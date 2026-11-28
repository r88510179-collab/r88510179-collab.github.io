# Pool Alerts — owner's manual

*Phone notifications for the Personal Pool Center: when the official weekly picks are published (or officially
corrected) in Admin, everyone who turned alerts on gets a notification, even with Pool Center closed. You no longer have
to message the group yourself.*

**Status of this document:** describes the release candidate on branch `ccr-cddcecdc-tuktqe`. Nothing here is live until
you approve and complete [DEPLOY.md](DEPLOY.md). Recovery playbooks: [RUNBOOK.md](RUNBOOK.md). Phone acceptance:
[ACCEPTANCE.md](ACCEPTANCE.md). Engineering audit of the earlier drafts: [AUDIT-2026-11-26.md](AUDIT-2026-11-26.md).

## 1. What participants see

- **Home → Pool Alerts card.** The latest official release (week, revision, Eastern publish/update time), a **New** marker
  until they view it, **View picks**, **Share announcement** (share sheet or copy, for the group chat), the official
  release history with New/Updated markers, and **Phone alerts**: *Turn on alerts* (no account, no e-mail, no code),
  *Also alert me when official picks are corrected*, *Send a test alert*, *Turn off alerts*, the alerts received on this
  device, and step-by-step help for Android, iPhone/iPad and computers.
- **The notification:** "Week 12 official picks are posted — Tap to see every entry's official picks." A correction:
  "Week 12 official picks corrected — Revision 2 … Tap to review." Tapping opens that week's Picks. Nothing private
  (names, picks, standings) is ever on the lock screen.
- **iPhone/iPad:** alerts work only from the Home Screen app (iOS/iPadOS 16.4+): Safari → Share → Add to Home Screen →
  open from the icon → Turn on alerts. The card explains this when opened in a Safari tab.

## 2. How it works (one paragraph per piece)

1. **Capture (database, migration 006).** When Admin publishes or corrects a week, a trigger on `nfl_pool_weeks` writes
   a *publication event* into the private `pool_alerts` schema **in the same transaction**. A failed, refused or
   rolled-back publication leaves no event; drafts, score refreshes and identical republishes are not announced. The
   trigger can never block publishing: if it fails it only logs a warning.
2. **Dispatch (Admin page).** Right after Admin shows its read-back-verified success message, the page asks the sender
   to deliver now, signed with your own sign-in token. The Admin "Pool Alerts" panel shows the result.
3. **Sender (Neon Function `poolalerts`).** Plans each event (first release vs. correction per device, coalescing rapid
   revisions, cancelling withdrawn weeks), **verifies the exact revision through the public Data API** (what visitors
   see), then sends encrypted Web Push messages through Google/Apple/Mozilla/Microsoft push services, with retries.
4. **Safety net (hourly Function Trigger).** Retries what is waiting, finds any publication the trigger missed
   (reported as a *capture gap*), tidies old records. It is the only scheduled work, and it is hourly so the free
   database compute stays within its allowance (see Costs).
5. **Device (service worker).** Always shows a notification for a push, keeps a small alert log and unread badge on the
   device, and opens the right week when tapped.

```
Admin publish ──► nfl_pool_weeks ──trigger──► pool_alerts.publication_events
      │ (verified)                                  │
      └──"notify now"──► Neon Function poolalerts ◄─┘ (+ hourly trigger)
                              │  verify exact revision via public Data API
                              └──► push services ──► phones / computers
```

## 3. Where everything is

| Piece | Location |
| --- | --- |
| Database change and rollback | `nfl-pool/migrations/006-pool-alerts.sql`, `006-pool-alerts-rollback.sql` |
| Sender source | `nfl-pool/push/*.mjs` (`index.mjs` is the function entry; `npm run bundle` builds `dist/poolalerts.zip`) |
| Owner tool | `node nfl-pool/push/ops.mjs …` (no database access) |
| Owner workflow | GitHub → Actions → **Pool Alerts maintenance** |
| Home card | `nfl-pool/pool-alerts.mjs`, `nfl-pool/push-client.mjs`, `nfl-pool/pool-alerts.css` |
| Notifications on the device | `nfl-pool/service-worker.js` (`BEGIN/END POOL ALERTS PUSH`) |
| Admin panel and auto-dispatch | `nfl-pool/admin/pool-alerts-admin.js` |
| Maintenance Center tile | `smokke-dashboard`: `api/pool-alerts-status.js` |
| Tests | `push/core.test.mjs`, `push/integration.spec.mjs` (+ `test-integration.sh`), `sql-tests/pool-alerts.sql`, `sql-tests/backup-compat.sh`, `pool-alerts.test.mjs`, `service-worker.test.mjs`, `acceptance/pool-alerts-browser.mjs` |

## 4. Everyday operations (no AI needed)

| I want to… | Do this |
| --- | --- |
| Check it is up | Maintenance Center tile, or Actions → Pool Alerts maintenance → `health` / `status` |
| See pending / failed alerts | `status` (lists recent alerts with sent/waiting/failed and recent problems) or the Admin panel |
| Send a test to my phone | Turn alerts on on your phone; Admin → Pool Alerts → **Test alert to this device** (on that phone), or `test-device` with the device id |
| Re-send what failed | Admin **Retry failed deliveries** or workflow `retry-failed` (only alerts still current and under 24 h old) |
| Stop all alerts now | Admin **Pause sending** or workflow `pause` (publishing continues; nothing is sent until **Resume**) |
| Restart sending | Admin **Resume sending** or workflow `resume` (anything older than 24 h is skipped, never sent late) |
| Notify now (if Admin could not) | Admin **Notify subscribers now** or workflow `notify` |
| Require a code to join | Store a 12+ character code as the repo secret `POOL_ALERTS_INVITE_CODE`, run `enrollment-invite`; share `https://r88510179-collab.github.io/nfl-pool/?view=home#alerts-invite=YOUR-CODE` |
| Stop new sign-ups | `enrollment-closed` (existing devices keep receiving) |

`status` vocabulary: **sent** delivered to the push service · **retry** temporary failure, will retry (30 s → 1 h, 5
tries) · **failed** gave up (see the problem code) · **expired** the device unsubscribed (removed automatically) ·
**superseded** a newer revision replaced it before sending · **withdrawn** the week was unpublished before sending ·
**stale** older than 24 h · **unchanged** identical republish, nothing new to say.

Problem codes: `gone-410/404` device unsubscribed (normal) · `auth-401/403` the push service refused the sender key (see
RUNBOOK §4) · `rate-limited` push service asked to slow down · `server-5xx`/`network` temporary, retried ·
`public-read-*` the public Data API could not confirm the revision (nothing is sent until it can).

## 5. Enrollment: no account, no code (by default)

Viewing Pool Center needs no sign-in, and an alert says only "Week N official picks are posted", so requiring an
invitation code added friction without protecting anything private. Abuse controls instead: only real push-service
addresses are accepted (no arbitrary URLs), at most 500 active devices and 60 new sign-ups per hour (database-enforced),
requests only from the two Pool Center sites, small request limits, automatic removal of devices that unsubscribe, and
the owner switches (invite mode, closed, pause). Each device gets a private management token kept only in that browser.

## 6. Security and privacy

- The sender connects as `pool_alerts_sender`: no access to any public table, Neon Auth or anything outside
  `pool_alerts`; it cannot forge publication events, change its own limits or set the environment. It refuses to start
  with any other database role, and a production sender refuses anything but the production endpoints (a staging
  sender refuses production endpoints), and the database itself is marked `production`/`staging`.
- VAPID private key, database password and token digests live only in the Neon Function environment. The owner token
  and status token are kept by you (GitHub secret / Vercel server variable / password manager). Never paste them in Git
  or chat.
- Stored per device: push address and keys, a SHA-256 of its token, the Pool Center site it used, the corrections
  choice and timestamps. No names, e-mail, IP addresses or picks. Turning alerts off deletes the device's record.
- Push payloads are end-to-end encrypted (RFC 8291) and carry only `{kind, season, week, revision}`.

## 7. Costs

No new paid service. Everything runs on what you already use, on the current free plans:

| Item | Usage | Cost |
| --- | --- | --- |
| Neon Function `poolalerts` (NFL Pool Functions project) | ~730 hourly runs + a few dispatches a month, seconds each; Free plan includes 1 M invocations, 10 active / 400 waiting capacity-hours per project | $0 |
| Production database compute | Each hourly check can wake the database for about 5 minutes: at most ≈15 CU-hours a month of the Free plan's 100 (this month's use so far: ≈12.5) | $0 |
| Push services (Google, Apple, Mozilla, Microsoft) | Free for Web Push | $0 |
| GitHub Actions, GitHub Pages, Vercel | Unchanged plans | $0 |

Do **not** make the trigger more frequent than hourly on the Free plan: a check every few minutes keeps the database
awake around the clock (≈180 CU-hours) and Neon would suspend the production database when the 100 CU-hour allowance
runs out. The earlier draft (polling every 30 s) had exactly that problem.

## 8. Development

```sh
cd nfl-pool/push && npm ci          # pg + web-push (runtime), esbuild (bundle), all lockfile-pinned
node core.test.mjs                  # policy, guards, auth, owner tool
bash test-integration.sh            # 30 end-to-end scenarios on disposable PostgreSQL 17.11 (Docker)
npm run bundle                      # dist/index.mjs + dist/poolalerts.zip, prints SHA-256 (reproducible)
bash ../sql-tests/run.sh            # SQL gate incl. Pool Alerts capture, backup compatibility and rollback
node ../acceptance/pool-alerts-browser.mjs --screenshots /tmp/shots   # Chromium acceptance (push subscription simulated)
```
