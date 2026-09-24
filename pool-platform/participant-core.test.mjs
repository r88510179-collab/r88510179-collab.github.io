import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeGames,pickemPayloadFromSelections,survivorBurnedTeams,survivorLegalTeams,validateSurvivorSelection,entrySubmissionAccess} from './participant-core.js';

const config={games:[
  {id:'g1',away:{key:'a',label:'Austin'},home:{key:'d',label:'Denver'}},
  {id:'g2',away:{key:'p',label:'Phoenix'},home:{key:'s',label:'Seattle'}}
]};

test('game normalization and Pickem payload are stable',()=>{
  assert.equal(normalizeGames(config).length,2);
  assert.deepEqual(pickemPayloadFromSelections({g1:'away',g2:'home'},47),{
    picks:{g1:'away',g2:'home'},tiebreak:47
  });
});

test('Survivor burned teams are excluded from legal choices',()=>{
  const history=[{payload:{team:'a'}},{payload:{team:'s'}}];
  assert.deepEqual([...survivorBurnedTeams(history)],['a','s']);
  const legal=survivorLegalTeams(config,history);
  assert.equal(legal.find(x=>x.key==='a').burned,true);
  assert.equal(legal.find(x=>x.key==='d').burned,false);
  assert.equal(validateSurvivorSelection('a',config,history).code,'team_already_used');
  assert.equal(validateSurvivorSelection('d',config,history).ok,true);
});

test('commissioner-owned submission blocks participant editing',()=>{
  const entry={submission:{source:'commissioner_import',status:'submitted'}};
  assert.deepEqual(entrySubmissionAccess(entry,'open','2027-09-10T12:00:00Z','2027-09-10T23:00:00Z'),{
    editable:false,reason:'commissioner_claimed',source:'commissioner_import'
  });
});

test('participant may update own submission only before deadline',()=>{
  const entry={submission:{source:'participant',status:'submitted'}};
  assert.equal(entrySubmissionAccess(entry,'open','2027-09-10T12:00:00Z','2027-09-10T23:00:00Z').editable,true);
  assert.equal(entrySubmissionAccess(entry,'open','2027-09-10T23:00:00Z','2027-09-10T23:00:00Z').editable,false);
});
