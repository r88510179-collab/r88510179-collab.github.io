import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectScoreboard} from './score-proxy/index.mjs';
import {survivorBuildResults} from './survivor-math.js';

const appSource=readFileSync(new URL('./weekly-app.js',import.meta.url),'utf8');
// HDC-12: the page imports the contest-ruling evaluator; where it does, point that import at the module's file URL so the
// page still loads from a data: URL. Before HDC-12 there is no such import and the source is used as it is.
const rulingsFrom=appSource.match(/from '\.\/contest-rulings\.js\?v=\d+';/)?.[0]??null;
const source=rulingsFrom?appSource.replace(rulingsFrom,`from '${new URL(rulingsFrom.slice("from '".length,-"';".length),import.meta.url).href}';`):appSource;
const from="from './public-math.js?v=2';";
assert(source.includes(from),'harness expects the public-math import');
assert(source.includes("if(ctl)ctl.abort()"),'overlapping Pick’em refreshes must abort the older request');
assert(source.includes("if(id!==gen)return"),'late Pick’em responses must be generation-gated');
const patched=source.replace(from,`from '${new URL('./public-math.js?v=2',import.meta.url).href}';`);
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

async function view({weekConfig=config,initialScorePayload={events:[game()]},store=pickemStore()}={}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El());return els.get(id)},docListeners={};
  const doc={
    body:{dataset:{}},title:'',visibilityState:'hidden',
    getElementById:$,querySelectorAll(){return[]},
    createElement(){return new El()},
    addEventListener(t,f){(docListeners[t]||=[]).push(f)}
  };
  const windowListeners={};
  globalThis.document=doc;
  globalThis.window={addEventListener(t,f){(windowListeners[t]||=[]).push(f)},scrollTo(){}};
  globalThis.location={href:'https://example.test/nfl-pool/?view=home',search:'?view=home'};
  globalThis.history={pushState(){},state:null};
  let tick=null,scorePayload=structuredClone(initialScorePayload),scoreFailure=false,scoreCalls=0;const rulingRequests=[];
  globalThis.setInterval=(fn,ms)=>{assert.equal(ms,20000);tick=fn;return 0};
  const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.y';
  globalThis.fetch=async (url,init={})=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/token/anonymous'))return{ok:true,json:async()=>({token})};
    if(u.pathname.endsWith('/nfl_pool_weeks'))return{ok:true,json:async()=>[{season:2026,week:3,status:'locked',revision:1,config:structuredClone(weekConfig)}]};
    const table=Object.keys(RULING_COLUMNS).find(t=>u.pathname.endsWith(`/${t}`));
    if(table){
      rulingRequests.push({table,url:u,authorization:init.headers?.Authorization??null});
      const rows=store[table];
      if(typeof rows==='function')return rows(u,init);
      if(typeof rows==='number')return{ok:false,status:rows,json:async()=>({})};
      return dataApi(table,rows,u);
    }
    scoreCalls++;
    if(scoreFailure)return{ok:false,status:503,json:async()=>({})};
    return{ok:true,status:200,json:async()=>structuredClone(scorePayload)};
  };
  // badge and raceStatus are exported from this test instance only, so their output can be checked directly.
  const mod=await import(`data:text/javascript;base64,${Buffer.from(patched+`\nexport {badge,raceStatus};\n//instance ${++instance}`).toString('base64')}`);
  await flush();
  const warning=()=>$('error').children[0]?.textContent||'';
  return{
    $,warning,mod,store,rulingRequests,token,
    html:()=>[...els.values()].map(e=>`${e.innerHTML}\n${e.textContent}`).join('\n'),
    setPayload:v=>{scorePayload=v},
    setFailure:v=>{scoreFailure=v},
    refresh:async()=>{tick();await flush()},
    resume:async()=>{const before=scoreCalls;doc.visibilityState='visible';for(const fn of docListeners.visibilitychange||[])fn();await flush();return scoreCalls-before}
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
  const expected={DEN:[['D.C.','1','0'],['DJS','0','1']],KC:[['DJS','1','0'],['D.C.','0','1']],tie:[['D.C.','0','0'],['DJS','0','0']]};
  const cells={DEN:['ok','bad'],KC:['bad','ok'],tie:['neutral','neutral']};
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
  const pickem={ok:'DEN',bad:'KC',neutral:'tie',pending:null};
  for(const [label,event,expected] of [...VALID_FINALS,...CONTRADICTORY_FINALS.map(([label,event])=>[label,event,null])]){
    const verdicts={};
    for(const [source,payload] of [['raw',{events:[structuredClone(event)]}],['projected',projectScoreboard({events:[structuredClone(event)]},PROJECTED_AT)]]){
      const v=await view({initialScorePayload:payload}),result=survivorBuildResults(payload.events,{season:2026,week:3}).get('DEN');
      verdicts[`Pick'em ${source}`]=pickem[pickCells(v)[0]];
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

  await regression('the page imports the HDC-12 evaluator',()=>assert.equal(rulingsFrom,"from './contest-rulings.js?v=1';",'weekly-app.js must import contest-rulings.js?v=1'));
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
    assert.deepEqual(records(v),[['D.C.','0','0'],['DJS','0','0']]);
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

  assert.equal(failures.length,0,`HDC-12 Pick'em regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log("weekly HDC-12 contest-ruling load, privacy, void, voided tiebreak, under-review, withdrawn, all-void, hold, fail-closed and Rules & rulings regressions passed");
