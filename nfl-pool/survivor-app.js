'use strict';

import {survivorEntryState,survivorPickDistribution,survivorSummary,survivorWeekProgress,survivorFieldAvailability,survivorDecisionOptions,survivorMarketMatchups,normalizeSurvivorCode} from './survivor-math.js?v=3';

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ESPN_SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const LOGO_CODE={WAS:'wsh'};
let rows=[],cfg=null,resultsByWeek=[],nextWeekMatchups=[],nextWeekFetchedAt=0,nextWeekError='',anonToken=null,anonExpiresAt=0,anonRequest=null,refreshId=0;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

function jwtExpiry(token){try{const part=token.split('.')[1],json=atob(part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'=')),exp=Number(JSON.parse(json)?.exp);return Number.isFinite(exp)?exp*1000:0}catch{return 0}}
async function anonymousToken(){if(anonToken&&Date.now()<anonExpiresAt-60000)return anonToken;if(!anonRequest){anonRequest=fetch(`${NEON_AUTH_URL}/token/anonymous`,{cache:'no-store',headers:{Accept:'application/json'}}).then(async r=>{if(!r.ok)throw new Error(`anonymous auth ${r.status}`);const j=await r.json();if(!j?.token)throw new Error('anonymous auth returned no token');anonToken=j.token;anonExpiresAt=jwtExpiry(anonToken)||Date.now()+5*60*1000;return anonToken}).finally(()=>{anonRequest=null})}return anonRequest}

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

function logo(team){const code=(LOGO_CODE[team]||team.toLowerCase());return`https://a.espncdn.com/i/teamlogos/nfl/500/${code}.png`}
function teamChip(team){return team?`<span class="survivor-team"><img src="${logo(team)}" alt=""><b>${esc(team)}</b></span>`:'<span class="survivor-none">NO PICK</span>'}
function allEntries(){return cfg?[...cfg.trackedEntries,...cfg.fieldEntries]:[]}

function buildResults(events){
  const map=new Map();
  for(const event of events||[]){
    const c=event?.competitions?.[0],away=c?.competitors?.find(x=>x.homeAway==='away'),home=c?.competitors?.find(x=>x.homeAway==='home');
    if(!away||!home)continue;
    const a=normalizeSurvivorCode(away.team?.abbreviation),h=normalizeSurvivorCode(home.team?.abbreviation),done=event.status?.type?.completed===true,state=event.status?.type?.state||'pre';
    const as=Number(away.score),hs=Number(home.score),scoresOk=Number.isFinite(as)&&Number.isFinite(hs),tie=done&&scoresOk&&as===hs,winner=done&&scoresOk&&!tie?(as>hs?a:h):null;
    map.set(a,{completed:done,state,winner,tie,opponent:h});map.set(h,{completed:done,state,winner,tie,opponent:a});
  }
  return map;
}

function marketLabel(option){
  if(!option.favorite)return 'No market favorite';
  return Number.isFinite(option.spread)?`Favorite -${option.spread}`:'Market favorite';
}
function optionRow(option){
  const where=option.home?'vs':'@',avail=option.fieldDenominator?`${option.fieldAvailable}/${option.fieldDenominator} can use · ${option.fieldAvailablePct}%`:'field availability unavailable';
  return `<div class="survivor-option-row"><div>${teamChip(option.team)}<span class="survivor-opponent">${where} ${esc(option.opponent)}</span></div><div class="survivor-option-meta"><b>${esc(marketLabel(option))}</b><span>${esc(avail)}</span></div></div>`;
}
function renderDecision(summary){
  const box=$('svDecisionEntries');if(!box||!cfg)return;
  const nextWeekIndex=cfg.week,nextWeek=cfg.week+1,entries=allEntries();
  $('svDecisionWeek').textContent=`Week ${nextWeek}`;
  if(summary.pending>0){$('svDecisionNote').textContent='Decision support is provisional until every current-week Survivor result is final.';box.innerHTML='<div class="empty">Waiting for the current week to settle before calculating the next-week surviving field.</div>';return}
  if(!nextWeekMatchups.length){$('svDecisionNote').textContent=nextWeekError||`Week ${nextWeek} schedule/market data has not loaded yet.`;box.innerHTML='<div class="empty">Week-ahead schedule unavailable. Burned-team history remains unchanged.</div>';return}
  const teams=nextWeekMatchups.flatMap(m=>[m.away,m.home]),availability=survivorFieldAvailability(entries,nextWeekIndex,resultsByWeek,teams);
  $('svDecisionNote').textContent='Field availability = share of surviving entries that have not already burned that team. It is not projected pick ownership.';
  box.innerHTML=cfg.trackedEntries.map(entry=>{
    const support=survivorDecisionOptions(entry,nextWeekIndex,resultsByWeek,nextWeekMatchups,availability),burned=support.burned.map(team=>`<span class="survivor-burned-chip">${esc(team)}</span>`).join('')||'<span class="survivor-none">None</span>';
    if(!support.eligible)return `<article class="survivor-decision-entry survivor-decision-out"><div class="survivor-decision-head"><div><span class="section-kicker">${esc(entry.displayName)}</span><h3>Out of Survivor</h3></div><span class="status-pill survivor-out">OUT</span></div><div class="survivor-burned"><span>Burned</span>${burned}</div><p>${esc(support.reason||'Entry is eliminated.')}</p></article>`;
    const favorites=support.options.filter(x=>x.favorite).sort((a,b)=>(b.spread||0)-(a.spread||0)||a.fieldAvailablePct-b.fieldAvailablePct||a.team.localeCompare(b.team));
    const safer=favorites.slice(0,4),leveragePool=favorites.length?favorites:support.options;
    const leverage=leveragePool.slice().sort((a,b)=>a.fieldAvailablePct-b.fieldAvailablePct||(b.spread||0)-(a.spread||0)||a.team.localeCompare(b.team)).slice(0,4);
    return `<article class="survivor-decision-entry"><div class="survivor-decision-head"><div><span class="section-kicker">${esc(entry.displayName)}</span><h3>Week ${nextWeek} Board</h3></div><span class="status-pill survivor-alive">ELIGIBLE</span></div><div class="survivor-burned"><span>Burned</span>${burned}</div><div class="survivor-board-grid"><div><h4>Safer favorites</h4><p>Market signal only; strongest available favorite first.</p>${safer.length?safer.map(optionRow).join(''):'<div class="empty">No market-favorite lines are available yet.</div>'}</div><div><h4>Field leverage</h4><p>Lower availability means fewer surviving entries can still use that team.</p>${leverage.length?leverage.map(optionRow).join(''):'<div class="empty">No legal Week-ahead options available.</div>'}</div></div></article>`;
  }).join('');
}

function statusLabel(state){
  return state.status==='alive'?'ALIVE':state.status==='live'?'LIVE':state.status==='pending'?'PENDING':'OUT';
}
function render(){
  if(!cfg)return;
  const entries=allEntries(),wi=cfg.week-1,summary=survivorSummary(entries,wi,resultsByWeek),dist=survivorPickDistribution(entries,wi,resultsByWeek),progress=survivorWeekProgress(entries,wi,resultsByWeek);
  $('svPoolSize').textContent=cfg.competitionSize;$('svEntered').textContent=summary.entered;$('svStillIn').textContent=summary.active;$('svPending').textContent=summary.pending;
  $('svSummaryNote').textContent=`${summary.eliminatedBefore} eliminated before Week ${cfg.week} · ${summary.eligibleEntering} eligible entering · ${summary.submitted} submitted · ${summary.entered} legal picks · ${summary.eliminatedThisWeek} eliminated this week so far.`;
  $('svTracked').innerHTML=cfg.trackedEntries.map(entry=>{
    const state=survivorEntryState(entry,wi,resultsByWeek),current=state.eliminatedWeek&&state.eliminatedWeek<cfg.week?entry.picks[state.eliminatedWeek-1]:entry.picks[wi],history=entry.picks.map((pick,i)=>`<span class="survivor-history-chip"><small>W${i+1}</small>${pick?esc(pick):'—'}</span>`).join('');
    return`<div class="survivor-tracked-row"><div><b>${esc(entry.displayName)}</b><div class="survivor-history">${history}</div></div><div class="survivor-current">${teamChip(current)}<span class="status-pill survivor-${state.status}">${statusLabel(state)}</span><small>${esc(state.reason)}</small></div></div>`;
  }).join('');
  $('svDistribution').innerHTML=dist.length?dist.map(item=>`<div class="survivor-pick-row"><div>${teamChip(item.team)}</div><div class="survivor-bar"><i style="width:${item.pct}%"></i></div><b>${item.count}</b><span>${item.pct}%</span></div>`).join(''):'<div class="empty">No eligible entries have a Week pick.</div>';
  $('svProgress').innerHTML=progress.map(x=>`<div class="survivor-week-step"><span>Week ${x.week}</span><b>${x.remaining}</b><small>${x.eligibleEntering} eligible · ${x.submitted} submitted · ${x.entered} legal · ${x.eliminated} out</small></div>`).join('');
  renderDecision(summary);
  $('svMeta').textContent=`Week ${cfg.week} · revision ${rows.find(r=>r.config===cfg)?.revision||'—'}`;
}

async function updateDecisionSchedule(force=false){
  if(!cfg)return;
  if(!force&&nextWeekMatchups.length&&Date.now()-nextWeekFetchedAt<300000){render();return}
  try{
    const week=cfg.week+1,r=await fetch(`${ESPN_SCOREBOARD}?dates=${cfg.season}&week=${week}&seasontype=2`,{cache:'no-store'});
    if(!r.ok)throw new Error(`Week ${week} schedule ${r.status}`);
    const j=await r.json(),matchups=survivorMarketMatchups(j.events);
    if(!matchups.length)throw new Error(`Week ${week} schedule is not available yet`);
    nextWeekMatchups=matchups;nextWeekFetchedAt=Date.now();nextWeekError='';render();
  }catch(e){nextWeekError=e.message||String(e);if(!nextWeekMatchups.length)render();console.warn(e)}
}

async function updateScores(){
  if(!cfg)return;const id=++refreshId;
  try{
    const indexes=Array.from({length:cfg.week},(_,i)=>i).filter(i=>i===cfg.week-1||!resultsByWeek[i]);
    const payloads=await Promise.all(indexes.map(async i=>{
      const week=i+1,r=await fetch(`${ESPN_SCOREBOARD}?dates=${cfg.season}&week=${week}&seasontype=2`,{cache:'no-store'});
      if(!r.ok)throw new Error(`Week ${week} score feed ${r.status}`);return{i,json:await r.json()};
    }));
    if(id!==refreshId)return;
    for(const {i,json} of payloads)resultsByWeek[i]=buildResults(json.events);
    $('svFeed').textContent='LIVE · NFL results';$('svFeed').className='survivor-feed ok';render();void updateDecisionSchedule();
  }catch(e){if(id!==refreshId)return;$('svFeed').textContent='RESULT FEED UNAVAILABLE';$('svFeed').className='survivor-feed warn';render();console.warn(e)}
}

function choose(row,{push=false}={}){
  cfg=validateConfig(row.config);resultsByWeek=[];nextWeekMatchups=[];nextWeekFetchedAt=0;nextWeekError='';$('survivorWeekSelect').value=`${row.season}-${row.week}`;render();updateScores();
  if(push){const u=new URL(location.href);u.searchParams.set('view','survivor');u.searchParams.set('sw',String(row.week));u.searchParams.set('season',String(row.season));history.replaceState(history.state,'',u)}
}

async function load(){
  const token=await anonymousToken(),url=`${NEON_DATA_URL}/nfl_survivor_weeks?select=season,week,status,config,revision,published_at&status=eq.locked&order=season.asc,week.asc`,r=await fetch(url,{cache:'no-store',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  if(!r.ok)throw new Error(`Survivor data ${r.status}`);rows=await r.json();if(!Array.isArray(rows)||!rows.length)throw new Error('No published Survivor weeks found');
  const sel=$('survivorWeekSelect');sel.innerHTML=rows.map(x=>`<option value="${x.season}-${x.week}">${x.season} · Week ${x.week}</option>`).join('');
  const qs=new URLSearchParams(location.search),requested=Number(qs.get('sw')),season=Number(qs.get('season'))||rows[rows.length-1].season;let chosen=requested?rows.find(x=>x.season===season&&x.week===requested):null;if(!chosen)chosen=rows[rows.length-1];
  sel.addEventListener('change',()=>{const [s,w]=sel.value.split('-').map(Number),row=rows.find(x=>x.season===s&&x.week===w);if(row)choose(row,{push:true})});
  choose(chosen);
}

load().catch(e=>{$('survivorError').innerHTML=`<div class="error">Survivor is not published yet: ${esc(e.message)}</div>`;console.warn(e)});
setInterval(()=>{if(cfg&&document.body.dataset.view==='survivor')updateScores()},20000);
