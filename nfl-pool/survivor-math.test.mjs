import assert from 'node:assert/strict';
import {survivorEntryState,survivorEligibleEntering,survivorPickDistribution,survivorSummary,survivorWeekProgress,survivorFieldAvailability,survivorDecisionOptions,survivorMarketMatchups} from './survivor-math.js';

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
assert.deepEqual(dist,[{team:'SF',count:2,denominator:4,pct:50},{team:'TB',count:2,denominator:4,pct:50}]);

assert.deepEqual(survivorSummary(entries,1,results),{
  poolSize:6,eligibleEntering:5,submitted:5,entered:4,active:2,eliminatedBefore:1,eliminatedThisWeek:3,pending:0
});

assert.deepEqual(survivorWeekProgress(entries,1,results),[
  {week:1,eligibleEntering:6,submitted:6,entered:6,remaining:5,eliminated:1},
  {week:2,eligibleEntering:5,submitted:5,entered:4,remaining:2,eliminated:3}
]);

const noPick={picks:['PIT',null]};
assert.equal(survivorEntryState(noPick,1,results).type,'no-pick');

const pendingResults=[week1,new Map([['SF',{completed:false,state:'in',winner:null,tie:false}]])];
assert.equal(survivorEntryState(entries[0],1,pendingResults).status,'live');
assert.equal(survivorSummary([entries[0]],1,pendingResults).pending,1);

console.log('survivor cumulative elimination, repeat-team, tie, no-pick, distribution and attrition regressions passed');


const nextTeams=['PIT','LV','SF','KC','BUF','MIA'];
const availability=survivorFieldAvailability(entries,2,results,nextTeams);
const byTeam=new Map(availability.map(x=>[x.team,x]));
assert.deepEqual(byTeam.get('SF'),{team:'SF',available:0,denominator:2,pct:0});
assert.deepEqual(byTeam.get('PIT'),{team:'PIT',available:1,denominator:2,pct:50});
assert.deepEqual(byTeam.get('LV'),{team:'LV',available:1,denominator:2,pct:50});
assert.deepEqual(byTeam.get('KC'),{team:'KC',available:2,denominator:2,pct:100});

const week3=[
  {away:'DEN',home:'KC',favorite:'KC',spread:7.5,date:'2026-09-27T17:00:00Z'},
  {away:'MIA',home:'BUF',favorite:'BUF',spread:3.5,date:'2026-09-27T17:00:00Z'},
  {away:'PIT',home:'CIN',favorite:'PIT',spread:2.5,date:'2026-09-27T17:00:00Z'}
];
const dcOptions=survivorDecisionOptions(entries[0],2,results,week3,availability);
assert.equal(dcOptions.eligible,true);
assert.deepEqual(dcOptions.burned,['PIT','SF']);
assert.equal(dcOptions.options.some(x=>x.team==='PIT'),false);
assert.equal(dcOptions.options.some(x=>x.team==='KC'&&x.favorite&&x.spread===7.5),true);
assert.equal(dcOptions.options.find(x=>x.team==='KC').fieldAvailablePct,100);

const outOptions=survivorDecisionOptions(entries[2],2,results,week3,availability);
assert.equal(outOptions.eligible,false);
assert.equal(outOptions.options.length,0);

console.log('survivor Week-ahead field availability and tracked decision-support regressions passed');


const marketEvents=[
  {date:'2026-09-27T17:00:00Z',competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:'DEN'}},{homeAway:'home',team:{abbreviation:'KC'}}
  ],odds:[{details:'KC -7.5',homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}}]}]},
  {date:'2026-09-27T20:25:00Z',competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:'MIA'}},{homeAway:'home',team:{abbreviation:'BUF'}}
  ],odds:[{details:'BUF -3.5'}]}]},
  {date:'2026-09-28T00:20:00Z',competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:'PHI'}},{homeAway:'home',team:{abbreviation:'DAL'}}
  ]}]},
  {competitions:[{competitors:[{homeAway:'away',team:{abbreviation:'NYJ'}}]}]}
];
assert.deepEqual(survivorMarketMatchups(marketEvents),[
  {away:'DEN',home:'KC',date:'2026-09-27T17:00:00Z',favorite:'KC',spread:7.5},
  {away:'MIA',home:'BUF',date:'2026-09-27T20:25:00Z',favorite:'BUF',spread:3.5},
  {away:'PHI',home:'DAL',date:'2026-09-28T00:20:00Z',favorite:null,spread:null}
]);

console.log('survivor ESPN Week-ahead schedule and market parsing regressions passed');
