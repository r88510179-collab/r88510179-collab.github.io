#!/usr/bin/env bash
# LOCAL REHEARSAL of the live harness (never evidence, never Neon). Needs a disposable LOCAL PostgreSQL superuser URL
# (the same kind the opt-in integration suite uses) and `npm install` in pool-platform/validation/live.
#   REHEARSAL_PG_CLUSTER=postgresql://postgres@127.0.0.1:55432/postgres PP_RUN_DIR=/some/private/dir \
#     bash pool-platform/validation/live/rehearsal/rehearse.sh
# It builds a database from the stub neon_auth/auth schema of migration-integration.test.mjs, migrations 001+002 and
# the synthetic fixtures, starts the mock Auth/Data API servers on 127.0.0.1:18081/18082 (JWT TTL 150 s so expiry is
# exercised) and runs every harness phase plus the owner steps in the same order as the live run.
set -euo pipefail
: "${REHEARSAL_PG_CLUSTER:?set REHEARSAL_PG_CLUSTER to a disposable local superuser URL}"
: "${PP_RUN_DIR:?set PP_RUN_DIR to a private directory outside the repository}"
HOST=$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$REHEARSAL_PG_CLUSTER")
[[ "$HOST" == 127.0.0.1 || "$HOST" == localhost ]] || { echo "refusing non-local database host $HOST"; exit 2; }
LIVE=$(cd "$(dirname "$0")/.." && pwd)
PP=$(cd "$LIVE/../.." && pwd)
DB=$(node -e 'const u=new URL(process.argv[1]);u.pathname="/pp_live_rehearsal";console.log(u.toString())' "$REHEARSAL_PG_CLUSTER")
OWNER=pool_platform_it_owner
rm -rf "$PP_RUN_DIR"; mkdir -p "$PP_RUN_DIR"; chmod 700 "$PP_RUN_DIR"
psql "$REHEARSAL_PG_CLUSTER" -X -q -v ON_ERROR_STOP=1 <<SQL
DO \$\$BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$OWNER') THEN CREATE ROLE $OWNER NOLOGIN; END IF;
END\$\$;
DROP DATABASE IF EXISTS pp_live_rehearsal WITH (FORCE);
CREATE DATABASE pp_live_rehearsal OWNER $OWNER;
SQL
node -e 'const fs=require("fs");const m=fs.readFileSync(process.argv[1],"utf8").match(/const STUB=`([\s\S]*?)`;/);process.stdout.write(m[1].replace(/\$\{OWNER\}/g,process.argv[2]))' "$PP/migration-integration.test.mjs" "$OWNER" | psql "$DB" -X -q -v ON_ERROR_STOP=1
owner_sql() { ( echo "SET ROLE $OWNER;"; cat "$@" ) | psql "$DB" -X -q -A -t -F ' | ' -v ON_ERROR_STOP=1; }
owner_sql "$PP/migrations/001_foundation.sql" "$PP/migrations/002_identity_submission_rls.sql" 2>&1 | grep -v NOTICE || true
( echo "SET ROLE $OWNER; BEGIN;"; cat "$LIVE/owner/F1_fixtures.sql"; echo "COMMIT;" ) | psql "$DB" -X -q -v ON_ERROR_STOP=1
echo "fixture digest: $(owner_sql "$LIVE/owner/F2_fixture_digest.sql")"
OTP_FILE="$PP_RUN_DIR/mock-otp.txt"
MOCK_PG="$DB" MOCK_JWT_TTL=150 MOCK_OTP_FILE="$OTP_FILE" node "$LIVE/rehearsal/mock-server.mjs" > "$PP_RUN_DIR/mock.log" 2>&1 &
MOCK=$!; trap 'kill $MOCK 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf -o /dev/null http://127.0.0.1:18081/neondb/auth/.well-known/jwks.json && break; node -e 'setTimeout(()=>{},200)'; done
export PP_REHEARSAL=1 PP_AUTH_URL=http://127.0.0.1:18081/neondb/auth PP_DATA_URL=http://127.0.0.1:18082/neondb/rest/v1 NODE_USE_ENV_PROXY=1
export PP_H_EMAIL=operator.rehearsal@example.com NODE_NO_WARNINGS=1
run() { (cd "$LIVE" && node harness/run.mjs "$@"); }
run probe signup sdk
owner_sql "$LIVE/owner/O1_memberships.sql" >/dev/null
run context auth invites hinvite tenantb sourcelock srcrace payload survivor status batch authorder surface isolation
BEFORE=$(owner_sql "$LIVE/owner/D1_digest_all.sql"); run directwrite; AFTER=$(owner_sql "$LIVE/owner/D1_digest_all.sql")
[[ "$BEFORE" == "$AFTER" ]] && echo "owner digest unchanged across direct-write probes" || { echo "OWNER DIGEST CHANGED"; exit 1; }
owner_sql "$LIVE/owner/O2_fixture_states.sql" >/dev/null
run expiredinv locked deadline authorder jwtexpiry signout
run human_send
PP_H_OTP=$(cat "$OTP_FILE") run human_verify isolation
owner_sql "$LIVE/owner/O3_consistency.sql" | tail -1
