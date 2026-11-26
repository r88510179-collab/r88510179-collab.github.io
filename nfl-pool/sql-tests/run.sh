#!/usr/bin/env bash
# HDC-13 SQL behavior gate. Starts a throwaway PostgreSQL 17.11 container (the pinned image below), emulates the production
# Neon shape (neon-shape.sql), applies migrations 001, 002, 003, 004 and 005 in order as nfl_pool_owner exactly as the files
# are in this checkout (003 with its kickoff supplied explicitly), checks that migration 005 refuses a second application and
# any other role, applies the full-field publication guard (twice: it is idempotent), loads fixtures.sql, then runs the
# full-field guard checks (full-field-guard.sql), the behavior suite (behavior.sql) and the race suite (races.sh). No Neon,
# no secrets, no network but the image pull. Exits 0 only when every migration applied, every guard and behavior assertion
# of its plan passed and every race assertion passed.
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

# PR #36 full-field publication guard (a CHECK constraint, safe to re-run): applied after 005 so every later suite runs
# with the constraint production has, and then exercised by full-field-guard.sql.
guard=20261108_full_field_publish_guard.sql
if [ -f "$migrations/$guard" ]; then
  if psql_as nfl_pool_owner nfl_pool < "$migrations/$guard" && psql_as nfl_pool_owner nfl_pool < "$migrations/$guard"; then
    echo "applied $guard (and re-applied: idempotent)"
  else problem "migration $guard failed"; fi
else
  problem "migration $guard is missing: the full-field publication guard does not exist"
fi

echo "== Fixtures"
psql_as postgres nfl_pool < "$here/fixtures.sql" || { echo "::error::fixtures.sql failed"; exit 1; }

echo "== Full-field publication guard"
psql_as postgres nfl_pool < "$here/full-field-guard.sql" > "$log/guard.out" 2>&1
guard_status=$?
grep -E '^NOTICE:  GUARD-TEST ' "$log/guard.out" | sed 's/^NOTICE:  //'
guard_ok="$(grep -c '^NOTICE:  GUARD-TEST ok: ' "$log/guard.out")"
guard_plan="$(sed -n 's/^GUARD-PLAN \([0-9][0-9]*\)$/\1/p' "$log/guard.out")"
[ "$guard_status" -eq 0 ] || { tail -20 "$log/guard.out"; problem "full-field-guard.sql stopped with exit code $guard_status"; }
[ -n "$guard_plan" ] && [ "$guard_ok" -eq "$guard_plan" ] || problem "full-field guard: $guard_ok passed, plan ${guard_plan:-missing}"
echo "Full-field guard: $guard_ok passed, plan ${guard_plan:-missing}"

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

# Pool Alerts (migration 006): applied AFTER the unchanged behavior suite (whose shape assertions pin the HDC-12..14
# function set exactly) and BEFORE the race suite, so the concurrent publish/republish races run with the capture trigger
# live and prove that publishing is unaffected. The fixtures already in the database play the production weeks that
# exist when 006 is applied (no event, so no historical notification). It refuses any role but nfl_pool_owner and a
# second application, changing nothing when it refuses.
m6=006-pool-alerts.sql
if [ -f "$migrations/$m6" ]; then
  alerts_state() { docker exec "$C" psql -X -At -U postgres -d nfl_pool -c "SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
    SELECT n.nspname || '.' || c.relname || ':' || c.relkind AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'pool_alerts')
    UNION ALL SELECT p.oid::regprocedure::text || ':' || md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    UNION ALL SELECT t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal
    UNION ALL SELECT r.rolname FROM pg_roles r) q"; }
  before="$(alerts_state)"
  if psql_as postgres nfl_pool < "$migrations/$m6" > "$log/m6-postgres.out" 2>&1; then
    problem "migration 006 applied as postgres: it must refuse every role but nfl_pool_owner"
  else
    refusal="$(grep -m1 -o 'ERROR: .*' "$log/m6-postgres.out")"
    case "$refusal" in *'must be applied as nfl_pool_owner'*) echo "ALERTS-MIGRATION ok: application as postgres is refused ($refusal)";;
      *) problem "migration 006 as postgres was refused for an unexpected reason: ${refusal:-no error}";; esac
  fi
  [ "$(alerts_state)" = "$before" ] || problem 'a refused application of migration 006 changed the schema'
  if psql_as nfl_pool_owner nfl_pool < "$migrations/$m6"; then
    echo "applied $m6"
    before="$(alerts_state)"
    if psql_as nfl_pool_owner nfl_pool < "$migrations/$m6" > "$log/m6-again.out" 2>&1; then
      problem 'migration 006 applied a second time: its preconditions must refuse it'
    else
      refusal="$(grep -m1 -o 'ERROR: .*' "$log/m6-again.out")"
      case "$refusal" in *'already applied'*) echo "ALERTS-MIGRATION ok: a second application is refused ($refusal)";;
        *) problem "a second application of migration 006 was refused for an unexpected reason: ${refusal:-no error}";; esac
    fi
    [ "$(alerts_state)" = "$before" ] || problem 'a refused second application of migration 006 changed the schema'
  else
    problem "migration $m6 failed"
  fi
else
  problem "migration $m6 is missing: the Pool Alerts capture does not exist"
fi

echo "== Race suite"
HDC13_PG_CONTAINER="$C" bash "$here/races.sh" > "$log/races.out" 2>&1
races_status=$?
cat "$log/races.out"
[ "$races_status" -eq 0 ] || problem "race suite failed (exit $races_status)"

echo "== Pool Alerts capture suite"
psql_as postgres nfl_pool < "$here/pool-alerts.sql" > "$log/alerts.out" 2>&1
alerts_status=$?
grep -E '^NOTICE:  ALERTS-TEST ' "$log/alerts.out" | sed 's/^NOTICE:  //'
alerts_ok="$(grep -c '^NOTICE:  ALERTS-TEST ok: ' "$log/alerts.out")"
alerts_fail="$(grep -c '^NOTICE:  ALERTS-TEST FAIL: ' "$log/alerts.out")"
alerts_plan="$(sed -n 's/^ALERTS-PLAN \([0-9][0-9]*\)$/\1/p' "$log/alerts.out")"
if [ "$alerts_status" -ne 0 ]; then
  grep -v '^NOTICE:  ALERTS-TEST ' "$log/alerts.out" | tail -20
  problem "pool-alerts.sql stopped with exit code $alerts_status"
fi
[ "$alerts_fail" -eq 0 ] || problem "$alerts_fail Pool Alerts assertion(s) failed"
[ -n "$alerts_plan" ] && [ "$alerts_ok" -eq "$alerts_plan" ] || problem "Pool Alerts suite: $alerts_ok passed, plan ${alerts_plan:-missing}"
echo "Pool Alerts: $alerts_ok passed, $alerts_fail failed, plan ${alerts_plan:-missing}"

echo "== Personal backup compatibility (public-schema dump and restore with the documented prerequisites)"
HDC13_PG_CONTAINER="$C" bash "$here/backup-compat.sh" > "$log/backup.out" 2>&1
backup_status=$?
cat "$log/backup.out"
[ "$backup_status" -eq 0 ] || problem "backup compatibility check failed (exit $backup_status)"

echo "== Pool Alerts rollback and re-application"
rollback_ok=0
if psql_as nfl_pool_owner nfl_pool < "$migrations/006-pool-alerts-rollback.sql"; then
  state="$(docker exec "$C" psql -X -At -U postgres -d nfl_pool -c "SELECT (SELECT count(*) FROM pg_namespace WHERE nspname='pool_alerts')||':'||
    (SELECT count(*) FROM pg_trigger WHERE tgname='nfl_pool_alerts_capture')||':'||(SELECT count(*) FROM pg_roles WHERE rolname='pool_alerts_sender')||':'||
    (SELECT count(*) FROM pg_proc WHERE proname='nfl_pool_alerts_capture')||':'||(SELECT count(*) FROM pg_tables WHERE schemaname='public')")"
  [ "$state" = "0:0:0:0:5" ] && echo "ALERTS-ROLLBACK ok: schema, trigger, function and role removed; public keeps its five tables" && rollback_ok=$((rollback_ok+1)) || problem "rollback left objects behind ($state)"
  if printf "%s\n" "BEGIN; SELECT set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}', true); SET LOCAL ROLE authenticated;" \
     "INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at, locked_at) VALUES (2095, 1, 'locked', '{\"schemaVersion\":1,\"season\":2095,\"week\":1,\"games\":[],\"participants\":[]}', 1, now(), now());" \
     "COMMIT;" | psql_as postgres nfl_pool > /dev/null; then echo "ALERTS-ROLLBACK ok: publishing works after the rollback"; rollback_ok=$((rollback_ok+1)); else problem 'publishing failed after the Pool Alerts rollback'; fi
  if psql_as nfl_pool_owner nfl_pool < "$migrations/$m6" > /dev/null; then echo "ALERTS-ROLLBACK ok: migration 006 applies again after the rollback"; rollback_ok=$((rollback_ok+1)); else problem 'migration 006 could not be re-applied after the rollback'; fi
  if printf "%s\n" "BEGIN; SELECT set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}', true); SET LOCAL ROLE authenticated;" \
     "UPDATE public.nfl_pool_weeks SET revision = 2, config = jsonb_set(config, '{label}', '\"re-applied\"') WHERE season = 2095 AND week = 1;" "COMMIT;" | psql_as postgres nfl_pool > /dev/null \
     && [ "$(docker exec "$C" psql -X -At -U postgres -d nfl_pool -c "SELECT count(*) FROM pool_alerts.publication_events WHERE season = 2095 AND revision = 2")" = 1 ]; then
    echo "ALERTS-ROLLBACK ok: the re-applied trigger captures the next publication"; rollback_ok=$((rollback_ok+1))
  else problem 'the re-applied trigger did not capture the next publication'; fi
else
  problem 'the Pool Alerts rollback failed'
fi
if psql_as postgres nfl_pool < "$migrations/006-pool-alerts-rollback.sql" > "$log/rb.out" 2>&1; then problem 'the rollback ran as postgres'; else
  grep -q 'must be applied as nfl_pool_owner' "$log/rb.out" && echo "ALERTS-ROLLBACK ok: the rollback refuses any role but nfl_pool_owner" && rollback_ok=$((rollback_ok+1)) || problem 'rollback refused for an unexpected reason'; fi

echo "PostgreSQL $version · behavior $behavior_ok/${plan:-?} · full-field guard $guard_ok/${guard_plan:-?} · $(grep -o 'races=[0-9]* passed=[0-9]* failed=[0-9]*' "$log/races.out" || echo 'races: no summary') · alerts $alerts_ok/${alerts_plan:-?} · $(grep -o 'backup-compat passed=[0-9]*' "$log/backup.out" || echo 'backup: no summary') · rollback $rollback_ok/5"
[ "$rollback_ok" -eq 5 ] || problem "Pool Alerts rollback checks: $rollback_ok of 5"
if [ "$problems" -ne 0 ]; then echo "HDC-13 SQL gate FAILED ($problems problem(s))"; exit 1; fi
echo "HDC-13 SQL gate passed"
