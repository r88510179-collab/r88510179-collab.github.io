import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import fs from 'node:fs';
import {reviewFinalScores,manualAttestationFingerprint,auditText,weekAcceptsFinalScores,scheduleBlockers,
  finalResultErrorMessage,ATTESTABLE_WEEK_STATUSES,SERVER_REFUSALS,STALE_RESULT_REVISION} from '../final-results-form.js';
const week={id:'30000000-0000-0000-0000-000000000001',status:'locked',
  deadline_at:'2026-11-08T18:00:00.000Z',
  config:{games:[
    {id:'g1',away:{key:'WAS'},home:{key:'NYG'},kickoff:'2026-11-08T18:00:00.000Z'},
    {id:'g2',away:{key:'BAL'},home:{key:'JAX'},kickoff:'2026-11-08T21:00:00.000Z'}
  ]}
};
const now=new Date('2026-11-11T19:30:00Z');
const values={g1:{away_score:'21',home_score:'14'},g2:{away_score:'17',home_score:'17'}};
const sourceReference='Independently checked official league recap for both Week 10 games';
const review=(extra={})=>reviewFinalScores({week,values,sourceReference,now,...extra});

test('review normalizes all games and recognizes tied final',()=>{
  const r=review();
  assert.equal(r.ok,true,r.reason);
  assert.equal(r.results.g1.away_score,21);
  assert.equal(r.results.g2.home_score,17);
  assert.equal(r.summary.length,2);
  assert.equal(r.expected_revision,0);
  assert.equal(r.correction_reason,null);
});
test('tamper-evident fingerprint deterministic; only reviewed references',async()=>{
  const r=review();const a=await manualAttestationFingerprint(r,webcrypto);
  const b=await manualAttestationFingerprint(r,webcrypto);
  assert.match(a,/^[a-f0-9]{64}$/);assert.equal(a,b);
  const other=review({sourceReference:sourceReference+' (corrected)'});
  assert.notEqual(a,await manualAttestationFingerprint(other,webcrypto));
});
test('eligibility follows the pick deadline: never a draft, and an open week only once its deadline has passed',()=>{
  const before=new Date('2026-11-07T18:00:00Z');
  for(const status of ['open','locked','final']){
    assert.equal(review({week:{...week,status}}).ok,true,status);
    assert.equal(review({week:{...week,status},now:before}).ok,false,`${status} before its deadline`);
    assert.equal(weekAcceptsFinalScores({...week,status},now),true,status);
    assert.equal(weekAcceptsFinalScores({...week,status},before),false,status);
  }
  for(const status of ['draft','archived','',undefined,null]){
    assert.equal(review({week:{...week,status}}).ok,false,String(status));
    assert.equal(weekAcceptsFinalScores({...week,status},now),false,String(status));
  }
  assert.deepEqual([...ATTESTABLE_WEEK_STATUSES],['open','locked','final']);
  assert.equal(weekAcceptsFinalScores({...week,deadline_at:'not a date'},now),false);
  assert.equal(weekAcceptsFinalScores(null,now),false);
  assert.equal(weekAcceptsFinalScores(week,new Date(week.deadline_at)),true,'the deadline instant itself has passed');
  // The migration this mirrors must name the same statuses, and no others.
  const sql=fs.readFileSync(new URL('../migrations/20261112_final_attestation_hardening.sql',import.meta.url),'utf8');
  assert.match(sql,/v_status NOT IN \('open','locked','final'\)/);
});
test('a game that has not kicked off is reported as that, not as a schedule defect',()=>{
  const pending={...week,config:{games:[week.config.games[0],{...week.config.games[1],kickoff:'2026-11-12T00:00:00Z'}]}};
  const r=review({week:pending});
  assert.equal(r.ok,false);
  assert.match(r.reason,/not kicked off/);
  const broken={...week,config:{games:[week.config.games[0],{...week.config.games[1],kickoff:'soon'}]}};
  assert.match(review({week:broken}).reason,/schedule review/);
});
test('audit text is one line: line breaks, tabs and control characters become single spaces',()=>{
  assert.equal(auditText('  https://a.invalid/1\r\n\thttps://a.invalid/2  '),'https://a.invalid/1 https://a.invalid/2');
  assert.equal(auditText('a\u0000b\u001bc\u007fd\u0085e\u2028f\u2029g'),'a b c d e f g');
  assert.equal(auditText(null),'');
  // No character the server's [[:cntrl:]] check refuses can survive, so a reviewed reference is never refused for it.
  const everyControl=String.fromCharCode(...Array.from({length:160},(_,i)=>i).filter(i=>i<32||(i>=127&&i<160)));
  assert.equal(auditText(`x${everyControl}y`),'x y');
  const twoLines=review({sourceReference:'Official game book, game one\nOfficial game book, game two'});
  assert.equal(twoLines.ok,true,twoLines.reason);
  assert.equal(twoLines.source_reference,'Official game book, game one Official game book, game two');
  assert.equal(review({sourceReference:'\n\n   \t short \n'}).ok,false,'padding does not count toward the minimum');
  const reason=review({currentRevision:1,values:{...values,g1:{away_score:'14',home_score:'21'}},
    correctionReason:'Scores were\ntransposed'});
  assert.equal(reason.correction_reason,'Scores were transposed');
});
test('an unchanged correction is caught whatever order the stored games arrive in',()=>{
  const prior=review().results;
  const reordered=Object.fromEntries(Object.entries(prior).reverse());
  assert.notEqual(JSON.stringify(reordered),JSON.stringify(prior));
  const same=review({currentRevision:1,currentResults:reordered,correctionReason:'No real change at all'});
  assert.equal(same.ok,false);
  assert.match(same.reason,/match the current revision/);
  // A stored revision for another set of games is never mistaken for "unchanged".
  const partial=review({currentRevision:1,currentResults:{g1:prior.g1},correctionReason:'Second game was missing'});
  assert.equal(partial.ok,true,partial.reason);
});
test('every refusal the result RPCs can raise has its own message, and unknown codes keep the shared one',()=>{
  const codes=SERVER_REFUSALS.map(([code])=>code);
  assert.equal(new Set(codes).size,codes.length);
  for(const a of codes)for(const b of codes)if(a!==b)assert.equal(a.includes(b),false,`${a} contains ${b}`);
  assert.equal(codes[0],STALE_RESULT_REVISION);
  for(const [code,message] of SERVER_REFUSALS){
    assert.equal(finalResultErrorMessage(code),message);
    assert.equal(finalResultErrorMessage(`P0001: ${code}`),message);
    assert.equal(/[<>]/.test(message),false);
  }
  assert.match(finalResultErrorMessage(STALE_RESULT_REVISION),/someone else/);
  assert.equal(finalResultErrorMessage('auth_required',()=>'shared'),'shared');
  assert.equal(finalResultErrorMessage(undefined,()=>'shared'),'shared');
  assert.match(finalResultErrorMessage('something_new'),/could not be completed/);
  // Drift guard: each exception text in the three result migrations is either mapped here, is the
  // sign-in refusal the shared mapper already handles, or is the trigger's own text (never raised by an RPC).
  const raised=new Set();
  for(const file of ['20261111_week_final_attestations.sql','20261111_attestation_evidence.sql','20261112_final_attestation_hardening.sql']){
    const sql=fs.readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8');
    for(const match of sql.matchAll(/RAISE EXCEPTION '([a-z_]+)'/g))raised.add(match[1]);
  }
  assert.ok(raised.size>=12,[...raised].join(','));
  const unmapped=[...raised].filter(code=>!codes.includes(code)).sort();
  assert.deepEqual(unmapped,['auth_required','result_revisions_are_append_only']);
});
test('requires a completed, verified week schedule and all scores',()=>{
  const future={...week,config:{games:[{...week.config.games[0],kickoff:'2026-11-12T00:00:00Z'}]}};
  assert.equal(review({week:future,values:{g1:values.g1}}).ok,false);
  assert.equal(review({values:{g1:values.g1}}).ok,false);
  assert.equal(review({values:{...values,g3:{away_score:'0',home_score:'0'}}}).ok,false);
  assert.equal(review({week:{...week,config:{games:[
    week.config.games[0],week.config.games[0]]}}}).ok,false);
});
test('scores fail closed on invalid numbers and incomplete game payload',()=>{
  for(const v of [-1,201,3.5,'03','NaN',null,'']) {
    assert.equal(review({values:{...values,g1:{away_score:v,home_score:'14'}}}).ok,false,String(v));
  }
  assert.equal(review({values:{...values,g1:{away_score:'14'}}}).ok,false);
});
test('corrections require revision and human reason; no-op rejected',()=>{
  const prior=review();
  assert.equal(review({currentRevision:1,currentResults:prior.results}).ok,false);
  assert.equal(review({currentRevision:1,correctionReason:'short'}).ok,false);
  const revised=review({currentRevision:1,
    values:{...values,g1:{away_score:'14',home_score:'21'}},
    currentResults:prior.results,correctionReason:'Corrected against an independently checked final'});
  assert.equal(revised.ok,true,revised.reason);
  assert.equal(revised.expected_revision,1);
  assert.equal(revised.correction_reason.length>8,true);
  assert.equal(review({correctionReason:'Invalid initial correction'}).ok,false);
});
test('does not mistake user-supplied source text for verified independent proof',()=>{
  const r=review({sourceReference:'short'});
  assert.equal(r.ok,false);
  assert.match(r.reason,/reference/i);
});

// The slates the live Commercial database holds for its 2027 weeks, exactly as stored: every game is an id and two
// teams, and none has a kickoff time (tests/release/production-replica-data.sql loads the same statements).
const storedSlate=extra=>({id:'30000000-0000-0000-0000-000000000005',status:'open',deadline_at:'2026-09-25T14:33:05.000Z',
  config:{tiebreakRequired:true,games:[
    {id:'g1',away:{key:'NYG',label:'New York'},home:{key:'DAL',label:'Dallas'}},
    {id:'g2',away:{key:'NYJ',label:'New York'},home:{key:'BUF',label:'Buffalo'}},
    {id:'g3',away:{key:'PHI',label:'Philadelphia'},home:{key:'WAS',label:'Washington'}},
    {id:'g4',away:{key:'KC',label:'Kansas City'},home:{key:'DEN',label:'Denver'}},
    {id:'g5',away:{key:'SF',label:'San Francisco'},home:{key:'SEA',label:'Seattle'}},...(extra??[])]}});
test('a week whose games have no kickoff time is blocked before any score is typed, and the review refuses it too',()=>{
  const stored=storedSlate();
  assert.deepEqual(scheduleBlockers(stored),['5 of 5 games have no kickoff time']);
  // The panel applies (the deadline has passed), so only the schedule stands in the way.
  assert.equal(weekAcceptsFinalScores(stored,now),true);
  const scores=Object.fromEntries(stored.config.games.map(game=>[game.id,{away_score:'21',home_score:'14'}]));
  assert.match(reviewFinalScores({week:stored,values:scores,sourceReference,now}).reason,/kickoff times require schedule review/);
  // A team that plays twice in one slate, as one stored Survivor week has: both findings are reported.
  assert.deepEqual(scheduleBlockers(storedSlate([{id:'g6',away:{key:'NYG',label:'New York'},home:{key:'MIA',label:'Miami'}}])),
    ['6 of 6 games have no kickoff time','1 of 6 games have a missing or repeated team or game identity']);
  // A kickoff that is not a time is no kickoff: nothing is guessed from it.
  for(const kickoff of ['',null,'Sunday 1pm','2026-13-45T99:00:00Z',1790000000000]){
    const one={...stored,config:{games:[{...stored.config.games[0],kickoff}]}};
    assert.deepEqual(scheduleBlockers(one),['1 of 1 game has no kickoff time'],String(kickoff));
  }
});
test('a verified slate has no schedule blocker, whether or not its games have been played yet',()=>{
  assert.deepEqual(scheduleBlockers(week),[]);
  const upcoming={...week,config:{games:week.config.games.map(game=>({...game,kickoff:'2099-01-01T18:00:00.000Z'}))}};
  assert.deepEqual(scheduleBlockers(upcoming),[],'a kickoff still to come is a matter of time, which the review checks');
  assert.match(reviewFinalScores({week:upcoming,values,sourceReference,now}).reason,/has not kicked off yet/);
  assert.deepEqual(scheduleBlockers({config:{games:[]}}),['it has no games']);
  assert.deepEqual(scheduleBlockers({}),['it has no games']);
  assert.deepEqual(scheduleBlockers({config:{games:Array.from({length:17},(_,i)=>({id:`g${i}`}))}}),['it has more than 16 games']);
});
test('one invalid stored kickoff blocks a complete-slate review without guessing the time',()=>{
  const withKickoff=kickoff=>({...week,config:{games:[week.config.games[0],{...week.config.games[1],kickoff}]}});
  for(const kickoff of ['2026-11-08','2026-11-08T21:00:00','2026-11-08T21:00:00-05:00',
    '2026-02-30T21:00:00Z','2026-11-08T24:00:00Z','-infinity','yesterday']){
    const invalid=withKickoff(kickoff);
    assert.deepEqual(scheduleBlockers(invalid),['1 of 2 games have no kickoff time'],kickoff);
    assert.match(review({week:invalid}).reason,/kickoff times require schedule review/,kickoff);
  }
  assert.deepEqual(scheduleBlockers(withKickoff('2026-11-08T21:00:00Z')),[]);
  assert.equal(review({week:withKickoff('2026-11-08T21:00:00Z')}).ok,true);
});
