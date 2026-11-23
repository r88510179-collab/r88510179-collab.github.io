import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleImport,eligibleImportEntries,previewCommissionerImport,guidedCsv,survivorTeams,weekCanAcceptPicks,importErrorText,chooseCommissionerPool,newEntryDraft,newDraftWeek} from '../commissioner-workflow.js';
import {authErrorMessage} from '../auth-core.js';
const survivorConfig={games:[
  {id:'g1',away:{key:'C99-B-ORCA',label:'Synthetic Orcas'},home:{key:'C99-B-BOBCAT',label:'Synthetic Bobcats'}},
  {id:'g2',away:{key:'C99-B-HERON',label:'Synthetic Herons'},home:{key:'C99-B-LYNX',label:'Synthetic Lynx'}}
]};
const pickemConfig={games:[
  {id:'C99-TEST-GAME-1',away:{key:'a',label:'Synthetic A'},home:{key:'b',label:'Synthetic B'}},
  {id:'C99-TEST-GAME-2',away:{key:'c',label:'Synthetic C'},home:{key:'d',label:'Synthetic D'}}
],tiebreakRequired:true};
const week={id:'week-10',week:10,status:'open',deadline_at:'2026-11-20T00:00:00Z'};
const now=new Date('2026-11-03T17:00:00Z');
const entries=[
  {id:'participant',entry_code:'C99QABETA',display_name:'Player',status:'active',submissions:[{week:10,source:'participant'}]},
  {id:'commissioner',entry_code:'C99B',display_name:'Commissioner',status:'active',submissions:[{week:10,source:'commissioner_import'}]},
  {id:'empty',entry_code:'C99E',display_name:'Empty',status:'active',submissions:[]}
];
test('Survivor sample uses selected week actual team keys, not unrelated NFL examples',()=>{
  const text=sampleImport({poolType:'survivor',entries,weekConfig:survivorConfig,week});
  assert.match(text,/C99B,C99-B-ORCA/);
  assert.doesNotMatch(text,/Miami|Denver/);
});
test('Pickem sample matches real configured game identifiers and valid away/home',()=>{
  const text=sampleImport({poolType:'pickem',entries,weekConfig:pickemConfig,week});
  const p=previewCommissionerImport({text,poolType:'pickem',entries,weekConfig:pickemConfig,week,now});
  assert.equal(p.errors.length,0);
  assert.equal(p.items.length,1);
  assert.deepEqual(p.items[0].payload.picks,{'C99-TEST-GAME-1':'away','C99-TEST-GAME-2':'home'});
});
test('Sample will not propose player-owned entry',()=>{
  const text=sampleImport({poolType:'survivor',entries:[entries[0]],weekConfig:survivorConfig,week});
  assert.equal(text,'');
  assert.equal(eligibleImportEntries(entries,week).length,2);
});
test('Survivor preview rejects participant submission without writing',()=>{
  const p=previewCommissionerImport({text:'entry_code,team\nC99QABETA,C99-B-HERON',poolType:'survivor',entries,weekConfig:survivorConfig,week,now});
  assert.equal(p.items.length,0);
  assert.equal(p.errors[0].code,'source_conflict');
  assert.equal(entries[0].submissions.length,1);
});
test('Survivor preview accepts valid unused team code on commissioner entry',()=>{
  const p=previewCommissionerImport({text:'entry_code,team\nC99B,C99-B-HERON',poolType:'survivor',entries,weekConfig:survivorConfig,week,now});
  assert.equal(p.errors.length,0);
  assert.deepEqual(p.items[0].payload,{team:'C99-B-HERON'});
  assert.equal(p.warnings.length,1);
});
test('Survivor preview catches Miami instead of sending invalid team',()=>{
  const p=previewCommissionerImport({text:'entry_code,team\nC99B,Miami',poolType:'survivor',entries,weekConfig:survivorConfig,week,now});
  assert.equal(p.items.length,0);assert.equal(p.errors[0].code,'unknown_team');
});
test('Locked week cannot generate a submission preview',()=>{
  const p=previewCommissionerImport({text:'entry_code,team\nC99B,C99-B-HERON',poolType:'survivor',entries,weekConfig:survivorConfig,week:{...week,status:'locked'},now});
  assert.equal(p.items.length,0);assert.equal(p.errors[0].code,'week_closed');
});
test('Expired deadline cannot generate submission preview',()=>{
  const p=previewCommissionerImport({text:'entry_code,team\nC99B,C99-B-HERON',poolType:'survivor',entries,weekConfig:survivorConfig,week,now:new Date('2026-11-21T00:00:00Z')});
  assert.equal(p.items.length,0);assert.match(importErrorText(p.errors[0]),/deadline/i);
});
test('Guided Survivor uses single code exactly',()=>{
  const text=guidedCsv({poolType:'survivor',entryCode:'C99B',team:'C99-B-HERON',weekConfig:survivorConfig});
  assert.equal(text,'entry_code,team\nC99B,C99-B-HERON');
});
test('Guided Pickem CSV passes through existing validator',()=>{
  const text=guidedCsv({poolType:'pickem',entryCode:'C99B',choices:{'C99-TEST-GAME-1':'away','C99-TEST-GAME-2':'home'},tiebreak:'47',weekConfig:pickemConfig});
  const p=previewCommissionerImport({text,poolType:'pickem',entries,weekConfig:pickemConfig,week,now});
  assert.equal(p.errors.length,0);assert.equal(p.items[0].payload.tiebreak,47);
});
test('Empty CSV and unknown entry explained in plain language',()=>{
  const p=previewCommissionerImport({text:'entry_code,team\nUNKNOWN,C99-B-HERON',poolType:'survivor',entries,weekConfig:survivorConfig,week,now});
  assert.match(importErrorText(p.errors[0]),/not found/);
});
test('Backend source conflict is shown without technical code',()=>{
  const m=authErrorMessage('source_conflict:participant');
  assert.match(m,/already submitted/);
  assert.doesNotMatch(m,/source_conflict/);
});
test('Unknown server errors are not echoed to the user',()=>{
  assert.doesNotMatch(authErrorMessage('unexpected_internal_sql_function_error'),/sql_function/);
});
test('Survivor team listing tracks configured keys',()=>{
  assert.deepEqual(survivorTeams(survivorConfig).map(t=>t.key),['C99-B-ORCA','C99-B-BOBCAT','C99-B-HERON','C99-B-LYNX']);
});
test('Open window, not open yet and locked are distinguished',()=>{
  assert.equal(weekCanAcceptPicks(week,now).ok,true);
  assert.equal(weekCanAcceptPicks({...week,opens_at:'2026-11-11T00:00:00Z'},now).ok,false);
  assert.equal(weekCanAcceptPicks({...week,status:'final'},now).ok,false);
});

test('Commissioner pool discovery automatically opens one authorized pool',()=>{
  const selection=chooseCommissionerPool([{slug:'alpha-pickem',display_name:'Alpha Pickem',pool_type:'pickem'}]);
  assert.equal(selection.selected,'alpha-pickem');assert.equal(selection.automatic,true);
});
test('Commissioner pool discovery requires selection for two pools',()=>{
  const selection=chooseCommissionerPool([
    {slug:'alpha-pickem',display_name:'Alpha Pickem',pool_type:'pickem'},
    {slug:'beta-survivor',display_name:'Beta Survivor',pool_type:'survivor'}
  ]);
  assert.equal(selection.selected,null);assert.equal(selection.available.length,2);
});
test('Pool selection ignores untrusted malformed pool metadata and deduplicates',()=>{
  const selection=chooseCommissionerPool([
    {slug:'alpha-pickem',display_name:'Alpha',pool_type:'pickem'},
    {slug:'alpha-pickem',display_name:'Alpha duplicate',pool_type:'pickem'},
    {slug:'../../admin',display_name:'Hacker',pool_type:'pickem'},
    {slug:'beta-survivor',display_name:'Beta',pool_type:'invalid'}
  ]);
  assert.deepEqual(selection.available.map(p=>p.slug),['alpha-pickem']);
});
test('Known authorized pool link stays selected when multiple are available',()=>{
  const choice=chooseCommissionerPool([
    {slug:'alpha-pickem',display_name:'Alpha',pool_type:'pickem'},
    {slug:'beta-survivor',display_name:'Beta',pool_type:'survivor'}
  ],'beta-survivor');
  assert.equal(choice.selected,'beta-survivor');
});

test('Create-entry preview validates season and normalizes entry code',()=>{
  const draft=newEntryDraft({season:{id:'season-1',status:'active'},entryCode:' player-02 ',displayName:' Jordan ',entries:[]});
  assert.deepEqual(draft,{ok:true,code:'PLAYER-02',name:'Jordan',seasonId:'season-1'});
});
test('Create-entry preview prevents duplicate participant codes',()=>{
  const draft=newEntryDraft({season:{id:'season-1',status:'active'},entryCode:'e01',displayName:'Jordan',entries:[{entry_code:'E01'}]});
  assert.equal(draft.ok,false);assert.match(draft.error,/already exists/i);
});
test('Create-entry preview denies archived seasons and malicious codes',()=>{
  assert.equal(newEntryDraft({season:{id:'x',status:'archived'},entryCode:'C33',displayName:'J'}).ok,false);
  assert.equal(newEntryDraft({season:{id:'x',status:'active'},entryCode:'../BAD',displayName:'J'}).ok,false);
});
test('Entry operation error codes are explained to commissioners',()=>{
  assert.match(authErrorMessage('duplicate_entry_code'),/already in use/i);
  assert.doesNotMatch(authErrorMessage('invalid_entry_code'),/invalid_entry_code/);
});

test('Draft week setup validates week number and future deadline',()=>{
  const p=newDraftWeek({season:{id:'s1',status:'active'},weekNumber:'11',deadlineLocal:'2026-11-20T19:00',opensLocal:'2026-11-18T19:00',weeks:[{week:10}],now:new Date('2026-11-03T17:00:00Z')});
  assert.equal(p.ok,true);assert.equal(p.week,11);assert.equal(p.seasonId,'s1');assert.ok(p.deadlineAt.endsWith('Z'));
});
test('Draft week cannot duplicate protected Week 10 or use malformed week',()=>{
  const base={season:{id:'s1',status:'active'},deadlineLocal:'2026-11-20T19:00',weeks:[{week:10}],now:new Date('2026-11-03T17:00:00Z')};
  assert.equal(newDraftWeek({...base,weekNumber:'10'}).ok,false);
  assert.equal(newDraftWeek({...base,weekNumber:'2.5'}).ok,false);
});
test('Draft week protects against expired, far future and reversed windows',()=>{
  const base={season:{id:'s1',status:'active'},weekNumber:'11',weeks:[],now:new Date('2026-11-03T17:00:00Z')};
  assert.equal(newDraftWeek({...base,deadlineLocal:'2026-10-20T19:00'}).ok,false);
  assert.equal(newDraftWeek({...base,deadlineLocal:'2035-11-20T19:00'}).ok,false);
  assert.equal(newDraftWeek({...base,deadlineLocal:'2026-11-20T19:00',opensLocal:'2026-11-22T19:00'}).ok,false);
});
