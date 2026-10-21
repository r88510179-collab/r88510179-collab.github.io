# Opening customer access: procedure (NOT EXECUTABLE)

**This procedure authorizes nothing and changes nothing.** It describes how a later, separately authorized step would
move the Commercial V1 site from operator-only access to its first customer, and how to undo that. No Netlify setting,
Firewall Traffic Rule, deploy, Neon setting or CORS entry has been changed in preparing it. Every step marked
**[ACTION]** needs its own written authorization naming the exact values it uses.

Evidence tags used below:

- **[VERIFIED]** shown by code and an offline test in this repository (file and test cited).
- **[RECORDED]** stated in a repository document as having happened; not re-verified here.
- **[OPERATOR]** a decision the operator makes and records; nothing here makes it.
- **[UNVERIFIED]** configuration or vendor behaviour that nobody has shown; it must be observed, not assumed.

## 0. Where things stand, as the repository records it

- Stage B (signed-in validation on production) is unauthorized until its prerequisites hold
  (`PRE_REGISTRATION_HARDENING.md:1235-1264`). P1 is deferred, which keeps Stage B blocked (`:793`) **[RECORDED]**.
- The pre-registration takeover (Races A and B) blocks customer launch until N0, migration 004, the identity audit and
  Gate W complete, and N1 as well for Race A (`PRE_REGISTRATION_HARDENING.md:340-341`, `:356-357`) **[RECORDED]**.
- Neon question I (Email OTP rate-limit keying) is a hosting blocker (`HOSTING_ARCHITECTURE.md:128-131`, `:301`);
  `NEON_QUESTION_I_PROTOCOL.md` is the plan to answer it **[RECORDED]**.
- The production branch is recorded at `48e0ac4` with Netlify Auto Publishing Locked, as a condition of the rollout
  window (`PRE_REGISTRATION_HARDENING.md:982`) **[RECORDED]**. `HOSTING_ARCHITECTURE.md` both says no Netlify action has
  occurred (`:3-7`) and refers to "the deployed `d23448b3`" and Stage A results (`:294-298`). With publishing locked the
  branch head and the published deploy can differ, so **which commit is published now is not known from the
  repository** **[UNVERIFIED]**; section 3 identifies it directly.
- Access is restricted to the operator by Firewall Traffic Rules (`HOSTING_ARCHITECTURE.md:256-257`, Free plan: two
  rules per ruleset, three addresses per rule) **[RECORDED as intended]**. Whether those rules also gate the function
  paths under `/api/auth`, and not only static files, is **[UNVERIFIED]**: section 2 checks it.
- What the firewall never covered: the browser calls the Data API on its own Neon origin
  (`platform-client.js:87`, the build's CSP `connect-src`) and Neon Auth through the proxy, but both Neon hosts are
  public endpoints outside Netlify. Operator-only access at Netlify has therefore never been the data-access control;
  that is Neon Auth plus the database's authorization and RLS **[VERIFIED: architecture, `scripts/runtime-config.mjs`
  `contentSecurityPolicy`]**.

## 1. Gates: all PASS and recorded before any [ACTION] in section 5

| Gate | PASS means | Source |
| --- | --- | --- |
| G1 Pre-registration hardening | the rollout window completed through step 9, Gate W passed, and N1/N2 applied after P1 passed | `PRE_REGISTRATION_HARDENING.md:1105`, `:1139`, `:340-341`, `:793` |
| G2 Stage B | Stage B ran under its own authorization after all its prerequisites, and its results are recorded with no P0/P1 open | `PRE_REGISTRATION_HARDENING.md:1235-1264`; `FRONTEND_INTEGRATION_RUNBOOK.md:180-181` |
| G3 Neon question I | answered by Neon in writing or by the protocol, with the operator's recorded decision on the finding | `NEON_QUESTION_I_PROTOCOL.md` |
| G4 Neon questions H and K | settled, so the production origin's Neon Auth and Data API settings are known | `HOSTING_ARCHITECTURE.md:126-132`, `:408` |
| G5 Go-live gate | every item of the Step 2 go-live gate holds, including the browser/device matrix | `STEP2_RUNBOOK.md:308-320` |
| G6 Offline suites | `npm test` with the browser opt-in passes on the exact commit to be published, after `npm ci` | `STAGE_B_ACCEPTANCE.md` |
| G7 Final origin | section 2 decided and recorded | below |
| G8 Deploy identity | section 3 recorded, and the published deploy is the authorized one | below |
| G9 Rollback ready | section 7's restore point recorded, and the previous good deploy identified | below |

If any gate is not PASS, stop: nothing below proceeds.

## 2. The final production origin **[OPERATOR]**

Decide and record one origin, exactly, before any Neon production-origin change (`HOSTING_ARCHITECTURE.md:32-35`).
Constraints the code already enforces **[VERIFIED]**:

- `POOL_PLATFORM_APP_ORIGIN` must be exactly an origin: `https:`, lowercase host, no path, no trailing slash, no default
  port; anything else disables the proxy (`server/auth-proxy-core.mjs:107-128`; `auth-proxy-core.test.mjs`, "configuration
  fails closed").
- The browser's session cookie is `__Host-pool-platform-session`, which needs HTTPS, no `Domain` and `Path=/`, and the
  host must serve nothing else on any port (`HOSTING_ARCHITECTURE.md:60-83`).
- `_headers` sends `Strict-Transport-Security: max-age=31536000` for that host only, without `includeSubDomains` or
  `preload` (`scripts/netlify-headers.mjs`; `netlify-hosting.test.mjs`).
- `*.netlify.app` hostnames are not used for live sign-in unless separately approved (`HOSTING_ARCHITECTURE.md:34-35`).

Record: the origin; who controls its DNS; that no other app is or will be served on that host; and, from a network
**not** on the operator allow-list while the firewall is still operator-only, that both a page and
`/api/auth/get-session` are refused at the edge. If the function path is not refused, record that the firewall does not
cover functions: the proxy is then reachable by anyone while "operator-only" (its refusals still apply), and that
changes what section 7 can restore.

## 3. The exact authorized deploy

Only a production deploy of `commercial-v1-netlify-adapter` can build; every other branch and context is skipped or
refused (`netlify.toml:10`, `:16`; `netlify-hosting.test.mjs`, "the deploy-context guard") **[VERIFIED]**. Work done on
any other branch, this candidate's included, reaches production only after review and a merge into that branch, which
is outside this procedure.

The authorization for opening names, and the operator records **[OPERATOR]**:

1. The full 40-character commit SHA, on `commercial-v1-netlify-adapter`, and the Netlify deploy ID built from it.
2. The public build values: `POOL_PLATFORM_MODE=live`, the Data API URL, the default (pilot) pool slug; and the
   function values: `POOL_PLATFORM_MODE=live`, the Neon Auth upstream URL's host, `POOL_PLATFORM_APP_ORIGIN` (section 2).
   Never a credential: the design needs none (`HOSTING_ARCHITECTURE.md:225-240`).
3. The per-file SHA-256 list and the CSP that `scripts/build.mjs` prints, and the `_headers` SHA-256 that
   `scripts/netlify-headers.mjs` prints (`HOSTING_ARCHITECTURE.md:394-396`).

Then, before opening:

- A local build of the same commit with the same public build values reproduces those hashes and that CSP, byte for
  byte (`HOSTING_ARCHITECTURE.md:394-396`; `frontend-readiness.test.mjs`, "a real build is reproducible, and sandbox and
  live builds differ only in platform-config.js") **[VERIFIED for the local build]**.
- Each static file served by the origin hashes to the recorded value, and carries the `_headers` values exactly once
  (Stage A check 8, `HOSTING_ARCHITECTURE.md:283-285`) **[ACTION: read-only requests to the origin]**.
- The published deploy is that deploy ID, and Auto Publishing stays Locked until section 6 ends, so no other commit can
  publish mid-opening **[ACTION: read the Netlify setting]**.

## 4. Origin, CORS and Auth proxy consistency (read-only checks)

Each must hold; any mismatch is a STOP.

| Check | Expected | Basis |
| --- | --- | --- |
| Served `platform-config.js` | `mode:'live'`, the recorded Data API URL and pilot slug, nothing else | `scripts/runtime-config.mjs` `serializeRuntimeConfig` **[VERIFIED shape]** |
| Page CSP `connect-src` | `'self'` plus exactly the Data API origin; no Neon Auth host | `contentSecurityPolicy`; `netlify-headers.mjs` refuses a `neonauth` host **[VERIFIED]** |
| Data API CORS | exactly the section 2 origin, no wildcard | `HOSTING_ARCHITECTURE.md:32-35`, `:414-415` **[UNVERIFIED: read it in Neon]** |
| Neon Auth trusted domain | as G4 settled (only if required) | `HOSTING_ARCHITECTURE.md:126-132` **[UNVERIFIED]** |
| `POOL_PLATFORM_APP_ORIGIN` | equals the origin the browser shows (`location.origin`) | `auth-proxy-core.mjs:301-302` (POST `Origin` must equal it) **[VERIFIED behaviour]** |
| Signed-out `GET /api/auth/get-session` | `200` with body `null`, answered by the proxy without calling Neon | `auth-proxy-core.mjs:330` **[VERIFIED]** |

The last row is the misconfiguration trap: if the function variables are missing or malformed, the proxy is disabled
and answers `404` to everything while the live pages still load (`auth-proxy-core.mjs:119-129`, `:290`) **[VERIFIED]**.
A `404` there is a STOP, never something to work around.

### Auth proxy refusals against the production origin

The same checks as the localhost gate (`FRONTEND_INTEGRATION_RUNBOOK.md:151-162`), against the production origin, from
the operator's allow-listed address. None of them reaches Neon: each is refused before any upstream call
(`auth-proxy-core.mjs:290-324`) **[VERIFIED in `auth-proxy-core.test.mjs` and `netlify-adapter.test.mjs`]**; on Netlify
they are **[UNVERIFIED]** until observed. Every answer has no `Access-Control-*` header and has `Cache-Control: no-store`.

| Request | Expected |
| --- | --- |
| any route with a `Host` other than the origin's host | `421` |
| `Sec-Fetch-Site: cross-site` or `same-site` | `403` |
| `POST /api/auth/sign-out` with a foreign `Origin`, `Origin: null`, or none | `403` |
| `OPTIONS` on any route | `405` |
| the app cookie twice, or a non-breaking-space look-alike beside it | `401`, no `Set-Cookie` |
| `GET /api/auth/list-sessions` | `404` |
| `PUT /api/auth/sign-out` | `405` |
| `/.netlify/functions/auth-otp`, `/.netlify/functions/auth-session` | not the proxy (Stage A check 6) |

No OTP is sent and nobody signs in for these checks.

## 5. Controlled first-customer opening **[ACTION]**

The Free plan's rules cannot list participants' addresses (phones change networks, and a rule holds three addresses,
`HOSTING_ARCHITECTURE.md:256-257`). "Controlled" therefore means controlling **who is invited**, not who can load the
page. How far to open is an **[OPERATOR]** decision between:

- **A. Commissioner first.** Add the first customer's commissioner's address(es) to the allow rule, keep everyone else
  out, and let the commissioner sign in, check the console and create invitations without sending them. Proves the
  commissioner path on production with the least exposure; participants cannot join yet.
- **B. Open the origin.** Remove the operator-only restriction. Anyone can load the pages and reach the proxy (still
  rate-limited at the edge, `netlify/functions/auth-otp.mjs`), and only invited accounts can read or submit anything.

Either way:

1. Record the current Firewall Traffic Rules exactly, as the restore point (section 7).
2. The operator is present for the whole opening, with the monitoring in section 6 open.
3. One customer, one pool. No invitation for any other customer exists or is created.
4. Right after the change, from a network not on the allow-list (for B; the commissioner's for A): the pages load, the
   pill reads `LIVE · secure`, signed-out `get-session` is `200 null`, the CSP header is the recorded one, and the console
   shows no CSP report other than the documented `eval` probe from `vendor/neon-js.js`
   (`FRONTEND_INTEGRATION_RUNBOOK.md:279-282`).
5. The commissioner signs in and loads the console. Invitations are created email-bound where possible (the console
   supports it), so a forwarded link cannot be claimed by another account (`STEP2_RUNBOOK.md:204`); an invitation
   without an email restriction stays a bearer link (`:206`).
6. For B: invitations are sent to that pool's participants only. Watch the first claims and the first submissions
   arrive, and the console's "This week" column update.

## 6. Monitoring during and after the opening

- Netlify function logs: one JSON line per Auth request with route, method, status, duration and a fixed reason
  (`HOSTING_ARCHITECTURE.md:205-207`). Watch the share of `429` (rate limits: question I's symptom), `502` (Neon
  unreachable or misbehaving), `401` `cookie-conflict`, `421` and `403`. These logs hold no email, OTP, cookie, token or
  invite token by design **[VERIFIED: `auth-proxy-core.test.mjs`, "the log never holds an OTP, email, body, cookie,
  session token, JWT or Authorization value"]**.
- Reports from participants of "Your sign-in could not be confirmed" (two `auth_required` in a row,
  `platform-client.js:11`) or of codes that never arrive.
- Neon-side logs and metrics for the Data API and Auth: what is available is **[UNVERIFIED]** (NOT IN REPO).
- Netlify Observability records request URLs with query strings (`HOSTING_ARCHITECTURE.md:294-298`): any `invite=` in a
  recorded query means an old-format link is in use (section 8).

## 7. Immediate rollback criteria

Any one of these restores operator-only access at once (section 8), then is investigated:

1. Any P0 of the localhost gate: a wrong identity, cross-tenant or cross-participant data, an overwritten source lock,
   or a secret in a URL or log (`FRONTEND_INTEGRATION_RUNBOOK.md:180-181`).
2. An invite token anywhere but a claim request body: in a URL, a log, Observability, a header.
3. The proxy answering `404` to everything, sustained `502`, or `421`/`403` for ordinary use.
4. Sign-in refusals (`429`) hitting more than one participant in the same minutes: question I's shared-bucket symptom.
5. Served bytes, headers or CSP that differ from section 3's record, or a published deploy other than the authorized one.
6. Any CSP report other than the documented one.
7. A participant shown a confirmation for picks the database does not hold, or the reverse (the defects fixed in
   `STAGE_B_ACCEPTANCE.md` are exactly this class).

## 8. Restoring operator-only access

1. **[ACTION]** Re-apply the Firewall Traffic Rules recorded in section 5 step 1, exactly.
2. From a network not on the allow-list, confirm that a page and `/api/auth/get-session` are refused; from the operator's
   address, that both work. If section 2 found the firewall does not gate functions, the proxy stays reachable: record it.
3. What re-closing the origin does **not** do: sessions already issued stay valid until they expire, and an issued JWT
   stays valid at the Data API, which is not behind Netlify, for up to about 15 minutes (`HOSTING_ARCHITECTURE.md:145-146`).
   For a security P0, revoking sessions is a separate, separately authorized Neon procedure
   (`PRE_REGISTRATION_HARDENING.md`, rollout window step 5), not part of this one.
4. For a code defect, roll back by promoting the previous recorded deployment; never rebuild between verification and
   promotion. The service worker's cache is versioned and the configuration is never cached, so a rollback cannot leave
   a newer configuration pinned in browsers (`HOSTING_ARCHITECTURE.md:397-401`) **[VERIFIED: `ui-contract.test.mjs`
   service worker tests]**.
5. Old-format (`?invite=`) links, if any were issued, stay claimable until claimed or expired (168 hours); revoking one
   needs a database action that has no reviewed workflow yet (`HOSTING_ARCHITECTURE.md:340-343`).
6. Record what happened, then return to section 1: reopening is a new authorization.

## What this procedure does not do

It does not decide the origin, approve a deploy, change a firewall rule, configure CORS or a trusted domain, contact
Neon, answer question I, run Stage B, onboard a customer, or merge anything. Each is its own step.
