# Pre-registration takeover hardening

Status: implementation candidate on branch `commercial-v1-pre-registration-hardening`, built on the production SHA
`48e0ac4`. Not reviewed, not applied to any database, not deployed. No Neon setting has been changed. Everything
below that touches Neon is a plan.

## The finding

Neon Auth (Managed Better Auth) lets anyone call the public `/sign-up/email` on the Neon Auth host with any address
and a password. The address owner's first Email OTP sign-in then verifies that same user row. On Better Auth before
1.6.22 (GHSA-qq9h-g4jm-xgf3, also filed as CVE-2026-67327), the password survives, so whoever registered it signs in
as the owner from then on. Fixed versions delete the unproven password and revoke its sessions at that sign-in, but a
JWT already minted from such a session stays valid at the Data API for its 15 minutes. The live Neon Auth host
fingerprints between 1.6.18 and 1.6.33, so whether it carries the fix is undetermined.

Before this candidate, V1 named a caller from `auth.user_id()` and the user row alone (present, not banned). The
email-bound invite check added the stored `"emailVerified"`. Once the owner has verified, a password holder sharing
the row passes both.

## Evidence (all read-only, 2026-10-07)

- `neon_auth."user"."emailVerified"` is `boolean NOT NULL`. `neon_auth.account` holds `"userId" uuid` (foreign key to
  `neon_auth."user".id`, `ON DELETE CASCADE`), `"providerId"` and `password`, has no RLS, and is readable by the
  migration owner (`neondb_owner`) but not by `authenticated`.
- `auth.session()` (pg_session_jwt 0.5.0) returns the JWT payload as jsonb. With no JWT it returns JSON `null` without
  error, and `auth.user_id()` returns NULL. The owner can execute it.
- Neon documents the JWT payload as the default user object, with `"emailVerified"` a JSON boolean, and custom claims
  are not supported (docs: Auth > Plugins > JWT). The same example's `"role": "authenticated"` is the claim the live
  harness required of every live JWT in runbook step 11 (`S-*-claims`).
- The three live identity helper bodies are byte-identical to 002 as of `48e0ac4` (SHA-256 of `pg_proc.prosrc`).
- Design-phase aggregates: 5 verified Email-OTP users, none with an account row; 6 unverified synthetic password users
  (`pp-cv1-*@example.com`); 0 OAuth users. All 3 entry owners are OTP-only, and 2 of the 3 memberships are held by
  synthetic password users.
- Neon Auth config: `email_password.enabled` true, `allow_sign_up` true, `verify_email_on_sign_up` false,
  `require_email_verification` false, Google shared OAuth on, `allow_localhost` true, `trusted_origins` [].

## Trust model

Every RLS policy and RPC names its caller through three SECURITY DEFINER helpers in 002:
`pool_platform_current_user_id()`, `pool_platform_current_user_email()` and
`pool_platform_current_user_has_verified_email(text)`. Each now applies one rule in one query. The caller is the user
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

The bearer model of unbound invites is unchanged: any identity holding the link may claim it, with no email match.
What changed is who counts as an identity at all. A contested user (one with a password or OAuth account) would bind the
entry to an id that the password holder shares, so a bearer claim is refused for it too. The same goes for a stale JWT.

Where it is enforced, and why there:

- **Database (the only boundary).** The browser calls the Data API directly with a Neon Auth JWT, and anyone can mint
  one from the public Neon Auth host, so neither the same-origin proxy nor the browser is on the attacker's path. The
  proxy keeps its contract (it never makes an authorization decision) and is unchanged. So are `auth-core.js`, the
  participant page and the client.
- **The claim RPC** is unchanged: its `auth_required`, `invite_email_mismatch` and `invite_email_unverified` checks now
  run on the hardened helpers.
- **The client** shows a refused identity as it shows any persistent `auth_required`: one retry, then "Your sign-in
  could not be confirmed. Try again, or sign out and sign in again." Signing in again mints a fresh JWT, which clears
  the stale-JWT case. A contested user needs the operator (see Recovery).

Files: `migrations/002_identity_submission_rls.sql` (the hardened helpers);
`migrations/004_identity_pre_registration_hardening.sql` (the forward migration for the live database, as 003 is for
`submit_entry`: a guard, the three definitions byte for byte as 002 has them, and 002's privilege statements); and
`validation/neon-preflight.sql` (P22, P23) and `validation/neon-catalog-verify.sql` (C24), for the two new
prerequisites. 002 carries the fix itself because re-applying 002 is a supported operation, and it must not undo
the hardening.

## Neon Auth configuration plan (not executed)

| | N1: `email_password.allow_sign_up` | N2: Google OAuth provider |
|---|---|---|
| Current (read 2026-10-07) | `true` | `google`, type `shared` |
| Desired | `false` | removed |
| Purpose | stop public `/sign-up/email`, the pre-registration path | remove OAuth sign-up and linking by address, the GHSA-g38m class |
| Public sign-up | refused | no Google sign-up |
| Email OTP sign-in, existing users | unaffected (sign-in, not sign-up) | unaffected |
| First-time Email OTP sign-in (new invitee) | **UNPROVEN**: Better Auth's emailOTP has its own `disableSignUp`, and how Neon maps `allow_sign_up` is unknown. If it also gates OTP sign-up, no new participant can join | unaffected |
| Existing users | none signs up again; the 6 synthetic password users can still sign in, and 004 refuses them | 0 OAuth users |
| Invited users, unbound invites | depend on the OTP row above | none |
| Rollback | `allow_sign_up` back to `true` | re-add `google` shared |
| Reversible | yes | yes |
| Migration or reverification | none | none |
| Order | after 004 and after proof P1 on a child branch | with N1 |

Deliberately unchanged:

- `require_email_verification`: per the reassessment, it does not stop the takeover, because the owner's own OTP
  verifies the row. 004 already refuses the pre-verification JWTs it would prevent.
- `email_password.enabled`: Neon documents Email OTP as needing "Sign-up and Sign-in with Email", so turning it off may
  disable OTP. That is unproven, and N1 makes it unnecessary.
- `allow_localhost` and trusted domains: no bearing on this finding (F-1 diagnostic).

Proofs needed before any production change, on a Neon child branch, never production:

- **P1.** With N1 and N2 applied on the child, a first-time Email OTP sign-in for a new address succeeds. An existing
  OTP user signs in, and `/sign-up/email` is refused.
- **R0.** A JWT from a verified Email-OTP sign-in carries `"emailVerified": true` as a JSON boolean (record claim keys
  and that value only). This is the one 004 premise taken from vendor documentation rather than observed.

## Rollout order: A (application first, then Neon)

1. R0. If the claim is absent or not a boolean, STOP: 004 would refuse every user (fail closed, reversible).
2. Apply 004 as the migration owner with `--single-transaction`. Re-run `neon-catalog-verify.sql` (C99 `PASS`) and
   check the three helper fingerprints against the 004 guard's hardened column. Then sign in as D, E and A and confirm
   participant and commissioner context load.
3. P1 on a child branch.
4. N1 and N2 on production. Then confirm an existing user's OTP sign-in.

Why A:

- 004 closes the takeover inside V1 whatever the Neon Auth version is: the contested identity is refused where the
  password survives, and the stale JWT is refused where it does not. It also covers the 6 rows registered before N1.
  Its only lockout risk is R0, checked first and undone in one step.
- B (Neon first) would leave V1 protected only by a setting whose effect on first-time OTP sign-up is unproven. If N1
  gates OTP sign-up, B locks out every new invitee. Until 004 lands, B also leaves V1 trusting any credential path
  N1 and N2 do not cover.
- C (atomic) is not needed. No intermediate state reopens the takeover. After 004 and before N1, the residual is a
  denial of service: someone who pre-registers an invitee's address makes that invitee's identity contested, and the
  invitee is refused rather than taken over (see Recovery). N1 removes it.

Unsafe orders:

- 004 without R0: risks refusing everyone.
- N1 without P1: risks refusing every new invitee.
- Neon changes without 004: leave the identity rule to vendor configuration alone.

## Existing users

- 5 verified OTP users (including the gate identities D, E and A): unaffected, provided R0 holds. No reverification.
- 6 unverified synthetic password users: refused by 004, and the 2 memberships they hold become inert. Nothing is
  required. A later cleanup (delete the users, which cascades their accounts and sessions; memberships and
  `entries.owner_auth_user_id` have no foreign key) is a separate operator decision.
- The live validation harness (`validation/live/`) signs up password identities, so after 004 and N1 it can no longer
  act. It needs a redesign before any further live run. Its local rehearsal takes the stub from
  `migration-integration.test.mjs`, and its mock Data API sets no JWT claims, so the rehearsal now refuses every
  identity too.

## Rollback

- 004: as the migration owner, in one transaction, run the three helper definitions from 002 as of `48e0ac4`
  (`git show 48e0ac4:pool-platform/migrations/002_identity_submission_rls.sql`), followed by the four privilege
  statements that end 004. The helpers then hash to the guard's pre-hardening column again, so 004 can be re-applied
  later. Re-run `neon-catalog-verify.sql` (C99 `PASS`).
- N1: `allow_sign_up` back to `true`. N2: re-add the `google` shared provider.

## Recovery for a contested identity

A user refused because their row carries a password or OAuth account cannot fix it by signing in again. Delete the
Neon Auth user, which cascades its accounts and sessions. Clear any `owner_auth_user_id` and membership that named it,
and re-invite. The owner's next Email OTP sign-in creates a fresh row.

## Residual risks

- R0 is vendor-documented and corroborated, not yet observed on a decoded live JWT.
- Until N1, an attacker who knows an invitee's address can deny that invitee access (above).
- A refused identity sees a generic sign-in message, not the reason.
- If Neon ever minted JWTs from a cached user snapshot, a user who verified moments earlier could be refused until
  the cache refreshes. That only affects rows that existed unverified before their first OTP sign-in. The proxy
  passes Neon only the session token cookie, never the session-data cache cookie.
- The Better Auth organization plugin is enabled upstream (GHSA-fmh4, 0 organizations). V1 never reads
  `auth.organization()`, and 004 does not change that.
- If a future Neon Auth release attached an account row to Email OTP users, every new user would be refused (fail
  closed). The catalog cannot show that; an aggregate of OTP users' account rows would.
- Each helper call now also probes `neon_auth.account` by its `"userId"` index and reads the JWT claims. RLS policies
  call `pool_platform_current_user_id()`, which is negligible at V1 scale.
- Email OTP rate-limit keying (Neon question I) is unchanged.
