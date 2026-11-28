// Pool Alerts monitor (scheduled: .github/workflows/pool-alerts-monitor.yml). For the Personal senders, production and
// staging, it reads each sender's health and status, recovers what is safe to recover on its own, and keeps ONE GitHub
// issue (label pool-alerts-monitor) for problems that need the owner: opened when a problem appears, updated only when
// the set of problems changes, closed when everything is healthy again. No problem is reported twice. The Commercial
// senders have their own monitor in the (private) Commercial repository, so nothing about them is published here.
//
// Least privilege: the monitor holds POOL_ALERTS_MONITOR_KEY, never the control key or a Neon API key. The token it
// derives (purpose "monitor") opens exactly two things on a sender: the read-only status report and POST /v1/dispatch,
// the same cycle the scheduled trigger runs (it sends only verified, current alerts, never while group sending is
// paused, and never the same alert twice). That is the only recovery it performs, when publications are waiting or
// deliveries are overdue: it cannot pause, resume, test, enroll, deploy or touch a database, and the monitor key derives
// no owner or status token. Without the key only the public health endpoints are checked. The key is never printed.
import {deriveToken} from '../push/release-lib.mjs';

export const TARGETS = Object.freeze([
  {app: 'personal', environment: 'production', url: 'https://br-late-hat-b55ygmj4-poolalerts.compute.c-7.us-east-2.aws.neon.tech', cron: '17 * * * *'},
  {app: 'personal', environment: 'staging', url: 'https://br-rough-smoke-bccichyp-poolalerts.compute.c-16.us-east-1.aws.neon.tech', cron: '17 * * * *'}
].map(Object.freeze));
const LABEL = 'pool-alerts-monitor', TITLE = 'Pool Alerts needs attention';

export function scheduleGapMs(cron) {
  const minutes = String(cron).trim().split(/\s+/)[0].split(',').map(Number).sort((a, b) => a - b);
  if (!minutes.length || minutes.some(m => !Number.isInteger(m))) return 3600000;
  let gap = 60 - minutes.at(-1) + minutes[0];
  for (let i = 1; i < minutes.length; i++) gap = Math.max(gap, minutes[i] - minutes[i - 1]);
  return gap * 60000;
}
const age = (iso, now) => (iso && Number.isFinite(Date.parse(iso)) ? now - Date.parse(iso) : null);

// What one target's answers mean. severity: alert (needs the owner), warn (shown, no issue), info.
// recover: a dispatch may fix it (publications waiting, deliveries overdue, a missed scheduled run with work waiting).
// Staging is shown but never opens the issue: its problems are warnings (synthetic tests expire devices on purpose, and
// the owner looks at staging while testing it).
export function assess(target, answers, now = Date.now()) {
  const result = assessAnswers(target, answers, now);
  if (target.environment !== 'staging') return result;
  return {...result, problems: result.problems.map(p => (p.severity === 'alert' ? {...p, severity: 'warn'} : p))};
}
function assessAnswers(target, {health, status}, now) {
  const problems = [];
  const add = (code, severity, message, recover = false) => problems.push({code, severity, message, recover});
  if (!health || health.status === 404) return {deployed: false, problems: [{code: 'not-deployed', severity: 'info', message: 'not deployed yet', recover: false}]};
  if (health.status !== 200) { add('health-unavailable', 'alert', `health answered ${health.status || 'nothing'}`); return {deployed: true, problems}; }
  const h = health.data || {};
  if (h.environment !== target.environment) add('environment-changed', 'alert', `the sender reports ${h.environment || 'no environment'}, expected ${target.environment}`);
  if (!h.sendingConfigured) add('sending-switched-off', target.environment === 'production' ? 'warn' : 'info', 'the deployment switch POOL_ALERTS_SENDING is off');
  if (!status) { add('status-not-checked', 'info', 'no monitor key: only health was checked'); return {deployed: true, problems}; }
  if (status.status === 401) {
    add('monitor-token-refused', 'alert', h.monitorTokenConfigured === false ? 'the sender has no monitor token yet (stage it with POOL_ALERTS_MONITOR_KEY set)'
      : 'the sender refused the monitor token (deployed with another monitor key?)');
    return {deployed: true, problems};
  }
  if (status.status !== 200) { add('status-unavailable', 'alert', `status answered ${status.status || 'nothing'} (database or sender failure)`); return {deployed: true, problems}; }
  const s = status.data || {};
  const lastRun = s.lastRun || (Array.isArray(s.lastRuns) ? {at: s.lastRuns[0]?.startedAt, outcome: s.lastRuns[0]?.outcome, errorClass: null} : null);
  if (lastRun?.outcome === 'error') add('last-run-failed', 'alert', `the last sender run failed${lastRun.errorClass ? ` (${lastRun.errorClass})` : ''}`);
  const authFailures = (Array.isArray(s.failures7d) ? s.failures7d.map(f => f.error) : Object.keys(s.problems7d || {})).filter(e => /^auth-/.test(e));
  if (authFailures.length) add('push-key-refused', 'alert', `a push service refused the VAPID key (${authFailures.join(', ')}): see the runbook`);
  const gap = scheduleGapMs(target.cron), cronAge = age(s.lastCronRunAt, now);
  const waiting = Number(s.eventsWaiting) || 0, okAge = age(s.lastOkRunAt, now);
  if (cronAge === null) add('no-scheduled-run', 'warn', 'no scheduled run recorded yet');
  else if (cronAge > 2 * gap + 10 * 60000) add('scheduled-run-missed', 'alert', `the last scheduled run was ${Math.round(cronAge / 60000)} min ago (schedule ${target.cron} UTC)`, waiting > 0);
  if (waiting > 0 && (okAge === null || okAge > 30 * 60000)) add('publications-waiting', 'alert', `${waiting} publication(s) recorded but not processed`, true);
  const oldestAge = age(s.oldestOutstandingAt ?? s.oldestWaiting, now);
  if (oldestAge !== null && oldestAge > 2 * 3600000) add('deliveries-delayed', 'alert', `alerts waiting to send for ${Math.round(oldestAge / 60000)} min`, true);
  const active = Number(s.subscriptions?.active ?? s.devices?.active) || 0, expired = Number(s.expiredDevices7d) || 0;
  if (expired >= 3 && expired > active) add('many-subscriptions-expired', 'alert', `${expired} subscriptions expired in 7 days, ${active} active: check the VAPID keys`);
  else if (expired) add('subscriptions-expired', 'info', `${expired} subscription(s) expired in 7 days (normal when people turn alerts off)`);
  if (Number(s.captureGaps30d) > 0) add('capture-gaps', 'warn', `${s.captureGaps30d} publication(s) were caught by reconciliation instead of the capture trigger`);
  if (!s.sendingEnabled) add('group-sending-paused', 'info', target.environment === 'production' ? 'group sending is paused (expected until activation)' : 'group sending is paused');
  return {deployed: true, problems, figures: {waiting, active, expired, lastCronRunAt: s.lastCronRunAt ?? null, lastOkRunAt: s.lastOkRunAt ?? null, version: h.version ?? null}};
}

// The incident's identity: which targets have which alert-level problems. Details (counts, minutes) are left out, so a
// problem that merely persists keeps the same signature and is not reported again.
export function signature(results) {
  return results.flatMap(r => r.problems.filter(p => p.severity === 'alert').map(p => `${r.app}/${r.environment}:${p.code}`)).sort().join(' ');
}
export function planIssue(open, sig) {
  if (!sig) return open ? {action: 'close'} : {action: 'none'};
  if (!open) return {action: 'create'};
  const previous = /<!-- signature: (.*?) -->/.exec(open.body || '')?.[1] ?? '';
  return previous === sig ? {action: 'none'} : {action: 'update'};
}
export function issueBody(results, sig, now = Date.now()) {
  const lines = results.map(r => {
    const alerts = r.problems.filter(p => p.severity === 'alert');
    return `### ${r.app} ${r.environment}\n${alerts.length ? alerts.map(p => `- **${p.code}**: ${p.message}`).join('\n') : '- healthy (or nothing that needs you)'}`;
  });
  return `Pool Alerts needs attention. Opened and updated by the scheduled monitor (\`.github/workflows/pool-alerts-monitor.yml\`); it closes this issue by itself when everything is healthy again, and does not repeat an unchanged problem.\n\n${lines.join('\n\n')}\n\nWhat to do: Maintenance Center → Pool Alerts operations (status, run now, retry, pause), and nfl-pool/push/RUNBOOK.md.\n\nChecked ${new Date(now).toISOString()}.\n\n<!-- signature: ${sig} -->\n`;
}

async function getJson(fetcher, url, {token, method = 'GET', timeout = 20000} = {}) {
  try {
    const r = await fetcher(url, {method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: {Accept: 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(method === 'POST' ? {'Content-Type': 'application/json'} : {})},
      body: method === 'POST' ? '{}' : undefined});
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return {status: r.status, data};
  } catch { return {status: 0, data: null}; }
}

export async function checkAll({env = process.env, fetcher = fetch, now = () => Date.now(), targets = TARGETS} = {}) {
  // Only the monitor key: a control key or a Neon API key given to this process by mistake is never read.
  const key = env.POOL_ALERTS_MONITOR_KEY;
  const results = [];
  for (const target of targets) {
    const token = key ? deriveToken(key, {app: target.app, environment: target.environment, purpose: 'monitor'}) : null;
    const read = async () => {
      const health = await getJson(fetcher, `${target.url}/v1/health`);
      const status = health.status === 200 && token ? await getJson(fetcher, `${target.url}/v1/status`, {token}) : null;
      return assess(target, {health, status}, now());
    };
    let outcome = await read();
    const recovery = [];
    if (token && outcome.problems.some(p => p.recover)) {
      const dispatched = await getJson(fetcher, `${target.url}/v1/dispatch`, {token, method: 'POST', timeout: 60000});
      recovery.push(`dispatch answered ${dispatched.status}${dispatched.data?.outcome ? ` (${dispatched.data.outcome})` : ''}`);
      outcome = await read();
    }
    results.push({app: target.app, environment: target.environment, url: target.url, ...outcome, recovery});
  }
  return results;
}

// One issue, labelled pool-alerts-monitor: created, updated (when the problems change) or closed (when healthy).
export async function manageIssue({results, env = process.env, fetcher = fetch, now = () => Date.now()}) {
  const repo = env.GITHUB_REPOSITORY, token = env.GITHUB_TOKEN;
  const sig = signature(results);
  if (!repo || !token) return {action: 'skipped', signature: sig};
  const api = `https://api.github.com/repos/${repo}`;
  const gh = (path, init = {}) => fetcher(`${api}${path}`, {...init, headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? {'Content-Type': 'application/json'} : {})}});
  // Found by its label, or by its exact title (should the label have been dropped), so it is never filed twice.
  const list = await (await gh('/issues?state=open&per_page=50')).json();
  const open = Array.isArray(list) ? list.find(i => !i.pull_request && ((i.labels || []).some(l => (l.name ?? l) === LABEL) || i.title === TITLE)) : null;
  const plan = planIssue(open, sig);
  if (plan.action === 'create') await gh('/issues', {method: 'POST', body: JSON.stringify({title: TITLE, body: issueBody(results, sig, now()), labels: [LABEL]})});
  if (plan.action === 'update') {
    await gh(`/issues/${open.number}`, {method: 'PATCH', body: JSON.stringify({body: issueBody(results, sig, now())})});
    await gh(`/issues/${open.number}/comments`, {method: 'POST', body: JSON.stringify({body: `The problems changed: ${sig}`})});
  }
  if (plan.action === 'close') {
    await gh(`/issues/${open.number}/comments`, {method: 'POST', body: JSON.stringify({body: `Recovered: everything is healthy again (${new Date(now()).toISOString()}).`})});
    await gh(`/issues/${open.number}`, {method: 'PATCH', body: JSON.stringify({state: 'closed', state_reason: 'completed'})});
  }
  return {action: plan.action, signature: sig, issue: open?.number ?? null};
}

export function summary(results, issue) {
  const rows = results.map(r => {
    const alerts = r.problems.filter(p => p.severity === 'alert'), warns = r.problems.filter(p => p.severity === 'warn');
    const state = !r.deployed ? 'not deployed' : alerts.length ? 'NEEDS ATTENTION' : warns.length ? 'warning' : 'healthy';
    const notes = r.problems.filter(p => p.severity !== 'info' || !r.deployed).map(p => `${p.code}: ${p.message}`).join('; ');
    return `| ${r.app} | ${r.environment} | ${state} | ${(r.recovery || []).join('; ') || '—'} | ${notes.replace(/\|/g, '/') || '—'} |`;
  });
  return `## Pool Alerts monitor\n\n| App | Environment | State | Recovery | Notes |\n|---|---|---|---|---|\n${rows.join('\n')}\n\nIssue: ${issue.action}${issue.issue ? ` (#${issue.issue})` : ''}\n`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const results = await checkAll();
  const issue = await manageIssue({results}).catch(error => ({action: `failed: ${String(error.message).slice(0, 80)}`}));
  const text = summary(results, issue);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
