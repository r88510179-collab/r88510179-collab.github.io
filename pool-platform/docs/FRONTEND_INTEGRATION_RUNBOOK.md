# Frontend integration runbook (next gate: localhost browser integration)

This runbook is for the **next** gate: the first controlled browser run of the commercial frontend against the live
Commercial Neon Auth and Data API, from an origin whose hostname is exactly `localhost`. It has **not** been
performed. Nothing below is verified in any browser against live Neon, and no row of the device matrix is verified.

The frontend-readiness phase that prepared it was code-only: it changed no Neon setting (trusted origins or domains,
`allow_localhost`, Data API CORS, schema, migrations, RLS, ACLs, functions, data) and configured no hosting.

**F-1 corrective (same-origin Auth proxy).** Since the corrective branch `commercial-v1-f1-auth-proxy-corrective`, the
browser never talks to the Neon Auth host: it calls four routes under `/api/auth` on its own origin, and the proxy
(`server/auth-proxy-core.mjs`, mounted by `scripts/serve.mjs`) forwards them (`docs/HOSTING_ARCHITECTURE.md`,
"Same-origin Neon Auth proxy"). The signed-in gate below waits for an independent review of the exact corrective SHA;
until then only the signed-out checks in "Auth proxy checks, before any code is sent" may be run.

## What the readiness phase provides

- `npm run build` (`scripts/build.mjs`) writes `pool-platform/dist/` from an explicit allow-list of 14 files, a
  generated `platform-config.js` and the bundled SDK in `vendor/neon-js.js`. Nothing else under `pool-platform/` and
  nothing outside it can reach `dist/`. A sandbox and a live build differ only in `platform-config.js`, and the same
  inputs always produce the same bytes. `dist/` is git-ignored.
- The browser's runtime configuration comes only from `POOL_PLATFORM_MODE`, `POOL_PLATFORM_DATA_URL` and
  `POOL_PLATFORM_DEFAULT_POOL_SLUG`. Without them the build is the synthetic sandbox. A live build fails before it
  writes anything unless the Data API URL is a canonical `https:` URL with no credentials, query string or fragment.
  It never names Neon Auth: the retired `POOL_PLATFORM_AUTH_URL` is refused. The tracked `platform-config.js` stays
  the sandbox and must never hold a live URL.
- The Auth proxy's configuration is server-only and read by `scripts/serve.mjs` from the environment:
  `POOL_PLATFORM_MODE=live` and `POOL_PLATFORM_AUTH_UPSTREAM_URL` (the Neon Auth base URL). Its app origin is the
  server's own `http://localhost:<port>`; `POOL_PLATFORM_APP_ORIGIN`, when set, must name exactly that. A live build
  without a valid proxy configuration is refused rather than served.
- The browser loads `@neondatabase/neon-js` **0.7.0-beta** from its own origin (`vendor/neon-js.js`), bundled from
  `package-lock.json` (the same SDK dependency tree as `validation/live/package-lock.json`). There is no CDN at runtime.
- The pages run under `script-src 'self'` and `style-src 'self'`: no inline script, no inline style.
- The service worker is registered from `sw-register.js` with scope `./`, caches only the allow-listed app shell
  (`pool-platform-commercial-v4`) and never stores or answers `platform-config.js`, Auth or Data API traffic,
  `Authorization`-bearing requests or query-string URLs (invites).
- `npm run serve` (`scripts/serve.mjs`) serves `dist/` at `http://localhost:4173/` only, with the production CSP, and
  for a live build mounts the Auth proxy at `/api/auth` (POST is accepted only there).

## Before the gate (read-only preconditions)

1. The exact candidate SHA has passed independent review, and the operator has its local suites green:

       cd pool-platform && npm ci && npm test
       POOL_PLATFORM_TEST_BROWSER=1 NODE_PATH="$(npm root -g)" node --test pool-platform/ui-contract.test.mjs

2. Commercial Neon only: project `fancy-brook-65396623`, branch `production`, database `neondb`. Never a personal
   project or the personal Pool Center database (`STEP2_RUNBOOK.md`, step 2).
3. Confirm, read-only, that Neon Auth accepts the proxy's upstream `Origin` `http://localhost:4173` (the localhost
   allowance) and that the Data API accepts browser requests from `http://localhost:4173`. Changing a trusted
   origin, trusted domain, `allow_localhost` or Data API CORS is outside this gate and needs its own approval. If
   localhost is not accepted, STOP and record it.
4. Synthetic identities and fixtures only (the pilot seed in `STEP2_RUNBOOK.md`): a commissioner account, at least one
   participant account owning two entries, a second participant account for wrong-account checks, and a mailbox for
   each that can receive Email OTP codes. Never a real customer.
5. Evidence rule: record outcomes, statuses, codes, timings and short fingerprints only. Never record an OTP code, a
   JWT, a cookie value, a session token or an invite token.

## Build a local live artifact without touching tracked files

Use shell variables or an untracked file. `pool-platform/.gitignore` ignores `.env` and `.env.*`, so a file such as
`pool-platform/.env.local` never reaches git:

    POOL_PLATFORM_MODE=live
    POOL_PLATFORM_DATA_URL=<Data API URL of the commercial branch, from the Neon console>
    POOL_PLATFORM_DEFAULT_POOL_SLUG=<synthetic pilot pool slug>
    POOL_PLATFORM_AUTH_UPSTREAM_URL=<Neon Auth URL of the commercial branch, from the Neon console>
    POOL_PLATFORM_APP_ORIGIN=http://localhost:4173

The build reads the first three; the server reads `POOL_PLATFORM_MODE` and the last two, which never reach the
browser. They are public endpoints, nothing else: never a password, a connection string, an API key, a Neon
management credential or a Vercel credential. Do not set `POOL_PLATFORM_AUTH_URL`: it is retired, and the build
refuses it. Build and check:

    cd pool-platform
    npm ci
    node --env-file=.env.local scripts/build.mjs
    git status --short        # must show nothing under dist/ and no .env file

The build prints the mode, the Data API URL, the default pool slug, a SHA-256 for each output file and the
Content-Security-Policy for this artifact (Auth is noted as the same-origin proxy). Record the hashes and the CSP with the gate evidence. The only file that
differs from a sandbox build of the same commit is `dist/platform-config.js`.

## Serve it at localhost

    node --env-file=.env.local scripts/serve.mjs      # add --port <n> for another port (and match POOL_PLATFORM_APP_ORIGIN)

Open exactly `http://localhost:4173/participant.html`, never `http://127.0.0.1:4173`. The server answers any other
`Host` with 421 and the URL to use, and listens on 127.0.0.1 and ::1 only. In the DevTools console confirm:

    location.hostname === 'localhost'
    location.origin === 'http://localhost:4173'

and that the mode pill reads `LIVE · secure`. The server log lists paths without query strings, so invite tokens
never appear in it; Auth proxy lines read `AUTH <method> <route> <status> [reason]` and never hold an email, code,
cookie or token. Every page response carries the build's CSP (`connect-src 'self' <Data API origin>`: no Neon Auth
origin), and the server prints `Auth: same-origin proxy at http://localhost:4173/api/auth/* (4 routes)`.

Port 4173 is also the default of some local preview servers: if another app used `http://localhost:4173` on this
browser profile, start from a fresh state (below) and keep this origin for this procedure only.

## Service worker: inspect, and start from a fresh state

Inspect (DevTools → Application → Service workers, or the console):

    const r = await navigator.serviceWorker.getRegistration();
    [r.scope, r.active?.scriptURL, r.updateViaCache]
    // ['http://localhost:4173/', 'http://localhost:4173/service-worker.js', 'none']
    await caches.keys()                      // ['pool-platform-commercial-v4']
    (await (await caches.open('pool-platform-commercial-v4')).keys()).map(q => q.url)

The cache must hold exactly the 14 app-shell URLs (`/`, the three pages, `styles.css`, `manifest.webmanifest`,
`sw-register.js` and the seven app modules) and never `platform-config.js`, `vendor/neon-js.js`, an `/api/auth` URL,
a Data API URL, or any URL with a query string.

Fresh state before each browser/profile run: DevTools → Application → Storage → **Clear site data** for
`http://localhost:4173`, or in the console:

    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    for (const key of await caches.keys()) if (key.startsWith('pool-platform-commercial-')) await caches.delete(key);

Then close every tab of the origin and reopen it. The session cookie is first-party on `localhost`
(`__Host-pool-platform-session`, path `/`); check DevTools → Application → Cookies for what remains, and sign out
first when a run needs no prior session. A cookie on a Neon Auth host, or a `__Secure-neon-auth.session_token` cookie
on `localhost`, is left over from before the proxy or an earlier build (the proxy never reads either); clear it.
Cookies are not isolated by port: serve nothing else on `localhost` during a run.

## Switch back to the sandbox without editing tracked files

Stop the server, then build with no `POOL_PLATFORM_*` variable set (a new shell, or `env -u` for each) and serve:

    env -u POOL_PLATFORM_MODE -u POOL_PLATFORM_DATA_URL -u POOL_PLATFORM_DEFAULT_POOL_SLUG -u POOL_PLATFORM_AUTH_UPSTREAM_URL -u POOL_PLATFORM_APP_ORIGIN npm run build
    npm run serve

Reload: the pill reads `SANDBOX · synthetic`. The service worker never stored the live configuration, so none can
linger; clear site data anyway before the next live run. `git status` stays clean throughout.

## Auth proxy checks, before any code is sent

Signed out, with the live build served as above. No OTP is requested and no sign-in is made. Record statuses and
booleans only.

1. `participant.html` and `commissioner.html` load; the pill reads `LIVE · secure`; the sign-in card shows.
2. `platform-config.js` holds no Neon Auth URL (`curl -s http://localhost:4173/platform-config.js`), and the page
   response's CSP `connect-src` is `'self'` plus the Data API origin only.
3. DevTools → Network while loading both pages: every request is to `http://localhost:4173`. The only Auth request is
   `GET /api/auth/get-session`, answered `200` with the body `null`, `Cache-Control: no-store` and no
   `Access-Control-*` header. No request goes to a `*.neonauth.*` host.
4. In the console, `await fetch('<Neon Auth URL>/get-session',{credentials:'include'}).catch(e=>'blocked')` returns
   `'blocked'`, and a `connect-src` CSP report names the Auth URL: the page cannot reach Neon Auth directly.
5. Refusals, from a terminal (none reaches Neon; each answer has no `Access-Control-*` header):
   - `curl -si -H 'Host: 127.0.0.1:4173' http://localhost:4173/api/auth/get-session` → 421;
   - `curl -si -H 'Sec-Fetch-Site: same-site' http://localhost:4173/api/auth/get-session` → 403, and `cross-site` → 403;
   - `curl -si -X POST -H 'Content-Type: application/json' -H 'Origin: http://localhost:4174' --data '{}' http://localhost:4173/api/auth/sign-out` → 403,
     and the same with `Origin: null`, or with no `Origin` → 403;
   - `curl -si -X OPTIONS -H 'Origin: https://cors-probe.invalid' http://localhost:4173/api/auth/get-session` → 405;
   - `curl -si -H 'Cookie: __Host-pool-platform-session=a; __Host-pool-platform-session=b' http://localhost:4173/api/auth/get-session`
     → 401 with no `Set-Cookie` (the session cookie twice is refused, and neither value is used);
   - a planted look-alike name with a leading NBSP byte (`0xA0`) is refused the same way, and never normalised into a
     session: `curl -si -H $'Cookie: \xa0__Host-pool-platform-session=planted' http://localhost:4173/api/auth/get-session`
     → 401 with no `Set-Cookie` and no upstream call (not `200 null`, which a signed-out request with no cookie gives);
   - `curl -si http://localhost:4173/api/auth/list-sessions` → 404; `curl -si -X PUT http://localhost:4173/api/auth/sign-out` → 405.
6. The service worker's cache holds no `/api/auth` URL (inspect as in "Service worker" above).
7. The server log shows only `AUTH <method> <route> <status> <reason>` lines for these, with no value from a request.

## The gate: controlled browser integration checklist

Only after an independent review of the exact corrective SHA, and with the operator's approval to send codes.
In addition to the sections below, record for the first sign-in:

- the app-host cookie `__Host-pool-platform-session` has `HttpOnly`, `Secure`, `SameSite=Strict`, path `/`, no
  `Domain` and no `Partitioned`; there is no `__Secure-neon-auth.session_token` cookie and no cookie for any Neon Auth
  host;
- the page-visible `GET /api/auth/get-session` JSON holds no opaque session token (compare, do not print: no
  `session.token` field, or only the JWT the SDK copies there from `set-auth-jwt`);
- the first RPC carries a bearer whose `sub` is the signed-in synthetic identity (sub only);
- from `http://localhost:4175` (same site) and `http://127.0.0.1:4174` (cross site), a credentialed
  `fetch('http://localhost:4173/api/auth/get-session')` fails (booleans only).

Run in order on Chromium desktop first. Stop at the first P0 (wrong identity, cross-tenant or cross-participant
data, an overwritten source lock, a secret in a URL or log) and record it.

### Participant

1. Email OTP send: enter the participant email, Send code; the code field appears, no error.
2. OTP verification: enter the code; the sign-in card disappears and Sign out shows in the shell.
3. Session creation: DevTools Network shows the Auth session response and the first Data API RPC carrying
   `Authorization: Bearer …` (record only that it is present).
4. Session persistence after reload: reload; still signed in, entries load without a new code.
5. Participant context: the pool name, week and deadline match the synthetic fixture.
6. Entry selection: with two owned entries, the Entry selector shows both; switching re-renders each entry's state.
7. Pick'em and Survivor rendering: both pool types render their forms (use `?pool=<slug>` for each fixture pool).
8. Safe synthetic validation submission: submit a complete Pick'em entry on a synthetic entry; `Revision 1`, the
   source notice says the participant channel claimed it.
9. Reload after submission: the saved picks reload; Update picks is offered while the week is open.
10. Source-lock UI: an entry the commissioner already imported shows the commissioner-channel notice and no submit.
11. Sign out: the shell returns to the sign-in card; nothing of the account remains on screen.
12. Reload after sign out: still signed out; no entry data flashes.

### Invites

1. The commissioner creates a synthetic invite for an unclaimed synthetic entry (with and without an email
   restriction); record the result, never the token.
2. The participant opens the invite link; the invite is claimed only after sign-in.
3. Email restriction: the wrong signed-in account sees "This invitation was issued to a different email address.",
   the link stays in the address bar and the invite is not consumed.
4. Successful claim with the invited account: the entry loads and the `invite=` parameter leaves the URL.
5. Reload after claim: the entry still loads; nothing is claimed twice.
6. Reopened, already-used invite: "expired, already used, or no longer available", and the account's own entry
   still loads.
7. Wrong-account behaviour: sign out, sign in as the invited account, claim succeeds.
8. Sign-out/account switch: nothing of the first account remains after switching.

### Commissioner

1. Email OTP sign-in to `commissioner.html?pool=<slug>`.
2. Session persistence across reload.
3. Commissioner context: the managed pool loads; an account that manages none sees "Commissioner access is required."
4. Season and week selection change the entry table.
5. Entry table: codes, claimed state and this week's source match the fixtures.
6. CSV client validation: an ambiguous code and a repeated entry are listed row by row and nothing is submitted.
7. Controlled synthetic import on synthetic entries: the summary counts match.
8. Participant-source conflict: an entry the participant submitted is reported as a source conflict, not overwritten.
9. Reload, then Sign out: nothing of the console remains.

### auth_required reliability (UI level)

The client contract (`PlatformClient.rpc()`): when an RPC's error body message is exactly `auth_required`, it waits
about 200 ms and sends the identical request once more (same URL, method, headers including the bearer token, body).
If that succeeds, the result is used; if it is `auth_required` again, the user sees
"Your sign-in could not be confirmed. Try again, or sign out and sign in again." (`SIGN_IN_NOT_CONFIRMED`) and there
is no third request. `platform-client.test.mjs` and the opt-in browser test
"live: an RPC answered auth_required is resent once…" already verify this locally against a stand-in Data API.

Live Neon cannot be made to answer `auth_required` on demand (it follows newly opened backend connections), so the
gate checks the UI with browser-network interception instead of touching the database. With Playwright against the
served build (a sketch; run it from an operator machine, never commit its output):

    // First POST to the RPC is answered locally with the database's own auth_required body; later ones reach Neon.
    let seen = 0; const requests = [];
    await context.route(`${DATA_URL}/rpc/pool_platform_participant_context`, async route => {
      const r = route.request();
      requests.push({ at: Date.now(), method: r.method(), url: r.url(), headers: r.headers(), body: r.postData() });
      if (seen++ === 0) return route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ code: 'P0001', details: null, hint: null, message: 'auth_required' }) });
      return route.continue();
    });

Check: exactly two requests, about 200 ms apart, identical method, URL, headers and body (compare, do not print, the
`authorization` value), and the entry renders from the second. Then fulfil every request with `auth_required`:
exactly two requests, the sign-in message above, and no third request. The intercepted first request never reaches
Neon; use a read-only RPC (`pool_platform_participant_context` or `pool_platform_commissioner_context`), and only a
synthetic entry if `pool_platform_submit_entry` is exercised this way. Do not weaken or replace the unit or live-security
contracts; this is an additional UI-level check.

### Service worker

1. Registration URL `http://localhost:4173/service-worker.js`, scope `http://localhost:4173/`.
2. Cache names: only `pool-platform-commercial-v4`.
3. `platform-config.js` is never in the cache, before or after pages load (inspect as above).
4. No Auth or Data API URL is cached; DevTools Network shows those requests with no "(ServiceWorker)" source.
5. Refresh and hard reload (Shift+Reload bypasses the worker) both load the current build.
6. Offline static fallback: DevTools → Network → Offline, reload `participant.html`: the cached page loads, the pill
   reads `UNAVAILABLE` and the page says "This page could not load its configuration. Check your connection, then
   reload."; nothing from a previous session or the sandbox is shown. (The Chromium opt-in test covers this locally.)
7. Recovery: back online, reload; the page returns to the signed-in state.

### Content-Security-Policy

With the build's CSP header in force (served by `scripts/serve.mjs`), record every console CSP report. The only one
expected is `script-src` refusing `eval` from `vendor/neon-js.js`: zod's `allowsEval` feature probe
(`try { new F(""); } catch { return false; }`), after which zod stays on its non-eval path. Anything else is a finding.
Never add `'unsafe-eval'` or `'unsafe-inline'` to silence a report.

## Browser and device matrix (none verified)

| Target | Status | Scope |
| --- | --- | --- |
| A. Chromium desktop (Chrome or Edge) | NOT VERIFIED | Full participant, commissioner and invite sections; reload/session; service worker; the `auth_required` interception; CSP reports |
| B. Android Chrome | NOT VERIFIED | Participant OTP, session persistence, reload, submission, sign out, service worker/PWA behaviour |
| C. Safari / WebKit | NOT VERIFIED | OTP, cookie/session persistence, reload, sign out, invite flow, cookie attributes |
| Firefox desktop (optional) | NOT VERIFIED | Participant sign-in, reload, submission, sign out |

**A. Chromium desktop.** As above. Also emulate 320, 360 and 412 CSS px for the participant page.

**B. Android Chrome.** A real device reaches the operator machine as `localhost` through USB debugging:
`adb reverse tcp:4173 tcp:4173`, then open `http://localhost:4173/participant.html` in Chrome on the device and
inspect it from `chrome://inspect`. Check OTP, reload persistence, a synthetic submission, sign out, the worker's scope
and caches, and the offline fallback. `manifest.webmanifest` has no icons yet, so Chrome's install prompt is not
expected; record what Chrome offers.

**C. Safari / WebKit.** Safari on macOS at `http://localhost:4173` and Safari in the iOS Simulator (which shares the
Mac's `localhost`). A physical iPhone cannot reach the operator machine as `localhost`, so its live sign-in waits for
the hosted origin. The session cookie is first-party on the app host (`__Host-pool-platform-session`: `Secure;
HttpOnly; SameSite=Strict`, path `/`), but the page is plain `http://localhost` here: record whether Safari keeps a
`Secure` (`__Host-`) cookie on it, and whether the session survives a reload and a new tab. If it does not, record it
as a finding (local https is a separate, unapproved option); do not change Neon settings in the gate.

**Firefox (optional).** Sign in, reload, submit, sign out; record any CSP report.

## Known characteristics to watch

- The bundled SDK is shipped unminified (about 885 KB, about 160 KB gzip) so it stays readable; it loads only in live mode.
- The one CSP report above comes from zod inside the SDK; it is benign and expected.
- Offline, a page shows the "could not load its configuration" message instead of the app: the configuration is
  never cached, by design.
- Sessions are a first-party cookie on the app host, set by the same-origin Auth proxy; browsers hold no cookie for
  the Neon Auth host. On `http://localhost`, Chromium accepts the `__Host-` session cookie (the opt-in Chromium suite
  in `ui-contract.test.mjs` signs in through the proxy and checks it); whether Firefox and Safari keep a `__Host-`
  cookie there is not verified, and Safari is the main unknown. An already-issued JWT stays valid at the Data API
  until it expires (up to about 15 minutes).
