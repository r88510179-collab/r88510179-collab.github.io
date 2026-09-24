import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUBMISSION_SOURCES,
  SUBMISSION_STATUS,
  canSubmit,
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
