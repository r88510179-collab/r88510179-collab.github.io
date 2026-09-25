import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./service-worker.js',import.meta.url),'utf8');
const index=readFileSync(new URL('./index.html',import.meta.url),'utf8');
for(const asset of [
  './weekly-app.js?v=weekly-v11',
  './public-math.js?v=2',
  './survivor-app.js?v=4',
  './survivor-math.js?v=4'
])assert(source.includes(`'${asset}'`),`precache must include ${asset}`);
assert(!source.includes("'./survivor-math.js?v=3'"));
assert(!source.includes("'./admin/"),'Admin pages are network-dependent and must not be precached');
assert(index.includes('weekly-app.js?v=weekly-v11'));
assert(index.includes('survivor-app.js?v=4'));

const listeners={},deleted=[],fetchCalls=[],matchCalls=[];
let added=[],fetchMode='ok';
const fallback={kind:'public-shell'},okResponse={ok:true,clone(){return this}};
const cache={addAll:async assets=>{added=Array.from(assets)},put:async()=>{}};
const caches={
  open:async()=>cache,
  keys:async()=>['pool-center-shell-v7','pool-center-shell-v8'],
  delete:async key=>{deleted.push(key);return true},
  match:async key=>{matchCalls.push(key);return key==='./index.html'?fallback:null}
};
const self={
  location:{origin:'https://example.test'},
  clients:{claim:async()=>{}},
  skipWaiting:async()=>{},
  addEventListener(t,f){listeners[t]=f}
};
const fetch=async request=>{fetchCalls.push(request);if(fetchMode==='throw')throw new Error('offline');return okResponse};
vm.runInNewContext(source,{self,caches,fetch,URL,Promise,console});

let installPromise;
listeners.install({waitUntil:p=>{installPromise=p}});await installPromise;
assert(added.includes('./public-math.js?v=2'));
assert(added.includes('./survivor-math.js?v=4'));
assert(!added.some(x=>x.startsWith('./admin')));

let activatePromise;
listeners.activate({waitUntil:p=>{activatePromise=p}});await activatePromise;
assert.deepEqual(deleted,['pool-center-shell-v7']);

const adminRequest={method:'GET',mode:'navigate',url:'https://example.test/nfl-pool/admin/survivor.html'};
let adminResponse;
const matchBefore=matchCalls.length;
listeners.fetch({request:adminRequest,respondWith:p=>{adminResponse=p}});
assert.equal(await adminResponse,okResponse);
assert.equal(matchCalls.length,matchBefore,'Admin navigation must not use a public-page fallback');

fetchMode='throw';
const publicRequest={method:'GET',mode:'navigate',url:'https://example.test/nfl-pool/?view=home'};
let publicResponse;
listeners.fetch({request:publicRequest,respondWith:p=>{publicResponse=p}});
assert.equal(await publicResponse,fallback,'offline public navigation should fall back to cached Pool Center shell');
assert(matchCalls.includes('./index.html'));

console.log('service-worker precache graph, cache rollover, public fallback and Admin isolation regressions passed');
