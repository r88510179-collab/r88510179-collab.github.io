import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCsv,prepareCommissionerImport,describeImportError,summarizeBatchResults} from './import-core.js';

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

// Two configured teams that display the same city. Each stays reachable by its stable key; the shared label
// is never resolved to whichever team happens to be listed first.
const sharedCity=[
  {id:'g1',away:{key:'NYG',label:'New York'},home:{key:'DAL',label:'Dallas'}},
  {id:'g2',away:{key:'MIA',label:'Miami'},home:{key:'NYJ',label:'New York'}}
];
const sameMatchup=[{id:'g1',away:{key:'NYJ',label:'New York'},home:{key:'NYG',label:'New York'}}];
const survivor=(text,games=sharedCity)=>prepareCommissionerImport({text,poolType:'survivor',entries:tiebreakEntries,weekConfig:{games}});
const pickem=(text,games)=>prepareCommissionerImport({text,poolType:'pickem',entries:tiebreakEntries,weekConfig:{games}});

test('Survivor import: a unique city label or a unique team key resolves to the configured key',()=>{
  const result=survivor('entry_code,team\nE01,Dallas\nE02,NYG\nE03,nyj\nE04, miami ');
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.items.map(item=>item.payload.team),['DAL','NYG','NYJ','MIA']);
});

test('Survivor import: a label two teams share is ambiguous_team_label with row context, never the first team',()=>{
  const result=survivor('entry_code,team\nE01,New York\nE02,NYG\nE03,new york');
  assert.deepEqual(result.items,[{entry_id:tiebreakEntries[1].id,payload:{team:'NYG'}}]);
  const candidates=[
    {game_id:'g1',side:'away',key:'NYG',label:'New York',use:'NYG'},{game_id:'g2',side:'home',key:'NYJ',label:'New York',use:'NYJ'}
  ];
  assert.deepEqual(result.errors,[
    {row:2,code:'ambiguous_team_label',entry_code:'E01',value:'New York',candidates},
    {row:4,code:'ambiguous_team_label',entry_code:'E03',value:'new york',candidates}
  ]);
  assert.equal(describeImportError(result.errors[0]),
    'ambiguous_team_label · "New York" · matches NYG (New York) in g1 and NYJ (New York) in g2 · type NYG or NYJ instead');
});

test('Survivor import: a value that is one team\'s key and another team\'s label is ambiguous too',()=>{
  const games=[{id:'g1',away:{key:'la',label:'Los Angeles'},home:{key:'lv',label:'LA'}}];
  const result=survivor('entry_code,team\nE01,LA\nE02,Los Angeles\nE03,lv\nE04,la',games);
  assert.deepEqual(result.errors.map(e=>[e.row,e.code,e.candidates.map(c=>`${c.key}:${c.use}`)]),
    [[2,'ambiguous_team_label',['la:Los Angeles','lv:lv']],[5,'ambiguous_team_label',['la:Los Angeles','lv:lv']]]);
  assert.deepEqual(result.items.map(item=>item.payload.team),['la','lv']);
  assert.match(describeImportError(result.errors[0]),/ · type Los Angeles or lv instead$/,'the colliding key "la" is never suggested');
});

test('Survivor import: when no value names either colliding team alone, the schedule is named as the fix',()=>{
  const crosswise=[{id:'g1',away:{key:'north',label:'South'},home:{key:'south',label:'North'}}];
  const result=survivor('entry_code,team\nE01,north\nE02,South',crosswise);
  assert.deepEqual(result.items,[]);
  assert.deepEqual(result.errors.map(e=>[e.code,e.candidates.map(c=>c.use)]),[['ambiguous_team_label',[null,null]],['ambiguous_team_label',[null,null]]]);
  assert.match(describeImportError(result.errors[0]),/ · no value names one of these teams alone; give them distinct keys and labels in the schedule$/);
  const pick=pickem('entry_code,g1\nE01,north\nE02,away',crosswise);
  assert.match(describeImportError(pick.errors[0]),/ · type away or home instead$/,'Pickem can still use away/home');
  assert.deepEqual(pick.items.map(item=>item.payload.picks.g1),['away']);
});

test('Survivor import: a team listed twice in the schedule is ambiguous even by its key',()=>{
  const games=[{id:'g1',away:{key:'dup',label:'Dupe City'},home:{key:'a',label:'A'}},{id:'g2',away:{key:'dup',label:'Dupe City'},home:{key:'b',label:'B'}}];
  const result=survivor('entry_code,team\nE01,dup\nE02,Dupe City',games);
  assert.deepEqual(result.items,[]);
  assert.deepEqual(result.errors.map(e=>[e.entry_code,e.code]),[['E01','ambiguous_team_label'],['E02','ambiguous_team_label']]);
  assert.match(describeImportError(result.errors[0]),/matches dup \(Dupe City\) in g1 and dup \(Dupe City\) in g2 · no value names one of these teams alone/);
  const keyless=survivor('entry_code,team\nE01,Metro',[{id:'g1',away:{label:'Metro'},home:{key:'b',label:'B'}},{id:'g2',away:{label:'Metro'},home:{key:'c',label:'C'}}]);
  assert.equal(describeImportError(keyless.errors[0]),
    'ambiguous_team_label · "Metro" · matches Metro in g1 and Metro in g2 · no value names one of these teams alone; give them distinct keys and labels in the schedule');
});

test('Survivor import: an unknown label is unknown_team and names the value',()=>{
  const result=survivor('entry_code,team\nE01,Houston\nE02,away');
  assert.deepEqual(result.items,[]);
  assert.deepEqual(result.errors,[
    {row:2,code:'unknown_team',entry_code:'E01',value:'Houston'},
    {row:3,code:'unknown_team',entry_code:'E02',value:'away'}
  ]);
  assert.equal(describeImportError(result.errors[0]),'unknown_team · "Houston"');
});

test('Pickem import: away/home, a unique key and a unique label resolve; a label on both sides of one matchup is rejected',()=>{
  const ok=pickem('entry_code,g1\nE01,away\nE02,HOME\nE03,nyj\nE04,NYG',sameMatchup);
  assert.deepEqual(ok.errors,[]);
  assert.deepEqual(ok.items.map(item=>item.payload.picks.g1),['away','home','away','home']);
  const labels=pickem('entry_code,g1,g2\nE01,Dallas,miami\nE02, dallas ,Miami',sharedCity);
  assert.deepEqual(labels.errors,[]);
  assert.deepEqual(labels.items.map(item=>item.payload.picks),[{g1:'home',g2:'away'},{g1:'home',g2:'away'}],'a unique label resolves');
  const ambiguous=pickem('entry_code,g1\nE01,New York\nE02,away',sameMatchup);
  assert.deepEqual(ambiguous.items,[{entry_id:tiebreakEntries[1].id,payload:{picks:{g1:'away'}}}]);
  assert.deepEqual(ambiguous.errors,[{row:2,entry_code:'E01',code:'ambiguous_team_label',game_id:'g1',value:'New York',candidates:[
    {side:'away',key:'NYJ',label:'New York',use:'away'},{side:'home',key:'NYG',label:'New York',use:'home'}
  ]}]);
  assert.equal(describeImportError(ambiguous.errors[0]),
    'ambiguous_team_label · game g1 · "New York" · matches away NYJ (New York) and home NYG (New York) · type away or home instead');
});

test('Pickem import: a label repeated elsewhere in the schedule still names one team inside its own game column',()=>{
  const result=pickem('entry_code,g1,g2\nE01,New York,New York\nE02,Dallas,Miami\nE03,NYJ,NYJ',sharedCity);
  assert.deepEqual(result.items.map(item=>item.payload.picks),[{g1:'away',g2:'home'},{g1:'home',g2:'away'}]);
  assert.deepEqual(result.errors,[{row:4,entry_code:'E03',code:'invalid_picks',game_id:'g1',value:'NYJ'}],'a key from another game is not a side of this one');
});

test('Pickem import: an unknown or blank pick is invalid_picks and names the game and value',()=>{
  const result=pickem('entry_code,g1,g2\nE01,Houston,home\nE02,away,\nE03,away',games);
  assert.deepEqual(result.items,[]);
  assert.deepEqual(result.errors,[
    {row:2,entry_code:'E01',code:'invalid_picks',game_id:'g1',value:'Houston'},
    {row:3,entry_code:'E02',code:'invalid_picks',game_id:'g2',value:''},
    {row:4,entry_code:'E03',code:'invalid_picks',game_id:'g2',value:''}
  ]);
  assert.equal(describeImportError(result.errors[0]),'invalid_picks · game g1 · "Houston"');
});

test('quoted CSV: quoting never bypasses the ambiguity check; quoted commas and quotes match exact labels',()=>{
  const games=[
    {id:'g1',away:{key:'NYG',label:'New York'},home:{key:'dc',label:'Washington, D.C.'}},
    {id:'g2',away:{key:'NYJ',label:'New York'},home:{key:'bigd',label:'Dallas "Big D"'}}
  ];
  const s=survivor('entry_code,team\nE01,"New York"\nE02,"Washington, D.C."\nE03,"Dallas ""Big D"""\nE04,"NYJ"\nE05," New York "',games);
  assert.deepEqual(s.items.map(item=>item.payload.team),['dc','bigd','NYJ']);
  assert.deepEqual(s.errors.map(e=>[e.row,e.code,e.value]),[[2,'ambiguous_team_label','New York'],[6,'ambiguous_team_label','New York']]);
  const p=pickem('entry_code,g1,g2\nE01,"Washington, D.C.","New York"\nE02,"New York","Dallas ""Big D"""',games);
  assert.deepEqual(p.items.map(item=>item.payload.picks),[{g1:'home',g2:'away'},{g1:'away',g2:'home'}]);
  assert.deepEqual(p.errors,[]);
});
