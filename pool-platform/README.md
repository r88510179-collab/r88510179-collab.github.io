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

The repository configuration remains `mode:'sandbox'`: the frontend has not been connected to the live backend in any browser, and the tracked `platform-config.js` holds no live URL. The frontend is prepared for that step: `scripts/build.mjs` writes an allow-listed build into the git-ignored `dist/`, generating its `platform-config.js` from `POOL_PLATFORM_*` variables (a sandbox unless `POOL_PLATFORM_MODE=live`, which fails closed without canonical `https:` Auth and Data API URLs) and bundling the pinned `@neondatabase/neon-js` 0.7.0-beta as a same-origin module, so nothing loads from a CDN at runtime. The pages carry no inline script or style (ready for `script-src 'self'` and `style-src 'self'`), and the service worker, registered with scope `./`, never caches the configuration. The next gate, a controlled browser run against Commercial Neon from `http://localhost:4173`, is `docs/FRONTEND_INTEGRATION_RUNBOOK.md`; the later hosting design is `docs/HOSTING_ARCHITECTURE.md`. Production CORS/allowed-origin configuration is deferred until the production hosting origin is selected.

## Build, serve and test

    cd pool-platform
    npm ci           # the pinned SDK and esbuild, exactly as package-lock.json
    npm test         # every committed suite; the opt-in ones skip without their variables
    npm run build    # the synthetic sandbox, into dist/ (git-ignored)
    npm run serve    # http://localhost:4173/

`node --test pool-platform/*.test.mjs` from the repository root needs no install; the checks of the real SDK bundle run once `npm ci` has been run here. The live build and the localhost browser procedure are in `docs/FRONTEND_INTEGRATION_RUNBOOK.md`.
