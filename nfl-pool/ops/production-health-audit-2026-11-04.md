# Personal NFL Pool Center — Production Health Audit

**Date:** 2026-11-04 (between Week 8 finals and Week 9 kickoff)
**Scope:** `nfl-pool/` in `r88510179-collab/r88510179-collab.github.io` at `main` 6b1ac9f, the production Neon project
`NFL Pool` (flat-cake-85432375), the score function `nflscores2` (project `NFL Pool Functions`, patient-thunder-85353337),
and the validation repo `r88510179-collab/personal-nologin-offline-validation` at e104348.
**Mode:** read-only. No production row, setting, deployment, branch or snapshot was changed. Every database read was a
`SELECT`; the live site was driven in a headless phone-sized browser exactly as a participant would use it.

## 1. Production health assessment

**Verdict: healthy for scoring, with two operational gaps (data freshness and backups) and a handful of low-severity defects.**

| Area | State | Evidence |
| --- | --- | --- |
| Pick'em scoring accuracy | **Verified** | 32 of 32 tracked standings rows across all 8 published weeks match an independent recomputation (records, group rank, tiebreak deltas, full-field rank, top %, games back). Season totals match (112 graded games). |
| Tie rule | **Verified on live data** | 2026 Week 5 NYG @ WAS ended 27–27 (OT). Displayed Week 5 standings equal the recomputation with a tie counted as a loss for both picks. |
| Survivor accuracy | **Verified** | Week 7 counts (247 / 18 / 18 / 18 / 13 still in / 5 out this week / 229 out before), every tracked state, the pick distribution and the week-by-week attrition match the independent recomputation. |
| Score feed | **Verified** | Weeks 1–8: 16, 16, 16, 16, 15, 14, 14, 14 events, all `STATUS_FINAL`, no duplicate ids or teams, every published game found, every published `eventId` equal to the feed's. Live origin rules behave as coded (both personal origins echoed, foreign origin 403, `week=23` 400). |
| Rulings layer | **Verified, unused so far** | 2 contests, policy revision 1 each, 0 incident rulings. Deployed trigger and RPC function bodies are byte-identical to the repo migrations (md5 match for all 4). RLS, column grants and the 9 append-only triggers match migrations 001/002/004/005. |
| Deployment parity | **Verified** | `weekly-app.js`, `survivor-app.js`, `picks-mobile.js`, `service-worker.js`, `index.html` are byte-identical on GitHub Pages, on `picks.smokkeventures.com` (Vercel) and at `main`. Service-worker precache list equals the versions `index.html` loads. |
| CI gates | **Green on main** | NFL Pool Tests run 132 (17 suites + SQL behavior gate) passed on 6b1ac9f; the 15-minute public smoke monitor has passed every run. All 17 suites also pass locally on Node 22.23.4. |
| Data freshness | **Gap** | Pick'em is published through Week 8; the latest locked Survivor snapshot is **Week 7** (published 2026-10-25). Nothing on Home says Survivor is a week behind. |
| Backups | **Gap** | Neon history retention is 6 hours, there is **no snapshot schedule**, and the only snapshot is the manual `pre-hdc14-2c901a8` from 2026-10-10 (before Weeks 5–8 were published). |
| Admin write path | **Solid, low-severity items** | Compare-and-swap on `(season, week, revision)`, one-row writes, read-back on lost responses; see §3 and §4. |
| Validation repo | **HOLD intact** | 6 offline guardrail tests pass; nothing native was executed; disposition stays HOLD / REFUSE FOR PRODUCTION. |

## 2. Verified scoring-integrity findings

### 2.1 Method
An independent recomputation (`nfl-pool/ops/standings-reconcile.mjs`, added with this audit) reads only what a participant's
browser reads: the anonymous Data API token, the locked `nfl_pool_weeks` / `nfl_survivor_weeks` rows and the public
`nflscores2` output. It imports nothing from the app. Its output was compared with the page's own share, picks and season
snapshots, captured from the live site for every published week (Pick'em Weeks 1–8, Survivor Weeks 2–7).

### 2.2 Pick'em, 2026 (displayed = recomputed for every row)

| Week | Rev | Games | Field | Tiebreak | Standings (group rank · W–L · overall) |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 14 | none | DEN@KC 41 | JC 12–2 · Thaddeus 11–3 · D.C. 10–4 · DJS 8–6 |
| 2 | 2 | 15 | 282 | NYG@LAR 34 | DJS 9–6 T-111 · D.C. 9–6 T-139 · Thaddeus 8–7 T-215 · JC 6–9 T-276 |
| 3 | 4 | 15 | 280 | PHI@CHI 34 | DJS 9–6 T-47 · D.C. 8–7 T-96 · JC 8–7 T-96 · Thaddeus 0–15 #280 (no submission) |
| 4 | 3 | 15 | 279 | ATL@NO 69 | JC 11–4 T-49 · Thaddeus 9–6 T-138 · D.C. 9–6 T-169 · DJS 8–7 T-210 |
| 5 | 1 | 14 | 281 | BUF@LAR 71 | DJS 8–6 T-132 · JC 8–6 T-153 · Thaddeus 8–6 T-153 · D.C. 6–8 T-257 |
| 6 | 1 | 13 | 276 | WAS@SF 40 | D.C. 8–5 T-70 · DJS 8–5 T-125 · JC 7–6 T-191 · Thaddeus 0–13 #276 (no submission) |
| 7 | 1 | 13 | 276 | DAL@PHI 59 | D.C. 9–4 T-21 · JC 7–6 T-190 · DJS 5–8 T-237 · Thaddeus 0–13 #276 (no submission) |
| 8 | 1 | 13 | 276 | CHI@SEA 51 | D.C. 8–5 T-204 · JC 8–5 T-210 · DJS 7–6 T-241 · Thaddeus 0–13 #276 (no submission) |

Season to date (shown on Home and Standings, and recomputed): D.C. 67–45 (59.8%), JC 67–45 (59.8%), DJS 62–50 (55.4%),
Thaddeus 36–76 (32.1%, no picks in Weeks 3, 6, 7, 8). Week 8 group winner D.C. over JC on the tiebreak (Δ4 vs Δ6), as shown.

Notes on rules as implemented and displayed: a missing pick on a final game is a loss; a verified NFL tie is a loss for
both picks (Pick'em) and an elimination (Survivor); a void game (confirmed commissioner ruling) scores nothing and removes
the tiebreak for that week; a no-submission week counts every graded game as a loss in the season record, and the
Standings card says so explicitly.

### 2.3 Survivor, 2026 Week 7 (latest locked snapshot)
Pool 247 · eligible entering 18 · submitted 18 · legal 18 · still in 13 · pending 0 · eliminated before 229 · this week 5.
Tracked: D.C. OUT (Week 5, DAL lost), DJS OUT (Week 7, NYJ lost), Thaddeus OUT (Week 1, LAC lost).
Distribution MIN 5 (28%), DEN 4, HOU 4, CLE 2, DAL 1, LAR 1, NYJ 1. Attrition W1 161/86, W2 98/63, W3 81/17, W4 77/4,
W5 52/25, W6 18/34, W7 13/5. All equal the recomputation.

### 2.4 Data and schema facts confirmed in production (read-only)
- `public.nfl_pool_weeks`: 8 locked rows (2026 W1–W8), revisions 1, 2, 4, 3, 1, 1, 1, 1; no draft rows. PK `(season, week)`,
  `status IN ('draft','locked')`, `revision > 0`; **no trigger** (revision and `updated_at` are client-supplied). RLS on;
  anonymous may `SELECT` only `status='locked'`; `authenticated` INSERT/UPDATE/SELECT only when the `neon_auth."user"` row is
  the commissioner (`role='admin'`, not banned); no DELETE grant.
- `public.nfl_survivor_weeks`: 6 locked rows (W2–W7), each revision 1, source files `Suicide 26 wN.pdf` with SHA-256 stored.
- `nfl_contests` (2 rows, `starts_at` 2026-09-10 00:20 UTC), `nfl_contest_policies` (void / advance_team_used, revision 1),
  `nfl_incident_rulings` (0 rows). Public column grants exclude `created_by` and `admin_note`, as the client expects.
- Function bodies: `nfl_append_incident_ruling` 3ba1d111…, `nfl_append_absent_incident_ruling` 130222cf…,
  `nfl_incident_rulings_check_insert` 13a3f489…, `nfl_contest_policies_check_insert` e79eaeb6… — each equal to the repo.
- Published field entries carry only `id`, `pickNumbers`, `tiebreak` (Pick'em) or `id`, `picks` (Survivor). Ids are
  positional per week (`field-001…`), so the same id is not the same person across weeks; the app never links them, and
  season totals cover tracked entries only.
- `nflscores2`: deployment 4 (2026-10-25 16:03 UTC, nodejs24), created after PR #21 merged the dual-origin source. The
  deployed source itself is not readable through the tools used here; its behavior was verified live (origins, parameter
  rejection, projection) and PR #23's draft parity check reports 107/107 Weeks 1–7 finals matching ESPN and NFL.com.

## 3. Confirmed defects (evidence-backed; none affects standings)

| # | Severity | Defect | Where | Evidence |
| --- | --- | --- | --- | --- |
| D1 | Low (time zone) | Published game `date` is the **UTC** calendar day of the ESPN kickoff. Sunday-night and Monday-night games are published one day late (e.g. CHI@SEA Mon Nov 2 8:15 PM ET published as 2026-11-03). The week strip therefore reads "Nov 1–Nov 3, 2026" for Week 8, and the Picks board's "Kickoff TBD" fallback would group such a game under the wrong weekday whenever the feed has not yet supplied the kickoff. | `admin/admin.js:194` (`String(e.date).slice(0,10)`); consumed by `weekly-app.js:230-233` and `picks-mobile.js:64-69,97-100` | 2 games per week flagged in every week 2–8 of the recomputation; capture shows "Sep 20–Sep 22", "Nov 1–Nov 3". Week 1 (sheet-derived `sourceDate`) is correct. |
| D2 | Low | `rpcErrorInfo` replaces the server's `HDC13_INVALID_INPUT` / `HDC14_INVALID_INPUT` reason with fixed text, so a server-only refusal hides which argument failed. | `admin/incident-rulings.js:719-720` (texts `:57,:76`) | Code read; mitigated by client-side pre-validation `:122-141`. |
| D3 | Low | Survivor publish read-back identity omits `status`, unlike the Pick'em read-back. | `admin/survivor-admin.js:94` vs `admin/admin.js:240` | Code read; Pick'em case is tested (`parser-core.test.mjs:1603`), Survivor is not. |
| D4 | Low | A team appearing in two different sheet games is not rejected by the parser or either `validateConfig`; only the schedule verification step stops it. | `admin/parser-core.js:505,623`; `weekly-app.js:176-182`; guard at `admin/admin.js:183-189` | Code read; tested only at the schedule step (`parser-core.test.mjs:2025`). |
| D5 | Low (hygiene) | `nfl-pool/app.js` is an unreferenced legacy Week-1 app with hard-coded picks and a Supabase proxy URL. Nothing loads it. | `nfl-pool/app.js` | No reference in any HTML, JS, test or workflow. |
| D6 | Nit | Score-function 400/403 responses carry the cacheable `cache-control` (`max-age=5, s-maxage=10`) and no `Vary: Origin`. Harmless in practice because every page request appends a `_=` cache-buster. | `score-proxy/index.mjs:101-113,126-128` | Live 403 response headers. |

## 4. Broken or risky workflows

No broken workflow was found. Risky ones, each with the concrete scenario:

| # | Risk | Scenario | Status |
| --- | --- | --- | --- |
| R1 | **Survivor publication lag** | Week 8 Pick'em was published Nov 1; no Week 8 Survivor snapshot exists. Home shows "Survivor FINAL · Week 7" beside "Pick'em FINAL · Week 8" with no hint; Decision Support targets Week 8 (already final), so it says "No market-favorite lines are available yet" for a week that is over. The Week 9 feed already carries lines for all 15 games, so the guidance works once Week 8 is published. | Operational; confirmed on the live site. |
| R2 | **Backups cover 6 hours** | A bad publish or an accidental UPDATE after 6 hours cannot be undone from Neon history; the only snapshot predates Weeks 5–8. Re-publishing from the owner's PDFs (SHA-256 stored) is the real recovery path and depends on those files existing. | Confirmed (`history_retention_seconds` 21600, empty schedule, one snapshot). |
| R3 | **Two bye teams on a sheet publish as an "absence exception"** | Both teams absent from the week feed makes the game look like a moved game; the commissioner types `WEEK N AWAY @ HOME ABSENT` and the game is published with no event, settled only by an absent-game ruling. Survivor refuses the same case; Pick'em has nothing to check against. | Gated solely by the typed attestation (`admin/admin.js:171,183-188`). |
| R4 | **Survivor earlier-week republish is not compared with later weeks** | Week 7 is locked; republishing Week 5 only prints "Published Survivor Week 7 already exists" and never compares histories; the public page and rulings page use the latest week, so a divergent Week 5 is reachable only via `?sw=5`. | `admin/survivor-publish-checks.js:246-247`. |
| R5 | **Revision is client-derived** | The admin client always writes `existing.revision + 1` through a CAS, so two tabs or a double click cannot lose an update or skip a revision. But the table has no trigger, so any other writer could reuse a revision; open pages re-download a week only when the listed revision changes (`weekly-app.js:525-532`), so a same-revision content change stays invisible until reload. | Only the admin client is a writer today. |
| R6 | **Publish does not re-read the schedule** | Event ids are captured at validation; a changed id between validation and publish is stored stale and later surfaces as `HDC13_EVENT_MISMATCH` until the week is republished. | `admin/admin.js:190-194,272`. |
| R7 | **Unauthenticated OTP trigger** | Anyone who opens an admin page can press "Send sign-in code" and email the commissioner a code; only Neon Auth rate limiting bounds it. | `admin/admin.js:67-75`. |
| R8 | **Session expiry mid-publish** | An expired JWT produces "Publish outcome unknown … could not be read back" rather than "sign in again"; nothing is written, but the message misleads. | `admin/admin.js:308`, `survivor-admin.js:233`. |
| R9 | **Week 9 QA work in flight** | Branch `test/personal-week9-isolated-qa-20261104` fails CI at `parser-core.test.mjs` (the harness pins the pdfjs CDN import string, which that branch changed); a QA Neon project `NFL Pool Personal Week9 Recovery QA 2026` (green-base-66242978) was created today and holds Week 9 rows only. Nothing on `main` or in production is affected. | Keep the QA project isolated; it is not an approval to change production (see §8). |

## 5. UX improvements ranked by user impact (phone, 390×844, Nov 4 live site)

Observed: no console errors, no page errors, no horizontal overflow on any view, one aborted request by design, every
status vocabulary consistent across header, cards and dashboard. Ranked by impact:

1. **Say when Survivor is behind Pick'em (R1).** A one-line notice on Home and the Survivor hero ("Week 8 Survivor sheet
   not published yet") removes the most likely confusion this week.
2. **Picks board after the week ends hides every pick.** With no live game every kickoff slate is collapsed by default
   (`picks-mobile.js:208`), so a finished week shows four headers and "Expand all" and no picks. Open the slates (or at
   least the tiebreak slate) when the week is complete, or show each entry's weekly record in the board header.
3. **Week strip dates (D1).** "Nov 1–Nov 3, 2026" for a week that ended Monday Nov 2 undermines the Eastern-time promise.
4. **Tap targets below 44 px:** settings "•••" 38×38, header Share 36 px tall, week selector 38 px, "Admin" menu link 35 px,
   Refresh 38 px, Picks segments 42 px. Everything else measured is ≥ 44 px. A CSS-only bump fixes all of them.
5. **Truncated status pill on Survivor:** "PICK'EM PAUSED · refres…" is cut at phone width. Shorten to "PICK'EM PAUSED".
6. **Decision Support copy for a finished target week** ("…not available yet") should say the week is already final.
7. **Collapsed-section summaries** on Home are good; consider adding the Pick'em weekly record of the spotlight entrant to
   the Survivor chip row for symmetry (optional).
8. **Accessibility is in good shape:** `aria-live` regions, `aria-expanded` disclosures, modal `<dialog>`s with focus
   return, decorative logos with empty `alt`, shortened names carry screen-reader full names. Small 10–11 px uppercase
   kickers are the main legibility risk; not measured for contrast here.

Preserved and working: week switching, submission notes ("No picks submitted this week" in the entry picker), the
Disagreements-only switch, the combined dashboard share card (PNG generated; headless browser falls back to Download /
Copy link / Copy summary as designed), owner-vs-member comparison, safer-favorite guidance code path (lines present in
the Week 9 feed).

## 6. Regression risks

- **Rulings have never fired in production.** The void/hold/under-review paths are covered by 17 suites and the SQL
  behavior and race gates, but no real halted game has exercised them end to end. The first real incident is the first
  live test; the admin preview and typed-phrase confirmation are the safety net.
- **Pinned CDN import strings in tests.** `parser-core.test.mjs` asserts the exact pdfjs import; any dependency bump turns
  the gate red (seen today on the QA branch). Intended, but plan the test update with the bump.
- **Season record network load.** Every Pick'em refresh re-reads unsettled other weeks' feeds; settled weeks are never
  re-read. A phone session that switched all 14 published weeks made 127 Data API and 68 score-function requests in four
  minutes; a normal session is far lighter. Watch it when the season has 18 weeks and live games.
- **Service worker cache generation** `pool-center-shell-v31` is network-first with `cache:'reload'`; the precache list is
  consistent with `index.html`. Forgetting to bump a `?v=` on a changed module would serve mixed versions only on an
  offline fallback, not online.
- **Full-field validation versions 2, 3, 4** coexist across weeks; the page's acceptance rules for null tiebreaks and
  no-picks depend on them (`weekly-app.js:187-191`). Keep the version in sync when the parser changes.
- **`fullFieldReady` false weeks** (Week 1) show no overall rank; the UI says so ("Full-field data unavailable").
- **Season-total rule for no-submission weeks** is a product decision that affects the displayed percentages (Thaddeus
  32.1%); it is stated on the card. Changing it later would change history.

## 7. Data-preservation safeguards (recommended; none executed)

1. **Enable a daily Neon snapshot schedule** on the `NFL Pool` main branch and take a manual snapshot before each
   publish or ruling, as `pre-hdc14-2c901a8` did. Consider marking the main branch *protected* (it is not).
2. **Weekly public-row export without secrets:** a GitHub Actions job can read the locked rows through the anonymous token
   exactly as the page does and store them as a run artifact (no login, no write). This preserves every publication at
   every revision even if the database is lost. `nfl-pool/ops/standings-reconcile.mjs --json` already captures the graded
   result; a sibling export of the raw rows is a small addition.
3. **Keep the source PDFs** (`Suicide 26 wN.pdf` and the Pick'em sheets) with their stored SHA-256 in a private location;
   they are the only re-publish path beyond 6 hours.
4. **Keep the Week 9 QA project isolated** from the production pages and delete it when the QA ends; never point
   `weekly-app.js` / `survivor-app.js` constants at it.
5. **Run the reconciliation after each publish** (see §9, Package A) and keep its JSON with the week's evidence.

## 8. Recovery review

- **Validation repo (`personal-nologin-offline-validation`).** Documents a HOLD / REFUSE FOR PRODUCTION disposition, a
  synthetic-only Mac preflight that refuses to run outside Darwin or without `--run-synthetic`, and 6 offline guardrail
  tests (all pass here on Linux). It contains no credentials, dumps or the locked ZIP (pinned SHA-256 only). Its
  `AGENTS.md` forbids Neon contact, production SQL, lock weakening and deployments. Nothing in it is an authorization to
  change the backup role or production; a passing offline run proves repository hygiene, not platform semantics. No change
  was made to that repo.
- **Rollback paths.** GitHub Pages serves `main` (deployed assets equal `main`); rollback is a revert commit on `main`
  through the existing gate. Vercel project `nfl-pool-personal` deploys production from `main` (last production deploy
  6b1ac9f, Oct 29) and lists the previous production deployment as an instant-rollback candidate; previews are SSO-protected
  except the custom domain. The score function is deployed separately (deployment 4) and is not rolled by a Git revert.
- **Database recovery.** 6-hour point-in-time history, one manual snapshot (Oct 10), no schedule (§7). Restoring a snapshot
  would overwrite Weeks 5–8 publications unless re-published from PDFs; do not restore without a fresh snapshot first.
- **Not executed:** no restore, no branch reset, no snapshot creation, no native Mac preflight.

## 9. Small, bounded improvement packages

| Pkg | Scope | Files | Risk | Notes |
| --- | --- | --- | --- | --- |
| A | **Read-only reconciliation tool** (included in this branch) | `nfl-pool/ops/standings-reconcile.mjs` | None (reads public data only) | Run after each publish; optional `workflow_dispatch` job later. Not in the 17-suite inventory (not a test). |
| B | **Eastern-time published dates (D1)** | `admin/admin.js:194` + one parser-core/admin test | Low | Derive the day in `America/New_York` with `Intl.DateTimeFormat`. Historical rows keep the UTC day unless republished; the week strip and TBD grouping are the only consumers. |
| C | **Survivor freshness notice + copy (R1, UX 1, 5, 6)** | `home-dashboard.js`, `survivor-app.js`, `weekly-app.js:482` | Low | Compare the two snapshot weeks in the dashboard; shorten "PICK'EM PAUSED"; reword past-week decision support. |
| D | **Picks board default for finished weeks (UX 2)** | `picks-mobile.js:208`, `picks-mobile.test.mjs` | Low | Open slates when every game is final (manual choices still win). |
| E | **44 px tap targets (UX 4)** | `style.css`, `share.css` | Trivial | Min-height on `.app-menu summary`, `.week-select`, `.share-btn`, `.btn`, menu links. |
| F | **Admin polish (D2, D3, D4)** | `admin/incident-rulings.js`, `admin/survivor-admin.js`, `admin/parser-core.js` + tests | Low | Pass the server detail through; add `status==='locked'` to the Survivor read-back; reject a team in two sheet games at parse time. |
| G | **Remove `app.js` (D5)** | `nfl-pool/app.js` | None | Dead file with a stale third-party URL. |
| H | **Backup posture (§7)** | Neon settings, one Actions workflow | Needs owner approval (Neon settings change) | Snapshot schedule + public-row export artifact. |
| I | **Score-function cache nit (D6)** | `score-proxy/index.mjs` + its test | Low; redeploy is separately gated | `no-store` on 400/403; `Vary: Origin` on every response. |

None of these changes scoring. B, C, D, E, F, G, I are each a single small PR with a test; A is already here; H is
operational.

## 10. What was not verified, and why

- The SQL behavior and race harness was not re-run in the audit container (no Docker daemon); the evidence is the green
  `sql-behavior-gate` job on `main` (run 132) and today's run on the QA branch, plus the deployed function md5 match.
- The deployed `nflscores2` source could not be read directly; behavior and the PR #23 parity record stand in for it.
- Neon Auth OTP rate limiting, the neon-js token refresh behavior and the Data API's zero-row UPDATE representation were
  not exercised (they would require a sign-in or a write).
- Contrast ratios were not measured.
- GitHub Pages source settings are not readable with the tools available here; byte-identical assets on the live site and
  `main` are the evidence that Pages serves `main`.
