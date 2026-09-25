// Commercial V1 live security/behaviour validation harness: shared helpers.
// SYNTHETIC DATA ONLY. Never prints passwords, OTP codes, JWTs, session/refresh tokens, cookies or invite tokens:
// secrets live only in RUN_DIR/secrets.json (mode 0600); evidence records hold status codes, error codes,
// claims (minus secrets), lengths and short SHA-256 fingerprints.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fetch as ufetch, ProxyAgent, Agent} from 'undici';

export const AUTH_URL = process.env.PP_AUTH_URL || 'https://ep-still-recipe-b5g7680z.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth';
export const DATA_URL = process.env.PP_DATA_URL || 'https://ep-still-recipe-b5g7680z.apirest.c-7.us-east-2.aws.neon.tech/neondb/rest/v1';
export const ORIGIN = process.env.PP_ORIGIN ?? 'http://localhost:5173';
// Secrets (passwords, cookies, JWTs, invite tokens) live in RUN_DIR/secrets.json: RUN_DIR must be given and must be
// outside this repository so nothing secret can be committed.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
if (!process.env.PP_RUN_DIR) throw new Error('set PP_RUN_DIR to a private directory outside the repository');
export const RUN_DIR = path.resolve(process.env.PP_RUN_DIR);
if (RUN_DIR === REPO_ROOT || RUN_DIR.startsWith(REPO_ROOT + path.sep)) throw new Error(`PP_RUN_DIR must be outside the repository (${REPO_ROOT})`);
export const RUN_TAG = process.env.PP_RUN_TAG || 'r1';

// Hard guard: only the dedicated commercial endpoint (project fancy-brook-65396623) may be touched. PP_REHEARSAL=1
// instead allows loopback only (the local mock servers used to debug this harness; never evidence).
const COMMERCIAL_ENDPOINT = 'ep-still-recipe-b5g7680z';
export const REHEARSAL = process.env.PP_REHEARSAL === '1';
for (const u of [AUTH_URL, DATA_URL]) {
  const host = new URL(u).hostname;
  if (REHEARSAL ? host !== '127.0.0.1' : !host.startsWith(`${COMMERCIAL_ENDPOINT}.`)) throw new Error(`refusing endpoint ${host} (rehearsal=${REHEARSAL})`);
}

fs.mkdirSync(RUN_DIR, {recursive: true, mode: 0o700});
const SECRETS = path.join(RUN_DIR, 'secrets.json');
const STATE = path.join(RUN_DIR, 'state.json');
const EVIDENCE = path.join(RUN_DIR, 'evidence.jsonl');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export const secrets = readJson(SECRETS, {identities: {}, invites: {}, anon: {}, firstJwts: {}});
export const state = readJson(STATE, {users: {}, fixtures: {}, owned: {}, results: {}});
export function save() {
  fs.writeFileSync(SECRETS, JSON.stringify(secrets, null, 1), {mode: 0o600});
  fs.chmodSync(SECRETS, 0o600);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
}

// ---------- redaction ----------
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const HEX64_RE = /\b[0-9a-fA-F]{64}\b/g;
export const scrub = s => String(s).replace(JWT_RE, '<jwt-redacted>').replace(HEX64_RE, '<hex64-redacted>');
const SECRET_KEYS = new Set(['password', 'token', 'invite_token', 'jwt', 'cookie', 'cookies', 'session_token', 'access_token', 'refresh_token', 'otp', 'set-auth-jwt', 'jar']);
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.has(k) ? (x == null ? x : '<redacted>') : redact(x)]));
  return typeof v === 'string' ? scrub(v) : v;
}
export const fp = s => s == null ? null : crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

// ---------- transport ----------
const proxyUri = process.env.HTTPS_PROXY || process.env.https_proxy || '';
export const newDispatcher = () => (proxyUri && !REHEARSAL ? new ProxyAgent({uri: proxyUri}) : new Agent());
const shared = newDispatcher();

// A 429 was not processed, so retrying it is safe. Honour Retry-After / X-Retry-After when present.
function retryAfterMs(res, attempt) {
  const h = Number(res.headers.get('retry-after') || res.headers.get('x-retry-after'));
  return Number.isFinite(h) && h > 0 ? Math.min(h, 120) * 1000 + 250 : Math.min(60000, 5000 * 2 ** attempt);
}
function parseBody(text) { try { return text ? JSON.parse(text) : null; } catch { return undefined; } }

// Minimal per-identity cookie jar for the single Neon Auth host.
function storeCookies(jar, setCookies) {
  for (const sc of setCookies) {
    const [pair, ...attrs] = sc.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
    const expired = attrs.some(a => /^\s*max-age=0\s*$/i.test(a)) || attrs.some(a => { const m = a.match(/^\s*expires=(.*)$/i); return m && Date.parse(m[1]) < Date.now(); });
    if (expired || value === '') delete jar[name]; else jar[name] = value;
  }
}
const cookieHeader = jar => Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; ');

export async function authCall(ident, method, p, body, {origin = ORIGIN, dispatcher = shared, extraHeaders = {}} = {}) {
  ident.jar ||= {};
  const headers = {accept: 'application/json', ...extraHeaders};
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const ck = cookieHeader(ident.jar);
  if (ck) headers.cookie = ck;
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await ufetch(AUTH_URL + p, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), dispatcher, redirect: 'manual'});
    if (res.status !== 429 || attempt >= 6) break;
    await res.text();
    const wait = retryAfterMs(res, attempt);
    console.log(`  (auth ${method} ${p} rate-limited: HTTP 429, retry ${attempt + 1} in ${Math.round(wait / 1000)}s)`);
    await sleep(wait);
  }
  storeCookies(ident.jar, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  const text = await res.text();
  return {status: res.status, headers: res.headers, json: parseBody(text), text};
}

export async function data(method, p, {token, body, headers = {}, dispatcher = shared, raw = false} = {}) {
  const h = {accept: 'application/json', ...headers};
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && !raw && !h['content-type']) h['content-type'] = 'application/json';
  let t0, res;
  for (let attempt = 0; ; attempt++) {
    t0 = performance.now();
    res = await ufetch(DATA_URL + p, {method, headers: h, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)), dispatcher});
    if (res.status !== 429 || attempt >= 6) break;
    await res.text();
    const wait = retryAfterMs(res, attempt);
    console.log(`  (data ${method} ${p.split('?')[0]} rate-limited: HTTP 429, retry ${attempt + 1} in ${Math.round(wait / 1000)}s)`);
    await sleep(wait);
  }
  const text = await res.text();
  const t1 = performance.now();
  const json = parseBody(text);
  const err = res.status >= 400 && json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  return {status: res.status, ok: res.ok, json, text, code: err?.code ?? null, message: err?.message ?? null,
    details: err?.details ?? null, hint: err?.hint ?? null, t0, t1, ms: Math.round(t1 - t0),
    contentRange: res.headers.get('content-range'), wwwAuth: res.headers.get('www-authenticate')};
}
export const rpc = (token, fn, args = {}, opts = {}) => data('POST', `/rpc/${fn}`, {token, body: args, ...opts});

// ---------- JWT (claims only; never logged raw) ----------
const b64uDec = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const b64uEnc = s => Buffer.from(s).toString('base64url');
export const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export function decodeJwt(t) {
  const [h, p] = t.split('.');
  return {header: JSON.parse(b64uDec(h)), payload: JSON.parse(b64uDec(p))};
}
export function claimsSummary(t, {maskEmail = false} = {}) {
  if (!t) return {present: false};
  const {header, payload} = decodeJwt(t);
  const email = payload.email == null ? payload.email : (maskEmail ? String(payload.email).replace(/^(.).*(@.*)$/, '$1***$2') : payload.email);
  return {present: true, length: t.length, fp: fp(t), alg: header.alg, kid_fp: fp(header.kid), typ: header.typ,
    iss: payload.iss, aud: payload.aud, sub: payload.sub, id: payload.id, role: payload.role, email,
    emailVerified: payload.emailVerified, banned: payload.banned, iat: payload.iat, exp: payload.exp, ttl_s: payload.exp - payload.iat,
    claim_keys: Object.keys(payload).sort()};
}
export function tamperPayload(t, patch) {
  const [h, p, s] = t.split('.');
  return `${h}.${b64uEnc(JSON.stringify({...JSON.parse(b64uDec(p)), ...patch}))}.${s}`;
}
export function algNone(t, patch = {}) {
  const {payload} = decodeJwt(t);
  return `${b64uEnc(JSON.stringify({alg: 'none', typ: 'JWT'}))}.${b64uEnc(JSON.stringify({...payload, ...patch}))}.`;
}
export function forgeWithRandomKey(t, patch = {}) {
  const {header, payload} = decodeJwt(t);
  const {privateKey} = crypto.generateKeyPairSync('ed25519');
  const input = `${b64uEnc(JSON.stringify(header))}.${b64uEnc(JSON.stringify({...payload, ...patch}))}`;
  return `${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}
export const jwtSecondsLeft = t => decodeJwt(t).payload.exp - Math.floor(Date.now() / 1000);

// ---------- identities ----------
export const IDENTITIES = {
  A: {label: 'Tenant A primary commissioner', local: 'a.commissioner', name: 'Synthetic Tenant A Commissioner'},
  B: {label: 'Tenant A co-commissioner', local: 'b.cocommissioner', name: 'Synthetic Tenant A Co-Commissioner'},
  C: {label: 'Tenant B commissioner', local: 'c.tenantb.commissioner', name: 'Synthetic Tenant B Commissioner'},
  D: {label: 'Tenant A participant 1', local: 'd.participant1', name: 'Synthetic Participant One'},
  E: {label: 'Tenant A participant 2', local: 'e.participant2', name: 'Synthetic Participant Two'},
  F: {label: 'Outsider (no membership)', local: 'f.outsider', name: 'Synthetic Outsider'},
  G: {label: 'Unverified-email user', local: 'g.unverified', name: 'Synthetic Unverified User'}
};
export const syntheticEmail = key => `pp-cv1-${RUN_TAG}-${IDENTITIES[key].local}@example.com`;
export const ident = key => (secrets.identities[key] ||= {jar: {}});

// A fresh JWT for an identity: reuse the cached one while it has > 90 s left, else GET /token with the session
// cookie, else sign in again with the stored password. The token itself is never returned to a logger.
export async function jwtFor(key) {
  const id = ident(key);
  if (id.jwt && JWT_SHAPE.test(id.jwt) && jwtSecondsLeft(id.jwt) > 90) return id.jwt;
  let r = await authCall(id, 'GET', '/token');
  if (!(r.status === 200 && JWT_SHAPE.test(r.json?.token || '')) && id.password) {
    await authCall(id, 'POST', '/sign-in/email', {email: id.email, password: id.password});
    r = await authCall(id, 'GET', '/token');
  }
  if (!(r.status === 200 && JWT_SHAPE.test(r.json?.token || ''))) throw new Error(`could not obtain a JWT for ${key} (HTTP ${r.status})`);
  id.jwt = r.json.token;
  save();
  return id.jwt;
}

// ---------- recorder ----------
export class StopCondition extends Error {}
export function summarize(r) {
  if (!r || typeof r !== 'object') return scrub(JSON.stringify(r));
  const parts = [`HTTP ${r.status}`];
  if (r.code) parts.push(r.code);
  if (r.message) parts.push(scrub(r.message).slice(0, 160));
  return parts.join(' ');
}
export function recorder(section) {
  const out = {pass: 0, fail: 0, info: 0, reliability: 0};
  const write = rec => fs.appendFileSync(EVIDENCE, JSON.stringify(redact({ts: new Date().toISOString(), section, ...rec})) + '\n');
  return {
    out,
    check(id, desc, pass, detail = {}) {
      out[pass ? 'pass' : 'fail']++;
      write({id, desc, result: pass ? 'PASS' : 'FAIL', detail});
      console.log(`${pass ? 'PASS' : 'FAIL'} [${section}] ${id} ${desc}${detail.summary ? ` :: ${scrub(detail.summary)}` : ''}`);
      return pass;
    },
    info(id, desc, detail = {}) {
      out.info++;
      write({id, desc, result: 'INFO', detail});
      console.log(`INFO [${section}] ${id} ${desc}${detail.summary ? ` :: ${scrub(detail.summary)}` : ''}`);
    },
    // The NULL-identity condition outlasted its one retry, so the check could not be established. A failure (never
    // a pass), counted in fail and in reliability, and not a security finding.
    reliability(id, desc, detail = {}) {
      out.fail++;
      out.reliability++;
      write({id, desc, result: 'FAIL-RELIABILITY', detail});
      console.log(`FAIL-RELIABILITY [${section}] ${id} ${desc}${detail.summary ? ` :: ${scrub(detail.summary)}` : ''}`);
      return false;
    },
    stop(severity, id, desc, detail = {}) {
      write({id, desc, result: `STOP-${severity}`, detail});
      console.log(`STOP-${severity} [${section}] ${id} ${desc}${detail.summary ? ` :: ${scrub(detail.summary)}` : ''}`);
      throw new StopCondition(`${severity} ${section}/${id}: ${desc}`);
    }
  };
}

// Expect a reviewed RAISE code (PostgREST maps RAISE EXCEPTION to a 4xx with the text in `message`).
export const failedWith = (r, message) => r.status >= 400 && r.message === message;
export const denied = r => (r.status === 401 || r.status === 403) && (r.code === '42501' || /permission denied/i.test(r.message || ''));
export const uuid = () => crypto.randomUUID();
export const sleep = ms => new Promise(res => setTimeout(res, ms));

// ---------- identity: the NULL-identity reliability condition ----------
// Observed on the commercial endpoint: the first request served by a newly opened Data API -> Postgres backend
// connection can run with auth.user_id() = NULL although its JWT is valid, and an immediate retry succeeded. Only
// that correlation is established, not the cause inside Neon. A NULL identity fails closed (each reviewed RPC raises
// auth_required as its first statement, before it reads, locks or writes; RLS shows it no row of any table), but it
// never counts as a passed check. Every identity result is exactly one of:
//   CORRECT  the expected user id: continue
//   NULL     no identity (a null user id, or an RPC's auth_required): the same request runs once more, never a third
//            time; NULL again is a RELIABILITY failure
//   WRONG    a user id other than the expected one: P0 stop at once
//   ERROR    anything else (an HTTP or client error, an unexpected value): a failure, never a pass
export const IDENTITY = Object.freeze({CORRECT: 'CORRECT', NULL: 'NULL', WRONG: 'WRONG', ERROR: 'ERROR'});
export const authRequired = r => !!r && failedWith(r, 'auth_required');

// r is a Data API result (data()/rpc()) or a PlatformClient.rpc() outcome from clientResult().
export function classifyIdentity(expectedUserId, r) {
  if (typeof expectedUserId !== 'string' || !expectedUserId) throw new Error('classifyIdentity: the expected user id is required');
  if (r?.ok) {
    if (r.json === expectedUserId) return IDENTITY.CORRECT;
    if (r.json === null) return IDENTITY.NULL;
    return typeof r.json === 'string' && r.json !== '' ? IDENTITY.WRONG : IDENTITY.ERROR;
  }
  return authRequired(r) ? IDENTITY.NULL : IDENTITY.ERROR;
}

// PlatformClient.rpc() resolves with the RPC's value or throws; this gives it the shape of a Data API result.
export async function clientResult(call) {
  try { return {via: 'PlatformClient.rpc', ok: true, status: null, json: await call()}; }
  catch (e) { return {via: 'PlatformClient.rpc', ok: false, status: null, json: null, message: scrub(e?.message ?? e)}; }
}
const resultSummary = r => r?.via ? (r.ok ? `${r.via} resolved ${scrub(JSON.stringify(r.json))}` : `${r.via} threw: ${scrub(r.message).slice(0, 160)}`) : summarize(r);

// Runs an identity-sensitive request, and runs it once more only when isNull says the first answer is the
// NULL-identity signal. No loop: a request runs at most twice.
export async function retryOnNull(attempt, isNull = authRequired) {
  const first = await attempt();
  if (!isNull(first)) return {result: first, first, retried: false, nullAgain: false};
  const result = await attempt();
  return {result, first, retried: true, nullAgain: !!isNull(result)};
}

// An identity probe (pool_platform_current_user_id, directly or through PlatformClient.rpc): classified, retried once
// on NULL, and recorded with the expected and returned user ids. WRONG stops (P0), NULL twice is a RELIABILITY
// failure and ERROR fails. An informational probe records INFO instead of a check, but still stops on WRONG.
export async function identityProbe(rec, id, desc, expectedUserId, attempt, {informational = false} = {}) {
  const x = await retryOnNull(attempt, r => classifyIdentity(expectedUserId, r) === IDENTITY.NULL);
  const classification = classifyIdentity(expectedUserId, x.result);
  const detail = {expected_user_id: expectedUserId, returned_user_id: x.result?.ok && typeof x.result.json === 'string' ? x.result.json : null,
    classification, summary: resultSummary(x.result), attempts: x.retried ? 2 : 1,
    ...(x.retried ? {first_attempt: {classification: IDENTITY.NULL, summary: resultSummary(x.first)}} : {})};
  if (classification === IDENTITY.WRONG) rec.stop('P0', id, `${desc}: WRONG identity (a user id other than the expected one)`, detail);
  if (informational) rec.info(id, desc, detail);
  else if (classification === IDENTITY.NULL) rec.reliability(id, `${desc}: identity NULL on the request and on its one retry`, detail);
  else rec.check(id, desc, classification === IDENTITY.CORRECT, detail);
  return {classification, ...x};
}
