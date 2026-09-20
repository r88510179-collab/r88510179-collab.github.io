import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {competitionRanks,ownershipShare,scoreEntry,tiebreakState} from './public-math.js';

{
  const ranked=competitionRanks([
    {id:'a',w:0,l:0,diff:null,_order:0},
    {id:'b',w:0,l:0,diff:null,_order:1},
    {id:'c',w:0,l:1,diff:null,_order:2}
  ],{tiebreakFinal:false});
  assert.deepEqual(ranked.map(x=>x.rank),[1,1,3]);
}
{
  const ranked=competitionRanks([
    {id:'tracked',w:3,l:1,diff:null,_order:0},
    {id:'anon',w:3,l:1,diff:null,_order:1},
    {id:'other',w:2,l:2,diff:null,_order:2}
  ],{tiebreakFinal:false});
  assert.equal(ranked.find(x=>x.id==='tracked').rank,1);
  assert.equal(ranked.find(x=>x.id==='anon').rank,1);
  assert.equal(ranked.find(x=>x.id==='other').rank,3);
}
{
  const ranked=competitionRanks([
    {id:'a',w:10,l:4,diff:8,_order:0},
    {id:'b',w:10,l:4,diff:2,_order:1},
    {id:'c',w:10,l:4,diff:2,_order:2}
  ],{tiebreakFinal:true});
  assert.equal(ranked[0].id,'b');
  assert.equal(ranked[0].rank,1);
  assert.equal(ranked[1].rank,1);
  assert.equal(ranked[2].rank,3);
}
{
  const entries=[
    {picks:['A']},{picks:['B']},{picks:['A']},{picks:[null]}
  ];
  const a=ownershipShare(entries,0,'A',['A','B']),b=ownershipShare(entries,0,'B',['A','B']);
  assert.deepEqual(a,{count:2,denominator:3,total:3,pct:67});
  assert.deepEqual(b,{count:1,denominator:3,total:3,pct:33});
  assert.equal(a.pct+b.pct,100);
}
{
  const tied=scoreEntry(['A','B'],[
    {completed:true,winner:null},
    {completed:false,winner:null}
  ]);
  assert.deepEqual(tied,{w:0,l:0,left:1});
}
{
  assert.deepEqual(tiebreakState({completed:false,state:'pre',awayScore:null,homeScore:null}),{final:false,total:null});
  assert.deepEqual(tiebreakState({completed:false,state:'in',awayScore:'14',homeScore:'10'}),{final:false,total:24});
  assert.deepEqual(tiebreakState({completed:true,state:'post',awayScore:'21',homeScore:'17'}),{final:true,total:38});
}

{
  const source=readFileSync(new URL('./weekly-app.js',import.meta.url),'utf8');
  assert(source.includes("CFG?.fullFieldReady===true"));
  assert(source.includes('WIN CEILING'));
  assert(source.includes('unresolved tiebreak not projected'));
  assert(!source.includes("'best possible'"));
  const scenarioStart=source.indexOf('function swingIndexes');
  const scenarioEnd=source.indexOf('function renderRace',scenarioStart);
  assert(scenarioStart>=0&&scenarioEnd>scenarioStart,'tracked scenario/race block must be identifiable');
  const scenarioBlock=source.slice(scenarioStart,scenarioEnd);
  assert.match(scenarioBlock,/\bP\.(?:map|forEach)\b/,'scenario engine must operate on tracked P entries');
  assert.doesNotMatch(scenarioBlock,/\bF\b|allCompetitionEntries\s*\(|rankCompetition\s*\(|fieldSnapshot\s*\(/,'anonymous full-field entries must not enter the tracked scenario/race engine');
}

console.log('public competition rank, tiebreak, ownership denominator, tracked scenario scope, and ceiling wording regressions passed');
