'use strict';
const CACHE='pool-center-shell-v42';
const SHELL=[
  './',
  './index.html',
  './style.css?v=premium-v3',
  './slate.css?v=slate-v1',
  './weekly.css?v=premium-v3',
  './weekly-app.js?v=weekly-v27',
  './public-math.js?v=3',
  './survivor.css?v=4',
  './survivor-app.js?v=12',
  './survivor-math.js?v=7',
  './contest-rulings.js?v=2',
  './score-feed-proxy.js?v=2',
  './pool-alerts.mjs?v=1',
  './push-client.mjs?v=1',
  './pwa.js?v=1',
  './share-card.js?v=2',
  './swing-card.js?v=1',
  './share-ui.js?v=3',
  './share.css?v=2',
  './home-dashboard.js?v=2',
  './home-dashboard.css?v=2',
  './picks-mobile.js?v=5',
  './picks-mobile.css?v=5',
  './season-record.js?v=1',
  './season-record.css?v=1',
  './week-date-range.js?v=2',
  './week-selector.css?v=1',
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
async function networkFirst(request,fallback){
  let response;
  try{
    // Runtime-managed Pool Center requests must not promote a still-fresh HTTP-cache copy from an older deploy into
    // this Cache API generation. Reload bypasses that copy while preserving the existing network-first fallback contract.
    response=await fetch(request,{cache:'reload'});
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

// BEGIN POOL ALERTS PUSH
function pushIdentity(p){
  return p&&Number.isInteger(p.season)&&p.season>=2000&&p.season<=2100&&Number.isInteger(p.week)&&p.week>=1&&p.week<=18&&Number.isSafeInteger(p.revision)&&p.revision>=1&&['release','correction'].includes(p.kind);
}
self.addEventListener('push',event=>{
  let p;try{p=event.data?.json()}catch{return}
  if(!pushIdentity(p))return;
  const title='Week '+p.week+(p.kind==='correction'?' picks updated':' official picks are live!');
  event.waitUntil(self.registration.showNotification(title,{
    body:p.kind==='correction'?'A new official revision is available. Tap to view.':'The official picks have been released. Tap to view.',
    tag:'pool-alerts-'+p.season+'-'+p.week+'-'+p.revision,
    icon:'/nfl-pool/assets/pool-center-icon-192.svg',
    data:{season:p.season,week:p.week,revision:p.revision,kind:p.kind}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const p=event.notification.data;
  if(!pushIdentity(p))return;
  const target=new URL('/nfl-pool/',self.location.origin);
  target.searchParams.set('view','picks');target.searchParams.set('season',String(p.season));target.searchParams.set('week',String(p.week));
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
    const existing=clients.find(c=>c.url===target.href);
    if(existing)return existing.focus();
    return self.clients.openWindow(target.href);
  }));
});
// END POOL ALERTS PUSH
