// Caller authentication for the sender's protected routes.
//  * Publisher JWT: the Admin page's own Neon Auth session token (EdDSA, verified against the Auth JWKS, issuer and
//    audience = the Auth origin, unexpired, verified e-mail equal to the one publisher). Used by "notify now" after a
//    verified publication and by the Admin page's Pool Alerts maintenance panel.
//  * Owner token: a random secret the owner keeps (GitHub Actions secret / password manager); the sender stores only
//    its SHA-256. Used by the maintenance workflow and command-line tool.
//  * Status token: a separate read-only secret for the Maintenance Center's status panel.
import {createHash, timingSafeEqual} from 'node:crypto';

const B64URL = /^[A-Za-z0-9_-]+$/;
const decodeJson = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/.exec(header);
  return match ? match[1] : null;
}

export function sha256Hex(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
export function digestMatches(token, expectedHex) {
  if (typeof token !== 'string' || !expectedHex) return false;
  const actual = Buffer.from(sha256Hex(token), 'hex'), expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createJwtVerifier({jwksUrl, issuer, audience, publisherEmail, fetcher = fetch, now = () => Date.now(), cacheMs = 10 * 60000}) {
  let cached = null, cachedAt = 0, pending = null;
  async function loadKeys(force) {
    if (!force && cached && now() - cachedAt < cacheMs) return cached;
    if (!pending) {
      pending = (async () => {
        const response = await fetcher(jwksUrl, {headers: {Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(8000)});
        if (!response.ok) throw new Error(`JWKS unavailable (${response.status})`);
        const body = await response.json();
        if (!Array.isArray(body?.keys)) throw new Error('JWKS malformed');
        cached = body.keys.filter(k => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && typeof k.kid === 'string');
        cachedAt = now();
        return cached;
      })().finally(() => { pending = null; });
    }
    return pending;
  }
  return async function verifyPublisher(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(p => p && B64URL.test(p))) return null;
    let header, payload;
    try { header = decodeJson(parts[0]); payload = decodeJson(parts[1]); } catch { return null; }
    if (header?.alg !== 'EdDSA' || typeof header.kid !== 'string') return null;
    let jwk = (await loadKeys(false)).find(k => k.kid === header.kid);
    if (!jwk) jwk = (await loadKeys(true)).find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', {kty: 'OKP', crv: 'Ed25519', x: jwk.x}, {name: 'Ed25519'}, false, ['verify']);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify({name: 'Ed25519'}, key, Buffer.from(parts[2], 'base64url'), signed);
    if (!valid) return null;
    const seconds = now() / 1000;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== issuer || !audiences.includes(audience)) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= seconds) return null;
    if (Number.isFinite(payload.nbf) && payload.nbf > seconds + 60) return null;
    if (Number.isFinite(payload.iat) && payload.iat > seconds + 60) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== publisherEmail) return null;
    if (payload.emailVerified !== true || payload.banned === true) return null;
    return {sub: payload.sub};
  };
}
