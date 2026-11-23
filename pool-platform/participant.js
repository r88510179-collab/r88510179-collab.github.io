import {CONFIG_UNAVAILABLE,PlatformClient,SIGN_IN_CHANGED,SIGNED_OUT_ELSEWHERE,restartAfterSignInChange,takeSignInChangedMark,watchSignIn} from './platform-client.js';
import {SUBMISSION_SOURCES,validatePickPayload} from './submission-core.js';
import {normalizeGames,pickemPayloadFromSelections,survivorLegalTeams,validateSurvivorSelection,entrySubmissionAccess,chooseParticipantPool} from './participant-core.js';
import {authErrorMessage,readInviteFromUrl} from './auth-core.js';
import './sw-register.js';
import {createGameDayBoard} from './game-day-board.js';
import {createPoolStandingsBoard} from './pool-standings-board.js';
import {createSeasonStandingsBoard} from './season-standings-board.js';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
// INV-SSO-01: the invitation URL carries an entry identifier, never a bearer secret.
// Netlify's perimeter can redirect before this script runs. Once this script runs,
// remove the non-secret entry hint from the address bar and keep it only in memory.
// Old fragment-token links are rejected; they cannot be made safe retroactively.
// Set when this page was started again because the browser's sign-in changed under it (see platform-client.js). Read
// first, so the mark is out of the address before the invitation check looks at it.
const signInChanged=takeSignInChangedMark();
const invite=readInviteFromUrl(location.href);
if(invite.found)history.replaceState(null,'',invite.cleanUrl);
let inviteEntryId=invite.entryId;
const inviteError=invite.error?authErrorMessage(invite.error):'';
if(inviteError)message('sessionError',inviteError);
// Fragment changes cannot introduce valid new invitations: links are token-free
// query parameters and require a fresh navigation after SSO authorization.
window.addEventListener('hashchange',()=>{
  if(readInviteFromUrl(location.href).error)location.reload();
});
// The service worker never stores platform-config.js, so no cached copy can pin this page to an old backend. When it
// cannot be read (offline, or missing from the deployment) the page says so and stops: it never falls back to the sandbox.
const {PLATFORM_CONFIG}=await import('./platform-config.js').catch(e=>{$('modePill').textContent='UNAVAILABLE';message('sessionError',CONFIG_UNAVAILABLE);throw e});
const params=new URLSearchParams(location.search);
const sandboxType=params.get('type')==='survivor'?'survivor':'pickem';
const client=new PlatformClient(PLATFORM_CONFIG);
// Live entry discovery is account-scoped. A generic link never falls back to
// an unrelated default pool slug from a build setting.
const initialPoolSlug=params.get('pool')||(!client.live?PLATFORM_CONFIG.defaultPoolSlug:'');
const state={context:null,entry:null,session:null,pendingEmail:'',sandbox:!client.live,poolSlug:initialPoolSlug,availablePools:[],preferredEntryId:null};
const standingsBoard=createPoolStandingsBoard($('poolStandingsCard'),{client});
const seasonBoard=createSeasonStandingsBoard($('seasonStandingsCard'),{client});
const gameDayBoard=createGameDayBoard($('scoreboardCard'),{onUpdate:event=>standingsBoard.setScores(event)});

function syntheticContext(type){
  const games=[
    {id:'g1',away:{key:'austin',label:'Austin'},home:{key:'denver',label:'Denver'}},
    {id:'g2',away:{key:'phoenix',label:'Phoenix'},home:{key:'seattle',label:'Seattle'}},
    {id:'g3',away:{key:'nashville',label:'Nashville'},home:{key:'baltimore',label:'Baltimore'}},
    {id:'g4',away:{key:'charlotte',label:'Charlotte'},home:{key:'chicago',label:'Chicago'}},
    {id:'g5',away:{key:'las-vegas',label:'Las Vegas'},home:{key:'miami',label:'Miami'}},
    {id:'g6',away:{key:'new-york',label:'New York'},home:{key:'los-angeles',label:'Los Angeles'}}
  ];
  const deadline=new Date(Date.now()+86400000).toISOString();
  return{
    pool:{id:'demo-pool',slug:'demo-football-pool',display_name:type==='survivor'?'Neighborhood Survivor':'Neighborhood Pick’em',pool_type:type,rules:{},branding:{}},
    season:{id:'demo-season',season:2027,config:{}},
    week:{id:'demo-week',week:3,status:'open',opens_at:null,deadline_at:deadline,config:{games,tiebreakRequired:type==='pickem'}},
    entries:[
      {id:'demo-entry-1',entry_code:'E07',display_name:'Demo Entry 07',status:'active',submission:null,history:type==='survivor'?[{week:1,payload:{team:'austin'}},{week:2,payload:{team:'seattle'}}]:[]},
      {id:'demo-entry-2',entry_code:'E08',display_name:'Demo Entry 08',status:'active',submission:null,history:[]}
    ]
  };
}

function show(id,on=true){$(id).classList.toggle('hidden',!on)}
function message(id,text){$(id).textContent=text;show(id,!!text)}
function formatDeadline(value){
  const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';
}
function setAuthVisible(){show('authCard',client.live&&!state.session);show('signOut',client.live&&!!state.session)}
function resetPoolView(){
  standingsBoard.hide();seasonBoard.hide();gameDayBoard.hide();state.context=null;state.entry=null;
  for(const id of ['entryCard','pickForm','submittedCard','emptyCard'])show(id,false);
}
function showPoolChoice(error=''){
  resetPoolView();
  $('authorizedPoolSelect').replaceChildren();
  for(const pool of state.availablePools){
    const option=document.createElement('option');option.value=pool.slug;
    option.textContent=pool.display_name+' ('+(pool.pool_type==='survivor'?'Survivor':'Pick’em')+')';
    $('authorizedPoolSelect').append(option);
  }
  const available=state.availablePools.length>0;
  show('poolPickerCard',available);
  if(!available){
    $('emptyMessage').textContent=error||'No active pool entries are linked to this account. Ask the pool organizer for an invitation.';
    show('emptyCard',true);
  }
  message('poolPickerError',available?error:'');
  if(available)$('authorizedPoolSelect').focus();
}
async function loadLiveContext(){
  const selectedId=state.preferredEntryId||state.entry?.id||null,session=state.session,slug=state.poolSlug;
  const ownedPool=state.availablePools.find(pool=>pool.slug===slug);
  const context=await client.participantContext(slug,ownedPool?.season??null,null);
  if(state.session!==session||state.poolSlug!==slug)return;
  state.context=context;show('poolPickerCard',false);renderContext(selectedId);
  if(state.preferredEntryId&&context.entries.some(e=>e.id===state.preferredEntryId))
    state.preferredEntryId=null;
}
async function discoverParticipantPools(){
  const session=state.session;
  let found;
  try{found=chooseParticipantPool(await client.listParticipantPools(),state.poolSlug)}
  catch(e){
    if(state.session!==session)return;
    // A temporary discovery RPC outage must not break an existing private pool link:
    // the per-pool context independently enforces signed entry ownership.
    if(state.poolSlug){try{await loadLiveContext();return}catch{}}
    if(state.session!==session)return;
    state.availablePools=[];
    showPoolChoice('Your pool list could not be loaded. Reopen your private pool link or try again.');
    return;
  }
  if(state.session!==session)return;
  state.availablePools=found.available;
  if(found.selected){
    state.poolSlug=found.selected;
    try{
      await loadLiveContext();
      if(state.session===session&&state.context)history.replaceState(null,'',`?pool=${encodeURIComponent(state.poolSlug)}`);
      return;
    }catch(e){
      if(state.session!==session)return;
      // An authorized pool may have no published week yet. Offer the selector
      // rather than claiming that this account owns no entry.
      showPoolChoice(String(e?.code||'').includes('week_not_found')
        ?'Your organizer has not published a week for this pool yet.'
        :'This pool cannot be opened right now. Select another pool or contact your organizer.');
      return;
    }
  }
  if(found.ambiguous.length&&!found.available.length){
    showPoolChoice('Two of your pools use the same code. Ask the organizer for a distinct pool link.');
  }else if(found.available.length){
    showPoolChoice(found.ambiguous.length?'Some pools share a code and need organizer assistance. Select another available pool.':'');
  }else showPoolChoice();
}
// One in-flight claim per invitation; concurrent session callbacks must not
// produce duplicate RPC attempts or a misleading replay error. Only the
// verified-email claim RPC can authorize ownership; the route alone cannot.
let claimInFlight=null;
async function claimInviteIfPresent(){
  if(!state.session)return;
  if(inviteError)throw new Error(inviteError);
  if(!inviteEntryId)return;
  if(claimInFlight)return claimInFlight;
  const target=inviteEntryId,session=state.session;
  const call=client.claimEmailInvite(target).then(()=>{
    if(state.session!==session)return;
    // Prefer the freshly claimed entry over older owned entries on the next
    // tenant-scoped pool context refresh. Clear only after a successful claim.
    state.preferredEntryId=target;
    inviteEntryId='';
  });
  claimInFlight=call;
  try{await call}finally{if(claimInFlight===call)claimInFlight=null}
}
// Runs once a session exists. Sign out is already showing in the shell. A failed invite claim (wrong account,
// used or expired link) is reported beside it and the account's own entries still load, so reopening an invite
// link that was already claimed never hides the entry. The entry hint survives a failed claim, so the invited
// account can still claim it after switching. A refused link is reported the same way, and nothing is claimed.
// From here on the page is this account's: a pick or a claim is sent only once the server has confirmed that the
// browser is still signed in as it, and the page starts again when it is not (accountChanged).
async function openSession(notice=''){
  const session=state.session,report=e=>{if(state.session===session)message('sessionError',e.message)};
  client.bindSession(session,accountChanged);
  setAuthVisible();message('sessionError',notice);
  let claimFailed=false;
  try{await claimInviteIfPresent()}catch(e){claimFailed=true;report(e)}
  if(state.session!==session)return;
  try{await discoverParticipantPools()}catch(e){if(!claimFailed)report(e)}
}

async function initialize(){
  await client.init();$('modePill').textContent=client.live?'Connected':'Local preview';
  $('platformFooter').textContent=client.live?'Secure participant entry · connected to your pool service':'Local sample preview · no database connection';
  if(!client.live){state.context=syntheticContext(sandboxType);renderContext();return}
  state.session=await client.getSession();setAuthVisible();
  watchSignIn(client);
  if(state.session)await openSession(signInChanged?SIGN_IN_CHANGED:'');
  else if(signInChanged)message('authError',SIGNED_OUT_ELSEWHERE);
}

$('sendCode').addEventListener('click',async()=>{message('authError','');try{state.pendingEmail=await client.sendOtp($('email').value);show('otpWrap',true);$('otp').focus()}catch(e){message('authError',e.message)}});
$('verifyCode').addEventListener('click',async()=>{message('authError','');try{state.session=await client.verifyOtp(state.pendingEmail||$('email').value,$('otp').value)}catch(e){message('authError',e.message);return}await openSession()});
$('openAuthorizedPool').addEventListener('click',async()=>{
  const slug=$('authorizedPoolSelect').value,session=state.session;
  if(!state.availablePools.some(pool=>pool.slug===slug))return;
  state.poolSlug=slug;message('poolPickerError','');
  try{
    await loadLiveContext();
    if(state.session===session&&state.context)history.replaceState(null,'',`?pool=${encodeURIComponent(state.poolSlug)}`);
  }catch(e){
    if(state.session!==session)return;
    showPoolChoice(String(e?.code||'').includes('week_not_found')
      ?'Your organizer has not published a week for this pool yet.'
      :'Unable to open this pool. Try another pool or contact the organizer.');
  }
});
$('switchPool').addEventListener('click',()=>showPoolChoice());
$('otp').addEventListener('keydown',e=>{if(e.key==='Enter')$('verifyCode').click()});
// Sign out lives in the shell, so it stays reachable with no entry, after a failed invite claim and after any
// load error. It drops the session and everything loaded for it but keeps an invite that was not claimed
// (in page memory), so the verified invited account can claim it after signing in.
function clearAccount(){
  client.bindSession(null);
  standingsBoard.hide();seasonBoard.hide();gameDayBoard.hide();Object.assign(state,{session:null,context:null,entry:null,pendingEmail:'',poolSlug:'',availablePools:[],preferredEntryId:null});
  for(const id of ['entryCard','pickForm','submittedCard','emptyCard','poolPickerCard','otpWrap'])show(id,false);
  for(const id of ['games','summary','entrySelect','authorizedPoolSelect'])$(id).replaceChildren();
  $('entrySelect').onchange=null;
  for(const id of ['poolName','poolTypeLabel','weekLabel','deadlineLabel','sourceNotice','submittedTitle','submittedMessage','submittedMeta'])$(id).textContent='';
  history.replaceState(null,'',location.pathname);
  for(const id of ['email','otp','tiebreak'])$(id).value='';
  // Cleared only now, so an error that arrived while signing out does not stay on the sign-in screen.
  for(const id of ['sessionError','authError','validation','poolPickerError'])message(id,'');
  setAuthVisible();
}
$('signOut').addEventListener('click',async()=>{
  try{await client.signOut()}catch(e){message('sessionError',e.message);return}
  clearAccount();
});
// The browser is signed out, or signed in as someone else, since this page was opened: another tab did it. Nothing
// of the account this page was showing stays on it, and the page starts again as whoever is signed in now.
function accountChanged(){
  clearAccount();
  restartAfterSignInChange();
}

function renderContext(preferredEntryId=null){
  const c=state.context;
  if(!c||!Array.isArray(c.entries)||!c.entries.length){
    standingsBoard.hide();seasonBoard.hide();gameDayBoard.hide();state.entry=null;show('entryCard',false);show('pickForm',false);show('submittedCard',false);
    $('emptyMessage').textContent='No active entry was found for this account in the selected pool. Contact your organizer.';
    show('emptyCard',true);return;
  }
  show('emptyCard',false);show('entryCard',true);
  show('switchPool',state.availablePools.length>1);
  $('poolName').textContent=c.pool.display_name;
  $('poolTypeLabel').textContent=c.pool.pool_type==='survivor'?'Survivor football pool':'Weekly Pick’em football pool';
  $('weekLabel').textContent=`Week ${c.week.week}`;$('deadlineLabel').textContent=formatDeadline(c.week.deadline_at);
  const select=$('entrySelect');select.innerHTML=c.entries.map(e=>`<option value="${esc(e.id)}">${esc(e.display_name)}</option>`).join('');
  show('entrySelectWrap',c.entries.length>1);state.entry=c.entries.find(e=>e.id===preferredEntryId)||c.entries[0];select.value=state.entry.id;
  select.onchange=()=>{state.entry=c.entries.find(e=>e.id===select.value)||c.entries[0];renderEntry()};renderEntry();
  if(client.live){
    void standingsBoard.show({poolId:c.pool.id,season:c.season?.season,week:c.week?.week,
      weekId:c.week?.id,config:c.week?.config});
    void seasonBoard.show({poolId:c.pool.id,season:c.season?.season});
    gameDayBoard.show({poolId:c.pool.id,season:c.season?.season,week:c.week?.week,config:c.week?.config});
  }else{standingsBoard.hide();seasonBoard.hide();gameDayBoard.hide();}
}
function currentAccess(){return entrySubmissionAccess(state.entry,state.context.week.status,new Date().toISOString(),state.context.week.deadline_at)}
function renderEntry(){
  show('submittedCard',false);
  const access=currentAccess(),sub=state.entry.submission;
  if(access.reason==='commissioner_claimed')$('sourceNotice').textContent='Your commissioner already entered this week’s pick. Contact them if you need a correction.';
  else if(access.reason==='participant_update')$('sourceNotice').textContent='Your selection is saved. You can change it until the deadline.';
  else if(access.reason==='closed'||access.reason==='locked')$('sourceNotice').textContent='Your pick is locked. You can review it, but changes are closed.';
  else $('sourceNotice').textContent='Choose your selection, review it, and press Submit to save. You can make changes until the deadline.';
  if(state.context.pool.pool_type==='survivor')renderSurvivor(access,sub);else renderPickem(access,sub);
}
function renderPickem(access,sub){
  const games=normalizeGames(state.context.week.config),saved=sub?.payload?.picks||{};
  $('games').innerHTML=games.map((g,i)=>`<fieldset class="game"><legend>Game ${i+1}</legend><div class="matchup-label">${esc(g.away.label)} vs ${esc(g.home.label)}</div><div class="choices">${['away','home'].map(side=>`<div class="pick-option"><input type="radio" id="game-${i}-${side}" name="game-${i}" value="${side}" ${saved[g.id]===side?'checked':''} ${access.editable?'':'disabled'}><label for="game-${i}-${side}">${esc(g[side].label)}</label></div>`).join('')}</div></fieldset>`).join('');
  const required=state.context.week.config?.tiebreakRequired===true||state.context.week.config?.tiebreak_required===true;
  show('tiebreakCard',required);$('tiebreak').disabled=!access.editable;$('tiebreak').value=sub?.payload?.tiebreak??'';show('pickForm',true);setFormEditable(access.editable);updateSummary();
}
// Each choice submits its stable key and shows its display name, which carries that key whenever another
// choice shares the name; choices that would still read alike are shown but cannot be picked.
function renderSurvivor(access,sub){
  const teams=survivorLegalTeams(state.context.week.config,state.entry.history);
  $('games').innerHTML=`<fieldset class="game full"><legend>Choose one team</legend><div class="survivor-choice-grid">${teams.map((team,i)=>`<div class="pick-option"><input type="radio" id="team-${i}" name="survivor-team" value="${esc(team.key)}" ${sub?.payload?.team===team.key?'checked':''} ${access.editable&&!team.burned&&!team.ambiguous?'':'disabled'}><label for="team-${i}">${esc(team.display)}${team.burned?' · USED':team.ambiguous?' · ASK COMMISSIONER':''}</label></div>`).join('')}</div></fieldset>`;
  show('tiebreakCard',false);show('pickForm',true);setFormEditable(access.editable);updateSummary();
}
function setFormEditable(editable){$('clearBtn').disabled=!editable;$('submitBtn').disabled=!editable;const survivor=state.context.pool.pool_type==='survivor';$('submitBtn').textContent=state.entry.submission?.source==='participant'?(survivor?'Update Survivor pick':'Update picks'):(survivor?'Submit Survivor pick':'Submit picks')}
function pickemSelections(){const selections={};normalizeGames(state.context.week.config).forEach((game,i)=>{const checked=document.querySelector(`input[name="game-${i}"]:checked`);if(checked)selections[game.id]=checked.value});return selections}
// Summary rows are built from text nodes: team labels come from pool configuration and the tiebreak is
// whatever the participant typed, so neither is ever parsed as HTML.
function summaryRow(label,value){
  const row=document.createElement('div'),name=document.createElement('span'),pick=document.createElement('strong');
  row.className='summary-row';name.textContent=label;pick.textContent=value;row.append(name,pick);
  return row;
}
function updateSummary(){
  const c=state.context;if(!c)return;
  if(c.pool.pool_type==='survivor'){
    const checked=document.querySelector('input[name="survivor-team"]:checked'),team=survivorLegalTeams(c.week.config,state.entry.history).find(x=>x.key===checked?.value);
    $('summary').replaceChildren(summaryRow('Survivor selection',team?team.display:'—'));return;
  }
  const selections=pickemSelections();
  $('summary').replaceChildren(...normalizeGames(c.week.config).map(g=>{const side=selections[g.id];return summaryRow(`${g.away.label} vs ${g.home.label}`,side?g[side].label:'—')}),summaryRow('Tiebreak',$('tiebreak').value||'—'));
}
$('pickForm').addEventListener('change',updateSummary);$('tiebreak').addEventListener('input',updateSummary);
$('clearBtn').addEventListener('click',()=>{for(const input of document.querySelectorAll('#pickForm input[type="radio"]'))input.checked=false;$('tiebreak').value='';message('validation','');updateSummary()});
$('pickForm').addEventListener('submit',async event=>{
  event.preventDefault();message('validation','');if(!currentAccess().editable){message('validation','This entry is not editable.');return}
  let payload;
  if(state.context.pool.pool_type==='survivor'){
    const team=document.querySelector('input[name="survivor-team"]:checked')?.value,result=validateSurvivorSelection(team,state.context.week.config,state.entry.history);
    if(!result.ok){message('validation',result.code==='team_already_used'?'That team has already been used by this entry.':'Choose one available team.');$('validation').focus();return}
    payload={team};
  }else{
    const games=normalizeGames(state.context.week.config),required=state.context.week.config?.tiebreakRequired===true||state.context.week.config?.tiebreak_required===true;
    payload=pickemPayloadFromSelections(pickemSelections(),$('tiebreak').value);
    const result=validatePickPayload(payload,{gameIds:games.map(g=>g.id),tiebreakRequired:required});
    if(!result.ok){message('validation','Complete every game and enter a valid tiebreak when required.');$('validation').focus();return}
  }
  // Signing out while this is in flight must leave nothing of it on screen: no saved card, no error.
  $('submitBtn').disabled=true;const session=state.session;
  try{
    let result;
    if(client.live){
      result=await client.submitEntry({weekId:state.context.week.id,entryId:state.entry.id,source:SUBMISSION_SOURCES.PARTICIPANT,payload});
      if(state.session!==session)return;
      await loadLiveContext();
    }
    else{
      const existing=state.entry.submission;if(existing&&existing.source!=='participant')throw new Error('This entry was already submitted through the commissioner channel.');
      state.entry.submission={source:'participant',status:'submitted',payload,revision:(existing?.revision||0)+1,submitted_at:new Date().toISOString()};renderEntry();result={code:existing?'updated':'created',revision:state.entry.submission.revision};
    }
    if(state.session!==session)return;
    const survivor=state.context.pool.pool_type==='survivor',updated=result?.code==='updated';
    $('submittedTitle').textContent=survivor?(updated?'Survivor pick updated':'Survivor pick saved'):(updated?'Picks updated':'Picks saved');
    const team=survivor?survivorLegalTeams(state.context.week.config,state.entry.history).find(t=>t.key===payload.team):null;
    $('submittedMessage').textContent=survivor?`You chose ${team?.display||payload.team} for Week ${state.context.week.week}.`:`Your Week ${state.context.week.week} picks are saved.`;
    const access=currentAccess();
    $('submittedMeta').textContent=access.editable?`You can change ${survivor?'your selection':'your picks'} until ${formatDeadline(state.context.week.deadline_at)}.`:'Your submission is locked and cannot be changed.';
    show('submittedCard',true);
  }catch(e){if(state.session===session){message('validation',e.message);$('validation').focus()}}
  finally{if(state.context&&state.entry)$('submitBtn').disabled=!currentAccess().editable}
});
initialize().catch(e=>message('sessionError',e.message));
