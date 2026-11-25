#!/usr/bin/env bash
# Lifecycle tests of rebuild.sh, on a DISPOSABLE PostgreSQL. Not the catalog (rebuild.sh itself and test_compare_catalog.py
# cover that) but what the script does to the cluster it is given: refuses what it must refuse and touches nothing; is the only
# execution at a time; removes only what it made; says so, with a nonzero exit status, when it cannot remove something; ends
# cleanly on a signal; and fails, not shrugs, when it cannot write a file it was asked for.
#
#   REBUILD_TEST_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres bash nfl-pool/sql-tests/test_rebuild_lifecycle.sh
#
# The cluster must be one that can be thrown away and must be EMPTY (no database but postgres, no role but postgres): these tests
# build and tear down in it, and between cases they remove whatever a case left. It stops at once if the cluster is not empty.
# Exit status 0 when every case passed, 1 when any failed, 2 when it cannot start. Prints TAP-style lines.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gate="$here/rebuild.sh"
url="${REBUILD_TEST_PG_URL:-}"
[[ "$url" =~ ^postgres(ql)?://postgres@(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?/postgres$ ]] \
  || { echo "set REBUILD_TEST_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres: a DISPOSABLE, empty loopback cluster, because these tests build and tear down in it"; exit 2; }
host="${BASH_REMATCH[2]}"; port="${BASH_REMATCH[3]#:}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tests=0; failed=0
ok() { tests=$((tests + 1)); echo "ok $tests - $1"; }
not_ok() { tests=$((tests + 1)); failed=$((failed + 1)); echo "not ok $tests - $1"; [ -z "${2:-}" ] || printf '%s\n' "$2" | head -20 | sed 's/^/#   /'; }
check() { local description="$1"; shift; if "$@" > /dev/null 2>&1; then ok "$description"; else not_ok "$description"; fi; }
sql() { psql -X -At "$url" -c "$1"; }
sql_in() { local db="$1"; shift; psql -X -At "${url%/*}/$db" -c "$1"; }
leftovers() { sql "SELECT COALESCE(string_agg(x,', ' ORDER BY x),'') FROM (SELECT 'database '||datname AS x FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') UNION ALL SELECT 'role '||rolname FROM pg_roles WHERE rolname !~ '^pg_' AND rolname<>'postgres') s"; }
reset_cluster() {
  local db role
  for db in $(sql "SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')"); do sql "DROP DATABASE \"$db\" WITH (FORCE)" > /dev/null; done
  for role in $(sql "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND rolname<>'postgres'"); do sql "DROP OWNED BY \"$role\"" > /dev/null 2>&1; sql "DROP ROLE \"$role\"" > /dev/null; done
}
cluster_is_empty() { [ -z "$(leftovers)" ]; }
# run_gate <name> [VAR=value ...]: runs the gate with REBUILD_PG_URL as given in $gate_url (default: the cluster's); output in $work/<name>.out, status in gate_status
gate_url="$url"
run_gate() { local name="$1"; shift; env REBUILD_PG_URL="$gate_url" "$@" bash "$gate" > "$work/$name.out" 2>&1; gate_status=$?; }
out() { cat "$work/$1.out"; }
has() { grep -q -- "$2" "$work/$1.out"; }
wait_until() { local i; for i in $(seq 1 400); do [ "$(sql "$1" 2> /dev/null)" = "$2" ] && return 0; sleep 0.05; done; return 1; }

cluster_is_empty || { echo "the cluster is not empty ($(leftovers)); these tests need a disposable one that is"; exit 2; }
echo "# rebuild.sh lifecycle tests on $(sql 'SHOW server_version')"

# ---------------------------------------------------------------------------------------------------------------------------
echo "# 1. What it refuses, and that a refusal touches nothing and prints no credential"
secret='hunter2-test-password'
for refused in "postgresql://postgres:$secret@$host${port:+:$port}/postgres" "postgresql://postgres@example.com${port:+:$port}/postgres" \
  "postgresql://postgres@$host${port:+:$port}/postgres?host=db.example.com" "postgresql://postgres@$host${port:+:$port}/postgres?hostaddr=10.0.0.1" \
  "postgresql://postgres@$host${port:+:$port}/postgres?service=elsewhere" "postgresql://postgres@$host,db.example.com${port:+:$port}/postgres" \
  "postgresql://$host${port:+:$port}/postgres" "postgresql://admin@$host${port:+:$port}/postgres" "postgresql://postgres@$host${port:+:$port}/otherdb" \
  "postgresql://postgres@$host${port:+:$port}/postgres/extra" "postgresql://postgres@$host:99999/postgres" "mysql://postgres@$host/postgres" "not a url" ""; do
  gate_url="$refused"; run_gate refusal
  label="${refused//$secret/<password>}"
  if [ "$gate_status" -eq 1 ] && ! has refusal "$secret" && cluster_is_empty && ! has refusal '== Roles'; then ok "refused, nothing built: ${label:-(empty)}"
  else not_ok "refused, nothing built: ${label:-(empty)}" "status $gate_status; $(leftovers); $(out refusal)"; fi
done
gate_url="postgresql://postgres:$secret@$host${port:+:$port}/postgres"; run_gate refusal
check "the refusal of a URL with a password says why, without the password" has refusal 'contains a password'
gate_url="$url"
for variable in PGHOSTADDR PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGHOST; do
  run_gate env-refusal "$variable=elsewhere.invalid"
  if [ "$gate_status" -eq 1 ] && has env-refusal "$variable is set" && cluster_is_empty; then ok "refused with $variable set, nothing built"; else not_ok "refused with $variable set" "$(out env-refusal)"; fi
done
run_gate snapdir-missing "REBUILD_SNAPSHOT_DIR=$work/no-such-directory"
if [ "$gate_status" -eq 1 ] && has snapdir-missing 'must be a directory that exists' && cluster_is_empty; then ok "a snapshot directory that does not exist is refused, nothing built"; else not_ok "missing snapshot directory" "$(out snapdir-missing)"; fi
: > "$work/a-file"; run_gate snapdir-file "REBUILD_SNAPSHOT_DIR=$work/a-file"
if [ "$gate_status" -eq 1 ] && cluster_is_empty; then ok "a snapshot 'directory' that is a file is refused, nothing built"; else not_ok "snapshot directory that is a file" "$(out snapdir-file)"; fi
if [ "$(id -u)" -ne 0 ]; then
  mkdir "$work/read-only" && chmod 555 "$work/read-only"; run_gate snapdir-readonly "REBUILD_SNAPSHOT_DIR=$work/read-only"
  if [ "$gate_status" -eq 1 ] && has snapdir-readonly 'cannot be written to' && cluster_is_empty && ! has snapdir-readonly '== Roles'; then ok "an unwritable snapshot directory stops the run before anything is built"; else not_ok "unwritable snapshot directory" "$(out snapdir-readonly)"; fi
  chmod 755 "$work/read-only"
else echo "# (running as root, which can write anywhere: the unwritable-directory case is skipped; the file that cannot be written is tested in 6)"; fi

# ---------------------------------------------------------------------------------------------------------------------------
echo "# 2. A cluster that is not the gate's to use is left exactly as found"
sql "CREATE DATABASE nfl_pool" > /dev/null; sql_in nfl_pool "CREATE TABLE keep(x int)" > /dev/null; sql_in nfl_pool "INSERT INTO keep VALUES (42)" > /dev/null
run_gate foreign-db
if [ "$gate_status" -eq 1 ] && [ "$(sql_in nfl_pool 'SELECT x FROM keep')" = 42 ] && [ "$(leftovers)" = "database nfl_pool" ]; then ok "a database named like the gate's, with data, is refused and kept intact"; else not_ok "foreign database named like the gate's" "$(leftovers); $(out foreign-db)"; fi
reset_cluster
sql "CREATE DATABASE someone_elses" > /dev/null; run_gate other-db
if [ "$gate_status" -eq 1 ] && [ "$(leftovers)" = "database someone_elses" ]; then ok "a cluster that holds a database of its own is refused and the database kept"; else not_ok "foreign database of its own" "$(leftovers); $(out other-db)"; fi
reset_cluster
sql "CREATE ROLE anonymous NOLOGIN" > /dev/null; run_gate foreign-role
if [ "$gate_status" -eq 1 ] && [ "$(leftovers)" = "role anonymous" ] && [ -z "$(sql "SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname='anonymous'")" ]; then ok "a cluster that already has one of the gate's roles is refused and the role kept, unmarked"; else not_ok "foreign role" "$(leftovers); $(out foreign-role)"; fi
reset_cluster
sql "CREATE ROLE nfl_pool_rebuild_lock NOLOGIN" > /dev/null; sql "COMMENT ON ROLE nfl_pool_rebuild_lock IS 'another execution, not this one'" > /dev/null; run_gate foreign-lock
if [ "$gate_status" -eq 1 ] && has foreign-lock 'another execution of the gate holds this cluster' && has foreign-lock 'another execution, not this one' \
   && [ "$(leftovers)" = "role nfl_pool_rebuild_lock" ] && [ "$(sql "SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname='nfl_pool_rebuild_lock'")" = "another execution, not this one" ]; then
  ok "a lock held by another execution stops the run, names its holder, and is left exactly as it was"; else not_ok "foreign lock" "$(leftovers); $(out foreign-lock)"; fi
reset_cluster

# ---------------------------------------------------------------------------------------------------------------------------
echo "# 3. Simultaneous invocations: exactly one builds, the others stop at once, and none interferes with the one that builds"
for i in 1 2 3 4; do ( env REBUILD_PG_URL="$url" bash "$gate" > "$work/simultaneous-$i.out" 2>&1; echo $? > "$work/simultaneous-$i.status" ) & done
wait
passed=0; refused_count=0; other=0
for i in 1 2 3 4; do
  s="$(cat "$work/simultaneous-$i.status")"
  if [ "$s" = 0 ]; then passed=$((passed + 1)); winner="$i"
  elif [ "$s" = 1 ] && grep -q -e 'another execution of the gate' -e 'appears to be running' "$work/simultaneous-$i.out"; then refused_count=$((refused_count + 1))
  else other=$((other + 1)); fi
done
if [ "$passed" -eq 1 ] && [ "$refused_count" -eq 3 ] && [ "$other" -eq 0 ]; then ok "four started together: one passed, three were refused naming the lock"; else not_ok "four started together" "passed $passed, refused $refused_count, other $other"; fi
if [ "$passed" -eq 1 ] && grep -q '^Behavior: .* 0 failed' "$work/simultaneous-$winner.out" && grep -q '^Personal rebuild gate passed' "$work/simultaneous-$winner.out" && grep -q '^Full-field guard: 9 passed' "$work/simultaneous-$winner.out"; then ok "the one that built ran every suite to the end: nothing a refused invocation did disturbed it"; else not_ok "the winner ran to the end" "$(tail -5 "$work/simultaneous-${winner:-1}.out")"; fi
check "the cluster is as it was found after four invocations" cluster_is_empty

# ---------------------------------------------------------------------------------------------------------------------------
echo "# 4. A cleanup that fails gives a nonzero status, names what it could not remove, and the next run refuses on it"
( wait_until "SELECT count(*) FROM pg_roles WHERE rolname='authenticated'" 1 \
  && sql "CREATE TABLE public.cleanup_blocker(i int)" > /dev/null && sql "ALTER TABLE public.cleanup_blocker OWNER TO authenticated" > /dev/null ) &
blocker=$!
run_gate cleanup-fails; wait "$blocker"
if [ "$gate_status" -eq 3 ]; then ok "everything passed, one role could not be dropped: exit status 3"; else not_ok "exit status 3 when only the cleanup fails" "status $gate_status; $(tail -6 "$work/cleanup-fails.out")"; fi
check "the output says the build passed" has cleanup-fails '^Behavior: .* 0 failed'
check "it names the role it could not drop" has cleanup-fails '::warning::could not drop role authenticated'
check "it says the cleanup is incomplete" has cleanup-fails 'cleanup incomplete'
if [ "$(leftovers)" = "role authenticated" ]; then ok "it dropped everything else it made, the databases and the lock included"; else not_ok "everything else dropped" "$(leftovers)"; fi
run_gate after-failed-cleanup
if [ "$gate_status" -eq 1 ] && has after-failed-cleanup 'already has roles the gate builds' && [ "$(leftovers)" = "role authenticated" ] && [ "$(sql_in postgres 'SELECT count(*) FROM public.cleanup_blocker')" = 0 ]; then ok "the next run refuses on what was left and leaves it alone"; else not_ok "next run after a failed cleanup" "$(leftovers); $(out after-failed-cleanup)"; fi
reset_cluster
check "(the test removed what it planted)" cluster_is_empty

# A run that FAILS and whose cleanup fails too stays nonzero, and still reports the cleanup.
( wait_until "SELECT count(*) FROM pg_roles WHERE rolname='authenticated'" 1 \
  && sql "CREATE TABLE public.cleanup_blocker(i int)" > /dev/null && sql "ALTER TABLE public.cleanup_blocker OWNER TO authenticated" > /dev/null
  wait_until "SELECT count(*) FROM pg_database WHERE datname='nfl_pool_rebuilt'" 1 && sql_in nfl_pool_rebuilt "CREATE TABLE public.nfl_contests(x int)" > /dev/null ) &
blocker=$!
run_gate failing-run-failing-cleanup; wait "$blocker"
if [ "$gate_status" -ne 0 ] && [ "$gate_status" -ne 3 ] && has failing-run-failing-cleanup 'migration .* failed' && has failing-run-failing-cleanup '::warning::could not drop role authenticated'; then ok "a failed run whose cleanup also fails exits nonzero (status $gate_status) and reports both"; else not_ok "failed run and failed cleanup" "status $gate_status; $(tail -8 "$work/failing-run-failing-cleanup.out")"; fi
reset_cluster

# ---------------------------------------------------------------------------------------------------------------------------
echo "# 5. Cleanup removes only what carries this execution's own mark"
# A role whose mark has become someone else's by the time the run ends: not dropped, said so, exit 3, everything of its own gone.
( wait_until "SELECT count(*) FROM pg_roles WHERE rolname='anonymous' AND shobj_description(oid,'pg_authid') LIKE 'nfl-pool-rebuild-gate run %'" 1 \
  && sql "COMMENT ON ROLE anonymous IS 'someone else'" > /dev/null ) &
tamper=$!
run_gate not-ours-role; wait "$tamper"
if [ "$gate_status" -eq 3 ]; then ok "a role that is no longer marked as this execution's: the run exits 3"; else not_ok "exit status with a role that is no longer its own" "status $gate_status; $(tail -8 "$work/not-ours-role.out")"; fi
check "it says it did not drop the role, and why" has not-ours-role "::warning::not dropping role anonymous: it is not marked as made by this execution"
if [ "$(leftovers)" = "role anonymous" ] && [ "$(sql "SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname='anonymous'")" = "someone else" ]; then ok "that role is still there, untouched, and everything that was this execution's own is gone (databases, other roles, the lock)"; else not_ok "foreign-marked role kept, the rest removed" "$(leftovers)"; fi
reset_cluster
# The same for a database. The roles that own or hold privileges in it cannot be dropped while it stays: they are reported too.
( wait_until "SELECT count(*) FROM pg_database WHERE datname='nfl_pool_prod_shape' AND shobj_description(oid,'pg_database') LIKE 'nfl-pool-rebuild-gate run %'" 1 \
  && sql "COMMENT ON DATABASE nfl_pool_prod_shape IS 'someone else'" > /dev/null ) &
tamper=$!
run_gate not-ours-database; wait "$tamper"
if [ "$gate_status" -eq 3 ]; then ok "a database that is no longer marked as this execution's: the run exits 3"; else not_ok "exit status with a database that is no longer its own" "status $gate_status; $(tail -8 "$work/not-ours-database.out")"; fi
check "it says it did not drop the database, and why" has not-ours-database "::warning::not dropping database nfl_pool_prod_shape: it is not marked as made by this execution"
if [ "$(sql "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='nfl_pool_prod_shape'")" = "someone else" ] \
   && ! echo "$(leftovers)" | grep -q -e 'database nfl_pool,' -e 'database nfl_pool_rebuilt' && [ -z "$(sql "SELECT 1 FROM pg_roles WHERE rolname='nfl_pool_rebuild_lock'")" ]; then
  ok "that database is still there with its foreign mark; the other databases and the lock were removed"; else not_ok "foreign-marked database kept, the rest removed" "$(leftovers)"; fi
reset_cluster

# ---------------------------------------------------------------------------------------------------------------------------
echo "# 6. A signal ends the run through the same cleanup; a snapshot file that cannot be written is a failure"
( env REBUILD_PG_URL="$url" bash "$gate" > "$work/signalled.out" 2>&1; echo $? > "$work/signalled.status" ) &
runner=$!
if wait_until "SELECT count(*) FROM pg_database WHERE datname='nfl_pool_rebuilt'" 1; then
  pkill -TERM -f "bash $gate" 2> /dev/null; wait "$runner" 2> /dev/null
  s="$(cat "$work/signalled.status")"
  if [ "$s" = 143 ] && cluster_is_empty; then ok "SIGTERM mid-run: exit status 143, and the cluster is as it was found"; else not_ok "SIGTERM mid-run" "status $s; left: $(leftovers); $(tail -4 "$work/signalled.out")"; fi
else wait "$runner" 2> /dev/null; not_ok "SIGTERM mid-run: the run ended before it could be signalled" "$(tail -4 "$work/signalled.out")"; fi
reset_cluster
mkdir -p "$work/snaps/rebuilt.json"   # a directory where the file must go: no write can succeed, root or not
run_gate unwritable-file "REBUILD_SNAPSHOT_DIR=$work/snaps"
if [ "$gate_status" -eq 1 ] && has unwritable-file 'could not write rebuilt.json' && cluster_is_empty; then ok "a snapshot file that cannot be written fails the run (status 1) and the cluster is cleaned"; else not_ok "unwritable snapshot file" "status $gate_status; $(leftovers); $(tail -5 "$work/unwritable-file.out")"; fi
rm -rf "$work/snaps"; mkdir "$work/snaps"
run_gate snapshots "REBUILD_SNAPSHOT_DIR=$work/snaps" PGPASSWORD=sentinel-secret-for-output-check
if [ "$gate_status" -eq 0 ] && [ "$(ls "$work/snaps" | sort | tr '\n' ' ')" = "production-shape-environment.json production-shape.json rebuilt.json reference.json " ]; then ok "when asked, the four snapshot files are written"; else not_ok "snapshot files written" "status $gate_status; $(ls "$work/snaps")"; fi
if ! grep -r -q 'sentinel-secret-for-output-check' "$work/snapshots.out" "$work/snaps"; then ok "a password in PGPASSWORD appears neither in the output nor in the snapshot files"; else not_ok "PGPASSWORD leaked"; fi
check "the production shape is the documented catalog (7f1b05a8...)" has snapshots 'production shape sha256 7f1b05a83ab6578a87455528b58d5dd04486ca5b4fcb91408f8d1cefd4b9d45d'
check "and the cluster is as it was found" cluster_is_empty

echo "1..$tests"
if [ "$failed" -ne 0 ]; then echo "# $failed of $tests failed"; exit 1; fi
echo "# all $tests passed"
