// Registers the commercial service worker. Every commercial page sits beside service-worker.js, so scope './' is this
// directory: the widest scope the worker may take without a Service-Worker-Allowed header, which nothing sends, so it
// can never control another app on the origin. updateViaCache 'none' makes every update check bypass the HTTP cache.
// A module with no imports or exports, loaded by index.html and imported by the participant and commissioner pages;
// registering again from another page resolves to the same registration.
if('serviceWorker' in navigator){navigator.serviceWorker.register('./service-worker.js',{scope:'./',updateViaCache:'none'}).catch(()=>{})}
