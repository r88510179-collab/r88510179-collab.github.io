// Targeted Home group-vs-field presentation tests. No Neon, NFL requests, production writes or new grading.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {groupFieldPulse,groupFieldPulseHtml} from './home-dashboard.js';

const NOW=Date.parse('2026-11-05T15:00:00Z');
const entry=(name,rank,{tieCount=1,noPicks=false}={})=>({
  name,noPicks,field:rank==null?null:{rank,tieCount}
});
const snapshot=(changes={})=>({
  ready:true,contest:'pickem',season:2026,week:9,revision:3,
  games:{total:13,final:6,live:2,void:0,remaining:7},
  fieldSize:87,
  entries:[entry('D.C.',3),entry('JC',8,{tieCount:2}),entry('DJS',8,{tieCount:2}),entry('Thaddeus',41)],
  feed:{fetchedAt:new Date(NOW-1000).toISOString(),failed:false,incomplete:false,warnings:0,review:false},
  tiebreak:{final:false,void:false},hold:false,rulingsStale:false,publishedStale:false,...changes
});

test('summarizes actual published full-field ranks and the top-quarter threshold',()=>{
  const p=groupFieldPulse(snapshot(),{now:NOW});
  assert.equal(p.state,'ready');
  assert.deepEqual([p.fieldSize,p.bestLabel,p.bestRank,p.bestName,p.bestPercent],[87,'#3',3,'D.C.',4]);
  assert.deepEqual([p.topQuarter,p.submittedCount,p.trackedCount],[3,4,4]);
  assert.equal(p.delayed,false);
  const html=groupFieldPulseHtml(snapshot(),{now:NOW});
  assert.match(html,/Best overall/);
  assert.match(html,/#3 <small>of 87/);
  assert.match(html,/3 <small>of 4 submitted/);
  assert.match(html,/In-progress scores do not count until final/);
});

test('does not report misleading ranks before a final game or with no field publication',()=>{
  assert.equal(groupFieldPulse(snapshot({games:{total:13,final:0,live:4,remaining:13}}),{now:NOW}).state,'pending');
  const missing=snapshot({fieldSize:null,entries:[entry('D.C.',null)]});
  assert.equal(groupFieldPulse(missing,{now:NOW}).state,'unavailable');
  assert.match(groupFieldPulseHtml(missing,{now:NOW}),/Full-pool rankings were not published/);
  assert.equal(groupFieldPulse({ready:false},{now:NOW}).state,'unavailable');
  assert.equal(groupFieldPulse(snapshot({hold:true}),{now:NOW}).state,'unavailable');
});

test('refuses partial and invalid field ranks; non-submitters never inflate group placement',()=>{
  const invalid=snapshot({entries:[entry('D.C.',3),entry('JC',null)]});
  assert.equal(groupFieldPulse(invalid,{now:NOW}).state,'unavailable');
  assert.equal(groupFieldPulse(snapshot({entries:[entry('D.C.',88)]}),{now:NOW}).state,'unavailable');
  const noPicks=snapshot({entries:[entry('D.C.',1,{noPicks:true}),entry('JC',4)]});
  const p=groupFieldPulse(noPicks,{now:NOW});
  assert.deepEqual([p.bestName,p.bestRank,p.topQuarter,p.submittedCount,p.trackedCount],['JC',4,1,1,2]);
  assert.equal(groupFieldPulse(snapshot({entries:[entry('D.C.',1,{noPicks:true})]}),{now:NOW}).state,'pending');
});

test('shows tied rank correctly and never leaks hostile participant markup',()=>{
  const tied=snapshot({entries:[entry('<script>alert(1)</script>',1,{tieCount:3})]});
  const p=groupFieldPulse(tied,{now:NOW});
  assert.equal(p.bestLabel,'T-1');
  const html=groupFieldPulseHtml(tied,{now:NOW});
  assert.match(html,/T-1/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>/);
});

test('marks previous verified ranks as delayed when publication or feed is stale',()=>{
  const failed=snapshot({feed:{...snapshot().feed,failed:true}});
  const p=groupFieldPulse(failed,{now:NOW});
  assert.equal(p.state,'ready');
  assert.equal(p.delayed,true);
  assert.match(groupFieldPulseHtml(failed,{now:NOW}),/Last verified standings/);
  const stale=snapshot({publishedStale:true});
  assert.equal(groupFieldPulse(stale,{now:NOW}).delayed,true);
  assert.match(groupFieldPulseHtml(stale,{now:NOW}),/PUBLISHED DATA STALE/);
});

test('Home wiring uses only its existing sanitized share snapshot; no new fetch, timers or data exposure',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const module=readFileSync(new URL('./home-dashboard.js',import.meta.url),'utf8');
  assert.equal((html.match(/id="homeFieldPulse"/g)||[]).length,1);
  assert.match(module,/fieldPulse\.innerHTML=groupFieldPulseHtml\(snapshots\.pickem,\{now\}\)/);
  const pulse=module.slice(module.indexOf('export function groupFieldPulse('),module.indexOf('export function spotlightText('));
  assert(!/\b(fetch|XMLHttpRequest|setInterval|setTimeout|localStorage|fieldEntries|pickNumbers)\b/.test(pulse));
});
