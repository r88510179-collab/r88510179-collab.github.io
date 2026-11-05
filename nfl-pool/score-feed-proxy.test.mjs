// The page shim (score-feed-proxy.js) sends every ESPN scoreboard request from Pick'em, Survivor and Admin to the Neon
// score proxy. It runs here unmodified in a vm with a fake window; no request leaves the process.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./score-feed-proxy.js',import.meta.url),'utf8');
const PROXY=source.match(/const PROXY='([^']+)';/)?.[1];
assert(PROXY,'the shim declares its PROXY base URL');
assert.equal(new URL(PROXY).href,PROXY,'PROXY is an absolute URL');
// The Neon Function nflscores2 (deployment 1, 2026-09-26T23:02:50.545776Z), exactly its invocation_url. nflscores stays
// deployed, unchanged, as the rollback target.
assert.equal(PROXY,'https://br-late-hat-b55ygmj4-nflscores2.compute.c-7.us-east-2.aws.neon.tech/','PROXY is the nflscores2 invocation_url');
const SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',NOW=1790000000000;

function load(){
  const calls=[],window={location:{href:'https://r88510179-collab.github.io/nfl-pool/?view=survivor'},
    fetch(input,init){calls.push({self:this,input,init});return Promise.resolve({ok:true})}};
  vm.runInNewContext(source,{window,URL,Request,Date:{now:()=>NOW}});
  return{window,calls,fetch:(input,init)=>{window.fetch(input,init);return calls.at(-1)}};
}

// Exactly the ESPN scoreboard origin and path is rewritten to PROXY with season, week and a fresh _; seasontype, limit and
// the caller's own _ are dropped, and the caller's init (cache mode, signal, headers) is passed through untouched.
{
  const {window,fetch}=load(),init={cache:'no-store',signal:new AbortController().signal,headers:{Accept:'application/json'}};
  for(const [label,input] of [
    ['Survivor',`${SCOREBOARD}?dates=2026&week=3&seasontype=2`],
    ["Pick'em and Admin",`${SCOREBOARD}?dates=2026&seasontype=2&week=3&limit=100&_=123`],
    ['URL object',new URL(`${SCOREBOARD}?dates=2026&week=3&seasontype=3`)]
  ]){
    const call=fetch(input,init);
    assert.equal(call.input,`${PROXY}?season=2026&week=3&_=${NOW}`,`${label}: rewritten to the proxy`);
    assert.equal(call.init,init,`${label}: init passed through`);
    assert.equal(call.self,window,`${label}: native fetch keeps its window binding`);
  }
  assert.equal(fetch(`${SCOREBOARD}?dates=2026`).input,`${PROXY}?season=2026&_=${NOW}`,'a missing week is not invented');
  assert.equal(fetch(`${SCOREBOARD}?week=3`).input,`${PROXY}?week=3&_=${NOW}`,'a missing season is not invented');
  assert.equal(fetch(SCOREBOARD).input,`${PROXY}?_=${NOW}`);
  assert.equal(fetch(`${SCOREBOARD}?dates=2026&week=3`).init,undefined);
}

// Every other URL, and any Request object, passes through exactly as given.
{
  const {fetch}=load(),init={cache:'no-store'};
  for(const input of [
    `${SCOREBOARD}/`,
    'http://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&week=3',
    'https://example.test/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&week=3',
    'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=2026&week=3',
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams',
    'https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1/nfl_survivor_weeks?select=season,week',
    PROXY,
    './manifest.webmanifest',
    'http://[',
    new URL('https://a.espncdn.com/i/teamlogos/nfl/500/kc.png'),
    new Request(`${SCOREBOARD}?dates=2026&week=3`)
  ]){
    const call=fetch(input,init);
    assert.equal(call.input,input,`${String(input.url||input)} passes through unchanged`);
    assert.equal(call.init,init);
  }
}

console.log('score-feed shim scoreboard rewrite and pass-through regressions passed');

// The Personal QA transport remains separate from the unchanged score shim and is absent from Admin.
const routing=readFileSync(new URL('./qa-read-routing.js',import.meta.url),'utf8');
function loadQaRouting(href='https://nfl-pool-personal-review.vercel.app/nfl-pool/'){
  const calls=[],window={location:{href},fetch(input,init){calls.push({input,init});return Promise.resolve({ok:true})}};
  vm.runInNewContext(routing,{window,URL,Request});
  return{calls,fetch:(input,init)=>{window.fetch(input,init);return calls.at(-1)}};
}
{
  const {fetch}=loadQaRouting(),init={cache:'no-store',signal:new AbortController().signal};
  const base='https://ep-silent-sunset-bbdqbm47';
  let call=fetch(base+'.neonauth.c-15.us-east-1.aws.neon.tech/nfl_pool/auth/token/anonymous',init);
  assert.equal(call.input,'https://nfl-pool-personal-review.vercel.app/api/qa-read?kind=anonymous');
  assert.equal(call.init,init);
  for(const resource of ['nfl_pool_weeks','nfl_survivor_weeks','nfl_contests','nfl_contest_policies','nfl_incident_rulings']){
    call=fetch(base+'.apirest.c-15.us-east-1.aws.neon.tech/nfl_pool/rest/v1/'+resource+'?select=season,week',init);
    const target=new URL(call.input);
    assert.equal(target.origin,'https://nfl-pool-personal-review.vercel.app');
    assert.equal(target.pathname,'/api/qa-read');
    assert.equal(target.searchParams.get('resource'),resource);
    assert.equal(target.searchParams.get('select'),'season,week');
    assert.equal(call.init,init);
  }
  const url=base+'.apirest.c-15.us-east-1.aws.neon.tech/nfl_pool/rest/v1/nfl_pool_weeks?select=season';
  assert.equal(fetch(url,{method:'POST'}).input,url,'writes are never routed');
  assert.equal(fetch(new Request(url)).input.url,'https://nfl-pool-personal-review.vercel.app/api/qa-read?select=season&resource=nfl_pool_weeks');
  const scoreCall=fetch(SCOREBOARD+'?dates=2026&week=9&seasontype=2&_=123',init);
  assert.equal(scoreCall.input,'https://nfl-pool-personal-review.vercel.app/api/qa-schedule?season=2026&week=9');
  assert.equal(scoreCall.init,init,'score refresh cancellation and cache policy are preserved');
  assert.equal(fetch(SCOREBOARD).input,'https://nfl-pool-personal-review.vercel.app/api/qa-schedule','missing context is not invented');
  for(const input of [PROXY,base+'.neonauth.c-15.us-east-1.aws.neon.tech/nfl_pool/auth/sign-in/email',
    base+'.apirest.c-15.us-east-1.aws.neon.tech/nfl_pool/rest/v1/nfl_pool_admins',
    'https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1/nfl_pool_weeks'])
    assert.equal(fetch(input).input,input,'unrelated/production URLs and auth sessions are not routed');
  assert.equal(loadQaRouting('https://picks.smokkeventures.com/nfl-pool/').fetch(url).input,url,'custom-domain production is untouched');
  for(const file of ['admin/index.html','admin/survivor.html'])
    assert(!readFileSync(new URL('./'+file,import.meta.url),'utf8').includes('qa-read-routing'),'publisher transport is unchanged');
}

const {createQaReadHandler}=await import('./api/qa-read.js');
async function gateway(query,{method='GET',environment='preview',host='nfl-pool-personal-review.vercel.app',authStatus=200,dataStatus=200,rows=[{season:2026,week:9,status:'locked'}],token='qa.anon.sig',fail=null}={}){
  const calls=[],res={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v},status(code){this.statusCode=code;return this},json(body){this.body=body;return this}};
  const handler=createQaReadHandler({environment:()=>environment,fetchImpl:async(url,init)=>{
    calls.push({url,init});if(fail)throw fail;
    return calls.length===1?{ok:authStatus===200,status:authStatus,json:async()=>({token})}:{ok:dataStatus===200,status:dataStatus,json:async()=>rows};
  }});
  await handler({method,url:'/api/qa-read?'+query,headers:{host,authorization:'Bearer caller-admin-token',cookie:'private-session'}},res);
  return{res,calls};
}
{
  const query='resource=nfl_pool_weeks&select=season,week,status,revision,published_at,config&week=eq.9';
  const t=await gateway(query);
  assert.equal(t.res.statusCode,200);
  assert.equal(t.res.headers['Cache-Control'],'no-store');
  assert.equal(t.res.headers['X-QA-Read-Only'],'1');
  assert.equal(t.calls.length,2);
  assert(t.calls.every(c=>c.init.cache==='no-store'&&c.init.signal instanceof AbortSignal));
  assert(t.calls[0].url.startsWith('https://ep-silent-sunset-bbdqbm47.neonauth.'));
  assert.deepEqual(t.calls[0].init.headers,{Accept:'application/json'});
  assert.equal(t.calls[1].init.headers.Authorization,'Bearer qa.anon.sig','caller admin credentials are never forwarded');
  assert(!Object.keys(t.calls[1].init.headers).some(k=>/cookie|origin/i.test(k)));
  const target=new URL(t.calls[1].url);
  assert.equal(target.hostname,'ep-silent-sunset-bbdqbm47.apirest.c-15.us-east-1.aws.neon.tech');
  assert.equal(target.searchParams.get('status'),'eq.locked');
  assert.equal(target.searchParams.get('season'),'eq.2026');
  assert.equal((await gateway('kind=anonymous')).calls.length,1);
  for(const options of [{environment:'production'},{environment:undefined},{host:'picks.smokkeventures.com'}]){
    // Undefined is tested directly below; the helper's default is preview.
    if(Object.hasOwn(options,'environment')&&options.environment===undefined)options.environment='';
    const denied=await gateway(query,options);assert.equal(denied.res.statusCode,404);assert.equal(denied.calls.length,0);
  }
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS','HEAD']){
    const denied=await gateway(query,{method});assert.equal(denied.res.statusCode,405);assert.equal(denied.calls.length,0);
  }
  for(const bad of [
    'resource=nfl_pool_admins&select=*','resource=__proto__&select=season','resource=nfl_pool_weeks&select=*',
    'resource=nfl_pool_weeks&select=season&select=config','resource=nfl_pool_weeks&select=season&status=eq.draft',
    'resource=nfl_pool_weeks&select=season&season=eq.2025','resource=nfl_pool_weeks&select=season&week=eq.19',
    'resource=nfl_incident_rulings&select=admin_note&contest_id=eq.pool-center-2026-pickem',
    'resource=nfl_incident_rulings&select=public_note','resource=nfl_contests&select=season&contest_id=eq.other',
    'resource=nfl_pool_weeks&select=season&url=https://production.example/',
    'resource=nfl_pool_weeks&select=season&order=season.asc,nullsfirst','kind=anonymous&url=https://other.test/'
  ]){const denied=await gateway(bad);assert.equal(denied.res.statusCode,400,bad);assert.equal(denied.calls.length,0)}
  for(const resource of ['nfl_contests','nfl_contest_policies','nfl_incident_rulings']){
    const ok=await gateway('resource='+resource+'&select=contest_id&contest_id=eq.pool-center-2026-survivor');
    assert.equal(ok.res.statusCode,200,resource);
  }
  for(const options of [{authStatus:503},{token:'invalid'},{dataStatus:403},{rows:{error:'not rows'}},{fail:new TypeError('network failure')}])
    assert.equal((await gateway(query,options)).res.statusCode,502);
  const aborted=new Error('aborted');aborted.name='AbortError';
  assert.equal((await gateway(query,{fail:aborted})).res.statusCode,504);
}
console.log('QA read gateway: preview guard, anonymous-only identity, fixed backend, public columns, published context, write rejection, timeouts and routing passed');
