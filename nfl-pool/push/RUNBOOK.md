# Pool Alerts — recovery playbooks

Each playbook: what you notice → what to check → what to do. None of them requires changing code. Publishing in Admin is
never blocked by Pool Alerts; if in doubt, **pause sending** first (Admin → Pool Alerts → Pause sending, or Actions →
Pool Alerts maintenance → `pause`), then investigate.

## 1. "I published but nobody got an alert"

1. Admin page after publishing: the Pool Alerts panel says what happened (delivered / paused / could not reach).
2. Run `status`. Find the week under *Recent alerts*:
   - **not listed**: the trigger did not record it. The hourly check will (it appears as a *capture gap*). To send now:
     `notify`. Then see §5.
   - `queued` with `public-read-*` problems: the public Data API could not confirm the revision. Check Pool Center
     itself loads that week; the next cycle retries.
   - `stale`: it was planned more than 24 h after publishing (sender down, or sending paused). Stale alerts are never
     sent late, by design.
   - `unchanged`: you republished identical content; nothing new to announce.
   - `done` with sent > 0: delivered to the push services; see §3 for a device that did not show it.
3. **Sending: database OFF** → `resume`. **deployment OFF** → the function was deployed without
   `POOL_ALERTS_SENDING=enabled` (config-only redeploy, DEPLOY.md §5).

## 2. The sender is down

- `health` fails / Maintenance tile *Not verified*: Neon Console → NFL Pool Functions → Functions → `poolalerts` → Logs.
  `configuration refused: …` names the missing/invalid setting. `environment-guard` means the database marker or role
  does not match (DEPLOY.md §2–3). Redeploy the last good bundle if the code is the problem.
- While it is down, publications are still recorded; the first cycle after recovery sends anything under 24 h old.

## 3. One person does not get alerts

On their device, Pool Center → Home → Pool Alerts:
- *Notifications are blocked…* → follow the on-screen unblock steps (system settings).
- iPhone: must be the **Home Screen app**, iOS 16.4+, and Focus/Do Not Disturb off for Pool Center.
- Android: Chrome notifications allowed for the site; battery saver can delay alerts.
- Tap **Send a test alert** (shows a local notification): if that fails, it is a device setting.
- Ask them to turn alerts off and on again: this re-enrolls the device and is always safe. (The Admin **Test alert to
  this device** button tests the phone you are holding, so use it for your own devices.)
- `status` problem `gone-410` for a device means the browser dropped the subscription: the device record is removed and
  turning alerts on again fixes it.

## 4. Everyone stopped getting alerts; status shows `auth-401/403`

The push services refuse the sender's VAPID key. Usually the function's `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` were
changed or mistyped. Restore the original pair (password manager) with a config-only redeploy. Only if the private key
leaked: generate a new pair. Each device then needs one tap: on its next open, Pool Center notices the key change,
removes the old subscription and shows *Turn on alerts* again.

## 5. Capture gaps (status: CAPTURE GAP)

The hourly check found a public revision the trigger did not record. The alert was still sent (reconciled). Check the
trigger is present and enabled (SQL Editor, role nfl_pool_owner):

```sql
SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.nfl_pool_weeks'::regclass AND NOT tgisinternal;
-- expect nfl_pool_alerts_capture | O   ;   if 'D':  ALTER TABLE public.nfl_pool_weeks ENABLE TRIGGER nfl_pool_alerts_capture;
```

A restore of the public schema from the Personal backup keeps the trigger; restoring into a new database without
`pool_alerts` makes the trigger log warnings until migration 006 is applied there.

## 6. Turn Pool Alerts off

| Level | How | Effect |
| --- | --- | --- |
| Pause | Admin **Pause sending** / workflow `pause` | Nothing is sent; events keep being recorded; **Resume** restarts (older than 24 h skipped) |
| Stop the schedule | Neon Console → Functions → `poolalerts` → Manage Triggers → disable `pool-alerts-hourly` | No hourly cycles; Admin "notify now" still works |
| Stop the sender | Config-only redeploy with `POOL_ALERTS_SENDING` removed, or delete the function | The service answers but never sends / is gone; the app shows "not available" |
| Stop recording | `ALTER TABLE public.nfl_pool_weeks DISABLE TRIGGER nfl_pool_alerts_capture;` | Publications no longer recorded (publishing unaffected) |
| Remove completely | `006-pool-alerts-rollback.sql` as nfl_pool_owner after a backup branch | Schema, trigger, function and role removed; devices re-enroll if it is reinstated |

## 7. Backups and recovery of alert data

What matters: the device list (`pool_alerts.subscriptions`). Everything else is operational history.

- **Before any risky change:** create a Neon backup branch (Console → Branches → Create branch, no compute). That covers
  `pool_alerts` and everything else; restore by resetting from or copying out of that branch.
- **Off-Neon copy (optional):** on a trusted computer with the owner connection string and `age`:
  ```sh
  pg_dump "$OWNER_DSN" --schema=pool_alerts --format=custom --file=pool-alerts.dump
  age -r <your age recipient> -o pool-alerts.dump.age pool-alerts.dump && rm pool-alerts.dump
  ```
  Restore into a database where migration 006 is applied: `pg_restore --data-only --schema=pool_alerts …`.
- **Lost the device list anyway?** Devices heal themselves: each enrolled device checks in at most daily when Pool
  Center opens; a device the service no longer knows re-enrolls silently (same push address, new token). People who do
  not open Pool Center for a while are re-added the next time they do.
- The existing Personal backup (smokke-dashboard, public schema only) is unchanged and does **not** include
  `pool_alerts`; `nfl-pool/sql-tests/backup-compat.sh` proves its dump and documented restore still work with the
  trigger.

## 8. Roll back a release

- **App:** revert the merge commit on `main` (Pages redeploys); installed apps pick up the previous service worker on
  their next update. The sender can stay (it does nothing without new enrollments) or be paused.
- **Sender:** redeploy the previous bundle (Neon keeps deployments) or pause/disable as in §6.
- **Database:** §6 "Remove completely", or reset to the backup branch from DEPLOY.md §1 (loses publications made since —
  avoid unless necessary).
