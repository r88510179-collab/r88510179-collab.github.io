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
