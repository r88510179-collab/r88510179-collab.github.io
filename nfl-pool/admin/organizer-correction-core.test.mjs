import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {planOrganizerCorrection,finalizeOrganizerCorrection} from './organizer-correction-core.js';

const sha='a'.repeat(64);
const games=[
  {index:0,away:'JAX',home:'BAL',awayNumber:1,homeNumber:2},
  {index:1,away:'CIN',home:'ATL',awayNumber:3,homeNumber:4}
];
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
  const participants=['dc','jc','djs','thaddeus'].map(id=>({id,displayName:id,pickNumbers:[1,3],tiebreak:40}));
  const fieldEntries=[
    {id:'field-001',pickNumbers:[1,3],tiebreak:40},
    {id:'field-002',pickNumbers:[2,4],tiebreak:51},
    {id:'field-003',pickNumbers:[1,4],tiebreak:43}
  ];
  const cfg={season:2026,week:9,games,participants,fieldEntries,fullFieldReady:true,fullFieldValidationVersion:4,
    fullFieldEntryCount:3,competitionSize:7,tiebreakGameIndex:1,source:{kind:'weekly-upload',sha256:sha,filename:'source.xlsx'}};
  const published={season:2026,week:9,revision:3,status:'locked',source_sha256:sha,config:clone(cfg)};
  const source={config:clone(cfg),localFieldNames:['Alpha','Mackpool','Gamma']};
  return{published,source,digest:sha,participantName:' mACKpool ',picksText:'1 4',tiebreakText:'51',sourceType:'organizer-email'};
}
test('matches exact original source name and produces minimal anonymous single-entry correction',()=>{
  const args=fixture(),plan=planOrganizerCorrection(args);
  assert.equal(plan.entryId,'field-002');
  assert.equal(plan.index,1);
  assert.equal(plan.changes.length,1);
  assert.equal(plan.changes[0].gameIndex,0);
  assert.deepEqual(plan.afterConfig.fieldEntries[0],args.published.config.fieldEntries[0]);
  assert.deepEqual(plan.afterConfig.fieldEntries[2],args.published.config.fieldEntries[2]);
  assert.deepEqual(plan.afterConfig.fieldEntries[1].pickNumbers,[1,4]);
  assert.deepEqual(args.published.config.fieldEntries[1].pickNumbers,[2,4]);
  const result=finalizeOrganizerCorrection(plan,args.published,'2026-11-09T16:00:00Z');
  assert.equal(result.organizerCorrections.length,1);
  assert.equal(result.organizerCorrections[0].entryId,'field-002');
  assert.equal(result.organizerCorrections[0].priorRevision,3);
  assert.equal(result.organizerCorrections[0].noticeSubject,'Organizer email');
  assert.deepEqual(result.organizerCorrections[0].priorPickNumbers,[2,4]);
  assert.deepEqual(result.organizerCorrections[0].correctedPickNumbers,[1,4]);
  assert.equal(JSON.stringify(result).includes('Mackpool'),false);
  assert.equal(result.competitionSize,7);
});
test('accepts a later correction only when prior anonymous change has recorded provenance',()=>{
  const a=fixture(),first=planOrganizerCorrection(a),config=finalizeOrganizerCorrection(first,a.published,'2026-11-09T16:00:00Z');
  const later={...a,published:{...a.published,revision:4,config},picksText:'2 3',tiebreakText:'53'};
  const next=planOrganizerCorrection(later);
  assert.equal(next.entryId,'field-002');
  assert.deepEqual(next.previousPicks,[1,4]);
  assert.deepEqual(next.correctedPicks,[2,3]);
  const history=finalizeOrganizerCorrection(next,later.published,'2026-11-09T16:01:00Z').organizerCorrections;
  assert.equal(history.length,2);
  assert.deepEqual(history[0],config.organizerCorrections[0]);
});
test('refuses wrong source fingerprint',()=>{
  const a=fixture();a.digest='b'.repeat(64);
  assert.throws(()=>planOrganizerCorrection(a),/exact original uploaded sheet/);
});
test('refuses duplicate or missing original names',()=>{
  const a=fixture();a.source.localFieldNames[2]='Mackpool';
  assert.throws(()=>planOrganizerCorrection(a),/more than once/);
  a.source.localFieldNames[2]='Gamma';a.participantName='unknown';
  assert.throws(()=>planOrganizerCorrection(a),/not found/);
});
test('refuses published entries changed without correction provenance',()=>{
  const a=fixture();a.published.config.fieldEntries[0].tiebreak=99;
  assert.throws(()=>planOrganizerCorrection(a),/cannot be reconciled/);
});
test('refuses ambiguous or malformed corrected picks and invalid tiebreak',()=>{
  for(const [p,t,pattern] of [['1','51',/exactly 2/],['1 8','51',/Pick 2/],['1 3','51',/already matches/],['1 4','-1',/valid, nonnegative/]]){
    const a=fixture();a.picksText=p;a.tiebreakText=t;
    if(p==='1 3'){a.published.config.fieldEntries[1].pickNumbers=[1,3];a.source.config.fieldEntries[1].pickNumbers=[1,3];}
    assert.throws(()=>planOrganizerCorrection(a),pattern);
  }
});
test('refuses game-order and entry-count mismatches',()=>{
  const a=fixture();a.source.config.games[0].awayNumber=2;
  assert.throws(()=>planOrganizerCorrection(a),/configuration failed validation|matchup order/);
  const b=fixture();b.source.localFieldNames.pop();
  assert.throws(()=>planOrganizerCorrection(b),/one-to-one/);
});
test('refuses source name being appended to persistent anonymous field entries',()=>{
  const a=fixture();a.source.config.fieldEntries[1].sourceName='Mackpool';
  assert.throws(()=>planOrganizerCorrection(a),/validation|reconciled/);
});

test('new public history cannot contain free-form references or private source content',()=>{
  const privateValues=[
    'Mackpool','Organizer correction, same email as Alpha','participant@example.test',
    'private-source-for-Alpha.xlsm','alpha-email-screenshot.png','data:image/png;base64,PRIVATE',
    'Forwarded message with a private phone number 555-0100'
  ];
  for(const value of privateValues){
    const args=fixture();
    args.noticeSubject=value;
    args.noticeAttachment=value;
    args.source.config.source.filename=value;
    args.source.fileContents=value;
    args.source.screenshot=value;
    const plan=planOrganizerCorrection(args);
    const result=finalizeOrganizerCorrection({...plan,noticeSubject:value},args.published,'2026-11-09T16:00:00Z');
    assert.equal(result.organizerCorrections[0].noticeSubject,'Organizer email');
    assert.deepEqual(result.source,args.published.config.source);
    assert(!JSON.stringify(result).includes(value));
    assert.throws(()=>planOrganizerCorrection({...args,sourceType:value}),/Unsupported organizer notice type/);
    assert.throws(()=>finalizeOrganizerCorrection({...plan,sourceType:value},args.published,'2026-11-09T16:00:00Z'),/Unsupported organizer notice type/);
  }
});

test('whole-sheet publisher refuses to erase recorded organizer corrections',()=>{
  const source=readFileSync(new URL('./admin.js',import.meta.url),'utf8');
  assert.match(source,/existing\.config\?\.organizerCorrections/);
  assert.match(source,/Full-sheet replacement is blocked because it would lose correction history/);
});

function withVerifiedMissingValues(){
  const a=fixture();
  // An original fully verified PDF recovery may leave one no-pick and an unknown tiebreak.
  // This remains a valid v4 full-field entry; the test must not manufacture substitutes.
  const entry={id:'field-002',pickNumbers:[0,4],tiebreak:null};
  a.source.config.fieldEntries[1]=clone(entry);
  a.published.config.fieldEntries[1]=clone(entry);
  a.picksText='0 3';a.tiebreakText='';
  return a;
}
test('preserves original no-pick 0 and null tiebreak when a different game is corrected',()=>{
  const a=withVerifiedMissingValues(),plan=planOrganizerCorrection(a);
  assert.equal(plan.entryId,'field-002');
  assert.deepEqual(plan.previousPicks,[0,4]);
  assert.deepEqual(plan.correctedPicks,[0,3]);
  assert.equal(plan.previousTiebreak,null);
  assert.equal(plan.correctedTiebreak,null);
  assert.deepEqual(plan.changes.map(c=>c.gameIndex),[1]);
  const updated=finalizeOrganizerCorrection(plan,a.published,'2026-11-11T12:00:00Z');
  assert.deepEqual(updated.fieldEntries[1],{id:'field-002',pickNumbers:[0,3],tiebreak:null});
  assert.deepEqual(updated.fieldEntries[0],a.published.config.fieldEntries[0]);
  assert.deepEqual(updated.fieldEntries[2],a.published.config.fieldEntries[2]);
  assert.deepEqual(updated.organizerCorrections[0].priorPickNumbers,[0,4]);
  assert.deepEqual(updated.organizerCorrections[0].correctedPickNumbers,[0,3]);
  assert.equal(updated.organizerCorrections[0].priorTiebreak,null);
  assert.equal(updated.organizerCorrections[0].correctedTiebreak,null);
  assert.equal(updated.competitionSize,7);
  assert(!JSON.stringify(updated).includes('Mackpool'));
});
test('allows a tiebreak-only correction while retaining no-pick 0',()=>{
  const a=withVerifiedMissingValues();a.picksText='0 4';a.tiebreakText='52';
  const plan=planOrganizerCorrection(a);
  assert.deepEqual(plan.changes,[]);
  assert.equal(plan.previousTiebreak,null);
  assert.equal(plan.correctedTiebreak,52);
  assert.deepEqual(finalizeOrganizerCorrection(plan,a.published,'2026-11-11T12:00:00Z').fieldEntries[1].pickNumbers,[0,4]);
});
test('allows filling a formerly missing pick while preserving blank tiebreak',()=>{
  const a=withVerifiedMissingValues();a.picksText='1 4';
  const plan=planOrganizerCorrection(a);
  assert.deepEqual(plan.correctedPicks,[1,4]);
  assert.equal(plan.correctedTiebreak,null);
});
test('refuses accidental erasure, malformed no-picks, or hidden tiebreak changes',()=>{
  const newMissing=fixture();newMissing.picksText='0 4';
  assert.throws(()=>planOrganizerCorrection(newMissing),/Use 0 only to retain an existing no-pick/);
  const missing=withVerifiedMissingValues();missing.picksText='0 0';
  assert.throws(()=>planOrganizerCorrection(missing),/Use 0 only to retain an existing no-pick/);
  const existingNumber=fixture();existingNumber.tiebreakText='';
  assert.throws(()=>planOrganizerCorrection(existingNumber),/leave blank only to retain an existing blank tiebreaker/);
  const existingNull=withVerifiedMissingValues();
  existingNull.tiebreakText='null';
  assert.throws(()=>planOrganizerCorrection(existingNull),/leave blank only to retain an existing blank tiebreaker/);
  const noop=withVerifiedMissingValues();noop.picksText='0 4';
  assert.throws(()=>planOrganizerCorrection(noop),/already matches this correction/);
});
