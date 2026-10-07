'use strict';

import {survivorEntryState,survivorPickDistribution,survivorSummary,survivorWeekProgress,survivorFieldAvailability,survivorDecisionOptions,survivorMarketMatchups,survivorBuildResults,survivorFeedContextError,survivorUnresolvedEntering,survivorAwaitingRuling,survivorOnHold} from './survivor-math.js?v=7';
import {PUBLIC_COLUMNS,FIRST_RULING_SEASON,contestIdFor,evaluateContestRulings,survivorRulingLookup,rulesModel} from './contest-rulings.js?v=1';

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ESPN_SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const LOGO_CODE={WAS:'wsh'};
let rows=[],cfg=null,resultsByWeek=[],nextWeekMatchups=[],nextWeekFetchedAt=0,nextWeekError='',anonToken=null,anonExpiresAt=0,anonRequest=null,refreshId=0,nextWeekRequestId=0,nextWeekController=null;
// HDC-12: the contest's validated rules and rulings (null until the first load for the selected week) and the raw events
// of each week, kept only to check an applied ruling against what the feed says now.
let rulingData=null,rawEventsByWeek=[];
const activeScoreControllers=new Set();
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

function jwtExpiry(token){try{const part=token.split('.')[1],json=atob(part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'=')),exp=Number(JSON.parse(json)?.exp);return Number.isFinite(exp)?exp*1000:0}catch{return 0}}
// The token is now also fetched on the refresh path (rulings), so a request that never answers is abandoned after the
// time limit and the next refresh starts a new one.
const TOKEN_TIMEOUT_MS=15000;
async function anonymousToken(){if(anonToken&&Date.now()<anonExpiresAt-60000)return anonToken;if(!anonRequest){const c=new AbortController,t=setTimeout(()=>c.abort(),TOKEN_TIMEOUT_MS);anonRequest=fetch(`${NEON_AUTH_URL}/token/anonymous`,{cache:'no-store',headers:{Accept:'application/json'},signal:c.signal}).then(async r=>{if(!r.ok)throw new Error(`anonymous auth ${r.status}`);const j=await r.json();if(!j?.token)throw new Error('anonymous auth returned no token');anonToken=j.token;anonExpiresAt=jwtExpiry(anonToken)||Date.now()+5*60*1000;return anonToken}).finally(()=>{clearTimeout(t);anonRequest=null})}return anonRequest}

// HDC-12: read-only public load of the contest, its policy history and every ruling through the selected week. Only the
// public columns are requested (never created_by or admin_note); the pure evaluator validates what comes back.
async function loadRulings(contestId,week,signal){
  const token=await anonymousToken(),headers={Authorization:`Bearer ${token}`,Accept:'application/json'},id=encodeURIComponent(contestId);
  const get=async(table,columns,query)=>{
    const r=await fetch(`${NEON_DATA_URL}/${table}?select=${columns.join(',')}&${query}`,{cache:'no-store',headers,signal});
    if(!r.ok)throw new Error(`${table} ${r.status}`);
    const data=await r.json();if(!Array.isArray(data))throw new Error(`${table} returned no rows`);return data;
  };
  const [contests,policies,rulings]=await Promise.all([
    get('nfl_contests',PUBLIC_COLUMNS.contests,`contest_id=eq.${id}`),
    get('nfl_contest_policies',PUBLIC_COLUMNS.policies,`contest_id=eq.${id}&order=revision.asc`),
    get('nfl_incident_rulings',PUBLIC_COLUMNS.rulings,`contest_id=eq.${id}&week=lte.${week}&order=week.asc,chain_seq.asc`)
  ]);
  return{contests,policies,rulings};
}
// The ruling overlay survivor-math reads, or null before the first load (nothing is graded then: no results either).
function rulingLookup(){return rulingData&&cfg?survivorRulingLookup(rulingData,{eventsByWeek:rawEventsByWeek,season:cfg.season}):null}

function validateConfig(c){
  if(!c||c.schemaVersion!==1)throw new Error('Unsupported Survivor data');
  if(!Number.isInteger(c.season)||!Number.isInteger(c.week)||c.week<1)throw new Error('Invalid Survivor season/week');
  if(!Array.isArray(c.trackedEntries)||c.trackedEntries.length!==3)throw new Error('Invalid tracked Survivor entries');
  if(!Array.isArray(c.fieldEntries))throw new Error('Invalid Survivor field');
  const expectedTracked=new Map([['dc','D.C.'],['djs','DJS'],['thaddeus','Thaddeus']]);
  const trackedAllowed=['displayName','id','picks'].sort(),fieldAllowed=['id','picks'].sort(),valid=new Set(['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS']);
  const check=(p,label,allowed)=>{const keys=Object.keys(p||{}).sort();if(keys.length!==allowed.length||keys.some((k,i)=>k!==allowed[i]))throw new Error(label+' privacy contract');if(!Array.isArray(p.picks)||p.picks.length!==c.week)throw new Error(label+' pick history');for(const pick of p.picks)if(pick!==null&&!valid.has(pick))throw new Error(label+' invalid team')};
  const trackedIds=new Set();
  c.trackedEntries.forEach((p,i)=>{check(p,'tracked '+(i+1),trackedAllowed);if(expectedTracked.get(p.id)!==p.displayName||trackedIds.has(p.id))throw new Error('Tracked Survivor identity mismatch');trackedIds.add(p.id)});
  const fieldIds=new Set();
  c.fieldEntries.forEach((p,i)=>{check(p,'field '+(i+1),fieldAllowed);if(typeof p.id!=='string'||!p.id||fieldIds.has(p.id))throw new Error('Invalid anonymous Survivor id');fieldIds.add(p.id)});
  const all=[...c.trackedEntries,...c.fieldEntries];
  if(c.competitionSize!==all.length)throw new Error('Survivor competition size mismatch');
  const current=all.filter(p=>p.picks[c.week-1]).length;
  if(c.currentWeekEntryCount!==current)throw new Error('Survivor current-week count mismatch');
  return c;
}

function logo(team){const code=(LOGO_CODE[team]||team.toLowerCase());return`https://a.espncdn.com/i/teamlogos/nfl/500/${encodeURIComponent(code)}.png`}
function teamChip(team){return team?`<span class="survivor-team"><img src="${logo(team)}" alt=""><b>${esc(team)}</b></span>`:'<span class="survivor-none">NO PICK</span>'}
function allEntries(){return cfg?[...cfg.trackedEntries,...cfg.fieldEntries]:[]}

// Only teams actually picked in a week matter: a week is settled once every picked team has a verified final.
const pickedTeams=i=>new Set(allEntries().map(e=>e.picks[i]).filter(Boolean));
function weekSettled(i){const map=resultsByWeek[i];if(!(map instanceof Map))return false;for(const team of pickedTeams(i)){const r=map.get(team);if(!r||r.completed!==true||r.unresolved)return false}return true}
// Feed-status flags over picked teams. HDC-11: a halted game with no active ruling awaits a pool ruling. HDC-12: a team
// whose ruling applies is decided by it (and flagged only while the feed contradicts it, UNDER REVIEW); a team whose ruling
// information is unusable is ON HOLD.
const plural=(n,word)=>`${n} ${word}${n===1?'':'S'}`;
function feedFlags(R){
  let unverified=0,awaiting=0,held=0,review=0;
  resultsByWeek.forEach((map,i)=>{
    if(!(map instanceof Map))return;
    for(const team of pickedTeams(i)){
      const slot=R?R.forPick(i+1,team):{state:'none'};
      if(slot.state==='hold'){held++;continue}
      if(slot.state==='effective'){if(slot.underReview)review++;continue}
      const r=map.get(team);
      if(!r||r.unresolved)unverified++;else if(r.halted)awaiting++;
    }
  });
  return[unverified?`${plural(unverified,'TEAM RESULT')} UNVERIFIED`:'',awaiting?`${plural(awaiting,'TEAM RESULT')} AWAITING RULING`:'',held?`${plural(held,'TEAM RESULT')} ON HOLD`:'',review?`${plural(review,'TEAM RESULT')} UNDER REVIEW`:''].filter(Boolean);
}

function marketLabel(option){
  if(!option.favorite)return 'No market favorite';
  return Number.isFinite(option.spread)?`Favorite -${option.spread}`:'Market favorite';
}
function optionRow(option){
  const where=option.home?'vs':'@',avail=option.fieldDenominator?`${option.fieldAvailable}/${option.fieldDenominator} can use · ${option.fieldAvailablePct}%`:'field availability unavailable';
  return `<div class="survivor-option-row"><div>${teamChip(option.team)}<span class="survivor-opponent">${where} ${esc(option.opponent)}</span></div><div class="survivor-option-meta"><b>${esc(marketLabel(option))}</b><span>${esc(avail)}</span></div></div>`;
}
function renderDecision(summary,ruling=0,held=0,R=null){
  const box=$('svDecisionEntries');if(!box||!cfg)return;
  const nextWeekIndex=cfg.week,nextWeek=cfg.week+1,entries=allEntries();
  $('svDecisionWeek').textContent=`Week ${nextWeek}`;
  // HDC-12: without the contest's rules and rulings no entry can be proven alive, so there is no surviving field.
  if(R?.status==='hold'){$('svDecisionNote').textContent='Decision support is on hold: ruling data unavailable.';box.innerHTML='<div class="empty">ON HOLD · Ruling data unavailable. No entry can be proven alive until the contest rules and rulings load.</div>';return}
  if(summary.pending>0){$('svDecisionNote').textContent='Decision support is provisional until every current-week Survivor result is final.';box.innerHTML='<div class="empty">Waiting for the current week to settle before calculating the next-week surviving field.</div>';return}
  if(!nextWeekMatchups.length){$('svDecisionNote').textContent=nextWeekError||`Week ${nextWeek} schedule/market data has not loaded yet.`;box.innerHTML='<div class="empty">Week-ahead schedule unavailable. Burned-team history remains unchanged.</div>';return}
  const teams=nextWeekMatchups.flatMap(m=>[m.away,m.home]),availability=survivorFieldAvailability(entries,nextWeekIndex,resultsByWeek,teams,R);
  // HDC-11: entries awaiting a pool ruling on a halted game no longer hold the board, but they are not in the surviving field.
  // HDC-12: neither are entries on HOLD.
  $('svDecisionNote').textContent=`${ruling?`Provisional · ${ruling} ${ruling===1?'entry awaits':'entries await'} a pool ruling on a halted game and ${ruling===1?'is':'are'} not part of the surviving field. `:''}${held?`Provisional · ${held} ${held===1?'entry is':'entries are'} on HOLD and ${held===1?'is':'are'} not part of the surviving field. `:''}Field availability = share of surviving entries that have not already burned that team. It is not projected pick ownership.`;
  box.innerHTML=cfg.trackedEntries.map(entry=>{
    const state=survivorEntryState(entry,nextWeekIndex-1,resultsByWeek,R);
    if(state.halted)return `<article class="survivor-decision-entry survivor-decision-ruling"><div class="survivor-decision-head"><div><span class="section-kicker">${esc(entry.displayName)}</span><h3>Awaiting pool ruling</h3></div><span class="status-pill survivor-pending">RULING</span></div><p>${esc(state.reason)}</p></article>`;
    if(state.status==='hold')return `<article class="survivor-decision-entry survivor-decision-hold"><div class="survivor-decision-head"><div><span class="section-kicker">${esc(entry.displayName)}</span><h3>On hold</h3></div><span class="status-pill survivor-hold">HOLD</span></div><p>${esc(state.reason)}</p></article>`;
    const support=survivorDecisionOptions(entry,nextWeekIndex,resultsByWeek,nextWeekMatchups,availability,R),burned=support.burned.map(team=>`<span class="survivor-burned-chip">${esc(team)}</span>`).join('')||'<span class="survivor-none">None</span>';
    if(!support.eligible)return `<article class="survivor-decision-entry survivor-decision-out"><div class="survivor-decision-head"><div><span class="section-kicker">${esc(entry.displayName)}</span><h3>Out of Survivor</h3></div><span class="status-pill survivor-out">OUT</span></div><div class="survivor-burned"><span>Burned</span>${burned}</div><p>${esc(support.reason||'Entry is eliminated.')}</p></article>`;
    const favorites=support.options.filter(x=>x.favorite).sort((a,b)=>(b.spread||0)-(a.spread||0)||a.fieldAvailablePct-b.fieldAvailablePct||a.team.localeCompare(b.team));
    const safer=favorites.slice(0,4),leveragePool=favorites.length?favorites:support.options;
    const leverage=leveragePool.slice().sort((a,b)=>a.fieldAvailablePct-b.fieldAvailablePct||(b.spread||0)-(a.spread||0)||a.team.localeCompare(b.team)).slice(0,4);
    return `<article class="survivor-decision-entry"><div class="survivor-decision-head"><div><span class="section-kicker">${esc(entry.displayName)}</span><h3>Week ${nextWeek} Board</h3></div><span class="status-pill survivor-alive">ELIGIBLE</span></div><div class="survivor-burned"><span>Burned</span>${burned}</div><div class="survivor-board-grid"><div><h4>Safer favorites</h4><p>Market signal only; strongest available favorite first.</p>${safer.length?safer.map(optionRow).join(''):'<div class="empty">No market-favorite lines are available yet.</div>'}</div><div><h4>Field leverage</h4><p>Lower availability means fewer surviving entries can still use that team.</p>${leverage.length?leverage.map(optionRow).join(''):'<div class="empty">No legal Week-ahead options available.</div>'}</div></div></article>`;
  }).join('');
}

function statusLabel(state){
  return state.halted?'RULING':state.status==='hold'?'HOLD':state.status==='alive'?'ALIVE':state.status==='live'?'LIVE':state.status==='pending'?'PENDING':'OUT';
}
// HDC-12: an applied ruling the entry's state rests on whose incident the feed now contradicts. The ruling stays applied.
function underReview(state){return state.ruling?.underReview||state.rulings?.find(r=>r.underReview)?.underReview||null}
function rulingNote(state){
  if(state.type==='ruling'||!state.rulings?.length)return'';
  return ` · ${state.rulings.map(r=>`Week ${r.week} ${r.team} advanced by commissioner ruling`).join(' · ')}`;
}
function rulesHtml(m){
  if(!m)return'<div class="empty">Loading contest rules and rulings…</div>';
  if(m.state!=='ready')return`<div class="rules-alert rules-${m.state}"><b>${esc(m.heading)}</b><p>${esc(m.text)}</p></div><p class="rules-confirm">${esc(m.confirmation)}</p>`;
  const policy=m.policy?`<div class="rules-block"><span class="rules-label">Halted-game policy</span><b>${esc(m.policy.name)}</b><small>Policy revision ${m.policy.revision} · in force from Week ${m.policy.effectiveWeek}</small><p>${esc(m.policy.text)}</p>${m.policy.publicNote?`<p class="rules-note">${esc(m.policy.publicNote)}</p>`:''}</div>`:'';
  const revisions=m.revisions.length>1?`<p class="rules-meta">Policy history: ${m.revisions.map(r=>`revision ${r.revision}, ${esc(r.name)}, from Week ${r.effectiveWeek}`).join(' · ')}</p>`:'';
  const incidents=m.incidents.length?m.incidents.map(x=>`<div class="rules-incident rules-${x.status.toLowerCase().replace(/\s+/g,'-')}"><div class="rules-incident-head"><b>Week ${x.week} · ${esc(x.matchup)}</b><span class="rules-status">${esc(x.status)}</span></div><p>${esc(x.detail)}</p>${x.review?`<p class="rules-review">${esc(x.review)}</p>`:''}${x.unmatched?`<p class="rules-meta">${esc(x.unmatched)}</p>`:''}${x.evidence?`<small>${esc(x.evidence)}</small>`:''}${x.history.length?`<ol class="rules-history">${x.history.map(h=>`<li>${esc(h.label)}${h.date?` · ${esc(h.date)}`:''}${h.note?` · ${esc(h.note)}`:''}</li>`).join('')}</ol>`:''}</div>`).join(''):`<div class="empty">${esc(m.empty)}</div>`;
  return`<div class="rules-grid"><div class="rules-block"><span class="rules-label">Contest</span><b>${esc(m.contestName)}</b><small>${esc(m.contestType)}</small></div>${policy}</div>${revisions}<p class="rules-confirm">${esc(m.confirmation)}</p>${m.stale?`<p class="rules-stale">${esc(m.stale)}</p>`:''}${incidents}`;
}
function render(){
  if(!cfg)return;
  const R=rulingLookup(),globalHold=R?.status==='hold';
  const entries=allEntries(),wi=cfg.week-1,summary=survivorSummary(entries,wi,resultsByWeek,R),dist=survivorPickDistribution(entries,wi,resultsByWeek,R),progress=survivorWeekProgress(entries,wi,resultsByWeek,R),unresolvedPrior=survivorUnresolvedEntering(entries,wi,resultsByWeek,R);
  // HDC-11: entries awaiting a pool ruling on a halted game are shown on their own, never as still in, eligible or eliminated.
  // HDC-12: so are entries on HOLD, whose ruling information is unusable or unavailable.
  const ruling=survivorAwaitingRuling(entries,wi,resultsByWeek,R),rulingPrior=survivorAwaitingRuling(entries,wi-1,resultsByWeek,R);
  const held=survivorOnHold(entries,wi,resultsByWeek,R),heldPrior=survivorOnHold(entries,wi-1,resultsByWeek,R);
  const provisional=[
    unresolvedPrior?`Provisional · ${unresolvedPrior} ${unresolvedPrior===1?'entry is':'entries are'} awaiting a verified earlier-week result and ${unresolvedPrior===1?'is':'are'} not counted as eligible.`:'',
    rulingPrior?`Provisional · ${rulingPrior} ${rulingPrior===1?'entry awaits':'entries await'} a pool ruling on a halted earlier-week game and ${rulingPrior===1?'is':'are'} not counted as eligible.`:'',
    heldPrior&&!globalHold?`Provisional · ${heldPrior} ${heldPrior===1?'entry is':'entries are'} on HOLD for an earlier week and ${heldPrior===1?'is':'are'} not counted as eligible.`:''
  ].filter(Boolean).join(' ');
  const awaiting=ruling?` ${ruling} ${ruling===1?'entry is':'entries are'} awaiting a pool ruling on a halted game and ${ruling===1?'is':'are'} not counted as still in or eliminated.`:'';
  const onHold=held&&!globalHold?` ${held} ${held===1?'entry is':'entries are'} on HOLD: the ruling information for ${held===1?'its pick is':'their picks is'} unusable, so ${held===1?'it is':'they are'} not counted as still in or eliminated.`:'';
  $('svPoolSize').textContent=cfg.competitionSize;$('svEntered').textContent=summary.entered;$('svStillIn').textContent=summary.active;$('svPending').textContent=summary.pending;
  $('svSummaryNote').textContent=`${globalHold?'ON HOLD · Ruling data unavailable: Survivor results are on hold until the contest rules and rulings load; nothing is graded from the NFL feed alone. ':''}${summary.eliminatedBefore} eliminated before Week ${cfg.week} · ${summary.eligibleEntering} eligible entering · ${summary.submitted} submitted · ${summary.entered} legal picks · ${summary.eliminatedThisWeek} eliminated this week so far.${awaiting}${onHold}${provisional?` ${provisional}`:''}`;
  $('svTracked').innerHTML=cfg.trackedEntries.map(entry=>{
    const state=survivorEntryState(entry,wi,resultsByWeek,R),current=state.eliminatedWeek&&state.eliminatedWeek<cfg.week?entry.picks[state.eliminatedWeek-1]:entry.picks[wi],history=entry.picks.map((pick,i)=>`<span class="survivor-history-chip"><small>W${i+1}</small>${pick?esc(pick):'—'}</span>`).join('');
    const review=underReview(state);
    return`<div class="survivor-tracked-row"><div><b>${esc(entry.displayName)}</b><div class="survivor-history">${history}</div></div><div class="survivor-current">${teamChip(current)}<span class="status-pill survivor-${state.status}">${statusLabel(state)}</span>${review?'<span class="status-pill survivor-review">UNDER REVIEW</span>':''}<small>${esc(state.reason)}${esc(rulingNote(state))}${review?` · UNDER REVIEW: ${esc(review)}; the ruling stays applied`:''}</small></div></div>`;
  }).join('');
  $('svDistribution').innerHTML=(provisional?`<div class="empty">${esc(provisional)}</div>`:'')+(dist.length?dist.map(item=>`<div class="survivor-pick-row"><div>${teamChip(item.team)}</div><div class="survivor-bar"><i style="width:${item.pct}%"></i></div><b>${item.count}</b><span>${item.pct}%</span></div>`).join(''):'<div class="empty">No eligible entries have a Week pick.</div>');
  $('svProgress').innerHTML=progress.map(x=>{const r=survivorAwaitingRuling(entries,x.week-1,resultsByWeek,R),h=survivorOnHold(entries,x.week-1,resultsByWeek,R);return`<div class="survivor-week-step"><span>Week ${x.week}</span><b>${x.remaining}</b><small>${x.eligibleEntering} eligible · ${x.submitted} submitted · ${x.entered} legal · ${x.eliminated} out${r?` · ${r} awaiting ruling`:''}${h?` · ${h} on hold`:''}</small></div>`}).join('');
  renderDecision(summary,ruling,held,R);
  const rules=$('svRules');
  if(rules)rules.innerHTML=rulesHtml(rulingData?rulesModel(rulingData,{week:cfg.week,slotState:x=>R?.forPick(x.week,x.away||x.home)||null}):null);
  $('svMeta').textContent=`Week ${cfg.week} · revision ${rows.find(r=>r.config===cfg)?.revision||'—'}`;
}

async function updateDecisionSchedule(force=false){
  if(!cfg)return;const scheduleCfg=cfg;
  if(!force&&nextWeekMatchups.length&&Date.now()-nextWeekFetchedAt<300000){render();return}
  const requestId=++nextWeekRequestId;
  if(nextWeekController)nextWeekController.abort();
  const controller=new AbortController;nextWeekController=controller;
  try{
    const week=scheduleCfg.week+1,r=await fetch(`${ESPN_SCOREBOARD}?dates=${scheduleCfg.season}&week=${week}&seasontype=2`,{cache:'no-store',signal:controller.signal});
    if(!r.ok)throw new Error(`Week ${week} schedule ${r.status}`);
    const j=await r.json();if(requestId!==nextWeekRequestId||cfg!==scheduleCfg)return;
    const matchups=survivorMarketMatchups(j?.events);
    if(!matchups.length)throw new Error(`Week ${week} schedule is not available yet`);
    const contextError=survivorFeedContextError(j,{season:scheduleCfg.season,week});if(contextError)throw new Error(contextError);
    if(requestId!==nextWeekRequestId||cfg!==scheduleCfg)return;
    nextWeekMatchups=matchups;nextWeekFetchedAt=Date.now();nextWeekError='';render();
  }catch(e){
    if(e?.name==='AbortError'||requestId!==nextWeekRequestId||cfg!==scheduleCfg)return;
    nextWeekError=e.message||String(e);if(!nextWeekMatchups.length)render();console.warn(e);
  }finally{
    if(requestId===nextWeekRequestId&&nextWeekController===controller)nextWeekController=null;
  }
}

// Each score request must settle before the next 20 s refresh, so a hung week can never hold up the others.
const SCORE_FEED_TIMEOUT_MS=15000;
function abortActiveScoreRequests(){for(const controller of activeScoreControllers)controller.abort();activeScoreControllers.clear()}
function withinTime(task,label){
  const controller=new AbortController;activeScoreControllers.add(controller);
  return new Promise((resolve,reject)=>{
    let settled=false,t=null;
    const finish=(fn,value)=>{if(settled)return;settled=true;if(t!==null)clearTimeout(t);activeScoreControllers.delete(controller);fn(value)};
    t=setTimeout(()=>{controller.abort();finish(reject,new Error(`${label} timed out`))},SCORE_FEED_TIMEOUT_MS);
    Promise.resolve().then(()=>task(controller.signal)).then(value=>finish(resolve,value),error=>finish(reject,error));
  });
}

async function updateScores(){
  if(!cfg)return;abortActiveScoreRequests();const id=++refreshId,scoreCfg=cfg;
  try{
    const current=scoreCfg.week-1,indexes=Array.from({length:scoreCfg.week},(_,i)=>i).filter(i=>i===current||!weekSettled(i));
    // HDC-12: the contest's rules and rulings load with the scores, under the same time limit and cancellation.
    const contestId=contestIdFor(scoreCfg.season,'survivor');
    const rulingLoad=scoreCfg.season<FIRST_RULING_SEASON?Promise.resolve({}):withinTime(signal=>loadRulings(contestId,scoreCfg.week,signal),'Survivor rules and rulings').then(data=>({data}),error=>({error}));
    const [outcomes,loaded]=await Promise.all([Promise.allSettled(indexes.map(i=>withinTime(async signal=>{
      const week=i+1,r=await fetch(`${ESPN_SCOREBOARD}?dates=${scoreCfg.season}&week=${week}&seasontype=2`,{cache:'no-store',signal});
      if(!r.ok)throw new Error(`Week ${week} score feed ${r.status}`);
      const json=await r.json(),contextError=survivorFeedContextError(json,{season:scoreCfg.season,week});
      if(contextError)throw new Error(contextError);
      return{results:survivorBuildResults(json.events,{season:scoreCfg.season,week}),events:json.events};
    },`Week ${i+1} score feed`))),rulingLoad]);
    if(id!==refreshId||cfg!==scoreCfg)return;
    // A load that fails keeps rulings already verified this session (marked stale); data that does not validate holds.
    if(loaded.error)console.warn(loaded.error);
    rulingData=evaluateContestRulings({contestId,contestType:'survivor',season:scoreCfg.season,...loaded,previous:rulingData});
    // Each week stands alone: a failed refresh of an earlier week keeps its last verified results.
    const failed=[];
    outcomes.forEach((o,k)=>{const i=indexes[k];if(o.status==='fulfilled'){resultsByWeek[i]=o.value.results;rawEventsByWeek[i]=o.value.events}else failed.push({i,reason:o.reason})});
    failed.forEach(f=>console.warn(f.reason));
    if(failed.some(f=>f.i===current||!(resultsByWeek[f.i] instanceof Map)))throw failed.find(f=>f.i===current||!(resultsByWeek[f.i] instanceof Map)).reason;
    const R=rulingLookup(),flags=R?.status==='hold'?null:feedFlags(R);
    $('svFeed').textContent=!flags?'ON HOLD · RULING DATA UNAVAILABLE':flags.length?`LIVE · ${flags.join(' · ')}`:'LIVE · NFL results';$('svFeed').className=`survivor-feed ${!flags||flags.length?'warn':'ok'}`;render();void updateDecisionSchedule();
  }catch(e){if(id!==refreshId||cfg!==scoreCfg)return;$('svFeed').textContent='RESULT FEED UNAVAILABLE';$('svFeed').className='survivor-feed warn';render();console.warn(e)}
}

function choose(row,{push=false}={}){
  const nextCfg=validateConfig(row.config);
  abortActiveScoreRequests();refreshId++;
  if(nextWeekController){nextWeekController.abort();nextWeekController=null}
  nextWeekRequestId++;
  cfg=nextCfg;resultsByWeek=[];rawEventsByWeek=[];rulingData=null;nextWeekMatchups=[];nextWeekFetchedAt=0;nextWeekError='';
  $('survivorWeekSelect').value=`${row.season}-${row.week}`;$('survivorError').innerHTML='';render();void updateScores();
  if(push){const u=new URL(location.href);u.searchParams.set('view','survivor');u.searchParams.set('sw',String(row.week));u.searchParams.set('season',String(row.season));history.replaceState(history.state,'',u)}
}

async function load(){
  const token=await anonymousToken(),url=`${NEON_DATA_URL}/nfl_survivor_weeks?select=season,week,status,config,revision,published_at&status=eq.locked&order=season.asc,week.asc`,r=await fetch(url,{cache:'no-store',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  if(!r.ok)throw new Error(`Survivor data ${r.status}`);rows=await r.json();if(!Array.isArray(rows)||!rows.length)throw new Error('No published Survivor weeks found');
  const sel=$('survivorWeekSelect');sel.innerHTML=rows.map(x=>`<option value="${x.season}-${x.week}">${x.season} · Week ${x.week}</option>`).join('');
  const qs=new URLSearchParams(location.search),requested=Number(qs.get('sw')),season=Number(qs.get('season'))||rows[rows.length-1].season;let chosen=requested?rows.find(x=>x.season===season&&x.week===requested):null;if(!chosen)chosen=rows[rows.length-1];
  sel.addEventListener('change',()=>{
    const previous=cfg?`${cfg.season}-${cfg.week}`:sel.value,[s,w]=sel.value.split('-').map(Number),row=rows.find(x=>x.season===s&&x.week===w);
    if(!row)return;
    try{choose(row,{push:true})}
    catch(e){sel.value=previous;$('survivorError').innerHTML=`<div class="error">Unable to switch Survivor week: ${esc(e.message||String(e))}</div>`;console.warn(e)}
  });
  choose(chosen);
}

load().catch(e=>{$('survivorError').innerHTML=`<div class="error">Survivor is not published yet: ${esc(e.message)}</div>`;console.warn(e)});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&cfg&&document.body.dataset.view==='survivor')updateScores()});
setInterval(()=>{if(cfg&&document.body.dataset.view==='survivor')updateScores()},20000);
