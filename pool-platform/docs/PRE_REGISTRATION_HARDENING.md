# Pre-registration takeover hardening

Status: plan corrective on branch `commercial-v1-pre-registration-plan-corrective`, a child of `38ea9ee` (the
hardening candidate, itself built on the production SHA `48e0ac4`). The exact-SHA review of `38ea9ee` accepted
migrations 002 and 004 as written, and refused the rollout plan around them. This revision corrects the plan, its
gates and its race coverage, and changes no migration. This revision is not yet reviewed. Nothing is applied to any
database or deployed, and no Neon setting has been changed. Everything below that touches Neon is a plan.

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
already minted also stays valid at the Data API for its 15 minutes. The live Neon Auth host fingerprints between
1.6.18 and 1.6.33, so whether it carries the fix is undetermined. The plan has to hold either way.

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
  records what it returns. `/admin/revoke-user-sessions` exists.
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
  - Deleting a session row ends that session.
  - No verification email was sent.

  This is Better Auth's behaviour, not Neon's deployment of it, which only P0 proves.

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
| What 004 does not prevent | The winning order. Once the row is verified and has no account, the attacker's session mints exactly the owner's claims. All three checks pass, and no row says whose session is whose. The attacker claims the owner's email-bound invites, submits as them and reads what they read. |
| What N0 prevents | The attacker's session. With `require_email_verification` true, `/sign-in/email` refuses when its single read said `emailVerified` false. A read that still finds the credential comes before the credential's deletion, and so before the verification. Better Auth deletes the credential before it sets the flag. With native joins the read is one statement; without them the user is read before the accounts. So that read says false, and the request is refused (403). A read after the verification finds no credential (401). This is source-backed and exercised on upstream Better Auth locally (Evidence); only P0 proves that Neon enforces it. |
| What N1 prevents | The precondition: no new pre-registration through `/sign-up/email`. Rows registered before N1 remain (audit I03). |
| Residual after the combined remediation | None known through `/sign-in/email` on 1.6.22 to 1.6.33. It depends on Neon keeping N0 enforced: a Neon Auth upgrade or a revert of N0 reopens it, so P0 is tied to the schema fingerprint. It also depends on no other route creating a session for an unverified row without that check. The routes that can create a session (Evidence) are the password and sign-up routes N0 gates, Email OTP and both verification routes (which need the owner's mailbox), social sign-in (N2 removes it; an OAuth account is refused by 004 anyway) and admin impersonation (operator only). A Race A session created before the window cannot be told from the owner's either, so the window revokes every live session (step 5). |
| Blocks Stage B | Yes, until N0 is applied after a passing P0, in the same window as 004. |
| Blocks customer launch | Yes, on the same conditions, and N1 as well. |

### Race B: a JWT minted across the verification (15 minutes)

| | |
|---|---|
| Initial state | As Race A, and the attacker already holds a live session on the pre-registered row: a password sign-in made while `require_email_verification` was false. N0 does not end that session. |
| Attacker capability | That session's token. Calls `/token` (or `/get-session`) at will. |
| Ordering | The attacker's `findSession` reads the session row before the owner's first `/sign-in/email-otp` deletes it, and reads the user row after that sign-in has set `emailVerified` true. This needs the two-query `findSession` (no native joins). |
| Boundary crossed | A JWT bound to the owner's identity: `sub` is the owner and `"emailVerified"` is true. It is valid for 15 minutes (the Data API accepts a JWT about 30 s past its `exp`), minted from a session that no longer exists, so it cannot be renewed. |
| What 004 prevents | Every other JWT from that session: before the verification (claim false) and after it (no session to mint from). |
| What 004 does not prevent | The straddling JWT. It passes all three checks for its whole lifetime. |
| What N0 prevents | New sessions of this kind: no password sign-in on an unverified row, and no session from sign-up. N0 does not remove sessions minted before it. The identity audit (I05, I06) finds them, and they are revoked after N0, before the hardening counts as complete. |
| What N1 prevents | New pre-registrations, so no new rows of this shape. |
| Residual after the combined remediation | None known once N0 is on and I05 and I06 pass after it: no session remains on an unverified or account-bearing row, and none can be created. It depends on N0 as Race A does, and on the revocation being complete (P0-5, then I05 and I06 at the end of the window). With native joins the race cannot occur at all. |
| Blocks Stage B | Yes, until the identity audit passes after N0, in the same window as 004. |
| Blocks customer launch | Yes, on the same conditions. |

`migration-integration.test.mjs` records both races ("pre-registration race residual"). Each Neon Auth step runs on
its own backend, in an order the race allows, against 004's helpers. The test asserts what 004 closes (the
pre-verification JWT, before and after the owner's sign-in). It asserts what a session created before the transition
retains: Race B's session is gone, yet the JWT minted across the verification names the owner. And it asserts what
004 cannot close: Race A's session and Race B's JWT meet all three checks, mint the owner's own claims and claim the
owner's email-bound invite. A revoked session's JWT also stays valid until it expires. A later revision that claimed 004
alone makes every intermediate state safe would have to change that test. The test proves nothing about N0, which
only Neon enforces: P0 proves it.

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
| Race A's session, or Race B's JWT | claims, as the owner | claims | as the owner: **not closed by 004**; closed by N0 and the audited revocation |

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
because re-applying 002 is a supported operation, and it must not undo the hardening.

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
| To observe in P0 | whether a verification email goes out on `/sign-up/email` (Better Auth defaults `sendOnSignUp` to `requireEmailVerification`; Neon's `send_verification_email_on_sign_up` is false and its mapping is unknown) | | |
| Rollback | `require_email_verification` back to `false` (reopens Race A, see Rollout) | `allow_sign_up` back to `true` | re-add `google` shared |
| Prerequisite | P0 | P1 | P1 (applied with N1) |
| When | in the rollout window, before 004 | in the same window, once P1 passed | with N1 |

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
users, sessions and Neon Auth configuration, and has its own Auth URL. It is deleted after the proofs.

**P0 (N0 proof).** On the child, run P0-4's first step while N0 is still false. Then apply N0 only and read the
configuration back: every other field must equal production's. Then run the remaining cases.

| Case | Steps | PASS | FAIL |
|---|---|---|---|
| P0-1 first-time Email OTP | an operator-controlled address with no row on the child requests a sign-in OTP and signs in with it | session created; the new row has `"emailVerified"` true and no account row; the decoded JWT carries `"emailVerified": true` as a JSON boolean (this also records R0) | any refusal, or a different claim shape |
| P0-2 existing-user Email OTP | a verified OTP user copied from production (one of D, E, A) signs in with Email OTP | session created; the row is unchanged | any refusal |
| P0-3 unverified password refused | `/sign-up/email` with a synthetic `@example.com` address and a password, then `/sign-in/email` with that password | sign-up returns no session token; sign-in returns 403 `EMAIL_NOT_VERIFIED`; that user has 0 session rows | a session is created at either step |
| P0-4 existing session survives | before N0, sign up and sign in a second synthetic password identity and keep its session token; after N0, call `/get-session` with that token | recorded either way. Expected: it still returns the session, which is why the revocation step exists | (none: a session that does not survive only makes the revocation step moot) |
| P0-5 revocation | delete P0-4's session row as the child's migration owner (`DELETE FROM neon_auth.session WHERE token = ...`), then call `/get-session` with its token | `null`: a database-side revocation ends the session | the delete is refused, or the session still answers: the window must revoke through `/admin/revoke-user-sessions` instead, with an operator admin identity |

Upstream Better Auth 1.6.22 and 1.6.33 pass all five cases locally (Evidence). P0 checks that Neon's deployment does
the same: its session storage, cookie cache and setting mappings are not visible from outside. Also record whether a
verification email was sent at P0-3, and the claim keys of whatever `/token/anonymous` returns without a session. P0
passes only if P0-1, P0-2 and P0-3 pass. P0-4 and P0-5 decide how the window revokes sessions. A P0 failure stops the whole rollout. 004 is not applied alone: it is not the
remediation, and the review requires the Neon-side closure in the same window. 004 alone would still be stricter than
today's production, but that would be a separate review decision.

**P1 (N1 and N2 proof).** On the same child after P0, with N0 still applied, apply N1 and N2. A first-time Email OTP
sign-in for a new address succeeds. An existing OTP user signs in. `/sign-up/email` is refused. P1 failing leaves N1
and N2 out of the window (no new invitee could join) and blocks Stage B. It does not block the window.

**R0 (JWT claim proof).** A JWT from a verified Email-OTP sign-in carries `"emailVerified": true` as a JSON boolean.
Record the claim keys and that value only. It is the one 004 premise taken from vendor documentation, and P0-1 can
record it on the child under the matching fingerprint. If the claim is absent or not a boolean, STOP: 004 would refuse
every user (fail closed, reversible).

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

Required action when I05 or I06 fails: after N0 is on (revoking earlier is pointless, since a new password sign-in
would follow), revoke exactly those users' sessions. Do not delete the users. Use the method P0-5 proved: either as
the migration owner, in one transaction, the same predicate the audit uses:

    DELETE FROM neon_auth.session s USING neon_auth."user" u
    WHERE u.id = s."userId"
      AND (NOT u."emailVerified" OR EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId" = u.id));

or `/admin/revoke-user-sessions` for each such user. Then run the audit again until I99 is PASS. In the rollout
window itself, every live session is revoked, not only these (step 5). A JWT already minted
from a revoked session stays valid for up to 15 minutes (plus about 30 s of skew). Such a JWT carries
`"emailVerified": false` or belongs to a row with an account, so once 004 is applied it names nobody. Before 004 it is
no more than today's production already accepts.

## Controlled rollout (one window)

Before the window (no production change):

1. This corrective is independently reviewed at its exact SHA.
2. P0 passes. P1 passes, or N1 and N2 are recorded as deferred (Stage B then stays blocked). R0 is recorded.
3. Production is unchanged: the production branch is at `48e0ac4`, Netlify Auto Publishing is Locked, and the three
   live helper bodies still hash to 004's pre-hardening column.

The window, one operator session with no gap between the security controls. It needs no Netlify deploy: no file the
build ships differs from `48e0ac4`. Auto Publishing stays Locked throughout, and no invite is sent during the window:

1. **Fingerprint.** Production's schema fingerprint equals the one P0 and P1 recorded. If it changed, STOP: the
   vendor changed, so re-run P0 and P1. Record the Neon Auth configuration (`get_neon_auth_config`).
2. **Audit, baseline.** Run `neon-identity-audit.sql` and record every row. A STOP here is expected when old sessions
   exist. It is remediated in step 5.
3. **N0.** Set `require_email_verification` to `true` on production. Read the configuration back: N0 is true and every
   other field is as step 1 recorded.
4. **Settle.** Wait 2 minutes, so that every `/sign-in/email` that read its row before N0 has finished.
5. **Audit after N0, and revoke.** Run the audit and record it. Then revoke every live session, by the method P0-5
   proved: as the migration owner `DELETE FROM neon_auth.session;`, or `/admin/revoke-user-sessions` for each user
   holding one. That covers the sessions I05 and I06 count, and also a Race A session created before N0. Such a
   session sits on a row that is now verified with no account, so no audit can tell it from the owner's. V1 is
   pre-launch, so every other session is the operator's, and those identities sign in again at step 7. Run the audit
   again. Continue only with I99 `PASS` and I07's total 0.
6. **004.** Apply 004 as the migration owner with `--single-transaction`. Re-run `neon-catalog-verify.sql` (C99
   `PASS`) and check the three helper fingerprints against the 004 guard's hardened column.
7. **Confirm.** Sign in as D, E and A by Email OTP, and confirm that participant and commissioner context load. This
   also exercises existing-user OTP sign-in under N0 on production.
8. **N1 and N2** (only if P1 passed). Apply them, read the configuration back, and confirm an existing user's OTP
   sign-in.
9. **Close.** Run the audit (I99 `PASS`) and the catalog verifier (C99 `PASS`) again. Confirm that the production
   branch is still `48e0ac4` and Auto Publishing is still Locked, and record everything.

The hardening counts as complete only at step 9.

Rollback, in reverse order of application. Roll back only what failed, and record it:

- **N1, N2:** `allow_sign_up` back to `true`; re-add the `google` shared provider. N0 and 004 stay.
- **004:** as the migration owner, in one transaction, run the three helper definitions from 002 as of `48e0ac4`
  (`git show 48e0ac4:pool-platform/migrations/002_identity_submission_rls.sql`), followed by the four privilege
  statements that end 004. The helpers then hash to the guard's pre-hardening column again, so 004 can be re-applied
  later. Re-run `neon-catalog-verify.sql` (C99 `PASS`). Use it when R0 proves wrong in production (everyone refused).
  N0 stays.
- **N0:** last, and only if Email OTP sign-in fails under it in production despite P0. `require_email_verification`
  back to `false`. This reopens Race A and Race B, so Stage B is blocked again, and re-applying N0 later repeats
  steps 3 to 5 (password sessions made in between must be found and revoked).

Unsafe orders:

- 004 without R0: risks refusing everyone.
- N0 without P0: risks refusing every Email OTP sign-in.
- N1 without P1: risks refusing every new invitee.
- 004 without N0 in the same window, or N0 without the audit after it: leaves Race A or Race B open while the
  hardening looks done.
- Revoking sessions before N0: a new password session can follow.
- Neon changes without 004: leave the identity rule to vendor configuration alone.

## Stage B prerequisites

Stage B (signed-in validation on production) stays unauthorized until all of these are true and recorded:

1. This corrective has passed its independent exact-SHA review.
2. P0 and P1 passed on a child branch whose schema fingerprint equals production's, and R0 is recorded.
3. The controlled window completed through step 9 with no outstanding rollback: N0, N1 and N2 applied and read back;
   004 applied with C99 `PASS` and the hardened helper fingerprints; D, E and A confirmed.
4. A fresh identity audit at the start of Stage B passes (I99 `PASS`). Every I03 row other than the synthetic harness
   identities is classified, and every I04 identity with V1 standing (I08) has been recovered.
5. Production's schema fingerprint still equals P0's, and its session-creating routes are still the ones listed in
   Evidence. Otherwise there may be an account-binding path the Stage B test would expose that this plan does not
   cover.
6. Stage B uses Email OTP identities only: the live harness's password identities cannot act after 004 and N0.

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
  since verified). Everyone signs in again with Email OTP.
- The live validation harness (`validation/live/`) signs up password identities, so after N0 and 004 it can no longer
  act. It needs a redesign before any further live run. Its local rehearsal takes the stub from
  `migration-integration.test.mjs`, and its mock Data API sets no JWT claims, so the rehearsal now refuses every
  identity too.

## Recovery for a contested identity

A user refused because their row carries a password or OAuth account cannot fix it by signing in again. Delete the
Neon Auth user, which cascades its accounts and sessions. Do not delete only the account row: that would make the
password holder's sessions valid again. Clear any `owner_auth_user_id` and membership that named the user, and
re-invite. The owner's next Email OTP sign-in creates a fresh row.

## Residual risks

- Race A and Race B are closed by N0 and the revocation in step 5, not by 004. That holds only while Neon enforces N0
  as P0 observed it, under the fingerprint P0 recorded. A Neon Auth upgrade calls for a new P0.
- R0 and the N0 effects are vendor behaviour. They are proven on a child branch and confirmed in production only by
  step 7.
- Until N1, an attacker who knows an invitee's address can make that identity contested, and the invitee is refused
  rather than taken over (Recovery). If Neon sends a verification email on sign-up under N0, the owner may also get
  one for a sign-up they never made. Completing it keeps the password, and 004 refuses the contested identity.
- A JWT minted before a revocation stays valid for up to 15 minutes, plus about 30 s of skew. It names nobody once 004
  is applied (above).
- A refused identity sees a generic sign-in message, not the reason.
- If Neon ever minted JWTs from a cached user snapshot, a user who verified moments earlier could be refused until
  the cache refreshes. That only affects rows that existed unverified before their first OTP sign-in. The proxy
  passes Neon only the session token cookie, never the session-data cache cookie.
- The Better Auth organization plugin is enabled upstream (GHSA-fmh4, 0 organizations). V1 never reads
  `auth.organization()`, and 004 does not change that.
- If a future Neon Auth release attached an account row to Email OTP users, every new user would be refused (fail
  closed). The catalog cannot show that, but the audit's I02 and I04 would.
- Each helper call now also probes `neon_auth.account` by its `"userId"` index and reads the JWT claims. RLS policies
  call `pool_platform_current_user_id()`, which is negligible at V1 scale.
- Email OTP rate-limit keying (Neon question I) is unchanged.
