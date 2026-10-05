// FCR-01: the score-feed proxy source (score-proxy/index.mjs, the Neon Function nflscores2). Covers the deployment-1
// projection plus the Survivor market-odds subset and the HDC-10 final evidence, parity with the Survivor feed parsers,
// parameter coercion, the exact upstream URL and the HTTP handler. No live network: every upstream fetch here is a stub.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import proxy,{ALLOWED_ORIGIN,UPSTREAM_TIMEOUT_MS,parseSeasonWeek,upstreamUrl,projectScoreboard,createHandler} from './index.mjs';
import {survivorMarketMatchups,survivorBuildResults,survivorEntryState,survivorFeedContextError} from '../survivor-math.js';

// Deployed as one unbundled file: nothing imported, no environment or secrets read.
const source=readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
assert.doesNotMatch(source,/^\s*import[\s{*'"]|\bimport\s*\(|\brequire\s*\(/m,'the function source imports nothing');
assert.doesNotMatch(source,/\bprocess\s*\.|\bDeno\b|\bBun\b/,'the function source reads no runtime environment');
assert.equal(typeof proxy?.fetch,'function','default export is {fetch(request)}');
assert.equal(ALLOWED_ORIGIN,'https://r88510179-collab.github.io','the only CORS origin is the Pages origin');
assert(UPSTREAM_TIMEOUT_MS>0&&UPSTREAM_TIMEOUT_MS<=10000,'upstream time limit is at most 10 s');

// ---- ESPN-shaped fixtures, with the extra fields ESPN sends at every level (as on the live 2026 Week 3 scoreboard).
const logo=code=>`https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${code.toLowerCase()}.png`;
const espnTeam=(code,id)=>({id,uid:`s:20~l:28~t:${id}`,location:'City',name:'Team',abbreviation:code,displayName:`City ${code}`,shortDisplayName:code,color:'5a1414',alternateColor:'ffb612',isActive:true,venue:{id:'3719'},links:[{rel:['clubhouse'],href:`https://www.espn.com/nfl/team/_/name/${code.toLowerCase()}`,text:'Clubhouse',isExternal:false,isPremium:false}],logo:logo(code)});
const STATUS={
  pre:{id:'1',name:'STATUS_SCHEDULED',state:'pre',completed:false,description:'Scheduled',detail:'Sun, September 27th at 1:00 PM EDT',shortDetail:'9/27 - 1:00 PM EDT'},
  in:{id:'2',name:'STATUS_IN_PROGRESS',state:'in',completed:false,description:'In Progress',detail:'10:12 - 2nd Quarter',shortDetail:'10:12 - 2nd'},
  post:{id:'3',name:'STATUS_FINAL',state:'post',completed:true,description:'Final',detail:'Final',shortDetail:'Final'}
};
function espnOdds({details,spread,away,home,favorite}){
  const side=(code,fav)=>({favorite:fav,underdog:!fav,team:{id:'9',uid:'s:20~l:28~t:9',abbreviation:code,name:'Team',displayName:`City ${code}`,logo:logo(code)},favoriteAtOpen:fav});
  return{provider:{id:'100',name:'DraftKings',priority:1,logos:[{href:'https://a.espncdn.com/i/betting/Draftkings_Light.svg',rel:['light']}]},details,overUnder:44.5,spread,
    awayTeamOdds:side(away,favorite===away),homeTeamOdds:side(home,favorite===home),
    moneyline:{displayName:'Moneyline',shortDisplayName:'ML',home:{close:{odds:'+320'},open:{odds:'+164'}},away:{close:{odds:'-410'},open:{odds:'-198'}}},
    pointSpread:{displayName:'Spread',shortDisplayName:'Spread',home:{close:{line:'+7.5',odds:'-102'}},away:{close:{line:'-7.5',odds:'-118'}}},
    total:{displayName:'Total',shortDisplayName:'Total',over:{close:{line:'o44.5',odds:'-110'}},under:{close:{line:'u44.5',odds:'-110'}}},
    link:{language:'en-US',rel:['game'],href:'https://sportsbook.draftkings.com/',text:'See More',isExternal:true,isPremium:false},
    header:{logo:{dark:'https://a.espncdn.com/i/betting/dark.svg',light:'https://a.espncdn.com/i/betting/light.svg'},text:'Game Odds'},footer:{disclaimer:'Odds by DraftKings'}};
}
let nextId=401872960;
function espnEvent({id=String(nextId++),away,home,state='pre',as='0',hs='0',season=2026,week=3,date='2026-09-27T17:00Z',odds}){
  const status=STATUS[state],done=status.completed,tie=done&&as===hs;
  const competitor=(homeAway,code,score,order)=>({id:String(20+order),uid:`s:20~l:28~t:${20+order}`,type:'team',order,homeAway,
    ...(done?{winner:!tie&&(homeAway==='home'?Number(hs)>Number(as):Number(as)>Number(hs))}:{}),
    team:espnTeam(code,String(20+order)),score,curatedRank:{current:99},statistics:[],records:[{name:'overall',abbreviation:'Any',type:'total',summary:'2-0'}],
    leaders:[{name:'passingLeader',displayName:'Passing Leader',shortDisplayName:'PASS',abbreviation:'PYDS',leaders:[]}]});
  return{id,uid:`s:20~l:28~e:${id}`,date,name:`${away} at ${home}`,shortName:`${away} @ ${home}`,season:{year:season,type:2,slug:'regular-season'},week:{number:week},
    competitions:[{id,uid:`s:20~l:28~e:${id}~c:${id}`,date,attendance:0,type:{id:'1',abbreviation:'STD'},timeValid:true,neutralSite:false,conferenceCompetition:false,playByPlayAvailable:state!=='pre',recent:false,
      venue:{id:'3719',fullName:'Stadium',address:{city:'City',state:'ST',country:'USA'},indoor:false},
      competitors:[competitor('home',home,hs,0),competitor('away',away,as,1)],notes:[],
      status:{clock:0,displayClock:'0:00',period:done?4:0,type:{...status},isTBDFlex:false},
      broadcasts:[{market:'national',names:['FOX']}],leaders:[],format:{regulation:{periods:4}},tickets:[],startDate:date,broadcast:'FOX',geoBroadcasts:[],
      ...(odds===undefined?{}:{odds}),highlights:[]}],
    links:[{language:'en-US',rel:['summary','desktop','event'],href:`https://www.espn.com/nfl/game/_/gameId/${id}`,text:'Gamecast'}],
    weather:{displayValue:'Sunny',temperature:72,highTemperature:72,conditionId:'1'},
    status:{clock:0,displayClock:'0:00',period:done?4:0,type:{...status}}};
}
const scoreboard=(events,week=3,season=2026)=>({leagues:[{id:'28',uid:'s:20~l:28',name:'National Football League',abbreviation:'NFL'}],season:{type:2,year:season},week:{number:week},events,provider:{id:'100',name:'DraftKings'}});
const line=(details,spread,away,home,favorite)=>[espnOdds({details,spread,away,home,favorite})];

// Week 3 shaped like ESPN's live feed: the final ATL @ GB with no line (as ESPN served it on 2026-09-26), a home favorite
// (negative spread), away favorites (positive spread), the WSH and JAC feed aliases, and an in-progress game with a line.
const W3=scoreboard([
  espnEvent({id:'401872948',away:'ATL',home:'GB',state:'post',as:'35',hs:'14',date:'2026-09-25T00:15Z'}),
  espnEvent({away:'LAC',home:'BUF',odds:line('BUF -7',-7,'LAC','BUF','BUF')}),
  espnEvent({away:'CAR',home:'CLE',odds:line('CAR -2.5',2.5,'CAR','CLE','CAR')}),
  espnEvent({id:'401872955',away:'SEA',home:'WSH',odds:line('SEA -7.5',7.5,'SEA','WSH','SEA')}),
  espnEvent({away:'NE',home:'JAC',odds:line('JAC -3',-3,'NE','JAC','JAC')}),
  espnEvent({away:'KC',home:'MIA',state:'in',as:'7',hs:'3',odds:line('KC -10',10,'KC','MIA','KC')})
]);
const FETCHED='2026-09-26T12:00:00.000Z';
const projected=payload=>projectScoreboard(payload,FETCHED);

// Deployment-1 whitelist, written independently. On 2026-09-26 nflscores answered 2026 Weeks 3 and 4 with exactly this
// projection of ESPN's events, byte for byte (32 of 32 events).
const legacy=e=>({id:e.id,date:e.date,status:{type:{state:e.status.type.state,completed:e.status.type.completed,shortDetail:e.status.type.shortDetail,detail:e.status.type.detail}},
  competitions:e.competitions.map(c=>({competitors:c.competitors.map(x=>({homeAway:x.homeAway,score:x.score,team:{abbreviation:x.team.abbreviation}}))}))});
const withoutOdds=payload=>{const copy=structuredClone(payload);for(const e of copy.events)for(const c of e.competitions)delete c.odds;return copy};
// Projected events with the HDC-10 final evidence removed again: event status names, competition statuses, winner flags.
const withoutFinalEvidence=events=>events.map(e=>{
  const copy=structuredClone(e);
  if(copy.status?.type)delete copy.status.type.name;
  for(const c of copy.competitions||[]){if(!c)continue;delete c.status;for(const x of c.competitors||[])if(x)delete x.winner}
  return copy;
});

// ---- Exact projection: key order as deployment 1, the odds subset last, and nothing else.
{
  const body=projected(W3),deployment1=withoutFinalEvidence(body.events);
  assert.deepEqual(Object.keys(body),['fetchedAt','events']);
  assert.equal(body.fetchedAt,FETCHED);
  assert.deepEqual(body.events.map(e=>e.id),W3.events.map(e=>e.id),'event order equals ESPN');
  // With the HDC-10 final evidence removed, byte-identical to deployment 1's live responses for these two events (the
  // final carries no line).
  assert.equal(JSON.stringify(deployment1[0]),'{"id":"401872948","date":"2026-09-25T00:15Z","status":{"type":{"state":"post","completed":true,"shortDetail":"Final","detail":"Final"}},"competitions":[{"competitors":[{"homeAway":"home","score":"14","team":{"abbreviation":"GB"}},{"homeAway":"away","score":"35","team":{"abbreviation":"ATL"}}]}]}');
  assert.equal(JSON.stringify(deployment1[3]),'{"id":"401872955","date":"2026-09-27T17:00Z","status":{"type":{"state":"pre","completed":false,"shortDetail":"9/27 - 1:00 PM EDT","detail":"Sun, September 27th at 1:00 PM EDT"}},"competitions":[{"competitors":[{"homeAway":"home","score":"0","team":{"abbreviation":"WSH"}},{"homeAway":"away","score":"0","team":{"abbreviation":"SEA"}}],"odds":[{"details":"SEA -7.5","spread":7.5,"awayTeamOdds":{"favorite":true},"homeTeamOdds":{"favorite":false}}]}]}');
  // Odds copied verbatim: sign convention, feed aliases and flags untouched.
  const odds=body.events.map(e=>e.competitions[0].odds);
  assert.deepEqual(odds,[
    undefined,
    [{details:'BUF -7',spread:-7,awayTeamOdds:{favorite:false},homeTeamOdds:{favorite:true}}],
    [{details:'CAR -2.5',spread:2.5,awayTeamOdds:{favorite:true},homeTeamOdds:{favorite:false}}],
    [{details:'SEA -7.5',spread:7.5,awayTeamOdds:{favorite:true},homeTeamOdds:{favorite:false}}],
    [{details:'JAC -3',spread:-3,awayTeamOdds:{favorite:false},homeTeamOdds:{favorite:true}}],
    [{details:'KC -10',spread:10,awayTeamOdds:{favorite:true},homeTeamOdds:{favorite:false}}]
  ]);
  assert.equal('odds' in body.events[0].competitions[0],false,'no odds key when ESPN sends no line');
  assert.equal(body.events[4].competitions[0].competitors[0].team.abbreviation,'JAC','feed alias kept verbatim');
}

// ---- Extra ESPN fields are never emitted: every object in the response has only its whitelisted keys.
{
  const ALLOWED={body:['fetchedAt','events'],event:['id','date','status','competitions'],status:['type'],type:['state','completed','shortDetail','detail','name'],
    competition:['competitors','status','odds'],competitionType:['state','completed','name'],competitor:['homeAway','score','team','winner'],team:['abbreviation'],
    odds:['details','spread','awayTeamOdds','homeTeamOdds'],side:['favorite']};
  const only=(object,kind)=>{for(const key of Object.keys(object))assert(ALLOWED[kind].includes(key),`${kind} must not carry ${key}`)};
  const body=projected(W3);only(body,'body');
  for(const e of body.events){
    only(e,'event');only(e.status,'status');only(e.status.type,'type');
    for(const c of e.competitions){
      only(c,'competition');
      // Every W3 competition has a status, as on ESPN's live feed: HDC-10 projects its type subset only.
      assert.equal(typeof c.status?.type,'object',`event ${e.id}: the competition status type is projected`);
      only(c.status,'status');only(c.status.type,'competitionType');
      for(const x of c.competitors){only(x,'competitor');only(x.team,'team')}
      for(const o of c.odds||[]){only(o,'odds');only(o.awayTeamOdds,'side');only(o.homeTeamOdds,'side')}
    }
  }
  const text=JSON.stringify(body);
  for(const name of ['season','week','uid','shortName','overUnder','provider','underdog','moneyline','venue','records','links','leagues','clock','displayClock','period','isTBDFlex','description'])
    assert(!text.includes(`"${name}"`),`${name} is never emitted`);
  // The only names are status names and the only winners are winner flags: one name in each event and competition status
  // type, and a flag on each competitor of the one final (the fixture flags only the competitors of completed games).
  assert.equal((text.match(/"name":/g)||[]).length,2*body.events.length,'a name only in each event and competition status type');
  assert.equal((text.match(/"winner":/g)||[]).length,2,'winner flags only on the final\'s two competitors');
  assert.equal(survivorFeedContextError(body,{season:2026,week:3}),null,'no season/week context, so the Survivor guard has nothing to contradict');
}

// ---- Absent, empty, null and non-array odds; odds[0] null, non-object or partial. [label, ESPN odds (undefined: key
// absent), projected odds (undefined: key absent)].
const ODDS_CASES=[
  ['absent',undefined,undefined],
  ['empty array',[],undefined],
  ['null',null,undefined],
  ['object instead of array',{details:'KC -3'},undefined],
  ['string','KC -3',undefined],
  ['odds[0] null',[null],undefined],
  ['odds[0] string',['KC -3'],undefined],
  ['odds[0] array',[[{details:'KC -3'}]],undefined],
  ['odds[0] empty object',[{}],[{}]],
  ['details only',[{details:'KC -7.5'}],[{details:'KC -7.5'}]],
  ['spread only',[{spread:-3}],[{spread:-3}]],
  ['flags only, subset key order',[{homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}}],[{awayTeamOdds:{favorite:false},homeTeamOdds:{favorite:true}}]],
  ['non-object sides dropped',[{details:'KC -3',awayTeamOdds:null,homeTeamOdds:'KC'}],[{details:'KC -3'}]],
  ['array side dropped',[{awayTeamOdds:[true],homeTeamOdds:{favorite:true}}],[{homeTeamOdds:{favorite:true}}]],
  ['side without favorite flag',[{awayTeamOdds:{underdog:true},homeTeamOdds:{favorite:true,underdog:false}}],[{awayTeamOdds:{},homeTeamOdds:{favorite:true}}]],
  ['values verbatim, no coercion',[{details:null,spread:'-3.5',awayTeamOdds:{favorite:'true'},homeTeamOdds:{favorite:null}}],[{details:null,spread:'-3.5',awayTeamOdds:{favorite:'true'},homeTeamOdds:{favorite:null}}]],
  ['only the first line',[{details:'KC -3',spread:-3},{details:'DEN -1',spread:1}],[{details:'KC -3',spread:-3}]]
];
for(const [label,odds,expected] of ODDS_CASES){
  const payload=scoreboard([espnEvent({away:'DEN',home:'KC',odds})]),[competition]=projected(payload).events[0].competitions;
  if(expected===undefined)assert.equal('odds' in competition,false,`${label}: odds key omitted`);
  else assert.equal(JSON.stringify(competition.odds),JSON.stringify(expected),`${label}: odds subset`);
  assert.deepEqual(survivorMarketMatchups(projected(payload).events),survivorMarketMatchups(payload.events),`${label}: market parity`);
}

// ---- Structure is never repaired or truncated: every competition and competitor keeps its position (non-objects
// become null), non-object events are skipped, and absent fields stay absent rather than being fabricated.
{
  const e=espnEvent({away:'DEN',home:'KC'}),extra=espnEvent({away:'NYJ',home:'NYG'}).competitions[0];
  e.competitions.push(null,'x',[extra],extra);
  e.competitions[0].competitors.splice(1,0,null,7,'KC',[{homeAway:'away'}]);
  const [p]=projected(scoreboard([e])).events;
  assert.equal(p.competitions.length,5);
  assert.deepEqual(p.competitions.slice(1,4),[null,null,null]);
  assert.deepEqual(p.competitions[0].competitors,[{homeAway:'home',score:'0',team:{abbreviation:'KC'}},null,null,null,null,{homeAway:'away',score:'0',team:{abbreviation:'DEN'}}]);
  assert.deepEqual(p.competitions[4],{competitors:[{homeAway:'home',score:'0',team:{abbreviation:'NYG'}},{homeAway:'away',score:'0',team:{abbreviation:'NYJ'}}],status:{type:{state:'pre',completed:false,name:'STATUS_SCHEDULED'}}});
  const valid=espnEvent({away:'MIA',home:'BUF'});
  assert.deepEqual(projected({events:[null,'x',42,true,[valid],valid]}).events.map(x=>x.id),[valid.id],'non-object events skipped');
  const shapes=[
    [{competitions:[{competitors:[{homeAway:'away',team:{abbreviation:'DEN'}},{homeAway:'home'}]}]},{competitions:[{competitors:[{homeAway:'away',team:{abbreviation:'DEN'}},{homeAway:'home'}]}]}],
    [{id:1,date:null,status:'Final',competitions:'x'},{id:1,date:null}],
    [{id:'a',status:{type:'post'},competitions:[{competitors:{}},{}]},{id:'a',status:{},competitions:[{},{}]}],
    [{id:'b',status:{type:{completed:true,name:'STATUS_FINAL'}}},{id:'b',status:{type:{completed:true,name:'STATUS_FINAL'}}}],
    [{id:'c',competitions:[{competitors:[{homeAway:'home',score:null,team:null},{score:24,team:{abbreviation:null,id:'1'}},{homeAway:'away',team:'DEN'}]}]},
      {id:'c',competitions:[{competitors:[{homeAway:'home',score:null},{score:24,team:{abbreviation:null}},{homeAway:'away'}]}]}]
  ];
  for(const [input,expected] of shapes)assert.equal(JSON.stringify(projected({events:[input]}).events[0]),JSON.stringify(expected),`shape ${JSON.stringify(input)}`);
  assert.equal(projectScoreboard({events:{}}),null,'no events array: no body');
  for(const payload of [null,undefined,'x',[],{}])assert.equal(projectScoreboard(payload),null);
}
// The Survivor client's malformed-feed checks fire exactly as they would on the raw feed.
{
  const variants=[
    e=>{e.competitions[0].competitors.push({homeAway:'home',team:{abbreviation:'KC'},score:'0'})},
    e=>{e.competitions[0].competitors[1]=null},
    e=>{e.competitions[0].competitors.splice(1,0,'x')},
    e=>{e.competitions.push(structuredClone(e.competitions[0]))},
    e=>{e.competitions[0].competitors[0].team='KC'}
  ];
  for(const [i,mutate] of variants.entries()){
    const e=espnEvent({away:'DEN',home:'KC',state:'post',as:'20',hs:'27'});mutate(e);
    const payload=scoreboard([e,espnEvent({away:'MIA',home:'BUF',state:'post',as:'10',hs:'24'})]);
    const raw=survivorBuildResults(payload.events,{season:2026,week:3}),proj=survivorBuildResults(projected(payload).events,{season:2026,week:3});
    assert.deepEqual(proj,raw,`malformed variant ${i}: same Survivor results`);
    const flagged=[...proj].filter(([team])=>team==='DEN'||team==='KC');
    assert(flagged.length&&flagged.every(([,r])=>r.unresolved&&['malformed','ambiguous'].includes(r.issue)),`malformed variant ${i}: still flagged`);
    assert.equal(proj.get('BUF').winner,'BUF',`malformed variant ${i}: other games unaffected`);
  }
}

// ---- Parity with the Survivor market parser on the live-shaped Week 3 feed and on the existing favorite-flag and details
// matrix cases (survivor-math.test.mjs), each run through the projection.
{
  const expectedW3=[
    {away:'ATL',home:'GB',date:'2026-09-25T00:15Z',favorite:null,spread:null},
    {away:'LAC',home:'BUF',date:'2026-09-27T17:00Z',favorite:'BUF',spread:7},
    {away:'CAR',home:'CLE',date:'2026-09-27T17:00Z',favorite:'CAR',spread:2.5},
    {away:'SEA',home:'WAS',date:'2026-09-27T17:00Z',favorite:'SEA',spread:7.5},
    {away:'NE',home:'JAX',date:'2026-09-27T17:00Z',favorite:'JAX',spread:3},
    {away:'KC',home:'MIA',date:'2026-09-27T17:00Z',favorite:'KC',spread:10}
  ];
  assert.deepEqual(survivorMarketMatchups(W3.events),expectedW3);
  assert.deepEqual(survivorMarketMatchups(projected(W3).events),expectedW3);
  // The production defect, for contrast: the deployment-1 projection carries no line, so no market favorite exists.
  assert.deepEqual(survivorMarketMatchups(W3.events.map(legacy)).map(m=>m.favorite),[null,null,null,null,null,null]);
}
{
  const pair=(away,home,odds,extra={})=>({...extra,competitions:[{competitors:[{homeAway:'away',team:{abbreviation:away}},{homeAway:'home',team:{abbreviation:home}}],...(odds===undefined?{}:{odds:[odds]})}]});
  const cases=[
    [pair('DEN','KC',{details:'KC -7.5',homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}},{date:'2026-09-27T17:00:00Z'}),pair('MIA','BUF',{details:'BUF -3.5'},{date:'2026-09-27T20:25:00Z'}),pair('PHI','DAL',undefined,{date:'2026-09-28T00:20:00Z'}),{competitions:[{competitors:[{homeAway:'away',team:{abbreviation:'NYJ'}}]}]}],
    [pair('DEN','KC',{details:'KC +3.5'},{date:'2026-09-27T17:00:00Z'})],
    [pair('DEN','KC',{details:'KC +3.5',homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}})],
    [pair('MIA','BUF',{spread:-4,homeTeamOdds:{favorite:true},awayTeamOdds:{favorite:false}})],
    [pair('DEN','KC',{details:'KC -3.5',awayTeamOdds:{favorite:true},homeTeamOdds:{favorite:true}})],
    [pair('DEN','KC',{details:'KC -6',awayTeamOdds:{favorite:false},homeTeamOdds:{favorite:false}})],
    ...['KC -7.5','KC -7','DEN -3.5','KC +3.5','KC +7','KC 3.5','DEN +3.5','XXX -7','',null].map(details=>[pair('DEN','KC',details===null?{}:{details})]),
    [pair('JAC','WSH',{details:'WSH -3'}),pair('wsh','jac',{details:'JAC -2.5'})]
  ];
  for(const code of ['x" onerror="alert(1)','XXX','OAK','7',7,{},'',null,undefined])for(const [away,home] of [[code,'KC'],['KC',code],[code,code]])
    cases.push([pair(away,home,{spread:-7,awayTeamOdds:{favorite:away===code},homeTeamOdds:{favorite:home===code}}),pair('MIA','BUF',{details:'BUF -3.5'})]);
  for(const [i,events] of cases.entries())
    assert.deepEqual(survivorMarketMatchups(projected({events}).events),survivorMarketMatchups(events),`market parity case ${i}`);
}

// ---- Survivor results parity on well-formed data: finals (a tie and the feed aliases included), live and scheduled.
{
  const W2=scoreboard([
    espnEvent({away:'SF',home:'ARI',state:'post',as:'27',hs:'20',week:2}),
    espnEvent({away:'BAL',home:'CLE',state:'post',as:'17',hs:'17',week:2}),
    espnEvent({away:'WSH',home:'JAC',state:'post',as:'10',hs:'31',week:2}),
    espnEvent({away:'KC',home:'LV',state:'in',as:'14',hs:'10',week:2,odds:line('KC -6',6,'KC','LV','KC')}),
    espnEvent({away:'DEN',home:'LAC',week:2,odds:line('LAC -2.5',-2.5,'DEN','LAC','LAC')})
  ],2);
  for(const [payload,week] of [[W2,2],[W3,3]]){
    const raw=survivorBuildResults(payload.events,{season:2026,week});
    assert.deepEqual(survivorBuildResults(projected(payload).events,{season:2026,week}),raw,`Week ${week} results parity`);
    assert.equal(survivorBuildResults(payload.events.map(legacy),{season:2026,week}).size,raw.size);
  }
  const results=survivorBuildResults(projected(W2).events,{season:2026,week:2});
  assert.equal(results.get('SF').winner,'SF');assert.equal(results.get('BAL').tie,true);assert.equal(results.get('WAS').winner,'JAX');
  assert.equal(results.get('KC').state,'in');assert.equal(results.get('LAC').completed,false);
}

// ---- Legacy parity: the response is the deployment-1 whitelist plus exactly two additions, the Survivor odds subset
// (FCR-01) and the HDC-10 final evidence. Without odds and with the final evidence removed, the projection is the
// deployment-1 whitelist byte for byte; with odds, removing both additions leaves exactly that whitelist.
{
  const bare=withoutOdds(W3);
  assert.equal(JSON.stringify(withoutFinalEvidence(projected(bare).events)),JSON.stringify(bare.events.map(legacy)));
  const stripped=withoutFinalEvidence(projected(W3).events).map(e=>({...e,competitions:e.competitions.map(({odds,...c})=>c)}));
  assert.equal(JSON.stringify(stripped),JSON.stringify(W3.events.map(legacy)));
}

// ---- HDC-10 R1: the final evidence Pick'em and Survivor check before grading a completed game survives projection:
// status.type.name, competitions[].status.type.{state,completed,name} and competitors[].winner. It is copied verbatim and
// only where ESPN sends it, after the deployment-1 keys (competitions[].status before the odds subset): nothing is
// coerced, repaired or invented, and no other ESPN field comes with it.
{
  const [final,,,scheduled]=projected(W3).events;
  // The final ATL @ GB and the scheduled SEA @ WSH (with its line), byte for byte.
  assert.equal(JSON.stringify(final),'{"id":"401872948","date":"2026-09-25T00:15Z","status":{"type":{"state":"post","completed":true,"shortDetail":"Final","detail":"Final","name":"STATUS_FINAL"}},"competitions":[{"competitors":[{"homeAway":"home","score":"14","team":{"abbreviation":"GB"},"winner":false},{"homeAway":"away","score":"35","team":{"abbreviation":"ATL"},"winner":true}],"status":{"type":{"state":"post","completed":true,"name":"STATUS_FINAL"}}}]}');
  assert.equal(JSON.stringify(scheduled),'{"id":"401872955","date":"2026-09-27T17:00Z","status":{"type":{"state":"pre","completed":false,"shortDetail":"9/27 - 1:00 PM EDT","detail":"Sun, September 27th at 1:00 PM EDT","name":"STATUS_SCHEDULED"}},"competitions":[{"competitors":[{"homeAway":"home","score":"0","team":{"abbreviation":"WSH"}},{"homeAway":"away","score":"0","team":{"abbreviation":"SEA"}}],"status":{"type":{"state":"pre","completed":false,"name":"STATUS_SCHEDULED"}},"odds":[{"details":"SEA -7.5","spread":7.5,"awayTeamOdds":{"favorite":true},"homeTeamOdds":{"favorite":false}}]}]}');
  assert.deepEqual(Object.keys(final.status.type),['state','completed','shortDetail','detail','name'],'the status name follows the deployment-1 status keys');
  assert.deepEqual(Object.keys(scheduled.competitions[0]),['competitors','status','odds'],'the competition status sits before the odds subset');
  assert.deepEqual(Object.keys(final.competitions[0].status.type),['state','completed','name']);
  assert.deepEqual(final.competitions[0].competitors.map(x=>Object.keys(x)),[['homeAway','score','team','winner'],['homeAway','score','team','winner']],'the winner flag follows the deployment-1 competitor keys');
  assert.deepEqual(scheduled.competitions[0].competitors.map(x=>Object.keys(x)),[['homeAway','score','team'],['homeAway','score','team']],'no winner flag where ESPN sends none');

  // Verbatim: any value in an evidence field (contradictory, malformed or not a string) reaches the pages unchanged, so
  // they judge exactly what ESPN sent.
  for(const value of ['STATUS_FINAL','STATUS_CANCELED','status_final','','post','in',true,false,'true','false',0,1,null,{},['STATUS_FINAL'],{name:'STATUS_FINAL'}]){
    const e=espnEvent({away:'DEN',home:'KC',state:'post',as:'20',hs:'27'}),type=e.competitions[0].status.type,label=JSON.stringify(value);
    e.status.type.name=type.state=type.completed=type.name=value;
    for(const x of e.competitions[0].competitors)x.winner=value;
    const [p]=projected(scoreboard([e])).events,[c]=p.competitions;
    assert.equal(JSON.stringify([p.status.type.name,c.status?.type,c.competitors.map(x=>x.winner)]),JSON.stringify([value,{state:value,completed:value,name:value},[value,value]]),`${label}: copied verbatim`);
    assert(Object.is(p.status.type.name,value)&&Object.is(c.status.type.state,value)&&Object.is(c.status.type.completed,value)&&Object.is(c.status.type.name,value)&&c.competitors.every(x=>Object.is(x.winner,value)),`${label}: the same value, never a coerced copy`);
  }

  // Absent evidence stays absent: no status name, competition status field or winner flag is invented.
  {
    const e=espnEvent({id:'401872999',away:'DEN',home:'KC',state:'post',as:'20',hs:'27'});
    delete e.status.type.name;for(const key of ['state','completed','name'])delete e.competitions[0].status.type[key];
    for(const x of e.competitions[0].competitors)delete x.winner;
    assert.equal(JSON.stringify(projected(scoreboard([e])).events[0]),'{"id":"401872999","date":"2026-09-27T17:00Z","status":{"type":{"state":"post","completed":true,"shortDetail":"Final","detail":"Final"}},"competitions":[{"competitors":[{"homeAway":"home","score":"27","team":{"abbreviation":"KC"}},{"homeAway":"away","score":"20","team":{"abbreviation":"DEN"}}],"status":{"type":{}}}]}');
  }

  // A competition status is projected as the event status is: a non-object status is dropped and a non-object type leaves
  // an empty status, never repaired. Survivor reads each projection exactly as it reads the raw event.
  for(const [label,status,expected] of [
    ['absent',undefined,undefined],
    ['null',null,undefined],
    ['a string','Final',undefined],
    ['an array',[{type:{state:'in',completed:false}}],undefined],
    ['without a type',{clock:0,displayClock:'0:00',period:4},{}],
    ['with a null type',{type:null},{}],
    ['with a string type',{type:'STATUS_FINAL'},{}],
    ['with an array type',{type:[{state:'in',completed:false}]},{}],
    ['with an empty type',{type:{}},{type:{}}],
    ['with a partial type',{type:{completed:false,description:'Canceled'}},{type:{completed:false}}]
  ]){
    const e=espnEvent({away:'DEN',home:'KC',state:'post',as:'20',hs:'27'});
    if(status===undefined)delete e.competitions[0].status;else e.competitions[0].status=status;
    const payload=scoreboard([e]),[c]=projected(payload).events[0].competitions;
    if(expected===undefined)assert.equal('status' in c,false,`competition status ${label}: no status key`);
    else assert.equal(JSON.stringify(c.status),JSON.stringify(expected),`competition status ${label}: projected status`);
    assert.deepEqual(survivorBuildResults(projected(payload).events,{season:2026,week:3}),survivorBuildResults(payload.events,{season:2026,week:3}),`competition status ${label}: same Survivor results`);
  }
}

// ---- HDC-10 R2: Survivor reaches the same safe result from the raw ESPN event and from its projection. A halted or
// contradictory "final" leaves both teams unresolved, so a pick on either side stays pending: never eliminated, never
// advanced. Each field the projection now forwards is needed by one of these cases.
{
  const CONTRADICTIONS=[
    ['STATUS_CANCELED on the event and competition status',e=>{e.status.type.name=e.competitions[0].status.type.name='STATUS_CANCELED'},'status'],
    ['STATUS_SUSPENDED on the event and competition status',e=>{e.status.type.name=e.competitions[0].status.type.name='STATUS_SUSPENDED'},'status'],
    ['STATUS_POSTPONED on the event status only',e=>{e.status.type.name='STATUS_POSTPONED'},'status'],
    ['STATUS_CANCELED on the competition status only',e=>{e.competitions[0].status.type.name='STATUS_CANCELED'},'status'],
    ['completed:true with competition completed:false',e=>{e.competitions[0].status.type.completed=false},'status'],
    ['event post with competition state:in',e=>{e.competitions[0].status.type.state='in'},'status'],
    ['winner flags contradicting the score',e=>{for(const x of e.competitions[0].competitors)x.winner=!x.winner},'winner']
  ];
  for(const [label,mutate,issue] of CONTRADICTIONS){
    const e=espnEvent({away:'DEN',home:'KC',state:'post',as:'20',hs:'27'});mutate(e);
    const payload=scoreboard([e,espnEvent({away:'MIA',home:'BUF',state:'post',as:'10',hs:'24'})]);
    const raw=survivorBuildResults(payload.events,{season:2026,week:3}),proj=survivorBuildResults(projected(payload).events,{season:2026,week:3});
    assert.deepEqual(proj,raw,`${label}: same Survivor results from the raw and the projected feed`);
    for(const team of ['DEN','KC'])assert.deepEqual([proj.get(team)?.unresolved,proj.get(team)?.issue],[true,issue],`${label}: ${team} is unresolved (${issue})`);
    assert.equal(proj.get('BUF').winner,'BUF',`${label}: other games unaffected`);
    for(const pick of ['DEN','KC']){
      const viaProxy=survivorEntryState({picks:[pick]},0,[proj]);
      assert.deepEqual(viaProxy,survivorEntryState({picks:[pick]},0,[raw]),`${label}: a ${pick} pick has the same state either way`);
      assert.deepEqual([viaProxy.status,viaProxy.type],['pending','unresolved'],`${label}: a ${pick} pick stays pending`);
    }
  }
}

// ---- Parameters: Number()-coerced integers, season 2020-2100 and week 1-22, as deployment 1 answered them on
// 2026-09-26 (the first value of a repeated parameter; other parameters ignored). Upstream is pinned to the regular season.
const ACCEPTED=[
  ['season=2026&week=3',2026,3],['season=2026&week=03',2026,3],['season=%202026&week=3',2026,3],['season=2026&week=3e0',2026,3],
  ['season=2026&week=0x3',2026,3],['season=2026&week=%2B3',2026,3],['season=2026&week=+3',2026,3],['season=2026&week=3.0',2026,3],
  ['season=2026&week=0b11',2026,3],['season=2026.0&week=3',2026,3],['season=2020&week=1',2020,1],['season=2100&week=1',2100,1],
  ['season=2026&week=22',2026,22],['season=2026&week=3&week=4',2026,3],['season=2026&week=3&seasontype=3&limit=1&_=123&dates=2025',2026,3]
];
const REJECTED=['season=2026&week=0','season=2026&week=23','season=2019&week=3','season=2101&week=1','season=2026&week=3.5','season=2026&week=',
  '','season=2026','week=3','season=2026&week=Infinity','season=2026&week=-0','season=abc&week=3','season=2026&week=1_0'];
for(const [query,season,week] of ACCEPTED)assert.deepEqual(parseSeasonWeek(new URLSearchParams(query)),{season,week},query);
for(const query of REJECTED)assert.equal(parseSeasonWeek(new URLSearchParams(query)),null,query);
assert.equal(upstreamUrl(2026,3),'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&week=3&seasontype=2');
assert.equal(upstreamUrl(2022,17),'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2022&week=17&seasontype=2');

console.log('score proxy projection, odds subset, final evidence, structure preservation, Survivor parity, legacy whitelist and parameter regressions passed');

// ---- HTTP handler with a stubbed upstream: status codes, bodies and headers for every Origin and method.
const NOW=Date.parse(FETCHED),CACHE='public, max-age=5, s-maxage=10, stale-while-revalidate=20',JSON_TYPE='application/json; charset=utf-8';
const CORS={'access-control-allow-headers':'Accept, Content-Type','access-control-allow-methods':'GET, OPTIONS','access-control-allow-origin':ALLOWED_ORIGIN,vary:'Origin'};
const H={cors:{...CORS,'cache-control':CACHE,'content-type':JSON_TYPE},plain:{'cache-control':CACHE,'content-type':JSON_TYPE},preflight:{...CORS,'cache-control':CACHE},
  corsFailed:{...CORS,'cache-control':'no-store','content-type':JSON_TYPE},plainFailed:{'cache-control':'no-store','content-type':JSON_TYPE}};
const ORIGINS={none:undefined,empty:'',allowed:ALLOWED_ORIGIN,foreign:'https://evil.example','null':'null',slash:`${ALLOWED_ORIGIN}/`,upper:ALLOWED_ORIGIN.toUpperCase(),http:ALLOWED_ORIGIN.replace('https:','http:')};
function harness(upstream=async()=>Response.json(W3),timeoutMs=25){
  const calls=[],handle=createHandler({fetch:async(url,init)=>{calls.push({url,init});return upstream(url,init)},now:()=>NOW,timeoutMs});
  return{calls,async send(method,query,origin){
    const headers=ORIGINS[origin]===undefined?{}:{Origin:ORIGINS[origin]};
    const r=await handle(new Request(`https://score-proxy.test/${query}`,{method,headers}));
    return{status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()};
  }};
}
const Q='?season=2026&week=3',BAD='?season=2026&week=0',error=code=>JSON.stringify({error:code}),OK=JSON.stringify(projected(W3));
const MATRIX=[
  // GET: an absent or empty Origin is served without CORS headers; any other Origin but the Pages origin is refused
  // before the parameters are read.
  ['GET','allowed',Q,200,OK,H.cors],['GET','none',Q,200,OK,H.plain],['GET','empty',Q,200,OK,H.plain],
  ['GET','foreign',Q,403,error('origin_not_allowed'),H.plain],['GET','null',Q,403,error('origin_not_allowed'),H.plain],
  ['GET','slash',Q,403,error('origin_not_allowed'),H.plain],['GET','upper',Q,403,error('origin_not_allowed'),H.plain],['GET','http',Q,403,error('origin_not_allowed'),H.plain],
  ['GET','allowed',BAD,400,error('invalid_season_or_week'),H.cors],['GET','none',BAD,400,error('invalid_season_or_week'),H.plain],
  ['GET','foreign',BAD,403,error('origin_not_allowed'),H.plain],
  // The path is not part of the contract.
  ['GET','allowed',`other/path${Q}`,200,OK,H.cors],
  // OPTIONS: only the Pages origin gets a preflight answer, whatever the parameters.
  ['OPTIONS','allowed',Q,204,'',H.preflight],['OPTIONS','allowed',BAD,204,'',H.preflight],
  ['OPTIONS','none',Q,403,error('origin_not_allowed'),H.plain],['OPTIONS','empty',Q,403,error('origin_not_allowed'),H.plain],
  ['OPTIONS','foreign',Q,403,error('origin_not_allowed'),H.plain],['OPTIONS','null',Q,403,error('origin_not_allowed'),H.plain],
  // Every other method is 405 whatever the Origin; CORS headers only for the Pages origin.
  ['POST','allowed',Q,405,error('method_not_allowed'),H.cors],['POST','none',Q,405,error('method_not_allowed'),H.plain],
  ['POST','foreign',Q,405,error('method_not_allowed'),H.plain],['POST','null',Q,405,error('method_not_allowed'),H.plain],
  ['HEAD','allowed',Q,405,error('method_not_allowed'),H.cors],['HEAD','none',Q,405,error('method_not_allowed'),H.plain],
  ['HEAD','foreign',Q,405,error('method_not_allowed'),H.plain],['HEAD','null',Q,405,error('method_not_allowed'),H.plain],
  ['PUT','allowed',Q,405,error('method_not_allowed'),H.cors],['DELETE','none',Q,405,error('method_not_allowed'),H.plain]
];
for(const [method,origin,query,status,body,headers] of MATRIX){
  const h=harness(),r=await h.send(method,query,origin),label=`${method} ${origin} ${query}`;
  assert.equal(r.status,status,`${label}: status`);
  assert.equal(r.body,body,`${label}: body`);
  assert.deepEqual(r.headers,headers,`${label}: headers`);
  if(status===200){
    assert.equal(h.calls.length,1,`${label}: one upstream request`);
    assert.equal(h.calls[0].url,upstreamUrl(2026,3),`${label}: exact upstream URL`);
    assert.equal(new Headers(h.calls[0].init.headers).get('accept'),'application/json');
    assert(h.calls[0].init.signal instanceof AbortSignal,`${label}: upstream request is time-limited`);
  }else assert.equal(h.calls.length,0,`${label}: no upstream request`);
}


// HDC-09 — explicit ESPN season/week context must be validated before projection strips it. Contradictions fail
// closed with the existing upstream-integrity contract; genuinely absent context remains compatible.
{
  const expectContextFailure=async(label,payload)=>{
    const h=harness(async()=>Response.json(payload)),r=await h.send('GET',Q,'allowed');
    assert.equal(r.status,502,`${label}: contradictory upstream context must fail closed`);
    assert.equal(r.body,error('upstream_unavailable'),`${label}: existing upstream failure body`);
    assert.deepEqual(r.headers,H.corsFailed,`${label}: contradictory context is never cacheable`);
    assert.deepEqual(h.calls.map(c=>c.url),[upstreamUrl(2026,3)],`${label}: requested upstream URL is unchanged`);
  };

  // TEST A — wrong payload week.
  const wrongPayloadWeek=structuredClone(W3);wrongPayloadWeek.week.number=2;
  await expectContextFailure('wrong payload week',wrongPayloadWeek);

  // TEST B — wrong payload season.
  const wrongPayloadSeason=structuredClone(W3);wrongPayloadSeason.season.year=2025;
  await expectContextFailure('wrong payload season',wrongPayloadSeason);

  // TEST C — wrong top-level season type.
  const wrongPayloadType=structuredClone(W3);wrongPayloadType.season.type=3;
  await expectContextFailure('wrong payload season type',wrongPayloadType);

  // TEST D — event-level contradictions. Top-level context stays correct.
  const wrongEventSeason=structuredClone(W3);wrongEventSeason.events[0].season.year=2025;
  await expectContextFailure('wrong event season',wrongEventSeason);
  const wrongEventWeek=structuredClone(W3);wrongEventWeek.events[0].week.number=2;
  await expectContextFailure('wrong event week',wrongEventWeek);
  const wrongEventType=structuredClone(W3);wrongEventType.events[0].season.type=3;
  await expectContextFailure('wrong event season type',wrongEventType);

  // TEST E — correct context preserves the successful response projection, event order, scores, odds and fetchedAt.
  const correct=harness(async()=>Response.json(W3)),correctResponse=await correct.send('GET',Q,'allowed');
  assert.equal(correctResponse.status,200,'correct ESPN context remains successful');
  assert.equal(correctResponse.body,OK,'correct context keeps the exact existing projected body');
  assert.deepEqual(correctResponse.headers,H.cors,'correct context keeps successful cache/CORS headers');

  // TEST F — context absent is still accepted; no season/week/type is invented or required.
  const absent=structuredClone(W3);
  delete absent.season;delete absent.week;
  for(const event of absent.events){delete event.season;delete event.week}
  const absentHarness=harness(async()=>Response.json(absent)),absentResponse=await absentHarness.send('GET',Q,'allowed');
  assert.equal(absentResponse.status,200,'absent context remains compatible');
  assert.equal(absentResponse.body,JSON.stringify(projected(absent)),'absent context keeps the existing projection');
  assert.deepEqual(absentResponse.headers,H.cors,'absent context keeps successful cache/CORS headers');
}

// HDC-10 — final evidence is forwarded, never judged: unlike contradictory context, a "final" that contradicts itself (a
// completed STATUS_CANCELED event whose competition status says it is not completed and whose winner flags contradict the
// score) is a successful, cacheable 200 carrying that evidence verbatim. The pages refuse to grade it; the proxy neither
// rejects nor repairs it.
{
  const e=espnEvent({away:'DEN',home:'KC',state:'post',as:'20',hs:'27'});
  e.status.type.name='STATUS_CANCELED';e.competitions[0].status.type.completed=false;
  for(const x of e.competitions[0].competitors)x.winner=!x.winner;
  const payload=scoreboard([e]),h=harness(async()=>Response.json(payload)),r=await h.send('GET',Q,'allowed');
  assert.equal(r.status,200,'contradictory final evidence is forwarded, not rejected');
  assert.deepEqual(r.headers,H.cors,'contradictory final evidence keeps the successful cache/CORS headers');
  assert.equal(r.body,JSON.stringify(projected(payload)));
  const [p]=JSON.parse(r.body).events;
  assert.equal(p.status.type.name,'STATUS_CANCELED');
  assert.deepEqual(p.competitions[0].status,{type:{state:'post',completed:false,name:'STATUS_FINAL'}});
  assert.deepEqual(p.competitions[0].competitors.map(x=>[x.team.abbreviation,x.score,x.winner]),[['KC','27',false],['DEN','20',true]]);
}
// Coerced parameters reach ESPN as plain integers; seasontype, limit and _ are never forwarded.
for(const [query,season,week] of ACCEPTED){
  const h=harness(async()=>Response.json(scoreboard([],week,season))),r=await h.send('GET',`?${query}`,'allowed');
  assert.equal(r.status,200,query);
  assert.deepEqual(h.calls.map(c=>c.url),[upstreamUrl(season,week)],query);
  assert.equal(r.body,JSON.stringify({fetchedAt:FETCHED,events:[]}),`${query}: an empty week is 200 with no events`);
}
for(const query of REJECTED){
  const h=harness(),r=await h.send('GET',`?${query}`,'allowed');
  assert.equal(r.status,400,query);assert.equal(h.calls.length,0,query);
}

// NEW: a failed upstream is 502 upstream_unavailable and never cacheable, with CORS headers for the Pages origin.
const hang=(url,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
const stall=(url,init)=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"events":['));init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true})}}),{status:200,headers:{'content-type':'application/json'}});
const FAILURES=[
  ['HTTP 500',async()=>new Response('upstream error',{status:500})],
  ['HTTP 404 with JSON',async()=>Response.json({events:[]},{status:404})],
  ['HTTP 304',async()=>new Response(null,{status:304})],
  ['network error',async()=>{throw new TypeError('fetch failed')}],
  ['non-JSON body',async()=>new Response('<html>busy</html>',{status:200,headers:{'content-type':'text/html'}})],
  ['events missing',async()=>Response.json({leagues:[]})],
  ['events not an array',async()=>Response.json({events:{}})],
  ['JSON null',async()=>Response.json(null)],
  ['JSON array',async()=>Response.json([])],
  ['no response before the time limit',hang],
  ['body stalls past the time limit',stall]
];
for(const [label,upstream] of FAILURES){
  for(const [origin,headers] of [['allowed',H.corsFailed],['none',H.plainFailed]]){
    const keepAlive=setTimeout(()=>{},5000),h=harness(upstream),started=Date.now(),r=await h.send('GET',Q,origin);clearTimeout(keepAlive);
    assert.equal(r.status,502,`${label} (${origin}): status`);
    assert.equal(r.body,error('upstream_unavailable'),`${label} (${origin}): body`);
    assert.deepEqual(r.headers,headers,`${label} (${origin}): headers`);
    assert.deepEqual(h.calls.map(c=>c.url),[upstreamUrl(2026,3)]);
    assert(Date.now()-started<2000,`${label} (${origin}): settles at the time limit`);
    if(upstream===hang||upstream===stall)assert.equal(h.calls[0].init.signal.reason?.name,'TimeoutError',`${label}: aborted by the time limit`);
  }
}

// The default export uses the runtime's global fetch, resolved per request.
{
  const realFetch=globalThis.fetch,seen=[];
  globalThis.fetch=async(url,init)=>{seen.push({url,init});return Response.json(W3)};
  try{
    const r=await proxy.fetch(new Request(`https://score-proxy.test/${Q}`,{headers:{Origin:ALLOWED_ORIGIN}}));
    assert.equal(r.status,200);
    assert.deepEqual(Object.fromEntries(r.headers),H.cors);
    const body=await r.json();
    assert.match(body.fetchedAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(body.events,projected(W3).events);
    assert.deepEqual(seen.map(c=>c.url),[upstreamUrl(2026,3)]);
    assert(seen[0].init.signal instanceof AbortSignal);
  }finally{globalThis.fetch=realFetch}
}

console.log('score proxy HTTP handler origin, method, parameter, header, context, final-evidence pass-through, upstream-failure and default-export regressions passed');
