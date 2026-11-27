# Pool Alerts — physical-device acceptance checklist

Automated tests cover the sender (30 end-to-end scenarios with real VAPID signing and payload encryption), the database
(capture, privileges, backup compatibility, rollback) and the app in Chromium (8 scenarios at 375/390/430 px, real
service-worker pushes). **They do not prove delivery through Google/Apple push services to a real phone.** Only these
manual checks do. Record date, device, OS and browser versions, and the result of each line.

Prerequisites: DEPLOY.md steps 1–8 done; sending OFF until step C.

## A. Android phone (Chrome)

1. Open `https://r88510179-collab.github.io/nfl-pool/` in Chrome. Home → Pool Alerts shows *Turn on alerts* and
   "No account needed". ☐
2. Tap **Turn on alerts** → Chrome asks → **Allow**. Card says *Alerts are on for this device.* ☐
3. Tap **Send a test alert** → a local "Pool Alerts test" notification appears. ☐
4. Optional: ⋮ → **Install app**; open Pool Center from the icon; card still shows alerts on. ☐
5. Uncheck **Also alert me when official picks are corrected** → "Correction alerts are off…"; check it again. ☐

## B. iPhone or iPad (iOS/iPadOS 16.4 or later)

1. In Safari open the same address. The card explains alerts need the Home Screen app. ☐
2. Share → **Add to Home Screen** → Add. Open Pool Center **from the new icon**. ☐
3. **Turn on alerts** → iOS asks → **Allow**. Card says alerts are on. ☐
4. **Send a test alert** → a notification appears (lock the phone to see it on the lock screen too). ☐

## C. Real delivery (sending ON)

1. `node nfl-pool/push/ops.mjs resume` (or Admin → Resume sending). ☐
2. On each phone, open Admin (signed in) → Pool Alerts → **Test alert to this device** → "Pool Alerts test" arrives
   with Pool Center **closed** (swipe it away first). ☐ Android ☐ iPhone
3. Next real publication (or a deliberate, approved republication): within a minute every phone shows
   **"Week N official picks are posted"**; the lock screen shows nothing else. ☐ Android ☐ iPhone
4. Tap it → Pool Center opens on that week's Picks; Home no longer shows *New*. ☐ Android ☐ iPhone
5. Official correction published in Organizer Corrections → phones with corrections on get **"Week N official picks
   corrected"**, a phone with corrections off gets nothing. ☐
6. Admin Pool Alerts panel after each: "Subscribers notified: N delivered". `status` shows the alert `done`. ☐
7. **Turn off alerts** on one phone → next alert does not reach it; `status` shows one device fewer. ☐
8. Desktop: Chrome or Edge (Windows/macOS) or Safari (macOS 13+): steps A1–A3 and C3. ☐

## E. Phone acceptance from the Maintenance Center (group sending can stay paused)

This is what `release.mjs activate` requires. Everything but the phone is automated.

1. On the phone open the Pool Center (staging: the preview in DEPLOY.md; production: picks.smokkeventures.com/nfl-pool/),
   turn on Pool Alerts (iPhone: from the Home Screen app), and tap **Ask for a device check**. The card shows a code
   such as `7BBP-SBWX`.
2. Close the app or lock the phone.
3. On any device open dashboard.smokkeventures.com → Pool Alerts tile → **Pool Alerts operations**, choose Personal and
   the environment. Your phone is listed by its code: press **Test** (then **Release**, **Repeat**, **Correction**).
4. The check shows **Accepted** (the push service took it), **Received** (the phone itself reported it) and, when you tap
   the notification, **Opened** (the app opens on the right page and clears the *New* marker).
5. Press **It arrived** or **It did not arrive**. Only your answer counts as physical delivery; the page then shows
   "Android: passed · iPhone: passed" once each platform has a passed, opened check.

The same is available without the dashboard: Actions → Pool Alerts maintenance → `devices`, `check-*`, `checks`,
`confirm-pass`/`confirm-fail`.

## D. Sign-off

- [ ] All lines above pass on at least one Android phone and one iPhone.
- [ ] Maintenance Center tile shows *Healthy*.
- [ ] Owner workflow `status` runs from GitHub on a phone.
- Signed off by: ________  Date: ________  Devices/versions: ________________________________
