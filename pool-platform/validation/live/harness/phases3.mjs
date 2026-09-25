// Phases: status, batch, authorder, directwrite, surface, isolation, expiredinv, locked, deadline, jwtexpiry, signout,
// human_send, human_verify.
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {AUTH_URL, DATA_URL, ORIGIN, secrets, state, save, data, rpc, authCall, jwtFor, summarize, failedWith, uuid, sleep,
  decodeJwt, claimsSummary, JWT_SHAPE, jwtSecondsLeft, scrub, fp, ident, IDENTITY, classifyIdentity, clientResult, identityProbe,
  retryOnNull} from './lib.mjs';
import {eid, W, PK, SV, PB, card, submit, createInvite, claim, subRow} from './phases2.mjs';

// The repo's own client modules (pool-platform/auth-core.js, platform-client.js), three levels up from here.
const POOL_PLATFORM = path.resolve(import.meta.dirname, '..', '..', '..');
const repoModule = rel => import(pathToFileURL(path.join(POOL_PLATFORM, rel)).href);
const TABLES = ['pool_platform_tenants', 'pool_platform_memberships', 'pool_platform_pools', 'pool_platform_seasons', 'pool_platform_entries',
  'pool_platform_weeks', 'pool_platform_submissions', 'pool_platform_submission_audit', 'pool_platform_entry_invites'];

// 11: entry status and week state.
export async function status(rec) {
  for (const code of ['PK-INACTIVE', 'PK-ELIMINATED', 'PK-ARCHIVED']) {
    let r = await submit('D', W(PK, 7), eid(code), 'participant', card());
    rec.check(`ST-${code}-p`, `${code}: owner participant submission → entry_not_active`, failedWith(r, 'entry_not_active'), {summary: summarize(r)});
    r = await submit('A', W(PK, 7), eid(code), 'commissioner_manual', card());
    rec.check(`ST-${code}-c`, `${code}: commissioner_manual → entry_not_active`, failedWith(r, 'entry_not_active'), {summary: summarize(r)});
  }
  let r = await rpc(await jwtFor('A'), 'pool_platform_submit_batch', {p_week_id: W(PK, 7), p_source: 'commissioner_import',
    p_items: ['PK-INACTIVE', 'PK-ELIMINATED', 'PK-ARCHIVED'].map(code => ({entry_id: eid(code), payload: card()}))});
  rec.check('ST-batch', 'batch import of inactive/eliminated/archived entries → entry_not_active for each', r.ok && r.json?.length === 3 && r.json.every(x => x.ok === false && x.code === 'entry_not_active'), {summary: `${summarize(r)} ${JSON.stringify(r.json)}`});
  for (const [n, code, desc] of [[1, 'deadline_passed', 'deadline in the past'], [2, 'week_not_open', 'opens_at in the future'], [3, 'week_not_open', 'draft week'], [4, 'week_not_open', 'locked week']]) {
    r = await submit('D', W(PK, n), eid('PK-DL'), 'participant', card());
    rec.check(`ST-w${n}-p`, `participant, ${desc} → ${code}`, failedWith(r, code), {summary: summarize(r)});
    r = await submit('A', W(PK, n), eid('PK-DL'), 'commissioner_manual', card());
    rec.check(`ST-w${n}-c`, `commissioner_manual, ${desc} → ${code}`, failedWith(r, code), {summary: summarize(r)});
  }
  r = await submit('D', W(PK, 12), eid('PK-DL'), 'participant', card('ahhha', 50));
  rec.check('ST-before', 'submission before the deadline (week 12) succeeds', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  const own = await data('GET', `/pool_platform_submissions?select=week_id,entry_id&entry_id=in.(${['PK-DL', 'PK-INACTIVE', 'PK-ELIMINATED', 'PK-ARCHIVED'].map(eid).join(',')})`, {token: await jwtFor('D')});
  rec.check('ST-norows', 'no rows for closed weeks or non-active entries (only PK-DL week 12)', own.ok && own.json.length === 1 && own.json[0].week_id === W(PK, 12), {summary: `rows=${own.json?.length}`});
}

export async function batch(rec) {
  const w9 = W(PK, 9), tA = await jwtFor('A');
  let r = await submit('D', w9, eid('PK-BATCH02'), 'participant', card('aaaaa', 40));
  rec.check('BT0', 'D submits PK-BATCH02 week 9 first', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  const items = [
    [{entry_id: eid('PK-BATCH01'), payload: card('hhhhh', 41)}, 'created'],
    [{entry_id: eid('PK-BATCH02'), payload: card('hhhhh', 42)}, 'source_conflict:participant'],
    [{entry_id: eid('PK-BATCH03'), payload: {picks: {g1: 'away'}}}, 'invalid_payload'],
    // Items go through submit_entry, which authorizes on the entry's own tenant before it looks at the week: a
    // missing entry and a Tenant B entry are both commissioner_required; A's own other-season entry is invalid_entry_week.
    [{entry_id: uuid(), payload: card()}, 'commissioner_required'],
    [{entry_id: 'not-a-uuid', payload: card()}, /invalid input syntax for type uuid/],
    [{entry_id: eid('B-01'), payload: card()}, 'commissioner_required'],
    [{entry_id: eid('SV-D02'), payload: card()}, 'invalid_entry_week'],
    [{entry_id: eid('PK-INACTIVE'), payload: card()}, 'entry_not_active'],
    [{entry_id: eid('PK-BATCH03')}, 'invalid_payload'],
    [{entry_id: eid('PK-BATCH01'), payload: card('ahhhh', 43)}, 'updated']
  ];
  r = await rpc(tA, 'pool_platform_submit_batch', {p_week_id: w9, p_source: 'commissioner_import', p_items: items.map(x => x[0])});
  const got = (r.json || []).map(x => x.ok ? x.result?.code : x.code);
  const pass = r.ok && got.length === items.length && items.every(([, exp], i) => exp instanceof RegExp ? exp.test(got[i] || '') : got[i] === exp);
  rec.check('BT1', 'mixed batch: new row, participant conflict, malformed, unknown, non-uuid, other-tenant, other-season, inactive, empty, same-source update', pass, {summary: `${summarize(r)} codes=${JSON.stringify(got.map(g => scrub(g || '')))}`});
  const row = await subRow('D', w9, eid('PK-BATCH02'));
  rec.check('BT2', 'the batch never overwrote the participant row', row?.source === 'participant' && row?.revision === 1 && JSON.stringify(row?.payload) === JSON.stringify(card('aaaaa', 40)), {summary: JSON.stringify({source: row?.source, revision: row?.revision})});
  for (const [cid, key, week, src, itemsArg, exp, desc] of [
    ['BT3', 'D', w9, 'commissioner_import', [], 'commissioner_required', 'participant calling the batch RPC'],
    ['BT4', 'D', w9, 'participant', [], 'commissioner_source_required', 'batch with the participant source'],
    ['BT5', 'C', w9, 'commissioner_import', [{entry_id: eid('PK-BATCH03'), payload: card()}], 'commissioner_required', 'Tenant B commissioner on a Tenant A week'],
    ['BT6', 'F', uuid(), 'commissioner_import', [], 'commissioner_required', 'outsider, nonexistent week'],
    ['BT7', 'A', w9, 'commissioner_import', {}, 'invalid_batch', 'items not an array'],
    ['BT8', 'A', w9, 'commissioner_import', Array.from({length: 501}, () => ({entry_id: eid('PK-BATCH03'), payload: card()})), 'invalid_batch', '501 items']
  ]) {
    const x = await rpc(await jwtFor(key), 'pool_platform_submit_batch', {p_week_id: week, p_source: src, p_items: itemsArg});
    rec.check(cid, `${desc} → ${exp}`, failedWith(x, exp), {summary: summarize(x)});
  }
  r = await data('POST', '/rpc/pool_platform_submit_batch', {body: {p_week_id: w9, p_source: 'commissioner_import', p_items: []}});
  rec.check('BT9', 'anonymous (no JWT) cannot call the batch RPC', !r.ok, {summary: summarize(r)});
}

// Evidence for a request that retryOnNull ran a second time because the first answer was auth_required.
function noteNull(rec, id, x) {
  if (x.retried) rec.info(`${id}-null`, `auth_required (NULL identity) on the first request; retried once${x.nullAgain ? ': NULL again' : ''}`,
    {classification: IDENTITY.NULL, first: summarize(x.first), retry: summarize(x.result)});
}
// A check over retryOnNull outcomes ([outcome, pass] pairs): a RELIABILITY failure when its only failing requests are
// the ones still NULL after their retry, otherwise the ordinary check.
function checkRetried(rec, id, desc, outcomes, detail) {
  const failing = outcomes.filter(([x, pass]) => !pass(x.result));
  if (failing.length && failing.every(([x]) => x.nullAgain)) {
    return rec.reliability(id, `${desc}: not established, ${failing.length} request(s) NULL identity (auth_required) on the request and on its one retry`, detail);
  }
  return rec.check(id, desc, !failing.length, detail);
}

// 15: unauthorized callers see only the authorization failure, whatever the payload, history, week or entry state.
export async function authorder(rec) {
  const probes = [
    ['malformed [] payload', W(PK, 12), eid('PK-D03'), []],
    ['malformed nested picks', W(PK, 12), eid('PK-D03'), {picks: 'x'}],
    ['unknown Survivor team', W(SV, 9), eid('SV-D01'), {team: 'XYZ'}],
    ['non-string Survivor team', W(SV, 9), eid('SV-D01'), {team: 123}],
    ['historical pick (KC, already used by SV-D01)', W(SV, 9), eid('SV-D01'), {team: 'KC'}],
    ['past-deadline week', W(PK, 1), eid('PK-D03'), card()],
    ['draft week', W(PK, 3), eid('PK-D03'), card()],
    ['locked week', W(PK, 4), eid('PK-D03'), card()],
    ['not-yet-open week', W(PK, 2), eid('PK-D03'), card()],
    ['inactive entry', W(PK, 12), eid('PK-INACTIVE'), card()],
    ['eliminated Survivor entry', W(SV, 9), eid('SV-ELIM'), {team: 'KC'}],
    ['existing participant row', W(PK, 7), eid('PK-D01'), card()],
    ['existing commissioner row', W(PK, 7), eid('PK-D02'), card()],
    ['locked participant row (if locked)', W(PK, 7), eid('PK-LOCK-P'), card()],
    ['valid payload in an open week', W(PK, 12), eid('PK-D03'), card()]
  ];
  // Every request here goes through retryOnNull. auth_required is the NULL-identity signal, raised before the RPC
  // reads anything, so it discloses nothing and gets one retry. NULL again leaves that probe unestablished: a
  // RELIABILITY failure of its summary check, never an authorization-order finding. Any other unexpected answer,
  // first or on the retry, stops or fails exactly as before.
  const unestablished = n => ({summary: `${n.length} probe(s) NULL identity (auth_required) on the request and on its one retry: ${n.join(' ')}`});
  let n = 0;
  const ao1Null = [];
  for (const caller of ['F', 'E', 'G', 'C']) {
    for (const [label, weekId, entryId, body] of probes) {
      for (const [src, exp] of [['participant', 'entry_not_owned'], ['commissioner_import', 'commissioner_required'], ['commissioner_manual', 'commissioner_required']]) {
        const x = await retryOnNull(() => submit(caller, weekId, entryId, src, body));
        const r = x.result;
        n++;
        noteNull(rec, `AO-${caller}-${n}`, x);
        if (x.nullAgain) { ao1Null.push(`AO-${caller}-${n}`); continue; }
        const ok = failedWith(r, exp) && r.details == null && r.hint == null;
        if (!ok) rec.stop('P1', `AO-${caller}-${n}`, `authorization-order leak: ${caller} ${src} on "${label}" returned ${summarize(r)} instead of ${exp}`, {summary: summarize(r)});
      }
    }
  }
  const ao1 = `${n} unauthorized probes (F, E, G, C × 15 states × 3 sources) all returned only entry_not_owned / commissioner_required with no details`;
  if (ao1Null.length) rec.reliability('AO1', `${ao1}: not established`, unestablished(ao1Null));
  else rec.check('AO1', ao1, true, {summary: `probes=${n}`});
  // Whether a week belongs to an entry's season, and whether the entry exists, is told only to its owner or a
  // commissioner of its tenant: for anyone else a real or missing entry with its own week, another season's week,
  // a Tenant B week or a missing week all answer the same authorization failure.
  const weeks = [['own week', W(PK, 12)], ['other-season week', W(SV, 9)], ['Tenant B week', W(PB, 1)], ['missing week', uuid()]];
  let m = 0;
  const ao2Null = [];
  for (const caller of ['F', 'E', 'G', 'C']) {
    for (const [entryLabel, entryId] of [['D entry', eid('PK-D03')], ['missing entry', uuid()]]) {
      for (const [weekLabel, weekId] of weeks) {
        for (const [src, exp] of [['participant', 'entry_not_owned'], ['commissioner_import', 'commissioner_required'], ['commissioner_manual', 'commissioner_required']]) {
          const x = await retryOnNull(() => submit(caller, weekId, entryId, src, card()));
          const r = x.result;
          m++;
          noteNull(rec, `AO2-${caller}-${m}`, x);
          if (x.nullAgain) { ao2Null.push(`AO2-${caller}-${m}`); continue; }
          const ok = failedWith(r, exp) && r.details == null && r.hint == null;
          if (!ok) rec.stop('P2', `AO2-${caller}-${m}`, `entry/week disclosure: ${caller} ${src} with ${entryLabel} and ${weekLabel} returned ${summarize(r)} instead of ${exp}`, {summary: summarize(r)});
        }
      }
    }
  }
  const ao2 = `${m} unauthorized entry/week probes (F, E, G, C × real or missing entry × own, other-season, Tenant B or missing week × 3 sources) all returned only entry_not_owned / commissioner_required`;
  if (ao2Null.length) rec.reliability('AO2', `${ao2}: not established`, unestablished(ao2Null));
  else rec.check('AO2', ao2, true, {summary: `probes=${m}`});
  // Authorized callers still learn that a week is not their entry's; a missing entry stays an authorization failure.
  const authorized = [];
  for (const [key, src, denied] of [['D', 'participant', 'entry_not_owned'], ['A', 'commissioner_import', 'commissioner_required'], ['B', 'commissioner_manual', 'commissioner_required']]) {
    for (const [weekLabel, weekId] of weeks.slice(1)) authorized.push([`${key} ${src} PK-D03 + ${weekLabel}`, await retryOnNull(() => submit(key, weekId, eid('PK-D03'), src, card())), 'invalid_entry_week']);
    const missingEntry = uuid();
    authorized.push([`${key} ${src} missing entry + own week`, await retryOnNull(() => submit(key, W(PK, 12), missingEntry, src, card())), denied]);
  }
  authorized.forEach(([, x], i) => noteNull(rec, `AO10-${i + 1}`, x));
  checkRetried(rec, 'AO10', 'owner D and Tenant A commissioners A, B: PK-D03 with another season\'s, a Tenant B or a missing week → invalid_entry_week; a missing entry → entry_not_owned / commissioner_required',
    authorized.map(([, x, exp]) => [x, r => failedWith(r, exp)]), {summary: authorized.map(([label, x]) => `${label}: ${summarize(x.result)}`).join('; ')});
  // Uniform answers where existence could otherwise leak.
  const pairs = [
    ['AO3', 'F', 'pool_platform_commissioner_context', {p_pool_slug: 'neighborhood-pickem'}, {p_pool_slug: 'no-such-pool-zz'}, 'commissioner_required'],
    ['AO4', 'F', 'pool_platform_participant_context', {p_pool_slug: 'neighborhood-pickem', p_season: null, p_week: null}, {p_pool_slug: 'no-such-pool-zz', p_season: null, p_week: null}, 'pool_not_found'],
    ['AO5', 'C', 'pool_platform_commissioner_context', {p_pool_slug: 'neighborhood-survivor'}, {p_pool_slug: 'no-such-pool-zz'}, 'commissioner_required'],
    ['AO6', 'D', 'pool_platform_commissioner_context', {p_pool_slug: 'neighborhood-pickem'}, {p_pool_slug: 'second-demo-pickem'}, 'commissioner_required'],
    ['AO7', 'E', 'pool_platform_participant_context', {p_pool_slug: 'second-demo-pickem', p_season: null, p_week: null}, {p_pool_slug: 'no-such-pool-zz', p_season: null, p_week: null}, 'pool_not_found'],
    ['AO8', 'F', 'pool_platform_submit_batch', {p_week_id: W(PK, 12), p_source: 'commissioner_import', p_items: []}, {p_week_id: uuid(), p_source: 'commissioner_import', p_items: []}, 'commissioner_required'],
    ['AO9', 'F', 'pool_platform_create_entry_invite', {p_entry_id: eid('PK-D03'), p_email: null, p_expires_hours: 24}, {p_entry_id: uuid(), p_email: null, p_expires_hours: 24}, 'commissioner_required']
  ];
  for (const [cid, key, fn, real, fake, exp] of pairs) {
    const t = await jwtFor(key);
    const a = await retryOnNull(() => rpc(t, fn, real)), b = await retryOnNull(() => rpc(t, fn, fake));
    noteNull(rec, `${cid}-real`, a);
    noteNull(rec, `${cid}-nonexistent`, b);
    checkRetried(rec, cid, `${key} ${fn}: real and nonexistent targets get the same ${exp}`, [a, b].map(x => [x, r => failedWith(r, exp)]),
      {summary: `${summarize(a.result)} | ${summarize(b.result)}`});
  }
}

// 5: direct table writes through the Data API, never with owner credentials.
export async function directwrite(rec) {
  const fx = state.fixtures;
  const tenantA = fx.tenant.A, poolA = fx.pools[PK].id, seasonA = fx.seasons[PK], weekA = W(PK, 12), entryD = eid('PK-D01');
  const shaHex = '\\x' + crypto.createHash('sha256').update('direct-write-probe').digest('hex');
  const W8 = {
    pool_platform_tenants: [{slug: 'dw-probe-tenant', display_name: 'DW Probe'}, `id=eq.${tenantA}`, {display_name: 'DW Probe Renamed'}],
    pool_platform_memberships: [self => ({tenant_id: tenantA, auth_user_id: self, role: 'owner'}), `tenant_id=eq.${tenantA}`, {role: 'owner'}],
    pool_platform_pools: [{tenant_id: tenantA, slug: 'dw-probe-pool', display_name: 'DW', pool_type: 'pickem'}, `id=eq.${poolA}`, {status: 'archived'}],
    pool_platform_seasons: [{pool_id: poolA, season: 2028}, `id=eq.${seasonA}`, {status: 'archived'}],
    pool_platform_entries: [{season_id: seasonA, entry_code: 'DW-PROBE', display_name: 'DW'}, `id=eq.${entryD}`, self => ({owner_auth_user_id: self})],
    pool_platform_weeks: [{season_id: seasonA, week: 25, deadline_at: '2030-01-01T00:00:00Z'}, `id=eq.${weekA}`, {deadline_at: '2030-01-01T00:00:00Z'}],
    pool_platform_submissions: [{week_id: weekA, entry_id: entryD, source: 'participant', payload: {picks: {}}}, `entry_id=eq.${entryD}`, {source: 'commissioner_import', revision: 99}],
    pool_platform_submission_audit: [{submission_id: uuid(), action: 'created', source: 'participant'}, 'id=gt.0', {reason: 'dw'}],
    pool_platform_entry_invites: [self => ({entry_id: entryD, token_sha256: shaHex, expires_at: '2030-01-01T00:00:00Z', created_by_auth_user_id: self}), `entry_id=eq.${entryD}`, {revoked_at: null, claimed_at: null}]
  };
  const callers = [['noauth', null, null], ['anonJWT', secrets.anon?.jwt ?? null, null], ['D', await jwtFor('D'), state.users.D.id], ['A', await jwtFor('A'), state.users.A.id], ['C', await jwtFor('C'), state.users.C.id]];
  const tally = {};
  for (const [label, token, self] of callers) {
    if (label === 'anonJWT' && !token) { rec.info('DW-anonJWT', 'anonymous JWT not available; skipped'); continue; }
    for (const [tbl, [ins, filter, patch]] of Object.entries(W8)) {
      for (const [verb, method, p, body] of [['INSERT', 'POST', `/${tbl}`, typeof ins === 'function' ? ins(self) : ins],
        ['UPDATE', 'PATCH', `/${tbl}?${filter}`, typeof patch === 'function' ? patch(self) : patch], ['DELETE', 'DELETE', `/${tbl}?${filter}`, undefined]]) {
        const r = await data(method, p, {token, body, headers: {prefer: 'return=minimal'}});
        const key = `${label}:${verb}`;
        tally[key] = tally[key] || {};
        tally[key][`${r.status} ${r.code ?? ''}`.trim()] = (tally[key][`${r.status} ${r.code ?? ''}`.trim()] || 0) + 1;
        if (r.ok) rec.stop('P0', `DW-${label}-${verb}-${tbl}`, `direct ${verb} on ${tbl} by ${label} returned ${r.status}`, {summary: summarize(r)});
      }
    }
  }
  for (const [k, v] of Object.entries(tally)) rec.check(`DW-${k}`, `direct ${k.split(':')[1]} by ${k.split(':')[0]} denied on all 9 tables`, true, {summary: JSON.stringify(v)});
  for (const fn of ['nextval', 'setval']) {
    const r = await rpc(await jwtFor('A'), fn, fn === 'nextval' ? {regclass: 'pool_platform_submission_audit_id_seq'} : {regclass: 'pool_platform_submission_audit_id_seq', bigint: 1});
    rec.check(`DW-${fn}`, `${fn}() on the audit sequence is not reachable through the Data API`, !r.ok, {summary: summarize(r)});
  }
}

// 16/17: RPC surface, internal helpers, schema switching, pgcrypto.
export async function surface(rec) {
  const callers = [['noauth', null], ['anonJWT', secrets.anon?.jwt ?? null], ['D', await jwtFor('D')]];
  for (const [label, token] of callers) {
    if (label === 'anonJWT' && !token) continue;
    const r = await data('GET', '/', {token});
    const paths = r.json && typeof r.json === 'object' && r.json.paths ? Object.keys(r.json.paths) : null;
    rec.info(`SF-root-${label}`, `Data API root (OpenAPI) as ${label}`, {summary: `${summarize(r)} paths=${paths ? paths.length : '-'}`, paths});
  }
  const fx = state.fixtures;
  const intended = [
    ['pool_platform_current_user_id', {}], ['pool_platform_is_tenant_commissioner', {p_tenant_id: fx.tenant.A}],
    ['pool_platform_can_read_pool', {p_pool_id: fx.pools[PK].id}], ['pool_platform_can_read_season', {p_season_id: fx.seasons[PK]}],
    ['pool_platform_create_entry_invite', {p_entry_id: uuid(), p_email: null, p_expires_hours: 24}], ['pool_platform_claim_entry_invite', {p_invite_token: '0'.repeat(64)}],
    ['pool_platform_submit_entry', {p_week_id: uuid(), p_entry_id: uuid(), p_source: 'participant', p_payload: {}}],
    ['pool_platform_submit_batch', {p_week_id: uuid(), p_source: 'commissioner_import', p_items: []}],
    ['pool_platform_participant_context', {p_pool_slug: 'no-such-pool-zz', p_season: null, p_week: null}], ['pool_platform_commissioner_context', {p_pool_slug: 'no-such-pool-zz'}]
  ];
  const internal = [
    ['pool_platform_current_user_email', {}], ['pool_platform_current_user_has_verified_email', {p_email_normalized: state.users.D.email}],
    ['pool_platform_payload_valid', {p_pool_type: 'pickem', p_week_config: {games: [{id: 'g1'}]}, p_entry_id: eid('PK-D03'), p_week_id: W(PK, 12), p_payload: {picks: {g1: 'away'}}}],
    ['pool_platform_guard_submission_source', {}]
  ];
  const tD = await jwtFor('D');
  for (const [fn, args] of intended) {
    const a = await rpc(tD, fn, args);
    const executed = a.ok || a.code === 'P0001';
    // This check is about EXECUTE (a NULL identity proves it too), but the identity it returns is still classified.
    const identity = fn === 'pool_platform_current_user_id' ? {expected_user_id: state.users.D.id, classification: classifyIdentity(state.users.D.id, a)} : {};
    if (identity.classification === IDENTITY.WRONG) rec.stop('P0', `SF-auth-${fn}`, `D's JWT resolved to another user id`, {summary: summarize(a), ...identity, returned_user_id: a.json});
    rec.check(`SF-auth-${fn}`, `authenticated can execute ${fn}`, executed, {summary: summarize(a), ...identity});
    for (const [label, token] of callers.slice(0, 2)) {
      if (label === 'anonJWT' && !token) continue;
      const x = await rpc(token, fn, args);
      if (x.ok || x.code === 'P0001') rec.stop('P0', `SF-${label}-${fn}`, `${label} executed ${fn}`, {summary: summarize(x)});
      rec.check(`SF-${label}-${fn}`, `${label} cannot execute ${fn}`, true, {summary: summarize(x)});
    }
  }
  for (const [fn, args] of internal) {
    for (const [label, token] of [['D', tD], ['A', await jwtFor('A')], ...callers.slice(0, 2)]) {
      if (label === 'anonJWT' && !token) continue;
      const x = await rpc(token, fn, args);
      if (x.ok) rec.stop('P0', `SF-int-${label}-${fn}`, `internal helper ${fn} executable by ${label} through the Data API`, {summary: summarize(x)});
      rec.check(`SF-int-${label}-${fn}`, `internal helper ${fn} not executable by ${label}`, !x.ok, {summary: summarize(x)});
    }
  }
  for (const [cid, method, p, prof] of [['SF-prof-neon_auth', 'GET', '/user?select=id,email', 'neon_auth'], ['SF-prof-neon_auth-session', 'GET', '/session?select=id', 'neon_auth'],
    ['SF-prof-auth', 'POST', '/rpc/user_id', 'auth']]) {
    for (const [label, token] of [['noauth', null], ['D', tD]]) {
      const x = await data(method, p, {token, body: method === 'POST' ? {} : undefined, headers: {[method === 'GET' ? 'accept-profile' : 'content-profile']: prof}});
      if (x.ok) rec.stop('P0', `${cid}-${label}`, `schema ${prof} reachable via profile header by ${label}`, {summary: summarize(x)});
      rec.check(`${cid}-${label}`, `schema ${prof} not reachable through the Data API (${label})`, !x.ok, {summary: summarize(x)});
    }
  }
  // pgcrypto (benign calls only; no crypt/gen_salt).
  const pg = [
    ['gen_random_bytes', 'POST', '/rpc/gen_random_bytes', {}, null], ['gen_random_bytes(16) raw', 'POST', '/rpc/gen_random_bytes', '16', 'text/plain'],
    ['digest', 'POST', '/rpc/digest', {}, null], ['digest raw', 'POST', '/rpc/digest', 'abc', 'text/plain'],
    ['gen_random_uuid', 'POST', '/rpc/gen_random_uuid', {}, null], ['fips_mode', 'POST', '/rpc/fips_mode', {}, null]
  ];
  const pgOut = {};
  for (const [label, token] of callers) {
    if (label === 'anonJWT' && !token) continue;
    for (const [name, method, p, body, ctype] of pg) {
      const x = await data(method, p, {token, body, raw: !!ctype, headers: ctype ? {'content-type': ctype} : {}});
      const value = x.ok ? (typeof x.json === 'string' ? `string len=${x.json.length}` : JSON.stringify(x.json)?.slice(0, 40)) : null;
      pgOut[`${label}:${name}`] = `${summarize(x)}${value ? ` value=${value}` : ''}`;
      rec.info(`PG-${label}-${name}`, `pgcrypto ${name} as ${label}`, {summary: pgOut[`${label}:${name}`]});
    }
  }
  state.results.pgcrypto = pgOut;
  save();
}

// 4: isolation matrix. Leak direction is checked row by row (STOP on violation); completeness by id sets.
export async function isolation(rec, keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G', ...(state.users.H ? ['H'] : [])]) {
  const fx = state.fixtures;
  const A = {tenant: fx.tenant.A, pools: new Set([fx.pools[PK].id, fx.pools[SV].id]), seasons: new Set([fx.seasons[PK], fx.seasons[SV]]),
    weeks: new Set([...Object.values(fx.weeks[PK]), ...Object.values(fx.weeks[SV])].map(w => w.id)), entries: new Set(Object.values(fx.entries).filter(e => e.slug !== PB).map(e => e.id))};
  const B = {tenant: fx.tenant.B, pools: new Set([fx.pools[PB].id]), seasons: new Set([fx.seasons[PB]]),
    weeks: new Set(Object.values(fx.weeks[PB]).map(w => w.id)), entries: new Set(Object.values(fx.entries).filter(e => e.slug === PB).map(e => e.id))};
  const seasonOf = {}; for (const [slug, id] of Object.entries(fx.seasons)) seasonOf[slug] = id;
  const ownedBy = k => new Set(Object.entries(state.owned).filter(([, w]) => w === k).map(([c]) => eid(c)));
  const isComm = key => key === 'A' || key === 'B' || key === 'C';
  // Reads that cannot come back empty once the identity resolves: a commissioner's own tenant, memberships, pools,
  // seasons, entries and weeks (fixtures, O1), and a participant's owned entries with their tenants, pools, seasons
  // and weeks. A NULL identity sees no row of any table, so no rows there is the NULL-identity signal and that read
  // runs once more. A commissioner sees audit rows only with their submissions, so audit rows beside an empty
  // submissions read is the same signal.
  const rowsCertain = (key, tbl, v) => isComm(key)
    ? ['pool_platform_tenants', 'pool_platform_memberships', 'pool_platform_pools', 'pool_platform_seasons', 'pool_platform_entries',
      'pool_platform_weeks'].includes(tbl) || (tbl === 'pool_platform_submissions' && v.pool_platform_submission_audit.length > 0)
    : ownedBy(key).size > 0 && ['pool_platform_tenants', 'pool_platform_pools', 'pool_platform_seasons', 'pool_platform_entries', 'pool_platform_weeks'].includes(tbl);
  const view = {}, errored = {}, stillNull = {};
  for (const key of keys) {
    const t = await jwtFor(key);
    const v = {};
    errored[key] = [];
    stillNull[key] = [];
    const readFailed = (tbl, r) => { rec.check(`ISO-${key}-${tbl}-read`, `${key} can query ${tbl} (RLS-filtered)`, false, {summary: summarize(r)}); errored[key].push(tbl); };
    for (const tbl of TABLES) {
      const r = await data('GET', `/${tbl}?select=*`, {token: t});
      if (!r.ok) { readFailed(tbl, r); v[tbl] = []; continue; }
      v[tbl] = r.json;
    }
    for (const tbl of TABLES) {
      if (v[tbl].length || errored[key].includes(tbl) || !rowsCertain(key, tbl, v)) continue;
      const r = await data('GET', `/${tbl}?select=*`, {token: t});
      rec.info(`ISO-${key}-${tbl}-null`, `${key} got no ${tbl} row where its identity must see rows (NULL identity); read once more`,
        {classification: IDENTITY.NULL, retry: `${summarize(r)} rows=${r.ok && Array.isArray(r.json) ? r.json.length : '-'}`});
      if (!r.ok) readFailed(tbl, r);
      else if (r.json.length) v[tbl] = r.json;
      else stillNull[key].push(tbl);
    }
    view[key] = v;
  }
  const leak = (key, desc, bad) => { if (bad.length) rec.stop('P0', `ISO-${key}-leak`, `${key}: ${desc}`, {summary: `${bad.length} row(s)`}); };
  for (const key of keys) {
    const v = view[key];
    // A leak check against the fixtures always runs: any row a read returns is a real row. A check that compares one
    // read with another runs only when the read it compares with answered, never on a read left empty by NULL
    // identity (or failed), which would turn every row of the other into a false leak.
    const answered = tbl => !errored[key].includes(tbl) && !stillNull[key].includes(tbl);
    const settle = (desc, pass, detail) => stillNull[key].length
      ? rec.reliability(`ISO-${key}`, `${desc}: not established, ${stillNull[key].join(', ')} returned no rows on the read and on its one retry`, detail)
      : rec.check(`ISO-${key}`, desc, !errored[key].length && pass, detail);
    if (isComm(key)) {
      const T = key === 'C' ? B : A, O = key === 'C' ? A : B;
      leak(key, 'other-tenant tenant rows', v.pool_platform_tenants.filter(x => x.id !== T.tenant));
      leak(key, 'other-tenant memberships', v.pool_platform_memberships.filter(x => x.tenant_id !== T.tenant));
      leak(key, 'other-tenant pools', v.pool_platform_pools.filter(x => !T.pools.has(x.id)));
      leak(key, 'other-tenant seasons', v.pool_platform_seasons.filter(x => !T.seasons.has(x.id)));
      leak(key, 'other-tenant weeks', v.pool_platform_weeks.filter(x => !T.weeks.has(x.id)));
      leak(key, 'other-tenant entries', v.pool_platform_entries.filter(x => !T.entries.has(x.id)));
      leak(key, 'other-tenant submissions', v.pool_platform_submissions.filter(x => !T.entries.has(x.entry_id)));
      if (answered('pool_platform_submissions')) {
        const subIds = new Set(v.pool_platform_submissions.map(x => x.id));
        leak(key, 'audit rows of submissions outside its view', v.pool_platform_submission_audit.filter(x => !subIds.has(x.submission_id)));
      }
      leak(key, 'other-tenant invites', v.pool_platform_entry_invites.filter(x => !T.entries.has(x.entry_id)));
      const complete = v.pool_platform_pools.length === T.pools.size && v.pool_platform_seasons.length === T.seasons.size && v.pool_platform_weeks.length === T.weeks.size && v.pool_platform_entries.length === T.entries.size;
      settle(`${key} (${key === 'C' ? 'Tenant B' : 'Tenant A'} commissioner) sees its whole tenant and nothing of the other`, complete && v.pool_platform_tenants.length === 1,
        {summary: `tenants=${v.pool_platform_tenants.length} memberships=${v.pool_platform_memberships.length} pools=${v.pool_platform_pools.length} seasons=${v.pool_platform_seasons.length} weeks=${v.pool_platform_weeks.length} entries=${v.pool_platform_entries.length} submissions=${v.pool_platform_submissions.length} audit=${v.pool_platform_submission_audit.length} invites=${v.pool_platform_entry_invites.length}`});
      state.results[`iso_${key}`] = Object.fromEntries(TABLES.map(tb => [tb, v[tb].length]));
      void O;
    } else {
      const mine = ownedBy(key);
      leak(key, "entries it does not own (another participant's or tenant's)", v.pool_platform_entries.filter(x => !mine.has(x.id)));
      leak(key, "submissions of entries it does not own", v.pool_platform_submissions.filter(x => !mine.has(x.entry_id)));
      leak(key, 'audit rows (commissioner-only)', v.pool_platform_submission_audit);
      leak(key, 'invite rows (commissioner-only)', v.pool_platform_entry_invites);
      leak(key, 'membership rows (it has none)', v.pool_platform_memberships);
      if (answered('pool_platform_entries')) {
        const mySeasons = new Set(v.pool_platform_entries.map(x => x.season_id));
        leak(key, 'seasons without an owned entry', v.pool_platform_seasons.filter(x => !mySeasons.has(x.id)));
        leak(key, 'weeks outside seasons it participates in', v.pool_platform_weeks.filter(x => !mySeasons.has(x.season_id)));
      }
      if (answered('pool_platform_seasons')) {
        const myPools = new Set(v.pool_platform_seasons.map(x => x.pool_id));
        leak(key, 'pools without an owned entry', v.pool_platform_pools.filter(x => !myPools.has(x.id)));
      }
      if (answered('pool_platform_pools')) leak(key, 'tenants without an owned entry', v.pool_platform_tenants.filter(x => !v.pool_platform_pools.some(p => p.tenant_id === x.id)));
      const exact = v.pool_platform_entries.length === mine.size;
      settle(`${key} sees exactly its own ${mine.size} entr${mine.size === 1 ? 'y' : 'ies'} and their context, nothing else`, exact,
        {summary: `tenants=${v.pool_platform_tenants.length} pools=${v.pool_platform_pools.length} seasons=${v.pool_platform_seasons.length} weeks=${v.pool_platform_weeks.length} entries=${v.pool_platform_entries.length} submissions=${v.pool_platform_submissions.length} audit=0 invites=0 memberships=0`});
      state.results[`iso_${key}`] = Object.fromEntries(TABLES.map(tb => [tb, v[tb].length]));
    }
  }
  // Anonymous: no header and anonymous JWT.
  for (const [label, token] of [['noauth', null], ['anonJWT', secrets.anon?.jwt ?? null]]) {
    if (label === 'anonJWT' && !token) continue;
    const codes = {};
    for (const tbl of TABLES) {
      const r = await data('GET', `/${tbl}?select=*`, {token});
      if (r.ok && Array.isArray(r.json) && r.json.length) rec.stop('P0', `ISO-${label}-${tbl}`, `${label} read ${r.json.length} protected row(s) of ${tbl}`, {summary: summarize(r)});
      codes[`${r.status} ${r.code ?? ''}`.trim()] = (codes[`${r.status} ${r.code ?? ''}`.trim()] || 0) + 1;
    }
    rec.check(`ISO-${label}`, `${label}: no protected rows from any of the 9 tables`, true, {summary: JSON.stringify(codes)});
  }
  // Context RPCs. auth_required (NULL identity) gets one retry; NULL again is a RELIABILITY failure, never INFO.
  const ctx = async (id, key, fn, args) => {
    const t = await jwtFor(key);
    const x = await retryOnNull(() => rpc(t, fn, args));
    noteNull(rec, id, x);
    return x;
  };
  const one = (x, pass) => [[x, pass]];
  let x = await ctx('ISO-ctx1', 'A', 'pool_platform_commissioner_context', {p_pool_slug: PB});
  checkRetried(rec, 'ISO-ctx1', 'A cannot load the Tenant B commissioner context', one(x, r => failedWith(r, 'commissioner_required')), {summary: summarize(x.result)});
  x = await ctx('ISO-ctx2', 'C', 'pool_platform_commissioner_context', {p_pool_slug: PK});
  checkRetried(rec, 'ISO-ctx2', 'C cannot load a Tenant A commissioner context', one(x, r => failedWith(r, 'commissioner_required')), {summary: summarize(x.result)});
  x = await ctx('ISO-ctx3', 'B', 'pool_platform_commissioner_context', {p_pool_slug: SV});
  checkRetried(rec, 'ISO-ctx3', 'co-commissioner B loads a Tenant A commissioner context', one(x, r => r.ok && r.json?.pool?.slug === SV), {summary: summarize(x.result)});
  for (const key of ['D', 'E', ...(state.users.H ? ['H'] : [])]) {
    const mine = ownedBy(key);
    for (const slug of [PK, SV]) {
      const cid = `ISO-pctx-${key}-${slug}`, desc = `${key} participant context for ${slug} lists only its own active entries and their own history`;
      x = await ctx(cid, key, 'pool_platform_participant_context', {p_pool_slug: slug, p_season: null, p_week: null});
      const r = x.result;
      if (x.nullAgain) { checkRetried(rec, cid, desc, one(x, () => false), {summary: summarize(r)}); continue; }
      if (!r.ok) { rec.info(cid, `${key} participant context ${slug}`, {summary: summarize(r)}); continue; }
      const foreign = r.json.entries.filter(e => !mine.has(e.id));
      const text = JSON.stringify(r.json);
      const otherIds = [...Object.values(state.fixtures.entries)].map(e => e.id).filter(id => !mine.has(id) && text.includes(id));
      if (foreign.length || otherIds.length) rec.stop('P0', cid, `${key} participant context exposes other entries`, {summary: `${foreign.length}/${otherIds.length}`});
      rec.check(cid, desc, true, {summary: `entries=${r.json.entries.length} week=${r.json.week?.week}`});
    }
    x = await ctx(`ISO-pctx-${key}-${PB}`, key, 'pool_platform_participant_context', {p_pool_slug: PB, p_season: null, p_week: null});
    checkRetried(rec, `ISO-pctx-${key}-${PB}`, `${key} cannot load the Tenant B participant context`, one(x, r => failedWith(r, 'pool_not_found')), {summary: summarize(x.result)});
  }
  for (const key of ['F', 'G']) for (const slug of [PK, SV, PB]) {
    x = await ctx(`ISO-out-${key}-${slug}`, key, 'pool_platform_participant_context', {p_pool_slug: slug, p_season: null, p_week: null});
    checkRetried(rec, `ISO-out-${key}-${slug}`, `${key} participant context ${slug} → pool_not_found`, one(x, r => failedWith(r, 'pool_not_found')), {summary: summarize(x.result)});
  }
  save();
}

export async function expiredinv(rec) {
  for (const [code, cid, desc] of [['PK-INV-EXP', 'IX1', 'expired'], ['PK-INV-REV', 'IX2', 'revoked']]) {
    for (const key of ['E', 'D']) {
      const r = await claim(key, secrets.invites[code]);
      if (r.ok) rec.stop('P1', `${cid}-${key}`, `${desc} invite claimed`, {summary: summarize(r)});
      rec.check(`${cid}-${key}`, `${desc} invite cannot be claimed (${key})`, failedWith(r, 'invite_unavailable'), {summary: summarize(r)});
    }
  }
}

export async function locked(rec) {
  const w7 = W(PK, 7);
  const cases = [
    ['LK1', 'D', 'PK-LOCK-P', 'participant', 'submission_locked', 'same-source participant edit of a locked row'],
    ['LK2', 'A', 'PK-LOCK-P', 'commissioner_import', 'source_conflict:participant', 'commissioner on a locked participant row'],
    ['LK3', 'A', 'PK-LOCK-C', 'commissioner_manual', 'submission_locked', 'same-source commissioner_manual edit of a locked row (A)'],
    ['LK4', 'B', 'PK-LOCK-C', 'commissioner_manual', 'submission_locked', 'same-source commissioner_manual edit of a locked row (co-commissioner B)'],
    ['LK5', 'D', 'PK-LOCK-C', 'participant', 'source_conflict:commissioner_manual', 'participant on a locked commissioner row'],
    ['LK6', 'F', 'PK-LOCK-P', 'participant', 'entry_not_owned', 'outsider on a locked row']
  ];
  for (const [cid, key, code, src, exp, desc] of cases) {
    const r = await submit(key, w7, eid(code), src, card('hhhhh', 77));
    if (r.ok) rec.stop('P0', cid, `${desc} modified a locked row`, {summary: summarize(r)});
    rec.check(cid, `${desc} → ${exp}`, failedWith(r, exp), {summary: summarize(r)});
  }
  for (const [code, key] of [['PK-LOCK-P', 'D'], ['PK-LOCK-C', 'A']]) {
    const row = await subRow(key, w7, eid(code));
    rec.check(`LK-${code}`, `${code} row still locked at revision 1`, row?.status === 'locked' && row?.revision === 1, {summary: JSON.stringify({status: row?.status, revision: row?.revision})});
  }
}

export async function deadline(rec) {
  const r0 = await rpc(await jwtFor('A'), 'pool_platform_commissioner_context', {p_pool_slug: PK});
  const w5 = r0.json?.seasons?.[0]?.weeks?.find(w => w.week === 5);
  if (!w5) { rec.check('DL0', 'deadline probe week 5 exists', false, {summary: summarize(r0)}); return; }
  state.fixtures.weeks[PK][5] = {id: w5.id, status: w5.status, deadline_at: w5.deadline_at}; save();
  const dl = Date.parse(w5.deadline_at);
  const left = Math.round((dl - Date.now()) / 1000);
  rec.info('DL0', 'deadline probe week 5', {summary: `deadline in ${left}s`});
  if (left < 20) { rec.check('DL1', 'enough time before the probe deadline', false, {summary: `${left}s left`}); return; }
  let r = await submit('D', w5.id, eid('PK-DL'), 'participant', card('aaaah', 60));
  rec.check('DL1', 'before the deadline: participant submission succeeds', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await submit('A', w5.id, eid('PK-D02'), 'commissioner_manual', card('hhhha', 61));
  rec.check('DL2', 'before the deadline: commissioner submission succeeds', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  while (Date.now() < dl + 3000) await sleep(Math.min(5000, dl + 3000 - Date.now()));
  for (const [cid, key, code, src, desc] of [['DL3', 'D', 'PK-DL', 'participant', 'same-source edit after the deadline'], ['DL4', 'A', 'PK-D02', 'commissioner_manual', 'commissioner same-source edit after the deadline'],
    ['DL5', 'D', 'PK-D01', 'participant', 'new participant submission after the deadline'], ['DL6', 'A', 'PK-D03', 'commissioner_import', 'new commissioner import after the deadline']]) {
    r = await submit(key, w5.id, eid(code), src, card('hahah', 62));
    if (r.ok) rec.stop('P1', cid, `${desc} accepted`, {summary: summarize(r)});
    rec.check(cid, `${desc} → deadline_passed`, failedWith(r, 'deadline_passed'), {summary: summarize(r)});
  }
  const row = await subRow('D', w5.id, eid('PK-DL'));
  rec.check('DL7', 'the pre-deadline row is unchanged (revision 1)', row?.revision === 1, {summary: `revision=${row?.revision}`});
}

// On the commercial endpoint the Data API accepted a JWT until about 29 s after its exp and rejected it from about
// 31-33 s (an expired JWT answers HTTP 400). The expired-token assertion therefore runs only once a token is at least
// JWT_EXPIRY_GATE_S past exp: a token already past exp waits for the gate (at most that long); one not yet expired is
// left for a later run. An accepted request past the gate is still a P0 stop.
export const JWT_EXPIRY_GATE_S = 35;

export async function jwtexpiry(rec) {
  let tested = 0;
  const notYet = [];
  for (const [key, tok] of Object.entries(secrets.firstJwts || {})) {
    if (!tok) continue;
    const exp = decodeJwt(tok).payload.exp;
    const pastExpNow = Date.now() / 1000 - exp;
    if (pastExpNow < 0) { notYet.push({key, exp, seconds_past_exp: Number(pastExpNow.toFixed(3))}); continue; }
    const waitedMs = pastExpNow < JWT_EXPIRY_GATE_S ? Math.ceil((JWT_EXPIRY_GATE_S - pastExpNow) * 1000) : 0;
    if (waitedMs) await sleep(waitedMs);
    // Captured before the probe request: the JWT's exp, when the probe starts and how far past exp that is.
    const probeStart = Date.now();
    const timing = {exp, exp_at: new Date(exp * 1000).toISOString(), probe_start: new Date(probeStart).toISOString(),
      seconds_past_exp: Number((probeStart / 1000 - exp).toFixed(3)), gate_s: JWT_EXPIRY_GATE_S, waited_ms: waitedMs};
    const r = await rpc(tok, 'pool_platform_current_user_id');
    if (r.ok) rec.stop('P0', `JX-${key}`, `expired JWT accepted ${timing.seconds_past_exp}s past exp`,
      {summary: summarize(r), timing, identity: classifyIdentity(state.users[key].id, r)});
    rec.check(`JX-${key}`, `${key}'s first JWT, ${timing.seconds_past_exp}s past exp at probe start, is rejected`, !r.ok, {summary: summarize(r), timing});
    const fresh = await jwtFor(key);
    await identityProbe(rec, `JX-${key}-fresh`, `${key} with a freshly issued JWT works again`, state.users[key].id,
      () => rpc(fresh, 'pool_platform_current_user_id'));
    if (++tested >= 3) break;
  }
  if (notYet.length) rec.info('JX-gate', `${notYet.length} first JWT(s) not yet past exp: not asserted (gate ${JWT_EXPIRY_GATE_S}s past exp)`, {tokens: notYet});
  if (!tested) rec.info('JX', 'no stored JWT has expired yet; run this phase again later');
}

export async function signout(rec, key = 'F') {
  const id = ident(key);
  const jwt = await jwtFor(key);
  let r = await authCall(id, 'POST', '/sign-out', {});
  rec.check('SO1', `${key} signs out`, r.status === 200, {summary: `HTTP ${r.status}`});
  r = await authCall(id, 'GET', '/get-session');
  rec.check('SO2', 'after sign-out the session cookie no longer yields a session', r.status === 200 ? !r.json?.session : r.status >= 400, {summary: `HTTP ${r.status} session=${!!r.json?.session}`});
  r = await authCall(id, 'GET', '/token');
  rec.check('SO3', 'after sign-out /token issues no JWT', !(r.status === 200 && JWT_SHAPE.test(r.json?.token || '')), {summary: `HTTP ${r.status}`});
  await identityProbe(rec, 'SO4', `JWT minted before sign-out, ${jwtSecondsLeft(jwt)}s before its exp (stateless JWTs stay valid until exp)`, state.users[key].id,
    () => rpc(jwt, 'pool_platform_current_user_id'), {informational: true});
  id.jwt = null; id.jar = {}; save();
}

// Operator mailbox identity H: real Email OTP through the pinned SDK. The OTP is read from PP_H_OTP and never logged.
async function sdkClientFor(key) {
  const id = ident(key);
  const authHost = new URL(AUTH_URL).host;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).host !== authHost) return realFetch(input, init);
    const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
    const ck = Object.entries(id.jar || {}).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) headers.set('cookie', ck);
    if (ORIGIN && !headers.has('origin')) headers.set('origin', ORIGIN);
    const res = await realFetch(url, {...init, headers});
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';'); const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      id.jar ||= {};
      if (value && !/max-age=0/i.test(sc)) id.jar[name] = value; else delete id.jar[name];
    }
    save();
    return res;
  };
  const {createClient} = await import('@neondatabase/neon-js');
  return {neon: createClient({auth: {url: AUTH_URL}, dataApi: {url: DATA_URL}}), restore: () => { globalThis.fetch = realFetch; }};
}

export async function human_send(rec) {
  const email = process.env.PP_H_EMAIL;
  if (!email) { rec.info('H0', 'PP_H_EMAIL not set; skipped'); return; }
  const id = ident('H'); id.email = email; id.jar = {}; save();
  const {neon, restore} = await sdkClientFor('H');
  try {
    const {PlatformClient} = await repoModule('platform-client.js');
    const pc = new PlatformClient({mode: 'live', authUrl: AUTH_URL, dataUrl: DATA_URL, defaultPoolSlug: PK});
    pc.neon = neon;
    let err = null;
    try { await pc.sendOtp(email); } catch (e) { err = e; }
    rec.check('H1', 'PlatformClient.sendOtp (pinned SDK emailOtp, type sign-in) accepted for the operator mailbox', !err, {summary: err ? scrub(err.message) : 'OTP email requested'});
  } finally { restore(); }
}

export async function human_verify(rec) {
  const otp = process.env.PP_H_OTP;
  const id = ident('H');
  if (!otp || !id.email) { rec.info('H2', 'PP_H_OTP or H email missing; skipped'); return; }
  const {neon, restore} = await sdkClientFor('H');
  try {
    const {PlatformClient} = await repoModule('platform-client.js');
    const {extractAccessToken} = await repoModule('auth-core.js');
    const pc = new PlatformClient({mode: 'live', authUrl: AUTH_URL, dataUrl: DATA_URL, defaultPoolSlug: PK});
    pc.neon = neon;
    let sess = null, err = null;
    try { sess = await pc.verifyOtp(id.email, otp); } catch (e) { err = e; }
    rec.check('H2', 'real Email OTP sign-in (PlatformClient.verifyOtp) produces a session', !!sess?.session && !err, {summary: err ? scrub(err.message) : `session=${!!sess?.session}`});
    if (!sess) return;
    const gs = await neon.auth.getSession();
    const tok = extractAccessToken(gs);
    rec.check('H3', 'client-accessible session.token holds the JWT the pinned SDK exposes', !!tok && tok === gs?.data?.session?.token, {claims: tok ? claimsSummary(tok, {maskEmail: true}) : null});
    state.users.H = {id: sess.user.id, email: id.email.replace(/^(.).*(@.*)$/, '$1***$2'), label: 'Operator mailbox participant (real OTP)', emailVerifiedAfterOtp: sess.user.emailVerified};
    save();
    rec.check('H4', 'OTP sign-in marks the operator email verified (Neon Auth user object)', sess.user.emailVerified === true, {summary: `emailVerified=${sess.user.emailVerified}`});
    await identityProbe(rec, 'H5', 'auth.user_id() resolves to H through the Data API (PlatformClient.rpc)', sess.user.id,
      () => clientResult(() => pc.rpc('pool_platform_current_user_id')));
    let cl;
    try { cl = await pc.claimInvite(secrets.invites['PK-H01']); } catch (e) { cl = {error: scrub(e.message)}; }
    rec.check('H6', 'email-bound invite + matching VERIFIED email → claimed', cl?.claimed === true && cl?.entry_id === eid('PK-H01'), {summary: JSON.stringify(cl)});
    if (cl?.claimed) { state.owned['PK-H01'] = 'H'; save(); }
    try { cl = await pc.claimInvite(secrets.invites['PK-H01']); } catch (e) { cl = {error: scrub(e.message)}; }
    rec.check('H7', 'the claimed bound invite cannot be claimed again', /no longer available|expired, already used/i.test(cl?.error || ''), {summary: JSON.stringify(cl)});
    // Keep the H session usable by jwtFor('H').
    const t = await authCall(id, 'GET', '/token');
    if (t.status === 200 && JWT_SHAPE.test(t.json?.token || '')) { id.jwt = t.json.token; save(); }
  } finally { restore(); }
}
