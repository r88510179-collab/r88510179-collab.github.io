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
  a source-lock overwrite, Survivor reuse, an unverified bound invite accepted, an authorization-order leak, an
  internal helper executable through the Data API, an expired JWT accepted, or a wrong identity (another user's id
  for a caller's JWT).

## NULL identity: retried once, never a pass

Live, the first request served by a newly opened Data API → Postgres backend connection repeatedly ran with
`auth.user_id()` = NULL (10 new backends, 10 NULL results); an immediate retry succeeded. Only that correlation is
established, not the cause inside Neon. It fails closed: each reviewed RPC raises `auth_required` as its first
statement, before it reads, locks or writes, and RLS shows a NULL identity no row of any table. No wrong identity was
observed. `harness/lib.mjs` classifies every identity result as exactly one of:

- `CORRECT`: the expected user id. The check goes on as before.
- `NULL`: a null user id, or an RPC's `auth_required`. The same request runs once more, never a third time. NULL again
  is a RELIABILITY failure: recorded as `FAIL-RELIABILITY` and counted in both `fail` and `reliability`, never a pass
  and never a security finding.
- `WRONG`: another user's id. A P0 stop at once.
- `ERROR`: anything else (an HTTP or client error, an unexpected value). A failure, never a pass.

Evidence records the expected and returned user ids, the classification and a result summary, and the first
attempt when there was a retry. Where it applies:

- identity probes: K04 and H5 (through `PlatformClient.rpc()`), `A-*-uid`, `JX-*-fresh`, SO4 (informational: NULL is
  INFO there, WRONG still stops) and the identity `SF-auth-pool_platform_current_user_id` returns;
- `authorder`: an `auth_required` answer is never an authorization-order P1 or P2. It is retried once, and a probe still
  NULL makes its summary check (AO1, AO2, AO10, AO3 to AO9) a RELIABILITY failure. Any other unexpected answer, on the
  first request or on the retry, stops P1 or P2 as before;
- `isolation`: a read that must return rows for the identity (a commissioner's own tenant, memberships, pools, seasons,
  weeks and entries; a participant's owned entries with their tenants, pools, seasons and weeks; a commissioner's
  submissions next to visible audit rows) and returns none is read once more. A check that compares one read with
  another runs only when the read it compares with answered, so a read left empty cannot turn the other's rows into a
  false P0; the leak checks against the fixtures always run. The context RPCs retry `auth_required` once and record a
  NULL that persists as a RELIABILITY failure instead of INFO.

A read that is empty for the identity anyway (a participant's audit rows, or everything for F and G) cannot show
whether its identity resolved; those checks hold for a NULL identity too. `srcrace` and the other phases are
unchanged: a NULL identity there is an `auth_required` answer that fails its check, never a pass or a stop.

## JWT expiry gate

Live, the Data API accepted an expired JWT until about 29 s after its `exp` and rejected it from about 31 to 33 s
after, with HTTP 400. `jwtexpiry` asserts only once a first JWT is at least 35 s past `exp`: a token already past
`exp` waits for the gate (at most 35 s), and one not yet expired is left for a later run (`JX-gate`). The JWT's
`exp`, the probe start and the seconds past `exp` are captured before the probe and recorded. An expired JWT accepted
past the gate is a P0 stop, and the fresh-JWT follow-up (`JX-*-fresh`) runs as before.

## Harness self-test

`harness/harness.test.mjs` runs the classification, the NULL retry, the RELIABILITY failures, the JWT gate and the
authorder and isolation paths against a scripted Data API on 127.0.0.1 (no PostgreSQL, no Neon, no network):

    cd pool-platform/validation/live && npm ci && npm test

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

Each run ends with `TOTAL pass=… fail=… info=… reliability=…`. A phase passes only with no STOP and `fail=0`;
`reliability` counts the failures that were a NULL identity through its one retry, which only a new run clears.

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
