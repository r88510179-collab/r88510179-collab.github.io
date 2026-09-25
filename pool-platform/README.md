# Pool Platform — Commercial V1

This directory is the commercial product foundation. It is intentionally isolated from the existing personal Pool Center implementation.

## Product boundary

The commercial product may reuse generic sports-domain concepts only:

- weekly pick submission
- football schedule/result abstractions
- scoring/tiebreak concepts
- Survivor-style elimination concepts
- live standings/analytics patterns

It must not copy customer-specific or personal-project data, names, standings, branding, historical entries, private configuration, or source files.

All fixtures in this directory are synthetic.

## V1 target

A low-cost, local-first managed SaaS for fewer than 10 initial customers.

Supported launch formats:

- Weekly Pick'em
- Survivor

Initial operating model:

- owner-operated provisioning
- commissioner-managed pools
- responsive web/PWA participant entry
- commissioner import/manual entry as an alternate submission channel
- strict one-channel-per-entry-per-week source lock
- tenant/pool isolation
- synthetic demo environment
- seasonal/manual billing outside the app initially

## Submission-source rule

For each pool entry and week, the first final submission claims exactly one source:

- `participant`
- `commissioner_import`
- `commissioner_manual`

Once claimed, another source cannot overwrite that entry/week. Same-source edits may be allowed only while the week is open. Batch imports must report conflicts instead of replacing participant submissions.

This rule is enforced in the database, not only in the browser.

## Current status

Commercial V1 Step 2 candidate is implemented on a feature branch.

Implemented:

- participant OTP/invite flow
- multi-entry participant support
- Pick'em direct entry
- Survivor direct entry with burned-team protection, enforced atomically per entry by a partial unique index
- commissioner invite generation
- commissioner CSV import
- atomic participant-vs-commissioner source locking
- tenant/pool/entry authorization model
- RLS read policies
- no direct authenticated table writes
- hashed invitation tokens; email-bound invitations require a matching, verified Neon Auth email
- submission audit trail design
- responsive PWA participant and commissioner surfaces

The dedicated commercial Neon project (PostgreSQL 18.6) runs the commercial schema: migration 003, the `pool_platform_submit_entry` authorization-order corrective, is live there (function fingerprint `f52183734e1f8c42c401e2a507e8c82323c259486909adca49d9537eed523c8f`). Its catalog verification passed (C99), and the live security validation cleared with no commercial P0, P1 or P2 remaining from that phase; see `validation/README.md`. Locally the migrations are exercised against disposable PostgreSQL databases by the opt-in `migration-integration.test.mjs` (set `POOL_PLATFORM_TEST_PG_CLUSTER` to a local superuser URL).

Known platform behaviour, a reliability issue and not a demonstrated authorization bypass: the first request served by a newly opened Data API backend connection may run with `auth.user_id()` = NULL, and the RPCs then fail closed with `auth_required` before any side effect. Only that correlation is established, not the cause inside Neon. A wrong identity has not been observed and would be a P0. `PlatformClient.rpc()` resends a request that failed with exactly `auth_required` once, after about 200 ms, and shows a sign-in message if it fails that way again. That relies on every browser-callable RPC raising `auth_required` before it reads, locks or writes anything; `platform-client.test.mjs` checks the migrations for it, and a new RPC must keep that order.

The repository configuration remains `mode:'sandbox'`: the frontend is not connected to the live backend, and `platform-config.js` holds no live URL. Production CORS/allowed-origin configuration is deferred until the production hosting origin is selected.
