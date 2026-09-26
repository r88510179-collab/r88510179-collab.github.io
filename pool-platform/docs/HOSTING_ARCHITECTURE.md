# Commercial hosting architecture (intended, not configured)

This is the intended production design for the commercial frontend. **Nothing here exists yet**: no Vercel project,
no Git connection, no domain, no environment variables, no deployment, and no Neon/Vercel integration have been
created, and no Neon trusted origin or Data API CORS entry has been added for a hosted origin. Each of those is a
separate, approved step of a later hosting gate.

## Why a dedicated origin

Today the commercial pages would share `r88510179-collab.github.io` with the private NFL Pool Center. An origin is the
boundary for Cache Storage, service workers, storage, cookies sent by the pages and the CSP, so the commercial product
gets its own origin, separate from `r88510179-collab.github.io`. Until then the tracked source stays safe to publish
there: its `platform-config.js` is the sandbox, no live URL is committed, and `dist/` and `.env*` are git-ignored.

## Target

- **A dedicated Vercel project** (static output only; no serverless functions, no middleware).
- **Project root limited to `pool-platform/`**: Install Command `npm ci` (from `package-lock.json`), Build Command
  `npm run build`, Output Directory `dist`, Node 22 (the version the lockfile and build were verified with).
- **Only the build output is published**: the 14 allow-listed files, the generated `platform-config.js` and
  `vendor/neon-js.js`. Tests, docs, migrations, validation, scripts, `node_modules` and anything outside
  `pool-platform/` (the Pool Center included) cannot reach it; `frontend-readiness.test.mjs` checks this.
- **A final custom commercial domain, chosen before any Neon production-origin change.** Neon Auth trusted
  domains/origins and Data API CORS are then configured for exactly that origin (no wildcard), in its own approved
  step. The `*.vercel.app` hostnames are not used for live sign-in unless separately approved.

## Configuration per environment

The build reads only `POOL_PLATFORM_MODE`, `POOL_PLATFORM_AUTH_URL`, `POOL_PLATFORM_DATA_URL` and
`POOL_PLATFORM_DEFAULT_POOL_SLUG`, and fails closed on anything malformed (`scripts/runtime-config.mjs`).

| Environment | POOL_PLATFORM_* | Result |
| --- | --- | --- |
| Production | `MODE=live`, the commercial Auth and Data API URLs, the pilot slug | Live build |
| Preview | none | Sandbox build (synthetic data, no backend named) |
| Development | none (local runs use `.env.local`, git-ignored) | Sandbox unless the operator builds live locally |

Preview deployments stay sandbox-only unless a separate staging backend **and** staging origin are deliberately
approved. They are public values, but they are still set in the host's environment settings, never committed.
No password, connection string, API key, Neon management credential or Vercel credential is ever a build variable.

## HTTP response headers (set by the host, not in HTML)

- `Content-Security-Policy`: exactly what the production build prints (`contentSecurityPolicy()` in
  `scripts/runtime-config.mjs`), i.e.

      default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'none';
      connect-src 'self' <EXACT_AUTH_ORIGIN> <EXACT_DATA_API_ORIGIN>; worker-src 'self'; manifest-src 'self';
      object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'

  It must be a response header (`frame-ancestors` has no effect in a `<meta>` tag). Never `'unsafe-inline'`,
  `'unsafe-eval'`, a wildcard or a CDN. One report is expected when the SDK loads: `script-src` refusing `eval` from
  `vendor/neon-js.js` (zod's feature probe, which then stays on its non-eval path). Whether the first hosted run uses
  `Content-Security-Policy-Report-Only` before enforcing is a decision for the hosting gate.
- `Cache-Control: no-cache` (revalidate every time) for the pages, `platform-config.js`, `service-worker.js` and
  `sw-register.js`; file names carry no content hash, so the other files revalidate too. Confirm the host's defaults
  at the hosting gate rather than assuming them.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and HSTS on the custom domain.
- Never `Service-Worker-Allowed`: the worker's scope stays the commercial root.

`scripts/serve.mjs` already sends the CSP, `nosniff`, `no-referrer` and `no-cache` locally, so the localhost gate runs
under the same policy.

## Deployments, promotion and rollback

- One commit → one reproducible build. Record the commit SHA, the per-file SHA-256 list and the CSP that the build
  prints, and compare them with a local build of the same commit and variables before promoting.
- Each deployment is immutable. Promote the exact verified deployment to the production domain; never rebuild
  between verification and promotion.
- Rollback is promoting the previous recorded deployment. The service worker's cache is versioned
  (`pool-platform-commercial-vN`) and the configuration is never cached, so a rollback cannot leave a newer
  configuration pinned in browsers.
- How deployments are triggered is a hosting-gate decision: a Git connection limited to the commercial release
  branch with builds skipped when `pool-platform/` is unchanged, or prebuilt deployments of a verified local build.
  `main` is not the Commercial V1 line and must not be the production branch.

## Order of the later hosting gate (each step separately approved)

1. Choose the final commercial domain.
2. Create the Vercel project with root `pool-platform/`, sandbox only, and verify a preview.
3. Add the Neon Auth trusted origin and Data API CORS entry for exactly the production origin.
4. Set the production `POOL_PLATFORM_*` values, deploy, verify hashes, headers and CSP, then promote.
5. Repeat the browser and device matrix of `FRONTEND_INTEGRATION_RUNBOOK.md` against the hosted origin.
