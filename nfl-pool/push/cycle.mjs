// One sender cycle. Started by the Admin page right after a verified publication ("dispatch"), by the hourly Neon
// Function Trigger ("cron"), or by the owner. Every step is idempotent and safe to run concurrently with another cycle.
//
//  1. ingest      plan new publication events (first run: record the baseline, announce nothing)
//  2. reconcile   a locked revision the public Data API shows but no event recorded is a capture gap: record + report
//  3. verify      each open notification's exact revision must be publicly readable; superseded/withdrawn ones close
//  4. deliver     only when sending is enabled in BOTH the deployment and the database switch; leased, bounded,
//                 retried within the cycle while the next retry is due soon and time remains
//  5. tidy        stale notifications close; (cron) old diagnostics and long-dead devices are removed
import * as store from './store.mjs';
import {notificationPayload, pushOptions, weekKey} from './core.mjs';

const CONCURRENCY = 6;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

const errorClassOf = error => (error && typeof error.errorClass === 'string' ? error.errorClass : error?.code ? `db-${error.code}` : 'internal');

export async function runCycle({pool, cfg, reader, send, trigger, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)),
  budgetMs = 120000, reconcile = true, tidy = trigger === 'cron'}) {
  const startedAt = now();
  const summary = {trigger, ingest: [], reconcile: null, verified: 0, closed: {}, attempts: 0, outcomes: {}, paused: false, errors: []};
  const runId = await store.startRun(pool, trigger);
  let outcome = 'ok', errorClass = null;
  try {
    // 1. Ingest everything captured so far (bounded batches).
    for (let i = 0; i < 20; i++) {
      const batch = await store.ingest(pool, {nowMs: now()});
      summary.ingest.push(batch);
      if (!batch.more) break;
    }
    const baseline = summary.ingest.some(b => b.baseline);

    // 2. Reconcile against the public index (never on the baseline run: history is not announced).
    if (reconcile && !baseline) {
      try {
        const cursor = await store.readCursor(pool);
        const settings = await store.readSettings(pool);
        const index = await reader.readIndex();
        const captured = await store.capturedRevisions(pool);
        const floor = Math.max(cursor.initialized_at.getTime(), now() - settings.max_notification_age_minutes * 60000);
        let added = 0;
        for (const row of index) {
          if (!row.publishedAt || Date.parse(row.publishedAt) < floor) continue;
          if ((captured.get(weekKey(row.season, row.week)) ?? 0) >= row.revision) continue;
          if (await store.recordReconcileEvent(pool, row)) added++;
        }
        summary.reconcile = {checked: index.length, added};
        if (added) summary.ingest.push(await store.ingest(pool, {nowMs: now()}));
      } catch (error) {
        summary.errors.push(`reconcile:${errorClassOf(error)}`);
      }
    }

    const settings = await store.readSettings(pool);
    const sendingOn = cfg.sendingAllowed && settings.sending_enabled === true;
    summary.paused = !sendingOn;

    // 3 + 4. Verify, then deliver; repeat while a retry is due soon.
    for (let pass = 0; pass < 12; pass++) {
      const open = await store.openNotifications(pool);
      const publicRows = new Map(), verifiedIds = [];
      for (const notification of open) {
        const key = weekKey(notification.season, notification.week);
        try {
          if (!publicRows.has(key)) publicRows.set(key, await reader.readWeek(notification.season, notification.week));
          const result = await store.applyVerification(pool, notification, publicRows.get(key));
          if (result.status === 'verified') verifiedIds.push(notification.id);
          else summary.closed[result.status] = (summary.closed[result.status] || 0) + 1;
        } catch (error) {
          summary.errors.push(`verify:${errorClassOf(error)}`);
        }
      }
      summary.verified = Math.max(summary.verified, verifiedIds.length);
      if (!sendingOn || !verifiedIds.length) break;

      let leasedThisPass = 0;
      for (;;) {
        const {token, rows} = await store.leaseDeliveries(pool, {notificationIds: verifiedIds});
        if (!rows.length) break;
        leasedThisPass += rows.length;
        await mapLimit(rows, CONCURRENCY, async row => {
          const payload = notificationPayload({kind: row.kind, season: row.season, week: row.week, revision: row.revision});
          let result;
          try {
            result = await send({endpoint: row.endpoint, keys: {p256dh: row.p256dh, auth: row.auth}}, payload,
              pushOptions({kind: row.kind, season: row.season, week: row.week}, settings.max_notification_age_minutes));
          } catch {
            result = {status: 0};
          }
          summary.attempts++;
          try {
            const done = await store.completeDelivery(pool, {row, token, status: result.status, retryAfterSeconds: result.retryAfterSeconds ?? null});
            summary.outcomes[done.state] = (summary.outcomes[done.state] || 0) + 1;
          } catch (error) {
            // The push may have gone out; the lease expires and the delivery is retried (the device's tag absorbs a repeat).
            summary.errors.push(`complete:${errorClassOf(error)}`);
          }
        });
        if (now() - startedAt > budgetMs) break;
      }
      await store.finishNotifications(pool);
      const nextAt = await store.nextRetryAt(pool, verifiedIds);
      const remaining = budgetMs - (now() - startedAt);
      if (!nextAt || remaining <= 0) break;
      const wait = Math.max(0, nextAt - now());
      if (wait > Math.min(150000, remaining)) break;
      if (wait > 0) await sleep(wait + 250);
      if (!leasedThisPass && wait === 0) break;
    }

    // 5. Tidy.
    summary.expired = await store.expireStale(pool, settings);
    if (tidy) summary.housekeeping = await store.housekeeping(pool);
    outcome = summary.errors.length ? 'partial' : summary.paused ? 'paused' : 'ok';
  } catch (error) {
    outcome = 'error';
    errorClass = errorClassOf(error);
    summary.errors.push(`cycle:${errorClass}`);
  } finally {
    summary.durationMs = now() - startedAt;
    await store.finishRun(pool, runId, {outcome, errorClass, summary}).catch(() => {});
  }
  return {runId, outcome, errorClass, summary};
}
