// Pool Alerts sender configuration and environment guards. Every value comes from the deployment's protected
// environment; nothing secret is in source. A production sender must point at exactly the Personal Pool's production
// endpoints below, and a staging or test sender must point at none of them, so neither can act on the other's data.
import {parseOrigins} from './core.mjs';

export const PRODUCTION = Object.freeze({
  dataUrl: 'https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1',
  authUrl: 'https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth',
  databaseHosts: Object.freeze(['ep-muddy-forest-au7eygkw.c-10.us-east-1.aws.neon.tech', 'ep-muddy-forest-au7eygkw-pooler.c-10.us-east-1.aws.neon.tech']),
  database: 'nfl_pool',
  endpointId: 'ep-muddy-forest-au7eygkw',
  origins: Object.freeze(['https://r88510179-collab.github.io', 'https://picks.smokkeventures.com']),
  publisherEmail: 'djsmokke@gmail.com'
});
export const SENDER_ROLE = 'pool_alerts_sender';

const HEX64 = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

function requireText(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required setting ${name}`);
  return value.trim();
}
function httpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} is not a URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be a plain https URL`);
  return url.href.replace(/\/$/, '');
}
function optionalHash(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (!HEX64.test(value)) throw new Error(`${name} must be a lowercase SHA-256 hex digest`);
  return value;
}
const mentionsProduction = text => typeof text === 'string' && text.includes(PRODUCTION.endpointId);

export function loadConfig(env) {
  const environment = requireText(env, 'POOL_ALERTS_ENV');
  if (!['production', 'staging', 'test'].includes(environment)) throw new Error('POOL_ALERTS_ENV must be production, staging or test');

  const databaseUrl = requireText(env, 'POOL_ALERTS_DATABASE_URL');
  let db;
  try { db = new URL(databaseUrl); } catch { throw new Error('POOL_ALERTS_DATABASE_URL is not a URL'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol)) throw new Error('POOL_ALERTS_DATABASE_URL must be a postgres URL');
  if (decodeURIComponent(db.username) !== SENDER_ROLE) throw new Error(`The sender must connect as ${SENDER_ROLE}, never as an owner or administrator`);
  const database = decodeURIComponent(db.pathname.replace(/^\//, ''));

  const dataUrl = httpsUrl(requireText(env, 'NEON_DATA_URL'), 'NEON_DATA_URL');
  const authUrl = httpsUrl(requireText(env, 'NEON_AUTH_URL'), 'NEON_AUTH_URL');
  const origins = parseOrigins(requireText(env, 'APP_ORIGINS'));
  const publisherEmail = requireText(env, 'PUBLISHER_EMAIL').toLowerCase();

  if (environment === 'production') {
    if (!PRODUCTION.databaseHosts.includes(db.hostname) || database !== PRODUCTION.database) throw new Error('Production sender must use the Personal Pool production database');
    if (dataUrl !== PRODUCTION.dataUrl || authUrl !== PRODUCTION.authUrl) throw new Error('Production sender must verify against the production Data API and Auth');
    if (origins.some(o => !PRODUCTION.origins.includes(o))) throw new Error('Production sender may enroll only the production Pool Center origins');
    if (publisherEmail !== PRODUCTION.publisherEmail) throw new Error('Production publisher identity does not match');
  } else {
    if (mentionsProduction(db.hostname) || mentionsProduction(dataUrl) || mentionsProduction(authUrl)) {
      throw new Error(`A ${environment} sender must never point at the Personal Pool production database, Data API or Auth`);
    }
    if (origins.some(o => PRODUCTION.origins.includes(o))) throw new Error(`A ${environment} sender must not enroll the production Pool Center origins`);
  }

  const vapidPublicKey = requireText(env, 'VAPID_PUBLIC_KEY');
  const vapidPrivateKey = requireText(env, 'VAPID_PRIVATE_KEY');
  if (!B64URL.test(vapidPublicKey) || Buffer.from(vapidPublicKey, 'base64url').length !== 65) throw new Error('VAPID_PUBLIC_KEY must be a 65-byte base64url P-256 key');
  if (!B64URL.test(vapidPrivateKey) || Buffer.from(vapidPrivateKey, 'base64url').length !== 32) throw new Error('VAPID_PRIVATE_KEY must be a 32-byte base64url key');
  const vapidSubject = requireText(env, 'VAPID_SUBJECT');
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(vapidSubject) && !/^https:\/\/[^\s]+$/.test(vapidSubject)) throw new Error('VAPID_SUBJECT must be a mailto: or https: contact');

  return Object.freeze({
    environment,
    databaseUrl,
    database,
    databaseHost: db.hostname,
    dataUrl,
    authUrl,
    jwksUrl: `${authUrl}/.well-known/jwks.json`,
    authOrigin: new URL(authUrl).origin,
    origins: Object.freeze(origins),
    publisherEmail,
    vapid: Object.freeze({publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject}),
    // Deployment-level master switch. Sending also needs the database switch (settings.sending_enabled) to be on.
    sendingAllowed: env.POOL_ALERTS_SENDING === 'enabled',
    ownerTokenSha256: optionalHash(env, 'OWNER_TOKEN_SHA256'),
    statusTokenSha256: optionalHash(env, 'STATUS_TOKEN_SHA256'),
    version: typeof env.POOL_ALERTS_VERSION === 'string' && /^[0-9a-f]{7,40}$/.test(env.POOL_ALERTS_VERSION) ? env.POOL_ALERTS_VERSION : 'unversioned'
  });
}
