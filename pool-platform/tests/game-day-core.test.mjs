import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateGameDayFeed} from '../game-day-core.js';
const now=new Date('2026-11-05T22:00:30Z');
const config={games:[
  {id:'2026_9_WAS_NYG',away:{key:'WAS',label:'Washington Commanders'},home:{key:'NYG',label:'New York Giants'}},
  {id:'2026_9_BAL_JAX',away:{key:'BAL',label:'Baltimore Ravens'},home:{key:'JAX',label:'Jacksonville Jaguars'}}
]};
const event=(id,a,h,{state='in',completed=false,name='STATUS_IN_PROGRESS',
  as='7',hs='14'}={})=>({
  id,season:{year:2026,type:2},week:{number:9},
  status:{type:{state,completed,name}},
  competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:a},score:as,winner:false},
    {homeAway:'home',team:{abbreviation:h},score:hs,winner:false}],
    status:{type:{state,completed,name}}}]
});
const feed=(events=[event('id1','WSH','NYG'),event('id2','BAL','JAX')])=>({
  season:2026,week:9,source:'espn_scoreboard_unofficial',fetched_at:'2026-11-05T22:00:00Z',events
});
const examine=(f=feed(),overrides={})=>validateGameDayFeed({season:2026,week:9,config,feed:f,now,...overrides});
test('matches only authorized configured games and canonicalizes Washington alias',()=>{
  const r=examine();
  assert.equal(r.ok,true);
  assert.equal(r.rows.length,2);
  assert.equal(r.rows[0].away,'Washington Commanders');
  assert.equal(r.rows[0].status,'live');
  assert.equal(r.rows[0].awayScore,7);
  assert.equal(r.rows[0].homeScore,14);
  assert.equal(r.ageSeconds,30);
});
test('final-only evidence must be complete; a tied final is labeled but not graded',()=>{
  const f=feed([event('id1','WSH','NYG',{state:'post',completed:true,name:'STATUS_FINAL',as:'17',hs:'17'}),
    event('id2','BAL','JAX',{state:'post',completed:true,name:'STATUS_FINAL',as:'14',hs:'21'})]);
  const r=examine(f);
  assert.equal(r.ok,true);
  assert.deepEqual(r.rows.map(x=>[x.status,x.label]),[['final','FINAL TIE'],['final','FINAL']]);
  const altered=structuredClone(f);altered.events[0].competitions[0].status.type.name='STATUS_SUSPENDED';
  assert.equal(examine(altered).ok,false);
});
test('upcoming games never display a fabricated score',()=>{
  const x=event('id1','WSH','NYG',{state:'pre',completed:false,name:'STATUS_SCHEDULED',as:null,hs:null});
  const y=event('id2','BAL','JAX',{state:'pre',completed:false,name:'STATUS_SCHEDULED',as:'0',hs:'0'});
  const r=examine(feed([x,y]));
  assert.equal(r.ok,true);
  assert.deepEqual(r.rows.map(x=>[x.label,x.awayScore,x.homeScore]),[
    ['SCHEDULED',null,null],['SCHEDULED',null,null]]);
});
test('unknown source, wrong season/week and stale or future response cannot attach to a pool',()=>{
  for(const f of [{...feed(),source:'wrong'}, {...feed(),week:8},
    {...feed(),season:2027},{...feed(),fetched_at:'2026-11-05T21:00:00Z'},
    {...feed(),fetched_at:'2026-11-05T22:12:00Z'}])
    assert.equal(examine(f).ok,false);
});
test('duplicate provider events or missing verified matchup cause entire rejection',()=>{
  for(const events of [[event('id1','WSH','NYG')],[
    event('id1','WSH','NYG'),event('id1','BAL','JAX')],[
    event('id1','WSH','NYG'),event('id2','WSH','NYG')],[
    event('id1','NYG','WSH'),event('id2','BAL','JAX')]]){
    const r=examine(feed(events));assert.equal(r.ok,false);assert.deepEqual(r.rows,[]);
  }
});
test('status contradiction or missing in-progress score never overwrite last good',()=>{
  for(const r of [
    event('id1','WSH','NYG',{state:'post',completed:false,name:'STATUS_FINAL'}),
    event('id1','WSH','NYG',{state:'post',completed:true,name:'STATUS_FINAL',as:'bad'}),
    event('id1','WSH','NYG',{state:'in',completed:false,as:null}),
    event('id1','WSH','NYG',{state:'pre',completed:false,as:'14',hs:'0'}),
    event('id1','WSH','NYG',{state:'in',completed:false,name:'STATUS_SUSPENDED',as:'7',hs:'14'})
  ])assert.equal(examine(feed([r,event('id2','BAL','JAX')])).ok,false);
});
test('a separate pool cannot import a matchup outside its week',()=>{
  const x=structuredClone(config);
  x.games[1]={...x.games[1],home:{key:'MIA',label:'Miami Dolphins'}};
  assert.equal(examine(feed(),{config:x}).ok,false);
});
test('missing authenticated context never displays another pool scoreboard',()=>{
  assert.equal(examine(feed(),{config:null}).ok,false);
  assert.equal(examine(feed(),{season:undefined}).ok,false);
  assert.equal(examine(feed(),{week:undefined}).ok,false);
});
test('browser board never mutates entry/pool data or calls submission endpoints',()=>{
  const src=readFileSync(new URL('../game-day-board.js',import.meta.url),'utf8');
  assert.doesNotMatch(src,/submitEntry|createInvite|applyVerifiedSchedule|\bPOST\b|PUT|\bDELETE\b|auth\.getSession/);
  assert.match(src,/function hide\(/); // its own lifecycle has a hide path
  assert.match(src,/score_feed_not_enabled/);
  assert.match(src,/last\.rows/);
});
