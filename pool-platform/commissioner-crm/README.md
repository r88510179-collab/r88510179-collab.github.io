# NFL Pool Center — Commissioner CRM React foundation

Isolated, **sandbox-only** React UI in the existing commercial repository. It is NOT deployed and is not connected to Neon. All sample pools and participants are fictional. This directory is intentionally NOT in the existing pool-platform allow-listed Netlify build.

## Scope decision
- Keep the participant app, Auth proxy, SDK pin, existing commercial build, and personal project unchanged.
- Adopt React incrementally for the growing commissioner dashboard, not via a site-wide rewrite.
- Tenant owner can choose co-commissioner access to all organization pools or selected pools, and grant individual capabilities. Staff management remains owner-only. The browser model is a preview only; server authorization and RLS migrations are required before release.
- Optional commissioner-only dues ledger: manual records of money collected externally. The application has no checkout, gateway, transfer, or payment collection.
- Ordinary commissioners never see technical JSON configuration.

## Run the isolated demo (not production)
From this directory use Node 22+, then \`npm install\` followed by \`npm run dev\`. The offline authoring environment could not contact the npm registry, so **a lockfile has not been generated**; do not publish until \`package-lock.json\` is generated, reviewed and committed, and a clean \`npm ci && npm run build:sandbox\` passes. \`npm test\` tests the pure capability model without installing packages.

The build explicitly requires \`CRM_SANDBOX_BUILD=1\`; it never reads or writes credentials or live tenant data.

## Integration gates (not yet implemented)
1. Wait for the separately running commercial AUTH-C acceptance to finish. Confirm the accepted commit, exact deployment and rollback target; rebase carefully without replacing auth, caching, CSP, service worker or deployment guards.
2. Review the React artifact in isolation on mobile and desktop. Resolve and pin the npm dependency tree, run tests and visual smoke.
3. Add additive database migrations for pool-specific staff grants, role-scoped checks and an optional append-only dues ledger in a new reviewed Neon branch. Preserve existing tenant-wide co-commissioner behavior until existing grants are explicitly migrated. Never equate client toggles with permission checks.
4. Integrate with Neon through the EXISTING session/Auth proxy and server-authorized operations. No standalone OAuth, no React-side secret, no direct privileged writes.
5. Add the static entrypoint to the existing explicit build allowlist only after build and CSP compatibility are verified. Netlify deploy gate remains unchanged until separately reviewed.
6. Re-run tenant isolation, source lock, invite, deadline, Survivor reuse, AUTH-C, and personal-site non-regression tests. Owner approves release separately.

## Database validation status (Oct 23, 2026)
- The additive source migration `migrations/001_crm_additive.sql` was **applied only to the disposable Neon validation branch** `crm-permissions-dues-validation-20261023` (`br-orange-forest-b5nyu8ov`).
- All three new tables have RLS enabled; authenticated table INSERT privileges are absent; functions are granted to `authenticated` only; a nonexistent pool receives no access.
- Production Neon branch `br-hidden-darkness-b55g0j83` has **zero** of the three CRM tables. This is intentionally nonproduction work; branch cleanup needs explicit owner approval.
- **Authorization migration is NOT complete:** older `co_commissioner` tenant-wide RPCs and RLS helpers remain active, so no pool-scoped grants are yet authoritative. Never connect the React permission switches to live accounts before their atomic replacement and authenticated negative tests.

## Build validation
- GitHub Actions sandbox job on commit `8d7223467dc51bb422271373da9563e8cd220e63` passed all five permission unit tests, temporary dependency resolution, `npm ci`, React/Vite production bundle build, and sandbox isolation check.
- The generated dependency lockfile was subsequently committed to the feature branch, and CI now requires `npm ci` against it.
- No Netlify deployment or production migration was performed in this branch.

## Phase 2 staging progress (Oct 23, 2026)
- `migrations/002_pool_scoped_authorization.sql` was executed atomically **only** on Neon validation branch `br-orange-forest-b5nyu8ov`: seven existing functions and six SELECT policies now use pool-scoped capabilities. Existing co-commissioner privileges were backfilled with six tenant-all capabilities (new dues permission is not granted implicitly).
- `migrations/003_crm_read_models.sql` added authenticated read-only `pool_platform_crm_pools()` and `pool_platform_crm_dues_summary(pool_id)` on that validation branch only; without a verified user both raise `auth_required` before table reads.
- `migrations/004_validate_crm_invariants.sql` **passed** on staging: three CRM tables have RLS, direct writes are blocked, old commissioner RPCs no longer contain tenant-wide checks, five relevant SELECT policies are pool scoped, legacy grants are preserved, and unauthorized pool access denies.
- `src/crm-data.mjs` provides a typed read model and an in-memory per-session cache. Switching A→B→A reuses A without another request. `src/platform-host.mjs` can reuse the existing same-origin `platform-client.js`, but is **not invoked by the sandbox bootstrap** and has not been connected to live auth.
- `App.jsx` can be injected with an authenticated gateway and renders real pool, entry and dues read models. By default, it renders **fictional demo data**; no write actions are activated in connected mode.
- New unit tests cover the pool adapter, cached navigation, fail-closed login, identity mismatches and dues permissions. CI must be checked at each commit; build green is not a hosted browser test.

### Remaining nonnegotiable gates
1. Read the independently accepted AUTH-C final production SHA, then reconcile the CRM branch against that accepted authentication/code baseline before any shared-site build changes.
2. Run **real authenticated** positive/negative tests with distinct commissioner and co-commissioner users in two tenants, including per-pool denial for RLS reads, commissioner context, invite creation, direct/manual and batch submissions; unauthorized requests must reveal no week/entry details.
3. Verify normal participant submissions, invite claim, source locking, deadlines, Survivor team-reuse prevention, audit integrity and service-worker cache separation.
4. Add secure staff-enrollment and RPC-write integration for permission assignment, dues toggles and manual ledger events; keep checkout/payment handling completely absent.
5. Review Vite build integration with the existing pinned Neon SDK, CSP, same-origin proxy and Netlify's explicit output allowlist; validate Samsung-size and desktop screen tests.
6. Seek separate owner approval before production migration, merge or deployment. The validation Neon branch should be deleted only with explicit owner approval.

## Phase 2 assistant management and dues ledger (Oct 23, 2026)
- `migrations/005_assistant_enrollment.sql` is installed on validation Neon branch `br-orange-forest-b5nyu8ov`: verified-account assistant enrollment, read-only assistant roster, audited role updates and permission revocation. Normal authenticated callers cannot execute the lower-level un-audited grant writer.
- `migrations/006_staging_role_simulation.sql` **PASSED** on the isolated branch: within one transaction/savepoint it temporarily narrowed an existing assistant from two pools to one, then denied second-pool access through commissioner context, invite and submission RPCs and authenticated-role RLS reads. The mock actor function and permission update were rolled back; this is NOT a real JWT acceptance test.
- `migrations/007_staging_dues_simulation.sql` **PASSED** on staging: manual charge/payment/refund/credit balance, server summary, append-only mutation refusal, assistant denial, foreign-tenant denial and direct-write privilege checks. Test entries were rolled back, leaving zero ledger records.
- After both tests, verified that `pool_platform_current_user_id()` still calls `auth.user_id()`, no test-actor override exists, the existing six legacy co-commissioner grants remain, and production has zero CRM tables.
- React `StaffManager.jsx` allows selection of an existing assistant or addition using an existing verified email, selected/all pools, presets and individual permissions; server RPCs enforce all writes. Assistant rosters cache by tenant and invalidate after changes.
- React `LiveDuesPanel.jsx` allows optional external bookkeeping: manually recorded amount owed, paid outside app, credit and refund; **no payments are accepted or moved by this app**.
- GitHub sandbox CI: **29/29 tests passed**, React/Vite bundle passed, npm lockfile installed via `npm ci`, no production config or participant file in output.

### Important next gates
- Actual signed-in JWT sessions (including multi-tenant, two-pool role enforcement and unverified/unknown assistant enrollment) have not been tested. Do NOT call the simulation a production auth sign-off.
- A co-commissioner role in the existing seed data lacks an authenticated verified Neon user; the read model retains that legacy staff record, but new email enrollment requires a genuinely verified account.
- The React entrypoint still runs as a disconnected sandbox until AUTH-C release reconciliation, CSP/Netlify integration, full regression, mobile viewport checks, and a separate production authorization.

## Phase 3 connected-candidate integration (October 23, 2026)

The separate `connected.html` / `src/ConnectedApp.jsx` entrypoint builds ONLY when explicitly invoked with `npm run build:connected-candidate`. It is deliberately **not included** in `pool-platform/scripts/build.mjs`, Netlify, the existing service-worker cache list, or the normal commercial distribution. The existing `index.html` remains a disconnected fictional-data sandbox.

- Signed-out state loads the existing same-origin `platform-config.js` and `platform-client.js` (not a new Auth service). It uses the exact original OTP send, verify, session and sign-out APIs.
- No valid account/session => sign-in form; no live config/module => an error screen; **never fallback to fictional pool records**.
- Authenticated state mounts the already-built React CRM with a stable gateway per existing PlatformClient instance. Sign-out unmounts the pool UI and discards its in-memory pool, assistant, and dues caches. Foreground/focus checks can discard stale sessions; accounts use separate React keys.
- Live-mode labels now reflect that some protected staff/dues writes are functional. Dues totals use the full-season ledger (including eliminated/inactive entries), not only active roster entries.
- Existing participant-invite RPC `createInvite` is available on the connected Players tab to commissioners with `manage_players`. URLs use `participant.html?pool=slug#invite=TOKEN` and never transmit tokens as query parameters; copy is explicitly user-initiated.
- The CI sandbox job builds **both outputs separately** and verifies candidate files are absent from the commercial publishing directory. The browser job enforces same-origin strict CSP, runs 360/412/1440px demo checks and a fake-account HTTPS interception rehearsal with no production JWT or API traffic.

**Not yet delivered or approved:** a connected deployment, AUTH-C reconciliation, real verified JWT positive/negative acceptance, production migration, production Netlify integration, or a real-device signoff. Merge/deploy requires explicit separate authorization.
