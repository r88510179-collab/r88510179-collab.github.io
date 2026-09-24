import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import test,{after,before,describe} from 'node:test';
import vm from 'node:vm';

const read=name=>fs.readFileSync(new URL('./'+name,import.meta.url),'utf8');
const participant=read('participant.html')+read('participant.js');
const commissioner=read('commissioner.html')+read('commissioner.js');
const css=read('styles.css');
const sw=read('service-worker.js');
const tree=participant+commissioner+read('index.html')+read('platform-config.js');

test('commercial tree stays generic and synthetic',()=>{
  for(const privateName of ['Thaddeus','DJS','D.C.','JC'])assert.equal(tree.includes(privateName),false);
  assert.equal(/NFL shield|National Football League/i.test(tree),false);
});

test('participant UI supports Pickem and Survivor with no-referrer invite pages',()=>{
  assert.match(participant,/pool_type==='survivor'/);
  assert.match(participant,/validatePickPayload/);
  assert.match(participant,/validateSurvivorSelection/);
  assert.match(participant,/name="referrer" content="no-referrer"/);
});

test('participant summary is built from text nodes; the typed tiebreak never reaches an HTML sink',()=>{
  const js=read('participant.js');
  const row=/\nfunction summaryRow\(label,value\)\{\n([\s\S]*?)\n\}\n/.exec(js)?.[1];
  const summary=/\nfunction updateSummary\(\)\{\n([\s\S]*?)\n\}\n/.exec(js)?.[1];
  assert.ok(row&&summary,'summaryRow and updateSummary must exist');
  assert.match(row,/name\.textContent=label;pick\.textContent=value;/);
  assert.doesNotMatch(row+summary,/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(summary,/summaryRow\('Tiebreak',\$\('tiebreak'\)\.value\|\|'—'\)/);
  assert.equal(summary.match(/\$\('summary'\)\.replaceChildren\(/g).length,2,'both the Pickem and Survivor summaries');
  for(const line of js.split('\n').filter(l=>/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(l))){
    assert.doesNotMatch(line,/tiebreak/i,`HTML sink near the tiebreak: ${line.slice(0,80)}`);
  }
});

test('participant Sign out and signed-in errors live in the shell, outside every card that context, invites or errors hide',()=>{
  const html=read('participant.html'),js=read('participant.js');
  const shell=html.slice(html.indexOf('<main class="shell">'),html.indexOf('<section'));
  assert.match(shell,/<div class="topbar">[\s\S]*<button class="button compact secondary hidden" id="signOut" type="button" style="min-height:44px">Sign out<\/button>/);
  assert.match(shell,/<div class="notice error hidden" id="sessionError" role="alert"/);
  assert.equal(html.match(/id="signOut"/g).length,1);
  // Only the session decides whether Sign out shows: not the entry context, an invite claim or an error.
  assert.equal(js.match(/show\('signOut'/g).length,1);
  assert.match(js,/function setAuthVisible\(\)\{show\('authCard',client\.live&&!state\.session\);show\('signOut',client\.live&&!!state\.session\)\}/);
  // A failed claim is reported, but the account's own context still loads (a reopened, already claimed link).
  assert.match(js,/async function openSession\(\)\{\n  const session=state\.session,report=e=>\{if\(state\.session===session\)message\('sessionError',e\.message\)\};\n  setAuthVisible\(\);message\('sessionError',''\);\n  let claimFailed=false;\n  try\{await claimInviteIfPresent\(\)\}catch\(e\)\{claimFailed=true;report\(e\)\}\n  try\{await loadLiveContext\(\)\}catch\(e\)\{if\(!claimFailed\)report\(e\)\}\n\}/);
  assert.match(js,/state\.session=await client\.getSession\(\);setAuthVisible\(\);\n  if\(state\.session\)await openSession\(\);/);
  assert.match(js,/state\.session=await client\.verifyOtp\(state\.pendingEmail\|\|\$\('email'\)\.value,\$\('otp'\)\.value\)\}catch\(e\)\{message\('authError',e\.message\);return\}await openSession\(\)/);
  // A failed claim throws before the token is dropped, so the invited account can still claim it.
  assert.match(js,/await client\.claimInvite\(inviteToken\);inviteToken='';cleanInviteFromUrl\(\)/);
  const signOut=/\$\('signOut'\)\.addEventListener\('click',async\(\)=>\{\n([\s\S]*?)\n\}\);/.exec(js)?.[1];
  assert.ok(signOut);
  assert.match(signOut,/Object\.assign\(state,\{session:null,context:null,entry:null,pendingEmail:''\}\)/);
  for(const id of ['entryCard','pickForm','submittedCard','emptyCard','otpWrap'])assert.match(signOut,new RegExp(`'${id}'`));
  assert.match(signOut,/for\(const id of \['sessionError','authError','validation'\]\)message\(id,''\);\n  setAuthVisible\(\);$/,'errors are cleared only after the session is gone');
  assert.ok(signOut.indexOf("message(id,'')")>signOut.indexOf('await client.signOut()'));
  assert.doesNotMatch(signOut,/inviteToken|cleanInviteFromUrl/,'signing out must not drop an unclaimed invite');
  assert.match(js,/if\(state\.session!==session\)return; \/\/ signed out while loading/,'a context that arrives after sign out is not rendered');
  const submit=/\$\('pickForm'\)\.addEventListener\('submit',async event=>\{\n([\s\S]*?)\n\}\);/.exec(js)?.[1];
  assert.ok(submit);
  assert.match(submit,/const session=state\.session;/);
  assert.match(submit,/if\(state\.session!==session\)return;\n    \$\('submittedTitle'\)/,'no saved card after sign out');
  assert.match(submit,/catch\(e\)\{if\(state\.session===session\)\{message\('validation',e\.message\)/,'no stale error after sign out');
  assert.match(submit,/finally\{if\(state\.context&&state\.entry\)\$\('submitBtn'\)/);
  assert.match(js,/catch\(e\)\{if\(!String\(e\?\.message\)\.includes\('pool_not_found'\)\)throw e\}/,'no readable pool means the empty state');
});

test('commissioner UI exposes invite and conflict-report workflows',()=>{
  assert.match(commissioner,/createInvite/);
  assert.match(commissioner,/submitBatch/);
  assert.match(commissioner,/source conflict/i);
  assert.match(commissioner,/<td>\$\{esc\(e\.row\?`Row \$\{e\.row\}\$\{e\.entry_code\?` · \$\{e\.entry_code\}`:''\}`:'CSV'\)\}<\/td><td>\$\{esc\(describeImportError\(e\)\)\}<\/td>/,'rejected rows are listed with their context, both cells escaped');
});

test('responsive baseline keeps mobile controls touch-friendly',()=>{
  assert.match(css,/min-width:320px/);
  assert.match(css,/font-size:16px/);
  assert.match(css,/min-height:48px/);
  assert.match(css,/@media\(max-width:560px\)/);
});

test('service worker precaches all Step 2 modules',()=>{
  for(const asset of ['participant.js','commissioner.js','platform-client.js','participant-core.js','import-core.js','auth-core.js']){
    assert.match(sw,new RegExp(asset.replace('.','\\.')));
  }
});

test('service worker cleanup is limited to the commercial cache namespace',()=>{
  assert.match(sw,/const CACHE_PREFIX='pool-platform-commercial-';/);
  assert.match(sw,/keys\.filter\(key=>key\.startsWith\(CACHE_PREFIX\)&&key!==CACHE\)/);
  assert.doesNotMatch(sw,/keys\.filter\(key=>key!==CACHE\)/,'deleting every other cache on the origin would wipe unrelated apps');
  assert.doesNotMatch(sw,/caches\.match\(/,'lookups must stay inside the commercial cache');
});

// Runs the real service-worker.js against in-memory Cache Storage, as on an origin shared with other apps.
const ORIGIN='https://pools.example.test';
const SW_URL=`${ORIGIN}/pool-platform/service-worker.js`;
// Read-only: the personal Pool Center worker's current cache name, which must survive commercial activation.
const PERSONAL_CACHE=(()=>{
  try{return /const CACHE='([^']+)'/.exec(fs.readFileSync(new URL('../nfl-pool/service-worker.js',import.meta.url),'utf8'))?.[1]}catch{return undefined}
})()||'pool-center-shell-v7';
const fakeResponse=({ok=true,status=200,type='basic',redirected=false,body='network'}={})=>({ok,status,type,redirected,body,clone(){return fakeResponse({ok,status,type,redirected,body})}});
const request=(url,{method='GET',mode='cors',headers={}}={})=>({url,method,mode,headers:new Headers(headers)});

function bootWorker({cacheNames=[],network=async()=>fakeResponse()}={}){
  const listeners={},stores=new Map(cacheNames.map(name=>[name,new Map()]));
  const log={opened:[],deleted:[],puts:[],fetched:[]};
  const keyOf=r=>typeof r==='string'?r:r.url;
  const caches={
    keys:async()=>[...stores.keys()],
    delete:async name=>{log.deleted.push(name);return stores.delete(name)},
    open:async name=>{
      log.opened.push(name);
      if(!stores.has(name))stores.set(name,new Map());
      const store=stores.get(name);
      return{
        addAll:async urls=>{for(const u of urls)store.set(new URL(u,SW_URL).href,fakeResponse({body:`precached ${new URL(u,SW_URL).pathname}`}))},
        put:async(r,response)=>{log.puts.push(keyOf(r));store.set(keyOf(r),response)},
        match:async r=>store.get(keyOf(r))
      };
    },
    match:async()=>{throw new Error('origin-wide caches.match must not be used')}
  };
  const self={location:new URL(SW_URL),addEventListener:(type,fn)=>{listeners[type]=fn},skipWaiting:async()=>{},clients:{claim:async()=>{}}};
  vm.runInContext(sw,vm.createContext({self,caches,URL,Response,Headers,fetch:async r=>{log.fetched.push(keyOf(r));return network(r)}}));
  const dispatch=async(type,init={})=>{
    const pending=[];let responded=null;
    listeners[type]({...init,waitUntil:p=>{pending.push(p)},respondWith:p=>{responded=Promise.resolve(p)}});
    const response=responded?await responded:undefined;
    await Promise.all(pending);
    return{responded:!!responded,response};
  };
  return{stores,log,dispatch};
}

async function installedWorker(options){
  const worker=bootWorker(options);
  await worker.dispatch('install');
  worker.cacheName=worker.log.opened[0];
  return worker;
}

test('activation removes only older commercial caches; Pool Center and unrelated caches survive',async()=>{
  const current=(await installedWorker()).cacheName;
  assert.match(current,/^pool-platform-commercial-/);
  assert.equal(PERSONAL_CACHE.startsWith('pool-platform-commercial-'),false);
  const survivors=[PERSONAL_CACHE,'pool-center-shell-v6','another-app-v1','workbox-precache-v2-https://pools.example.test/',current];
  const worker=bootWorker({cacheNames:[...survivors,'pool-platform-commercial-v1','pool-platform-commercial-v2']});
  await worker.dispatch('activate');
  assert.deepEqual(worker.log.deleted.sort(),['pool-platform-commercial-v1','pool-platform-commercial-v2']);
  assert.deepEqual([...worker.stores.keys()].sort(),[...survivors].sort());
});

test('install precaches every listed static module, at bare same-origin paths, in the commercial cache only',async()=>{
  const worker=await installedWorker();
  const keys=[...worker.stores.get(worker.cacheName).keys()];
  for(const asset of ['','index.html','participant.html','commissioner.html','styles.css','participant.js','commissioner.js','submission-core.js','participant-core.js','import-core.js','auth-core.js','platform-config.js','platform-client.js','manifest.webmanifest']){
    assert.ok(keys.includes(`${ORIGIN}/pool-platform/${asset}`),asset||'./');
  }
  assert.ok(keys.every(key=>key.startsWith(`${ORIGIN}/pool-platform/`)&&!key.includes('?')));
  assert.deepEqual([...worker.stores.keys()],[worker.cacheName]);
});

test('invite and other query-string navigations are never cache keys; offline they get the bare cached page',async()=>{
  const invite=`${ORIGIN}/pool-platform/participant.html?pool=demo&invite=${'a'.repeat(64)}`;
  const online=await installedWorker();
  for(const url of [invite,`${ORIGIN}/pool-platform/participant.html?pool=demo`,`${ORIGIN}/pool-platform/commissioner.html?pool=demo`]){
    const result=await online.dispatch('fetch',{request:request(url,{mode:'navigate'})});
    assert.equal(result.responded,true);
    assert.equal(result.response.body,'network');
  }
  assert.deepEqual(online.log.puts,[]);
  await online.dispatch('fetch',{request:request(`${ORIGIN}/pool-platform/participant.html`,{mode:'navigate'})});
  assert.deepEqual(online.log.puts,[`${ORIGIN}/pool-platform/participant.html`],'a bare allow-listed page may be refreshed');

  const offline=await installedWorker({network:async()=>{throw new TypeError('offline')}});
  const fallback=await offline.dispatch('fetch',{request:request(invite,{mode:'navigate'})});
  assert.equal(fallback.response.body,'precached /pool-platform/participant.html');
  const unknown=await offline.dispatch('fetch',{request:request(`${ORIGIN}/pool-platform/missing?invite=${'b'.repeat(64)}`,{mode:'navigate'})});
  assert.equal(unknown.response.body,'precached /pool-platform/index.html');
  assert.deepEqual(offline.log.puts,[]);
  for(const worker of [online,offline]){
    for(const store of worker.stores.values())for(const key of store.keys())assert.ok(!key.includes('?')&&!key.includes('invite'),key);
  }
});

test('cross-origin, auth, Data API, non-GET, Authorization-bearing and query requests are left to the network',async()=>{
  const worker=await installedWorker();
  const untouched=[
    request('https://ep-demo.neonauth.c-2.us-east-2.aws.neon.tech/neondb/auth/get-session',{mode:'cors'}),
    request('https://ep-demo.apirest.c-2.us-east-2.aws.neon.tech/neondb/rest/v1/rpc/pool_platform_submit_entry',{method:'POST'}),
    request('https://ep-demo.apirest.c-2.us-east-2.aws.neon.tech/neondb/rest/v1/pool_platform_entries'),
    request('https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm'),
    request(`${ORIGIN}/neondb/auth/get-session`),
    request(`${ORIGIN}/pool-platform/rpc/pool_platform_participant_context`),
    request(`${ORIGIN}/pool-platform/auth-core.js`,{method:'POST'}),
    request(`${ORIGIN}/pool-platform/auth-core.js`,{headers:{Authorization:'Bearer a.b.c'}}),
    request(`${ORIGIN}/pool-platform/auth-core.js?v=2`),
    request(`${ORIGIN}/nfl-pool/app.js`)
  ];
  for(const r of untouched){
    const result=await worker.dispatch('fetch',{request:r});
    assert.equal(result.responded,false,`${r.method} ${r.url}`);
  }
  assert.deepEqual(worker.log.fetched,[]);
  assert.deepEqual(worker.log.puts,[]);
});

test('listed static modules are served network-first and refreshed only from clean same-origin responses',async()=>{
  const worker=await installedWorker();
  const result=await worker.dispatch('fetch',{request:request(`${ORIGIN}/pool-platform/auth-core.js`)});
  assert.equal(result.responded,true);
  assert.deepEqual(worker.log.puts,[`${ORIGIN}/pool-platform/auth-core.js`]);
  for(const response of [fakeResponse({redirected:true}),fakeResponse({ok:false,status:404}),fakeResponse({type:'opaque'})]){
    const skipped=await installedWorker({network:async()=>response});
    await skipped.dispatch('fetch',{request:request(`${ORIGIN}/pool-platform/auth-core.js`)});
    assert.deepEqual(skipped.log.puts,[]);
  }
  const offline=await installedWorker({network:async()=>{throw new TypeError('offline')}});
  const cached=await offline.dispatch('fetch',{request:request(`${ORIGIN}/pool-platform/import-core.js`)});
  assert.equal(cached.response.body,'precached /pool-platform/import-core.js');
});

// Opt-in: the real participant page in headless Chromium through Playwright.
//   POOL_PLATFORM_TEST_BROWSER=1 NODE_PATH="$(npm root -g)" node --test pool-platform/ui-contract.test.mjs
// Sandbox runs as shipped. Live mode is stubbed only at the network edge: platform-config.js is served as a
// live config, the pinned Neon SDK URL as an in-page fake auth client, and the Data API RPCs by an in-memory
// stand-in, so the page's own auth shell, invite, rendering and submit code runs unmodified.
const BROWSER=process.env.POOL_PLATFORM_TEST_BROWSER||'';
const SDK_URL=/import\('(https:[^']+)'\)/.exec(read('platform-client.js'))[1];
const FAKE_SDK=`const b64=s=>btoa(s).replace(/[+]/g,'-').replace(/[/]/g,'_').replace(/=+$/,'');
const auth=()=>window.__fakeAuth;
const jwt=email=>[b64('{"alg":"none","typ":"JWT"}'),b64(JSON.stringify({email})),b64('shape-only-signature')].join('.');
export function createClient(){return{auth:{
  getSession:async()=>auth().email?{data:{session:{token:jwt(auth().email)},user:{id:auth().email,email:auth().email}},error:null}:{data:{session:null,user:null},error:null},
  emailOtp:{sendVerificationOtp:async({email})=>{auth().sent=email;return{data:{success:true},error:null}}},
  signIn:{emailOtp:async({email,otp})=>email===auth().sent&&otp==='123456'?(auth().email=email,{data:{},error:null}):{data:null,error:new Error('Invalid sign-in code.')}},
  signOut:async()=>{await window.__signOutGate;auth().email=null;return{data:{success:true},error:null}}
}}}`;
const INVITE='ab'.repeat(32);
const HOSTILE_LABEL='<img src=x onerror="window.__xss=(window.__xss||0)+1">';
// Every value the tiebreak box must show verbatim (blank shows the dash) without creating markup or running.
const TIEBREAK_INPUTS=['<img src=x onerror=alert(1)>','<script>alert(1)</script>','<img src=x onerror="window.__xss=(window.__xss||0)+1">','<svg onload=alert(1)>','"double" and \'single\' quotes','Tom & Jerry &amp; &lt;b&gt;','<b>bold</b> > <i>angle</i> <','47','0',''];
const textAsHtml=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function serveDirectory(root){
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json'};
  const server=http.createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/,'')||'index.html';
    if(name.includes('/')||name.includes('..')){res.writeHead(404).end();return}
    fs.readFile(new URL(name,root),(error,body)=>{
      if(error){res.writeHead(404).end();return}
      res.writeHead(200,{'content-type':types[path.extname(name)]||'application/octet-stream'}).end(body);
    });
  });
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server)));
}

function liveWorld({owners={},invites={},readable=[],games}={}){
  const deadline=new Date(Date.now()+86400000).toISOString();
  return{
    owners,invites,readable,calls:[],gates:[],
    entries:['E01','E02'].map((code,i)=>({id:`entry-${i+1}`,entry_code:code,display_name:`Entry ${code}`,status:'active',submission:null,history:[]})),
    context:{
      pool:{id:'pool-1',slug:'it-pool',display_name:'IT Pick’em',pool_type:'pickem',rules:{},branding:{}},
      season:{id:'season-1',season:2027,config:{}},
      week:{id:'week-1',week:1,status:'open',opens_at:null,deadline_at:deadline,config:{tiebreakRequired:true,games:games||[
        {id:'g1',away:{key:'austin',label:'Austin'},home:{key:'denver',label:'Denver'}},
        {id:'g2',away:{key:'phoenix',label:'Phoenix'},home:{key:'seattle',label:'Seattle'}}
      ]}}
    }
  };
}

// Holds the (skip+1)th call of one RPC until release(), so a test can act while that request is in flight.
// arrived rejects if the page never makes that call, instead of hanging the run.
function gate(world,name,skip=0){
  let release,timer;
  const held={name,skip,released:new Promise(resolve=>{release=resolve})};
  const arrived=new Promise((resolve,reject)=>{
    held.seen=()=>{clearTimeout(timer);resolve()};
    timer=setTimeout(()=>reject(new Error(`the page never called ${name}`)),15000);timer.unref();
  });
  arrived.catch(()=>{});world.gates.push(held);
  return{arrived,release};
}

// In-memory Data API: identity comes from the bearer JWT the page sends, errors use PostgREST's body shape.
function dataApi(world){
  return async route=>{
    const request=route.request(),name=new URL(request.url()).pathname.split('/').pop();
    const claims=(request.headers().authorization||'').replace(/^Bearer /,'').split('.')[1];
    const email=claims?JSON.parse(Buffer.from(claims,'base64url').toString()).email:null;
    const args=request.postDataJSON()||{};
    world.calls.push({name,email,args});
    const held=world.gates.find(g=>g.name===name&&!g.done);
    if(held){if(held.skip>0)held.skip--;else{held.done=true;held.seen();await held.released}}
    const reply=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    const fail=message=>reply(400,{code:'P0001',details:null,hint:null,message});
    if(!email)return fail('auth_required');
    if(name==='pool_platform_claim_entry_invite'){
      const invite=world.invites[args.p_invite_token];
      if(!invite||invite.claimedBy)return fail('invite_unavailable');
      if(invite.email&&invite.email!==email)return fail('invite_email_mismatch');
      invite.claimedBy=email;world.owners[invite.entryId]=email;
      return reply(200,{entry_id:invite.entryId,claimed:true});
    }
    if(name==='pool_platform_participant_context'){
      const entries=world.entries.filter(e=>world.owners[e.id]===email);
      if(!entries.length&&!world.readable.includes(email))return fail('pool_not_found');
      return reply(200,{...world.context,entries});
    }
    if(name==='pool_platform_submit_entry'){
      const entry=world.entries.find(e=>e.id===args.p_entry_id);
      if(!entry||world.owners[entry.id]!==email)return fail('entry_not_owned');
      const revision=(entry.submission?.revision||0)+1;
      entry.submission={source:'participant',status:'submitted',payload:args.p_payload,revision};
      return reply(200,{ok:true,code:revision>1?'updated':'created',submission_id:`sub-${entry.id}`,source:'participant',status:'submitted',revision});
    }
    return fail(`unexpected_rpc:${name}`);
  };
}

describe('participant page in headless Chromium (opt-in)',{skip:BROWSER?false:'set POOL_PLATFORM_TEST_BROWSER=1 (with playwright on NODE_PATH) to drive the real page'},()=>{
  let server,browser,base;
  const contexts=[];
  before(async()=>{
    let playwright;
    try{playwright=createRequire(import.meta.url)('playwright')}
    catch(error){assert.fail(`POOL_PLATFORM_TEST_BROWSER is set but playwright cannot be loaded (${error.message.split('\n')[0]}); put it on NODE_PATH`)}
    server=await serveDirectory(new URL('./',import.meta.url));
    base=`http://127.0.0.1:${server.address().port}`;
    browser=await playwright.chromium.launch();
  });
  after(async()=>{
    await Promise.all(contexts.splice(0).map(c=>c.close()));
    await browser?.close();
    await new Promise(resolve=>server?server.close(resolve):resolve());
  });

  async function openPage({world=null,signedInAs=null,query='',width=390,height=844}={}){
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height}});
    contexts.push(context);
    const page=await context.newPage(),seen={dialogs:[],errors:[]};
    page.on('dialog',dialog=>{seen.dialogs.push(dialog.message());dialog.dismiss().catch(()=>{})});
    page.on('pageerror',error=>seen.errors.push(error.message));
    if(world){
      await page.addInitScript(email=>{window.__fakeAuth={email}},signedInAs);
      await page.route(`${base}/platform-config.js`,route=>route.fulfill({contentType:'text/javascript',
        body:`export const PLATFORM_CONFIG=Object.freeze({mode:'live',authUrl:'https://auth.pool.test/auth',dataUrl:'${base}/data-api',defaultPoolSlug:'it-pool'});`}));
      await page.route(SDK_URL,route=>route.fulfill({contentType:'text/javascript',headers:{'access-control-allow-origin':'*'},body:FAKE_SDK}));
      await page.route(`${base}/data-api/rpc/*`,dataApi(world));
    }
    await page.goto(`${base}/participant.html${query}`);
    return{page,seen};
  }
  const visible=async(page,expected)=>{
    for(const [id,on] of Object.entries(expected))assert.equal(await page.isVisible(`#${id}`),on,`#${id} should be ${on?'visible':'hidden'}`);
  };
  const clean=async(page,seen)=>{
    assert.deepEqual(seen.dialogs,[],'no dialog may open');
    assert.deepEqual(seen.errors,[],'no page error');
    assert.equal(await page.evaluate(()=>window.__xss),undefined,'no injected handler ran');
    assert.equal(await page.locator('img,svg,script:not([src])').count(),0,'no injected element exists');
  };
  const pickAll=async(page,sides)=>{for(const [i,side] of sides.entries())await page.click(`label[for="game-${i}-${side}"]`)};
  // Lets the page finish whatever a just-delivered response set in motion.
  const settle=page=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,150)));
  const signIn=async(page,email)=>{
    await page.fill('#email',email);await page.click('#sendCode');
    await page.fill('#otp','123456');await page.click('#verifyCode');
  };
  const summaryTiebreak=page=>page.locator('#summary .summary-row').last().locator('strong');

  test('sandbox: hostile tiebreak text is displayed literally and never interpreted; 47 and 0 are kept, blank is not 0',async()=>{
    const {page,seen}=await openPage();
    await page.locator('#pickForm').waitFor({state:'visible'});
    for(const value of TIEBREAK_INPUTS){
      await page.fill('#tiebreak',value);
      assert.equal(await summaryTiebreak(page).textContent(),value||'—',JSON.stringify(value));
      assert.equal(await summaryTiebreak(page).innerHTML(),textAsHtml(value||'—'),`${JSON.stringify(value)} is a text node`);
      assert.deepEqual(await page.locator('#summary *').evaluateAll(nodes=>[...new Set(nodes.map(n=>n.tagName))].sort()),['DIV','SPAN','STRONG']);
    }
    await page.fill('#tiebreak',TIEBREAK_INPUTS[0]);
    await page.click('#submitBtn');
    assert.match(await page.textContent('#validation'),/valid tiebreak/);
    await pickAll(page,['away','home','away','home','away','home']);
    for(const [typed,kept] of [['47','47'],['0','0']]){
      await page.fill('#tiebreak',typed);await page.click('#submitBtn');
      await page.locator('#submittedCard').waitFor({state:'visible'});
      assert.equal(await page.inputValue('#tiebreak'),kept,`saved tiebreak ${typed}`);
      assert.equal(await summaryTiebreak(page).textContent(),kept);
    }
    await page.fill('#tiebreak','');await page.click('#submitBtn');
    assert.match(await page.textContent('#validation'),/valid tiebreak/,'a blank required tiebreak is refused, not saved as 0');
    await visible(page,{signOut:false,authCard:false,sessionError:false});
    await clean(page,seen);
  });

  test('live: wrong account opens an email-bound invite → mismatch beside Sign out → sign out → invited account claims it',async()=>{
    const world=liveWorld({invites:{[INVITE]:{email:'invited@example.test',entryId:'entry-1'}}});
    const {page,seen}=await openPage({world,signedInAs:'wrong@example.test',query:`?pool=it-pool&invite=${INVITE}`});
    await page.locator('#sessionError').waitFor({state:'visible'});
    assert.match(await page.textContent('#sessionError'),/different email address/);
    await page.locator('#emptyCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,authCard:false,entryCard:false,pickForm:false,sessionError:true});
    assert.equal(world.invites[INVITE].claimedBy,undefined,'a rejected claim does not consume the invite');
    assert.ok(page.url().includes(`invite=${INVITE}`),'the invite stays in the URL');

    await page.click('#signOut');
    await page.locator('#authCard').waitFor({state:'visible'});
    await visible(page,{signOut:false,sessionError:false,entryCard:false,emptyCard:false,otpWrap:false});
    assert.equal(await page.evaluate(()=>window.__fakeAuth.email),null,'the session ended');
    assert.equal(await page.inputValue('#email'),'');

    await signIn(page,'invited@example.test');
    await page.locator('#entryCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,authCard:false,sessionError:false,pickForm:true,emptyCard:false});
    assert.equal(world.invites[INVITE].claimedBy,'invited@example.test');
    assert.ok(!page.url().includes('invite='),'a claimed invite leaves the URL');
    assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_claim_entry_invite').map(c=>[c.email,c.args.p_invite_token]),
      [['wrong@example.test',INVITE],['invited@example.test',INVITE]]);
    await clean(page,seen);
  });

  test('live: reopening an invite link this account already claimed reports it but still loads the entry, before and after signing in again',async()=>{
    const world=liveWorld({owners:{'entry-1':'player@example.test'},invites:{[INVITE]:{email:'player@example.test',entryId:'entry-1',claimedBy:'player@example.test'}}});
    const {page,seen}=await openPage({world,signedInAs:'player@example.test',query:`?pool=it-pool&invite=${INVITE}`});
    for(const round of ['opened','signed in again']){
      await page.locator('#entryCard').waitFor({state:'visible'});
      assert.match(await page.textContent('#sessionError'),/expired, already used/,round);
      await visible(page,{signOut:true,sessionError:true,pickForm:true,authCard:false,emptyCard:false});
      if(round==='opened'){
        await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
        await signIn(page,'player@example.test');
      }
    }
    assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_claim_entry_invite').map(c=>c.email),['player@example.test','player@example.test']);
    await clean(page,seen);
  });

  test('live: signing out while a claim, context load, submit or post-submit reload is in flight leaves nothing of that account on screen',async()=>{
    const signedOut={authCard:true,signOut:false,sessionError:false,entryCard:false,pickForm:false,emptyCard:false,submittedCard:false};
    // A claim that will fail, then the context load, each still in flight when Sign out finishes.
    for(const name of ['pool_platform_claim_entry_invite','pool_platform_participant_context']){
      const world=liveWorld({owners:{'entry-2':'wrong@example.test'},invites:{[INVITE]:{email:'invited@example.test',entryId:'entry-1'}}});
      const held=gate(world,name);
      const {page,seen}=await openPage({world,signedInAs:'wrong@example.test',query:`?invite=${INVITE}`});
      await held.arrived;
      await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
      const reply=page.waitForResponse(response=>response.url().endsWith(`/rpc/${name}`));
      held.release();await reply;await settle(page);
      await visible(page,signedOut);
      assert.equal(await page.textContent('#sessionError'),'',name);
      await clean(page,seen);
    }
    // A claim error that lands while Sign out itself is still finishing is cleared with everything else.
    {
      const world=liveWorld({invites:{[INVITE]:{email:'invited@example.test',entryId:'entry-1'}}});
      const held=gate(world,'pool_platform_claim_entry_invite');
      const {page,seen}=await openPage({world,signedInAs:'wrong@example.test',query:`?invite=${INVITE}`});
      await held.arrived;
      await page.evaluate(()=>{window.__signOutGate=new Promise(resolve=>{window.__finishSignOut=resolve})});
      await page.click('#signOut');
      const reply=page.waitForResponse(response=>response.url().endsWith('/rpc/pool_platform_claim_entry_invite'));
      held.release();await reply;
      await page.locator('#sessionError').waitFor({state:'visible'});
      await page.evaluate(()=>window.__finishSignOut());
      await page.locator('#authCard').waitFor({state:'visible'});await settle(page);
      await visible(page,signedOut);
      await clean(page,seen);
    }
    // A submit, then the reload that follows it.
    for(const [name,skip] of [['pool_platform_submit_entry',0],['pool_platform_participant_context',1]]){
      const world=liveWorld({owners:{'entry-1':'player@example.test'}});
      const held=gate(world,name,skip);
      const {page,seen}=await openPage({world,signedInAs:'player@example.test'});
      await page.locator('#pickForm').waitFor({state:'visible'});
      await pickAll(page,['away','home']);await page.fill('#tiebreak','47');
      await page.click('#submitBtn');await held.arrived;
      await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
      const reply=page.waitForResponse(response=>response.url().endsWith(`/rpc/${name}`));
      held.release();await reply;await settle(page);
      await visible(page,signedOut);
      await signIn(page,'player@example.test');
      await page.locator('#pickForm').waitFor({state:'visible'});
      await visible(page,{submittedCard:false,validation:false,sessionError:false});
      assert.equal(await page.textContent('#validation'),'',`${name}: nothing from the interrupted submit carries over`);
      await clean(page,seen);
    }
  });

  test('live: an account with no entry sees the empty state with Sign out, whether the pool is unreadable or has no active entry',async()=>{
    for(const world of [liveWorld(),liveWorld({readable:['loner@example.test']})]){
      const {page,seen}=await openPage({world,signedInAs:'loner@example.test'});
      await page.locator('#emptyCard').waitFor({state:'visible'});
      await visible(page,{signOut:true,authCard:false,entryCard:false,pickForm:false,sessionError:false});
      await page.click('#signOut');
      await page.locator('#authCard').waitFor({state:'visible'});
      await visible(page,{signOut:false,emptyCard:false});
      await clean(page,seen);
    }
  });

  test('live: a normal multi-entry participant keeps Sign out in the shell; labels and tiebreak render as text; picks submit',async()=>{
    const world=liveWorld({owners:{'entry-1':'player@example.test','entry-2':'player@example.test'},games:[
      {id:'g1',away:{key:'austin',label:HOSTILE_LABEL},home:{key:'denver',label:'Denver & "Co" <b>'}},
      {id:'g2',away:{key:'phoenix',label:'Phoenix'},home:{key:'seattle',label:'Seattle'}}
    ]});
    const {page,seen}=await openPage({world,signedInAs:'player@example.test'});
    await page.locator('#entryCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,authCard:false,sessionError:false,emptyCard:false,entrySelectWrap:true,pickForm:true});
    assert.equal(await page.locator('section #signOut').count(),0,'Sign out is not inside any card');
    assert.equal(await page.textContent('label[for="game-0-away"]'),HOSTILE_LABEL);
    await page.click('label[for="game-0-away"]');
    assert.equal(await page.locator('#summary .summary-row').first().locator('strong').textContent(),HOSTILE_LABEL);
    assert.equal(await page.locator('#summary .summary-row').first().locator('span').textContent(),`${HOSTILE_LABEL} vs Denver & "Co" <b>`);
    await page.fill('#tiebreak','<script>alert(1)</script>');
    assert.equal(await summaryTiebreak(page).textContent(),'<script>alert(1)</script>');
    await page.click('#submitBtn');
    assert.match(await page.textContent('#validation'),/valid tiebreak/);
    assert.equal(world.calls.filter(c=>c.name==='pool_platform_submit_entry').length,0,'nothing invalid is sent');

    await page.click('label[for="game-1-home"]');
    for(const [typed,expected] of [['47',47],['0',0]]){
      await page.fill('#tiebreak',typed);await page.click('#submitBtn');
      await page.locator('#submittedCard').waitFor({state:'visible'});
      assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_submit_entry').at(-1).args,
        {p_week_id:'week-1',p_entry_id:'entry-1',p_source:'participant',p_payload:{picks:{g1:'away',g2:'home'},tiebreak:expected}});
      assert.equal(await page.inputValue('#tiebreak'),typed);
      await visible(page,{signOut:true});
    }
    await page.fill('#tiebreak','');await page.click('#submitBtn');
    assert.match(await page.textContent('#validation'),/valid tiebreak/);
    assert.equal(world.calls.filter(c=>c.name==='pool_platform_submit_entry').length,2,'a blank tiebreak is never sent as 0');
    await clean(page,seen);
  });

  test('mobile widths: no horizontal overflow and Sign out stays on screen in every signed-in state',async()=>{
    for(const width of [320,360,375,390,412]){
      const states=[
        {world:liveWorld({invites:{[INVITE]:{email:'invited@example.test',entryId:'entry-1'}}}),signedInAs:'wrong@example.test',query:`?invite=${INVITE}`,ready:'#sessionError'},
        {world:liveWorld(),signedInAs:'loner@example.test',ready:'#emptyCard'},
        {world:liveWorld({owners:{'entry-1':'player@example.test'}}),signedInAs:'player@example.test',ready:'#pickForm'}
      ];
      for(const {ready,...options} of states){
        const {page,seen}=await openPage({...options,width,height:740});
        await page.locator(ready).waitFor({state:'visible'});
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
        assert.ok(overflow<=0,`${width}px ${ready}: horizontal overflow ${overflow}px`);
        const box=await page.locator('#signOut').boundingBox();
        assert.ok(box&&box.x>=0&&box.x+box.width<=width&&box.height>=44,`${width}px ${ready}: Sign out box ${JSON.stringify(box)}`);
        await clean(page,seen);
      }
      const {page,seen}=await openPage({width,height:740});
      await page.locator('#pickForm').waitFor({state:'visible'});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),`${width}px sandbox pick form overflows`);
      await clean(page,seen);
    }
  });
});
