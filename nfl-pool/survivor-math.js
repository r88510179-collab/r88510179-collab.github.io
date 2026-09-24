const TEAM_ALIASES={JAC:'JAX',WSH:'WAS'};
export const normalizeSurvivorCode=code=>TEAM_ALIASES[String(code||'').toUpperCase()]||String(code||'').toUpperCase();

// Strict NFL score: a nonnegative safe integer, or a string of digits. Number(null)/Number('') must never become 0.
export function survivorScore(value){
  let n;
  if(typeof value==='string'){const v=value.trim();if(!/^\d+$/.test(v))return null;n=Number(v)}
  else if(typeof value==='number')n=value;
  else return null;
  return Number.isSafeInteger(n)&&n>=0?n:null;
}

export const SURVIVOR_TEAM_CODES=new Set(['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS']);
const HALTED_STATUS=/CANCEL|POSTPON|SUSPEND|FORFEIT/i;
const FEED_ISSUES={
  score:'final score missing or invalid in feed',
  status:'final status is contradictory or not a completed game',
  winner:'feed winner flag contradicts the final score',
  ambiguous:'team appears in more than one feed event',
  affected:'opponent appears in more than one feed event',
  malformed:'feed event is malformed',
  context:'feed event is outside the expected season/week'
};
const contextValue=v=>typeof v==='number'?v:typeof v==='string'&&/^\d+$/.test(v.trim())?Number(v.trim()):NaN;
export function survivorContextMismatch(source,{season,week,seasonType=2}={}){
  if(!source||typeof source!=='object')return null;
  const checks=[['season year',source.season?.year,season],['season type',source.season?.type,seasonType],['week',source.week?.number,week]];
  for(const [label,actual,expected] of checks){
    if(actual===undefined||actual===null||expected===undefined||expected===null)continue;
    if(contextValue(actual)!==expected)return `${label} ${String(actual)} (expected ${expected})`;
  }
  return null;
}

// Whole-payload guard: context fields are checked only where the feed exposes them.
export function survivorFeedContextError(payload,{season,week,seasonType=2}={}){
  if(!payload||typeof payload!=='object'||!Array.isArray(payload.events))return `Week ${week} feed returned no event list`;
  if(!payload.events.length)return `Week ${week} feed returned no games`;
  const mismatch=survivorContextMismatch(payload,{season,week,seasonType});
  return mismatch?`Week ${week} feed context mismatch: ${mismatch}`:null;
}

// A status name, where the feed provides one, must name a final (e.g. STATUS_FINAL, STATUS_FINAL_OVERTIME) and must not
// name a halted game; unnamed finals are judged by completed/state alone.
const nonFinalName=name=>name!==undefined&&name!==null&&(typeof name!=='string'||!/FINAL/i.test(name)||HALTED_STATUS.test(name));
function finalStatusIssue(event,competition){
  const type=event?.status?.type||{},comp=competition?.status?.type;
  if(type.state!=='post'||nonFinalName(type.name))return 'status';
  if(comp&&(comp.completed===false||(typeof comp.state==='string'&&comp.state!=='post')||nonFinalName(comp.name)))return 'status';
  return null;
}

// Builds team -> result for one NFL week. Anything that cannot be proven stays unresolved (never a tie, winner or loss).
export function survivorBuildResults(events,context={}){
  if(!Number.isInteger(context?.season)||!Number.isInteger(context?.week))throw new Error('Survivor results require an integer season and week');
  const records=[],appearances=new Map();
  for(const event of Array.isArray(events)?events:[]){
    const competitions=Array.isArray(event?.competitions)?event.competitions:[],c=competitions[0],competitors=Array.isArray(c?.competitors)?c.competitors:[];
    const codes=competitors.map(x=>normalizeSurvivorCode(x?.team?.abbreviation)).filter(Boolean);
    for(const code of codes)appearances.set(code,(appearances.get(code)||0)+1);
    const aways=competitors.filter(x=>x?.homeAway==='away'),homes=competitors.filter(x=>x?.homeAway==='home');
    const away=aways.length===1?aways[0]:null,home=homes.length===1?homes[0]:null;
    const a=normalizeSurvivorCode(away?.team?.abbreviation),h=normalizeSurvivorCode(home?.team?.abbreviation);
    const type=event?.status?.type||{},state=typeof type.state==='string'?type.state:'pre',done=type.completed===true;
    const as=survivorScore(away?.score),hs=survivorScore(home?.score);
    let issue=null;
    if(competitions.length!==1||competitors.length!==2||!away||!home||!SURVIVOR_TEAM_CODES.has(a)||!SURVIVOR_TEAM_CODES.has(h)||a===h)issue='malformed';
    else if(survivorContextMismatch(event,context))issue='context';
    else if(done)issue=finalStatusIssue(event,c)||(as===null||hs===null?'score':null)||
      ((away.winner===true&&!(as>hs))||(home.winner===true&&!(hs>as))?'winner':null);
    records.push({teams:[...new Set(codes)],a,h,state,done,issue,as,hs});
  }
  const ambiguous=team=>(appearances.get(team)||0)>1;
  const map=new Map(),unresolved=(team,opponent,state,issue)=>{if(team&&(!map.has(team)||!map.get(team).unresolved||issue==='ambiguous'))map.set(team,{completed:false,state,winner:null,tie:false,opponent:opponent||null,unresolved:true,issue})};
  for(const r of records){
    if(r.issue==='malformed'||r.issue==='context'){for(const team of r.teams)unresolved(team,null,r.state,ambiguous(team)?'ambiguous':r.issue);continue}
    if(ambiguous(r.a)||ambiguous(r.h)){
      unresolved(r.a,r.h,r.state,ambiguous(r.a)?'ambiguous':'affected');unresolved(r.h,r.a,r.state,ambiguous(r.h)?'ambiguous':'affected');continue;
    }
    if(r.issue){unresolved(r.a,r.h,r.state,r.issue);unresolved(r.h,r.a,r.state,r.issue);continue}
    const tie=r.done&&r.as===r.hs,winner=r.done&&!tie?(r.as>r.hs?r.a:r.h):null;
    map.set(r.a,{completed:r.done,state:r.state,winner,tie,opponent:r.h});map.set(r.h,{completed:r.done,state:r.state,winner,tie,opponent:r.a});
  }
  return map;
}

export function survivorResultIssue(result){return result?.unresolved?(FEED_ISSUES[result.issue]||'feed data could not be verified'):null}

function weekResults(resultsByWeek,weekIndex){
  if(Array.isArray(resultsByWeek))return resultsByWeek[weekIndex]||null;
  if(resultsByWeek instanceof Map&&resultsByWeek.has(weekIndex))return resultsByWeek.get(weekIndex)||null;
  return weekIndex===0?(resultsByWeek||null):null;
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
    const results=weekResults(resultsByWeek,i);
    if(!results)return{status:'pending',pick,week,reason:`Week ${week} result unavailable`,type:'unresolved'};
    const result=teamResult(results,pick);
    if(!result)return{status:'pending',pick,week,reason:`${pick} not present in verified Week ${week} feed/schedule`,type:'absent'};
    if(result.unresolved)return{status:'pending',pick,week,reason:`Week ${week} ${pick} result unavailable: ${survivorResultIssue(result)}`,type:'unresolved'};
    if(result.completed!==true)return{status:result.state==='in'?'live':'pending',pick,week,reason:result.state==='in'?`Week ${week} game live`:`Week ${week} game pending`,type:'pending'};
    const unverified={status:'pending',pick,week,reason:`Week ${week} ${pick} result unavailable: final result has no verified winner`,type:'unresolved'};
    if(result.tie===true)return result.winner?unverified:{status:'out',pick,week,eliminatedWeek:week,reason:`NFL tie eliminated entry in Week ${week}`,type:'tie'};
    if(typeof result.winner!=='string'||!result.winner||(result.opponent&&result.winner!==pick&&result.winner!==result.opponent))return unverified;
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

// Entries whose status entering weekIndex cannot be decided yet (an earlier result is pending, live or unverified).
export function survivorUnresolvedEntering(entries,weekIndex,resultsByWeek){
  if(weekIndex<=0)return 0;
  return (entries||[]).filter(e=>['pending','live'].includes(survivorEntryState(e,weekIndex-1,resultsByWeek).status)).length;
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
