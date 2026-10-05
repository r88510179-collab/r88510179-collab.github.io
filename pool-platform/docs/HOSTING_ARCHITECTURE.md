# Commercial hosting architecture (intended, not configured)

This is the intended production design for the commercial frontend. **Nothing here exists yet**: no Netlify account
action has occurred (no site, Git connection, environment variable, build, deploy, rate-limit rule, Firewall Traffic
Rule or domain), no Vercel project exists, no Neon/host integration has been created, and no Neon trusted origin,
trusted domain or Data API CORS entry has been added for a hosted origin. Each of those is a separate, approved step
of a later hosting gate.

## Why a dedicated origin

Today the commercial pages would share `r88510179-collab.github.io` with the private NFL Pool Center. An origin is the
boundary for Cache Storage, service workers, storage, cookies sent by the pages and the CSP, so the commercial product
gets its own origin, separate from `r88510179-collab.github.io`. Until then the tracked source stays safe to publish
there: its `platform-config.js` is the sandbox, no live URL is committed, and `dist/` and `.env*` are git-ignored.

## Target

- **Netlify is the current hosting target**: one dedicated Netlify site serving the static build plus **exactly two
  narrowly scoped functions**, `auth-otp` and `auth-session` in `netlify/functions/`, which together host the
  same-origin Neon Auth proxy (below) through one thin adapter (`server/netlify-adapter.mjs`) around the one reviewed
  core (`server/auth-proxy-core.mjs`). No other function, no edge function, no redirect rule and no build plugin.
- **The site's base directory is `pool-platform/`**, where Netlify reads `netlify.toml`: the build command
  `npm ci && npm run build && node scripts/netlify-headers.mjs` behind a deploy-context guard, publish directory
  `dist`, functions directory `netlify/functions`, Pretty URLs off, and Node 22 from `.nvmrc` (the version the lockfile
  and build were verified with). See **Netlify** below.
- **Only the build output is published as static files**: the 14 allow-listed files, the generated
  `platform-config.js` and `vendor/neon-js.js`, plus `_headers`, generated after the build. Tests, docs, migrations,
  validation, scripts, `node_modules`, the Netlify and Vercel configuration, the functions and anything outside
  `pool-platform/` (the Pool Center included) cannot reach it; `frontend-readiness.test.mjs` checks this. The proxy
  (the two functions, the adapter, the core and the two modules it imports, `auth-core.js` and
  `scripts/runtime-config.mjs`) runs only as the functions; none of its code or configuration is in `dist/`.
- **A final custom commercial domain, chosen before any Neon production-origin change.** Data API CORS is then
  configured for exactly that origin (no wildcard), and whether Neon Auth also needs it as a trusted domain is
  settled by the open Neon questions below, each in its own approved step. The `*.netlify.app` hostnames are not used
  for live sign-in unless separately approved.
- **The Vercel adapter is kept but is not the chosen target.** `vercel.json` and `api/auth.mjs` stay unchanged for
  history and compatibility, and their tests still run; nothing is configured on Vercel.

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

  Every other path under `/api/auth` is 404 and a wrong method 405. On Netlify the two OTP routes are served by the
  `auth-otp` function and everything else under `/api/auth` by `auth-session` (see **Netlify**). The retained
  `vercel.json` rewrites the four paths to one function (`/api/auth?route=<id>`), and its adapter maps them back to
  the route's own path.
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
hash of the normalized email (never the email itself). **No store is bundled**, so no hook is installed today. On
Netlify the edge control is code-based rate limiting, declared in each function's `config`: the stricter rule on the
two OTP routes (`auth-otp`), a looser one on the session routes (`auth-session`), both counted per client IP and
domain (see **Netlify**). Those numbers are hosting-spike settings, not an answer to question I below; a per-email
limit needs a shared store and its own approval. The proxy never forwards a client IP upstream.

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

## Netlify (current hosting target)

Code only so far: nothing below has been configured or deployed, and nothing Netlify does at its edge or in its
function runtime is verified. What only a deploy can show is listed under **Stage A**.

### Build and publish

| Setting | Value | Set in |
| --- | --- | --- |
| Base directory | `pool-platform` | the site (how Netlify finds `pool-platform/netlify.toml`) |
| Build command | `npm ci && npm run build && node scripts/netlify-headers.mjs`, behind the deploy-context guard | `netlify.toml` |
| Publish directory | `dist` | `netlify.toml` |
| Functions directory | `netlify/functions` | `netlify.toml` |
| Pretty URLs | off: `[build.processing.html] pretty_urls = false` | `netlify.toml` (overrides the site setting) |
| Node.js | 22 | `.nvmrc` |

Netlify documents that it runs `npm install` itself for a repository with no other lockfile type; the build command's
own `npm ci` installs exactly `package-lock.json` whatever that left, and `scripts/build.mjs` refuses a tree that
differs from the lockfile. Pretty URLs stay off because that post-processing rewrites link URLs in the built pages,
and the served pages must be the built bytes. `netlify.toml` sets no environment variable, URL, origin, secret,
header rule or redirect (`netlify-hosting.test.mjs`).

### Functions and routing

| Function | `config.path` | `config.excludedPath` | Code-based rate limit |
| --- | --- | --- | --- |
| `auth-otp` | `/api/auth/email-otp/send-verification-otp`, `/api/auth/sign-in/email-otp` | none | 10 requests per 180 s, per client IP and domain |
| `auth-session` | `/api/auth`, `/api/auth/*` | the two OTP paths | 120 requests per 60 s, per client IP and domain |

- Each `config` is a plain literal that Netlify reads from the source at build time; `netlify-adapter.test.mjs` pins
  it to the core's route constants. No `method` is restricted, so every method Netlify routes to functions,
  `OPTIONS` included, reaches the core and is answered there (an `OPTIONS` preflight is 405).
- Netlify documents that a function with a custom `path` is reachable only there, not at
  `/.netlify/functions/<name>`. Were it reached there anyway, the core would answer 404: that is not one of the four
  routes.
- Each function serves only the routes it owns and refuses the others with the core's own 404 before the core runs,
  so a URL that Netlify's router matches as another path under `/api/auth` but that a Web `Request` normalizes to an
  OTP route (a dot segment, an encoded dot, a backslash) still cannot be served by `auth-session` under the looser
  limit.
- The rate limits use Netlify's two code-based rules (the Free plan's allowance). Netlify answers a request over the
  limit itself, with 429, and documents that enforcement can lag by up to about 10 seconds. The numbers are
  hosting-spike settings: they are not an answer to Neon question I, and no per-email limiter exists.

### The adapter (`server/netlify-adapter.mjs`)

Each function hands the core the Web `Request` Netlify delivered, unchanged, with `host` set to the raw `Host` header
(`request.headers.get('host')`; never the URL's host or a forwarding header) and `clientIp` set to `context.ip`, which
feeds only the rate-limit hook (none installed) and is never sent upstream. It never uses `context.cookies` or any
other part of the Netlify Context, never parses, rebuilds or normalizes a cookie, and returns the core's `Response` as
it is, `Set-Cookie` lines included. An exception becomes the core's generic 502, as in `scripts/serve.mjs`. The log is
the core's: one JSON line per request with route, method, status, duration and a fixed reason code (the adapter adds
`function-route` and `adapter-error`), never a body, OTP, email, cookie, token, JWT, IP address or invite token.

### Response headers (`dist/_headers`)

`scripts/netlify-headers.mjs` runs after the build and writes `dist/_headers`, one `/*` rule (Netlify's documented
form for every page of a site) with `Content-Security-Policy` exactly as `contentSecurityPolicy()` derives it from the
built `platform-config.js` (as `scripts/serve.mjs` sends it: the Data API origin for a live build, none for a sandbox,
never Neon Auth), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-cache` and
`Strict-Transport-Security: max-age=31536000` (this host only: no `includeSubDomains` and no `preload`, which would
bind the commercial domain's other hosts and is hard to reverse). It reads nothing but the build, no environment
variable, and refuses a directory that is not exactly the build's files, a page or script that differs from the
sources (a stale build), a configuration or SDK bundle the build could not have written, a Data API URL on a Neon Auth
host, and an existing `_headers`, which it never overwrites. Same build, same bytes; it prints the file's SHA-256.
Netlify documents that custom headers apply only to files served from its own store and never to a function's
response, so the proxy's responses carry only the core's own headers and depend on nothing in `_headers`.
`scripts/build.mjs` refuses to rebuild into a `dist/` that holds `_headers`: remove `dist/` first.

### Environment variables (set on the site, never in `netlify.toml`)

| Variable | Read by | Value | Class |
| --- | --- | --- | --- |
| `POOL_PLATFORM_MODE` | build and functions | `live` (unset: a sandbox build, and the proxy answers 404) | public setting |
| `POOL_PLATFORM_DATA_URL` | build only | the commercial Data API URL | public; written into `platform-config.js` |
| `POOL_PLATFORM_DEFAULT_POOL_SLUG` | build only | the pilot pool slug | public; written into `platform-config.js` |
| `POOL_PLATFORM_AUTH_UPSTREAM_URL` | functions only | the Neon Auth base URL | server-only, not a secret, never in the browser |
| `POOL_PLATFORM_APP_ORIGIN` | functions only | the final `https://` origin | server-only, not a secret |

Never set: `POOL_PLATFORM_AUTH_URL` (retired; the build refuses it), `NODE_VERSION` (so `.nvmrc` alone selects Node
22), `AWS_LAMBDA_JS_RUNTIME` (so the functions run on the build's Node version), and any password, connection string,
API key, Neon management credential or Netlify credential: the design needs none. Netlify documents that variables
declared in `netlify.toml` never reach functions, that a function sees a variable only when its scope includes
Functions, and that a changed value takes effect only with a new deploy. Where scopes cannot be chosen, the build also
sees the server-only variables and ignores them, and the functions see the build's and ignore them.

### Deploy contexts and branches

Only a production deploy of `commercial-v1-netlify-adapter` builds. The `ignore` command in `netlify.toml` skips every
other context (`deploy-preview`, `branch-deploy`, `dev`) and every other branch, and the build command repeats the same
check and fails, because Netlify documents that an `ignore` command never cancels a build started by a build hook.
`main` is never a deployment source. It holds no `pool-platform/` at all, so for `main`, and for any branch without
this `netlify.toml`, only the site's own settings apply. Before any Git connection is used, the site therefore needs:
production branch `commercial-v1-netlify-adapter`, branch deploys off, deploy previews off, and no build hook.

### Account and site settings for the security spike (none made yet)

- The Netlify badge disabled in the account configuration, so nothing is added to the served pages.
- Web Analytics and Real User Metrics (RUM) off for the whole security spike, and no snippet injection.
- Pretty URLs off (also forced by `netlify.toml`).
- Access restricted to the operator with Firewall Traffic Rules, which the Free plan allows (two rules per ruleset,
  three IP addresses per rule).
- Code-based rate limiting as above: the Free plan's two rules.

### Stage A: Netlify unknowns that must be tested (none verified)

Netlify's edge and function runtime cannot be exercised locally. Stage A, the first approved hosting-spike stage,
records and checks each of these. A sandbox deploy (the proxy answers 404 to everything) shows the static-file and
routing checks; the checks of the proxy's own answers (1 to 5 and 7) need its server-only variables, set in their
own approved step, and any request that would reach Neon (as checks 3 and 5 need) is approved separately again. No
OTP is sent and no sign-in is made for any of them.

1. A function sees `Host` exactly as the browser sent it, the app host; otherwise the core answers 421 to everything.
2. **STOP condition: Cookie join.** The `Cookie` header a function receives joins several cookies, HTTP/2 cookie
   crumbs included, with `; `. If Netlify joins them in any other way (with `, `, say), STOP: the core reads cookies
   only as `;`-separated pairs. To show it, send the app cookie twice in two separate `Cookie` header lines (as the
   local server's test does): the answer must be 401, exactly as when both pairs share one line; `200 null` means the
   lines were joined some other way.
3. **STOP condition: upstream disclosure.** No response the browser receives carries `x-nf-fetch-timing`, or any
   other header or body, that discloses the Neon Auth upstream host or upstream timing. If one does, STOP.
4. Every proxy response carries exactly the core's headers (`Cache-Control: no-store`, the CSP
   `default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy`, nosniff, no-referrer) and no
   `Access-Control-*`; nothing from `_headers` is added to it, and Netlify's CDN never serves one from cache.
5. `Set-Cookie` lines from a function arrive unchanged: one line per cookie, every attribute as the core wrote it.
6. `/.netlify/functions/auth-otp` and `/.netlify/functions/auth-session` are not reachable, and requests on the OTP
   paths are served only by `auth-otp`.
7. `OPTIONS` on each route is the core's 405, never an answer from Netlify; what a `HEAD` request gets is recorded.
8. Every static file (`/`, the pages, `/vendor/neon-js.js`, and `/participant` without `.html`, which Netlify may
   serve as the page) carries the `_headers` values exactly once, with a single `Strict-Transport-Security` header,
   and the served bytes equal the recorded build hashes: no badge, snippet, analytics script or rewritten link.
9. Each rate limit answers 429 near its threshold, and that 429 carries no CORS grant.
10. The functions run on Node 22, and each function bundle holds only its file, the adapter, the core and the core's
    two modules.
11. What Netlify's request logs and observability record for a URL with a query string (see the invite issue below).

### Carried issues (unchanged by the Netlify adapter)

- **Invite-query observability: unresolved, must be settled before customers.** Invite links carry their token in
  the query string. Whether Netlify's request logs or observability features record query strings is not known.
- **Neon pre-registration takeover: HIGH, a customer blocker.** Not addressed here.
- Neon question I (how Email OTP limits are keyed) remains a hosting blocker.

## Configuration per environment

The build reads only `POOL_PLATFORM_MODE`, `POOL_PLATFORM_DATA_URL` and `POOL_PLATFORM_DEFAULT_POOL_SLUG`, and fails
closed on anything malformed (`scripts/runtime-config.mjs`). The functions read only the server-only variables above.

| Netlify context | Build (POOL_PLATFORM_*) | Functions (server-only) | Result |
| --- | --- | --- | --- |
| Production, `commercial-v1-netlify-adapter` | `MODE=live`, the commercial Data API URL, the pilot slug | `MODE=live`, the Auth upstream URL, the production origin | Live build and proxy |
| Production, first Stage A deploy | none | none | Sandbox build; the proxy answers 404 to everything |
| Deploy preview, branch deploy, any other branch | — | — | Not built (the deploy-context guard) |
| Development | none (local runs use `.env.local`, git-ignored) | none | Sandbox unless the operator builds and serves live locally |

A staging backend **and** staging origin would each need their own approval. The values are public, but they are
still set in the host's environment settings, never committed. No password, connection string, API key, Neon
management credential, Netlify credential or Vercel credential is ever a build variable.

## HTTP response headers (generated into `dist/_headers`, not in HTML)

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
  `sw-register.js`; file names carry no content hash, so the other files revalidate too. `_headers` sets it on every
  static file; Stage A confirms what is served rather than assuming Netlify's defaults.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Strict-Transport-Security:
  max-age=31536000` for the app host.
- Never `Service-Worker-Allowed`: the worker's scope stays the commercial root.

`scripts/serve.mjs` already sends the CSP, `nosniff`, `no-referrer` and `no-cache` locally and mounts the same proxy
core at `/api/auth`, so the localhost gate runs under the same policy and the same Auth path. On Netlify the same CSP
comes from `dist/_headers`, generated from the same build by the same `contentSecurityPolicy()`.

## Deployments, promotion and rollback

- One commit → one reproducible build. Record the commit SHA, the per-file SHA-256 list and the CSP that the build
  prints and the `_headers` SHA-256 that `scripts/netlify-headers.mjs` prints, and compare them with a local build of
  the same commit and variables before promoting.
- Each deployment is immutable. Promote the exact verified deployment to the production domain; never rebuild
  between verification and promotion. How Netlify's publishing is held until that verification is settled at Stage A.
- Rollback is promoting the previous recorded deployment. The service worker's cache is versioned
  (`pool-platform-commercial-vN`) and the configuration is never cached, so a rollback cannot leave a newer
  configuration pinned in browsers.
- Deployments are triggered by a Git connection whose only buildable source is a production deploy of
  `commercial-v1-netlify-adapter` (the deploy-context guard, above). `main` is not the Commercial V1 line and must
  not be the production branch.

## Order of the later hosting gate (each step separately approved)

1. Resolve, or settle by a controlled test, Neon questions I (the hosting blocker), H and K; record L, M and N.
2. Choose the final commercial domain.
3. Stage A: create the Netlify site with base directory `pool-platform`, production branch
   `commercial-v1-netlify-adapter`, branch deploys and deploy previews off, no build hook, the badge, Web Analytics and
   RUM off, and Firewall Traffic Rules limiting access to the operator. Deploy the sandbox first (no variables: the
   proxy answers 404) and run the **Stage A** checks in the order given there; a STOP condition ends the step.
4. Add the Data API CORS entry (and, if question H/K requires it, the Neon Auth trusted domain) for exactly the
   production origin.
5. Set the production build variables and the functions' server-only variables; deploy, verify hashes, headers,
   CSP, the rate limits and the proxy's refusals, then promote.
6. Repeat the browser and device matrix of `FRONTEND_INTEGRATION_RUNBOOK.md`, including its Auth proxy checks,
   against the hosted origin.
