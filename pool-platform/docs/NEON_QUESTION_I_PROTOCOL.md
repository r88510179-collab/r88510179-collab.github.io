# Neon question I: future evidence-collection protocol (not executed, not authorized)

**Status: a plan only.** Nothing in this document has been run. No request has been sent to Neon, no OTP has been
requested or delivered, no branch or project has been created, and question I is **unanswered**. Each step that would
reach Neon needs its own written authorization (see **Authorizations**). Running any part of it under this document
alone is out of order.

## The question

From `HOSTING_ARCHITECTURE.md:128-131`, verbatim:

> **I. HOSTING BLOCKER.** How Email OTP send/verify limits are keyed. Server-to-server calls from the function come from
> shared egress IPs, and Better Auth keys its IP limiter on `x-forwarded-for`. If Neon keys OTP limits by source IP and
> ignores a forwarded client IP, every user of the app shares one bucket (Better Auth's default is 3 per 60 s). This
> must be answered by Neon or measured in a controlled test before the proxy is relied on in hosting.

It splits into four answerable parts. The protocol is done when each has a recorded answer or is recorded as
inconclusive:

| Part | What must be known | Why it matters here |
| --- | --- | --- |
| I-1 | The key of the limit on `POST <auth>/email-otp/send-verification-otp`: the caller's source IP, a forwarded-IP header, the email, a combination, or one bucket for everyone | The proxy calls Neon from the hosting provider's function egress, never forwards a client IP (`HOSTING_ARCHITECTURE.md:122`) and sends only `accept`, `content-type`, `user-agent`, `origin` and the session cookie (`:93-94`). If the key is the source IP, every participant shares the egress address's bucket. |
| I-2 | The same for `POST <auth>/sign-in/email-otp` (verify) | A shared verify bucket would refuse correct codes from unrelated users. |
| I-3 | The window, the maximum, and the refusal's shape (status, body, any retry header) | The page shows the refusal's `message` (`docs/STAGE_B_ACCEPTANCE.md`, sign-in tests); capacity planning for the first customers needs the numbers. |
| I-4 | Whether the bucket is per path, per Neon Auth instance or branch, and whether its state is consistent across Neon's servers | Decides whether a test on a branch says anything about production, and whether results are reproducible. |

## What the repository already shows (library evidence only, not Neon's)

The pinned SDK tree carries `better-auth` 1.6.23. Its own rate limiter, read in `pool-platform/node_modules` after
`npm ci`, behaves like this. **Hosted Neon Auth is documented as Better Auth 1.4.18 with a configuration nobody here can
read (question N, `HOSTING_ARCHITECTURE.md:141-142`), so none of this answers question I.** It only says which
hypotheses the measurement must tell apart.

- Key: `` `${ip}|${path}` `` (`better-auth/dist/api/rate-limiter/index.mjs:287`). The email is not part of it.
- IP: taken from `x-forwarded-for` only, by default (`@better-auth/core/dist/utils/ip.mjs`, `DEFAULT_IP_HEADERS`), and
  only when the header holds exactly one address unless trusted proxies are configured. With no usable address the
  library logs that it is "falling back to a single shared per-path bucket" and uses the key `no-trusted-ip|<path>`
  (`rate-limiter/index.mjs:275`, `:281-287`).
- Limits: the Email OTP plugin sets 3 requests per 60 s on both routes above unless configured otherwise
  (`better-auth/dist/plugins/email-otp/index.mjs:75-102`).
- Refusal: `429` with body `{"message":"Too many requests. Please try again later."}` and an `X-Retry-After` header
  (`rate-limiter/index.mjs:65-70`). The proxy passes a Neon 4xx on with its status and only `code` and `message`
  (`server/auth-proxy-core.mjs:380-383`), so the browser never sees the retry header.
- Storage: in-process memory unless a secondary storage is configured (`better-auth/dist/context/create-context.mjs:174`),
  so several servers would each keep their own counts.

Hypotheses this leaves open for hosted Neon:

| Hypothesis | Prediction in the matrix below |
| --- | --- |
| HIP: per source IP (as Neon's ingress sees it) and path | another email from the same IP is refused; the same email from another IP is allowed |
| HEM: per email (Neon customized the key) | another email from the same IP is allowed; the same email from another IP is refused |
| HBOTH: per IP and email together | both of those are allowed |
| HONE: one bucket per path (no client IP resolved, for example a forwarded header with more than one hop) | everything is refused once the bucket is full, from any IP and for any email |
| HSPLIT: per-server memory | the same cell gives different answers on repeated runs |

## Where to run it (an operator decision)

Never production. Two options, each with a cost; the choice and its reason are recorded before anything runs.

1. **A disposable Neon child branch of production.** It reproduces production's Neon Auth configuration as far as a
   child copies it, and it carries the child's known exposure: production's users, sessions and signing keys, private
   halves included, until it is deleted; it is a second host that may mint JWTs production accepts
   (`PRE_REGISTRATION_HARDENING.md:461-477`, `:1222-1224`). The hardening plan's K1 to K4 govern only its P0 child; any
   other production-derived branch first needs **a separate security assessment of the state it copies (sessions,
   signing keys, N0, 004, and the revocation and waiting gates that state would need again), reviewed before the branch
   is created** (`:1230-1233`); without it the branch is an unsafe order (`:1205`). Timing matters too: a branch made
   before the rollout window makes the window's precondition 6 false (`:986-987`), so the window would need its own
   re-assessment, and one made after the window must have passed that review or it breaks Stage B prerequisite 8
   (`:1263-1264`). If chosen, it is also run like the P0 child: operator-run, K1 to K4 recorded, schema fingerprint
   equal to production's, no credential or session crossing between branches, deleted in the same session
   (`:457-498`).
2. **A separate throwaway Neon project** with Neon Auth enabled and nothing copied from production. It carries no
   production data or keys and is outside those branch rules, but it measures Neon's defaults only: whether
   production's Auth configuration differs from a new project's is not known (NOT IN REPO), so a result transfers to
   production only if Neon confirms the configuration is the same.

Unless the operator records a reason that option 1's assessment is worth its cost, option 2 is the default.

Whether a branch's limiter state is shared with production's, or with any other Neon tenant, is itself unknown (I-4).
That is why the request budget below stays at the smallest number that can trip one bucket, and why the run happens
**before any customer is invited**: the go-live gate admits no real customer until it passes (`STEP2_RUNBOOK.md:308-320`),
so a bucket the test fills could at worst delay the operator's own sign-ins. The run is scheduled when the operator is
not relying on signing in, and stops at the first refusal of each cell.

## Ask Neon first (no traffic)

A written answer from Neon support or documentation that names the hosted version and states I-1 to I-4 settles the
question without any request. Record the answer verbatim with its date and source. Disclosing project or branch
identifiers in a support request is the operator's decision. A vague answer ("limits are per user") is not enough: it
must name the key for each route. If Neon answers I-1 and I-2 completely, run only cell V0 and S0 below to confirm the
numbers, or nothing, at the operator's choice.

## The smallest safe matrix

Two operator-controlled source addresses, `A` and `B` (for example a home connection and a mobile hotspot), each
confirmed distinct by the operator before the run. Synthetic addresses on the reserved `example.com` domain, which
receives no mail (`PRE_REGISTRATION_HARDENING.md:1116`), in the live harness's `pp-cv1-<tag>-*@example.com` form
(`validation/live/README.md:11-12`): `X`, `Y`, `Z`, each used only in this run. No real mailbox, no real person's
address, no identity copied from production. Requests go **directly** from `A` or `B` to the test branch's Neon Auth
URL, not through Netlify or any proxy, so no other limiter (Netlify's 10 per 180 s per client IP,
`netlify/functions/auth-otp.mjs:12-15`) is in the path.

Every request carries the same fixed headers (`content-type: application/json`, `accept: application/json`, a fixed
`user-agent`, and the `origin` the test branch accepts, recorded beforehand). Nothing else.

### Verify route first: it sends no email

A verify request with a wrong code for an address with no pending code sends no mail, and in the pinned library the
limiter counts the request before the route runs (`better-auth/dist/api/index.mjs:168-169`, in `onRequest`). Whether
hosted Neon does the same is part of what V0 shows: if wrong-code verifies are never limited, the verify matrix is
inconclusive and only the send matrix can answer I-1. Each cell is one request unless stated; `N` is the threshold found in
V0.

| Cell | From | Request | Purpose |
| --- | --- | --- | --- |
| V0 | A | `verify` for `X` with code `000000`, repeated until the first `429` or 6 requests, all within 30 s | finds `N` and the refusal shape (I-3); no `429` by 6 means the route's limit is above 6 here or absent: stop the verify matrix, record a lower bound |
| V1 | A | `verify` for `Y`, at once after V0's first `429` | same IP, other email |
| V2 | B | `verify` for `X`, at once | other IP, same email |
| V3 | B | `verify` for `Z`, at once | other IP, other email: separates HONE |
| V4 | A | after the recorded window has passed with no requests, V0 to V3 again once | repeatability (HSPLIT) |

### Send route: only if the verify matrix was conclusive, or Neon says the routes differ

Each allowed send makes Neon email a code to a reserved address that receives nothing. Budget: at most `N + 3` sends.

| Cell | From | Request |
| --- | --- | --- |
| S0 | A | `send` for `X`, repeated until the first `429` (at most `N + 1`) |
| S1 | A | `send` for `Y`, at once |
| S2 | B | `send` for `X`, at once |

S3 (`Z` from `B`) is added only if S1 and S2 were both refused.

### Optional cell, separately authorized: a client-supplied forwarded address

Only if the operator wants to know whether a caller can choose its own bucket (a security property of Neon, not of this
app, which never forwards a client IP). From `A`, after V0 tripped, one `verify` for `X` carrying
`x-forwarded-for: 203.0.113.7` (a documentation-only address, RFC 5737). Allowed means Neon trusts a caller's forwarded
header for keying; refused means it does not. Sending a spoofed header to a vendor endpoint needs its own explicit
authorization even on a throwaway project.

## Reading the result

| V1 (same IP, other email) | V2 (other IP, same email) | V3 | Finding |
| --- | --- | --- | --- |
| refused | allowed | allowed | **HIP**: keyed by source IP. With the hosting provider's shared egress, all users share one bucket. The blocker stands. |
| allowed | refused | allowed | **HEM**: keyed by email. Shared egress does not merge users' buckets. |
| allowed | allowed | allowed | **HBOTH**, or the window ended between cells (check the timestamps) |
| refused | refused | refused | **HONE**: one bucket for everyone. Worst case; the blocker stands. |
| any other combination, or V4 differs from V0 to V3 | | | **Inconclusive** (possibly HSPLIT) |

What each finding means for hosting is a decision for the operator and is not taken here. HIP or HONE leave question I a
blocker: the options recorded so far are a per-email limiter in the proxy, which needs a shared store and its own
approval (`HOSTING_ARCHITECTURE.md:121-122`), or a change on Neon's side. HEM or HBOTH would clear the shared-egress
concern; the per-IP abuse limit at the edge then remains Netlify's (`auth-otp.mjs`). Whatever the outcome, which egress
addresses Netlify functions actually use (one, few, or changing per invocation) is not known (NOT IN REPO) and would
need its own observation after hosting.

## What counts as inconclusive

Record INCONCLUSIVE, never a guess, when any of these holds:

- no `429` within the cap (only a lower bound is known);
- any `5xx`, timeout, connection failure, or a `403` or other refusal that is not the rate limit (for example an origin
  refusal, question H): that cell's outcome is not about the limiter;
- a cell ran after the recorded window could have reset (timestamps decide; cells V1 to V3 must start within 5 s of
  V0's first `429`);
- `A` and `B` could not be confirmed as distinct addresses as Neon sees them;
- V4 disagrees with V0 to V3;
- a vendor answer that does not name the key per route, or names a version other than the one hosted.

A `429` that arrives without the body shape above is still a refusal; record its body as seen.

## Recording

Per request: cell, source label (`A`/`B`), address label (`X`/`Y`/`Z`), route, UTC time to the millisecond, status,
the body's `code` and `message`, and any `retry` header. Never record an address, an OTP, a cookie, a token, the test
branch's credentials or the source IP addresses themselves; labels only. The record follows the evidence rule of
`FRONTEND_INTEGRATION_RUNBOOK.md:56-57` and the secrets rules of `PRE_REGISTRATION_HARDENING.md:465-469`. Stop at the
first unexpected result and record it: no automatic retries, no extra requests to "make sure".

## Authorizations (each separate and written)

1. Choosing where to run (child branch or throwaway project), and creating it. For a child branch, the reviewed
   security assessment of `PRE_REGISTRATION_HARDENING.md:1230-1233` comes first, with its effect on the rollout window
   and Stage B recorded.
2. Every request to that Neon Auth endpoint, with the cell list and the request budget above.
3. Sending any OTP (the S cells), even to a reserved address.
4. The optional forwarded-header cell.
5. Deleting the branch or project, and recording that (K4 for a child).
6. Any change to Neon Auth configuration needed to run the test (for example a trusted origin for the test), each
   reverted and recorded.

Out of scope in every case: production, any production identity or session, any real mailbox, and any customer.
