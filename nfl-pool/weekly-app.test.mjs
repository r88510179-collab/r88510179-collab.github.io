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
  await import(`data:text/javascript;base64,${Buffer.from(patched+`\n//instance ${++instance}`).toString('base64')}`);
  await flush();
  const warning=()=>$('error').children[0]?.textContent||'';
  return{
    $,warning,
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

console.log('weekly public feed-context, malformed-event isolation, fail-safe preservation and foreground-refresh regressions passed');
