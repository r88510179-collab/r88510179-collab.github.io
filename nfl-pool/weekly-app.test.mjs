import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectScoreboard} from './score-proxy/index.mjs';
import {survivorBuildResults} from './survivor-math.js';

const appSource=readFileSync(new URL('./weekly-app.js',import.meta.url),'utf8');
// HDC-12: the page imports the contest-ruling evaluator; where it does, point that import at the module's file URL so the
// page still loads from a data: URL. Before HDC-12 there is no such import and the source is used as it is.
const rulingsFrom=appSource.match(/from '\.\/contest-rulings\.js\?v=\d+';/)?.[0]??null;
const source=rulingsFrom?appSource.replace(rulingsFrom,`from '${new URL(rulingsFrom.slice("from '".length,-"';".length),import.meta.url).href}';`):appSource;
const from="from './public-math.js?v=3';";
assert(source.includes(from),'harness expects the public-math import');
assert(source.includes("if(ctl)ctl.abort()"),'overlapping Pick’em refreshes must abort the older request');
assert(source.includes("if(id!==gen)return"),'late Pick’em responses must be generation-gated');
const patched=source.replace(from,`from '${new URL('./public-math.js?v=3',import.meta.url).href}';`);
let instance=0;

class El{
  constructor(){this.textContent='';this.innerHTML='';this.className='';this.value='';this.hidden=false;this.disabled=false;this.style={};this.listeners={};this.children=[]}
  // As in the DOM, textContent reads back as a string: an assigned number shows as its decimal text, null as ''.
  get textContent(){return this.text}
  set textContent(v){this.text=v==null?'':String(v)}
  addEventListener(t,f){(this.listeners[t]||=[]).push(f)}
  replaceChildren(...nodes){this.children=[...nodes]}
  appendChild(node){this.children.push(node);return node}
}
const flush=async(n=20)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};
const config={schemaVersion:1,season:2026,week:3,tiebreakGameIndex:0,
  games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-27'}],
  participants:[
    {id:'dc',displayName:'D.C.',pickNumbers:[1],tiebreak:41},
    {id:'djs',displayName:'DJS',pickNumbers:[2],tiebreak:44}
  ]
};
const game=({season=2026,seasonType=2,week=3,away='DEN',home='KC',id=`${away.toLowerCase()}-${home.toLowerCase()}`,awayScore='24',homeScore='17'}={})=>({
  id,season:{year:season,type:seasonType},week:{number:week},
  status:{type:{state:'post',completed:true,shortDetail:'Final'}},
  competitions:[{competitors:[
    {homeAway:'away',team:{abbreviation:away},score:awayScore},
    {homeAway:'home',team:{abbreviation:home},score:homeScore}
  ]}]
});

// HDC-12: the contest rules and rulings, served as the Neon Data API serves them to the anonymous role. Only the granted
// public columns can be selected (select=* or any other column is refused, as PostgREST refuses a column the role may not
// read) and rows are filtered by the request's eq./lte. filters. The stored rows carry the private columns too, so a request
// for one fails. By default: one valid contest, its revision-1 policy and no ruling, so every page above renders as before.
const RULING_COLUMNS={
  nfl_contests:['contest_id','season','contest_type','display_name','starts_at','created_at'],
  nfl_contest_policies:['contest_id','contest_type','revision','effective_week','halted_game_policy','public_note','created_at'],
  nfl_incident_rulings:['ruling_id','contest_id','contest_type','week','away_team','home_team','policy_revision','chain_seq','parent_ruling_id','consequence','incident_status','event_id','evidence_source','public_note','created_at']
};
const PK_CONTEST='pool-center-2026-pickem',PRIVATE={admin_note:'PRIVATE ADMIN NOTE',created_by:'auth-user-7f3a'};
const pkContestRow=(o={})=>({contest_id:PK_CONTEST,season:2026,contest_type:'pickem',display_name:"Pool Center 2026 Pick'em",starts_at:'2026-09-01T00:00:00+00:00',created_at:'2026-10-08T12:00:00+00:00',created_by:PRIVATE.created_by,...o});
const pkPolicyRow=(o={})=>({contest_id:PK_CONTEST,contest_type:'pickem',revision:1,effective_week:1,halted_game_policy:'void',public_note:'Approved policy for this contest.',created_at:'2026-10-08T12:00:00+00:00',...PRIVATE,...o});
const pickemStore=(o={})=>({nfl_contests:[pkContestRow()],nfl_contest_policies:[pkPolicyRow()],nfl_incident_rulings:[],...o});
function dataApi(table,rows,u){
  const select=(u.searchParams.get('select')||'*').split(','),allowed=RULING_COLUMNS[table];
  if(select.some(c=>!allowed.includes(c)))return{ok:false,status:401,json:async()=>({code:'42501',message:`permission denied for table ${table}`})};
  const filters=[...u.searchParams].filter(([k])=>k!=='select'&&k!=='order');
  if(filters.some(([k,v])=>!allowed.includes(k)||!/^(eq|lte)\./.test(v)))return{ok:false,status:400,json:async()=>({message:'unsupported filter'})};
  const keep=row=>filters.every(([k,v])=>{const [op,...rest]=v.split('.'),want=rest.join('.'),have=row[k],w=typeof have==='number'?Number(want):want;return op==='eq'?have===w:have<=w});
  return{ok:true,status:200,json:async()=>structuredClone(rows.filter(keep).map(row=>Object.fromEntries(select.map(c=>[c,row[c]]))))};
}
// HDC-15: the Pick'em publication table (nfl_pool_weeks) as the Data API serves it to the anonymous role: eq. filters and
// the requested column list are applied (a missing value reads as null); rows keep the order the fixture lists them in,
// which is the order a request asks for. A column the table does not have, or any other filter, is refused.
const PUB_COLUMNS=['season','week','status','config','revision','published_at','locked_at','source_filename','source_sha256','created_at','updated_at'];
function publicationApi(rows,u){
  const select=(u.searchParams.get('select')||'*').split(',');
  if(select.some(c=>c!=='*'&&!PUB_COLUMNS.includes(c)))return{ok:false,status:400,json:async()=>({message:'unknown column'})};
  const filters=[...u.searchParams].filter(([k])=>k!=='select'&&k!=='order');
  if(filters.some(([k,v])=>!PUB_COLUMNS.includes(k)||!/^eq\./.test(v)))return{ok:false,status:400,json:async()=>({message:'unsupported filter'})};
  const keep=row=>filters.every(([k,v])=>String(row[k])===v.slice(3));
  return{ok:true,status:200,json:async()=>structuredClone(rows.filter(keep).map(row=>select.includes('*')?row:Object.fromEntries(select.map(c=>[c,row[c]??null]))))};
}

// HDC-15: the page's publication rows (by default the one locked row of the config, keyed by its own season and week), a log
// of every request by kind (token, index: a publication read without a config, row: one with a config, rulings, score),
// per-kind hooks that can answer a request instead of the default (bootHooks are in place before the page boots), the History
// API calls, the document's visibility and the bottom-nav clicks. refresh() is a visible timer tick (the tick a browser runs), tick() the timer callback as the document
// currently is, resume() a hidden-to-visible transition.
async function view({weekConfig=config,initialScorePayload={events:[game()]},store=pickemStore(),published=null,search='?view=home',tokenTtl=3600,bootHooks={}}={}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El());return els.get(id)},docListeners={};
  const doc={
    body:{dataset:{}},title:'',visibilityState:'hidden',
    getElementById:$,querySelectorAll(){return[]},
    createElement(){return new El()},
    addEventListener(t,f){(docListeners[t]||=[]).push(f)},
    dispatchEvent(e){for(const fn of docListeners[e.type]||[])fn(e);return true}
  };
  const windowListeners={},historyCalls=[];
  globalThis.document=doc;
  globalThis.window={addEventListener(t,f){(windowListeners[t]||=[]).push(f)},scrollTo(){}};
  globalThis.location={href:`https://example.test/nfl-pool/${search}`,search};
  globalThis.history={state:null,pushState(_s,_t,u){historyCalls.push(['push',String(u)])},replaceState(_s,_t,u){historyCalls.push(['replace',String(u)])}};
  let tick=null,scorePayload=structuredClone(initialScorePayload),scoreFailure=false,scoreCalls=0;const rulingRequests=[],calls=[],hooks={...bootHooks};
  const pub=published?structuredClone(published):[{season:weekConfig?.season??2026,week:weekConfig?.week??3,status:'locked',revision:1,config:structuredClone(weekConfig)}];
  globalThis.setInterval=(fn,ms)=>{assert.equal(ms,20000);tick=fn;return 0};
  const mint=()=>'x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+tokenTtl})).toString('base64url')+'.y',token=mint();
  globalThis.fetch=async (url,init={})=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/token/anonymous')){calls.push({kind:'token',url:u});const answer={ok:true,json:async()=>({token:tokenTtl===3600?token:mint()})};return hooks.token?.(u,init,answer)??answer}
    if(u.pathname.endsWith('/nfl_pool_weeks')){
      const kind=(u.searchParams.get('select')||'*').split(',').some(c=>c==='config'||c==='*')?'row':'index';
      calls.push({kind,url:u,authorization:init.headers?.Authorization??null});
      return hooks[kind]?.(u,init)??publicationApi(pub,u);
    }
    const table=Object.keys(RULING_COLUMNS).find(t=>u.pathname.endsWith(`/${t}`));
    if(table){
      rulingRequests.push({table,url:u,authorization:init.headers?.Authorization??null});calls.push({kind:'rulings',url:u});
      const rows=store[table];
      if(typeof rows==='function')return rows(u,init);
      if(typeof rows==='number')return{ok:false,status:rows,json:async()=>({})};
      return dataApi(table,rows,u);
    }
    scoreCalls++;calls.push({kind:'score',url:u});
    const hooked=hooks.score?.(u,init);if(hooked)return hooked;
    if(scoreFailure)return{ok:false,status:503,json:async()=>({})};
    return{ok:true,status:200,json:async()=>structuredClone(scorePayload)};
  };
  // badge and raceStatus are exported from this test instance only, so their output can be checked directly.
  const mod=await import(`data:text/javascript;base64,${Buffer.from(patched+`\nexport {badge,raceStatus};\n//instance ${++instance}`).toString('base64')}`);
  await flush();
  const warning=()=>$('error').children[0]?.textContent||'';
  const setVisibility=state=>{doc.visibilityState=state;for(const fn of docListeners.visibilitychange||[])fn()};
  return{
    $,warning,mod,store,rulingRequests,token,doc,pub,calls,hooks,historyCalls,setVisibility,
    html:()=>[...els.values()].map(e=>`${e.innerHTML}\n${e.textContent}`).join('\n'),
    setPayload:v=>{scorePayload=v},
    setFailure:v=>{scoreFailure=v},
    tick:()=>tick(),
    click:target=>{for(const fn of docListeners.click||[])fn({target:{closest:s=>s==='[data-view-target]'?{dataset:{viewTarget:target}}:null},preventDefault(){}})},
    refresh:async()=>{doc.visibilityState='visible';tick();await flush()},
    resume:async()=>{const before=scoreCalls;setVisibility('hidden');setVisibility('visible');await flush();return scoreCalls-before}
  };
}

{
  const v=await view();
  assert.equal(v.$('leaderName').textContent,'D.C.');
  assert.equal(v.$('leaderRecord').textContent,'1–0','exactly one competition with one away/home pair must be accepted');
  assert.equal(v.warning(),'','valid one-competition event should not warn');

  v.setPayload({events:[game({week:4,awayScore:'10',homeScore:'31'})]});await v.refresh();
  assert.equal(v.$('leaderName').textContent,'D.C.','wrong-week feed must not replace the verified result');
  assert.match(v.warning(),/feed week 4 does not match 3/);

  v.setPayload({events:[game({season:2025,awayScore:'10',homeScore:'31'})]});await v.refresh();
  assert.equal(v.$('leaderName').textContent,'D.C.');
  assert.match(v.warning(),/feed season 2025 does not match 2026/);

  v.setPayload({events:[game({seasonType:1,awayScore:'10',homeScore:'31'})]});await v.refresh();
  assert.equal(v.$('leaderName').textContent,'D.C.');
  assert.match(v.warning(),/feed season type 1 is not regular season/);

  const malformed=game({awayScore:'10',homeScore:'31'});
  malformed.competitions[0].competitors.push({homeAway:'away',team:{abbreviation:'LV'},score:'7'});
  v.setPayload({events:[malformed]});await v.refresh();
  assert.equal(v.$('leaderName').textContent,'D.C.','incorrect competitor cardinality must not replace the verified result');
  assert.equal(v.$('leaderRecord').textContent,'1–0');
  assert.match(v.warning(),/malformed competitor data ignored/);

  const malformedCases=[
    ['zero competitions',e=>{e.competitions=[]}],
    ['multiple competitions',e=>{e.competitions.push(structuredClone(e.competitions[0]))}],
    ['null competition',e=>{e.competitions=[null]}],
    ['empty competition object',e=>{e.competitions=[{}]}],
    ['null competitors collection',e=>{e.competitions[0].competitors=null}],
    ['non-array competitors',e=>{e.competitions[0].competitors={}}],
    ['null competitor entry',e=>{e.competitions[0].competitors=[null,{homeAway:'home',team:{abbreviation:'KC'},score:'31'}]}],
    ['duplicate away roles',e=>{e.competitions[0].competitors=[{homeAway:'away',team:{abbreviation:'DEN'},score:'10'},{homeAway:'away',team:{abbreviation:'KC'},score:'31'}]}],
    ['duplicate home roles',e=>{e.competitions[0].competitors=[{homeAway:'home',team:{abbreviation:'DEN'},score:'10'},{homeAway:'home',team:{abbreviation:'KC'},score:'31'}]}]
  ];
  for(const [label,mutate] of malformedCases){
    const event=game({awayScore:'10',homeScore:'31'});mutate(event);
    v.setPayload({events:[event]});await v.refresh();
    assert.equal(v.$('leaderRecord').textContent,'1–0',`${label}: malformed event must preserve last-good game state`);
    assert(v.warning(),`${label}: malformed event must surface a warning`);
    assert.doesNotMatch(v.$('sync').textContent,/^FEED UNAVAILABLE/,`${label}: malformed event must not become a feed outage`);
    assert.match(v.$('sync').textContent,/^INCOMPLETE/,`${label}: malformed event should surface incomplete state`);
  }

  v.setFailure(true);await v.refresh();
  assert.match(v.$('sync').textContent,/^FEED UNAVAILABLE/,'legitimate score-feed/network failure must remain FEED UNAVAILABLE');
  assert.equal(v.$('leaderRecord').textContent,'1–0','feed failure must preserve last-good standings');

  v.setFailure(false);v.setPayload({events:[game()]});
  assert.equal(await v.resume(),1,'foreground resume must start exactly one Pick’em refresh');
}

{
  // A proven tracked no-submission row is a real tracked entry: it loads, shows NO PICK, and scores as no picks.
  // The tiebreak note lists every tracked guess, NO PICK included, only until the tiebreak game is final; from then on it
  // shows the final total for everyone. The missing tiebreak is never invented: the standings show "—" with no
  // difference, so Thaddeus cannot win a tiebreak.
  const noSubmission=structuredClone(config);
  noSubmission.participants.push({id:'thaddeus',displayName:'Thaddeus',pickNumbers:[null],tiebreak:null});
  const kickoff=game({awayScore:'0',homeScore:'0'});kickoff.status={type:{state:'pre',completed:false,shortDetail:'Sun 4:25 PM'}};
  const v=await view({weekConfig:noSubmission,initialScorePayload:{events:[kickoff]}});
  const pickRow=name=>v.$('pickBody').innerHTML.split('</tr>').find(r=>r.includes(`<td class="name">${name}</td>`))||'';
  assert.equal(v.warning(),'');
  assert.equal(v.$('tbNote').textContent,'Tiebreak guesses: D.C. 41 · DJS 44 · Thaddeus NO PICK.');
  assert.match(pickRow('Thaddeus'),/<td class="c pending">.*NO PICK/);
  assert.doesNotMatch(pickRow('D.C.'),/NO PICK/);

  v.setPayload({events:[game()]});await v.refresh();
  assert.equal(v.warning(),'');
  assert.equal(v.$('leaderName').textContent,'D.C.');
  assert.equal(v.$('leaderRecord').textContent,'1–0');
  assert.equal(v.$('tbNote').textContent,'Tiebreak final total: 41. Tiebreak differences are active.');
  const cells=row=>[...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(m=>m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
  const standings=v.$('standings').innerHTML.split('</tr>').filter(Boolean).map(cells);
  // rank, entry, W, L, tiebreak: a no-pick is a miss once the game is decided, and it has no tiebreak difference
  assert.deepEqual(standings.map(r=>[r[0],r[1],r[3],r[4],r[r.length-1]]),[['1','D.C.','1','0','41 Δ 0'],['2','DJS','0','1','44 Δ 3'],['3','Thaddeus','0','1','—']]);
  assert.match(pickRow('Thaddeus'),/<td class="c bad">.*NO PICK.*✕/);
}


{
  // Geometry-validated anonymous field rows may contain multiple proven empty pick cells and a missing Pts/tiebreak.
  const fieldConfig={schemaVersion:1,season:2026,week:3,tiebreakGameIndex:0,fullFieldReady:true,fullFieldValidationVersion:3,competitionSize:4,fullFieldEntryCount:2,
    games:[
      {away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-27'},
      {away:'MIA',home:'BUF',awayNumber:3,homeNumber:4,date:'2026-09-27'}
    ],
    participants:[
      {id:'dc',displayName:'D.C.',pickNumbers:[1,3],tiebreak:41},
      {id:'djs',displayName:'DJS',pickNumbers:[2,4],tiebreak:44}
    ],
    fieldEntries:[
      {id:'field-001',pickNumbers:[0,0],tiebreak:42},
      {id:'field-002',pickNumbers:[1,4],tiebreak:null}
    ]
  };
  const initial={events:[game(),game({away:'MIA',home:'BUF',awayScore:'10',homeScore:'20'})]};
  const v=await view({weekConfig:fieldConfig,initialScorePayload:initial});
  assert.equal(v.warning(),'');
  assert.equal(v.$('entryCount').textContent,'4');
}

{
  // The anonymous no-pick limit follows the config's validation version. Version 3 accepts the empty-cell shapes PDF
  // geometry recovery produces; earlier versions (2, or none) keep one explicit no-pick and a required tiebreak, so a
  // legacy config never gains version-3 permissions. A refused config never renders.
  const games=[['DEN','KC'],['MIA','BUF'],['NYJ','NE']].map(([away,home],i)=>({away,home,awayNumber:2*i+1,homeNumber:2*i+2,date:'2026-09-27'}));
  const week=(version,entries)=>({schemaVersion:1,season:2026,week:3,tiebreakGameIndex:0,games,
    ...(version===undefined?{}:{fullFieldValidationVersion:version}),fullFieldReady:true,competitionSize:2+entries.length,fullFieldEntryCount:entries.length,
    participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1,3,5],tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2,4,6],tiebreak:44}],
    fieldEntries:entries.map(([pickNumbers,tiebreak],i)=>({id:`field-00${i+1}`,pickNumbers,tiebreak}))});
  const initial={events:[game(),game({away:'MIA',home:'BUF',awayScore:'10',homeScore:'20'}),game({away:'NYJ',home:'NE',awayScore:'13',homeScore:'9'})]};
  // The refusal message when the page refuses the config, else what it rendered. The page logs a refused config with
  // console.error; keep the expected refusals out of the test output.
  const load=async cfg=>{
    const log=console.error;console.error=()=>{};
    try{const v=await view({weekConfig:cfg,initialScorePayload:initial});return v.$('sync').textContent==='CONFIG UNAVAILABLE'?v.$('error').innerHTML:{entryCount:v.$('entryCount').textContent,warning:v.warning()}}
    finally{console.error=log}
  };
  // version 3: two empty picks with a tiebreak, one empty pick without a tiebreak, every pick made without a tiebreak
  assert.deepEqual(await load(week(3,[[[0,0,5],42],[[1,0,6],null],[[2,4,6],null]])),{entryCount:'5',warning:''});
  for(const version of [2,undefined]){
    assert.deepEqual(await load(week(version,[[[0,3,6],42]])),{entryCount:'3',warning:''},`version ${version}: one no-pick`);
    for(const pickNumbers of [[0,0,5],[0,0,0]])assert.match(await load(week(version,[[pickNumbers,42]])),/Unable to load weekly pool data: field 1: too many no-picks/,`version ${version}: ${pickNumbers}`);
    assert.match(await load(week(version,[[[1,3,5],null]])),/Unable to load weekly pool data: Invalid entry field 1/,`version ${version}: missing tiebreak`);
  }
}

{
  const mixedConfig={schemaVersion:1,season:2026,week:3,tiebreakGameIndex:0,
    games:[
      {away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-27'},
      {away:'MIA',home:'BUF',awayNumber:3,homeNumber:4,date:'2026-09-27'}
    ],
    participants:[
      {id:'dc',displayName:'D.C.',pickNumbers:[1,3],tiebreak:41},
      {id:'djs',displayName:'DJS',pickNumbers:[2,4],tiebreak:44}
    ]
  };
  const initial={events:[game(),game({away:'MIA',home:'BUF',awayScore:'10',homeScore:'20'})]};
  const v=await view({weekConfig:mixedConfig,initialScorePayload:initial});
  assert.equal(v.$('leaderRecord').textContent,'1–1','mixed-feed harness should begin from two verified finals');

  const malformed=game({awayScore:'10',homeScore:'31'});malformed.competitions[0].competitors={};
  const validUpdate=game({away:'MIA',home:'BUF',awayScore:'30',homeScore:'20'});
  v.setPayload({events:[malformed,validUpdate]});await v.refresh();
  assert.equal(v.$('leaderName').textContent,'D.C.');
  assert.equal(v.$('leaderRecord').textContent,'2–0','valid event must update while malformed matchup preserves its last-good DEN result');
  assert.match(v.warning(),/DEN-KC:/,'malformed expected event must surface a matchup warning');
  assert.match(v.$('sync').textContent,/^INCOMPLETE/);
  assert.match(v.$('sync').textContent,/1 warning/,'mixed feed should count only the affected malformed matchup');
  assert.doesNotMatch(v.$('sync').textContent,/FEED UNAVAILABLE/,'one malformed event must not turn a usable mixed feed into an outage');
}

// HDC-06 helpers. A proven tracked no-submission entry (every pick and the tiebreak null) has no possible picks. While games
// remain it takes no part in the group race: it never makes a swing game, never contends, has no ceiling and no rooting
// chips, and every submitter's swing, race-path, status, ceiling, rooting and impact output is exactly what it would be if
// that entry were not tracked at all. Completed weeks render as before, and no badge requests a logo for an empty code.
const scheduled=({away,home,id=`${away.toLowerCase()}-${home.toLowerCase()}`})=>({id,season:{year:2026,type:2},week:{number:3},
  status:{type:{state:'pre',completed:false,shortDetail:'Sun 1:00 PM'}},
  competitions:[{competitors:[{homeAway:'away',team:{abbreviation:away}},{homeAway:'home',team:{abbreviation:home}}]}]
});
const raceRows=v=>v.$('raceList').innerHTML.split('<div class="race-row">').slice(1).map(row=>({
  name:row.match(/<div class="race-name">(.*?)<\/div>/)[1],
  status:row.match(/<span class="status-pill [^"]*">(.*?)<\/span>/)[1],
  note:row.match(/<div class="race-sub">(.*?)<\/div>/)[1],
  roots:[...(row.split('<div class="rooting">')[1]||'').matchAll(/<span class="root-chip[^"]*"><span class="badge[^"]*"[^>]*><span class="badge-fallback">(.*?)<\/span>/g)].map(m=>m[1]),
  html:row
}));
// [name, status pill, note, rooting chips] for each race row
const race=v=>raceRows(v).map(({name,status,note,roots})=>[name,status,note,roots]);
// [[away, impact], [home, impact], ['TIE', impact]] for each swing game
const swingGames=v=>v.$('swingList').innerHTML.split('<div class="swing-item">').slice(1).map(item=>[...item.matchAll(/<div class="impact[^"]*"><b>(.*?)<\/b> (.*?)<\/div>/g)].map(m=>[m[1],m[2]]));
const matchups=v=>swingGames(v).map(([away,home])=>`${away[0]}@${home[0]}`);
const standingCells=v=>v.$('standings').innerHTML.split('</tr>').filter(Boolean).map(row=>[...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(m=>m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()));
const noEmptyLogo=(v,label)=>assert(!v.html().includes('/500/.png'),`${label}: no rendered panel may request an empty-code team logo`);
const without=(cfg,names)=>({...structuredClone(cfg),participants:cfg.participants.filter(p=>!names.includes(p.displayName))});
// The race the submitters see must be exactly the race of the same week with the no-submission entries not tracked at all.
// Call it last in a block: the absent-week instance takes over the shared document.
async function sameAsAbsent(present,cfg,names,events,label){
  const absent=await view({weekConfig:without(cfg,names),initialScorePayload:{events}});
  assert.equal(absent.warning(),'');
  for(const id of ['swingLeft','swingMeta','scenarioCount'])assert.equal(present.$(id).textContent,absent.$(id).textContent,`${label}: ${id} must equal the week without ${names.join(' and ')}`);
  assert.equal(present.$('swingList').innerHTML,absent.$('swingList').innerHTML,`${label}: swing games, pickers and impact text must equal the week without ${names.join(' and ')}`);
  assert.deepEqual(raceRows(present).filter(r=>!names.includes(r.name)).map(r=>r.html),raceRows(absent).map(r=>r.html),`${label}: every submitter race row must equal the week without ${names.join(' and ')}`);
  const submitters=v=>{const r=v.mod.raceStatus();return{outcomes:r.outcomes,racePaths:r.racePaths,items:r.items.filter(x=>!names.includes(x.name))}};
  assert.deepEqual(submitters(present),submitters(absent),`${label}: every submitter's status, ceiling, roots and race paths must equal the week without ${names.join(' and ')}`);
}
// Four games: every ballot picks KC and BUF; the ballots split NYJ/NE and WAS/PHI. WAS-PHI is the tiebreak game.
const nsGames=[['DEN','KC'],['MIA','BUF'],['NYJ','NE'],['WAS','PHI']].map(([away,home],i)=>({away,home,awayNumber:2*i+1,homeNumber:2*i+2,date:'2026-09-27'}));
const nsBallots={'D.C.':[[2,4,5,7],41],JC:[[2,4,5,8],44],DJS:[[2,4,6,7],38],Thaddeus:[[2,4,6,8],47]};
const nsWeek=noSubmission=>({schemaVersion:1,season:2026,week:3,tiebreakGameIndex:3,games:structuredClone(nsGames),
  participants:Object.entries(nsBallots).map(([name,[pickNumbers,tiebreak]])=>noSubmission.includes(name)
    ?{id:name,displayName:name,pickNumbers:nsGames.map(()=>null),tiebreak:null}
    :{id:name,displayName:name,pickNumbers:pickNumbers.slice(),tiebreak})
});
// ESPN spells Washington WSH; the config's WAS matches it through the alias.
const nsScheduled=()=>[scheduled({away:'DEN',home:'KC'}),scheduled({away:'MIA',home:'BUF'}),scheduled({away:'NYJ',home:'NE'}),scheduled({away:'WSH',home:'PHI'})];

{
  // HDC-06 NS-A. Before kickoff D.C., JC and DJS agree on KC and BUF and disagree on NYJ/NE and WAS/PHI; Thaddeus submitted
  // nothing. Only the two disagreements are swing games: 3^4 outcomes and 3^2 race paths. Thaddeus is OUT with no picks.
  const v=await view({weekConfig:nsWeek(['Thaddeus']),initialScorePayload:{events:nsScheduled()}});
  assert.equal(v.warning(),'');
  assert.equal(v.$('swingLeft').textContent,'2','a no-submission entry must not turn games every submitter agrees on into swing games');
  assert.equal(v.$('swingMeta').textContent,'2 left');
  assert.deepEqual(matchups(v),['NYJ@NE','WAS@PHI'],'the swing list holds exactly the games the submitters disagree on');
  assert.equal(v.$('scenarioCount').textContent,'81 outcomes · 9 race paths');
  assert.deepEqual(race(v),[
    ['D.C.','ALIVE','Ceiling 4 wins',['NYJ','WAS']],
    ['JC','ALIVE','Ceiling 4 wins',['NYJ','PHI']],
    ['DJS','ALIVE','Ceiling 4 wins',['NE','WAS']],
    ['Thaddeus','OUT','No picks submitted',[]]
  ],'the no-submission entry is OUT with no rooting chips; each submitter roots in both swing games');
  assert.deepEqual(v.mod.raceStatus().items.find(x=>x.name==='Thaddeus'),{name:'Thaddeus',status:'OUT',ceiling:null,roots:[],topPaths:0,note:'No picks submitted'},'a no-submission entry is never given a ceiling or race paths');
  assert.deepEqual(swingGames(v),[
    [['NYJ','eliminates DJS'],['NE','eliminates D.C.'],['TIE','0 pts to all · 3 contenders remain']],
    [['WAS','eliminates JC'],['PHI','eliminates D.C.'],['TIE','0 pts to all · 3 contenders remain']]
  ]);
  assert(!v.$('swingList').innerHTML.includes('Thaddeus'),'a no-submission entry is never a picker or named in impact text');
  noEmptyLogo(v,'NS-A');
}

{
  // HDC-06 NS-B. The same week with Thaddeus not tracked at all: every submitter's swing and race output is identical.
  const cfg=nsWeek(['Thaddeus']),events=nsScheduled();
  const v=await view({weekConfig:cfg,initialScorePayload:{events}});
  await sameAsAbsent(v,cfg,['Thaddeus'],events,'NS-B');
}

{
  // HDC-06 NS-C. KC beats DEN, a game every submitter picked: it was never a swing game and the swing count stays 2.
  const cfg=nsWeek(['Thaddeus']),events=nsScheduled();
  const v=await view({weekConfig:cfg,initialScorePayload:{events}});
  assert.equal(v.$('swingLeft').textContent,'2','before DEN-KC is final');
  assert(!matchups(v).includes('DEN@KC'),'an agreed game is not a swing game before it is final');
  const decided=[game({away:'DEN',home:'KC',awayScore:'17',homeScore:'24'}),...events.slice(1)];
  v.setPayload({events:decided});await v.refresh();
  assert.equal(v.warning(),'');
  assert.equal(v.$('finals').textContent,'1/4');
  assert.equal(v.$('swingLeft').textContent,'2','finalizing an agreed game must leave the swing count unchanged');
  assert.deepEqual(matchups(v),['NYJ@NE','WAS@PHI']);
  assert.equal(v.$('scenarioCount').textContent,'27 outcomes · 9 race paths');
  assert.deepEqual(race(v),[
    ['D.C.','ALIVE','Ceiling 4 wins',['NYJ','WAS']],
    ['JC','ALIVE','Ceiling 4 wins',['NYJ','PHI']],
    ['DJS','ALIVE','Ceiling 4 wins',['NE','WAS']],
    ['Thaddeus','OUT','No picks submitted',[]]
  ]);
  noEmptyLogo(v,'NS-C');
  await sameAsAbsent(v,cfg,['Thaddeus'],decided,'NS-C');
}

{
  // HDC-06 NS-D. Nothing depends on which tracked entry submitted nothing: here D.C. submitted nothing while Thaddeus
  // submitted picks, then D.C. and Thaddeus both submitted nothing.
  {
    const cfg=nsWeek(['D.C.']),events=nsScheduled();
    const v=await view({weekConfig:cfg,initialScorePayload:{events}});
    assert.equal(v.warning(),'');
    assert.equal(v.$('swingLeft').textContent,'2','D.C. submitted nothing');
    assert.deepEqual(matchups(v),['NYJ@NE','WAS@PHI']);
    assert.equal(v.$('scenarioCount').textContent,'81 outcomes · 9 race paths');
    assert.deepEqual(race(v),[
      ['D.C.','OUT','No picks submitted',[]],
      ['JC','ALIVE','Ceiling 4 wins',['NYJ','PHI']],
      ['DJS','ALIVE','Ceiling 4 wins',['NE','WAS']],
      ['Thaddeus','ALIVE','Ceiling 4 wins',['NE','PHI']]
    ],'Thaddeus submitted picks and races like any submitter');
    noEmptyLogo(v,'NS-D (D.C.)');
    await sameAsAbsent(v,cfg,['D.C.'],events,'NS-D (D.C.)');
  }
  {
    const cfg=nsWeek(['D.C.','Thaddeus']),events=nsScheduled();
    const v=await view({weekConfig:cfg,initialScorePayload:{events}});
    assert.equal(v.warning(),'');
    assert.equal(v.$('swingLeft').textContent,'2','D.C. and Thaddeus submitted nothing');
    assert.deepEqual(matchups(v),['NYJ@NE','WAS@PHI']);
    assert.equal(v.$('scenarioCount').textContent,'81 outcomes · 9 race paths');
    assert.deepEqual(race(v),[
      ['D.C.','OUT','No picks submitted',[]],
      ['JC','ALIVE','Ceiling 4 wins',['NYJ','PHI']],
      ['DJS','ALIVE','Ceiling 4 wins',['NE','WAS']],
      ['Thaddeus','OUT','No picks submitted',[]]
    ]);
    noEmptyLogo(v,'NS-D (D.C. and Thaddeus)');
    await sameAsAbsent(v,cfg,['D.C.','Thaddeus'],events,'NS-D (D.C. and Thaddeus)');
  }
  {
    // The WAS-PHI tiebreak game is already final (PHI 24-20, total 44) while the other games remain, so submitters tied on
    // record are separated by their own tiebreak guesses. D.C. is listed first: its missing guess never stands in for JC's.
    // A NYJ-NE tie leaves JC and Thaddeus 1-0 each, and JC's 44 beats Thaddeus's 47.
    const cfg=nsWeek(['D.C.']),events=[...nsScheduled().slice(0,3),game({away:'WSH',home:'PHI',awayScore:'20',homeScore:'24'})];
    const v=await view({weekConfig:cfg,initialScorePayload:{events}});
    assert.equal(v.warning(),'');
    assert.equal(v.$('swingLeft').textContent,'1');
    assert.deepEqual(swingGames(v),[[['NYJ','clinches JC'],['NE','clinches Thaddeus'],['TIE','clinches JC']]],'tied submitters are separated by their own tiebreak guesses');
    assert.equal(v.$('scenarioCount').textContent,'27 outcomes · 3 race paths');
    assert.deepEqual(race(v),[
      ['D.C.','OUT','No picks submitted',[]],
      ['JC','ALIVE','Ceiling 4 wins',['NYJ']],
      ['DJS','OUT','Cannot finish first',[]],
      ['Thaddeus','ALIVE','Ceiling 4 wins',['NE']]
    ]);
    noEmptyLogo(v,'NS-D (tiebreak final)');
    await sameAsAbsent(v,cfg,['D.C.'],events,'NS-D (tiebreak final)');
  }
}

{
  // HDC-06 NS-E. DEN-KC, MIA-BUF and NYJ-NE end tied, so nobody has a win and only the WAS-PHI tiebreak game remains. Its
  // tiebreak-only impact text (the slate would end with the tiebreak total unknown) names submitters only.
  const cfg=nsWeek(['Thaddeus']);
  const events=[game({away:'DEN',home:'KC',awayScore:'20',homeScore:'20'}),game({away:'MIA',home:'BUF',awayScore:'17',homeScore:'17'}),game({away:'NYJ',home:'NE',awayScore:'10',homeScore:'10'}),scheduled({away:'WSH',home:'PHI'})];
  const v=await view({weekConfig:cfg,initialScorePayload:{events}});
  assert.equal(v.warning(),'');
  assert.equal(v.$('swingLeft').textContent,'1');
  assert.deepEqual(swingGames(v),[[
    ['WAS','eliminates JC · tiebreak total decides D.C., DJS'],
    ['PHI','clinches JC by record'],
    ['TIE','tiebreak total decides D.C., JC, DJS']
  ]],'tiebreak-only impact text must name only entries that submitted picks');
  assert(!v.$('swingList').innerHTML.includes('Thaddeus'),'a no-submission entry is never named in tiebreak impact text');
  assert.equal(v.$('scenarioCount').textContent,'3 outcomes · 3 race paths');
  assert.deepEqual(race(v),[
    ['D.C.','ALIVE','Ceiling 1 wins',['WAS']],
    ['JC','ALIVE','Ceiling 1 wins',['PHI']],
    ['DJS','ALIVE','Ceiling 1 wins',['WAS']],
    ['Thaddeus','OUT','No picks submitted',[]]
  ]);
  noEmptyLogo(v,'NS-E');
  await sameAsAbsent(v,cfg,['Thaddeus'],events,'NS-E');
}

{
  // HDC-06 NS-F. Completed weeks are unchanged: with every game final the race shows the result exactly as before, and the
  // no-submission entry keeps its completed-week row (OUT · Slate complete).
  const cfg=nsWeek(['Thaddeus']);
  const finals=total=>[game({away:'DEN',home:'KC',awayScore:'17',homeScore:'24'}),game({away:'MIA',home:'BUF',awayScore:'10',homeScore:'20'}),game({away:'NYJ',home:'NE',awayScore:'9',homeScore:'13'}),game({away:'WSH',home:'PHI',awayScore:'17',homeScore:String(total-17)})];
  const v=await view({weekConfig:cfg,initialScorePayload:{events:finals(40)}});
  assert.equal(v.warning(),'');
  assert.equal(v.$('scenarioCount').textContent,'Final');
  assert.equal(v.$('swingLeft').textContent,'0');
  assert.equal(v.$('swingMeta').textContent,'0 left');
  assert.equal(v.$('swingList').innerHTML,'<div class="empty">No swing games remain. The race is decided by finalized results and, if needed, the tiebreak.</div>');
  assert.deepEqual(race(v),[
    ['D.C.','OUT','Slate complete',[]],
    ['JC','OUT','Slate complete',[]],
    ['DJS','WINNER','Pool winner',[]],
    ['Thaddeus','OUT','Slate complete',[]]
  ]);
  // rank, entry, W, L, tiebreak
  assert.deepEqual(standingCells(v).map(r=>[r[0],r[1],r[3],r[4],r[r.length-1]]),[['1','DJS','3','1','38 Δ 2'],['2','JC','3','1','44 Δ 4'],['3','D.C.','2','2','41 Δ 1'],['4','Thaddeus','0','4','—']]);
  assert.deepEqual([v.$('leaderKicker').textContent,v.$('leaderName').textContent,v.$('leaderRecord').textContent],['Group winner','DJS','3–1']);
  assert.equal(v.$('tbNote').textContent,'Tiebreak final total: 40. Tiebreak differences are active.');
  noEmptyLogo(v,'NS-F');
  // JC and DJS are both 3-1 and both 3 away from a total of 41: co-winners.
  v.setPayload({events:finals(41)});await v.refresh();
  assert.equal(v.warning(),'');
  assert.deepEqual(race(v),[
    ['D.C.','OUT','Slate complete',[]],
    ['JC','WINNER','Co-winner · exact tiebreak tied',[]],
    ['DJS','WINNER','Co-winner · exact tiebreak tied',[]],
    ['Thaddeus','OUT','Slate complete',[]]
  ]);
  assert.deepEqual([v.$('leaderKicker').textContent,v.$('leaderName').textContent,v.$('leaderRecord').textContent],['Group co-winners','JC / DJS','3–1']);
  noEmptyLogo(v,'NS-F co-winners');
}

{
  // HDC-06 NS-G. Every tracked entry submitted nothing: no swing games, no contenders, no rooting chips, and nothing throws or
  // renders NaN or Infinity, before kickoff, part-way through, or once the slate is complete. The completed-week race display
  // is frozen in HDC-06, so with every game final it renders exactly as it did before, even here.
  const names=Object.keys(nsBallots),events=nsScheduled();
  const v=await view({weekConfig:nsWeek(names),initialScorePayload:{events}});
  const settled=label=>{
    assert.equal(v.warning(),'',label);
    assert.match(v.$('sync').textContent,/^LIVE/,label);
    assert.doesNotMatch(v.html(),/NaN|Infinity/,`${label}: no NaN or Infinity may render`);
    noEmptyLogo(v,label);
  };
  settled('NS-G before kickoff');
  assert.equal(v.$('swingLeft').textContent,'0');
  assert.equal(v.$('swingMeta').textContent,'0 left');
  assert.equal(v.$('scenarioCount').textContent,'81 outcomes · 1 race paths');
  assert.deepEqual(race(v),names.map(name=>[name,'OUT','No picks submitted',[]]));
  v.setPayload({events:[game({away:'DEN',home:'KC',awayScore:'17',homeScore:'24'}),...events.slice(1)]});await v.refresh();
  settled('NS-G one final');
  assert.equal(v.$('swingLeft').textContent,'0');
  assert.equal(v.$('scenarioCount').textContent,'27 outcomes · 1 race paths');
  assert.deepEqual(race(v),names.map(name=>[name,'OUT','No picks submitted',[]]));
  v.setPayload({events:[game({away:'DEN',home:'KC',awayScore:'17',homeScore:'24'}),game({away:'MIA',home:'BUF',awayScore:'10',homeScore:'20'}),game({away:'NYJ',home:'NE',awayScore:'9',homeScore:'13'}),game({away:'WSH',home:'PHI',awayScore:'17',homeScore:'23'})]});await v.refresh();
  settled('NS-G all final');
  assert.equal(v.$('scenarioCount').textContent,'Final');
  assert.deepEqual(race(v),names.map(name=>[name,'WINNER','Co-winner · exact tiebreak tied',[]]),'the frozen completed-week display');
}

{
  // HDC-06 NS-H. A badge never emits a logo image for an empty or missing team code; it keeps the text fallback. Valid codes,
  // aliases included, render exactly as before, and the race and swing panels still request their teams' logos.
  const v=await view({weekConfig:nsWeek(['Thaddeus']),initialScorePayload:{events:nsScheduled()}});
  for(const code of [null,undefined,''])assert.equal(v.mod.badge(code),'<span class="badge" style="--tc:#33465f" aria-hidden="true"><span class="badge-fallback"></span></span>',`badge(${JSON.stringify(code)}) must keep the text fallback without an image`);
  assert.equal(v.mod.badge(null,'tiny'),'<span class="badge tiny" style="--tc:#33465f" aria-hidden="true"><span class="badge-fallback"></span></span>');
  const logo=(file,team,color,size='')=>`<span class="badge${size?` ${size}`:''}" style="--tc:${color}" aria-hidden="true"><span class="badge-fallback">${team}</span><img class="team-logo" src="https://a.espncdn.com/i/teamlogos/nfl/500/${file}.png" alt="" loading="lazy" decoding="async" onerror="this.hidden=true"></span>`;
  assert.equal(v.mod.badge('KC'),logo('kc','KC','#E31837'));
  assert.equal(v.mod.badge('GB','mini'),logo('gb','GB','#203731','mini'));
  assert.equal(v.mod.badge('WAS'),logo('wsh','WAS','#5A1414'),'WAS keeps its wsh.png logo');
  assert.equal(v.mod.badge('WSH','tiny'),logo('wsh','WAS','#5A1414','tiny'),'the WSH alias still renders WAS with wsh.png');
  assert.equal(v.mod.badge('JAC','mini'),logo('jax','JAX','#006778','mini'),'the JAC alias still renders JAX with jax.png');
  const raceList=v.$('raceList').innerHTML,chips=race(v).flatMap(r=>r[3]);
  assert.equal(chips.length,6);
  assert.equal((raceList.match(/<img /g)||[]).length,chips.length,'every rooting chip, and only a rooting chip, carries a logo');
  assert.equal((raceList.match(/teamlogos\/nfl\/500\/wsh\.png/g)||[]).length,2,'the WAS rooting chips request wsh.png');
  assert.match(v.$('swingList').innerHTML,/teamlogos\/nfl\/500\/wsh\.png/);
  assert.match(v.$('gamegrid').innerHTML,/teamlogos\/nfl\/500\/wsh\.png/);
  noEmptyLogo(v,'NS-H');
}

{
  // HDC-06 S1. Only the exact no-submission shape is one: the full pick list with every pick null, and a null tiebreak. A
  // short or long list, a tiebreak, a missing tiebreak, a partially missing ballot or the anonymous 0 marker is not: the page
  // refuses such a tracked entry exactly as before, so it is never classified as a no-submission entry.
  const load=async thaddeus=>{
    const cfg=nsWeek([]);cfg.participants[3]={id:'Thaddeus',displayName:'Thaddeus',...thaddeus};
    const log=console.error;console.error=()=>{};
    try{const v=await view({weekConfig:cfg,initialScorePayload:{events:nsScheduled()}});return v.$('sync').textContent==='CONFIG UNAVAILABLE'?v.$('error').innerHTML:race(v).at(-1)}
    finally{console.error=log}
  };
  for(const [label,thaddeus,message] of [
    ['a short pick list',{pickNumbers:[null,null,null],tiebreak:null},'Invalid entry Thaddeus'],
    ['a long pick list',{pickNumbers:[null,null,null,null,null],tiebreak:null},'Invalid entry Thaddeus'],
    ['a tiebreak',{pickNumbers:[null,null,null,null],tiebreak:47},'Thaddeus: unknown pick null'],
    ['a missing tiebreak',{pickNumbers:[null,null,null,null]},'Invalid entry Thaddeus'],
    ['a partially missing ballot',{pickNumbers:[2,null,null,null],tiebreak:null},'Invalid entry Thaddeus'],
    ['a partially missing ballot with a tiebreak',{pickNumbers:[2,null,null,null],tiebreak:47},'Thaddeus: unknown pick null'],
    ['the anonymous no-pick marker',{pickNumbers:[0,0,0,0],tiebreak:null},'Invalid entry Thaddeus']
  ])assert.equal(await load(thaddeus),`<div class="error">Unable to load weekly pool data: ${message}</div>`,`${label} is not a no-submission entry`);
  assert.deepEqual(await load({pickNumbers:[null,null,null,null],tiebreak:null}),['Thaddeus','OUT','No picks submitted',[]],'the exact shape is a no-submission entry');
}

{
  // HDC-06 15-game regression, shaped like the race that exposed the defect: three submitters disagree on 7 of 15 games and a
  // fourth tracked entry submitted nothing. That entry turned all 15 games into swing games (3^15 race paths); only the 7
  // disagreements are swing games, so 3^7 = 2,187 race paths among 3^15 = 14,348,907 outcomes.
  const teams=[['ARI','ATL'],['BAL','BUF'],['CAR','CHI'],['CIN','CLE'],['DAL','DEN'],['DET','GB'],['HOU','IND'],['JAX','KC'],['LV','LAC'],['LAR','MIA'],['MIN','NE'],['NO','NYG'],['NYJ','PHI'],['PIT','SF'],['SEA','TB']];
  const games=teams.map(([away,home],i)=>({away,home,awayNumber:2*i+1,homeNumber:2*i+2,date:'2026-09-27'}));
  const ballot=sides=>[...sides].map((side,i)=>side==='a'?games[i].awayNumber:games[i].homeNumber);
  const cfg={schemaVersion:1,season:2026,week:3,tiebreakGameIndex:14,games,participants:[
    {id:'avery',displayName:'Avery',pickNumbers:ballot('ahhahhhaaahhaah'),tiebreak:41},
    {id:'blake',displayName:'Blake',pickNumbers:ballot('hhaahhhaahhaahh'),tiebreak:44},
    {id:'casey',displayName:'Casey',pickNumbers:ballot('hhhahahhaahaahh'),tiebreak:38},
    {id:'drew',displayName:'Drew',pickNumbers:games.map(()=>null),tiebreak:null}
  ]};
  const events=teams.map(([away,home])=>scheduled({away,home}));
  const v=await view({weekConfig:cfg,initialScorePayload:{events}});
  assert.equal(v.warning(),'');
  assert.equal(v.$('swingLeft').textContent,'7');
  assert.deepEqual(matchups(v),['ARI@ATL','CAR@CHI','DET@GB','JAX@KC','LAR@MIA','NO@NYG','PIT@SF']);
  assert.equal(v.mod.raceStatus().racePaths,2187);
  assert.equal(v.$('scenarioCount').textContent,`${(14348907).toLocaleString()} outcomes · ${(2187).toLocaleString()} race paths`);
  assert.deepEqual(race(v).map(([name,status,note,roots])=>[name,status,note,roots.length]),[
    ['Avery','ALIVE','Ceiling 15 wins',7],['Blake','ALIVE','Ceiling 15 wins',7],['Casey','ALIVE','Ceiling 15 wins',7],['Drew','OUT','No picks submitted',0]
  ]);
  noEmptyLogo(v,'15-game');
  await sameAsAbsent(v,cfg,['Drew'],events,'15-game');
}

// HDC-10. Pick'em grades a completed event only when the final evidence the feed exposes agrees with it, as Survivor
// (survivor-math.js) requires: the event state is 'post'; a status name, where given, names a FINAL and no halted game; the
// competition status does not explicitly contradict the event; no winner flag claims a team that did not outscore its
// opponent. Absent evidence stays compatible; explicit contradiction leaves the game ungraded and is surfaced. Fixtures
// follow ESPN's finals (2020-2026 scoreboards): the competition repeats the event status, each competitor carries a boolean
// winner flag (false/false on a tie), and an overtime final is STATUS_FINAL with detail 'Final/OT'.
const espnFinal=({away='DEN',home='KC',awayScore='24',homeScore='17',detail='Final'}={})=>{
  const type={id:'3',name:'STATUS_FINAL',state:'post',completed:true,description:'Final',detail,shortDetail:detail};
  const tie=awayScore===homeScore,awayWon=Number(awayScore)>Number(homeScore);
  return{id:`${away.toLowerCase()}-${home.toLowerCase()}`,season:{year:2026,type:2},week:{number:3},status:{clock:0,displayClock:'0:00',period:4,type:{...type}},
    competitions:[{competitors:[
      {homeAway:'home',winner:!tie&&!awayWon,team:{abbreviation:home},score:homeScore},
      {homeAway:'away',winner:!tie&&awayWon,team:{abbreviation:away},score:awayScore}
    ],status:{clock:0,displayClock:'0:00',period:4,type:{...type},isTBDFlex:false}}]};
};
const finalWith=(mutate,scores)=>{const e=espnFinal(scores);mutate(e);return e};
const eventType=e=>e.status.type,competitionType=e=>e.competitions[0].status.type,competitorsOf=e=>e.competitions[0].competitors;
// [label, valid final, its result: the winner or 'tie']. D.C. picked DEN and DJS picked KC.
const VALID_FINALS=[
  ['STATUS_FINAL with every piece of evidence',espnFinal(),'DEN'],
  ['a home win with its winner flags',espnFinal({awayScore:'17',homeScore:'24'}),'KC'],
  ['Final/OT (STATUS_FINAL, detail Final/OT)',espnFinal({awayScore:'27',homeScore:'24',detail:'Final/OT'}),'DEN'],
  ['a tie (Final/OT, winner flags false/false)',espnFinal({awayScore:'20',homeScore:'20',detail:'Final/OT'}),'tie'],
  ['no status name',finalWith(e=>{delete eventType(e).name;delete competitionType(e).name}),'DEN'],
  ['a null status name',finalWith(e=>{eventType(e).name=null;competitionType(e).name=null}),'DEN'],
  ['no competition status',finalWith(e=>{delete e.competitions[0].status}),'DEN'],
  ['a competition status without a type',finalWith(e=>{delete e.competitions[0].status.type}),'DEN'],
  ['no winner flags',finalWith(e=>{for(const x of competitorsOf(e))delete x.winner}),'DEN'],
  ['a tie without winner flags',finalWith(e=>{for(const x of competitorsOf(e))delete x.winner},{awayScore:'20',homeScore:'20'}),'tie'],
  ['no optional evidence at all (the deployment-1 shape)',finalWith(e=>{delete eventType(e).name;delete e.competitions[0].status;for(const x of competitorsOf(e))delete x.winner}),'DEN']
];
// [label, contradictory "final", what contradicts it]. Each is a 31-10 KC rout that would hand DJS the week if graded.
const ROUT={awayScore:'10',homeScore:'31'};
const CONTRADICTORY_FINALS=[
  ['completed:true + state:in',finalWith(e=>{eventType(e).state='in'},ROUT),'status'],
  ['completed:true + state:pre',finalWith(e=>{eventType(e).state='pre'},ROUT),'status'],
  ['completed:true without a state (Survivor requires post)',finalWith(e=>{delete eventType(e).state},ROUT),'status'],
  ['completed:true + STATUS_CANCELED',finalWith(e=>{eventType(e).name='STATUS_CANCELED'},ROUT),'status'],
  ['completed:true + STATUS_SUSPENDED',finalWith(e=>{eventType(e).name='STATUS_SUSPENDED'},ROUT),'status'],
  ['completed:true + STATUS_POSTPONED',finalWith(e=>{eventType(e).name='STATUS_POSTPONED'},ROUT),'status'],
  ['completed:true + STATUS_FORFEIT',finalWith(e=>{eventType(e).name='STATUS_FORFEIT'},ROUT),'status'],
  ['completed:true + a status name that is not a final',finalWith(e=>{eventType(e).name='STATUS_IN_PROGRESS'},ROUT),'status'],
  ['completed:true + a status name that is not a string',finalWith(e=>{eventType(e).name=3},ROUT),'status'],
  ['event final + competition state:in',finalWith(e=>{competitionType(e).state='in'},ROUT),'status'],
  ['event final + competition completed:false',finalWith(e=>{competitionType(e).completed=false},ROUT),'status'],
  ['event final + competition STATUS_CANCELED',finalWith(e=>{competitionType(e).name='STATUS_CANCELED'},ROUT),'status'],
  ['winner flags contradicting the score',finalWith(e=>{for(const x of competitorsOf(e))x.winner=!x.winner},ROUT),'winner flag'],
  ['a winner flag on a tie',finalWith(e=>{competitorsOf(e).find(x=>x.homeAway==='home').winner=true},{awayScore:'20',homeScore:'20'}),'winner flag']
];
const pickCells=v=>[...v.$('pickBody').innerHTML.matchAll(/<td class="c ([a-z]+)">/g)].map(m=>m[1]);
const records=v=>standingCells(v).map(r=>[r[1],r[3],r[4]]);
// Everything a grade reaches: final count, standings, pick board, game cards, leader, warning and the sync label.
const graded=v=>({finals:v.$('finals').textContent,standings:v.$('standings').innerHTML,picks:v.$('pickBody').innerHTML,games:v.$('gamegrid').innerHTML,
  leader:[v.$('leaderKicker').textContent,v.$('leaderName').textContent,v.$('leaderRecord').textContent],warning:v.warning(),sync:v.$('sync').textContent.split(' · ')[0]});
const PROJECTED_AT='2026-09-27T20:00:00.000Z';

{
  // HDC-10 R3. A contradictory final grades nothing: from kickoff no win, loss or tie is recorded, the scheduled game card
  // stays, and the ignored final is surfaced as a warning with an INCOMPLETE sync label. A verified final still grades, and
  // the same contradiction arriving later never regrades it: the verified 24-17 result is kept.
  for(const [label,contradiction,kind] of CONTRADICTORY_FINALS){
    const ignored=new RegExp(`^Some feed data was ignored to protect standings: DEN-KC: final with contradictory ${kind} ignored$`);
    const v=await view({initialScorePayload:{events:[scheduled({away:'DEN',home:'KC'})]}});
    v.setPayload({events:[structuredClone(contradiction)]});await v.refresh();
    assert.equal(v.$('finals').textContent,'0/1',`${label}: never counted as a final`);
    assert.deepEqual(records(v),[['D.C.','0','0'],['DJS','0','0']],`${label}: no win, loss or tie from the contradictory final`);
    assert.deepEqual(pickCells(v),['pending','pending'],`${label}: no pick graded`);
    assert.match(v.$('gamegrid').innerHTML,/^<div class="game pre">/,`${label}: the last verified (scheduled) game card is kept`);
    assert.doesNotMatch(v.$('gamegrid').innerHTML,/FINAL/,`${label}: the game is never shown as final`);
    assert.match(v.warning(),ignored,`${label}: the ignored final is surfaced`);
    assert.match(v.$('sync').textContent,/^INCOMPLETE · .* · 1 warning$/,`${label}: sync reports incomplete data, not a clean final`);

    v.setPayload({events:[espnFinal()]});await v.refresh();
    assert.deepEqual([v.warning(),v.$('finals').textContent,...records(v)],['','1/1',['D.C.','1','0'],['DJS','0','1']],`${label}: a verified final still grades`);
    v.setPayload({events:[structuredClone(contradiction)]});await v.refresh();
    assert.equal(v.$('finals').textContent,'1/1',`${label}: the verified final stays final`);
    assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']],`${label}: the verified result is never regraded`);
    assert.deepEqual(pickCells(v),['ok','bad']);
    assert.match(v.$('gamegrid').innerHTML,/^<div class="game final">.*<span class="score">24<\/span>.*<span class="score">17<\/span>/,`${label}: the verified 24-17 game card is kept`);
    assert.match(v.warning(),ignored,`${label}: the later contradiction is surfaced too`);
    assert.match(v.$('sync').textContent,/^INCOMPLETE · .* · 1 warning$/);
  }
}

{
  // HDC-10 R4. Valid finals grade exactly as before, absent evidence included, and the projected feed (what nflscores2
  // serves) renders the identical page.
  const expected={DEN:[['D.C.','1','0'],['DJS','0','1']],KC:[['DJS','1','0'],['D.C.','0','1']],tie:[['D.C.','0','1'],['DJS','0','1']]};
  const cells={DEN:['ok','bad'],KC:['bad','ok'],tie:['bad','bad']};
  for(const [label,final,result] of VALID_FINALS){
    const v=await view({initialScorePayload:{events:[structuredClone(final)]}}),page=graded(v);
    assert.equal(page.warning,'',`${label}: no warning`);
    assert.equal(page.sync,'LIVE',`${label}: a clean final`);
    assert.equal(page.finals,'1/1',`${label}: graded final`);
    assert.deepEqual(records(v),expected[result],`${label}: graded as before`);
    assert.deepEqual(pickCells(v),cells[result],`${label}: pick board graded as before`);
    assert.match(page.games,result==='tie'?/^<div class="game final tie">/:/^<div class="game final">/,`${label}: final game card`);
    const viaProxy=await view({initialScorePayload:projectScoreboard({events:[structuredClone(final)]},PROJECTED_AT)});
    assert.deepEqual(graded(viaProxy),page,`${label}: the projected final renders identically`);
  }
}

{
  // HDC-10 R5. One shared fixture set, so the two public surfaces cannot drift apart again: Pick'em and Survivor
  // (survivorBuildResults, which the Survivor view and Admin use) must reach the same verdict on every event, from the raw
  // ESPN event and from its projection: the winner, a tie, or no safe final (null).
  const pickem={ok:'DEN',bad:'KC',pending:null};
  for(const [label,event,expected] of [...VALID_FINALS,...CONTRADICTORY_FINALS.map(([label,event])=>[label,event,null])]){
    const verdicts={};
    for(const [source,payload] of [['raw',{events:[structuredClone(event)]}],['projected',projectScoreboard({events:[structuredClone(event)]},PROJECTED_AT)]]){
      const v=await view({initialScorePayload:payload}),result=survivorBuildResults(payload.events,{season:2026,week:3}).get('DEN');
      verdicts[`Pick'em ${source}`]=/class="game final tie"/.test(v.$('gamegrid').innerHTML)?'tie':pickem[pickCells(v)[0]];
      verdicts[`Survivor ${source}`]=result?.completed===true&&!result.unresolved?(result.tie?'tie':result.winner):null;
    }
    assert.deepEqual(verdicts,{"Pick'em raw":expected,'Survivor raw':expected,"Pick'em projected":expected,'Survivor projected':expected},`${label}: Pick'em and Survivor agree, raw and projected`);
  }
}

console.log('weekly public feed-context, malformed-event isolation, fail-safe preservation, foreground-refresh, no-submission race-boundary and final-evidence regressions passed');


// HDC-11. A game the feed reports as not completed whose event or competition status explicitly names a halted state
// (canceled, postponed, suspended, forfeit) stays ungraded exactly as before: it is not a final, and the standings, pick
// board, games, race and tiebreak are those of the same game without its status name. The page now says why the week is
// incomplete: a warning names the matchup and the halted status (and says when it is the tiebreak game) and that the week
// awaits a pool ruling or official resolution, so the sync label reads INCOMPLETE instead of a clean LIVE. Fixtures follow
// ESPN 2022 Week 17 BUF at CIN (event 401437947): STATUS_CANCELED, state post, completed:false, 0-0, the competition
// repeating the event status. BUF-CIN is game 2; D.C. picked DEN and BUF, DJS picked KC and CIN.
const haltConfig=(tiebreakGameIndex=1)=>({schemaVersion:1,season:2026,week:3,tiebreakGameIndex,
  games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-27'},{away:'BUF',home:'CIN',awayNumber:3,homeNumber:4,date:'2026-09-28'}],
  participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1,3],tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2,4],tiebreak:44}]});
const espnStatus=(name,state,detail)=>({id:'5',...(name===undefined?{}:{name}),state,completed:false,description:detail,detail,shortDetail:detail});
const bufCin=(type=espnStatus('STATUS_CANCELED','post','Canceled'),comp=type)=>({id:'401437947',date:'2026-09-28T00:15Z',season:{year:2026,type:2},week:{number:3},
  status:{clock:372,displayClock:'6:12',period:1,type:{...type}},
  competitions:[{...(comp?{status:{clock:372,displayClock:'6:12',period:1,type:{...comp},isTBDFlex:false}}:{}),competitors:[
    {homeAway:'home',team:{abbreviation:'CIN'},score:'0'},{homeAway:'away',team:{abbreviation:'BUF'},score:'0'}]}]});
const midGame=e=>{const [cin,buf]=e.competitions[0].competitors;cin.score='7';buf.score='3';return e};
const withoutNames=e=>{delete e.status.type.name;if(e.competitions[0].status?.type)delete e.competitions[0].status.type.name;return e};
const HALT_PAGE=['standings','homeStandings','gamegrid','homeGamePreview','pickHead','pickBody','raceList','swingList','scenarioCount','swingMeta','swingLeft','finals','liveCount','left','mnf','tbNote','leaderKicker','leaderName','leaderRecord','leaderNote','bestWins','progressText','fieldSummary','footerRule'];
const haltPage=v=>Object.fromEntries(HALT_PAGE.map(id=>[id,`${v.$(id).innerHTML}|${v.$(id).textContent}`]));
const syncLabel=v=>v.$('sync').textContent.split(' · ')[0];
const HALTED_GAMES=[
  ['STATUS_CANCELED (ESPN 2022 Week 17 BUF at CIN)',bufCin(),'STATUS_CANCELED'],
  ['STATUS_POSTPONED (the ESPN 2017 Week 1 TB at MIA shape)',bufCin(espnStatus('STATUS_POSTPONED','post','Postponed')),'STATUS_POSTPONED'],
  ['STATUS_POSTPONED before kickoff',bufCin(espnStatus('STATUS_POSTPONED','pre','Postponed')),'STATUS_POSTPONED'],
  ['STATUS_SUSPENDED mid-game',midGame(bufCin(espnStatus('STATUS_SUSPENDED','in','Suspended'))),'STATUS_SUSPENDED'],
  ['STATUS_FORFEIT',bufCin(espnStatus('STATUS_FORFEIT','post','Forfeit')),'STATUS_FORFEIT'],
  ['the event status name only (no competition status)',bufCin(espnStatus('STATUS_CANCELED','post','Canceled'),null),'STATUS_CANCELED'],
  ['the competition status name only',bufCin(espnStatus(undefined,'post','Canceled'),espnStatus('STATUS_CANCELED','post','Canceled')),'STATUS_CANCELED']
];

{
  // HDC-11 R4. The halted game is never graded and changes nothing but the warning and the sync label, as the tiebreak
  // game (index 1) and as an ordinary game (index 0).
  for(const tiebreakGameIndex of [1,0]){
    for(const [label,halted,name] of HALTED_GAMES){
      const cfg=haltConfig(tiebreakGameIndex),as=`${label}${tiebreakGameIndex===1?' (tiebreak game)':''}`;
      const unnamed=await view({weekConfig:cfg,initialScorePayload:{events:[espnFinal(),withoutNames(structuredClone(halted))]}});
      const before={page:haltPage(unnamed),warning:unnamed.warning(),sync:syncLabel(unnamed)};
      assert.deepEqual([before.warning,before.sync],['','LIVE'],`${as}: without its status name the same game raises no warning (production behaviour)`);
      const v=await view({weekConfig:cfg,initialScorePayload:{events:[espnFinal(),structuredClone(halted)]}});
      assert.deepEqual(haltPage(v),before.page,`${as}: standings, picks, games, race and tiebreak are those of the same game without its status name`);
      assert.equal(v.$('finals').textContent,'1/2',`${as}: never counted as a final`);
      assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']],`${as}: only the DEN-KC final is graded`);
      assert.deepEqual(pickCells(v),['ok','pending','bad','pending'],`${as}: the halted game's picks stay ungraded`);
      assert.equal(v.warning(),`Some feed data was ignored to protect standings: BUF-CIN: ${tiebreakGameIndex===1?'tiebreak game':'game'} halted (${name}), not graded; awaiting a pool ruling or official resolution`,`${as}: the warning names the matchup, the halted status and the pending ruling`);
      assert.match(v.$('sync').textContent,/^INCOMPLETE · .* · 1 warning$/,`${as}: sync reports an incomplete week, not a clean LIVE state`);
      assert.doesNotMatch(v.warning(),/pending/i,`${as}: not merely a pending game`);
    }
  }
  // The canceled tiebreak game leaves the tiebreak exactly as unresolved as before: no total and no differences.
  const v=await view({weekConfig:haltConfig(1),initialScorePayload:{events:[espnFinal(),bufCin()]}});
  assert.deepEqual([v.$('mnf').textContent,v.$('tbNote').textContent,v.$('left').textContent],['—','Tiebreak guesses: D.C. 41 · DJS 44.','1']);
  assert.deepEqual(standingCells(v).map(r=>r[r.length-1]),['41','44'],'no tiebreak differences');
  assert.match(v.$('gamegrid').innerHTML,/<div class="status">Canceled<\/div>/,'the game card keeps ESPN\'s own status text');
}

{
  // HDC-11 R5. Ordinary unfinished games keep exactly the production page: no warning, a LIVE sync label, ungraded picks.
  for(const [label,event] of [
    ['scheduled (STATUS_SCHEDULED)',bufCin(espnStatus('STATUS_SCHEDULED','pre','Sun 8:15 PM'))],
    ['pregame without a status name',bufCin(espnStatus(undefined,'pre','Sun 8:15 PM'))],
    ['live (STATUS_IN_PROGRESS)',midGame(bufCin(espnStatus('STATUS_IN_PROGRESS','in','6:12 - 1st')))],
    ['halftime (STATUS_HALFTIME)',midGame(bufCin(espnStatus('STATUS_HALFTIME','in','Halftime')))],
    ['end of a period (STATUS_END_PERIOD)',midGame(bufCin(espnStatus('STATUS_END_PERIOD','in','End of 1st')))],
    ['a weather delay expected to resume (STATUS_DELAYED)',midGame(bufCin(espnStatus('STATUS_DELAYED','in','Delayed')))],
    ['a rain delay (STATUS_RAIN_DELAY)',midGame(bufCin(espnStatus('STATUS_RAIN_DELAY','in','Rain Delay')))],
    ['state post without a status name',bufCin(espnStatus(undefined,'post','Canceled'))],
    ['a null status name',bufCin(espnStatus(null,'pre','Sun 8:15 PM'))],
    ['a status name that is not a string',bufCin(espnStatus(5,'pre','Sun 8:15 PM'))]
  ]){
    const v=await view({weekConfig:haltConfig(1),initialScorePayload:{events:[espnFinal(),structuredClone(event)]}});
    assert.equal(v.warning(),'',`${label}: no warning`);
    assert.match(v.$('sync').textContent,/^LIVE · /,`${label}: a clean LIVE sync label`);
    assert.equal(v.$('finals').textContent,'1/2',`${label}: not a final`);
    assert.deepEqual(pickCells(v),['ok','pending','bad','pending'],`${label}: ungraded`);
  }
}

{
  // HDC-11 R6. Nothing is memoized: the same event reported later as an ordinary live game, then as a verified final, is
  // judged exactly as such. The warning clears and the final grades under the HDC-10 rules.
  for(const [label,halted] of [['STATUS_POSTPONED',bufCin(espnStatus('STATUS_POSTPONED','pre','Postponed'))],['STATUS_SUSPENDED',midGame(bufCin(espnStatus('STATUS_SUSPENDED','in','Suspended')))]]){
    const v=await view({weekConfig:haltConfig(1),initialScorePayload:{events:[espnFinal(),halted]}});
    assert.match(v.warning(),/BUF-CIN: tiebreak game halted/,`${label}: awaiting a ruling first`);
    v.setPayload({events:[espnFinal(),midGame(bufCin(espnStatus('STATUS_IN_PROGRESS','in','10:00 - 3rd')))]});await v.refresh();
    assert.deepEqual([v.warning(),syncLabel(v),v.$('liveCount').textContent,v.$('finals').textContent],['','LIVE','1','1/2'],`${label}: resumed as an ordinary live game`);
    v.setPayload({events:[espnFinal(),{...espnFinal({away:'BUF',home:'CIN',awayScore:'27',homeScore:'24'}),id:'401437947'}]});await v.refresh();
    assert.deepEqual([v.warning(),syncLabel(v),v.$('finals').textContent],['','LIVE','2/2'],`${label}: the verified final grades`);
    assert.deepEqual(records(v),[['D.C.','2','0'],['DJS','0','2']]);
    assert.equal(v.$('tbNote').textContent,'Tiebreak final total: 51. Tiebreak differences are active.');
  }
}

{
  // HDC-11 R7. nflscores2 forwards the status names, so the projected feed renders the identical page, warning and sync
  // label included, and Survivor (survivorBuildResults) sees the same halted game, raw and projected.
  for(const [label,halted,name] of HALTED_GAMES){
    const raw={events:[espnFinal(),structuredClone(halted)]},projected=projectScoreboard(structuredClone(raw),PROJECTED_AT);
    const a=await view({weekConfig:haltConfig(1),initialScorePayload:raw}),rawPage={page:haltPage(a),warning:a.warning(),sync:syncLabel(a)};
    const b=await view({weekConfig:haltConfig(1),initialScorePayload:projected});
    assert.deepEqual({page:haltPage(b),warning:b.warning(),sync:syncLabel(b)},rawPage,`${label}: the projected feed renders the identical page`);
    assert(rawPage.warning.endsWith(`BUF-CIN: tiebreak game halted (${name}), not graded; awaiting a pool ruling or official resolution`),`${label}: both pages carry the halted warning`);
    for(const payload of [raw,projected]){
      const results=survivorBuildResults(payload.events,{season:2026,week:3});
      for(const team of ['BUF','CIN'])assert.deepEqual([results.get(team).completed,results.get(team).halted],[false,name],`${label}: Survivor sees the same halted ${team} game`);
    }
  }
}

{
  // HDC-11 R8/R9. completed:true is judged only as a final (HDC-10): a halted name on a completed event, FORFEIT included,
  // stays a contradictory final and never a pending ruling, while a consistent final that mentions a forfeit only in its
  // detail text grades as before.
  for(const name of ['STATUS_CANCELED','STATUS_POSTPONED','STATUS_SUSPENDED','STATUS_FORFEIT','STATUS_FINAL_FORFEIT']){
    const contradiction=finalWith(e=>{eventType(e).name=name;competitionType(e).name=name},{away:'BUF',home:'CIN',awayScore:'10',homeScore:'31'});
    const v=await view({weekConfig:haltConfig(1),initialScorePayload:{events:[espnFinal(),contradiction]}});
    assert.equal(v.warning(),'Some feed data was ignored to protect standings: BUF-CIN: final with contradictory status ignored',`completed:true + ${name}: still the HDC-10 contradiction`);
    assert.equal(v.$('finals').textContent,'1/2',`completed:true + ${name}: never graded`);
  }
  const forfeitFinal=finalWith(e=>{for(const t of [eventType(e),competitionType(e)])Object.assign(t,{detail:'Final - Forfeit',shortDetail:'Final - Forfeit'})},{away:'BUF',home:'CIN',awayScore:'0',homeScore:'2'});
  const v=await view({weekConfig:haltConfig(1),initialScorePayload:{events:[espnFinal(),forfeitFinal]}});
  assert.deepEqual([v.warning(),syncLabel(v),v.$('finals').textContent],['','LIVE','2/2'],'a consistent completed final mentioning a forfeit grades');
  assert.deepEqual(records(v),[['D.C.','1','1'],['DJS','1','1']]);
}

console.log('weekly HDC-11 halted-game warning, ungraded halted game, unchanged standings and tiebreak, ordinary-pending, recovery, projected-feed and HDC-10 completed-final regressions passed');


// HDC-12. Contest-scoped commissioner rulings in Pick'em. The page reads the public columns of the 2026 Pick'em contest,
// its policy history and the selected week's rulings, applies only a confirmed incident ruling (void: no win, no loss, no
// points, not remaining, never shown as an NFL tie), keeps the NFL fact apart from the pool consequence, voids the tiebreak
// without choosing another game, and fails closed when the ruling data cannot be read. Fixtures reuse the HDC-11 Week-3
// BUF at CIN game (event 401437947, STATUS_CANCELED): D.C. picked DEN and BUF, DJS picked KC and CIN. Each regression
// reports through one collector; the block fails at its end if any did.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const voids=(consequences,o={},firstId=1)=>consequences.map((consequence,i)=>({ruling_id:firstId+i,contest_id:PK_CONTEST,contest_type:'pickem',week:3,away_team:'BUF',home_team:'CIN',
    policy_revision:1,chain_seq:i+1,parent_ruling_id:i?firstId+i-1:null,consequence,incident_status:'STATUS_CANCELED',event_id:'401437947',evidence_source:'nflscores2',
    public_note:i?null:'League canceled the game; voided for this contest.',created_at:'2026-10-08T12:00:00+00:00',...PRIVATE,...o}));
  const canceledGame=(away,home,id)=>{const e=bufCin();e.id=id;const [h,a]=e.competitions[0].competitors;h.team.abbreviation=home;a.team.abbreviation=away;return e};
  const page=async({tiebreakGameIndex=0,events=[espnFinal(),bufCin()],rulings=voids(['void']),store=null,weekConfig=null}={})=>
    view({weekConfig:weekConfig||haltConfig(tiebreakGameIndex),initialScorePayload:{events},store:store||pickemStore({nfl_incident_rulings:rulings})});
  const card=(v,away)=>v.$('gamegrid').innerHTML.split('<div class="game').slice(1).find(g=>g.includes(`<span class="abbr">${away}</span>`))||'';
  const rules=v=>v.$('pickemRules').innerHTML;
  const esc=t=>String(t).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const banner=v=>v.$('error').children.map(c=>c.textContent).join('\n');

  await regression('the page imports the HDC-12 evaluator',()=>assert.match(rulingsFrom||'',/^from '\.\/contest-rulings\.js\?v=\d+';$/,'weekly-app.js must import the versioned contest-rulings.js'));
  await regression("the public loader requests only public columns of the Pick'em contest and the selected week's rulings, with the anonymous token",async()=>{
    const v=await page({rulings:[]});
    for(const table of Object.keys(RULING_COLUMNS)){
      const requests=v.rulingRequests.filter(r=>r.table===table);
      assert(requests.length>=1,`${table} is requested`);
      for(const {url,authorization} of requests){
        assert.deepEqual(url.searchParams.get('select')?.split(','),RULING_COLUMNS[table],`${table}: exactly the public columns`);
        assert.equal(url.searchParams.get('contest_id'),`eq.${PK_CONTEST}`);
        assert.equal(authorization,`Bearer ${v.token}`);
        assert.doesNotMatch(url.href,/admin_note|created_by|select=\*/);
        if(table==='nfl_incident_rulings')assert.equal(url.searchParams.get('week'),'eq.3',"Pick'em needs the selected week's rulings");
      }
    }
  });
  await regression('preservation guard: a valid empty ruling set keeps the HDC-11 INCOMPLETE page',async()=>{
    const v=await page({rulings:[]});
    assert.equal(v.warning(),'Some feed data was ignored to protect standings: BUF-CIN: game halted (STATUS_CANCELED), not graded; awaiting a pool ruling or official resolution');
    assert.equal(syncLabel(v),'INCOMPLETE');assert.equal(v.$('finals').textContent,'1/2');
  });
  await regression('void: no win, no loss, not remaining, resolved for the week; shown as VOID by commissioner ruling, never as an NFL tie',async()=>{
    const v=await page();
    assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']],'only DEN-KC scores; BUF-CIN gives no win and no loss');
    assert.deepEqual(pickCells(v),['ok','void','bad','void']);
    assert.equal(v.$('finals').textContent,'1/2 · 1 void');
    assert.equal(v.$('left').textContent,'0','the void game is not remaining');
    assert.equal(v.$('progressText').textContent,'100%');
    assert.equal(v.warning(),'','the week is not incomplete merely because the canceled game never finished');
    assert.equal(syncLabel(v),'LIVE');
    const buf=card(v,'BUF');
    assert.match(buf,/VOID/);assert.match(buf,/Commissioner ruling/);
    assert.doesNotMatch(buf,/FINAL TIE|final tie|Canceled<\/div>/,'never shown as an NFL tie');
    assert.doesNotMatch(v.$('pickBody').innerHTML,/class="c neutral"/,'no tie cell');
    assert.match(v.$('pickBody').innerHTML,/<td class="c void">.*?VOID/);
    assert.deepEqual([v.$('leaderKicker').textContent,v.$('leaderName').textContent],['Group winner','D.C.']);
    assert.equal(v.$('tbNote').textContent,'Tiebreak final total: 41. Tiebreak differences are active.','the DEN-KC tiebreak is unaffected');
  });
  await regression('voided tiebreak: no tiebreak that week, ranking by scored record only, tied leaders are co-winners, no fallback game',async()=>{
    const v=await page({tiebreakGameIndex:1,events:[espnFinal({awayScore:'20',homeScore:'20'}),bufCin()]});
    assert.deepEqual(records(v),[['D.C.','0','1'],['DJS','0','1']],'the unvoided NFL tie costs both entries a loss; only BUF-CIN is void');
    assert.equal(v.$('mnf').textContent,'VOID');
    assert.match(v.$('tbNote').textContent,/no tiebreak this week/);
    assert.match(v.$('footerRule').textContent,/BUF–CIN tiebreak game voided by commissioner ruling: no tiebreak this week/);
    assert.deepEqual([v.$('leaderKicker').textContent,v.$('leaderName').textContent],['Group co-winners','D.C. / DJS']);
    assert.match(v.$('leaderNote').textContent,/no tiebreak/);
    assert.deepEqual(race(v).map(([name,status,note])=>[name,status,note]),[['D.C.','WINNER','Co-winner · no tiebreak (tiebreak game void)'],['DJS','WINNER','Co-winner · no tiebreak (tiebreak game void)']]);
    assert.deepEqual(standingCells(v).map(r=>r[r.length-1]),['41','44'],'no tiebreak difference is computed');
    assert.doesNotMatch(`${v.$('tbNote').textContent} ${v.$('mnf').textContent} ${v.$('leaderNote').textContent}`,/\b40\b/,'the DEN-KC total is never used as a fallback tiebreak');
    assert.doesNotMatch(v.html(),/unresolved tiebreak not projected|after the configured tiebreak|exact tiebreak tied/);
  });
  await regression('a later NFL final, live or scheduled game, or a new event id never reverses the void; the slot is UNDER REVIEW',async()=>{
    for(const [label,event,pattern] of [
      ['final',{...espnFinal({away:'BUF',home:'CIN',awayScore:'27',homeScore:'24'}),id:'401437947'},/completed final/],
      ['live',midGame(bufCin(espnStatus('STATUS_IN_PROGRESS','in','6:12 - 1st'))),/live/],
      ['scheduled',bufCin(espnStatus('STATUS_SCHEDULED','pre','Sun 8:15 PM')),/scheduled/],
      ['a new event id at first load',{...bufCin(),id:'401999999'},/different event/]
    ]){
      const v=await page({events:[espnFinal(),event]});
      assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']],`${label}: still void`);
      assert.deepEqual(pickCells(v),['ok','void','bad','void'],label);
      assert.match(card(v,'BUF'),/VOID/,label);assert.match(card(v,'BUF'),/UNDER REVIEW/,label);
      assert.equal(syncLabel(v),'UNDER REVIEW',label);
      assert.match(rules(v),pattern,label);
    }
    // After the first load, a changed event id still trips the HDC-09 guard (the new event is never adopted) and the void stays.
    const v=await page({events:[espnFinal(),bufCin()]});
    v.setPayload({events:[espnFinal(),{...espnFinal({away:'BUF',home:'CIN',awayScore:'27',homeScore:'24'}),id:'401999999'}]});await v.refresh();
    assert.match(v.warning(),/BUF-CIN: event identity changed/);
    assert.deepEqual(pickCells(v),['ok','void','bad','void']);
    assert.match(card(v,'BUF'),/UNDER REVIEW/);
  });
  await regression('withdrawn: after the void is withdrawn the page returns to the NFL fact and HDC-11 (never a FINAL TIE)',async()=>{
    const v=await page();
    assert.deepEqual(pickCells(v),['ok','void','bad','void'],'first the void applies');
    v.store.nfl_incident_rulings=voids(['void','withdrawn']);await v.refresh();
    assert.equal(v.warning(),'Some feed data was ignored to protect standings: BUF-CIN: game halted (STATUS_CANCELED), not graded; awaiting a pool ruling or official resolution');
    assert.equal(syncLabel(v),'INCOMPLETE');
    assert.deepEqual(pickCells(v),['ok','pending','bad','pending']);
    assert.equal(v.$('finals').textContent,'1/2');
    assert.doesNotMatch(v.$('gamegrid').innerHTML,/FINAL TIE|VOID/);
    assert.match(rules(v),/WITHDRAWN/);
  });
  await regression('all games void: complete, 100%, nothing remaining, no tiebreak, co-winners, no NaN, Infinity or 0/0',async()=>{
    const cfg=haltConfig(1);cfg.participants.push({id:'thaddeus',displayName:'Thaddeus',pickNumbers:[null,null],tiebreak:null});
    const v=await page({weekConfig:cfg,events:[canceledGame('DEN','KC','401437900'),bufCin()],rulings:[...voids(['void']),...voids(['void'],{away_team:'DEN',home_team:'KC',event_id:'401437900'},10)]});
    assert.equal(v.$('finals').textContent,'0/2 · 2 void');
    assert.equal(v.$('left').textContent,'0');
    assert.deepEqual([v.$('progressText').textContent,v.$('progressBar').style.width],['100%','100%']);
    assert.equal(v.$('mnf').textContent,'VOID');
    assert.deepEqual([v.$('leaderKicker').textContent,v.$('leaderName').textContent,v.$('leaderRecord').textContent],['Group co-winners','D.C. / DJS','0–0'],'the no-submission entry is never a co-winner');
    assert.deepEqual(race(v).map(([name,status])=>[name,status]),[['D.C.','WINNER'],['DJS','WINNER'],['Thaddeus','OUT']]);
    assert.equal(v.warning(),'');assert.equal(syncLabel(v),'LIVE');
    assert.doesNotMatch(v.html(),/NaN|Infinity|\b0\/0\b/);
  });
  await regression('an invalid ruling holds only its slot; the other game still grades',async()=>{
    const broken=voids(['void','void']);broken[1].parent_ruling_id=42;
    const v=await page({rulings:broken});
    assert.deepEqual(pickCells(v),['ok','hold','bad','hold']);
    assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']]);
    assert.match(card(v,'BUF'),/HOLD/);assert.doesNotMatch(card(v,'BUF'),/VOID/);
    assert.match(v.warning(),/BUF-CIN: ruling on hold/);assert.equal(syncLabel(v),'INCOMPLETE');
    const wrong=await page({rulings:voids(['void'],{away_team:'BUF',home_team:'KC'})});
    assert.deepEqual(pickCells(wrong),['hold','hold','hold','hold'],'a ruling that matches no published game holds every slot whose team it names');
  });
  await regression('a canceled-game void whose game the feed now reports as a forfeit holds',async()=>{
    const v=await page({events:[espnFinal(),bufCin(espnStatus('STATUS_FORFEIT','post','Forfeit'))]});
    assert.deepEqual(pickCells(v),['ok','hold','bad','hold']);assert.match(card(v,'BUF'),/HOLD/);
  });
  await regression('global: when the ruling data cannot be loaded at all, no game is graded from the NFL feed alone (ON HOLD)',async()=>{
    for(const [label,o] of [['rulings unavailable',{nfl_incident_rulings:503}],['tables absent',{nfl_contests:404,nfl_contest_policies:404,nfl_incident_rulings:404}],
      ['contest not provisioned',{nfl_contests:[]}],['policy history unusable',{nfl_contest_policies:[pkPolicyRow({halted_game_policy:'eliminate'})]}]]){
      const v=await page({store:pickemStore(o)});
      assert.equal(syncLabel(v),'ON HOLD',label);
      assert.deepEqual(records(v),[['D.C.','0','0'],['DJS','0','0']],`${label}: the DEN-KC final is not graded`);
      assert.deepEqual(pickCells(v),['hold','hold','hold','hold'],label);
      assert.equal(v.$('leaderKicker').textContent,'ON HOLD',label);
      assert.match(banner(v),/Ruling data unavailable/,label);
      assert.match(rules(v),/ON HOLD · Ruling data unavailable/,label);
    }
    // A request that never answers is abandoned at the refresh time limit and holds, rather than freezing the page.
    const realSetTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...a)=>realSetTimeout(fn,ms>=10000?5:ms,...a);
    try{
      const v=await page({store:pickemStore({nfl_incident_rulings:()=>new Promise(()=>{})})});
      await new Promise(r=>realSetTimeout(r,30));await v.refresh();
      assert.equal(syncLabel(v),'ON HOLD','a hung ruling request');
    }finally{globalThis.setTimeout=realSetTimeout}
  });
  await regression('a ruling refresh that fails after a verified load keeps the verified rulings (stale); a feed failure keeps last-good results',async()=>{
    const v=await page();
    v.store.nfl_incident_rulings=503;await v.refresh();
    assert.deepEqual(pickCells(v),['ok','void','bad','void']);assert.match(rules(v),/could not be refreshed/);
    v.store.nfl_incident_rulings=voids(['void']);v.setFailure(true);await v.refresh();
    assert.match(v.$('sync').textContent,/^FEED UNAVAILABLE/);
    assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']]);assert.deepEqual(pickCells(v),['ok','void','bad','void']);
  });
  await regression("Rules & rulings: contest type, void policy, revision, effective week, confirmation, rulings, history and notes; never private fields",async()=>{
    const rows=voids(['void','void']);rows[1].public_note='Reaffirmed after review.';
    const v=await page({rulings:rows}),html=rules(v);
    for(const text of ["Pick'em contest","Pool Center 2026 Pick'em",'Void','Policy revision 1','in force from Week 1','Approved policy for this contest.','Commissioner confirmation is required',
      'BUF @ CIN','APPLIED','Ruled VOID','Reaffirmed VOID','League canceled the game; voided for this contest.','Reaffirmed after review.'])
      assert(html.includes(esc(text)),`the card shows: ${text}`);
    const leaky=pickemStore({nfl_contest_policies:()=>({ok:true,status:200,json:async()=>[pkPolicyRow()]}),nfl_incident_rulings:()=>({ok:true,status:200,json:async()=>voids(['void'])})});
    const l=await page({store:leaky});
    assert.doesNotMatch(`${html}\n${l.html()}`,/PRIVATE ADMIN NOTE|auth-user-7f3a/);
  });

  // Review-driven regressions (added after the implementation's adversarial review).
  await regression('a ruling that matches no published game is HOLD on the Rules & rulings card, never APPLIED, and changes no slot',async()=>{
    const v=await page({rulings:voids(['void'],{away_team:'NYJ',home_team:'NE',event_id:'401437990'})});
    assert.deepEqual(pickCells(v),['ok','pending','bad','pending'],'BUF-CIN still awaits a ruling (HDC-11)');
    const html=rules(v);
    assert(html.includes('NYJ @ NE'),'the card lists the ruling');
    assert.match(html,/rules-status">HOLD</);assert.match(html,/does not match a published game/);
    assert.doesNotMatch(html,/APPLIED|Applied by commissioner ruling/);
  });
  await regression('a withdrawn mis-keyed ruling releases the published slots it named; the correct ruling then applies',async()=>{
    const misKeyed=voids(['void','withdrawn'],{away_team:'BUF',home_team:'KC'});
    const v=await page({rulings:misKeyed,events:[espnFinal(),{...espnFinal({away:'BUF',home:'CIN',awayScore:'27',homeScore:'24'}),id:'401437947'}]});
    assert.deepEqual(pickCells(v),['ok','ok','bad','bad'],'both games grade from the NFL fact');
    assert.deepEqual(records(v),[['D.C.','2','0'],['DJS','0','2']]);
    assert.equal(syncLabel(v),'LIVE');
    assert.match(rules(v),/rules-status">WITHDRAWN</);assert.doesNotMatch(rules(v),/rules-status">HOLD</);
    const fixed=await page({rulings:[...misKeyed,...voids(['void'],{},10)]});
    assert.deepEqual(pickCells(fixed),['ok','void','bad','void']);
  });
  await regression('the Rules & rulings card shows a withdrawn ruling as WITHDRAWN even when another ruling holds its game',async()=>{
    const v=await page({rulings:[...voids(['void','withdrawn']),...voids(['void'],{away_team:'BUF',home_team:'KC',event_id:'401437990'},10)]});
    assert.deepEqual(pickCells(v),['hold','hold','hold','hold'],'the active mis-keyed ruling holds both published games');
    assert.match(rules(v),/BUF @ CIN<\/b><span class="rules-status">WITHDRAWN</);
    assert.match(rules(v),/BUF @ KC<\/b><span class="rules-status">HOLD</);
  });

  // ---- HDC-12 review remediation (the independent review of 4333347).
  // MAJOR-2: the recorded canceled event (401437947) still in the feed, plus BUF at CIN under another event id (401437999).
  const relistedFinal={...espnFinal({away:'BUF',home:'CIN',awayScore:'27',homeScore:'24'}),id:'401437999'};
  await regression("MAJOR-2: the recorded canceled event plus the same pair under another event id keeps the VOID, is UNDER REVIEW everywhere, and keeps the HDC-09 duplicate warning",async()=>{
    for(const [label,second] of [['a final',relistedFinal],['a live game',{...midGame(bufCin(espnStatus('STATUS_IN_PROGRESS','in','6:12 - 1st'))),id:'401437999'}],
      ['a scheduled game',{...bufCin(espnStatus('STATUS_SCHEDULED','pre','Sun 8:15 PM')),id:'401437999'}],['another halted state',{...bufCin(espnStatus('STATUS_POSTPONED','post','Postponed')),id:'401437999'}]]){
      const v=await page({events:[espnFinal(),bufCin(),second]});
      assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']],`${label}: still void, no win and no loss`);
      assert.deepEqual(pickCells(v),['ok','void','bad','void'],`${label}: void pick cells`);
      assert.equal(v.$('left').textContent,'0',`${label}: not remaining`);
      assert.match(card(v,'BUF'),/VOID · Commissioner ruling · UNDER REVIEW/,`${label}: the game card is VOID and UNDER REVIEW`);
      assert.match(rules(v),/BUF @ CIN<\/b><span class="rules-status">UNDER REVIEW</,`${label}: Rules & rulings says UNDER REVIEW`);
      assert.match(banner(v),/UNDER REVIEW · BUF-CIN: VOID by commissioner ruling stays applied; the feed also lists BUF @ CIN under another event \(feed event 401437999\)/,`${label}: the participant notice names the conflict`);
      assert.equal(v.warning(),'Some feed data was ignored to protect standings: BUF-CIN: duplicate events ignored',`${label}: the HDC-09 duplicate warning stays`);
      assert.equal(syncLabel(v),'INCOMPLETE',`${label}: the feed-integrity warning keeps precedence`);
    }
    // As the tiebreak game: still no tiebreak, and tied leaders stay co-winners.
    const t=await page({tiebreakGameIndex:1,events:[espnFinal({awayScore:'20',homeScore:'20'}),bufCin(),relistedFinal]});
    assert.equal(t.$('mnf').textContent,'VOID');assert.match(t.$('tbNote').textContent,/no tiebreak this week/);
    assert.deepEqual([t.$('leaderKicker').textContent,t.$('leaderName').textContent],['Group co-winners','D.C. / DJS']);
    assert.match(card(t,'BUF'),/VOID · Commissioner ruling · UNDER REVIEW/,'tiebreak game: VOID and UNDER REVIEW');
  });
  // Preserved (accepted by the review): one other event id in place of the recorded one after the first load.
  await regression('preserved: after the first load, the recorded event replaced by one other event id keeps the HDC-09 identity warning (INCOMPLETE), the VOID and the UNDER REVIEW notice; the new event is never adopted',async()=>{
    const v=await page();
    v.setPayload({events:[espnFinal(),relistedFinal]});await v.refresh();
    assert.equal(v.warning(),'Some feed data was ignored to protect standings: BUF-CIN: event identity changed','the HDC-09 identity warning stays');
    assert.equal(syncLabel(v),'INCOMPLETE','the feed-integrity warning keeps precedence');
    assert.deepEqual(pickCells(v),['ok','void','bad','void']);assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']],'the new event never grades the game');
    assert.match(card(v,'BUF'),/VOID · Commissioner ruling · UNDER REVIEW/);
    assert.match(banner(v),/UNDER REVIEW · BUF-CIN: VOID by commissioner ruling stays applied; the feed now reports a completed final \(feed event 401437999; the ruling recorded event 401437947\)/);
    assert.match(rules(v),/BUF @ CIN<\/b><span class="rules-status">UNDER REVIEW</);
  });
  // MAJOR-3: rulings kept after a failed refresh are stale, and the always-visible header says so (scores stay separate).
  await regression('MAJOR-3: rulings kept after a failed refresh still apply, and the header and a notice say RULINGS STALE (never a clean LIVE) until a refresh succeeds',async()=>{
    const v=await page();
    assert.match(v.$('sync').textContent,/^LIVE · data \d+s old$/,'verified: a clean LIVE');assert.equal(v.$('dot').style.background,'var(--green)');
    v.store.nfl_incident_rulings=503;await v.refresh();
    assert.deepEqual(pickCells(v),['ok','void','bad','void'],'the last verified void still applies');
    assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']]);
    assert.match(v.$('sync').textContent,/^LIVE · RULINGS STALE · data \d+s old$/,'the header says the rulings, not the scores, are stale');
    assert.equal(v.$('dot').style.background,'var(--gold)','never the clean LIVE dot');
    assert.match(banner(v),/RULINGS STALE · /,'a persistent notice says so');assert.doesNotMatch(banner(v),/ON HOLD/,'not a global hold');
    assert.match(rules(v),/could not be refreshed/,'the Rules & rulings card keeps its stale note');
    // The score feed failing as well: the header and the notice still say the rulings are stale.
    v.setFailure(true);await v.refresh();
    assert.match(v.$('sync').textContent,/^FEED UNAVAILABLE · RULINGS STALE · last good \d+s ago$/);assert.match(banner(v),/RULINGS STALE · /);
    assert.deepEqual(pickCells(v),['ok','void','bad','void']);
    // A refresh that loads the rulings again clears it.
    v.setFailure(false);v.store.nfl_incident_rulings=voids(['void']);await v.refresh();
    assert.match(v.$('sync').textContent,/^LIVE · data \d+s old$/);assert.equal(v.$('dot').style.background,'var(--green)');
    assert.doesNotMatch(banner(v),/RULINGS STALE/);assert.doesNotMatch(rules(v),/could not be refreshed/);
  });

  // ---- HDC-12 second review remediation (the independent review of 84108339). Copies of one feed event are one logical
  // event: a repeated recorded event can neither hide the ruled pair under another event id (UNDER REVIEW) nor hide a forfeit
  // (HOLD), and copies of one event id that disagree are never decided by the copy that comes first. Every feed order counts.
  const orders=list=>list.length<2?[list]:list.flatMap((x,i)=>orders([...list.slice(0,i),...list.slice(i+1)]).map(rest=>[x,...rest]));
  const named=events=>events.map(e=>e.id==='401437999'?'B':'A').join('+');
  const forfeitB={...bufCin(espnStatus('STATUS_FORFEIT','post','Forfeit')),id:'401437999'};
  const DUPLICATE='Some feed data was ignored to protect standings: BUF-CIN: duplicate events ignored';
  const voidUnderReview=(v,label,notice)=>{
    assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']],`${label}: still void: no win and no loss; no other listing grades the game`);
    assert.deepEqual(pickCells(v),['ok','void','bad','void'],`${label}: void pick cells`);
    assert.deepEqual([v.$('left').textContent,v.$('finals').textContent],['0','1/2 · 1 void'],`${label}: not remaining, never an NFL final`);
    assert.match(card(v,'BUF'),/VOID · Commissioner ruling · UNDER REVIEW/,`${label}: the game card is VOID and UNDER REVIEW`);
    assert.doesNotMatch(card(v,'BUF'),/FINAL TIE|final tie/,`${label}: never an NFL tie`);
    assert.match(rules(v),/BUF @ CIN<\/b><span class="rules-status">UNDER REVIEW</,`${label}: Rules & rulings says UNDER REVIEW`);
    assert.match(banner(v),notice,`${label}: the participant notice names the conflict`);
  };
  const heldGame=(v,label)=>{
    assert.deepEqual(pickCells(v),['ok','hold','bad','hold'],`${label}: HOLD, never VOID`);
    assert.deepEqual([records(v),v.$('finals').textContent],[[['D.C.','1','0'],['DJS','0','1']],'1/2'],`${label}: the held game is never graded or voided`);
    assert.match(card(v,'BUF'),/HOLD · Ruling information unusable/,`${label}: the game card says HOLD`);assert.doesNotMatch(card(v,'BUF'),/VOID/,`${label}: never VOID`);
    assert.match(v.warning(),/BUF-CIN: ruling on hold \(the feed now reports STATUS_FORFEIT; a forfeit is not covered by v1 rulings\), not graded/,`${label}: the warning names the forfeit hold`);
    assert.match(rules(v),/BUF @ CIN<\/b><span class="rules-status">HOLD</,`${label}: Rules & rulings says HOLD`);
    assert.equal(syncLabel(v),'INCOMPLETE',label);
  };
  await regression('second review: the recorded event listed twice plus the same pair under another event id (A+A+B) keeps the VOID and is UNDER REVIEW everywhere in every feed order, with the HDC-09 duplicate warning; A+A alone is no conflict',async()=>{
    const notice=/UNDER REVIEW · BUF-CIN: VOID by commissioner ruling stays applied; the feed also lists BUF @ CIN under another event \(feed event 401437999\)/;
    for(const events of orders([bufCin(),bufCin(),relistedFinal])){
      const v=await page({events:[espnFinal(),...events]}),label=`${named(events)} (B final)`;
      voidUnderReview(v,label,notice);
      assert.equal(v.warning(),DUPLICATE,`${label}: the HDC-09 duplicate warning stays`);
      assert.equal(syncLabel(v),'INCOMPLETE',`${label}: the feed-integrity warning keeps precedence`);
    }
    for(const [label,second] of [['a live game',{...midGame(bufCin(espnStatus('STATUS_IN_PROGRESS','in','6:12 - 1st'))),id:'401437999'}],
      ['a scheduled game',{...bufCin(espnStatus('STATUS_SCHEDULED','pre','Sun 8:15 PM')),id:'401437999'}],['another halted state',{...bufCin(espnStatus('STATUS_POSTPONED','post','Postponed')),id:'401437999'}]])
      voidUnderReview(await page({events:[espnFinal(),bufCin(),bufCin(),second]}),`A+A+B (B ${label})`,notice);
    // As the tiebreak game: still no tiebreak, and tied leaders stay co-winners.
    const t=await page({tiebreakGameIndex:1,events:[espnFinal({awayScore:'20',homeScore:'20'}),bufCin(),bufCin(),relistedFinal]});
    assert.equal(t.$('mnf').textContent,'VOID');assert.match(t.$('tbNote').textContent,/no tiebreak this week/);
    assert.deepEqual([t.$('leaderKicker').textContent,t.$('leaderName').textContent],['Group co-winners','D.C. / DJS']);
    assert.match(card(t,'BUF'),/VOID · Commissioner ruling · UNDER REVIEW/,'tiebreak game: VOID and UNDER REVIEW');
    // Control: the recorded event listed twice and nothing else is no conflict; only the HDC-09 duplicate warning remains.
    const twice=await page({events:[espnFinal(),bufCin(),bufCin()]});
    assert.deepEqual(pickCells(twice),['ok','void','bad','void'],'A+A: the VOID applies');
    assert.match(card(twice,'BUF'),/VOID · Commissioner ruling/);assert.doesNotMatch(`${card(twice,'BUF')}\n${banner(twice)}\n${rules(twice)}`,/UNDER REVIEW/,'A+A: never UNDER REVIEW');
    assert.match(rules(twice),/BUF @ CIN<\/b><span class="rules-status">APPLIED</,'A+A: Rules & rulings says APPLIED');
    assert.equal(twice.warning(),DUPLICATE,'A+A: the HDC-09 duplicate warning stays');
  });
  await regression('second review: a forfeit of the ruled pair beside the repeated recorded event (A+A+forfeit B) holds the game in every feed order, never VOID; as the tiebreak game it is no voided tiebreak',async()=>{
    for(const events of orders([bufCin(),bufCin(),forfeitB])){
      const v=await page({events:[espnFinal(),...events]}),label=`${named(events)} (B forfeit)`;
      heldGame(v,label);
      assert.match(v.warning(),/BUF-CIN: duplicate events ignored/,`${label}: the HDC-09 duplicate warning stays`);
    }
    const t=await page({tiebreakGameIndex:1,events:[espnFinal({awayScore:'20',homeScore:'20'}),bufCin(),bufCin(),forfeitB]});
    assert.deepEqual(pickCells(t),['bad','hold','bad','hold'],'the separate NFL tie is a loss on both sides; tiebreak game: HOLD, never VOID');
    assert.notEqual(t.$('mnf').textContent,'VOID','tiebreak game: no voided tiebreak');
    assert.doesNotMatch(`${t.$('tbNote').textContent} ${t.$('footerRule').textContent} ${t.$('leaderNote').textContent}`,/no tiebreak this week|tiebreak game voided|tiebreak game void/,'tiebreak game: never resolved as a voided tiebreak');
  });
  await regression('second review: the recorded event gone and the same pair listed twice under one other event id (B+B) is the accepted event-id change: the VOID stays, UNDER REVIEW, B never adopted; B+B forfeit holds',async()=>{
    const v=await page({events:[espnFinal(),relistedFinal,relistedFinal]});
    voidUnderReview(v,'B+B final',/UNDER REVIEW · BUF-CIN: VOID by commissioner ruling stays applied; the feed now reports a completed final \(feed event 401437999; the ruling recorded event 401437947\)/);
    assert.equal(v.warning(),DUPLICATE,'B+B final: the HDC-09 duplicate warning stays');
    heldGame(await page({events:[espnFinal(),forfeitB,forfeitB]}),'B+B forfeit');
  });
  await regression('second review: copies of the recorded event that disagree are never decided by the first copy: a final and a forfeit hold the game, a final and a live game keep the VOID UNDER REVIEW, in either order',async()=>{
    const final={...espnFinal({away:'BUF',home:'CIN',awayScore:'27',homeScore:'24'}),id:'401437947'},forfeit=bufCin(espnStatus('STATUS_FORFEIT','post','Forfeit'));
    const live=midGame(bufCin(espnStatus('STATUS_IN_PROGRESS','in','6:12 - 1st')));
    for(const events of orders([final,forfeit]))heldGame(await page({events:[espnFinal(),...events]}),`same id: ${events[0]===final?'final, forfeit':'forfeit, final'}`);
    for(const events of orders([final,live]))voidUnderReview(await page({events:[espnFinal(),...events]}),`same id: ${events[0]===final?'final, live':'live, final'}`,
      /UNDER REVIEW · BUF-CIN: VOID by commissioner ruling stays applied; the feed lists event 401437947 more than once with conflicting information/);
  });

  assert.equal(failures.length,0,`HDC-12 Pick'em regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}


// HDC-14. Absent-game adjudication in Pick'em: the 2020 Week 4 PIT at TEN shape in Week 12. The published game PIT @ TEN
// (event 401438121) is no longer listed in the Week 12 feed; the matchup later appears as a distinct Week 13 event. Without
// a ruling the week stays INCOMPLETE, as before. A ruling whose evidence is an attested absence (STATUS_ABSENT,
// commissioner-attestation) applies while the Week 12 feed still omits the game: VOID, no win, no loss, not remaining, the
// week completes. If the game is listed again in Week 12 the VOID stays and is UNDER REVIEW; no other week is ever read.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const absentConfig=(tiebreakGameIndex=0)=>({schemaVersion:1,season:2026,week:12,tiebreakGameIndex,
    games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-11-29',eventId:'401438140'},{away:'PIT',home:'TEN',awayNumber:3,homeNumber:4,date:'2026-11-29',eventId:'401438121'}],
    participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1,3],tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2,4],tiebreak:44}]});
  const absentRows=(consequences,o={},firstId=1)=>consequences.map((consequence,i)=>({ruling_id:firstId+i,contest_id:PK_CONTEST,contest_type:'pickem',week:12,away_team:'PIT',home_team:'TEN',
    policy_revision:1,chain_seq:i+1,parent_ruling_id:i?firstId+i-1:null,consequence,incident_status:'STATUS_ABSENT',event_id:'401438121',evidence_source:'commissioner-attestation',
    public_note:i?null:'PIT @ TEN left the Week 12 feed; void for this contest.',created_at:'2026-11-30T12:00:00+00:00',...PRIVATE,...o}));
  const denKc=(awayScore='24',homeScore='17')=>game({week:12,away:'DEN',home:'KC',id:'401438140',awayScore,homeScore});
  const pitTen=(o={})=>({...game({week:12,away:'PIT',home:'TEN',id:'401438121',awayScore:'24',homeScore:'27'}),...o});
  const page=async({tiebreakGameIndex=0,events=[denKc()],rulings=absentRows(['void'])}={})=>
    view({weekConfig:absentConfig(tiebreakGameIndex),initialScorePayload:{events},store:pickemStore({nfl_incident_rulings:rulings})});
  const banner=v=>v.$('error').children.map(c=>c.textContent).join('\n');
  const pitCard=v=>v.$('gamegrid').innerHTML.split('<div class="game').slice(1).find(g=>g.includes('<span class="abbr">PIT</span>'))||'';
  const rules=v=>v.$('pickemRules').innerHTML;
  const EVIDENCE='Recorded incident: ABSENT FROM WEEK 12 FEED · commissioner attestation · original event 401438121';

  await regression('HDC-14: the page imports the evaluator at its HDC-14 version (contest-rulings.js?v=2)',()=>{
    assert.equal(rulingsFrom,"from './contest-rulings.js?v=2';",'weekly-app.js must import contest-rulings.js?v=2');
  });
  await regression('HDC-14 preservation: without a ruling the absent published game stays INCOMPLETE, ungraded and remaining',async()=>{
    const v=await page({rulings:[]});
    assert.equal(v.warning(),'Some feed data was ignored to protect standings: PIT-TEN: expected game missing from feed');
    assert.equal(syncLabel(v),'INCOMPLETE');assert.equal(v.$('finals').textContent,'1/2');assert.equal(v.$('left').textContent,'1');
    assert.deepEqual(pickCells(v),['ok','pending','bad','pending'],'never VOID without a ruling');
    assert.doesNotMatch(pitCard(v),/VOID/);
  });
  await regression('HDC-14 an active absence VOID is APPLIED: no win, no loss, not remaining, the week completes, LIVE with no warning',async()=>{
    const v=await page();
    assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']],'only DEN-KC scores');
    assert.deepEqual(pickCells(v),['ok','void','bad','void']);
    assert.equal(v.$('finals').textContent,'1/2 · 1 void');assert.equal(v.$('left').textContent,'0');assert.equal(v.$('progressText').textContent,'100%');
    assert.equal(v.warning(),'','the absent game the ruling covers is no longer a missing-game warning');
    assert.equal(syncLabel(v),'LIVE');
    assert.deepEqual([v.$('leaderKicker').textContent,v.$('leaderName').textContent],['Group winner','D.C.']);
    assert.match(pitCard(v),/VOID · Commissioner ruling/);assert.doesNotMatch(pitCard(v),/UNDER REVIEW|FINAL|HOLD/);
    assert.equal(v.$('tbNote').textContent,'Tiebreak final total: 41. Tiebreak differences are active.','the DEN-KC tiebreak is unaffected');
    assert.match(rules(v),/<span class="rules-status">APPLIED<\/span>/);
    assert(rules(v).includes(`<small>${EVIDENCE}</small>`),'the Rules card names the attested absence and the original event');
    assert.doesNotMatch(rules(v),/nflscores2|STATUS_POSTPONED|STATUS_CANCELED|PRIVATE ADMIN NOTE|auth-user-7f3a/,'never a feed fact, never a private field');
  });
  await regression('HDC-14 tiebreak: the absent game as the tiebreak game voids the week tiebreak; co-winners when the scored record ties',async()=>{
    const v=await page({tiebreakGameIndex:1,events:[denKc('20','20')]});
    assert.equal(v.$('mnf').textContent,'VOID');
    assert.match(v.$('tbNote').textContent,/no tiebreak this week/);assert.match(v.$('footerRule').textContent,/PIT–TEN tiebreak game voided by commissioner ruling: no tiebreak this week/);
    assert.deepEqual([v.$('leaderKicker').textContent,v.$('leaderName').textContent],['Group co-winners','D.C. / DJS']);
    const decided=await page({tiebreakGameIndex:1});
    assert.deepEqual([decided.$('mnf').textContent,decided.$('leaderKicker').textContent,decided.$('leaderName').textContent],['VOID','Group winner','D.C.'],'the record decides; no other game becomes the tiebreak');
  });
  await regression('HDC-14 feed recovery: the game listed again in Week 12 keeps the VOID applied and UNDER REVIEW; the NFL final never scores while the ruling is active',async()=>{
    for(const [label,listing] of [['a completed final',pitTen()],['scheduled',{...pitTen(),status:{type:{state:'pre',completed:false,name:'STATUS_SCHEDULED',shortDetail:'Sun 1:00 PM'}}}]]){
      const v=await page({events:[denKc(),listing]});
      assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']],`${label}: TEN is never credited`);
      assert.deepEqual(pickCells(v),['ok','void','bad','void'],`${label}: VOID stays`);
      assert.match(pitCard(v),/VOID · Commissioner ruling · UNDER REVIEW/,label);
      assert.match(banner(v),/UNDER REVIEW · PIT-TEN: VOID by commissioner ruling stays applied; the game is listed in this week's feed again/,label);
      assert.equal(syncLabel(v),'UNDER REVIEW',label);
      assert.match(rules(v),/<span class="rules-status">UNDER REVIEW<\/span>/,label);
    }
  });
  await regression('HDC-14 the Week 13 makeup has zero effect: the page reads only its own week, and a Week 13 listing in the payload leaves the absence APPLIED',async()=>{
    const v=await page();
    const native=globalThis.fetch,weeks=[];
    globalThis.fetch=async(url,init)=>{const u=new URL(url);if(u.searchParams.has('week')&&u.searchParams.has('dates'))weeks.push(u.searchParams.get('week'));return native(url,init)};
    try{await v.refresh()}finally{globalThis.fetch=native}
    assert.deepEqual([...new Set(weeks)],['12'],'only the Week 12 score feed is requested');
    const makeup=await page({events:[denKc(),{...pitTen(),id:'401438199',week:{number:13}}]});
    assert.deepEqual(pickCells(makeup),['ok','void','bad','void'],'still VOID');
    assert.doesNotMatch(banner(makeup),/UNDER REVIEW/,'never under review because of another week');
    assert.match(rules(makeup),/<span class="rules-status">APPLIED<\/span>/);
  });
  await regression('HDC-14 a withdrawn absence ruling restores the unruled week: INCOMPLETE, the game pending again',async()=>{
    const v=await page({rulings:absentRows(['void','withdrawn'])});
    assert.equal(v.warning(),'Some feed data was ignored to protect standings: PIT-TEN: expected game missing from feed');
    assert.deepEqual(pickCells(v),['ok','pending','bad','pending']);assert.equal(syncLabel(v),'INCOMPLETE');
    assert.match(rules(v),/<span class="rules-status">WITHDRAWN<\/span>/);
  });
  await regression('HDC-14 unusable absence evidence HOLDs the game (never VOID): a feed status claimed as an attestation, or a chain mixing evidence classes',async()=>{
    for(const [label,rows] of [['STATUS_POSTPONED attested',absentRows(['void'],{incident_status:'STATUS_POSTPONED'})],
      ['STATUS_ABSENT from nflscores2',absentRows(['void'],{evidence_source:'nflscores2'})],
      ['absence root, feed re-ruling',absentRows(['void','withdrawn','void']).map((r,i)=>i===2?{...r,incident_status:'STATUS_POSTPONED',evidence_source:'nflscores2'}:r)]]){
      const v=await page({rulings:rows});
      assert.deepEqual(pickCells(v),['ok','hold','bad','hold'],label);
      assert.match(v.warning(),/PIT-TEN: ruling on hold/,label);
    }
  });
  await regression('HDC-14 only an applied absence ruling silences the missing-game warning: never a feed-evidence VOID (even one the feed gives no usable evidence about), never an absence under review',async()=>{
    const unreadable={...pitTen(),competitions:[{competitors:[{homeAway:'away',team:{abbreviation:'PIT'}}]}]};
    const feed=await page({events:[denKc(),unreadable],rulings:absentRows(['void'],{incident_status:'STATUS_POSTPONED',evidence_source:'nflscores2'})});
    assert.deepEqual(pickCells(feed),['ok','void','bad','void'],'the feed-evidence VOID stays applied');
    assert.doesNotMatch(banner(feed),/UNDER REVIEW/,'an unreadable listing is no evidence against a feed-evidence ruling');
    assert.equal(feed.warning(),'Some feed data was ignored to protect standings: PIT-TEN: expected game missing from feed','the missing-game warning stays');
    assert.equal(syncLabel(feed),'INCOMPLETE');
    const absence=await page({events:[denKc(),unreadable]});
    assert.deepEqual(pickCells(absence),['ok','void','bad','void']);
    assert.match(banner(absence),/UNDER REVIEW · PIT-TEN: VOID by commissioner ruling stays applied; this week's feed lists an unreadable game naming PIT or TEN/);
    assert.equal(absence.warning(),'Some feed data was ignored to protect standings: PIT-TEN: expected game missing from feed','an absence under review never silences it');
  });
  await regression('HDC-14 preservation: a feed-evidence VOID whose game left the feed is still UNDER REVIEW with the missing-game warning (HDC-12 unchanged)',async()=>{
    const v=await page({rulings:absentRows(['void'],{incident_status:'STATUS_POSTPONED',evidence_source:'nflscores2'})});
    assert.deepEqual(pickCells(v),['ok','void','bad','void']);
    assert.match(banner(v),/UNDER REVIEW · PIT-TEN: VOID by commissioner ruling stays applied; the game is no longer in this week's feed/);
    assert.equal(v.warning(),'Some feed data was ignored to protect standings: PIT-TEN: expected game missing from feed');
    assert.equal(syncLabel(v),'INCOMPLETE');
  });

  assert.equal(failures.length,0,`HDC-14 Pick'em absent-game regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log("weekly HDC-12 contest-ruling load and HDC-14 absent-game, privacy, void, voided tiebreak, under-review, withdrawn, all-void, hold, fail-closed and Rules & rulings regressions passed");


// HDC-15. The public refresh lifecycle in Pick'em. Every full refresh first reads a lightweight publication index (season,
// week, revision, published_at, status: never a config) and downloads a full published row only for the first selection, a
// changed revision of the selected week, or a week the participant chooses. A newer revision is loaded and validated before it
// replaces the active config and never mixes with it; one that cannot be loaded or validated leaves the last verified revision
// on screen, marked PUBLISHED DATA STALE (never a plain LIVE), and is retried on the next refresh. A newly published week
// enters the selector without moving the participant. Timer refreshes run only while the document is visible and a Pick'em
// view is active; becoming visible, coming back from Survivor and REFRESH each run exactly one full refresh, and a late
// response for an older revision or week never overwrites a newer one. Each regression reports through one collector; the
// block fails at its end if any did.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const PUBLISHED_AT='2026-09-27T16:43:08.115+00:00';
  // Week 3: DEN at KC (DEN won 24-17) and BUF at CIN (BUF won 27-24, the tiebreak game). D.C. picked DEN and BUF, DJS KC and
  // CIN. Revision 4 republishes D.C.'s ballot as KC and BUF, revision 5 as KC and CIN. Weeks 4 and 5 have one game each.
  const wk3=(dc=[1,3])=>({schemaVersion:1,season:2026,week:3,tiebreakGameIndex:1,
    games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-27'},{away:'BUF',home:'CIN',awayNumber:3,homeNumber:4,date:'2026-09-28'}],
    participants:[{id:'dc',displayName:'D.C.',pickNumbers:dc,tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2,4],tiebreak:44}]});
  const oneGame=(week,away,home,date)=>({schemaVersion:1,season:2026,week,tiebreakGameIndex:0,games:[{away,home,awayNumber:1,homeNumber:2,date}],
    participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1],tiebreak:40},{id:'djs',displayName:'DJS',pickNumbers:[2],tiebreak:38}]});
  const wk4=()=>oneGame(4,'MIA','BUF','2026-10-04'),wk5=()=>oneGame(5,'NYJ','NE','2026-10-11');
  const pubRow=(cfg,revision,o={})=>({season:cfg.season,week:cfg.week,status:'locked',revision,published_at:PUBLISHED_AT,locked_at:PUBLISHED_AT,config:structuredClone(cfg),...o});
  const wk3Final=()=>({events:[game(),{...game({away:'BUF',home:'CIN',awayScore:'27',homeScore:'24'}),id:'401437947'}]});
  // Each week's score feed answers for its own week: BUF beat MIA in Week 4, NYJ beat NE in Week 5.
  const FEEDS={3:wk3Final(),4:{events:[game({week:4,away:'MIA',home:'BUF',awayScore:'10',homeScore:'20'})]},5:{events:[game({week:5,away:'NYJ',home:'NE',awayScore:'24',homeScore:'13'})]}};
  const json=data=>({ok:true,status:200,json:async()=>structuredClone(data)}),httpError=status=>({ok:false,status,json:async()=>({})});
  const byWeek=u=>FEEDS[u.searchParams.get('week')]?json(FEEDS[u.searchParams.get('week')]):undefined;
  const open=async({published=[pubRow(wk3(),3)],search='?view=home&season=2026&week=3',tokenTtl=3600,store=pickemStore()}={})=>{
    const v=await view({published,search,tokenTtl,store,initialScorePayload:wk3Final()});v.hooks.score=byWeek;return v;
  };
  const tally=(v,from=0)=>{const t={token:0,index:0,row:0,rulings:0,score:0};for(const c of v.calls.slice(from))t[c.kind]++;return t};
  const kinds=(v,from)=>v.calls.slice(from).map(c=>c.kind);
  const rowWeeks=(v,from)=>v.calls.slice(from).filter(c=>c.kind==='row').map(c=>[c.url.searchParams.get('season'),c.url.searchParams.get('week')]);
  const weekLine=v=>v.$('weekLine').textContent;
  const options=v=>[...v.$('weekSelect').innerHTML.matchAll(/<option value="([^"]+)"/g)].map(m=>m[1]);
  const banner=v=>v.$('error').children.map(c=>c.textContent).join('\n');
  const PAGE=[...HALT_PAGE,'pickemRules','weekLine','pulseWeek','entryCount','gameCount'];
  const panels=v=>Object.fromEntries(PAGE.map(id=>[id,`${v.$(id).innerHTML}|${v.$(id).textContent}`]));
  const graded=v=>({records:records(v),cells:pickCells(v),games:v.$('gamegrid').innerHTML});
  const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
  const choose=async(v,value)=>{const select=v.$('weekSelect');select.value=value;for(const fn of select.listeners.change||[])fn();await flush()};
  const FULL={token:0,index:1,row:0,rulings:3,score:1};
  // Published data that could not be verified: kept on screen, and said so everywhere a participant looks.
  const stale=(v,label)=>{
    assert.match(v.$('sync').textContent,/PUBLISHED DATA STALE/,`${label}: the header says the published data is stale`);
    assert.doesNotMatch(v.$('sync').textContent,/^LIVE\b/,`${label}: never LIVE`);
    assert.notEqual(v.$('dot').style.background,'var(--green)',`${label}: never the clean LIVE dot`);
    assert.match(weekLine(v),/^(WEEK \d+ UNAVAILABLE · )?PUBLISHED DATA STALE · revision \d+ · /,`${label}: the week strip leads with it (a phone's ellipsis never cuts it), then the revision on screen`);
    assert.match(banner(v),/^PUBLISHED DATA STALE · /m,`${label}: a notice explains it`);
  };
  const current=(v,label)=>{
    assert.match(v.$('sync').textContent,/^LIVE · data \d+s old$/,`${label}: a clean LIVE`);
    assert.equal(v.$('dot').style.background,'var(--green)',label);
    assert.doesNotMatch(`${weekLine(v)}\n${banner(v)}`,/PUBLISHED DATA STALE/,`${label}: nothing is marked stale`);
  };

  await regression("boot reads the publication index (identity columns only, never a config) and then exactly one full row, the selected week's; the week strip shows that row's revision",async()=>{
    const v=await open({published:[pubRow(wk3(),3),pubRow(wk4(),2)]});
    assert.deepEqual(tally(v),{token:1,index:1,row:1,rulings:3,score:1},'boot: one index, one row, the rules and rulings, the score feed');
    const index=v.calls.find(c=>c.kind==='index'),full=v.calls.find(c=>c.kind==='row'),columns=index.url.searchParams.get('select').split(',');
    for(const c of ['season','week','revision','published_at','status'])assert(columns.includes(c),`the index reads ${c}`);
    assert(columns.every(c=>['season','week','revision','published_at','status','locked_at'].includes(c)),`the index reads identity columns only: ${columns}`);
    assert.equal(index.url.searchParams.get('status'),'eq.locked','the index lists locked rows');
    assert.deepEqual(rowWeeks(v,0),[['eq.2026','eq.3']],'the full row is the selected week only');
    assert(full.url.searchParams.get('select').split(',').includes('config'));
    for(const c of [index,full])assert.equal(c.authorization,`Bearer ${v.token}`,'published rows are read with the anonymous token');
    assert.deepEqual(options(v),['2026-3','2026-4']);assert.equal(v.$('weekSelect').value,'2026-3');
    assert.match(weekLine(v),/^Week 3 · revision 3 · /);
    assert.deepEqual(records(v),[['D.C.','2','0'],['DJS','0','2']]);
    current(v,'boot');
  });
  await regression('an unchanged revision: each visible timer refresh reads the index once, the three HDC-12 tables and the score feed, never a full row, and changes nothing on the page',async()=>{
    const v=await open(),before=panels(v);
    for(let i=1;i<=3;i++){const from=v.calls.length;await v.refresh();assert.deepEqual(tally(v,from),FULL,`tick ${i}`)}
    assert.deepEqual(panels(v),before,'scores, tiebreak, standings, picks, race and rules are exactly as before');
    current(v,'unchanged');
  });
  await regression('hidden: timer ticks make no request at all, not even to renew an expired anonymous token',async()=>{
    // The token is always inside its renewal minute, so any refresh would first ask for a new one.
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
  await regression('Survivor active: visible Pick’em timer ticks make no request',async()=>{
    const v=await open();v.doc.visibilityState='visible';
    v.click('survivor');await flush();
    const from=v.calls.length;v.tick();v.tick();await flush();
    assert.deepEqual(kinds(v,from),[]);
  });
  await regression('becoming visible runs exactly one full refresh at once; with Survivor active it runs none',async()=>{
    const v=await open();
    let from=v.calls.length;await v.resume();
    assert.deepEqual(tally(v,from),FULL,'one index, the HDC-12 tables and the score feed');
    v.click('survivor');await flush();
    from=v.calls.length;await v.resume();
    assert.deepEqual(kinds(v,from),[],'Survivor active: not Pick’em’s to refresh');
  });
  await regression('becoming visible and timer ticks at the same moment still run one full refresh',async()=>{
    const v=await open();v.setVisibility('hidden');
    const from=v.calls.length;v.setVisibility('visible');v.tick();v.tick();await flush();
    assert.deepEqual(tally(v,from),FULL);
  });
  await regression('REFRESH runs the full refresh: the publication is verified first, and a republished revision is installed',async()=>{
    const v=await open(),click=()=>v.$('refresh').listeners.click[0]();
    let from=v.calls.length;click();await flush();
    assert.deepEqual(tally(v,from),FULL,'REFRESH verifies the publication, not only the scores');
    v.pub[0]=pubRow(wk3([2,3]),4);
    from=v.calls.length;click();await flush();
    assert.deepEqual(rowWeeks(v,from),[['eq.2026','eq.3']]);
    assert.match(weekLine(v),/^Week 3 · revision 4 · /);
    assert.deepEqual(records(v),[['D.C.','1','1'],['DJS','0','2']]);
  });
  await regression('a republished revision (3 → 4) is fetched once, validated and installed whole: standings, picks and the revision label move together, and later unchanged ticks never download it again',async()=>{
    const v=await open();
    v.pub[0]=pubRow(wk3([2,3]),4);
    let from=v.calls.length;await v.refresh();
    assert.deepEqual(tally(v,from),{...FULL,row:1},'the changed revision adds exactly its own full row');
    assert.deepEqual(rowWeeks(v,from),[['eq.2026','eq.3']]);
    assert.match(weekLine(v),/^Week 3 · revision 4 · /);assert.doesNotMatch(weekLine(v),/revision 3/);
    assert.deepEqual(records(v),[['D.C.','1','1'],['DJS','0','2']]);
    assert.deepEqual(pickCells(v),['bad','ok','bad','bad'],'D.C. now holds KC (lost) and BUF (won)');
    current(v,'installed');
    assert.deepEqual(v.historyCalls,[],'the URL is unchanged');
    from=v.calls.length;await v.refresh();await v.refresh();
    assert.deepEqual(tally(v,from),{token:0,index:2,row:0,rulings:6,score:2},'later unchanged ticks never download the row again');
    // Nothing of revision 3 is left: the page is exactly a fresh load of revision 4. (Last: the fresh page takes the document.)
    const installed=panels(v),fresh=await view({published:[pubRow(wk3([2,3]),4)],initialScorePayload:wk3Final()});
    assert.deepEqual(installed,panels(fresh),'the installed revision renders exactly as a fresh load of it');
  });
  await regression('a newer revision that cannot be loaded (HTTP 500) leaves revision 3 on screen, marked PUBLISHED DATA STALE and never LIVE; each later refresh retries it until it installs',async()=>{
    const v=await open(),before=graded(v);
    v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>httpError(500);
    let from=v.calls.length;await v.refresh();
    assert.equal(tally(v,from).row,1);
    assert.deepEqual(graded(v),before,'revision 3 still scores the page');
    assert.match(weekLine(v),/^PUBLISHED DATA STALE · revision 3 · /);
    stale(v,'HTTP 500');
    from=v.calls.length;await v.refresh();
    assert.equal(tally(v,from).row,1,'the next refresh retries revision 4');stale(v,'still failing');
    delete v.hooks.row;await v.refresh();
    assert.match(weekLine(v),/^Week 3 · revision 4 · /);assert.deepEqual(records(v),[['D.C.','1','1'],['DJS','0','2']]);
    current(v,'installed on retry');
  });
  await regression('a newer row that fails validation or is not exactly the published week is never installed: revision 3 stays on screen, marked stale',async()=>{
    for(const [label,setup] of [
      ['a config that fails validation',v=>{const bad=wk3([2,3]);bad.participants.pop();v.pub[0]=pubRow(bad,4)}],
      ['a response that is not JSON',v=>{v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected token < in JSON at position 0')}})}],
      ['a response that is not a list',v=>{v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>json(pubRow(wk3([2,3]),4))}],
      ['no row',v=>{v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>json([])}],
      ['two rows',v=>{v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>json([pubRow(wk3([2,3]),4),pubRow(wk3([2,3]),4)])}],
      ['a row of another week',v=>{v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>json([{...pubRow(wk3([2,3]),4),week:2}])}],
      ['a row that is not locked',v=>{v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>json([pubRow(wk3([2,3]),4,{status:'draft'})])}],
      ['a row older than the published revision',v=>{v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>json([pubRow(wk3(),3)])}]
    ]){
      const v=await open(),before=graded(v);
      setup(v);
      const from=v.calls.length;await v.refresh();
      assert.equal(tally(v,from).row,1,`${label}: the newer row is requested`);
      assert.deepEqual(graded(v),before,`${label}: revision 3 still scores the page`);
      assert.match(weekLine(v),/^PUBLISHED DATA STALE · revision 3 · /,label);
      stale(v,label);
    }
  });
  await regression('an index that is unusable, ambiguous or goes backwards is never trusted: no row is downloaded, revision 3 and the selector stay, marked stale, and a usable index clears it',async()=>{
    const id=(o={})=>({season:2026,week:3,revision:4,published_at:PUBLISHED_AT,status:'locked',...o});
    for(const [label,answer] of [
      ['the index request fails (HTTP 503)',()=>httpError(503)],
      ['the index request never reaches the server',()=>{throw new TypeError('Failed to fetch')}],
      ['an index that is not a list',()=>json({rows:[id()]})],
      ['the selected week listed twice',()=>json([id(),id({revision:5})])],
      ['a revision that is not an integer',()=>json([id({revision:4.5})])],
      ['a revision given as text',()=>json([id({revision:'4'})])],
      ['revision 0',()=>json([id({revision:0})])],
      ['another week at revision 0',()=>json([id(),id({week:4,revision:0})])],
      ['another row numbered week 0',()=>json([id(),id({week:0,revision:1})])],
      ['another row numbered season 0',()=>json([id(),id({season:0,week:4,revision:1})])],
      ['a row that is not locked',()=>json([id({status:'draft'})])],
      ['a season given as text',()=>json([id({season:'2026'})])],
      ['another row whose week is not an integer',()=>json([id(),id({week:3.5})])],
      ['the selected week missing',()=>json([id({week:4,revision:1})])],
      ['an empty index',()=>json([])],
      ['a revision older than the one on screen',()=>json([id({revision:2})])],
      ['a revision older than the one on screen, listed with a new week',()=>json([id({revision:2}),id({week:4,revision:1})])]
    ]){
      const v=await open(),before={...graded(v),options:options(v),selected:v.$('weekSelect').value};
      v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.index=answer;
      const from=v.calls.length;await v.refresh();
      assert.equal(tally(v,from).row,0,`${label}: no full row is downloaded`);
      assert.deepEqual({...graded(v),options:options(v),selected:v.$('weekSelect').value},before,`${label}: revision 3 and the selector are unchanged`);
      assert.match(weekLine(v),/^PUBLISHED DATA STALE · revision 3 · /,label);
      stale(v,label);
      delete v.hooks.index;v.pub[0]=pubRow(wk3(),3);await v.refresh();
      assert.match(weekLine(v),/^Week 3 · revision 3 · /,`${label}: recovered`);current(v,`${label}: a usable index verifying revision 3 again`);
    }
  });
  await regression('a stale publication never hides a more serious state: ON HOLD, INCOMPLETE, UNDER REVIEW, FEED UNAVAILABLE and RULINGS STALE keep their place, colour and notice, and PUBLISHED DATA STALE rides along with each',async()=>{
    const staleNext=v=>{v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>httpError(500)};
    const shows=(v,label,sync,dot,notice)=>{
      assert.match(v.$('sync').textContent,sync,`${label}: the header`);
      assert.equal(v.$('dot').style.background,dot,`${label}: the dot`);
      assert.match(weekLine(v),/^PUBLISHED DATA STALE · revision 3 · /,`${label}: the week strip`);
      assert.match(banner(v),/^PUBLISHED DATA STALE · /m,`${label}: the publication notice`);
      assert.match(banner(v),notice,`${label}: its own notice stays`);
    };
    // ON HOLD: the rules and rulings never loaded on this page.
    const hold=await open({store:pickemStore({nfl_incident_rulings:503})});staleNext(hold);await hold.refresh();
    shows(hold,'ON HOLD',/^ON HOLD · PUBLISHED DATA STALE · data \d+s old$/,'var(--red)',/^ON HOLD · Ruling data unavailable/m);
    // INCOMPLETE: the BUF-CIN game is missing from the feed.
    const incomplete=await open();staleNext(incomplete);incomplete.hooks.score=()=>json({events:[game()]});await incomplete.refresh();
    shows(incomplete,'INCOMPLETE',/^INCOMPLETE · PUBLISHED DATA STALE · data \d+s old · 1 warning$/,'var(--gold)',/BUF-CIN: expected game missing from feed/);
    // UNDER REVIEW: BUF-CIN was voided as canceled, and the feed now reports the same event as a completed final.
    const voided={ruling_id:1,contest_id:PK_CONTEST,contest_type:'pickem',week:3,away_team:'BUF',home_team:'CIN',policy_revision:1,chain_seq:1,parent_ruling_id:null,consequence:'void',
      incident_status:'STATUS_CANCELED',event_id:'401437947',evidence_source:'nflscores2',public_note:'League canceled the game; voided for this contest.',created_at:'2026-10-08T12:00:00+00:00',...PRIVATE};
    const review=await open({store:pickemStore({nfl_incident_rulings:[voided]})});staleNext(review);await review.refresh();
    shows(review,'UNDER REVIEW',/^UNDER REVIEW · PUBLISHED DATA STALE · data \d+s old$/,'var(--gold)',/^UNDER REVIEW · BUF-CIN: VOID by commissioner ruling stays applied/m);
    // RULINGS STALE: a ruling refresh fails after a verified load.
    const rulings=await open();staleNext(rulings);rulings.store.nfl_incident_rulings=503;await rulings.refresh();
    shows(rulings,'RULINGS STALE',/^PUBLISHED DATA STALE · RULINGS STALE · data \d+s old$/,'var(--gold)',/^RULINGS STALE · /m);
    // FEED UNAVAILABLE, and then with the rulings stale as well.
    const down=await open();staleNext(down);down.hooks.score=()=>httpError(503);await down.refresh();
    shows(down,'FEED UNAVAILABLE',/^FEED UNAVAILABLE · PUBLISHED DATA STALE · last good \d+s ago$/,'var(--red)',/Automatic score refresh failed/);
    down.store.nfl_incident_rulings=503;await down.refresh();
    shows(down,'FEED UNAVAILABLE and RULINGS STALE',/^FEED UNAVAILABLE · PUBLISHED DATA STALE · RULINGS STALE · last good \d+s ago$/,'var(--red)',/^RULINGS STALE · /m);
  });
  await regression('a newly published week enters the selector without moving the participant: no automatic switch, no URL change, no download of its config',async()=>{
    const v=await open({search:'?view=home'}),before=panels(v);
    assert.deepEqual(options(v),['2026-3']);
    v.pub.push(pubRow(wk4(),1));
    const from=v.calls.length;await v.refresh();await v.refresh();
    assert.deepEqual(options(v),['2026-3','2026-4'],'Week 4 appears once, after Week 3');
    assert.equal(v.$('weekSelect').value,'2026-3','Week 3 stays selected');
    assert.deepEqual(v.historyCalls,[],'the URL is never rewritten');
    assert.equal(tally(v,from).row,0,'Week 4 is not downloaded until it is chosen');
    assert.deepEqual(panels(v),before,'Week 3 is untouched');
    current(v,'new week listed');
  });
  await regression('choosing a week downloads and validates exactly that row before it replaces the week on screen, and the URL follows the choice',async()=>{
    const v=await open({published:[pubRow(wk3(),3),pubRow(wk4(),2)]});
    const from=v.calls.length;await choose(v,'2026-4');
    assert.deepEqual(rowWeeks(v,from),[['eq.2026','eq.4']],"exactly the chosen week's row");
    assert.match(weekLine(v),/^Week 4 · revision 2 · /);
    assert.deepEqual(records(v),[['DJS','1','0'],['D.C.','0','1']]);
    assert.equal(v.$('weekSelect').value,'2026-4');
    assert(v.calls.slice(from).some(c=>c.kind==='score'&&c.url.searchParams.get('week')==='4'),'the Week 4 scores are read');
    const url=new URL(v.historyCalls.at(-1)?.[1]??'https://example.test/');
    assert.deepEqual([url.searchParams.get('season'),url.searchParams.get('week')],['2026','4'],'the URL names the chosen week');
    current(v,'switched');
  });
  await regression('a chosen week that cannot be loaded keeps the week on screen: the selector goes back, an explicit error is shown, nothing is reset and the URL is unchanged',async()=>{
    for(const [label,answer] of [['HTTP 500',()=>httpError(500)],['a config that fails validation',()=>{const bad=wk4();bad.participants.pop();return json([pubRow(bad,2)])}]]){
      const v=await open({published:[pubRow(wk3(),3),pubRow(wk4(),2)]}),before=graded(v);
      v.hooks.row=u=>u.searchParams.get('week')==='eq.4'?answer():undefined;
      await choose(v,'2026-4');
      assert.equal(v.$('weekSelect').value,'2026-3',`${label}: the selector shows the week on screen again`);
      assert.match(banner(v),/Unable to switch Pick.em week/,`${label}: an explicit error`);
      assert.match(weekLine(v),/^WEEK 4 UNAVAILABLE · Week 3 · revision 3 · /,`${label}: the week strip says so`);
      assert.deepEqual(graded(v),before,`${label}: Week 3 is untouched`);
      assert.deepEqual(v.historyCalls,[],`${label}: the URL is unchanged`);
    }
    // The error stays until the next choice, even when a newer revision of the week on screen installs meanwhile.
    const v=await open({published:[pubRow(wk3(),3),pubRow(wk4(),2)]});
    v.hooks.row=u=>u.searchParams.get('week')==='eq.4'?httpError(500):undefined;
    await choose(v,'2026-4');
    v.pub[0]=pubRow(wk3([2,3]),4);await v.refresh();
    assert.match(weekLine(v),/^WEEK 4 UNAVAILABLE · Week 3 · revision 4 · /,'revision 4 installs; the failed choice is still reported');
    assert.match(banner(v),/Unable to switch Pick.em week/);
    delete v.hooks.row;await choose(v,'2026-4');
    assert.match(weekLine(v),/^Week 4 · revision 2 · /,'the next choice clears it');assert.doesNotMatch(banner(v),/Unable to switch/);
  });
  await regression('a week chosen while the first week is still loading takes the page over; the first week arriving later changes nothing',async()=>{
    const late=deferred();
    const v=await view({published:[pubRow(wk3(),3),pubRow(wk4(),2)],search:'?view=home&season=2026&week=3',initialScorePayload:wk3Final(),
      bootHooks:{row:u=>u.searchParams.get('week')==='eq.3'?late.promise:undefined}});
    v.hooks.score=byWeek;
    assert.deepEqual(options(v),['2026-3','2026-4'],'the selector is filled from the index first');
    assert.doesNotMatch(weekLine(v),/revision/,'Week 3 is still on its way');
    await choose(v,'2026-4');
    assert.match(weekLine(v),/^Week 4 · revision 2 · /);
    late.resolve(json([pubRow(wk3(),3)]));await flush();
    assert.match(weekLine(v),/^Week 4 · revision 2 · /,'Week 3 arriving last changes nothing');
    assert.deepEqual(records(v),[['DJS','1','0'],['D.C.','0','1']]);
    assert.equal(v.$('weekSelect').value,'2026-4');
    assert.deepEqual(v.historyCalls.map(([,u])=>new URL(u).searchParams.get('week')),['4'],'the URL only ever names Week 4');
    current(v,'chosen during boot');
  });
  await regression('a late response for an older revision never overwrites a newer one',async()=>{
    const v=await open(),late=deferred();
    v.pub[0]=pubRow(wk3([2,3]),4);v.hooks.row=()=>late.promise;
    await v.refresh();
    assert.match(weekLine(v),/^Week 3 · revision 3 · /,'revision 4 is still on its way: nothing installed, nothing timed out');
    // Revision 4's row is still on its way and its refresh has run past any stall limit, so the next tick replaces it.
    const realNow=Date.now;Date.now=()=>realNow()+60000;
    try{
      v.pub[0]=pubRow(wk3([2,4]),5);delete v.hooks.row;
      await v.refresh();
      assert.match(weekLine(v),/^Week 3 · revision 5 · /);
      late.resolve(json([pubRow(wk3([2,3]),4)]));await flush();
      assert.match(weekLine(v),/^Week 3 · revision 5 · /,'revision 4 arriving last changes nothing');
      assert.deepEqual(records(v),[['DJS','0','2'],['D.C.','0','2']]);
      assert.deepEqual(pickCells(v),['bad','bad','bad','bad']);
    }finally{Date.now=realNow}
  });
  await regression('a late response for a week the participant has since moved away from never replaces their newer choice',async()=>{
    const v=await open({published:[pubRow(wk3(),3),pubRow(wk4(),2),pubRow(wk5(),1)]}),late=deferred();
    v.hooks.row=u=>u.searchParams.get('week')==='eq.4'?late.promise:undefined;
    await choose(v,'2026-4');
    assert.match(weekLine(v),/^Week 3 · revision 3 · /,'Week 4 is still on its way: nothing installed');assert.doesNotMatch(banner(v),/Unable to switch/,'and nothing timed out');
    await choose(v,'2026-5');
    assert.match(weekLine(v),/^Week 5 · revision 1 · /);
    late.resolve(json([pubRow(wk4(),2)]));await flush();
    assert.match(weekLine(v),/^Week 5 · revision 1 · /,'Week 4 arriving last changes nothing');
    assert.deepEqual(records(v),[['D.C.','1','0'],['DJS','0','1']]);
    assert.equal(v.$('weekSelect').value,'2026-5');
    assert.deepEqual(v.historyCalls.map(([,u])=>new URL(u).searchParams.get('week')),['5'],'the URL only ever names Week 5');
  });
  await regression('a late score response for the week on screen before a switch never reaches the new week',async()=>{
    const v=await open({published:[pubRow(wk3(),3),pubRow(wk4(),2)]}),late=deferred();
    v.hooks.score=u=>u.searchParams.get('week')==='3'?late.promise:byWeek(u);
    await v.refresh();
    await choose(v,'2026-4');
    assert.match(weekLine(v),/^Week 4 · revision 2 · /);
    const settled=panels(v);
    late.resolve(json({events:[game({awayScore:'3',homeScore:'38'}),{...game({away:'BUF',home:'CIN',awayScore:'0',homeScore:'41'}),id:'401437947'}]}));await flush();
    assert.deepEqual(panels(v),settled,'the Week 3 response arriving last changes nothing on the Week 4 page');
    assert.deepEqual(records(v),[['DJS','1','0'],['D.C.','0','1']]);
  });
  await regression('coming back from Survivor runs one full Pick’em refresh at once; moving between Pick’em views runs none; a tick at the same moment adds none',async()=>{
    const v=await open();v.doc.visibilityState='visible';
    v.click('survivor');await flush();
    let from=v.calls.length;v.click('home');await flush();
    assert.deepEqual(tally(v,from),FULL,'Survivor → Home');
    from=v.calls.length;v.click('games');v.click('standings');v.click('picks');await flush();
    assert.deepEqual(kinds(v,from),[],'between Pick’em views');
    v.click('survivor');await flush();
    from=v.calls.length;v.click('games');v.tick();await flush();
    assert.deepEqual(tally(v,from),FULL,'a view change and a tick together');
  });

  await regression("while Survivor has the page the Pick'em header says PICK'EM PAUSED, never a frozen LIVE, even when a refresh lands after the switch; coming back refreshes it",async()=>{
    const PAUSED="PICK'EM PAUSED · refreshes on return";
    const v=await open();v.doc.visibilityState='visible';
    assert.match(v.$('sync').textContent,/^LIVE · /);
    v.click('survivor');
    assert.deepEqual([v.$('sync').textContent,v.$('dot').style.background],[PAUSED,'var(--dim)'],'Survivor takes the page');
    v.click('home');await flush();
    assert.match(v.$('sync').textContent,/^LIVE · data \d+s old$/,'coming back refreshes it');
    for(const [label,answer] of [['scores that load',()=>json(wk3Final())],['a score feed that fails',()=>httpError(503)]]){
      const late=deferred();v.hooks.score=()=>late.promise;
      v.tick();v.click('survivor');   // a refresh still on its way when Survivor takes the page
      late.resolve(answer());await flush();
      assert.deepEqual([v.$('sync').textContent,v.$('dot').style.background],[PAUSED,'var(--dim)'],`${label}: landing after the switch keeps the pause`);
      v.hooks.score=byWeek;v.click('home');await flush();
      assert.match(v.$('sync').textContent,/^LIVE · data \d+s old$/,`${label}: coming back refreshes it`);
    }
    const s=await open({search:'?view=survivor&season=2026&week=3'});
    assert.equal(s.$('sync').textContent,PAUSED,'a page opened on Survivor shows Pick’em paused from the start');
    s.doc.visibilityState='visible';s.click('standings');await flush();
    assert.match(s.$('sync').textContent,/^LIVE · data \d+s old$/);
  });

  assert.equal(failures.length,0,`HDC-15 Pick'em refresh-lifecycle regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('weekly HDC-15 publication index, atomic revision install, published-data stale state, new-week discovery, week switching, request budget, visibility and active-view polling and late-response regressions passed');


// A virtual clock for the HDC-15 remediation regressions below. Every timer keeps its real duration and fires in time order
// as the clock advances; timers due at the same moment fire in the order they were set (a repeating timer is set again as
// it fires, before it runs), as in a browser, and every promise settles before the next timer fires. Date.now() and
// new Date() read the virtual time. A 0 ms timer (the harness's flush) is left to the real event loop. jump() is a frozen
// page: time passes and no timer fires; when the clock next advances, each overdue timer fires once, in order.
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

// HDC-15 remediation (F-1, refresh starvation). The rejected candidate (60760a1) let a timer tick replace any refresh still
// running 15 s after it started, while a full refresh runs up to three requests one after another (the publication index,
// the row of a changed revision, then the score feed with the rules and rulings side by side), each allowed 15 s, and the
// Pick'em score feed had no time limit at all. At 10-14 s a request no refresh ever completed: each was replaced at the next
// 20 s tick, the header stayed on "Updating…", and a score feed that never answered never reached FEED UNAVAILABLE. These
// regressions run the page on the virtual clock above, which keeps every real duration (the network latency, the 15 s time
// limits, the 20 s timer and the stall limit), so they relate exactly as in a browser; nothing is shortened. Each regression
// reports through one collector; the block fails at its end if any did.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const S=1000,PERIOD=20*S,LIMIT=15*S,PUBLISHED_AT='2026-09-27T16:43:08.115+00:00';
  // Week 3 (DEN at KC, BUF at CIN, the tiebreak game) as in the HDC-15 regressions above: revision 3 has D.C. on DEN and BUF,
  // revision 4 on KC and BUF, revision 5 on KC and CIN. Weeks 4 and 5 have one game each.
  const wk3=(dc=[1,3])=>({schemaVersion:1,season:2026,week:3,tiebreakGameIndex:1,
    games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-27'},{away:'BUF',home:'CIN',awayNumber:3,homeNumber:4,date:'2026-09-28'}],
    participants:[{id:'dc',displayName:'D.C.',pickNumbers:dc,tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2,4],tiebreak:44}]});
  const oneGame=(week,away,home,date)=>({schemaVersion:1,season:2026,week,tiebreakGameIndex:0,games:[{away,home,awayNumber:1,homeNumber:2,date}],
    participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1],tiebreak:40},{id:'djs',displayName:'DJS',pickNumbers:[2],tiebreak:38}]});
  const wk4=()=>oneGame(4,'MIA','BUF','2026-10-04'),wk5=()=>oneGame(5,'NYJ','NE','2026-10-11');
  const pubRow=(cfg,revision)=>({season:cfg.season,week:cfg.week,status:'locked',revision,published_at:PUBLISHED_AT,locked_at:PUBLISHED_AT,config:structuredClone(cfg)});
  const FEEDS={3:{events:[game(),{...game({away:'BUF',home:'CIN',awayScore:'27',homeScore:'24'}),id:'401437947'}]},
    4:{events:[game({week:4,away:'MIA',home:'BUF',awayScore:'10',homeScore:'20'})]},5:{events:[game({week:5,away:'NYJ',home:'NE',awayScore:'24',homeScore:'13'})]}};
  const json=data=>({ok:true,status:200,json:async()=>structuredClone(data)});
  const R4=[['D.C.','1','1'],['DJS','0','2']],R5=[['DJS','0','2'],['D.C.','0','2']];
  // A Pick'em page on the virtual clock, visible, its 20 s timer running on the clock from boot. Every publication read, rules
  // and rulings read and score-feed request is answered lag(kind, request) ms after it is sent (Infinity: never), from the
  // data as it was when it was sent; one the page abandons fails at once with an AbortError, as fetch does, unless
  // deaf(kind, request): a response already on its way, which arrives anyway. The anonymous token is minted at boot and stays
  // valid throughout, so no phase waits on a renewal. Every request is logged (its kind, when it was sent, when it ended and
  // how: answered, aborted or still open), and so is every change to the header, its dot, the week strip and the REFRESH
  // button, with its time. A refresh has completed when its generation re-enables REFRESH.
  const slowPage=async({lag=()=>0,tokenLag=()=>0,deaf=()=>false,scoreResponse=()=>null,published=[pubRow(wk3(),3)],search='?view=home&season=2026&week=3'}={})=>{
    const clock=virtualClock(),life=[],seen=[],ticks=[];let v=null;
    try{
      const send=(kind,url,init,response)=>{
        const rec={kind,url,sent:clock.now(),ended:null,how:'open'};life.push(rec);
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
      const rows=()=>structuredClone(v?v.pub:published);
      const rulings=table=>(u,init)=>send('rulings',u,init,dataApi(table,pickemStore()[table],u));
      const store={nfl_contests:rulings('nfl_contests'),nfl_contest_policies:rulings('nfl_contest_policies'),nfl_incident_rulings:rulings('nfl_incident_rulings')};
      const hooks={index:(u,init)=>send('index',u,init,publicationApi(rows(),u)),row:(u,init)=>send('row',u,init,publicationApi(rows(),u)),
        score:(u,init)=>send('score',u,init,scoreResponse(u)??json(FEEDS[u.searchParams.get('week')])),token:(u,init,answer)=>send('token',u,init,answer)};
      v=await view({published,search,initialScorePayload:FEEDS[3],store,bootHooks:hooks});
      // From boot on, fetch returns the request's own promise, as a browser's fetch does (the harness's async fetch adds
      // promise ticks a browser does not); only the anonymous token still goes through the harness.
      const harnessFetch=globalThis.fetch;
      globalThis.fetch=(url,init={})=>{
        const u=new URL(url),table=Object.keys(RULING_COLUMNS).find(t=>u.pathname.endsWith(`/${t}`));
        if(u.pathname.endsWith('/nfl_pool_weeks'))return(u.searchParams.get('select')||'*').split(',').some(c=>c==='config'||c==='*')?hooks.row(u,init):hooks.index(u,init);
        if(table)return store[table](u,init);
        if(u.pathname.endsWith('/scoreboard'))return hooks.score(u,init);
        return harnessFetch(url,init);
      };
      const watch=(label,el,prop)=>{let value=el[prop];seen.push({t:clock.now(),label,value});Object.defineProperty(el,prop,{configurable:true,enumerable:true,get:()=>value,set:x=>{value=prop==='textContent'?(x==null?'':String(x)):x;seen.push({t:clock.now(),label,value})}})};
      watch('sync',v.$('sync'),'textContent');watch('dot',v.$('dot').style,'background');watch('weekLine',v.$('weekLine'),'textContent');watch('refresh',v.$('refresh'),'disabled');
      v.doc.visibilityState='visible';
      const start=clock.now();clock.every(PERIOD,()=>{ticks.push(clock.now());v.tick()});
      const since=from=>life.slice(from);
      return{v,clock,life,seen,ticks,
        sync:()=>v.$('sync').textContent,dot:()=>v.$('dot').style.background,weekLine:()=>v.$('weekLine').textContent,
        banner:()=>v.$('error').children.map(c=>c.textContent).join('\n'),
        toNextTick:()=>(ticks.length?ticks[ticks.length-1]:start)+PERIOD-clock.now(),
        // The refreshes that completed after seen[from]: when, and the header and dot they left.
        settled:(from=0)=>{const out=[];let sync=null,dot=null;seen.forEach((s,i)=>{if(s.label==='sync')sync=s.value;if(s.label==='dot')dot=s.value;if(i>=from&&s.label==='refresh'&&s.value===false&&s.t>=0)out.push({t:s.t,sync,dot})});return out},
        // The header text over time after seen[from], as [time, text].
        headers:(from=0)=>seen.slice(from).filter(s=>s.label==='sync').map(s=>[s.t,s.value]),
        tally:(from=0,until=Infinity)=>{const t={index:0,row:0,rulings:0,score:0};for(const r of since(from))if(r.sent<=until&&r.kind in t)t[r.kind]++;return t},
        sentAt:(from,at)=>since(from).filter(r=>r.sent===at).map(r=>r.kind),
        aborted:(from=0)=>since(from).filter(r=>r.how==='aborted').map(r=>({kind:r.kind,sent:r.sent,after:r.ended-r.sent})),
        // The most requests of each kind open at once.
        maxOpen:(from=0)=>{const out={index:0,row:0,rulings:0,score:0},list=since(from).filter(r=>r.kind in out);for(const r of list){const n=list.filter(x=>x.kind===r.kind&&x.sent<=r.sent&&(x.ended===null||x.ended>r.sent)).length;out[r.kind]=Math.max(out[r.kind],n)}return out},
        trace:(from=0,t0=0)=>since(from).map(r=>`${r.kind}@${(r.sent-t0)/S}-${r.ended===null?'open':(r.ended-t0)/S}:${r.how}`).join(' ')};
    }catch(error){clock.restore();throw error}
  };
  // Runs check on a slow page and always restores the real timers afterwards.
  const onSlowPage=async(options,check)=>{const p=await slowPage(options);try{await check(p)}finally{p.clock.restore()}};
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
  const graded=v=>({records:records(v),cells:pickCells(v),games:v.$('gamegrid').innerHTML});
  const choose=(v,value)=>{const select=v.$('weekSelect');select.value=value;for(const fn of select.listeners.change||[])fn()};
  const click=v=>v.$('refresh').listeners.click[0]();
  const FULL={index:1,row:0,rulings:3,score:1};

  for(const L of [10,11,12,14]){
    await regression(`${L} s a request: a healthy refresh (the index, then the scores with the rules and rulings: ${2*L} s) completes, the timer ticks while it runs join it instead of replacing it, nothing is abandoned, and six timer periods complete at least two refreshes`,()=>onSlowPage({lag:()=>L*S},async p=>{
      await p.clock.advance(3*L*S);
      assert.equal(p.sync(),'LIVE · data 0s old','boot (the index, the row, then the scores with the rules and rulings) completes');
      const from=p.seen.length,sent=p.life.length,t0=p.clock.now();
      await p.clock.advance(6*PERIOD);
      const done=p.settled(from),starts=p.life.slice(sent).filter(r=>r.kind==='index').map(r=>r.sent);
      assert.equal(p.ticks.filter(t=>t>t0).length,6,'six timer periods');
      assert(done.length>=2,`completed refreshes: ${done.length}, want at least 2; requests: ${p.trace(sent,t0)}`);
      for(const d of done)assert.deepEqual([d.sync,d.dot],['LIVE · data 0s old','var(--green)'],`the refresh completed at +${(d.t-t0)/S} s`);
      assert.deepEqual(p.aborted(sent),[],'no request is abandoned');
      starts.slice(1).forEach((s,k)=>assert(s>=done[k].t,`refresh ${k+2} started at +${(s-t0)/S} s, before refresh ${k+1} completed at +${(done[k].t-t0)/S} s`));
      assert(starts.length===done.length||starts.length===done.length+1,`${starts.length} refreshes started, ${done.length} completed`);
      done.forEach((d,k)=>assert.deepEqual(p.tally(sent,d.t),Object.fromEntries(Object.entries(FULL).map(([kind,n])=>[kind,n*(k+1)])),`requests through refresh ${k+1}: one index, the three HDC-12 tables and one score feed each, never a row`));
      assert.deepEqual(p.maxOpen(sent),FULL,'one refresh at a time');
    }));
  }

  for(const L of [12,14]){
    await regression(`a republished revision (3 → 4) over ${L} s a request (the index, the row, then the scores with the rules and rulings: ${3*L} s) is installed whole and its refresh completes; the timer ticks during it join it and nothing is abandoned`,()=>onSlowPage({lag:()=>L*S},async p=>{
      await p.clock.advance(3*L*S);
      assert.match(p.weekLine(),/^Week 3 · revision 3 · /);
      p.v.pub[0]=pubRow(wk3([2,3]),4);
      const from=p.seen.length,sent=p.life.length;
      await p.clock.advance(p.toNextTick());const T=p.clock.now();
      await p.clock.advance(3*L*S);
      assert.deepEqual(p.settled(from).map(d=>[(d.t-T)/S,d.sync]),[[3*L,'LIVE · data 0s old']],`one refresh, completed at ${3*L} s; requests: ${p.trace(sent,T)}`);
      assert.match(p.weekLine(),/^Week 3 · revision 4 · /);
      assert.deepEqual(records(p.v),R4);assert.deepEqual(pickCells(p.v),['bad','ok','bad','bad'],'D.C. holds KC (lost) and BUF (won)');
      assert.deepEqual(p.tally(sent),{index:1,row:1,rulings:3,score:1},'the index, the row of revision 4, then its scores and rulings; the ticks during it sent nothing');
      assert.deepEqual(p.life.slice(sent).map(r=>[r.kind,(r.sent-T)/S]),[['index',0],['row',L],['score',2*L],['rulings',2*L],['rulings',2*L],['rulings',2*L]],'one phase after another');
      assert.deepEqual(p.aborted(sent),[],'nothing is abandoned');
      const next=p.life.length;await p.clock.advance(p.toNextTick()+2*L*S);
      assert.deepEqual(p.tally(next),FULL,'the next refresh finds revision 4 unchanged: no row');
      assert.match(p.weekLine(),/^Week 3 · revision 4 · /);assert.equal(p.sync(),'LIVE · data 0s old');
    }));
  }

  for(const [label,lagScore,scoreResponse] of [
    ['never answers',Infinity,()=>null],
    ['answers but never delivers its body',0,()=>({ok:true,status:200,json:()=>new Promise(()=>{})})]
  ]){
    await regression(`a Pick’em score feed that ${label} is abandoned at its 15 s limit: the header says FEED UNAVAILABLE (red) at 15 s, not before; never LIVE again, never "Updating…" for longer than the limit, and each later refresh fails the same way, one score request at a time`,async()=>{
      let hang=false;
      await onSlowPage({lag:kind=>kind==='score'&&hang?lagScore:0,scoreResponse:()=>hang?scoreResponse():null},async p=>{
        await p.clock.advance(0);
        assert.equal(p.sync(),'LIVE · data 0s old','boot');
        hang=true;
        const from=p.seen.length,sent=p.life.length;
        await p.clock.advance(p.toNextTick());const T=p.clock.now();
        assert.equal(p.sync(),'Updating…');
        await p.clock.advance(LIMIT-1);
        assert.equal(p.sync(),'Updating…','within its 15 s limit the feed is still awaited: no failure is reported early');
        await p.clock.advance(1);
        assert.match(p.sync(),/^FEED UNAVAILABLE · last good \d+s ago$/,'at its limit the feed is abandoned and the refresh reports it');
        assert.equal(p.dot(),'var(--red)');
        assert.match(p.banner(),/Automatic score refresh failed/);
        if(lagScore===Infinity)assert.deepEqual(p.aborted(sent),[{kind:'score',sent:T,after:LIMIT}],'the request is abandoned at its limit, not before');
        await p.clock.advance(5*PERIOD);
        const done=p.settled(from);
        assert.deepEqual(done.map(d=>(d.t-T)/S),[15,35,55,75,95,115],`a refresh at each tick, each failing at its limit; requests: ${p.trace(sent,T)}`);
        for(const d of done)assert.match(d.sync,/^FEED UNAVAILABLE · last good \d+s ago$/);
        const headers=p.headers(from);
        assert(!headers.some(([,text])=>/^LIVE\b/.test(text)),'never LIVE');
        headers.forEach(([t,text],i)=>{if(text==='Updating…'){const end=headers[i+1]?.[0]??p.clock.now();assert(end-t<=LIMIT,`"Updating…" from +${(t-T)/S} s lasted ${(end-t)/S} s`)}});
        assert(p.maxOpen(sent).score<=1,'one score request at a time');
        if(lagScore===Infinity)assert(p.aborted(sent).every(r=>r.kind==='score'&&r.after===LIMIT),'every score request is abandoned exactly at its limit');
      });
    });
  }

  await regression('an outage that hangs the publication index and then the score feed: the refresh marks PUBLISHED DATA STALE at 15 s and reports FEED UNAVAILABLE at 30 s, keeps the verified revision, never says LIVE, and the tick in between joins it',async()=>{
    let hang=false;
    await onSlowPage({lag:kind=>hang&&(kind==='index'||kind==='score')?Infinity:0},async p=>{
      await p.clock.advance(0);
      const before=graded(p.v);
      hang=true;
      const from=p.seen.length,sent=p.life.length;
      await p.clock.advance(p.toNextTick());const T=p.clock.now();
      await p.clock.advance(LIMIT);
      assert.match(p.weekLine(),/^PUBLISHED DATA STALE · revision 3 · /,'at 15 s the index is abandoned and the week strip says the publication is stale at once');
      assert.equal(p.sync(),'Updating…','the scores are still awaited: the header claims nothing');
      await p.clock.advance(LIMIT);
      assert.match(p.sync(),/^FEED UNAVAILABLE · PUBLISHED DATA STALE · last good \d+s ago$/,'at 30 s the score feed is abandoned and the refresh completes');
      assert.equal(p.dot(),'var(--red)');
      assert.match(p.banner(),/^PUBLISHED DATA STALE · the published week list could not be checked \(published week data timed out\)/m);
      assert.match(p.banner(),/Automatic score refresh failed/);
      assert.deepEqual(graded(p.v),before,'revision 3 still scores the page');
      await p.clock.advance(6*PERIOD-2*LIMIT);
      const done=p.settled(from);
      assert.deepEqual(done.map(d=>(d.t-T)/S),[30,70,110],`one refresh every two ticks, each taking its two 15 s limits; requests: ${p.trace(sent,T)}`);
      for(const d of done)assert.match(d.sync,/^FEED UNAVAILABLE · PUBLISHED DATA STALE · last good \d+s ago$/);
      assert(!p.headers(from).some(([,text])=>/^LIVE\b/.test(text)),'never LIVE');
      assert(p.aborted(sent).every(r=>r.after===LIMIT),'nothing is abandoned before its own limit: no refresh is replaced');
      assert.deepEqual([p.maxOpen(sent).index,p.maxOpen(sent).score],[1,1],'one refresh at a time');
    });
  });

  await regression('a fast network is unchanged: each visible timer tick runs one full refresh (one index, the three HDC-12 tables, one score feed, no row) that completes at the tick, LIVE, and nothing is abandoned',()=>onSlowPage({},async p=>{
    await p.clock.advance(0);
    for(let i=1;i<=6;i++){
      const from=p.seen.length,sent=p.life.length;
      await p.clock.advance(p.toNextTick());const T=p.clock.now();
      assert.deepEqual(p.tally(sent),FULL,`tick ${i}`);
      assert.deepEqual(p.settled(from).map(d=>[d.t-T,d.sync,d.dot]),[[0,'LIVE · data 0s old','var(--green)']],`tick ${i}: completes at once`);
    }
    assert.deepEqual(p.aborted(0),[]);
  }));

  await regression('a refresh that reaches every phase’s full 15 s limit (the index answering at 14.9 s with revision 4, its row and then the score feed never answering) is never replaced: it completes at 44.9 s with PUBLISHED DATA STALE and FEED UNAVAILABLE; ticks at 4.5, 24.5 and 44.5 s join it',async()=>{
    let T=Infinity;
    await onSlowPage({lag:(kind,r)=>r.sent<T?0:kind==='index'?14.9*S:kind==='row'||kind==='score'?Infinity:0},async p=>{
      await p.clock.advance(p.toNextTick()+15.5*S);
      p.v.pub[0]=pubRow(wk3([2,3]),4);
      const from=p.seen.length,sent=p.life.length;T=p.clock.now();
      click(p.v);
      await p.clock.advance(46*S);
      assert.deepEqual(p.ticks.filter(t=>t>T).map(t=>(t-T)/S),[4.5,24.5,44.5]);
      assert.deepEqual(p.settled(from).map(d=>(d.t-T)/S),[44.9],`one refresh, completed at 44.9 s; requests: ${p.trace(sent,T)}`);
      assert.match(p.sync(),/^FEED UNAVAILABLE · PUBLISHED DATA STALE · last good \d+s ago$/);
      assert.match(p.weekLine(),/^PUBLISHED DATA STALE · revision 3 · /);
      assert.match(p.banner(),/revision 4 is published but could not be loaded \(published week data timed out\)/);
      assert.deepEqual(p.tally(sent),{index:1,row:1,rulings:3,score:1},'the ticks during it sent nothing');
      assert.deepEqual(p.aborted(sent).map(r=>[r.kind,r.after/S]),[['row',15],['score',15]],'only the time limits abandon a request');
    });
  });

  await regression('a week choice that times out falls back to refreshing the week on screen, and that refresh is not replaced by the stall limit: the fallback (a republished revision, then the scores, 14 s a request) completes and installs it; the ticks during it join it',async()=>{
    let T=Infinity;
    await onSlowPage({published:[pubRow(wk3(),3),pubRow(wk4(),2)],lag:(kind,r)=>r.sent<T?0:kind==='row'&&r.sent===T?Infinity:14*S},async p=>{
      await p.clock.advance(p.toNextTick()+10*S);
      p.v.pub[0]=pubRow(wk3([2,3]),4);
      const from=p.seen.length,sent=p.life.length;T=p.clock.now();
      choose(p.v,'2026-4');
      await p.clock.advance(60*S);
      assert.deepEqual(p.ticks.filter(t=>t>T).map(t=>(t-T)/S),[10,30,50]);
      assert.deepEqual(p.settled(from).map(d=>[(d.t-T)/S,d.sync]),[[57,'LIVE · data 0s old']],`the choice fails at 15 s; its fallback (index 14 s, row 14 s, scores 14 s) completes at 57 s; requests: ${p.trace(sent,T)}`);
      assert.match(p.weekLine(),/^WEEK 4 UNAVAILABLE · Week 3 · revision 4 · /);
      assert.deepEqual(records(p.v),R4);
      assert.deepEqual(p.aborted(sent).map(r=>[r.kind,r.after/S]),[['row',15]],'only the chosen week’s row is abandoned, at its limit');
      assert.deepEqual(p.tally(sent),{index:1,row:2,rulings:3,score:1},'the ticks during the choice and its fallback sent nothing');
    });
  });

  await regression('a late response under long latency never overwrites a newer revision: a refresh slowed to 12 s a request is superseded by REFRESH, which installs revision 5; its own revision 4 row arriving afterwards changes nothing',async()=>{
    let T=Infinity,R=Infinity;
    await onSlowPage({lag:(kind,r)=>r.sent>=T&&r.sent<R?12*S:0,deaf:(kind,r)=>r.sent>=T&&r.sent<R},async p=>{
      await p.clock.advance(0);
      p.v.pub[0]=pubRow(wk3([2,3]),4);
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      await p.clock.advance(1+16*S);
      assert.match(p.weekLine(),/^Week 3 · revision 3 · /,'revision 4 is still on its way');
      p.v.pub[0]=pubRow(wk3([2,4]),5);R=p.clock.now();
      click(p.v);await p.clock.advance(0);
      assert.match(p.weekLine(),/^Week 3 · revision 5 · /);
      await p.clock.advance(3*PERIOD);
      assert(p.life.some(r=>r.kind==='row'&&r.sent===T+12*S&&r.how==='answered'&&r.ended===T+24*S),'revision 4’s row did arrive, late');
      assert.match(p.weekLine(),/^Week 3 · revision 5 · /,'revision 4 arriving last changes nothing');
      assert.deepEqual(records(p.v),R5);assert.deepEqual(pickCells(p.v),['bad','bad','bad','bad']);
      assert.equal(p.sync(),'LIVE · data 0s old');
    });
  });

  await regression('a late response under long latency never replaces a newer week choice: Week 4’s row, slowed to 12 s, arrives after Week 5 was chosen and installed, and changes nothing',async()=>{
    const weekFour=(kind,r)=>kind==='row'&&r.url.searchParams.get('week')==='eq.4';
    await onSlowPage({published:[pubRow(wk3(),3),pubRow(wk4(),2),pubRow(wk5(),1)],lag:(kind,r)=>weekFour(kind,r)?12*S:0,deaf:weekFour},async p=>{
      await p.clock.advance(0);
      choose(p.v,'2026-4');await p.clock.advance(5*S);
      assert.match(p.weekLine(),/^Week 3 · revision 3 · /,'Week 4 is still on its way');
      choose(p.v,'2026-5');await p.clock.advance(0);
      assert.match(p.weekLine(),/^Week 5 · revision 1 · /);
      await p.clock.advance(2*PERIOD);
      assert(p.life.some(r=>weekFour(r.kind,r)&&r.how==='answered'),'Week 4’s row did arrive, late');
      assert.match(p.weekLine(),/^Week 5 · revision 1 · /,'Week 4 arriving last changes nothing');
      assert.deepEqual(records(p.v),[['D.C.','1','0'],['DJS','0','1']]);
      assert.equal(p.v.$('weekSelect').value,'2026-5');
    });
  });

  await regression('a superseded refresh’s score request is abandoned with it at once, not left to its own time limit: a week chosen while a 12 s score request is on its way aborts that request',async()=>{
    let T=Infinity;
    await onSlowPage({published:[pubRow(wk3(),3),pubRow(wk4(),2)],lag:(kind,r)=>r.sent>=T&&r.sent<T+PERIOD&&(kind==='score'||kind==='rulings')?12*S:0},async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      const sent=p.life.length;
      await p.clock.advance(1+5*S);
      assert.deepEqual(p.life.slice(sent).filter(r=>r.how==='open').map(r=>r.kind).sort(),['rulings','rulings','rulings','score'],'the refresh is waiting for its scores and rulings');
      choose(p.v,'2026-4');await p.clock.advance(0);
      assert.deepEqual(p.aborted(sent).map(r=>[r.kind,r.after/S]).sort(),[['rulings',5],['rulings',5],['rulings',5],['score',5]],'the superseded score and ruling requests are abandoned at the choice');
      assert.match(p.weekLine(),/^Week 4 · revision 2 · /);
    });
  });

  await regression('Survivor taking the page during a slow Pick’em refresh: the header says PICK’EM PAUSED at once and keeps it when that refresh lands; the Pick’em timer sends nothing while Survivor has the page; coming back runs one full refresh that completes',async()=>{
    const PAUSED="PICK'EM PAUSED · refreshes on return";
    let T=Infinity;
    await onSlowPage({lag:(kind,r)=>r.sent>=T?12*S:0},async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      await p.clock.advance(1+5*S);
      const sent=p.life.length;
      p.v.click('survivor');
      assert.equal(p.sync(),PAUSED);
      await p.clock.advance(2*PERIOD);
      assert.equal(p.sync(),PAUSED,'the refresh that landed meanwhile keeps the pause');
      assert.deepEqual(p.tally(sent),{index:0,row:0,rulings:3,score:1},'only the refresh already on its way continues; the timer sends nothing');
      const back=p.life.length,from=p.seen.length;
      p.v.click('home');const B=p.clock.now();
      await p.clock.advance(2*12*S);
      assert.deepEqual(p.tally(back),FULL,'one full refresh');
      assert.deepEqual(p.settled(from).map(d=>[(d.t-B)/S,d.sync]),[[24,'LIVE · data 0s old']]);
      assert.deepEqual(p.aborted(0),[]);
    });
  });

  await regression('hidden during a slow refresh: the refresh already on its way may finish, no timer tick sends a request while hidden, and becoming visible again runs one full refresh',async()=>{
    let T=Infinity;
    await onSlowPage({lag:(kind,r)=>r.sent>=T?12*S:0},async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      await p.clock.advance(1+5*S);
      p.v.setVisibility('hidden');
      const sent=p.life.length;
      await p.clock.advance(3*PERIOD);
      assert.deepEqual(p.tally(sent),{index:0,row:0,rulings:3,score:1},'only the refresh already on its way continues (its scores and rulings); hidden ticks send nothing');
      assert.equal(p.sync(),'LIVE · data 0s old','the refresh on its way completed');
      const back=p.life.length;p.v.setVisibility('visible');
      await p.clock.advance(0);
      assert.deepEqual(p.tally(back),{index:1,row:0,rulings:0,score:0},'becoming visible starts one full refresh at once');
      await p.clock.advance(24*S);
      assert.deepEqual(p.tally(back),FULL);assert.equal(p.sync(),'LIVE · data 0s old');
    });
  });

  await regression('becoming visible while a slow refresh is still within its time limits joins it instead of starting a second: a republished revision 30 s into its 42 s refresh still installs, nothing is abandoned',async()=>{
    let T=Infinity;
    await onSlowPage({lag:(kind,r)=>r.sent>=T?14*S:0},async p=>{
      await p.clock.advance(0);
      p.v.pub[0]=pubRow(wk3([2,3]),4);
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      const sent=p.life.length,from=p.seen.length;
      await p.clock.advance(1+25*S);
      p.v.setVisibility('hidden');await p.clock.advance(5*S);
      const back=p.life.length;p.v.setVisibility('visible');await p.clock.advance(0);
      assert.deepEqual(p.tally(back),{index:0,row:0,rulings:0,score:0},'becoming visible 30 s in starts nothing');
      await p.clock.advance(12*S);
      assert.deepEqual(p.settled(from).map(d=>[(d.t-T)/S,d.sync]),[[42,'LIVE · data 0s old']],`requests: ${p.trace(sent,T)}`);
      assert.match(p.weekLine(),/^Week 3 · revision 4 · /);assert.deepEqual(records(p.v),R4);
      assert.deepEqual(p.aborted(sent),[]);
    });
  });

  await regression('a page frozen in the background past the longest a refresh can take: becoming visible replaces the refresh it left behind, at once and only once, and the new refresh completes',async()=>{
    let T=Infinity;
    await onSlowPage({lag:(kind,r)=>r.sent>=T?12*S:0},async p=>{
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
      assert.deepEqual(p.settled(from).map(d=>[(d.t-V)/S,d.sync]),[[24,'LIVE · data 0s old']],`requests: ${p.trace(sent,T)}`);
      assert.deepEqual(p.tally(sent),{index:2,row:0,rulings:3,score:1});
    });
  });

  await regression('a refresh left behind by a page frozen in the background never lets a timer tick start a new refresh while the page is still hidden, however long it has run; becoming visible does',async()=>{
    let T=Infinity;
    await onSlowPage({lag:(kind,r)=>r.sent>=T?12*S:0},async p=>{
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

  await regression('a Pick’em refresh left behind by a frozen page never lets Pick’em refresh while Survivor has the page, however long it has run',async()=>{
    let T=Infinity;
    await onSlowPage({lag:(kind,r)=>r.sent>=T?12*S:0},async p=>{
      await p.clock.advance(p.toNextTick()-1);T=p.clock.now()+1;
      const sent=p.life.length;
      await p.clock.advance(1+5*S);
      p.v.click('survivor');p.v.setVisibility('hidden');
      p.clock.jump(300*S);
      p.v.setVisibility('visible');
      await p.clock.advance(2*PERIOD);
      assert.deepEqual(p.life.slice(sent).filter(r=>r.kind==='index').map(r=>(r.sent-T)/S),[0],'Survivor has the page: Pick’em starts no refresh, on resume or on a tick');
      assert.equal(p.sync(),"PICK'EM PAUSED · refreshes on return");
    });
  });

  await regression('the stall limit is the longest a refresh can take plus a second (46 s): a refresh left behind by a page frozen until 45.9 s after it started is joined when the page becomes visible, one frozen until 46 s is replaced',async()=>{
    for(const [frozenUntil,replaced] of [[45900,false],[46000,true]]){
      let T=Infinity;
      await onSlowPage({lag:(kind,r)=>r.sent>=T?12*S:0},async p=>{
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

  await regression('where fetch’s own abort error reaches the race first, a score feed that runs out of time is still a timeout: FEED UNAVAILABLE at 15 s, never a silent "Updating…"',()=>abortAlgorithmsFirst(async()=>{
    let hang=false;
    await onSlowPage({lag:kind=>kind==='score'&&hang?Infinity:0},async p=>{
      await p.clock.advance(0);hang=true;
      await p.clock.advance(p.toNextTick());
      await p.clock.advance(LIMIT);
      assert.match(p.sync(),/^FEED UNAVAILABLE · last good \d+s ago$/);assert.equal(p.dot(),'var(--red)');
    });
  }));

  await regression('where fetch’s own abort error reaches the race first, a publication index that runs out of time is still a timeout: PUBLISHED DATA STALE at 15 s, and the refresh never says LIVE',()=>abortAlgorithmsFirst(async()=>{
    let hang=false;
    await onSlowPage({lag:kind=>kind==='index'&&hang?Infinity:0},async p=>{
      await p.clock.advance(0);hang=true;
      const from=p.seen.length;
      await p.clock.advance(p.toNextTick());
      await p.clock.advance(LIMIT);
      assert.match(p.weekLine(),/^PUBLISHED DATA STALE · revision 3 · /,'the publication is marked stale at its limit');
      assert.match(p.sync(),/^PUBLISHED DATA STALE · data 0s old$/,'the refresh completes with the stale state, not LIVE');
      assert(!p.headers(from).some(([,text])=>/^LIVE\b/.test(text)),'never LIVE');
      assert.match(p.banner(),/^PUBLISHED DATA STALE · the published week list could not be checked \(published week data timed out\)/m);
    });
  }));

  await regression('where fetch’s own abort error reaches the race first, a chosen week whose row runs out of time is still a failed choice: at 15 s the error is shown, the selector goes back and the week on screen is refreshed',()=>abortAlgorithmsFirst(async()=>{
    let T=Infinity;
    await onSlowPage({published:[pubRow(wk3(),3),pubRow(wk4(),2)],lag:(kind,r)=>kind==='row'&&r.sent>=T?Infinity:0},async p=>{
      await p.clock.advance(p.toNextTick()+5*S);
      const sent=p.life.length;T=p.clock.now();
      choose(p.v,'2026-4');
      await p.clock.advance(LIMIT);
      assert.match(p.banner(),/Unable to switch Pick.em week: 2026 Week 4 could not be loaded \(published week data timed out\)/);
      assert.match(p.weekLine(),/^WEEK 4 UNAVAILABLE · Week 3 · revision 3 · /);assert.equal(p.v.$('weekSelect').value,'2026-3');
      assert.deepEqual(p.tally(sent),{index:1,row:1,rulings:3,score:1},'the week on screen is refreshed at once');
      assert.equal(p.sync(),'LIVE · data 0s old');
    });
  }));

  for(const L of [10,12,14]){
    await regression(`${L} s for every request from the very first, the anonymous token included: boot completes (the token, then the index, the row and the scores with the rules and rulings: ${4*L} s), then so do the refreshes; no read waits for the token inside its own time limit`,()=>onSlowPage({lag:()=>L*S,tokenLag:()=>L*S},async p=>{
      await p.clock.advance(4*L*S);
      assert.equal(p.sync(),'LIVE · data 0s old',`boot completes at ${4*L} s`);
      assert.match(p.weekLine(),/^Week 3 · revision 3 · /);
      assert.deepEqual(p.life.map(r=>[r.kind,r.sent/S-p.life[0].sent/S]).filter(([kind])=>kind!=='rulings'),[['token',0],['index',L],['row',2*L],['score',3*L]],'one phase after another, the token first');
      const from=p.seen.length,sent=p.life.length;
      await p.clock.advance(6*PERIOD);
      const done=p.settled(from);
      assert(done.length>=2,`completed refreshes after boot: ${done.length}, want at least 2`);
      for(const d of done)assert.equal(d.sync,'LIVE · data 0s old');
      assert.deepEqual(p.aborted(0),[],'nothing is abandoned, at boot or after');
      assert.equal(p.life.slice(sent).filter(r=>r.kind==='token').length,0,'the token is not fetched again');
    }));
  }

  assert.equal(failures.length,0,`HDC-15 Pick'em slow-network regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('weekly HDC-15 slow-network regressions passed: slow refreshes complete, hung feeds fail at their limits, no refresh is replaced within its bounded lifetime');

// Shareable cards. share-ui.js asks the page for the Pick'em standings with a poolcenter:share event, and weekly-app.js answers
// at once with what render() shows and the state behind it. The card made from that answer (share-card.js) claims the
// header's state (a slate whose games are all final is FINAL), and a shared link boots the same week in the Standings view.
{
  const {buildCard,FRESH_SECONDS}=await import('./share-card.js');
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const ask=(v,contest='pickem')=>{const detail={contest,snapshot:null};v.doc.dispatchEvent({type:'poolcenter:share',detail});return detail.snapshot};
  const card=v=>buildCard('pickem',ask(v),{now:Date.now(),href:'https://example.test/nfl-pool/?view=standings'});
  const header=v=>v.$('sync').textContent.split(' · ')[0];
  const table=v=>[...v.$('standings').innerHTML.matchAll(/<td>(\d+)<\/td><td class="entry">([^<]+)<\/td><td class="c"><span class="standing-overall">([^<]+)<\/span>.*?<\/td><td class="c w">(\d+)<\/td><td class="c l">(\d+)<\/td><td class="c">(\d+)<\/td>/g)]
    .map(m=>({groupRank:Number(m[1]),name:m[2],overall:m[3],w:Number(m[4]),l:Number(m[5]),left:Number(m[6])}));
  const fieldWeek={schemaVersion:1,season:2026,week:3,tiebreakGameIndex:0,fullFieldReady:true,fullFieldValidationVersion:3,competitionSize:4,fullFieldEntryCount:2,
    games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-27'},{away:'MIA',home:'BUF',awayNumber:3,homeNumber:4,date:'2026-09-27'}],
    participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1,3],tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2,4],tiebreak:44}],
    fieldEntries:[{id:'field-001',pickNumbers:[0,0],tiebreak:42},{id:'field-002',pickNumbers:[1,4],tiebreak:null}]};
  const fieldScores={events:[game(),game({away:'MIA',home:'BUF',awayScore:'10',homeScore:'20'})]};
  const twoWeeks=()=>[{season:2026,week:3,status:'locked',revision:1,config:structuredClone(config)},{season:2026,week:4,status:'locked',revision:2,config:{...structuredClone(config),week:4}}];

  await regression('the snapshot is the standings render() shows: the same rows in the same order, records, group ranks and game counts',async()=>{
    const v=await view(),s=ask(v);
    assert.equal(s.ready,true);
    assert.deepEqual([s.contest,s.season,s.week,s.revision,s.fieldSize],['pickem',2026,3,1,null]);
    assert.deepEqual(s.games,{total:1,final:1,void:0,live:0,remaining:0});
    assert.deepEqual(table(v),s.entries.map(e=>({groupRank:e.groupRank,name:e.name,overall:'—',w:e.w,l:e.l,left:e.left})));
    assert.deepEqual(s.entries.map(e=>[e.name,e.w,e.l,e.leader,e.field]),[['D.C.',1,0,true,null],['DJS',0,1,false,null]]);
    assert.deepEqual([s.feed.failed,s.feed.incomplete,s.feed.review,s.hold,s.rulingsStale,s.publishedStale],[false,false,false,false,false,false]);
    assert.equal(header(v),'LIVE');
    assert.equal(card(v).status.label,'FINAL','the one game is final: the header says LIVE, the card FINAL');
  });
  await regression('full-field ranks are the ones the standings show, and no field entry, pick or id leaves the page',async()=>{
    const v=await view({weekConfig:fieldWeek,initialScorePayload:fieldScores}),s=ask(v);
    assert.equal(s.fieldSize,4);
    assert.deepEqual(table(v).map(r=>r.overall),s.entries.map(e=>e.field.label));
    assert.deepEqual(s.entries.map(e=>[e.name,e.w,e.l,e.groupRank,e.field.label,e.tiebreakDelta]),[['D.C.',1,1,1,'#2',0],['DJS',1,1,2,'#3',3]],'the final tiebreak orders the two 1–1 entries');
    assert(!/field-00|pickNumbers|"picks"|"id"|"mnf"/.test(JSON.stringify(s)),'the snapshot carries no field entry, pick or id');
    const c=card(v);assert.equal(c.ok,true);assert.deepEqual(c.rows.map(r=>[r.overall,r.overallOf,r.tiebreak]),[['#2','of 4','Tiebreak Δ 0'],['#3','of 4','Tiebreak Δ 3']]);
  });
  await regression('nothing is shared before the week on screen has scores from the feed',async()=>{
    let release;
    const v=await view({bootHooks:{score:()=>new Promise(resolve=>{release=resolve})}});
    assert.deepEqual(ask(v),{ready:false,reason:'Scores for this week are still loading.'});
    v.hooks.score=undefined;release({ok:true,status:200,json:async()=>structuredClone({events:[game()]})});await flush();
    assert.equal(ask(v).ready,true);
  });
  await regression('a failed refresh keeps the last good scores, and the card says FEED UNAVAILABLE as the header does',async()=>{
    const v=await view(),before=ask(v);
    v.setFailure(true);await v.refresh();
    const s=ask(v);
    assert.match(v.$('sync').textContent,/^FEED UNAVAILABLE/);
    assert.deepEqual([s.ready,s.feed.failed,s.feed.fetchedAt],[true,true,before.feed.fetchedAt]);
    assert.deepEqual(s.entries,before.entries);
    assert.equal(card(v).status.label,'FEED UNAVAILABLE');
    v.setFailure(false);await v.refresh();
    assert.equal(ask(v).feed.failed,false);assert.equal(card(v).status.label,'FINAL');
  });
  await regression('ON HOLD and PUBLISHED DATA STALE reach the card as the header shows them',async()=>{
    // The page logs the refused rules and rulings with console.warn; keep that expected warning out of the test output.
    const warn=console.warn;console.warn=()=>{};
    let held;try{held=await view({store:pickemStore({nfl_contests:503})})}finally{console.warn=warn}
    assert.equal(header(held),'ON HOLD');assert.equal(ask(held).hold,true);assert.equal(card(held).status.label,'ON HOLD');
    assert.deepEqual(ask(held).games,{total:1,final:0,void:0,live:0,remaining:1},'nothing is graded while the rulings are on hold');
    const v=await view();
    v.hooks.index=()=>({ok:false,status:503,json:async()=>({})});await v.refresh();
    assert.equal(header(v),'PUBLISHED DATA STALE');assert.equal(ask(v).publishedStale,true);
    assert.equal(card(v).status.label,'PUBLISHED DATA STALE','a stale publication is never FINAL or LIVE');
  });
  await regression('while another week loads, and until it has its own scores, nothing is shared; then the card is that week',async()=>{
    const v=await view({published:twoWeeks(),search:'?view=standings&season=2026&week=3'});
    assert.equal(ask(v).week,3);
    let releaseRow,releaseScore;
    v.hooks.row=u=>new Promise(resolve=>{releaseRow=()=>resolve(publicationApi(v.pub,u))});
    const select=v.$('weekSelect');select.value='2026-4';for(const fn of select.listeners.change||[])fn();await flush();
    assert.deepEqual(ask(v),{ready:false,reason:'Another week is loading. Share again once it is on screen.'});
    v.hooks.row=undefined;v.hooks.score=()=>new Promise(resolve=>{releaseScore=resolve});
    releaseRow();await flush();
    assert.match(v.$('weekLine').textContent,/^Week 4 · revision 2 · /);
    assert.deepEqual(ask(v),{ready:false,reason:'Scores for this week are still loading.'},'week 4 is on screen but its scores have not arrived: week 3 scores are never shared with it');
    v.hooks.score=undefined;releaseScore({ok:true,status:200,json:async()=>structuredClone({events:[game({week:4})]})});await flush();
    const s=ask(v);assert.deepEqual([s.ready,s.week,s.revision],[true,4,2]);
  });
  await regression("a shared link boots the same published week in the Standings view, even with a later week published",async()=>{
    const v=await view({published:twoWeeks(),search:'?view=standings&season=2026&week=3'});
    assert.equal(v.doc.body.dataset.view,'standings');assert.match(v.$('weekLine').textContent,/^Week 3 · revision 1 · /);
    const link=new URL(card(v).link);
    assert.deepEqual([link.pathname,link.searchParams.get('view'),link.searchParams.get('season'),link.searchParams.get('week')],['/nfl-pool/','standings','2026','3']);
    const opened=await view({published:twoWeeks(),search:link.search});
    assert.equal(opened.doc.body.dataset.view,'standings');assert.match(opened.$('weekLine').textContent,/^Week 3 · revision 1 · /);
    assert.equal(ask(opened).week,3);
  });
  await regression('a page that has not refreshed for longer than the freshness limit shares DELAYED, never LIVE or FINAL',async()=>{
    const v=await view(),later=Date.now()+(FRESH_SECONDS+5)*1000;
    const late=buildCard('pickem',ask(v),{now:later,href:'https://example.test/nfl-pool/?view=standings'});
    assert.equal(late.status.label,'DELAYED');assert.match(late.status.detail,/^Scores as of /);
  });
  await regression('weekly-app.js answers only a Pick’em share request',async()=>{
    const v=await view();
    assert.equal(ask(v,'survivor'),null);assert.equal(ask(v,'games'),null);
  });

  assert.equal(failures.length,0,`share-card Pick'em regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('weekly share-card regressions passed: the share snapshot is the rendered standings, never before its own scores, never across a week switch, with the header state, and shared links boot the same week');

// Home dashboard (home-dashboard.js). Every change of view is announced (poolcenter:viewchange, with the view and the one
// before) while Pick'em itself still refreshes only when it takes the page back from Survivor (HDC-15); each refresh, a failed
// one, a publication found stale or verified again, a chosen week installed and a boot failure announce poolcenter:update for
// Pick'em, carrying no data; and the share snapshot also carries the group race render() computed and the game Game Watch
// leads with, public values only, so the dashboard's summaries are the page's own numbers.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const ask=v=>{const detail={contest:'pickem',snapshot:null};v.doc.dispatchEvent({type:'poolcenter:share',detail});return detail.snapshot};
  const tally=(v,from=0)=>{const t={token:0,index:0,row:0,rulings:0,score:0};for(const c of v.calls.slice(from))t[c.kind]++;return t};
  const NONE={token:0,index:0,row:0,rulings:0,score:0},FULL={token:0,index:1,row:0,rulings:3,score:1};
  const twoWeeks=()=>[{season:2026,week:3,status:'locked',revision:1,config:structuredClone(config)},{season:2026,week:4,status:'locked',revision:2,config:{...structuredClone(config),week:4}}];
  const quiet=async fn=>{const error=console.error,warn=console.warn;console.error=()=>{};console.warn=()=>{};try{return await fn()}finally{console.error=error;console.warn=warn}};

  await regression('every change of view is announced with the view and the one before, never the same view again; Pick’em refreshes only when it takes the page back from Survivor',async()=>{
    const v=await view();v.doc.visibilityState='visible';
    const seen=[];v.doc.addEventListener('poolcenter:viewchange',e=>seen.push([e.detail.previous,e.detail.view]));
    let from=v.calls.length;v.click('standings');v.click('standings');v.click('games');v.click('home');await flush();
    assert.deepEqual(seen,[['home','standings'],['standings','games'],['games','home']]);
    assert.deepEqual(tally(v,from),NONE,'no Pick’em refresh between Pick’em views');
    seen.length=0;from=v.calls.length;v.click('survivor');await flush();
    assert.deepEqual(seen,[['home','survivor']]);assert.deepEqual(tally(v,from),NONE,'entering Survivor is Survivor’s refresh, not Pick’em’s');
    assert.equal(v.$('sync').textContent,"PICK'EM PAUSED · refreshes on return");
    seen.length=0;from=v.calls.length;v.click('picks');await flush();
    assert.deepEqual(seen,[['survivor','picks']]);assert.deepEqual(tally(v,from),FULL,'leaving Survivor: one full Pick’em refresh');
    assert.match(v.$('sync').textContent,/^LIVE · /);
  });
  await regression('each refresh, a failed refresh, a publication found stale or verified again, a chosen week installed and a boot failure announce poolcenter:update for Pick’em, carrying no data',async()=>{
    const v=await view({published:twoWeeks(),search:'?view=home&season=2026&week=3'});
    const seen=[];v.doc.addEventListener('poolcenter:update',e=>seen.push(e.detail));
    await v.refresh();
    assert(seen.length>=1,'a refresh announces');assert(seen.every(d=>JSON.stringify(d)==='{"contest":"pickem"}'),`the contest only: ${JSON.stringify(seen)}`);
    let n=seen.length;v.setFailure(true);await v.refresh();
    assert(seen.length>n,'a failed refresh announces');assert.equal(ask(v).feed.failed,true);assert.match(v.$('sync').textContent,/^FEED UNAVAILABLE/);
    n=seen.length;v.setFailure(false);v.hooks.index=()=>({ok:false,status:503,json:async()=>({})});await quiet(()=>v.refresh());
    assert(seen.length>n,'a stale publication announces');assert.equal(ask(v).publishedStale,true);
    n=seen.length;v.hooks.index=undefined;await v.refresh();
    assert(seen.length>n,'verified again announces');assert.equal(ask(v).publishedStale,false);
    n=seen.length;const select=v.$('weekSelect');select.value='2026-4';for(const fn of select.listeners.change||[])fn();await flush();
    assert(seen.length>n,'a chosen week announces');assert.deepEqual([ask(v).week,ask(v).revision],[4,2]);
    let release;
    const failing=await view({published:[],bootHooks:{index:()=>new Promise(resolve=>{release=resolve})}});
    const events=[];failing.doc.addEventListener('poolcenter:update',e=>events.push(e.detail.contest));
    await quiet(async()=>{release({ok:true,status:200,json:async()=>[]});await flush()});
    assert.deepEqual(events,['pickem'],'a boot failure announces');
    assert.equal(failing.$('sync').textContent,'CONFIG UNAVAILABLE');
    assert.deepEqual(ask(failing),{ready:false,reason:"Pick'em standings have not loaded yet."});
  });
  await regression('the share snapshot carries the group race render() shows (each tracked entry’s status and note, as the Group Scenarios rows read) and the game Game Watch leads with, public values only',async()=>{
    const v=await view(),s=ask(v);
    assert.deepEqual(s.race,{outcomes:1,racePaths:1,items:[{name:'D.C.',status:'WINNER',note:'Pool winner'},{name:'DJS',status:'OUT',note:'Slate complete'}]});
    for(const x of s.race.items)assert(v.$('raceList').innerHTML.includes(`<div class="race-name">${x.name}</div><div class="race-sub">${x.note}</div></div><span class="status-pill ${x.status.toLowerCase()}">${x.status}</span>`),`${x.name} reads the same in Group Scenarios`);
    assert.deepEqual(s.spotlight,{away:'DEN',home:'KC',status:'FINAL',live:false,final:true,awayScore:24,homeScore:17});
    assert.match(v.$('homeGamePreview').innerHTML,/^<div class="game final">/);
    const kickoff=game({awayScore:'0',homeScore:'0'});kickoff.status={type:{state:'pre',completed:false,shortDetail:'Sun 4:25 PM'}};
    v.setPayload({events:[kickoff]});await v.refresh();
    const pre=ask(v);
    assert.deepEqual(pre.spotlight,{away:'DEN',home:'KC',status:'Sun 4:25 PM',live:false,final:false,awayScore:null,homeScore:null},'before kickoff: no scores');
    assert.deepEqual(pre.race.items.map(x=>[x.name,x.status,x.note]),[['D.C.','ALIVE','Ceiling 1 wins'],['DJS','ALIVE','Ceiling 1 wins']]);
    assert.deepEqual([pre.race.outcomes,pre.race.racePaths],[3,3]);
    const live=game({awayScore:'3',homeScore:'7'});live.status={type:{state:'in',completed:false,shortDetail:'2nd 5:12'}};
    v.setPayload({events:[live]});await v.refresh();
    assert.deepEqual(ask(v).spotlight,{away:'DEN',home:'KC',status:'2nd 5:12',live:true,final:false,awayScore:3,homeScore:7},'a live game leads with its score');
    assert.match(v.$('homeGamePreview').innerHTML,/^<div class="game live">/);
    assert(!/"picks"|pickNumbers|"id"|"mnf"|field-/.test(JSON.stringify(ask(v))),'public values only');
    let release;
    const loading=await view({bootHooks:{score:()=>new Promise(resolve=>{release=resolve})}});
    assert.deepEqual(ask(loading),{ready:false,reason:'Scores for this week are still loading.'},'nothing, not even the race, before the week has scores');
    loading.hooks.score=undefined;release({ok:true,status:200,json:async()=>structuredClone({events:[game()]})});await flush();
    assert.equal(ask(loading).race.items.length,2);
  });
  await regression('the snapshot a Pick’em view other than Home answers is the same snapshot: the dashboard reads nothing the page does not show',async()=>{
    const v=await view();const home=ask(v);
    v.click('standings');await flush();
    const standings=ask(v);
    assert.deepEqual(standings,{...home,feed:standings.feed},'the same rows, race and spotlight');
  });

  assert.equal(failures.length,0,`Home dashboard Pick'em regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('weekly Home dashboard regressions passed: every view change announced, Pick’em refresh ownership unchanged, update announcements, and the race and spotlight in the snapshot');

// ---- V1.3 mobile UX (picks-mobile.js) regressions: the Picks snapshot and the Rules & rulings model the page answers with
// (poolcenter:picks and poolcenter:rules). Every grade, status, score and share in the snapshot is the comparison table's own.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const picks=v=>{const detail={contest:'pickem',snapshot:null};v.doc.dispatchEvent({type:'poolcenter:picks',detail});return detail.snapshot};
  const rulesOf=v=>{const detail={contest:'pickem',snapshot:null};v.doc.dispatchEvent({type:'poolcenter:rules',detail});return detail.snapshot};
  const cells=v=>[...v.$('pickBody').innerHTML.matchAll(/<td class="c ([a-z]+)">/g)].map(m=>m[1]);
  const CELL={correct:'ok',incorrect:'bad',tie:'bad',pending:'pending',void:'void',hold:'hold'};
  const cfg=(o={})=>({schemaVersion:1,season:2026,week:3,tiebreakGameIndex:3,
    games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-24'},{away:'MIA',home:'BUF',awayNumber:3,homeNumber:4,date:'2026-09-27'},{away:'NYJ',home:'NE',awayNumber:5,homeNumber:6,date:'2026-09-27'},{away:'WAS',home:'PHI',awayNumber:7,homeNumber:8,date:'2026-09-27'}],
    participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1,4,5,8],tiebreak:41},{id:'jc',displayName:'JC',pickNumbers:[2,3,6,7],tiebreak:45},{id:'djs',displayName:'DJS',pickNumbers:[1,3,5,7],tiebreak:44},{id:'thaddeus',displayName:'Thaddeus',pickNumbers:[null,null,null,null],tiebreak:null}],...o});
  const at=(event,date)=>({...event,date});
  const live=(o,detail)=>({...game(o),status:{type:{state:'in',completed:false,shortDetail:detail}}});
  const scheduled=(o,detail)=>({...game({...o,awayScore:'0',homeScore:'0'}),status:{type:{state:'pre',completed:false,shortDetail:detail}}});
  const canceled=(away,home,id)=>({id,season:{year:2026,type:2},week:{number:3},status:{type:{state:'post',completed:false,name:'STATUS_CANCELED',shortDetail:'Canceled'}},competitions:[{status:{type:{state:'post',completed:false,name:'STATUS_CANCELED'}},competitors:[{homeAway:'away',team:{abbreviation:away},score:'0'},{homeAway:'home',team:{abbreviation:home},score:'0'}]}]});
  const slate=()=>[at(game({away:'DEN',home:'KC',awayScore:'24',homeScore:'17'}),'2026-09-25T00:15Z'),at(game({away:'MIA',home:'BUF',awayScore:'20',homeScore:'20'}),'2026-09-27T17:00Z'),at(live({away:'NYJ',home:'NE',awayScore:'10',homeScore:'7'},'3rd 7:41'),'2026-09-27T17:00Z'),at(scheduled({away:'WAS',home:'PHI'},'Sun 4:25 PM'),'2026-09-27T20:25Z')];
  const canceledSlate=()=>{const s=slate();s[1]=at(canceled('MIA','BUF','401437947'),'2026-09-27T17:00Z');return s};
  const voidRow=(o={})=>({ruling_id:1,contest_id:PK_CONTEST,contest_type:'pickem',week:3,away_team:'MIA',home_team:'BUF',policy_revision:1,chain_seq:1,parent_ruling_id:null,consequence:'void',incident_status:'STATUS_CANCELED',event_id:'401437947',evidence_source:'espn-scoreboard',public_note:'League canceled the game; voided for this contest.',created_at:'2026-10-08T12:00:00+00:00',...PRIVATE,...o});
  await regression('the Picks snapshot is exactly what the table shows: every game in published order with its teams, kickoff, date, status, verified scores and every tracked entry’s pick graded as the table grades it; a no-submission entry is NO PICK; a tie is one loss; public values only',async()=>{
    const v=await view({weekConfig:cfg(),initialScorePayload:{events:slate()},search:'?view=picks'});
    const s=picks(v);
    assert.equal(s.ready,true);assert.deepEqual([s.contest,s.season,s.week,s.revision,s.fieldSize,s.tiebreakIndex],['pickem',2026,3,1,null,3]);
    assert.deepEqual(s.entrants,[{name:'D.C.',noSubmission:false},{name:'JC',noSubmission:false},{name:'DJS',noSubmission:false},{name:'Thaddeus',noSubmission:true}]);
    assert.deepEqual(s.games.map(g=>[g.index,g.away.code,g.home.code,g.kickoff,g.date,g.kind,g.status,g.detail,g.awayScore,g.homeScore,g.winner,g.tiebreak]),[
      [0,'DEN','KC','2026-09-25T00:15Z','2026-09-24','final','FINAL','Final',24,17,'DEN',false],
      [1,'MIA','BUF','2026-09-27T17:00Z','2026-09-27','tie','FINAL TIE','Final',20,20,null,false],
      [2,'NYJ','NE','2026-09-27T17:00Z','2026-09-27','live','3rd 7:41','3rd 7:41',10,7,null,false],
      [3,'WAS','PHI','2026-09-27T20:25Z','2026-09-27','upcoming','Sun 4:25 PM','Sun 4:25 PM',null,null,null,true]]);
    assert.deepEqual(s.games[0].away,{code:'DEN',color:'#FB4F14',logo:'https://a.espncdn.com/i/teamlogos/nfl/500/den.png'});
    assert.deepEqual(s.games[0].picks,[{name:'D.C.',team:'DEN',result:'correct'},{name:'JC',team:'KC',result:'incorrect'},{name:'DJS',team:'DEN',result:'correct'},{name:'Thaddeus',team:null,result:'incorrect'}]);
    assert.deepEqual(s.games[1].picks.map(p=>p.result),['tie','tie','tie','tie'],'an NFL tie is one loss for every pick, NO PICK included');
    assert.deepEqual(s.games[2].picks.map(p=>p.result),['pending','pending','pending','pending']);
    assert.deepEqual(s.games.map(g=>[g.void,g.hold,g.underReview,g.issue,g.ownership,g.note]),Array(4).fill([false,null,null,null,null,null]));
    // The table's cells, row by row, are the snapshot's grades: nothing is graded twice.
    assert.deepEqual(cells(v),s.entrants.flatMap((_,pi)=>s.games.map(g=>CELL[g.picks[pi].result])));
    assert.deepEqual(cells(v),['ok','bad','pending','pending','bad','bad','pending','pending','ok','bad','pending','pending','bad','bad','pending','pending']);
    assert(!/pickNumbers|"id":|field-|"mnf"/.test(JSON.stringify(s)),'public values only');
    const other={contest:'survivor',snapshot:null};v.doc.dispatchEvent({type:'poolcenter:picks',detail:other});assert.equal(other.snapshot,null,'Survivor is not answered here');
  });
  await regression('a kickoff is the verified event’s own timestamp, kept when a later feed omits or garbles it and moved with a rescheduled game; a feed warning on a game rides on its card; nothing is graded from the kickoff',async()=>{
    const v=await view({weekConfig:cfg(),initialScorePayload:{events:slate()},search:'?view=picks'});
    const kickoffs=['2026-09-25T00:15Z','2026-09-27T17:00Z','2026-09-27T17:00Z','2026-09-27T20:25Z'];
    v.setPayload({events:slate().map(e=>{const {date,...rest}=e;return rest})});await v.refresh();
    assert.deepEqual(picks(v).games.map(g=>g.kickoff),kickoffs,'kept without a date');
    v.setPayload({events:slate().map(e=>({...e,date:'not a time'}))});await v.refresh();
    assert.deepEqual(picks(v).games.map(g=>g.kickoff),kickoffs,'an unreadable time is ignored');
    const moved=slate();moved[3]=at(scheduled({away:'WAS',home:'PHI'},'Mon 7:00 PM'),'2026-09-28T23:00Z');
    v.setPayload({events:moved});await v.refresh();
    assert.equal(picks(v).games[3].kickoff,'2026-09-28T23:00Z','a rescheduled game moves with the feed');
    const contradictory=slate();contradictory[2]={...game({away:'NYJ',home:'NE',awayScore:'27',homeScore:'24'}),date:'2026-09-27T17:00Z',status:{type:{state:'in',completed:true,shortDetail:'Final'}}};
    v.setPayload({events:contradictory});await v.refresh();
    const s=picks(v);
    assert.deepEqual([s.games[2].kind,s.games[2].awayScore,s.games[2].homeScore],['live',10,7],'the contradictory final is not graded: the last verified live fact stands');
    assert.equal(s.games[2].issue,'NYJ-NE: final with contradictory status ignored');
    assert.match(v.warning(),/NYJ-NE: final with contradictory status ignored/,'the same warning the page reports');
    assert.deepEqual(s.games.map(g=>g.issue!==null),[false,false,true,false]);
  });
  await regression('VOID, HOLD and UNDER REVIEW are the table’s own ruling states: a void game scores nothing and carries no feed warning, a held game is not graded and says why, a void the feed now contradicts stays applied and is under review',async()=>{
    const v=await view({weekConfig:cfg(),initialScorePayload:{events:canceledSlate()},store:pickemStore({nfl_incident_rulings:[voidRow()]}),search:'?view=picks'});
    let g=picks(v).games[1];
    assert.deepEqual([g.kind,g.status,g.note,g.void,g.hold,g.underReview,g.issue,g.awayScore,g.homeScore],['void','VOID · Commissioner ruling','Commissioner ruling',true,null,null,null,null,null]);
    assert.deepEqual(g.picks.map(p=>p.result),['void','void','void','void']);
    assert.deepEqual(cells(v).filter((_,i)=>i%4===1),['void','void','void','void'],'the table shows VOID in the same column');
    v.setPayload({events:slate().map((e,i)=>i===1?{...game({away:'MIA',home:'BUF',id:'401437947',awayScore:'20',homeScore:'17'}),date:'2026-09-27T17:00Z'}:e)});await v.refresh();
    g=picks(v).games[1];
    assert.deepEqual([g.kind,g.status,g.note,g.awayScore,g.homeScore,g.winner],['void','VOID · Commissioner ruling · UNDER REVIEW','Commissioner ruling · UNDER REVIEW',20,17,null],'still void, never graded; the NFL scores are shown as the Games grid shows them');
    assert.match(g.underReview,/the feed now reports a completed final/);
    assert.deepEqual(g.picks.map(p=>p.result),['void','void','void','void']);
    const held=await view({weekConfig:cfg(),initialScorePayload:{events:canceledSlate()},store:pickemStore({nfl_incident_rulings:[voidRow(),voidRow({ruling_id:2,chain_seq:2,parent_ruling_id:42})]}),search:'?view=picks'});
    g=picks(held).games[1];
    assert.deepEqual([g.kind,g.status,g.note,g.void],['hold','HOLD · Ruling information unusable','Ruling information unusable',false]);
    assert.match(g.hold,/chain position 2 names a predecessor that does not exist/);
    assert.match(g.issue,/^MIA-BUF: game halted \(STATUS_CANCELED\), not graded/,'the halted-game warning stays while no ruling applies');
    assert.deepEqual(g.picks.map(p=>p.result),['hold','hold','hold','hold']);
    assert.deepEqual(cells(held).filter((_,i)=>i%4===1),['hold','hold','hold','hold']);
  });
  await regression('full-field ownership is the table header’s own share of valid field picks, present only when the field is published, and no field entry reaches the snapshot',async()=>{
    const field=cfg({fullFieldReady:true,competitionSize:7,fieldEntries:[{id:'f1',pickNumbers:[1,4,5,8],tiebreak:40},{id:'f2',pickNumbers:[2,4,6,8],tiebreak:50},{id:'f3',pickNumbers:[1,3,5,7],tiebreak:30}]});
    const v=await view({weekConfig:field,initialScorePayload:{events:slate()},search:'?view=picks'});
    const s=picks(v);
    assert.equal(s.fieldSize,7);
    assert.deepEqual(s.games[0].ownership,{away:{pct:67,count:4,total:6},home:{pct:33,count:2,total:6}},'DEN: 4 of the 6 valid picks (Thaddeus has none)');
    assert.deepEqual(s.games[1].ownership,{away:{pct:50,count:3,total:6},home:{pct:50,count:3,total:6}},'MIA: JC, DJS and one field entry; BUF: D.C. and two field entries');
    assert.match(v.$('pickHead').innerHTML,/DEN<\/span><span class="matchup-slash">\/<\/span><span class="matchup-team">[^<]*<span class="badge tiny"[\s\S]*?KC<\/span><div class="matchup-ownership"><span>67%<\/span><span>33%<\/span><\/div>/,'the same numbers the table header shows');
    assert(!/"f1"|"f2"|"f3"|pickNumbers/.test(JSON.stringify(s)),'no field entry reaches the snapshot');
  });
  await regression('nothing is answered before a week is on screen or while a chosen week loads; a switched week answers its own games and names',async()=>{
    const week4=cfg({week:4,tiebreakGameIndex:0,games:[{away:'GB',home:'MIN',awayNumber:1,homeNumber:2,date:'2026-10-04'}],participants:cfg().participants.map(p=>({...p,pickNumbers:p.pickNumbers[0]===null?[null]:[p.pickNumbers[0]===1?1:2]}))});
    const published=[{season:2026,week:3,status:'locked',revision:1,config:cfg()},{season:2026,week:4,status:'locked',revision:1,config:week4}];
    let release;
    const loading=await view({published,search:'?view=picks&season=2026&week=3',bootHooks:{row:()=>new Promise(resolve=>{release=resolve})}});
    assert.deepEqual(picks(loading),{ready:false,reason:"Pick'em picks have not loaded yet."});
    assert.deepEqual(rulesOf(loading),{ready:false,reason:'Loading contest rules and rulings…'});
    loading.hooks.row=undefined;release({ok:true,status:200,json:async()=>[published[0]]});await flush();
    assert.equal(picks(loading).ready,true);
    const v=await view({published,initialScorePayload:{events:slate()},search:'?view=picks&season=2026&week=3'});
    assert.equal(picks(v).week,3);
    v.hooks.row=()=>new Promise(()=>{});
    const select=v.$('weekSelect');select.value='2026-4';for(const fn of select.listeners.change||[])fn();await flush();
    assert.deepEqual(picks(v),{ready:false,reason:'Another week is loading. The picks follow once it is on screen.'});
    assert.deepEqual(rulesOf(v),{ready:false,reason:'Another week is loading. The rules and rulings follow once it is on screen.'});
    v.hooks.row=undefined;v.setPayload({events:[at(game({week:4,away:'GB',home:'MIN',awayScore:'3',homeScore:'30'}),'2026-10-04T17:00Z')]});
    select.value='2026-4';for(const fn of select.listeners.change||[])fn();await flush();
    const s=picks(v);
    assert.deepEqual([s.ready,s.week,s.games.length,s.games[0].away.code,s.games[0].kickoff,s.games[0].kind,s.games[0].winner],[true,4,1,'GB','2026-10-04T17:00Z','final','MIN']);
    assert.deepEqual(s.games[0].picks.map(p=>[p.name,p.team,p.result]),[['D.C.','GB','incorrect'],['JC','MIN','correct'],['DJS','GB','incorrect'],['Thaddeus',null,'incorrect']]);
  });
  await regression('the Rules & rulings model the card is rendered from is answered to poolcenter:rules: ready with the contest’s policy and this week’s rulings, stale when a refresh fails, ON HOLD when the store cannot be read, inactive before 2026',async()=>{
    const v=await view({weekConfig:cfg(),initialScorePayload:{events:canceledSlate()},store:pickemStore({nfl_incident_rulings:[voidRow()]}),search:'?view=games'});
    let r=rulesOf(v);
    assert.deepEqual([r.ready,r.contest,r.week,r.model.state,r.model.contestType,r.model.contestName,r.model.policy.name,r.model.policy.revision,r.model.stale],[true,'pickem',3,'ready',"Pick'em contest","Pool Center 2026 Pick'em",'Void',1,null]);
    assert.deepEqual(r.model.incidents.map(x=>[x.week,x.matchup,x.status]),[[3,'MIA @ BUF','APPLIED']]);
    assert(v.$('pickemRules').innerHTML.includes('Pool Center 2026 Pick&#39;em')&&v.$('pickemRules').innerHTML.includes('>APPLIED<'),'the card is rendered from the same model');
    v.store.nfl_incident_rulings=503;await v.refresh();
    r=rulesOf(v);
    assert.equal(r.model.state,'ready');assert.match(r.model.stale,/could not be refreshed/);assert.deepEqual(r.model.incidents.map(x=>x.status),['APPLIED'],'the rulings last verified still apply, marked stale');
    const held=await view({weekConfig:cfg(),initialScorePayload:{events:slate()},store:pickemStore({nfl_incident_rulings:503}),search:'?view=games'});
    assert.deepEqual([rulesOf(held).model.state,rulesOf(held).model.heading],['hold','ON HOLD · Ruling data unavailable']);
    const old=await view({weekConfig:cfg({season:2025}),initialScorePayload:{events:slate().map(e=>({...e,season:{year:2025,type:2}}))},published:[{season:2025,week:3,status:'locked',revision:1,config:cfg({season:2025})}],search:'?view=games'});
    assert.equal(rulesOf(old).model.state,'inactive');
    const other={contest:'survivor',snapshot:null};v.doc.dispatchEvent({type:'poolcenter:rules',detail:other});assert.equal(other.snapshot,null,'Survivor is not answered here');
  });

  assert.equal(failures.length,0,`V1.3 mobile UX Pick'em regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('weekly V1.3 mobile UX regressions passed: the Picks snapshot is the table’s own grading, kickoffs ride with verified events, VOID/HOLD/UNDER REVIEW and ownership agree with the page, nothing is answered while a week loads, and the rules model is the card’s own');
