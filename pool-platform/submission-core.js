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

// Reads a typed or imported tiebreak. Blank, whitespace-only, null or undefined means "not entered" (never 0);
// 0-200 written as plain digits is a value; anything else is invalid. Matches the Postgres rule
// (^[0-9]{1,3}$ and <= 200).
export function parseTiebreak(value){
  if(value===undefined||value===null)return{present:false,valid:true,value:null};
  if(typeof value==='number'){
    return Number.isInteger(value)&&value>=0&&value<=200?{present:true,valid:true,value}:{present:true,valid:false,value:null};
  }
  if(typeof value!=='string')return{present:true,valid:false,value:null};
  const text=value.trim();
  if(!text)return{present:false,valid:true,value:null};
  return /^\d{1,3}$/.test(text)&&Number(text)<=200?{present:true,valid:true,value:Number(text)}:{present:true,valid:false,value:null};
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
  // The payload is checked as it will be sent: an absent (or null) tiebreak fails only when required, and a
  // present one must already be an integer 0-200. Blank input never reaches here as 0.
  const tiebreak=payload?.tiebreak;
  if(tiebreak===undefined||tiebreak===null){
    if(tiebreakRequired)errors.push({code:'tiebreak_required'});
  }else if(!Number.isInteger(tiebreak)||tiebreak<0||tiebreak>200){
    errors.push({code:'invalid_tiebreak'});
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
