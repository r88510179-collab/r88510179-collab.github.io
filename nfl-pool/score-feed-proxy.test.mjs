// The page shim (score-feed-proxy.js) sends every ESPN scoreboard request from Pick'em, Survivor and Admin to the Neon
// score proxy. It runs here unmodified in a vm with a fake window; no request leaves the process.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./score-feed-proxy.js',import.meta.url),'utf8');
const PROXY=source.match(/const PROXY='([^']+)';/)?.[1];
assert(PROXY,'the shim declares its PROXY base URL');
assert.equal(new URL(PROXY).href,PROXY,'PROXY is an absolute URL');
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
