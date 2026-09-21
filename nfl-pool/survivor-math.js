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

export function survivorCurrentPickIsLegal(entry,weekIndex){
  const pick=entry?.picks?.[weekIndex]||null;if(!pick)return false;
  return !(entry.picks||[]).slice(0,weekIndex).includes(pick);
}

export function survivorPickDistribution(entries,weekIndex,resultsByWeek){
  const eligible=(entries||[]).filter(e=>survivorEligibleEntering(e,weekIndex,resultsByWeek)&&survivorCurrentPickIsLegal(e,weekIndex));
  const counts=new Map();
  for(const entry of eligible){const team=entry.picks[weekIndex];counts.set(team,(counts.get(team)||0)+1)}
  return[...counts].map(([team,count])=>({team,count,denominator:eligible.length,pct:eligible.length?Math.round(count/eligible.length*100):0}))
    .sort((a,b)=>b.count-a.count||a.team.localeCompare(b.team));
}

export function survivorSummary(entries,weekIndex,resultsByWeek){
  const all=entries||[],states=all.map(e=>survivorEntryState(e,weekIndex,resultsByWeek));
  const eligibleEntering=all.filter(e=>survivorEligibleEntering(e,weekIndex,resultsByWeek)).length;
  const submitted=all.filter(e=>survivorEligibleEntering(e,weekIndex,resultsByWeek)&&e?.picks?.[weekIndex]).length;
  const entered=all.filter(e=>survivorEligibleEntering(e,weekIndex,resultsByWeek)&&survivorCurrentPickIsLegal(e,weekIndex)).length;
  const active=states.filter(s=>['alive','pending','live'].includes(s.status)).length;
  const eliminatedBefore=states.filter(s=>s.status==='out'&&s.eliminatedWeek<weekIndex+1).length;
  const eliminatedThisWeek=states.filter(s=>s.status==='out'&&s.eliminatedWeek===weekIndex+1).length;
  const pending=states.filter(s=>s.status==='pending'||s.status==='live').length;
  return{poolSize:all.length,eligibleEntering,submitted,entered,active,eliminatedBefore,eliminatedThisWeek,pending};
}

export function survivorWeekProgress(entries,currentWeekIndex,resultsByWeek){
  const all=entries||[],rows=[];
  for(let i=0;i<=currentWeekIndex;i++){
    const eligibleEntering=all.filter(e=>survivorEligibleEntering(e,i,resultsByWeek)).length;
    const submitted=all.filter(e=>survivorEligibleEntering(e,i,resultsByWeek)&&e?.picks?.[i]).length;
    const entered=all.filter(e=>survivorEligibleEntering(e,i,resultsByWeek)&&survivorCurrentPickIsLegal(e,i)).length;
    const states=all.map(e=>survivorEntryState(e,i,resultsByWeek));
    const remaining=states.filter(s=>['alive','pending','live'].includes(s.status)).length;
    const eliminated=states.filter(s=>s.status==='out'&&s.eliminatedWeek===i+1).length;
    rows.push({week:i+1,eligibleEntering,submitted,entered,remaining,eliminated});
  }
  return rows;
}


export function survivorFieldAvailability(entries,nextWeekIndex,resultsByWeek,teams){
  const alive=(entries||[]).filter(e=>survivorEligibleEntering(e,nextWeekIndex,resultsByWeek));
  const unique=[...new Set((teams||[]).filter(Boolean))];
  return unique.map(team=>{
    const available=alive.filter(e=>!(e?.picks||[]).slice(0,nextWeekIndex).includes(team)).length;
    return{team,available,denominator:alive.length,pct:alive.length?Math.round(available/alive.length*100):0};
  }).sort((a,b)=>a.team.localeCompare(b.team));
}

export function survivorDecisionOptions(entry,nextWeekIndex,resultsByWeek,matchups,availabilityRows=[]){
  const prior=nextWeekIndex<=0?{status:'alive'}:survivorEntryState(entry,nextWeekIndex-1,resultsByWeek);
  const burned=[...new Set((entry?.picks||[]).slice(0,nextWeekIndex).filter(Boolean))];
  if(prior.status!=='alive')return{eligible:false,reason:prior.reason||'Entry is not alive',burned,options:[]};
  const availability=new Map((availabilityRows||[]).map(x=>[x.team,x]));
  const appearances=new Map();
  for(const matchup of matchups||[])for(const team of [matchup?.away,matchup?.home])if(team)appearances.set(team,(appearances.get(team)||0)+1);
  const options=[];
  for(const matchup of matchups||[]){
    const away=matchup?.away,home=matchup?.home;
    if(!away||!home||appearances.get(away)!==1||appearances.get(home)!==1)continue;
    for(const side of ['away','home']){
      const team=matchup[side],opponent=matchup[side==='away'?'home':'away'];
      if(burned.includes(team))continue;
      const field=availability.get(team)||{available:0,denominator:0,pct:0};
      options.push({
        team,opponent,home:side==='home',date:matchup.date||null,
        favorite:matchup.favorite===team,
        spread:matchup.favorite===team&&Number.isFinite(matchup.spread)?Math.abs(matchup.spread):null,
        fieldAvailable:field.available,fieldDenominator:field.denominator,fieldAvailablePct:field.pct
      });
    }
  }
  return{eligible:true,reason:null,burned,options};
}


export function survivorMarketMatchups(events){
  const out=[];
  for(const event of events||[]){
    const c=event?.competitions?.[0],away=c?.competitors?.find(x=>x.homeAway==='away'),home=c?.competitors?.find(x=>x.homeAway==='home');
    if(!away||!home)continue;
    const a=normalizeSurvivorCode(away.team?.abbreviation),h=normalizeSurvivorCode(home.team?.abbreviation);
    if(!a||!h)continue;
    const odds=c?.odds?.[0]||{},details=String(odds?.details||'').trim();
    const awayFavorite=odds?.awayTeamOdds?.favorite===true,homeFavorite=odds?.homeTeamOdds?.favorite===true;
    const explicitConflict=awayFavorite&&homeFavorite;
    let favorite=awayFavorite!==homeFavorite?(awayFavorite?a:h):null,spread=null;
    const fallback=details.match(/^([A-Za-z]{2,3})\s+(-\d+(?:\.\d+)?)(?:\s|$)/);
    if(!favorite&&!explicitConflict&&fallback){
      const code=normalizeSurvivorCode(fallback[1]);
      if(code===a||code===h){favorite=code;spread=Math.abs(Number(fallback[2]))}
    }
    if(favorite&&spread===null){
      const explicitSpread=Math.abs(Number(odds?.spread));
      if(Number.isFinite(explicitSpread)&&explicitSpread>0)spread=explicitSpread;
      else if(fallback&&normalizeSurvivorCode(fallback[1])===favorite){
        const detailSpread=Math.abs(Number(fallback[2]));
        if(Number.isFinite(detailSpread)&&detailSpread>0)spread=detailSpread;
      }
    }
    out.push({away:a,home:h,date:event?.date||c?.date||null,favorite,spread});
  }
  return out;
}
