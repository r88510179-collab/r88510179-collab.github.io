// Reads what every Pool Center visitor reads: the public, anonymous Data API. A notification is sent only after this
// path returns the exact locked revision, so nothing is announced that a participant could not open.
import {publicationIdentity, weekKey} from './core.mjs';

const TIMEOUT_MS = 10000;

function jwtExpiry(token) {
  try {
    const part = token.split('.')[1];
    const exp = Number(JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))?.exp);
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch { return 0; }
}

export function createPublicReader({authUrl, dataUrl, fetcher = fetch, now = () => Date.now()}) {
  let token = null, expiresAt = 0;
  async function get(url, headers = {}) {
    const response = await fetcher(url, {
      headers: {Accept: 'application/json', ...headers}, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw Object.assign(new Error(`public read failed (${response.status})`), {errorClass: `public-read-${response.status}`});
    return response.json();
  }
  async function anonymousToken() {
    if (token && now() < expiresAt - 60000) return token;
    const body = await get(`${authUrl}/token/anonymous`);
    if (typeof body?.token !== 'string' || body.token.split('.').length !== 3) {
      throw Object.assign(new Error('anonymous token unavailable'), {errorClass: 'public-token'});
    }
    token = body.token;
    expiresAt = jwtExpiry(token) || now() + 5 * 60000;
    return token;
  }
  async function rows(query) {
    const data = await get(`${dataUrl}/nfl_pool_weeks?${query}`, {Authorization: `Bearer ${await anonymousToken()}`});
    if (!Array.isArray(data)) throw Object.assign(new Error('public read returned no list'), {errorClass: 'public-read-shape'});
    return data;
  }
  return {
    // The current public row of one week, or null when the week is not publicly readable.
    async readWeek(season, week) {
      const data = await rows(`select=season,week,revision,status,published_at&status=eq.locked&season=eq.${season}&week=eq.${week}`);
      if (data.length > 1) throw Object.assign(new Error('public read returned duplicate weeks'), {errorClass: 'public-read-shape'});
      return data.length ? data[0] : null;
    },
    // Every locked week: the same index the app's week selector uses. A malformed or repeated row voids the whole index.
    async readIndex() {
      const data = await rows('select=season,week,revision,status,published_at&status=eq.locked&order=season.asc,week.asc');
      const seen = new Set();
      return data.map(row => {
        const id = publicationIdentity(row), key = weekKey(id.season, id.week);
        if (seen.has(key)) throw Object.assign(new Error('public index repeats a week'), {errorClass: 'public-read-shape'});
        seen.add(key);
        return id;
      });
    }
  };
}
