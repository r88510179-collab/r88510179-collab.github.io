// Pool Alerts durable store: every state change of the outbox happens here, in short transactions, as the
// least-privileged pool_alerts_sender role. Concurrency rules:
//  * Planning (ingest) is serialized by a transaction-scoped advisory lock and is idempotent (cursor + unique event_id).
//  * Deliveries are claimed with FOR UPDATE SKIP LOCKED and a per-batch lease token; a crashed sender's lease expires
//    and the delivery is retried (the device's notification tag makes a repeat display replace, not duplicate).
//  * A completion only lands if its lease is still held, so a slow worker can never overwrite a newer outcome.
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {MAX_ATTEMPTS, deliveryOutcome, deviceCodeFromDigest, planEvent, verificationOutcome, weekKey} from './core.mjs';
import {digestMatches, sha256Hex} from './auth.mjs';

const OPEN = ['queued', 'verified'];
const LOCK_INGEST = "SELECT pg_advisory_xact_lock(hashtext('pool_alerts.ingest'))";
const LOCK_ENROLL = "SELECT pg_advisory_xact_lock(hashtext('pool_alerts.enroll'))";

export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function audit(db, actor, action, detail = {}) {
  await db.query('INSERT INTO pool_alerts.audit_log (actor, action, detail) VALUES ($1, $2, $3)', [actor, action, JSON.stringify(detail)]);
}

export async function readSettings(db) {
  const row = (await db.query(`SELECT sending_enabled, enrollment_mode, invite_code_sha256, max_active_subscriptions,
    max_new_subscriptions_per_hour, max_notification_age_minutes, updated_at, updated_by, note FROM pool_alerts.settings`)).rows[0];
  if (!row) throw Object.assign(new Error('Pool Alerts settings are missing'), {errorClass: 'settings-missing'});
  return row;
}

// The database must be the one this sender was configured for, reached as the least-privileged sender role.
export async function checkIdentity(pool, cfg) {
  const row = (await pool.query(`SELECT current_user AS role, current_database() AS database,
      (SELECT name FROM pool_alerts.environment) AS environment,
      (SELECT rolsuper OR rolbypassrls OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS privileged,
      (SELECT count(*)::int FROM pool_alerts.settings) AS settings,
      to_regclass('pool_alerts.device_checks') IS NOT NULL AS device_checks`)).rows[0];
  const problems = [];
  if (row.role !== 'pool_alerts_sender') problems.push(`connected as ${row.role}, not pool_alerts_sender`);
  if (row.privileged) problems.push('the sender role has superuser, create-role or RLS-bypass rights');
  if (row.database !== cfg.database) problems.push(`database is ${row.database}, expected ${cfg.database}`);
  if (row.environment !== cfg.environment) problems.push(`database environment marker is ${row.environment ?? 'not set'}, sender is ${cfg.environment}`);
  if (row.settings !== 1) problems.push('settings row missing');
  if (!row.device_checks) problems.push('migration 007 (device checks) is not applied');
  if (problems.length) throw Object.assign(new Error(`Environment guard refused: ${problems.join('; ')}`), {errorClass: 'environment-guard'});
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Planning: turn new publication events into notifications and per-device deliveries.
// ---------------------------------------------------------------------------------------------------------------
async function closeOpen(c, {season, week, maxRevision = null, status, reason, deliveryState, deliveryError}) {
  const closed = await c.query(`UPDATE pool_alerts.notifications SET status = $3, status_reason = $4, finished_at = clock_timestamp()
      WHERE season = $1 AND week = $2 AND status = ANY($5) AND ($6::integer IS NULL OR revision <= $6) RETURNING id`,
    [season, week, status, reason, OPEN, maxRevision]);
  if (closed.rowCount) {
    await c.query(`UPDATE pool_alerts.deliveries SET state = $2, last_error = $3, lease_token = NULL, lease_until = NULL,
        updated_at = clock_timestamp() WHERE notification_id = ANY($1) AND state IN ('pending', 'retry')`,
      [closed.rows.map(r => r.id), deliveryState, deliveryError]);
  }
  return closed.rowCount;
}

async function planPublish(c, event, settings, nowMs, counts) {
  const plan = planEvent({action: 'publish', contentChanged: event.content_changed, occurredAt: event.occurred_at.toISOString()},
    {nowMs, maxAgeMinutes: settings.max_notification_age_minutes});
  // An identical republish has nothing new to say, but it still supersedes the week's announcement that may be on its
  // way (verification needs the exact public revision). Those undelivered deliveries move to the new revision with the
  // same kind, so a publish -> correct -> identical republish sequence before a cycle never loses the alert.
  const carried = plan.status === 'unchanged' ? (await c.query(`SELECT d.subscription_id, d.kind FROM pool_alerts.deliveries d
      JOIN pool_alerts.notifications n ON n.id = d.notification_id
      WHERE n.season = $1 AND n.week = $2 AND n.status = ANY($3) AND d.state IN ('pending', 'retry', 'sending')`,
    [event.season, event.week, OPEN])).rows : [];
  counts.superseded += await closeOpen(c, {season: event.season, week: event.week, status: 'superseded',
    reason: `revision ${event.revision} was published`, deliveryState: 'superseded', deliveryError: 'superseded'});
  const status = plan.status === 'unchanged' && carried.length ? 'queued' : plan.status;
  const reason = status === plan.status ? plan.reason : 'identical republish: carries the announcement still on its way';
  const announced = (await c.query(`SELECT EXISTS (SELECT 1 FROM pool_alerts.deliveries d JOIN pool_alerts.notifications n ON n.id = d.notification_id
      WHERE n.season = $1 AND n.week = $2 AND d.state = 'sent') AS yes`, [event.season, event.week])).rows[0].yes;
  const notification = (await c.query(`INSERT INTO pool_alerts.notifications
      (event_id, season, week, revision, base_kind, status, status_reason, published_at, finished_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $6 = 'queued' THEN NULL ELSE clock_timestamp() END)
      ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    [event.id, event.season, event.week, event.revision, announced ? 'correction' : 'release', status, reason, event.published_at])).rows[0];
  counts[status] += 1;
  if (!notification || status !== 'queued') return;
  if (carried.length) {
    // Same devices, same kind; a device that has since turned corrections off or been removed is skipped.
    const inserted = await c.query(`INSERT INTO pool_alerts.deliveries (notification_id, subscription_id, kind)
        SELECT DISTINCT ON (p.subscription_id) $1, p.subscription_id, p.kind
        FROM unnest($2::uuid[], $3::text[]) AS p(subscription_id, kind)
        JOIN pool_alerts.subscriptions s ON s.id = p.subscription_id
        WHERE s.status = 'active' AND (p.kind = 'release' OR s.corrections)
        ORDER BY p.subscription_id, (p.kind = 'release') DESC
        ON CONFLICT DO NOTHING`, [notification.id, carried.map(r => r.subscription_id), carried.map(r => r.kind)]);
    counts.deliveries += inserted.rowCount;
    counts.carried = (counts.carried || 0) + inserted.rowCount;
    return;
  }
  // A device gets 'release' until it has received an announcement of this week, 'correction' afterwards (and only if
  // it wants corrections). Only devices enrolled before the publication are included, and a device that already
  // received this exact revision of this week gets nothing (duplicate publication).
  const inserted = await c.query(`INSERT INTO pool_alerts.deliveries (notification_id, subscription_id, kind)
      SELECT $1, s.id, k.kind FROM pool_alerts.subscriptions s
      CROSS JOIN LATERAL (SELECT CASE WHEN EXISTS (
        SELECT 1 FROM pool_alerts.deliveries d JOIN pool_alerts.notifications n ON n.id = d.notification_id
        WHERE d.subscription_id = s.id AND n.season = $2 AND n.week = $3 AND d.state = 'sent') THEN 'correction' ELSE 'release' END AS kind) k
      WHERE s.status = 'active' AND s.created_at <= $5
        AND (k.kind = 'release' OR s.corrections)
        AND NOT EXISTS (SELECT 1 FROM pool_alerts.deliveries d JOIN pool_alerts.notifications n ON n.id = d.notification_id
          WHERE d.subscription_id = s.id AND n.season = $2 AND n.week = $3 AND n.revision = $4 AND d.state = 'sent')
      ON CONFLICT DO NOTHING`, [notification.id, event.season, event.week, event.revision, event.occurred_at]);
  counts.deliveries += inserted.rowCount;
}

export async function ingest(pool, {nowMs, limit = 200}) {
  return tx(pool, async c => {
    await c.query(LOCK_INGEST);
    const settings = await readSettings(c);
    const cursor = (await c.query('SELECT last_event_id, initialized_at FROM pool_alerts.cursor')).rows[0];
    if (!cursor) {
      // First start: everything already captured is history. Record the baseline and announce nothing.
      const max = Number((await c.query('SELECT coalesce(max(id), 0) AS id FROM pool_alerts.publication_events')).rows[0].id);
      await c.query('INSERT INTO pool_alerts.cursor (last_event_id) VALUES ($1)', [max]);
      await audit(c, 'sender', 'baseline', {last_event_id: max});
      return {baseline: true, events: 0, more: false};
    }
    const events = (await c.query(`SELECT id, season, week, revision, action, content_changed, published_at, occurred_at, source
        FROM pool_alerts.publication_events WHERE id > $1 ORDER BY id LIMIT $2`, [cursor.last_event_id, limit])).rows;
    const counts = {baseline: false, events: events.length, queued: 0, stale: 0, unchanged: 0, superseded: 0, withdrawn: 0, deliveries: 0};
    for (const event of events) {
      if (event.action === 'publish') await planPublish(c, event, settings, nowMs, counts);
      else counts.withdrawn += await closeOpen(c, {season: event.season, week: event.week, maxRevision: event.revision, status: 'withdrawn',
        reason: `revision ${event.revision} was withdrawn`, deliveryState: 'cancelled', deliveryError: 'withdrawn'});
    }
    if (events.length) await c.query('UPDATE pool_alerts.cursor SET last_event_id = $1, updated_at = clock_timestamp()', [events.at(-1).id]);
    return {...counts, more: events.length === limit};
  });
}

export async function readCursor(db) {
  return (await db.query('SELECT last_event_id, initialized_at FROM pool_alerts.cursor')).rows[0] || null;
}

// Highest captured publish revision per week (all events, processed or not).
export async function capturedRevisions(db) {
  const rows = (await db.query(`SELECT season, week, max(revision) AS revision FROM pool_alerts.publication_events
      WHERE action = 'publish' GROUP BY season, week`)).rows;
  return new Map(rows.map(r => [weekKey(r.season, r.week), Number(r.revision)]));
}

// A locked revision is public but no event recorded it (the trigger was disabled, failed or bypassed). Record it so it
// is planned like any other publication, and leave an audit entry: this is a capture gap the owner must look at.
export async function recordReconcileEvent(pool, row) {
  return tx(pool, async c => {
    await c.query(LOCK_INGEST);
    const exists = (await c.query(`SELECT 1 FROM pool_alerts.publication_events WHERE season = $1 AND week = $2 AND action = 'publish'
        AND revision >= $3`, [row.season, row.week, row.revision])).rowCount;
    if (exists) return false;
    await c.query(`INSERT INTO pool_alerts.publication_events (season, week, revision, action, content_changed, published_at, source)
        VALUES ($1, $2, $3, 'publish', true, $4, 'reconcile')`, [row.season, row.week, row.revision, row.publishedAt]);
    await audit(c, 'sender', 'capture-gap', {season: row.season, week: row.week, revision: row.revision});
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Verification and delivery.
// ---------------------------------------------------------------------------------------------------------------
export async function openNotifications(db) {
  return (await db.query(`SELECT id, season, week, revision, status, created_at FROM pool_alerts.notifications
      WHERE status = ANY($1) ORDER BY id`, [OPEN])).rows.map(r => ({...r, id: Number(r.id)}));
}

export async function applyVerification(pool, notification, publicRow) {
  const outcome = verificationOutcome(notification, publicRow);
  if (outcome.status === 'verified') {
    await pool.query(`UPDATE pool_alerts.notifications SET status = 'verified', verified_at = coalesce(verified_at, clock_timestamp())
        WHERE id = $1 AND status = ANY($2)`, [notification.id, OPEN]);
    return outcome;
  }
  await tx(pool, async c => {
    const closed = await c.query(`UPDATE pool_alerts.notifications SET status = $2, status_reason = $3, finished_at = clock_timestamp()
        WHERE id = $1 AND status = ANY($4) RETURNING id`, [notification.id, outcome.status, outcome.reason, OPEN]);
    if (closed.rowCount) {
      await c.query(`UPDATE pool_alerts.deliveries SET state = $2, last_error = $3, lease_token = NULL, lease_until = NULL,
          updated_at = clock_timestamp() WHERE notification_id = $1 AND state IN ('pending', 'retry')`,
        [notification.id, outcome.status === 'superseded' ? 'superseded' : 'cancelled', outcome.status]);
    }
  });
  return outcome;
}

export async function leaseDeliveries(pool, {notificationIds, limit = 25, leaseSeconds = 120}) {
  if (!notificationIds.length) return {token: null, rows: []};
  const token = randomUUID();
  const rows = (await pool.query(`WITH due AS (
        SELECT d.notification_id, d.subscription_id FROM pool_alerts.deliveries d
        JOIN pool_alerts.notifications n ON n.id = d.notification_id
        JOIN pool_alerts.subscriptions s ON s.id = d.subscription_id
        WHERE n.status = 'verified' AND n.id = ANY($1::bigint[]) AND s.status = 'active'
          AND (d.kind = 'release' OR s.corrections) AND d.attempts < $2
          AND ((d.state IN ('pending', 'retry') AND d.next_attempt_at <= clock_timestamp())
            OR (d.state = 'sending' AND d.lease_until <= clock_timestamp()))
        ORDER BY d.next_attempt_at, d.notification_id LIMIT $3 FOR UPDATE OF d SKIP LOCKED)
      UPDATE pool_alerts.deliveries d SET state = 'sending', attempts = d.attempts + 1, lease_token = $4,
        lease_until = clock_timestamp() + make_interval(secs => $5), updated_at = clock_timestamp()
      FROM due JOIN pool_alerts.subscriptions s ON s.id = due.subscription_id
        JOIN pool_alerts.notifications n ON n.id = due.notification_id
      WHERE d.notification_id = due.notification_id AND d.subscription_id = due.subscription_id
      RETURNING d.notification_id, d.subscription_id, d.kind, d.attempts, s.endpoint, s.p256dh, s.auth, n.season, n.week, n.revision`,
    [notificationIds, MAX_ATTEMPTS, limit, token, leaseSeconds])).rows;
  return {token, rows: rows.map(r => ({...r, notification_id: Number(r.notification_id)}))};
}

// Transient database failures (connection limit, network, deadlock, lock or statement timeout) are retried a few times
// before a completion gives up; a completion that never lands leaves the lease to expire and the delivery is retried
// (at-least-once, never lost).
const TRANSIENT = new Set(['53300', '57P01', '57P03', '08000', '08003', '08006', '40001', '40P01', '55P03', '57014']);
export async function withRetry(fn, {attempts = 4, delays = [150, 400, 1000]} = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (error) {
      const transient = TRANSIENT.has(error?.code) || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|terminat/i.test(String(error?.message));
      if (!transient || i >= attempts) throw error;
      await new Promise(r => setTimeout(r, delays[Math.min(i - 1, delays.length - 1)]));
    }
  }
}

export async function completeDelivery(pool, {row, token, status, retryAfterSeconds = null}) {
  const outcome = deliveryOutcome({status, attempt: row.attempts, retryAfterSeconds});
  await withRetry(() => tx(pool, async c => {
    const changed = await c.query(`UPDATE pool_alerts.deliveries SET state = $4, next_attempt_at = clock_timestamp() + make_interval(secs => $5),
        lease_token = NULL, lease_until = NULL, last_status = $6, last_error = $7,
        sent_at = CASE WHEN $4 = 'sent' THEN clock_timestamp() ELSE sent_at END, updated_at = clock_timestamp()
        WHERE notification_id = $1 AND subscription_id = $2 AND lease_token = $3 AND state = 'sending'`,
      [row.notification_id, row.subscription_id, token, outcome.state, outcome.delaySeconds || 0, status || null, outcome.errorClass]);
    if (!changed.rowCount) return;
    if (outcome.state === 'sent') {
      await c.query('UPDATE pool_alerts.subscriptions SET last_success_at = clock_timestamp() WHERE id = $1', [row.subscription_id]);
    } else if (outcome.state === 'expired') {
      await c.query(`UPDATE pool_alerts.subscriptions SET status = 'expired', disabled_at = clock_timestamp(), disabled_reason = $2,
          updated_at = clock_timestamp() WHERE id = $1 AND status = 'active'`, [row.subscription_id, outcome.errorClass]);
      await c.query(`UPDATE pool_alerts.deliveries SET state = 'cancelled', last_error = 'subscription expired', updated_at = clock_timestamp()
          WHERE subscription_id = $1 AND state IN ('pending', 'retry')`, [row.subscription_id]);
    }
  }));
  return outcome;
}

export async function finishNotifications(pool) {
  return (await pool.query(`UPDATE pool_alerts.notifications n SET status = 'done', finished_at = clock_timestamp()
      WHERE n.status = 'verified' AND NOT EXISTS (SELECT 1 FROM pool_alerts.deliveries d WHERE d.notification_id = n.id
        AND d.state IN ('pending', 'retry', 'sending')) RETURNING id`)).rowCount;
}

// The soonest retry still owed for these notifications (ms epoch), or null.
export async function nextRetryAt(pool, notificationIds) {
  if (!notificationIds.length) return null;
  const at = (await pool.query(`SELECT min(CASE WHEN d.state = 'sending' THEN d.lease_until ELSE d.next_attempt_at END) AS at
      FROM pool_alerts.deliveries d JOIN pool_alerts.notifications n ON n.id = d.notification_id
      WHERE n.status = 'verified' AND n.id = ANY($1::bigint[]) AND d.state IN ('pending', 'retry', 'sending') AND d.attempts < $2`,
    [notificationIds, MAX_ATTEMPTS])).rows[0].at;
  return at ? at.getTime() : null;
}

// Notifications that could not be sent within the age limit are closed as stale: an alert days late is noise.
// Exhausted in-flight leases (a crashed sender on its last attempt) are closed as failed.
export async function expireStale(pool, settings) {
  return tx(pool, async c => {
    const stale = await c.query(`UPDATE pool_alerts.notifications n SET status = 'stale', status_reason = 'not delivered within the age limit',
        finished_at = clock_timestamp() FROM pool_alerts.publication_events e
        WHERE e.id = n.event_id AND n.status = ANY($1) AND e.occurred_at < clock_timestamp() - make_interval(mins => $2) RETURNING n.id`,
      [OPEN, settings.max_notification_age_minutes]);
    if (stale.rowCount) {
      await c.query(`UPDATE pool_alerts.deliveries SET state = 'failed', last_error = 'stale', lease_token = NULL, lease_until = NULL,
          updated_at = clock_timestamp() WHERE notification_id = ANY($1) AND state IN ('pending', 'retry')`, [stale.rows.map(r => r.id)]);
    }
    const exhausted = await c.query(`UPDATE pool_alerts.deliveries SET state = 'failed', last_error = 'lease-expired-exhausted', lease_token = NULL,
        lease_until = NULL, updated_at = clock_timestamp() WHERE state = 'sending' AND lease_until <= clock_timestamp() AND attempts >= $1`, [MAX_ATTEMPTS]);
    return {stale: stale.rowCount, exhausted: exhausted.rowCount};
  });
}

export async function housekeeping(pool) {
  return tx(pool, async c => {
    const runs = await c.query("DELETE FROM pool_alerts.runs WHERE started_at < clock_timestamp() - interval '90 days'");
    const subs = await c.query(`DELETE FROM pool_alerts.subscriptions WHERE status IN ('expired', 'disabled')
        AND coalesce(disabled_at, updated_at) < clock_timestamp() - interval '30 days'`);
    const deliveries = await c.query(`DELETE FROM pool_alerts.deliveries WHERE state IN ('sent', 'failed', 'expired', 'cancelled', 'superseded')
        AND updated_at < clock_timestamp() - interval '180 days'`);
    const checks = await c.query("DELETE FROM pool_alerts.device_checks WHERE created_at < clock_timestamp() - interval '30 days'");
    return {runs: runs.rowCount, subscriptions: subs.rowCount, deliveries: deliveries.rowCount, checks: checks.rowCount};
  });
}

export async function startRun(pool, trigger) {
  return Number((await pool.query('INSERT INTO pool_alerts.runs (trigger) VALUES ($1) RETURNING id', [trigger])).rows[0].id);
}
export async function finishRun(pool, id, {outcome, errorClass = null, summary}) {
  await pool.query(`UPDATE pool_alerts.runs SET finished_at = clock_timestamp(), outcome = $2, error_class = $3, summary = $4 WHERE id = $1`,
    [id, outcome, errorClass ? String(errorClass).slice(0, 80) : null, JSON.stringify(summary)]);
}

// ---------------------------------------------------------------------------------------------------------------
// Devices.
// ---------------------------------------------------------------------------------------------------------------
async function authorizedSubscription(c, id, token) {
  const row = (await c.query('SELECT id, endpoint, p256dh, auth, manage_token_sha256, corrections, status FROM pool_alerts.subscriptions WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row || !digestMatches(token, row.manage_token_sha256)) return null;
  return row;
}

export async function enroll(pool, {subscription, corrections, origin, inviteCode, platform = null}) {
  return tx(pool, async c => {
    await c.query(LOCK_ENROLL);
    const settings = await readSettings(c);
    if (settings.enrollment_mode === 'closed') return {status: 403, body: {error: 'enrollment-closed'}};
    if (settings.enrollment_mode === 'invite' && !digestMatches(inviteCode, settings.invite_code_sha256)) {
      return {status: 403, body: {error: 'invite-required'}};
    }
    const token = randomBytes(32).toString('base64url');
    const existing = (await c.query('SELECT id, p256dh, auth FROM pool_alerts.subscriptions WHERE endpoint = $1 FOR UPDATE', [subscription.endpoint])).rows[0];
    if (existing) {
      // The same browser enrolling again (its stored credentials were lost): same endpoint AND same keys only.
      if (existing.p256dh !== subscription.keys.p256dh || existing.auth !== subscription.keys.auth) return {status: 409, body: {error: 'endpoint-conflict'}};
      await c.query(`UPDATE pool_alerts.subscriptions SET manage_token_sha256 = $2, corrections = $3, origin = $4, status = 'active',
          disabled_at = NULL, disabled_reason = NULL, updated_at = clock_timestamp(), last_seen_at = clock_timestamp(),
          platform = coalesce($5, platform) WHERE id = $1`,
        [existing.id, sha256Hex(token), corrections, origin, platform]);
      return {status: 200, body: {id: existing.id, token, corrections, reenrolled: true}};
    }
    const counts = (await c.query(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
        count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 hour')::int AS recent FROM pool_alerts.subscriptions`)).rows[0];
    if (counts.active >= settings.max_active_subscriptions) return {status: 503, body: {error: 'capacity-reached'}};
    if (counts.recent >= settings.max_new_subscriptions_per_hour) return {status: 429, body: {error: 'enrollment-busy'}};
    const id = (await c.query(`INSERT INTO pool_alerts.subscriptions (endpoint, p256dh, auth, manage_token_sha256, origin, corrections, platform)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, sha256Hex(token), origin, corrections, platform])).rows[0].id;
    return {status: 201, body: {id, token, corrections}};
  });
}

export async function updateDevice(pool, {id, token, corrections, subscription}) {
  return tx(pool, async c => {
    const row = await authorizedSubscription(c, id, token);
    if (!row) return {status: 403, body: {error: 'not-authorized'}};
    if (subscription && subscription.endpoint !== row.endpoint) {
      const taken = (await c.query('SELECT 1 FROM pool_alerts.subscriptions WHERE endpoint = $1 AND id <> $2', [subscription.endpoint, id])).rowCount;
      if (taken) return {status: 409, body: {error: 'endpoint-conflict'}};
    }
    const next = {corrections: corrections ?? row.corrections, endpoint: subscription?.endpoint ?? row.endpoint,
      p256dh: subscription?.keys.p256dh ?? row.p256dh, auth: subscription?.keys.auth ?? row.auth};
    await c.query(`UPDATE pool_alerts.subscriptions SET corrections = $2, endpoint = $3, p256dh = $4, auth = $5, status = 'active',
        disabled_at = NULL, disabled_reason = NULL, updated_at = clock_timestamp(), last_seen_at = clock_timestamp() WHERE id = $1`,
      [id, next.corrections, next.endpoint, next.p256dh, next.auth]);
    if (!next.corrections) {
      await c.query(`UPDATE pool_alerts.deliveries SET state = 'cancelled', last_error = 'corrections turned off', updated_at = clock_timestamp()
          WHERE subscription_id = $1 AND kind = 'correction' AND state IN ('pending', 'retry')`, [id]);
    }
    return {status: 200, body: {ok: true, corrections: next.corrections, rotated: next.endpoint !== row.endpoint}};
  });
}

// Turning alerts off removes the device's row and its delivery history (nothing about it is kept).
export async function removeDevice(pool, {id, token}) {
  return tx(pool, async c => {
    const row = await authorizedSubscription(c, id, token);
    if (!row) return {status: 403, body: {error: 'not-authorized'}};
    await c.query('DELETE FROM pool_alerts.subscriptions WHERE id = $1', [id]);
    return {status: 200, body: {ok: true, removed: true}};
  });
}

// A device confirming it is still enrolled (at most daily). 'unknown' tells the app to enroll again (e.g. after the
// alert store was restored from an older backup).
export async function checkDevice(pool, {id, token, endpoint}) {
  return tx(pool, async c => {
    const row = await authorizedSubscription(c, id, token);
    if (!row) return {status: 200, body: {state: 'unknown'}};
    if (endpoint && endpoint !== row.endpoint) return {status: 200, body: {state: 'endpoint-changed', corrections: row.corrections}};
    await c.query('UPDATE pool_alerts.subscriptions SET last_seen_at = clock_timestamp() WHERE id = $1', [id]);
    return {status: 200, body: {state: row.status, corrections: row.corrections}};
  });
}

export async function deviceForTest(db, id) {
  return (await db.query("SELECT id, endpoint, p256dh, auth, status, corrections FROM pool_alerts.subscriptions WHERE id = $1", [id])).rows[0] || null;
}

// ---------------------------------------------------------------------------------------------------------------
// Device checks (migration 007): the device asks to be checked; the owner sends check alerts to that one device; the
// device's service worker returns each check's receipt; the owner records a verdict.
// ---------------------------------------------------------------------------------------------------------------
export const deviceCode = id => deviceCodeFromDigest(createHash('sha256').update(String(id), 'utf8').digest());

// A device asks (from its own Pool Alerts card) to be listed for the owner's checks for 24 hours. At most once a minute.
export async function requestCheck(pool, {id, token, platform = null}) {
  return tx(pool, async c => {
    const row = await authorizedSubscription(c, id, token);
    if (!row) return {status: 403, body: {error: 'not-authorized'}};
    if (row.status !== 'active') return {status: 409, body: {error: 'device-not-active'}};
    const recent = (await c.query(`SELECT check_requested_at > clock_timestamp() - interval '1 minute' AS recent FROM pool_alerts.subscriptions WHERE id = $1`, [id])).rows[0];
    if (recent?.recent) return {status: 429, body: {error: 'try-again-later'}};
    await c.query(`UPDATE pool_alerts.subscriptions SET check_requested_at = clock_timestamp(), last_seen_at = clock_timestamp(),
        platform = coalesce($2, platform) WHERE id = $1`, [id, platform]);
    return {status: 200, body: {ok: true, code: deviceCode(id), listedForHours: 24}};
  });
}

// The devices that asked to be checked in the last 24 hours (the owner's acceptance list). No endpoint or key.
export async function checkCandidates(db) {
  const rows = (await db.query(`SELECT id, platform, origin, corrections, status, created_at, last_seen_at, check_requested_at, last_success_at
      FROM pool_alerts.subscriptions WHERE check_requested_at > clock_timestamp() - interval '24 hours'
      ORDER BY check_requested_at DESC LIMIT 20`)).rows;
  return rows.map(r => ({id: r.id, code: deviceCode(r.id), platform: r.platform, origin: r.origin, corrections: r.corrections, status: r.status,
    enrolledAt: r.created_at, lastSeenAt: r.last_seen_at, checkRequestedAt: r.check_requested_at, lastSuccessAt: r.last_success_at}));
}

export async function startCheck(pool, {subscriptionId, scenario, season = null, week = null, revision = null, ackSha256, actor, skipped = null}) {
  return Number((await pool.query(`INSERT INTO pool_alerts.device_checks (subscription_id, ack_sha256, scenario, season, week, revision, requested_by, state, last_error)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [subscriptionId, ackSha256, scenario, season, week, revision, String(actor).slice(0, 40), skipped ? 'skipped' : 'sending', skipped])).rows[0].id);
}

export async function completeCheck(pool, {id, state, status, errorClass}) {
  await withRetry(() => tx(pool, async c => {
    const done = (await c.query(`UPDATE pool_alerts.device_checks SET state = $2, last_status = $3, last_error = $4,
        sent_at = CASE WHEN $2 = 'sent' THEN clock_timestamp() ELSE sent_at END WHERE id = $1 AND state = 'sending' RETURNING subscription_id`,
      [id, state, status || null, errorClass])).rows[0];
    if (!done) return;
    if (state === 'sent') await c.query('UPDATE pool_alerts.subscriptions SET last_success_at = clock_timestamp() WHERE id = $1', [done.subscription_id]);
    else if (state === 'expired') {
      await c.query(`UPDATE pool_alerts.subscriptions SET status = 'expired', disabled_at = clock_timestamp(), disabled_reason = $2,
          updated_at = clock_timestamp() WHERE id = $1 AND status = 'active'`, [done.subscription_id, errorClass]);
      await c.query(`UPDATE pool_alerts.deliveries SET state = 'cancelled', last_error = 'subscription expired', updated_at = clock_timestamp()
          WHERE subscription_id = $1 AND state IN ('pending', 'retry')`, [done.subscription_id]);
    }
  }));
}

// A device's receipt for a check sent within the last day: 'received' (shown; repeat = it replaced an identical alert
// already on the device) or 'opened' (tapped). Anything else changes nothing; the caller learns nothing either way.
export async function ackCheck(pool, {ackSha256, event, repeat = null}) {
  const rows = await pool.query(`UPDATE pool_alerts.device_checks SET received_at = coalesce(received_at, clock_timestamp()),
      received_repeat = CASE WHEN $2 = 'received' AND received_at IS NULL THEN $3 ELSE received_repeat END,
      opened_at = CASE WHEN $2 = 'opened' THEN coalesce(opened_at, clock_timestamp()) ELSE opened_at END
      WHERE ack_sha256 = $1 AND state = 'sent' AND created_at > clock_timestamp() - interval '1 day'`, [ackSha256, event, repeat]);
  return rows.rowCount > 0;
}

export async function recentChecks(db) {
  const rows = (await db.query(`SELECT c.id, c.subscription_id, s.platform, c.scenario, c.season, c.week, c.revision, c.state, c.last_status,
      c.last_error, c.requested_by, c.created_at, c.sent_at, c.received_at, c.received_repeat, c.opened_at, c.owner_result, c.owner_note, c.confirmed_at
      FROM pool_alerts.device_checks c JOIN pool_alerts.subscriptions s ON s.id = c.subscription_id
      WHERE c.created_at > clock_timestamp() - interval '48 hours' ORDER BY c.id DESC LIMIT 40`)).rows;
  return rows.map(({subscription_id: sid, ...r}) => ({...r, id: Number(r.id), code: deviceCode(sid)}));
}

export async function confirmCheck(pool, {checkId, result, note = null, actor}) {
  if (!['pass', 'fail'].includes(result)) throw Object.assign(new Error('result must be pass or fail'), {status: 400});
  return tx(pool, async c => {
    const row = (await c.query(`UPDATE pool_alerts.device_checks SET owner_result = $2, owner_note = $3, confirmed_at = clock_timestamp()
        WHERE id = $1 RETURNING id, scenario, state, received_at IS NOT NULL AS received, opened_at IS NOT NULL AS opened`,
      [checkId, result, note ? String(note).slice(0, 200) : null])).rows[0];
    if (!row) return null;
    await audit(c, actor, 'device-check-verdict', {check: Number(row.id), scenario: row.scenario, result, state: row.state, received: row.received, opened: row.opened});
    return {...row, id: Number(row.id)};
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Owner operations and diagnostics.
// ---------------------------------------------------------------------------------------------------------------
export async function setSending(pool, {enabled, actor, note = null}) {
  return tx(pool, async c => {
    await c.query(`UPDATE pool_alerts.settings SET sending_enabled = $1, updated_at = clock_timestamp(), updated_by = $2, note = $3`,
      [enabled, actor, note ? String(note).slice(0, 200) : null]);
    await audit(c, actor, enabled ? 'resume-sending' : 'pause-sending', {note});
    return readSettings(c);
  });
}

export async function setEnrollment(pool, {mode, inviteCode = null, actor}) {
  if (!['open', 'invite', 'closed'].includes(mode)) throw new Error('Invalid enrollment mode');
  if (mode === 'invite' && (typeof inviteCode !== 'string' || inviteCode.length < 12 || inviteCode.length > 128)) {
    throw new Error('An invitation code of 12 to 128 characters is required');
  }
  return tx(pool, async c => {
    await c.query(`UPDATE pool_alerts.settings SET enrollment_mode = $1, invite_code_sha256 = $2, updated_at = clock_timestamp(), updated_by = $3`,
      [mode, mode === 'invite' ? sha256Hex(inviteCode) : null, actor]);
    await audit(c, actor, 'set-enrollment', {mode});
    return readSettings(c);
  });
}

// Failed deliveries (not expired devices, not refused credentials) of notifications that are still current and within
// the age limit go back to the queue with a fresh attempt budget.
export async function retryFailed(pool, {actor}) {
  return tx(pool, async c => {
    const settings = await readSettings(c);
    const reset = await c.query(`UPDATE pool_alerts.deliveries d SET state = 'pending', attempts = 0, next_attempt_at = clock_timestamp(),
        last_error = 'owner retry', updated_at = clock_timestamp()
      FROM pool_alerts.notifications n JOIN pool_alerts.publication_events e ON e.id = n.event_id, pool_alerts.subscriptions s
      WHERE d.notification_id = n.id AND s.id = d.subscription_id AND d.state = 'failed' AND s.status = 'active'
        AND coalesce(d.last_error, '') NOT LIKE 'auth-%' AND n.status IN ('verified', 'done')
        AND e.occurred_at >= clock_timestamp() - make_interval(mins => $1)
      RETURNING d.notification_id`, [settings.max_notification_age_minutes]);
    const ids = [...new Set(reset.rows.map(r => r.notification_id))];
    if (ids.length) await c.query(`UPDATE pool_alerts.notifications SET status = 'queued', finished_at = NULL WHERE id = ANY($1) AND status = 'done'`, [ids]);
    await audit(c, actor, 'retry-failed', {deliveries: reset.rowCount});
    return {deliveries: reset.rowCount, notifications: ids.length};
  });
}

export async function status(pool) {
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const [settings] = await q(`SELECT sending_enabled, enrollment_mode, max_active_subscriptions, max_new_subscriptions_per_hour,
      max_notification_age_minutes, updated_at, updated_by, note FROM pool_alerts.settings`);
  const [env] = await q('SELECT name FROM pool_alerts.environment');
  const [cursor] = await q('SELECT last_event_id, initialized_at, updated_at FROM pool_alerts.cursor');
  const [events] = await q(`SELECT max(id) AS latest_id, count(*) FILTER (WHERE source = 'reconcile')::int AS reconciled,
      max(occurred_at) AS latest_at FROM pool_alerts.publication_events`);
  const subscriptions = Object.fromEntries((await q('SELECT status, count(*)::int AS n FROM pool_alerts.subscriptions GROUP BY status')).map(r => [r.status, r.n]));
  const deliveries = Object.fromEntries((await q(`SELECT state, count(*)::int AS n FROM pool_alerts.deliveries
      WHERE updated_at > clock_timestamp() - interval '30 days' GROUP BY state`)).map(r => [r.state, r.n]));
  const [oldest] = await q(`SELECT min(created_at) AS at FROM pool_alerts.deliveries WHERE state IN ('pending', 'retry', 'sending')`);
  const failures = await q(`SELECT coalesce(last_error, 'unknown') AS error, count(*)::int AS n FROM pool_alerts.deliveries
      WHERE state IN ('failed', 'expired', 'retry') AND updated_at > clock_timestamp() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
  const notifications = await q(`SELECT n.id, n.season, n.week, n.revision, n.base_kind, n.status, n.status_reason, n.created_at, n.finished_at,
      count(d.*) FILTER (WHERE d.state = 'sent')::int AS sent, count(d.*) FILTER (WHERE d.state IN ('pending', 'retry', 'sending'))::int AS pending,
      count(d.*) FILTER (WHERE d.state IN ('failed', 'expired'))::int AS failed
      FROM pool_alerts.notifications n LEFT JOIN pool_alerts.deliveries d ON d.notification_id = n.id
      GROUP BY n.id ORDER BY n.id DESC LIMIT 10`);
  const runs = await q(`SELECT id, trigger, started_at, finished_at, outcome, error_class, summary FROM pool_alerts.runs ORDER BY id DESC LIMIT 10`);
  const gaps = await q(`SELECT at, detail FROM pool_alerts.audit_log WHERE action = 'capture-gap' AND at > clock_timestamp() - interval '30 days' ORDER BY at DESC LIMIT 5`);
  const actions = await q(`SELECT at, actor, action, detail FROM pool_alerts.audit_log ORDER BY id DESC LIMIT 10`);
  // Figures for the Maintenance Center (counts and times only).
  const [runTimes] = await q(`SELECT max(started_at) FILTER (WHERE outcome IN ('ok', 'paused')) AS last_ok,
      max(started_at) FILTER (WHERE trigger = 'cron') AS last_cron FROM pool_alerts.runs`);
  const [waiting] = await q(`SELECT count(*)::int AS n FROM pool_alerts.publication_events WHERE id > coalesce((SELECT last_event_id FROM pool_alerts.cursor), 0)`);
  const [latest] = await q(`SELECT season, week, revision, action, occurred_at FROM pool_alerts.publication_events ORDER BY id DESC LIMIT 1`);
  const [latency] = await q(`SELECT count(*)::int AS sent, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM d.sent_at - e.occurred_at))::numeric) AS p50,
      round(max(extract(epoch FROM d.sent_at - e.occurred_at))::numeric) AS max FROM pool_alerts.deliveries d
      JOIN pool_alerts.notifications n ON n.id = d.notification_id JOIN pool_alerts.publication_events e ON e.id = n.event_id
      WHERE d.state = 'sent' AND d.sent_at > clock_timestamp() - interval '7 days'`);
  const [expired] = await q(`SELECT count(*)::int AS n FROM pool_alerts.subscriptions WHERE status = 'expired' AND coalesce(disabled_at, updated_at) > clock_timestamp() - interval '7 days'`);
  const [checkRows] = await q(`SELECT to_regclass('pool_alerts.device_checks') IS NOT NULL AS installed`);
  const checks7d = checkRows?.installed ? (await q(`SELECT count(*)::int AS requested, count(*) FILTER (WHERE state = 'sent')::int AS sent,
      count(*) FILTER (WHERE state IN ('failed', 'expired'))::int AS failed, count(received_at)::int AS received, count(opened_at)::int AS opened,
      count(*) FILTER (WHERE owner_result = 'pass')::int AS passed, count(*) FILTER (WHERE owner_result = 'fail')::int AS owner_failed,
      max(received_at) AS last_received_at, max(confirmed_at) AS last_confirmed_at
      FROM pool_alerts.device_checks WHERE created_at > clock_timestamp() - interval '7 days'`))[0] : null;
  return {
    environment: env?.name ?? null, settings, cursor: cursor ?? null,
    events: {latestId: events.latest_id === null ? null : Number(events.latest_id), latestAt: events.latest_at, reconciled: events.reconciled},
    subscriptions, deliveries30d: deliveries, oldestOutstandingAt: oldest?.at ?? null, failures7d: failures,
    notifications: notifications.map(n => ({...n, id: Number(n.id)})),
    runs: runs.map(r => ({...r, id: Number(r.id)})), captureGaps30d: gaps, recentActions: actions,
    lastOkRunAt: runTimes?.last_ok ?? null, lastCronRunAt: runTimes?.last_cron ?? null, eventsWaiting: waiting?.n ?? 0,
    latestEvent: latest ? {season: latest.season, week: latest.week, revision: latest.revision, action: latest.action, occurredAt: latest.occurred_at} : null,
    latency7d: {sent: latency?.sent ?? 0, p50Seconds: latency?.p50 === null || latency?.p50 === undefined ? null : Number(latency.p50),
      maxSeconds: latency?.max === null || latency?.max === undefined ? null : Number(latency.max)},
    expiredDevices7d: expired?.n ?? 0, checks7d
  };
}
