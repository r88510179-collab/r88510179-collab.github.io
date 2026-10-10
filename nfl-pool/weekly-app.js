'use strict';

import {competitionRanks,ownershipShare,scoreEntry,tiebreakState} from './public-math.js?v=2';
import {PUBLIC_COLUMNS,FIRST_RULING_SEASON,contestIdFor,evaluateContestRulings,pickemSlotRuling,pickemSlotEffect,pickemEffectiveGame,rulesModel,isAbsenceEvidence} from './contest-rulings.js?v=2';

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ESPN_SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const TEAM_COLORS={ARI:'#97233F',ATL:'#A71930',BAL:'#241773',BUF:'#00338D',CAR:'#0085CA',CHI:'#0B162A',CIN:'#FB4F14',CLE:'#311D00',DAL:'#003594',DEN:'#FB4F14',DET:'#0076B6',GB:'#203731',HOU:'#03202F',IND:'#002C5F',JAX:'#006778',KC:'#E31837',LV:'#111',LAC:'#0080C6',LAR:'#003594',MIA:'#008E97',MIN:'#4F2683',NE:'#002244',NO:'#B3995D',NYG:'#0B2265',NYJ:'#125740',PHI:'#004C54',PIT:'#FFB612',SF:'#AA0000',SEA:'#002244',TB:'#D50A0A',TEN:'#4B92DB',WAS:'#5A1414'};
const ALIAS={JAC:'JAX',WSH:'WAS'};
const ESPN_LOGO_CODE={WAS:'wsh'};

let CFG=null,M=[],P=[],S=[],F=[],TIEBREAK_INDEX=0,G=[],gen=0,ctl=null,lastFetchedAt=null,anonToken=null,anonExpiresAt=0,anonRequest=null;
// HDC-12. NFL holds the NFL facts per game, exactly as the protected feed path (HDC-09/10/11) accepts them; G is the scoring
// view derived from those facts and the contest's confirmed rulings (pickemEffectiveGame): a void game scores nothing, a
// held game is never graded, every other game is its NFL fact. RULINGS is the validated contest dataset (null until the
// first load), SLOTS the ruling state of each game, LAST_EVENTS the raw feed used only to check an applied ruling against
// what the feed says now, and FEED_ISSUES the protected path's warnings by game.
let NFL=[],RULINGS=null,SLOTS=[],LAST_EVENTS=null,FEED_ISSUES=[];
// HDC-15. PUB is the identity of the published row CFG was installed from (season, week, revision, published_at), set in the
// same step as CFG, so the revision on screen is always the one being scored. PUB_STALE says why that publication could not
// be verified as the current one (null while it is), PUB_WEEKS is the last valid publication index (the selector's weeks)
// and SWITCH_ERROR is a chosen week that could not be loaded. refreshStartedAt and switching let a timer, a resume or a view
// change join a refresh that is already running instead of starting a second one.
let PUB=null,PUB_STALE=null,PUB_WEEKS=[],SWITCH_ERROR=null,refreshStartedAt=0,switching=false;
// A refresh still running after STALL_MS (a hung request) no longer holds the next timer refresh back.
const STALL_MS=15000,PUB_INDEX_COLUMNS='season,week,revision,published_at,status',PUB_ROW_COLUMNS='season,week,status,revision,published_at,config';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=x=>ALIAS[x]||x;
const score=x=>{let n;if(typeof x==='string'){const v=x.trim();if(!v||!/^\d+$/.test(v))return null;n=Number(v)}else if(typeof x==='number')n=x;else return null;return Number.isFinite(n)&&Number.isInteger(n)&&n>=0?n:null};
const VALID_VIEWS=new Set(['home','standings','games','picks','survivor']);
function currentView(){const q=new URLSearchParams(location.search).get('view');return VALID_VIEWS.has(q)?q:'home'}
function setView(view,{push=false,scroll=true}={}){
  const next=VALID_VIEWS.has(view)?view:'home',previous=document.body.dataset.view;
  document.querySelectorAll('[data-view-panel]').forEach(panel=>{panel.hidden=panel.dataset.viewPanel!==next});
  document.querySelectorAll('[data-view-target]').forEach(btn=>{if(btn.closest('.bottom-nav'))btn.setAttribute('aria-current',btn.dataset.viewTarget===next?'page':'false')});
  document.body.dataset.view=next;
  document.title=next==='home'?'Pool Center':`Pool Center · ${next[0].toUpperCase()+next.slice(1)}`;
  if(push){const u=new URL(location.href);u.searchParams.set('view',next);history.pushState({view:next},'',u)}
  document.querySelectorAll('.app-menu[open]').forEach(menu=>menu.removeAttribute('open'));
  if(scroll)window.scrollTo({top:0,behavior:'smooth'});
  // HDC-15: moving between Survivor and the Pick'em views hands the page to the other app, which refreshes once at once
  // (Survivor learns of it from this event); moving between Pick'em views changes nothing.
  if(VALID_VIEWS.has(previous)&&(previous==='survivor')!==(next==='survivor')){
    document.dispatchEvent(new CustomEvent('poolcenter:viewchange',{detail:{view:next,previous}}));
    autoRefresh();
  }
}
function setupViewNavigation(){
  document.addEventListener('click',event=>{const hit=event.target.closest('[data-view-target]');if(!hit)return;event.preventDefault();setView(hit.dataset.viewTarget,{push:true})});
  window.addEventListener('popstate',()=>setView(currentView(),{push:false,scroll:false}));
  setView(currentView(),{push:false,scroll:false});
}

function jwtExpiry(token){try{const part=token.split('.')[1],json=atob(part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'=')),exp=Number(JSON.parse(json)?.exp);return Number.isFinite(exp)?exp*1000:0}catch{return 0}}
// The token and the rules and rulings are read on every refresh, so neither may hold a refresh up: each request is
// abandoned after RULINGS_TIMEOUT_MS (a refresh then holds or keeps the rulings already verified) and retried next time.
const RULINGS_TIMEOUT_MS=15000;
async function anonymousToken(){if(anonToken&&Date.now()<anonExpiresAt-60000)return anonToken;if(!anonRequest){const c=new AbortController,t=setTimeout(()=>c.abort(),RULINGS_TIMEOUT_MS);anonRequest=fetch(`${NEON_AUTH_URL}/token/anonymous`,{cache:'no-store',headers:{Accept:'application/json'},signal:c.signal}).then(async r=>{if(!r.ok)throw new Error(`anonymous auth ${r.status}`);const j=await r.json();if(!j?.token)throw new Error('anonymous auth returned no token');anonToken=j.token;anonExpiresAt=jwtExpiry(anonToken)||Date.now()+5*60*1000;return anonToken}).finally(()=>{clearTimeout(t);anonRequest=null})}return anonRequest}
// HDC-12: read-only public load of the Pick'em contest, its policy history and the selected week's rulings. Only the public
// columns are requested (never created_by or admin_note); the pure evaluator validates what comes back.
async function loadRulings(signal){
  const c=new AbortController,abort=()=>c.abort(),t=setTimeout(abort,RULINGS_TIMEOUT_MS);
  if(signal){if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})}
  const fail=new Promise((_,reject)=>c.signal.addEventListener('abort',()=>{const e=new Error(signal?.aborted?'Aborted':'rules and rulings timed out');e.name=signal?.aborted?'AbortError':'TimeoutError';reject(e)},{once:true}));
  try{
    const token=await Promise.race([anonymousToken(),fail]),headers={Authorization:`Bearer ${token}`,Accept:'application/json'},id=encodeURIComponent(contestIdFor(CFG.season,'pickem'));
    const get=async(table,columns,query)=>{
      const r=await Promise.race([fetch(`${NEON_DATA_URL}/${table}?select=${columns.join(',')}&${query}`,{cache:'no-store',headers,signal:c.signal}),fail]);
      if(!r.ok)throw new Error(`${table} ${r.status}`);
      const data=await Promise.race([r.json(),fail]);if(!Array.isArray(data))throw new Error(`${table} returned no rows`);return data;
    };
    const [contests,policies,rulings]=await Promise.all([
      get('nfl_contests',PUBLIC_COLUMNS.contests,`contest_id=eq.${id}`),
      get('nfl_contest_policies',PUBLIC_COLUMNS.policies,`contest_id=eq.${id}&order=revision.asc`),
      get('nfl_incident_rulings',PUBLIC_COLUMNS.rulings,`contest_id=eq.${id}&week=eq.${CFG.week}&order=chain_seq.asc`)
    ]);
    return{contests,policies,rulings};
  }finally{clearTimeout(t);signal?.removeEventListener?.('abort',abort)}
}
// HDC-15: one read of the Pick'em publication table, time-limited and abandoned with its refresh like the rules and rulings.
async function readPublished(query,signal){
  const c=new AbortController,abort=()=>c.abort(),t=setTimeout(abort,RULINGS_TIMEOUT_MS);
  if(signal){if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})}
  const fail=new Promise((_,reject)=>c.signal.addEventListener('abort',()=>{const e=new Error(signal?.aborted?'Aborted':'published week data timed out');e.name=signal?.aborted?'AbortError':'TimeoutError';reject(e)},{once:true}));
  try{
    const token=await Promise.race([anonymousToken(),fail]);
    const r=await Promise.race([fetch(`${NEON_DATA_URL}/nfl_pool_weeks?${query}`,{cache:'no-store',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:c.signal}),fail]);
    if(!r.ok)throw new Error(`week data ${r.status}`);
    const data=await Promise.race([r.json(),fail]);if(!Array.isArray(data))throw new Error('week data is not a list');return data;
  }finally{clearTimeout(t);signal?.removeEventListener?.('abort',abort)}
}
// The identity of a published row: a locked season and week at a whole revision of at least 1. Anything else is refused.
function publishedIdentity(x){
  if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('a published row is malformed');
  const {season,week,revision,status,published_at:publishedAt=null}=x;
  if(!Number.isSafeInteger(season)||season<1||!Number.isSafeInteger(week)||week<1)throw new Error('a published row has no valid season and week');
  if(!Number.isSafeInteger(revision)||revision<1)throw new Error(`${season} Week ${week} has no valid revision`);
  if(status!=='locked')throw new Error(`${season} Week ${week} is not locked`);
  if(publishedAt!==null&&typeof publishedAt!=='string')throw new Error(`${season} Week ${week} has no valid publication time`);
  return{season,week,revision,publishedAt};
}
// The publication index: which weeks are published, at which revision. Identity columns only, never a config; a malformed or
// repeated week makes the whole index unusable, so no week is ever chosen from an ambiguous list.
async function loadPublicationIndex(signal){
  const seen=new Set();
  return(await readPublished(`select=${PUB_INDEX_COLUMNS}&status=eq.locked&order=season.asc,week.asc`,signal)).map(x=>{
    const id=publishedIdentity(x),key=`${id.season}-${id.week}`;
    if(seen.has(key))throw new Error(`${id.season} Week ${id.week} is listed more than once`);
    seen.add(key);return id;
  });
}
// The full published row of one week, accepted only when it is exactly that locked week, at the listed revision or a later
// one, and its config validates.
async function loadPublishedWeek({season,week,revision},signal){
  const data=await readPublished(`select=${PUB_ROW_COLUMNS}&season=eq.${season}&week=eq.${week}&status=eq.locked`,signal);
  if(data.length!==1)throw new Error(data.length?`${season} Week ${week} came back more than once`:`${season} Week ${week} is not published`);
  const row=publishedIdentity(data[0]);
  if(row.season!==season||row.week!==week)throw new Error(`asked for ${season} Week ${week}, got ${row.season} Week ${row.week}`);
  if(row.revision<revision)throw new Error(`got revision ${row.revision}, older than the published revision ${revision}`);
  return{...row,config:validateConfig(data[0].config)};
}
function rulingsUnavailable(){return RULINGS!==null&&RULINGS.status==='hold'}
// Rulings verified earlier this session and kept because the latest load failed: still applied, and always shown as stale.
function rulingsStale(){return RULINGS?.stale===true}
// The ruling state of every game, then the scoring view. Before the first load (RULINGS null) nothing has been fetched,
// so every game is still the configured, ungraded one.
function deriveGames(){
  SLOTS=M.map(([away,home])=>{const ruling=RULINGS?pickemSlotRuling(RULINGS,{week:CFG.week,season:CFG.season,away,home,events:LAST_EVENTS}):{state:'none'};return{ruling,effect:pickemSlotEffect(ruling)}});
  G=NFL.map((game,i)=>pickemEffectiveGame(game,SLOTS[i].effect));
}

// A tracked entry that proves no submission: the full pick list with every pick null, and a null tiebreak.
const isNoSubmission=(p,gameCount)=>Array.isArray(p?.pickNumbers)&&p.pickNumbers.length===gameCount&&p.pickNumbers.every(n=>n===null)&&p?.tiebreak===null;
function validateConfig(c){
  if(!c||c.schemaVersion!==1)throw new Error('Unsupported weekly data');
  if(!Number.isInteger(c.season)||!Number.isInteger(c.week))throw new Error('Invalid season/week');
  if(!Array.isArray(c.games)||c.games.length<1||c.games.length>18)throw new Error('Invalid game list');
  if(!Array.isArray(c.participants)||c.participants.length<2)throw new Error('Invalid participant list');
  if(!Number.isInteger(c.tiebreakGameIndex)||c.tiebreakGameIndex<0||c.tiebreakGameIndex>=c.games.length)throw new Error('Invalid tiebreak game');
  const numbers=new Map();
  c.games.forEach((g,i)=>{
    if(!g||typeof g.away!=='string'||typeof g.home!=='string')throw new Error(`Invalid game ${i+1}`);
    if(!Number.isInteger(g.awayNumber)||!Number.isInteger(g.homeNumber)||g.awayNumber===g.homeNumber)throw new Error(`Invalid pick numbers for game ${i+1}`);
    if(numbers.has(g.awayNumber)||numbers.has(g.homeNumber))throw new Error('Duplicate pick number');
    numbers.set(g.awayNumber,{i,team:norm(g.away)});numbers.set(g.homeNumber,{i,team:norm(g.home)});
  });
  const validateEntry=(p,label,tracked=false)=>{
    if(tracked&&typeof p?.displayName!=='string')throw new Error(`Invalid entry ${label}`);
    const trackedNoSubmission=tracked&&isNoSubmission(p,c.games.length);
    if(trackedNoSubmission)return;
    const geometryValidated=!tracked&&Number(c.fullFieldValidationVersion)>=3,validTiebreak=Number.isInteger(p?.tiebreak)||(geometryValidated&&p?.tiebreak===null);
    if(!Array.isArray(p?.pickNumbers)||p.pickNumbers.length!==c.games.length||!validTiebreak)throw new Error(`Invalid entry ${label}`);
    const seen=new Set();let noPicks=0;
    p.pickNumbers.forEach(n=>{if(!tracked&&n===0){noPicks++;return}const x=numbers.get(n);if(!x)throw new Error(`${label}: unknown pick ${n}`);if(seen.has(x.i))throw new Error(`${label}: multiple picks for game ${x.i+1}`);seen.add(x.i)});
    if(noPicks>(geometryValidated?c.games.length:1))throw new Error(`${label}: too many no-picks`);
    if(seen.size+noPicks!==c.games.length)throw new Error(`${label}: incomplete picks`);
  };
  c.participants.forEach(p=>validateEntry(p,p?.displayName||'tracked',true));
  if(c.fullFieldReady===true){
    if(!Array.isArray(c.fieldEntries)||!c.fieldEntries.length)throw new Error('Full-field ready requires anonymous entries');
    const ids=new Set(),allowed=['id','pickNumbers','tiebreak'].sort();
    c.fieldEntries.forEach((p,i)=>{
      if(!p||typeof p!=='object'||Array.isArray(p))throw new Error(`Invalid field entry ${i+1}`);
      const keys=Object.keys(p).sort();
      if(keys.length!==allowed.length||keys.some((k,ki)=>k!==allowed[ki]))throw new Error('Field entries may contain only id, pickNumbers, and tiebreak');
      if(typeof p.id!=='string'||!p.id||ids.has(p.id))throw new Error(`Invalid field entry ${i+1}`);
      ids.add(p.id);validateEntry(p,`field ${i+1}`);
    });
    const expected=c.participants.length+c.fieldEntries.length;
    if(c.competitionSize!==expected)throw new Error('Competition size mismatch');
    if(c.fullFieldEntryCount!==undefined&&c.fullFieldEntryCount!==c.fieldEntries.length)throw new Error('Full-field entry count mismatch');
  }
  return c;
}
// The config and the identity of the published row it came from are installed together, after validation, and everything
// derived from the previous config is reset (HDC-15: also a newer revision of the same week).
function applyConfig(c,publication){
  CFG=validateConfig(c);PUB=publication;PUB_STALE=null;M=CFG.games.map(g=>[norm(g.away),norm(g.home)]);
  const numberMap=new Map();CFG.games.forEach((g,i)=>{numberMap.set(g.awayNumber,{i,team:norm(g.away)});numberMap.set(g.homeNumber,{i,team:norm(g.home)})});
  const mapTracked=(p,id,name)=>{const picks=Array(M.length).fill(null);p.pickNumbers.forEach(n=>{if(n===null)return;const hit=numberMap.get(n);if(hit)picks[hit.i]=hit.team});return{name,id,mnf:p.tiebreak,picks,pickNumbers:p.pickNumbers.slice(),noSubmission:isNoSubmission(p,M.length)}};
  const mapField=(p,fi)=>{const picks=p.pickNumbers.map((n,i)=>{const g=CFG.games[i];if(n===g.awayNumber)return norm(g.away);if(n===g.homeNumber)return norm(g.home);return null});return{name:null,id:p.id||`field-${fi+1}`,mnf:p.tiebreak,picks,pickNumbers:p.pickNumbers.slice()}};
  P=CFG.participants.map((p,pi)=>mapTracked(p,p.id||String(pi),p.displayName));
  // Only tracked entries that submitted picks take part in the group race while games remain.
  S=P.filter(p=>!p.noSubmission);
  F=(CFG.fieldEntries||[]).map(mapField);
  TIEBREAK_INDEX=CFG.tiebreakGameIndex;NFL=M.map(([away,home])=>({away,home,state:'pre',completed:false,winner:null,awayScore:null,homeScore:null,detail:'Scheduled',eventId:null}));
  RULINGS=null;LAST_EVENTS=null;FEED_ISSUES=[];deriveGames();renderStaticLabels();
}
function formatWeekDates(){
  const dates=(CFG.games||[]).map(g=>g.date||g.sourceDate).filter(Boolean).map(v=>new Date(`${String(v).slice(0,10)}T12:00:00Z`)).filter(d=>!Number.isNaN(d.valueOf()));
  if(!dates.length)return `${CFG.season} season`;const lo=new Date(Math.min(...dates)),hi=new Date(Math.max(...dates));const fmt=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});return lo.valueOf()===hi.valueOf()?`${fmt(lo)}, ${CFG.season}`:`${fmt(lo)}–${fmt(hi)}, ${CFG.season}`;
}
function tiebreakGuess(p){return Number.isInteger(p?.mnf)?String(p.mnf):'NO PICK'}
function tiebreakDiff(p,t){return t.final?(Number.isInteger(p?.mnf)?Math.abs(p.mnf-t.total):Number.POSITIVE_INFINITY):null}
// HDC-15: the week strip names the revision being scored, says when it could not be verified as the current publication,
// and leads with a chosen week that could not be loaded.
function weekLineText(){return`${SWITCH_ERROR?`WEEK ${SWITCH_ERROR.week} UNAVAILABLE · `:''}Week ${CFG.week} · revision ${PUB.revision}${PUB_STALE?' · PUBLISHED DATA STALE':''} · ${formatWeekDates()} · ${P.map(p=>p.name).join(' · ')}`}
function renderWeekLine(){if(CFG)$('weekLine').textContent=weekLineText()}
function renderStaticLabels(){
  $('weekLine').textContent=weekLineText();$('pulseWeek').textContent=`Week ${CFG.week}`;$('entryCount').textContent=fieldAvailable()?CFG.competitionSize:P.length;$('gameCount').textContent=M.length;$('finals').textContent=`0/${M.length}`;$('left').textContent=M.length;$('tbNote').textContent=`Tiebreak guesses: ${P.map(p=>`${p.name} ${tiebreakGuess(p)}`).join(' · ')}.`;$('footerRule').textContent=footerText();
}
// HDC-12: a voided tiebreak game means no tiebreak that week; another game is never chosen after the fact.
const tiebreakVoid=(games=G)=>games[TIEBREAK_INDEX]?.void===true;
function footerText(){const [a,h]=M[TIEBREAK_INDEX];return`Final NFL outcomes only · NFL ties = 0 points · ${tiebreakVoid()?`${a}–${h} tiebreak game voided by commissioner ruling: no tiebreak this week.`:`${a}–${h} tiebreak activates when that game is final.`}${G.some(g=>g.void)?' VOID = removed from scoring by commissioner ruling.':''}${fieldAvailable()?' Full-field entries are stored without competitor names.':''}`}
function stats(p,games=G){return scoreEntry(p.picks,games)}
function tiebreak(games=G){return tiebreakState(games[TIEBREAK_INDEX])}
function rows(games=G){const t=tiebreak(games);return P.map((p,i)=>({...p,...stats(p,games),diff:tiebreakDiff(p,t),i})).sort((a,b)=>b.w-a.w||a.l-b.l||(t.final?a.diff-b.diff:0)||a.i-b.i)}
function topIndices(wins,t=tiebreak(),entries=P){const best=Math.max(...wins);let leaders=wins.map((w,i)=>w===best?i:-1).filter(i=>i>=0);if(t.final&&leaders.length>1){const bestDiff=Math.min(...leaders.map(i=>tiebreakDiff(entries[i],t)));leaders=leaders.filter(i=>tiebreakDiff(entries[i],t)===bestDiff)}return leaders}
function tiedWith(a,b,t=tiebreak()){return a.w===b.w&&a.l===b.l&&(!t.final||a.diff===b.diff)}
function fieldAvailable(){return CFG?.fullFieldReady===true&&Array.isArray(CFG?.fieldEntries)&&Number.isInteger(CFG?.competitionSize)&&CFG.competitionSize===P.length+F.length&&F.length>0}
function allCompetitionEntries(){return fieldAvailable()?[...P.map((p,i)=>({...p,_order:i,_tracked:true})),...F.map((p,i)=>({...p,_order:P.length+i,_tracked:false}))]:[]}
function sameFieldStanding(a,b,t){return !!a&&!!b&&a.w===b.w&&a.l===b.l&&(!t.final||a.diff===b.diff)}
function rankCompetition(games=G){
  if(!fieldAvailable())return null;
  const t=tiebreak(games),all=allCompetitionEntries();
  const ranked=competitionRanks(all.map(p=>({...p,...stats(p,games),diff:tiebreakDiff(p,t)})),{tiebreakFinal:t.final});
  return{rows:ranked,byId:new Map(ranked.map(p=>[p.id,p])),size:ranked.length,bestWins:ranked[0]?.w??0,t};
}
function fieldSnapshot(games=G){
  const base=rankCompetition(games);if(!base)return null;
  const metrics=new Map();
  for(const p of P){
    const current=base.byId.get(p.id);
    const ceilingGames=games.map((g,i)=>g.completed?g:{...g,state:'post',completed:true,winner:p.picks[i],awayScore:null,homeScore:null,detail:'Ceiling simulation'});
    const ceiling=rankCompetition(ceilingGames)?.byId.get(p.id)||current;
    metrics.set(p.id,{
      rank:current.rank,
      tieCount:current.tieCount,
      topPercent:Math.max(1,Math.ceil(current.rank/base.size*100)),
      behind:Math.max(0,base.bestWins-current.w),
      ceilingRank:ceiling.rank,
      ceilingTieCount:ceiling.tieCount,
      aliveForFirst:ceiling.rank===1
    });
  }
  return{...base,metrics};
}
function fieldRankLabel(metric){if(!metric)return'—';return`${metric.tieCount>1?'T-':'#'}${metric.rank}`}
function ceilingRankLabel(metric){if(!metric)return'—';return`${metric.ceilingTieCount>1?'T-':'#'}${metric.ceilingRank}`}
function fieldShare(gameIndex,team){
  if(!fieldAvailable())return null;
  return ownershipShare(allCompetitionEntries(),gameIndex,team,M[gameIndex]||[]);
}
function fieldShareText(gameIndex,team){
  const share=fieldShare(gameIndex,team);if(!share)return'';
  return`${share.pct}% of field`;
}
function fieldShareClass(gameIndex,team){const share=fieldShare(gameIndex,team);return share&&share.pct<=35?' contrarian':''}
function gameIndexForTeam(team){return M.findIndex(([a,h])=>a===team||h===team)}
function state(g){return g.void?'VOID':g.hold?'HOLD':g.completed?(g.winner?'FINAL':'FINAL TIE'):g.state==='in'?(g.detail||'LIVE'):(g.detail||'SCHEDULED')}
// The winners of a resolved week. Only entries that submitted picks can win while any did (an entry that proved no
// submission is never a co-winner, which an all-void week would otherwise allow); with none, every tracked entry, as before.
function finalWinnerIndices(games,t){
  if(!S.length)return topIndices(P.map(p=>stats(p,games).w),t);
  return topIndices(S.map(p=>stats(p,games).w),t,S).map(si=>P.indexOf(S[si]));
}
function teamLogoUrl(t){const team=norm(String(t||'').toUpperCase()),code=ESPN_LOGO_CODE[team]||team.toLowerCase();return`https://a.espncdn.com/i/teamlogos/nfl/500/${encodeURIComponent(code)}.png`}
function badge(t,size=''){const team=norm(String(t||'').toUpperCase());return`<span class="badge${size?` ${size}`:''}" style="--tc:${TEAM_COLORS[team]||'#33465f'}" aria-hidden="true"><span class="badge-fallback">${esc(team)}</span>${team?`<img class="team-logo" src="${teamLogoUrl(team)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">`:''}</span>`}
function pickTeam(t){if(!t)return'<span class="pick-team no-pick"><span>NO PICK</span></span>';const team=norm(String(t).toUpperCase());return`<span class="pick-team">${badge(team,'mini')}<span>${esc(team)}</span></span>`}
function swingIndexes(unfinishedOnly=false,games=G){return M.map((_,i)=>i).filter(i=>new Set(S.map(p=>p.picks[i])).size>1&&(!unfinishedOnly||!games[i].completed))}
function addState(map,wins,count){const key=wins.join(',');map.set(key,(map.get(key)||0)+count)}
function raceStatus(games=G){
  const unfinished=games.map((g,i)=>!g.completed?i:-1).filter(i=>i>=0),swings=swingIndexes(true,games),t=tiebreak(games);
  if(!unfinished.length){const base=P.map(p=>stats(p,games).w),winners=finalWinnerIndices(games,t),co=winners.length>1,coNote=tiebreakVoid(games)?'Co-winner · no tiebreak (tiebreak game void)':'Co-winner · exact tiebreak tied';return{outcomes:1,racePaths:1,items:P.map((p,i)=>({name:p.name,status:winners.includes(i)?'WINNER':'OUT',ceiling:base[i],roots:[],topPaths:winners.includes(i)?1:0,note:winners.includes(i)?(co?coNote:'Pool winner'):'Slate complete'}))}}
  // While games remain the race is run over the submitters alone, exactly as if no-submission entries were not tracked. A
  // no-submission entry has no possible picks: it is OUT, with no ceiling and no rooting chips.
  const outcomes=3**unfinished.length,noPicks=p=>({name:p.name,status:'OUT',ceiling:null,roots:[],topPaths:0,note:'No picks submitted'});
  if(!S.length)return{outcomes,racePaths:1,items:P.map(noPicks)};
  const base=S.map(p=>stats(p,games).w),ceiling=base.map(w=>w+unfinished.length);
  let states=new Map([[base.join(','),1]]);
  for(const gi of swings){const next=new Map();for(const [key,count] of states){const w0=key.split(',').map(Number);addState(next,w0,count);for(const winner of M[gi]){const w=w0.slice();S.forEach((p,si)=>{if(p.picks[gi]===winner)w[si]++});addState(next,w,count)}}states=next}
  const canTop=Array(S.length).fill(false),clinched=Array(S.length).fill(true),topPaths=Array(S.length).fill(0);
  for(const [key,count] of states){const wins=key.split(',').map(Number),leaders=topIndices(wins,t,S);leaders.forEach(si=>{canTop[si]=true;topPaths[si]+=count});for(let si=0;si<S.length;si++)if(!(leaders.length===1&&leaders[0]===si))clinched[si]=false}
  const contenders=S.map((_,i)=>canTop[i]?i:-1).filter(i=>i>=0),activeSwings=swings.filter(gi=>new Set(contenders.map(si=>S[si].picks[gi])).size>1),racePaths=3**activeSwings.length;
  const items=new Map(S.map((p,i)=>{const status=clinched[i]?'CLINCHED':canTop[i]?'ALIVE':'OUT',roots=status==='OUT'?[]:activeSwings.map(gi=>p.picks[gi]);return[p,{name:p.name,status,ceiling:ceiling[i],roots,topPaths:topPaths[i],note:status==='CLINCHED'?'Sole pool win guaranteed':status==='OUT'?'Cannot finish first':`Ceiling ${ceiling[i]} wins`}]}));
  return{outcomes,racePaths,items:P.map(p=>items.get(p)||noPicks(p))};
}
function renderRace(race){
  $('scenarioCount').textContent=race.outcomes===1?'Final':`${race.outcomes.toLocaleString()} outcomes · ${race.racePaths.toLocaleString()} race paths`;
  $('raceList').innerHTML=race.items.map(x=>`<div class="race-row"><div class="race-copy"><div class="race-name">${esc(x.name)}</div><div class="race-sub">${esc(x.note)}</div></div><span class="status-pill ${x.status.toLowerCase()}">${x.status}</span><div class="rooting">${x.roots.length?x.roots.map(t=>{const gi=gameIndexForTeam(t),share=gi>=0?fieldShare(gi,t):null;return`<span class="root-chip${share&&share.pct<=35?' contrarian':''}">${badge(t,'tiny')}${esc(t)}${share?`<span class="field-pct">${share.pct}%</span>`:''}</span>`}).join(''):'<span class="race-sub">—</span>'}</div></div>`).join('');
}
function simulateGame(games,i,winner){return games.map((g,gi)=>gi===i?{...g,state:'post',completed:true,winner:winner||null,awayScore:null,homeScore:null,detail:winner?'Simulated final':'Simulated tie'}:{...g})}
function unknownTiebreakImpact(games,baseRace,before){const wins=S.map(p=>stats(p,games).w),best=Math.max(...wins),leaders=wins.map((w,i)=>w===best?i:-1).filter(i=>i>=0),leaderNames=leaders.map(i=>S[i].name),active=baseRace.items.filter(x=>x.status!=='OUT').map(x=>x.name),newlyOut=active.filter(name=>!leaderNames.includes(name));if(leaders.length===1){const sole=leaderNames[0];if(!['CLINCHED','WINNER'].includes(before.get(sole)))return`clinches ${sole} by record`;if(newlyOut.length)return`eliminates ${newlyOut.join(', ')} · ${sole} leads by record`;return`${sole} leads by record`}if(newlyOut.length)return`eliminates ${newlyOut.join(', ')} · tiebreak total decides ${leaderNames.join(', ')}`;return`tiebreak total decides ${leaderNames.join(', ')}`}
function impactText(i,winner,baseRace){const games=simulateGame(G,i,winner),before=new Map(baseRace.items.map(x=>[x.name,x.status]));if(i===TIEBREAK_INDEX&&games.every(g=>g.completed)&&!tiebreak(games).final)return unknownTiebreakImpact(games,baseRace,before);const sim=raceStatus(games),after=new Map(sim.items.map(x=>[x.name,x.status])),clinched=P.filter(p=>['CLINCHED','WINNER'].includes(after.get(p.name))&&!['CLINCHED','WINNER'].includes(before.get(p.name))).map(p=>p.name),out=P.filter(p=>after.get(p.name)==='OUT'&&before.get(p.name)!=='OUT').map(p=>p.name);if(clinched.length)return`clinches ${clinched.join(', ')}`;if(out.length)return`eliminates ${out.join(', ')}`;const active=baseRace.items.filter(x=>x.status!=='OUT').map(x=>x.name);if(!winner)return active.length?`0 pts to all · ${active.length} contender${active.length===1?'':'s'} remain`:'0 pts to all';const helps=P.filter(p=>active.includes(p.name)&&p.picks[i]===winner).map(p=>p.name),hurts=P.filter(p=>active.includes(p.name)&&p.picks[i]!==winner).map(p=>p.name);return helps.length&&hurts.length?`helps ${helps.join(', ')} · hurts ${hurts.join(', ')}`:helps.length?`helps ${helps.join(', ')} · no active counterpick`:'no active-race leverage'}
function pickerNames(i,team,race){const status=new Map(race.items.map(x=>[x.name,x.status]));return P.filter(p=>p.picks[i]===team).map(p=>status.get(p.name)==='OUT'?`<span class="picker eliminated">${esc(p.name)} · OUT</span>`:`<span class="picker">${esc(p.name)}</span>`).join('<span class="sep"> · </span>')}
function renderSwings(race){
  const ids=swingIndexes(true);$('swingMeta').textContent=`${ids.length} left`;$('swingLeft').textContent=ids.length;
  if(!ids.length){$('swingList').innerHTML='<div class="empty">No swing games remain. The race is decided by finalized results and, if needed, the tiebreak.</div>';return}
  $('swingList').innerHTML=ids.map(i=>{
    const g=G[i],show=g.state==='in',as=score(g.awayScore),hs=score(g.homeScore),awayShare=fieldShare(i,g.away),homeShare=fieldShare(i,g.home);
    const awayField=awayShare?`<div class="field-share${awayShare.pct<=35?' contrarian':''}">${awayShare.pct}% of ${awayShare.total} entries</div>`:'';
    const homeField=homeShare?`<div class="field-share${homeShare.pct<=35?' contrarian':''}">${homeShare.pct}% of ${homeShare.total} entries</div>`:'';
    return`<div class="swing-item"><div class="swing-side"><div class="swing-team">${badge(g.away)} ${esc(g.away)}</div><div class="pickers">${pickerNames(i,g.away,race)}</div>${awayField}</div><div class="swing-mid"><div class="swing-state">${esc(state(g))}</div><div class="swing-score">${show?`${as??'—'}–${hs??'—'}`:'vs'}</div></div><div class="swing-side home"><div class="swing-team">${esc(g.home)} ${badge(g.home)}</div><div class="pickers">${pickerNames(i,g.home,race)}</div>${homeField}</div><div class="impact-grid"><div class="impact"><b>${esc(g.away)}</b> ${esc(impactText(i,g.away,race))}</div><div class="impact"><b>${esc(g.home)}</b> ${esc(impactText(i,g.home,race))}</div><div class="impact tie-impact"><b>TIE</b> ${esc(impactText(i,null,race))}</div></div></div>`;
  }).join('');
}
function gameOrder(){const rank=g=>g.state==='in'?0:!g.completed?1:2;return G.map((g,i)=>({g,i})).sort((a,b)=>rank(a.g)-rank(b.g)||a.i-b.i)}
// HDC-12: the participant-visible Rules & rulings card.
function rulesHtml(m){
  if(!m)return'<div class="empty">Loading contest rules and rulings…</div>';
  if(m.state!=='ready')return`<div class="rules-alert rules-${m.state}"><b>${esc(m.heading)}</b><p>${esc(m.text)}</p></div><p class="rules-confirm">${esc(m.confirmation)}</p>`;
  const policy=m.policy?`<div class="rules-block"><span class="rules-label">Halted-game policy</span><b>${esc(m.policy.name)}</b><small>Policy revision ${m.policy.revision} · in force from Week ${m.policy.effectiveWeek}</small><p>${esc(m.policy.text)}</p>${m.policy.publicNote?`<p class="rules-note">${esc(m.policy.publicNote)}</p>`:''}</div>`:'';
  const revisions=m.revisions.length>1?`<p class="rules-meta">Policy history: ${m.revisions.map(r=>`revision ${r.revision}, ${esc(r.name)}, from Week ${r.effectiveWeek}`).join(' · ')}</p>`:'';
  const incidents=m.incidents.length?m.incidents.map(x=>`<div class="rules-incident rules-${x.status.toLowerCase().replace(/\s+/g,'-')}"><div class="rules-incident-head"><b>Week ${x.week} · ${esc(x.matchup)}</b><span class="rules-status">${esc(x.status)}</span></div><p>${esc(x.detail)}</p>${x.review?`<p class="rules-review">${esc(x.review)}</p>`:''}${x.evidence?`<small>${esc(x.evidence)}</small>`:''}${x.history.length?`<ol class="rules-history">${x.history.map(h=>`<li>${esc(h.label)}${h.date?` · ${esc(h.date)}`:''}${h.note?` · ${esc(h.note)}`:''}</li>`).join('')}</ol>`:''}</div>`).join(''):`<div class="empty">${esc(m.empty)}</div>`;
  return`<div class="rules-grid"><div class="rules-block"><span class="rules-label">Contest</span><b>${esc(m.contestName)}</b><small>${esc(m.contestType)}</small></div>${policy}</div>${revisions}<p class="rules-confirm">${esc(m.confirmation)}</p>${m.stale?`<p class="rules-stale">${esc(m.stale)}</p>`:''}${incidents}`;
}
// A ruling's state as the card shows it: its published game's slot; withdrawn, which has no consequence anywhere; otherwise
// HOLD, because a ruling that matches no published game (another opponent, or no published team at all) is invalid here.
function cardSlot(x){
  const i=M.findIndex(([a,h])=>a===x.away&&h===x.home);
  if(i>=0)return SLOTS[i].ruling;
  if(x.state==='withdrawn')return{state:'withdrawn'};
  return{state:'hold',reason:M.some(([a,h])=>[a,h].some(t=>t===x.away||t===x.home))?'it does not match the published game':'it does not match a published game in this contest'};
}
function render(){
  if(!CFG)return;
  deriveGames();
  // HDC-12: a void game is resolved (complete, not remaining) but is not an NFL final; held games are not resolved.
  const nflFinals=G.filter(g=>g.completed&&!g.void).length,voids=G.filter(g=>g.void).length,onHold=rulingsUnavailable(),tbVoid=tiebreakVoid();
  const r=rows(),lead=r[0],f=nflFinals+voids,live=G.filter(g=>g.state==='in'&&!g.completed).length,t=tiebreak(),finalWinners=f===M.length?finalWinnerIndices(G,t):[],race=raceStatus(),field=fieldSnapshot();
  const unprojected=tbVoid?' · no tiebreak this week (tiebreak game void)':t.final?'':' · unresolved tiebreak not projected';
  let rank=1;
  $('fieldSummary').textContent=field?`${field.size} entries · field names anonymized`:'Full-field data unavailable for this week.';
  $('standings').innerHTML=r.map((p,i)=>{
    if(i&&!tiedWith(p,r[i-1],t))rank=i+1;
    const leadTie=tiedWith(p,lead,t),fm=field?.metrics.get(p.id),overall=fm?fieldRankLabel(fm):'—',back=fm?(fm.behind?fm.behind:'—'):'—',ceiling=fm?ceilingRankLabel(fm):'—';
    const overallSub=fm?`<span class="standing-sub">Top ${fm.topPercent}% · ${fm.tieCount>1?`${fm.tieCount} tied`:'solo'}</span>`:'<span class="standing-sub">field unavailable</span>';
    const ceilingSub=fm?`<span class="standing-sub">WIN CEILING${unprojected}</span>`:'';
    const tb=Number.isInteger(p.mnf)?String(p.mnf):'—',tbDelta=Number.isFinite(p.diff)?`<span class="standing-sub">Δ ${p.diff}</span>`:'';return`<tr class="${leadTie?'leadrow':''}"><td>${rank}</td><td class="entry">${esc(p.name)}</td><td class="c"><span class="standing-overall">${overall}</span>${overallSub}</td><td class="c w">${p.w}</td><td class="c l">${p.l}</td><td class="c">${p.left}</td><td class="c">${back}</td><td class="c"><span class="standing-overall">${ceiling}</span>${ceilingSub}</td><td class="c">${tb}${tbDelta}</td></tr>`;
  }).join('');

  if($('homeStandings')){
    let hrank=1;
    $('homeStandings').innerHTML=r.map((p,i)=>{
      if(i&&!tiedWith(p,r[i-1],t))hrank=i+1;
      const leadTie=tiedWith(p,lead,t),fm=field?.metrics.get(p.id);
      const fieldHtml=fm?`<span class="home-field"><b>${fieldRankLabel(fm)} / ${field.size}</b><small>Top ${fm.topPercent}% · ${fm.behind?`${fm.behind} back`:'field lead'} · win ceiling ${ceilingRankLabel(fm)}${unprojected}</small></span>`:`<span class="home-left">${p.left} left</span>`;
      return`<div class="home-standing-row ${leadTie?'lead':''}"><span class="home-rank">${hrank}</span><span class="home-entry">${esc(p.name)}</span><span class="home-record">${p.w}–${p.l}</span>${fieldHtml}</div>`;
    }).join('');
  }

  const orderedGames=gameOrder();
  // A void or held game shows the NFL fact (scores where the feed has them) with the pool's ruling state, never a winner
  // and never FINAL TIE.
  const ruled=(g,i)=>{const fact=NFL[i],show=fact.state==='in'||fact.completed,as=score(fact.awayScore),hs=score(fact.homeScore);
    const label=g.void?`VOID · Commissioner ruling${g.underReview?' · UNDER REVIEW':''}`:`HOLD · ${SLOTS[i].effect.scope==='contest'?'Ruling data unavailable':'Ruling information unusable'}`;
    return`<div class="game ${g.void?`void${g.underReview?' review':''}`:'hold'}"><div class="team">${badge(g.away)}<span class="abbr">${esc(g.away)}</span>${show?`<span class="score">${as??'—'}</span>`:''}</div><div class="status">${esc(label)}</div><div class="team home">${show?`<span class="score">${hs??'—'}</span>`:''}<span class="abbr">${esc(g.home)}</span>${badge(g.home)}</div></div>`};
  const gameMarkup=(g,i)=>{if(g.void||g.hold)return ruled(g,i);const show=g.state==='in'||g.completed,cl=g.completed?(g.winner?'final':'final tie'):g.state==='in'?'live':'pre',as=score(g.awayScore),hs=score(g.homeScore);return`<div class="game ${cl}"><div class="team ${g.winner===g.away?'winner':''}">${badge(g.away)}<span class="abbr">${esc(g.away)}</span>${show?`<span class="score">${as??'—'}</span>`:''}</div><div class="status">${esc(state(g))}</div><div class="team home ${g.winner===g.home?'winner':''}">${show?`<span class="score">${hs??'—'}</span>`:''}<span class="abbr">${esc(g.home)}</span>${badge(g.home)}</div></div>`};
  $('gamegrid').innerHTML=orderedGames.map(({g,i})=>gameMarkup(g,i)).join('');
  if($('homeGamePreview'))$('homeGamePreview').innerHTML=orderedGames.slice(0,3).map(({g,i})=>gameMarkup(g,i)).join('');

  $('pickHead').innerHTML='<tr><th class="name">Entry</th>'+M.map(([a,h],i)=>{
    const away=fieldShare(i,a),home=fieldShare(i,h),ownership=away&&home?`<div class="matchup-ownership"><span>${away.pct}%</span><span>${home.pct}%</span></div>`:'';
    return`<th class="c matchup-head"><span class="matchup-team">${badge(a,'tiny')}${esc(a)}</span><span class="matchup-slash">/</span><span class="matchup-team">${badge(h,'tiny')}${esc(h)}</span>${ownership}</th>`;
  }).join('')+'</tr>';
  $('pickBody').innerHTML=P.map(p=>'<tr><td class="name">'+esc(p.name)+'</td>'+p.picks.map((pick,i)=>{const g=G[i];if(g.void||g.hold)return`<td class="c ${g.void?'void':'hold'}"><span class="pick-choice">${pickTeam(pick)}<span class="pick-result">${g.void?'VOID':'HOLD'}</span></span></td>`;const done=g.completed,ok=done&&g.winner&&pick===g.winner,tie=done&&!g.winner;return`<td class="c ${tie?'neutral':done?(ok?'ok':'bad'):'pending'}"><span class="pick-choice">${pickTeam(pick)}<span class="pick-result">${tie?'0':done?(ok?'✓':'✕'):''}</span></span></td>`}).join('')+'</tr>').join('');

  $('finals').textContent=voids?`${nflFinals}/${M.length} · ${voids} void`:`${nflFinals}/${M.length}`;$('liveCount').textContent=live;$('left').textContent=M.length-f;$('mnf').textContent=tbVoid?'VOID':t.total==null?'—':t.total+(t.final?'':'*');
  if(onHold){
    $('leaderKicker').textContent='ON HOLD';$('leaderName').textContent='Ruling data unavailable';$('leaderRecord').textContent='—';
    $('leaderNote').textContent='Standings are on hold: the contest rules and rulings could not be loaded or verified, so no game is graded from the NFL feed alone.';
  }else if(f===M.length&&finalWinners.length>1){
    $('leaderName').textContent=finalWinners.map(i=>P[i].name).join(' / ');$('leaderRecord').textContent=`${lead.w}–${lead.l}`;$('leaderKicker').textContent='Group co-winners';$('leaderNote').textContent=tbVoid?'Your tracked entries are tied. The tiebreak game was voided by commissioner ruling, so there is no tiebreak this week: tied leaders are co-winners.':'Your tracked entries are tied after the configured tiebreak.';
  }else{
    const tiedLeaders=lead?r.filter(x=>tiedWith(x,lead,t)):[],ties=tiedLeaders.length,fm=lead&&field?field.metrics.get(lead.id):null;
    $('leaderName').textContent=ties>1?tiedLeaders.map(x=>x.name).join(' / '):(lead?.name||'—');$('leaderRecord').textContent=lead?`${lead.w}–${lead.l}`:'0–0';$('leaderKicker').textContent=f===M.length?'Group winner':ties>1?'Tracked leaders':'Group leader';
    $('leaderNote').textContent=fm?`${ties>1?`${ties} tracked entries tied · `:''}Overall ${fieldRankLabel(fm)} of ${field.size} · Top ${fm.topPercent}% · ${fm.behind?`${fm.behind} back`:'at the field lead'} · win ceiling ${ceilingRankLabel(fm)}${unprojected}.`:ties>1&&!t.final?`${ties} tracked entries are tied${tbVoid?' and there is no tiebreak this week (tiebreak game void)':''}. Full-field data is not published for this week.`:`${nflFinals} of ${M.length} games are final${voids?` · ${voids} void by commissioner ruling`:''}. Full-field data is not published for this week.`;
  }
  $('bestWins').textContent=field?.bestWins??lead?.w??0;
  const pc=Math.round(f/M.length*100);$('progressText').textContent=`${pc}%`;$('progressBar').style.width=`${pc}%`;
  $('tbNote').textContent=tbVoid?'Tiebreak game voided by commissioner ruling: no tiebreak this week. Standings use the scored record only, and tied leaders are co-winners.':t.final?`Tiebreak final total: ${t.total}. Tiebreak differences are active.`:`Tiebreak guesses: ${P.map(p=>`${p.name} ${tiebreakGuess(p)}`).join(' · ')}.`;
  $('footerRule').textContent=footerText();
  const rulesBox=$('pickemRules');
  if(rulesBox)rulesBox.innerHTML=rulesHtml(RULINGS?rulesModel(RULINGS,{week:CFG.week,slotState:cardSlot}):null);
  renderRace(race);renderSwings(race);
}
function warn(list,{hold=null,notes=[],stale=false}={}){const e=$('error');e.replaceChildren();const add=(cls,text)=>{const b=document.createElement('div');b.className=cls;b.textContent=text;e.appendChild(b)};if(list.length)add('error',`Some feed data was ignored to protect standings: ${list.join(' · ')}`);if(hold)add('error rules-hold-banner',`ON HOLD · Ruling data unavailable (${hold}). Standings are on hold until the contest rules and rulings load; no game is graded from the NFL feed alone.`);if(stale)add('notice rules-stale-banner','RULINGS STALE · The contest rules and rulings could not be refreshed just now. The rulings last verified on this page still apply until they load again.');if(notes.length)add('notice rules-review-banner',`UNDER REVIEW · ${notes.join(' · ')}`);if(PUB_STALE)add('notice publication-stale-banner',`PUBLISHED DATA STALE · ${PUB_STALE.reason}. The standings still use Week ${PUB.week} revision ${PUB.revision}, the last publication verified on this page, until the current one loads.`);if(SWITCH_ERROR)add('error week-switch-banner',`Unable to switch Pick'em week: ${SWITCH_ERROR.season} Week ${SWITCH_ERROR.week} could not be loaded (${SWITCH_ERROR.message}). Week ${PUB.week} stays on screen.`)}
// HDC-12: the warnings, hold and review notes for this refresh. A void game is resolved by its ruling, so its HDC-11
// "awaiting a pool ruling" warning no longer applies; every other HDC-09/10 warning stays, protection unchanged. A held game
// is ungraded and says why. A void the feed now contradicts stays applied and is UNDER REVIEW. Rulings kept from an earlier
// load are marked stale in the header and a notice. HDC-14: a game missing from this week's feed is resolved only by an
// applied, unreviewed VOID whose evidence is the commissioner's attestation of that absence; a missing game under any other
// ruling (or none) still warns.
const absenceResolves=slot=>slot?.effect.kind==='void'&&!slot.effect.underReview&&isAbsenceEvidence(slot.effect.incident?.evidence);
function report(fetchedAt){
  const warnings=[],notes=[];
  for(const x of FEED_ISSUES)if(!(x.halted&&SLOTS[x.i]?.effect.kind==='void')&&!(x.missing&&absenceResolves(SLOTS[x.i])))warnings.push(x.text);
  SLOTS.forEach(({effect},i)=>{const [a,h]=M[i];if(effect.kind==='hold'&&effect.scope!=='contest')warnings.push(`${a}-${h}: ruling on hold (${effect.reason}), not graded`);if(effect.kind==='void'&&effect.underReview)notes.push(`${a}-${h}: VOID by commissioner ruling stays applied; ${effect.underReview}`)});
  const hold=rulingsUnavailable()?RULINGS.reason:null,stale=rulingsStale();
  warn(warnings,{hold,notes,stale});setSync(fetchedAt,warnings,{hold:!!hold,review:notes.length>0,stale});
}
function exactCompetitorPair(e){
  const competitions=Array.isArray(e?.competitions)?e.competitions:[];
  if(competitions.length!==1)return null;
  const competitors=Array.isArray(competitions[0]?.competitors)?competitions[0].competitors:[];
  if(competitors.length!==2)return null;
  const away=competitors.filter(x=>x?.homeAway==='away'),home=competitors.filter(x=>x?.homeAway==='home');
  if(away.length!==1||home.length!==1)return null;
  return{away:away[0],home:home[0]};
}
// A completed event is graded only when the final evidence the feed exposes agrees with it, exactly as survivor-math.js
// requires before Survivor resolves a pick: the event state is 'post'; a status name, where given, names a FINAL and no
// halted game; the competition status does not explicitly contradict the event; no winner flag claims a team that did
// not outscore its opponent. Absent evidence is compatible. A contradiction keeps the last verified game and warns.
const HALTED_STATUS=/CANCEL|POSTPON|SUSPEND|FORFEIT/i;
const nonFinalName=name=>name!==undefined&&name!==null&&(typeof name!=='string'||!/FINAL/i.test(name)||HALTED_STATUS.test(name));
function finalEvidenceIssue(e,away,home,as,hs){
  const type=e.status.type,comp=e.competitions[0].status?.type;
  if(type.state!=='post'||nonFinalName(type.name))return 'status';
  if(comp&&(comp.completed===false||(typeof comp.state==='string'&&comp.state!=='post')||nonFinalName(comp.name)))return 'status';
  if((away.winner===true&&!(as>hs))||(home.winner===true&&!(hs>as)))return 'winner flag';
  return null;
}
// HDC-11: an event that is not completed but whose status, at the event or competition level, explicitly names a halted game
// (canceled, postponed, suspended, forfeit) stays ungraded exactly as before. parseEvent also warns, naming the matchup and
// the status, so the sync label reads INCOMPLETE while the week awaits a pool ruling or official resolution. Absent or
// non-string names never halt a game, and a completed event is judged only as a final (finalEvidenceIssue).
function haltedStatus(e){for(const name of [e.status?.type?.name,e.competitions[0].status?.type?.name])if(typeof name==='string'&&HALTED_STATUS.test(name))return name;return null}
function parseEvent(e,a,h,old,tiebreakGame=false){const pair=exactCompetitorPair(e);if(!pair)return{game:old,warning:`${a}-${h}: malformed competitor data ignored`};const {away,home}=pair,st=e.status?.type?.state||'pre',done=e.status?.type?.completed===true,as=score(away.score),hs=score(home.score);if((st==='in'||done)&&(as===null||hs===null))return{game:old,warning:`${a}-${h}: invalid score ignored`};const issue=done?finalEvidenceIssue(e,away,home,as,hs):null;if(issue)return{game:old,warning:`${a}-${h}: final with contradictory ${issue} ignored`};const tied=done&&as===hs,halted=done?null:haltedStatus(e);return{halted:!!halted,game:{away:a,home:h,state:st,completed:done,winner:done&&!tied?(as>hs?a:h):null,awayScore:as,homeScore:hs,detail:String(e.status?.type?.shortDetail||e.status?.type?.detail||(done?(tied?'Final · Tie':'Final'):'Scheduled')),eventId:e.id?String(e.id):old.eventId},warning:halted?`${a}-${h}: ${tiebreakGame?'tiebreak game':'game'} halted (${halted}), not graded; awaiting a pool ruling or official resolution`:null}}
function eventContextWarning(e,a,h){
  const season=e?.season?.year,seasonType=e?.season?.type,week=e?.week?.number;
  if(season!=null&&Number(season)!==CFG.season)return `${a}-${h}: feed season ${season} does not match ${CFG.season}`;
  if(seasonType!=null&&Number(seasonType)!==2)return `${a}-${h}: feed season type ${seasonType} is not regular season`;
  if(week!=null&&Number(week)!==CFG.week)return `${a}-${h}: feed week ${week} does not match ${CFG.week}`;
  return null;
}
function selectEvent(events,a,h,old){const q=events.filter(e=>{const c=e?.competitions?.[0],competitors=Array.isArray(c?.competitors)?c.competitors:[],x=competitors.find(v=>v?.homeAway==='away'),y=competitors.find(v=>v?.homeAway==='home');return norm(x?.team?.abbreviation)===a&&norm(y?.team?.abbreviation)===h});if(!q.length)return{event:null,warning:`${a}-${h}: expected game missing from feed`,missing:true};if(q.length!==1)return{event:null,warning:`${a}-${h}: duplicate events ignored`};const e=q[0],pair=exactCompetitorPair(e);if(!pair||norm(pair.away?.team?.abbreviation)!==a||norm(pair.home?.team?.abbreviation)!==h)return{event:null,warning:`${a}-${h}: malformed competitor data ignored`};const contextWarning=eventContextWarning(e,a,h);if(contextWarning)return{event:null,warning:contextWarning};if(old.eventId&&e.id&&String(e.id)!==String(old.eventId))return{event:null,warning:`${a}-${h}: event identity changed`};return{event:e,warning:null}}
function ageSeconds(ts){const ms=Date.parse(ts);if(!Number.isFinite(ms))return null;const delta=Date.now()-ms;if(delta<-60000)return null;return Math.max(0,Math.floor(delta/1000))}
// HDC-15: published data that could not be verified is never LIVE: it takes LIVE's (or DELAYED's) place and rides along with
// every more serious state, which keeps its precedence.
function setSync(fetchedAt,warnings=[],{hold=false,review=false,stale=false}={}){lastFetchedAt=typeof fetchedAt==='string'?fetchedAt:null;const age=ageSeconds(lastFetchedAt),delayed=age===null||age>30,incomplete=warnings.length>0,published=PUB_STALE!==null,label=hold?'ON HOLD':incomplete?'INCOMPLETE':review?'UNDER REVIEW':published?'PUBLISHED DATA STALE':delayed?'DELAYED':'LIVE',ageText=age===null?'age unknown':`data ${age}s old`;$('sync').textContent=`${label}${published&&label!=='PUBLISHED DATA STALE'?' · PUBLISHED DATA STALE':''}${stale?' · RULINGS STALE':''} · ${ageText}${warnings.length?` · ${warnings.length} warning${warnings.length===1?'':'s'}`:''}`;$('dot').style.background=hold?'var(--red)':incomplete||delayed||review||stale||published?'var(--gold)':'var(--green)'}
async function feed(signal){const url=`${ESPN_SCOREBOARD}?dates=${CFG.season}&seasontype=2&week=${CFG.week}&limit=100&_=${Date.now()}`,r=await fetch(url,{signal,cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`ESPN ${r.status}`);const j=await r.json();if(!j||!Array.isArray(j.events))throw new Error('invalid ESPN payload');return{fetchedAt:new Date().toISOString(),events:j.events}}
// Each refresh reads the scores and the contest's rules and rulings together. The protected feed path reads and writes
// only the NFL facts (NFL[i] is the last verified game and carries the event id the HDC-09 guard compares); the scoring
// view is derived again on every render. A rulings load that fails keeps rulings already verified this session, shown as
// RULINGS STALE; with none, the contest holds and nothing is graded from the NFL feed alone. HDC-15: it runs inside a refresh
// generation (refresh() or a week switch), which owns the abort controller and the REFRESH button.
async function update(id,signal){try{const [scores,rulings]=await Promise.allSettled([feed(signal),CFG.season<FIRST_RULING_SEASON?Promise.resolve(null):loadRulings(signal)]);if(id!==gen)return;if(rulings.status==='rejected')console.warn(rulings.reason);RULINGS=evaluateContestRulings({contestId:contestIdFor(CFG.season,'pickem'),contestType:'pickem',season:CFG.season,...(rulings.status==='fulfilled'?{data:rulings.value}:{error:rulings.reason}),previous:RULINGS});if(scores.status==='rejected')throw scores.reason;const j=scores.value,issues=[],next=M.map(([a,h],i)=>{const s=selectEvent(j.events,a,h,NFL[i]);if(s.warning)issues.push({i,text:s.warning,missing:s.missing===true});if(!s.event)return NFL[i];const p=parseEvent(s.event,a,h,NFL[i],i===TIEBREAK_INDEX);if(p.warning)issues.push({i,text:p.warning,halted:p.halted});return p.game});if(id!==gen)return;NFL=next;LAST_EVENTS=j.events;FEED_ISSUES=issues;render();report(j.fetchedAt)}catch(e){if(e?.name==='AbortError'||id!==gen)return;render();const staleText=`${PUB_STALE?' · PUBLISHED DATA STALE':''}${rulingsStale()?' · RULINGS STALE':''}`;$('sync').textContent=lastFetchedAt?`FEED UNAVAILABLE${staleText} · last good ${ageSeconds(lastFetchedAt)??'?'}s ago`:`FEED UNAVAILABLE${staleText}`;$('dot').style.background='var(--red)';warn(['Automatic score refresh failed. Existing results are preserved; tap REFRESH to retry.'],{hold:rulingsUnavailable()?RULINGS.reason:null,stale:rulingsStale()})}}
// HDC-15. A full refresh: verify that the config on screen is still the published revision of its week (a newer revision is
// loaded and validated before it replaces it whole), then read the scores and the rules and rulings for whatever config is
// active. One generation covers both, so a later refresh or week switch supersedes all of it.
async function refresh({verify=true}={}){
  if(!CFG)return;
  const id=++gen;if(ctl)ctl.abort();const c=new AbortController;ctl=c;refreshStartedAt=Date.now();switching=false;
  $('refresh').disabled=true;$('sync').textContent='Updating…';
  try{if(verify)await verifyPublication(id,c.signal);if(id===gen)await update(id,c.signal)}
  finally{if(id===gen){$('refresh').disabled=false;if(ctl===c)ctl=null}}
}
// The index says which weeks are published and at which revision. An unchanged revision downloads nothing more; a changed one
// downloads that week's full row only. Anything that cannot be verified (the index or the row unavailable, malformed,
// ambiguous, not that week, or going backwards) leaves the last verified config on screen, marked PUBLISHED DATA STALE, and
// is retried by the next refresh.
async function verifyPublication(id,signal){
  let index,row;
  try{index=await loadPublicationIndex(signal)}
  catch(e){if(e?.name!=='AbortError'&&id===gen)markStale(`the published week list could not be checked (${e.message||e})`);return}
  if(id!==gen)return;
  const entry=index.find(x=>x.season===PUB.season&&x.week===PUB.week);
  if(!entry){markStale(`${PUB.season} Week ${PUB.week} is no longer listed as published`);return}
  if(entry.revision<PUB.revision){markStale(`the published revision went back from ${PUB.revision} to ${entry.revision}`);return}
  showWeeks(index);
  if(entry.revision===PUB.revision){markVerified();return}
  try{row=await loadPublishedWeek(entry,signal)}
  catch(e){if(e?.name!=='AbortError'&&id===gen)markStale(`revision ${entry.revision} is published but could not be loaded (${e.message||e})`);return}
  if(id===gen)installPublication(row);
}
function markStale(reason){PUB_STALE={reason};renderWeekLine()}
function markVerified(){PUB_STALE=null;renderWeekLine()}
// The selector lists the published weeks in the index's order; the week on screen stays selected, so a newly published week
// appears without moving the participant or the URL.
function showWeeks(index,selected=PUB){
  const key=x=>`${x.season}-${x.week}`,select=$('weekSelect');
  if(index.map(key).join()!==PUB_WEEKS.map(key).join()){select.innerHTML=index.map(x=>`<option value="${key(x)}">${x.season} · Week ${x.week}</option>`).join('');select.value=key(selected)}
  PUB_WEEKS=index;
}
// A validated row replaces the config on screen whole (the initial/choose path); it renders at once as one revision.
function installPublication(row){applyConfig(row.config,{season:row.season,week:row.week,revision:row.revision,publishedAt:row.publishedAt});warn([]);render()}
// A chosen week replaces the week on screen only once its exact published row has loaded and validated. A failed load keeps
// the week on screen, puts the selector back, says so (until the next choice), and refreshes the week on screen as usual.
async function switchWeek(season,week){
  if(PUB&&season===PUB.season&&week===PUB.week){if(switching)void refresh();return}
  const id=++gen;if(ctl)ctl.abort();const c=new AbortController;ctl=c;refreshStartedAt=Date.now();switching=true;SWITCH_ERROR=null;
  $('refresh').disabled=true;if(CFG)$('sync').textContent='Updating…';
  try{
    let row;
    try{row=await loadPublishedWeek({season,week,revision:PUB_WEEKS.find(x=>x.season===season&&x.week===week)?.revision??1},c.signal)}
    catch(e){
      if(e?.name==='AbortError'||id!==gen)return;
      switching=false;console.warn(e);
      if(!CFG){$('error').innerHTML=`<div class="error">Unable to load weekly pool data: ${esc(e.message||String(e))}</div>`;return}
      $('weekSelect').value=`${PUB.season}-${PUB.week}`;SWITCH_ERROR={season,week,message:e.message||String(e)};renderWeekLine();
      await verifyPublication(id,c.signal);if(id===gen)await update(id,c.signal);
      return;
    }
    if(id!==gen)return;
    switching=false;installPublication(row);
    const u=new URL(location.href);u.searchParams.set('season',String(season));u.searchParams.set('week',String(week));history.replaceState(history.state,'',u);
    await update(id,c.signal);
  }finally{if(id===gen){switching=false;$('refresh').disabled=false;if(ctl===c)ctl=null}}
}
// Timer refreshes, resume and view activation refresh only the active Pick'em view of a visible page, decided before any
// request is made, and join a refresh that is already running (unless it has stalled) instead of starting a second one.
function autoRefresh(){if(CFG&&document.visibilityState==='visible'&&document.body.dataset.view!=='survivor'&&!switching&&(!ctl||Date.now()-refreshStartedAt>=STALL_MS))void refresh()}
// HDC-15: boot reads the publication index, chooses the requested (or latest) week, and installs that week's full row once it
// has validated; the scores and the rules and rulings follow. The selector is filled from the index first, so another week
// can still be chosen if this one cannot be loaded; a week chosen while it loads takes the page over, and boot then installs
// and reports nothing.
async function loadWeeks(){
  const index=await loadPublicationIndex();if(!index.length)throw new Error('No published pool weeks found');
  const qs=new URLSearchParams(location.search),requested=Number(qs.get('week')),season=Number(qs.get('season'))||Math.max(...index.map(x=>x.season));let chosen=requested?index.find(x=>x.season===season&&x.week===requested):null;if(!chosen)chosen=index[index.length-1];
  const select=$('weekSelect');showWeeks(index,chosen);select.addEventListener('change',()=>{const [s,w]=select.value.split('-').map(Number);void switchWeek(s,w)});
  const bootGen=gen;let row;
  try{row=await loadPublishedWeek(chosen)}catch(e){if(gen!==bootGen)return;throw e}
  if(gen!==bootGen)return;
  applyConfig(row.config,{season:row.season,week:row.week,revision:row.revision,publishedAt:row.publishedAt});render();await refresh({verify:false});
}
setupViewNavigation();
$('refresh').addEventListener('click',()=>void refresh());
document.addEventListener('visibilitychange',autoRefresh);
loadWeeks().catch(e=>{$('sync').textContent='CONFIG UNAVAILABLE';$('dot').style.background='var(--red)';$('error').innerHTML=`<div class="error">Unable to load weekly pool data: ${esc(e.message)}</div>`;console.error(e)});
setInterval(autoRefresh,20000);
