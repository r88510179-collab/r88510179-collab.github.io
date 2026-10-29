# Commissioner CRM: read-only verification kit (prepared 2026-10-28, not yet run)

Four single-statement, read-only SQL files that establish the accepted post-AUTH-C production baseline before any
CRM migration is applied anywhere, and record the legacy validation branch before it is retired. None of them has
been executed. Each is one `SELECT`; each runs unchanged in psql, the Neon SQL Editor or one HTTP SQL call, and
each can be wrapped in `BEGIN READ ONLY; ... ROLLBACK;`. `src/migrations-contract.test.mjs` does not cover these
files; the single-statement and no-write properties are visible on inspection.

The production run of P1, P2, P3 and the two AUTH-C files is A1:

| File | Role |
| --- | --- |
| `A1_AUTHORIZATION.md` | the exact text the owner signed: target, controls, files and hashes, PASS and STOP conditions (unchanged) |
| `A1_RUNNER_ACK.txt` | the supplement the owner signs to accept runner version 2, and where it reads the authorization more strictly |
| `A1_SIGNING.md` | the owner's procedure: update the Mac checkout, preflight, sign the acknowledgment, approve, run |
| `a1_run.sh` | the operator's fail-closed runner, version 2: hash pins, guard, read-only wrapper, every row checked, HOLD or STOP |
| `a1_run.test.sh` | its regression suite: Linux, root, a network namespace with only loopback, a throwaway local PostgreSQL 18 |
| `a1_preflight_mac.sh` | the owner's Mac preflight: hashes, signatures, psql service entry and password file, without connecting |
| `a1_preflight_mac.test.sh` | its regression suite: a fake macOS home, a throwaway key, a fake psql that only reports its version |

Neither test suite connects to Neon or any other remote host; run them on a disposable Linux machine as root.

| File | Target | Reads | Verdict row | Expected |
| --- | --- | --- | --- | --- |
| `P1_identity_helpers_004.sql` | production | catalogs only | `H99` | `PASS` (the three helpers at 004's hardened fingerprints) |
| `P2_private_schema_inventory.sql` | production | catalogs and `pg_stat_all_tables` only | none (inventory) | the owner explains every object listed; dependencies in both directions by name (foreign keys, views, triggers, reviewed public functions or policies that name the schema) |
| `P3_crm_preconditions.sql` | production | catalogs; `X05` counts memberships and the `neon_auth` user/account rows they point at | `X99` | `PASS` (no CRM object yet; the seven RPC bodies at their baseline fingerprints) |
| `L1_legacy_branch_inventory.sql` | `br-orange-forest-b5nyu8ov` | catalogs and CRM table row counts; never `neon_auth` | none (inventory) | as the CRM README recorded; captured once, before retirement |

Alongside them, on production, in this order, as the same role:

1. `pool-platform/validation/neon-catalog-verify.sql` **from the AUTH-C candidate tree** (`git show
   2c6e2a805fa816638808cb2d96d430ee177453e6:pool-platform/validation/neon-catalog-verify.sql`), not the copy on the
   CRM branch, which predates AUTH-C: `C99` must be `PASS`.
2. `pool-platform/validation/neon-identity-audit.sql` from the same tree: `I99` must be `PASS`; counts only.
3. `migrations/008_post_auth_c_readonly_gate.sql`: the four `AUTH-C …` rows must be `PASS`; the other fifteen fail
   on production by design until the CRM migrations exist there.

## Authorization each run needs

- **Production (P1, P2, P3, the two AUTH-C files, 008):** a written owner authorization naming the branch
  (`production`, `br-hidden-darkness-b55g0j83`), the endpoint host recorded for the window, the exact files by
  commit SHA, the role (the migration owner), the wrapper (`BEGIN READ ONLY; ... ROLLBACK;`), and the output rule
  (verdict rows, counts and fingerprints only; no id, email, token or key; no `neon_auth` row). Run from the
  operator's machine with psql under the window's own `service=` guard, or in the Neon SQL Editor. Not through an
  AI session's Neon connection: production stays out of MCP reach (Neon's own guidance for MCP), and the standing
  connection in use on 2026-10-28 was unscoped, write-capable and ADMIN.
- **Legacy branch (L1, then 008):** the same shape, naming `br-orange-forest-b5nyu8ov`. The 2026-10-24 freeze
  rule still holds for that branch's `neon_auth` schema: L1 never reads it. Capture the outputs beside the K4-style
  retirement record (branch listing without the branch; its Auth base URL no longer serving `/.well-known/jwks.json`).

## Recording

Keep each output as the file's rows in a text table, with the commit SHA of the SQL file, the UTC time, the branch
id and the role name. Record `H99`, `X99`, `C99`, `I99` and the 008 rows; record P2 and L1 in full. Nothing else from
the session is written down.
