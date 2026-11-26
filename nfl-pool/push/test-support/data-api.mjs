// A local stand-in for the Personal Pool's public Neon Auth + Data API, for tests. /token/anonymous hands out an
// unsigned anonymous token; /rest/v1/nfl_pool_weeks runs the request against the real test database AS THE anonymous
// ROLE, so row-level security decides what is visible exactly as it does for a Pool Center visitor. The JWKS route
// serves the publisher's test signing key. outage() makes every route answer 503.
import http from 'node:http';

export async function startDataApi({adminPool, jwks}) {
  let down = false;
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (down) return send(503, {error: 'outage'});
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/auth/token/anonymous') {
      const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
      return send(200, {token: `${enc({alg: 'none'})}.${enc({role: 'anonymous', exp: Math.floor(Date.now() / 1000) + 900})}.x`});
    }
    if (url.pathname === '/auth/.well-known/jwks.json') return send(200, jwks);
    if (url.pathname !== '/rest/v1/nfl_pool_weeks' || !/^Bearer .+/.test(req.headers.authorization || '')) return send(404, {});
    const where = [], params = [];
    for (const name of ['status', 'season', 'week']) {
      const value = url.searchParams.get(name);
      if (value === null) continue;
      const m = /^eq\.(.+)$/.exec(value);
      if (!m) return send(400, {});
      params.push(m[1]);
      where.push(`${name} = $${params.length}${name === 'status' ? '' : '::integer'}`);
    }
    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', '{\"role\":\"anonymous\"}', true)");
      await client.query('SET LOCAL ROLE anonymous');
      const rows = (await client.query(`SELECT season, week, revision, status, to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS published_at
          FROM public.nfl_pool_weeks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY season, week`, params)).rows;
      await client.query('COMMIT');
      send(200, rows);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      send(500, {error: error.message});
    } finally { client.release(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    authUrl: `${base}/auth`, dataUrl: `${base}/rest/v1`, jwksUrl: `${base}/auth/.well-known/jwks.json`, issuer: base,
    outage(on) { down = on; },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}
