// Registers the commercial service worker. This module sits beside service-worker.js, so the worker and its scope are
// resolved from this module's own address, never from the page's: an invitation opens the participant page at
// /join/<pool>/<entry>, where a path relative to the page would name /join/<pool>/service-worker.js, a file that does
// not exist. The scope is this module's directory: the widest scope the worker may take without a
// Service-Worker-Allowed header, which nothing sends, so it can never control another app on the origin.
// updateViaCache 'none' makes every update check bypass the HTTP cache. A module with no imports or exports, loaded by
// index.html and imported by the participant and commissioner pages; registering again from another page resolves to
// the same registration.
if('serviceWorker' in navigator){navigator.serviceWorker.register(new URL('./service-worker.js',import.meta.url),{scope:new URL('./',import.meta.url).href,updateViaCache:'none'}).catch(()=>{})}
