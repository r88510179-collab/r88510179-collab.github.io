// Pool Center V1.3 mobile UX: the Picks view's matchup cards for narrow screens (grouped by kickoff, filtered by entrant
// and by game status) and the collapsible Rules & rulings cards on the Games and Survivor views. Presentation only, in
// the Home dashboard's shape: weekly-app.js and survivor-app.js keep rendering the comparison table and the rules into the
// same elements and refreshing exactly as before (HDC-15). This module reads no feed, no published row and no rendered
// text, computes no result (every pick's grade, every game's status, every ownership share and every ruling state is
// the one the owning app already computed and shows) and starts no timer: each app says when its state may have changed
// (poolcenter:update) and the module re-reads the Picks snapshot (poolcenter:picks) and the Rules & rulings model
// (poolcenter:rules) that app answers with. Nothing here changes scoring, standings, sharing or publications.

// The entrant selection lives under one versioned key; anything stored there that does not validate is every entrant.
export const STORAGE_KEY='poolcenter.picks.v1';
export const PREFERENCES_VERSION=1;
// Kickoff dates and times are shown in Eastern time, whatever the device's zone.
export const TIME_ZONE='America/New_York';
export const STATUS_FILTERS=Object.freeze(['all','final','live','upcoming']);
export const STATUS_LABELS=Object.freeze({all:'All',final:'Final',live:'Live',upcoming:'Upcoming'});
// A game's kind is the app's own status: VOID and HOLD are commissioner-ruling states (never NFL finals, never hidden by a
// status filter); tie is a verified NFL tie (a final: one loss for both picks); final, live and upcoming are the NFL fact.
export const KINDS=Object.freeze(['void','hold','final','tie','live','upcoming']);
const EXCEPTIONAL=new Set(['void','hold']);
const KIND_LABEL={void:'VOID',hold:'HOLD',final:'FINAL',tie:'FINAL TIE',live:'LIVE',upcoming:'UPCOMING'};
const EMPTY={all:'No games are published for this week.',final:'No games are final yet.',live:'No games are live right now.',upcoming:'No games are still to come.'};
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// ---- Kickoff times. The snapshot carries each game's verified kickoff (the score feed's own timestamp for the event the
// app grades) and the published schedule's calendar date. A kickoff is grouped by its Eastern date and slot; a game with a
// date but no kickoff joins a clearly labelled "kickoff time TBD" group on that date; a game with neither is unscheduled.
const partsOf=(formatter,date)=>Object.fromEntries(formatter.formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
export function kickoffParts(iso,{timeZone=TIME_ZONE}={}){
  const ms=typeof iso==='string'?Date.parse(iso):NaN;
  if(!Number.isFinite(ms))return null;
  const d=new Date(ms);
  const n=partsOf(new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}),d);
  const hour=Number(n.hour)%24,minute=Number(n.minute);
  if(!Number.isFinite(hour)||!Number.isFinite(minute))return null;
  return{ms,dayKey:`${n.year}-${n.month}-${n.day}`,weekday:n.weekday,hour,minute,
    time:new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',minute:'2-digit',hour12:true,timeZoneName:'short'}).format(d),
    date:new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short',month:'short',day:'numeric'}).format(d)};
}
// A published calendar date (YYYY-MM-DD) read as that date, never shifted by any zone.
export function dateParts(ymd){
  if(typeof ymd!=='string'||!/^\d{4}-\d{2}-\d{2}/.test(ymd))return null;
  const key=ymd.slice(0,10),d=new Date(`${key}T12:00:00Z`);
  if(Number.isNaN(d.valueOf()))return null;
  return{dayKey:key,weekday:new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long'}).format(d),date:new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(d)};
}
// Slots are by clock time, not by the NFL's usual schedule, so an unusual kickoff, a rescheduled game or an extra day gets
// a true label: before noon is a morning slot, noon to 2:59 PM early, 3:00 to 6:59 PM late, 7:00 PM on a night game.
const SLOTS=['morning','early','late','night','tbd'];
export function slotOf(hour){return hour<12?'morning':hour<15?'early':hour<19?'late':'night'}
export function slotLabel(weekday,slot){
  if(slot==='night')return`${weekday} Night`;
  if(slot==='early')return`${weekday} — Early Games`;
  if(slot==='late')return`${weekday} — Late Games`;
  if(slot==='morning')return`${weekday} Morning`;
  return`${weekday} · kickoff time TBD`;
}
// Chronological groups of games: by Eastern date, then slot, then kickoff, then published order; the date-only and the
// unscheduled groups last on their date and at the very end. Each listed game carries its kickoff text (null without one).
export function groupGames(games,{timeZone=TIME_ZONE}={}){
  const groups=new Map();
  (games||[]).forEach((game,order)=>{
    const k=kickoffParts(game?.kickoff,{timeZone}),d=k?null:dateParts(game?.date);
    let key,label,date,sortKey;
    if(k){const slot=slotOf(k.hour);key=`${k.dayKey}|${SLOTS.indexOf(slot)}`;label=slotLabel(k.weekday,slot);date=k.date;sortKey=key}
    else if(d){key=`${d.dayKey}|${SLOTS.indexOf('tbd')}`;label=slotLabel(d.weekday,'tbd');date=d.date;sortKey=key}
    else{key='tbd';label='Unscheduled · kickoff TBD';date='';sortKey='9999-99-99|9'}
    if(!groups.has(key))groups.set(key,{key,label,date,sortKey,items:[]});
    groups.get(key).items.push({game,order,ms:k?k.ms:Infinity,time:k?k.time:null});
  });
  return[...groups.values()].sort((a,b)=>a.sortKey.localeCompare(b.sortKey)).map(({key,label,date,items})=>({key,label,date,
    games:items.sort((a,b)=>(a.ms-b.ms)||(a.order-b.order)).map(({game,time})=>({game,time}))}));
}

// ---- Status filter. VOID and HOLD games stay in every filter, so a ruling state never disappears behind a category.
export function matchesStatus(kind,status){
  if(EXCEPTIONAL.has(kind)||status==='all'||!STATUS_FILTERS.includes(status))return true;
  if(status==='final')return kind==='final'||kind==='tie';
  return kind===status;
}
export function filterGames(games,status){return(games||[]).filter(g=>matchesStatus(g?.kind,status))}
export function statusCounts(games){
  const c={all:0,final:0,live:0,upcoming:0,exceptions:0};
  for(const g of games||[]){c.all++;if(EXCEPTIONAL.has(g?.kind))c.exceptions++;else if(g?.kind==='final'||g?.kind==='tie')c.final++;else if(g?.kind==='live')c.live++;else c.upcoming++}
  return c;
}

// ---- Entrant selection: any 1 to all of the tracked entries, in the published order, never empty.
export function normalizeSelection(raw,names){
  const all=(names||[]).slice();
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==PREFERENCES_VERSION||!Array.isArray(raw.entrants))return all;
  const known=new Set(all),kept=new Set(raw.entrants.filter(n=>typeof n==='string'&&known.has(n)));
  return kept.size?all.filter(n=>kept.has(n)):all;
}
export function readSelection(names,storage){
  try{const raw=(storage??globalThis.localStorage)?.getItem(STORAGE_KEY);return normalizeSelection(raw==null?null:JSON.parse(raw),names)}catch{return(names||[]).slice()}
}
export function writeSelection(selection,storage){
  try{const s=storage??globalThis.localStorage;if(!s)return false;s.setItem(STORAGE_KEY,JSON.stringify({version:PREFERENCES_VERSION,entrants:(selection||[]).slice()}));return true}catch{return false}
}
// The next selection after a tap: "*" selects every entry; the last selected entry cannot be deselected.
export function toggleEntrant(selection,names,name){
  const all=(names||[]).slice(),current=(selection||[]).filter(n=>all.includes(n));
  if(name==='*')return all;
  if(!all.includes(name))return current.length?current:all;
  const set=new Set(current.length?current:all);
  if(set.has(name)){if(set.size===1)return all.filter(n=>set.has(n));set.delete(name)}else set.add(name);
  return all.filter(n=>set.has(n));
}

// ---- Markup. Everything shown is the snapshot's own text; names and feed text are escaped.
const RESULT={correct:['ok','✓ Correct'],incorrect:['bad','✕ Incorrect'],tie:['bad','✕ Tie · 1 loss'],pending:['pending','Pending'],void:['void','VOID'],hold:['hold','HOLD']};
function badge(team,size=''){
  return`<span class="pm-badge${size?` ${size}`:''}" style="--tc:${esc(team?.color||'#33465f')}" aria-hidden="true"><span class="pm-badge-code">${esc(team?.code)}</span>${team?.logo?`<img class="pm-logo" src="${esc(team.logo)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">`:''}</span>`;
}
function pickHtml(pick,result){
  const [cls,word]=RESULT[result]||RESULT.pending;
  if(!pick?.team)return`<li class="pm-pick ${cls} no-pick-row"><span class="pm-name">${esc(pick?.name)}</span><span class="pm-pick-team no-pick">NO PICK</span><span class="pm-result">${result==='pending'?'Pending':result==='correct'?'✓':result==='incorrect'||result==='tie'?'✕ No pick':word}</span></li>`;
  return`<li class="pm-pick ${cls}"><span class="pm-name">${esc(pick.name)}</span><span class="pm-pick-team">${badge(pick.teamInfo,'mini')}<span>${esc(pick.team)}</span></span><span class="pm-result">${word}</span></li>`;
}
export function cardHtml(game,selected,{time=null}={}){
  const kind=KINDS.includes(game?.kind)?game.kind:'upcoming',away=game.away||{},home=game.home||{},scored=Number.isInteger(game.awayScore)&&Number.isInteger(game.homeScore);
  const winner=kind==='final'?game.winner:null;
  const detail=kind==='live'?game.detail:kind==='final'||kind==='tie'?(game.detail&&!/^final$/i.test(game.detail)?game.detail:''):kind==='upcoming'?(time?'':game.detail):'';
  const ruled=kind==='void'||kind==='hold'?(game.note||(kind==='void'?'Commissioner ruling':'Ruling data unavailable')):'';
  const ownership=game.ownership?`<div class="pm-ownership" aria-label="Full-field pick ownership"><span${game.ownership.away.pct<=35?' class="contrarian"':''}>${esc(away.code)} ${game.ownership.away.pct}%</span><small>of ${game.ownership.away.total} entries</small><span${game.ownership.home.pct<=35?' class="contrarian"':''}>${game.ownership.home.pct}% ${esc(home.code)}</span></div>`:'';
  const flags=[game.underReview?`<span class="pm-flag pm-flag-review">UNDER REVIEW</span>`:'',game.tiebreak?`<span class="pm-flag pm-flag-tiebreak">TIEBREAK GAME</span>`:'',kind==='hold'&&game.hold?`<span class="pm-flag pm-flag-issue">Not graded · ${esc(game.hold)}</span>`:'',game.issue?`<span class="pm-flag pm-flag-issue">Not verified · ${esc(game.issue)}</span>`:''].filter(Boolean).join('');
  const teamInfo={[away.code]:away,[home.code]:home};
  const picks=(game.picks||[]).filter(p=>selected.includes(p.name)).map(p=>pickHtml({...p,teamInfo:teamInfo[p.team]||{code:p.team}},p.result)).join('');
  const side=(team,isHome)=>`<div class="pm-side ${isHome?'pm-home':'pm-away'}${winner&&winner===team.code?' pm-winner':''}">${isHome?'':badge(team)}${isHome&&scored?`<span class="pm-score">${game.homeScore}</span>`:''}<span class="pm-code">${esc(team.code)}</span>${!isHome&&scored?`<span class="pm-score">${game.awayScore}</span>`:''}${isHome?badge(team):''}</div>`;
  return`<article class="pm-card pm-kind-${kind}" data-game="${esc(game.index)}" aria-label="${esc(`${away.code} at ${home.code}, ${KIND_LABEL[kind]}`)}"><div class="pm-card-top"><span class="pm-time">${esc(time||(kind==='upcoming'&&game.detail?game.detail:'Kickoff TBD'))}</span><span class="pm-status pm-status-${kind}">${KIND_LABEL[kind]}</span>${ruled||detail?`<span class="pm-detail">${esc(ruled||detail)}</span>`:''}</div><div class="pm-matchup">${side(away,false)}<span class="pm-at">@</span>${side(home,true)}</div>${ownership}${flags?`<div class="pm-flags">${flags}</div>`:''}<ul class="pm-picks">${picks||'<li class="pm-pick pending"><span class="pm-name">No entry selected</span></li>'}</ul></article>`;
}
export function boardHtml(snapshot,{entrants=null,status='all'}={},{timeZone=TIME_ZONE}={}){
  if(!snapshot||snapshot.ready!==true)return`<div class="empty">${esc(snapshot?.reason||'Picks are not available yet.')}</div>`;
  const names=(snapshot.entrants||[]).map(e=>e.name),selected=normalizeSelection({version:PREFERENCES_VERSION,entrants:entrants||names},names);
  const shown=filterGames(snapshot.games,status);
  if(!shown.length)return`<div class="empty">${esc(EMPTY[status]||EMPTY.all)}</div>`;
  return groupGames(shown,{timeZone}).map(group=>`<section class="pm-group" aria-label="${esc(group.label)}"><h3 class="pm-group-title"><span>${esc(group.label)}</span><small>${esc([group.date,`${group.games.length} game${group.games.length===1?'':'s'}`].filter(Boolean).join(' · '))}</small></h3>${group.games.map(({game,time})=>cardHtml(game,selected,{time})).join('')}</section>`).join('');
}
export function filterBarHtml(names,{selected=null,status='all',counts=null}={}){
  const all=names||[],chosen=normalizeSelection({version:PREFERENCES_VERSION,entrants:selected||all},all),c=counts||{all:0,final:0,live:0,upcoming:0,exceptions:0};
  const chips=[`<button type="button" class="pm-chip pm-chip-all" data-picks-entrant="*" aria-pressed="${chosen.length===all.length}">All ${all.length}</button>`,
    ...all.map(n=>`<button type="button" class="pm-chip" data-picks-entrant="${esc(n)}" aria-pressed="${chosen.includes(n)}">${esc(n)}</button>`)].join('');
  const segments=STATUS_FILTERS.map(s=>`<button type="button" class="pm-segment" data-picks-status="${s}" aria-pressed="${s===status}">${STATUS_LABELS[s]}<b data-picks-count="${s}">${c[s]}</b></button>`).join('');
  return`<div class="pm-filters"><div class="pm-chips" role="group" aria-label="Entries shown">${chips}</div><div class="pm-segments" role="group" aria-label="Game status">${segments}</div><p class="pm-note" data-picks-note aria-live="polite"></p></div>`;
}
export function filterNote(names,selected,status,counts,shown,notice=''){
  const all=names||[],chosen=selected||all;
  const who=chosen.length===all.length?`All ${all.length} entries`:chosen.join(' · ');
  const games=`${shown} of ${counts.all} game${counts.all===1?'':'s'}${status!=='all'?` · ${STATUS_LABELS[status]}`:''}`;
  return[notice,`${who} · ${games}`,counts.exceptions?`${counts.exceptions} VOID/HOLD shown in every filter`:''].filter(Boolean).join(' · ');
}

// ---- Rules & rulings: what the collapsed card says and what stays visible while it is collapsed, from the app's own
// plain-text model (the same model its expanded content is rendered from).
export function rulesSummary(answer){
  const loading={summary:'Loading contest rules and rulings…',alerts:[]};
  if(!answer||typeof answer!=='object')return loading;
  if(answer.ready!==true)return{summary:typeof answer.reason==='string'&&answer.reason?answer.reason:loading.summary,alerts:[]};
  const m=answer.model;
  if(!m||typeof m!=='object')return loading;
  if(m.state==='hold')return{summary:String(m.heading||'ON HOLD · Ruling data unavailable'),alerts:[{tone:'bad',label:'ON HOLD',text:String(m.text||'')}]};
  if(m.state!=='ready')return{summary:String(m.heading||m.state||''),alerts:[]};
  const incidents=Array.isArray(m.incidents)?m.incidents:[],by=s=>incidents.filter(x=>x?.status===s);
  const applied=by('APPLIED'),review=by('UNDER REVIEW'),held=by('HOLD'),withdrawn=by('WITHDRAWN');
  const policy=m.policy?`${m.policy.name} policy · revision ${m.policy.revision}`:'No policy in force';
  const counts=incidents.length?[applied.length?`${applied.length} applied`:'',review.length?`${review.length} under review`:'',held.length?`${held.length} on hold`:'',withdrawn.length?`${withdrawn.length} withdrawn`:''].filter(Boolean).join(' · '):'no incident rulings';
  const alerts=[];
  if(m.stale)alerts.push({tone:'warn',label:'RULINGS STALE',text:String(m.stale)});
  for(const x of held)alerts.push({tone:'warn',label:'HOLD',text:`Week ${x.week} · ${x.matchup} · ${x.detail}`});
  for(const x of review)alerts.push({tone:'warn',label:'UNDER REVIEW',text:`Week ${x.week} · ${x.matchup} · ${x.review||x.detail}`});
  for(const x of applied)alerts.push({tone:'info',label:'APPLIED',text:`Week ${x.week} · ${x.matchup} · ${x.detail}`});
  return{summary:`${policy} · ${counts}${m.stale?' · RULINGS STALE':''}`,alerts};
}
export function alertsHtml(alerts){
  return(alerts||[]).map(a=>`<div class="rules-alert-line tone-${esc(a.tone)}"><b>${esc(a.label)}</b><span>${esc(a.text)}</span></div>`).join('');
}

// ---- The page part.
function requestSnapshot(type,contest){const detail={contest,snapshot:null};document.dispatchEvent(new CustomEvent(type,{detail}));return detail.snapshot}
export function boot(){
  const cards=[...document.querySelectorAll('[data-rules-card]')],board=document.getElementById('picksBoard'),filters=document.getElementById('picksFilters');
  if(!cards.length&&!board)return null;
  // Collapsible Rules & rulings: collapsed as the page ships; the toggle is the one control, and the apps keep rendering
  // into the body, so an expanded card stays expanded through every refresh. The summary and the alerts sit outside the body.
  const rules=new Map();
  for(const card of cards){
    const contest=card.dataset.rulesCard,toggle=card.querySelector('[data-rules-toggle]'),bodyId=toggle?.getAttribute('aria-controls');
    const entry={card,contest,toggle,body:bodyId?document.getElementById(bodyId):null,summary:card.querySelector('[data-rules-summary]'),alerts:card.querySelector('[data-rules-alerts]'),label:card.querySelector('[data-rules-toggle-label]'),expanded:toggle?.getAttribute('aria-expanded')==='true'};
    const apply=()=>{
      if(entry.body)entry.body.hidden=!entry.expanded;
      if(entry.toggle){entry.toggle.setAttribute('aria-expanded',String(entry.expanded));entry.toggle.setAttribute('aria-label',`${entry.expanded?'Collapse':'Expand'} Rules & rulings`)}
      if(entry.label)entry.label.textContent=entry.expanded?'Collapse':'Expand';
      card.classList.toggle('is-collapsed',!entry.expanded);
    };
    apply();
    toggle?.addEventListener('click',()=>{entry.expanded=!entry.expanded;apply();toggle.focus?.()});
    entry.set=expanded=>{entry.expanded=!!expanded;apply()};
    rules.set(contest,entry);
  }
  const renderRules=contest=>{
    const e=rules.get(contest);if(!e)return;
    const {summary,alerts}=rulesSummary(requestSnapshot('poolcenter:rules',contest));
    if(e.summary)e.summary.textContent=summary;
    if(e.alerts)e.alerts.innerHTML=alertsHtml(alerts);
  };
  // The Picks board: the entrant selection is remembered in this browser; the status filter is for this page.
  const state={snapshot:null,names:[],selection:[],status:'all',notice:'',saved:true,built:null};
  const persist=()=>{state.saved=writeSelection(state.selection)};
  function syncFilters(){
    if(!filters)return;
    const names=state.names,counts=statusCounts(state.snapshot?.ready===true?state.snapshot.games:[]),shown=state.snapshot?.ready===true?filterGames(state.snapshot.games,state.status).length:0;
    const key=names.join('\u0000');
    // No controls without a snapshot: the board shows the app's reason instead.
    if(!names.length){if(state.built!==key){filters.innerHTML='';state.built=key}return}
    if(state.built!==key){filters.innerHTML=filterBarHtml(names,{selected:state.selection,status:state.status,counts});state.built=key}
    for(const chip of filters.querySelectorAll('[data-picks-entrant]')){const n=chip.dataset.picksEntrant;chip.setAttribute('aria-pressed',String(n==='*'?state.selection.length===names.length:state.selection.includes(n)))}
    for(const seg of filters.querySelectorAll('[data-picks-status]'))seg.setAttribute('aria-pressed',String(seg.dataset.picksStatus===state.status));
    for(const count of filters.querySelectorAll('[data-picks-count]'))count.textContent=String(counts[count.dataset.picksCount]??0);
    const note=filters.querySelector('[data-picks-note]');
    if(note)note.textContent=names.length?filterNote(names,state.selection,state.status,counts,shown,[state.notice,state.saved?'':'Selection not saved in this browser'].filter(Boolean).join(' · ')):'';
    state.notice='';
  }
  function renderPicks(){
    if(!board)return;
    state.snapshot=requestSnapshot('poolcenter:picks','pickem');
    const names=state.snapshot?.ready===true?state.snapshot.entrants.map(e=>e.name):[];
    if(names.join('\u0000')!==state.names.join('\u0000')){state.names=names;state.selection=readSelection(names)}
    board.innerHTML=boardHtml(state.snapshot,{entrants:state.selection,status:state.status});
    syncFilters();
  }
  if(board){
    const host=board.closest?.('.picks');if(host)host.classList.add('is-mobile-ready');
    board.hidden=false;if(filters)filters.hidden=false;
    filters?.addEventListener('click',event=>{
      const chip=event.target?.closest?.('[data-picks-entrant]'),segment=event.target?.closest?.('[data-picks-status]');
      if(chip){
        const next=toggleEntrant(state.selection,state.names,chip.dataset.picksEntrant);
        if(next.join('\u0000')===state.selection.join('\u0000')&&chip.dataset.picksEntrant!=='*')state.notice='At least one entry stays selected';
        else{state.selection=next;persist()}
        renderPicks();
      }else if(segment&&STATUS_FILTERS.includes(segment.dataset.picksStatus)){state.status=segment.dataset.picksStatus;renderPicks()}
    });
  }
  document.addEventListener('poolcenter:update',event=>{const contest=event?.detail?.contest;if(contest==='pickem'){renderPicks();renderRules('pickem')}else if(contest==='survivor')renderRules('survivor')});
  for(const contest of rules.keys())renderRules(contest);
  renderPicks();
  return{get state(){return{...state,selection:state.selection.slice(),names:state.names.slice()}},rules,renderPicks,renderRules,
    setStatus(status){if(STATUS_FILTERS.includes(status)){state.status=status;renderPicks()}},
    setSelection(names){state.selection=normalizeSelection({version:PREFERENCES_VERSION,entrants:names},state.names);persist();renderPicks()}};
}
if(typeof document!=='undefined'&&typeof document.querySelectorAll==='function'&&typeof document.getElementById==='function'&&(document.getElementById('picksBoard')||document.querySelector?.('[data-rules-card]')))boot();
