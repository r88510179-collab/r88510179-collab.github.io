# Commercial V1 Step 2: live Neon validation kit

Status: live validation has not started. The first attempt stopped before provisioning: the session had no Neon
credentials, and its network policy denied `*.neon.tech` and `cdn.jsdelivr.net`. Nothing in this folder has run
against Neon yet.

Reviewed candidate: `c0c9e24f38902e01cc0fdd646daa95c322a3aee1` (`commercial-v1-step2-submissions`).
These files do not change the reviewed migrations or app code.

## Files

- `neon-preflight.sql` is read-only. Run it after Neon Auth and the Data API are enabled and before 001/002.
  Any row with `ok = false` is a STOP. P03/P04 refuse the personal Pool Center database (`nfl_pool`,
  `nfl_pool_weeks`, `nfl_survivor_weeks`). P14 predicts whether 002 would leave `authenticated` with a table
  privilege it does not revoke (PG17 `MAINTAIN`).
- `neon-catalog-verify.sql` is read-only. Run it after 001/002. Any row with `ok = false` is a finding.

Each file is one `SELECT`, so it runs unchanged in psql, the Neon SQL Editor, or a single HTTPS SQL call. The
Claude cloud container cannot use psql against Neon: its egress proxy carries HTTPS only, not raw TCP on 5432.

## Order on a fresh commercial/dev branch

1. Enable Neon Auth. It provides `neon_auth."user"`.
2. Enable the Data API. It provides the `anonymous`/`authenticated` roles and `auth.user_id()`.
3. `neon-preflight.sql`: no `ok = false`.
4. `001_foundation.sql`, then `002_identity_submission_rls.sql`. Apply each as one transaction that stops on the
   first error, for example `psql -v ON_ERROR_STOP=1 --single-transaction -f <file>`.
5. `neon-catalog-verify.sql`.

`docs/STEP2_RUNBOOK.md` §2 applies the migrations before §3 enables Auth and the Data API. On a fresh branch
that order fails. Locally, 001+002 without `neon_auth` stopped at the first identity helper
(`relation "neon_auth.user" does not exist`), and the single transaction left 0 relations behind.

## Local evidence (disposable local clusters, never Neon)

The integration suite runs both migrations under hostile default privileges: `GRANT ALL ON TABLES` and
`EXECUTE ON FUNCTIONS` to `anonymous` and `authenticated`.

| Check | PostgreSQL 16.13 | PostgreSQL 17.10 |
|---|---|---|
| `migration-integration.test.mjs` | 19/19 pass | 18/19: the grants test finds `authenticated:MAINTAIN` |
| `neon-catalog-verify.sql`, hostile defaults | only C17 fails | C13 and C14 (`MAINTAIN` on all 9 tables) and C17 fail |
| `neon-catalog-verify.sql`, clean defaults | only C17 fails | only C17 fails |
| Patched copy of 002 (see below): suite / catalog, hostile | 19/19 / only C17 fails | 19/19 / only C17 fails |
| `neon-preflight.sql` without Neon Auth | not run | P07, P09 and all four P10 rows fail |
| `neon-preflight.sql`, hostile / clean defaults | all pass / not run | P14 fails (`MAINTAIN`) / all pass |

## Findings recorded here, not fixed

These were deferred per the validation brief.

- **PG17 `MAINTAIN`.** 002 removes `INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER` from `authenticated`
  rather than `ALL`. On PG17, a default privilege that grants `ALL` or `MAINTAIN` on tables therefore survives.
  With it, `authenticated` could run `LOCK TABLE … IN ACCESS EXCLUSIVE MODE`, `VACUUM` and `REINDEX` on the
  commercial tables (checked locally). Whether this happens live depends on the default privileges Neon's Data
  API actually installs; preflight P14 shows them before anything is applied. A candidate fix, tested only on a
  copy, turns the nine `REVOKE ALL ON public.pool_platform_<table> FROM anonymous;` lines into
  `… FROM anonymous,authenticated;` (they run before the `GRANT SELECT` lines). It passed 19/19 on PG16 and PG17.
- **pgcrypto in `public`.** 001 installs pgcrypto into `public`: 36 functions, callable by `PUBLIC` and so by
  `anonymous` and `authenticated` at the SQL level. Whether the Data API exposes them as RPCs has to be checked
  live (catalog check C17).
