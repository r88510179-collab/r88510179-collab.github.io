// Behavioral tests for the public Survivor view (survivor-app.js) with a fake DOM and mocked Neon/NFL feeds.
// Only the module import path is rewritten; the view logic runs unmodified.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectScoreboard} from './score-proxy/index.mjs';

const source=readFileSync(new URL('./survivor-app.js',import.meta.url),'utf8');
// The view's survivor-math import at the version it pins; the exact version is checked at the end of this file.
const from=source.match(/from '\.\/survivor-math\.js\?v=\d+';/)?.[0];
assert(from,'harness expects the survivor-math import');
const mathHref=new URL(from.slice("from '".length,-"';".length),import.meta.url).href,patched=source.replace(from,`from '${mathHref}';`);
let instance=0;
// Fast timers: the view's 15 s score-feed time limit elapses in 5 ms here; short timers are unchanged.
// The long delays requested are recorded so the real time limit can be checked against the real refresh interval.
const realSetTimeout=globalThis.setTimeout,longTimeouts=[];globalThis.setTimeout=(fn,ms,...a)=>{if(ms>=10000)longTimeouts.push(ms);return realSetTimeout(fn,ms>=10000?5:ms,...a)};

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

async function view(feeds,rowsOverride=null,app=patched){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El());return els.get(id)},docListeners={};
  const seen=[],signals=[],doc={getElementById:$,body:{dataset:{view:'survivor'}},visibilityState:'hidden',addEventListener(t,f){(docListeners[t]||=[]).push(f)}};
  globalThis.document=doc;
  globalThis.location={href:'https://example.test/nfl-pool/?view=survivor',search:'?view=survivor'};
  globalThis.history={state:null,replaceState(){}};
  let tick=null;const intervals=[];globalThis.setInterval=(fn,ms)=>{tick=fn;intervals.push(ms);return 0};
  const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.y';
  const defaultRows=[{season:2026,week:2,status:'locked',revision:7,config:structuredClone(config)}],rowsData=rowsOverride||defaultRows;
  globalThis.fetch=async (url,init={})=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/token/anonymous'))return{ok:true,json:async()=>({token})};
    if(u.pathname.endsWith('/nfl_survivor_weeks'))return{ok:true,json:async()=>structuredClone(rowsData)};
    const w=Number(u.searchParams.get('week'));seen.push(w);if(init.signal)signals.push({week:w,signal:init.signal});
    const payload=feeds[w];
    if(typeof payload==='function')return payload({week:w,signal:init.signal});
    if(payload==='hang')return new Promise((resolve,reject)=>{if(init.signal)init.signal.addEventListener('abort',()=>{const e=new Error('Aborted');e.name='AbortError';reject(e)},{once:true})});
    if(!payload)return{ok:false,status:404,json:async()=>({})};
    return{ok:true,status:200,json:async()=>structuredClone(payload)};
  };
  await import(`data:text/javascript;base64,${Buffer.from(app+`\n//instance ${++instance}`).toString('base64')}`);
  await flush();
  const row=name=>$('svTracked').innerHTML.split('survivor-tracked-row').find(s=>s.includes(`<b>${name}</b>`))||'';
  return{
    $,row,seen,feeds,signals,intervals,
    refresh:async()=>{seen.length=0;tick();await flush()},
    resume:async()=>{seen.length=0;doc.visibilityState='visible';for(const fn of docListeners.visibilitychange||[])fn();await flush()}
  };
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
  assert.equal(v.$('svFeed').textContent,'LIVE · 1 TEAM RESULT UNVERIFIED');assert.match(v.$('svFeed').className,/warn/);
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
// An unpicked earlier-week game that never settles (canceled) is not a warning and never blocks the current week:
// a failed refresh of that earlier week keeps its verified results while the current week keeps updating.
{
  const canceled=week(W1,1,{BAL:(a,h,n)=>{const g=game(a,h,n);g.status.type.name='STATUS_CANCELED';return g}});
  const live=week(W2,2,{SF:(a,h,n)=>game(a,h,n,{completed:false,state:'in'})});
  const v=await view({1:canceled,2:live,3:week(W3,3)});
  assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');assert.match(v.row('D.C.'),/LIVE/);
  delete v.feeds[1];v.feeds[2]=week(W2,2);
  await v.refresh();
  assert.deepEqual(v.seen.filter(w=>w<=2),[2],'settled earlier week (every picked team final) is not refetched');
  assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');assert.match(v.row('D.C.'),/ALIVE/);
  // Earlier week with an unresolved picked team keeps being refreshed; its failure alone does not blank the current week.
  const badPick=week(W1,1,{PIT:(a,h,n)=>game(a,h,n,{as:null,hs:null})});
  const v2=await view({1:badPick,2:week(W2,2),3:week(W3,3)});
  assert.match(v2.row('D.C.'),/Week 1 PIT result unavailable/);
  delete v2.feeds[1];await v2.refresh();
  assert.deepEqual(v2.seen.filter(w=>w<=2).sort(),[1,2]);
  assert.equal(v2.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNVERIFIED');assert.match(v2.row('DJS'),/ALIVE/);
}
// The score-feed time limit actually used must stay below the refresh interval actually scheduled.
{
  longTimeouts.length=0;
  const v=await view({1:week(W1,1),2:week(W2,2),3:week(W3,3)});
  assert.deepEqual(v.intervals,[20000],'exactly one refresh interval, 20 s');
  assert(longTimeouts.length>0,'score requests are time-limited');
  assert(Math.max(...longTimeouts)<v.intervals[0],`score-feed time limit ${Math.max(...longTimeouts)} ms must be below the ${v.intervals[0]} ms refresh interval`);
  assert.match(v.row('D.C.'),/ALIVE/);
}
// A hung refresh of an unsettled earlier week times out on its own: its cached results stay, and the current week
// still updates (a hung current week is reported as unavailable instead of silently stale).
{
  const badPick=week(W1,1,{PIT:(a,h,n)=>game(a,h,n,{as:null,hs:null})});
  const v=await view({1:badPick,2:week(W2,2,{SF:(a,h,n)=>game(a,h,n,{completed:false,state:'in'})}),3:week(W3,3)});
  assert.match(v.row('DJS'),/LIVE/);
  v.feeds[1]='hang';v.feeds[2]=week(W2,2);
  await v.refresh();await new Promise(r=>realSetTimeout(r,40));await flush();
  assert.match(v.row('DJS'),/ALIVE/,'current week applied despite the hung earlier week');
  assert.match(v.row('D.C.'),/Week 1 PIT result unavailable/,'cached earlier-week result kept');
  assert.match(v.$('svFeed').textContent,/^LIVE/);
  v.feeds[2]='hang';
  await v.refresh();await new Promise(r=>realSetTimeout(r,40));await flush();
  assert.equal(v.$('svFeed').textContent,'RESULT FEED UNAVAILABLE');
}
// Next-week schedule from the wrong context never feeds decision support.
{
  const wrongNext=week(W3,3);wrongNext.week={number:4};
  const v=await view({1:week(W1,1),2:week(W2,2),3:wrongNext});
  assert.match(v.$('svDecisionNote').textContent,/Week 3 feed context mismatch: week 4/);
  assert.match(v.$('svDecisionEntries').innerHTML,/Week-ahead schedule unavailable/);
}

// A score-feed timeout aborts the underlying request rather than only abandoning its wrapper.
{
  const v=await view({1:week(W1,1),2:'hang',3:week(W3,3)});
  await new Promise(r=>realSetTimeout(r,40));await flush();
  const current=v.signals.find(x=>x.week===2)?.signal;
  assert(current,'current-week score request must carry an AbortSignal');
  assert.equal(current.aborted,true,'timed-out current-week request must be aborted');
  assert.equal(v.$('svFeed').textContent,'RESULT FEED UNAVAILABLE');
}
// A newer schedule refresh cancels the older same-config request and produces the board from the newer response.
{
  const v=await view({1:week(W1,1),2:week(W2,2),3:'hang'});
  await new Promise(r=>realSetTimeout(r,20));await flush();
  const firstSchedule=v.signals.find(x=>x.week===3)?.signal;
  assert(firstSchedule,'initial Week-3 schedule request should exist');
  v.feeds[3]=week(W3,3);
  await v.refresh();await new Promise(r=>realSetTimeout(r,20));await flush();
  assert.equal(firstSchedule.aborted,true,'superseded schedule request must be aborted');
  assert.match(v.$('svDecisionEntries').innerHTML,/Week 3 Board/);
}
// Invalid selected-week configuration never leaves the selector pointing at data from another week.
{
  const bad=structuredClone(config);bad.week=3;
  const rowsData=[
    {season:2026,week:3,status:'locked',revision:8,config:bad},
    {season:2026,week:2,status:'locked',revision:7,config:structuredClone(config)}
  ];
  const v=await view({1:week(W1,1),2:week(W2,2),3:week(W3,3)},rowsData);
  const sel=v.$('survivorWeekSelect');assert.equal(sel.value,'2026-2');
  sel.value='2026-3';sel.listeners.change[0]();await flush();
  assert.equal(sel.value,'2026-2','failed switch must restore the rendered week');
  assert.match(v.$('survivorError').innerHTML,/Unable to switch Survivor week/);
  assert.match(v.row('D.C.'),/ALIVE/);
}
// Returning to the foreground immediately reuses the normal guarded score refresh path.
{
  const v=await view({1:week(W1,1),2:week(W2,2),3:week(W3,3)});
  await v.resume();
  assert(v.seen.includes(2),'foreground resume must refresh the current Survivor week');
}

console.log('survivor public view feed-context, malformed-final, duplicate, absent-team, provisional, request-cancellation, selection-rollback and resume regressions passed');


// ---- HDC-04: live next-week feed codes reach the decision board's <img src>. Only NFL codes may become options, and
// the logo sink URL-encodes whatever reaches it, so every src value stays one well-formed attribute.
const LOGO_IMG=/^<img src="https:\/\/a\.espncdn\.com\/i\/teamlogos\/nfl\/500\/[^"<>&\s\/]+\.png" alt="">$/;
function assertLogoImgs(html,label){
  const tags=html.match(/<img\b[^>]*>/g)||[];
  assert.equal(tags.length,html.split('<img').length-1,`${label}: every <img is one tag`);
  for(const tag of tags)assert.match(tag,LOGO_IMG,`${label}: attribute-breaking logo ${tag}`);
}
// Next-week (Week 3) feed with market lines on several games; WAS and JAX arrive under their feed aliases WSH and JAC.
const line=odds=>(a,h,n)=>{const g=game(a,h,n,{completed:false});g.competitions[0].odds=[odds];return g};
const NEXT=W3.map(([a,h])=>[a==='WAS'?'WSH':a,h==='JAX'?'JAC':h]);
const LINES={MIA:line({details:'BUF -3.5'}),PIT:line({details:'PIT -2.5'}),ARI:line({details:'SF -6'}),NE:line({details:'LV -3.5'}),WSH:line({details:'WSH -4'}),IND:line({spread:-3,homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}})};
const OPTION=/<div class="survivor-option-row"><div><span class="survivor-team"><img src="([^"]*)" alt=""><b>([^<]*)<\/b><\/span><span class="survivor-opponent">([^<]*)<\/span><\/div><div class="survivor-option-meta"><b>([^<]*)<\/b><span>([^<]*)<\/span><\/div><\/div>/g;
// The board per tracked entry; an option reads "team | opponent | market | availability | logo file".
function board(html){
  const out={};
  for(const article of html.split('<article').slice(1)){
    const name=article.match(/class="section-kicker">([^<]*)</)[1],[safer,leverage='']=article.split('<h4>Field leverage</h4>');
    const options=part=>{const rows=[...part.matchAll(OPTION)];assert.equal(rows.length,part.split('survivor-option-row').length-1,`${name}: every option row parses`);return rows.map(([,src,team,vs,market,avail])=>`${team} | ${vs} | ${market} | ${avail} | ${src.split('/').pop()}`)};
    out[name]={head:article.match(/<h3>([^<]*)<\/h3>/)[1],burned:[...article.matchAll(/survivor-burned-chip">([^<]*)</g)].map(m=>m[1]),safer:options(safer),leverage:options(leverage)};
  }
  return out;
}
const KC='KC | vs DEN | Favorite -7.5 | 2/2 can use · 100% | kc.png',WAS='WAS | @ LAC | Favorite -4 | 2/2 can use · 100% | wsh.png',LV='LV | vs NE | Favorite -3.5 | 1/2 can use · 50% | lv.png';
const BUF='BUF | vs MIA | Favorite -3.5 | 2/2 can use · 100% | buf.png',JAX='JAX | vs IND | Favorite -3 | 2/2 can use · 100% | jax.png',PIT='PIT | @ CIN | Favorite -2.5 | 1/2 can use · 50% | pit.png';
const OUT={head:'Out of Survivor',burned:['LAC'],safer:[],leverage:[]};
// A well-formed feed renders exactly as before: board, ordering, market labels, availability and logo URLs.
{
  const v=await view({1:week(W1,1),2:week(W2,2),3:week(NEXT,3,LINES)}),html=v.$('svDecisionEntries').innerHTML;
  assertLogoImgs(html,'well-formed feed');
  assert.deepEqual(board(html),{
    'D.C.':{head:'Week 3 Board',burned:['PIT','SF'],safer:[KC,WAS,LV,BUF],leverage:[LV,KC,WAS,BUF]},
    DJS:{head:'Week 3 Board',burned:['LV','SF'],safer:[KC,WAS,BUF,JAX],leverage:[PIT,KC,WAS,BUF]},
    Thaddeus:OUT
  });
  assert(html.includes('<img src="https://a.espncdn.com/i/teamlogos/nfl/500/wsh.png" alt=""><b>WAS</b>'),'WAS keeps its ESPN logo code');
  assert.match(v.$('svDecisionNote').textContent,/^Field availability = share of surviving entries/);
}
// A hostile next-week abbreviation, flagged as the favorite on either side, never becomes an option: its matchup is
// dropped whole (so its NFL opponent, KC or WAS, is not offered either); the remaining options are unchanged.
{
  const A='x" onerror="alert(1)',B='"><img src=x onerror=alert(1)>';
  const pairs=NEXT.map(([a,h])=>[a==='DEN'?A:a,h==='LAC'?B:h]);
  const lines={...LINES,[A]:line({spread:-10,awayTeamOdds:{favorite:true},homeTeamOdds:{favorite:false}}),WSH:line({spread:-9,homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}})};
  const v=await view({1:week(W1,1),2:week(W2,2),3:week(pairs,3,lines)}),html=v.$('svDecisionEntries').innerHTML;
  assertLogoImgs(html,'hostile feed');
  assert.doesNotMatch(html,/onerror|alert/i,'hostile abbreviation must not reach the board');
  assert.deepEqual(board(html),{
    'D.C.':{head:'Week 3 Board',burned:['PIT','SF'],safer:[LV,BUF,JAX],leverage:[LV,BUF,JAX]},
    DJS:{head:'Week 3 Board',burned:['LV','SF'],safer:[BUF,JAX,PIT],leverage:[PIT,BUF,JAX]},
    Thaddeus:OUT
  });
}
// Defense in depth: with the allowlist bypassed by a stand-in market parser (only the survivor-math import is
// re-pointed; the app runs unmodified), a hostile code that reaches the logo sink still yields one well-formed src.
for(const [code,encoded,text] of [
  ['x" onerror="alert(1)','x%22%20onerror%3D%22alert(1)','x&quot; onerror=&quot;alert(1)'],
  ['"><img src=x onerror=alert(1)>','%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E','&quot;&gt;&lt;img src=x onerror=alert(1)&gt;']
]){
  const stand=`export * from '${mathHref}';import {survivorMarketMatchups as parse} from '${mathHref}';const swap=t=>t==='KC'?${JSON.stringify(code)}:t;export const survivorMarketMatchups=events=>parse(events).map(m=>({...m,away:swap(m.away),home:swap(m.home),favorite:swap(m.favorite)}));`;
  const app=source.replace(from,`from 'data:text/javascript;base64,${Buffer.from(stand).toString('base64')}';`);
  const v=await view({1:week(W1,1),2:week(W2,2),3:week(NEXT,3,LINES)},null,app),html=v.$('svDecisionEntries').innerHTML;
  assertLogoImgs(html,`logo sink ${code}`);
  assert(html.includes(`<img src="https://a.espncdn.com/i/teamlogos/nfl/500/${encoded}.png" alt=""><b>${text}</b>`),`hostile code reaches the logo sink encoded as ${encoded}`);
}

console.log('survivor decision-board NFL-code allowlist and logo output-encoding regressions passed');


// ---- FCR-01: in production every scoreboard request goes through the Neon score proxy, whose payload has no season or
// week context anywhere: {fetchedAt, events:[{id, status.type.{state,completed}, competitions[].competitors[].{homeAway,
// score,team.abbreviation}}]} (date and status details only where ESPN sends them), plus competitions[].odds when ESPN
// has a line (HDC-10 adds the final evidence where ESPN sends it; these fixtures carry none, see the HDC-10 block below).
// The view needs no change: with the odds subset the proxy-shaped feed renders the same board as the ESPN-shaped feed;
// without it (the deployment-1 contract) no option is a market favorite. The LINES odds are already that subset.
const proxied=(payload,{odds=true}={})=>({fetchedAt:'2026-09-26T12:00:00.000Z',events:payload.events.map(e=>({
  id:e.id,status:{type:{state:e.status.type.state,completed:e.status.type.completed}},
  competitions:e.competitions.map(c=>({
    competitors:c.competitors.map(x=>({homeAway:x.homeAway,score:x.score,team:{abbreviation:x.team.abbreviation}})),
    ...(odds&&c.odds?.[0]?{odds:[c.odds[0]]}:{})
  }))
}))});
assert.doesNotMatch(JSON.stringify([proxied(week(W1,1)),proxied(week(NEXT,3,LINES))]),/"(?:season|week)"/,'proxy-shaped feeds carry no season/week');
// Proxy-shaped feeds with market lines: the identical board, market labels, ordering, availability and logos.
{
  const espn=await view({1:week(W1,1),2:week(W2,2),3:week(NEXT,3,LINES)});
  const v=await view({1:proxied(week(W1,1)),2:proxied(week(W2,2)),3:proxied(week(NEXT,3,LINES))}),html=v.$('svDecisionEntries').innerHTML;
  assert.equal(html,espn.$('svDecisionEntries').innerHTML,'proxy-shaped feeds render the identical board');
  assert.equal(v.$('svDecisionNote').textContent,espn.$('svDecisionNote').textContent);
  assertLogoImgs(html,'proxy-shaped feed');
  assert.deepEqual(board(html),{
    'D.C.':{head:'Week 3 Board',burned:['PIT','SF'],safer:[KC,WAS,LV,BUF],leverage:[LV,KC,WAS,BUF]},
    DJS:{head:'Week 3 Board',burned:['LV','SF'],safer:[KC,WAS,BUF,JAX],leverage:[PIT,KC,WAS,BUF]},
    Thaddeus:OUT
  });
}
// Proxy-shaped feeds without market lines (what deployment 1 serves): every option reads "No market favorite", Safer
// favorites is empty for each eligible entry, and Field leverage falls back to all legal options by availability.
{
  const v=await view({1:proxied(week(W1,1)),2:proxied(week(W2,2)),3:proxied(week(NEXT,3,LINES),{odds:false})}),html=v.$('svDecisionEntries').innerHTML;
  const row=(team,vs,avail)=>`${team} | ${vs} | No market favorite | ${avail} | ${team.toLowerCase()}.png`,FULL='2/2 can use · 100%',HALF='1/2 can use · 50%';
  assertLogoImgs(html,'proxy-shaped feed without lines');
  assert.deepEqual(board(html),{
    'D.C.':{head:'Week 3 Board',burned:['PIT','SF'],safer:[],leverage:[row('LV','vs NE',HALF),row('ARI','@ SF',FULL),row('ATL','@ TB',FULL),row('BAL','@ CLE',FULL)]},
    DJS:{head:'Week 3 Board',burned:['LV','SF'],safer:[],leverage:[row('PIT','@ CIN',HALF),row('ARI','@ SF',FULL),row('ATL','@ TB',FULL),row('BAL','@ CLE',FULL)]},
    Thaddeus:OUT
  });
  assert.equal(html.split('No market-favorite lines are available yet.').length-1,2,'each eligible entry shows the empty Safer favorites state');
  assert.doesNotMatch(html,/Favorite -|Market favorite/,'no option is labelled a market favorite');
  assert.match(v.$('svDecisionNote').textContent,/^Field availability = share of surviving entries/);
}
// Every week proxy-shaped: the same tracked states, distribution, progress, feed status and board as the ESPN-shaped test.
{
  const espn=await view({1:week(W1,1),2:week(W2,2),3:week(W3,3)});
  const v=await view({1:proxied(week(W1,1)),2:proxied(week(W2,2)),3:proxied(week(W3,3))});
  for(const id of ['svTracked','svDistribution','svProgress','svDecisionEntries'])assert.equal(v.$(id).innerHTML,espn.$(id).innerHTML,`${id} markup`);
  for(const id of ['svFeed','svSummaryNote','svPoolSize','svEntered','svStillIn','svPending','svDecisionWeek','svDecisionNote','svMeta'])assert.equal(v.$(id).textContent,espn.$(id).textContent,`${id} text`);
  assert.match(v.row('D.C.'),/ALIVE/);assert.match(v.row('DJS'),/ALIVE/);
  assert.match(v.row('Thaddeus'),/OUT/);assert.match(v.row('Thaddeus'),/LAC lost in Week 1/);
  assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');assert.equal(v.$('svPending').textContent,0);
}

console.log('survivor decision-board proxy-shaped feed (with and without market lines) regressions passed');


// ---- HDC-10: nflscores2 (score-proxy/index.mjs) forwards the final evidence Survivor validates (status names, the
// competition status and winner flags), so a halted or contradictory Week-2 "final" leaves both SF pickers pending
// whether the page reads ESPN directly or the projection of the same feed: never eliminated, never advanced.
{
  const FETCHED='2026-09-27T20:00:00.000Z',STATUS='final status is contradictory or not a completed game',WINNER='feed winner flag contradicts the final score';
  // The fixture game as ESPN sends a final: a status name, the competition repeating the status, and winner flags.
  const withEvidence=g=>{
    g.status.type.name='STATUS_FINAL';g.competitions[0].status={type:{...g.status.type}};
    const [a,h]=g.competitions[0].competitors;a.winner=Number(a.score)>Number(h.score);h.winner=Number(h.score)>Number(a.score);
    return g;
  };
  for(const [label,mutate,issue] of [
    ['STATUS_CANCELED',g=>{g.status.type.name=g.competitions[0].status.type.name='STATUS_CANCELED'},STATUS],
    ['STATUS_SUSPENDED',g=>{g.status.type.name=g.competitions[0].status.type.name='STATUS_SUSPENDED'},STATUS],
    ['competition completed:false',g=>{g.competitions[0].status.type.completed=false},STATUS],
    ['competition state:in',g=>{g.competitions[0].status.type.state='in'},STATUS],
    ['winner flags contradicting the score',g=>{for(const x of g.competitions[0].competitors)x.winner=!x.winner},WINNER]
  ]){
    const feeds={1:week(W1,1),2:week(W2,2,{SF:(a,h,n)=>{const g=withEvidence(game(a,h,n));mutate(g);return g}}),3:week(W3,3)};
    const espn=await view(feeds);
    const v=await view(Object.fromEntries(Object.entries(feeds).map(([w,payload])=>[w,projectScoreboard(payload,FETCHED)])));
    for(const id of ['svTracked','svDistribution','svProgress','svDecisionEntries'])assert.equal(v.$(id).innerHTML,espn.$(id).innerHTML,`${label}: projected-feed ${id} markup equals the ESPN-fed page`);
    for(const id of ['svFeed','svSummaryNote','svStillIn','svPending','svDecisionNote'])assert.equal(v.$(id).textContent,espn.$(id).textContent,`${label}: projected-feed ${id} equals the ESPN-fed page`);
    for(const name of ['D.C.','DJS']){
      assert.match(v.row(name),/PENDING/,`${label}: ${name} stays pending`);
      assert(v.row(name).includes(`Week 2 SF result unavailable: ${issue}`),`${label}: ${name} shows why`);
    }
    assert.equal(v.$('svFeed').textContent,'LIVE · 1 TEAM RESULT UNVERIFIED',`${label}: the unverified result is flagged`);
    assert.match(v.row('Thaddeus'),/LAC lost in Week 1/,`${label}: other results unchanged`);
    assert.match(v.$('svDecisionEntries').innerHTML,/Waiting for the current week to settle/,`${label}: decision support waits`);
  }
}

console.log('survivor projected-feed final-evidence regressions passed');


// ---- HDC-11: a picked game that is not completed and whose status explicitly names a halted state (canceled, postponed,
// suspended, forfeit) awaits a pool ruling. Its pickers show RULING, never ALIVE, OUT or PENDING, and are counted neither as
// still in nor as eliminated. They no longer hold the next-week board for everyone: provably alive entries get decision
// support, the halted pickers get none and are not part of the surviving field, and the page says the board is provisional.
// Ordinary unfinished games still hold the board exactly as before, and nothing is memoized. The halted game is shaped like
// ESPN 2022 Week 17 BUF at CIN: completed:false, 0-0, the competition repeating the event status.
const notCompleted=(name,state)=>(a,h,n)=>{
  const g=game(a,h,n,{as:'0',hs:'0',completed:false,state});
  if(name!==undefined){g.status.type.name=name;g.competitions[0].status={type:{...g.status.type}}}
  return g;
};
// D.C. and survivor-003 picked the Week-2 SF-ARI game; DJS and survivor-001 won with BUF; Thaddeus and survivor-002 went out
// in Week 1.
const rulingConfig=structuredClone(config);
rulingConfig.trackedEntries=[{id:'dc',displayName:'D.C.',picks:['PIT','SF']},{id:'djs',displayName:'DJS',picks:['LV','BUF']},{id:'thaddeus',displayName:'Thaddeus',picks:['LAC',null]}];
rulingConfig.fieldEntries=[{id:'survivor-001',picks:['JAX','BUF']},{id:'survivor-002',picks:['CLE',null]},{id:'survivor-003',picks:['JAX','ARI']}];
rulingConfig.currentWeekEntryCount=4;
const rulingRows=[{season:2026,week:2,status:'locked',revision:9,config:rulingConfig}];
const shown=v=>['svTracked','svDistribution','svProgress','svDecisionEntries'].map(id=>v.$(id).innerHTML).concat(['svFeed','svSummaryNote','svDecisionNote'].map(id=>v.$(id).textContent)).join('\n');
const HALTED=[['STATUS_CANCELED','post'],['STATUS_POSTPONED','pre'],['STATUS_SUSPENDED','in'],['STATUS_FORFEIT','post']];
const WEEK1_STEP='<div class="survivor-week-step"><span>Week 1</span><b>4</b><small>6 eligible · 6 submitted · 6 legal · 2 out</small></div>';
{
  // R2/R3. The board is not frozen; the halted pickers are shown separately and kept out of the alive and out counts.
  for(const [name,state] of HALTED){
    const v=await view({1:week(W1,1),2:week(W2,2,{SF:notCompleted(name,state)}),3:week(W3,3)},rulingRows),html=v.$('svDecisionEntries').innerHTML;
    const reason=`Week 2 SF game halted (${name}): awaiting pool ruling`;
    assert(v.row('D.C.').includes(`<span class="status-pill survivor-pending">RULING</span><small>${reason}</small>`),`${name}: D.C. awaits a pool ruling`);
    assert.doesNotMatch(v.row('D.C.'),/>(?:ALIVE|OUT|PENDING|LIVE)</,`${name}: D.C. is never alive, out or ordinary pending`);
    assert.match(v.row('DJS'),/>ALIVE</);assert.match(v.row('Thaddeus'),/>OUT</);
    assert.equal(v.$('svStillIn').textContent,2,`${name}: still in counts DJS and survivor-001 only`);
    assert.equal(v.$('svPending').textContent,0,`${name}: no ordinary pending entry`);
    assert.equal(v.$('svSummaryNote').textContent,'2 eliminated before Week 2 · 4 eligible entering · 4 submitted · 4 legal picks · 0 eliminated this week so far. 2 entries are awaiting a pool ruling on a halted game and are not counted as still in or eliminated.',`${name}: summary`);
    assert.equal(v.$('svProgress').innerHTML,WEEK1_STEP+'<div class="survivor-week-step"><span>Week 2</span><b>2</b><small>4 eligible · 4 submitted · 4 legal · 0 out · 2 awaiting ruling</small></div>',`${name}: attrition`);
    assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS AWAITING RULING',`${name}: the feed status is not a clean LIVE`);assert.match(v.$('svFeed').className,/warn/);
    assert.doesNotMatch(html,/Waiting for the current week to settle/,`${name}: the next-week board is not frozen`);
    assert.match(v.$('svDecisionNote').textContent,/^Provisional · 2 entries await a pool ruling on a halted game and are not part of the surviving field\. Field availability = share of surviving entries/,`${name}: the board says it is provisional`);
    assert.deepEqual(board(html),{
      'D.C.':{head:'Awaiting pool ruling',burned:[],safer:[],leverage:[]},
      DJS:{head:'Week 3 Board',burned:['LV','BUF'],safer:[KC],leverage:[KC]},
      Thaddeus:OUT
    },`${name}: DJS gets decision support over a surviving field of 2; D.C. awaits a ruling with no options`);
    assert(html.includes(`<span class="status-pill survivor-pending">RULING</span></div><p>${reason}</p></article>`),`${name}: the ruling card says why`);
    assert.doesNotMatch(html.split('<article').find(a=>a.includes('D.C.')),/ELIGIBLE|Out of Survivor|>OUT</,`${name}: D.C. is neither eligible nor out`);
    // The halted picks were made in Week 2, so the Week-2 distribution keeps them and needs no provisional note.
    assert.doesNotMatch(v.$('svDistribution').innerHTML,/Provisional/);
    assertLogoImgs(html,`${name} board`);
  }
}
{
  // R5. Ordinary unfinished games keep the production page exactly: LIVE or PENDING pickers, the waiting board, no ruling.
  for(const [label,override,pill,reason] of [
    ['live without a status name',(a,h,n)=>game(a,h,n,{as:'7',hs:'3',completed:false,state:'in'}),'LIVE','Week 2 game live'],
    ['live (STATUS_IN_PROGRESS)',notCompleted('STATUS_IN_PROGRESS','in'),'LIVE','Week 2 game live'],
    ['halftime (STATUS_HALFTIME)',notCompleted('STATUS_HALFTIME','in'),'LIVE','Week 2 game live'],
    ['a weather delay expected to resume (STATUS_DELAYED)',notCompleted('STATUS_DELAYED','in'),'LIVE','Week 2 game live'],
    ['scheduled (STATUS_SCHEDULED)',notCompleted('STATUS_SCHEDULED','pre'),'PENDING','Week 2 game pending'],
    ['pregame without a status name',notCompleted(undefined,'pre'),'PENDING','Week 2 game pending'],
    ['state post without a status name',notCompleted(undefined,'post'),'PENDING','Week 2 game pending']
  ]){
    const v=await view({1:week(W1,1),2:week(W2,2,{SF:override}),3:week(W3,3)},rulingRows);
    assert(v.row('D.C.').includes(`<span class="status-pill survivor-${pill.toLowerCase()}">${pill}</span><small>${reason}</small>`),`${label}: D.C. stays ${pill}`);
    assert.equal(v.$('svPending').textContent,2,`${label}: D.C. and survivor-003 are pending`);
    assert.equal(v.$('svStillIn').textContent,4,`${label}: still in includes the pending pickers`);
    assert.equal(v.$('svSummaryNote').textContent,'2 eliminated before Week 2 · 4 eligible entering · 4 submitted · 4 legal picks · 0 eliminated this week so far.');
    assert.equal(v.$('svProgress').innerHTML,WEEK1_STEP+'<div class="survivor-week-step"><span>Week 2</span><b>4</b><small>4 eligible · 4 submitted · 4 legal · 0 out</small></div>');
    assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');
    assert.equal(v.$('svDecisionNote').textContent,'Decision support is provisional until every current-week Survivor result is final.',`${label}: the board still waits`);
    assert.equal(v.$('svDecisionEntries').innerHTML,'<div class="empty">Waiting for the current week to settle before calculating the next-week surviving field.</div>');
    assert.doesNotMatch(shown(v),/ruling/i,`${label}: never a pool ruling`);
  }
}
{
  // R6. Nothing is memoized: the same Week-2 event reported later as live, then as a verified final, is judged as such.
  const v=await view({1:week(W1,1),2:week(W2,2,{SF:notCompleted('STATUS_SUSPENDED','in')}),3:week(W3,3)},rulingRows);
  assert(v.row('D.C.').includes('>RULING<'),'suspended: awaiting a pool ruling');
  v.feeds[2]=week(W2,2,{SF:notCompleted('STATUS_IN_PROGRESS','in')});await v.refresh();
  assert(v.row('D.C.').includes('<span class="status-pill survivor-live">LIVE</span><small>Week 2 game live</small>'),'resumed: ordinary live again');
  assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');
  assert.match(v.$('svDecisionEntries').innerHTML,/Waiting for the current week to settle/,'resumed: the live game holds the board again');
  v.feeds[2]=week(W2,2);await v.refresh();
  assert.match(v.row('D.C.'),/>ALIVE</,'final: SF won, so D.C. is alive');
  assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');
  assert.match(v.$('svDecisionEntries').innerHTML,/D\.C\.<\/span><h3>Week 3 Board/);
  assert.doesNotMatch(shown(v),/ruling/i,'final: no pool ruling remains');
}
{
  // Later weeks. Week 3 with the Week-2 SF game still canceled: D.C. and survivor-003 keep awaiting the Week-2 ruling (D.C.'s
  // Week-3 KC loss is not applied), are not eligible entering Week 3, and the Week-4 board serves the provably alive
  // entries. The unsettled Week 2 keeps being refreshed, so when it goes final the ordinary results take over.
  const cfg3=structuredClone(rulingConfig);cfg3.week=3;cfg3.label='Survivor Week 3';
  cfg3.trackedEntries=[{id:'dc',displayName:'D.C.',picks:['PIT','SF','KC']},{id:'djs',displayName:'DJS',picks:['LV','BUF','MIA']},{id:'thaddeus',displayName:'Thaddeus',picks:['LAC',null,null]}];
  cfg3.fieldEntries=[{id:'survivor-001',picks:['JAX','BUF','DEN']},{id:'survivor-002',picks:['CLE',null,null]},{id:'survivor-003',picks:['JAX','ARI',null]}];
  cfg3.currentWeekEntryCount=3;
  const finals3={season:{year:2026,type:2},week:{number:3},events:W3.map(([a,h])=>game(a,h,3))};
  const next4={season:{year:2026,type:2},week:{number:4},events:W1.map(([a,h])=>game(a,h,4,{completed:false}))};
  const v=await view({1:week(W1,1),2:week(W2,2,{SF:notCompleted('STATUS_CANCELED','post')}),3:finals3,4:next4},[{season:2026,week:3,status:'locked',revision:11,config:cfg3}]);
  const provisional='Provisional · 2 entries await a pool ruling on a halted earlier-week game and are not counted as eligible.';
  assert(v.row('D.C.').includes('<span class="status-pill survivor-pending">RULING</span><small>Week 2 SF game halted (STATUS_CANCELED): awaiting pool ruling</small>'),'D.C. awaits the Week-2 ruling');
  assert.doesNotMatch(v.row('D.C.'),/>OUT<|KC lost/,'the later Week-3 loss is not applied to the halted pick');
  assert.match(v.row('DJS'),/>ALIVE</);
  assert.equal(v.$('svStillIn').textContent,2);assert.equal(v.$('svPending').textContent,0);
  assert.equal(v.$('svSummaryNote').textContent,`2 eliminated before Week 3 · 2 eligible entering · 2 submitted · 2 legal picks · 0 eliminated this week so far. 2 entries are awaiting a pool ruling on a halted game and are not counted as still in or eliminated. ${provisional}`);
  assert(v.$('svDistribution').innerHTML.startsWith(`<div class="empty">${provisional}</div>`),'the Week-3 distribution is provisional');
  assert.equal(v.$('svProgress').innerHTML,WEEK1_STEP+'<div class="survivor-week-step"><span>Week 2</span><b>2</b><small>4 eligible · 4 submitted · 4 legal · 0 out · 2 awaiting ruling</small></div><div class="survivor-week-step"><span>Week 3</span><b>2</b><small>2 eligible · 2 submitted · 2 legal · 0 out · 2 awaiting ruling</small></div>');
  assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS AWAITING RULING');
  const html=v.$('svDecisionEntries').innerHTML;
  assert.deepEqual(Object.fromEntries(Object.entries(board(html)).map(([name,b])=>[name,b.head])),{'D.C.':'Awaiting pool ruling',DJS:'Week 4 Board',Thaddeus:'Out of Survivor'});
  v.feeds[2]=week(W2,2);await v.refresh();
  assert(v.seen.includes(2),'the unsettled Week 2 is refreshed');
  assert(v.row('D.C.').includes('<span class="status-pill survivor-out">OUT</span><small>KC lost in Week 3</small>'),'once Week 2 is final, the ordinary results decide');
  assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');
  assert.doesNotMatch(shown(v),/ruling/i);
}
{
  // R7. nflscores2 forwards the status names, so the page built from the projected feed (score-proxy/index.mjs) is the page
  // built from ESPN's own feed.
  const FETCHED='2026-09-27T20:00:00.000Z';
  for(const [name,state] of HALTED){
    const feeds={1:week(W1,1),2:week(W2,2,{SF:notCompleted(name,state)}),3:week(W3,3)};
    const espn=await view(feeds,rulingRows);
    const v=await view(Object.fromEntries(Object.entries(feeds).map(([w,payload])=>[w,projectScoreboard(payload,FETCHED)])),rulingRows);
    for(const id of ['svTracked','svDistribution','svProgress','svDecisionEntries'])assert.equal(v.$(id).innerHTML,espn.$(id).innerHTML,`${name}: projected-feed ${id} markup equals the ESPN-fed page`);
    for(const id of ['svFeed','svSummaryNote','svStillIn','svPending','svDecisionNote'])assert.equal(v.$(id).textContent,espn.$(id).textContent,`${name}: projected-feed ${id} equals the ESPN-fed page`);
    assert(v.row('D.C.').includes('>RULING<'),`${name}: the projected feed awaits the pool ruling too`);
  }
}

// HDC-11 changes survivor-math.js, so the view imports it as survivor-math.js?v=6 (service-worker.test.mjs pins the rest).
assert.equal(from,"from './survivor-math.js?v=6';",'survivor-app.js must import survivor-math.js?v=6');

console.log('survivor HDC-11 halted-game ruling, unfrozen board, ordinary-pending, recovery, later-week and projected-feed regressions passed');
