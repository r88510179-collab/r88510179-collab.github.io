# PR #30 — final mobile Week 10 selector acceptance (QA preview, inspection-only CSS)

**Result: PASS at 375, 390 and 430 CSS px** — run 2026-11-06 10:16 UTC. Continues the completed
[PR #29 acceptance](https://github.com/r88510179-collab/r88510179-collab.github.io/pull/29#issuecomment-6674108279),
whose only failure was this selector (“2026 · Week 10” clipped to “2026 · Week 1”).

## What was tested

| Item | Value |
| --- | --- |
| Fix under test | PR #30 head `34788854438144868fefe6f3c61aeb0676e9b5a6`, file `nfl-pool/week-selector.css` (git blob `11d45c3`, SHA-256 `f9acb1e880a3e3e0cfd5a96a69a028c902109e76679ed8cc27a86060b7bb8bd9`, 448 bytes), injected byte-for-byte |
| Browser target | Existing SSO-protected QA preview `dpl_B5FasHyJc66368k2Dmp5Cu6MUqEa` (app `68feca1`, branch `qa/personal-pdf-import-e2e-20261105`) |
| Data | PR #29’s synthetic Pick'em Week 10 revision 2 on Neon `green-base-66242978` / `br-damp-credit-bbn7d0zr` / `nfl_pool`, read only through the same-origin read-only `/api/qa-read` gateway |
| CSS baseline | All 8 stylesheets the preview served are byte-identical (SHA-256) to `main` `cdd6609` (PR #30’s base). The served `index.html` is byte-identical to `68feca1`, which differs from `main` only by the QA read-routing script. |

## Method

* One fresh Playwright 1.63.0 / Chromium 153.0.8010.12 headless context per width: viewport W × 844, DPR 2,
  `isMobile`, `hasTouch`, service workers blocked — the same emulation as PR #29’s `tracker-mobile.cjs`.
* Access reused the deployment’s existing temporary share link (Vercel reported `reused`, expiring 6 Nov 23:52).
  Vercel Authentication stayed on; the token is not recorded in any file.
* **Control:** `/nfl-pool/?view=standings&season=2026&week=10` with the deployed (= `main`) CSS → measured and cropped.
* **PR #30 CSS:** an init script inserts `<style data-qa-inspection="pr30-week-selector">` holding the exact file bytes
  directly after the `season-record.css?v=1` link — where PR #30 adds its `<link>` — before first render. The same
  URL is then loaded fresh, measured and screenshotted.
* **Usability:** actionability check (trial tap), hit-test at the select’s left, centre and right, then Week 10 → Week 9
  → Week 10 through the select itself.
* Nothing else was changed: no request, response, storage, application data or database. Every request was a GET.

## Results

| CSS width | Control select / content box | PR #30 select / content box | “2026 · Week 10” text | Label fits: control → PR #30 | innerWidth / clientWidth / scrollWidth / body scrollWidth / max scrollX | Week 10 data = PR #29 read-back | Selector usable (10 → 9 → 10) | Browser errors |
| ---: | --- | --- | ---: | --- | --- | --- | --- | --- |
| 375 | 126 / 76 px | 150 / 100 px | 83.32 px (84 rounded up) | no → **yes** (+16.68 px) | 375 / 375 / 375 / 375 / 0 | yes | yes | 0 |
| 390 | 126 / 76 px | 150 / 100 px | 83.32 px (84 rounded up) | no → **yes** (+16.68 px) | 390 / 390 / 390 / 390 / 0 | yes | yes | 0 |
| 430 | 126 / 76 px | 150 / 100 px | 83.32 px (84 rounded up) | no → **yes** (+16.68 px) | 430 / 430 / 430 / 430 / 0 | yes | yes | 0 |

* **Week 10 data:** the week line was `Week 10 · revision 2 · Nov 13–Nov 17, 2026 · D.C. · JC · DJS · Thaddeus`, with
  options `2026 · Week 9`, `2026 · Week 10`. All four standings rows (Overall `T-1 Top 3% · 43 tied`, W–L 0–0, 14 left,
  tiebreaks 35/37/55/41) were identical to PR #29’s recorded read-back, both on load and after switching back from Week 9.
  Week 9 loaded as `Week 9 · revision 3`; its label (78.13 px) also fits.
* **Layout:** the strip, summary and select stay inside the viewport. The select sits inside the strip’s content box and
  the summary ends before the select. Overflow stayed zero on load, on Week 9 and after returning to Week 10. The two
  injected selectors each matched exactly one element.
* **Summary line (truncation is intended in PR #30):** 375 `Week 10 · revision 2 · Nov 13–Nov…` (control `…Nov 17, 2…`),
  390 `…Nov 13–Nov 17,…` (control `…Nov 17, 202…`), 430 `…Nov 17, 2026 ·…` (control `…2026 · D.C. ·…`).
  “Week 10 · revision 2” stays visible at every width.
* **Margin for Weeks 10–18:** the widest two-digit label measures 83.32 px in the rendered font (Inter). Measured in wider
  installed faces at the same 850 / 11 px: DejaVu Sans 95.57 px, Liberation Sans 78.07 px and FreeSans 78.18 px. All
  are within the 100 px content box.
* **Isolation:** every gateway read returned 200 with `X-QA-Read-Only: 1`, from the anonymous token or backend
  `ep-shiny-snow-bbx446zt` only. The only hosts contacted were the preview and `a.espncdn.com` (league and team logo images). There were 0 production
  or QA-parent requests, 0 direct Neon requests from the browser and 0 non-GET requests.
* **Browser errors:** 0 application console errors or warnings, 0 page errors, 0 failed requests and 0 HTTP ≥ 400. The only console
  output was the harness warning `Service Worker registration blocked by Playwright`, 3 per width, caused by blocking
  service workers as in PR #29.

## Limits

* This is headless Chromium with CSS-viewport and touch emulation, not a physical phone. The container renders Inter (the app’s first font
  choice). SF Pro (iOS) and Roboto (Android) are not installed, so they were not measured; the wider DejaVu Sans probe is the margin check.
* The CSS was injected for inspection; it was not deployed. Loading `week-selector.css?v=1` through PR #30’s `<link>` and its
  `pool-center-shell-v33` precache are covered by PR #30’s CI (`service-worker.test.mjs`), not by this browser run.
* Survivor was not retested (it passed in PR #29). Its select is outside `.week-strip`, so neither injected selector reaches it.

## Files

* `runner/week-selector-mobile.cjs` — the runner. Reproduce from a checkout containing the commits above:
  `node runner/week-selector-mobile.cjs <file holding the share URL> <this folder>`
* `logs/week-selector-mobile.json` — summary, every check, all measurements, gateway rows and browser logs
* `logs/week-selector-mobile-network.json` — every response by method, host, path and status (no query strings)
* `screenshots/pickem-week10-strip-control-{375,390,430}.png` — control: clipped “2026 · Week 1”
* `screenshots/pickem-week10-strip-pr30-{375,390,430}.png` — PR #30 CSS: full “2026 · Week 10”
* `screenshots/pickem-week10-viewport-pr30-{375,390,430}.jpg` — full viewport with PR #30 CSS
* `screenshots/pickem-week9-strip-pr30-{375,390,430}.png` — after choosing Week 9 with the select
* `screenshots/pickem-week10-standings-pr30-{375,390,430}.png` — Week 10 standings after returning to Week 10
