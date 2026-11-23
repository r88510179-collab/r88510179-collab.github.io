import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {replayVerifiedSeason} from '../server/season-replay-core.mjs';

const pool='10000000-0000-4000-8000-000000000001';
const other='20000000-0000-4000-8000-000000000002';
const entries=[{entry_id:'alpha'},{entry_id:'beta'}];
const games1=[
  {id:'W1_AAA_BBB',away:{key:'AAA'},home:{key:'BBB'}},
  {id:'W1_CCC_DDD',away:{key:'CCC'},home:{key:'DDD'}}
];
const games2=[
  {id:'W2_AAA_CCC',away:{key:'AAA'},home:{key:'CCC'}},
  {id:'W2_BBB_DDD',away:{key:'BBB'},home:{key:'DDD'}}
];
const results1={
  W1_AAA_BBB:{status:'final',away_score:21,home_score:14},
  W1_CCC_DDD:{status:'final',away_score:7,home_score:7}
};
const results2={
  W2_AAA_CCC:{status:'final',away_score:27,home_score:10},
  W2_BBB_DDD:{status:'final',away_score:17,home_score:24}
};
const revision=(results,index=1,other={})=>({
  revision:index,results,source_sha256:index===1?'a'.repeat(64):'b'.repeat(64),
  verified_by:'synthetic_commissioner',
  verified_at:index===1?'2026-11-10T01:00:00.000Z':'2026-11-11T01:00:00.000Z',
  ...(index>1?{reason:'Independently verified final-score correction'}:{}),...other
});
const week=(num,games,results,submissions=[])=>({
  pool_id:pool,season:2026,week:num,games,submissions,
  revisions:[revision(results)]
});
const submission=(entry_id,payload)=>({entry_id,source:'participant',status:'locked',payload});
const picks=(a,b,c,d)=>[
  submission('alpha',{picks:{W1_AAA_BBB:a,W1_CCC_DDD:b}}),
  submission('beta',{picks:{W1_AAA_BBB:c,W1_CCC_DDD:d}})
];
const w2picks=[
  submission('alpha',{picks:{W2_AAA_CCC:'away',W2_BBB_DDD:'away'}}),
  submission('beta',{picks:{W2_AAA_CCC:'home',W2_BBB_DDD:'home'}})
];
const pickemWeeks=()=>[
  week(1,games1,results1,picks('away','away','home','home')),
  week(2,games2,results2,w2picks)
];
const pickem=(weeks=pickemWeeks(),rest={})=>replayVerifiedSeason({
  pool_id:pool,season:2026,pool_type:'pickem',entries,weeks,start_week:1,
  rules:{tiesBothLose:true,pointsPerCorrectPick:1},...rest
});
const survivorWeeks=()=>[
  week(1,games1,results1,[
    submission('alpha',{team:'AAA'}),
    submission('beta',{team:'CCC'})
  ]),
  week(2,games2,results2,[
    submission('alpha',{team:'DDD'}),
    submission('beta',{team:'DDD'})
  ])
];
const survivor=(weeks=survivorWeeks(),rest={})=>replayVerifiedSeason({
  pool_id:pool,season:2026,pool_type:'survivor',entries,weeks,start_week:1,
  rules:{missingSurvivorPick:'eliminate'},...rest
});

test('deterministic season Pickem ranks sum confirmed wins, counting both sides of a tie as losses',()=>{
  const r=pickem();
  assert.equal(r.ok,true,r.reason);
  assert.equal(r.unofficial,true);
  assert.deepEqual(r.rows.map(x=>[x.entry_id,x.correct,x.incorrect,x.ties_both_lose,x.rank]),[
    ['alpha',2,2,1,1],['beta',1,3,1,2]
  ]);
  assert.deepEqual(r.revisions.map(x=>[x.week,x.revision]),[[1,1],[2,1]]);
  assert.equal(r.fingerprint.length,64);
  assert.deepEqual(pickem(),r,'replay of identical validated inputs must be byte-stable');
});
test('a corrected first week recomputes season ranking with a different fingerprint',()=>{
  const weeks=pickemWeeks();
  const corrected={...results1,W1_AAA_BBB:{status:'final',away_score:14,home_score:21}};
  weeks[0].revisions.push(revision(corrected,2));
  const before=pickem(),after=pickem(weeks);
  assert.equal(after.ok,true,after.reason);
  assert.deepEqual(after.rows.map(x=>[x.entry_id,x.correct,x.rank]),[
    ['beta',2,1],['alpha',1,2]
  ]);
  assert.notEqual(after.fingerprint,before.fingerprint);
  assert.deepEqual(after.revisions.map(x=>x.revision),[2,1]);
  assert.equal(weeks[0].revisions.length,2,'old revision is retained');
});
test('missing Pickem submissions are recorded as missing without a fabricated win',()=>{
  const weeks=pickemWeeks();
  weeks[1].submissions=[weeks[1].submissions[0]];
  const r=pickem(weeks);
  assert.equal(r.ok,true);
  const beta=r.rows.find(x=>x.entry_id==='beta');
  assert.equal(beta.correct,0);
  assert.equal(beta.missing_weeks,1);
  assert.equal(beta.submitted_weeks,1);
});
test('Survivor advances only actual winners and tie eliminates either side',()=>{
  const r=survivor();
  assert.equal(r.ok,true,r.reason);
  assert.deepEqual(r.rows.map(x=>[x.entry_id,x.status,x.advanced_weeks,x.eliminated_week]),[
    ['alpha','active',2,null],['beta','eliminated',0,1]
  ]);
  assert.equal(r.rows[1].elimination_reason,'tie');
  assert.equal(r.rows[1].ignored_later_submissions,1);
});
test('a corrected prior result retroactively eliminates a previously advanced entry',()=>{
  const weeks=survivorWeeks();
  weeks[0].revisions.push(revision({...results1,W1_AAA_BBB:{
    status:'final',away_score:14,home_score:21
  }},2));
  const r=survivor(weeks);
  assert.equal(r.ok,true,r.reason);
  const alpha=r.rows.find(x=>x.entry_id==='alpha');
  assert.equal(alpha.status,'eliminated');
  assert.equal(alpha.eliminated_week,1);
  assert.equal(alpha.advanced_weeks,0);
  assert.equal(alpha.ignored_later_submissions,1);
});
test('Survivor cannot reuse its prior winning team',()=>{
  const weeks=survivorWeeks();
  weeks[1].submissions=[submission('alpha',{team:'AAA'})];
  const r=survivor(weeks);
  assert.equal(r.ok,false);
  assert.match(r.reason,/invalid_survivor_week/);
  assert.deepEqual(r.rows,[]);
});
test('no-pick Survivor policy: a loss by default or by the pool’s own rule, never an advancement, and no other rule is graded',()=>{
  const weeks=survivorWeeks();
  weeks[1].submissions=[];
  const stated=survivor(weeks);
  assert.equal(stated.ok,true);
  assert.equal(stated.rows.find(x=>x.entry_id==='alpha').elimination_reason,'no_pick');
  // A pool that states no rule: the default (ruling of 2026-11-13) gives exactly the same replay.
  const byDefault=survivor(weeks,{rules:{}});
  assert.equal(byDefault.ok,true,byDefault.reason);
  assert.deepEqual(byDefault.rows,stated.rows);
  assert.equal(byDefault.fingerprint,stated.fingerprint);
  assert.ok(byDefault.rows.every(row=>row.advanced_weeks<=1),'the week without a pick is not counted as survived');
  // A pool that states another rule is not replayed at all.
  const other=survivor(weeks,{rules:{missingSurvivorPick:'advance'}});
  assert.deepEqual([other.ok,other.reason],[false,'unsupported_missing_survivor_pick_rule']);
});
test('foreign pool context, gaps and repeated weeks fail with no partial standings',()=>{
  const foreign=pickemWeeks();foreign[1].pool_id=other;
  assert.equal(pickem(foreign).ok,false);
  const gap=pickemWeeks();gap[1].week=3;
  assert.equal(pickem(gap).ok,false);
  const duplicate=pickemWeeks();duplicate[1].week=1;
  assert.equal(pickem(duplicate).ok,false);
  const wrongStart=pickem(pickemWeeks(),{start_week:2});
  assert.equal(wrongStart.ok,false);
});
test('extra, duplicate, or malformed submissions cannot influence results',()=>{
  const foreign=pickemWeeks();
  foreign[1].submissions.push(submission('foreigner',{picks:{}}));
  assert.equal(pickem(foreign).reason,'foreign_or_duplicate_submission');
  const repeated=pickemWeeks();
  repeated[0].submissions.push(repeated[0].submissions[0]);
  assert.equal(pickem(repeated).ok,false);
  assert.equal(pickem(pickemWeeks(),{entries:[...entries,entries[0]]}).ok,false);
});
test('gapped or unaudited result revision chains fail closed',()=>{
  const missing=pickemWeeks();missing[0].revisions=[];
  assert.equal(pickem(missing).reason,'missing_result_revision');
  const skipped=pickemWeeks();skipped[0].revisions.push(revision(results1,3));
  assert.equal(pickem(skipped).reason,'invalid_result_revision');
  const noReason=pickemWeeks();noReason[0].revisions.push(revision(results1,2,{reason:''}));
  assert.equal(pickem(noReason).reason,'invalid_correction_audit');
  const noProof=pickemWeeks();noProof[0].revisions[0].source_sha256='fake';
  assert.equal(pickem(noProof).reason,'invalid_result_revision');
});
test('a provisional or malformed final cannot appear in a season replay',()=>{
  const weeks=pickemWeeks();
  weeks[1].revisions[0].results={
    ...results2,W2_AAA_CCC:{status:'live',away_score:27,home_score:10}
  };
  assert.equal(pickem(weeks).reason,'unverified_final_result');
});
test('unsupported scoring rules cannot silently produce an official rank',()=>{
  assert.equal(pickem(pickemWeeks(),{rules:{tiesBothLose:false}}).reason,'unsupported_pickem_rules');
  assert.equal(pickem(pickemWeeks(),{rules:{pointsPerCorrectPick:2}}).reason,'unsupported_pickem_rules');
});
test('offline replay has no I/O, SQL, or credential access',()=>{
  const src=readFileSync(new URL('../server/season-replay-core.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(src,/\bfetch\s*\(|\bINSERT\s+INTO\b|\bUPDATE\s+public\.|process\.env|\bconnect\s*\(/);
});
