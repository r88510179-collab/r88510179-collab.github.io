#!/usr/bin/env bash
# Rebuildability gate for the Personal database. On a disposable PostgreSQL it builds the database twice:
#   reference  the way the SQL gate (run.sh) has always built it: neon-shape.sql, which emulates the production shape
#              including a hand-written public.nfl_pool_weeks, then migrations 001-005 and the full-field guard;
#   rebuilt    from the repository alone: only what Neon provides (roles, auth.user_id(), neon_auth."user"), then
#              migrations 000, 001-005 and the full-field guard. No hand-written table.
# and shows (1) every migration applies, (2) the two databases have the very same catalog (columns, constraints, indexes,
# triggers, policies, row-level security, functions, privileges), (3) migration 000 on a database that already has the
# table changes nothing, and twice on the rebuilt one changes nothing, (4) the full-field guard and behavior suites pass
# on the rebuilt database. It prints the SHA-256 of the catalog document so the same read-only catalog-snapshot.sql can be
# compared against the real database by someone allowed to read it. No Neon, no secrets, nothing is ever applied to Neon.
#
#   REBUILD_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres bash nfl-pool/sql-tests/rebuild.sh
#
# THE CONNECTION. REBUILD_PG_URL has one supported form, exactly: postgresql://postgres@HOST[:PORT]/postgres, HOST being
# 127.0.0.1, localhost or [::1]. The gate connects as the superuser postgres to the database postgres, and then as the roles it
# creates itself; the URL supplies only the host and the port. A URL with a password, another user or database, a query string
# or any other host is refused, and the value is never printed. The gate's own roles have no password, so the cluster must let
# them connect without one (trust, as the CI service container does with POSTGRES_HOST_AUTH_METHOD=trust). If the superuser
# needs a password, put it in PGPASSWORD, never in the URL.
#
# THE CLUSTER must be a disposable loopback one, holding no database but postgres, and must not already have the roles
# neon-shape.sql creates (it stops if it does).
#
# ONE EXECUTION AT A TIME PER CLUSTER. The roles are cluster-wide, so two executions on one cluster would be building the same
# things. An execution takes a lock first, the role nfl_pool_rebuild_lock (created, not looked for: creating it either works or
# fails, so two executions started together cannot both win); a second one stops at once, touches nothing, and says whose lock
# it found. Everything an execution creates (the lock, the roles, the databases) is marked with that execution's own identifier,
# in the object's comment, as it is created. When it ends it drops only what carries its own mark, databases first, the lock
# last; it never drops something it did not make, and it says so when it meets one.
#
# EXIT STATUS. 0 the gate passed and the cluster is as it was found; 1 it was refused or a check failed (the cluster is still
# cleaned up); 3 everything passed but something this execution made could not be removed (named in a ::warning:: line: the
# next run will refuse until it is removed). A cleanup failure after a failed run leaves status 1 and is still reported. A
# signal (INT, TERM, HUP) ends the run through the same cleanup. An execution killed outright (SIGKILL, power loss) cannot
# clean up: it leaves its lock and what it made, and the next run refuses on them, naming them.
#
# REBUILD_SNAPSHOT_DIR, when set, must be a directory that exists and can be written: the gate stops at once if it is not, and
# stops with status 1 if any of the files it was asked to keep (reference.json, rebuilt.json, production-shape.json,
# production-shape-environment.json) cannot be written. They describe the schema and the roles' attributes, and name no row.
# Two executions on different clusters must not share one directory.
#
# A fourth stage builds the production shape the migrations alone do not describe: backup-role-delta.sql adds the scoped
# backup role, its five SELECT grants, its five policies and its one sequence grant, and the script prints that catalog's
# SHA-256 beside the others. compare-catalog.py --documented-backup-role then requires that catalog to be the migrations-only
# one plus exactly those eleven rows, nothing more (see nfl-pool/ops/CATALOG_COMPARISON.md). The same catalog-snapshot.sql run
# read-only against the real database must give that value. A fifth stage reads environment-snapshot.sql on that database
# beside two synthetic roles that read through pg_read_all_data, so what it reports about membership and effective access is
# itself tested.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations="$(cd "$here/../migrations" && pwd)"
compare="$here/compare-catalog.py"
KICKOFF_2026='2026-09-10T00:20:00+00:00'
problems=0
problem() { problems=$((problems + 1)); echo "::error title=Personal rebuild gate::$1"; }
log="$(mktemp -d)" || { echo "::error::could not make a temporary directory"; exit 1; }
# Before anything is owned: say why and leave, touching nothing.
refuse() { echo "::error::$1"; rm -rf "$log"; exit 1; }
command -v psql > /dev/null && command -v python3 > /dev/null || refuse "psql and python3 are needed"
[ -n "${REBUILD_PG_URL:-}" ] || refuse "set REBUILD_PG_URL to a disposable loopback PostgreSQL superuser URL: postgresql://postgres@127.0.0.1:5432/postgres"
url="${REBUILD_PG_URL}"
# Only this form is accepted. The user and the database are always postgres; a query string can carry host=, hostaddr= or
# service= and send libpq somewhere else; several hosts, or none, would make the check mean something other than what libpq
# does; and a password in a URL ends up in process listings and error messages. The value itself is never printed.
url_form='^postgres(ql)?://postgres@(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?/postgres$'
if ! [[ "$url" =~ $url_form ]]; then
  reasons=()
  [[ "$url" =~ ^postgres(ql)?://[^/@:]*:[^/@]*@ ]] && reasons+=("it contains a password (the gate's roles need none; put the superuser's in PGPASSWORD, never in the URL)")
  [[ "$url" =~ ^postgres(ql)?:// ]] || reasons+=("it is not a postgresql:// URL")
  [[ "$url" =~ ^postgres(ql)?://postgres[:@] ]] || reasons+=("the user must be postgres")
  [[ "$url" =~ @(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/|$) ]] || reasons+=("the host must be 127.0.0.1, localhost or [::1], once")
  [[ "$url" =~ /postgres$ ]] || reasons+=("the database must be postgres and nothing may follow it")
  [[ "$url" =~ [?#] ]] && reasons+=("a query string or fragment can send libpq elsewhere")
  refuse "REBUILD_PG_URL is not of the supported form postgresql://postgres@127.0.0.1[:port]/postgres: ${reasons[*]:-the form is not recognised}"
fi
port="${BASH_REMATCH[3]#:}"
if [ -n "$port" ] && [ $((10#$port)) -gt 65535 ]; then refuse "REBUILD_PG_URL names a port above 65535"; fi
# The same overrides can come from the environment: PGHOSTADDR connects to its address whatever host the URL names, and a
# service file can supply it. They are refused, not unset, so a surprising environment is noticed. The rest only change how
# the sessions of this script behave (time zone, options), and the suites need them as they are.
for variable in PGHOSTADDR PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGHOST; do
  [ -z "${!variable:-}" ] || refuse "$variable is set; it can send the connection somewhere other than the URL's host. Unset it and run again."
done
unset PGOPTIONS PGTZ PGDATESTYLE PGGEQO PGCLIENTENCODING PGDATABASE PGUSER PGPORT
export PGCONNECT_TIMEOUT=10
# Optional: a directory to keep the catalog documents in. Checked now, before anything is built: asking for files and not getting
# them is a failure, not a silent omission.
if [ -n "${REBUILD_SNAPSHOT_DIR:-}" ]; then
  [ -d "$REBUILD_SNAPSHOT_DIR" ] || refuse "REBUILD_SNAPSHOT_DIR must be a directory that exists"
  probe="$(mktemp "$REBUILD_SNAPSHOT_DIR/.rebuild-probe.XXXXXX" 2> /dev/null)" || refuse "REBUILD_SNAPSHOT_DIR cannot be written to: nothing was built"
  rm -f "$probe"
fi
psql_as() { local u="${url%%://*}://$1@${url#*@}"; u="${u%/*}/$2"; psql -X -q -v ON_ERROR_STOP=1 "$u" "${@:3}"; }
psql_at() { local u="${url%%://*}://$1@${url#*@}"; u="${u%/*}/$2"; psql -X -At "$u" "${@:3}"; }

run_id="$(od -An -N8 -tx1 /dev/urandom 2> /dev/null | tr -d ' \n')"
[ "${#run_id}" -eq 16 ] || refuse "could not make a run identifier"
tag="nfl-pool-rebuild-gate run $run_id"
lock_role=nfl_pool_rebuild_lock
roles_from_neon_shape=(nfl_pool_owner neon_auth authenticator authenticated anonymous neon_superuser)
backup_role=smokke_personal_cloud_backup_ro
synthetic_roles=(synthetic_predefined_reader synthetic_bypass_reader)
all_roles=("${roles_from_neon_shape[@]}" "$backup_role" "${synthetic_roles[@]}")
databases=(nfl_pool nfl_pool_rebuilt nfl_pool_prod_shape)
in_list() { local item list="" ; for item in "$@"; do list="${list:+$list,}'$item'"; done; printf '%s' "$list"; }
holder_of_lock() { psql_at postgres postgres -c "SELECT COALESCE(shobj_description(oid,'pg_authid'),'(no mark)') FROM pg_roles WHERE rolname='$lock_role'" 2> /dev/null; }

# ---- is this a cluster that may be built in and torn down? Reads only. Nothing here can prove it, so it must at least hold
# nothing of its own: no database but the three every cluster has, none of the names this script builds, none of its roles,
# and not a Neon compute.
check_disposable() {
  local out
  out="$(psql_at postgres postgres -c "SELECT (SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1'))||'|'||COALESCE(current_setting('neon.project_id',true),'')||'|'||(SELECT count(*) FROM pg_roles WHERE rolname IN ($(in_list "${all_roles[@]}")))" 2> "$log/probe.err")" \
    || { echo "::error::could not read the cluster: $(tail -1 "$log/probe.err")"; return 2; }
  local databases_of_its_own="${out%%|*}" rest="${out#*|}"
  local neon="${rest%%|*}" our_roles="${rest#*|}"
  if [ -n "$neon" ]; then echo "::error::this is a Neon compute; the gate only runs on an empty disposable cluster"; return 1; fi
  if [ "$databases_of_its_own" != 0 ]; then echo "::error::this cluster holds a database of its own, or one the gate builds; the gate only runs on an empty disposable cluster (nothing was changed)"; return 1; fi
  if [ "$our_roles" != 0 ]; then echo "::error::this cluster already has roles the gate builds; use a disposable one (nothing was changed)"; return 1; fi
  return 0
}
holder="$(holder_of_lock)"
if [ -n "$holder" ]; then refuse "another execution of the gate holds this cluster (role $lock_role exists, marked: $holder). Nothing was changed. If none is running, a killed one left it: drop the role, and anything it made, by hand."; fi
check_disposable; status=$?
if [ "$status" -ne 0 ]; then
  holder="$(holder_of_lock)"
  [ -z "$holder" ] || echo "::error::an execution of the gate appears to be running on this cluster (role $lock_role exists, marked: $holder)"
  rm -rf "$log"; exit 1
fi

# ---- ownership. Everything this execution creates is recorded here and marked with its own identifier as it is made.
owned_databases=(); owned_roles=(); lock_held=0; cleanup_failed=0
say_cleanup() { echo "::warning::$1"; cleanup_failed=1; }
mark_of() { # database|role name -> its mark, empty if it has none, ABSENT if it does not exist
  case "$1" in
    database) psql_at postgres postgres -c "SELECT COALESCE((SELECT COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname='$2'),'ABSENT')" ;;
    role) psql_at postgres postgres -c "SELECT COALESCE((SELECT COALESCE(shobj_description(oid,'pg_authid'),'') FROM pg_roles WHERE rolname='$2'),'ABSENT')" ;;
  esac
}
drop_if_ours() { # database|role name: drops it only if it carries this execution's mark
  local kind="$1" name="$2" found
  found="$(mark_of "$kind" "$name" 2> "$log/drop.err")" || { say_cleanup "could not look up $kind $name, so it was not dropped: $(tail -1 "$log/drop.err")"; return; }
  [ "$found" = ABSENT ] && return
  if [ "$found" != "$tag" ]; then say_cleanup "not dropping $kind $name: it is not marked as made by this execution (mark found: '${found:-none}')"; return; fi
  if [ "$kind" = database ]; then psql_as postgres postgres -c "DROP DATABASE $name WITH (FORCE)" > /dev/null 2> "$log/drop.err" || say_cleanup "could not drop database $name: $(tail -1 "$log/drop.err")"
  else psql_as postgres postgres -c "DROP ROLE $name" > /dev/null 2> "$log/drop.err" || say_cleanup "could not drop role $name: $(tail -1 "$log/drop.err")"; fi
}
cleanup() {
  # Leave the cluster as found, so the gate can be run again: the databases first, then the roles, the lock last. Only what
  # carries this execution's mark. A failure is said, never swallowed: it makes the exit status nonzero.
  local i
  for ((i=${#owned_databases[@]}-1; i>=0; i--)); do drop_if_ours database "${owned_databases[i]}"; done
  for ((i=${#owned_roles[@]}-1; i>=0; i--)); do drop_if_ours role "${owned_roles[i]}"; done
  [ "$lock_held" -eq 0 ] || drop_if_ours role "$lock_role"
}
on_exit() {
  local status=$?
  trap - EXIT INT TERM HUP
  cleanup
  rm -rf "$log"
  if [ "$cleanup_failed" -ne 0 ]; then
    echo "Personal rebuild gate: cleanup incomplete, see the warnings above; the next run will refuse until what is named is removed"
    [ "$status" -ne 0 ] || status=3
  elif [ "$status" -eq 0 ]; then echo "Personal rebuild gate passed"
  else echo "Personal rebuild gate FAILED"; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
stop() { echo "::error::$1"; exit 1; }
adopt_database() { owned_databases+=("$1"); psql_as postgres postgres -c "COMMENT ON DATABASE $1 IS '$tag'" > /dev/null || problem "could not mark database $1 as this execution's"; }
adopt_role() { owned_roles+=("$1"); psql_as postgres postgres -c "COMMENT ON ROLE $1 IS '$tag'" > /dev/null || problem "could not mark role $1 as this execution's"; }

# ---- the lock. Creating the role either works or fails: two executions started together cannot both succeed.
if psql_as postgres postgres -c "CREATE ROLE $lock_role NOLOGIN" > /dev/null 2> "$log/lock.err"; then
  lock_held=1
  psql_as postgres postgres -c "COMMENT ON ROLE $lock_role IS '$tag'" > /dev/null || problem "could not mark the lock role"
else
  holder="$(holder_of_lock)"
  if [ -n "$holder" ]; then echo "::error::another execution of the gate holds this cluster (role $lock_role exists, marked: $holder). Nothing was changed."
  else echo "::error::could not take the lock: $(tail -1 "$log/lock.err")"; fi
  exit 1
fi
# Now that nobody else can be building, the cluster is looked at again: the first look only kept the gate off a cluster it
# must not touch, and could have been made before another execution began.
check_disposable || exit 1
echo "Run $run_id; server: PostgreSQL $(psql_at postgres postgres -c 'SHOW server_version' | cut -d' ' -f1)"

# The snapshot files. Each is written to the temporary directory, validated there by compare-catalog.py, and, when a directory
# was asked for, copied to it and checked; a failure to write it is a failure of the run, not a silent omission.
publish() { # name
  [ -n "${REBUILD_SNAPSHOT_DIR:-}" ] || return 0
  cat "$log/$1.json" > "$REBUILD_SNAPSHOT_DIR/$1.json" 2> /dev/null && cmp -s "$log/$1.json" "$REBUILD_SNAPSHOT_DIR/$1.json" \
    || { problem "could not write $1.json to the directory REBUILD_SNAPSHOT_DIR names"; exit 1; }
}
snapshot() { # database name [environment]: writes $log/<name>.json, sets snap_sha to its SHA-256, and ends the run if it is not a valid document
  # It is called in the main shell, never in a command substitution, so that stop really ends the run.
  local file="$log/$2.json" query="$here/catalog-snapshot.sql" out
  local kind=(); [ "${3:-}" != environment ] || { query="$here/environment-snapshot.sql"; kind=(--environment); }
  snap_sha=""
  out="$(psql_at postgres "$1" < "$query" 2> "$log/snapshot.err")" && [ -n "$out" ] || { tail -3 "$log/snapshot.err"; stop "could not read the catalog of $1"; }
  printf '%s\n' "$out" > "$file" || stop "could not write a temporary file"
  python3 "$compare" --validate "${kind[@]}" "$file" > "$log/snapshot.sha" 2> "$log/snapshot.err" || { cat "$log/snapshot.err"; stop "the snapshot of $1 is not a valid document"; }
  snap_sha="$(awk '{print $2}' "$log/snapshot.sha")"
  [ "${#snap_sha}" -eq 64 ] || stop "the snapshot of $1 has no hash"
}

# neon-shape.sql in three parts, split at its own markers: the roles, the platform objects Neon provides, and the
# hand-written table. A change to those markers stops this script instead of silently building something else.
shape="$here/neon-shape.sql"
grep -q '^CREATE DATABASE nfl_pool OWNER nfl_pool_owner;$' "$shape" && grep -q '^\\connect nfl_pool$' "$shape" \
  && grep -q "^-- nfl_pool_weeks: the Pick'em publication table" "$shape" || stop "neon-shape.sql no longer has the markers this gate splits it at"
awk '/^CREATE DATABASE nfl_pool OWNER/{exit} {print}' "$shape" > "$log/roles.sql"
awk '/^\\connect nfl_pool$/{p=1} /^-- nfl_pool_weeks: the Pick.em publication table/{exit} p' "$shape" | sed '1d' > "$log/platform.sql"
awk '/^-- nfl_pool_weeks: the Pick.em publication table/{p=1} p' "$shape" > "$log/table.sql"

echo "== Roles (once), then two databases"
psql_as postgres postgres < "$log/roles.sql"; roles_status=$?
# Whatever of the roles now exists was made by the file above: the cluster was empty of them when the lock was taken.
for role in "${roles_from_neon_shape[@]}"; do
  [ "$(psql_at postgres postgres -c "SELECT count(*) FROM pg_roles WHERE rolname='$role'")" != 1 ] || adopt_role "$role"
done
[ "$roles_status" -eq 0 ] || stop "roles failed"
for db in nfl_pool nfl_pool_rebuilt; do
  psql_as postgres postgres -c "CREATE DATABASE $db OWNER nfl_pool_owner" || stop "could not create $db"
  adopt_database "$db"
  psql_as postgres postgres -c "ALTER DATABASE $db SET timezone TO 'GMT'" || stop "could not set the time zone of $db"
  psql_as postgres "$db" < "$log/platform.sql" || stop "platform objects failed in $db"
done
psql_as postgres nfl_pool < "$log/table.sql" || stop "the emulated table failed"
echo "reference: platform objects and the emulated nfl_pool_weeks; rebuilt: platform objects only"

apply() { # apply <database> <file> [kickoff]
  if [ -n "${3:-}" ]; then { printf "SET nfl_pool.contest_start_2026 = '%s';\n" "$3"; cat "$migrations/$2"; } | psql_as nfl_pool_owner "$1" > "$log/$1-$2.out" 2>&1
  else psql_as nfl_pool_owner "$1" < "$migrations/$2" > "$log/$1-$2.out" 2>&1; fi
}
echo "== Migrations"
for db in nfl_pool nfl_pool_rebuilt; do
  list="001-survivor-weeks.sql 002-contest-rulings.sql 003-pool-center-2026-contests.sql 004-incident-ruling-writes.sql 005-absent-game-adjudication.sql 20261108_full_field_publish_guard.sql"
  [ "$db" = nfl_pool_rebuilt ] && list="000-pool-weeks-baseline.sql $list"
  for m in $list; do
    k=""; [ "$m" = 003-pool-center-2026-contests.sql ] && k="$KICKOFF_2026"
    if apply "$db" "$m" "$k"; then echo "$db: applied $m"; else tail -5 "$log/$db-$m.out"; problem "$db: migration $m failed"; fi
  done
done

echo "== Catalog"
snapshot nfl_pool reference; sha_ref="$snap_sha"; publish reference
snapshot nfl_pool_rebuilt rebuilt; sha_reb="$snap_sha"; publish rebuilt
echo "reference  sha256 $sha_ref"; echo "rebuilt    sha256 $sha_reb"
# Both documents were validated as they were read: an empty or incomplete one stopped the run above, and cannot be "equal".
python3 "$compare" "$log/reference.json" "$log/rebuilt.json" --label-a reference --label-b rebuilt > "$log/compare.out" 2>&1; cs=$?
case "$cs" in
  0) echo "the rebuilt database has the very catalog the production shape describes" ;;
  1) head -40 "$log/compare.out"; problem "the rebuilt catalog differs from the production shape" ;;
  *) cat "$log/compare.out"; problem "a catalog snapshot is not a valid document" ;;
esac
python3 - "$log/rebuilt.json" <<'PY' || problem "the catalog is missing something the gate expects"
import sys,json
d=json.load(open(sys.argv[1]))
tables=sorted(r[0] for r in d['tables'] if r[1]=='r')
want=['nfl_contest_policies','nfl_contests','nfl_incident_rulings','nfl_pool_weeks','nfl_survivor_weeks']
assert tables==want,tables
assert all(r[3] for r in d['tables'] if r[1]=='r'),'every table has row-level security'
print('tables:',', '.join(tables),'| policies:',len(d['policies']),'| functions:',len(d['functions']),'| privilege rows:',len(d['privileges']))
PY

echo "== The production shape: the migrations plus what the live database is documented to hold beyond them"
# A copy of the rebuilt database, so the suites below still run on the one the migrations alone made. The two synthetic roles
# belong to the environment stage below; they hold no grant, so the catalog document cannot see them.
shape_ok=0
psql_as postgres postgres -c "CREATE ROLE $backup_role LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE" > /dev/null && adopt_role "$backup_role"
psql_as postgres postgres -c "CREATE ROLE synthetic_predefined_reader LOGIN NOSUPERUSER NOBYPASSRLS" -c "GRANT pg_read_all_data TO synthetic_predefined_reader" > /dev/null && adopt_role synthetic_predefined_reader
psql_as postgres postgres -c "CREATE ROLE synthetic_bypass_reader LOGIN NOSUPERUSER BYPASSRLS" -c "GRANT pg_read_all_data TO synthetic_bypass_reader" > /dev/null && adopt_role synthetic_bypass_reader
if psql_as postgres postgres -c "CREATE DATABASE nfl_pool_prod_shape TEMPLATE nfl_pool_rebuilt OWNER nfl_pool_owner" > /dev/null; then
  adopt_database nfl_pool_prod_shape
  psql_as postgres postgres -c "ALTER DATABASE nfl_pool_prod_shape SET timezone TO 'GMT'" > /dev/null \
    && psql_as nfl_pool_owner nfl_pool_prod_shape < "$here/backup-role-delta.sql" > "$log/delta.out" 2>&1 && shape_ok=1
fi
if [ "$shape_ok" -eq 1 ]; then
  snapshot nfl_pool_prod_shape production-shape; sha_shape="$snap_sha"; publish production-shape
  # Strict equality against the adjusted shape: the migrations-only catalog plus exactly the eleven documented rows. A grant
  # of anything but SELECT, a read grant on another object, a grant option, a policy for other roles or for more than reading,
  # a documented row missing: the tool says which, and the run fails.
  python3 "$compare" "$log/production-shape.json" "$log/rebuilt.json" --label-a production-shape --label-b rebuilt --documented-backup-role > "$log/shape.out" 2>&1; ss=$?
  case "$ss" in
    0) sed -n 's/^\(MATCHES.*\)$/\1/p' "$log/shape.out" ;;
    1) head -40 "$log/shape.out"; problem "the backup role's additions are not exactly the five grants, five policies and one sequence grant documented" ;;
    *) cat "$log/shape.out"; problem "the production shape could not be compared with the migrations-only catalog" ;;
  esac
  python3 - "$log/production-shape.json" <<'PY' || problem "the production shape is not the size it should be"
import sys,json
d=json.load(open(sys.argv[1]))
print('policies:',len(d['policies']),'| functions:',len(d['functions']),'| privilege rows:',len(d['privileges']))
PY
  echo "production shape sha256 $sha_shape  (what catalog-snapshot.sql gives on the real database, if it is as documented)"
else
  tail -5 "$log/delta.out" 2> /dev/null; problem "the production shape could not be built"
fi

echo "== The environment around schema public, read where roles reach the tables by membership"
if [ "$shape_ok" -eq 1 ]; then
  snapshot nfl_pool_prod_shape production-shape-environment environment; publish production-shape-environment
  python3 - "$log/production-shape-environment.json" <<'PY' || problem "the environment snapshot does not show what it must about membership and effective privileges"
import sys,json
d=json.load(open(sys.argv[1]))
members={(m[0],m[1]):m for m in d['memberships']}
eff={}
for role,kind,obj,priv,explicit,effective,via,exempt in d['effective_privileges']: eff[(role,kind,obj,priv)]=(explicit,effective,via,exempt)
tables=['nfl_contest_policies','nfl_contests','nfl_incident_rulings','nfl_pool_weeks','nfl_survivor_weeks']
# Predefined-role membership is listed, with the inheritance that matters.
assert members[('neon_superuser','pg_read_all_data')][5] is True and members[('neon_superuser','pg_write_all_data')][5] is True,'neon_superuser inherits the predefined data roles'
assert members[('synthetic_predefined_reader','pg_read_all_data')][5] is True
assert members[('authenticator','authenticated')][5] is False and members[('authenticator','anonymous')][5] is False,'the Data API login does not inherit'
assert members[('nfl_pool_owner','neon_superuser')][5] is True
roles={r[0]:r for r in d['roles']}
assert roles['authenticator'][6] is False,'the Data API login is NOINHERIT'
assert roles['synthetic_bypass_reader'][4] is True and roles['synthetic_predefined_reader'][4] is False and roles['synthetic_predefined_reader'][6] is True
# Explicit, inherited and effective are kept apart: reading through pg_read_all_data is effective and not explicit, and row-level
# security still applies to it unless the role bypasses it.
for t in tables:
    assert eff[('synthetic_predefined_reader','table',t,'SELECT')]==(False,True,'pg_read_all_data',False),t
    assert eff[('synthetic_bypass_reader','table',t,'SELECT')]==(False,True,'pg_read_all_data',True),t
    assert ('synthetic_predefined_reader','table',t,'INSERT') not in eff,'reading through pg_read_all_data is not writing'
    assert eff[('smokke_personal_cloud_backup_ro','table',t,'SELECT')]==(True,True,'direct',False),t
    for w in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'):
        assert ('smokke_personal_cloud_backup_ro','table',t,w) not in eff,('the scoped backup role may only read',t,w)
assert eff[('smokke_personal_cloud_backup_ro','sequence','nfl_incident_rulings_ruling_id_seq','SELECT')]==(True,True,'direct',False)
assert not any(k[0]=='smokke_personal_cloud_backup_ro' and k[3] not in ('SELECT',) for k in eff),'the scoped backup role holds nothing but SELECT, explicit or inherited'
print('memberships:',len(d['memberships']),'| roles:',len(d['roles']),'| effective privilege rows:',len(d['effective_privileges']))
PY
else
  problem "the environment could not be read: the production shape was not built"
fi

echo "== Migration 000 changes nothing where the table exists, and nothing the second time"
snapshot nfl_pool idempotence; before="$snap_sha"
if apply nfl_pool 000-pool-weeks-baseline.sql && grep -q "000: public.nfl_pool_weeks already exists; nothing changed" "$log/nfl_pool-000-pool-weeks-baseline.sql.out"; then
  snapshot nfl_pool idempotence
  if [ "$snap_sha" = "$before" ]; then echo "on the reference database (table present): noticed, nothing changed"
  else problem "migration 000 changed a database that has the table"; fi
else problem "migration 000 failed on a database that has the table"; fi
snapshot nfl_pool_rebuilt idempotence; before="$snap_sha"
if apply nfl_pool_rebuilt 000-pool-weeks-baseline.sql; then
  snapshot nfl_pool_rebuilt idempotence
  if [ "$snap_sha" = "$before" ]; then echo "on the rebuilt database, a second time: nothing changed"
  else problem "migration 000 is not idempotent"; fi
else problem "migration 000 failed the second time"; fi

echo "== Suites on the rebuilt database"
psql_as postgres nfl_pool_rebuilt < "$here/fixtures.sql" || { echo "::error::fixtures.sql failed on the rebuilt database"; problem "fixtures failed"; }
psql_as postgres nfl_pool_rebuilt < "$here/full-field-guard.sql" > "$log/guard.out" 2>&1; gs=$?
guard_ok="$(grep -c '^NOTICE:  GUARD-TEST ok: ' "$log/guard.out")"; guard_plan="$(sed -n 's/^GUARD-PLAN \([0-9][0-9]*\)$/\1/p' "$log/guard.out")"
[ "$gs" -eq 0 ] && [ -n "$guard_plan" ] && [ "$guard_ok" -eq "$guard_plan" ] || { tail -10 "$log/guard.out"; problem "full-field guard on the rebuilt database: $guard_ok passed, plan ${guard_plan:-missing}"; }
echo "Full-field guard: $guard_ok passed, plan ${guard_plan:-missing}"
psql_as postgres nfl_pool_rebuilt < "$here/behavior.sql" > "$log/behavior.out" 2>&1; bs=$?
ok="$(grep -c '^NOTICE:  HDC13-TEST ok: ' "$log/behavior.out")"; fail="$(grep -c '^NOTICE:  HDC13-TEST FAIL: ' "$log/behavior.out")"; plan="$(sed -n 's/^HDC13-PLAN \([0-9][0-9]*\)$/\1/p' "$log/behavior.out")"
[ "$bs" -eq 0 ] && [ "$fail" -eq 0 ] && [ -n "$plan" ] && [ "$ok" -eq "$plan" ] || { grep -v '^NOTICE:  HDC13-TEST ' "$log/behavior.out" | tail -10; problem "behavior suite on the rebuilt database: $ok passed, $fail failed, plan ${plan:-missing}"; }
echo "Behavior: $ok passed, $fail failed, plan ${plan:-missing}"

# The verdict line is printed by the exit handler, after cleanup, so that it can say the truth about both.
if [ "$problems" -ne 0 ]; then echo "$problems problem(s)"; exit 1; fi
exit 0
