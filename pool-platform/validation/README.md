# Commercial V1 Step 2: live Neon validation kit

Two read-only SQL files for the dedicated commercial/dev Neon database, used by `docs/STEP2_RUNBOOK.md` (steps 6,
7 and 10). Neither has run against Neon yet.

- `neon-preflight.sql`: after Neon Auth and the Data API are provisioned, before 001/002.
- `neon-catalog-verify.sql`: after 001/002.

Each file is one `SELECT` over the system catalogs, so it runs unchanged in psql, the Neon SQL Editor or a single
HTTP SQL call, and it writes nothing. `migration-contract.test.mjs` checks that each file is a single statement
with no write keyword or side-effecting function, and `migration-integration.test.mjs` runs both inside
`BEGIN READ ONLY`. Run them as the role that runs and owns the migrations:

    psql "$COMMERCIAL_DEV_URL" -X -v ON_ERROR_STOP=1 -f pool-platform/validation/neon-preflight.sql
    psql "$COMMERCIAL_DEV_URL" -X -v ON_ERROR_STOP=1 -f pool-platform/validation/neon-catalog-verify.sql

## Reading the output

Every row has `check_id`, `check_name`, `required`, `expected`, `actual` and `ok`.

- `required = true`: a gate. It passes only when `ok` is `true`.
- `required = false`: informational. Copy `actual` into the validation report.
- `P99` / `C99`: the verdict. `PASS` only when every required row passes; otherwise it names the failing checks.
  Anything but `PASS`, or an error while running the file, is a STOP.

## The contract after migration 002

002 resets each of the 9 commercial tables with `REVOKE ALL PRIVILEGES ... FROM PUBLIC,anonymous,authenticated
CASCADE` before granting `SELECT` to `authenticated`, and resets the audit identity sequence the same way. So:

- `anonymous`: no privilege on any commercial table, including through PUBLIC
- `authenticated`: `SELECT` only, without grant option; on PostgreSQL 17 no `MAINTAIN` (no LOCK, VACUUM, ANALYZE,
  REINDEX or CLUSTER)
- no column privileges, and no sequence privileges for anyone but the owner
- internal helpers callable by the owner only; `EXECUTE` for `authenticated` on the 4 RLS helpers and 6 RPCs only

This holds with clean default privileges and with hostile ones or earlier unwanted grants (ALL, grant options and
re-grants, PUBLIC, column and sequence grants), on PostgreSQL 16 and 17.

## Preflight rows

| ID | Gate | Checks |
|---|---|---|
| P01 | yes | PostgreSQL major version 16 or 17, the versions the local suites verify |
| P02 | report | database and its oid, current_user, session_user, search_path |
| P03 | yes | database is not `nfl_pool`, the personal Pool Center database |
| P04 | yes | no `nfl_pool_weeks` or `nfl_survivor_weeks` relation and no `nfl_survivor_*` policy in any schema |
| P05 | yes | fresh database: no `pool_platform_*` relation or function in `public` |
| P06 | yes | roles `anonymous` and `authenticated` exist, are not superusers and have no BYPASSRLS |
| P07 | yes | `auth.user_id()` exists and returns text |
| P08 | yes | the migration role has USAGE on `auth` and EXECUTE on `auth.user_id()` |
| P09 | report | `pg_session_jwt` extension |
| P10 | yes | `neon_auth."user"` exists |
| P11 | yes | its `id`, `email` (text or varchar), `"emailVerified"` and `banned` (boolean) columns |
| P12 | yes | the migration role can read those four columns, with USAGE on `neon_auth` |
| P13 | yes | pgcrypto not installed yet, or installed in `public` |
| P14 | yes | the extension creation schema (first schema on the search_path) is `public` |
| P15 | yes | the migration role can CREATE in `public` |
| P16 | yes | the migration role is not a superuser and not a Data API role |
| P17 | yes | `anonymous`/`authenticated` do not belong, directly or through other roles, to the migration role, a superuser or BYPASSRLS role, or a privileged predefined role such as `pg_read_all_data`, `pg_write_all_data` or `pg_maintain` |
| P18 | yes | PUBLIC has no CREATE on `public` (002 revokes it only from `anonymous` and `authenticated`) |
| P19 | report | default privileges 002 resets: PUBLIC/`anonymous`/`authenticated` on the tables, sequence and functions the migration role creates in `public`; on PostgreSQL 17 table defaults can include `MAINTAIN` |
| P20 | yes | default privileges 002 does not reset: any other grantee on those object types |
| P21 | report | every default privilege in the database |
| P99 | verdict | |

## Catalog verification rows

| ID | Gate | Checks |
|---|---|---|
| C01 | report | server version |
| C02 | yes | exactly the 9 `pool_platform_*` tables |
| C03 | yes | RLS enabled on all 9 |
| C04 | report | FORCE RLS (the SECURITY DEFINER functions rely on the owner's bypass) |
| C05 | yes | `UNIQUE (week_id, entry_id)` on submissions |
| C06 | yes | `pool_platform_pool_slug_global_unique` |
| C07 | yes | `pool_platform_submissions_survivor_team_unique`, partial on string teams |
| C08 | yes | exactly one user trigger on the 9 tables: the source guard, BEFORE UPDATE FOR EACH ROW, enabled |
| C09 | yes | exactly the 9 reviewed policies, each permissive FOR SELECT TO `authenticated` |
| C10 | yes | exactly the 14 reviewed function signatures; 13 SECURITY DEFINER with the pinned search_path; one owner |
| C11 | yes | effective EXECUTE: internal helpers owner-only; RLS helpers and RPCs `authenticated` only |
| C12 | yes | function ACL entries: exactly `authenticated:EXECUTE` without grant option on those 10 |
| C13 | yes | effective table privileges: `anonymous` none, `authenticated` SELECT only (MAINTAIN checked from 17) |
| C14 | yes | table ACL entries: exactly `authenticated:SELECT` without grant option, granted by the owner |
| C15 | yes | no CREATE on `public` for `anonymous` or `authenticated` |
| C16 | yes | no privilege on `pool_platform_*` sequences for anyone but the owner |
| C17 | yes | no other public function callable by `anonymous`/`authenticated`, pgcrypto aside |
| C18 | yes | pgcrypto installed in `public` (002 calls `digest` and `gen_random_bytes` unqualified) |
| C19 | yes | `anonymous`/`authenticated` are not superusers and have no BYPASSRLS |
| C20 | yes | one table owner, not a Data API role, not a superuser |
| C21 | yes from 17, report on 16 | `authenticated` holds `MAINTAIN` on no commercial table |
| C22 | yes | no column privileges |
| C23 | report | pgcrypto functions callable by `anonymous`/`authenticated`; the live Data API check (runbook step 11) decides whether that matters |
| C24 | yes | the owner can call `auth.user_id()` and read `neon_auth."user"` |
| C25 | yes | `authenticated` has USAGE on `public` |
| C26 | yes | not the personal Pool Center database |
| C99 | verdict | |

## Local evidence (disposable local clusters, never Neon)

PostgreSQL 16.13 (Ubuntu 24.04 package) and PostgreSQL 17.10 (`@embedded-postgres/linux-x64` 17.10.0-beta.17
binaries), both on 127.0.0.1.

| Check | PostgreSQL 16.13 | PostgreSQL 17.10 |
|---|---|---|
| `migration-integration.test.mjs` | 27/27 pass | 27/27 pass |
| same suite with the unfixed 002 (`c0c9e24`) | 7 fail: grant-option re-grants abort 002 (`dependent privileges exist`), PUBLIC and sequence grants survive | 8 fail: the same, plus `authenticated` keeps `MAINTAIN` under hostile table defaults |
| unfixed 002, hostile table defaults: `neon-catalog-verify.sql` | PASS | FINDINGS: C13, C14, C21 |
| fixed 002, hostile table, sequence and function defaults: `neon-catalog-verify.sql` | PASS | PASS |
| `neon-preflight.sql`, clean or hostile PUBLIC/`anonymous`/`authenticated` defaults | PASS | PASS |
| 002 applied before Neon Auth, `psql --single-transaction` | stops at line 49 (`relation "neon_auth.user" does not exist`); nothing of 002 is left | same |

The integration suite also shows that each single fault (an extra table or column grant, a grant option, EXECUTE
on an internal helper, an extra trigger, RLS disabled, a changed policy, a sequence grant, an extra public
function, the owner losing `neon_auth."user"`) fails exactly the catalog rows expected for it, and that each
unsafe preflight condition (no Neon Auth, a default 002 does not reset, a used database, a superuser, a personal
Pool Center table or database name, PUBLIC CREATE, a non-public extension schema, pgcrypto elsewhere,
`authenticated` inheriting the migration role) stops exactly the rows expected for it.

## Changes from the first draft of this kit (`41eae1a`)

- The PostgreSQL 17 `MAINTAIN` finding recorded there is fixed in 002. The candidate fix it noted,
  `REVOKE ALL ... FROM anonymous,authenticated`, is not enough on its own: it aborts with `dependent privileges
  exist` once `authenticated` has passed on a grant option, and leaves PUBLIC grants in effect, so 002 also names
  PUBLIC and uses CASCADE. It also resets the audit identity sequence, which picks up sequence default privileges.
- P14, which predicted `MAINTAIN`, is replaced by P19 (defaults 002 resets, report) and P20 (defaults it would
  leave, gate). The old P14 would stop a PostgreSQL 17 environment over defaults 002 now handles.
- The catalog check no longer fails on pgcrypto: C17 skips pgcrypto's functions and C23 reports them.
- New rows: owner access to `auth.user_id()` and `neon_auth."user"` (P08, P12, C24), PUBLIC CREATE (P18), the
  migration role (P16), transitive memberships (P17), exact policies and signatures (C09, C10), no extra trigger
  (C08), column privileges (C22), `MAINTAIN` (C21), the personal database guard after migration (C26), and a
  verdict row in each file.
- The activation order lives in `docs/STEP2_RUNBOOK.md`, now corrected.
