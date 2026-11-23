// TEST-ONLY server for the browser end-to-end checks of the commissioner final-score panel. Never deployed, never
// copied into dist/, and it refuses to start outside a disposable PostgreSQL (see assertDisposableDatabase).
//
// What is real and what is a stand-in:
//   REAL      the built pages and modules from dist/ (the same bytes the build allow-list ships), under the same
//             Content-Security-Policy; the same-origin Auth proxy (server/auth-proxy-core.mjs), with its Host, Origin,
//             cookie and token rules; every pool_platform_* migration, run by a real PostgreSQL as role authenticated.
//   STAND-IN  Neon Auth itself (fakeNeonAuth below: one fixed sign-in code for fixed synthetic addresses, unsigned
//             tokens) and the Neon Data API (dataApi below: it trusts the token's sub claim WITHOUT verifying a
//             signature and hands it to the fixture's pool_platform_current_user_id() through test.uid).
// So these checks say nothing about JWT verification, Neon Auth, Data API CORS or the hosted perimeter. They show how
// the reviewed page and the reviewed SQL behave together for a given, already authenticated subject.
//
// One HTTPS origin (https://localhost:<port>, self-signed) serves pages, /api/auth and /rest/v1, so the app's
// __Host- Secure session cookie works in Chromium and WebKit alike and the Data API call is same-origin.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {PROXY_PREFIX,UPSTREAM_SESSION_COOKIE,createAuthProxy,proxyConfigFromEnv,refusal} from '../../server/auth-proxy-core.mjs';
import {contentSecurityPolicy,parseRuntimeConfig} from '../../scripts/runtime-config.mjs';

export const E2E_OTP='424242';
// Synthetic addresses under the reserved .invalid TLD: no mail can ever be sent to them.
export const E2E_USERS=Object.freeze({
  'commish.alpha@e2e.invalid':'commish_alpha',
  'cocommish.alpha@e2e.invalid':'cocommish_alpha',
  'commish.beta@e2e.invalid':'commish_beta',
  'alice@e2e.invalid':'alice',
  'outsider@e2e.invalid':'outsider'
});
export const DATA_API_PATH='/rest/v1';
// Well-formed for the proxy's own configuration check; never resolved, because the proxy's fetch is fakeNeonAuth.
const FAKE_AUTH_UPSTREAM='https://ep-e2e-fixture-00000000.neonauth.c-0.us-east-0.aws.neon.tech/neondb/auth';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8'};

// The browser-callable RPCs these checks use, with the argument types the migrations declare. The legacy
// five-argument attestation RPC is listed on purpose: the database, not this list, must refuse it.
export const RPCS=Object.freeze({
  pool_platform_list_commissioner_pools:[],
  pool_platform_create_email_invite:[['p_entry_id','uuid'],['p_email','text'],['p_expires_hours','integer']],
  pool_platform_claim_email_invite:[['p_entry_id','uuid']],
  pool_platform_commissioner_context:[['p_pool_slug','text']],
  pool_platform_list_participant_pools:[],
  pool_platform_participant_context:[['p_pool_slug','text'],['p_season','integer'],['p_week','integer']],
  pool_platform_season_standings_snapshot:[['p_pool_id','uuid'],['p_season','integer']],
  pool_platform_week_projection_snapshot:[['p_week_id','uuid']],
  pool_platform_week_result_snapshot:[['p_week_id','uuid']],
  // The pick-writing code as deployed (tests/fixtures/deployed/qa-submission-paths-20261112.sql), for the checks
  // that a pick is refused after the deadline.
  pool_platform_submit_entry:[['p_week_id','uuid'],['p_entry_id','uuid'],['p_source','text'],['p_payload','jsonb']],
  pool_platform_submit_batch:[['p_week_id','uuid'],['p_source','text'],['p_items','jsonb']],
  pool_platform_attest_week_final_results_with_source:[['p_week_id','uuid'],['p_expected_revision','integer'],
    ['p_results','jsonb'],['p_source_sha256','text'],['p_source_reference','text'],['p_correction_reason','text']],
  pool_platform_attest_week_final_results:[['p_week_id','uuid'],['p_expected_revision','integer'],
    ['p_results','jsonb'],['p_source_sha256','text'],['p_correction_reason','text']]
});

export function runPsql(sql,{vars={},database,env=process.env}={}){
  return new Promise((resolve,reject)=>{
    const args=['-X','-q','-A','-t','-v','ON_ERROR_STOP=1'];
    for(const [name,value] of Object.entries(vars))args.push('-v',`${name}=${value}`);
    args.push('-f','-');
    const child=spawn('psql',args,{env:{...env,...(database?{PGDATABASE:database}:{})},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk});
    child.stderr.on('data',chunk=>{stderr+=chunk});
    child.on('error',reject);
    child.on('close',code=>resolve({code,stdout:stdout.replace(/\n$/,''),stderr}));
    child.stdin.end(sql);
  });
}

// Check before any database setup. A service or connection string could override the local host fields.
export function assertLocalDatabaseHost(env=process.env){
  const local=host=>!host||host==='localhost'||host==='127.0.0.1'||host==='::1'
    ||(host.startsWith('/')&&!host.includes(','));
  if(!local(env.PGHOST)||!local(env.PGHOSTADDR)||env.PGSERVICE
    ||/^postgres(?:ql)?:\/\//.test(env.PGDATABASE||'')||env.PGDATABASE?.includes('='))
    throw new Error('e2e-server refuses a non-loopback PostgreSQL host');
}

// The fixture marker confirms the local database was created by this harness.
export async function assertDisposableDatabase({database,env=process.env}){
  assertLocalDatabaseHost(env);
  if(!/^pool_e2e[a-z0-9_]*$/.test(database||''))throw new Error('e2e-server only uses a database named pool_e2e*');
  const marker=await runPsql("SELECT purpose FROM public.e2e_disposable_marker",{database,env});
  if(marker.code!==0||marker.stdout!=='disposable-e2e-only')
    throw new Error('e2e-server refuses a database without the disposable marker');
}

const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
// Shaped like a compact JWS so the SDK and extractAccessToken() accept it. It is NOT signed. Every token issued is a
// different string (jti), as two tokens of a real issuer are: the SDK tells a renewed token from the one it holds by
// comparing the two, and without this two tokens issued within the same second would be identical.
export function unsignedTestToken(subject,email){
  const now=Math.floor(Date.now()/1000);
  return `${b64({alg:'none',typ:'JWT',kid:'e2e-unsigned'})}.${b64({sub:subject,email,emailVerified:true,
    role:'authenticated',iss:'https://e2e-fixture.invalid',aud:'https://e2e-fixture.invalid',iat:now,exp:now+900,jti:crypto.randomUUID()})}.`
    +Buffer.from('e2e-unsigned-test-token').toString('base64url');
}
export function subjectOfTestToken(token){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))return null;
  try{
    const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
    return typeof claims.sub==='string'&&/^[a-z_]{1,40}$/.test(claims.sub)&&claims.exp>Date.now()/1000?claims.sub:null;
  }catch{return null}
}

// A minimal in-memory stand-in for the four Better Auth endpoints the proxy forwards to.
export function fakeNeonAuth(){
  const sessions=new Map();
  const json=(status,body,extra=[])=>{
    const headers=new Headers({'content-type':'application/json'});
    for(const [name,value] of extra)headers.append(name,value);
    return new Response(JSON.stringify(body),{status,headers});
  };
  const cookieOf=headers=>{
    const match=new RegExp(`(?:^|;\\s*)${UPSTREAM_SESSION_COOKIE.replace(/[.]/g,'\\.')}=([^;]+)`).exec(new Headers(headers).get('cookie')||'');
    return match?match[1]:null;
  };
  const view=record=>({
    session:{id:record.id,token:record.token,userId:record.subject,expiresAt:record.expiresAt,createdAt:record.createdAt,
      updatedAt:record.createdAt,ipAddress:null,userAgent:null},
    user:{id:record.subject,email:record.email,emailVerified:true,name:record.subject,image:null,
      createdAt:record.createdAt,updatedAt:record.createdAt}
  });
  return async function upstream(url,init={}){
    const target=new URL(url);
    if(!target.href.startsWith(`${FAKE_AUTH_UPSTREAM}/`))throw new Error('fakeNeonAuth: unexpected upstream URL');
    const route=target.href.slice(FAKE_AUTH_UPSTREAM.length+1),body=init.body?JSON.parse(init.body):null;
    if(route==='email-otp/send-verification-otp')return json(200,{success:true});
    if(route==='sign-in/email-otp'){
      const subject=E2E_USERS[body?.email];
      if(!subject||body?.otp!==E2E_OTP)return json(400,{code:'INVALID_OTP',message:'Invalid OTP'});
      const token=crypto.randomBytes(24).toString('hex'),cookie=`${token}.${crypto.randomBytes(24).toString('base64url')}`;
      const now=new Date();
      const record={id:crypto.randomUUID(),token,subject,email:body.email,createdAt:now.toISOString(),
        expiresAt:new Date(now.getTime()+3600_000).toISOString()};
      sessions.set(cookie,record);
      return json(200,{token,user:view(record).user},[
        ['set-cookie',`${UPSTREAM_SESSION_COOKIE}=${cookie}; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax`],
        ['set-auth-jwt',unsignedTestToken(subject,body.email)]]);
    }
    if(route==='get-session'){
      const record=sessions.get(cookieOf(init.headers));
      if(!record)return json(200,null);
      return json(200,view(record),[['set-auth-jwt',unsignedTestToken(record.subject,record.email)]]);
    }
    if(route==='sign-out'){
      sessions.delete(cookieOf(init.headers));
      return json(200,{success:true},[['set-cookie',`${UPSTREAM_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`]]);
    }
    return json(404,{code:'NOT_FOUND',message:'Not found'});
  };
}

const cast=(name,type)=>type==='jsonb'?`(:'args'::jsonb->'${name}')`:`(:'args'::jsonb->>'${name}')::${type}`;
// POST /rest/v1/rpc/<name>, answered in the PostgREST shape the app reads: the function's JSON on success,
// {code,message,details,hint} with 400 for a raised exception and 403 for a missing privilege.
async function dataApi(req,res,{database,env}){
  const send=(status,body)=>{
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    res.end(typeof body==='string'?body:JSON.stringify(body));
  };
  const name=decodeURIComponent(req.url.slice(`${DATA_API_PATH}/rpc/`.length).split('?')[0]);
  if(req.method!=='POST')return send(405,{code:'PGRST117',message:'Unsupported HTTP method',details:null,hint:null});
  const bearer=/^Bearer (.+)$/.exec(req.headers.authorization||'');
  const subject=bearer?subjectOfTestToken(bearer[1]):null;
  if(!subject)return send(401,{code:'PGRST302',message:'missing authentication credentials: required authorization bearer token in JWT format',details:null,hint:null});
  const params=Object.hasOwn(RPCS,name)?RPCS[name]:null;
  if(!params)return send(404,{code:'PGRST202',message:'Could not find the function in the schema cache',details:null,hint:null});
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>65536)return send(413,{code:'PGRST000',message:'payload too large',details:null,hint:null});chunks.push(chunk)}
  let args;
  try{args=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{return send(400,{code:'PGRST102',message:'Error in $: invalid JSON',details:null,hint:null})}
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!params.some(([p])=>p===key)))
    return send(404,{code:'PGRST202',message:'Could not find the function with the given arguments',details:null,hint:null});
  const call=`public.${name}(${params.map(([p,type])=>`${p} => ${cast(p,type)}`).join(', ')})`;
  const result=await runPsql(`\\set VERBOSITY verbose
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL ROLE authenticated;
SELECT set_config('test.uid', :'uid', true) AS uid \\gset e2e_
SELECT (${call})::text;
COMMIT;
`,{vars:{uid:subject,args:JSON.stringify(args)},database,env});
  if(result.code===0)return send(200,result.stdout===''?'null':result.stdout);
  const failure=/ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(result.stderr);
  if(!failure)return send(500,{code:'XX000',message:'e2e data api stand-in failed',details:null,hint:null});
  // A function this database does not have is answered as the Data API answers it: not found, before any SQL error.
  if(failure[1]==='42883')return send(404,{code:'PGRST202',message:'Could not find the function in the schema cache',details:null,hint:null});
  return send(failure[1]==='42501'?403:failure[1].startsWith('P0')||failure[1].startsWith('22')?400:500,
    {code:failure[1],message:failure[2],details:null,hint:null});
}

async function serveProxy(proxy,req,res){
  let request,response;
  try{
    const headers=new Headers();
    for(const [name,value] of Object.entries(req.headers))headers.set(name,Array.isArray(value)?value.join(', '):value);
    request=new Request(`https://localhost${req.url}`,{method:req.method,headers,
      ...(req.method==='GET'||req.method==='HEAD'?{}:{body:Readable.toWeb(req),duplex:'half'})});
  }catch{request=null}
  try{response=request?await proxy(request,{clientIp:req.socket.remoteAddress??null,host:req.headers.host}):refusal(405)}
  catch{response=refusal(502)}
  const headers={};
  response.headers.forEach((value,name)=>{if(name!=='set-cookie')headers[name]=value});
  const cookies=response.headers.getSetCookie();
  if(cookies.length)headers['set-cookie']=cookies;
  res.writeHead(response.status,headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

export async function startE2eServer({dir,port,key,cert,database,env=process.env,log=()=>{}}){
  await assertDisposableDatabase({database,env});
  const root=fs.realpathSync(dir);
  const config=parseRuntimeConfig(fs.readFileSync(path.join(root,'platform-config.js'),'utf8'));
  const origin=`https://localhost:${port}`;
  if(config.mode!=='live'||config.dataUrl!==`${origin}${DATA_API_PATH}`)
    throw new Error(`the build must be live with POOL_PLATFORM_DATA_URL=${origin}${DATA_API_PATH}`);
  const csp=contentSecurityPolicy(config);
  const proxyConfig=proxyConfigFromEnv({POOL_PLATFORM_MODE:'live',POOL_PLATFORM_AUTH_UPSTREAM_URL:FAKE_AUTH_UPSTREAM,
    POOL_PLATFORM_APP_ORIGIN:origin});
  if(!proxyConfig.enabled)throw new Error(`auth proxy configuration refused: ${proxyConfig.reason}`);
  const proxy=createAuthProxy({config:proxyConfig,fetch:fakeNeonAuth(),
    log:entry=>log(`AUTH ${entry.method} ${entry.route??'(no route)'} ${entry.status}${entry.reason?` ${entry.reason}`:''}`)});
  const server=https.createServer({key,cert},(req,res)=>{
    const fail=()=>{if(!res.headersSent)res.writeHead(500);res.end()};
    let url;
    try{url=req.url.startsWith('/')?new URL(`https://localhost${req.url}`):null}catch{url=null}
    if(!url||req.headers.host!==`localhost:${port}`){res.writeHead(421);res.end();return}
    if(url.pathname===PROXY_PREFIX||url.pathname.startsWith(`${PROXY_PREFIX}/`)){serveProxy(proxy,req,res).catch(fail);return}
    if(url.pathname.startsWith(`${DATA_API_PATH}/rpc/`)){
      dataApi(req,res,{database,env}).then(()=>log(`RPC ${url.pathname.slice(DATA_API_PATH.length+5)} ${res.statusCode}`)).catch(fail);return;
    }
    const reply=(status,headers={},body='')=>{
      res.writeHead(status,{'content-security-policy':csp,'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
        'cache-control':'no-store',...headers});
      res.end(body);
    };
    if(req.method!=='GET'&&req.method!=='HEAD'){reply(405,{allow:'GET, HEAD'});return}
    let name=url.pathname==='/'?'/index.html':url.pathname;
    // Match the release's internal Netlify invitation rewrite.
    if(/^\/join\/[a-z0-9][a-z0-9-]{1,62}[a-z0-9]\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(name))name='/participant.html';
    const segments=name.slice(1).split('/');
    if(segments.some(s=>s===''||s==='.'||s==='..'||s.includes('\\')||s.includes('\0'))||!TYPES[path.extname(name)]){reply(404);return}
    const file=path.join(root,...segments);
    let body=null;
    try{if(fs.realpathSync(file)===file&&fs.statSync(file).isFile())body=fs.readFileSync(file)}catch{body=null}
    if(body===null){reply(404);return}
    reply(200,{'content-type':TYPES[path.extname(name)]},req.method==='HEAD'?'':body);
  });
  // 127.0.0.1 and, where the machine has it, ::1: "localhost" answers whichever family a browser tries first.
  const listen=(target,host)=>new Promise((resolve,reject)=>{target.once('error',reject);target.listen(port,host,()=>{target.off('error',reject);resolve()})});
  const servers=[server];
  await listen(server,'127.0.0.1');
  const v6=https.createServer({key,cert},(req,res)=>server.emit('request',req,res));
  try{await listen(v6,'::1');servers.push(v6)}catch{}
  return{origin,csp,close:()=>Promise.all(servers.map(s=>new Promise(resolve=>{s.close(()=>resolve());s.closeAllConnections()})))};
}
