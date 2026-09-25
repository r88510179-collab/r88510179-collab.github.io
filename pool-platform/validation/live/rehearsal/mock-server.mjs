// LOCAL REHEARSAL ONLY (never evidence): a small Better Auth look-alike and a PostgREST-style Data API over a local
// PostgreSQL replica (stub neon_auth."user", stub auth.user_id() reading pp_test.user_id, migrations 001+002 applied as
// a NOLOGIN owner). Its only purpose is to debug the live harness before the real Neon endpoints are reachable.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const DB = process.env.MOCK_PG || 'postgresql://postgres@127.0.0.1:55432/rehearsal';
const AUTH_PORT = 18081, DATA_PORT = 18082, TTL = Number(process.env.MOCK_JWT_TTL || 900);
const OTP_FILE = process.env.MOCK_OTP_FILE || '/dev/null';
const pool = new pg.Pool({connectionString: DB, max: 30});
const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');
const kid = crypto.randomUUID();
const jwk = {...publicKey.export({format: 'jwk'}), kid, alg: 'EdDSA', use: 'sig'};
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = payload => { const input = `${b64({alg: 'EdDSA', kid, typ: 'JWT'})}.${b64(payload)}`; return `${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString('base64url')}`; };
function verify(tok) {
  const parts = String(tok).split('.');
  if (parts.length !== 3) return {error: 'PGRST301'};
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (header.alg !== 'EdDSA' || header.kid !== kid) return {error: 'PGRST301'};
    if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) return {error: 'PGRST301'};
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (payload.exp <= Math.floor(Date.now() / 1000)) return {error: 'PGRST303'};
    return {payload};
  } catch { return {error: 'PGRST301'}; }
}
const body = req => new Promise(res => { let s = ''; req.on('data', c => s += c); req.on('end', () => res(s)); });
const send = (res, status, obj, headers = {}) => { res.writeHead(status, {'content-type': 'application/json', ...headers}); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

// ---------------- auth ----------------
const passwords = new Map(), sessions = new Map(), otps = new Map();
const cookieOf = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]));
const sessionOf = req => sessions.get(cookieOf(req)['mock.session_token']);
async function userBy(field, v) { const r = await pool.query(`SELECT id::text,name,email,"emailVerified",banned FROM neon_auth."user" WHERE ${field}=$1`, [v]); return r.rows[0] || null; }
const userJson = u => u && ({id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerified, image: null, banned: u.banned ?? false});
function newSession(res, u) {
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, u.id);
  res.setHeader('set-cookie', `mock.session_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
  return token;
}
const jwtFor = u => { const iat = Math.floor(Date.now() / 1000); return sign({iat, exp: iat + TTL, sub: u.id, id: u.id, email: u.email, emailVerified: u.emailVerified, role: 'authenticated', name: u.name, iss: 'http://127.0.0.1:18081', aud: 'http://127.0.0.1:18081'}); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/neondb\/auth/, '');
  const raw = await body(req);
  const j = raw ? JSON.parse(raw) : {};
  try {
    if (p === '/.well-known/jwks.json') return send(res, 200, {keys: [jwk]});
    if (p === '/sign-up/email' && req.method === 'POST') {
      if (await userBy('email', j.email.toLowerCase())) return send(res, 422, {code: 'USER_ALREADY_EXISTS', message: 'User already exists'});
      const r = await pool.query(`INSERT INTO neon_auth."user"(name,email,"emailVerified") VALUES ($1,$2,false) RETURNING id::text,name,email,"emailVerified",banned`, [j.name, j.email.toLowerCase()]);
      passwords.set(j.email.toLowerCase(), j.password);
      const token = newSession(res, r.rows[0]);
      return send(res, 200, {token, user: userJson(r.rows[0])});
    }
    if (p === '/sign-in/email' && req.method === 'POST') {
      const u = await userBy('email', j.email.toLowerCase());
      if (!u || passwords.get(u.email) !== j.password) return send(res, 401, {code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password'});
      const token = newSession(res, u);
      return send(res, 200, {redirect: false, token, url: null, user: userJson(u)});
    }
    if (p === '/get-session') {
      const uid = sessionOf(req);
      if (!uid) return send(res, 200, null);
      const u = await userBy('id::text', uid);
      return send(res, 200, {session: {token: cookieOf(req)['mock.session_token'], userId: uid, expiresAt: new Date(Date.now() + 7 * 864e5).toISOString()}, user: userJson(u)}, {'set-auth-jwt': jwtFor(u)});
    }
    if (p === '/token') {
      const uid = sessionOf(req);
      if (!uid) return send(res, 401, {code: 'UNAUTHORIZED', message: 'Unauthorized'});
      return send(res, 200, {token: jwtFor(await userBy('id::text', uid))});
    }
    if (p === '/token/anonymous') { const iat = Math.floor(Date.now() / 1000); return send(res, 200, {token: sign({iat, exp: iat + TTL, role: 'anonymous', iss: 'http://127.0.0.1:18081'}), expires_at: iat + TTL}); }
    if (p === '/sign-out' && req.method === 'POST') { sessions.delete(cookieOf(req)['mock.session_token']); return send(res, 200, {success: true}, {'set-cookie': 'mock.session_token=; Path=/; Max-Age=0'}); }
    if (p === '/email-otp/send-verification-otp' && req.method === 'POST') {
      const otp = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      otps.set(j.email.toLowerCase(), otp);
      fs.writeFileSync(OTP_FILE, otp);
      return send(res, 200, {success: true});
    }
    if (p === '/sign-in/email-otp' && req.method === 'POST') {
      if (otps.get(j.email.toLowerCase()) !== String(j.otp)) return send(res, 400, {code: 'INVALID_OTP', message: 'Invalid OTP'});
      otps.delete(j.email.toLowerCase());
      let u = await userBy('email', j.email.toLowerCase());
      if (!u) u = (await pool.query(`INSERT INTO neon_auth."user"(name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id::text,name,email,"emailVerified",banned`, [j.email.split('@')[0], j.email.toLowerCase()])).rows[0];
      else u = (await pool.query(`UPDATE neon_auth."user" SET "emailVerified"=true WHERE id::text=$1 RETURNING id::text,name,email,"emailVerified",banned`, [u.id])).rows[0];
      const token = newSession(res, u);
      return send(res, 200, {token, user: userJson(u)});
    }
    return send(res, 404, {message: 'not found'});
  } catch (e) { return send(res, 500, {message: String(e.message)}); }
}).listen(AUTH_PORT, '127.0.0.1');

// ---------------- data api ----------------
const pgErr = (res, e, role) => {
  const st = e.code === '42501' ? (role === 'anonymous' ? 401 : 403) : e.code === 'P0001' || /^22|^23/.test(e.code || '') ? 400 : e.code === 'PGRST202' ? 404 : 400;
  return send(res, st, {code: e.code || null, message: e.message, details: e.detail ?? null, hint: e.hint ?? null});
};
function filters(params, args) {
  const where = [];
  for (const [col, v] of params) {
    if (col === 'select') continue;
    if (!/^[a-z_]+$/.test(col)) throw Object.assign(new Error('bad column'), {code: 'PGRST100'});
    const m = v.match(/^(eq|gt|in)\.(.*)$/);
    if (!m) throw Object.assign(new Error('bad filter'), {code: 'PGRST100'});
    if (m[1] === 'eq') { args.push(m[2]); where.push(`${col}::text=$${args.length}`); }
    if (m[1] === 'gt') { args.push(m[2]); where.push(`${col}>$${args.length}`); }
    if (m[1] === 'in') { args.push(m[2].replace(/^\(|\)$/g, '').split(',')); where.push(`${col}::text=ANY($${args.length}::text[])`); }
  }
  return where.length ? ` WHERE ${where.join(' AND ')}` : '';
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/neondb\/rest\/v1/, '');
  const raw = await body(req);
  const prof = req.headers['accept-profile'] || req.headers['content-profile'];
  if (prof && prof !== 'public') return send(res, 406, {code: 'PGRST106', message: 'The schema must be one of the following: public', details: null, hint: null});
  let role = 'anonymous', sub = '';
  const authz = req.headers.authorization;
  if (authz) {
    const v = verify(authz.replace(/^Bearer\s+/i, ''));
    if (v.error) return send(res, 401, {code: v.error, message: v.error === 'PGRST303' ? 'JWT expired' : 'JWT invalid', details: null, hint: null});
    role = v.payload.role; sub = v.payload.sub || '';
    if (!['anonymous', 'authenticated'].includes(role)) return send(res, 401, {code: '22023', message: `role "${role}" does not exist`});
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('pp_test.user_id',$1,true)`, [sub]);
    let out;
    if (p === '/' ) {
      const r = await client.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' UNION ALL SELECT 'rpc/'||proname FROM pg_proc WHERE pronamespace='public'::regnamespace`);
      out = [200, {paths: Object.fromEntries(r.rows.map(x => [`/${x.relname}`, {}]))}];
    } else if (p.startsWith('/rpc/')) {
      const fn = p.slice(5);
      const ctype = req.headers['content-type'] || 'application/json';
      const fns = (await client.query(`SELECT p.oid,p.proname,COALESCE(p.proargnames,'{}') AS names,ARRAY(SELECT format_type(t,NULL) FROM unnest(p.proargtypes) t) AS types,p.pronargs,format_type(p.prorettype,NULL) AS ret
        FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=$1 AND p.prorettype<>'trigger'::regtype`, [fn])).rows;
      let call, args = [];
      if (/json/.test(ctype)) {
        const j = raw ? JSON.parse(raw) : {};
        const keys = Object.keys(j).sort();
        const f = fns.find(x => JSON.stringify([...x.names].slice(0, x.pronargs).sort()) === JSON.stringify(keys));
        if (!f) throw Object.assign(new Error(`Could not find the function public.${fn}(${keys.join(', ')}) in the schema cache`), {code: 'PGRST202'});
        const parts = f.names.slice(0, f.pronargs).map((n, i) => { const v = j[n]; args.push(v === null || v === undefined ? null : f.types[i] === 'jsonb' || f.types[i] === 'json' ? JSON.stringify(v) : String(v)); return `${n} => $${args.length}::${f.types[i]}`; });
        call = `SELECT to_jsonb(public.${fn}(${parts.join(', ')})) AS r`;
      } else {
        const f = fns.find(x => x.pronargs === 1 && (!x.names.length || x.names[0] === '') && ['text', 'json', 'jsonb', 'bytea', 'xml'].includes(x.types[0]));
        if (!f) throw Object.assign(new Error(`Could not find the function public.${fn} in the schema cache`), {code: 'PGRST202'});
        args = [raw]; call = `SELECT to_jsonb(public.${fn}($1::${f.types[0]})) AS r`;
      }
      const r = await client.query(call, args);
      out = [200, r.rows[0].r];
    } else {
      const tbl = p.slice(1);
      if (!/^[a-z_]+$/.test(tbl)) throw Object.assign(new Error('bad table'), {code: 'PGRST100'});
      const args = [];
      if (req.method === 'GET') {
        const sel = url.searchParams.get('select') || '*';
        if (!/^[a-z_,*]+$/.test(sel)) throw Object.assign(new Error('bad select'), {code: 'PGRST100'});
        const r = await client.query(`SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]'::jsonb) AS r FROM (SELECT ${sel} FROM public.${tbl}${filters(url.searchParams, args)}) x`, args);
        out = [200, r.rows[0].r];
      } else if (req.method === 'POST') {
        const j = JSON.parse(raw || '{}'); const cols = Object.keys(j).filter(c => /^[a-z_]+$/.test(c));
        args.push(JSON.stringify(j));
        await client.query(`INSERT INTO public.${tbl}(${cols.join(',')}) SELECT ${cols.join(',')} FROM jsonb_populate_record(NULL::public.${tbl}, $1::jsonb)`, args);
        out = [201, undefined];
      } else if (req.method === 'PATCH') {
        const j = JSON.parse(raw || '{}'); const cols = Object.keys(j).filter(c => /^[a-z_]+$/.test(c));
        args.push(JSON.stringify(j));
        await client.query(`UPDATE public.${tbl} SET (${cols.join(',')})=(SELECT ${cols.join(',')} FROM jsonb_populate_record(NULL::public.${tbl}, $1::jsonb))${filters(url.searchParams, args)}`, args);
        out = [204, undefined];
      } else if (req.method === 'DELETE') {
        await client.query(`DELETE FROM public.${tbl}${filters(url.searchParams, args)}`, args);
        out = [204, undefined];
      }
    }
    await client.query('COMMIT');
    return send(res, out[0], out[1]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return pgErr(res, e, role);
  } finally { client.release(); }
}).listen(DATA_PORT, '127.0.0.1');
console.log(`mock auth :${AUTH_PORT} data :${DATA_PORT} ttl=${TTL}s`);
