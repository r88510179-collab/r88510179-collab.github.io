import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test,{after,before,describe} from 'node:test';
import vm from 'node:vm';
import {CONFIG_UNAVAILABLE,SIGN_IN_NOT_CONFIRMED} from './platform-client.js';
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
  assert.match(shell,/<div class="topbar">[\s\S]*<button class="button compact secondary hidden tap-target" id="signOut" type="button">Sign out<\/button>/);
  assert.match(shell,/<div class="notice error hidden shell-notice" id="sessionError" role="alert">/);
  assert.equal(html.match(/id="signOut"/g).length,1);
  // Only the session decides whether Sign out shows: not the entry context, an invite claim or an error.
  assert.equal(js.match(/show\('signOut'/g).length,1);
  assert.match(js,/function setAuthVisible\(\)\{show\('authCard',client\.live&&!state\.session\);show\('signOut',client\.live&&!!state\.session\)\}/);
  // A failed claim is reported, but the account's own context still loads (a reopened, already claimed link).
  assert.match(js,/async function openSession\(\)\{\n  const session=state\.session,report=e=>\{if\(state\.session===session\)message\('sessionError',e\.message\)\};\n  setAuthVisible\(\);message\('sessionError',''\);\n  let claimFailed=false;\n  try\{await claimInviteIfPresent\(\)\}catch\(e\)\{claimFailed=true;report\(e\)\}\n  try\{await loadLiveContext\(\)\}catch\(e\)\{if\(!claimFailed\)report\(e\)\}\n\}/);
  assert.match(js,/state\.session=await client\.getSession\(\);setAuthVisible\(\);\n  if\(state\.session\)await openSession\(\);/);
  assert.match(js,/state\.session=await client\.verifyOtp\(state\.pendingEmail\|\|\$\('email'\)\.value,\$\('otp'\)\.value\)\}catch\(e\)\{message\('authError',e\.message\);return\}await openSession\(\)/);
  // A failed claim throws before the token is dropped, so the invited account can still claim it. The URL is not
  // touched here: the invite left it when the page first read it.
  assert.match(js,/await client\.claimInvite\(inviteToken\);inviteToken=''\}/);
  assert.doesNotMatch(js,/cleanInviteFromUrl/);
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

// Invite tokens travel only in the URL fragment, which no HTTP request carries, so Netlify's request logs and
// observability never see one. The commissioner page builds links that way, and the participant page reads the
// invite, scrubs it from the address bar and keeps it only in memory before it does anything else.
test('invite links carry the token only in the fragment; the participant page reads, scrubs and holds it before anything else runs',()=>{
  const cjs=read('commissioner.js'),pjs=read('participant.js'),core=read('auth-core.js');
  assert.match(cjs,/^import \{participantInviteUrl\} from '\.\/auth-core\.js';$/m);
  assert.match(cjs,/const url=participantInviteUrl\(new URL\('\.\/participant\.html',location\.href\),state\.context\.pool\.slug,result\.invite_token\);\n    msg\('inviteResult',`Invite ready: \$\{url\} · /);
  // Nothing anywhere puts an invite into a query string, or reads one from it.
  for(const [name,source] of [['commissioner.js',cjs],['participant.js',pjs],['auth-core.js',core]]){
    assert.doesNotMatch(source,/[?&]invite=|searchParams\.(set|append)\(\s*['"]invite['"]/,name);
  }
  assert.doesNotMatch(pjs,/\.get\(\s*['"]invite['"]\s*\)|\.has\(\s*['"]invite['"]\s*\)|location\.hash/);
  // Read and scrubbed first: before the configuration import, the first thing the page awaits.
  assert.match(pjs,/^import \{authErrorMessage,readInviteFromUrl\} from '\.\/auth-core\.js';$/m);
  const capture=pjs.indexOf('\nconst invite=readInviteFromUrl(location.href);\n');
  assert.ok(capture>0,'the invite is read from the page URL');
  assert.ok(capture<pjs.indexOf('await '),'and before the page awaits anything');
  assert.match(pjs,/\nconst invite=readInviteFromUrl\(location\.href\);\nif\(invite\.found\)history\.replaceState\(null,'',invite\.cleanUrl\);\nlet inviteToken=invite\.token;\nconst inviteError=invite\.error\?authErrorMessage\(invite\.error\):'';\nif\(inviteError\)message\('sessionError',inviteError\);\n/);
  assert.equal(pjs.match(/history\.replaceState\(/g).length,1);
  // An invite link opened over this page changes only the fragment and loads nothing: the page reloads to read it.
  assert.match(pjs,/\nwindow\.addEventListener\('hashchange',\(\)=>\{if\(readInviteFromUrl\(location\.href\)\.found\)location\.reload\(\)\}\);\n/);
  // In memory only: set from the fragment, sent only to claimInvite, cleared only by a successful claim. A refused
  // link fails like a claim, before any token could be sent, so the account's own entries still load.
  assert.deepEqual(pjs.split('\n').filter(line=>line.includes('inviteToken')&&!line.trim().startsWith('//')),[
    'let inviteToken=invite.token;',
    "async function claimInviteIfPresent(){if(!state.session)return;if(inviteError)throw new Error(inviteError);if(!inviteToken)return;await client.claimInvite(inviteToken);inviteToken=''}"
  ]);
  // Never persisted and never logged.
  for(const [name,source] of [['commissioner.js',cjs],['participant.js',pjs],['auth-core.js',core]]){
    assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|document\.cookie|caches\.|console\./,name);
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

test('commissioner Sign out and signed-in errors live in the shell; async work renders only for the session that started it',()=>{
  const html=read('commissioner.html'),js=read('commissioner.js');
  const shell=html.slice(html.indexOf('<main class="shell">'),html.indexOf('<section'));
  assert.match(shell,/<div class="topbar">[\s\S]*<button class="button compact secondary hidden tap-target" id="signOut" type="button">Sign out<\/button>/);
  assert.match(shell,/<div class="notice error hidden shell-notice" id="sessionError" role="alert">/);
  assert.equal(html.match(/id="signOut"/g).length,1);
  // Only the session decides whether Sign out shows: not the pool context, an import or an error.
  assert.equal(js.match(/show\('signOut'/g).length,1);
  assert.match(js,/function setAuth\(\)\{show\('authCard',client\.live&&!state\.session\);show\('signOut',client\.live&&!!state\.session\)\}/);
  assert.match(js,/async function load\(\)\{\n  const session=state\.session,context=client\.live\?await client\.commissionerContext\(poolSlug\):syntheticContext\(\);\n  if\(state\.session!==session\)return; \/\/ signed out while loading: render nothing for the previous account\n  state\.context=context;renderConsole\(\);\n\}/);
  assert.match(js,/async function openSession\(\)\{\n  const session=state\.session;\n  setAuth\(\);msg\('sessionError',''\);\n  try\{await load\(\)\}catch\(e\)\{if\(state\.session===session\)msg\('sessionError',e\.message\)\}\n\}/);
  assert.match(js,/state\.session=await client\.getSession\(\);setAuth\(\);\n  if\(state\.session\)await openSession\(\);/);
  assert.match(js,/state\.session=await client\.verifyOtp\(state\.pendingEmail\|\|\$\('email'\)\.value,\$\('otp'\)\.value\)\}catch\(e\)\{msg\('authError',e\.message\);return\}await openSession\(\)/);
  assert.match(js,/initialize\(\)\.catch\(e=>msg\('sessionError',e\.message\)\)/);
  const signOut=/\$\('signOut'\)\.addEventListener\('click',async\(\)=>\{\n([\s\S]*?)\n\}\);/.exec(js)?.[1];
  assert.ok(signOut);
  assert.match(signOut,/^  try\{await client\.signOut\(\)\}catch\(e\)\{msg\('sessionError',e\.message\);return\}/);
  assert.match(signOut,/Object\.assign\(state,\{session:null,context:null,season:null,week:null,pendingEmail:''\}\)/);
  for(const id of ['consoleCard','entriesCard','inviteCard','importCard','resultTableWrap','otpWrap','seasonSelect','weekSelect','entriesBody','inviteEntry','resultBody','email','otp','inviteEmail','importText','inviteResult','importError','importResult']){
    assert.match(signOut,new RegExp(`'${id}'`),id);
  }
  assert.match(signOut,/for\(const id of \['sessionError','authError','inviteResult','importError','importResult'\]\)msg\(id,''\);\n  setAuth\(\);$/,'errors are cleared only after the session is gone');
  for(const action of ['createInvite','runImport']){
    const body=new RegExp(`\\$\\('${action}'\\)\\.addEventListener\\('click',async\\(\\)=>\\{\\n([\\s\\S]*?)\\n\\}\\);`).exec(js)?.[1];
    assert.ok(body,action);
    assert.match(body,/const session=state\.session;/,action);
    assert.match(body,/\n    if\(state\.session!==session\)return; \/\/ signed out while /,action);
    assert.match(body,/catch\(e\)\{if\(state\.session===session\)msg\('importError',e\.message\)\}/,action);
  }
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
  const listed=['','index.html','participant.html','commissioner.html','styles.css','sw-register.js','participant.js','commissioner.js','submission-core.js','participant-core.js','import-core.js','auth-core.js','platform-client.js','manifest.webmanifest'];
  assert.deepEqual(keys.sort(),listed.map(asset=>`${ORIGIN}/pool-platform/${asset}`).sort());
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
  assert.equal(current,'pool-platform-commercial-v4');
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

// Opt-in: the real participant page in headless Chromium through Playwright.
//   POOL_PLATFORM_TEST_BROWSER=1 NODE_PATH="$(npm root -g)" node --test pool-platform/ui-contract.test.mjs
// Sandbox runs as shipped. Live mode is stubbed only at the network edge: platform-config.js is served as a
// live config, the same-origin bundled SDK (vendor/neon-js.js) as an in-page fake auth client, and the Data API
// RPCs by an in-memory stand-in, so the page's own auth shell, invite, rendering and submit code runs unmodified.
// Every page is served with the production Content-Security-Policy, and clean() fails on any violation reported.
const BROWSER=process.env.POOL_PLATFORM_TEST_BROWSER||'';
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
const INVITE='ab'.repeat(32);
const HOSTILE_LABEL='<img src=x onerror="window.__xss=(window.__xss||0)+1">';
// Every value the tiebreak box must show verbatim (blank shows the dash) without creating markup or running.
const TIEBREAK_INPUTS=['<img src=x onerror=alert(1)>','<script>alert(1)</script>','<img src=x onerror="window.__xss=(window.__xss||0)+1">','<svg onload=alert(1)>','"double" and \'single\' quotes','Tom & Jerry &amp; &lt;b&gt;','<b>bold</b> > <i>angle</i> <','47','0',''];
const textAsHtml=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function serveDirectory(root){
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json'};
  const server=http.createServer((req,res)=>{
    server.targets.push(req.url); // each request target exactly as the browser sent it
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

function liveWorld({owners={},invites={},readable=[],games,poolType='pickem'}={}){
  const deadline=new Date(Date.now()+86400000).toISOString();
  return{
    owners,invites,readable,calls:[],gates:[],
    entries:['E01','E02'].map((code,i)=>({id:`entry-${i+1}`,entry_code:code,display_name:`Entry ${code}`,status:'active',submission:null,history:[]})),
    context:{
      pool:{id:'pool-1',slug:'it-pool',display_name:poolType==='survivor'?'IT Survivor':'IT Pick’em',pool_type:poolType,rules:{},branding:{}},
      season:{id:'season-1',season:2027,config:{}},
      week:{id:'week-1',week:1,status:'open',opens_at:null,deadline_at:deadline,config:{tiebreakRequired:poolType==='pickem',games:games||[
        {id:'g1',away:{key:'austin',label:'Austin'},home:{key:'denver',label:'Denver'}},
        {id:'g2',away:{key:'phoenix',label:'Phoenix'},home:{key:'seattle',label:'Seattle'}}
      ]}}
    }
  };
}

// The same pool seen from the commissioner console. commissioner_context answers only a listed commissioner and
// only for this pool's slug, raising commissioner_required otherwise, as the database does; contextFailure
// makes it fail with an HTTP error or a dropped connection instead.
function consoleWorld({commissioners=['commish@example.test'],contextFailure=null}={}){
  const world=liveWorld(),{pool,season,week}=world.context;
  return Object.assign(world,{commissioners,contextFailure,console:{
    pool:{...pool,tenant_id:'tenant-1',display_name:'Private Console Pool'},
    seasons:[{...season,status:'active',weeks:[week],
      entries:world.entries.map(({id,entry_code,display_name,status})=>({id,entry_code,display_name,status,claimed:false,submissions:[]}))}]
  }});
}
const INVITE_OUT='cd'.repeat(32);

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
    world.calls.push({name,email,args,at:Date.now(),method:request.method(),url:request.url(),headers:request.headers(),body:request.postData()});
    const held=world.gates.find(g=>g.name===name&&!g.done);
    if(held){if(held.skip>0)held.skip--;else{held.done=true;held.seen();await held.released}}
    const reply=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    const fail=message=>reply(400,{code:'P0001',details:null,hint:null,message});
    // world.authRequired[name]: how many more calls of that RPC answer auth_required before anything else happens,
    // as a newly opened Data API connection that saw no identity would (the database raises it first).
    if(world.authRequired?.[name]>0){world.authRequired[name]--;return fail('auth_required')}
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
    const commissioner=(world.commissioners||[]).includes(email);
    if(name==='pool_platform_commissioner_context'){
      if(world.contextFailure==='network')return route.abort('failed');
      if(world.contextFailure==='http')return reply(500,{code:'XX000',details:null,hint:null,message:'upstream_unavailable'});
      if(!commissioner||args.p_pool_slug!==world.console.pool.slug)return fail('commissioner_required');
      return reply(200,world.console);
    }
    if(name==='pool_platform_create_entry_invite'){
      if(!commissioner)return fail('commissioner_required');
      return reply(200,{invite_token:INVITE_OUT,entry_id:args.p_entry_id,expires_at:new Date(Date.now()+7*86400000).toISOString()});
    }
    if(name==='pool_platform_submit_batch'){
      if(!commissioner)return fail('commissioner_required');
      return reply(200,args.p_items.map(item=>({entry_id:item.entry_id,ok:true,result:{ok:true,code:'created',revision:1}})));
    }
    return fail(`unexpected_rpc:${name}`);
  };
}

describe('participant and commissioner pages in headless Chromium (opt-in)',{skip:BROWSER?false:'set POOL_PLATFORM_TEST_BROWSER=1 (with playwright on NODE_PATH) to drive the real page'},()=>{
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
      await page.route(`${base}/platform-config.js`,route=>route.fulfill({contentType:'text/javascript',
        body:`export const PLATFORM_CONFIG=Object.freeze({mode:'live',dataUrl:'${base}/data-api',defaultPoolSlug:${JSON.stringify(poolSlug)}});`}));
      await page.route(`${base}/${SDK_PATH}`,route=>route.fulfill({contentType:'text/javascript',body:FAKE_SDK}));
      await page.route(`${base}/data-api/rpc/*`,dataApi(world));
    }
    await page.goto(`${base}/${path}${query}`);
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
  // A fragment invite token may travel in one place only: the body of the claim RPC. Never in a request target the
  // host saw, a URL or header the browser sent, any other RPC, a console message, the page, the address bar or a store.
  const inviteContained=async(page,world,seen,token)=>{
    assert.equal(server.targets.some(target=>target.includes(token)||target.includes('#')),false,'a request target the host saw');
    assert.equal(seen.requests.some(request=>JSON.stringify(request).includes(token)),false,'a request URL or header the browser sent');
    for(const {args,body,...call} of world.calls){
      assert.equal(JSON.stringify(call).includes(token),false,`${call.name}: its URL or headers`);
      if(call.name==='pool_platform_claim_entry_invite'&&args.p_invite_token===token)assert.equal(body,JSON.stringify({p_invite_token:token}));
      else assert.equal(String(body).includes(token),false,`${call.name}: its body`);
    }
    assert.equal(seen.console.some(text=>text.includes(token)),false,'a console message');
    assert.equal(page.url().includes(token)||page.url().includes('invite'),false,`the address bar: ${page.url()}`);
    assert.equal((await page.content()).includes(token),false,'the page');
    const stores=await page.evaluate(async()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookie:document.cookie,
      history:history.state,databases:await indexedDB.databases(),caches:await caches.keys()}));
    assert.equal(stores.includes(token),false,stores);
    assert.equal(JSON.stringify(await page.context().cookies()).includes(token),false,'a cookie');
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

  test('live: wrong account opens an email-bound invite → mismatch beside Sign out → sign out → invited account claims it from page memory',async()=>{
    const world=liveWorld({invites:{[INVITE]:{email:'invited@example.test',entryId:'entry-1'}}});
    const {page,seen}=await openPage({world,signedInAs:'wrong@example.test',query:`?pool=it-pool#invite=${INVITE}`});
    await page.locator('#sessionError').waitFor({state:'visible'});
    assert.match(await page.textContent('#sessionError'),/different email address/);
    await page.locator('#emptyCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,authCard:false,entryCard:false,pickForm:false,sessionError:true});
    assert.equal(world.invites[INVITE].claimedBy,undefined,'a rejected claim does not consume the invite');
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`,'the invite left the address bar when the page read it; the pool stays');

    await page.click('#signOut');
    await page.locator('#authCard').waitFor({state:'visible'});
    await visible(page,{signOut:false,sessionError:false,entryCard:false,emptyCard:false,otpWrap:false});
    assert.equal(await page.evaluate(()=>window.__fakeAuth.email),null,'the session ended');
    assert.equal(await page.inputValue('#email'),'');

    await signIn(page,'invited@example.test');
    await page.locator('#entryCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,authCard:false,sessionError:false,pickForm:true,emptyCard:false});
    assert.equal(world.invites[INVITE].claimedBy,'invited@example.test');
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_claim_entry_invite').map(c=>[c.email,c.args.p_invite_token]),
      [['wrong@example.test',INVITE],['invited@example.test',INVITE]]);
    // A successful claim drops the token: the next account to sign in on this page claims nothing.
    await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
    await signIn(page,'wrong@example.test');
    await page.locator('#emptyCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,sessionError:false});
    assert.equal(world.calls.filter(c=>c.name==='pool_platform_claim_entry_invite').length,2);
    await inviteContained(page,world,seen,INVITE);
    await clean(page,seen);
  });

  test('live: reopening an invite link this account already claimed reports it but still loads the entry, before and after signing in again',async()=>{
    const world=liveWorld({owners:{'entry-1':'player@example.test'},invites:{[INVITE]:{email:'player@example.test',entryId:'entry-1',claimedBy:'player@example.test'}}});
    const {page,seen}=await openPage({world,signedInAs:'player@example.test',query:`?pool=it-pool#invite=${INVITE}`});
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
    assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_claim_entry_invite').map(c=>c.email),['player@example.test','player@example.test']);
    await inviteContained(page,world,seen,INVITE);
    await clean(page,seen);
  });

  test('live: a signed-out participant opens an invite, which leaves the address bar at once and is claimed from page memory after sign-in',async()=>{
    const world=liveWorld({invites:{[INVITE]:{email:'invited@example.test',entryId:'entry-1'}}});
    const {page,seen}=await openPage({world,query:`?pool=it-pool#invite=${INVITE}`});
    await page.locator('#authCard').waitFor({state:'visible'});
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    await visible(page,{signOut:false,sessionError:false,entryCard:false});
    assert.deepEqual(world.calls,[],'nothing is claimed or loaded before sign-in');
    await signIn(page,'invited@example.test');
    await page.locator('#entryCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,sessionError:false,pickForm:true});
    assert.deepEqual(world.calls.map(c=>[c.name,c.email]),[['pool_platform_claim_entry_invite','invited@example.test'],['pool_platform_participant_context','invited@example.test']]);
    assert.equal(world.invites[INVITE].claimedBy,'invited@example.test');
    await inviteContained(page,world,seen,INVITE);
    await clean(page,seen);
  });

  test('live: an invite link opened over an already open participant page changes only the fragment; the page reloads, reads and scrubs it',async()=>{
    const world=liveWorld({invites:{[INVITE]:{email:'invited@example.test',entryId:'entry-1'}}});
    const {page,seen}=await openPage({world,signedInAs:'invited@example.test',query:'?pool=it-pool'});
    await page.locator('#emptyCard').waitFor({state:'visible'});
    await page.goto(`${base}/participant.html?pool=it-pool#invite=${INVITE}`);
    await page.locator('#entryCard').waitFor({state:'visible'});
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_claim_entry_invite').map(c=>[c.email,c.args.p_invite_token]),[['invited@example.test',INVITE]]);
    await inviteContained(page,world,seen,INVITE);
    await clean(page,seen);
  });

  test('live: a query-string invite (the retired link format) is never claimed; it leaves the URL, the participant is told to ask for a new link, and their own entries still load',async()=>{
    // Each token here would claim entry-1 if it were ever sent; the participant owns entry-2.
    const LEGACY='ef'.repeat(32);
    for(const [label,query,copy] of [
      ['query',`?pool=it-pool&invite=${LEGACY}`,/retired format/],
      ['query and fragment',`?pool=it-pool&invite=${LEGACY}#invite=${INVITE}`,/not valid/],
      ['fragment twice',`?pool=it-pool#invite=${INVITE}&invite=${INVITE}`,/not valid/]
    ]){
      const world=liveWorld({owners:{'entry-2':'player@example.test'},invites:{[LEGACY]:{entryId:'entry-1'},[INVITE]:{entryId:'entry-1'}}});
      const {page,seen}=await openPage({world,signedInAs:'player@example.test',query});
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
      assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_claim_entry_invite'),[],`${label}: no claim was sent`);
      assert.deepEqual(world.calls.map(c=>c.name),['pool_platform_participant_context','pool_platform_participant_context'],label);
      assert.equal(Object.values(world.invites).some(invite=>invite.claimedBy),false,label);
      for(const token of [LEGACY,INVITE])assert.equal(JSON.stringify(world.calls).includes(token),false,`${label}: no RPC carried a token`);
      await inviteContained(page,world,seen,INVITE);
      assert.equal(seen.console.some(text=>text.includes(LEGACY)),false,label);
      await clean(page,seen);
    }
    // Signed out, the refusal shows beside the sign-in card at once and again after sign-in.
    const world=liveWorld({invites:{[LEGACY]:{entryId:'entry-1'}}});
    const {page,seen}=await openPage({world,query:`?pool=it-pool&invite=${LEGACY}`});
    await page.locator('#authCard').waitFor({state:'visible'});
    assert.match(await page.textContent('#sessionError'),/retired format/);
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    await signIn(page,'invited@example.test');
    await page.locator('#emptyCard').waitFor({state:'visible'});
    assert.match(await page.textContent('#sessionError'),/retired format/);
    assert.deepEqual(world.calls.map(c=>c.name),['pool_platform_participant_context']);
    await clean(page,seen);
  });

  test('live: signing out while a claim, context load, submit or post-submit reload is in flight leaves nothing of that account on screen',async()=>{
    const signedOut={authCard:true,signOut:false,sessionError:false,entryCard:false,pickForm:false,emptyCard:false,submittedCard:false};
    // A claim that will fail, then the context load, each still in flight when Sign out finishes.
    for(const name of ['pool_platform_claim_entry_invite','pool_platform_participant_context']){
      const world=liveWorld({owners:{'entry-2':'wrong@example.test'},invites:{[INVITE]:{email:'invited@example.test',entryId:'entry-1'}}});
      const held=gate(world,name);
      const {page,seen}=await openPage({world,signedInAs:'wrong@example.test',query:`#invite=${INVITE}`});
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
      const {page,seen}=await openPage({world,signedInAs:'wrong@example.test',query:`#invite=${INVITE}`});
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
    for(const [i,[typed,expected]] of [['47',47],['0',0]].entries()){
      await page.fill('#tiebreak',typed);await page.click('#submitBtn');
      // The saved card is still up from the previous submit, so wait for this submit's own revision, which
      // is written only after its reload has re-rendered the form and re-enabled Submit.
      await page.locator('#submittedMeta',{hasText:`Revision ${i+1} `}).waitFor();
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
    const world=liveWorld({owners:{'entry-1':'player@example.test','entry-2':'player@example.test'},games:SURVIVOR_GAMES,poolType:'survivor'});
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
    await page.click('#submitBtn');await page.locator('#submittedMeta',{hasText:'Revision 1 '}).waitFor();
    assert.deepEqual(submitted(),{p_week_id:'week-1',p_entry_id:'entry-1',p_source:'participant',p_payload:{team:'NYJ'}});
    await page.click('label[for="team-4"]');
    assert.equal(await page.locator('#summary .summary-row strong').textContent(),`Twin City (${HOSTILE_KEY})`);
    await page.click('#submitBtn');await page.locator('#submittedMeta',{hasText:'Revision 2 '}).waitFor();
    assert.deepEqual(submitted().p_payload,{team:HOSTILE_KEY},'the markup key round-trips exactly');

    await page.selectOption('#entrySelect','entry-2');
    assert.deepEqual(await survivorLabels(page),['New York (NYG) · USED',...SURVIVOR_LABELS.slice(1)]);
    assert.deepEqual((await survivorInputs(page)).slice(0,4),[['NYG',true],['DAL',false],['MIA',false],['NYJ',false]]);
    await page.click('label[for="team-3"]');await page.click('#submitBtn');
    await page.locator('#submittedMeta',{hasText:'Revision 1 '}).waitFor();
    assert.deepEqual(submitted(),{p_week_id:'week-1',p_entry_id:'entry-2',p_source:'participant',p_payload:{team:'NYJ'}});
    await clean(page,seen);
  });

  test('mobile widths: no horizontal overflow and Sign out stays on screen in every signed-in state',async()=>{
    for(const width of [320,360,375,384,390,412]){
      const states=[
        {world:liveWorld({invites:{[INVITE]:{email:'invited@example.test',entryId:'entry-1'}}}),signedInAs:'wrong@example.test',query:`#invite=${INVITE}`,ready:'#sessionError'},
        {world:liveWorld(),signedInAs:'loner@example.test',ready:'#emptyCard'},
        {world:liveWorld({owners:{'entry-1':'player@example.test'}}),signedInAs:'player@example.test',ready:'#pickForm'},
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
      }
      const {page,seen}=await openPage({width,height:740});
      await page.locator('#pickForm').waitFor({state:'visible'});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),`${width}px sandbox pick form overflows`);
      await clean(page,seen);
    }
  });

  const openConsole=options=>openPage({path:'commissioner.html',...options});
  const IMPORT_CSV='entry_code,g1,g2,tiebreak\nE01,away,home,47\nE02,home,away,41';
  const signedOutConsole={authCard:true,signOut:false,sessionError:false,otpWrap:false,consoleCard:false,entriesCard:false,inviteCard:false,importCard:false,resultTableWrap:false};
  // Nothing a commissioner session loaded or typed may stay in the page, shown or hidden, once it signs out.
  // The sign-in fields are checked only while signed out: afterwards they hold the next account's own input.
  const noConsoleLeft=async(page,label,{signedOut=true}={})=>{
    const html=await page.content();
    for(const marker of ['Private Console Pool','Entry E01','Entry E02','entry-1','entry-2',INVITE_OUT,'Week 1 ·']){
      assert.equal(html.includes(marker),false,`${label}: "${marker}" is still in the page`);
    }
    for(const id of ['inviteEmail','importText',...(signedOut?['email','otp']:[])]){
      assert.equal(await page.inputValue(`#${id}`),'',`${label}: #${id} still has a value`);
    }
    assert.equal(await page.textContent('#poolName'),'Pool',label);
    assert.equal(await page.getAttribute('#importText','placeholder'),'',label);
  };

  test('commissioner live: an account that manages no pool gets commissioner_required beside Sign out, then switches to the commissioner',async()=>{
    const world=consoleWorld();
    const {page,seen}=await openConsole({world,signedInAs:'player@example.test'});
    await page.locator('#sessionError').waitFor({state:'visible'});
    assert.equal(await page.textContent('#sessionError'),'Commissioner access is required.');
    await visible(page,{signOut:true,authCard:false,consoleCard:false,entriesCard:false,inviteCard:false,importCard:false});
    assert.equal(await page.locator('section #signOut').count(),0,'Sign out is not inside any card');
    await page.click('#signOut');
    await page.locator('#authCard').waitFor({state:'visible'});
    await visible(page,signedOutConsole);
    assert.equal(await page.evaluate(()=>window.__fakeAuth.email),null,'the session ended');
    await signIn(page,'commish@example.test');
    await page.locator('#importCard').waitFor({state:'visible'});
    await visible(page,{signOut:true,authCard:false,sessionError:false,consoleCard:true,entriesCard:true,inviteCard:true});
    assert.equal(await page.textContent('#poolName'),'Private Console Pool');
    assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_commissioner_context').map(c=>[c.email,c.args.p_pool_slug]),
      [['player@example.test','it-pool'],['commish@example.test','it-pool']]);
    await clean(page,seen);
  });

  test('commissioner live: a missing pool slug, an unknown pool and a failed context load each leave a working Sign out',async()=>{
    const cases=[
      ['no pool slug',{poolSlug:''},{},'',/^Commissioner access is required\.$/],
      ['unknown pool',{query:'?pool=no-such-pool'},{},'no-such-pool',/^Commissioner access is required\.$/],
      ['server error',{},{contextFailure:'http'},'it-pool',/^upstream_unavailable$/],
      ['dropped connection',{},{contextFailure:'network'},'it-pool',/fetch/i]
    ];
    for(const [label,options,worldOptions,slug,message] of cases){
      const world=consoleWorld(worldOptions);
      const {page,seen}=await openConsole({world,signedInAs:'commish@example.test',...options});
      await page.locator('#sessionError').waitFor({state:'visible'});
      assert.match(await page.textContent('#sessionError'),message,label);
      await visible(page,{signOut:true,authCard:false,consoleCard:false,importCard:false});
      assert.deepEqual(world.calls.map(c=>[c.name,c.args.p_pool_slug]),[['pool_platform_commissioner_context',slug]],label);
      await page.click('#signOut');
      await page.locator('#authCard').waitFor({state:'visible'});
      await visible(page,signedOutConsole);
      await clean(page,seen);
    }
  });

  test('commissioner live: a failed sign out is reported beside Sign out and can be retried',async()=>{
    const {page,seen}=await openConsole({world:consoleWorld(),signedInAs:'player@example.test'});
    await page.locator('#sessionError').waitFor({state:'visible'});
    await page.evaluate(()=>{window.__signOutGate=Promise.reject(new Error('Sign-out service unavailable.'));window.__signOutGate.catch(()=>{})});
    await page.click('#signOut');
    await page.locator('#sessionError',{hasText:'Sign-out service unavailable.'}).waitFor();
    await visible(page,{signOut:true,authCard:false});
    await page.evaluate(()=>{window.__signOutGate=null});
    await page.click('#signOut');
    await page.locator('#authCard').waitFor({state:'visible'});
    await visible(page,signedOutConsole);
    await clean(page,seen);
  });

  test('commissioner live: signing out while the context load, an invite, an import or the post-import reload is in flight leaves nothing of that account on screen',async()=>{
    const createInvite=async page=>{await page.fill('#inviteEmail','invitee@example.test');await page.click('#createInvite')};
    const runImport=async page=>{await page.fill('#importText',IMPORT_CSV);await page.click('#runImport')};
    for(const [name,skip,act] of [
      ['pool_platform_commissioner_context',0,null],
      ['pool_platform_create_entry_invite',0,createInvite],
      ['pool_platform_submit_batch',0,runImport],
      ['pool_platform_commissioner_context',1,runImport]
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
      await page.locator('#sessionError').waitFor({state:'visible'});
      assert.equal(await page.textContent('#sessionError'),'Commissioner access is required.',label);
      await visible(page,{signOut:true,consoleCard:false,importCard:false,resultTableWrap:false,inviteResult:false,importResult:false});
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
    assert.match(await page.textContent('#inviteResult'),new RegExp(`^Invite ready: ${`${base}/participant.html?pool=it-pool#invite=${INVITE_OUT}`.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')} · expires `));
    const reloaded=page.waitForResponse(response=>response.url().endsWith('/rpc/pool_platform_commissioner_context'));
    await page.fill('#importText',IMPORT_CSV);await page.click('#runImport');
    await page.locator('#importResult').waitFor({state:'visible'});
    assert.match(await page.textContent('#importResult'),/^2 submitted · 0 source conflict\(s\) · 0 other error\(s\)\./);
    await reloaded;await settle(page);
    assert.deepEqual(world.calls.find(c=>c.name==='pool_platform_submit_batch').args.p_items.map(item=>item.entry_id),['entry-1','entry-2']);
    await page.fill('#importText','entry_code,g1,g2,tiebreak\nE01,home,home,30');
    await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
    await visible(page,signedOutConsole);
    await visible(page,{inviteResult:false,importError:false,importResult:false});
    await noConsoleLeft(page,'signed out');
    await signIn(page,'player@example.test');
    await page.locator('#sessionError').waitFor({state:'visible'});
    await noConsoleLeft(page,'next account',{signedOut:false});
    await clean(page,seen);
  });

  test('commissioner live → participant: the link shown carries the pool in its query and the token only in its fragment, and opening it claims that token',async()=>{
    const {page:consolePage,seen:consoleSeen}=await openConsole({world:consoleWorld(),signedInAs:'commish@example.test'});
    await consolePage.locator('#importCard').waitFor({state:'visible'});
    await consolePage.click('#createInvite');
    await consolePage.locator('#inviteResult').waitFor({state:'visible'});
    const link=new URL(/^Invite ready: (\S+) · expires /.exec(await consolePage.textContent('#inviteResult'))?.[1]);
    assert.equal(link.href,`${base}/participant.html?pool=it-pool#invite=${INVITE_OUT}`);
    assert.deepEqual([...link.searchParams],[['pool','it-pool']]);
    assert.equal(consolePage.url(),`${base}/commissioner.html`,'the commissioner page URL never holds a token');
    await clean(consolePage,consoleSeen);
    // The participant opens exactly that link.
    const world=liveWorld({invites:{[INVITE_OUT]:{email:'invited@example.test',entryId:'entry-1'}}});
    const {page,seen}=await openPage({world,signedInAs:'invited@example.test',query:link.href.slice(`${base}/participant.html`.length)});
    await page.locator('#entryCard').waitFor({state:'visible'});
    assert.equal(page.url(),`${base}/participant.html?pool=it-pool`);
    assert.deepEqual(world.calls.filter(c=>c.name==='pool_platform_claim_entry_invite').map(c=>[c.email,c.args.p_invite_token]),[['invited@example.test',INVITE_OUT]]);
    await inviteContained(page,world,seen,INVITE_OUT);
    await clean(page,seen);
  });

  test('commissioner live: an ambiguous entry code and a repeated entry are listed row by row and nothing is submitted',async()=>{
    const world=consoleWorld();
    world.console.seasons[0].entries.push(...['Fox1','FOX1'].map((entry_code,i)=>({id:`entry-f${i+1}`,entry_code,display_name:`Entry ${entry_code}`,status:'active',claimed:false,submissions:[]})));
    const {page,seen}=await openConsole({world,signedInAs:'commish@example.test'});
    await page.locator('#importCard').waitFor({state:'visible'});
    await page.fill('#importText','entry_code,g1,g2,tiebreak\nE01,away,home,47\nfox1,home,away,41\ne01,home,home,30\nFOX1,away,away,20');
    await page.click('#runImport');
    await page.locator('#resultTableWrap').waitFor({state:'visible'});
    assert.equal(await page.textContent('#importError'),'Import validation found 2 row error(s). Fix them before submission.');
    assert.deepEqual(await page.locator('#resultBody tr').evaluateAll(rows=>rows.map(row=>[...row.cells].map(cell=>cell.textContent))),[
      ['Row 3 · fox1','ambiguous_entry_code · matches entry codes Fox1 and FOX1 · type the entry code exactly as listed'],
      ['Row 4 · E01','duplicate_entry_row · entry E01 is already on row 2; keep one row per entry']
    ]);
    assert.equal(world.calls.filter(c=>c.name==='pool_platform_submit_batch').length,0,'no row is submitted while any row is rejected');
    await clean(page,seen);
  });

  test('commissioner sandbox: the synthetic console loads without Sign out and a sample import still reports its conflict',async()=>{
    const {page,seen}=await openConsole();
    await page.locator('#importCard').waitFor({state:'visible'});
    assert.equal(await page.textContent('#modePill'),'SANDBOX · synthetic');
    await visible(page,{signOut:false,authCard:false,sessionError:false,consoleCard:true});
    await page.click('#sampleImport');await page.click('#runImport');
    await page.locator('#importResult').waitFor({state:'visible'});
    assert.match(await page.textContent('#importResult'),/^1 submitted · 1 source conflict\(s\) · 0 other error\(s\)\./);
    await clean(page,seen);
  });

  test('commissioner mobile widths: no horizontal overflow, and Sign out stays on screen and works in the error and console states',async()=>{
    for(const width of [320,360,384,412]){
      for(const [signedInAs,ready] of [[null,'#authCard'],['player@example.test','#sessionError'],['commish@example.test','#importCard']]){
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
      const world=liveWorld({owners:{'entry-1':'player@example.test'}});world.authRequired={pool_platform_participant_context:1};
      const {page,seen}=await openPage({world,signedInAs:'player@example.test'});
      await page.locator('#pickForm').waitFor({state:'visible'});
      const loads=calls(world,'pool_platform_participant_context');
      assert.equal(loads.length,2);same(loads[0],loads[1],'context');
      await visible(page,{sessionError:false,entryCard:true,signOut:true});
      await clean(page,seen);
    }
    // A submit answers auth_required once: the first request did nothing, the resent one saves exactly once.
    {
      const world=liveWorld({owners:{'entry-1':'player@example.test'}});
      const {page,seen}=await openPage({world,signedInAs:'player@example.test'});
      await page.locator('#pickForm').waitFor({state:'visible'});
      world.authRequired={pool_platform_submit_entry:1};
      await pickAll(page,['away','home']);await page.fill('#tiebreak','47');await page.click('#submitBtn');
      await page.locator('#submittedMeta',{hasText:'Revision 1 '}).waitFor();
      const submits=calls(world,'pool_platform_submit_entry');
      assert.equal(submits.length,2);same(submits[0],submits[1],'submit');
      assert.equal(world.entries[0].submission.revision,1);
      await visible(page,{validation:false,sessionError:false});
      await clean(page,seen);
    }
    // auth_required twice: two requests, the friendly message, and no third request although it would succeed.
    {
      const world=liveWorld({owners:{'entry-1':'player@example.test'}});world.authRequired={pool_platform_participant_context:2};
      const {page,seen}=await openPage({world,signedInAs:'player@example.test'});
      await page.locator('#sessionError').waitFor({state:'visible'});
      assert.equal(await page.textContent('#sessionError'),SIGN_IN_NOT_CONFIRMED);
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
        assert.equal(await page.textContent('#modePill'),'UNAVAILABLE',label);
        for(const id of ['authCard','signOut','entryCard','pickForm','emptyCard','consoleCard','entriesCard','importCard']){
          if(await page.locator(`#${id}`).count())assert.equal(await page.isVisible(`#${id}`),false,`${label}: #${id}`);
        }
        assert.equal(errors.length,1,`${label}: the failed configuration import is the only error`);
        assert.deepEqual(await page.evaluate(()=>window.__csp),[],label);
      }
    }
  });

  test('service worker in Chromium: commercial scope, exactly the allow-list cached, the configuration never stored; offline the cached shell says so, and online a reload recovers',async()=>{
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
      const listed=['','index.html','participant.html','commissioner.html','styles.css','sw-register.js','participant.js','commissioner.js',
        'submission-core.js','participant-core.js','import-core.js','auth-core.js','platform-client.js','manifest.webmanifest'].map(asset=>`${origin}/${asset}`).sort();
      assert.deepEqual(await cached(),{'pool-platform-commercial-v4':listed});
      await page.goto(`${origin}/participant.html`);
      await page.locator('#pickForm').waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>navigator.serviceWorker.controller?.scriptURL),`${origin}/service-worker.js`);
      assert.deepEqual(await cached(),{'pool-platform-commercial-v4':listed},'loading the configuration stored nothing');
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
      assert.equal(await page.textContent('#modePill'),'SANDBOX · synthetic');
      assert.deepEqual(await cached(),{'pool-platform-commercial-v4':listed});
      assert.equal(errors.length,1,'only the offline configuration import failed');
      assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
    }finally{if(own.listening)await stop()}
  });

  test('service worker in Chromium: an invite fragment never reaches the host, a cache key or the address bar, online or offline',async()=>{
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
      const listed=['','index.html','participant.html','commissioner.html','styles.css','sw-register.js','participant.js','commissioner.js',
        'submission-core.js','participant-core.js','import-core.js','auth-core.js','platform-client.js','manifest.webmanifest'].map(asset=>`${origin}/${asset}`).sort();
      // Each link is opened from another page, so it is a real navigation through the worker, with and without a query.
      for(const [link,scrubbed] of [[`${origin}/participant.html?pool=demo#invite=${INVITE}`,`${origin}/participant.html?pool=demo`],
        [`${origin}/participant.html#invite=${INVITE}`,`${origin}/participant.html`]]){
        await page.goto(`${origin}/index.html`);
        await page.goto(link);
        await page.locator('#pickForm').waitFor({state:'visible'});
        assert.equal(page.url(),scrubbed);
      }
      assert.deepEqual(await cached(),{'pool-platform-commercial-v4':listed},'no invite link was stored');
      // The host unreachable: the worker serves the bare cached page, which scrubs the invite before its configuration
      // import fails.
      await page.goto(`${origin}/index.html`);
      await stop();
      await page.goto(`${origin}/participant.html#invite=${INVITE}`);
      await page.locator('#sessionError').waitFor({state:'visible'});
      assert.equal(await page.textContent('#sessionError'),CONFIG_UNAVAILABLE);
      assert.equal(page.url(),`${origin}/participant.html`);
      assert.deepEqual(await cached(),{'pool-platform-commercial-v4':listed});
      assert.equal(own.targets.some(target=>target.includes(INVITE)||target.includes('#')),false,JSON.stringify(own.targets));
      assert.ok(own.targets.includes('/participant.html?pool=demo')&&own.targets.includes('/participant.html'));
      assert.equal(requests.some(url=>url.includes(INVITE)||url.includes('#')),false,JSON.stringify(requests));
      assert.equal(errors.length,1,'only the offline configuration import failed');
      assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
    }finally{if(own.listening)await stop()}
  });

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
        assert.equal(await page.textContent('#modePill'),'LIVE · secure');
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

  test('real bundled SDK: signed in through the proxy and a stand-in Neon Auth, Chromium holds only the app\'s __Host- cookie, no script reads the session, the JWT is the Data API bearer, a planted duplicate fails closed, and sign-out deletes the cookie',{skip:ESBUILD?false:'run npm ci in pool-platform to bundle the real SDK'},async()=>{
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
  test('real bundled SDK: an invite link opened at scripts/serve.mjs and signed in through the same-origin Auth proxy keeps its token out of every request target, Auth call, log line, header and store; only the claim RPC body carries it',{skip:ESBUILD?false:'run npm ci in pool-platform to bundle the real SDK'},async()=>{
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
        // The Data API (cross-origin): this invite claims entry-1 once; the context then holds that entry.
        let claimed=false;
        await context.route('https://data.pool.test/**',route=>{
          const request=route.request(),cors={'access-control-allow-origin':origin,'access-control-allow-headers':'authorization, content-type, accept','access-control-allow-methods':'POST'};
          if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
          data.push({url:request.url(),headers:request.headers(),body:request.postData()});
          const reply=(status,body)=>route.fulfill({status,contentType:'application/json',headers:cors,body:JSON.stringify(body)});
          if(request.url()===`${DATA}/rpc/pool_platform_claim_entry_invite`){
            if(claimed||request.postDataJSON()?.p_invite_token!==INVITE)return reply(400,{message:'invite_unavailable'});
            claimed=true;return reply(200,{entry_id:'entry-1',claimed:true});
          }
          if(request.url()===`${DATA}/rpc/pool_platform_participant_context`)return claimed?reply(200,{...poolContext,entries:[entries[0]]}):reply(400,{message:'pool_not_found'});
          return reply(400,{message:'unexpected_rpc'});
        });
        const signIn=async()=>{
          await page.fill('#email','invited@example.test');await page.click('#sendCode');
          await page.locator('#otpWrap').waitFor({state:'visible'});
          await page.fill('#otp','123456');await page.click('#verifyCode');
          await page.locator('#entryCard').waitFor({state:'visible'});
        };
        await page.goto(`${local.url}participant.html?pool=it-pool#invite=${INVITE}`);
        await page.locator('#authCard').waitFor({state:'visible'});
        assert.equal(page.url(),`${local.url}participant.html?pool=it-pool`,'scrubbed before sign-in');
        await signIn();
        assert.equal(await page.isVisible('#sessionError'),false);
        // Signed out and in again on the same page: the claimed token is gone, so nothing is claimed twice.
        await page.click('#signOut');await page.locator('#authCard').waitFor({state:'visible'});
        await signIn();
        assert.equal(await page.isVisible('#sessionError'),false);
        // The one place the token travels: the claim RPC body, once, under the session's JWT.
        const claims=data.filter(call=>call.url===`${DATA}/rpc/pool_platform_claim_entry_invite`);
        assert.deepEqual(claims.map(call=>[call.body,call.headers.authorization]),[[JSON.stringify({p_invite_token:INVITE}),`Bearer ${JWT}`]]);
        for(const call of data)assert.equal(JSON.stringify(claims.includes(call)?{...call,body:null}:call).includes(INVITE),false,call.url);
        // Nowhere else: no request URL or header (the page, the Auth proxy, the Data API), nothing the proxy sent to Neon
        // Auth, no server or proxy log line, no console message, store or cookie, not the page and not the address bar.
        const auth=requests.filter(r=>new URL(r.url).pathname.startsWith('/api/auth/'));
        assert.deepEqual([...new Set(auth.map(r=>`${r.method} ${new URL(r.url).pathname}`))].sort(),
          ['GET /api/auth/get-session','POST /api/auth/email-otp/send-verification-otp','POST /api/auth/sign-in/email-otp','POST /api/auth/sign-out']);
        assert.ok(requests.some(r=>r.url===`${local.url}participant.html?pool=it-pool`),'the page was requested by its path and pool only');
        for(const [label,value] of [['browser requests',requests],['Neon Auth upstream',upstream],['server and proxy log',lines],['console',messages]]){
          assert.equal(JSON.stringify(value).includes(INVITE),false,label);
        }
        assert.ok(lines.includes('GET /participant.html 200')&&lines.includes('AUTH POST verify-otp 200'),JSON.stringify(lines));
        assert.equal(lines.some(line=>line.includes('#')||line.includes('invite')),false,JSON.stringify(lines));
        const stores=await page.evaluate(async()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookie:document.cookie,
          history:history.state,databases:await indexedDB.databases(),caches:await caches.keys()}));
        assert.equal(stores.includes(INVITE),false,stores);
        assert.equal(JSON.stringify(await context.cookies()).includes(INVITE),false);
        assert.equal((await page.content()).includes(INVITE),false);
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
  test('real bundled SDK: a sibling-host NBSP look-alike cookie is never read as the session, sends nothing upstream, and cannot override the genuine __Host- cookie (signed out, and beside a real session)',{skip:ESBUILD?false:'run npm ci in pool-platform to bundle the real SDK'},async()=>{
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
