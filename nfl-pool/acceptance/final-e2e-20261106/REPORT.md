# Personal Pool — final E2E acceptance run (2026-11-06)

**Verdict: NOT fully accepted.** Everything that can run without an authorized publisher session passed on current `main`, one genuine defect was found and fixed, and isolation held. The authenticated publish → revision → read-back of *new* synthetic weeks on current `main` is **BLOCKED** (reason below), and with it the in-browser grading of a Pick'em NFL tie.

| Item | Value |
| --- | --- |
| Code under test | `main` at `756f2ac3b179cfd4fb62cef15a0e27e24ce6fcfb` (app files byte-identical, verified with `git diff --quiet origin/main -- nfl-pool`); post-fix reruns on this PR's fix |
| How it was served | `runner/qa-serve.mjs` at `http://localhost:8765/nfl-pool/` — repository files unchanged except a counted substitution of the production Neon Auth/Data API URLs → QA child, the production publisher identity → the synthetic QA publisher, and the `nflscores2` URL → a local instance of the repository's own gateway source (`score-proxy/index.mjs`) against the real ESPN API. Anything still naming production, the QA parent or the legacy Supabase function is refused (HTTP 500) — see `logs/qa-serve-failclosed-probe.jsonl` |
| Browser | Playwright 1.63.0, Chromium 153.0.8010.12 headless, service workers blocked, fail-closed network allowlist; mobile = CSS viewports 375/390/430 × 844, touch, DPR 2 (not physical phones) |
| Database | Neon `green-base-66242978`. Reads: child `br-damp-credit-bbn7d0zr` (`ep-shiny-snow-bbx446zt`). Parent `br-dawn-fire-bb923034`: fingerprinted only. Production `flat-cake-85432375`: never contacted or queried |
| Runs | 2026-11-06 17:16–17:40 UTC, 9 browser runs (`logs/e2e-*.json`) |

## Results

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Pre/post fingerprints of every QA publication, contest, policy, RLS policy, grant, auth identity, function, trigger, Data API CORS — parent (3 publications) and child (5) | **PASS — identical** | `db/fingerprints-pre.json`, `db/fingerprints-post.json` |
| 2 | Harness fails closed (wrong substitution count, leftover production marker, path traversal, `acceptance/`) | **PASS** | `logs/qa-serve-failclosed-probe.jsonl` |
| 3 | Pick'em import rejections in the real publisher: malformed PDF, tracked row missing a pick, duplicate tracked row, **team in two matchups (rule added after PR #29)**, matchup not on the NFL schedule | **PASS 5/5** — error shown, preview hidden, Publish disabled, 0 writes | `logs/e2e-imports-signed-out.json` P03–P07, `screenshots/imports-p0*.jpg` |
| 4 | Survivor import rejections: malformed PDF, unknown team, duplicate tracked row, pick of a team on bye | **PASS 4/4** | same log S01–S04, `screenshots/imports-s0*.jpg` |
| 5 | Valid synthetic sheets parse, match the live NFL schedule and preview: Pick'em 2026 W5 r1/r2 (15 games, 38 entries, **Eastern kickoff dates** Oct 8 … Oct 12 although several UTC dates differ); Survivor 2026 W8 (Weeks 1–8 verified, history matches published W6 r2) | **PASS** | P08, P08b, S05, `screenshots/imports-p08*-preview-*.jpg` |
| 6 | Publishing is impossible without a publisher session (Pick'em Publish disabled; Survivor "Sign in to compare…" block) | **PASS** | `logs/e2e-smoke-signed-out.json`, P01, S05 |
| 7 | Authenticated Pick'em/Survivor publish, duplicate/locked refusal, revision 2, stale-writer refusal, new-session + Data API + SQL read-back of the new weeks | **BLOCKED** | `logs/e2e-pickem.json` (P02); see *Blocker* |
| 8 | Pick'em NFL tie graded as a loss for both picks, in the browser | **BLOCKED** (needs #7: no existing QA publication contains a finished tie) | — |
| 9 | Survivor NFL tie elimination in the browser (QA W6 r2: DJS "NFL tie eliminated entry in Week 5", real NYG 27–27 WSH); loss and reused-team eliminations | **PASS** | T07, `screenshots/tracker-07-*.jpg`, `tracker-03-mobile-*-archive-*.jpg` |
| 10 | Read-back of existing QA Pick'em W9 r3 after the real JAX 33–10 BAL final: JC 1–0, Thaddeus 1–0 (T-1 of 5), D.C. 0–1, DJS 0–1 (T-4), 1/15 final, LIVE | **PASS** | T01, T02, `screenshots/tracker-01*`, `tracker-02*` |
| 11 | **Positive** group-vs-field pulse after a real final ("T-1 of 5 · JC · Top 20%", "2 of 4 submitted") — PR #27 could only observe the pending state | **PASS** | T02, `screenshots/tracker-02a-desktop-home-week9-field-pulse.jpg` |
| 12 | Score feed failure → FEED UNAVAILABLE, nothing graded (all 0–0, 0/15); Refresh after recovery → LIVE, correct W–L | **PASS** (injected 502) | T04, `tracker-04a/b-*.jpg` |
| 13 | Rules/rulings unreadable → ON HOLD banner, no game graded, field pulse withheld | **PASS** (injected abort) | T05, `tracker-05a/b-*.jpg` |
| 14 | Publication index unreadable on refresh → PUBLISHED DATA STALE, revision 3 and last verified standings kept | **PASS** (injected abort) | T06 |
| 15 | Week-strip dates use verified Eastern kickoffs (QA W9 r3 stores UTC dates Nov 6–10; strip shows **Nov 5–Nov 9**) | **PASS** normally · **FAIL on `main` in the stale state → fixed in this PR → PASS** | `e2e-tracker-rerun-T06-main-756f2ac.json` (red), `e2e-tracker-rerun-T06-fix.json` + `e2e-tracker-rerun-T01_T02_T06.json` (green); `screenshots/tracker-06-published-data-stale-main-756f2ac.jpg` vs `-fix.jpg` |
| 16 | Mobile 375/390/430: innerWidth = clientWidth = scrollWidth (no horizontal overflow) on Home, Standings, Picks and the Survivor archive; "2026 · Week 10" label 83.3 px inside a 100 px content box; every PR #32 target ≥ 44 px | **PASS** | T03-375/390/430, `screenshots/tracker-03-mobile-*.jpg` (DPR 2) |
| 17 | Anonymous Data API read-back returns exactly the locked QA rows (hashes match #1); anonymous INSERT (unused key, draft) refused **403 / 42501** | **PASS** | `logs/e2e-readback.json` |
| 18 | Isolation: 1,559 browser requests; hosts only `localhost:8765`, `cdn.jsdelivr.net`, `a.espncdn.com` (GET) and the QA child's Auth/Data API; **0** requests to production, the QA parent, the production score gateway, GitHub Pages, Vercel or Netlify; 0 violations, 0 refusals, 0 page errors; the only write request was the refused anonymous INSERT | **PASS** | `logs/isolation-summary.json`, `logs/qa-serve-requests.jsonl` |
| 19 | Console | **PASS** — outside injected-fault steps the only messages are "Service Worker registration blocked by Playwright" (test setting); 502/abort errors appear only in T04–T06 and the expected 403 in R02 | `logs/isolation-summary.json` (`consoleByStep`) |
| 20 | 17 approved suites (local, Node 22.23.4) on `main` and with the fix | **PASS 17/17** both | local runs; GitHub Actions result on this PR |

T04/T06 failed in the first full tracker run only because the runner clicked Refresh on the Standings view, where that Game Center control is not displayed (a harness bug); after fixing the runner, only T04 and T06 were rerun and passed (`e2e-tracker-rerun-T04_T06.json`).

## Defect found and fixed

On `main`, `week-date-range.js` corrects the week strip only when it reads `Week N · revision R · …`. While a publication cannot be re-verified the strip reads `PUBLISHED DATA STALE · revision R · …`, so it fell back to the publication's stored UTC dates — "Nov 6–Nov 10" for QA W9 r3 instead of "Nov 5–Nov 9" — contrary to the README ("rather than trusting UTC dates from old PDFs"). The fix also accepts the stale lead, keeps the warning verbatim, still refuses another revision, and shows "Kickoff dates unverified" when kickoffs are not verified. Release mechanics follow the PWA rules: module `?v=2`, shell cache `pool-center-shell-v37`, and the bounded inverse/hash gates in `service-worker.test.mjs` updated (the old "stale line unchanged" assertion now expects corrected dates; new cases cover both warnings, unverified kickoffs, another revision and Week 1 vs 11). Presentation only: no score, rank, publication, database or feed change.

## Blocker (what prevents #7 and #8)

Only two identities may write publications: the real production publisher identity (on the parent and the child) and, on the child only, the synthetic `qa.pdf-e2e.publisher@example.com` (role `admin`, PR #29's additive policies). Current `main` signs in only with an emailed code. The synthetic address is a reserved `example.com` address with no mailbox, and the QA child's Neon Auth stores codes **hashed** (`neon_auth.verification`), so no code can be obtained; PR #29's password sign-in was a QA-only page change and its password existed only on that runner. The page's single code request (17:17:17Z) expired unused at 17:22:17Z; nothing else changed. Publishing therefore needs an owner decision that changes QA authentication — not done here:

1. **Owner-run:** run `runner/e2e.cjs pickem survivor tracker` against the QA child with an identity whose mailbox you control (the runner waits for the code in a local file, never in Git or chat), after authorizing that identity on the **child only**.
2. **Authorize a synthetic password publisher on the child only** (sign-up through the child's own Neon Auth, role `admin`, six additive child-only policies as in PR #29). The runner would sign in through the supported email/password endpoint and then use the unmodified publisher pages.

Either way the fixtures (`fixtures/`, SHA-256 in `fixtures-manifest.json`) and scenarios are ready: Pick'em 2026 W5 (contains the real NYG 27–27 WSH tie) r1 → duplicate refused → r2 → stale writer refused; Survivor 2026 W8 r1 → duplicate refused → r2 → stale validation refused; then read-back.

## Files

`runner/` — `make-fixtures.py` (deterministic PDFs), `preflight-parse.mjs` (static, not E2E evidence: `logs/static-preflight-parse.jsonl`), `qa-serve.mjs`, `e2e.cjs`. QA tooling only: nothing in the app loads it, it holds no credentials, and it refuses production targets. `db/` — fingerprints. `logs/` — per-run step results, network, writes and console. `screenshots/` — 40 JPEGs, synthetic or QA data only. The real publisher address was redacted from `logs/qa-serve-requests.jsonl` after capture (10 occurrences in substitution labels); the harness now logs labels only.
