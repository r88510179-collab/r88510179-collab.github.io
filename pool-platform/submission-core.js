export const SUBMISSION_SOURCES=Object.freeze({
  PARTICIPANT:'participant',
  COMMISSIONER_IMPORT:'commissioner_import',
  COMMISSIONER_MANUAL:'commissioner_manual'
});

export const SUBMISSION_STATUS=Object.freeze({
  SUBMITTED:'submitted',
  LOCKED:'locked'
});

export function isKnownSource(source){
  return Object.values(SUBMISSION_SOURCES).includes(source);
}

export function canSubmit({existing=null,source,now,deadline}){
  if(!isKnownSource(source))return{ok:false,code:'invalid_source'};
  const nowMs=new Date(now).getTime(),deadlineMs=new Date(deadline).getTime();
  if(!Number.isFinite(nowMs)||!Number.isFinite(deadlineMs))return{ok:false,code:'invalid_time'};
  if(nowMs>=deadlineMs)return{ok:false,code:'deadline_passed'};
  if(!existing)return{ok:true,code:'claim'};
  if(existing.status===SUBMISSION_STATUS.LOCKED)return{ok:false,code:'submission_locked',existingSource:existing.source};
  if(existing.source!==source)return{ok:false,code:'source_conflict',existingSource:existing.source};
  return{ok:true,code:'same_source_update',existingSource:existing.source};
}

export function validatePickPayload(payload,{gameIds,tiebreakRequired=false}={}){
  const errors=[];
  const ids=Array.isArray(gameIds)?gameIds:[];
  const picks=payload?.picks&&typeof payload.picks==='object'?payload.picks:{};
  for(const gameId of ids){
    const value=picks[gameId];
    if(value!=='away'&&value!=='home')errors.push({gameId,code:'pick_required'});
  }
  const extra=Object.keys(picks).filter(id=>!ids.includes(id));
  if(extra.length)errors.push({code:'unknown_games',gameIds:extra});
  if(tiebreakRequired){
    const n=Number(payload?.tiebreak);
    if(!Number.isInteger(n)||n<0||n>200)errors.push({code:'invalid_tiebreak'});
  }
  return{ok:errors.length===0,errors};
}

export function submissionConflictCopy(result){
  if(result?.code==='source_conflict'){
    if(result.existingSource===SUBMISSION_SOURCES.PARTICIPANT)return'This entry was already submitted directly by the participant. Commissioner import cannot overwrite it.';
    return'This entry was already submitted through the commissioner channel. Direct participant submission is closed for this week.';
  }
  if(result?.code==='deadline_passed')return'The submission deadline has passed.';
  if(result?.code==='submission_locked')return'This submission is locked.';
  return'Unable to submit these picks.';
}
