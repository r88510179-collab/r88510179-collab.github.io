import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUBMISSION_SOURCES,
  SUBMISSION_STATUS,
  canSubmit,
  parseTiebreak,
  validatePickPayload,
  submissionConflictCopy
} from './submission-core.js';

const now='2027-09-10T12:00:00Z';
const deadline='2027-09-10T23:00:00Z';

test('first final submission claims an unclaimed entry/week',()=>{
  assert.deepEqual(canSubmit({source:SUBMISSION_SOURCES.PARTICIPANT,now,deadline}),{ok:true,code:'claim'});
});

test('same source may update while open',()=>{
  const existing={source:SUBMISSION_SOURCES.PARTICIPANT,status:SUBMISSION_STATUS.SUBMITTED};
  assert.deepEqual(canSubmit({existing,source:SUBMISSION_SOURCES.PARTICIPANT,now,deadline}),{
    ok:true,code:'same_source_update',existingSource:SUBMISSION_SOURCES.PARTICIPANT
  });
});

test('participant submission blocks commissioner import',()=>{
  const existing={source:SUBMISSION_SOURCES.PARTICIPANT,status:SUBMISSION_STATUS.SUBMITTED};
  const result=canSubmit({existing,source:SUBMISSION_SOURCES.COMMISSIONER_IMPORT,now,deadline});
  assert.equal(result.ok,false);
  assert.equal(result.code,'source_conflict');
  assert.match(submissionConflictCopy(result),/participant/i);
});

test('commissioner submission blocks participant submission',()=>{
  const existing={source:SUBMISSION_SOURCES.COMMISSIONER_IMPORT,status:SUBMISSION_STATUS.SUBMITTED};
  const result=canSubmit({existing,source:SUBMISSION_SOURCES.PARTICIPANT,now,deadline});
  assert.equal(result.ok,false);
  assert.equal(result.code,'source_conflict');
  assert.match(submissionConflictCopy(result),/commissioner/i);
});

test('locked submission cannot be changed even by same source',()=>{
  const existing={source:SUBMISSION_SOURCES.PARTICIPANT,status:SUBMISSION_STATUS.LOCKED};
  assert.equal(canSubmit({existing,source:SUBMISSION_SOURCES.PARTICIPANT,now,deadline}).code,'submission_locked');
});

test('deadline blocks all normal submission paths',()=>{
  assert.equal(canSubmit({
    source:SUBMISSION_SOURCES.PARTICIPANT,
    now:'2027-09-10T23:00:00Z',
    deadline
  }).code,'deadline_passed');
});

test('pick payload requires exactly one side per configured game',()=>{
  const gameIds=['g1','g2'];
  assert.equal(validatePickPayload({picks:{g1:'away',g2:'home'},tiebreak:41},{gameIds,tiebreakRequired:true}).ok,true);
  assert.equal(validatePickPayload({picks:{g1:'away'},tiebreak:41},{gameIds,tiebreakRequired:true}).ok,false);
  assert.equal(validatePickPayload({picks:{g1:'away',g2:'home',g3:'away'},tiebreak:41},{gameIds,tiebreakRequired:true}).ok,false);
});

test('parseTiebreak: blank and whitespace are absent (never 0); 0, "0" and 47 are values; other text is invalid',()=>{
  const absent={present:false,valid:true,value:null},invalid={present:true,valid:false,value:null};
  for(const blank of ['','   ','\t\n',undefined,null])assert.deepEqual(parseTiebreak(blank),absent,JSON.stringify(blank));
  assert.deepEqual(parseTiebreak(0),{present:true,valid:true,value:0});
  assert.deepEqual(parseTiebreak('0'),{present:true,valid:true,value:0});
  assert.deepEqual(parseTiebreak(' 0 '),{present:true,valid:true,value:0});
  assert.deepEqual(parseTiebreak(47),{present:true,valid:true,value:47});
  assert.deepEqual(parseTiebreak('47'),{present:true,valid:true,value:47});
  assert.deepEqual(parseTiebreak('200'),{present:true,valid:true,value:200});
  for(const bad of ['abc','4.5','-1','+5','1e2','0x1f','4 7','201','1000',201,-1,4.5,Number.NaN,Infinity,true,[47],{}]){
    assert.deepEqual(parseTiebreak(bad),invalid,String(bad));
  }
});

test('tiebreak validation: absent/null fails only when required, 0 is valid, a present value must be an integer 0-200',()=>{
  const gameIds=['g1','g2'],picks={g1:'away',g2:'home'};
  const check=(payload,tiebreakRequired)=>validatePickPayload(payload,{gameIds,tiebreakRequired});
  assert.deepEqual(check({picks},true).errors,[{code:'tiebreak_required'}]);
  assert.deepEqual(check({picks,tiebreak:null},true).errors,[{code:'tiebreak_required'}]);
  assert.equal(check({picks,tiebreak:0},true).ok,true);
  assert.equal(check({picks,tiebreak:47},true).ok,true);
  assert.deepEqual(check({picks,tiebreak:''},true).errors,[{code:'invalid_tiebreak'}],'a raw blank string would be rejected by Postgres too');
  assert.equal(check({picks},false).ok,true,'optional tiebreak may be left out');
  assert.equal(check({picks,tiebreak:0},false).ok,true);
  assert.deepEqual(check({picks,tiebreak:'abc'},false).errors,[{code:'invalid_tiebreak'}]);
  assert.deepEqual(check({picks,tiebreak:201},false).errors,[{code:'invalid_tiebreak'}]);
});
