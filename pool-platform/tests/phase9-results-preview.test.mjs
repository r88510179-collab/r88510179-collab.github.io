import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFinalWeek,previewPickemStandings,previewSurvivorOutcomes}
  from '../scripts/results-preview.mjs';
import {readFileSync} from 'node:fs';
const games=[
  {id:'2026_10_JAX_BAL',away:{key:'JAX'},home:{key:'BAL'}},
  {id:'2026_10_PIT_TEN',away:{key:'PIT'},home:{key:'TEN'}},
  {id:'2026_10_BUF_MIA',away:{key:'BUF'},home:{key:'MIA'}}
];
const finals={
  '2026_10_JAX_BAL':{status:'final',away_score:14,home_score:21},
  '2026_10_PIT_TEN':{status:'final',away_score:17,home_score:17},
  '2026_10_BUF_MIA':{status:'final',away_score:28,home_score:7}
};
const entry=(id,payload,source='participant')=>({
  entry_id:id,source,status:'submitted',payload
});
test('score alone does not prove an NFL result is final',()=>{
  for(const status of [undefined,'live','scheduled','halftime']){
    const r={...finals,[games[0].id]:{status,away_score:14,home_score:21}};
    assert.equal(validateFinalWeek({games,results:r}).ok,false);
  }
});
test('missing, unknown, or duplicate games fail closed',()=>{
  const missing={...finals};delete missing[games[1].id];
  assert.equal(validateFinalWeek({games,results:missing}).ok,false);
  assert.equal(validateFinalWeek({games,results:{...finals,extra:{status:'final',away_score:0,home_score:0}}}).ok,false);
  assert.equal(validateFinalWeek({games:[...games,games[0]],results:finals}).ok,false);
  assert.equal(validateFinalWeek({games:[],results:{}}).ok,false);
});
test('malformed score, negatives, non-integers and overflow fail closed',()=>{
  for(const score of [-1,201,3.5,NaN,'17',null]){
    const results={...finals,[games[0].id]:{status:'final',away_score:score,home_score:0}};
    assert.equal(validateFinalWeek({games,results}).ok,false,String(score));
  }
});
test('team duplication or unknown team identity is refused',()=>{
  assert.equal(validateFinalWeek({games:[...games,{id:'extra',away:{key:'JAX'},home:{key:'SEA'}}],results:finals}).ok,false);
  assert.equal(validateFinalWeek({games:[{id:'g',away:{key:''},home:{key:'SEA'}}],results:{g:{status:'final',away_score:1,home_score:0}}}).ok,false);
});
test('tied final returns no winner for either team',()=>{
  const x=validateFinalWeek({games,results:finals});
  assert.equal(x.ok,true);
  assert.deepEqual(x.outcomes.map(r=>r.winner),['home',null,'away']);
  assert.equal(x.outcomes[1].tie,true);
});
test('Pickem tie counts as loss whichever side is chosen',()=>{
  const r=previewPickemStandings({games,results:finals,submissions:[entry('a',{
    picks:{'2026_10_JAX_BAL':'home','2026_10_PIT_TEN':'away','2026_10_BUF_MIA':'away'}
  })]});
  assert.equal(r.ok,true);
  assert.deepEqual(r.rows,[{entry_id:'a',correct:2,incorrect:1,tiesBothLose:1,total_games:3,rank:1}]);
});
test('Pickem tied scores share rank without invented tiebreak',()=>{
  const p=x=>({picks:{'2026_10_JAX_BAL':x,'2026_10_PIT_TEN':'home','2026_10_BUF_MIA':'away'}});
  const r=previewPickemStandings({games,results:finals,submissions:[
    entry('z',p('home')),entry('a',p('home')),entry('m',p('away'))]});
  assert.equal(r.ok,true);
  assert.deepEqual(r.rows.map(x=>[x.entry_id,x.rank,x.correct]),
    [['a',1,2],['z',1,2],['m',3,1]]);
});
test('Pickem unknown, missing or malformed choices never output a partial leaderboard',()=>{
  for(const picks of [
    {'2026_10_JAX_BAL':'home'},
    {'2026_10_JAX_BAL':'home','2026_10_PIT_TEN':'away','2026_10_BUF_MIA':'away',extra:'away'},
    {'2026_10_JAX_BAL':'NO','2026_10_PIT_TEN':'away','2026_10_BUF_MIA':'away'}]){
    const r=previewPickemStandings({games,results:finals,submissions:[entry('a',{picks})]});
    assert.equal(r.ok,false);assert.deepEqual(r.rows,[]);
  }
});
test('duplicate entry and unrecognized submission source are rejected',()=>{
  const p={picks:Object.fromEntries(games.map(g=>[g.id,'away']))};
  assert.equal(previewPickemStandings({games,results:finals,submissions:[entry('a',p),entry('a',p)]}).ok,false);
  assert.equal(previewPickemStandings({games,results:finals,submissions:[entry('a',p,'unknown')]}).ok,false);
});
test('Survivor winning team advances; losing team and either tie choice are eliminated',()=>{
  const r=previewSurvivorOutcomes({games,results:finals,submissions:[
    entry('a',{team:'BAL'}),entry('b',{team:'JAX'}),
    entry('c',{team:'PIT'}),entry('d',{team:'TEN'})]});
  assert.equal(r.ok,true);
  assert.deepEqual(r.rows.map(x=>[x.entry_id,x.outcome,x.tie_elimination]),
    [['a','advanced',false],['b','eliminated',false],
     ['c','eliminated',true],['d','eliminated',true]]);
});
test('Survivor repeated pick or bye team yields no outcomes',()=>{
  const r=previewSurvivorOutcomes({games,results:finals,submissions:[
    entry('a',{team:'BAL'}),entry('b',{team:'CHI'})],
    priorTeamsByEntry:{a:['BAL']}});
  assert.equal(r.ok,false);assert.deepEqual(r.rows,[]);
});
test('Survivor requires authorized history and all final game statuses',()=>{
  const s=[entry('a',{team:'BAL'})];
  assert.equal(previewSurvivorOutcomes({games,results:finals,submissions:s,
    priorTeamsByEntry:{other:[]}}).ok,false);
  assert.equal(previewSurvivorOutcomes({games,results:finals,submissions:s,
    priorTeamsByEntry:{a:'BUF'}}).ok,false);
  assert.equal(previewSurvivorOutcomes({games,results:{
    ...finals,[games[2].id]:{status:'scheduled'}},submissions:s}).ok,false);
});
test('preview remains offline and never modifies a backend',()=>{
  const code=readFileSync(new URL('../scripts/results-preview.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(code,/\bfetch\s*\(|\bexecute\s*\(|\bUPDATE\s+public\.|\bINSERT\s+INTO\s+public\./);
});
