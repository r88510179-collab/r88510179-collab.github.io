#!/usr/bin/env bash
# A1: read-only verification of the Commercial V1 production baseline, run by the operator with psql.
# See A1_AUTHORIZATION.md. This script runs nothing until the owner has signed that text and approved the run.
#
#   PP_SERVICE=<psql service entry for production, held on this machine only>
#   PP_OUT=<private directory outside any repository or synced folder>
#   PP_REPO=<checkout of r88510179-collab.github.io at the session branch, with 2c6e2a80 fetched>
#   bash pool-platform/commissioner-crm/validation/a1_run.sh
#
# Every file is checked against the SHA-256 pinned in A1_AUTHORIZATION.md, every connection is guarded (host,
# database and role must be production's), and every file runs inside BEGIN READ ONLY; ... ROLLBACK;. Outputs are
# the files' rows only; the connection details never leave the service entry.
set -euo pipefail
: "${PP_SERVICE:?psql service entry for production (held on this machine only)}"
: "${PP_OUT:?private output directory outside any repository}"
: "${PP_REPO:?path to the repository checkout}"
umask 077
mkdir -p "$PP_OUT/src" "$PP_OUT/out"
export PSQL_HISTORY=/dev/null

EXPECT_HOST='ep-still-recipe-b5g7680z.c-7.us-east-2.aws.neon.tech'
EXPECT_DB='neondb'
EXPECT_ROLE='neondb_owner'
AUTHC='2c6e2a805fa816638808cb2d96d430ee177453e6'
KIT="$PP_REPO/pool-platform/commissioner-crm/validation"

# File, pinned SHA-256, verdict row id (empty for an inventory).
FILES=(
  "P1_identity_helpers_004.sql 9ef14dea4ea0f0ff9270b06eb05339f7dfe114accf9c6264d7dd810a979666ae H99"
  "P2_private_schema_inventory.sql 234b81f89d328107ff86b0564c32e57f25f220c8ad8da053dc2cbf82731e39d1 -"
  "P3_crm_preconditions.sql f652ecad1d7adcc1f474d1b0af9753e7a8aec1e14567d03cb350c1312cd2333d X99"
  "neon-catalog-verify.sql 40b20416909c0ca2c26e2e682cb4ad2c5ef0b87fc257ca79d259dce55a0e9b43 C99"
  "neon-identity-audit.sql d512b94f8281fd201bcecb3efae3eb39fda2ab372b921d8f4a224bec012dca61 I99"
)

# 1. Stage the sources: the three kit files from the checkout, the two AUTH-C files from commit 2c6e2a80.
cp "$KIT/P1_identity_helpers_004.sql" "$KIT/P2_private_schema_inventory.sql" "$KIT/P3_crm_preconditions.sql" "$PP_OUT/src/"
git -C "$PP_REPO" show "$AUTHC:pool-platform/validation/neon-catalog-verify.sql" > "$PP_OUT/src/neon-catalog-verify.sql" \
  || { echo "A1 STOP: commit $AUTHC is not in this checkout (git fetch origin $AUTHC)" >&2; exit 2; }
git -C "$PP_REPO" show "$AUTHC:pool-platform/validation/neon-identity-audit.sql" > "$PP_OUT/src/neon-identity-audit.sql"

# 2. Refuse any file whose hash is not the authorized one.
for entry in "${FILES[@]}"; do
  read -r name sha _ <<<"$entry"
  echo "$sha  $PP_OUT/src/$name" | sha256sum --check --quiet --strict \
    || { echo "A1 STOP: $name does not match the authorized SHA-256" >&2; exit 2; }
done
echo "sources verified: ${#FILES[@]} files"

# 3. Run each file read-only behind the guard; keep the rows; stop on the first error or guard refusal.
run_one(){ # name
  local name=$1 out="$PP_OUT/out/${1%.sql}.txt"
  psql "service=$PP_SERVICE" -X -q -v ON_ERROR_STOP=1 -At -F ' | ' <<SQL > "$out" 2>&1 || { echo "A1 STOP: $name errored (see $out)" >&2; return 3; }
\set ECHO none
\set VERBOSITY terse
SELECT :'HOST' = '$EXPECT_HOST' AND current_database() = '$EXPECT_DB' AND current_user = '$EXPECT_ROLE' AS on_production \gset
\if :on_production
\else
\echo 'A1 STOP: not the production endpoint, database and owner'
\quit
\endif
BEGIN READ ONLY;
\i $PP_OUT/src/$name
ROLLBACK;
SQL
  if grep -q '^A1 STOP' "$out"; then cat "$out" >&2; return 3; fi
}

date -u +'A1 start %Y-%m-%dT%H:%M:%SZ' | tee "$PP_OUT/out/times.txt"
for entry in "${FILES[@]}"; do
  read -r name _ verdict <<<"$entry"
  run_one "$name"
  if [ "$verdict" != "-" ]; then
    grep -E "^$verdict \|" "$PP_OUT/out/${name%.sql}.txt" || echo "$name: no $verdict row (STOP)"
  else
    echo "$name: $(wc -l < "$PP_OUT/out/${name%.sql}.txt") inventory rows"
  fi
done
date -u +'A1 end %Y-%m-%dT%H:%M:%SZ' | tee -a "$PP_OUT/out/times.txt"

# 4. Fingerprint what was run and what came out. Review the out/ files for the redaction rule before sharing any of it.
( cd "$PP_OUT" && sha256sum src/* out/* "$(realpath --relative-to="$PP_OUT" "$0")" 2>/dev/null || sha256sum src/* out/* ) > "$PP_OUT/sha256sums.txt"
echo "outputs in $PP_OUT/out, fingerprints in $PP_OUT/sha256sums.txt"
