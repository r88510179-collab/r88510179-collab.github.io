// Behavioral tests for the public Survivor view (survivor-app.js) with a fake DOM and mocked Neon/NFL feeds.
// Only the module import path is rewritten; the view logic runs unmodified.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectScoreboard} from './score-proxy/index.mjs';

const appSource=readFileSync(new URL('./survivor-app.js',import.meta.url),'utf8');
// HDC-12: the view imports the contest-ruling evaluator; where it does, point that import at the module's file URL so the
// view still loads from a data: URL. Before HDC-12 there is no such import and the source is used as it is.
const rulingsFrom=appSource.match(/from '\.\/contest-rulings\.js\?v=\d+';/)?.[0]??null;
const source=rulingsFrom?appSource.replace(rulingsFrom,`from '${new URL(rulingsFrom.slice("from '".length,-"';".length),import.meta.url).href}';`):appSource;
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

// HDC-12: the contest rules and rulings, served as the Neon Data API serves them to the anonymous role. Only the granted
// public columns can be selected (select=* or any other column is refused, as PostgREST refuses a column the role may not
// read) and rows are filtered by the request's eq./lte. filters. The stored rows carry the private columns too, so a request
// for one fails. By default: one valid contest, its revision-1 policy and no ruling, so every page above renders as before.
const RULING_COLUMNS={
  nfl_contests:['contest_id','season','contest_type','display_name','starts_at','created_at'],
  nfl_contest_policies:['contest_id','contest_type','revision','effective_week','halted_game_policy','public_note','created_at'],
  nfl_incident_rulings:['ruling_id','contest_id','contest_type','week','away_team','home_team','policy_revision','chain_seq','parent_ruling_id','consequence','incident_status','event_id','evidence_source','public_note','created_at']
};
const SV_CONTEST='pool-center-2026-survivor',PRIVATE={admin_note:'PRIVATE ADMIN NOTE',created_by:'auth-user-7f3a'};
const svContestRow=(o={})=>({contest_id:SV_CONTEST,season:2026,contest_type:'survivor',display_name:'Pool Center 2026 Survivor',starts_at:'2026-09-01T00:00:00+00:00',created_at:'2026-10-08T12:00:00+00:00',created_by:PRIVATE.created_by,...o});
const svPolicyRow=(halted_game_policy='advance_team_used',o={})=>({contest_id:SV_CONTEST,contest_type:'survivor',revision:1,effective_week:1,halted_game_policy,public_note:'Approved policy for this contest.',created_at:'2026-10-08T12:00:00+00:00',...PRIVATE,...o});
const rulingStore=(o={})=>({nfl_contests:[svContestRow()],nfl_contest_policies:[svPolicyRow()],nfl_incident_rulings:[],...o});
function dataApi(table,rows,u){
  const select=(u.searchParams.get('select')||'*').split(','),allowed=RULING_COLUMNS[table];
  if(select.some(c=>!allowed.includes(c)))return{ok:false,status:401,json:async()=>({code:'42501',message:`permission denied for table ${table}`})};
  const filters=[...u.searchParams].filter(([k])=>k!=='select'&&k!=='order');
  if(filters.some(([k,v])=>!allowed.includes(k)||!/^(eq|lte)\./.test(v)))return{ok:false,status:400,json:async()=>({message:'unsupported filter'})};
  const keep=row=>filters.every(([k,v])=>{const [op,...rest]=v.split('.'),want=rest.join('.'),have=row[k],w=typeof have==='number'?Number(want):want;return op==='eq'?have===w:have<=w});
  return{ok:true,status:200,json:async()=>structuredClone(rows.filter(keep).map(row=>Object.fromEntries(select.map(c=>[c,row[c]]))))};
}

async function view(feeds,rowsOverride=null,app=patched,store=rulingStore()){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El());return els.get(id)},docListeners={};
  const seen=[],signals=[],rulingRequests=[],doc={getElementById:$,body:{dataset:{view:'survivor'}},visibilityState:'hidden',addEventListener(t,f){(docListeners[t]||=[]).push(f)}};
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
    const table=Object.keys(RULING_COLUMNS).find(t=>u.pathname.endsWith(`/${t}`));
    if(table){
      rulingRequests.push({table,url:u,authorization:init.headers?.Authorization??null});
      const rows=store[table];
      if(typeof rows==='function')return rows(u,init);
      if(typeof rows==='number')return{ok:false,status:rows,json:async()=>({})};
      return dataApi(table,rows,u);
    }
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
    $,row,seen,feeds,signals,intervals,store,rulingRequests,token,
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

console.log('survivor HDC-11 halted-game ruling, unfrozen board, ordinary-pending, recovery, later-week and projected-feed regressions passed');


// ---- HDC-12: contest-scoped commissioner rulings in the public Survivor view. The view reads the public columns of the
// contest, its policy history and its rulings through Week N, applies only a confirmed incident ruling (the policy alone
// changes nothing), keeps the NFL fact apart from the pool consequence, and fails closed when the ruling data cannot be
// read. D.C. picked SF and survivor-003 picked ARI in the canceled Week-2 SF at ARI game (event 401547001); DJS and
// survivor-001 won with BUF; Thaddeus and survivor-002 went out in Week 1. Each regression reports through one collector.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const canceled=(name='STATUS_CANCELED',id='401547001')=>(a,h,n)=>{const g=notCompleted(name,'post')(a,h,n);g.id=id;return g};
  const finalSF=(as,hs,id='401547001')=>(a,h,n)=>({...game(a,h,n,{as,hs}),id});
  const feeds=(sf=canceled())=>({1:week(W1,1),2:week(W2,2,{SF:sf}),3:week(W3,3)});
  const rulings=(consequences,o={},firstId=1)=>consequences.map((consequence,i)=>({ruling_id:firstId+i,contest_id:SV_CONTEST,contest_type:'survivor',week:2,away_team:'SF',home_team:'ARI',
    policy_revision:1,chain_seq:i+1,parent_ruling_id:i?firstId+i-1:null,consequence,incident_status:'STATUS_CANCELED',event_id:'401547001',evidence_source:'nflscores2',
    public_note:i?null:'Game canceled by the league; commissioner ruling applied.',created_at:'2026-10-08T12:00:00+00:00',...PRIVATE,...o}));
  const store=(policy,rows)=>rulingStore({nfl_contest_policies:[svPolicyRow(policy)],nfl_incident_rulings:rows});
  const pill=(v,name)=>(v.row(name).match(/<span class="status-pill [^"]*">([^<]*)<\/span>/g)||[]).map(x=>x.replace(/<[^>]+>/g,''));
  // The status line is the row's last <small> (the history chips carry their own week labels in <small> too).
  const small=(v,name)=>[...v.row(name).matchAll(/<small>([^<]*)<\/small>/g)].pop()?.[1]||'';
  const heads=html=>Object.fromEntries(Object.entries(board(html)).map(([name,b])=>[name,b.head]));
  const rules=v=>v.$('svRules').innerHTML;

  await regression('the view imports the evaluator and survivor-math at their HDC-12 versions',()=>{
    assert.match(rulingsFrom||'',/^from '\.\/contest-rulings\.js\?v=\d+';$/,'survivor-app.js must import the versioned contest-rulings.js');
    assert.equal(from,"from './survivor-math.js?v=7';",'survivor-app.js must import survivor-math.js?v=7');
  });
  await regression('the public loader requests only public columns of this contest, rulings through the selected week, with the anonymous token',async()=>{
    const v=await view(feeds(),rulingRows);
    const byTable=t=>v.rulingRequests.filter(r=>r.table===t);
    for(const table of Object.keys(RULING_COLUMNS)){
      const requests=byTable(table);
      assert(requests.length>=1,`${table} is requested`);
      for(const {url,authorization} of requests){
        assert.deepEqual(url.searchParams.get('select')?.split(','),RULING_COLUMNS[table],`${table}: exactly the public columns`);
        assert.equal(url.searchParams.get('contest_id'),`eq.${SV_CONTEST}`,`${table}: this contest only`);
        assert.equal(authorization,`Bearer ${v.token}`,`${table}: the anonymous Data API token`);
        assert.doesNotMatch(url.href,/admin_note|created_by|select=\*/,`${table}: never a private column`);
      }
    }
    for(const {url} of byTable('nfl_incident_rulings'))assert.equal(url.searchParams.get('week'),'lte.2','Survivor needs every ruling through the selected week');
  });
  await regression('preservation guard: a valid empty ruling set leaves the HDC-11 page exactly as it was',async()=>{
    const v=await view(feeds(),rulingRows);
    assert(v.row('D.C.').includes('<span class="status-pill survivor-pending">RULING</span><small>Week 2 SF game halted (STATUS_CANCELED): awaiting pool ruling</small>'));
    assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS AWAITING RULING');
  });
  await regression('advance_team_used: the pickers are ALIVE by applied commissioner ruling, the team stays burned, the board serves them',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    for(const name of ['D.C.','DJS'])assert.deepEqual(pill(v,name),['ALIVE'],`${name} is alive`);
    assert.match(small(v,'D.C.'),/applied commissioner ruling/,'the row says the survival came from a commissioner ruling');
    assert.doesNotMatch(v.row('D.C.'),/>RULING<|awaiting pool ruling/);
    assert.equal(v.$('svStillIn').textContent,4,'D.C. and survivor-003 are still in alongside DJS and survivor-001');
    assert.equal(v.$('svPending').textContent,0);
    assert.equal(v.$('svFeed').textContent,'LIVE · NFL results','nothing awaits a ruling');
    assert.equal(v.$('svSummaryNote').textContent,'2 eliminated before Week 2 · 4 eligible entering · 4 submitted · 4 legal picks · 0 eliminated this week so far.');
    const html=v.$('svDecisionEntries').innerHTML;
    assert.deepEqual(heads(html),{'D.C.':'Week 3 Board',DJS:'Week 3 Board',Thaddeus:'Out of Survivor'},'D.C. gets next-week decision support');
    const dc=board(html)['D.C.'];
    assert.deepEqual(dc.burned,['PIT','SF'],'SF stays burned');
    assert(![...dc.safer,...dc.leverage].some(o=>o.startsWith('SF ')),'SF is never offered again');
    assert.doesNotMatch(v.$('svDecisionNote').textContent,/^Provisional/);
  });
  await regression('eliminate: the pickers are OUT by applied commissioner ruling in Week 2',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('eliminate',rulings(['eliminate'])));
    assert.deepEqual(pill(v,'D.C.'),['OUT']);assert.match(small(v,'D.C.'),/applied commissioner ruling/);
    assert.equal(v.$('svStillIn').textContent,2);
    assert.equal(v.$('svSummaryNote').textContent,'2 eliminated before Week 2 · 4 eligible entering · 4 submitted · 4 legal picks · 2 eliminated this week so far.');
    assert.equal(heads(v.$('svDecisionEntries').innerHTML)['D.C.'],'Out of Survivor');
  });
  await regression('withdrawn: after the ruling is withdrawn the page returns to the NFL fact and HDC-11 awaiting',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE'],'first the ruling applies');
    v.store.nfl_incident_rulings=rulings(['advance_team_used','withdrawn']);await v.refresh();
    assert(v.row('D.C.').includes('<span class="status-pill survivor-pending">RULING</span><small>Week 2 SF game halted (STATUS_CANCELED): awaiting pool ruling</small>'),'then the pick awaits a ruling again');
    assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS AWAITING RULING');
    assert.match(rules(v),/WITHDRAWN/);
  });
  await regression('a later NFL final neither overrides the advance nor undoes the elimination; the conflict is shown as UNDER REVIEW',async()=>{
    const v=await view(feeds(finalSF('10','24')),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE','UNDER REVIEW'],'SF lost the later final, but the advance stands and is under review');
    assert.match(small(v,'D.C.'),/UNDER REVIEW: the feed now reports a completed final/);
    assert.match(v.$('svFeed').textContent,/UNDER REVIEW/);
    assert.match(rules(v),/UNDER REVIEW/);
    const e=await view(feeds(finalSF('24','10')),rulingRows,patched,store('eliminate',rulings(['eliminate'])));
    assert.deepEqual(pill(e,'D.C.'),['OUT','UNDER REVIEW'],'SF won the later final, but the elimination stands');
  });
  await regression('a changed event id at first load is UNDER REVIEW, not a removed ruling and not a new slot',async()=>{
    const v=await view(feeds(canceled('STATUS_CANCELED','401547999')),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE','UNDER REVIEW']);assert.match(small(v,'D.C.'),/different event/);
  });
  await regression('later weeks are evaluated after an advance, and the advanced team cannot be used again',async()=>{
    const cfg3=structuredClone(rulingConfig);cfg3.week=3;cfg3.label='Survivor Week 3';cfg3.currentWeekEntryCount=3;
    cfg3.trackedEntries=[{id:'dc',displayName:'D.C.',picks:['PIT','SF','KC']},{id:'djs',displayName:'DJS',picks:['LV','BUF','MIA']},{id:'thaddeus',displayName:'Thaddeus',picks:['LAC',null,null]}];
    cfg3.fieldEntries=[{id:'survivor-001',picks:['JAX','BUF','DEN']},{id:'survivor-002',picks:['CLE',null,null]},{id:'survivor-003',picks:['JAX','ARI',null]}];
    const f={1:week(W1,1),2:week(W2,2,{SF:canceled()}),3:{season:{year:2026,type:2},week:{number:3},events:W3.map(([a,h])=>game(a,h,3))},4:{season:{year:2026,type:2},week:{number:4},events:W1.map(([a,h])=>game(a,h,4,{completed:false}))}};
    const v=await view(f,[{season:2026,week:3,status:'locked',revision:11,config:cfg3}],patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert(v.row('D.C.').includes('<span class="status-pill survivor-out">OUT</span><small>KC lost in Week 3</small>'),'the Week-3 loss after the Week-2 advance eliminates');
    assert.deepEqual(pill(v,'DJS'),['ALIVE']);
    const repeat=structuredClone(cfg3);repeat.trackedEntries[0].picks=['PIT','SF','SF'];
    const r=await view(f,[{season:2026,week:3,status:'locked',revision:11,config:repeat}],patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert(r.row('D.C.').includes('<span class="status-pill survivor-out">OUT</span><small>Repeated SF in Week 3</small>'),'using the advanced team again is a repeat');
  });
  await regression('an invalid ruling holds only the coverage it names: HOLD, never ALIVE, OUT, ELIGIBLE or awaiting',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('commissioner_decides',rulings(['advance_team_used','eliminate'])));
    assert.deepEqual(pill(v,'D.C.'),['HOLD']);assert.match(small(v,'D.C.'),/on hold/i);
    assert.deepEqual(pill(v,'DJS'),['ALIVE'],'unrelated coverage still resolves');
    assert.equal(v.$('svStillIn').textContent,2);assert.equal(v.$('svPending').textContent,0);
    assert.match(v.$('svSummaryNote').textContent,/2 entries are on HOLD/);
    assert.match(v.$('svFeed').textContent,/ON HOLD/);
    const html=v.$('svDecisionEntries').innerHTML,dc=html.split('<article').find(a=>a.includes('D.C.'));
    assert.equal(heads(html)['D.C.'],'On hold');
    assert.doesNotMatch(dc,/ELIGIBLE|Out of Survivor|>OUT<|>RULING</,'HOLD never collapses into another state');
    assert.equal(heads(html).DJS,'Week 3 Board');
    assert.match(rules(v),/HOLD/);
  });
  // HDC-12 review remediation, MAJOR-1: a ruling that recorded no event is still the commissioner's confirmed ruling. A feed
  // that pairs its teams differently is a conflict: the ruling stays applied and is UNDER REVIEW, never HOLD.
  await regression("Survivor: a ruling whose matchup the feed contradicts (inverted, no recorded event) stays applied and UNDER REVIEW, never HOLD",async()=>{
    const v=await view(feeds(),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'],{away_team:'ARI',home_team:'SF',event_id:null,evidence_source:null})));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE','UNDER REVIEW']);
    assert.match(small(v,'D.C.'),/UNDER REVIEW: the feed now lists SF @ ARI/);
  });
  await regression('global: when the ruling data cannot be loaded at all, nothing is graded from the NFL feed alone (ON HOLD)',async()=>{
    for(const [label,o] of [['rulings unavailable',{nfl_incident_rulings:503}],['tables absent',{nfl_contests:404,nfl_contest_policies:404,nfl_incident_rulings:404}],
      ['contest not provisioned',{nfl_contests:[]}],['policy history unusable',{nfl_contest_policies:[svPolicyRow('advance')]}],
      ['a request that never answers',{nfl_incident_rulings:()=>new Promise(()=>{})}]]){
      const v=await view(feeds(),rulingRows,patched,rulingStore(o));
      for(const name of ['D.C.','DJS','Thaddeus'])assert.deepEqual(pill(v,name),['HOLD'],`${label}: ${name} is on hold`);
      assert.equal(v.$('svStillIn').textContent,0,label);
      assert.equal(v.$('svFeed').textContent,'ON HOLD · RULING DATA UNAVAILABLE',label);
      assert.match(v.$('svSummaryNote').textContent,/^ON HOLD · Ruling data unavailable/,label);
      assert.match(v.$('svDecisionEntries').innerHTML,/ON HOLD · Ruling data unavailable/,label);
      assert.doesNotMatch(v.$('svDecisionEntries').innerHTML,/Week 3 Board|Out of Survivor/,label);
      assert.match(rules(v),/ON HOLD · Ruling data unavailable/,label);
    }
  });
  await regression('a ruling refresh that fails after a verified load keeps the verified rulings (stale) instead of grading from the feed',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    v.store.nfl_incident_rulings=503;await v.refresh();
    assert.deepEqual(pill(v,'D.C.'),['ALIVE']);
    assert.match(rules(v),/could not be refreshed/);
  });
  await regression('Rules & rulings: contest, policy, revision, effective week, confirmation, rulings, history and notes; never private fields',async()=>{
    const rows=[...rulings(['advance_team_used','advance_team_used'])];rows[1].public_note='Reaffirmed after review.';
    const v=await view(feeds(),rulingRows,patched,store('advance_team_used',rows)),html=rules(v);
    for(const text of ['Survivor contest','Pool Center 2026 Survivor','Advance, team used','Policy revision 1','in force from Week 1','Approved policy for this contest.',
      'Commissioner confirmation is required','SF @ ARI','APPLIED','Ruled ADVANCE','Reaffirmed ADVANCE','Game canceled by the league; commissioner ruling applied.','Reaffirmed after review.'])
      assert(html.includes(text),`the card shows: ${text}`);
    // Even a misconfigured API that returned private columns never reaches the page.
    const leaky=rulingStore({nfl_contest_policies:()=>({ok:true,status:200,json:async()=>[svPolicyRow()]}),nfl_incident_rulings:()=>({ok:true,status:200,json:async()=>rulings(['advance_team_used'])})});
    const l=await view(feeds(),rulingRows,patched,leaky);
    const page=['svRules','svTracked','svDecisionEntries','svSummaryNote','svFeed'].map(id=>`${l.$(id).innerHTML}${l.$(id).textContent}`).join('\n');
    assert.doesNotMatch(`${html}\n${page}`,/PRIVATE ADMIN NOTE|auth-user-7f3a/);
  });

  // Review-driven regression (added after the implementation's adversarial review).
  await regression('switching weeks never reuses rulings verified for another week: a failed load after the switch holds',async()=>{
    const week3=structuredClone(rulingConfig);week3.week=3;week3.label='Survivor Week 3';
    const third={dc:'DEN',djs:'MIA',thaddeus:null,'survivor-001':'PIT','survivor-002':null,'survivor-003':'NE'};
    for(const e of [...week3.trackedEntries,...week3.fieldEntries])e.picks.push(third[e.id]);
    week3.currentWeekEntryCount=4;
    // The last row is the week shown first (Week 2); Week 3 is then chosen from the selector.
    const v=await view(feeds(),[{season:2026,week:3,status:'locked',revision:10,config:week3},...rulingRows],patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE'],'Week 2: the verified ruling applies');
    v.store.nfl_incident_rulings=503;
    const sel=v.$('survivorWeekSelect');sel.value='2026-3';sel.listeners.change[0]();await flush();await flush();
    assert.equal(sel.value,'2026-3');
    for(const name of ['D.C.','DJS','Thaddeus'])assert.deepEqual(pill(v,name),['HOLD'],`Week 3: ${name} is on hold, never graded from the feed alone`);
    assert.equal(v.$('svFeed').textContent,'ON HOLD · RULING DATA UNAVAILABLE');
    assert.doesNotMatch(rules(v),/could not be refreshed/,'the Week-2 rulings are not shown as stale Week-3 rulings');
  });

  // ---- HDC-12 review remediation (the independent review of 4333347).
  // MAJOR-1: no recorded event, and the feed later pairs both ruled teams with other opponents (SF at TB, SEA at ARI).
  await regression('MAJOR-1: a no-event ruling whose teams the feed re-pairs keeps the advance ALIVE (SF burned, Week-3 board) or the elimination OUT, UNDER REVIEW, never HOLD',async()=>{
    const repaired={1:week(W1,1),2:week(W2,2,{SF:(a,h,n)=>game('SF','TB',n,{completed:false}),SEA:(a,h,n)=>game('SEA','ARI',n,{completed:false})}),3:week(W3,3)};
    const bare={event_id:null,evidence_source:null};
    const v=await view(repaired,rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'],bare)));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE','UNDER REVIEW'],'the advance stays applied and is under review');
    assert.match(small(v,'D.C.'),/applied commissioner ruling/);assert.match(small(v,'D.C.'),/UNDER REVIEW: the feed now lists SF @ TB/);
    assert.equal(v.$('svStillIn').textContent,4,'D.C. and survivor-003 stay in');assert.equal(v.$('svPending').textContent,0);
    assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNDER REVIEW');
    const html=v.$('svDecisionEntries').innerHTML;
    assert.equal(heads(html)['D.C.'],'Week 3 Board','D.C. keeps next-week decision support');
    assert.deepEqual(board(html)['D.C.'].burned,['PIT','SF'],'SF stays burned');
    assert.match(rules(v),/rules-status">UNDER REVIEW</);assert.doesNotMatch(rules(v),/rules-status">HOLD</);
    const e=await view(repaired,rulingRows,patched,store('eliminate',rulings(['eliminate'],bare)));
    assert.deepEqual(pill(e,'D.C.'),['OUT','UNDER REVIEW'],'the elimination stays applied and is under review');
    assert.equal(heads(e.$('svDecisionEntries').innerHTML)['D.C.'],'Out of Survivor');
    assert.equal(e.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNDER REVIEW');
  });
  // MAJOR-2: the recorded canceled event (401547001) still in the feed, plus SF at ARI under another event id as a final.
  const relisted=([as,hs])=>{const f=feeds();f[2].events.push(finalSF(as,hs,'401547002')('SF','ARI',2));return f};
  await regression('MAJOR-2: the recorded canceled event plus the same pair as a final under another event id keeps the advance ALIVE and the elimination OUT, UNDER REVIEW; the feed status is never a clean LIVE',async()=>{
    const v=await view(relisted(['10','24']),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE','UNDER REVIEW'],'SF lost the second listing, but the advance stands and is under review');
    assert.match(small(v,'D.C.'),/UNDER REVIEW: the feed also lists SF @ ARI under another event \(feed event 401547002\)/);
    assert.notEqual(v.$('svFeed').textContent,'LIVE · NFL results','never a clean LIVE · NFL results');
    assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNDER REVIEW');assert.match(v.$('svFeed').className,/warn/);
    assert.match(rules(v),/rules-status">UNDER REVIEW</);
    assert.equal(v.$('svStillIn').textContent,4,'no NFL final replaces the ruling consequence');
    const e=await view(relisted(['24','10']),rulingRows,patched,store('eliminate',rulings(['eliminate'])));
    assert.deepEqual(pill(e,'D.C.'),['OUT','UNDER REVIEW'],'SF won the second listing, but the elimination stands and is under review');
    assert.equal(e.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNDER REVIEW');
  });
  // MAJOR-3: rulings kept after a failed refresh are stale, and the main Survivor status says so.
  await regression('MAJOR-3: rulings kept after a failed refresh still apply, and the main feed status says RULINGS STALE (never a clean LIVE · NFL results) until a refresh succeeds',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert.equal(v.$('svFeed').textContent,'LIVE · NFL results','verified: a clean LIVE');
    v.store.nfl_incident_rulings=503;await v.refresh();
    assert.deepEqual(pill(v,'D.C.'),['ALIVE'],'the last verified ruling still applies');
    assert.notEqual(v.$('svFeed').textContent,'LIVE · NFL results','never a clean LIVE · NFL results while the rulings are stale');
    assert.equal(v.$('svFeed').textContent,'LIVE · RULINGS STALE');assert.match(v.$('svFeed').className,/warn/);
    assert.match(rules(v),/could not be refreshed/,'the Rules & rulings card keeps its stale note');
    // The current week's score feed failing as well: the status still says the rulings are stale.
    const current=v.feeds[2];delete v.feeds[2];await v.refresh();
    assert.equal(v.$('svFeed').textContent,'RESULT FEED UNAVAILABLE · RULINGS STALE');
    // A refresh that loads the rulings again clears it.
    v.feeds[2]=current;v.store.nfl_incident_rulings=rulings(['advance_team_used']);await v.refresh();
    assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');assert.doesNotMatch(rules(v),/could not be refreshed/);
  });

  // ---- HDC-12 second review remediation (the independent review of 84108339). Copies of one feed event are one logical
  // event: the recorded canceled event (401547001) listed twice can neither hide SF at ARI under another event id (UNDER
  // REVIEW) nor hide a forfeit (HOLD). The extra listings go after the week's events, or before them.
  const withListings=(listings,first=false)=>{const f=feeds(),extra=listings.map(make=>make('SF','ARI',2));f[2].events=first?[...extra,...f[2].events]:[...f[2].events,...extra];return f};
  await regression('second review: the recorded canceled event listed twice plus SF at ARI as a final under another event id keeps the advance ALIVE (SF used) and the elimination OUT, UNDER REVIEW in either order; never a clean LIVE; A+A alone is no conflict',async()=>{
    for(const first of [false,true]){
      const order=first?'B+A+A':'A+A+B';
      const v=await view(withListings([canceled(),finalSF('10','24','401547002')],first),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
      assert.deepEqual(pill(v,'D.C.'),['ALIVE','UNDER REVIEW'],`${order}: SF lost the other listing, but the advance stands and is under review`);
      assert.match(small(v,'D.C.'),/applied commissioner ruling/,`${order}: alive by the ruling`);
      assert.match(small(v,'D.C.'),/UNDER REVIEW: the feed also lists SF @ ARI under another event \(feed event 401547002\)/,`${order}: the row names the conflict`);
      assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNDER REVIEW',`${order}: never a clean LIVE · NFL results`);assert.match(v.$('svFeed').className,/warn/);
      assert.match(rules(v),/rules-status">UNDER REVIEW</,`${order}: Rules & rulings says UNDER REVIEW`);
      assert.equal(v.$('svStillIn').textContent,4,`${order}: no NFL final replaces the ruling consequence`);
      const html=v.$('svDecisionEntries').innerHTML;
      assert.equal(heads(html)['D.C.'],'Week 3 Board',`${order}: D.C. keeps next-week decision support`);
      assert.deepEqual(board(html)['D.C.'].burned,['PIT','SF'],`${order}: SF stays used`);
      const e=await view(withListings([canceled(),finalSF('24','10','401547002')],first),rulingRows,patched,store('eliminate',rulings(['eliminate'])));
      assert.deepEqual(pill(e,'D.C.'),['OUT','UNDER REVIEW'],`${order}: SF won the other listing, but the elimination stands and is under review`);
      assert.equal(heads(e.$('svDecisionEntries').innerHTML)['D.C.'],'Out of Survivor');
      assert.equal(e.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNDER REVIEW',`${order}: elimination: never a clean LIVE`);
      assert.match(rules(e),/rules-status">UNDER REVIEW</);
    }
    // Control: the recorded event listed twice and nothing else is no conflict.
    const twice=await view(withListings([canceled()]),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert.deepEqual(pill(twice,'D.C.'),['ALIVE'],'A+A: the advance applies, never UNDER REVIEW');
    assert.doesNotMatch(`${twice.row('D.C.')}\n${twice.$('svFeed').textContent}\n${rules(twice)}`,/UNDER REVIEW/,'A+A: no conflict anywhere');
    assert.match(rules(twice),/rules-status">APPLIED</);
  });
  await regression('second review: a forfeit of SF at ARI beside the repeated recorded event is HOLD in either order, never ALIVE or OUT from the advance or the elimination',async()=>{
    for(const first of [false,true])for(const consequence of ['advance_team_used','eliminate']){
      const label=`${first?'forfeit B+A+A':'A+A+forfeit B'} (${consequence})`;
      const v=await view(withListings([canceled(),canceled('STATUS_FORFEIT','401547002')],first),rulingRows,patched,store(consequence,rulings([consequence])));
      assert.deepEqual(pill(v,'D.C.'),['HOLD'],`${label}: HOLD, never ALIVE or OUT`);
      assert.match(small(v,'D.C.'),/on hold.*forfeit/i,`${label}: the row names the forfeit hold`);
      assert.equal(v.$('svStillIn').textContent,2,`${label}: the held pickers are not counted as still in`);
      assert.match(v.$('svFeed').textContent,/ON HOLD/,`${label}: the feed status says ON HOLD`);
      assert.equal(heads(v.$('svDecisionEntries').innerHTML)['D.C.'],'On hold',`${label}: no board, not out`);
      assert.match(rules(v),/rules-status">HOLD</,`${label}: Rules & rulings says HOLD`);
    }
  });
  await regression('second review: the recorded event gone and SF at ARI listed twice under one other event id is the accepted event-id change (ALIVE, UNDER REVIEW); listed twice as a forfeit it is HOLD',async()=>{
    const twice=sf=>{const f=feeds(sf);f[2].events.push(sf('SF','ARI',2));return f};
    const v=await view(twice(canceled('STATUS_CANCELED','401547999')),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE','UNDER REVIEW'],'B+B: the advance stands and is under review');
    assert.match(small(v,'D.C.'),/UNDER REVIEW: the feed now reports a different event \(feed event 401547999; the ruling recorded event 401547001\)/);
    assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNDER REVIEW');
    const h=await view(twice(canceled('STATUS_FORFEIT','401547999')),rulingRows,patched,store('advance_team_used',rulings(['advance_team_used'])));
    assert.deepEqual(pill(h,'D.C.'),['HOLD'],'B+B forfeit: HOLD, never ALIVE');
  });

  assert.equal(failures.length,0,`HDC-12 Survivor view regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}


// ---- HDC-14: absent-game adjudication in the public Survivor view. The Week-2 SF @ ARI game (event 401547001) is no longer
// listed in the Week 2 feed; a distinct SF @ ARI event appears in Week 3. D.C. picked SF and survivor-003 ARI in Week 2.
// Without a ruling their picks stay pending, as before. An attested-absence ruling (STATUS_ABSENT, commissioner-attestation)
// applies while the Week 2 feed still omits the game: advance_team_used keeps them ALIVE with the team burned, eliminate
// puts them OUT. A Week 2 listing again puts the applied ruling UNDER REVIEW; the Week 3 makeup changes nothing.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const absentW2=W2.filter(([a])=>a!=='SF');
  const makeupW3=W3.map(([a,h])=>a==='ARI'?['SF','ARI']:[a,h]);
  const feeds=(w2=week(absentW2,2),w3=week(makeupW3,3))=>({1:week(W1,1),2:w2,3:w3});
  const absent=(consequences,o={},firstId=1)=>consequences.map((consequence,i)=>({ruling_id:firstId+i,contest_id:SV_CONTEST,contest_type:'survivor',week:2,away_team:'SF',home_team:'ARI',
    policy_revision:1,chain_seq:i+1,parent_ruling_id:i?firstId+i-1:null,consequence,incident_status:'STATUS_ABSENT',event_id:'401547001',evidence_source:'commissioner-attestation',
    public_note:i?null:'SF @ ARI left the Week 2 feed; commissioner ruling applied.',created_at:'2026-10-08T12:00:00+00:00',...PRIVATE,...o}));
  const store=(policy,rows)=>rulingStore({nfl_contest_policies:[svPolicyRow(policy)],nfl_incident_rulings:rows});
  const pill=(v,name)=>(v.row(name).match(/<span class="status-pill [^"]*">([^<]*)<\/span>/g)||[]).map(x=>x.replace(/<[^>]+>/g,''));
  const small=(v,name)=>[...v.row(name).matchAll(/<small>([^<]*)<\/small>/g)].pop()?.[1]||'';
  const rules=v=>v.$('svRules').innerHTML;
  const EVIDENCE='Recorded incident: ABSENT FROM WEEK 2 FEED · commissioner attestation · original event 401547001';

  await regression('HDC-14: the view imports the evaluator at its HDC-14 version (contest-rulings.js?v=2)',()=>{
    assert.equal(rulingsFrom,"from './contest-rulings.js?v=2';",'survivor-app.js must import contest-rulings.js?v=2');
  });
  await regression('HDC-14 preservation: without a ruling the absent picks stay pending, never alive or out',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('advance_team_used',[]));
    assert.deepEqual(pill(v,'D.C.'),['PENDING']);assert.match(small(v,'D.C.'),/SF not present in verified Week 2 feed\/schedule/);
    assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNVERIFIED');
    assert.equal(v.$('svPending').textContent,2,'D.C. and survivor-003 are pending');
  });
  await regression('HDC-14 advance_team_used: the absent picks are ALIVE by applied commissioner ruling, SF stays burned, the board serves D.C.',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('advance_team_used',absent(['advance_team_used'])));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE']);assert.match(small(v,'D.C.'),/alive by applied commissioner ruling; SF stays used/);
    assert.equal(v.$('svStillIn').textContent,4);assert.equal(v.$('svPending').textContent,0);
    assert.equal(v.$('svFeed').textContent,'LIVE · NFL results','an applied absence ruling is no unverified result');
    const dc=board(v.$('svDecisionEntries').innerHTML)['D.C.'];
    assert.equal(dc.head,'Week 3 Board');assert.deepEqual(dc.burned,['PIT','SF'],'SF stays burned');
    assert(![...dc.safer,...dc.leverage].some(o=>o.startsWith('SF ')),'SF is never offered again');
    assert.match(rules(v),/<span class="rules-status">APPLIED<\/span>/);
    assert(rules(v).includes(`<small>${EVIDENCE}</small>`),'the Rules card names the attested absence');
    assert.doesNotMatch(rules(v),/PRIVATE ADMIN NOTE|auth-user-7f3a|nflscores2/);
  });
  await regression('HDC-14 eliminate: the absent picks are OUT by applied commissioner ruling in Week 2',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('eliminate',absent(['eliminate'])));
    assert.deepEqual(pill(v,'D.C.'),['OUT']);assert.match(small(v,'D.C.'),/eliminated by applied commissioner ruling/);
    assert.equal(v.$('svStillIn').textContent,2);
    assert.equal(board(v.$('svDecisionEntries').innerHTML)['D.C.'].head,'Out of Survivor');
  });
  await regression('HDC-14 feed recovery: SF @ ARI listed again in Week 2 keeps the advance applied and UNDER REVIEW',async()=>{
    const v=await view(feeds(week(W2,2)),rulingRows,patched,store('advance_team_used',absent(['advance_team_used'])));
    assert.deepEqual(pill(v,'D.C.'),['ALIVE','UNDER REVIEW']);
    assert.match(small(v,'D.C.'),/UNDER REVIEW: the game is listed in this week's feed again/);
    assert.equal(v.$('svFeed').textContent,'LIVE · 2 TEAM RESULTS UNDER REVIEW');
  });
  await regression('HDC-14 the Week 3 makeup has zero effect on the Week 2 absence',async()=>{
    for(const w3 of [week(W3,3),week(makeupW3,3)]){
      const v=await view(feeds(week(absentW2,2),w3),rulingRows,patched,store('advance_team_used',absent(['advance_team_used'])));
      assert.deepEqual(pill(v,'D.C.'),['ALIVE'],'no review from another week');
      assert.doesNotMatch(v.row('D.C.'),/UNDER REVIEW/);
    }
  });
  await regression('HDC-14 a withdrawn absence ruling restores the pending picks',async()=>{
    const v=await view(feeds(),rulingRows,patched,store('advance_team_used',absent(['advance_team_used','withdrawn'])));
    assert.deepEqual(pill(v,'D.C.'),['PENDING']);assert.match(rules(v),/<span class="rules-status">WITHDRAWN<\/span>/);
  });
  await regression('HDC-14 unusable absence evidence HOLDs the picks, never ALIVE',async()=>{
    for(const o of [{evidence_source:'nflscores2'},{incident_status:'STATUS_CANCELED'}]){
      const v=await view(feeds(),rulingRows,patched,store('advance_team_used',absent(['advance_team_used'],o)));
      assert.deepEqual(pill(v,'D.C.'),['HOLD'],JSON.stringify(o));
    }
  });

  assert.equal(failures.length,0,`HDC-14 Survivor absent-game regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('survivor HDC-12 contest-ruling load and HDC-14 absent-game, privacy, advance, eliminate, withdrawn, under-review, later-week, hold, fail-closed and Rules & rulings regressions passed');
