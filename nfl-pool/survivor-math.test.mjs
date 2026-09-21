import assert from 'node:assert/strict';
import {survivorEntryState,survivorPickDistribution,survivorSummary} from './survivor-math.js';

const entries=[
  {picks:['PIT','SF']},
  {picks:['LV','SF']},
  {picks:['LAC',null]},
  {picks:['JAX','TB']}
];
const dist=survivorPickDistribution(entries,1);
assert.deepEqual(dist,[{team:'SF',count:2,denominator:3,pct:67},{team:'TB',count:1,denominator:3,pct:33}]);

const results=new Map([
  ['SF',{completed:true,state:'post',winner:'SF',tie:false}],
  ['TB',{completed:true,state:'post',winner:null,tie:true}]
]);
assert.equal(survivorEntryState(entries[0],1,results).status,'alive');
assert.equal(survivorEntryState(entries[2],1,results).status,'out');
assert.equal(survivorEntryState(entries[3],1,results).status,'out');
assert.deepEqual(survivorSummary(entries,1,results),{poolSize:4,entered:3,active:2,eliminatedBefore:1,eliminatedThisWeek:1,pending:0});

const pending=new Map([['SF',{completed:false,state:'in',winner:null,tie:false}]]);
assert.equal(survivorEntryState(entries[0],1,pending).status,'live');
console.log('survivor state, tie elimination, no-pick, and ownership regressions passed');
