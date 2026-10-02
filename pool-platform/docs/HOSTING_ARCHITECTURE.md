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

- **A dedicated Vercel project**: static output plus **exactly one narrowly scoped function**, the same-origin Neon
  Auth proxy (`api/auth.mjs`, below). No other function and no middleware.
- **Project root limited to `pool-platform/`**: Install Command `npm ci` (from `package-lock.json`), Build Command
  `npm run build`, Output Directory `dist`, Node 22 (the version the lockfile and build were verified with).
- **Only the build output is published as static files**: the 14 allow-listed files, the generated
  `platform-config.js` and `vendor/neon-js.js`. Tests, docs, migrations, validation, scripts, `node_modules` and
  anything outside `pool-platform/` (the Pool Center included) cannot reach it; `frontend-readiness.test.mjs` checks
  this. The proxy (`api/auth.mjs`, `server/auth-proxy-core.mjs` and the two modules it imports, `auth-core.js` and
  `scripts/runtime-config.mjs`) runs only as the function; none of its code or configuration is in `dist/`.
- **A final custom commercial domain, chosen before any Neon production-origin change.** Data API CORS is then
  configured for exactly that origin (no wildcard), and whether Neon Auth also needs it as a trusted domain is
  settled by the open Neon questions below, each in its own approved step. The `*.vercel.app` hostnames are not used
  for live sign-in unless separately approved.

## Same-origin Neon Auth proxy (finding F-1)

Neon Auth answers credentialed CORS for any `Origin` (including `null`), and neither trusted domains nor
`allow_localhost` changes that (diagnostic of 2026-09-30, fully rolled back). A browser holding a Neon Auth cookie can
therefore have its session read by other pages on the same site. The corrective is that **the browser never talks to
the Neon Auth host**:

- The pages call exactly four routes on their own origin, and `server/auth-proxy-core.mjs` forwards each to one fixed
  upstream endpoint:

  | Route (same origin) | Method | Upstream (fixed) |
  | --- | --- | --- |
  | `/api/auth/get-session` | GET | `<upstream>/get-session` |
  | `/api/auth/email-otp/send-verification-otp` | POST | `<upstream>/email-otp/send-verification-otp` |
  | `/api/auth/sign-in/email-otp` | POST | `<upstream>/sign-in/email-otp` |
  | `/api/auth/sign-out` | POST | `<upstream>/sign-out` |

  Every other path under `/api/auth` is 404 and a wrong method 405. `vercel.json` rewrites the four paths to the one
  function (`/api/auth?route=<id>`), and the adapter maps them back to the route's own path.
- **Cookies.** The browser holds one session cookie, the app's own: `__Host-pool-platform-session; HttpOnly; Secure;
  SameSite=Strict; Path=/` (no `Domain`, never `Partitioned`). The `__Host-` prefix makes a conforming browser refuse
  to set this **exact** name with a `Domain` or a non-root path, so a sibling subdomain cannot plant the protected
  cookie itself. That prefix alone is not full isolation: a sibling host can still set a **different**, non-exact name
  that only resembles this one (a leading NBSP before `__Host-pool-platform-session`, say), which the browser keeps
  distinct from the `__Host-` cookie and sends alongside it. The server therefore also parses cookie names exactly
  (`sessionCookieValue`): optional whitespace is ASCII `SP`/`HTAB` only, never Unicode whitespace or normalisation, so
  only the byte-exact name supplies a session value and a non-exact look-alike never does (see **Duplicate session
  cookies fail closed**). Compromise of the exact app host stays outside this protection. Neon's session
  cookie name never reaches the browser: the proxy sends the app cookie's value upstream under Neon's name
  (`UPSTREAM_SESSION_COOKIE`, the one place it is named) and re-issues Neon's new or refreshed value as the app
  cookie, keeping only its value and lifetime. No other browser cookie is sent upstream, and every other upstream
  cookie is dropped. Sign-out always deletes the app cookie, with the attributes it was set with. Browsers hold no
  cookie for the Neon Auth host.
- **Duplicate and look-alike session cookies fail closed.** A request is refused with 401 on every route when it
  carries the exact app cookie more than once, **or** when it carries a non-exact cookie name that the retired
  broad-`trim()` parser would have mistaken for the app cookie (a planted look-alike such as a leading NBSP before the
  name). The check runs after the route, method, query-string, `Host`, fetch-metadata and `Origin` checks, and before
  any body processing, the rate-limit hook, the upstream request or any `Set-Cookie`: neither value reaches Neon, and
  no cookie is set or deleted, since deleting the host's own cookie could leave the planted one as the only cookie.
  The exact look-alike is never normalised into the real cookie or used as a session; it only triggers the
  fail-closed refusal. The page then shows the refusal ("Clear this site's cookies, then sign in again."). Cookies
  are not isolated by port, so the app host must serve nothing else, on any port; on `localhost` every port shares
  one host and cookie namespace, which stays a local-gate operational concern.
- **Tokens.** Every `token` field is removed from response bodies, and an answer that still contains the session
  token is refused (502), so page JavaScript never sees the opaque session token. `set-auth-token` is dropped.
  `set-auth-jwt` is passed on unchanged: the Data API bearer path (`set-auth-jwt` → SDK memory →
  `Authorization: Bearer <JWT>` → RPC) is exactly as before.
- **Checks.** `Host` must be exactly the app host (421). Every POST must carry exactly the app origin (missing,
  `null`, another scheme, port or host: 403). `Sec-Fetch-Site`, when sent, must be `same-origin` and
  `Sec-Fetch-Mode` `cors` or `same-origin` (403). State-changing routes accept only `application/json`, at most
  2048 bytes, and a fixed schema; the OTP type is always `sign-in`. No query string is accepted.
- **Upstream.** The upstream protocol, host, base path and endpoint path come only from server configuration.
  Upstream always sees the app's own origin as `Origin`, never the browser's, and only `accept`, `content-type`,
  `user-agent`, `origin` and the session cookie. Upstream failures become a generic 502.
- **Responses** never carry `Access-Control-*` headers, and always carry `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`
  and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
- **Logs** hold route, method, status, duration and a fixed reason code only: never an OTP, email, body, cookie,
  session token, JWT or `Authorization` value.
- **CSRF** is covered by the `SameSite=Strict` cookie, the exact `Origin` check on every POST, `Sec-Fetch-Site`,
  JSON-only state-changing requests, and the absence of any CORS header (an `OPTIONS` preflight is 405). No
  synchronizer token is used.

### Server-only configuration (never a build variable, never in the browser, no secret)

| Variable | Value | Notes |
| --- | --- | --- |
| `POOL_PLATFORM_MODE` | `live` | Anything else disables the proxy: every request is 404. |
| `POOL_PLATFORM_AUTH_UPSTREAM_URL` | the Neon Auth base URL of the commercial branch | `https`, canonical, a host matched label by label as `ep-<endpoint>.neonauth.<region>.neon.tech` (it must end in `neon.tech`), no explicit port (only the implicit default HTTPS port is accepted; `:443`, `:8443` or any other explicit port is refused) and a `/<database>/auth` path. |
| `POOL_PLATFORM_APP_ORIGIN` | the final `https://` commercial origin | Exactly an origin: compared with `Origin` and sent upstream as `Origin`. |

Missing or malformed values fail closed (404 everywhere). The design needs no secret, no Neon API key, no database
credential and no cookie-signing secret. `POOL_PLATFORM_AUTH_URL` is retired: the build refuses it.

### Rate limiting

The core has a rate-limit hook, asked before an OTP is sent or verified with the route, the client IP and a keyed
hash of the normalized email (never the email itself). **No store is bundled**, so no hook is installed today. At the
hosting gate, Vercel Firewall rate-limit rules on `POST /api/auth/email-otp/send-verification-otp` and
`POST /api/auth/sign-in/email-otp`, keyed per client IP, are the edge control; a per-email limit needs a shared
store and its own approval. The proxy never forwards a client IP upstream.

### Open Neon dependencies (unanswered; nothing below is assumed)

- **H.** Which `Origin` Neon Auth's origin check expects on proxied, cookie-bearing POSTs (sign-in, sign-out), and
  whether the app origin must be a trusted domain.
- **I. HOSTING BLOCKER.** How Email OTP send/verify limits are keyed. Server-to-server calls from the function come
  from shared egress IPs, and Better Auth keys its IP limiter on `x-forwarded-for`. If Neon keys OTP limits by source
  IP and ignores a forwarded client IP, every user of the app shares one bucket (Better Auth's default is 3 per
  60 s). This must be answered by Neon or measured in a controlled test before the proxy is relied on in hosting.
- **K.** Whether trusted domains populate Better Auth's `trustedOrigins`.
- **L. Hosting dependency.** The canonical, stable name of Neon's session cookie (Neon's docs say
  `__Secure-neonauth.session_token`; the SDK, and the browser before the proxy, show `__Secure-neon-auth.session_token`,
  which the proxy uses). It is named in one constant, `UPSTREAM_SESSION_COOKIE` in `server/auth-proxy-core.mjs`, and
  only ever exchanged with Neon. The browser's cookie (`__Host-pool-platform-session`) does not depend on it, so a
  rename changes that constant only. Until it is answered, a rename would show as sign-in failing closed (no session
  recognized), never as another session.
- **M.** The supported `SameSite` for a proxied cookie (Neon's server docs say `strict`, its SDK code defaults to
  `lax`; the proxy sets `Strict`).
- **N.** Compatibility of the hosted Better Auth 1.4.18 (per Neon's docs) with the pinned SDK tree's better-auth
  1.6.23.
- Whether server-to-server `get-session` returns `set-auth-jwt` (it must, for the Data API path; the proxy fails
  closed if it does not).
- Whether `/sign-out` revokes the Neon session immediately. An already-issued JWT stays valid at the Data API until
  it expires, up to about 15 minutes.

## Configuration per environment

The build reads only `POOL_PLATFORM_MODE`, `POOL_PLATFORM_DATA_URL` and `POOL_PLATFORM_DEFAULT_POOL_SLUG`, and fails
closed on anything malformed (`scripts/runtime-config.mjs`). The function reads only the server-only variables above.

| Environment | Build (POOL_PLATFORM_*) | Function (server-only) | Result |
| --- | --- | --- | --- |
| Production | `MODE=live`, the commercial Data API URL, the pilot slug | `MODE=live`, the Auth upstream URL, the production origin | Live build and proxy |
| Preview | none | none | Sandbox build; the proxy answers 404 to everything |
| Development | none (local runs use `.env.local`, git-ignored) | none | Sandbox unless the operator builds and serves live locally |

Preview deployments stay sandbox-only unless a separate staging backend **and** staging origin are deliberately
approved. They are public values, but they are still set in the host's environment settings, never committed.
No password, connection string, API key, Neon management credential or Vercel credential is ever a build variable.

## HTTP response headers (set by the host, not in HTML)

- `Content-Security-Policy`: exactly what the production build prints (`contentSecurityPolicy()` in
  `scripts/runtime-config.mjs`), i.e.

      default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'none';
      connect-src 'self' <EXACT_DATA_API_ORIGIN>; worker-src 'self'; manifest-src 'self';
      object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'

  `connect-src` never names Neon Auth: Auth is same-origin, so the browser itself refuses any direct request to the
  Auth host. It must be a response header (`frame-ancestors` has no effect in a `<meta>` tag). Never
  `'unsafe-inline'`, `'unsafe-eval'`, a wildcard or a CDN. One report is expected when the SDK loads: `script-src`
  refusing `eval` from `vendor/neon-js.js` (zod's feature probe, which then stays on its non-eval path). Whether the
  first hosted run uses `Content-Security-Policy-Report-Only` before enforcing is a decision for the hosting gate.
  The proxy sets its own headers (above) on its responses.
- `Cache-Control: no-cache` (revalidate every time) for the pages, `platform-config.js`, `service-worker.js` and
  `sw-register.js`; file names carry no content hash, so the other files revalidate too. Confirm the host's defaults
  at the hosting gate rather than assuming them.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and HSTS on the custom domain.
- Never `Service-Worker-Allowed`: the worker's scope stays the commercial root.

`scripts/serve.mjs` already sends the CSP, `nosniff`, `no-referrer` and `no-cache` locally and mounts the same proxy
core at `/api/auth`, so the localhost gate runs under the same policy and the same Auth path.

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

1. Resolve, or settle by a controlled test, Neon questions I (the hosting blocker), H and K; record L, M and N.
2. Choose the final commercial domain.
3. Create the Vercel project with root `pool-platform/`, sandbox only (the proxy disabled), and verify a preview,
   including how the `vercel.json` rewrites present the request URL, `Host` and `x-real-ip` to the function, and that
   the `Cookie` header reaches it joined with `; ` (the proxy reads cookies only as `;`-separated pairs).
4. Add the Data API CORS entry (and, if question H/K requires it, the Neon Auth trusted domain) for exactly the
   production origin.
5. Set the production build variables and the function's server-only variables, and the Vercel Firewall
   rate-limit rules; deploy, verify hashes, headers, CSP and the proxy's refusals, then promote.
6. Repeat the browser and device matrix of `FRONTEND_INTEGRATION_RUNBOOK.md`, including its Auth proxy checks,
   against the hosted origin.
