import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCORE_GATEWAY_INSTALLED,SCORE_GATEWAY_NOT_INSTALLED,SCORE_GATEWAY_PATH,createGameDayBoard} from '../game-day-board.js';

const APP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(APP,name),'utf8');

// A score card with just enough of a document for the board: what it writes, and the handlers it installs.
function card(t){
  const page={tick:null,click:null,visible:null,timers:0,hiddenCard:null};
  const previous=globalThis.document;
  globalThis.document={visibilityState:'visible',addEventListener:(_,fn)=>{page.visible=fn}};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous});
  t.mock.method(globalThis,'setInterval',fn=>{page.tick=fn;page.timers++;return 1});
  t.mock.method(globalThis,'clearInterval',()=>{});
  const classes=()=>{const set=new Set();return{add:name=>set.add(name),remove:name=>set.delete(name),contains:name=>set.has(name)}};
  page.status={};
  page.rows=0;
  page.button={disabled:false,classList:classes(),addEventListener:(_,fn)=>{page.click=fn}};
  const list={replaceChildren(){page.rows=0}};
  const nodes={'[data-score-status]':page.status,'[data-score-list]':list,'[data-score-refresh]':page.button};
  page.root={querySelector:key=>nodes[key],classList:classes()};
  return page;
}
const WEEK={poolId:'synthetic',season:2027,week:1,config:{games:[{id:'g1'}]}};

test('this release installs no score gateway: the card says so, offers no refresh and never asks for it',async t=>{
  const page=card(t),updates=[];
  let requests=0;
  // No gatewayInstalled option: the pages do not pass one, so this is exactly what they get.
  const board=createGameDayBoard(page.root,{fetchImpl:async()=>{requests++;return {ok:false,status:404}},onUpdate:value=>updates.push(value)});
  t.after(()=>board.hide());
  assert.equal(SCORE_GATEWAY_INSTALLED,false);
  assert.equal(page.button.disabled,true,'the refresh control is off before any week is shown');
  assert.equal(page.button.classList.contains('hidden'),true,'and it is not shown');

  board.show(WEEK);
  assert.equal(page.root.classList.contains('hidden'),false,'the card is shown');
  assert.equal(page.status.textContent,SCORE_GATEWAY_NOT_INSTALLED);
  assert.match(page.status.textContent,/not installed/);
  assert.match(page.status.textContent,/Picks, pool management and recorded final scores work without them/);
  // The standings card is told what an unreachable gateway told it before: no score facts for this week.
  assert.deepEqual(updates,[null,{poolId:'synthetic',season:2027,week:1,data:null,stale:true}]);

  // Nothing that used to lead to a request does now: no timer, a tab shown again, a tap, a call, another week.
  assert.equal(page.timers,0,'no polling timer is started');
  page.visible();
  page.click();
  await board.refresh();
  board.show({...WEEK,week:2});
  board.show({...WEEK,week:3});
  board.show(WEEK);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests,0,'the gateway was never requested');
  assert.equal(page.timers,0);
  assert.equal(page.button.disabled,true);
  assert.equal(page.button.classList.contains('hidden'),true);
  assert.deepEqual(updates.at(-1),{poolId:'synthetic',season:2027,week:1,data:null,stale:true});
  assert.equal(updates.filter(Boolean).length,4,'one report per week shown');

  board.hide();
  assert.equal(page.root.classList.contains('hidden'),true);
  assert.equal(updates.at(-1),null);
  assert.equal(page.button.disabled,true,'hiding the card does not bring the refresh control back');
  assert.equal(requests,0);
});

test('an installed score gateway that is absent stops automatic polling but preserves a manual retry',async t=>{
  const page=card(t);
  let requests=0,ready;
  const first=new Promise(resolve=>{ready=resolve});
  const board=createGameDayBoard(page.root,{gatewayInstalled:true,fetchImpl:async()=>{requests++;return {ok:false,status:404}},
    onUpdate:value=>{if(value?.stale)ready()}});
  t.after(()=>board.hide());
  assert.equal(page.button.disabled,false);
  assert.equal(page.button.classList.contains('hidden'),false);
  board.show(WEEK);
  await first;
  assert.match(page.status.textContent,/not enabled/);
  page.tick();page.visible();
  assert.equal(requests,1);
  page.click();
  assert.equal(requests,2);
});

// The declaration is a statement about what this tree deploys, so it is checked against the tree. A release that
// adds a function, a rewrite or a local route for the gateway must set SCORE_GATEWAY_INSTALLED to true in the same
// change, and one that removes it must set it back.
test('the declaration matches what this release deploys',()=>{
  assert.equal(SCORE_GATEWAY_PATH,'/api/nfl-scores');
  const serving=[];
  for(const dir of ['netlify/functions','api','server']){
    for(const name of fs.readdirSync(path.join(APP,dir)))if(read(`${dir}/${name}`).includes('nfl-scores'))serving.push(`${dir}/${name}`);
  }
  for(const name of ['netlify.toml','vercel.json','scripts/serve.mjs'])if(read(name).includes('nfl-scores'))serving.push(name);
  assert.equal(serving.length>0,SCORE_GATEWAY_INSTALLED,
    SCORE_GATEWAY_INSTALLED?'the gateway is declared installed but nothing in this tree serves it'
      :`the gateway is declared not installed but these serve it: ${serving.join(', ')}`);
  if(!SCORE_GATEWAY_INSTALLED)assert.match(read('ops/release/README.md'),/live-score gateway disabled for this release/);
});

test('both pages take the declaration as it is, and the path is written in one place',()=>{
  for(const role of ['participant','commissioner']){
    const source=read(`${role}.js`);
    assert.match(source,/createGameDayBoard\(\$\('scoreboardCard'\),\{onUpdate:event=>standingsBoard\.setScores\(event\)\}\)/,role);
    assert.doesNotMatch(source,/gatewayInstalled|SCORE_GATEWAY|nfl-scores/,`${role}.js does not override or restate it`);
  }
  const board=read('game-day-board.js');
  assert.equal(board.split('/api/nfl-scores').length-1,1,'the path is a constant, written once');
  assert.match(board,/if\(!installed\|\|!active\|\|controller\|\|document\.visibilityState==='hidden'\)return;/,'refresh() does nothing without a gateway');
  // No other service is named: this is not a switch to another project's score feed.
  assert.doesNotMatch(board,/https?:\/\//);
});
