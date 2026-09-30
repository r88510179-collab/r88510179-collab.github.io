import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./service-worker.js',import.meta.url),'utf8');
const index=readFileSync(new URL('./index.html',import.meta.url),'utf8');
for(const asset of [
  './weekly-app.js?v=weekly-v13',
  './public-math.js?v=2',
  './survivor-app.js?v=5',
  './survivor-math.js?v=5',
  './score-feed-proxy.js?v=2'
])assert(source.includes(`'${asset}'`),`precache must include ${asset}`);
assert(!source.includes("'./survivor-math.js?v=4'"));
assert(!source.includes("'./score-feed-proxy.js?v=1'"));
assert(!source.includes("'./admin/"),'Admin pages are network-dependent and must not be precached');
assert(index.includes('weekly-app.js?v=weekly-v13'));
assert(index.includes('survivor-app.js?v=5'));
assert(index.includes('score-feed-proxy.js?v=2'));

const listeners={},deleted=[],fetchCalls=[],matchCalls=[],putCalls=[];
let added=[],network=()=>okResponse;
const fallback={kind:'public-shell'},okResponse={ok:true,clone(){return this}};
const offline=new Error('offline'),cached=new Map([['./index.html',fallback]]);
const httpResponse=status=>{const response={status,ok:status>=200&&status<300,clone:()=>({status,ok:response.ok,cloneOf:response})};return response};
const cache={addAll:async assets=>{added=Array.from(assets)},put:async(request,response)=>{putCalls.push({request,response})}};
const caches={
  open:async()=>cache,
  keys:async()=>['pool-center-shell-v12','pool-center-shell-v13'],
  delete:async key=>{deleted.push(key);return true},
  match:async key=>{matchCalls.push(key);return cached.get(typeof key==='string'?key:key.url)}
};
const self={
  location:{origin:'https://example.test'},
  clients:{claim:async()=>{}},
  skipWaiting:async()=>{},
  addEventListener(t,f){listeners[t]=f}
};
const fetch=async request=>{fetchCalls.push(request);return network(request)};
vm.runInNewContext(source,{self,caches,fetch,URL,Promise,console});

let installPromise;
listeners.install({waitUntil:p=>{installPromise=p}});await installPromise;
assert(added.includes('./public-math.js?v=2'));
assert(added.includes('./survivor-math.js?v=5'));
assert(!added.some(x=>x.startsWith('./admin')));

let activatePromise;
listeners.activate({waitUntil:p=>{activatePromise=p}});await activatePromise;
// HDC-05 rolls the shell cache so a v12 cache that may hold runtime-cached Admin modules is deleted on activation.
assert.deepEqual(deleted,['pool-center-shell-v12']);

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
  const seen=[fetchCalls.length,matchCalls.length,putCalls.length];
  let responded,result,error;
  listeners.fetch({request,respondWith:p=>{responded=p}});
  try{result=await responded}catch(err){error=err}
  return{result,error,fetched:fetchCalls.slice(seen[0]),matched:matchCalls.slice(seen[1]),put:putCalls.slice(seen[2])};
}

// A. HTTP 503 with the requested resource cached: its last-good copy wins over the error and the shell.
for(const request of [page('/nfl-pool/?view=survivor'),asset('/nfl-pool/weekly-app.js?v=weekly-v13')]){
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
for(const request of [page('/nfl-pool/?view=home'),asset('/nfl-pool/weekly-app.js?v=weekly-v13')]){
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

console.log('service-worker precache graph, cache rollover, public fallback, HTTP error fallback, navigation redirect, public route boundary, Admin isolation and Admin path boundary regressions passed');
