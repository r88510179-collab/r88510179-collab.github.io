// Pool Alerts browser acceptance (Chromium, synthetic data, no network). The real Pool Center files are served at the
// production origin through request interception, so the site-to-alert-service mapping, the service worker, IndexedDB
// and the Home card run exactly as shipped. Neon (anonymous token, Data API), the score feed and the alert service are
// answered in memory. SIMULATED, stated plainly: headless Chromium has no push service, so PushManager.subscribe is
// replaced by a stub subscription; pushes reach the REAL service worker through the DevTools protocol
// (ServiceWorker.deliverPushMessage). Physical Android/iPhone acceptance is a separate, manual checklist.
//   node nfl-pool/acceptance/pool-alerts-browser.mjs [--screenshots <dir>]
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync, readFileSync, existsSync} from 'node:fs';
import {extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://r88510179-collab.github.io';
const ALERTS = 'https://br-late-hat-b55ygmj4-poolalerts.compute.c-7.us-east-2.aws.neon.tech';
const shotsArg = process.argv.indexOf('--screenshots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (shots) mkdirSync(shots, {recursive: true});
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json'};

const games = [{away: 'DEN', home: 'KC', awayNumber: 1, homeNumber: 2, date: '2026-11-29'}, {away: 'BUF', home: 'MIA', awayNumber: 3, homeNumber: 4, date: '2026-11-29'}];
const config = week => ({schemaVersion: 1, season: 2026, week, tiebreakGameIndex: 0, games,
  participants: [{id: 'dc', displayName: 'D.C.', pickNumbers: [1, 3], tiebreak: 41}, {id: 'jc', displayName: 'JC', pickNumbers: [2, 3], tiebreak: 44},
    {id: 'djs', displayName: 'DJS', pickNumbers: [1, 4], tiebreak: 40}, {id: 'th', displayName: 'Thaddeus', pickNumbers: [2, 4], tiebreak: 45}]});
const weeks = [
  {season: 2026, week: 11, revision: 2, status: 'locked', published_at: '2026-11-18T14:00:00+00:00'},
  {season: 2026, week: 12, revision: 1, status: 'locked', published_at: '2026-11-25T14:00:00+00:00'}
];

async function newContext(browser, {width = 390, permission = 'granted', iphone = false, alertApi = {}} = {}) {
  const context = await browser.newContext({viewport: {width, height: 900}, deviceScaleFactor: shots ? 2 : 1, hasTouch: true, isMobile: true,
    userAgent: iphone ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'});
  if (permission === 'granted') await context.grantPermissions(['notifications'], {origin: ORIGIN});
  const api = {calls: [], subscribe: alertApi.subscribe || (() => ({status: 201, body: {id: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', token: 'T'.repeat(43), corrections: true}}))};
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN && url.pathname.startsWith('/nfl-pool/')) {
      let rel = url.pathname.slice('/nfl-pool/'.length) || 'index.html';
      if (rel.endsWith('/')) rel += 'index.html';
      const file = join(root, rel);
      if (!file.startsWith(root) || !existsSync(file)) return route.fulfill({status: 404, body: 'not found'});
      return route.fulfill({status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file), headers: {'Cache-Control': 'no-cache'}});
    }
    if (url.hostname.includes('neonauth')) return route.fulfill({json: {token: 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYW5vbnltb3VzIn0.x'}});
    if (url.hostname.includes('apirest')) {
      const table = url.pathname.split('/').pop();
      if (table === 'nfl_pool_weeks') {
        const select = url.searchParams.get('select') || '';
        const week = Number((url.searchParams.get('week') || '').replace('eq.', ''));
        const rows = week ? weeks.filter(w => w.week === week) : weeks;
        return route.fulfill({json: rows.map(w => select.includes('config') ? {...w, config: config(w.week)} : w)});
      }
      return route.fulfill({json: []});
    }
    if (url.hostname.includes('nflscores2')) return route.fulfill({json: {fetchedAt: new Date().toISOString(), events: []}});
    if (url.origin === ALERTS) {
      const body = route.request().postDataJSON?.() ?? null;
      api.calls.push({path: url.pathname, method: route.request().method(), body});
      const cors = {'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST'};
      if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
      if (url.pathname === '/v1/config') return route.fulfill({json: {publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', environment: 'test'}, headers: cors});
      const reply = url.pathname === '/v1/subscribe' ? api.subscribe(body) : url.pathname === '/v1/check' ? {status: 200, body: {state: 'active', corrections: true}} : {status: 200, body: {ok: true}};
      return route.fulfill({status: reply.status, json: reply.body, headers: cors});
    }
    return route.fulfill({status: 204, body: ''});
  });
  await context.addInitScript(({iphone, permission}) => {
    if (iphone) { delete window.PushManager; delete window.Notification; return; }
    if (permission === 'denied') {
      Object.defineProperty(Notification, 'permission', {get: () => 'denied'});
      Notification.requestPermission = async () => 'denied';
    }
    // SIMULATED push subscription (no push service in headless Chromium).
    let current = null;
    const make = () => ({endpoint: `https://fcm.googleapis.com/fcm/send/simulated-${Math.random().toString(36).slice(2)}`,
      options: {applicationServerKey: null},
      toJSON() { return {endpoint: this.endpoint, keys: {p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg'}}; },
      async unsubscribe() { current = null; window.__pushLog.push('unsubscribe'); return true; }});
    window.__pushLog = [];
    PushManager.prototype.getSubscription = async function () { return current; };
    PushManager.prototype.subscribe = async function (options) { window.__pushLog.push('subscribe'); current = make(); current.options = options; return current; };
    window.__shared = [];
  }, {iphone, permission});
  return {context, api};
}

const results = [];
// Poll an async in-page check until it is truthy (page.waitForFunction treats a returned Promise as already truthy).
async function until(page, check, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(check, arg);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${check.toString().slice(0, 90)}`);
    await new Promise(r => setTimeout(r, 200));
  }
}
const step = async (name, fn) => { await fn(); results.push(name); console.log(`ok - ${name}`); };
const card = page => page.locator('section[aria-label="Pool Alerts"]');
async function open(context, path = '/nfl-pool/?view=home') {
  const page = await context.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto(ORIGIN + path);
  await page.waitForFunction(() => document.getElementById('poolAlertsLink') && !document.getElementById('poolAlertsLink').hidden, null, {timeout: 20000});
  return page;
}
async function shot(page, name) {
  if (!shots) return;
  await card(page).scrollIntoViewIfNeeded();
  await card(page).screenshot({path: join(shots, `${name}.png`)});
}

// Full Chromium (new headless) or the runner's Chrome: the headless shell reports Notification.permission as denied.
// No host name resolves, so a request the routes above do not answer fails instead of reaching a real site. (With
// Playwright 1.56 and Chrome the service worker's own fetches bypassed the routes and loaded the live Pool Center.)
const browser = await chromium.launch({channel: process.env.POOL_ALERTS_BROWSER_CHANNEL || 'chromium',
  args: ['--host-resolver-rules=MAP * ~NOTFOUND']});
try {
  await step('latest official release: Eastern time, revision, unread marker, direct link and history baseline', async () => {
    const {context} = await newContext(browser);
    const page = await open(context);
    await assert.doesNotReject(page.waitForFunction(() => document.querySelector('[data-pa-device] .pa-status')?.textContent.includes('No account needed')));
    assert.equal(await page.locator('#poolAlertsTitle').textContent(), 'New · Week 12 official picks published');
    assert.equal(await page.locator('#poolAlertsNote').textContent(), '2026 season · Revision 1 · Published Nov 25, 2026, 9:00 AM EST');
    assert.equal(await page.locator('#poolAlertsLink').getAttribute('href'), './?view=picks&season=2026&week=12');
    const history = page.locator('[data-pa-history] li');
    assert.equal(await history.count(), 2);
    assert.match(await history.nth(0).textContent(), /Week 12 · revision 1New/);
    assert.doesNotMatch(await history.nth(1).textContent(), /New|Updated/, 'a week published before this browser first opened Pool Center is not new');
    for (const width of [375, 390, 430]) {
      await page.setViewportSize({width, height: 900});
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, `no horizontal scroll at ${width}px`);
      const small = await card(page).locator('button:visible, a:visible, summary:visible').evaluateAll(els => els.filter(e => e.getBoundingClientRect().height < 43.5).map(e => e.textContent.trim()));
      assert.deepEqual(small, [], `every Pool Alerts control is at least 44px tall at ${width}px`);
      await page.locator('[data-pa-history] summary').evaluate(e => e.parentElement.open = true);
      await page.locator('[data-pa-help] summary').evaluate(e => e.parentElement.open = false);
      await shot(page, `release-and-off-${width}`);
    }
    // Viewing the week's picks marks it read; Home then shows no "New".
    await page.goto(`${ORIGIN}/nfl-pool/?view=picks&season=2026&week=12`);
    await page.waitForFunction(() => document.getElementById('poolAlertsTitle')?.textContent === 'Week 12 official picks published');
    assert.equal(await page.evaluate(() => localStorage.getItem('poolcenter.alerts.seen.v1')), '2026:12:1');
    await context.close();
  });

  await step('one-tap sharing of the official announcement (share sheet, then clipboard fallback)', async () => {
    const {context} = await newContext(browser);
    const page = await open(context);
    await page.evaluate(() => { navigator.share = async data => { window.__shared.push(data); }; });
    await page.getByRole('button', {name: 'Share announcement'}).click();
    const shared = await page.evaluate(() => window.__shared);
    assert.deepEqual(shared, [{title: 'Week 12 official picks', text: 'Week 12 official picks are published in Pool Center (2026 season, revision 1, Nov 25, 2026, 9:00 AM EST).',
      url: `${ORIGIN}/nfl-pool/?view=picks&season=2026&week=12`}]);
    await context.grantPermissions(['notifications', 'clipboard-read', 'clipboard-write'], {origin: ORIGIN});
    await page.evaluate(() => { delete navigator.share; Navigator.prototype.share = undefined; });
    await page.getByRole('button', {name: 'Share announcement'}).click();
    await page.waitForFunction(() => document.querySelector('[data-pa-release] + .pa-status')?.textContent.includes('copied'));
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Week 12 official picks are published in Pool Center .* https:\/\/r88510179-collab\.github\.io\/nfl-pool\/\?view=picks&season=2026&week=12$/);
    await context.close();
  });

  await step('enrollment without an account, preferences, local test alert and removal (subscription simulated)', async () => {
    const {context, api} = await newContext(browser);
    const page = await open(context);
    await page.getByRole('button', {name: 'Turn on alerts'}).click();
    await page.waitForFunction(() => document.querySelector('[data-pa-device] .pa-status')?.textContent === 'Alerts are on for this device.');
    const subscribe = api.calls.find(c => c.path === '/v1/subscribe');
    assert.equal(subscribe.body.corrections, true);
    assert.match(subscribe.body.subscription.endpoint, /^https:\/\/fcm\.googleapis\.com\/fcm\/send\/simulated-/);
    assert.equal(subscribe.body.inviteCode, undefined, 'no invitation code is needed in open enrollment');
    const device = await page.evaluate(() => new Promise(resolve => { const r = indexedDB.open('pool-alerts', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('device'); g.onsuccess = () => resolve(g.result); }; }));
    assert.equal(device.id, '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f');
    assert.equal(device.api, ALERTS, 'credentials stay in this browser, bound to this site\'s alert service');
    for (const width of [375, 390, 430]) { await page.setViewportSize({width, height: 900}); await shot(page, `alerts-on-${width}`); }
    await page.getByText('Also alert me when official picks are corrected').click();
    await page.waitForFunction(() => document.querySelector('[data-pa-device] .pa-status')?.textContent.startsWith('Correction alerts are off'));
    assert.deepEqual(api.calls.filter(c => c.path === '/v1/preferences').at(-1).body, {id: device.id, token: device.token, corrections: false});
    await page.getByRole('button', {name: 'Send a test alert'}).click();
    await until(page, async () => (await (await navigator.serviceWorker.ready).getNotifications()).some(n => n.title === 'Pool Alerts test'));
    await page.getByRole('button', {name: 'Turn off alerts'}).click();
    await page.waitForFunction(() => document.querySelector('[data-pa-device] .pa-status')?.textContent.startsWith('Alerts are off for this device.'));
    assert.deepEqual(api.calls.filter(c => c.path === '/v1/unsubscribe').at(-1).body, {id: device.id, token: device.token});
    assert.deepEqual(await page.evaluate(() => window.__pushLog), ['subscribe', 'unsubscribe']);
    await context.close();
  });

  await step('invitation mode: the code from the shared link is offered and sent', async () => {
    let calls = 0;
    const {context, api} = await newContext(browser, {alertApi: {subscribe: body => (++calls === 1 && !body.inviteCode)
      ? {status: 403, body: {error: 'invite-required'}} : {status: 201, body: {id: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', token: 'T'.repeat(43), corrections: true}}}});
    const page = await open(context, '/nfl-pool/?view=home#alerts-invite=family-pool-2026');
    await page.getByRole('button', {name: 'Turn on alerts'}).click();
    await page.waitForFunction(() => document.querySelector('[data-pa-device] .pa-status')?.textContent === 'Alerts are on for this device.');
    assert.equal(api.calls.find(c => c.path === '/v1/subscribe').body.inviteCode, 'family-pool-2026');
    await context.close();
  });

  await step('blocked notifications explain exactly how to unblock them', async () => {
    const {context} = await newContext(browser, {permission: 'denied'});
    const page = await open(context);
    await page.waitForFunction(() => document.querySelector('[data-pa-device] .pa-status')?.textContent.startsWith('Notifications are blocked'));
    assert.match(await page.locator('[data-pa-device] .pa-status').textContent(), /Site settings, Notifications/);
    await shot(page, 'blocked-390');
    await context.close();
  });

  await step('iPhone Safari tab: no push in the browser, Home Screen instructions first', async () => {
    const {context} = await newContext(browser, {iphone: true});
    const page = await open(context);
    await page.waitForFunction(() => document.querySelector('[data-pa-device] .pa-status')?.textContent.startsWith('On iPhone or iPad'));
    const firstHeading = await page.locator('[data-pa-help] h4').first().textContent();
    assert.equal(firstHeading, 'iPhone or iPad (iOS 16.4 or later)');
    await page.locator('[data-pa-help] summary').click();
    await shot(page, 'iphone-instructions-390');
    await context.close();
  });

  await step('real service worker: a delivered push is shown, logged on the device and cleared by viewing the week', async () => {
    const {context} = await newContext(browser);
    const page = await open(context);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cdp = await context.newCDPSession(page);
    const registration = new Promise(resolve => cdp.on('ServiceWorker.workerRegistrationUpdated', ({registrations}) => {
      const r = registrations.find(x => x.scopeURL === `${ORIGIN}/nfl-pool/` && !x.isDeleted);
      if (r) resolve(r.registrationId);
    }));
    await cdp.send('ServiceWorker.enable');
    const registrationId = await registration;
    await cdp.send('ServiceWorker.deliverPushMessage', {origin: ORIGIN, registrationId, data: JSON.stringify({v: 1, kind: 'release', season: 2026, week: 12, revision: 1})});
    await until(page, async () => (await (await navigator.serviceWorker.ready).getNotifications()).some(n => n.tag === 'pool-week-2026-12'));
    const shown = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({title: n.title, body: n.body, tag: n.tag, icon: n.icon, badge: n.badge})));
    const alert = shown.find(n => n.tag === 'pool-week-2026-12');
    assert.equal(alert.title, 'Week 12 official picks are posted');
    assert.match(alert.icon, /pool-alerts-icon-192\.png$/);
    assert.match(alert.badge, /pool-alerts-badge-96\.png$/);
    await cdp.send('ServiceWorker.deliverPushMessage', {origin: ORIGIN, registrationId, data: 'not json'});
    await until(page, async () => (await (await navigator.serviceWorker.ready).getNotifications()).some(n => n.title === 'Pool Center update'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-pa-device-log] li')?.textContent.includes('Week 12 · revision 1Unread'));
    await page.locator('[data-pa-device-log] summary').click();
    await shot(page, 'device-log-390');
    await page.goto(`${ORIGIN}/nfl-pool/?view=picks&season=2026&week=12`);
    await page.waitForFunction(() => document.querySelector('[data-pa-device-log] li') && !document.querySelector('[data-pa-device-log] li')?.textContent.includes('Unread'));
    await context.close();
  });

  await step('a site without an alert service never contacts one', async () => {
    const context = await browser.newContext({viewport: {width: 390, height: 800}});
    const calls = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === ALERTS) calls.push(url.pathname);
      if (url.origin === 'https://staging.invalid' && url.pathname.startsWith('/nfl-pool/')) {
        const rel = url.pathname.slice('/nfl-pool/'.length) || 'index.html', file = join(root, rel.endsWith('/') ? rel + 'index.html' : rel);
        return existsSync(file) ? route.fulfill({status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file)}) : route.fulfill({status: 404});
      }
      if (url.hostname.includes('neonauth')) return route.fulfill({json: {token: 'a.b.c'}});
      if (url.hostname.includes('apirest')) return route.fulfill({json: url.pathname.endsWith('nfl_pool_weeks') ? weeks.map(w => ({...w, config: config(w.week)})) : []});
      return route.fulfill({status: 204, body: ''});
    });
    const page = await context.newPage();
    await page.goto('https://staging.invalid/nfl-pool/?view=home');
    await page.waitForFunction(() => document.querySelector('[data-pa-device] .pa-status')?.textContent === 'Phone alerts are not switched on for this site yet.');
    assert.deepEqual(calls, []);
    await context.close();
  });
  await step('device check: a check link asks for a check, the card shows the device code, and a check alert sends its receipt (375, 390, 430 px)', async () => {
    for (const width of [375, 390, 430]) {
      const {context, api} = await newContext(browser, {width});
      const page = await open(context, '/nfl-pool/?view=home#alerts-check');
      await page.getByRole('button', {name: 'Turn on alerts'}).click();
      await until(page, () => document.querySelector('[data-pa-device] .pa-status')?.textContent.startsWith('Device check requested for '));
      const request = api.calls.find(c => c.path === '/v1/check-request');
      assert.deepEqual(request.body, {id: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', token: 'T'.repeat(43), platform: 'android'}, 'only the device\'s own credentials and its platform');
      assert.equal(api.calls.find(c => c.path === '/v1/subscribe').body.platform, 'android');
      await until(page, () => /This device's code: [A-Z2-7]{4}-[A-Z2-7]{4}$/.test(document.querySelector('[data-pa-device-check] .pa-muted:last-of-type')?.textContent || ''));
      assert.equal(await page.locator('[data-pa-device-check]').evaluate(d => d.open), true, 'opened from the link');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, `no horizontal scrolling at ${width} px`);
      if (width === 390) await shot(page, 'device-check-390');
      // A check alert reaches the real service worker, which sends its receipt to this device's alert service.
      await page.evaluate(() => navigator.serviceWorker.ready);
      const cdp = await context.newCDPSession(page);
      const registration = new Promise(resolve => cdp.on('ServiceWorker.workerRegistrationUpdated', ({registrations}) => {
        const r = registrations.find(x => x.scopeURL === `${ORIGIN}/nfl-pool/` && !x.isDeleted);
        if (r) resolve(r.registrationId);
      }));
      await cdp.send('ServiceWorker.enable');
      const registrationId = await registration;
      await cdp.send('ServiceWorker.deliverPushMessage', {origin: ORIGIN, registrationId, data: JSON.stringify({v: 1, kind: 'test', ack: 'AbCdEfGhIjKlMnOpQrStUv'})});
      const deadline = Date.now() + 15000;
      while (!api.calls.some(c => c.path === '/v1/ack') && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
      assert.deepEqual(api.calls.find(c => c.path === '/v1/ack')?.body, {ack: 'AbCdEfGhIjKlMnOpQrStUv', event: 'received', repeat: false});
      await context.close();
    }
  });
  await step('Admin at a Vercel preview origin stops before any Neon client exists; at the production origin it starts', async () => {
    const PREVIEW = 'https://nfl-pool-personal-git-ccr-161-71e00c-r88510179-collabs-projects.vercel.app';
    const neonCalls = [];
    const context = await browser.newContext({viewport: {width: 390, height: 900}});
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if ((url.origin === PREVIEW || url.origin === ORIGIN) && url.pathname.startsWith('/nfl-pool/')) {
        let rel = url.pathname.slice('/nfl-pool/'.length) || 'index.html';
        if (rel.endsWith('/')) rel += 'index.html';
        const file = join(root, rel);
        if (!file.startsWith(root) || !existsSync(file)) return route.fulfill({status: 404, body: 'not found'});
        return route.fulfill({status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file)});
      }
      // A stand-in for the Neon SDK, so what stops the page is the guard, never a missing download.
      if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({status: 200, contentType: 'text/javascript',
        body: 'export function createClient(){window.__neonClients=(window.__neonClients||0)+1;const n=()=>new Promise(()=>{});return{auth:{getSession:n,signIn:{emailOtp:n},emailOtp:{sendVerificationOtp:n},signOut:n},from:()=>({select:n}),rpc:n}}'});
      if (url.hostname.includes('neon')) { neonCalls.push(url.href); return route.fulfill({status: 500, body: ''}); }
      return route.fulfill({status: 204, body: ''});
    });
    const page = await context.newPage();
    await page.goto(`${PREVIEW}/nfl-pool/admin/`);
    await page.waitForFunction(() => document.body.textContent.includes('Admin is switched off on preview deployments'), null, {timeout: 15000});
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__neonClients || 0), 0, 'no Neon client was created on the preview');
    assert.deepEqual(neonCalls, [], 'and nothing was sent to Neon');
    const production = await context.newPage();
    await production.goto(`${ORIGIN}/nfl-pool/admin/`);
    await production.waitForFunction(() => (window.__neonClients || 0) >= 1, null, {timeout: 15000});
    assert.equal(await production.evaluate(() => document.body.textContent.includes('switched off on preview')), false, 'production Admin starts as before');
    await context.close();
  });
  console.log(`Pool Alerts browser acceptance: ${results.length} Chromium scenarios passed (push subscription simulated; pushes delivered to the real service worker via DevTools)`);
} finally {
  await browser.close();
}
