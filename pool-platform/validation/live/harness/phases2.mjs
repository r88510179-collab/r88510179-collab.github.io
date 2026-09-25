// Phases: invites, tenantb, sourcelock, srcrace, payload, survivor.
import crypto from 'node:crypto';
import {secrets, state, save, data, rpc, jwtFor, summarize, failedWith, newDispatcher, uuid, sleep} from './lib.mjs';

export const eid = code => { const e = state.fixtures.entries[code]; if (!e) throw new Error(`unknown entry ${code}`); return e.id; };
export const W = (slug, n) => { const w = state.fixtures.weeks[slug]?.[n]; if (!w) throw new Error(`unknown week ${slug}#${n}`); return w.id; };
export const PK = 'neighborhood-pickem', SV = 'neighborhood-survivor', PB = 'second-demo-pickem';
export const card = (pattern = 'ahaha', tb = 10) => {
  const picks = {};
  ['g1', 'g2', 'g3', 'g4', 'g5'].forEach((g, i) => { picks[g] = pattern[i] === 'a' ? 'away' : 'home'; });
  return tb === undefined ? {picks} : {picks, tiebreak: tb};
};
export const submit = async (key, weekId, entryId, source, payload, opts = {}) =>
  rpc(await jwtFor(key), 'pool_platform_submit_entry', {p_week_id: weekId, p_entry_id: entryId, p_source: source, p_payload: payload}, opts);
export const createInvite = async (key, entryId, email = null, hours = 24) =>
  rpc(await jwtFor(key), 'pool_platform_create_entry_invite', {p_entry_id: entryId, p_email: email, p_expires_hours: hours});
export const claim = async (key, token, opts = {}) => rpc(await jwtFor(key), 'pool_platform_claim_entry_invite', {p_invite_token: token}, opts);
export async function subRow(key, weekId, entryId) {
  const r = await data('GET', `/pool_platform_submissions?select=id,source,status,revision,payload,submitted_by_auth_user_id&week_id=eq.${weekId}&entry_id=eq.${entryId}`, {token: await jwtFor(key)});
  return r.ok ? (r.json[0] ?? null) : {error: summarize(r)};
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hex64 = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

// Fire the sides' requests at the same instant on separate, pre-warmed connections. Results are index-aligned.
export async function race(sides, {headStartMs = 0} = {}) {
  const prep = await Promise.all(sides.map(async s => ({...s, token: await jwtFor(s.key), dispatcher: newDispatcher()})));
  await Promise.all(prep.map(s => rpc(s.token, 'pool_platform_current_user_id', {}, {dispatcher: s.dispatcher})));
  const results = await Promise.all(prep.map((s, i) => (i > 0 && headStartMs ? sleep(headStartMs) : Promise.resolve()).then(() => s.fn(s.token, s.dispatcher))));
  await Promise.all(prep.map(s => s.dispatcher.close()));
  const overlapMs = Math.round(Math.min(...results.map(r => r.t1)) - Math.max(...results.map(r => r.t0)));
  return {results, overlapMs};
}

const OWN = {
  D: ['PK-D01', 'PK-D02', 'PK-D03', 'PK-RACE01', 'PK-RACE02', 'PK-RACE03', 'PK-RACE04', 'PK-RACE05', 'PK-RACE06', 'PK-INACTIVE',
    'PK-ELIMINATED', 'PK-ARCHIVED', 'PK-LOCK-P', 'PK-LOCK-C', 'PK-DL', 'PK-PAY', 'PK-MAN', 'PK-BATCH02', 'SV-D01', 'SV-D02', 'SV-D03',
    'SV-RACE01', 'SV-RACE02', 'SV-RACE03', 'SV-RACE04', 'SV-DIFF01', 'SV-TYPED01', 'SV-TYPED02', 'SV-ELIM'],
  E: ['PK-E01', 'SV-E01', 'SV-DIFF02']
};

export async function invites(rec) {
  let r;
  r = await createInvite('A', eid('PK-D01'), null, 0);
  rec.check('I01', 'invite expiry of 0 h is rejected', failedWith(r, 'invalid_invite_expiry'), {summary: summarize(r)});
  r = await createInvite('A', eid('PK-D01'), null, 721);
  rec.check('I02', 'invite expiry of 721 h is rejected', failedWith(r, 'invalid_invite_expiry'), {summary: summarize(r)});
  for (const [cid, key, entry, desc] of [
    ['I03', 'C', eid('PK-D01'), 'Tenant B commissioner cannot create a Tenant A invite'],
    ['I04', 'A', eid('B-01'), 'Tenant A commissioner cannot create a Tenant B invite'],
    ['I05', 'D', eid('PK-D01'), 'participant cannot create an invite'],
    ['I06', 'F', eid('PK-D01'), 'outsider cannot create an invite'],
    ['I07', 'G', eid('PK-D01'), 'unverified user cannot create an invite'],
    ['I08', 'A', uuid(), 'nonexistent entry gets the same commissioner_required']
  ]) {
    r = await createInvite(key, entry);
    if (r.ok) rec.stop('P1', cid, `${desc}: an invite was created`, {summary: summarize(r)});
    rec.check(cid, desc, failedWith(r, 'commissioner_required'), {summary: summarize(r)});
  }
  r = await data('POST', '/rpc/pool_platform_create_entry_invite', {body: {p_entry_id: eid('PK-D01'), p_email: null, p_expires_hours: 24}});
  if (r.ok) rec.stop('P0', 'I09', 'anonymous created an invite', {summary: summarize(r)});
  rec.check('I09', 'anonymous (no JWT) cannot create an invite', !r.ok, {summary: summarize(r)});

  // Ownership is established only through the reviewed RPCs: a commissioner (A or co-commissioner B) issues an
  // unbound invite and the participant claims it.
  for (const [who, codes] of Object.entries(OWN)) {
    let i = 0;
    for (const code of codes) {
      if (state.owned[code]) continue;
      const creator = i++ % 2 ? 'B' : 'A';
      const c = await createInvite(creator, eid(code));
      if (!rec.check(`I-own-${code}`, `${creator} issues an unbound invite for ${code}`, c.ok && hex64(c.json?.invite_token), {summary: `${summarize(c)} token_len=${c.json?.invite_token?.length ?? '-'}`})) continue;
      const cl = await claim(who, c.json.invite_token);
      rec.check(`I-claim-${code}`, `${who} claims ${code}`, cl.ok && cl.json?.claimed === true && cl.json?.entry_id === eid(code), {summary: summarize(cl)});
      if (cl.ok) { state.owned[code] = who; save(); }
      if (code === 'PK-D01') {
        const again = await claim(who, c.json.invite_token);
        rec.check('I10', 'a claimed invite cannot be claimed again by the same user', failedWith(again, 'invite_unavailable'), {summary: summarize(again)});
      }
    }
  }

  // Unbound bearer invite: claimable once.
  let c = await createInvite('A', eid('PK-INV-UNB'));
  const unb = c.json?.invite_token;
  r = await claim('E', unb);
  rec.check('I11', 'unbound invite: first claimant (E) succeeds', r.ok && r.json?.claimed === true, {summary: summarize(r)});
  if (r.ok) { state.owned['PK-INV-UNB'] = 'E'; save(); }
  r = await claim('F', unb);
  if (r.ok) rec.stop('P1', 'I12', 'a used unbound invite was claimed a second time', {summary: summarize(r)});
  rec.check('I12', 'unbound invite: a second user (F) is rejected (used)', failedWith(r, 'invite_unavailable'), {summary: summarize(r)});
  r = await claim('E', unb);
  rec.check('I13', 'unbound invite: the same claimant again is rejected (used)', failedWith(r, 'invite_unavailable'), {summary: summarize(r)});

  // Email-bound to G, whose email is unverified. The address is given in another case with padding.
  const gEmail = state.users.G.email;
  c = await createInvite('A', eid('PK-G01'), `  ${gEmail.toUpperCase()} `);
  rec.check('I14', 'commissioner issues an invite bound to G (mixed case + whitespace input)', c.ok && hex64(c.json?.invite_token), {summary: summarize(c)});
  const gTok = c.json?.invite_token;
  secrets.invites['PK-G01'] = gTok; save();
  r = await claim('G', gTok);
  if (r.ok) rec.stop('P0', 'I15', 'unverified-email bound invite accepted', {summary: summarize(r)});
  rec.check('I15', 'matching but UNVERIFIED email → invite_email_unverified', failedWith(r, 'invite_email_unverified'), {summary: summarize(r)});
  r = await claim('F', gTok);
  rec.check('I16', 'wrong email (F) → invite_email_mismatch', failedWith(r, 'invite_email_mismatch'), {summary: summarize(r)});
  r = await claim('D', gTok);
  rec.check('I17', "participant D cannot claim another user's bound invite", failedWith(r, 'invite_email_mismatch'), {summary: summarize(r)});
  r = await claim('G', gTok);
  rec.check('I18', 'rejections leave the bound invite open (G retry → still invite_email_unverified)', failedWith(r, 'invite_email_unverified'), {summary: summarize(r)});

  // Targets the owner step turns into an expired and a revoked invite.
  c = await createInvite('A', eid('PK-INV-EXP'));
  secrets.invites['PK-INV-EXP'] = c.json?.invite_token;
  c = await createInvite('B', eid('PK-INV-REV'));
  secrets.invites['PK-INV-REV'] = c.json?.invite_token;
  save();
  rec.check('I21', 'expired/revoked invite targets issued (owner step adjusts them)', hex64(secrets.invites['PK-INV-EXP']) && hex64(secrets.invites['PK-INV-REV']), {});

  r = await claim('F', 'not-a-token');
  rec.check('I22', 'malformed invite token → invalid_invite_token', failedWith(r, 'invalid_invite_token'), {summary: summarize(r)});
  r = await claim('F', crypto.randomBytes(32).toString('hex'));
  rec.check('I23', 'unknown well-formed token → invite_unavailable', failedWith(r, 'invite_unavailable'), {summary: summarize(r)});
  r = await rpc(await jwtFor('F'), 'pool_platform_claim_entry_invite', {p_invite_token: null});
  rec.check('I24', 'null invite token → invalid_invite_token', failedWith(r, 'invalid_invite_token'), {summary: summarize(r)});
  r = await data('POST', '/rpc/pool_platform_claim_entry_invite', {body: {p_invite_token: crypto.randomBytes(32).toString('hex')}});
  rec.check('I25', 'anonymous (no JWT) cannot call claim', !r.ok, {summary: summarize(r)});

  // Simultaneous double claim of one unbound invite on two connections.
  for (const [rid, code, a, b] of [['IR1', 'PK-INV-RACE1', 'D', 'E'], ['IR2', 'PK-INV-RACE2', 'E', 'D'], ['IR3', 'PK-INV-RACE3', 'D', 'E']]) {
    if (state.owned[code]) continue;
    c = await createInvite('A', eid(code));
    const tok = c.json?.invite_token;
    const sides = [a, b].map(key => ({key, fn: (t, d) => rpc(t, 'pool_platform_claim_entry_invite', {p_invite_token: tok}, {dispatcher: d})}));
    const {results, overlapMs} = await race(sides);
    const wins = results.map((x, i) => x.ok && x.json?.claimed === true ? i : -1).filter(i => i >= 0);
    if (wins.length > 1) rec.stop('P0', rid, 'two concurrent claims of one invite both succeeded', {summary: results.map(summarize).join(' | ')});
    const loser = results.find(x => !x.ok);
    rec.check(rid, `simultaneous double-claim (${a} vs ${b}) of one unbound invite: exactly one succeeds`, wins.length === 1 && !!loser && failedWith(loser, 'invite_unavailable'),
      {summary: `winner=${wins.length === 1 ? sides[wins[0]].key : '-'} loser=${loser ? summarize(loser) : '-'} overlap_ms=${overlapMs} latencies=${results.map(x => x.ms).join('/')}`});
    if (wins.length === 1) { state.owned[code] = sides[wins[0]].key; save(); }
  }
  // Two different invites for one entry, claimed at once by two users.
  if (!state.owned['PK-INV-DUAL']) {
    const c1 = await createInvite('A', eid('PK-INV-DUAL')), c2 = await createInvite('B', eid('PK-INV-DUAL'));
    const sides = [['E', c1.json?.invite_token], ['D', c2.json?.invite_token]].map(([key, tok]) => ({key, fn: (t, d) => rpc(t, 'pool_platform_claim_entry_invite', {p_invite_token: tok}, {dispatcher: d})}));
    const {results, overlapMs} = await race(sides);
    const wins = results.map((x, i) => x.ok ? i : -1).filter(i => i >= 0);
    if (wins.length > 1) rec.stop('P0', 'IR4', 'two users both claimed one entry through two invites', {summary: results.map(summarize).join(' | ')});
    const loser = results.find(x => !x.ok);
    rec.check('IR4', 'two invites for one entry claimed simultaneously by E and D: exactly one owner, loser entry_already_claimed',
      wins.length === 1 && !!loser && failedWith(loser, 'entry_already_claimed'), {summary: `winner=${wins.length === 1 ? sides[wins[0]].key : '-'} loser=${loser ? summarize(loser) : '-'} overlap_ms=${overlapMs}`});
    if (wins.length === 1) { state.owned['PK-INV-DUAL'] = sides[wins[0]].key; save(); }
  }
}

// Email-bound invite for the operator mailbox H (claimed later by H after a real OTP sign-in).
export async function hinvite(rec) {
  let r, c;
  if (process.env.PP_H_EMAIL && !secrets.invites['PK-H01']) {
    c = await createInvite('A', eid('PK-H01'), process.env.PP_H_EMAIL);
    rec.check('I19', 'commissioner issues an invite bound to the operator mailbox (H)', c.ok && hex64(c.json?.invite_token), {summary: summarize(c)});
    secrets.invites['PK-H01'] = c.json?.invite_token; save();
    for (const key of ['E', 'G']) {
      r = await claim(key, secrets.invites['PK-H01']);
      if (r.ok) rec.stop('P0', `I20-${key}`, `${key} claimed an invite bound to H`, {summary: summarize(r)});
      rec.check(`I20-${key}`, `${key} cannot claim the invite bound to H`, failedWith(r, 'invite_email_mismatch'), {summary: summarize(r)});
    }
  } else rec.info('I19', 'operator mailbox (H) invite not issued in this pass', {summary: process.env.PP_H_EMAIL ? 'already issued' : 'PP_H_EMAIL not set'});

}

// Tenant B private data, so the isolation checks have something to leak.
export async function tenantb(rec) {
  let r = await submit('C', W(PB, 1), eid('B-01'), 'commissioner_import', card('aaaaa', 17));
  rec.check('TB1', 'Tenant B commissioner imports a submission for B-01', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await submit('C', W(PB, 1), eid('B-03'), 'commissioner_manual', card('hhhhh', 23));
  rec.check('TB2', 'Tenant B commissioner enters a manual submission for B-03', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await createInvite('C', eid('B-02'));
  rec.check('TB3', 'Tenant B commissioner issues an (unused) invite for B-02', r.ok, {summary: summarize(r)});
}

export async function sourcelock(rec) {
  const w7 = W(PK, 7);
  // 7: participant first.
  let r = await submit('D', w7, eid('PK-D01'), 'participant', card('aaaaa', 5));
  rec.check('SL1', 'participant-first: D submits PK-D01 wk7', r.ok && r.json?.code === 'created' && r.json?.source === 'participant' && r.json?.revision === 1, {summary: summarize(r)});
  for (const [cid, key, src] of [['SL2', 'A', 'commissioner_import'], ['SL3', 'B', 'commissioner_manual'], ['SL3b', 'A', 'commissioner_manual']]) {
    r = await submit(key, w7, eid('PK-D01'), src, card('hhhhh', 99));
    if (r.ok) rec.stop('P0', cid, `${src} overwrote a participant-owned row`, {summary: summarize(r)});
    rec.check(cid, `${key} ${src} on a participant row → source_conflict:participant`, failedWith(r, 'source_conflict:participant'), {summary: summarize(r)});
  }
  r = await rpc(await jwtFor('A'), 'pool_platform_submit_batch', {p_week_id: w7, p_source: 'commissioner_import', p_items: [{entry_id: eid('PK-D01'), payload: card('hhhhh', 99)}]});
  rec.check('SL4', 'batch import of a participant row reports source_conflict:participant', r.ok && r.json?.[0]?.ok === false && r.json?.[0]?.code === 'source_conflict:participant', {summary: `${summarize(r)} ${JSON.stringify(r.json)}`});
  let row = await subRow('D', w7, eid('PK-D01'));
  rec.check('SL5', 'participant row intact: source participant, revision 1, original payload', row?.source === 'participant' && row?.revision === 1 && same(row?.payload, card('aaaaa', 5)), {summary: JSON.stringify({source: row?.source, revision: row?.revision})});

  // 8: commissioner first.
  r = await submit('A', w7, eid('PK-D02'), 'commissioner_import', card('hhhhh', 7));
  rec.check('SL6', 'commissioner-first: A imports PK-D02 wk7', r.ok && r.json?.code === 'created' && r.json?.source === 'commissioner_import', {summary: summarize(r)});
  r = await submit('D', w7, eid('PK-D02'), 'participant', card('aaaaa', 1));
  if (r.ok) rec.stop('P0', 'SL7', 'participant overwrote a commissioner row', {summary: summarize(r)});
  rec.check('SL7', 'participant on a commissioner_import row → source_conflict:commissioner_import', failedWith(r, 'source_conflict:commissioner_import'), {summary: summarize(r)});
  r = await submit('A', w7, eid('PK-D02'), 'commissioner_manual', card('aaaaa', 1));
  rec.check('SL8', 'commissioner_manual on a commissioner_import row → source_conflict:commissioner_import', failedWith(r, 'source_conflict:commissioner_import'), {summary: summarize(r)});
  row = await subRow('A', w7, eid('PK-D02'));
  rec.check('SL9', 'commissioner row intact: source commissioner_import, revision 1, original payload', row?.source === 'commissioner_import' && row?.revision === 1 && same(row?.payload, card('hhhhh', 7)), {summary: JSON.stringify({source: row?.source, revision: row?.revision})});

  // 9: same-source edits before the deadline.
  r = await submit('D', w7, eid('PK-D01'), 'participant', card('hhaaa', 6));
  rec.check('SS1', 'participant → participant update: revision 2', r.ok && r.json?.code === 'updated' && r.json?.revision === 2, {summary: summarize(r)});
  r = await submit('D', w7, eid('PK-D01'), 'participant', card('hhhaa', 8));
  rec.check('SS2', 'participant → participant update: revision 3', r.ok && r.json?.code === 'updated' && r.json?.revision === 3, {summary: summarize(r)});
  r = await submit('A', w7, eid('PK-D02'), 'commissioner_import', card('ahhhh', 9));
  rec.check('SS3', 'commissioner_import → commissioner_import update (A): revision 2', r.ok && r.json?.code === 'updated' && r.json?.revision === 2, {summary: summarize(r)});
  r = await submit('B', w7, eid('PK-D02'), 'commissioner_import', card('aahhh', 12));
  rec.check('SS4', 'commissioner_import update by co-commissioner B: revision 3', r.ok && r.json?.code === 'updated' && r.json?.revision === 3, {summary: summarize(r)});
  r = await submit('A', w7, eid('PK-MAN'), 'commissioner_manual', card('ahaha', 14));
  rec.check('SS5', 'commissioner_manual creates PK-MAN wk7', r.ok && r.json?.code === 'created' && r.json?.source === 'commissioner_manual', {summary: summarize(r)});
  r = await submit('B', w7, eid('PK-MAN'), 'commissioner_manual', card('haha' + 'h', 15));
  rec.check('SS6', 'commissioner_manual → commissioner_manual update (B): revision 2', r.ok && r.json?.code === 'updated' && r.json?.revision === 2, {summary: summarize(r)});
  r = await submit('D', w7, eid('PK-MAN'), 'participant', card('aaaaa', 1));
  rec.check('SS7', 'participant on a commissioner_manual row → source_conflict:commissioner_manual', failedWith(r, 'source_conflict:commissioner_manual'), {summary: summarize(r)});
  r = await submit('A', w7, eid('PK-MAN'), 'commissioner_import', card('aaaaa', 1));
  rec.check('SS8', 'commissioner_import on a commissioner_manual row → source_conflict:commissioner_manual', failedWith(r, 'source_conflict:commissioner_manual'), {summary: summarize(r)});
  row = await subRow('A', w7, eid('PK-D02'));
  rec.check('SS9', 'PK-D02 row: submitted_by is the last same-source actor (B)', row?.submitted_by_auth_user_id === state.users.B.id && row?.revision === 3, {summary: JSON.stringify({revision: row?.revision, by_B: row?.submitted_by_auth_user_id === state.users.B.id})});
  for (const [cid, src] of [['SS10', 'admin'], ['SS11', null]]) {
    r = await submit('D', w7, eid('PK-D03'), src, card('aaaaa', 1));
    rec.check(cid, `unknown source ${JSON.stringify(src)} → invalid_source`, failedWith(r, 'invalid_source'), {summary: summarize(r)});
  }
  // Rows the owner step locks.
  r = await submit('D', w7, eid('PK-LOCK-P'), 'participant', card('aaaaa', 30));
  rec.check('LK0a', 'lock target: participant row PK-LOCK-P wk7 created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await submit('A', w7, eid('PK-LOCK-C'), 'commissioner_manual', card('hhhhh', 31));
  rec.check('LK0b', 'lock target: commissioner_manual row PK-LOCK-C wk7 created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
}

// 10: participant vs commissioner import racing for the same empty entry/week.
export async function srcrace(rec) {
  const pairs = [];
  for (const w of [8, 9, 10, 11]) for (const n of [1, 2, 3, 4, 5, 6]) pairs.push([`PK-RACE0${n}`, w]);
  const tally = {participant: 0, commissioner_import: 0};
  const log = (state.results.srcrace ||= []);
  let i = 0;
  for (const [code, w] of pairs) {
    if (log.some(x => x.code === code && x.week === w)) continue;
    if (i >= 12 && tally.participant >= 3 && tally.commissioner_import >= 3) break;
    const weekId = W(PK, w), entryId = eid(code);
    let sides = [
      {key: 'D', src: 'participant', fn: (t, d) => rpc(t, 'pool_platform_submit_entry', {p_week_id: weekId, p_entry_id: entryId, p_source: 'participant', p_payload: card('aaaaa', 11)}, {dispatcher: d})},
      {key: 'A', src: 'commissioner_import', fn: (t, d) => rpc(t, 'pool_platform_submit_entry', {p_week_id: weekId, p_entry_id: entryId, p_source: 'commissioner_import', p_payload: card('hhhhh', 22)}, {dispatcher: d})}
    ];
    if (i % 2) sides = sides.reverse();
    // After 12 one-sided iterations, give the side that never won a small head start (still two independent requests).
    const lagging = i >= 12 && (tally.participant === 0 || tally.commissioner_import === 0) ? (tally.participant === 0 ? 'participant' : 'commissioner_import') : null;
    if (lagging && sides[0].src !== lagging) sides = sides.reverse();
    const {results, overlapMs} = await race(sides, {headStartMs: lagging ? 15 : 0});
    const okIdx = results.map((x, j) => x.ok ? j : -1).filter(j => j >= 0);
    if (okIdx.length > 1) rec.stop('P0', `RS-${code}-${w}`, 'both sources claimed one entry/week', {summary: results.map(summarize).join(' | ')});
    const win = okIdx.length === 1 ? sides[okIdx[0]] : null;
    const loserRes = okIdx.length === 1 ? results[1 - okIdx[0]] : null;
    const pass = !!win && results[okIdx[0]].json?.code === 'created' && failedWith(loserRes, `source_conflict:${win.src}`);
    rec.check(`RS-${code}-w${w}`, `simultaneous first submission (participant vs commissioner_import) ${code} wk${w}: exactly one source wins`, pass,
      {summary: `winner=${win?.src ?? '-'} loser=${loserRes ? summarize(loserRes) : results.map(summarize).join(' | ')} overlap_ms=${overlapMs} first_fired=${sides[0].src}${lagging ? ' (head start)' : ''}`});
    if (win) tally[win.src]++;
    log.push({code, week: w, winner: win?.src ?? null, loser: loserRes?.message ?? null, overlapMs, firstFired: sides[0].src, headStart: !!lagging});
    save();
    i++;
  }
  const all = log.reduce((t, x) => (x.winner && (t[x.winner] = (t[x.winner] || 0) + 1), t), {});
  rec.check('RS-summary', 'race summary: every iteration had exactly one winner', log.every(x => x.winner && x.loser === `source_conflict:${x.winner}`), {summary: JSON.stringify(all)});
  if (!all.participant || !all.commissioner_import) rec.info('RS-coverage', 'only one side won every iteration (timing); both-winner coverage not achieved', {summary: JSON.stringify(all)});
  else rec.check('RS-coverage', 'both possible winners observed', true, {summary: JSON.stringify(all)});
}

// 12: Pick'em payload matrix through the live RPC. PK-PAY belongs to D; week 8 has no row until the valid card.
export async function payload(rec) {
  const w8 = W(PK, 8), entry = eid('PK-PAY');
  const five = card('ahaha', 10).picks;
  const invalid = [
    ['PL01', 'missing configured game (g5 absent)', {picks: {g1: 'away', g2: 'home', g3: 'away', g4: 'home'}, tiebreak: 10}],
    ['PL02', 'unknown game in place of a configured one (g9 for g5)', {picks: {g1: 'away', g2: 'home', g3: 'away', g4: 'home', g9: 'away'}, tiebreak: 10}],
    ['PL03', 'extra game (g1-g5 plus g6)', {picks: {...five, g6: 'away'}, tiebreak: 10}],
    ['PL04', 'invalid side "draw"', {picks: {...five, g1: 'draw'}, tiebreak: 10}],
    ['PL05', 'invalid side "AWAY" (case)', {picks: {...five, g1: 'AWAY'}, tiebreak: 10}],
    ['PL06', 'invalid side "" (blank)', {picks: {...five, g1: ''}, tiebreak: 10}],
    ['PL07', 'invalid side JSON null', {picks: {...five, g1: null}, tiebreak: 10}],
    ['PL08', 'invalid side number 1', {picks: {...five, g1: 1}, tiebreak: 10}],
    ['PL09', 'invalid side boolean true', {picks: {...five, g1: true}, tiebreak: 10}],
    ['PL10', 'side as nested object {"side":"away"}', {picks: {...five, g1: {side: 'away'}}, tiebreak: 10}],
    ['PL11', 'required tiebreak missing', {picks: five}],
    ['PL12', 'blank tiebreak "" (behaves as missing, never 0)', {picks: five, tiebreak: ''}],
    ['PL13', 'whitespace tiebreak "   "', {picks: five, tiebreak: '   '}],
    ['PL14', 'tiebreak JSON null', {picks: five, tiebreak: null}],
    ['PL15', 'tiebreak 201 (out of range)', {picks: five, tiebreak: 201}],
    ['PL16', 'tiebreak -1', {picks: five, tiebreak: -1}],
    ['PL17', 'tiebreak 1.5', {picks: five, tiebreak: 1.5}],
    ['PL18', 'tiebreak "abc"', {picks: five, tiebreak: 'abc'}],
    ['PL19', 'tiebreak boolean true', {picks: five, tiebreak: true}],
    ['PL20', 'non-object payload: array', []],
    ['PL21', 'non-object payload: string', 'picks'],
    ['PL22', 'non-object payload: number', 5],
    ['PL23', 'non-object payload: boolean', true],
    ['PL24', 'payload SQL NULL', null],
    ['PL25', 'malformed nested: picks is an array', {picks: ['away', 'home', 'away', 'home', 'away'], tiebreak: 10}],
    ['PL26', 'malformed nested: picks is a string', {picks: 'away', tiebreak: 10}],
    ['PL27', 'malformed nested: picks is null', {picks: null, tiebreak: 10}],
    ['PL28', 'picks missing entirely', {tiebreak: 10}],
    ['PL29', 'extra top-level key', {picks: five, tiebreak: 10, note: 'x'}],
    ['PL30', 'Survivor-shaped payload in a Pick\'em week', {team: 'KC'}],
    ['PL31', 'oversize payload (> 20000 bytes)', {picks: five, tiebreak: 10, pad: 'x'.repeat(21000)}]
  ];
  for (const [cid, desc, body] of invalid) {
    const r = await submit('D', w8, entry, 'participant', body);
    if (r.ok) rec.stop('P1', cid, `${desc} was accepted`, {summary: summarize(r)});
    rec.check(cid, `Pick'em ${desc} → invalid_payload`, failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  }
  let row = await subRow('D', w8, entry);
  rec.check('PL32', 'no row written by any invalid attempt', row === null, {summary: JSON.stringify(row && {source: row.source, revision: row.revision})});
  let r = await submit('D', w8, entry, 'participant', card('ahaha', 0));
  rec.check('PL33', 'valid complete card with numeric tiebreak 0 → created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  row = await subRow('D', w8, entry);
  rec.check('PL34', 'stored tiebreak stays numeric 0 (not blank/null)', row?.payload?.tiebreak === 0 && typeof row?.payload?.tiebreak === 'number', {summary: `tiebreak=${JSON.stringify(row?.payload?.tiebreak)}`});
  for (const [cid, desc, body] of [['PL35', 'missing game', {picks: {g1: 'away'}, tiebreak: 3}], ['PL36', 'blank tiebreak', {picks: five, tiebreak: ''}]]) {
    r = await submit('D', w8, entry, 'participant', body);
    rec.check(cid, `invalid update (${desc}) of an existing row → invalid_payload`, failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  }
  row = await subRow('D', w8, entry);
  rec.check('PL37', 'existing row unchanged by invalid updates (revision 1, tiebreak 0)', row?.revision === 1 && row?.payload?.tiebreak === 0, {summary: `revision=${row?.revision}`});
  // Optional-tiebreak week 6.
  const w6 = W(PK, 6);
  r = await submit('D', w6, entry, 'participant', {picks: five});
  rec.check('PL38', 'week without required tiebreak: card with no tiebreak → created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await submit('D', w6, entry, 'participant', {picks: five, tiebreak: ''});
  rec.check('PL39', 'optional tiebreak given as "" is still rejected (never coerced to 0)', failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  r = await submit('D', w6, entry, 'participant', {picks: five, tiebreak: 0});
  rec.check('PL40', 'optional tiebreak numeric 0 accepted as an update', r.ok && r.json?.code === 'updated', {summary: summarize(r)});
  // String digits.
  r = await submit('D', W(PK, 9), entry, 'participant', {picks: five, tiebreak: '0'});
  rec.info('PL41', 'tiebreak given as the string "0" (required week 9)', {summary: `${summarize(r)} ${r.ok ? r.json?.code : ''}`});
  // The commissioner channel uses the same validator.
  r = await submit('A', W(PK, 10), entry, 'commissioner_import', {picks: {g1: 'away'}, tiebreak: 1});
  rec.check('PL42', 'commissioner_import with an incomplete card → invalid_payload', failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  r = await rpc(await jwtFor('A'), 'pool_platform_submit_batch', {p_week_id: W(PK, 10), p_source: 'commissioner_import', p_items: [{entry_id: entry, payload: {picks: five}}, {entry_id: entry, payload: []}]});
  rec.check('PL43', 'batch import rows with a missing tiebreak / non-object payload → invalid_payload each', r.ok && r.json?.every(x => x.ok === false && x.code === 'invalid_payload'), {summary: `${summarize(r)} ${JSON.stringify(r.json)}`});
  row = await subRow('A', W(PK, 10), entry);
  rec.check('PL44', 'no week-10 row written by the invalid commissioner attempts', row === null, {});
}

// 13: Survivor matrix.
export async function survivor(rec) {
  const sub = (key, w, code, team, src = 'participant', opts) => submit(key, W(SV, w), eid(code), src, {team}, opts);
  let r = await sub('D', 4, 'SV-D01', 'KC');
  rec.check('SV01', 'valid configured team (SV-D01 wk4 KC) → created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  for (const [cid, desc, team] of [['SV02', 'unknown team XYZ', 'XYZ'], ['SV03', 'display label "New York" instead of a key', 'New York'], ['SV04', 'lower-case key "kc"', 'kc'], ['SV05', 'blank team ""', '']]) {
    r = await sub('D', 5, 'SV-D01', team);
    rec.check(cid, `${desc} → invalid_payload`, failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  }
  for (const [cid, desc, team] of [['SV06', 'number 123', 123], ['SV07', 'boolean true', true], ['SV08', 'array ["KC"]', ['KC']], ['SV09', 'object {"key":"KC"}', {key: 'KC'}], ['SV10', 'JSON null', null]]) {
    r = await sub('D', 5, 'SV-D01', team);
    rec.check(cid, `non-string team ${desc} → invalid_payload`, failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  }
  r = await submit('D', W(SV, 5), eid('SV-D01'), 'participant', {team: 'BUF', note: 'x'});
  rec.check('SV11', 'extra key next to team → invalid_payload', failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  // Typed keys (week 2 configures keys "123" and "true"): only the JSON-string form is a pick.
  r = await sub('D', 2, 'SV-TYPED01', 123);
  rec.check('SV12', 'numeric 123 where "123" is a configured key → invalid_payload', failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  r = await sub('D', 2, 'SV-TYPED01', '123');
  rec.check('SV13', 'string "123" → created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await sub('D', 2, 'SV-TYPED02', true);
  rec.check('SV14', 'boolean true where "true" is a configured key → invalid_payload', failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  r = await sub('D', 2, 'SV-TYPED02', 'true');
  rec.check('SV15', 'string "true" → created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await sub('D', 4, 'SV-TYPED01', 123);
  rec.check('SV16', 'a numeric repeat of a used string key in another week → invalid_payload (type check first)', failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  // Reuse.
  r = await sub('D', 6, 'SV-D01', 'KC');
  if (r.ok) rec.stop('P0', 'SV17', 'Survivor team reused by the same entry', {summary: summarize(r)});
  rec.check('SV17', 'same entry, same team, later week → team_already_used', failedWith(r, 'team_already_used'), {summary: summarize(r)});
  r = await sub('D', 5, 'SV-D01', 'BUF');
  rec.check('SV18', 'same entry, different team in another week → created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await sub('D', 5, 'SV-D02', 'SF');
  rec.check('SV19', 'out-of-order: SV-D02 week 5 SF first → created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await sub('D', 2, 'SV-D02', 'SF');
  if (r.ok) rec.stop('P0', 'SV20', 'out-of-order Survivor reuse accepted', {summary: summarize(r)});
  rec.check('SV20', 'out-of-order: then week 2 SF → team_already_used', failedWith(r, 'team_already_used'), {summary: summarize(r)});
  r = await sub('D', 5, 'SV-D02', 'SF');
  rec.check('SV21', 'same row may keep its team (week 5 SF again → updated)', r.ok && r.json?.code === 'updated' && r.json?.revision === 2, {summary: summarize(r)});
  r = await sub('A', 7, 'SV-D02', 'SF', 'commissioner_manual');
  rec.check('SV22', 'commissioner channel cannot reuse the entry\'s team either → team_already_used', failedWith(r, 'team_already_used'), {summary: summarize(r)});
  // Duplicate display labels: NYG and NYJ are both "New York".
  r = await sub('D', 4, 'SV-D03', 'NYG');
  rec.check('SV23', 'SV-D03 wk4 NYG ("New York") → created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await sub('D', 5, 'SV-D03', 'NYJ');
  rec.check('SV24', 'SV-D03 wk5 NYJ (also "New York") → created; keys, not labels, decide', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await sub('D', 6, 'SV-D03', 'NYG');
  rec.check('SV25', 'SV-D03 wk6 NYG again → team_already_used', failedWith(r, 'team_already_used'), {summary: summarize(r)});
  r = await sub('D', 3, 'SV-D03', 'NYG');
  rec.check('SV26', 'week 3 schedules NYG twice: NYG is ambiguous there → invalid_payload', failedWith(r, 'invalid_payload'), {summary: summarize(r)});
  r = await sub('D', 3, 'SV-D03', 'MIA');
  rec.check('SV27', 'week 3 MIA (unambiguous) → created', r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await sub('E', 4, 'SV-E01', 'NYG');
  rec.check('SV28', "another entry (E's SV-E01) may use NYG in the same week → created (no cross-entry conflict)", r.ok && r.json?.code === 'created', {summary: summarize(r)});
  r = await sub('E', 5, 'SV-E01', 'KC');
  rec.check('SV29', "another entry may use KC, which SV-D01 used → created", r.ok && r.json?.code === 'created', {summary: summarize(r)});
  const rows = await data('GET', `/pool_platform_submissions?select=entry_id,week_id,payload&entry_id=eq.${eid('SV-D03')}`, {token: await jwtFor('D')});
  const teams = (rows.json || []).map(x => x.payload?.team).sort();
  rec.check('SV30', 'stored SV-D03 picks are the stable keys MIA, NYG, NYJ', JSON.stringify(teams) === JSON.stringify(['MIA', 'NYG', 'NYJ']), {summary: JSON.stringify(teams)});
  r = await sub('D', 1, 'SV-D01', 'SEA');
  rec.check('SV31', 'Survivor week past its deadline → deadline_passed', failedWith(r, 'deadline_passed'), {summary: summarize(r)});
  r = await sub('D', 4, 'SV-ELIM', 'SEA');
  rec.check('SV32', 'eliminated Survivor entry → entry_not_active', failedWith(r, 'entry_not_active'), {summary: summarize(r)});

  // Concurrent picks of one team for two weeks of the SAME entry.
  const rounds = [['SV-RACE01', 6, 7, 'DAL', 'D', 'D'], ['SV-RACE02', 8, 9, 'BUF', 'D', 'A'], ['SV-RACE03', 10, 11, 'WAS', 'D', 'D'], ['SV-RACE04', 4, 12, 'SEA', 'D', 'D'],
    ['SV-RACE01', 8, 9, 'PHI', 'D', 'D'], ['SV-RACE02', 10, 11, 'DEN', 'D', 'A'], ['SV-RACE03', 4, 5, 'SF', 'D', 'D'], ['SV-RACE04', 5, 6, 'NYJ', 'D', 'D']];
  let k = 0;
  for (const [code, wa, wb, team, ka, kb] of rounds) {
    const mk = (key, w) => ({key, w, fn: (t, d) => rpc(t, 'pool_platform_submit_entry', {p_week_id: W(SV, w), p_entry_id: eid(code), p_source: key === 'A' ? 'commissioner_manual' : 'participant', p_payload: {team}}, {dispatcher: d})});
    let sides = [mk(ka, wa), mk(kb, wb)];
    if (k++ % 2) sides = sides.reverse();
    const {results, overlapMs} = await race(sides);
    const oks = results.filter(x => x.ok);
    if (oks.length > 1) rec.stop('P0', `SVR-${code}-${team}`, 'two concurrent picks of one team for one entry both committed', {summary: results.map(summarize).join(' | ')});
    const loser = results.find(x => !x.ok);
    rec.check(`SVR-${code}-${team}`, `concurrent ${team} picks for ${code} weeks ${wa}/${wb} (${ka}/${kb}): exactly one succeeds`, oks.length === 1 && failedWith(loser, 'team_already_used'),
      {summary: `winner_week=${oks.length === 1 ? sides[results.indexOf(oks[0])].w : '-'} loser=${loser ? summarize(loser) : '-'} overlap_ms=${overlapMs}`});
  }
  // Different entries may take the same team at the same time.
  for (const [w, team] of [[6, 'PHI'], [7, 'KC']]) {
    const sides = [['D', 'SV-DIFF01'], ['E', 'SV-DIFF02']].map(([key, code]) => ({key, fn: (t, d) => rpc(t, 'pool_platform_submit_entry', {p_week_id: W(SV, w), p_entry_id: eid(code), p_source: 'participant', p_payload: {team}}, {dispatcher: d})}));
    const {results, overlapMs} = await race(sides);
    rec.check(`SVD-${team}`, `two different entries pick ${team} in week ${w} concurrently: both succeed`, results.every(x => x.ok && x.json?.code === 'created'), {summary: `${results.map(summarize).join(' | ')} overlap_ms=${overlapMs}`});
  }
  // Same entry, different teams, concurrently.
  const sides = [[8, 'SEA'], [9, 'DEN']].map(([w, team]) => ({key: 'D', fn: (t, d) => rpc(t, 'pool_platform_submit_entry', {p_week_id: W(SV, w), p_entry_id: eid('SV-DIFF01'), p_source: 'participant', p_payload: {team}}, {dispatcher: d})}));
  const {results, overlapMs} = await race(sides);
  rec.check('SVC', 'one entry picks different teams in two weeks concurrently: both succeed', results.every(x => x.ok && x.json?.code === 'created'), {summary: `${results.map(summarize).join(' | ')} overlap_ms=${overlapMs}`});
}
