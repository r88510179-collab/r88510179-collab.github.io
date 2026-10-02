import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test,{describe} from 'node:test';
import {fileURLToPath} from 'node:url';
import {extractAccessToken} from './auth-core.js';
import {AUTH_PROXY_PATH} from './platform-client.js';
import {
  APP_SESSION_COOKIE,BODY_LIMIT,DELETE_SESSION_COOKIE,PROXY_PREFIX,ROUTES,SECURITY_HEADERS,UPSTREAM_SESSION_COOKIE,authUpstreamUrl,createAuthProxy,
  emailKey,proxyConfigFromEnv,sessionCookie,sessionCookieValue,stripTokens
} from './server/auth-proxy-core.mjs';
import vercelDefault,{canonicalAuthRequest,createVercelHandler} from './api/auth.mjs';

// The same-origin Neon Auth proxy (F-1). Deterministic and offline: upstream Neon Auth is an in-memory stand-in that
// answers the way Neon's Better Auth does (Set-Cookie with the partitioned session cookie, the opaque session token in
// the body, set-auth-jwt, reflected CORS headers), so every rewrite and removal is exercised. All values are synthetic
// shapes, never credentials, and no request ever leaves the process: the upstream host below is never resolved.
const UPSTREAM='https://ep-example-000000.neonauth.c-0.us-east-2.aws.neon.tech/neondb/auth';
const APP='https://pools.example.test',HOST='pools.example.test';
const ENV={POOL_PLATFORM_MODE:'live',POOL_PLATFORM_AUTH_UPSTREAM_URL:UPSTREAM,POOL_PLATFORM_APP_ORIGIN:APP};
const CONFIG=proxyConfigFromEnv(ENV);
const TOKEN='SynthSessTokenAbcdefghijklmn0123';
const SIGNED=`${TOKEN}.c3ludGhldGljLXNpZ25hdHVyZQ%3D%3D`;
const JWT='eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ1c2VyLTEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2hhcGUtb25seS1zaWduYXR1cmU';
// Neon sets its own session cookie; the browser gets the app's, with the same value and lifetime only.
const SESSION_SET=`${UPSTREAM_SESSION_COOKIE}=${SIGNED}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`;
const REISSUED=`${APP_SESSION_COOKIE}=${SIGNED}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`;
const REFLECTED={'access-control-allow-origin':'https://evil.example.test','access-control-allow-credentials':'true','access-control-expose-headers':'set-auth-jwt','vary':'Origin'};
const USER={id:'user-1',email:'player@example.test',emailVerified:true,name:'Player'};
const SESSION={id:'sess-1',userId:'user-1',token:TOKEN,expiresAt:'2030-01-01T00:00:00.000Z',ipAddress:'',userAgent:'UA'};
const P={session:`${PROXY_PREFIX}/get-session`,send:`${PROXY_PREFIX}/email-otp/send-verification-otp`,verify:`${PROXY_PREFIX}/sign-in/email-otp`,out:`${PROXY_PREFIX}/sign-out`};

// Neon's answers, per upstream endpoint.
const NEON={
  'get-session':{body:{session:SESSION,user:USER},cookies:[SESSION_SET,'__Secure-neon-auth.session_data=abc; Path=/; Secure'],headers:{...REFLECTED,'set-auth-jwt':JWT,'set-auth-token':TOKEN}},
  'email-otp/send-verification-otp':{body:{success:true},headers:REFLECTED},
  'sign-in/email-otp':{body:{token:TOKEN,user:USER},cookies:[SESSION_SET,'__Secure-neon-auth.session_data=abc; Path=/; Secure'],headers:{...REFLECTED,'set-auth-token':TOKEN}},
  'sign-out':{body:{success:true},cookies:[`${UPSTREAM_SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=None; Partitioned`],headers:REFLECTED}
};

function upstream(replies=NEON){
  const calls=[];
  const fetch=async(url,init={})=>{
    calls.push({url:String(url),method:init.method,headers:Object.fromEntries(new Headers(init.headers)),body:init.body??null,redirect:init.redirect,signal:init.signal});
    const reply=replies[String(url).slice(UPSTREAM.length+1)]??{status:404,body:{code:'NOT_FOUND',message:'no such endpoint'}};
    if(typeof reply==='function')return reply(init);
    if(reply instanceof Error)throw reply;
    const headers=new Headers({'content-type':reply.type??'application/json'});
    for(const [name,value] of Object.entries(reply.headers??{}))headers.set(name,value);
    for(const cookie of reply.cookies??[])headers.append('set-cookie',cookie);
    return new Response(reply.raw??JSON.stringify(reply.body),{status:reply.status??200,headers});
  };
  return{calls,fetch};
}
function proxyWith(replies=NEON,options={}){
  const up=upstream(replies),logs=[];
  return{handle:createAuthProxy({config:CONFIG,fetch:up.fetch,log:entry=>logs.push(entry),...options}),up,logs};
}
const headersOf=values=>{const h=new Headers();for(const [k,v] of Object.entries(values))if(v!==null&&v!==undefined)h.set(k,v);return h};
const browser={'sec-fetch-site':'same-origin','sec-fetch-mode':'cors'};
const req=(path,{method='GET',headers={},body,base=APP}={})=>new Request(`${base}${path}`,{method,headers:headersOf({host:HOST,...headers}),...(body!==undefined?{body}:{})});
const post=(path,body,headers={})=>req(path,{method:'POST',headers:{...browser,origin:APP,'content-type':'application/json',...headers},body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)});
const getSession=(headers={})=>req(P.session,{headers:{...browser,cookie:`${APP_SESSION_COOKIE}=${SIGNED}`,...headers}});
const SEND={email:'player@example.test',type:'sign-in'},VERIFY={email:'player@example.test',otp:'123456'};
const json=async response=>JSON.parse(await response.text());
const accessControl=response=>[...response.headers.keys()].filter(name=>name.startsWith('access-control-'));

test('configuration fails closed: outside live mode, or with any missing or malformed value, every request is 404 and nothing reaches Neon',async()=>{
  assert.deepEqual({...CONFIG},{enabled:true,upstreamUrl:UPSTREAM,appOrigin:APP});
  assert.deepEqual({...proxyConfigFromEnv({...ENV,POOL_PLATFORM_APP_ORIGIN:'http://localhost:4173'})},{enabled:true,upstreamUrl:UPSTREAM,appOrigin:'http://localhost:4173'});
  const disabled=[
    {},{...ENV,POOL_PLATFORM_MODE:undefined},{...ENV,POOL_PLATFORM_MODE:'sandbox'},{...ENV,POOL_PLATFORM_MODE:'LIVE'},{...ENV,POOL_PLATFORM_MODE:' live'},
    {...ENV,POOL_PLATFORM_AUTH_UPSTREAM_URL:undefined},{...ENV,POOL_PLATFORM_AUTH_UPSTREAM_URL:''},{...ENV,POOL_PLATFORM_APP_ORIGIN:undefined},{...ENV,POOL_PLATFORM_APP_ORIGIN:''}
  ];
  const upstreams=['http://ep-x.neonauth.c-0.us-east-2.aws.neon.tech/neondb/auth','https://evil.example.test/neondb/auth','https://ep-x.apirest.c-0.aws.neon.tech/neondb/auth',
    'https://neonauth.example.test/neondb/auth','https://ep-x.neonauth.c-0.aws.neon.tech/neondb/auth/','https://ep-x.neonauth.c-0.aws.neon.tech/auth',
    'https://ep-x.neonauth.c-0.aws.neon.tech/neondb/other','https://ep-x.neonauth.c-0.aws.neon.tech/neondb/auth/get-session','https://ep-x.neonauth.c-0.aws.neon.tech/neondb/auth?secret=1',
    'https://secret@ep-x.neonauth.c-0.aws.neon.tech/neondb/auth','https://ep-x.neonauth.c-0.aws.neon.tech/neondb/auth#secret','https://ep-x.neonauth.c-0.aws.neon.tech/a/../neondb/auth'];
  const origins=['https://pools.example.test/','https://pools.example.test/app','https://POOLS.example.test','http://pools.example.test','http://127.0.0.1:4173',
    'https://pools.example.test:443','null','pools.example.test','https://secret@pools.example.test','https://pools.example.test?secret'];
  for(const env of [...disabled,...upstreams.map(u=>({...ENV,POOL_PLATFORM_AUTH_UPSTREAM_URL:u})),...origins.map(o=>({...ENV,POOL_PLATFORM_APP_ORIGIN:o}))]){
    const config=proxyConfigFromEnv(env);
    assert.equal(config.enabled,false,JSON.stringify(env));
    assert.equal(typeof config.reason,'string');
    assert.doesNotMatch(config.reason,/secret|evil/,'the rejected value is never repeated');
    const up=upstream();
    const handle=createAuthProxy({config,fetch:up.fetch});
    for(const request of [getSession(),post(P.send,SEND),post(P.verify,VERIFY),post(P.out,{})]){
      const response=await handle(request);
      assert.equal(response.status,404);
      assert.equal(response.headers.get('cache-control'),'no-store');
    }
    assert.deepEqual(up.calls,[]);
  }
  assert.equal((await createAuthProxy()(getSession())).status,404,'no configuration at all is disabled');
});

test('the upstream host must be a Neon Auth host ending in neon.tech, matched label by label: other domains, lookalikes and suffix tricks are refused',async()=>{
  // The approved commercial host, and the same structure with other endpoints, regions and databases.
  for(const url of ['https://ep-still-recipe-b5g7680z.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth',UPSTREAM,
    'https://ep-example-111111.neonauth.c-2.eu-central-1.aws.neon.tech/app_db/auth']){
    assert.deepEqual({...proxyConfigFromEnv({...ENV,POOL_PLATFORM_AUTH_UPSTREAM_URL:url})},{enabled:true,upstreamUrl:url,appOrigin:APP},url);
  }
  const refused=[
    'http://ep-still-recipe-b5g7680z.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth', // not https
    'https://x.neonauth.attacker.example/neondb/auth', // "neonauth" in second place, under any domain
    'https://ep-x.neonauth.attacker.example/neondb/auth','https://attacker.example/neondb/auth','https://neonauth.attacker.example/neondb/auth',
    // suffix confusion: neon.tech, then more labels
    'https://neon.tech.attacker.example/neondb/auth','https://ep-x.neonauth.neon.tech.attacker.example/neondb/auth',
    'https://ep-x.neonauth.c-7.us-east-2.aws.neon.tech.attacker.example/neondb/auth','https://ep-x.neonauth.c-7.us-east-2.aws.neon.tech.neon.example/neondb/auth',
    // lookalikes of neon.tech and of the Neon Auth labels
    'https://ep-x.neonauth.c-7.us-east-2.aws.neon.techx/neondb/auth','https://ep-x.neonauth.c-7.us-east-2.aws.xneon.tech/neondb/auth',
    'https://ep-x.neonauth.c-7.us-east-2.aws.neon-tech.example/neondb/auth','https://ep-x.neonauth.c-7.us-east-2.aws.neontech/neondb/auth',
    'https://ep-x.neonauth.c-7.us-east-2.aws.neon.xn--tch-rdd/neondb/auth','https://ep-x.neonauthx.c-7.us-east-2.aws.neon.tech/neondb/auth',
    'https://ep-x.neon-auth.c-7.us-east-2.aws.neon.tech/neondb/auth','https://ep-x.xneonauth.c-7.us-east-2.aws.neon.tech/neondb/auth',
    'https://ep-x.apirest.c-7.us-east-2.aws.neon.tech/neondb/auth', // the Data API host
    // the structure: an ep- endpoint label first, then neonauth, then at least one region label
    'https://ep-x.neonauth.neon.tech/neondb/auth','https://neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth','https://x.ep-x.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth',
    'https://ep-.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth','https://ep--x.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth','https://x-ep.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth',
    'https://ep-x.neonauth..c-7.us-east-2.aws.neon.tech/neondb/auth','https://ep-x.neonauth.c-7.us-east-2.aws.neon.tech./neondb/auth',
    'https://ep-x.neonauth.-c.aws.neon.tech/neondb/auth','https://127.0.0.1/neondb/auth','https://[::1]/neondb/auth',
    // not canonical, or not only a host
    'https://EP-X.NEONAUTH.C-7.US-EAST-2.AWS.NEON.TECH/neondb/auth','https://ep-x.neonauth.c-7.us-east-2.aws.neon.tech:443/neondb/auth',
    'https://ep-x.neonauth.c-7.us-east-2.aws.neon.tech@attacker.example/neondb/auth','https://ep-x.neonauth.c-7.us-east-2.aws.neon.tech%2eattacker.example/neondb/auth',
    'https://attacker.example/ep-x.neonauth.c-7.us-east-2.aws.neon.tech/auth'
  ];
  for(const url of refused){
    const config=proxyConfigFromEnv({...ENV,POOL_PLATFORM_AUTH_UPSTREAM_URL:url});
    assert.equal(config.enabled,false,url);
    assert.doesNotMatch(config.reason,/attacker|still-recipe|ep-x/,'the rejected value is never repeated');
    const up=upstream();
    assert.equal((await createAuthProxy({config,fetch:up.fetch})(getSession())).status,404,url);
    assert.deepEqual(up.calls,[]);
  }
});

test('the upstream auth URL uses the default HTTPS port only: no explicit port is accepted, a non-default port (and the explicit default :443) is refused, and nothing reaches Neon',async()=>{
  // No explicit port: accepted. The production-style host must keep working.
  for(const url of ['https://ep-still-recipe-b5g7680z.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth','https://ep-x.neonauth.c-7.aws.neon.tech/neondb/auth']){
    assert.deepEqual({...proxyConfigFromEnv({...ENV,POOL_PLATFORM_AUTH_UPSTREAM_URL:url})},{enabled:true,upstreamUrl:url,appOrigin:APP},url);
    assert.equal(authUpstreamUrl(url),url);
  }
  // A non-default explicit port is refused, on a Neon Auth host and on an attacker/lookalike host alike; the explicit
  // default :443 stays refused by canonicalization (the URL parser strips it, so the value is not canonical).
  const ports=[
    'https://ep-still-recipe-b5g7680z.neonauth.c-7.us-east-2.aws.neon.tech:8443/neondb/auth',
    'https://ep-x.neonauth.c-7.aws.neon.tech:8443/neondb/auth','https://ep-x.neonauth.c-7.aws.neon.tech:444/neondb/auth',
    'https://ep-x.neonauth.c-7.us-east-2.aws.neon.tech:443/neondb/auth','https://ep-x.neonauth.c-7.aws.neon.tech:80/neondb/auth',
    'https://x.neonauth.attacker.example:8443/neondb/auth','https://attacker.example:8443/ep-x.neonauth.c-7.aws.neon.tech/auth'
  ];
  for(const url of ports){
    assert.throws(()=>authUpstreamUrl(url),/default HTTPS port|canonical/,url);
    const config=proxyConfigFromEnv({...ENV,POOL_PLATFORM_AUTH_UPSTREAM_URL:url});
    assert.equal(config.enabled,false,url);
    assert.doesNotMatch(config.reason,/attacker|still-recipe|8443|444/,'the rejected value and its port are never repeated');
    const up=upstream();
    assert.equal((await createAuthProxy({config,fetch:up.fetch})(getSession())).status,404,url);
    assert.deepEqual(up.calls,[]);
  }
});

test('only the four routes exist: every other path under /api/auth is 404, a wrong method is 405, and neither reaches Neon',async()=>{
  assert.deepEqual(Object.keys(ROUTES).sort(),[P.send,P.session,P.verify,P.out].sort());
  assert.deepEqual(Object.values(ROUTES).map(r=>`${r.method} ${r.upstream}`).sort(),['GET get-session','POST email-otp/send-verification-otp','POST sign-in/email-otp','POST sign-out']);
  assert.equal(AUTH_PROXY_PATH,PROXY_PREFIX,'the browser calls exactly the prefix the proxy serves');
  const {handle,up}=proxyWith();
  for(const path of ['/api/auth','/api/auth/','/api/auth/get-session/','/api/auth/list-sessions','/api/auth/update-user','/api/auth/token','/api/auth/jwks',
    '/api/auth/sign-in/email','/api/auth/sign-in/social','/api/auth/email-otp/verify-email','/api/auth/GET-SESSION','/api/auth/get-session%00','/api/auth/get%2Dsession',
    '/api/auth/%2e%2e/sign-out','/api/auth/x/../../other','/api/auth//get-session','/api/authx/get-session','/api/auth/get-session.json','/api/auth/sign-out/extra']){
    for(const method of ['GET','POST']){
      const response=await handle(method==='GET'?req(path,{headers:browser}):post(path,{}));
      assert.equal(response.status,404,`${method} ${path}`);
    }
  }
  for(const [path,route] of Object.entries(ROUTES)){
    for(const method of ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].filter(m=>m!==route.method)){
      const response=await handle(req(path,{method,headers:{...browser,origin:APP,'access-control-request-method':'POST'},...(['GET','HEAD'].includes(method)?{}:{body:'{}'})}));
      assert.equal(response.status,405,`${method} ${path}`);
      assert.equal(response.headers.get('allow'),route.method);
      assert.deepEqual(accessControl(response),[],'a preflight never grants anything');
    }
  }
  assert.deepEqual(up.calls,[]);
});

test('Host must be exactly the app host (421 otherwise), whatever the URL claims',async()=>{
  const {handle,up}=proxyWith();
  for(const host of ['evil.example.test','pools.example.test:443','POOLS.example.test','pools.example.test.evil.test','sub.pools.example.test','localhost','pools.example.test.']){
    assert.equal((await handle(getSession({host}))).status,421,host);
    assert.equal((await handle(post(P.send,SEND,{host}))).status,421,host);
  }
  const noHost=new Request(`${APP}${P.session}`,{headers:headersOf(browser)});
  assert.equal((await handle(noHost)).status,421,'no Host');
  // The adapter's Host wins over the request's own header, and the URL's host is never trusted.
  assert.equal((await handle(getSession(),{host:'evil.example.test'})).status,421);
  assert.equal((await handle(req(P.session,{base:'https://evil.example.test',headers:browser}))).status,200,'the URL host is ignored; the Host header decides');
  assert.equal(up.calls.length,0,'the signed-out get-session above needed no upstream call');
});

test('Origin: every POST needs exactly the app origin; a GET with any other Origin is refused (403), and nothing reaches Neon',async()=>{
  const {handle,up}=proxyWith();
  for(const origin of [null,'null','http://pools.example.test','https://pools.example.test:8443','https://evil.example.test','https://pools.example.test/',
    'https://sub.pools.example.test','https://pools.example.test.evil.test','HTTPS://POOLS.EXAMPLE.TEST','','https://pools.example.test.']){
    for(const [path,body] of [[P.send,SEND],[P.verify,VERIFY],[P.out,{}]]){
      const response=await handle(post(path,body,{origin}));
      assert.equal(response.status,403,`${origin} ${path}`);
      assert.equal(response.headers.get('set-cookie'),null,'a refused sign-out deletes nothing');
    }
    if(origin!==null)assert.equal((await handle(getSession({origin}))).status,403,`GET ${origin}`);
  }
  assert.deepEqual(up.calls,[]);
  assert.equal((await handle(getSession({origin:APP}))).status,200);
  assert.equal((await handle(getSession({origin:null}))).status,200,'a same-origin GET need not send Origin');
});

test('Sec-Fetch-Site must be same-origin when sent, and Sec-Fetch-Mode cors or same-origin: same-site, cross-site, typed and navigations are 403',async()=>{
  const {handle,up}=proxyWith();
  for(const site of ['same-site','cross-site','none','']){
    assert.equal((await handle(getSession({'sec-fetch-site':site}))).status,403,`get-session ${site}`);
    assert.equal((await handle(post(P.send,SEND,{'sec-fetch-site':site}))).status,403,`send ${site}`);
  }
  for(const mode of ['navigate','no-cors','websocket','nested-navigate']){
    assert.equal((await handle(getSession({'sec-fetch-mode':mode}))).status,403,`mode ${mode}`);
  }
  assert.deepEqual(up.calls,[]);
  assert.equal((await handle(getSession({'sec-fetch-site':null,'sec-fetch-mode':null}))).status,200,'a client without fetch metadata is judged by Origin and Host alone');
  assert.equal((await handle(getSession({'sec-fetch-mode':'same-origin'}))).status,200);
});

test('state-changing routes accept only application/json, a small body, the exact schema and the sign-in OTP type',async()=>{
  const {handle,up}=proxyWith();
  for(const type of [null,'text/plain','application/x-www-form-urlencoded','multipart/form-data; boundary=x','application/json-patch+json','application/jsonx','text/json']){
    for(const [path,body] of [[P.send,SEND],[P.verify,VERIFY],[P.out,{}]]){
      assert.equal((await handle(post(path,body,{'content-type':type}))).status,415,`${type} ${path}`);
    }
  }
  const big=JSON.stringify({email:'player@example.test',type:'sign-in',pad:'x'.repeat(BODY_LIMIT)});
  assert.equal((await handle(post(P.send,big))).status,413);
  assert.equal((await handle(post(P.send,SEND,{'content-length':String(BODY_LIMIT+1)}))).status,413,'a declared size over the limit is refused unread');
  assert.equal((await handle(post(P.send,SEND,{'content-length':'1e3'}))).status,413);
  const bad=[
    [P.send,'{"email":'],[P.send,'[]'],[P.send,'"x"'],[P.send,'null'],[P.send,new Uint8Array([0x7b,0xff,0xfe,0x7d])],
    [P.send,{email:'player@example.test'}],[P.send,{type:'sign-in'}],[P.send,{...SEND,extra:1}],[P.send,{...SEND,email:'not-an-email'}],[P.send,{...SEND,email:['player@example.test']}],
    [P.send,{...SEND,email:`${'a'.repeat(250)}@example.test`}],[P.send,{...SEND,type:'email-verification'}],[P.send,{...SEND,type:'forget-password'}],[P.send,{...SEND,type:'Sign-In'}],[P.send,{...SEND,type:null}],
    [P.verify,{email:'player@example.test'}],[P.verify,{...VERIFY,otp:123456}],[P.verify,{...VERIFY,otp:'12a456'}],[P.verify,{...VERIFY,otp:'123'}],[P.verify,{...VERIFY,otp:'1'.repeat(11)}],
    [P.verify,{...VERIFY,email:'x'}],[P.verify,{...VERIFY,type:'sign-in'}],[P.verify,{...VERIFY,token:'x'}],
    [P.out,{session:'x'}],[P.out,'[]'],[P.out,''],[P.out,'null']
  ];
  for(const [path,body] of bad)assert.equal((await handle(post(path,body))).status,400,`${path} ${typeof body==='string'?body:JSON.stringify(body)}`);
  for(const path of [P.session,P.send,P.verify,P.out]){
    const response=path===P.session?await handle(req(`${path}?disableCookieCache=true`,{headers:browser})):await handle(post(`${path}?x=1`,{}));
    assert.equal(response.status,400,`query on ${path}`);
  }
  assert.deepEqual(up.calls,[]);
  const typed=proxyWith();
  await typed.handle(post(P.send,{...SEND,type:'email-verification'}));
  assert.equal(typed.logs[0].reason,'otp-type');
});

test('request OTP: Neon gets only the normalized body, the app Origin and no cookie; the answer is {success} with no cookie or JWT',async()=>{
  const {handle,up}=proxyWith();
  const response=await handle(post(P.send,{email:'  Player@Example.TEST ',type:'sign-in'},{
    cookie:`${APP_SESSION_COOKIE}=${SIGNED}; theme=dark; ${UPSTREAM_SESSION_COOKIE}=${SIGNED}`,authorization:'Bearer should-not-travel','x-neon-client-info':'{"sdk":"x"}',referer:`${APP}/participant.html`,
    'x-forwarded-for':'203.0.113.9','x-forwarded-host':'evil.example.test','user-agent':`UA/${'x'.repeat(600)}`
  }));
  assert.equal(response.status,200);
  assert.deepEqual(await json(response),{success:true});
  assert.equal(response.headers.get('set-cookie'),null);
  assert.equal(response.headers.get('set-auth-jwt'),null);
  assert.deepEqual(accessControl(response),[]);
  assert.equal(up.calls.length,1);
  const [call]=up.calls;
  assert.equal(call.url,`${UPSTREAM}/email-otp/send-verification-otp`);
  assert.equal(call.method,'POST');
  assert.equal(call.redirect,'manual');
  assert.ok(call.signal instanceof AbortSignal,'every upstream call has a timeout');
  assert.equal(call.body,'{"email":"player@example.test","type":"sign-in"}');
  assert.deepEqual(Object.keys(call.headers).sort(),['accept','content-type','origin','user-agent']);
  assert.equal(call.headers.origin,APP);
  assert.equal(call.headers['content-type'],'application/json');
  assert.equal(call.headers['user-agent'].length,512);
});

test('verify OTP: the session cookie is re-issued exactly for the app host, every other cookie is dropped, and the body has no token',async()=>{
  const {handle,up}=proxyWith();
  const response=await handle(post(P.verify,{email:'Player@Example.test',otp:' 123456 '}));
  assert.equal(response.status,200);
  assert.deepEqual(response.headers.getSetCookie(),[REISSUED]);
  const body=await json(response);
  assert.deepEqual(body,{user:USER});
  assert.equal(JSON.stringify(body).includes(TOKEN),false);
  assert.equal(response.headers.get('set-auth-token'),null);
  assert.deepEqual(accessControl(response),[]);
  assert.equal(up.calls[0].body,'{"email":"player@example.test","otp":"123456"}');
  assert.equal(up.calls[0].headers.cookie,undefined,'no cookie is sent to sign in');
  // A set-auth-jwt on the sign-in answer is passed on; one that is not JWT-shaped is not.
  const withJwt=proxyWith({...NEON,'sign-in/email-otp':{...NEON['sign-in/email-otp'],headers:{'set-auth-jwt':JWT}}});
  assert.equal((await withJwt.handle(post(P.verify,VERIFY))).headers.get('set-auth-jwt'),JWT);
  const odd=proxyWith({...NEON,'sign-in/email-otp':{...NEON['sign-in/email-otp'],headers:{'set-auth-jwt':'not a jwt'}}});
  assert.equal((await odd.handle(post(P.verify,VERIFY))).headers.get('set-auth-jwt'),null);
});

test('get session: no app cookie answers null without asking Neon; otherwise only its value travels, under Neon\'s name, the token is removed and set-auth-jwt kept',async()=>{
  const {handle,up}=proxyWith();
  // Neon's own cookie name, a case variant or a longer name is not the app's cookie: the browser contract is one name.
  for(const cookie of [null,'theme=dark','__Secure-neon-auth.session_data=abc',`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`,`__host-pool-platform-session=${SIGNED}`,
    `${APP_SESSION_COOKIE}x=${SIGNED}`,`${APP_SESSION_COOKIE}=`,`${APP_SESSION_COOKIE}=bad value`,`${APP_SESSION_COOKIE}=a"b`]){
    const response=await handle(getSession({cookie}));
    assert.equal(response.status,200,String(cookie));
    assert.equal(await response.text(),'null');
  }
  assert.deepEqual(up.calls,[]);
  const response=await handle(getSession({cookie:`theme=dark; ${UPSTREAM_SESSION_COOKIE}=PlantedUnderNeonsName0123456789; ${APP_SESSION_COOKIE}=${SIGNED}; __Secure-neon-auth.session_data=abc; other=1`}));
  assert.equal(response.status,200);
  assert.equal(up.calls.length,1);
  assert.equal(up.calls[0].url,`${UPSTREAM}/get-session`);
  assert.equal(up.calls[0].method,'GET');
  assert.equal(up.calls[0].body,null);
  assert.equal(up.calls[0].headers.cookie,`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`,'one cookie, built from the app cookie\'s value; no browser cookie is passed on');
  assert.equal(up.calls[0].headers.origin,APP);
  const body=await json(response);
  const {token:_,...sessionWithoutToken}=SESSION;
  assert.deepEqual(body,{session:sessionWithoutToken,user:USER});
  assert.equal(JSON.stringify(body).includes(TOKEN),false);
  assert.equal(response.headers.get('set-auth-jwt'),JWT,'the Data API bearer is passed on unchanged');
  assert.equal(response.headers.get('set-auth-token'),null);
  assert.deepEqual(accessControl(response),[]);
  assert.deepEqual(response.headers.getSetCookie(),[REISSUED],'a refreshed session cookie is re-issued; session_data is dropped');
  // Neon ending the session (Max-Age=0 or an Expires in the past) deletes the app-host cookie the same way.
  for(const ended of [`${UPSTREAM_SESSION_COOKIE}=; Max-Age=0; Path=/`,`${UPSTREAM_SESSION_COOKIE}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`]){
    const gone=proxyWith({'get-session':{body:null,cookies:[ended]}});
    assert.deepEqual((await gone.handle(getSession())).headers.getSetCookie(),[DELETE_SESSION_COOKIE],ended);
  }
  // An upstream cookie value that is not a plain cookie value is never re-issued.
  const injected=proxyWith({'get-session':{body:null,cookies:[`${UPSTREAM_SESSION_COOKIE}=x"y; Path=/`]}});
  assert.deepEqual((await injected.handle(getSession())).headers.getSetCookie(),[]);
});

test('sign out: only the session travels, under Neon\'s name, and exactly one deletion of the app cookie is always sent, whatever Neon answers',async()=>{
  assert.equal(DELETE_SESSION_COOKIE,`${APP_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  assert.equal(sessionCookie(SIGNED,604800),REISSUED);
  assert.equal(sessionCookie(SIGNED,null),`${APP_SESSION_COOKIE}=${SIGNED}; Path=/; HttpOnly; Secure; SameSite=Strict`);
  // The deletion names the cookie exactly as it was set: same name, Path=/, no Domain, Secure, HttpOnly, SameSite=Strict.
  const attributesOf=line=>line.split('; ').slice(1).filter(a=>!/^max-age=/i.test(a)).sort();
  assert.equal(DELETE_SESSION_COOKIE.split('=')[0],REISSUED.split('=')[0]);
  assert.deepEqual(attributesOf(DELETE_SESSION_COOKIE),attributesOf(REISSUED));
  assert.deepEqual(attributesOf(DELETE_SESSION_COOKIE),['HttpOnly','Path=/','SameSite=Strict','Secure']);
  assert.match(DELETE_SESSION_COOKIE,/; Max-Age=0;/);
  const {handle,up}=proxyWith();
  const response=await handle(post(P.out,{},{cookie:`other=1; ${APP_SESSION_COOKIE}=${SIGNED}`}));
  assert.equal(response.status,200);
  assert.deepEqual(await json(response),{success:true});
  assert.deepEqual(response.headers.getSetCookie(),[DELETE_SESSION_COOKIE]);
  assert.equal(up.calls[0].url,`${UPSTREAM}/sign-out`);
  assert.equal(up.calls[0].body,'{}');
  assert.equal(up.calls[0].headers.cookie,`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`);
  for(const failure of [new TypeError('network down'),{status:500,body:{message:'boom'}},{status:401,body:{code:'UNAUTHORIZED',message:'no session'}},{status:302,body:{},headers:{location:'https://evil.example.test'}}]){
    const failing=proxyWith({'sign-out':failure});
    const answer=await failing.handle(post(P.out,{}));
    assert.deepEqual(answer.headers.getSetCookie(),[DELETE_SESSION_COOKIE],JSON.stringify(failure));
  }
  const noSession=proxyWith();
  await noSession.handle(post(P.out,{}));
  assert.equal(noSession.up.calls[0].headers.cookie,undefined);
});

test('the browser\'s only session cookie is the app\'s own __Host- cookie: Neon\'s cookie name, Domain, Partitioned, SameSite and Path never reach the browser',async()=>{
  assert.notEqual(APP_SESSION_COOKIE,UPSTREAM_SESSION_COOKIE);
  // What __Host- requires (Secure, Path=/, no Domain), plus HttpOnly and SameSite=Strict, and never Partitioned.
  for(const line of [REISSUED,DELETE_SESSION_COOKIE,sessionCookie(SIGNED,null)]){
    const [pair,...attributes]=line.split('; ');
    assert.equal(pair.slice(0,pair.indexOf('=')),APP_SESSION_COOKIE,line);
    assert.ok(APP_SESSION_COOKIE.startsWith('__Host-'));
    for(const required of ['Path=/','Secure','HttpOnly','SameSite=Strict'])assert.ok(attributes.includes(required),`${line}: ${required}`);
    assert.deepEqual(attributes.filter(a=>/^path=/i.test(a)),['Path=/'],line);
    assert.equal(attributes.some(a=>/^(?:domain|partitioned|samesite=(?:none|lax))\b/i.test(a)),false,line);
  }
  // Whatever attributes Neon sets, only the value and lifetime survive, under the app's name, on both routes that
  // establish or refresh a session.
  const variants=[
    `${UPSTREAM_SESSION_COOKIE}=${SIGNED}; Max-Age=604800; Domain=neon.tech; Path=/neondb/auth; Secure; HttpOnly; SameSite=None; Partitioned`,
    `${UPSTREAM_SESSION_COOKIE}=${SIGNED}; max-age=604800; domain=.ep-example-000000.neonauth.c-0.us-east-2.aws.neon.tech; path=/; samesite=lax; partitioned; priority=high`
  ];
  for(const variant of variants){
    for(const [upstreamPath,request] of [['get-session',()=>getSession()],['sign-in/email-otp',()=>post(P.verify,VERIFY)]]){
      const {handle}=proxyWith({...NEON,[upstreamPath]:{...NEON[upstreamPath],cookies:[variant]}});
      assert.deepEqual((await handle(request())).headers.getSetCookie(),[REISSUED],`${upstreamPath} ${variant}`);
    }
  }
  // An upstream Set-Cookie that names the app's cookie (or anything else) is never passed on.
  const planted=proxyWith({...NEON,'get-session':{...NEON['get-session'],cookies:[`${APP_SESSION_COOKIE}=PlantedByUpstream0123456789; Path=/; Secure; HttpOnly`,'theme=dark; Path=/']}});
  const plantedAnswer=await planted.handle(getSession());
  assert.deepEqual(plantedAnswer.headers.getSetCookie(),[]);
  assert.equal(planted.logs[0].reason,'dropped-cookies:2');
  // On every route, every Set-Cookie the browser receives is the app's cookie, and none names Neon's.
  const {handle}=proxyWith();
  const answers=[await handle(getSession()),await handle(post(P.send,SEND)),await handle(post(P.verify,VERIFY)),await handle(post(P.out,{},{cookie:`${APP_SESSION_COOKIE}=${SIGNED}`}))];
  assert.deepEqual(answers.map(r=>r.headers.getSetCookie().length),[1,0,1,1]);
  for(const line of answers.flatMap(r=>r.headers.getSetCookie())){
    assert.ok(line.startsWith(`${APP_SESSION_COOKIE}=`),line);
    assert.equal(line.includes(UPSTREAM_SESSION_COOKIE)||line.includes('neon-auth'),false,line);
  }
});

test('the app session cookie more than once in a request fails closed on every route: 401, neither value reaches Neon, nothing is set or deleted',async()=>{
  const OTHER='PlantedSessTokenZyxwvutsrq98765.cGxhbnRlZC1zaWduYXR1cmU%3D';
  // None, exactly one, and more than one.
  assert.deepEqual(sessionCookieValue(null),{value:null,conflict:false});
  assert.deepEqual(sessionCookieValue(`theme=dark; ${UPSTREAM_SESSION_COOKIE}=${SIGNED}`),{value:null,conflict:false},'Neon\'s name is not the app\'s cookie');
  assert.deepEqual(sessionCookieValue(`theme=dark; ${APP_SESSION_COOKIE}=${SIGNED}`),{value:SIGNED,conflict:false});
  assert.deepEqual(sessionCookieValue(`${APP_SESSION_COOKIE}=bad value`),{value:null,conflict:false},'one malformed value is treated as absent');
  const duplicates=[
    `${APP_SESSION_COOKIE}=${SIGNED}; ${APP_SESSION_COOKIE}=${OTHER}`,`${APP_SESSION_COOKIE}=${OTHER}; ${APP_SESSION_COOKIE}=${SIGNED}`,
    `${APP_SESSION_COOKIE}=${SIGNED}; theme=dark; ${APP_SESSION_COOKIE}=${SIGNED}`,`${APP_SESSION_COOKIE}=${SIGNED}; ${APP_SESSION_COOKIE}=`,
    `${APP_SESSION_COOKIE}=bad value; ${APP_SESSION_COOKIE}=${SIGNED}`,` ${APP_SESSION_COOKIE} = ${SIGNED};${APP_SESSION_COOKIE}=${OTHER}`,
    `${APP_SESSION_COOKIE}=${OTHER}; ${UPSTREAM_SESSION_COOKIE}=${SIGNED}; ${APP_SESSION_COOKIE}=${OTHER}`
  ];
  for(const header of duplicates)assert.deepEqual(sessionCookieValue(header),{value:null,conflict:true},header);
  for(const header of duplicates){
    const seen=[];
    const {handle,up,logs}=proxyWith(NEON,{rateLimit:async args=>{seen.push(args);return true}});
    for(const request of [getSession({cookie:header}),post(P.send,SEND,{cookie:header}),post(P.verify,VERIFY,{cookie:header}),post(P.out,{},{cookie:header})]){
      const response=await handle(request);
      assert.equal(response.status,401,header);
      const text=await response.text();
      assert.deepEqual(JSON.parse(text),{code:'UNAUTHORIZED',message:'Sign-in could not be confirmed. Clear this site\'s cookies, then sign in again.'});
      for(const secret of [SIGNED,OTHER,TOKEN,'Planted','neon-auth',APP_SESSION_COOKIE])assert.equal(text.includes(secret),false,secret);
      assert.deepEqual(response.headers.getSetCookie(),[],'no cookie is set, and none deleted (not even by sign-out)');
      assert.equal(response.headers.get('set-auth-jwt'),null);
      assert.deepEqual(accessControl(response),[]);
      for(const [name,value] of Object.entries(SECURITY_HEADERS))assert.equal(response.headers.get(name),value,name);
    }
    assert.deepEqual(up.calls,[],'neither value reaches Neon');
    assert.deepEqual(seen,[],'refused before the rate-limit hook is asked');
    assert.deepEqual(logs.map(l=>`${l.route} ${l.status} ${l.reason}`),['get-session 401 cookie-conflict','send-otp 401 cookie-conflict','verify-otp 401 cookie-conflict','sign-out 401 cookie-conflict']);
  }
  // Exactly one still works, and none is still signed out without asking Neon.
  const {handle,up}=proxyWith();
  assert.equal(await (await handle(getSession({cookie:'theme=dark'}))).text(),'null');
  assert.deepEqual(up.calls,[]);
  assert.deepEqual((await handle(getSession({cookie:`theme=dark; ${APP_SESSION_COOKIE}=${SIGNED}`}))).headers.getSetCookie(),[REISSUED]);
  assert.deepEqual(up.calls.map(c=>c.headers.cookie),[`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`]);
});

// Finding 1 (Corrective 2): cookie names are matched byte-exactly. The retired parser trimmed the name with
// String.prototype.trim(), which removes Unicode whitespace (NBSP, VT, FF, CR, LF, BOM, ...); a sibling host that
// planted a name like NBSP + __Host-pool-platform-session — which the browser keeps distinct from the __Host- cookie —
// was then read by the proxy as the session, so its value was forwarded upstream (session fixation). Only ASCII SP and
// HTAB (cookie OWS) are now trimmed, only the byte-exact name supplies a value, and a trim()-collapsing look-alike
// fails the whole request closed, never supplying or being normalised into a session value.
test('only the byte-exact cookie name supplies a session value: ASCII SP/HTAB are the only trimmed whitespace, every trim()-collapsing look-alike fails closed, and other non-exact names supply nothing',async()=>{
  const A=APP_SESSION_COOKIE,OTHER='PlantedSessTokenZyxwvutsrq98765.cGxhbnRlZA%3D%3D';
  // 1. ASCII cookie OWS (SP, HTAB) around the exact name and value is stripped, and the exact value is read.
  for(const ows of [' ','\t','  ','\t ',' \t']){
    assert.deepEqual(sessionCookieValue(`${ows}${A}${ows}=${ows}${SIGNED}${ows}`),{value:SIGNED,conflict:false},JSON.stringify(ows));
    assert.deepEqual(sessionCookieValue(`theme=dark;${ows}${A}=${SIGNED}`),{value:SIGNED,conflict:false},JSON.stringify(ows));
  }
  // 2. The exact name once is read; the exact name more than once still fails closed (unchanged).
  assert.deepEqual(sessionCookieValue(`${A}=${SIGNED}`),{value:SIGNED,conflict:false});
  assert.deepEqual(sessionCookieValue(`${A}=${SIGNED}; ${A}=${OTHER}`),{value:null,conflict:true});
  // 3. A non-exact name the retired trim() parser would have accepted (NBSP, VT, FF, CR, LF, other Unicode whitespace,
  //    BOM), leading or trailing, alone or beside the genuine cookie: never a value, always fail closed. CR and LF are
  //    representable here as string input though a browser can never place them in a header on the wire.
  const collapsing={NBSP:' ',VT:'\u000B',FF:'\u000C',CR:'\r',LF:'\n',BOM:'﻿','EN QUAD':' ','IDEOGRAPHIC SPACE':'　','LINE SEP':' ','NARROW NBSP':' '};
  for(const [label,ws] of Object.entries(collapsing)){
    for(const header of [`${ws}${A}=${OTHER}`,`${A}${ws}=${OTHER}`,`${ws}${A}${ws}=${OTHER}`,`theme=dark; ${ws}${A}=${OTHER}`,
      `${A}=${SIGNED}; ${ws}${A}=${OTHER}`,`${ws}${A}=${OTHER}; ${A}=${SIGNED}`]){
      assert.deepEqual(sessionCookieValue(header),{value:null,conflict:true},`${label}: ${JSON.stringify(header)}`);
    }
  }
  // 4. A non-exact name that trim() would NOT fold to the protected name supplies no value and is not a conflict: the
  //    Neon upstream name, a case fold (never case-folded here), an added prefix/suffix, and Unicode look-alikes
  //    (Cyrillic о, a hyphen look-alike, a fullwidth underscore) — none is normalised, none supplies a session.
  for(const name of [UPSTREAM_SESSION_COOKIE,'__host-pool-platform-session','__HOST-pool-platform-session',`${A}x`,`x${A}`,
    '__Host-poоl-platform-session','__Host‐pool-platform-session','＿_Host-pool-platform-session']){
    assert.deepEqual(sessionCookieValue(`${name}=${SIGNED}`),{value:null,conflict:false},name);
  }
  // 5. Mixed unrelated cookies, the Neon upstream name among them, do not disturb the exact one.
  assert.deepEqual(sessionCookieValue(`theme=dark; lang=en-US; ${A}=${SIGNED}; ${UPSTREAM_SESSION_COOKIE}=${OTHER}; other=1`),{value:SIGNED,conflict:false});
  // 6. End to end: a planted look-alike fails closed on every route — 401, zero upstream, no Set-Cookie (not even by
  //    sign-out), refused before the rate-limit hook, and no cookie value in the log — alone or beside the genuine one.
  for(const planted of [` ${A}=${OTHER}`,`${A}=${SIGNED};  ${A}=${OTHER}`,`\u000C${A}=${OTHER}; other=1`]){
    const seen=[];
    const {handle,up,logs}=proxyWith(NEON,{rateLimit:async args=>{seen.push(args);return true}});
    for(const request of [getSession({cookie:planted}),post(P.send,SEND,{cookie:planted}),post(P.verify,VERIFY,{cookie:planted}),post(P.out,{},{cookie:planted})]){
      const response=await handle(request);
      assert.equal(response.status,401,JSON.stringify(planted));
      const text=await response.text();
      assert.deepEqual(JSON.parse(text),{code:'UNAUTHORIZED',message:'Sign-in could not be confirmed. Clear this site\'s cookies, then sign in again.'});
      for(const secret of [SIGNED,OTHER,TOKEN,'Planted',A])assert.equal(text.includes(secret),false,secret);
      assert.deepEqual(response.headers.getSetCookie(),[],'nothing set, nothing deleted');
      assert.deepEqual(accessControl(response),[]);
      for(const [name,value] of Object.entries(SECURITY_HEADERS))assert.equal(response.headers.get(name),value,name);
    }
    assert.deepEqual(up.calls,[],'the planted value never reaches Neon');
    assert.deepEqual(seen,[],'refused before the rate-limit hook');
    assert.deepEqual(logs.map(l=>`${l.route} ${l.status} ${l.reason}`),['get-session 401 cookie-conflict','send-otp 401 cookie-conflict','verify-otp 401 cookie-conflict','sign-out 401 cookie-conflict']);
    const log=JSON.stringify(logs);
    for(const secret of [SIGNED,OTHER,TOKEN,'Planted'])assert.equal(log.includes(secret),false,secret);
  }
  // 7. The look-alike, not the genuine value, is what caused the refusals above: the genuine cookie alone still signs
  //    in, and only its value travels upstream under Neon's name — the planted value is never laundered into it.
  const {handle,up}=proxyWith();
  assert.deepEqual((await handle(getSession({cookie:`${A}=${SIGNED}`}))).headers.getSetCookie(),[REISSUED]);
  assert.deepEqual(up.calls.map(c=>c.headers.cookie),[`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`]);
});

test('the opaque session token never reaches a body JavaScript can read, however Neon nests or renames it',async()=>{
  assert.deepEqual(stripTokens({token:'a',session:{token:'b',id:'s'},list:[{token:'c',keep:1}],deep:{a:{b:{token:'d'}}}}),{session:{id:'s'},list:[{keep:1}],deep:{a:{b:{}}}});
  assert.deepEqual(stripTokens(null),null);
  assert.throws(()=>stripTokens(JSON.parse('['.repeat(40)+']'.repeat(40))),/nested too deeply/);
  for(const leaked of [{session:{id:'s',sessionToken:TOKEN},user:USER},{user:{...USER,note:`x${TOKEN}x`}},{session:{id:SIGNED},user:USER}]){
    const {handle}=proxyWith({'get-session':{body:leaked,cookies:[SESSION_SET],headers:{'set-auth-jwt':JWT}}});
    const response=await handle(getSession());
    assert.equal(response.status,502,JSON.stringify(leaked));
    const text=await response.text();
    assert.equal(text.includes(TOKEN),false);
    assert.equal(response.headers.get('set-auth-jwt'),null,'nothing of a refused answer is passed on');
  }
  const verify=proxyWith({'sign-in/email-otp':{body:{user:{...USER,ref:TOKEN}},cookies:[SESSION_SET]}});
  assert.equal((await verify.handle(post(P.verify,VERIFY))).status,502,'the token of a cookie being issued is caught too');
});

test('every response carries no-store and the security headers, and never an Access-Control-* header',async()=>{
  const {handle}=proxyWith();
  const disabled=createAuthProxy({config:proxyConfigFromEnv({})});
  const responses=[
    await handle(getSession()),await handle(getSession({cookie:null})),await handle(post(P.send,SEND)),await handle(post(P.verify,VERIFY)),await handle(post(P.out,{})),
    await handle(req('/api/auth/nope',{headers:browser})),await handle(req(P.session,{method:'OPTIONS',headers:{...browser,origin:'https://evil.example.test','access-control-request-method':'GET'}})),
    await handle(getSession({host:'evil.example.test'})),await handle(post(P.send,SEND,{origin:'https://evil.example.test'})),await handle(post(P.send,SEND,{'content-type':'text/plain'})),
    await handle(post(P.send,'x'.repeat(BODY_LIMIT+1))),await handle(post(P.send,{})),await disabled(getSession()),
    await proxyWith({'get-session':new TypeError('down')}).handle(getSession()),await proxyWith({},{rateLimit:async()=>false}).handle(post(P.send,SEND)),
    await handle(getSession({cookie:`${APP_SESSION_COOKIE}=${SIGNED}; ${APP_SESSION_COOKIE}=${SIGNED}`}))
  ];
  assert.deepEqual(responses.map(r=>r.status),[200,200,200,200,200,404,405,421,403,415,413,400,404,502,429,401]);
  for(const response of responses){
    for(const [name,value] of Object.entries(SECURITY_HEADERS))assert.equal(response.headers.get(name),value,`${response.status} ${name}`);
    assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');
    assert.deepEqual(accessControl(response),[],String(response.status));
    assert.equal(response.headers.get('vary'),null);
  }
  assert.deepEqual(SECURITY_HEADERS,{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'cross-origin-resource-policy':'same-origin','content-security-policy':"default-src 'none'; frame-ancestors 'none'"});
});

test('the upstream URL and Origin are fixed server-side: nothing in a request changes the protocol, host, base path, endpoint or Origin',async()=>{
  const {handle,up}=proxyWith();
  const ATTACKER='https://x.neonauth.attacker.example/neondb/auth';
  const attempts=[
    getSession({'x-forwarded-host':'evil.example.test','x-forwarded-proto':'http',forwarded:'host=evil.example.test'}),
    req(P.session,{base:'https://evil.example.test',headers:{...browser,cookie:`${APP_SESSION_COOKIE}=${SIGNED}`}}),
    req('/api/auth/x/../get-session',{headers:{...browser,cookie:`${APP_SESSION_COOKIE}=${SIGNED}`}}),
    post(P.send,SEND,{'x-original-url':'/api/auth/sign-out','x-rewrite-url':'/admin'}),
    post(P.verify,VERIFY,{origin:APP,referer:'https://evil.example.test/'}),
    post(P.out,{},{cookie:`${APP_SESSION_COOKIE}=${SIGNED}`}),
    // Request data naming another Neon Auth upstream is never read for one.
    getSession({'x-forwarded-host':'x.neonauth.attacker.example','x-neon-auth-url':ATTACKER,'x-upstream':ATTACKER,referer:ATTACKER}),
    req(P.session,{base:'https://x.neonauth.attacker.example',headers:{...browser,cookie:`${APP_SESSION_COOKIE}=${SIGNED}`}})
  ];
  for(const request of attempts)await handle(request);
  // Refused outright, before any upstream call: a Host, query or body field naming another upstream.
  assert.equal((await handle(getSession({host:'x.neonauth.attacker.example'}))).status,421);
  assert.equal((await handle(req(`${P.session}?upstream=${encodeURIComponent(ATTACKER)}`,{headers:browser}))).status,400);
  assert.equal((await handle(post(P.send,{...SEND,upstream:ATTACKER}))).status,400);
  assert.deepEqual(up.calls.map(c=>c.url),[`${UPSTREAM}/get-session`,`${UPSTREAM}/get-session`,`${UPSTREAM}/get-session`,
    `${UPSTREAM}/email-otp/send-verification-otp`,`${UPSTREAM}/sign-in/email-otp`,`${UPSTREAM}/sign-out`,`${UPSTREAM}/get-session`,`${UPSTREAM}/get-session`]);
  for(const call of up.calls){
    assert.equal(call.headers.origin,APP);
    for(const name of ['host','referer','x-forwarded-host','x-forwarded-for','x-forwarded-proto','forwarded','x-original-url','authorization','x-neon-auth-url','x-upstream'])assert.equal(call.headers[name],undefined,name);
  }
});

// A hung upstream holds an open connection, and an open connection keeps Node's event loop alive. The proxy's own
// AbortSignal.timeout() timer does not (Node unrefs it), so a stand-in that merely waits for the abort leaves Node
// nothing to wait for, and the runner cancels the waiting test and every test after it. This stand-in therefore holds
// a ref'd handle, as a socket would, until the proxy aborts the call. Were the proxy never to abort, the handle would
// answer with a session after HUNG_FOR_MS, and the 502 expected of a timeout would fail the test.
const HUNG_FOR_MS=5000;
function hungUpstream(){
  const signals=[];
  const fetch=(url,init)=>new Promise((resolve,reject)=>{
    signals.push(init.signal);
    const connection=setTimeout(()=>resolve(new Response(JSON.stringify({session:SESSION,user:USER}),{status:200,headers:{'content-type':'application/json'}})),HUNG_FOR_MS);
    init.signal.addEventListener('abort',()=>{clearTimeout(connection);reject(init.signal.reason)},{once:true});
  });
  return{fetch,signals};
}

test('upstream failures become a generic 502 that carries nothing of Neon\'s answer; Neon\'s own 4xx passes only code and message',async()=>{
  const failures=[new TypeError('ECONNREFUSED internal-host:5432'),{status:500,body:{message:'internal detail'}},{status:503,raw:'<html>internal detail</html>',type:'text/html'},
    {status:302,body:{},headers:{location:'https://evil.example.test'}},{status:200,raw:'<html>internal detail</html>',type:'text/html'},{status:200,raw:'{"broken',type:'application/json'},
    {status:200,raw:`{"pad":"${'x'.repeat(70000)}"}`}];
  for(const failure of failures){
    const {handle}=proxyWith({'get-session':failure});
    const response=await handle(getSession());
    assert.equal(response.status,502,JSON.stringify(failure).slice(0,80));
    const text=await response.text();
    assert.doesNotMatch(text,/internal|ECONNREFUSED|evil/);
    assert.deepEqual(JSON.parse(text),{code:'AUTH_UPSTREAM_ERROR',message:'The sign-in service could not be reached. Try again.'});
  }
  // A hung upstream: the proxy's own timeout ends the call, on every route that calls Neon (sign-out still deletes).
  for(const [request,deletes] of [[()=>getSession(),[]],[()=>post(P.send,SEND),[]],[()=>post(P.verify,VERIFY),[]],
    [()=>post(P.out,{},{cookie:`${APP_SESSION_COOKIE}=${SIGNED}`}),[DELETE_SESSION_COOKIE]]]){
    const hung=hungUpstream(),logs=[];
    const slow=createAuthProxy({config:CONFIG,fetch:hung.fetch,log:entry=>logs.push(entry),timeoutMs:20});
    const timedOut=await slow(request());
    assert.equal(timedOut.status,502,'a hung upstream times out');
    assert.deepEqual(await json(timedOut),{code:'AUTH_UPSTREAM_ERROR',message:'The sign-in service could not be reached. Try again.'});
    assert.deepEqual(timedOut.headers.getSetCookie(),deletes);
    assert.equal(hung.signals.length,1);
    assert.equal(hung.signals[0].aborted,true,'the proxy abandoned the call');
    assert.equal(hung.signals[0].reason?.name,'TimeoutError','through its own timeout');
    assert.equal(logs[0].reason,'upstream-unreachable');
  }
  const rejected=proxyWith({'sign-in/email-otp':{status:400,body:{code:'INVALID_OTP',message:'Invalid OTP',token:TOKEN,stack:'at internal'},cookies:[SESSION_SET]}});
  const answer=await rejected.handle(post(P.verify,VERIFY));
  assert.equal(answer.status,400);
  assert.deepEqual(await json(answer),{code:'INVALID_OTP',message:'Invalid OTP'});
  assert.deepEqual(answer.headers.getSetCookie(),[],'a failed sign-in issues no session cookie');
  const limited=proxyWith({'email-otp/send-verification-otp':{status:429,body:{code:'TOO_MANY_ATTEMPTS',message:'Too many requests'}}});
  const tooMany=await limited.handle(post(P.send,SEND));
  assert.deepEqual([tooMany.status,await json(tooMany)],[429,{code:'TOO_MANY_ATTEMPTS',message:'Too many requests'}]);
  const bare=proxyWith({'email-otp/send-verification-otp':{status:400,raw:'',type:'text/plain'}});
  assert.deepEqual(await json(await bare.handle(post(P.send,SEND))),{code:'AUTH_ERROR',message:'The request could not be completed.'});
});

test('the rate-limit hook is asked before an OTP is sent or verified, sees a keyed hash instead of the email, and fails closed',async()=>{
  const seen=[];
  const allow=proxyWith(NEON,{rateLimit:async args=>{seen.push(args);return true}});
  await allow.handle(post(P.send,{email:'Player@Example.test',type:'sign-in'}),{clientIp:'203.0.113.7'});
  await allow.handle(post(P.verify,VERIFY),{clientIp:'203.0.113.7'});
  await allow.handle(getSession(),{clientIp:'203.0.113.7'});
  await allow.handle(post(P.out,{}),{clientIp:'203.0.113.7'});
  await allow.handle(post(P.send,SEND,{origin:'https://evil.example.test'}),{clientIp:'203.0.113.7'});
  await allow.handle(post(P.send,SEND,{cookie:`${APP_SESSION_COOKIE}=${SIGNED}; ${APP_SESSION_COOKIE}=${SIGNED}`}),{clientIp:'203.0.113.7'});
  const key=crypto.createHash('sha256').update('pool-platform-otp\u0000player@example.test').digest('hex');
  assert.equal(emailKey('player@example.test'),key);
  assert.deepEqual(seen,[{route:'send-otp',clientIp:'203.0.113.7',emailKey:key},{route:'verify-otp',clientIp:'203.0.113.7',emailKey:key}]);
  assert.equal(JSON.stringify(seen).includes('player'),false);
  for(const [limit,status] of [[async()=>false,429],[async()=>'yes',429],[async()=>undefined,429],[async()=>{throw new Error('store down')},503]]){
    const blocked=proxyWith(NEON,{rateLimit:limit});
    assert.equal((await blocked.handle(post(P.send,SEND))).status,status);
    assert.equal((await blocked.handle(post(P.verify,VERIFY))).status,status);
    assert.deepEqual(blocked.up.calls,[],'nothing reaches Neon');
  }
});

test('the log never holds an OTP, email, body, cookie, session token, JWT or Authorization value',async()=>{
  const email='Leaky.Person@Example.test',otp='987654',bearer='Bearer eyJsecret.payload.sig';
  const {handle,logs}=proxyWith({...NEON,'sign-in/email-otp':{...NEON['sign-in/email-otp'],headers:{'set-auth-jwt':JWT}}},{rateLimit:async()=>true});
  const sensitive={authorization:bearer,cookie:`${APP_SESSION_COOKIE}=${SIGNED}; theme=dark`,'user-agent':'UA-fingerprint-123'};
  await handle(post(P.send,{email,type:'sign-in'},sensitive));
  await handle(post(P.verify,{email,otp},sensitive));
  await handle(getSession(sensitive));
  await handle(post(P.out,{},sensitive));
  await handle(post(P.verify,{email,otp:'12x'},sensitive));
  await handle(post(P.send,{email,type:'forget-password'},{...sensitive,origin:'https://evil.example.test'}));
  await handle(req(`${P.session}?email=${encodeURIComponent(email)}&otp=${otp}`,{headers:{...browser,...sensitive}}));
  await handle(req(`/api/auth/${otp}/${email}`,{headers:{...browser,...sensitive}}));
  await handle(post(P.verify,{email,otp},{...sensitive,cookie:`${APP_SESSION_COOKIE}=${SIGNED}; ${APP_SESSION_COOKIE}=${TOKEN}`}));
  assert.equal(logs.length,9);
  assert.deepEqual(logs.at(-1),{route:'verify-otp',method:'POST',status:401,ms:logs.at(-1).ms,reason:'cookie-conflict'});
  const text=JSON.stringify(logs).toLowerCase();
  for(const secret of [email,'leaky',otp,TOKEN,SIGNED,JWT,bearer,'eyjsecret','ua-fingerprint','dark','sign-in"','forget-password'])assert.equal(text.includes(secret.toLowerCase()),false,secret);
  for(const entry of logs){
    assert.deepEqual(Object.keys(entry).filter(k=>!['route','method','status','ms','reason'].includes(k)),[]);
    assert.ok(entry.route===null||Object.values(ROUTES).some(r=>r.id===entry.route));
    if(entry.reason!==undefined)assert.match(entry.reason,/^[a-z-]+(?::\d+)?$/);
  }
});

test('vercel.json routes exactly the four paths to the one function, and the adapter maps them back to the routes\' own paths',async()=>{
  const vercel=JSON.parse(fs.readFileSync(new URL('./vercel.json',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(vercel).sort(),['$schema','functions','rewrites']);
  assert.deepEqual(vercel.rewrites,Object.entries(ROUTES).map(([source,route])=>({source,destination:`/api/auth?route=${route.id}`})));
  assert.deepEqual(vercel.functions,{'api/auth.mjs':{maxDuration:15}});
  assert.equal(typeof vercelDefault.fetch,'function');
  const up=upstream(),handler=createVercelHandler(ENV,{fetch:up.fetch,log:()=>{}});
  for(const [path,route] of Object.entries(ROUTES)){
    const rewritten=canonicalAuthRequest(new Request(`${APP}/api/auth?route=${route.id}`,{method:route.method,headers:{host:HOST},...(route.method==='POST'?{body:'{}',duplex:'half'}:{})}));
    assert.equal(new URL(rewritten.url).pathname+new URL(rewritten.url).search,path);
    assert.equal(rewritten.method,route.method);
  }
  const answer=await handler.fetch(new Request(`${APP}/api/auth?route=get-session`,{headers:headersOf({host:HOST,...browser})}));
  assert.deepEqual([answer.status,await answer.text()],[200,'null']);
  const out=await handler.fetch(new Request(`${APP}/api/auth?route=sign-out`,{method:'POST',headers:headersOf({host:HOST,...browser,origin:APP,'content-type':'application/json',cookie:`${APP_SESSION_COOKIE}=${SIGNED}`}),body:'{}'}));
  assert.deepEqual([out.status,out.headers.getSetCookie()],[200,[DELETE_SESSION_COOKIE]]);
  assert.equal(up.calls.at(-1).body,'{}','the body survives the mapping');
  assert.equal(up.calls.at(-1).headers.cookie,`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`);
  const conflict=await handler.fetch(new Request(`${APP}/api/auth?route=get-session`,{headers:headersOf({host:HOST,...browser,cookie:`${APP_SESSION_COOKIE}=${SIGNED}; ${APP_SESSION_COOKIE}=${SIGNED}`})}));
  assert.deepEqual([conflict.status,conflict.headers.getSetCookie()],[401,[]],'the adapter keeps the duplicate-cookie refusal');
  for(const url of ['/api/auth','/api/auth?route=bogus','/api/auth?route=get-session&x=1','/api/auth?x=1&route=get-session','/api/auth?route=get-session&route=sign-out','/api/auth?Route=get-session']){
    assert.equal((await handler.fetch(new Request(`${APP}${url}`,{headers:headersOf({host:HOST,...browser})}))).status,404,url);
  }
  assert.equal((await handler.fetch(new Request(`${APP}/api/auth?route=get-session`,{headers:headersOf({host:'evil.example.test',...browser})}))).status,421);
  const off=createVercelHandler({},{fetch:up.fetch,log:()=>{}});
  assert.equal((await off.fetch(new Request(`${APP}/api/auth/get-session`,{headers:headersOf({host:HOST,...browser})}))).status,404,'unconfigured fails closed');
});

// The real pinned SDK (@neondatabase/neon-js 0.7.0-beta, as the browser runs it) against the proxy, with the browser's
// part played by a small same-origin fetch: it adds the headers a browser adds and keeps a cookie jar that honours
// HttpOnly, Path and Max-Age. This proves the SDK's own request shapes pass every check unchanged.
const SDK=(()=>{try{return !!createRequire(import.meta.url).resolve('@neondatabase/neon-js')}catch{return false}})();
describe('the pinned Neon SDK through the proxy',{skip:SDK?false:'run npm ci in pool-platform to load the real SDK'},()=>{
  test('signed out, send code, verify, session with the JWT as bearer, sign out: only the four routes, and JavaScript never sees the session token',async()=>{
    const {createClient}=await import('@neondatabase/neon-js');
    // Neon's get-session: signed in exactly when the forwarded cookie is the session cookie Neon issued, by Neon's name.
    const neon={...NEON,'get-session':init=>{
      const signedIn=new Headers(init.headers).get('cookie')===`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`;
      const headers=new Headers({'content-type':'application/json',...REFLECTED,...(signedIn?{'set-auth-jwt':JWT,'set-auth-token':TOKEN}:{})});
      return new Response(JSON.stringify(signedIn?{session:SESSION,user:USER}:null),{status:200,headers});
    }};
    const up=upstream(neon),proxy=createAuthProxy({config:CONFIG,fetch:up.fetch});
    const jar=new Map(),browserCalls=[];
    const realFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const request=new Request(input,init),url=new URL(request.url);
      assert.equal(url.origin,APP,`the SDK asked for ${url.origin}: only the app's own origin is allowed`);
      const headers=new Headers(request.headers);
      headers.set('host',HOST);headers.set('sec-fetch-site','same-origin');headers.set('sec-fetch-mode','cors');
      if(request.method!=='GET')headers.set('origin',APP);
      const cookies=[...jar].filter(([,c])=>url.pathname.startsWith(c.path)).map(([name,c])=>`${name}=${c.value}`);
      if(cookies.length)headers.set('cookie',cookies.join('; '));
      browserCalls.push(`${request.method} ${url.pathname}${url.search}`);
      const response=await proxy(new Request(request.url,{method:request.method,headers,body:request.method==='GET'?undefined:await request.text()}));
      for(const line of response.headers.getSetCookie()){
        const [pair,...attrs]=line.split('; '),[name,value]=[pair.slice(0,pair.indexOf('=')),pair.slice(pair.indexOf('=')+1)];
        // Only ever the app's cookie, with what __Host- requires (Secure, Path=/, no Domain), HttpOnly and SameSite=Strict.
        assert.equal(name,APP_SESSION_COOKIE,line);
        for(const required of ['Path=/','HttpOnly','Secure','SameSite=Strict'])assert.ok(attrs.includes(required),line);
        assert.equal(attrs.some(a=>/^(?:domain|partitioned)\b/i.test(a)),false,line);
        if(attrs.includes('Max-Age=0'))jar.delete(name);else jar.set(name,{value,path:'/'});
      }
      // What page JavaScript can read: never Set-Cookie (the browser hides it), everything else on a same-origin answer.
      const visible=new Headers(response.headers);visible.delete('set-cookie');
      return new Response(response.body,{status:response.status,headers:visible});
    };
    try{
      const client=createClient({auth:{url:`${APP}${AUTH_PROXY_PATH}`},dataApi:{url:'https://data.example.test/neondb/rest/v1'}});
      const before=await client.auth.getSession();
      assert.equal(before.data?.session??null,null);
      const code=await client.auth.emailOtp.sendVerificationOtp({email:'player@example.test',type:'sign-in'});
      assert.equal(code.error,null);
      const signIn=await client.auth.signIn.emailOtp({email:'player@example.test',otp:'123456'});
      assert.equal(signIn.error,null);
      assert.deepEqual([...jar.keys()],[APP_SESSION_COOKIE],'the browser holds the app\'s cookie, never Neon\'s');
      const session=await client.auth.getSession();
      assert.equal(session.data.user.id,'user-1');
      assert.equal(session.data.session.token,JWT,'session.token is the JWT from set-auth-jwt, not the opaque token');
      assert.equal(extractAccessToken(session),JWT,'the Data API bearer path is unchanged');
      assert.equal(JSON.stringify(session).includes(TOKEN),false);
      assert.equal(JSON.stringify(signIn).includes(TOKEN),false);
      const out=await client.auth.signOut();
      assert.equal(out.error,null);
      assert.equal(jar.size,0,'signing out deleted the app-host cookie');
      const after=await client.auth.getSession();
      assert.equal(after.data?.session??null,null);
      assert.deepEqual([...new Set(browserCalls)].sort(),['GET /api/auth/get-session','POST /api/auth/email-otp/send-verification-otp','POST /api/auth/sign-in/email-otp','POST /api/auth/sign-out']);
      assert.deepEqual([...new Set(up.calls.map(c=>`${c.method} ${c.url.slice(UPSTREAM.length)}`))].sort(),['GET /get-session','POST /email-otp/send-verification-otp','POST /sign-in/email-otp','POST /sign-out']);
      for(const call of up.calls){
        assert.equal(call.headers.origin,APP);
        assert.equal(call.headers['x-neon-client-info'],undefined);
      }
    }finally{globalThis.fetch=realFetch}
  });
});

// npm test runs each file in its own child process (node --test). A test that waits on nothing ref'd lets that
// process's event loop empty, and the runner then cancels it and every test after it, which fails the run. So this file
// is run here exactly that way, in a fresh child with no preload, keep-alive or filter, and must finish with every test
// passed and none failed, cancelled or skipped, the tests after the hung-upstream case and the last one included.
// The child leaves this check out (SELF_CHECK), so it does not run itself again.
const SELF_CHECK='POOL_PLATFORM_PROXY_TEST_SELF_CHECK';
if(!process.env[SELF_CHECK]){
  test('this file, run by node --test in a fresh child process, finishes with every test passed and none cancelled, failed or skipped',()=>{
    const env={...process.env,[SELF_CHECK]:'1'};
    delete env.NODE_TEST_CONTEXT; // a top-level runner of its own, not a child reporting to this one
    delete env.NODE_OPTIONS; // nothing preloaded (a keep-alive there would hide the very failure this looks for)
    const run=spawnSync(process.execPath,['--test','--test-reporter=tap',fileURLToPath(import.meta.url)],{env,encoding:'utf8',timeout:120000});
    const total=name=>Number(new RegExp(`^# ${name} (\\d+)$`,'m').exec(run.stdout)?.[1]);
    assert.equal(run.status,0,run.stdout.slice(-3000));
    assert.deepEqual(['fail','cancelled','skipped','todo'].map(total),[0,0,0,0],run.stdout.slice(-3000));
    assert.ok(total('tests')>0);
    assert.equal(total('pass'),total('tests'));
    assert.doesNotMatch(run.stdout,/^\s*not ok /m);
    const ran=name=>assert.match(run.stdout,new RegExp(`^\\s*ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`,'m'),name);
    for(const name of ['upstream failures become a generic 502','the rate-limit hook is asked before an OTP','the log never holds an OTP','vercel.json routes exactly the four paths'])ran(name);
    if(SDK)ran('signed out, send code, verify, session with the JWT as bearer, sign out');
  });
}
