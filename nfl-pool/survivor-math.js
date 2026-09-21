const TEAM_ALIASES={JAC:'JAX',WSH:'WAS'};
export const normalizeSurvivorCode=code=>TEAM_ALIASES[String(code||'').toUpperCase()]||String(code||'').toUpperCase();

function weekResults(resultsByWeek,weekIndex){
  if(Array.isArray(resultsByWeek))return resultsByWeek[weekIndex]||new Map();
  if(resultsByWeek instanceof Map&&resultsByWeek.has(weekIndex))return resultsByWeek.get(weekIndex)||new Map();
  return weekIndex===0?(resultsByWeek||new Map()):new Map();
}
function teamResult(results,pick){
  return results instanceof Map?results.get(pick):results?.[pick];
}

export function survivorEntryState(entry,weekIndex,resultsByWeek){
  const picks=entry?.picks||[],used=new Set();
  for(let i=0;i<=weekIndex;i++){
    const pick=picks[i]||null,week=i+1;
    if(!pick)return{status:'out',pick:null,week,eliminatedWeek:week,reason:`No pick in Week ${week}`,type:'no-pick'};
    if(used.has(pick))return{status:'out',pick,week,eliminatedWeek:week,reason:`Repeated ${pick} in Week ${week}`,type:'repeat'};
    used.add(pick);
    const result=teamResult(weekResults(resultsByWeek,i),pick);
    if(!result)return{status:'pending',pick,week,reason:`Week ${week} result unavailable`,type:'unresolved'};
    if(!result.completed)return{status:result.state==='in'?'live':'pending',pick,week,reason:result.state==='in'?`Week ${week} game live`:`Week ${week} game pending`,type:'pending'};
    if(result.tie)return{status:'out',pick,week,eliminatedWeek:week,reason:`NFL tie eliminated entry in Week ${week}`,type:'tie'};
    if(result.winner!==pick)return{status:'out',pick,week,eliminatedWeek:week,reason:`${pick} lost in Week ${week}`,type:'loss'};
  }
  const pick=picks[weekIndex]||null;
  return{status:'alive',pick,week:weekIndex+1,reason:`Alive through Week ${weekIndex+1}`,type:'win'};
}

export function survivorEligibleEntering(entry,weekIndex,resultsByWeek){
  if(weekIndex<=0)return true;
  const prior=survivorEntryState(entry,weekIndex-1,resultsByWeek);
  return prior.status==='alive';
}

export function survivorPickDistribution(entries,weekIndex,resultsByWeek){
  const eligible=(entries||[]).filter(e=>survivorEligibleEntering(e,weekIndex,resultsByWeek)&&e?.picks?.[weekIndex]);
  const counts=new Map();
  for(const entry of eligible){const team=entry.picks[weekIndex];counts.set(team,(counts.get(team)||0)+1)}
  return[...counts].map(([team,count])=>({team,count,denominator:eligible.length,pct:eligible.length?Math.round(count/eligible.length*100):0}))
    .sort((a,b)=>b.count-a.count||a.team.localeCompare(b.team));
}

export function survivorSummary(entries,weekIndex,resultsByWeek){
  const all=entries||[],states=all.map(e=>survivorEntryState(e,weekIndex,resultsByWeek));
  const eligibleEntering=all.filter(e=>survivorEligibleEntering(e,weekIndex,resultsByWeek)).length;
  const entered=all.filter(e=>survivorEligibleEntering(e,weekIndex,resultsByWeek)&&e?.picks?.[weekIndex]).length;
  const active=states.filter(s=>['alive','pending','live'].includes(s.status)).length;
  const eliminatedBefore=states.filter(s=>s.status==='out'&&s.eliminatedWeek<weekIndex+1).length;
  const eliminatedThisWeek=states.filter(s=>s.status==='out'&&s.eliminatedWeek===weekIndex+1).length;
  const pending=states.filter(s=>s.status==='pending'||s.status==='live').length;
  return{poolSize:all.length,eligibleEntering,entered,active,eliminatedBefore,eliminatedThisWeek,pending};
}

export function survivorWeekProgress(entries,currentWeekIndex,resultsByWeek){
  const all=entries||[],rows=[];
  for(let i=0;i<=currentWeekIndex;i++){
    const eligibleEntering=all.filter(e=>survivorEligibleEntering(e,i,resultsByWeek)).length;
    const entered=all.filter(e=>survivorEligibleEntering(e,i,resultsByWeek)&&e?.picks?.[i]).length;
    const states=all.map(e=>survivorEntryState(e,i,resultsByWeek));
    const remaining=states.filter(s=>['alive','pending','live'].includes(s.status)).length;
    const eliminated=states.filter(s=>s.status==='out'&&s.eliminatedWeek===i+1).length;
    rows.push({week:i+1,eligibleEntering,entered,remaining,eliminated});
  }
  return rows;
}
