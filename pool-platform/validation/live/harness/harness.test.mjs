// Focused tests of the harness's own NULL-identity handling, identity classification and JWT-expiry gate, run against
// a scripted Data API on 127.0.0.1: no PostgreSQL, no Neon, no network. The scripted API answers as the reviewed
// contract does (the RLS row rules, auth_required as every RPC's first check) and can inject, per request, a NULL
// identity, a WRONG identity or a leaked row.
//   cd pool-platform/validation/live && npm ci && npm test
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test, {after, beforeEach} from 'node:test';

// ---------- a synthetic world: 2 tenants, 3 pools, commissioners A, B (Tenant A) and C (Tenant B) ----------
const uid = () => crypto.randomUUID();
const KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const U = Object.fromEntries(KEYS.map(k => [k, uid()]));
const TA = uid(), TB = uid();
const PK = 'neighborhood-pickem', SV = 'neighborhood-survivor', PB = 'second-demo-pickem';
const POOLS = {[PK]: {id: uid(), tenant: TA, season: uid()}, [SV]: {id: uid(), tenant: TA, season: uid()}, [PB]: {id: uid(), tenant: TB, season: uid()}};
const WEEKS = Object.entries({[PK]: [1, 2, 3, 4, 5, 7, 12], [SV]: [1, 9], [PB]: [1]})
  .flatMap(([slug, ns]) => ns.map(n => ({id: uid(), slug, week: n, season: POOLS[slug].season})));
const ENTRIES = [
  ['PK-D01', PK, 'D'], ['PK-D02', PK, 'D'], ['PK-D03', PK, 'D'], ['PK-INACTIVE', PK, 'D', 'inactive'], ['PK-LOCK-P', PK, 'D'],
  ['SV-D01', SV, 'D'], ['SV-ELIM', SV, 'D', 'eliminated'], ['PK-E01', PK, 'E'], ['SV-E01', SV, 'E'], ['PK-OPEN', PK, null],
  ['B-01', PB, null], ['B-02', PB, null]
].map(([code, slug, owner, status = 'active']) => ({id: uid(), code, slug, season: POOLS[slug].season, owner: owner && U[owner], status}));
const entry = code => ENTRIES.find(e => e.code === code);
const week = (slug, n) => WEEKS.find(w => w.slug === slug && w.week === n);
const SUBMISSIONS = [['PK-D01', 7], ['PK-E01', 7], ['B-01', 1]].map(([code, n]) => ({id: uid(), entry: entry(code), week: week(entry(code).slug, n)}));
const AUDIT = SUBMISSIONS.map((s, i) => ({id: i + 1, submission: s}));
const INVITES = ['PK-OPEN', 'B-02'].map(code => ({id: uid(), entry: entry(code)}));
const MEMBERSHIPS = [[TA, 'A', 'commissioner'], [TA, 'B', 'co_commissioner'], [TB, 'C', 'commissioner']].map(([tenant, key, role]) => ({tenant, user: U[key], role}));

// The reviewed row rules. A NULL identity (me === null) is nobody: it owns nothing and commissions nothing.
const tenantOf = e => POOLS[e.slug].tenant;
const comm = (me, tenant) => !!me && MEMBERSHIPS.some(m => m.tenant === tenant && m.user === me);
const owns = (me, pred) => !!me && ENTRIES.some(e => e.owner === me && pred(e));
const seasonTenant = season => Object.values(POOLS).find(p => p.season === season).tenant;
const seasonVisible = (me, season) => comm(me, seasonTenant(season)) || owns(me, e => e.season === season);
const ROWS = {
  pool_platform_tenants: me => [TA, TB].filter(t => comm(me, t) || owns(me, e => tenantOf(e) === t)).map(t => ({id: t})),
  pool_platform_memberships: me => MEMBERSHIPS.filter(m => (!!me && m.user === me) || comm(me, m.tenant)).map(m => ({tenant_id: m.tenant, auth_user_id: m.user, role: m.role})),
  pool_platform_pools: me => Object.entries(POOLS).filter(([slug, p]) => comm(me, p.tenant) || owns(me, e => e.slug === slug)).map(([slug, p]) => ({id: p.id, slug, tenant_id: p.tenant})),
  pool_platform_seasons: me => Object.values(POOLS).filter(p => seasonVisible(me, p.season)).map(p => ({id: p.season, pool_id: p.id})),
  pool_platform_entries: me => ENTRIES.filter(e => (!!me && e.owner === me) || comm(me, tenantOf(e))).map(e => ({id: e.id, season_id: e.season, entry_code: e.code, owner_auth_user_id: e.owner})),
  pool_platform_weeks: me => WEEKS.filter(w => seasonVisible(me, w.season)).map(w => ({id: w.id, season_id: w.season, week: w.week})),
  pool_platform_submissions: me => SUBMISSIONS.filter(s => (!!me && s.entry.owner === me) || comm(me, tenantOf(s.entry))).map(s => ({id: s.id, entry_id: s.entry.id, week_id: s.week.id})),
  pool_platform_submission_audit: me => AUDIT.filter(a => comm(me, tenantOf(a.submission.entry))).map(a => ({id: a.id, submission_id: a.submission.id})),
  pool_platform_entry_invites: me => INVITES.filter(i => comm(me, tenantOf(i.entry))).map(i => ({id: i.id, entry_id: i.entry.id}))
};
const raise = message => ({status: 400, body: {code: 'P0001', message, details: null, hint: null}});
const ok = body => ({status: 200, body});
const poolBySlug = slug => POOLS[slug] && {slug, ...POOLS[slug]};
// The reviewed RPCs: auth_required first, then authorization, then the rest.
const RPCS = {
  pool_platform_current_user_id: me => ok(me ?? null),
  pool_platform_is_tenant_commissioner: (me, a) => ok(comm(me, a.p_tenant_id)),
  pool_platform_can_read_pool: (me, a) => ok(ROWS.pool_platform_pools(me).some(p => p.id === a.p_pool_id)),
  pool_platform_can_read_season: (me, a) => ok(ROWS.pool_platform_seasons(me).some(s => s.id === a.p_season_id)),
  pool_platform_submit_entry: (me, a) => {
    if (!me) return raise('auth_required');
    if (!['participant', 'commissioner_import', 'commissioner_manual'].includes(a.p_source)) return raise('invalid_source');
    const e = ENTRIES.find(x => x.id === a.p_entry_id);
    if (a.p_source === 'participant' && e?.owner !== me) return raise('entry_not_owned');
    if (a.p_source !== 'participant' && (!e || !comm(me, tenantOf(e)))) return raise('commissioner_required');
    const w = WEEKS.find(x => x.id === a.p_week_id);
    return !w || w.season !== e.season ? raise('invalid_entry_week') : ok({code: 'created'});
  },
  pool_platform_submit_batch: (me, a) => {
    if (!me) return raise('auth_required');
    if (!['commissioner_import', 'commissioner_manual'].includes(a.p_source)) return raise('commissioner_source_required');
    const w = WEEKS.find(x => x.id === a.p_week_id);
    return !w || !comm(me, seasonTenant(w.season)) ? raise('commissioner_required') : ok([]);
  },
  pool_platform_create_entry_invite: (me, a) => {
    if (!me) return raise('auth_required');
    const e = ENTRIES.find(x => x.id === a.p_entry_id);
    return !e || !comm(me, tenantOf(e)) ? raise('commissioner_required') : ok({invite_token: 'scripted'});
  },
  pool_platform_claim_entry_invite: me => (me ? raise('invite_unavailable') : raise('auth_required')),
  pool_platform_commissioner_context: (me, a) => {
    if (!me) return raise('auth_required');
    const p = poolBySlug(a.p_pool_slug);
    return !p || !comm(me, p.tenant) ? raise('commissioner_required') : ok({pool: {id: p.id, slug: p.slug, tenant_id: p.tenant}, seasons: []});
  },
  pool_platform_participant_context: (me, a) => {
    if (!me) return raise('auth_required');
    const mine = ENTRIES.filter(e => e.slug === a.p_pool_slug && e.owner === me && e.status === 'active');
    return mine.length ? ok({pool: {slug: a.p_pool_slug}, entries: mine.map(e => ({id: e.id, entry_code: e.code})), week: {week: 12}}) : raise('pool_not_found');
  }
};

// ---------- the scripted API ----------
// Tokens are shape-only JWTs minted here; the API accepts exactly those, until exp + skew (then HTTP 400, as live).
const minted = new Set();
let plan = [], log = [], skewS = 0;
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function mint(key, expInS = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const token = `${b64({alg: 'EdDSA', typ: 'JWT'})}.${b64({sub: U[key], id: U[key], role: 'authenticated', iat: now + expInS - 900, exp: now + expInS})}.${crypto.randomBytes(16).toString('base64url')}`;
  minted.add(token);
  return token;
}
// An injection rule changes the next `times` requests it matches: as (the identity that request runs with: null is a
// NULL identity, another user id a WRONG one) and/or transform (the answer).
const inject = (match, times, rule) => plan.push({match, times, ...rule});
const nullFor = (match, times = 1) => inject(match, times, {as: null});
const sent = match => log.filter(match).length;

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const send = ({status, body}) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const url = new URL(req.url, 'http://scripted');
  if (url.pathname.startsWith('/neondb/auth/')) {
    const p = url.pathname.slice('/neondb/auth'.length);
    if (p === '/sign-out') return send(ok({success: true}));
    if (p === '/get-session') return send(ok(null));
    if (p === '/token') return send({status: 401, body: {code: 'UNAUTHORIZED', message: 'Unauthorized'}});
    return send({status: 500, body: {message: `scripted auth: unexpected ${p}`}});
  }
  const p = url.pathname.replace(/^\/neondb\/rest\/v1/, '');
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || null;
  const args = (() => { try { return raw ? JSON.parse(raw) : {}; } catch { return raw; } })();
  const q = {method: req.method, fn: p.startsWith('/rpc/') ? p.slice(5) : null, table: p.startsWith('/rpc/') ? null : p.slice(1), args, at: Date.now()};
  if (token && !minted.has(token)) { log.push({...q, status: 401}); return send({status: 401, body: {code: 'PGRST301', message: 'JWT invalid', details: null, hint: null}}); }
  if (token) {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    Object.assign(q, {sub: claims.sub, exp: claims.exp});
    if (q.at / 1000 > claims.exp + skewS) { log.push({...q, status: 400}); return send({status: 400, body: {code: 'PGRST303', message: 'JWT expired', details: null, hint: null}}); }
  }
  const rule = plan.find(r => r.times > 0 && r.match(q));
  if (rule) rule.times--;
  const me = rule && 'as' in rule ? rule.as : q.sub ?? null;
  let out = !token ? {status: 401, body: {code: '42501', message: 'permission denied', details: null, hint: null}}
    : q.fn && RPCS[q.fn] && req.method === 'POST' ? RPCS[q.fn](me, q.args)
    : q.table && ROWS[q.table] && req.method === 'GET' ? ok(ROWS[q.table](me))
    : {status: 404, body: {code: 'PGRST202', message: 'not in the scripted API', details: null, hint: null}};
  if (rule?.transform) out = rule.transform(out);
  log.push({...q, as: me, injected: !!rule, status: out.status});
  send(out);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-harness-test-'));
Object.assign(process.env, {PP_REHEARSAL: '1', PP_AUTH_URL: `${BASE}/neondb/auth`, PP_DATA_URL: `${BASE}/neondb/rest/v1`, PP_RUN_DIR: RUN_DIR});
const lib = await import('./lib.mjs');
const p1 = await import('./phases1.mjs');
const p3 = await import('./phases3.mjs');
const {IDENTITY} = lib;

after(() => { server.closeAllConnections(); server.close(); fs.rmSync(RUN_DIR, {recursive: true, force: true}); });

beforeEach(() => {
  plan = []; log = []; skewS = 0;
  for (const k of KEYS) lib.secrets.identities[k] = {jwt: mint(k), jar: {}};
  lib.secrets.firstJwts = {};
  Object.assign(lib.state, {
    users: Object.fromEntries(KEYS.map(k => [k, {id: U[k]}])),
    owned: Object.fromEntries(ENTRIES.filter(e => e.owner).map(e => [e.code, KEYS.find(k => U[k] === e.owner)])),
    results: {},
    fixtures: {
      pools: Object.fromEntries(Object.entries(POOLS).map(([slug, p]) => [slug, {id: p.id, tenant_id: p.tenant, pool_type: slug === SV ? 'survivor' : 'pickem'}])),
      seasons: Object.fromEntries(Object.entries(POOLS).map(([slug, p]) => [slug, p.season])),
      weeks: Object.fromEntries(Object.keys(POOLS).map(slug => [slug, Object.fromEntries(WEEKS.filter(w => w.slug === slug).map(w => [w.week, {id: w.id, status: 'open', deadline_at: null}]))])),
      entries: Object.fromEntries(ENTRIES.map(e => [e.code, {id: e.id, slug: e.slug, status: e.status}])),
      tenant: {A: TA, B: TB}
    }
  });
});

// Runs a phase with the real recorder (evidence in RUN_DIR), capturing every record and a STOP.
async function run(phase, ...args) {
  const rec = lib.recorder(`test-${phase.name}`);
  const records = [];
  for (const kind of ['check', 'info', 'reliability', 'stop']) {
    const real = rec[kind];
    rec[kind] = (...a) => {
      records.push(kind === 'stop' ? {kind, severity: a[0], id: a[1], detail: a[3]} : {kind, id: a[0], pass: kind === 'check' ? a[2] : undefined, detail: a[kind === 'check' ? 3 : 2]});
      return real(...a);
    };
  }
  const quiet = console.log;
  console.log = () => {};
  let stop = null;
  try { await phase(rec, ...args); } catch (e) { if (e instanceof lib.StopCondition) stop = e; else throw e; } finally { console.log = quiet; }
  const outcome = id => records.filter(r => r.id === id).map(r => r.kind === 'check' ? (r.pass ? 'PASS' : 'FAIL') : r.kind === 'reliability' ? 'FAIL-RELIABILITY' : r.kind === 'stop' ? `STOP-${r.severity}` : 'INFO');
  return {records, stop, out: rec.out, outcome, detail: id => records.find(r => r.id === id)?.detail};
}
const noFailures = r => assert.deepEqual(r.records.filter(x => x.kind === 'reliability' || x.kind === 'stop' || (x.kind === 'check' && !x.pass)).map(x => x.id), []);

// ---------- classification ----------
const answer = json => ({ok: true, status: 200, json});
const AUTH_REQUIRED = {ok: false, status: 400, code: 'P0001', message: 'auth_required'};
const HTTP_500 = {ok: false, status: 500, code: null, message: 'upstream error'};

test('classifyIdentity: every identity result is exactly one of CORRECT, NULL, WRONG, ERROR', () => {
  const c = r => lib.classifyIdentity(U.D, r);
  assert.equal(c(answer(U.D)), IDENTITY.CORRECT);
  assert.equal(c(answer(null)), IDENTITY.NULL);
  assert.equal(c(AUTH_REQUIRED), IDENTITY.NULL);
  assert.equal(c(answer(U.A)), IDENTITY.WRONG);
  for (const r of [answer(''), answer(42), answer({id: U.D}), answer([U.D]), HTTP_500, {ok: false, status: 401, code: 'PGRST301', message: 'JWT invalid'},
    {ok: false, status: 400, code: 'P0001', message: 'auth_required_elsewhere'}, {ok: true, status: 200}, undefined, null]) {
    assert.equal(c(r), IDENTITY.ERROR, JSON.stringify(r));
  }
  assert.throws(() => lib.classifyIdentity(undefined, answer(U.D)), /expected user id/);
});

test('clientResult gives PlatformClient.rpc() outcomes the Data API result shape', async () => {
  assert.equal(lib.classifyIdentity(U.D, await lib.clientResult(async () => U.D)), IDENTITY.CORRECT);
  assert.equal(lib.classifyIdentity(U.D, await lib.clientResult(async () => null)), IDENTITY.NULL);
  assert.equal(lib.classifyIdentity(U.D, await lib.clientResult(async () => U.A)), IDENTITY.WRONG);
  const thrown = await lib.clientResult(async () => { throw new Error('Commissioner access is required.'); });
  assert.deepEqual(thrown, {via: 'PlatformClient.rpc', ok: false, status: null, json: null, message: 'Commissioner access is required.'});
  assert.equal(lib.classifyIdentity(U.D, thrown), IDENTITY.ERROR);
});

test('retryOnNull: a request runs at most twice, and a second time only after the NULL signal', async () => {
  const script = answers => { let i = 0; const attempt = async () => answers[Math.min(i++, answers.length - 1)]; attempt.count = () => i; return attempt; };
  for (const [answers, runs, retried, nullAgain] of [[[answer(U.D)], 1, false, false], [[HTTP_500], 1, false, false],
    [[AUTH_REQUIRED, answer(U.D)], 2, true, false], [[AUTH_REQUIRED, HTTP_500], 2, true, false], [[AUTH_REQUIRED], 2, true, true]]) {
    const attempt = script(answers);
    const x = await lib.retryOnNull(attempt);
    assert.deepEqual([attempt.count(), x.retried, x.nullAgain], [runs, retried, nullAgain], JSON.stringify(answers));
    assert.equal(x.result, answers[runs - 1] ?? answers.at(-1));
  }
});

test('identityProbe: CORRECT passes, NULL is retried once, NULL twice is RELIABILITY, WRONG stops P0, ERROR fails', async () => {
  const cases = [
    ['correct', [answer(U.D)], 'PASS', 1],
    ['null then correct', [answer(null), answer(U.D)], 'PASS', 2],
    ['auth_required then correct', [AUTH_REQUIRED, answer(U.D)], 'PASS', 2],
    ['null twice', [answer(null), answer(null)], 'FAIL-RELIABILITY', 2],
    ['null then auth_required', [answer(null), AUTH_REQUIRED], 'FAIL-RELIABILITY', 2],
    ['wrong', [answer(U.A)], 'STOP-P0', 1],
    ['null then wrong', [answer(null), answer(U.A)], 'STOP-P0', 2],
    ['error', [HTTP_500], 'FAIL', 1],
    ['null then error', [answer(null), HTTP_500], 'FAIL', 2]
  ];
  for (const [name, answers, expected, attempts] of cases) {
    let i = 0;
    const r = await run(async rec => lib.identityProbe(rec, 'X1', 'probe', U.D, async () => answers[i++]));
    assert.deepEqual([r.outcome('X1'), i], [[expected], attempts], name);
    const d = r.detail('X1');
    assert.equal(d.expected_user_id, U.D, name);
    assert.equal(d.returned_user_id, answers[attempts - 1].ok && typeof answers[attempts - 1].json === 'string' ? answers[attempts - 1].json : null, name);
    assert.equal(d.classification, expected === 'PASS' ? IDENTITY.CORRECT : expected === 'FAIL-RELIABILITY' ? IDENTITY.NULL : expected === 'STOP-P0' ? IDENTITY.WRONG : IDENTITY.ERROR, name);
    assert.equal(typeof d.summary, 'string', name);
    assert.equal(d.attempts, attempts, name);
    assert.equal(d.first_attempt?.classification, attempts === 2 ? IDENTITY.NULL : undefined, name);
  }
  // Informational probes (SO4) never fail on NULL, but a WRONG identity still stops.
  for (const [answers, expected] of [[[answer(null), answer(null)], 'INFO'], [[answer(U.A)], 'STOP-P0']]) {
    let i = 0;
    const r = await run(async rec => lib.identityProbe(rec, 'X2', 'probe', U.D, async () => answers[i++], {informational: true}));
    assert.deepEqual(r.outcome('X2'), [expected]);
  }
});

test('recorder: a RELIABILITY failure is written as FAIL-RELIABILITY and counted in fail and reliability', async () => {
  const r = await run(async rec => { rec.reliability('R1', 'not established', {classification: IDENTITY.NULL}); rec.check('R2', 'fine', true); });
  assert.deepEqual(r.out, {pass: 1, fail: 1, info: 0, reliability: 1});
  const lines = fs.readFileSync(path.join(RUN_DIR, 'evidence.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.section === 'test-' && l.id === 'R1');
  assert.equal(lines.at(-1)?.result, 'FAIL-RELIABILITY');
});

// ---------- identity probes in the phases ----------
const uidProbe = key => q => q.fn === 'pool_platform_current_user_id' && q.sub === U[key];

test('auth: each A-*-uid probe is classified; a NULL is retried once; NULL twice is RELIABILITY; a WRONG identity stops P0', async () => {
  let r = await run(p1.auth);
  noFailures(r);
  for (const k of KEYS) assert.deepEqual(r.outcome(`A-${k}-uid`), ['PASS'], k);
  assert.equal(sent(uidProbe('D')), 1);

  log = [];
  nullFor(uidProbe('D'));
  nullFor(uidProbe('E'), 2);
  r = await run(p1.auth);
  assert.equal(r.stop, null);
  assert.deepEqual(r.outcome('A-D-uid'), ['PASS']);
  assert.equal(r.detail('A-D-uid').first_attempt.classification, IDENTITY.NULL);
  assert.deepEqual(r.outcome('A-E-uid'), ['FAIL-RELIABILITY']);
  assert.equal(sent(uidProbe('D')), 2);
  assert.equal(sent(uidProbe('E')), 2, 'never a third attempt');

  inject(uidProbe('F'), 1, {as: U.A});
  r = await run(p1.auth);
  assert.match(r.stop?.message ?? '', /^P0 test-auth\/A-F-uid: .*WRONG identity/);
  assert.equal(r.detail('A-F-uid').returned_user_id, U.A);
});

test('PlatformClient.rpc() identity probes (K04, H5) are classified and retried once by the harness', async () => {
  const {PlatformClient} = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', '..', '..', 'platform-client.js')).href);
  const pc = new PlatformClient({mode: 'live', authUrl: process.env.PP_AUTH_URL, dataUrl: process.env.PP_DATA_URL});
  const token = mint('D');
  pc.neon = {auth: {getSession: async () => ({data: {session: {token}, user: {id: U.D}}, error: null})}};
  const probe = rec => lib.identityProbe(rec, 'K04', 'PlatformClient.rpc() resolves to D', U.D, () => lib.clientResult(() => pc.rpc('pool_platform_current_user_id')));
  for (const [setup, expected, requests] of [[() => {}, 'PASS', 1], [() => nullFor(uidProbe('D')), 'PASS', 2], [() => nullFor(uidProbe('D'), 2), 'FAIL-RELIABILITY', 2],
    [() => inject(uidProbe('D'), 1, {as: U.E}), 'STOP-P0', 1]]) {
    plan = []; log = [];
    setup();
    const r = await run(probe);
    assert.deepEqual(r.outcome('K04'), [expected]);
    assert.equal(sent(uidProbe('D')), requests);
  }
});

test('surface: the identity returned to D is classified; a WRONG one stops P0', async () => {
  let r = await run(p3.surface);
  assert.equal(r.stop, null);
  assert.equal(r.detail('SF-auth-pool_platform_current_user_id').classification, IDENTITY.CORRECT);
  inject(uidProbe('D'), 1, {as: U.A});
  r = await run(p3.surface);
  assert.match(r.stop?.message ?? '', /^P0 test-surface\/SF-auth-pool_platform_current_user_id:/);
});

test('signout: SO4 stays informational through a NULL identity, but a WRONG identity stops P0', async () => {
  nullFor(uidProbe('F'), 2);
  let r = await run(p3.signout);
  assert.equal(r.stop, null);
  assert.deepEqual(r.outcome('SO4'), ['INFO']);
  assert.equal(r.detail('SO4').classification, IDENTITY.NULL);
  lib.secrets.identities.F = {jwt: mint('F'), jar: {}};
  inject(uidProbe('F'), 1, {as: U.A});
  r = await run(p3.signout);
  assert.match(r.stop?.message ?? '', /^P0 test-signout\/SO4:/);
});

// ---------- JWT expiry gate ----------
const expiredProbe = key => q => q.sub === U[key] && q.exp < q.at / 1000;

test('jwtexpiry: no expired-token assertion before 35 s past exp; exp, probe start and seconds past exp are recorded', async () => {
  assert.equal(p3.JWT_EXPIRY_GATE_S, 35);
  // The API still accepts the token until exp + 32 s (the live endpoint: until about +29 s, rejected by +31 to +33 s).
  // The harness before this corrective probed any token 5 s past exp, so here it probed at +31 s and stopped P0.
  skewS = 32;
  lib.secrets.firstJwts = {A: mint('A', -31)};
  const r = await run(p3.jwtexpiry);
  noFailures(r);
  assert.deepEqual(r.outcome('JX-A'), ['PASS']);
  const probeReq = log.find(expiredProbe('A'));
  assert.ok(probeReq.at / 1000 - probeReq.exp >= 35, `probed ${probeReq.at / 1000 - probeReq.exp}s past exp`);
  assert.equal(probeReq.status, 400);
  const {timing} = r.detail('JX-A');
  assert.equal(timing.exp, probeReq.exp);
  assert.ok(timing.seconds_past_exp >= 35 && timing.seconds_past_exp < 37, JSON.stringify(timing));
  assert.ok(Date.parse(timing.probe_start) <= probeReq.at, 'probe start is captured before the request');
  assert.ok(timing.waited_ms >= 2500 && timing.waited_ms <= 5000, JSON.stringify(timing));
  assert.deepEqual(r.outcome('JX-A-fresh'), ['PASS']);
});

test('jwtexpiry: an expired JWT accepted past the gate is still a P0 stop', async () => {
  skewS = 1e9;
  lib.secrets.firstJwts = {A: mint('A', -40)};
  const r = await run(p3.jwtexpiry);
  assert.match(r.stop?.message ?? '', /^P0 test-jwtexpiry\/JX-A: expired JWT accepted/);
  const d = r.detail('JX-A');
  assert.ok(d.timing.seconds_past_exp >= 40 && d.timing.waited_ms === 0, JSON.stringify(d.timing));
  assert.equal(d.identity, IDENTITY.CORRECT);
});

test('jwtexpiry: a JWT not yet expired is not asserted; the fresh-JWT follow-up retries a NULL identity once', async () => {
  lib.secrets.firstJwts = {A: mint('A', 600)};
  let r = await run(p3.jwtexpiry);
  assert.deepEqual(r.records.map(x => `${x.kind}:${x.id}`), ['info:JX-gate', 'info:JX']);
  assert.equal(sent(q => q.sub === U.A), 0);

  lib.secrets.firstJwts = {B: mint('B', -40)};
  nullFor(uidProbe('B'));
  r = await run(p3.jwtexpiry);
  assert.deepEqual([r.outcome('JX-B'), r.outcome('JX-B-fresh')], [['PASS'], ['PASS']]);
  assert.equal(r.detail('JX-B-fresh').attempts, 2);
});

// ---------- authorization order ----------
const submitBy = (key, pred) => q => q.fn === 'pool_platform_submit_entry' && q.sub === U[key] && pred(q.args);
// AO1's first probe: F, participant, the malformed [] payload.
const AO1_FIRST = submitBy('F', a => a.p_source === 'participant' && Array.isArray(a.p_payload) && !a.p_payload.length);
// An AO2-only probe: F, participant, D's PK-D03 with the other season's week 9.
const AO2_PROBE = submitBy('F', a => a.p_source === 'participant' && a.p_entry_id === entry('PK-D03').id && a.p_week_id === week(SV, 9).id);

test('authorder: clean run; auth_required is retried once and is never an authorization-order finding', async () => {
  let r = await run(p3.authorder);
  noFailures(r);
  for (const id of ['AO1', 'AO2', 'AO10', 'AO3', 'AO4', 'AO5', 'AO6', 'AO7', 'AO8', 'AO9']) assert.deepEqual(r.outcome(id), ['PASS'], id);

  // Once: the probe runs a second time and AO1 still passes, with the NULL recorded.
  log = [];
  nullFor(AO1_FIRST);
  r = await run(p3.authorder);
  noFailures(r);
  assert.equal(sent(AO1_FIRST), 2);
  assert.deepEqual(r.outcome('AO-F-1-null'), ['INFO']);
  assert.equal(r.detail('AO-F-1-null').classification, IDENTITY.NULL);

  // Twice: the harness before this corrective stopped P1 (AO1) and P2 (AO2) here. Now each is a RELIABILITY failure.
  log = [];
  nullFor(AO1_FIRST, 2);
  nullFor(AO2_PROBE, 2);
  nullFor(submitBy('D', a => a.p_entry_id === entry('PK-D03').id && a.p_week_id === week(SV, 9).id), 2);
  nullFor(q => q.fn === 'pool_platform_commissioner_context' && q.sub === U.F && q.args.p_pool_slug === PK, 2);
  r = await run(p3.authorder);
  assert.equal(r.stop, null);
  for (const id of ['AO1', 'AO2', 'AO10', 'AO3']) assert.deepEqual(r.outcome(id), ['FAIL-RELIABILITY'], id);
  for (const id of ['AO4', 'AO5', 'AO6', 'AO7', 'AO8', 'AO9']) assert.deepEqual(r.outcome(id), ['PASS'], id);
  assert.equal(sent(AO1_FIRST), 2, 'never a third attempt');
  assert.equal(sent(AO2_PROBE), 2, 'never a third attempt');
  assert.match(r.detail('AO1').summary, /^1 probe\(s\) .* AO-F-1$/);
});

test('authorder: real authorization-order leaks still stop P1 / P2, also when the leak comes on the retry', async () => {
  const leak = code => ({transform: () => raise(code)});
  inject(AO1_FIRST, 1, leak('invalid_payload'));
  let r = await run(p3.authorder);
  assert.match(r.stop?.message ?? '', /^P1 test-authorder\/AO-F-1: authorization-order leak/);

  plan = [];
  nullFor(AO1_FIRST);
  inject(AO1_FIRST, 1, leak('invalid_payload'));
  r = await run(p3.authorder);
  assert.match(r.stop?.message ?? '', /^P1 test-authorder\/AO-F-1: authorization-order leak/);

  plan = [];
  inject(AO2_PROBE, 1, leak('invalid_entry_week'));
  r = await run(p3.authorder);
  assert.match(r.stop?.message ?? '', /^P2 test-authorder\/AO2-F-\d+: entry\/week disclosure/);

  // A real mismatch beside a NULL is an ordinary failure, not RELIABILITY.
  plan = [];
  nullFor(submitBy('D', a => a.p_entry_id === entry('PK-D03').id && a.p_week_id === week(SV, 9).id), 2);
  inject(submitBy('A', a => a.p_entry_id === entry('PK-D03').id && a.p_week_id === week(SV, 9).id), 1, leak('commissioner_required'));
  r = await run(p3.authorder);
  assert.deepEqual(r.outcome('AO10'), ['FAIL']);
});

// ---------- isolation ----------
const read = (key, table) => q => q.method === 'GET' && q.table === table && q.sub === U[key];

test('isolation: clean run, every identity sees exactly its view', async () => {
  const r = await run(p3.isolation);
  noFailures(r);
  for (const k of KEYS) assert.deepEqual(r.outcome(`ISO-${k}`), ['PASS'], k);
  assert.equal(r.records.filter(x => x.kind === 'info').length, 0);
});

test('isolation: a read left empty by NULL identity is read once more and never becomes a false P0', async () => {
  // D's entries empty once: the harness before this corrective stopped P0 ("seasons without an owned entry").
  nullFor(read('D', 'pool_platform_entries'));
  let r = await run(p3.isolation);
  noFailures(r);
  assert.deepEqual(r.outcome('ISO-D-pool_platform_entries-null'), ['INFO']);
  assert.equal(sent(read('D', 'pool_platform_entries')), 2);

  // Twice: ISO-D is a RELIABILITY failure; no stop, no third read.
  log = [];
  nullFor(read('D', 'pool_platform_entries'), 2);
  r = await run(p3.isolation);
  assert.equal(r.stop, null);
  assert.deepEqual(r.outcome('ISO-D'), ['FAIL-RELIABILITY']);
  assert.match(r.detail('ISO-D').summary, /entries=0/);
  assert.equal(sent(read('D', 'pool_platform_entries')), 2);
  for (const k of ['A', 'B', 'C', 'E', 'F', 'G']) assert.deepEqual(r.outcome(`ISO-${k}`), ['PASS'], k);

  // A's submissions empty beside its audit rows: before, a P0 ("audit rows of submissions outside its view").
  for (const times of [1, 2]) {
    plan = [];
    nullFor(read('A', 'pool_platform_submissions'), times);
    r = await run(p3.isolation);
    assert.equal(r.stop, null);
    assert.deepEqual(r.outcome('ISO-A'), [times === 1 ? 'PASS' : 'FAIL-RELIABILITY']);
  }

  // A participant's seasons and pools reads, and a commissioner's tenant read.
  plan = [];
  nullFor(read('E', 'pool_platform_seasons'), 2);
  nullFor(read('D', 'pool_platform_pools'));
  nullFor(read('C', 'pool_platform_tenants'), 2);
  r = await run(p3.isolation);
  assert.equal(r.stop, null);
  assert.deepEqual([r.outcome('ISO-E'), r.outcome('ISO-D'), r.outcome('ISO-C')], [['FAIL-RELIABILITY'], ['PASS'], ['FAIL-RELIABILITY']]);
});

test('isolation: real leaks still stop P0, also beside a read left empty by NULL identity, and under a WRONG identity', async () => {
  const foreignSubmission = {id: uid(), entry_id: entry('B-01').id, week_id: week(PB, 1).id};
  const addRow = row => ({transform: out => ({...out, body: [...out.body, row]})});
  inject(read('D', 'pool_platform_submissions'), 1, addRow(foreignSubmission));
  let r = await run(p3.isolation);
  assert.match(r.stop?.message ?? '', /^P0 test-isolation\/ISO-D-leak: D: submissions of entries it does not own/);

  plan = [];
  nullFor(read('D', 'pool_platform_entries'), 2);
  inject(read('D', 'pool_platform_submissions'), 1, addRow(foreignSubmission));
  r = await run(p3.isolation);
  assert.match(r.stop?.message ?? '', /^P0 test-isolation\/ISO-D-leak/);

  plan = [];
  inject(read('D', 'pool_platform_seasons'), 1, addRow({id: POOLS[PB].season, pool_id: POOLS[PB].id}));
  r = await run(p3.isolation);
  assert.match(r.stop?.message ?? '', /^P0 test-isolation\/ISO-D-leak: D: seasons without an owned entry/);

  plan = [];
  inject(read('A', 'pool_platform_submission_audit'), 1, addRow({id: 99, submission_id: SUBMISSIONS.find(s => s.entry.code === 'B-01').id}));
  r = await run(p3.isolation);
  assert.match(r.stop?.message ?? '', /^P0 test-isolation\/ISO-A-leak: A: audit rows of submissions outside its view/);

  plan = [];
  inject(q => q.method === 'GET' && q.sub === U.D, 9, {as: U.A});
  r = await run(p3.isolation);
  assert.match(r.stop?.message ?? '', /^P0 test-isolation\/ISO-D-leak/);
});

test('isolation: context RPCs retry auth_required once; NULL twice is RELIABILITY, never INFO', async () => {
  const pctx = (key, slug) => q => q.fn === 'pool_platform_participant_context' && q.sub === U[key] && q.args.p_pool_slug === slug;
  nullFor(pctx('D', PK));
  nullFor(pctx('E', SV), 2);
  nullFor(pctx('F', PB), 2);
  nullFor(q => q.fn === 'pool_platform_commissioner_context' && q.sub === U.B, 2);
  const r = await run(p3.isolation);
  assert.equal(r.stop, null);
  assert.deepEqual(r.outcome(`ISO-pctx-D-${PK}`), ['PASS']);
  assert.deepEqual(r.outcome(`ISO-pctx-D-${PK}-null`), ['INFO']);
  assert.deepEqual(r.outcome(`ISO-pctx-E-${SV}`), ['FAIL-RELIABILITY']);
  assert.deepEqual(r.outcome(`ISO-out-F-${PB}`), ['FAIL-RELIABILITY']);
  assert.deepEqual(r.outcome('ISO-ctx3'), ['FAIL-RELIABILITY']);
  assert.equal(sent(pctx('E', SV)), 2);
});
