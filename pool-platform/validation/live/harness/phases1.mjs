// Phases: probe, signup, sdk, context, auth.
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {AUTH_URL, DATA_URL, ORIGIN, IDENTITIES, secrets, state, save, authCall, data, rpc, decodeJwt, claimsSummary,
  tamperPayload, algNone, forgeWithRandomKey, JWT_SHAPE, fp, scrub, summarize, ident, jwtFor, syntheticEmail,
  identityProbe, clientResult} from './lib.mjs';

// The repo's own client modules (pool-platform/auth-core.js, platform-client.js), three levels up from here.
const POOL_PLATFORM = path.resolve(import.meta.dirname, '..', '..', '..');
const repoModule = rel => import(pathToFileURL(path.join(POOL_PLATFORM, rel)).href);

export async function probe(rec) {
  const anon = (secrets.anon ||= {jar: {}});
  let r = await authCall(anon, 'GET', '/.well-known/jwks.json', undefined, {origin: null});
  const keys = Array.isArray(r.json?.keys) ? r.json.keys.map(k => ({kty: k.kty, crv: k.crv, alg: k.alg, kid_fp: fp(k.kid)})) : null;
  rec.check('P01', 'Neon Auth JWKS reachable', r.status === 200 && !!keys?.length, {summary: `HTTP ${r.status} keys=${JSON.stringify(keys)}`});
  r = await authCall(anon, 'GET', '/get-session', undefined, {origin: null});
  rec.check('P02', 'get-session without a cookie yields no session', r.status === 200 ? !r.json?.session : r.status === 401,
    {summary: `HTTP ${r.status} session=${!!r.json?.session} set-auth-jwt=${r.headers.get('set-auth-jwt') ? 'present' : 'absent'}`});
  r = await data('GET', '/');
  const paths = r.json && typeof r.json === 'object' && r.json.paths ? Object.keys(r.json.paths) : null;
  rec.info('P03', 'Data API root without Authorization', {summary: summarize(r), openapi_paths: paths});
  r = await data('GET', '/pool_platform_tenants?select=id');
  rec.check('P04', 'table read without Authorization is not served', !r.ok, {summary: summarize(r)});
  if (r.ok && Array.isArray(r.json) && r.json.length) rec.stop('P0', 'P04', 'anonymous read protected rows', {summary: summarize(r)});
  r = await authCall(anon, 'GET', '/token/anonymous', undefined, {origin: null});
  const at = r.json?.token;
  rec.info('P05', 'anonymous-token endpoint (/token/anonymous)', {summary: `HTTP ${r.status}`, claims: at && JWT_SHAPE.test(at) ? claimsSummary(at) : null});
  if (at && JWT_SHAPE.test(at)) {
    anon.jwt = at; save();
    const t = await data('GET', '/pool_platform_tenants?select=id', {token: at});
    rec.check('P06', 'anonymous-JWT table read is not served', !t.ok, {summary: summarize(t)});
    if (t.ok && Array.isArray(t.json) && t.json.length) rec.stop('P0', 'P06', 'anonymous JWT read protected rows', {summary: summarize(t)});
  }
}

export async function signup(rec) {
  for (const key of Object.keys(IDENTITIES)) {
    const id = ident(key);
    if (state.users[key]?.id) { rec.info(`S-${key}`, `${key} already created in this run`, {summary: state.users[key].id}); continue; }
    id.email = syntheticEmail(key);
    id.password = crypto.randomBytes(24).toString('base64url');
    id.jar = {};
    save();
    let r = await authCall(id, 'POST', '/sign-up/email', {email: id.email, password: id.password, name: IDENTITIES[key].name});
    const u = r.json?.user;
    rec.check(`S-${key}-signup`, `${key} (${IDENTITIES[key].label}) created through the public email/password sign-up`, r.status === 200 && !!u?.id,
      {summary: `HTTP ${r.status} user=${u?.id ?? '-'} emailVerified=${u?.emailVerified}${r.status !== 200 ? ` body=${scrub(r.text).slice(0, 200)}` : ''}`});
    if (!u?.id) continue;
    state.users[key] = {id: u.id, email: id.email, label: IDENTITIES[key].label, emailVerifiedAtSignup: u.emailVerified};
    save();
    rec.check(`S-${key}-unverified`, `${key} verification state as returned by Neon Auth (not set by us)`, u.emailVerified === false, {summary: `emailVerified=${u.emailVerified}`});
    id.jar = {};
    r = await authCall(id, 'POST', '/sign-in/email', {email: id.email, password: id.password});
    rec.check(`S-${key}-signin`, `${key} sign-in creates a session`, r.status === 200 && Object.keys(id.jar).length > 0,
      {summary: `HTTP ${r.status} cookie names=${Object.keys(id.jar).join(',')}${r.status !== 200 ? ` body=${scrub(r.text).slice(0, 200)}` : ''}`});
    r = await authCall(id, 'GET', '/get-session');
    const hdrJwt = r.headers.get('set-auth-jwt');
    const opaque = r.json?.session?.token;
    rec.check(`S-${key}-session`, `${key} get-session returns session + user`, r.status === 200 && r.json?.user?.id === u.id && !!r.json?.session,
      {summary: `HTTP ${r.status} user match=${r.json?.user?.id === u.id} session.token(opaque) len=${typeof opaque === 'string' ? opaque.length : '-'} jwt-shaped=${typeof opaque === 'string' && JWT_SHAPE.test(opaque)} set-auth-jwt=${hdrJwt ? `present len=${hdrJwt.length} fp=${fp(hdrJwt)}` : 'absent'}`});
    if (typeof opaque === 'string') id.sessionTokenOpaque = opaque;
    if (hdrJwt && JWT_SHAPE.test(hdrJwt)) rec.info(`S-${key}-hdrjwt`, `${key} set-auth-jwt claims`, {claims: claimsSummary(hdrJwt), sub_matches: decodeJwt(hdrJwt).payload.sub === u.id});
    r = await authCall(id, 'GET', '/token');
    const jwt = r.json?.token;
    rec.check(`S-${key}-jwt`, `${key} /token issues a JWT for the session`, r.status === 200 && JWT_SHAPE.test(jwt || ''), {summary: `HTTP ${r.status}`, claims: jwt && JWT_SHAPE.test(jwt) ? claimsSummary(jwt) : null});
    if (jwt && JWT_SHAPE.test(jwt)) {
      const c = decodeJwt(jwt).payload;
      rec.check(`S-${key}-claims`, `${key} JWT sub = Neon Auth user id; role = authenticated`, c.sub === u.id && c.role === 'authenticated',
        {summary: `sub match=${c.sub === u.id} role=${c.role} ttl=${c.exp - c.iat}s emailVerified=${c.emailVerified}`});
      id.jwt = jwt;
      secrets.firstJwts[key] = jwt;
    }
    save();
  }
}

// The pinned SDK (@neondatabase/neon-js 0.7.0-beta, the version platform-client.js loads) and the repo's own
// PlatformClient/extractAccessToken, run in Node. Node has no cookie store, so global fetch gets a cookie jar for
// the Neon Auth host (a browser keeps the same cookie); Origin is a localhost origin, which allow_localhost admits.
export async function sdk(rec, key = 'D') {
  const id = ident(key);
  const authHost = new URL(AUTH_URL).host;
  const jar = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).host !== authHost) return realFetch(input, init);
    const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
    const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) headers.set('cookie', ck);
    if (ORIGIN && !headers.has('origin')) headers.set('origin', ORIGIN);
    const res = await realFetch(url, {...init, headers});
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';'); const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      if (value && !/max-age=0/i.test(sc)) jar[name] = value; else delete jar[name];
    }
    return res;
  };
  try {
    const {createClient} = await import('@neondatabase/neon-js');
    const {extractAccessToken} = await repoModule('auth-core.js');
    const {PlatformClient} = await repoModule('platform-client.js');
    const neon = createClient({auth: {url: AUTH_URL}, dataApi: {url: DATA_URL}});
    const si = await neon.auth.signIn.email({email: id.email, password: id.password});
    rec.check('K01', `pinned SDK signIn.email (${key})`, !si?.error, {summary: si?.error ? scrub(si.error.message || JSON.stringify(si.error)) : 'ok'});
    const gs = await neon.auth.getSession();
    const tok = extractAccessToken(gs);
    const sub = tok ? decodeJwt(tok).payload.sub : null;
    rec.check('K02', 'SDK session.token carries the Neon Auth JWT where PlatformClient reads it (extractAccessToken)',
      !!tok && tok === gs?.data?.session?.token && sub === state.users[key].id,
      {summary: `session=${!!gs?.data?.session} session.token jwt-shaped=${!!tok} equals session.token=${tok === gs?.data?.session?.token} sub match=${sub === state.users[key].id}`, claims: tok ? claimsSummary(tok) : null});
    const pc = new PlatformClient({mode: 'live', authUrl: AUTH_URL, dataUrl: DATA_URL, defaultPoolSlug: 'neighborhood-pickem'});
    pc.neon = neon;
    const sess = await pc.getSession();
    rec.check('K03', 'PlatformClient.getSession() returns the signed-in user', sess?.user?.id === state.users[key].id, {summary: `user match=${sess?.user?.id === state.users[key].id}`});
    await identityProbe(rec, 'K04', 'PlatformClient.rpc() sends the session JWT; auth.user_id() resolves to the signed-in user', state.users[key].id,
      () => clientResult(() => pc.rpc('pool_platform_current_user_id')));
    await neon.auth.signOut();
    let after;
    try { after = await pc.getSession(); } catch { after = null; }
    rec.check('K05', 'after SDK signOut the client holds no session', !after, {summary: `session=${!!after}`});
  } finally {
    globalThis.fetch = realFetch;
  }
}

export async function context(rec) {
  const fx = {pools: {}, seasons: {}, weeks: {}, entries: {}, tenant: {}};
  for (const [key, slug] of [['A', 'neighborhood-pickem'], ['A', 'neighborhood-survivor'], ['C', 'second-demo-pickem']]) {
    const r = await rpc(await jwtFor(key), 'pool_platform_commissioner_context', {p_pool_slug: slug});
    rec.check(`X-${slug}`, `${key} loads the commissioner context of ${slug}`, r.ok && r.json?.pool?.slug === slug, {summary: summarize(r)});
    if (!r.ok) continue;
    const pool = r.json.pool;
    fx.pools[slug] = {id: pool.id, tenant_id: pool.tenant_id, pool_type: pool.pool_type};
    const s = r.json.seasons[0];
    fx.seasons[slug] = s.id;
    fx.weeks[slug] = Object.fromEntries(s.weeks.map(w => [w.week, {id: w.id, status: w.status, deadline_at: w.deadline_at}]));
    for (const e of s.entries) fx.entries[e.entry_code] = {id: e.id, slug, status: e.status};
  }
  fx.tenant.A = fx.pools['neighborhood-pickem']?.tenant_id;
  fx.tenant.B = fx.pools['second-demo-pickem']?.tenant_id;
  rec.check('X-tenants', 'Tenant A pools share one tenant id; Tenant B differs', !!fx.tenant.A && !!fx.tenant.B && fx.tenant.A !== fx.tenant.B && fx.pools['neighborhood-survivor']?.tenant_id === fx.tenant.A, {});
  rec.check('X-counts', 'context lists 46 Tenant A entries and 3 Tenant B entries', Object.values(fx.entries).filter(e => e.slug !== 'second-demo-pickem').length === 46 && Object.values(fx.entries).filter(e => e.slug === 'second-demo-pickem').length === 3,
    {summary: `entries=${Object.keys(fx.entries).length}`});
  state.fixtures = fx;
  save();
}

export async function auth(rec) {
  const fx = state.fixtures;
  for (const key of Object.keys(IDENTITIES)) {
    const t = await jwtFor(key);
    await identityProbe(rec, `A-${key}-uid`, `auth.user_id() (through pool_platform_current_user_id) resolves to ${key}`, state.users[key].id,
      () => rpc(t, 'pool_platform_current_user_id'));
  }
  const expect = {A: [true, false], B: [true, false], C: [false, true], D: [false, false], E: [false, false], F: [false, false], G: [false, false]};
  for (const [key, [a, b]] of Object.entries(expect)) {
    const t = await jwtFor(key);
    const ra = await rpc(t, 'pool_platform_is_tenant_commissioner', {p_tenant_id: fx.tenant.A});
    const rb = await rpc(t, 'pool_platform_is_tenant_commissioner', {p_tenant_id: fx.tenant.B});
    rec.check(`A-${key}-roles`, `${key} commissioner of Tenant A=${a}, Tenant B=${b}`, ra.ok && rb.ok && ra.json === a && rb.json === b, {summary: `A=${ra.json} B=${rb.json}`});
  }
  const base = await jwtFor('D');
  const aId = state.users.A.id;
  const cases = [
    ['N01', 'no Authorization header', null],
    ['N02', 'malformed bearer token', 'not.a.jwt'],
    ['N03', "D's JWT with sub/id changed to A (original signature)", tamperPayload(base, {sub: aId, id: aId})],
    ['N04', "D's JWT with role changed to neondb_owner (original signature)", tamperPayload(base, {role: 'neondb_owner'})],
    ['N05', 'alg=none token carrying A claims', algNone(base, {sub: aId, id: aId})],
    ['N06', 'token re-signed with a foreign Ed25519 key (same kid) carrying A claims', forgeWithRandomKey(base, {sub: aId, id: aId})],
    ['N07', 'opaque Better Auth session token used as bearer', ident('D').sessionTokenOpaque],
    ['N08', 'anonymous JWT from /token/anonymous', secrets.anon?.jwt]
  ];
  for (const [cid, desc, tok] of cases) {
    if (tok === undefined) { rec.info(cid, `${desc}: not available in this run`); continue; }
    const r = await rpc(tok, 'pool_platform_current_user_id');
    if (r.ok && typeof r.json === 'string' && r.json) rec.stop('P0', cid, `${desc} authenticated as a user`, {summary: summarize(r)});
    rec.check(cid, `${desc} does not authenticate`, !r.ok, {summary: summarize(r)});
    const t2 = await data('GET', '/pool_platform_entries?select=id', {token: tok});
    const n = Array.isArray(t2.json) ? t2.json.length : null;
    if (t2.ok && n > 0) rec.stop('P0', `${cid}-rows`, `${desc} read protected rows`, {summary: summarize(t2)});
    rec.check(`${cid}-rows`, `${desc}: protected table read returns no rows`, !t2.ok || n === 0, {summary: `${summarize(t2)} rows=${n}`});
  }
}
