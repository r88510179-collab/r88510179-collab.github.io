const CACHE='pool-platform-commercial-v2';
const ASSETS=[
  './','./index.html','./participant.html','./commissioner.html','./styles.css',
  './participant.js','./commissioner.js','./submission-core.js','./participant-core.js',
  './import-core.js','./auth-core.js','./platform-config.js','./platform-client.js','./manifest.webmanifest'
];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))));self.clients.claim()});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{});return response}).catch(()=>caches.match(event.request).then(hit=>hit||caches.match('./index.html'))))});
