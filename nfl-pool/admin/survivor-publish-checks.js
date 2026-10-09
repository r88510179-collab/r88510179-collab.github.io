import {normalizeSurvivorCode,survivorFeedContextError,survivorContextMismatch,survivorBuildResults,survivorEntryState} from '../survivor-math.js?v=4';
import {SURVIVOR_NFL_TEAMS,validateSurvivorConfig} from './survivor-parser.js?v=3';

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

// HDC-14: a picked game the NFL feed no longer lists in its week. The only proof of its matchup is the locked Pick'em slate
// of the same season and week (never another week, a makeup listing, the feed or anything typed): the team in exactly one
// slate game, no other slate game of either team, the slate's eventId (if any) an event id, and neither team listed in the
// week's feed. Even then the sheet publishes only with the exact typed confirmation WEEK N AWAY @ HOME ABSENT, and the
// snapshot records the exception; nothing is decided for the picks, which stay pending until a ruling is recorded. A bye,
// a matchup the slate cannot prove (the Thursday game a sheet may omit) or a re-paired opponent still blocks.
export const SURVIVOR_ABSENT_EXCEPTION='absent-from-week-feed';
export const survivorAbsencePhrase=(week,away,home)=>`WEEK ${week} ${away} @ ${home} ABSENT`;
const SLATE_ALIASES={JAC:'JAX',WSH:'WAS'};
const slateCode=code=>typeof code==='string'?(SLATE_ALIASES[code]||code):null;
function slateMatchup(pickemSlates,{season,week,team,listed}){
  const rows=(Array.isArray(pickemSlates)?pickemSlates:[]).filter(r=>r&&r.season===season&&r.week===week);
  if(rows.length!==1)return null;
  const row=rows[0],cfg=row.config;
  if(row.status!=='locked'||!cfg||typeof cfg!=='object'||cfg.season!==season||cfg.week!==week||!Array.isArray(cfg.games))return null;
  const games=[];
  for(const g of cfg.games){
    const away=slateCode(g?.away),home=slateCode(g?.home);
    if(!SURVIVOR_NFL_TEAMS.has(away)||!SURVIVOR_NFL_TEAMS.has(home)||away===home)return null;
    games.push({away,home,eventId:g.eventId??null});
  }
  const mine=games.filter(g=>g.away===team||g.home===team);
  if(mine.length!==1)return null;
  const {away,home,eventId}=mine[0];
  if(games.filter(g=>[g.away,g.home].some(t=>t===away||t===home)).length!==1)return null;
  if(eventId!==null&&!/^[0-9]{1,20}$/.test(String(eventId)))return null;
  if(listed.has(away)||listed.has(home))return null;
  return{away,home,revision:row.revision};
}

export function verifySurvivorSchedule(config,payloadByWeek,{pickemSlates=[],absenceConfirmations=[]}={}){
  const errors=[],weeks=[],resultsByWeek=[],contextUnexposed=[],absentGames=[],absenceRequests=[],offScheduleList=[];
  const none={weeks,resultsByWeek,contextUnexposed,absentGames,absenceRequests,offSchedule:offScheduleList};
  if(!config||!Number.isInteger(config.week)||config.week<1)return{ok:false,errors:['Survivor week is missing'],...none};
  if(config.week>NFL_REGULAR_SEASON_WEEKS)return{ok:false,errors:[`Survivor Week ${config.week} is outside the NFL regular season (Weeks 1–${NFL_REGULAR_SEASON_WEEKS}); only regular-season schedules can be verified`],...none};
  const confirmations=new Set((Array.isArray(absenceConfirmations)?absenceConfirmations:[]).filter(x=>typeof x==='string')),confirmed=new Set();
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
      offScheduleList.push({week,team,entries:labels.length});
      const shown=labels.slice(0,8).join(', ')+(labels.length>8?`, +${labels.length-8} more`:'');
      const base=`Week ${week}: ${team} is not scheduled in verified NFL Week ${week} (bye or invalid team) — ${plural(labels.length,'entry','entries')}: ${shown}. Check the sheet's Week ${week} column for ${team}.`;
      const slate=slateMatchup(pickemSlates,{season:config.season,week,team,listed:schedule.teams});
      if(!slate){errors.push(base);continue}
      const phrase=survivorAbsencePhrase(week,slate.away,slate.home);
      if(confirmations.has(phrase)){
        confirmed.add(phrase);
        if(!absentGames.some(x=>x.confirmation===phrase))absentGames.push({type:SURVIVOR_ABSENT_EXCEPTION,week,away:slate.away,home:slate.home,pickemRevision:slate.revision,confirmation:phrase});
        continue;
      }
      if(!absenceRequests.some(x=>x.confirmation===phrase))absenceRequests.push({week,away:slate.away,home:slate.home,pickemRevision:slate.revision,confirmation:phrase});
      errors.push(`${base} Pick'em Week ${week} (revision ${slate.revision}) proves ${slate.away} @ ${slate.home}, and neither team is listed in the NFL Week ${week} feed: if that game was moved out of Week ${week}, type ${phrase} under Absent games and Read & validate again.`);
    }
  }
  for(const text of confirmations)if(!confirmed.has(text))errors.push(`Absent-game confirmation "${text}" does not match a picked game that the same-week Pick'em slate proves and the NFL feed no longer lists. Correct or clear it, then Read & validate again.`);
  return{ok:errors.length===0,errors:[...new Set(errors)],weeks,resultsByWeek,contextUnexposed,absentGames,absenceRequests,offSchedule:offScheduleList};
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
// No-pick eliminations per week (through `weeks`) that a list of entries produces under verified results.
function noPickOutsByWeek(entries,weeks,resultsByWeek){
  const out=new Map();
  for(const entry of entries||[]){
    const state=survivorEntryState(entry,weeks-1,resultsByWeek);
    if(state.type==='no-pick'&&state.eliminatedWeek<=weeks)out.set(state.eliminatedWeek,(out.get(state.eliminatedWeek)||0)+1);
  }
  return out;
}
const perWeekText=byWeek=>{const weeks=[...byWeek].filter(([,n])=>n>0).sort((a,b)=>a[0]-b[0]);return weeks.length===1?`Week ${weeks[0][0]}`:weeks.map(([w,n])=>`Week ${w}: ${n}`).join(', ')};

// Partial/premature-sheet guard. It never changes Survivor rules: it decides whether publication is blocked, or needs the
// admin's explicit confirmation that the sheet is the final submission set before blanks become no-pick eliminations.
export function survivorPublishGuard(config,{resultsByWeek=[],currentGames=null,published=null,detachedRows=[],unanchoredRows=[],gridBreaks=[],symbolRows=[],contextUnexposed=[]}={}){
  const W=config.week,entries=entriesOf(config),facts=[],reasons=[],blocking=[];
  if(!published||published.checked!==true)blocking.push('Published Survivor weeks for this season have not been checked. Sign in; the comparison runs automatically.');
  const rows=(published?.rows||[]).filter(r=>r&&r.season===config.season&&Number.isInteger(r.week));
  const locked=rows.filter(r=>r.status==='locked').sort((a,b)=>a.week-b.week);
  const prior=locked.filter(r=>r.week<W).pop()||null,P=prior?prior.week:0,existing=rows.find(r=>r.week===W)||null;
  const validFor=(row,week)=>!!row?.config&&!validateSurvivorConfig(row.config).length&&row.config.season===config.season&&row.config.week===week;
  const existingValid=validFor(existing,W),priorValid=validFor(prior,P),existingKind=existing?.status==='locked'?'published':'draft';
  // Weeks already on the published record: through the latest published week before W, or through W-1 when this
  // replaces a published (locked) Week W whose histories cover them. Draft rows are never public, so they cover nothing.
  const existingCovers=existingValid&&existing.status==='locked',covered=existingCovers?Math.max(P,W-1):P;
  if(published?.checked===true)facts.push(locked.length?`Published Survivor weeks visible for ${config.season}: ${locked.map(r=>r.week).join(', ')}.`:`No published Survivor weeks are visible for ${config.season}.`);
  if(contextUnexposed.length)facts.push(`The NFL feed did not identify its season/week for ${listWeeks(contextUnexposed)}; those games were matched by team structure only.`);

  const games=Array.isArray(currentGames)?currentGames:null,notStarted=games?games.filter(g=>g.state==='pre').length:null,unknownState=games?games.filter(g=>!['pre','in','post'].includes(g.state)).length:null;
  const kickoffNote=!games?` Kickoff status for Week ${W} could not be confirmed.`:notStarted?` ${notStarted} of ${games.length} Week ${W} games have not kicked off yet, so this export may be premature.`:unknownState?` Kickoff status for ${unknownState} Week ${W} game${unknownState===1?' is':'s are'} unknown.`:'';
  // No-pick eliminations this publication creates in weeks not yet on the published record (each entry counted once,
  // at its first blank week).
  const outsByWeek=new Map(),maybeByWeek=new Map(),counted=new Set();
  let aliveEntering=0,picksAlive=0,missingAlive=0,unresolvedEntering=0,missingUnresolved=0;
  for(let w=covered+1;w<=W;w++){
    let alive=0,missing=0,pending=0,pendingMissing=0,notFinal=0;const names=[];
    for(const entry of entries){
      if(counted.has(entry))continue;
      const pick=entry?.picks?.[w-1]||null,state=w===1?{status:'alive'}:survivorEntryState(entry,w-2,resultsByWeek);
      if(state.status==='alive'){alive++;if(!pick){missing++;counted.add(entry);if(entry.displayName)names.push(entry.displayName)}}
      else if(state.status==='pending'||state.status==='live'){pending++;if(!pick){pendingMissing++;counted.add(entry);if(state.type==='pending')notFinal++}}
    }
    if(missing)outsByWeek.set(w,missing);if(pendingMissing)maybeByWeek.set(w,pendingMissing);
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

  const byElimination=new Map();let resultEliminations=true;
  for(const entry of entries){
    if(!entry?.picks?.[W-1]||W===1)continue;
    const state=survivorEntryState(entry,W-2,resultsByWeek);
    if(state.status!=='out')continue;
    if(state.type!=='loss'&&state.type!=='tie')resultEliminations=false;
    const label=eliminationLabel(state);byElimination.set(label,(byElimination.get(label)||0)+1);
  }
  const picksFromEliminated=[...byElimination.values()].reduce((a,b)=>a+b,0);
  if(picksFromEliminated){
    const groups=[...byElimination].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])),shown=groups.slice(0,4).map(([label,n])=>`${n} OUT by ${label}`).join('; ')+(groups.length>4?`; +${groups.length-4} more groups`:'');
    reasons.push(`${plural(picksFromEliminated,'entry','entries')} already eliminated before Week ${W} still ${picksFromEliminated===1?'shows':'show'} a Week ${W} pick (${shown}). The sheet may disagree with ${resultEliminations?'the NFL results':'the NFL results or its own earlier picks'}; Survivor rules still treat ${picksFromEliminated===1?'it':'them'} as OUT.`);
  }

  // Blanks that this sheet introduces into weeks already on the published record are new no-pick eliminations too.
  const newlyBlank=(cfg,weeks,label)=>{
    if(weeks<1)return;
    // Tracked entries have stable ids, so each one is compared exactly.
    const trackedNew=new Map();
    for(const tracked of config.trackedEntries||[]){
      const now=survivorEntryState(tracked,weeks-1,resultsByWeek);
      if(now.type!=='no-pick'||now.eliminatedWeek>weeks)continue;
      const was=(cfg.trackedEntries||[]).find(x=>x.id===tracked.id),before=was?survivorEntryState(was,weeks-1,resultsByWeek):null;
      if(before?.type==='no-pick'&&before.eliminatedWeek===now.eliminatedWeek)continue;
      if(!trackedNew.has(now.eliminatedWeek))trackedNew.set(now.eliminatedWeek,[]);trackedNew.get(now.eliminatedWeek).push(tracked.displayName);
    }
    for(const [w,names] of [...trackedNew].sort((a,b)=>a[0]-b[0])){outsByWeek.set(w,(outsByWeek.get(w)||0)+names.length);reasons.push(`${names.join(', ')} ${names.length===1?'is':'are'} newly OUT (no pick) in Week ${w} compared with ${label}.`)}
    // Anonymous entries have no stable identity: compare per-week no-pick totals.
    const sheet=noPickOutsByWeek(config.fieldEntries,weeks,resultsByWeek),before=noPickOutsByWeek(cfg.fieldEntries,weeks,resultsByWeek);
    for(const [w,n] of sheet){const extra=n-(before.get(w)||0);if(extra>0){outsByWeek.set(w,(outsByWeek.get(w)||0)+extra);reasons.push(`${plural(extra,'more entry is','more entries are')} OUT (no pick) in Week ${w} than in ${label}.`)}}
  };
  if(published?.checked===true&&W>1&&!existingCovers){
    if(!prior)reasons.push(`No published Survivor week before Week ${W} exists to compare this sheet against.`);
    else{
      if(P<W-1)reasons.push(`Survivor ${weekSpan(P+1,W-1)} ${P+1===W-1?'has':'have'} never been published; this sheet becomes the first published record of ${P+1===W-1?'that week':'those weeks'}.`);
      if(!priorValid)reasons.push(`Published Survivor Week ${P} could not be validated for comparison.`);
      else{const label=`published Week ${P} (revision ${prior.revision})`,issues=compareToPublished(config,prior.config,P,label);if(issues.length)reasons.push(...issues);else facts.push(`Entry count and ${weekSpan(1,P)} pick histories match ${label}.`);newlyBlank(prior.config,P,label)}
    }
  }
  if(existing){
    const label=`${existingKind} Week ${W} revision ${existing.revision}`;
    if(!existingValid)reasons.push(`${label[0].toUpperCase()+label.slice(1)} could not be validated for comparison.`);
    else{
      const cfg=existing.config,issues=compareToPublished(config,cfg,W,label),removed=removedCurrentPicks(config,cfg,W);
      if(removed)issues.push(`${plural(removed,`Week ${W} pick`,`Week ${W} picks`)} in ${label} ${removed===1?'is':'are'} blank in this sheet.`);
      if(cfg.currentWeekEntryCount>config.currentWeekEntryCount)issues.push(`${label[0].toUpperCase()+label.slice(1)} has ${cfg.currentWeekEntryCount} Week ${W} picks; this sheet has only ${config.currentWeekEntryCount}.`);
      if(issues.length)reasons.push(`This replaces ${label}:`,...issues);else facts.push(`This sheet is identical to ${label} (entries and ${weekSpan(1,W)} pick histories).`);
      if(existingCovers)newlyBlank(cfg,W-1,label);
    }
  }
  const later=locked.filter(r=>r.week>W).map(r=>r.week);
  if(later.length)reasons.push(`Published Survivor ${listWeeks(later)} already ${later.length===1?'exists; it keeps its own history and is':'exist; they keep their own histories and are'} not changed by this publication.`);
  if(detachedRows?.length){
    const shown=detachedRows.slice(0,6).map(r=>`"${r.label}"${r.page!=null?` (page ${r.page})`:''}`).join(', ')+(detachedRows.length>6?`, +${detachedRows.length-6} more`:'');
    reasons.push(`${plural(detachedRows.length,'row without picks was','rows without picks were')} physically separated from the participant table and ${detachedRows.length===1?'was':'were'} NOT counted as ${detachedRows.length===1?'an entrant':'entrants'}: ${shown}. If any is a real entrant, do not publish.`);
  }
  if(unanchoredRows?.length){
    const shown=unanchoredRows.slice(0,6).map(r=>`"${r.label}"${r.page!=null?` (page ${r.page})`:''}`).join(', ')+(unanchoredRows.length>6?`, +${unanchoredRows.length-6} more`:'');
    reasons.push(`${plural(unanchoredRows.length,'row without picks','rows without picks')} on a page with no participant picks ${unanchoredRows.length===1?'was':'were'} counted as ${unanchoredRows.length===1?'an entrant':'entrants'} (OUT for no pick): ${shown}. If any is not a real entrant, do not publish.`);
  }
  if(gridBreaks?.length){
    const shown=gridBreaks.slice(0,4).map(r=>`"${r.upper}" → "${r.lower}"${r.page!=null?` (page ${r.page})`:''}`).join(', ')+(gridBreaks.length>4?`, +${gridBreaks.length-4} more`:'');
    reasons.push(`${plural(gridBreaks.length,'participant-table grid restart was','participant-table grid restarts were')} counted across a single empty visual row: ${shown}. Confirm ${gridBreaks.length===1?'it is a real continuation':'they are real continuations'} of the participant table.`);
  }
  if(symbolRows?.length){
    const shown=symbolRows.slice(0,6).map(r=>`"${r.label}"${r.page!=null?` (page ${r.page})`:''}`).join(', ')+(symbolRows.length>6?`, +${symbolRows.length-6} more`:'');
    reasons.push(`${plural(symbolRows.length,'name-column row has','name-column rows have')} no letter or digit and ${symbolRows.length===1?'was':'were'} NOT counted as ${symbolRows.length===1?'an entrant':'entrants'}: ${shown}. If any is a real entrant, do not publish.`);
  }
  const noPickOuts=[...outsByWeek.values()].reduce((a,b)=>a+b,0),maybeNoPickOuts=[...maybeByWeek.values()].reduce((a,b)=>a+b,0);
  const replacing=existing?`, replacing ${existingKind} Week ${W} revision ${existing.revision}`:'';
  const separated=detachedRows?.length?` The ${plural(detachedRows.length,'separated row','separated rows')} listed above ${detachedRows.length===1?'is not an entrant':'are not entrants'}.`:'';
  const unanchored=unanchoredRows?.length?` The ${plural(unanchoredRows.length,'row','rows')} counted from a page without picks ${unanchoredRows.length===1?'is a real entrant':'are real entrants'}.`:'';
  const gridRestart=gridBreaks?.length?` The ${plural(gridBreaks.length,'participant-table grid restart','participant-table grid restarts')} listed above ${gridBreaks.length===1?'is a real continuation':'are real continuations'}.`:'';
  const outs=noPickOuts||maybeNoPickOuts?` Publishing shows ${plural(noPickOuts,'entry','entries')} OUT for no pick${noPickOuts?` (${perWeekText(outsByWeek)})`:''}${maybeNoPickOuts?`, and up to ${maybeNoPickOuts} more once earlier results are final (${perWeekText(maybeByWeek)})`:''}.`:'';
  const symbols=symbolRows?.length?` The ${plural(symbolRows.length,'row','rows')} without a letter or digit listed above ${symbolRows.length===1?'is not an entrant':'are not entrants'}.`:'';
  const confirmText=`I reviewed every item listed above and confirm this sheet is the final Survivor Week ${W} submission set — no more Week ${W} picks will be added${replacing}.${outs}${separated}${unanchored}${gridRestart}${symbols}`;
  return{week:W,priorWeek:P,coveredThrough:covered,aliveEntering,picksAlive,missingAlive,unresolvedEntering,missingUnresolved,noPickOuts,maybeNoPickOuts,picksFromEliminated,notStarted,facts,reasons,blocking,requiresConfirmation:reasons.length>0,confirmText};
}
