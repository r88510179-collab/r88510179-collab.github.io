# Step 2 activation runbook

This runbook is intentionally blocked until the Step 2 candidate receives an independent read-only review.

## 1. Environment

Provision a dedicated commercial/dev Neon project or database environment.

Do not use the personal Pool Center production database as the commercial product backend.

Low-cost goal:

- one commercial dev/production project while customer count is small
- one synthetic demo tenant inside that project, or a separate demo branch later
- scale-to-zero/serverless settings where available

## 2. Database

After review, apply in order:

1. migrations/001_foundation.sql
2. migrations/002_identity_submission_rls.sql

Then verify:

- every pool_platform_* table exists
- RLS is enabled on every table
- anonymous has no table privileges
- authenticated has SELECT only on tables
- authenticated has EXECUTE only on the intended RPC functions
- no DELETE grant exists
- source-change trigger exists
- UNIQUE (week_id, entry_id) exists
- pool slug global unique index exists

Do not seed any data from the personal Pool Center.

## 3. Auth + Data API

Provision Neon Auth and enable the Data API for the commercial branch.

Set the production client config in platform-config.js:

- mode: live
- authUrl: commercial Neon Auth URL
- dataUrl: commercial Data API URL
- defaultPoolSlug: the pilot pool slug

These URLs are endpoint configuration, not database passwords.

Keep all privileged database credentials out of browser code.

## 4. Synthetic pilot seed

Create a synthetic tenant and pool first.

Recommended first fixture:

- Tenant: Local Demo Group
- Pool: Neighborhood Pick'em
- Season: 2027
- Week: 1
- 10 synthetic entries
- 4 to 6 synthetic football games
- deadline at least 24 hours in the future

Create one commissioner membership tied to a test Neon Auth account.

## 5. Identity tests

Test on separate accounts:

Commissioner:
- can load only managed tenant/pool
- can generate an invite
- cannot manage another tenant

Participant:
- can claim an invite once
- wrong email cannot claim an email-bound invite
- expired/used invite fails
- can own multiple entries
- cannot read another participant's entry

## 6. Source-lock race tests

Required:

A. Participant submits first.
Commissioner import must report source_conflict:participant.

B. Commissioner import submits first.
Participant direct submission must report source conflict.

C. Two simultaneous first submissions for the same entry/week.
Exactly one source claims the UNIQUE row.

D. Same participant source updates before deadline.
Revision increments.

E. Same commissioner_import source updates before deadline.
Revision increments.

F. Any ordinary submission at or after deadline.
Rejected.

G. Locked submission.
Rejected even from same source.

## 7. Payload tests

Pick'em:

- every configured game required
- only away/home accepted internally
- displayed city/team labels normalize during commissioner import
- unknown game rejected
- extra game rejected
- required tiebreak enforced
- malformed payload rejected server-side

Survivor:

- one configured team required
- displayed city/team label normalizes to stable team key on import
- unknown team rejected
- previously used team rejected server-side
- ambiguous duplicate team in configured schedule rejected for that selection

## 8. Device matrix

Participant pick entry must be manually checked at minimum on:

- 320 CSS px emulator
- 360 CSS px Android
- 384 CSS px Android
- 412 CSS px Android
- Samsung Galaxy S23/S24-class device
- iPhone Safari
- iPad/tablet
- desktop Chrome/Edge
- desktop Safari/Firefox when available

Verify:

- no page-level horizontal overflow
- 44px+ effective tap targets
- 16px+ form inputs
- no hover-only action
- keyboard navigation
- focus visibility
- submit/error/status announcements
- Pick'em and Survivor forms

## 9. Commissioner import

Test a batch containing:

- new commissioner entries
- participant-submitted conflict
- same-source commissioner update
- unknown entry code
- malformed pick
- city-label pick
- Survivor city label

The import must continue for safe rows and return a conflict/error report.

It must never overwrite a participant-owned row.

## 10. Go-live gate

Do not use the live commercial backend with a real customer until:

- independent code review: SHIP
- migration applies cleanly in dedicated dev
- RLS/privilege matrix verified
- race tests pass
- browser/device matrix passes
- synthetic demo works end-to-end

Only then seed the first real customer's tenant/pool.
