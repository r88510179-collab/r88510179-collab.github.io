// The same-origin Neon Auth proxy as one Vercel Function (Node.js runtime, Web fetch handler). All the behaviour is in
// server/auth-proxy-core.mjs, shared with scripts/serve.mjs; this file only adapts the host. Not deployed: hosting is a
// separate, approved gate (docs/HOSTING_ARCHITECTURE.md).
//
// vercel.json rewrites each of the four public routes to /api/auth?route=<id>. Whether the function then sees the
// public path or the rewritten one is settled at the hosting gate, so both are accepted: a request for /api/auth that
// carries exactly one known route id, and nothing else, is handed to the core as that route's own path, with no query.
// Anything else reaches the core unchanged, where it is refused like any other unknown path or query string.
// Configuration is server-only (POOL_PLATFORM_MODE, POOL_PLATFORM_AUTH_UPSTREAM_URL, POOL_PLATFORM_APP_ORIGIN) and
// fails closed: outside live mode, or when anything is missing, every request is answered 404.
import {PROXY_PREFIX,ROUTES,createAuthProxy,proxyConfigFromEnv} from '../server/auth-proxy-core.mjs';

const PATHS_BY_ID=new Map(Object.entries(ROUTES).map(([pathname,route])=>[route.id,pathname]));

export function canonicalAuthRequest(request){
  const url=new URL(request.url);
  if(url.pathname!==PROXY_PREFIX)return request;
  const keys=[...url.searchParams.keys()],id=url.searchParams.get('route');
  if(keys.length!==1||keys[0]!=='route'||!PATHS_BY_ID.has(id))return request;
  const hasBody=request.method!=='GET'&&request.method!=='HEAD';
  return new Request(new URL(PATHS_BY_ID.get(id),url.origin),{method:request.method,headers:request.headers,
    ...(hasBody?{body:request.body,duplex:'half'}:{})});
}

export function createVercelHandler(env,{fetch,log=entry=>console.log(JSON.stringify({event:'auth-proxy',...entry}))}={}){
  const proxy=createAuthProxy({config:proxyConfigFromEnv(env),log,...(fetch?{fetch}:{})});
  // x-real-ip is set by Vercel to the connecting client; it feeds only the rate-limit hook and is never sent upstream.
  return{fetch:request=>proxy(canonicalAuthRequest(request),{clientIp:request.headers.get('x-real-ip'),host:request.headers.get('host')})};
}

export default createVercelHandler(process.env);
