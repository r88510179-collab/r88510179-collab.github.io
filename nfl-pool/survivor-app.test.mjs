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
// HDC-15: a publication table (nfl_survivor_weeks, or nfl_pool_weeks on the whole page below) as the Data API serves it to the
// anonymous role: eq. filters and the requested column list are applied (a missing value reads as null); rows keep the order
// the fixture lists them in, which is the order a request asks for. A column the table does not have, or any other filter,
// is refused.
const PUB_COLUMNS=['season','week','status','config','revision','published_at','locked_at','source_filename','source_sha256','created_at','updated_at'];
function publicationApi(rows,u){
  const select=(u.searchParams.get('select')||'*').split(',');
  if(select.some(c=>c!=='*'&&!PUB_COLUMNS.includes(c)))return{ok:false,status:400,json:async()=>({message:'unknown column'})};
  const filters=[...u.searchParams].filter(([k])=>k!=='select'&&k!=='order');
  if(filters.some(([k,v])=>!PUB_COLUMNS.includes(k)||!/^eq\./.test(v)))return{ok:false,status:400,json:async()=>({message:'unsupported filter'})};
  const keep=row=>filters.every(([k,v])=>String(row[k])===v.slice(3));
  return{ok:true,status:200,json:async()=>structuredClone(rows.filter(keep).map(row=>select.includes('*')?row:Object.fromEntries(select.map(c=>[c,row[c]??null]))))};
}
const publicationKind=u=>(u.searchParams.get('select')||'*').split(',').some(c=>c==='config'||c==='*')?'row':'index';

// HDC-15 additions: the published rows (a copy, so a test can republish or add a week), a log of every request by kind (token,
// index: a publication read without a config, row: one with a config, rulings, score), per-kind hooks that can answer a
// request instead of the default (bootHooks are in place before the view boots), the History API calls and the document's
// visibility. refresh() is a visible timer tick (the
// tick a browser runs), tick() the timer callback as the document currently is, resume() a hidden-to-visible transition.
async function view(feeds,rowsOverride=null,app=patched,store=rulingStore(),{tokenTtl=3600,search='?view=survivor',bootHooks={}}={}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El());return els.get(id)},docListeners={};
  const seen=[],signals=[],rulingRequests=[],calls=[],hooks={...bootHooks},historyCalls=[],doc={getElementById:$,body:{dataset:{view:'survivor'}},visibilityState:'hidden',addEventListener(t,f){(docListeners[t]||=[]).push(f)},dispatchEvent(e){for(const fn of docListeners[e.type]||[])fn(e);return true}};
  globalThis.document=doc;
  globalThis.location={href:`https://example.test/nfl-pool/${search}`,search};
  globalThis.history={state:null,replaceState(_s,_t,u){historyCalls.push(['replace',String(u)])},pushState(_s,_t,u){historyCalls.push(['push',String(u)])}};
  let tick=null;const intervals=[];globalThis.setInterval=(fn,ms)=>{tick=fn;intervals.push(ms);return 0};
  const mint=()=>'x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+tokenTtl})).toString('base64url')+'.y',token=mint();
  const defaultRows=[{season:2026,week:2,status:'locked',revision:7,config:structuredClone(config)}],rowsData=structuredClone(rowsOverride||defaultRows);
  globalThis.fetch=async (url,init={})=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/token/anonymous')){calls.push({kind:'token',url:u});const answer={ok:true,json:async()=>({token:tokenTtl===3600?token:mint()})};return hooks.token?.(u,init,answer)??answer}
    if(u.pathname.endsWith('/nfl_survivor_weeks')){
      const kind=publicationKind(u);calls.push({kind,url:u,authorization:init.headers?.Authorization??null});
      return hooks[kind]?.(u,init)??publicationApi(rowsData,u);
    }
    const table=Object.keys(RULING_COLUMNS).find(t=>u.pathname.endsWith(`/${t}`));
    if(table){
      rulingRequests.push({table,url:u,authorization:init.headers?.Authorization??null});calls.push({kind:'rulings',url:u});
      const rows=store[table];
      if(typeof rows==='function')return rows(u,init);
      if(typeof rows==='number')return{ok:false,status:rows,json:async()=>({})};
      return dataApi(table,rows,u);
    }
    const w=Number(u.searchParams.get('week'));seen.push(w);calls.push({kind:'score',url:u});if(init.signal)signals.push({week:w,signal:init.signal});
    const hooked=hooks.score?.(u,init);if(hooked)return hooked;
    const payload=feeds[w];
    if(typeof payload==='function')return payload({week:w,signal:init.signal});
    if(payload==='hang')return new Promise((resolve,reject)=>{if(init.signal)init.signal.addEventListener('abort',()=>{const e=new Error('Aborted');e.name='AbortError';reject(e)},{once:true})});
    if(!payload)return{ok:false,status:404,json:async()=>({})};
    return{ok:true,status:200,json:async()=>structuredClone(payload)};
  };
  await import(`data:text/javascript;base64,${Buffer.from(app+`\n//instance ${++instance}`).toString('base64')}`);
  await flush();
  const row=name=>$('svTracked').innerHTML.split('survivor-tracked-row').find(s=>s.includes(`<b>${name}</b>`))||'';
  const setVisibility=state=>{doc.visibilityState=state;for(const fn of docListeners.visibilitychange||[])fn()};
  return{
    $,row,seen,feeds,signals,intervals,store,rulingRequests,token,doc,rows:rowsData,calls,hooks,historyCalls,setVisibility,
    tick:()=>tick(),
    refresh:async()=>{seen.length=0;doc.visibilityState='visible';tick();await flush()},
    resume:async()=>{seen.length=0;setVisibility('hidden');setVisibility('visible');await flush()}
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
    assert.match(small(v,'D.C.'),/UNDER REVIEW: the game is listed in this week&#39;s feed again/,'the row text is HTML-escaped');
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


// HDC-15. The public refresh lifecycle in Survivor. Every full refresh first reads a lightweight publication index (season,
// week, revision, published_at, status: never a config) and downloads a full published snapshot only for the first selection,
// a changed revision of the selected week, or a week the participant chooses. A newer revision is loaded and validated before
// it replaces the active snapshot and never mixes with it; one that cannot be loaded or validated leaves the last verified
// revision on screen, marked PUBLISHED DATA STALE (never LIVE), and is retried on the next refresh. A newly published week
// enters the selector without moving the participant. Timer refreshes run only while the document is visible and Survivor is
// the active view; becoming visible runs exactly one full refresh; a late response for an older revision or week never
// overwrites a newer one. Each regression reports through one collector; the block fails at its end if any did.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const PUBLISHED_AT='2026-09-21T19:30:44.641+00:00';
  const svRow=(cfg,revision,o={})=>({season:cfg.season,week:cfg.week,status:'locked',revision,published_at:PUBLISHED_AT,locked_at:PUBLISHED_AT,config:structuredClone(cfg),...o});
  // Revision 8 republishes D.C.'s Week 2 pick as ARI, which lost to SF; revision 9 as BUF, which beat CAR.
  const republished=team=>{const c=structuredClone(config);c.trackedEntries[0].picks=['PIT',team];return c};
  // A Week 3 snapshot: the Week 2 field plus its Week 3 picks.
  const wk3=()=>{
    const c=structuredClone(config);c.week=3;c.label='Survivor Week 3';
    const third={dc:'DEN',djs:'MIA',thaddeus:null,'survivor-001':'PIT','survivor-002':null,'survivor-003':null};
    for(const e of [...c.trackedEntries,...c.fieldEntries])e.picks.push(third[e.id]);
    c.currentWeekEntryCount=3;return c;
  };
  const feeds=()=>({1:week(W1,1),2:week(W2,2),3:week(W3,3)});
  const json=data=>({ok:true,status:200,json:async()=>structuredClone(data)}),httpError=status=>({ok:false,status,json:async()=>({})});
  const open=({rows=[svRow(config,7)],search,tokenTtl,store=rulingStore()}={})=>view(feeds(),rows,patched,store,{...(search?{search}:{}),...(tokenTtl?{tokenTtl}:{})});
  const tally=(v,from=0)=>{const t={token:0,index:0,row:0,rulings:0,score:0};for(const c of v.calls.slice(from))t[c.kind]++;return t};
  const kinds=(v,from)=>v.calls.slice(from).map(c=>c.kind);
  const rowWeeks=(v,from)=>v.calls.slice(from).filter(c=>c.kind==='row').map(c=>[c.url.searchParams.get('season'),c.url.searchParams.get('week')]);
  const meta=v=>v.$('svMeta').textContent,notices=v=>v.$('survivorError').innerHTML;
  const options=v=>[...v.$('survivorWeekSelect').innerHTML.matchAll(/<option value="([^"]+)"/g)].map(m=>m[1]);
  const choose=async(v,value)=>{const select=v.$('survivorWeekSelect');select.value=value;for(const fn of select.listeners.change||[])fn();await flush();await flush()};
  const SNAPSHOT_HTML=['svTracked','svDistribution','svProgress','svDecisionEntries','svRules'],SNAPSHOT_TEXT=['svSummaryNote','svPoolSize','svEntered','svStillIn','svPending','svDecisionWeek','svDecisionNote'];
  const page=v=>Object.fromEntries([...SNAPSHOT_HTML.map(id=>[id,v.$(id).innerHTML]),...SNAPSHOT_TEXT.map(id=>[id,v.$(id).textContent])]);
  const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
  // This file shortens every long time limit to 5 ms. A late-response race needs the superseded request still waiting when
  // the newer refresh or choice starts, so those regressions give each limit a second instead (restored afterwards).
  const withSlowLimits=async check=>{const fast=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...a)=>realSetTimeout(fn,ms>=10000?1000:ms,...a);try{await check()}finally{globalThis.setTimeout=fast}};
  const FULL={token:0,index:1,row:0,rulings:3,score:1};
  const stale=(v,label)=>{
    assert.equal(meta(v),'Week 2 · revision 7 · PUBLISHED DATA STALE',`${label}: the revision on screen is marked stale`);
    assert.match(v.$('svFeed').textContent,/PUBLISHED DATA STALE/,`${label}: the feed status says so`);
    assert.doesNotMatch(v.$('svFeed').textContent,/^LIVE\b/,`${label}: never LIVE`);
    assert.match(v.$('svFeed').className,/\bwarn\b/,label);
    assert.match(notices(v),/PUBLISHED DATA STALE · /,`${label}: a notice explains it`);
  };
  const current=(v,label,revision)=>{
    assert.equal(meta(v),`Week 2 · revision ${revision}`,label);
    assert.equal(v.$('svFeed').textContent,'LIVE · NFL results',label);
    assert.doesNotMatch(notices(v),/PUBLISHED DATA STALE/,`${label}: nothing is marked stale`);
  };

  await regression("boot reads the Survivor publication index (identity columns only, never a config) and then exactly one full snapshot, the selected week's",async()=>{
    const v=await open({rows:[svRow(config,7),svRow(wk3(),2)],search:'?view=survivor&sw=2&season=2026'});
    const t=tally(v);
    assert.deepEqual([t.index,t.row,t.rulings],[1,1,3],'boot: one index, one snapshot, the rules and rulings');
    const index=v.calls.find(c=>c.kind==='index'),full=v.calls.find(c=>c.kind==='row'),columns=index.url.searchParams.get('select').split(',');
    for(const c of ['season','week','revision','published_at','status'])assert(columns.includes(c),`the index reads ${c}`);
    assert(columns.every(c=>['season','week','revision','published_at','status','locked_at'].includes(c)),`the index reads identity columns only: ${columns}`);
    assert.deepEqual(rowWeeks(v,0),[['eq.2026','eq.2']],'the full snapshot is the selected week only');
    assert(full.url.searchParams.get('select').split(',').includes('config'));
    for(const c of [index,full])assert.equal(c.authorization,`Bearer ${v.token}`,'published rows are read with the anonymous token');
    assert.deepEqual(options(v),['2026-2','2026-3']);assert.equal(v.$('survivorWeekSelect').value,'2026-2');
    current(v,'boot',7);assert.match(v.row('D.C.'),/ALIVE/);
  });
  await regression('an unchanged revision: each visible timer refresh reads the index once, the three HDC-12 tables and the unsettled score feeds, never a snapshot, and changes nothing',async()=>{
    const v=await open(),before=page(v);
    for(let i=1;i<=3;i++){const from=v.calls.length;await v.refresh();assert.deepEqual(tally(v,from),FULL,`tick ${i}`)}
    assert.deepEqual(page(v),before,'states, burned teams, distribution, progress, decision support and rules are exactly as before');
    current(v,'unchanged',7);
  });
  await regression('hidden: Survivor timer ticks make no request at all, not even to renew an expired anonymous token',async()=>{
    const v=await open({tokenTtl:30});
    // Going hidden makes no request either. Each tick is counted with nothing in flight, so a token request one of them
    // starts cannot hide behind one already on its way.
    let from=v.calls.length;v.setVisibility('hidden');await flush();
    assert.deepEqual(kinds(v,from),[],'going hidden makes no request');
    from=v.calls.length;v.tick();await flush();v.tick();await flush();
    assert.deepEqual(kinds(v,from),[],'no token, Data API or score-feed request from a hidden tick');
    v.doc.visibilityState='visible';from=v.calls.length;v.tick();await flush();
    assert(tally(v,from).token>=1&&tally(v,from).index===1,'control: the same tick while visible renews the token and refreshes');
  });
  // Home is not such a view since the Home dashboard: there Survivor refreshes once a minute at most (its own regressions
  // follow the page ones below), so these two regressions use Standings, as every other Pick’em view behaves.
  await regression('a Pick’em view other than Home active: visible Survivor timer ticks make no request',async()=>{
    const v=await open();v.doc.visibilityState='visible';v.doc.body.dataset.view='standings';
    const from=v.calls.length;v.tick();v.tick();await flush();
    assert.deepEqual(kinds(v,from),[]);
  });
  await regression('becoming visible runs exactly one Survivor full refresh at once, even with timer ticks at the same moment; with a Pick’em view active it runs none',async()=>{
    const v=await open();
    let from=v.calls.length;await v.resume();
    assert.deepEqual(tally(v,from),FULL,'resume');
    v.setVisibility('hidden');from=v.calls.length;v.setVisibility('visible');v.tick();v.tick();await flush();
    assert.deepEqual(tally(v,from),FULL,'resume and ticks together');
    v.doc.body.dataset.view='standings';from=v.calls.length;await v.resume();
    assert.deepEqual(kinds(v,from),[],'a Pick’em view active');
  });
  await regression('a republished revision (7 → 8) is fetched once, validated and installed whole, and later unchanged ticks never download it again',async()=>{
    const v=await open(),boot=tally(v);
    assert.match(v.row('D.C.'),/ALIVE/);
    v.rows[0]=svRow(republished('ARI'),8);
    let from=v.calls.length;await v.refresh();
    const t=tally(v,from);
    assert.deepEqual([t.index,t.row,t.rulings,t.score],[1,1,3,boot.score],'one snapshot, then exactly the score feeds a fresh load reads');
    assert.deepEqual(rowWeeks(v,from),[['eq.2026','eq.2']]);
    assert.match(v.row('D.C.'),/OUT/);assert.match(v.row('D.C.'),/ARI lost in Week 2/);
    current(v,'installed',8);
    assert.deepEqual(v.historyCalls,[],'the URL is unchanged');
    from=v.calls.length;await v.refresh();await v.refresh();
    assert.equal(tally(v,from).row,0,'later unchanged ticks never download the snapshot again');
    // Nothing of revision 7 is left: the view is exactly a fresh load of revision 8. (Last: the fresh view takes the document.)
    const installed={...page(v),meta:meta(v)},fresh=await open({rows:[svRow(republished('ARI'),8)]});
    assert.deepEqual(installed,{...page(fresh),meta:meta(fresh)},'the installed revision renders exactly as a fresh load of it');
  });
  await regression('a newer revision that cannot be loaded (HTTP 500) leaves revision 7 on screen, marked PUBLISHED DATA STALE and never LIVE; each later refresh retries it until it installs',async()=>{
    const v=await open(),before=page(v);
    v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>httpError(500);
    let from=v.calls.length;await v.refresh();
    assert.equal(tally(v,from).row,1);
    assert.deepEqual(page(v),before,'revision 7 still decides every entry');
    stale(v,'HTTP 500');
    from=v.calls.length;await v.refresh();
    assert.equal(tally(v,from).row,1,'the next refresh retries revision 8');stale(v,'still failing');
    delete v.hooks.row;await v.refresh();
    current(v,'installed on retry',8);assert.match(v.row('D.C.'),/ARI lost in Week 2/);
  });
  await regression('a newer snapshot that fails validation or is not exactly the published week is never installed: revision 7 stays on screen, marked stale',async()=>{
    for(const [label,setup] of [
      ['a snapshot that fails validation',v=>{const bad=republished('ARI');bad.trackedEntries.pop();v.rows[0]=svRow(bad,8)}],
      ['a response that is not JSON',v=>{v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected token < in JSON at position 0')}})}],
      ['a response that is not a list',v=>{v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>json(svRow(republished('ARI'),8))}],
      ['no row',v=>{v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>json([])}],
      ['two rows',v=>{v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>json([svRow(republished('ARI'),8),svRow(republished('ARI'),8)])}],
      ['a row of another week',v=>{v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>json([{...svRow(republished('ARI'),8),week:1}])}],
      ['a row that is not locked',v=>{v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>json([svRow(republished('ARI'),8,{status:'draft'})])}],
      ['a row older than the published revision',v=>{v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>json([svRow(config,7)])}]
    ]){
      const v=await open(),before=page(v);
      setup(v);
      const from=v.calls.length;await v.refresh();
      assert.equal(tally(v,from).row,1,`${label}: the newer snapshot is requested`);
      assert.deepEqual(page(v),before,`${label}: revision 7 still decides every entry`);
      stale(v,label);
    }
  });
  await regression('an index that is unusable, ambiguous or goes backwards is never trusted: no snapshot is downloaded, revision 7 and the selector stay, marked stale, and a usable index clears it',async()=>{
    const id=(o={})=>({season:2026,week:2,revision:8,published_at:PUBLISHED_AT,status:'locked',...o});
    for(const [label,answer] of [
      ['the index request fails (HTTP 503)',()=>httpError(503)],
      ['the index request never reaches the server',()=>{throw new TypeError('Failed to fetch')}],
      ['an index that is not a list',()=>json({rows:[id()]})],
      ['the selected week listed twice',()=>json([id(),id({revision:9})])],
      ['a revision that is not an integer',()=>json([id({revision:8.5})])],
      ['a revision given as text',()=>json([id({revision:'8'})])],
      ['revision 0',()=>json([id({revision:0})])],
      ['another week at revision 0',()=>json([id(),id({week:3,revision:0})])],
      ['another row numbered week 0',()=>json([id(),id({week:0,revision:1})])],
      ['another row numbered season 0',()=>json([id(),id({season:0,week:3,revision:1})])],
      ['a row that is not locked',()=>json([id({status:'draft'})])],
      ['a season given as text',()=>json([id({season:'2026'})])],
      ['another row whose week is not an integer',()=>json([id(),id({week:2.5})])],
      ['the selected week missing',()=>json([id({week:3,revision:1})])],
      ['an empty index',()=>json([])],
      ['a revision older than the one on screen',()=>json([id({revision:6})])],
      ['a revision older than the one on screen, listed with a new week',()=>json([id({revision:6}),id({week:3,revision:1})])]
    ]){
      const v=await open(),before={...page(v),options:options(v),selected:v.$('survivorWeekSelect').value};
      v.rows[0]=svRow(republished('ARI'),8);v.hooks.index=answer;
      const from=v.calls.length;await v.refresh();
      assert.equal(tally(v,from).row,0,`${label}: no snapshot is downloaded`);
      assert.deepEqual({...page(v),options:options(v),selected:v.$('survivorWeekSelect').value},before,`${label}: revision 7 and the selector are unchanged`);
      stale(v,label);
      delete v.hooks.index;v.rows[0]=svRow(config,7);await v.refresh();
      current(v,`${label}: a usable index verifying revision 7 again`,7);
    }
  });
  await regression('a stale publication never hides a more serious state: ON HOLD, RESULT FEED UNAVAILABLE, unverified results and RULINGS STALE keep their place, and PUBLISHED DATA STALE rides along with each',async()=>{
    const staleNext=v=>{v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>httpError(500)};
    const shows=(v,label,feed)=>{
      assert.equal(v.$('svFeed').textContent,feed,`${label}: the feed status`);
      assert.match(v.$('svFeed').className,/\bwarn\b/,label);
      assert.equal(meta(v),'Week 2 · revision 7 · PUBLISHED DATA STALE',`${label}: the revision on screen is marked stale`);
      assert.match(notices(v),/PUBLISHED DATA STALE · /,`${label}: the publication notice`);
    };
    // ON HOLD: the rules and rulings never loaded on this page.
    const hold=await open({store:rulingStore({nfl_incident_rulings:503})});staleNext(hold);await hold.refresh();
    shows(hold,'ON HOLD','ON HOLD · RULING DATA UNAVAILABLE · PUBLISHED DATA STALE');
    assert.match(hold.$('svSummaryNote').textContent,/^ON HOLD · Ruling data unavailable/,'ON HOLD: the summary still says so');
    // A Week 2 final with no score: one team result cannot be verified.
    const unverified=await open();staleNext(unverified);unverified.feeds[2]=week(W2,2,{SF:(a,h,n)=>game(a,h,n,{as:null,hs:''})});await unverified.refresh();
    shows(unverified,'an unverified result','PUBLISHED DATA STALE · 1 TEAM RESULT UNVERIFIED');
    // RULINGS STALE: a ruling refresh fails after a verified load.
    const rulings=await open();staleNext(rulings);rulings.store.nfl_incident_rulings=503;await rulings.refresh();
    shows(rulings,'RULINGS STALE','PUBLISHED DATA STALE · RULINGS STALE');
    // RESULT FEED UNAVAILABLE, and then with the rulings stale as well.
    const down=await open();staleNext(down);delete down.feeds[2];await down.refresh();
    shows(down,'RESULT FEED UNAVAILABLE','RESULT FEED UNAVAILABLE · PUBLISHED DATA STALE');
    down.store.nfl_incident_rulings=503;await down.refresh();
    shows(down,'RESULT FEED UNAVAILABLE and RULINGS STALE','RESULT FEED UNAVAILABLE · PUBLISHED DATA STALE · RULINGS STALE');
  });
  await regression('a newly published week enters the selector without moving the participant: no automatic switch, no URL change, no download of its snapshot',async()=>{
    const v=await open(),before=page(v);
    assert.deepEqual(options(v),['2026-2']);
    v.rows.push(svRow(wk3(),1));
    const from=v.calls.length;await v.refresh();await v.refresh();
    assert.deepEqual(options(v),['2026-2','2026-3'],'Week 3 appears once, after Week 2');
    assert.equal(v.$('survivorWeekSelect').value,'2026-2','Week 2 stays selected');
    assert.deepEqual(v.historyCalls,[],'the URL is never rewritten');
    assert.equal(tally(v,from).row,0,'Week 3 is not downloaded until it is chosen');
    assert.deepEqual(page(v),before,'Week 2 is untouched');
    current(v,'new week listed',7);
  });
  await regression('choosing a week downloads and validates exactly that snapshot before it replaces the week on screen, and the URL follows the choice',async()=>{
    const v=await open({rows:[svRow(config,7),svRow(wk3(),2)],search:'?view=survivor&sw=2&season=2026'});
    const from=v.calls.length;await choose(v,'2026-3');
    assert.deepEqual(rowWeeks(v,from),[['eq.2026','eq.3']],"exactly the chosen week's snapshot");
    assert.equal(meta(v),'Week 3 · revision 2');
    assert.equal(v.$('survivorWeekSelect').value,'2026-3');
    const url=new URL(v.historyCalls.at(-1)?.[1]??'https://example.test/');
    assert.deepEqual([url.searchParams.get('view'),url.searchParams.get('sw'),url.searchParams.get('season')],['survivor','3','2026'],'the URL names the chosen week');
  });
  await regression('a chosen week that cannot be loaded keeps the week on screen: the selector goes back, an explicit error is shown, nothing is reset and the URL is unchanged',async()=>{
    const v=await open({rows:[svRow(config,7),svRow(wk3(),2)],search:'?view=survivor&sw=2&season=2026'}),before=page(v);
    v.hooks.row=u=>u.searchParams.get('week')==='eq.3'?httpError(500):undefined;
    await choose(v,'2026-3');
    assert.equal(v.$('survivorWeekSelect').value,'2026-2','the selector shows the week on screen again');
    assert.match(notices(v),/Unable to switch Survivor week/,'an explicit error');
    assert.deepEqual(page(v),before,'Week 2 is untouched');
    assert.equal(meta(v),'Week 2 · revision 7');
    assert.deepEqual(v.historyCalls,[],'the URL is unchanged');
    // The error stays until the next choice, even when a newer revision of the week on screen installs meanwhile.
    v.rows[0]=svRow(republished('ARI'),8);await v.refresh();
    assert.equal(meta(v),'Week 2 · revision 8','revision 8 installs');
    assert.match(notices(v),/Unable to switch Survivor week/,'the failed choice is still reported');
    delete v.hooks.row;await choose(v,'2026-3');
    assert.equal(meta(v),'Week 3 · revision 2','the next choice clears it');assert.doesNotMatch(notices(v),/Unable to switch/);
  });
  await regression('a week chosen while the first week is still loading takes the view over; the first week arriving later changes nothing',()=>withSlowLimits(async()=>{
    const late=deferred();
    const v=await view(feeds(),[svRow(config,7),svRow(wk3(),2)],patched,rulingStore(),{search:'?view=survivor&sw=2&season=2026',bootHooks:{row:u=>u.searchParams.get('week')==='eq.2'?late.promise:undefined}});
    assert.deepEqual(options(v),['2026-2','2026-3'],'the selector is filled from the index first');
    assert.doesNotMatch(meta(v),/revision/,'Week 2 is still on its way');assert.equal(notices(v),'','and nothing timed out');
    await choose(v,'2026-3');
    assert.equal(meta(v),'Week 3 · revision 2');
    late.resolve(json([svRow(config,7)]));await flush();await flush();
    assert.equal(meta(v),'Week 3 · revision 2','Week 2 arriving last changes nothing');
    assert.equal(v.$('survivorWeekSelect').value,'2026-3');
    assert.deepEqual(v.historyCalls.map(([,u])=>new URL(u).searchParams.get('sw')),['3'],'the URL only ever names Week 3');
  }));
  await regression('a late response for an older revision never overwrites a newer one',()=>withSlowLimits(async()=>{
    const v=await open(),late=deferred();
    v.rows[0]=svRow(republished('ARI'),8);v.hooks.row=()=>late.promise;
    await v.refresh();
    assert.equal(meta(v),'Week 2 · revision 7','revision 8 is still on its way: nothing installed, nothing timed out');
    // Revision 8's snapshot is still on its way and its refresh has run past any stall limit, so the next tick replaces it.
    const realNow=Date.now;Date.now=()=>realNow()+60000;
    try{
      v.rows[0]=svRow(republished('BUF'),9);delete v.hooks.row;
      await v.refresh();
      assert.match(meta(v),/^Week 2 · revision 9\b/);
      late.resolve(json([svRow(republished('ARI'),8)]));await flush();await flush();
      assert.match(meta(v),/^Week 2 · revision 9\b/,'revision 8 arriving last changes nothing');
      assert.match(v.row('D.C.'),/ALIVE/,'D.C. holds BUF (revision 9), never ARI (revision 8)');
      assert.match(v.row('D.C.'),/<small>W2<\/small>BUF/);
    }finally{Date.now=realNow}
  }));
  await regression('a late response for a week the participant has since moved away from never replaces their newer choice',()=>withSlowLimits(async()=>{
    const wk1=()=>{const c=structuredClone(config);c.week=1;c.label='Survivor Week 1';for(const e of [...c.trackedEntries,...c.fieldEntries])e.picks=e.picks.slice(0,1);c.currentWeekEntryCount=6;return c};
    const v=await open({rows:[svRow(wk1(),1),svRow(config,7),svRow(wk3(),2)],search:'?view=survivor&sw=2&season=2026'}),late=deferred();
    v.hooks.row=u=>u.searchParams.get('week')==='eq.1'?late.promise:undefined;
    await choose(v,'2026-1');
    assert.equal(meta(v),'Week 2 · revision 7','Week 1 is still on its way: nothing installed');assert.doesNotMatch(notices(v),/Unable to switch/,'and nothing timed out');
    await choose(v,'2026-3');
    assert.equal(meta(v),'Week 3 · revision 2');
    late.resolve(json([svRow(wk1(),1)]));await flush();await flush();
    assert.equal(meta(v),'Week 3 · revision 2','Week 1 arriving last changes nothing');
    assert.equal(v.$('survivorWeekSelect').value,'2026-3');
    assert.deepEqual(v.historyCalls.map(([,u])=>new URL(u).searchParams.get('sw')),['3'],'the URL only ever names Week 3');
  }));

  assert.equal(failures.length,0,`HDC-15 Survivor refresh-lifecycle regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('survivor HDC-15 publication index, atomic revision install, published-data stale state, new-week discovery, week switching, request budget, visibility and active-view polling and late-response regressions passed');


// HDC-15. The whole Pool Center page: weekly-app.js and survivor-app.js loaded into one document, as index.html loads them,
// sharing the bottom navigation, the document's visibility, the timers and the network. Every request is logged by the app
// that sent it (its publication table, its contest's rules and rulings, its score feed). Only the active view's app polls,
// only while the page is visible; becoming visible, entering Survivor and leaving it each run exactly one full refresh, of
// the active app only, even when the timers fire at the same moment.
const weeklySource=readFileSync(new URL('./weekly-app.js',import.meta.url),'utf8')
  .replace(/from '\.\/(public-math|contest-rulings)\.js\?v=(\d+)';/g,(_,name,version)=>`from '${new URL(`./${name}.js?v=${version}`,import.meta.url).href}';`);
assert(!/from '\.\//.test(weeklySource),'the page harness points every weekly-app import at its file');
class PageEl{
  constructor(){this.text='';this.innerHTML='';this.className='';this.value='';this.hidden=false;this.disabled=false;this.style={};this.listeners={};this.children=[]}
  get textContent(){return this.text}
  set textContent(v){this.text=v==null?'':String(v)}
  addEventListener(t,f){(this.listeners[t]||=[]).push(f)}
  replaceChildren(...nodes){this.children=[...nodes]}
  appendChild(node){this.children.push(node);return node}
}
const PK_CONTEST='pool-center-2026-pickem';
const pickemRulingStore=()=>({
  nfl_contests:[{contest_id:PK_CONTEST,season:2026,contest_type:'pickem',display_name:"Pool Center 2026 Pick'em",starts_at:'2026-09-01T00:00:00+00:00',created_at:'2026-10-08T12:00:00+00:00'}],
  nfl_contest_policies:[{contest_id:PK_CONTEST,contest_type:'pickem',revision:1,effective_week:1,halted_game_policy:'void',public_note:'Approved policy for this contest.',created_at:'2026-10-08T12:00:00+00:00'}],
  nfl_incident_rulings:[]
});
const pickemWeek={schemaVersion:1,season:2026,week:3,tiebreakGameIndex:0,games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-27'}],
  participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1],tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2],tiebreak:44}]};
const pickemFeed={events:[{id:'den-kc',season:{year:2026,type:2},week:{number:3},status:{type:{state:'post',completed:true,shortDetail:'Final'}},
  competitions:[{competitors:[{homeAway:'away',team:{abbreviation:'DEN'},score:'24'},{homeAway:'home',team:{abbreviation:'KC'},score:'17'}]}]}]};
// respond(app, kind, url, init, answer) may answer a request later (the HDC-15 slow-network regressions at the end of this
// file); by default every request is answered at once, as before.
async function poolPage(view,{respond=(app,kind,u,init,answer)=>answer}={}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new PageEl());return els.get(id)},listeners={},timers=[],calls=[];
  const doc={body:{dataset:{}},title:'',visibilityState:'visible',getElementById:$,querySelectorAll(){return[]},createElement(){return new PageEl()},
    addEventListener(t,f){(listeners[t]||=[]).push(f)},dispatchEvent(e){for(const f of listeners[e.type]||[])f(e);return true}};
  globalThis.document=doc;
  globalThis.window={addEventListener(){},scrollTo(){}};
  globalThis.location={href:`https://example.test/nfl-pool/?view=${view}`,search:`?view=${view}`};
  globalThis.history={state:null,pushState(){},replaceState(){}};
  globalThis.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length};
  const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.y';
  const rows={pickem:[{season:2026,week:3,status:'locked',revision:1,published_at:null,config:structuredClone(pickemWeek)}],survivor:[{season:2026,week:2,status:'locked',revision:7,published_at:null,config:structuredClone(config)}]};
  const stores={pickem:pickemRulingStore(),survivor:rulingStore()},feeds={1:week(W1,1),2:week(W2,2),3:week(W3,3)};
  globalThis.fetch=async (url,init={})=>{
    const u=new URL(url),log=(app,kind)=>calls.push({app,kind});
    if(u.pathname.endsWith('/token/anonymous')){log('auth','token');return{ok:true,json:async()=>({token})}}
    for(const [table,app] of [['nfl_pool_weeks','pickem'],['nfl_survivor_weeks','survivor']])
      if(u.pathname.endsWith(`/${table}`)){const kind=publicationKind(u);log(app,kind);return respond(app,kind,u,init,publicationApi(rows[app],u))}
    const table=Object.keys(RULING_COLUMNS).find(t=>u.pathname.endsWith(`/${t}`));
    if(table){const app=u.searchParams.get('contest_id')===`eq.${PK_CONTEST}`?'pickem':'survivor';log(app,'rulings');return respond(app,'rulings',u,init,dataApi(table,stores[app][table],u))}
    // The Pick'em score feed asks for limit=100; Survivor's week feeds do not.
    if(u.searchParams.has('limit')){log('pickem','score');return respond('pickem','score',u,init,{ok:true,status:200,json:async()=>structuredClone(pickemFeed)})}
    log('survivor','score');const payload=feeds[Number(u.searchParams.get('week'))];
    return respond('survivor','score',u,init,payload?{ok:true,status:200,json:async()=>structuredClone(payload)}:{ok:false,status:404,json:async()=>({})});
  };
  await import(`data:text/javascript;base64,${Buffer.from(weeklySource+`\n//page ${++instance}`).toString('base64')}`);
  await import(`data:text/javascript;base64,${Buffer.from(patched+`\n//page ${++instance}`).toString('base64')}`);
  await flush();
  return{
    $,doc,calls,timers,
    tally:(from=0)=>{const t={pickem:{index:0,row:0,rulings:0,score:0},survivor:{index:0,row:0,rulings:0,score:0},token:0};for(const c of calls.slice(from)){if(c.kind==='token')t.token++;else t[c.app][c.kind]++}return t},
    tickAll:()=>{for(const t of timers)t.fn()},
    click:target=>{for(const f of listeners.click||[])f({target:{closest:s=>s==='[data-view-target]'?{dataset:{viewTarget:target}}:null},preventDefault(){}})},
    setVisibility:state=>{doc.visibilityState=state;for(const f of listeners.visibilitychange||[])f({type:'visibilitychange'})}
  };
}
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const NONE={index:0,row:0,rulings:0,score:0},FULL={index:1,row:0,rulings:3,score:1};
  const only=app=>({pickem:app==='pickem'?FULL:NONE,survivor:app==='survivor'?FULL:NONE,token:0});
  await regression('page: both apps boot, each with one 20 s timer; with a Pick’em view active a visible timer refresh is Pick’em’s full refresh alone',async()=>{
    const p=await poolPage('home');
    assert.deepEqual(p.timers.map(t=>t.ms),[20000,20000],'one 20 s timer per app');
    assert.match(p.$('weekLine').textContent,/^Week 3 · revision 1 · /,'Pick’em booted');assert.equal(p.$('svMeta').textContent,'Week 2 · revision 7','Survivor booted');
    for(const view of ['home','standings','games','picks']){
      if(view!=='home')p.click(view);await flush();
      const from=p.calls.length;p.tickAll();await flush();
      assert.deepEqual(p.tally(from),only('pickem'),`${view}: the timers`);
    }
  });
  await regression('page: with Survivor active a visible timer refresh is Survivor’s full refresh alone',async()=>{
    const p=await poolPage('survivor');
    const from=p.calls.length;p.tickAll();await flush();
    assert.deepEqual(p.tally(from),only('survivor'));
  });
  await regression('page: a hidden page makes no timer request from either app',async()=>{
    for(const view of ['home','survivor']){
      const p=await poolPage(view);p.setVisibility('hidden');
      const from=p.calls.length;p.tickAll();p.tickAll();await flush();
      assert.deepEqual(p.calls.slice(from),[],view);
    }
  });
  await regression('page: becoming visible runs exactly one full refresh, of the active app only, even with both timers firing at the same moment',async()=>{
    for(const [view,app] of [['home','pickem'],['games','pickem'],['survivor','survivor']]){
      const p=await poolPage(view);p.setVisibility('hidden');
      let from=p.calls.length;p.setVisibility('visible');await flush();
      assert.deepEqual(p.tally(from),only(app),`${view}: resume`);
      p.setVisibility('hidden');from=p.calls.length;p.setVisibility('visible');p.tickAll();await flush();
      assert.deepEqual(p.tally(from),only(app),`${view}: resume and both timers together`);
    }
  });
  await regression('page: entering Survivor runs one Survivor full refresh and leaving it one Pick’em full refresh; moving between Pick’em views runs none; timers at the same moment add none',async()=>{
    const p=await poolPage('home');
    let from=p.calls.length;p.click('survivor');await flush();
    assert.deepEqual(p.tally(from),only('survivor'),'Home → Survivor');
    from=p.calls.length;p.click('standings');await flush();
    assert.deepEqual(p.tally(from),only('pickem'),'Survivor → Standings');
    from=p.calls.length;p.click('games');p.click('picks');p.click('home');await flush();
    assert.deepEqual(p.calls.slice(from),[],'between Pick’em views');
    from=p.calls.length;p.click('survivor');p.tickAll();await flush();
    assert.deepEqual(p.tally(from),only('survivor'),'Survivor entered as the timers fire');
    from=p.calls.length;p.click('picks');p.tickAll();await flush();
    assert.deepEqual(p.tally(from),only('pickem'),'Survivor left as the timers fire');
  });

  assert.equal(failures.length,0,`HDC-15 page refresh-ownership regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('pool page HDC-15 single-owner polling, hidden-page silence, one-refresh resume and view-activation regressions passed');


// A virtual clock for the HDC-15 remediation regressions below (as in weekly-app.test.mjs). Every timer keeps its real
// duration and fires in time order as the clock advances; timers due at the same moment fire in the order they were set (a
// repeating timer is set again as it fires, before it runs), as in a browser, and every promise settles before the next
// timer fires. Date.now() and new Date() read the virtual time. A 0 ms timer (the harness's flush) is left to the real
// event loop. jump() is a frozen page: time passes and no timer fires; when the clock next advances, each overdue timer fires
// once, in order. Installing it replaces this file's shortened timers until restore().
function virtualClock(){
  const real={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,Date:globalThis.Date},RealDate=real.Date,timers=new Map();
  let now=RealDate.parse('2026-10-11T17:00:00.000Z'),seq=0;
  const add=(fn,ms,args,every)=>{const id=++seq;timers.set(id,{fn,args,every,at:now+Math.max(0,Number(ms)||0),seq:id});return id};
  class VirtualDate extends RealDate{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}
  globalThis.setTimeout=(fn,ms,...args)=>Number(ms)>0?add(fn,ms,args,0):real.setTimeout(fn,0,...args);
  globalThis.clearTimeout=id=>{if(!timers.delete(id))real.clearTimeout(id)};
  globalThis.Date=VirtualDate;
  const settle=async()=>{for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r))};
  const next=end=>{let hit=null;for(const [id,t] of timers)if(t.at<=end&&(!hit||t.at<hit.t.at||(t.at===hit.t.at&&t.seq<hit.t.seq)))hit={id,t};return hit};
  return{
    now:()=>now,
    every:(ms,fn)=>add(fn,ms,[],ms),
    async advance(ms){
      const end=now+ms;await settle();
      for(let hit=next(end);hit;hit=next(end)){
        const {id,t}=hit;now=Math.max(now,t.at);
        if(t.every){t.at=now+t.every;t.seq=++seq}else timers.delete(id);
        t.fn(...t.args);await settle();
      }
      now=end;await settle();
    },
    jump(ms){now+=ms},
    restore(){globalThis.setTimeout=real.setTimeout;globalThis.clearTimeout=real.clearTimeout;globalThis.Date=real.Date}
  };
}

// HDC-15 remediation (F-1, refresh starvation) in Survivor and on the whole page. The rejected candidate (60760a1) let a timer
// tick replace any refresh still running 15 s after it started, while a full Survivor refresh runs up to three requests one
// after another (the publication index, the snapshot of a changed revision, then the score feeds with the rules and rulings
// side by side), each allowed 15 s. At 10-14 s a request no refresh completed after boot, so the feed status stayed on its
// last "LIVE · NFL results" and a score feed that never answered never reached RESULT FEED UNAVAILABLE; and a publication
// found stale left the feed status saying LIVE until the scores came back. These regressions run on the virtual clock above,
// which keeps every real duration; nothing is shortened. Each regression reports through one collector; the block fails at
// its end if any did.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const S=1000,PERIOD=20*S,LIMIT=15*S,PUBLISHED_AT='2026-09-21T19:30:44.641+00:00',LIVE='LIVE · NFL results';
  const svRow=(cfg,revision)=>({season:cfg.season,week:cfg.week,status:'locked',revision,published_at:PUBLISHED_AT,locked_at:PUBLISHED_AT,config:structuredClone(cfg)});
  // Revision 8 republishes D.C.'s Week 2 pick as ARI, which lost to SF. A Week 3 snapshot: the Week 2 field plus its Week 3 picks.
  const republished=team=>{const c=structuredClone(config);c.trackedEntries[0].picks=['PIT',team];return c};
  const wk3=()=>{
    const c=structuredClone(config);c.week=3;c.label='Survivor Week 3';
    const third={dc:'DEN',djs:'MIA',thaddeus:null,'survivor-001':'PIT','survivor-002':null,'survivor-003':null};
    for(const e of [...c.trackedEntries,...c.fieldEntries])e.picks.push(third[e.id]);
    c.currentWeekEntryCount=3;return c;
  };
  const FEEDS={1:week(W1,1),2:week(W2,2),3:week(W3,3)};
  const json=data=>({ok:true,status:200,json:async()=>structuredClone(data)}),httpError=status=>({ok:false,status,json:async()=>({})});
  // A request answered lag(kind, request) ms after it is sent (Infinity: never), with the answer given when it was sent; one
  // the page abandons fails at once with an AbortError, as fetch does, unless deaf(kind, request): a response already on its
  // way, which arrives anyway. Each is logged in life with its kind, url, when it was sent, when it ended and how.
  const network=(clock,life,lag,deaf,tokenLag=()=>0)=>(kind,url,init,response,app)=>{
    const rec={kind,url,app,sent:clock.now(),ended:null,how:'open'};life.push(rec);
    const ms=kind==='token'?tokenLag(rec):lag(kind,rec),signal=deaf(kind,rec)?null:init?.signal;
    return new Promise((resolve,reject)=>{
      const answer=()=>{signal?.removeEventListener('abort',abandoned);rec.ended=clock.now();rec.how='answered';resolve(response)};
      let timer=null;
      function abandoned(){if(timer!==null)clearTimeout(timer);rec.ended=clock.now();rec.how='aborted';const e=new Error('The operation was aborted.');e.name='AbortError';reject(e)}
      if(signal?.aborted)return abandoned();
      if(ms===0)return answer();
      signal?.addEventListener('abort',abandoned,{once:true});
      if(signal)EARLY.set(signal,[...(EARLY.get(signal)||[]),()=>{if(timer!==null)clearTimeout(timer);rec.ended=clock.now();rec.how='aborted';reject(new DOMException('The operation was aborted.','AbortError'))}]);
      if(Number.isFinite(ms))timer=setTimeout(answer,ms);
    });
  };
  // An engine whose fetch follows the caller's signal through an abort algorithm, run before the signal's 'abort' event (the
  // DOM's earlier "follow" model): aborting a controller first rejects each request it was given with the engine's own
  // AbortError, and only then do the signal's 'abort' listeners run. Chromium runs the listeners first; the page must tell
  // a time limit from a superseded refresh either way.
  const EARLY=new WeakMap();
  const abortAlgorithmsFirst=async check=>{
    const native=AbortController.prototype.abort;
    AbortController.prototype.abort=function(...a){for(const reject of EARLY.get(this.signal)||[])reject();return native.apply(this,a)};
    try{await check()}finally{AbortController.prototype.abort=native}
  };
  const watcher=(clock,seen)=>(label,el,prop)=>{let value=el[prop];seen.push({t:clock.now(),label,value});Object.defineProperty(el,prop,{configurable:true,enumerable:true,get:()=>value,set:x=>{value=prop==='textContent'?(x==null?'':String(x)):x;seen.push({t:clock.now(),label,value})}})};
  const logTools=(life,S0=0)=>({
    tally:(from=0,until=Infinity)=>{const t={index:0,row:0,rulings:0,score:0};for(const r of life.slice(from))if(r.sent<=until&&r.kind in t)t[r.kind]++;return t},
    // Requests abandoned (the week-ahead schedule, which no refresh waits for, is left out), with how long after being sent.
    aborted:(from=0)=>life.slice(from).filter(r=>r.how==='aborted'&&r.kind!=='schedule').map(r=>({kind:r.kind,sent:r.sent,after:r.ended-r.sent})),
    tokens:(from=0)=>life.slice(from).filter(r=>r.kind==='token').length,
    maxOpen:(from=0)=>{const out={index:0,row:0,rulings:0,score:0},list=life.slice(from).filter(r=>r.kind in out);for(const r of list){const n=list.filter(x=>x.kind===r.kind&&x.sent<=r.sent&&(x.ended===null||x.ended>r.sent)).length;out[r.kind]=Math.max(out[r.kind],n)}return out},
    trace:(from=0,t0=S0)=>life.slice(from).map(r=>`${r.kind}${r.kind==='score'||r.kind==='schedule'?r.url.searchParams.get('week'):''}@${(r.sent-t0)/S}-${r.ended===null?'open':(r.ended-t0)/S}:${r.how}`).join(' ')
  });
  // The Survivor refreshes that completed after seen[from]: a refresh writes the feed status and renders the view at once
  // (installing a snapshot writes LOADING RESULTS; marking the publication stale renders nothing).
  const svSettled=(seen,from=0)=>{const out=[];let feed=null;seen.forEach((s,i)=>{if(s.label==='feed')feed={t:s.t,value:s.value,i,cls:null,counted:false};else if(s.label==='feedClass'&&feed)feed.cls=s.value;else if(s.label==='summary'&&feed&&!feed.counted&&s.t===feed.t&&feed.value!=='LOADING RESULTS'){feed.counted=true;if(feed.i>=from)out.push({t:feed.t,feed:feed.value,cls:feed.cls})}});return out};
  // A Survivor page on the virtual clock, visible, its 20 s timer running on the clock from boot. Every publication read,
  // rules and rulings read and score-feed request goes through network(); answer[kind](url) can replace the default answer.
  // A score-feed request for a week after the one on screen is the week-ahead schedule the page loads after its scores
  // without waiting for it: its own kind, 'schedule'. Every change to the feed status, its class, the meta line and the
  // summary is logged with its time. The anonymous token is minted at boot and stays valid throughout.
  const slowSurvivor=async({lag=()=>0,tokenLag=()=>0,deaf=()=>false,rows=[svRow(config,7)],search='?view=survivor'}={})=>{
    const clock=virtualClock(),life=[],seen=[],ticks=[],answer={};let v=null;
    try{
      const send=network(clock,life,lag,deaf,tokenLag);
      const shown=()=>{const m=/^Week (\d+)/.exec(globalThis.document.getElementById('svMeta').textContent);return m?Number(m[1]):Infinity};
      const espn=(u,init)=>{const w=Number(u.searchParams.get('week')),kind=w>shown()?'schedule':'score';return send(kind,u,init,answer[kind]?.(u)??(FEEDS[w]?json(FEEDS[w]):httpError(404)))};
      const published=()=>structuredClone(v?v.rows:rows);
      const rulings=table=>(u,init)=>send('rulings',u,init,answer.rulings?.(u)??dataApi(table,rulingStore()[table],u));
      const store={nfl_contests:rulings('nfl_contests'),nfl_contest_policies:rulings('nfl_contest_policies'),nfl_incident_rulings:rulings('nfl_incident_rulings')};
      const hooks={index:(u,init)=>send('index',u,init,answer.index?.(u)??publicationApi(published(),u)),row:(u,init)=>send('row',u,init,answer.row?.(u)??publicationApi(published(),u)),score:espn,
        token:(u,init,reply)=>send('token',u,init,reply)};
      v=await view(FEEDS,rows,patched,store,{search,bootHooks:hooks});
      // From boot on, fetch returns the request's own promise, as a browser's fetch does (the harness's async fetch adds
      // promise ticks a browser does not); only the anonymous token still goes through the harness.
      const harnessFetch=globalThis.fetch;
      globalThis.fetch=(url,init={})=>{
        const u=new URL(url),table=Object.keys(RULING_COLUMNS).find(t=>u.pathname.endsWith(`/${t}`));
        if(u.pathname.endsWith('/nfl_survivor_weeks'))return publicationKind(u)==='row'?hooks.row(u,init):hooks.index(u,init);
        if(table)return store[table](u,init);
        if(u.pathname.endsWith('/scoreboard'))return hooks.score(u,init);
        return harnessFetch(url,init);
      };
      const watch=watcher(clock,seen);
      watch('feed',v.$('svFeed'),'textContent');watch('feedClass',v.$('svFeed'),'className');watch('meta',v.$('svMeta'),'textContent');watch('summary',v.$('svSummaryNote'),'textContent');
      v.doc.visibilityState='visible';
      const start=clock.now();clock.every(PERIOD,()=>{ticks.push(clock.now());v.tick()});
      return{v,clock,life,seen,ticks,answer,...logTools(life),
        feed:()=>v.$('svFeed').textContent,feedClass:()=>v.$('svFeed').className,meta:()=>v.$('svMeta').textContent,notices:()=>v.$('survivorError').innerHTML,
        toNextTick:()=>(ticks.length?ticks[ticks.length-1]:start)+PERIOD-clock.now(),
        settled:(from=0)=>svSettled(seen,from),
        feeds:(from=0)=>seen.slice(from).filter(s=>s.label==='feed').map(s=>[s.t,s.value])};
    }catch(error){clock.restore();throw error}
  };
  const onSlow=async(options,check)=>{const p=await slowSurvivor(options);try{await check(p)}finally{p.clock.restore()}};
  const choose=(v,value)=>{const select=v.$('survivorWeekSelect');select.value=value;for(const fn of select.listeners.change||[])fn()};
  const FULL={index:1,row:0,rulings:3,score:1};

  for(const L of [10,11,12,14]){
    await regression(`${L} s a request: a healthy Survivor refresh (the index, then the score feed with the rules and rulings: ${2*L} s) completes, the timer ticks while it runs join it instead of replacing it, nothing is abandoned, and six timer periods complete at least two refreshes`,()=>onSlow({lag:()=>L*S},async p=>{
      await p.clock.advance(3*L*S);
      assert.equal(p.feed(),LIVE,'boot (the index, the snapshot, then the score feeds with the rules and rulings) completes');
      const from=p.seen.length,sent=p.life.length,t0=p.clock.now();
      await p.clock.advance(6*PERIOD);
      const done=p.settled(from),starts=p.life.slice(sent).filter(r=>r.kind==='index').map(r=>r.sent);
      assert(done.length>=2,`completed refreshes: ${done.length}, want at least 2; requests: ${p.trace(sent,t0)}`);
      for(const d of done)assert.deepEqual([d.feed,d.cls],[LIVE,'survivor-feed ok'],`the refresh completed at +${(d.t-t0)/S} s`);
      assert.deepEqual(p.aborted(sent),[],'no request is abandoned');
      starts.slice(1).forEach((s,k)=>assert(s>=done[k].t,`refresh ${k+2} started at +${(s-t0)/S} s, before refresh ${k+1} completed at +${(done[k].t-t0)/S} s`));
      assert(starts.length===done.length||starts.length===done.length+1,`${starts.length} refreshes started, ${done.length} completed`);
      done.forEach((d,k)=>assert.deepEqual(p.tally(sent,d.t),Object.fromEntries(Object.entries(FULL).map(([kind,n])=>[kind,n*(k+1)])),`requests through refresh ${k+1}: one index, the three HDC-12 tables and the current week's score feed each, never a snapshot`));
      assert.deepEqual(p.maxOpen(sent),FULL,'one refresh at a time');
    }));
  }

  for(const L of [12,14]){
    await regression(`a republished Survivor revision (7 → 8) over ${L} s a request (the index, the snapshot, then the score feeds with the rules and rulings: ${3*L} s) is installed whole and its refresh completes; the timer ticks during it join it and nothing is abandoned`,()=>onSlow({lag:()=>L*S},async p=>{
      await p.clock.advance(3*L*S);
      assert.equal(p.meta(),'Week 2 · revision 7');assert.equal(p.feed(),LIVE,'boot completes');
      p.v.rows[0]=svRow(republished('ARI'),8);
      const from=p.seen.length,sent=p.life.length;
      await p.clock.advance(p.toNextTick());const T=p.clock.now();
      await p.clock.advance(3*L*S);
      assert.deepEqual(p.settled(from).map(d=>[(d.t-T)/S,d.feed]),[[3*L,LIVE]],`one refresh, completed at ${3*L} s; requests: ${p.trace(sent,T)}`);
      assert.equal(p.meta(),'Week 2 · revision 8');assert.match(p.v.row('D.C.'),/OUT/);assert.match(p.v.row('D.C.'),/ARI lost in Week 2/);
      assert.deepEqual(p.tally(sent),{index:1,row:1,rulings:3,score:2},'the index, the snapshot of revision 8, then the score feeds a fresh load reads; the ticks during it sent nothing');
      assert.deepEqual(p.aborted(sent),[],'nothing is abandoned');
    }));
  }

  for(const X of [0,8,12]){
    await regression(`a current-week Survivor score feed that never answers, after an index answering in ${X} s: RESULT FEED UNAVAILABLE at the feed’s 15 s limit (${X+15} s), not before; never LIVE again, and each later refresh fails the same way, one score request at a time`,async()=>{
      let hang=false;
      await onSlow({lag:(kind,r)=>!hang?0:kind==='index'?X*S:kind==='score'&&r.url.searchParams.get('week')==='2'?Infinity:0},async p=>{
        await p.clock.advance(0);
        assert.equal(p.feed(),LIVE,'boot');
        hang=true;
        const from=p.seen.length,sent=p.life.length;
        await p.clock.advance(p.toNextTick());const T=p.clock.now();
        await p.clock.advance(X*S+LIMIT-1);
        assert.equal(p.feed(),LIVE,'within its 15 s limit the feed is still awaited: no failure is reported early');
        await p.clock.advance(1);
        assert.equal(p.feed(),'RESULT FEED UNAVAILABLE','at its limit the feed is abandoned and the refresh reports it');
        assert.match(p.feedClass(),/\bwarn\b/);
        await p.clock.advance(6*PERIOD-X*S-LIMIT);
        const done=p.settled(from),expected=[];
        for(let start=0;start<6*PERIOD;){const end=start+X*S+LIMIT;if(end>6*PERIOD)break;expected.push(end/S);start=Math.ceil(end/PERIOD)*PERIOD}
        assert.deepEqual(done.map(d=>(d.t-T)/S),expected,`each refresh fails at its limit and the next tick starts the next; requests: ${p.trace(sent,T)}`);
        for(const d of done)assert.equal(d.feed,'RESULT FEED UNAVAILABLE');
        assert(!p.feeds(from).some(([,text])=>/^LIVE\b/.test(text)),'never LIVE');
        assert(p.aborted(sent).every(r=>r.kind==='score'&&r.after===LIMIT),'only the time limits abandon a request');
        assert.equal(p.maxOpen(sent).score,1,'one score request at a time');
      });
    });
  }

  await regression('an outage that hangs the Survivor publication index and then the score feed: PUBLISHED DATA STALE at 15 s, in the feed status as well at once, and RESULT FEED UNAVAILABLE · PUBLISHED DATA STALE at 30 s; never LIVE; the tick in between joins the refresh',async()=>{
    let hang=false;
    await onSlow({lag:(kind,r)=>hang&&(kind==='index'||(kind==='score'&&r.url.searchParams.get('week')==='2'))?Infinity:0},async p=>{
      await p.clock.advance(0);
      const before=p.v.$('svTracked').innerHTML;
      hang=true;
      const from=p.seen.length,sent=p.life.length;
      await p.clock.advance(p.toNextTick());const T=p.clock.now();
      await p.clock.advance(LIMIT);
      assert.equal(p.meta(),'Week 2 · revision 7 · PUBLISHED DATA STALE','at 15 s the index is abandoned and the publication marked stale');
      assert.match(p.notices(),/PUBLISHED DATA STALE · the published week list could not be checked \(Survivor publication list timed out\)/);
      assert.equal(p.feed(),'PUBLISHED DATA STALE · NFL results','the feed status stops saying LIVE at once, while the scores are still awaited');
      assert.match(p.feedClass(),/\bwarn\b/);
      await p.clock.advance(LIMIT);
      assert.equal(p.feed(),'RESULT FEED UNAVAILABLE · PUBLISHED DATA STALE','at 30 s the score feed is abandoned and the refresh completes');
      assert.equal(p.v.$('svTracked').innerHTML,before,'revision 7 still decides every entry');
      await p.clock.advance(6*PERIOD-2*LIMIT);
      assert.deepEqual(p.settled(from).map(d=>[(d.t-T)/S,d.feed]),[[30,'RESULT FEED UNAVAILABLE · PUBLISHED DATA STALE'],[70,'RESULT FEED UNAVAILABLE · PUBLISHED DATA STALE'],[110,'RESULT FEED UNAVAILABLE · PUBLISHED DATA STALE']],`one refresh every two ticks; requests: ${p.trace(sent,T)}`);
      assert(!p.feeds(from).some(([t,text])=>t>T&&/^LIVE\b/.test(text)),'never LIVE');
      assert(p.aborted(sent).every(r=>r.after===LIMIT),'nothing is abandoned before its own limit: no refresh is replaced');
    });
  });

  for(const [label,setup,reason] of [
    ['the publication index cannot be read (HTTP 503)',p=>{p.answer.index=()=>httpError(503)},/the published week list could not be checked \(Survivor data 503\)/],
    ['revision 8 is published but its snapshot cannot be read (HTTP 500)',p=>{p.v.rows[0]=svRow(republished('ARI'),8);p.answer.row=()=>httpError(500)},/revision 8 is published but could not be loaded \(Survivor data 500\)/]
  ]){
    await regression(`the feed status stops saying LIVE the moment the publication is found stale, while a slow score feed is still on its way (${label}); LIVE returns only with a completed score load of a verified publication`,async()=>{
      let T=Infinity;
      await onSlow({lag:(kind,r)=>r.sent<T?0:kind==='index'||kind==='row'?1*S:12*S},async p=>{
        await p.clock.advance(0);
        assert.equal(p.feed(),LIVE,'boot');
        setup(p);
        const from=p.seen.length;
        await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
        await p.clock.advance(1);
        await p.clock.advance(3*S);
        assert.match(p.notices(),reason);
        assert.equal(p.feed(),'PUBLISHED DATA STALE · NFL results','the feed status says PUBLISHED DATA STALE at once');
        assert.match(p.feedClass(),/\bwarn\b/);
        await p.clock.advance(12*S);
        const done=p.settled(from);
        assert.equal(done.length,1,'the refresh completes');assert.equal(done[0].feed,'PUBLISHED DATA STALE · NFL results');
        assert(!p.feeds(from).some(([,text])=>/^LIVE\b/.test(text)),'never LIVE while the publication is stale');
        delete p.answer.index;delete p.answer.row;
        const back=p.seen.length;
        await p.clock.advance(p.toNextTick());const V=p.clock.now();
        await p.clock.advance(16*S);
        const live=p.feeds(back).filter(([,text])=>text===LIVE).map(([t])=>t);
        assert.deepEqual(live,p.settled(back).map(d=>d.t),'LIVE is written only by a completed score load');
        assert(live.length===1&&live[0]>=V+12*S,'and only once the score load of the verified publication completed');
      });
    });
  }

  await regression('a fast network is unchanged: each visible Survivor timer tick runs one full refresh (one index, the three HDC-12 tables, the current week’s score feed, no snapshot) that completes at the tick, LIVE, and nothing is abandoned',()=>onSlow({},async p=>{
    await p.clock.advance(0);
    for(let i=1;i<=6;i++){
      const from=p.seen.length,sent=p.life.length;
      await p.clock.advance(p.toNextTick());const T=p.clock.now();
      assert.deepEqual(p.tally(sent),FULL,`tick ${i}`);
      assert.deepEqual(p.settled(from).map(d=>[d.t-T,d.feed,d.cls]),[[0,LIVE,'survivor-feed ok']],`tick ${i}: completes at once`);
    }
    assert.deepEqual(p.aborted(0),[]);
  }));

  await regression('a Survivor refresh that reaches every phase’s full 15 s limit (the index answering at 14.9 s with revision 8, its snapshot and then the score feed never answering) is never replaced: it completes at 44.9 s with RESULT FEED UNAVAILABLE · PUBLISHED DATA STALE; ticks at 4.5, 24.5 and 44.5 s join it',async()=>{
    let T=Infinity;
    await onSlow({lag:(kind,r)=>r.sent<T?0:kind==='index'?14.9*S:kind==='row'||kind==='score'?Infinity:0},async p=>{
      await p.clock.advance(p.toNextTick()+15.5*S);
      p.v.rows[0]=svRow(republished('ARI'),8);
      const from=p.seen.length,sent=p.life.length;T=p.clock.now();
      p.v.setVisibility('hidden');p.v.setVisibility('visible');
      await p.clock.advance(46*S);
      assert.deepEqual(p.ticks.filter(t=>t>T).map(t=>(t-T)/S),[4.5,24.5,44.5]);
      assert.deepEqual(p.settled(from).map(d=>[(d.t-T)/S,d.feed]),[[44.9,'RESULT FEED UNAVAILABLE · PUBLISHED DATA STALE']],`one refresh, completed at 44.9 s; requests: ${p.trace(sent,T)}`);
      assert.equal(p.meta(),'Week 2 · revision 7 · PUBLISHED DATA STALE');
      assert.match(p.notices(),/revision 8 is published but could not be loaded \(Survivor publication timed out\)/);
      assert.deepEqual(p.tally(sent),{index:1,row:1,rulings:3,score:1},'the ticks during it sent nothing');
      assert.deepEqual(p.aborted(sent).map(r=>[r.kind,r.after/S]),[['row',15],['score',15]],'only the time limits abandon a request');
    });
  });

  await regression('a Survivor week choice that times out falls back to refreshing the week on screen, and that refresh is not replaced by the stall limit: the fallback (a republished revision, then the score feeds, 14 s a request) completes and installs it; the ticks during it join it',async()=>{
    let T=Infinity;
    await onSlow({rows:[svRow(config,7),svRow(wk3(),2)],search:'?view=survivor&sw=2&season=2026',lag:(kind,r)=>r.sent<T?0:kind==='row'&&r.sent===T?Infinity:14*S},async p=>{
      await p.clock.advance(p.toNextTick()+10*S);
      p.v.rows[0]=svRow(republished('ARI'),8);
      const from=p.seen.length,sent=p.life.length;T=p.clock.now();
      choose(p.v,'2026-3');
      await p.clock.advance(60*S);
      assert.deepEqual(p.ticks.filter(t=>t>T).map(t=>(t-T)/S),[10,30,50]);
      assert.deepEqual(p.settled(from).map(d=>[(d.t-T)/S,d.feed]),[[57,LIVE]],`the choice fails at 15 s; its fallback (index 14 s, snapshot 14 s, scores 14 s) completes at 57 s; requests: ${p.trace(sent,T)}`);
      assert.equal(p.meta(),'Week 2 · revision 8');assert.match(p.notices(),/Unable to switch Survivor week/);
      assert.deepEqual(p.aborted(sent).map(r=>[r.kind,r.after/S]),[['row',15]],'only the chosen week’s snapshot is abandoned, at its limit');
      assert.deepEqual(p.tally(sent),{index:1,row:2,rulings:3,score:2},'the ticks during the choice and its fallback sent nothing');
    });
  });

  await regression('a late response under long latency never overwrites a newer choice: revision 8’s snapshot, slowed to 12 s, arrives after Week 3 was chosen and installed, and changes nothing',async()=>{
    let T=Infinity,C=Infinity;
    const slow=(kind,r)=>r.sent>=T&&r.sent<C;
    await onSlow({rows:[svRow(config,7),svRow(wk3(),2)],search:'?view=survivor&sw=2&season=2026',lag:(kind,r)=>slow(kind,r)?12*S:0,deaf:slow},async p=>{
      await p.clock.advance(0);
      p.v.rows[0]=svRow(republished('ARI'),8);
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      await p.clock.advance(1+16*S);
      assert.equal(p.meta(),'Week 2 · revision 7','revision 8 is still on its way');
      C=p.clock.now();choose(p.v,'2026-3');await p.clock.advance(0);
      assert.equal(p.meta(),'Week 3 · revision 2');
      await p.clock.advance(3*PERIOD);
      assert(p.life.some(r=>r.kind==='row'&&r.sent===T+12*S&&r.how==='answered'&&r.ended===T+24*S),'revision 8’s snapshot did arrive, late');
      assert.equal(p.meta(),'Week 3 · revision 2','revision 8 arriving last changes nothing');
      assert.equal(p.v.$('survivorWeekSelect').value,'2026-3');
      assert.deepEqual(p.v.historyCalls.map(([,u])=>new URL(u).searchParams.get('sw')),['3']);
    });
  });

  await regression('a superseded Survivor refresh’s requests are abandoned with it at once, not left to their time limits: a week chosen while a 12 s score feed and the rules and rulings are on their way aborts them',async()=>{
    let T=Infinity;
    await onSlow({rows:[svRow(config,7),svRow(wk3(),2)],search:'?view=survivor&sw=2&season=2026',lag:(kind,r)=>r.sent>=T&&r.sent<T+PERIOD&&(kind==='score'||kind==='rulings')?12*S:0},async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      const sent=p.life.length;
      await p.clock.advance(1+5*S);
      assert.deepEqual(p.life.slice(sent).filter(r=>r.how==='open').map(r=>r.kind).sort(),['rulings','rulings','rulings','score'],'the refresh is waiting for its score feed and rulings');
      choose(p.v,'2026-3');await p.clock.advance(0);
      assert.deepEqual(p.aborted(sent).map(r=>[r.kind,r.after/S]).sort(),[['rulings',5],['rulings',5],['rulings',5],['score',5]],'the superseded requests are abandoned at the choice');
      assert.equal(p.meta(),'Week 3 · revision 2');
    });
  });

  await regression('a Pick’em view taking the page during a slow Survivor refresh: the refresh already on its way lands, the Survivor timer sends nothing while Pick’em has the page, and coming back runs one full refresh that completes',async()=>{
    let T=Infinity;
    await onSlow({lag:(kind,r)=>r.sent>=T&&kind!=='schedule'?12*S:0},async p=>{
      const viewTo=view=>{p.v.doc.body.dataset.view=view;p.v.doc.dispatchEvent({type:'poolcenter:viewchange',detail:{view}})};
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      await p.clock.advance(1+5*S);
      const sent=p.life.length;
      viewTo('home');
      await p.clock.advance(2*PERIOD);
      assert.deepEqual(p.tally(sent),{index:0,row:0,rulings:3,score:1},'only the refresh already on its way continues; the timer sends nothing');
      const back=p.life.length,from=p.seen.length;
      viewTo('survivor');const B=p.clock.now();
      await p.clock.advance(24*S);
      assert.deepEqual(p.tally(back),FULL,'one full refresh');
      assert.deepEqual(p.settled(from).map(d=>[(d.t-B)/S,d.feed]),[[24,LIVE]]);
      assert.deepEqual(p.aborted(0),[]);
    });
  });

  await regression('hidden during a slow Survivor refresh: the refresh already on its way may finish, no timer tick sends a request while hidden, and becoming visible again runs one full refresh',async()=>{
    let T=Infinity;
    await onSlow({lag:(kind,r)=>r.sent>=T&&kind!=='schedule'?12*S:0},async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      await p.clock.advance(1+5*S);
      p.v.setVisibility('hidden');
      const sent=p.life.length;
      await p.clock.advance(3*PERIOD);
      assert.deepEqual(p.tally(sent),{index:0,row:0,rulings:3,score:1},'only the refresh already on its way continues; hidden ticks send nothing');
      assert.equal(p.feed(),LIVE,'the refresh on its way completed');
      const back=p.life.length,from=p.seen.length;p.v.setVisibility('visible');const V=p.clock.now();
      await p.clock.advance(0);
      assert.deepEqual(p.tally(back),{index:1,row:0,rulings:0,score:0},'becoming visible starts one full refresh at once');
      await p.clock.advance(24*S);
      assert.deepEqual(p.tally(back),FULL);assert.deepEqual(p.settled(from).map(d=>[(d.t-V)/S,d.feed]),[[24,LIVE]]);
    });
  });

  await regression('becoming visible while a slow Survivor refresh is still within its time limits joins it instead of starting a second: a republished revision 30 s into its 42 s refresh still installs, nothing is abandoned',async()=>{
    let T=Infinity;
    await onSlow({lag:(kind,r)=>r.sent>=T&&kind!=='schedule'?14*S:0},async p=>{
      await p.clock.advance(0);
      p.v.rows[0]=svRow(republished('ARI'),8);
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      const sent=p.life.length,from=p.seen.length;
      await p.clock.advance(1+25*S);
      p.v.setVisibility('hidden');await p.clock.advance(5*S);
      const back=p.life.length;p.v.setVisibility('visible');await p.clock.advance(0);
      assert.deepEqual(p.tally(back),{index:0,row:0,rulings:0,score:0},'becoming visible 30 s in starts nothing');
      await p.clock.advance(12*S);
      assert.deepEqual(p.settled(from).map(d=>[(d.t-T)/S,d.feed]),[[42,LIVE]],`requests: ${p.trace(sent,T)}`);
      assert.equal(p.meta(),'Week 2 · revision 8');assert.match(p.v.row('D.C.'),/ARI lost in Week 2/);
      assert.deepEqual(p.aborted(sent),[]);
    });
  });

  await regression('a Survivor page frozen in the background past the longest a refresh can take: becoming visible replaces the refresh it left behind, at once and only once, and the new refresh completes',async()=>{
    let T=Infinity;
    await onSlow({lag:(kind,r)=>r.sent>=T&&kind!=='schedule'?12*S:0},async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      const sent=p.life.length,from=p.seen.length;
      await p.clock.advance(1+5*S);
      p.v.setVisibility('hidden');
      p.clock.jump(300*S);
      const V=p.clock.now();
      p.v.setVisibility('visible');
      await p.clock.advance(0);
      assert.deepEqual(p.aborted(sent).map(r=>[r.kind,(r.sent-T)/S,(r.sent+r.after-T)/S]),[['index',0,305]],'the frozen refresh is abandoned as the page becomes visible');
      assert.deepEqual(p.life.slice(sent).filter(r=>r.sent===V).map(r=>r.kind),['index'],'one new full refresh starts at once');
      await p.clock.advance(24*S);
      assert.deepEqual(p.settled(from).map(d=>[(d.t-V)/S,d.feed]),[[24,LIVE]],`requests: ${p.trace(sent,T)}`);
      assert.deepEqual(p.tally(sent),{index:2,row:0,rulings:3,score:1});
    });
  });

  await regression('a Survivor refresh left behind by a page frozen in the background never lets a timer tick start a new refresh while the page is still hidden, however long it has run; becoming visible does',async()=>{
    let T=Infinity;
    await onSlow({lag:(kind,r)=>r.sent>=T&&kind!=='schedule'?12*S:0},async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      const sent=p.life.length;
      await p.clock.advance(1+5*S);
      p.v.setVisibility('hidden');
      p.clock.jump(300*S);
      await p.clock.advance(2*PERIOD);
      assert.deepEqual(p.life.slice(sent).filter(r=>r.kind==='index').map(r=>(r.sent-T)/S),[0],'unfrozen but still hidden: the timer ticks start no refresh');
      const back=p.life.length;p.v.setVisibility('visible');await p.clock.advance(0);
      assert.deepEqual(p.tally(back),{index:1,row:0,rulings:0,score:0},'becoming visible starts one full refresh');
    });
  });

  // Home is not such a view since the Home dashboard (Survivor refreshes there once a minute at most; its own regressions
  // are in the Home dashboard block at the end of this file), so this regression uses Standings.
  await regression('a Survivor refresh left behind by a frozen page never lets Survivor refresh while a Pick’em view other than Home has the page, however long it has run',async()=>{
    let T=Infinity;
    await onSlow({lag:(kind,r)=>r.sent>=T&&kind!=='schedule'?12*S:0},async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      const sent=p.life.length;
      await p.clock.advance(1+5*S);
      p.v.doc.body.dataset.view='standings';p.v.doc.dispatchEvent({type:'poolcenter:viewchange',detail:{view:'standings'}});
      p.v.setVisibility('hidden');
      p.clock.jump(300*S);
      p.v.setVisibility('visible');
      await p.clock.advance(2*PERIOD);
      assert.deepEqual(p.life.slice(sent).filter(r=>r.kind==='index').map(r=>(r.sent-T)/S),[0],'a Pick’em view other than Home has the page: Survivor starts no refresh, on resume or on a tick');
    });
  });

  await regression('the Survivor stall limit is the longest a refresh can take plus a second (46 s): a refresh left behind by a page frozen until 45.9 s after it started is joined when the page becomes visible, one frozen until 46 s is replaced',async()=>{
    for(const [frozenUntil,replaced] of [[45900,false],[46000,true]]){
      let T=Infinity;
      await onSlow({lag:(kind,r)=>r.sent>=T&&kind!=='schedule'?12*S:0},async p=>{
        await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
        const sent=p.life.length;
        await p.clock.advance(1+5*S);
        p.v.setVisibility('hidden');
        p.clock.jump(frozenUntil-5*S);
        const V=p.clock.now();
        p.v.setVisibility('visible');
        await p.clock.advance(0);
        assert.deepEqual(p.life.slice(sent).filter(r=>r.sent===V&&r.kind==='index').map(r=>r.kind),replaced?['index']:[],`frozen until ${frozenUntil/S} s: the refresh is ${replaced?'replaced':'joined'}`);
        assert.deepEqual(p.aborted(sent).map(r=>[r.kind,(r.sent+r.after-T)/S]),replaced?[['index',frozenUntil/S]]:[],`frozen until ${frozenUntil/S} s`);
      });
    }
  });

  await regression('where fetch’s own abort error reaches the race first, a Survivor index that runs out of time is still a timeout: PUBLISHED DATA STALE at 15 s, in the feed status too',()=>abortAlgorithmsFirst(async()=>{
    let hang=false;
    await onSlow({lag:kind=>kind==='index'&&hang?Infinity:0},async p=>{
      await p.clock.advance(0);hang=true;
      await p.clock.advance(p.toNextTick());
      await p.clock.advance(LIMIT);
      assert.equal(p.meta(),'Week 2 · revision 7 · PUBLISHED DATA STALE');
      assert.match(p.notices(),/the published week list could not be checked \(Survivor publication list timed out\)/);
      assert.equal(p.feed(),'PUBLISHED DATA STALE · NFL results');
    });
  }));

  for(const L of [10,12,14]){
    await regression(`${L} s for every Survivor request from the very first, the anonymous token included: boot completes (the token, then the index, the snapshot and the score feeds with the rules and rulings: ${4*L} s), then so do the refreshes; no read waits for the token inside its own time limit`,()=>onSlow({lag:kind=>kind==='schedule'?0:L*S,tokenLag:()=>L*S},async p=>{
      await p.clock.advance(4*L*S);
      assert.equal(p.feed(),LIVE,`boot completes at ${4*L} s`);
      assert.equal(p.meta(),'Week 2 · revision 7');
      assert.deepEqual(p.life.filter(r=>r.kind==='token'||r.kind==='index'||r.kind==='row').map(r=>[r.kind,(r.sent-p.life[0].sent)/S]),[['token',0],['index',L],['row',2*L]],'one phase after another, the token first');
      const from=p.seen.length,sent=p.life.length;
      await p.clock.advance(6*PERIOD);
      const done=p.settled(from);
      assert(done.length>=2,`completed refreshes after boot: ${done.length}, want at least 2`);
      for(const d of done)assert.equal(d.feed,LIVE);
      assert.deepEqual(p.aborted(0),[],'nothing is abandoned, at boot or after');
      assert.equal(p.tokens(sent),0,'the token is not fetched again');
    }));
  }

  // The whole page (both apps, as index.html loads them) on the virtual clock, every Data API and score-feed request of the
  // given apps answered lag(app, kind, request) ms after it is sent. Both 20 s timers run on the clock from boot.
  const slowPool=async(viewName,lag)=>{
    const clock=virtualClock(),life=[],seen=[],ticks=[];
    try{
      const send=network(clock,life,(kind,r)=>lag(r.app,kind,r),()=>false);
      const p=await poolPage(viewName,{respond:(app,kind,u,init,answer)=>send(kind,u,init,answer,app)});
      const watch=watcher(clock,seen);
      watch('sync',p.$('sync'),'textContent');watch('refresh',p.$('refresh'),'disabled');watch('feed',p.$('svFeed'),'textContent');watch('feedClass',p.$('svFeed'),'className');watch('summary',p.$('svSummaryNote'),'textContent');
      const start=clock.now();clock.every(PERIOD,()=>{ticks.push(clock.now());p.tickAll()});
      return{...p,clock,life,seen,ticks,
        toNextTick:()=>(ticks.length?ticks[ticks.length-1]:start)+PERIOD-clock.now(),
        sent:(app,from=0)=>life.slice(from).filter(r=>r.app===app).map(r=>r.kind),
        aborted:(from=0)=>life.slice(from).filter(r=>r.how==='aborted').map(r=>[r.app,r.kind]),
        pickemSettled:(from=0)=>{const out=[];let sync=null;seen.forEach((s,i)=>{if(s.label==='sync')sync=s.value;if(i>=from&&s.label==='refresh'&&s.value===false)out.push({t:s.t,sync})});return out},
        survivorSettled:(from=0)=>svSettled(seen,from)};
    }catch(error){clock.restore();throw error}
  };
  const onPool=async(viewName,lag,check)=>{const p=await slowPool(viewName,lag);try{await check(p)}finally{p.clock.restore()}};
  // Survivor's week-ahead schedule (Week 3 on this page), which no refresh waits for, answers at once.
  const scheduleRequest=(app,kind,r)=>app==='survivor'&&kind==='score'&&r.url.searchParams.get('week')==='3';
  const PAUSED="PICK'EM PAUSED · refreshes on return";

  await regression('page: Survivor taking the page during a slow Pick’em refresh runs one Survivor refresh that completes (12 s a request) and is not replaced by the tick during it; the Pick’em refresh already on its way lands under PICK’EM PAUSED and the Pick’em timer sends nothing more',async()=>{
    let T=Infinity;
    await onPool('home',(app,kind,r)=>r.sent>=T&&!scheduleRequest(app,kind,r)?12*S:0,async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      await p.clock.advance(1+5*S);
      const from=p.seen.length,sent=p.life.length;
      p.click('survivor');const C=p.clock.now();
      assert.equal(p.$('sync').textContent,PAUSED);
      await p.clock.advance(2*PERIOD);
      assert.deepEqual(p.survivorSettled(from).map(d=>[(d.t-C)/S,d.feed]),[[24,LIVE]],`Survivor's refresh completes; requests: ${p.life.slice(sent).map(r=>`${r.app}.${r.kind}@${(r.sent-C)/S}-${r.ended===null?'open':(r.ended-C)/S}:${r.how}`).join(' ')}`);
      assert.deepEqual(p.sent('pickem',sent).sort(),['rulings','rulings','rulings','score'],'Pick’em: only the refresh already on its way continues (its scores and rulings)');
      assert.equal(p.$('sync').textContent,PAUSED,'it lands under PICK’EM PAUSED');
      assert.deepEqual(p.aborted(sent),[],'nothing is abandoned');
    });
  });

  await regression('page: a Pick’em view taking the page during a slow Survivor refresh runs one Pick’em refresh that completes (12 s a request) and is not replaced by the tick during it; the Survivor refresh already on its way lands and the Survivor timer sends nothing more',async()=>{
    let T=Infinity;
    await onPool('survivor',(app,kind,r)=>r.sent>=T&&!scheduleRequest(app,kind,r)?12*S:0,async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      await p.clock.advance(1+5*S);
      const from=p.seen.length,sent=p.life.length;
      p.click('home');const C=p.clock.now();
      await p.clock.advance(2*PERIOD);
      assert.deepEqual(p.pickemSettled(from).map(d=>[(d.t-C)/S,d.sync]),[[24,'LIVE · data 0s old']],`Pick’em's refresh completes; requests: ${p.life.slice(sent).map(r=>`${r.app}.${r.kind}@${(r.sent-C)/S}-${r.ended===null?'open':(r.ended-C)/S}:${r.how}`).join(' ')}`);
      assert.deepEqual(p.life.slice(sent).filter(r=>r.app==='survivor'&&!scheduleRequest(r.app,r.kind,r)).map(r=>r.kind).sort(),['rulings','rulings','rulings','score'],'Survivor: only the refresh already on its way continues (its score feed and rulings)');
      assert.deepEqual(p.aborted(sent),[],'nothing is abandoned');
    });
  });

  assert.equal(failures.length,0,`HDC-15 Survivor and page slow-network regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('survivor and page HDC-15 slow-network regressions passed: slow refreshes complete, hung feeds fail at their limits, stale publications never read LIVE, no refresh is replaced within its bounded lifetime');

// Shareable cards. survivor-app.js answers a poolcenter:share event for Survivor at once with the counts and tracked states
// render() shows, from the same survivor-math calls, and the state of the feeds, rulings and publication behind them. The
// card made from it (share-card.js) claims the feed status (a week whose every entry is decided is FINAL), a shared link
// boots the same week, and on the whole page each app answers for its own contest only.
{
  const {buildCard,FRESH_SECONDS}=await import('./share-card.js');
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const ask=(v,contest='survivor')=>{const detail={contest,snapshot:null};v.doc.dispatchEvent({type:'poolcenter:share',detail});return detail.snapshot};
  const card=(v,contest='survivor')=>buildCard(contest,ask(v,contest),{now:Date.now(),href:'https://example.test/nfl-pool/?view=survivor'});
  const allFeeds=()=>({1:week(W1,1),2:week(W2,2),3:week(W3,3)});
  // The page logs feeds and rulings it refuses with console.warn; keep those expected warnings out of the test output.
  const quiet=async fn=>{const warn=console.warn;console.warn=()=>{};try{return await fn()}finally{console.warn=warn}};

  await regression('the snapshot is the Survivor week render() shows: the hero counts and every tracked row',async()=>{
    const v=await view(allFeeds()),s=ask(v);
    assert.equal(s.ready,true);
    assert.deepEqual([s.contest,s.season,s.week,s.revision,s.fieldSize],['survivor',2026,2,7,6]);
    assert.deepEqual([String(s.fieldSize),String(s.counts.legalPicks),String(s.counts.active),String(s.counts.pending)],
      ['svPoolSize','svEntered','svStillIn','svPending'].map(id=>String(v.$(id).textContent)),'the hero metrics (this harness keeps textContent as assigned)');
    assert.deepEqual(s.counts,{active:2,pending:0,out:4,outThisWeek:2,submitted:3,legalPicks:3,awaitingRuling:0,onHold:0});
    assert.deepEqual(s.tracked.map(t=>[t.name,t.status,t.team,t.reason,t.underReview]),[['D.C.','ALIVE','SF','Alive through Week 2',false],['DJS','ALIVE','SF','Alive through Week 2',false],['Thaddeus','OUT','LAC','LAC lost in Week 1',false]]);
    for(const t of s.tracked){assert.match(v.row(t.name),new RegExp(`<span class="status-pill survivor-[a-z]+">${t.status}</span>`),t.name);assert.match(v.row(t.name),new RegExp(`<b>${t.team}</b>`),t.name)}
    assert.deepEqual([s.feed.failed,s.hold,s.flags,s.rulingsStale,s.publishedStale],[false,false,[],false,false]);
    assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');
    assert.equal(card(v).status.label,'FINAL','every entry is decided: the header says LIVE, the card FINAL');
    assert(!/survivor-00|"picks"|"id"|JAX|CLE|BAL/.test(JSON.stringify(s)),'no field entry, field pick or id is shared');
  });
  await regression('an unverified result rides along on the card exactly as the header names it, and the week is not FINAL',async()=>{
    const bad=week(W2,2,{SF:(a,h,n)=>game(a,h,n,{as:null,hs:''})});
    const v=await view({1:week(W1,1),2:bad,3:week(W3,3)}),s=ask(v);
    assert.equal(v.$('svFeed').textContent,'LIVE · 1 TEAM RESULT UNVERIFIED');
    assert.deepEqual(s.flags,['1 TEAM RESULT UNVERIFIED']);assert.deepEqual(s.tracked.slice(0,2).map(t=>t.status),['PENDING','PENDING']);
    const c=card(v);assert.deepEqual([c.status.label,c.status.tone,c.status.flags],['LIVE','warn',['1 TEAM RESULT UNVERIFIED']]);
  });
  await regression('nothing is shared until this week has loaded results; a failed later load keeps them and says RESULT FEED UNAVAILABLE',async()=>{
    const feeds=allFeeds();feeds[2]='hang';
    const v=await quiet(()=>view(feeds));
    assert.match(v.$('svFeed').textContent,/^RESULT FEED UNAVAILABLE/);
    assert.deepEqual(ask(v),{ready:false,reason:'Survivor results for this week could not be loaded, so there is nothing to share yet.'});
    feeds[2]=week(W2,2);await v.refresh();
    const good=ask(v);assert.equal(good.ready,true);assert.equal(good.feed.failed,false);
    feeds[2]='hang';await quiet(()=>v.refresh());
    const s=ask(v);
    assert.match(v.$('svFeed').textContent,/^RESULT FEED UNAVAILABLE/);
    assert.deepEqual([s.ready,s.feed.failed,s.feed.at],[true,true,good.feed.at],'the last verified results, from when they loaded');
    assert.deepEqual(s.counts,good.counts);assert.equal(card(v).status.label,'RESULT FEED UNAVAILABLE');
  });
  await regression('a contest ON HOLD reaches the card as ON HOLD, with every held entry counted as on hold',async()=>{
    const v=await quiet(()=>view(allFeeds(),null,patched,rulingStore({nfl_contests:503}))),s=ask(v);
    assert.match(v.$('svFeed').textContent,/^ON HOLD · RULING DATA UNAVAILABLE/);
    assert.equal(s.hold,true);assert.deepEqual(s.counts,{active:0,pending:0,out:0,outThisWeek:0,submitted:0,legalPicks:0,awaitingRuling:0,onHold:6});
    assert.deepEqual(s.tracked.map(t=>t.status),['HOLD','HOLD','HOLD']);
    assert.equal(card(v).status.label,'ON HOLD');
  });
  await regression('a shared Survivor link boots the same published week, even with a later week published',async()=>{
    const first={...structuredClone(config),week:1,label:'Survivor Week 1',currentWeekEntryCount:6,
      trackedEntries:config.trackedEntries.map(e=>({...e,picks:e.picks.slice(0,1)})),fieldEntries:config.fieldEntries.map(e=>({...e,picks:e.picks.slice(0,1)}))};
    const rows=[{season:2026,week:1,status:'locked',revision:3,config:first},{season:2026,week:2,status:'locked',revision:7,config:structuredClone(config)}];
    const v=await view(allFeeds(),rows,patched,rulingStore(),{search:'?view=survivor&season=2026&sw=1'});
    assert.equal(v.$('svMeta').textContent,'Week 1 · revision 3');
    const link=new URL(card(v).link);
    assert.deepEqual([link.pathname,link.searchParams.get('view'),link.searchParams.get('season'),link.searchParams.get('sw')],['/nfl-pool/','survivor','2026','1']);
    const opened=await view(allFeeds(),rows,patched,rulingStore(),{search:link.search});
    assert.equal(opened.$('svMeta').textContent,'Week 1 · revision 3');assert.deepEqual([ask(opened).week,ask(opened).revision],[1,3]);
  });
  await regression('a page that has not refreshed for longer than the freshness limit shares DELAYED, never LIVE or FINAL',async()=>{
    const v=await view(allFeeds()),later=Date.now()+(FRESH_SECONDS+5)*1000;
    const late=buildCard('survivor',ask(v),{now:later,href:'https://example.test/nfl-pool/?view=survivor'});
    assert.equal(late.status.label,'DELAYED');assert.match(late.status.detail,/^Results as of /);
  });
  await regression('survivor-app.js answers only a Survivor share request',async()=>{
    const v=await view(allFeeds());
    assert.equal(ask(v,'pickem'),null);assert.equal(ask(v,'games'),null);
  });
  await regression('page: on the whole page each app answers for its own contest, and both cards can be made',async()=>{
    const p=await poolPage('standings');
    const pk=ask(p,'pickem'),sv=ask(p,'survivor');
    assert.deepEqual([pk.contest,pk.week,pk.revision,sv.contest,sv.week,sv.revision],['pickem',3,1,'survivor',2,7]);
    assert.equal(card(p,'pickem').ok,true);assert.equal(card(p,'survivor').ok,true);
  });

  assert.equal(failures.length,0,`share-card Survivor regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('survivor share-card regressions passed: the share snapshot is the rendered Survivor week, never before its results, with the feed, ruling and publication state, shared links boot the same week, and each app answers for its own contest');

// Home dashboard (home-dashboard.js). With Home active on a visible page, Survivor refreshes once a minute at most: a timer
// tick, a resume or a view change runs one full refresh only once the last one started HOME_REFRESH_MS (60 s) ago, and joins,
// never doubles, one still running; Pick'em keeps its own 20 s cycle on Home (HDC-15 single owner), and with any other
// Pick'em view active Survivor never refreshes. Each render, a publication found stale or verified again, and a boot failure
// announce poolcenter:update (carrying no data), and the share snapshot says how often these results are refreshed in the
// current view (feed.interval). The clock is the virtual one above, so a minute passes without waiting.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const S=1000,HOME=60*S,PUBLISHED_AT='2026-09-21T19:30:44.641+00:00';
  const svRow=(cfg,revision)=>({season:cfg.season,week:cfg.week,status:'locked',revision,published_at:PUBLISHED_AT,locked_at:PUBLISHED_AT,config:structuredClone(cfg)});
  const feeds=()=>({1:week(W1,1),2:week(W2,2),3:week(W3,3)});
  const tally=(v,from=0)=>{const t={token:0,index:0,row:0,rulings:0,score:0};for(const c of v.calls.slice(from))t[c.kind]++;return t};
  const FULL={token:0,index:1,row:0,rulings:3,score:1},NONE={token:0,index:0,row:0,rulings:0,score:0};
  const ask=v=>{const detail={contest:'survivor',snapshot:null};v.doc.dispatchEvent({type:'poolcenter:share',detail});return detail.snapshot};
  const quiet=async fn=>{const warn=console.warn;console.warn=()=>{};try{return await fn()}finally{console.warn=warn}};
  // A Survivor view booted on the virtual clock with Home active and the page visible (boot refreshed it once, as always).
  const onHome=async(check,{view:activeView='home'}={})=>{
    const clock=virtualClock();
    try{
      const v=await view(feeds(),[svRow(config,7)],patched,rulingStore(),{search:'?view=home'});
      v.doc.visibilityState='visible';v.doc.body.dataset.view=activeView;
      await check(v,clock);
    }finally{clock.restore()}
  };
  const viewTo=(v,next,previous)=>{v.doc.body.dataset.view=next;v.doc.dispatchEvent({type:'poolcenter:viewchange',detail:{view:next,previous}})};

  await regression('Home active: visible timer ticks make no request until the last Survivor refresh started a minute ago, then one tick runs exactly one full refresh (the index, the rules and rulings, the current week’s feed, never a snapshot) and the gate closes again',()=>onHome(async(v,clock)=>{
    let from=v.calls.length;v.tick();v.tick();await flush();
    assert.deepEqual(tally(v,from),NONE,'right after boot');
    await clock.advance(HOME-S);from=v.calls.length;v.tick();await flush();
    assert.deepEqual(tally(v,from),NONE,'59 s after the boot refresh started');
    await clock.advance(S);from=v.calls.length;v.tick();v.tick();await flush();
    assert.deepEqual(tally(v,from),FULL,'60 s after: one full refresh, the second tick joins it');
    assert.equal(v.$('svFeed').textContent,'LIVE · NFL results');
    from=v.calls.length;v.tick();await flush();
    assert.deepEqual(tally(v,from),NONE,'the next tick is inside the next minute');
    await clock.advance(HOME);from=v.calls.length;v.tick();await flush();
    assert.deepEqual(tally(v,from),FULL,'a minute later again');
  }));
  await regression('Home active: becoming visible or Home becoming the active view runs the one bounded refresh only when it is due, and never a second one at the same moment',()=>onHome(async(v,clock)=>{
    let from=v.calls.length;await v.resume();
    assert.deepEqual(tally(v,from),NONE,'a resume right after boot');
    v.setVisibility('hidden');clock.jump(HOME);from=v.calls.length;v.setVisibility('visible');v.tick();await flush();
    assert.deepEqual(tally(v,from),FULL,'a resume a minute later: one full refresh, the tick at the same moment joins it');
    viewTo(v,'standings','home');from=v.calls.length;await v.resume();v.tick();await flush();
    assert.deepEqual(tally(v,from),NONE,'Standings active: nothing, however long');
    clock.jump(10*HOME);from=v.calls.length;v.tick();await v.resume();
    assert.deepEqual(tally(v,from),NONE,'still nothing with Standings active after ten minutes');
    from=v.calls.length;viewTo(v,'home','standings');await flush();
    assert.deepEqual(tally(v,from),{...FULL,score:2},'Home active again with results eleven minutes old: one refresh at once (its week-ahead schedule, cached five minutes, is read again with it, as on the Survivor view)');
    from=v.calls.length;viewTo(v,'games','home');viewTo(v,'home','games');await flush();
    assert.deepEqual(tally(v,from),NONE,'leaving and coming back inside the minute: nothing');
  }));
  await regression('Home active: a hidden page makes no Survivor request from a tick, however old the results',()=>onHome(async(v,clock)=>{
    v.setVisibility('hidden');clock.jump(10*HOME);
    const from=v.calls.length;v.tick();v.tick();await flush();
    assert.deepEqual(tally(v,from),NONE);
  }));
  await regression('Home active: a republished revision found by the bounded refresh is installed whole, and a stale publication is reported, exactly as on the Survivor view',()=>onHome(async(v,clock)=>{
    v.rows[0]=svRow((()=>{const c=structuredClone(config);c.trackedEntries[0].picks=['PIT','ARI'];return c})(),8);
    await clock.advance(HOME);let from=v.calls.length;v.tick();await flush();
    assert.deepEqual(tally(v,from),{token:0,index:1,row:1,rulings:3,score:3},'the index, the snapshot of revision 8, then a fresh load of both weeks’ score feeds and the week-ahead schedule');
    assert.deepEqual(v.seen.slice(-3).sort(),[1,2,3]);
    assert.equal(v.$('svMeta').textContent,'Week 2 · revision 8');assert.match(v.row('D.C.'),/ARI lost in Week 2/);
    v.hooks.index=()=>({ok:false,status:503,json:async()=>({})});
    await clock.advance(HOME);from=v.calls.length;await quiet(async()=>{v.tick();await flush()});
    assert.equal(v.$('svMeta').textContent,'Week 2 · revision 8 · PUBLISHED DATA STALE');
    assert.match(ask(v).publishedStale.toString(),/true/);
  }));
  await regression('page: with Home active a visible timer tick is Pick’em’s full refresh alone until Survivor’s last refresh is a minute old; that tick then runs both, once, and the next ticks are Pick’em’s alone again',async()=>{
    const clock=virtualClock();
    try{
      const p=await poolPage('home');
      const FULLP={index:1,row:0,rulings:3,score:1},NONEP={index:0,row:0,rulings:0,score:0};
      let from=p.calls.length;p.tickAll();await flush();
      assert.deepEqual(p.tally(from),{pickem:FULLP,survivor:NONEP,token:0},'right after boot');
      await clock.advance(HOME);from=p.calls.length;p.tickAll();await flush();
      assert.deepEqual(p.tally(from),{pickem:FULLP,survivor:FULLP,token:0},'a minute later: both, each once');
      from=p.calls.length;p.tickAll();await flush();p.tickAll();await flush();
      assert.deepEqual(p.tally(from),{pickem:{index:2,row:0,rulings:6,score:2},survivor:NONEP,token:0},'the next two ticks: Pick’em alone');
      assert.equal(p.$('svFeed').textContent,'LIVE · NFL results');assert.match(p.$('sync').textContent,/^LIVE/);
      p.click('standings');await flush();
      await clock.advance(HOME);from=p.calls.length;p.tickAll();await flush();
      assert.deepEqual(p.tally(from),{pickem:FULLP,survivor:NONEP,token:0},'Standings active: Pick’em alone, however old the Survivor results');
    }finally{clock.restore()}
  });
  await regression('every render, a publication found stale and one verified again announce poolcenter:update for Survivor, carrying no data; a boot failure is the snapshot’s reason',async()=>{
    const v=await view(feeds(),[svRow(config,7)],patched);
    const seen=[];v.doc.addEventListener('poolcenter:update',e=>seen.push(e.detail));
    await v.refresh();
    assert(seen.length>=1,'a refresh announces');assert(seen.every(d=>JSON.stringify(d)==='{"contest":"survivor"}'),`only the contest: ${JSON.stringify(seen)}`);
    let n=seen.length;v.hooks.index=()=>({ok:false,status:503,json:async()=>({})});await quiet(()=>v.refresh());
    assert(seen.length>n,'a stale publication announces');assert.match(v.$('svMeta').textContent,/PUBLISHED DATA STALE/);assert.equal(ask(v).publishedStale,true);
    n=seen.length;v.hooks.index=undefined;await v.refresh();
    assert(seen.length>n,'verified again announces');assert.equal(ask(v).publishedStale,false);
    const failed=await quiet(()=>view(feeds(),[],patched));
    assert.match(failed.$('survivorError').innerHTML,/^<div class="error">Survivor is not published yet: No published Survivor weeks found<\/div>$/);
    assert.deepEqual(ask(failed),{ready:false,reason:'Survivor is not published yet: No published Survivor weeks found'});
  });
  await regression('the share snapshot says how often these results are refreshed: every 20 s on the Survivor view, once a minute elsewhere',async()=>{
    const v=await view(feeds(),[svRow(config,7)],patched);
    assert.equal(ask(v).feed.interval,20000);
    v.doc.body.dataset.view='home';assert.equal(ask(v).feed.interval,60000);
    v.doc.body.dataset.view='standings';assert.equal(ask(v).feed.interval,60000);
    assert.deepEqual(v.intervals,[20000],'still exactly one 20 s timer');
  });

  assert.equal(failures.length,0,`Home dashboard Survivor regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('survivor Home dashboard regressions passed: one bounded Survivor refresh a minute with Home active, none with another Pick’em view active, no doubled refresh on resume or view change, update announcements, and the snapshot’s refresh interval');
