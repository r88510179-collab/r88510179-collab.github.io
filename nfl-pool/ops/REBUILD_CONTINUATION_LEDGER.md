# Personal database rebuild: continuation ledger

Repository `r88510179-collab/r88510179-collab.github.io`, branch `ccr-86fdd383-ucy01u`. Additive: the newest section is last.
Nothing here touches Neon, a production database, a permission, a deployment, a backup schedule or a secret, and Personal
#43, #44 and #45 were not touched. The rebuild gate and everything it runs are for a throwaway PostgreSQL only.

## Resolution of the review of `bf91cf9` (2026-11-25)

### Starting point
- The branch tip, checked against GitHub before anything changed, is `bf91cf94cdb4ce52d4b38d4c33c8f8d5259a5931`, two commits above
  `ef82b37` (main): `26c5df5` "rebuildable from the repository alone" and `bf91cf9` "catalog comparison with the live shape, and a
  harder rebuild gate". No pull request exists for the branch (and none was opened: it was not asked for).
- **The findings came from the owner's instruction** (the five below, with their sub-points). No document called "Checkpoint 10"
  exists in anything this session could read (the three local checkouts and all their refs, and a code search of the owner's
  repositories), so the review's own wording was not checked against the findings as given.
- **Preserved evidence.** `catalog-snapshot.sql`, the migrations, `backup-role-delta.sql`, `neon-shape.sql`, the fixtures, the
  behavior and full-field-guard suites have no diff against `bf91cf9`. The baseline was run once, unchanged, before any edit
  (PostgreSQL 17.12: passed; migrations-only catalog `2c42b3a6985ed8d604cbb30ee352ab8c68dbb5f8afba8dbcf74d1ea91f28ce3c`;
  production shape `7f1b05a83ab6578a87455528b58d5dd04486ca5b4fcb91408f8d1cefd4b9d45d`, 16 policies, 121 privilege rows; guard
  9/9; behavior 409/409) and the same values come out of the changed gate. The baseline was not recreated and the completed live
  audit was not repeated; the real database was not read.

### Commits
| Commit | What |
| --- | --- |
| `bf91cf94cdb4ce52d4b38d4c33c8f8d5259a5931` | the reviewed head |
| `7a01ce61de93a472c49527479ac11755f2173704` | the resolution: tool, gate, SQL, both test files, the CI step, the documentation |
| the commit that adds this file | the ledger only. CI for the branch head is read from the branch's checks; a commit cannot name its own run |

### The findings and what was done
| # | Finding | Resolution | Shown by |
| --- | --- | --- | --- |
| 1 | Strict catalog comparison: exactly the eleven documented backup-role differences, right direction, objects, SELECT only, grant options, policy definitions; reject unexpected write grants, missing read grants and overbroad policies; strict equality against the adjusted production shape | `compare-catalog.py --documented-backup-role`: the first snapshot must equal the migrations-only one plus exactly the eleven rows (six privilege rows with no grant option, five permissive `FOR SELECT` policies `TO` the role alone with `USING (true)`), by strict row equality; each deviation is material and explained; the documented rows given the wrong way round, or already in the second snapshot, exit 2. The wildcard `--env-role` is removed. `rebuild.sh` uses the same check on its own production-shape database, replacing an assertion that only counted rows. | `test_compare_catalog.py`: every missing row, seven write privileges, sequence USAGE and UPDATE, a grant option, a read grant on another table, column, function or sequence, another role, eight policy variants, a sixth or doubled policy, the wrong direction, a partial second snapshot, other drift beside the eleven rows; six regressions of the tool each fail the tests |
| 2 | Rebuild lifecycle: overlapping executions; cleanup only of what this execution owns; cleanup failure nonzero; test simultaneous invocations and failed cleanup on disposable infrastructure | A lock role created atomically (the second execution stops, touches nothing, names the holder); every created role and database marked with the execution's own identifier as it is made; cleanup drops only what carries the mark, databases, roles, lock last, and names anything else; a failed cleanup exits 3 (1 after a failed run) with a "cleanup incomplete" line; INT, TERM, HUP end through the same cleanup | `test_rebuild_lifecycle.sh`: four invocations started together, one builds and runs every suite, three are refused, the cluster is as found; a role that cannot be dropped: exit 3, role named, next run refuses; a failed run with failed cleanup; a changed mark on a role and on a database: not dropped, exit 3; SIGTERM: 143 and a clean cluster; foreign database, role, lock kept. 18 of the 49 checks fail against the script of `bf91cf9` |
| 3 | Snapshot validation: all sections, valid rows, legitimate null aggregates, exit 2 for malformed or incomplete, no equality shortcut for incomplete documents | Validation before any comparison, whatever the hash; a section may be null; rows are checked for length, type and (policy command, privilege kind, function hash) set; duplicate sections, empty, truncated, noisy or two-document files are refused; `--validate` mode; `rebuild.sh` validates and compares through the tool, not by text (two empty snapshots were "the very same catalog") | unit tests: every missing section, unknown section, non-object, sixteen malformed-row kinds, identical incomplete documents, null aggregates, file problems; the hash-shortcut-first regression fails them |
| 4 | Environment and privilege reporting: predefined-role memberships and inheritance; explicit versus inherited versus effective; correct the documentation about the older backup role | `environment-snapshot.sql`: memberships including predefined roles with admin, inherit and set options and the effective `inherits`; role attributes (inherit, replication, connection limit); effective privileges per role, table and sequence with `explicit`, `effective`, `via` and whether row-level security applies; its ordering by constants fixed. The tool notes superusers, bypassing roles, predefined memberships and effective-but-not-explicit access. `CATALOG_COMPARISON.md` corrected: the old line "holds none" is about explicit grants; the older login's access through `pg_read_all_data` and `BYPASSRLS` is recorded as the review reported it | `rebuild.sh` stage 5 on the production-shape database beside two synthetic roles reading through `pg_read_all_data`: membership and inheritance, the explicit/effective/via split, the exemption, and that the scoped backup role holds nothing but SELECT, explicit or inherited; unit tests of the notes |
| 5 | Operational correctness: connection-string behavior; failing snapshot writes; no credentials in output | One supported form, `postgresql://postgres@HOST[:PORT]/postgres` (loopback host), enforced and documented: the URL's user, password and database used to be accepted and silently ignored; a password, other user or database, query string, several hosts or a port above 65535 is refused and the value is never printed; `PGPASSWORD` is the way for a superuser that needs one, and the gate's roles need `trust`. `REBUILD_SNAPSHOT_DIR` is probed first and a file that cannot be written fails the run | lifecycle checks: fourteen URLs and five variables refused with nothing built and no password echoed, a missing directory and a file instead of one, an unwritable directory (non-root), a file that cannot be written, `PGPASSWORD` in neither output nor files |

### Evidence (local, disposable PostgreSQL 17.12; the PostgreSQL 17 role `pg_maintain` in `neon-shape.sql` makes 17 the supported major)
- `python3 nfl-pool/sql-tests/test_compare_catalog.py`: 39 tests, OK. Six regressions of the tool (the direction check removed, the
  wildcard back, the grant option ignored, validation skipped, the hash shortcut first, a missing documented row tolerated): each
  fails the suite.
- `bash nfl-pool/sql-tests/test_rebuild_lifecycle.sh` on an empty cluster: 49/49 as root, 50/50 as an unprivileged user (the
  unwritable-directory case cannot run as root). Against the `rebuild.sh` of `bf91cf9`: 18 of 49 fail, covering the unrestricted
  URL, the missing lock (four started together: the winner does not run to the end), a failed cleanup exiting 0, objects of
  another owner dropped, and an unwritable snapshot file not failing the run.
- `bash nfl-pool/sql-tests/rebuild.sh` with `REBUILD_SNAPSHOT_DIR`: exit 0; reference and rebuilt both
  `2c42b3a6985ed8d604cbb30ee352ab8c68dbb5f8afba8dbcf74d1ea91f28ce3c`; production shape
  `7f1b05a83ab6578a87455528b58d5dd04486ca5b4fcb91408f8d1cefd4b9d45d`, 16 policies, 121 privilege rows, "MATCHES: production-shape is
  rebuilt plus exactly the eleven documented backup-role rows"; environment stage 14 memberships, 11 roles, 139 effective
  privilege rows; guard 9/9; behavior 409/409; the cluster as found; the four snapshot files written and valid
  (`compare-catalog.py --validate`).
- `environment-snapshot.sql` also run, read-only, on existing PostgreSQL 17.12 and 18.7 databases (it validates).

### Not run here
The real database (nothing was read from it); PostgreSQL other than 17.12 for the gate; the 18 Node suites, `acceptance` checks
and `run.sh` (it needs Docker): the change does not touch them, and CI runs them.

### Remaining blockers
1. **Exact-head CI** for the branch head, read from the branch's checks after the push.
2. **The live comparison is still the owner's read-only step** (`catalog-snapshot.sql` on the real database, then the two
   `compare-catalog.py` commands in `CATALOG_COMPARISON.md`). It has not been repeated here, by instruction, and
   `environment-snapshot.sql` has never been run against the real database.
3. **The older backup login's access** (through `pg_read_all_data`, with `BYPASSRLS`) is recorded as the review reported it and was
   not confirmed against the real database. If it is so, that login can read every table whatever the scoped role's grants and
   policies say. Whether to narrow it is a decision about a production permission: not taken, and nothing was changed.
4. **Limits of the gate:** an execution killed outright (SIGKILL, power loss) leaves its lock and what it made, and the next run
   refuses on them; bash 5 and PostgreSQL 17 only; the lock is per cluster, so two executions on different clusters must not share a
   snapshot directory; the lifecycle tests need an empty disposable cluster.
5. **Release coordination** of Personal #43, #44 and #45 is separate and was left alone.
