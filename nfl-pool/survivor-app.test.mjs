// Behavioral tests for the public Survivor view (survivor-app.js) with a fake DOM and mocked Neon/NFL feeds.
// Only the module import path is rewritten; the view logic runs unmodified.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('./survivor-app.js',import.meta.url),'utf8');
const from="from './survivor-math.js?v=4';";
assert(source.includes(from),'harness expects the survivor-math import');
const mathHref=new URL('./survivor-math.js?v=4',import.meta.url).href,patched=source.replace(from,`from '${mathHref}';`);
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
