#!/usr/bin/env bash
# Pool Alerts / Personal backup compatibility. Runs inside the HDC-13 container (HDC13_PG_CONTAINER) after every suite.
#
# The Personal backup (smokke-dashboard scripts/personal-pool-cloud-backup.sh) dumps ONLY the public schema of nfl_pool
# with pg_dump --format=custom --schema=public --enable-row-security --inserts --no-large-objects, and the documented
# restore proof (smokke-dashboard docs/CLOUD_BACKUPS.md) restores it with --single-transaction --exit-on-error into a
# fresh database prepared by ops/personal-backup-restore-prereqs.sql (vendored here byte-for-byte as
# backup-restore-prereqs.sql, sha256 b8bdedc61ac82938ce8a1f6610e023d5e557f81e416697ecd18399ffadb807f2, from
# smokke-dashboard a035c00). Migration 006 adds a trigger on public.nfl_pool_weeks and its function in public, so this
# check proves the unchanged procedure still restores, keeps the trigger, and that the restored copy (which has no
# pool_alerts schema) still accepts publication writes. It also re-checks the backup preflight's table count.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C="${HDC13_PG_CONTAINER:?HDC13_PG_CONTAINER is required}"
passed=0
fail() { echo "BACKUP-COMPAT FAIL: $1"; exit 1; }
ok() { passed=$((passed + 1)); echo "BACKUP-COMPAT ok: $1"; }
q() { docker exec -i "$C" psql -X -At -v ON_ERROR_STOP=1 -U postgres -d "$1" -c "$2"; }

expected_sha='b8bdedc61ac82938ce8a1f6610e023d5e557f81e416697ecd18399ffadb807f2'
[ "$(sha256sum "$here/backup-restore-prereqs.sql" | cut -d' ' -f1)" = "$expected_sha" ] || fail 'vendored restore prerequisites differ from the reviewed smokke-dashboard copy'
ok 'vendored restore prerequisites match the reviewed copy'

[ "$(q nfl_pool "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = 5 ] || fail 'public no longer holds exactly five tables (backup preflight would refuse)'
ok 'public still holds exactly five tables (backup preflight condition)'

docker exec "$C" sh -ec 'pg_dump -U postgres --format=custom --schema=public --enable-row-security --inserts --no-large-objects --file=/tmp/personal-pool.dump nfl_pool' || fail 'pg_dump of the public schema failed'
ok 'pg_dump --schema=public succeeds'
docker exec "$C" sh -ec 'pg_restore --list /tmp/personal-pool.dump > /tmp/catalog.txt'
[ "$(docker exec "$C" grep -c ' TABLE DATA ' /tmp/catalog.txt)" = 5 ] || fail 'the archive does not hold exactly five table-data entries'
ok 'archive holds exactly five table-data entries (backup script check)'
docker exec "$C" grep -q 'TRIGGER public nfl_pool_weeks nfl_pool_alerts_capture' /tmp/catalog.txt || fail 'the capture trigger is not in the archive'
docker exec "$C" grep -q 'FUNCTION public nfl_pool_alerts_capture()' /tmp/catalog.txt || fail 'the capture function is not in the archive'
if docker exec "$C" grep -Eq ' (SCHEMA - pool_alerts|TABLE pool_alerts|TABLE DATA pool_alerts|SEQUENCE pool_alerts) ' /tmp/catalog.txt; then
  fail 'the public-only archive unexpectedly contains pool_alerts objects'
fi
ok 'archive carries the trigger and its function, and nothing from pool_alerts'

q postgres "DROP DATABASE IF EXISTS restore_proof" > /dev/null
q postgres "CREATE DATABASE restore_proof TEMPLATE template0" > /dev/null || fail 'could not create restore_proof'
docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d restore_proof < "$here/backup-restore-prereqs.sql" > /dev/null || fail 'restore prerequisites failed'
# The documented list filter: drop only the archive's own CREATE SCHEMA public entry.
docker exec "$C" sh -ec "pg_restore --list /tmp/personal-pool.dump | awk '\$4 != \"SCHEMA\" || \$5 != \"-\" || \$6 != \"public\" || \$7 != \"pg_database_owner\"' > /tmp/restore.list"
docker exec "$C" sh -ec 'pg_restore --use-list=/tmp/restore.list --single-transaction --exit-on-error -U postgres -d restore_proof /tmp/personal-pool.dump' || fail 'the documented single-transaction restore failed'
ok 'the documented single-transaction, exit-on-error restore succeeds'

src="$(q nfl_pool "SELECT count(*) FROM public.nfl_pool_weeks")"
dst="$(q restore_proof "SELECT count(*) FROM public.nfl_pool_weeks")"
[ "$src" = "$dst" ] || fail "restored nfl_pool_weeks has $dst rows, source $src"
ok "restored Pick'em weeks match the source ($dst rows)"
[ "$(q restore_proof "SELECT count(*) FROM pg_trigger WHERE tgname='nfl_pool_alerts_capture' AND NOT tgisinternal")" = 1 ] || fail 'restored copy lacks the trigger'
[ "$(q restore_proof "SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.nfl_pool_alerts_capture()'::regprocedure")" = nfl_pool_owner ] || fail 'restored function owner is not nfl_pool_owner'
ok 'restored copy keeps the trigger and the function owner'
[ "$(q restore_proof "SELECT count(*) FROM pg_namespace WHERE nspname='pool_alerts'")" = 0 ] || fail 'restored copy unexpectedly has pool_alerts'

# A publication write in the restored copy (no pool_alerts schema) still succeeds, with only a warning.
out="$(docker exec -i "$C" psql -X -v ON_ERROR_STOP=1 -U postgres -d restore_proof 2>&1 <<'SQL'
INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at, locked_at)
VALUES (2097, 1, 'locked', '{"schemaVersion":1,"season":2097,"week":1,"games":[],"participants":[]}', 1, now(), now());
UPDATE public.nfl_pool_weeks SET revision = 2 WHERE season = 2097 AND week = 1;
SQL
)" || fail "a publication write in the restored copy failed: $out"
printf '%s' "$out" | grep -q 'WARNING:  Pool Alerts did not record this publication change' || fail 'expected the fail-open warning in the restored copy'
[ "$(q restore_proof "SELECT revision FROM public.nfl_pool_weeks WHERE season=2097 AND week=1")" = 2 ] || fail 'the restored-copy write did not land'
ok 'a restored copy without pool_alerts still accepts publication writes (fail-open warning only)'

q postgres "DROP DATABASE restore_proof" > /dev/null
docker exec "$C" rm -f /tmp/personal-pool.dump /tmp/catalog.txt /tmp/restore.list
echo "backup-compat passed=$passed"
