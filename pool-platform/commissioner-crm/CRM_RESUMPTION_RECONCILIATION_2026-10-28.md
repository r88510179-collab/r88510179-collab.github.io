# Commissioner CRM resumption: read-only reconciliation (2026-10-28)

**Scope of this record.** Read-only. Nothing was executed against any database, nothing was merged, deployed,
reset, restored or deleted, and no credential, connection string, key, token or OTP was retrieved or recorded.
Draft PR #19 and its head `92ee3c17b206e65a3619914dcb655aee5adf1a3e` are unchanged; this file lives on a separate
session branch so the PR head the owner pinned stays exactly where it was. The one side effect of the inspection:
read-only Neon metadata calls (roles, Data API and Auth status) started the computes of both branches for a few
seconds (production at 16:03 UTC, the validation branch at 15:55 and 16:03 UTC). No SQL ran.

Evidence tags, as in the hardening plan: **[VERIFIED]** read from the repository or an API in this session;
**[RECORDED]** stated in a repository document, not re-verified; **[UNVERIFIED]** not shown by anything read here.

## 1. Branch and PR verification

| Item | State | Evidence |
| --- | --- | --- |
| CRM branch `feature/commissioner-crm-react-foundation` | `92ee3c17`, equal to PR #19 head | `git ls-remote`, PR API **[VERIFIED]** |
| PR #19 | open, draft, `mergeable_state: clean`, base `commercial-v1-netlify-adapter` at `48e0ac4e`, 94 commits, 41 files added, 4942 insertions, 0 deletions, no reviews, no review threads | PR API **[VERIFIED]** |
| Files outside `pool-platform/commissioner-crm/` | only `.github/workflows/commissioner-crm-sandbox.yml` (added) | `git diff --name-only` **[VERIFIED]** |
| Baseline files the CRM must not change (`migrations/`, `platform-client.js`, `scripts/`, `netlify.toml`, `service-worker.js`, `server/`, `netlify/`, `auth-core.js`, `commissioner.js`, `participant.js`) | byte-identical to `48e0ac4e` | `git diff --stat` empty **[VERIFIED]** |
| CI on the head | `sandbox` and `visual` jobs succeeded (runs 40043997207 and 40044002873) | Actions API **[VERIFIED]** |
| Netlify | deploy preview for the PR canceled; the CRM has never been published | commit status **[VERIFIED]** |
| Owner freeze comment of 2026-10-24 | still the last human comment on the PR | PR comments **[VERIFIED]** |
| Merge base with the production branch and with the AUTH-C candidate | `48e0ac4e` for both | `git merge-base` **[VERIFIED]** |
| Dry-run merge of the AUTH-C candidate `2c6e2a80` into the CRM head | clean, no conflicts | `git merge-tree` **[VERIFIED]** |

The production code branch `commercial-v1-netlify-adapter` still points at `48e0ac4e`. No commit on any
`commercial-v1*` or `claude/commercial-v1*` branch is dated after 2026-10-21; the only pushes after the freeze are
the personal Pool Center PRs #20 and #21 on `main` (2026-10-25). There are no tags and no releases.

## 2. "Step 9", "M2" and the accepted auth baseline

**Step 9** is the closing step of the controlled rollout window in
`docs/PRE_REGISTRATION_HARDENING.md` (AUTH-C candidate lineage, `commercial-v1-pre-registration-hardening`
through `2c6e2a80`). Completing it means, by that plan's own definition: N0 (`require_email_verification`) applied
and shown enforced on production; every production session revoked (step 5, T_rev); migration
`004_identity_pre_registration_hardening.sql` applied with C99 `PASS` and the three identity helpers at their
hardened fingerprints; D, E and A confirmed by Email OTP; N1 and N2 applied if P1 passed; Gate W passed; the
identity audit (I99 `PASS`) and catalog verifier (C99 `PASS`) re-run after Gate W; the production branch still at
`48e0ac4`; Auto Publishing still Locked **[RECORDED]**. The window needs no Netlify deploy: no file the build ships
differs from `48e0ac4`.

What this session could and could not confirm:

- Production's Neon Auth configuration (read-only, secrets redacted) now reads `require_email_verification: true`,
  `allow_sign_up: false` and no OAuth providers. That is the N0 + N1 + N2 state the plan describes after step 8
  **[VERIFIED]**.
- Whether 004 is applied on production (the three helper bodies hashing to 004's hardened column), and whether the
  step 9 audit and catalog runs happened, cannot be read from configuration. It needs one read-only SQL pass on
  production as the migration owner, which this session deliberately did not run **[UNVERIFIED]**.
- **"M2" is not defined in any document on any branch of this repository** (grep of every remote branch tip). It
  cannot be verified here; the owner's window record must say what M2 is and where its result is kept.
- No repository document records the completed window: `AUTH_C_RELEASE_GATE.md` still says "hold", the PR body
  still lists the AUTH-C reconciliation as outstanding, and no commit, tag or release names an accepted SHA.
- **Production's Data API exposes a schema `pool_platform_private` that the 2026-10-23 validation branch does not
  have and that no migration on any branch of this repository creates** (`CREATE SCHEMA` appears only for `auth`,
  `neon_auth` and the test-only `pp_it_ext`). Its provenance is unknown to the repository **[UNVERIFIED]**.

**Working definition of the accepted auth baseline for CRM reconciliation (to be confirmed by the owner):**
code `48e0ac4e` (unchanged production branch); database = `001` + `002` (as of `48e0ac4e`) + `003` + `004`
(the 004 blob is byte-identical from `38ea9ee3` to `2c6e2a80`, SHA-256
`332fba7f39d17c162a4f2793cb70a7f4f9431175e20d9bb30227fee3dd387d7a`), with the three identity helpers at the hardened
bodies and Neon Auth at N0 + N1 + N2. The AUTH-C candidate's frontend changes (Stage B defects D1 to D7, S1 to S3)
are **not** on production and are a separate review and deploy decision.

## 3. Credential-custody and AUTH-C release blockers (inspection)

| # | Finding | Evidence |
| --- | --- | --- |
| C1 | The Neon MCP connection available to this session is **unscoped, write mode, ADMIN** on all three projects of the organization (the commercial project and the two personal NFL Pool projects), with destructive tools and connection-string export exposed. The only gate is procedural ("ask first"). | MCP server notice, `list_projects` **[VERIFIED]** |
| C2 | The `production` branch (`br-hidden-darkness-b55g0j83`) is **not protected**. Neon documents that child branches of an unprotected branch inherit the parent's Postgres role passwords; so the validation branch holds the same `neondb_owner` and `authenticator` passwords as production. Protected branches are a paid-plan feature; the project's plan was not determined. | `list_branches`, Neon docs "Protected branches" **[VERIFIED]** |
| C3 | The existing CRM validation branch `br-orange-forest-b5nyu8ov` (created 2026-10-23 18:12 UTC from production) is a **pre-window copy of production**: Neon Auth there still has `require_email_verification: false`, `allow_sign_up: true` and the shared Google provider; its helpers are the pre-004 bodies; by the hardening plan it also holds copies of production's users, sessions and signing keys. The plan calls such a branch "a second host that may mint production-valid JWTs for production users" and lists "starting the window while the child branch exists" under unsafe orders. It existed throughout the 2026-10-25 window and still exists. | `get_neon_auth_config` (redacted), `PRE_REGISTRATION_HARDENING.md` "Child branch" **[VERIFIED/RECORDED]** |
| C4 | Neon operations since 2026-10-23 23:28 UTC are **only** `start_compute` / `suspend_compute`: no branch create, reset, restore or delete. The validation branch's compute was started at 2026-10-25 00:24:10 UTC, one second before production's, nine minutes into the window. Read-only metadata calls start computes (this session's did), so a compute start alone does not show a SQL connection. | `list_operations` **[VERIFIED]** |
| C5 | Neon project members: one (the owner, org admin, ADMIN). Two default platform credentials (AI gateway, object storage) exist from project creation; no customer-issued credential beyond those. | `list_project_members`, `list_credentials` **[VERIFIED]** |
| C6 | The live validation harness is hard-pinned to production's endpoint and signs up **password** identities; after 004 and N0 those identities cannot act (Stage B prerequisite 7). | `validation/live/harness/lib.mjs`, hardening plan **[VERIFIED/RECORDED]** |
| C7 | AUTH-C gates 1 to 8 (`AUTH_C_RELEASE_GATE.md`) are all still open in the repository: gate 1 (accepted SHA recorded) has no record; gate 3 (fresh post-AUTH-C branch) has not been done (no branch was created or deleted since 2026-10-23); gates 4 to 8 depend on them. | §1, §2, C4 **[VERIFIED]** |

## 4. Can Neon access be restored with approval-gated permissions? Yes, under this shape

1. **Read-only, project-scoped connection for all reconciliation work.** Neon documents the MCP URL parameters
   `?readonly=true` (SELECT and schema inspection only; branch creation, migrations and auth-config changes disabled)
   and `?projectId=fancy-brook-65396623` (no cross-project navigation), plus `?category=` to drop whole tool
   categories and `?roleName=<role>` to pin SQL to a least-privilege Postgres role (which also removes
   `get_connection_string`). With OAuth the read-only scope can be chosen at authorization. Neon's own guidance:
   never connect MCP agents to production databases. The current unscoped write connection should not be used for
   CRM work.
2. **Writes only through a separately authorized channel, per step.** Each mutating step below (branch creation,
   CRM migrations on the child, session revocation on the child, deletion of the old branch) runs under its own
   written authorization, by the owner or as the migration owner from the operator's machine (the window's own
   `psql 'service=…'` guard pattern), never through the standing MCP connection.
3. **Custody controls before the next child branch exists:** set `production` as protected if the plan allows it
   (child branches then get new passwords); otherwise reset the child's `neondb_owner` and `authenticator`
   passwords immediately after creation. Delete `br-orange-forest-b5nyu8ov` (owner approval; its SQL and results
   are already in git) and record a K4-style note (branch listing without it, its Auth URL no longer serving JWKS).
4. **The first use of restored access is read-only verification on production** (owner approval): helper
   fingerprints against 004's hardened column, `neon-catalog-verify.sql` (C99), `neon-identity-audit.sql` (I99,
   counts only), the schema fingerprint, and a catalog listing of `pool_platform_private`.

## 5. CRM migrations 001 to 008 against the accepted baseline

| File | What it assumes | Against `001+002+003+004` (post-window production) | Action |
| --- | --- | --- | --- |
| `001_crm_additive.sql` | `pool_platform_current_user_id()` exists; tables of 001/002; `authenticated` role | Compatible: additive only (3 tables, 5 functions, 3 policies, 1 trigger, 1 UNIQUE on pools). Pinned `search_path` differs in style from 002's (`pg_catalog` first) but is safe. | none |
| `002_pool_scoped_authorization.sql` | The seven RPCs as of `48e0ac4e`/`003` | The seven overlapping functions are **byte-identical between baseline 002/003 and AUTH-C 002** (AUTH-C changes only the three identity helpers, which CRM never redefines). CRM 002 changes exactly one predicate per function (`is_tenant_commissioner` → `staff_can` with the relevant capability) and keeps 003's authorization-first order in `submit_entry`. | none; re-apply as is after 004 |
| `003_crm_read_models.sql` | 001 + 002 | Compatible. | none |
| `004_validate_crm_invariants.sql` | 001 to 003 | Compatible; it never touches the identity helpers. | none |
| `005_assistant_enrollment.sql` | `neon_auth."user"` columns `emailVerified`, `banned` | **Gap F1:** `pool_platform_crm_add_assistant` admits a verified, unbanned user who holds a `neon_auth.account` row. Under 004 such a user is nobody (every RPC answers `auth_required`), so enrolling one creates exactly the "V1 standing held by users with an account row" the identity audit flags (I08). Add `AND NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)` to the lookup, a 004 invariant row for it, and a 008 row. | CRM code change before any application |
| `006_staging_role_simulation.sql`, `007_staging_dues_simulation.sql` | One transaction; a `co_commissioner` membership, two pools in its tenant, one foreign pool | Compatible: they `CREATE OR REPLACE` `pool_platform_current_user_id()` inside a savepoint and roll it back, which restores 004's hardened body. 004's guard refuses to run over an unreviewed helper body, so a simulation left un-rolled-back is caught, never silently overwritten. The synthetic fixtures still exist on a child of production. | run each as a single transaction |
| `008_post_auth_c_readonly_gate.sql` | 004's helper text | Its four AUTH-C rows match 004's hardened bodies (`auth.session()`/`sub`, `neon_auth.account` + `not exists`, `banned`, `emailverified` + `auth.session()`), so on a post-004 child with CRM 001/002/003/005 applied all 18 rows can pass. On the old branch 15 PASS / 3 FAIL is the expected pre-004 result **[RECORDED]**. | run after 001/002/003/005 |
| AUTH-C catalog verifier (`validation/neon-catalog-verify.sql`) | exactly 9 tables, 14 signatures, 10 grants, 9 policies, 1 trigger | **Gap F2:** fails by design after CRM (4 tables, 11 functions, 4 policies, 1 trigger and new grants added). A separate CRM catalog baseline (same shape, expected sets extended) is needed; the AUTH-C file must stay unchanged for AUTH-C acceptance. | new CRM validation file |
| Production schema `pool_platform_private` | not in any migration | **Gap F3:** unknown objects on production; cannot be reconciled until inspected or explained. | owner / read-only inspection |

## 6. Shortest path: real multi-role testing, Netlify integration, release acceptance

The order below follows `AUTH_C_RELEASE_GATE.md` gates 1 to 8 with the facts above. Each **[APPROVAL]** is a
separate written owner authorization.

1. **Pin the accepted baseline (gate 1 and 2).** Owner provides the window record (T_rev, Gate W pass time, step 9
   I99/C99, the 004 source commit, the M2 definition and result), or **[APPROVAL]** the read-only production
   verification in §4.4 runs and is recorded. Update `AUTH_C_RELEASE_GATE.md` from "hold" to the accepted identity.
   Explain or inspect `pool_platform_private`.
2. **Custody (§4.1 to §4.3).** Read-only scoped MCP for reconciliation; protected production branch or password
   rotation on children; **[APPROVAL]** delete `br-orange-forest-b5nyu8ov` with a K4-style record.
3. **New validation branch (gate 3). [APPROVAL]** Create `crm-post-auth-c-validation-<date>` from production
   under K1 to K4 discipline (record branch id, parent, endpoint host, Auth URL; never present a child token to
   production); on the child, immediately revoke the copied sessions (`DELETE FROM neon_auth.session`, the method
   P0-5 proved, child only) and reset role passwords if production is not protected; fixed lifetime; deletion after
   acceptance. Pre-check read-only: helper fingerprints = hardened, C99 `PASS`, 008 shows the 4 AUTH-C rows `PASS`.
4. **CRM migrations (gate 4).** Commit F1 (005 account-row predicate) and F2 (CRM catalog baseline) on the CRM
   branch first. **[APPROVAL]** On the child: 001 → 002 → 003 → 005 as the migration owner, then 004 invariants,
   006 and 007 (one transaction each), then 008: 18/18 `PASS`. Record counts and verdicts only.
5. **Real authenticated multi-role tests (gate 5).** Smallest code set that makes them possible, all reviewable
   in PR #19:
   - `src/platform-host.mjs`: accept exactly `http://localhost:<port>` beside `https://` (the commercial app's own
     localhost gate already runs there; `__Host-` cookie behaviour on `http://localhost` is recorded in
     `FRONTEND_INTEGRATION_RUNBOOK.md`); keep the origin-mismatch check.
   - `scripts/serve.mjs` serves the integrated build (step 6) so the CRM page loads from the same origin as
     `platform-config.js`, `platform-client.js` and the Auth proxy; the proxy upstream and Data API URL point at the
     child's endpoints (public values, server-only variables, never committed).
   - `validation/live/harness/lib.mjs`: endpoint pin taken from an explicit variable (default unchanged), and an
     Email-OTP identity mode for N identities (`human_send`/`human_verify` generalized), since password identities
     are refused after 004.
   - Identities: four Email-OTP accounts on the child (tenant A owner, tenant A pool-scoped assistant, tenant A
     participant, tenant B commissioner) on operator-controlled mailboxes; memberships created by owner SQL on the
     child; the synthetic `r1` fixtures (2 tenants, 3 pools) are already on the child.
   - Matrix: assistant scoped to one pool denied `commissioner_context`, invite, `submit_entry`, `submit_batch` and
     RLS reads on the other pool with `commissioner_required` before any week detail; foreign commissioner denied
     everything in tenant A; participant invite claim via fragment, submission, source lock, deadline, Survivor reuse
     unchanged; dues ledger append-only and `record_dues` scoped; A → sign out → B and other-tab account change;
     `auth_required` single retry; JWT expiry gate. Evidence per `validation/live/README.md` (no secrets).
   - Viewports 360/412/1440 on the authenticated host, then a real Samsung device and desktop (gate 7).
6. **Netlify packaging (gate 6).** The commercial build is an exact allow-list of 14 plain file names copied byte
   for byte, with `OUTPUT_FILES` enforced by `scripts/build.mjs`, `scripts/netlify-headers.mjs`,
   `frontend-readiness.test.mjs`, `netlify-hosting.test.mjs` and `ui-contract.test.mjs`, and the CRM's own
   `commercial-compat.test.mjs` locks every CRM name out. Minimal design: a fourth source class in `build.mjs`, the
   CRM bundle built from its locked tree (`npm ci` + `build:connected-candidate`) with fixed output names under
   `crm/` (Vite `entryFileNames`/`assetFileNames`, single chunk), the allow-list rule extended to that one
   subdirectory, `OUTPUT_FILES` extended, `netlify-headers.mjs` verifying the CRM files by rebuild or recorded hash,
   the service worker leaving `crm/` to the network (no cache bump), `netlify.toml` build command adding the CRM
   install and build, and the five tests updated deliberately. CSP needs no change: the CRM sources contain no inline
   script or style, no `url()`, `data:` or font; CI already runs the sandbox under `script-src 'self'; style-src
   'self'`. The Data API origin and the Auth proxy are unchanged, so no Neon trusted-origin or CORS change is needed
   for the same origin. Record reproducible per-file hashes and the CSP as `CUSTOMER_ACCESS_OPENING.md` §3 does.
7. **Release acceptance (gate 8). [APPROVAL ×3]** Production migration (CRM 001/002/003/005 plus the CRM catalog
   baseline, 008 on production 18/18), PR #19 merge (base `commercial-v1-netlify-adapter`; if the AUTH-C candidate
   code is merged there first, merge the base into the CRM branch with a merge commit, no rebase; the dry run is
   clean), and the deploy (Auto Publishing unlock → verified deploy → lock), with rollback identities recorded.
   Delete the validation branch afterwards (K4).

## 7. Exact remaining blockers

1. No repository record of the completed window or of the accepted AUTH-C identity; "M2" undefined in the
   repository; `AUTH_C_RELEASE_GATE.md` still on hold. (§2)
2. 004's application on production and the step 9 audit/catalog results are unverified from here; one approved
   read-only SQL pass settles it. (§2, §4.4)
3. `pool_platform_private` exists on production and in no migration. (§2, F3)
4. Credential custody: unscoped write-mode ADMIN Neon MCP; unprotected production branch sharing role passwords with
   children. (C1, C2)
5. The old validation branch is a live pre-window copy of production (config, helpers, sessions, keys) and must be
   deleted with owner approval before the next branch is made. (C3)
6. CRM 005 does not mirror 004's account-row rule (F1); no CRM catalog baseline exists (F2).
7. Real multi-role testing is not runnable as is: harness pinned to production and to password identities; CRM
   candidate refuses non-`https` origins; the local server cannot serve the CRM; no OTP identities exist. (C6, §6.5)
8. Netlify integration is unimplemented and currently locked out by design in five test files. (§6.6)
9. Sequencing decision: whether the AUTH-C candidate's frontend changes are merged to the production branch before
   or after the CRM (PR #19's base is the current production code either way).
10. Three separate owner authorizations (production migration, merge, deploy) remain required, unchanged.

## 8. Executable next steps, in order

1. Owner: supply the window record (or authorize §4.4) and the M2 definition; explain `pool_platform_private`.
2. Owner: reconnect Neon MCP as `?readonly=true&projectId=fancy-brook-65396623` for CRM work; decide on protected
   production; authorize deletion of `br-orange-forest-b5nyu8ov`.
3. CRM branch commits (no database effect): F1 in 005 with a 004-invariant row and a 008 row; F2 CRM catalog
   baseline; `AUTH_C_RELEASE_GATE.md` status update once step 1 is answered.
4. Owner-authorized: create the post-AUTH-C child under K1 to K4; revoke copied sessions on it; rotate passwords
   if needed; run the read-only pre-checks; apply 001/002/003/005; run 004, 006, 007, 008 (18/18).
5. CRM branch commits: localhost origin allowance, harness endpoint variable and OTP identity mode, build
   integration under `crm/`, test updates; CI green.
6. Owner-authorized: four OTP identities and memberships on the child; run the §6.5 matrix; viewports and devices.
7. Owner-authorized, separately: production migration, PR #19 merge, deploy, branch deletion.

## 9. What this session did not do

Did not run any SQL on any branch (not even the read-only 008 gate); did not create, reset, restore or delete a
Neon branch; did not read `neon_auth` tables, keys or JWKS; did not retrieve a connection string or credential; did
not merge, rebase, reset, push to or otherwise change PR #19 or `feature/commissioner-crm-react-foundation`; did
not deploy; did not change Netlify or Neon settings; did not touch the production branch, `main`, or any
Commercial V1 recovery branch.
