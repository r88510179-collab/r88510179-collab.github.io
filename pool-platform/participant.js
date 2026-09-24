import {PLATFORM_CONFIG} from './platform-config.js';
import {PlatformClient} from './platform-client.js';
import {SUBMISSION_SOURCES,validatePickPayload} from './submission-core.js';
import {normalizeGames,pickemPayloadFromSelections,survivorLegalTeams,validateSurvivorSelection,entrySubmissionAccess} from './participant-core.js';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const params=new URLSearchParams(location.search);
const poolSlug=params.get('pool')||PLATFORM_CONFIG.defaultPoolSlug;
let inviteToken=params.get('invite')||'';
const sandboxType=params.get('type')==='survivor'?'survivor':'pickem';
const client=new PlatformClient(PLATFORM_CONFIG);
const state={context:null,entry:null,session:null,pendingEmail:'',sandbox:!client.live};

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
function cleanInviteFromUrl(){
  if(!params.has('invite'))return;
  params.delete('invite');
  history.replaceState(null,'',params.toString()?`${location.pathname}?${params.toString()}`:location.pathname);
}
function setAuthVisible(){show('authCard',client.live&&!state.session);show('signOut',client.live&&!!state.session)}
async function loadLiveContext(){const selectedId=state.entry?.id||null;state.context=await client.participantContext(poolSlug,null,null);renderContext(selectedId)}
async function claimInviteIfPresent(){if(!inviteToken||!state.session)return;await client.claimInvite(inviteToken);inviteToken='';cleanInviteFromUrl()}

async function initialize(){
  await client.init();$('modePill').textContent=client.live?'LIVE · secure':'SANDBOX · synthetic';
  if(!client.live){state.context=syntheticContext(sandboxType);renderContext();return}
  state.session=await client.getSession();setAuthVisible();
  if(state.session){try{await claimInviteIfPresent();await loadLiveContext()}catch(e){message('authError',e.message)}}
}

$('sendCode').addEventListener('click',async()=>{message('authError','');try{state.pendingEmail=await client.sendOtp($('email').value);show('otpWrap',true);$('otp').focus()}catch(e){message('authError',e.message)}});
$('verifyCode').addEventListener('click',async()=>{message('authError','');try{state.session=await client.verifyOtp(state.pendingEmail||$('email').value,$('otp').value);setAuthVisible();await claimInviteIfPresent();await loadLiveContext()}catch(e){message('authError',e.message)}});
$('otp').addEventListener('keydown',e=>{if(e.key==='Enter')$('verifyCode').click()});
$('signOut').addEventListener('click',async()=>{await client.signOut();state.session=null;state.context=null;state.entry=null;show('entryCard',false);show('pickForm',false);show('submittedCard',false);setAuthVisible()});

function renderContext(preferredEntryId=null){
  const c=state.context;
  if(!c||!Array.isArray(c.entries)||!c.entries.length){show('entryCard',false);show('pickForm',false);show('emptyCard',true);return}
  show('emptyCard',false);show('entryCard',true);
  $('poolName').textContent=c.pool.display_name;
  $('poolTypeLabel').textContent=c.pool.pool_type==='survivor'?'Survivor football pool':'Weekly Pick’em football pool';
  $('weekLabel').textContent=`Week ${c.week.week}`;$('deadlineLabel').textContent=formatDeadline(c.week.deadline_at);
  const select=$('entrySelect');select.innerHTML=c.entries.map(e=>`<option value="${e.id}">${esc(e.display_name)}</option>`).join('');
  show('entrySelectWrap',c.entries.length>1);state.entry=c.entries.find(e=>e.id===preferredEntryId)||c.entries[0];select.value=state.entry.id;
  select.onchange=()=>{state.entry=c.entries.find(e=>e.id===select.value)||c.entries[0];renderEntry()};renderEntry();
}
function currentAccess(){return entrySubmissionAccess(state.entry,state.context.week.status,new Date().toISOString(),state.context.week.deadline_at)}
function renderEntry(){
  show('submittedCard',false);
  const access=currentAccess(),sub=state.entry.submission;
  if(access.reason==='commissioner_claimed')$('sourceNotice').textContent='This entry was already submitted through the commissioner channel. Direct participant submission is closed for this week.';
  else if(access.reason==='participant_update')$('sourceNotice').textContent='You already submitted this entry. You may update it from this same participant channel until the deadline.';
  else if(access.reason==='closed'||access.reason==='locked')$('sourceNotice').textContent='This week is closed or this submission is locked. Your saved picks are read-only.';
  else $('sourceNotice').textContent='Direct participant entry is available. Your final submission claims this entry/week and prevents a commissioner import from overwriting it.';
  if(state.context.pool.pool_type==='survivor')renderSurvivor(access,sub);else renderPickem(access,sub);
}
function renderPickem(access,sub){
  const games=normalizeGames(state.context.week.config),saved=sub?.payload?.picks||{};
  $('games').innerHTML=games.map((g,i)=>`<fieldset class="game"><legend>Game ${i+1}</legend><div class="matchup-label">${esc(g.away.label)} vs ${esc(g.home.label)}</div><div class="choices">${['away','home'].map(side=>`<div class="pick-option"><input type="radio" id="game-${i}-${side}" name="game-${i}" value="${side}" ${saved[g.id]===side?'checked':''} ${access.editable?'':'disabled'}><label for="game-${i}-${side}">${esc(g[side].label)}</label></div>`).join('')}</div></fieldset>`).join('');
  const required=state.context.week.config?.tiebreakRequired===true||state.context.week.config?.tiebreak_required===true;
  show('tiebreakCard',required);$('tiebreak').disabled=!access.editable;$('tiebreak').value=sub?.payload?.tiebreak??'';show('pickForm',true);setFormEditable(access.editable);updateSummary();
}
function renderSurvivor(access,sub){
  const teams=survivorLegalTeams(state.context.week.config,state.entry.history);
  $('games').innerHTML=`<fieldset class="game full"><legend>Choose one team</legend><div class="survivor-choice-grid">${teams.map((team,i)=>`<div class="pick-option"><input type="radio" id="team-${i}" name="survivor-team" value="${esc(team.key)}" ${sub?.payload?.team===team.key?'checked':''} ${access.editable&&!team.burned?'':'disabled'}><label for="team-${i}">${esc(team.label)}${team.burned?' · USED':''}</label></div>`).join('')}</div></fieldset>`;
  show('tiebreakCard',false);show('pickForm',true);setFormEditable(access.editable);updateSummary();
}
function setFormEditable(editable){$('clearBtn').disabled=!editable;$('submitBtn').disabled=!editable;$('submitBtn').textContent=state.entry.submission?.source==='participant'?'Update picks':'Submit picks'}
function pickemSelections(){const selections={};normalizeGames(state.context.week.config).forEach((game,i)=>{const checked=document.querySelector(`input[name="game-${i}"]:checked`);if(checked)selections[game.id]=checked.value});return selections}
function updateSummary(){
  const c=state.context;if(!c)return;
  if(c.pool.pool_type==='survivor'){
    const checked=document.querySelector('input[name="survivor-team"]:checked'),team=survivorLegalTeams(c.week.config,state.entry.history).find(x=>x.key===checked?.value);
    $('summary').innerHTML=`<div class="summary-row"><span>Survivor selection</span><strong>${team?esc(team.label):'—'}</strong></div>`;return;
  }
  const selections=pickemSelections();
  $('summary').innerHTML=normalizeGames(c.week.config).map(g=>{const side=selections[g.id];return`<div class="summary-row"><span>${esc(g.away.label)} vs ${esc(g.home.label)}</span><strong>${side?esc(g[side].label):'—'}</strong></div>`}).join('')+`<div class="summary-row"><span>Tiebreak</span><strong>${$('tiebreak').value||'—'}</strong></div>`;
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
  $('submitBtn').disabled=true;
  try{
    let result;
    if(client.live){result=await client.submitEntry({weekId:state.context.week.id,entryId:state.entry.id,source:SUBMISSION_SOURCES.PARTICIPANT,payload});await loadLiveContext()}
    else{
      const existing=state.entry.submission;if(existing&&existing.source!=='participant')throw new Error('This entry was already submitted through the commissioner channel.');
      state.entry.submission={source:'participant',status:'submitted',payload,revision:(existing?.revision||0)+1,submitted_at:new Date().toISOString()};renderEntry();result={code:existing?'updated':'created',revision:state.entry.submission.revision};
    }
    $('submittedTitle').textContent=result?.code==='updated'?'Picks updated':'Participant channel claimed';$('submittedMessage').textContent='Your picks are saved. A commissioner import cannot overwrite this entry/week.';$('submittedMeta').textContent=`Revision ${result?.revision||state.entry.submission?.revision||1} · same-source edits remain available only while the week is open.`;show('submittedCard',true);
  }catch(e){message('validation',e.message);$('validation').focus()}finally{$('submitBtn').disabled=!currentAccess().editable}
});
initialize().catch(e=>message('authError',e.message));
if('serviceWorker' in navigator){navigator.serviceWorker.register('./service-worker.js').catch(()=>{})}
