import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./service-worker.js',import.meta.url),'utf8');
const index=readFileSync(new URL('./index.html',import.meta.url),'utf8');
// HDC-12 regressions run through this collector so every one of them reports, not only the first; the suite fails at the
// end if any did.
const hdc12Failures=[];
const hdc12=async(name,check)=>{try{await check()}catch(error){hdc12Failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
const hdc14Failures=[];
const hdc14=async(name,check)=>{try{await check()}catch(error){hdc14Failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
// HDC-12 changes weekly-app.js, survivor-app.js, survivor-math.js, weekly.css and survivor.css and adds contest-rulings.js,
// so each is precached and loaded at its new version and none at the version it replaces.
await hdc12('HDC-12 precache and page versions',()=>{
  for(const asset of [
    './public-math.js?v=2',
    './survivor-math.js?v=7',
    './weekly.css?v=premium-v3',
    './survivor.css?v=4',
    './score-feed-proxy.js?v=2'
  ])assert(source.includes(`'${asset}'`),`precache must include ${asset}`);
  for(const [asset,label] of [['./weekly-app.js?v=weekly-v16','weekly-v16 module'],['./survivor-app.js?v=6','survivor-app v6 module'],
    ['./survivor-math.js?v=6','survivor-math v6 module'],['./weekly.css?v=premium-v2','weekly.css premium-v2 stylesheet'],['./survivor.css?v=3','survivor.css v3 stylesheet']])
    assert(!source.includes(`'${asset}'`),`the superseded ${label} must no longer be precached`);
  assert(!index.includes('weekly-app.js?v=weekly-v16'),'the Pool Center page must no longer load weekly-v16');
  assert(!index.includes('survivor-app.js?v=6'),'the Pool Center page must no longer load survivor-app v6');
  assert(index.includes('weekly.css?v=premium-v3')&&!index.includes('weekly.css?v=premium-v2'),'the Pool Center page must load weekly.css premium-v3 only');
  assert(index.includes('survivor.css?v=4')&&!index.includes('survivor.css?v=3'),'the Pool Center page must load survivor.css v4 only');
});
// HDC-14 changes contest-rulings.js (the absence evidence) and, through their imports, weekly-app.js and survivor-app.js:
// each is precached and loaded at its new version and none at the version it replaces. Nothing else moves.
await hdc14('HDC-14 precache and page versions',()=>{
  for(const asset of ['./weekly-app.js?v=weekly-v18','./survivor-app.js?v=8','./contest-rulings.js?v=2'])
    assert(source.includes(`'${asset}'`),`precache must include ${asset}`);
  for(const [asset,label] of [['./weekly-app.js?v=weekly-v17','weekly-v17 module'],['./survivor-app.js?v=7','survivor-app v7 module'],['./contest-rulings.js?v=1','contest-rulings v1 module']])
    assert(!source.includes(`'${asset}'`),`the superseded ${label} must no longer be precached`);
  assert(index.includes('weekly-app.js?v=weekly-v18')&&!index.includes('weekly-app.js?v=weekly-v17'),'the Pool Center page must load weekly-v18 only');
  assert(index.includes('survivor-app.js?v=8')&&!index.includes('survivor-app.js?v=7'),'the Pool Center page must load survivor-app v8 only');
});
assert(!source.includes("'./weekly-app.js?v=weekly-v15'"),'the superseded weekly-v15 module must no longer be precached');
assert(!source.includes("'./survivor-app.js?v=5'"),'the superseded survivor-app v5 module must no longer be precached');
assert(!source.includes("'./survivor-math.js?v=5'"),'the superseded survivor-math v5 module must no longer be precached');
assert(!source.includes("'./survivor-math.js?v=4'"));
assert(!source.includes("'./score-feed-proxy.js?v=1'"));
assert(!source.includes("'./admin/"),'Admin pages are network-dependent and must not be precached');
assert(!index.includes('weekly-app.js?v=weekly-v15'),'the Pool Center page must no longer load weekly-v15');
assert(!index.includes('survivor-app.js?v=5'),'the Pool Center page must no longer load survivor-app v5');
assert(index.includes('score-feed-proxy.js?v=2'));

const listeners={},deleted=[],fetchCalls=[],fetchInitCalls=[],matchCalls=[],putCalls=[],opened=[],addAllCalls=[];
let network=()=>okResponse,skipWaitingCalls=0;
const fallback={kind:'public-shell'},okResponse={ok:true,clone(){return this}};
const offline=new Error('offline'),cached=new Map([['./index.html',fallback]]);
const httpResponse=status=>{const response={status,ok:status>=200&&status<300,clone:()=>({status,ok:response.ok,cloneOf:response})};return response};
const cache={addAll:async requests=>{addAllCalls.push(Array.from(requests))},put:async(request,response)=>{putCalls.push({request,response})}};
const caches={
  open:async name=>{opened.push(name);return cache},
  keys:async()=>['pool-center-shell-v12','pool-center-shell-v13','pool-center-shell-v14','pool-center-shell-v15','pool-center-shell-v16','pool-center-shell-v17','pool-center-shell-v18','pool-center-shell-v19','pool-center-shell-v20','pool-center-shell-v21'],
  delete:async key=>{deleted.push(key);return true},
  match:async key=>{matchCalls.push(key);return cached.get(typeof key==='string'?key:key.url)}
};
// The worker is served at /nfl-pool/service-worker.js. In a ServiceWorkerGlobalScope a relative URL passed to new Request()
// resolves against the worker script's URL, as Cache.addAll resolves a URL string.
const workerURL='https://example.test/nfl-pool/service-worker.js';
// Test-only stand-in for the browser's Request: the resolved URL and the cache mode ('default' unless one is given) are all
// the install regressions inspect.
class Request{constructor(input,init={}){this.url=new URL(input,workerURL).href;this.cache=init.cache??'default'}}
const self={
  location:{origin:'https://example.test',href:workerURL},
  clients:{claim:async()=>{}},
  skipWaiting:async()=>{skipWaitingCalls++},
  addEventListener(t,f){listeners[t]=f}
};
const fetch=async(request,init)=>{fetchCalls.push(request);fetchInitCalls.push(init);return network(request,init)};
vm.runInNewContext(source,{self,caches,fetch,URL,Promise,console,Request});

let installPromise;
listeners.install({waitUntil:p=>{installPromise=p}});await installPromise;
// HDC-07. A request with the default cache mode may be answered from the browser's HTTP cache while that copy is fresh, and
// Pages serves max-age=600. cache.addAll(SHELL) passed URL strings, so a new shell cache could be filled with the page
// from before the deploy: pool-center-shell-v15 was observed holding an index.html that loads weekly-app.js?v=weekly-v13
// next to the weekly-v14 module. Install must give Cache.addAll one Request per shell asset with cache:'reload', which
// skips any HTTP-cache copy on the way to the origin and stores the origin's response in the HTTP cache on the way back,
// so a new shell cache holds one deployment.
const shell=[
  './','./index.html','./style.css?v=premium-v3','./slate.css?v=slate-v1','./weekly.css?v=premium-v3',
  './weekly-app.js?v=weekly-v18','./public-math.js?v=2','./survivor.css?v=4','./survivor-app.js?v=8','./survivor-math.js?v=7',
  './contest-rulings.js?v=2','./score-feed-proxy.js?v=2','./pwa.js?v=1','./manifest.webmanifest',
  './assets/pool-center-icon.svg','./assets/pool-center-icon-192.svg','./assets/pool-center-icon-512.svg'
].map(path=>new URL(path,workerURL).href);
assert.equal(addAllCalls.length,1,'install must precache the whole shell with one all-or-nothing Cache.addAll');
const installRequests=addAllCalls[0];
// It changes how each shell asset is fetched, never which: the HDC-06 shell, in the same order, every query string intact.
// A URL string is resolved as Cache.addAll would resolve it.
const precached=installRequests.map(request=>request instanceof Request?request.url:new URL(request,workerURL).href);
assert(precached.includes('https://example.test/nfl-pool/public-math.js?v=2'));
assert(!precached.some(url=>new URL(url).pathname.startsWith('/nfl-pool/admin')),'Admin pages must not be precached');
await hdc12('HDC-12 precached shell',()=>{
  assert(precached.includes('https://example.test/nfl-pool/survivor-math.js?v=7'),'survivor-math.js?v=7 must be precached');
  assert(precached.some(url=>/\/nfl-pool\/contest-rulings\.js\?v=\d+$/.test(url)),'the HDC-12 ruling evaluator must be precached');
});
await hdc14('HDC-14 precached shell',()=>{
  assert(precached.includes('https://example.test/nfl-pool/contest-rulings.js?v=2'),'the HDC-14 ruling evaluator (v2) must be precached');
  assert.deepEqual(precached,shell,'install must precache exactly the public shell, each asset at its own URL');
});
assert.deepEqual(installRequests.map(request=>request.cache),precached.map(()=>'reload'),
  'every shell asset must be requested with cache:"reload", never answered from a fresh HTTP-cache copy');
for(const mode of ['default','no-cache','no-store','force-cache','only-if-cached']){
  assert(!installRequests.some(request=>request.cache===mode),`no shell asset may be requested with cache:"${mode}"`);
}
assert(installRequests.every(request=>request instanceof Request),'install must give Cache.addAll Request objects, not URL strings');
await hdc14('HDC-14 weekly-v18 reload request',()=>assert.equal(installRequests[shell.indexOf('https://example.test/nfl-pool/weekly-app.js?v=weekly-v18')]?.url,
  'https://example.test/nfl-pool/weekly-app.js?v=weekly-v18','the reload request must keep the weekly-v18 query string'));
assert.deepEqual([fetchCalls.length,putCalls.length],[0,0],'install must fetch and store the shell only through Cache.addAll');
assert.equal(skipWaitingCalls,1,'a completed install skips waiting once');
await hdc14('HDC-14 install cache generation',()=>assert.deepEqual(opened,['pool-center-shell-v21'],'install must write the shell to pool-center-shell-v21'));
{
  // HDC-07 keeps Cache.addAll all-or-nothing. When any shell response is not OK the browser rejects addAll and stores none
  // of the shell; install must reject with that same error and never skip waiting, so the previous worker keeps control
  // with its complete shell instead of a partly filled one activating.
  const failure=new TypeError('Cache.addAll: ./survivor.css?v=3 answered HTTP 404'),failedListeners={},failedOpens=[],failedCalls=[];
  let failedSkips=0,failedInstall;
  vm.runInNewContext(source,{
    self:{location:self.location,clients:self.clients,skipWaiting:async()=>{failedSkips++},addEventListener(t,f){failedListeners[t]=f}},
    caches:{open:async name=>{failedOpens.push(name);return{addAll:async requests=>{failedCalls.push(Array.from(requests));throw failure},put:async()=>{throw new Error('install must not call cache.put')}}}},
    fetch:async()=>{throw new Error('install must not fetch outside Cache.addAll')},
    URL,Promise,console,Request
  });
  failedListeners.install({waitUntil:p=>{failedInstall=p}});
  await assert.rejects(failedInstall,error=>error===failure,'a shell asset that fails must fail the install with the Cache.addAll error');
  assert.equal(failedSkips,0,'a failed install must never skip waiting');
  assert.equal(failedCalls.length,1,'a failed Cache.addAll must not be retried or replaced by a partial precache');
  assert.equal(failedCalls[0].length,precached.length);
  await hdc14('HDC-14 failed-install cache generation',()=>assert.deepEqual(failedOpens,['pool-center-shell-v21']));
}

let activatePromise;
listeners.activate({waitUntil:p=>{activatePromise=p}});await activatePromise;
// HDC-05 rolls the shell cache so a v12 cache that may hold runtime-cached Admin modules is deleted on activation. Its
// corrective rolls it again: v13 was filled while noncanonical Admin paths (/nfl-pool//admin/, /nfl-pool/%61dmin/, ...)
// still reached networkFirst, so v13 may hold runtime-cached Admin modules under those paths and is deleted too. HDC-06
// rolls it to v15 with weekly-app.js?v=weekly-v14, so v14, which holds the weekly-v13 module and the page that loads it,
// is deleted as well. HDC-07 rolls it to v16: v15 may have been installed from still-fresh HTTP-cache copies, such as the
// page from before the HDC-06 deploy that loads weekly-v13, so v15 is deleted too. HDC-08 rolls it to v17 because v16
// may already contain runtime responses accepted from a still-fresh browser HTTP-cache copy. HDC-10 rolls it to v18 with
// weekly-app.js?v=weekly-v15, so v17, which holds the weekly-v14 module and the page that loads it, is deleted as well.
// HDC-11 rolls it to v19 with weekly-app.js?v=weekly-v16, survivor-app.js?v=6 and survivor-math.js?v=6, so v18, which
// holds the weekly-v15, survivor-app v5 and survivor-math v5 modules and the page that loads them, is deleted too.
// HDC-12 rolls it to v20 with weekly-app.js?v=weekly-v17, survivor-app.js?v=7, survivor-math.js?v=7, weekly.css premium-v3,
// survivor.css v4 and the new contest-rulings.js?v=1, so v19, which holds the modules, stylesheets and page they replace,
// is deleted too. HDC-14 rolls it to v21 with weekly-app.js?v=weekly-v18, survivor-app.js?v=8 and contest-rulings.js?v=2, so
// v20, which holds the weekly-v17, survivor-app v7 and contest-rulings v1 modules and the page that loads them, is deleted
// too. Only v21 is kept.
await hdc14('HDC-14 activation rollover',()=>assert.deepEqual(deleted,['pool-center-shell-v12','pool-center-shell-v13','pool-center-shell-v14','pool-center-shell-v15','pool-center-shell-v16','pool-center-shell-v17','pool-center-shell-v18','pool-center-shell-v19','pool-center-shell-v20'],'activation must delete v12 through v20 and keep only v21'));

const adminRequest={method:'GET',mode:'navigate',url:'https://example.test/nfl-pool/admin/survivor.html'};
let adminResponse;
const matchBefore=matchCalls.length;
listeners.fetch({request:adminRequest,respondWith:p=>{adminResponse=p}});
assert.equal(await adminResponse,okResponse);
assert.equal(matchCalls.length,matchBefore,'Admin navigation must not use a public-page fallback');

network=()=>{throw offline};
const publicRequest={method:'GET',mode:'navigate',url:'https://example.test/nfl-pool/?view=home'};
let publicResponse;
listeners.fetch({request:publicRequest,respondWith:p=>{publicResponse=p}});
assert.equal(await publicResponse,fallback,'offline public navigation should fall back to cached Pool Center shell');
assert(matchCalls.includes('./index.html'));

const page=path=>({method:'GET',mode:'navigate',url:`https://example.test${path}`});
const asset=path=>({method:'GET',mode:'no-cors',url:`https://example.test${path}`});
async function route(request){
  const seen=[fetchCalls.length,matchCalls.length,putCalls.length],initBefore=fetchInitCalls.length;
  let responded,result,error;
  listeners.fetch({request,respondWith:p=>{responded=p}});
  try{result=await responded}catch(err){error=err}
  return{result,error,fetched:fetchCalls.slice(seen[0]),fetchInit:fetchInitCalls.slice(initBefore),matched:matchCalls.slice(seen[1]),put:putCalls.slice(seen[2])};
}

// HDC-08. Model the browser HTTP cache separately from the origin. With ordinary default fetch semantics, a still-fresh
// response from the prior deployment wins. Managed runtime requests must instead use reload semantics, reach the NEW
// origin response, return it, and write only that NEW response into the active Cache API generation.
for(const request of [
  page('/nfl-pool/'),
  page('/nfl-pool/index.html'),
  page('/nfl-pool/?view=survivor'),
  page('/nfl-pool/?view=survivor&sw=4&season=2026'),
  asset('/nfl-pool/weekly-app.js?v=weekly-v17')
]){
  const stale=httpResponse(200),fresh=httpResponse(200);
  network=(_request,init)=>init?.cache==='reload'?fresh:stale;
  assert.equal(network(request),stale,`the modeled default-cache fetch for ${request.url} must receive the OLD HTTP-cache response`);
  const seen=await route(request);
  assert.equal(seen.result,fresh,`${request.url} must bypass the stale ordinary HTTP cache and return the NEW origin response`);
  assert.deepEqual(seen.fetched,[request]);
  assert.equal(seen.fetchInit.length,1);
  assert.equal(seen.fetchInit[0]?.cache,'reload',`${request.url} runtime fetch must force HTTP-cache reload semantics`);
  assert.deepEqual(seen.matched,[],'a successful fresh runtime response must not consult the Cache API fallback');
  assert.equal(seen.put.length,1,'a successful fresh runtime response must be cached');
  assert.equal(seen.put[0].request,request,'the fresh response must be cached under the originally requested resource');
  assert.equal(seen.put[0].response.cloneOf,fresh,'only the NEW origin response may be written into the active Cache API generation');
}

// A. HTTP 503 with the requested resource cached: its last-good copy wins over the error and the shell.
for(const request of [page('/nfl-pool/?view=survivor'),asset('/nfl-pool/weekly-app.js?v=weekly-v17')]){
  const lastGood=httpResponse(200),unavailable=httpResponse(503);
  cached.set(request.url,lastGood);
  network=()=>unavailable;
  const {result,matched,put}=await route(request);
  assert.equal(result,lastGood,`HTTP 503 for ${request.url} must serve its cached copy, not the error`);
  assert.deepEqual(matched,[request],'the requested resource is looked up before any configured fallback');
  assert.deepEqual(put,[],'an HTTP 503 must never be written to the cache');
  cached.delete(request.url);
}
{
  // B. HTTP 503 for a page that is not cached: the configured Pool Center shell fallback is served.
  const request=page('/nfl-pool/?view=weekly'),unavailable=httpResponse(503);
  network=()=>unavailable;
  const {result,matched,put}=await route(request);
  assert.equal(result,fallback,'HTTP 503 for an uncached page must fall back to the cached Pool Center shell');
  assert.deepEqual(matched,[request,'./index.html']);
  assert.deepEqual(put,[],'an HTTP 503 must never be written to the cache');
}
{
  // C. HTTP 503 with no cached copy and no configured fallback: the original response is returned as-is.
  const request=asset('/nfl-pool/slate.css?v=slate-v1'),unavailable=httpResponse(503);
  network=()=>unavailable;
  const {result,matched,put}=await route(request);
  assert.equal(result,unavailable,'with nothing cached the original HTTP 503 must be returned, not a replacement');
  assert.deepEqual(matched,[request]);
  assert.deepEqual(put,[],'an HTTP 503 must never be written to the cache');
}
{
  // C. The shell fallback is configured but not cached: the original response is still returned as-is.
  cached.delete('./index.html');
  const request=page('/nfl-pool/?view=weekly'),unavailable=httpResponse(503);
  network=()=>unavailable;
  const {result,matched,put}=await route(request);
  assert.equal(result,unavailable,'with neither the page nor the shell cached the original HTTP 503 must be returned');
  assert.deepEqual(matched,[request,'./index.html']);
  assert.deepEqual(put,[],'an HTTP 503 must never be written to the cache');
  cached.set('./index.html',fallback);
}
// D. HTTP 200: the network response itself is returned and a clone is cached under the request, as before.
for(const request of [page('/nfl-pool/?view=home'),asset('/nfl-pool/weekly-app.js?v=weekly-v17')]){
  const fresh=httpResponse(200);
  network=()=>fresh;
  const {result,matched,put}=await route(request);
  assert.equal(result,fresh,'a successful network response must be returned as-is');
  assert.equal(put.length,1,'a successful network response must be cached');
  assert.equal(put[0].request,request,'the successful response is cached under the requested resource');
  assert.equal(put[0].response.cloneOf,fresh,'the cache receives a clone of the successful response');
  assert.deepEqual(matched,[],'a successful network response does not consult the cache');
}
{
  // E. fetch throws with the requested resource cached: the cached copy is still served, before the shell.
  const request=page('/nfl-pool/?view=survivor'),lastGood=httpResponse(200);
  cached.set(request.url,lastGood);
  network=()=>{throw offline};
  const {result,matched,put}=await route(request);
  assert.equal(result,lastGood,'offline navigation must serve the cached requested page');
  assert.deepEqual(matched,[request]);
  assert.deepEqual(put,[]);
  cached.delete(request.url);
}
{
  // fetch throws with nothing cached and no configured fallback: the original network error still propagates.
  const request=asset('/nfl-pool/slate.css?v=slate-v1');
  network=()=>{throw offline};
  const {result,error,matched}=await route(request);
  assert.equal(error,offline,'an uncached offline request must reject with the original network error');
  assert.equal(result,undefined);
  assert.deepEqual(matched,[request]);
}
{
  // F. Admin navigation stays direct-network: neither an HTTP error nor an offline failure is replaced by a
  // cached copy or the public shell, even when both are available, and no Admin response is cached.
  const request=page('/nfl-pool/admin/'),unavailable=httpResponse(503),fresh=httpResponse(200);
  cached.set(request.url,httpResponse(200));
  network=()=>unavailable;
  let seen=await route(request);
  assert.equal(seen.result,unavailable,'Admin navigation must return the direct network response, even an HTTP error');
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[],'Admin navigation must not consult the cache or the public-page fallback');
  assert.deepEqual(seen.put,[]);
  network=()=>{throw offline};
  seen=await route(request);
  assert.equal(seen.error,offline,'offline Admin navigation must fail rather than receive the public shell');
  assert.deepEqual(seen.matched,[]);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[],'Admin navigation responses are never cached');
  cached.delete(request.url);
}
{
  // G. A public navigation the origin answers with a redirect reaches the worker as an opaqueredirect (status 0,
  // ok false). It is a redirect, not an HTTP error: the exact response is returned so the browser follows it, even
  // with the requested page and the Pool Center shell both cached; neither is consulted and nothing is cached.
  const request=page('/nfl-pool/?view=survivor'),lastGood=httpResponse(200);
  const redirect={type:'opaqueredirect',status:0,ok:false,clone:()=>({type:'opaqueredirect',status:0,ok:false,cloneOf:redirect})};
  cached.set(request.url,lastGood);
  assert.equal(cached.get(request.url),lastGood,'the requested page is cached for this regression');
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  network=()=>redirect;
  let seen=await route(request);
  assert.equal(seen.result,redirect,'a public navigation redirect must be returned unchanged, not a cached page or the shell');
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[],'a redirect must consult neither the requested page cache nor the ./index.html fallback');
  assert.deepEqual(seen.put,[],'a redirect must never be written to the cache');
  // With only the shell cached, the redirect is still not replaced by the ./index.html fallback.
  cached.delete(request.url);
  seen=await route(request);
  assert.equal(seen.result,redirect,'a public navigation redirect must not be replaced by the cached shell');
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  // A non-OK response that is not a redirect, such as an HTTP 404, still takes the HTTP error fallback.
  cached.set(request.url,lastGood);
  network=()=>Object.assign(httpResponse(404),{type:'basic'});
  seen=await route(request);
  assert.equal(seen.result,lastGood,'an HTTP 404 must still serve the cached copy of the requested page');
  assert.deepEqual(seen.matched,[request]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}

// Route boundary (RB). Pool Center is one document, /nfl-pool/ or /nfl-pool/index.html, whose views are selected by
// query string (?view=home, ?view=survivor, ...), never by pathname. index.html loads its CSS, JavaScript and icons by
// relative URL, so the shell renders only at those two paths. Any other navigation under the /nfl-pool/ scope is not a
// Pool Center route: it gets the exact network result, never a cached copy of itself or the ./index.html shell, and the
// worker neither reads nor writes the cache for it.
const opaqueRedirect=()=>{const response={type:'opaqueredirect',status:0,ok:false,clone:()=>({type:'opaqueredirect',status:0,ok:false,cloneOf:response})};return response};
const outcome=response=>response.type==='opaqueredirect'?'a redirect':`HTTP ${response.status}`;
const documentPaths=['/nfl-pool/','/nfl-pool/index.html','/nfl-pool/?view=home','/nfl-pool/?view=survivor','/nfl-pool/?view=survivor&sw=3&season=2026','/nfl-pool/index.html?view=picks'];
const invalidPaths=['/nfl-pool/assets/','/nfl-pool/foo','/nfl-pool/assets/missing/','/nfl-pool/not-a-route','/nfl-pool/assets/?view=home','/nfl-pool/foo?view=survivor&sw=3&season=2026','/nfl-pool/index.html/','/nfl-pool/assets/index.html'];
for(const path of documentPaths){
  // RB-A, RB-B, RB-C. Both document paths, with or without a query string, keep the HDC-02 navigation behavior.
  const request=page(path),lastGood=httpResponse(200);
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  for(const status of [404,503]){
    // RB-K. An HTTP error serves the cached copy of the requested page, else the ./index.html shell, else the original
    // response; it is never cached.
    const failed=httpResponse(status);
    network=()=>failed;
    cached.set(request.url,lastGood);
    let seen=await route(request);
    assert.equal(seen.result,lastGood,`HTTP ${status} for ${path} must serve the cached copy of the requested page`);
    assert.deepEqual(seen.fetched,[request]);
    assert.deepEqual(seen.matched,[request],'the requested page is looked up before the shell');
    assert.deepEqual(seen.put,[],`HTTP ${status} must never be written to the cache`);
    cached.delete(request.url);
    seen=await route(request);
    assert.equal(seen.result,fallback,`HTTP ${status} for uncached ${path} must fall back to the cached Pool Center shell`);
    assert.deepEqual(seen.matched,[request,'./index.html']);
    assert.deepEqual(seen.put,[]);
    cached.delete('./index.html');
    seen=await route(request);
    assert.equal(seen.result,failed,`HTTP ${status} for ${path} with nothing cached must be returned as-is`);
    assert.deepEqual(seen.matched,[request,'./index.html']);
    assert.deepEqual(seen.put,[]);
    cached.set('./index.html',fallback);
  }
  // RB-L. A thrown fetch serves the cached copy of the requested page, else the shell, else rejects with the original
  // network error.
  network=()=>{throw offline};
  cached.set(request.url,lastGood);
  let seen=await route(request);
  assert.equal(seen.result,lastGood,`offline ${path} must serve the cached copy of the requested page`);
  assert.deepEqual(seen.matched,[request]);
  cached.delete(request.url);
  seen=await route(request);
  assert.equal(seen.result,fallback,`offline uncached ${path} must fall back to the cached Pool Center shell`);
  assert.deepEqual(seen.matched,[request,'./index.html']);
  cached.delete('./index.html');
  seen=await route(request);
  assert.equal(seen.error,offline,`offline ${path} with nothing cached must reject with the original network error`);
  assert.deepEqual(seen.matched,[request,'./index.html']);
  assert.deepEqual(seen.put,[]);
  cached.set('./index.html',fallback);
  // RB-M. A successful response is returned as-is and a clone is cached under the request.
  const fresh=httpResponse(200);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh,`a successful ${path} response must be returned as-is`);
  assert.deepEqual(seen.matched,[]);
  assert.equal(seen.put.length,1,`a successful ${path} response must be cached`);
  assert.equal(seen.put[0].request,request);
  assert.equal(seen.put[0].response.cloneOf,fresh);
  // RB-N. A redirect is returned unchanged, even with the requested page cached, and is never cached.
  const redirect=opaqueRedirect();
  network=()=>redirect;
  cached.set(request.url,lastGood);
  seen=await route(request);
  assert.equal(seen.result,redirect,`a ${path} redirect must be returned unchanged`);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
{
  // RB-D, RB-F, RB-G, RB-H. The production-observed case: /nfl-pool/assets/ is a directory, not a Pool Center route.
  // Its HTTP 404 is returned unchanged whether the invalid URL itself, the ./index.html shell, both or neither are
  // cached; the worker calls neither caches.match nor cache.put for it.
  const request=page('/nfl-pool/assets/'),notFound=httpResponse(404);
  network=()=>notFound;
  for(const [state,urlCached,shellCached] of [
    ['the invalid URL and the shell both cached',true,true],
    ['only the invalid URL cached',true,false],
    ['only the ./index.html shell cached',false,true],
    ['nothing cached',false,false]
  ]){
    if(urlCached)cached.set(request.url,httpResponse(200));else cached.delete(request.url);
    if(shellCached)cached.set('./index.html',fallback);else cached.delete('./index.html');
    const seen=await route(request);
    assert.equal(seen.result,notFound,`HTTP 404 for /nfl-pool/assets/ with ${state} must be returned unchanged`);
    assert.deepEqual(seen.fetched,[request]);
    assert.deepEqual(seen.matched,[],`/nfl-pool/assets/ with ${state} must not call caches.match`);
    assert.deepEqual(seen.put,[],`/nfl-pool/assets/ with ${state} must not call cache.put`);
  }
  cached.delete(request.url);
  cached.set('./index.html',fallback);
}
for(const path of invalidPaths){
  // RB-E, RB-C, RB-H. Every invalid public pathname, nested or not, with or without a query string, and near-misses of
  // the two document paths get the exact network result even with their own URL and the shell cached.
  const request=page(path);
  cached.set(request.url,httpResponse(200));
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  for(const response of [httpResponse(404),httpResponse(500),httpResponse(503),opaqueRedirect()]){
    network=()=>response;
    const seen=await route(request);
    assert.equal(seen.result,response,`${outcome(response)} for ${path} must be returned unchanged`);
    assert.deepEqual(seen.fetched,[request]);
    assert.deepEqual(seen.matched,[],`${path} is not a Pool Center route and must not call caches.match`);
    assert.deepEqual(seen.put,[],`${path} is not a Pool Center route and must not call cache.put`);
  }
  // RB-I. A successful response is returned directly and is not cached by this worker.
  const fresh=httpResponse(200);
  network=()=>fresh;
  let seen=await route(request);
  assert.equal(seen.result,fresh,`a successful ${path} response must be returned as-is`);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[],`a successful ${path} response must not be cached by this worker`);
  // RB-J. A thrown fetch propagates the original network failure; no cached copy or shell replaces it.
  network=()=>{throw offline};
  seen=await route(request);
  assert.equal(seen.error,offline,`offline ${path} must reject with the original network error`);
  assert.equal(seen.result,undefined);
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
for(const path of ['/nfl-pool/admin','/nfl-pool/admin/','/nfl-pool/admin/survivor.html?season=2026']){
  // RB-O. Admin navigation stays direct-network: an HTTP 404 is returned unchanged with the Admin page and the shell
  // cached, and a successful response is not cached.
  const request=page(path),notFound=httpResponse(404),fresh=httpResponse(200);
  cached.set(request.url,httpResponse(200));
  network=()=>notFound;
  let seen=await route(request);
  assert.equal(seen.result,notFound,`Admin ${path} must return the direct network response`);
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[],'Admin navigation must not consult the cache or the public shell');
  assert.deepEqual(seen.put,[]);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[],'Admin navigation responses are never cached');
  cached.delete(request.url);
}
for(const path of ['/nfl-pool/style.css?v=premium-v3','/nfl-pool/pwa.js?v=1','/nfl-pool/assets/pool-center-icon.svg','/nfl-pool/manifest.webmanifest']){
  // RB-P. Public static assets keep networkFirst with their own cached copy as the only fallback: an HTTP 404 or a
  // thrown fetch serves the cached copy, an uncached 404 is returned as-is (never the shell), and a success is cached.
  const request=asset(path),lastGood=httpResponse(200),notFound=httpResponse(404),fresh=httpResponse(200);
  cached.set(request.url,lastGood);
  network=()=>notFound;
  let seen=await route(request);
  assert.equal(seen.result,lastGood,`HTTP 404 for ${path} must serve its cached copy`);
  assert.deepEqual(seen.matched,[request]);
  assert.deepEqual(seen.put,[]);
  network=()=>{throw offline};
  seen=await route(request);
  assert.equal(seen.result,lastGood,`offline ${path} must serve its cached copy`);
  assert.deepEqual(seen.matched,[request]);
  cached.delete(request.url);
  network=()=>notFound;
  seen=await route(request);
  assert.equal(seen.result,notFound,`HTTP 404 for uncached ${path} must be returned as-is, never the shell`);
  assert.deepEqual(seen.matched,[request]);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh);
  assert.equal(seen.put.length,1,`a successful ${path} response must be cached`);
  assert.equal(seen.put[0].request,request);
}

// Admin boundary (AB). Admin is production write-capable, so the worker never decides that an older copy of an Admin page,
// module or stylesheet may stand in for its current network representation. Every same-origin GET whose pathname is
// exactly /nfl-pool/admin or begins /nfl-pool/admin/ is direct network whatever its request mode, file extension or query
// string: the worker calls fetch(request) once and returns exactly what it yields, an HTTP error included, lets a thrown
// fetch reject with the original error, and never calls caches.match or cache.put for it, even with a copy of that Admin
// resource and the ./index.html shell both cached. The boundary is the request's own pathname: the shared public resources
// an Admin page loads, and paths that merely begin with "admin", keep the existing public routing.
const adminLoad=(path,mode)=>({method:'GET',mode,url:`https://example.test${path}`,referrer:'https://example.test/nfl-pool/admin/'});
async function assertDirectNetwork(request,label){
  cached.set(request.url,httpResponse(200));
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  for(const response of [httpResponse(200),httpResponse(404),httpResponse(500),httpResponse(503),opaqueRedirect()]){
    network=()=>response;
    const seen=await route(request);
    assert.equal(seen.result,response,`${outcome(response)} for Admin ${label} must be returned exactly, never a cached copy`);
    assert.equal(seen.fetched.length,1,`Admin ${label} must be fetched from the network once`);
    assert.equal(seen.fetched[0],request,`Admin ${label} must be fetched as requested`);
    assert.equal(seen.fetchInit.length,1);
    assert.equal(seen.fetchInit[0],undefined,`Admin ${label} must keep ordinary direct-network fetch semantics`);
    assert.deepEqual(seen.matched,[],`Admin ${label} must not call caches.match`);
    assert.deepEqual(seen.put,[],`Admin ${label} must not call cache.put`);
  }
  network=()=>{throw offline};
  const seen=await route(request);
  assert.equal(seen.error,offline,`offline Admin ${label} must reject with the original network error, never a cached copy`);
  assert.equal(seen.result,undefined);
  assert.equal(seen.fetched.length,1);
  assert.deepEqual(seen.matched,[],`offline Admin ${label} must not call caches.match`);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
async function assertNetworkFirst(request,label){
  const lastGood=httpResponse(200),notFound=httpResponse(404),fresh=httpResponse(200);
  cached.set(request.url,lastGood);
  for(const response of [httpResponse(404),httpResponse(503)]){
    network=()=>response;
    const seen=await route(request);
    assert.equal(seen.result,lastGood,`${outcome(response)} for ${label} must still serve its cached copy`);
    assert.deepEqual(seen.matched,[request]);
    assert.deepEqual(seen.put,[]);
  }
  network=()=>{throw offline};
  let seen=await route(request);
  assert.equal(seen.result,lastGood,`offline ${label} must still serve its cached copy`);
  assert.deepEqual(seen.matched,[request]);
  cached.delete(request.url);
  network=()=>notFound;
  seen=await route(request);
  assert.equal(seen.result,notFound,`HTTP 404 for uncached ${label} must be returned as-is, never the shell`);
  assert.deepEqual(seen.matched,[request]);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh);
  assert.deepEqual(seen.matched,[]);
  assert.equal(seen.put.length,1,`a successful ${label} response must still be cached`);
  assert.equal(seen.put[0].request,request);
  assert.equal(seen.put[0].response.cloneOf,fresh);
}
for(const [url,mode] of [
  ['/nfl-pool/admin/admin.js?v=10','cors'],                  // module script of admin/index.html (Pick'em Admin)
  ['/nfl-pool/admin/parser-core.js?v=11','cors'],            // imported by admin.js
  ['/nfl-pool/admin/survivor-admin.js?v=3','cors'],          // module script of admin/survivor.html (Survivor Admin)
  ['/nfl-pool/admin/survivor-parser.js?v=3','cors'],         // imported by survivor-admin.js and survivor-publish-checks.js
  ['/nfl-pool/admin/survivor-publish-checks.js?v=2','cors'], // imported by survivor-admin.js
  ['/nfl-pool/admin/admin.css?v=premium-v3','no-cors']       // stylesheet of both Admin pages
]){
  // AB-A, AB-B, AB-C. The current Admin module or stylesheet URL, in the mode its page requests it: a success is not
  // cached, an HTTP 404/500/503 is not replaced by the cached copy, and a thrown fetch is not answered from the cache.
  await assertDirectNetwork(adminLoad(url,mode),url);
  // AB-D. Only the pathname decides: another version, or no query string at all, routes identically.
  const pathname=url.slice(0,url.indexOf('?'));
  for(const other of [`${pathname}?v=999`,pathname])await assertDirectNetwork(adminLoad(other,mode),other);
  // AB-E. So does every other request mode, a navigation to the file included.
  for(const other of ['cors','no-cors','same-origin','navigate'].filter(m=>m!==mode))await assertDirectNetwork(adminLoad(url,other),`${url} (${other})`);
}
for(const path of ['/nfl-pool/admin','/nfl-pool/admin/','/nfl-pool/admin/index.html','/nfl-pool/admin/survivor.html']){
  // AB-F. Admin page navigations keep their direct-network behavior, and a non-navigation request for the same Admin
  // path is direct network too instead of reaching the public static-resource cache.
  await assertDirectNetwork(page(path),`${path} navigation`);
  await assertDirectNetwork(adminLoad(path,'cors'),path);
}
for(const path of ['/nfl-pool/administrator/','/nfl-pool/admin-old.js','/nfl-pool/admin2/','/nfl-pool/admin.js?v=10','/nfl-pool/assets/nfl-pool/admin/admin.js']){
  // AB-G. The gate has a path boundary and is anchored at the start of the pathname: siblings that merely begin with
  // "admin", an Admin-named file outside the directory and a path that nests the Admin directory deeper are not Admin.
  // As subresources they keep networkFirst; as navigations they stay non-document routes with the exact network result.
  await assertNetworkFirst(asset(path),path);
  const request=page(path),notFound=httpResponse(404);
  cached.set(request.url,httpResponse(200));
  network=()=>notFound;
  const seen=await route(request);
  assert.equal(seen.result,notFound,`${path} navigation is not a Pool Center route: its HTTP 404 must be returned unchanged`);
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
for(const [path,mode] of [
  ['/nfl-pool/style.css?v=premium-v3','no-cors'],
  ['/nfl-pool/slate.css?v=slate-v1','no-cors'],
  ['/nfl-pool/score-feed-proxy.js?v=2','no-cors'],
  ['/nfl-pool/pwa.js?v=1','no-cors'],
  ['/nfl-pool/assets/pool-center-icon.svg','no-cors'],
  ['/nfl-pool/manifest.webmanifest','cors'],
  ['/nfl-pool/survivor-math.js?v=4','cors']                  // imported by admin/survivor-publish-checks.js
]){
  // AB-H. The boundary is the request's own pathname, never the page that asked for it: the shared public resources the
  // Admin pages load keep networkFirst with their own cached copy as the only fallback.
  await assertNetworkFirst(adminLoad(path,mode),`${path} requested by an Admin page`);
}
{
  // AB-I. An Admin path that appears only in the query string does not make a public request Admin: the public asset
  // keeps networkFirst and the public document keeps the HDC-02 shell fallback.
  await assertNetworkFirst(asset('/nfl-pool/style.css?v=premium-v3&from=/nfl-pool/admin/'),'a public asset with an Admin path in its query');
  const request=page('/nfl-pool/?view=home&from=/nfl-pool/admin/'),unavailable=httpResponse(503);
  network=()=>unavailable;
  const seen=await route(request);
  assert.equal(seen.result,fallback,'an Admin path in the query string must not take a public document out of the shell fallback');
  assert.deepEqual(seen.matched,[request,'./index.html']);
  assert.deepEqual(seen.put,[]);
}
for(const request of [
  {method:'POST',mode:'cors',url:'https://example.test/nfl-pool/admin/admin.js?v=10'},
  {method:'GET',mode:'cors',url:'https://cdn.example/nfl-pool/admin/admin.js?v=10'}
]){
  // AB-J. The gate runs after the existing GET and same-origin checks: a non-GET request and another origin's Admin-shaped
  // path are still left to the browser, untouched by the worker.
  network=()=>okResponse;
  const seen=await route(request);
  assert.deepEqual(seen.fetched,[],`${request.method} ${request.url} must not be handled by the worker`);
  assert.equal(seen.result,undefined);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
}
for(const [path,mode] of [
  ['/nfl-pool/admin/sub/path/module.js','cors'],
  ['/nfl-pool/admin/sub/path/module.js?v=1','cors'],
  ['/nfl-pool/admin/sub/path/theme.css?v=1','no-cors'],
  ['/nfl-pool/admin/sub/path/icon.svg','no-cors'],
  ['/nfl-pool/admin/sub/','cors'],
  ['/nfl-pool/admin/sub/path/module.js','navigate'],
  ['/nfl-pool/admin/sub/','navigate']
]){
  // AB-K. Every depth below /nfl-pool/admin/ is Admin: a nested module, stylesheet, icon or directory, requested as a
  // subresource or navigated to, is direct network exactly like a top-level Admin file, with its own stale copy and the
  // shell both cached.
  await assertDirectNetwork(adminLoad(path,mode),`${path} (${mode})`);
}
async function assertExactNavigation(path){
  const request=page(path),notFound=httpResponse(404);
  cached.set(request.url,httpResponse(200));
  network=()=>notFound;
  const seen=await route(request);
  assert.equal(seen.result,notFound,`${path} navigation is not a Pool Center route: its HTTP 404 must be returned unchanged`);
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
for(const path of ['/nfl-pool/admin.css','/nfl-pool/admin.css?v=premium-v3']){
  // AB-L. A stylesheet beside the Admin directory whose name merely begins with "admin" is not the Admin stylesheet
  // (/nfl-pool/admin/admin.css): as a subresource it keeps networkFirst with its own cached copy as the only fallback,
  // and as a navigation it keeps the exact network result.
  await assertNetworkFirst(asset(path),path);
  await assertExactNavigation(path);
}
for(const path of ['/nfl-pool/administrator','/nfl-pool/administer','/nfl-pool/admin-old']){
  // AB-M. Extensionless siblings that merely begin with "admin" are not Admin. An Admin path is always answered with
  // fetch(request); these are not static resources either, so in every subresource mode the worker still leaves them to
  // the browser, even with a copy of them cached, and as navigations they keep the exact network result.
  for(const mode of ['cors','no-cors','same-origin']){
    const request={...asset(path),mode};
    cached.set(request.url,httpResponse(200));
    network=()=>okResponse;
    const seen=await route(request);
    assert.deepEqual(seen.fetched,[],`${path} (${mode}) is not Admin and must not be answered by the worker`);
    assert.equal(seen.result,undefined);
    assert.deepEqual(seen.matched,[]);
    assert.deepEqual(seen.put,[]);
    cached.delete(request.url);
  }
  await assertExactNavigation(path);
}

// Noncanonical Admin paths (NC). GitHub Pages also serves the Admin directory at spellings other than /nfl-pool/admin/:
// it decodes each %XX escape once, merges repeated slashes and then removes dot segments, so /nfl-pool//admin/,
// /nfl-pool///admin/, /nfl-pool/%61dmin/, /nfl-pool/a%64min/, /nfl-pool%2Fadmin/ and /nfl-pool/x%2F..%2Fadmin/ all return
// the real Admin page and modules (checked against production with read-only GETs). An Admin page opened at such a path
// loads its modules and stylesheet relative to it, under the same spelling. Every such request is Admin and gets exactly
// the direct-network behavior of the canonical path, fetched as it was made; paths that only look similar, and the shared
// public resources such a page loads, keep their existing routing.
const ncLoad=(path,mode,referrer='/nfl-pool//admin/')=>({method:'GET',mode,url:`https://example.test${path}`,referrer:`https://example.test${referrer}`});
const allModes=['navigate','cors','no-cors','same-origin'];
{
  // NC-A. The production defect. With a stale copy of the Pick'em Admin module cached under the spelling its page at
  // /nfl-pool//admin/ requests, a success must be returned without being cached, and an HTTP 503 must be returned as the
  // 503 itself, never answered with the stale copy of write-capable Admin code.
  const request=ncLoad('/nfl-pool//admin/admin.js?v=10','cors'),stale=httpResponse(200),fresh=httpResponse(200),unavailable=httpResponse(503);
  const answered=response=>response===stale?'the stale cached copy':response===fresh?'the network HTTP 200':response===unavailable?'the network HTTP 503':'another response';
  cached.set(request.url,stale);
  network=()=>fresh;
  const healthy=await route(request);
  network=()=>unavailable;
  const failed=await route(request);
  cached.delete(request.url);
  assert.deepEqual({
    'HTTP 200 answered with':answered(healthy.result),'HTTP 200 cache.put calls':healthy.put.length,
    'HTTP 503 answered with':answered(failed.result),'HTTP 503 caches.match calls':failed.matched.length
  },{
    'HTTP 200 answered with':'the network HTTP 200','HTTP 200 cache.put calls':0,
    'HTTP 503 answered with':'the network HTTP 503','HTTP 503 caches.match calls':0
  },'/nfl-pool//admin/admin.js?v=10 is Admin: it must be direct network, never cached and never answered from the cache');
}
for(const path of ['/nfl-pool//admin/','/nfl-pool//admin/admin.js?v=10','/nfl-pool///admin/parser-core.js?v=11']){
  // NC-B. The repeated-slash Admin directory and the modules its page loads, in every request mode: a success is not
  // cached, an HTTP 404/500/503 or a redirect is returned exactly and a thrown fetch rejects, with a stale copy of the
  // resource and the shell both cached. Two slashes or three make no difference.
  for(const mode of allModes)await assertDirectNetwork(ncLoad(path,mode),`${path} (${mode})`);
}
for(const path of ['/nfl-pool/%61dmin/','/nfl-pool/%61dmin/admin.js?v=10','/nfl-pool/a%64min/','/nfl-pool/a%64min/parser-core.js?v=11']){
  // NC-C. A percent-encoded letter of "admin" names the same directory, in every request mode, for the directory itself
  // and for its modules alike.
  for(const mode of allModes)await assertDirectNetwork(ncLoad(path,mode,'/nfl-pool/%61dmin/'),`${path} (${mode})`);
}
for(const prefix of [
  '/nfl-pool//admin/','/nfl-pool///admin/','/nfl-pool////admin/','//nfl-pool/admin/','/nfl-pool//admin//',
  '/nfl-pool/%61dmin/','/nfl-pool/a%64min/','/nfl-pool/%61%64%6D%69%6E/','/nfl-pool/%61%64%6d%69%6e/',
  '/nfl-pool%2Fadmin/','/nfl-pool/admin%2F','/nfl-pool%2F%2Fadmin%2F','/nfl-pool/.%2Fadmin/',
  '/nfl-pool/x%2F..%2Fadmin/','/nfl-pool/x%2F%2E%2E%2Fadmin/','/nfl-pool/x//..%2Fadmin/'
]){
  // NC-D. Every current Admin page, module and stylesheet, in the mode its page requests it, under each spelling Pages
  // resolves to /nfl-pool/admin/: repeated slashes anywhere, encoded letters in either hex case, an encoded slash, an
  // encoded single-dot segment, and an encoded dot-dot segment that climbs back into the Admin directory (Pages merges
  // repeated slashes before removing it).
  for(const [file,mode] of [
    ['index.html','navigate'],['survivor.html','navigate'],['admin.css?v=premium-v3','no-cors'],
    ['admin.js?v=10','cors'],['parser-core.js?v=11','cors'],['survivor-admin.js?v=3','cors'],
    ['survivor-parser.js?v=3','cors'],['survivor-publish-checks.js?v=2','cors']
  ])await assertDirectNetwork(ncLoad(prefix+file,mode,prefix),`${prefix}${file} (${mode})`);
}
for(const path of ['/nfl-pool//admin/%E0%A4%A.js','/nfl-pool/%61dmin/%ZZ.js','/nfl-pool/a%64min/%','/nfl-pool//admin/%C3.css']){
  // NC-E. A malformed escape (a % without two hex digits after it, or an incomplete UTF-8 sequence) is one that
  // decodeURIComponent cannot decode. It must never throw out of the fetch handler: it stays literal text and the rest of
  // the path is still classified, so a request inside the Admin directory stays Admin and direct network (Pages answers
  // such a path HTTP 400, which reaches the page exactly) ...
  for(const mode of ['cors','navigate'])await assertDirectNetwork(ncLoad(path,mode),`${path} (${mode})`);
}
for(const path of ['/nfl-pool/%ZZ/style.css','/nfl-pool//%E0%A4%A.css','/nfl-pool/adm%ZZin/admin.js','/nfl-pool/%61dm%ZZin/x.js']){
  // ... while a malformed escape anywhere else, including inside what would be the "admin" segment, does not make a
  // public request Admin: as a subresource it keeps networkFirst, and as a navigation the exact network result.
  await assertNetworkFirst(asset(path),path);
  await assertExactNavigation(path);
}
for(const path of [
  '/nfl-pool//administrator/','/nfl-pool//admin-old.js','/nfl-pool//admin2/',
  '/nfl-pool/%61dministrator/','/nfl-pool/%61dmin-old.js','/nfl-pool/%61dmin2/',
  '/nfl-pool/%2561dmin/admin.js?v=10','/nfl-pool/Admin/admin.js?v=10','/nfl-pool/admin%5Cadmin.js?v=10',
  '/nfl-pool//..%2Fadmin/admin.js?v=10','/nfl-pool/admin%2F..%2Fstyle.css?v=premium-v3'
]){
  // NC-F. Normalization does not widen the boundary. Siblings that merely begin with "admin" stay public however they are
  // spelled, and so do the spellings Pages itself does not resolve into the Admin directory: a double-encoded escape
  // (decoded once, it is %61dmin), another letter case, an encoded backslash, a dot segment that climbs out of /nfl-pool/
  // before "admin" (the slashes merge first, so it lands on /admin/) and one that climbs out of the Admin directory to a
  // public file. As subresources they keep networkFirst with their own cached copy as the only fallback, and as
  // navigations the exact network result.
  await assertNetworkFirst(asset(path),path);
  await assertExactNavigation(path);
}
for(const query of ['from=/nfl-pool//admin/','from=/nfl-pool/%61dmin/','from=%2Fnfl-pool%2F%2Fadmin%2F']){
  // NC-G. A noncanonical Admin spelling that appears only in the query string does not make a public request Admin: the
  // public asset keeps networkFirst and the public document keeps the HDC-02 shell fallback.
  await assertNetworkFirst(asset(`/nfl-pool/style.css?v=premium-v3&${query}`),`a public asset with ${query} in its query`);
  const request=page(`/nfl-pool/?view=home&${query}`),unavailable=httpResponse(503);
  network=()=>unavailable;
  const seen=await route(request);
  assert.equal(seen.result,fallback,`${query} in the query string must not take a public document out of the shell fallback`);
  assert.deepEqual(seen.matched,[request,'./index.html']);
  assert.deepEqual(seen.put,[]);
}
for(const request of [
  {method:'POST',mode:'cors',url:'https://example.test/nfl-pool//admin/admin.js?v=10'},
  {method:'POST',mode:'navigate',url:'https://example.test/nfl-pool/%61dmin/'},
  {method:'GET',mode:'cors',url:'https://cdn.example/nfl-pool//admin/admin.js?v=10'},
  {method:'GET',mode:'cors',url:'https://cdn.example/nfl-pool/%61dmin/admin.js?v=10'}
]){
  // NC-H. Normalization runs after the existing GET and same-origin checks: a non-GET request and another origin's
  // noncanonical Admin-shaped path are still left to the browser, untouched by the worker.
  network=()=>okResponse;
  const seen=await route(request);
  assert.deepEqual(seen.fetched,[],`${request.method} ${request.url} must not be handled by the worker`);
  assert.equal(seen.result,undefined);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
}
for(const [path,mode,referrer] of [
  ['/nfl-pool//style.css?v=premium-v3','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//slate.css?v=slate-v1','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//score-feed-proxy.js?v=2','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//pwa.js?v=1','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//assets/pool-center-icon.svg','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//manifest.webmanifest','cors','/nfl-pool//admin/'],
  ['/nfl-pool//survivor-math.js?v=4','cors','/nfl-pool//admin/survivor-publish-checks.js?v=2'],
  ['/nfl-pool///style.css?v=premium-v3','no-cors','/nfl-pool///admin/'],
  ['/nfl-pool///survivor-math.js?v=4','cors','/nfl-pool///admin/survivor-publish-checks.js?v=2'],
  ['/nfl-pool/style.css?v=premium-v3','no-cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/slate.css?v=slate-v1','no-cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/score-feed-proxy.js?v=2','no-cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/pwa.js?v=1','no-cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/survivor-math.js?v=4','cors','/nfl-pool/%61dmin/survivor-publish-checks.js?v=2'],
  ['/nfl-pool/manifest.webmanifest','cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/weekly-app.js?v=weekly-v17','cors','/nfl-pool/'],
  ['/nfl-pool/assets/pool-center-icon-192.svg','no-cors','/nfl-pool/'],
  ['/nfl-pool/assets/pool-center-icon-512.svg','no-cors','/nfl-pool/']
]){
  // NC-I. The shared public resources a noncanonical Admin page loads are not Admin: by ../ from /nfl-pool//admin/ they
  // keep the repeated slash, from /nfl-pool/%61dmin/ they are the canonical public files. Like the rest of the public
  // static shell they keep networkFirst with their own cached copy as the only fallback.
  await assertNetworkFirst(ncLoad(path,mode,referrer),`${path} requested by ${referrer}`);
}
for(const path of ['/nfl-pool//','/nfl-pool//index.html','/nfl-pool///?view=home','/nfl-pool/%69ndex.html','/nfl-pool/index%2Ehtml']){
  // NC-J. Only the Admin gate reads the normalized path. The Pool Center document is still exactly /nfl-pool/ or
  // /nfl-pool/index.html as written (its relative assets resolve only there), so another spelling of either is not a
  // document path: it gets the exact network result, never the shell or a cached copy, and nothing is cached for it.
  const request=page(path);
  cached.set(request.url,httpResponse(200));
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  for(const response of [httpResponse(404),httpResponse(503),httpResponse(200)]){
    network=()=>response;
    const seen=await route(request);
    assert.equal(seen.result,response,`${outcome(response)} for ${path} must be returned unchanged`);
    assert.deepEqual(seen.fetched,[request]);
    assert.deepEqual(seen.matched,[],`${path} is not a document path and must not call caches.match`);
    assert.deepEqual(seen.put,[],`${path} is not a document path and must not call cache.put`);
  }
  network=()=>{throw offline};
  const seen=await route(request);
  assert.equal(seen.error,offline,`offline ${path} must reject with the original network error, never the shell`);
  assert.deepEqual(seen.matched,[]);
  cached.delete(request.url);
}
for(const path of ['/nfl-pool/admin/x%2F..%2F..%2Fstyle.css?v=premium-v3','/nfl-pool/admin/%2E%2E%2Fslate.css?v=slate-v1','/nfl-pool/admin/..%2F..%2Findex.html']){
  // NC-K. Normalization only adds Admin spellings and never removes one: a pathname that begins /nfl-pool/admin/ as
  // written stays Admin, as HDC-05 made it, even where an encoded dot segment reads it out of the Admin directory (Pages
  // answers the first with the public stylesheet). It is direct network in every request mode, never a cached copy.
  for(const mode of allModes)await assertDirectNetwork(ncLoad(path,mode,'/nfl-pool/admin/'),`${path} (${mode})`);
}
// Every cache the worker opened, at install and before each runtime cache.put above, is pool-center-shell-v21.
assert.equal(opened.length,1+putCalls.length,'install and each runtime cache.put open the shell cache once');
await hdc14('HDC-14 runtime cache generation',()=>assert.deepEqual([...new Set(opened)],['pool-center-shell-v21'],'the worker must write only to pool-center-shell-v21'));

// ---- HDC-12 version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v19 (main 8caafa6): an asset whose bytes changed is requested at a new version, an asset whose bytes did
// not change keeps its version (no unrelated bump), a new asset carries an explicit version, and any change to the shell's
// contents rolls the shell cache. The page, the worker and the public modules reference each shell asset at exactly its
// precached version and at no other.
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const sha=path=>{const b=bytes(path);return b?createHash('sha256').update(b).digest('hex'):null};
  const V19={
    'index.html':[null,'f1eb28a1d4a3dff17638f0842846e5bc9dad4bdea39cd9fa6eb1123f1ec308c7'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v2','93125860c48b3cbeed37419fe04a375a02130e90647c629e53def1db804107ab'],
    'weekly-app.js':['weekly-v16','b95b5bb5e124f211bd76e1b65eab1dc94ae6ada109ff781431fd93a7b2263112'],
    'public-math.js':['2','1dd847931f83cc021341a657b8913eab208a8ab62721705b5cf4cd0803cc79db'],
    'survivor.css':['3','6f3da84a8772d14ba35bbade0c83168a0715a1019d58ae97d8ad35685d73c396'],
    'survivor-app.js':['6','460f7acae675c983911831022bbd4790faab28a687ce15956f30b4b609d6b7ef'],
    'survivor-math.js':['6','505b10a7c67b53144ddd72d30b88920a6d80b30bef06b98b510c6835a3c507aa'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=precached.map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await hdc12('HDC-12 changed bytes roll the version, unchanged bytes keep it',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V19[path];
      if(!before){if(!version)problems.push(`${path} is new to the shell and must carry an explicit version`);continue}
      const changed=sha(path)!==before[1];
      if(before[0]===null)continue; // unversioned (the page, the manifest, the icons): only the shell cache can roll
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
    }
    assert.deepEqual(problems,[]);
  });
  await hdc12('HDC-12 shell cache rolls when shell contents change',()=>{
    const shellChanged=entries.some(({path})=>!V19[path]||sha(path)!==V19[path][1])||Object.keys(V19).some(path=>!entries.some(e=>e.path===path));
    assert(shellChanged,'HDC-12 changes the shell');
    assert.notEqual(cacheName,'pool-center-shell-v19','a changed shell must not reuse pool-center-shell-v19');
  });
  await hdc12('HDC-12 references match the precache exactly',()=>{
    const shellVersion=new Map(entries.map(e=>[e.path,e.version]));
    const refs=[...index.matchAll(/(?:src|href)="([^":]+?\.(?:js|css)(?:\?[^"]*)?)"/g)].map(m=>['index.html',m[1]]);
    for(const file of ['weekly-app.js','survivor-app.js','survivor-math.js','contest-rulings.js','public-math.js']){
      const text=bytes(file)?.toString('utf8');
      if(text)for(const m of text.matchAll(/(?:from|import)\s*\(?\s*'(\.\/[^']+)'/g))refs.push([file,m[1]]);
    }
    for(const app of ['weekly-app.js','survivor-app.js'])
      assert(refs.some(([from,ref])=>from===app&&/^\.\/contest-rulings\.js\?v=\d+$/.test(ref)),`${app} must import the versioned ./contest-rulings.js`);
    for(const [from,ref] of refs){
      const u=new URL(ref,'https://example.test/nfl-pool/'),path=u.pathname.replace('/nfl-pool/','');
      assert(shellVersion.has(path),`${from} loads ${ref}, which must be precached`);
      assert.equal(u.searchParams.get('v'),shellVersion.get(path),`${from} must load ${path} at its precached version`);
    }
    // No stale query string: each versioned shell asset is named at one version only in the worker and the page.
    for(const {path,version} of entries)if(version){
      const escaped=path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      for(const [label,text] of [['service-worker.js',source],['index.html',index]]){
        const versions=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert(versions.size<=1&&(!versions.size||versions.has(version)),`${label} names ${path} at ${[...versions].join(', ')}; only v=${version} is precached`);
      }
    }
  });
  // Review-driven regression (added after the implementation's adversarial review): both apps render their Rules & rulings
  // card into a container the page must actually have; the app harnesses create any element they are asked for.
  await hdc12('index.html has exactly one Rules & rulings container in each contest panel',()=>{
    // A panel runs from its opening tag to its own matching </section>, never into the markup that follows it.
    const panelOf=name=>{
      const start=index.indexOf(`<section class="view-panel" data-view-panel="${name}"`),tags=/<section\b[^>]*>|<\/section>/g;
      if(start<0)return'';
      tags.lastIndex=start;let depth=0,m;
      while((m=tags.exec(index))){depth+=m[0][1]==='/'?-1:1;if(!depth)return index.slice(start,m.index)}
      return'';
    };
    for(const [id,panel] of [['pickemRules','games'],['svRules','survivor']]){
      assert.equal(index.split(`id="${id}"`).length-1,1,`index.html has exactly one #${id}`);
      assert(panelOf(panel).includes(`id="${id}"`),`#${id} is inside the ${panel} panel`);
    }
  });
}

// ---- HDC-14 version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v20 (main 6a3c6a7, the production baseline): an asset whose bytes changed is requested at a new version,
// an asset whose bytes did not change keeps its version (no unrelated bump), and any change to the shell's contents rolls
// the shell cache to v21. The public modules reference the evaluator at exactly its precached version.
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const sha=path=>{const b=bytes(path);return b?createHash('sha256').update(b).digest('hex'):null};
  const V20={
    'index.html':[null,'73673852dbd92ac0661898b1cc4c9b51f9e7ffd4307657dea6231f7867352a9e'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v17','98fbf75550a86aefe8a71271ed5934cfc8a96df6684609ae1f3cc401ed022974'],
    'public-math.js':['2','1dd847931f83cc021341a657b8913eab208a8ab62721705b5cf4cd0803cc79db'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['7','4b5e8256aabb60e4dc135751d6b8a09b958f1ac9859ae55f596c549a4c06eb25'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['1','10ce2d245e396c404697fb8d2628785a9d5dccfe7df3cac42e5722d51926556a'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=precached.map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await hdc14('HDC-14 changed bytes roll the version, unchanged bytes keep it (against pool-center-shell-v20)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V20[path];
      if(!before){problems.push(`${path} is new to the shell: HDC-14 adds no shell asset`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
    }
    for(const path of ['contest-rulings.js','weekly-app.js','survivor-app.js'])if(sha(path)===V20[path][1])problems.push(`${path} must change for HDC-14`);
    for(const path of ['survivor-math.js','public-math.js','style.css','slate.css','weekly.css','survivor.css','score-feed-proxy.js','pwa.js'])
      if(sha(path)!==V20[path][1])problems.push(`${path} is outside HDC-14 and must keep its bytes`);
    assert.deepEqual(problems,[]);
  });
  await hdc14('HDC-14 shell cache rolls from pool-center-shell-v20 to v21',()=>{
    assert.notEqual(cacheName,'pool-center-shell-v20','a changed shell must not reuse pool-center-shell-v20');
    assert.equal(cacheName,'pool-center-shell-v21');
  });
  await hdc14('HDC-14 both apps import the evaluator at its precached version (contest-rulings.js?v=2)',()=>{
    for(const app of ['weekly-app.js','survivor-app.js'])
      assert(bytes(app)?.toString('utf8').includes("from './contest-rulings.js?v=2';"),`${app} must import ./contest-rulings.js?v=2`);
  });
}

assert.equal(hdc12Failures.length,0,`HDC-12 service-worker regressions failed (${hdc12Failures.length}):\n  ${hdc12Failures.join('\n  ')}`);
assert.equal(hdc14Failures.length,0,`HDC-14 service-worker regressions failed (${hdc14Failures.length}):\n  ${hdc14Failures.join('\n  ')}`);

console.log('service-worker precache graph (HDC-14 versions), fresh (cache:"reload") precache requests, all-or-nothing install, cache rollover, public fallback, HTTP error fallback, navigation redirect, public route boundary, Admin isolation, Admin path boundary and noncanonical Admin path regressions passed');
