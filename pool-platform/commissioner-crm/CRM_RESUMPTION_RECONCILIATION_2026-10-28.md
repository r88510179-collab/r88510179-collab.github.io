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

---

# Part 2: continuation from the verified reconciliation (2026-10-28, later the same day)

Same rules as Part 1: read-only against Neon, Netlify and Drive; no SQL on any Neon branch; PR #19 and its head
untouched. New this part: CRM SQL and test changes on the session branch, rehearsed on a disposable local
PostgreSQL 16.15 with a stub of Neon Auth (never Neon), and the exact read-only verification the production
baseline needs, prepared but not executed.

## 10. Inputs the owner resolved

- **Completion report.** `~/Documents/Commercial-V1/recovery-20261026/COMMERCIAL-V1-COMPLETION-REPORT-20261028.md`,
  SHA-256 `8d2e1805abd9991ffa8e27ebe6e5ccb52350aae054840967ade90885415f14cb` **[owner-provided]**. The file is on the
  owner's computer; this cloud session has no home-directory copy and no Remote Control folder, and it is not in
  the owner's Drive. The Stage B readiness assessment written earlier today by another cloud session, kept in the
  owner's private Drive folder, records that SHA as verified and quotes the window record: migration 004 applied
  on 2026-10-26; N0, N1 and N2 applied about 15:15 UTC on 2026-10-28; Gate W passed 15:19:51 UTC; step 9 closed
  15:20:55 UTC; M2 CLEAN 15:21:19 UTC **[RECORDED there; not re-verified here]**. That folder is classified for the
  private workspace, so nothing more of it is reproduced in this public file.
- **M2** is the owner's post-step-9 read-only security audit: 0 new users, 0 new accounts, 0 unexpected
  sign-ins, D=1, E=2, A=1, four expected live sessions **[owner-provided]**. It is a session and account count,
  not the `neon-identity-audit.sql` I99 audit, which (per the same assessment) has not yet run live. A fresh I99
  is therefore still part of the production verification below.

## 11. A. Neon credential custody: exact steps, and what each layer enforces

What this session observed:

| Fact | Evidence |
| --- | --- |
| Neon's documented unauthenticated tool-list endpoint returns 127 tools for the plain MCP URL, 120 with `?projectId=fancy-brook-65396623`, and **49** with `?readonly=true&projectId=…`. The 49 keep `run_sql`, `inspect_database`, schema and listing tools; they drop `run_sql_transaction`, `get_connection_string`, and every create, delete, reset, restore, update, rotate and provision tool. Project scope also drops `list_projects`, `list_organizations`, `search` and `fetch`. | `curl https://mcp.neon.tech/api/list-tools?…` **[VERIFIED]** |
| In read-only mode `run_sql` runs each query inside a `READ ONLY` transaction; under OAuth, `readonly=true` on the URL cannot be widened on the consent page; `roleName=<role>` pins the Postgres login role for the whole connection, a limit Postgres itself enforces, and the server resolves that role's credentials internally and never returns them; `get_connection_string` is unavailable on a pinned connection. | Neon MCP server README and docs **[VERIFIED as documented]** |
| The organization is on Neon's **free** plan: protected branches (paid plans) and IP Allow (Scale) are not available. | `list_organizations` **[VERIFIED]** |
| Both branches hold the same four roles with identical `updated_at` (2026-09-24 22:24 UTC): no password reset has happened on the validation branch since it was created, so per Neon's documented default its `neondb_owner` and `authenticator` passwords are production's. | `list_postgres_roles` **[VERIFIED]**, Neon docs |
| Roles created in the Neon Console, CLI or API are members of `neon_superuser` and can read all data; a least-privilege role has to be created with SQL. | Neon docs "Manage roles" **[VERIFIED as documented]** |

The steps, in order (owner actions unless marked otherwise):

1. **Replace the connector.** In claude.ai, Settings → Connectors → Neon: disconnect, then add it again and, on
   Neon's consent page, choose the single project `pool-platform-commercial-dev` (`fancy-brook-65396623`) and the
   read-only scope (uncheck "Allow writes"); or use the parameterized URL
   `https://mcp.neon.tech/mcp?readonly=true&projectId=fancy-brook-65396623`. Under OAuth both are fixed at
   authorization and cannot be widened from inside a session.
2. **Pin a least-privilege Postgres role, on the new child branch only**, once that branch exists (§14, step A4).
   Created with SQL by the migration owner, never from the console:

       CREATE ROLE crm_reader LOGIN PASSWORD '<chosen by the owner, never recorded>'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       ALTER ROLE crm_reader SET default_transaction_read_only = on;
       GRANT USAGE ON SCHEMA public, neon_auth TO crm_reader;
       GRANT SELECT ON ALL TABLES IN SCHEMA public TO crm_reader;
       GRANT SELECT (id, email, "emailVerified", banned) ON neon_auth."user" TO crm_reader;
       GRANT SELECT ("userId", "providerId") ON neon_auth.account TO crm_reader;
       GRANT SELECT ("userId", "expiresAt", "impersonatedBy") ON neon_auth.session TO crm_reader;

   Nothing on `neon_auth.jwks`, `neon_auth.verification`, `session.token` or `account.password`. Then add
   `&roleName=crm_reader` to the URL (or the role field on the consent page). Neon's docs show exactly this
   SQL-created-role pattern; whether the hosted server can log in as a role Neon did not create is confirmed by the
   first probe below, and if it cannot, the fallback is `readonly=true&projectId=…` without a role: SQL then runs
   as the owner but still inside `READ ONLY` transactions.
3. **Prove it, on the child, before relying on it** (one approved probe set, nothing on production):
   the session's tool list holds at most the 49 read-only tools and no `get_connection_string`;
   `SELECT current_user, current_setting('transaction_read_only'), pg_has_role(current_user,'neon_superuser','MEMBER')`
   returns `crm_reader`, `on`, `false`; `CREATE TEMP TABLE crm_probe(x int)` fails with SQLSTATE `25006`
   (read-only transaction). Record the three results only.
4. **Keep production out of any AI session's reach.** Production reads (§12) run by the operator with psql under
   the window's own `service=` host guard, or in the Neon SQL Editor, never through the connector, which follows
   Neon's own MCP guidance ("never connect MCP agents to production databases").
5. **Inherited passwords.** With protected branches unavailable on the free plan, rotate the child's
   `neondb_owner` password right after the child is created (`reset_postgres_role_password` scoped to the child's
   branch id, by the owner); leave `authenticator` to Neon, which manages it for the Data API; never read or change
   a production password. The alternative is a plan upgrade so `production` can be set protected (children then
   get fresh passwords automatically, and production can no longer be deleted or reset); that is the owner's
   decision, not a precondition.
6. **The standing connection used on 2026-10-28** was unscoped, write-capable and ADMIN. Until step 1 is done, no
   CRM session should hold it; this session issued only metadata reads with it and no SQL.

## 12. B. Accepted production baseline, and the smallest read-only verification of it

**Baseline, as far as it is established:**

| Component | State | Evidence |
| --- | --- | --- |
| Production code | `48e0ac4e` on `commercial-v1-netlify-adapter`; the production Netlify site's current deploy is a **locked** production-context deploy of that commit, published 2026-10-28 01:15 UTC, with the two Auth proxy functions and their edge rate limits; the older commercial site holds the same commit from 2026-10-07 | Netlify API, read-only **[VERIFIED]** |
| Production database | `001` + `002` (as of `48e0ac4e`) + `003` live since Step 2; `004` applied 2026-10-26 **[owner record]**; hardened helper fingerprints **[not yet read]** | §2, §10 |
| Neon Auth | N0 `require_email_verification=true`, N1 `allow_sign_up=false`, N2 no OAuth provider, trusted origin the production app origin only, `allow_localhost=true` | `get_neon_auth_config` (redacted) **[VERIFIED]** |
| Data API | exposes `public` only; `pool_platform_private` is listed as available but **not** exposed | `get_data_api` **[VERIFIED]** |
| PR #19 base | `48e0ac4e`, the production code; the CRM branch needs no rebase or base merge today | §1 |

**The verification, prepared in `validation/` and not executed** (see `validation/README.md` for the run order,
roles, wrapper and output rule):

| File | Reads | Verdict | Expected on production |
| --- | --- | --- | --- |
| `P1_identity_helpers_004.sql` | catalogs only | `H99` | `PASS`: the three helpers hash to 004's hardened column (`001b7601…`, `b605c8f5…`, `7615a729…`), SECURITY DEFINER with the pinned search_path, `authenticated` may execute only `current_user_id()`, `auth.session()` returns jsonb, `neon_auth.account."userId"` readable by the owner |
| `P2_private_schema_inventory.sql` | catalogs and `pg_stat_all_tables` | inventory | every relation and function in `pool_platform_private` with owner, ACL, RLS flag, approximate row count, extension membership and a body fingerprint, plus an OID-order provenance hint; no row of any table is read |
| `P3_crm_preconditions.sql` | catalogs; `X05` counts memberships and the `neon_auth` user and account rows they point at | `X99` | `PASS`: no CRM table, function, constraint or index exists; the seven RPC bodies CRM 002 replaces hash to their baseline fingerprints (reproduced from `48e0ac4e` and 003 with the same method 004 uses; the method reproduces 004's own pre-hardening and hardened columns and the README's recorded 003 fingerprint `f5218373…`) |
| AUTH-C `neon-catalog-verify.sql` (from `2c6e2a80`, not the CRM branch's older copy) | catalogs | `C99` | `PASS` |
| AUTH-C `neon-identity-audit.sql` | `neon_auth` counts | `I99` | `PASS`; `I07` total at most the four window sessions |
| `migrations/008_post_auth_c_readonly_gate.sql` | catalogs | rows | the four `AUTH-C …` rows `PASS`; the other fifteen `FAIL` until the CRM exists there |

Authorization each run needs is stated in `validation/README.md`: branch and endpoint named, files by commit SHA,
the migration owner, `BEGIN READ ONLY; … ROLLBACK;`, verdicts, counts and fingerprints only, operator-run.

**Rehearsal evidence (local PostgreSQL 16.15, stub Neon Auth, never Neon):** baseline 001 + AUTH-C 002 + 003
applied; AUTH-C 004 accepted its own hardened bodies as a no-op; the AUTH-C verifier `C99 PASS`; `P1 H99 PASS`;
`P2` reports the schema absent; `P3 X99 PASS` before and after the synthetic `F1`/`O1` fixtures; CRM 001, 002,
003, 005 applied; 004 invariants pass; 006 and 007 pass as single transactions; 008 **19/19 PASS**; 009 `K99
PASS`; the AUTH-C verifier then reports exactly `FINDINGS: C02, C03, C08, C09, C10, C11, C12, C14` (the CRM
additions, as 009's header states); the identity audit `I99 PASS`; enrolling a verified user who holds an
account row is refused with `assistant_account_not_ready` while a clean verified user enrolls; 004's guard refuses
a mock identity helper left behind by a simulation ("not a reviewed definition: stop"); `L1` parses.

## 13. C. CRM changes on the session branch (PR #19's head untouched)

| Change | File | Why |
| --- | --- | --- |
| **F1** | `migrations/005_assistant_enrollment.sql` | `pool_platform_crm_add_assistant` now also requires no `neon_auth.account` row, mirroring 004; enrolling a contested identity is refused with the same generic error |
| F1 checks | `migrations/004_validate_crm_invariants.sql`, `migrations/008_post_auth_c_readonly_gate.sql` | 004 raises `crm_assistant_enrollment_admits_account_holders` once 005 exists without the predicate; 008 gains row 19, "Assistant enrollment refuses account-holding users" |
| **F2** | `migrations/009_crm_catalog_baseline.sql` | read-only catalog baseline of the CRM additions (K01 to K14, K99): tables, policies, privileges, ACLs, functions, grants, trigger, composite key and scope index, sequence, untouched helpers, rewritten RPC scope, legacy backfill, and K12, which recomputes what the unchanged AUTH-C verifier must then report |
| **F4** (found by the rehearsal) | `migrations/004_validate_crm_invariants.sql` | the grants check expected `authenticated` to execute the grant writer that 005 withdraws, so the gate's documented order (001, 002, 003, 005, then 004) failed; it now expects the audited wrappers after 005 and raises `crm_unaudited_grant_writer_exposed` if the writer is still callable |
| contracts | `src/migrations-contract.test.mjs` | text contracts CI runs with `npm test`: the reviewed file set, F1 present in 005/004/008, no forward migration redefines an identity helper, 006/007 savepoint discipline, 008/009 single read-only statements, 009 names every table, policy and function of 001/003/005 and states the verifier's expected findings, 002 rewrites exactly the seven RPCs |
| kit | `validation/` | P1, P2, P3, L1 and their README |

Suite: 41 of 41 pass (35 existing plus 6 contracts). No React, CSS, Vite, workflow, `platform-host.mjs` or baseline
file changed; the CI evidence on `92ee3c17` stands.

**Real signed-in testing and integration plan (not applied; each item is one reviewable commit on PR #19):**

1. `src/platform-host.mjs`: accept exactly `http://localhost:<port>` beside `https://` (the commercial app's own
   localhost gate; Chromium keeps the `__Host-` cookie there per `FRONTEND_INTEGRATION_RUNBOOK.md`), keeping the
   origin-mismatch check; `src/platform-host.test.mjs` gains the localhost case and keeps the `http://example.test`
   refusal.
2. `scripts/build.mjs` fourth source class: the CRM bundle built from its locked tree with fixed names under
   `crm/`, the allow-list rule extended to that one subdirectory, `OUTPUT_FILES` extended,
   `scripts/netlify-headers.mjs` verifying those files by rebuild, the service worker leaving `crm/` to the
   network, `netlify.toml` adding the CRM install and build, and `frontend-readiness`, `netlify-hosting`,
   `ui-contract` and the CRM `commercial-compat` tests updated deliberately. CSP unchanged (no inline script or
   style, no `url()`, `data:` or font in the CRM sources; CI already runs it under `script-src 'self'; style-src
   'self'`).
3. `validation/live/harness/lib.mjs`: endpoint pin from an explicit variable (default unchanged) and an Email-OTP
   identity mode for N identities, since password identities are inert after 004 and N0.
4. Identities and fixtures on the new child: the Stage B draft's synthetic Email-OTP identities (participant,
   commissioner) plus two the CRM needs (a tenant A pool-scoped assistant, a tenant B commissioner), on
   operator-controlled mailboxes; memberships by owner SQL on the child; the synthetic `F1` fixtures come with the
   child by copy. One authorization can cover both workstreams' identities.
5. The matrix of Part 1 §6.5, through `scripts/serve.mjs --dir dist` at `http://localhost:4173` against the
   child's Auth and Data API endpoints (public values, server-only variables), evidence per
   `validation/live/README.md`; then 360/412/1440 and real devices.

## 14. D. Decision report

**1. Verified now.** PR #19 head and branch unchanged; production code `48e0ac4e` locked and served; Neon Auth at
N0/N1/N2; Data API exposes `public` only; no Neon branch create, reset, restore or delete since 2026-10-23;
read-only MCP mode and project scope enforced server-side (tool list) and SQL confined to `READ ONLY`
transactions, with `roleName` as a Postgres-enforced limit; free plan (no protected branches); the CRM SQL
(001, 002, 003, 005 with F1, 004 with F4, 006, 007, 008 at 19 rows, 009) and the four verification files all
execute as expected on PostgreSQL 16 over the AUTH-C baseline; the completion report's facts as the owner and the
Stage B readiness assessment state them (SHA verified there, not here).

**2. Security issues that need owner action.**
- Replace the standing Neon connector with the read-only, project-scoped one (§11 steps 1 to 3).
- Decide inherited credentials: child password rotation after creation, or a plan upgrade for a protected
  production branch (§11 step 5).
- Retire the legacy validation branch (below): it is a pre-window copy of production (pre-004 helpers, Auth
  config with sign-up open and Google present, copied sessions and signing key), which the hardening plan treats
  as a second host able to mint production-valid tokens, and it is also the Stage B assessment's blocker 2.
- Explain or inspect `pool_platform_private` (P2) before any CRM migration order is finalized.
- Run the fresh I99 identity audit on production as part of the baseline verification.
- Authorize nothing on production for the CRM beyond the read-only kit until all of the above are recorded.

**3. Can the legacy validation branch be retired safely? Yes.** Nothing the CRM needs lives only there: the
migrations are in git, their results are in the README and PR #19, the AUTH-C gate already rules the branch
inadequate for acceptance, and a fresh post-AUTH-C child is required regardless. Preserve first, read-only and
without touching its `neon_auth` schema: the `L1` inventory and the 008 output (expected 15 PASS / 4 FAIL on that
branch), the K1-style identity record (branch id, parent id, parent LSN and timestamp, endpoint host, Auth base
URL), and the Neon operation timestamps around 2026-10-24 and 2026-10-25 already captured in Part 1. Then delete
with an explicit approval and record K4 (branch listing without it; its Auth base URL no longer serving
`/.well-known/jwks.json`). Deleting it is a Neon write and stays owner-authorized.

**4. Smallest separately approvable actions toward real signed-in CRM testing, in order.**

| # | Action | Writes? | Who |
| --- | --- | --- | --- |
| A1 | Run the read-only production verification (§12) and record the verdicts, including a fresh I99 | none | operator, psql or SQL Editor, under written authorization |
| A2 | Replace the Neon connector with read-only + project scope (§11 steps 1 and 3; the role in step 2 waits for A4) | none | owner |
| A3 | Capture `L1` and 008 on the legacy branch, then delete it and record K4 | delete one branch | owner-authorized |
| A4 | Create the post-AUTH-C child under K1 to K4; on the child only: revoke the copied sessions (`DELETE FROM neon_auth.session`, the P0-5 method), rotate `neondb_owner`, create `crm_reader`; record K1 and K2 | child only | owner-authorized |
| A5 | On the child: 001 → 002 → 003 → 005, then 004, 006, 007, 008 (19/19), 009 (`K99 PASS`), the AUTH-C verifier (its eight expected findings and nothing else), the identity audit | child only | owner-authorized, migration owner |
| A6 | Commit the three code items of §13 on PR #19; create the OTP identities and memberships on the child; run the signed-in matrix from the localhost gate; devices | child only; CRM branch commits | owner-authorized identities; CI-reviewed code |

Netlify packaging, the production migration, the PR #19 merge and the deploy remain after A6, each with its own
approval, as Part 1 §6 lists. None of A1 to A6 touches production except A1's read-only reads.

## 15. What this part did not do

No SQL on any Neon branch; no Neon branch created, reset, restored or deleted; no Neon or Netlify setting changed;
no credential, connection string, key or token retrieved or recorded; no production write; no change to PR #19,
its branch, the production branch or `main`; no merge or deploy; nothing from the owner's private Drive folder
reproduced beyond the facts the owner stated in this session. The disposable local PostgreSQL cluster used for the
rehearsal was stopped and deleted afterwards.

---

# Part 3: A1 and A2 execution readiness, legacy branch retirement, the new child (2026-10-28, evening)

Same rules. New facts read this part, all Neon metadata: the production endpoint is `ep-still-recipe-b5g7680z`
with direct host `ep-still-recipe-b5g7680z.c-7.us-east-2.aws.neon.tech`; database `neondb` is owned by
`neondb_owner` on both branches; the legacy branch has no Neon Functions, triggers, storage buckets, child
branches or snapshots that depend on it; a **manual snapshot of production** named
`commercial-v1-owner-recovery-2026-10-28` was taken at 16:28 UTC today (it holds a copy of production's sessions
and keys, so restoring it would fall under the hardening plan's "Restores and new branches" rule; nothing here
uses it); both endpoints allow Neon's passwordless console access and the organization does not require MFA, so
the Neon account itself is the root of every access path described below. P2 was extended with dependency rows in
both directions and parse-checked on a stub schema; its hash in `A1_AUTHORIZATION.md` is the final one.

## 16. A1: the exact read-only run, ready for signature

`validation/A1_AUTHORIZATION.md` is the approval text: target (project, branch, database, owner, endpoint host,
server), path (operator psql, service entry held only on that machine, history off, private output directory),
the five files with their SHA-256 and the order they run in, what is read and never read, the PASS and STOP
conditions per file, the output and redaction rule, and the signature and separate run-approval blocks.
`validation/a1_run.sh` executes exactly that: it refuses any file whose SHA-256 differs, guards every connection
(`:HOST`, `current_database()`, `current_user` must be production's), wraps each file in `BEGIN READ ONLY; …
ROLLBACK;` with `ON_ERROR_STOP`, keeps the rows in the private directory and fingerprints sources and outputs.
Expected: `H99 PASS`, `X99 PASS`, `C99 PASS`, `I99 PASS`, and a P2 inventory the owner can explain line by line.

For `pool_platform_private`, P2 now lists: the schema (owner, ACL, comment, USAGE and CREATE for the Data API
roles); each relation (kind, owner, RLS, ACL, approximate row count, extension membership); each function (language,
SECURITY DEFINER, config, ACL, body SHA-256, extension membership); foreign keys leaving or entering the schema;
views that read relations outside it; triggers outside it that call its functions; reviewed public functions or
policies that name it; and the OID-order provenance hint. No row content and no function text is returned.

## 17. A2: the scoped Neon connection, and how it is verified after the fact

**Reconnect (owner, in claude.ai):** Settings → Connectors → Neon → remove the connector. Add it again as a custom
connector with the URL

    https://mcp.neon.tech/mcp?readonly=true&projectId=fancy-brook-65396623

and authorize it; on Neon's consent page the grant shows read-only and the single project with no editor to widen
them (the official connector's page offers the same choices, read-only scope and one project, but the parameterized
URL is the one whose grant cannot be widened later). Leave the Postgres role empty until `crm_reader` exists on the
new child (§19); then reconnect once more with `&roleName=crm_reader`. A cloud session picks the new connection up
when it starts, so the next CRM session runs the verification below before anything else.

**Verification protocol (the public tool list is not proof; these are):**

| # | Probe | Where | Pass |
| --- | --- | --- | --- |
| V1 | Enumerate the Neon tools the session actually holds | session | at most the 49 read-only tools; none of `get_connection_string`, `run_sql_transaction`, `create_branch`, `delete_branch`, `reset_from_parent`, `reset_postgres_role_password`, `create_credential`, `update_auth_config`, `provision_neon_auth`, `list_projects`, `list_organizations`, `search`, `fetch` |
| V2 | `describe_project` for one of the personal projects, and `list_branches` without a project id | session | refused or scoped to `fancy-brook-65396623` only |
| V3 | `run_sql`: `SELECT current_user, current_setting('transaction_read_only'), pg_has_role(current_user,'neon_superuser','MEMBER')` | legacy branch only, never production | `transaction_read_only = on`; the role is reported (the owner, and a `neon_superuser` member, until `roleName` pins `crm_reader`) |
| V4 | `run_sql`: `CREATE TEMP TABLE crm_probe(x int)` (a write that must be refused; nothing persists either way) | legacy branch only; needs the owner's explicit OK for this one probe | SQLSTATE `25006` "cannot execute CREATE TABLE in a read-only transaction"; success is a STOP: the mode is not read-only |
| V5 | `run_sql`: `SELECT has_table_privilege(current_user,'neon_auth.jwks','SELECT'), has_table_privilege(current_user,'neon_auth.session','SELECT')` (catalog function, reads no row) | legacy branch only | records the residual reach of the SQL role: true for the owner, which is why §19 pins `crm_reader` on the child; false once pinned |

Until V1 to V5 are recorded, the connector is not relied on for anything. The standing unscoped connection is not
used for SQL at all; this session used it for metadata only.

**Root of trust.** Neon's passwordless connect (enabled on both endpoints) and the console both authenticate
through the Neon account, which has no MFA requirement set at the organization. Requiring MFA on that account is
the owner's call and the one control above every connector setting.

## 18. Legacy branch `br-orange-forest-b5nyu8ov`: evidence, risks, blockers, retirement plan

**Dependencies checked (read-only):** no child branch; no snapshot of it (the only snapshot is of production);
no Neon Function, trigger or storage bucket on it; its compute `ep-bold-unit-b5gq0wuk` idle; the two Netlify
commercial deploys predate it or point at production (the production site serves the production Data API, the
older site's deploy is from 2026-10-07); the CRM CI intercepts all network traffic and names no Neon host. Nothing
in the repository or the hosting records depends on it.

**Inherited credentials and authorization state:** its `neondb_owner` and `authenticator` passwords are
production's (no reset since creation); its Neon Auth endpoint is live with sign-up open, Google present and no
email verification requirement; its helpers are pre-004; it holds the users, the pre-revocation session rows and
the signing key copied on 2026-10-23. Deleting the branch removes its databases, roles, compute and Auth endpoint
(Neon's documented effect). Deletion does not change production's passwords: anyone who extracted the branch's
owner password before deletion still holds production's. Whether to rotate production's owner password afterwards
is a separate owner decision and a production change; it is not required by the CRM.

**Blockers before retirement:** none technical. Three records and one approval: (1) the L1 inventory and the 008
rows captured on the branch (read-only, operator path, the same guard with the branch's host
`ep-bold-unit-b5gq0wuk.c-7.us-east-2.aws.neon.tech`, never touching `neon_auth`; expected 15 PASS / 4 FAIL on 008),
(2) the K1-style identity record (branch id, parent `br-hidden-darkness-b55g0j83`, parent LSN `0/2E95158` at
2026-10-23 18:12:37 UTC, endpoint host, Auth base URL), (3) agreement with the Stage B workstream that this one
deletion closes its blocker 2 as well, and (4) the owner's written deletion approval naming the branch id.

**Deletion plan (owner, console or a write-capable path of the owner's, never a read-only connector):**
1. Confirm the branch listing still shows exactly `production` and `br-orange-forest-b5nyu8ov`, and that nobody is
   signed in through the branch's Auth endpoint (no one should be).
2. Delete `br-orange-forest-b5nyu8ov`.
3. Record K4: the deletion time, `list_branches` showing only `production`, the Neon operation (`delete_timeline`)
   for the branch, and the branch's Auth base URL no longer serving `/.well-known/jwks.json`.
4. Update `AUTH_C_RELEASE_GATE.md` and the CRM README to say the branch is gone.

## 19. The new post-AUTH-C child: K1 to K4 plan (no creation yet)

Preconditions: A1 recorded `PASS`; A2 verified; the legacy branch deleted (one production-derived child at a time);
the owner's written creation approval. The child is the hardening plan's "production-derived branch", so this plan
is the security assessment that rule requires: it names every piece of state the branch copies and what is done
about each.

| Copied state | Risk | Handling on the child, in order |
| --- | --- | --- |
| Signing keys (`neon_auth.jwks`, private halves) | the child's Auth host can mint tokens production's Data API may accept (K2: expect the same public key as production) | never present a child token, cookie or session to any production endpoint; K3 provenance from a child-only identity's first JWT (`iss`, `aud`, `kid` fingerprint, `exp - iat` only); the child lives only for the acceptance run; K4 deletion afterwards |
| Session rows (whatever is live on production at creation: the operator's D, E, A and any since) | a second host holding production sessions | first action after creation, child only: `DELETE FROM neon_auth.session` as the owner under a host guard that asserts the child's endpoint host (the P0-5 method); record the count |
| Role passwords (`neondb_owner`, `authenticator`) | production's passwords on a second host | reset the child's `neondb_owner` password (console or API, scoped to the child's branch id); `authenticator` stays Neon-managed; production never touched |
| Users (verified operator identities, inert synthetic password identities) | the child's Auth can sign them in by Email OTP | operator-held mailboxes only; no customer exists |
| Neon Auth configuration (N0 true, N1 sign-up closed, N2 no OAuth, trusted origin production's, `allow_localhost` true) | sign-up closed means the four CRM test identities cannot be created | on the child only: set `allow_sign_up=true`, create the four identities by Email OTP (no password, so no account row), set `allow_sign_up=false` again; record both reads; N0 stays true throughout; the child's identity audit must then show the four new users verified with no account row |
| Identity helpers at 004's hardened bodies, catalog at the AUTH-C baseline | none; this is the point of the branch | P1 and the AUTH-C verifier on the child before any CRM file: `H99 PASS`, `C99 PASS` |
| Data (synthetic `F1` fixtures, memberships of password identities) | none; synthetic by construction | the CRM's 006 and 007 use them; new memberships for the OTP identities by owner SQL |

Records: K1 (child branch id and name, parent id, parent LSN and timestamp, endpoint host, Auth base URL, each
different from production's where it must be); K2 (public JWKS of child and production: `kty`, `crv`, `alg`,
`kid` fingerprint, RFC 7638 thumbprint; no private field); K3 at the first CRM sign-in; K4 at deletion. Also the
child's Neon Auth schema fingerprint (`del(.servers) | sha256` of the public `open-api/generate-schema`), so the
CRM tests are tied to the Neon Auth version they ran on, as the Stage B assessment asks for production.

Then, on the child: `crm_reader` (§11 step 2), the A2 reconnect with `roleName`, CRM 001 → 002 → 003 → 005, 004,
006, 007, 008 (19/19), 009 (`K99 PASS`), the AUTH-C verifier (its eight expected findings only), the identity
audit; then the OTP identities, memberships and the signed-in matrix through the localhost gate.

## 20. The shortest sequence to real authenticated CRM testing

| Step | Needs | Writes | Output |
| --- | --- | --- | --- |
| A1 | owner signature on `A1_AUTHORIZATION.md` + "run now" | none | `H99`, `X99`, `C99`, `I99` PASS; P2 explained |
| A2 | owner reconnects the connector; OK for probe V4 | none (V4 must fail) | V1 to V5 recorded |
| A3 | owner approval naming `br-orange-forest-b5nyu8ov` | one branch deleted | L1 and 008 captured; K4 recorded |
| A4 | owner creation approval | child only: session delete, owner password reset, `crm_reader`, `allow_sign_up` toggled | K1, K2 recorded; `H99`, `C99` PASS on the child |
| A5 | migration-owner run on the child | child only | 004 ok, 006 ok, 007 ok, 008 19/19, 009 PASS, verifier eight findings, I99 PASS |
| A6 | the three PR #19 code items (localhost origin, build integration under `crm/`, harness endpoint variable and OTP identities); four OTP identities and memberships on the child | child only; CRM branch commits | the Part 1 §6.5 matrix, K3, viewports, devices |

Everything after A6 (Netlify packaging on production, the production migration, the PR #19 merge, the deploy)
keeps its own approval. No step above writes to production.

## 21. What this part did not do

No SQL on any Neon branch; no connector change (the owner makes it); no branch created or deleted; no credential,
password or key read, exported, rotated or changed; no production change; PR #19 and its branch unchanged. The
disposable local cluster used for the P2 parse check was deleted again afterwards.

---

# Part 4: A1 signing readiness, snapshot custody, A2 scope proof (2026-10-29)

Same rules; nothing ran on Neon. This part finalizes the A1 signing procedure, folds the production snapshot into
the credential-custody inventory, and pins the Neon tool-scope facts that A2 will be checked against.

## 22. A1 package verified against the committed tree

Every file A1 names was re-hashed from the git objects at `2882c7d` and equals the value pinned inside
`A1_AUTHORIZATION.md` (`8de895da…`), and `a1_run.sh` (`d63654bc…`) carries the same five SQL hashes:

| File | SHA-256 |
| --- | --- |
| P1_identity_helpers_004.sql | `9ef14dea4ea0f0ff9270b06eb05339f7dfe114accf9c6264d7dd810a979666ae` |
| P2_private_schema_inventory.sql | `234b81f89d328107ff86b0564c32e57f25f220c8ad8da053dc2cbf82731e39d1` |
| P3_crm_preconditions.sql | `f652ecad1d7adcc1f474d1b0af9753e7a8aec1e14567d03cb350c1312cd2333d` |
| neon-catalog-verify.sql @ 2c6e2a80 | `40b20416909c0ca2c26e2e682cb4ad2c5ef0b87fc257ca79d259dce55a0e9b43` |
| neon-identity-audit.sql @ 2c6e2a80 | `d512b94f8281fd201bcecb3efae3eb39fda2ab372b921d8f4a224bec012dca61` |

`A1_SIGNING.md` is the owner-facing signing and execution procedure. It does not alter `A1_AUTHORIZATION.md`, so
the reviewed hash stands. **Signing anchor:** this session is scoped to one repository, so GitHub's public-key
endpoints (`r88510179-collab.keys`, `.gpg`, the user API) return 403 and cannot be read here. The signature is
therefore anchored to a key the owner holds on their own machine (SSH `ssh-keygen -Y` or GPG detached signature),
or a countersignature in the file whose signed hash is the reviewed `8de895da…`. Nothing in this session can
produce or verify the owner's key, which is correct.

## 23. Production snapshot in the credential-custody inventory

| Field | Value | Evidence |
| --- | --- | --- |
| Snapshot | `snap-gentle-thunder-b5ir7gg3`, name `commercial-v1-owner-recovery-2026-10-28` | `list_snapshots` |
| Source | branch `production` (`br-hidden-darkness-b55g0j83`) | `list_snapshots` |
| Created | 2026-10-28T16:28:28Z, manual, `full_size` 33,415,168 bytes (production's logical size) | `list_snapshots`, `list_operations` |
| Internal storage | the manual snapshot is backed by an archived internal timeline `br-winter-glitter-b50skh1u` (`create_branch` + `timeline_archive` at 16:28:28Z); it is hidden storage, not a usable branch, and does not appear in `list_branches` | `list_operations` |
| Owner / access | the Neon account `org-dawn-leaf-10280035` (free plan, one member, org admin); reachable only by whoever holds that account | `list_organizations`, `list_project_members` |
| Expiration | none; manual snapshots never expire unless given one, and no backup schedule is set (`get_snapshot_schedule` empty) | `get_snapshot_schedule`, Neon docs |
| Free-plan limit | 1 manual snapshot on the free plan; this is it, so another manual snapshot cannot be taken until this is deleted or the plan upgraded | Neon docs |
| Restore risk | it holds a copy of production's data as of 16:28:28Z, including `neon_auth` sessions and signing keys; restoring it creates a NEW branch (new id) and, if finalized, swaps production's computes onto it. That is a production-affecting operation and falls under the hardening plan's "Restores and new branches" rule: it needs its own reviewed security assessment first | Neon docs, `PRE_REGISTRATION_HARDENING.md` |

Not read: no snapshot contents, no `neon_auth` row, no key. **Not deleted**, per instruction. Note for custody:
restoring this snapshot would reintroduce the pre-revocation session and key state the October window cleared, so
it carries the same authorization-state risk as the legacy branch and must not be restored without that assessment.

The full operations history (250 operations, 2026-10-09 to 2026-10-29) was read: no `restore` or
`reset_from_parent` ever; the only `delete_timeline` events are the P0 child (2026-10-09) and four short-lived
internal branches created and deleted the same day on 2026-10-20 to 2026-10-23 (automated daily-probe branches,
none persisting); the legacy branch has only compute start/suspend since 2026-10-28, all from this session's
metadata reads, with `written_data_bytes` still 0.

## 24. A2 scope, proven by category, and the authenticated check that must follow

The read-only, project-scoped tool list was enumerated per category (not just the flat list):

| Category | Read-only tools | SQL-executing? |
| --- | --- | --- |
| querying | `run_sql`, `inspect_database`, `explain_sql_statement`, `list_slow_queries` | yes: `run_sql` only (`run_sql_transaction` is dropped in read-only mode) |
| schema | `compare_database_schema`, `describe_table_schema`, `get_database_tables` | no |
| branches / endpoints / snapshots / data_api / neon_auth / observability / projects / storage / realtime / functions / docs | listing and `get_*` only | no |

Total 49 tools; none of `get_connection_string`, `create_*`, `delete_*`, `reset_*`, `rotate_*`, `update_*`,
`provision_*`, `list_projects`, `list_organizations`, `search`, `fetch`. The only way a scoped read-only session
touches SQL is `run_sql`, which the server runs inside a `READ ONLY` transaction (documented). If the owner wants
the connector unable to run even read SQL, dropping the `querying` category leaves 29 pure-metadata tools; but A5
needs `run_sql` on the child, so the connector keeps `querying` and production stays out of reach by the
operator-path rule, not by removing the tool.

**This public list is not proof of the authenticated grant.** After the owner reconnects, the next session must run
the V1–V5 probes (Part 3 §17) against the live connection and record them: the actual tool set it holds, a refused
cross-project call, `transaction_read_only = on`, a refused `CREATE TEMP TABLE` (SQLSTATE 25006) on the legacy
branch only, and the SQL role's residual table reach. Only those recorded results, not the catalog endpoint, make
A2 done.

## 25. A1 has not run; the PASS conditions it is waiting to produce

A1 is prepared and **not executed**: it requires the owner's signature on `8de895da…` and a separate run approval,
both withheld here. So `H99`, `X99`, `C99`, `I99` and the P2 inventory have **no actual values yet** and none are
invented. The expected results, against which the operator will read the real output:

| Output | Expected PASS | Would be a finding / STOP |
| --- | --- | --- |
| P1 `H99` | PASS: the three identity helpers at 004's hardened fingerprints, SECURITY DEFINER, pinned search_path, `authenticated` executes only `current_user_id()`, `auth.session()` jsonb and `neon_auth.account."userId"` reachable | any helper `PRE-HARDENING`/`MISSING`/`UNREVIEWED`: 004 is not actually in force as recorded |
| P3 `X99` | PASS: no CRM object on production yet; the seven RPC bodies at their baseline fingerprints | any CRM object already present, or an RPC body not at baseline |
| AUTH-C `C99` | PASS (PostgreSQL 18; `C21` PASS, `C23` recorded) | any required C row false: the catalog diverged from the reviewed contract |
| AUTH-C `I99` | PASS, `I05=0`, `I06=0`, `I07` at most the four window sessions of verified no-account users | a live session of an unverified or account-holding user; an `I04` identity with V1 standing not recovered |
| P2 inventory | every `pool_platform_private` object explained from the window record; no reviewed public function or policy names the schema; no Data API role has USAGE | an unexplained object, a dependency from reviewed code, or Data API reach into the schema |

Report format when it runs: the verdict rows and the P2 rows, expected-vs-finding, per `A1_SIGNING.md` §6.

## 26. Smallest next actions for A2 and A3

- **A2 (no writes):** owner removes the current connector and re-adds Neon as `?readonly=true&projectId=fancy-brook-65396623`;
  a fresh session records V1–V5 (the `CREATE TEMP TABLE` probe V4, the only write attempted, must fail on the
  legacy branch and needs the owner's one-time OK). The standing admin connector is used for nothing until replaced.
- **A3 (one write, separately approved):** capture `L1` and the 19-row `008` on the legacy branch read-only through
  the operator path, write the K1-style record (branch id, parent, parent LSN `0/2E95158` at 2026-10-23 18:12:37Z,
  endpoint host, Auth base URL), confirm the Stage B workstream agrees this closes its blocker 2, then delete
  `br-orange-forest-b5nyu8ov` on the owner's written approval and record K4. The snapshot is left as is.

A1 → A2 → A3 → A4 (new child) → A5 (CRM migrations on the child) → A6 (OTP identities and the signed-in matrix) is
the whole path to real authenticated CRM testing; none of it writes to production except A1's read-only reads.

## 27. What this part did not do

No SQL on any Neon branch; no connector change; no snapshot or branch created, restored or deleted; no credential,
password or key read, exported, rotated or changed; no production change; PR #19 and its branch unchanged. The
operations history and snapshot metadata were read through Neon's read-only management API only.

# Part 5: A1 runner version 2, repaired locally (Option B, 2026-10-29)

The owner chose Option B: repair the runner locally, test it, have it independently reviewed and document it. Same
rules as before, and narrower: nothing ran on Neon, nothing in the cloud connected to production, Neon was not
changed, and A1 has not run. `A1_AUTHORIZATION.md` (`8de895da…`) and the five SQL files are unchanged (re-hashed).
The owner's detached signature and private key stay on the owner's Mac; this session has neither.

## 28. Why version 1 could not be run

- It printed each verdict row (`grep … || echo "…: no … row (STOP)"`) and carried on: a missing `H99`, `X99`, `C99` or
  `I99`, a `FINDINGS` or `STOP` verdict, or a required row false under the verdict did not stop it, and it still
  exited 0. P2 was only counted.
- Its hash checks used GNU coreutils options (`sha256sum --check --quiet --strict`), and its own hash was recorded
  only through GNU `realpath --relative-to`, whose fallback could repeat lines in `sha256sums.txt`.
- It did not hash-check the authorization text, did not check that the evidence directory was new, private and
  outside the repository, left TLS to the service entry, and had no terminal or agent-shell boundary.
- Its guard called `current_database()` and `=` unqualified, outside the read-only transaction (found in review).

## 29. Independent review, round 1: version 2 at `8350ba4a…` rejected

An independent reviewer (a separate agent given the code, the authorization and the owner's seven requirements, not
the author's conclusions; no network, no Neon) reproduced three blocking defects on a local server:

| Finding | What it allowed | Fix |
| --- | --- | --- |
| B1 | a line break inside a P2 value (a schema comment) forged a whole row, hiding `USAGE` for `authenticated`: HOLD instead of STOP | psql's own `:ROW_COUNT` closes every file's output; lines must equal rows |
| B2 | tabs inside a trigger name forged P2's detail field, so a trigger on a public table passed as internal | every P2 row must have exactly five fields |
| B3 | a role-level search path putting a planted schema before `pg_catalog` let the unqualified guard run a function that wrote (5 rows committed), or forged `C15` | the guard and every runner statement use `pg_catalog`-qualified names; the effective search path must be exactly `pg_catalog, public` before `BEGIN READ ONLY` |

And: M1, the server's `pg_stat_ssl` flag was required although TLS ends at Neon's proxy (now recorded, not
required; `verify-full` protects the client hop); M2, test gaps found by mutation (removing `LC_ALL`,
`PSQL_HISTORY`, the `unset PG…` line or the HUP/INT traps passed the suite); m1, macOS paths compared with case; m2,
evidence accepted inside another repository; m3, only `sslmode` was pinned (the connection string now pins host,
port 5432, database, role, `sslmode=verify-full` and `gssencmode=disable`); m4, HOLD wording; and nits (`CDPATH`, a
failed listing, a failed evidence hash after the result, raw database text on the terminal, the row count in the
HOLD line). Outside the runner: a public view over `pool_platform_private` appeared in none of the five outputs.
Version 2 now runs one query of its own inside P2's read-only transaction, over `pg_catalog` only, listing every
object outside the schema that depends on it; a Data API-readable view among them is a STOP, any other a HOLD.

## 30. Independent review, round 2: version 2 at `675bc5a9…` rejected

The same reviewer confirmed every round-1 finding closed, then reproduced two new blocking defects and several
smaller ones:

| Finding | What it allowed | Fix |
| --- | --- | --- |
| B1 | the five files call built-ins without schema names; a function planted in `public` whose signature fits a call better than `pg_catalog`'s (`has_schema_privilege(text,oid,text)`, `convert_to(text,text)`) forged `C15` and `H01`: HOLD instead of STOP, with the search path exactly `pg_catalog, public` | inside the read-only transaction, before each file, `public` may hold no function or operator that shares its name with a `pg_catalog` one unless its signature is identical (an exact twin is always hidden by `pg_catalog`); anything else is STOP 3, with the names listed |
| B2 (preflight) | the preflight echoed the service entry's `port`, `dbname` and `user` when they differed from the pinned values; a connection string pasted in as `dbname` printed its password into output the procedure sends to the session | no value read from the service or password file, nor from `PGSERVICEFILE`, `PGPASSFILE` or `PGSSLROOTCERT`, is printed: only key names, counts, and whether each value is what A1 needs |
| M1 | a view over the schema that a Data API role could read through a column grant, or through a second view, was not counted as readable: HOLD instead of STOP | readability by `has_any_column_privilege`; dependents followed through views and through functions that record their dependencies |
| M2 | no test for B1, B2, M1, m2 or m3; three mutants passed the suite (an unhashable evidence file ignored, `DONE` set before `finalize`, a failed `ls -A` tolerated; sanitization removed; the type branch dropped and materialized views not counted as readable) | a test for each, and a mutation check of every fix (§32) |
| m1 (preflight) | READY with a misspelt key, `sslsni=0` or an `options` line, each of which makes psql or the runner stop at the connection | the entry is read as libpq reads it; a line libpq would reject, and every key that would change or break A1's connection, is a STOP |
| m2 | a leading `//` in `PP_OUT`, which `pwd -P` keeps, got past the synced-folder check | a leading `//` is read as `/` in every path comparison |
| m3 | a public function whose `BEGIN ATOMIC` body reads the schema has no source text for P2 to match: HOLD | a public function, or a policy outside the schema, that depends on it is a STOP |
| m4 | statements in the acknowledgment and the procedure not true as written (the dependents listed, the path comparison, the search path, the readable-view and public-code STOPs, "A1 cannot rule it out", the round-1 summary, "it holds no secret") | rewritten; the review verdict moved out of the signed text into `A1_SIGNING.md`, so no pinned file changes after the review |

Nits, all taken: the pinned P2 does not list types (the runner's row now lists the schema's other members); a failed
`finalize` on the HOLD path left two outcomes in the manifest (the second now says which one it replaces); login
event triggers are listed (HOLD); and every view in `public` that a Data API role can read is listed (HOLD), since
the AUTH-C verifier checks tables only. `PGAPPNAME` and the like were still passed to psql (round 3 found that some
of them could still break the connection, §33).

## 31. What version 2 does, by requirement

| # | Requirement | Version 2 | Tests (in `a1_run.test.sh`) |
| --- | --- | --- | --- |
| 1 | STOP, nonzero, on a missing, malformed or non-PASS verdict; enforce every required check | every line checked: the session row; psql's row count last; exactly six fields; a known id, once; the required flag the file defines (pinned in the runner); ok `t`, `f` or empty; the verdict row `PASS`/`t`; every required row `t`; rows carrying sections 1 and 5 (`H07`, `C01` PostgreSQL 18, `C20`, `C21`, `I07`). Exit 4 at once | missing, failing, renamed and lowercase verdicts for all four; required rows false or NULL under PASS; flipped flags; duplicates, unknown ids, field counts, blank lines, empty output, bad session rows, row counts missing, wrong, unreadable, forged or followed by more; real failures of P1, P3, the verifier and the audit |
| 2 | P2 separately: inventory kept whole, HOLD or STOP, never PASS | P2's rows kept whole, exactly five fields, closed by the row count; then the runner's own row (eleven fields, its own row count). STOP: `USAGE` or `CREATE` for a Data API role; reviewed public code naming the schema; a public function or a policy outside it that depends on it; a trigger outside it; a view outside it that a Data API role can read through any column and that depends on it, directly or through views and functions. HOLD: everything else, absence included, every relation in `public` other than the nine commercial tables that a Data API role can read, and every login event trigger | real: `USAGE` and `CREATE` (granted, to `PUBLIC`, behind a spoofing comment, behind a line break), named-by, triggers outside, inside and with tabs in the name, foreign keys, absence, readable and unreadable public views, a column grant, a chain of views, a view through a function outside the schema, a materialized view, a write rule on a public table (listed, not followed), a `BEGIN ATOMIC` public function, a policy, a private type used outside, statistics and an operator inside the schema (members, not outside), a readable view over a commercial table, a readable table in `public`, a login event trigger, and a name with a line break and a tab in each list; every malformed shape of both rows through the fake psql |
| 3 | macOS-compatible SHA-256, pins not weakened | `shasum -a 256`, else `sha256sum`, else `openssl dgst -sha256`, on stdin; exactly 64 lowercase hex, equal to the pin | each tool alone; none; one-byte changes to the authorization and each kit file; symlinked or missing kit file; no AUTH-C commit; a wrong AUTH-C pin |
| 4 | the runner's own hash, reliably | `PP_RUNNER_SHA256` must equal it; one block, parsed before it runs; manifest; staged copy re-hashed; `sha256sums.txt` over everything, and an evidence file that cannot be hashed turns the HOLD into a STOP | unset, uppercase, short, wrong; byte-identical copy; `./a1_run.sh`, through `CDPATH` and a symlinked directory; a symlinked runner refused; a `shasum` that fails on the finished manifest |
| 5 | host/database/role guard, READ ONLY, ROLLBACK, redaction, operator-only | the guard's three values unchanged, now qualified; host, port, database, role, `verify-full` and `gssencmode=disable` pinned in the connection string; the effective search path; `BEGIN READ ONLY` asserted; the overload check; the check of the five tables the identity checks read, and the Neon Auth ownership HOLD; `ROLLBACK`; every PG variable but the three files, and `CDPATH`, cleared; terminal, `RUN A1`, agent and CI refusal; non-printable database text replaced | the exact script and arguments sent; psql's environment; the server's log (five `BEGIN READ ONLY`, five `ROLLBACK`, no `COMMIT`, `SET` or write, all TLS, all `neondb_owner` on `neondb`); a whole-database `pg_dump` identical before and after; the extracted guard refusing another database, role and host; service entries naming another host, database, role or port, `sslmode=disable` and `gssencmode=require`, all overridden; hostile search paths (version 1's guard shown writing, version 2's not); planted overloads (`has_schema_privilege`, `convert_to`, an operator `=`, a default argument, a name with a line break) refused before any file, and an exact twin of `lower(text)` hidden and accepted; each route of the table check (an enum with an implicit cast, a domain, forced and enabled row security, a child table, a view in a table's place, a generated column, a missing column, a collation of another schema, `"expiresAt"` without a time zone, the `neon_auth` schema missing), row security that BYPASSRLS skips (no STOP), and the ownership HOLD (through ownership, and through a SET-only membership); PG variables that would break the connection; a search path setting with a tab; wrong CA, the unmodified runner refused by TLS, closed port, no or wrong password; escape sequences; the password nowhere |
| 6 | fail-closed regression tests | `a1_run.test.sh`, 1211 assertions, all passing | see §32 |

Exit codes: `10` HOLD; `2` STOP before any connection; `3` STOP at a connection; `4` STOP on a check; any other
nonzero code (an interruption included) is a STOP and still ends with the `A1 RESULT: STOP` line.

## 32. Test evidence

`a1_run.test.sh` (`20b6eca2e40823b21a662420e898d8db865a03ccb8abfb1079616b55e0156069`) re-executes itself in a Linux
network namespace that holds only loopback, starts a throwaway PostgreSQL 18.6 with TLS from a test CA, applies the
Commercial V1 baseline (001 at `48e0ac4e`, AUTH-C 002, 003, AUTH-C 004) on a stub of Neon Auth, and drives the
runner through a pseudo-terminal. The unmodified runner is used for everything before a connection, for every
output check through a fake psql that prints recorded rows, and against the local server (which its pinned
production name cannot match); a copy that differs in exactly one line (the expected host, `a1-guard-test.invalid`)
makes the real connections.

| Run | Result |
| --- | --- |
| bash 5.2.21, mawk 1.3.4, psql 16.15 and 18.6 clients | 1211 passed, 0 failed |
| bash 3.2.57 (the macOS `/bin/bash` version, built from GNU source with its signature checked), BWK awk 20231127 (`original-awk`; macOS ships this awk at version 20200816, not run here) | 1211 passed, 0 failed |
| mutation check: 61 copies of the runner, each with one fix of review rounds 1 to 4 removed (the mutants that passed the suite in round 2 included), each run through the whole suite | 60 caught and 1 survivor, the equivalent mutant (`clean()` removed from `hold()`: every HOLD message is runner text plus numbers already checked to be digits, so no output can differ); run on build `958edad5…`, each mutant through the whole suite |
| `a1_preflight_mac.test.sh` (`ffbd05255b52e6171795197a825ac297169ec0da94debc446c31eba4c9134cc1`), both of the above | 693 passed, 0 failed, each |

Not exercised here, and so first exercised by A1 itself: macOS's own `sed`, `grep`, `date` and `ls` (the runner uses
only POSIX features of each; GNU versions ran), a Homebrew or Postgres.app psql, Neon's TLS chain and SNI routing, and
the real production catalog.

## 33. Independent review, round 3: version 2 at `661ac92e…` approved with changes

The reviewer re-ran every earlier reproduction (all closed), agreed with the mutation check (45 of 46 caught; the
survivor is equivalent), and approved with one required change and four recommended ones:

| Finding | What it allowed | Fix |
| --- | --- | --- |
| F1 (required) | whoever owns the tables the identity audit reads could change its counts without changing a row: `"emailVerified"` retyped to an enum with an implicit cast to boolean forged the required `I05` (HOLD instead of STOP); `memberships.auth_user_id` retyped, or row security forced on the commercial tables, removed the `I04` and `I08` HOLD | before each file, inside its read-only transaction, the five tables P3 and the audit read must be plain tables with no child table and no row security in force for the session, and every column they read must exist, not be generated, and have a built-in type and collation; anything else is STOP 3, naming the table or column. The session row records whether the session's role can alter the Neon Auth tables; if it can, the audit is a HOLD for the owner |
| F2 | READY from the preflight with `PGSSLSNI=0`, `PGSSLCERTMODE`, `PGREQUIREAUTH` or another PG variable the runner passed on, or with a service-file line of 1022 characters or more, each of which makes the connection fail | the runner clears every PG variable but `PGSERVICEFILE`, `PGPASSFILE` and `PGSSLROOTCERT`; the preflight refuses such a line |
| N1 | the catalog can change while A1 runs (REPEATABLE READ is no fix, the reviewer agreed) | stated as a limit in the acknowledgment, §5 |
| N2 | a table in `public`, other than the nine, that a Data API role can read appeared in no output | the runner's P2 row lists every such relation (HOLD) |
| N3, N4, N5 | three statements not true as written: every connection variable cleared; the preflight refuses what libpq rejects; BWK awk 20231127 as the macOS awk (macOS ships 20200816) | now true (F2), and the awk stated as it is |

Beyond the review: an owner of an identity table could also swap two columns' names, which the runner does not
detect (column order or key membership would expose some such renames, not all). The acknowledgment (§5) states
this, and the run records whether its own role can alter the Neon Auth tables.

## 34. Independent review, round 4: version 2 at `cc3f6a19…` approved with changes

The reviewer re-ran its round-3 reproductions against the new build, all closed: the enum `"emailVerified"`, the
retyped `auth_user_id`, forced row security and a view standing in for `neon_auth.session` each gave STOP 3;
`PGSSLSNI=0`, `PGSSLCERTMODE=require` and `PGREQUIREAUTH=none` were cleared; an 1100-character service-file line
was a preflight STOP. It agreed with the mutation check (58 of 59 caught; the survivor is equivalent), reproduced
the rename limit the acknowledgment states (§5), and approved with one required change:

| Finding | What it allowed | Fix |
| --- | --- | --- |
| G1 (required) | the table check accepted any built-in type for `neon_auth.session."expiresAt"`. As `timestamp` without time zone (or `date`), the audit's `"expiresAt" > now()` reads through the session's time zone, which A1's own role can set (`ALTER ROLE … SET timezone`): with the column retyped and `Etc/GMT-14` set, a live unverified session ten hours from expiry vanished from `I05` (HOLD instead of STOP) | `"expiresAt"` must be `timestamp with time zone`; anything else is STOP 3, naming the column |
| N1 | a shell whose `compgen` failed would have cleared no PG variable, silently | a failed `compgen -e` is STOP 2 |
| N2 | §33 said no catalog check could tell a rename from the reviewed definition; column order, key membership and `atthasmissing` would expose many | reworded |
| N3 | §32's mutation row described rounds 1 and 2 only | now rounds 1 to 4 |
| N4 | the preflight's long-line message said libpq then rejects the file, but libpq never reads the lines after the chosen entry | reworded; the preflight is stricter there |
| N5 | the reviewer's own round-3 threshold was one character off | nothing to change: libpq 18.6 accepts 1021 characters and a line feed and rejects 1022, as the preflight does |

The tests it found missing were added: G1 itself; a SET-only membership in the owner of `neon_auth.account` (the
ownership HOLD, which a check of `USAGE` instead of `MEMBER` would miss; ownership of `neon_auth.session` alone is
still untested, §35); BYPASSRLS with row security enabled on `neon_auth.session` (no STOP); the `neon_auth` schema
missing (STOP 3 naming the three tables, no psql error); and, in the preflight, a line ending in a carriage return
and a long line after the entry.

## 35. Independent review, round 5: version 2 at `958edad5…` approved

Round 5 of the independent review **approved** runner `958edad5…`, its suite, preflight `af207822…`, its suite and
`A1_RUNNER_ACK.txt` (`25c3ce54…`), all at commit `3af026a`, with no blocking, major or minor finding. The reviewer
is the same as in rounds 1 to 4: a separate agent given the code, the authorization and the owner's seven
requirements, with no network and no Neon.

- Every requirement MET, with line evidence. Both suites were re-run (1211 and 693 assertions, bash 5.2 with mawk
  and bash 3.2.57 with BWK awk, all passing), and the mutation check was confirmed (61 single-fix removals, 60
  caught; the survivor is equivalent). For each new test, a copy with its guard removed made the test fail.
- G1 is closed: `"expiresAt"` as `timestamp` or as `date`, with the session's time zone shifted through A1's own
  role (Etc/GMT-14, or about seven days), is STOP 3 at the first file; as `timestamptz`, a live unverified session
  still gives STOP 4 on `I05`.
- The new condition raises no error, leaves nothing unqualified, and accepts no type that reads through the time
  zone (a precision such as `timestamptz(3)` passes). It stops production only if production's `"expiresAt"` is not
  `timestamp with time zone`, which is the intended STOP.
- A runner without `compgen` stops with STOP 2 before it creates anything (reproduced on both bash versions).

Three notes, none of which needs a change before signing:

1. The `compgen` STOP has no test of its own; the reviewer checked it by hand, as above.
2. Ownership of `neon_auth.session` alone has no test of its own (`"user"` and `account` have); the reviewer checked
   it by hand: the run gives the ownership HOLD.
3. A `BASH_ENV` file or an exported bash function in the operator's own shell runs inside the runner before its
   first line. That is within the acknowledgment's boundary that the owner runs A1 from the owner's own Terminal;
   macOS's default shell, zsh, sets neither unless configured to.

Rounds 1 and 2 rejected earlier builds; rounds 3 and 4 approved with one required change each, and both were made
(acknowledgment section 1; the reconciliation's Part 5, sections 29 to 35).

## 36. The supplemental acknowledgment, and the smallest valid procedure

The authorization names the runner by path and pins only the SQL, so its signature still verifies; but the owner
reviewed version 1 as part of the signed package, and version 2 is different code acting under that authority, with
one query of its own. The owner's signature must cover the new bytes, and re-signing the authorization would mean a
new text. So version 2 needs one supplemental signed text, `A1_RUNNER_ACK.txt`
(`25c3ce544c68bf60dbf93dcce01388ec49372a5266ea18dff4cd08876da0fd03`). It pins the runner
(`958edad58daeab10df66e7a836e5db6ebc3650fb7b293cf2e98725d452da6bee`) and the test suite, restates what stays
unchanged, lists what version 2 adds and where it reads the authorization more strictly, and states what A1 still
cannot establish. The smallest valid procedure, in `A1_SIGNING.md`:

1. `git pull --ff-only` the Mac checkout, run `a1_preflight_mac.sh` (one `[TODO]`: the acknowledgment is unsigned);
2. read the acknowledgment and the round-5 verdict in `A1_SIGNING.md`, then sign the acknowledgment with
   `ssh-keygen -Y sign -n file` and the key that signed the authorization;
3. run the preflight again until it prints `PREFLIGHT RESULT: READY`, and send that output (it prints no value from the
   service or password file, so it holds no password);
4. the separate "Run A1 now" approval; then the printed command, from the owner's own Terminal.

## 37. The Mac preflight

`a1_preflight_mac.sh` (`af2078228e48ecd8e6fabb6b178449f46063b6eae1ed3709ad578082837ded12`) uses the owner's
actual paths (`$HOME/Documents/commissioner-crm-a1`, `$HOME/.ssh/crm_a1_signing_ed25519.pub`,
`$HOME/commissioner-crm-a1-evidence`) and contains no placeholder. It opens no network connection, never opens the
private key, and prints no value read from the service or password file, nor from `PGSERVICEFILE`, `PGPASSFILE` or
`PGSSLROOTCERT`: only key names from its own lists, counts, and whether each value is what A1 needs (its tests put
a planted secret into every value and path it reads, a whole connection string pasted in as the database
included, and check that the secret appears nowhere). It refuses to run outside macOS, without a terminal or in an
agent or CI shell; checks every pinned hash and both signatures; finds the single service entry for the production
host, reading the file as libpq does, and refuses what libpq would reject or what would change or break A1's
connection (a misspelt key, a line without `=`, `service`, `hostaddr`, `options`, `replication`, `sslsni`,
`sslkeylogfile` and the other keys A1 does not use, and a line of 1022 characters or more anywhere in the file,
which libpq refuses when it reaches one); checks the root certificate, the password source and the permissions
(port, database, role and `sslmode` are noted without their values, since the runner pins them); checks that the
evidence directory is private and outside every git repository; and on READY prints the exact A1 command.

## 38. What this part did not do

No SQL on any Neon branch; no connection to production or to Neon from this session; no Neon setting, branch,
snapshot or credential touched; no password or key read; `A1_AUTHORIZATION.md` and the five SQL files unchanged; A1
not run; PR #19 and its branch unchanged; nothing merged or deployed. For the tests only, PostgreSQL 18 (PGDG
packages), a bash 3.2.57 build and `original-awk` were installed in this disposable container.
