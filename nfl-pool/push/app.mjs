// Pool Alerts HTTP surface (Fetch API: Request in, Response out), served by a Neon Function in production.
//
// Public (from the Pool Center sites only; CORS to the configured origins):
//   GET  /v1/config        the VAPID public key and environment; no database access
//   GET  /v1/health        liveness and what this instance last did; no database access
//   POST /v1/subscribe     enroll this device (no account needed; enrollment caps and optional invite mode)
//   POST /v1/preferences   change corrections preference, or rotate the endpoint (device management token)
//   POST /v1/unsubscribe   remove this device and its history (device management token)
//   POST /v1/check         is this device still enrolled? (device management token; at most daily per device)
//   POST /v1/check-request list this device for the owner's device checks for 24 hours (device management token)
//   POST /v1/ack           a device's receipt of a check alert (body {ack, event, repeat}); no credential: the ack value
//                          was readable only by that device (end-to-end encrypted payload)
// Publisher (the Admin page's Neon Auth session JWT) or owner token:
//   POST /v1/dispatch      run a cycle now (called by Admin right after a verified publication or correction)
//   GET  /v1/owner/status  full diagnostics      POST /v1/owner/pause | resume | retry-failed | enrollment | test
//   GET  /v1/owner/devices devices that asked to be checked (24 h)   POST /v1/owner/check  one check alert to one device
//   GET  /v1/owner/checks  recent checks and receipts               POST /v1/owner/check-confirm  the owner's verdict
// Status token (Maintenance Center, read-only):  GET /v1/status
// Neon Function Trigger (X-Neon-Trigger-Invocation-Id, which Neon strips from client requests): POST /v1/cron
import {randomBytes} from 'node:crypto';
import {validatePreferences, validateSubscription, isUuid, isManageToken, notificationPayload, pushOptions, PUSH_SERVICES,
  CHECK_SCENARIOS, checkOutcome, isCheckValue, latestPublished, validatePlatform} from './core.mjs';
import {bearerToken, digestMatches, sha256Hex} from './auth.mjs';
import * as store from './store.mjs';
import {runCycle} from './cycle.mjs';

const MAX_BODY = 8192;
const WRITE_LIMIT_PER_MINUTE = 60;
const RECEIPTS_PER_MINUTE = 240;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}});

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw Object.assign(new Error('content type'), {status: 415});
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) throw Object.assign(new Error('too large'), {status: 413});
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY) throw Object.assign(new Error('too large'), {status: 413});
  let value;
  try { value = JSON.parse(text); } catch { throw Object.assign(new Error('bad json'), {status: 400}); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('bad body'), {status: 400});
  return value;
}

export const BUDGETS = Object.freeze({dispatch: 90000, cron: 240000, owner: 90000});

export function createApp({cfg, pool, reader, send, verifyPublisher, now = () => Date.now(), sleep, services = PUSH_SERVICES, budgets = BUDGETS, log = () => {}}) {
  let identityCheckedAt = 0, lastCycle = null, writes = {window: 0, count: 0}, receipts = {window: 0, count: 0};
  const cors = origin => cfg.origins.includes(origin) ? {
    'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600'} : {Vary: 'Origin'};

  async function guard() {
    if (now() - identityCheckedAt < 10 * 60000) return;
    await store.checkIdentity(pool, cfg);
    identityCheckedAt = now();
  }
  // Best-effort per-instance throttle for the unauthenticated write routes; the database caps are the real limit.
  function throttled() {
    const minute = Math.floor(now() / 60000);
    if (writes.window !== minute) writes = {window: minute, count: 0};
    return ++writes.count > WRITE_LIMIT_PER_MINUTE;
  }
  function receiptsThrottled() {
    const minute = Math.floor(now() / 60000);
    if (receipts.window !== minute) receipts = {window: minute, count: 0};
    return ++receipts.count > RECEIPTS_PER_MINUTE;
  }
  // One owner-run check alert to one device. 'release' and 'repeat' name the most recently published week (an exact
  // repeat must replace the first on the device, not add a second); 'correction' respects the device's choice exactly as
  // the planner does. Never retried; the push service's answer is the result.
  async function sendCheck({subscriptionId, scenario, actor}) {
    if (!cfg.sendingAllowed) return {status: 409, body: {error: 'sending-not-configured'}};
    const device = await store.deviceForTest(pool, subscriptionId);
    if (!device || device.status !== 'active') return {status: 404, body: {error: 'device-not-enrolled'}};
    let week = null;
    if (scenario !== 'test') {
      week = latestPublished(await reader.readIndex());
      if (!week) return {status: 409, body: {error: 'no-published-week'}};
    }
    const ack = randomBytes(16).toString('base64url');
    const identity = week ? {season: week.season, week: week.week, revision: week.revision} : {};
    if (scenario === 'correction' && !device.corrections) {
      const id = await store.startCheck(pool, {subscriptionId, scenario, ...identity, ackSha256: sha256Hex(ack), actor, skipped: 'corrections-off'});
      return {status: 200, body: {check: id, outcome: 'skipped', reason: 'corrections-off'}};
    }
    const kind = scenario === 'test' ? 'test' : scenario === 'correction' ? 'correction' : 'release';
    const id = await store.startCheck(pool, {subscriptionId, scenario, ...identity, ackSha256: sha256Hex(ack), actor});
    let result;
    try {
      result = await send({endpoint: device.endpoint, keys: {p256dh: device.p256dh, auth: device.auth}},
        notificationPayload({kind, ...identity, check: ack}), pushOptions({kind, ...identity}, 60));
    } catch { result = {status: 0}; }
    const outcome = checkOutcome(result.status);
    await store.completeCheck(pool, {id, state: outcome.state, status: result.status, errorClass: outcome.errorClass});
    await store.audit(pool, actor, 'device-check', {check: id, scenario, state: outcome.state, status: result.status});
    return {status: 200, body: {check: id, outcome: outcome.state === 'sent' ? 'accepted' : outcome.state, status: result.status,
      ...(week ? {season: week.season, week: week.week, revision: week.revision} : {})}};
  }
  async function cycle(trigger) {
    await guard();
    const result = await runCycle({pool, cfg, reader, send, trigger, now, ...(sleep ? {sleep} : {}), budgetMs: budgets[trigger] ?? BUDGETS.dispatch});
    lastCycle = {at: new Date(now()).toISOString(), trigger, outcome: result.outcome};
    log(`cycle ${trigger} ${result.outcome} run=${result.runId} attempts=${result.summary.attempts} ${JSON.stringify(result.summary.outcomes)}`);
    return result;
  }
  async function ownerActor(request) {
    const token = bearerToken(request);
    if (!token) return null;
    if (cfg.ownerTokenSha256 && digestMatches(token, cfg.ownerTokenSha256)) return 'owner-token';
    try { if (await verifyPublisher(token)) return 'publisher'; } catch { return null; }
    return null;
  }

  async function handle(request) {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/', origin = request.headers.get('origin');
    const headers = cors(origin);
    if (request.method === 'OPTIONS') return cfg.origins.includes(origin) ? new Response(null, {status: 204, headers}) : json(403, {error: 'origin-not-allowed'});

    if (request.method === 'GET' && path === '/v1/config') {
      return json(200, {publicKey: cfg.vapid.publicKey, environment: cfg.environment, version: cfg.version}, headers);
    }
    if (request.method === 'GET' && path === '/v1/health') {
      return json(200, {service: 'pool-alerts', environment: cfg.environment, version: cfg.version, sendingConfigured: cfg.sendingAllowed,
        ownerTokenConfigured: !!cfg.ownerTokenSha256, statusTokenConfigured: !!cfg.statusTokenSha256, lastCycle}, headers);
    }

    if (request.method === 'POST' && path === '/v1/cron') {
      if (!request.headers.get('x-neon-trigger-invocation-id')) return json(401, {error: 'not-a-trigger-call'});
      const result = await cycle('cron');
      return json(result.outcome === 'error' ? 503 : 200, {outcome: result.outcome, run: result.runId},
        result.outcome === 'error' ? {'Retry-After': '300'} : {});
    }

    if (path === '/v1/dispatch' || path.startsWith('/v1/owner/')) {
      const actor = await ownerActor(request);
      if (!actor) return json(401, {error: 'not-authorized'}, headers);
      await guard();
      if (request.method === 'POST' && path === '/v1/dispatch') {
        const result = await cycle('dispatch');
        return json(200, {outcome: result.outcome, run: result.runId, paused: result.summary.paused,
          sent: result.summary.outcomes.sent || 0, retrying: result.summary.outcomes.retry || 0,
          failed: (result.summary.outcomes.failed || 0) + (result.summary.outcomes.expired || 0)}, headers);
      }
      if (request.method === 'GET' && path === '/v1/owner/status') {
        return json(200, {sendingConfigured: cfg.sendingAllowed, version: cfg.version, lastCycle, ...(await store.status(pool))}, headers);
      }
      if (request.method === 'GET' && path === '/v1/owner/devices') return json(200, {devices: await store.checkCandidates(pool)}, headers);
      if (request.method === 'GET' && path === '/v1/owner/checks') return json(200, {checks: await store.recentChecks(pool)}, headers);
      if (request.method !== 'POST' || ['/v1/owner/status', '/v1/owner/devices', '/v1/owner/checks'].includes(path)) return json(405, {error: 'method-not-allowed'}, headers);
      const body = await readJson(request).catch(e => ({__error: e}));
      if (body.__error) return json(body.__error.status || 400, {error: 'bad-request'}, headers);
      if (path === '/v1/owner/pause') return json(200, {settings: await store.setSending(pool, {enabled: false, actor, note: body.note})}, headers);
      if (path === '/v1/owner/resume') return json(200, {settings: await store.setSending(pool, {enabled: true, actor, note: body.note})}, headers);
      if (path === '/v1/owner/retry-failed') {
        const reset = await store.retryFailed(pool, {actor});
        const result = reset.deliveries ? await cycle('owner') : null;
        return json(200, {reset, outcome: result?.outcome ?? 'nothing-to-retry'}, headers);
      }
      if (path === '/v1/owner/enrollment') {
        try { return json(200, {settings: await store.setEnrollment(pool, {mode: body.mode, inviteCode: body.inviteCode, actor})}, headers); }
        catch (error) { return json(400, {error: error.message}, headers); }
      }
      if (path === '/v1/owner/check') {
        if (!isUuid(body.subscriptionId) || !CHECK_SCENARIOS.includes(body.scenario)) return json(400, {error: 'subscription-id-and-scenario-required'}, headers);
        const result = await sendCheck({subscriptionId: body.subscriptionId, scenario: body.scenario, actor});
        return json(result.status, result.body, headers);
      }
      if (path === '/v1/owner/check-confirm') {
        const checkId = Number(body.checkId);
        if (!Number.isSafeInteger(checkId) || checkId < 1 || !['pass', 'fail'].includes(body.result)) return json(400, {error: 'check-and-result-required'}, headers);
        const confirmed = await store.confirmCheck(pool, {checkId, result: body.result, note: typeof body.note === 'string' ? body.note : null, actor});
        return confirmed ? json(200, {confirmed}, headers) : json(404, {error: 'check-not-found'}, headers);
      }
      if (path === '/v1/owner/test') {
        if (!isUuid(body.subscriptionId)) return json(400, {error: 'subscription-id-required'}, headers);
        const device = await store.deviceForTest(pool, body.subscriptionId);
        if (!device || device.status !== 'active') return json(404, {error: 'device-not-enrolled'}, headers);
        if (!cfg.sendingAllowed) return json(409, {error: 'sending-not-configured'}, headers);
        const result = await send({endpoint: device.endpoint, keys: {p256dh: device.p256dh, auth: device.auth}},
          notificationPayload({kind: 'test'}), pushOptions({kind: 'test'}));
        await store.audit(pool, actor, 'test-send', {subscription: device.id, status: result.status});
        return json(200, {status: result.status, delivered: result.status >= 200 && result.status < 300}, headers);
      }
      return json(404, {error: 'not-found'}, headers);
    }

    if (request.method === 'GET' && path === '/v1/status') {
      const token = bearerToken(request);
      if (!cfg.statusTokenSha256 || !digestMatches(token, cfg.statusTokenSha256)) return json(401, {error: 'not-authorized'});
      await guard();
      const s = await store.status(pool);
      // Read-only, sanitized: counts and states only, never endpoints, tokens or device ids.
      return json(200, {environment: s.environment, version: cfg.version, sendingConfigured: cfg.sendingAllowed,
        sendingEnabled: s.settings.sending_enabled, enrollment: s.settings.enrollment_mode, subscriptions: s.subscriptions,
        deliveries30d: s.deliveries30d, failures7d: s.failures7d, oldestOutstandingAt: s.oldestOutstandingAt,
        captureGaps30d: s.captureGaps30d.length, lastRun: s.runs[0] ? {at: s.runs[0].started_at, trigger: s.runs[0].trigger, outcome: s.runs[0].outcome,
          errorClass: s.runs[0].error_class} : null,
        lastOkRunAt: s.lastOkRunAt, lastCronRunAt: s.lastCronRunAt, eventsWaiting: s.eventsWaiting,
        latestEvent: s.latestEvent ? {season: s.latestEvent.season, week: s.latestEvent.week, revision: s.latestEvent.revision, action: s.latestEvent.action,
          occurredAt: s.latestEvent.occurredAt} : null,
        latency7d: s.latency7d, expiredDevices7d: s.expiredDevices7d, checks7d: s.checks7d,
        lastNotification: s.notifications[0] ? {season: s.notifications[0].season, week: s.notifications[0].week, revision: s.notifications[0].revision,
          status: s.notifications[0].status, sent: s.notifications[0].sent, pending: s.notifications[0].pending, failed: s.notifications[0].failed} : null});
    }

    // A device's receipt of a check alert. Sent by its service worker, from the Pool Center sites only; shape-checked and
    // throttled before the database, and answered the same whether or not the value matched a check.
    if (request.method === 'POST' && path === '/v1/ack') {
      if (!cfg.origins.includes(origin)) return json(403, {error: 'origin-not-allowed'});
      const body = await readJson(request).catch(e => ({__error: e}));
      if (body.__error || !isCheckValue(body.ack) || !['received', 'opened'].includes(body.event) || (body.repeat !== undefined && typeof body.repeat !== 'boolean')) {
        return json(400, {error: 'bad-request'}, headers);
      }
      if (receiptsThrottled()) return json(429, {error: 'try-again-later'}, {...headers, 'Retry-After': '60'});
      await guard();
      await store.ackCheck(pool, {ackSha256: sha256Hex(body.ack), event: body.event, repeat: body.event === 'received' ? body.repeat === true : null});
      return json(200, {ok: true}, headers);
    }

    // Device routes: browsers on the Pool Center sites only.
    if (request.method !== 'POST' || !['/v1/subscribe', '/v1/preferences', '/v1/unsubscribe', '/v1/check', '/v1/check-request'].includes(path)) {
      return json(404, {error: 'not-found'}, headers);
    }
    if (!cfg.origins.includes(origin)) return json(403, {error: 'origin-not-allowed'});
    if (throttled()) return json(429, {error: 'try-again-later'}, {...headers, 'Retry-After': '60'});
    const body = await readJson(request).catch(e => ({__error: e}));
    if (body.__error) return json(body.__error.status || 400, {error: 'bad-request'}, headers);
    await guard();

    if (path === '/v1/subscribe') {
      let subscription, prefs;
      try { subscription = validateSubscription(body.subscription, services); prefs = validatePreferences(body); }
      catch (error) { return json(400, {error: 'invalid-subscription', detail: error.message}, headers); }
      const inviteCode = typeof body.inviteCode === 'string' && body.inviteCode.length <= 128 ? body.inviteCode : null;
      const result = await store.enroll(pool, {subscription, corrections: prefs.corrections, origin, inviteCode, platform: validatePlatform(body.platform)});
      return json(result.status, result.body, headers);
    }
    if (!isUuid(body.id) || !isManageToken(body.token)) return json(403, {error: 'not-authorized'}, headers);
    if (path === '/v1/preferences') {
      let corrections, subscription;
      try {
        corrections = body.corrections === undefined ? undefined : validatePreferences(body).corrections;
        subscription = body.subscription === undefined ? undefined : validateSubscription(body.subscription, services);
      } catch (error) { return json(400, {error: 'invalid-request', detail: error.message}, headers); }
      const result = await store.updateDevice(pool, {id: body.id, token: body.token, corrections, subscription});
      return json(result.status, result.body, headers);
    }
    if (path === '/v1/check-request') {
      const result = await store.requestCheck(pool, {id: body.id, token: body.token, platform: validatePlatform(body.platform)});
      return json(result.status, result.body, headers);
    }
    if (path === '/v1/unsubscribe') {
      const result = await store.removeDevice(pool, {id: body.id, token: body.token});
      return json(result.status, result.body, headers);
    }
    const endpoint = typeof body.endpoint === 'string' && body.endpoint.length <= 2048 ? body.endpoint : null;
    const result = await store.checkDevice(pool, {id: body.id, token: body.token, endpoint});
    return json(result.status, result.body, headers);
  }

  return {
    async fetch(request) {
      try {
        return await handle(request);
      } catch (error) {
        log(`request failed: ${error?.errorClass || error?.code || 'internal'}`);
        const guardFailure = error?.errorClass === 'environment-guard';
        return json(guardFailure ? 503 : 500, {error: guardFailure ? 'environment-guard' : 'internal'}, cors(request.headers.get('origin')));
      }
    },
    get lastCycle() { return lastCycle; }
  };
}
