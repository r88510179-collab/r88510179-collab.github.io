import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test,{after,afterEach,before,describe} from 'node:test';
import vm from 'node:vm';
import {CONFIG_UNAVAILABLE} from './platform-client.js';
import {buildCommercialFrontend} from './scripts/build.mjs';
import {contentSecurityPolicy} from './scripts/runtime-config.mjs';
import {startServer} from './scripts/serve.mjs';
import {APP_SESSION_COOKIE,ROUTES,UPSTREAM_SESSION_COOKIE} from './server/auth-proxy-core.mjs';

const read=name=>fs.readFileSync(new URL('./'+name,import.meta.url),'utf8');
const participant=read('participant.html')+read('participant.js');
const commissioner=read('commissioner.html')+read('commissioner.js');
const css=read('styles.css');
const sw=read('service-worker.js');
const tree=participant+commissioner+read('index.html')+read('platform-config.js');
const PRECACHE_FILES=['','index.html','participant.html','commissioner.html','styles.css','sw-register.js','participant.js','commissioner.js',
  'submission-core.js','participant-core.js','import-core.js','commissioner-workflow.js','schedule-core.js','auth-core.js','platform-client.js',
  'game-day-core.js','game-day-board.js','pool-projection.js','pool-standings-board.js','final-results-form.js','results-grading.js',
  'season-standings-core.js','season-standings-board.js','manifest.webmanifest'];

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

function occursInOrder(source,...pieces){
  let offset=0;
  for(const piece of pieces){
    const index=source.indexOf(piece,offset);
    assert.ok(index>=0,piece);
    offset=index+piece.length;
  }
}

test('participant session, invitation and pick feedback are scoped to the signed-in account',()=>{
  const html=read('participant.html'),js=read('participant.js');
  const shell=html.slice(html.indexOf('<main '),html.indexOf('<section'));
  assert.match(shell,/id="signOut" type="button">Sign out/);
  assert.match(shell,/id="sessionError" role="alert"/);
  assert.equal(html.match(/id="signOut"/g).length,1);
  assert.equal(js.match(/show\('signOut'/g).length,1);
  assert.ok(js.includes("show('signOut',client.live&&!!state.session)"));
  // The page binds the sign-in it shows before anything is claimed or loaded for it, so that every later write is
  // confirmed against the browser's sign-in first (platform-client.test.mjs, tests/e2e).
  occursInOrder(js,"async function openSession(notice='')",'client.bindSession(session,accountChanged);',"message('sessionError',notice)",
    'await claimInviteIfPresent()', 'claimFailed=true;report(e)', 'await discoverParticipantPools()', 'if(!claimFailed)report(e)');
  occursInOrder(js,'state.session=await client.getSession();setAuthVisible();','watchSignIn(client);',
    "if(state.session)await openSession(signInChanged?SIGN_IN_CHANGED:'');","else if(signInChanged)message('authError',SIGNED_OUT_ELSEWHERE);");
  occursInOrder(js,'state.session=await client.verifyOtp(', 'await openSession()');
  occursInOrder(js,'const context=await client.participantContext(', 'if(state.session!==session||state.poolSlug!==slug)return;', 'state.context=context');
  // One function takes an account off the page. Sign-out runs it once the server has signed the account out; a
  // sign-in that changed in another tab runs it and then starts the page again.
  occursInOrder(js,'function clearAccount(){',"$('signOut').addEventListener",'function accountChanged(){','function renderContext');
  const clear=js.slice(js.indexOf('function clearAccount(){'),js.indexOf("$('signOut').addEventListener"));
  occursInOrder(clear,'client.bindSession(null);','session:null,context:null,entry:null', 'availablePools:[],preferredEntryId:null', "message(id,'')", 'setAuthVisible()');
  for(const id of ['entryCard','pickForm','submittedCard','emptyCard','otpWrap','sessionError','validation','authError'])assert.ok(clear.includes("'"+id+"'"));
  assert.doesNotMatch(clear,/inviteEntryId\s*=/);
  const signout=js.slice(js.indexOf("$('signOut').addEventListener"),js.indexOf('function accountChanged(){'));
  occursInOrder(signout,'try{await client.signOut()}catch(e){',"return}",'clearAccount();');
  assert.doesNotMatch(signout,/inviteEntryId\s*=|restartAfterSignInChange/);
  const changed=js.slice(js.indexOf('function accountChanged(){'),js.indexOf('function renderContext'));
  occursInOrder(changed,'clearAccount();','restartAfterSignInChange();');
  assert.equal(js.match(/restartAfterSignInChange\(\)/g).length,1);
  occursInOrder(js,'const signInChanged=takeSignInChangedMark();','const invite=readInviteFromUrl(location.href);');
  const submit=js.slice(js.indexOf("$('pickForm').addEventListener('submit'"));
  occursInOrder(submit,'const session=state.session','await client.submitEntry(', 'if(state.session!==session)return;', "$('submittedTitle')", "if(state.session===session){message('validation'",'finally{if(state.context&&state.entry)');
});

test('links carry only the entry and pool, while a verified account authorizes the claim',()=>{
  const c=read('commissioner.js'),p=read('participant.js');
  occursInOrder(c,'await client.createInvite({entryId,email','if(state.session!==session)return;', "participantInviteUrl(new URL('./participant.html',location.href),state.context.pool.slug,result.entry_id)");
  occursInOrder(p,'const invite=readInviteFromUrl(location.href);',"history.replaceState(null,'',invite.cleanUrl)",'let inviteEntryId=invite.entryId;', "await import('./platform-config.js')");
  occursInOrder(p,'if(!state.session)return;', 'if(inviteError)throw', 'if(!inviteEntryId)return;', 'if(claimInFlight)return claimInFlight;', 'client.claimEmailInvite(target).then(', 'if(state.session!==session)return;', 'state.preferredEntryId=target;', "inviteEntryId='';");
  for(const js of [c,p,read('auth-core.js')]){
    assert.doesNotMatch(js,/searchParams\.(set|append)\(\s*['"]invite['"]|localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  }
});

test('participant Survivor choices submit the stable key and show the escaped display name that tells shared labels apart',()=>{
  const js=read('participant.js');
  const survivor=/\nfunction renderSurvivor\(access,sub\)\{\n([\s\S]*?)\n\}\n/.exec(js)?.[1];
  assert.ok(survivor,'renderSurvivor must exist');
  assert.match(survivor,/<input type="radio" id="team-\$\{i\}" name="survivor-team" value="\$\{esc\(team\.key\)\}"/);
  assert.match(survivor,/<label for="team-\$\{i\}">\$\{esc\(team\.display\)\}\$\{team\.burned\?' · USED':team\.ambiguous\?' · ASK COMMISSIONER':''\}<\/label>/);
  assert.match(survivor,/\$\{access\.editable&&!team\.burned&&!team\.ambiguous\?'':'disabled'\}/);
  assert.doesNotMatch(survivor,/team\.label/,'the bare label can repeat across choices');
  assert.match(js,/summaryRow\('Survivor selection',team\?team\.display:'—'\)/);
});

test('commissioner sign-out clears tenant data and async work is fenced by its originating session',()=>{
  const html=read('commissioner.html'),js=read('commissioner.js');
  const shell=html.slice(html.indexOf('<main '),html.indexOf('<section'));
  assert.match(shell,/id="signOut" type="button">Sign out/);
  assert.match(shell,/id="sessionError" role="alert"/);
  assert.equal(html.match(/id="signOut"/g).length,1);
  assert.equal(js.match(/show\('signOut'/g).length,1);
  assert.ok(js.includes("show('signOut',client.live&&!!state.session)"));
  occursInOrder(js,'await client.commissionerContext(slug)','if(session!==state.session||slug!==state.poolSlug)return;', 'state.context=context;');
  // As on the participant page: the sign-in is bound before anything is loaded for it, one function takes an
  // account off the page, and a sign-in that changed in another tab runs it and starts the page again.
  occursInOrder(js,"async function openSession(notice='')",'client.bindSession(session,accountChanged);',"msg('sessionError',notice)",
    'await discoverCommissionerPools();','if(session!==state.session)return;');
  occursInOrder(js,'state.session=await client.getSession();setAuth();','watchSignIn(client);',
    "if(state.session)await openSession(signInChanged?SIGN_IN_CHANGED:'');","else if(signInChanged)msg('authError',SIGNED_OUT_ELSEWHERE);");
  occursInOrder(js,'function clearAccount(){',"$('signOut').addEventListener",'function accountChanged(){','function cancelPoolCreation');
  const clear=js.slice(js.indexOf('function clearAccount(){'),js.indexOf("$('signOut').addEventListener"));
  occursInOrder(clear,'client.bindSession(null);','session:null,context:null,season:null,week:null', 'availablePools:[],preview:null','hidePool()', "msg(id,'')",'setAuth()');
  for(const id of ['otpWrap','inviteLinkWrap','seasonSelect','weekSelect','entriesBody','inviteEntry','resultBody','email','otp','inviteEmail','importText','inviteResult','importError','importResult'])assert.ok(clear.includes("'"+id+"'"),id);
  const signout=js.slice(js.indexOf("$('signOut').addEventListener"),js.indexOf('function accountChanged(){'));
  occursInOrder(signout,'try{await client.signOut()}catch(e){','return}','clearAccount();');
  assert.doesNotMatch(signout,/restartAfterSignInChange/);
  const changed=js.slice(js.indexOf('function accountChanged(){'),js.indexOf('function cancelPoolCreation'));
  occursInOrder(changed,'clearAccount();','restartAfterSignInChange();');
  assert.equal(js.match(/restartAfterSignInChange\(\)/g).length,1);
  const confirm=js.slice(js.indexOf("$('confirmImport').addEventListener"));
  occursInOrder(confirm,'pending.session!==state.session)return;', 'state.preview=null;', 'await client.submitBatch(', 'if(state.session!==pending.session)return;', 'summarizeBatchResults', "if(state.session===pending.session)msg('importError'");
});

test('commissioner preview and import results escape entry labels and conflict messages',()=>{
  assert.ok(commissioner.includes('source_conflict:'));
  assert.ok(commissioner.includes('<td>\u0024{esc(r.entry)}</td><td>\u0024{esc(r.result)}</td>'));
  assert.ok(commissioner.includes("<td>\u0024{esc(entry?.display_name||entry?.entry_code||'Entry')}</td><td>\u0024{esc(outcome)}</td>"));
});

test('responsive baseline keeps mobile controls touch-friendly',()=>{
  assert.match(css,/min-width:320px/);
  assert.match(css,/font-size:16px/);
  assert.match(css,/min-height:48px/);
  assert.match(css,/@media\(max-width:560px\)/);
  // Sign out is a .compact button (42px); .tap-target follows .compact with equal specificity, so it wins: 44px.
  assert.match(css,/\.compact\{min-height:42px;[^}]*\}\.tap-target\{min-height:44px\}/);
  assert.match(css,/\.shell-notice\{margin-bottom:14px\}/);
});

test('service worker precaches all Step 2 modules',()=>{
  for(const asset of ['participant.js','commissioner.js','platform-client.js','participant-core.js','import-core.js','auth-core.js','sw-register.js']){
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

test('install precaches exactly the listed static modules, at bare same-origin paths, in the commercial cache only',async()=>{
  const worker=await installedWorker();
  const keys=[...worker.stores.get(worker.cacheName).keys()];
  assert.deepEqual(keys.sort(),PRECACHE_FILES.map(asset=>`${ORIGIN}/pool-platform/${asset}`).sort());
  // The runtime configuration and the bundled SDK are never precached.
  for(const absent of ['platform-config.js','vendor/neon-js.js','service-worker.js'])assert.ok(!keys.some(key=>key.endsWith(`/${absent}`)),absent);
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

// The fragment never leaves the browser in a request, but FetchEvent.request.url keeps it, and Cache Storage keeps a
// stored request's URL as given: Chromium stored participant.html#invite=<token> when a link had no query string.
test('an invite fragment is never a cache key: with or without a query, online or offline, the worker stores nothing for it',async()=>{
  const token='ab'.repeat(32);
  const links=[`${ORIGIN}/pool-platform/participant.html?pool=demo#invite=${token}`,`${ORIGIN}/pool-platform/participant.html#invite=${token}`];
  const online=await installedWorker();
  for(const url of links){
    const result=await online.dispatch('fetch',{request:request(url,{mode:'navigate'})});
    assert.equal(result.responded,true,url);
    assert.equal(result.response.body,'network',url);
  }
  assert.deepEqual(online.log.puts,[],'neither navigation is stored');
  assert.equal((await online.dispatch('fetch',{request:request(`${ORIGIN}/pool-platform/auth-core.js#invite=${token}`)})).responded,false,'a module URL with a fragment is not stored either');
  assert.deepEqual(online.log.puts,[]);
  const offline=await installedWorker({network:async()=>{throw new TypeError('offline')}});
  for(const url of links){
    const result=await offline.dispatch('fetch',{request:request(url,{mode:'navigate'})});
    assert.equal(result.response.body,'precached /pool-platform/participant.html',url);
  }
  assert.deepEqual(offline.log.puts,[]);
  for(const worker of [online,offline]){
    for(const store of worker.stores.values())for(const key of store.keys())assert.ok(!key.includes('#')&&!key.includes(token),key);
  }
});

test('cross-origin, auth, Data API, non-GET, Authorization-bearing and query requests are left to the network',async()=>{
  const worker=await installedWorker();
  const untouched=[
    request('https://ep-demo.neonauth.c-2.us-east-2.aws.neon.tech/neondb/auth/get-session',{mode:'cors'}),
    request('https://ep-demo.apirest.c-2.us-east-2.aws.neon.tech/neondb/rest/v1/rpc/pool_platform_submit_entry',{method:'POST'}),
    request('https://ep-demo.apirest.c-2.us-east-2.aws.neon.tech/neondb/rest/v1/pool_platform_entries'),
    request('https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm'),
    request(`${ORIGIN}/pool-platform/platform-config.js`),
    request(`${ORIGIN}/pool-platform/vendor/neon-js.js`),
    request(`${ORIGIN}/neondb/auth/get-session`),
    request(`${ORIGIN}/pool-platform/rpc/pool_platform_participant_context`),
    request(`${ORIGIN}/pool-platform/auth-core.js`,{method:'POST'}),
    request(`${ORIGIN}/pool-platform/auth-core.js`,{headers:{Authorization:'Bearer a.b.c'}}),
    request(`${ORIGIN}/pool-platform/auth-core.js?v=2`),
    request(`${ORIGIN}/nfl-pool/app.js`),
    // The same-origin Auth proxy, as the SDK calls it (fetch, never a navigation), with and without credentials.
    ...Object.keys(ROUTES).flatMap(route=>[request(`${ORIGIN}${route}`,{method:ROUTES[route].method}),request(`${ORIGIN}${route}`,{method:ROUTES[route].method,mode:'same-origin'}),
      request(`${ORIGIN}${route}`,{method:ROUTES[route].method,headers:{cookie:`${APP_SESSION_COOKIE}=x`,authorization:'Bearer a.b.c'}})]),
    request(`${ORIGIN}/api/auth/get-session`,{mode:'no-cors'}),request(`${ORIGIN}/pool-platform/api/auth/get-session`),request(`${ORIGIN}/api/auth/unknown`)
  ];
  for(const r of untouched){
    const result=await worker.dispatch('fetch',{request:r});
    assert.equal(result.responded,false,`${r.method} ${r.url}`);
  }
  assert.deepEqual(worker.log.fetched,[]);
  assert.deepEqual(worker.log.puts,[]);
});

test('the Auth proxy is never cached or answered by the worker: its fetches go straight to the network, and a navigation to it is passed through, never stored, and offline gets the landing page',async()=>{
  assert.doesNotMatch(sw,/api\/auth|get-session|sign-out/,'no Auth route is ever listed');
  const AUTH_ANSWER='{"session":{"id":"s"}}';
  for(const [network,navigated] of [[async()=>fakeResponse({body:AUTH_ANSWER}),AUTH_ANSWER],[async()=>{throw new TypeError('offline')},'precached /pool-platform/index.html']]){
    const worker=await installedWorker({network});
    for(const [route,{method}] of Object.entries(ROUTES)){
      for(const mode of ['cors','same-origin','no-cors']){
        assert.equal((await worker.dispatch('fetch',{request:request(`${ORIGIN}${route}`,{method,mode})})).responded,false,`${method} ${route} ${mode}`);
      }
      // Typed into the address bar or followed as a link it is a navigation. The worker hands it to the network (the
      // proxy refuses navigations) and stores nothing; offline it serves the landing page, never an Auth answer.
      const navigation=await worker.dispatch('fetch',{request:request(`${ORIGIN}${route}`,{mode:'navigate'})});
      assert.equal(navigation.response?.body,navigated,`navigation to ${route}`);
    }
    assert.deepEqual(worker.log.puts,[]);
    for(const store of worker.stores.values())assert.ok(![...store.keys()].some(key=>key.includes('/api/auth')));
  }
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

test('the runtime configuration is never stored or answered by the worker, online or offline, so no cached copy can pin a backend',async()=>{
  assert.doesNotMatch(sw,/platform-config\.js'/,'not in the precache list');
  const config=`${ORIGIN}/pool-platform/platform-config.js`;
  for(const network of [async()=>fakeResponse({body:'export const PLATFORM_CONFIG={}'}),async()=>{throw new TypeError('offline')}]){
    const worker=await installedWorker({network});
    for(const mode of ['cors','same-origin','no-cors']){
      assert.equal((await worker.dispatch('fetch',{request:request(config,{mode})})).responded,false,mode);
    }
    // Typed into the address bar it is a navigation: fetched from the network, never stored; offline the landing page.
    const navigation=await worker.dispatch('fetch',{request:request(config,{mode:'navigate'})});
    assert.notEqual(navigation.response?.body,'precached /pool-platform/platform-config.js');
    assert.deepEqual(worker.log.puts,[]);
    for(const store of worker.stores.values())assert.ok(![...store.keys()].some(key=>key.includes('platform-config')));
  }
});

test('activation deletes the v3 commercial cache, the last one that held platform-config.js, and nothing outside the namespace',async()=>{
  const current=(await installedWorker()).cacheName;
  assert.equal(current,'pool-platform-commercial-v5');
  const worker=bootWorker({cacheNames:['pool-platform-commercial-v3',current,PERSONAL_CACHE,'another-app-v1']});
  await worker.dispatch('activate');
  assert.deepEqual(worker.log.deleted,['pool-platform-commercial-v3']);
  assert.deepEqual([...worker.stores.keys()].sort(),[current,PERSONAL_CACHE,'another-app-v1'].sort());
});

test('a request carrying Authorization is never stored, in any header case and for navigations too',async()=>{
  const worker=await installedWorker();
  for(const name of ['Authorization','authorization','AUTHORIZATION']){
    const asset=await worker.dispatch('fetch',{request:request(`${ORIGIN}/pool-platform/participant.js`,{headers:{[name]:'Bearer a.b.c'}})});
    assert.equal(asset.responded,false,name);
    const page=await worker.dispatch('fetch',{request:request(`${ORIGIN}/pool-platform/participant.html`,{mode:'navigate',headers:{[name]:'Bearer a.b.c'}})});
    assert.equal(page.response.body,'network',name);
  }
  assert.deepEqual(worker.log.puts,[]);
});

// Opt-in: the real participant and commissioner pages in headless browsers through Playwright.
//   POOL_PLATFORM_TEST_BROWSER=1 E2E_BROWSERS=chromium,webkit NODE_PATH="$(npm root -g)" node --test pool-platform/ui-contract.test.mjs
// Sandbox runs as shipped. Live mode is stubbed only at the network edge: platform-config.js is served as a
// live config, the same-origin bundled SDK (vendor/neon-js.js) as an in-page fake auth client, and the Data API
// RPCs by an in-memory stand-in, so the page's own auth shell, invite, rendering and submit code runs unmodified.
// Every page is served with the production Content-Security-Policy, and clean() fails on any violation reported.
const BROWSER=process.env.POOL_PLATFORM_TEST_BROWSER||'';
const BROWSER_ENGINES=(process.env.E2E_BROWSERS||'chromium').split(',');
const SDK_PATH=/import\('\.\/(vendor\/[^']+)'\)/.exec(read('platform-client.js'))?.[1];
// The stand-in Data API is same-origin and the fake SDK makes no Auth request, so connect-src 'self' suffices.
const PAGE_CSP=contentSecurityPolicy({dataUrl:''});
const ESBUILD=(()=>{try{return !!createRequire(import.meta.url).resolve('esbuild')}catch{return false}})();
const FAKE_SDK=`const b64=s=>btoa(s).replace(/[+]/g,'-').replace(/[/]/g,'_').replace(/=+$/,'');
const auth=()=>window.__fakeAuth;
const jwt=email=>[b64('{"alg":"none","typ":"JWT"}'),b64(JSON.stringify({email})),b64('shape-only-signature')].join('.');
export function createClient(){return{auth:{
  getSession:async()=>auth().email?{data:{session:{token:jwt(auth().email)},user:{id:auth().email,email:auth().email}},error:null}:{data:{session:null,user:null},error:null},
  emailOtp:{sendVerificationOtp:async({email})=>{auth().sent=email;return{data:{success:true},error:null}}},
  signIn:{emailOtp:async({email,otp})=>email===auth().sent&&otp==='123456'?(auth().email=email,{data:{},error:null}):{data:null,error:new Error('Invalid sign-in code.')}},
  signOut:async()=>{await window.__signOutGate;auth().email=null;return{data:{success:true},error:null}}
}}}`;
const LEGACY_INVITE='ab'.repeat(32);
const ENTRY_ONE='10000000-0000-4000-8000-000000000001';
const ENTRY_TWO='10000000-0000-4000-8000-000000000002';
const POOL_ID='20000000-0000-4000-8000-000000000001';
const WEEK_ID='30000000-0000-4000-8000-000000000001';
const POOL_SLUG='it-pool';
const JOIN_PATH=`/join/${POOL_SLUG}/${ENTRY_ONE}`;
const CLAIM_INVITE='pool_platform_claim_email_invite';
const CREATE_INVITE='pool_platform_create_email_invite';
const LIST_PARTICIPANT_POOLS='pool_platform_list_participant_pools';
const LIST_COMMISSIONER_POOLS='pool_platform_list_commissioner_pools';
const PARTICIPANT_CONTEXT='pool_platform_participant_context';
const COMMISSIONER_CONTEXT='pool_platform_commissioner_context';
const NO_MANAGED_POOLS='No pools are assigned to this account.';
const REQUEST_FAILED='The request could not be completed. Please try again or contact the pool organizer.';
const sdkJwt=email=>[
  Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
  Buffer.from(JSON.stringify({email})).toString('base64url'),
  Buffer.from('shape-only-signature').toString('base64url')
].join('.');
const HOSTILE_LABEL='<img src=x onerror="window.__xss=(window.__xss||0)+1">';
// Every value the tiebreak box must show verbatim (blank shows the dash) without creating markup or running.
const TIEBREAK_INPUTS=['<img src=x onerror=alert(1)>','<script>alert(1)</script>','<img src=x onerror="window.__xss=(window.__xss||0)+1">','<svg onload=alert(1)>','"double" and \'single\' quotes','Tom & Jerry &amp; &lt;b&gt;','<b>bold</b> > <i>angle</i> <','47','0',''];
const textAsHtml=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function serveDirectory(root){
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json'};
  const server=http.createServer((req,res)=>{
    server.targets.push(req.url); // each request target exactly as the browser sent it
    const pathname=new URL(req.url,'http://localhost').pathname;
    const name=/^\/join\/[a-z0-9-]+\/[0-9a-f-]+$/i.test(pathname)?'participant.html':decodeURIComponent(pathname).replace(/^\/+/,'')||'index.html';
    if(name.includes('/')||name.includes('..')){res.writeHead(404).end();return}
    fs.readFile(new URL(name,root),(error,body)=>{
      if(error){res.writeHead(404).end();return}
      res.writeHead(200,{'content-type':types[path.extname(name)]||'application/octet-stream','content-security-policy':PAGE_CSP}).end(body);
    });
  });
  server.targets=[];
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server)));
}

function liveWorld({owners={},invites={},readable=[],unverified=[],games,poolType='pickem'}={}){
  const deadline=new Date(Date.now()+86400000).toISOString();
  return{
    owners,invites,readable,unverified,calls:[],gates:[],
    entries:[ENTRY_ONE,ENTRY_TWO].map((id,i)=>({id,entry_code:`E0${i+1}`,display_name:`Entry E0${i+1}`,status:'active',submission:null,history:[]})),
    context:{
      pool:{id:POOL_ID,slug:POOL_SLUG,display_name:poolType==='survivor'?'IT Survivor':'IT Pick’em',pool_type:poolType,rules:{},branding:{}},
      season:{id:'season-1',season:2027,config:{}},
      week:{id:WEEK_ID,week:1,status:'open',opens_at:null,deadline_at:deadline,config:{tiebreakRequired:poolType==='pickem',games:games||[
        {id:'g1',away:{key:'austin',label:'Austin'},home:{key:'denver',label:'Denver'}},
        {id:'g2',away:{key:'phoenix',label:'Phoenix'},home:{key:'seattle',label:'Seattle'}}
      ]}}
    }
  };
}

// The same pool seen from the commissioner console. commissioner_context answers only a listed commissioner and
// only for this pool's slug, raising commissioner_required otherwise, as the database does; contextFailure
// makes it fail with an HTTP error or a dropped connection instead.
function consoleWorld({commissioners=['commish@example.test'],contextFailure=null,additionalPools=[]}={}){
  const world=liveWorld(),{pool,season,week}=world.context;
  return Object.assign(world,{commissioners,contextFailure,additionalPools,console:{
    pool:{...pool,tenant_id:'tenant-1',display_name:'Private Console Pool'},
    seasons:[{...season,status:'active',weeks:[week],
      entries:world.entries.map(({id,entry_code,display_name,status})=>({id,entry_code,display_name,status,claimed:false,submissions:[]}))}]
  }});
}
function participantDiscovery({pool,season}){
  const {id,slug,display_name,pool_type}=pool;
  return {id,slug,display_name,pool_type,season:season.season};
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
    const reply=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(['pool_platform_week_projection_snapshot','pool_platform_week_result_snapshot','pool_platform_season_standings_snapshot'].includes(name)){
      // The standings browser suite exercises these endpoints against PostgreSQL.
      return reply(404,{code:'PGRST202',message:'Could not find the function'});
    }
    world.calls.push({name,email,args,at:Date.now(),method:request.method(),url:request.url(),headers:request.headers(),body:request.postData()});
    const held=world.gates.find(g=>g.name===name&&!g.done);
    if(held){if(held.skip>0)held.skip--;else{held.done=true;held.seen();await held.released}}
    const fail=message=>reply(400,{code:'P0001',details:null,hint:null,message});
    // world.authRequired[name]: how many more calls of that RPC answer auth_required before anything else happens,
    // as a newly opened Data API connection that saw no identity would (the database raises it first).
    if(world.authRequired?.[name]>0){world.authRequired[name]--;return fail('auth_required')}
    if(!email)return fail('auth_required');
    if(name===CLAIM_INVITE){
      if(world.unverified.includes(email))return fail('invite_email_unverified');
      const entry=world.entries.find(e=>e.id===args.p_entry_id&&e.status==='active');
      const invite=entry&&world.invites[entry.id];
      if(!invite||invite.claimedBy||invite.email!==email.toLowerCase()||
         (invite.expires_at&&Date.parse(invite.expires_at)<=Date.now()))return fail('invite_unavailable');
      if(world.owners[entry.id])return fail('entry_already_claimed');
      invite.claimedBy=email;world.owners[entry.id]=email;
      return reply(200,{entry_id:entry.id,claimed:true});
    }
    const ownedEntries=world.entries.filter(e=>e.status==='active'&&world.owners[e.id]===email);
    if(name===LIST_PARTICIPANT_POOLS)return reply(200,ownedEntries.length?[participantDiscovery(world.context)]:[]);
    if(name===PARTICIPANT_CONTEXT){
      if(world.participantContextFailure)return fail(world.participantContextFailure);
      if(args.p_pool_slug!==world.context.pool.slug||
         (!ownedEntries.length&&!world.readable.includes(email)))return fail('pool_not_found');
      return reply(200,{...world.context,entries:ownedEntries});
    }
    if(name==='pool_platform_submit_entry'){
      const entry=world.entries.find(e=>e.id===args.p_entry_id);
      if(!entry||world.owners[entry.id]!==email)return fail('entry_not_owned');
      const revision=(entry.submission?.revision||0)+1;
      entry.submission={source:'participant',status:'submitted',payload:args.p_payload,revision};
      return reply(200,{ok:true,code:revision>1?'updated':'created',submission_id:`sub-${entry.id}`,source:'participant',status:'submitted',revision});
    }
    const commissioner=(world.commissioners||[]).includes(email);
    if(name===LIST_COMMISSIONER_POOLS){
      if(!commissioner)return reply(200,[]);
      const {slug,display_name,pool_type}=world.console.pool;
      return reply(200,[{slug,display_name,pool_type,status:'active'},...world.additionalPools]);
    }
    if(name===COMMISSIONER_CONTEXT){
      if(world.contextFailure==='network')return route.abort('failed');
      if(world.contextFailure==='http')return reply(500,{code:'XX000',details:null,hint:null,message:'upstream_unavailable'});
      if(!commissioner||args.p_pool_slug!==world.console.pool.slug)return fail('commissioner_required');
      return reply(200,world.console);
    }
    if(name===CREATE_INVITE){
      const recipient=typeof args.p_email==='string'?args.p_email.trim().toLowerCase():'';
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))return fail('invalid_invite_email');
      if(!Number.isInteger(args.p_expires_hours)||args.p_expires_hours<1||args.p_expires_hours>720)return fail('invalid_invite_expiry');
      const entry=world.entries.find(e=>e.id===args.p_entry_id);
      if(!commissioner||!entry)return fail('commissioner_required');
      if(world.owners[entry.id]||entry.status!=='active')return fail('entry_unavailable');
      const expires_at=new Date(Date.now()+args.p_expires_hours*3600000).toISOString();
      world.invites[entry.id]={email:recipient,expires_at};
      return reply(200,{entry_id:entry.id,expires_at,delivery:'verified_email'});
    }
    if(name==='pool_platform_submit_batch'){
      if(!commissioner)return fail('commissioner_required');
      return reply(200,args.p_items.map(item=>({entry_id:item.entry_id,ok:true,result:{ok:true,code:'created',revision:1}})));
    }
    return fail(`unexpected_rpc:${name}`);
  };
}

for(const engine of BROWSER?BROWSER_ENGINES:['chromium']){
describe(`participant and commissioner pages in headless ${engine} (opt-in)`,{skip:BROWSER?false:'set POOL_PLATFORM_TEST_BROWSER=1 (with playwright on NODE_PATH) to drive the real page'},()=>{
  let server,browser,base;
  const contexts=[];
  before(async()=>{
    let playwright;
    try{playwright=createRequire(import.meta.url)('playwright')}
    catch(error){assert.fail(`POOL_PLATFORM_TEST_BROWSER is set but playwright cannot be loaded (${error.message.split('\n')[0]}); put it on NODE_PATH`)}
    server=await serveDirectory(new URL('./',import.meta.url));
    base=`http://127.0.0.1:${server.address().port}`;
    browser=await playwright[engine].launch();
  });
  afterEach(()=>Promise.all(contexts.splice(0).map(c=>c.close())));
  after(async()=>{
    await browser?.close();
    await new Promise(resolve=>server?server.close(resolve):resolve());
  });

  // Collects every Content-Security-Policy violation a page reports, as "<directive> <blocked URI> <source>:<line>".
  const recordCsp=page=>page.addInitScript(()=>{
    window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
  });
  async function openPage({world=null,signedInAs=null,query='',width=390,height=844,path='participant.html',poolSlug='it-pool'}={}){
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height}});
    contexts.push(context);
    const page=await context.newPage(),seen={dialogs:[],errors:[],requests:[],console:[]};
    page.on('dialog',dialog=>{seen.dialogs.push(dialog.message());dialog.dismiss().catch(()=>{})});
    page.on('pageerror',error=>seen.errors.push(error.message));
    page.on('request',request=>seen.requests.push({method:request.method(),url:request.url(),headers:request.headers()}));
    page.on('console',message=>seen.console.push(message.text()));
    await recordCsp(page);
    if(world){
      await page.addInitScript(email=>{window.__fakeAuth={email}},signedInAs);
      await page.route(`${base}/api/auth/get-session`,async route=>{
        const email=await page.evaluate(()=>window.__fakeAuth.email);
        return route.fulfill({json:email?{session:{id:'fake-session'},user:{id:email,email}}:null,
          headers:email?{'set-auth-jwt':sdkJwt(email)}:{}});
      });
      await page.route(`${base}/platform-config.js`,route=>route.fulfill({contentType:'text/javascript',
        body:`export const PLATFORM_CONFIG=Object.freeze({mode:'live',dataUrl:'${base}/data-api',defaultPoolSlug:${JSON.stringify(poolSlug)}});`}));
      await page.route(`${base}/${SDK_PATH}`,route=>route.fulfill({contentType:'text/javascript',body:FAKE_SDK}));
      await page.route(`${base}/data-api/rpc/*`,dataApi(world));
    }
    await page.goto(new URL(path+query,base+'/').href);
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
    assert.deepEqual(await page.evaluate(()=>window.__csp),[],'no Content-Security-Policy violation');
  };
  const pickAll=async(page,sides)=>{for(const [i,side] of sides.entries())await page.click(`label[for="game-${i}-${side}"]`)};
  // Lets the page finish whatever a just-delivered response set in motion.
  const settle=page=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,150)));
  const signIn=async(page,email)=>{
    await page.fill('#email',email);await page.click('#sendCode');
    await page.fill('#otp','123456');await page.click('#verifyCode');
  };
  const summaryTiebreak=page=>page.locator('#summary .summary-row').last().locator('strong');
  const submitPick=async(page,title)=>{
    await page.click('#submitBtn');
    await page.locator('#submittedTitle',{hasText:title}).waitFor({state:'visible'});
  };
  // The entry UUID is visible only on the invitation navigation and in authorized RPC bodies or loaded entries.
  // A retired token may arrive in a pasted URL, but never continues into the API, document, logs or storage.
  const inviteContained=async(page,world,seen,{entryId=ENTRY_ONE,legacyToken=null}={})=>{
    assert.equal(server.targets.some(target=>target.includes('#')),false,'a fragment reached the host');
    for(const request of seen.requests){
      assert.equal(JSON.stringify(request.headers).includes(entryId),false,'an invitation ID in a request header');
      if(request.url.includes(entryId)){
        const url=new URL(request.url);
        assert.ok(url.pathname===JOIN_PATH||url.searchParams.get('entry')===entryId,request.url);
      }
    }
    for(const call of world.calls){
      assert.doesNotMatch(call.body||'',/p_invite_token|invite_token/);
      if(call.name===CLAIM_INVITE)assert.equal(call.body,JSON.stringify({p_entry_id:entryId}));
      if(legacyToken)assert.equal(JSON.stringify(call).includes(legacyToken),false,call.name);
    }
    const markers=[entryId,sdkJwt('invited@example.test'),...(legacyToken?[legacyToken]:[])];
    const stores=await page.evaluate(async()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookie:document.cookie,
      history:history.state,databases:await indexedDB.databases(),caches:await caches.keys()}));
    for(const marker of markers){
      assert.equal(seen.console.some(text=>text.includes(marker)),false,'a console message');
      assert.equal(page.url().includes(marker),false,`the address bar: ${page.url()}`);
      assert.equal(stores.includes(marker),false,stores);
      assert.equal(JSON.stringify(await page.context().cookies()).includes(marker),false,'a cookie');
    }
    if(legacyToken)assert.equal((await page.content()).includes(legacyToken),false,'a retired token is not on the page');
  };

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

  test('live: wrong account opens an email-bound invite → refusal beside Sign out → sign out → verified recipient claims it from page memory',async()=>{
    const world=liveWorld({invites:{[ENTRY_ONE]:{email:'invited@example.test'}},unverified:['unverified@example.test']});
    const {page,seen}=await openPage({world,signedInAs:'wrong@example.test',path:JOIN_PATH});
    await page.locator('#sessionError').waitFor({state:'visible'});
    assert.match(await page.textContent('#sessionError'),/expired, already used, or no longer available/);
    await page.locator('#emptyCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,authCard:false,entryCard:false,pickForm:false,sessionError:true});
    assert.equal(world.invites[ENTRY_ONE].claimedBy,undefined,'a rejected claim does not consume the invite');
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`,'the invite left the address bar when the page read it; the pool stays');

    await page.click('#signOut');
    await page.locator('#authCard').waitFor({state:'visible'});
    await visible(page,{signOut:false,sessionError:false,entryCard:false,emptyCard:false,otpWrap:false});
    assert.equal(await page.evaluate(()=>window.__fakeAuth.email),null,'the session ended');
    assert.equal(await page.inputValue('#email'),'');

    await signIn(page,'unverified@example.test');
    await page.locator('#sessionError',{hasText:'requires a verified email address'}).waitFor();
    assert.equal(world.invites[ENTRY_ONE].claimedBy,undefined,'an unverified account does not consume the invite');
    await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
    await signIn(page,'invited@example.test');
    await page.locator('#entryCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,authCard:false,sessionError:false,pickForm:true,emptyCard:false});
    assert.equal(world.invites[ENTRY_ONE].claimedBy,'invited@example.test');
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    assert.deepEqual(world.calls.filter(c=>c.name===CLAIM_INVITE).map(c=>[c.email,c.args]),
      ['wrong@example.test','unverified@example.test','invited@example.test'].map(email=>[email,{p_entry_id:ENTRY_ONE}]));
    // A successful claim drops the hint: the next account to sign in on this page claims nothing.
    await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
    await signIn(page,'wrong@example.test');
    await page.locator('#emptyCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,sessionError:false});
    assert.equal(world.calls.filter(c=>c.name===CLAIM_INVITE).length,3);
    await inviteContained(page,world,seen);
    await clean(page,seen);
  });

  test('live: reopening an invite link this account already claimed reports it but still loads the entry, before and after signing in again',async()=>{
    const world=liveWorld({owners:{[ENTRY_ONE]:'player@example.test'},invites:{[ENTRY_ONE]:{email:'player@example.test',claimedBy:'player@example.test'}}});
    const {page,seen}=await openPage({world,signedInAs:'player@example.test',path:JOIN_PATH});
    for(const round of ['opened','signed in again']){
      await page.locator('#entryCard').waitFor({state:'visible'});
      assert.match(await page.textContent('#sessionError'),/expired, already used/,round);
      await visible(page,{signOut:true,sessionError:true,pickForm:true,authCard:false,emptyCard:false});
      assert.equal(page.url(),`${base}/participant.html?pool=it-pool`,round);
      if(round==='opened'){
        await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
        await signIn(page,'player@example.test');
      }
    }
    assert.deepEqual(world.calls.filter(c=>c.name===CLAIM_INVITE).map(c=>c.email),['player@example.test','player@example.test']);
    await inviteContained(page,world,seen);
    await clean(page,seen);
  });

  test('live: a signed-out participant opens an invite, which leaves the address bar at once and is claimed from page memory after sign-in',async()=>{
    const world=liveWorld({invites:{[ENTRY_ONE]:{email:'invited@example.test'}}});
    const {page,seen}=await openPage({world,path:JOIN_PATH});
    await page.locator('#authCard').waitFor({state:'visible'});
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    await visible(page,{signOut:false,sessionError:false,entryCard:false});
    assert.deepEqual(world.calls,[],'nothing is claimed or loaded before sign-in');
    await signIn(page,'invited@example.test');
    await page.locator('#entryCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,sessionError:false,pickForm:true});
    assert.deepEqual(world.calls.map(c=>[c.name,c.email]),[CLAIM_INVITE,LIST_PARTICIPANT_POOLS,PARTICIPANT_CONTEXT].map(name=>[name,'invited@example.test']));
    assert.equal(world.invites[ENTRY_ONE].claimedBy,'invited@example.test');
    await inviteContained(page,world,seen);
    await clean(page,seen);
  });

  test('live: opening an invitation over an open participant page loads the token-free route and removes the entry hint',async()=>{
    const world=liveWorld({invites:{[ENTRY_ONE]:{email:'invited@example.test'}}});
    const {page,seen}=await openPage({world,signedInAs:'invited@example.test',query:'?pool=it-pool'});
    await page.locator('#emptyCard').waitFor({state:'visible'});
    await page.goto(base+JOIN_PATH);
    await page.locator('#entryCard').waitFor({state:'visible'});
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    assert.deepEqual(world.calls.filter(c=>c.name===CLAIM_INVITE).map(c=>[c.email,c.args]),[['invited@example.test',{p_entry_id:ENTRY_ONE}]]);
    await inviteContained(page,world,seen);
    await clean(page,seen);
  });

  test('live: a query-string invite (the retired link format) is never claimed; it leaves the URL, the participant is told to ask for a new link, and their own entries still load',async()=>{
    const duplicateToken='ef'.repeat(32);
    for(const [label,path,query,copy] of [
      ['query','participant.html',`?pool=it-pool&invite=${LEGACY_INVITE}`,/retired format/],
      ['query and fragment','participant.html',`?pool=it-pool&invite=${LEGACY_INVITE}#invite=${duplicateToken}`,/retired format/],
      ['fragment twice','participant.html',`?pool=it-pool#invite=${LEGACY_INVITE}&invite=${duplicateToken}`,/retired format/],
      ['ambiguous targets',JOIN_PATH,`?entry=${ENTRY_TWO}`,/not valid/]
    ]){
      const world=liveWorld({owners:{[ENTRY_TWO]:'player@example.test'},invites:{[ENTRY_ONE]:{email:'player@example.test'}}});
      const {page,seen}=await openPage({world,signedInAs:'player@example.test',path,query});
      for(const round of ['opened','signed in again']){
        await page.locator('#entryCard').waitFor({state:'visible'});
        await page.locator('#sessionError').waitFor({state:'visible'});
        assert.match(await page.textContent('#sessionError'),copy,`${label}, ${round}`);
        assert.match(await page.textContent('#sessionError'),/Ask your commissioner for a new invitation link\.$/,`${label}, ${round}`);
        await visible(page,{signOut:true,pickForm:true,authCard:false,emptyCard:false});
        assert.equal(page.url(),`${base}/participant.html?pool=it-pool`,`${label}, ${round}`);
        if(round==='opened'){
          await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
          await signIn(page,'player@example.test');
        }
      }
      assert.deepEqual(world.calls.filter(c=>c.name===CLAIM_INVITE),[],`${label}: no claim was sent`);
      assert.deepEqual(world.calls.map(c=>c.name),[LIST_PARTICIPANT_POOLS,PARTICIPANT_CONTEXT,LIST_PARTICIPANT_POOLS,PARTICIPANT_CONTEXT],label);
      assert.equal(Object.values(world.invites).some(invite=>invite.claimedBy),false,label);
      for(const legacyToken of [LEGACY_INVITE,duplicateToken]){
        await inviteContained(page,world,seen,{legacyToken});
        assert.equal(seen.requests.some(request=>JSON.stringify(request.headers).includes(legacyToken)),false,label);
      }
      await clean(page,seen);
    }
    // Signed out, the refusal shows beside the sign-in card at once and again after sign-in.
    const world=liveWorld({invites:{[ENTRY_ONE]:{email:'invited@example.test'}}});
    const {page,seen}=await openPage({world,query:`?pool=it-pool&invite=${LEGACY_INVITE}`});
    await page.locator('#authCard').waitFor({state:'visible'});
    assert.match(await page.textContent('#sessionError'),/retired format/);
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    await signIn(page,'invited@example.test');
    await page.locator('#emptyCard').waitFor({state:'visible'});
    assert.match(await page.textContent('#sessionError'),/retired format/);
    assert.deepEqual(world.calls.map(c=>c.name),[LIST_PARTICIPANT_POOLS]);
    await inviteContained(page,world,seen,{legacyToken:LEGACY_INVITE});
    await clean(page,seen);
  });

  test('live: signing out while a claim, context load, submit or post-submit reload is in flight leaves nothing of that account on screen',async()=>{
    const signedOut={authCard:true,signOut:false,sessionError:false,entryCard:false,pickForm:false,emptyCard:false,submittedCard:false};
    // A claim that will fail, then the context load, each still in flight when Sign out finishes.
    for(const [name,reject] of [[CLAIM_INVITE,false],[PARTICIPANT_CONTEXT,false],[PARTICIPANT_CONTEXT,true]]){
      const world=liveWorld({owners:{[ENTRY_TWO]:'wrong@example.test'},invites:{[ENTRY_ONE]:{email:'invited@example.test'}}});
      const held=gate(world,name);
      const {page,seen}=await openPage({world,signedInAs:'wrong@example.test',path:JOIN_PATH});
      await held.arrived;
      await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
      if(reject)world.participantContextFailure='week_not_found';
      const reply=page.waitForResponse(response=>response.url().endsWith(`/rpc/${name}`));
      held.release();await reply;await settle(page);
      await visible(page,signedOut);
      assert.equal(await page.textContent('#sessionError'),'',name);
      if(name===CLAIM_INVITE)assert.deepEqual(world.calls.map(call=>call.name),[CLAIM_INVITE],'no account data is requested after sign-out');
      await clean(page,seen);
    }
    // A claim error that lands while Sign out itself is still finishing is cleared with everything else.
    {
      const world=liveWorld({invites:{[ENTRY_ONE]:{email:'invited@example.test'}}});
      const held=gate(world,CLAIM_INVITE);
      const {page,seen}=await openPage({world,signedInAs:'wrong@example.test',path:JOIN_PATH});
      await held.arrived;
      await page.evaluate(()=>{window.__signOutGate=new Promise(resolve=>{window.__finishSignOut=resolve})});
      await page.click('#signOut');
      const reply=page.waitForResponse(response=>response.url().endsWith('/rpc/'+CLAIM_INVITE));
      held.release();await reply;
      await page.locator('#sessionError').waitFor({state:'visible'});
      await page.evaluate(()=>window.__finishSignOut());
      await page.locator('#authCard').waitFor({state:'visible'});await settle(page);
      await visible(page,signedOut);
      await clean(page,seen);
    }
    // A submit, then the reload that follows it.
    for(const [name,skip] of [['pool_platform_submit_entry',0],[PARTICIPANT_CONTEXT,1]]){
      const world=liveWorld({owners:{[ENTRY_ONE]:'player@example.test'}});
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
    for(const [fallback,readable] of [[false,[]],[true,[]],[true,['loner@example.test']]]){
      const world=liveWorld({readable});
      if(fallback)world.authRequired={[LIST_PARTICIPANT_POOLS]:2};
      const {page,seen}=await openPage({world,signedInAs:'loner@example.test',query:fallback?'?pool=it-pool':''});
      await page.locator('#emptyCard').waitFor({state:'visible'});
      await visible(page,{signOut:true,authCard:false,entryCard:false,pickForm:false,sessionError:false});
      assert.deepEqual(world.calls.map(c=>c.name),fallback?[LIST_PARTICIPANT_POOLS,LIST_PARTICIPANT_POOLS,PARTICIPANT_CONTEXT]:[LIST_PARTICIPANT_POOLS]);
      await page.click('#signOut');
      await page.locator('#authCard').waitFor({state:'visible'});
      await visible(page,{signOut:false,emptyCard:false});
      await clean(page,seen);
    }
  });

  test('live: a normal multi-entry participant keeps Sign out in the shell; labels and tiebreak render as text; picks submit',async()=>{
    const world=liveWorld({owners:{[ENTRY_ONE]:'player@example.test',[ENTRY_TWO]:'player@example.test'},games:[
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
    for(const [i,[typed,expected]] of [['47',47],['0',0]].entries()){
      await page.fill('#tiebreak',typed);
      await submitPick(page,i?'Picks updated':'Picks saved');
      assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_submit_entry').at(-1).args,
        {p_week_id:WEEK_ID,p_entry_id:ENTRY_ONE,p_source:'participant',p_payload:{picks:{g1:'away',g2:'home'},tiebreak:expected}});
      assert.equal(await page.inputValue('#tiebreak'),typed);
      assert.equal(world.entries[0].submission.revision,i+1);
      await visible(page,{signOut:true});
    }
    await page.fill('#tiebreak','');await page.click('#submitBtn');
    assert.match(await page.textContent('#validation'),/valid tiebreak/);
    assert.equal(world.calls.filter(c=>c.name==='pool_platform_submit_entry').length,2,'a blank tiebreak is never sent as 0');
    await clean(page,seen);
  });

  // Survivor schedule with two "New York" teams, two teams whose labels differ only in case (one key is markup),
  // a markup label, and two "Los Angeles" teams, one with a long key that has no break opportunity. Entry E02
  // already used NYG in another week.
  const HOSTILE_KEY='<img src=x onerror="window.__xss=(window.__xss||0)+2">',LONG_KEY='LONGUNBROKENSTABLETEAMKEY00001';
  const SURVIVOR_GAMES=[
    {id:'g1',away:{key:'NYG',label:'New York'},home:{key:'DAL',label:'Dallas'}},
    {id:'g2',away:{key:'MIA',label:'Miami'},home:{key:'NYJ',label:'New York'}},
    {id:'g3',away:{key:HOSTILE_KEY,label:'Twin City'},home:{key:'TWC',label:'twin city'}},
    {id:'g4',away:{key:'ATX',label:'Austin'},home:{key:'ARL',label:HOSTILE_LABEL}},
    {id:'g5',away:{key:LONG_KEY,label:'Los Angeles'},home:{key:'LAX',label:'Los Angeles'}}
  ];
  const SURVIVOR_LABELS=['New York (NYG)','Dallas','Miami','New York (NYJ)',`Twin City (${HOSTILE_KEY})`,'twin city (TWC)','Austin',HOSTILE_LABEL,`Los Angeles (${LONG_KEY})`,'Los Angeles (LAX)'];
  const survivorWorld=()=>{
    const world=liveWorld({owners:{[ENTRY_ONE]:'player@example.test',[ENTRY_TWO]:'player@example.test'},games:SURVIVOR_GAMES,poolType:'survivor'});
    world.entries[1].history=[{week:2,source:'participant',status:'submitted',payload:{team:'NYG'},revision:1}];
    return world;
  };
  const survivorLabels=page=>page.locator('#games label').allTextContents();
  const survivorInputs=page=>page.locator('#games input[name="survivor-team"]').evaluateAll(inputs=>inputs.map(input=>[input.value,input.disabled]));

  test('live Survivor: teams that share a label show their keys as text, a used one stays locked, and the chosen key is submitted',async()=>{
    const world=survivorWorld(),submitted=()=>world.calls.filter(c=>c.name==='pool_platform_submit_entry').at(-1).args;
    const {page,seen}=await openPage({world,signedInAs:'player@example.test'});
    await page.locator('#pickForm').waitFor({state:'visible'});
    const labels=await survivorLabels(page);
    assert.deepEqual(labels,SURVIVOR_LABELS);
    assert.equal(new Set(labels).size,labels.length,'no two choices read alike');
    assert.deepEqual(await survivorInputs(page),SURVIVOR_GAMES.flatMap(g=>[[g.away.key,false],[g.home.key,false]]),'each choice submits its stable key');
    assert.equal(await page.locator('label[for="team-4"]').innerHTML(),textAsHtml(`Twin City (${HOSTILE_KEY})`),'a markup key is text');
    assert.equal(await page.locator('label[for="team-7"]').innerHTML(),textAsHtml(HOSTILE_LABEL),'a markup label is text');

    await page.click('label[for="team-3"]');
    assert.equal(await page.locator('#summary .summary-row strong').textContent(),'New York (NYJ)');
    await submitPick(page,'Survivor pick saved');
    assert.deepEqual(submitted(),{p_week_id:WEEK_ID,p_entry_id:ENTRY_ONE,p_source:'participant',p_payload:{team:'NYJ'}});
    await page.click('label[for="team-4"]');
    assert.equal(await page.locator('#summary .summary-row strong').textContent(),`Twin City (${HOSTILE_KEY})`);
    await submitPick(page,'Survivor pick updated');
    assert.deepEqual(submitted().p_payload,{team:HOSTILE_KEY},'the markup key round-trips exactly');
    assert.equal(world.entries[0].submission.revision,2);

    await page.selectOption('#entrySelect',ENTRY_TWO);
    assert.deepEqual(await survivorLabels(page),['New York (NYG) · USED',...SURVIVOR_LABELS.slice(1)]);
    assert.deepEqual((await survivorInputs(page)).slice(0,4),[['NYG',true],['DAL',false],['MIA',false],['NYJ',false]]);
    await page.click('label[for="team-3"]');await submitPick(page,'Survivor pick saved');
    assert.deepEqual(submitted(),{p_week_id:WEEK_ID,p_entry_id:ENTRY_TWO,p_source:'participant',p_payload:{team:'NYJ'}});
    assert.equal(world.entries[1].submission.revision,1);
    await clean(page,seen);
  });

  test('mobile widths: no horizontal overflow and Sign out stays on screen in every signed-in state',async()=>{
    for(const width of [320,360,375,384,390,412]){
      const states=[
        {world:liveWorld({invites:{[ENTRY_ONE]:{email:'invited@example.test'}}}),signedInAs:'wrong@example.test',path:JOIN_PATH,ready:'#sessionError'},
        {world:liveWorld(),signedInAs:'loner@example.test',ready:'#emptyCard'},
        {world:liveWorld({owners:{[ENTRY_ONE]:'player@example.test'}}),signedInAs:'player@example.test',ready:'#pickForm'},
        {world:survivorWorld(),signedInAs:'player@example.test',ready:'#pickForm',survivor:true}
      ];
      for(const {ready,survivor,...options} of states){
        const {page,seen}=await openPage({...options,width,height:740});
        await page.locator(ready).waitFor({state:'visible'});
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
        assert.ok(overflow<=0,`${width}px ${ready}${survivor?' Survivor':''}: horizontal overflow ${overflow}px`);
        const box=await page.locator('#signOut').boundingBox();
        assert.ok(box&&box.x>=0&&box.x+box.width<=width&&box.height>=44,`${width}px ${ready}: Sign out box ${JSON.stringify(box)}`);
        if(survivor){
          assert.deepEqual(await survivorLabels(page),SURVIVOR_LABELS,`${width}px`);
          // Each choice's text, not only its box, stays inside the choice and on screen; so does the review
          // summary once the long-key team is picked.
          await page.click('label[for="team-8"]');
          const boxes=await page.evaluate(()=>[...document.querySelectorAll('#games label'),document.querySelector('#summary .summary-row strong')].map(el=>{
            const range=document.createRange();range.selectNodeContents(el);
            const box=el.getBoundingClientRect(),text=range.getBoundingClientRect();
            return{text:el.textContent.slice(0,24),left:box.left,right:box.right,height:box.height,textLeft:text.left,textRight:text.right};
          }));
          assert.equal(boxes.at(-1).text,`Los Angeles (${LONG_KEY})`.slice(0,24));
          for(const b of boxes){
            assert.ok(b.left>=0&&b.right<=width&&b.textLeft>=b.left&&b.textRight<=b.right,`${width}px Survivor text off screen or outside its box ${JSON.stringify(b)}`);
          }
          for(const b of boxes.slice(0,-1))assert.ok(b.height>=44,`${width}px Survivor choice under 44px ${JSON.stringify(b)}`);
          const after=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
          assert.ok(after<=0,`${width}px Survivor with the long-key team picked: horizontal overflow ${after}px`);
        }
        await clean(page,seen);
        await page.context().close();
      }
      const {page,seen}=await openPage({width,height:740});
      await page.locator('#pickForm').waitFor({state:'visible'});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),`${width}px sandbox pick form overflows`);
      await clean(page,seen);
      await page.context().close();
    }
  });

  const openConsole=options=>openPage({path:'commissioner.html',...options});
  const IMPORT_CSV='entry_code,g1,g2,tiebreak\nE01,away,home,47\nE02,home,away,41';
  const signedOutConsole={authCard:true,signOut:false,sessionError:false,otpWrap:false,consoleCard:false,entriesCard:false,inviteCard:false,importCard:false,importPreview:false,poolPickerCard:false};
  const openCsv=async page=>{
    const summary=page.locator('#advancedImport:not([open]) > summary');
    if(await summary.count())await summary.click();
  };
  const previewAndConfirm=async(page,csv=IMPORT_CSV)=>{
    await openCsv(page);
    await page.fill('#importText',csv);await page.click('#runImport');
    await page.locator('#importPreview').waitFor({state:'visible'});
    await page.click('#confirmImport');
  };
  const noManagedPools=async page=>{
    await page.locator('#poolPickerError',{hasText:NO_MANAGED_POOLS}).waitFor({state:'visible'});
    assert.equal(await page.locator('#authorizedPoolSelect option').count(),0,'no tenant or pool names disclosed');
  };
  // Nothing a commissioner session loaded or typed may stay in the page, shown or hidden, once it signs out.
  // The sign-in fields are checked only while signed out: afterwards they hold the next account's own input.
  const noConsoleLeft=async(page,label,{signedOut=true}={})=>{
    const html=await page.content();
    for(const marker of ['Private Console Pool','Entry E01','Entry E02',ENTRY_ONE,ENTRY_TWO,'Week 1 ·']){
      assert.equal(html.includes(marker),false,`${label}: "${marker}" is still in the page`);
    }
    for(const id of ['inviteEmail','inviteLink','csvFile','importText',...(signedOut?['email','otp']:[])]){
      assert.equal(await page.inputValue(`#${id}`),'',`${label}: #${id} still has a value`);
    }
    assert.equal(await page.textContent('#poolName'),'Pool',label);
    assert.equal(await page.getAttribute('#importText','placeholder'),'',label);
    assert.equal(await page.textContent('#previewHelp'),'',label);
  };

  test('commissioner live: an account that manages no pool sees a private picker with Sign out, then switches to the commissioner',async()=>{
    const world=consoleWorld();
    const {page,seen}=await openConsole({world,signedInAs:'player@example.test'});
    await noManagedPools(page);
    await visible(page,{signOut:true,authCard:false,consoleCard:false,entriesCard:false,inviteCard:false,importCard:false});
    await page.fill('#poolCode',POOL_SLUG);await page.click('#openPool');
    await page.locator('#poolPickerError',{hasText:'You do not have access to manage this pool.'}).waitFor({state:'visible'});
    await visible(page,{signOut:true,consoleCard:false,entriesCard:false,inviteCard:false,importCard:false});
    assert.equal(await page.locator('section #signOut').count(),0,'Sign out is not inside any card');
    await page.click('#signOut');
    await page.locator('#authCard').waitFor({state:'visible'});
    await visible(page,signedOutConsole);
    assert.equal(await page.evaluate(()=>window.__fakeAuth.email),null,'the session ended');
    await signIn(page,'commish@example.test');
    await page.locator('#importCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,authCard:false,sessionError:false,consoleCard:true,entriesCard:true,inviteCard:true});
    assert.equal(await page.textContent('#poolName'),'Private Console Pool');
    assert.deepEqual(world.calls.map(c=>[c.name,c.email,c.args]),[
      [LIST_COMMISSIONER_POOLS,'player@example.test',{}],
      [COMMISSIONER_CONTEXT,'player@example.test',{p_pool_slug:POOL_SLUG}],
      [LIST_COMMISSIONER_POOLS,'commish@example.test',{}],
      [COMMISSIONER_CONTEXT,'commish@example.test',{p_pool_slug:POOL_SLUG}]
    ]);
    await clean(page,seen);
  });

  test('commissioner live: a missing pool slug, an unknown pool and a failed context load each leave a working Sign out',async()=>{
    const additionalPools=[{slug:'other-pool',display_name:'Other Authorized Pool',pool_type:'survivor',status:'active'}];
    const cases=[
      ['no pool slug',{poolSlug:''},{additionalPools},null,/Enter the pool code/],
      ['unknown pool',{query:'?pool=no-such-pool'},{additionalPools},'no-such-pool',/You do not have access to manage this pool/],
      ['server error',{},{contextFailure:'http'},POOL_SLUG,/The request could not be completed/],
      ['dropped connection',{},{contextFailure:'network'},POOL_SLUG,/The request could not be completed/]
    ];
    for(const [label,options,worldOptions,slug,message] of cases){
      const world=consoleWorld(worldOptions);
      const {page,seen}=await openConsole({world,signedInAs:'commish@example.test',...options});
      await page.locator('#poolPickerCard').waitFor({state:'visible'});
      if(additionalPools===worldOptions.additionalPools)await page.click('#openPool');
      await page.locator('#poolPickerError').waitFor({state:'visible'});
      assert.match(await page.textContent('#poolPickerError'),message,label);
      await visible(page,{signOut:true,authCard:false,consoleCard:false,importCard:false});
      assert.deepEqual(world.calls.map(c=>[c.name,c.args]),[
        [LIST_COMMISSIONER_POOLS,{}],...(slug?[[COMMISSIONER_CONTEXT,{p_pool_slug:slug}]]:[])
      ],label);
      await page.click('#signOut');
      await page.locator('#authCard').waitFor({state:'visible'});
      await visible(page,signedOutConsole);
      await clean(page,seen);
    }
  });

  test('commissioner live: a failed sign out is reported beside Sign out and can be retried',async()=>{
    const {page,seen}=await openConsole({world:consoleWorld(),signedInAs:'player@example.test'});
    await noManagedPools(page);
    await page.evaluate(()=>{window.__signOutGate=Promise.reject(new Error('Sign-out service unavailable.'));window.__signOutGate.catch(()=>{})});
    await page.click('#signOut');
    await page.locator('#sessionError',{hasText:REQUEST_FAILED}).waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.__fakeAuth.email),'player@example.test','a rejected sign-out retains the session');
    await visible(page,{signOut:true,authCard:false});
    await page.evaluate(()=>{window.__signOutGate=null});
    await page.click('#signOut');
    await page.locator('#authCard').waitFor({state:'visible'});
    await visible(page,signedOutConsole);
    await clean(page,seen);
  });

  test('commissioner live: signing out while the context load, an invite, an import or the post-import reload is in flight leaves nothing of that account on screen',async()=>{
    const createInvite=async page=>{await page.fill('#inviteEmail','invitee@example.test');await page.click('#createInvite')};
    for(const [name,skip,act] of [
      [COMMISSIONER_CONTEXT,0,null],
      [CREATE_INVITE,0,createInvite],
      ['pool_platform_submit_batch',0,previewAndConfirm],
      [COMMISSIONER_CONTEXT,1,previewAndConfirm]
    ]){
      const world=consoleWorld(),held=gate(world,name,skip),label=`${name} #${skip+1}`;
      const {page,seen}=await openConsole({world,signedInAs:'commish@example.test'});
      if(act){await page.locator('#importCard').waitFor({state:'visible'});await act(page)}
      await held.arrived;
      await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
      const reply=page.waitForResponse(response=>response.url().endsWith(`/rpc/${name}`));
      held.release();await reply;await settle(page);
      await visible(page,signedOutConsole);
      await visible(page,{inviteResult:false,importError:false,importResult:false});
      await noConsoleLeft(page,`${label}, signed out`);
      // The next account sees only its own state: here it manages no pool.
      await signIn(page,'player@example.test');
      await noManagedPools(page);
      await visible(page,{signOut:true,consoleCard:false,importCard:false,importPreview:false,inviteResult:false,importResult:false});
      await noConsoleLeft(page,`${label}, next account`,{signedOut:false});
      await clean(page,seen);
    }
  });

  test('commissioner live: Sign out clears the loaded console, invite link, typed CSV and import results before the next account signs in',async()=>{
    const world=consoleWorld();
    const {page,seen}=await openConsole({world,signedInAs:'commish@example.test'});
    await page.locator('#importCard').waitFor({state:'visible'});
    assert.equal(await page.textContent('#poolName'),'Private Console Pool');
    await page.fill('#inviteEmail','invitee@example.test');await page.click('#createInvite');
    await page.locator('#inviteResult').waitFor({state:'visible'});
    assert.match(await page.textContent('#inviteResult'),/Invitation ready for invitee@example\.test.*verified email.*Expires/);
    assert.equal(await page.inputValue('#inviteLink'),base+JOIN_PATH);
    const reloaded=page.waitForResponse(response=>response.url().endsWith('/rpc/'+COMMISSIONER_CONTEXT));
    await previewAndConfirm(page);
    await page.locator('#importResult').waitFor({state:'visible'});
    assert.equal(await page.textContent('#importResult'),'2 picks saved. ');
    await reloaded;await settle(page);
    assert.deepEqual(world.calls.find(c=>c.name==='pool_platform_submit_batch').args.p_items.map(item=>item.entry_id),[ENTRY_ONE,ENTRY_TWO]);
    await page.evaluate(()=>{
      File.prototype.text=()=>new Promise(resolve=>{window.__finishCsv=resolve});
    });
    const csv='entry_code,g1,g2,tiebreak\nE01,home,home,30';
    await page.fill('#importText',csv);
    await page.locator('#csvFile').setInputFiles({name:'private-picks.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await page.waitForFunction(()=>typeof window.__finishCsv==='function');
    await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
    await page.evaluate(()=>window.__finishCsv('a file from the previous account'));
    await settle(page);
    await visible(page,signedOutConsole);
    await visible(page,{inviteResult:false,importError:false,importResult:false});
    await noConsoleLeft(page,'signed out');
    await signIn(page,'player@example.test');
    await noManagedPools(page);
    await noConsoleLeft(page,'next account',{signedOut:false});
    await clean(page,seen);
  });

  test('commissioner live → participant: a token-free link contains only the pool and entry, and requires the verified recipient to claim it',async()=>{
    const world=consoleWorld();
    const {page:consolePage,seen:consoleSeen}=await openConsole({world,signedInAs:'commish@example.test'});
    await consolePage.locator('#importCard').waitFor({state:'visible'});
    await consolePage.click('#createInvite');
    await consolePage.locator('#inviteError',{hasText:'Enter the participant’s email address'}).waitFor();
    assert.equal(world.calls.some(c=>c.name===CREATE_INVITE),false,'a recipient is mandatory');
    await consolePage.fill('#inviteEmail','Invited@Example.test');
    await consolePage.click('#createInvite');
    await consolePage.locator('#inviteResult').waitFor({state:'visible'});
    const link=new URL(await consolePage.inputValue('#inviteLink'));
    assert.equal(link.href,base+JOIN_PATH);
    assert.equal(link.search+link.hash,'');
    assert.equal(consolePage.url(),`${base}/commissioner.html?pool=it-pool`,'the commissioner page URL never holds an invitation');
    assert.deepEqual(world.calls.filter(c=>c.name===CREATE_INVITE).map(c=>c.args),
      [{p_entry_id:ENTRY_ONE,p_email:'invited@example.test',p_expires_hours:168}]);
    await clean(consolePage,consoleSeen);
    // The participant opens exactly that link.
    const {page,seen}=await openPage({world,signedInAs:'invited@example.test',path:link.pathname});
    await page.locator('#entryCard').waitFor({state:'visible'});
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    assert.deepEqual(world.calls.filter(c=>c.name===CLAIM_INVITE).map(c=>[c.email,c.args]),[['invited@example.test',{p_entry_id:ENTRY_ONE}]]);
    await inviteContained(page,world,seen);
    await clean(page,seen);
  });

  test('commissioner live: an ambiguous entry code and a repeated entry are listed row by row and nothing is submitted',async()=>{
    const world=consoleWorld();
    world.console.seasons[0].entries.push(...['Fox1','FOX1'].map((entry_code,i)=>({id:`entry-f${i+1}`,entry_code,display_name:`Entry ${entry_code}`,status:'active',claimed:false,submissions:[]})));
    const {page,seen}=await openConsole({world,signedInAs:'commish@example.test'});
    await page.locator('#importCard').waitFor({state:'visible'});
    await openCsv(page);
    await page.fill('#importText','entry_code,g1,g2,tiebreak\nE01,away,home,47\nfox1,home,away,41\ne01,home,home,30\nFOX1,away,away,20');
    await page.click('#runImport');
    await page.locator('#importPreview').waitFor({state:'visible'});
    assert.equal(await page.textContent('#importError'),'2 problem(s) found. No picks were saved. Correct them and preview again.');
    assert.deepEqual(await page.locator('#resultBody tr').evaluateAll(rows=>rows.slice(0,2).map(row=>[...row.cells].map(cell=>cell.textContent))),[
      ['Row 3 · fox1','ambiguous_entry_code · matches entry codes Fox1 and FOX1 · type the entry code exactly as listed'],
      ['Row 4 · E01','duplicate_entry_row · entry E01 is already on row 2; keep one row per entry']
    ]);
    assert.equal(await page.locator('#confirmImport').isDisabled(),true,'no pick may be confirmed with an invalid row');
    assert.equal(world.calls.filter(c=>c.name==='pool_platform_submit_batch').length,0,'no row is submitted while any row is rejected');
    await clean(page,seen);
  });

  test('commissioner sandbox: the synthetic console loads without Sign out and a sample import still reports its conflict',async()=>{
    const {page,seen}=await openConsole();
    await page.locator('#importCard').waitFor({state:'visible'});
    assert.equal(await page.textContent('#modePill'),'Local preview');
    await visible(page,{signOut:false,authCard:false,sessionError:false,consoleCard:true});
    await openCsv(page);
    await page.click('#sampleImport');
    const allowed=await page.inputValue('#importText');
    // A player pick blocks confirmation for the entire preview, including the eligible entry.
    await page.fill('#importText',`${allowed}\nE01,away,home,47`);
    await page.click('#runImport');
    await page.locator('#importPreview').waitFor({state:'visible'});
    assert.match(await page.textContent('#resultBody'),/A pick was already submitted using a different method\. It will not be changed\./);
    assert.equal(await page.locator('#confirmImport').isDisabled(),true);
    assert.equal(await page.locator('#entriesBody tr').first().locator('td').last().textContent(),'Submitted by player');
    await page.fill('#importText',allowed);await page.click('#runImport');
    assert.match(await page.textContent('#previewHelp'),/never a player-submitted pick/);
    await page.click('#confirmImport');
    await page.locator('#importResult').waitFor({state:'visible'});
    assert.match(await page.textContent('#importResult'),/^1 pick saved\./);
    assert.equal(await page.locator('#entriesBody tr').first().locator('td').last().textContent(),'Submitted by player');
    await clean(page,seen);
  });

  test('commissioner mobile widths: no horizontal overflow, and Sign out stays on screen and works in the error and console states',async()=>{
    for(const width of [320,360,384,412]){
      for(const [signedInAs,ready] of [[null,'#authCard'],['player@example.test','#poolPickerError'],['commish@example.test','#importCard']]){
        const {page,seen}=await openConsole({world:consoleWorld(),signedInAs,width,height:740}),state=`${width}px ${ready}`;
        await page.locator(ready).waitFor({state:'visible'});
        const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
        const before=await overflow();
        assert.ok(before<=0,`${state}: horizontal overflow ${before}px`);
        if(signedInAs){
          const box=await page.locator('#signOut').boundingBox();
          assert.ok(box&&box.x>=0&&box.x+box.width<=width&&box.height>=44,`${state}: Sign out box ${JSON.stringify(box)}`);
          await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
          await visible(page,signedOutConsole);
          const after=await overflow();
          assert.ok(after<=0,`${state} after sign out: horizontal overflow ${after}px`);
        }else assert.equal(await page.isVisible('#signOut'),false,state);
        await clean(page,seen);
        await page.context().close();
      }
    }
  });

  test('live: an RPC answered auth_required is resent once, unchanged, about 200 ms later; a second auth_required shows the sign-in message and nothing more is sent',async()=>{
    const same=(first,second,label)=>{
      for(const key of ['method','url','body'])assert.equal(second[key],first[key],`${label}: ${key}`);
      assert.deepEqual(second.headers,first.headers,`${label}: headers, bearer token included`);
      const gap=second.at-first.at;
      assert.ok(gap>=190&&gap<1500,`${label}: resent after ${gap} ms`);
    };
    const calls=(world,name)=>world.calls.filter(c=>c.name===name);
    // The context load answers auth_required once: the resent request loads the entry.
    {
      const world=liveWorld({owners:{[ENTRY_ONE]:'player@example.test'}});world.authRequired={pool_platform_participant_context:1};
      const {page,seen}=await openPage({world,signedInAs:'player@example.test'});
      await page.locator('#pickForm').waitFor({state:'visible'});
      const loads=calls(world,'pool_platform_participant_context');
      assert.equal(loads.length,2);same(loads[0],loads[1],'context');
      await visible(page,{sessionError:false,entryCard:true,signOut:true});
      await clean(page,seen);
    }
    // A submit answers auth_required once: the first request did nothing, the resent one saves exactly once.
    {
      const world=liveWorld({owners:{[ENTRY_ONE]:'player@example.test'}});
      const {page,seen}=await openPage({world,signedInAs:'player@example.test'});
      await page.locator('#pickForm').waitFor({state:'visible'});
      world.authRequired={pool_platform_submit_entry:1};
      await pickAll(page,['away','home']);await page.fill('#tiebreak','47');
      await submitPick(page,'Picks saved');
      const submits=calls(world,'pool_platform_submit_entry');
      assert.equal(submits.length,2);same(submits[0],submits[1],'submit');
      assert.equal(world.entries[0].submission.revision,1);
      await visible(page,{validation:false,sessionError:false});
      await clean(page,seen);
    }
    // auth_required twice: two requests, a safe pool picker, and no third request although it would succeed.
    {
      const world=liveWorld({owners:{[ENTRY_ONE]:'player@example.test'}});world.authRequired={pool_platform_participant_context:2};
      const {page,seen}=await openPage({world,signedInAs:'player@example.test'});
      await page.locator('#poolPickerError',{hasText:'This pool cannot be opened right now.'}).waitFor({state:'visible'});
      await page.waitForTimeout(600);
      const loads=calls(world,'pool_platform_participant_context');
      assert.equal(loads.length,2,'no third request');same(loads[0],loads[1],'context twice');
      await visible(page,{signOut:true,entryCard:false,pickForm:false,authCard:false});
      await clean(page,seen);
    }
  });

  test('a page that cannot load platform-config.js (offline, or missing) says so and shows neither the sandbox nor a sign-in',async()=>{
    for(const path of ['participant.html','commissioner.html']){
      for(const failure of ['internetdisconnected','missing']){
        const context=await browser.newContext({serviceWorkers:'block'});contexts.push(context);
        const page=await context.newPage(),errors=[],label=`${path} ${failure}`;
        page.on('pageerror',error=>errors.push(error.message));
        await recordCsp(page);
        await page.route(`${base}/platform-config.js`,route=>failure==='missing'?route.fulfill({status:404,contentType:'text/plain',body:'not found'}):route.abort(failure));
        await page.goto(`${base}/${path}`);
        await page.locator('#sessionError').waitFor({state:'visible'});
        assert.equal(await page.textContent('#sessionError'),CONFIG_UNAVAILABLE,label);
        assert.match(await page.textContent('#modePill'),/^unavailable$/i,label);
        for(const id of ['authCard','signOut','entryCard','pickForm','emptyCard','consoleCard','entriesCard','importCard']){
          if(await page.locator(`#${id}`).count())assert.equal(await page.isVisible(`#${id}`),false,`${label}: #${id}`);
        }
        assert.equal(errors.length,1,`${label}: the failed configuration import is the only error`);
        assert.deepEqual(await page.evaluate(()=>window.__csp),[],label);
      }
    }
  });

  test('service worker: commercial scope, exactly the allow-list cached, the configuration never stored; offline the cached shell says so, and online a reload recovers',async()=>{
    const own=await serveDirectory(new URL('./',import.meta.url)),port=own.address().port,origin=`http://127.0.0.1:${port}`;
    const stop=()=>new Promise(resolve=>{own.close(()=>resolve());own.closeAllConnections()});
    try{
      const context=await browser.newContext();contexts.push(context);
      const page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await recordCsp(page);
      await page.goto(`${origin}/index.html`);
      const registration=await page.evaluate(async()=>{const r=await navigator.serviceWorker.ready;return{scope:r.scope,script:r.active.scriptURL,updateViaCache:r.updateViaCache}});
      assert.deepEqual(registration,{scope:`${origin}/`,script:`${origin}/service-worker.js`,updateViaCache:'none'});
      const cached=()=>page.evaluate(async()=>{
        const out={};for(const name of await caches.keys())out[name]=(await (await caches.open(name)).keys()).map(r=>r.url).sort();return out;
      });
      const listed=PRECACHE_FILES.map(asset=>`${origin}/${asset}`).sort();
      assert.deepEqual(await cached(),{'pool-platform-commercial-v5':listed});
      await page.goto(`${origin}/participant.html`);
      await page.locator('#pickForm').waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>navigator.serviceWorker.controller?.scriptURL),`${origin}/service-worker.js`);
      assert.deepEqual(await cached(),{'pool-platform-commercial-v5':listed},'loading the configuration stored nothing');
      // The host unreachable: the worker serves the page and its modules from cache, the configuration cannot load.
      await stop();
      await page.reload();
      await page.locator('#sessionError').waitFor({state:'visible'});
      assert.equal(await page.textContent('#sessionError'),CONFIG_UNAVAILABLE);
      assert.equal(await page.textContent('#modePill'),'UNAVAILABLE');
      assert.equal(await page.isVisible('#pickForm'),false,'nothing rendered from a cached configuration');
      // Reachable again: a reload recovers.
      await new Promise(resolve=>own.listen(port,'127.0.0.1',resolve));
      await page.reload();
      await page.locator('#pickForm').waitFor({state:'visible'});
      assert.equal(await page.textContent('#modePill'),'Local preview');
      assert.deepEqual(await cached(),{'pool-platform-commercial-v5':listed});
      assert.equal(errors.length,1,'only the offline configuration import failed');
      assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
    }finally{if(own.listening)await stop()}
  });

  test('service worker: legacy invite fragments stay off the host and token-free invitation routes stay out of Cache Storage',async()=>{
    const own=await serveDirectory(new URL('./',import.meta.url)),port=own.address().port,origin=`http://127.0.0.1:${port}`;
    const stop=()=>new Promise(resolve=>{own.close(()=>resolve());own.closeAllConnections()});
    try{
      const context=await browser.newContext();contexts.push(context);
      const page=await context.newPage(),errors=[],requests=[];
      page.on('pageerror',error=>errors.push(error.message));
      context.on('request',request=>requests.push(request.url())); // the page's requests and its worker's
      await recordCsp(page);
      await page.goto(`${origin}/index.html`);
      await page.evaluate(()=>navigator.serviceWorker.ready);
      await page.reload();
      assert.equal(await page.evaluate(()=>navigator.serviceWorker.controller?.scriptURL),`${origin}/service-worker.js`);
      const cached=()=>page.evaluate(async()=>{
        const out={};for(const name of await caches.keys())out[name]=(await (await caches.open(name)).keys()).map(r=>r.url).sort();return out;
      });
      const listed=PRECACHE_FILES.map(asset=>`${origin}/${asset}`).sort();
      // Each link is opened from another page, so it is a real navigation through the worker, with and without a query.
      for(const [link,scrubbed] of [[`${origin}/participant.html?pool=demo#invite=${LEGACY_INVITE}`,`${origin}/participant.html?pool=demo`],
        [`${origin}/participant.html#invite=${LEGACY_INVITE}`,`${origin}/participant.html`],
        [origin+JOIN_PATH,`${origin}/participant.html?pool=it-pool`]]){
        await page.goto(`${origin}/index.html`);
        await page.goto(link);
        await page.locator('#pickForm').waitFor({state:'visible'});
        assert.equal(page.url(),scrubbed);
      }
      assert.deepEqual(await cached(),{'pool-platform-commercial-v5':listed},'no invite link was stored');
      // The host unreachable: the worker serves the bare cached page, which scrubs the invite before its configuration
      // import fails.
      await page.goto(`${origin}/index.html`);
      await stop();
      await page.goto(`${origin}/participant.html#invite=${LEGACY_INVITE}`);
      await page.locator('#sessionError').waitFor({state:'visible'});
      assert.equal(await page.textContent('#sessionError'),CONFIG_UNAVAILABLE);
      assert.equal(page.url(),`${origin}/participant.html`);
      assert.deepEqual(await cached(),{'pool-platform-commercial-v5':listed});
      assert.equal(own.targets.some(target=>target.includes(LEGACY_INVITE)||target.includes('#')),false,JSON.stringify(own.targets));
      assert.ok(own.targets.includes('/participant.html?pool=demo')&&own.targets.includes('/participant.html')&&own.targets.includes(JOIN_PATH));
      assert.equal(requests.some(url=>url.includes(LEGACY_INVITE)||url.includes('#')),false,JSON.stringify(requests));
      assert.equal(errors.length,1,'only the offline configuration import failed');
      assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
    }finally{if(own.listening)await stop()}
  });

  // The legacy proxy server serves HTTP localhost. WebKit authenticates using Secure cookies in the HTTPS E2E suite.
  const SDK_HTTP_SESSION_SKIP=engine==='webkit'?'WebKit requires HTTPS for these Secure-cookie session checks':
    ESBUILD?false:'run npm ci in pool-platform to bundle the real SDK';

  test('real bundled SDK: a live build served by scripts/serve.mjs at localhost signs in far enough to send a code, through the same-origin Auth proxy only, under the production CSP',{skip:ESBUILD?false:'run npm ci in pool-platform to bundle the real SDK'},async()=>{
    const work=fs.mkdtempSync(path.join(os.tmpdir(),'pool-platform-live-')),dist=path.join(work,'dist');
    const UPSTREAM='https://ep-example-000000.neonauth.c-0.us-east-2.aws.neon.tech/neondb/auth',DATA='https://data.pool.test/neondb/rest/v1';
    // Stand-in Neon Auth behind the proxy: no session yet, and an Email OTP send that succeeds.
    const upstream=[];
    const upstreamFetch=async(url,init)=>{
      upstream.push({url,method:init.method,headers:Object.fromEntries(new Headers(init.headers)),body:init.body??null});
      const headers={'content-type':'application/json','access-control-allow-origin':'https://evil.example.test','access-control-allow-credentials':'true'};
      if(url===`${UPSTREAM}/email-otp/send-verification-otp`)return new Response('{"success":true}',{status:200,headers});
      return new Response('null',{status:200,headers});
    };
    try{
      await buildCommercialFrontend({outDir:dist,env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_DATA_URL:DATA,POOL_PLATFORM_DEFAULT_POOL_SLUG:'it-pool'}});
      const local=await startServer({dir:dist,port:0,log:()=>{},env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_AUTH_UPSTREAM_URL:UPSTREAM},upstreamFetch});
      const other=await serveDirectory(new URL('./',import.meta.url));
      try{
        assert.match(local.csp,/connect-src 'self' https:\/\/data\.pool\.test;/);
        assert.doesNotMatch(local.csp,/neonauth/);
        const context=await browser.newContext({serviceWorkers:'block'});contexts.push(context);
        const page=await context.newPage(),errors=[],requests=[],escaped=[],data=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('request',request=>requests.push({method:request.method(),url:request.url(),headers:request.headers()}));
        await recordCsp(page);
        // Anything that reached the network for a Neon Auth host or the Data API would be recorded here.
        await context.route(/neonauth/,route=>{escaped.push(route.request().url());return route.abort()});
        await context.route('https://data.pool.test/**',route=>{data.push(route.request().url());return route.abort()});
        await page.goto(`${local.url}participant.html`);
        await page.locator('#authCard').waitFor({state:'visible'});
        assert.equal(await page.evaluate(()=>location.hostname),'localhost');
        assert.equal(await page.textContent('#modePill'),'Connected');
        await page.fill('#email','Player@Example.test');await page.click('#sendCode');
        await page.locator('#otpWrap').waitFor({state:'visible'});
        assert.equal(await page.textContent('#authError'),'');
        const origin=new URL(local.url).origin;
        // Every request the page made stayed on its own origin; the Auth ones went only to the proxy's routes.
        assert.ok(requests.every(r=>new URL(r.url).origin===origin),JSON.stringify(requests.map(r=>r.url)));
        const auth=requests.filter(r=>new URL(r.url).pathname.startsWith('/api/auth'));
        assert.deepEqual(auth.map(r=>`${r.method} ${new URL(r.url).pathname}`),['GET /api/auth/get-session','POST /api/auth/email-otp/send-verification-otp']);
        const info=JSON.parse(auth[0].headers['x-neon-client-info']);
        assert.deepEqual([info.sdk,info.version,info.runtime],['@neondatabase/neon-js','0.7.0-beta','browser'],'the exact pinned SDK is what runs');
        // Chromium's own request headers passed the proxy's checks; Neon saw only the normalized body and this origin.
        assert.deepEqual(upstream.map(c=>[c.url,c.method,c.body,c.headers.origin,c.headers.cookie,c.headers['x-neon-client-info']]),
          [[`${UPSTREAM}/email-otp/send-verification-otp`,'POST','{"email":"player@example.test","type":"sign-in"}',origin,undefined,undefined]]);
        // The page cannot reach Neon Auth even when told to: the CSP refuses it before any request is made.
        const direct=await page.evaluate(async url=>{try{await fetch(url,{credentials:'include'});return 'reached'}catch{return 'blocked'}},`${UPSTREAM}/get-session`);
        assert.equal(direct,'blocked');
        assert.deepEqual(escaped,[],'no request to a Neon Auth host reached the network');
        assert.deepEqual(data,[]);
        assert.deepEqual(errors,[]);
        // The one report the SDK may cause: zod's eval feature probe (allowsEval: try { new F(""); } catch), which
        // finds eval blocked and keeps zod on its non-eval path. The deliberate direct fetch above adds exactly one
        // connect-src report. No other directive may be violated.
        const bundle=fs.readFileSync(path.join(dist,'vendor/neon-js.js'),'utf8').split('\n');
        const violations=await page.evaluate(()=>window.__csp);
        const connect=violations.filter(v=>v.startsWith('connect-src '));
        assert.deepEqual(connect.map(v=>v.split(' ')[1]),[`${UPSTREAM}/get-session`]);
        const rest=violations.filter(v=>!v.startsWith('connect-src '));
        assert.ok(rest.length<=1,JSON.stringify(rest));
        const probe=new RegExp(`^script-src eval ${`${local.url}vendor/neon-js.js`.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')}:(\\d+)$`);
        for(const violation of rest){
          const at=probe.exec(violation);
          assert.ok(at,violation);
          assert.equal(bundle[Number(at[1])-1].trim(),'new F("");',violation);
        }
        // Other origins cannot read the proxy: a cross-site page (127.0.0.1) and a same-site one on another port
        // (localhost:<other>) both get a network error, because no response carries CORS headers.
        const before=upstream.length;
        for(const foreign of [`http://127.0.0.1:${other.address().port}/index.html`,`http://localhost:${other.address().port}/index.html`]){
          const probePage=await context.newPage();
          await probePage.goto(foreign);
          const outcome=await probePage.evaluate(async target=>{
            const results={};
            for(const [name,init] of [['get',{credentials:'include'}],['post',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'}],
              ['simple-post',{method:'POST',credentials:'include',headers:{'content-type':'text/plain'},body:'{}'}]]){
              try{const r=await fetch(`${target}api/auth/${name==='get'?'get-session':'sign-out'}`,init);results[name]=`read ${r.status}`}catch{results[name]='blocked'}
            }
            return results;
          },local.url);
          assert.deepEqual(outcome,{get:'blocked',post:'blocked','simple-post':'blocked'},foreign);
          await probePage.close();
        }
        assert.equal(upstream.length,before,'nothing from another origin reached Neon');
      }finally{await local.close();await new Promise(resolve=>{other.close(()=>resolve());other.closeAllConnections()})}
    }finally{fs.rmSync(work,{recursive:true,force:true})}
  });

  test('real bundled SDK: signed in through the proxy and a stand-in Neon Auth, Chromium holds only the app\'s __Host- cookie, no script reads the session, the JWT is the Data API bearer, a planted duplicate fails closed, and sign-out deletes the cookie',{skip:SDK_HTTP_SESSION_SKIP},async()=>{
    const work=fs.mkdtempSync(path.join(os.tmpdir(),'pool-platform-cookie-')),dist=path.join(work,'dist');
    const UPSTREAM='https://ep-example-000000.neonauth.c-0.us-east-2.aws.neon.tech/neondb/auth',DATA='https://data.pool.test/neondb/rest/v1';
    // Synthetic shapes only. The stand-in answers like Neon's Better Auth: its own Partitioned, SameSite=None session
    // cookie, the opaque token in the body and in set-auth-token, the JWT in set-auth-jwt. It accepts one synthetic
    // code; no code is ever sent anywhere.
    const TOKEN='SynthSessTokenAbcdefghijklmn0123',SIGNED=`${TOKEN}.c3ludGhldGljLXNpZ25hdHVyZQ%3D%3D`,PLANTED='PlantedSessTokenZyxwvutsrq98765.cGxhbnRlZA%3D%3D';
    const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const JWT=`${b64({alg:'EdDSA',typ:'JWT'})}.${b64({sub:'user-1',role:'authenticated'})}.c2hhcGUtb25seS1zaWduYXR1cmU`;
    const USER={id:'user-1',email:'player@example.test',emailVerified:true,name:'Player'};
    const neonCookie=value=>`${UPSTREAM_SESSION_COOKIE}=${value}; Max-Age=${value?604800:0}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`;
    const upstream=[];
    const upstreamFetch=async(url,init)=>{
      const call={path:url.slice(UPSTREAM.length),cookie:new Headers(init.headers).get('cookie'),body:init.body??null};
      upstream.push(call);
      const headers=new Headers({'content-type':'application/json','access-control-allow-origin':'https://evil.example.test','access-control-allow-credentials':'true'});
      if(call.path==='/get-session'){
        if(call.cookie!==`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`)return new Response('null',{status:200,headers});
        headers.set('set-auth-jwt',JWT);headers.set('set-auth-token',TOKEN);headers.append('set-cookie',neonCookie(SIGNED));
        return new Response(JSON.stringify({session:{id:'sess-1',userId:'user-1',token:TOKEN,expiresAt:'2030-01-01T00:00:00.000Z'},user:USER}),{status:200,headers});
      }
      if(call.path==='/email-otp/send-verification-otp')return new Response('{"success":true}',{status:200,headers});
      if(call.path==='/sign-in/email-otp'){
        if(JSON.parse(call.body).otp!=='123456')return new Response('{"code":"INVALID_OTP","message":"Invalid OTP"}',{status:400,headers});
        headers.set('set-auth-token',TOKEN);headers.append('set-cookie',neonCookie(SIGNED));
        return new Response(JSON.stringify({token:TOKEN,user:USER}),{status:200,headers});
      }
      if(call.path==='/sign-out'){headers.append('set-cookie',neonCookie(''));return new Response('{"success":true}',{status:200,headers})}
      return new Response('{}',{status:404,headers});
    };
    // Another port of the same host. Cookies are not isolated by port, and __Host- cannot stop that host from adding a
    // second, Partitioned cookie of the same name, which Chromium then sends to the app beside the genuine one.
    const planter=http.createServer((req,res)=>{
      const cookie={'/plant':`${APP_SESSION_COOKIE}=${PLANTED}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
        '/unplant':`${APP_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None; Partitioned`}[req.url];
      res.writeHead(cookie?200:404,{'content-type':'text/plain; charset=utf-8',...(cookie?{'set-cookie':cookie}:{})}).end('planter');
    });
    await new Promise(resolve=>planter.listen(0,'127.0.0.1',resolve));
    try{
      await buildCommercialFrontend({outDir:dist,env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_DATA_URL:DATA,POOL_PLATFORM_DEFAULT_POOL_SLUG:'it-pool'}});
      const lines=[];
      const local=await startServer({dir:dist,port:0,log:line=>lines.push(line),env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_AUTH_UPSTREAM_URL:UPSTREAM},upstreamFetch});
      try{
        const origin=new URL(local.url).origin,plant=`http://localhost:${planter.address().port}`;
        const context=await browser.newContext({serviceWorkers:'block'});contexts.push(context);
        const page=await context.newPage(),errors=[],escaped=[],bearers=[],auth=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('response',response=>{
          const url=new URL(response.url());
          if(url.origin===origin&&url.pathname.startsWith('/api/auth/'))auth.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
        });
        await context.route(/neonauth/,route=>{escaped.push(route.request().url());return route.abort()});
        // The Data API (cross-origin): record the bearer each RPC carries and answer pool_not_found, the page's empty state.
        await context.route('https://data.pool.test/**',route=>{
          const request=route.request(),cors={'access-control-allow-origin':origin,'access-control-allow-headers':'authorization, content-type, accept','access-control-allow-methods':'POST'};
          if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
          bearers.push(request.headers().authorization??null);
          return route.fulfill({status:400,contentType:'application/json',headers:cors,body:'{"message":"pool_not_found"}'});
        });
        const sessionCookies=async()=>(await context.cookies()).filter(c=>c.name===APP_SESSION_COOKIE).map(c=>c.value).sort();
        await page.goto(`${local.url}participant.html`);
        await page.locator('#authCard').waitFor({state:'visible'});
        assert.deepEqual(await context.cookies(),[]);
        // 1. Sign in through the proxy.
        await page.fill('#email','player@example.test');await page.click('#sendCode');
        await page.locator('#otpWrap').waitFor({state:'visible'});
        await page.fill('#otp','123456');await page.click('#verifyCode');
        await page.locator('#emptyCard').waitFor({state:'visible'});
        assert.equal(await page.isVisible('#signOut'),true);
        // 2, 3. Exactly one cookie: the app's own, HttpOnly, Secure, SameSite=Strict, Path=/, host-only, not partitioned.
        // Neon's cookie name is never stored.
        const cookies=await context.cookies();
        assert.deepEqual(cookies.map(({name,value,domain,path,secure,httpOnly,sameSite,partitionKey})=>({name,value,domain,path,secure,httpOnly,sameSite,partitionKey})),
          [{name:APP_SESSION_COOKIE,value:SIGNED,domain:'localhost',path:'/',secure:true,httpOnly:true,sameSite:'Strict',partitionKey:undefined}]);
        assert.equal(cookies.some(c=>c.name===UPSTREAM_SESSION_COOKIE||c.name.includes('neon')),false);
        // 6, 7. What a script can read of the session: no cookie, no opaque token, no cookie value; only the JWT from
        // set-auth-jwt, which the SDK keeps.
        const seen=await page.evaluate(async()=>{const r=await fetch('/api/auth/get-session');return{status:r.status,headers:[...r.headers],body:await r.text(),cookie:document.cookie}});
        assert.equal(seen.status,200);
        assert.equal(seen.cookie,'');
        assert.equal(JSON.stringify(seen).includes(TOKEN),false,'neither the opaque token nor the cookie value, which begins with it');
        assert.deepEqual(seen.headers.filter(([name])=>['set-auth-jwt','set-auth-token','set-cookie'].includes(name)),[['set-auth-jwt',JWT]]);
        assert.deepEqual(Object.keys(JSON.parse(seen.body).session).sort(),['expiresAt','id','userId']);
        // 8. The Data API bearer is the JWT, never the opaque token.
        assert.ok(bearers.length>=1);
        assert.deepEqual([...new Set(bearers)],[`Bearer ${JWT}`]);
        // A reload stays signed in: the app cookie's value travels upstream under Neon's name.
        await page.reload();
        await page.locator('#emptyCard').waitFor({state:'visible'});
        assert.equal(upstream.filter(c=>c.path==='/get-session').at(-1).cookie,`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`);
        // 4. A planted duplicate: both cookies now reach the app, and the proxy uses neither. The page confirms no session
        // and shows the proxy's refusal (its get-session failure notice), a sign-out request is refused too, nothing
        // reaches Neon or the Data API, and no cookie is set or deleted.
        const planterPage=await context.newPage();
        await planterPage.goto(`${plant}/plant`);
        assert.deepEqual(await sessionCookies(),[PLANTED,SIGNED].sort());
        const [upstreamBefore,bearersBefore]=[upstream.length,bearers.length];
        await page.reload();
        await page.locator('#sessionError').waitFor({state:'visible'});
        assert.equal(await page.textContent('#sessionError'),'Sign-in could not be confirmed. Clear this site\'s cookies, then sign in again.');
        assert.equal(await page.isVisible('#signOut'),false,'signed in as neither');
        assert.equal(await page.isVisible('#emptyCard'),false);
        const refused=await page.evaluate(async()=>{const r=await fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});return{status:r.status,body:await r.text()}});
        assert.equal(refused.status,401);
        assert.equal(refused.body.includes(PLANTED.split('.')[0])||refused.body.includes(TOKEN),false);
        assert.deepEqual([upstream.length,bearers.length],[upstreamBefore,bearersBefore],'neither value reached Neon, and no RPC was made');
        assert.deepEqual(await sessionCookies(),[PLANTED,SIGNED].sort(),'nothing was set or deleted');
        // The planted cookie removed, the untouched genuine one is signed in again.
        await planterPage.goto(`${plant}/unplant`);
        await planterPage.close();
        assert.deepEqual(await sessionCookies(),[SIGNED]);
        await page.reload();
        await page.locator('#emptyCard').waitFor({state:'visible'});
        // 5. Sign-out deletes the app cookie, and Neon is asked under its own cookie name.
        await page.click('#signOut');
        await page.locator('#authCard').waitFor({state:'visible'});
        assert.deepEqual(await context.cookies(),[]);
        assert.deepEqual([upstream.at(-1).path,upstream.at(-1).cookie],['/sign-out',`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`]);
        const afterOut=upstream.length;
        await page.reload();
        await page.locator('#authCard').waitFor({state:'visible'});
        assert.equal(upstream.length,afterOut,'signed out: answered without asking Neon');
        // Over the whole run: Neon only ever saw its own session cookie with the genuine value, never the planted one.
        for(const call of upstream)assert.ok(call.cookie===null||call.cookie===`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`,JSON.stringify(call));
        assert.ok(auth.includes('GET /api/auth/get-session 401')&&auth.includes('POST /api/auth/sign-out 401'),JSON.stringify(auth));
        assert.deepEqual([...new Set(auth.map(entry=>entry.split(' ').slice(0,2).join(' ')))].sort(),
          ['GET /api/auth/get-session','POST /api/auth/email-otp/send-verification-otp','POST /api/auth/sign-in/email-otp','POST /api/auth/sign-out']);
        assert.ok(lines.includes('AUTH GET get-session 401 cookie-conflict')&&lines.includes('AUTH POST sign-out 401 cookie-conflict'));
        assert.equal(lines.some(line=>line.includes(TOKEN)||line.includes('Planted')||line.includes(JWT)),false);
        assert.deepEqual(escaped,[],'no request to a Neon Auth host reached the network');
        assert.deepEqual(errors,[]);
      }finally{await local.close()}
    }finally{
      await new Promise(resolve=>{planter.close(()=>resolve());planter.closeAllConnections()});
      fs.rmSync(work,{recursive:true,force:true});
    }
  });

  // The invite telemetry finding end to end: the real page, SDK, local server and Auth proxy core (the one the Netlify
  // functions mount), with stand-ins for Neon Auth and the Data API only.
  test('real bundled SDK: the same-origin Auth proxy signs in the verified recipient without an invite token, and the entry hint never reaches Auth, headers or browser storage',{skip:SDK_HTTP_SESSION_SKIP},async()=>{
    const work=fs.mkdtempSync(path.join(os.tmpdir(),'pool-platform-invite-')),dist=path.join(work,'dist');
    const UPSTREAM='https://ep-example-000000.neonauth.c-0.us-east-2.aws.neon.tech/neondb/auth',DATA='https://data.pool.test/neondb/rest/v1';
    // Synthetic shapes only, answered as in the cookie test above: one accepted code, one session.
    const TOKEN='SynthSessTokenAbcdefghijklmn0123',SIGNED=`${TOKEN}.c3ludGhldGljLXNpZ25hdHVyZQ%3D%3D`;
    const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const JWT=`${b64({alg:'EdDSA',typ:'JWT'})}.${b64({sub:'user-1',role:'authenticated'})}.c2hhcGUtb25seS1zaWduYXR1cmU`;
    const USER={id:'user-1',email:'invited@example.test',emailVerified:true,name:'Invited'};
    const neonCookie=value=>`${UPSTREAM_SESSION_COOKIE}=${value}; Max-Age=${value?604800:0}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`;
    const upstream=[];
    const upstreamFetch=async(url,init)=>{
      const call={url,method:init.method,headers:Object.fromEntries(new Headers(init.headers)),body:init.body??null},route=url.slice(UPSTREAM.length);
      upstream.push(call);
      const headers=new Headers({'content-type':'application/json'});
      if(route==='/get-session'){
        if(call.headers.cookie!==`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`)return new Response('null',{status:200,headers});
        headers.set('set-auth-jwt',JWT);headers.set('set-auth-token',TOKEN);headers.append('set-cookie',neonCookie(SIGNED));
        return new Response(JSON.stringify({session:{id:'sess-1',userId:'user-1',token:TOKEN,expiresAt:'2030-01-01T00:00:00.000Z'},user:USER}),{status:200,headers});
      }
      if(route==='/email-otp/send-verification-otp')return new Response('{"success":true}',{status:200,headers});
      if(route==='/sign-in/email-otp'){
        if(JSON.parse(call.body).otp!=='123456')return new Response('{"code":"INVALID_OTP","message":"Invalid OTP"}',{status:400,headers});
        headers.set('set-auth-token',TOKEN);headers.append('set-cookie',neonCookie(SIGNED));
        return new Response(JSON.stringify({token:TOKEN,user:USER}),{status:200,headers});
      }
      if(route==='/sign-out'){headers.append('set-cookie',neonCookie(''));return new Response('{"success":true}',{status:200,headers})}
      return new Response('{}',{status:404,headers});
    };
    try{
      await buildCommercialFrontend({outDir:dist,env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_DATA_URL:DATA,POOL_PLATFORM_DEFAULT_POOL_SLUG:'it-pool'}});
      const lines=[];
      const local=await startServer({dir:dist,port:0,log:line=>lines.push(line),env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_AUTH_UPSTREAM_URL:UPSTREAM},upstreamFetch});
      try{
        const origin=new URL(local.url).origin,{context:poolContext,entries}=liveWorld();
        const context=await browser.newContext({serviceWorkers:'block'});contexts.push(context);
        const page=await context.newPage(),errors=[],requests=[],messages=[],data=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('console',message=>messages.push(message.text()));
        context.on('request',request=>requests.push({method:request.method(),url:request.url(),headers:request.headers()}));
        await context.route(/neonauth/,route=>route.abort());
        // The Data API (cross-origin): the verified recipient claims the entry once, then discovers its pool.
        let claimed=false;
        await context.route('https://data.pool.test/**',route=>{
          const request=route.request(),cors={'access-control-allow-origin':origin,'access-control-allow-headers':'authorization, content-type, accept','access-control-allow-methods':'POST'};
          if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
          data.push({url:request.url(),headers:request.headers(),body:request.postData()});
          const reply=(status,body)=>route.fulfill({status,contentType:'application/json',headers:cors,body:JSON.stringify(body)});
          if(request.url()===`${DATA}/rpc/${CLAIM_INVITE}`){
            if(claimed||request.headers().authorization!==`Bearer ${JWT}`||request.postDataJSON()?.p_entry_id!==ENTRY_ONE)
              return reply(400,{message:'invite_unavailable'});
            claimed=true;return reply(200,{entry_id:ENTRY_ONE,claimed:true});
          }
          if(request.url()===`${DATA}/rpc/${LIST_PARTICIPANT_POOLS}`)return reply(200,claimed?[participantDiscovery(poolContext)]:[]);
          if(request.url()===`${DATA}/rpc/${PARTICIPANT_CONTEXT}`)return claimed?reply(200,{...poolContext,entries:[entries[0]]}):reply(400,{message:'pool_not_found'});
          if(request.url().includes('_snapshot'))return reply(404,{code:'PGRST202',message:'Could not find the function'});
          return reply(400,{message:'unexpected_rpc'});
        });
        const signIn=async()=>{
          await page.fill('#email','invited@example.test');await page.click('#sendCode');
          await page.locator('#otpWrap').waitFor({state:'visible'});
          await page.fill('#otp','123456');await page.click('#verifyCode');
          await page.locator('#entryCard').waitFor({state:'visible'});
        };
        const inviteUrl=origin+JOIN_PATH;
        await page.goto(inviteUrl);
        await page.locator('#authCard').waitFor({state:'visible'});
        assert.equal(page.url(),`${local.url}participant.html?pool=it-pool`,'scrubbed before sign-in');
        await signIn();
        assert.equal(await page.isVisible('#sessionError'),false);
        // Signed out and in again on the same page: the claimed hint is gone, so nothing is claimed twice.
        await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
        await signIn();
        assert.equal(await page.isVisible('#sessionError'),false);
        const claims=data.filter(call=>call.url===`${DATA}/rpc/${CLAIM_INVITE}`);
        assert.deepEqual(claims.map(call=>[call.body,call.headers.authorization]),[[JSON.stringify({p_entry_id:ENTRY_ONE}),`Bearer ${JWT}`]]);
        for(const call of data){
          assert.doesNotMatch(call.body||'',/p_invite_token|invite_token/);
          assert.equal(JSON.stringify(claims.includes(call)?{...call,body:null}:call).includes(ENTRY_ONE),false,call.url);
        }
        const auth=requests.filter(r=>new URL(r.url).pathname.startsWith('/api/auth/'));
        assert.deepEqual([...new Set(auth.map(r=>`${r.method} ${new URL(r.url).pathname}`))].sort(),
          ['GET /api/auth/get-session','POST /api/auth/email-otp/send-verification-otp','POST /api/auth/sign-in/email-otp','POST /api/auth/sign-out']);
        assert.equal(requests.filter(r=>r.url===inviteUrl).length,1,'the invitation requests only the pool and entry path');
        assert.equal(inviteUrl.includes('?')||inviteUrl.includes('#'),false);
        for(const [label,value] of [['other browser requests',requests.filter(r=>r.url!==inviteUrl)],['request headers',requests.map(r=>r.headers)],
          ['Neon Auth upstream',upstream],['Auth proxy log',lines.filter(line=>line.startsWith('AUTH '))],['console',messages]]){
          assert.equal(JSON.stringify(value).includes(ENTRY_ONE),false,label);
        }
        assert.ok(lines.includes(`GET ${JOIN_PATH} 200`)&&lines.includes('AUTH POST verify-otp 200'),JSON.stringify(lines));
        assert.equal(lines.some(line=>line.includes('#')||line.includes('invite=')),false,JSON.stringify(lines));
        const stores=await page.evaluate(async()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookie:document.cookie,
          history:history.state,databases:await indexedDB.databases(),caches:await caches.keys()}));
        assert.equal(stores.includes(ENTRY_ONE),false,stores);
        assert.equal(stores.includes(JWT),false,stores);
        assert.equal(JSON.stringify(await context.cookies()).includes(ENTRY_ONE),false);
        assert.doesNotMatch(await page.content(),/invite_token|p_invite_token/);
        assert.equal(page.url(),`${local.url}participant.html?pool=it-pool`);
        assert.deepEqual(errors,[]);
      }finally{await local.close()}
    }finally{fs.rmSync(work,{recursive:true,force:true})}
  });

  // Finding 1 (Corrective 2) in real Chromium: a sibling host plants a cookie whose raw name carries a leading
  // non-ASCII whitespace byte (NBSP, 0xA0) before __Host-pool-platform-session. Chromium keeps that planted name
  // distinct from the protected __Host- cookie — so another port may set it, and it is sent to the app beside any
  // genuine cookie — but the retired proxy parser trimmed Unicode whitespace from the name and would have read the
  // planted value as the session, forwarding it upstream (session fixation). The corrected proxy matches the name
  // byte-exactly, so the planted value is never a session, never travels upstream, and is never laundered into the
  // real app cookie; the request fails closed (401). A is a signed-out browser with the planted near-match only; B is
  // a genuine signed-in cookie plus the planted near-match, proving the planted value cannot replace or override it.
  test('real bundled SDK: a sibling-host NBSP look-alike cookie is never read as the session, sends nothing upstream, and cannot override the genuine __Host- cookie (signed out, and beside a real session)',{skip:SDK_HTTP_SESSION_SKIP},async()=>{
    const work=fs.mkdtempSync(path.join(os.tmpdir(),'pool-platform-nbsp-')),dist=path.join(work,'dist');
    const UPSTREAM='https://ep-example-000000.neonauth.c-0.us-east-2.aws.neon.tech/neondb/auth',DATA='https://data.pool.test/neondb/rest/v1';
    const TOKEN='SynthSessTokenAbcdefghijklmn0123',SIGNED=`${TOKEN}.c3ludGhldGljLXNpZ25hdHVyZQ%3D%3D`,PLANTED='PlantedSessTokenZyxwvutsrq98765.cGxhbnRlZA%3D%3D';
    const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const JWT=`${b64({alg:'EdDSA',typ:'JWT'})}.${b64({sub:'user-1',role:'authenticated'})}.c2hhcGUtb25seS1zaWduYXR1cmU`;
    const USER={id:'user-1',email:'player@example.test',emailVerified:true,name:'Player'};
    const neonCookie=value=>`${UPSTREAM_SESSION_COOKIE}=${value}; Max-Age=${value?604800:0}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`;
    const upstream=[];
    const upstreamFetch=async(url,init)=>{
      const call={path:url.slice(UPSTREAM.length),cookie:new Headers(init.headers).get('cookie'),body:init.body??null};
      upstream.push(call);
      const headers=new Headers({'content-type':'application/json'});
      if(call.path==='/get-session'){
        if(call.cookie!==`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`)return new Response('null',{status:200,headers});
        headers.set('set-auth-jwt',JWT);headers.append('set-cookie',neonCookie(SIGNED));
        return new Response(JSON.stringify({session:{id:'sess-1',userId:'user-1',token:TOKEN,expiresAt:'2030-01-01T00:00:00.000Z'},user:USER}),{status:200,headers});
      }
      if(call.path==='/email-otp/send-verification-otp')return new Response('{"success":true}',{status:200,headers});
      if(call.path==='/sign-in/email-otp'){
        headers.append('set-cookie',neonCookie(SIGNED));
        return new Response(JSON.stringify({token:TOKEN,user:USER}),{status:200,headers});
      }
      if(call.path==='/sign-out'){headers.append('set-cookie',neonCookie(''));return new Response('{"success":true}',{status:200,headers})}
      return new Response('{}',{status:404,headers});
    };
    // The planter runs on another port of the same host. Its Set-Cookie name is the app cookie name with one leading
    // NBSP byte (0xA0), written as a Latin-1 byte on the wire. Chromium stores it as a cookie DISTINCT from the
    // __Host- cookie (the raw name does not start with "__Host-"), so this sibling may set it with no __Host- rules and
    // it rides alongside the genuine cookie. /unplant-nbsp expires that same distinct name.
    const nbspName=` ${APP_SESSION_COOKIE}`;
    const planter=http.createServer((req,res)=>{
      const cookie={[`/plant-nbsp`]:`${nbspName}=${PLANTED}; Path=/; Secure; SameSite=None`,
        [`/unplant-nbsp`]:`${nbspName}=; Path=/; Max-Age=0; Secure; SameSite=None`}[req.url];
      res.writeHead(cookie?200:404,{'content-type':'text/plain; charset=utf-8',...(cookie?{'set-cookie':cookie}:{})}).end('planter');
    });
    await new Promise(resolve=>planter.listen(0,'127.0.0.1',resolve));
    try{
      await buildCommercialFrontend({outDir:dist,env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_DATA_URL:DATA,POOL_PLATFORM_DEFAULT_POOL_SLUG:'it-pool'}});
      const lines=[];
      const local=await startServer({dir:dist,port:0,log:line=>lines.push(line),env:{POOL_PLATFORM_MODE:'live',POOL_PLATFORM_AUTH_UPSTREAM_URL:UPSTREAM},upstreamFetch});
      try{
        const origin=new URL(local.url).origin,plant=`http://localhost:${planter.address().port}`;
        const context=await browser.newContext({serviceWorkers:'block'});contexts.push(context);
        const page=await context.newPage(),errors=[],escaped=[],auth=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('response',response=>{
          const url=new URL(response.url());
          if(url.origin===origin&&url.pathname.startsWith('/api/auth/'))auth.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
        });
        await context.route(/neonauth/,route=>{escaped.push(route.request().url());return route.abort()});
        await context.route('https://data.pool.test/**',route=>{
          const request=route.request(),cors={'access-control-allow-origin':origin,'access-control-allow-headers':'authorization, content-type, accept','access-control-allow-methods':'POST'};
          if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
          return route.fulfill({status:400,contentType:'application/json',headers:cors,body:'{"message":"pool_not_found"}'});
        });
        // Playwright's CDP cookie view strips the leading NBSP byte from the stored name, so the genuine and the
        // planted cookie both read back here under the exact name; they are told apart by value. The wire truth — that
        // the planted cookie reaches the app as a DISTINCT, NBSP-prefixed near-match and not the exact cookie — is what
        // the proxy refusing with reason `cookie-conflict` below proves: an exact cookie would have been read as the
        // session (200), never a conflict.
        const appCookieValues=async()=>(await context.cookies()).filter(c=>c.name===APP_SESSION_COOKIE).map(c=>c.value).sort();
        const plantPage=await context.newPage();

        // A. Signed out, planted near-match only. The app never had a session. get-session fails closed (401), nothing
        //    reaches Neon, and no genuine app cookie is minted from the planted value.
        await plantPage.goto(`${plant}/plant-nbsp`);
        assert.deepEqual(await appCookieValues(),[PLANTED],'the sibling planted exactly one app-named cookie');
        const beforeA=upstream.length;
        await page.goto(`${local.url}participant.html`);
        await page.locator('#sessionError').waitFor({state:'visible'});
        assert.equal(await page.textContent('#sessionError'),'Sign-in could not be confirmed. Clear this site\'s cookies, then sign in again.');
        assert.equal(await page.isVisible('#signOut'),false,'the planted value is not a session');
        const seenA=await page.evaluate(async()=>{const r=await fetch('/api/auth/get-session');return{status:r.status,body:await r.text(),cookie:document.cookie}});
        assert.equal(seenA.status,401,'fails closed, not 200 null');
        assert.equal(seenA.body.includes(PLANTED.split('.')[0]),false,'no planted value in the body');
        assert.equal(seenA.cookie,'','no script-visible cookie');
        assert.equal(upstream.length,beforeA,'the planted value never reached Neon');
        assert.equal(lines.filter(l=>l.startsWith('AUTH GET get-session')).at(-1),'AUTH GET get-session 401 cookie-conflict',
          'a lone planted near-match is refused as a conflict — proof the wire name carried the NBSP, not the exact cookie');
        assert.deepEqual(await appCookieValues(),[PLANTED],'nothing set or deleted: no genuine cookie minted from the planted value');

        // B. A genuine session plus the planted near-match. Sign in first (clear the planted cookie, sign in, confirm
        //    the empty state), then plant the near-match beside the genuine cookie and reload.
        await plantPage.goto(`${plant}/unplant-nbsp`);
        assert.deepEqual(await context.cookies(),[]);
        await page.goto(`${local.url}participant.html`);
        await page.locator('#authCard').waitFor({state:'visible'});
        await page.fill('#email','player@example.test');await page.click('#sendCode');
        await page.locator('#otpWrap').waitFor({state:'visible'});
        await page.fill('#otp','123456');await page.click('#verifyCode');
        await page.locator('#emptyCard').waitFor({state:'visible'});
        assert.deepEqual(await appCookieValues(),[SIGNED],'exactly the genuine session cookie');
        await plantPage.goto(`${plant}/plant-nbsp`);
        assert.deepEqual(await appCookieValues(),[PLANTED,SIGNED].sort(),'the planted near-match now rides beside the genuine cookie');
        const beforeB=upstream.length;
        await page.reload();
        await page.locator('#sessionError').waitFor({state:'visible'});
        assert.equal(await page.isVisible('#signOut'),false,'the request is ambiguous and fails closed');
        const seenB=await page.evaluate(async()=>{const r=await fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});return{status:r.status,body:await r.text()}});
        assert.equal(seenB.status,401);
        assert.equal(seenB.body.includes(PLANTED.split('.')[0])||seenB.body.includes(TOKEN),false);
        assert.equal(upstream.length,beforeB,'neither value reached Neon; the look-alike never overrode the genuine session');
        assert.equal(lines.filter(l=>l.startsWith('AUTH POST sign-out')).at(-1),'AUTH POST sign-out 401 cookie-conflict','the planted near-match cannot even drive a sign-out of the genuine cookie');
        assert.deepEqual(await appCookieValues(),[PLANTED,SIGNED].sort(),'nothing set or deleted; the genuine cookie survives untouched');

        // Remove the planted cookie: the untouched genuine cookie signs in again, proving B never overrode it.
        await plantPage.goto(`${plant}/unplant-nbsp`);
        assert.deepEqual(await appCookieValues(),[SIGNED]);
        await page.reload();
        await page.locator('#emptyCard').waitFor({state:'visible'});
        assert.equal(upstream.filter(c=>c.path==='/get-session').at(-1).cookie,`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`);

        // Over the whole run Neon only ever saw its own cookie with the genuine value, never the planted one; the two
        // fail-closed get-session/sign-out answers were 401; and no value leaked to a Neon Auth host or the log.
        for(const call of upstream)assert.ok(call.cookie===null||call.cookie===`${UPSTREAM_SESSION_COOKIE}=${SIGNED}`,JSON.stringify(call));
        assert.ok(auth.includes('GET /api/auth/get-session 401')&&auth.includes('POST /api/auth/sign-out 401'),JSON.stringify(auth));
        assert.ok(lines.includes('AUTH GET get-session 401 cookie-conflict')&&lines.includes('AUTH POST sign-out 401 cookie-conflict'));
        assert.equal(lines.some(line=>line.includes(TOKEN)||line.includes('Planted')||line.includes(JWT)),false);
        assert.deepEqual(escaped,[],'no request to a Neon Auth host reached the network');
        assert.deepEqual(errors,[]);
      }finally{await local.close()}
    }finally{
      await new Promise(resolve=>{planter.close(()=>resolve());planter.closeAllConnections()});
      fs.rmSync(work,{recursive:true,force:true});
    }
  });
});
}
