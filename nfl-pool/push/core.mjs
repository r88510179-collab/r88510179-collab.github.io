// Pool Alerts policy: pure functions with no database, network or clock access of their own. Everything the sender
// decides about what may be sent, to whom and when is here, so it is unit-tested without infrastructure.

export const SEASON_MIN = 2020, SEASON_MAX = 2100, WEEK_MIN = 1, WEEK_MAX = 22;
export const MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_SECONDS = Object.freeze([30, 120, 600, 1800, 3600]);
export const MAX_RETRY_AFTER_SECONDS = 3600;
export const KINDS = Object.freeze(['release', 'correction']);

const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// A locked publication row as the public Data API returns it (season, week, revision, status, published_at).
export function publicationIdentity(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Publication row is malformed');
  const {season, week, revision, status, published_at: publishedAt = null} = row;
  if (!isInt(season, SEASON_MIN, SEASON_MAX) || !isInt(week, WEEK_MIN, WEEK_MAX)) throw new Error('Publication has no valid season and week');
  if (!isInt(revision, 1, Number.MAX_SAFE_INTEGER)) throw new Error('Publication has no valid revision');
  if (status !== 'locked') throw new Error('Publication is not locked');
  if (publishedAt !== null && (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt)))) {
    throw new Error('Publication has no valid publication time');
  }
  return {season, week, revision, publishedAt: publishedAt === null ? null : new Date(publishedAt).toISOString()};
}
export const weekKey = (season, week) => `${season}:${week}`;

// Push services the sender may contact. A subscription endpoint must be HTTPS on one of these exact hosts, with no
// credentials, port or fragment: the sender never posts to an address a client chose freely (no SSRF).
export const PUSH_SERVICES = Object.freeze([
  Object.freeze({name: 'fcm', accepts: host => host === 'fcm.googleapis.com'}),
  Object.freeze({name: 'mozilla', accepts: host => host === 'updates.push.services.mozilla.com'}),
  Object.freeze({name: 'apple', accepts: host => host === 'web.push.apple.com'}),
  Object.freeze({name: 'windows', accepts: host => /^[a-z0-9-]{1,63}\.notify\.windows\.com$/.test(host)})
]);

const B64URL = /^[A-Za-z0-9_-]+$/;
function decodeKey(value, length, name) {
  if (typeof value !== 'string' || !B64URL.test(value)) throw new Error(`Invalid push key ${name}`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw new Error(`Invalid push key ${name}`);
  return bytes;
}

export function validateSubscription(value, services = PUSH_SERVICES) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid subscription');
  if (typeof value.endpoint !== 'string' || value.endpoint.length < 20 || value.endpoint.length > 2048) throw new Error('Invalid endpoint');
  let url;
  try { url = new URL(value.endpoint); } catch { throw new Error('Invalid endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Unsupported push service');
  const service = services.find(s => s.accepts(url.hostname));
  // Real push services never use a port; only a test service list (never the production one) may allow one.
  if (!service || (url.port && service.allowsPort !== true)) throw new Error('Unsupported push service');
  if (!url.pathname || url.pathname === '/') throw new Error('Invalid push path');
  if (url.href !== value.endpoint) throw new Error('Endpoint is not canonical');
  const keys = value.keys;
  if (!keys || typeof keys !== 'object') throw new Error('Invalid push keys');
  const p256dh = decodeKey(keys.p256dh, 65, 'p256dh');
  if (p256dh[0] !== 4) throw new Error('Invalid push key p256dh');
  decodeKey(keys.auth, 16, 'auth');
  return {endpoint: url.href, keys: {p256dh: keys.p256dh, auth: keys.auth}, service: service.name};
}

// Notification preferences. Enrolling a device always means "tell me when official picks are released"; the one
// choice is whether official corrections of an already-announced week are announced too.
export function validatePreferences(value, fallback = {corrections: true}) {
  const corrections = value?.corrections === undefined ? fallback.corrections : value.corrections;
  if (typeof corrections !== 'boolean') throw new Error('Invalid preferences');
  return {corrections};
}

export function parseRetryAfter(value, nowMs) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (/^\d{1,7}$/.test(text)) return Math.min(Number(text), MAX_RETRY_AFTER_SECONDS);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, Math.ceil((at - nowMs) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

// What one push-service answer means for a delivery. attempt is the attempt just made (1-based).
//  2xx                -> sent
//  404, 410           -> expired: the device unsubscribed or the browser dropped it; disable the subscription
//  401, 403           -> failed (auth): the VAPID key does not match this subscription or the token was refused
//  400, 413, other 4xx-> failed: the request itself is wrong and would fail again
//  429, 5xx, network  -> retry with bounded backoff (Retry-After honored, capped), failed after MAX_ATTEMPTS
export function deliveryOutcome({status, attempt, retryAfterSeconds = null}) {
  if (!isInt(attempt, 1, 1000)) throw new Error('Invalid attempt');
  const code = Number.isInteger(status) ? status : 0;
  if (code >= 200 && code < 300) return {state: 'sent', errorClass: null};
  if (code === 404 || code === 410) return {state: 'expired', errorClass: `gone-${code}`};
  if (code === 401 || code === 403) return {state: 'failed', errorClass: `auth-${code}`};
  const transient = code === 0 || code === 429 || code >= 500;
  if (!transient) return {state: 'failed', errorClass: `rejected-${code}`};
  const errorClass = code === 0 ? 'network' : code === 429 ? 'rate-limited' : `server-${code}`;
  if (attempt >= MAX_ATTEMPTS) return {state: 'failed', errorClass: `${errorClass}-exhausted`};
  const backoff = RETRY_DELAYS_SECONDS[Math.min(attempt, RETRY_DELAYS_SECONDS.length) - 1];
  const delaySeconds = Math.max(backoff, retryAfterSeconds ?? 0);
  return {state: 'retry', delaySeconds: Math.min(delaySeconds, MAX_RETRY_AFTER_SECONDS), errorClass};
}

// The encrypted push payload. It carries no name, pick, standing or account detail: only which official publication
// changed, so the lock screen shows nothing private and the app loads everything else after it opens.
export function notificationPayload({kind, season, week, revision, check}) {
  if (!['release', 'correction', 'test'].includes(kind)) throw new Error('Invalid notification kind');
  // An owner-run device check carries a one-time receipt value (only the device can decrypt it); nothing else changes.
  if (check !== undefined && !isCheckValue(check)) throw new Error('Invalid check value');
  if (kind === 'test') return check === undefined ? {v: 1, kind} : {v: 1, kind, ack: check};
  if (!isInt(season, SEASON_MIN, SEASON_MAX) || !isInt(week, WEEK_MIN, WEEK_MAX) || !isInt(revision, 1, Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid notification identity');
  }
  return check === undefined ? {v: 1, kind, season, week, revision} : {v: 1, kind, season, week, revision, check};
}

// Push-service delivery options. The topic lets a push service replace an undelivered older message about the same
// week (a phone that was off sees one current alert, not a backlog). Releases are 'high' urgency so Android delivers
// them promptly; corrections 'normal'. Both expire after the notification age limit (default 24 hours).
export function pushOptions({kind, season, week}, maxAgeMinutes = 1440) {
  const ttl = Math.max(60, Math.min(maxAgeMinutes, 1440) * 60);
  if (kind === 'test') return {topic: 'pool-alerts-test', urgency: 'normal', ttl: 600};
  return {topic: `pool-${season}-${week}`, urgency: kind === 'release' ? 'high' : 'normal', ttl};
}

// How a new publication event is planned, before any device is chosen.
//  stale      the event is older than the notification age limit (an outage, or the first start): never announced
//  unchanged  a new revision with byte-identical content (e.g. the same sheet republished): nothing new to announce
//  queued     announce, after the public Data API confirms the exact revision is readable
export function planEvent({action, contentChanged, occurredAt}, {nowMs, maxAgeMinutes}) {
  if (action !== 'publish') throw new Error('Only publish events are planned');
  const occurred = Date.parse(occurredAt);
  if (!Number.isFinite(occurred)) throw new Error('Event has no valid time');
  if (nowMs - occurred > maxAgeMinutes * 60000) return {status: 'stale', reason: `older than ${maxAgeMinutes} minutes when planned`};
  if (contentChanged === false) return {status: 'unchanged', reason: 'revision republished with identical content'};
  return {status: 'queued', reason: null};
}

// Compare a queued notification with what the public Data API returns for its week right now.
//  verified    the exact revision is publicly readable and locked
//  superseded  a newer revision is public (its own event plans that announcement)
//  withdrawn   the week is no longer public, or only an older revision is
export function verificationOutcome(notification, publicRow) {
  if (!publicRow) return {status: 'withdrawn', reason: 'week is not publicly readable'};
  const identity = publicationIdentity(publicRow);
  if (identity.season !== notification.season || identity.week !== notification.week) throw new Error('Public row is for another week');
  if (identity.revision === notification.revision) return {status: 'verified', reason: null};
  if (identity.revision > notification.revision) return {status: 'superseded', reason: `revision ${identity.revision} is public`};
  return {status: 'withdrawn', reason: `public revision ${identity.revision} is older`};
}

// Origins allowed to enroll devices (the Pool Center sites). Exact https origins only.
export function parseOrigins(list) {
  const origins = String(list || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origins.length) throw new Error('At least one app origin is required');
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error(`Invalid app origin ${origin}`); }
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error(`App origin must be an exact https origin: ${origin}`);
  }
  return [...new Set(origins)];
}

export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const isManageToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

// ---------------------------------------------------------------------------------------------------------------
// Device checks (migration 007): an owner-run alert to one device, with a receipt only that device can give.
// ---------------------------------------------------------------------------------------------------------------
export const CHECK_SCENARIOS = Object.freeze(['test', 'release', 'repeat', 'correction']);
export const isCheckValue = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
export const PLATFORMS = Object.freeze(['android', 'ios', 'desktop']);
export const validatePlatform = value => (PLATFORMS.includes(value) ? value : null);

// A device's short code, shown on its Pool Alerts card and in the owner's acceptance list, so the owner can tell which
// phone is which without seeing its id: the first 8 base32 characters of SHA-256(id), as XXXX-XXXX. The app computes
// the same code with WebCrypto (pool-alerts.mjs deviceCode); core.test.mjs pins both to the same vectors.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function deviceCodeFromDigest(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5 && out.length < 8) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= 8) break;
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

// The most recently published week of the public index (the week a real-week check names).
export function latestPublished(index) {
  let best = null;
  for (const row of index || []) {
    if (!best || row.season > best.season || (row.season === best.season && row.week > best.week)) best = row;
  }
  return best;
}

// What a check's push-service answer means. A check is never retried: the owner is waiting for this one answer.
export function checkOutcome(status) {
  const code = Number.isInteger(status) ? status : 0;
  if (code >= 200 && code < 300) return {state: 'sent', errorClass: null};
  if (code === 404 || code === 410) return {state: 'expired', errorClass: `gone-${code}`};
  if (code === 401 || code === 403) return {state: 'failed', errorClass: `auth-${code}`};
  if (code === 0) return {state: 'failed', errorClass: 'network'};
  if (code === 429) return {state: 'failed', errorClass: 'rate-limited'};
  return {state: 'failed', errorClass: code >= 500 ? `server-${code}` : `rejected-${code}`};
}
