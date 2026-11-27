#!/usr/bin/env bash
# Pool Alerts end-to-end integration on a throwaway PostgreSQL 17.11 container (the same pinned image as the SQL gate),
# shaped like production (nfl-pool/sql-tests/neon-shape.sql: Data API roles, RLS, neon_auth), with the full-field guard
# and migrations 006 and 007 applied as nfl_pool_owner. The sender connects as pool_alerts_sender (no other privilege). Push
# deliveries go to a local HTTPS push service that verifies VAPID and decrypts every payload. No Neon, no secrets, no
# network but the image pull.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
IMAGE="${HDC13_PG_IMAGE:-postgres:17.11@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3}"
C="pool-alerts-it-$$"
cleanup() { docker rm -f "$C" > /dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$C" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 "$IMAGE" -c TimeZone=GMT -c max_connections=100 > /dev/null
for _ in $(seq 1 120); do
  if docker logs "$C" 2>&1 | grep -q 'PostgreSQL init process complete' && docker exec "$C" pg_isready -U postgres -q 2>/dev/null; then break; fi
  sleep 1
done
docker exec "$C" pg_isready -U postgres -q || { docker logs "$C" | tail -20; echo 'PostgreSQL did not become ready'; exit 1; }
port="$(docker port "$C" 5432/tcp | head -1 | sed 's/.*://')"
psql_as() { docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -U "$1" -d "$2"; }

psql_as postgres postgres < "$root/sql-tests/neon-shape.sql"
psql_as nfl_pool_owner nfl_pool < "$root/migrations/20261108_full_field_publish_guard.sql"
psql_as nfl_pool_owner nfl_pool < "$root/migrations/006-pool-alerts.sql"
psql_as nfl_pool_owner nfl_pool < "$root/migrations/007-pool-alerts-device-checks.sql"
psql_as postgres nfl_pool <<'SQL'
INSERT INTO neon_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Commissioner', 'DJSmokke@Gmail.com', true, now(), now(), 'admin', NULL),
  ('00000000-0000-4000-8000-000000000002', 'Participant', 'participant@example.com', true, now(), now(), 'user', false);
-- The owner's post-migration steps, as the runbook gives them: mark the environment, enable the sender's login.
INSERT INTO pool_alerts.environment (name) VALUES ('test');
ALTER ROLE pool_alerts_sender LOGIN;
SQL

export PUSH_IT_ADMIN_URL="postgresql://postgres@127.0.0.1:$port/nfl_pool"
export PUSH_IT_SENDER_URL="postgresql://pool_alerts_sender@127.0.0.1:$port/nfl_pool"
node "$here/integration.spec.mjs"
