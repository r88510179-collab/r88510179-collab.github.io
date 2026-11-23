# Commercial Pool release runbook

The live Netlify site builds `pool-platform/` from the branch `commercial-v1-netlify-adapter`. The database scripts in this
directory run separately, with `psql`, over a direct connection to the Commercial Neon database as its owner role.
Nothing here runs by itself: every step that changes the live database, the Data API or the published site needs the
owner's approval for that step.

Every script first checks that the server it reached is the one named on the command line (project, branch and the
database `neondb`) and stops with `commercial_release_target_mismatch` before doing anything else if it is not. Set the
two identifiers once per shell, from the Neon console, and run every command from `pool-platform/`:

```sh
export COMMERCIAL_PROJECT=<Neon project id>  COMMERCIAL_BRANCH=<Neon branch id, br-...>
```

## The scripts

| Script | Changes anything? | What it does |
| --- | --- | --- |
| `baseline.sql` | No (read-only transaction) | Prints a row count and fingerprint for each of the ten original tables, the identity map, outstanding legacy invitations and whether the release is installed. Counts and hashes only. |
| `kickoff-audit.sql` | No (read-only transaction) | For every week, whether final scores can be recorded and why not; then every game without a usable kickoff time. |
| `predeploy.sql` | Yes, one transaction | Checks the target and that the schema is the recorded baseline, locks the ten original tables against writes, applies the 13 migrations, then commits only if the schema and the browser privileges are exactly the reviewed ones and no existing row changed. |
| `retire-legacy-invites.sql` | Yes, one transaction | Takes the two original invitation functions away from the browser. Refuses while a legacy invitation is still outstanding. |
| `restore-legacy-invites.sql` | Yes, one transaction | Undoes the retirement. Needed only if the previous frontend is published again after it. |
| `rollback-predeploy.sql` | Yes, one transaction | Removes everything `predeploy.sql` added and proves the schema is the baseline again. Refuses if that would destroy rows. |
| `kickoff-repair.sql` | Only with `-v apply=yes` | Adds kickoff times to one week from the verified schedule catalog. A dry run by default. |

`verify-target.sql`, `verify-baseline-schema.sql`, `data-fingerprint.sql`, `verify-postconditions.sql` and
`verify-data-unchanged.sql` are the checks the scripts above include; they are not run on their own.

A script that stops prints one of these and leaves the database exactly as it was:

- `commercial_release_target_mismatch`: wrong server, or an identifier was not set.
- `commercial_release_baseline_mismatch: …`: the schema is not the one this release was reviewed against. Do not continue.
- `commercial_release_postcondition_failed: …`: after the migrations, something a browser could reach was not as reviewed
  (a default privilege on the target is the usual cause). Do not continue.
- `commercial_release_changed_existing_rows: …`: an existing row would have changed.
- `outstanding_legacy_invitations_require_review`, `commercial_release_rollback_refused: …`, `kickoff_repair_refused: …`:
  the reason follows the name.

The predeployment holds its locks for the length of one transaction (it gives up after 5 seconds waiting for a lock and
45 seconds in any statement). Picks submitted during those seconds wait and then go through.

## Release, in order

1. **Before anything.** Confirm the approved candidate commit. Take a current encrypted backup with the existing
   backup arrangement and verify an isolated restore of it. Note the identifier of the Netlify deploy that is live now.
2. **Baseline.** Save the output; it is what every later step is compared with.
   ```sh
   psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -f ops/release/baseline.sql | tee baseline-before.txt
   psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -f ops/release/kickoff-audit.sql | tee kickoff-audit-before.txt
   ```
   Expect `release_schema_installed` false, `legacy_invitations_callable` true and 14 functions. If
   `outstanding_legacy_invitations` is not 0, arrange replacement links with those commissioners before step 7.
3. **Predeployment** (database only; the site still serves the previous frontend, which keeps working).
   ```sh
   psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -f ops/release/predeploy.sql
   psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -f ops/release/baseline.sql | tee baseline-after-predeploy.txt
   ```
   The first command ends with `COMMIT`. In the second, the ten `rows:fingerprint` values, `application_rows` and
   `identities` must equal `baseline-before.txt`; `release_schema_installed` is now true, with 32 functions.
4. **Data API.** Refresh its schema cache so it sees the new functions: in the Neon console under Postgres database >
   Data API, **Refresh schema cache**; or `neon data-api refresh-schema --project-id "$COMMERCIAL_PROJECT" --branch "$COMMERCIAL_BRANCH"`,
   which changes no setting. Then confirm the settings are what they were (`neon data-api get`): the anonymous role is
   `anonymous`, the exposed schema is `public`, the role claim is `.role`.
5. **Publish the reviewed build.** Bring the approved `pool-platform/` tree to `commercial-v1-netlify-adapter` and check
   it is the reviewed one before it is published: `git rev-parse HEAD:pool-platform` on that branch must equal
   `git rev-parse <approved commit>:pool-platform`. Publish that deploy; keep the previous deploy available.
6. **Smoke test** with the designated accounts, on the live site:
   - Sign in by emailed code as a commissioner and as a participant. Existing pools, entries and picks are there.
   - The week and season standings cards load for a pool the account may read.
   - Issue an invitation to a designated test entry; open the link as the invited, verified address and claim it; open
     it as another account and see it refused.
   - On the commissioner page, open a week whose pick deadline has passed and whose games have no kickoff time: the
     final-score panel says so and offers no score to type.
   - With two tabs open and signed in, sign out in one. The other returns to its sign-in card and says the account was
     signed out, without a reload by hand; nothing of the account remains on it.
   - In the browser's developer tools, the site's local storage holds no `better-auth.message` entry after sign-in and
     after sign-out.
7. **Retire the original invitations**, once step 6 passed and no legacy invitation is outstanding.
   ```sh
   psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -f ops/release/retire-legacy-invites.sql
   psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -f ops/release/baseline.sql | tee baseline-after-retirement.txt
   ```
   The ten fingerprints and the identity map still equal `baseline-before.txt`; `legacy_invitations_callable` is false.

Keep automated schedule sync and the live-score gateway disabled for this release: neither is deployed by it.

## Going back

- **The site.** Publish the previous deploy again. The previous frontend never calls the new functions, so the added
  schema can stay. If step 7 has run, run `restore-legacy-invites.sql` as well, or the previous frontend cannot issue
  or claim an invitation.
- **The database.** Only if the added schema itself must go:
  ```sh
  psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -f ops/release/rollback-predeploy.sql
  ```
  It refuses when a new table holds rows (invitations, recorded final scores or schedule records made since the
  release), because dropping the tables would destroy them, and it refuses after step 7 until
  `restore-legacy-invites.sql` has run. When it commits, `baseline.sql` prints the same values as `baseline-before.txt`.
- A restore from the backup is the owner's separate decision and is not part of these scripts.

## Weeks, schedules and kickoff times

- Final scores can be recorded for a week only when it is open, locked or final, its pick deadline has passed, and every
  game has its two teams and a kickoff time, stored as a UTC timestamp (`2026-11-08T18:00:00Z`), that is in the past.
  The page says which of these is missing before any score is typed, and the database refuses the rest.
  `kickoff-audit.sql` lists every week and game concerned. No kickoff time is ever inferred.
- `kickoff-repair.sql` can add kickoff times to one existing week, and only from the verified schedule catalog:
  ```sh
  psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -v week_id=<week uuid> -f ops/release/kickoff-repair.sql
  ```
  That is a dry run; `-v apply=yes` keeps the change. It refuses unless the catalog holds that season and week, validated
  within the last 48 hours, and the stored slate is that verified slate game for game. A week whose slate matches no
  verified schedule cannot be repaired and stays closed to final scores; its picks are kept as they are.
- A new week is opened from the commissioner page, and only against a verified slate in the catalog that was validated
  within the last 48 hours. Nothing in this release fills the catalog: schedule sync is not part of it. Until the owner
  approves a schedule source and a way to load it, no new week can be opened.

## Checks on a physical iPhone

CI runs the pages in Chromium and in WebKit on Linux, which is not Safari on a phone. Before the release is called
done, on an iPhone in Safari: sign in by emailed code; open an invitation link from Mail and claim it; submit and change
a pick; read the week and season standings cards without sideways scrolling; sign out; with two tabs signed in, sign
out in one and return to the other; in a Private tab, sign in and submit a pick.

## Recording and correcting final scores

1. Open the intended pool, season and week. After the pick deadline, match every home and away team to its scheduled game. Check both scores in NFL Game Center once each game is marked Final. Use the official NFL Game Book to resolve a discrepancy. Keep the supporting record. [NFL Game Center](https://www.nfl.com/scores/)
2. In **Record reviewed final scores**, enter both scores for each game and a one-line source reference of 12–500 characters. Include the source location, week and time checked. Review the entire slate before confirming. If the page flags a missing kickoff, an unresolved game or an unverified team, leave the week pending.
3. Reopen the week and verify the saved revision. Check the week and season standings. Equal Pick’em totals share rank. A tied game earns zero points for either Pick’em side and eliminates either Survivor choice. A missing Survivor pick counts as a loss under the default rules.
4. To correct a final, open the current revision, recheck the source and enter the corrected scores and a one-line reason of 8–240 characters. Confirm the next revision and recheck both standings views. If another commissioner saved first, reload and review that revision before trying again.
