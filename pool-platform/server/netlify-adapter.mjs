// The same-origin Neon Auth proxy as two Netlify Functions (netlify/functions/auth-otp.mjs and auth-session.mjs). All
// the behaviour is in server/auth-proxy-core.mjs, shared with scripts/serve.mjs and api/auth.mjs; this file only
// adapts the host. Not deployed: hosting is a separate, approved gate (docs/HOSTING_ARCHITECTURE.md).
//
// Netlify calls a function with the Web Request it received and a Context. The Request goes to the core as it is, with
// the raw Host header (request.headers.get('host')) and Netlify's client IP (context.ip), which feeds only the
// rate-limit hook and is never sent upstream. Nothing else of the Context is read (never context.cookies), so the
// session reaches the core only in the request's own Cookie header, parsed there and nowhere else, and the core's
// Response, Set-Cookie lines included, is what Netlify sends back. The two functions exist for Netlify's code-based rate limits: auth-otp serves
// the two Email OTP routes under the stricter limit, and auth-session serves the other two and every other path under
// /api/auth, which the core answers with its own 404 or 405. Each function refuses a route it does not own, so no
// difference between Netlify's path matching and the URL the Request carries (a dot segment, say) can move an OTP
// route under the looser limit. Configuration is server-only and fails closed, as in api/auth.mjs: outside live mode,
// or when anything is missing, every request is answered 404.
import {ROUTES,createAuthProxy,proxyConfigFromEnv,refusal} from './auth-proxy-core.mjs';

// The public routes each function serves, by the core's route id. Each function's config routes exactly their paths
// (netlify-adapter.test.mjs).
export const FUNCTION_ROUTES=Object.freeze({
  'auth-otp':Object.freeze(['send-otp','verify-otp']),
  'auth-session':Object.freeze(['get-session','sign-out'])
});
// The methods a log line names, as the core names them; anything else is logged as OTHER.
const LOGGED_METHODS=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);

const routeOf=request=>{try{return ROUTES[new URL(request.url).pathname]??null}catch{return null}};

// name is the function's own (its file name). fetch is the upstream fetch and log receives one plain object per
// request, as for the core; createProxy is the core's factory, replaceable only so that tests can watch what the
// adapter hands the core.
export function createNetlifyHandler(name,env,{fetch,log=entry=>console.log(JSON.stringify({event:'auth-proxy',...entry})),createProxy=createAuthProxy}={}){
  const owned=FUNCTION_ROUTES[name];
  if(!owned)throw new Error(`${name} is not one of the Netlify Auth functions (${Object.keys(FUNCTION_ROUTES).join(', ')})`);
  const proxy=createProxy({config:proxyConfigFromEnv(env),log,...(fetch?{fetch}:{})});
  return async function netlifyAuthHandler(request,context){
    const started=Date.now(),route=routeOf(request);
    // The adapter's own answers are the core's refusals, logged as the core logs: route, method, status, duration and
    // a fixed reason, never a value from the request.
    const refuse=(status,reason)=>{
      log({route:route?.id??null,method:LOGGED_METHODS.has(request.method)?request.method:'OTHER',status,ms:Date.now()-started,reason});
      return refusal(status);
    };
    if(route&&!owned.includes(route.id))return refuse(404,'function-route');
    try{
      const ip=context?.ip; // read once
      return await proxy(request,{clientIp:typeof ip==='string'?ip:null,host:request.headers.get('host')});
    }catch{
      // As scripts/serve.mjs does: an exception becomes the core's generic 502, so no platform error page or message
      // ever answers for the proxy.
      return refuse(502,'adapter-error');
    }
  };
}
