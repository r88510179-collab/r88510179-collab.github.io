# Audit evidence, 2026-11-04

Captured read-only from the live Pool Center (GitHub Pages) and the public Data API during the production health audit
(`../production-health-audit-2026-11-04.md`). Nothing here was written to production.

- `live-site-capture.json`: the page's own share, picks, season and Survivor snapshots for every published week, header
  texts, console/network log, tap-target measurements and overflow checks, driven in a 390x844 headless browser.
- `recomputed-pickem.json`, `recomputed-survivor.json`: the independent recomputation compared against those snapshots
  (32/32 Pick'em rows and the Survivor Week 7 counts matched). Produced by the same logic as `../standings-reconcile.mjs`.
- `phone-*.png`: phone-width screenshots of Home, Standings, Games, Picks, Survivor and the combined share-card preview.

The raw published rows and the score-feed payloads are reproducible from the public endpoints and are not stored here.
