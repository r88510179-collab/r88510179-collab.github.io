import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('./weekly-app.js',import.meta.url),'utf8');
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

async function view({weekConfig=config,initialScorePayload={events:[game()]}}={}){
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
  let tick=null,scorePayload=structuredClone(initialScorePayload),scoreFailure=false,scoreCalls=0;
  globalThis.setInterval=(fn,ms)=>{assert.equal(ms,20000);tick=fn;return 0};
  const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.y';
  globalThis.fetch=async (url,init={})=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/token/anonymous'))return{ok:true,json:async()=>({token})};
    if(u.pathname.endsWith('/nfl_pool_weeks'))return{ok:true,json:async()=>[{season:2026,week:3,status:'locked',revision:1,config:structuredClone(weekConfig)}]};
    scoreCalls++;
    if(scoreFailure)return{ok:false,status:503,json:async()=>({})};
    return{ok:true,status:200,json:async()=>structuredClone(scorePayload)};
  };
  // badge and raceStatus are exported from this test instance only, so their output can be checked directly.
  const mod=await import(`data:text/javascript;base64,${Buffer.from(patched+`\nexport {badge,raceStatus};\n//instance ${++instance}`).toString('base64')}`);
  await flush();
  const warning=()=>$('error').children[0]?.textContent||'';
  return{
    $,warning,mod,
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

console.log('weekly public feed-context, malformed-event isolation, fail-safe preservation, foreground-refresh and no-submission race-boundary regressions passed');
