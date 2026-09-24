import {normalizeSurvivorCode,survivorFeedContextError,survivorContextMismatch,survivorBuildResults,survivorEntryState} from '../survivor-math.js?v=4';
import {SURVIVOR_NFL_TEAMS,validateSurvivorConfig} from './survivor-parser.js?v=2';

const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
const entriesOf=config=>[...(config?.trackedEntries||[]),...(config?.fieldEntries||[])];
const entryLabel=entry=>entry?.displayName||entry?.id||'entry';
const payloadFor=(payloadByWeek,week)=>payloadByWeek instanceof Map?payloadByWeek.get(week):Array.isArray(payloadByWeek)?payloadByWeek[week-1]:payloadByWeek?.[week];

// One NFL regular-season week from the score feed: every game must be two distinct NFL teams and every team may appear once.
export function survivorScheduleWeek(payload,{season,week}){
  const errors=[],games=[],appearances=new Map();
  const contextError=survivorFeedContextError(payload,{season,week});
  if(contextError&&!Array.isArray(payload?.events))return{week,games,teams:new Set(),errors:[contextError]};
  if(contextError)errors.push(contextError);
  for(const event of payload?.events||[]){
    const competitors=event?.competitions?.[0]?.competitors,list=Array.isArray(competitors)?competitors:[];
    const aways=list.filter(x=>x?.homeAway==='away'),homes=list.filter(x=>x?.homeAway==='home');
    const away=normalizeSurvivorCode(aways[0]?.team?.abbreviation),home=normalizeSurvivorCode(homes[0]?.team?.abbreviation);
    for(const code of list.map(x=>normalizeSurvivorCode(x?.team?.abbreviation)).filter(Boolean))appearances.set(code,(appearances.get(code)||0)+1);
    if(list.length!==2||aways.length!==1||homes.length!==1||!SURVIVOR_NFL_TEAMS.has(away)||!SURVIVOR_NFL_TEAMS.has(home)||away===home){
      errors.push(`NFL Week ${week} feed has a malformed game${event?.id?` (event ${event.id})`:''}`);continue;
    }
    const eventContext=survivorContextMismatch(event,{season,week});
    if(eventContext){errors.push(`NFL Week ${week} game ${away} at ${home} is outside the expected context: ${eventContext}`);continue}
    games.push({away,home,state:typeof event?.status?.type?.state==='string'?event.status.type.state:null});
  }
  for(const [team,count] of appearances)if(count>1)errors.push(`NFL Week ${week} schedule lists ${team} in ${count} games; schedule is ambiguous`);
  const teams=new Set(games.flatMap(g=>[g.away,g.home]));
  return{week,games,teams,errors:[...new Set(errors)]};
}

// Every non-null pick in Week i must be a team scheduled in verified NFL Week i (current week and history).
export const NFL_REGULAR_SEASON_WEEKS=18;
const exposesContext=payload=>payload?.season?.year!=null&&payload?.season?.type!=null&&payload?.week?.number!=null;

export function verifySurvivorSchedule(config,payloadByWeek){
  const errors=[],weeks=[],resultsByWeek=[],contextUnexposed=[];
  if(!config||!Number.isInteger(config.week)||config.week<1)return{ok:false,errors:['Survivor week is missing'],weeks,resultsByWeek,contextUnexposed};
  if(config.week>NFL_REGULAR_SEASON_WEEKS)return{ok:false,errors:[`Survivor Week ${config.week} is outside the NFL regular season (Weeks 1–${NFL_REGULAR_SEASON_WEEKS}); only regular-season schedules can be verified`],weeks,resultsByWeek,contextUnexposed};
  const entries=entriesOf(config);
  for(let week=1;week<=config.week;week++){
    const payload=payloadFor(payloadByWeek,week);
    if(!payload){errors.push(`NFL Week ${week} schedule could not be loaded`);continue}
    const schedule=survivorScheduleWeek(payload,{season:config.season,week});
    weeks.push(schedule);errors.push(...schedule.errors);
    if(!exposesContext(payload))contextUnexposed.push(week);
    if(schedule.errors.length)continue;
    resultsByWeek[week-1]=survivorBuildResults(payload.events,{season:config.season,week});
    const offSchedule=new Map();
    for(const entry of entries){
      const pick=entry?.picks?.[week-1];
      if(!pick||schedule.teams.has(pick))continue;
      if(!offSchedule.has(pick))offSchedule.set(pick,[]);
      offSchedule.get(pick).push(entryLabel(entry));
    }
    for(const [team,labels] of offSchedule){
      const shown=labels.slice(0,8).join(', ')+(labels.length>8?`, +${labels.length-8} more`:'');
      errors.push(`Week ${week}: ${team} is not scheduled in verified NFL Week ${week} (bye or invalid team) — ${plural(labels.length,'entry','entries')}: ${shown}. Check the sheet's Week ${week} column for ${team}.`);
    }
  }
  return{ok:errors.length===0,errors:[...new Set(errors)],weeks,resultsByWeek,contextUnexposed};
}

const weekSpan=(a,b)=>a===b?`Week ${a}`:`Weeks ${a}–${b}`;
const listWeeks=ws=>ws.length===1?`Week ${ws[0]}`:`Weeks ${ws.join(', ')}`;
function historyKey(picks,weeks){return JSON.stringify((picks||[]).slice(0,weeks).map(x=>x||null))}
function unmatchedHistories(config,published,weeks){
  const count=new Map();
  for(const entry of entriesOf(published)){const key=historyKey(entry.picks,weeks);count.set(key,(count.get(key)||0)+1)}
  let unmatched=0;
  for(const entry of entriesOf(config)){const key=historyKey(entry.picks,weeks),left=count.get(key)||0;if(left>0)count.set(key,left-1);else unmatched++}
  return unmatched;
}
function compareToPublished(config,published,weeks,label){
  const issues=[];
  if(published.competitionSize!==config.competitionSize)issues.push(`This sheet has ${config.competitionSize} entries but ${label} has ${published.competitionSize}.`);
  for(const tracked of config.trackedEntries||[]){
    const prior=(published.trackedEntries||[]).find(x=>x.id===tracked.id);
    if(!prior||historyKey(prior.picks,weeks)!==historyKey(tracked.picks,weeks))issues.push(`${tracked.displayName}'s ${weekSpan(1,weeks)} history differs from ${label}.`);
  }
  const differing=unmatchedHistories(config,published,weeks);
  if(differing)issues.push(`${plural(differing,'pick history','pick histories')} for ${weekSpan(1,weeks)} ${differing===1?'differs':'differ'} from ${label}.`);
  return issues;
}
// Week-W picks present in a published revision whose entries (grouped by Weeks 1..W-1 history) are blank in this sheet.
function removedCurrentPicks(config,published,week){
  const groups=new Map(),bump=(entry,side)=>{const key=historyKey(entry.picks,week-1),g=groups.get(key)||{published:0,sheet:0};if(entry.picks?.[week-1])g[side]++;groups.set(key,g)};
  for(const entry of entriesOf(published))bump(entry,'published');
  for(const entry of entriesOf(config))bump(entry,'sheet');
  let removed=0;for(const g of groups.values())removed+=Math.max(0,g.published-g.sheet);
  return removed;
}
function eliminationLabel(state){
  if(state.type==='loss')return `${state.pick}'s Week ${state.eliminatedWeek} loss`;
  if(state.type==='tie')return `${state.pick}'s Week ${state.eliminatedWeek} tie`;
  if(state.type==='repeat')return `repeating ${state.pick} in Week ${state.eliminatedWeek}`;
  return `no Week ${state.eliminatedWeek} pick`;
}

// Partial/premature-sheet guard. It never changes Survivor rules: it decides whether publication is blocked, or needs the
// admin's explicit confirmation that the sheet is the final submission set before blanks become no-pick eliminations.
export function survivorPublishGuard(config,{resultsByWeek=[],currentGames=null,published=null,detachedRows=[],contextUnexposed=[]}={}){
  const W=config.week,entries=entriesOf(config),facts=[],reasons=[],blocking=[];
  if(!published||published.checked!==true)blocking.push('Published Survivor weeks for this season have not been checked. Sign in; the comparison runs automatically.');
  const rows=(published?.rows||[]).filter(r=>r&&r.season===config.season&&Number.isInteger(r.week));
  const locked=rows.filter(r=>r.status==='locked').sort((a,b)=>a.week-b.week);
  const prior=locked.filter(r=>r.week<W).pop()||null,P=prior?prior.week:0,existing=rows.find(r=>r.week===W)||null;
  if(published?.checked===true)facts.push(locked.length?`Published Survivor weeks visible for ${config.season}: ${locked.map(r=>r.week).join(', ')}.`:`No published Survivor weeks are visible for ${config.season}.`);
  if(contextUnexposed.length)facts.push(`The NFL feed did not identify its season/week for ${listWeeks(contextUnexposed)}; those games were matched by team structure only.`);

  const games=Array.isArray(currentGames)?currentGames:null,notStarted=games?games.filter(g=>g.state==='pre').length:null,unknownState=games?games.filter(g=>!['pre','in','post'].includes(g.state)).length:null;
  const kickoffNote=!games?` Kickoff status for Week ${W} could not be confirmed.`:notStarted?` ${notStarted} of ${games.length} Week ${W} games have not kicked off yet, so this export may be premature.`:unknownState?` Kickoff status for ${unknownState} Week ${W} game${unknownState===1?' is':'s are'} unknown.`:'';
  // No-pick eliminations this publication creates, for every week not already covered by a published week.
  let noPickOuts=0,maybeNoPickOuts=0,aliveEntering=0,picksAlive=0,missingAlive=0,unresolvedEntering=0,missingUnresolved=0;
  for(let w=Math.max(1,P+1);w<=W;w++){
    let alive=0,missing=0,pending=0,pendingMissing=0,notFinal=0;const names=[];
    for(const entry of entries){
      const pick=entry?.picks?.[w-1]||null,state=w===1?{status:'alive'}:survivorEntryState(entry,w-2,resultsByWeek);
      if(state.status==='alive'){alive++;if(!pick){missing++;if(entry.displayName)names.push(entry.displayName)}}
      else if(state.status==='pending'||state.status==='live'){pending++;if(!pick){pendingMissing++;if(state.type==='pending')notFinal++}}
    }
    noPickOuts+=missing;maybeNoPickOuts+=pendingMissing;
    if(w===W){aliveEntering=alive;picksAlive=alive-missing;missingAlive=missing;unresolvedEntering=pending;missingUnresolved=pendingMissing}
    const who=names.length?` (including ${names.join(', ')})`:'';
    if(missing)reasons.push(w===W
      ?`${missing} of ${alive} entries alive entering Week ${W} ${missing===1?'has':'have'} no Week ${W} pick${who}. Publishing shows ${missing===1?'it':'them'} OUT (no pick) in Week ${W}.${kickoffNote}`
      :`${missing} of ${alive} entries alive entering Week ${w} ${missing===1?'has':'have'} no Week ${w} pick${who}, and Week ${w} has never been published. Publishing shows ${missing===1?'it':'them'} OUT (no pick) in Week ${w}.`);
    if(pendingMissing)reasons.push(`${plural(pendingMissing,'entry','entries')} with no Week ${w} pick cannot yet be proven alive or out (${notFinal===pendingMissing?'an earlier result is not final yet':notFinal?'earlier results are not final or not verifiable':'an earlier result is not verifiable in the feed'}); ${pendingMissing===1?'it':'they'} will show OUT (no pick) in Week ${w} if ${pendingMissing===1?'it survives':'they survive'}.`);
  }
  facts.unshift(W===1?`${aliveEntering} entries enter Week 1; ${picksAlive} have a Week 1 pick.`:`${aliveEntering} entries are proven alive entering Week ${W} from verified ${weekSpan(1,W-1)} NFL results; ${picksAlive} of them have a Week ${W} pick.`);
  if(unresolvedEntering&&!missingUnresolved)facts.push(`${plural(unresolvedEntering,'entry is','entries are')} not yet proven alive or out entering Week ${W}; all of them have a Week ${W} pick.`);
  if(games)facts.push(`${games.length-notStarted-unknownState} of ${games.length} NFL Week ${W} games have kicked off${unknownState?` (${unknownState} with unknown status)`:''}.`);

  const byElimination=new Map();
  for(const entry of entries){
    if(!entry?.picks?.[W-1]||W===1)continue;
    const state=survivorEntryState(entry,W-2,resultsByWeek);
    if(state.status!=='out')continue;
    const label=eliminationLabel(state);byElimination.set(label,(byElimination.get(label)||0)+1);
  }
  const picksFromEliminated=[...byElimination.values()].reduce((a,b)=>a+b,0);
  if(picksFromEliminated){
    const groups=[...byElimination].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])),shown=groups.slice(0,4).map(([label,n])=>`${n} OUT by ${label}`).join('; ')+(groups.length>4?`; +${groups.length-4} more groups`:'');
    reasons.push(`${plural(picksFromEliminated,'entry','entries')} already eliminated before Week ${W} still ${picksFromEliminated===1?'shows':'show'} a Week ${W} pick (${shown}). The sheet may disagree with the NFL results; Survivor rules still treat ${picksFromEliminated===1?'it':'them'} as OUT.`);
  }

  if(published?.checked===true&&W>1){
    if(!prior)reasons.push(`No published Survivor week before Week ${W} exists to compare this sheet against.`);
    else{
      if(P<W-1)reasons.push(`Survivor ${weekSpan(P+1,W-1)} ${P+1===W-1?'has':'have'} never been published; this sheet becomes the first published record of ${P+1===W-1?'that week':'those weeks'}.`);
      const cfg=prior.config,errs=validateSurvivorConfig(cfg);
      if(errs.length||cfg.season!==config.season||cfg.week!==P)reasons.push(`Published Survivor Week ${P} could not be validated for comparison.`);
      else{const label=`published Week ${P} (revision ${prior.revision})`,issues=compareToPublished(config,cfg,P,label);if(issues.length)reasons.push(...issues);else facts.push(`Entry count and ${weekSpan(1,P)} pick histories match ${label}.`)}
    }
  }
  if(existing){
    const cfg=existing.config,label=`published Week ${W} revision ${existing.revision}`;
    if(!cfg||validateSurvivorConfig(cfg).length||cfg.season!==config.season||cfg.week!==W)reasons.push(`Published Week ${W} revision ${existing.revision} could not be validated for comparison.`);
    else{
      const issues=compareToPublished(config,cfg,W,label),removed=removedCurrentPicks(config,cfg,W);
      if(removed)issues.push(`${plural(removed,`Week ${W} pick`,`Week ${W} picks`)} in ${label} ${removed===1?'is':'are'} blank in this sheet.`);
      if(cfg.currentWeekEntryCount>config.currentWeekEntryCount)issues.push(`${label[0].toUpperCase()+label.slice(1)} has ${cfg.currentWeekEntryCount} Week ${W} picks; this sheet has only ${config.currentWeekEntryCount}.`);
      if(issues.length)reasons.push(`This replaces ${label}:`,...issues);else facts.push(`This sheet is identical to ${label} (entries and ${weekSpan(1,W)} pick histories).`);
    }
  }
  const later=locked.filter(r=>r.week>W).map(r=>r.week);
  if(later.length)reasons.push(`Published Survivor ${listWeeks(later)} already ${later.length===1?'exists; it keeps its own history and is':'exist; they keep their own histories and are'} not changed by this publication.`);
  if(detachedRows?.length){
    const shown=detachedRows.slice(0,6).map(r=>`"${r.label}"${r.page!=null?` (page ${r.page})`:''}`).join(', ')+(detachedRows.length>6?`, +${detachedRows.length-6} more`:'');
    reasons.push(`${plural(detachedRows.length,'row without picks was','rows without picks were')} physically separated from the participant table and ${detachedRows.length===1?'was':'were'} NOT counted as ${detachedRows.length===1?'an entrant':'entrants'}: ${shown}. If any is a real entrant, do not publish.`);
  }
  const replacing=existing?` and replaces published Week ${W} revision ${existing.revision}`:'',separated=detachedRows?.length?` The ${plural(detachedRows.length,'separated row','separated rows')} listed above ${detachedRows.length===1?'is not an entrant':'are not entrants'}.`:'';
  const confirmText=noPickOuts||maybeNoPickOuts
    ?`I confirm this sheet is the final Week ${W} pick list — no more Week ${W} picks will be added. Publishing shows ${plural(noPickOuts,'entry','entries')} OUT for no pick${maybeNoPickOuts?` (up to ${noPickOuts+maybeNoPickOuts} once earlier results are final)`:''}${replacing}.${separated}`
    :`I reviewed every item listed above and confirm this sheet should be published as Survivor Week ${W}${existing?`, replacing revision ${existing.revision}`:''}.${separated}`;
  return{week:W,priorWeek:P,aliveEntering,picksAlive,missingAlive,unresolvedEntering,missingUnresolved,noPickOuts,maybeNoPickOuts,picksFromEliminated,notStarted,facts,reasons,blocking,requiresConfirmation:reasons.length>0,confirmText};
}
