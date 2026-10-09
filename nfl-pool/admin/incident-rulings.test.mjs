// HDC-13 regressions: the commissioner incident-ruling write path, Admin side.
//
// incident-rulings.js (pure: candidate discovery, eligibility, action state, request and preview construction, error-token
// mapping, evidence-source mapping) is tested directly. rulings-admin.js (DOM, network, auth) runs unmodified against a fake
// DOM and a mock Neon client (Data API reads and the RPC); only its CDN import and its module import are rewritten, and the
// real score-feed-proxy.js is wrapped around the mock network, so every score request takes the production nflscores2 path.
// Preview parity boots the unmodified public weekly-app.js and survivor-app.js the way their own suites do and compares
// what they render with what the Admin previewed. Every regression reports through one collector and the suite fails at
// the end if any did; a module that is missing or does not load is an assertion failure, never an import crash.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {projectScoreboard} from '../score-proxy/index.mjs';
import {PUBLIC_COLUMNS,SUPPORTED_INCIDENT_STATUSES} from '../contest-rulings.js?v=1';

const failures=[];
const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
const here=new URL('.',import.meta.url);
const read=rel=>{try{return readFileSync(new URL(rel,here),'utf8')}catch{return null}};
let IR=null,loadError=null;
try{IR=await import(new URL('./incident-rulings.js?v=1',here).href)}catch(error){loadError=error}
const need=()=>{assert(IR,`incident-rulings.js must exist and load (${loadError?.code||loadError?.message||'not loaded'})`);return IR};
const adminSource=read('./rulings-admin.js'),pageHtml=read('./rulings.html'),moduleSource=read('./incident-rulings.js');
const proxySource=read('../score-feed-proxy.js');
const flush=async(n=30)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};

const RPC_ARGUMENTS=['p_contest_id','p_week','p_away_team','p_home_team','p_action','p_consequence','p_expected_policy_revision',
  'p_expected_parent_ruling_id','p_incident_status','p_event_id','p_evidence_source','p_public_note','p_admin_note'];
const FORBIDDEN=['created_by','chain_seq','parent_ruling_id','root_ruling_id','created_at','admin_note','ruling_id'];
const NFLSCORES2='https://br-late-hat-b55ygmj4-nflscores2.compute.c-7.us-east-2.aws.neon.tech';
const ESPN='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const TOKENS=['HDC13_NOT_COMMISSIONER','HDC13_ISOLATION','HDC13_INVALID_INPUT','HDC13_STALE_POLICY','HDC13_STALE_CHAIN',
  'HDC13_INVALID_TRANSITION','HDC13_NOT_PERMITTED','HDC13_NOT_PUBLISHED','HDC13_EVENT_MISMATCH'];
const HDC14=/requires the future exception workflow/;

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures. Contest data is the public columns the Data API returns; feeds are ESPN events reduced by the real nflscores2
// projection (projectScoreboard), exactly what score-feed-proxy.js returns to the pages.
// ---------------------------------------------------------------------------------------------------------------------
const PK='pool-center-2026-pickem',SV='pool-center-2026-survivor',CREATED='2026-10-08T12:00:00+00:00';
const CONTESTS=[
  {contest_id:PK,season:2026,contest_type:'pickem',display_name:"Pool Center 2026 Pick'em",starts_at:'2026-09-10T00:20:00+00:00',created_at:CREATED},
  {contest_id:SV,season:2026,contest_type:'survivor',display_name:'Pool Center 2026 Survivor',starts_at:'2026-09-10T00:20:00+00:00',created_at:CREATED}];
const policyRow=(contest_id,contest_type,halted_game_policy,o={})=>({contest_id,contest_type,revision:1,effective_week:1,halted_game_policy,
  public_note:'Approved policy for this contest.',created_at:CREATED,...o});
const pkPolicies=()=>[policyRow(PK,'pickem','void')];
const svPolicies=(policy='advance_team_used')=>[policyRow(SV,'survivor',policy)];
const chainRows=(contest_id,contest_type,{week,away,home,eventId,status='STATUS_CANCELED',revision=1},consequences,firstId=1)=>consequences.map((consequence,i)=>({
  ruling_id:firstId+i,contest_id,contest_type,week,away_team:away,home_team:home,policy_revision:revision,chain_seq:i+1,parent_ruling_id:i?firstId+i-1:null,
  consequence,incident_status:status,event_id:eventId,evidence_source:'nflscores2',public_note:i?`Chain step ${i+1}.`:'Canceled by the league.',created_at:CREATED}));
const BUFCIN={week:3,away:'BUF',home:'CIN',eventId:'401437947'};
const pkChain=consequences=>chainRows(PK,'pickem',BUFCIN,consequences);
const pkData=(rulings=[],policies=pkPolicies())=>({contests:CONTESTS.filter(c=>c.contest_id===PK),policies,rulings});

// Pick'em Week 3: DEN @ KC (game 1) and BUF @ CIN (game 2), with the schedule event ids admin.js records.
const pkConfig=({tiebreakGameIndex=1,eventIds=true,extraGames=[]}={})=>({schemaVersion:1,season:2026,week:3,tiebreakGameIndex,
  games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-09-27',...(eventIds?{eventId:'401437900'}:{})},
    {away:'BUF',home:'CIN',awayNumber:3,homeNumber:4,date:'2026-09-28',...(eventIds?{eventId:'401437947'}:{})},...extraGames],
  participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1,3],tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2,4],tiebreak:44}]});
const pkWeekRow=(config=pkConfig(),o={})=>({season:2026,week:3,status:'locked',revision:1,config,...o});

const espnType=(name,state,completed=false,detail=name||'Status')=>({...(name===undefined?{}:{name}),state,completed,description:detail,detail,shortDetail:detail});
const espnEvent=({id,away,home,type,as='0',hs='0',week=3})=>({id,date:'2026-09-28T00:15Z',season:{year:2026,type:2},week:{number:week},status:{type:{...type}},
  competitions:[{status:{type:{...type}},competitors:[{homeAway:'home',team:{abbreviation:home},score:hs},{homeAway:'away',team:{abbreviation:away},score:as}]}]});
const bufCin=(name='STATUS_CANCELED',state='post',o={})=>espnEvent({id:'401437947',away:'BUF',home:'CIN',type:espnType(name,state),...o});
const finalGame=(away,home,id,as,hs,week=3)=>espnEvent({id,away,home,as,hs,week,type:{name:'STATUS_FINAL',state:'post',completed:true,detail:'Final',shortDetail:'Final'}});
const denKc=()=>finalGame('DEN','KC','401437900','24','17');
const projected=events=>projectScoreboard({events:structuredClone(events)},'2026-10-08T12:00:00.000Z');
const pkEvents=(...events)=>projected(events.length?events:[denKc(),bufCin()]).events;

// Survivor: the public suite's Week-2 fixture. SF @ ARI (event 401547001) is canceled; D.C. picked SF, survivor-003 ARI.
const W1=[['PIT','CLE'],['LV','NE'],['KC','LAC'],['JAX','CAR'],['ARI','ATL'],['BAL','BUF'],['CHI','CIN'],['DAL','DEN'],['DET','GB'],['HOU','IND'],['LAR','MIA'],['MIN','NO'],['NYG','NYJ'],['PHI','SEA'],['SF','TB'],['TEN','WAS']];
const W2=[['SF','ARI'],['ATL','BAL'],['BUF','CAR'],['CHI','CIN'],['CLE','DAL'],['DEN','DET'],['GB','HOU'],['IND','JAX'],['KC','LV'],['LAC','LAR'],['MIA','MIN'],['NE','NO'],['NYG','NYJ'],['PHI','PIT'],['SEA','TB'],['TEN','WAS']];
const svGame=(a,h,n,{as='24',hs='10',completed=true,state=completed?'post':'pre',name,id=`${n}-${a}`}={})=>({id,week:{number:n},season:{year:2026,type:2},
  status:{type:{completed,state,...(name?{name}:{})}},competitions:[{...(name?{status:{type:{completed,state,name}}}:{}),
  competitors:[{homeAway:'away',team:{abbreviation:a},score:as},{homeAway:'home',team:{abbreviation:h},score:hs}]}]});
const svWeek=(pairs,n,over={})=>({season:{year:2026,type:2},week:{number:n},events:pairs.map(([a,h])=>over[a]?over[a](a,h,n):svGame(a,h,n))});
const svCanceled=(a,h,n)=>svGame(a,h,n,{as:'0',hs:'0',completed:false,state:'post',name:'STATUS_CANCELED',id:'401547001'});
const svFeeds=(sf=svCanceled)=>({1:svWeek(W1,1),2:svWeek(W2,2,{SF:sf})});
const svEventsByWeek=feeds=>[1,2].map(w=>projected(feeds[w].events).events);
const svConfig=()=>({schemaVersion:1,season:2026,week:2,label:'Survivor Week 2',sheetWeeks:18,
  trackedEntries:[{id:'dc',displayName:'D.C.',picks:['PIT','SF']},{id:'djs',displayName:'DJS',picks:['LV','BUF']},{id:'thaddeus',displayName:'Thaddeus',picks:['LAC',null]}],
  fieldEntries:[{id:'survivor-001',picks:['JAX','BUF']},{id:'survivor-002',picks:['CLE',null]},{id:'survivor-003',picks:['JAX','ARI']}],
  competitionSize:6,currentWeekEntryCount:4,source:{kind:'survivor-upload',filename:'w2.pdf'}});
const svSnapshotRow=(config=svConfig())=>({season:2026,week:2,status:'locked',revision:9,config});
const SFARI={week:2,away:'SF',home:'ARI',eventId:'401547001'};
const svData=(rulings=[],policies=svPolicies())=>({contests:CONTESTS.filter(c=>c.contest_id===SV),policies,rulings});

const pkCandidates=({config=pkConfig(),events=pkEvents(),source='nflscores2',data=pkData()}={})=>
  need().pickemCandidates({contestId:PK,season:2026,week:3,config,events,source,data});
const pkCandidate=(o={},key='BUF@CIN')=>{const c=pkCandidates(o).find(x=>x.key===key);assert(c,`candidate ${key} is discovered`);return c};
const svCandidates=({config=svConfig(),week=2,events=svEventsByWeek(svFeeds())[1],source='nflscores2',data=svData()}={})=>
  need().survivorCandidates({contestId:SV,season:2026,week,snapshot:{week:config.week,config},events,source,data});
const svCandidate=(o={},key='SF@ARI')=>{const c=svCandidates(o).find(x=>x.key===key);assert(c,`candidate ${key} is discovered`);return c};
const NOTE='Canceled by the league; void for this contest.',ADMIN_NOTE='Confirmed against the league announcement.';
const requestFor=(c,action,o={})=>{
  const out=need().buildRequest({contestId:o.contestId||(c.contestType==='survivor'?SV:PK),week:c.week,candidate:c,action,consequence:o.consequence??null,
    publicNote:o.publicNote??NOTE,adminNote:o.adminNote??(action==='withdraw'||action==='rerule'?ADMIN_NOTE:null)});
  assert(out.ok,`request builds: ${out.reason}`);return out.request;
};

// ---------------------------------------------------------------------------------------------------------------------
// 1. The module surface and its purity.
// ---------------------------------------------------------------------------------------------------------------------
await regression('incident-rulings.js loads and exports the HDC-13 surface',()=>{
  const m=need();
  for(const name of ['scoreboardUrl','evidenceSourceFor','readFeed','checkPublicNote','checkAdminNote','contestOptions','pickemWeeks','survivorWeeks',
    'pickemGames','chainState','consequenceChoices','pickemCandidates','survivorCandidates','buildRequest','writeProbeRequest','hypotheticalRow',
    'pickemPreview','survivorPreview','previewOutcome','sameOutcome','confirmationPhrase','confirmationMatches','preflightKey','rpcErrorInfo',
    'classifyReadBack','probeOutcome'])assert.equal(typeof m[name],'function',`exports ${name}()`);
  assert.equal(m.RPC_FUNCTION,'nfl_append_incident_ruling');
  assert.deepEqual([...m.RPC_ARGUMENTS],RPC_ARGUMENTS,'the 13 approved arguments, in order');
  assert.deepEqual([...m.ACTIONS],['rule','reaffirm','withdraw','rerule']);
  assert.equal(m.WRITE_PROBE_PARENT,9007199254740991);
  assert.equal(m.PRODUCTION_FEED_SOURCE,'nflscores2');
  assert.deepEqual(Object.keys(m.HDC13_ERROR_TEXT).sort(),[...TOKENS].sort(),'a fixed message for every HDC13 token');
});
await regression('incident-rulings.js is pure and imports only contest-rulings v2 (HDC-14), survivor-math v7 and public-math v2',()=>{
  assert(moduleSource,'incident-rulings.js must exist');
  const imports=[...moduleSource.matchAll(/^\s*import\b[^;]*?from\s*'([^']+)'/gm)].map(m=>m[1]).sort();
  assert.deepEqual(imports,['../contest-rulings.js?v=2','../public-math.js?v=2','../survivor-math.js?v=7']);
  assert.doesNotMatch(moduleSource,/weekly-app|survivor-app|\bdocument\b|\bwindow\b|\bfetch\s*\(|localStorage|sessionStorage|XMLHttpRequest|setInterval|setTimeout|innerHTML/,
    'no DOM, network, storage or timer in the pure module');
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Evidence source and the production feed path.
// ---------------------------------------------------------------------------------------------------------------------
await regression('the Admin requests the ESPN scoreboard URL that score-feed-proxy.js sends through nflscores2, as the public pages do',async()=>{
  const m=need(),url=new URL(m.scoreboardUrl(2026,3));
  assert.equal(`${url.origin}${url.pathname}`,ESPN);
  assert.equal(url.searchParams.get('dates'),'2026');assert.equal(url.searchParams.get('week'),'3');assert.equal(url.searchParams.get('seasontype'),'2');
  assert(proxySource,'score-feed-proxy.js exists');
  const seen=[],win={location:{href:'https://r88510179-collab.github.io/nfl-pool/admin/rulings.html'},fetch:async u=>{seen.push(String(u));return{url:String(u)}}};
  new Function('window',proxySource)(win);
  const response=await win.fetch(m.scoreboardUrl(2026,3),{cache:'no-store'});
  const target=new URL(seen[0]);
  assert.equal(target.origin,NFLSCORES2,'rewritten to the nflscores2 Neon Function');
  assert.equal(target.searchParams.get('season'),'2026');assert.equal(target.searchParams.get('week'),'3');
  assert.equal(m.evidenceSourceFor(response.url),'nflscores2','the response of the production path maps to nflscores2');
});
await regression('evidence-source mapping: nflscores2, espn-scoreboard, and anything else unknown (null)',()=>{
  const m=need();
  assert.equal(m.evidenceSourceFor(`${NFLSCORES2}/?season=2026&week=3&_=1`),'nflscores2');
  assert.equal(m.evidenceSourceFor(`${ESPN}?dates=2026&week=3`),'espn-scoreboard');
  for(const u of ['https://example.com/scoreboard','https://site.api.espn.com/other','not a url','',null,undefined,`${NFLSCORES2}.evil.example/`])
    assert.equal(m.evidenceSourceFor(u),null,`unknown source: ${u}`);
});
await regression('readFeed accepts a week payload with events and refuses no events, no games or a contradicting context',()=>{
  const m=need();
  assert.equal(m.readFeed(projected([denKc()]),{season:2026,week:3}).ok,true);
  assert.equal(m.readFeed({events:null},{season:2026,week:3}).ok,false);
  assert.equal(m.readFeed({events:[]},{season:2026,week:3}).ok,false);
  assert.equal(m.readFeed(null,{season:2026,week:3}).ok,false);
  assert.equal(m.readFeed({week:{number:4},events:[denKc()]},{season:2026,week:3}).ok,false,'a feed for another week');
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Notes.
// ---------------------------------------------------------------------------------------------------------------------
await regression('public note: required, trimmed of spaces, 1-500 characters (code points), one line, no control characters',()=>{
  const m=need(),ok=v=>m.checkPublicNote(v),bad=v=>assert.equal(ok(v).ok,false,`refused: ${JSON.stringify(v)}`);
  assert.deepEqual(ok('  Canceled by the league.  '),{ok:true,value:'Canceled by the league.'});
  assert.equal(ok('x'.repeat(500)).ok,true);assert.equal(ok('\u{1F3C8}'.repeat(500)).ok,true,'500 non-BMP characters');
  for(const v of [null,undefined,'','   ','x'.repeat(501),'\u{1F3C8}'.repeat(501),'Two\nlines','Two\rlines','Tab\there','\tLeading tab','Bell\u0007',
    'Next\u0085line','Line\u2028separator','Para\u2029separator','Delete\u007f',42,{}])bad(v);
  assert.equal(ok('<b>plain text</b> & more').value,'<b>plain text</b> & more','plain text, never rendered as HTML here');
});
await regression('admin note: at most 2000 characters, newlines and tabs kept, other controls refused; required for withdraw and re-rule',()=>{
  const m=need(),ok=(v,required=false)=>m.checkAdminNote(v,{required});
  assert.deepEqual(ok(null),{ok:true,value:null});assert.deepEqual(ok('   '),{ok:true,value:null});assert.deepEqual(ok(''),{ok:true,value:null});
  assert.deepEqual(ok(' Line one\n\tLine two \n'),{ok:true,value:'Line one\n\tLine two'});
  assert.equal(ok('y'.repeat(2000)).ok,true);assert.equal(ok('y'.repeat(2001)).ok,false);
  assert.equal(ok('Bell\u0007').ok,false);assert.equal(ok('Esc\u001b').ok,false);
  assert.equal(ok(null,true).ok,false);assert.equal(ok(' \n\t ',true).ok,false);assert.equal(ok('Why.',true).ok,true);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Contest and week selection: nothing free-form.
// ---------------------------------------------------------------------------------------------------------------------
await regression('contest selection lists only the contests the Pool Center pages read, from nfl_contests',()=>{
  const m=need(),rows=[...CONTESTS,{...CONTESTS[0],contest_id:'fixture-2026-pickem'},{...CONTESTS[0],contest_id:'pool-center-2026-bogus',contest_type:'bogus'},{...CONTESTS[1],season:'2026'}];
  const options=m.contestOptions(rows);
  assert.deepEqual(options.map(o=>[o.contestId,o.contestType,o.season]),[[PK,'pickem',2026],[SV,'survivor',2026]]);
  assert.match(options[0].displayName,/Pick'em/);
  assert.deepEqual(m.contestOptions(null),[]);
});
await regression("Pick'em week selection: locked, consistent published weeks only, in order",()=>{
  const m=need(),rows=[pkWeekRow(pkConfig(),{week:3}),{...pkWeekRow(),week:5,status:'draft'},{...pkWeekRow({...pkConfig(),week:7}),week:6},
    {...pkWeekRow({...pkConfig(),week:1}),week:1},{...pkWeekRow({...pkConfig(),week:2,season:2025}),week:2},{...pkWeekRow({...pkConfig(),week:4,games:null}),week:4}];
  assert.deepEqual(m.pickemWeeks(rows,{season:2026}).map(w=>w.week),[1,3]);
});
await regression('Survivor week selection: every week a locked snapshot covers, from the latest locked snapshot',()=>{
  const m=need(),cfg4={...svConfig(),week:4};
  const out=m.survivorWeeks([svSnapshotRow(),{season:2026,week:4,status:'locked',revision:2,config:cfg4},{season:2026,week:5,status:'draft',revision:1,config:{...svConfig(),week:5}}],{season:2026});
  assert.equal(out.snapshot.week,4);assert.deepEqual(out.weeks,[1,2,3,4]);
  assert.deepEqual(m.survivorWeeks([],{season:2026}),{snapshot:null,weeks:[]});
});
await regression('published games are read with the canonical alias map only (JAC -> JAX, WSH -> WAS)',()=>{
  const m=need(),games=m.pickemGames(pkConfig({extraGames:[{away:'JAC',home:'WSH',awayNumber:5,homeNumber:6,eventId:'401437960'}]}));
  assert.deepEqual(games.map(g=>[g.index,g.away,g.home,g.eventId]),[[0,'DEN','KC','401437900'],[1,'BUF','CIN','401437947'],[2,'JAX','WAS','401437960']]);
  assert.equal(m.pickemGames({games:'x'}),null);
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. Candidate discovery and eligibility (the Admin is the factual preflight boundary).
// ---------------------------------------------------------------------------------------------------------------------
await regression("candidate discovery: every published game of the week, with its chain state and feed reading",()=>{
  const list=pkCandidates();
  assert.deepEqual(list.map(c=>c.key),['DEN@KC','BUF@CIN']);
  const c=list[1];
  assert.equal(c.matchup,'BUF @ CIN');assert.equal(c.gameIndex,1);assert.equal(c.publishedEventId,'401437947');
  assert.equal(c.chain.state,'empty');assert.equal(c.policy.revision,1);assert.deepEqual(c.consequences,['void']);
});
await regression('an explicitly halted game (canceled, postponed, suspended) is eligible for a first ruling, with the feed evidence',()=>{
  for(const [name,state] of [['STATUS_CANCELED','post'],['STATUS_POSTPONED','pre'],['STATUS_SUSPENDED','in']]){
    const c=pkCandidate({events:pkEvents(denKc(),bufCin(name,state))});
    assert.equal(c.actions.rule.ok,true,`${name}: ${c.actions.rule.reason}`);
    assert.deepEqual(c.evidence,{incidentStatus:name,eventId:'401437947',evidenceSource:'nflscores2'},name);
  }
  assert(SUPPORTED_INCIDENT_STATUSES.length===3);
});
await regression('a normal final, live or scheduled game is refused',()=>{
  for(const [label,event,pattern] of [['final',finalGame('BUF','CIN','401437947','27','24'),/final/i],
    ['live',bufCin('STATUS_IN_PROGRESS','in'),/live/i],['scheduled',bufCin('STATUS_SCHEDULED','pre'),/scheduled/i]]){
    const c=pkCandidate({events:pkEvents(denKc(),event)});
    assert.equal(c.actions.rule.ok,false,label);assert.match(c.actions.rule.reason,pattern,label);
  }
  assert.equal(pkCandidate({},'DEN@KC').actions.rule.ok,false,'DEN @ KC is a final');
});
await regression('a game absent from the feed (or moved to another week) is refused: requires the future exception workflow',()=>{
  const c=pkCandidate({events:pkEvents(denKc())});
  assert.equal(c.actions.rule.ok,false);assert.match(c.actions.rule.reason,HDC14);assert.equal(c.factual.hdc14,true);
});
await regression('a re-paired matchup (a ruled team listed against another opponent) is refused: future exception workflow',()=>{
  const repaired=espnEvent({id:'401437950',away:'BUF',home:'NYJ',type:espnType('STATUS_CANCELED','post')});
  for(const events of [pkEvents(denKc(),repaired),pkEvents(denKc(),bufCin(),repaired)]){
    const c=pkCandidate({events});
    assert.equal(c.actions.rule.ok,false);assert.match(c.actions.rule.reason,HDC14);
  }
});
await regression('the published pair inverted in the feed (CIN @ BUF) is refused: future exception workflow',()=>{
  const inverted=espnEvent({id:'401437947',away:'CIN',home:'BUF',type:espnType('STATUS_CANCELED','post')});
  const c=pkCandidate({events:pkEvents(denKc(),inverted)});
  assert.equal(c.actions.rule.ok,false);assert.match(c.actions.rule.reason,HDC14);
});
await regression('a relisted pair (two event ids) or conflicting copies of one event are refused: future exception workflow',()=>{
  const relisted=pkCandidate({events:pkEvents(denKc(),bufCin(),{...bufCin(),id:'401437999'})});
  assert.equal(relisted.actions.rule.ok,false);assert.match(relisted.actions.rule.reason,HDC14);
  const conflicting=pkCandidate({events:pkEvents(denKc(),bufCin(),bufCin('STATUS_IN_PROGRESS','in'))});
  assert.equal(conflicting.actions.rule.ok,false);assert.match(conflicting.actions.rule.reason,HDC14);
  const duplicate=pkCandidate({events:pkEvents(denKc(),bufCin(),bufCin())});
  assert.equal(duplicate.actions.rule.ok,true,'identical copies of one event are one event');
});
await regression('a forfeit is refused (never a cancellation ruling)',()=>{
  for(const event of [bufCin('STATUS_FORFEIT','post'),{...bufCin('STATUS_FORFEIT','post'),status:{type:{name:'STATUS_FINAL_FORFEIT',state:'post',completed:true}}}]){
    const c=pkCandidate({events:pkEvents(denKc(),event)});
    assert.equal(c.actions.rule.ok,false);assert.match(c.actions.rule.reason,/forfeit/i);
  }
});
await regression('the feed event must match the published event id where the published game has one',()=>{
  const moved=pkCandidate({events:pkEvents(denKc(),{...bufCin(),id:'401437999'})});
  assert.equal(moved.actions.rule.ok,false);assert.match(moved.actions.rule.reason,HDC14);
  const unpinned=pkCandidate({config:pkConfig({eventIds:false}),events:pkEvents(denKc(),{...bufCin(),id:'401437999'})});
  assert.equal(unpinned.actions.rule.ok,true,'no published event id (as production Week 1): the feed event is recorded');
  assert.equal(unpinned.evidence.eventId,'401437999');
  const noId=pkCandidate({config:pkConfig({eventIds:false}),events:pkEvents(denKc(),{...bufCin(),id:undefined})});
  assert.equal(noId.actions.rule.ok,false,'a halted listing without an event id cannot be recorded');
});
await regression('an unsupported halted status name or an unknown evidence source is refused',()=>{
  const odd=pkCandidate({events:pkEvents(denKc(),bufCin('STATUS_CANCELED_WEATHER','post'))});
  assert.equal(odd.actions.rule.ok,false);assert.match(odd.actions.rule.reason,/supported/i);
  for(const source of [null,'espn-scoreboard','nflscores']){
    const c=pkCandidate({source});
    assert.equal(c.actions.rule.ok,false,`source ${source}`);assert.match(c.actions.rule.reason,/nflscores2|source/i);
  }
});
await regression('a feed that cannot be read, or contest data that does not validate, refuses every write but withdrawal of an active chain',()=>{
  const unread=pkCandidate({events:null});
  assert.equal(unread.actions.rule.ok,false);
  const badPolicy=pkCandidates({data:pkData([],[policyRow(PK,'pickem','eliminate')])});
  assert(badPolicy.every(c=>!c.actions.rule.ok&&!c.actions.withdraw.ok),'no write while the policy history does not validate');
  const active=pkCandidate({events:null,data:pkData(pkChain(['void']))});
  assert.equal(active.actions.withdraw.ok,true,'withdrawal never needs the feed');
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. Action state: only valid transitions are offered.
// ---------------------------------------------------------------------------------------------------------------------
const offered=c=>need().ACTIONS.filter(a=>c.actions[a].ok);
await regression('EMPTY offers rule only; reaffirm, withdraw and re-rule are hidden',()=>{
  assert.deepEqual(offered(pkCandidate()),['rule']);
});
await regression('ACTIVE and APPLIED offers withdraw only (reaffirm needs UNDER REVIEW)',()=>{
  const c=pkCandidate({data:pkData(pkChain(['void']))});
  assert.equal(c.chain.state,'active');assert.equal(c.chain.last.ruling_id,1);assert.equal(c.underReview,null);
  assert.deepEqual(offered(c),['withdraw']);
  assert.match(c.actions.reaffirm.reason,/UNDER REVIEW/);assert.match(c.actions.rule.reason,/already/i);
});
await regression('ACTIVE and UNDER REVIEW offers reaffirm and withdraw',()=>{
  const c=pkCandidate({data:pkData(pkChain(['void'])),events:pkEvents(denKc(),finalGame('BUF','CIN','401437947','27','24'))});
  assert.match(c.underReview,/completed final/);
  assert.deepEqual(offered(c),['reaffirm','withdraw']);
});
await regression('WITHDRAWN offers re-rule only while the game is still eligible; never reaffirm or withdraw',()=>{
  const c=pkCandidate({data:pkData(pkChain(['void','withdrawn']))});
  assert.equal(c.chain.state,'withdrawn');assert.deepEqual(offered(c),['rerule']);
  const changed=pkCandidate({data:pkData(pkChain(['void','withdrawn'])),events:pkEvents(denKc(),finalGame('BUF','CIN','401437947','27','24'))});
  assert.deepEqual(offered(changed),[],'re-rule requires current HDC-13 eligibility');
  const otherStatus=pkCandidate({data:pkData(pkChain(['void','withdrawn'])),events:pkEvents(denKc(),bufCin('STATUS_POSTPONED','pre'))});
  assert.deepEqual(offered(otherStatus),[],'re-rule keeps the root evidence: a changed status is not re-ruled here');
});
await regression('an active chain whose game is no longer published stays withdrawable (and nothing else)',()=>{
  const rows=chainRows(PK,'pickem',{week:3,away:'NYJ',home:'NE',eventId:'401437990'},['void']);
  const c=pkCandidates({data:pkData(rows)}).find(x=>x.key==='NYJ@NE');
  assert(c,'the chain is listed');assert.equal(c.published,false);assert.deepEqual(offered(c),['withdraw']);
});
await regression('Survivor policy action filtering: each policy offers exactly the consequences it permits',()=>{
  const m=need();
  assert.deepEqual(m.consequenceChoices('survivor','advance_team_used'),['advance_team_used']);
  assert.deepEqual(m.consequenceChoices('survivor','eliminate'),['eliminate']);
  assert.deepEqual(m.consequenceChoices('survivor','commissioner_decides'),['advance_team_used','eliminate']);
  assert.deepEqual(m.consequenceChoices('pickem','void'),['void']);
  assert.deepEqual(m.consequenceChoices('survivor','void'),[]);
  for(const [policy,expected] of [['advance_team_used',['advance_team_used']],['eliminate',['eliminate']],['commissioner_decides',['advance_team_used','eliminate']]])
    assert.deepEqual(svCandidate({data:svData([],svPolicies(policy))}).consequences,expected,policy);
});
await regression('Survivor candidate discovery: feed games in the week involving a picked team, eligible when halted',()=>{
  const list=svCandidates();
  assert(list.some(c=>c.key==='SF@ARI'),'SF @ ARI (picked by D.C. and survivor-003)');
  assert(!list.some(c=>c.key==='SEA@TB'),'no game without a picked team');
  const c=list.find(x=>x.key==='SF@ARI');
  assert.deepEqual(offered(c),['rule']);assert.deepEqual(c.evidence,{incidentStatus:'STATUS_CANCELED',eventId:'401547001',evidenceSource:'nflscores2'});
  assert.equal(svCandidates().find(x=>x.key==='BUF@CAR').actions.rule.ok,false,'a final is refused');
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. Requests: exactly the 13 approved arguments, explicit NULLs, nothing server-derived.
// ---------------------------------------------------------------------------------------------------------------------
const exact13=r=>{
  assert.deepEqual(Object.keys(r),RPC_ARGUMENTS,'exactly the 13 approved keys, in order');
  for(const k of FORBIDDEN)assert(!(k in r),`never sends ${k}`);
};
await regression('first ruling request: the 13 keys, the feed evidence, the governing revision, no expected parent',()=>{
  const r=requestFor(pkCandidate(),'rule',{consequence:'void',adminNote:'  Private context.  '});
  exact13(r);
  assert.deepEqual(r,{p_contest_id:PK,p_week:3,p_away_team:'BUF',p_home_team:'CIN',p_action:'rule',p_consequence:'void',p_expected_policy_revision:1,
    p_expected_parent_ruling_id:null,p_incident_status:'STATUS_CANCELED',p_event_id:'401437947',p_evidence_source:'nflscores2',p_public_note:NOTE,p_admin_note:'Private context.'});
});
await regression('reaffirm, withdraw and re-rule send NULL consequence (except re-rule) and NULL evidence, and the current last ruling as expected parent',()=>{
  const reaffirm=requestFor(pkCandidate({data:pkData(pkChain(['void'])),events:pkEvents(denKc(),finalGame('BUF','CIN','401437947','27','24'))}),'reaffirm');
  exact13(reaffirm);
  assert.deepEqual([reaffirm.p_action,reaffirm.p_consequence,reaffirm.p_expected_parent_ruling_id,reaffirm.p_incident_status,reaffirm.p_event_id,reaffirm.p_evidence_source,reaffirm.p_admin_note],
    ['reaffirm',null,1,null,null,null,null]);
  const withdraw=requestFor(pkCandidate({data:pkData(pkChain(['void','void']))}),'withdraw');
  exact13(withdraw);
  assert.deepEqual([withdraw.p_action,withdraw.p_consequence,withdraw.p_expected_parent_ruling_id,withdraw.p_event_id,withdraw.p_admin_note],['withdraw',null,2,null,ADMIN_NOTE]);
  const rerule=requestFor(pkCandidate({data:pkData(pkChain(['void','withdrawn']))}),'rerule',{consequence:'void'});
  exact13(rerule);
  assert.deepEqual([rerule.p_action,rerule.p_consequence,rerule.p_expected_parent_ruling_id,rerule.p_incident_status,rerule.p_event_id],['rerule','void',2,null,null]);
});
await regression('a request is refused for an action not offered, a consequence the policy does not permit, or a missing note',()=>{
  const m=need(),c=pkCandidate(),build=o=>m.buildRequest({contestId:PK,week:3,candidate:c,publicNote:NOTE,adminNote:null,...o});
  assert.equal(build({action:'withdraw'}).ok,false,'withdraw on an empty chain');
  assert.equal(build({action:'rule',consequence:'eliminate'}).ok,false,"eliminate in Pick'em");
  assert.equal(build({action:'rule',consequence:'void',publicNote:''}).ok,false,'no public note');
  const active=pkCandidate({data:pkData(pkChain(['void']))});
  assert.equal(m.buildRequest({contestId:PK,week:3,candidate:active,action:'withdraw',publicNote:NOTE,adminNote:''}).ok,false,'withdraw needs a private note');
  assert.equal(build({action:'rule',consequence:'void',contestId:SV}).ok,false,'the candidate belongs to another contest');
});
await regression('the write-access probe is a withdraw with the impossible expected parent 9007199254740991 and writes nothing by construction',()=>{
  const r=need().writeProbeRequest({contestId:PK,week:3,away:'DEN',home:'KC',policyRevision:1});
  exact13(r);
  assert.deepEqual([r.p_action,r.p_consequence,r.p_expected_parent_ruling_id,r.p_incident_status,r.p_event_id,r.p_evidence_source,r.p_expected_policy_revision],
    ['withdraw',null,9007199254740991,null,null,null,1]);
  assert.equal(need().checkPublicNote(r.p_public_note).ok,true);assert.equal(need().checkAdminNote(r.p_admin_note,{required:true}).ok,true);
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. The hypothetical row and the preview (the shared HDC-12 evaluator, before and after).
// ---------------------------------------------------------------------------------------------------------------------
await regression('the hypothetical row is exactly the row the server would write: derived parent, position, consequence and root evidence; no private field',()=>{
  const m=need(),c=pkCandidate({data:pkData(pkChain(['void'])),events:pkEvents(denKc(),finalGame('BUF','CIN','401437947','27','24'))});
  const row=m.hypotheticalRow(requestFor(c,'reaffirm'),{contestType:'pickem',chain:c.chain,rulingId:2,createdAt:'2026-10-08T13:00:00.000Z'});
  assert.deepEqual(Object.keys(row).sort(),[...PUBLIC_COLUMNS.rulings].sort());
  assert.deepEqual(row,{ruling_id:2,contest_id:PK,contest_type:'pickem',week:3,away_team:'BUF',home_team:'CIN',policy_revision:1,chain_seq:2,parent_ruling_id:1,
    consequence:'void',incident_status:'STATUS_CANCELED',event_id:'401437947',evidence_source:'nflscores2',public_note:NOTE,created_at:'2026-10-08T13:00:00.000Z'});
  const w=pkCandidate({data:pkData(pkChain(['void']))});
  assert.equal(m.hypotheticalRow(requestFor(w,'withdraw',{adminNote:'secret'}),{contestType:'pickem',chain:w.chain,rulingId:2,createdAt:CREATED}).consequence,'withdrawn');
});
const pkPreviewOf=({action='rule',consequence='void',chain=[],events=pkEvents(),config=pkConfig()}={})=>{
  const data=pkData(pkChain(chain)),c=pkCandidate({data,events,config}),request=requestFor(c,action,{consequence:action==='rule'||action==='rerule'?consequence:null,adminNote:'Private context.'});
  return{c,request,preview:need().pickemPreview({contestId:PK,season:2026,week:3,config,events,data,request,candidate:c,rulingId:chain.length+1,createdAt:'2026-10-08T13:00:00.000Z'})};
};
await regression("Pick'em preview (rule VOID): game before/after, affected entries, record and remaining-game effect, void state, tiebreak, Rules card",()=>{
  const {preview:p}=pkPreviewOf();
  assert.equal(p.before.slot.state,'none');assert.equal(p.before.effect.kind,'nfl');assert.equal(p.after.effect.kind,'void');
  assert.equal(p.before.game.completed,false);assert.equal(p.after.game.void,true);assert.equal(p.after.game.winner,null);
  assert.equal(p.affected,2,'D.C. (BUF) and DJS (CIN)');
  assert.deepEqual(p.entries.map(e=>[e.name,e.pick,e.before.cell,e.after.cell]),[['D.C.','BUF','pending','void'],['DJS','CIN','pending','void']]);
  for(const e of p.entries)assert.deepEqual([e.after.w-e.before.w,e.after.l-e.before.l,e.after.left-e.before.left],[0,0,-1],`${e.name}: no win, no loss, one fewer remaining`);
  assert.deepEqual(p.remaining,{before:1,after:0});
  assert.deepEqual(p.tiebreak,{isTiebreakGame:true,beforeVoid:false,afterVoid:true});
  assert.equal(p.after.rules.state,'ready');
  assert.deepEqual(p.after.rules.incidents.map(x=>[x.matchup,x.status]),[['BUF @ CIN','APPLIED']]);
  assert.deepEqual(p.before.rules.incidents,[]);
  assert.doesNotMatch(JSON.stringify(p),/Private context|admin_note|created_by/,'the private note never reaches the participant-visible preview');
});
await regression("Pick'em preview (withdraw): the VOID is removed and the halted game awaits a ruling again",()=>{
  const {preview:p}=pkPreviewOf({action:'withdraw',chain:['void']});
  assert.equal(p.before.effect.kind,'void');assert.equal(p.after.effect.kind,'nfl');assert.equal(p.after.effect.withdrawn,true);
  assert.deepEqual(p.entries.map(e=>[e.before.cell,e.after.cell]),[['void','pending'],['void','pending']]);
  assert.deepEqual(p.remaining,{before:0,after:1});
  assert.deepEqual(p.after.rules.incidents.map(x=>x.status),['WITHDRAWN']);
});
await regression('the preview outcome compares equal for the same rows and differs when the written row differs',()=>{
  const m=need(),{c,request,preview:p}=pkPreviewOf();
  const again=m.pickemPreview({contestId:PK,season:2026,week:3,config:pkConfig(),events:pkEvents(),data:pkData(),request,candidate:c,rulingId:77,createdAt:'2026-10-09T01:00:00.000Z'});
  assert.equal(m.sameOutcome(m.previewOutcome(p.after),m.previewOutcome(again.after)),true,'ids and dates are not part of the outcome');
  const other=m.pickemPreview({contestId:PK,season:2026,week:3,config:pkConfig(),events:pkEvents(),data:pkData(),request:{...request,p_public_note:'Another note.'},candidate:c,rulingId:2,createdAt:CREATED});
  assert.equal(m.sameOutcome(m.previewOutcome(p.after),m.previewOutcome(other.after)),false,'a different public note is a different outcome');
});
await regression('Survivor preview (advance_team_used): affected entries, ALIVE/OUT change, team stays used, next-week eligibility, summary, Rules card',()=>{
  const m=need(),c=svCandidate(),request=requestFor(c,'rule',{consequence:'advance_team_used'});
  const p=m.survivorPreview({contestId:SV,season:2026,week:2,snapshot:{week:2,config:svConfig()},eventsByWeek:svEventsByWeek(svFeeds()),data:svData(),request,candidate:c,rulingId:1,createdAt:CREATED});
  assert.equal(p.affected,2,'D.C. (SF) and survivor-003 (ARI)');
  assert.deepEqual(p.entries.map(e=>[e.name,e.pick,e.before.label,e.after.label]),[['D.C.','SF','RULING','ALIVE'],['survivor-003','ARI','RULING','ALIVE']]);
  assert.deepEqual(p.entries.map(e=>[e.before.nextWeekEligible,e.after.nextWeekEligible]),[[false,true],[false,true]]);
  assert.deepEqual(p.entries.find(e=>e.name==='D.C.').after.used,['PIT','SF'],'SF stays used');
  assert.equal(p.before.summary.active,2);assert.equal(p.after.summary.active,4);
  assert.deepEqual([p.before.awaiting,p.after.awaiting,p.before.held,p.after.held],[2,0,0,0]);
  assert.deepEqual(p.after.rules.incidents.map(x=>[x.matchup,x.status]),[['SF @ ARI','APPLIED']]);
  const e=m.survivorPreview({contestId:SV,season:2026,week:2,snapshot:{week:2,config:svConfig()},eventsByWeek:svEventsByWeek(svFeeds()),data:svData([],svPolicies('eliminate')),
    request:requestFor(svCandidate({data:svData([],svPolicies('eliminate'))}),'rule',{consequence:'eliminate'}),candidate:svCandidate({data:svData([],svPolicies('eliminate'))}),rulingId:1,createdAt:CREATED});
  assert.deepEqual(e.entries.map(x=>[x.name,x.after.label]),[['D.C.','OUT'],['survivor-003','OUT']],'eliminate puts its pickers OUT');
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. Preview parity: the Admin preview against what the unmodified public pages render for the same rows and feed.
// ---------------------------------------------------------------------------------------------------------------------
class PageEl{constructor(){this.innerHTML='';this.className='';this.value='';this.hidden=false;this.disabled=false;this.style={};this.listeners={};this.children=[];this.text=''}
  get textContent(){return this.text} set textContent(v){this.text=v==null?'':String(v)}
  addEventListener(t,f){(this.listeners[t]||=[]).push(f)} replaceChildren(...n){this.children=[...n]} appendChild(n){this.children.push(n);return n}}
let pageInstance=0;const pageWarnings=[];
const pageSource=(file,imports)=>{let s=read(`../${file}`);for(const dep of imports){const from=s.match(new RegExp(`from '\\./${dep.replace('.','\\.')}\\?v=[^']+';`))?.[0];assert(from,`${file} imports ${dep}`);
  s=s.replace(from,`from '${new URL(from.slice("from '".length,-"';".length),new URL('../',here)).href}';`)}return s};
const STORE_COLUMNS={nfl_contests:PUBLIC_COLUMNS.contests,nfl_contest_policies:PUBLIC_COLUMNS.policies,nfl_incident_rulings:PUBLIC_COLUMNS.rulings};
function servePublic(table,rows,u){
  const select=(u.searchParams.get('select')||'*').split(','),filters=[...u.searchParams].filter(([k])=>k!=='select'&&k!=='order');
  if(select.some(c=>!STORE_COLUMNS[table].includes(c)))return{ok:false,status:401,json:async()=>({})};
  const keep=r=>filters.every(([k,v])=>{const [op,...rest]=v.split('.'),want=rest.join('.'),have=r[k],w=typeof have==='number'?Number(want):want;return op==='eq'?have===w:have<=w});
  return{ok:true,status:200,json:async()=>structuredClone(rows.filter(keep).map(r=>Object.fromEntries(select.map(c=>[c,r[c]]))))};
}
async function bootPage(file,{weekRows,store,feedFor,view}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new PageEl());return els.get(id)};
  globalThis.document={body:{dataset:{view}},title:'',visibilityState:'hidden',getElementById:$,querySelectorAll(){return[]},createElement(){return new PageEl()},addEventListener(){}};
  globalThis.window={addEventListener(){},scrollTo(){}};
  globalThis.location={href:`https://example.test/nfl-pool/?view=${view}`,search:`?view=${view}`};
  globalThis.history={pushState(){},replaceState(){},state:null};
  globalThis.setInterval=()=>0;
  const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.y';
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/token/anonymous'))return{ok:true,json:async()=>({token})};
    if(u.pathname.endsWith('/nfl_pool_weeks')||u.pathname.endsWith('/nfl_survivor_weeks'))return{ok:true,json:async()=>structuredClone(weekRows)};
    const table=Object.keys(STORE_COLUMNS).find(t=>u.pathname.endsWith(`/${t}`));
    if(table)return servePublic(table,store[table],u);
    const payload=feedFor(Number(u.searchParams.get('week')));
    return payload?{ok:true,status:200,json:async()=>structuredClone(payload)}:{ok:false,status:404,json:async()=>({})};
  };
  const source=file==='weekly-app.js'?pageSource(file,['public-math.js','contest-rulings.js']):pageSource(file,['survivor-math.js','contest-rulings.js']);
  // The pages' own console warnings (here: the next week's schedule, which this harness does not serve) are collected
  // rather than printed; their stacks embed the whole data: URL. No assertion reads them.
  const warn=console.warn;console.warn=(...args)=>{pageWarnings.push(args)};
  try{
    await import(`data:text/javascript;base64,${Buffer.from(source+`\n//page ${++pageInstance}`).toString('base64')}`);
    await flush(40);
  }finally{console.warn=warn}
  return $;
}
const weeklyView=async({rows,events,config=pkConfig()})=>{
  const $=await bootPage('weekly-app.js',{view:'home',weekRows:[pkWeekRow(config)],store:{nfl_contests:CONTESTS.filter(c=>c.contest_id===PK),nfl_contest_policies:pkPolicies(),nfl_incident_rulings:rows},feedFor:()=>projected(events)});
  const pickRows=$('pickBody').innerHTML.split('</tr>').filter(r=>r.includes('<td class="name">'));
  const cells=Object.fromEntries(pickRows.map(r=>[r.match(/<td class="name">([^<]*)<\/td>/)[1],[...r.matchAll(/<td class="c ([a-z ]+)">/g)].map(m=>m[1])]));
  const records=Object.fromEntries([...$('standings').innerHTML.matchAll(/<td class="entry">([^<]*)<\/td>.*?<td class="c w">(\d+)<\/td><td class="c l">(\d+)<\/td><td class="c">(\d+)<\/td>/g)].map(m=>[m[1],{w:+m[2],l:+m[3],left:+m[4]}]));
  return{cells,records,finals:$('finals').textContent,left:$('left').textContent,mnf:$('mnf').textContent,rules:$('pickemRules').innerHTML};
};
const survivorView=async({rows,feeds,config=svConfig()})=>{
  const $=await bootPage('survivor-app.js',{view:'survivor',weekRows:[svSnapshotRow(config)],store:{nfl_contests:CONTESTS.filter(c=>c.contest_id===SV),nfl_contest_policies:svPolicies(rows.policy||'advance_team_used'),nfl_incident_rulings:rows.rulings},feedFor:w=>feeds[w]?projected(feeds[w].events):null});
  const tracked=$('svTracked').innerHTML.split('survivor-tracked-row').slice(1);
  const pills=Object.fromEntries(tracked.map(r=>[r.match(/<b>([^<]*)<\/b>/)[1],[...r.matchAll(/<span class="status-pill [^"]*">([^<]*)<\/span>/g)].map(m=>m[1])]));
  return{pills,stillIn:Number($('svStillIn').textContent),pending:Number($('svPending').textContent),entered:Number($('svEntered').textContent),rules:$('svRules').innerHTML};
};
const unescape=s=>String(s).replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
await regression("Pick'em parity (rule VOID, tiebreak game): the Admin preview matches weekly-app.js before and after",async()=>{
  const {request,preview:p}=pkPreviewOf();
  const row=need().hypotheticalRow(request,{contestType:'pickem',chain:{state:'empty',rows:[],root:null,last:null},rulingId:1,createdAt:CREATED});
  const before=await weeklyView({rows:[],events:[denKc(),bufCin()]}),after=await weeklyView({rows:[row],events:[denKc(),bufCin()]});
  for(const e of p.entries){
    assert.equal(before.cells[e.name][1],e.before.cell,`${e.name}: weekly-app before`);assert.equal(after.cells[e.name][1],e.after.cell,`${e.name}: weekly-app after`);
    assert.deepEqual([after.records[e.name].w-before.records[e.name].w,after.records[e.name].l-before.records[e.name].l,after.records[e.name].left-before.records[e.name].left],
      [e.after.w-e.before.w,e.after.l-e.before.l,e.after.left-e.before.left],`${e.name}: record delta`);
  }
  assert.equal(before.left,'1');assert.equal(after.left,'0');assert.equal(Number(after.left)-Number(before.left),p.remaining.after-p.remaining.before);
  assert.equal(after.mnf,'VOID','the voided tiebreak game');assert.equal(p.tiebreak.afterVoid,true);
  assert.equal(after.finals,'1/2 · 1 void');
  for(const x of p.after.rules.incidents){assert(unescape(after.rules).includes(x.matchup),'the card lists the incident');assert(after.rules.includes(`<span class="rules-status">${x.status}</span>`),`card status ${x.status}`)}
});
await regression("Pick'em parity (withdraw): the Admin preview matches weekly-app.js after the withdrawal",async()=>{
  const {request,preview:p}=pkPreviewOf({action:'withdraw',chain:['void']});
  const rows=pkChain(['void']),row=need().hypotheticalRow(request,{contestType:'pickem',chain:{state:'active',rows,root:rows[0],last:rows[0]},rulingId:2,createdAt:CREATED});
  const before=await weeklyView({rows,events:[denKc(),bufCin()]}),after=await weeklyView({rows:[...rows,row],events:[denKc(),bufCin()]});
  for(const e of p.entries){assert.equal(before.cells[e.name][1],e.before.cell);assert.equal(after.cells[e.name][1],e.after.cell)}
  for(const x of p.after.rules.incidents)assert(after.rules.includes(`<span class="rules-status">${x.status}</span>`),`card status ${x.status}`);
});
await regression('Survivor parity (advance_team_used and eliminate): the Admin preview matches survivor-app.js before and after',async()=>{
  const m=need(),feeds=svFeeds();
  for(const [policy,consequence] of [['advance_team_used','advance_team_used'],['eliminate','eliminate']]){
    const data=svData([],svPolicies(policy)),c=svCandidate({data}),request=requestFor(c,'rule',{consequence});
    const p=m.survivorPreview({contestId:SV,season:2026,week:2,snapshot:{week:2,config:svConfig()},eventsByWeek:svEventsByWeek(feeds),data,request,candidate:c,rulingId:1,createdAt:CREATED});
    const row=m.hypotheticalRow(request,{contestType:'survivor',chain:c.chain,rulingId:1,createdAt:CREATED});
    const before=await survivorView({rows:{policy,rulings:[]},feeds}),after=await survivorView({rows:{policy,rulings:[row]},feeds});
    for(const e of p.tracked){
      assert.equal(before.pills[e.name][0],e.before.label,`${policy} ${e.name}: survivor-app before`);
      assert.equal(after.pills[e.name][0],e.after.label,`${policy} ${e.name}: survivor-app after`);
    }
    assert.deepEqual([before.stillIn,before.pending,before.entered],[p.before.summary.active,p.before.summary.pending,p.before.summary.entered],`${policy}: summary before`);
    assert.deepEqual([after.stillIn,after.pending,after.entered],[p.after.summary.active,p.after.summary.pending,p.after.summary.entered],`${policy}: summary after`);
    for(const x of p.after.rules.incidents)assert(after.rules.includes(`<span class="rules-status">${x.status}</span>`),`${policy}: card status ${x.status}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 10. Confirmation, errors, read-back, probe (pure).
// ---------------------------------------------------------------------------------------------------------------------
await regression('typed confirmation is the matchup ("BUF @ CIN"); case and spacing normalize; anything else does not match',()=>{
  const m=need(),phrase=m.confirmationPhrase(pkCandidate());
  assert.equal(phrase,'BUF @ CIN');
  for(const typed of ['BUF @ CIN','buf @ cin','  BUF   @   CIN ','BUF@CIN','Buf@Cin'])assert.equal(m.confirmationMatches(typed,phrase),true,typed);
  for(const typed of ['CIN @ BUF','BUF CIN','CONFIRM','BUF @ CIN!','',null,'BUF @ CINN'])assert.equal(m.confirmationMatches(typed,phrase),false,String(typed));
});
await regression('the preflight key changes with the event, status, matchup, event id, policy or chain, and not otherwise',()=>{
  const m=need(),key=c=>m.preflightKey(c),base=key(pkCandidate());
  assert.equal(key(pkCandidate()),base);
  assert.notEqual(key(pkCandidate({events:pkEvents(denKc(),bufCin('STATUS_POSTPONED','pre'))})),base,'status');
  assert.notEqual(key(pkCandidate({events:pkEvents(denKc(),finalGame('BUF','CIN','401437947','27','24'))})),base,'event state');
  assert.notEqual(key(pkCandidate({config:pkConfig({eventIds:false}),events:pkEvents(denKc(),{...bufCin(),id:'401437999'})})),base,'event id');
  assert.notEqual(key(pkCandidate({data:pkData(pkChain(['void','withdrawn']))})),base,'chain');
  assert.notEqual(key(pkCandidate({data:pkData([],[policyRow(PK,'pickem','void',{created_at:CREATED}),policyRow(PK,'pickem','void',{revision:2,effective_week:2,created_at:'2026-08-01T00:00:00+00:00'})])})),base,'policy revision');
});
await regression('known HDC13 tokens map to fixed safe messages; nothing written',()=>{
  const m=need();
  for(const token of TOKENS){
    for(const error of [{code:'P0001',message:`${token}: detail`,hint:token},{code:'P0001',message:`${token}: detail`,hint:null},{code:'22023',message:'other',hint:token}]){
      const info=m.rpcErrorInfo(error);
      assert.equal(info.token,token);assert.equal(info.known,true);assert.equal(info.definitive,true);assert.equal(info.text,m.HDC13_ERROR_TEXT[token]);
    }
    assert.match(m.HDC13_ERROR_TEXT[token],/Nothing was written/);
  }
  assert.match(m.HDC13_ERROR_TEXT.HDC13_STALE_CHAIN,/preview/i);assert.match(m.HDC13_ERROR_TEXT.HDC13_STALE_POLICY,/preview/i);
  assert.equal(m.rpcErrorInfo({code:'P0001',message:'HDC13_MADE_UP: x',hint:'HDC13_MADE_UP'}).known,false,'only the known tokens');
});
await regression('permission denied, other database errors and lost responses are classified; unknown text stays plain text',()=>{
  const m=need();
  const denied=m.rpcErrorInfo({code:'42501',message:'permission denied for function nfl_append_incident_ruling'});
  assert.equal(denied.known,true);assert.equal(denied.definitive,true);assert.match(denied.text,/permission/i);
  const html='<img src=x onerror=alert(1)>boom';
  const other=m.rpcErrorInfo({code:'23514',message:html});
  assert.equal(other.known,false);assert.equal(other.definitive,true,'a database error wrote nothing');assert(other.text.includes(html),'kept as text for textContent');
  for(const lost of [{code:'',message:'TypeError: Failed to fetch'},{message:'network down'},new TypeError('Failed to fetch'),null])
    assert.equal(m.rpcErrorInfo(lost).definitive,false,'the outcome of a lost response is unknown');
  assert.equal(m.rpcErrorInfo({code:'PGRST202',message:'Could not find the function'}).definitive,true);
});
await regression('read-back classifies a lost response: LANDED, NOT_WRITTEN or CHANGED',()=>{
  const m=need(),before=pkChain(['void']),c=pkCandidate({data:pkData(before)}),request=requestFor(c,'withdraw');
  const landed=[...before,{...pkChain(['void','withdrawn'])[1],ruling_id:57,public_note:NOTE}];
  assert.equal(m.classifyReadBack({beforeRows:before,afterRows:landed,request,chain:c.chain}),'LANDED');
  assert.equal(m.classifyReadBack({beforeRows:before,afterRows:before,request,chain:c.chain}),'NOT_WRITTEN');
  assert.equal(m.classifyReadBack({beforeRows:before,afterRows:[...before,{...landed[1],public_note:'Another tab.'}],request,chain:c.chain}),'CHANGED');
  assert.equal(m.classifyReadBack({beforeRows:before,afterRows:[...before,{...landed[1],consequence:'void'}],request,chain:c.chain}),'CHANGED');
  assert.equal(m.classifyReadBack({beforeRows:before,afterRows:[],request,chain:c.chain}),'CHANGED');
});
await regression('write-access probe outcomes: HDC13_STALE_CHAIN authorizes, NOT_COMMISSIONER or permission denied does not, success is unexpected',()=>{
  const m=need();
  assert.equal(m.probeOutcome({error:{code:'P0001',message:'HDC13_STALE_CHAIN: x',hint:'HDC13_STALE_CHAIN'}}).status,'authorized');
  assert.equal(m.probeOutcome({error:{code:'42501',message:'HDC13_NOT_COMMISSIONER: x',hint:'HDC13_NOT_COMMISSIONER'}}).status,'denied');
  assert.equal(m.probeOutcome({error:{code:'42501',message:'permission denied for function nfl_append_incident_ruling'}}).status,'denied');
  assert.equal(m.probeOutcome({data:{ruling_id:1}}).status,'unexpected');
  assert.equal(m.probeOutcome({error:{code:'P0001',message:'HDC13_STALE_POLICY: x',hint:'HDC13_STALE_POLICY'}}).status,'inconclusive');
});

// ---------------------------------------------------------------------------------------------------------------------
// 11. The Admin page workflow (rulings-admin.js unmodified, fake DOM, mock Neon, real score-feed-proxy.js).
// ---------------------------------------------------------------------------------------------------------------------
const COMMISSIONER={id:'00000000-0000-4000-8000-000000000001',email:'djsmokke@gmail.com'};
class El{
  constructor(id){this.id=id;this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.text='';this.innerHTML='';this.className='';this.listeners={};this.attributes={};this.style={}}
  get textContent(){return this.text} set textContent(v){this.text=v==null?'':String(v)}
  addEventListener(t,f){(this.listeners[t]||=[]).push(f)}
  dispatch(t){return Promise.all((this.listeners[t]||[]).map(fn=>fn({type:t,target:this,preventDefault(){}})))}
  setAttribute(k,v){this.attributes[k]=String(v)} removeAttribute(k){delete this.attributes[k]} focus(){}
}
const tokenError=(token,code='P0001')=>({data:null,error:{code,message:`${token}: emulated refusal`,hint:token,details:null}});
// The server's derivations (004), emulated over the in-memory tables for the page workflow tests.
function serverRpc(db){
  return async(fn,a)=>{
    assert.equal(fn,'nfl_append_incident_ruling');
    if(!db.session||db.session.email.toLowerCase()!=='djsmokke@gmail.com')return tokenError('HDC13_NOT_COMMISSIONER','42501');
    const contest=db.tables.nfl_contests.find(c=>c.contest_id===a.p_contest_id);
    if(!contest)return tokenError('HDC13_INVALID_INPUT','22023');
    const rev=db.tables.nfl_contest_policies.filter(p=>p.contest_id===a.p_contest_id&&p.effective_week<=a.p_week).sort((x,y)=>y.revision-x.revision)[0]?.revision??null;
    if(rev!==a.p_expected_policy_revision)return tokenError('HDC13_STALE_POLICY');
    const chain=db.tables.nfl_incident_rulings.filter(r=>r.contest_id===a.p_contest_id&&r.week===a.p_week&&r.away_team===a.p_away_team&&r.home_team===a.p_home_team&&r.policy_revision===rev).sort((x,y)=>x.chain_seq-y.chain_seq);
    const last=chain.at(-1)||null;
    if((last?.ruling_id??null)!==(a.p_expected_parent_ruling_id??null))return tokenError('HDC13_STALE_CHAIN');
    const state=!last?'empty':last.consequence==='withdrawn'?'withdrawn':'active';
    if({rule:'empty',reaffirm:'active',withdraw:'active',rerule:'withdrawn'}[a.p_action]!==state)return tokenError('HDC13_INVALID_TRANSITION');
    const root=chain[0]||null,row={ruling_id:++db.nextId,contest_id:a.p_contest_id,contest_type:contest.contest_type,week:a.p_week,away_team:a.p_away_team,home_team:a.p_home_team,
      policy_revision:rev,chain_seq:(last?.chain_seq||0)+1,parent_ruling_id:last?.ruling_id??null,
      consequence:a.p_action==='withdraw'?'withdrawn':a.p_action==='reaffirm'?last.consequence:a.p_consequence,
      incident_status:root?root.incident_status:a.p_incident_status,event_id:root?root.event_id:a.p_event_id,evidence_source:root?root.evidence_source:a.p_evidence_source,
      public_note:db.serverNote??a.p_public_note,created_at:new Date().toISOString(),admin_note:a.p_admin_note,created_by:db.session.id};
    db.tables.nfl_incident_rulings.push(row);
    return{data:Object.fromEntries(PUBLIC_COLUMNS.rulings.map(c=>[c,row[c]])),error:null};
  };
}
// HDC-14: the absent-game function's server derivations (migration 005), emulated over the in-memory tables: the commissioner,
// the compare-and-swap tokens, the state machine, one evidence class per chain, the published proof (Pick'em: the locked
// week; Survivor: a covering snapshot and the same-week locked slate) and the server-derived absence evidence.
const ABSENT_ARGS=['p_contest_id','p_week','p_away_team','p_home_team','p_action','p_consequence','p_expected_policy_revision',
  'p_expected_parent_ruling_id','p_public_note','p_admin_note'];
function serverAbsentRpc(db){
  const alias=c=>({JAC:'JAX',WSH:'WAS'}[c]||c);
  return async(fn,a)=>{
    assert.equal(fn,'nfl_append_absent_incident_ruling');
    assert.deepEqual(Object.keys(a),ABSENT_ARGS,'exactly the 10 absent-game arguments, in order');
    if(!db.session||db.session.email.toLowerCase()!=='djsmokke@gmail.com')return tokenError('HDC14_NOT_COMMISSIONER','42501');
    const contest=db.tables.nfl_contests.find(c=>c.contest_id===a.p_contest_id);
    if(!contest)return tokenError('HDC14_INVALID_INPUT','22023');
    const rev=db.tables.nfl_contest_policies.filter(p=>p.contest_id===a.p_contest_id&&p.effective_week<=a.p_week).sort((x,y)=>y.revision-x.revision)[0]?.revision??null;
    if(rev!==a.p_expected_policy_revision)return tokenError('HDC14_STALE_POLICY');
    const chain=db.tables.nfl_incident_rulings.filter(r=>r.contest_id===a.p_contest_id&&r.week===a.p_week&&r.away_team===a.p_away_team&&r.home_team===a.p_home_team&&r.policy_revision===rev).sort((x,y)=>x.chain_seq-y.chain_seq);
    const last=chain.at(-1)||null,root=chain[0]||null;
    if((last?.ruling_id??null)!==(a.p_expected_parent_ruling_id??null))return tokenError('HDC14_STALE_CHAIN');
    const state=!last?'empty':last.consequence==='withdrawn'?'withdrawn':'active';
    if({rule:'empty',reaffirm:'active',withdraw:'active',rerule:'withdrawn'}[a.p_action]!==state)return tokenError('HDC14_INVALID_TRANSITION');
    if(root&&root.incident_status!=='STATUS_ABSENT')return tokenError('HDC14_NOT_ABSENCE_CHAIN');
    let eventId=root?root.event_id:null;
    if(a.p_action!=='withdraw'){
      const survivor=contest.contest_type==='survivor';
      if(survivor&&!db.tables.nfl_survivor_weeks.some(w=>w.season===contest.season&&w.week>=a.p_week&&w.status==='locked'))return tokenError('HDC14_NOT_PUBLISHED');
      const weeks=db.tables.nfl_pool_weeks.filter(w=>w.season===contest.season&&w.week===a.p_week&&w.status==='locked'&&w.config?.week===a.p_week);
      const games=(weeks[0]?.config?.games||[]).map(g=>({away:alias(g.away),home:alias(g.home),eventId:g.eventId??null}));
      const pairs=games.filter(g=>g.away===a.p_away_team&&g.home===a.p_home_team),touching=games.filter(g=>[g.away,g.home].some(t=>t===a.p_away_team||t===a.p_home_team));
      if(weeks.length!==1||pairs.length!==1||touching.length!==1)return tokenError(survivor?'HDC14_ABSENCE_NOT_ATTESTABLE':'HDC14_NOT_PUBLISHED');
      if(a.p_action==='rule')eventId=pairs[0].eventId;
      else if(pairs[0].eventId!==null&&pairs[0].eventId!==eventId)return tokenError('HDC14_EVENT_MISMATCH');
    }
    const row={ruling_id:++db.nextId,contest_id:a.p_contest_id,contest_type:contest.contest_type,week:a.p_week,away_team:a.p_away_team,home_team:a.p_home_team,
      policy_revision:rev,chain_seq:(last?.chain_seq||0)+1,parent_ruling_id:last?.ruling_id??null,
      consequence:a.p_action==='withdraw'?'withdrawn':a.p_action==='reaffirm'?last.consequence:a.p_consequence,
      incident_status:'STATUS_ABSENT',event_id:eventId,evidence_source:'commissioner-attestation',
      public_note:db.serverNote??a.p_public_note,created_at:new Date().toISOString(),admin_note:a.p_admin_note,created_by:db.session.id};
    db.tables.nfl_incident_rulings.push(row);
    return{data:Object.fromEntries(PUBLIC_COLUMNS.rulings.map(c=>[c,row[c]])),error:null};
  };
}
const routeRpc=db=>{const normal=serverRpc(db),absentRpc=serverAbsentRpc(db);return(fn,a)=>fn==='nfl_append_absent_incident_ruling'?absentRpc(fn,a):normal(fn,a)};
function neonModule(db){
  const columns={nfl_contests:PUBLIC_COLUMNS.contests,nfl_contest_policies:PUBLIC_COLUMNS.policies,nfl_incident_rulings:PUBLIC_COLUMNS.rulings};
  class Query{
    constructor(table){this.table=table;this.cols='*';this.filters=[]}
    select(cols){this.cols=cols;return this}
    eq(k,v){this.filters.push(['eq',k,v]);return this}
    lte(k,v){this.filters.push(['lte',k,v]);return this}
    order(){return this}
    then(ok,fail){return this.run().then(ok,fail)}
    async run(){
      db.reads.push({table:this.table,cols:this.cols,filters:this.filters.map(f=>f.join(':'))});
      if(db.readFail&&db.readFail(this.table))return{data:null,error:{code:'',message:'TypeError: Failed to fetch'}};
      const cols=String(this.cols).split(',').map(s=>s.trim());
      if(columns[this.table]&&cols.some(c=>!columns[this.table].includes(c)))return{data:null,error:{code:'42501',message:`permission denied for table ${this.table}`}};
      const rows=(db.tables[this.table]||[]).filter(r=>this.filters.every(([op,k,v])=>op==='eq'?r[k]===v:r[k]<=v));
      return{data:structuredClone(rows.map(r=>cols[0]==='*'?r:Object.fromEntries(cols.map(c=>[c,r[c]])))),error:null};
    }
  }
  return{createClient:()=>({
    auth:{getSession:async()=>({data:db.session?{user:db.session,session:{token:'t'}}:null}),signOut:async()=>{db.signOuts++;db.session=null},
      emailOtp:{sendVerificationOtp:async()=>({error:null})},signIn:{emailOtp:async()=>{db.session=db.pendingSession;return{error:null}}}},
    from:table=>new Query(table),
    rpc:async(fn,args)=>{db.rpcCalls.push({fn,args:structuredClone(args)});return db.rpc(fn,args)}
  })};
}
const patchedAdmin=()=>{
  assert(adminSource,'rulings-admin.js must exist');
  const moduleFrom=adminSource.match(/from '\.\/incident-rulings\.js\?v=\d+';/)?.[0];
  assert(moduleFrom,'rulings-admin.js imports a versioned incident-rulings.js');
  const swaps=[["import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';","const {createClient}=globalThis.__rulingsTest.neonModule;"],
    [moduleFrom,`from '${new URL(moduleFrom.slice("from '".length,-"';".length),here).href}';`]];
  let s=adminSource;
  for(const [from,to] of swaps){assert(s.includes(from),`harness expects: ${from}`);s=s.split(from).join(to)}
  return s;
};
let adminInstance=0;
async function boot({session=COMMISSIONER,pendingSession=COMMISSIONER,tables={},feeds={3:projected([denKc(),bufCin()])},rpc=null}={}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El(id));return els.get(id)};
  const db={session,pendingSession,signOuts:0,reads:[],rpcCalls:[],nextId:100,tables:{nfl_contests:structuredClone(CONTESTS),nfl_contest_policies:[...pkPolicies(),...svPolicies()],
    nfl_incident_rulings:[],nfl_pool_weeks:[pkWeekRow()],nfl_survivor_weeks:[svSnapshotRow()],...structuredClone(tables)}};
  db.rpc=rpc?rpc(db):routeRpc(db);
  const net={calls:[],feeds,gate:null};
  const nativeFetch=async(url)=>{
    const u=new URL(String(url));net.calls.push(u.href);
    if(net.gate)await net.gate;
    if(u.origin===NFLSCORES2){const w=Number(u.searchParams.get('week')),p=typeof net.feeds[w]==='function'?net.feeds[w]():net.feeds[w];
      return p?{ok:true,status:200,url:u.href,json:async()=>structuredClone(p)}:{ok:false,status:502,url:u.href,json:async()=>({error:'upstream_unavailable'})}}
    return{ok:false,status:404,url:u.href,json:async()=>({})};
  };
  const intervals=[];
  globalThis.document={getElementById:$,addEventListener(){},body:{dataset:{}}};
  globalThis.window={fetch:nativeFetch,location:{href:'https://r88510179-collab.github.io/nfl-pool/admin/rulings.html'},addEventListener(){}};
  new Function('window',proxySource)(globalThis.window);
  globalThis.fetch=globalThis.window.fetch;
  globalThis.setInterval=(...a)=>{intervals.push(a);return 0};
  globalThis.__rulingsTest={neonModule:neonModule(db)};
  await import(`data:text/javascript;base64,${Buffer.from(patchedAdmin()+`\n//admin ${++adminInstance}`).toString('base64')}`);
  await flush();
  const t={$,db,net,intervals,
    click:async id=>{await $(id).dispatch('click');await flush()},
    change:async(id,value)=>{$(id).value=String(value);await $(id).dispatch('change');await flush()},
    input:async(id,value)=>{$(id).value=value;await $(id).dispatch('input');await flush()},
    options:id=>[...$(id).innerHTML.matchAll(/<option value="([^"]*)"/g)].map(m=>m[1]).filter(Boolean),
    html:()=>[...els.values()].map(e=>`${e.innerHTML}\n${e.textContent}`).join('\n'),
    feedCalls:()=>net.calls.filter(u=>u.startsWith(NFLSCORES2)).length};
  return t;
}
// Contest, week, Load, matchup, action, consequence and notes, as the commissioner would.
async function ready(t,{contest=PK,week=3,matchup='BUF@CIN',action='rule',consequence='void',publicNote=NOTE,adminNote=''}={}){
  await t.change('contestSelect',contest);await t.change('weekSelect',week);await t.click('loadBtn');
  await t.change('matchupSelect',matchup);
  if(action)await t.change('actionSelect',action);
  if(consequence&&t.options('consequenceSelect').includes(consequence))await t.change('consequenceSelect',consequence);
  await t.input('publicNote',publicNote);await t.input('adminNote',adminNote);
}
async function previewed(t,o={}){await ready(t,o);await t.click('previewBtn');await t.input('confirmMatchup',o.typed??(o.matchup||'BUF@CIN').replace('@',' @ '))}

await regression('auth required: signed out, nothing is read or offered; the email-code sign-in then loads the contests',async()=>{
  const t=await boot({session:null});
  assert.equal(t.$('authState').textContent,'SIGN IN REQUIRED');assert.equal(t.$('signedOut').hidden,false);
  assert.equal(t.db.reads.length,0,'no Data API read while signed out');
  for(const id of ['loadBtn','previewBtn','submitBtn','probeBtn'])assert.equal(t.$(id).disabled,true,`${id} disabled`);
  await t.click('sendCode');assert.equal(t.$('otpWrap').hidden,false);
  await t.input('otp','123456');await t.click('verifyCode');
  assert.equal(t.$('authState').textContent,'AUTHORIZED');
  assert.deepEqual(t.options('contestSelect'),[PK,SV]);
  assert(t.db.reads.some(r=>r.table==='nfl_contests'&&r.cols===PUBLIC_COLUMNS.contests.join(',')),'contests read with the public columns');
});
await regression('commissioner UX check: another account is signed out at once (the database still decides)',async()=>{
  const t=await boot({session:{id:'someone',email:'participant@example.com'}});
  assert.equal(t.db.signOuts,1);assert.equal(t.$('authState').textContent,'SIGN IN REQUIRED');
  assert.equal(t.db.reads.length,0);assert.equal(t.$('submitBtn').disabled,true);
  assert.match(adminSource,/const ADMIN_EMAIL='djsmokke@gmail\.com'/,'the same ADMIN_EMAIL UX guard as the other Admin pages');
});
await regression('selection: contest from nfl_contests, week from locked published data, matchup from published data and the live feed; nothing free-form',async()=>{
  const t=await boot();
  await t.change('contestSelect',PK);
  assert.deepEqual(t.options('weekSelect'),['3']);
  await t.change('weekSelect',3);await t.click('loadBtn');
  assert.deepEqual(t.options('matchupSelect'),['DEN@KC','BUF@CIN']);
  assert.equal(t.feedCalls(),1,'one score request for the week, through nflscores2');
  assert.match(t.$('feedState').textContent,/nflscores2/);
  assert.doesNotMatch(pageHtml||'',/<input[^>]+id="(contest|week|away|home|event|eventId|revision|parent)/i,'no free-form identity input');
});
await regression('the action list shows only valid transitions, and the consequence list only what the policy permits',async()=>{
  const t=await boot();await ready(t,{action:null});
  assert.deepEqual(t.options('actionSelect'),['rule']);assert.deepEqual(t.options('consequenceSelect'),['void']);
  const active=await boot({tables:{nfl_incident_rulings:pkChain(['void'])}});await ready(active,{action:null});
  assert.deepEqual(active.options('actionSelect'),['withdraw']);
  const den=await boot();await ready(den,{matchup:'DEN@KC',action:null});
  assert.deepEqual(den.options('actionSelect'),[],'a final offers nothing');assert.match(den.$('candidateInfo').innerHTML,/final/i);
});
await regression('first ruling end to end: preview, typed confirmation, one RPC with exactly the 13 arguments, read-back',async()=>{
  const t=await boot();await previewed(t,{adminNote:'Private context.'});
  assert.equal(t.$('preview').hidden,false);
  const summary=unescape(t.$('previewSummary').innerHTML+t.$('previewSummary').textContent);
  for(const text of ["Pool Center 2026 Pick'em",'Week 3','BUF @ CIN','401437947','STATUS_CANCELED','nflscores2','revision 1','rule','void','2',NOTE,'Private context.'])
    assert(summary.includes(text),`the confirmation shows ${text}`);
  assert.match(t.$('previewBefore').innerHTML+t.$('previewAfter').innerHTML,/VOID/);
  assert.equal(t.$('confirmPhrase').textContent,'BUF @ CIN');
  assert.equal(t.$('submitBtn').disabled,false);
  await t.click('submitBtn');
  assert.equal(t.db.rpcCalls.length,1);
  const {fn,args}=t.db.rpcCalls[0];
  assert.equal(fn,'nfl_append_incident_ruling');exact13(args);
  assert.deepEqual(args,{p_contest_id:PK,p_week:3,p_away_team:'BUF',p_home_team:'CIN',p_action:'rule',p_consequence:'void',p_expected_policy_revision:1,p_expected_parent_ruling_id:null,
    p_incident_status:'STATUS_CANCELED',p_event_id:'401437947',p_evidence_source:'nflscores2',p_public_note:NOTE,p_admin_note:'Private context.'});
  assert.equal(t.db.tables.nfl_incident_rulings.length,1);
  assert.match(t.$('message').textContent,/recorded/i);assert.match(t.$('result').textContent,/matches the preview/i);
  assert(t.db.reads.filter(r=>r.table==='nfl_incident_rulings').length>=3,'the chain is read again after the write');
  assert(t.db.reads.filter(r=>r.table==='nfl_incident_rulings').every(r=>r.cols===PUBLIC_COLUMNS.rulings.join(',')),'only public columns are ever read');
  assert.equal(t.$('submitBtn').disabled,true,'a recorded preview cannot be submitted again');
});
await regression('typed confirmation is required; a generic CONFIRM does not unlock the submit button',async()=>{
  const t=await boot();await previewed(t,{typed:'CONFIRM'});
  assert.equal(t.$('submitBtn').disabled,true);
  await t.click('submitBtn');assert.equal(t.db.rpcCalls.length,0);
  await t.input('confirmMatchup','buf@cin');assert.equal(t.$('submitBtn').disabled,false);
});
await regression('any material change clears the preview and the confirmation',async()=>{
  for(const [label,change] of [['public note',t=>t.input('publicNote','Another note.')],['private note',t=>t.input('adminNote','Another.')],
    ['action',t=>t.change('actionSelect','rule')],['consequence',t=>t.change('consequenceSelect','void')],['matchup',t=>t.change('matchupSelect','DEN@KC')],
    ['week',t=>t.change('weekSelect',3)],['contest',t=>t.change('contestSelect',SV)],['reload',t=>t.click('loadBtn')]]){
    const t=await boot();await previewed(t);
    assert.equal(t.$('submitBtn').disabled,false,`${label}: armed first`);
    await change(t);
    assert.equal(t.$('submitBtn').disabled,true,`${label}: disarmed`);assert.equal(t.$('confirmMatchup').value,'',`${label}: confirmation cleared`);
    assert.equal(t.$('preview').hidden,true,`${label}: preview cleared`);
  }
});
await regression('submit re-fetches the feed and re-checks eligibility first; a changed feed cancels the submit (no RPC)',async()=>{
  const t=await boot();await previewed(t);
  const before=t.feedCalls();
  t.net.feeds[3]=projected([denKc(),finalGame('BUF','CIN','401437947','27','24')]);
  await t.click('submitBtn');
  assert.equal(t.feedCalls(),before+1,'the feed is fetched again before submitting');
  assert.equal(t.db.rpcCalls.length,0,'nothing is sent');
  assert.match(t.$('message').textContent,/changed/i);assert.equal(t.$('preview').hidden,true);assert.equal(t.$('submitBtn').disabled,true);
  for(const [label,feed] of [['status',projected([denKc(),bufCin('STATUS_POSTPONED','pre')])],['event id',projected([denKc(),{...bufCin(),id:'401437999'}])],['matchup',projected([denKc()])]]){
    const u=await boot();await previewed(u);u.net.feeds[3]=feed;await u.click('submitBtn');
    assert.equal(u.db.rpcCalls.length,0,`${label}: cancelled`);
  }
});
await regression('submit re-reads the chain and the policy; another tab\'s write or a new revision cancels the submit (no RPC)',async()=>{
  const t=await boot();await previewed(t);
  t.db.tables.nfl_incident_rulings.push(...pkChain(['void']));
  await t.click('submitBtn');
  assert.equal(t.db.rpcCalls.length,0);assert.match(t.$('message').textContent,/changed/i);
  const p=await boot();await previewed(p);
  p.db.tables.nfl_contest_policies=[policyRow(PK,'pickem','void'),policyRow(PK,'pickem','void',{revision:2,effective_week:3,created_at:'2026-08-01T00:00:00+00:00'}),...svPolicies()];
  await p.click('submitBtn');assert.equal(p.db.rpcCalls.length,0);
});
await regression('double-click: one RPC call, one row',async()=>{
  const t=await boot();await previewed(t);
  await Promise.all([t.$('submitBtn').dispatch('click'),t.$('submitBtn').dispatch('click'),t.$('submitBtn').dispatch('click')]);await flush();
  assert.equal(t.db.rpcCalls.length,1);assert.equal(t.db.tables.nfl_incident_rulings.length,1);
});
await regression('STALE_POLICY and STALE_CHAIN: the fixed message, nothing retried, a new preview is required',async()=>{
  for(const token of ['HDC13_STALE_POLICY','HDC13_STALE_CHAIN']){
    const t=await boot({rpc:()=>async()=>tokenError(token)});await previewed(t);await t.click('submitBtn');
    assert.equal(t.db.rpcCalls.length,1,`${token}: no automatic retry`);
    assert.equal(t.$('message').textContent,need().HDC13_ERROR_TEXT[token]);
    assert.equal(t.$('preview').hidden,true);assert.equal(t.$('submitBtn').disabled,true);
  }
});
await regression('every known token shows its fixed message as text',async()=>{
  for(const token of TOKENS){
    const t=await boot({rpc:()=>async()=>tokenError(token,token==='HDC13_NOT_COMMISSIONER'?'42501':'P0001')});await previewed(t);await t.click('submitBtn');
    assert.equal(t.$('message').textContent,need().HDC13_ERROR_TEXT[token],token);assert.equal(t.db.rpcCalls.length,1,token);
  }
});
await regression('an unknown error is shown as plain text, never as HTML',async()=>{
  const evil='<img src=x onerror=alert(1)>refused';
  const t=await boot({rpc:()=>async()=>({data:null,error:{code:'23514',message:evil,hint:null}})});await previewed(t);await t.click('submitBtn');
  assert(t.$('message').textContent.includes(evil),'the database text is shown as text');
  assert(![...['message','result','previewSummary','previewBefore','previewAfter','candidateInfo','probeResult','feedState']].some(id=>t.$(id).innerHTML.includes('<img src=x')),'never injected as HTML');
});
await regression('lost response: the chain is read back and classified LANDED, NOT WRITTEN (retry after a new preview) or CHANGED',async()=>{
  const lost={data:null,error:{code:'',message:'TypeError: Failed to fetch',hint:'',details:''}};
  const landed=await boot({rpc:db=>async(fn,a)=>{await serverRpc(db)(fn,a);return lost}});await previewed(landed);await landed.click('submitBtn');
  assert.match(landed.$('message').textContent,/LANDED/);assert.equal(landed.db.rpcCalls.length,1);
  const notWritten=await boot({rpc:()=>async()=>lost});await previewed(notWritten);await notWritten.click('submitBtn');
  assert.match(notWritten.$('message').textContent,/NOT WRITTEN/);assert.equal(notWritten.$('submitBtn').disabled,true);assert.equal(notWritten.$('previewBtn').disabled,false,'a new preview can be built');
  await notWritten.click('previewBtn');await notWritten.input('confirmMatchup','BUF @ CIN');
  notWritten.db.rpc=serverRpc(notWritten.db);await notWritten.click('submitBtn');
  assert.equal(notWritten.db.rpcCalls.length,2,'the operator retried after a new preview');assert.equal(notWritten.db.tables.nfl_incident_rulings.length,1);
  const changed=await boot({rpc:db=>async()=>{db.tables.nfl_incident_rulings.push(...pkChain(['void']).map(r=>({...r,public_note:'Another tab.'})));return lost}});
  await previewed(changed);await changed.click('submitBtn');
  assert.match(changed.$('message').textContent,/CHANGED/);assert.equal(changed.$('preview').hidden,true);assert.equal(changed.$('submitBtn').disabled,true);
});
await regression('read-back: an actual AFTER that differs from the preview shows a mismatch warning and nothing is retried',async()=>{
  const t=await boot();t.db.serverNote='A note the server stored differently.';await previewed(t);await t.click('submitBtn');
  assert.match(t.$('result').textContent,/does not match the preview/i);assert.equal(t.db.rpcCalls.length,1);
});
await regression('write-access check: a withdraw with the impossible parent; HDC13_STALE_CHAIN confirms access and 0 rows written',async()=>{
  const t=await boot();await t.change('contestSelect',PK);await t.change('weekSelect',3);await t.click('loadBtn');
  const rows=t.db.tables.nfl_incident_rulings.length;
  await t.click('probeBtn');
  assert.equal(t.db.rpcCalls.length,1);const {args}=t.db.rpcCalls[0];exact13(args);
  assert.deepEqual([args.p_action,args.p_expected_parent_ruling_id,args.p_consequence,args.p_event_id,args.p_contest_id],['withdraw',9007199254740991,null,null,PK]);
  assert.equal(t.db.tables.nfl_incident_rulings.length,rows,'0 rows written');
  assert.match(t.$('probeResult').textContent,/HDC13_STALE_CHAIN/);assert.match(t.$('probeResult').textContent,/0 rows written/);
  const denied=await boot({rpc:()=>async()=>tokenError('HDC13_NOT_COMMISSIONER','42501')});await denied.change('contestSelect',PK);await denied.change('weekSelect',3);await denied.click('loadBtn');
  await denied.click('probeBtn');assert.match(denied.$('probeResult').textContent,/not authorized/i);
});
await regression('reaffirm is offered only UNDER REVIEW; withdraw requires both notes and the typed matchup',async()=>{
  const review=await boot({tables:{nfl_incident_rulings:pkChain(['void'])},feeds:{3:projected([denKc(),finalGame('BUF','CIN','401437947','27','24')])}});
  await ready(review,{action:null});assert.deepEqual(review.options('actionSelect'),['reaffirm','withdraw']);
  const t=await boot({tables:{nfl_incident_rulings:pkChain(['void'])}});
  await ready(t,{action:'withdraw',consequence:null,adminNote:''});await t.click('previewBtn');
  assert.equal(t.$('preview').hidden,true,'no preview without the private note');assert.match(t.$('message').textContent,/private note/i);
  await t.input('adminNote','Ruled in error.');await t.click('previewBtn');await t.input('confirmMatchup','BUF @ CIN');
  await t.click('submitBtn');
  assert.equal(t.db.rpcCalls.length,1);assert.deepEqual([t.db.rpcCalls[0].args.p_action,t.db.rpcCalls[0].args.p_expected_parent_ruling_id],['withdraw',1]);
  assert.deepEqual(t.db.tables.nfl_incident_rulings.map(r=>r.consequence),['void','withdrawn']);
});
await regression('Survivor end to end: advance_team_used from the Survivor snapshot weeks, with every snapshot week read through nflscores2',async()=>{
  const feeds={1:projected(svFeeds()[1].events),2:projected(svFeeds()[2].events)};
  const t=await boot({feeds});await t.change('contestSelect',SV);
  assert.deepEqual(t.options('weekSelect'),['1','2']);
  await t.change('weekSelect',2);await t.click('loadBtn');
  assert(t.options('matchupSelect').includes('SF@ARI'));
  await t.change('matchupSelect','SF@ARI');assert.deepEqual(t.options('consequenceSelect'),['advance_team_used']);
  await t.input('publicNote','Canceled; pickers advance.');await t.click('previewBtn');
  assert.match(t.$('previewAfter').innerHTML,/ALIVE/);
  await t.input('confirmMatchup','sf @ ari');await t.click('submitBtn');
  assert.equal(t.db.rpcCalls.length,1);assert.equal(t.db.rpcCalls[0].args.p_consequence,'advance_team_used');assert.equal(t.db.rpcCalls[0].args.p_event_id,'401547001');
  assert(t.net.calls.filter(u=>u.startsWith(NFLSCORES2)).length>=4,'Weeks 1 and 2 at load and again before submitting');
});
await regression('no background polling: the Admin never starts an interval timer',async()=>{
  const t=await boot();await previewed(t);await t.click('submitBtn');
  assert.equal(t.intervals.length,0);assert.doesNotMatch(adminSource,/setInterval/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 12. The page itself: mobile and static accessibility, script order, navigation, network-only under the service worker.
// ---------------------------------------------------------------------------------------------------------------------
await regression('rulings.html: language, viewport, title, labelled controls, a live message region, buttons that never submit a form',()=>{
  assert(pageHtml,'rulings.html must exist');
  assert.match(pageHtml,/<html lang="en">/);assert.match(pageHtml,/<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">/);
  assert.match(pageHtml,/<title>Pool Center · Incident Rulings<\/title>/);
  for(const id of ['contestSelect','weekSelect','matchupSelect','actionSelect','consequenceSelect','publicNote','adminNote','confirmMatchup','otp']){
    assert.match(pageHtml,new RegExp(`id="${id}"`),`${id} exists`);
    assert(new RegExp(`<label[^>]*for="${id}"`).test(pageHtml)||new RegExp(`id="${id}"[^>]*aria-label=`).test(pageHtml),`${id} is labelled`);
  }
  assert.match(pageHtml,/id="message"[^>]*role="status"[^>]*aria-live="polite"|id="message"[^>]*aria-live="polite"[^>]*role="status"/);
  for(const m of pageHtml.matchAll(/<button\b[^>]*>/g))assert.match(m[0],/type="button"/,`every button is type="button": ${m[0]}`);
  assert.match(pageHtml,/id="publicNote"[^>]*maxlength="500"/);assert.match(pageHtml,/<textarea[^>]*id="adminNote"[^>]*maxlength="2000"/);
  assert.doesNotMatch(pageHtml,/\son[a-z]+="/i,'no inline event handlers');
});
await regression('rulings.html loads score-feed-proxy.js before the module and never a public page runtime',()=>{
  assert(pageHtml,'rulings.html must exist');
  const scripts=[...pageHtml.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)].map(m=>m[1]);
  assert.deepEqual(scripts,['../score-feed-proxy.js?v=2','rulings-admin.js?v=2'],'HDC-14 loads rulings-admin.js v2');
  assert.match(pageHtml,/<script type="module" src="rulings-admin\.js\?v=2"><\/script>/);
  assert.doesNotMatch(pageHtml+(adminSource||''),/weekly-app\.js|survivor-app\.js/);
  assert.match(pageHtml,/href="admin\.css\?v=premium-v3"/);assert.match(pageHtml,/href="\.\/"/);assert.match(pageHtml,/href="survivor\.html"/);
});
await regression('rulings-admin.js uses the existing Neon client and auth pattern and imports only incident-rulings.js v2 (HDC-14)',()=>{
  assert(adminSource,'rulings-admin.js must exist');
  const imports=[...adminSource.matchAll(/^\s*import\b[^;]*?from\s*'([^']+)'/gm)].map(m=>m[1]);
  assert.deepEqual(imports,['https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm','./incident-rulings.js?v=2']);
  assert.match(adminSource,/neon\.auth\.emailOtp\.sendVerificationOtp\(\{email:ADMIN_EMAIL,type:'sign-in'\}\)/);
  assert.match(adminSource,/neon\.rpc\(RPC_FUNCTION,/);
  assert.doesNotMatch(adminSource,/(?<!\w)admin_note|created_by|\.innerHTML\s*=\s*[^;]*\berror\b/,'never reads private columns; never renders an error as HTML');
});
await regression('the Pick\'em and Survivor Admin pages link to the incident rulings page',()=>{
  for(const file of ['./index.html','./survivor.html']){const html=read(file);assert(html,`${file} exists`);assert.match(html,/<a href="rulings\.html" class="back">Incident Rulings<\/a>/,file)}
});
await regression('the new Admin files are network-only under the unchanged service worker (no cache roll)',async()=>{
  const sw=read('../service-worker.js'),listeners={},network=[];
  vm.runInNewContext(sw,{self:{addEventListener:(t,f)=>{listeners[t]=f},location:{origin:'https://r88510179-collab.github.io'}},
    caches:{open:async()=>{throw new Error('no cache for Admin')},match:async()=>{throw new Error('no cache for Admin')}},fetch:r=>{network.push(r.url);return Promise.resolve({ok:true})},URL,Request,Promise,console});
  for(const path of ['/nfl-pool/admin/rulings.html','/nfl-pool/admin/rulings-admin.js?v=1','/nfl-pool/admin/incident-rulings.js?v=1']){
    let responded=null;listeners.fetch({request:{method:'GET',url:`https://r88510179-collab.github.io${path}`,mode:path.endsWith('.html')?'navigate':'cors'},respondWith:p=>{responded=p}});
    assert(responded,`${path} is answered by the worker`);await responded;assert(network.includes(`https://r88510179-collab.github.io${path}`),`${path} goes to the network`);
  }
  assert.doesNotMatch(sw,/rulings\.html|rulings-admin|incident-rulings/,'the new Admin files are not precached');
});

// ---------------------------------------------------------------------------------------------------------------------
// 13. Pick'em tiebreak preview parity. The tiebreak belongs to the week, not to the previewed game: weekly-app.js voids it
// exactly when the game at config.tiebreakGameIndex is VOID (games[TIEBREAK_INDEX].void), whichever game a ruling names.
// The child-branch rehearsal found the Admin preview reading it from the previewed game instead: voiding KC @ DEN (game 0)
// or NO @ ATL showed "tiebreak game void: no tiebreak this week" while the public page kept the CAR @ CHI tiebreak active.
// Each scenario compares, for the same rows and feed before and after the hypothetical row: pickemState's tiebreakVoid, the
// preview's tiebreak summary, the unmodified weekly-app.js (TB box, tiebreak note and footer) and the preview the unmodified
// rulings-admin.js renders. Fixture: a published Week 3 of four games; KC @ DEN, NO @ ATL and CAR @ CHI are halted and BUF @
// CIN is a final. The tiebreak game is CAR @ CHI (the last game, as in production) or, where a scenario says so, NO @ ATL (a
// middle game), so neither the first nor the last game can stand in for the configured one.
// ---------------------------------------------------------------------------------------------------------------------
const TB_GAMES=[
  {away:'KC',home:'DEN',eventId:'401437901',halted:['STATUS_CANCELED','post'],score:['17','20']},
  {away:'BUF',home:'CIN',eventId:'401437947',halted:null,score:['27','24']},
  {away:'NO',home:'ATL',eventId:'401437960',halted:['STATUS_POSTPONED','pre'],score:['13','16']},
  {away:'CAR',home:'CHI',eventId:'401437970',halted:['STATUS_CANCELED','post'],score:['20','23']}];
const CARCHI=3,NOATL=2,NO_TIEBREAK='tiebreak game void: no tiebreak this week';
const tbKey=g=>`${g.away}@${g.home}`,tbName=i=>`${TB_GAMES[i].away} @ ${TB_GAMES[i].home}`;
const tbConfig=(tiebreakGameIndex=CARCHI)=>({schemaVersion:1,season:2026,week:3,tiebreakGameIndex,
  games:TB_GAMES.map((g,i)=>({away:g.away,home:g.home,awayNumber:2*i+1,homeNumber:2*i+2,date:'2026-09-27',eventId:g.eventId})),
  participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1,3,5,7],tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2,4,6,8],tiebreak:44}]});
// The week's raw ESPN events: each game as listed above, unless `states` makes it 'final', 'scheduled' or 'forfeit'.
const tbEvents=(states={})=>TB_GAMES.map(g=>{
  const state=states[tbKey(g)]||(g.halted?'halted':'final');
  if(state==='final')return finalGame(g.away,g.home,g.eventId,...g.score);
  const type={halted:g.halted,scheduled:['STATUS_SCHEDULED','pre'],forfeit:['STATUS_FORFEIT','post']}[state];
  return espnEvent({id:g.eventId,away:g.away,home:g.home,type:espnType(...type)});
});
// A ruling chain of one fixture game, recording its halted status and its event.
const tbChain=(key,consequences,firstId)=>{const g=TB_GAMES.find(x=>tbKey(x)===key);
  return chainRows(PK,'pickem',{week:3,away:g.away,home:g.home,eventId:g.eventId,status:g.halted[0]},consequences,firstId)};
// The Admin preview of one offered action, and the rows the public page reads before and after it.
const tbPreview=({tiebreakGameIndex=CARCHI,rows=[],states={},key,action})=>{
  const config=tbConfig(tiebreakGameIndex),raw=tbEvents(states),events=pkEvents(...raw),data=pkData(rows),c=pkCandidate({config,events,data},key);
  assert.equal(c.actions[action].ok,true,`${key} ${action} is offered (${c.actions[action].reason})`);
  const request=requestFor(c,action,{consequence:action==='rule'||action==='rerule'?'void':null}),rulingId=rows.reduce((m,r)=>Math.max(m,r.ruling_id),0)+1;
  const p=need().pickemPreview({contestId:PK,season:2026,week:3,config,events,data,request,candidate:c,rulingId,createdAt:CREATED});
  return{config,raw,p,before:rows,after:[...rows,need().hypotheticalRow(request,{contestType:'pickem',chain:c.chain,rulingId,createdAt:CREATED})]};
};
// The tiebreak as the unmodified weekly-app.js shows it. The page states it one way everywhere: the TB box reads VOID exactly
// when the tiebreak note and the footer say there is no tiebreak this week.
const publicTiebreak=async({config,rows,events})=>{
  const $=await bootPage('weekly-app.js',{view:'home',weekRows:[pkWeekRow(config)],store:{nfl_contests:CONTESTS.filter(c=>c.contest_id===PK),
    nfl_contest_policies:pkPolicies(),nfl_incident_rulings:rows},feedFor:()=>projected(events)});
  const mnf=$('mnf').textContent,note=$('tbNote').textContent,footer=$('footerRule').textContent,tbVoid=mnf==='VOID';
  assert.equal(/no tiebreak this week/.test(note),tbVoid,`weekly-app: the tiebreak note agrees with the TB box ${mnf}: ${note}`);
  assert.equal(/tiebreak game voided by commissioner ruling: no tiebreak this week/.test(footer),tbVoid,`weekly-app: the footer agrees with the TB box ${mnf}: ${footer}`);
  const cells=Object.fromEntries($('pickBody').innerHTML.split('</tr>').filter(r=>r.includes('<td class="name">'))
    .map(r=>[r.match(/<td class="name">([^<]*)<\/td>/)[1],[...r.matchAll(/<td class="c ([a-z ]+)">/g)].map(m=>m[1])]));
  return{tbVoid,mnf,note,footer,cells,standings:$('standings').innerHTML};
};
// Whether the preview the unmodified rulings-admin.js renders (fake DOM, mock Neon, real score-feed-proxy.js) says there is
// no tiebreak this week, before and after.
const renderedTiebreak=async({tiebreakGameIndex=CARCHI,rows=[],states={},key,action})=>{
  const t=await boot({tables:{nfl_pool_weeks:[pkWeekRow(tbConfig(tiebreakGameIndex))],nfl_incident_rulings:rows},feeds:{3:projected(tbEvents(states))}});
  await ready(t,{matchup:key,action,adminNote:action==='withdraw'||action==='rerule'?ADMIN_NOTE:''});await t.click('previewBtn');
  assert.equal(t.$('preview').hidden,false,`${key} ${action}: the Admin page builds the preview (${t.$('message').textContent})`);
  return[t.$('previewBefore').innerHTML,t.$('previewAfter').innerHTML].map(html=>html.includes(NO_TIEBREAK));
};
// One scenario: every reading of the week's tiebreak must be `expected`, [before, after] the previewed action.
const tiebreakParity=async(scenario,expected)=>{
  const {config,raw,p,before,after}=tbPreview(scenario);
  const pub=[await publicTiebreak({config,rows:before,events:raw}),await publicTiebreak({config,rows:after,events:raw})];
  const got={pickemState:[p.before.tiebreakVoid,p.after.tiebreakVoid],preview:[p.tiebreak.beforeVoid,p.tiebreak.afterVoid],
    weeklyApp:pub.map(x=>x.tbVoid),rendered:await renderedTiebreak(scenario)};
  const want=JSON.stringify({pickemState:expected,preview:expected,weeklyApp:expected,rendered:expected});
  assert(JSON.stringify(got)===want,`tiebreak void [before, after]: expected ${want}, got ${JSON.stringify(got)}`);
  return{p,pub};
};
const tbIncident=(side,i)=>side.rules.incidents.filter(x=>x.matchup===tbName(i)).map(x=>[x.status,x.history.length]);

// 1. A VOID of a game that is not the tiebreak game leaves the tiebreak active, as the public page keeps it: the tiebreak game
// scheduled, final (its total and the tiebreak differences stay in use) or halted without a ruling.
for(const [tiebreakGameIndex,tiebreakState,key] of [[CARCHI,'scheduled','KC@DEN'],[CARCHI,'scheduled','NO@ATL'],[CARCHI,'final','KC@DEN'],
  [CARCHI,'final','NO@ATL'],[CARCHI,'halted','KC@DEN'],[NOATL,'halted','KC@DEN'],[NOATL,'halted','CAR@CHI']])
  await regression(`tiebreak parity 1: voiding ${key.replace('@',' @ ')}, not the tiebreak game, keeps the ${tbName(tiebreakGameIndex)} tiebreak (${tiebreakState}) active, as weekly-app.js does`,async()=>{
    const {away,home}=TB_GAMES[tiebreakGameIndex],states=tiebreakState==='halted'?{}:{[`${away}@${home}`]:tiebreakState};
    const {p,pub}=await tiebreakParity({tiebreakGameIndex,states,key,action:'rule'},[false,false]);
    assert.deepEqual([p.tiebreak.isTiebreakGame,p.after.effect.kind,p.after.game?.void],[false,'void',true],'the previewed game is VOID after');
    assert.equal(need().previewOutcome(p.after).tiebreakVoid,false,'the outcome the read-back compares keeps the tiebreak active');
    const gi=TB_GAMES.findIndex(g=>tbKey(g)===key);
    assert.deepEqual(Object.values(pub[1].cells).map(row=>row[gi]),['void','void'],'weekly-app shows the previewed game VOID after');
    for(const x of pub){
      assert.notEqual(x.mnf,'VOID');assert.doesNotMatch(`${x.note} ${x.footer}`,/no tiebreak|tiebreak game void/,'weekly-app keeps the tiebreak');
      assert(x.footer.includes(`${away}–${home} tiebreak activates when that game is final.`),x.footer);
      if(tiebreakState==='final'){
        assert.deepEqual([x.mnf,x.note],['43','Tiebreak final total: 43. Tiebreak differences are active.'],'the tiebreak total stays in use');
        assert.match(x.standings,/Δ 2<\/span>/);assert.match(x.standings,/Δ 1<\/span>/);
      }else assert.deepEqual([x.mnf,x.note],['—','Tiebreak guesses: D.C. 41 · DJS 44.']);
    }
  });
// 2. Voiding the configured tiebreak game voids the week's tiebreak. (The BUF @ CIN tiebreak-game regressions in sections 8 and
// 9 are unchanged.)
for(const [tiebreakGameIndex,key] of [[CARCHI,'CAR@CHI'],[NOATL,'NO@ATL']])
  await regression(`tiebreak parity 2: voiding the tiebreak game ${tbName(tiebreakGameIndex)} voids the week's tiebreak, as weekly-app.js does`,async()=>{
    const {p,pub}=await tiebreakParity({tiebreakGameIndex,key,action:'rule'},[false,true]);
    assert.equal(p.tiebreak.isTiebreakGame,true);
    assert(pub[1].footer.includes(`${tbName(tiebreakGameIndex).replace(' @ ','–')} tiebreak game voided by commissioner ruling: no tiebreak this week.`),pub[1].footer);
  });
// 3. The tiebreak game already has an active VOID: previewing a ruling on another game shows no tiebreak before and after,
// and leaves the tiebreak game's chain as it was.
for(const [tiebreakGameIndex,key] of [[CARCHI,'KC@DEN'],[CARCHI,'NO@ATL'],[NOATL,'KC@DEN'],[NOATL,'CAR@CHI']])
  await regression(`tiebreak parity 3: with the tiebreak game ${tbName(tiebreakGameIndex)} already VOID, previewing ${key.replace('@',' @ ')} shows no tiebreak before and after, as weekly-app.js does`,async()=>{
    const {p}=await tiebreakParity({tiebreakGameIndex,rows:tbChain(tbKey(TB_GAMES[tiebreakGameIndex]),['void'],1),key,action:'rule'},[true,true]);
    assert.equal(p.tiebreak.isTiebreakGame,false);
    for(const side of [p.before,p.after])assert.deepEqual(tbIncident(side,tiebreakGameIndex),[['APPLIED',1]],'the tiebreak chain is unchanged');
  });
// 4. The tiebreak game's VOID was withdrawn: the tiebreak is active again while another game is previewed.
for(const [tiebreakGameIndex,key] of [[CARCHI,'KC@DEN'],[NOATL,'CAR@CHI']])
  await regression(`tiebreak parity 4: with the tiebreak game ${tbName(tiebreakGameIndex)}'s VOID withdrawn, previewing ${key.replace('@',' @ ')} keeps the tiebreak active, as weekly-app.js does`,async()=>{
    const {p}=await tiebreakParity({tiebreakGameIndex,rows:tbChain(tbKey(TB_GAMES[tiebreakGameIndex]),['void','withdrawn'],1),key,action:'rule'},[false,false]);
    for(const side of [p.before,p.after])assert.deepEqual(tbIncident(side,tiebreakGameIndex),[['WITHDRAWN',2]],'the tiebreak chain is unchanged');
  });
// 5. A tiebreak-game ruling the feed makes unusable (a forfeit) holds that game; a HOLD is not a VOID, so the tiebreak is not
// voided while another game is previewed.
await regression('tiebreak parity 5: a held tiebreak game (its VOID made unusable by a forfeit) is no voided tiebreak while KC @ DEN is previewed, as weekly-app.js does',async()=>{
  const {p}=await tiebreakParity({rows:tbChain('CAR@CHI',['void'],1),states:{'CAR@CHI':'forfeit'},key:'KC@DEN',action:'rule'},[false,false]);
  for(const side of [p.before,p.after])assert.deepEqual(tbIncident(side,CARCHI),[['HOLD',1]],'the tiebreak ruling is on hold');
});
// 6. The tiebreak game's own chain through every action: rule VOID -> no tiebreak; reaffirm (UNDER REVIEW) -> still none;
// withdraw -> the tiebreak is active again; re-rule VOID -> none again.
for(const [action,rows,states,expected] of [['rule',[],{},[false,true]],['reaffirm',tbChain('CAR@CHI',['void'],1),{'CAR@CHI':'final'},[true,true]],
  ['withdraw',tbChain('CAR@CHI',['void'],1),{},[true,false]],['rerule',tbChain('CAR@CHI',['void','withdrawn'],1),{},[false,true]]])
  await regression(`tiebreak parity 6: ${action} on the tiebreak game CAR @ CHI takes the tiebreak void from ${expected[0]} to ${expected[1]}, as weekly-app.js does`,async()=>{
    await tiebreakParity({rows,states,key:'CAR@CHI',action},expected);
  });
// 7. Another game's chain through every action never changes the tiebreak: active stays active, void stays void.
for(const [tiebreak,tiebreakRows] of [['active',[]],['void',tbChain('CAR@CHI',['void'],1)]])
  for(const [action,rows,states] of [['rule',[],{}],['reaffirm',tbChain('KC@DEN',['void'],11),{'KC@DEN':'final'}],
    ['withdraw',tbChain('KC@DEN',['void'],11),{}],['rerule',tbChain('KC@DEN',['void','withdrawn'],11),{}]])
    await regression(`tiebreak parity 7: ${action} on KC @ DEN leaves the CAR @ CHI tiebreak ${tiebreak}, as weekly-app.js does`,async()=>{
      await tiebreakParity({rows:[...tiebreakRows,...rows],states,key:'KC@DEN',action},[tiebreak==='void',tiebreak==='void']);
    });

// ---------------------------------------------------------------------------------------------------------------------
// 14. HDC-14: absent-game adjudication. Week 12 of the 2026 Pick'em contest publishes DEN @ KC and PIT @ TEN (event
// 401438121); the Week 12 feed no longer lists PIT @ TEN (the 2020 Week 4 shape: it later appears as a distinct Week 13
// event). The normal HDC-13 path still refuses it; the separate absent-game path (public.nfl_append_absent_incident_ruling)
// offers it, with server-derived evidence (STATUS_ABSENT, commissioner-attestation, the published event) and a typed
// confirmation naming the week, the matchup and the absence. Controls: a game canceled (2022) or postponed (2017) in place
// stays on the HDC-13 path, and HDC-14 is not offered. No other week is ever read.
// ---------------------------------------------------------------------------------------------------------------------
const ABSENT_RPC='nfl_append_absent_incident_ruling';
const HDC14_TOKENS=['HDC14_NOT_COMMISSIONER','HDC14_ISOLATION','HDC14_INVALID_INPUT','HDC14_STALE_POLICY','HDC14_STALE_CHAIN','HDC14_INVALID_TRANSITION',
  'HDC14_NOT_ABSENCE_CHAIN','HDC14_NOT_PERMITTED','HDC14_NOT_PUBLISHED','HDC14_EVENT_MISMATCH','HDC14_ABSENCE_NOT_ATTESTABLE'];
const PITTEN={week:12,away:'PIT',home:'TEN',eventId:'401438121'};
const pk12Config=({tiebreakGameIndex=0,eventIds=true,extraGames=[]}={})=>({schemaVersion:1,season:2026,week:12,tiebreakGameIndex,
  games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-11-29',...(eventIds?{eventId:'401438140'}:{})},
    {away:'PIT',home:'TEN',awayNumber:3,homeNumber:4,date:'2026-11-29',...(eventIds?{eventId:'401438121'}:{})},...extraGames],
  participants:[{id:'dc',displayName:'D.C.',pickNumbers:[1,3],tiebreak:41},{id:'djs',displayName:'DJS',pickNumbers:[2,4],tiebreak:44}]});
const pk12Row=(config=pk12Config(),o={})=>({season:2026,week:12,status:'locked',revision:1,config,...o});
const denKc12=(as='24',hs='17')=>finalGame('DEN','KC','401438140',as,hs,12);
const pitTen12=(name='STATUS_POSTPONED',state='pre',o={})=>espnEvent({id:'401438121',away:'PIT',home:'TEN',week:12,type:espnType(name,state),...o});
const pk12Events=(...events)=>projected(events.length?events:[denKc12()]).events;
const absentChain=(consequences,o={},firstId=1)=>chainRows(PK,'pickem',{...PITTEN,status:'STATUS_ABSENT'},consequences,firstId)
  .map(r=>({...r,evidence_source:'commissioner-attestation',...o}));
const feedChain12=consequences=>chainRows(PK,'pickem',{...PITTEN,status:'STATUS_POSTPONED'},consequences);
const pk12Candidates=({config=pk12Config(),events=pk12Events(),source='nflscores2',data=pkData()}={})=>
  need().pickemCandidates({contestId:PK,season:2026,week:12,config,events,source,data});
const pk12Candidate=(o={},key='PIT@TEN')=>{const c=pk12Candidates(o).find(x=>x.key===key);assert(c,`candidate ${key} is discovered`);return c};
const absentOffered=c=>need().ACTIONS.filter(a=>c.absence?.actions?.[a]?.ok);
const ABSENT_NOTE='PIT @ TEN left the Week 12 feed; void for this contest.';
const absentRequestFor=(c,action,o={})=>{
  const out=need().buildAbsentRequest({contestId:o.contestId||(c.contestType==='survivor'?SV:PK),week:c.week,candidate:c,action,consequence:o.consequence??null,
    publicNote:o.publicNote??ABSENT_NOTE,adminNote:o.adminNote??(action==='withdraw'||action==='rerule'?ADMIN_NOTE:null)});
  assert(out.ok,`absent-game request builds: ${out.reason}`);return out.request;
};
const exact10=r=>{
  assert.deepEqual(Object.keys(r),ABSENT_ARGS,'exactly the 10 approved absent-game keys, in order');
  for(const k of [...FORBIDDEN,'p_incident_status','p_event_id','p_evidence_source'])assert(!(k in r),`never sends ${k}`);
};
// Survivor: the Week-2 SF @ ARI game (event 401547001) is no longer in the Week 2 feed; the same-week locked Pick'em slate
// (2026 Week 2, revision 4) publishes it exactly once. D.C. picked SF, survivor-003 ARI.
const svAbsentFeeds=()=>({1:svWeek(W1,1),2:svWeek(W2.filter(([a])=>a!=='SF'),2)});
const svSlate=(games=[['SF','ARI','401547001'],['ATL','BAL','401547010']],o={})=>({season:2026,week:2,status:'locked',revision:4,config:{schemaVersion:1,season:2026,week:2,
  tiebreakGameIndex:0,games:games.map(([away,home,eventId],i)=>({away,home,awayNumber:2*i+1,homeNumber:2*i+2,...(eventId?{eventId}:{})})),participants:[]},...o});
const svAbsentCandidates=({config=svConfig(),feeds=svAbsentFeeds(),slate=svSlate(),source='nflscores2',data=svData()}={})=>
  need().survivorCandidates({contestId:SV,season:2026,week:2,snapshot:{week:config.week,config},events:svEventsByWeek(feeds)[1],source,data,slate});
const svAbsentChain=(consequences,o={})=>chainRows(SV,'survivor',{...SFARI,status:'STATUS_ABSENT'},consequences).map(r=>({...r,evidence_source:'commissioner-attestation',...o}));

await regression('HDC-14 module surface: the absent-game RPC, its 10 arguments, its fixed error messages and its helpers',()=>{
  const m=need();
  assert.equal(m.ABSENT_RPC_FUNCTION,ABSENT_RPC);
  assert.deepEqual([...(m.ABSENT_RPC_ARGUMENTS||[])],ABSENT_ARGS);
  assert.deepEqual(Object.keys(m.HDC14_ERROR_TEXT||{}).sort(),[...HDC14_TOKENS].sort(),'a fixed message for every HDC14 token');
  for(const token of HDC14_TOKENS)assert.match(m.HDC14_ERROR_TEXT[token],/Nothing was written/,token);
  for(const name of ['buildAbsentRequest','absentWriteProbeRequest','absentHypotheticalRow','absencePhrase','absentActionPhrase','classifyAbsentReadBack','absentProbeOutcome','survivorAbsentPicks'])
    assert.equal(typeof m[name],'function',`exports ${name}()`);
  assert.equal(m.ABSENT_INCIDENT_STATUS,'STATUS_ABSENT');assert.equal(m.ATTESTATION_SOURCE,'commissioner-attestation');
  assert.equal(m.RPC_FUNCTION,'nfl_append_incident_ruling','the HDC-13 function is unchanged');assert.deepEqual([...m.RPC_ARGUMENTS],RPC_ARGUMENTS);
});
await regression('HDC-14 Control C (the 2020 shape): PIT @ TEN absent from the Week 12 feed is refused by HDC-13 and offered by HDC-14, labelled ABSENT FROM ORIGINAL WEEK FEED',()=>{
  const c=pk12Candidate();
  assert.equal(c.actions.rule.ok,false,'the normal first ruling stays refused');assert.match(c.actions.rule.reason,HDC14);
  assert.equal(c.absence?.eligible,true,c.absence?.reason);assert.deepEqual(absentOffered(c),['rule']);
  assert.equal(c.absence.label,'ABSENT FROM ORIGINAL WEEK FEED');
  assert.deepEqual(c.absence.evidence,{incidentStatus:'STATUS_ABSENT',eventId:'401438121',evidenceSource:'commissioner-attestation'},'server-derived: the published event, never a feed status');
  assert.deepEqual(c.consequences,['void']);
  const den=pk12Candidate({},'DEN@KC');
  assert.equal(den.absence.eligible,false,'a listed final is never absent');assert.deepEqual(absentOffered(den),[]);
  const bare=pk12Candidate({config:pk12Config({eventIds:false})});
  assert.equal(bare.absence.eligible,true);assert.equal(bare.absence.evidence.eventId,null,'no published event: none is fabricated');
});
await regression('HDC-14 Controls A and B: a game canceled (2022) or postponed (2017) in its own week stays on the HDC-13 path; HDC-14 is not offered',()=>{
  for(const [label,event] of [['canceled in place',pitTen12('STATUS_CANCELED','post')],['postponed in place, makeup elsewhere',pitTen12('STATUS_POSTPONED','pre')]]){
    const c=pk12Candidate({events:pk12Events(denKc12(),event)});
    assert.equal(c.actions.rule.ok,true,`${label}: HDC-13 offers its rule (${c.actions.rule.reason})`);
    assert.equal(c.absence.eligible,false,`${label}: HDC-14 is not offered`);assert.deepEqual(absentOffered(c),[],label);
  }
});
await regression('HDC-14 fails closed: a reversed, re-paired, relisted, conflicting, unreadable, forfeited or out-of-context listing in the week is not an absence',()=>{
  const broken={...pitTen12(),competitions:[{competitors:[{homeAway:'away',team:{abbreviation:'PIT'}}]}]};
  for(const [label,extra] of [['reversed (TEN @ PIT)',[espnEvent({id:'401438150',away:'TEN',home:'PIT',week:12,type:espnType('STATUS_SCHEDULED','pre')})]],
    ['PIT re-paired against NYG',[espnEvent({id:'401438151',away:'PIT',home:'NYG',week:12,type:espnType('STATUS_SCHEDULED','pre')})]],
    ['TEN re-paired against BUF',[espnEvent({id:'401438152',away:'BUF',home:'TEN',week:12,type:espnType('STATUS_SCHEDULED','pre')})]],
    ['the published event id listed for other teams',[espnEvent({id:'401438121',away:'NYG',home:'DAL',week:12,type:espnType('STATUS_SCHEDULED','pre')})]],
    ['relisted under two ids',[pitTen12(),{...pitTen12(),id:'401438153'}]],['conflicting copies',[pitTen12(),pitTen12('STATUS_IN_PROGRESS','in')]],
    ['an unreadable listing naming PIT',[broken]],['a forfeit',[pitTen12('STATUS_FORFEIT','post')]],
    ['the Week 13 makeup inside the Week 12 payload',[{...finalGame('PIT','TEN','401438199','24','27',13)}]]]){
    const c=pk12Candidate({events:pk12Events(denKc12(),...extra)});
    assert.equal(c.absence.eligible,false,label);assert.deepEqual(absentOffered(c),[],label);assert(c.absence.reason,`${label}: a reason`);
  }
  // The nflscores2 projection drops each listing's season and week; a payload that keeps them (the raw ESPN shape) can carry
  // a listing of the pair marked another week. That is never evidence of the Week 12 absence either.
  const outside=pk12Candidate({events:[...pk12Events(denKc12()),finalGame('PIT','TEN','401438199','24','27',13)]});
  assert.equal(outside.absence.eligible,false,'a listing of the pair outside the week context is no absence');assert.deepEqual(absentOffered(outside),[]);
});
await regression('HDC-14 fails closed on the evidence it rests on: an unknown feed source, an unreadable feed, a game not published exactly once, a policy that is not ready',()=>{
  for(const source of [null,'espn-scoreboard','nflscores'])assert.equal(pk12Candidate({source}).absence.eligible,false,`source ${source}`);
  assert.equal(pk12Candidate({events:null}).absence.eligible,false,'feed unreadable');
  const twice=pk12Candidates({config:pk12Config({extraGames:[{away:'PIT',home:'TEN',awayNumber:5,homeNumber:6,eventId:'401438160'}]})}).find(x=>x.key==='PIT@TEN');
  assert.equal(twice.absence.eligible,false,'published twice');
  const repaired=pk12Candidates({config:pk12Config({extraGames:[{away:'NYG',home:'PIT',awayNumber:5,homeNumber:6,eventId:'401438161'}]})}).find(x=>x.key==='PIT@TEN');
  assert.equal(repaired.absence.eligible,false,'PIT published in another game');
  const badPolicy=pk12Candidates({data:pkData([],[policyRow(PK,'pickem','eliminate')])});
  assert(badPolicy.every(c=>!c.absence.eligible&&!absentOffered(c).length),'no write while the policy history does not validate');
  const badEvent=pk12Candidate({config:pk12Config({extraGames:[]}),events:pk12Events()});
  assert.equal(badEvent.absence.eligible,true,'control: the published event id is an event id');
  const malformed=pk12Candidates({config:{...pk12Config(),games:pk12Config().games.map(g=>g.away==='PIT'?{...g,eventId:'4014x'}:g)}}).find(x=>x.key==='PIT@TEN');
  assert.equal(malformed.absence.eligible,false,'a published eventId that is not an event id is never recorded');
});
await regression('HDC-14 chain ownership: an absence chain offers only absent-game actions; a feed chain only HDC-13 actions',()=>{
  const active=pk12Candidate({data:pkData(absentChain(['void']))});
  assert.deepEqual(offered(active),[],'no HDC-13 action continues an absence chain');
  for(const a of ['reaffirm','withdraw','rerule'])assert.match(active.actions[a].reason,/absence|absent-game/i,a);
  assert.deepEqual(absentOffered(active),['withdraw'],'absent and APPLIED: withdraw only (reaffirm needs UNDER REVIEW)');
  assert.equal(active.absence.label,'ABSENT FROM ORIGINAL WEEK FEED');
  const review=pk12Candidate({data:pkData(absentChain(['void'])),events:pk12Events(denKc12(),finalGame('PIT','TEN','401438121','24','27',12))});
  assert(review.underReview,'listed again in Week 12: UNDER REVIEW');assert.deepEqual(absentOffered(review),['reaffirm','withdraw']);
  const withdrawn=pk12Candidate({data:pkData(absentChain(['void','withdrawn']))});
  assert.deepEqual(absentOffered(withdrawn),['rerule'],'still absent: re-rule is offered');assert.deepEqual(offered(withdrawn),[]);
  const listedAgain=pk12Candidate({data:pkData(absentChain(['void','withdrawn'])),events:pk12Events(denKc12(),pitTen12('STATUS_SCHEDULED','pre'))});
  assert.deepEqual(absentOffered(listedAgain),[],'no longer absent: no re-rule');
  const unread=pk12Candidate({data:pkData(absentChain(['void'])),events:null});
  assert.deepEqual(absentOffered(unread),['withdraw'],'a withdrawal never needs the feed');
  const feed=pk12Candidate({data:pkData(feedChain12(['void'])),events:pk12Events(denKc12(),pitTen12())});
  assert.deepEqual(offered(feed),['withdraw'],'the feed chain keeps its HDC-13 actions');assert.deepEqual(absentOffered(feed),[]);
  assert.match(feed.absence.actions.withdraw.reason,/feed evidence/i);
  const feedGone=pk12Candidate({data:pkData(feedChain12(['void','withdrawn']))});
  assert.deepEqual(absentOffered(feedGone),[],'a withdrawn feed chain is never re-ruled as an absence');
});
await regression('HDC-14 Survivor: the absent pick\'s matchup is proved by the same-week locked Pick\'em slate, never by the feed or another week',()=>{
  const list=svAbsentCandidates(),c=list.find(x=>x.key==='SF@ARI');
  assert(c,'SF @ ARI is discovered from the slate');
  assert.equal(c.absence.eligible,true,c.absence.reason);assert.deepEqual(absentOffered(c),['rule']);
  assert.deepEqual(c.absence.evidence,{incidentStatus:'STATUS_ABSENT',eventId:'401547001',evidenceSource:'commissioner-attestation'});
  assert.equal(c.absence.slateRevision,4);assert.equal(c.actions.rule.ok,false,'HDC-13 refuses');
  for(const [label,slate] of [['no slate',null],['the slate omits SF (a Thursday game the sheet leaves out)',svSlate([['ATL','BAL','401547010']])],
    ['SF twice on the slate',svSlate([['SF','ARI','401547001'],['SF','ARI','401547002']])],['ARI in another slate game',svSlate([['SF','ARI','401547001'],['ARI','DAL','401547003']])],
    ['a draft slate',svSlate(undefined,{status:'draft'})],['a slate of another week',svSlate(undefined,{week:3})],['a slate eventId that is not an event id',svSlate([['SF','ARI','4015x'],['ATL','BAL','401547010']])],
    ['a slate whose configuration names another week',{...svSlate(),config:{...svSlate().config,week:3}}],['another season',svSlate(undefined,{season:2025})]]){
    const found=svAbsentCandidates({slate}).find(x=>x.away==='SF'||x.home==='SF');
    assert(!found||!found.absence.eligible,`${label}: no absent-game ruling`);
    const report=need().survivorAbsentPicks({season:2026,week:2,snapshot:{week:2,config:svConfig()},events:svEventsByWeek(svAbsentFeeds())[1],slate});
    assert(report.some(r=>r.team==='SF'&&!r.provable&&r.reason),`${label}: SF is reported unprovable with a reason`);
  }
  // The slate is the only source of the matchup's orientation: a slate that publishes ARI @ SF proves ARI @ SF (the
  // orientation the absent-game function checks), and SF @ ARI is never offered.
  const reversed=svAbsentCandidates({slate:svSlate([['ARI','SF','401547001']])});
  assert.equal(reversed.some(x=>x.key==='SF@ARI'),false,'the reversed orientation is never offered');
  assert.equal(reversed.find(x=>x.key==='ARI@SF')?.absence?.eligible,true,"the slate's own orientation is the matchup");
  const opponentListed=svAbsentCandidates({feeds:{1:svWeek(W1,1),2:svWeek(W2.filter(([a])=>a!=='SF').concat([['ARI','DAL']]).filter(([a,h])=>!(a==='CLE'&&h==='DAL')),2)}}).find(x=>x.key==='SF@ARI');
  assert(!opponentListed?.absence?.eligible,'ARI listed against DAL that week: a re-pairing, never an absence');
  const listed=svCandidates().find(x=>x.key==='SF@ARI');
  assert.equal(listed.absence.eligible,false,'SF @ ARI listed (canceled) in its week: the HDC-13 path, not HDC-14');
  const report=need().survivorAbsentPicks({season:2026,week:2,snapshot:{week:2,config:svConfig()},events:svEventsByWeek(svAbsentFeeds())[1],slate:svSlate()});
  assert.deepEqual(report.map(r=>[r.team,r.provable,r.away,r.home]),[['ARI',true,'SF','ARI'],['SF',true,'SF','ARI']]);
});
await regression('HDC-14 requests: exactly the 10 approved keys, no evidence, explicit NULLs, the compare-and-swap tokens',()=>{
  const m=need(),rule=absentRequestFor(pk12Candidate(),'rule',{consequence:'void',adminNote:'  Checked the Week 12 feed.  '});
  exact10(rule);
  assert.deepEqual(rule,{p_contest_id:PK,p_week:12,p_away_team:'PIT',p_home_team:'TEN',p_action:'rule',p_consequence:'void',p_expected_policy_revision:1,
    p_expected_parent_ruling_id:null,p_public_note:ABSENT_NOTE,p_admin_note:'Checked the Week 12 feed.'});
  const withdraw=absentRequestFor(pk12Candidate({data:pkData(absentChain(['void','void']))}),'withdraw');
  exact10(withdraw);assert.deepEqual([withdraw.p_action,withdraw.p_consequence,withdraw.p_expected_parent_ruling_id,withdraw.p_admin_note],['withdraw',null,2,ADMIN_NOTE]);
  const rerule=absentRequestFor(pk12Candidate({data:pkData(absentChain(['void','withdrawn']))}),'rerule',{consequence:'void'});
  assert.deepEqual([rerule.p_action,rerule.p_consequence,rerule.p_expected_parent_ruling_id],['rerule','void',2]);
  const build=o=>m.buildAbsentRequest({contestId:PK,week:12,candidate:pk12Candidate(),publicNote:ABSENT_NOTE,adminNote:null,...o});
  assert.equal(build({action:'withdraw'}).ok,false,'withdraw on an empty chain');assert.equal(build({action:'rule',consequence:'eliminate'}).ok,false,"eliminate in Pick'em");
  assert.equal(build({action:'rule',consequence:'void',publicNote:''}).ok,false,'no public note');
  assert.equal(m.buildAbsentRequest({contestId:PK,week:12,candidate:pk12Candidate({events:pk12Events(denKc12(),pitTen12())}),action:'rule',consequence:'void',publicNote:ABSENT_NOTE}).ok,false,'not offered: the game is listed');
  assert.equal(build({action:'rule',consequence:'void',contestId:SV}).ok,false,'another contest');
  const probe=m.absentWriteProbeRequest({contestId:PK,week:12,away:'DEN',home:'KC',policyRevision:1});
  exact10(probe);assert.deepEqual([probe.p_action,probe.p_consequence,probe.p_expected_parent_ruling_id],['withdraw',null,9007199254740991]);
});
await regression('HDC-14 the hypothetical row: server-derived absence evidence on the root, the root copied on every later row, no private field',()=>{
  const m=need(),c=pk12Candidate(),row=m.absentHypotheticalRow(absentRequestFor(c,'rule',{consequence:'void'}),{contestType:'pickem',chain:c.chain,eventId:c.absence.evidence.eventId,rulingId:1,createdAt:CREATED});
  assert.deepEqual(Object.keys(row).sort(),[...PUBLIC_COLUMNS.rulings].sort());
  assert.deepEqual([row.incident_status,row.event_id,row.evidence_source,row.consequence,row.chain_seq,row.parent_ruling_id],['STATUS_ABSENT','401438121','commissioner-attestation','void',1,null]);
  const later=pk12Candidate({data:pkData(absentChain(['void'],{event_id:null}))});
  const w=m.absentHypotheticalRow(absentRequestFor(later,'withdraw'),{contestType:'pickem',chain:later.chain,eventId:'999',rulingId:2,createdAt:CREATED});
  assert.deepEqual([w.incident_status,w.event_id,w.evidence_source,w.consequence,w.parent_ruling_id],['STATUS_ABSENT',null,'commissioner-attestation','withdrawn',1],'a later row copies the root, never a new event');
});
await regression('HDC-14 typed confirmation names the week, the matchup and the absence; a generic or partial phrase never matches',()=>{
  const m=need(),c=pk12Candidate(),phrase=m.absencePhrase(c);
  assert.equal(phrase,'WEEK 12 PIT @ TEN ABSENT');
  assert.equal(m.absentActionPhrase(c,'rule'),phrase);assert.equal(m.absentActionPhrase(c,'rerule'),phrase);
  assert.equal(m.absentActionPhrase(c,'withdraw'),'PIT @ TEN');assert.equal(m.absentActionPhrase(c,'reaffirm'),'PIT @ TEN');
  for(const typed of ['WEEK 12 PIT @ TEN ABSENT','week 12 pit @ ten absent','  Week 12  PIT@TEN  Absent '])assert.equal(m.confirmationMatches(typed,phrase),true,typed);
  for(const typed of ['PIT @ TEN','CONFIRM','yes','WEEK 12 PIT @ TEN','WEEK 13 PIT @ TEN ABSENT','WEEK 12 TEN @ PIT ABSENT','WEEK 12 PIT @ TEN POSTPONED','',null])
    assert.equal(m.confirmationMatches(typed,phrase),false,String(typed));
});
const pk12PreviewOf=({action='rule',consequence='void',rows=[],events=pk12Events(),config=pk12Config()}={})=>{
  const m=need(),data=pkData(rows),c=pk12Candidate({data,events,config}),request=absentRequestFor(c,action,{consequence:action==='rule'||action==='rerule'?consequence:null});
  return{c,request,preview:m.pickemPreview({contestId:PK,season:2026,week:12,config,events,data,request,candidate:c,path:'absence',rulingId:rows.length+1,createdAt:CREATED})};
};
await regression("HDC-14 Pick'em preview: BEFORE pending and remaining, AFTER VOID; absence evidence; affected entries; record, remaining, tiebreak and Rules card",()=>{
  const {preview:p}=pk12PreviewOf();
  assert.deepEqual([p.before.effect.kind,p.after.effect.kind],['nfl','void']);
  assert.deepEqual([p.before.game?.completed,p.before.game?.void??false,p.after.game.void],[false,false,true],'BEFORE: the absent game is pending, never graded');
  assert.deepEqual(p.entries.map(e=>[e.name,e.pick,e.before.cell,e.after.cell]),[['D.C.','PIT','pending','void'],['DJS','TEN','pending','void']]);
  for(const e of p.entries)assert.deepEqual([e.after.w-e.before.w,e.after.l-e.before.l,e.after.left-e.before.left],[0,0,-1],e.name);
  assert.deepEqual(p.remaining,{before:1,after:0});assert.deepEqual(p.tiebreak,{isTiebreakGame:false,beforeVoid:false,afterVoid:false});
  const x=p.after.rules.incidents.find(i=>i.matchup==='PIT @ TEN');
  assert.equal(x.status,'APPLIED');assert.equal(x.evidence,'Recorded incident: ABSENT FROM WEEK 12 FEED · commissioner attestation · original event 401438121');
  assert.deepEqual(p.before.rules.incidents,[]);
  const tb=pk12PreviewOf({config:pk12Config({tiebreakGameIndex:1})}).preview;
  assert.deepEqual(tb.tiebreak,{isTiebreakGame:true,beforeVoid:false,afterVoid:true},'the absent game as the tiebreak game voids the tiebreak');
  const w=pk12PreviewOf({action:'withdraw',rows:absentChain(['void'])}).preview;
  assert.deepEqual([w.before.effect.kind,w.after.effect.kind],['void','nfl']);assert.deepEqual(w.remaining,{before:0,after:1});
  assert.deepEqual(w.after.rules.incidents.map(i=>i.status),['WITHDRAWN']);
});
await regression("HDC-14 Pick'em parity: the Admin preview matches weekly-app.js before and after an absence VOID; the Week 13 feed is never consulted",async()=>{
  const m=need(),{c,request,preview:p}=pk12PreviewOf();
  const row=m.absentHypotheticalRow(request,{contestType:'pickem',chain:c.chain,eventId:c.absence.evidence.eventId,rulingId:1,createdAt:CREATED});
  const before=await weeklyView({rows:[],events:[denKc12()],config:pk12Config()}),after=await weeklyView({rows:[row],events:[denKc12()],config:pk12Config()});
  for(const e of p.entries){
    assert.equal(before.cells[e.name][1],e.before.cell,`${e.name}: weekly-app before`);assert.equal(after.cells[e.name][1],e.after.cell,`${e.name}: weekly-app after`);
    assert.deepEqual([after.records[e.name].w-before.records[e.name].w,after.records[e.name].l-before.records[e.name].l,after.records[e.name].left-before.records[e.name].left],
      [e.after.w-e.before.w,e.after.l-e.before.l,e.after.left-e.before.left],`${e.name}: record delta`);
  }
  assert.deepEqual([before.left,after.left,after.finals],['1','0','1/2 · 1 void']);
  assert(after.rules.includes('<span class="rules-status">APPLIED</span>'),'the public card shows APPLIED');
  assert(unescape(after.rules).includes('Recorded incident: ABSENT FROM WEEK 12 FEED · commissioner attestation · original event 401438121'));
});
await regression('HDC-14 Survivor preview and parity: BEFORE pending, AFTER ALIVE (advance, team used) or OUT (eliminate), as survivor-app.js renders',async()=>{
  const m=need(),feeds=svAbsentFeeds();
  for(const [policy,consequence,label] of [['advance_team_used','advance_team_used','ALIVE'],['eliminate','eliminate','OUT']]){
    const data=svData([],svPolicies(policy)),c=svAbsentCandidates({data}).find(x=>x.key==='SF@ARI'),request=absentRequestFor(c,'rule',{consequence});
    const p=m.survivorPreview({contestId:SV,season:2026,week:2,snapshot:{week:2,config:svConfig()},eventsByWeek:svEventsByWeek(feeds),data,request,candidate:c,path:'absence',rulingId:1,createdAt:CREATED});
    assert.deepEqual(p.entries.map(e=>[e.name,e.pick,e.before.label,e.after.label]),[['D.C.','SF','PENDING',label],['survivor-003','ARI','PENDING',label]],policy);
    if(consequence==='advance_team_used')assert.deepEqual(p.entries[0].after.used,['PIT','SF'],'SF stays used');
    const row=m.absentHypotheticalRow(request,{contestType:'survivor',chain:c.chain,eventId:c.absence.evidence.eventId,rulingId:1,createdAt:CREATED});
    assert.deepEqual([row.incident_status,row.event_id,row.evidence_source],['STATUS_ABSENT','401547001','commissioner-attestation']);
    const before=await survivorView({rows:{policy,rulings:[]},feeds}),after=await survivorView({rows:{policy,rulings:[row]},feeds});
    for(const e of p.tracked){assert.equal(before.pills[e.name][0],e.before.label,`${policy} ${e.name} before`);assert.equal(after.pills[e.name][0],e.after.label,`${policy} ${e.name} after`)}
    assert.deepEqual([after.stillIn,after.pending],[p.after.summary.active,p.after.summary.pending],`${policy}: summary after`);
  }
});
await regression('HDC-14 read-back after a lost response: LANDED, NOT_WRITTEN or CHANGED against the server-derived absence row',()=>{
  const m=need(),c=pk12Candidate(),request=absentRequestFor(c,'rule',{consequence:'void'});
  const landed={...absentChain(['void'])[0],ruling_id:57,public_note:ABSENT_NOTE};
  assert.equal(m.classifyAbsentReadBack({beforeRows:[],afterRows:[landed],request,chain:c.chain,eventId:'401438121'}),'LANDED');
  assert.equal(m.classifyAbsentReadBack({beforeRows:[],afterRows:[],request,chain:c.chain,eventId:'401438121'}),'NOT_WRITTEN');
  for(const [label,changed] of [['a feed status',{...landed,incident_status:'STATUS_POSTPONED',evidence_source:'nflscores2'}],['another event',{...landed,event_id:'401438199'}],
    ['another note',{...landed,public_note:'Another tab.'}]])assert.equal(m.classifyAbsentReadBack({beforeRows:[],afterRows:[changed],request,chain:c.chain,eventId:'401438121'}),'CHANGED',label);
});
await regression('HDC-14 error tokens map to fixed safe messages; the write-access probe answers HDC14_STALE_CHAIN when authorized',()=>{
  const m=need();
  for(const token of HDC14_TOKENS){
    const info=m.rpcErrorInfo({code:'P0001',message:`${token}: detail`,hint:token});
    assert.deepEqual([info.token,info.known,info.definitive,info.text],[token,true,true,m.HDC14_ERROR_TEXT[token]],token);
  }
  assert.equal(m.rpcErrorInfo({code:'P0001',message:'HDC14_MADE_UP: x',hint:'HDC14_MADE_UP'}).known,false);
  assert.equal(m.absentProbeOutcome({error:{code:'P0001',message:'HDC14_STALE_CHAIN: x',hint:'HDC14_STALE_CHAIN'}}).status,'authorized');
  assert.equal(m.absentProbeOutcome({error:{code:'42501',message:'HDC14_NOT_COMMISSIONER: x',hint:'HDC14_NOT_COMMISSIONER'}}).status,'denied');
  assert.equal(m.absentProbeOutcome({error:{code:'PGRST202',message:'Could not find the function public.nfl_append_absent_incident_ruling'}}).status,'inconclusive');
  assert.equal(m.absentProbeOutcome({data:{ruling_id:1}}).status,'unexpected');
});
await regression('HDC-14 the preflight key changes when the absence evidence changes: the game listed again, another published event, another slate revision',()=>{
  const m=need(),base=m.preflightKey(pk12Candidate());
  assert.equal(m.preflightKey(pk12Candidate()),base);
  assert.notEqual(m.preflightKey(pk12Candidate({events:pk12Events(denKc12(),pitTen12())})),base,'listed again');
  assert.notEqual(m.preflightKey(pk12Candidate({config:pk12Config({eventIds:false})})),base,'published event');
  const sv=svAbsentCandidates().find(x=>x.key==='SF@ARI'),sv5=svAbsentCandidates({slate:svSlate(undefined,{revision:5})}).find(x=>x.key==='SF@ARI');
  assert.notEqual(m.preflightKey(sv),m.preflightKey(sv5),'slate revision');
});

// The Admin page workflow for HDC-14 (rulings-admin.js unmodified, fake DOM, mock Neon with the emulated absent-game RPC).
const pk12Tables=(rulings=[])=>({nfl_pool_weeks:[pk12Row()],nfl_incident_rulings:rulings});
const pk12Feeds=()=>({12:projected([denKc12()]),13:projected([finalGame('PIT','TEN','401438199','24','27',13)])});
await regression('HDC-14 page: the absent game is listed with its absent-game action only, labelled ABSENT FROM ORIGINAL WEEK FEED; only Week 12 is read',async()=>{
  const t=await boot({tables:pk12Tables(),feeds:pk12Feeds()});
  await ready(t,{week:12,matchup:'PIT@TEN',action:null});
  assert.deepEqual(t.options('actionSelect'),['absent-rule']);assert.deepEqual(t.options('consequenceSelect'),['void']);
  assert.match(t.$('candidateInfo').innerHTML,/ABSENT FROM ORIGINAL WEEK FEED/);
  assert.match(unescape(t.$('candidateInfo').innerHTML),/STATUS_ABSENT · event 401438121 · commissioner-attestation/);
  assert.deepEqual([...new Set(t.net.calls.filter(u=>u.startsWith(NFLSCORES2)).map(u=>new URL(u).searchParams.get('week')))],['12'],'the Week 13 makeup feed is never requested');
});
await regression('HDC-14 page end to end: preview, typed absence confirmation, one RPC to the absent-game function with exactly the 10 arguments, read-back',async()=>{
  const t=await boot({tables:pk12Tables(),feeds:pk12Feeds()});
  await ready(t,{week:12,matchup:'PIT@TEN',action:'absent-rule',consequence:'void',publicNote:ABSENT_NOTE,adminNote:'Checked the Week 12 feed.'});
  await t.click('previewBtn');
  assert.equal(t.$('preview').hidden,false,t.$('message').textContent);
  const summary=unescape(t.$('previewSummary').innerHTML);
  for(const text of ['Week 12','PIT @ TEN','401438121','STATUS_ABSENT','commissioner-attestation','ABSENT FROM ORIGINAL WEEK FEED','void','2',ABSENT_NOTE,'Checked the Week 12 feed.'])
    assert(summary.includes(text),`the confirmation shows ${text}`);
  assert.doesNotMatch(summary,/nflscores2/,'the absence is never presented as feed evidence');
  assert.match(t.$('previewBefore').innerHTML,/PENDING|not graded/i);assert.match(t.$('previewAfter').innerHTML,/VOID/);
  assert.equal(t.$('confirmPhrase').textContent,'WEEK 12 PIT @ TEN ABSENT');
  for(const typed of ['PIT @ TEN','CONFIRM','WEEK 12 PIT @ TEN']){await t.input('confirmMatchup',typed);assert.equal(t.$('submitBtn').disabled,true,typed)}
  await t.input('confirmMatchup','week 12 pit @ ten absent');assert.equal(t.$('submitBtn').disabled,false);
  await Promise.all([t.$('submitBtn').dispatch('click'),t.$('submitBtn').dispatch('click')]);await flush();
  assert.equal(t.db.rpcCalls.length,1,'double click: one RPC');
  const {fn,args}=t.db.rpcCalls[0];
  assert.equal(fn,ABSENT_RPC);exact10(args);
  assert.deepEqual(args,{p_contest_id:PK,p_week:12,p_away_team:'PIT',p_home_team:'TEN',p_action:'rule',p_consequence:'void',p_expected_policy_revision:1,
    p_expected_parent_ruling_id:null,p_public_note:ABSENT_NOTE,p_admin_note:'Checked the Week 12 feed.'});
  const [row]=t.db.tables.nfl_incident_rulings;
  assert.deepEqual([row.incident_status,row.event_id,row.evidence_source],['STATUS_ABSENT','401438121','commissioner-attestation']);
  assert.match(t.$('message').textContent,/recorded/i);assert.match(t.$('result').textContent,/matches the preview/i);
});
await regression('HDC-14 page: the game listed again before submitting cancels the submit (no RPC)',async()=>{
  const t=await boot({tables:pk12Tables(),feeds:pk12Feeds()});
  await ready(t,{week:12,matchup:'PIT@TEN',action:'absent-rule',consequence:'void',publicNote:ABSENT_NOTE});
  await t.click('previewBtn');await t.input('confirmMatchup','WEEK 12 PIT @ TEN ABSENT');
  t.net.feeds[12]=projected([denKc12(),pitTen12()]);
  await t.click('submitBtn');
  assert.equal(t.db.rpcCalls.length,0);assert.match(t.$('message').textContent,/changed/i);assert.equal(t.$('preview').hidden,true);
});
await regression('HDC-14 page: HDC14 refusals show their fixed messages; a lost response is read back and classified',async()=>{
  for(const token of ['HDC14_STALE_CHAIN','HDC14_NOT_PUBLISHED','HDC14_NOT_ABSENCE_CHAIN']){
    const t=await boot({tables:pk12Tables(),feeds:pk12Feeds(),rpc:()=>async()=>tokenError(token)});
    await ready(t,{week:12,matchup:'PIT@TEN',action:'absent-rule',consequence:'void',publicNote:ABSENT_NOTE});
    await t.click('previewBtn');await t.input('confirmMatchup','WEEK 12 PIT @ TEN ABSENT');await t.click('submitBtn');
    assert.equal(t.$('message').textContent,need().HDC14_ERROR_TEXT[token],token);assert.equal(t.db.rpcCalls.length,1,token);
  }
  const lost={data:null,error:{code:'',message:'TypeError: Failed to fetch',hint:'',details:''}};
  const landed=await boot({tables:pk12Tables(),feeds:pk12Feeds(),rpc:db=>async(fn,a)=>{await routeRpc(db)(fn,a);return lost}});
  await ready(landed,{week:12,matchup:'PIT@TEN',action:'absent-rule',consequence:'void',publicNote:ABSENT_NOTE});
  await landed.click('previewBtn');await landed.input('confirmMatchup','WEEK 12 PIT @ TEN ABSENT');await landed.click('submitBtn');
  assert.match(landed.$('message').textContent,/LANDED/);
});
await regression('HDC-14 page: an absence chain is withdrawn through the absent-game function with the matchup typed; HDC-13 actions are never offered for it',async()=>{
  const t=await boot({tables:pk12Tables(absentChain(['void'])),feeds:pk12Feeds()});
  await ready(t,{week:12,matchup:'PIT@TEN',action:null});
  assert.deepEqual(t.options('actionSelect'),['absent-withdraw']);
  await t.change('actionSelect','absent-withdraw');await t.input('publicNote','Withdrawn.');await t.input('adminNote','Ruled in error.');
  await t.click('previewBtn');assert.equal(t.$('confirmPhrase').textContent,'PIT @ TEN');
  await t.input('confirmMatchup','PIT @ TEN');await t.click('submitBtn');
  assert.equal(t.db.rpcCalls.length,1);assert.equal(t.db.rpcCalls[0].fn,ABSENT_RPC);
  assert.deepEqual([t.db.rpcCalls[0].args.p_action,t.db.rpcCalls[0].args.p_expected_parent_ruling_id],['withdraw',1]);
  assert.deepEqual(t.db.tables.nfl_incident_rulings.map(r=>[r.consequence,r.incident_status]),[['void','STATUS_ABSENT'],['withdrawn','STATUS_ABSENT']]);
});
await regression('HDC-14 page, Survivor: the absent SF @ ARI pick is offered from the same-week slate; advance previewed ALIVE and recorded',async()=>{
  const feeds={1:projected(svAbsentFeeds()[1].events),2:projected(svAbsentFeeds()[2].events)};
  const t=await boot({feeds,tables:{nfl_pool_weeks:[svSlate()]}});
  await t.change('contestSelect',SV);await t.change('weekSelect',2);await t.click('loadBtn');
  assert(t.options('matchupSelect').includes('SF@ARI'),'discovered from the slate');
  assert(t.db.reads.some(r=>r.table==='nfl_pool_weeks'&&r.filters.includes('eq:week:2')&&r.filters.includes('eq:status:locked')),'the same-week locked slate is read');
  await t.change('matchupSelect','SF@ARI');assert.deepEqual(t.options('actionSelect'),['absent-rule']);
  await t.input('publicNote','SF @ ARI left the Week 2 feed; pickers advance.');await t.click('previewBtn');
  assert.match(t.$('previewAfter').innerHTML,/ALIVE/);assert.match(t.$('previewBefore').innerHTML,/PENDING/);
  await t.input('confirmMatchup','WEEK 2 SF @ ARI ABSENT');await t.click('submitBtn');
  assert.equal(t.db.rpcCalls.length,1);assert.equal(t.db.rpcCalls[0].fn,ABSENT_RPC);assert.equal(t.db.rpcCalls[0].args.p_consequence,'advance_team_used');
  assert.equal(t.db.tables.nfl_incident_rulings[0].event_id,'401547001');
});
await regression('HDC-14 page: the absent-game write-access check calls the absent-game function with the impossible parent and writes nothing',async()=>{
  const t=await boot({tables:pk12Tables(),feeds:pk12Feeds()});
  await t.change('contestSelect',PK);await t.change('weekSelect',12);await t.click('loadBtn');
  await t.click('probeAbsentBtn');
  assert.equal(t.db.rpcCalls.length,1);assert.equal(t.db.rpcCalls[0].fn,ABSENT_RPC);exact10(t.db.rpcCalls[0].args);
  assert.equal(t.db.rpcCalls[0].args.p_expected_parent_ruling_id,9007199254740991);
  assert.match(t.$('probeResult').textContent,/HDC14_STALE_CHAIN/);assert.match(t.$('probeResult').textContent,/0 rows written/);
  assert.equal(t.db.tables.nfl_incident_rulings.length,0);
});
await regression('HDC-14 rulings.html: the absent-game write-access button is a labelled type="button"',()=>{
  assert.match(pageHtml||'',/<button type="button" id="probeAbsentBtn" class="ghost">[^<]+<\/button>/);
  assert.match(adminSource||'',/neon\.rpc\(ABSENT_RPC_FUNCTION,/);
});

assert.equal(failures.length,0,`HDC-13 incident-ruling write-path regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
console.log('HDC-13 and HDC-14 Admin incident-ruling write paths: module surface, feed path, notes, selection, candidate discovery and eligibility, action state, 13-argument requests, previews, weekly-app and survivor-app parity, confirmation, preflight, errors, read-back, write-access check, page workflow and static accessibility regressions passed');
