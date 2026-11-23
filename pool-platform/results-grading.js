// Final-score grading for one week: Pick'em correct picks and Survivor outcomes from FINAL results only.
// Pure and deterministic: no network, no storage, no DOM, no clock, no credentials. It publishes nothing.
// One implementation for every caller: the pages (season-standings-core.js), the offline replay
// (server/season-replay-core.mjs) and scripts/results-preview.mjs, which re-exports this module.
// Moved here unchanged from scripts/results-preview.mjs so that the browser build can ship it.
const SIDES=new Set(['away','home']);
const SOURCES=new Set(['participant','commissioner_import','commissioner_manual']);
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const MAX_SCORE=200;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const key=v=>typeof v==='string'?v:v?.key;
const valid=v=>typeof v==='string'&&ID.test(v);
const keys=v=>object(v)?Object.keys(v):[];

export function validateFinalWeek({games,results}={}){
  const errors=[];
  if(!Array.isArray(games)||games.length<1||games.length>16)errors.push('invalid_games');
  if(!object(results))errors.push('invalid_results');
  if(errors.length)return {ok:false,errors,outcomes:[]};
  const ids=new Set(),teams=new Set(),outcomes=[];
  for(const game of games){
    const id=game?.id,away=key(game?.away),home=key(game?.home);
    if(!valid(id)||ids.has(id)){errors.push('invalid_or_duplicate_game_id');continue}
    ids.add(id);
    if(!valid(away)||!valid(home)||away===home||teams.has(away)||teams.has(home)){
      errors.push('invalid_teams:'+id);continue;
    }
    teams.add(away);teams.add(home);
    if(!Object.hasOwn(results,id)){errors.push('missing_result:'+id);continue}
    const score=results[id];
    if(!object(score)||score.status!=='final'
      ||!Number.isSafeInteger(score.away_score)||!Number.isSafeInteger(score.home_score)
      ||score.away_score<0||score.home_score<0
      ||score.away_score>MAX_SCORE||score.home_score>MAX_SCORE){
      errors.push('invalid_or_unconfirmed_final:'+id);continue;
    }
    const tie=score.away_score===score.home_score;
    outcomes.push({id,away,home,away_score:score.away_score,home_score:score.home_score,
      winner:tie?null:score.away_score>score.home_score?'away':'home',tie});
  }
  for(const id of keys(results))if(!ids.has(id))errors.push('unknown_game_result:'+id);
  return errors.length?{ok:false,errors,outcomes:[]}:{ok:true,errors:[],outcomes};
}

function submissionValid(s,seen,errors){
  const id=s?.entry_id;
  if(!valid(id)||seen.has(id)){errors.push('invalid_or_duplicate_entry_id');return false}
  seen.add(id);
  if(!SOURCES.has(s?.source)||!['submitted','locked'].includes(s?.status)||!object(s.payload)){
    errors.push('invalid_submission:'+id);return false;
  }
  return true;
}

// Equal point totals share competition rank; tiebreaks require separate approved rules.
export function previewPickemStandings({games,results,submissions}={}){
  const checked=validateFinalWeek({games,results});
  if(!checked.ok)return {ok:false,errors:checked.errors,rows:[]};
  if(!Array.isArray(submissions))return {ok:false,errors:['invalid_submissions'],rows:[]};
  const seen=new Set(),errors=[],rows=[];
  for(const s of submissions){
    if(!submissionValid(s,seen,errors))continue;
    const picks=s.payload.picks;
    if(!object(picks)||keys(picks).length!==checked.outcomes.length
      ||checked.outcomes.some(g=>!SIDES.has(picks[g.id]))
      ||keys(picks).some(id=>!checked.outcomes.some(g=>g.id===id))){
      errors.push('invalid_picks:'+s.entry_id);continue;
    }
    let correct=0,incorrect=0,tiesBothLose=0;
    for(const result of checked.outcomes){
      if(result.tie){tiesBothLose++;incorrect++}
      else if(picks[result.id]===result.winner)correct++;
      else incorrect++;
    }
    rows.push({entry_id:s.entry_id,correct,incorrect,tiesBothLose,
      total_games:checked.outcomes.length});
  }
  if(errors.length)return {ok:false,errors,rows:[]};
  rows.sort((a,b)=>b.correct-a.correct||a.entry_id.localeCompare(b.entry_id));
  let rank=0,previous=null;
  rows.forEach((row,i)=>{if(row.correct!==previous)rank=i+1;row.rank=rank;previous=row.correct});
  return {ok:true,errors:[],rows};
}

// A tie eliminates both Survivor choices. Prior-use data must come from an
// authorized backend read, not from untrusted browser state.
export function previewSurvivorOutcomes({games,results,submissions,priorTeamsByEntry={}}={}){
  const checked=validateFinalWeek({games,results});
  if(!checked.ok)return {ok:false,errors:checked.errors,rows:[]};
  if(!Array.isArray(submissions)||!object(priorTeamsByEntry))
    return {ok:false,errors:['invalid_inputs'],rows:[]};
  const seen=new Set(),errors=[],rows=[];
  for(const s of submissions){
    if(!submissionValid(s,seen,errors))continue;
    const id=s.entry_id,selected=s.payload.team;
    const earlier=Object.hasOwn(priorTeamsByEntry,id)?priorTeamsByEntry[id]:[];
    if(!Array.isArray(earlier)||!earlier.every(valid)){errors.push('invalid_history:'+id);continue}
    const game=checked.outcomes.find(g=>g.away===selected||g.home===selected);
    if(!game||earlier.includes(selected)){
      errors.push('invalid_or_reused_survivor_team:'+id);continue;
    }
    const winner=game.tie?null:game.winner==='away'?game.away:game.home;
    rows.push({entry_id:id,team:selected,outcome:winner===selected?'advanced':'eliminated',
      tie_elimination:game.tie});
  }
  for(const id of keys(priorTeamsByEntry))if(!seen.has(id))
    errors.push('unknown_history_entry:'+id);
  if(errors.length)return {ok:false,errors,rows:[]};
  rows.sort((a,b)=>a.entry_id.localeCompare(b.entry_id));
  return {ok:true,errors:[],rows};
}
