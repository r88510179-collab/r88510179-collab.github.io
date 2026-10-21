# Offline Stage B acceptance (browser)

Stage B, the signed-in validation on production, stays unauthorized until its prerequisites hold
(`PRE_REGISTRATION_HARDENING.md:1235-1264`). This document covers what can be shown **before** it, offline: the
participant and commissioner journeys in headless Chromium, stubbed only at the network edge. It complements the
existing opt-in browser suite in `ui-contract.test.mjs`, which it does not repeat.

**What a pass shows and what it does not.** A pass shows that the shipped page code behaves as described against
stand-ins that answer the way the repository's own code says the backend answers: the real bundled SDK and the real
same-origin Auth proxy in front of a stand-in Neon Auth, and a Data API stand-in that refuses with the codes, in the
order and in the shapes of migrations 002 and 003. It does **not** show that hosted Neon Auth, the hosted Data API,
Netlify or a real device behave that way. Viewports are CSS-viewport emulation in Chromium, not physical Android or
iPhone devices, and not Safari/WebKit.

## Running it

    cd pool-platform
    npm ci                                                        # the real SDK bundle needs it
    POOL_PLATFORM_TEST_BROWSER=1 NODE_PATH="$(npm root -g)" node --test stage-b-acceptance.test.mjs
    POOL_PLATFORM_TEST_BROWSER=1 NODE_PATH="$(npm root -g)" npm test   # every suite, both browser suites included

Playwright comes from `NODE_PATH`, as for `ui-contract.test.mjs`; it is not a project dependency. Without
`POOL_PLATFORM_TEST_BROWSER` the browser tests are skipped and only the always-on copy test runs. Without `npm ci` the
real-SDK sign-in tests are skipped. Nothing reaches the network: synthetic `example.test` identities only.

## Coverage map

`FRONTEND_INTEGRATION_RUNBOOK.md` defines the live checks this rehearses. "Existing" is `ui-contract.test.mjs`; "new" is
`stage-b-acceptance.test.mjs`.

| Runbook check | Offline evidence | Left for live Stage B |
| --- | --- | --- |
| P1 send code (`:185`) | new: real SDK + proxy: malformed email refused in the page with no Auth request; a valid one shows the code field with focus; each refused send (rate limit, upstream error, upstream unreachable, a non-JSON edge error) explains itself and creates no session. Existing: real-SDK send through the proxy | delivery of a real code; Neon's real refusal bodies and limits (question I) |
| P2 verify (`:186`) | new: wrong, expired and too-many-attempts codes (pinned better-auth 1.6.23 bodies) keep the sign-in card, set no cookie, call no Data API; Enter submits the code; one sign-in per double tap. Existing: real-SDK full sign-in with stand-in Neon Auth | a real sign-in, cookie attributes in Safari/Firefox |
| P3, P4 bearer, reload (`:187-189`) | existing only (real-SDK cookie test) | live JWT and reload persistence |
| P5 context (`:190`) | new: pool name and entries per account | live fixture values |
| P6 several entries (`:191`) | new: each entry shows only its own picks, notice and actions; unsaved picks never move to another entry; another account's entry is never offered; Submit goes to the entry on screen | |
| P7 both pool types (`:192`) | new: Pick'em and Survivor journeys | the live Survivor fixture (its contents are not in the repo) |
| P8 submit (`:193-194`) | new: "Participant channel claimed", the saved message, "Revision 1", the notice and "Update picks"; every server refusal (source conflict, deadline, week locked, entry inactive or reassigned, schedule changed, submission locked) is shown in words, takes focus, keeps the picks and saves nothing | the live database's answers |
| P9 reload saved (`:195`) | new: saved picks re-checked after the post-submit reload and on reload | |
| P10 commissioner-claimed (`:196`) | new: read-only notice, every input and Submit disabled, a forced submit refused in the page, nothing sent | |
| P11, P12 sign out (`:197-198`) | existing (in-flight sign-outs); new: an expired session's submit says sign-in is needed, shows nothing as saved, and signing in again recovers | live cookie deletion |
| I1-I5, I7-I9 invites (`:202-221`) | existing | live claim |
| I6 reused invite (`:214`) | existing (reused by its own account); new: expired, revoked, used by another, entry already owned, unverified email and malformed token, each explained beside Sign out, nothing consumed, own entries still shown; a malformed token is never sent | live `invite_email_unverified` (needs a real verified/unverified pair) |
| C1-C3 (`:225-227`) | new: commissioner sign-in failure states (real SDK); existing: `commissioner_required` and load failures | |
| C4, C5 (`:228-229`) | new: the entry table's claimed and "This week" columns before and after an import | season/week switching is not covered |
| C6 client validation (`:230`) | existing (ambiguous code, repeated entry); new: unknown entry, unresolved pick (markup kept as text), invalid and missing tiebreak, missing columns, empty CSV, Survivor ambiguous/unknown/missing team; nothing submitted until every row resolves; labels sent as stable keys | |
| C7, C8 import and conflicts (`:231-232`) | new: one world shared by both pages: the participant's row is reported `source_conflict:participant` and is not overwritten, an inactive entry is "other error", the summary counts match, a same-source re-import is `updated` | the live batch |
| STEP2 verify list (`STEP2_RUNBOOK.md:280-290`) | new: 360, 390, 768 and 1280 px: no sideways scroll, controls at least 44 px, form text at least 16 px, results table scrolls in its own box; keyboard-only Pick'em with a visible focus ring; the confirmation and refusals take focus | physical devices, Safari, screen readers |

## Defects found and fixed

Each was reproduced by a test that failed on the unmodified baseline `e06519a` and passes after the fix. Each fix was
also undone on its own (mutation check) and its test failed every time.

| ID | Reproduction (what a person would see) | Fix | Test |
| --- | --- | --- | --- |
| D1 | After saving, changing a pick, the tiebreak or pressing Clear left "Your picks are saved" on screen above unsaved picks | any edit takes the saved card down until the next save (`participant.js`, `edited`) | "after saving, any change to the picks takes the confirmation down…" |
| D2 | With two entries, switching entry while a submit was in flight showed entry 1's "Participant channel claimed · Revision 1" on entry 2, which was not submitted | the entry selector is locked while a submit is in flight and unlocked when it ends; sign-out unlocks it for the next account | "stale responses: …" |
| D3 | With Submit at the bottom of the screen, the confirmation appeared below the fold (0 to 4 px of it visible at 360, 390, 768 and 1280 px) and focus fell to the page: nothing visible changed except the button's label | the confirmation takes focus (`tabindex="-1"`), which brings it into view and to assistive technology, as refusals already did | "the confirmation is on screen and has focus…"; "keyboard only…" |
| S2 | A save that succeeded, followed by a failed reload of the entry, was reported as an error, with no confirmation and "Submit picks" still offered | once the save is answered, a failed reload no longer turns it into an error: the page records the save itself, as the sandbox does | "the page reports what the latest submit did…" |
| S1 | A later refusal left an earlier "saved" card on screen beside the refusal | a new submit takes the previous result down first | same test |
| D6 | A validation message raised on one entry stayed on screen after switching to another | rendering an entry clears it | "stale responses: …" |
| D5 | A participant who claimed an invitation before the commissioner opened a week saw the raw code `week_not_found` (or `season_not_found`), though the claim had succeeded | both codes map to "This pool has no week open for picks yet…" (`auth-core.js`) | "every database refusal a participant can meet is shown as words…"; "pre-season: …" |
| D4 | A double tap on Send code sent two codes; on Verify, two sign-ins (and, with an invitation in memory, two claims) | Send code and Verify are disabled while their request is out, on both pages, and usable again afterwards, success or failure | "sign-in buttons: …" |
| D7 | The commissioner's CSV box used 14 px text, under the 16 px the device checklist requires (`STEP2_RUNBOOK.md:280-290`); iOS Safari zooms such fields on focus (not observed here: no WebKit) | 16 px | "viewport matrix: …" |

Why D4 matters is partly unverified: in the pinned better-auth 1.6.23 each send stores a new code unless a reuse
strategy is configured (`better-auth/dist/plugins/email-otp/routes.mjs`, `resolveOTP`), and sends count against the
Email OTP limit (`NEON_QUESTION_I_PROTOCOL.md`). Whether hosted Neon behaves that way is not known.

No request changed in what it carries or where it goes: invitation-token transport, the SDK calls, the Auth proxy, the
RPC arguments, the migrations and the database are untouched. The sign-in buttons only refuse a second activation while
the first is in flight. `ui-contract.test.mjs`'s source contracts for the invite, sign-in, sign-out and submit paths
still pass unchanged.

## Checked and found sound (no change made)

- No horizontal page scroll in any tested state at 360, 390, 768 and 1280 px (participant sign-in, code entry, Pick'em
  and Survivor saved states; commissioner invite link, import results and row errors).
- Every control a person operates is at least 44 px tall. Only the brand link (20 px) and the tiebreak's text label are
  smaller; the tiebreak input itself is 48 px.
- Sign-in never fails silently, even for a non-JSON error from in front of the proxy: the real SDK turns it into a
  visible message (for example "HTTP 429 Too Many Requests"), though raw.
- Invitations, the source lock in both directions, Survivor used-team protection and import validation behave as the
  runbooks expect.

## Deferred backlog verdict

| Item | Verdict | Reason |
| --- | --- | --- |
| Invite revocation UI (`STEP2_RUNBOOK.md:326`) | worthwhile post-launch | not a reproducible defect: no UI path misleads, and email-bound invitations cannot be claimed by another account. A misdirected unrestricted link has no in-app undo, and revoking needs a database action with no reviewed workflow (`HOSTING_ARCHITECTURE.md:340-343`): for the first customers, prefer email-bound invitations. |
| Partial CSV import (`:327`) | unnecessary for launch | the all-or-nothing behaviour is deliberate and now tested: every rejected row is listed with its reason and nothing is sent until the CSV is corrected. |
| Error-state UX (`:328`) | launch-relevant parts fixed here (D1-D7, S1, S2); the rest post-launch | remaining, none misleading about whether picks were saved: raw codes in the import result table (`source_conflict:participant`), "Authentication required." after a session expires, raw "HTTP 429…" / "Failed to fetch" for errors in front of the proxy, the generic "This entry is not editable." when the deadline passes with the page open, a refused submit leaving the stale notice up until reload, invite-creation errors shown in the Import card, import results kept after switching week, a failed claim plus a failed load showing neither entries nor the empty state, commissioner results not announced to screen readers, no Enter-to-verify on the commissioner page, no in-flight lock on Create invite or Validate & import (a double click creates two invites or a second "updated" revision, both harmless). |
| General UI polish (`:333`) | post-launch or unnecessary | brand link tap size, PWA icons (no install prompt, `FRONTEND_INTEGRATION_RUNBOOK.md:298-299`). |

## Known limitations

- Emulation only: no physical Android or iPhone, no Safari/WebKit, no Firefox, no screen reader. The device matrix of
  `FRONTEND_INTEGRATION_RUNBOOK.md:284-308` and `STEP2_RUNBOOK.md:268-290` stays unverified.
- The Data API stand-in mirrors the migrations' refusal order and shapes; it is not the database. The database's own
  behaviour is covered by `migration-integration.test.mjs` (opt-in, local PostgreSQL), which was not run here.
- Stand-in Neon Auth bodies are the pinned better-auth 1.6.23's; hosted Neon runs another version (question N).
