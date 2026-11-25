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
`nfl_incident_rulings_ruling_id_seq`. With exactly those added (`sql-tests/backup-role-delta.sql`, applied by `rebuild.sh`
to a copy), the catalog hash is **identical to the real one**: 64 hexadecimal digits, not a similarity.

What that establishes, for everything `catalog-snapshot.sql` describes in schema `public`: columns with their types, defaults,
identity and generation; constraints; indexes; triggers; row-level security and every policy; every function with its
language, result, `SECURITY DEFINER` flag, volatility, settings, owner and a SHA-256 of its body; sequences; and every
privilege on a table, sequence, function or column, by role. In that scope the real database has no difference from the
repository's migrations other than the backup role's additions, including: no other role holds any privilege there (the
older `smokke_backup_ro` login holds none), and the sequence grant prepared on 2026-11-12 **has been applied**, because the
hash includes it.

The real value was supplied to this work and the real document itself was not seen: the comparison is of hashes and counts.
It was not re-read here. Run the real catalog read again before relying on it, as the database may have changed.

## What it does not establish

- **Data.** No row is compared, and no sequence position.
- **Anything outside schema `public`**, including `neon_auth` and the Data API's own objects.
- **Extensions, roles and their attributes, memberships, and settings.** The snapshot names a role only where it holds a
  privilege. `environment-snapshot.sql` lists the rest (below); it has not been run against the real database.
- **That the live database was created by these migrations.** Equal catalogs mean the migrations reproduce it, not that they
  made it. `nfl_pool_weeks` was created by hand before migrations were kept; migration 000 now describes it in the recorded
  production shape and does nothing at all where the table already exists.
- **Production behaviour.** The SQL suites run on the rebuilt synthetic database, not on Neon.

## Repeating the comparison

```sh
# 1. Build, and keep the three catalog documents (schema only; no row of the application is in them).
mkdir snapshots
REBUILD_SNAPSHOT_DIR=snapshots REBUILD_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres bash nfl-pool/sql-tests/rebuild.sh
#    prints "production shape sha256 <value>": what step 2 should give if the real database is as documented.

# 2. By someone allowed to read the real database, read-only:
psql "$REAL_DATABASE_URL" -X -At -f nfl-pool/sql-tests/catalog-snapshot.sql > snapshots/live.json
sha256sum < <(tr -d '\n' < snapshots/live.json)          # the same 64 digits as in step 1, or not

# 3. If they differ, see which rows:
python3 nfl-pool/sql-tests/compare-catalog.py snapshots/live.json snapshots/production-shape.json --label-a live --label-b repository
python3 nfl-pool/sql-tests/compare-catalog.py snapshots/live.json snapshots/rebuilt.json --label-a live --label-b migrations-only
```

`compare-catalog.py` separates two kinds of difference. **Expected environment-specific**: a privilege held by, or a policy
that is for, a role that only exists in one environment (by default the scoped backup role; add others with `--env-role`).
**Material**: everything else on one side only, a column, constraint, index, trigger, function body, owner, row-level-security
flag, or any privilege or policy of any other role. It exits 0 for identical or environment-only differences, 1 for anything
material. Treat a material difference as drift to be explained before any restore or rebuild is trusted.

For what surrounds `public`, run `sql-tests/environment-snapshot.sql` on each side (read-only; roles by name and attributes
only, no password or hash) and `compare-catalog.py --environment live-env.json rebuilt-env.json`. These are expected to
differ on a hosted database, by design, and are read by a person: the platform's own roles and extensions, the owner role's
name, the `neon_auth` and Data API schemas, the time zone (GMT on both), and the server's major version (17). A role that is
a superuser or bypasses row-level security on the real side is printed as a note, not a failure.

## What the gate protects against, and what changed in this review

`rebuild.sh` builds, drops and re-creates databases and roles on the server it is given. The checks that stand between that
and a real server, and the weaknesses a review of the script found in them:

| Weakness found | Now |
| --- | --- |
| The loopback check read only the host in the URL's authority. A query string (`?host=`, `?hostaddr=`, `?service=`) or several hosts are read by libpq differently; a URL with no user built a broken connection string. | Only `postgresql://user[:password]@127.0.0.1\|localhost\|[::1][:port]/database` is accepted, nothing after the database name. |
| `PGHOSTADDR`, `PGSERVICE` and a service file can send libpq to another address whatever the URL says; `PGTZ` and `PGOPTIONS` change the time zone and role of every session silently. | `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGSYSCONFDIR` and `PGHOST` make the script stop. `PGOPTIONS`, `PGTZ`, `PGDATESTYLE` and the like are unset. A connect timeout is set, so a wrong port cannot hang it. |
| `ALTER SYSTEM SET timezone` was run on the cluster and never undone: a permanent change to a server the script says it leaves as found. | The time zone is set on the two databases it builds and goes when they are dropped. The cluster's settings are not touched. |
| Nothing checked that the cluster was disposable beyond the names the script builds. | It also stops if the cluster holds any database of its own, or is a Neon compute. |
| Cleanup hid every failure, so a leftover role or database was silent and the next run refused for no visible reason. | Each failed drop is reported as a warning naming the object and why. |

Each refusal is exercised with a real run: an unsafe URL of seven kinds, each of the five environment variables, a cluster that
holds another database (which keeps its data), and one that already has the script's roles (which are kept). A drop that fails is
reported, and the next run refuses on what was left. A drifting baseline still fails the gate and shows the rows. The comparison
tool has its own self-test (`test_compare_catalog.py`, no database). What no check can prove is that a cluster is disposable: a
local cluster you care about, empty apart from `postgres`, passes. Use a throwaway one.
