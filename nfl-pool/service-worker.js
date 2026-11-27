'use strict';
const CACHE='pool-center-shell-v43';
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
  './pool-alerts.mjs?v=2',
  './push-client.mjs?v=2',
  './pool-alerts.css?v=1',
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
  './assets/pool-center-icon-512.svg',
  './assets/pool-alerts-icon-192.png',
  './assets/pool-alerts-badge-96.png',
  './assets/pool-center-touch-180.png'
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
// Pool Alerts v2. Every push shows a notification (browsers penalize or revoke silent pushes). A recognized alert names
// only the week and whether its official picks were posted or corrected: nothing private reaches the lock screen.
const ALERT_ICON='/nfl-pool/assets/pool-alerts-icon-192.png',ALERT_BADGE='/nfl-pool/assets/pool-alerts-badge-96.png';
function pushIdentity(p){
  return !!p&&(p.v===undefined||p.v===1)&&Number.isInteger(p.season)&&p.season>=2000&&p.season<=2100&&Number.isInteger(p.week)&&p.week>=1&&p.week<=22&&Number.isSafeInteger(p.revision)&&p.revision>=1&&['release','correction'].includes(p.kind);
}
function alertsDb(){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open('pool-alerts',1);
    r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv');if(!db.objectStoreNames.contains('alerts'))db.createObjectStore('alerts',{keyPath:'id'})};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
}
async function alertsTx(store,mode,fn){
  const db=await alertsDb();
  try{return await new Promise((resolve,reject)=>{const t=db.transaction(store,mode),r=fn(t.objectStore(store));t.oncomplete=()=>resolve(r&&r.result);t.onerror=t.onabort=()=>reject(t.error)})}
  finally{db.close()}
}
async function unreadAlerts(){return((await alertsTx('alerts','readonly',s=>s.getAll()))||[]).filter(a=>a.kind!=='test'&&!a.openedAt).length}
async function updateBadge(){
  const nav=self.navigator;
  if(!nav||typeof nav.setAppBadge!=='function')return;
  const n=await unreadAlerts();
  if(n)await nav.setAppBadge(n);else if(typeof nav.clearAppBadge==='function')await nav.clearAppBadge();
}
// Device checks (owner-run, migration 007): a check alert carries a one-time value only this device can decrypt (ack for a
// test, check for a week). It goes back to this device's alert service when the alert is shown (and whether it replaced
// an identical alert already here) and when it is tapped: proof of delivery to this physical device. Nothing else is sent.
const CHECK_VALUE=/^[A-Za-z0-9_-]{22}$/;
async function checkReceipt(value,event,repeat){
  if(typeof value!=='string'||!CHECK_VALUE.test(value))return;
  try{
    const device=await alertsTx('kv','readonly',s=>s.get('device'));
    if(!device||typeof device.api!=='string'||!/^https:\/\/[a-z0-9.-]+$/.test(device.api))return;
    await fetch(device.api+'/v1/ack',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(event==='received'?{ack:value,event,repeat:repeat===true}:{ack:value,event})});
  }catch{}
}
async function recordAlert(p){
  const id=p.season+':'+p.week+':'+p.revision+':'+p.kind;
  const seen=await alertsTx('alerts','readonly',s=>s.get(id));
  if(!seen)await alertsTx('alerts','readwrite',s=>{s.put({id,season:p.season,week:p.week,revision:p.revision,kind:p.kind,receivedAt:Date.now(),openedAt:null})});
  const all=(await alertsTx('alerts','readonly',s=>s.getAll()))||[];
  if(all.length>40){const old=all.sort((a,b)=>a.receivedAt-b.receivedAt).slice(0,all.length-40);await alertsTx('alerts','readwrite',s=>{for(const a of old)s.delete(a.id)})}
  return !seen;
}
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let p=null;
    try{p=event.data?event.data.json():null}catch{p=null}
    if(p&&p.kind==='test'){
      const ack=typeof p.ack==='string'&&CHECK_VALUE.test(p.ack)?p.ack:null;
      await self.registration.showNotification('Pool Alerts test',{body:'Alerts are working on this device.',tag:'pool-alerts-test',icon:ALERT_ICON,badge:ALERT_BADGE,data:ack?{kind:'test',ack}:{kind:'test'}});
      return checkReceipt(ack,'received',false);
    }
    if(!pushIdentity(p)){
      return self.registration.showNotification('Pool Center update',{body:'Open Pool Center for the latest official picks.',tag:'pool-alerts-update',icon:ALERT_ICON,badge:ALERT_BADGE,data:{kind:'update'}});
    }
    let fresh=true;
    try{fresh=await recordAlert(p)}catch{fresh=true}
    const correction=p.kind==='correction',check=typeof p.check==='string'&&CHECK_VALUE.test(p.check)?p.check:null;
    const text=correction?'Revision '+p.revision+' of the official picks is posted. Tap to review.':'Tap to see every entry\'s official picks.';
    await self.registration.showNotification('Week '+p.week+(correction?' official picks corrected':' official picks are posted'),{
      body:check?'Device check. '+text:text,
      // One notification per week: a correction replaces and re-alerts; an exact repeat (a resend) replaces silently.
      tag:'pool-week-'+p.season+'-'+p.week,renotify:fresh,icon:ALERT_ICON,badge:ALERT_BADGE,timestamp:Date.now(),
      data:check?{season:p.season,week:p.week,revision:p.revision,kind:p.kind,check}:{season:p.season,week:p.week,revision:p.revision,kind:p.kind}
    });
    try{await updateBadge()}catch{}
    await checkReceipt(check,'received',!fresh);
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const p=event.notification.data||{};
  const target=new URL('/nfl-pool/',self.location.origin);
  if(pushIdentity(p)){target.searchParams.set('view','picks');target.searchParams.set('season',String(p.season));target.searchParams.set('week',String(p.week))}
  else target.searchParams.set('view','home');
  event.waitUntil((async()=>{
    await checkReceipt(p.ack||p.check,'opened');
    if(pushIdentity(p)){
      try{
        const list=(await alertsTx('alerts','readonly',s=>s.getAll()))||[];
        const hit=list.filter(a=>a.season===p.season&&a.week===p.week&&a.revision<=p.revision&&!a.openedAt);
        if(hit.length)await alertsTx('alerts','readwrite',s=>{for(const a of hit)s.put(Object.assign({},a,{openedAt:Date.now()}))});
        await updateBadge();
      }catch{}
    }
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const open=windows.find(c=>{const u=new URL(c.url);return u.origin===self.location.origin&&u.pathname.startsWith('/nfl-pool/')&&!u.pathname.startsWith('/nfl-pool/admin')});
    if(open){
      try{await open.focus()}catch{}
      try{if(typeof open.navigate==='function'){await open.navigate(target.href);return}}catch{}
      open.postMessage({type:'pool-alerts-open',url:target.href});
      return;
    }
    return self.clients.openWindow(target.href);
  })());
});
// The browser replaced this device's push subscription: re-register it with the alert service under the same device.
self.addEventListener('pushsubscriptionchange',event=>{
  event.waitUntil((async()=>{
    const device=await alertsTx('kv','readonly',s=>s.get('device'));
    if(!device||!device.id||!device.token||typeof device.api!=='string'||!/^https:\/\//.test(device.api))return;
    let sub=event.newSubscription||null;
    if(!sub){
      const key=event.oldSubscription&&event.oldSubscription.options&&event.oldSubscription.options.applicationServerKey;
      if(!key)return;
      sub=await self.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    }
    const res=await fetch(device.api+'/v1/preferences',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:device.id,token:device.token,subscription:sub.toJSON()})});
    if(res.ok)await alertsTx('kv','readwrite',s=>{s.put(Object.assign({},device,{endpoint:sub.endpoint}),'device')});
  })());
});
// END POOL ALERTS PUSH
