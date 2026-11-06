# Pool applications: real end-to-end acceptance (owner-operated)

**Status: procedure and independent-check tooling only. Not yet a live PASS.**
This package does not authorize writing to a live customer or personal pool, changing authentication, migrating production, or merging/deploying. Use synthetic users/entries and a dedicated isolated test environment. The personal GitHub Pages app currently targets the live personal Neon database, so **do not use its real Publish button to simulate testing**.

## What is already tested, and what is not

- GitHub's existing 17-suite Personal Pool CI verifies parser, publishing contracts, score math, service worker, feed finality, tie rules and SQL behavior against disposable local PostgreSQL. A passing suite is not evidence that a live PDF was published or that a real auth session persisted a participant's picks.
- Commercial V1 has local Node tests for submission rules and frontend/auth contracts; live commercial authenticated acceptance requires a dedicated signed-in Stage B gate and synthetic accounts.
- The read-only `acceptance/score-reconcile.mjs` script checks deployed `nflscores2` against independent requests to **the same ESPN upstream**. This catches proxy mapping, missing finals and mismatched scores, but *not* an upstream error present in ESPN itself. It never logs in, reads private entries or writes data.
- An optional, independently transcribed `official.csv` adds **NFL.com final-score** comparisons. Never mark independent official verification complete without all finished games included and verified from a separate source. Screenshots alone without game/week evidence are insufficient.

## Non-production acceptance matrix

| Test | Prerequisite | Steps | PASS evidence |
| --- | --- | --- | --- |
| Personal Pick'em PDF import | Isolated personal Neon test database and test origin; user-authorized disposable data, not the live Pages-origin database | Open admin on test origin; upload a **synthetic** multi-page PDF for a synthetic season/week; inspect preview, field totals, duplicate names, missing rows and explicit exception gates; publish once; refresh the public test page and DB query | PDF fixture SHA-256; accepted week/revision and published fingerprint; identical expected counts and picks across parsed preview, persisted DB and public read-back; no duplicate re-publish |
| Personal Survivor PDF import | Same isolation | Upload synthetic Survivor PDF with duplicate names, eliminated/inactive rows and an empty pick; confirm preview and publish to isolated DB; reopen as a fresh session | Exact entry count, team/week picks, elimination/tie semantics, no corrupted private names, UI and DB agree |
| Commercial Pick'em direct entry | Isolated commercial environment, two synthetic Neon Auth users, synthetic pool and future deadline; Stage B authorization gates | Sign in as test participant; claim invite, select entry, submit picks+tiebreak; log out/in, reopen same week, read back DB; attempt second account and expired deadline | Same immutable entry/pool/week and picks across browser and DB; scoped authorization enforced; no duplicate records; negative tests reject |
| Commercial Survivor direct entry | Isolated commercial environment and two synthetic users | Submit legal team, reload, attempt reused team, wrong tenant and locked week | Correct persisted selection; reused/wrong-tenant/late attempts rejected |
| Commercial commissioner import | Test-only tenant and entries | Import synthetic CSV/PDF via supported channel (only if the version actually implements it), then attempt participant override and second import | Approved source channel recorded; source conflicts and locks enforced; exact record count and reread identical; if not implemented, mark NOT IMPLEMENTED, not PASS |
| CRM permissions | Isolated CRM branch and real synthetic test identities | Confirm owner, assistant, viewer and foreign tenant cannot exceed granted scopes, before any production integration | Database queries, API outcomes and browser UI all agree; negative cross-tenant cases are denied |
| Official final scores + ties | Independent NFL.com final scoreboard for each completed game; read-only proxy check | Run `node nfl-pool/acceptance/score-reconcile.mjs --season 2026 --weeks 1-9 --official path/to/official.csv`. Compare resulting pool scores and tie policy manually in UI | Every finalized game included in independent reference, no mismatch; one real tie fixture grades **both sides as losses** unless a documented contest ruling overrides |
| Rollback and recovery | Tested snapshot and restore on disposable branch, known-good SHA | Deliberately deploy a faulty **test** candidate, recover the staging site and test database | Original browser behavior, roles, pick submissions and scores return without new data loss |

**Do not fabricate an acceptance PASS:** Record untested, blocked and simulated results separately. A read-only check never proves a write path works.

## Running the score check

From a checked-out personal repository on a Mac with Node.js 22+:

```sh
node nfl-pool/acceptance/score-reconcile.mjs --season 2026 --weeks 1-8
```

This compares the currently deployed Neon `nflscores2` against a freshly retrieved ESPN scoreboard for each week. It is read-only. A `PASS` means *ESPN upstream ↔ deployed proxy* final-result parity, **not** independent NFL official parity or end-to-end pick grading. Internet access is needed. Proxy/ESPN errors fail the check.

For independently verified results, manually transcribe **all completed games** for the selected weeks from official NFL.com game results into a **local, untracked** CSV (do not commit it unless source provenance/license and accuracy have been reviewed). Exact header:

```csv
week,away,home,awayScore,homeScore
```

Team codes may be copied exactly as NFL.com shows them: the tool maps NFL.com's `AZ` to `ARI` (and `JAC`, `WSH`, `LA` to `JAX`, `WAS`, `LAR`).

Example with *illustrative, fabricated scores only* (DO NOT use this as official evidence):

```csv
1,BUF,BAL,27,24
```

Then run `node nfl-pool/acceptance/score-reconcile.mjs --season 2026 --weeks 1-8 --official /private/path/official.csv`. For every final game, the check requires a corresponding reference row and matches both teams and scores; additional reference rows for games that aren't finalized fail. Report which exact season/weeks and how many finals were checked.

This does not automatically fetch an independent NFL official feed. That feature is not implemented. A separate future integration may automate official scoreboard ingestion if a reliable, permitted source is confirmed.

## Evidence record (create one per acceptance run)

- Time, timezone, exact candidate commit SHA, deployment ID, test URL
- Neon project/branch ID and proof that it is *not* a production branch
- Test identities and synthetic pool/week/entry IDs (no emails, passwords or tokens)
- Browser/mobile device and version
- PDF fixture hash and original expected count
- Read-back of authorized row counts/fingerprints before and after
- Expected and observed scoring on each finalized game, including ties and rulings
- Screenshots with no personal/private participant data
- Pass, fail, blocked, not implemented, or untested per matrix row
- Cleanup confirmation for disposable data and test deployment

## Stop conditions

Stop on a production URL, actual entry, unapproved token, unknown source status, expired current-week deadline, a mismatched Neon branch, a permission failure, or any test that would need real customer/personally identifiable data. Don't silently switch to production. Keep CRM draft PR #19 and Commercial V1 locked branch `commercial-v1-netlify-adapter` unchanged until the separate release gate authorizes integration.


## Verified read-only live result — October 29, 2026

GitHub Actions [run 40828802205](https://github.com/r88510179-collab/r88510179-collab.github.io/actions/runs/40828802205) executed `node nfl-pool/acceptance/score-reconcile.mjs --season 2026 --weeks 1-8` without secrets or production writes, exit 0.

- Weeks 1–7: 16 + 16 + 16 + 16 + 15 + 14 + 14 = **107 completed games**; each matched the live `nflscores2` vs freshly fetched ESPN upstream projection.
- Week 8: 14 scheduled games, **0 finalized** as of this run; skipped final-score comparisons properly.
- **0 parity failures**; this establishes ESPN feed projection parity only, not official NFL.com independent parity, UI standings/scoring correctness, or signed-in pick/PDF write/read-back acceptance.
- Next mandatory evidence: owner-approved synthetic staging tenant and read-after-write tests, plus independent NFL.com final records. Do not advertise full E2E PASS from this result.

## Independent NFL.com cross-check, October 29, 2026

All 107 completed games of weeks 1-7 were read from nfl.com/scores/2026/week-1 to week-7 in a browser and checked with `--official`: **107 of 107 match**, 0 failures. A copy with one score altered failed as it should. Before the `AZ` mapping above, NFL.com's own codes produced 14 false failures (every Arizona game). The transcribed CSV stays local, as this document requires.


## November 5, 2026 continuation (PR #23, not a completed E2E release)

- The October 29 parity run and 107-game independent check are **historical evidence**, not proof of current-week parity.
- The default parity job now covers **2026 Weeks 1-9**. The manual workflow has explicit season/week inputs so the owner can extend the range after Week 9 without needing AI or code changes. Manual dispatch is available only after the workflow is merged to the default branch.
- The checker refuses a green result for empty ESPN/proxy event lists or a stale/invalid proxy `fetchedAt`, and prints expected-vs-actual *public game* evidence for finalized-score mismatches.
- Deterministic, network-free synthetic tests cover parity, ties, score mismatches, empty feeds, stale data and independently supplied score comparisons.
- Run from the feature branch: `node --test nfl-pool/acceptance/score-reconcile.spec.mjs`.
- A new post-update live read-only run is required for current parity; do not mark any current-week results verified until that job completes. Full browser/PDF write-path acceptance remains blocked by separate staging authorization.

## November 5, 2026 independent official Week 8 evidence

- NFL's official [2026 Week 8 final-score schedule](https://www.nfl.com/schedules/2026/by-week/week-8) was read and matched against the independently published [CBS Sports Week 8 results](https://www.cbssports.com/nfl/schedule/2026/regular/8/): 14 final games, same matchups and scores, including Arizona's 33–30 OT win and Tennessee's 36–43 OT loss.
- An official-reference CSV is assembled **ephemerally inside the read-only CI runner** from those 14 reviewed public score facts (not committed as a stand-alone customer or private data file). `--official` requires all 14 finalized games, rejects missing/incorrect/extra results, and exits nonzero on disagreement.
- This official check covers **Week 8**. The October 29 run documented separate official coverage for Weeks 1–7; Week 9 remains future/current when this evidence was added. Review the newest live Actions result before marking the new official check PASS.
- Official final-score parity does **not** verify the third-party contest operator's standings or any PDF/participant write-path.

## November 6, 2026 final E2E run on current `main` (not a full PASS)

- Report and evidence: [`final-e2e-20261106/REPORT.md`](final-e2e-20261106/REPORT.md). Current `main` (`756f2ac`) was driven in a real browser against the isolated QA child `br-damp-credit-bbn7d0zr`; the QA parent and every existing QA publication fingerprinted identical before and after; production was never contacted.
- **PASS:** Pick'em and Survivor malformed/invalid import rejection (9/9, including the duplicate-team rule added after PR #29), valid parse/preview with Eastern kickoff dates, signed-out publish gate, read-back of existing QA weeks after a real final, positive group-vs-field pulse, FEED UNAVAILABLE / ON HOLD / PUBLISHED DATA STALE (injected faults), Survivor tie elimination, 375/390/430 layout, anonymous write refusal (403/42501).
- **Fixed:** the PUBLISHED DATA STALE strip fell back to stored UTC dates; it now keeps the warning and shows only verified Eastern dates (`week-date-range.js?v=2`, cache v37).
- **BLOCKED:** authenticated publish/revision/read-back of new synthetic weeks and in-browser Pick'em tie grading — no usable authorized synthetic publisher sign-in on QA (email codes are stored hashed and the synthetic address has no mailbox). Requires an owner decision on QA authentication; see the report.
- **Later the same day (closed):** after owner authorization of a child-only synthetic password publisher, the blocked publish/revision/stale-writer/read-back scenarios were run (summary: [`final-e2e-20261106/QA_PASSWORD_E2E_CLOSEOUT.md`](final-e2e-20261106/QA_PASSWORD_E2E_CLOSEOUT.md)). An independent read-only check then confirmed the database end state (W5 and W8 at revision 3 from the r2 fixtures; every earlier QA publication and the original policies unchanged; parent unchanged) and, in a fresh anonymous browser, the Week 5 standings against an ESPN-derived computation, including the NYG 27–27 WSH tie graded as a loss for every tracked pick (`final-e2e-20261106/logs/e2e-week5-week8-readback.json`, 7/7 PASS). Isolated-QA E2E acceptance is complete; release of the date fix remains with PR #35.
