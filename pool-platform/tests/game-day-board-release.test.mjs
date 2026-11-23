import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameDayBoard} from '../game-day-board.js';

test('an absent score gateway stops automatic polling but preserves a manual retry',async t=>{
  let tick,refresh,vis;
  const previous=globalThis.document;
  globalThis.document={visibilityState:'visible',addEventListener:(_,fn)=>{vis=fn}};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous});
  t.mock.method(globalThis,'setInterval',fn=>{tick=fn;return 1});
  t.mock.method(globalThis,'clearInterval',()=>{});
  const status={},list={replaceChildren(){}},button={addEventListener:(_,fn)=>{refresh=fn}};
  const nodes={'[data-score-status]':status,'[data-score-list]':list,'[data-score-refresh]':button};
  const root={querySelector:key=>nodes[key],classList:{add(){},remove(){}}};
  let requests=0,ready;
  const first=new Promise(resolve=>{ready=resolve});
  const board=createGameDayBoard(root,{fetchImpl:async()=>{requests++;return {ok:false,status:404}},
    onUpdate:value=>{if(value?.stale)ready()}});
  t.after(()=>board.hide());
  board.show({poolId:'synthetic',season:2027,week:1,config:{games:[{id:'g1'}]}});
  await first;
  assert.match(status.textContent,/not enabled/);
  tick();vis();
  assert.equal(requests,1);
  refresh();
  assert.equal(requests,2);
});
