# Commercial V1 live security/behaviour validation kit

Runbook step 11 (`docs/STEP2_RUNBOOK.md`): exercise the database contract through the **live** Neon Auth and Data
API with synthetic identities and the synthetic pilot fixtures. Nothing here is part of the app, and nothing here
changes a migration, a policy, a grant or `platform-config.js`.

## Safety rules the harness enforces

- **Commercial endpoint only.** `harness/lib.mjs` refuses any Auth/Data API host other than
  `ep-still-recipe-b5g7680z.*` (project `fancy-brook-65396623`). `PP_REHEARSAL=1` allows loopback only.
- **Synthetic data only.** Identities are `pp-cv1-<tag>-*@example.com` created through the public email/password
  sign-up. The one real mailbox (identity H, the operator) is used only for a real Email OTP sign-in.
- **No secrets in output or in the repository.** Passwords, cookies, JWTs, session tokens, invite tokens and OTP codes
  live only in `$PP_RUN_DIR/secrets.json` (mode 0600). `PP_RUN_DIR` is required and must be outside the repository.
  Evidence (`$PP_RUN_DIR/evidence.jsonl`) holds HTTP status, SQLSTATE, error codes, claim values, lengths and short
  SHA-256 fingerprints; every logged string is scrubbed of JWT-shaped and 64-hex values as a second line of defence.
- **Owner credentials never probe.** Owner-only steps (memberships, lock/expire/revoke fixtures, digests,
  consistency checks) are the SQL files in `owner/`, run separately as the migration owner (for example with the
  Neon MCP `run_sql`), never by the harness.
- **STOP conditions abort the run** (exit 3): cross-tenant or cross-participant reads, anonymous rows, a direct write,
  a source-lock overwrite, Survivor reuse, an unverified bound invite accepted, an authorization-order leak, or an
  internal helper executable through the Data API.

## Live run order

```
cd pool-platform/validation/live && npm ci
export PP_RUN_DIR=<private dir outside the repo> NODE_USE_ENV_PROXY=1 PP_H_EMAIL=<operator mailbox>
node harness/run.mjs probe signup sdk                     # 1. identities A-G, pinned SDK + PlatformClient path
#   owner: owner/O1_memberships.sql                          2. A commissioner + B co-commissioner (Tenant A), C (Tenant B)
node harness/run.mjs context auth invites hinvite tenantb sourcelock srcrace payload survivor status batch authorder surface isolation
#   owner: owner/D1_digest_all.sql (before)                  3. direct writes between two full-table digests
node harness/run.mjs directwrite
#   owner: owner/D1_digest_all.sql (after, must be identical)
#   owner: owner/O2_fixture_states.sql                       4. expire/revoke invites, lock two rows, week-5 deadline in 180 s
node harness/run.mjs expiredinv locked deadline authorder jwtexpiry signout
node harness/run.mjs human_send                            # 5. operator requests the OTP email
PP_H_OTP=<code from the operator> node harness/run.mjs human_verify isolation
#   owner: owner/O3_consistency.sql (O99 must be PASS), then validation/neon-catalog-verify.sql (C99 must be PASS)
```

`owner/O1_memberships.sql` and `owner/O3_consistency.sql` name the synthetic identities of run tag `r1` (the default
`PP_RUN_TAG`); edit the addresses there if a run uses another tag.

`owner/F1_fixtures.sql` creates the synthetic fixtures (2 tenants, 3 pools, season 2027, 27 weeks, 49 entries including
`E1`, `e1` and `E01`, and Survivor keys `NYG`/`NYJ` both labelled "New York"); `owner/F2_fixture_digest.sql` fingerprints
them so a live database can be compared with a local build.

## Local rehearsal (never evidence)

`rehearsal/rehearse.sh` runs every phase and owner step, in the same order, against a disposable local PostgreSQL with
the integration suite's stub `neon_auth`/`auth` schema and `rehearsal/mock-server.mjs` (a small Better Auth look-alike and
a PostgREST-style Data API in front of it). Grants, RLS, SECURITY DEFINER functions and row locks are real PostgreSQL;
only the HTTP layer is mocked. Use it to debug the harness, not to judge the live stack.
