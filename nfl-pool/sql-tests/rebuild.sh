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
# The cluster must be a disposable loopback one with a superuser URL, holding no database but postgres, and must not
# already have the roles neon-shape.sql creates (it stops if it does). The gate removes what it built when it ends and
# changes no setting of the cluster. CI runs it on a PostgreSQL 17.11 service container.
# A fourth stage builds the production shape the migrations alone do not describe: backup-role-delta.sql adds the scoped
# backup role, its five SELECT grants, its five policies and its one sequence grant, and the script prints that catalog's
# SHA-256 beside the others. The same catalog-snapshot.sql run read-only against the real database must give that value;
# sql-tests/compare-catalog.py shows, row by row, what differs if it does not (see nfl-pool/ops/CATALOG_COMPARISON.md).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations="$(cd "$here/../migrations" && pwd)"
KICKOFF_2026='2026-09-10T00:20:00+00:00'
problems=0
problem() { problems=$((problems + 1)); echo "::error title=Personal rebuild gate::$1"; }
[ -n "${REBUILD_PG_URL:-}" ] || { echo "::error::set REBUILD_PG_URL to a disposable loopback PostgreSQL superuser URL"; exit 1; }
url="${REBUILD_PG_URL}"
# Only this form is accepted: user[:password]@host[:port]/database, the host one that means this machine, nothing after the
# database name. A query string can carry host=, hostaddr= or service= and send libpq somewhere else; several hosts, or none,
# would make the check below mean something other than what libpq does.
url_form='^postgres(ql)?://[A-Za-z0-9_.-]+(:[A-Za-z0-9_.~-]*)?@(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?/[A-Za-z0-9_]+$'
[[ "$url" =~ $url_form ]] || { echo "::error::REBUILD_PG_URL must be of the form postgresql://postgres@127.0.0.1:5432/postgres: a user, a loopback host, a port and a database, and nothing else"; exit 1; }
# The same overrides can come from the environment: PGHOSTADDR connects to its address whatever host the URL names, and a
# service file can supply it. They are refused, not unset, so a surprising environment is noticed. The rest only change how
# the sessions of this script behave (time zone, options), and the suites need them as they are.
for variable in PGHOSTADDR PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGHOST; do
  [ -z "${!variable:-}" ] || { echo "::error::$variable is set; it can send the connection somewhere other than the URL's host. Unset it and run again."; exit 1; }
done
unset PGOPTIONS PGTZ PGDATESTYLE PGGEQO PGCLIENTENCODING PGDATABASE PGUSER PGPORT
export PGCONNECT_TIMEOUT=10
# Optional: a directory that already exists, to keep the three catalog documents in (reference.json, rebuilt.json,
# production-shape.json). They describe the schema and name no row; compare-catalog.py reads them.
[ -z "${REBUILD_SNAPSHOT_DIR:-}" ] || [ -d "$REBUILD_SNAPSHOT_DIR" ] || { echo "::error::REBUILD_SNAPSHOT_DIR must be a directory that exists"; exit 1; }
save() { [ -z "${REBUILD_SNAPSHOT_DIR:-}" ] || printf '%s\n' "$2" > "$REBUILD_SNAPSHOT_DIR/$1.json"; }
log="$(mktemp -d)"
psql_as() { local u="${url%%://*}://$1@${url#*@}"; u="${u%/*}/$2"; psql -X -q -v ON_ERROR_STOP=1 "$u" "${@:3}"; }
psql_at() { local u="${url%%://*}://$1@${url#*@}"; u="${u%/*}/$2"; psql -X -At "$u" "${@:3}"; }
roles=(nfl_pool_owner neon_auth authenticator authenticated anonymous neon_superuser smokke_personal_cloud_backup_ro)
databases=(nfl_pool nfl_pool_rebuilt nfl_pool_prod_shape)
in_list() { local item list="" ; for item in "$@"; do list="${list:+$list,}'$item'"; done; printf '%s' "$list"; }
cleanup() {
  # Leave the cluster as found, so the gate can be run again: the databases first, then the roles. A failure is said, never
  # swallowed: a role or database left behind makes the next run refuse, and the person needs to know why.
  local db role
  for db in "${databases[@]}"; do psql_as postgres postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" > /dev/null 2> "$log/drop.err" || echo "::warning::could not drop database $db: $(tail -1 "$log/drop.err")"; done
  for role in "${roles[@]}"; do psql_as postgres postgres -c "DROP ROLE IF EXISTS $role" > /dev/null 2> "$log/drop.err" || echo "::warning::could not drop role $role: $(tail -1 "$log/drop.err")"; done
  rm -rf "$log"
}
# Is this a cluster that may be built in and torn down? Nothing here can prove it, so it must at least hold nothing of its own:
# no database but the three every cluster has, none of the names this script builds, none of its roles, and not a Neon compute.
if [ "$(psql_at postgres postgres -c "SELECT count(*) FROM pg_roles WHERE rolname IN ($(in_list "${roles[@]}"))")" != 0 ] \
   || [ "$(psql_at postgres postgres -c "SELECT count(*) FROM pg_database WHERE datname IN ($(in_list "${databases[@]}"))")" != 0 ]; then
  echo "::error::this cluster already has the roles or databases the gate builds; use a disposable one"; rm -rf "$log"; exit 1
fi
if [ "$(psql_at postgres postgres -c "SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')")" != 0 ] \
   || [ -n "$(psql_at postgres postgres -c "SELECT COALESCE(current_setting('neon.project_id',true),'')")" ]; then
  echo "::error::this cluster holds a database of its own, or is a Neon compute; the gate only runs on an empty disposable cluster"; rm -rf "$log"; exit 1
fi
trap cleanup EXIT
# The Data API tests read times in GMT, as production does. That is set on the two databases the suites run in, never on the
# cluster: it goes when they are dropped, and nothing outlives the run.
echo "Server: PostgreSQL $(psql_at postgres postgres -c 'SHOW server_version' | cut -d' ' -f1)"

# neon-shape.sql in three parts, split at its own markers: the roles, the platform objects Neon provides, and the
# hand-written table. A change to those markers stops this script instead of silently building something else.
shape="$here/neon-shape.sql"
grep -q '^CREATE DATABASE nfl_pool OWNER nfl_pool_owner;$' "$shape" && grep -q '^\\connect nfl_pool$' "$shape" \
  && grep -q "^-- nfl_pool_weeks: the Pick'em publication table" "$shape" || { echo "::error::neon-shape.sql no longer has the markers this gate splits it at"; exit 1; }
awk '/^CREATE DATABASE nfl_pool OWNER/{exit} {print}' "$shape" > "$log/roles.sql"
awk '/^\\connect nfl_pool$/{p=1} /^-- nfl_pool_weeks: the Pick.em publication table/{exit} p' "$shape" | sed '1d' > "$log/platform.sql"
awk '/^-- nfl_pool_weeks: the Pick.em publication table/{p=1} p' "$shape" > "$log/table.sql"

echo "== Roles (once), then two databases"
psql_as postgres postgres < "$log/roles.sql" || { echo "::error::roles failed"; exit 1; }
for db in nfl_pool nfl_pool_rebuilt; do
  psql_as postgres postgres -c "CREATE DATABASE $db OWNER nfl_pool_owner" -c "ALTER DATABASE $db SET timezone TO 'GMT'" || { echo "::error::could not create $db"; exit 1; }
  psql_as postgres "$db" < "$log/platform.sql" || { echo "::error::platform objects failed in $db"; exit 1; }
done
psql_as postgres nfl_pool < "$log/table.sql" || { echo "::error::the emulated table failed"; exit 1; }
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

snapshot() { psql_at postgres "$1" < "$here/catalog-snapshot.sql"; }
md5_of() { printf '%s' "$1" | md5sum | cut -d' ' -f1; }
sha_of() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
ref="$(snapshot nfl_pool)"; reb="$(snapshot nfl_pool_rebuilt)"
save reference "$ref"; save rebuilt "$reb"
echo "== Catalog"
echo "reference  sha256 $(sha_of "$ref")"; echo "rebuilt    sha256 $(sha_of "$reb")"
if [ "$ref" = "$reb" ]; then echo "the rebuilt database has the very catalog the production shape describes"
else problem "the rebuilt catalog differs from the production shape"; diff <(printf '%s' "$ref" | python3 -c 'import sys,json;d=json.load(sys.stdin);[print(k,json.dumps(r)) for k,v in d.items() for r in (v or [])]' | sort) \
  <(printf '%s' "$reb" | python3 -c 'import sys,json;d=json.load(sys.stdin);[print(k,json.dumps(r)) for k,v in d.items() for r in (v or [])]' | sort) | head -20; fi
python3 - "$reb" <<'PY' || problem "the catalog is missing something the gate expects"
import sys,json
d=json.loads(sys.argv[1])
tables=sorted(r[0] for r in d['tables'] if r[1]=='r')
want=['nfl_contest_policies','nfl_contests','nfl_incident_rulings','nfl_pool_weeks','nfl_survivor_weeks']
assert tables==want,tables
assert all(r[3] for r in d['tables'] if r[1]=='r'),'every table has row-level security'
print('tables:',', '.join(tables),'| policies:',len(d['policies']),'| functions:',len(d['functions']),'| privilege rows:',len(d['privileges']))
PY

echo "== The production shape: the migrations plus what the live database is documented to hold beyond them"
# A copy of the rebuilt database, so the suites below still run on the one the migrations alone made.
if psql_as postgres postgres -c "CREATE ROLE smokke_personal_cloud_backup_ro LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE" \
     -c "CREATE DATABASE nfl_pool_prod_shape TEMPLATE nfl_pool_rebuilt OWNER nfl_pool_owner" -c "ALTER DATABASE nfl_pool_prod_shape SET timezone TO 'GMT'" > /dev/null \
   && psql_as nfl_pool_owner nfl_pool_prod_shape < "$here/backup-role-delta.sql" > "$log/delta.out" 2>&1; then
  shape="$(snapshot nfl_pool_prod_shape)"; save production-shape "$shape"
  python3 - "$reb" "$shape" <<'PY' || problem "the backup role's additions are not the five grants, five policies and one sequence grant they should be"
import sys,json
a,b=json.loads(sys.argv[1]),json.loads(sys.argv[2])
assert len(b['policies'])==len(a['policies'])+5,'five more policies'
assert len(b['privileges'])==len(a['privileges'])+6,'six more privilege rows: five tables and one sequence'
assert all(r[2]=='smokke_personal_cloud_backup_ro' for r in b['privileges'] if r not in a['privileges']),'only the backup role gained anything'
assert all(r[4]=='{smokke_personal_cloud_backup_ro}' for r in b['policies'] if r not in a['policies']),'only the backup role has a new policy'
for section in ('columns','tables','constraints','indexes','triggers','functions'): assert a[section]==b[section],section
print('policies:',len(b['policies']),'| functions:',len(b['functions']),'| privilege rows:',len(b['privileges']))
PY
  echo "production shape sha256 $(sha_of "$shape")  (what catalog-snapshot.sql gives on the real database, if it is as documented)"
else
  tail -5 "$log/delta.out" 2> /dev/null; problem "the production shape could not be built"
fi

echo "== Migration 000 changes nothing where the table exists, and nothing the second time"
before="$(sha_of "$(snapshot nfl_pool)")"
if apply nfl_pool 000-pool-weeks-baseline.sql && grep -q "000: public.nfl_pool_weeks already exists; nothing changed" "$log/nfl_pool-000-pool-weeks-baseline.sql.out" && [ "$(sha_of "$(snapshot nfl_pool)")" = "$before" ]; then
  echo "on the reference database (table present): noticed, nothing changed"; else problem "migration 000 changed or failed on a database that has the table"; fi
before="$(sha_of "$(snapshot nfl_pool_rebuilt)")"
if apply nfl_pool_rebuilt 000-pool-weeks-baseline.sql && [ "$(sha_of "$(snapshot nfl_pool_rebuilt)")" = "$before" ]; then
  echo "on the rebuilt database, a second time: nothing changed"; else problem "migration 000 is not idempotent"; fi

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

if [ "$problems" -ne 0 ]; then echo "Personal rebuild gate FAILED ($problems problem(s))"; exit 1; fi
echo "Personal rebuild gate passed"
