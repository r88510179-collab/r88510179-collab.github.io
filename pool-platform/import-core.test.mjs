import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCsv,prepareCommissionerImport,summarizeBatchResults} from './import-core.js';

const entries=[
  {id:'11111111-1111-1111-1111-111111111111',entry_code:'E01'},
  {id:'22222222-2222-2222-2222-222222222222',entry_code:'E02'}
];

test('CSV parser supports quoted fields',()=>{
  assert.deepEqual(parseCsv('entry_code,g1\n"E01",away\n'),[['entry_code','g1'],['E01','away']]);
});

test('Pickem import maps entries and rejects unknown rows',()=>{
  const text='entry_code,g1,g2,tiebreak\nE01,away,home,47\nBAD,home,away,44';
  const result=prepareCommissionerImport({
    text,poolType:'pickem',entries,
    weekConfig:{games:[{id:'g1'},{id:'g2'}],tiebreakRequired:true}
  });
  assert.equal(result.items.length,1);
  assert.deepEqual(result.items[0].payload,{picks:{g1:'away',g2:'home'},tiebreak:47});
  assert.equal(result.errors[0].code,'unknown_entry');
});

test('Survivor import produces one team per entry',()=>{
  const result=prepareCommissionerImport({
    text:'entry_code,team\nE02,Miami',
    poolType:'survivor',entries,weekConfig:{}
  });
  assert.deepEqual(result.items,[{entry_id:entries[1].id,payload:{team:'Miami'}}]);
});

test('batch summary distinguishes source conflicts',()=>{
  const summary=summarizeBatchResults([
    {ok:true},{ok:false,code:'source_conflict:participant'},{ok:false,code:'invalid_payload'}
  ]);
  assert.deepEqual({submitted:summary.submitted,conflicts:summary.conflicts,errors:summary.errors},{submitted:1,conflicts:1,errors:1});
});
