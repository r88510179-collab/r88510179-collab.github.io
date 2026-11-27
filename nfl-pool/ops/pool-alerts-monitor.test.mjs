// Pool Alerts monitor, unit level: no network. Health/status answers, recovery, compute and the one-issue alerting are
// played against stand-ins; the token derivation is the release workflow's own (nfl-pool/push/release-lib.mjs).
import assert from 'node:assert/strict';
import {TARGETS, scheduleGapMs, assess, computeProblem, signature, planIssue, issueBody, checkAll, manageIssue, summary} from './pool-alerts-monitor.mjs';
import {deriveToken} from '../push/release-lib.mjs';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; };
const NOW = Date.parse('2026-11-27T06:21:00Z');
const ago = min => new Date(NOW - min * 60000).toISOString();
const personalProd = TARGETS.find(t => t.app === 'personal' && t.environment === 'production');
const commercialStaging = TARGETS.find(t => t.app === 'commercial' && t.environment === 'staging');
const healthy = {status: 200, data: {environment: 'production', version: 'abc1234', sendingConfigured: true}};
const personalStatus = (extra = {}) => ({status: 200, data: {environment: 'production', sendingEnabled: true, subscriptions: {active: 4}, failures7d: [], oldestOutstandingAt: null,
  captureGaps30d: 0, lastRun: {at: ago(4), outcome: 'ok'}, lastOkRunAt: ago(4), lastCronRunAt: ago(4), eventsWaiting: 0, expiredDevices7d: 0, ...extra}});
const alerts = r => r.problems.filter(p => p.severity === 'alert').map(p => p.code);

await test('targets: both apps, both environments, each sender URL in the Neon Functions shape with its schedule', () => {
  assert.deepEqual(TARGETS.map(t => `${t.app}/${t.environment}`), ['personal/production', 'personal/staging', 'commercial/production', 'commercial/staging']);
  for (const t of TARGETS) assert.match(t.url, /^https:\/\/br-[a-z0-9-]+-poolalerts\.compute\.c-\d+\.us-east-[12]\.aws\.neon\.tech$/);
  assert.equal(scheduleGapMs('17 * * * *'), 3600000);
  assert.equal(scheduleGapMs('13,43 * * * *'), 1800000);
});

await test('healthy, paused before activation, or not deployed yet: nothing needs the owner', () => {
  assert.deepEqual(alerts(assess(personalProd, {health: healthy, status: personalStatus()}, NOW)), []);
  const paused = assess(personalProd, {health: healthy, status: personalStatus({sendingEnabled: false})}, NOW);
  assert.deepEqual(alerts(paused), []);
  assert(paused.problems.some(p => p.code === 'group-sending-paused' && p.severity === 'info'));
  const missing = assess(personalProd, {health: {status: 404, data: null}, status: null}, NOW);
  assert.equal(missing.deployed, false);
  assert.deepEqual(alerts(missing), []);
  const noKey = assess(personalProd, {health: healthy, status: null}, NOW);
  assert.deepEqual(noKey.problems.map(p => p.code), ['status-not-checked']);
});

await test('each failure the brief names is detected and needs the owner', () => {
  const cases = [
    [{health: {status: 503, data: null}}, 'health-unavailable'],
    [{health: {...healthy, data: {...healthy.data, environment: 'staging'}}, status: personalStatus()}, 'environment-changed'],
    [{health: healthy, status: {status: 401, data: null}}, 'status-token-refused'],
    [{health: healthy, status: {status: 503, data: {error: 'environment-guard'}}}, 'status-unavailable'],
    [{health: healthy, status: personalStatus({lastRun: {at: ago(4), outcome: 'error', errorClass: 'database'}})}, 'last-run-failed'],
    [{health: healthy, status: personalStatus({failures7d: [{error: 'auth-403', n: 3}]})}, 'push-key-refused'],
    [{health: healthy, status: personalStatus({lastCronRunAt: ago(200)})}, 'scheduled-run-missed'],
    [{health: healthy, status: personalStatus({eventsWaiting: 2, lastOkRunAt: ago(90)})}, 'publications-waiting'],
    [{health: healthy, status: personalStatus({oldestOutstandingAt: ago(150)})}, 'deliveries-delayed'],
    [{health: healthy, status: personalStatus({expiredDevices7d: 5, subscriptions: {active: 1}})}, 'many-subscriptions-expired']];
  for (const [answers, code] of cases) assert(alerts(assess(personalProd, answers, NOW)).includes(code), code);
  // A few expired subscriptions are normal churn, not an incident.
  assert.deepEqual(alerts(assess(personalProd, {health: healthy, status: personalStatus({expiredDevices7d: 1})}, NOW)), []);
  // Commercial answers use their own field names (lastRuns, problems7d, oldestWaiting, devices).
  const c = assess(commercialStaging, {health: {status: 200, data: {environment: 'staging', sendingConfigured: true}},
    status: {status: 200, data: {environment: 'staging', sendingEnabled: false, devices: {active: 2}, problems7d: {'auth-401': 1}, oldestWaiting: ago(300),
      lastRuns: [{trigger: 'cron', startedAt: ago(30), outcome: 'error'}], lastOkRunAt: ago(400), lastCronRunAt: ago(30), eventsWaiting: 0}}}, NOW);
  assert.deepEqual(alerts(c), [], 'staging never opens the issue');
  assert.deepEqual(c.problems.filter(p => p.severity === 'warn').map(p => p.code).sort(), ['deliveries-delayed', 'last-run-failed', 'push-key-refused'], 'but every problem is shown');
  const commercialProd = TARGETS.find(t => t.app === 'commercial' && t.environment === 'production');
  const cp = assess(commercialProd, {health: {status: 200, data: {environment: 'production', sendingConfigured: true}},
    status: {status: 200, data: {environment: 'production', sendingEnabled: false, devices: {active: 2}, problems7d: {'auth-401': 1}, oldestWaiting: ago(300),
      lastRuns: [{trigger: 'cron', startedAt: ago(30), outcome: 'error'}], lastOkRunAt: ago(400), lastCronRunAt: ago(30), eventsWaiting: 0}}}, NOW);
  assert.deepEqual(alerts(cp).sort(), ['deliveries-delayed', 'last-run-failed', 'push-key-refused'], 'Commercial field names, production: needs the owner');
});

await test('only waiting publications, overdue deliveries or a missed run with work waiting are recoverable', () => {
  const r = assess(personalProd, {health: healthy, status: personalStatus({eventsWaiting: 1, lastOkRunAt: ago(45), lastCronRunAt: ago(200)})}, NOW);
  assert.deepEqual(r.problems.filter(p => p.recover).map(p => p.code).sort(), ['publications-waiting', 'scheduled-run-missed']);
  const missedIdle = assess(personalProd, {health: healthy, status: personalStatus({lastCronRunAt: ago(200)})}, NOW);
  assert.deepEqual(missedIdle.problems.filter(p => p.recover), [], 'nothing waiting: a dispatch would not help, the owner checks the trigger');
});

await test('compute: warned at 75%, an incident at 90% of the Free plan allowance', () => {
  assert.equal(computeProblem(personalProd, {id: 'p', compute_time_seconds: 50 * 3600}, NOW), null);
  assert.equal(computeProblem(personalProd, {id: 'p', compute_time_seconds: 80 * 3600}, NOW).severity, 'warn');
  assert.equal(computeProblem(personalProd, {id: 'p', compute_time_seconds: 95 * 3600}, NOW).code, 'compute-near-limit');
});

await test('one issue per incident: created once, unchanged problems are not repeated, changes update it, recovery closes it', () => {
  const sick = [{app: 'personal', environment: 'production', problems: [{code: 'scheduled-run-missed', severity: 'alert', message: '200 min'}, {code: 'group-sending-paused', severity: 'info'}]}];
  const sig = signature(sick);
  assert.equal(sig, 'personal/production:scheduled-run-missed');
  assert.deepEqual(planIssue(null, sig), {action: 'create'});
  const body = issueBody(sick, sig, NOW);
  assert.match(body, /<!-- signature: personal\/production:scheduled-run-missed -->/);
  assert.deepEqual(planIssue({number: 7, body}, signature([{...sick[0], problems: [{code: 'scheduled-run-missed', severity: 'alert', message: '260 min'}]}])), {action: 'none'}, 'the minutes changed, the incident did not');
  assert.deepEqual(planIssue({number: 7, body}, 'commercial/staging:last-run-failed personal/production:scheduled-run-missed'), {action: 'update'});
  assert.deepEqual(planIssue({number: 7, body}, ''), {action: 'close'});
  assert.deepEqual(planIssue(null, ''), {action: 'none'});
});

// Stand-ins for the senders and the GitHub API.
function senders(answers, seen) {
  return async (url, init = {}) => {
    const u = new URL(url), target = TARGETS.find(t => u.origin === t.url);
    seen.push({target: target ? `${target.app}/${target.environment}` : u.host, path: u.pathname, method: init.method || 'GET', auth: init.headers?.Authorization ?? null});
    const answer = answers(target, u.pathname, init);
    return new Response(answer.data === undefined ? '' : JSON.stringify(answer.data), {status: answer.status});
  };
}
const KEY = Buffer.alloc(32, 5).toString('base64url');

await test('recovery: one dispatch with the owner token, then a fresh read; status uses the status token; without a key only health', async () => {
  const seen = [];
  let dispatched = false;
  const fetcher = senders((target, path) => {
    if (target.app !== 'personal' || target.environment !== 'production') return {status: 404};
    if (path === '/v1/health') return healthy;
    if (path === '/v1/dispatch') { dispatched = true; return {status: 200, data: {outcome: 'ok'}}; }
    return personalStatus(dispatched ? {} : {eventsWaiting: 3, lastOkRunAt: ago(70)});
  }, seen);
  const results = await checkAll({env: {POOL_ALERTS_CONTROL_KEY: KEY}, fetcher, now: () => NOW});
  const prod = results.find(r => r.app === 'personal' && r.environment === 'production');
  assert.deepEqual(alerts(prod), [], 'recovered: nothing for the owner');
  assert.deepEqual(prod.recovery, ['dispatch answered 200 (ok)']);
  const calls = seen.filter(s => s.target === 'personal/production');
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET /v1/health', 'GET /v1/status', 'POST /v1/dispatch', 'GET /v1/health', 'GET /v1/status']);
  assert.equal(calls[1].auth, `Bearer ${deriveToken(KEY, {app: 'personal', environment: 'production', purpose: 'status'})}`);
  assert.equal(calls[2].auth, `Bearer ${deriveToken(KEY, {app: 'personal', environment: 'production', purpose: 'owner'})}`);
  assert.equal(calls[0].auth, null);
  assert(results.filter(r => r !== prod).every(r => r.deployed === false), 'the others are not deployed yet');
  const text = summary(results, {action: 'none'});
  assert(!text.includes(KEY) && !text.includes(calls[2].auth.slice(7)), 'no token in the summary');
  const bare = [];
  await checkAll({env: {}, fetcher: senders(() => healthy, bare), now: () => NOW});
  assert(bare.every(s => s.path === '/v1/health' && s.auth === null), 'no key: health only, no token, no dispatch');
});

await test('GitHub issue: created for a new incident, left alone while unchanged, closed with a comment on recovery', async () => {
  const issues = [], calls = [];
  const github = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    assert.equal(init.headers.Authorization, 'Bearer gh-token');
    // Labels come back as objects; the second run finds the issue by its title even if the label had been dropped.
    if (method === 'GET') return new Response(JSON.stringify(issues.filter(i => i.state === 'open').map(i => ({...i, labels: []}))), {status: 200});
    const body = JSON.parse(init.body);
    if (method === 'POST' && u.pathname.endsWith('/issues')) { issues.push({number: 12, state: 'open', ...body}); return new Response('{}', {status: 201}); }
    if (method === 'PATCH') { Object.assign(issues[0], body); return new Response('{}', {status: 200}); }
    return new Response('{}', {status: 201});
  };
  const env = {GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'gh-token'};
  const sick = [{app: 'personal', environment: 'production', problems: [{code: 'last-run-failed', severity: 'alert', message: 'failed'}]}];
  assert.equal((await manageIssue({results: sick, env, fetcher: github, now: () => NOW})).action, 'create');
  assert.deepEqual(issues[0].labels, ['pool-alerts-monitor']);
  assert.equal((await manageIssue({results: sick, env, fetcher: github, now: () => NOW})).action, 'none');
  const healthyNow = [{app: 'personal', environment: 'production', problems: []}];
  assert.equal((await manageIssue({results: healthyNow, env, fetcher: github, now: () => NOW})).action, 'close');
  assert.equal(issues[0].state, 'closed');
  assert.equal(calls.filter(c => c.startsWith('POST') && c.endsWith('/issues')).length, 1, 'exactly one issue for the incident');
  assert.equal((await manageIssue({results: healthyNow, env, fetcher: github, now: () => NOW})).action, 'none');
  assert.equal((await manageIssue({results: sick, env: {}, fetcher: github})).action, 'skipped', 'outside GitHub Actions nothing is filed');
});

console.log(`Pool Alerts monitor: ${passed} groups passed`);
