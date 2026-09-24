# Pool Platform — Commercial V1

This directory is the commercial product foundation. It is intentionally isolated from the existing personal Pool Center implementation.

## Product boundary

The commercial product may reuse generic sports-domain concepts only:

- weekly pick submission
- football schedule/result abstractions
- scoring/tiebreak concepts
- Survivor-style elimination concepts
- live standings/analytics patterns

It must not copy customer-specific or personal-project data, names, standings, branding, historical entries, private configuration, or source files.

All fixtures in this directory are synthetic.

## V1 target

A low-cost, local-first managed SaaS for fewer than 10 initial customers.

Supported launch formats:

- Weekly Pick'em
- Survivor

Initial operating model:

- owner-operated provisioning
- commissioner-managed pools
- responsive web/PWA participant entry
- commissioner import/manual entry as an alternate submission channel
- strict one-channel-per-entry-per-week source lock
- tenant/pool isolation
- synthetic demo environment
- seasonal/manual billing outside the app initially

## Submission-source rule

For each pool entry and week, the first final submission claims exactly one source:

- `participant`
- `commissioner_import`
- `commissioner_manual`

Once claimed, another source cannot overwrite that entry/week. Same-source edits may be allowed only while the week is open. Batch imports must report conflicts instead of replacing participant submissions.

This rule is enforced in the database, not only in the browser.

## Current status

Commercial V1 Step 2 candidate is implemented on a feature branch.

Implemented:

- participant OTP/invite flow
- multi-entry participant support
- Pick'em direct entry
- Survivor direct entry with burned-team protection
- commissioner invite generation
- commissioner CSV import
- atomic participant-vs-commissioner source locking
- tenant/pool/entry authorization model
- RLS read policies
- no direct authenticated table writes
- hashed invitation tokens
- submission audit trail design
- responsive PWA participant and commissioner surfaces

The migrations remain REVIEW-ONLY and have not been applied to any database.

The repository configuration remains `mode:'sandbox'`. No live commercial backend is connected yet.
