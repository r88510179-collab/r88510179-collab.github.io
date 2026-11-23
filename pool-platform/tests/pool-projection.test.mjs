import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectPoolStandings} from '../pool-projection.js';

const config={games:[
  {id:'2026_9_BAL_JAX',away:{key:'BAL',label:'Ravens'},home:{key:'JAX',label:'Jaguars'}},
  {id:'2026_9_BUF_MIA',away:{key:'BUF',label:'Bills'},home:{key:'MIA',label:'Dolphins'}},
  {id:'2026_9_DAL_NYG',away:{key:'DAL',label:'Cowboys'},home:{key:'NYG',label:'Giants'}}
]};
const row=(entry_id,picks,other={})=>({
  entry_id,entry_code:entry_id,display_name:entry_id,
  entry_status:'active',
  submission:picks===null?null:{
    status:'submitted',source:'participant',
    payload:{picks},...other
  }
});
const snap=(entries,pool_type='pickem')=>({
  pool_id:'pool-alpha',season:2026,week:9,week_id:'week-nine',
  pool_type,visibility:'after_deadline',entries
});
const fact=(id,status,awayScore,homeScore)=>({
  id,status,awayScore,homeScore
});
const facts={rows:[
  fact('2026_9_BAL_JAX','final',14,7),
  fact('2026_9_BUF_MIA','final',17,17),
  fact('2026_9_DAL_NYG','live',7,21)
]};
const picks=(a,b,c)=>Object.fromEntries(config.games.map((g,i)=>[g.id,[a,b,c][i]]));
const call=(snapshot,scoreFacts=facts,patch={})=>projectPoolStandings({
  snapshot,scoreFacts,config,poolId:'pool-alpha',season:2026,week:9,...patch
});
test('standings are sealed before deadline, including entry names and other picks',()=>{
  const s={...snap([row('a',picks('away','home','home'))]),visibility:'sealed',entries:[]};
  const r=call(s);
  assert.equal(r.ok,true);assert.equal(r.reason,'deadline_not_passed');
  assert.deepEqual(r.rows,[]);
});
test('pool identity, season, week and participant tenant are never inferred from feed',()=>{
  for(const patch of [{poolId:'pool-beta'},{season:2025},{week:10}]){
    const r=call(snap([row('a',picks('away','home','home'))]),facts,patch);
    assert.equal(r.ok,false,JSON.stringify(patch));assert.deepEqual(r.rows,[]);
  }
  assert.equal(call({...snap([]),pool_id:'pool-beta'}).ok,false);
});
test('missing score source cannot display fabricated scores or ranks',()=>{
  const r=call(snap([row('a',picks('away','home','home')),row('b',null)]),null);
  assert.equal(r.ok,true);assert.equal(r.reason,'scores_unavailable');
  assert.equal(r.rows.length,2);
  assert.deepEqual(r.rows.map(x=>x.rank),[null,null]);
  assert.ok(r.rows.every(x=>x.label==='Waiting for NFL scores'));
});
test('Pickem only awards final confirmed wins and provisional leads, ties lose both sides',()=>{
  const r=call(snap([
    row('entry-a',picks('away','away','away')),
    row('entry-b',picks('home','home','home')),
    row('entry-c',picks('away','home','home')),
    row('entry-d',null)
  ]));
  assert.equal(r.ok,true);assert.equal(r.unofficial,true);
  assert.equal(r.reason,'unofficial_projection');assert.equal(r.completed,2);
  assert.deepEqual(r.rows.map(x=>[x.entry_id,x.rank,x.projected]),[
    ['entry-c',1,2],['entry-a',2,1],['entry-b',2,1],['entry-d',null,0]]);
  const a=r.rows.find(x=>x.entry_id==='entry-a');
  assert.deepEqual([a.confirmed,a.provisional,a.losses,a.tiedGames],[1,0,1,1]);
  const b=r.rows.find(x=>x.entry_id==='entry-b');
  assert.deepEqual([b.confirmed,b.provisional,b.losses,b.tiedGames],[0,1,2,1]);
});
test('in-progress ties do not score a side or count as a final loss',()=>{
  const f={rows:[...facts.rows.slice(0,2),fact(config.games[2].id,'live',7,7)]};
  const r=call(snap([row('a',picks('away','away','home'))]),f);
  assert.equal(r.ok,true);
  assert.equal(r.rows[0].provisional,0);
  assert.equal(r.rows[0].pending,1);
  assert.equal(r.rows[0].tiedGames,1);
});
test('rank ties share competition rank without invented tiebreak policy',()=>{
  const r=call(snap([
    row('a',picks('away','away','away')),
    row('b',picks('away','home','away')),
    row('c',picks('home','home','away'))
  ]));
  assert.equal(r.ok,true);
  assert.deepEqual(r.rows.map(x=>x.rank),[1,1,3]);
});
test('even every provider FINAL does not produce official standings',()=>{
  const f={rows:[...facts.rows.slice(0,2),fact(config.games[2].id,'final',7,21)]};
  const r=call(snap([row('a',picks('away','home','home'))]),f);
  assert.equal(r.ok,true);assert.equal(r.completed,3);
  assert.equal(r.unofficial,true);
});
test('duplicate entries or missing game facts refuse all projected results',()=>{
  const x=row('a',picks('away','away','away'));
  assert.equal(call(snap([x,x])).ok,false);
  for(const f of [{rows:facts.rows.slice(0,2)},{rows:[...facts.rows,facts.rows[0]]},
    {rows:[...facts.rows.slice(0,2),{...facts.rows[2],id:'other'}]}]){
    const r=call(snap([x]),f);
    assert.equal(r.ok,false);assert.deepEqual(r.rows,[]);
  }
});
test('malformed or extra pick does not silently award points',()=>{
  for(const choice of [undefined,{...picks('away','away','away'),extra:'away'},
    {...picks('away','away','away'),[config.games[0].id]:'bogus'}]){
    const r=call(snap([row('bad',choice)]));
    assert.equal(r.ok,false,JSON.stringify(choice));assert.deepEqual(r.rows,[]);
  }
});
test('Survivor advance/eliminate and tie-as-elimination are provisional only',()=>{
  const s=snap([
    row('a',undefined,{payload:{team:'BAL'}}),
    row('b',undefined,{payload:{team:'JAX'}}),
    row('c',undefined,{payload:{team:'BUF'}}),
    row('d',undefined,{payload:{team:'MIA'}}),
    row('e',undefined,{payload:{team:'NYG'}}),
  ],'survivor');
  const r=call(s);
  assert.equal(r.ok,true);assert.equal(r.unofficial,true);
  assert.deepEqual(r.rows.map(x=>x.label),[
    'Advanced','Eliminated','Eliminated (tie)','Eliminated (tie)','Leading — provisional']);
});
test('Survivor trailing side is NOT eliminated before final',()=>{
  const s=snap([row('a',undefined,{payload:{team:'DAL'}})],'survivor');
  const r=call(s);
  assert.equal(r.ok,true);assert.equal(r.rows[0].label,'Trailing — not final');
});
test('Survivor selections must match exact verified week games',()=>{
  const s=snap([row('a',undefined,{payload:{team:'SEA'}})],'survivor');
  const r=call(s);
  assert.equal(r.ok,false);assert.deepEqual(r.rows,[]);
});
test('projection contains no network, DB, auth, submission write or official publisher',()=>{
  const s=readFileSync(new URL('../pool-projection.js',import.meta.url),'utf8');
  assert.doesNotMatch(s,/\bfetch\s*\(|process\.env|\bINSERT\b|\bUPDATE\s+public\.|\bpublishOfficial\b/);
});
