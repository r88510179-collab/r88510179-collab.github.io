'use strict';
const CACHE='pool-center-shell-v17';
const SHELL=[
  './',
  './index.html',
  './style.css?v=premium-v3',
  './slate.css?v=slate-v1',
  './weekly.css?v=premium-v2',
  './weekly-app.js?v=weekly-v14',
  './public-math.js?v=2',
  './survivor.css?v=3',
  './survivor-app.js?v=5',
  './survivor-math.js?v=5',
  './score-feed-proxy.js?v=2',
  './pwa.js?v=1',
  './manifest.webmanifest',
  './assets/pool-center-icon.svg',
  './assets/pool-center-icon-192.svg',
  './assets/pool-center-icon-512.svg'
];
const DOCUMENT_PATHS=['/nfl-pool/','/nfl-pool/index.html'];
const ADMIN_PATH='/nfl-pool/admin';
// Pages also serves Admin at equivalent spellings (/nfl-pool//admin/, /nfl-pool/%61dmin/, /nfl-pool/x%2F..%2Fadmin/): it
// decodes each %XX once, merges repeated slashes, then drops dot segments. Classify the path as written and as Pages reads it.
// Only ASCII escapes can spell the boundary, so malformed or non-ASCII ones stay literal text and nothing here throws.
function isAdminPath(pathname){
  const segments=[];
  for(const segment of pathname.replace(/%([0-7][0-9a-f])/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))).split('/')){
    if(segment==='..')segments.pop();
    else if(segment!==''&&segment!=='.')segments.push(segment);
  }
  return [pathname,'/'+segments.join('/')].some(path=>path===ADMIN_PATH||path.startsWith(ADMIN_PATH+'/'));
}
// Install fetches each shell asset from the origin (cache:'reload'), never from a still-fresh HTTP-cache copy, so a new
// shell cache holds one deployment and the HTTP cache is refreshed with it. Cache.addAll stays all-or-nothing.
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(asset=>new Request(asset,{cache:'reload'})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
// The network leg fetches a copy of the request with cache:'reload', like install, so a still-fresh HTTP-cache copy of an
// earlier deployment never answers it and lands in this shell cache. Cache entries stay keyed by the request itself.
async function networkFirst(request,fallback){
  let response;
  try{
    response=await fetch(new Request(request,{cache:'reload'}));
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
  if(isAdminPath(url.pathname)){event.respondWith(fetch(request));return}
  if(request.mode==='navigate'){
    if(!DOCUMENT_PATHS.includes(url.pathname)){event.respondWith(fetch(request));return}
    event.respondWith(networkFirst(request,'./index.html'));
    return;
  }
  if(/\.(?:css|js|svg|webmanifest)$/i.test(url.pathname)||url.pathname.endsWith('/')){
    event.respondWith(networkFirst(request));
  }
});
