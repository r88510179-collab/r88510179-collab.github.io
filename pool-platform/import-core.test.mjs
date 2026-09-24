import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCsv,prepareCommissionerImport,summarizeBatchResults} from './import-core.js';

const entries=[
  {id:'11111111-1111-1111-1111-111111111111',entry_code:'E01'},
  {id:'22222222-2222-2222-2222-222222222222',entry_code:'E02'}
];
const games=[
  {id:'g1',away:{key:'austin',label:'Austin'},home:{key:'denver',label:'Denver'}},
  {id:'g2',away:{key:'phoenix',label:'Phoenix'},home:{key:'seattle',label:'Seattle'}}
];

test('CSV parser supports quoted fields',()=>{
  assert.deepEqual(parseCsv('entry_code,g1\n"E01",away\n'),[['entry_code','g1'],['E01','away']]);
});

test('Pickem import maps entries and rejects unknown rows',()=>{
  const text='entry_code,g1,g2,tiebreak\nE01,away,home,47\nBAD,home,away,44';
  const result=prepareCommissionerImport({
    text,poolType:'pickem',entries,
    weekConfig:{games,tiebreakRequired:true}
  });
  assert.equal(result.items.length,1);
  assert.deepEqual(result.items[0].payload,{picks:{g1:'away',g2:'home'},tiebreak:47});
  assert.equal(result.errors[0].code,'unknown_entry');
});

test('Survivor import produces one team per entry',()=>{
  const result=prepareCommissionerImport({
    text:'entry_code,team\nE02,Denver',
    poolType:'survivor',entries,weekConfig:{games}
  });
  assert.deepEqual(result.items,[{entry_id:entries[1].id,payload:{team:'denver'}}]);
});

test('batch summary distinguishes source conflicts',()=>{
  const summary=summarizeBatchResults([
    {ok:true},{ok:false,code:'source_conflict:participant'},{ok:false,code:'invalid_payload'}
  ]);
  assert.deepEqual({submitted:summary.submitted,conflicts:summary.conflicts,errors:summary.errors},{submitted:1,conflicts:1,errors:1});
});


test('Pickem import accepts displayed city labels as well as away/home',()=>{
  const result=prepareCommissionerImport({
    text:'entry_code,g1,g2,tiebreak\nE01,Austin,Seattle,51',
    poolType:'pickem',entries,weekConfig:{games,tiebreakRequired:true}
  });
  assert.equal(result.errors.length,0);
  assert.deepEqual(result.items[0].payload,{picks:{g1:'away',g2:'home'},tiebreak:51});
});

const tiebreakEntries=['E01','E02','E03','E04','E05','E06'].map((entry_code,i)=>({id:`00000000-0000-4000-8000-00000000000${i+1}`,entry_code}));

test('required CSV tiebreak: blank or whitespace is missing, "0" is 0, 47 is 47, text is invalid',()=>{
  const text=['entry_code,g1,g2,tiebreak','E01,away,home,','E02,away,home,   ','E03,home,away,0','E04,home,home,47','E05,away,away,abc','E06,away,away'].join('\n');
  const result=prepareCommissionerImport({text,poolType:'pickem',entries:tiebreakEntries,weekConfig:{games,tiebreakRequired:true}});
  assert.deepEqual(result.errors.map(e=>[e.row,e.entry_code,e.code]),[
    [2,'E01','missing_tiebreak'],[3,'E02','missing_tiebreak'],[6,'E05','invalid_tiebreak'],[7,'E06','missing_tiebreak']
  ]);
  assert.deepEqual(result.items.map(item=>item.payload),[
    {picks:{g1:'home',g2:'away'},tiebreak:0},
    {picks:{g1:'home',g2:'home'},tiebreak:47}
  ]);
});

test('optional CSV tiebreak: a blank cell or absent column leaves it out, "0" stays 0, text is still invalid',()=>{
  const result=prepareCommissionerImport({
    text:'entry_code,g1,g2,tiebreak\nE01,away,home,\nE02,away,home,0\nE03,away,home,abc\nE04,away,home,47',
    poolType:'pickem',entries:tiebreakEntries,weekConfig:{games}
  });
  assert.deepEqual(result.items.map(item=>item.payload),[
    {picks:{g1:'away',g2:'home'}},{picks:{g1:'away',g2:'home'},tiebreak:0},{picks:{g1:'away',g2:'home'},tiebreak:47}
  ]);
  assert.equal('tiebreak' in result.items[0].payload,false,'blank must not become 0');
  assert.deepEqual(result.errors.map(e=>[e.entry_code,e.code]),[['E03','invalid_tiebreak']]);
  const noColumn=prepareCommissionerImport({text:'entry_code,g1,g2\nE01,away,home',poolType:'pickem',entries:tiebreakEntries,weekConfig:{games}});
  assert.deepEqual(noColumn,{items:[{entry_id:tiebreakEntries[0].id,payload:{picks:{g1:'away',g2:'home'}}}],errors:[]});
});

test('Survivor import normalizes a displayed city to its stable team key',()=>{
  const result=prepareCommissionerImport({
    text:'entry_code,team\nE01,Austin',
    poolType:'survivor',entries,weekConfig:{games}
  });
  assert.deepEqual(result.items[0].payload,{team:'austin'});
});
