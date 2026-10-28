# AUTH-C → Commissioner CRM release reconciliation (hold)

**Status on October 23, 2026:** Commercial baseline 48e0ac4e0d6a4cd745cdd4ed2a67fc56ef53cb60 remains unchanged. AUTH-C candidate 2c6e2a805fa816638808cb2d96d430ee177453e6 is eight commits ahead, but not merged or accepted as the production identity. Draft CRM PR #19 is NOT approved to merge. This is a runbook, not a release authorization.

## Verified code relationships

- The AUTH-C candidate and existing commercial baseline have identical platform-client.js, scripts/build.mjs and scripts/runtime-config.mjs blobs. The CRM bridge reuses these APIs and same-origin CSP.
- AUTH-C changes auth-core.js, commissioner.js, participant.js, migration 002 and introduces identity-hardening migration 004. CRM PR #19 does not change these files.
- AUTH-C migration 004 hardens current_user_id, email and verified-email helpers with session subject, banned-account and linked-account checks. CRM must not overwrite these helpers.
- AUTH-C migration 002 and CRM migration 002 overlap seven functions: pool_platform_is_tenant_commissioner, pool_platform_can_read_pool, pool_platform_can_read_season, pool_platform_commissioner_context, pool_platform_create_entry_invite, pool_platform_submit_entry, and pool_platform_submit_batch. CRM scopes co-commissioner rights by pool/capability. Apply the accepted AUTH-C version FIRST, then the reconciled CRM changes, or AUTH-C can overwrite pool-scoped restrictions.
- The AUTH-C catalog verifier expects nine original tables and exactly ten function grants. Those invariants describe AUTH-C before CRM additions. Retain that verifier for AUTH-C acceptance; add a separately approved CRM catalog baseline afterward.

## Ordered release gates — stop at any failure

1. Obtain independent acceptance of the exact final AUTH-C production SHA, deployment and database migration. Do not treat the previous candidate as approval. Verify Stage A and B evidence on that release.
2. Verify production branch and Neon schema match the accepted AUTH-C identity. Do not apply old migrations in arbitrary order.
3. Create a fresh isolated Neon validation branch derived from accepted AUTH-C production. The prior CRM staging branch br-orange-forest-b5nyu8ov was cloned from pre-AUTH-C and is NOT adequate for final acceptance.
4. Reconcile all seven overlapping functions against the accepted AUTH-C code. Apply CRM migrations 001, 002, 003, then 005 in the new staging branch. Run 004 invariants, rollback-only 006/007 simulations, read-only 008_post_auth_c_readonly_gate.sql and read-only 009_crm_catalog_baseline.sql. All 19 rows of 008 must pass and 009 must end `K99 PASS`; the unchanged AUTH-C catalog verifier must then report exactly the findings 009's header lists (C02, C03, C08, C09, C10, C11, C12, C14) and nothing else. Rehearsed end to end on a local PostgreSQL 16 with a stub of Neon Auth on 2026-10-28 (`CRM_RESUMPTION_RECONCILIATION_2026-10-28.md`, Part 2).
5. Use real, distinct authenticated owner, pool-scoped assistant, participant and foreign-tenant commissioner accounts. Verify positive and negative RLS, grants, invite creation and claiming, source locks, pick deadlines, Survivor reuse, append-only dues and sign-out/session changes. No credentials, OTP, JWT or private tokens in reports.
6. Separately review Netlify packaging changes for the connected CRM entrypoint, CSP, service worker and explicit allowlist. Do not publish raw SQL, demo assets or unrelated files.
7. Verify authenticated host in 360/412/1440px browser sizes, then real Samsung and desktop. Check A→B→A pool switching, token refresh, revocation and account changes.
8. Obtain separate owner authorization for production database migration, PR merge and deployment. Preserve independently verified rollback identities.

## Expected negative gate today

On the original isolated CRM validation branch, read-only gate 008 returned 15 PASS and 3 FAIL: AUTH-C session-subject validation, linked-account exclusion, and verified-email claim checks. The old staging branch predates AUTH-C; these failures are expected. Do NOT weaken these assertions. With the 19th row added on 2026-10-28 (assistant enrollment refuses account-holding users), that branch would report 15 PASS and 4 FAIL: its copy of 005 predates the predicate. The branch is a pre-window copy of production and is to be retired under owner approval after its state is captured read-only (`validation/L1_legacy_branch_inventory.sql`); the status of gate 1 and the production baseline are tracked in `CRM_RESUMPTION_RECONCILIATION_2026-10-28.md`.

## Restrictions

- Dues remain manual off-app bookkeeping, without any payment collection or processor.
- Noncommercial NFL Pool Center, Fantasy GM and other Smokke projects remain untouched.
- Current CI uses intercepted fictional HTTPS sessions, not real JWT acceptance.
- No production DB migration, merge, DNS change, deployment, or paid service is authorized by this draft.
