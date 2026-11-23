import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptPersonalScoreFeed} from '../server/personal-score-compat.mjs';
import {validateGameDayFeed} from '../game-day-core.js';

const now=new Date('2026-11-11T18:00:30Z');
const verifiedGames=[
  {away:'WAS',home:'NYG',kickoffAt:'2026-11-12T01:15:00Z',providerId:'401'},
  {away:'BAL',home:'JAX',kickoffAt:'2026-11-11T19:00:00Z',providerId:'402'}
];
const event=(id,away,home,{state='in',completed=false,name='STATUS_IN_PROGRESS',
  aScore='7',hScore='14',date='2026-11-12T01:15:00Z'}={})=>({
  id,date,status:{type:{state,completed,name}},competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:away},score:aScore,winner:false},
    {homeAway:'home',team:{abbreviation:home},score:hScore,winner:false}
  ],status:{type:{state,completed,name}}}]
});
const good=()=>({fetchedAt:'2026-11-11T18:00:00Z',events:[
  event('401','WSH','NYG'),event('402','BAL','JAX',{state:'post',completed:true,
    name:'STATUS_FINAL',aScore:'21',hScore:'17',date:'2026-11-11T19:00:00Z'})
]});
const adapt=(raw=good(),options={})=>adaptPersonalScoreFeed(raw,{
  season:2026,week:10,verifiedGames,now,...options
});

test('reuses nflscores2 projection with independently verified game identities',()=>{
  const result=adapt();
  assert.equal(result.ok,true);
  assert.equal(result.feed.source,'espn_scoreboard_unofficial');
  assert.equal(result.feed.events.length,2);
  assert.deepEqual(result.feed.events[0].season,{year:2026,type:2});
  assert.deepEqual(result.feed.events[0].week,{number:10});
  assert.equal(result.feed.events[0].competitions[0].competitors[0].team.abbreviation,'WAS');
  assert.equal(result.feed.events[1].status.type.completed,true);
});
test('accepts native nflverse verified_schedule_catalog game objects',()=>{
  const native=verifiedGames.map(g=>({
    id:'2026_10_'+g.away+'_'+g.home,
    away:{key:g.away},home:{key:g.home},
    kickoff:g.kickoffAt
  }));
  const result=adapt(good(),{verifiedGames:native});
  assert.equal(result.ok,true,result.reason);
  assert.equal(result.feed.events.length,2);
});
test('converted result passes the existing Expanded Pool score validator',()=>{
  const converted=adapt();
  assert.equal(converted.ok,true);
  const config={games:[
    {id:'2026_10_WAS_NYG',away:{key:'WAS',label:'Washington Commanders'},
      home:{key:'NYG',label:'New York Giants'}},
    {id:'2026_10_BAL_JAX',away:{key:'BAL',label:'Baltimore Ravens'},
      home:{key:'JAX',label:'Jacksonville Jaguars'}}
  ]};
  const checked=validateGameDayFeed({season:2026,week:10,config,feed:converted.feed,now});
  assert.equal(checked.ok,true,checked.reason);
  assert.deepEqual(checked.rows.map(x=>x.status),['live','final']);
});
test('only public score facts survive: no odds, entries or upstream metadata',()=>{
  const data=good();data.events[0].private_key='secret';
  data.events[0].competitions[0].odds=[{details:'-110'}];
  const output=JSON.stringify(adapt(data).feed);
  assert.doesNotMatch(output,/secret|private_key|odds|-110|entry_id|tenant_id/);
});
test('rejects missing, unmatched and duplicate games or unverified schedules',()=>{
  const a=good();a.events.pop();assert.equal(adapt(a).ok,false);
  const b=good();b.events[0].competitions[0].competitors[0].team.abbreviation='MIA';
  assert.equal(adapt(b).ok,false);
  const c=good();c.events[1].id='401';assert.equal(adapt(c).ok,false);
  const d=good();d.events[0].date='2026-10-15T01:15:00Z';assert.equal(adapt(d).ok,false);
  assert.equal(adapt(good(),{verifiedGames:[verifiedGames[0],verifiedGames[0]]}).ok,false);
  assert.equal(adapt(good(),{verifiedGames:verifiedGames.map(g=>({
    away:g.away,home:g.home}))}).ok,false);
});
test('refuses contradictory context, malformed scores and false finality',()=>{
  const a=good();a.events[0].week={number:9};assert.equal(adapt(a).ok,false);
  const b=good();b.events[1].status.type.name='STATUS_IN_PROGRESS';
  assert.equal(adapt(b).ok,false);
  const c=good();c.events[1].competitions[0].competitors[0].score='bad';
  assert.equal(adapt(c).ok,false);
  const d=good();d.events[1].competitions[0].competitors[1].winner=true;
  assert.equal(adapt(d).ok,false);
});
test('rejects timestamps beyond the freshness boundary',()=>{
  const a=good();a.fetchedAt='2026-11-11T17:45:00Z';assert.equal(adapt(a).ok,false);
  const b=good();b.fetchedAt='2026-11-11T18:03:00Z';assert.equal(adapt(b).ok,false);
});
