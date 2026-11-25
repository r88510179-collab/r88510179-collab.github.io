# Comparing the Personal database with what the repository builds

Whether the real Personal database can be rebuilt from this repository is answered by comparing two documents:
`sql-tests/catalog-snapshot.sql` run read-only against the real database, and the same query run on a database that
`sql-tests/rebuild.sh` built from migrations 000 to 005 and the full-field guard. Nothing here is ever applied to Neon:
`rebuild.sh` refuses any host but a loopback one, and migration 000 is not for production.

## What was found (2026-11-25)

| | catalog SHA-256 | relations | policies | functions | privilege rows |
| --- | --- | --- | --- | --- | --- |
| Real database (read by the owner's assistant, read-only) | `7f1b05a83ab6578a87455528b58d5dd04486ca5b4fcb91408f8d1cefd4b9d45d` | 6 | 16 | 6 | 121 |
| Rebuilt from the migrations | `2c42b3a6985ed8d604cbb30ee352ab8c68dbb5f8afba8dbcf74d1ea91f28ce3c` | 6 | 11 | 6 | 115 |
| Rebuilt, plus the scoped backup role as documented | `7f1b05a83ab6578a87455528b58d5dd04486ca5b4fcb91408f8d1cefd4b9d45d` | 6 | 16 | 6 | 121 |

The migrations alone do not give the real database's hash, and the whole of the difference is the scoped backup role
(`smokke_personal_cloud_backup_ro`): SELECT on the five application tables, five policies named
`smokke_personal_cloud_backup_read` (the original 11 policies unchanged), and SELECT on the one sequence
`nfl_incident_rulings_ruling_id_seq`. With exactly those eleven rows added (`sql-tests/backup-role-delta.sql`, applied by
`rebuild.sh` to a copy), the catalog hash is **identical to the real one**: 64 hexadecimal digits, not a similarity.
`rebuild.sh` still prints exactly these values (re-run for the second review, on PostgreSQL 17.12: `2c42b3a6…` for the
migrations alone, `7f1b05a8…` for the production shape, 16 policies, 121 privilege rows); nothing in the second review
changed `catalog-snapshot.sql`, the migrations or the delta.

What that establishes, for everything `catalog-snapshot.sql` describes in schema `public`: columns with their types, defaults,
identity and generation; constraints; indexes; triggers; row-level security and every policy; every function with its
language, result, `SECURITY DEFINER` flag, volatility, settings, owner and a SHA-256 of its body; sequences; and every
privilege **entry** on a table, sequence, function or column, by role. In that scope the real database has no difference from
the repository's migrations other than the backup role's additions, and the sequence grant prepared on 2026-11-12 **has been
applied**, because the hash includes it.

The real value was supplied to this work and the real document itself was not seen: the comparison is of hashes and counts.
It was not re-read here. Run the real catalog read again before relying on it, as the database may have changed.

### What the catalog document does not show: access by membership and by attribute

The catalog document lists **explicit grants**: the entries of each object's access list. It does not show what a role can do
without an entry of its own. An earlier version of this page said that no other role holds any privilege and that the older
`smokke_backup_ro` login "holds none". That is true of explicit grants and is not a statement about access. As the independent
review recorded, that login reaches the data through its membership of the predefined role `pg_read_all_data`, which reads every
table and sequence of the database as if SELECT were granted on each, and has the attribute `BYPASSRLS`, which is not inherited
through membership and which makes row-level security not apply to the role that has it. So it can read every table whatever
the grants and policies say: the scoped backup role's SELECT-only grants and `USING (true)` policies neither describe nor limit
what it can read. **This was reported to this work and the real database was not read again to confirm it**; no permission was
changed. `environment-snapshot.sql` (below) is the read-only query that shows it, and it has not been run against the real
database.

## What it does not establish

- **Data.** No row is compared, and no sequence position.
- **Anything outside schema `public`**, including `neon_auth` and the Data API's own objects.
- **Extensions, roles and their attributes, memberships, and settings**, which `catalog-snapshot.sql` does not describe, and
  what a role can effectively do beyond its explicit grants. `environment-snapshot.sql` lists them (below); it has not been run
  against the real database.
- **That the live database was created by these migrations.** Equal catalogs mean the migrations reproduce it, not that they
  made it. `nfl_pool_weeks` was created by hand before migrations were kept; migration 000 now describes it in the recorded
  production shape and does nothing at all where the table already exists.
- **Production behaviour.** The SQL suites run on the rebuilt synthetic database, not on Neon.

## Repeating the comparison

```sh
# 1. Build, and keep the catalog documents (schema only; no row of the application is in them).
mkdir snapshots
REBUILD_SNAPSHOT_DIR=snapshots REBUILD_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres bash nfl-pool/sql-tests/rebuild.sh
#    prints "production shape sha256 <value>": what step 2 should give if the real database is as documented.
#    keeps reference.json, rebuilt.json (the migrations alone), production-shape.json, production-shape-environment.json.

# 2. By someone allowed to read the real database, read-only:
psql "$REAL_DATABASE_URL" -X -At -f nfl-pool/sql-tests/catalog-snapshot.sql > snapshots/live.json
sha256sum < <(tr -d '\n' < snapshots/live.json)          # the same 64 digits as in step 1, or not

# 3. Compare, strictly. Either way the answer is exit status 0 (equal) or 1 (it lists every row that differs):
python3 nfl-pool/sql-tests/compare-catalog.py snapshots/live.json snapshots/production-shape.json --label-a live --label-b repository
python3 nfl-pool/sql-tests/compare-catalog.py snapshots/live.json snapshots/rebuilt.json --label-a live --label-b migrations --documented-backup-role
```

**Strict.** Without a flag the two catalogs must be the same, row for row; any difference is *material*. There is no
allowance for a role of the environment: the former `--env-role` option, which let any privilege or policy naming a role through,
is gone.

**The documented backup role** (`--documented-backup-role`, with the live snapshot first and the migrations-only one second):
the first must equal the second **plus exactly the eleven documented rows and nothing else**: six privilege rows, SELECT on
`nfl_contest_policies`, `nfl_contests`, `nfl_incident_rulings`, `nfl_pool_weeks` and `nfl_survivor_weeks` and on the sequence
`nfl_incident_rulings_ruling_id_seq`, each for `smokke_personal_cloud_backup_ro`, none with a grant option; and five policies
named `smokke_personal_cloud_backup_read`, one per table, permissive, `FOR SELECT`, `TO` that role alone, `USING (true)`, no
`WITH CHECK`. The equality is against that adjusted catalog, so each of these is material, and the output says why:

- a documented row missing (a missing read grant, a missing policy);
- any privilege of the backup role other than those six: INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, USAGE
  or UPDATE on the sequence, a read grant on another table, sequence, column or function, a grant option;
- a policy that names other roles (or none, which is PUBLIC), is for more than SELECT, reads as anything but `true`, has a
  `WITH CHECK`, is restrictive, has another name, belongs to a sixth table, or appears twice;
- the same access held by a role with another name; and any other difference in the catalog.

The direction matters. The documented rows must be in the first snapshot and not in the second: a second snapshot that already
holds any of them is refused (exit status 2), so the two cannot be given the wrong way round.

**Exit status.** 0: equal (strictly, or, with the flag, to the adjusted shape). 1: anything is material. 2: the command line, or
a file, is not valid. A snapshot is validated before anything is compared, whatever its hash: every section of the catalog
document (`columns tables constraints indexes triggers policies functions privileges`) must be present and no other, each a list
of rows or null (what an aggregate over nothing gives: a database without triggers is valid), and every row of the right number
of fields, each of the right type and, where it has one, from the right set (a policy command, a privilege kind, a 64-digit
hexadecimal function hash). An empty file, a truncated one, one with text around the document, a repeated section, or an
object of the wrong sections is exit status 2; two identical documents that are incomplete never pass as "identical". The
messages name the section and the position and never print a row. `compare-catalog.py --validate file` checks one file and
prints its SHA-256.

### The environment around `public`

```sh
psql "$REAL_DATABASE_URL" -X -At -f nfl-pool/sql-tests/environment-snapshot.sql > snapshots/live-env.json   # read-only
python3 nfl-pool/sql-tests/compare-catalog.py --environment snapshots/live-env.json snapshots/production-shape-environment.json --label-a live --label-b repository
```

The snapshot holds the database and its owner, the server's major version and time zone, the schemas, the extensions, and:

- **roles** that are not PostgreSQL's own: login, superuser, createrole, **bypassrls**, createdb, **inherit**, replication and
  connection limit (no password, no hash, no setting that could hold a secret);
- **memberships**, now **including the predefined roles** (`pg_read_all_data`, `pg_write_all_data`, ...): admin, inherit and set
  options of the membership (null before PostgreSQL 16) and `inherits`, the answer the server uses;
- **effective privileges** on each application table and sequence, with three things kept apart: *explicit* (the role has an
  entry of its own in the access list, which is what `catalog-snapshot.sql` shows), *effective* (the server would let it:
  inheritance, predefined roles, ownership, superuser and PUBLIC grants all counted) and *via* (how, when it is not explicit:
  `superuser`, `owner`, `pg_read_all_data`, `pg_write_all_data`, `inherited from <roles>` or `public`), plus whether
  row-level security does not apply to the role on that table (superuser, `BYPASSRLS`, or an owner of a table without FORCE).

`compare-catalog.py --environment` lists what differs between two such documents and never fails on a difference (a hosted
database and a rebuilt one differ by design: the platform's roles and extensions, the owner's name, `neon_auth` and the Data API
schemas, the time zone, the major version), but it **notes** what a person should read: a role that is a superuser or bypasses
row-level security; a login that is a member of a predefined role, and whether it inherits it; and, per role, how many privileges
it holds that no grant gives it, through what, and on how many tables row-level security does not apply to it. `rebuild.sh`
tests this query itself, on the production-shape database beside two synthetic roles that read through `pg_read_all_data`
(one with `BYPASSRLS`): the memberships, the explicit/effective/via split and the exemption must come out as they should, and the
scoped backup role must hold nothing but SELECT, explicit or inherited.

## The gate: what protects the cluster

`rebuild.sh` builds, drops and re-creates databases and roles on the server it is given.

**The connection.** `REBUILD_PG_URL` has one supported form, exactly `postgresql://postgres@HOST[:PORT]/postgres`, with HOST
`127.0.0.1`, `localhost` or `[::1]`. The gate connects as the superuser `postgres` to the database `postgres`, and then as the
roles it creates; the URL supplies only the host and the port. (An earlier version accepted any user, a password and any
database and silently ignored all three: the password was dropped and the user and database replaced.) A URL with a password,
another user or database, a query string (`?host=`, `?hostaddr=`, `?service=`), several hosts, a port above 65535 or anything
after the database name is refused, and **the value is never printed**. The gate's own roles have no password, so the cluster
must let them connect without one (`trust`, as the CI service container does with `POSTGRES_HOST_AUTH_METHOD=trust`). If the
superuser needs a password, put it in `PGPASSWORD`; it is not echoed and appears in no file the gate writes. `PGHOSTADDR`,
`PGSERVICE`, `PGSERVICEFILE`, `PGSYSCONFDIR` and `PGHOST` make the script stop; `PGOPTIONS`, `PGTZ`, `PGDATESTYLE` and the like
are unset; a connect timeout is set. It was written and tested with bash 5.2 and PostgreSQL 17 (`neon-shape.sql` uses a PostgreSQL 17 role); the macOS default bash 3.2 is not supported. It needs `psql`, `python3`, `od`, `awk` and `mktemp`.

**One execution at a time per cluster.** The roles are cluster-wide, so two executions on one cluster build the same things.
An execution first takes a lock by creating the role `nfl_pool_rebuild_lock` (creating it either works or fails, so executions
started together cannot both win). A second one stops at once, touches nothing, and prints the holder's mark. A cluster that holds
a database of its own, is a Neon compute, or already has the gate's roles or databases is refused before anything is changed, and
looked at again once the lock is held.

**Cleanup removes only what this execution made.** Everything an execution creates (the lock, the roles, the databases) is marked,
as it is created, with that execution's random identifier in the object's comment. At the end it drops only what carries its own
mark: databases first, roles next, the lock last. An object it did not make, or whose mark has changed, is **not dropped**: a
warning names it and why. The earlier version dropped a fixed list of names whatever their origin.

**Exit status.** 0: the gate passed and the cluster is as found. 1: it was refused, or a check failed (the cluster is still
cleaned up). 3: everything passed but something this execution made could not be removed; a `::warning::` line names it, the
last line says "cleanup incomplete", and the next run refuses until it is removed. A cleanup failure after a failed run leaves
status 1 and is still reported. INT, TERM and HUP end the run through the same cleanup (status 130, 143, 129). An execution
killed outright (SIGKILL, power loss) cannot clean up: it leaves its lock and what it made, and the next run refuses on them and
names the holder.

**Snapshot files.** When `REBUILD_SNAPSHOT_DIR` is set it must be an existing directory that can be written, checked before
anything is built; if a file the gate was asked to keep (`reference.json`, `rebuilt.json`, `production-shape.json`,
`production-shape-environment.json`) cannot be written, the run fails with status 1. Two executions on different clusters must not
share a directory. The catalog is read once per database, validated by `compare-catalog.py`, and compared by it: a snapshot that
cannot be read, or is empty or incomplete, stops the run and can never count as "the same".

### What changed in the review of `bf91cf9`

| Weakness found | Now |
| --- | --- |
| `compare-catalog.py` let any privilege or policy that named the backup role through as "environment-specific", whatever it was, in either direction. | Strict equality; the backup role's eleven rows are the only allowance, exactly, in the right direction (above). |
| A document with missing sections, or malformed rows, was accepted if its hash matched; `rebuild.sh` compared the raw text, so two empty snapshots were "the very same catalog". | Every snapshot is validated first (exit status 2) and compared by the tool, never by text or hash alone. |
| Two executions on one cluster could drop each other's databases and roles; cleanup dropped fixed names. | A lock, marks, cleanup of what carries this execution's own mark only. |
| A failed cleanup was a warning and the exit status stayed 0. | Exit status 3 (or 1), the warning names the object, and the next run refuses on it. |
| The environment snapshot left out every `pg_` role and membership, ordered by constants, and had no inheritance attributes or effective privileges, so a role reading through `pg_read_all_data` or `BYPASSRLS` was invisible; the page said the older backup role "holds none". | Predefined memberships, inheritance, effective privileges with their route and the row-level-security exemption; the page corrected (above). |
| The URL's user, password and database were accepted and ignored. A snapshot directory that could not be written failed silently. | One supported form, enforced, documented, never printed; unwritable snapshot output is a failure. |

### The tests

- `sql-tests/test_compare_catalog.py` (39 tests, no database): the strict comparison and each way of fooling it: every missing
  documented row, every write-capable privilege, a grant option, a read grant on anything else, another role with the same
  access, every overbroad or different policy, the documented rows given the wrong way round or twice, any other difference
  beside them; every missing section, an unknown one, a non-object, malformed rows of sixteen kinds, a repeated section, empty and
  truncated files, identical incomplete documents, null aggregates; the environment notes. Reintroducing any of six weaknesses
  into the tool (the wildcard, the direction check removed, the grant option ignored, validation skipped, the hash shortcut before
  validation, a missing row tolerated) fails them.
- `sql-tests/test_rebuild_lifecycle.sh` (49 checks, 50 as a non-root user, on a disposable empty cluster; CI runs it before the
  gate): fourteen unsafe URLs and the five environment variables refused with nothing built and no password echoed; foreign
  databases, roles and a foreign lock left exactly as found; **four invocations started together, exactly one builds and passes
  every suite, three are refused naming the lock, and the cluster is as found**; a cleanup made to fail (a role that cannot be
  dropped): exit status 3, the role named, everything else removed, the next run refusing and leaving it alone; a failed run whose
  cleanup also fails; objects whose mark was changed during the run, a role and a database, not dropped, reported, exit 3; SIGTERM
  mid-run, exit 143 and a clean cluster; a snapshot file that cannot be written failing the run; the four files written when
  asked; a `PGPASSWORD` in neither the output nor the files. Against the script of `bf91cf9`, 18 of these 49 fail.
- `rebuild.sh` itself, which builds twice, compares, checks the production shape against the adjusted shape, tests the
  environment query, and runs the guard and behavior suites.

None of this touches Neon. The SQL suites and the rebuild run on a throwaway PostgreSQL; what no check can prove is that a cluster
is disposable: a local cluster you care about, empty apart from `postgres`, passes. Use a throwaway one.
