'use strict';
const CACHE='pool-center-shell-v8';
const SHELL=[
  './',
  './index.html',
  './style.css?v=premium-v3',
  './slate.css?v=slate-v1',
  './weekly.css?v=premium-v2',
  './weekly-app.js?v=weekly-v11',
  './public-math.js?v=2',
  './survivor.css?v=3',
  './survivor-app.js?v=4',
  './survivor-math.js?v=4',
  './score-feed-proxy.js?v=1',
  './pwa.js?v=1',
  './manifest.webmanifest',
  './assets/pool-center-icon.svg',
  './assets/pool-center-icon-192.svg',
  './assets/pool-center-icon-512.svg'
];
const DOCUMENT_PATHS=['/nfl-pool/','/nfl-pool/index.html'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
async function networkFirst(request,fallback){
  let response;
  try{
    response=await fetch(request);
    if(response&&response.type==='opaqueredirect')return response;
    if(response&&response.ok){
      const cache=await caches.open(CACHE);
      await cache.put(request,response.clone());
      return response;
    }
  }catch(err){
    const cached=await caches.match(request);
    if(cached)return cached;
    if(fallback){const f=await caches.match(fallback);if(f)return f}
    throw err;
  }
  const cached=await caches.match(request);
  if(cached)return cached;
  if(fallback){const f=await caches.match(fallback);if(f)return f}
  return response;
}
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(request.mode==='navigate'){
    if(/\/nfl-pool\/admin(?:\/|$)/.test(url.pathname)){event.respondWith(fetch(request));return}
    if(!DOCUMENT_PATHS.includes(url.pathname)){event.respondWith(fetch(request));return}
    event.respondWith(networkFirst(request,'./index.html'));
    return;
  }
  if(/\.(?:css|js|svg|webmanifest)$/i.test(url.pathname)||url.pathname.endsWith('/')){
    event.respondWith(networkFirst(request));
  }
});
