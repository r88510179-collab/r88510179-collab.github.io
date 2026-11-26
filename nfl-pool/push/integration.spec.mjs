// Pool Alerts end-to-end scenarios against a disposable, production-shaped PostgreSQL (see test-integration.sh), the
// real sender HTTP surface, the real web-push library and a local HTTPS push service that verifies VAPID and decrypts
// every payload. Publications are written as the Data API publisher (SET ROLE authenticated + commissioner claims);
// the public verification path reads as the anonymous role through RLS. Nothing here touches Neon.
import assert from 'node:assert/strict';
import https from 'node:https';
import {generateKeyPairSync, sign, randomBytes} from 'node:crypto';
import pg from 'pg';
import webpush from 'web-push';
import {createApp} from './app.mjs';
import {serve} from './main.mjs';
import {createPublicReader} from './public-read.mjs';
import {createJwtVerifier, sha256Hex} from './auth.mjs';
import {createPushSender} from './webpush.mjs';
import * as store from './store.mjs';
import {startPushService} from './test-support/push-service.mjs';
import {startDataApi} from './test-support/data-api.mjs';
import {main as ops} from './ops.mjs';

const adminUrl = process.env.PUSH_IT_ADMIN_URL, senderUrl = process.env.PUSH_IT_SENDER_URL;
for (const url of [adminUrl, senderUrl]) {
  if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('A disposable local test database is required (run test-integration.sh)');
}
const admin = new pg.Pool({connectionString: adminUrl, max: 8});
const senderPool = new pg.Pool({connectionString: senderUrl, max: 3});
const SEASON = 2096, ORIGIN = 'https://pool-center.test', OWNER_TOKEN = randomBytes(32).toString('base64url'), STATUS_TOKEN = randomBytes(32).toString('base64url');
const COMMISSIONER = '00000000-0000-4000-8000-000000000001';

const {publicKey: jwtPublic, privateKey: jwtPrivate} = generateKeyPairSync('ed25519');
const dataApi = await startDataApi({adminPool: admin, jwks: {keys: [{...jwtPublic.export({format: 'jwk'}), kid: 'publisher-1'}]}});
const vapid = webpush.generateVAPIDKeys(), subject = 'mailto:pool-alerts-test@example.invalid';
const pushService = await startPushService({subject});
const cfg = Object.freeze({environment: 'test', database: 'nfl_pool', origins: [ORIGIN], publisherEmail: 'djsmokke@gmail.com',
  vapid: {publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject}, sendingAllowed: true,
  ownerTokenSha256: sha256Hex(OWNER_TOKEN), statusTokenSha256: sha256Hex(STATUS_TOKEN), version: 'test'});
const services = [{name: 'local-test-service', accepts: host => host === 'localhost', allowsPort: true}];
const send = createPushSender({...cfg.vapid, agent: new https.Agent({ca: pushService.ca})});
function makeApp(cfgOverrides = {}) {
  return createApp({cfg: {...cfg, ...cfgOverrides}, pool: senderPool, send, services, budgets: {dispatch: 4000, cron: 4000, owner: 4000},
    reader: createPublicReader({authUrl: dataApi.authUrl, dataUrl: dataApi.dataUrl}),
    verifyPublisher: createJwtVerifier({jwksUrl: dataApi.jwksUrl, issuer: dataApi.issuer, audience: dataApi.issuer, publisherEmail: cfg.publisherEmail})});
}
const server = await serve(makeApp());
const base = `http://127.0.0.1:${server.address().port}`;

function publisherJwt(overrides = {}, key = jwtPrivate) {
  const now = Math.floor(Date.now() / 1000), enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const signing = `${enc({alg: 'EdDSA', kid: 'publisher-1', typ: 'JWT'})}.${enc({iss: dataApi.issuer, aud: dataApi.issuer, sub: COMMISSIONER,
    email: 'DJSmokke@Gmail.com', emailVerified: true, banned: false, iat: now, exp: now + 900, ...overrides})}`;
  return `${signing}.${sign(null, Buffer.from(signing), key).toString('base64url')}`;
}
async function call(path, {method = 'POST', body, origin = ORIGIN, token, headers = {}} = {}) {
  const response = await fetch(base + path, {method, body: body === undefined ? undefined : JSON.stringify(body), headers: {
    ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...(origin ? {Origin: origin} : {}),
    ...(token ? {Authorization: `Bearer ${token}`} : {}), ...headers}});
  return {status: response.status, body: await response.json().catch(() => null), headers: response.headers};
}
const dispatch = () => call('/v1/dispatch', {token: publisherJwt(), body: {}});
const cron = () => call('/v1/cron', {origin: null, headers: {'X-Neon-Trigger-Invocation-Id': `it-${randomBytes(6).toString('hex')}`}});
const owner = (path, body = {}) => call(`/v1/owner/${path}`, {token: OWNER_TOKEN, origin: null, body});

async function asPublisher(sql, params = [], claimsSub = COMMISSIONER) {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({sub: claimsSub, role: 'authenticated'})]);
    await c.query('SET LOCAL ROLE authenticated');
    const result = await c.query(sql, params);
    await c.query('COMMIT');
    return result;
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}
const weekConfig = (week, extra = {}) => JSON.stringify({schemaVersion: 1, season: SEASON, week, games: [], participants: [], ...extra});
async function publish(week, extra = {}) {
  const existing = (await admin.query('SELECT revision FROM public.nfl_pool_weeks WHERE season = $1 AND week = $2', [SEASON, week])).rows[0];
  if (!existing) {
    await asPublisher(`INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at, locked_at)
      VALUES ($1, $2, 'locked', $3, 1, now(), now())`, [SEASON, week, weekConfig(week, extra)]);
    return 1;
  }
  const result = await asPublisher(`UPDATE public.nfl_pool_weeks SET status = 'locked', config = $3, revision = $4 + 1, published_at = now(), locked_at = now()
    WHERE season = $1 AND week = $2 AND revision = $4 RETURNING revision`, [SEASON, week, weekConfig(week, extra), existing.revision]);
  assert.equal(result.rowCount, 1);
  return result.rows[0].revision;
}
const withdraw = week => asPublisher("UPDATE public.nfl_pool_weeks SET status = 'draft' WHERE season = $1 AND week = $2", [SEASON, week]);

async function enroll(name, {corrections = true, script = []} = {}) {
  const device = pushService.device(name, script);
  const result = await call('/v1/subscribe', {body: {subscription: device.subscription, corrections}});
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return {...device, sid: result.body.id, token: result.body.token};
}
const weekMessages = (device, week) => pushService.received(device.id).filter(m => m.payload.week === week);
const allRequests = device => pushService.messages.filter(m => m.device === device.id).length;
const deliveriesFor = async (week, revision) => (await admin.query(`SELECT d.*, n.revision FROM pool_alerts.deliveries d
  JOIN pool_alerts.notifications n ON n.id = d.notification_id WHERE n.season = $1 AND n.week = $2 ${revision ? 'AND n.revision = $3' : ''}`,
  revision ? [SEASON, week, revision] : [SEASON, week])).rows;
const notificationOf = async (week, revision) => (await admin.query('SELECT * FROM pool_alerts.notifications WHERE season = $1 AND week = $2 AND revision = $3',
  [SEASON, week, revision])).rows[0];
const fastForward = week => admin.query(`UPDATE pool_alerts.deliveries d SET next_attempt_at = now() FROM pool_alerts.notifications n
  WHERE n.id = d.notification_id AND n.season = $1 AND n.week = $2 AND d.state = 'retry'`, [SEASON, week]);

const results = [];
async function scenario(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
}

try {
  let A, B, C;
  await scenario('enrollment: no account, Pool Center origin only, push-service allowlist, re-enrollment, invite and capacity controls', async () => {
    A = await enroll('a');
    B = await enroll('b', {corrections: false});
    C = await enroll('c');
    const stray = pushService.device('stray');
    assert.equal((await call('/v1/subscribe', {origin: 'https://evil.example', body: {subscription: stray.subscription}})).status, 403);
    assert.equal((await call('/v1/subscribe', {origin: null, body: {subscription: stray.subscription}})).status, 403);
    for (const endpoint of ['https://127.0.0.1:9/push/x1234567890', 'http://localhost/push/abcdefghijk', 'https://metadata.google.internal/x/abcdef']) {
      assert.equal((await call('/v1/subscribe', {body: {subscription: {...stray.subscription, endpoint}}})).status, 400, endpoint);
    }
    // The same browser enrolling again (lost credentials): same endpoint and keys get a new token; the old one stops working.
    const again = await call('/v1/subscribe', {body: {subscription: A.subscription, corrections: true}});
    assert.equal(again.status, 200);
    assert.equal(again.body.reenrolled, true);
    assert.equal(again.body.id, A.sid);
    assert.equal((await call('/v1/preferences', {body: {id: A.sid, token: A.token, corrections: true}})).status, 403);
    A.token = again.body.token;
    const hijack = {...A.subscription, keys: {...A.subscription.keys, auth: randomBytes(16).toString('base64url')}};
    assert.equal((await call('/v1/subscribe', {body: {subscription: hijack}})).status, 409, 'same endpoint with other keys is refused');
    // Invite mode, closed mode, the active-device cap and the hourly cap.
    assert.equal((await owner('enrollment', {mode: 'invite', inviteCode: 'family-pool-2026'})).status, 200);
    assert.equal((await call('/v1/subscribe', {body: {subscription: stray.subscription}})).body.error, 'invite-required');
    assert.equal((await call('/v1/subscribe', {body: {subscription: stray.subscription, inviteCode: 'wrong-code-0000'}})).status, 403);
    const invited = await call('/v1/subscribe', {body: {subscription: stray.subscription, inviteCode: 'family-pool-2026'}});
    assert.equal(invited.status, 201);
    assert.equal((await call('/v1/unsubscribe', {body: {id: invited.body.id, token: invited.body.token}})).status, 200);
    assert.equal((await owner('enrollment', {mode: 'closed'})).status, 200);
    assert.equal((await call('/v1/subscribe', {body: {subscription: pushService.device('late').subscription}})).body.error, 'enrollment-closed');
    assert.equal((await owner('enrollment', {mode: 'open'})).status, 200);
    await admin.query('UPDATE pool_alerts.settings SET max_active_subscriptions = 3');
    assert.equal((await call('/v1/subscribe', {body: {subscription: pushService.device('cap').subscription}})).status, 503);
    await admin.query('UPDATE pool_alerts.settings SET max_active_subscriptions = 500, max_new_subscriptions_per_hour = 3');
    assert.equal((await call('/v1/subscribe', {body: {subscription: pushService.device('burst').subscription}})).status, 429);
    await admin.query('UPDATE pool_alerts.settings SET max_new_subscriptions_per_hour = 60');
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pool_alerts.subscriptions WHERE status = 'active'")).rows[0].n, 3);
  });

  await scenario('initialization never announces history: publications before the first cycle become the baseline', async () => {
    await publish(1);
    await publish(2);
    const first = await dispatch();
    assert.equal(first.status, 200);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pool_alerts.notifications')).rows[0].n, 0);
    assert.equal(pushService.messages.length, 0);
    const cursor = (await admin.query('SELECT last_event_id FROM pool_alerts.cursor')).rows[0];
    assert.equal(Number(cursor.last_event_id), Number((await admin.query('SELECT max(id) AS id FROM pool_alerts.publication_events')).rows[0].id));
  });

  await scenario('kill switch: sending starts disabled; a paused cycle sends nothing; resuming delivers the verified release', async () => {
    await publish(3);
    const paused = await dispatch();
    assert.equal(paused.body.paused, true);
    assert.equal(pushService.messages.length, 0);
    assert.equal((await notificationOf(3, 1)).status, 'verified');
    assert.equal((await owner('resume', {note: 'integration'})).status, 200);
    const sent = await dispatch();
    assert.equal(sent.body.sent, 3);
    for (const device of [A, B, C]) {
      const [message, ...rest] = weekMessages(device, 3);
      assert.equal(rest.length, 0);
      assert.deepEqual(message.payload, {v: 1, kind: 'release', season: SEASON, week: 3, revision: 1});
      assert.equal(message.topic, `pool-${SEASON}-3`);
      assert.equal(message.urgency, 'high');
      assert.equal(message.ttl, 86400);
      assert.equal(message.vapidKey, vapid.publicKey);
    }
    assert.equal((await notificationOf(3, 1)).status, 'done');
  });

  await scenario('official correction: opted-in devices get a correction; the opt-out device gets nothing', async () => {
    await publish(3, {organizerCorrections: [{entry: 'x', note: 'organizer notice'}]});
    await dispatch();
    assert.deepEqual(weekMessages(A, 3).map(m => [m.payload.kind, m.payload.revision]), [['release', 1], ['correction', 2]]);
    assert.deepEqual(weekMessages(C, 3).map(m => m.payload.kind), ['release', 'correction']);
    assert.deepEqual(weekMessages(B, 3).map(m => m.payload.kind), ['release']);
    assert.equal((await notificationOf(3, 2)).base_kind, 'correction');
  });

  await scenario('duplicate publication: a republished identical sheet announces nothing', async () => {
    const before = pushService.messages.length;
    await publish(3, {organizerCorrections: [{entry: 'x', note: 'organizer notice'}]});
    await dispatch();
    assert.equal(pushService.messages.length, before);
    assert.equal((await notificationOf(3, 3)).status, 'unchanged');
  });

  await scenario('rapid consecutive revisions: one release of the newest revision reaches every device, including correction opt-outs', async () => {
    await publish(4);
    await publish(4, {label: 'Week 4 (corrected once)'});
    await publish(4, {label: 'Week 4 (corrected twice)'});
    await dispatch();
    for (const device of [A, B, C]) assert.deepEqual(weekMessages(device, 4).map(m => [m.payload.kind, m.payload.revision]), [['release', 3]]);
    assert.equal((await notificationOf(4, 1)).status, 'superseded');
    assert.equal((await notificationOf(4, 2)).status, 'superseded');
  });

  // Found on the hosted staging sender: publish -> correct -> identical republish before a cycle superseded the pending
  // release and planned the identical revision as 'unchanged', so nobody heard about the week.
  await scenario('identical republish while the release is still on its way: the newest revision carries it, nobody misses the week', async () => {
    await publish(22);
    await publish(22, {label: 'Week 22 (corrected)'});
    await publish(22, {label: 'Week 22 (corrected)'});
    await dispatch();
    for (const device of [A, B, C]) assert.deepEqual(weekMessages(device, 22).map(m => [m.payload.kind, m.payload.revision]), [['release', 3]]);
    assert.equal((await notificationOf(22, 2)).status, 'superseded');
    assert.equal((await notificationOf(22, 3)).status, 'done');
    const before = pushService.messages.length;
    await publish(22, {label: 'Week 22 (corrected)'});
    await dispatch();
    assert.equal(pushService.messages.length, before, 'an identical republish after delivery still announces nothing');
    assert.equal((await notificationOf(22, 4)).status, 'unchanged');
  });

  await scenario('identical republish while a correction is still on its way: opted-in devices still get the correction', async () => {
    await owner('pause');
    await publish(22, {label: 'Week 22 (corrected again)'});
    await dispatch();
    await publish(22, {label: 'Week 22 (corrected again)'});
    await owner('resume');
    await dispatch();
    for (const device of [A, C]) assert.deepEqual(weekMessages(device, 22).map(m => [m.payload.kind, m.payload.revision]), [['release', 3], ['correction', 6]]);
    assert.deepEqual(weekMessages(B, 22).map(m => [m.payload.kind, m.payload.revision]), [['release', 3]]);
    assert.equal((await notificationOf(22, 5)).status, 'superseded');
    assert.equal((await notificationOf(22, 6)).status, 'done');
  });

  await scenario('failed publications (RLS refusal, constraint violation, stale compare-and-swap) record and send nothing', async () => {
    const before = pushService.messages.length;
    await assert.rejects(asPublisher(`INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at)
      VALUES ($1, 5, 'locked', $2, 1, now())`, [SEASON, weekConfig(5)], '00000000-0000-4000-8000-000000000002'), /row-level security/);
    await assert.rejects(asPublisher(`INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at)
      VALUES ($1, 6, 'locked', $2, 1, now())`, [SEASON, weekConfig(6, {source: {kind: 'weekly-upload'}})]), /check constraint/);
    const stale = await asPublisher("UPDATE public.nfl_pool_weeks SET revision = 99 WHERE season = $1 AND week = 4 AND revision = 1", [SEASON]);
    assert.equal(stale.rowCount, 0);
    await dispatch();
    assert.equal(pushService.messages.length, before);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pool_alerts.publication_events WHERE season = $1 AND week IN (5, 6)', [SEASON])).rows[0].n, 0);
  });

  await scenario('withdrawal before delivery cancels it; republication is announced as the release', async () => {
    await owner('pause');
    await publish(7);
    await dispatch();
    assert.equal((await notificationOf(7, 1)).status, 'verified');
    await withdraw(7);
    await owner('resume');
    await dispatch();
    assert.equal((await notificationOf(7, 1)).status, 'withdrawn');
    for (const device of [A, B, C]) assert.equal(weekMessages(device, 7).length, 0);
    await publish(7);
    await dispatch();
    for (const device of [A, B, C]) assert.deepEqual(weekMessages(device, 7).map(m => [m.payload.kind, m.payload.revision]), [['release', 2]]);
  });

  await scenario('withdrawal after delivery sends nothing; republication is a correction (opt-in only)', async () => {
    await withdraw(7);
    await dispatch();
    await publish(7, {label: 'Week 7 reissued'});
    await dispatch();
    assert.deepEqual(weekMessages(A, 7).map(m => [m.payload.kind, m.payload.revision]), [['release', 2], ['correction', 3]]);
    assert.deepEqual(weekMessages(B, 7).map(m => m.payload.kind), ['release']);
  });

  await scenario('concurrent delivery workers (three dispatches and the hourly trigger at once) deliver exactly once', async () => {
    await publish(8);
    const outcomes = await Promise.all([dispatch(), dispatch(), dispatch(), cron()]);
    assert(outcomes.every(o => o.status === 200), JSON.stringify(outcomes.map(o => o.body)));
    for (const device of [A, B, C]) assert.equal(weekMessages(device, 8).length, 1);
    { const rows8 = await deliveriesFor(8); assert(rows8.every(d => d.state === 'sent' && d.attempts === 1), JSON.stringify(rows8.map(d => [d.kind, d.state, d.attempts, d.last_status, d.last_error]))); }
  });

  await scenario('sender crash before sending: the expired lease is retried and each device gets one alert', async () => {
    await owner('pause');
    await publish(9);
    await dispatch();
    const notification = await notificationOf(9, 1);
    await admin.query('UPDATE pool_alerts.settings SET sending_enabled = true');
    const leased = await store.leaseDeliveries(senderPool, {notificationIds: [Number(notification.id)]});
    assert.equal(leased.rows.length, 3);
    await dispatch();
    for (const device of [A, B, C]) assert.equal(weekMessages(device, 9).length, 0, 'an unexpired lease is never stolen');
    await admin.query("UPDATE pool_alerts.deliveries SET lease_until = now() - interval '1 second' WHERE state = 'sending'");
    await dispatch();
    for (const device of [A, B, C]) assert.equal(weekMessages(device, 9).length, 1);
    assert((await deliveriesFor(9)).every(d => d.state === 'sent' && d.attempts === 2));
  });

  await scenario('sender crash after sending but before recording: at-least-once, the repeat carries the same topic and payload', async () => {
    await owner('pause');
    await publish(10);
    await dispatch();
    await admin.query('UPDATE pool_alerts.settings SET sending_enabled = true');
    const notification = await notificationOf(10, 1);
    const leased = await store.leaseDeliveries(senderPool, {notificationIds: [Number(notification.id)]});
    for (const row of leased.rows) {
      await send({endpoint: row.endpoint, keys: {p256dh: row.p256dh, auth: row.auth}}, {v: 1, kind: row.kind, season: row.season, week: row.week, revision: row.revision},
        {topic: `pool-${row.season}-${row.week}`, urgency: 'high', ttl: 86400});
    }
    await admin.query("UPDATE pool_alerts.deliveries SET lease_until = now() - interval '1 second' WHERE state = 'sending'");
    await dispatch();
    for (const device of [A, B, C]) {
      const repeats = weekMessages(device, 10);
      assert.equal(repeats.length, 2);
      assert.deepEqual(repeats[0].payload, repeats[1].payload);
      assert.equal(repeats[0].topic, repeats[1].topic);
    }
  });

  let D;
  await scenario('expired subscription (410): disabled at once, its queue cancelled, never contacted again', async () => {
    D = await enroll('d', {script: [{status: 410}]});
    await publish(11);
    await dispatch();
    assert.equal((await admin.query('SELECT status, disabled_reason FROM pool_alerts.subscriptions WHERE id = $1', [D.sid])).rows[0].status, 'expired');
    assert.equal(allRequests(D), 1);
    await publish(12);
    await dispatch();
    assert.equal(allRequests(D), 1);
    assert.equal(weekMessages(A, 12).length, 1);
  });

  let E, F;
  await scenario('network failure and server errors: bounded retries, then failure, then owner retry succeeds', async () => {
    E = await enroll('e', {script: [{status: 500}]});
    F = await enroll('f', {script: Array.from({length: 5}, () => ({drop: true}))});
    await publish(13);
    await dispatch();
    let rows = await deliveriesFor(13);
    assert.equal(rows.find(d => d.subscription_id === E.sid).state, 'retry');
    assert.equal(rows.find(d => d.subscription_id === E.sid).last_status, 500);
    assert.equal(rows.find(d => d.subscription_id === F.sid).last_error, 'network');
    for (let i = 0; i < 4; i++) { await fastForward(13); await cron(); }
    rows = await deliveriesFor(13);
    assert.equal(rows.find(d => d.subscription_id === E.sid).state, 'sent');
    const failed = rows.find(d => d.subscription_id === F.sid);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.attempts, 5);
    assert.equal(failed.last_error, 'network-exhausted');
    assert.equal(weekMessages(F, 13).length, 0);
    const retry = await owner('retry-failed');
    assert.equal(retry.body.reset.deliveries, 1);
    assert.equal(weekMessages(F, 13).length, 1);
    assert.equal((await deliveriesFor(13)).find(d => d.subscription_id === F.sid).state, 'sent');
  });

  await scenario('429 with Retry-After: the push service\'s wait is honored (capped at one hour)', async () => {
    const G = await enroll('g', {script: [{status: 429, retryAfter: 900}]});
    await publish(14);
    await dispatch();
    const row = (await admin.query(`SELECT state, extract(epoch FROM next_attempt_at - now())::int AS wait FROM pool_alerts.deliveries d
      JOIN pool_alerts.notifications n ON n.id = d.notification_id WHERE n.week = 14 AND d.subscription_id = $1`, [G.sid])).rows[0];
    assert.equal(row.state, 'retry');
    assert(row.wait > 840 && row.wait <= 900, String(row.wait));
    assert.equal((await call('/v1/unsubscribe', {body: {id: G.sid, token: G.token}})).status, 200);
  });

  await scenario('revocation: turning alerts off removes the device and its queued alert is never sent', async () => {
    await owner('pause');
    await publish(15);
    await dispatch();
    assert.equal((await call('/v1/unsubscribe', {body: {id: E.sid, token: E.token}})).status, 200);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pool_alerts.subscriptions WHERE id = $1', [E.sid])).rows[0].n, 0);
    await owner('resume');
    await dispatch();
    assert.equal(weekMessages(E, 15).length, 0);
    assert.equal(weekMessages(A, 15).length, 1);
    assert.equal((await call('/v1/unsubscribe', {body: {id: E.sid, token: E.token}})).status, 403, 'a removed device cannot be managed');
  });

  await scenario('preference change: turning corrections off cancels a queued correction', async () => {
    await owner('pause');
    await publish(15, {label: 'Week 15 corrected'});
    await dispatch();
    assert.equal((await call('/v1/preferences', {body: {id: C.sid, token: C.token, corrections: false}})).status, 200);
    await owner('resume');
    await dispatch();
    assert.deepEqual(weekMessages(C, 15).map(m => m.payload.kind), ['release']);
    assert.deepEqual(weekMessages(A, 15).map(m => m.payload.kind), ['release', 'correction']);
    assert.equal((await call('/v1/preferences', {body: {id: C.sid, token: C.token, corrections: true}})).status, 200);
  });

  await scenario('public Data API outage: nothing is announced unverified; the next cycle verifies and sends', async () => {
    await publish(16);
    dataApi.outage(true);
    const during = await dispatch();
    assert.equal(during.body.outcome, 'partial');
    assert.equal(weekMessages(A, 16).length, 0);
    assert.equal((await notificationOf(16, 1)).status, 'queued');
    dataApi.outage(false);
    await cron();
    assert.equal(weekMessages(A, 16).length, 1);
  });

  await scenario('capture gap: a publication the trigger missed is reconciled from the public index, reported and sent', async () => {
    await admin.query('ALTER TABLE public.nfl_pool_weeks DISABLE TRIGGER nfl_pool_alerts_capture');
    try { await publish(17); } finally { await admin.query('ALTER TABLE public.nfl_pool_weeks ENABLE TRIGGER nfl_pool_alerts_capture'); }
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pool_alerts.publication_events WHERE season = $1 AND week = 17', [SEASON])).rows[0].n, 0);
    await cron();
    const event = (await admin.query('SELECT source FROM pool_alerts.publication_events WHERE season = $1 AND week = 17', [SEASON])).rows[0];
    assert.equal(event.source, 'reconcile');
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pool_alerts.audit_log WHERE action = 'capture-gap'")).rows[0].n, 1);
    assert.equal(weekMessages(A, 17).length, 1);
    const status = await owner('status', undefined);
    assert.equal(status.status, 405, 'status is a GET');
    const got = await call('/v1/owner/status', {method: 'GET', token: OWNER_TOKEN, origin: null});
    assert.equal(got.body.captureGaps30d.length, 1);
  });

  await scenario('stale alerts: a publication older than the age limit is never announced', async () => {
    await owner('pause');
    await publish(18);
    await admin.query("UPDATE pool_alerts.publication_events SET occurred_at = now() - interval '2 hours' WHERE season = $1 AND week = 18", [SEASON]);
    await admin.query('UPDATE pool_alerts.settings SET max_notification_age_minutes = 60');
    await owner('resume');
    await dispatch();
    assert.equal((await notificationOf(18, 1)).status, 'stale');
    assert.equal(weekMessages(A, 18).length, 0);
    await admin.query('UPDATE pool_alerts.settings SET max_notification_age_minutes = 1440');
  });

  await scenario('postseason week 19 is announced like any other week', async () => {
    await publish(19);
    await dispatch();
    assert.deepEqual(weekMessages(A, 19).map(m => m.payload), [{v: 1, kind: 'release', season: SEASON, week: 19, revision: 1}]);
  });

  await scenario('authentication: dispatch, owner, status and trigger routes refuse forged or missing credentials', async () => {
    assert.equal((await call('/v1/dispatch', {body: {}})).status, 401);
    assert.equal((await call('/v1/dispatch', {body: {}, token: publisherJwt({}, generateKeyPairSync('ed25519').privateKey)})).status, 401);
    assert.equal((await call('/v1/dispatch', {body: {}, token: publisherJwt({email: 'participant@example.com'})})).status, 401);
    assert.equal((await call('/v1/dispatch', {body: {}, token: publisherJwt({exp: Math.floor(Date.now() / 1000) - 5})})).status, 401);
    assert.equal((await call('/v1/owner/pause', {body: {}, token: randomBytes(32).toString('base64url'), origin: null})).status, 401);
    assert.equal((await call('/v1/cron', {origin: null})).status, 401);
    assert.equal((await call('/v1/status', {method: 'GET', token: OWNER_TOKEN, origin: null})).status, 401, 'the owner token is not the status token');
    const status = await call('/v1/status', {method: 'GET', token: STATUS_TOKEN, origin: null});
    assert.equal(status.status, 200);
    const text = JSON.stringify(status.body);
    assert(!/push\/|endpoint|p256dh|token|localhost/.test(text), 'the status report carries no device data');
    assert.equal(status.body.sendingEnabled, true);
    const publisherStatus = await call('/v1/owner/status', {method: 'GET', token: publisherJwt()});
    assert.equal(publisherStatus.status, 200);
  });

  await scenario('controlled test notification to one device', async () => {
    const result = await owner('test', {subscriptionId: B.sid});
    assert.equal(result.body.delivered, true);
    assert.deepEqual(pushService.received(B.id).at(-1).payload, {v: 1, kind: 'test'});
    assert.equal((await owner('test', {subscriptionId: D.sid})).status, 404, 'an expired device is not tested');
  });

  await scenario('device check-in and self-healing after a restore lost the device', async () => {
    assert.deepEqual((await call('/v1/check', {body: {id: B.sid, token: B.token, endpoint: B.subscription.endpoint}})).body, {state: 'active', corrections: false});
    await admin.query('DELETE FROM pool_alerts.subscriptions WHERE id = $1', [B.sid]);
    assert.equal((await call('/v1/check', {body: {id: B.sid, token: B.token}})).body.state, 'unknown');
    const back = await call('/v1/subscribe', {body: {subscription: B.subscription, corrections: false}});
    assert.equal(back.status, 201);
    Object.assign(B, {sid: back.body.id, token: back.body.token});
  });

  await scenario('endpoint rotation (pushsubscriptionchange) keeps the device enrolled on its new endpoint', async () => {
    const rotated = pushService.device('a-rotated');
    const result = await call('/v1/preferences', {body: {id: A.sid, token: A.token, subscription: rotated.subscription}});
    assert.equal(result.body.rotated, true);
    await publish(20);
    await dispatch();
    assert.equal(weekMessages(A, 20).length, 0);
    assert.equal(pushService.received(rotated.id).filter(m => m.payload.week === 20).length, 1);
  });

  await scenario('environment guard: a sender configured for another environment refuses to touch the database', async () => {
    const wrong = await serve(makeApp({environment: 'staging'}));
    try {
      const response = await fetch(`http://127.0.0.1:${wrong.address().port}/v1/check`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: ORIGIN},
        body: JSON.stringify({id: B.sid, token: B.token})});
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'environment-guard');
    } finally { await new Promise(r => wrong.close(r)); }
  });

  await scenario('owner tool: status, pause, notify while paused, resume, notify and test through the deployed API', async () => {
    const env = {POOL_ALERTS_URL: base, POOL_ALERTS_OWNER_TOKEN: OWNER_TOKEN}, out = [];
    const run = async (...argv) => { out.length = 0; assert.equal(await ops(argv, env, line => out.push(line)), 0); return out.join('\n'); };
    assert.match(await run('status'), /Environment: test[\s\S]*Sending: deployment ON, database ON[\s\S]*Recent alerts:/);
    assert.match(await run('pause', 'integration'), /Sending paused/);
    await publish(21);
    assert.match(await run('notify'), /Sending is paused: nothing was sent/);
    assert.equal(weekMessages(A, 21).length, 0);
    assert.match(await run('resume'), /Sending resumed/);
    assert.match(await run('notify'), /Cycle ok: \d+ sent/);
    assert.equal(pushService.received(A.id).concat(pushService.messages.filter(m => m.device.startsWith('a-rotated'))).filter(m => m.payload.week === 21).length, 1);
    assert.match(await run('test', B.sid), /Test alert accepted/);
    assert.match(await run('health'), /"service": "pool-alerts"/);
    await assert.rejects(ops(['status'], {...env, POOL_ALERTS_OWNER_TOKEN: 'w'.repeat(43)}), /HTTP 401/);
  });

  await scenario('every delivery was VAPID-signed with the configured key and decrypted by its device; run history is recorded', async () => {
    assert.deepEqual(pushService.rejections, []);
    assert(pushService.messages.every(m => m.vapidKey === vapid.publicKey));
    for (const m of pushService.messages) assert.deepEqual(Object.keys(m.payload).sort(), m.payload.kind === 'test' ? ['kind', 'v'] : ['kind', 'revision', 'season', 'v', 'week']);
    const runs = (await admin.query('SELECT outcome, count(*)::int AS n FROM pool_alerts.runs GROUP BY outcome')).rows;
    assert(runs.some(r => r.outcome === 'ok') && runs.some(r => r.outcome === 'paused') && runs.some(r => r.outcome === 'partial'), JSON.stringify(runs));
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pool_alerts.runs WHERE finished_at IS NULL")).rows[0].n, 0);
  });

  console.log(`Pool Alerts integration: ${results.length} scenarios passed (${pushService.messages.length} push requests verified and decrypted)`);
} finally {
  await new Promise(r => server.close(r));
  await pushService.close();
  await dataApi.close();
  await senderPool.end();
  await admin.end();
}
