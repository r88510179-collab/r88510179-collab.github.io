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
