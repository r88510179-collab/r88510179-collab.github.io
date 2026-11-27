// Pool Alerts release automation, unit level: no network, database or Neon. The database steps run end to end on
// PostgreSQL in release.spec.mjs (test-integration.sh); the real staging rehearsal is recorded in DEPLOY.md.
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkControlKey, deriveToken, splitSqlScript, scrub, loadManifest, migrationPlan, nextCronRun, fingerprintQuery,
  confirmationFor, sha256Hex} from './release-lib.mjs';
import {parseArgs, run} from './release.mjs';
import {TARGETS} from './release-targets.mjs';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; };
const KEY = Buffer.alloc(32, 7).toString('base64url');

await test('tokens are derived per app, environment and purpose, and never from a weak key', () => {
  const owner = deriveToken(KEY, {app: 'personal', environment: 'production', purpose: 'owner'});
  assert.match(owner, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(owner, deriveToken(KEY, {app: 'personal', environment: 'production', purpose: 'owner'}), 'stable');
  const all = ['personal', 'commercial'].flatMap(app => ['production', 'staging'].flatMap(environment => ['owner', 'status'].map(purpose => deriveToken(KEY, {app, environment, purpose}))));
  assert.equal(new Set(all).size, 8, 'eight different tokens');
  assert.notEqual(deriveToken(Buffer.alloc(32, 8).toString('base64url'), {app: 'personal', environment: 'production', purpose: 'owner'}), owner);
  for (const bad of [undefined, '', 'short', Buffer.alloc(16, 1).toString('base64url'), 'x'.repeat(42), `${KEY}!`]) assert.throws(() => checkControlKey(bad), /at least 32 random bytes/);
  assert.throws(() => deriveToken(KEY, {app: 'personal', environment: 'production', purpose: 'admin'}), /Unknown token/);
  assert.throws(() => deriveToken(KEY, {app: 'other', environment: 'production', purpose: 'owner'}), /Unknown token/);
});

await test('migration files split into their statements for one HTTP batch, byte for byte, without BEGIN and COMMIT', () => {
  for (const file of ['006-pool-alerts.sql', '006-pool-alerts-rollback.sql', '007-pool-alerts-device-checks.sql', '007-pool-alerts-device-checks-rollback.sql']) {
    const text = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    const statements = splitSqlScript(text);
    assert(statements.length >= 3, file);
    assert(!statements.some(s => /^(BEGIN|COMMIT)$/i.test(s.replace(/--[^\n]*/g, '').trim())), `${file}: the batch is the transaction`);
    for (const s of statements) assert(text.includes(s), `${file}: every statement is kept exactly`);
    for (const block of text.match(/DO \$(\w*)\$[\s\S]*?\$\1\$/g) || []) assert(statements.some(s => s.includes(block)), `${file}: a DO block is never cut`);
  }
  assert.deepEqual(splitSqlScript("BEGIN;\nSELECT 'a;b' AS \"x;y\"; -- c;\n/* d; /* nested; */ */ SELECT $q$e;f$q$;\nSELECT $$g;$$;\nCOMMIT;"),
    ["SELECT 'a;b' AS \"x;y\"", "-- c;\n/* d; /* nested; */ */ SELECT $q$e;f$q$", 'SELECT $$g;$$']);
  assert.deepEqual(splitSqlScript("SELECT 'it''s; fine'; SELECT 2"), ["SELECT 'it''s; fine'", 'SELECT 2']);
  assert.throws(() => splitSqlScript('\\set ON_ERROR_STOP on\nSELECT 1;'), /psql meta-commands/);
  assert.throws(() => splitSqlScript("SELECT 'open"), /Unterminated string/);
  assert.throws(() => splitSqlScript('SELECT $x$ open'), /Unterminated dollar-quoted/);
  assert.throws(() => splitSqlScript('/* open'), /Unterminated block comment/);
});

await test('evidence never holds a secret: configured values, URL credentials and secret-named fields are replaced', () => {
  const secret = 'Sup3rS3cretValue_x1', uri = 'postgresql://nfl_pool_owner:hunter2hunter2@ep-x.neon.tech/nfl_pool?sslmode=require';
  const out = scrub({note: `connected with ${uri}`, nested: {password: 'abc12345', token: 'tok', ownerTokenSha256: 'a'.repeat(64), fine: `value ${secret} here`},
    list: [secret], connectionString: 'x', enabled: true, uri: 'whatever', count: 3}, [secret]);
  const text = JSON.stringify(out);
  assert(!text.includes('hunter2') && !text.includes(secret) && !text.includes('abc12345'));
  assert.equal(out.nested.password, '[redacted]');
  assert.equal(out.nested.token, '[redacted]');
  assert.equal(out.nested.ownerTokenSha256, 'a'.repeat(64), 'a digest is not a secret');
  assert.equal(out.connectionString, '[redacted]');
  assert.equal(out.uri, '[redacted]');
  assert.deepEqual([out.enabled, out.count], [true, 3]);
  assert.match(out.note, /postgresql:\/\/nfl_pool_owner:\[redacted\]@ep-x/);
});

await test('the release manifest names the exact migration files of this commit, and plans only reviewed states', () => {
  const {manifest, problems} = loadManifest();
  assert.deepEqual(problems, [], 'every migration and rollback file matches its digest (update release-manifest.json with the files)');
  assert.deepEqual(manifest.migrations.map(m => m.id), ['006', '007']);
  for (const m of manifest.migrations) assert.match(m.fingerprintAfter, /^[0-9a-f]{64}$/);
  assert.deepEqual(migrationPlan(manifest, {fingerprint: manifest.fingerprintBefore}), {state: 'none', pending: ['006', '007']});
  assert.deepEqual(migrationPlan(manifest, {fingerprint: manifest.migrations[0].fingerprintAfter}), {state: '006', pending: ['007']});
  assert.deepEqual(migrationPlan(manifest, {fingerprint: manifest.migrations[1].fingerprintAfter}), {state: '007', pending: []});
  assert.deepEqual(migrationPlan(manifest, {fingerprint: 'f'.repeat(64)}), {state: 'unknown', pending: null}, 'a hand-changed catalog is refused');
  const q = fingerprintQuery();
  assert.match(q, /^SELECT \* FROM \(WITH owner_names/);
  assert.match(q, /AS f\(schema, counts, functions, relations, triggers, sender_role\)$/);
  assert(!q.includes('\\set'));
});

await test('the next scheduled run of the Pool Alerts triggers', () => {
  assert.equal(nextCronRun('17 * * * *', Date.parse('2026-11-27T03:10:00Z')), '2026-11-27T03:17:00.000Z');
  assert.equal(nextCronRun('17 * * * *', Date.parse('2026-11-27T03:17:00Z')), '2026-11-27T04:17:00.000Z');
  assert.equal(nextCronRun('13,43 * * * *', Date.parse('2026-11-27T23:50:00Z')), '2026-11-28T00:13:00.000Z');
  assert.equal(nextCronRun('*/5 * * * *'), null, 'never a guess');
  assert.equal(nextCronRun('0 9 * * 1'), null);
});

await test('arguments: an operation, a target and nothing unexpected', () => {
  assert.deepEqual(parseArgs(['preflight', '--target', 'staging']), {operation: 'preflight', options: {target: 'staging'}});
  assert.deepEqual(parseArgs(['stage', '--target', 'production', '--approved-commit', 'a'.repeat(40), '--bundle-sha256', 'b'.repeat(64)]).options,
    {target: 'production', approvedCommit: 'a'.repeat(40), bundleSha256: 'b'.repeat(64)});
  assert.throws(() => parseArgs(['deploy', '--target', 'production']), /Operation must be one of/);
  assert.throws(() => parseArgs(['status', '--target', 'prod']), /--target must be production or staging/);
  assert.throws(() => parseArgs(['status', '--target']), /Unexpected argument/);
  assert.throws(() => parseArgs(['rollback', '--target', 'staging']), /--level must be one of/);
  assert.throws(() => parseArgs(['status', '--target', 'staging', '--sql', 'ftp']), /--sql must be/);
  assert.equal(parseArgs(['staging-publish', '--target', 'staging', '--action', 'correct', '--week', '12']).options.action, 'correct');
  assert.throws(() => parseArgs(['staging-publish', '--target', 'production', '--action', 'publish', '--week', '12']), /staging only/, 'never production');
  assert.throws(() => parseArgs(['staging-publish', '--target', 'staging', '--action', 'delete', '--week', '12']), /--action must be/);
  for (const week of ['0', '23', 'x', '']) assert.throws(() => parseArgs(['staging-publish', '--target', 'staging', '--action', 'publish', '--week', week]), /--week must be 1 to 22/);
  assert.equal(confirmationFor('stage', 'production'), 'stage-production');
  assert.equal(TARGETS.production.sender.sameProjectAsDatabase, false, 'production keeps the sender out of the database project');
  assert.equal(TARGETS.production.env.APP_ORIGINS, 'https://r88510179-collab.github.io,https://picks.smokkeventures.com');
});

// A Neon API and an owner connection in memory: preflight reads everything and changes nothing; a change without its
// confirmation, or production without the approved commit, stops before anything is touched.
function fakeNeon({fingerprint, functionExists = true, calls = []}) {
  const {manifest} = loadManifest();
  const t = TARGETS.production;
  const responses = {
    [`GET /projects/${t.database.projectId}`]: {project: {id: t.database.projectId, name: t.database.projectName, compute_time_seconds: 45000, quota_reset_at: '2026-12-01T00:00:00Z'}},
    [`GET /projects/${t.database.projectId}/branches/${t.database.branchId}`]: {branch: {id: t.database.branchId, current_state: 'ready'}},
    [`GET /projects/${t.database.projectId}/branches/${t.database.branchId}/endpoints`]: {endpoints: [{id: t.database.endpointId, host: t.database.host, type: 'read_write'}]},
    [`GET /projects/${t.database.projectId}/branches/${t.database.branchId}/databases`]: {databases: [{name: 'nfl_pool', owner_name: 'nfl_pool_owner'}]},
    [`GET /projects/${t.database.projectId}/branches/${t.database.branchId}/roles`]: {roles: [{name: 'nfl_pool_owner'}]},
    [`GET /projects/${t.database.projectId}/connection_uri`]: {uri: 'postgresql://nfl_pool_owner:OwnerPassw0rdSecret@ep-muddy-forest-au7eygkw.c-10.us-east-1.aws.neon.tech/nfl_pool?sslmode=require'},
    [`GET /projects/${t.database.projectId}/branches`]: {branches: [{id: t.database.branchId, name: 'main'}]},
    [`GET /projects/${t.sender.projectId}/branches/${t.sender.branchId}/functions/${t.sender.slug}`]: functionExists ? {function: {invocation_url: `${t.sender.url}/`, current_deployment: {id: 3, status: 'completed', environment: ['VAPID_PUBLIC_KEY']}}} : null,
    [`GET /projects/${t.sender.projectId}/branches/${t.sender.branchId}/triggers`]: {triggers: [{name: 'pool-alerts-hourly', trigger_id: 'trig-1', schedule: {cron: '17 * * * *'}, function_path: '/v1/cron', enabled: true}]}
  };
  const fetcher = async (url, init = {}) => {
    const u = new URL(url), key = `${init.method || 'GET'} ${u.pathname.replace('/api/v2', '')}`;
    calls.push(key);
    if (u.origin === new URL(t.sender.url).origin) return new Response(JSON.stringify({service: 'pool-alerts', environment: 'production', version: 'a'.repeat(40)}), {status: 200});
    if (!(key in responses)) return new Response('{"message":"unexpected call"}', {status: 500});
    return responses[key] === null ? new Response('{"message":"not found"}', {status: 404}) : new Response(JSON.stringify(responses[key]), {status: 200});
  };
  const sqlFactory = async () => ({
    query: async text => {
      calls.push(`SQL ${text.slice(0, 30)}`);
      if (text.includes('current_user AS role')) return [{role: 'nfl_pool_owner', database: 'nfl_pool', public_tables: '5', alerts_schema: fingerprint === manifest.fingerprintBefore ? 'false' : 'true',
        device_checks: fingerprint === manifest.migrations[1].fingerprintAfter ? 'true' : 'false', sender_role: '1', sender_can_login: 'false'}];
      if (text.includes('pool_alerts.environment')) return [{environment: 'production', sending_enabled: 'false', cursor: null, devices: '0', latest_event: null}];
      if (text.includes('owner_names')) return [{schema: `schema_sha256=${fingerprint}`, counts: 'functions=1 relations=15 triggers=1 sender_can_login=false'}];
      throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
    },
    script: async () => { throw new Error('preflight never runs a script'); },
    close: async () => {}
  });
  return {fetcher, sqlFactory, calls};
}
const quiet = () => {};
const git = args => (args[0] === 'rev-parse' ? 'a'.repeat(40) : '');

await test('preflight reads Neon, the database and the sender, changes nothing, and writes evidence without secrets', async () => {
  const {manifest} = loadManifest();
  const {fetcher, sqlFactory, calls} = fakeNeon({fingerprint: manifest.fingerprintBefore, functionExists: false});
  const dir = mkdtempSync(join(tmpdir(), 'release-test-'));
  const evidence = await run(['preflight', '--target', 'production', '--evidence', dir], {env: {NEON_API_KEY: 'neon-api-key-secret-123', POOL_ALERTS_CONTROL_KEY: KEY}, fetcher, sqlFactory, git, print: quiet, wait: async () => {}});
  assert.equal(evidence.ok, true, JSON.stringify(evidence.steps));
  assert.deepEqual(evidence.database.pending, ['006', '007']);
  assert.equal(evidence.sender.deployed, false);
  assert(calls.every(c => c.startsWith('GET ') || c.startsWith('SQL ')), 'only reads');
  assert(!calls.some(c => c.startsWith('SQL ') && !/^SQL (SELECT|WITH)/.test(c)), 'only SELECT statements');
  const written = readFileSync(evidence.file, 'utf8');
  for (const secret of ['neon-api-key-secret-123', KEY, 'OwnerPassw0rdSecret']) assert(!written.includes(secret), `the evidence never holds ${secret.slice(0, 6)}…`);
  assert.equal(JSON.parse(written).steps.find(s => s.name === 'Neon identity').computeThisPeriodCuHours, 12.5);
});

await test('a change without its exact confirmation, or production without the approved commit, stops before anything is touched', async () => {
  const {manifest} = loadManifest();
  for (const [argv, note] of [
    [['stage', '--target', 'production'], /--confirm stage-production/],
    [['stage', '--target', 'production', '--confirm', 'stage-staging'], /--confirm stage-production/],
    [['activate', '--target', 'staging', '--confirm', 'yes'], /--confirm activate-staging/],
    [['rollback', '--target', 'production', '--level', 'database', '--confirm', 'rollback'], /--confirm rollback-production/]]) {
    const {fetcher, sqlFactory, calls} = fakeNeon({fingerprint: manifest.fingerprintBefore});
    const evidence = await run(argv, {env: {NEON_API_KEY: 'k'.repeat(20), POOL_ALERTS_CONTROL_KEY: KEY}, fetcher, sqlFactory, git, print: quiet, wait: async () => {}, evidence: undefined});
    assert.equal(evidence.ok, false);
    assert.match(evidence.steps[0].note, note);
    assert.deepEqual(calls, [], `${argv.join(' ')}: nothing was contacted`);
  }
  const {fetcher, sqlFactory, calls} = fakeNeon({fingerprint: manifest.fingerprintBefore});
  const wrong = await run(['stage', '--target', 'production', '--confirm', 'stage-production', '--approved-commit', 'b'.repeat(40)],
    {env: {NEON_API_KEY: 'k'.repeat(20), POOL_ALERTS_CONTROL_KEY: KEY}, fetcher, sqlFactory, git, print: quiet, wait: async () => {}});
  assert.equal(wrong.ok, false);
  assert.match(wrong.steps.find(s => s.name === 'approved commit').note, /approved b{40}/);
  assert.deepEqual(calls, [], 'a different commit stops before Neon is contacted');
  const noKey = await run(['pause', '--target', 'production', '--confirm', 'pause-production'], {env: {NEON_API_KEY: 'k'.repeat(20)}, fetcher, sqlFactory, git, print: quiet});
  assert.match(noKey.steps[0].note, /POOL_ALERTS_CONTROL_KEY is required/);
});

await test('a database in no reviewed state, or marked for another environment, is refused', async () => {
  const {fetcher, sqlFactory} = fakeNeon({fingerprint: 'e'.repeat(64)});
  const evidence = await run(['preflight', '--target', 'production'], {env: {NEON_API_KEY: 'k'.repeat(20)}, fetcher, sqlFactory, git, print: quiet, wait: async () => {}});
  assert.equal(evidence.ok, false);
  assert.match(evidence.steps.at(-1).note, /matches no reviewed state/);
  const {manifest} = loadManifest();
  const other = fakeNeon({fingerprint: manifest.migrations[1].fingerprintAfter});
  const staged = await run(['preflight', '--target', 'staging'], {env: {NEON_API_KEY: 'k'.repeat(20)}, fetcher: other.fetcher, sqlFactory: other.sqlFactory, git, print: quiet, wait: async () => {}});
  assert.equal(staged.ok, false, 'production identities never pass as staging');
});

console.log(`Pool Alerts release automation: ${passed} groups passed`);
