'use strict';

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ESPN_SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const TEAM_COLORS={ARI:'#97233F',ATL:'#A71930',BAL:'#241773',BUF:'#00338D',CAR:'#0085CA',CHI:'#0B162A',CIN:'#FB4F14',CLE:'#311D00',DAL:'#003594',DEN:'#FB4F14',DET:'#0076B6',GB:'#203731',HOU:'#03202F',IND:'#002C5F',JAX:'#006778',KC:'#E31837',LV:'#111',LAC:'#0080C6',LAR:'#003594',MIA:'#008E97',MIN:'#4F2683',NE:'#002244',NO:'#B3995D',NYG:'#0B2265',NYJ:'#125740',PHI:'#004C54',PIT:'#FFB612',SF:'#AA0000',SEA:'#002244',TB:'#D50A0A',TEN:'#4B92DB',WAS:'#5A1414'};
const ALIAS={JAC:'JAX',WSH:'WAS'};
const ESPN_LOGO_CODE={WAS:'wsh'};

let CFG=null,M=[],P=[],TIEBREAK_INDEX=0,G=[],gen=0,ctl=null,lastFetchedAt=null,anonToken=null,anonExpiresAt=0,anonRequest=null;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=x=>ALIAS[x]||x;
const score=x=>{let n;if(typeof x==='string'){const v=x.trim();if(!v||!/^\d+$/.test(v))return null;n=Number(v)}else if(typeof x==='number')n=x;else return null;return Number.isFinite(n)&&Number.isInteger(n)&&n>=0?n:null};
const VALID_VIEWS=new Set(['home','standings','games','picks']);
function currentView(){const q=new URLSearchParams(location.search).get('view');return VALID_VIEWS.has(q)?q:'home'}
function setView(view,{push=false,scroll=true}={}){
  const next=VALID_VIEWS.has(view)?view:'home';
  document.querySelectorAll('[data-view-panel]').forEach(panel=>{panel.hidden=panel.dataset.viewPanel!==next});
  document.querySelectorAll('[data-view-target]').forEach(btn=>{if(btn.closest('.bottom-nav'))btn.setAttribute('aria-current',btn.dataset.viewTarget===next?'page':'false')});
  document.body.dataset.view=next;
  document.title=next==='home'?'Pool Center':`Pool Center · ${next[0].toUpperCase()+next.slice(1)}`;
  if(push){const u=new URL(location.href);u.searchParams.set('view',next);history.pushState({view:next},'',u)}
  document.querySelectorAll('.app-menu[open]').forEach(menu=>menu.removeAttribute('open'));
  if(scroll)window.scrollTo({top:0,behavior:'smooth'});
}
function setupViewNavigation(){
  document.addEventListener('click',event=>{const hit=event.target.closest('[data-view-target]');if(!hit)return;event.preventDefault();setView(hit.dataset.viewTarget,{push:true})});
  window.addEventListener('popstate',()=>setView(currentView(),{push:false,scroll:false}));
  setView(currentView(),{push:false,scroll:false});
}

function jwtExpiry(token){try{const part=token.split('.')[1],json=atob(part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'=')),exp=Number(JSON.parse(json)?.exp);return Number.isFinite(exp)?exp*1000:0}catch{return 0}}
async function anonymousToken(){if(anonToken&&Date.now()<anonExpiresAt-60000)return anonToken;if(!anonRequest){anonRequest=fetch(`${NEON_AUTH_URL}/token/anonymous`,{cache:'no-store',headers:{Accept:'application/json'}}).then(async r=>{if(!r.ok)throw new Error(`anonymous auth ${r.status}`);const j=await r.json();if(!j?.token)throw new Error('anonymous auth returned no token');anonToken=j.token;anonExpiresAt=jwtExpiry(anonToken)||Date.now()+5*60*1000;return anonToken}).finally(()=>{anonRequest=null})}return anonRequest}

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
    numbers.set(g.awayNumber,{i,team:g.away});numbers.set(g.homeNumber,{i,team:g.home});
  });
  c.participants.forEach(p=>{
    if(typeof p.displayName!=='string'||!Array.isArray(p.pickNumbers)||p.pickNumbers.length!==c.games.length||!Number.isInteger(p.tiebreak))throw new Error(`Invalid entry ${p?.displayName||''}`);
    const seen=new Set();
    p.pickNumbers.forEach(n=>{const x=numbers.get(n);if(!x)throw new Error(`${p.displayName}: unknown pick ${n}`);if(seen.has(x.i))throw new Error(`${p.displayName}: multiple picks for game ${x.i+1}`);seen.add(x.i)});
    if(seen.size!==c.games.length)throw new Error(`${p.displayName}: incomplete picks`);
  });
  return c;
}
function applyConfig(c){
  CFG=validateConfig(c);M=CFG.games.map(g=>[norm(g.away),norm(g.home)]);
  const numberMap=new Map();CFG.games.forEach((g,i)=>{numberMap.set(g.awayNumber,{i,team:norm(g.away)});numberMap.set(g.homeNumber,{i,team:norm(g.home)})});
  P=CFG.participants.map((p,pi)=>{const picks=Array(M.length).fill(null);p.pickNumbers.forEach(n=>{const hit=numberMap.get(n);picks[hit.i]=hit.team});return{name:p.displayName,id:p.id||String(pi),mnf:p.tiebreak,picks,pickNumbers:p.pickNumbers.slice()}});
  TIEBREAK_INDEX=CFG.tiebreakGameIndex;G=M.map(([away,home])=>({away,home,state:'pre',completed:false,winner:null,awayScore:null,homeScore:null,detail:'Scheduled',eventId:null}));renderStaticLabels();
}
function formatWeekDates(){
  const dates=(CFG.games||[]).map(g=>g.date||g.sourceDate).filter(Boolean).map(v=>new Date(`${String(v).slice(0,10)}T12:00:00Z`)).filter(d=>!Number.isNaN(d.valueOf()));
  if(!dates.length)return `${CFG.season} season`;const lo=new Date(Math.min(...dates)),hi=new Date(Math.max(...dates));const fmt=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});return lo.valueOf()===hi.valueOf()?`${fmt(lo)}, ${CFG.season}`:`${fmt(lo)}–${fmt(hi)}, ${CFG.season}`;
}
function renderStaticLabels(){
  $('weekLine').textContent=`Week ${CFG.week} · ${formatWeekDates()} · ${P.map(p=>p.name).join(' · ')}`;$('pulseWeek').textContent=`Week ${CFG.week}`;$('entryCount').textContent=P.length;$('gameCount').textContent=M.length;$('finals').textContent=`0/${M.length}`;$('left').textContent=M.length;$('tbNote').textContent=`Tiebreak guesses: ${P.map(p=>`${p.name} ${p.mnf}`).join(' · ')}.`;const [a,h]=M[TIEBREAK_INDEX];$('footerRule').textContent=`Final NFL outcomes only · NFL ties = 0 points · ${a}–${h} tiebreak activates when that game is final.`;
}
function stats(p,games=G){let w=0,l=0,left=0;games.forEach((g,i)=>{if(g.completed){if(g.winner)p.picks[i]===g.winner?w++:l++}else left++});return{w,l,left}}
function tiebreak(games=G){const g=games[TIEBREAK_INDEX],a=score(g?.awayScore),h=score(g?.homeScore),ok=a!==null&&h!==null;return{final:!!(g?.completed&&ok),total:ok&&(g.state==='in'||g.completed)?a+h:null}}
function rows(games=G){const t=tiebreak(games);return P.map((p,i)=>({...p,...stats(p,games),diff:t.final?Math.abs(p.mnf-t.total):null,i})).sort((a,b)=>b.w-a.w||a.l-b.l||(t.final?a.diff-b.diff:0)||a.i-b.i)}
function topIndices(wins,t=tiebreak()){const best=Math.max(...wins);let leaders=wins.map((w,i)=>w===best?i:-1).filter(i=>i>=0);if(t.final&&leaders.length>1){const bestDiff=Math.min(...leaders.map(i=>Math.abs(P[i].mnf-t.total)));leaders=leaders.filter(i=>Math.abs(P[i].mnf-t.total)===bestDiff)}return leaders}
function tiedWith(a,b,t=tiebreak()){return a.w===b.w&&a.l===b.l&&(!t.final||a.diff===b.diff)}
function state(g){return g.completed?(g.winner?'FINAL':'FINAL TIE'):g.state==='in'?(g.detail||'LIVE'):(g.detail||'SCHEDULED')}
function teamLogoUrl(t){const team=norm(String(t||'').toUpperCase()),code=ESPN_LOGO_CODE[team]||team.toLowerCase();return`https://a.espncdn.com/i/teamlogos/nfl/500/${encodeURIComponent(code)}.png`}
function badge(t,size=''){const team=norm(String(t||'').toUpperCase());return`<span class="badge${size?` ${size}`:''}" style="--tc:${TEAM_COLORS[team]||'#33465f'}"><span class="badge-fallback">${esc(team)}</span><img class="team-logo" src="${teamLogoUrl(team)}" alt="${esc(team)} logo" loading="lazy" decoding="async" onerror="this.hidden=true"></span>`}
function pickTeam(t){const team=norm(String(t||'').toUpperCase());return`<span class="pick-team">${badge(team,'mini')}<span>${esc(team)}</span></span>`}
function swingIndexes(unfinishedOnly=false,games=G){return M.map((_,i)=>i).filter(i=>new Set(P.map(p=>p.picks[i])).size>1&&(!unfinishedOnly||!games[i].completed))}
function addState(map,wins,count){const key=wins.join(',');map.set(key,(map.get(key)||0)+count)}
function raceStatus(games=G){
  const unfinished=games.map((g,i)=>!g.completed?i:-1).filter(i=>i>=0),swings=swingIndexes(true,games),base=P.map(p=>stats(p,games).w),t=tiebreak(games),ceiling=base.map(w=>w+unfinished.length);
  if(!unfinished.length){const winners=topIndices(base,t),co=winners.length>1;return{outcomes:1,racePaths:1,items:P.map((p,i)=>({name:p.name,status:winners.includes(i)?'WINNER':'OUT',ceiling:base[i],roots:[],topPaths:winners.includes(i)?1:0,note:winners.includes(i)?(co?'Co-winner · exact tiebreak tied':'Pool winner'):'Slate complete'}))}}
  let states=new Map([[base.join(','),1]]);
  for(const gi of swings){const next=new Map();for(const [key,count] of states){const w0=key.split(',').map(Number);addState(next,w0,count);for(const winner of M[gi]){const w=w0.slice();P.forEach((p,pi)=>{if(p.picks[gi]===winner)w[pi]++});addState(next,w,count)}}states=next}
  const canTop=Array(P.length).fill(false),clinched=Array(P.length).fill(true),topPaths=Array(P.length).fill(0);
  for(const [key,count] of states){const wins=key.split(',').map(Number),leaders=topIndices(wins,t);leaders.forEach(pi=>{canTop[pi]=true;topPaths[pi]+=count});for(let pi=0;pi<P.length;pi++)if(!(leaders.length===1&&leaders[0]===pi))clinched[pi]=false}
  const contenders=P.map((_,i)=>canTop[i]?i:-1).filter(i=>i>=0),activeSwings=swings.filter(gi=>new Set(contenders.map(pi=>P[pi].picks[gi])).size>1),racePaths=3**activeSwings.length,outcomes=3**unfinished.length;
  return{outcomes,racePaths,items:P.map((p,i)=>{const status=clinched[i]?'CLINCHED':canTop[i]?'ALIVE':'OUT',roots=status==='OUT'?[]:activeSwings.map(gi=>p.picks[gi]);return{name:p.name,status,ceiling:ceiling[i],roots,topPaths:topPaths[i],note:status==='CLINCHED'?'Sole pool win guaranteed':status==='OUT'?'Cannot finish first':`Ceiling ${ceiling[i]} wins`}})};
}
function renderRace(race){$('scenarioCount').textContent=race.outcomes===1?'Final':`${race.outcomes.toLocaleString()} outcomes · ${race.racePaths.toLocaleString()} race paths`;$('raceList').innerHTML=race.items.map(x=>`<div class="race-row"><div class="race-copy"><div class="race-name">${esc(x.name)}</div><div class="race-sub">${esc(x.note)}</div></div><span class="status-pill ${x.status.toLowerCase()}">${x.status}</span><div class="rooting">${x.roots.length?x.roots.map(t=>`<span class="root-chip">${badge(t,'tiny')}${esc(t)}</span>`).join(''):'<span class="race-sub">—</span>'}</div></div>`).join('')}
function simulateGame(games,i,winner){return games.map((g,gi)=>gi===i?{...g,state:'post',completed:true,winner:winner||null,awayScore:null,homeScore:null,detail:winner?'Simulated final':'Simulated tie'}:{...g})}
function unknownTiebreakImpact(games,baseRace,before){const wins=P.map(p=>stats(p,games).w),best=Math.max(...wins),leaders=wins.map((w,i)=>w===best?i:-1).filter(i=>i>=0),leaderNames=leaders.map(i=>P[i].name),active=baseRace.items.filter(x=>x.status!=='OUT').map(x=>x.name),newlyOut=active.filter(name=>!leaderNames.includes(name));if(leaders.length===1){const sole=leaderNames[0];if(!['CLINCHED','WINNER'].includes(before.get(sole)))return`clinches ${sole} by record`;if(newlyOut.length)return`eliminates ${newlyOut.join(', ')} · ${sole} leads by record`;return`${sole} leads by record`}if(newlyOut.length)return`eliminates ${newlyOut.join(', ')} · tiebreak total decides ${leaderNames.join(', ')}`;return`tiebreak total decides ${leaderNames.join(', ')}`}
function impactText(i,winner,baseRace){const games=simulateGame(G,i,winner),before=new Map(baseRace.items.map(x=>[x.name,x.status]));if(i===TIEBREAK_INDEX&&games.every(g=>g.completed)&&!tiebreak(games).final)return unknownTiebreakImpact(games,baseRace,before);const sim=raceStatus(games),after=new Map(sim.items.map(x=>[x.name,x.status])),clinched=P.filter(p=>['CLINCHED','WINNER'].includes(after.get(p.name))&&!['CLINCHED','WINNER'].includes(before.get(p.name))).map(p=>p.name),out=P.filter(p=>after.get(p.name)==='OUT'&&before.get(p.name)!=='OUT').map(p=>p.name);if(clinched.length)return`clinches ${clinched.join(', ')}`;if(out.length)return`eliminates ${out.join(', ')}`;const active=baseRace.items.filter(x=>x.status!=='OUT').map(x=>x.name);if(!winner)return active.length?`0 pts to all · ${active.length} contender${active.length===1?'':'s'} remain`:'0 pts to all';const helps=P.filter(p=>active.includes(p.name)&&p.picks[i]===winner).map(p=>p.name),hurts=P.filter(p=>active.includes(p.name)&&p.picks[i]!==winner).map(p=>p.name);return helps.length&&hurts.length?`helps ${helps.join(', ')} · hurts ${hurts.join(', ')}`:helps.length?`helps ${helps.join(', ')} · no active counterpick`:'no active-race leverage'}
function pickerNames(i,team,race){const status=new Map(race.items.map(x=>[x.name,x.status]));return P.filter(p=>p.picks[i]===team).map(p=>status.get(p.name)==='OUT'?`<span class="picker eliminated">${esc(p.name)} · OUT</span>`:`<span class="picker">${esc(p.name)}</span>`).join('<span class="sep"> · </span>')}
function renderSwings(race){const ids=swingIndexes(true);$('swingMeta').textContent=`${ids.length} left`;$('swingLeft').textContent=ids.length;if(!ids.length){$('swingList').innerHTML='<div class="empty">No swing games remain. The race is decided by finalized results and, if needed, the tiebreak.</div>';return}$('swingList').innerHTML=ids.map(i=>{const g=G[i],show=g.state==='in',as=score(g.awayScore),hs=score(g.homeScore);return`<div class="swing-item"><div class="swing-side"><div class="swing-team">${badge(g.away)} ${esc(g.away)}</div><div class="pickers">${pickerNames(i,g.away,race)}</div></div><div class="swing-mid"><div class="swing-state">${esc(state(g))}</div><div class="swing-score">${show?`${as??'—'}–${hs??'—'}`:'vs'}</div></div><div class="swing-side home"><div class="swing-team">${esc(g.home)} ${badge(g.home)}</div><div class="pickers">${pickerNames(i,g.home,race)}</div></div><div class="impact-grid"><div class="impact"><b>${esc(g.away)}</b> ${esc(impactText(i,g.away,race))}</div><div class="impact"><b>${esc(g.home)}</b> ${esc(impactText(i,g.home,race))}</div><div class="impact tie-impact"><b>TIE</b> ${esc(impactText(i,null,race))}</div></div></div>`}).join('')}
function gameOrder(){const rank=g=>g.state==='in'?0:!g.completed?1:2;return G.map((g,i)=>({g,i})).sort((a,b)=>rank(a.g)-rank(b.g)||a.i-b.i)}
function render(){
  if(!CFG)return;const r=rows(),lead=r[0],f=G.filter(g=>g.completed).length,live=G.filter(g=>g.state==='in'&&!g.completed).length,t=tiebreak(),finalWinners=f===M.length?topIndices(P.map(p=>stats(p).w),t):[],race=raceStatus();let rank=1;
  $('standings').innerHTML=r.map((p,i)=>{if(i&&!tiedWith(p,r[i-1],t))rank=i+1;const leadTie=tiedWith(p,lead,t);return`<tr class="${leadTie?'leadrow':''}"><td>${rank}</td><td class="entry">${esc(p.name)}</td><td class="c w">${p.w}</td><td class="c l">${p.l}</td><td class="c">${p.left}</td><td class="c">${p.mnf}</td><td class="c">${p.diff??'—'}</td></tr>`}).join('');
  if($('homeStandings')){let hrank=1;$('homeStandings').innerHTML=r.map((p,i)=>{if(i&&!tiedWith(p,r[i-1],t))hrank=i+1;const leadTie=tiedWith(p,lead,t);return`<div class="home-standing-row ${leadTie?'lead':''}"><span class="home-rank">${hrank}</span><span class="home-entry">${esc(p.name)}</span><span class="home-record">${p.w}–${p.l}</span><span class="home-left">${p.left} left</span></div>`}).join('')}
  const orderedGames=gameOrder();
  const gameMarkup=g=>{const show=g.state==='in'||g.completed,cl=g.completed?(g.winner?'final':'final tie'):g.state==='in'?'live':'pre',as=score(g.awayScore),hs=score(g.homeScore);return`<div class="game ${cl}"><div class="team ${g.winner===g.away?'winner':''}">${badge(g.away)}<span class="abbr">${esc(g.away)}</span>${show?`<span class="score">${as??'—'}</span>`:''}</div><div class="status">${esc(state(g))}</div><div class="team home ${g.winner===g.home?'winner':''}">${show?`<span class="score">${hs??'—'}</span>`:''}<span class="abbr">${esc(g.home)}</span>${badge(g.home)}</div></div>`};
  $('gamegrid').innerHTML=orderedGames.map(({g})=>gameMarkup(g)).join('');
  if($('homeGamePreview'))$('homeGamePreview').innerHTML=orderedGames.slice(0,3).map(({g})=>gameMarkup(g)).join('');
  $('pickHead').innerHTML='<tr><th class="name">Entry</th>'+M.map(([a,h])=>`<th class="c matchup-head"><span class="matchup-team">${badge(a,'tiny')}${esc(a)}</span><span class="matchup-slash">/</span><span class="matchup-team">${badge(h,'tiny')}${esc(h)}</span></th>`).join('')+'</tr>';
  $('pickBody').innerHTML=P.map(p=>'<tr><td class="name">'+esc(p.name)+'</td>'+p.picks.map((pick,i)=>{const g=G[i],done=g.completed,ok=done&&g.winner&&pick===g.winner,tie=done&&!g.winner;return`<td class="c ${tie?'neutral':done?(ok?'ok':'bad'):'pending'}"><span class="pick-choice">${pickTeam(pick)}<span class="pick-result">${tie?'0':done?(ok?'✓':'✕'):''}</span></span></td>`}).join('')+'</tr>').join('');
  $('finals').textContent=`${f}/${M.length}`;$('liveCount').textContent=live;$('left').textContent=M.length-f;$('mnf').textContent=t.total==null?'—':t.total+(t.final?'':'*');
  if(f===M.length&&finalWinners.length>1){$('leaderName').textContent=finalWinners.map(i=>P[i].name).join(' / ');$('leaderRecord').textContent=`${lead.w}–${lead.l}`;$('leaderKicker').textContent='Co-winners';$('leaderNote').textContent='Exact tiebreak is tied; no secondary tiebreak is defined.'}else{$('leaderName').textContent=lead?.name||'—';$('leaderRecord').textContent=lead?`${lead.w}–${lead.l}`:'0–0';$('leaderKicker').textContent=f===M.length?'Pool winner':'Current leader';const ties=lead?r.filter(x=>tiedWith(x,lead,t)).length:0;$('leaderNote').textContent=ties>1&&!t.final?`${ties} entries are tied. The designated game total remains reserved for the final tiebreaker.`:`${f} of ${M.length} games are final.`}
  $('bestWins').textContent=lead?.w??0;const pc=Math.round(f/M.length*100);$('progressText').textContent=`${pc}%`;$('progressBar').style.width=`${pc}%`;$('tbNote').textContent=t.final?`Tiebreak final total: ${t.total}. Tiebreak differences are active.`:`Tiebreak guesses: ${P.map(p=>`${p.name} ${p.mnf}`).join(' · ')}.`;renderRace(race);renderSwings(race);
}
function warn(list){const e=$('error');e.replaceChildren();if(!list.length)return;const b=document.createElement('div');b.className='error';b.textContent=`Some feed data was ignored to protect standings: ${list.join(' · ')}`;e.appendChild(b)}
function parseEvent(e,a,h,old){const c=e?.competitions?.[0],away=c?.competitors?.find(x=>x.homeAway==='away'),home=c?.competitors?.find(x=>x.homeAway==='home');if(!away||!home)return{game:old,warning:`${a}-${h}: missing competitor data`};const st=e.status?.type?.state||'pre',done=e.status?.type?.completed===true,as=score(away.score),hs=score(home.score);if((st==='in'||done)&&(as===null||hs===null))return{game:old,warning:`${a}-${h}: invalid score ignored`};const tied=done&&as===hs;return{game:{away:a,home:h,state:st,completed:done,winner:done&&!tied?(as>hs?a:h):null,awayScore:as,homeScore:hs,detail:String(e.status?.type?.shortDetail||e.status?.type?.detail||(done?(tied?'Final · Tie':'Final'):'Scheduled')),eventId:e.id?String(e.id):old.eventId},warning:null}}
function selectEvent(events,a,h,old){const q=events.filter(e=>{const c=e?.competitions?.[0],x=c?.competitors?.find(v=>v.homeAway==='away'),y=c?.competitors?.find(v=>v.homeAway==='home');return norm(x?.team?.abbreviation)===a&&norm(y?.team?.abbreviation)===h});if(!q.length)return{event:null,warning:`${a}-${h}: expected game missing from feed`};if(q.length!==1)return{event:null,warning:`${a}-${h}: duplicate events ignored`};const e=q[0];if(old.eventId&&e.id&&String(e.id)!==String(old.eventId))return{event:null,warning:`${a}-${h}: event identity changed`};return{event:e,warning:null}}
function ageSeconds(ts){const ms=Date.parse(ts);if(!Number.isFinite(ms))return null;const delta=Date.now()-ms;if(delta<-60000)return null;return Math.max(0,Math.floor(delta/1000))}
function setSync(fetchedAt,warnings=[]){lastFetchedAt=typeof fetchedAt==='string'?fetchedAt:null;const age=ageSeconds(lastFetchedAt),delayed=age===null||age>30,incomplete=warnings.length>0,label=incomplete?'INCOMPLETE':delayed?'DELAYED':'LIVE',ageText=age===null?'age unknown':`data ${age}s old`;$('sync').textContent=`${label} · ${ageText}${warnings.length?` · ${warnings.length} warning${warnings.length===1?'':'s'}`:''}`;$('dot').style.background=incomplete||delayed?'var(--gold)':'var(--green)'}
async function feed(signal){const url=`${ESPN_SCOREBOARD}?dates=${CFG.season}&seasontype=2&week=${CFG.week}&limit=100&_=${Date.now()}`,r=await fetch(url,{signal,cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`ESPN ${r.status}`);const j=await r.json();if(!j||!Array.isArray(j.events))throw new Error('invalid ESPN payload');return{fetchedAt:new Date().toISOString(),events:j.events}}
async function update(){if(!CFG)return;const id=++gen;if(ctl)ctl.abort();const c=new AbortController;ctl=c;$('refresh').disabled=true;$('sync').textContent='Updating…';try{const j=await feed(c.signal);if(id!==gen)return;const warnings=[],next=M.map(([a,h],i)=>{const s=selectEvent(j.events,a,h,G[i]);if(s.warning)warnings.push(s.warning);if(!s.event)return G[i];const p=parseEvent(s.event,a,h,G[i]);if(p.warning)warnings.push(p.warning);return p.game});if(id!==gen)return;G=next;render();warn(warnings);setSync(j.fetchedAt,warnings)}catch(e){if(e?.name==='AbortError'||id!==gen)return;$('sync').textContent=lastFetchedAt?`FEED UNAVAILABLE · last good ${ageSeconds(lastFetchedAt)??'?'}s ago`:'FEED UNAVAILABLE';$('dot').style.background='var(--red)';warn(['Automatic score refresh failed. Existing results are preserved; tap REFRESH to retry.'])}finally{if(id===gen){$('refresh').disabled=false;if(ctl===c)ctl=null}}}
async function loadWeeks(){
  const token=await anonymousToken(),url=`${NEON_DATA_URL}/nfl_pool_weeks?select=season,week,status,config,revision,published_at,locked_at&status=eq.locked&order=season.asc,week.asc`,r=await fetch(url,{cache:'no-store',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});if(!r.ok)throw new Error(`week data ${r.status}`);const data=await r.json();if(!Array.isArray(data)||!data.length)throw new Error('No published pool weeks found');
  const select=$('weekSelect');select.innerHTML=data.map(x=>`<option value="${x.season}-${x.week}">${x.season} · Week ${x.week}</option>`).join('');const qs=new URLSearchParams(location.search),requested=Number(qs.get('week')),season=Number(qs.get('season'))||Math.max(...data.map(x=>x.season));let chosen=requested?data.find(x=>x.season===season&&x.week===requested):null;if(!chosen)chosen=data[data.length-1];select.value=`${chosen.season}-${chosen.week}`;select.addEventListener('change',()=>{const [s,w]=select.value.split('-');const u=new URL(location.href);u.searchParams.set('season',s);u.searchParams.set('week',w);location.href=u.toString()});applyConfig(chosen.config);render();await update();
}
setupViewNavigation();
$('refresh').addEventListener('click',update);loadWeeks().catch(e=>{$('sync').textContent='CONFIG UNAVAILABLE';$('dot').style.background='var(--red)';$('error').innerHTML=`<div class="error">Unable to load weekly pool data: ${esc(e.message)}</div>`;console.error(e)});setInterval(()=>{if(CFG)update()},20000);
