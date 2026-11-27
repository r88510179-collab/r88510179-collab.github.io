// Pool Alerts release automation end to end on a disposable PostgreSQL (run by test-integration.sh): the real
// release.mjs against three production-shaped databases copied before migration 006, a Neon API stand-in (projects,
// branches, endpoints, connection URIs, functions, deployments with Neon's merge semantics, triggers), an emulation of
// Neon's SQL-over-HTTP endpoint (one statement per query, a batch is one transaction, raw text values), and the real
// sender served locally from whatever environment the release deployed. The sender role must authenticate with SCRAM
// on these databases (pg_hba, test-integration.sh), so the password Neon's reset_password stand-in sets (as Neon does)
// is really what the deployed sender authenticates with.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {run, ownerSql} from './release.mjs';
import {loadManifest, splitSqlScript, fingerprintQuery, randomPassword, deriveToken, fingerprintGuard, withGuard, GUARD_MESSAGE} from './release-lib.mjs';
import {createApp} from './app.mjs';
import {serve} from './main.mjs';

const admin = process.env.PUSH_IT_RELEASE_ADMIN;
if (!admin || !['127.0.0.1', 'localhost'].includes(new URL(admin).hostname)) throw new Error('A disposable local cluster is required (run test-integration.sh)');
const port = new URL(admin).port;
const url = (database, user = 'nfl_pool_owner', password) => `postgresql://${user}${password ? `:${encodeURIComponent(password)}` : ''}@127.0.0.1:${port}/${database}`;
const {manifest} = loadManifest();
const fingerprintOf = async database => {
  const c = new pg.Client({connectionString: url(database, 'postgres')});
  await c.connect();
  try { return String((await c.query(fingerprintQuery())).rows[0].schema).slice('schema_sha256='.length); } finally { await c.end(); }
};
const results = [];
const scenario = async (name, fn) => { await fn(); results.push(name); console.log(`ok - ${name}`); };
const migrationText = id => readFileSync(new URL(`../../${manifest.migrations.find(m => m.id === id).file}`, import.meta.url), 'utf8');
// Neon's SQL-over-HTTP endpoint, emulated: the database named by the Neon-Connection-String header, one statement per
// query (a multi-statement query is refused, as a prepared statement is), a batch is one transaction, raw text values.
const sqlOverHttpOn = async (connectionString, body) => {
  const c = new pg.Client({connectionString, types: {getTypeParser: () => value => value}});
  await c.connect();
  const shape = r => ({fields: r.fields.map(f => ({name: f.name})), rows: r.rows});
  try {
    if (body.queries) {
      await c.query('BEGIN');
      try { const results = []; for (const q of body.queries) results.push(shape(await c.query({text: q.query, values: q.params, rowMode: 'array'}))); await c.query('COMMIT'); return {status: 200, body: {results}}; }
      catch (e) { await c.query('ROLLBACK'); return {status: 400, body: {message: e.message, code: e.code}}; }
    }
    if (/;\s*\S/.test(body.query.replace(/'[^']*'|\$(\w*)\$[\s\S]*?\$\1\$/g, ''))) return {status: 400, body: {message: 'cannot insert multiple commands into a prepared statement', code: '42601'}};
    try { return {status: 200, body: shape(await c.query({text: body.query, values: body.params, rowMode: 'array'}))}; }
    catch (e) { return {status: 400, body: {message: e.message, code: e.code}}; }
  } finally { await c.end(); }
};
const httpOnly = async (input, init = {}) => {
  if (new URL(input).pathname !== '/sql') throw new Error(`unexpected request ${input}`);
  const r = await sqlOverHttpOn(init.headers['Neon-Connection-String'], JSON.parse(init.body));
  return new Response(JSON.stringify(r.body), {status: r.status});
};
const senderRoles = async () => {
  const c = new pg.Client({connectionString: url('postgres', 'postgres')});
  await c.connect();
  try { return Number((await c.query("SELECT count(*) FROM pg_roles WHERE rolname = 'pool_alerts_sender'")).rows[0].count); } finally { await c.end(); }
};

await scenario('verify before commit: a migration that would not end as the reviewed catalog commits nothing, over TCP and as an HTTP batch', async () => {
  for (const [database, transport] of [['nfl_pool_release_a', 'tcp'], ['nfl_pool_release_b', 'http']]) {
    assert.equal(await fingerprintOf(database), manifest.fingerprintBefore);
    const sql = await ownerSql({uri: url(database), transport, fetcher: httpOnly});
    try {
      await assert.rejects(sql.script(withGuard(migrationText('006'), fingerprintGuard('0'.repeat(64)))),
        error => error.message.includes(GUARD_MESSAGE) && error.message.includes(manifest.migrations[0].fingerprintAfter), `${transport}: the guard names what the catalog would have been`);
      assert.equal(await fingerprintOf(database), manifest.fingerprintBefore, `${transport}: nothing was committed`);
      assert.equal((await sql.query("SELECT to_regnamespace('pool_alerts') IS NULL AS absent"))[0].absent, transport === 'tcp' ? true : 't', `${transport}: the connection still answers`);
      assert.equal(await senderRoles(), 0, `${transport}: even the role the migration creates was rolled back`);
    } finally { await sql.close(); }
  }
});

await scenario('the whole file over TCP and its statements as one HTTP batch give exactly the reviewed catalog; a second run is refused and changes nothing', async () => {
  assert.equal(await fingerprintOf('nfl_pool_release_a'), manifest.fingerprintBefore, 'a fresh copy is the reviewed starting point');
  const a = new pg.Client({connectionString: url('nfl_pool_release_a')}), b = new pg.Client({connectionString: url('nfl_pool_release_b')});
  await a.connect(); await b.connect();
  try {
    for (const m of manifest.migrations) {
      await a.query(migrationText(m.id));
      await b.query('BEGIN');
      for (const statement of splitSqlScript(migrationText(m.id))) await b.query(statement);
      await b.query('COMMIT');
      assert.equal(await fingerprintOf('nfl_pool_release_a'), m.fingerprintAfter, `${m.id} over TCP`);
      assert.equal(await fingerprintOf('nfl_pool_release_b'), m.fingerprintAfter, `${m.id} as a batch`);
    }
    await b.query('BEGIN');
    await assert.rejects((async () => { for (const statement of splitSqlScript(migrationText('007'))) await b.query(statement); })(), /already applied/);
    await b.query('ROLLBACK');
    assert.equal(await fingerprintOf('nfl_pool_release_b'), manifest.migrations[1].fingerprintAfter);
  } finally { await a.end(); await b.end(); }
});

// The comparison copies are done: drop them and the role they created, so the rehearsal below starts from exactly the
// state production is in before this release (the role is cluster-wide).
{
  const c = new pg.Client({connectionString: url('postgres', 'postgres')});
  await c.connect();
  try {
    for (const d of ['nfl_pool_release_a', 'nfl_pool_release_b']) await c.query(`DROP DATABASE ${d} WITH (FORCE)`);
    await c.query('DROP ROLE pool_alerts_sender');
  } finally { await c.end(); }
}

// ---------------------------------------------------------------------------------------------------------- stand-ins
const DB = 'nfl_pool_release_c', head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
let current = null;
const proxy = {fetch: request => (current ? current.fetch(request) : new Response('{"error":"not deployed"}', {status: 503}))};
const senderServer = await serve(proxy);
const senderUrl = `http://127.0.0.1:${senderServer.address().port}`;
const senderPools = [];
function deployLocally(env) {
  const pool = new pg.Pool({connectionString: env.POOL_ALERTS_DATABASE_URL, max: 3});
  pool.on('error', () => {});
  senderPools.push(pool);
  current = createApp({cfg: Object.freeze({environment: env.POOL_ALERTS_ENV, database: DB, origins: env.APP_ORIGINS.split(','), publisherEmail: env.PUBLISHER_EMAIL,
    vapid: {publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT}, sendingAllowed: env.POOL_ALERTS_SENDING === 'enabled',
    ownerTokenSha256: env.OWNER_TOKEN_SHA256, statusTokenSha256: env.STATUS_TOKEN_SHA256, version: env.POOL_ALERTS_VERSION}),
  pool, send: async () => ({status: 201}), reader: {readIndex: async () => [], readWeek: async () => null}, verifyPublisher: async () => false});
}
const target = Object.freeze({
  app: 'personal', environment: 'staging',
  database: {projectId: 'rehearsal-project', projectName: 'rehearsal', branchId: 'br-rehearsal-main', database: DB, ownerRole: 'nfl_pool_owner',
    endpointId: 'ep-rehearsal', host: `127.0.0.1:${port}`, publicTables: null, sslmode: 'disable'},
  sender: {projectId: 'rehearsal-project', projectName: 'rehearsal', branchId: 'br-rehearsal-main', slug: 'poolalerts', url: senderUrl, sameProjectAsDatabase: true},
  env: {NEON_DATA_URL: 'https://ep-rehearsal.apirest.example.invalid/nfl_pool/rest/v1', NEON_AUTH_URL: 'https://ep-rehearsal.neonauth.example.invalid/nfl_pool/auth',
    APP_ORIGINS: 'https://rehearsal.example.invalid', PUBLISHER_EMAIL: 'publisher@example.invalid', VAPID_SUBJECT: 'mailto:alerts@example.invalid'},
  trigger: {name: 'pool-alerts-hourly', cron: '17 * * * *', path: '/v1/cron'}, apps: [], backupPrefix: 'backup-before-pool-alerts'
});
const state = {deployments: [], env: null, triggers: [], branches: [{id: 'br-rehearsal-main', name: 'main', parent_id: null, current_state: 'ready', created_at: '2026-09-14T00:00:00Z'}], calls: []};
async function fetcher(input, init = {}) {
  const u = new URL(input), method = init.method || 'GET';
  if (u.origin === senderUrl) return fetch(input, init);
  if (u.pathname === '/sql') { const r = await sqlOverHttpOn(url(DB), JSON.parse(init.body)); return new Response(JSON.stringify(r.body), {status: r.status}); }
  const path = u.pathname.replace('/api/v2', '');
  state.calls.push(`${method} ${path}`);
  const ok = body => new Response(JSON.stringify(body), {status: 200});
  const base = `/projects/rehearsal-project`;
  if (method === 'GET' && path === base) return ok({project: {id: 'rehearsal-project', name: 'rehearsal', compute_time_seconds: 3600 * 12, quota_reset_at: '2026-12-01T00:00:00Z'}});
  if (method === 'GET' && path === `${base}/branches`) return ok({branches: state.branches});
  if (method === 'POST' && path === `${base}/branches`) {
    const body = JSON.parse(init.body), branch = {id: `br-backup-${state.branches.length}`, name: body.branch.name, parent_id: body.branch.parent_id, current_state: 'ready', created_at: new Date().toISOString(), parent_lsn: '0/1'};
    state.branches.push(branch);
    return ok({branch, operations: []});
  }
  const branchMatch = /^\/projects\/rehearsal-project\/branches\/([^/]+)$/.exec(path);
  if (method === 'GET' && branchMatch) return ok({branch: state.branches.find(b => b.id === branchMatch[1])});
  if (method === 'GET' && path === `${base}/branches/br-rehearsal-main/endpoints`) return ok({endpoints: [{id: 'ep-rehearsal', host: `127.0.0.1:${port}`, type: 'read_write'}]});
  if (method === 'GET' && path === `${base}/branches/br-rehearsal-main/databases`) return ok({databases: [{name: DB, owner_name: 'nfl_pool_owner'}]});
  if (method === 'GET' && path === `${base}/branches/br-rehearsal-main/roles`) return ok({roles: [{name: 'nfl_pool_owner'}]});
  if (method === 'GET' && path === `${base}/connection_uri`) return ok({uri: url(DB)});
  if (method === 'POST' && path === `${base}/branches/br-rehearsal-main/roles/pool_alerts_sender/reset_password`) {
    // As Neon does: a new password generated server-side, applied to the role, returned once; refused (422) for a role
    // that has never had a password, as a role created by migration 006 is.
    const password = randomPassword(), c = new pg.Client({connectionString: url('postgres', 'postgres')});
    await c.connect();
    try {
      const has = (await c.query("SELECT rolpassword IS NOT NULL AS has FROM pg_authid WHERE rolname = 'pool_alerts_sender'")).rows[0]?.has;
      if (!has) { state.refusals = (state.refusals || 0) + 1; return new Response(JSON.stringify({message: 'cannot update password for role without password'}), {status: 422}); }
      await c.query(`ALTER ROLE pool_alerts_sender PASSWORD '${password}'`);
    } finally { await c.end(); }
    state.resets = (state.resets || 0) + 1;
    return ok({role: {name: 'pool_alerts_sender', password}, operations: []});
  }
  const fnPath = `${base}/branches/br-rehearsal-main/functions/poolalerts`;
  if (method === 'GET' && path === fnPath) return state.env ? ok({function: {invocation_url: `${senderUrl}/`, current_deployment: {id: state.deployments.length, status: 'completed', environment: Object.keys(state.env).sort()}}})
    : new Response('{"message":"not found"}', {status: 404});
  if (method === 'POST' && path === `${fnPath}/deployments`) {
    const form = await new Response(init.body).formData();
    const environment = JSON.parse(form.get('environment'));
    // Neon merges variables with the previous deployment; an empty value is kept as empty.
    state.env = {...(state.env || {}), ...environment};
    state.deployments.push({zip: form.get('zip') ? Buffer.from(await form.get('zip').arrayBuffer()).length : 0, variables: Object.keys(environment).sort()});
    deployLocally(state.env);
    return ok({deployment: {id: state.deployments.length}});
  }
  if (method === 'GET' && path === `${base}/branches/br-rehearsal-main/triggers`) return ok({triggers: state.triggers});
  if (method === 'POST' && path === `${base}/branches/br-rehearsal-main/triggers`) {
    const body = JSON.parse(init.body);
    state.triggers.push({...body, trigger_id: `trig-${state.triggers.length + 1}`, inherited: false, next_run_at: '2026-11-27T04:17:00Z'});
    return ok({trigger: state.triggers.at(-1)});
  }
  const trig = /\/triggers\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && trig) { const t = state.triggers.find(x => x.trigger_id === trig[1]); Object.assign(t, JSON.parse(init.body)); return ok({trigger: t}); }
  return new Response(JSON.stringify({message: `unexpected ${method} ${path}`}), {status: 500});
}
const CONTROL = Buffer.alloc(32, 9).toString('base64url');
const env = {NEON_API_KEY: 'rehearsal-neon-key-not-real', POOL_ALERTS_CONTROL_KEY: CONTROL};
const evidenceDir = mkdtempSync(join(tmpdir(), 'release-spec-'));
const bundle = new URL('./dist/poolalerts.zip', import.meta.url).pathname;
const release = (...argv) => run([...argv, '--evidence', evidenceDir], {env, fetcher, targets: {staging: target}, print: () => {}, wait: ms => new Promise(r => setTimeout(r, Math.min(ms, 20)))});
const names = evidence => evidence.steps.map(s => `${s.status}:${s.name}`);

try {
  await scenario('preflight on a database before 006: identity, nothing installed, no sender; read-only', async () => {
    const evidence = await release('preflight', '--target', 'staging', '--sql', 'http');
    assert.equal(evidence.ok, true, JSON.stringify(evidence.steps));
    assert.deepEqual([evidence.database.migrationState, evidence.database.pending, evidence.sender.deployed], ['none', ['006', '007'], false]);
    assert(state.calls.every(c => c.startsWith('GET ')), 'preflight only reads');
    assert.equal(await fingerprintOf(DB), manifest.fingerprintBefore);
  });

  await scenario('stage over HTTP: backup, 006 and 007 verified by fingerprint, marker, Neon-generated password, exact bundle, health, baseline, trigger; group sending stays off', async () => {
    const evidence = await release('stage', '--target', 'staging', '--confirm', 'stage-staging', '--sql', 'http', '--bundle', bundle);
    assert.equal(evidence.ok, true, JSON.stringify(evidence.steps, null, 1));
    assert.deepEqual(names(evidence).filter(n => /migration|marker|backup|trigger|baseline|deployment/.test(n)),
      ['ok:backup', 'ok:backup ready', 'ok:migration 006', 'ok:migration 007', 'ok:environment marker', 'ok:deployment', 'ok:deployment complete', 'ok:baseline cycle', 'ok:hourly trigger']);
    assert.equal(await fingerprintOf(DB), manifest.migrations[1].fingerprintAfter);
    assert.equal(state.deployments.length, 1);
    assert(state.deployments[0].zip > 100000, 'the bundle was uploaded');
    assert.equal(state.env.POOL_ALERTS_VERSION, head);
    assert.equal(state.env.OWNER_TOKEN_SHA256.length, 64);
    assert.equal(state.env.DATABASE_URL, 'unused', 'a same-project function never keeps the owner connection Neon injects');
    assert.deepEqual(state.triggers.map(t => [t.name, t.schedule.cron, t.function_path, t.enabled]), [['pool-alerts-hourly', '17 * * * *', '/v1/cron', true]]);
    const c = new pg.Client({connectionString: url(DB)}); await c.connect();
    const row = (await c.query('SELECT (SELECT name FROM pool_alerts.environment) AS env, (SELECT sending_enabled FROM pool_alerts.settings) AS sending, (SELECT last_event_id FROM pool_alerts.cursor) AS cursor')).rows[0];
    await c.end();
    assert.deepEqual([row.env, row.sending, row.cursor !== null], ['staging', false, true], 'marked, group sending OFF, baseline recorded');
    // The fresh role had no password: Neon refused the reset once, a random first password was set, and the reset then
    // gave the password the sender uses (it authenticates with SCRAM: the status probe passed as pool_alerts_sender).
    assert.deepEqual([state.refusals, state.resets], [1, 1], 'the sender password came from the reset_password stand-in');
    assert.match(evidence.steps.find(s => s.name === 'sender credentials').note, /generated by Neon \(reset_password\), after a first random password/);
    const deployedPassword = decodeURIComponent(new URL(state.env.POOL_ALERTS_DATABASE_URL).password);
    const wrong = new pg.Client({connectionString: url(DB, 'pool_alerts_sender', `${deployedPassword}x`)});
    await assert.rejects(wrong.connect(), /password authentication failed/, 'SCRAM is really checked on this database');
    const written = readFileSync(evidence.file, 'utf8');
    for (const secret of [CONTROL, env.NEON_API_KEY, state.env.POOL_ALERTS_DATABASE_URL.split(':')[2].split('@')[0], state.env.VAPID_PRIVATE_KEY,
      deriveToken(CONTROL, {app: 'personal', environment: 'staging', purpose: 'owner'})]) assert(!written.includes(secret), 'no secret in the evidence');
  });

  await scenario('stage again (an interrupted run resumes): nothing applied twice, VAPID keys kept, one trigger, a fresh password that works', async () => {
    const vapid = state.env.VAPID_PUBLIC_KEY, password = state.env.POOL_ALERTS_DATABASE_URL;
    const evidence = await release('stage', '--target', 'staging', '--confirm', 'stage-staging', '--bundle', bundle);
    assert.equal(evidence.ok, true, JSON.stringify(evidence.steps, null, 1));
    assert.deepEqual(names(evidence).filter(n => /migration|marker|backup|trigger/.test(n)), ['skip:backup', 'ok:backup ready', 'skip:migrations', 'skip:environment marker', 'skip:hourly trigger']);
    assert.equal(state.env.VAPID_PUBLIC_KEY, vapid, 'devices stay enrolled: the key pair is never replaced by a rerun');
    assert.equal(state.deployments[1].variables.includes('VAPID_PRIVATE_KEY'), false);
    assert.notEqual(state.env.POOL_ALERTS_DATABASE_URL, password);
    assert.deepEqual([state.refusals, state.resets], [1, 2], 'the role has a password now: reset directly');
    assert.equal(state.triggers.length, 1);
    assert.equal(state.branches.filter(b => b.name.startsWith('backup-before-pool-alerts-')).length, 1, 'one backup per release and day');
  });

  await scenario('verify, pause, resume; activate is refused without passed device checks on Android and iPhone', async () => {
    const verified = await release('verify', '--target', 'staging');
    assert.equal(verified.ok, true, JSON.stringify(verified.steps, null, 1));
    assert.equal(verified.status.sendingEnabled, false);
    assert.equal((await release('resume', '--target', 'staging', '--confirm', 'resume-staging')).ok, true);
    assert.equal((await release('pause', '--target', 'staging', '--confirm', 'pause-staging')).ok, true);
    const refused = await release('activate', '--target', 'staging', '--confirm', 'activate-staging');
    assert.equal(refused.ok, false);
    assert.match(refused.steps.at(-1).note, /no passed, opened device check on both an Android phone and an iPhone/);
    const c = new pg.Client({connectionString: url(DB)}); await c.connect();
    assert.equal((await c.query('SELECT sending_enabled FROM pool_alerts.settings')).rows[0].sending_enabled, false, 'still off');
    await c.end();
  });

  await scenario('staging-publish: a synthetic publication, correction and withdrawal, each captured by the trigger and dispatched at once', async () => {
    const c = new pg.Client({connectionString: url(DB)}); await c.connect();
    // Ten earlier events of another week first, so a text sort of event ids would pick the wrong one ('9' > '10').
    for (let i = 0; i < 10; i++) await c.query("INSERT INTO pool_alerts.publication_events (season, week, revision, action, content_changed, published_at, source) VALUES (2026, 12, $1, 'publish', true, now(), 'trigger')", [i + 1]);
    await c.query(`INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision) VALUES (2026, 12, 'draft', $1, 3)`,
      [JSON.stringify({schemaVersion: 1, season: 2026, week: 12, games: [], participants: []})]);
    const events = async () => (await c.query("SELECT action, revision FROM pool_alerts.publication_events WHERE season = 2026 AND week = 12 ORDER BY id")).rows.map(r => `${r.action}:${r.revision}`);
    try {
      for (const action of ['publish', 'correct', 'withdraw']) {
        const evidence = await release('staging-publish', '--target', 'staging', '--confirm', 'staging-publish-staging', '--action', action, '--week', '12');
        assert.equal(evidence.ok, true, JSON.stringify(evidence.steps, null, 1));
        assert.match(evidence.steps.find(s => s.name === 'dispatch').note, /^ok|^paused/);
        const [latest] = (await c.query('SELECT id FROM pool_alerts.publication_events ORDER BY id DESC LIMIT 1')).rows;
        assert.match(evidence.steps.find(s => s.name === 'synthetic publication').note, new RegExp(`captured as event ${latest.id} \\(${action === 'withdraw' ? 'withdraw' : 'publish'}\\)`), 'the evidence names the event it created');
      }
      assert.deepEqual((await events()).slice(-3), ['publish:4', 'publish:5', 'withdraw:5'], 'the capture trigger recorded each one');
      const again = await release('staging-publish', '--target', 'staging', '--confirm', 'staging-publish-staging', '--action', 'withdraw', '--week', '12');
      assert.equal(again.ok, false, 'a week that is not published cannot be withdrawn');
      const unconfirmed = await release('staging-publish', '--target', 'staging', '--confirm', 'yes', '--action', 'publish', '--week', '12');
      assert.match(unconfirmed.steps[0].note, /staging-publish-staging/);
    } finally { await c.end(); }
  });

  await scenario('adopt-tokens (staging only): the sender learns the digests of another control key\'s tokens, never the key; the old tokens stop working', async () => {
    const sha = t => createHash('sha256').update(t).digest('hex');
    const other = Buffer.alloc(32, 3).toString('base64url');
    const token = (key, purpose) => deriveToken(key, {app: 'personal', environment: 'staging', purpose});
    const adopt = key => release('adopt-tokens', '--target', 'staging', '--owner-sha256', sha(token(key, 'owner')), '--status-sha256', sha(token(key, 'status')), '--confirm', 'adopt-tokens-staging');
    const refused = await run(['adopt-tokens', '--target', 'staging', '--owner-sha256', 'a'.repeat(64), '--status-sha256', 'b'.repeat(64), '--confirm', 'yes'],
      {env, fetcher, targets: {staging: target}, print: () => {}, wait: async () => {}});
    assert.equal(refused.ok, false, 'needs its exact confirmation');
    const e = await adopt(other);
    assert.equal(e.ok, true, JSON.stringify(e.steps, null, 1));
    const status = async key => (await fetch(`${senderUrl}/v1/status`, {headers: {Authorization: `Bearer ${token(key, 'status')}`}})).status;
    assert.deepEqual([await status(other), await status(CONTROL)], [200, 401], 'the other key\'s token works, the old one no longer does');
    assert(!JSON.stringify(e).includes(token(other, 'owner')), 'no token in the evidence');
    assert.equal((await adopt(CONTROL)).ok, true, 'back to the rehearsal key for the scenarios that follow');
    assert.equal(await status(CONTROL), 200);
  });

  await scenario('rollback rehearsal: database level pauses, disables the trigger, stops the sender, removes 007 then 006 exactly; stage restores it all', async () => {
    const evidence = await release('rollback', '--target', 'staging', '--level', 'database', '--confirm', 'rollback-staging');
    assert.equal(evidence.ok, true, JSON.stringify(evidence.steps, null, 1));
    assert.deepEqual(names(evidence), [...names(evidence).slice(0, names(evidence).indexOf('ok:pause')), 'ok:pause', 'ok:trigger', 'ok:sender', 'ok:rollback 007', 'ok:rollback 006']);
    assert.equal(await fingerprintOf(DB), manifest.fingerprintBefore, 'exactly the catalog before 006');
    assert.equal(state.triggers[0].enabled, false);
    assert.equal(state.env.POOL_ALERTS_SENDING, '');
    const restored = await release('stage', '--target', 'staging', '--confirm', 'stage-staging', '--bundle', bundle);
    assert.equal(restored.ok, true, JSON.stringify(restored.steps, null, 1));
    assert.equal(await fingerprintOf(DB), manifest.migrations[1].fingerprintAfter);
    assert.deepEqual([state.triggers.length, state.triggers[0].enabled, state.env.POOL_ALERTS_SENDING], [1, true, 'enabled']);
  });
  console.log(`Pool Alerts release rehearsal: ${results.length} scenarios passed`);
} finally {
  await new Promise(r => senderServer.close(r));
  for (const pool of senderPools) await pool.end().catch(() => {});
}
