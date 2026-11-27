// Pool Alerts unit suite: policy, configuration guards and caller authentication. No database or network.
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {
  publicationIdentity, validateSubscription, validatePreferences, deliveryOutcome, parseRetryAfter, notificationPayload, pushOptions,
  planEvent, verificationOutcome, parseOrigins, isUuid, isManageToken, MAX_ATTEMPTS, RETRY_DELAYS_SECONDS,
  CHECK_SCENARIOS, checkOutcome, deviceCodeFromDigest, isCheckValue, latestPublished, validatePlatform
} from './core.mjs';
import {createHash, webcrypto} from 'node:crypto';
import {loadConfig, PRODUCTION} from './config.mjs';
import {createJwtVerifier, digestMatches, sha256Hex, bearerToken} from './auth.mjs';
import {generateKeys, describe, main as ops} from './ops.mjs';
import {createECDH} from 'node:crypto';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; };

const row = {season: 2026, week: 12, revision: 1, status: 'locked', published_at: '2026-11-25T15:00:00Z'};
await test('publication identity accepts regular-season and postseason weeks, refuses anything else', () => {
  assert.deepEqual(publicationIdentity(row), {season: 2026, week: 12, revision: 1, publishedAt: '2026-11-25T15:00:00.000Z'});
  assert.equal(publicationIdentity({...row, week: 22}).week, 22, 'postseason week 22 is valid (the database allows 1-22)');
  assert.equal(publicationIdentity({...row, published_at: null}).publishedAt, null);
  for (const bad of [{...row, week: 23}, {...row, week: 0}, {...row, season: 2019}, {...row, revision: 0}, {...row, status: 'draft'},
    {...row, published_at: 'nope'}, null, [], {...row, revision: 1.5}]) assert.throws(() => publicationIdentity(bad));
});

const keys = {p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 9).toString('base64url')};
await test('subscriptions: only the exact push-service hosts, https, canonical, valid key lengths', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc123', 'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://web.push.apple.com/QGuYvlL9', 'https://wns2-bl2p.notify.windows.com/w/?token=BQYAAA']) {
    assert.equal(validateSubscription({endpoint, keys}).endpoint, endpoint);
  }
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/a1234567890', 'https://fcm.googleapis.com.evil.example/a1234567',
    'https://127.0.0.1/abcdefghijklmn', 'https://fcm.googleapis.com:444/fcm/send/a', 'https://user@fcm.googleapis.com/fcm/send/a',
    'https://api.push.apple.com/3/device/abcdef', 'https://evil.notify.windows.com.example.org/w/a', 'https://fcm.googleapis.com/',
    'https://fcm.googleapis.com/fcm/send/a#frag', 'https://FCM.googleapis.com/fcm/send/abcdef', 'x'.repeat(30)]) {
    assert.throws(() => validateSubscription({endpoint, keys}), undefined, endpoint);
  }
  assert.throws(() => validateSubscription({endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: {...keys, auth: 'abc'}}));
  assert.throws(() => validateSubscription({endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: {...keys, p256dh: Buffer.alloc(65, 3).toString('base64url')}}));
  assert.throws(() => validateSubscription({endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: {...keys, auth: keys.auth + '='}}));
  assert.throws(() => validateSubscription(null));
});

await test('preferences: only the corrections choice, boolean', () => {
  assert.deepEqual(validatePreferences({}), {corrections: true});
  assert.deepEqual(validatePreferences({corrections: false}), {corrections: false});
  assert.throws(() => validatePreferences({corrections: 'no'}));
});

await test('delivery outcomes: sent, expired, refused credentials, rejected, bounded retries with Retry-After', () => {
  assert.equal(deliveryOutcome({status: 201, attempt: 1}).state, 'sent');
  assert.deepEqual(deliveryOutcome({status: 410, attempt: 1}), {state: 'expired', errorClass: 'gone-410'});
  assert.deepEqual(deliveryOutcome({status: 404, attempt: 3}), {state: 'expired', errorClass: 'gone-404'});
  assert.deepEqual(deliveryOutcome({status: 403, attempt: 1}), {state: 'failed', errorClass: 'auth-403'});
  assert.deepEqual(deliveryOutcome({status: 400, attempt: 1}), {state: 'failed', errorClass: 'rejected-400'});
  assert.deepEqual(deliveryOutcome({status: 413, attempt: 1}), {state: 'failed', errorClass: 'rejected-413'});
  assert.deepEqual(deliveryOutcome({status: 0, attempt: 1}), {state: 'retry', delaySeconds: 30, errorClass: 'network'});
  assert.deepEqual(deliveryOutcome({status: 503, attempt: 2}), {state: 'retry', delaySeconds: 120, errorClass: 'server-503'});
  assert.deepEqual(deliveryOutcome({status: 429, attempt: 1, retryAfterSeconds: 900}), {state: 'retry', delaySeconds: 900, errorClass: 'rate-limited'});
  assert.deepEqual(deliveryOutcome({status: 429, attempt: 1, retryAfterSeconds: 99999}), {state: 'retry', delaySeconds: 3600, errorClass: 'rate-limited'});
  assert.deepEqual(deliveryOutcome({status: 500, attempt: MAX_ATTEMPTS}), {state: 'failed', errorClass: 'server-500-exhausted'});
  assert.equal(RETRY_DELAYS_SECONDS.length, MAX_ATTEMPTS);
  assert.throws(() => deliveryOutcome({status: 200, attempt: 0}));
  assert.equal(parseRetryAfter('120', 0), 120);
  assert.equal(parseRetryAfter(new Date(60000).toUTCString(), 0), 60);
  assert.equal(parseRetryAfter('soon', 0), null);
  assert.equal(parseRetryAfter(undefined, 0), null);
});

await test('payloads carry only the publication identity; no names, picks or standings', () => {
  assert.deepEqual(notificationPayload({kind: 'release', season: 2026, week: 12, revision: 2}), {v: 1, kind: 'release', season: 2026, week: 12, revision: 2});
  assert.deepEqual(notificationPayload({kind: 'test'}), {v: 1, kind: 'test'});
  assert.throws(() => notificationPayload({kind: 'score', season: 2026, week: 12, revision: 1}));
  assert.throws(() => notificationPayload({kind: 'release', season: 2026, week: 99, revision: 1}));
  assert(JSON.stringify(notificationPayload({kind: 'correction', season: 2026, week: 22, revision: 9})).length < 100);
  assert.deepEqual(pushOptions({kind: 'release', season: 2026, week: 12}), {topic: 'pool-2026-12', urgency: 'high', ttl: 86400});
  assert.deepEqual(pushOptions({kind: 'correction', season: 2026, week: 12}, 60), {topic: 'pool-2026-12', urgency: 'normal', ttl: 3600});
  assert.match(pushOptions({kind: 'release', season: 2026, week: 12}).topic, /^[A-Za-z0-9_-]{1,32}$/, 'RFC 8030 topic alphabet');
});

await test('planning: stale history and unchanged republications are never announced', () => {
  const nowMs = Date.parse('2026-11-26T12:00:00Z');
  assert.equal(planEvent({action: 'publish', contentChanged: true, occurredAt: '2026-11-26T11:59:00Z'}, {nowMs, maxAgeMinutes: 1440}).status, 'queued');
  assert.equal(planEvent({action: 'publish', contentChanged: true, occurredAt: '2026-11-24T11:59:00Z'}, {nowMs, maxAgeMinutes: 1440}).status, 'stale');
  assert.equal(planEvent({action: 'publish', contentChanged: false, occurredAt: '2026-11-26T11:59:00Z'}, {nowMs, maxAgeMinutes: 1440}).status, 'unchanged');
  assert.throws(() => planEvent({action: 'withdraw', occurredAt: '2026-11-26T11:59:00Z'}, {nowMs, maxAgeMinutes: 1440}));
});

await test('verification: exact public revision only', () => {
  const n = {season: 2026, week: 12, revision: 2};
  assert.equal(verificationOutcome(n, {...row, revision: 2}).status, 'verified');
  assert.equal(verificationOutcome(n, {...row, revision: 3}).status, 'superseded');
  assert.equal(verificationOutcome(n, {...row, revision: 1}).status, 'withdrawn');
  assert.equal(verificationOutcome(n, null).status, 'withdrawn');
  assert.throws(() => verificationOutcome(n, {...row, week: 11, revision: 2}));
  assert.throws(() => verificationOutcome(n, {...row, revision: 2, status: 'draft'}));
});

await test('origins, ids and tokens', () => {
  assert.deepEqual(parseOrigins('https://a.example, https://b.example,https://a.example'), ['https://a.example', 'https://b.example']);
  for (const bad of ['', 'http://a.example', 'https://a.example/', 'https://a.example/path', '*']) assert.throws(() => parseOrigins(bad), undefined, bad);
  assert(isUuid('6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'));
  assert(!isUuid('6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5'));
  assert(isManageToken('A'.repeat(43)) && !isManageToken('A'.repeat(42)) && !isManageToken('A'.repeat(42) + '='));
});

// Configuration guards.
const vapidPublic = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
const vapidPrivate = Buffer.alloc(32, 2).toString('base64url');
const production = {
  POOL_ALERTS_ENV: 'production',
  POOL_ALERTS_DATABASE_URL: 'postgresql://pool_alerts_sender:secret@ep-muddy-forest-au7eygkw.c-10.us-east-1.aws.neon.tech/nfl_pool?sslmode=require',
  NEON_DATA_URL: PRODUCTION.dataUrl, NEON_AUTH_URL: PRODUCTION.authUrl, APP_ORIGINS: PRODUCTION.origins.join(','),
  PUBLISHER_EMAIL: PRODUCTION.publisherEmail, VAPID_PUBLIC_KEY: vapidPublic, VAPID_PRIVATE_KEY: vapidPrivate,
  VAPID_SUBJECT: 'https://picks.smokkeventures.com/nfl-pool/', POOL_ALERTS_SENDING: 'enabled'
};
const staging = {...production, POOL_ALERTS_ENV: 'staging',
  POOL_ALERTS_DATABASE_URL: 'postgresql://pool_alerts_sender:secret@ep-staging-123.c-2.us-east-1.aws.neon.tech/nfl_pool',
  NEON_DATA_URL: 'https://ep-staging-123.apirest.c-2.us-east-1.aws.neon.tech/nfl_pool/rest/v1',
  NEON_AUTH_URL: 'https://ep-staging-123.neonauth.c-2.us-east-1.aws.neon.tech/nfl_pool/auth', APP_ORIGINS: 'https://staging.example'};

await test('configuration: production must be exactly production; staging must touch nothing of production', () => {
  const cfg = loadConfig(production);
  assert.equal(cfg.environment, 'production');
  assert.equal(cfg.sendingAllowed, true);
  assert.equal(cfg.jwksUrl, `${PRODUCTION.authUrl}/.well-known/jwks.json`);
  assert.equal(cfg.authOrigin, 'https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech');
  assert.equal(loadConfig({...production, POOL_ALERTS_SENDING: 'true'}).sendingAllowed, false, 'only the exact word enables sending');
  assert.equal(loadConfig(staging).environment, 'staging');
  const refused = [
    {...production, POOL_ALERTS_DATABASE_URL: production.POOL_ALERTS_DATABASE_URL.replace('pool_alerts_sender', 'nfl_pool_owner')},
    {...production, POOL_ALERTS_DATABASE_URL: staging.POOL_ALERTS_DATABASE_URL},
    {...production, NEON_DATA_URL: staging.NEON_DATA_URL},
    {...production, APP_ORIGINS: `${production.APP_ORIGINS},https://staging.example`},
    {...production, PUBLISHER_EMAIL: 'someone@example.com'},
    {...staging, POOL_ALERTS_DATABASE_URL: production.POOL_ALERTS_DATABASE_URL},
    {...staging, NEON_DATA_URL: PRODUCTION.dataUrl},
    {...staging, NEON_AUTH_URL: PRODUCTION.authUrl},
    {...staging, APP_ORIGINS: 'https://picks.smokkeventures.com'},
    {...production, POOL_ALERTS_ENV: 'prod'},
    {...production, VAPID_PRIVATE_KEY: 'short'},
    {...production, VAPID_SUBJECT: 'owner'},
    {...production, OWNER_TOKEN_SHA256: 'not-a-digest'},
    {...production, NEON_DATA_URL: `${PRODUCTION.dataUrl}?x=1`}
  ];
  for (const env of refused) assert.throws(() => loadConfig(env), undefined, JSON.stringify(env).slice(0, 120));
  for (const name of Object.keys(production).filter(k => k !== 'POOL_ALERTS_SENDING')) {
    const env = {...production}; delete env[name];
    assert.throws(() => loadConfig(env), new RegExp(name), `missing ${name} is refused`);
  }
});

await test('owner tokens are compared by SHA-256 digest in constant time', () => {
  const token = 'owner-token-'.padEnd(48, 'x');
  assert(digestMatches(token, sha256Hex(token)));
  assert(!digestMatches(`${token}y`, sha256Hex(token)));
  assert(!digestMatches(undefined, sha256Hex(token)));
  assert(!digestMatches(token, null));
  const req = h => new Request('http://x/', {headers: h});
  assert.equal(bearerToken(req({authorization: `Bearer ${token}`})), token);
  assert.equal(bearerToken(req({authorization: `Basic ${token}`})), null);
  assert.equal(bearerToken(req({})), null);
});

// Publisher JWT verification against a local Ed25519 JWKS (the Neon Auth token shape).
const {publicKey, privateKey} = generateKeyPairSync('ed25519');
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'k1'};
const issuer = 'https://ep-x.neonauth.c-1.us-east-1.aws.neon.tech';
const nowSeconds = 1795700000;
function jwt(payload, {kid = 'k1', alg = 'EdDSA', key = privateKey} = {}) {
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const signing = `${enc({alg, kid, typ: 'JWT'})}.${enc(payload)}`;
  return `${signing}.${sign(null, Buffer.from(signing), key).toString('base64url')}`;
}
const good = {iss: issuer, aud: issuer, sub: 'u1', email: 'DJSmokke@Gmail.com', emailVerified: true, banned: false, iat: nowSeconds - 10, exp: nowSeconds + 600};
let jwksFetches = 0;
const verify = createJwtVerifier({jwksUrl: `${issuer}/x/.well-known/jwks.json`, issuer, audience: issuer, publisherEmail: 'djsmokke@gmail.com',
  now: () => nowSeconds * 1000, fetcher: async () => { jwksFetches++; return new Response(JSON.stringify({keys: [jwk]})); }});
await test('publisher JWT: signature, issuer, audience, expiry, verified e-mail, not banned', async () => {
  assert.deepEqual(await verify(jwt(good)), {sub: 'u1'});
  const other = generateKeyPairSync('ed25519').privateKey;
  for (const bad of [jwt(good, {key: other}), jwt({...good, iss: 'https://evil.example'}), jwt({...good, aud: 'https://evil.example'}),
    jwt({...good, exp: nowSeconds - 1}), jwt({...good, email: 'someone@example.com'}), jwt({...good, emailVerified: false}),
    jwt({...good, banned: true}), jwt({...good, sub: ''}), jwt({...good, iat: nowSeconds + 3600}), jwt(good, {kid: 'unknown'}),
    jwt(good, {alg: 'HS256'}), 'a.b.c', 'not a token', `${jwt(good)}x`]) {
    assert.equal(await verify(bad), null);
  }
  assert(jwksFetches >= 2 && jwksFetches <= 4, 'an unknown kid forces one JWKS refresh, otherwise keys are cached');
});

await test('owner tool: generated keys are valid for the sender, tokens match their digests, commands are guarded', async () => {
  for (let i = 0; i < 200; i++) {
    const k = generateKeys();
    const priv = Buffer.from(k.vapidPrivateKey, 'base64url'), pub = Buffer.from(k.vapidPublicKey, 'base64url');
    assert.equal(priv.length, 32);
    assert.equal(pub.length, 65);
    const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(priv);
    assert.equal(ecdh.getPublicKey().toString('base64url'), k.vapidPublicKey, 'the private key reproduces the public key');
    assert.equal(sha256Hex(k.ownerToken), k.ownerTokenSha256);
    assert.equal(sha256Hex(k.statusToken), k.statusTokenSha256);
    if (i === 0) assert.equal(loadConfig({...production, VAPID_PUBLIC_KEY: k.vapidPublicKey, VAPID_PRIVATE_KEY: k.vapidPrivateKey,
      OWNER_TOKEN_SHA256: k.ownerTokenSha256, STATUS_TOKEN_SHA256: k.statusTokenSha256}).ownerTokenSha256, k.ownerTokenSha256);
  }
  const printed = [];
  assert.equal(await ops(['keys'], {}, line => printed.push(line)), 0);
  assert.match(printed.join('\n'), /VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{87}\n/);
  await assert.rejects(ops(['status'], {}), /POOL_ALERTS_OWNER_TOKEN is required/);
  await assert.rejects(ops(['status'], {POOL_ALERTS_URL: 'http://evil.example', POOL_ALERTS_OWNER_TOKEN: 'x'.repeat(43)}), /https origin/);
  await assert.rejects(ops(['test', 'nope'], {POOL_ALERTS_OWNER_TOKEN: 'x'.repeat(43)}), /Usage: test/);
  await assert.rejects(ops(['enrollment', 'invite'], {POOL_ALERTS_OWNER_TOKEN: 'x'.repeat(43)}), /POOL_ALERTS_INVITE_CODE/);
  await assert.rejects(ops(['drop-database'], {POOL_ALERTS_OWNER_TOKEN: 'x'.repeat(43)}), /Unknown command/);
  assert.match(describe({environment: 'production', sendingConfigured: true, settings: {sending_enabled: false, note: 'maintenance'}, subscriptions: {active: 3}}),
    /Sending: deployment ON, database OFF \(maintenance\)/);
});

await test('device checks: payloads carry a receipt value only when asked; codes match the app; outcomes are never retried', async () => {
  const ack = 'AbCdEfGhIjKlMnOpQrStUv';
  assert.deepEqual(notificationPayload({kind: 'test'}), {v: 1, kind: 'test'}, 'an ordinary test is unchanged');
  assert.deepEqual(notificationPayload({kind: 'release', season: 2026, week: 12, revision: 3}), {v: 1, kind: 'release', season: 2026, week: 12, revision: 3},
    'a real alert never carries a receipt value');
  assert.deepEqual(notificationPayload({kind: 'test', check: ack}), {v: 1, kind: 'test', ack});
  assert.deepEqual(notificationPayload({kind: 'correction', season: 2026, week: 12, revision: 3, check: ack}), {v: 1, kind: 'correction', season: 2026, week: 12, revision: 3, check: ack});
  for (const bad of ['short', `${ack}x`, 'AbCdEfGhIjKlMnOpQrSt/v', 1]) assert.throws(() => notificationPayload({kind: 'test', check: bad}), /check value/);
  assert.equal(isCheckValue(ack), true);
  assert.deepEqual(CHECK_SCENARIOS, ['test', 'release', 'repeat', 'correction']);
  assert.deepEqual(['android', 'ios', 'desktop', 'iPhone', '', null, 7].map(validatePlatform), ['android', 'ios', 'desktop', null, null, null, null]);
  // The same code from Node's hash (sender) and WebCrypto (the app), for fixed vectors.
  const vectors = {'11111111-1111-4111-8111-111111111111': 'XV3G-FJPO', '00000000-0000-4000-8000-000000000000': '3OAF-LYHA'};
  for (const [id, code] of Object.entries(vectors)) {
    assert.equal(deviceCodeFromDigest(createHash('sha256').update(id).digest()), code);
    assert.equal(deviceCodeFromDigest(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(id)))), code);
  }
  assert.match(deviceCodeFromDigest(createHash('sha256').update('x').digest()), /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.deepEqual(latestPublished([{season: 2026, week: 3, revision: 1}, {season: 2026, week: 12, revision: 2}, {season: 2025, week: 22, revision: 4}]),
    {season: 2026, week: 12, revision: 2});
  assert.equal(latestPublished([]), null);
  assert.deepEqual([201, 404, 410, 403, 0, 429, 503, 400].map(s => checkOutcome(s).state), ['sent', 'expired', 'expired', 'failed', 'failed', 'failed', 'failed', 'failed']);
  assert.deepEqual([checkOutcome(503).errorClass, checkOutcome(429).errorClass, checkOutcome(0).errorClass], ['server-503', 'rate-limited', 'network']);
});

console.log(`Pool Alerts core: ${passed} policy, configuration-guard and authentication groups passed`);
