// Offline Stage B acceptance for the Commercial V1 participant and commissioner pages.
//
// Stage B is the signed-in validation on production (docs/PRE_REGISTRATION_HARDENING.md, "Stage B prerequisites") and
// stays unauthorized. These tests walk the same journeys offline beforehand: the shipped pages in headless Chromium,
// stubbed only at the network edge, so every line of page code runs unmodified.
//   - Sign-in failure states go through the real bundled SDK (vendor/neon-js.js, built from package-lock.json) and the
//     real same-origin Auth proxy (scripts/serve.mjs), in front of a stand-in Neon Auth that answers with the pinned
//     better-auth 1.6.23's error bodies. They need npm ci.
//   - Everything after sign-in uses a fake SDK and an in-memory Data API that refuses with the codes, in the order, and
//     in the shapes that migrations 002 and 003 use.
// Synthetic identities (example.test) and fixtures only; nothing here reaches Neon, Netlify or any other host. A pass is
// evidence about the page code, not about hosted Neon Auth or the Data API, which only Stage B itself can show.
// docs/STAGE_B_ACCEPTANCE.md maps each test to the FRONTEND_INTEGRATION_RUNBOOK.md checks it rehearses.
//
// The browser tests are opt-in, like the suite in ui-contract.test.mjs:
//   POOL_PLATFORM_TEST_BROWSER=1 NODE_PATH="$(npm root -g)" node --test pool-platform/stage-b-acceptance.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test,{after,before,describe} from 'node:test';
import {authErrorMessage} from './auth-core.js';
import {buildCommercialFrontend} from './scripts/build.mjs';
import {contentSecurityPolicy} from './scripts/runtime-config.mjs';
import {startServer} from './scripts/serve.mjs';

const read=name=>fs.readFileSync(new URL('./'+name,import.meta.url),'utf8');
const BROWSER=process.env.POOL_PLATFORM_TEST_BROWSER||'';
const ESBUILD=(()=>{try{return !!createRequire(import.meta.url).resolve('esbuild')}catch{return false}})();
const SDK_PATH=/import\('\.\/(vendor\/[^']+)'\)/.exec(read('platform-client.js'))?.[1];
const PAGE_CSP=contentSecurityPolicy({dataUrl:''});
// Representative CSS viewports: Android phone, iPhone, tablet, desktop. Emulation only, never a physical device.
const VIEWPORTS=[[360,800],[390,844],[768,1024],[1280,800]];
const PLAYER='player@example.test',OTHER='other@example.test',INVITED='invited@example.test',COMMISH='commish@example.test';
const SAVED_COPY='Your picks are saved. A commissioner import cannot overwrite this entry/week.';
const NOTICE={
  open:'Direct participant entry is available. Your final submission claims this entry/week and prevents a commissioner import from overwriting it.',
  update:'You already submitted this entry. You may update it from this same participant channel until the deadline.',
  commissioner:'This entry was already submitted through the commissioner channel. Direct participant submission is closed for this week.',
  closed:'This week is closed or this submission is locked. Your saved picks are read-only.'
};

// Every code the database raises that a participant page can show (migrations 002 and 003). invalid_source and
// invalid_invite_token are left out: the page always sends its own source and refuses a malformed token before any
// request. pool_not_found is the empty state, and auth_required is resent once and then becomes SIGN_IN_NOT_CONFIRMED.
const PARTICIPANT_CODES=['entry_not_owned','invalid_entry_week','entry_not_active','week_not_open','deadline_passed','invalid_payload',
  'source_conflict:commissioner_import','source_conflict:commissioner_manual','submission_locked','team_already_used',
  'invite_unavailable','invite_email_mismatch','invite_email_unverified','entry_already_claimed','season_not_found','week_not_found'];

test('every database refusal a participant can meet is shown as words, never as its raw code',()=>{
  for(const code of PARTICIPANT_CODES){
    const copy=authErrorMessage(code);
    assert.notEqual(copy,code,`${code} reaches the participant as a raw code`);
    assert.doesNotMatch(copy,/[a-z]+_[a-z_]+/,`${code}: ${copy}`);
  }
  // A pool that is readable but has no season or week open yet (weeks start as draft) is not an error in the
  // account or the invitation, and the copy must not suggest one.
  for(const code of ['season_not_found','week_not_found']){
    assert.match(authErrorMessage(code),/no week open for picks yet/i,code);
    assert.doesNotMatch(authErrorMessage(code),/invitation|sign in|not own/i,code);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Shared browser helpers.

function serveDirectory(root){
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json'};
  const server=http.createServer((req,res)=>{
    server.targets.push(req.url);
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/,'')||'index.html';
    if(name.includes('/')||name.includes('..')){res.writeHead(404).end();return}
    fs.readFile(new URL(name,root),(error,body)=>{
      if(error){res.writeHead(404).end();return}
      res.writeHead(200,{'content-type':types[path.extname(name)]||'application/octet-stream','content-security-policy':PAGE_CSP}).end(body);
    });
  });
  server.targets=[];
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server)));
}
const recordCsp=page=>page.addInitScript(()=>{
  window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
});
const visible=async(page,expected)=>{
  for(const [id,on] of Object.entries(expected))assert.equal(await page.isVisible(`#${id}`),on,`#${id} should be ${on?'visible':'hidden'}`);
};
const settle=page=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,150)));
async function launch(){
  try{return await createRequire(import.meta.url)('playwright').chromium.launch()}
  catch(error){assert.fail(`POOL_PLATFORM_TEST_BROWSER is set but playwright cannot be loaded (${error.message.split('\n')[0]}); put it on NODE_PATH`)}
}

// ---------------------------------------------------------------------------------------------------------------
// 1 and 2: sign-in through the real SDK and the real same-origin Auth proxy.

describe('Stage B sign-in through the real bundled SDK and the same-origin Auth proxy (opt-in)',{skip:!BROWSER?'set POOL_PLATFORM_TEST_BROWSER=1 (with playwright on NODE_PATH) to drive the real page':!ESBUILD?'run npm ci in pool-platform to bundle the real SDK':false},()=>{
  const UPSTREAM='https://ep-example-000000.neonauth.c-0.us-east-2.aws.neon.tech/neondb/auth',DATA='https://data.pool.test/neondb/rest/v1';
  // The stand-in Neon Auth. replies.send and replies.verify answer the OTP routes when set (a Response, or a thrown
  // error for an unreachable upstream); otherwise a send succeeds and nothing has a session. No code is ever sent.
  const upstream={calls:[],replies:{}};
  const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const upstreamFetch=async url=>{
    const route=url.slice(UPSTREAM.length);upstream.calls.push(route);
    const reply=route==='/email-otp/send-verification-otp'?upstream.replies.send:route==='/sign-in/email-otp'?upstream.replies.verify:null;
    if(reply)return reply();
    return route==='/email-otp/send-verification-otp'?json(200,{success:true}):json(200,null);
  };
  let work,local,browser;
  const contexts=[];
  before(async()=>{
    work=fs.mkdtempSync(path.join(os.tmpdir(),'pool-platform-stage-b-'));
    const dist=path.join(work,'dist');
    await buildCommercialFrontend({outDir:dist,env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_DATA_URL:DATA,POOL_PLATFORM_DEFAULT_POOL_SLUG:'it-pool'}});
    local=await startServer({dir:dist,port:0,log:()=>{},env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_AUTH_UPSTREAM_URL:UPSTREAM},upstreamFetch});
    browser=await launch();
  });
  after(async()=>{
    await Promise.all(contexts.splice(0).map(c=>c.close()));
    await browser?.close();await local?.close();
    if(work)fs.rmSync(work,{recursive:true,force:true});
  });

  async function openSignIn(page_){
    upstream.calls.length=0;upstream.replies={};
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});contexts.push(context);
    const page=await context.newPage(),seen={errors:[],data:[],escaped:[]};
    page.on('pageerror',error=>seen.errors.push(error.message));
    await context.route(/neonauth/,route=>{seen.escaped.push(route.request().url());return route.abort()});
    await context.route('https://data.pool.test/**',route=>{seen.data.push(route.request().url());return route.abort()});
    await page.goto(`${local.url}${page_}`);
    await page.locator('#authCard').waitFor({state:'visible'});
    return{page,context,seen};
  }
  // Signed out after a refusal: still on the sign-in card, no Sign out, no session cookie, no Data API request.
  async function stillSignedOut(page,context,seen,label){
    await visible(page,{authCard:true,signOut:false});
    assert.deepEqual((await context.cookies()).map(c=>c.name),[],`${label}: a cookie was set`);
    assert.deepEqual(seen.data,[],`${label}: the Data API was called`);
    assert.deepEqual(seen.escaped,[],`${label}: a request went to Neon Auth directly`);
    assert.deepEqual(seen.errors,[],`${label}: page error`);
  }
  const sendCode=async(page,email)=>{await page.fill('#email',email);await page.click('#sendCode')};
  const errorShown=(page,text)=>page.locator('#authError',{hasText:text}).waitFor({state:'visible'});

  for(const pagePath of ['participant.html','commissioner.html']){
    test(`${pagePath}: a malformed email or code is refused in the page before any Auth request, and a good one moves on`,async()=>{
      const {page,context,seen}=await openSignIn(pagePath);
      for(const email of ['','not-an-email','player@','a b@example.test']){
        await sendCode(page,email);
        await errorShown(page,'Enter a valid email address.');
        await visible(page,{otpWrap:false});
      }
      // Signed out, the proxy answers get-session itself (no cookie, nothing to ask Neon), so nothing reached upstream.
      assert.deepEqual(upstream.calls,[],'a malformed email reached Neon Auth');
      await sendCode(page,' Player@Example.test ');
      await page.locator('#otpWrap').waitFor({state:'visible'});
      await visible(page,{authError:false});
      assert.equal(await page.evaluate(()=>document.activeElement.id),'otp','the code field takes focus');
      assert.deepEqual(upstream.calls,['/email-otp/send-verification-otp']);
      for(const code of ['','12ab56','12 34 56x']){
        await page.fill('#otp',code);await page.click('#verifyCode');
        await errorShown(page,'Enter a valid email and numeric sign-in code.');
      }
      assert.equal(upstream.calls.includes('/sign-in/email-otp'),false,'no malformed code was sent');
      await stillSignedOut(page,context,seen,pagePath);
    });

    test(`${pagePath}: each refused send or verify says why, keeps the sign-in card and creates no session`,async()=>{
      const {page,context,seen}=await openSignIn(pagePath);
      // Bodies are the pinned better-auth 1.6.23's own (rate limiter; EMAIL_OTP_ERROR_CODES), not hosted Neon's.
      const sends=[
        ['rate limited upstream',()=>json(429,{message:'Too many requests. Please try again later.'}),'Too many requests. Please try again later.'],
        ['upstream error',()=>json(503,{message:'unavailable'}),'The sign-in service could not be reached. Try again.'],
        ['upstream unreachable',()=>{throw new TypeError('fetch failed')},'The sign-in service could not be reached. Try again.']
      ];
      for(const [label,reply,copy] of sends){
        upstream.replies.send=reply;
        await sendCode(page,PLAYER);await errorShown(page,copy);
        await visible(page,{otpWrap:false});
        await stillSignedOut(page,context,seen,label);
      }
      // A refusal from something in front of the proxy (a hosting edge, say) arrives as a non-JSON page. What Netlify
      // actually sends is unverified; whatever it is, the page must not fail silently.
      await page.route('**/api/auth/email-otp/send-verification-otp',route=>route.fulfill({status:429,contentType:'text/html',body:'<html><body>Too Many Requests</body></html>'}));
      await sendCode(page,PLAYER);await errorShown(page,'429');
      await visible(page,{otpWrap:false});
      await page.unroute('**/api/auth/email-otp/send-verification-otp');
      upstream.replies={};
      await sendCode(page,PLAYER);
      await page.locator('#otpWrap').waitFor({state:'visible'});
      await visible(page,{authError:false});
      const verifies=[
        ['wrong code',()=>json(400,{code:'INVALID_OTP',message:'Invalid OTP'}),'Invalid OTP'],
        ['expired code',()=>json(400,{code:'OTP_EXPIRED',message:'OTP expired'}),'OTP expired'],
        ['too many attempts',()=>json(403,{code:'TOO_MANY_ATTEMPTS',message:'Too many attempts'}),'Too many attempts'],
        ['upstream error',()=>json(500,{message:'boom'}),'The sign-in service could not be reached. Try again.']
      ];
      for(const [label,reply,copy] of verifies){
        upstream.replies.verify=reply;
        await page.fill('#otp','123456');await page.click('#verifyCode');
        await errorShown(page,copy);
        await visible(page,{otpWrap:true});
        await stillSignedOut(page,context,seen,label);
      }
      if(pagePath==='participant.html'){
        // The participant code field submits on Enter.
        upstream.replies.verify=()=>json(400,{code:'INVALID_OTP',message:'Invalid OTP'});
        await page.fill('#otp','654321');await page.locator('#authError').evaluate(el=>{el.textContent='';el.classList.add('hidden')});
        await page.press('#otp','Enter');await errorShown(page,'Invalid OTP');
      }
      else await visible(page,{consoleCard:false,importCard:false});
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 3 to 10: the signed-in journeys against a stand-in Data API.

// The fake SDK keeps its state in window.__fakeAuth: the signed-in email, every send and verify it was asked for, and
// optional gates (sendGate, verifyGate) and a failure for the next sends (sendFailure). The OTP is 123456.
const FAKE_SDK=`const b64=s=>btoa(s).replace(/[+]/g,'-').replace(/[/]/g,'_').replace(/=+$/,'');
const auth=()=>window.__fakeAuth;
const jwt=email=>[b64('{"alg":"none","typ":"JWT"}'),b64(JSON.stringify({email})),b64('shape-only-signature')].join('.');
const failure=message=>({data:null,error:Object.assign(new Error(message),{status:400})});
export function createClient(){return{auth:{
  getSession:async()=>auth().email?{data:{session:{token:jwt(auth().email)},user:{id:auth().email,email:auth().email}},error:null}:{data:{session:null,user:null},error:null},
  emailOtp:{sendVerificationOtp:async({email})=>{auth().sends.push(email);await auth().sendGate;if(auth().sendFailure)return failure(auth().sendFailure);auth().sent=email;return{data:{success:true},error:null}}},
  signIn:{emailOtp:async({email,otp})=>{auth().verifies.push(email);await auth().verifyGate;return email===auth().sent&&otp==='123456'?(auth().email=email,{data:{},error:null}):failure('Invalid OTP')}},
  signOut:async()=>{auth().email=null;return{data:{success:true},error:null}}
}}}`;

const PICKEM_GAMES=[
  {id:'g1',away:{key:'austin',label:'Austin'},home:{key:'denver',label:'Denver'}},
  {id:'g2',away:{key:'phoenix',label:'Phoenix'},home:{key:'seattle',label:'Seattle'}},
  {id:'g3',away:{key:'nashville',label:'Nashville'},home:{key:'baltimore',label:'Baltimore'}}
];
// Two teams share the label New York, so the page shows their keys; choices are in schedule order (team-0 to team-5).
const SURVIVOR_GAMES=[
  {id:'g1',away:{key:'NYG',label:'New York'},home:{key:'DAL',label:'Dallas'}},
  {id:'g2',away:{key:'MIA',label:'Miami'},home:{key:'NYJ',label:'New York'}},
  {id:'g3',away:{key:'ATX',label:'Austin'},home:{key:'DEN',label:'Denver'}}
];
const future=()=>new Date(Date.now()+86400000).toISOString(),past=()=>new Date(Date.now()-60000).toISOString();

// One pool, season and week 3, seen by participants and the commissioner alike, so a test can act on one page and
// observe on another. entries: [code, {owner, status, submission, history}].
function world({poolType='pickem',entries=[['E01'],['E02']],week={},commissioners=[COMMISH],invites={}}={}){
  return{
    poolType,commissioners,invites,calls:[],gates:[],readable:[],noSeason:false,noWeek:false,
    pool:{id:'pool-1',tenant_id:'tenant-1',slug:'it-pool',display_name:poolType==='survivor'?'IT Survivor':'IT Pick’em',pool_type:poolType,rules:{},branding:{}},
    season:{id:'season-1',season:2027,status:'active',config:{}},
    week:{id:'week-1',week:3,status:'open',opens_at:null,deadline_at:future(),
      config:{tiebreakRequired:poolType==='pickem',games:structuredClone(poolType==='survivor'?SURVIVOR_GAMES:PICKEM_GAMES)},...week},
    entries:entries.map(([code,more={}],i)=>({id:`entry-${i+1}`,entry_code:code,display_name:`Entry ${code}`,status:'active',owner:null,submission:null,history:[],...more}))
  };
}
const entryOf=(w,code)=>w.entries.find(e=>e.entry_code===code);

class Refusal extends Error{}
const refuse=code=>{throw new Refusal(code)};
// pool_platform_payload_valid: exactly the configured games, away/home, the tiebreak rule; Survivor one configured key,
// unused by this entry in every other week (team_already_used).
function checkPayload(w,entry,payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))refuse('invalid_payload');
  const games=w.week.config.games;
  if(w.poolType==='survivor'){
    if(Object.keys(payload).join()!=='team'||typeof payload.team!=='string')refuse('invalid_payload');
    if(games.flatMap(g=>[g.away.key,g.home.key]).filter(k=>k===payload.team).length!==1)refuse('invalid_payload');
    if(entry.history.some(h=>h.week!==w.week.week&&h.payload?.team===payload.team))refuse('team_already_used');
    return;
  }
  if(Object.keys(payload).some(k=>k!=='picks'&&k!=='tiebreak'))refuse('invalid_payload');
  const picks=payload.picks||{},ids=games.map(g=>g.id);
  if(Object.keys(picks).sort().join()!==[...ids].sort().join()||ids.some(id=>!['away','home'].includes(picks[id])))refuse('invalid_payload');
  if(w.week.config.tiebreakRequired||payload.tiebreak!==undefined){
    if(!Number.isInteger(payload.tiebreak)||payload.tiebreak<0||payload.tiebreak>200)refuse('invalid_payload');
  }
}
// pool_platform_submit_entry (migration 003), refusal for refusal in its order.
function submitEntry(w,email,{p_week_id,p_entry_id,p_source,p_payload}){
  if(!['participant','commissioner_import','commissioner_manual'].includes(p_source))refuse('invalid_source');
  const entry=w.entries.find(e=>e.id===p_entry_id);
  if(p_source==='participant'){if(!entry||entry.owner!==email)refuse('entry_not_owned')}
  else if(!entry||!w.commissioners.includes(email))refuse('commissioner_required');
  if(p_week_id!==w.week.id)refuse('invalid_entry_week');
  if(entry.status!=='active')refuse('entry_not_active');
  if(w.week.status!=='open')refuse('week_not_open');
  if(Date.now()>=new Date(w.week.deadline_at).getTime())refuse('deadline_passed');
  checkPayload(w,entry,p_payload);
  if(!entry.submission){
    entry.submission={source:p_source,status:'submitted',payload:p_payload,revision:1};
    return{ok:true,code:'created',submission_id:`sub-${entry.id}`,source:p_source,status:'submitted',revision:1};
  }
  if(entry.submission.source!==p_source)refuse(`source_conflict:${entry.submission.source}`);
  if(entry.submission.status==='locked')refuse('submission_locked');
  entry.submission={...entry.submission,payload:p_payload,revision:entry.submission.revision+1};
  return{ok:true,code:'updated',submission_id:`sub-${entry.id}`,source:p_source,status:'submitted',revision:entry.submission.revision};
}
function rpc(w,name,email,args){
  if(name==='pool_platform_claim_entry_invite'){
    const token=String(args.p_invite_token??'');
    if(!/^[0-9a-fA-F]{64}$/.test(token))refuse('invalid_invite_token');
    const invite=w.invites[token.toLowerCase()];
    if(!invite||invite.revoked||invite.expired||invite.claimedBy)refuse('invite_unavailable');
    if(invite.email){if(invite.email!==email)refuse('invite_email_mismatch');if(invite.unverified)refuse('invite_email_unverified')}
    const entry=w.entries.find(e=>e.id===invite.entryId);
    if(entry.owner&&entry.owner!==email)refuse('entry_already_claimed');
    entry.owner=email;invite.claimedBy=email;
    return{entry_id:entry.id,claimed:true};
  }
  if(name==='pool_platform_participant_context'){
    const readable=w.entries.some(e=>e.owner===email)||w.readable.includes(email)||w.commissioners.includes(email);
    if(args.p_pool_slug!==w.pool.slug||!readable)refuse('pool_not_found');
    if(w.noSeason)refuse('season_not_found');
    if(w.noWeek)refuse('week_not_found');
    const {tenant_id,...pool}=w.pool,{status,...season}=w.season;
    return{pool,season,week:w.week,entries:w.entries.filter(e=>e.owner===email&&e.status==='active').map(e=>({
      id:e.id,entry_code:e.entry_code,display_name:e.display_name,status:e.status,submission:e.submission,history:e.history.filter(h=>h.week!==w.week.week)
    }))};
  }
  if(name==='pool_platform_submit_entry')return submitEntry(w,email,args);
  const commissioner=w.commissioners.includes(email);
  if(name==='pool_platform_commissioner_context'){
    if(!commissioner||args.p_pool_slug!==w.pool.slug)refuse('commissioner_required');
    return{pool:w.pool,seasons:[{...w.season,weeks:[w.week],entries:w.entries.map(e=>({id:e.id,entry_code:e.entry_code,display_name:e.display_name,status:e.status,
      claimed:!!e.owner,submissions:[...e.history,...(e.submission?[{week:w.week.week,...e.submission}]:[])].map(({week,source,status,revision})=>({week,source,status,revision}))}))}]};
  }
  if(name==='pool_platform_create_entry_invite'){
    if(!commissioner)refuse('commissioner_required');
    return{invite_token:'cd'.repeat(32),entry_id:args.p_entry_id,expires_at:future()};
  }
  if(name==='pool_platform_submit_batch'){
    if(!['commissioner_import','commissioner_manual'].includes(args.p_source))refuse('commissioner_source_required');
    if(!commissioner||args.p_week_id!==w.week.id)refuse('commissioner_required');
    // Each row in its own subtransaction: a refused row is reported with its code and the others still run.
    return args.p_items.map(item=>{
      try{return{entry_id:item.entry_id,ok:true,result:submitEntry(w,email,{p_week_id:args.p_week_id,p_entry_id:item.entry_id,p_source:args.p_source,p_payload:item.payload})}}
      catch(error){if(error instanceof Refusal)return{entry_id:item.entry_id,ok:false,code:error.message};throw error}
    });
  }
  refuse(`unexpected_rpc:${name}`);
}
// Holds the (skip+1)th call of one RPC until release().
function gate(w,name,skip=0){
  let release,timer;
  const held={name,skip,released:new Promise(resolve=>{release=resolve})};
  const arrived=new Promise((resolve,reject)=>{
    held.seen=()=>{clearTimeout(timer);resolve()};
    timer=setTimeout(()=>reject(new Error(`the page never called ${name}`)),15000);timer.unref();
  });
  arrived.catch(()=>{});w.gates.push(held);
  return{arrived,release};
}
// The Data API at the network edge: identity from the bearer JWT, errors in PostgREST's body shape.
function dataApi(w){
  return async route=>{
    const request=route.request(),name=new URL(request.url()).pathname.split('/').pop();
    const claims=(request.headers().authorization||'').replace(/^Bearer /,'').split('.')[1];
    const email=claims?JSON.parse(Buffer.from(claims,'base64url').toString()).email:null;
    const args=request.postDataJSON()||{};
    w.calls.push({name,email,args,body:request.postData()});
    const held=w.gates.find(g=>g.name===name&&!g.done);
    if(held){if(held.skip>0)held.skip--;else{held.done=true;held.seen();await held.released}}
    // w.drop[name]: how many more calls of that RPC lose their connection before any answer.
    if(w.drop?.[name]>0){w.drop[name]--;return route.abort('failed')}
    const reply=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(!email)return reply(400,{code:'P0001',details:null,hint:null,message:'auth_required'});
    try{return await reply(200,rpc(w,name,email,args))}
    catch(error){if(error instanceof Refusal)return reply(400,{code:'P0001',details:null,hint:null,message:error.message});throw error}
  };
}
const calls=(w,name)=>w.calls.filter(c=>c.name===name);

describe('Stage B journeys against a stand-in Data API that refuses as the database does (opt-in)',{skip:BROWSER?false:'set POOL_PLATFORM_TEST_BROWSER=1 (with playwright on NODE_PATH) to drive the real page'},()=>{
  let server,browser,base;
  const contexts=[];
  before(async()=>{
    server=await serveDirectory(new URL('./',import.meta.url));
    base=`http://127.0.0.1:${server.address().port}`;
    browser=await launch();
  });
  after(async()=>{
    await Promise.all(contexts.splice(0).map(c=>c.close()));
    await browser?.close();
    await new Promise(resolve=>server?server.close(resolve):resolve());
  });

  // A page served as shipped. With a world it runs live: platform-config.js names a same-origin Data API, the SDK is
  // the fake above and the Data API is the stand-in. Without one it is the shipped sandbox.
  async function openPage({w=null,signedInAs=null,query='',width=390,height=844,path='participant.html',touch=false}={}){
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height},hasTouch:touch,isMobile:touch});
    contexts.push(context);
    const page=await context.newPage(),seen={dialogs:[],errors:[],requests:[]};
    page.on('dialog',dialog=>{seen.dialogs.push(dialog.message());dialog.dismiss().catch(()=>{})});
    page.on('pageerror',error=>seen.errors.push(error.message));
    page.on('request',request=>seen.requests.push(request.url()));
    await recordCsp(page);
    if(w){
      await page.addInitScript(email=>{window.__fakeAuth={email,sends:[],verifies:[]}},signedInAs);
      await page.route(`${base}/platform-config.js`,route=>route.fulfill({contentType:'text/javascript',
        body:`export const PLATFORM_CONFIG=Object.freeze({mode:'live',dataUrl:'${base}/data-api',defaultPoolSlug:'it-pool'});`}));
      await page.route(`${base}/${SDK_PATH}`,route=>route.fulfill({contentType:'text/javascript',body:FAKE_SDK}));
      await page.route(`${base}/data-api/rpc/*`,dataApi(w));
    }
    await page.goto(`${base}/${path}${query}`);
    return{page,seen};
  }
  const clean=async(page,seen)=>{
    assert.deepEqual(seen.dialogs,[],'no dialog may open');
    assert.deepEqual(seen.errors,[],'no page error');
    assert.equal(await page.locator('img,svg,script:not([src])').count(),0,'no injected element exists');
    assert.deepEqual(await page.evaluate(()=>window.__csp),[],'no Content-Security-Policy violation');
  };
  const signIn=async(page,email)=>{
    await page.fill('#email',email);await page.click('#sendCode');
    await page.locator('#otpWrap').waitFor({state:'visible'});
    await page.fill('#otp','123456');await page.click('#verifyCode');
  };
  const pick=async(page,sides)=>{for(const [i,side] of sides.entries())await page.click(`label[for="game-${i}-${side}"]`)};
  const checked=page=>page.locator('#games input:checked').evaluateAll(inputs=>inputs.map(input=>input.id));
  const submitted=(page,revision)=>page.locator('#submittedMeta',{hasText:`Revision ${revision} `}).waitFor();
  const refusedWith=(page,copy)=>page.locator('#validation',{hasText:copy}).waitFor({state:'visible'});
  const notice=page=>page.textContent('#sourceNotice');

  // ---- 3 and 4: invitation links that cannot be claimed.

  test('invites: an expired, revoked, used-up, already-claimed, unverified or malformed link explains itself, consumes nothing, and the account still reaches its own entry',async()=>{
    const TOKEN='ab'.repeat(32);
    const cases=[
      ['expired',{entryId:'entry-1',expired:true},'invite_unavailable'],
      ['revoked',{entryId:'entry-1',revoked:true},'invite_unavailable'],
      ['already claimed by its recipient',{entryId:'entry-1',claimedBy:OTHER},'invite_unavailable'],
      ['entry already owned by another account',{entryId:'entry-1'},'entry_already_claimed'],
      ['email-bound and not yet verified',{entryId:'entry-1',email:PLAYER,unverified:true},'invite_email_unverified']
    ];
    for(const [label,invite,code] of cases){
      const w=world({entries:[['E01',{owner:code==='entry_already_claimed'?OTHER:null}],['E02',{owner:PLAYER}]],invites:{[TOKEN]:invite}});
      const before=JSON.stringify(w.invites[TOKEN]);
      const {page,seen}=await openPage({w,signedInAs:PLAYER,query:`?pool=it-pool#invite=${TOKEN}`});
      await page.locator('#entryCard').waitFor({state:'visible'});
      await page.locator('#sessionError').waitFor({state:'visible'});
      assert.equal(await page.textContent('#sessionError'),authErrorMessage(code),label);
      await visible(page,{signOut:true,authCard:false,pickForm:true,emptyCard:false});
      assert.equal(await page.textContent('#poolName'),'IT Pick’em');
      assert.equal(await page.inputValue('#entrySelect'),'entry-2',`${label}: only the account's own entry is shown`);
      assert.equal(page.url(),`${base}/participant.html?pool=it-pool`,`${label}: the token left the address bar`);
      assert.equal(JSON.stringify(w.invites[TOKEN]),before,`${label}: the invite was not consumed`);
      assert.equal(entryOf(w,'E01').owner,code==='entry_already_claimed'?OTHER:null,`${label}: E01 changed hands`);
      assert.deepEqual(calls(w,'pool_platform_claim_entry_invite').map(c=>c.body),[JSON.stringify({p_invite_token:TOKEN})],label);
      assert.equal(seen.requests.some(url=>url.includes(TOKEN)),false,`${label}: a request URL carried the token`);
      await clean(page,seen);
    }
    // A token that is not 64 hex characters is refused in the page: no claim request is ever made.
    {
      const w=world({entries:[['E01'],['E02',{owner:PLAYER}]]});
      const {page,seen}=await openPage({w,signedInAs:PLAYER,query:'?pool=it-pool#invite=not-a-token'});
      await page.locator('#entryCard').waitFor({state:'visible'});
      assert.equal(await page.textContent('#sessionError'),'Invitation link is invalid.');
      assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
      assert.deepEqual(w.calls.map(c=>c.name),['pool_platform_participant_context']);
      await clean(page,seen);
    }
    // Opened signed out, an expired link says so only after sign-in (nothing is sent before), and a fresh link then works.
    {
      const FRESH='ef'.repeat(32);
      const w=world({invites:{[TOKEN]:{entryId:'entry-1',expired:true},[FRESH]:{entryId:'entry-1',email:INVITED}}});
      const {page,seen}=await openPage({w,query:`?pool=it-pool#invite=${TOKEN}`});
      await page.locator('#authCard').waitFor({state:'visible'});
      await visible(page,{sessionError:false,signOut:false});
      assert.deepEqual(w.calls,[],'nothing is claimed before sign-in');
      await signIn(page,INVITED);
      await page.locator('#emptyCard').waitFor({state:'visible'});
      assert.equal(await page.textContent('#sessionError'),authErrorMessage('invite_unavailable'));
      // The fresh link opened over this page: a fragment change, so the page reloads to read it. The fake SDK keeps
      // its session in page memory, which the reload drops, so the invited account signs in again and claims it.
      await page.goto(`${base}/participant.html?pool=it-pool#invite=${FRESH}`);
      await page.locator('#authCard').waitFor({state:'visible'});
      assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
      await signIn(page,INVITED);
      await page.locator('#pickForm').waitFor({state:'visible'});
      await visible(page,{sessionError:false});
      assert.equal(entryOf(w,'E01').owner,INVITED,'the fresh invite claimed E01');
      await clean(page,seen);
    }
  });

  // ---- 5: choosing between several entries.

  test('multiple entries: each entry shows only its own saved picks, notice and actions; read-only entries cannot be sent; Submit goes to the entry on screen',async()=>{
    const savedPicks={picks:{g1:'home',g2:'away',g3:'home'},tiebreak:30};
    const w=world({entries:[
      ['E01',{owner:PLAYER,submission:{source:'participant',status:'submitted',payload:savedPicks,revision:1}}],
      ['E02',{owner:PLAYER}],
      ['E03',{owner:PLAYER,submission:{source:'commissioner_import',status:'submitted',payload:{picks:{g1:'away',g2:'away',g3:'away'},tiebreak:41},revision:1}}],
      ['E04',{owner:PLAYER,submission:{source:'participant',status:'locked',payload:{picks:{g1:'away',g2:'home',g3:'away'},tiebreak:12},revision:2}}],
      ['E05',{owner:OTHER}]
    ]});
    const {page,seen}=await openPage({w,signedInAs:PLAYER});
    await page.locator('#pickForm').waitFor({state:'visible'});
    assert.deepEqual(await page.locator('#entrySelect option').evaluateAll(o=>o.map(x=>[x.value,x.textContent])),
      [['entry-1','Entry E01'],['entry-2','Entry E02'],['entry-3','Entry E03'],['entry-4','Entry E04']],'another account\'s entry is never offered');
    const expectEntry=async(id,{picks,tiebreak,copy,button,editable})=>{
      assert.equal(await page.inputValue('#entrySelect'),id);
      assert.deepEqual(await checked(page),picks,`${id} picks`);
      assert.equal(await page.inputValue('#tiebreak'),tiebreak,`${id} tiebreak`);
      assert.equal(await notice(page),copy,`${id} notice`);
      assert.equal(await page.textContent('#submitBtn'),button,`${id} button`);
      for(const id_ of ['submitBtn','clearBtn','tiebreak'])assert.equal(await page.isEnabled(`#${id_}`),editable,`${id} #${id_}`);
      assert.equal(await page.locator('#games input:disabled').count(),editable?0:6,`${id} pick inputs`);
    };
    await expectEntry('entry-1',{picks:['game-0-home','game-1-away','game-2-home'],tiebreak:'30',copy:NOTICE.update,button:'Update picks',editable:true});
    await page.selectOption('#entrySelect','entry-2');
    await expectEntry('entry-2',{picks:[],tiebreak:'',copy:NOTICE.open,button:'Submit picks',editable:true});
    // Unsaved picks on E02 never show up on another entry.
    await pick(page,['home','home','home']);await page.fill('#tiebreak','99');
    await page.selectOption('#entrySelect','entry-3');
    await expectEntry('entry-3',{picks:['game-0-away','game-1-away','game-2-away'],tiebreak:'41',copy:NOTICE.commissioner,button:'Submit picks',editable:false});
    // Forcing a submit past the disabled button is still refused in the page, and nothing is sent.
    await page.locator('#pickForm').evaluate(form=>form.requestSubmit());
    await refusedWith(page,'This entry is not editable.');
    await page.selectOption('#entrySelect','entry-4');
    await expectEntry('entry-4',{picks:['game-0-away','game-1-home','game-2-away'],tiebreak:'12',copy:NOTICE.closed,button:'Update picks',editable:false});
    await page.locator('#pickForm').evaluate(form=>form.requestSubmit());
    await refusedWith(page,'This entry is not editable.');
    assert.equal(calls(w,'pool_platform_submit_entry').length,0,'no read-only entry was sent');
    await page.selectOption('#entrySelect','entry-2');
    await expectEntry('entry-2',{picks:[],tiebreak:'',copy:NOTICE.open,button:'Submit picks',editable:true});
    await pick(page,['away','home','away']);await page.fill('#tiebreak','44');await page.click('#submitBtn');
    await submitted(page,1);
    assert.deepEqual(calls(w,'pool_platform_submit_entry').map(c=>c.args),[{p_week_id:'week-1',p_entry_id:'entry-2',p_source:'participant',p_payload:{picks:{g1:'away',g2:'home',g3:'away'},tiebreak:44}}]);
    assert.deepEqual(entryOf(w,'E01').submission.payload,savedPicks,'E01 is untouched');
    assert.equal(await page.inputValue('#entrySelect'),'entry-2','the reload keeps the entry on screen');
    assert.equal(await notice(page),NOTICE.update);
    await clean(page,seen);
    // A closed week, and a deadline that has passed while the week is still marked open, are read-only on arrival.
    for(const weekState of [{status:'locked'},{deadline_at:past()}]){
      const closed=world({entries:[['E01',{owner:PLAYER}]],week:weekState});
      const {page:p2,seen:s2}=await openPage({w:closed,signedInAs:PLAYER});
      await p2.locator('#pickForm').waitFor({state:'visible'});
      assert.equal(await p2.textContent('#sourceNotice'),NOTICE.closed,JSON.stringify(weekState));
      assert.equal(await p2.isEnabled('#submitBtn'),false,JSON.stringify(weekState));
      await clean(p2,s2);
    }
  });

  // ---- 6: Pick'em submission and confirmation.

  test('Pick\'em: only a saved submission shows the confirmation; every refusal shows its reason, takes focus and leaves the picks editable',async()=>{
    const later=[
      ['the commissioner imported this entry meanwhile',w=>{entryOf(w,'E01').submission={source:'commissioner_import',status:'submitted',payload:{picks:{g1:'away',g2:'away',g3:'away'},tiebreak:1},revision:1}},'source_conflict:commissioner_import'],
      ['the deadline passed while the page was open',w=>{w.week.deadline_at=past()},'deadline_passed'],
      ['the commissioner locked the week',w=>{w.week.status='locked'},'week_not_open'],
      ['the entry was deactivated',w=>{entryOf(w,'E01').status='inactive'},'entry_not_active'],
      ['the entry was reassigned',w=>{entryOf(w,'E01').owner=OTHER},'entry_not_owned'],
      ['the schedule changed',w=>{w.week.config={...w.week.config,games:[...w.week.config.games,{id:'g4',away:{key:'a',label:'A'},home:{key:'b',label:'B'}}]}},'invalid_payload']
    ];
    for(const [label,change,code] of later){
      const w=world({entries:[['E01',{owner:PLAYER}]]});
      const {page,seen}=await openPage({w,signedInAs:PLAYER});
      await page.locator('#pickForm').waitFor({state:'visible'});
      change(w);
      const before=JSON.stringify(entryOf(w,'E01').submission);
      await pick(page,['away','home','away']);await page.fill('#tiebreak','47');await page.click('#submitBtn');
      await refusedWith(page,authErrorMessage(code));
      assert.equal(await page.evaluate(()=>document.activeElement.id),'validation',`${label}: the reason takes focus`);
      await visible(page,{submittedCard:false});
      assert.equal(await page.isEnabled('#submitBtn'),true,`${label}: Submit is usable again`);
      assert.deepEqual(await checked(page),['game-0-away','game-1-home','game-2-away'],`${label}: the picks are kept`);
      assert.equal(JSON.stringify(entryOf(w,'E01').submission),before,`${label}: nothing was saved`);
      await clean(page,seen);
    }
    // An own submission locked meanwhile: the update is refused and the saved revision stays.
    {
      const w=world({entries:[['E01',{owner:PLAYER,submission:{source:'participant',status:'submitted',payload:{picks:{g1:'home',g2:'home',g3:'home'},tiebreak:20},revision:1}}]]});
      const {page,seen}=await openPage({w,signedInAs:PLAYER});
      await page.locator('#pickForm').waitFor({state:'visible'});
      entryOf(w,'E01').submission.status='locked';
      await page.click('label[for="game-0-away"]');await page.click('#submitBtn');
      await refusedWith(page,authErrorMessage('submission_locked'));
      await visible(page,{submittedCard:false});
      assert.equal(entryOf(w,'E01').submission.revision,1);
      await clean(page,seen);
    }
    // The success path, for contrast: the claim, then a same-source update.
    const w=world({entries:[['E01',{owner:PLAYER}]]});
    const {page,seen}=await openPage({w,signedInAs:PLAYER});
    await page.locator('#pickForm').waitFor({state:'visible'});
    assert.equal(await notice(page),NOTICE.open);
    await pick(page,['away','home','away']);await page.fill('#tiebreak','47');await page.click('#submitBtn');
    await submitted(page,1);
    assert.equal(await page.textContent('#submittedTitle'),'Participant channel claimed');
    assert.equal(await page.textContent('#submittedMessage'),SAVED_COPY);
    assert.equal(await notice(page),NOTICE.update);
    assert.equal(await page.textContent('#submitBtn'),'Update picks');
    await visible(page,{validation:false});
    await page.click('label[for="game-2-home"]');await page.click('#submitBtn');
    await submitted(page,2);
    assert.equal(await page.textContent('#submittedTitle'),'Picks updated');
    assert.deepEqual(entryOf(w,'E01').submission,{source:'participant',status:'submitted',payload:{picks:{g1:'away',g2:'home',g3:'home'},tiebreak:47},revision:2});
    await clean(page,seen);
  });

  // ---- 7: Survivor.

  test('Survivor: a used team is locked and refused in the page, a team the server knows was used elsewhere is refused with the reason, and the chosen key is what is saved',async()=>{
    const w=world({poolType:'survivor',entries:[['E01',{owner:PLAYER,history:[{week:1,source:'participant',status:'submitted',payload:{team:'DAL'},revision:1}]}]]});
    const {page,seen}=await openPage({w,signedInAs:PLAYER});
    await page.locator('#pickForm').waitFor({state:'visible'});
    assert.deepEqual(await page.locator('#games label').allTextContents(),['New York (NYG)','Dallas · USED','Miami','New York (NYJ)','Austin','Denver']);
    assert.deepEqual(await page.locator('#games input').evaluateAll(i=>i.map(x=>[x.value,x.disabled])),
      [['NYG',false],['DAL',true],['MIA',false],['NYJ',false],['ATX',false],['DEN',false]]);
    await visible(page,{tiebreakCard:false});
    await page.click('#submitBtn');
    await refusedWith(page,'Choose one available team.');
    // A used team forced past its disabled input is still refused before anything is sent.
    await page.locator('#team-1').evaluate(input=>{input.disabled=false;input.checked=true});
    await page.click('#submitBtn');
    await refusedWith(page,'That team has already been used by this entry.');
    assert.equal(calls(w,'pool_platform_submit_entry').length,0);
    // Week 2 was saved for this entry from elsewhere after the page loaded: only the server knows Miami is used.
    entryOf(w,'E01').history.push({week:2,source:'participant',status:'submitted',payload:{team:'MIA'},revision:1});
    await page.click('label[for="team-2"]');
    assert.equal(await page.textContent('#summary .summary-row strong'),'Miami');
    await page.click('#submitBtn');
    await refusedWith(page,authErrorMessage('team_already_used'));
    await visible(page,{submittedCard:false});
    assert.equal(entryOf(w,'E01').submission,null);
    await page.click('label[for="team-3"]');await page.click('#submitBtn');
    await submitted(page,1);
    assert.deepEqual(entryOf(w,'E01').submission.payload,{team:'NYJ'});
    assert.equal(await page.textContent('#summary .summary-row strong'),'New York (NYJ)');
    // The reload marks Miami used as well, now that the page has been told.
    assert.deepEqual((await page.locator('#games input').evaluateAll(i=>i.map(x=>x.disabled))).slice(0,4),[false,true,true,false]);
    await clean(page,seen);
  });

  // ---- 8: commissioner CSV validation.

  test('commissioner import: unresolvable Pick\'em and Survivor rows are listed row by row, markup stays text, and nothing is submitted until every row resolves',async()=>{
    const runImport=async(page,text)=>{await page.fill('#importText',text);await page.click('#runImport')};
    const rows=page=>page.locator('#resultBody tr').evaluateAll(trs=>trs.map(tr=>[...tr.cells].map(td=>td.textContent)));
    {
      const w=world({entries:[['E01'],['E02'],['E03'],['E04']]});
      const {page,seen}=await openPage({w,signedInAs:COMMISH,path:'commissioner.html'});
      await page.locator('#importCard').waitFor({state:'visible'});
      assert.equal(await page.textContent('#importHelp'),'CSV headers: entry_code,g1,g2,g3,tiebreak. Pick values may use away/home or the displayed city/team label.');
      await runImport(page,'entry_code,g1,g2,g3,tiebreak\nE01,away,home,away,47\nE99,away,home,away,40\nE02,<img src=x onerror=alert(1)>,home,away,40\nE03,home,home,home,250\nE04,Austin,Seattle,baltimore,');
      await page.locator('#resultTableWrap').waitFor({state:'visible'});
      assert.equal(await page.textContent('#importError'),'Import validation found 4 row error(s). Fix them before submission.');
      assert.deepEqual(await rows(page),[
        ['Row 3 · E99','unknown_entry'],
        ['Row 4 · E02','invalid_picks · game g1 · "<img src=x onerror=alert(1)>"'],
        ['Row 5 · E03','invalid_tiebreak'],
        ['Row 6 · E04','missing_tiebreak']
      ]);
      await visible(page,{importResult:false});
      for(const [text,code] of [['entry_code,g1,g2,tiebreak\nE01,away,home,4','missing_game_columns'],['','no_data'],['entry_code,g1,g2,g3\nE01,away,home,away','missing_tiebreak'],['code,g1,g2,g3,tiebreak\nE01,away,home,away,4','missing_entry_code']]){
        await runImport(page,text);
        await page.locator('#importError',{hasText:'1 row error(s)'}).waitFor();
        assert.deepEqual(await rows(page),[['CSV',code]],code);
      }
      assert.equal(calls(w,'pool_platform_submit_batch').length,0,'nothing is submitted while any row is rejected');
      // Fixed: labels resolve to sides, and both rows are sent.
      await runImport(page,'entry_code,g1,g2,g3,tiebreak\nE01,away,home,away,47\nE04,Austin,Seattle,baltimore,12');
      await page.locator('#importResult').waitFor({state:'visible'});
      await visible(page,{importError:false});
      assert.deepEqual(calls(w,'pool_platform_submit_batch')[0].args.p_items,[
        {entry_id:'entry-1',payload:{picks:{g1:'away',g2:'home',g3:'away'},tiebreak:47}},
        {entry_id:'entry-4',payload:{picks:{g1:'away',g2:'home',g3:'home'},tiebreak:12}}
      ]);
      await clean(page,seen);
    }
    {
      const w=world({poolType:'survivor',entries:[['E01'],['E02'],['E03']]});
      const {page,seen}=await openPage({w,signedInAs:COMMISH,path:'commissioner.html'});
      await page.locator('#importCard').waitFor({state:'visible'});
      assert.equal(await page.textContent('#importHelp'),'CSV headers: entry_code,team');
      await runImport(page,'entry_code,team\nE01,New York\nE02,Atlantis\nE03,');
      await page.locator('#resultTableWrap').waitFor({state:'visible'});
      assert.deepEqual(await rows(page),[
        ['Row 2 · E01','ambiguous_team_label · "New York" · matches NYG (New York) in g1 and NYJ (New York) in g2 · type NYG or NYJ instead'],
        ['Row 3 · E02','unknown_team · "Atlantis"'],
        ['Row 4 · E03','missing_team']
      ]);
      assert.equal(calls(w,'pool_platform_submit_batch').length,0);
      await runImport(page,'entry_code,team\nE01,NYJ\nE02,miami');
      await page.locator('#importResult').waitFor({state:'visible'});
      assert.deepEqual(calls(w,'pool_platform_submit_batch')[0].args.p_items.map(i=>i.payload.team),['NYJ','MIA'],'labels are sent as stable keys');
      await clean(page,seen);
    }
  });

  // ---- 9: the source lock, both ways, across the two pages.

  test('source lock: a participant\'s submission is reported as a conflict by the import and never overwritten; the commissioner\'s import makes that entry read-only for the participant',async()=>{
    const w=world({entries:[['E01',{owner:PLAYER}],['E02',{owner:PLAYER}],['E03'],['E04',{status:'inactive'}]]});
    const {page:player,seen:playerSeen}=await openPage({w,signedInAs:PLAYER});
    await player.locator('#pickForm').waitFor({state:'visible'});
    await pick(player,['home','home','home']);await player.fill('#tiebreak','21');await player.click('#submitBtn');
    await submitted(player,1);
    const participantSaved=structuredClone(entryOf(w,'E01').submission);

    const {page:console_,seen:consoleSeen}=await openPage({w,signedInAs:COMMISH,path:'commissioner.html'});
    await console_.locator('#importCard').waitFor({state:'visible'});
    const thisWeek=()=>console_.locator('#entriesBody tr').evaluateAll(trs=>trs.map(tr=>[tr.cells[0].querySelector('strong').textContent,tr.cells[1].textContent,tr.cells[2].textContent]));
    assert.deepEqual(await thisWeek(),[['E01','Yes','participant'],['E02','Yes','—'],['E03','No','—'],['E04','No','—']]);
    const reloaded=console_.waitForResponse(r=>r.url().endsWith('/rpc/pool_platform_commissioner_context'));
    await console_.fill('#importText','entry_code,g1,g2,g3,tiebreak\nE01,away,away,away,1\nE02,away,away,away,2\nE03,away,home,away,3\nE04,home,away,home,4');
    await console_.click('#runImport');
    await console_.locator('#importResult').waitFor({state:'visible'});
    await reloaded;await settle(console_);
    assert.equal(await console_.textContent('#importResult'),'2 submitted · 1 source conflict(s) · 1 other error(s). Participant submissions were not overwritten.');
    assert.deepEqual(await console_.locator('#resultBody tr').evaluateAll(trs=>trs.map(tr=>[...tr.cells].map(td=>td.textContent))),
      [['E01','source_conflict:participant'],['E02','created'],['E03','created'],['E04','entry_not_active']]);
    assert.deepEqual(entryOf(w,'E01').submission,participantSaved,'the participant\'s picks were not overwritten');
    assert.deepEqual(await thisWeek(),[['E01','Yes','participant'],['E02','Yes','commissioner_import'],['E03','No','commissioner_import'],['E04','No','—']]);
    // The same source may update its own rows while the week is open.
    await console_.fill('#importText','entry_code,g1,g2,g3,tiebreak\nE02,home,home,home,9');await console_.click('#runImport');
    await console_.locator('#importResult',{hasText:'1 submitted · 0 source conflict(s) · 0 other error(s).'}).waitFor();
    assert.deepEqual(await console_.locator('#resultBody tr').evaluateAll(trs=>trs.map(tr=>[...tr.cells].map(td=>td.textContent))),[['E02','updated']]);
    assert.equal(entryOf(w,'E02').submission.revision,2);
    await clean(console_,consoleSeen);

    // The participant comes back: E02 is now the commissioner's and read-only; E01 is still theirs to update.
    await player.reload();
    await player.locator('#pickForm').waitFor({state:'visible'});
    assert.equal(await player.textContent('#sourceNotice'),NOTICE.update);
    await player.selectOption('#entrySelect','entry-2');
    assert.equal(await player.textContent('#sourceNotice'),NOTICE.commissioner);
    assert.deepEqual(await checked(player),['game-0-home','game-1-home','game-2-home'],'the commissioner\'s saved picks are shown read-only');
    assert.equal(await player.isEnabled('#submitBtn'),false);
    assert.equal(calls(w,'pool_platform_submit_entry').length,1,'the participant sent exactly one submission');
    await clean(player,playerSeen);
  });

  // ---- 10: session transitions and stale responses.

  test('stale responses: while a submission is in flight the entry on screen cannot change, so its result is never shown on another entry; a validation message does not follow the participant to another entry',async()=>{
    for(const outcome of ['saved','refused']){
      const w=world({entries:[['E01',{owner:PLAYER}],['E02',{owner:PLAYER}]]});
      const {page,seen}=await openPage({w,signedInAs:PLAYER});
      await page.locator('#pickForm').waitFor({state:'visible'});
      if(outcome==='refused')w.week.status='locked';
      const held=gate(w,'pool_platform_submit_entry');
      await pick(page,['away','home','away']);await page.fill('#tiebreak','47');await page.click('#submitBtn');
      await held.arrived;
      // What a participant can do mid-flight: pick the other entry, if the selector lets them.
      const switched=await page.evaluate(()=>{
        const select=document.getElementById('entrySelect');if(select.disabled)return false;
        select.value='entry-2';select.dispatchEvent(new Event('change',{bubbles:true}));return true;
      });
      const done=page.waitForResponse(r=>r.url().endsWith('/rpc/pool_platform_submit_entry'));
      held.release();await done;
      if(outcome==='saved')await submitted(page,1);else await page.locator('#validation').waitFor({state:'visible'});
      await settle(page);
      const onScreen=await page.inputValue('#entrySelect');
      if(await page.isVisible('#submittedCard'))assert.equal(onScreen,'entry-1',`the confirmation for E01 is shown while ${onScreen} is on screen (switched mid-flight: ${switched})`);
      if(await page.isVisible('#validation'))assert.equal(onScreen,'entry-1',`E01's refusal is shown while ${onScreen} is on screen (switched mid-flight: ${switched})`);
      assert.equal(await page.isEnabled('#entrySelect'),true,`${outcome}: the selector is usable again`);
      assert.equal(entryOf(w,'E02').submission,null);
      await clean(page,seen);
    }
    // Signing out mid-flight: the next session's selector is usable at once, before the old answer arrives, and the
    // old answer changes nothing on screen.
    {
      const w=world({entries:[['E01',{owner:PLAYER}],['E02',{owner:PLAYER}]]});
      const {page,seen}=await openPage({w,signedInAs:PLAYER});
      await page.locator('#pickForm').waitFor({state:'visible'});
      const held=gate(w,'pool_platform_submit_entry');
      await pick(page,['away','home','away']);await page.fill('#tiebreak','47');await page.click('#submitBtn');
      await held.arrived;
      await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
      await signIn(page,PLAYER);
      await page.locator('#entrySelectWrap').waitFor({state:'visible'});
      assert.equal(await page.isEnabled('#entrySelect'),true,'the new session inherited a locked selector');
      await page.selectOption('#entrySelect','entry-2');
      const done=page.waitForResponse(r=>r.url().endsWith('/rpc/pool_platform_submit_entry'));
      held.release();await done;await settle(page);
      assert.equal(await page.inputValue('#entrySelect'),'entry-2');
      await visible(page,{submittedCard:false,validation:false});
      assert.equal(await page.isEnabled('#entrySelect'),true);
      await clean(page,seen);
    }
    // A validation message belongs to the entry it was raised on.
    const w=world({entries:[['E01',{owner:PLAYER}],['E02',{owner:PLAYER}]]});
    const {page,seen}=await openPage({w,signedInAs:PLAYER});
    await page.locator('#pickForm').waitFor({state:'visible'});
    await page.click('#submitBtn');
    await refusedWith(page,'Complete every game');
    await page.selectOption('#entrySelect','entry-2');
    await visible(page,{validation:false});
    await clean(page,seen);
  });

  test('pre-season: an invitation claimed before the commissioner opens a week says the pool has no open week, not a raw code, and the claim stands',async()=>{
    const TOKEN='ab'.repeat(32);
    for(const flag of ['noWeek','noSeason']){
      const w=world({invites:{[TOKEN]:{entryId:'entry-1',email:INVITED}}});w[flag]=true;
      const {page,seen}=await openPage({w,signedInAs:INVITED,query:`?pool=it-pool#invite=${TOKEN}`});
      await page.locator('#sessionError').waitFor({state:'visible'});
      const copy=await page.textContent('#sessionError');
      assert.doesNotMatch(copy,/_not_found/,`${flag}: raw code shown: ${copy}`);
      assert.match(copy,/no week open for picks yet/i,flag);
      assert.equal(entryOf(w,'E01').owner,INVITED,`${flag}: the invitation was claimed`);
      await visible(page,{signOut:true,authCard:false});
      await clean(page,seen);
    }
  });

  test('after saving, any change to the picks takes the confirmation down until they are saved again',async()=>{
    const w=world({entries:[['E01',{owner:PLAYER}]]});
    const {page,seen}=await openPage({w,signedInAs:PLAYER});
    await page.locator('#pickForm').waitFor({state:'visible'});
    await pick(page,['away','home','away']);await page.fill('#tiebreak','47');await page.click('#submitBtn');
    await submitted(page,1);await visible(page,{submittedCard:true});
    const edits=[
      ['another pick',()=>page.click('label[for="game-1-away"]')],
      ['the tiebreak',()=>page.fill('#tiebreak','48')],
      ['Clear',()=>page.click('#clearBtn')]
    ];
    for(const [i,[label,edit]] of edits.entries()){
      await edit();
      await visible(page,{submittedCard:false});
      assert.equal(await page.textContent('#submitBtn'),'Update picks',label);
      if(label==='Clear')await pick(page,['home','home','home']),await page.fill('#tiebreak','10');
      await page.click('#submitBtn');await submitted(page,i+2);
      assert.equal(await page.textContent('#submittedTitle'),'Picks updated',label);
    }
    assert.deepEqual(entryOf(w,'E01').submission.payload,{picks:{g1:'home',g2:'home',g3:'home'},tiebreak:10});
    await clean(page,seen);
    // Survivor, and the shipped sandbox, behave the same.
    const s=world({poolType:'survivor',entries:[['E01',{owner:PLAYER}]]});
    const {page:sp,seen:ss}=await openPage({w:s,signedInAs:PLAYER});
    await sp.locator('#pickForm').waitFor({state:'visible'});
    await sp.click('label[for="team-0"]');await sp.click('#submitBtn');await submitted(sp,1);
    await sp.click('label[for="team-4"]');
    await visible(sp,{submittedCard:false});
    await clean(sp,ss);
    const {page:demo,seen:ds}=await openPage();
    await demo.locator('#pickForm').waitFor({state:'visible'});
    await pick(demo,['away','home','away','home','away','home']);await demo.fill('#tiebreak','30');await demo.click('#submitBtn');
    await demo.locator('#submittedCard').waitFor({state:'visible'});
    await demo.click('#clearBtn');
    await visible(demo,{submittedCard:false});
    await clean(demo,ds);
  });

  test('the page reports what the latest submit did: a save whose follow-up reload fails is still shown as saved, and a later refusal takes an earlier confirmation down',async()=>{
    // The save succeeds; the reload of the entry that follows it loses its connection.
    const w=world({entries:[['E01',{owner:PLAYER}]]});
    const {page,seen}=await openPage({w,signedInAs:PLAYER});
    await page.locator('#pickForm').waitFor({state:'visible'});
    w.drop={pool_platform_participant_context:1};
    await pick(page,['away','home','away']);await page.fill('#tiebreak','47');
    const reload=page.waitForEvent('requestfailed',r=>r.url().endsWith('/rpc/pool_platform_participant_context'));
    await page.click('#submitBtn');
    await reload;await settle(page);
    assert.equal(entryOf(w,'E01').submission?.revision,1,'the server saved the picks');
    await visible(page,{submittedCard:true,validation:false});
    assert.match(await page.textContent('#submittedMeta'),/^Revision 1 /);
    // The rest of the page agrees with the confirmation, and shows the picks that were saved.
    assert.equal(await notice(page),NOTICE.update);
    assert.equal(await page.textContent('#submitBtn'),'Update picks');
    assert.deepEqual(await checked(page),['game-0-away','game-1-home','game-2-away']);
    // Saved picks unchanged, then the week is locked: the new attempt is refused, and only its result is shown.
    w.week.status='locked';
    await page.click('#submitBtn');
    await refusedWith(page,authErrorMessage('week_not_open'));
    await visible(page,{submittedCard:false});
    await clean(page,seen);
  });

  test('the confirmation is on screen and has focus after Submit at 360, 390, 768 and 1280 px, even when Submit was at the bottom edge',async()=>{
    for(const [width,height] of VIEWPORTS){
      for(const poolType of ['pickem','survivor']){
        const w=world({poolType,entries:[['E01',{owner:PLAYER}]]}),label=`${width}px ${poolType}`;
        const {page,seen}=await openPage({w,signedInAs:PLAYER,width,height,touch:width<700});
        await page.locator('#pickForm').waitFor({state:'visible'});
        if(poolType==='pickem'){await pick(page,['away','home','away']);await page.fill('#tiebreak','47')}
        else await page.click('label[for="team-2"]');
        // Where a thumb leaves it: just scrolled into view at the bottom of the screen.
        await page.locator('#submitBtn').evaluate(button=>button.scrollIntoView({block:'end'}));
        await page.click('#submitBtn');await submitted(page,1);await settle(page);
        const view=await page.evaluate(()=>{const r=document.getElementById('submittedCard').getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:innerHeight,focus:document.activeElement.id}});
        // Layout is in fractional pixels and scrolling in whole ones, so an edge may land up to 1px past the viewport.
        assert.ok(view.top>=-1&&view.bottom<=view.height+1,`${label}: the confirmation is not fully on screen ${JSON.stringify(view)}`);
        assert.equal(view.focus,'submittedCard',`${label}: focus`);
        // A refusal is brought into view the same way (the existing behaviour, kept).
        await page.locator('#submitBtn').evaluate(button=>button.scrollIntoView({block:'end'}));
        w.week.status='locked';
        await page.click(poolType==='pickem'?'label[for="game-0-home"]':'label[for="team-3"]');await page.click('#submitBtn');
        await refusedWith(page,authErrorMessage('week_not_open'));
        const error=await page.evaluate(()=>{const r=document.getElementById('validation').getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:innerHeight,focus:document.activeElement.id}});
        assert.ok(error.top>=-1&&error.bottom<=error.height+1&&error.focus==='validation',`${label}: refusal ${JSON.stringify(error)}`);
        await clean(page,seen);
      }
    }
  });

  test('keyboard only: every game is reachable with Tab, chosen with the arrow keys with a visible focus ring, and Enter in the tiebreak submits',async()=>{
    const {page,seen}=await openPage({width:1280,height:800});
    await page.locator('#pickForm').waitFor({state:'visible'});
    const focused=()=>page.evaluate(()=>document.activeElement.id||document.activeElement.tagName);
    for(let i=0;i<20&&(await focused())!=='game-0-away';i++)await page.keyboard.press('Tab');
    for(let game=0;game<6;game++){
      assert.equal(await focused(),`game-${game}-away`,`Tab reaches game ${game+1}`);
      const ring=await page.locator(`label[for="game-${game}-away"]`).evaluate(label=>getComputedStyle(label).outlineStyle);
      assert.notEqual(ring,'none',`game ${game+1}: no visible focus ring`);
      if(game%2)await page.keyboard.press('Space');else await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Tab');
    }
    assert.equal(await focused(),'tiebreak');
    assert.deepEqual(await checked(page),['game-0-home','game-1-away','game-2-home','game-3-away','game-4-home','game-5-away']);
    await page.keyboard.type('47');await page.keyboard.press('Enter');
    await page.locator('#submittedCard').waitFor({state:'visible'});
    assert.equal(await focused(),'submittedCard','the confirmation takes focus, so it is read out and on screen');
    await clean(page,seen);
  });

  test('viewport matrix: participant and commissioner states at 360, 390, 768 and 1280 px have no sideways scroll, 44px controls and 16px form text',async()=>{
    // Every visible control a participant or commissioner operates. The brand link and the tiebreak's text label
    // (whose input is the 48px target) are not counted.
    const audit=(page,label)=>page.evaluate(label=>{
      const problems=[],root=document.documentElement;
      if(root.scrollWidth>root.clientWidth)problems.push(`${label}: page scrolls sideways by ${root.scrollWidth-root.clientWidth}px`);
      for(const el of document.querySelectorAll('button,input,select,textarea,label[for^="game-"],label[for^="team-"]')){
        if(el.matches('input[type=radio]')||el.closest('.hidden'))continue;
        const r=el.getBoundingClientRect(),name=`${el.tagName.toLowerCase()}#${el.id||el.htmlFor}`;
        if(!r.width)continue;
        if(r.height<44)problems.push(`${label}: ${name} is ${Math.round(r.height)}px tall`);
        if(r.left<0||r.right>root.clientWidth)problems.push(`${label}: ${name} is off screen`);
        if(el.matches('input,select,textarea')&&parseFloat(getComputedStyle(el).fontSize)<16)problems.push(`${label}: ${name} text is ${getComputedStyle(el).fontSize} (under 16px, which iOS Safari zooms on focus)`);
      }
      return problems;
    },label);
    const problems=[];
    for(const [width,height] of VIEWPORTS){
      const touch=width<700;
      {
        const {page,seen}=await openPage({w:world(),width,height,touch});
        await page.locator('#authCard').waitFor({state:'visible'});
        problems.push(...await audit(page,`${width}px participant sign-in`));
        await page.fill('#email',PLAYER);await page.click('#sendCode');await page.locator('#otpWrap').waitFor({state:'visible'});
        problems.push(...await audit(page,`${width}px participant code`));
        await clean(page,seen);
      }
      for(const poolType of ['pickem','survivor']){
        const w=world({poolType,entries:[['E01',{owner:PLAYER}],['E02',{owner:PLAYER}]]});
        const {page,seen}=await openPage({w,signedInAs:PLAYER,width,height,touch});
        await page.locator('#pickForm').waitFor({state:'visible'});
        if(poolType==='pickem'){await pick(page,['away','home','away']);await page.fill('#tiebreak','47')}else await page.click('label[for="team-0"]');
        await page.click('#submitBtn');await submitted(page,1);
        problems.push(...await audit(page,`${width}px participant ${poolType} saved`));
        await clean(page,seen);
      }
      {
        const w=world({entries:[['E01',{owner:PLAYER,submission:{source:'participant',status:'submitted',payload:{picks:{g1:'away',g2:'away',g3:'away'},tiebreak:1},revision:1}}],['E02'],['E03']]});
        const {page,seen}=await openPage({w,signedInAs:COMMISH,width,height,touch,path:'commissioner.html'});
        await page.locator('#importCard').waitFor({state:'visible'});
        await page.fill('#inviteEmail',INVITED);await page.click('#createInvite');await page.locator('#inviteResult').waitFor({state:'visible'});
        await page.fill('#importText','entry_code,g1,g2,g3,tiebreak\nE01,away,home,away,47\nE02,away,home,away,40\nE03,home,home,home,7');await page.click('#runImport');
        await page.locator('#importResult').waitFor({state:'visible'});await settle(page);
        problems.push(...await audit(page,`${width}px commissioner results`));
        // The results table may be wider than a phone; it scrolls inside its own box, never the page.
        const box=await page.locator('#resultTableWrap').evaluate(el=>({overflowX:getComputedStyle(el).overflowX,right:el.getBoundingClientRect().right,client:document.documentElement.clientWidth}));
        assert.equal(box.overflowX,'auto');assert.ok(box.right<=box.client,`${width}px results box ${JSON.stringify(box)}`);
        await page.fill('#importText','entry_code,g1,g2,g3,tiebreak\nE99,away,home,away,47\nE01,sideways,home,away,999');await page.click('#runImport');
        await page.locator('#importError').waitFor({state:'visible'});
        problems.push(...await audit(page,`${width}px commissioner row errors`));
        await clean(page,seen);
      }
    }
    assert.deepEqual(problems,[]);
  });

  test('sign-in buttons: a second tap on Send code or Verify while the first is in flight sends nothing more, and a failure leaves them usable',async()=>{
    for(const pagePath of ['participant.html','commissioner.html']){
      const w=world({entries:[['E01',{owner:PLAYER}]]});
      const {page,seen}=await openPage({w,path:pagePath});
      await page.locator('#authCard').waitFor({state:'visible'});
      const fake=()=>page.evaluate(()=>({sends:window.__fakeAuth.sends.length,verifies:window.__fakeAuth.verifies.length}));
      // A double tap, as two activations of the button before the first request has answered.
      const doubleTap=id=>page.evaluate(id=>{const button=document.getElementById(id);button.click();button.click()},id);
      await page.evaluate(()=>{window.__fakeAuth.sendGate=new Promise(resolve=>{window.__releaseSend=resolve})});
      await page.fill('#email',PLAYER);await doubleTap('sendCode');await settle(page);
      assert.deepEqual(await fake(),{sends:1,verifies:0},`${pagePath}: one tap, one code`);
      await page.evaluate(()=>window.__releaseSend());
      await page.locator('#otpWrap').waitFor({state:'visible'});
      assert.equal(await page.isEnabled('#sendCode'),true,`${pagePath}: Send code is usable again to request a new code`);
      // A refused send leaves the button usable too.
      await page.evaluate(()=>{window.__fakeAuth.sendFailure='Too many attempts. Wait a few minutes, then try again.'});
      await page.click('#sendCode');await page.locator('#authError',{hasText:'Too many attempts'}).waitFor();
      assert.equal(await page.isEnabled('#sendCode'),true);
      await page.evaluate(()=>{window.__fakeAuth.sendFailure=null});
      // A wrong code, then a double-tapped right one.
      await page.fill('#otp','000000');await page.click('#verifyCode');await page.locator('#authError',{hasText:'Invalid OTP'}).waitFor();
      assert.equal(await page.isEnabled('#verifyCode'),true);
      await page.evaluate(()=>{window.__fakeAuth.verifyGate=new Promise(resolve=>{window.__releaseVerify=resolve})});
      const before=(await fake()).verifies;
      await page.fill('#otp','123456');await doubleTap('verifyCode');
      if(pagePath==='participant.html')await page.press('#otp','Enter');
      await settle(page);
      assert.equal((await fake()).verifies,before+1,`${pagePath}: one sign-in attempt`);
      await page.evaluate(()=>window.__releaseVerify());
      await page.locator('#signOut').waitFor({state:'visible'});
      await clean(page,seen);
    }
  });

  test('a session that ends while the page is open: the next submit says sign-in is needed, nothing is shown as saved, and signing in again recovers',async()=>{
    const w=world({entries:[['E01',{owner:PLAYER}]]});
    const {page,seen}=await openPage({w,signedInAs:PLAYER});
    await page.locator('#pickForm').waitFor({state:'visible'});
    await page.evaluate(()=>{window.__fakeAuth.email=null});
    await pick(page,['away','home','away']);await page.fill('#tiebreak','47');await page.click('#submitBtn');
    await refusedWith(page,'Authentication required.');
    await visible(page,{submittedCard:false,signOut:true});
    assert.equal(calls(w,'pool_platform_submit_entry').length,0,'nothing was sent without a session');
    await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
    await visible(page,{pickForm:false,entryCard:false,validation:false});
    await signIn(page,PLAYER);
    await page.locator('#pickForm').waitFor({state:'visible'});
    assert.deepEqual(await checked(page),[],'nothing typed before the session ended is carried over');
    await pick(page,['away','home','away']);await page.fill('#tiebreak','47');await page.click('#submitBtn');
    await submitted(page,1);
    await clean(page,seen);
  });
});
