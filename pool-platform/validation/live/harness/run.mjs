// Usage: NODE_USE_ENV_PROXY=1 node harness/run.mjs <phase> [<phase> ...]
// Phases run in the order given; a STOP condition aborts the run (exit 3) after recording it.
import {recorder, StopCondition, save} from './lib.mjs';
import * as p1 from './phases1.mjs';
import * as p2 from './phases2.mjs';
import * as p3 from './phases3.mjs';

const PHASES = {
  probe: p1.probe, signup: p1.signup, sdk: p1.sdk, context: p1.context, auth: p1.auth,
  invites: p2.invites, hinvite: p2.hinvite, tenantb: p2.tenantb, sourcelock: p2.sourcelock, srcrace: p2.srcrace, payload: p2.payload, survivor: p2.survivor,
  status: p3.status, batch: p3.batch, authorder: p3.authorder, directwrite: p3.directwrite, surface: p3.surface, isolation: p3.isolation,
  expiredinv: p3.expiredinv, locked: p3.locked, deadline: p3.deadline, jwtexpiry: p3.jwtexpiry, signout: p3.signout,
  human_send: p3.human_send, human_verify: p3.human_verify
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter(p => !PHASES[p]);
if (!wanted.length || unknown.length) {
  console.error(`phases: ${Object.keys(PHASES).join(' ')}${unknown.length ? `\nunknown: ${unknown.join(' ')}` : ''}`);
  process.exit(2);
}
const totals = {pass: 0, fail: 0, info: 0};
let code = 0;
for (const name of wanted) {
  const rec = recorder(name);
  console.log(`\n=== ${name} ===`);
  try {
    await PHASES[name](rec);
  } catch (e) {
    if (e instanceof StopCondition) { console.log(`\n*** STOP CONDITION: ${e.message}`); code = 3; }
    else { console.log(`\n*** harness error in ${name}: ${String(e?.stack || e).replace(/eyJ[A-Za-z0-9_.-]+/g, '<jwt-redacted>')}`); code = 1; }
  }
  for (const k of Object.keys(totals)) totals[k] += rec.out[k];
  console.log(`--- ${name}: pass=${rec.out.pass} fail=${rec.out.fail} info=${rec.out.info}`);
  save();
  if (code) break;
}
console.log(`\nTOTAL pass=${totals.pass} fail=${totals.fail} info=${totals.info}${code === 3 ? ' (STOPPED)' : code ? ' (ERROR)' : ''}`);
process.exit(code);
