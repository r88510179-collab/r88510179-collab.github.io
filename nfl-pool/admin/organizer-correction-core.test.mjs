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
  return{published,source,digest:sha,participantName:' mACKpool ',picksText:'1 4',tiebreakText:'51',sourceType:'organizer-email',noticeSubject:'Week 9 correction'};
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
  assert.equal(finalizeOrganizerCorrection(next,later.published,'2026-11-09T16:01:00Z').organizerCorrections.length,2);
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
