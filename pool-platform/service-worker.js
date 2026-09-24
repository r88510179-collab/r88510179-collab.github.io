// The commercial app shares its origin, and so Cache Storage, with other apps. This worker only ever deletes
// caches in its own namespace and only stores an explicit list of same-origin static files at their bare
// paths: never auth or Data API traffic, cross-origin requests, or any URL with a query string (invites).
const CACHE_PREFIX='pool-platform-commercial-';
const CACHE=`${CACHE_PREFIX}v3`;
const ASSETS=[
  './','./index.html','./participant.html','./commissioner.html','./styles.css',
  './participant.js','./commissioner.js','./submission-core.js','./participant-core.js',
  './import-core.js','./auth-core.js','./platform-config.js','./platform-client.js','./manifest.webmanifest'
];
const STATIC_PATHS=new Set(ASSETS.map(asset=>new URL(asset,self.location).pathname));

function isStaticAsset(request,url){
  return request.method==='GET'&&url.origin===self.location.origin&&url.search===''&&
    STATIC_PATHS.has(url.pathname)&&!request.headers.has('authorization');
}

function fromOwnCache(key){
  return caches.open(CACHE).then(cache=>cache.match(key));
}

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==CACHE).map(key=>caches.delete(key))
  )).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  const cacheable=isStaticAsset(request,url);
  if(request.mode!=='navigate'&&!cacheable)return;
  event.respondWith(fetch(request).then(response=>{
    if(cacheable&&response.ok&&response.type==='basic'&&!response.redirected){
      const copy=response.clone();
      event.waitUntil(caches.open(CACHE).then(cache=>cache.put(request,copy)).catch(()=>{}));
    }
    return response;
  }).catch(()=>{
    // Offline: serve the cached copy of the same page with any query string dropped (the query itself is
    // never a cache key), falling back to the landing page.
    const bare=url.origin+url.pathname;
    return (STATIC_PATHS.has(url.pathname)?fromOwnCache(bare):Promise.resolve(undefined))
      .then(hit=>hit||(request.mode==='navigate'?fromOwnCache(new URL('./index.html',self.location).href):undefined))
      .then(hit=>hit||Response.error());
  }));
});
