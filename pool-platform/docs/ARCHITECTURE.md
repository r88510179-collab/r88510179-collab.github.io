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

- static hosting for the web client on its own commercial origin (planned: a Vercel project limited to `pool-platform/` that publishes only the allow-listed `dist/`; see `HOSTING_ARCHITECTURE.md`, nothing configured yet)
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


## Step 2 security decisions

- No anonymous database access is required for pick submission.
- Authenticated browser clients receive SELECT-only table grants subject to RLS.
- All mutation flows use narrow SECURITY DEFINER RPC functions.
- Submission source is immutable after the first successful claim.
- The database unique key on (week_id, entry_id) closes participant/import races atomically.
- Browser validation is duplicated by Postgres payload validation.
- Survivor team reuse is blocked atomically by a partial unique index on (entry_id, payload->>'team'), so out-of-order and concurrent submissions cannot reuse a team; submissions for one entry also serialize on the entry row.
- Submission RPCs authorize the caller before checking entry state, week state, payload or pick history, and only active entries accept ordinary submissions.
- Invitation tokens are 256-bit random values; only SHA-256 hashes are stored.
- Optional invitation email binding prevents another signed-in email from claiming the link, and the bound email must be verified in Neon Auth.
- The commercial service worker only manages caches under its own pool-platform-commercial- prefix and only stores an allow-list of same-origin static files; auth, Data API, cross-origin and query-string URLs are never cached.
- The worker is registered from `sw-register.js` with scope `./` and never stores or answers `platform-config.js`, so no cached configuration can pin a page to an old backend; a page that cannot load its configuration says so and never falls back to the sandbox.
- The browser loads the pinned `@neondatabase/neon-js` 0.7.0-beta from its own origin (`vendor/neon-js.js`, bundled from `package-lock.json`); no code is loaded from a CDN.
- The pages carry no inline script or style, so they run under `script-src 'self'` and `style-src 'self'`.
- The runtime configuration is generated at build time from `POOL_PLATFORM_*` variables (public endpoint URLs only, validated, fail closed); the tracked `platform-config.js` is the sandbox.
- Commercial pool slugs are globally unique in V1 to keep links simple.
- Participant invite pages use a no-referrer policy.
- Dynamic commissioner-controlled text is escaped before HTML rendering.

## Dedicated commercial environment

Do not connect this project to the personal Pool Center tables or copy personal Pool Center participant data into it.

Use a dedicated commercial/dev Neon environment for migration testing and pilots.
