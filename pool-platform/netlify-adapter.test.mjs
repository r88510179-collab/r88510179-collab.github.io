import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  APP_SESSION_COOKIE,DELETE_SESSION_COOKIE,PROXY_PREFIX,ROUTES,SECURITY_HEADERS,UPSTREAM_SESSION_COOKIE,createAuthProxy,proxyConfigFromEnv
} from './server/auth-proxy-core.mjs';
import {FUNCTION_ROUTES,createNetlifyHandler} from './server/netlify-adapter.mjs';
import otpHandler,{config as otpConfig} from './netlify/functions/auth-otp.mjs';
import sessionHandler,{config as sessionConfig} from './netlify/functions/auth-session.mjs';

// The same-origin Neon Auth proxy on Netlify Functions: two functions, one thin adapter, and the reviewed core
// (server/auth-proxy-core.mjs) unchanged. Deterministic and offline: Neon Auth is the same in-memory stand-in as in
// auth-proxy-core.test.mjs, the Netlify Context is a recording stand-in, and every value is a synthetic shape. What
// Netlify itself does at its edge (routing, Host, the Cookie header it delivers, headers it adds) is not testable here
// and is listed for the hosting spike in docs/HOSTING_ARCHITECTURE.md.
const UPSTREAM='https://ep-example-000000.neonauth.c-0.us-east-2.aws.neon.tech/neondb/auth';
const APP='https://pools.example.test',HOST='pools.example.test';
const ENV={POOL_PLATFORM_MODE:'live',POOL_PLATFORM_AUTH_UPSTREAM_URL:UPSTREAM,POOL_PLATFORM_APP_ORIGIN:APP};
const A=APP_SESSION_COOKIE;
const TOKEN='SynthSessTokenAbcdefghijklmn0123';
const SIGNED=`${TOKEN}.c3ludGhldGljLXNpZ25hdHVyZQ%3D%3D`;
const PLANTED='PlantedSessTokenZyxwvutsrq98765.cGxhbnRlZA%3D%3D';
const JWT='eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ1c2VyLTEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2hhcGUtb25seS1zaWduYXR1cmU';
const SESSION_SET=`${UPSTREAM_SESSION_COOKIE}=${SIGNED}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`;
const REISSUED=`${A}=${SIGNED}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`;
const REFLECTED={'access-control-allow-origin':'https://evil.example.test','access-control-allow-credentials':'true','access-control-expose-headers':'set-auth-jwt','vary':'Origin'};
const USER={id:'user-1',email:'player@example.test',emailVerified:true,name:'Player'};
const P={session:`${PROXY_PREFIX}/get-session`,send:`${PROXY_PREFIX}/email-otp/send-verification-otp`,verify:`${PROXY_PREFIX}/sign-in/email-otp`,out:`${PROXY_PREFIX}/sign-out`};
const ROUTE_PATHS=[P.session,P.send,P.verify,P.out];
// The function that owns each public route, as the reviewed split assigns them.
const OWNER={[P.session]:'auth-session',[P.out]:'auth-session',[P.send]:'auth-otp',[P.verify]:'auth-otp'};
const OTHER_FUNCTION={'auth-otp':'auth-session','auth-session':'auth-otp'};
const FUNCTIONS={'auth-otp':otpConfig,'auth-session':sessionConfig};
const NEON={
  'get-session':{body:{session:{id:'sess-1',userId:'user-1',token:TOKEN},user:USER},cookies:[SESSION_SET],headers:{...REFLECTED,'set-auth-jwt':JWT,'set-auth-token':TOKEN}},
  'email-otp/send-verification-otp':{body:{success:true},headers:REFLECTED},
  'sign-in/email-otp':{body:{token:TOKEN,user:USER},cookies:[SESSION_SET],headers:{...REFLECTED,'set-auth-token':TOKEN}},
  'sign-out':{body:{success:true},cookies:[`${UPSTREAM_SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=None; Partitioned`],headers:REFLECTED}
};

function upstream(replies=NEON){
  const calls=[];
  const fetch=async(url,init={})=>{
    calls.push({url:String(url),method:init.method,headers:Object.fromEntries(new Headers(init.headers)),body:init.body??null});
    const reply=replies[String(url).slice(UPSTREAM.length+1)]??{status:404,body:{code:'NOT_FOUND',message:'no such endpoint'}};
    const headers=new Headers({'content-type':'application/json'});
    for(const [name,value] of Object.entries(reply.headers??{}))headers.set(name,value);
    for(const cookie of reply.cookies??[])headers.append('set-cookie',cookie);
    return new Response(JSON.stringify(reply.body),{status:reply.status??200,headers});
  };
  return{calls,fetch};
}

// A Netlify function as Netlify invokes it: (Request, Context). The real core runs behind the adapter, with a recording
// rate-limit hook so the tests can see what reaches it; the injected createProxy only adds that hook.
function netlify(name,{env=ENV,replies=NEON}={}){
  const up=upstream(replies),logs=[],limited=[];
  const handler=createNetlifyHandler(name,env,{fetch:up.fetch,log:entry=>logs.push(entry),
    createProxy:options=>createAuthProxy({...options,rateLimit:async args=>{limited.push(args);return true}})});
  return{handler,up,logs,limited};
}

// The Netlify Context, documented as ip, cookies, geo, requestId, params, server, site, deploy, account and
// waitUntil. Every property access, presence check, enumeration and descriptor read is recorded, and context.cookies
// throws if any of its methods is called, so a test can prove the adapter reads context.ip and nothing else.
function netlifyContext(ip='203.0.113.7'){
  const reads=[];
  const refuse=name=>()=>{throw new Error(`context.cookies.${name} was called`)};
  const target={ip,cookies:{get:refuse('get'),set:refuse('set'),delete:refuse('delete')},geo:{city:'Nowhere'},requestId:'01TESTREQUESTIDXXXXXXXXXXXX',
    params:{},server:{region:'us-east-1'},site:{id:'site-id',name:'pools',url:APP},deploy:{context:'production',id:'deploy-id',published:true},
    account:{id:'account-id'},waitUntil(){}};
  const context=new Proxy(target,{
    get(t,key,receiver){reads.push(String(key));return Reflect.get(t,key,receiver)},
    has(t,key){reads.push(`has ${String(key)}`);return Reflect.has(t,key)},
    ownKeys(t){reads.push('ownKeys');return Reflect.ownKeys(t)},
    getOwnPropertyDescriptor(t,key){reads.push(`descriptor ${String(key)}`);return Reflect.getOwnPropertyDescriptor(t,key)}
  });
  return{context,reads};
}

const headersOf=values=>{const h=new Headers();for(const [k,v] of Object.entries(values))if(v!==null&&v!==undefined)h.set(k,v);return h};
const browser={'sec-fetch-site':'same-origin','sec-fetch-mode':'cors'};
const req=(path,{method='GET',headers={},body,base=APP}={})=>new Request(`${base}${path}`,{method,headers:headersOf({host:HOST,...headers}),...(body!==undefined?{body}:{})});
const post=(path,body,headers={})=>req(path,{method:'POST',headers:{...browser,origin:APP,'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
const SEND={email:'player@example.test',type:'sign-in'},VERIFY={email:'player@example.test',otp:'123456'};
// One well-formed request for a public route, as the app's own page sends it.
const routeRequest=(path,headers={})=>path===P.session?req(path,{headers:{...browser,...headers}}):post(path,path===P.send?SEND:path===P.verify?VERIFY:{},headers);
const accessControl=response=>[...response.headers.keys()].filter(name=>name.startsWith('access-control-'));
const snapshot=async response=>({status:response.status,headers:[...response.headers],body:await response.text()});
const OPTIONS_PREFLIGHT={origin:'https://evil.example.test','access-control-request-method':'POST','access-control-request-headers':'content-type'};

// Netlify routes config.path and config.excludedPath with URLPattern syntax. These configs use two forms only, which
// test Q pins: a literal path, matched exactly, and a literal prefix ending in "/*", whose wildcard matches any
// remainder, slashes included. For those two forms this is URLPattern's own pathname matching.
const matches=(pattern,pathname)=>pattern.endsWith('/*')?pathname.startsWith(pattern.slice(0,-1)):pathname===pattern;
const servedBy=pathname=>Object.entries(FUNCTIONS).filter(([,config])=>[config.path].flat().some(p=>matches(p,pathname))&&
  ![config.excludedPath??[]].flat().some(p=>matches(p,pathname))).map(([name])=>name);

test('A: the four public Auth routes map to the reviewed core, each served only by the function that owns it',async()=>{
  // The ownership table partitions the core's own routes: the two OTP routes to auth-otp, the other two to auth-session.
  assert.deepEqual(Object.keys(FUNCTION_ROUTES).sort(),['auth-otp','auth-session']);
  assert.deepEqual({...FUNCTION_ROUTES},{'auth-otp':['send-otp','verify-otp'],'auth-session':['get-session','sign-out']});
  assert.deepEqual(Object.values(FUNCTION_ROUTES).flat().sort(),Object.values(ROUTES).map(r=>r.id).sort());
  for(const path of ROUTE_PATHS)assert.ok(FUNCTION_ROUTES[OWNER[path]].includes(ROUTES[path].id),path);
  // Each route, through its owning function, reaches exactly its one fixed upstream endpoint, with the app's Origin.
  for(const path of ROUTE_PATHS){
    const {handler,up}=netlify(OWNER[path]);
    const response=await handler(routeRequest(path,{cookie:`${A}=${SIGNED}`}),netlifyContext().context);
    assert.equal(response.status,200,path);
    assert.deepEqual(up.calls.map(c=>[c.method,c.url,c.headers.origin]),[[ROUTES[path].method,`${UPSTREAM}/${ROUTES[path].upstream}`,APP]],path);
  }
  // The other function never serves a route it does not own: the core's own 404, nothing upstream, no rate-limit hook.
  const notFound=await snapshot(await createAuthProxy({config:proxyConfigFromEnv(ENV)})(req('/api/auth/nope',{headers:browser})));
  for(const path of ROUTE_PATHS){
    const {handler,up,logs,limited}=netlify(OTHER_FUNCTION[OWNER[path]]);
    const response=await handler(routeRequest(path,{cookie:`${A}=${SIGNED}`}),netlifyContext().context);
    assert.deepEqual(await snapshot(response),notFound,path);
    assert.deepEqual([up.calls,limited],[[],[]],path);
    assert.deepEqual(logs.map(l=>[l.route,l.status,l.reason]),[[ROUTES[path].id,404,'function-route']],path);
  }
  // A request URL that Netlify's router may match as a path under /api/auth but that a Web Request normalizes to an
  // OTP route (dot segments, encoded dots, a backslash) still cannot make auth-session serve it, so the OTP routes
  // stay behind auth-otp's stricter rate limit whatever the router does.
  for(const raw of ['/api/auth/x/../sign-in/email-otp','/api/auth/x/%2e%2e/sign-in/email-otp','/api/auth/./email-otp/send-verification-otp','/api/auth/sign-in\\email-otp']){
    const request=post(raw,raw.includes('sign-in')?VERIFY:SEND);
    assert.ok([P.send,P.verify].includes(new URL(request.url).pathname),raw);
    const {handler,up,logs,limited}=netlify('auth-session');
    assert.deepEqual(await snapshot(await handler(request,netlifyContext().context)),notFound,raw);
    assert.deepEqual([up.calls,limited,logs.map(l=>l.reason)],[[],[],['function-route']],raw);
  }
  assert.throws(()=>createNetlifyHandler('auth',ENV),/auth/,'only the two known functions exist');
});

test('B: no /.netlify/functions path can reach the proxy: each function has a custom path, and the core refuses every such path anyway',async()=>{
  // Netlify: "When you set a custom path, the function is only available at that path — not at the default
  // /.netlify/functions/<name> URL." Both functions set one, and neither path pattern covers /.netlify/.
  for(const [name,config] of Object.entries(FUNCTIONS)){
    assert.ok([config.path].flat().length>0,name);
    for(const hidden of [`/.netlify/functions/${name}`,`/.netlify/functions/${name}/`,`/.netlify/functions/${name}${P.send}`,`/.netlify/functions/${name}${P.session}`]){
      assert.deepEqual(servedBy(hidden),[],hidden);
    }
  }
  // Were the default path ever reached, the request URL is not one of the four routes: the core answers 404 before any
  // body, rate-limit hook or upstream call, whatever the body, Origin or cookie.
  for(const name of Object.keys(FUNCTIONS)){
    const {handler,up,limited}=netlify(name);
    for(const pathname of [`/.netlify/functions/${name}`,`/.netlify/functions/${name}/`,`/.netlify/functions/${name}${P.send}`,`/.netlify/functions/${name}${P.verify}`,
      `/.netlify/functions/${name}${P.session}`,`/.netlify/functions/${name}${P.out}`,'/.netlify/functions/auth-otp?route=send-otp']){
      for(const request of [req(pathname,{headers:{...browser,cookie:`${A}=${SIGNED}`}}),post(pathname,SEND,{cookie:`${A}=${SIGNED}`}),post(pathname,VERIFY)]){
        const response=await handler(request,netlifyContext().context);
        assert.equal(response.status,404,`${name} ${request.method} ${pathname}`);
        assert.equal(response.headers.get('set-cookie'),null);
      }
    }
    assert.deepEqual([up.calls,limited],[[],[]],name);
  }
});

test('C: the Host the core judges is the raw request Host header, handed over explicitly; the URL host and forwarding headers are never used',async()=>{
  const calls=[];
  const spy=options=>{const core=createAuthProxy(options);return(request,coreOptions)=>{calls.push({request,coreOptions});return core(request,coreOptions)}};
  const up=upstream(),handler=createNetlifyHandler('auth-session',ENV,{fetch:up.fetch,log:()=>{},createProxy:spy});
  const cases=[
    [req(P.session,{headers:browser}),HOST,200],
    [req(P.session,{headers:{...browser,host:'evil.example.test','x-forwarded-host':HOST,forwarded:`host=${HOST}`}}),'evil.example.test',421],
    [req(P.session,{base:'https://evil.example.test',headers:browser}),HOST,200],
    [req(P.session,{headers:{...browser,host:'POOLS.example.test'}}),'POOLS.example.test',421],
    [req(P.session,{headers:{...browser,host:`${HOST}:443`}}),`${HOST}:443`,421],
    [new Request(`${APP}${P.session}`,{headers:headersOf({...browser,'x-forwarded-host':HOST})}),null,421]
  ];
  for(const [request,host,status] of cases){
    const response=await handler(request,netlifyContext().context);
    assert.equal(response.status,status,String(host));
    const call=calls.at(-1);
    assert.equal(call.request,request,'the very Request Netlify delivered is handed to the core');
    assert.deepEqual(Object.keys(call.coreOptions).sort(),['clientIp','host']);
    assert.equal(call.coreOptions.host,host,'Host is request.headers.get(\'host\'), passed explicitly');
  }
  assert.equal(up.calls.length,0,'no request with a wrong Host reached the upstream, and signed out needs none');
});

test('D: the client IP the core sees comes only from context.ip, never from a forwarding header',async()=>{
  const calls=[];
  const spy=options=>{const core=createAuthProxy(options);return(request,coreOptions)=>{calls.push(coreOptions.clientIp);return core(request,coreOptions)}};
  const handler=createNetlifyHandler('auth-otp',ENV,{fetch:upstream().fetch,log:()=>{},createProxy:spy});
  const forged={'x-forwarded-for':'198.51.100.1','x-real-ip':'198.51.100.2','client-ip':'198.51.100.3','x-nf-client-connection-ip':'198.51.100.4',
    forwarded:'for=198.51.100.5','true-client-ip':'198.51.100.6','cf-connecting-ip':'198.51.100.7'};
  await handler(post(P.send,SEND,forged),netlifyContext('203.0.113.7').context);
  await handler(post(P.verify,VERIFY,forged),netlifyContext('2001:db8::7').context);
  await handler(post(P.send,SEND,forged),undefined);
  await handler(post(P.send,SEND,forged),{});
  await handler(post(P.send,SEND,forged),{ip:42});
  assert.deepEqual(calls,['203.0.113.7','2001:db8::7',null,null,null]);
  // End to end: the core's rate-limit hook is handed context.ip and nothing else of the client.
  const {handler:otp,limited}=netlify('auth-otp');
  await otp(post(P.send,SEND,forged),netlifyContext('203.0.113.9').context);
  await otp(post(P.verify,VERIFY,forged),netlifyContext('203.0.113.9').context);
  assert.deepEqual(limited.map(l=>[l.route,l.clientIp]),[['send-otp','203.0.113.9'],['verify-otp','203.0.113.9']]);
  assert.equal(JSON.stringify(limited).includes('198.51.100'),false);
});

test('E: context.cookies is never used: the adapter reads context.ip and nothing else of the Netlify Context',async()=>{
  for(const path of ROUTE_PATHS){
    for(const cookie of [`${A}=${SIGNED}`,`${A}=${SIGNED}; ${A}=${PLANTED}`,` ${A}=${PLANTED}`,`theme=dark`]){
      for(const name of Object.keys(FUNCTIONS)){
        const {handler}=netlify(name),{context,reads}=netlifyContext();
        const response=await handler(routeRequest(path,{cookie}),context);
        assert.notEqual(response.status,502,`${name} ${path}: context.cookies was called`);
        assert.ok(reads.every(key=>key==='ip'),`${name} ${path} read ${reads.join(', ')}`);
        assert.ok(reads.length<=1,`${name} ${path} read context.ip ${reads.length} times`);
      }
    }
  }
  // Nor does the source of the adapter or of either function name it, outside comments.
  for(const file of ['server/netlify-adapter.mjs','netlify/functions/auth-otp.mjs','netlify/functions/auth-session.mjs']){
    const code=fs.readFileSync(new URL(`./${file}`,import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
    assert.doesNotMatch(code,/cookies/i,file);
  }
});

test('F: the exact app cookie more than once still fails closed through either function: 401, nothing upstream, nothing set',async()=>{
  const duplicates=[`${A}=${SIGNED}; ${A}=${PLANTED}`,`${A}=${PLANTED}; ${A}=${SIGNED}`,`${A}=${SIGNED}; theme=dark; ${A}=${SIGNED}`,` ${A} = ${SIGNED};${A}=${PLANTED}`];
  for(const cookie of duplicates){
    for(const path of ROUTE_PATHS){
      const {handler,up,logs,limited}=netlify(OWNER[path]);
      const response=await handler(routeRequest(path,{cookie}),netlifyContext().context);
      assert.equal(response.status,401,`${path} ${cookie}`);
      const text=await response.text();
      assert.deepEqual(JSON.parse(text),{code:'UNAUTHORIZED',message:'Sign-in could not be confirmed. Clear this site\'s cookies, then sign in again.'});
      for(const secret of [SIGNED,PLANTED,TOKEN])assert.equal(text.includes(secret),false,secret);
      assert.deepEqual(response.headers.getSetCookie(),[],'nothing set, nothing deleted');
      for(const [name,value] of Object.entries(SECURITY_HEADERS))assert.equal(response.headers.get(name),value,name);
      assert.deepEqual([up.calls,limited],[[],[]],'neither value reaches Neon, and the rate-limit hook is not asked');
      assert.deepEqual(logs.map(l=>`${l.route} ${l.status} ${l.reason}`),[`${ROUTES[path].id} 401 cookie-conflict`]);
    }
  }
});

test('G: a look-alike of the app cookie never becomes a session through either function: trim()-collapsing names fail closed, others are inert',async()=>{
  // Raw NBSP (0xA0), VT and FF before or after the exact name: what the retired trim() parser would have read as the
  // session. Every route answers 401 with nothing upstream, alone or beside the genuine cookie.
  for(const ws of [' ','\u000B','\u000C']){
    for(const cookie of [`${ws}${A}=${PLANTED}`,`${A}${ws}=${PLANTED}`,`${A}=${SIGNED}; ${ws}${A}=${PLANTED}`,`${ws}${A}=${PLANTED}; ${A}=${SIGNED}`]){
      for(const path of ROUTE_PATHS){
        const {handler,up,limited}=netlify(OWNER[path]);
        const response=await handler(routeRequest(path,{cookie}),netlifyContext().context);
        assert.deepEqual([response.status,response.headers.getSetCookie(),up.calls,limited],[401,[],[],[]],`${path} ${JSON.stringify(cookie)}`);
      }
    }
  }
  // A UTF-8 NBSP and a UTF-8 Cyrillic "о" decoded byte by byte (0xC2 0xA0 and 0xD0 0xBE, as a Latin-1 header parser
  // yields them), a long internal SP/HTAB run, a case fold and a suffix: never the exact name, so never a session and
  // never a conflict. Signed out, get-session answers null without asking Neon; beside the genuine cookie, only the
  // genuine value travels.
  for(const name of [`Â ${A}`,'__Host-poÐ¾l-platform-session',`a${' '.repeat(16000)}b`,`a${'\t'.repeat(16000)}b`,'__host-pool-platform-session',`${A}x`]){
    const {handler,up}=netlify('auth-session');
    const signedOut=await handler(req(P.session,{headers:{...browser,cookie:`${name}=${PLANTED}`}}),netlifyContext().context);
    assert.deepEqual([signedOut.status,await signedOut.text(),up.calls.length],[200,'null',0],JSON.stringify(name.slice(0,40)));
    const signedIn=await handler(req(P.session,{headers:{...browser,cookie:`${name}=${PLANTED}; ${A}=${SIGNED}`}}),netlifyContext().context);
    assert.deepEqual([signedIn.status,signedIn.headers.getSetCookie()],[200,[REISSUED]]);
    assert.deepEqual(up.calls.map(c=>c.headers.cookie),[`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`]);
  }
});

test('H: beside the genuine cookie, a planted value never travels upstream through either function',async()=>{
  const planted=[
    [`${A}=${SIGNED}; ${A}=${PLANTED}`,401],[`${A}=${SIGNED};  ${A}=${PLANTED}`,401],[` ${A}=${PLANTED}; ${A}=${SIGNED}`,401],
    [`${UPSTREAM_SESSION_COOKIE}=${PLANTED}; ${A}=${SIGNED}`,200],[`${A}=${SIGNED}; ${UPSTREAM_SESSION_COOKIE}=${PLANTED}`,200],
    [`Â ${A}=${PLANTED}; ${A}=${SIGNED}`,200],[`__Secure-neon-auth.session_data=${PLANTED}; ${A}=${SIGNED}`,200]
  ];
  for(const [cookie,status] of planted){
    for(const path of ROUTE_PATHS){
      const {handler,up,logs}=netlify(OWNER[path]);
      const response=await handler(routeRequest(path,{cookie}),netlifyContext().context);
      assert.equal(response.status,status,`${path} ${JSON.stringify(cookie)}`);
      assert.equal(JSON.stringify(up.calls).includes(PLANTED),false,`${path}: the planted value reached Neon`);
      assert.equal(JSON.stringify(logs).includes(PLANTED),false);
      // Only get-session and sign-out send a cookie upstream, and then only the genuine value under Neon's name.
      for(const call of up.calls)assert.equal(call.headers.cookie,[P.session,P.out].includes(path)?`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`:undefined,path);
    }
  }
});

test('I: OPTIONS reaches the core through either function and is refused there with 405: no method is restricted at the routing layer',async()=>{
  for(const [name,config] of Object.entries(FUNCTIONS))assert.equal(Object.hasOwn(config,'method'),false,`${name} must not restrict methods: Netlify would answer OPTIONS itself`);
  for(const path of ROUTE_PATHS){
    const {handler,up,logs}=netlify(OWNER[path]);
    const response=await handler(req(path,{method:'OPTIONS',headers:OPTIONS_PREFLIGHT}),netlifyContext().context);
    assert.equal(response.status,405,path);
    assert.equal(response.headers.get('allow'),ROUTES[path].method);
    assert.deepEqual(accessControl(response),[],'a preflight never grants anything');
    for(const [name,value] of Object.entries(SECURITY_HEADERS))assert.equal(response.headers.get(name),value,name);
    assert.deepEqual(up.calls,[]);
    assert.deepEqual(logs.map(l=>[l.route,l.method,l.status,l.reason]),[[ROUTES[path].id,'OPTIONS',405,'method']]);
  }
  // Any other path under /api/auth reaches the core through auth-session, and OPTIONS there is the core's 404.
  const {handler}=netlify('auth-session');
  assert.equal((await handler(req('/api/auth/list-sessions',{method:'OPTIONS',headers:OPTIONS_PREFLIGHT}),netlifyContext().context)).status,404);
});

test('J: wrong methods, unknown paths and query strings get exactly the core\'s own answers through the function that serves them',async()=>{
  const core=()=>createAuthProxy({config:proxyConfigFromEnv(ENV),fetch:upstream().fetch,log:()=>{}});
  const unknown=['/api/auth','/api/auth/','/api/auth/get-session/','/api/auth/list-sessions','/api/auth/update-user','/api/auth/token','/api/auth/jwks',
    '/api/auth/sign-in/email','/api/auth/sign-in/social','/api/auth/GET-SESSION','/api/auth/get%2Dsession','/api/auth//get-session','/api/auth/sign-out/extra',
    '/api/auth/email-otp/verify-email','/api/auth/sign-in/email-otp/','/api/auth/email-otp/send-verification-otp.json'];
  const cases=[];
  for(const path of unknown)for(const method of ['GET','POST','PUT','DELETE'])cases.push(['auth-session',path,method]);
  for(const path of ROUTE_PATHS)for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE'].filter(m=>m!==ROUTES[path].method))cases.push([OWNER[path],path,method]);
  for(const [name,path,method] of cases){
    const request=()=>req(path,{method,headers:{...browser,origin:APP,'content-type':'application/json'},...(['GET','HEAD'].includes(method)?{}:{body:'{}'})});
    const {handler,up}=netlify(name);
    assert.deepEqual(await snapshot(await handler(request(),netlifyContext().context)),await snapshot(await core()(request())),`${name} ${method} ${path}`);
    assert.deepEqual(up.calls,[]);
  }
  for(const path of ROUTE_PATHS){
    const {handler}=netlify(OWNER[path]);
    const request=()=>path===P.session?req(`${path}?disableCookieCache=true`,{headers:browser}):post(`${path}?x=1`,{});
    const response=await handler(request(),netlifyContext().context);
    assert.equal(response.status,400,`query on ${path}`);
    assert.deepEqual(await snapshot(response),await snapshot(await core()(request())));
  }
});

test('K: a POST without exactly the app Origin is 403 through either function, before any upstream call',async()=>{
  for(const origin of [null,'null','http://pools.example.test','https://pools.example.test:8443','https://evil.example.test','https://sub.pools.example.test','']){
    for(const path of [P.send,P.verify,P.out]){
      const {handler,up,limited}=netlify(OWNER[path]);
      const response=await handler(routeRequest(path,{origin,cookie:`${A}=${SIGNED}`}),netlifyContext().context);
      assert.equal(response.status,403,`${origin} ${path}`);
      assert.deepEqual([response.headers.getSetCookie(),up.calls,limited],[[],[],[]]);
    }
  }
});

test('L: fetch metadata other than same-origin is 403 through either function, before any upstream call',async()=>{
  for(const path of ROUTE_PATHS){
    for(const headers of [{'sec-fetch-site':'same-site'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'none'},{'sec-fetch-mode':'navigate'},{'sec-fetch-mode':'no-cors'}]){
      const {handler,up,limited}=netlify(OWNER[path]);
      const response=await handler(routeRequest(path,{...headers,cookie:`${A}=${SIGNED}`}),netlifyContext().context);
      assert.equal(response.status,403,`${path} ${JSON.stringify(headers)}`);
      assert.deepEqual([up.calls,limited],[[],[]]);
    }
  }
});

test('M: a signed-out get-session is the core\'s own answer, unchanged: 200 null, its headers, and no upstream call',async()=>{
  const {handler,up,logs}=netlify('auth-session');
  const response=await handler(req(P.session,{headers:browser}),netlifyContext().context);
  const direct=await createAuthProxy({config:proxyConfigFromEnv(ENV),fetch:upstream().fetch})(req(P.session,{headers:browser}));
  const [mine,theirs]=[await snapshot(response),await snapshot(direct)];
  assert.deepEqual(mine,theirs);
  assert.deepEqual([mine.status,mine.body],[200,'null']);
  assert.deepEqual(Object.fromEntries(mine.headers),{...SECURITY_HEADERS,'content-type':'application/json; charset=utf-8'});
  assert.deepEqual(up.calls,[]);
  assert.deepEqual(logs.map(l=>[l.route,l.method,l.status,l.reason]),[['get-session','GET',200,undefined]]);
});

test('N: no response from either function carries a CORS grant, even when the upstream reflects one',async()=>{
  const responses=[];
  for(const path of ROUTE_PATHS){
    const {handler}=netlify(OWNER[path]),{handler:other}=netlify(OTHER_FUNCTION[OWNER[path]]);
    for(const origin of [APP,'https://evil.example.test','null']){
      responses.push(await handler(routeRequest(path,{origin,cookie:`${A}=${SIGNED}`}),netlifyContext().context));
      responses.push(await handler(req(path,{method:'OPTIONS',headers:{...OPTIONS_PREFLIGHT,origin}}),netlifyContext().context));
      responses.push(await other(routeRequest(path,{origin}),netlifyContext().context));
    }
  }
  const {handler}=netlify('auth-session');
  responses.push(await handler(req('/api/auth/nope',{headers:{...browser,origin:'https://evil.example.test'}}),netlifyContext().context));
  assert.ok(responses.some(r=>r.status===200)&&responses.some(r=>r.status===403)&&responses.some(r=>r.status===405)&&responses.some(r=>r.status===404));
  for(const response of responses){
    assert.deepEqual(accessControl(response),[],String(response.status));
    assert.equal(response.headers.get('vary'),null);
    for(const [name,value] of Object.entries(SECURITY_HEADERS))assert.equal(response.headers.get(name),value,`${response.status} ${name}`);
  }
});

test('O: the core\'s Response, Set-Cookie included, is returned as is: the adapter never parses or rebuilds it',async()=>{
  // Whatever the core answers is what Netlify gets, the very object, so no cookie line is re-parsed or re-joined.
  const odd=new Response('{"x":1}',{status:200,headers:[['set-cookie',`${A}=${SIGNED}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`],
    ['set-cookie','other=1;Max-Age=0;  HttpOnly'],['set-cookie','third=a, b; Expires=Wed, 21 Oct 2037 07:28:00 GMT'],['content-type','application/json']]});
  for(const name of Object.keys(FUNCTIONS)){
    const handler=createNetlifyHandler(name,ENV,{log:()=>{},createProxy:()=>async()=>odd});
    const path=FUNCTION_ROUTES[name].map(id=>Object.keys(ROUTES).find(p=>ROUTES[p].id===id))[0];
    const response=await handler(routeRequest(path),netlifyContext().context);
    assert.equal(response,odd,name);
    assert.equal(response.headers.getSetCookie().length,3);
  }
  // End to end, the cookie lines are exactly the core's: re-issued on verify and get-session, deleted on sign-out.
  const lines=async(path,cookie)=>{const {handler}=netlify(OWNER[path]);return(await handler(routeRequest(path,{cookie}),netlifyContext().context)).headers.getSetCookie()};
  assert.deepEqual(await lines(P.verify),[REISSUED]);
  assert.deepEqual(await lines(P.session,`${A}=${SIGNED}`),[REISSUED]);
  assert.deepEqual(await lines(P.out,`${A}=${SIGNED}`),[DELETE_SESSION_COOKIE]);
  assert.deepEqual(await lines(P.send),[]);
});

test('P: the adapter logs one JSON line per request with route, method, status, duration and a fixed reason only: no secret or request value',async()=>{
  const email='Leaky.Person@Example.test',otp='987654',invite='ab'.repeat(32),bearer='Bearer eyJsecret.payload.sig',ip='198.51.100.23';
  const lines=[],original=console.log;
  console.log=(...args)=>lines.push(args.join(' '));
  try{
    // The default logger, as the deployed functions use it.
    const up=upstream({...NEON,'sign-in/email-otp':{...NEON['sign-in/email-otp'],headers:{'set-auth-jwt':JWT}}});
    const otpFunction=createNetlifyHandler('auth-otp',ENV,{fetch:up.fetch}),sessionFunction=createNetlifyHandler('auth-session',ENV,{fetch:up.fetch});
    const sensitive={authorization:bearer,cookie:`${A}=${SIGNED}; theme=dark`,'user-agent':'UA-fingerprint-123','x-forwarded-for':ip};
    const context=()=>netlifyContext(ip).context;
    await otpFunction(post(P.send,{email,type:'sign-in'},sensitive),context());
    await otpFunction(post(P.verify,{email,otp},sensitive),context());
    await sessionFunction(req(P.session,{headers:{...browser,...sensitive}}),context());
    await sessionFunction(post(P.out,{},sensitive),context());
    await otpFunction(post(P.verify,{email,otp:'12x'},sensitive),context());
    await otpFunction(post(P.send,{email,type:'forget-password'},{...sensitive,origin:'https://evil.example.test'}),context());
    await sessionFunction(req(`${P.session}?invite=${invite}&email=${encodeURIComponent(email)}`,{headers:{...browser,...sensitive}}),context());
    await sessionFunction(req(`/api/auth/${otp}/${email}`,{headers:{...browser,...sensitive}}),context());
    await sessionFunction(post(P.verify,{email,otp},sensitive),context());
    await otpFunction(post(P.verify,{email,otp},{...sensitive,cookie:`${A}=${SIGNED}; ${A}=${TOKEN}`}),context());
    // The OTP really travelled: Neon was asked to verify exactly this code, and it still never reached a log line.
    assert.ok(up.calls.some(call=>call.body===JSON.stringify({email:email.toLowerCase(),otp})),'the verify request carried the code upstream');
    // An exception inside the core becomes the core's generic 502, and its message is never logged.
    const failing=createNetlifyHandler('auth-otp',ENV,{createProxy:()=>async()=>{throw new Error(`boom ${SIGNED} ${email}`)}});
    const failed=await failing(post(P.send,{email,type:'sign-in'},sensitive),context());
    assert.equal(failed.status,502);
    assert.deepEqual(JSON.parse(await failed.text()),{code:'AUTH_UPSTREAM_ERROR',message:'The sign-in service could not be reached. Try again.'});
    for(const [name,value] of Object.entries(SECURITY_HEADERS))assert.equal(failed.headers.get(name),value,name);
  }finally{console.log=original}
  assert.equal(lines.length,11);
  const entries=lines.map(line=>JSON.parse(line));
  assert.deepEqual(entries.map(e=>[e.route,e.method,e.status,e.reason??null]),[
    ['send-otp','POST',200,null],['verify-otp','POST',200,null],['get-session','GET',200,null],['sign-out','POST',200,null],
    ['verify-otp','POST',400,'schema'],['send-otp','POST',403,'origin'],['get-session','GET',400,'query'],[null,'GET',404,'route'],
    ['verify-otp','POST',404,'function-route'],['verify-otp','POST',401,'cookie-conflict'],['send-otp','POST',502,'adapter-error']
  ]);
  for(const entry of entries){
    assert.equal(entry.event,'auth-proxy');
    assert.deepEqual(Object.keys(entry).filter(k=>!['event','route','method','status','ms','reason'].includes(k)),[]);
    assert.equal(typeof entry.ms,'number');
    if(entry.reason!==undefined)assert.match(entry.reason,/^[a-z-]+(?::\d+)?$/);
  }
  const text=lines.join('\n').toLowerCase();
  for(const secret of [email,'leaky',otp,invite,TOKEN,SIGNED,JWT,bearer,'eyjsecret','ua-fingerprint','theme','dark',ip,'198.51.100','forget-password','boom'])assert.equal(text.includes(secret.toLowerCase()),false,secret);
});

test('Q: each function\'s config is a plain literal that routes exactly the reviewed route constants, with the reviewed rate limits',async()=>{
  const pathsOf=name=>Object.keys(ROUTES).filter(path=>FUNCTION_ROUTES[name].includes(ROUTES[path].id));
  const OTP_PATHS=pathsOf('auth-otp');
  assert.deepEqual(OTP_PATHS,[P.send,P.verify]);
  // Exactly these configs: the OTP function owns the two OTP paths and nothing else; the session function owns
  // /api/auth and everything under it except those two. Rate limits are per client IP and domain, Netlify's default
  // aggregation, and the OTP limit is the stricter one. These numbers are hosting-spike settings, not the answer to
  // how Neon limits Email OTP (docs/HOSTING_ARCHITECTURE.md, question I).
  assert.deepEqual(otpConfig,{path:[P.send,P.verify],rateLimit:{windowLimit:10,windowSize:180,aggregateBy:['ip','domain']}});
  assert.deepEqual(sessionConfig,{path:[PROXY_PREFIX,`${PROXY_PREFIX}/*`],excludedPath:[P.send,P.verify],rateLimit:{windowLimit:120,windowSize:60,aggregateBy:['ip','domain']}});
  assert.deepEqual(otpConfig.path,OTP_PATHS,'the OTP function routes exactly the core\'s OTP routes');
  assert.deepEqual(sessionConfig.excludedPath,OTP_PATHS,'and the session function excludes exactly those');
  for(const [name,config] of Object.entries(FUNCTIONS)){
    const limit=config.rateLimit;
    assert.ok(Number.isInteger(limit.windowSize)&&limit.windowSize>0&&limit.windowSize<=180,`${name}: Netlify allows a window of at most 180 s`);
    assert.ok(Number.isInteger(limit.windowLimit)&&limit.windowLimit>0,name);
    assert.equal(Object.hasOwn(limit,'action')||Object.hasOwn(limit,'to'),false,`${name}: the default action answers 429; nothing is rewritten`);
    // Only the two pattern forms the routing simulation implements exactly: literal paths and a literal prefix + "/*".
    for(const pattern of [config.path,config.excludedPath??[]].flat())assert.match(pattern,/^\/[a-z0-9/-]*[a-z0-9-](?:\/\*)?$/,`${name}: ${pattern}`);
  }
  assert.ok(otpConfig.rateLimit.windowLimit/otpConfig.rateLimit.windowSize<sessionConfig.rateLimit.windowLimit/sessionConfig.rateLimit.windowSize,'the OTP limit is the stricter');
  // Netlify's Free plan allows two code-based rate-limit rules per project: exactly these two functions, one rule each.
  assert.deepEqual(fs.readdirSync(new URL('./netlify/functions/',import.meta.url)).sort(),['auth-otp.mjs','auth-session.mjs']);
  // Routing, under URLPattern semantics for these patterns: each public route is served by exactly its owner, every
  // other path under /api/auth by auth-session alone (so the core answers it), and nothing outside /api/auth.
  for(const path of ROUTE_PATHS)assert.deepEqual(servedBy(path),[OWNER[path]],path);
  for(const path of ['/api/auth','/api/auth/','/api/auth/list-sessions','/api/auth/sign-in/email-otp/','/api/auth/email-otp/send-verification-otp/x',
    '/api/auth//sign-in/email-otp','/api/auth/sign-in/email%2Dotp','/api/auth/x/%2e%2e/sign-in/email-otp'])assert.deepEqual(servedBy(path),['auth-session'],path);
  for(const path of ['/','/participant.html','/api','/api/authx','/api/auth-otp','/api/other','/.netlify/functions/auth-session'])assert.deepEqual(servedBy(path),[],path);
  // Netlify reads each config from the source at build time, so it must be a plain literal: evaluated alone, with no
  // binding in scope, it is exactly the exported config, and it holds nothing but keys, strings, numbers and brackets.
  for(const [name,config] of Object.entries(FUNCTIONS)){
    const source=fs.readFileSync(new URL(`./netlify/functions/${name}.mjs`,import.meta.url),'utf8');
    const literal=/^export const config=(\{\n[\s\S]*?\n\});$/m.exec(source)?.[1];
    assert.ok(literal,`${name}: export const config={...}; as a literal`);
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal})`,Object.create(null)))),config,name);
    assert.match(literal.replace(/'[^'\\\n]*'/g,"''"),/^[\s{}[\],:'0-9A-Za-z]*$/,`${name}: only literal keys, strings and numbers`);
    assert.equal((source.match(/^export /gm)||[]).length,2,`${name}: a default handler and config, nothing else exported`);
    assert.match(source,new RegExp(`^export default createNetlifyHandler\\('${name}',process\\.env\\);$`,'m'),name);
  }
  // The deployed handlers are wired to their own names: each refuses the other's routes before reaching the core,
  // whatever this process's environment configures.
  const lines=[],original=console.log;
  console.log=(...args)=>lines.push(JSON.parse(args.join(' ')));
  try{
    for(const [handler,name] of [[otpHandler,'auth-otp'],[sessionHandler,'auth-session']]){
      for(const path of ROUTE_PATHS){
        lines.length=0;
        await handler(routeRequest(path),netlifyContext().context);
        assert.equal(lines.at(-1).reason==='function-route',OWNER[path]!==name,`${name} ${path}`);
      }
    }
  }finally{console.log=original}
});
