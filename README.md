# Personal NFL Pool Center — project guide

**What this repository does:** It publishes a personal IT portfolio at the website root and a separate, read-only NFL Pool Center at [the NFL Pool page](https://r88510179-collab.github.io/nfl-pool/). The pool app follows a handful of our entries in an **externally organized** Pick'em contest. We do **not** run the underlying league, collect payments, or accept user picks through this public tracker.

**If you just want to use the app:** Open [Pool Center](https://r88510179-collab.github.io/nfl-pool/). Choose a published week, then use Home, Standings, Games, Picks or Archive. You do not need to sign in to view results.

**If you maintain the app:** Read [the complete plain-English Pool Center guide](nfl-pool/README.md). It explains the screens, where the numbers come from, how new weeks appear, the restricted publishing workflow, the live score source, deployments, tests, backups and basic troubleshooting.

## Where things live

| Location | What it is |
| --- | --- |
| [index.html](index.html) | The public portfolio/landing page at the repository's root |
| [nfl-pool/index.html](nfl-pool/index.html) | The Pool Center's public application |
| [nfl-pool/README.md](nfl-pool/README.md) | Owner's step-by-step guide and system explanation |
| [nfl-pool/admin/](nfl-pool/admin/) | Restricted weekly publication and incident-ruling interfaces; **not** ordinary participant login |
| [nfl-pool/ops/](nfl-pool/ops/) | Public health checks and branch review |
| [nfl-pool/acceptance/](nfl-pool/acceptance/) | Verification procedures and independent score comparisons |
| [.github/workflows/](.github/workflows/) | Automated code tests, score checks and public uptime monitoring |
| [nfl-pool/ops/BRANCH_REVIEW_2026-11-06.md](nfl-pool/ops/BRANCH_REVIEW_2026-11-06.md) | Branch inventory, completed work, outstanding decisions and cleanup safeguards |

## The three distinct projects

1. **Personal NFL Pool Center:** What the published \`main\` branch and \`nfl-pool/\` implement. A tracker, not a contest-management platform.
2. **Commercial V1 pool platform:** Separate application development on \`commercial-v1-netlify-adapter\` and other isolated work. It has its **own** release, access and database safeguards. Do not merge it into the personal website.
3. **Commissioner CRM:** A separate, unfinished staging feature tracked in [PR #19](https://github.com/r88510179-collab/r88510179-collab.github.io/pull/19). It is not enabled by the personal app.

## How changes reach the public Personal Pool

A proposed change goes into a focused Git branch → GitHub's tests run → the actual mobile/data behavior is checked → the reviewed pull request is merged into protected \`main\` → GitHub Pages builds and deploys → the public site is checked read-only. **A green CI run is not proof of a successful website deployment or a database restore.**

Never put passwords, session cookies, private publication files or anonymous-user JWTs into commits. Never use production Neon as a synthetic test database. Never merge QA-only publisher overrides, test accounts or same-origin QA gateways.

**Owner status, November 6, 2026:** The earlier Personal Pool closeout and 44px mobile touch-target fixes were released in PR #31 and PR #32. Historical Survivor is displayed as our group's archive; Pick'em remains active. The remaining date-label repair is intentionally a **read-only presentation change**, not a rewrite of old competition data. See its PR for exact deployment status; this README itself does not claim that an unmerged candidate is live.
