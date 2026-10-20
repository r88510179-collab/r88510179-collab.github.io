// Pool Center season record: season-record.js with the poolcenter:season answers of weekly-app.js. The pure helpers are checked
// directly; everything else runs on the page as index.html loads it: the unmodified weekly-app.js and season-record.js in one
// document (every import pointed at its file), on a virtual clock that keeps every real duration, with the Neon Data API
// (anonymous role, public columns, eq./lte. filters) and the score feed stood in for. Every request is logged and told apart:
// the page's own (the index, the selected week's row and feed, the week-scoped rules and rulings) and the season history's
// (another week's row or feed, the season-wide rules and rulings). Each regression reports through one collector; the suite
// fails at its end if any did.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {winPct,recordText,weekList,weekRulings,seasonStatusText,READ_TIMEOUT_MS,FEED_EVERY_MS,RULINGS_EVERY_MS,RETRY_MS,MAX_READS} from './season-record.js';

const failures=[];
const check=async(name,fn)=>{try{await fn()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};

// ---- Pure helpers.
await check('the reads keep the page’s own limits and cadence: 15 s per read, an unresolved week’s feed at most once per refresh, the rules and rulings once a minute',()=>{
  assert.deepEqual({READ_TIMEOUT_MS,FEED_EVERY_MS,RULINGS_EVERY_MS,RETRY_MS,MAX_READS},{READ_TIMEOUT_MS:15000,FEED_EVERY_MS:15000,RULINGS_EVERY_MS:60000,RETRY_MS:15000,MAX_READS:4});
});
await check('winPct: wins ÷ (wins + losses) × 100 to one decimal, rounded half up exactly; an em dash until a game is graded',()=>{
  for(const [w,l,want] of [[50,36,'58.1%'],[52,34,'60.5%'],[36,50,'41.9%'],[8,5,'61.5%'],[7,6,'53.8%'],[0,13,'0.0%'],[13,0,'100.0%'],[1,7,'12.5%'],
    [1,15,'6.3%'],[1,79,'1.3%'],[3,16,'15.8%'],[5,16,'23.8%'],[2,1,'66.7%'],[1,2,'33.3%'],[5,7,'41.7%'],[5,2,'71.4%'],[2,5,'28.6%'],[0,0,'—'],
    // Exact halves that a binary fraction rounds down (41/80 = 51.25%: toFixed gives 51.2%): rounded half up, as written.
    [41,39,'51.3%'],[23,57,'28.8%'],[51,29,'63.8%'],[82,78,'51.3%'],[153,87,'63.8%']])
    assert.equal(winPct(w,l),want,`${w}-${l}`);
  for(const [w,l] of [[-1,3],[1.5,2],['3',1],[null,1],[undefined,undefined],[Number.NaN,1],[1,Infinity]])assert.equal(winPct(w,l),'—',`${w}-${l} is not a record`);
  assert.equal(recordText(50,36),'50–36');
});
await check('weekList names the weeks a record covers as ranges',()=>{
  assert.equal(weekList([4]),'Week 4');assert.equal(weekList([1,2,3,4,5,6]),'Weeks 1–6');assert.equal(weekList([6,3]),'Weeks 3 and 6');
  assert.equal(weekList([1,2,3,5]),'Weeks 1–3 and 5');assert.equal(weekList([1,3,5,7]),'Weeks 1, 3, 5 and 7');assert.equal(weekList([2,2]),'Week 2');assert.equal(weekList([]),'');
});
await check('weekRulings gives each week exactly its own rows, as the page’s week-scoped read; a row no week can claim reaches every week, so each holds',()=>{
  const rows=[{week:1,id:'a'},{week:2,id:'b'},{week:2,id:'c'}],data={contests:['contest'],policies:['policy'],rulings:rows};
  assert.deepEqual(weekRulings(data,2),{contests:['contest'],policies:['policy'],rulings:[rows[1],rows[2]]});
  assert.deepEqual(weekRulings(data,3).rulings,[]);
  for(const stray of [{week:'2'},{week:0},{week:23},{week:2.5},null,[2],{}])assert.equal(weekRulings({...data,rulings:[...rows,stray]},1).rulings.length,4,JSON.stringify(stray));
});
await check('seasonStatusText says why a season record is not shown, and nothing once it is complete',()=>{
  assert.equal(seasonStatusText({status:'complete',reasons:[]}),null);
  assert.equal(seasonStatusText({status:'loading',reasons:[]}),'Loading the season record…');
  assert.equal(seasonStatusText({status:'delayed',reasons:['Week 3 scores could not be refreshed']}),'Season record as last verified · Week 3 scores could not be refreshed.');
  assert.equal(seasonStatusText({status:'incomplete',reasons:['Week 2 is not published','Week 4 is loading']}),'Season record incomplete: Week 2 is not published (and 1 more week). It returns once every published week is verified.');
});

// ---- The page.
const patch=(source,names)=>source.replace(new RegExp(`from '\\./(${names})\\.js\\?v=(\\d+)';`,'g'),(_,name,version)=>`from '${new URL(`./${name}.js?v=${version}`,import.meta.url).href}';`);
const weeklySource=patch(readFileSync(new URL('./weekly-app.js',import.meta.url),'utf8'),'public-math|contest-rulings');
const seasonSource=patch(readFileSync(new URL('./season-record.js',import.meta.url),'utf8'),'contest-rulings');
assert(!/from '\.\//.test(weeklySource)&&!/from '\.\//.test(seasonSource),'the page harness points every import at its file');
let instance=0;
class PageEl{
  constructor(){this.text='';this.innerHTML='';this.className='';this.value='';this.hidden=false;this.disabled=false;this.style={};this.listeners={};this.children=[]}
  get textContent(){return this.text}
  set textContent(v){this.text=v==null?'':String(v)}
  addEventListener(t,f){(this.listeners[t]||=[]).push(f)}
  replaceChildren(...nodes){this.children=[...nodes]}
  appendChild(node){this.children.push(node);return node}
}
// The virtual clock of the HDC-15 suites: every timer keeps its real duration and fires in time order as the clock advances;
// Date.now() and new Date() read the virtual time; a 0 ms timer (the harness's flush) is left to the real event loop.
// jump() lets time pass with no timer firing.
function virtualClock(){
  const real={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,Date:globalThis.Date},RealDate=real.Date,timers=new Map();
  let now=RealDate.parse('2026-10-18T20:00:00.000Z'),seq=0;
  const add=(fn,ms,args)=>{const id=++seq;timers.set(id,{fn,args,at:now+Math.max(0,Number(ms)||0),seq:id});return id};
  class VirtualDate extends RealDate{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}
  globalThis.setTimeout=(fn,ms,...args)=>Number(ms)>0?add(fn,ms,args):real.setTimeout(fn,0,...args);
  globalThis.clearTimeout=id=>{if(!timers.delete(id))real.clearTimeout(id)};
  globalThis.Date=VirtualDate;
  const settle=async()=>{for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r))};
  const next=end=>{let hit=null;for(const [id,t] of timers)if(t.at<=end&&(!hit||t.at<hit.t.at||(t.at===hit.t.at&&t.seq<hit.t.seq)))hit={id,t};return hit};
  return{
    now:()=>now,
    pending:()=>timers.size,
    async advance(ms){const end=now+ms;await settle();for(let hit=next(end);hit;hit=next(end)){const {id,t}=hit;now=Math.max(now,t.at);timers.delete(id);t.fn(...t.args);await settle()}now=end;await settle()},
    jump(ms){now+=ms},
    restore(){globalThis.setTimeout=real.setTimeout;globalThis.clearTimeout=real.clearTimeout;globalThis.Date=real.Date}
  };
}
const flush=async(n=80)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};
const S=1000,REFRESH=20*S;

// Published weeks. games: [away, home]; each tracked entry's picks are one letter per game, a (away) or h (home), or null for a
// proven no-submission (every pick null, no tiebreak). An entry given no id is published without one.
const PK='pool-center-2026-pickem',AT='2026-10-18T13:38:04.360+00:00';
const PEOPLE=[['dc','D.C.'],['jc','JC'],['djs','DJS'],['thaddeus','Thaddeus']];
const entry=(id,displayName,picks,tiebreak=40)=>({id,displayName,picks,tiebreak});
const four=(picks,names={})=>PEOPLE.map(([id,name])=>entry(id,names[id]??name,picks[id]));
function weekCfg(week,games,entries,{season=2026,tiebreakGameIndex=games.length-1}={}){
  return{schemaVersion:1,season,week,tiebreakGameIndex,label:`Week ${week}`,
    games:games.map(([away,home],i)=>({away,home,awayNumber:2*i+1,homeNumber:2*i+2,date:`${season}-10-18`})),
    participants:entries.map(e=>({...(e.id===undefined?{}:{id:e.id}),displayName:e.displayName,
      pickNumbers:e.picks===null?games.map(()=>null):[...e.picks].map((c,i)=>c==='a'?2*i+1:2*i+2),tiebreak:e.picks===null?null:e.tiebreak}))};
}
const row=(cfg,revision=1,o={})=>({season:cfg.season,week:cfg.week,status:'locked',revision,published_at:AT,locked_at:AT,config:structuredClone(cfg),...o});
const STATUS={final:{state:'post',completed:true,name:'STATUS_FINAL',shortDetail:'Final'},live:{state:'in',completed:false,name:'STATUS_IN_PROGRESS',shortDetail:'10:00 - 3rd'},
  scheduled:{state:'pre',completed:false,name:'STATUS_SCHEDULED',shortDetail:'Sun 1:00 PM'},canceled:{state:'post',completed:false,name:'STATUS_CANCELED',shortDetail:'Canceled'}};
const eventId=(week,i)=>String(401000000+week*100+i);
const ev=(week,i,away,home,{kind='final',awayScore=0,homeScore=0,season=2026}={})=>({id:eventId(week,i),date:`${season}-10-18T17:00Z`,season:{year:season,type:2},week:{number:week},
  status:{type:{...STATUS[kind]}},competitions:[{competitors:[{homeAway:'home',team:{abbreviation:home},score:String(homeScore)},{homeAway:'away',team:{abbreviation:away},score:String(awayScore)}]}]});

// The season the regressions start from (2026, Weeks 1-3 published, Week 3 the latest and live):
//   Week 1  DEN 24 @ KC 17 (DEN), BUF 20 @ CIN 27 (CIN)          D.C. 2-0 · JC 1-1 · DJS 1-1 · Thaddeus 0-2
//   Week 2  NYG 27 @ WAS 27 (NFL tie), DAL 31 @ PHI 20 (DAL)     D.C. 1-1 · JC 0-2 · DJS 0-2 · Thaddeus 0-2 (no picks)
//   Week 3  SF 30 @ SEA 10 (SF), LAR @ ARI live, GB @ MIN later  D.C. 1-0 · JC 0-1 · DJS 1-0 · Thaddeus 1-0
//   Season  D.C. 4-1 (80.0%) · JC 1-4 (20.0%) · DJS 2-3 (40.0%) · Thaddeus 1-4 (20.0%) · 5 graded games, 2 not yet
const G1=[['DEN','KC'],['BUF','CIN']],G2=[['NYG','WAS'],['DAL','PHI']],G3=[['SF','SEA'],['LAR','ARI'],['GB','MIN']];
const W1=(picks={})=>weekCfg(1,G1,four({dc:'ah',jc:'hh',djs:'aa',thaddeus:'ha',...picks}));
const W2=()=>weekCfg(2,G2,four({dc:'ha',jc:'ah',djs:'hh',thaddeus:null}));
const W3=()=>weekCfg(3,G3,four({dc:'aaa',jc:'hah',djs:'aha',thaddeus:'aah'}));
const F1=()=>({events:[ev(1,0,'DEN','KC',{awayScore:24,homeScore:17}),ev(1,1,'BUF','CIN',{awayScore:20,homeScore:27})]});
const F2=()=>({events:[ev(2,0,'NYG','WAS',{awayScore:27,homeScore:27}),ev(2,1,'DAL','PHI',{awayScore:31,homeScore:20})]});
// stage 0: SF final, LAR-ARI live, GB-MIN scheduled; 1: LAR 24-21 final too; 2: every game final (MIN 20-17).
const F3=(stage=0)=>({events:[ev(3,0,'SF','SEA',{awayScore:30,homeScore:10}),ev(3,1,'LAR','ARI',stage?{awayScore:24,homeScore:21}:{kind:'live',awayScore:14,homeScore:10}),
  ev(3,2,'GB','MIN',stage>1?{awayScore:17,homeScore:20}:{kind:'scheduled'})]});
const BASE=()=>({published:[row(W1()),row(W2()),row(W3())],feeds:{1:F1(),2:F2(),3:F3()}});
const contestRows=()=>({nfl_contests:[{contest_id:PK,season:2026,contest_type:'pickem',display_name:"Pool Center 2026 Pick'em",starts_at:'2026-09-10T00:20:00+00:00',created_at:'2026-10-08T04:34:04.856+00:00',created_by:null}],
  nfl_contest_policies:[{contest_id:PK,contest_type:'pickem',revision:1,effective_week:1,halted_game_policy:'void',public_note:'Approved policy for this contest.',admin_note:'private',created_at:'2026-10-08T04:34:04.856+00:00',created_by:null}],
  nfl_incident_rulings:[]});
const ruling=(o={})=>({ruling_id:1,contest_id:PK,contest_type:'pickem',week:1,away_team:'BUF',home_team:'CIN',policy_revision:1,chain_seq:1,parent_ruling_id:null,consequence:'void',
  incident_status:'STATUS_CANCELED',event_id:eventId(1,1),evidence_source:'nflscores2',public_note:'Voided for this contest.',admin_note:'private',created_at:'2026-10-09T12:00:00+00:00',created_by:null,...o});

// The Data API as the anonymous role sees it: only the public columns of the three contest tables can be selected, and rows
// are filtered by eq./lte. filters; the publication table answers eq. filters with the requested columns.
const RULING_COLUMNS={
  nfl_contests:['contest_id','season','contest_type','display_name','starts_at','created_at'],
  nfl_contest_policies:['contest_id','contest_type','revision','effective_week','halted_game_policy','public_note','created_at'],
  nfl_incident_rulings:['ruling_id','contest_id','contest_type','week','away_team','home_team','policy_revision','chain_seq','parent_ruling_id','consequence','incident_status','event_id','evidence_source','public_note','created_at']
};
const PUB_COLUMNS=['season','week','status','config','revision','published_at','locked_at','source_filename','source_sha256','created_at','updated_at'];
const ok=data=>({ok:true,status:200,json:async()=>structuredClone(data)}),httpError=status=>({ok:false,status,json:async()=>({})});
function rulingsApi(table,rows,u){
  const select=(u.searchParams.get('select')||'*').split(','),allowed=RULING_COLUMNS[table];
  if(select.some(c=>!allowed.includes(c)))return{ok:false,status:401,json:async()=>({message:`permission denied for table ${table}`})};
  const filters=[...u.searchParams].filter(([k])=>k!=='select'&&k!=='order');
  if(filters.some(([k,v])=>!allowed.includes(k)||!/^(eq|lte)\./.test(v)))return httpError(400);
  const keep=r=>filters.every(([k,v])=>{const [op,...rest]=v.split('.'),want=rest.join('.'),have=r[k],w=typeof have==='number'?Number(want):want;return op==='eq'?have===w:have<=w});
  return ok(rows.filter(keep).map(r=>Object.fromEntries(select.map(c=>[c,r[c]]))));
}
function publicationApi(rows,u){
  const select=(u.searchParams.get('select')||'*').split(',');
  if(select.some(c=>!PUB_COLUMNS.includes(c)))return httpError(400);
  const filters=[...u.searchParams].filter(([k])=>k!=='select'&&k!=='order');
  if(filters.some(([k,v])=>!PUB_COLUMNS.includes(k)||!/^eq\./.test(v)))return httpError(400);
  return ok(rows.filter(r=>filters.every(([k,v])=>String(r[k])===v.slice(3))).map(r=>Object.fromEntries(select.map(c=>[c,r[c]??null]))));
}
const hang=init=>new Promise((_,reject)=>init?.signal?.addEventListener('abort',()=>{const e=new Error('The operation was aborted.');e.name='AbortError';reject(e)},{once:true}));

let clock=null;
async function page({view='home',week=null,season=2026,published,feeds,store=contestRows(),bootHooks={},prepare=null}={}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new PageEl());return els.get(id)},listeners={},intervals=[],calls=[],storage=[];
  const doc={body:{dataset:{}},title:'',visibilityState:'visible',getElementById:$,querySelectorAll(){return[]},createElement(){return new PageEl()},
    addEventListener(t,f){(listeners[t]||=[]).push(f)},dispatchEvent(e){for(const f of listeners[e.type]||[])f(e);return true}};
  globalThis.document=doc;globalThis.window={addEventListener(){},scrollTo(){}};
  const search=`?view=${view}${week?`&season=${season}&week=${week}`:''}`;
  globalThis.location={href:`https://example.test/nfl-pool/${search}`,search};
  globalThis.history={state:null,pushState(){},replaceState(){}};
  globalThis.setInterval=(fn,ms)=>{intervals.push({fn,ms});return intervals.length};
  globalThis.localStorage={getItem(k){storage.push(['get',k]);return null},setItem(k){storage.push(['set',k])},removeItem(k){storage.push(['remove',k])}};
  const net={published:structuredClone(published),feeds:{...feeds},store,hooks:{...bootHooks}};
  const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.y';
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/token/anonymous')){calls.push({kind:'token'});return net.hooks.token?.(u,init)??ok({token})}
    if(u.pathname.endsWith('/nfl_pool_weeks')){
      const kind=(u.searchParams.get('select')||'').split(',').includes('config')?'row':'index',w=u.searchParams.get('week');
      const call={kind,week:w?Number(w.slice(3)):null};calls.push(call);
      return net.hooks[kind]?.(u,init,call)??publicationApi(net.published,u);
    }
    const table=Object.keys(RULING_COLUMNS).find(t=>u.pathname.endsWith(`/${t}`));
    if(table){
      const call={kind:'rulings',table,scope:table==='nfl_incident_rulings'?(u.searchParams.has('week')?'week':'season'):null};calls.push(call);
      const hooked=net.hooks.rulings?.(u,init,call);if(hooked)return hooked;
      const rows=net.store[table];if(typeof rows==='number')return httpError(rows);
      return rulingsApi(table,rows,u);
    }
    const w=Number(u.searchParams.get('week')),call={kind:'feed',week:w};calls.push(call);
    const hooked=net.hooks.feed?.(u,init,call);if(hooked)return hooked;
    const payload=net.feeds[w];
    if(typeof payload==='number')return httpError(payload);
    return payload?ok(payload):httpError(404);
  };
  prepare?.({$,doc,net});
  await import(`data:text/javascript;base64,${Buffer.from(weeklySource+`\n//page ${++instance}`).toString('base64')}`);
  await import(`data:text/javascript;base64,${Buffer.from(seasonSource+`\n//season ${instance}`).toString('base64')}`);
  await flush();
  const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const v={
    $,doc,net,calls,intervals,storage,
    async tick(){doc.visibilityState='visible';for(const t of intervals)t.fn();await flush()},
    async refresh(ms=REFRESH){clock.jump(ms);await v.tick()},
    async choose(s,w){const select=$('weekSelect');select.value=`${s}-${w}`;for(const fn of select.listeners.change||[])fn();await flush()},
    async click(target){for(const f of listeners.click||[])f({target:{closest:sel=>sel==='[data-view-target]'?{dataset:{viewTarget:target}}:null},preventDefault(){}});await flush()},
    setVisibility(state){doc.visibilityState=state;for(const f of listeners.visibilitychange||[])f({type:'visibilitychange'})},
    ask(op,extra={}){const detail={op,...extra,result:null};doc.dispatchEvent(new CustomEvent('poolcenter:season',{detail}));return detail.result},
    // The page's own weekly standings rows: [entry, W, L].
    standing:()=>$('standings').innerHTML.split('</tr>').filter(Boolean).map(r=>[...r.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(m=>text(m[1]))).map(c=>[c[1],c[3],c[4]]),
    chips:()=>[...$('homeSeason').innerHTML.matchAll(/<div class="season-chip">(.*?)<\/div>/g)].map(m=>[...m[1].matchAll(/<span[^>]*>(.*?)<\/span>/g)].map(x=>text(x[1]))),
    cardRows:()=>($('seasonRecord').innerHTML.split('<tbody>')[1]||'').split('</tbody>')[0].split('</tr>').filter(Boolean).map(r=>[...r.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(m=>text(m[1]))),
    notes:()=>[...($('seasonRecord').innerHTML.split('<div class="season-notes">')[1]||'').matchAll(/<p[^>]*>(.*?)<\/p>/g)].map(m=>text(m[1])),
    homeNotes:()=>[...$('homeSeason').innerHTML.matchAll(/<p class="season-strip-status">(.*?)<\/p>/g)].map(m=>text(m[1])),
    meta:()=>$('seasonMeta').textContent,
    // Requests since `from`, split into the page's own and the season history's (pageWeek: the week the page has selected).
    split(from=0,pageWeek=3){
      const page={token:0,index:0,row:[],feed:[],rulings:0},lane={row:[],feed:[],rulings:0},rest=[];
      for(const c of calls.slice(from)){
        if(c.kind==='token')page.token++;else if(c.kind==='index')page.index++;
        else if(c.kind==='rulings'){if(c.table!=='nfl_incident_rulings')rest.push(c);else if(c.scope==='season')lane.rulings++;else page.rulings++}
        else (c.week===pageWeek?page:lane)[c.kind].push(c.week);
      }
      // The contest and policy tables carry no week: each read of them goes with one read of the rulings table.
      return{page,lane,contestReads:rest.length};
    }
  };
  return v;
}
const lane=(v,from,pageWeek=3)=>v.split(from,pageWeek).lane;
const pageReads=(v,from,pageWeek=3)=>{const p=v.split(from,pageWeek).page;delete p.token;return p};
const QUIET={row:[],feed:[],rulings:0};
const SEASON=[['D.C.','4–1','80.0%'],['JC','1–4','20.0%'],['DJS','2–3','40.0%'],['Thaddeus','1–4','20.0%']];

// The page's own console warnings and errors (a failed read, a boot that cannot load) are collected rather than printed; their
// stacks embed the whole data: URL. No assertion reads them.
const consoleOut=[],{warn,error}=console;
console.warn=(...a)=>consoleOut.push(a);console.error=(...a)=>consoleOut.push(a);
clock=virtualClock();
try{

await check('boot: the season record adds up every published week as the page grades it, on Home and on Standings alike; the selected week sits beside it',async()=>{
  const v=await page(BASE());
  assert.deepEqual(v.chips(),SEASON,'Home: each tracked entry’s season W–L and winning percentage, in published order');
  assert.deepEqual(v.cardRows(),[['D.C.','1–0','100.0%','4–1','80.0%'],['JC','0–1','0.0%','1–4','20.0%'],['DJS','1–0','100.0%','2–3','40.0%'],['Thaddeus','1–0','100.0%','1–4','20.0%']],'Standings: Week 3 and the season');
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 5 graded games');
  assert.deepEqual(v.notes(),['Thaddeus: no picks submitted in Week 2. Every graded game that week counts as a loss, as in the weekly standings.','2 live or upcoming games not graded yet.',
    'Win % = wins ÷ (wins + losses), to one decimal; — until a game is graded. An NFL tie is a loss for both picks. Win % is a win–loss rate, not the field percentile (Top %) in Your Group.']);
  assert.deepEqual(v.homeNotes(),[],'a complete season record needs no note on Home');
  assert(v.$('seasonRecord').innerHTML.includes('<th scope="colgroup" colspan="2" class="c season-group">Week 3</th><th scope="colgroup" colspan="2" class="c season-group">Season</th>'),'the weekly and season columns are labelled');
  // Home and Standings consistency: the same season numbers in both places, and the selected week's W–L is the page's own.
  assert.deepEqual(v.cardRows().map(r=>[r[0],r[3],r[4]]),v.chips());
  const weekly=new Map(v.standing().map(([name,w,l])=>[name,`${w}–${l}`]));
  for(const r of v.cardRows())assert.equal(r[1],weekly.get(r[0]),`${r[0]}: the Week 3 W–L of Your Group`);
});

await check('the season record is exactly the sum of the weekly records the page itself shows for each week, the NFL tie a loss for both picks and the no-submission week a loss per graded game',async()=>{
  const v=await page(BASE()),sum=new Map();
  for(const week of [1,2,3]){
    await v.choose(2026,week);
    for(const [name,w,l] of v.standing()){const t=sum.get(name)||[0,0];sum.set(name,[t[0]+Number(w),t[1]+Number(l)])}
    if(week===2)assert.deepEqual(v.standing(),[['D.C.','1','1'],['JC','0','2'],['DJS','0','2'],['Thaddeus','0','2']],'Week 2: the NFL tie is a loss for both picks; no picks is a loss per graded game');
    assert.deepEqual(v.chips(),SEASON,`Week ${week} on screen: the season record does not move`);
  }
  assert.deepEqual(PEOPLE.map(([,name])=>[name,`${sum.get(name)[0]}–${sum.get(name)[1]}`,winPct(...sum.get(name))]),SEASON);
});

await check('reads: the page’s own refresh is unchanged; the history reads each other week’s row and feed once and the season’s rules and rulings once, then nothing while every other week is settled, and the rules and rulings again only after a minute',async()=>{
  const v=await page(BASE());
  const boot=v.split(0);
  assert.deepEqual([boot.page.index,boot.page.row,boot.page.feed,boot.page.rulings],[1,[3],[3],1],'the page boots as before: the index, its week’s row and feed, its week’s rulings');
  assert.deepEqual({...boot.lane,row:boot.lane.row.sort(),feed:boot.lane.feed.sort()},{row:[1,2],feed:[1,2],rulings:1},'the history: Weeks 1 and 2 once each, and the season-wide rulings once');
  assert.equal(boot.contestReads,4,'two contest and two policy reads: one pair with the page’s rulings, one with the history’s');
  assert.equal(boot.page.token,2,'one anonymous token for the page and one for the history');
  for(let i=1;i<=2;i++){const from=v.calls.length;await v.refresh();assert.deepEqual(lane(v,from),QUIET,`refresh ${i}: the history reads nothing`);assert.deepEqual(pageReads(v,from),{index:1,row:[],feed:[3],rulings:1},`refresh ${i}: the page’s own refresh`)}
  let from=v.calls.length;await v.refresh();
  assert.deepEqual(lane(v,from),{row:[],feed:[],rulings:1},'a minute after the last one, the season’s rules and rulings are read again, and nothing else');
  from=v.calls.length;await v.refresh();
  assert.deepEqual(lane(v,from),QUIET);
  assert.deepEqual(v.chips(),SEASON,'and the season record never moved');
  assert.deepEqual(v.intervals.map(t=>t.ms),[20000],'the season record adds no timer of its own: only the page’s 20 s refresh exists');
  assert.deepEqual(v.storage,[],'and nothing is read from or written to browser storage');
});

await check('quiet: with one published week the history reads nothing at all; a hidden page or Survivor on screen reads nothing',async()=>{
  const one=await page({published:[row(W1())],feeds:{1:F1()},week:1});
  assert.deepEqual(lane(one,0,1),QUIET,'nothing to read: the season is the week on screen');
  assert.deepEqual(one.chips(),[['D.C.','2–0','100.0%'],['JC','1–1','50.0%'],['DJS','1–1','50.0%'],['Thaddeus','0–2','0.0%']]);
  assert.equal(one.meta(),'2026 season · Week 1 · 2 graded games');
  const v=await page(BASE());
  v.setVisibility('hidden');let from=v.calls.length;clock.jump(2*RULINGS_EVERY_MS);for(const t of v.intervals)t.fn();await flush();
  assert.deepEqual(v.calls.slice(from),[],'hidden: no request from the page or the history');
  await v.click('survivor');from=v.calls.length;await v.refresh(2*RULINGS_EVERY_MS);
  assert.deepEqual(v.calls.slice(from),[],'Survivor has the page: Pick’em and its season history are paused');
});

await check('real time: a game going final in the week on screen moves the season record in the same refresh, with no read of the history',async()=>{
  const v=await page(BASE());
  v.net.feeds[3]=F3(1);const from=v.calls.length;await v.refresh();
  assert.deepEqual(lane(v,from),QUIET);
  // LAR wins: D.C., JC and Thaddeus picked LAR, DJS ARI.
  assert.deepEqual(v.chips(),[['D.C.','5–1','83.3%'],['JC','2–4','33.3%'],['DJS','2–4','33.3%'],['Thaddeus','2–4','33.3%']]);
  assert.deepEqual(v.cardRows().map(r=>r.slice(1,3)),[['2–0','100.0%'],['1–1','50.0%'],['1–1','50.0%'],['2–0','100.0%']]);
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 6 graded games');
  assert.equal(v.notes()[1],'1 live or upcoming game not graded yet.','the scheduled game stays ungraded');
});

await check('real time with another week on screen: the live week’s feed is read with each page refresh until every game is resolved, the season record follows, then the week is never read again',async()=>{
  const v=await page(BASE());
  let from=v.calls.length;await v.choose(2026,1);
  assert.deepEqual(lane(v,from,1),QUIET,'choosing a week reads nothing for the history: Week 3 is handed over as the page just graded it');
  assert.deepEqual(v.chips(),SEASON,'Week 1 on screen: the season record holds, Week 3 kept as the page last graded it');
  from=v.calls.length;await v.refresh();
  assert.deepEqual(lane(v,from,1),{row:[],feed:[3],rulings:0},'the unresolved Week 3 is read with the page’s refresh; its row is not (it was handed over)');
  v.net.feeds[3]=F3(1);from=v.calls.length;await v.refresh();
  assert.deepEqual(lane(v,from,1).feed,[3]);
  assert.deepEqual(v.chips(),[['D.C.','5–1','83.3%'],['JC','2–4','33.3%'],['DJS','2–4','33.3%'],['Thaddeus','2–4','33.3%']],'LAR’s win counts while Week 1 is on screen');
  v.net.feeds[3]=F3(2);await v.refresh();
  // MIN wins the last game: JC and Thaddeus picked MIN.
  const all=[['D.C.','5–2','71.4%'],['JC','3–4','42.9%'],['DJS','2–5','28.6%'],['Thaddeus','3–4','42.9%']];
  assert.deepEqual(v.chips(),all);
  for(let i=0;i<3;i++){from=v.calls.length;await v.refresh();assert.deepEqual(lane(v,from,1).feed,[],'a settled week is never read again')}
  assert.deepEqual(v.cardRows().map(r=>r.slice(1)),[['2–0','100.0%','5–2','71.4%'],['1–1','50.0%','3–4','42.9%'],['1–1','50.0%','2–5','28.6%'],['0–2','0.0%','3–4','42.9%']],'Standings: Week 1 beside the season');
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 7 graded games');
});

await check('week switches: choosing any week leaves the season record where it is, counts every week once, and a week still loading on screen keeps the grade the history verified',async()=>{
  const v=await page(BASE());
  // Week 1's own scores are held back while it loads on screen: the season record keeps counting Week 1 from the history.
  let release=null;v.net.hooks.feed=(u,init,call)=>call.week===1&&!release?new Promise(r=>{release=()=>r(ok(F1()))}):undefined;
  await v.choose(2026,1);
  assert.equal(typeof release,'function','Week 1’s scores are still loading on screen');
  assert.deepEqual(v.chips(),SEASON,'no blank and no double count while the chosen week loads');
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 5 graded games');
  release();await flush();
  for(const week of [2,3,1,3]){await v.choose(2026,week);assert.deepEqual(v.chips(),SEASON,`after choosing Week ${week}`);assert.equal(v.meta(),'2026 season · Weeks 1–3 · 5 graded games')}
  // Week 3 is back on screen: from now on the season record follows the page's own grade of it, not the copy kept while it
  // was away.
  v.net.feeds[3]=F3(1);await v.refresh();
  assert.deepEqual(v.chips(),[['D.C.','5–1','83.3%'],['JC','2–4','33.3%'],['DJS','2–4','33.3%'],['Thaddeus','2–4','33.3%']]);
});

await check('duplicate refreshes: timer ticks, a resume, REFRESH and repeated history answers never count a week twice',async()=>{
  const v=await page(BASE());
  for(let i=0;i<3;i++)await v.refresh(5*S);
  v.setVisibility('hidden');v.setVisibility('visible');await flush();
  v.$('refresh').listeners.click[0]();await flush();
  for(let i=0;i<4;i++)await v.refresh(RULINGS_EVERY_MS);
  assert.deepEqual(v.chips(),SEASON);
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 5 graded games');
});

await check('a republished week (revision 1 → 2) is read once, replaces its earlier revision whole, and moves the season record by exactly the changed picks',async()=>{
  const v=await page(BASE());
  v.net.published[0]=row(W1({jc:'ah'}),2);
  let from=v.calls.length;await v.refresh();
  assert.deepEqual(lane(v,from),{row:[1],feed:[1],rulings:0},'the new revision’s row, then its feed, once');
  // JC now holds DEN in Week 1: 2-0 that week.
  assert.deepEqual(v.chips(),[['D.C.','4–1','80.0%'],['JC','2–3','40.0%'],['DJS','2–3','40.0%'],['Thaddeus','1–4','20.0%']]);
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 5 graded games','still five graded games: Week 1 counts once');
  for(let i=0;i<2;i++){from=v.calls.length;await v.refresh();assert.deepEqual(lane(v,from).row,[],'the revision is never read again')}
});

await check('a republished week that cannot be read or validated is never totalled: the season record says so and comes back when the row loads',async()=>{
  for(const [label,answer,reason] of [
    ['HTTP 500',()=>httpError(500),'Week 1 could not be loaded (week data 500)'],
    ['a config that fails validation',()=>{const bad=W1({jc:'ah'});bad.participants[1].pickNumbers=[1,1];return ok([row(bad,2)])},'Week 1 could not be loaded (JC: multiple picks for game 1)'],
    ['a row of another week',()=>ok([{...row(W1({jc:'ah'}),2),week:2}]),'Week 1 could not be loaded (asked for 2026 Week 1, got 2026 Week 2)'],
    ['a row older than the listed revision',()=>ok([row(W1(),1)]),'Week 1 could not be loaded (got revision 1, older than the published revision 2)'],
    ['a draft',()=>ok([row(W1({jc:'ah'}),2,{status:'draft'})]),'Week 1 could not be loaded (2026 Week 1 is not locked)'],
    ['a row that holds another week’s config',()=>{const c=W1({jc:'ah'});c.week=2;return ok([row(c,2,{week:1})])},'Week 1 could not be loaded (2026 Week 1 holds the config of 2026 Week 2)']
  ]){
    const v=await page(BASE());
    v.net.published[0]=row(W1({jc:'ah'}),2);v.net.hooks.row=(u,init,call)=>call.week===1?answer():undefined;
    await v.refresh();
    assert.deepEqual(v.chips().map(c=>c.slice(1)),[['—','—'],['—','—'],['—','—'],['—','—']],`${label}: no total`);
    assert.deepEqual(v.homeNotes(),[`Season record incomplete: ${reason}. It returns once every published week is verified.`],label);
    assert.equal(v.meta(),'2026 season · Weeks 1–3 · incomplete',label);
    delete v.net.hooks.row;await v.refresh();
    assert.deepEqual(v.chips(),[['D.C.','4–1','80.0%'],['JC','2–3','40.0%'],['DJS','2–3','40.0%'],['Thaddeus','1–4','20.0%']],`${label}: recovered with the next refresh`);
  }
});

await check('a VOID ruling removes its game from every season record: no win, no loss, not remaining; without it the halted game simply stays ungraded',async()=>{
  const canceled=()=>({events:[ev(1,0,'DEN','KC',{awayScore:24,homeScore:17}),ev(1,1,'BUF','CIN',{kind:'canceled'})]});
  // Week 1 without BUF-CIN: D.C. 1-0 · JC 0-1 · DJS 1-0 · Thaddeus 0-1.
  const voided=[['D.C.','3–1','75.0%'],['JC','0–4','0.0%'],['DJS','2–2','50.0%'],['Thaddeus','1–3','25.0%']];
  const store=contestRows();store.nfl_incident_rulings=[ruling()];
  const v=await page({...BASE(),feeds:{...BASE().feeds,1:canceled()},store});
  assert.deepEqual(v.chips(),voided);
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 4 graded games');
  assert(v.notes().includes('2 live or upcoming games not graded yet · 1 game void by commissioner ruling, not counted.'),v.notes().join(' | '));
  await v.choose(2026,1);
  assert.deepEqual(v.standing(),[['D.C.','1','0'],['DJS','1','0'],['JC','0','1'],['Thaddeus','0','1']],'the page grades Week 1 the same way');
  assert.equal(v.$('finals').textContent,'1/2 · 1 void');
  assert.deepEqual(v.chips(),voided,'and the season record is unchanged with Week 1 on screen');
  const halted=await page({...BASE(),feeds:{...BASE().feeds,1:canceled()}});
  assert.deepEqual(halted.chips(),voided,'no ruling: the halted game is not graded, and the season record is still shown');
  assert(halted.notes().includes('3 live or upcoming games not graded yet.'),'the halted game is counted among the games not graded yet');
  const from=halted.calls.length;await halted.refresh();
  assert.deepEqual(lane(halted,from).feed,[1],'a week with a halted game is unresolved, so its feed is read again with the refresh');
});

await check('HOLD: a game whose ruling is unusable is not graded and the record says so; ruling data that cannot be loaded at all holds the season record instead of a misleading total',async()=>{
  // A Week 1 ruling for BUF at NYJ does not match the published BUF at CIN: that slot holds.
  const store=contestRows();store.nfl_incident_rulings=[ruling({away_team:'BUF',home_team:'NYJ'})];
  const v=await page({...BASE(),store});
  assert.deepEqual(v.chips(),[['D.C.','3–1','75.0%'],['JC','0–4','0.0%'],['DJS','2–2','50.0%'],['Thaddeus','1–3','25.0%']]);
  assert(v.notes().includes('2 live or upcoming games not graded yet · 1 game on hold, not graded.'),v.notes().join(' | '));
  const down=await page({...BASE(),bootHooks:{rulings:(u,init,call)=>call.scope==='season'?httpError(503):undefined}});
  assert.deepEqual(down.chips().map(c=>c.slice(1)),[['—','—'],['—','—'],['—','—'],['—','—']],'no rulings verified for Weeks 1 and 2: no total');
  assert.deepEqual(down.homeNotes(),['Season record incomplete: Week 1 is on hold: its rules and rulings could not be loaded or verified (and 1 more week). It returns once every published week is verified.']);
  delete down.net.hooks.rulings;await down.refresh();
  assert.deepEqual(down.chips(),SEASON,'the next refresh reads them again and the season record returns');
});

await check('a ruling added for an earlier week, then withdrawn, moves the season record within a minute, each time counted once',async()=>{
  const v=await page(BASE());
  // Week 2's NYG-WAS (an NFL tie, a loss for every pick) is voided: no entry takes that loss any more.
  v.net.store.nfl_incident_rulings=[ruling({week:2,away_team:'NYG',home_team:'WAS',event_id:eventId(2,0)})];
  await v.refresh();
  assert.deepEqual(v.chips(),SEASON,'before the next season read the earlier rulings still apply');
  await v.refresh(RULINGS_EVERY_MS);
  const voided=[['D.C.','4–0','100.0%'],['JC','1–3','25.0%'],['DJS','2–2','50.0%'],['Thaddeus','1–3','25.0%']];
  assert.deepEqual(v.chips(),voided);
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 4 graded games');
  v.net.store.nfl_incident_rulings=[...v.net.store.nfl_incident_rulings,ruling({ruling_id:2,week:2,away_team:'NYG',home_team:'WAS',event_id:null,chain_seq:2,parent_ruling_id:1,consequence:'withdrawn',public_note:null,created_at:'2026-10-10T12:00:00+00:00'})];
  await v.refresh(RULINGS_EVERY_MS);
  assert.deepEqual(v.chips(),SEASON,'withdrawn: the NFL tie counts as a loss again');
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 5 graded games');
});

await check('rulings kept when a later season read fails: still applied, and the season record says it is as last verified',async()=>{
  const store=contestRows();store.nfl_incident_rulings=[ruling({week:2,away_team:'NYG',home_team:'WAS',event_id:eventId(2,0)})];
  const v=await page({...BASE(),store});
  v.net.hooks.rulings=(u,init,call)=>call.scope==='season'?httpError(503):undefined;
  await v.refresh(RULINGS_EVERY_MS);
  assert.deepEqual(v.chips(),[['D.C.','4–0','100.0%'],['JC','1–3','25.0%'],['DJS','2–2','50.0%'],['Thaddeus','1–3','25.0%']],'the verified void still applies');
  assert.deepEqual(v.homeNotes(),['Season record as last verified · Week 1 rulings could not be refreshed · Week 2 rulings could not be refreshed.']);
  delete v.net.hooks.rulings;await v.refresh();
  assert.deepEqual(v.homeNotes(),[],'the next read clears it');
});

await check('a week republished while the latest rules and rulings read has failed is graded with the rulings last verified this session, and says so',async()=>{
  const v=await page(BASE());
  v.net.hooks.rulings=(u,init,call)=>call.scope==='season'?httpError(503):undefined;
  await v.refresh(RULINGS_EVERY_MS);
  v.net.published[0]=row(W1({jc:'ah'}),2);
  let from=v.calls.length;await v.refresh(10*S);
  assert.deepEqual(lane(v,from),{row:[1],feed:[1],rulings:0},'the new revision is read; the failed rulings read is not retried within 15 s');
  assert.deepEqual(v.chips(),[['D.C.','4–1','80.0%'],['JC','2–3','40.0%'],['DJS','2–3','40.0%'],['Thaddeus','1–4','20.0%']],'revision 2 counts, graded with the rulings verified earlier');
  assert.deepEqual(v.homeNotes(),['Season record as last verified · Week 1 rulings could not be refreshed · Week 2 rulings could not be refreshed.']);
  delete v.net.hooks.rulings;from=v.calls.length;await v.refresh();
  assert.deepEqual(lane(v,from).rulings,1);
  assert.deepEqual(v.homeNotes(),[]);
});

await check('feed failures: a week whose scores never loaded is never totalled; a refresh that fails after a verified one keeps the last verified record and says so',async()=>{
  const v=await page({...BASE(),bootHooks:{feed:(u,init,call)=>call.week===1?httpError(503):undefined}});
  assert.deepEqual(v.homeNotes(),['Season record incomplete: Week 1 scores could not be loaded. It returns once every published week is verified.']);
  assert.deepEqual(v.cardRows().map(r=>r.slice(3)),[['—','—'],['—','—'],['—','—'],['—','—']],'Standings: no season total either');
  assert.deepEqual(v.cardRows().map(r=>r.slice(1,3)),[['1–0','100.0%'],['0–1','0.0%'],['1–0','100.0%'],['1–0','100.0%']],'the selected week stays shown');
  delete v.net.hooks.feed;await v.refresh();
  assert.deepEqual(v.chips(),SEASON,'retried with the next refresh');
  await v.choose(2026,1);
  v.net.hooks.feed=(u,init,call)=>call.week===3?httpError(503):undefined;await v.refresh();
  assert.deepEqual(v.chips(),SEASON,'the live Week 3 as last verified');
  assert.deepEqual(v.homeNotes(),['Season record as last verified · Week 3 scores could not be refreshed.']);
  assert.equal(v.meta(),'2026 season · Weeks 1–3 · 5 graded games');
  delete v.net.hooks.feed;await v.refresh();
  assert.deepEqual(v.homeNotes(),[]);
});

await check('incomplete history: a week that is not published, or that has a game the feed cannot verify, is named instead of a total',async()=>{
  const gap=await page({published:[row(W1()),row(W3())],feeds:{1:F1(),3:F3()}});
  assert.deepEqual(gap.homeNotes(),['Season record incomplete: Week 2 is not published. It returns once every published week is verified.']);
  assert.equal(gap.meta(),'2026 season · Weeks 1–3 · incomplete');
  const missing=await page({...BASE(),feeds:{...BASE().feeds,1:{events:[F1().events[0]]}}});
  assert.deepEqual(missing.homeNotes(),['Season record incomplete: Week 1 has 1 game the score feed could not verify. It returns once every published week is verified.']);
  assert.deepEqual(missing.chips().map(c=>c[1]),['—','—','—','—']);
});

await check('time limits: a history read that never answers is abandoned after 15 s and reported, never doubled while it waits, and never holds up the page’s refresh',async()=>{
  const v=await page({...BASE(),bootHooks:{row:(u,init,call)=>call.week===1?hang(init):undefined}});
  assert.equal(v.homeNotes()[0],'Loading the season record…','Week 1 is still loading');
  let from=v.calls.length;await v.refresh();
  assert.deepEqual(lane(v,from).row,[],'the read still waiting is not started a second time');
  assert.match(v.$('sync').textContent,/^LIVE · /,'the page’s own refresh completed');
  await clock.advance(READ_TIMEOUT_MS);
  assert.deepEqual(v.homeNotes(),['Season record incomplete: Week 1 could not be loaded (timed out). It returns once every published week is verified.']);
  delete v.net.hooks.row;from=v.calls.length;await v.refresh();
  assert.deepEqual(lane(v,from).row,[1],'tried again with the next refresh');
  assert.deepEqual(v.chips(),SEASON);
});

await check('time limits: a history token request that never answers is abandoned after 15 s like any read, and the next refresh asks for a new one',async()=>{
  let tokens=0;
  const v=await page({...BASE(),bootHooks:{token:(u,init)=>++tokens===2?hang(init):undefined}});
  assert.equal(tokens,2,'the page’s token, then the history’s');
  assert.equal(v.homeNotes()[0],'Loading the season record…');
  await clock.advance(READ_TIMEOUT_MS);
  assert.deepEqual(v.homeNotes(),['Season record incomplete: Week 1 could not be loaded (timed out) (and 1 more week). It returns once every published week is verified.']);
  await v.refresh();
  assert.equal(tokens,3,'a new token');
  assert.deepEqual(v.chips(),SEASON);
});

await check('identity: entries are matched by published id across weeks; a renamed entry still counts, and an entry missing, repeated or without an id in some week is never totalled',async()=>{
  const renamed=await page({...BASE(),published:[row(weekCfg(1,G1,four({dc:'ah',jc:'hh',djs:'aa',thaddeus:'ha'},{dc:'DC'}))),row(W2()),row(W3())]});
  assert.deepEqual(renamed.chips(),SEASON,'named DC in Week 1, D.C. now: one entry, shown by its current name');
  for(const [label,week1,reason] of [
    ['not tracked',weekCfg(1,G1,four({dc:'ah',jc:'hh',djs:'aa',thaddeus:'ha'}).slice(0,3)),'Thaddeus is not tracked in Week 1'],
    ['listed twice',weekCfg(1,G1,[...four({dc:'ah',jc:'hh',djs:'aa',thaddeus:'ha'}),entry('dc','D.C. (2)','hh')]),'D.C. is listed more than once in Week 1'],
    ['published without an id',weekCfg(1,G1,four({dc:'ah',jc:'hh',djs:'aa',thaddeus:'ha'}).map(e=>e.id==='jc'?{...e,id:undefined}:e)),'JC is not tracked in Week 1']
  ]){
    const v=await page({...BASE(),published:[row(week1),row(W2()),row(W3())]});
    const name=reason.split(' is ')[0];
    for(const [n,record,pct] of v.chips())if(n===name)assert.deepEqual([record,pct],['—','—'],`${label}: ${name} has no season total`);else assert.deepEqual([n,record,pct],SEASON.find(s=>s[0]===n),`${label}: ${n} still counts`);
    assert(v.homeNotes().includes(`${reason}.`),`${label}: ${v.homeNotes().join(' | ')}`);
  }
  const unnamed=await page({...BASE(),published:[row(W1()),row(W2()),row(weekCfg(3,G3,four({dc:'aaa',jc:'hah',djs:'aha',thaddeus:'aah'}).map(e=>e.id==='jc'?{...e,id:undefined}:e)))]});
  assert(unnamed.homeNotes().includes('JC has no published entry id, so the weeks cannot be matched.'));
  assert.deepEqual(unnamed.chips().find(c=>c[0]==='JC'),['JC','—','—']);
});

await check('a season before contest-scoped rulings (2025) reads no rules and rulings at all, page or history, and is totalled from the NFL results',async()=>{
  const cfg=(week,games,picks)=>weekCfg(week,games,four(picks),{season:2025}),f=(week,list)=>({events:list.map(([a,h,as,hs],i)=>ev(week,i,a,h,{awayScore:as,homeScore:hs,season:2025}))});
  const v=await page({season:2025,week:2,published:[row(cfg(1,G1,{dc:'ah',jc:'hh',djs:'aa',thaddeus:'ha'})),row(cfg(2,G2,{dc:'ha',jc:'ah',djs:'hh',thaddeus:'aa'}))],
    feeds:{1:f(1,[['DEN','KC',24,17],['BUF','CIN',20,27]]),2:f(2,[['NYG','WAS',27,27],['DAL','PHI',31,20]])}});
  assert.equal(v.calls.filter(c=>c.kind==='rulings').length,0,'no rules and rulings read');
  // Week 2: the tie is a loss for all; DAL wins: D.C. 1-1 · JC 0-2 · DJS 0-2 · Thaddeus 1-1.
  assert.deepEqual(v.chips(),[['D.C.','3–1','75.0%'],['JC','1–3','25.0%'],['DJS','1–3','25.0%'],['Thaddeus','1–3','25.0%']]);
  assert.equal(v.meta(),'2025 season · Weeks 1–2 · 4 graded games');
});

await check('boot: until Pick’em has a week on screen the page’s own “Loading season record…” stays; a Pick’em that cannot boot leaves the season record unavailable, never zero',async()=>{
  const waiting=await page({...BASE(),bootHooks:{index:(u,init)=>hang(init)},prepare:({$})=>{$('seasonRecord').innerHTML='STATIC';$('seasonMeta').textContent='STATIC META'}});
  assert.deepEqual([waiting.$('seasonRecord').innerHTML,waiting.meta(),waiting.$('homeSeason').innerHTML],['STATIC','STATIC META',''],'nothing replaced while Pick’em boots');
  // The season module starts after Pick'em has already given up here, so this also proves the late start reads the failure.
  const failed=await page({...BASE(),bootHooks:{index:()=>httpError(503)},prepare:({$})=>{$('seasonRecord').innerHTML='STATIC'}});
  assert.equal(failed.$('seasonRecord').innerHTML,'<div class="empty">Season record unavailable: the weekly pool data could not be loaded (week data 503).</div>');
  assert.equal(failed.meta(),'Season record unavailable');
  assert.equal(failed.$('homeSeason').innerHTML,'');
});

await check('poolcenter:season: the page grades another week exactly as it grades that week on screen, accepts its row by exactly the page’s own checks, and answers nothing while a week loads',async()=>{
  const v=await page(BASE()),store=contestRows();
  const rulingsData={contests:store.nfl_contests,policies:store.nfl_contest_policies,rulings:[]};
  for(const [week,cfg,feed] of [[1,W1(),F1()],[2,W2(),F2()],[3,W3(),F3()]]){
    const prepared=v.ask('prepare',{entry:{season:2026,week,revision:1},data:[row(cfg)]});
    assert.equal(prepared?.ok,true,`Week ${week} is accepted`);
    assert.deepEqual(prepared.week.tracked.map(t=>[t.id,t.identified,t.name]),PEOPLE.map(([id,name])=>[id,true,name]));
    const graded=v.ask('grade',{week:prepared.week,events:feed.events,parse:true,rulings:{data:weekRulings(rulingsData,week)}});
    await v.choose(2026,week);
    const onScreen=v.ask('state');
    assert.equal(onScreen.week,week);
    assert.deepEqual(graded.graded,onScreen.current.graded,`Week ${week}: the same grade as on screen`);
    assert.deepEqual(graded.graded.records.map(r=>[r.name,String(r.w),String(r.l)]).sort(),v.standing().sort(),`Week ${week}: the same records as Your Group`);
  }
  for(const [label,data,error] of [
    ['no row',[],'2026 Week 1 is not published'],['two rows',[row(W1()),row(W1())],'2026 Week 1 came back more than once'],['not a list',{},'week data is not a list'],
    ['not locked',[row(W1(),1,{status:'draft'})],'2026 Week 1 is not locked'],['an older revision',[row(W1(),1)],'got revision 1, older than the published revision 2'],
    ['an invalid config',[row({...W1(),games:[]},2)],'Invalid game list']
  ])assert.deepEqual(v.ask('prepare',{entry:{season:2026,week:1,revision:label==='an older revision'||label==='an invalid config'?2:1},data}),{ok:false,error},label);
  let release=null;v.net.hooks.row=(u,init,call)=>call.week===2?new Promise(r=>{release=()=>r(ok([row(W2())]))}):undefined;
  const select=v.$('weekSelect');select.value='2026-2';for(const fn of select.listeners.change)fn();await flush();
  assert.deepEqual(v.ask('state'),{ready:false,switching:true,reason:'another week is loading'});
  release();await flush();
  assert.equal(v.ask('state').week,2);
});

await check('the season record never enters the page’s own weekly elements: Your Group and the Live Standings rows render exactly as before',async()=>{
  const v=await page(BASE());
  for(const id of ['standings','homeStandings'])assert.doesNotMatch(v.$(id).innerHTML,/season|Season|80\.0%|4–1/,`#${id} carries no season output`);
});

}finally{clock.restore();console.warn=warn;console.error=error}

assert.equal(failures.length,0,`season record regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
console.log('season record: winning percentage, week ranges, week-scoped rulings, season totals from every published week as the page grades it, Home and Standings consistency, week switches, duplicate refreshes, revisions, rulings (void, hold, withdrawal, stale), feed failures, incomplete history, time limits, identity, pre-2026 seasons, boot and read pacing regressions passed');
