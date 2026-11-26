// Pool Alerts client logic (pool-alerts.mjs v2 and push-client.mjs v2), without a browser. The Home card's DOM, the
// service worker and the device panel run in real Chromium in acceptance/pool-alerts-browser.mjs.
import assert from 'node:assert/strict';
import {latestPublication, releases, baselineWeeks, readState, unreadCount, shareDetails, releaseNote, picksUrl, publicationTime, bootPoolAlerts,
  STORAGE_KEY, WEEKS_KEY} from './pool-alerts.mjs';
import {ALERT_APIS, PRODUCTION_ALERT_API, apiFor, decodeVapid, platformOf, support, MESSAGES, createDeviceStore} from './push-client.mjs';

let groups = 0;
const group = async (name, fn) => { await fn(); groups++; };
const w11 = {season: 2026, week: 11, revision: 2, publishedAt: '2026-11-18T14:00:00Z'};
const w12 = {season: 2026, week: 12, revision: 1, publishedAt: '2026-11-25T14:00:00Z'};
const w19 = {season: 2026, week: 19, revision: 1, publishedAt: '2027-01-12T19:00:00Z'};
const state = index => ({ready: true, publishedStale: false, index});

await group('latest release and history accept postseason weeks and refuse an ambiguous index', () => {
  assert.equal(latestPublication(state([w11, w12, w19])), w19, 'a playoff week (19-22) is a valid release');
  assert.equal(latestPublication(state([w11, {...w12, week: 23}])), null);
  assert.equal(latestPublication(state([w11, w11])), null);
  assert.deepEqual(releases(state([w11, w19, w12])).map(x => x.week), [19, 12, 11]);
  assert.deepEqual(releases({...state([w11]), publishedStale: true}), []);
});

await group('first run: only the newest release is new; viewed revisions are read; corrections are updated', () => {
  const list = releases(state([w11, w12]));
  const weeks = baselineWeeks(list, null, new Date('2026-11-26T00:00:00Z'));
  assert.deepEqual(weeks, {v: 2, weeks: {'2026:11': 2}, baselineAt: '2026-11-26T00:00:00.000Z'});
  assert.equal(readState(w12, weeks), 'new');
  assert.equal(readState(w11, weeks), 'read');
  assert.equal(readState({...w11, revision: 3}, weeks), 'updated');
  assert.equal(unreadCount(list, weeks), 1);
  assert.deepEqual(baselineWeeks(list, '2026:12:1').weeks, {'2026:11': 2, '2026:12': 1}, 'the PR #46 latest-release key is carried over');
});

await group('release note and share text: Eastern time, revision, published vs updated, exact deep link', () => {
  assert.equal(publicationTime(w12), 'Nov 25, 2026, 9:00 AM EST');
  assert.equal(publicationTime({...w12, publishedAt: '2026-10-25T14:00:00Z'}), 'Oct 25, 2026, 10:00 AM EDT', 'daylight time is shown as EDT');
  assert.equal(releaseNote(w12), '2026 season · Revision 1 · Published Nov 25, 2026, 9:00 AM EST');
  assert.equal(releaseNote({...w12, revision: 2}), '2026 season · Revision 2 · Updated Nov 25, 2026, 9:00 AM EST');
  assert.equal(releaseNote({...w12, publishedAt: null}), '2026 season · Revision 1 · Release time unavailable');
  assert.equal(picksUrl(w12, 'https://picks.smokkeventures.com'), 'https://picks.smokkeventures.com/nfl-pool/?view=picks&season=2026&week=12');
  assert.deepEqual(shareDetails({...w12, revision: 2}, 'https://r88510179-collab.github.io'), {title: 'Week 12 official picks',
    text: 'Week 12 official picks are updated in Pool Center (2026 season, revision 2, Nov 25, 2026, 9:00 AM EST).',
    url: 'https://r88510179-collab.github.io/nfl-pool/?view=picks&season=2026&week=12'});
  assert.equal(shareDetails({...w12, publishedAt: null}, 'https://x.example').text, 'Week 12 official picks are published in Pool Center (2026 season, revision 1).');
});

await group('reading Home writes nothing; viewing older and newest weeks records them; storage failures are harmless', () => {
  const nodes = Object.fromEntries(['poolAlertsTitle', 'poolAlertsNote', 'poolAlertsLink'].map(id => [id, {textContent: '', hidden: false, removeAttribute(k) { delete this[k]; }}]));
  const handlers = new Map(), saved = new Map(), seenEvents = [];
  let current = {...state([w11, w12]), current: {week: w11}};
  const doc = {body: {dataset: {view: 'home'}}, getElementById: id => nodes[id], addEventListener: (t, f) => handlers.set(t, f),
    dispatchEvent: e => { if (e.type === 'poolcenter:season') e.detail.result = current; if (e.type === 'poolalerts:seen') seenEvents.push(e.detail); }};
  bootPoolAlerts(doc, {getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v)}, {navigator: {}, location: {origin: 'https://x.example'}});
  const update = () => handlers.get('poolcenter:update')({detail: {contest: 'pickem'}});
  assert.equal(saved.size, 0, 'opening Home writes nothing');
  assert.equal(nodes.poolAlertsNote.textContent, '2026 season · Revision 1 · Published Nov 25, 2026, 9:00 AM EST');
  doc.body.dataset.view = 'picks';
  current = {...current, index: [{...w11, revision: 3}, w12], current: {week: {...w11, revision: 3}}};
  update();
  assert.deepEqual(JSON.parse(saved.get(WEEKS_KEY)).weeks, {'2026:11': 3}, 'viewing a corrected older week records it');
  assert.equal(saved.get(STORAGE_KEY), undefined, 'the newest release is still unread');
  assert.deepEqual(seenEvents, [{season: 2026, week: 11, revision: 3}]);
  current = {...current, current: {week: w12}};
  update();
  assert.equal(saved.get(STORAGE_KEY), '2026:12:1');
  assert.equal(nodes.poolAlertsTitle.textContent, 'Week 12 official picks published');
  const broken = {getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }};
  assert.doesNotThrow(() => bootPoolAlerts(doc, broken, {navigator: {}, location: {origin: 'https://x.example'}}));
});

await group('each Pool Center site maps to exactly one alert service; others never contact one', () => {
  assert.equal(apiFor('https://r88510179-collab.github.io'), PRODUCTION_ALERT_API);
  assert.equal(apiFor('https://picks.smokkeventures.com'), PRODUCTION_ALERT_API);
  for (const origin of ['http://r88510179-collab.github.io', 'https://evil.example', 'https://r88510179-collab.github.io.evil.example', 'toString', '__proto__']) assert.equal(apiFor(origin), null, origin);
  assert(Object.isFrozen(ALERT_APIS));
  assert(Object.values(ALERT_APIS).every(u => /^https:\/\/[a-z0-9-]+\.compute\.c-\d+\.[a-z0-9-]+\.aws\.neon\.tech$/.test(u)));
});

await group('VAPID public keys must be 65-byte uncompressed P-256 points', () => {
  const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
  assert.equal(decodeVapid(key).length, 65);
  for (const bad of ['', 'a+b', Buffer.alloc(65, 1).toString('base64url'), Buffer.alloc(33, 4).toString('base64url'), 7]) assert.throws(() => decodeVapid(bad));
});

await group('platform and capability detection drives the right instructions', () => {
  const win = (ua, extra = {}) => ({isSecureContext: true, navigator: {userAgent: ua, serviceWorker: {}, ...extra.nav}, matchMedia: () => ({matches: !!extra.standalone}),
    ...(extra.push === false ? {} : {PushManager: function () {}, Notification: function () {}})});
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  const ipadDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
  assert.equal(platformOf(win(iphone)), 'ios');
  assert.equal(platformOf(win(ipadDesktop, {nav: {maxTouchPoints: 5}})), 'ios', 'iPadOS in desktop mode is still iPad');
  assert.equal(platformOf(win(ipadDesktop, {nav: {maxTouchPoints: 0}})), 'desktop');
  assert.equal(platformOf(win(android)), 'android');
  assert.deepEqual(support(win(iphone, {push: false})), {ok: false, reason: 'ios-install', platform: 'ios', standalone: false});
  assert.deepEqual(support(win(iphone, {standalone: true})), {ok: true, platform: 'ios', standalone: true});
  assert.equal(support(win(android, {push: false})).reason, 'no-push');
  assert.equal(support({...win(android), isSecureContext: false}).reason, 'insecure');
  for (const reason of ['ios-install', 'no-push', 'no-service-worker', 'insecure', 'unavailable', 'unconfigured', 'denied', 'off', 'on']) assert(MESSAGES[reason], reason);
});

await group('the device store keeps credentials and the alert log in IndexedDB; opening a week marks its alerts read', async () => {
  const rows = {kv: new Map(), alerts: new Map()};
  const fakeIdb = {open() {
    const req = {};
    queueMicrotask(() => {
      const db = {objectStoreNames: {contains: () => true}, close() {},
        transaction(name) {
          const tx = {}; let pending = 0;
          const done = () => { if (--pending === 0) queueMicrotask(() => tx.oncomplete?.()); };
          const op = fn => { pending++; const r = {}; queueMicrotask(() => { r.result = fn(); done(); }); return r; };
          tx.objectStore = () => ({get: k => op(() => rows[name].get(k)), getAll: () => op(() => [...rows[name].values()]),
            put: (v, k) => op(() => rows[name].set(name === 'alerts' ? v.id : k, structuredClone(v))), delete: k => op(() => rows[name].delete(k))});
          return tx;
        }};
      req.result = db; req.onsuccess();
    });
    return req;
  }};
  const store = createDeviceStore(fakeIdb);
  assert.equal(await store.getDevice(), undefined);
  await store.setDevice({id: 'x', token: 't'});
  assert.deepEqual(await store.getDevice(), {id: 'x', token: 't'});
  for (const a of [{id: '2026:12:1:release', season: 2026, week: 12, revision: 1, kind: 'release', receivedAt: 1, openedAt: null},
    {id: '2026:12:2:correction', season: 2026, week: 12, revision: 2, kind: 'correction', receivedAt: 3, openedAt: null},
    {id: '2026:13:1:release', season: 2026, week: 13, revision: 1, kind: 'release', receivedAt: 2, openedAt: null}]) rows.alerts.set(a.id, a);
  assert.deepEqual((await store.listAlerts()).map(a => a.id), ['2026:12:2:correction', '2026:13:1:release', '2026:12:1:release'], 'newest first');
  assert.equal(await store.markOpened({season: 2026, week: 12, revision: 1}), 1, 'a later correction stays unread');
  assert.equal(await store.markOpened({season: 2026, week: 12, revision: 2}), 1);
  assert.equal(rows.alerts.get('2026:13:1:release').openedAt, null);
  await store.deleteDevice();
  assert.equal(await store.getDevice(), undefined);
});

console.log(`Pool Alerts client: ${groups} groups passed (release card, unread history, sharing, site mapping, platform detection, device store)`);
