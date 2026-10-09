#!/usr/bin/env bash
# HDC-13 SQL behavior gate. Starts a throwaway PostgreSQL 17.11 container (the pinned image below), emulates the production
# Neon shape (neon-shape.sql), applies migrations 001, 002, 003, 004 and 005 in order as nfl_pool_owner exactly as the files
# are in this checkout (003 with its kickoff supplied explicitly), checks that migration 005 refuses a second application and
# any other role, loads fixtures.sql, then runs the behavior suite (behavior.sql) and the race suite (races.sh). No Neon, no
# secrets, no network but the image pull. Exits 0 only when every migration applied, every behavior assertion of the plan
# passed and every race assertion passed.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations="$(cd "$here/../migrations" && pwd)"
IMAGE="${HDC13_PG_IMAGE:-postgres:17.11@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3}"
EXPECTED_SERVER_VERSION='17.11'
# The verified 2026 Week-1 kickoff migration 003 is applied with (the production value of nfl_contests.starts_at).
KICKOFF_2026='2026-09-10T00:20:00+00:00'
C="hdc13-sql-$$"
log="$(mktemp -d)"
problems=0

cleanup() { docker rm -f "$C" > /dev/null 2>&1; rm -rf "$log"; }
trap cleanup EXIT
problem() { problems=$((problems + 1)); echo "::error title=HDC-13 SQL gate::$1"; }
# psql inside the container (so the client is the pinned 17.11 one too); SQL on stdin.
psql_as() { docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -U "$1" -d "$2"; }

echo "Image: $IMAGE"
docker run -d --name "$C" -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" -c TimeZone=GMT -c max_connections=50 > /dev/null || { echo "::error::could not start $IMAGE"; exit 1; }
# The image's entrypoint runs a socket-only server during initdb, then restarts; wait for the restart to finish.
ready=0
for _ in $(seq 1 120); do
  if docker logs "$C" 2>&1 | grep -q 'PostgreSQL init process complete' && docker exec "$C" pg_isready -U postgres -q 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { docker logs "$C" 2>&1 | tail -20; echo "::error::PostgreSQL did not become ready"; exit 1; }

version="$(docker exec "$C" psql -X -At -U postgres -c 'SHOW server_version' | cut -d' ' -f1)"
echo "Server: PostgreSQL $version ($(docker exec "$C" psql -X -At -U postgres -c 'SELECT version()'))"
[ "$version" = "$EXPECTED_SERVER_VERSION" ] || { echo "::error::expected PostgreSQL $EXPECTED_SERVER_VERSION, found $version"; exit 1; }

echo "== Production Neon shape"
psql_as postgres postgres < "$here/neon-shape.sql" || { echo "::error::neon-shape.sql failed"; exit 1; }

echo "== Migrations, in order, as nfl_pool_owner"
for m in 001-survivor-weeks.sql 002-contest-rulings.sql; do
  if psql_as nfl_pool_owner nfl_pool < "$migrations/$m"; then echo "applied $m"; else problem "migration $m failed"; fi
done
if { printf "SET nfl_pool.contest_start_2026 = '%s';\n" "$KICKOFF_2026"; cat "$migrations/003-pool-center-2026-contests.sql"; } | psql_as nfl_pool_owner nfl_pool; then
  echo "applied 003-pool-center-2026-contests.sql (kickoff $KICKOFF_2026)"
else problem 'migration 003-pool-center-2026-contests.sql failed'; fi
if [ -f "$migrations/004-incident-ruling-writes.sql" ]; then
  if psql_as nfl_pool_owner nfl_pool < "$migrations/004-incident-ruling-writes.sql"; then echo "applied 004-incident-ruling-writes.sql"; else problem 'migration 004-incident-ruling-writes.sql failed'; fi
else
  problem 'migration 004-incident-ruling-writes.sql is missing: the HDC-13 write surface does not exist'
fi
# HDC-14. Migration 005 refuses a second application and any role but nfl_pool_owner; a refused application changes no
# function, grant or constraint.
m5=005-absent-game-adjudication.sql
if [ -f "$migrations/$m5" ]; then
  if psql_as nfl_pool_owner nfl_pool < "$migrations/$m5"; then
    echo "applied $m5"
    schema_state() { docker exec "$C" psql -X -At -U postgres -d nfl_pool -c "SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
      SELECT p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || COALESCE(p.proacl::text, '') AS x FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      UNION ALL SELECT c.conname || ':' || pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.nfl_incident_rulings'::regclass) q"; }
    before="$(schema_state)"
    for role in nfl_pool_owner postgres; do
      if psql_as "$role" nfl_pool < "$migrations/$m5" > "$log/m5-$role.out" 2>&1; then
        problem "migration 005 applied a second time as $role: its preconditions must refuse it"
      else
        refusal="$(grep -m1 -o 'ERROR: .*' "$log/m5-$role.out")"
        case "$role:$refusal" in
          nfl_pool_owner:*'migration 005'*|postgres:*'must be applied as nfl_pool_owner'*) echo "HDC14-MIGRATION ok: a second application as $role is refused ($refusal)";;
          *) problem "migration 005 as $role was refused for an unexpected reason: ${refusal:-no error}";;
        esac
      fi
    done
    [ "$(schema_state)" = "$before" ] || problem 'a refused application of migration 005 changed the schema'
  else
    problem "migration $m5 failed"
  fi
else
  problem "migration $m5 is missing: the HDC-14 absent-game write path does not exist"
fi

echo "== Fixtures"
psql_as postgres nfl_pool < "$here/fixtures.sql" || { echo "::error::fixtures.sql failed"; exit 1; }

echo "== Behavior suite"
psql_as postgres nfl_pool < "$here/behavior.sql" > "$log/behavior.out" 2>&1
behavior_status=$?
grep -E '^NOTICE:  HDC13-TEST ' "$log/behavior.out" | sed 's/^NOTICE:  //'
behavior_ok="$(grep -c '^NOTICE:  HDC13-TEST ok: ' "$log/behavior.out")"
behavior_fail="$(grep -c '^NOTICE:  HDC13-TEST FAIL: ' "$log/behavior.out")"
plan="$(sed -n 's/^HDC13-PLAN \([0-9][0-9]*\)$/\1/p' "$log/behavior.out")"
if [ "$behavior_status" -ne 0 ]; then
  grep -v '^NOTICE:  HDC13-TEST ' "$log/behavior.out" | tail -20
  problem "behavior.sql stopped with exit code $behavior_status"
fi
[ "$behavior_fail" -eq 0 ] || problem "$behavior_fail behavior assertion(s) failed"
[ -n "$plan" ] && [ "$behavior_ok" -eq "$plan" ] || problem "behavior suite: $behavior_ok passed, plan ${plan:-missing}"
echo "Behavior: $behavior_ok passed, $behavior_fail failed, plan ${plan:-missing}"

echo "== Race suite"
HDC13_PG_CONTAINER="$C" bash "$here/races.sh" > "$log/races.out" 2>&1
races_status=$?
cat "$log/races.out"
[ "$races_status" -eq 0 ] || problem "race suite failed (exit $races_status)"

echo "PostgreSQL $version · behavior $behavior_ok/${plan:-?} · $(grep -o 'races=[0-9]* passed=[0-9]* failed=[0-9]*' "$log/races.out" || echo 'races: no summary')"
if [ "$problems" -ne 0 ]; then echo "HDC-13 SQL gate FAILED ($problems problem(s))"; exit 1; fi
echo "HDC-13 SQL gate passed"
