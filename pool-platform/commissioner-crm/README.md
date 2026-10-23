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

## No deployments or production migrations
This is a source-only branch. No hosting, Neon or runtime configuration is changed.
