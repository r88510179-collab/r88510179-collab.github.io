// The same-origin Neon Auth proxy (finding F-1). Neon Auth answers credentialed CORS for any Origin, so a browser that
// holds a Neon Auth cookie can have its session read by other pages on the same site. Here the browser never talks to
// the Neon Auth host: it calls exactly four routes on the app's own origin, and this handler forwards each one to a
// single fixed upstream endpoint. The browser then holds no cookie for the Auth host and no cookie under Neon's name:
// its session cookie is the app's own (__Host-pool-platform-session: HttpOnly, Secure, SameSite=Strict, bound to the
// app host), and every response carries no CORS headers, so no other origin can read it.
//
// Web standards only (Request in, Response out), so the same code runs in scripts/serve.mjs for the localhost gate
// and in api/auth.mjs on the host. It never makes an authorization decision: Neon validates the session and the Data
// API validates the JWT, exactly as before. What it guarantees is narrower:
//   - only the four routes below exist; the upstream protocol, host, base path and endpoint path are fixed server-side;
//   - Host is exactly the app's; POSTs carry exactly the app's Origin; Sec-Fetch-Site, when sent, is same-origin;
//     state-changing requests are application/json, small, and match a fixed schema (the OTP type is always sign-in);
//   - upstream sees the app's Origin (never the browser's), and only the session, under Neon's own cookie name (never
//     any other cookie); a request holding the app's session cookie more than once is refused, and neither is used;
//   - JavaScript never sees the opaque session token: every "token" field is removed from response bodies, a body
//     that still contains the token is refused, and set-auth-token is dropped; set-auth-jwt, the Data API bearer,
//     is passed on unchanged;
//   - the log never holds an OTP, email, body, cookie, token, JWT or Authorization value: only route, method, status,
//     duration and a fixed reason code.
import crypto from 'node:crypto';
import {normalizeEmail,validEmail,validOtp} from '../auth-core.js';
import {ConfigError,endpointUrl} from '../scripts/runtime-config.mjs';

// Server-only configuration. None of it is a secret, and none of it is ever written into the browser build.
export const PROXY_ENV=Object.freeze({
  mode:'POOL_PLATFORM_MODE',
  upstreamUrl:'POOL_PLATFORM_AUTH_UPSTREAM_URL',
  appOrigin:'POOL_PLATFORM_APP_ORIGIN'
});
export const PROXY_PREFIX='/api/auth';
// The browser's session cookie is the app's own, never Neon's, so the browser's cookie contract does not depend on what
// Neon calls its cookie. The __Host- prefix makes a conforming browser refuse to set this EXACT name with a Domain or a
// non-root Path, so a sibling subdomain cannot plant the protected cookie itself. It is not, on its own, a complete
// isolation: a sibling host can still set a DIFFERENT, non-exact name that only looks like this one (a leading NBSP,
// say), which the browser keeps distinct from the __Host- cookie and sends alongside it. The server therefore parses
// cookie names exactly (sessionCookieValue): only the byte-exact name supplies a session value, a non-exact look-alike
// never does, and an exact duplicate or a planted look-alike fails the request closed. Compromise of the exact app
// host remains outside this protection; on localhost all ports share one host and cookie namespace, which stays a
// local-gate operational concern (docs/HOSTING_ARCHITECTURE.md).
export const APP_SESSION_COOKIE='__Host-pool-platform-session';
// Neon Auth's session cookie, under the name Neon issues and reads today (whether that name is canonical and stable is
// Neon question L, docs/HOSTING_ARCHITECTURE.md). It exists only between this proxy and the upstream: the session value
// is sent to Neon under this name and comes back under it, and is mapped to and from APP_SESSION_COOKIE here.
export const UPSTREAM_SESSION_COOKIE='__Secure-neon-auth.session_token';
export const BODY_LIMIT=2048;
export const UPSTREAM_TIMEOUT_MS=10000;
const UPSTREAM_BODY_LIMIT=65536;
const JSON_DEPTH_LIMIT=16;

// Public path -> the one upstream endpoint it may reach. Nothing in a request can name another.
export const ROUTES=Object.freeze({
  [`${PROXY_PREFIX}/get-session`]:Object.freeze({id:'get-session',method:'GET',upstream:'get-session'}),
  [`${PROXY_PREFIX}/email-otp/send-verification-otp`]:Object.freeze({id:'send-otp',method:'POST',upstream:'email-otp/send-verification-otp'}),
  [`${PROXY_PREFIX}/sign-in/email-otp`]:Object.freeze({id:'verify-otp',method:'POST',upstream:'sign-in/email-otp'}),
  [`${PROXY_PREFIX}/sign-out`]:Object.freeze({id:'sign-out',method:'POST',upstream:'sign-out'})
});

export const SECURITY_HEADERS=Object.freeze({
  'cache-control':'no-store',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'cross-origin-resource-policy':'same-origin',
  'content-security-policy':"default-src 'none'; frame-ancestors 'none'"
});

// A Better Auth session cookie value is the URL-encoded "<token>.<signature>"; anything else is never re-issued or
// sent.
const COOKIE_VALUE=/^[A-Za-z0-9._~%+/=-]{1,4096}$/;
const JWT_SHAPE=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KNOWN_METHODS=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);

const REFUSALS=Object.freeze({
  400:['INVALID_REQUEST','The request was refused.'],
  401:['UNAUTHORIZED','Sign-in could not be confirmed. Clear this site\'s cookies, then sign in again.'],
  403:['FORBIDDEN','The request was refused.'],
  404:['NOT_FOUND','Not found.'],
  405:['METHOD_NOT_ALLOWED','Method not allowed.'],
  413:['PAYLOAD_TOO_LARGE','The request was refused.'],
  415:['UNSUPPORTED_MEDIA_TYPE','The request was refused.'],
  421:['MISDIRECTED_REQUEST','Open this site at its own address.'],
  429:['TOO_MANY_REQUESTS','Too many attempts. Wait a few minutes, then try again.'],
  502:['AUTH_UPSTREAM_ERROR','The sign-in service could not be reached. Try again.'],
  503:['AUTH_UNAVAILABLE','Sign-in is temporarily unavailable. Try again.']
});

// A Neon Auth host, matched label by label: ep-<endpoint>.neonauth.<region labels>.neon.tech. It must end in Neon's own
// domain, so a "neonauth" label under any other domain, or neon.tech followed by more labels, is refused.
const NEON_AUTH_HOST=/^ep-[a-z0-9]+(?:-[a-z0-9]+)*\.neonauth(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+\.neon\.tech$/;

// The Neon Auth base URL: canonical https (as endpointUrl() requires of every endpoint), a Neon Auth host on the
// default HTTPS port, and a /<database>/auth path with no trailing slash, so appending a fixed endpoint path can only
// ever produce <base>/<endpoint>. endpointUrl() already rejects a non-canonical value, which strips an explicit :443
// (so https://host:443/... is refused as non-canonical, preserving the default-port canonicalisation); here we
// additionally refuse any explicit non-default port such as :8443 or :444, which the URL parser keeps. url.port is the
// empty string exactly when the port is the HTTPS default.
export function authUpstreamUrl(raw){
  const href=endpointUrl(PROXY_ENV.upstreamUrl,raw),url=new URL(href);
  if(url.port!==''||!NEON_AUTH_HOST.test(url.hostname)||!/^\/[a-z0-9_-]+\/auth$/i.test(url.pathname)){
    throw new ConfigError(`${PROXY_ENV.upstreamUrl} must be a Neon Auth base URL of the form https://ep-<endpoint>.neonauth.<region>.neon.tech/<database>/auth on the default HTTPS port.`);
  }
  return href;
}

// The one origin the app is served from: an https origin, or http://localhost:<port> for the local gate. Exactly an
// origin (no path, no trailing slash), because it is compared as a string with Origin and sent upstream as Origin.
export function appOriginValue(raw){
  const variable=PROXY_ENV.appOrigin;
  if(typeof raw!=='string'||raw==='')throw new ConfigError(`${variable} is required when ${PROXY_ENV.mode}=live.`);
  let url;
  try{url=new URL(raw)}catch{throw new ConfigError(`${variable} is not an origin.`)}
  if(url.origin!==raw)throw new ConfigError(`${variable} must be exactly an origin: scheme, lowercase host and port only.`);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='localhost')){
    throw new ConfigError(`${variable} must be an https: origin, or http://localhost:<port> for local checks.`);
  }
  return raw;
}

// Fails closed: outside live mode, or with anything missing or malformed, the proxy is disabled and answers 404 to
// everything. The reason names the variable, never its value.
export function proxyConfigFromEnv(env={}){
  if(env[PROXY_ENV.mode]!=='live')return Object.freeze({enabled:false,reason:`${PROXY_ENV.mode} is not live`});
  try{
    return Object.freeze({enabled:true,upstreamUrl:authUpstreamUrl(env[PROXY_ENV.upstreamUrl]),appOrigin:appOriginValue(env[PROXY_ENV.appOrigin])});
  }catch(error){
    if(error instanceof ConfigError)return Object.freeze({enabled:false,reason:error.message});
    throw error;
  }
}

function jsonResponse(status,body,extra=[]){
  const headers=new Headers({...SECURITY_HEADERS,'content-type':'application/json; charset=utf-8'});
  for(const [name,value] of extra)headers.append(name,value);
  return new Response(JSON.stringify(body),{status,headers});
}

// The proxy's own refusal, with the same headers as every other proxy response. Adapters use it for requests they
// cannot hand to the core at all.
export function refusal(status,extra=[]){
  const [code,message]=REFUSALS[status];
  return jsonResponse(status,{code,message},extra);
}

// Cookie-header optional whitespace is ASCII SP (0x20) and HTAB (0x09) only (RFC 6265 cookie-string, RFC 7230 OWS). We
// strip exactly those from the ends of a cookie name and value, and nothing else: never NBSP, VT, FF, CR, LF, other
// Unicode whitespace, a BOM, or any Unicode normalisation. A cookie name is the application session only when, after
// that ASCII-only trim, it is byte-for-byte APP_SESSION_COOKIE.
const COOKIE_OWS=/^[\t ]+|[\t ]+$/g;
const stripCookieOws=s=>s.replace(COOKIE_OWS,'');

// The app session cookie from a Cookie header: {value} (null when absent, or when not a plain cookie value), or
// {conflict:true} when the request is ambiguous and must fail closed, so neither value is ever used — never the first,
// never the last. A browser sends one cookie per name, host, path and partition, so a second cookie that resolves to
// this name was set from somewhere else (another partition or port of this host, or a client that does not enforce the
// __Host- prefix). Two cases fail closed:
//   - the exact name appears more than once; or
//   - a NON-exact cookie name is present that the retired broad-trim() parser would have mistaken for this cookie — a
//     planted look-alike such as a leading NBSP before __Host-pool-platform-session. Chromium keeps such a planted
//     name distinct from the protected __Host- cookie, so it can sit beside the genuine one and is sent with it; the
//     retired parser, which trimmed Unicode whitespace from the name, would then have read the planted value as the
//     session. We never do that: the name must be byte-exact to supply a value. Detecting the look-alike here only to
//     refuse the whole request keeps a non-exact name from ever influencing a session, without re-introducing broad
//     normalisation to select one.
export function sessionCookieValue(header){
  const values=[];
  let nearMatch=false;
  for(const part of String(header??'').split(';')){
    const eq=part.indexOf('=');
    if(eq<0)continue;
    const rawName=part.slice(0,eq);
    if(stripCookieOws(rawName)===APP_SESSION_COOKIE){values.push(stripCookieOws(part.slice(eq+1)));continue}
    // Detection only, never selection: would the retired String.prototype.trim() parser have accepted this planted
    // name as the session cookie (NBSP, VT, FF, CR, LF, Unicode whitespace, BOM)? If so, refuse the whole request.
    if(rawName.trim()===APP_SESSION_COOKIE)nearMatch=true;
  }
  if(nearMatch||values.length>1)return{value:null,conflict:true};
  return{value:values.length===1&&COOKIE_VALUE.test(values[0])?values[0]:null,conflict:false};
}

// The one cookie the browser holds, set only on the app host: HttpOnly, Secure, SameSite=Strict, Path=/ and no Domain
// (exactly what __Host- requires), never Partitioned. maxAge null keeps the upstream's browser-session lifetime; 0
// deletes the cookie, so sign-out deletes it with the very attributes it was set with.
export function sessionCookie(value,maxAge){
  return [`${APP_SESSION_COOKIE}=${value}`,'Path=/',...(maxAge===null?[]:[`Max-Age=${maxAge}`]),'HttpOnly','Secure','SameSite=Strict'].join('; ');
}
export const DELETE_SESSION_COOKIE=sessionCookie('',0);

// One upstream Set-Cookie: name, value and lifetime only. Every other attribute is replaced by sessionCookie().
function parseSetCookie(line,now){
  const [pair,...attributes]=String(line).split(';');
  const at=pair.indexOf('=');
  if(at<0)return null;
  const name=pair.slice(0,at).trim(),value=pair.slice(at+1).trim();
  let maxAge=null,expires=null;
  for(const attribute of attributes){
    const eq=attribute.indexOf('='),key=(eq<0?attribute:attribute.slice(0,eq)).trim().toLowerCase(),raw=eq<0?'':attribute.slice(eq+1).trim();
    if(key==='max-age'&&/^-?\d+$/.test(raw))maxAge=Math.max(0,Number(raw));
    if(key==='expires'){const t=Date.parse(raw);if(Number.isFinite(t))expires=Math.max(0,Math.floor((t-now)/1000))}
  }
  return{name,value,maxAge:maxAge??expires};
}

// The secret strings that must never appear in a body JavaScript can read: the cookie value and its token part.
function secretsOf(value){
  if(!value)return[];
  let decoded=value;
  try{decoded=decodeURIComponent(value)}catch{}
  return [value,decoded,decoded.split('.')[0]].filter(s=>s.length>=16);
}

// Removes every property named "token", at any depth: the opaque session token is session.token in get-session and
// token in the sign-in response. The SDK fills session.token from set-auth-jwt, the Data API bearer, instead.
export function stripTokens(value,depth=0){
  if(depth>JSON_DEPTH_LIMIT)throw new Error('response nested too deeply');
  if(Array.isArray(value))return value.map(item=>stripTokens(item,depth+1));
  if(value&&typeof value==='object'){
    const out={};
    for(const [key,item] of Object.entries(value))if(key!=='token')out[key]=stripTokens(item,depth+1);
    return out;
  }
  return value;
}

// Reads at most limit bytes of a body as UTF-8. A declared or actual size over the limit is refused without reading on.
async function readLimited(message,limit){
  const declared=message.headers.get('content-length');
  if(declared!==null&&!(/^\d+$/.test(declared)&&Number(declared)<=limit))return{tooLarge:true};
  if(!message.body)return{text:''};
  const reader=message.body.getReader(),chunks=[];
  let size=0;
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>limit){await reader.cancel().catch(()=>{});return{tooLarge:true}}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  return{text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
}

const mediaType=headers=>(headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
const exactKeys=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

// The only bodies each POST route accepts, and what is sent upstream for them; {reason} when refused.
function upstreamBody(route,body){
  if(route.id==='send-otp'){
    if(!exactKeys(body,['email','type'])||typeof body.email!=='string')return{reason:'schema'};
    if(body.type!=='sign-in')return{reason:'otp-type'};
    const email=normalizeEmail(body.email);
    return validEmail(email)?{body:{email,type:'sign-in'},email}:{reason:'schema'};
  }
  if(route.id==='verify-otp'){
    if(!exactKeys(body,['email','otp'])||typeof body.email!=='string'||typeof body.otp!=='string')return{reason:'schema'};
    const email=normalizeEmail(body.email);
    return validEmail(email)&&validOtp(body.otp)?{body:{email,otp:body.otp.trim()},email}:{reason:'schema'};
  }
  return exactKeys(body,[])?{body:{}}:{reason:'schema'}; // sign-out: the SDK sends {}
}

// The rate-limit hook sees a keyed hash of the normalized email, never the email itself.
export const emailKey=email=>crypto.createHash('sha256').update(`pool-platform-otp\u0000${email}`).digest('hex');

// Builds the request handler. config comes from proxyConfigFromEnv(). fetch is the upstream fetch (injectable for
// tests), log receives one plain object per request, and rateLimit, when given, is asked before an OTP is sent or
// verified: ({route, clientIp, emailKey}) => true to allow. No store is bundled; see docs/HOSTING_ARCHITECTURE.md.
export function createAuthProxy({config,fetch:upstreamFetch=globalThis.fetch,log=()=>{},rateLimit=null,timeoutMs=UPSTREAM_TIMEOUT_MS}={}){
  const enabled=config?.enabled===true;
  const appOrigin=enabled?config.appOrigin:null,appHost=enabled?new URL(config.appOrigin).host:null;
  const upstreamBase=enabled?config.upstreamUrl:null;

  return async function handleAuthRequest(request,{clientIp=null,host}={}){
    const started=Date.now();
    let route=null;
    const finish=(response,reason=null)=>{
      log({route:route?.id??null,method:KNOWN_METHODS.has(request.method)?request.method:'OTHER',status:response.status,ms:Date.now()-started,...(reason?{reason}:{})});
      return response;
    };
    if(!enabled)return finish(refusal(404),'disabled');
    let url;
    try{url=new URL(request.url)}catch{return finish(refusal(400),'url')}
    if((host??request.headers.get('host'))!==appHost)return finish(refusal(421),'host');
    route=ROUTES[url.pathname]??null;
    if(!route)return finish(refusal(404),'route');
    if(request.method!==route.method)return finish(refusal(405,[['allow',route.method]]),'method');
    if(url.search!=='')return finish(refusal(400),'query');
    const site=request.headers.get('sec-fetch-site'),mode=request.headers.get('sec-fetch-mode');
    if(site!==null&&site!=='same-origin')return finish(refusal(403),'fetch-site');
    if(mode!==null&&mode!=='cors'&&mode!=='same-origin')return finish(refusal(403),'fetch-mode');
    const origin=request.headers.get('origin');
    if(route.method==='POST'?origin!==appOrigin:origin!==null&&origin!==appOrigin)return finish(refusal(403),'origin');
    // The app session cookie more than once: refused on every route before anything else happens. Neither value reaches
    // Neon, and no cookie is set or deleted: deleting this host's own cookie could leave the other one as the only
    // session cookie, to be sent with the next request.
    const cookie=sessionCookieValue(request.headers.get('cookie'));
    if(cookie.conflict)return finish(refusal(401),'cookie-conflict');

    let sent;
    if(route.method==='POST'){
      if(mediaType(request.headers)!=='application/json')return finish(refusal(415),'content-type');
      let read;
      try{read=await readLimited(request,BODY_LIMIT)}catch{return finish(refusal(400),'body')}
      if(read.tooLarge)return finish(refusal(413),'body-size');
      let parsed;
      try{parsed=JSON.parse(read.text)}catch{return finish(refusal(400),'body')}
      sent=upstreamBody(route,parsed);
      if(sent.reason)return finish(refusal(400),sent.reason);
      if(rateLimit&&sent.email!==undefined){
        let allowed;
        try{allowed=await rateLimit({route:route.id,clientIp,emailKey:emailKey(sent.email)})}catch{return finish(refusal(503),'rate-limit-error')}
        if(allowed!==true)return finish(refusal(429),'rate-limit');
      }
    }

    const session=cookie.value;
    // No session cookie: there is nothing to look up, and Neon's answer would be the same null.
    if(route.id==='get-session'&&!session)return finish(jsonResponse(200,null));

    const headers=new Headers({accept:'application/json',origin:appOrigin});
    const agent=request.headers.get('user-agent');
    if(agent)headers.set('user-agent',agent.slice(0,512));
    if(sent)headers.set('content-type','application/json');
    // Upstream gets one cookie, built here: the app session value under Neon's cookie name. No browser cookie is passed.
    if(session&&(route.id==='get-session'||route.id==='sign-out'))headers.set('cookie',`${UPSTREAM_SESSION_COOKIE}=${session}`);
    // Signing out always deletes the app-host cookie, whatever Neon answers.
    const always=route.id==='sign-out'?[['set-cookie',DELETE_SESSION_COOKIE]]:[];

    let upstream;
    try{
      upstream=await upstreamFetch(`${upstreamBase}/${route.upstream}`,{method:route.method,headers,body:sent?JSON.stringify(sent.body):undefined,
        redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});
    }catch{return finish(refusal(502,always),'upstream-unreachable')}
    if(upstream.status>=300&&upstream.status<400||upstream.status>=500){
      upstream.body?.cancel().catch(()=>{});
      return finish(refusal(502,always),'upstream-status');
    }

    let text;
    try{
      const read=await readLimited(upstream,UPSTREAM_BODY_LIMIT);
      if(read.tooLarge)return finish(refusal(502,always),'upstream-size');
      text=read.text;
    }catch{return finish(refusal(502,always),'upstream-body')}
    let data=null;
    if(text!==''){
      if(mediaType(upstream.headers)!=='application/json')return finish(refusal(502,always),'upstream-type');
      try{data=JSON.parse(text)}catch{return finish(refusal(502,always),'upstream-body')}
    }

    // Cookies: only Neon's session cookie is ever passed on, and only as the app's own cookie (its value and lifetime;
    // every upstream attribute is replaced), by the routes that establish or refresh a session, and only on success;
    // Neon ending a session (an empty value) is passed on whatever the status. No upstream cookie name reaches the
    // browser.
    const now=Date.now(),cookies=[...always],secrets=secretsOf(session);
    let dropped=0;
    for(const line of upstream.headers.getSetCookie()){
      const upstreamCookie=parseSetCookie(line,now);
      const neonSession=upstreamCookie?.name===UPSTREAM_SESSION_COOKIE;
      if(neonSession)secrets.push(...secretsOf(upstreamCookie.value));
      const reissue=neonSession&&(route.id==='get-session'||route.id==='verify-otp')&&
        (upstreamCookie.value===''||upstream.status<400&&COOKIE_VALUE.test(upstreamCookie.value));
      if(reissue)cookies.push(['set-cookie',upstreamCookie.value===''?DELETE_SESSION_COOKIE:sessionCookie(upstreamCookie.value,upstreamCookie.maxAge)]);
      else if(!(route.id==='sign-out'&&neonSession))dropped++;
    }

    let body;
    if(upstream.status>=400){
      // Neon's own error code and message (the SDK shows the message), nothing else from the body.
      const pick=key=>typeof data?.[key]==='string'?data[key].slice(0,300):undefined;
      body={code:pick('code')??'AUTH_ERROR',message:pick('message')??'The request could not be completed.'};
    }else if(route.id==='send-otp'||route.id==='sign-out'){
      body={success:data?.success===true};
    }else{
      try{body=stripTokens(data)}catch{return finish(refusal(502,always),'upstream-body')}
    }
    const serialized=JSON.stringify(body);
    if(secrets.some(secret=>serialized.includes(secret)))return finish(refusal(502,always),'token-in-body');

    const extra=[...cookies];
    const jwt=upstream.headers.get('set-auth-jwt');
    if(upstream.status<400&&(route.id==='get-session'||route.id==='verify-otp')&&jwt&&JWT_SHAPE.test(jwt))extra.push(['set-auth-jwt',jwt]);
    // Every success is answered 200 with a JSON body (a 204 could carry none).
    return finish(jsonResponse(upstream.status<400?200:upstream.status,body,extra),dropped?`dropped-cookies:${dropped}`:null);
  };
}
