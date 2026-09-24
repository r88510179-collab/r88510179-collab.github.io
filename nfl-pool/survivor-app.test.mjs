// Behavioral tests for the public Survivor view (survivor-app.js) with a fake DOM and mocked Neon/NFL feeds.
// Only the module import path is rewritten; the view logic runs unmodified.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('./survivor-app.js',import.meta.url),'utf8');
const from="from './survivor-math.js?v=4';";
assert(source.includes(from),'harness expects the survivor-math import');
const patched=source.replace(from,`from '${new URL('./survivor-math.js?v=4',import.meta.url).href}';`);
let instance=0;

const W1=[['PIT','CLE'],['LV','NE'],['KC','LAC'],['JAX','CAR'],['ARI','ATL'],['BAL','BUF'],['CHI','CIN'],['DAL','DEN'],['DET','GB'],['HOU','IND'],['LAR','MIA'],['MIN','NO'],['NYG','NYJ'],['PHI','SEA'],['SF','TB'],['TEN','WAS']];
const W2=[['SF','ARI'],['ATL','BAL'],['BUF','CAR'],['CHI','CIN'],['CLE','DAL'],['DEN','DET'],['GB','HOU'],['IND','JAX'],['KC','LV'],['LAC','LAR'],['MIA','MIN'],['NE','NO'],['NYG','NYJ'],['PHI','PIT'],['SEA','TB'],['TEN','WAS']];
const W3=[['DEN','KC'],['MIA','BUF'],['PIT','CIN'],['ARI','SF'],['NE','LV'],['DAL','PHI'],['NYJ','NYG'],['DET','CHI'],['GB','MIN'],['HOU','TEN'],['IND','JAX'],['BAL','CLE'],['LAR','SEA'],['ATL','TB'],['CAR','NO'],['WAS','LAC']];
const game=(away,home,week,{as='24',hs='10',completed=true,state=completed?'post':'pre'}={})=>({id:`${week}-${away}`,week:{number:week},season:{year:2026,type:2},status:{type:{completed,state}},competitions:[{competitors:[{homeAway:'away',team:{abbreviation:away},score:as},{homeAway:'home',team:{abbreviation:home},score:hs}],odds:away==='DEN'?[{details:'KC -7.5',homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}}]:[]}]});
const week=(pairs,n,overrides={})=>({season:{year:2026,type:2},week:{number:n},events:pairs.map(([a,h])=>overrides[a]?overrides[a](a,h,n):game(a,h,n,n===3?{completed:false}:{}))});

const config={schemaVersion:1,season:2026,week:2,label:'Survivor Week 2',sheetWeeks:18,
  trackedEntries:[{id:'dc',displayName:'D.C.',picks:['PIT','SF']},{id:'djs',displayName:'DJS',picks:['LV','SF']},{id:'thaddeus',displayName:'Thaddeus',picks:['LAC',null]}],
  fieldEntries:[{id:'survivor-001',picks:['JAX','BAL']},{id:'survivor-002',picks:['CLE',null]},{id:'survivor-003',picks:['JAX',null]}],
  source:{kind:'survivor-upload',filename:'w2.pdf'}};
config.competitionSize=6;config.currentWeekEntryCount=3;

class El{constructor(){this.textContent='';this.innerHTML='';this.className='';this.value='';this.listeners={}}addEventListener(t,f){(this.listeners[t]||=[]).push(f)}}
const flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};

async function view(feeds){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El());return els.get(id)};
  const seen=[];
  globalThis.document={getElementById:$,body:{dataset:{view:'survivor'}}};
  globalThis.location={href:'https://example.test/nfl-pool/?view=survivor',search:'?view=survivor'};
  globalThis.history={state:null,replaceState(){}};
  globalThis.setInterval=()=>0;
  const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.y';
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/token/anonymous'))return{ok:true,json:async()=>({token})};
    if(u.pathname.endsWith('/nfl_survivor_weeks'))return{ok:true,json:async()=>[{season:2026,week:2,status:'locked',revision:7,config:structuredClone(config)}]};
    const w=Number(u.searchParams.get('week'));seen.push(w);
    const payload=feeds[w];if(!payload)return{ok:false,status:404,json:async()=>({})};
    return{ok:true,status:200,json:async()=>structuredClone(payload)};
  };
  await import(`data:text/javascript;base64,${Buffer.from(patched+`\n//instance ${++instance}`).toString('base64')}`);
  await flush();
  const tracked=$('svTracked').innerHTML,row=name=>tracked.split('survivor-tracked-row').find(s=>s.includes(`<b>${name}</b>`))||'';
  return{$,row,seen};
}

// Well-formed feeds: production semantics are unchanged.
{
  const v=await view({1:week(W1,1),2:week(W2,2),3:week(W3,3)});
  assert.match(v.row('D.C.'),/ALIVE/);assert.match(v.row('DJS'),/ALIVE/);
  assert.match(v.row('Thaddeus'),/OUT/);assert.match(v.row('Thaddeus'),/LAC lost in Week 1/);
  assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');
  assert.equal(v.$('svPending').textContent,0);
  assert.match(v.$('svDecisionEntries').innerHTML,/Week 3 Board/);
  assert.match(v.$('svDecisionEntries').innerHTML,/Safer favorites/);
  assert.equal(v.$('svDistribution').innerHTML.includes('Provisional'),false);
}
// A completed Week-2 event with missing scores: no tie, no elimination, board gated, feed flagged.
{
  const bad=week(W2,2,{SF:(a,h,n)=>game(a,h,n,{as:null,hs:''})});
  const v=await view({1:week(W1,1),2:bad,3:week(W3,3)});
  for(const name of ['D.C.','DJS']){assert.match(v.row(name),/PENDING/);assert.match(v.row(name),/Week 2 SF result unavailable: final score missing or invalid in feed/)}
  assert.match(v.row('Thaddeus'),/LAC lost in Week 1/);
  assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNVERIFIED');assert.match(v.$('svFeed').className,/warn/);
  assert.match(v.$('svDecisionEntries').innerHTML,/Waiting for the current week to settle/);
}
// Duplicate SF events: ambiguous, never first/last occurrence.
{
  const dup=week(W2,2);dup.events.push(game('SF','DAL',2,{as:'3',hs:'30'}));
  const v=await view({1:week(W1,1),2:dup,3:week(W3,3)});
  assert.match(v.row('D.C.'),/Week 2 SF result unavailable: team appears in more than one feed event/);
  assert.match(v.$('svDecisionEntries').innerHTML,/Waiting for the current week to settle/);
}
// Pick absent from a verified week feed is distinguishable from an unavailable feed.
{
  const absent=week(W2.filter(([a])=>a!=='SF'),2);
  const v=await view({1:week(W1,1),2:absent,3:week(W3,3)});
  assert.match(v.row('D.C.'),/SF not present in verified Week 2 feed\/schedule/);assert.match(v.row('D.C.'),/PENDING/);
  assert.equal(v.$('svFeed').textContent,'LIVE · 1 TEAM RESULT UNVERIFIED');
  const down=await view({1:week(W1,1),3:week(W3,3)});
  assert.equal(down.$('svFeed').textContent,'RESULT FEED UNAVAILABLE');
  assert.match(down.row('D.C.'),/Week 1 result unavailable|Week 2 result unavailable/);
}
// A feed answering for the wrong week is rejected rather than scored.
{
  const wrong=week(W3.map(([a,h])=>[a,h]),2);wrong.week={number:3};wrong.events.forEach(e=>{e.status.type={completed:true,state:'post'}});
  const v=await view({1:week(W1,1),2:wrong,3:week(W3,3)});
  assert.equal(v.$('svFeed').textContent,'RESULT FEED UNAVAILABLE');
  assert.match(v.row('D.C.'),/PENDING/);
}
// Unresolved earlier-week result (PIT@CLE final without scores): both sides' pickers are provisional, not eliminated.
{
  const badW1=week(W1,1,{PIT:(a,h,n)=>game(a,h,n,{as:'',hs:''})});
  const v=await view({1:badW1,2:week(W2,2),3:week(W3,3)});
  assert.match(v.row('D.C.'),/Week 1 PIT result unavailable/);
  assert.match(v.$('svDistribution').innerHTML,/Provisional · 2 entries are awaiting a verified earlier-week result/);
  assert.match(v.$('svSummaryNote').textContent,/Provisional/);
}
// Next-week schedule from the wrong context never feeds decision support.
{
  const wrongNext=week(W3,3);wrongNext.week={number:4};
  const v=await view({1:week(W1,1),2:week(W2,2),3:wrongNext});
  assert.match(v.$('svDecisionNote').textContent,/Week 3 feed context mismatch: week 4/);
  assert.match(v.$('svDecisionEntries').innerHTML,/Week-ahead schedule unavailable/);
}

console.log('survivor public view feed-context, malformed-final, duplicate, absent-team, provisional and decision-gate regressions passed');
