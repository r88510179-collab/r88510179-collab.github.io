# Personal Pool PDF import — isolated acceptance handoff

**Date:** 2026-11-05. **Status:** PENDING real signed-in browser publish/read-back. This is a test procedure, **not** a claim of PASS.

## Source and isolated targets

- GitHub repository: `r88510179-collab/r88510179-collab.github.io`
- Dedicated QA code branch: `qa/personal-pdf-import-e2e-20261105`
- Branch parent: PR #27 test-only commit `911e0a26aa44b977d6efb80b3e4221a6825990fd`; do **not** merge this QA branch into main.
- **Only authorized data-write target:** Neon project `green-base-66242978`, child branch `br-damp-credit-bbn7d0zr`, database `nfl_pool`. It is a non-default child of the existing **synthetic QA** parent branch `br-dawn-fire-bb923034`.
- Parent synthetic QA publications at clone time: 2026 Pick'em Week 9 locked revision 3, four tracked entries, 15 games; Survivor Week 2 locked revision 2 and Week 9 locked revision 1. These are fixtures/evidence, not production data.
- **Strictly forbidden:** live Personal project `flat-cake-85432375`, branch `br-icy-thunder-auknamhk`, and any app/auth/Data API host tied to production. Commercial V1, CRM, all production settings and live external submissions are out of scope.
- Existing PR #27 protected mobile acceptance evidence: https://github.com/r88510179-collab/r88510179-collab.github.io/pull/27#issuecomment-6666992174
- Merged PR #23 read-only score diagnostics: https://github.com/r88510179-collab/r88510179-collab.github.io/pull/23

## Critical publisher safety blocker to resolve first

The normal `nfl-pool/admin/admin.js` and `nfl-pool/admin/survivor-admin.js` contain hardcoded **production** Neon endpoints and production publisher email. **Never click Publish from these files** without a verified isolated rewrite that cannot reach production. A protected preview or QA read proxy does **not** make the normal admin write path safe.

Create a **QA-only** publisher/runtime configuration, reject unknown hosts and all production endpoints, use a distinct authorized synthetic QA publisher identity, and prove fail-closed behavior with automated security tests and visible runtime diagnostics. No user or production credentials, OTPs, or raw private data in commits, logs, screenshots or chat.

If authenticated QA publish cannot be completed with the available synthetic identity and authorized QA auth, stop and report BLOCKED rather than bypassing server authorization, using a real account, weakening RLS, inventing a PASS or writing directly into production.

## Acceptance evidence to produce

1. Preflight: verify exact project/branch/database via connected Neon, inspect required public tables and publisher RLS/authorization without mutations. Record a child-branch fingerprint of publication metadata/config hashes, and confirm the parent is not the target.
2. Prepare synthetic multi-page Pick'em and Survivor PDF fixtures for a **fresh synthetic week** suitable for the season schedule. Include four tracked entries and an anonymous full-pool row, duplicate name/blank/unanchored field cases and a revision case. Do not use real participant documents.
3. Browser: actual PDF file selection; parser preview; game/entry/team/tiebreak verification; schedule validation; negative malformed/duplicate/exception gates; publish only to the child QA branch through authenticated standard UI and normal application RPC/Data API, not through a direct ad-hoc SQL write.
4. Re-open in a new browser session; verify published revision, SHA-256 and exact expected counts/team selections through both UI and authorized DB read-back. Test revision/compare-and-swap once, read-after-write, duplicate retry behavior and rejection for wrong identity. No fabricated screenshots.
5. Survivor: publish a separate synthetic fixture, read-back same as above; confirm prior-team reuse, tie-policy handling, missing/absent-team schedule cases, participant eligibility and locking. Mark NOT IMPLEMENTED if an expected UI path is absent.
6. Smoke-test protected QA tracker at 375, 390, 430 CSS px only if the new published synthetic week is readable, measuring innerWidth and document scrollWidth. Do not needlessly rerun all previously accepted PR #27 states.
7. Compare parent synthetic QA metadata fingerprints before/after and confirm unchanged. Do not delete child branch or staging records without separate explicit approval. Record exact commit/deploy/branch IDs, source fixtures' hashes, redacted screenshots, observed calls, failures and PASS/BLOCKED status in the new QA draft PR and reference this handoff.
8. Keep all QA-only publisher/gateway/fixture code out of production, never disable SSO, never alter DNS, service-worker production assets, or the live score proxy. Never merge this QA branch into `main`.

## Final report

Give a short PASS/FAIL/BLOCKED matrix for: Picker/parser, NFL schedule gate, authenticated Pick'em publish, refresh/database readback, revision/duplicate guard, Survivor publish, rule/tie cases, QA mobile, parent/production isolation. Distinguish static/synthetic tests from actual browser/API calls. If blocked by test-account sign-in or available browser tooling, state exactly that; request the smallest authorized unblock without weakening access controls.
