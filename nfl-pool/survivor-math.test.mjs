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


// Positive details syntax must never invent an underdog as the market favorite.
const positiveSpread=survivorMarketMatchups([{
  date:'2026-09-27T17:00:00Z',
  competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:'DEN'}},{homeAway:'home',team:{abbreviation:'KC'}}
  ],odds:[{details:'KC +3.5'}]}]
}]);
assert.deepEqual(positiveSpread,[{away:'DEN',home:'KC',date:'2026-09-27T17:00:00Z',favorite:null,spread:null}]);

// Explicit ESPN favorite flags remain authoritative, but contradictory positive details do not fabricate a spread.
const explicitFavorite=survivorMarketMatchups([{
  competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:'DEN'}},{homeAway:'home',team:{abbreviation:'KC'}}
  ],odds:[{details:'KC +3.5',homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}}]}]
}]);
assert.deepEqual(explicitFavorite,[{away:'DEN',home:'KC',date:null,favorite:'KC',spread:null}]);

const explicitSpreadFavorite=survivorMarketMatchups([{
  competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:'MIA'}},{homeAway:'home',team:{abbreviation:'BUF'}}
  ],odds:[{spread:-4,homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}}]}]
}]);
assert.deepEqual(explicitSpreadFavorite,[{away:'MIA',home:'BUF',date:null,favorite:'BUF',spread:4}]);

// Ambiguous duplicate-team schedules fail closed for the affected matchups instead of duplicating options.
const duplicateSchedule=[
  {away:'DEN',home:'KC',favorite:'KC',spread:7.5,date:'a'},
  {away:'LV',home:'KC',favorite:'KC',spread:6.5,date:'b'},
  {away:'MIA',home:'BUF',favorite:'BUF',spread:3.5,date:'c'}
];
const duplicateOptions=survivorDecisionOptions(entries[0],2,results,duplicateSchedule,availability);
assert.equal(duplicateOptions.options.some(x=>x.team==='KC'),false);
assert.equal(duplicateOptions.options.some(x=>x.team==='DEN'),false);
assert.equal(duplicateOptions.options.some(x=>x.team==='LV'),false);
assert.equal(duplicateOptions.options.filter(x=>x.team==='BUF').length,1);
assert.equal(duplicateOptions.options.filter(x=>x.team==='MIA').length,1);

console.log('survivor positive-spread and duplicate-schedule corrective regressions passed');


// Conflicting explicit favorite flags are authoritative ambiguity: never fall through to details.
const conflictingFlags=survivorMarketMatchups([{
  competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:'DEN'}},{homeAway:'home',team:{abbreviation:'KC'}}
  ],odds:[{details:'KC -3.5',awayTeamOdds:{favorite:true},homeTeamOdds:{favorite:true}}]}]
}]);
assert.deepEqual(conflictingFlags,[{away:'DEN',home:'KC',date:null,favorite:null,spread:null}]);

// Full details-fallback matrix: only recognized competitor + negative spread can infer a favorite.
const marketMatrix=[
  ['KC -7.5','KC',7.5],
  ['KC -7','KC',7],
  ['DEN -3.5','DEN',3.5],
  ['KC +3.5',null,null],
  ['KC +7',null,null],
  ['KC 3.5',null,null],
  ['DEN +3.5',null,null],
  ['XXX -7',null,null],
  ['',null,null],
  [null,null,null]
];
for(const [details,expectedFavorite,expectedSpread] of marketMatrix){
  const odds=details===null?{}:{details};
  const parsed=survivorMarketMatchups([{
    competitions:[{competitors:[
      {homeAway:'away',team:{abbreviation:'DEN'}},{homeAway:'home',team:{abbreviation:'KC'}}
    ],odds:[odds]}]
  }])[0];
  assert.equal(parsed.favorite,expectedFavorite,`details ${String(details)} favorite`);
  assert.equal(parsed.spread,expectedSpread,`details ${String(details)} spread`);
}

// Both explicit flags false permit a valid negative-details fallback.
const bothFalseFallback=survivorMarketMatchups([{
  competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:'DEN'}},{homeAway:'home',team:{abbreviation:'KC'}}
  ],odds:[{details:'KC -6',awayTeamOdds:{favorite:false},homeTeamOdds:{favorite:false}}]}]
}]);
assert.deepEqual(bothFalseFallback,[{away:'DEN',home:'KC',date:null,favorite:'KC',spread:6}]);

// Duplicate-team ambiguity matrix must fail closed only for affected matchups.
const duplicateMatrices=[
  [
    {away:'DEN',home:'KC',favorite:'KC',spread:7,date:'a'},
    {away:'LV',home:'KC',favorite:'KC',spread:6,date:'b'}
  ],
  [
    {away:'KC',home:'DEN',favorite:'KC',spread:7,date:'a'},
    {away:'KC',home:'LV',favorite:'KC',spread:6,date:'b'}
  ],
  [
    {away:'DEN',home:'KC',favorite:'KC',spread:7,date:'a'},
    {away:'KC',home:'LV',favorite:'KC',spread:6,date:'b'}
  ],
  [
    {away:'DEN',home:'KC',favorite:'KC',spread:7,date:'a'},
    {away:'DEN',home:'KC',favorite:'DEN',spread:1,date:'b'}
  ],
  [
    {away:'DEN',home:'KC',favorite:'KC',spread:7,date:'a'},
    {away:'LV',home:'KC',favorite:'LV',spread:2,date:'b'},
    {away:'KC',home:'CHI',favorite:'KC',spread:4,date:'c'}
  ]
];
for(const ambiguous of duplicateMatrices){
  const rows=[...ambiguous,{away:'MIA',home:'BUF',favorite:'BUF',spread:3.5,date:'unique'}];
  const opts=survivorDecisionOptions(entries[0],2,results,rows,availability);
  assert.equal(opts.options.some(x=>ambiguous.some(m=>m.away===x.team||m.home===x.team)),false);
  assert.equal(opts.options.filter(x=>x.team==='MIA').length,1);
  assert.equal(opts.options.filter(x=>x.team==='BUF').length,1);
}

console.log('survivor conflicting-flags and full corrective attack matrix passed');


// ---- Strict NFL score parsing: Number(null)/Number('') must never become a 0-0 final.
{
  const {survivorScore}=await import('./survivor-math.js');
  for(const [value,expected] of [[0,0],['0',0],[17,17],['17',17],[' 17 ',17]])assert.equal(survivorScore(value),expected,`valid score ${JSON.stringify(value)}`);
  for(const value of [null,undefined,'',' ','17.5',17.5,-1,'-1',NaN,Infinity,'abc','1e2','0x10',true,false,{},[],[7],{value:17},'17 points',Number.MAX_SAFE_INTEGER+1])
    assert.equal(survivorScore(value),null,`invalid score ${String(value)}`);
}

const {survivorBuildResults,survivorFeedContextError}=await import('./survivor-math.js');
const ev=(away,home,{as='20',hs='17',completed=true,state=completed?'post':'pre',id,week,season,seasonType}={})=>({
  ...(id?{id}:{}),
  ...(week!==undefined?{week:{number:week}}:{}),
  ...(season!==undefined||seasonType!==undefined?{season:{...(season!==undefined?{year:season}:{}),...(seasonType!==undefined?{type:seasonType}:{})}}:{}),
  status:{type:{completed,state}},
  competitions:[{competitors:[{homeAway:'away',team:{abbreviation:away},score:as},{homeAway:'home',team:{abbreviation:home},score:hs}]}]
});
const ctx={season:2026,week:2};
const stateFor=(pick,map)=>survivorEntryState({picks:[pick]},0,[map]);

// Completed events with missing/invalid scores stay unresolved: no tie, no winner, no elimination for either side.
const noScoreKeys=ev('DEN','KC');for(const c of noScoreKeys.competitions[0].competitors)delete c.score;
for(const [as,hs] of [[null,null],['',''],[' ',' '],['absent','absent'],['17.5','10'],[-1,3],['abc','7'],[null,'0'],['0',null]]){
  const map=survivorBuildResults([as==='absent'?noScoreKeys:ev('DEN','KC',{as,hs})],ctx);
  for(const team of ['DEN','KC']){
    const r=map.get(team);
    assert.equal(r.unresolved,true,`${team} unresolved for ${String(as)}-${String(hs)}`);
    assert.equal(r.tie,false);assert.equal(r.winner,null);assert.equal(r.completed,false);
    const s=stateFor(team,map);
    assert.equal(s.status,'pending');assert.equal(s.type,'unresolved');assert.equal(s.eliminatedWeek,undefined);
    assert.match(s.reason,/result unavailable: final score missing or invalid/);
  }
}
// Valid 0-0 remains a genuine NFL tie (tie = OUT is preserved); valid numeric/string finals still decide winners.
{
  const map=survivorBuildResults([ev('DEN','KC',{as:'0',hs:0}),ev('MIA','BUF',{as:'24',hs:'27'}),ev('NYJ','NE',{as:13,hs:'10'})],ctx);
  assert.equal(stateFor('DEN',map).type,'tie');assert.equal(stateFor('KC',map).type,'tie');
  assert.equal(stateFor('BUF',map).status,'alive');assert.equal(stateFor('MIA',map).type,'loss');
  assert.equal(stateFor('NYJ',map).status,'alive');assert.equal(stateFor('NE',map).type,'loss');
}
// In-progress/scheduled events do not need scores; they remain live/pending.
{
  const map=survivorBuildResults([ev('DEN','KC',{as:null,hs:null,completed:false,state:'in'}),ev('MIA','BUF',{as:'',hs:'',completed:false})],ctx);
  assert.equal(stateFor('KC',map).status,'live');assert.equal(stateFor('BUF',map).status,'pending');assert.equal(stateFor('BUF',map).type,'pending');
}

// ---- Duplicate / ambiguous feed teams fail closed for the affected matchups only; never first/last occurrence wins.
{
  const unique=ev('MIA','BUF',{as:'10',hs:'20'});
  const cases={
    sameTeamTwoEvents:[ev('DEN','KC',{as:'30',hs:'10'}),ev('LV','KC',{as:'3',hs:'31'}),unique],
    exactDuplicate:[ev('DEN','KC',{as:'30',hs:'10',id:'1'}),ev('DEN','KC',{as:'30',hs:'10',id:'1'}),unique],
    homeThenAway:[ev('DEN','KC',{as:'30',hs:'10'}),ev('KC','LV',{as:'31',hs:'3'}),unique],
    lastWouldWin:[ev('DEN','KC',{as:'30',hs:'10'}),ev('DEN','LV',{as:'3',hs:'31'}),unique]
  };
  for(const [name,events] of Object.entries(cases)){
    for(const order of [events,events.slice().reverse()]){
      const map=survivorBuildResults(order,ctx),involved=new Set(events.slice(0,2).flatMap(e=>e.competitions[0].competitors.map(c=>c.team.abbreviation)));
      for(const team of involved){
        const s=stateFor(team,map);
        assert.equal(s.status,'pending',`${name}: ${team} must stay unresolved`);assert.equal(s.type,'unresolved');
        assert.match(s.reason,/more than one feed event/);
      }
      assert.equal(stateFor('BUF',map).status,'alive',`${name}: unrelated unique winner survives`);
      assert.equal(stateFor('MIA',map).type,'loss',`${name}: unrelated unique loser still loses`);
    }
  }
  // A team listed twice inside one malformed event, or an event missing a side, is unresolved rather than skipped.
  const malformed=survivorBuildResults([ev('KC','KC'),{status:{type:{completed:true,state:'post'}},competitions:[{competitors:[{homeAway:'home',team:{abbreviation:'SF'},score:'20'}]}]},unique],ctx);
  assert.equal(stateFor('KC',malformed).type,'unresolved');assert.equal(stateFor('SF',malformed).type,'unresolved');assert.equal(stateFor('BUF',malformed).status,'alive');
  // A malformed duplicate appearance still makes the otherwise-valid event ambiguous.
  const partialDup=survivorBuildResults([ev('DEN','KC',{as:'30',hs:'10'}),{competitions:[{competitors:[{homeAway:'away',team:{abbreviation:'DEN'}}]}]}],ctx);
  assert.equal(stateFor('DEN',partialDup).type,'unresolved');assert.equal(stateFor('KC',partialDup).type,'unresolved');
}

// ---- Feed/event context: checked where exposed, fail closed on mismatch.
{
  assert.equal(survivorFeedContextError({events:[ev('DEN','KC')]},ctx),null);
  assert.equal(survivorFeedContextError({season:{year:2026,type:2},week:{number:2},events:[ev('DEN','KC')]},ctx),null);
  assert.match(survivorFeedContextError({week:{number:3},events:[ev('DEN','KC')]},ctx),/context mismatch: week 3/);
  assert.match(survivorFeedContextError({season:{year:2025},events:[ev('DEN','KC')]},ctx),/season year 2025/);
  assert.match(survivorFeedContextError({season:{type:1},events:[ev('DEN','KC')]},ctx),/season type 1/);
  assert.match(survivorFeedContextError({events:[]},ctx),/no games/);
  assert.match(survivorFeedContextError({},ctx),/no event list/);
  assert.match(survivorFeedContextError(null,ctx),/no event list/);
  const map=survivorBuildResults([ev('DEN','KC',{week:3}),ev('MIA','BUF',{as:'10',hs:'20',week:2,season:2026,seasonType:2}),ev('NYJ','NE',{season:2025})],ctx);
  assert.match(stateFor('KC',map).reason,/outside the expected season\/week/);assert.equal(stateFor('DEN',map).status,'pending');
  assert.equal(stateFor('NE',map).status,'pending');assert.equal(stateFor('BUF',map).status,'alive');
}

// ---- Absent team vs unavailable feed are distinguishable and never eliminate.
{
  const map=survivorBuildResults([ev('MIA','BUF',{as:'10',hs:'20'})],ctx);
  const absent=survivorEntryState({picks:['BUF','KC']},1,[map,map]);
  assert.deepEqual(absent,{status:'pending',pick:'KC',week:2,reason:'KC not present in verified Week 2 feed/schedule',type:'absent'});
  const unavailable=survivorEntryState({picks:['BUF','KC']},1,[map]);
  assert.deepEqual(unavailable,{status:'pending',pick:'KC',week:2,reason:'Week 2 result unavailable',type:'unresolved'});
  // Malformed caller-supplied result objects can never eliminate an entry.
  for(const bad of [{completed:true,tie:false},{completed:true,tie:false,winner:''},{completed:true,tie:false,winner:'LV',opponent:'DEN'}]){
    const s=survivorEntryState({picks:['KC']},0,[new Map([['KC',bad]])]);
    assert.equal(s.status,'pending');assert.equal(s.type,'unresolved');
  }
}

// ---- Malformed current-week data keeps the next-week board gated; history, burned teams and D.C./DJS/Thaddeus stay intact.
{
  const w1=survivorBuildResults([ev('PIT','CLE',{as:'24',hs:'10'}),ev('LV','NE',{as:'20',hs:'13'}),ev('KC','LAC',{as:'27',hs:'21'})],{season:2026,week:1});
  const w2bad=survivorBuildResults([ev('SF','ARI',{as:null,hs:null})],ctx);
  const dc={picks:['PIT','SF']},djs={picks:['LV','SF']},thaddeus={picks:['LAC',null]};
  assert.equal(survivorEntryState(thaddeus,1,[w1,w2bad]).type,'loss');
  assert.equal(survivorEntryState(thaddeus,1,[w1,w2bad]).eliminatedWeek,1);
  assert.equal(survivorEntryState(dc,1,[w1,w2bad]).status,'pending');
  const summary=survivorSummary([dc,djs,thaddeus],1,[w1,w2bad]);
  assert.equal(summary.pending,2);assert.equal(summary.active,2);assert.equal(summary.eliminatedBefore,1);
  const next=survivorDecisionOptions(dc,2,[w1,w2bad],[{away:'DEN',home:'KC',favorite:'KC',spread:7}],[]);
  assert.equal(next.eligible,false);assert.deepEqual(next.burned,['PIT','SF']);assert.equal(next.options.length,0);
  assert.equal(survivorFieldAvailability([dc,djs,thaddeus],2,[w1,w2bad],['KC']).find(x=>x.team==='KC').denominator,0);
  const w2ok=survivorBuildResults([ev('SF','ARI',{as:'27',hs:'20'})],ctx);
  assert.equal(survivorEntryState(dc,1,[w1,w2ok]).status,'alive');assert.equal(survivorEntryState(djs,1,[w1,w2ok]).status,'alive');
  assert.equal(survivorSummary([dc,djs,thaddeus],1,[w1,w2ok]).pending,0);
}

// ---- A completed flag alone is not proof of a final: contradictory status, halted games, winner flags, extra competitions.
{
  const {survivorUnresolvedEntering,SURVIVOR_TEAM_CODES}=await import('./survivor-math.js');
  const final=(overrides={},compOverrides={})=>{const e=ev('DEN','KC',{as:'20',hs:'17'});Object.assign(e.status.type,overrides);Object.assign(e.competitions[0],compOverrides);return e};
  const cases=[
    ['completed while state in',final({state:'in'}),/final status is contradictory/],
    ['completed while state pre (0-0)',(()=>{const e=final({state:'pre'});e.competitions[0].competitors.forEach(c=>c.score='0');return e})(),/final status is contradictory/],
    ['canceled',final({name:'STATUS_CANCELED'}),/final status is contradictory/],
    ['postponed',final({name:'STATUS_POSTPONED'}),/final status is contradictory/],
    ['suspended',final({name:'STATUS_SUSPENDED'}),/final status is contradictory/],
    ...['STATUS_ABANDONED','STATUS_NO_CONTEST','STATUS_RESCHEDULED','STATUS_DELAYED','STATUS_UNCONTESTED','STATUS_IN_PROGRESS','STATUS_FINAL_CANCELED'].map(name=>[`unknown non-final name ${name}`,final({name}),/final status is contradictory/]),
    ['competition-level non-final name',final({name:'STATUS_FINAL'},{status:{type:{completed:true,state:'post',name:'STATUS_ABANDONED'}}}),/final status is contradictory/],
    ['competition status still live',final({},{status:{type:{completed:false,state:'in'}}}),/final status is contradictory/],
    ['winner flag on score loser',(()=>{const e=final();e.competitions[0].competitors[1].winner=true;return e})(),/winner flag contradicts/],
    ['winner flag on a tied score',(()=>{const e=final();e.competitions[0].competitors.forEach(c=>c.score='10');e.competitions[0].competitors[0].winner=true;return e})(),/winner flag contradicts/],
    ['second competition',(()=>{const e=final();e.competitions.push(structuredClone(e.competitions[0]));return e})(),/feed event is malformed/],
    ['non-NFL team code',ev('7','KC'),/feed event is malformed/]
  ];
  for(const [label,event,pattern] of cases){
    const map=survivorBuildResults([event,ev('MIA','BUF',{as:'10',hs:'20'})],ctx);
    const s=stateFor('KC',map);
    assert.equal(s.status,'pending',label);assert.equal(s.type,'unresolved',label);assert.match(s.reason,pattern,label);
    assert.equal(stateFor('BUF',map).status,'alive',`${label}: unrelated game still final`);
  }
  // Consistent finals (including matching winner flags and a matching competition status) remain decisive.
  const ok=final({name:'STATUS_FINAL'},{status:{type:{completed:true,state:'post',name:'STATUS_FINAL'}}});ok.competitions[0].competitors[0].winner=true;ok.competitions[0].competitors[1].winner=false;
  const okMap=survivorBuildResults([ok],ctx);
  assert.equal(stateFor('DEN',okMap).status,'alive');assert.equal(stateFor('KC',okMap).type,'loss');
  const ot=final({name:'STATUS_FINAL_OVERTIME'},{status:{type:{completed:true,state:'post',name:'STATUS_FINAL_OVERTIME'}}});
  assert.equal(stateFor('KC',survivorBuildResults([ot],ctx)).type,'loss');
  // The builder refuses to run without an explicit season/week context.
  assert.throws(()=>survivorBuildResults([ok]),/integer season and week/);
  assert.throws(()=>survivorBuildResults([ok],{season:2026}),/integer season and week/);
  // Result objects must use real booleans/strings; truthy look-alikes never eliminate.
  for(const bad of [{completed:1,tie:false,winner:'DEN'},{completed:true,tie:'false',winner:null},{completed:true,tie:true,winner:'DEN'},{completed:true,tie:false,winner:7}]){
    const s=survivorEntryState({picks:['KC']},0,[new Map([['KC',bad]])]);
    assert.notEqual(s.status,'out',JSON.stringify(bad));
  }
  assert.equal(SURVIVOR_TEAM_CODES.size,32);
  // Entries whose earlier-week result is unresolved are counted so the UI can mark current-week numbers provisional.
  const w1=survivorBuildResults([ev('PIT','CLE',{as:null,hs:null}),ev('LV','NE',{as:'20',hs:'13'})],{season:2026,week:1});
  assert.equal(survivorUnresolvedEntering([{picks:['PIT','SF']},{picks:['LV','SF']},{picks:['NE',null]}],1,[w1]),1);
  assert.equal(survivorUnresolvedEntering([{picks:['PIT','SF']}],0,[w1]),0);
}

console.log('survivor strict score, malformed final, duplicate-feed, context, absent-team and gating regressions passed');


// ---- HDC-04: Week-ahead market codes reach the public decision board's markup, so only NFL codes may pass.
// Any other feed abbreviation, on either side, drops its whole matchup; valid codes and feed aliases pass unchanged.
{
  const NFL=['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];
  const event=(away,home,odds)=>({competitions:[{competitors:[{homeAway:'away',team:{abbreviation:away}},{homeAway:'home',team:{abbreviation:home}}],...(odds?{odds:[odds]}:{})}]});
  const pairs=[];for(let i=0;i<NFL.length;i+=2)pairs.push([NFL[i],NFL[i+1]]);
  for(const feed of [pairs,pairs.map(p=>p.map(t=>t.toLowerCase()))])
    assert.deepEqual(survivorMarketMatchups(feed.map(([a,h])=>event(a,h))),pairs.map(([away,home])=>({away,home,date:null,favorite:null,spread:null})),'all 32 NFL codes pass');
  assert.deepEqual(survivorMarketMatchups([event('JAC','WSH',{details:'WSH -3'}),event('wsh','jac',{details:'JAC -2.5'})]),[
    {away:'JAX',home:'WAS',date:null,favorite:'WAS',spread:3},
    {away:'WAS',home:'JAX',date:null,favorite:'JAX',spread:2.5}
  ]);
  const kept={away:'MIA',home:'BUF',date:null,favorite:'BUF',spread:3.5};
  for(const code of ['x" onerror="alert(1)','"><img src=x onerror=alert(1)>','KC/../x','K C','XXX','OAK','TBD','KCC','7',7,{},'',null,undefined]){
    for(const [away,home] of [[code,'KC'],['KC',code],[code,code]]){
      const odds={spread:-7,awayTeamOdds:{favorite:away===code},homeTeamOdds:{favorite:home===code}};
      const parsed=survivorMarketMatchups([event(away,home,odds),event('MIA','BUF',{details:'BUF -3.5'})]);
      assert.deepEqual(parsed,[kept],`${JSON.stringify(code)} (${away===code?'away':'home'}${away===home?'+home':''}) must never become a decision option`);
    }
  }
}

console.log('survivor Week-ahead market NFL-code allowlist regressions passed');


// ---- HDC-11: a game the feed reports as not completed (completed !== true) whose event or competition status explicitly
// names a halted state (CANCEL, POSTPON, SUSPEND or FORFEIT) awaits a pool ruling. Its pickers are never alive, never out
// and never ordinary pending: the state keeps status 'pending' and type 'pending' (the fields the frozen Admin publish guard
// reads), carries the halted status name and says why. Nothing is decided: no elimination, no advancement, no used team,
// and later results are not applied to it. Ordinary unfinished games, games without explicit status evidence and completed
// games (HDC-10) are unchanged.
{
  const {projectScoreboard}=await import('./score-proxy/index.mjs');
  const {survivorUnresolvedEntering,survivorAwaitingRuling}=await import('./survivor-math.js');
  // ESPN 2022 Week 17 BUF at CIN (event 401437947) as the scoreboard serves it: STATUS_CANCELED, state post, completed:false,
  // 0-0, no winner flags, the competition repeating the event status. ESPN 2017 Week 1 TB at MIA (400951581) has the same
  // shape as STATUS_POSTPONED.
  const statusType=(name,state,detail)=>({id:'5',...(name===undefined?{}:{name}),state,completed:false,description:detail,detail,shortDetail:detail});
  const bufCin=(type=statusType('STATUS_CANCELED','post','Canceled'),comp=type)=>({
    id:'401437947',date:'2023-01-03T01:30Z',season:{year:2022,type:2,slug:'regular-season'},week:{number:17},
    status:{clock:372,displayClock:'6:12',period:1,type:{...type}},
    competitions:[{id:'401437947',...(comp?{status:{clock:372,displayClock:'6:12',period:1,type:{...comp},isTBDFlex:false}}:{}),competitors:[
      {id:'4',homeAway:'home',team:{abbreviation:'CIN'},score:'0'},{id:'2',homeAway:'away',team:{abbreviation:'BUF'},score:'0'}
    ]}]
  });
  const finalType={id:'3',name:'STATUS_FINAL',state:'post',completed:true,description:'Final',detail:'Final',shortDetail:'Final'};
  const scored=(event,home,away)=>{const [h,a]=event.competitions[0].competitors;h.score=String(home);a.score=String(away);h.winner=home>away;a.winner=away>home;return event};
  const final17=(away,home,as,hs)=>({id:`${away}-${home}`,season:{year:2022,type:2},week:{number:17},status:{type:{...finalType}},
    competitions:[{status:{type:{...finalType}},competitors:[
      {homeAway:'home',team:{abbreviation:home},score:String(hs),winner:hs>as},{homeAway:'away',team:{abbreviation:away},score:String(as),winner:as>hs}
    ]}]});
  // A Week-17 entry that won Weeks 1-16 with sixteen other teams, so its Week-17 state reads as the real season would.
  const EARLIER=['ARI','ATL','BAL','CAR','CHI','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC'];
  const won=team=>new Map([[team,{completed:true,state:'post',winner:team,tie:false}]]);
  const at17=(pick,week17)=>survivorEntryState({picks:[...EARLIER,pick]},16,[...EARLIER.map(won),week17]);
  const ctx17={season:2022,week:17};

  // R1. Canceled, postponed, suspended and forfeit games that are not completed await a pool ruling, at either status level.
  const HALTED=[
    ['STATUS_CANCELED (ESPN 2022 Week 17 BUF at CIN)',bufCin(),'STATUS_CANCELED'],
    ['STATUS_POSTPONED (the ESPN 2017 Week 1 TB at MIA shape)',bufCin(statusType('STATUS_POSTPONED','post','Postponed')),'STATUS_POSTPONED'],
    ['STATUS_POSTPONED before kickoff',bufCin(statusType('STATUS_POSTPONED','pre','Postponed')),'STATUS_POSTPONED'],
    ['STATUS_SUSPENDED mid-game',scored(bufCin(statusType('STATUS_SUSPENDED','in','Suspended')),7,3),'STATUS_SUSPENDED'],
    ['STATUS_FORFEIT',bufCin(statusType('STATUS_FORFEIT','post','Forfeit')),'STATUS_FORFEIT'],
    ['a FORFEITED variant',bufCin(statusType('STATUS_FORFEITED','post','Forfeited')),'STATUS_FORFEITED'],
    ['the CANCELLED spelling',bufCin(statusType('STATUS_CANCELLED','post','Cancelled')),'STATUS_CANCELLED'],
    ['a lower-case name',bufCin(statusType('status_postponed','pre','Postponed')),'status_postponed'],
    ['the event status name only (no competition status)',bufCin(statusType('STATUS_CANCELED','post','Canceled'),null),'STATUS_CANCELED'],
    ['the competition status name only',bufCin(statusType(undefined,'post','Canceled'),statusType('STATUS_CANCELED','post','Canceled')),'STATUS_CANCELED'],
    ['an ordinary event name with a halted competition name',bufCin(statusType('STATUS_SCHEDULED','pre','Scheduled'),statusType('STATUS_POSTPONED','pre','Postponed')),'STATUS_POSTPONED']
  ];
  for(const [label,event,name] of HALTED){
    const week17=survivorBuildResults([structuredClone(event),final17('MIA','NE',21,23)],ctx17);
    for(const [team,opponent] of [['BUF','CIN'],['CIN','BUF']]){
      const s=at17(team,week17);
      assert.notEqual(s.status,'alive',`${label}: the ${team} picker is never alive`);
      assert.notEqual(s.status,'out',`${label}: the ${team} picker is never out`);
      assert.equal(s.eliminatedWeek,undefined,`${label}: no elimination week`);
      assert.deepEqual(s,{status:'pending',pick:team,week:17,reason:`Week 17 ${team} game halted (${name}): awaiting pool ruling`,type:'pending',halted:name},`${label}: the ${team} picker awaits a pool ruling`);
      assert.deepEqual(week17.get(team),{completed:false,state:event.status.type.state,winner:null,tie:false,opponent,halted:name},`${label}: ${team} has no result, only the halted status`);
    }
    assert.equal(at17('NE',week17).status,'alive',`${label}: an unrelated final still resolves`);
    assert.equal(at17('MIA',week17).type,'loss',`${label}: an unrelated loser still loses`);
  }

  // R5. Ordinary unfinished games and games without explicit halted evidence keep exactly the production state.
  const ORDINARY=[
    ['scheduled (STATUS_SCHEDULED)',bufCin(statusType('STATUS_SCHEDULED','pre','Mon, January 2nd at 8:30 PM EST')),'pending'],
    ['pregame without a status name',bufCin(statusType(undefined,'pre','1/2 - 8:30 PM EST')),'pending'],
    ['live (STATUS_IN_PROGRESS)',scored(bufCin(statusType('STATUS_IN_PROGRESS','in','6:12 - 1st Quarter')),7,3),'live'],
    ['halftime (STATUS_HALFTIME)',scored(bufCin(statusType('STATUS_HALFTIME','in','Halftime')),10,10),'live'],
    ['end of a period (STATUS_END_PERIOD)',scored(bufCin(statusType('STATUS_END_PERIOD','in','End of 1st Quarter')),7,3),'live'],
    ['a weather delay expected to resume (STATUS_DELAYED)',scored(bufCin(statusType('STATUS_DELAYED','in','Delayed')),7,3),'live'],
    ['a rain delay (STATUS_RAIN_DELAY)',scored(bufCin(statusType('STATUS_RAIN_DELAY','in','Rain Delay')),7,3),'live'],
    ['a delayed start (STATUS_DELAYED before kickoff)',bufCin(statusType('STATUS_DELAYED','pre','Delayed')),'pending'],
    ['state post without a status name',bufCin(statusType(undefined,'post','Canceled')),'pending'],
    ['a null status name',bufCin(statusType(null,'pre','Scheduled')),'pending'],
    ['a status name that is not a string',bufCin(statusType(5,'pre','Scheduled')),'pending'],
    ['no status at all',(()=>{const e=bufCin();delete e.status;delete e.competitions[0].status;return e})(),'pending']
  ];
  for(const [label,event,status] of ORDINARY){
    const week17=survivorBuildResults([structuredClone(event)],ctx17);
    for(const team of ['BUF','CIN']){
      assert.deepEqual(at17(team,week17),{status,pick:team,week:17,reason:status==='live'?'Week 17 game live':'Week 17 game pending',type:'pending'},`${label}: ${team} stays ordinary ${status}`);
      assert.equal(Object.hasOwn(week17.get(team),'halted'),false,`${label}: no halted status is manufactured for ${team}`);
    }
  }

  // R8/R9. completed:true is judged only as a final (HDC-10): a halted name on a completed event, FORFEIT included, is a
  // contradictory final (unresolved, never a pool ruling), while a consistent final whose detail mentions a forfeit decides.
  for(const name of ['STATUS_CANCELED','STATUS_POSTPONED','STATUS_SUSPENDED','STATUS_FORFEIT','STATUS_FINAL_FORFEIT']){
    const week17=survivorBuildResults([scored(bufCin({...statusType(name,'post','Final'),completed:true}),23,20)],ctx17);
    for(const team of ['BUF','CIN']){
      assert.deepEqual(at17(team,week17),{status:'pending',pick:team,week:17,reason:`Week 17 ${team} result unavailable: final status is contradictory or not a completed game`,type:'unresolved'},`completed:true + ${name}: the HDC-10 contradiction, not a pool ruling`);
      assert.equal(Object.hasOwn(week17.get(team),'halted'),false);
    }
  }
  {
    const forfeitFinal=scored(bufCin({...finalType,detail:'Final - Forfeit',shortDetail:'Final - Forfeit'}),2,0);
    const week17=survivorBuildResults([forfeitFinal],ctx17);
    assert.equal(at17('CIN',week17).status,'alive','a consistent completed final mentioning a forfeit only in its detail decides');
    assert.deepEqual(at17('BUF',week17),{status:'out',pick:'BUF',week:17,eliminatedWeek:17,reason:'BUF lost in Week 17',type:'loss'});
  }

  // R6. Nothing is memoized: the same event reported later as an ordinary live game or a verified final is judged as such.
  {
    const live=scored(bufCin(statusType('STATUS_IN_PROGRESS','in','10:00 - 3rd Quarter')),14,10);
    const final=scored(bufCin({...finalType}),27,24);
    for(const halted of [bufCin(statusType('STATUS_POSTPONED','pre','Postponed')),scored(bufCin(statusType('STATUS_SUSPENDED','in','Suspended')),7,3)]){
      const name=halted.status.type.name;
      assert.equal(at17('BUF',survivorBuildResults([halted],ctx17)).halted,name,`${name}: awaits a pool ruling first`);
      assert.deepEqual(at17('BUF',survivorBuildResults([live],ctx17)),{status:'live',pick:'BUF',week:17,reason:'Week 17 game live',type:'pending'},`${name} then live: ordinary live again`);
      assert.deepEqual(at17('BUF',survivorBuildResults([final],ctx17)),{status:'out',pick:'BUF',week:17,eliminatedWeek:17,reason:'BUF lost in Week 17',type:'loss'},`${name} then final: decided as a final`);
      assert.equal(at17('CIN',survivorBuildResults([final],ctx17)).status,'alive',`${name} then final: the winner advances`);
    }
  }

  // R7. nflscores2 (score-proxy/index.mjs) forwards the status names, so the raw ESPN event and its projection are classified
  // identically, halted or not.
  for(const [label,event,name] of [...HALTED,...ORDINARY.map(([label,event])=>[label,event,null])]){
    const raw=survivorBuildResults([structuredClone(event)],ctx17);
    const projected=survivorBuildResults(projectScoreboard({events:[structuredClone(event)]},'2023-01-03T02:00:00.000Z').events,ctx17);
    assert.deepEqual([...projected],[...raw],`${label}: the projected event gives the raw event's results`);
    for(const team of ['BUF','CIN'])assert.equal(at17(team,projected).halted,name??undefined,`${label}: ${team} classified identically from the projection`);
  }

  // R2/R3. Field counts. Week 2: BUF at CIN is canceled; a and b picked it. c won, d lost, e went out in Week 1, f's game is
  // live. The halted pickers count neither as still in nor as eliminated, are not ordinary pending, and never enter the
  // next week's surviving field or its decision support; f's live game still blocks the board exactly as before.
  const halt=(e,name)=>{e.status.type.name=name;e.competitions[0].status={type:{...e.status.type}};return e};
  const w1=survivorBuildResults([ev('PIT','CLE',{as:'24',hs:'10'}),ev('LV','NE',{as:'20',hs:'13'}),ev('KC','LAC',{as:'27',hs:'21'}),ev('JAX','CAR',{as:'30',hs:'3'}),ev('DEN','SEA',{as:'17',hs:'13'})],{season:2026,week:1});
  const w2=dal=>survivorBuildResults([halt(ev('BUF','CIN',{as:'0',hs:'0',completed:false,state:'post'}),'STATUS_CANCELED'),ev('MIA','NYJ',{as:'24',hs:'10'}),ev('ATL','TB',{as:'10',hs:'20'}),dal],ctx);
  const liveR=[w1,w2(ev('DAL','PHI',{as:'7',hs:'3',completed:false,state:'in'}))],finalR=[w1,w2(ev('DAL','PHI',{as:'27',hs:'3'}))];
  const field={a:{picks:['PIT','BUF']},b:{picks:['LV','CIN']},c:{picks:['KC','MIA']},d:{picks:['JAX','ATL']},e:{picks:['LAC',null]},f:{picks:['DEN','DAL']}};
  const all=Object.values(field);
  const reasonA='Week 2 BUF game halted (STATUS_CANCELED): awaiting pool ruling';
  assert.deepEqual(survivorSummary(all,1,liveR),{poolSize:6,eligibleEntering:5,submitted:5,entered:5,active:2,eliminatedBefore:1,eliminatedThisWeek:1,pending:1},'halted pickers are neither still in, eliminated nor ordinary pending; the live game is pending');
  assert.deepEqual(survivorSummary(all,1,finalR),{poolSize:6,eligibleEntering:5,submitted:5,entered:5,active:2,eliminatedBefore:1,eliminatedThisWeek:1,pending:0},'only the halted pickers remain unresolved: no ordinary pending entry holds the board');
  assert.deepEqual(survivorWeekProgress(all,1,finalR),[
    {week:1,eligibleEntering:6,submitted:6,entered:6,remaining:5,eliminated:1},
    {week:2,eligibleEntering:5,submitted:5,entered:5,remaining:2,eliminated:1}
  ],'attrition counts the halted pickers neither as remaining nor as eliminated');
  assert.equal(survivorUnresolvedEntering(all,2,finalR),0,'awaiting a pool ruling is not awaiting a verified result');
  assert.equal(survivorUnresolvedEntering(all,2,liveR),1,'the live game still leaves its picker unresolved entering Week 3');
  // The halted picks were made in Week 2, so the Week-2 distribution keeps them.
  assert.deepEqual(survivorPickDistribution(all,1,finalR).map(x=>[x.team,x.count,x.denominator]),[['ATL',1,5],['BUF',1,5],['CIN',1,5],['DAL',1,5],['MIA',1,5]]);
  for(const name of ['a','b']){
    const entry=field[name];
    assert.deepEqual(survivorEntryState(entry,1,finalR),{status:'pending',pick:entry.picks[1],week:2,reason:`Week 2 ${entry.picks[1]} game halted (STATUS_CANCELED): awaiting pool ruling`,type:'pending',halted:'STATUS_CANCELED'},`${name}: awaits a pool ruling`);
    assert.equal(survivorEligibleEntering(entry,2,finalR),false,`${name}: never eligible for Week 3`);
  }
  assert.equal(survivorEligibleEntering(field.c,2,finalR),true);assert.equal(survivorEligibleEntering(field.f,2,finalR),true);
  const avail=survivorFieldAvailability(all,2,finalR,['KC','BUF','SEA']);
  assert.deepEqual(avail,[{team:'BUF',available:2,denominator:2,pct:100},{team:'KC',available:1,denominator:2,pct:50},{team:'SEA',available:2,denominator:2,pct:100}],'the surviving field is c and f only');
  const support=survivorDecisionOptions(field.a,2,finalR,[{away:'SEA',home:'KC',favorite:'KC',spread:3}],avail);
  assert.deepEqual([support.eligible,support.reason,support.options],[false,reasonA,[]],'no decision support for a halted picker');
  assert.equal(survivorDecisionOptions(field.c,2,finalR,[{away:'SEA',home:'KC',favorite:'KC',spread:3}],avail).eligible,true,'a provably alive entry keeps decision support');
  assert.equal(typeof survivorAwaitingRuling,'function','survivor-math exports survivorAwaitingRuling');
  assert.equal(survivorAwaitingRuling(all,1,finalR),2);assert.equal(survivorAwaitingRuling(all,1,liveR),2);
  assert.equal(survivorAwaitingRuling(all,0,finalR),0);assert.equal(survivorAwaitingRuling(all,-1,finalR),0);
  // Later weeks are not applied to a halted pick: a Week-3 loss, or no Week-3 pick, leaves the entry awaiting its ruling.
  const w3=survivorBuildResults([ev('SEA','KC',{as:'10',hs:'27'})],{season:2026,week:3});
  assert.deepEqual(survivorEntryState({picks:['PIT','BUF','SEA']},2,[...finalR,w3]),{status:'pending',pick:'BUF',week:2,reason:reasonA,type:'pending',halted:'STATUS_CANCELED'},'a later loss is not applied');
  assert.equal(survivorEntryState({picks:['LV','CIN',null]},2,[...finalR,w3]).halted,'STATUS_CANCELED','a later missing pick is not applied');
  assert.equal(survivorAwaitingRuling([...all,{picks:['PIT','BUF','SEA']}],2,[...finalR,w3]),3,'a, b and the Week-3 entry still await the Week-2 ruling in Week 3');
}

// ---- HDC-11 Admin compatibility: the frozen Admin publish guard (admin/survivor-publish-checks.js) reads status and type,
// so an entry awaiting a pool ruling is exactly what it was before HDC-11, an entry whose earlier result is not final yet:
// the schedule verification and every publication check match those of the same feed without the halted status name.
{
  const {verifySurvivorSchedule,survivorPublishGuard}=await import('./admin/survivor-publish-checks.js');
  const w=(n,pairs,make)=>({season:{year:2026,type:2},week:{number:n},events:pairs.map(([a,h],i)=>make(a,h,{id:`${n}-${i}`,week:n,season:2026}))});
  const week2=named=>w(2,[['BUF','CIN'],['MIA','NYJ'],['ATL','TB'],['DAL','PHI']],(a,h,o)=>{
    const e=ev(a,h,{...o,as:'24',hs:'10'});
    if(a==='BUF'){e.status.type={completed:false,state:'post',...(named?{name:'STATUS_CANCELED'}:{})};e.competitions[0].status={type:{...e.status.type}};for(const c of e.competitions[0].competitors)c.score='0'}
    return e;
  });
  const payloads=named=>({1:w(1,[['PIT','CLE'],['LV','NE'],['KC','LAC'],['JAX','CAR'],['DEN','SEA']],(a,h,o)=>ev(a,h,{...o,as:'24',hs:'10'})),2:week2(named),3:w(3,[['SEA','KC'],['NE','LV'],['CLE','PIT'],['CAR','JAX']],(a,h,o)=>ev(a,h,{...o,completed:false}))});
  const tracked=[{id:'dc',displayName:'D.C.',picks:['PIT','BUF','KC']},{id:'djs',displayName:'DJS',picks:['LV','CIN',null]},{id:'thaddeus',displayName:'Thaddeus',picks:['KC','MIA','SEA']}];
  const fieldEntries=[{id:'survivor-001',picks:['JAX','CIN',null]},{id:'survivor-002',picks:['DEN','DAL',null]},{id:'survivor-003',picks:['LAC',null,null]}];
  const config={schemaVersion:1,season:2026,week:3,label:'Survivor Week 3',sheetWeeks:18,trackedEntries:tracked,fieldEntries,competitionSize:6,currentWeekEntryCount:2,source:{kind:'survivor-upload',filename:'w3.pdf'}};
  const admin=named=>{
    const v=verifySurvivorSchedule(config,payloads(named));
    const guard=survivorPublishGuard(config,{resultsByWeek:v.resultsByWeek,currentGames:v.weeks.find(x=>x.week===3)?.games||null,published:{checked:true,rows:[]}});
    return{ok:v.ok,errors:v.errors,weeks:v.weeks.map(x=>({week:x.week,games:x.games,errors:x.errors})),guard};
  };
  const halted=admin(true),unnamed=admin(false);
  assert.equal(halted.ok,true);
  assert.deepEqual(halted,unnamed,'Admin sees a game awaiting a pool ruling exactly as a game that is not final yet');
  assert(halted.guard.reasons.some(r=>/cannot yet be proven alive or out \(an earlier result is not final yet\)/.test(r)),'the halted pickers with no Week-3 pick are reported as before');
}

console.log('survivor HDC-11 halted-game awaiting-ruling classification, ordinary-pending, HDC-10 completed-final, forfeit-boundary, recovery, projection-parity, field-count and Admin-compatibility regressions passed');


// ---- HDC-12: contest-scoped halted-game rulings. Three layers stay apart: the NFL fact (the feed), the contest policy (the
// commissioner's halted-game rule, which never changes a standing by itself) and the incident ruling (a commissioner-
// confirmed consequence for one incident, the only thing that changes a pool result). The pure evaluator
// (contest-rulings.js) validates policy history and ruling chains and answers with explicit states; survivor-math.js takes
// its Survivor overlay as an optional last argument, so the frozen Admin guard, which never passes one, is unchanged.
// Every regression below runs through one collector, so each failing one is reported; the block fails at its end if any did.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  let CR=null;
  try{CR=await import('./contest-rulings.js')}catch{CR=null}
  const evaluator=()=>{assert(CR,'nfl-pool/contest-rulings.js (the HDC-12 ruling evaluator) is missing');return CR};
  const SM=await import('./survivor-math.js');
  const {scoreEntry,tiebreakState}=await import('./public-math.js');
  const {readFileSync,existsSync}=await import('node:fs');
  const {createHash}=await import('node:crypto');

  // Fixture rows shaped like the Data API's public columns. TEST_START is a fixture value, not a real kickoff.
  const TEST_START='2026-09-01T00:00:00+00:00',WRITTEN='2026-10-08T12:00:00+00:00',PRE_START='2026-08-15T12:00:00+00:00',INITIAL='2026-08-01T00:00:00+00:00';
  const NAME={pickem:"Pool Center 2026 Pick'em",survivor:'Pool Center 2026 Survivor'},DEFAULT_POLICY={pickem:'void',survivor:'advance_team_used'};
  const cid=type=>`pool-center-2026-${type}`;
  const contestRow=(type,o={})=>({contest_id:cid(type),season:2026,contest_type:type,display_name:NAME[type],starts_at:TEST_START,created_at:WRITTEN,...o});
  const policyRow=(type,revision,effective_week,halted_game_policy,o={})=>({contest_id:cid(type),contest_type:type,revision,effective_week,halted_game_policy,public_note:null,created_at:revision===1?INITIAL:PRE_START,...o});
  // One incident chain: the consequences in order, each row naming the one before it as its predecessor.
  const chain=(type,consequences,o={},firstId=1)=>consequences.map((consequence,i)=>({ruling_id:firstId+i,contest_id:cid(type),contest_type:type,week:3,away_team:'BUF',home_team:'CIN',
    policy_revision:1,chain_seq:i+1,parent_ruling_id:i?firstId+i-1:null,consequence,incident_status:'STATUS_CANCELED',event_id:'401437947',evidence_source:'nflscores2',public_note:null,created_at:WRITTEN,...o}));
  const evaluate=(type,{contests=[contestRow(type)],policies=[policyRow(type,1,1,DEFAULT_POLICY[type])],rulings=[]}={})=>
    evaluator().evaluateContestRulings({contestId:cid(type),contestType:type,season:2026,data:{contests,policies,rulings}});
  const slot=(ds,away='BUF',home='CIN',week=3)=>evaluator().rulingForSlot(ds,{week,away,home});
  const team=(ds,t='BUF',week=3)=>evaluator().rulingForTeam(ds,{week,team:t});
  // The ESPN 2022 Week 17 BUF at CIN shape (event 401437947: STATUS_CANCELED, state post, completed:false, 0-0), in Week 3.
  const feedEvent=({away='BUF',home='CIN',id='401437947',name='STATUS_CANCELED',state='post',completed=false}={})=>({id,season:{year:2026,type:2},week:{number:3},
    status:{type:{name,state,completed}},competitions:[{status:{type:{name,state,completed}},competitors:[{homeAway:'home',team:{abbreviation:home},score:'0'},{homeAway:'away',team:{abbreviation:away},score:'0'}]}]});
  const pickemSlot=(ds,events,away='BUF',home='CIN')=>evaluator().pickemSlotRuling(ds,{week:3,season:2026,away,home,events});
  const survivorPick=(ds,events,t='BUF')=>evaluator().survivorRulingLookup(ds,{eventsByWeek:[null,null,events],season:2026}).forPick(3,t);

  // ---- policy values and consequences
  await regression('Survivor policy values: advance_team_used, eliminate and commissioner_decides; advance, advance_team_not_used and awarded rejected',()=>{
    const {validatePolicyValue,HALTED_GAME_POLICIES}=evaluator();
    assert.deepEqual([...HALTED_GAME_POLICIES.survivor],['advance_team_used','eliminate','commissioner_decides']);
    for(const v of HALTED_GAME_POLICIES.survivor)assert.equal(validatePolicyValue('survivor',v).ok,true,v);
    for(const v of ['advance','advance_team_not_used','awarded','void','reaffirm','ADVANCE_TEAM_USED','',null,undefined,1])assert.equal(validatePolicyValue('survivor',v).ok,false,`${String(v)} is not a Survivor policy`);
    for(const v of ['advance','advance_team_not_used','awarded'])assert.equal(evaluate('survivor',{policies:[policyRow('survivor',1,1,v)]}).status,'hold',`a published ${v} policy holds the contest`);
    assert.equal(evaluate('survivor').status,'ready','advance_team_used is the approved Survivor default');
  });
  await regression("Pick'em policy: void only",()=>{
    const {validatePolicyValue,HALTED_GAME_POLICIES}=evaluator();
    assert.deepEqual([...HALTED_GAME_POLICIES.pickem],['void']);
    assert.equal(validatePolicyValue('pickem','void').ok,true);
    for(const v of ['advance_team_used','eliminate','commissioner_decides','awarded','tie','loss','',null])assert.equal(validatePolicyValue('pickem',v).ok,false,`${String(v)} is not a Pick'em policy`);
    assert.equal(evaluate('pickem',{policies:[policyRow('pickem',1,1,'eliminate')]}).status,'hold');
  });
  await regression('consequences: no reaffirm, awarded or generic advance consequence; policy/consequence compatibility',()=>{
    const {RULING_CONSEQUENCES,WITHDRAWN,policyAllowsConsequence}=evaluator();
    assert.deepEqual([...RULING_CONSEQUENCES.survivor],['advance_team_used','eliminate']);
    assert.deepEqual([...RULING_CONSEQUENCES.pickem],['void']);
    assert.equal(WITHDRAWN,'withdrawn');
    const matrix=(type,policy)=>Object.fromEntries(['advance_team_used','eliminate','void','withdrawn','reaffirm','advance','awarded'].map(c=>[c,policyAllowsConsequence(type,policy,c)]));
    const none={advance_team_used:false,eliminate:false,void:false,withdrawn:false,reaffirm:false,advance:false,awarded:false};
    assert.deepEqual(matrix('survivor','advance_team_used'),{...none,advance_team_used:true});
    assert.deepEqual(matrix('survivor','eliminate'),{...none,eliminate:true});
    assert.deepEqual(matrix('survivor','commissioner_decides'),{...none,advance_team_used:true,eliminate:true});
    assert.deepEqual(matrix('pickem','void'),{...none,void:true});
  });

  // ---- policy revisions
  await regression('policy revision in force is selected by effective week; same-week pre-start revisions: the highest wins',()=>{
    const {policyForWeek}=evaluator();
    const ds=evaluate('survivor',{policies:[policyRow('survivor',1,1,'advance_team_used',{created_at:'2026-08-01T00:00:00Z'}),policyRow('survivor',2,1,'eliminate',{created_at:'2026-08-10T00:00:00Z'}),
      policyRow('survivor',3,1,'commissioner_decides',{created_at:PRE_START,public_note:'Replaced before the season'}),policyRow('survivor',4,8,'eliminate',{created_at:WRITTEN})]});
    assert.equal(ds.status,'ready');
    assert.deepEqual([1,4,7,8,12].map(w=>[policyForWeek(ds,w).revision,policyForWeek(ds,w).policy]),[[3,'commissioner_decides'],[3,'commissioner_decides'],[3,'commissioner_decides'],[4,'eliminate'],[4,'eliminate']]);
    assert.equal(policyForWeek(ds,1).publicNote,'Replaced before the season');
    assert.equal(policyForWeek(ds,8).effectiveWeek,8);
  });
  await regression('the bootstrap revision 1 written after the start is the initial policy, in force from Week 1',()=>{
    const {policyForWeek}=evaluator();
    const ds=evaluate('pickem',{policies:[policyRow('pickem',1,1,'void',{created_at:WRITTEN})]});
    assert.equal(ds.status,'ready');assert.equal(policyForWeek(ds,1).revision,1);assert.equal(policyForWeek(ds,17).revision,1);
  });
  await regression('malformed, gapped, regressive or retroactive policy history holds the whole contest',()=>{
    const p1=policyRow('survivor',1,1,'advance_team_used');
    for(const [label,policies] of [
      ['regressive effective week',[p1,policyRow('survivor',2,4,'eliminate'),policyRow('survivor',3,2,'commissioner_decides')]],
      ['a gap',[p1,policyRow('survivor',3,5,'eliminate')]],
      ['a duplicated revision',[p1,{...p1}]],
      ['revision 1 not in force from Week 1',[policyRow('survivor',1,2,'advance_team_used')]],
      ['revision 0',[policyRow('survivor',0,1,'advance_team_used')]],
      ['a non-integer revision',[policyRow('survivor','1',1,'advance_team_used')]],
      ['no effective week',[policyRow('survivor',1,null,'advance_team_used')]],
      ['an effective week out of range',[p1,policyRow('survivor',2,23,'eliminate')]],
      ['another contest',[policyRow('survivor',1,1,'advance_team_used',{contest_id:cid('pickem')})]],
      ['no policy at all',[]],
      ['a retroactive revision written after the start',[p1,policyRow('survivor',2,3,'eliminate',{created_at:WRITTEN})]],
      ['a later revision with no creation time',[p1,policyRow('survivor',2,10,'eliminate',{created_at:null})]]
    ]){
      const ds=evaluate('survivor',{policies});
      assert.deepEqual([ds.status,ds.scope],['hold','contest'],`${label}: the contest holds`);
      assert.match(ds.reason,/policy/i,`${label}: the reason names the policy history`);
      assert.deepEqual(team(ds,'BUF').state,'hold',`${label}: no slot is evaluated`);
    }
    for(const [label,contests] of [['no contest record',[]],['two contest records',[contestRow('survivor'),contestRow('survivor')]],['another contest type',[contestRow('survivor',{contest_type:'pickem'})]],
      ['another season',[contestRow('survivor',{season:2027})]],['no verified start',[contestRow('survivor',{starts_at:null})]]]){
      assert.deepEqual([evaluate('survivor',{contests}).status,evaluate('survivor',{contests}).scope],['hold','contest'],`${label}: the contest holds`);
    }
  });

  // ---- incident identity, published slots and isolation
  await regression('a ruling citing a policy revision other than the one in force holds; other incidents are unaffected',()=>{
    const policies=[policyRow('survivor',1,1,'advance_team_used'),policyRow('survivor',2,6,'eliminate')];
    const rows=[...chain('survivor',['advance_team_used']),...chain('survivor',['advance_team_used'],{week:6,away_team:'NYG',home_team:'NYJ'},10),
      ...chain('survivor',['eliminate'],{week:6,away_team:'DAL',home_team:'PHI',policy_revision:2},20),...chain('survivor',['eliminate'],{away_team:'KC',home_team:'DEN',policy_revision:2},30)];
    const ds=evaluate('survivor',{policies,rulings:rows});
    assert.equal(team(ds,'BUF').state,'effective');
    assert.equal(team(ds,'NYG',6).state,'hold');assert.match(team(ds,'NYG',6).reason,/revision 2 is in force/);
    assert.equal(team(ds,'DAL',6).state,'effective');
    assert.equal(team(ds,'KC',3).state,'hold');assert.match(team(ds,'KC',3).reason,/revision 1 is in force/);
  });
  await regression('a ruling row from another contest holds the coverage it names',()=>{
    for(const o of [{contest_id:cid('pickem')},{contest_type:'pickem'}]){
      const ds=evaluate('survivor',{rulings:[...chain('survivor',['advance_team_used'],o),...chain('survivor',['advance_team_used'],{away_team:'NYG',home_team:'NYJ'},10)]});
      assert.equal(team(ds,'BUF').state,'hold');assert.equal(team(ds,'CIN').state,'hold');
      assert.equal(team(ds,'NYG').state,'effective','an unrelated incident still applies');
    }
  });
  await regression("Pick'em: a ruling that does not match the published game holds that slot (other opponent, inverted pair); unrelated rulings change nothing",()=>{
    const other=evaluate('pickem',{rulings:chain('pickem',['void'],{away_team:'BUF',home_team:'KC'})});
    assert.equal(slot(other).state,'hold');assert.match(slot(other).reason,/does not match the published game BUF @ CIN/);
    assert.equal(slot(other,'DEN','KC').state,'hold','the other team named is held too');
    const inverted=evaluate('pickem',{rulings:chain('pickem',['void'],{away_team:'CIN',home_team:'BUF'})});
    assert.equal(slot(inverted).state,'hold','an inverted pair never matches silently');
    const unrelated=evaluate('pickem',{rulings:chain('pickem',['void'],{away_team:'NYG',home_team:'NYJ'})});
    assert.deepEqual([slot(unrelated).state,slot(unrelated,'DEN','KC').state],['none','none']);
    const exact=evaluate('pickem',{rulings:chain('pickem',['void'])});
    assert.deepEqual([slot(exact).state,slot(exact).consequence],['effective','void']);
    const alias=evaluate('pickem',{rulings:chain('pickem',['void'],{away_team:'WAS',home_team:'JAX'})});
    assert.equal(slot(alias,'WSH','JAC').state,'effective','feed aliases normalize to the same published pair');
  });
  await regression('event_id is evidence, not identity: a ruling without one applies',()=>{
    const ds=evaluate('pickem',{rulings:chain('pickem',['void'],{event_id:null,evidence_source:null})});
    assert.equal(slot(ds).state,'effective');
    const checked=pickemSlot(ds,[feedEvent()]);
    assert.deepEqual([checked.state,checked.underReview],['effective',null],'the feed still reports the canceled game');
  });
  await regression('a changed event id after a valid ruling is UNDER REVIEW, never a removed ruling (first load included)',()=>{
    const ds=evaluate('pickem',{rulings:chain('pickem',['void'])});
    const p=pickemSlot(ds,[feedEvent({id:'401999999'})]);
    assert.deepEqual([p.state,p.consequence],['effective','void']);assert.match(p.underReview,/different event/);
    const sds=evaluate('survivor',{rulings:chain('survivor',['advance_team_used'])});
    const s=survivorPick(sds,[feedEvent({id:'401999999'})]);
    assert.deepEqual([s.state,s.outcome],['effective','alive']);assert.match(s.underReview,/different event/);
  });
  await regression('a different opponent after a valid ruling is UNDER REVIEW, never a removed ruling',()=>{
    const ds=evaluate('pickem',{rulings:chain('pickem',['void'])});
    for(const events of [[feedEvent({home:'KC'})],[feedEvent({home:'KC',id:'401999999'})]]){
      const p=pickemSlot(ds,events);assert.equal(p.state,'effective');assert.match(p.underReview,/BUF @ KC/);
    }
    // Survivor publishes no matchup, so the recorded event is what ties the ruling to a game whose facts changed.
    const s=survivorPick(evaluate('survivor',{rulings:chain('survivor',['advance_team_used'])}),[feedEvent({home:'KC'})]);
    assert.equal(s.state,'effective');assert.match(s.underReview,/BUF @ KC/);
  });
  await regression("Survivor: a ruling matchup the feed contradicts, with no recorded event tying it to a changed game, holds (wrong pair, inverted pair, bye team)",()=>{
    const ds=evaluate('survivor',{rulings:chain('survivor',['advance_team_used'],{event_id:null,evidence_source:null})});
    for(const [label,events] of [['other opponent',[feedEvent({home:'KC',id:'5'})]],['inverted',[feedEvent({away:'CIN',home:'BUF',id:'5'})]],
      ['BUF on bye, CIN playing NYJ',[feedEvent({away:'NYJ',home:'CIN',id:'5'})]],['re-paired in two games',[feedEvent({home:'KC',id:'5'}),feedEvent({away:'NYJ',home:'CIN',id:'6'})]]]){
      for(const t of ['BUF','CIN']){const s=survivorPick(ds,events,t);assert.equal(s.state,'hold',`${label}: ${t} pickers hold`);assert.match(s.reason,/does not match the feed/,label)}
    }
    assert.equal(survivorPick(ds,[feedEvent({id:'5'})]).state,'effective','the matching game corroborates it');
  });
  await regression('team double coverage holds every incident involved; unrelated incidents still apply',()=>{
    const ds=evaluate('pickem',{rulings:[...chain('pickem',['void']),...chain('pickem',['void'],{away_team:'BUF',home_team:'KC',event_id:'402'},10),...chain('pickem',['void'],{away_team:'NYG',home_team:'NYJ',event_id:'403'},20)]});
    assert.equal(slot(ds).state,'hold');assert.match(slot(ds).reason,/BUF|more than one/);
    assert.equal(slot(ds,'DEN','KC').state,'hold');
    assert.equal(slot(ds,'NYG','NYJ').state,'effective');
    assert.equal(ds.incidents.filter(x=>x.doubleCoverage).length,2);
    const s=evaluate('survivor',{rulings:[...chain('survivor',['advance_team_used']),...chain('survivor',['advance_team_used'],{away_team:'KC',home_team:'BUF',event_id:'402'},10)]});
    assert.equal(team(s,'BUF').state,'hold');assert.equal(team(s,'CIN').state,'hold');assert.equal(team(s,'KC').state,'hold');
  });
  await regression('rows of one chain are one incident, never double coverage',()=>{
    const ds=evaluate('pickem',{rulings:chain('pickem',['void','void'])});
    assert.equal(ds.incidents.length,1);assert.equal(slot(ds).state,'effective');
    assert.deepEqual(ds.incidents[0].history.map(h=>h.action),['ruled','reaffirmed']);
  });
  await regression('isolation: an unattributable row holds the contest; one unknown team holds only the known team; two hold only that week',()=>{
    assert.deepEqual([evaluate('pickem',{rulings:[{...chain('pickem',['void'])[0],week:null}]}).status],['hold']);
    const one=evaluate('pickem',{rulings:[...chain('pickem',['void'],{away_team:'XYZ'}),...chain('pickem',['void'],{away_team:'NYG',home_team:'NYJ'},10)]});
    assert.deepEqual([slot(one).state,slot(one,'DEN','KC').state,slot(one,'NYG','NYJ').state],['hold','none','effective']);
    const two=evaluate('pickem',{rulings:[...chain('pickem',['void'],{away_team:'XYZ',home_team:'ABC'}),...chain('pickem',['void'],{week:4,away_team:'NYG',home_team:'NYJ'},10)]});
    assert.deepEqual([slot(two).state,slot(two,'DEN','KC').state,slot(two,'NYG','NYJ',4).state],['hold','hold','effective']);
    assert.equal(slot(two).scope,'week');
  });

  // ---- ruling chains
  await regression('chain: original advance_team_used, eliminate and void apply',()=>{
    const adv=team(evaluate('survivor',{rulings:chain('survivor',['advance_team_used'])}));
    assert.deepEqual([adv.state,adv.consequence,adv.outcome,adv.teamUsed],['effective','advance_team_used','alive',true]);
    assert.equal(team(evaluate('survivor',{rulings:chain('survivor',['advance_team_used'])}),'CIN').outcome,'alive','both sides of a canceled game advance; neither is an NFL winner');
    const elim=team(evaluate('survivor',{policies:[policyRow('survivor',1,1,'eliminate')],rulings:chain('survivor',['eliminate'])}));
    assert.deepEqual([elim.state,elim.consequence,elim.outcome],['effective','eliminate','out']);
    const v=slot(evaluate('pickem',{rulings:chain('pickem',['void'])}));
    assert.deepEqual([v.state,v.consequence],['effective','void']);
  });
  await regression('chain: reaffirm, withdraw, and re-rule after withdrawal',()=>{
    const policies=[policyRow('survivor',1,1,'commissioner_decides')];
    const reaffirmed=evaluate('survivor',{policies,rulings:chain('survivor',['advance_team_used','advance_team_used'])});
    assert.deepEqual([team(reaffirmed).state,team(reaffirmed).consequence],['effective','advance_team_used']);
    const withdrawn=evaluate('survivor',{policies,rulings:chain('survivor',['advance_team_used','withdrawn'])});
    assert.equal(team(withdrawn).state,'withdrawn','withdrawn: there is no active ruling');
    const rerule=evaluate('survivor',{policies,rulings:chain('survivor',['advance_team_used','withdrawn','eliminate'])});
    assert.deepEqual([team(rerule).state,team(rerule).consequence,team(rerule).outcome],['effective','eliminate','out']);
    assert.deepEqual(rerule.incidents[0].history.map(h=>h.action),['ruled','withdrawn','re-ruled']);
    const back=evaluate('survivor',{policies,rulings:chain('survivor',['eliminate','withdrawn','advance_team_used'])});
    assert.deepEqual([team(back).state,team(back).consequence],['effective','advance_team_used']);
    const pk=evaluate('pickem',{rulings:chain('pickem',['void','withdrawn','void'])});
    assert.deepEqual([slot(pk).state,slot(pk).consequence],['effective','void']);
  });
  await regression('chain: direct advance_team_used -> eliminate and eliminate -> advance_team_used are rejected (HOLD)',()=>{
    const policies=[policyRow('survivor',1,1,'commissioner_decides')];
    for(const seq of [['advance_team_used','eliminate'],['eliminate','advance_team_used'],['advance_team_used','advance_team_used','eliminate']]){
      const s=team(evaluate('survivor',{policies,rulings:chain('survivor',seq)}));
      assert.equal(s.state,'hold',seq.join(' -> '));assert.match(s.reason,/without a withdrawal/);
    }
  });
  await regression('chain: broken predecessor, multiple roots, cross-incident predecessor, first-row withdrawal, repeated withdrawal, gap and cycle hold',()=>{
    const base=chain('pickem',['void','withdrawn','void']);
    const cases=[
      ['broken predecessor',[base[0],{...base[1],parent_ruling_id:99},base[2]]],
      ['a predecessor that skips a row',[base[0],base[1],{...base[2],parent_ruling_id:1}]],
      ['two original rulings',[base[0],{...base[1],chain_seq:1,parent_ruling_id:null,consequence:'void'}]],
      ['a second row with no predecessor',[base[0],{...base[1],parent_ruling_id:null}]],
      ['first row withdrawn',chain('pickem',['withdrawn'])],
      ['repeated withdrawal',chain('pickem',['void','withdrawn','withdrawn'])],
      ['a gap in the chain',[base[0],{...base[2],chain_seq:3,parent_ruling_id:1}]],
      ['a self-referencing cycle',[base[0],{...base[1],parent_ruling_id:2}]],
      ['an original ruling that names a predecessor',[{...base[0],parent_ruling_id:3},base[1],base[2]]],
      ['a duplicated row identity',[base[0],{...base[1],ruling_id:1}]]
    ];
    for(const [label,rows] of cases){const s=slot(evaluate('pickem',{rulings:rows}));assert.equal(s.state,'hold',label)}
    // A predecessor from another incident holds both incidents.
    const cross=evaluate('pickem',{rulings:[...chain('pickem',['void']),...chain('pickem',['void'],{away_team:'DEN',home_team:'KC',event_id:'402'},10),
      {...chain('pickem',['withdrawn'],{away_team:'DEN',home_team:'KC',event_id:'402'},12)[0],chain_seq:2,parent_ruling_id:1}]});
    assert.deepEqual([slot(cross).state,slot(cross,'DEN','KC').state],['hold','hold']);
  });
  await regression('chain: a malformed chain is isolated to its own incident',()=>{
    const ds=evaluate('pickem',{rulings:[...chain('pickem',['void','void']).map((r,i)=>i?{...r,parent_ruling_id:42}:r),...chain('pickem',['void'],{away_team:'DEN',home_team:'KC',event_id:'402'},10)]});
    assert.equal(ds.status,'ready','one bad chain never freezes the contest');
    assert.deepEqual([slot(ds).state,slot(ds,'DEN','KC').state,slot(ds,'NYG','NYJ').state],['hold','effective','none']);
  });
  await regression('chain: consequences the cited policy does not permit hold',()=>{
    assert.equal(team(evaluate('survivor',{rulings:chain('survivor',['eliminate'])})).state,'hold','advance_team_used permits only advance_team_used');
    assert.equal(team(evaluate('survivor',{policies:[policyRow('survivor',1,1,'eliminate')],rulings:chain('survivor',['advance_team_used'])})).state,'hold','eliminate permits only eliminate');
    assert.equal(team(evaluate('survivor',{rulings:chain('survivor',['void'])})).state,'hold');
    assert.equal(slot(evaluate('pickem',{rulings:chain('pickem',['advance_team_used'])})).state,'hold');
  });
  await regression('chain: a later row naming another event (a makeup game) holds; the original evidence is kept',()=>{
    const rows=chain('pickem',['void','void']);rows[1].event_id='401999999';
    assert.equal(slot(evaluate('pickem',{rulings:rows})).state,'hold');
    const ok=evaluate('pickem',{rulings:chain('pickem',['void','void'],{}).map((r,i)=>i?{...r,event_id:null,incident_status:'STATUS_POSTPONED'}:r)});
    assert.deepEqual(ok.incidents[0].evidence,{incidentStatus:'STATUS_CANCELED',eventId:'401437947',source:'nflscores2'});
  });

  // ---- forfeit boundary
  await regression('an unsupported FORFEIT incident never receives a v1 cancellation consequence',()=>{
    for(const status of ['STATUS_FORFEIT','STATUS_FINAL_FORFEIT','STATUS_FINAL',null]){
      assert.equal(slot(evaluate('pickem',{rulings:chain('pickem',['void'],{incident_status:status})})).state,'hold',`stored ${status}: void is not applied`);
      assert.equal(team(evaluate('survivor',{rulings:chain('survivor',['advance_team_used'],{incident_status:status})})).state,'hold',`stored ${status}: advance is not applied`);
    }
    assert.match(slot(evaluate('pickem',{rulings:chain('pickem',['void'],{incident_status:'STATUS_FORFEIT'})})).reason,/forfeit/i);
    // A valid canceled-game ruling whose game the feed now reports as a forfeit holds rather than stay applied.
    for(const name of ['STATUS_FORFEIT','STATUS_FINAL_FORFEIT']){
      const event=feedEvent({name,completed:name==='STATUS_FINAL_FORFEIT'});
      assert.equal(pickemSlot(evaluate('pickem',{rulings:chain('pickem',['void'])}),[event]).state,'hold',`feed ${name}: Pick'em slot holds`);
      assert.equal(survivorPick(evaluate('survivor',{rulings:chain('survivor',['advance_team_used'])}),[event]).state,'hold',`feed ${name}: Survivor pick holds`);
    }
  });

  // ---- later NFL facts never reverse a ruling
  await regression('later final, live, scheduled or missing NFL evidence keeps the ruling applied and UNDER REVIEW',()=>{
    const ds=evaluate('pickem',{rulings:chain('pickem',['void'])}),sds=evaluate('survivor',{rulings:chain('survivor',['advance_team_used'])});
    for(const [label,events,pattern] of [['final',[feedEvent({name:'STATUS_FINAL',completed:true})],/completed final/],['live',[feedEvent({name:'STATUS_IN_PROGRESS',state:'in'})],/live/],
      ['scheduled',[feedEvent({name:'STATUS_SCHEDULED',state:'pre'})],/scheduled/],['postponed instead of canceled',[feedEvent({name:'STATUS_POSTPONED'})],/STATUS_POSTPONED/],['missing',[feedEvent({away:'NYG',home:'NYJ',id:'9'})],/no longer/]]){
      const p=pickemSlot(ds,events);assert.deepEqual([p.state,p.consequence],['effective','void'],`${label}: void stays`);assert.match(p.underReview,pattern,label);
      const s=survivorPick(sds,events);assert.deepEqual([s.state,s.outcome],['effective','alive'],`${label}: advance stays`);assert.match(s.underReview,pattern,label);
    }
    for(const [label,events] of [['unavailable',undefined],['duplicate events',[feedEvent(),feedEvent({id:'7'})]]]){
      const p=pickemSlot(ds,events);assert.deepEqual([p.state,p.underReview],['effective',null],`${label}: no usable evidence, no review`);
    }
  });

  // ---- global failure, empty set, inactive seasons
  await regression('global: an unreadable or unusable ruling store holds the contest; a valid empty ruling set is not an error',()=>{
    const {evaluateContestRulings,survivorRulingLookup}=evaluator();
    const id={contestId:cid('pickem'),contestType:'pickem',season:2026};
    for(const [label,input] of [['request failed',{error:new Error('nfl_incident_rulings 503')}],['no data',{}],['not arrays',{data:{contests:{},policies:[],rulings:[]}}]]){
      const ds=evaluateContestRulings({...id,...input});
      assert.deepEqual([ds.status,ds.scope],['hold','contest'],label);
      assert.deepEqual([slot(ds).state,slot(ds).scope],['hold','contest'],label);
      assert.equal(survivorRulingLookup(ds).status,'hold');
    }
    const empty=evaluate('pickem');
    assert.deepEqual([empty.status,slot(empty).state],['ready','none']);
    assert.equal(survivorRulingLookup(evaluate('survivor')).forPick(3,'BUF').state,'none');
    const old=evaluateContestRulings({contestId:'pool-center-2025-pickem',contestType:'pickem',season:2025,error:new Error('no store')});
    assert.deepEqual([old.status,slot(old).state],['inactive','none'],'seasons before 2026 have no contest-scoped rulings');
  });
  await regression('a refresh failure keeps the dataset already validated this session (stale); invalid new data never falls back',()=>{
    const {evaluateContestRulings}=evaluator();
    const good=evaluate('pickem',{rulings:chain('pickem',['void'])});
    const stale=evaluateContestRulings({contestId:cid('pickem'),contestType:'pickem',season:2026,error:new Error('offline'),previous:good});
    assert.deepEqual([stale.status,stale.stale,slot(stale).state],['ready',true,'effective']);
    const bad=evaluateContestRulings({contestId:cid('pickem'),contestType:'pickem',season:2026,data:{contests:[],policies:[],rulings:[]},previous:good});
    assert.equal(bad.status,'hold');
    const otherContest=evaluateContestRulings({contestId:cid('survivor'),contestType:'survivor',season:2026,error:new Error('offline'),previous:good});
    assert.equal(otherContest.status,'hold','a dataset from another contest is never reused');
  });

  // ---- Pick'em void interpretation
  await regression("Pick'em void: no win, no loss, not remaining, no tiebreak total, never an NFL tie",()=>{
    const {pickemEffectiveGame,pickemSlotEffect}=evaluator();
    const fact={away:'BUF',home:'CIN',state:'post',completed:false,winner:null,awayScore:0,homeScore:0,detail:'Canceled',eventId:'401437947'},before=structuredClone(fact);
    const v=pickemEffectiveGame(fact,pickemSlotEffect(slot(evaluate('pickem',{rulings:chain('pickem',['void'])}))));
    assert.deepEqual(fact,before,'the NFL fact is not modified');
    assert.deepEqual([v.void,v.completed,v.winner,v.awayScore,v.homeScore],[true,true,null,null,null]);
    for(const pick of ['BUF','CIN',null])assert.deepEqual(scoreEntry([pick],[v]),{w:0,l:0,left:0},`a ${pick} pick: no win, no loss, nothing remaining`);
    assert.deepEqual(tiebreakState(v),{final:false,total:null},'a void game has no tiebreak total');
    const tie={...fact,state:'post',completed:true,awayScore:20,homeScore:20,detail:'Final'};
    assert.equal(tie.void,undefined,'an NFL tie carries no void marker');
    const held=pickemEffectiveGame(fact,pickemSlotEffect({state:'hold',scope:'incident',reason:'x'}));
    assert.deepEqual([held.completed,held.hold,scoreEntry(['BUF'],[held])],[false,'x',{w:0,l:0,left:1}],'a held slot is never graded');
    assert.equal(pickemEffectiveGame(fact,pickemSlotEffect({state:'none'})),fact,'no ruling: the NFL fact itself');
    assert.equal(pickemEffectiveGame(fact,pickemSlotEffect({state:'withdrawn'})),fact,'withdrawn: the NFL fact itself');
  });

  // ---- privacy and participant-visible text
  await regression('public columns exclude created_by and admin_note; private fields never reach the evaluator output or the rules text',()=>{
    const {PUBLIC_COLUMNS,rulesModel}=evaluator();
    const expected={contests:['contest_id','season','contest_type','display_name','starts_at','created_at'],
      policies:['contest_id','contest_type','revision','effective_week','halted_game_policy','public_note','created_at'],
      rulings:['ruling_id','contest_id','contest_type','week','away_team','home_team','policy_revision','chain_seq','parent_ruling_id','consequence','incident_status','event_id','evidence_source','public_note','created_at']};
    assert.deepEqual(JSON.parse(JSON.stringify(PUBLIC_COLUMNS)),expected);
    const leak={admin_note:'PRIVATE-ADMIN-NOTE',created_by:'PRIVATE-AUTH-ID'};
    const ds=evaluate('pickem',{contests:[contestRow('pickem',leak)],policies:[policyRow('pickem',1,1,'void',{...leak,public_note:'Visible policy note'})],rulings:chain('pickem',['void'],{...leak,public_note:'Visible ruling note'})});
    const text=JSON.stringify({ds,incidents:ds.incidents,model:rulesModel(ds,{week:3})});
    assert.doesNotMatch(text,/PRIVATE-ADMIN-NOTE|PRIVATE-AUTH-ID/);
    assert.match(text,/Visible policy note/);assert.match(text,/Visible ruling note/);
  });
  await regression('Rules & rulings model: contest type, policy, revision, effective week, confirmation, rulings, history, withdrawn and review states',()=>{
    const {rulesModel,evaluateContestRulings}=evaluator();
    const ds=evaluate('survivor',{policies:[policyRow('survivor',1,1,'commissioner_decides',{public_note:'Commissioner rules each incident'})],
      rulings:[...chain('survivor',['advance_team_used','withdrawn','eliminate'],{public_note:'Ruled after the league update'}),...chain('survivor',['advance_team_used','withdrawn'],{away_team:'NYG',home_team:'NYJ',event_id:'402'},10)]});
    const m=rulesModel(ds,{week:3,slotState:x=>x.away==='BUF'?{state:'effective',underReview:'the feed now reports a completed final'}:null});
    assert.equal(m.contestType,'Survivor contest');
    assert.equal(m.contestName,'Pool Center 2026 Survivor');
    assert.deepEqual([m.policy.revision,m.policy.effectiveWeek,m.policy.name],[1,1,'Commissioner decides']);
    assert.equal(m.policy.publicNote,'Commissioner rules each incident');
    assert.match(m.confirmation,/Commissioner confirmation is required/);
    assert.match(m.confirmation,/policy alone never changes standings/);
    const buf=m.incidents.find(x=>x.matchup==='BUF @ CIN'),nyg=m.incidents.find(x=>x.matchup==='NYG @ NYJ');
    assert.equal(buf.status,'UNDER REVIEW');assert.match(buf.review,/stays applied/);
    assert.deepEqual(buf.history.map(h=>h.label),['Ruled ADVANCE','Withdrawn','Re-ruled ELIMINATE']);
    assert.equal(buf.history[0].note,'Ruled after the league update');
    assert.equal(nyg.status,'WITHDRAWN');assert.match(nyg.detail,/no active ruling/);
    assert.doesNotMatch(JSON.stringify(m),/"ruling_id"|ruling 1[0-9]? /);
    const hold=rulesModel(evaluateContestRulings({contestId:cid('survivor'),contestType:'survivor',season:2026,error:new Error('x')}),{week:3});
    assert.deepEqual([hold.state,hold.heading],['hold','ON HOLD · Ruling data unavailable']);
  });

  // ---- Survivor effect through survivor-math (a duck-typed overlay: {status, reason, forPick(week, team)})
  const lookup=(byPick,{status='ready',reason=null}={})=>({status,reason,forPick:(week,t)=>byPick[`${week}|${t}`]||{state:'none'}});
  const incident={week:2,away:'SF',home:'ARI',evidence:{incidentStatus:'STATUS_CANCELED',eventId:'402'}};
  const advance=(o={})=>({state:'effective',consequence:'advance_team_used',outcome:'alive',teamUsed:true,underReview:null,incident,...o});
  const eliminate=(o={})=>({state:'effective',consequence:'eliminate',outcome:'out',underReview:null,incident,...o});
  const both=s=>({'2|SF':s,'2|ARI':s});
  const haltedEvent=(a,h,id)=>{const e=ev(a,h,{as:'0',hs:'0',completed:false,state:'post',id});e.status.type.name='STATUS_CANCELED';e.competitions[0].status={type:{...e.status.type}};return e};
  const w1=SM.survivorBuildResults([ev('PIT','CLE',{as:'24',hs:'10'}),ev('LV','NE',{as:'20',hs:'13'}),ev('KC','LAC',{as:'27',hs:'21'}),ev('JAX','CAR',{as:'30',hs:'3'})],{season:2026,week:1});
  const w2=SM.survivorBuildResults([haltedEvent('SF','ARI','402'),ev('BUF','CIN',{as:'24',hs:'10'})],{season:2026,week:2});
  const w3=SM.survivorBuildResults([ev('DEN','KC',{as:'10',hs:'27'}),ev('NE','LV',{as:'24',hs:'10'})],{season:2026,week:3});
  const R12=[w1,w2],R123=[w1,w2,w3];
  // a and d..f picked SF (away) or ARI (home) in the canceled Week-2 game; c won with BUF.
  const E={a:{picks:['PIT','SF']},b:{picks:['LV','ARI']},c:{picks:['KC','BUF']},d:{picks:['JAX','SF','SF']},e:{picks:['PIT','SF','DEN']},f:{picks:['LV','ARI','NE']}};
  const all=Object.values(E);
  const awaiting={status:'pending',pick:'SF',week:2,reason:'Week 2 SF game halted (STATUS_CANCELED): awaiting pool ruling',type:'pending',halted:'STATUS_CANCELED'};
  await regression('Survivor preservation guard: an empty ruling set changes nothing, halted games still await a ruling',()=>{
    const none=lookup({});
    assert.deepEqual(SM.survivorEntryState(E.a,1,R12,none),awaiting);
    for(const wi of [0,1,2])for(const entry of all)assert.deepEqual(SM.survivorEntryState(entry,wi,R123,none),SM.survivorEntryState(entry,wi,R123));
    assert.deepEqual(SM.survivorSummary(all,1,R12,none),SM.survivorSummary(all,1,R12));
    assert.deepEqual(SM.survivorWeekProgress(all,2,R123,none),SM.survivorWeekProgress(all,2,R123));
  });
  await regression('Survivor advance_team_used: alive by applied commissioner ruling, team stays burned, both sides advance, no NFL winner invented',()=>{
    const L=lookup(both(advance()));
    const a=SM.survivorEntryState(E.a,1,R12,L),b=SM.survivorEntryState(E.b,1,R12,L);
    assert.deepEqual([a.status,a.type,a.ruling?.consequence],['alive','ruling','advance_team_used']);
    assert.match(a.reason,/applied commissioner ruling/);
    assert.equal(b.status,'alive','the other side of the canceled game advances too');
    assert.deepEqual([w2.get('SF').winner,w2.get('ARI').winner,w2.get('SF').completed],[null,null,false],'the NFL fact keeps no winner');
    assert.equal(SM.survivorEligibleEntering(E.a,2,R12,L),true);
    const support=SM.survivorDecisionOptions(E.a,2,R12,[{away:'SF',home:'SEA'},{away:'KC',home:'DEN',favorite:'KC',spread:3}],[],L);
    assert.equal(support.eligible,true,'next-week decision support');
    assert(support.burned.includes('SF'),'the advanced team stays burned');
    assert(!support.options.some(o=>o.team==='SF'),'the advanced team is never offered again');
    assert.deepEqual(SM.survivorFieldAvailability(all,2,R12,['SF','KC'],L),[{team:'KC',available:5,denominator:6,pct:83},{team:'SF',available:3,denominator:6,pct:50}]);
    const s=SM.survivorSummary(all,1,R12,L);assert.deepEqual([s.active,s.pending,s.eliminatedThisWeek],[6,0,0]);
  });
  await regression('Survivor advance_team_used: later weeks are evaluated, and repeating the advanced team later is a repeat elimination',()=>{
    const L=lookup(both(advance()));
    assert.deepEqual(SM.survivorEntryState(E.d,2,R123,L),{status:'out',pick:'SF',week:3,eliminatedWeek:3,reason:'Repeated SF in Week 3',type:'repeat'});
    assert.deepEqual(SM.survivorEntryState(E.e,2,R123,L),{status:'out',pick:'DEN',week:3,eliminatedWeek:3,reason:'DEN lost in Week 3',type:'loss'});
    const f=SM.survivorEntryState(E.f,2,R123,L);
    assert.deepEqual([f.status,f.type,f.reason],['alive','win','Alive through Week 3']);
    assert.deepEqual(f.rulings?.map(r=>[r.week,r.team,r.consequence]),[[2,'ARI','advance_team_used']],'the Week-2 ruling it survived through is carried');
  });
  await regression('Survivor eliminate: out in the affected week by applied commissioner ruling; later weeks never revive',()=>{
    const L=lookup(both(eliminate()));
    const a=SM.survivorEntryState(E.a,1,R12,L);
    assert.deepEqual([a.status,a.eliminatedWeek,a.type],['out',2,'ruling']);assert.match(a.reason,/applied commissioner ruling/);
    const f=SM.survivorEntryState(E.f,2,R123,L);
    assert.deepEqual([f.status,f.eliminatedWeek],['out',2],'a Week-3 win does not revive');
    const s=SM.survivorSummary(all,1,R12,L);assert.deepEqual([s.active,s.eliminatedThisWeek,s.pending],[1,5,0]);
  });
  await regression('Survivor withdrawn: an applied ruling, once withdrawn, returns to the NFL fact and HDC-11 awaiting',()=>{
    assert.equal(SM.survivorEntryState(E.a,1,R12,lookup(both(advance()))).status,'alive','first the ruling applies');
    assert.deepEqual(SM.survivorEntryState(E.a,1,R12,lookup(both({state:'withdrawn',incident}))),awaiting,'then, withdrawn, the pick awaits a ruling again');
  });
  await regression('Survivor: a later NFL final neither overrides an advance nor undoes an elimination (UNDER REVIEW carried)',()=>{
    const final2=SM.survivorBuildResults([ev('SF','ARI',{as:'10',hs:'24',id:'402'}),ev('BUF','CIN',{as:'24',hs:'10'})],{season:2026,week:2}),Rf=[w1,final2];
    const review='the feed now reports a completed final';
    const a=SM.survivorEntryState(E.a,1,Rf,lookup(both(advance({underReview:review}))));
    assert.equal(a.status,'alive','SF lost the later final, but the advance ruling stands');assert.equal(a.ruling.underReview,review);
    const b=SM.survivorEntryState(E.b,1,Rf,lookup(both(eliminate({underReview:review}))));
    assert.deepEqual([b.status,b.eliminatedWeek],['out',2],'ARI won the later final, but the elimination stands');
  });
  await regression('Survivor HOLD: isolated to the affected coverage, never alive, out or pending; global store failure holds every entry',()=>{
    assert.equal(typeof SM.survivorOnHold,'function','survivor-math exports survivorOnHold');
    const L=lookup(both({state:'hold',scope:'incident',reason:'the ruling chain changes advance_team_used to eliminate without a withdrawal'}));
    const a=SM.survivorEntryState(E.a,1,R12,L);
    assert.deepEqual([a.status,a.type,a.hold],['hold','hold','incident']);assert.match(a.reason,/on hold/i);
    assert.equal(SM.survivorEntryState(E.c,1,R12,L).status,'alive','unrelated coverage still resolves');
    assert.equal(SM.survivorOnHold(all,1,R12,L),5);
    const s=SM.survivorSummary(all,1,R12,L);assert.deepEqual([s.active,s.pending,s.eliminatedThisWeek],[1,0,0]);
    assert.equal(SM.survivorAwaitingRuling(all,1,R12,L),0,'HOLD is not awaiting a ruling');
    assert.equal(SM.survivorDecisionOptions(E.a,2,R12,[{away:'KC',home:'DEN'}],[],L).eligible,false);
    const G={status:'hold',reason:'ruling data unavailable',forPick:()=>({state:'hold',scope:'contest',reason:'ruling data unavailable'})};
    for(const entry of all)assert.equal(SM.survivorEntryState(entry,1,R12,G).status,'hold','no result is graded from the NFL feed alone');
    assert.equal(SM.survivorOnHold(all,1,R12,G),6);
    assert.deepEqual(SM.survivorEntryState({picks:[null,'SF']},1,R12,G),{status:'out',pick:null,week:1,eliminatedWeek:1,reason:'No pick in Week 1',type:'no-pick'},'a missing pick is a pick-sheet fact');
    const gs=SM.survivorSummary(all,1,R12,G);assert.deepEqual([gs.active,gs.pending,gs.eliminatedBefore,gs.eliminatedThisWeek],[0,0,0,0]);
  });

  // ---- review-driven regressions (added after the implementation's adversarial review)
  await regression('Survivor: a ruling that recorded an event stays applied and UNDER REVIEW when the feed drops that event and re-pairs the team',()=>{
    const sds=evaluate('survivor',{rulings:chain('survivor',['advance_team_used'])});
    for(const [t,events,pattern] of [['BUF',[feedEvent({home:'KC',id:'401999999',name:'STATUS_SCHEDULED',state:'pre'})],/BUF @ KC/],['CIN',[feedEvent({away:'NYJ',id:'401999998',name:'STATUS_SCHEDULED',state:'pre'})],/NYJ @ CIN/]]){
      const s=survivorPick(sds,events,t);
      assert.deepEqual([s.state,s.outcome],['effective','alive'],`${t}: the corroborated ruling still applies (conflict B, never HOLD)`);
      assert.match(s.underReview||'',pattern,t);assert.match(s.underReview||'',/401437947/,`${t}: the review names the recorded event`);
    }
    // Without a recorded event nothing ties the ruling to a changed game: the same feed holds it, and says why.
    const bare=survivorPick(evaluate('survivor',{rulings:chain('survivor',['advance_team_used'],{event_id:null,evidence_source:null})}),[feedEvent({home:'KC',id:'401999999',name:'STATUS_SCHEDULED',state:'pre'})]);
    assert.equal(bare.state,'hold');assert.match(bare.reason,/recorded no event/);
  });
  await regression('evidence comes from the first row: a later row cannot add an event the original ruling did not record',()=>{
    const rows=chain('survivor',['advance_team_used','advance_team_used'],{event_id:null,evidence_source:null});rows[1].event_id='401437947';
    const s=team(evaluate('survivor',{rulings:rows}));
    assert.equal(s.state,'hold');assert.match(s.reason,/did not record/);
    const ok=chain('survivor',['advance_team_used','advance_team_used']);ok[1].event_id=null;
    assert.equal(team(evaluate('survivor',{rulings:ok})).incident.evidence.eventId,'401437947');
  });
  await regression('a ruled team the feed also places against another opponent that week is UNDER REVIEW; the ruling stays applied',()=>{
    const repaired=[feedEvent(),feedEvent({home:'KC',id:'9',name:'STATUS_FINAL',completed:true})];
    for(const [label,o] of [['recorded event present',{}],['no recorded event',{event_id:null,evidence_source:null}]]){
      const p=pickemSlot(evaluate('pickem',{rulings:chain('pickem',['void'],o)}),repaired);
      assert.deepEqual([p.state,p.consequence],['effective','void'],`${label}: void stays`);assert.match(p.underReview||'',/also lists BUF @ KC/,`${label}: Pick'em review`);
      const s=survivorPick(evaluate('survivor',{rulings:chain('survivor',['advance_team_used'],o)}),repaired);
      assert.deepEqual([s.state,s.outcome],['effective','alive'],`${label}: advance stays`);assert.match(s.underReview||'',/also lists BUF @ KC/,`${label}: Survivor review`);
    }
    // A forfeit of the recorded incident still holds, whatever else the feed lists.
    const forfeit=[feedEvent({name:'STATUS_FORFEIT'}),feedEvent({home:'KC',id:'9'})];
    assert.equal(pickemSlot(evaluate('pickem',{rulings:chain('pickem',['void'])}),forfeit).state,'hold');
    assert.equal(survivorPick(evaluate('survivor',{rulings:chain('survivor',['advance_team_used'])}),forfeit).state,'hold');
  });
  await regression('a withdrawn mis-keyed ruling has no active ruling: it holds no published slot and never blocks the correct incident',()=>{
    const misKeyed=chain('pickem',['void','withdrawn'],{away_team:'BUF',home_team:'KC'});
    const alone=evaluate('pickem',{rulings:misKeyed});
    assert.deepEqual([slot(alone).state,slot(alone,'DEN','KC').state],['none','none'],'both published slots return to the NFL fact');
    assert.equal(slot(alone,'BUF','KC').state,'withdrawn');
    const fixed=evaluate('pickem',{rulings:[...misKeyed,...chain('pickem',['void'],{},10)]});
    assert.deepEqual([slot(fixed).state,slot(fixed).consequence],['effective','void'],'the correct incident applies');
    assert.equal(fixed.incidents.some(x=>x.doubleCoverage),false);
    const s=evaluate('survivor',{rulings:[...chain('survivor',['advance_team_used','withdrawn'],{away_team:'BUF',home_team:'KC'}),...chain('survivor',['advance_team_used'],{},10)]});
    assert.deepEqual([team(s,'BUF').state,team(s,'BUF').outcome,team(s,'KC').state],['effective','alive','withdrawn']);
    // An active mis-keyed ruling still holds (an invalid stored ruling), including one re-ruled after its withdrawal.
    assert.equal(slot(evaluate('pickem',{rulings:chain('pickem',['void','withdrawn','void'],{away_team:'BUF',home_team:'KC'})})).state,'hold');
  });
  await regression('policy revisions dated out of order hold the contest; revision 1 needs a verifiable creation time',()=>{
    const ds=evaluate('survivor',{policies:[policyRow('survivor',1,1,'advance_team_used',{created_at:WRITTEN}),policyRow('survivor',2,1,'eliminate',{created_at:PRE_START})]});
    assert.deepEqual([ds.status,ds.scope],['hold','contest']);assert.match(ds.reason,/dated before revision 1/);
    assert.equal(evaluate('survivor',{policies:[policyRow('survivor',1,1,'advance_team_used',{created_at:'not a date'})]}).status,'hold');
  });
  await regression('hostile JSON values never throw: the evaluator holds instead',()=>{
    const hostile=JSON.parse('{"toString":null}');
    let ds;
    assert.doesNotThrow(()=>{ds=evaluate('pickem',{rulings:chain('pickem',[hostile])})},'a hostile consequence');
    assert.equal(slot(ds).state,'hold');
    assert.doesNotThrow(()=>{ds=evaluate('pickem',{rulings:chain('pickem',['void'],{policy_revision:hostile})})},'a hostile policy revision');
    assert.equal(slot(ds).state,'hold');
    assert.doesNotThrow(()=>{ds=evaluate('survivor',{policies:[policyRow('survivor',1,1,hostile)]})},'a hostile policy value');
    assert.deepEqual([ds.status,ds.scope],['hold','contest']);
    assert.doesNotThrow(()=>{ds=evaluate('pickem',{rulings:[{get week(){throw new TypeError('trap')}}]})},'a row that throws when read');
    assert.deepEqual([ds.status,ds.scope],['hold','contest']);
  });
  await regression('Rules & rulings model: a withdrawn incident is WITHDRAWN even when another incident holds its team',()=>{
    const ds=evaluate('survivor',{rulings:[...chain('survivor',['advance_team_used','withdrawn']),...chain('survivor',['advance_team_used'],{away_team:'BUF',home_team:'KC',incident_status:'STATUS_FORFEIT',event_id:'402'},10)]});
    const lookup=evaluator().survivorRulingLookup(ds,{eventsByWeek:[null,null,[feedEvent()]],season:2026});
    // Built the way survivor-app.js builds it: the slot of the incident's first-named team.
    const m=evaluator().rulesModel(ds,{week:3,slotState:x=>lookup.forPick(x.week,x.away||x.home)});
    const row=matchup=>m.incidents.find(x=>x.matchup===matchup);
    assert.equal(row('BUF @ CIN').status,'WITHDRAWN');assert.match(row('BUF @ CIN').detail,/no active ruling/);
    assert.equal(row('BUF @ KC').status,'HOLD');assert.match(row('BUF @ KC').detail,/forfeit/);
    assert.equal(lookup.forPick(3,'CIN').state,'withdrawn','CIN pickers have no active ruling');
  });
  await regression('Rules & rulings model: a ruling that matches no published game is HOLD, never APPLIED',()=>{
    const m=evaluator().rulesModel(evaluate('pickem',{rulings:chain('pickem',['void'],{away_team:'NYJ',home_team:'NE'})}),{week:3,slotState:()=>({state:'none',unmatched:true})});
    assert.equal(m.incidents[0].status,'HOLD');
    assert.doesNotMatch(m.incidents[0].detail,/Applied by commissioner ruling/);assert.match(m.incidents[0].detail,/does not match a published game/);
  });

  // ---- migration contract (static). The executable behaviour of 002 and 003 is exercised against a throwaway local
  // PostgreSQL in the candidate review, never against Neon; these checks pin what the files must and must not say.
  const migration=name=>{const url=new URL(`./migrations/${name}`,import.meta.url);assert(existsSync(url),`migrations/${name} must exist`);return readFileSync(url,'utf8')};
  const statements=sql=>sql.replace(/--[^\n]*/g,'').replace(/\$\$[\s\S]*?\$\$/g,()=>'$$body$$').replace(/'(?:[^']|'')*'/g,()=>"'s'").split(';').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
  const TABLES=['nfl_contests','nfl_contest_policies','nfl_incident_rulings'];
  const PUBLIC={nfl_contests:['contest_id','season','contest_type','display_name','starts_at','created_at'],
    nfl_contest_policies:['contest_id','contest_type','revision','effective_week','halted_game_policy','public_note','created_at'],
    nfl_incident_rulings:['ruling_id','contest_id','contest_type','week','away_team','home_team','policy_revision','chain_seq','parent_ruling_id','consequence','incident_status','event_id','evidence_source','public_note','created_at']};
  await regression('migration files: 002 and 003 exist and 001 is unchanged',()=>{
    migration('002-contest-rulings.sql');migration('003-pool-center-2026-contests.sql');
    assert.equal(createHash('sha256').update(readFileSync(new URL('./migrations/001-survivor-weeks.sql',import.meta.url))).digest('hex'),'9a143b13e9e0f3ff0b5c06c1c9e813625f0500822b202a39565d7a585cbd348d','migration 001 is frozen');
  });
  await regression('migration 002: column-level SELECT on public columns only; created_by and admin_note never granted; no write grant',()=>{
    const st=statements(migration('002-contest-rulings.sql'));
    const toDataApi=s=>/\bTO\b[^;]*\b(anonymous|authenticated|PUBLIC)\b/i.test(s);
    const grants=st.filter(s=>/^GRANT\b/i.test(s)&&toDataApi(s));
    for(const table of TABLES){
      const mine=grants.filter(s=>new RegExp(`\\bON (TABLE )?public\\.${table}\\b`,'i').test(s));
      assert.equal(mine.length,1,`${table}: exactly one grant to the Data API roles`);
      const m=mine[0].match(/^GRANT SELECT \(([^)]*)\) ON public\.(\w+) TO anonymous, authenticated$/i);
      assert(m&&m[2]===table,`${table}: the grant must be a column-level SELECT to anonymous and authenticated: ${mine[0]}`);
      const cols=m[1].split(',').map(c=>c.trim());
      assert.deepEqual(cols,PUBLIC[table],`${table}: granted columns`);
      assert(!cols.includes('created_by')&&!cols.includes('admin_note'),`${table}: private columns are never granted`);
      // REVOKE ALL also clears column privileges, so it must precede the grant.
      const revoke=st.findIndex(s=>/^REVOKE ALL ON TABLE\b/i.test(s)&&s.includes(`public.${table}`)&&/FROM PUBLIC, anonymous, authenticated$/i.test(s));
      assert(revoke>=0&&revoke<st.indexOf(mine[0]),`${table}: REVOKE ALL from PUBLIC, anonymous and authenticated precedes its column grant`);
    }
    assert.equal(grants.length,TABLES.length,'no other grant reaches anonymous, authenticated or PUBLIC (no write, EXECUTE or sequence grant)');
    assert(!st.some(s=>/^GRANT\b/i.test(s)&&/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL|USAGE|EXECUTE)\b/i.test(s.split(/\bON\b/i)[0])),'no write, usage or execute privilege is granted to anyone');
    assert(st.some(s=>/^REVOKE ALL ON SEQUENCE public\.nfl_incident_rulings_ruling_id_seq FROM PUBLIC, anonymous, authenticated$/i.test(s)),'the identity sequence is revoked');
    assert(!st.some(s=>/ALTER DEFAULT PRIVILEGES/i.test(s)),'no default privileges are changed');
  });
  await regression('migration 002: RLS on every table with SELECT-only policies; no RPC; append-only triggers; public_note and admin_note distinct',()=>{
    const raw=migration('002-contest-rulings.sql'),st=statements(raw);
    for(const table of TABLES){
      assert(st.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`),`${table}: RLS enabled`);
      const policies=st.filter(s=>new RegExp(`^CREATE POLICY \\w+ ON public\\.${table}\\b`,'i').test(s));
      assert(policies.length>=1&&policies.every(s=>/ FOR SELECT TO anonymous, authenticated USING \(true\)$/i.test(s)),`${table}: SELECT-only read policies`);
      assert(st.some(s=>new RegExp(`^CREATE TRIGGER \\w+ BEFORE UPDATE OR DELETE ON public\\.${table} FOR EACH ROW EXECUTE FUNCTION public\\.nfl_contest_history_reject_change\\(\\)$`,'i').test(s)),`${table}: UPDATE and DELETE are rejected`);
      assert(st.some(s=>new RegExp(`^CREATE TRIGGER \\w+ BEFORE TRUNCATE ON public\\.${table} FOR EACH STATEMENT EXECUTE FUNCTION public\\.nfl_contest_history_reject_change\\(\\)$`,'i').test(s)),`${table}: TRUNCATE is rejected`);
    }
    assert(!st.some(s=>/^CREATE POLICY\b.*\bFOR (INSERT|UPDATE|DELETE|ALL)\b/i.test(s)),'no write policy');
    const fns=st.filter(s=>/^CREATE (OR REPLACE )?FUNCTION\b/i.test(s));
    assert(fns.length>=1&&fns.every(s=>/^CREATE FUNCTION public\.\w+\(\) RETURNS trigger\b.*\bSET search_path = pg_catalog AS \$\$body\$\$$/i.test(s)),'only trigger functions (never callable as RPC), each with a fixed search_path');
    for(const s of fns){const name=s.match(/FUNCTION (public\.\w+)\(\)/)[1];assert(st.includes(`REVOKE ALL ON FUNCTION ${name}() FROM PUBLIC, anonymous, authenticated`),`${name}: EXECUTE revoked`)}
    assert.match(raw,/CREATE FUNCTION public\.nfl_contest_history_reject_change\(\)[\s\S]*?RAISE EXCEPTION[\s\S]*?append-only/,'the append-only guard raises');
    for(const table of ['nfl_contest_policies','nfl_incident_rulings']){
      const create=st.find(s=>s.startsWith(`CREATE TABLE public.${table} (`));
      assert(/\bpublic_note text\b/.test(create)&&/\badmin_note text\b/.test(create),`${table}: public_note and admin_note are separate columns`);
    }
    const rulings=st.find(s=>s.startsWith('CREATE TABLE public.nfl_incident_rulings ('));
    assert.match(rulings,/ruling_id bigint GENERATED ALWAYS AS IDENTITY .*PRIMARY KEY/,'stable ruling row identity');
    assert.match(rulings,/UNIQUE \(contest_id, week, away_team, home_team, policy_revision, chain_seq\)/,'one row per chain position of a logical incident');
    assert.match(rulings,/parent_ruling_id bigint REFERENCES public\.nfl_incident_rulings \(ruling_id\)/,'explicit predecessor link');
    assert.match(rulings,/CHECK \(\(chain_seq = 1\) = \(parent_ruling_id IS NULL\)\)/,'one root per chain');
    assert.match(rulings,/CHECK \(chain_seq > 1 OR consequence <> 's'\)/,'a chain never starts with a withdrawal');
    assert.match(rulings,/incident_status text NOT NULL CHECK \(incident_status IN \('s','s','s'\)\)/,'three supported incident statuses');
    assert.doesNotMatch(raw.replace(/--[^\n]*/g,''),/STATUS_FORFEIT/,'forfeit is not a supported incident status');
    assert.doesNotMatch(rulings,/PRIMARY KEY \([^)]*event_id/,'event_id is never the identity');
    assert.doesNotMatch(raw,/\bINSERT INTO\b/i,'002 inserts no data');
  });
  await regression('migration 003: exactly the two 2026 contests with revision-1 policies, verified start required, no ruling, no guessed kickoff, never overwrites',()=>{
    const raw=migration('003-pool-center-2026-contests.sql'),code=raw.replace(/--[^\n]*/g,'');
    assert.doesNotMatch(raw,/\b\d{4}-\d{2}-\d{2}\b/,'no date literal anywhere, comments included');
    assert.doesNotMatch(code,/\b(now|transaction_timestamp|statement_timestamp)\s*\(|\bcurrent_timestamp\b|\blocaltimestamp\b/i,'the start is never taken from the clock');
    assert.deepEqual([...code.matchAll(/clock_timestamp\(\)/g)].length,1,'the clock is read once, to refuse a start in the future');
    assert.match(code,/IF kickoff > clock_timestamp\(\) THEN\s+RAISE EXCEPTION/);
    assert.match(code,/current_setting\('nfl_pool\.contest_start_2026', true\)/,'the verified start is an explicit session input');
    assert.match(code,/IF supplied IS NULL OR btrim\(supplied\) = '' THEN\s+RAISE EXCEPTION/,'a missing input raises');
    assert.match(code,/kickoff := supplied::timestamptz;/);
    assert.match(code,/INSERT INTO public\.nfl_contests \(contest_id, season, contest_type, display_name, starts_at\)\s+VALUES \(spec\.contest_id, 2026, spec\.contest_type, spec\.display_name, kickoff\)/,'starts_at is the verified input');
    assert.deepEqual([...new Set(code.match(/pool-center-\d{4}-[a-z]+/g))].sort(),['pool-center-2026-pickem','pool-center-2026-survivor']);
    assert.match(code,/\('pool-center-2026-pickem', 'pickem', 'Pool Center 2026 Pick''em', 'void',/);
    assert.match(code,/\('pool-center-2026-survivor', 'survivor', 'Pool Center 2026 Survivor', 'advance_team_used',/);
    assert.match(code,/INSERT INTO public\.nfl_contest_policies \(contest_id, contest_type, revision, effective_week, halted_game_policy, public_note, admin_note\)\s+VALUES \(spec\.contest_id, spec\.contest_type, 1, 1,/,'revision 1, in force from Week 1');
    assert.doesNotMatch(code,/nfl_incident_rulings/,'the bootstrap creates no incident ruling');
    assert.doesNotMatch(code,/ON CONFLICT|\bUPDATE\s+public\.|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bMERGE\b/i,'nothing is ever overwritten');
    assert.equal([...code.matchAll(/IS DISTINCT FROM/g)].length,2,'an existing contest or revision-1 row must equal the bootstrap exactly');
  });

  await regression('migration review fixes: absolute-time prospective rule, dated revisions, first-row event evidence, withdrawn incidents cover nothing, 003 compares created_by',()=>{
    const code=migration('002-contest-rulings.sql').replace(/--[^\n]*/g,'');
    assert.match(code,/\(NEW\.effective_week - 1\) \* interval '168 hours' - interval '72 hours' <= NEW\.created_at/,'the same absolute-time rule as the evaluator');
    assert.doesNotMatch(code,/interval '\d+ days?'/i,'no calendar-day interval: the rule never depends on the session time zone');
    assert.match(code,/IF NEW\.created_at < latest_created THEN/);
    assert.match(code,/r\.chain_seq = 1;\s*IF NEW\.event_id IS NOT NULL AND NEW\.event_id IS DISTINCT FROM root_event THEN/);
    assert.match(code,/IF NEW\.consequence <> 'withdrawn' AND EXISTS/);
    assert.match(code,/AND r\.consequence <> 'withdrawn'\s+AND r\.chain_seq = \(SELECT max\(l\.chain_seq\)/);
    const boot=migration('003-pool-center-2026-contests.sql').replace(/--[^\n]*/g,'');
    assert.match(boot,/existing\.starts_at, existing\.created_by\)\s+IS DISTINCT FROM \(2026, spec\.contest_type, spec\.display_name, kickoff, NULL::text\)/);
    assert.match(boot,/existing\.admin_note,\s+existing\.created_by\)\s+IS DISTINCT FROM[^;]*?, NULL::text\) THEN/);
  });
  assert.equal(failures.length,0,`HDC-12 contest-ruling regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('survivor HDC-12 contest policy, revision selection, ruling chain, published-slot, double-coverage, forfeit-boundary, conflict, fail-safe, Survivor-effect, Pick\'em-void, privacy and migration-contract regressions passed');
