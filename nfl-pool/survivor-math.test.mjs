import assert from 'node:assert/strict';
import {survivorEntryState,survivorEligibleEntering,survivorPickDistribution,survivorSummary,survivorWeekProgress} from './survivor-math.js';

const entries=[
  {picks:['PIT','SF']},
  {picks:['LV','SF']},
  {picks:['LAC',null]},
  {picks:['JAX','TB']},
  {picks:['SF','SF']},
  {picks:['DET','TB']}
];
const week1=new Map([
  ['PIT',{completed:true,state:'post',winner:'PIT',tie:false}],
  ['LV',{completed:true,state:'post',winner:'LV',tie:false}],
  ['LAC',{completed:true,state:'post',winner:'KC',tie:false}],
  ['JAX',{completed:true,state:'post',winner:'JAX',tie:false}],
  ['SF',{completed:true,state:'post',winner:'SF',tie:false}],
  ['DET',{completed:true,state:'post',winner:'DET',tie:false}]
]);
const week2=new Map([
  ['SF',{completed:true,state:'post',winner:'SF',tie:false}],
  ['TB',{completed:true,state:'post',winner:null,tie:true}]
]);
const results=[week1,week2];

assert.equal(survivorEntryState(entries[0],1,results).status,'alive');
assert.deepEqual(survivorEntryState(entries[2],1,results),{status:'out',pick:'LAC',week:1,eliminatedWeek:1,reason:'LAC lost in Week 1',type:'loss'});
assert.equal(survivorEntryState(entries[3],1,results).type,'tie');
assert.equal(survivorEntryState(entries[4],1,results).type,'repeat');
assert.equal(survivorEntryState(entries[4],1,results).eliminatedWeek,2);
assert.equal(survivorEligibleEntering(entries[2],1,results),false);

const dist=survivorPickDistribution(entries,1,results);
assert.deepEqual(dist,[{team:'SF',count:3,denominator:5,pct:60},{team:'TB',count:2,denominator:5,pct:40}]);

assert.deepEqual(survivorSummary(entries,1,results),{
  poolSize:6,eligibleEntering:5,entered:5,active:2,eliminatedBefore:1,eliminatedThisWeek:3,pending:0
});

assert.deepEqual(survivorWeekProgress(entries,1,results),[
  {week:1,eligibleEntering:6,entered:6,remaining:5,eliminated:1},
  {week:2,eligibleEntering:5,entered:5,remaining:2,eliminated:3}
]);

const noPick={picks:['PIT',null]};
assert.equal(survivorEntryState(noPick,1,results).type,'no-pick');

const pendingResults=[week1,new Map([['SF',{completed:false,state:'in',winner:null,tie:false}]])];
assert.equal(survivorEntryState(entries[0],1,pendingResults).status,'live');
assert.equal(survivorSummary([entries[0]],1,pendingResults).pending,1);

console.log('survivor cumulative elimination, repeat-team, tie, no-pick, distribution and attrition regressions passed');
