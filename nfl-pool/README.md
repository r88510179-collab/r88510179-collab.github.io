# NFL Pool Center — how it works, start to finish

*A plain-English manual for the owner and for someone maintaining the application.*

## 1. What this app is (and isn't)

The public [Pool Center](https://r88510179-collab.github.io/nfl-pool/) lets you follow **D.C., JC, DJS and Thaddeus** in another organizer's NFL Pick'em pool, compare them with the **entire published pool**, and see real NFL scores. It also has a **historical Survivor archive** for our group, whose tracked members have all been eliminated. The larger Survivor competition may still be running.

The app does **not** collect new participant picks, operate the organizer's contest, determine the organizer's official decisions, charge dues or automatically obtain unpublished pool sheets. Ordinary visitors only **read** public data. The restricted Admin section is used by an authorized publisher to transcribe a legitimate organizer-supplied sheet into the tracker after validating it.

**Live scores and official pool picks are separate things.** NFL games can have live scores even when the organizer has not supplied the corresponding pool picks. Never invent missing weeks, entries, picks or Survivor results.

## 2. How to use the five screens

| Screen | What you see | What to do |
| --- | --- | --- |
| **Home** | At-a-glance results, our tracked group, live standings, group-vs-field position, games and Survivor archive status | Open the sections you care about; Customize can rearrange/hide sections; Share makes a summary |
| **Standings** | Our entries' wins/losses, group order, published full-field position, wins back, tiebreak and season record | Choose a week at the top; compare our entries with all published competitors |
| **Games** | Verified NFL scores, whether each matchup is upcoming/live/final, and what is unresolved or under review | Use Refresh to request the latest official-score feed |
| **Picks** | Which team each of the four entries chose in each published matchup, correct/incorrect marks, ownership percentages where the full pool was published | Filter tracked entries; use Disagreements only; open/close kickoff slates; scroll the table within its panel |
| **Archive** | Past Survivor selections, attrition and results for our eliminated group, with wider-field historical statistics | Review published old weeks; don't expect new tracked Survivor predictions |

The week dropdown shows **published weeks**, not the entire NFL calendar. A missing Week 9, for example, normally means the external organizer's Week 9 sheet hasn't been published into this tracker yet.

### How to read the numbers

- **W–L:** Wins and losses for the selected week's actual picks, using the game's accepted official outcome. A completed NFL tie counts as a **loss for either team selected** under this pool's accepted rule.
- **Left / Final:** How many selected games are still waiting and how many are complete. A commissioner-confirmed void is separately marked and is not scored as a normal NFL win.
- **Overall / Top %:** Our entry's place in the **full field**, available only if the validated publication includes the anonymized other pool entries. Otherwise it should say unavailable; it does not pretend four participants are the entire pool.
- **Group winner / scenarios:** Relative standing or possible outcomes among **our tracked entries**, not control of the actual organizer's contest.
- **Tiebreak (TB):** The designated published matchup's combined final points, compared with each entry's prediction, when the contest rules make the tiebreak applicable.
- **LIVE / DELAYED / FEED UNAVAILABLE:** Whether an NFL score update was retrieved recently. **PUBLISHED DATA STALE** means the currently installed pool-sheet revision could not be reverified. **ON HOLD** indicates insufficient verified ruling information; do not interpret it as a new loss.
- **Date range in the top strip:** A display summary, not a score or stored official record. The historical-date fix uses verified NFL kickoff instants in **America/New_York**. Until all selected matchups have verified kickoff times, it displays **Kickoff dates unverified** rather than trusting UTC dates from old PDFs. On a stale publication it keeps the PUBLISHED DATA STALE warning and still shows only the verified Eastern range (or Kickoff dates unverified).

The Picks slate grouping already uses kickoff times in Eastern time. The top date-range fix aligns that header with the same validated kickoff evidence. It changes **only displayed text**; not the game day in the database, published revision, SHA-256 fingerprint, picks, rankings, grading or feed.

## 3. Where each piece of information comes from

1. **External pool organizer:** Supplies the actual weekly Pick'em sheet (PDF or spreadsheet), entries, matchups, tiebreak and full-field data if available. Our app does not fetch those sheets automatically.
2. **Restricted Admin publisher:** Signs in with the approved passwordless account, uploads the authentic sheet, validates it against NFL schedule events, reviews the exact four tracked picks and optional anonymized field, then publishes a **locked** weekly revision.
3. **Neon database:** Holds the accepted Pick'em publications, Survivor historical weeks, contest policies and confirmed incident rulings. Public visitors get read-only data through Neon Auth's anonymous-token and Data API/RLS path. The authorized publisher has a separate protected write path.
4. **NFL scores:** The page requests ESPN's scoreboard format; \`score-feed-proxy.js\` routes that request through the public \`nflscores2\` gateway. The app matches games by verified teams, week/season and event identity; bad or contradictory evidence is not silently graded.
5. **Your browser:** Combines the published picks with verified NFL results and the applicable rulings to show scores, standings, ownership and group scenarios. Nothing about viewing a result writes to the production pool database.

### A simple example

If the external organizer has published Week 8 but not Week 9, the app correctly displays **Week 8** even if NFL Week 9 games are underway. The feed can be healthy while the tracker lacks new Week 9 picks. The solution is to receive and validate the real Week 9 sheet, **not** create placeholder picks or edit the database by hand.

### Organizer-issued single-entry corrections

Use **Weekly Admin → Organizer Corrections** for an email/screenshot notice that changes a participant's picks or tiebreaker but provides no replacement full sheet.

1. Sign in as the authorized publisher, choose the published season/week, and load its locked revision.
2. Select **the exact original PDF or Excel workbook** used for that week. It stays in the browser and its SHA-256 must match the published source fingerprint. The page validates the complete field and reconstructs the participant's original name-to-anonymous-ID association locally; names are never saved to the database.
3. Enter the participant name as shown in the original organizer sheet, paste the numbered picks in matchup order, and enter the corrected tiebreaker. Select the organizer notice type. The history uses a standard label based on that choice.
4. Preview the precise before/after game changes, then explicitly approve. The protected compare-and-swap update replaces **one anonymous row only**, increments the locked publication revision, retains counts and the original file fingerprint, writes anonymous correction history, and confirms the result by read-back. If the revision/source/identity cannot be verified, the correction fails closed.
5. Confirm the public week and group-versus-field standings. If the organizer issues another correction, reload the new revision; stored anonymous history preserves the previous values needed to reverse a mistake.

**Audit preservation:** Once a week contains individual organizer corrections, the old Weekly Admin whole-sheet replacement action refuses to overwrite that week, because it would discard the correction history and could silently restore superseded picks. Use the individual correction page or separately review a history-preserving full-sheet migration.

**Source file requirement:** A standalone screenshot or notice is not sufficient to map a participant name to an anonymous row. The original full sheet (PDF, XLSX, XLS or XLSM) is required. Existing weekly Excel import uses the same strict local-sheet validator and may refuse incompatible spreadsheet layouts. No correction is automatically published, and no source names/images/workbooks are uploaded or kept by the app.

## 4. Publishing a genuine new Pick'em week — restricted operation

**You need:** The original authorized organizer sheet, access to the existing approved publisher account, and an appropriate backup/recovery position. This is not a normal viewer task.

1. Open [Pick'em Admin](https://r88510179-collab.github.io/nfl-pool/admin/). Sign in through the displayed one-time-code flow. **Never paste codes into AI chats or store them in Git.**
2. Choose the correct NFL season. Add a total-entry count **only if the source supports it**. Leave special absent-game fields blank unless a genuine documented exception exists.
3. Select the organizer's PDF or Excel file and choose **Read & validate sheet**. The file is parsed locally; the source file itself is **not** uploaded as a permanent server attachment.
4. Inspect every matchup/team number, all four tracked entries, the actual tiebreak, and whether anonymized full-field entries are present and complete.
5. Check schedule validation and Eastern kickoff days. If any duplicate team/game, unknown matchup, missing pick, mismatched field count, or ambiguous source exists, **stop and correct the source** before publishing.

   **Automatic PDF recovery:** When the first PDF pass cannot prove the whole field, the Admin attempts a conservative second pass using the verified participant-column positions and the same file still selected in the browser. It can reconnect uniquely aligned name/number rows and preserve missing/invalid picks as explicit no-picks, but it cannot invent a selection or bypass a wrong total. It also proves the table is unbroken: no gap where a row could be missing, every page but the last filled to the same bottom, the first page's rows starting directly under the Pts/W header, and no name without its pick cells. Because a cleanly removed PDF page leaves no trace in the file, recovery also compares the pool size with the previous published week, so **sign in before reading the sheet**. A drop of half a printed page or more is blocked as a possible missing page; if the pool really shrank, type the organizer's total in **Total pool entries** and read the sheet again (a typed total must then match exactly). A successful recovery is named in the review with its anonymized-entry, no-submission and exception counts; the publisher must still review and click Publish. Any refusal names the PDF page and table row to check (never a participant's name), and the publish button stays blocked. The original PDF is *not* retained on the server, so this is upload-time recovery, not a promise that a deleted source can be recreated later.
6. Preview the exact published configuration. Confirm the intended year, week and revision. Publishing is a protected write, not a harmless refresh; only proceed under the existing release/backup authorization.
7. After publishing, open the public app in a fresh session; verify the chosen week, revision, all four entries, ranks, games, tiebreak, and exact source fingerprint against the reviewed file.

A revision is an explicit replacement of the same week. The current system rechecks the previous revision before writing and reads back the result; stale concurrent writes are rejected. Do **not** bypass it with manual SQL or a re-upload guessed from memory.

**Survivor Admin** at \`nfl-pool/admin/survivor.html\` and **Incident Rulings** at \`nfl-pool/admin/rulings.html\` are restricted specialist tools, not ordinary personal tracking. Our tracked Survivor run is archived; don't resume it merely to fill a later-week gap. A ruling needs the organizer/commissioner's documented authority and valid policy, not a guess by the tracker owner.

## 5. The app's moving parts, in ordinary language

| File or folder | Role |
| --- | --- |
| \`index.html\` | The public Pool Center page and controls |
| \`weekly-app.js\` | Loads published Pick'em weeks, checks live NFL facts, computes the current weekly view, handles refresh/week switching |
| \`public-math.js\` / \`contest-rulings.js\` | Pick'em scoring, ranks, tiebreaks and documented hold/void decisions |
| \`picks-mobile.js\` / \`home-dashboard.js\` | Mobile Picks filters/cards and the Home dashboard |
| \`season-record.js\` | Read-only history across published Pick'em weeks |
| \`week-date-range.js\` | Read-only historical week-header correction from already-verified Eastern kickoff times; no new API request |
| \`survivor-app.js\` / \`survivor-math.js\` | Survivor history, eligibility, reused teams, results and the archive |
| \`score-feed-proxy.js\` / \`score-proxy/\` | ESPN-shaped score requests and the source implementation/tests for the gateway; deployed gateway health is checked separately |
| \`admin/\` | Local sheet parsers, validated publisher screens, Survivor historical publisher and incident rulings |
| \`service-worker.js\` / \`pwa.js\` / \`manifest.webmanifest\` | Installs the web app and caches the app shell for offline opening; **offline does not mean current NFL scores or new publications** |
| \`migrations/\` / \`sql-tests/\` | Database schema/security changes and disposable PostgreSQL behavior/race tests |
| \`acceptance/\` | Full acceptance instructions and independent score-reconciliation scripts |
| \`ops/cloud-smoke.mjs\` | Small read-only checks that public websites and the score gateway respond |
| \`.github/workflows/\` | Automatic tests, manual score checks and GitHub-based public endpoint monitor |

## 6. Where it is hosted, and how a release works

- **Public Personal Pool:** GitHub Pages at \`https://r88510179-collab.github.io/nfl-pool/\`, deployed from protected \`main\` after a reviewed merge. Another separately hosted domain or protected Vercel preview may point at the same app, but **do not confuse a Vercel preview with the production GitHub Pages release**.
- **Database:** Production Neon belongs to the Personal Pool. Its tables, identity controls and backups are not equivalent to GitHub's source code, and a green build does **not** back up database records.
- **NFL gateway:** \`nflscores2\` is deployed separately. Modifying the repository's gateway source does not automatically prove that the deployed gateway was updated.
- **Commercial V1/CRM:** Isolated project/branch workflows. Never apply their migrations to the Personal database or merge their staging branches into Personal \`main\`.

**Safe code release sequence:** Create a focused branch from current \`main\` → run code tests and SQL gates → inspect the precise diff for secrets/QA URLs and data changes → validate the actual UI at required mobile widths using synthetic QA or read-only production → obtain merge approval → merge exact tested head SHA → verify GitHub Pages deployment and post-merge CI → independently check the live page read-only. Preserve rollback history and backups.

## 7. Basic checks without asking AI to code

Use **GitHub → Actions** in this repository. Look for:

- **NFL Pool Tests:** 17 approved Node.js test suites (the job label still says “12-suite” for historical branch-protection reasons), SQL behavior/race checks on disposable PostgreSQL 17.11 (including the full-field publication guard that refuses a four-entry-only locked week from any client, even a stale cached Admin page), and syntax checks. No production database writes.
- **Pool live score parity (read-only):** Manually run for the actual season and week range; compares deployed \`nflscores2\` with fresh ESPN final scores. This checks feed parity, not whether ESPN itself is infallible.
- **Smokke Cloud Monitor:** Runs approximately every 15 minutes on GitHub's best-effort cron and checks public availability of multiple websites plus the score function. It is **not** Survivor tracking, authentication testing, a publication scheduler or a backup.

On a machine with Node.js 22, from the repository root you may run:

~~~sh
node nfl-pool/service-worker.test.mjs
node nfl-pool/weekly-app.test.mjs
node nfl-pool/admin/parser-core.test.mjs
node nfl-pool/acceptance/score-reconcile.mjs --season 2026 --weeks 1-9
~~~

These commands test local code or read public scores; the score command needs network access. To run **all** approved suites and the disposable PostgreSQL gates, use the existing GitHub Actions **NFL Pool Tests** workflow or its documented local harness. Do not point SQL tests at production.

## 8. Troubleshooting in a few steps

| Symptom | Most likely check / next action |
| --- | --- |
| Site will not load | Open the GitHub Pages build/deploy action and the Cloud Monitor's most recent public-site result |
| App loads but no week | Verify the published-week index; check whether the organizer actually supplied that week's validated file |
| NFL score delayed or unavailable | Refresh; compare \`nflscores2\` with ESPN using the read-only parity action; distinguish a temporary feed error from a data error |
| Pick'em rank looks wrong | Check the exact season/week/revision, all 4 picks, published full-field availability, final NFL results, ties and applicable rulings |
| Week date range says “Kickoff dates unverified” | The app has not verified every matchup's kickoff from the live feed. Do not infer dates from stored UTC values |
| Survivor archive is not current | Our tracked Survivor group is intentionally finished. Its historical published weeks remain accessible; the outside contest may continue |
| App offline or stale after an update | Reconnect, reload and let the service worker replace its shell cache. A cached app shell does not include fresh scores |
| A publisher is blocked | Stop; check identity, source, publication revision, policy and QA-vs-production target. Never weaken auth/RLS to make it pass |
| A release fails | Restore the last known-good **code** deployment first; for a genuine database problem follow the separate verified backup/restore playbook, never improvise SQL |

If an investigation needs a developer, include the site URL, page, selected week, exact release commit, what you expected, what actually happened, and relevant console/network evidence. Do **not** include passwords, OTPs or real participant source files.

## 9. Backups, permissions and maintenance

This repository is **not** the backup of the Neon production database. Historical backup/snapshot evidence exists, and an isolated no-compute branch was reported during the November 6 closeout, but **do not assume a current successful restore or new snapshot exists unless the actual maintenance tool confirms it**. The owner Maintenance Center and separately verified backup/restore scripts should be used for changes that could damage data.

Routine maintenance means checking public availability and score parity, viewing legitimate new Pick'em publications once available, and investigating reproducible defects. **No recurring Survivor-group monitoring** is needed; leave already-published Survivor weeks readable. No weekly refactor, new feature, or extra cloud tool is necessary solely because an upstream sheet has not arrived.

## 10. Project status and old branches

The historical PR #31 moved the eliminated Survivor group into an archive and tightened Pick'em validation. PR #32 corrected real mobile touch targets. Earlier PRs provided field rankings, sharing, PWA/mobile layouts and score parity. Test-only PRs #27 and #29 were intentionally closed without merging. Optional publisher UX and Claude config proposals (#26 and #25) were deferred.

For the **actual 28-branch inventory**, why each branch remains, cleanup priorities and the separate CRM work, see [the branch review](ops/BRANCH_REVIEW_2026-11-06.md). Do not treat an open Commercial CRM PR as an unfinished Personal Pool release.

**Documentation rule:** This README describes intended behavior, not a promise that any future code candidate is deployed. Verify the exact commit shown on GitHub \`main\` and its successful Pages deployment before claiming a fix is live.
