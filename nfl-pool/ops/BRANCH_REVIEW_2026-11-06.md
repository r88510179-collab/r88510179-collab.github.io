# Branch inventory and unfinished-work triage — 6 November 2026

**Scope:** \`r88510179-collab/r88510179-collab.github.io\`, 28 GitHub branches visible during the audit; compare base was protected Personal \`main\` at \`ff7b58704cfd0c5faa94b12933fd08b3965f1457\`. This is an **inventory and disposition**, not an authorization to delete history.

**Important:** Because GitHub used squash merges, many successfully released branches still report as “diverged” from \`main\`; a branch being ahead is **not** by itself proof of unfinished product work. Conversely, this audit does not assert that a detached branch is fully obsolete without inspecting its files and intended deployment. The connected GitHub actions available here do not provide branch-ref deletion, so **no branch has been deleted**. The following classifications are actionable guidance for a future owner-controlled cleanup.

## Keep: protected or active products (3)

| Branch | Decision | Why |
| --- | --- | --- |
| \`main\` | **KEEP — protected** | Public portfolio + production Personal Pool GitHub Pages |
| \`commercial-v1-netlify-adapter\` | **KEEP — protected** | Separate Commercial V1 application; different branch, infrastructure and database |
| \`feature/commissioner-crm-react-foundation\` | **KEEP — unfinished** | [PR #19](https://github.com/r88510179-collab/r88510179-collab.github.io/pull/19) is open/draft. Authentication, integration and production authorization are separate outstanding CRM release gates; do not quietly merge or delete |

## Keep: isolated QA, deferred designs and evidence (7)

| Branch | Decision | Reason / former task |
| --- | --- | --- |
| \`feat/personal-tracked-vs-field-pulse-20261105\` | Archive, don't merge | PR #27's protected preview and QA-only read routing; production-safe presentation shipped separately in PR #28 |
| \`qa/personal-pdf-import-e2e-20261105\` | Archive, don't merge | PR #29's synthetic PDF, authenticated publisher and isolation evidence; deliberately contains QA-only targets/fixtures |
| \`test/personal-week9-isolated-qa-20261104\` | Archive, don't merge | Isolated Week 9 test routing and proof, not a production candidate |
| \`ux/personal-weekly-publisher-owner-flow-20261105\` | Deferred | PR #26 proposed a tidier Admin advanced-options layout; not necessary for the read-only public tracker and not mobile-accepted for production |
| \`chore/lean-claude-context-20261031\` | Deferred | PR #25 contained optional Claude instructions/agent configuration; no runtime benefit required for release |
| \`ccr-f0e40931-d5w326\` | Preserve evidence | Real browser 375/390/430 Week 10 label screenshots and logs for PR #30 |
| \`ccr-d916d579-tt6236\` | **Review before cleanup** | Unmerged Nov 4 production health report, raw screenshots and standalone \`ops/standings-reconcile.mjs\`; valuable historical independent recomputation, but report describes the older release and its script has not been adopted/tested against current main. Do not mistake it for a current test PASS |

## Released Personal branches — cleanup candidates after verifying references (6)

| Branch | Already completed elsewhere |
| --- | --- |
| \`fix/personal-2026-11-06-closeout\` | PR #31 and PR #32 merged into protected main; retain until rollback/evidence needs are settled |
| \`fix/personal-double-digit-week-selector-20261106\` | PR #30 merged, Week 10 mobile selector fixed |
| \`release/personal-group-vs-field-prod-safe-20261105\` | PR #28 merged, production field-pulse presentation |
| \`ops/e2e-acceptance-and-score-reconciliation\` | PR #23 merged, read-only parity/acceptance scripts |
| \`ops/manual-run-personal-pool-tests\` | PR #22 merged, manual regression test entrypoint |
| \`ops/cloud-monitor-mac-independent\` | PR #24 merged, public endpoint checks |

The commits and PR comments remain accessible even after a branch is deleted. Before deletion, verify the branch is not named by an active Vercel preview/deployment, QA runbook, scheduled workflow, unfinished PR, external worktree, or backup process. Preserve screenshots and evidence whose only copy is on an evidence branch.

## Older Personal development branches — do not merge wholesale (6)

| Branch | Assessment |
| --- | --- |
| \`hdc-08-service-worker-runtime-http-cache-coherence-v2\` | Old PWA cache testing candidate, now many releases behind. Compare its assertions with current v35+ before declaring obsolete |
| \`ccr-542521d5-r49esa\` | Similar older service-worker-only work; likely superseded by later PWA tests. Verify unique fixes before deletion |
| \`nfl-pool-pwa-premium-ui\` | Historical premium PWA work already represented by merged PR #4 and later revisions; old branch not a release candidate |
| \`nfl-pool-full-field-metrics-corrective\` | Legacy full-field metrics/parser variant, heavily behind; current app already supports field rankings. Compare any unique parser test before cleanup |
| \`pool-center-pickem-parser-hardening\` | Legacy parser-hardening branch. Modern Admin and 17-suite gate contain later parser tests; do not cherry-pick old whole branch |
| \`pool-center-tracked-label-polish\` | Legacy presentation-only polish, well behind the released Home/Picks UI; review before deletion if owner wants exact old wording |

There is **no newly discovered proof that these historical branches must be finished as product features**. They should not block Personal Pool maintenance. The only item with potentially useful unmerged operational functionality identified here is the old independent standings-reconciliation utility and audit evidence; keep it for a separate narrowly scoped review rather than merging an obsolete audit into today's app.

## Commercial/CRM working branches — retain and reconcile in that separate project (6)

These are **not** Personal Pool cleanup candidates:

- \`ccr-4e4f5363-96cult\`
- \`ccr-321cd6b3-fu8f1j\`
- \`claude/commercial-v1-neon-validation-rodqzy\`
- \`claude/commercial-v1-security-validation-exg0wb\`
- \`claude/pool-platform-auth-order-fix-3cl1p3\`
- \`claude/pool-platform-auth-order-fix-6zw1ft\`

Several of these contain different \`pool-platform/\` authentication/commissioner/CRM files and commit histories. Reconcile with current Commercial V1 Phase 9+ work in its own repository, protected deployment and database before pruning. No Commercial production feature is authorized or made complete by this branch review.

## Why unfinished work was not merged

1. **PR #19, CRM:** Still an active isolated WIP with staging-auth/role, browser/JWT and release integration gates. Requires the Commercial project process and explicit authorization.
2. **PR #26, publisher UX:** Optional cosmetic controls; owner runs a viewer, not the upstream contest. Separate signed-in mobile acceptance was never completed. Intentionally deferred.
3. **PR #25, Claude instructions:** Optional development convenience, not a shipped app feature. Intentionally deferred rather than mixing workflow configuration into a release.
4. **PRs #27 and #29:** Accomplished their QA purposes, but included test-only credentials, read shims, synthetic publications and child-only RLS. Correct disposition is to preserve evidence and **never merge the QA routing**.
5. **Old independent standings audit:** The audit was read-only and valuable; its unmerged helper would need a current compatibility/security review and independent tests before adoption. It is not necessary to fix a date label or keep scores working.

## Practical next cleanup (separate from code release)

1. Confirm outstanding Commercial V1/CRM worktree and deployment references. Keep those branches.
2. Save any irreplaceable QA evidence from \`ccr-\` and synthetic branches before removing Git refs.
3. Have an authorized repository owner delete only verified superseded merged feature branches using GitHub's branch UI, preferably after checking deployment previews/rollback references.
4. Keep protected \`main\`, protected Commercial base, open CRM PR #19, preserved QA/evidence branches and deferred design branches until their consumers explicitly sign off.
5. Do not force-push, delete Neon branches, revoke accounts, alter SSO, or remove backups as part of source branch cleanup. Those are independent decisions.

**Completed in this audit:** all open/closed PRs and all 28 visible branches were inventoried; closed QA PR reasons were reviewed; duplicate/old work was categorized; no source or production branches were deleted. A subsequent owner-controlled GitHub UI cleanup can reduce the list safely.
