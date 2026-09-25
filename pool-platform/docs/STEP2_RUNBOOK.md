# Step 2 activation runbook

This runbook is intentionally blocked until the Step 2 candidate receives an independent read-only review.

## Status: dedicated commercial Neon project

- PostgreSQL 18.6, with the commercial schema: the catalog verification (step 10) verdict is C99 `PASS`.
- 002 was applied there before the authorization-order fix. Migration 003 (`003_submit_entry_authorization_order.sql`)
  is live: `pool_platform_submit_entry` has the corrected definition, whose body's SHA-256 fingerprint is
  `f52183734e1f8c42c401e2a507e8c82323c259486909adca49d9537eed523c8f`.
- The live security/behaviour validation (step 11, `validation/live/`) cleared: no commercial P0, P1 or P2 remains
  from that phase.
- The pgcrypto Data API surface check is recorded and decided (below): no ACL change is required at present.
- Two platform behaviours were measured in step 11 (below): about 30 s of JWT expiry skew, and a NULL identity on the
  first request of a newly opened Data API backend connection.
- Step 12 has not started: `platform-config.js` holds no live configuration. Production CORS/allowed-origin
  configuration is deferred until the production hosting origin is selected; localhost development works today.

## Before touching Neon

Run every commercial suite locally, never against Neon. The opt-in PostgreSQL suites use disposable local
clusters and must pass on PostgreSQL 16, 17 and 18 (17 adds the table MAINTAIN privilege; 18 adds none):

    POOL_PLATFORM_TEST_PG_CLUSTER=postgresql://postgres@127.0.0.1:5432/postgres \
      node --test pool-platform/migration-integration.test.mjs

    POOL_PLATFORM_TEST_PG=postgresql://postgres@127.0.0.1:5432/<throwaway database> \
      node --test pool-platform/migration-contract.test.mjs

The integration suite also runs the read-only live validation kit in `validation/` against clean and hostile
local privilege scenarios. The live harness has its own local tests, against a scripted Data API:

    cd pool-platform/validation/live && npm ci && npm test

## Dedicated Neon activation order

Do these steps in this order. STOP means: record the output, do not continue, and get the cause reviewed.

The earlier order, which applied migration 002 before Neon Auth and the Data API were provisioned, was wrong:
002 needs `neon_auth."user"`, `auth.user_id()` and the `anonymous`/`authenticated` roles at the moment it runs.

1. **Create a dedicated commercial/dev Neon environment.** Use a new Neon project for the commercial product,
   on PostgreSQL 16, 17 or 18 (the versions the local suites verify; the preflight stops on any other). Low-cost goal:
   - one commercial dev/production project while customer count is small
   - one synthetic demo tenant inside that project, or a separate demo branch later
   - scale-to-zero/serverless settings where available

2. **Confirm it is NOT the personal Pool Center project/database.** The personal Pool Center (`nfl-pool/`)
   talks to the Neon endpoint `ep-muddy-forest-au7eygkw` and the database `nfl_pool` (tables `nfl_pool_weeks`
   and `nfl_survivor_weeks`). The commercial connection string must name neither. Do not use the personal Pool
   Center database as the commercial backend, and do not seed any data from it. The preflight (P03, P04) and
   the catalog check (C26) repeat this guard from inside the database.

3. **Enable/provision Neon Auth** for the commercial environment.

4. **Enable/provision the Neon Data API** for the same database.

5. **Verify what migration 002 needs exists**, before anything is applied:
   - roles `anonymous` and `authenticated`
   - function `auth.user_id()` returning text
   - table `neon_auth."user"` with `id`, `email`, `"emailVerified"` and `banned`

   The reviewed migrations assume Neon Auth and the Data API provide exactly these. On the dedicated commercial
   project they did: 002 applied and the catalog verification passed (C99). If anything is missing or different,
   STOP; do not create stand-ins by hand. The preflight checks all of it (P06 to P12).

6. **Run `validation/neon-preflight.sql`** as the role that will run and own the migrations (use the same role
   for steps 6, 8, 9 and 10). It is one read-only SELECT over the catalogs:

       psql "$COMMERCIAL_DEV_URL" -X -v ON_ERROR_STOP=1 -f pool-platform/validation/neon-preflight.sql

   It identifies the server version and the database, guards against the personal Pool Center, verifies Neon
   Auth and `auth.user_id()` (including that the migration role can use them), and reports default privileges,
   separating those 002 resets from those it would leave in place.

7. **STOP unless the preflight verdict P99 is `PASS`.** A required row with `ok = false`, a P99 of `STOP: …`, or
   an error while running the file is a stop.

8. **Apply `001_foundation.sql`** as one transaction that stops at the first error:

       psql "$COMMERCIAL_DEV_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f pool-platform/migrations/001_foundation.sql

9. **Apply `002_identity_submission_rls.sql`** the same way, straight after 001:

       psql "$COMMERCIAL_DEV_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f pool-platform/migrations/002_identity_submission_rls.sql

   If either file fails, STOP. A failed file leaves nothing of itself behind, but 001 stays committed when only
   002 fails. Do not patch the database by hand: recreate the dedicated database and restart at step 6.

10. **Run `validation/neon-catalog-verify.sql`** (read-only, same role):

        psql "$COMMERCIAL_DEV_URL" -X -v ON_ERROR_STOP=1 -f pool-platform/validation/neon-catalog-verify.sql

    STOP unless the verdict C99 is `PASS`. It confirms the 9 tables with RLS, the 9 reviewed policies, the
    unique indexes, the source trigger (and no other trigger), the 14 functions with their SECURITY DEFINER
    and search_path settings, that anonymous has no table privileges, that authenticated has SELECT only (from
    PostgreSQL 17 on, no MAINTAIN), no column or sequence privileges, internal helpers callable by the owner only,
    and EXECUTE for authenticated on the RLS helpers and RPCs only.

11. **Authenticated RLS/race tests.** With test Neon Auth accounts and the synthetic pilot seed below, exercise
    the database contract through the live Data API: the Data API surface check, the identity tests, the
    source-lock race tests and the payload tests below. The local integration suite covers the same
    expectations; this step shows the live stack behaves the same way.

12. **Connect the dev frontend.** Set the client config in `platform-config.js`:
    - mode: live
    - authUrl: commercial Neon Auth URL
    - dataUrl: commercial Data API URL
    - defaultPoolSlug: the pilot pool slug

    These URLs are endpoint configuration, not database passwords. Keep all privileged database credentials
    out of browser code. Then repeat the identity tests through the participant and commissioner pages and run
    the commissioner import tests.

13. **Browser/device matrix.** Run the device matrix below.

## Synthetic pilot seed

Create a synthetic tenant and pool first.

Recommended first fixture:

- Tenant: Local Demo Group
- Pool: Neighborhood Pick'em
- Season: 2027
- Week: 1
- 10 synthetic entries
- 4 to 6 synthetic football games
- deadline at least 24 hours in the future

Create one commissioner membership tied to a test Neon Auth account.

## Data API surface check (pgcrypto)

A deferred live check: do not relocate pgcrypto or change 001 for it in this pass.

001 creates pgcrypto in `public`, so its functions keep PostgreSQL's default PUBLIC EXECUTE and `anonymous` and
`authenticated` can call them in SQL (catalog check C23 reports how many; C17 separately fails on any other
callable public function). What reaches the outside depends on what the Data API exposes, so in step 11:

- inspect which functions the Data API actually exposes to anonymous and to signed-in callers
- as an anonymous caller (no JWT) and as a signed-in caller, try to invoke a pgcrypto function such as
  `gen_random_bytes` through the Data API, and record the responses
- decide whether this is a meaningful data or security exposure, and record the decision

pgcrypto's functions are stateless utilities: they read no commercial table and bypass no RLS, so being callable
is not an authentication bypass by itself. What remains to weigh is surface area, for example compute-heavy calls
such as `crypt` with a high-cost `gen_salt`, when deciding whether a later pass moves pgcrypto out of `public`.

Recorded (step 11, dedicated commercial project): the catalog reports 37 pgcrypto functions callable by `anonymous`
and `authenticated` (C23), and probing the Data API found seven callable utility functions. Decision: no pgcrypto ACL
change is required at present. pgcrypto stays in `public` with its privileges unchanged, and 001 is unchanged.

## Platform behaviours measured in step 11

JWT expiry skew. The Data API accepted an expired JWT until about 29 s after its `exp` and rejected it from about 31
to 33 s after (HTTP 400): about 30 s of skew. The live harness asserts expiry only once a token is at least 35 s past
`exp`; an expired token accepted after that is still a P0.

NULL identity on a newly opened backend connection. The first request served by a newly opened Data API → Postgres
backend connection repeatedly ran with `auth.user_id()` = NULL (10 new backends, 10 NULL results), and an immediate
retry succeeded. No wrong identity was observed, all protected data stayed denied, and every identity-using commercial
RPC failed closed with `auth_required` before any read, lock, write or side effect. It is a reliability issue, not a
demonstrated authorization bypass. Only the correlation with newly opened backend connections is established; the
cause inside Neon is not known.

- The live harness classifies every identity result as CORRECT, NULL, WRONG or ERROR. It retries a NULL once and
  records a NULL that persists as a RELIABILITY failure, never a pass. A wrong identity is a P0
  (`validation/live/README.md`).
- The client (`PlatformClient.rpc()` in `platform-client.js`) resends a request that failed with exactly
  `auth_required` once, after about 200 ms, and never any other failure; a second `auth_required` shows the user a
  sign-in message instead of the raw code. The retry is safe only because every browser-callable RPC raises
  `auth_required` as its first statement, before it reads, locks or writes anything. `platform-client.test.mjs` checks
  the migrations for that order, and any new RPC must keep it.

## Identity tests

Test on separate accounts:

Commissioner:
- can load only managed tenant/pool
- can generate an invite
- cannot manage another tenant

Participant:
- can claim an invite once
- wrong email cannot claim an email-bound invite
- matching but unverified email cannot claim an email-bound invite (invite_email_unverified) until verified
- an invite without an email restriction remains a bearer link
- expired/used invite fails
- signed-in RPCs succeed: the client sends the JWT the pinned SDK stores in session.token
- can own multiple entries
- cannot read another participant's entry

## Source-lock race tests

Required:

A. Participant submits first.
Commissioner import must report source_conflict:participant.

B. Commissioner import submits first.
Participant direct submission must report source conflict.

C. Two simultaneous first submissions for the same entry/week.
Exactly one source claims the UNIQUE row.

D. Same participant source updates before deadline.
Revision increments.

E. Same commissioner_import source updates before deadline.
Revision increments.

F. Any ordinary submission at or after deadline.
Rejected.

G. Locked submission.
Rejected even from same source.

H. Inactive, eliminated or archived entry.
Rejected (entry_not_active) through participant and commissioner channels.

I. Caller who does not own the entry, or is not a commissioner of its tenant.
Receives only entry_not_owned / commissioner_required, whatever the payload, pick history, week or entry state.

## Payload tests

Pick'em:

- every configured game required
- only away/home accepted internally
- displayed city/team labels normalize during commissioner import
- unknown game rejected
- extra game rejected
- required tiebreak enforced
- blank tiebreak (form or CSV) is missing, never 0; a typed or imported 0 is kept
- malformed payload rejected server-side

Survivor:

- one configured team required
- displayed city/team label normalizes to stable team key on import
- unknown team rejected
- team already used by the entry in any other week, earlier or later, rejected server-side (team_already_used)
- simultaneous picks of one team for two weeks of one entry: exactly one succeeds
- ambiguous duplicate team in configured schedule rejected for that selection

## Device matrix

Participant pick entry must be manually checked at minimum on:

- 320 CSS px emulator
- 360 CSS px Android
- 384 CSS px Android
- 412 CSS px Android
- Samsung Galaxy S23/S24-class device
- iPhone Safari
- iPad/tablet
- desktop Chrome/Edge
- desktop Safari/Firefox when available

Verify:

- no page-level horizontal overflow
- 44px+ effective tap targets
- 16px+ form inputs
- no hover-only action
- keyboard navigation
- focus visibility
- submit/error/status announcements
- Pick'em and Survivor forms
- updating the commercial service worker leaves other caches on the origin (for example the Pool Center cache) intact

## Commissioner import

Test a batch containing:

- new commissioner entries
- participant-submitted conflict
- same-source commissioner update
- unknown entry code
- malformed pick
- city-label pick
- Survivor city label

The import must continue for safe rows and return a conflict/error report.

It must never overwrite a participant-owned row.

## Go-live gate

Do not use the live commercial backend with a real customer until:

- independent code review: SHIP
- preflight verdict PASS, then both migrations apply cleanly in dedicated dev
- catalog verification verdict PASS (RLS/privilege matrix verified, no MAINTAIN from PostgreSQL 17 on)
- pgcrypto Data API surface check recorded and decided (done: no ACL change required at present)
- race tests pass
- browser/device matrix passes
- synthetic demo works end-to-end

Only then seed the first real customer's tenant/pool.

## Deferred until after the Step 2 security gate

Known P2 items, intentionally not addressed in the Step 2 corrective passes:

- invite revocation/undo UI (revoked_at exists in the schema but has no commissioner workflow)
- importing the safe CSV rows when other rows fail client-side validation (the console currently blocks the whole import)
- general signed-in error UX
- hosting migration away from GitHub Pages (the commercial app currently shares an origin with the Pool Center)
- production CORS/allowed-origin configuration for Neon Auth and the Data API, until the production hosting origin is
  selected (localhost development works today)
- broader commercial UX polish
