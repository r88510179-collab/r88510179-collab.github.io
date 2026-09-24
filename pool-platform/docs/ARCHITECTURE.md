# Commercial V1 architecture

## Guiding principles

1. Keep costs near zero until paid demand is proven.
2. Use one multi-tenant application, not one deployment per customer.
3. Keep the personal Pool Center and commercial product data completely separate.
4. Make every critical rule enforceable server-side/database-side.
5. Support phones, tablets, laptops, and desktops from one responsive PWA.
6. Do not require app-store distribution.
7. Fail closed when submission ownership, schedule context, or authorization is ambiguous.

## Core hierarchy

Tenant
→ Pool
→ Season
→ Week
→ Entry
→ Submission

A tenant is the customer/group. A tenant can own multiple pools.

A pool is a configured competition such as Pick'em or Survivor.

A season contains the rules/configuration for a year.

A week owns the deadline and publication state.

An entry is one participant slot. One person may own multiple entries.

A submission contains the finalized picks for one entry/week.

## Participant entry versus commissioner entry

The system supports two ways to collect picks without allowing double-entry or overwrites.

### Participant path

1. Participant opens an authenticated or signed invite link.
2. They select picks locally.
3. Nothing is claimed while they are merely editing.
4. On final Submit, the backend atomically creates the entry/week submission with source `participant`.
5. The unique entry/week constraint wins any race.
6. After submission, commissioner batch import cannot overwrite it.
7. Same-source participant edits may be allowed until the configured deadline.

### Commissioner path

1. Commissioner uploads/imports a sheet or enters a participant manually.
2. Each finalized entry attempts to claim its entry/week row as `commissioner_import` or `commissioner_manual`.
3. Rows already claimed by participant submission are returned as conflicts.
4. The import continues for non-conflicting entries.
5. The commissioner receives a conflict report.

### Why the source lock is per entry/week

A pool may have a mixture of direct-entry participants and participants who continue sending picks to the commissioner. Locking the entire pool to one intake method would reduce flexibility.

The loophole is closed at the exact place it matters: one entry cannot have two competing finalized sources for the same week.

## Corrections

V1 does not permit source transfer through ordinary participant or commissioner UI.

A future audited correction workflow may:

- record the previous source/payload
- require commissioner reason
- create an immutable audit event
- increment revision
- visibly mark the corrected submission

Do not implement silent cross-source overwrite.

## Low-cost stack

Initial recommended stack:

- GitHub Pages or equivalent static hosting for the web client
- Neon/Postgres for data
- Neon/Auth or equivalent passwordless authentication
- serverless/API layer only for operations that cannot safely be direct database calls
- PWA for installable cross-device behavior
- seasonal manual invoices/payment links rather than subscription infrastructure

## Device support target

Baseline:

- 320 CSS px minimum width
- modern Android Chrome
- iPhone Safari
- iPad/tablet browsers
- desktop Chrome/Edge/Safari/Firefox

Interaction requirements:

- 44px+ primary tap targets
- 16px+ form input text on mobile
- no hover-only controls
- no page-level horizontal overflow for participant pick entry
- semantic labels/radio groups
- keyboard operable
- visible focus
- status not conveyed by color alone

## Demo levels

1. Clickthrough: static/synthetic, no backend.
2. Sandbox: dedicated demo tenant and synthetic data, reset on a schedule.
3. Private pilot: isolated tenant configured to prospect rules using sanitized/test data first.

No demo credential may access production customer data.
