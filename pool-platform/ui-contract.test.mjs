import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
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

test('commissioner UI exposes invite and conflict-report workflows',()=>{
  assert.match(commissioner,/createInvite/);
  assert.match(commissioner,/submitBatch/);
  assert.match(commissioner,/source conflict/i);
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
