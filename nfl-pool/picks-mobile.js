// Pool Center V1.4 premium compact Picks UX (after the V1.3 mobile UX): the Picks view's matchup list for narrow screens
// (one compact card per matchup, collapsed until tapped, grouped by kickoff slate in Eastern time, each slate a collapsible
// group whose heading is its control, filtered by slate, by game status and by the entries compared) and the collapsible
// Rules & rulings cards on the Games and Survivor views. Presentation
// only, in the Home dashboard's shape: weekly-app.js and survivor-app.js keep rendering the comparison table and the rules
// into the same elements and refreshing exactly as before (HDC-15). This module reads no feed, no published row and no
// rendered text, computes no result (every pick's grade, every game's status, every ownership share and every ruling state is
// the one the owning app already computed and shows) and starts no timer: each app says when its state may have changed
// (poolcenter:update) and the module re-reads the Picks snapshot (poolcenter:picks) and the Rules & rulings model
// (poolcenter:rules) that app answers with. Nothing here changes scoring, standings, sharing or publications.

// The entrant selection lives under one versioned key (the V1.3 key and shape, unchanged); anything stored there that does
// not validate is every entrant. The slate, the status filter and the open slates are page state: kept through every refresh,
// reset by a reload.
export const STORAGE_KEY='poolcenter.picks.v1';
export const PREFERENCES_VERSION=1;
// The card name labels live under their own key, so the selection key keeps its V1.3 shape: 'compact' shortens long names on
// the collapsed cards, 'full' shows every name as published; anything else means the default for the screen (compact on a
// narrow one). Disagreements only is page state like the slate and the status: off on load, kept through every refresh.
export const LABELS_KEY='poolcenter.picks.labels.v1';
export const LABEL_MODES=Object.freeze(['compact','full']);
// A name of this many characters or fewer is never shortened; a longer one is cut to its first four letters and a full stop.
export const LABEL_MAX=6;
export const NARROW_SCREEN='(max-width:480px)';
// Kickoff dates and times are shown in Eastern time, whatever the device's zone.
export const TIME_ZONE='America/New_York';
export const STATUS_FILTERS=Object.freeze(['all','final','live','upcoming']);
export const STATUS_LABELS=Object.freeze({all:'All',final:'Final',live:'Live',upcoming:'Upcoming'});
// A game's kind is the app's own status: VOID and HOLD are commissioner-ruling states (never NFL finals, never hidden by a
// status filter); tie is a verified NFL tie (a final: one loss for both picks); final, live and upcoming are the NFL fact.
export const KINDS=Object.freeze(['void','hold','final','tie','live','upcoming']);
// The slate selector's default: every slate of the week.
export const ALL_SLATES='all';
const EXCEPTIONAL=new Set(['void','hold']);
const KIND_LABEL={void:'VOID',hold:'HOLD',final:'FINAL',tie:'FINAL TIE',live:'LIVE',upcoming:'UPCOMING'};
const EMPTY={all:'No games are published for this week.',final:'No games are final yet.',live:'No games are live right now.',upcoming:'No games are still to come.'};
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// ---- Kickoff times. The snapshot carries each game's verified kickoff (the score feed's own timestamp for the event the
// app grades) and the published schedule's calendar date. A kickoff is grouped by its Eastern date and slot; a game with a
// date but no kickoff joins a clearly labelled "Kickoff TBD" group on that date; a game with neither is in the last group.
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
  if(slot==='early')return`${weekday} Early`;
  if(slot==='late')return`${weekday} Late`;
  if(slot==='morning')return`${weekday} Morning`;
  return`${weekday} · Kickoff TBD`;
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
    else{key='tbd';label='Kickoff TBD';date='';sortKey='9999-99-99|9'}
    if(!groups.has(key))groups.set(key,{key,label,date,sortKey,items:[]});
    groups.get(key).items.push({game,order,ms:k?k.ms:Infinity,time:k?k.time:null});
  });
  return[...groups.values()].sort((a,b)=>a.sortKey.localeCompare(b.sortKey)).map(({key,label,date,items})=>({key,label,date,
    games:items.sort((a,b)=>(a.ms-b.ms)||(a.order-b.order)).map(({game,time})=>({game,time}))}));
}
// ---- Slates: the selector's options are exactly the kickoff groups present in the given games (All Slates first, each
// with its game count), so a slate that is not on a week's schedule is never offered and one chosen earlier falls back to
// All Slates. Filtering by a slate keeps the published order; the board regroups what it shows.
export function slateOptions(games,{timeZone=TIME_ZONE}={}){
  return[{key:ALL_SLATES,label:'All Slates',date:'',count:(games||[]).length},...groupGames(games,{timeZone}).map(g=>({key:g.key,label:g.label,date:g.date,count:g.games.length}))];
}
export function resolveSlate(slate,options){return typeof slate==='string'&&(options||[]).some(o=>o.key===slate)?slate:ALL_SLATES}
export function filterSlate(games,slate,{timeZone=TIME_ZONE}={}){
  const all=(games||[]).slice();
  if(!slate||slate===ALL_SLATES)return all;
  const group=groupGames(all,{timeZone}).find(g=>g.key===slate);
  if(!group)return[];
  const keep=new Set(group.games.map(x=>x.game));
  return all.filter(g=>keep.has(g));
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

// ---- Slate expansion (the V1.4 collapsible slate groups). On the board each kickoff slate is a disclosure whose heading is
// the one control. All Slates keeps its own layout for the week on screen: a slate starts open only while it lists a live
// game, so the games in progress are in view and every other slate is one tap away behind a compact summary. A tap on a
// heading, Expand all and Collapse all are manual choices, kept through every refresh, filter and slate change of the same
// week: a slate the user closed never reopens by itself (live or not), a slate the user opened never closes by itself, and
// a slate nobody touched opens once it goes live and stays open afterwards, so nothing is ever closed under the reader. A
// slate chosen in the selector starts open each time it is chosen and can then be closed by hand, which is kept through
// refreshes and filters while it stays chosen; All Slates comes back as it was left. A new week starts afresh and a slate
// that leaves the schedule is forgotten. Nothing here changes which games a slate lists, their order, their status or their
// grading.
export function slateHasLive(group){return(group?.games||[]).some(x=>kindOf(x?.game)==='live')}
export function defaultSlateOpen(group,slate=ALL_SLATES){return slate!==ALL_SLATES||slateHasLive(group)}
const slateStateOf=(states,key)=>states instanceof Map?states.get(key):states&&typeof states==='object'?states[key]:undefined;
// Whether a slate is open on the board: its state (a boolean, or {open}) when it has one, else its default.
export function slateOpen(group,slate=ALL_SLATES,states=null){
  const s=slateStateOf(states,group?.key),open=s&&typeof s==='object'?s.open:s;
  return typeof open==='boolean'?open:defaultSlateOpen(group,slate);
}
// The All Slates states after a render, as a new Map of key to {open, manual}: the previous states (those of slates no longer
// among the keys dropped, anything malformed dropped), each listed slate without one at its All Slates default, and an
// untouched slate that is now live opened. Nothing else moves.
export function nextSlateStates(previous,groups,{keys=null}={}){
  const keep=Array.isArray(keys)?new Set(keys):null,next=new Map();
  for(const [key,s] of previous instanceof Map?previous:[])if(typeof key==='string'&&(!keep||keep.has(key))&&s&&typeof s==='object')next.set(key,{open:s.open===true,manual:s.manual===true});
  for(const group of groups||[]){
    if(typeof group?.key!=='string')continue;
    const live=slateHasLive(group),s=next.get(group.key);
    if(!s)next.set(group.key,{open:live,manual:false});
    else if(!s.manual&&live&&!s.open)s.open=true;
  }
  return next;
}
// A manual choice for one slate or, for Expand all and Collapse all, for every slate of the schedule; the previous Map is untouched.
export function setSlateOpen(states,keys,open){
  const next=new Map();
  for(const [key,s] of states instanceof Map?states:[])next.set(key,s&&typeof s==='object'?{...s}:s);
  for(const key of Array.isArray(keys)?keys:[keys])if(typeof key==='string')next.set(key,{open:open===true,manual:true});
  return next;
}
// The compact summary of a slate, counting the games it lists: each once by the status its card shows (LIVE, FINAL, FINAL
// TIE, UPCOMING, VOID, HOLD), then the games under review and the unverified results, and whether the tiebreak game is among
// them, so a collapsed slate still shows what needs a look.
export function slateSummary(group){
  const games=(group?.games||[]).map(x=>x?.game),kinds=games.map(kindOf),count=kind=>kinds.filter(k=>k===kind).length;
  return{all:games.length,live:count('live'),final:count('final'),tie:count('tie'),upcoming:count('upcoming'),void:count('void'),hold:count('hold'),review:games.filter(g=>!!g?.underReview).length,issue:games.filter(g=>!!g?.issue).length,tiebreak:games.some(g=>g?.tiebreak===true)};
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
// What the one compact control says is being compared.
export function compareLabel(names,selected){
  const all=names||[];
  if(!all.length)return'';
  const chosen=normalizeSelection({version:PREFERENCES_VERSION,entrants:selected||all},all);
  return chosen.length===all.length?`All ${all.length} ${all.length===1?'entry':'entries'}`:chosen.join(' + ');
}

// ---- Card name labels. In compact mode a name longer than LABEL_MAX characters is shortened on the collapsed cards to its
// first four letters and a full stop (Thaddeus → Thad.); a name of LABEL_MAX characters or fewer stays whole (D.C., JC, DJS).
// A shortening is unambiguous only when no other name begins with its letters, so alike names are lengthened until they
// differ (Thaddeus and Thadeus → Thadd. and Thade.; Thad and Thaddeus → Thad and Thadd.), and a name that cannot be
// shortened unambiguously stays whole (Thaddeus beside Thaddeus Jr). Display only: the snapshot, the selection, the open
// matchup and the selection panel always carry the full name, and the shortened label is never spoken (the full name is).
const LABEL_CUT=4;
const labelKey=s=>String(s).trim().toLowerCase().replace(/\.+$/,'');
const cutName=(name,n)=>{const head=name.slice(0,n).trimEnd().replace(/\.+$/,'');return head&&head.length+1<name.trim().length?`${head}.`:name};
export function shortLabels(names){
  const all=(names||[]).map(n=>String(n??'')),whole=n=>n.trim().length<=LABEL_MAX;
  return all.map(name=>{
    if(whole(name))return name;
    const others=all.filter(o=>o!==name).map(labelKey);
    for(let n=LABEL_CUT;n<name.length;n++){
      const label=cutName(name,n);
      if(label===name)return name;
      const stem=labelKey(label);
      if(!others.some(o=>o.startsWith(stem)))return label;
    }
    return name;
  });
}
// The label of each name in a mode: in full mode every name is its own label.
export function labelMap(names,mode){
  const all=(names||[]).map(n=>String(n??'')),labels=mode==='compact'?shortLabels(all):all;
  return new Map(all.map((name,i)=>[name,labels[i]]));
}
// The default for a screen: compact on a narrow one, full otherwise or without a screen to ask.
export function defaultLabels(win){
  const w=win===undefined?(typeof window==='undefined'?null:window):win;
  try{return typeof w?.matchMedia==='function'&&w.matchMedia(NARROW_SCREEN)?.matches===true?'compact':'full'}catch{return'full'}
}
export function readLabels(storage){
  try{const raw=(storage??globalThis.localStorage)?.getItem(LABELS_KEY);return LABEL_MODES.includes(raw)?raw:null}catch{return null}
}
export function writeLabels(mode,storage){
  try{const s=storage??globalThis.localStorage;if(!s||!LABEL_MODES.includes(mode))return false;s.setItem(LABELS_KEY,mode);return true}catch{return false}
}

// ---- Disagreements. A game is a disagreement when two or more of the compared entries picked different teams: the picks
// submitted only (an entry without a pick for the game is left out), the grades aside (two entries on the same losing team
// agree). The filter keeps VOID and HOLD games whatever their picks, as the status filter does: the commissioner's exceptions
// stay listed in every filter, and the note and the open card say so.
export function disagreement(game,selected){
  const chosen=selected||[],teams=new Set();
  for(const p of game?.picks||[])if(chosen.includes(p?.name)&&p?.team)teams.add(String(p.team).trim().toUpperCase());
  return teams.size>=2;
}
export function filterDisagreements(games,selected,on){
  const all=games||[];
  return on===true?all.filter(g=>EXCEPTIONAL.has(g?.kind)||disagreement(g,selected)):all.slice();
}
// The empty state of Disagreements only: who was compared, and the status and the slate that narrowed it.
export function emptyDisagreements(names,selected,status='all',slateLabel=''){
  const all=names||[],chosen=selected||all;
  const who=chosen.length===2?`between ${chosen[0]} and ${chosen[1]}`:chosen.length===all.length?`among all ${all.length} entries`:`among ${chosen.slice(0,-1).join(', ')} and ${chosen[chosen.length-1]}`;
  const kind=STATUS_FILTERS.includes(status)&&status!=='all'?`${STATUS_LABELS[status].toLowerCase()} `:'';
  return`No ${kind}disagreements ${who}${slateLabel?` in ${slateLabel}`:''}.`;
}

// ---- Markup. Everything shown is the snapshot's own text; names and feed text are escaped.
// A pick's grade: the row class, the words in the expanded list, the spoken word and the compact mark.
const RESULT={correct:['ok','✓ Correct','correct','✓'],incorrect:['bad','✕ Incorrect','incorrect','✕'],tie:['bad','✕ Tie · 1 loss','tie, one loss','✕'],pending:['pending','Pending','pending',''],void:['void','VOID','void',''],hold:['hold','HOLD','hold','']};
function badge(team,size=''){
  return`<span class="pm-badge${size?` ${size}`:''}" style="--tc:${esc(team?.color||'#33465f')}" aria-hidden="true"><span class="pm-badge-code">${esc(team?.code)}</span>${team?.logo?`<img class="pm-logo" src="${esc(team.logo)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">`:''}</span>`;
}
// The compact result token (chip) of one entry: the name (its compact label when shortened, with the full name for assistive
// technology), the pick (— without one) and, once the game is decided, the mark. A VOID or HOLD game's tokens carry no mark:
// the card's one status pill already says so.
function tokenHtml(pick,result,label=null){
  const [cls,,word,mark]=RESULT[result]||RESULT.pending;
  const code=pick?.team?esc(pick.team):'—',name=esc(pick?.name),shown=label==null?name:esc(label);
  const nameHtml=shown===name?name:`<span class="pm-token-short" aria-hidden="true">${shown}</span><span class="pm-sr">${name}</span>`;
  return`<span class="pm-token ${cls}${pick?.team?'':' no-pick'}"><span class="pm-token-name">${nameHtml}</span><span class="pm-token-pick">${code}</span>${mark?`<span class="pm-token-mark" role="img" aria-label="${esc(word)}">${mark}</span>`:''}</span>`;
}
// Chips for this many compared entries or more are denser.
const DENSE_FROM=4;
function pickHtml(pick,result){
  const [cls,word]=RESULT[result]||RESULT.pending;
  if(!pick?.team)return`<li class="pm-pick ${cls} no-pick-row"><span class="pm-name">${esc(pick?.name)}</span><span class="pm-pick-team no-pick">NO PICK</span><span class="pm-result">${result==='pending'?'Pending':result==='correct'?'✓':result==='incorrect'||result==='tie'?'✕ No pick':word}</span></li>`;
  return`<li class="pm-pick ${cls}"><span class="pm-name">${esc(pick.name)}</span><span class="pm-pick-team">${badge(pick.teamInfo,'mini')}<span>${esc(pick.team)}</span></span><span class="pm-result">${word}</span></li>`;
}
const kindOf=game=>KINDS.includes(game?.kind)?game.kind:'upcoming';
const selectedPicks=(game,selected)=>{
  const away=game.away||{},home=game.home||{},teamInfo={[away.code]:away,[home.code]:home};
  return(game.picks||[]).filter(p=>selected.includes(p.name)).map(p=>({...p,teamInfo:teamInfo[p.team]||{code:p.team}}));
};
// The collapsed card: the moment (the Eastern kickoff, or the clock while live), one status pill, the compact flags that
// make an exceptional game recognisable at a glance, both teams with their logos and the verified score, the chevron and
// one result token per selected entry. Scores, status and flags appear here only; the expanded part never repeats them.
// With compact labels (a Map of name to label) the chips sit on one row, one column per entry, so the same entry is in the
// same column on every card; with full labels they keep their width and wrap.
export function summaryHtml(game,selected,{time=null,labels=null}={}){
  const kind=kindOf(game),away=game.away||{},home=game.home||{},scored=Number.isInteger(game.awayScore)&&Number.isInteger(game.homeScore);
  const winner=kind==='final'?game.winner:null;
  const moment=kind==='live'?(game.detail||'LIVE'):time?time:kind==='upcoming'?(game.detail||'Kickoff TBD'):'';
  const detail=kind==='final'||kind==='tie'?(game.detail&&!/^final$/i.test(game.detail)?game.detail:''):kind==='void'||kind==='hold'?(game.note||(kind==='void'?'Commissioner ruling':'Ruling data unavailable')):'';
  const flags=[game.underReview?'<span class="pm-flag pm-flag-review">UNDER REVIEW</span>':'',kind==='hold'&&game.hold?'<span class="pm-flag pm-flag-issue">NOT GRADED</span>':'',game.issue?'<span class="pm-flag pm-flag-issue">NOT VERIFIED</span>':'',game.tiebreak?'<span class="pm-flag pm-flag-tiebreak">TIEBREAK</span>':''].filter(Boolean).join('');
  const side=(team,isHome)=>`<span class="pm-side ${isHome?'pm-home':'pm-away'}${winner&&winner===team.code?' pm-winner':''}">${isHome?'':badge(team)}${isHome&&scored?`<span class="pm-score">${game.homeScore}</span>`:''}<span class="pm-code">${esc(team.code)}</span>${!isHome&&scored?`<span class="pm-score">${game.awayScore}</span>`:''}${isHome?badge(team):''}</span>`;
  const picks=selectedPicks(game,selected),map=labels instanceof Map?labels:null,tokens=picks.map(p=>tokenHtml(p,p.result,map?map.get(p.name)??null:null)).join('');
  const results=`<span class="pm-results${picks.length>=DENSE_FROM?' is-dense':''}${map?' is-grid':''}" style="--pm-cols:${Math.max(1,picks.length)}">`;
  return`<span class="pm-top">${moment?`<span class="pm-moment">${esc(moment)}</span>`:''}<span class="pm-status pm-status-${kind}">${KIND_LABEL[kind]}</span>${flags}${detail?`<span class="pm-detail">${esc(detail)}</span>`:''}<span class="pm-chevron" aria-hidden="true"></span></span><span class="pm-matchup">${side(away,false)}<span class="pm-at">@</span>${side(home,true)}</span>${results}${tokens||'<span class="pm-token pending"><span class="pm-token-name">No entry selected</span></span>'}</span>`;
}
// The expanded part: each selected entry's pick with the grade the table gives it, the full-field ownership of each side
// when the field is published, and the explanations behind the compact flags in the page's own words.
export function detailsHtml(game,selected){
  const kind=kindOf(game),away=game.away||{},home=game.home||{};
  const picks=selectedPicks(game,selected).map(p=>pickHtml(p,p.result)).join('');
  const ownership=game.ownership?`<div class="pm-ownership" aria-label="Full-field pick ownership"><span${game.ownership.away.pct<=35?' class="contrarian"':''}>${esc(away.code)} ${game.ownership.away.pct}%</span><small>of ${game.ownership.away.total} entries</small><span${game.ownership.home.pct<=35?' class="contrarian"':''}>${game.ownership.home.pct}% ${esc(home.code)}</span></div>`:'';
  const notes=[kind==='void'?`<span class="pm-why pm-why-void"><b>Void</b>${esc(game.note||'Commissioner ruling')} · removed from scoring · listed in every status filter</span>`:'',
    kind==='hold'?`<span class="pm-why pm-why-issue"><b>Not graded</b>${esc(game.hold||game.note||'Ruling data unavailable')} · listed in every status filter</span>`:'',
    game.underReview?`<span class="pm-why pm-why-review"><b>Under review</b>${esc(game.underReview)}</span>`:'',
    game.issue?`<span class="pm-why pm-why-issue"><b>Not verified</b>${esc(game.issue)}</span>`:'',
    game.tiebreak?`<span class="pm-why pm-why-tiebreak"><b>Tiebreak game</b>activates when this game is final</span>`:''].filter(Boolean).join('');
  return`<ul class="pm-picks">${picks||'<li class="pm-pick pending"><span class="pm-name">No entry selected</span></li>'}</ul>${ownership}${notes?`<div class="pm-whys">${notes}</div>`:''}`;
}
export function cardHtml(game,selected,{time=null,expanded=false,labels=null}={}){
  const kind=kindOf(game),away=game.away||{},home=game.home||{},i=esc(game.index),on=expanded===true;
  return`<article class="pm-card pm-kind-${kind}${on?' is-expanded':''}" data-game="${i}" aria-label="${esc(`${away.code} at ${home.code}, ${KIND_LABEL[kind]}`)}"><button type="button" class="pm-summary" data-picks-expand="${i}" aria-expanded="${on}" aria-controls="pm-details-${i}">${summaryHtml(game,selected,{time,labels})}</button><div class="pm-details" id="pm-details-${i}"${on?'':' hidden'}>${detailsHtml(game,selected)}</div></article>`;
}
// One kickoff slate: a heading whose one control is the disclosure button, named by the slate, its date and game count and,
// while collapsed, the compact summary pills, with aria-expanded and the id of the body it controls; then the body with the
// slate's cards. The id is the slate key with every character outside letters, digits, - and _ replaced.
const slateId=key=>`pm-slate-${String(key).replace(/[^A-Za-z0-9_-]/g,'-')}`;
const PILLS=[['live','LIVE'],['final','FINAL'],['tie','FINAL TIE'],['upcoming','UPCOMING'],['void','VOID'],['hold','HOLD'],['review','UNDER REVIEW'],['issue','NOT VERIFIED']];
export function slateSummaryHtml(group){
  const s=slateSummary(group),pill=(tone,text)=>`<span class="pm-slate-pill pm-slate-pill-${tone}">${text}</span>`;
  return[...PILLS.map(([field,label])=>s[field]?pill(field,`${s[field]} ${field==='tie'&&s[field]!==1?'FINAL TIES':label}`):''),s.tiebreak?pill('tiebreak','TIEBREAK'):''].join('');
}
export function slateHtml(group,selected,{open=true,expanded=null,labels=null}={}){
  const id=slateId(group.key),on=open===true,count=group.games.length,meta=[group.date,`${count} game${count===1?'':'s'}`].filter(Boolean).join(' · ');
  return`<section class="pm-group${on?'':' is-collapsed'}" data-slate="${esc(group.key)}" aria-label="${esc(group.label)}"><h3 class="pm-group-title"><button type="button" class="pm-slate-toggle" data-picks-slate-toggle="${esc(group.key)}" aria-expanded="${on}" aria-controls="${esc(id)}"><span class="pm-slate-chevron" aria-hidden="true"></span><span class="pm-slate-copy"><span class="pm-slate-name">${esc(group.label)}</span><small class="pm-slate-meta">${esc(meta)}</small></span><span class="pm-slate-summary">${slateSummaryHtml(group)}</span></button></h3><div class="pm-slate-body" id="${esc(id)}"${on?'':' hidden'}>${group.games.map(({game,time})=>cardHtml(game,selected,{time,expanded:expanded!==null&&game.index===expanded,labels})).join('')}</div></section>`;
}
// Expand all and Collapse all, above the slates of All Slates.
export function slatesBarHtml(){
  return'<div class="pm-slates-bar" role="group" aria-label="Slates"><button type="button" class="pm-slates-action" data-picks-slates="expand">Expand all</button><button type="button" class="pm-slates-action" data-picks-slates="collapse">Collapse all</button></div>';
}
// The board: the slate, the status and Disagreements only (two or more compared entries) apply together; the labels mode
// decides how the chips name the entries; each slate is open or collapsed by its state (slates: a Map or an object of key to
// {open} or to a boolean) or, without one, by its default, and All Slates carries Expand all and Collapse all.
export function boardHtml(snapshot,{entrants=null,status='all',slate=ALL_SLATES,expanded=null,disagree=false,labels='full',slates=null}={},{timeZone=TIME_ZONE}={}){
  if(!snapshot||snapshot.ready!==true)return`<div class="empty">${esc(snapshot?.reason||'Picks are not available yet.')}</div>`;
  const names=(snapshot.entrants||[]).map(e=>e.name),selected=normalizeSelection({version:PREFERENCES_VERSION,entrants:entrants||names},names);
  const map=labels==='compact'?labelMap(names,'compact'):null,only=disagree===true&&selected.length>=2;
  const options=slateOptions(snapshot.games,{timeZone}),key=resolveSlate(slate,options),label=options.find(o=>o.key===key)?.label||'';
  const listed=filterGames(filterSlate(snapshot.games,key,{timeZone}),status),shown=filterDisagreements(listed,selected,only);
  if(!shown.length)return`<div class="empty">${esc(only&&listed.length?emptyDisagreements(names,selected,status,key===ALL_SLATES?'':label):key===ALL_SLATES?(EMPTY[status]||EMPTY.all):`No ${STATUS_FILTERS.includes(status)&&status!=='all'?`${STATUS_LABELS[status].toLowerCase()} `:''}games in ${label}.`)}</div>`;
  return(key===ALL_SLATES?slatesBarHtml():'')+groupGames(shown,{timeZone}).map(group=>slateHtml(group,selected,{open:slateOpen(group,key,slates),expanded,labels:map})).join('');
}
export function slateOptionsHtml(options,slate){
  const key=resolveSlate(slate,options);
  return(options||[]).map(o=>`<option value="${esc(o.key)}"${o.key===key?' selected':''}>${esc(`${o.label} (${o.count})`)}</option>`).join('');
}
// The filter bar: the one compact control for the entries compared (it opens the selection panel), the slate selector,
// the status segments with their counts, the Disagreements only switch (off until tapped, disabled with fewer than two
// entries compared) and one live note that says what is shown.
export function filterBarHtml(names,{selected=null,status='all',counts=null,slates=null,slate=ALL_SLATES,disagree=false}={}){
  const all=names||[],c=counts||{all:0,final:0,live:0,upcoming:0,exceptions:0},options=slates||[{key:ALL_SLATES,label:'All Slates',date:'',count:c.all}];
  const chosen=normalizeSelection({version:PREFERENCES_VERSION,entrants:selected||all},all);
  const compare=`<button type="button" class="pm-compare" data-picks-compare aria-haspopup="dialog" aria-expanded="false" aria-controls="picksEntrants"><span class="pm-compare-copy"><span class="pm-compare-kicker">Comparing</span><b data-picks-compare-label>${esc(compareLabel(all,selected))}</b></span><span class="pm-caret" aria-hidden="true"></span></button>`;
  const select=`<label class="pm-sr" for="picksSlate">Slate</label><select id="picksSlate" class="pm-select" data-picks-slate>${slateOptionsHtml(options,slate)}</select>`;
  const segments=STATUS_FILTERS.map(s=>`<button type="button" class="pm-segment" data-picks-status="${s}" aria-pressed="${s===status}">${STATUS_LABELS[s]}<b data-picks-count="${s}">${c[s]}</b></button>`).join('');
  const toggle=`<div class="pm-options"><button type="button" class="pm-toggle" data-picks-disagree aria-pressed="${disagree===true&&chosen.length>=2}"${chosen.length<2?' disabled':''}><span class="pm-toggle-track" aria-hidden="true"></span><span class="pm-toggle-copy">Disagreements only</span></button></div>`;
  return`<div class="pm-filters"><div class="pm-row">${compare}${select}</div><div class="pm-segments" role="group" aria-label="Game status">${segments}</div>${toggle}<p class="pm-note" data-picks-note aria-live="polite"></p></div>`;
}
// The selection panel's rows: one labelled checkbox per tracked entry, with the entry's verified submission state.
export function entrantPanelHtml(entrants,selected){
  const names=(entrants||[]).map(e=>typeof e==='string'?e:e?.name),chosen=normalizeSelection({version:PREFERENCES_VERSION,entrants:selected||names},names);
  return(entrants||[]).map((e,i)=>{const name=names[i],none=typeof e==='object'&&e?.noSubmission===true;
    return`<label class="pm-entry${none?' pm-entry-none':''}"><input type="checkbox" data-picks-entrant="${esc(name)}"${chosen.includes(name)?' checked':''}><span class="pm-entry-copy"><span class="pm-entry-name">${esc(name)}</span>${none?'<span class="pm-entry-meta">No picks submitted this week</span>':''}</span></label>`}).join('');
}
export function filterNote(names,selected,status,counts,shown,notice='',slateLabel='',disagree=false){
  const all=names||[],chosen=selected||all;
  const who=chosen.length===all.length?`All ${all.length} entries`:chosen.join(' + ');
  const games=`${shown} of ${counts.all} game${counts.all===1?'':'s'}${status!=='all'?` · ${STATUS_LABELS[status]}`:''}${disagree===true?' · Disagreements only':''}`;
  return[notice,[who,slateLabel,games].filter(Boolean).join(' · '),counts.exceptions?`${counts.exceptions} VOID/HOLD shown in every ${disagree===true?'filter':'status filter'}`:''].filter(Boolean).join(' · ');
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
const sameList=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
export function boot(){
  const cards=[...document.querySelectorAll('[data-rules-card]')],board=document.getElementById('picksBoard'),filters=document.getElementById('picksFilters'),dialog=document.getElementById('picksEntrants');
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
  // The Picks board. The entrant selection is remembered in this browser; the slate, the status filter, the one expanded
  // matchup and the open slates are page state, kept through every refresh of the same week. A new week collapses every card,
  // returns every slate to its default and drops a slate that is not on its schedule.
  const state={snapshot:null,names:[],entrants:[],selection:[],status:'all',slate:ALL_SLATES,slateLabel:'',expanded:null,week:null,notice:'',dialogNote:'',saved:true,built:null,options:[],optionsHtml:'',disagree:false,labels:readLabels(),savedLabels:true,slates:new Map(),chosenOpen:null,groups:[]};
  const persist=()=>{state.saved=writeSelection(state.selection)};
  const storageNote=()=>[state.saved?'':'Selection not saved in this browser',state.savedLabels?'':'Label setting not saved in this browser'].filter(Boolean).join(' · ');
  const ready=()=>state.snapshot?.ready===true;
  const games=()=>ready()?state.snapshot.games:[];
  const slateGames=()=>filterSlate(games(),state.slate);
  // The labels mode on screen: the remembered choice, else the default for this screen. Disagreements only applies with two
  // or more entries compared; the games the counts describe and the games listed both honour it.
  const labelsMode=()=>LABEL_MODES.includes(state.labels)?state.labels:defaultLabels();
  const only=()=>state.disagree===true&&state.selection.length>=2;
  const countGames=()=>filterDisagreements(slateGames(),state.selection,only());
  const shownGames=()=>filterGames(countGames(),state.status);
  function applyExpanded(){
    if(!board)return;
    for(const toggle of board.querySelectorAll('[data-picks-expand]')){
      const on=state.expanded!==null&&Number(toggle.dataset.picksExpand)===state.expanded,details=document.getElementById(toggle.getAttribute('aria-controls')||'');
      toggle.setAttribute('aria-expanded',String(on));
      if(details)details.hidden=!on;
      toggle.closest?.('.pm-card')?.classList.toggle('is-expanded',on);
    }
  }
  // The slates of the week on screen (All Slates aside). In All Slates a slate is open by its state (state.slates), else by its
  // default; the chosen slate of the selector is open unless it was closed by hand since it was chosen (state.chosenOpen).
  const slateKeys=()=>state.options.map(o=>o.key).filter(k=>k!==ALL_SLATES);
  const slateIsOpen=key=>{
    if(state.slate!==ALL_SLATES)return state.chosenOpen!==false;
    const s=state.slates.get(key);if(s)return s.open===true;
    const group=state.groups.find(g=>g.key===key);return group?slateHasLive(group):true;
  };
  const boardSlates=()=>state.slate===ALL_SLATES?state.slates:state.chosenOpen===null?null:new Map([[state.slate,{open:state.chosenOpen,manual:true}]]);
  function applySlates(){
    if(!board)return;
    for(const section of board.querySelectorAll('.pm-group')){
      const key=section.dataset.slate,open=slateIsOpen(key),toggle=section.querySelector('[data-picks-slate-toggle]'),body=document.getElementById(toggle?.getAttribute('aria-controls')||'');
      if(toggle)toggle.setAttribute('aria-expanded',String(open));
      if(body)body.hidden=!open;
      section.classList.toggle('is-collapsed',!open);
    }
  }
  // A refresh of the same matchups keeps every card and slate element: only the summary and the detail markup that changed is
  // rewritten (a slate heading's copy and summary pills likewise), so the expanded card, the open slates, a focused control and
  // the scroll position stay where they were. A different set of matchups (another week, a filter) rebuilds the board; focus
  // then returns to the control of the same matchup, slate or action, if shown.
  function patchBoard(html){
    const fresh=document.createElement('div');fresh.innerHTML=html;
    const key=root=>[...root.querySelectorAll('.pm-group')].map(g=>g.dataset.slate);
    const cardsOf=root=>[...root.querySelectorAll('[data-game]')];
    const current=cardsOf(board),next=cardsOf(fresh);
    if(current.length&&current.length===next.length&&sameList(current.map(c=>c.dataset.game),next.map(c=>c.dataset.game))&&sameList(key(board),key(fresh))&&!!board.querySelector('.pm-slates-bar')===!!fresh.querySelector('.pm-slates-bar')){
      const groups=[...board.querySelectorAll('.pm-group')],freshGroups=[...fresh.querySelectorAll('.pm-group')];
      groups.forEach((g,i)=>{const fg=freshGroups[i];if(!fg)return;for(const part of ['.pm-slate-copy','.pm-slate-summary']){const a=g.querySelector(part),b=fg.querySelector(part);if(a&&b&&a.innerHTML!==b.innerHTML)a.innerHTML=b.innerHTML}});
      current.forEach((card,i)=>{
        const fc=next[i];
        for(const name of ['class','aria-label'])if(card.getAttribute(name)!==fc.getAttribute(name))card.setAttribute(name,fc.getAttribute(name));
        for(const part of ['.pm-summary','.pm-details']){const a=card.querySelector(part),b=fc.querySelector(part);if(a&&b&&a.innerHTML!==b.innerHTML)a.innerHTML=b.innerHTML}
      });
      return;
    }
    const active=document.activeElement,d=active&&typeof active.closest==='function'&&active.closest('#picksBoard')?(active.dataset||{}):{};
    const focused=d.picksExpand!=null?`[data-picks-expand="${d.picksExpand}"]`:d.picksSlateToggle!=null?`[data-picks-slate-toggle="${d.picksSlateToggle}"]`:d.picksSlates!=null?`[data-picks-slates="${d.picksSlates}"]`:null;
    board.innerHTML=html;
    if(focused){const again=board.querySelector(focused);if(again)again.focus?.()}
  }
  // A tap on a slate heading opens or closes that slate alone; Expand all and Collapse all (All Slates only) set every slate of
  // the week. Each is a manual choice: nothing is re-rendered, so the control keeps focus; an opened slate is brought into
  // view like an opened card.
  function toggleSlate(key,control){
    const open=!slateIsOpen(key);
    if(state.slate===ALL_SLATES)state.slates=setSlateOpen(state.slates,key,open);else state.chosenOpen=open;
    applySlates();
    if(open)reveal(control?.closest?.('.pm-group'));
  }
  function setEverySlate(open){if(state.slate!==ALL_SLATES)return;state.slates=setSlateOpen(state.slates,slateKeys(),open);applySlates()}
  // A slate chosen in the selector starts open, whatever was chosen for it before; All Slates keeps its own states meanwhile.
  function chooseSlate(slate){
    state.slate=resolveSlate(slate,state.options);state.slateLabel=state.options.find(o=>o.key===state.slate)?.label||'';
    state.chosenOpen=null;
    renderPicks();
  }
  // An opened card is brought into view above the fixed bottom navigation, never pushed past the top of the screen.
  function reveal(card){
    if(!card||typeof card.getBoundingClientRect!=='function'||typeof window==='undefined'||typeof window.scrollBy!=='function')return;
    const rect=card.getBoundingClientRect(),nav=document.querySelector('.bottom-nav'),limit=window.innerHeight-(nav?nav.getBoundingClientRect().height:0)-8;
    if(rect.bottom>limit)window.scrollBy({top:Math.min(rect.bottom-limit,Math.max(0,rect.top-8)),behavior:'smooth'});
  }
  // The panel's rows are rebuilt for another set of tracked names. The same names keep their row elements (a focused checkbox
  // keeps focus): each checkbox follows the selection, and each row's verified submission state follows the week on screen,
  // since the same entry may have submitted this week and not last (a chosen week arrives as one update, with the same names).
  function syncDialog(){
    if(!dialog)return;
    const list=dialog.querySelector('[data-picks-entrants]');
    if(list){
      const html=entrantPanelHtml(state.entrants,state.selection),key=state.names.join('\u0000');
      if(list.dataset.built!==key){list.innerHTML=html;list.dataset.built=key}
      else{
        const fresh=document.createElement('div');fresh.innerHTML=html;
        const rows=[...list.querySelectorAll('.pm-entry')],next=[...fresh.querySelectorAll('.pm-entry')];
        rows.forEach((row,i)=>{
          const fr=next[i];if(!fr)return;
          if(row.getAttribute('class')!==fr.getAttribute('class'))row.setAttribute('class',fr.getAttribute('class'));
          const a=row.querySelector('.pm-entry-copy'),b=fr.querySelector('.pm-entry-copy');if(a&&b&&a.innerHTML!==b.innerHTML)a.innerHTML=b.innerHTML;
        });
        for(const box of list.querySelectorAll('[data-picks-entrant]'))box.checked=state.selection.includes(box.dataset.picksEntrant);
      }
    }
    const mode=labelsMode();
    for(const button of dialog.querySelectorAll('[data-picks-labels]'))button.setAttribute('aria-pressed',String(button.dataset.picksLabels===mode));
    const all=dialog.querySelector('[data-picks-entrant="*"]');if(all)all.disabled=state.selection.length===state.names.length;
    const note=dialog.querySelector('[data-picks-dialog-note]');if(note)note.textContent=[state.dialogNote||'',storageNote()].filter(Boolean).join(' · ');
    state.dialogNote='';
  }
  function syncFilters(){
    if(!filters)return;
    const names=state.names,counts=statusCounts(countGames()),shown=shownGames().length;
    const key=names.join('\u0000');
    // No controls without a snapshot: the board shows the app's reason instead.
    if(!names.length){if(state.built!==key){filters.innerHTML='';state.built=key}return}
    if(state.built!==key){filters.innerHTML=filterBarHtml(names,{selected:state.selection,status:state.status,counts,slates:state.options,slate:state.slate});state.built=key;state.optionsHtml=slateOptionsHtml(state.options,state.slate)}
    const label=filters.querySelector('[data-picks-compare-label]');if(label)label.textContent=compareLabel(names,state.selection);
    const select=filters.querySelector('[data-picks-slate]');
    if(select){const html=slateOptionsHtml(state.options,state.slate);if(html!==state.optionsHtml){select.innerHTML=html;state.optionsHtml=html}if(select.value!==state.slate)select.value=state.slate}
    for(const seg of filters.querySelectorAll('[data-picks-status]'))seg.setAttribute('aria-pressed',String(seg.dataset.picksStatus===state.status));
    for(const count of filters.querySelectorAll('[data-picks-count]'))count.textContent=String(counts[count.dataset.picksCount]??0);
    const toggle=filters.querySelector('[data-picks-disagree]');
    if(toggle){toggle.setAttribute('aria-pressed',String(only()));toggle.disabled=state.selection.length<2}
    const note=filters.querySelector('[data-picks-note]');
    if(note)note.textContent=filterNote(names,state.selection,state.status,counts,shown,[state.notice,storageNote()].filter(Boolean).join(' · '),state.slate===ALL_SLATES?'':state.slateLabel,only());
    state.notice='';
  }
  function renderPicks(){
    if(!board)return;
    state.snapshot=requestSnapshot('poolcenter:picks','pickem');
    const entrants=ready()?state.snapshot.entrants:[],names=entrants.map(e=>e.name);
    if(names.join('\u0000')!==state.names.join('\u0000')){state.names=names;state.selection=readSelection(names)}
    state.entrants=entrants;
    // Disagreements only needs two entries to compare: with fewer it switches off (and its switch is disabled) and says so once.
    if(state.disagree&&state.selection.length<2){
      state.disagree=false;
      const said='Disagreements only is off: it needs two or more entries';
      state.notice=[state.notice,said].filter(Boolean).join(' · ');state.dialogNote=[state.dialogNote,said].filter(Boolean).join(' · ');
    }
    if(ready()){
      // The slate is checked against the week on screen only: while another week loads nothing is answered and nothing moves.
      const week=`${state.snapshot.season}-${state.snapshot.week}`;
      if(week!==state.week){if(state.week!==null){state.expanded=null;state.slates=new Map();state.chosenOpen=null}state.week=week}
      state.options=slateOptions(games());
      if(state.slate!==ALL_SLATES&&resolveSlate(state.slate,state.options)===ALL_SLATES){state.notice=`${state.slateLabel||'The chosen slate'} is not on this week's schedule · showing All Slates`;state.slate=ALL_SLATES;state.slateLabel='';state.chosenOpen=null}
      const shown=shownGames();
      if(state.expanded!==null&&!shown.some(g=>g.index===state.expanded))state.expanded=null;
      // The slates listed and, in All Slates, their states: a new slate at its default, one that went live opened, the rest as
      // they were.
      state.groups=groupGames(shown);
      if(state.slate===ALL_SLATES)state.slates=nextSlateStates(state.slates,state.groups,{keys:slateKeys()});
    }
    patchBoard(boardHtml(state.snapshot,{entrants:state.selection,status:state.status,slate:state.slate,expanded:state.expanded,disagree:only(),labels:labelsMode(),slates:boardSlates()}));
    applyExpanded();applySlates();
    syncFilters();syncDialog();
  }
  const setSelection=(next,{refusedName=null}={})=>{
    if(sameList(next,state.selection)){if(refusedName)state.dialogNote=state.notice='At least one entry stays selected'}
    else{state.selection=next;persist()}
    renderPicks();
  };
  const setLabels=mode=>{if(!LABEL_MODES.includes(mode))return;state.labels=mode;state.savedLabels=writeLabels(mode);renderPicks()};
  function openDialog(opener){
    if(!dialog)return;
    syncDialog();
    if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','')}
    opener?.setAttribute('aria-expanded','true');
    dialog.querySelector('[data-picks-entrant]')?.focus?.();
    dialog.addEventListener('close',()=>{opener?.setAttribute('aria-expanded','false');opener?.focus?.()},{once:true});
  }
  function closeDialog(){
    if(!dialog)return;
    if(typeof dialog.close==='function'&&dialog.open)dialog.close();
    else{dialog.removeAttribute('open');dialog.dispatchEvent(new CustomEvent('close'))}
  }
  if(board){
    const host=board.closest?.('.picks');if(host)host.classList.add('is-mobile-ready');
    const panel=board.closest?.('[data-view-panel]');if(panel)panel.classList.add('is-mobile-ready');
    board.hidden=false;if(filters)filters.hidden=false;
    board.addEventListener('click',event=>{
      const heading=event.target?.closest?.('[data-picks-slate-toggle]'),action=event.target?.closest?.('[data-picks-slates]');
      if(heading){toggleSlate(heading.dataset.picksSlateToggle,heading);return}
      if(action){setEverySlate(action.dataset.picksSlates==='expand');return}
      const toggle=event.target?.closest?.('[data-picks-expand]');if(!toggle)return;
      const i=Number(toggle.dataset.picksExpand);
      state.expanded=state.expanded===i?null:i;
      applyExpanded();
      if(state.expanded!==null)reveal(toggle.closest?.('.pm-card'));
    });
    filters?.addEventListener('click',event=>{
      const compare=event.target?.closest?.('[data-picks-compare]'),segment=event.target?.closest?.('[data-picks-status]'),toggle=event.target?.closest?.('[data-picks-disagree]');
      if(compare)openDialog(compare);
      else if(segment&&STATUS_FILTERS.includes(segment.dataset.picksStatus)){state.status=segment.dataset.picksStatus;renderPicks()}
      else if(toggle&&!toggle.disabled){state.disagree=!state.disagree;renderPicks()}
    });
    filters?.addEventListener('change',event=>{
      const select=event.target?.closest?.('[data-picks-slate]');if(!select)return;
      chooseSlate(select.value);
    });
    dialog?.addEventListener('change',event=>{
      const box=event.target?.closest?.('[data-picks-entrant]');if(!box||box.dataset.picksEntrant==='*')return;
      const name=box.dataset.picksEntrant,next=toggleEntrant(state.selection,state.names,name);
      if(sameList(next,state.selection)&&!box.checked)box.checked=true;
      setSelection(next,{refusedName:name});
    });
    dialog?.addEventListener('click',event=>{
      if(event.target===dialog){closeDialog();return}
      const labels=event.target?.closest?.('[data-picks-labels]');
      if(event.target?.closest?.('[data-picks-close]'))closeDialog();
      else if(event.target?.closest?.('[data-picks-entrant="*"]'))setSelection(toggleEntrant(state.selection,state.names,'*'));
      else if(labels)setLabels(labels.dataset.picksLabels);
    });
  }
  document.addEventListener('poolcenter:update',event=>{const contest=event?.detail?.contest;if(contest==='pickem'){renderPicks();renderRules('pickem')}else if(contest==='survivor')renderRules('survivor')});
  for(const contest of rules.keys())renderRules(contest);
  renderPicks();
  return{get state(){return{...state,selection:state.selection.slice(),names:state.names.slice(),options:state.options.slice(),slates:new Map([...state.slates].map(([k,s])=>[k,{...s}])),groups:state.groups.slice()}},rules,renderPicks,renderRules,openDialog,closeDialog,
    setStatus(status){if(STATUS_FILTERS.includes(status)){state.status=status;renderPicks()}},
    setSlate(slate){chooseSlate(slate)},
    setExpanded(index){state.expanded=Number.isInteger(index)?index:null;applyExpanded()},
    setSelection(names){setSelection(normalizeSelection({version:PREFERENCES_VERSION,entrants:names},state.names))},
    setDisagree(on){state.disagree=on===true;renderPicks()},
    setLabels};
}
if(typeof document!=='undefined'&&typeof document.querySelectorAll==='function'&&typeof document.getElementById==='function'&&(document.getElementById('picksBoard')||document.querySelector?.('[data-rules-card]')))boot();
