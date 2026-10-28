# A1: read-only verification of the Commercial V1 production baseline (authorization text)

**Status: DRAFT for the owner's approval. Nothing below has run.** Approval is the owner's signature on this exact
text (record this file's SHA-256 at signing) plus a separate "run A1 now" message. The run is the operator's, with
psql, from the operator's machine. No AI session connects to production for it.

## 1. Target: every item must match, and the script refuses to run otherwise

| Item | Value | Source |
| --- | --- | --- |
| Neon project | `fancy-brook-65396623` (`pool-platform-commercial-dev`), organization `org-dawn-leaf-10280035` | Neon project record |
| Branch | `production`, `br-hidden-darkness-b55g0j83` (default, primary) | Neon branch record |
| Database and owner | `neondb`, owned by `neondb_owner` | Neon database record |
| Endpoint | `ep-still-recipe-b5g7680z`; host `ep-still-recipe-b5g7680z.c-7.us-east-2.aws.neon.tech` (the direct host, not `-pooler`) | Neon endpoint record |
| Server | PostgreSQL 18 (`C01` reports the exact version) | Neon project record |
| Role | `neondb_owner`, the migration owner (`H07` and `C20` report it) | Neon database record |

## 2. Path and controls

- The operator's machine, `psql`, a `service=` entry that exists only there (never in a repository, a chat, a cloud
  session or this file). `PSQL_HISTORY=/dev/null`, `umask 077`, outputs in a private directory outside any
  repository and any synced folder.
- On every connection the guard runs first: psql's `:HOST` must equal the host above, `current_database()` must be
  `neondb` and `current_user` must be `neondb_owner`; otherwise `\quit` and no file runs.
- Each file runs inside `BEGIN READ ONLY; … ROLLBACK;` with `ON_ERROR_STOP`. A file that errors stops the run and
  the error is recorded as a STOP.
- `validation/a1_run.sh` does all of this and refuses a file whose SHA-256 differs from §3. The Neon SQL Editor is
  the fallback if psql is unavailable: same files, same order, same output rule, hashes checked by hand.

## 3. Files, in this order, each checked by SHA-256 before it runs

| # | File | Source | SHA-256 | git blob |
| --- | --- | --- | --- | --- |
| 1 | `pool-platform/commissioner-crm/validation/P1_identity_helpers_004.sql` | session branch `ccr-321cd6b3-fu8f1j` | `9ef14dea4ea0f0ff9270b06eb05339f7dfe114accf9c6264d7dd810a979666ae` | `fb068fde` |
| 2 | `pool-platform/commissioner-crm/validation/P2_private_schema_inventory.sql` | session branch | `234b81f89d328107ff86b0564c32e57f25f220c8ad8da053dc2cbf82731e39d1` | `ada5d830` |
| 3 | `pool-platform/commissioner-crm/validation/P3_crm_preconditions.sql` | session branch | `f652ecad1d7adcc1f474d1b0af9753e7a8aec1e14567d03cb350c1312cd2333d` | `41f2280d` |
| 4 | `pool-platform/validation/neon-catalog-verify.sql` | AUTH-C candidate `2c6e2a805fa816638808cb2d96d430ee177453e6` | `40b20416909c0ca2c26e2e682cb4ad2c5ef0b87fc257ca79d259dce55a0e9b43` | `3e95013f` |
| 5 | `pool-platform/validation/neon-identity-audit.sql` | AUTH-C candidate `2c6e2a805fa816638808cb2d96d430ee177453e6` | `d512b94f8281fd201bcecb3efae3eb39fda2ab372b921d8f4a224bec012dca61` | `592fc1dd` |

Files 4 and 5 are the AUTH-C candidate's, not the older copies on the CRM branch. The CRM's own 008 gate is not
part of A1: on production its four AUTH-C rows are implied by `H01`, and its other rows cannot pass until the CRM
exists there.

## 4. What is read, and what is never read

Read: `pg_catalog` and `information_schema`; `pg_stat_all_tables` (P2, approximate row counts only); counts over
`public.pool_platform_memberships`, `neon_auth."user"` and `neon_auth.account` (P3 `X05`); counts over
`neon_auth."user"`, `neon_auth.account`, `neon_auth.session`, `public.pool_platform_memberships` and
`public.pool_platform_entries` (the identity audit).

Never: a write or DDL of any kind; a setting change; a row of `neon_auth.jwks`, `neon_auth.verification`, a
session token, an account password; an id, email, token, key, password or connection string in any output; any
branch other than `production`; any connection from an AI session or through the Neon MCP server.

## 5. Expected results (PASS conditions)

| File | PASS | STOP |
| --- | --- | --- |
| P1 | `H01` all three helpers `hardened`; `H02` SECURITY DEFINER, `search_path=public, neon_auth, pg_temp`, owned by the table owner; `H03` `authenticated` executes only `current_user_id()`; `H04` `auth.session()` returns `jsonb`; `H05` `neon_auth.account."userId"` present; `H06` owner reach true; `H07` reports `neondb_owner`; **`H99 PASS`** | any `PRE-HARDENING`, `MISSING` or `UNREVIEWED` helper; any required row false |
| P2 | an inventory: every `schema`, `relation` and `function` row is explained by the owner from the window record, or the schema is absent; no `dependency … named by reviewed public object` row; `usage: anonymous=false authenticated=false` | an unexplained object; a reviewed public function or policy that names the schema; USAGE for a Data API role |
| P3 | `X01` none; `X02` none; `X03` constraint absent and index absent; `X04` all seven `baseline`; `X05` recorded; `X06` pgcrypto in `public`; **`X99 PASS`** | any CRM object already present; any RPC body `OTHER` or `MISSING` |
| AUTH-C verifier | **`C99 PASS`**; `C23` recorded; `C21` PASS (PostgreSQL 18) | any required `C` row false |
| Identity audit | **`I99 PASS`** (`I05=0`, `I06=0`); `I01` to `I04`, `I07`, `I08` recorded; `I07` total at most the four window sessions (D, E, A) while they last, all of verified users with no account row | a live session of an unverified or account-holding user; an `I04` identity with V1 standing not yet recovered |

Any STOP ends the run; nothing of A2 to A6 proceeds until the owner has reviewed the recorded output.

## 6. Output and redaction rule

Record: the verdict rows, every `check_id` row's `required`, `actual` and `ok`, the UTC start and end, the branch
id, the role name, the five file hashes and the script's hash, and `sha256sums.txt` of the outputs. Review before
anything is shared: P2 comments and ACL strings, and the `actual` strings of C and X rows (they may hold role names
and function signatures; by construction never an id, email or token). The raw output files stay in the private
directory. Nothing else from the session is written down.

## 7. Signature and run approval

    I authorize A1 exactly as scoped above (target §1, path §2, files §3, reads §4), as a read-only run.
    Owner: ______________________   Date/time (UTC): ______________________
    Signed-text SHA-256 of this file: ______________________

    Run approval (separate): "Run A1 now."
    Owner: ______________________   Date/time (UTC): ______________________
