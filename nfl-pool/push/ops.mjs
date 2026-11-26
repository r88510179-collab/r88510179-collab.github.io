#!/usr/bin/env node
// Pool Alerts owner tool. No database access and no dependencies: it talks to the deployed sender with the owner token.
//
//   node nfl-pool/push/ops.mjs keys                 generate a VAPID key pair, the owner and status tokens and a sender
//                                                   database password, and print where each one goes (run once, on a
//                                                   trusted computer; nothing is stored or sent anywhere)
//   node nfl-pool/push/ops.mjs health               is the sender up? (public, no token, no database)
//   node nfl-pool/push/ops.mjs status               full diagnostics: switches, devices, pending/failed, recent runs
//   node nfl-pool/push/ops.mjs notify               run a cycle now (deliver anything waiting)
//   node nfl-pool/push/ops.mjs pause "reason"       stop sending (publications are still recorded)
//   node nfl-pool/push/ops.mjs resume               start sending again
//   node nfl-pool/push/ops.mjs retry-failed         put failed deliveries (still current, within 24 h) back in the queue
//   node nfl-pool/push/ops.mjs test <device-id>     send a test alert to one enrolled device
//   node nfl-pool/push/ops.mjs enrollment open|closed|invite   (invite reads the code from POOL_ALERTS_INVITE_CODE)
//
// Environment: POOL_ALERTS_URL (default: production), POOL_ALERTS_OWNER_TOKEN (required except for keys and health).
import {createECDH, createHash, randomBytes} from 'node:crypto';

export const PRODUCTION_URL = 'https://br-late-hat-b55ygmj4-poolalerts.compute.c-7.us-east-2.aws.neon.tech';
const CLASS = /^[a-z0-9-]{1,60}$/;

export function generateKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const token = () => randomBytes(32).toString('base64url');
  const owner = token(), status = token();
  return {
    vapidPublicKey: ecdh.getPublicKey().toString('base64url'),
    // A private scalar can serialize shorter than 32 bytes: left-pad the BYTES with zeros (never the base64 text).
    vapidPrivateKey: Buffer.concat([Buffer.alloc(32), ecdh.getPrivateKey()]).subarray(-32).toString('base64url'),
    ownerToken: owner, ownerTokenSha256: createHash('sha256').update(owner).digest('hex'),
    statusToken: status, statusTokenSha256: createHash('sha256').update(status).digest('hex'),
    senderPassword: randomBytes(30).toString('base64url')
  };
}

export function describe(s) {
  const out = [];
  const subs = s.subscriptions || {}, d = s.deliveries30d || {};
  out.push(`Environment: ${s.environment ?? 'not set'} · version ${s.version ?? '?'}`);
  out.push(`Sending: ${s.sendingConfigured ? 'deployment ON' : 'deployment OFF'}, database ${s.settings?.sending_enabled ? 'ON' : 'OFF'}${s.settings?.note ? ` (${s.settings.note})` : ''}`);
  out.push(`Enrollment: ${s.settings?.enrollment_mode ?? '?'} · cap ${s.settings?.max_active_subscriptions ?? '?'} active, ${s.settings?.max_new_subscriptions_per_hour ?? '?'} new/hour · age limit ${s.settings?.max_notification_age_minutes ?? '?'} min`);
  out.push(`Devices: ${subs.active || 0} active, ${subs.expired || 0} expired, ${subs.disabled || 0} disabled`);
  out.push(`Deliveries (30 days): ${Object.entries(d).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  if (s.oldestOutstandingAt) out.push(`Oldest waiting delivery since: ${s.oldestOutstandingAt}`);
  if (s.cursor) out.push(`Planned through event #${s.cursor.last_event_id} (baseline ${s.cursor.initialized_at}); newest captured event #${s.events?.latestId ?? 'none'}`);
  for (const f of s.failures7d || []) if (CLASS.test(String(f.error))) out.push(`Problem (7 days): ${f.error} ×${f.n}`);
  for (const g of s.captureGaps30d || []) out.push(`CAPTURE GAP: Week ${g.detail?.week} revision ${g.detail?.revision} was found by reconciliation at ${g.at} (check the trigger)`);
  out.push('Recent alerts:');
  for (const n of s.notifications || []) out.push(`  #${n.id} ${n.season} Week ${n.week} r${n.revision} ${n.base_kind} → ${n.status}${n.status_reason ? ` (${n.status_reason})` : ''}: ${n.sent} sent, ${n.pending} waiting, ${n.failed} failed`);
  out.push('Recent runs:');
  for (const r of s.runs || []) out.push(`  #${r.id} ${r.started_at} ${r.trigger} → ${r.outcome ?? 'running'}${r.error_class ? ` (${r.error_class})` : ''}`);
  out.push('Recent owner actions:');
  for (const a of s.recentActions || []) out.push(`  ${a.at} ${a.actor} ${a.action}`);
  return out.join('\n');
}

async function call(base, path, {token, method = 'POST', body} = {}) {
  const response = await fetch(base + path, {method, redirect: 'error', signal: AbortSignal.timeout(150000),
    headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...(method === 'POST' ? {'Content-Type': 'application/json'} : {})},
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined});
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}${data?.error ? ` (${data.error})` : ''}`), {status: response.status});
  return data;
}

export async function main(argv = process.argv.slice(2), env = process.env, print = console.log) {
  const [command, value] = argv;
  const base = (env.POOL_ALERTS_URL || PRODUCTION_URL).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(base) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('POOL_ALERTS_URL must be the sender\'s https origin');
  if (command === 'keys') {
    const k = generateKeys();
    print(['Store these in the Neon Function environment (config-only deploy; never in Git):',
      `  VAPID_PUBLIC_KEY=${k.vapidPublicKey}`, `  VAPID_PRIVATE_KEY=${k.vapidPrivateKey}`,
      `  OWNER_TOKEN_SHA256=${k.ownerTokenSha256}`, `  STATUS_TOKEN_SHA256=${k.statusTokenSha256}`,
      'Store the owner token as the GitHub Actions secret POOL_ALERTS_OWNER_TOKEN and in your password manager:',
      `  ${k.ownerToken}`,
      'Store the status token as the smokke-dashboard Vercel variable POOL_ALERTS_STATUS_TOKEN (server only):',
      `  ${k.statusToken}`,
      'Use this as the pool_alerts_sender database password (ALTER ROLE ... PASSWORD) and in POOL_ALERTS_DATABASE_URL:',
      `  ${k.senderPassword}`,
      'Changing VAPID keys later makes every device re-enroll; keep them unless they leaked.'].join('\n'));
    return 0;
  }
  if (command === 'health') { print(JSON.stringify(await call(base, '/v1/health', {method: 'GET'}), null, 2)); return 0; }
  const token = env.POOL_ALERTS_OWNER_TOKEN;
  if (!token || token.length < 32) throw new Error('POOL_ALERTS_OWNER_TOKEN is required');
  switch (command) {
    case 'status': print(describe(await call(base, '/v1/owner/status', {token, method: 'GET'}))); return 0;
    case 'notify': { const r = await call(base, '/v1/dispatch', {token}); print(r.paused ? 'Sending is paused: nothing was sent.' : `Cycle ${r.outcome}: ${r.sent} sent, ${r.retrying} retrying, ${r.failed} failed.`); return 0; }
    case 'pause': await call(base, '/v1/owner/pause', {token, body: {note: value || 'paused by owner'}}); print('Sending paused. Publications are still recorded.'); return 0;
    case 'resume': await call(base, '/v1/owner/resume', {token, body: {note: value || 'resumed by owner'}}); print('Sending resumed.'); return 0;
    case 'retry-failed': { const r = await call(base, '/v1/owner/retry-failed', {token}); print(`Reset ${r.reset.deliveries} failed deliveries (${r.reset.notifications} alerts); cycle: ${r.outcome}.`); return 0; }
    case 'test': {
      if (!/^[0-9a-f-]{36}$/.test(value || '')) throw new Error('Usage: test <device-id> (from the Admin panel or status)');
      const r = await call(base, '/v1/owner/test', {token, body: {subscriptionId: value}});
      print(r.delivered ? 'Test alert accepted by the push service.' : `The push service answered ${r.status}.`); return 0;
    }
    case 'enrollment': {
      if (!['open', 'closed', 'invite'].includes(value)) throw new Error('Usage: enrollment open|closed|invite');
      const body = {mode: value, ...(value === 'invite' ? {inviteCode: env.POOL_ALERTS_INVITE_CODE} : {})};
      if (value === 'invite' && !(body.inviteCode?.length >= 12)) throw new Error('Set POOL_ALERTS_INVITE_CODE (12+ characters) for invite mode');
      await call(base, '/v1/owner/enrollment', {token, body});
      print(`Enrollment is now ${value}.`); return 0;
    }
    default: throw new Error('Unknown command. Commands: keys, health, status, notify, pause, resume, retry-failed, test, enrollment');
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`Pool Alerts: ${error.message}`); process.exitCode = 1; });
}
