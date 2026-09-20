'use strict';
const CACHE='pool-center-shell-v1';
const SHELL=[
  './',
  './index.html',
  './style.css?v=premium-v1',
  './slate.css?v=slate-v1',
  './weekly.css?v=premium-v1',
  './weekly-app.js?v=weekly-v5',
  './score-feed-proxy.js?v=1',
  './pwa.js?v=1',
  './manifest.webmanifest',
  './assets/pool-center-icon.svg',
  './admin/',
  './admin/index.html',
  './admin/admin.css?v=premium-v1',
  './admin/admin.js?v=4',
  './admin/parser-core.js?v=4'
];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
async function networkFirst(request,fallback){
  try{
    const response=await fetch(request);
    if(response&&response.ok){const cache=await caches.open(CACHE);cache.put(request,response.clone())}
    return response;
  }catch(err){
    const cached=await caches.match(request);
    if(cached)return cached;
    if(fallback){const f=await caches.match(fallback);if(f)return f}
    throw err;
  }
}
async function staleWhileRevalidate(request){
  const cache=await caches.open(CACHE);
  const cached=await cache.match(request);
  const network=fetch(request).then(response=>{if(response&&response.ok)cache.put(request,response.clone());return response}).catch(()=>null);
  return cached||network||Response.error();
}
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(request.mode==='navigate'){
    const fallback=url.pathname.includes('/admin/')?'./admin/index.html':'./index.html';
    event.respondWith(networkFirst(request,fallback));
    return;
  }
  if(/\.(?:css|js|svg|webmanifest)$/i.test(url.pathname)||url.pathname.endsWith('/')){
    event.respondWith(staleWhileRevalidate(request));
  }
});
