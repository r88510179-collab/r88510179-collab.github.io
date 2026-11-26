// Local / self-hosted adapter: serves the same Fetch handler with node:http (tests, staging rehearsals, or a host other
// than Neon Functions). It never runs cycles on a timer: schedule POST /v1/cron with the X-Neon-Trigger-Invocation-Id
// header from a trusted scheduler, exactly as the Neon Function Trigger does.
import http from 'node:http';

export function serve(app, {port = 0, host = '127.0.0.1'} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const request = new Request(`http://${req.headers.host || host}${req.url}`, {method: req.method, headers,
        body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks)});
      const response = await app.fetch(request);
      const out = {};
      response.headers.forEach((value, name) => { out[name] = value; });
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, {'Content-Type': 'application/json'});
      res.end('{"error":"internal"}');
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const {buildFromEnv} = await import('./index.mjs');
  const server = await serve(buildFromEnv(process.env), {port: Number(process.env.PORT || 8787), host: process.env.HOST || '127.0.0.1'});
  console.log(`Pool Alerts sender listening on http://${server.address().address}:${server.address().port}`);
}
