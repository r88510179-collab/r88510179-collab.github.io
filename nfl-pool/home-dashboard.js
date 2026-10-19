// Pool Center Home dashboard: the Home view's six collapsible sections (Quick Overview, Live Standings, Survivor Quick View,
// Pool Status, Group Scenarios, Game Watch), shown, hidden, reordered, expanded or collapsed as the participant prefers and
// remembered in this browser only; the Customize Dashboard dialog; the Survivor summary and both contests' status chips; and
// the Share menu's housekeeping (share-ui.js does the sharing). Presentation only: weekly-app.js and survivor-app.js keep
// rendering into the same elements and refreshing exactly as before (HDC-15), and everything this module shows comes from
// the verified snapshot each app already answers a poolcenter:share request with. It reads no feed, no published row and
// no rendered text, computes no result, and starts no timer: each app says when its snapshot may have changed
// (poolcenter:update) and the dashboard re-reads it then.
import {pickemStatus,survivorStatus} from './share-card.js?v=2';

// Preferences live under one versioned key; anything stored under it that does not validate falls back to the defaults.
export const STORAGE_KEY='poolcenter.home.dashboard.v1';
export const PREFERENCES_VERSION=1;
export const SECTIONS=Object.freeze([
  Object.freeze({id:'overview',title:'Quick Overview',required:true,expanded:true}),
  Object.freeze({id:'standings',title:'Live Standings',required:false,expanded:true}),
  Object.freeze({id:'survivor',title:'Survivor Quick View',required:false,expanded:true}),
  Object.freeze({id:'pulse',title:'Pool Status',required:false,expanded:false}),
  Object.freeze({id:'scenarios',title:'Group Scenarios',required:false,expanded:false}),
  Object.freeze({id:'games',title:'Game Watch',required:false,expanded:false})
]);
export const DENSITIES=Object.freeze(['compact','detailed']);
// The tracked Survivor entrant the summaries single out (survivor-app.js validates exactly D.C., DJS and Thaddeus).
export const SPOTLIGHT_ENTRANT='DJS';
const SECTION_IDS=SECTIONS.map(s=>s.id),REQUIRED=new Set(SECTIONS.filter(s=>s.required).map(s=>s.id)),NAME={pickem:"Pick'em",survivor:'Survivor'};
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// ---- Preferences.
export function defaultPreferences(){return{version:PREFERENCES_VERSION,order:SECTION_IDS.slice(),hidden:[],collapsed:SECTIONS.filter(s=>!s.expanded).map(s=>s.id),density:'compact'}}
// Whatever was stored, made safe: an unknown version or shape is the defaults; unknown or repeated section ids are dropped
// and sections missing from the order follow in their default place; a required section can never be hidden; a density
// that is not offered is the default one.
export function normalizePreferences(raw){
  const d=defaultPreferences();
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==PREFERENCES_VERSION)return d;
  const known=new Set(SECTION_IDS),list=v=>Array.isArray(v)?[...new Set(v.filter(x=>typeof x==='string'&&known.has(x)))]:null;
  const order=list(raw.order);
  return{version:PREFERENCES_VERSION,
    order:order?[...order,...d.order.filter(id=>!order.includes(id))]:d.order,
    hidden:(list(raw.hidden)||[]).filter(id=>!REQUIRED.has(id)),
    collapsed:list(raw.collapsed)??d.collapsed,
    density:DENSITIES.includes(raw.density)?raw.density:d.density};
}
// Storage can be absent, refuse access (a sandboxed page) or hold something that is not JSON: each case is the defaults
// kept in memory for this page. Only this key is ever read or written.
export function readPreferences(storage){
  try{const raw=(storage??globalThis.localStorage)?.getItem(STORAGE_KEY);return normalizePreferences(raw==null?null:JSON.parse(raw))}catch{return defaultPreferences()}
}
export function writePreferences(prefs,storage){
  try{const s=storage??globalThis.localStorage;if(!s)return false;s.setItem(STORAGE_KEY,JSON.stringify(prefs));return true}catch{return false}
}

// ---- Statuses and summaries, from the snapshots alone.
export function formatAge(ms,now=Date.now()){
  if(!Number.isFinite(ms))return'age unknown';
  const s=Math.max(0,Math.floor((now-ms)/1000));
  if(s<5)return'just now';if(s<60)return`${s}s ago`;
  const m=Math.floor(s/60);if(m<60)return`${m}m ago`;
  return`${Math.floor(m/60)}h ago`;
}
const LOADING=/still loading|not loaded yet|is loading/i;
// A contest's chip: the share card's own status for a snapshot that is ready (pickemStatus and survivorStatus, so Home and
// the cards never disagree), LOADING or UNAVAILABLE with the app's reason otherwise, and UNAVAILABLE when no app answered.
export function contestStatus(contest,snapshot,{now=Date.now()}={}){
  const name=NAME[contest]||contest;
  if(!snapshot||typeof snapshot!=='object')return{label:'UNAVAILABLE',tone:'bad',detail:`${name} has not answered. Reload the page to try again.`,flags:[],ready:false};
  if(snapshot.ready!==true){
    const reason=typeof snapshot.reason==='string'&&snapshot.reason.trim()?snapshot.reason:`${name} has nothing to show yet.`,loading=LOADING.test(reason);
    return{label:loading?'LOADING':'UNAVAILABLE',tone:loading?'muted':'bad',detail:reason,flags:[],ready:false};
  }
  try{return{...(contest==='pickem'?pickemStatus(snapshot,{now}):survivorStatus(snapshot,{now})),ready:true}}
  catch{return{label:'UNAVAILABLE',tone:'bad',detail:`The ${name} snapshot could not be read.`,flags:[],ready:false}}
}
export function leaderText(pk){
  const leaders=(pk.entries||[]).filter(e=>e.leader===true);
  if(!leaders.length)return'—';
  return`${leaders.map(e=>e.name).join(' / ')} ${leaders[0].w}–${leaders[0].l}`;
}
export function spotlightText(s){
  if(!s||typeof s!=='object')return'';
  const scored=Number.isInteger(s.awayScore)&&Number.isInteger(s.homeScore);
  return scored?`${s.away} ${s.awayScore}–${s.homeScore} ${s.home} · ${s.status}`:`${s.away} @ ${s.home} · ${s.status}`;
}
const pendingText=(contest,snapshot)=>contestStatus(contest,snapshot).label==='LOADING'?'Loading…':'Unavailable';
// What a collapsed section says: one line, from the same snapshot its expanded content comes from.
export function sectionSummary(id,{pickem=null,survivor=null}={},{now=Date.now()}={}){
  const pk=pickem?.ready===true?pickem:null,sv=survivor?.ready===true?survivor:null;
  switch(id){
    case'overview':return`Pick'em ${contestStatus('pickem',pickem,{now}).label} · Survivor ${contestStatus('survivor',survivor,{now}).label}`;
    case'standings':return pk?leaderText(pk):pendingText('pickem',pickem);
    case'survivor':{
      if(!sv)return pendingText('survivor',survivor);
      const c=sv.counts,spot=(sv.tracked||[]).find(t=>t.name===SPOTLIGHT_ENTRANT);
      return[`${c.active} of ${sv.fieldSize} remaining`,c.pending?`${c.pending} pending`:'',spot?`${spot.name} ${spot.status}`:''].filter(Boolean).join(' · ');
    }
    case'pulse':{
      if(!pk)return pendingText('pickem',pickem);
      const g=pk.games;
      return[`${g.final}/${g.total} final`,g.live?`${g.live} live`:'',g.void?`${g.void} void`:'',!g.live&&g.remaining?`${g.remaining} left`:''].filter(Boolean).join(' · ');
    }
    case'scenarios':{
      if(!pk)return pendingText('pickem',pickem);
      const r=pk.race;
      return r&&Array.isArray(r.items)&&r.items.length?r.items.map(x=>`${x.name} ${x.status}`).join(' · '):'—';
    }
    case'games':return pk?spotlightText(pk.spotlight)||'No games':pendingText('pickem',pickem);
    default:return'';
  }
}
const chip=st=>`<span class="dash-status tone-${esc(st.tone)}">${esc(st.label)}</span>`;
const pill=status=>{const s=String(status||'').toUpperCase(),cls=s==='RULING'?'pending':s.toLowerCase();return`<span class="status-pill survivor-${esc(cls)}">${esc(s)}</span>`};
// Quick Overview: each contest's own panel with its own chip, week and revision, the facts the section lists and the chip's
// detail, so neither contest's LIVE ever stands for the other.
export function overviewHtml({pickem=null,survivor=null}={},{now=Date.now()}={}){
  const pk=contestStatus('pickem',pickem,{now}),sv=contestStatus('survivor',survivor,{now});
  // The chip's detail is shown under the facts only while it says more than they do: a warning, a reason, a failure.
  const panel=(contest,st,line,facts)=>`<div class="dash-contest dash-contest-${contest}" data-dash-contest="${contest}"><div class="dash-contest-head"><span class="dash-contest-name">${esc(NAME[contest])}</span>${chip(st)}</div><div class="dash-contest-line">${esc(line)}</div>${facts?`<div class="dash-contest-facts">${facts}</div>`:''}${st.tone==='ok'||st.tone==='final'?'':`<div class="dash-contest-note">${esc(st.detail)}</div>`}</div>`;
  let pkLine='—',pkFacts='';
  if(pk.ready){
    const s=pickem,g=s.games;
    pkLine=`Week ${s.week} · revision ${s.revision} · data ${formatAge(Date.parse(s.feed.fetchedAt),now)}`;
    pkFacts=`<span>Leader <b>${esc(leaderText(s))}</b></span><span>${s.fieldSize===null?'Field <b>not published</b>':`Field <b>${s.fieldSize}</b> entries`}</span><span>Games <b>${g.final}/${g.total}</b> final${g.live?` · ${g.live} live`:''}${g.void?` · ${g.void} void`:''}</span>`;
  }
  let svLine='—',svFacts='';
  if(sv.ready){
    const s=survivor,c=s.counts,spot=(s.tracked||[]).find(t=>t.name===SPOTLIGHT_ENTRANT);
    svLine=`Week ${s.week} · revision ${s.revision} · results ${formatAge(s.feed.at,now)}`;
    svFacts=`<span>Remaining <b>${c.active}</b> of ${s.fieldSize}</span><span>Pending <b>${c.pending}</b></span>${spot?`<span>${esc(spot.name)} ${pill(spot.status)}</span>`:''}`;
  }
  return panel('pickem',pk,pkLine,pkFacts)+panel('survivor',sv,svLine,svFacts);
}
// Survivor Quick View: the field's four counts, the tracked entrants as badge rows (compact) or with their reasons
// (detailed), and the week's own status; unloaded results are never shown as zero.
export function survivorQuickViewHtml(snapshot,{density='compact',now=Date.now()}={}){
  const st=contestStatus('survivor',snapshot,{now});
  if(!st.ready)return`<div class="dash-survivor-empty">${chip(st)}<p>${esc(st.detail)}</p></div>`;
  const s=snapshot,c=s.counts,detailed=density==='detailed';
  const metrics=[['Total field',s.fieldSize],['Remaining',c.active],['Pending',c.pending],['Submissions',c.submitted]].map(([k,v])=>`<div class="dash-metric"><span>${k}</span><b>${esc(v)}</b></div>`).join('');
  const rows=(s.tracked||[]).map(t=>`<div class="dash-entrant"><span class="dash-entrant-name">${esc(t.name)}</span><span class="dash-entrant-pick${t.team?'':' none'}">${t.team?esc(t.team):'NO PICK'}</span><span class="dash-entrant-status">${pill(t.status)}${t.underReview?'<span class="status-pill survivor-review">UNDER REVIEW</span>':''}</span>${detailed?`<small class="dash-entrant-reason">${esc(t.reason)}</small>`:''}</div>`).join('');
  const note=detailed?`<p class="dash-survivor-note">${esc([`${c.submitted} submitted · ${c.legalPicks} legal picks`,c.out?`${c.out} out (${c.outThisWeek} this week)`:'',c.awaitingRuling?`${c.awaitingRuling} awaiting a ruling`:'',c.onHold?`${c.onHold} on hold`:'',...(st.flags||[])].filter(Boolean).join(' · '))}</p>`:'';
  return`<div class="dash-survivor-metrics">${metrics}</div><div class="dash-entrants">${rows}</div><div class="dash-survivor-status">${chip(st)}<span>${esc(`Week ${s.week} · revision ${s.revision} · ${st.detail} · results ${formatAge(s.feed.at,now)}`)}</span></div>${note}`;
}

// ---- The page part.
function requestSnapshot(contest){const detail={contest,snapshot:null};document.dispatchEvent(new CustomEvent('poolcenter:share',{detail}));return detail.snapshot}
function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props)){
    if(key==='class')node.className=value;else if(key==='text')node.textContent=value;
    else if(key==='hidden'||key==='disabled'||key==='checked')node[key]=value;else node.setAttribute(key,value);
  }
  for(const child of children)node.appendChild(child);
  return node;
}
export function boot(){
  const root=document.getElementById('dashSections'),dialog=document.getElementById('dashPanel');
  if(!root)return null;
  const sections=new Map();
  for(const node of root.querySelectorAll('[data-dash-section]'))if(SECTION_IDS.includes(node.dataset.dashSection))sections.set(node.dataset.dashSection,node);
  const snapshots={pickem:null,survivor:null};
  let prefs=readPreferences(),saved=true;
  const persist=()=>{saved=writePreferences(prefs);renderStorageNote()};
  const renderStorageNote=()=>{const note=document.getElementById('dashPanelStorage');if(note){note.hidden=saved;note.textContent=saved?'':'Preferences could not be saved in this browser; they apply to this page only.'}};
  // Collapsing is presentation only: the section's body is hidden, the apps keep rendering into it, and the header's
  // button says what the collapsed section would show.
  function applySection(id){
    const node=sections.get(id);if(!node)return;
    const collapsed=prefs.collapsed.includes(id),toggle=node.querySelector('[data-dash-toggle]'),body=node.querySelector('.dash-body');
    node.hidden=prefs.hidden.includes(id);
    if(body)body.hidden=collapsed;
    if(toggle)toggle.setAttribute('aria-expanded',String(!collapsed));
    node.classList.toggle('is-collapsed',collapsed);
  }
  function applyLayout(){
    for(const id of prefs.order){const node=sections.get(id);if(node)root.appendChild(node)}
    for(const id of sections.keys())applySection(id);
    root.dataset.dashDensity=prefs.density;
  }
  function renderData(){
    const now=Date.now(),contests=document.getElementById('dashContests'),survivor=document.getElementById('dashSurvivor');
    if(contests)contests.innerHTML=overviewHtml(snapshots,{now});
    if(survivor)survivor.innerHTML=survivorQuickViewHtml(snapshots.survivor,{density:prefs.density,now});
    for(const [id,node] of sections){const summary=node.querySelector('[data-dash-summary]');if(summary)summary.textContent=sectionSummary(id,snapshots,{now})}
  }
  function setCollapsed(id,collapsed){
    const set=new Set(prefs.collapsed);if(collapsed)set.add(id);else set.delete(id);
    prefs={...prefs,collapsed:SECTION_IDS.filter(x=>set.has(x))};persist();applySection(id);
  }
  function setHidden(id,hidden){
    if(REQUIRED.has(id))return;
    const set=new Set(prefs.hidden);if(hidden)set.add(id);else set.delete(id);
    prefs={...prefs,hidden:SECTION_IDS.filter(x=>set.has(x))};persist();applySection(id);
  }
  function move(id,dir){
    const order=prefs.order.slice(),i=order.indexOf(id),j=dir==='up'?i-1:i+1;
    if(i<0||j<0||j>=order.length)return;
    [order[i],order[j]]=[order[j],order[i]];prefs={...prefs,order};persist();applyLayout();renderPanel();
    const same=dialog?.querySelector(`[data-dash-move="${id}"][data-dash-dir="${dir}"]`),other=dialog?.querySelector(`[data-dash-move="${id}"][data-dash-dir="${dir==='up'?'down':'up'}"]`);
    (same&&!same.disabled?same:other)?.focus?.();
  }
  function setDensity(density){if(!DENSITIES.includes(density))return;prefs={...prefs,density};persist();applyLayout();renderData()}
  function restoreDefaults(){prefs=defaultPreferences();persist();applyLayout();renderData();renderPanel()}
  // The Customize Dashboard dialog: one row per section in its current order (show, expand or collapse, move up or down,
  // the required Quick Overview always shown), the display density and Restore default layout. Every change applies at once.
  function renderPanel(){
    const list=document.getElementById('dashPanelList');if(!list)return;
    list.replaceChildren();
    prefs.order.forEach((id,index)=>{
      const meta=SECTIONS.find(s=>s.id===id),collapsed=prefs.collapsed.includes(id),row=el('div',{class:'dash-panel-row','data-dash-row':id});
      const show=el('input',{type:'checkbox',id:`dashShow-${id}`,'data-dash-show':id,checked:!prefs.hidden.includes(id),disabled:REQUIRED.has(id)});
      show.addEventListener('change',()=>setHidden(id,!show.checked));
      const label=el('label',{for:`dashShow-${id}`,class:'dash-panel-label',text:meta.title+(REQUIRED.has(id)?' (always shown)':'')});
      const expand=el('button',{type:'button',class:'dash-panel-btn','data-dash-expand':id,'aria-pressed':String(!collapsed),'aria-label':`${collapsed?'Expand':'Collapse'} ${meta.title}`,text:collapsed?'Expand':'Collapse'});
      expand.addEventListener('click',()=>{setCollapsed(id,!prefs.collapsed.includes(id));renderPanel();dialog?.querySelector(`[data-dash-expand="${id}"]`)?.focus?.()});
      const up=el('button',{type:'button',class:'dash-panel-btn dash-move','data-dash-move':id,'data-dash-dir':'up','aria-label':`Move ${meta.title} up`,text:'▲',disabled:index===0});
      const down=el('button',{type:'button',class:'dash-panel-btn dash-move','data-dash-move':id,'data-dash-dir':'down','aria-label':`Move ${meta.title} down`,text:'▼',disabled:index===prefs.order.length-1});
      up.addEventListener('click',()=>move(id,'up'));down.addEventListener('click',()=>move(id,'down'));
      row.append(show,label,el('div',{class:'dash-panel-controls'},expand,up,down));
      list.appendChild(row);
    });
    for(const radio of dialog?dialog.querySelectorAll('input[name="dashDensity"]'):[])radio.checked=radio.value===prefs.density;
    renderStorageNote();
  }
  function openPanel(opener){
    if(!dialog)return;
    renderPanel();
    if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','')}
    dialog.querySelector('[data-dash-show]')?.focus?.();
    dialog.addEventListener('close',()=>opener?.focus?.(),{once:true});
  }
  function closePanel(){if(!dialog)return;if(typeof dialog.close==='function'&&dialog.open)dialog.close();else dialog.removeAttribute('open')}
  // Wiring.
  for(const [id,node] of sections){const toggle=node.querySelector('[data-dash-toggle]');if(toggle)toggle.addEventListener('click',()=>setCollapsed(id,!prefs.collapsed.includes(id)))}
  for(const button of document.querySelectorAll('[data-dash-customize]')){button.addEventListener('click',()=>openPanel(button));button.hidden=false}
  if(dialog){
    for(const button of dialog.querySelectorAll('[data-dash-close]'))button.addEventListener('click',closePanel);
    for(const button of dialog.querySelectorAll('[data-dash-reset]'))button.addEventListener('click',restoreDefaults);
    for(const radio of dialog.querySelectorAll('input[name="dashDensity"]'))radio.addEventListener('change',()=>{if(radio.checked)setDensity(radio.value)});
    dialog.addEventListener('click',event=>{if(event.target===dialog)closePanel()});
  }
  // The Share menu is share-ui.js's; here it only closes after a card is chosen (the preview opens), on Escape and on a tap
  // elsewhere, so it never covers the dashboard.
  const menu=document.querySelector('.dash-share-menu');
  if(menu){
    menu.addEventListener('click',event=>{if(event.target?.closest?.('[data-share-card]'))menu.removeAttribute('open')});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')menu.removeAttribute('open')});
    document.addEventListener('click',event=>{if(!event.target?.closest?.('.dash-share-menu'))menu.removeAttribute('open')});
  }
  document.addEventListener('poolcenter:update',event=>{const contest=event?.detail?.contest;if(contest==='pickem'||contest==='survivor'){snapshots[contest]=requestSnapshot(contest);renderData()}});
  applyLayout();
  snapshots.pickem=requestSnapshot('pickem');snapshots.survivor=requestSnapshot('survivor');renderData();
  return{get preferences(){return prefs},sections,setCollapsed,setHidden,move,setDensity,restoreDefaults,openPanel,closePanel,renderData};
}
if(typeof document!=='undefined'&&typeof document.getElementById==='function'&&document.getElementById('dashSections'))boot();
