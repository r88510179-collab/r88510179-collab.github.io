const TEAM_ALIASES={JAC:'JAX',WSH:'WAS'};
export const normalizeSurvivorCode=code=>TEAM_ALIASES[String(code||'').toUpperCase()]||String(code||'').toUpperCase();

export function survivorPickDistribution(entries,weekIndex){
  const counts=new Map(),eligible=(entries||[]).filter(e=>e?.picks?.[weekIndex]);
  for(const entry of eligible){const team=entry.picks[weekIndex];counts.set(team,(counts.get(team)||0)+1)}
  return[...counts].map(([team,count])=>({team,count,denominator:eligible.length,pct:eligible.length?Math.round(count/eligible.length*100):0}))
    .sort((a,b)=>b.count-a.count||a.team.localeCompare(b.team));
}

export function survivorEntryState(entry,weekIndex,resultByTeam){
  const pick=entry?.picks?.[weekIndex]||null;
  if(!pick)return{status:'out',pick:null,reason:'No pick for this week'};
  const result=resultByTeam instanceof Map?resultByTeam.get(pick):resultByTeam?.[pick];
  if(!result)return{status:'pending',pick,reason:'Game not found'};
  if(!result.completed)return{status:result.state==='in'?'live':'pending',pick,reason:result.state==='in'?'Game live':'Game pending'};
  if(result.tie)return{status:'out',pick,reason:'NFL tie eliminates the entry'};
  return result.winner===pick?{status:'alive',pick,reason:'Pick won'}:{status:'out',pick,reason:'Pick lost'};
}

export function survivorSummary(entries,weekIndex,resultByTeam){
  const all=entries||[],entered=all.filter(e=>e?.picks?.[weekIndex]).length;
  const states=all.map(e=>survivorEntryState(e,weekIndex,resultByTeam));
  const active=states.filter(s=>['alive','pending','live'].includes(s.status)).length;
  const eliminatedBefore=all.length-entered;
  const eliminatedThisWeek=states.filter((s,i)=>all[i]?.picks?.[weekIndex]&&s.status==='out').length;
  const pending=states.filter(s=>s.status==='pending'||s.status==='live').length;
  return{poolSize:all.length,entered,active,eliminatedBefore,eliminatedThisWeek,pending};
}
