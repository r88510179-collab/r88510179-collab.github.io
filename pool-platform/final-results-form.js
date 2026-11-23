// A compact, two-step commissioner review of completed games.
// This does not independently verify a provider or publish official ranks.
// The authenticated SQL RPC validates all permissions, deadlines and finals.
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const code=x=>typeof x==='string'&&/^[A-Za-z0-9-]{2,16}$/.test(x);
const storedKickoff=/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/;
function kickoffTime(value){
  if(typeof value!=='string'||!storedKickoff.test(value))return NaN;
  const time=Date.parse(value);
  if(!Number.isFinite(time))return NaN;
  const canonical=value.length===20?value.slice(0,-1)+'.000Z':value;
  return new Date(time).toISOString()===canonical?time:NaN;
}
const number=x=>{
  if(typeof x==='number')return Number.isInteger(x)&&x>=0&&x<=200?x:null;
  if(typeof x==='string'&&/^(0|[1-9][0-9]{0,2})$/.test(x)&&Number(x)<=200)
    return Number(x);
  return null;
};
const error=reason=>({ok:false,reason,results:null});

// The week statuses the server accepts once the pick deadline has passed.
// Nothing in the application moves a week out of 'open', and the submission
// RPC already refuses picks after the deadline, so an open week past its
// deadline is attestable. A draft week never is.
export const ATTESTABLE_WEEK_STATUSES=Object.freeze(['open','locked','final']);

// Audit text is kept on one line. The server refuses control characters in
// the evidence reference and the correction reason, and both boxes are
// multi-line, so line breaks, tabs and other control characters become one
// space here: what the commissioner reviews is exactly what is sent.
export function auditText(value){
  return String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g,' ')
    .replace(/\s+/g,' ').trim();
}

// Whether the final-score panel applies to this week at all. The server
// repeats every part of this and additionally checks each kickoff.
export function weekAcceptsFinalScores(week,now=new Date()){
  const time=now instanceof Date?now.getTime():Date.parse(now);
  const deadline=Date.parse(week?.deadline_at);
  return obj(week)&&ATTESTABLE_WEEK_STATUSES.includes(week.status)&&
    Number.isFinite(deadline)&&Number.isFinite(time)&&time>=deadline;
}

// Why this week's stored schedule cannot carry final scores at all: the reasons that waiting does not remove. A
// game with no kickoff time, or a team or game identity that is missing or repeated, means the schedule was never
// verified, and the server refuses every score for such a week. The page says so before any score is typed. An
// empty list says nothing about a deadline or a kickoff still to come: reviewFinalScores checks those.
export function scheduleBlockers(week){
  const games=week?.config?.games;
  if(!Array.isArray(games)||games.length<1)return ['it has no games'];
  if(games.length>16)return ['it has more than 16 games'];
  const seen=new Set(),teams=new Set();
  let unidentified=0,untimed=0;
  for(const game of games){
    const a=game?.away?.key,b=game?.home?.key;
    if(!id(game?.id)||seen.has(game.id)||!code(a)||!code(b)||a===b||teams.has(a)||teams.has(b))unidentified++;
    seen.add(game?.id);teams.add(a);teams.add(b);
    if(!Number.isFinite(kickoffTime(game?.kickoff)))untimed++;
  }
  const of=count=>`${count} of ${games.length} game${games.length===1?'':'s'}`;
  return [...(untimed?[`${of(untimed)} ${untimed===1&&games.length===1?'has':'have'} no kickoff time`]:[]),
    ...(unidentified?[`${of(unidentified)} ${unidentified===1&&games.length===1?'has':'have'} a missing or repeated team or game identity`]:[])];
}

export function reviewFinalScores({week,values,sourceReference,
  currentRevision=0,currentResults=null,correctionReason='',now=new Date()}={}){
  const games=week?.config?.games;
  const time=now instanceof Date?now.getTime():Date.parse(now);
  if(!weekAcceptsFinalScores(week,now))
    return error('Final scores can be recorded only after the week’s pick deadline has passed.');
  if(!Array.isArray(games)||games.length<1||games.length>16||!obj(values))
    return error('This week does not have a complete verified game schedule.');
  if(!Number.isInteger(currentRevision)||currentRevision<0)
    return error('The stored results revision could not be confirmed.');
  const source=auditText(sourceReference);
  if(source.length<12||source.length>500)
    return error('Provide a 12–500 character reference to the independently checked result evidence.');
  if(Object.keys(values).length!==games.length)
    return error('Enter a score for every game.');
  const results={},seen=new Set(),teams=new Set();
  for(const game of games){
    const a=game?.away?.key,b=game?.home?.key,kickoff=kickoffTime(game?.kickoff);
    if(!id(game?.id)||seen.has(game.id)||!code(a)||!code(b)||a===b||
       teams.has(a)||teams.has(b)||!Number.isFinite(kickoff))
      return error('Game identities or kickoff times require schedule review.');
    if(kickoff>time)
      return error('At least one game in this week has not kicked off yet. Record final scores only after every game has finished.');
    seen.add(game.id);teams.add(a);teams.add(b);
    const row=values[game.id];
    if(!obj(row)||Object.keys(row).sort().join(',')!=='away_score,home_score')
      return error('Enter both final scores for each game.');
    const away=number(row.away_score),home=number(row.home_score);
    if(away===null||home===null)
      return error('Scores must be whole numbers between 0 and 200.');
    results[game.id]={status:'final',away_score:away,home_score:home};
  }
  if(Object.keys(values).some(x=>!seen.has(x)))
    return error('A game outside this verified week was included.');
  const reason=auditText(correctionReason);
  if(currentRevision>0){
    if(reason.length<8||reason.length>240)
      return error('Explain the correction in 8–240 characters.');
    // Compared game by game: the stored revision comes back with its keys in the database's order, not the
    // schedule's, so comparing two serialized objects would miss an unchanged correction.
    if(obj(currentResults)&&Object.keys(currentResults).length===games.length&&
       games.every(g=>obj(currentResults[g.id])&&
         currentResults[g.id].away_score===results[g.id].away_score&&
         currentResults[g.id].home_score===results[g.id].home_score))
      return error('These results match the current revision; no correction is needed.');
  }else if(reason) return error('A correction reason is only for an existing result revision.');
  return {ok:true,reason:null,results,source_reference:source,
    correction_reason:currentRevision?reason:null,
    expected_revision:currentRevision,
    summary:games.map(g=>({
      game_id:g.id,matchup:`${g.away.key} at ${g.home.key}`,
      away_score:results[g.id].away_score,home_score:results[g.id].home_score
    }))};
}

// This is a **content fingerprint**, not proof of the external source's
// authenticity. The commissioner must retain the original source evidence.
export async function manualAttestationFingerprint(review,cryptoImpl=globalThis.crypto){
  if(!review?.ok||!cryptoImpl?.subtle?.digest)throw Error('Cannot prepare a reviewed attestation.');
  const bytes=new TextEncoder().encode(JSON.stringify({
    reference:review.source_reference,results:review.results
  }));
  const hash=new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',bytes));
  return [...hash].map(x=>x.toString(16).padStart(2,'0')).join('');
}

// What the commissioner is told for each refusal the two result RPCs raise.
// Every one of them means nothing was written. The match is by substring, so
// no code listed here may be contained in another. Anything not listed (for
// example auth_required) keeps the shared message from auth-core.js.
export const STALE_RESULT_REVISION='stale_result_revision';
export const SERVER_REFUSALS=Object.freeze([
  [STALE_RESULT_REVISION,'Results for this week were recorded by someone else after you opened this form, so nothing was saved. The latest recorded scores are loaded below: check them before recording a correction.'],
  ['week_not_eligible_for_final_attestation','Final scores can be recorded only after this week’s pick deadline has passed. Nothing was saved.'],
  ['game_not_started_or_schedule_missing','At least one game in this week has not kicked off yet, or its kickoff time is missing. Nothing was saved.'],
  ['invalid_result_source_reference','The evidence reference must be 12–500 characters on one line. Nothing was saved.'],
  ['initial_attestation_cannot_be_correction','A correction reason is only for a week that already has recorded results. Nothing was saved.'],
  ['correction_reason_required','Explain the correction in 8–240 characters on one line. Nothing was saved.'],
  ['no_result_change','These scores match the latest recorded revision, so no correction was saved.'],
  ['invalid_expected_revision','The stored results revision could not be confirmed. Reload the page and try again. Nothing was saved.'],
  ['invalid_final_results','One or more scores were not accepted. Enter a whole number from 0 to 200 for both teams in every game. Nothing was saved.'],
  ['invalid_verified_schedule','This week’s game schedule failed validation, so final scores cannot be recorded. Nothing was saved.'],
  ['week_not_found','You do not have access to record results for this week. Nothing was saved.']
].map(Object.freeze));
export function finalResultErrorMessage(raw,fallback=()=>
  'The request could not be completed. Please try again or contact the pool organizer.'){
  const text=String(raw??'');
  for(const [refusal,message] of SERVER_REFUSALS)if(text.includes(refusal))return message;
  return fallback(raw);
}
