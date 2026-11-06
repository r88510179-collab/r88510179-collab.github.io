# Personal NFL Pool — authorized QA publisher E2E closeout (6 November 2026)

## Verdict: PASS, isolated synthetic QA acceptance

This follow-up completes the **two BLOCKED items** in the original [final E2E report](REPORT.md). The first attempt on 6 November stopped at synthetic email-OTP sign-in. The owner subsequently authorized child-only synthetic password authentication. The actual publish, revision, stale-writer, fresh-session read-back, and Pick'em NFL-tie grading were executed successfully.

**This is not a production deployment or an authorization to merge.** It establishes acceptance of the current production-aligned source paths, with PR #34's separate week-date presentation fix and with explicit QA-only Auth/Data API endpoint substitutions. Only the QA authentication step was replaced in the disposable test harness.

### Exact scope and boundary

- **GitHub**: `r88510179-collab/r88510179-collab.github.io`; PR [#34](https://github.com/r88510179-collab/r88510179-collab.github.io/pull/34), branch `claude/nfl-pool-final-e2e-uhkybv`, source SHA `2c878f99a2943ca5240f4d8538618f5fa13fe435` (before this report). This branch includes the one independently reviewed date-strip fix; the original baseline `main` was `756f2ac3b179cfd4fb62cef15a0e27e24ce6fcfb`.
- **Only Neon writes**: project `green-base-66242978`, child branch `br-damp-credit-bbn7d0zr`, database `nfl_pool` (child Auth/Data API endpoint `ep-shiny-snow-bbx446zt`). The parent `br-dawn-fire-bb923034` was inspected read-only; live production `flat-cake-85432375` was neither contacted nor modified.
- **Authentication**: created a separate synthetic `qa.pdf-e2e.final20261106@example.com` identity through the child's supported Better Auth email/password sign-up endpoint; set that child's Auth role to `admin`; added only six additive child-only RLS policies scoped to its *exact user ID*, *exact synthetic email*, admin role, and non-banned state. Original policy predicates and other roles were unchanged. No password, token, cookie or Auth credential is committed or recorded in this report.
- **Browser**: Chromium 153 / Playwright 1.63, real file inputs and clicks against a fail-closed local same-origin harness. App source was retargeted only for the exact Auth/Data API endpoint and synthetic publisher identity, and used the repository's own NFL gateway code against ESPN. QA password sign-in used a temporary test-runner Neon SDK client and then **reloaded** the unmodified publisher modules to restore the session. No production auth UI, publisher logic, database configuration, or deploy was changed.
- **Egress**: session-level network allowlist, plus the test runner's stricter request guard. No actual application requests to production, parent, Vercel, Netlify or external non-approved hosts. The disposable browser environment was not exposed as a public deployment.

### Authenticated publisher results — real browser and Data API

| Acceptance gate | Actual result |
| --- | --- |
| Pick'em current code: authenticated sign-in, signed-out publish refusal, PDF preview and schedule verification | **PASS** |
| Pick'em malformed/missing-pick/duplicate-entry/duplicate-team/off-schedule imports | **PASS** 5/5 rejected |
| Pick'em 2026 Week 5 first locked publication via one INSERT | **PASS**, revision 1 |
| Pick'em duplicate publish without Replace | **PASS**, refused, 0 writes |
| Pick'em revision 2 compare-and-swap | **PASS**, UPDATE |
| Pick'em concurrent stale writer vs later successful revision | **PASS**, stale writer refused, final revision 3 |
| **Pick'em full scenario** | **15/15 steps PASS**, four authorized write requests, 0 refused/forbidden network requests, 0 page errors |
| Survivor malformed/unknown-team/duplicate-entry/bye-week picks | **PASS** 4/4 rejected |
| Survivor 2026 Week 8 first locked publication via one INSERT | **PASS**, revision 1 |
| Survivor duplicate without Replace | **PASS**, refused, 0 writes |
| Survivor revision 2 compare-and-swap and stale validation refusal | **PASS**, final revision 3 |
| **Survivor full scenario** | **10/10 steps PASS**, three authorized write requests, 0 refused/forbidden network requests, 0 page errors |
| Fresh **unauthenticated** browser Pick'em Week 5 revision 3 read-back | **PASS**, `LIVE`, 15/15 finals, 0 remaining |
| Independent ESPN math vs actual browser standings | **PASS**, all four tracked entries match |
| **NYG 27–27 Washington tie** (2026 Week 5) | **PASS**: two tracked entries picked NYG, two picked Washington, and all four receive a loss for this matchup (no push or win) |
| Fresh unauthenticated mobile Survivor Week 8 revision 3 read-back | **PASS**, `LIVE · NFL results`, tracked elimination reasons including W5 NFL tie and W8 Seattle loss; at 390 CSS px, document scroll width exactly 390 |

The independent Pick'em grading used ESPN's 15 completed 2026 Week 5 event records, each matched by the published NFL event ID, and compared expected W/L counts to visible, freshly loaded HTML standings:

| Tracked QA entry | ESPN-derived W–L | Browser W–L |
| --- | --- | --- |
| D.C. | 13–2 | 13–2 |
| JC | 12–3 | 12–3 |
| DJS | 13–2 | 13–2 |
| Thaddeus | 12–3 | 12–3 |

### Database preservation verified after writes

These are SHA-like **first 16 hex characters of `md5(config::text)`**, intended for before/after equality, **not** publication source SHA-256:

| Existing child row | Before | After |
| --- | --- | --- |
| Pick'em W9 r3 | `d6d616b68a08f754` | identical |
| Pick'em W10 r2 | `a843be04b824410a` | identical |
| Survivor W2 r2 | `64ed41ebe842a078` | identical |
| Survivor W6 r2 | `9fef33e0766ba088` | identical |
| Survivor W9 r1 | `f5800e61c4e00cd2` | identical |

New **child-only** test rows are Pick'em W5 **locked r3** (`e23e44cba9922df8`) and Survivor W8 **locked r3** (`8979498dc071f664`). The parent still has exactly its original Pick'em W9 and Survivor W2/W9 publications with matching hashes. On the parent, the new synthetic Auth user count is **0**, new QA-policy count **0**, and the new W5 and W8 publication counts are **0**. On the child, six exact-user additive policies and one exact synthetic publisher were confirmed. No production database operations were issued.

### Boundaries, evidence, and release decision

- The runnable Playwright scripts and synthetic fixtures already live on PR #34. The new password-sign-in path was applied only in the disposable sandbox test-runner; the generated password and authentication state were kept out of GitHub.
- This QA run validates real browser → Neon Auth → authorized Data API publication → fresh browser reading and scoring, **not** a physical device or the external contest organizer's source-of-truth standings.
- The previous original report remains a historical record of the earlier OTP-blocked run; **this later follow-up supersedes its BLOCKED verdict for isolated QA E2E**.
- The confirmed display-only fix was separately extracted into [draft PR #35](https://github.com/r88510179-collab/r88510179-collab.github.io/pull/35) for production review, avoiding the large QA-only harness/evidence payload in PR #34.
- **No merges, production releases, production data writes, or new production credentials were authorized or performed.** Explicit owner approval remains the release boundary for PR #35.
