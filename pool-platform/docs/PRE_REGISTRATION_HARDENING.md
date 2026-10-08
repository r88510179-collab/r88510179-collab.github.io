# Pre-registration takeover hardening

Status: plan corrective 2 on branch `commercial-v1-pre-registration-plan-corrective-2`, a child of `a854419` (the first
plan corrective). `a854419` is a child of `38ea9ee`, the hardening candidate built on the production SHA `48e0ac4`. The
exact-SHA review of `38ea9ee` accepted migrations 002 and 004 as written and refused the rollout plan around them. The
exact-SHA review of `a854419` again accepted 002, 004, the helper hardening and the race model. It refused the plan's
revocation timing and proofs. This revision corrects those and changes only this document. It is not yet reviewed.
Nothing is applied to any database or deployed, no Neon setting has been changed, and no Neon branch has been created.
Everything below that touches Neon is a plan.

## Corrections to the reviewed plan (`a854419`)

- **Retracted:** "a JWT already minted from a revoked session ... names nobody once 004 is applied". A Race A session
  sits on a row that is verified and has no account, so its JWTs still pass 004 after the revocation. The race test's
  `a_revoked` probe shows this.
- **Retracted:** "deleting a session row ends the session at once". Better Auth answers `/get-session` and `/token`
  from the `session_data` cookie cache, without reading the row, until that cookie expires, and the repository models
  Neon setting that cookie (Evidence). So after a revocation, a session can still mint JWTs for its effective lifetime
  S, and each of those JWTs stays valid for 15 minutes plus about 30 s of skew. P0-5 now measures S. Gate W holds the
  close, invites, customer activity and Stage B until S + 15 minutes + 30 s have passed since the revocation.
- **Retracted:** Race B's "it cannot be renewed". The request that mints the straddling JWT also re-issues the cache
  with the verified user, so `/token` can mint more such JWTs until the cache expires.
- **Retracted:** the fallback to `/admin/revoke-user-sessions` (P0-5, the identity audit, step 5). The route exists,
  but that does not show the operator holds a valid admin identity or can run the route safely. A P0-5 failure now
  stops the rollout.
- **Corrected:** P0-5. The DELETE of the test session's row must report exactly 1 row. The proof then presents the full
  cookie jar to `/get-session` and `/token` until both refuse, and stops at a 60-minute bound.
- **Corrected:** the fixed 2-minute settle after N0. P0-6 measures how long N0 takes to be read back and enforced on
  the child. Before any revocation, production step 4 probes enforcement and waits a margin over that measurement.
- **Added:** a record of the child branch's copy of production's signing keys and sessions, the non-secret evidence
  that the proofs ran on the child (K1 to K4), and the child's deletion right after the proofs, before the window.
- **Added:** a follow-up for the production branch's pre-hardening 002.
- **Corrected:** rollback. After step 5, rolling back 004 or N0 waits for Gate W.

## Corrections to the reviewed plan (`38ea9ee`)

- **Retracted:** "004 closes the takeover inside V1 whatever the Neon Auth version is." On Better Auth 1.6.22 to
  1.6.33, the range the live host fingerprints in, the upstream fix opens two races, Race A and Race B. Each leaves a
  password holder with a session or JWT that names the owner, and no database check can tell it from the owner's.
  004 does not close them. N0 and the identity audit do.
- **Retracted:** "No intermediate state reopens the takeover", and with it "C (atomic) is not needed." Any state
  with 004 and without N0, or with N0 while a session minted before it is still live, leaves Race A or Race B open.
  The Neon-side closure (N0) now lands in the same controlled window as 004.
- **Retracted:** the reason for leaving `require_email_verification` unchanged. It does not stop the original
  takeover, because the owner's own Email OTP sign-in verifies the row. But it is what closes Race A, and, with the
  session revocation the identity audit gates, Race B. It is now N0, a mandatory gate.
- **Added:** proof P0 for N0, the read-only identity audit (`validation/neon-identity-audit.sql`), handling for
  existing sessions, one controlled rollout window with its rollback order, and the Stage B prerequisites.

## The finding

Neon Auth (Managed Better Auth) lets anyone call the public `/sign-up/email` on the Neon Auth host with any address
and a password. The address owner's first Email OTP sign-in then verifies that same user row. On Better Auth before
1.6.22 (GHSA-qq9h-g4jm-xgf3, also filed as CVE-2026-67327), the password survives, so whoever registered it signs in
as the owner from then on. Fixed versions delete the unproven password and revoke the user's sessions at that
sign-in. But they do it in separate statements that concurrent requests can interleave with (Race A, Race B). A JWT
already minted also stays valid at the Data API for its 15 minutes, and a revoked session can mint more from its
cookie cache until the cache expires. The live Neon Auth host fingerprints between 1.6.18 and 1.6.33, so whether it
carries the fix is undetermined. The plan has to hold either way.

Before this candidate, V1 named a caller from `auth.user_id()` and the user row alone (present, not banned). The
email-bound invite check added the stored `"emailVerified"`. Once the owner has verified, a password holder sharing
the row passes both.

## Evidence (all read-only)

2026-10-07:

- `neon_auth."user"."emailVerified"` is `boolean NOT NULL`. `neon_auth.account` holds `"userId" uuid` (foreign key to
  `neon_auth."user".id`, `ON DELETE CASCADE`), `"providerId"` and `password`. It has no RLS, and the migration owner
  (`neondb_owner`) can read it but `authenticated` cannot.
- `auth.session()` (pg_session_jwt 0.5.0) returns the JWT payload as jsonb. With no JWT it returns JSON `null` without
  error, and `auth.user_id()` returns NULL. The owner can execute it.
- Neon documents the JWT payload as the default user object, with `"emailVerified"` a JSON boolean. It does not support
  custom claims (docs: Auth > Plugins > JWT). The same example's `"role": "authenticated"` is the claim the live
  harness required of every live JWT in runbook step 11 (`S-*-claims`).
- The three live identity helper bodies are byte-identical to 002 as of `48e0ac4` (SHA-256 of `pg_proc.prosrc`).
- Design-phase aggregates: 5 verified Email-OTP users, none with an account row, and 6 unverified synthetic password
  users (`pp-cv1-*@example.com`). 0 OAuth users and 0 unexpired sessions. All 3 entry owners are OTP-only, and 2 of
  the 3 memberships are held by synthetic password users.

2026-10-08:

- Neon Auth config (`get_neon_auth_config`, branch `production`): `email_password.enabled` true, `allow_sign_up`
  true, `verify_email_on_sign_up` false, `verify_email_on_sign_in` false, `email_verification_method` `otp`,
  `require_email_verification` false, `auto_sign_in_after_verification` true, Google shared OAuth on,
  `allow_localhost` true, `trusted_origins` [].
- Neon API (OpenAPI `v2.json`): `PATCH /projects/{project_id}/branches/{branch_id}/auth/email_and_password` takes
  `require_email_verification` ("When true, users must verify their email address before they can sign in") and
  `disable_sign_up` (the inverse of the `allow_sign_up` above). The CLI equivalents are
  `neon neon-auth config email-password update --require-email-verification` and `--disable-sign-up`. The docs page
  "Email verification" says: "When email verification is required ..., users cannot sign in until they verify."
- `neon_auth.session` (catalog only): `id`, `"expiresAt"`, `token` (unique), `"createdAt"`, `"updatedAt"`,
  `"ipAddress"`, `"userAgent"`, `"userId"` (foreign key, `ON DELETE CASCADE`), `"impersonatedBy"`,
  `"activeOrganizationId"`.
- The live host's public OpenAPI schema (`<base>/open-api/generate-schema`, 78 paths) is identical across fetches.
  Without its `servers` entry, the only branch-specific field, it hashes to
  `e67ff74f19f3deaf9a9f45bc5c5cf6b7370b8b1ea6a411972e2fcf1af5cebf93` (`jq -S 'del(.servers)' | shasum -a 256`). Routes
  that can create a session: `/sign-in/email`, `/sign-up/email`, `/sign-in/email-otp`, `/sign-in/social` with
  `/callback/{id}`, `/verify-email`, `/email-otp/verify-email` and `/admin/impersonate-user`. There is no magic-link,
  phone or passkey route. `/token/anonymous` (Neon's own, no parameters) is not described beyond its name, so P0
  records what it returns. `/admin/revoke-user-sessions` exists, but this plan does not use it (P0-5).
- Better Auth source, read from the npm packages 1.6.21, 1.6.22 and 1.6.33 (the facts below are the same in 1.6.22
  and 1.6.33; 1.6.21 has no revocation):
  - `/sign-in/email-otp`, for an existing user whose `emailVerified` is false, calls `revokeUnprovenAccountAccess`,
    then `updateUser({emailVerified: true})`, then `createSession`. `revokeUnprovenAccountAccess` reads the user (and
    returns if it is already verified), reads its accounts, deletes each `credential` account, then deletes the
    user's sessions. Each is its own statement, and no transaction wraps them. OAuth accounts are kept. For a new
    address it creates the user with `emailVerified: true`, unless the plugin's own `disableSignUp` is set.
  - `/sign-in/email` reads the user with its accounts once (`findUserByEmail(email, {includeAccounts: true})`) and
    verifies the password. Then, only under `emailAndPassword.requireEmailVerification`, it refuses (403
    `EMAIL_NOT_VERIFIED`) when that one read said `emailVerified` false. Then it creates the session.
  - `/sign-up/email` under `requireEmailVerification` creates the user and its password, but no session.
  - `requireEmailVerification` appears only in `/sign-in/email`, `/sign-up/email` and the username and organization
    plugins. `/get-session`, `/token` and the session middleware never read it.
  - A JWT (`/token`, and the `set-auth-jwt` header) carries the session's user object as `findSession` read it,
    valid for 15 minutes by default. Without native joins (`experimental.joins`, whose Neon setting is unknown),
    `findSession` reads the session and then the user, in two queries.
- Upstream Better Auth 1.6.22 and 1.6.33, run locally on PostgreSQL 18 with `requireEmailVerification` true and
  Neon's two `sendOn*` settings false. OTPs were captured in memory; no mail and no Neon. This used a scratch harness,
  not committed, because it would add Better Auth to a lockfile. Results:
  - A first-time Email OTP sign-in and an existing user's each create a session; the new row is verified, with no
    account.
  - `/sign-up/email` creates the row and its password, but no session.
  - `/sign-in/email` on that row returns 403 `EMAIL_NOT_VERIFIED` and creates no session. The same call without the
    setting creates one.
  - A session minted without the setting is still accepted with it.
  - The owner's first Email OTP sign-in removes that session and the password. Afterwards the password sign-in
    returns 401.
  - Deleting a session row ends that session. The cookie cache was off (the upstream default with a database), so
    this holds only for a request that carries no `session_data` cookie (below).
  - No verification email was sent.

  This is Better Auth's behaviour, not Neon's deployment of it, which only P0 proves.

2026-10-08, for corrective 2 (repository and npm source only):

- Better Auth 1.6.33 source (`api/routes/session.mjs`, `cookies/index.mjs`, `plugins/jwt`): `/token` runs
  `sessionMiddleware`, which reads the session through `getSessionFromCtx` without `disableCookieCache`. When the
  cookie cache is enabled and the request carries an unexpired `session_data` cookie, it answers from that cookie and
  does not read `neon_auth.session`. A session read from the database re-issues the cookie, carrying the user as read,
  and so does a sign-in. The cookie's default `maxAge` is 300 s. With a database configured, upstream forces
  `refreshCache` off. Neon's values for these are not visible from outside.
- The repository models Neon setting `__Secure-neon-auth.session_data` on `/get-session` and `/sign-in/email-otp`
  (`auth-proxy-core.test.mjs`). The proxy drops that cookie. An attacker calls the Neon Auth host directly and keeps
  it.
- JWT plugin: `iss` and `aud` default to the Auth base URL's origin, and `exp` is 15 minutes after `iat` by default.
  The JWKS route serves each `neon_auth.jwks` row's public key, with `kid` set to the row's id. The same row holds the
  private key, encrypted with the Auth secret unless that is disabled. The live harness already records JWKS keys as
  `kty`, `crv`, `alg` and a `kid` fingerprint (`sha256(kid)`, first 12 hex characters), from
  `<base>/.well-known/jwks.json` (harness check P01).
- A Neon child branch copies its parent's data. A child of production therefore copies `neon_auth.jwks` (private keys
  included), `neon_auth.project_config`, every user and every session row.
- `migration-integration.test.mjs`, probe `a_revoked`: after Race A's session row is deleted, the JWT minted from it
  still names the owner under 004's helpers.
- Migration 002 differs between the production branch and this lineage (Follow-up: production source drift).

## The races in the fix: Race A and Race B

Both need an address that was pre-registered (an unverified row with a `credential` account) and whose owner then
signs in with Email OTP for the first time, on a version with the fix. On a version without it, or when the row is
verified some other way (`/verify-email`, `/email-otp/verify-email`, a password reset), the credential survives
verification. The identity stays contested, which 004 refuses (see Recovery).

### Race A: a password sign-in that lands after the revocation (persistent)

| | |
|---|---|
| Initial state | The address is pre-registered: unverified row, `credential` account, password known to the attacker. Its owner has never signed in. `require_email_verification` is false. |
| Attacker capability | Knows the address and the password. Calls the public `/sign-in/email` as often as its rate limit allows (keyed on IP and path, so spread over IPs), so that one request is in flight when the owner first signs in, for example around the time an invite goes out. Needs neither the owner's mail nor their traffic. |
| Ordering | 1. The attacker's `/sign-in/email` reads the row: unverified, with the credential. 2. While it hashes the password (scrypt), the owner's first `/sign-in/email-otp` deletes the credential, deletes the user's sessions, sets `emailVerified` true and creates the owner's session. 3. The attacker's request checks nothing more and creates its session. That INSERT lands after step 2's session delete, so nothing removes it. |
| Boundary crossed | Account binding. The attacker holds a persistent Neon Auth session (full session lifetime, renewed on use) for the owner's user. Every JWT it mints carries the owner's `sub` and `"emailVerified": true`. |
| What 004 prevents | Every losing order: any JWT minted before the row is verified (its claim false never equals the stored true), and any JWT while the credential remains (no fix, or a verification path that keeps it). |
| What 004 does not prevent | The winning order. Once the row is verified and has no account, the attacker's session mints exactly the owner's claims. All three checks pass, and no row says whose session is whose. The attacker claims the owner's email-bound invites, submits as them and reads what they read. Revoking the session does not stop this at once: the attacker can mint JWTs from its cookie cache for up to S (P0-5), and each one passes 004 for its 15 minutes. |
| What N0 prevents | The attacker's session. With `require_email_verification` true, `/sign-in/email` refuses when its single read said `emailVerified` false. A read that still finds the credential comes before the credential's deletion, and so before the verification. Better Auth deletes the credential before it sets the flag. With native joins the read is one statement; without them the user is read before the accounts. So that read says false, and the request is refused (403). A read after the verification finds no credential (401). This is source-backed and exercised on upstream Better Auth locally (Evidence); only P0 proves that Neon enforces it, and P0-6 and step 4 how soon. |
| What N1 prevents | The precondition: no new pre-registration through `/sign-up/email`. Rows registered before N1 remain (audit I03). |
| Residual after the combined remediation | None known through `/sign-in/email` on 1.6.22 to 1.6.33. It depends on Neon keeping N0 enforced: a Neon Auth upgrade or a revert of N0 reopens it, so P0 is tied to the schema fingerprint. It also depends on no other route creating a session for an unverified row without that check. The routes that can create a session (Evidence) are the password and sign-up routes N0 gates, Email OTP and both verification routes (which need the owner's mailbox), social sign-in (N2 removes it; an OAuth account is refused by 004 anyway) and admin impersonation (operator only). A Race A session created before the window cannot be told from the owner's either, so the window revokes every live session (step 5), and Gate W holds everything an owner's identity could be used for until that session's cache and last JWT have expired. |
| Blocks Stage B | Yes, until N0 is applied after a passing P0, in the same window as 004, and Gate W has passed. |
| Blocks customer launch | Yes, on the same conditions, and N1 as well. |

### Race B: a JWT minted across the verification (15 minutes, and the cache)

| | |
|---|---|
| Initial state | As Race A, and the attacker already holds a live session on the pre-registered row: a password sign-in made while `require_email_verification` was false. N0 does not end that session. |
| Attacker capability | That session's token and cookies. Calls `/token` (or `/get-session`) at will. |
| Ordering | The attacker's `findSession` reads the session row before the owner's first `/sign-in/email-otp` deletes it, and reads the user row after that sign-in has set `emailVerified` true. This needs the two-query `findSession` (no native joins), and a request the cookie cache does not answer. |
| Boundary crossed | A JWT bound to the owner's identity: `sub` is the owner and `"emailVerified"` is true. It is valid for 15 minutes (the Data API accepts a JWT about 30 s past its `exp`). The session row is gone, but the same request re-issued the `session_data` cookie with the verified user. So `/token` can keep minting such JWTs from that cookie, with no session row, until the cache expires (S, measured by P0-5): up to S + 15 minutes + 30 s in all. |
| What 004 prevents | Every other JWT from that session: before the verification (claim false), and after it once the cache has expired (no session to mint from). |
| What 004 does not prevent | The straddling JWT, and any JWT minted from the re-issued cache. Each passes all three checks for its whole lifetime. |
| What N0 prevents | New sessions of this kind: no password sign-in on an unverified row, and no session from sign-up. N0 does not remove sessions minted before it. The identity audit (I05, I06) finds them, and they are revoked after N0 is enforced, before the hardening counts as complete. |
| What N1 prevents | New pre-registrations, so no new rows of this shape. |
| Residual after the combined remediation | None known once N0 is enforced and I05 and I06 pass after it: no session remains on an unverified or account-bearing row, and none can be created. It depends on N0 as Race A does, on the revocation being complete (P0-5, then I05 and I06 at the end of the window), and on Gate W outlasting the cache and the last JWT. With native joins the race cannot occur at all. |
| Blocks Stage B | Yes, until the identity audit passes after N0, in the same window as 004, and Gate W has passed. |
| Blocks customer launch | Yes, on the same conditions. |

`migration-integration.test.mjs` records both races ("pre-registration race residual"). Each Neon Auth step runs on
its own backend, in an order the race allows, against 004's helpers. The test asserts what 004 closes (the
pre-verification JWT, before and after the owner's sign-in). It asserts what a session created before the transition
retains: Race B's session is gone, yet the JWT minted across the verification names the owner. And it asserts what
004 cannot close: Race A's session and Race B's JWT meet all three checks, mint the owner's own claims and claim the
owner's email-bound invite. A revoked session's JWT also stays valid until it expires. A later revision that claimed 004
alone makes every intermediate state safe would have to change that test. The test does not model the cookie cache, so
it understates how long a revoked session can still mint JWTs; P0-5 measures that. The test proves nothing about N0,
which only Neon enforces: P0 proves it.

## Trust model

Every RLS policy and RPC names its caller through three SECURITY DEFINER helpers in 002:
`pool_platform_current_user_id()`, `pool_platform_current_user_email()` and
`pool_platform_current_user_has_verified_email(text)`. Each applies one rule in one query. The caller is the user
named by `auth.user_id()`, not banned, and only when all of the following hold:

- `auth.session()->>'sub'` is that user, so the claims checked belong to the same JWT;
- `auth.session()->'emailVerified'` equals `to_jsonb(u."emailVerified")`. It must be a JSON boolean equal to the
  stored state, so a missing, null, string, numeric or nested claim never matches, and neither does a session that is
  not a JSON object;
- the user has no `neon_auth.account` row. Email OTP sign-in creates none, so a V1 identity never has one; a password
  or OAuth account is exactly what pre-registration attaches.

`has_verified_email` also keeps the stored `"emailVerified" IS TRUE` and the email match, so an email-bound invite
needs a verified email and a JWT that says so.

| Caller | Email-bound invite | Unbound invite | Everything else |
|---|---|---|---|
| no JWT, or claims malformed or missing | `auth_required` | `auth_required` | nobody |
| verified OTP user, fresh JWT, matching email | claims | claims | as before |
| verified OTP user, other email | `invite_email_mismatch` | claims | as before |
| unverified user, no account row (claim false) | `invite_email_unverified` | claims (bearer, unchanged) | as before |
| any user with a password or OAuth account | `auth_required` | `auth_required` | nobody |
| JWT minted before the email was verified | `auth_required` | `auth_required` | nobody |
| Race A's session, or Race B's JWT | claims, as the owner | claims | as the owner: **not closed by 004**; closed by N0, the audited revocation and Gate W |

The bearer model of unbound invites is unchanged: any identity holding the link may claim it, with no email match.
What changed is who counts as an identity at all. A contested user (one with a password or OAuth account) would bind the
entry to an id that the password holder shares, so a bearer claim is refused for it too. The same goes for a stale JWT.

What the database cannot see: the helpers see one JWT and the current rows, never the session or request it came
from. After Race A or Race B, the password holder's JWT and the owner's are the same claims for the same rows. So
whether a JWT belongs to the address owner is decided inside Neon Auth. N0, and no live session on an unverified or
account-bearing row (the audit), are part of this trust model, not optional configuration.

Where it is enforced, and why there:

- **Database (the only authorization boundary).** The browser calls the Data API directly with a Neon Auth JWT, and
  anyone can mint one from the public Neon Auth host, so neither the same-origin proxy nor the browser is on the
  attacker's path. The proxy keeps its contract (it never makes an authorization decision) and is unchanged. So are
  `auth-core.js`, the participant page and the client.
- **Neon Auth (who a JWT belongs to).** N0 stops a password sign-in on an unverified row; N1 and N2 stop the sign-up
  and OAuth paths that create contested rows. None of this is visible to, or enforceable by, the database.
- **The claim RPC** is unchanged: its `auth_required`, `invite_email_mismatch` and `invite_email_unverified` checks now
  run on the hardened helpers.
- **The client** shows a refused identity as it shows any persistent `auth_required`: one retry, then "Your sign-in
  could not be confirmed. Try again, or sign out and sign in again." Signing in again mints a fresh JWT, which clears
  the stale-JWT case. A contested user needs the operator (see Recovery).

Files: `migrations/002_identity_submission_rls.sql` (the hardened helpers);
`migrations/004_identity_pre_registration_hardening.sql` (the forward migration for the live database, as 003 is for
`submit_entry`: a guard, the three definitions byte for byte as 002 has them, and 002's privilege statements);
`validation/neon-preflight.sql` (P22, P23) and `validation/neon-catalog-verify.sql` (C24), for the two new
prerequisites; and `validation/neon-identity-audit.sql`, the read-only identity audit. 002 carries the fix itself
because re-applying 002 is a supported operation, and it must not undo the hardening. The production branch does not
carry it yet (Follow-up: production source drift).

## Neon Auth configuration plan (not executed)

| | N0: `email_password.require_email_verification` | N1: `email_password.allow_sign_up` | N2: Google OAuth provider |
|---|---|---|---|
| API field | `require_email_verification` | `disable_sign_up` (inverse) | `oauth_providers` `google` |
| Current (read 2026-10-08) | `false` | `true` | `google`, type `shared` |
| Desired | `true` | `false` | removed |
| Purpose | refuse a password sign-in on an unverified row: closes Race A, and with the audit Race B | stop public `/sign-up/email`, the pre-registration path | remove OAuth sign-up and linking by address, the GHSA-g38m class |
| Email OTP, first-time sign-in (new invitee) | unaffected by source (it creates the user verified; `requireEmailVerification` is not read); **P0 proves it** | **UNPROVEN**: Better Auth's emailOTP has its own `disableSignUp`, and how Neon maps `allow_sign_up` is unknown. If it also gates OTP sign-up, no new participant can join; **P1 proves it** | unaffected |
| Email OTP, existing users | unaffected by source; **P0 proves it** | unaffected (sign-in, not sign-up); P1 | unaffected |
| Password sign-in | refused for an unverified row (403 `EMAIL_NOT_VERIFIED`); a verified row's password still signs in, and 004 refuses that identity | unaffected | none |
| `/sign-up/email` | creates the row and its password, no session | refused | none |
| Existing users | 5 verified OTP users unaffected; the 6 unverified synthetic password users can no longer sign in | none signs up again | 0 OAuth users |
| Existing sessions | **not touched**: a session minted before N0 survives it (no session or JWT route reads the setting). The audit finds them, and they are revoked | not touched | not touched (0 OAuth users) |
| Time to take effect | **unknown**: P0-6 measures it on the child, and step 4 probes it in production before any revocation | not measured: N1 and N2 change no session | not measured |
| To observe in P0 | whether a verification email goes out on `/sign-up/email` (Better Auth defaults `sendOnSignUp` to `requireEmailVerification`; Neon's `send_verification_email_on_sign_up` is false and its mapping is unknown) | | |
| Rollback | `require_email_verification` back to `false` (reopens Race A; after step 5 only once Gate W has passed, see Rollout) | `allow_sign_up` back to `true` | re-add `google` shared |
| Prerequisite | P0 | P1 | P1 (applied with N1) |
| When | in the rollout window, before 004, and enforced (step 4) before the revocation | in the same window, once P1 passed | with N1 |

Deliberately unchanged:

- `email_password.enabled`: Neon documents Email OTP as needing "Sign-up and Sign-in with Email", so turning it off may
  disable OTP. That is unproven, and N0 with N1 makes it unnecessary.
- `verify_email_on_sign_up`, `verify_email_on_sign_in`, `email_verification_method`,
  `auto_sign_in_after_verification`: no bearing on either race.
- `allow_localhost` and trusted domains: no bearing on this finding (F-1 diagnostic).

## Proofs before any production change

Vendor behaviour is proven only live, on a Neon child branch of production (never on production itself), by the
operator. Real Email OTP codes go to addresses the operator controls and are typed by the operator, under the live-gate
OTP protocol. The local suites model the database side only and prove nothing about Neon Auth. Each proof records the
child's schema fingerprint (Evidence: `jq -S 'del(.servers)' | shasum -a 256` of `<base>/open-api/generate-schema`).
It must equal production's at the time of the proof, or the proof does not count. A child branch copies production's
users, sessions, signing keys and Neon Auth configuration, and has its own Auth URL. It is deleted right after the
proofs (below).

Secrets in the proofs: passwords, OTP codes, session tokens, cookie values and JWTs stay in shell variables or a cookie
jar file in a scratch directory. They are never printed, logged, committed or pasted into the record, and they are
deleted with the child. The record holds statuses, times, counts and the non-secret fields named below.

### Child branch: key copy, provenance and deletion

A child branch is a copy of production's database. So it holds copies of `neon_auth.jwks` (the JWT signing keys,
private halves included), `neon_auth.project_config`, every production user and every live production session. No
child-branch proof can avoid that copy, and it is accepted only while the proofs run. Nobody reads, exports or copies
the private key column, the project configuration or a production session. No query in this plan reads
`neon_auth.jwks` or `neon_auth.project_config`: K2 comes from the public JWKS endpoint.

If the child's Auth host signs with the copied key, its JWTs may verify against production's JWKS. Whether production's
Data API also checks `iss` or `aud` is not known, and the plan does not test it against production. The child also
keeps the copied production sessions, which production's step 5 does not revoke. Until it is deleted, the child is a
second host that may mint production-valid JWTs for production users.

Non-secret record, made on the child before P0 starts (K1, K2), during P0 (K3) and at its deletion (K4):

| | Record | Rule |
|---|---|---|
| K1 branch identity | the child's branch id and name, its parent branch id, the compute endpoint host that every child query (including the P0-5 DELETE) connects to, and the child's Auth base URL | the parent branch id must be production's; the child's branch id, endpoint host and Auth base URL must each differ from production's. Otherwise STOP: the proof would not be on the child |
| K2 key copy | `GET <base>/.well-known/jwks.json` (public, unauthenticated) on the child and on production: per key `kty`, `crv`, `alg`, the `kid` fingerprint (as harness check P01) and the RFC 7638 SHA-256 thumbprint of the public JWK | recorded; state whether the child serves any key that production serves |
| K3 JWT provenance | for the R0 JWT (P0-1): header `alg` and `kid` fingerprint; claims `iss` and `aud` (origins only); `exp - iat` in seconds | recorded; `kid` must be one of the child's K2 keys, otherwise STOP: the JWT's provenance is unexplained. Never the token, its signature or any other claim value |
| K4 deletion | the child's deletion time, a branch listing without it, and the child's Auth base URL no longer serving `/.well-known/jwks.json` | required before the window starts |

Deletion: delete the child immediately after P0, P1 and R0 are recorded, in the same operator session and before any
production step. Its test sessions, synthetic users and the operator's child identity go with it. The window does not
start while the child exists (Before the window, item 3). JWTs the child minted stay valid for up to 15 minutes and
30 s after the deletion. The window's revocation comes after the deletion, so Gate W covers them.

### P0 (N0 proof)

Order on the child: record K1 and K2. While N0 is still false, run P0-4's first step and create P0-6's identity. Then
P0-6 applies N0 alone and measures it, and the read-back must show every other field equal to production's. Then run
P0-1, P0-2, P0-3, P0-4's second step and P0-5, and record R0 and K3 from P0-1.

| Case | Steps | PASS | FAIL |
|---|---|---|---|
| P0-1 first-time Email OTP | an operator-controlled address with no row on the child requests a sign-in OTP and signs in with it | session created; the new row has `"emailVerified"` true and no account row; the decoded JWT carries `"emailVerified": true` as a JSON boolean (this also records R0 and K3) | any refusal, or a different claim shape |
| P0-2 existing-user Email OTP | a verified OTP user copied from production (one of D, E, A) signs in with Email OTP | session created; the row is unchanged | any refusal |
| P0-3 unverified password refused | `/sign-up/email` with a synthetic `@example.com` address and a password, then `/sign-in/email` with that password | sign-up returns no session token; sign-in returns 403 `EMAIL_NOT_VERIFIED`; that user has 0 session rows | a session is created at either step |
| P0-4 existing session survives | before N0, sign up and sign in a second synthetic password identity and keep its cookie jar; after N0, call `/get-session` with that jar | recorded either way. Expected: it still returns the session, which is why the revocation step exists | (none: a session that does not survive only makes the revocation step moot) |
| P0-5 revocation, measured | below | below | below; a FAIL is a STOP |
| P0-6 N0 propagation, measured | below | below | below |

**P0-5 (revocation, measured).** It uses P0-4's session if P0-4 shows that it survived N0, and otherwise P0-1's. Every
call goes straight to the child's Auth base URL, as an attacker's would. The cookie jar holds every cookie the host set
for that session: `session_token`, and `session_data` when the host sets one. The jar applies every `Set-Cookie` the
host returns, deletions included. Nothing in P0-5 records a token, a cookie value or a JWT.

1. Control. Call `/get-session` and `/token` with the jar. Both must accept: a session, and a token. Record whether
   the jar holds a `session_data` cookie, and the `Max-Age` on its latest `Set-Cookie` (the attribute only). Record
   t_issue: when the request whose response last set that cookie was sent. Hold the session's raw token
   (`session.token` in the `/get-session` body, also sent as the `set-auth-token` header) in a shell variable.
2. Delete. Straight after the control, note t_del. Then, as the child's migration owner, on the K1 endpoint, in one
   transaction: `DELETE FROM neon_auth.session WHERE token = :'token';`. The command tag must read `DELETE 1`, and
   only then COMMIT. Any other count, or an error, is a FAIL: roll back.
3. Poll. From the commit on, call `/get-session` and `/token` with the jar every 10 s. For each poll, record its time,
   both statuses, whether a session or a token came back, and whether a `session_data` cookie was set or expired. A
   poll accepts the session if either call does. t_last_ok is the last poll that accepts it, and t_first_fail is the
   first poll after that. Keep polling for 5 minutes past the first refusal. An acceptance in that time moves both
   t_last_ok and t_first_fail.
4. Bound. If the session is still accepted 60 minutes after t_del, stop polling: FAIL.
5. Record t_del, t_last_ok, t_first_fail, L = t_first_fail - t_del, and C = t_first_fail - t_issue (C = L when the jar
   held no `session_data` cookie). Then S = the larger of C and that `Max-Age` (when one was set), in whole minutes,
   rounded up. S is the effective session lifetime that Gate W uses. Unset the shell variable.

PASS requires all of the following: the control accepted; the DELETE reported 1 row; both calls refused before the
bound and through the 5 minutes after; S is recorded. Anything else is a FAIL. **A P0-5 FAIL is a STOP.** The controlled
remediation rollout is not authorized, nothing proceeds to production, and no other revocation method stands in. The
plan has no fallback.

Not in this plan: `/admin/revoke-user-sessions` exists (Evidence), but that does not show the operator holds a valid
admin identity or can run it safely. This plan creates no admin identity, uses no admin route and impersonates no one.
An admin revocation path, if one is wanted, needs its own evidence phase first.

**P0-6 (N0 propagation, measured).** While N0 is still false, sign up a third synthetic identity with `/sign-up/email`
and keep its password. Note t0, then send the PATCH that sets N0. Until both of the following are seen, read the
configuration back every 10 s, and call `/sign-in/email` with the third identity's password every 10 s:

- t_rb: the first read-back with N0 true.
- t_ref: when the first 403 `EMAIL_NOT_VERIFIED` that follows the last successful sign-in arrives.

Keep the sign-in probe going for 2 minutes past t_ref. A 429 counts as neither a success nor a refusal. Record t0,
t_rb, t_ref, every probe's status, and P_N0 = t_ref - t0 in whole seconds, rounded up. Sessions the probe creates
before t_ref stay on the child and are deleted with it.

PASS requires both t_rb and t_ref within 15 minutes of t0, and every probe after t_ref refused. FAIL is any of these:
N0 is not read back, or not enforced, within 15 minutes; a probe succeeds after t_ref (N0 is not enforced uniformly).
P_N0 is one measurement on one child from one client. It is not a vendor propagation bound, and step 4 uses it only
with a margin and a production probe.

Upstream Better Auth 1.6.22 and 1.6.33 pass P0-1 to P0-4 locally. A row delete ended a session that presented no cache
cookie (Evidence). The local run exercised neither the cookie cache, nor P0-5's timing, nor N0's propagation. P0 checks
that Neon's deployment behaves the same: its session storage, cookie cache and setting mappings are not visible from
outside. Also record whether a verification email was sent at P0-3, and the claim keys of whatever `/token/anonymous`
returns without a session. P0 passes only if P0-1, P0-2, P0-3, P0-5 and P0-6 pass, R0 holds, and K1 to K3 are
recorded. P0-4 is recorded either way. A P0 failure stops the whole rollout. 004 is not applied alone: it is not the
remediation, and the review requires the Neon-side closure in the same window. 004 alone would still be stricter than
today's production, but that would be a separate review decision.

**P1 (N1 and N2 proof).** On the same child after P0, with N0 still applied, apply N1 and N2. A first-time Email OTP
sign-in for a new address succeeds. An existing OTP user signs in. `/sign-up/email` is refused. P1 failing leaves N1
and N2 out of the window (no new invitee could join) and blocks Stage B. It does not block the window.

**R0 (JWT claim proof).** A JWT from a verified Email-OTP sign-in carries `"emailVerified": true` as a JSON boolean.
Record the claim keys and that value, and K3. It is the one 004 premise taken from vendor documentation, and P0-1 can
record it on the child under the matching fingerprint. If the claim is absent or not a boolean, STOP: 004 would refuse
every user (fail closed, reversible). If `exp - iat` exceeds 900 s, STOP: Gate W assumes a JWT lifetime of at most
15 minutes, and the plan must be revised first.

Values the window uses:

| Value | From | Used in |
|---|---|---|
| P_N0 (seconds) | P0-6 | step 4: production must enforce N0 within 2 * P_N0, and the revocation waits for T_N0 + 2 * P_N0 + 120 s |
| S (whole minutes) | P0-5 | Gate W: G = S + 900 s + 30 s |
| `exp - iat` (seconds) | R0 (K3) | must be at most 900; Gate W uses 900 s whatever the value |

## Identity audit (read-only)

`validation/neon-identity-audit.sql` is one read-only SELECT, run as the migration owner like the rest of the kit.
It returns counts only, never an id, email, token, IP address or user agent. It deletes, revokes and changes nothing.
The rows are listed in `validation/README.md`. Gates:

- **I05:** no live session (unexpired) of an unverified user.
- **I06:** no live session of a user with any account row (password or OAuth).

Reported, with a required disposition:

- **I03**, the unverified users with an account row (the pre-registration shape), split into the synthetic harness
  identities (`pp-cv1-*@example.com`, which cannot receive mail) and others. The operator classifies each other row
  in the Neon Console, without exporting addresses. With N0 on, none can sign in by password. If its owner signs in
  by Email OTP, a fixed version strips the password, and otherwise the identity is contested and refused by 004. So
  deleting them is not required for the closure. Deletion is a separate operator decision, after checking the row
  has no V1 standing.
- **I04**, the verified users with an account row (contested: 004 refuses them), and **I08**, the memberships and
  entries such users hold. Each one with V1 standing needs the recovery below.

Required action when I05 or I06 fails: revoke sessions only after N0 is enforced (step 4). Revoking earlier is
pointless, since a new password sign-in would follow. Do not delete the users. Revoke as the migration owner, by the
method P0-5 proved, a DELETE of `neon_auth.session` rows. Outside the window, delete exactly those users' sessions, in
one transaction, with the same predicate the audit uses:

    DELETE FROM neon_auth.session s USING neon_auth."user" u
    WHERE u.id = s."userId"
      AND (NOT u."emailVerified" OR EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId" = u.id));

No admin route is used (P0-5). Then run the audit again until I99 is PASS. In the rollout window itself, every live
session is revoked, not only these (step 5).

A revocation is not instant. A deleted session is still answered from its `session_data` cookie cache for up to S
(P0-5), and every JWT minted from it until then stays valid for 15 minutes plus about 30 s of skew. A Race A session's
JWTs carry the owner's claims for a verified row with no account, so 004 does not refuse them (probe `a_revoked`). The
other revoked sessions' JWTs carry `"emailVerified": false` or belong to a row with an account, and 004 refuses those
once applied. Gate W holds everything an owner's identity could be used for until that whole tail has passed.

## Controlled rollout (one window)

Before the window (no production change):

1. This corrective is independently reviewed at its exact SHA.
2. P0 passes, including P0-5 and P0-6. P1 passes, or N1 and N2 are recorded as deferred (Stage B then stays blocked).
   R0 is recorded with `exp - iat` at most 900 s. K1 to K3 are recorded. P_N0 and S are recorded.
3. The child branch is deleted and K4 is recorded.
4. Production is unchanged: the production branch is at `48e0ac4`, Netlify Auto Publishing is Locked, and the three
   live helper bodies still hash to 004's pre-hardening column.

Clocks. The window checks every wait on the production database clock: `SELECT clock_timestamp()` on the
migration-owner connection. T_N0 and T_rev are read on that clock right after the action each one marks, so each wait
starts no earlier than its action. Intervals (P0's P_N0 and S, step 4's P_prod) are measured on the operator's machine
clock in UTC. Each start is taken before the action is sent, and each end when the response arrives, so each interval
overstates the true one. Only intervals cross from one clock to the other.

The window is one operator session with no gap between the security controls. It needs no Netlify deploy: no file the
build ships differs from `48e0ac4`. Auto Publishing stays Locked throughout, and no invite is sent during the window:

1. **Fingerprint.** Production's schema fingerprint equals the one P0 and P1 recorded. If it changed, STOP: the
   vendor changed, so re-run P0 and P1. The child branch is still absent (K4). Record the Neon Auth configuration
   (`get_neon_auth_config`).
2. **Audit, baseline, and the probe identity.** Run `neon-identity-audit.sql` and record every row. A STOP here is
   expected when old sessions exist. It is remediated in step 5. Then sign up one synthetic probe identity on
   production through `/sign-up/email` (`pp-cv1-n0probe-<UTC date>@example.com`, with a random password held only in
   the operator's shell). Step 4 probes with it, and step 5 revokes its sign-up session. Afterwards it stays as one
   more synthetic I03 row: under N0 it cannot sign in, 004 refuses it, and deleting it falls under the same operator
   decision as the other six.
3. **N0.** Note t3 on the operator's clock, and set `require_email_verification` to `true` on production. Immediately
   after the PATCH returns, read T_N0 = `clock_timestamp()` on production and record it. Read the configuration back
   every 10 s, for up to 15 minutes, until N0 is true. Every other field must be as step 1 recorded.
4. **N0 enforced (replaces the fixed settle).** From step 3 on, call production's `/sign-in/email` with the probe
   identity's password every 10 s. A 429 counts as neither a success nor a refusal. Record every status, and the
   arrival of the first 403 `EMAIL_NOT_VERIFIED` that follows the last success. P_prod is that arrival time - t3.
   - PASS, when all of these hold: N0 reads back true; P_prod is at most 2 * P_N0; every probe has been refused for
     at least 2 minutes since that first refusal; and
     `SELECT clock_timestamp() >= timestamptz '<T_N0>' + interval '<2 * P_N0 + 120> seconds'` returns true on
     production. The 2 minutes let a `/sign-in/email` that read its row before N0 finish. Doubling P_N0 is a margin,
     because one child measurement is not a vendor bound.
   - STOP, on any of these: no refusal by t3 + 2 * P_N0 (production differs materially from P0-6); a success after a
     refusal; N0 not read back within 15 minutes. On a STOP, no session is revoked and 004 is not applied. N0 stays
     applied: it is stricter than before, and P0 proved Email OTP under it. Record everything and end the window.
5. **Audit after N0, and revoke.** Only after step 4 passes. Run the audit and record it. Then revoke every live
   session as the migration owner, by the method P0-5 proved, in one transaction: `DELETE FROM neon_auth.session;`
   (record its row count), then `SELECT count(*) FROM neon_auth.session;`, which must return 0, then COMMIT.
   Immediately after the commit, read T_rev = `clock_timestamp()` on the same connection and record it: Gate W starts
   there. No admin route is used. This covers the sessions I05 and I06 count, and also a Race A session created before
   N0. Such a session sits on a row that is now verified with no account, so no audit can tell it from the owner's. V1
   is pre-launch, so every other session is the operator's, and those identities sign in again at step 7. Run the
   audit again. Continue only with I99 `PASS` and I07's total 0. If step 5 runs again, T_rev is the last run's.
6. **004.** Apply 004 as the migration owner with `--single-transaction`. Re-run `neon-catalog-verify.sql` (C99
   `PASS`) and check the three helper fingerprints against the 004 guard's hardened column.
7. **Confirm.** Sign in as D, E and A by Email OTP, and confirm that participant and commissioner context load. This
   also exercises existing-user OTP sign-in under N0 on production. This is operator activity only: no invite is
   created, sent or claimed.
8. **N1 and N2** (only if P1 passed). Apply them, read the configuration back, and confirm an existing user's OTP
   sign-in.
9. **Close.** Only after Gate W has passed. Run the audit (I99 `PASS`) and the catalog verifier (C99 `PASS`) again.
   Confirm that the production branch is still `48e0ac4`, that Auto Publishing is still Locked, and that the child
   branch is still absent. Record everything, including t3, T_N0, P_prod, T_rev, S, G and the time Gate W passed.

The hardening counts as complete only at step 9.

### Gate W (security wait)

Gate W is an operator gate between step 5 and step 9. It exists because a revoked session is still usable for up to
S, and its JWTs for 15 minutes and about 30 s after that.

| | |
|---|---|
| Starts at | T_rev: the production database's `clock_timestamp()`, read immediately after step 5's transaction commits (the last run of step 5, if it ran more than once) |
| Length | G = S + 900 s + 30 s. S comes from P0-5, in whole minutes rounded up. 900 s is the JWT lifetime R0 bounded. 30 s is the skew the Data API accepts past `exp`. G is never shortened |
| Check | `SELECT clock_timestamp() >= timestamptz '<T_rev>' + interval '<G> seconds';` on production, as the migration owner |
| PASS | the check returns true, step 6 has completed, and since T_rev: no rollback of N0 or 004 has run; N0 still reads back true; 004's helper fingerprints are still the hardened column. Record the time of the check |
| Not yet | the check returns false, or step 6 has not completed: wait and check again |
| STOP | T_rev or S is not recorded: no PASS is possible, so run step 5 again for a new T_rev. Or a rollback of N0 or 004 has run since T_rev: the window is incomplete (Rollback) |
| Until PASS | no step 9, no final PASS and no "complete"; no invite created (`pool_platform_create_entry_invite`) or sent; no invite claimed; no participant or customer activity; no Stage B. Steps 6, 7 and 8 may run |

### Rollback

Rollback, in reverse order of application. Roll back only what failed, and record it. Deleting a session row is not
instant. So no rollback or recovery step counts a revocation as effective before Gate W's check for that revocation
returns true. After step 5, a rollback of 004 or N0 does not run before Gate W's check returns true. Until then, a
revoked session can still mint JWTs from its cache, and JWTs minted before the revocation are still valid. Rolling back
004 would make more of them acceptable. Rolling back N0 would let new password sessions form beside them. Both
failures these rollbacks answer are fail-closed (everyone refused, or no Email OTP sign-in), so waiting costs
availability, not security:

- **N1, N2:** may run at any time. `allow_sign_up` goes back to `true`, and the `google` shared provider is re-added.
  N0 and 004 stay, so reopening sign-up does not reopen Race A or Race B. Stage B stays blocked until N1 and N2 are
  applied again.
- **004:** after step 5, only once Gate W's check returns true. As the migration owner, in one transaction, run the
  three helper definitions from 002 as of `48e0ac4`
  (`git show 48e0ac4:pool-platform/migrations/002_identity_submission_rls.sql`), followed by the four privilege
  statements that end 004. The helpers then hash to the guard's pre-hardening column again, so 004 can be re-applied
  later (step 6, then step 9). Re-run `neon-catalog-verify.sql` (C99 `PASS`). Use it when R0 proves wrong in
  production (everyone refused). N0 stays. The hardening is then incomplete, and Stage B stays blocked.
- **N0:** last, and only if Email OTP sign-in fails under it in production despite P0. After step 5, it waits until
  Gate W's check returns true. Set `require_email_verification` back to `false`. This reopens Race A and Race B, so
  Stage B is blocked again. Re-applying N0 later repeats steps 2 to 5 (a new T_N0, the step 4 probe, a new revocation
  and T_rev), then Gate W from the new T_rev, before step 9. Password sessions made in between are revoked by that new
  step 5. Before step 5, when N0 is the only Neon setting changed, rolling it back restores today's production and
  needs no wait. The window has then failed.

### Unsafe orders

- 004 without R0: risks refusing everyone.
- N0 without P0: risks refusing every Email OTP sign-in.
- N1 without P1: risks refusing every new invitee.
- 004 without N0 in the same window, or N0 without the audit after it: leaves Race A or Race B open while the
  hardening looks done.
- Revoking sessions before step 4 has shown N0 enforced in production (a read-back alone is not enough): a new password
  session can follow.
- Closing the window, inviting, claiming, letting customers act or starting Stage B before Gate W: a revoked Race A or
  Race B session, or its JWTs, may still name the owner.
- Rolling back 004 or N0 after step 5 before Gate W.
- Starting the window while the child branch exists: it can still mint JWTs from production sessions that step 5 does
  not revoke.
- Falling back to an admin route, or any revocation method P0-5 did not prove, when P0-5 fails.
- Neon changes without 004: leave the identity rule to vendor configuration alone.

## Stage B prerequisites

Stage B (signed-in validation on production) stays unauthorized until all of these are true and recorded:

1. This corrective (corrective 2) has passed its independent exact-SHA review.
2. P0 and P1 passed on a child branch whose schema fingerprint equals production's. That includes P0-5 (revocation
   measured, S recorded) and P0-6 (N0 enforced on the child, P_N0 recorded). R0 is recorded with `exp - iat` at most
   900 s, and K1 to K3 are recorded.
3. The child branch was deleted after the proofs and before the window (K4).
4. The controlled window completed through step 9 with no outstanding rollback. N0 was applied, read back and shown
   enforced in production (step 4). Every production session was revoked (step 5), with T_rev recorded. 004 was
   applied, with C99 `PASS` and the hardened helper fingerprints. D, E and A were confirmed. N1 and N2 were applied
   and read back. Gate W passed. The audit (I99 `PASS`) and catalog verifier (C99 `PASS`) at step 9 ran after Gate W.
5. A fresh identity audit at the start of Stage B passes (I99 `PASS`). Every I03 row other than the synthetic harness
   identities is classified, and every I04 identity with V1 standing (I08) has been recovered.
6. Production's schema fingerprint still equals P0's, and its session-creating routes are still the ones listed in
   Evidence. Otherwise there may be an account-binding path the Stage B test would expose that this plan does not
   cover.
7. Stage B uses Email OTP identities only: the live harness's password identities cannot act after 004 and N0.

Other carried items (for example Neon question I, Email OTP rate-limit keying) are tracked elsewhere and are not
changed here.

## Existing users and sessions

- 5 verified OTP users (including the gate identities D, E and A): unaffected, provided R0 and P0 hold. No
  reverification.
- 6 unverified synthetic password users: N0 refuses their password sign-in, and 004 refuses them. The 2 memberships
  they hold become inert. Their live sessions, if any, are revoked in step 5. Deleting the users (which cascades their
  accounts and sessions; memberships and `entries.owner_auth_user_id` have no foreign key) is a separate operator
  decision.
- Any session minted before N0 survives N0 (Neon's setting gates sign-in only). The audit finds those on unverified
  or account-bearing rows. Step 5 revokes every live session, including any it cannot find (a Race A session on a row
  since verified). A revoked session can still be answered from its cookie cache for up to S, and its JWTs stay valid
  for 15 minutes and about 30 s after that. Gate W covers that tail. Everyone signs in again with Email OTP.
- The live validation harness (`validation/live/`) signs up password identities, so after N0 and 004 it can no longer
  act. It needs a redesign before any further live run. Its local rehearsal takes the stub from
  `migration-integration.test.mjs`, and its mock Data API sets no JWT claims, so the rehearsal now refuses every
  identity too.

## Recovery for a contested identity

A user refused because their row carries a password or OAuth account cannot fix it by signing in again. Delete the
Neon Auth user, which cascades its accounts and sessions. Do not delete only the account row: that would make the
password holder's sessions valid again. Clear any `owner_auth_user_id` and membership that named the user, and
re-invite. The owner's next Email OTP sign-in creates a fresh row.

## Follow-up: production source drift of migration 002

- **The drift.** The production source and runtime branch, `commercial-v1-netlify-adapter`, is at
  `48e0ac4e0d6a4cd745cdd4ed2a67fc56ef53cb60` (tree `e1c71e85ffd10556c83ebbb9b06b8b5cec99e099`). Its
  `pool-platform/migrations/002_identity_submission_rls.sql` (blob `5bf7b18`) defines the three identity helpers
  without the hardening, and it has no 004. The hardened 002 (blob `016749b`) and 004 (blob `c696397`) exist only on
  the candidate lineage: `38ea9ee`, `a854419` and this branch.
- **Why it does not block the controlled remediation.** 004 hardens the live database by itself: it carries the
  three hardened definitions byte for byte. No file the Netlify build ships differs from `48e0ac4`, so the window
  needs no deploy and the runtime stays at `48e0ac4`.
- **Why it must be resolved before any migration maintenance or re-application.** Re-applying 002 is a supported
  operation (Trust model). 002 as of `48e0ac4` replaces the hardened helpers with the pre-hardening bodies
  (`CREATE OR REPLACE`), so re-applying it would silently undo 004 on the live database. Until the drift is resolved,
  002 is not re-applied from the production branch.
- **Resolution is separate.** Promoting the reviewed source lineage to the production branch, or any other fix, is
  its own reviewed follow-up. This corrective moves no branch and does not fast-forward the production branch.

## Residual risks

- Race A and Race B are closed by N0, the revocation in step 5 and Gate W, not by 004. That holds only while Neon
  enforces N0 as P0 observed it, under the fingerprint P0 recorded. A Neon Auth upgrade calls for a new P0.
- R0 and the N0 effects are vendor behaviour. They are proven on a child branch, and confirmed in production only by
  step 4 (the refusal probe) and step 7 (Email OTP).
- Gate W's length rests on the S that P0-5 measured on the child and the JWT lifetime R0 bounded. P0-5 measures one
  session from one client, so a Neon change to either value calls for a new P0.
- Until N1, an attacker who knows an invitee's address can make that identity contested, and the invitee is refused
  rather than taken over (Recovery). If Neon sends a verification email on sign-up under N0, the owner may also get
  one for a sign-up they never made. Completing it keeps the password, and 004 refuses the contested identity.
- After a revocation, a session can still mint JWTs from its cookie cache for up to S, and each JWT stays valid for up
  to 15 minutes, plus about 30 s of skew. For a Race A session, these JWTs still name the owner once 004 is applied.
  Gate W holds the close, invites, customer activity and Stage B until that tail has passed.
- A refused identity sees a generic sign-in message, not the reason.
- Better Auth mints a JWT from a cached user snapshot when a request carries the `session_data` cookie (Evidence). A
  user who verified moments earlier could then be refused until the cache refreshes. That only affects rows that
  existed unverified before their first OTP sign-in. The proxy passes Neon only the session token cookie, never the
  session-data cache cookie, so this does not reach V1's own client.
- The Better Auth organization plugin is enabled upstream (GHSA-fmh4, 0 organizations). V1 never reads
  `auth.organization()`, and 004 does not change that.
- If a future Neon Auth release attached an account row to Email OTP users, every new user would be refused (fail
  closed). The catalog cannot show that, but the audit's I02 and I04 would.
- Each helper call now also probes `neon_auth.account` by its `"userId"` index and reads the JWT claims. RLS policies
  call `pool_platform_current_user_id()`, which is negligible at V1 scale.
- Email OTP rate-limit keying (Neon question I) is unchanged.
