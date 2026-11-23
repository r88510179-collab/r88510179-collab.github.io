import {CONFIG_UNAVAILABLE,PlatformClient,SIGN_IN_CHANGED,SIGNED_OUT_ELSEWHERE,restartAfterSignInChange,takeSignInChangedMark,watchSignIn} from './platform-client.js';
import {SUBMISSION_SOURCES} from './submission-core.js';
import {describeImportError,summarizeBatchResults} from './import-core.js';
import {participantInviteUrl,authErrorMessage,validEmail} from './auth-core.js';
import {weekSubmission,eligibleImportEntries,survivorTeams,readableGame,sampleImport,guidedCsv,previewCommissionerImport,importErrorText,weekCanAcceptPicks,chooseCommissionerPool,newEntryDraft,newDraftWeek} from './commissioner-workflow.js';
import {NFL_TEAMS,prepareManualSchedule} from './schedule-core.js';
import './sw-register.js';
import {createGameDayBoard} from './game-day-board.js';
import {createPoolStandingsBoard} from './pool-standings-board.js';
import {createSeasonStandingsBoard} from './season-standings-board.js';
import {reviewFinalScores,manualAttestationFingerprint,weekAcceptsFinalScores,scheduleBlockers,finalResultErrorMessage,STALE_RESULT_REVISION} from './final-results-form.js';

// Set when this page was started again because the browser's sign-in changed under it (see platform-client.js).
const signInChanged=takeSignInChangedMark();
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const slugValid=v=>/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(v);
function show(id,on=true){$(id).classList.toggle('hidden',!on)}
function msg(id,value){$(id).textContent=value;show(id,!!value)}
const {PLATFORM_CONFIG}=await import('./platform-config.js').catch(e=>{$('modePill').textContent='Unavailable';msg('sessionError',CONFIG_UNAVAILABLE);throw e});
const client=new PlatformClient(PLATFORM_CONFIG);
const state={session:null,context:null,season:null,week:null,pendingEmail:'',poolSlug:params.get('pool')||PLATFORM_CONFIG.defaultPoolSlug||'',availablePools:[],preview:null,entryDraft:null,weekDraft:null,scheduleDraft:null,verifiedPreview:null,openReview:null,poolCreateDraft:null,seasonCreateDraft:null};
const standingsBoard=createPoolStandingsBoard($('poolStandingsCard'),{client});
const seasonBoard=createSeasonStandingsBoard($('seasonStandingsCard'),{client});
const gameDayBoard=createGameDayBoard($('scoreboardCard'),{onUpdate:event=>standingsBoard.setScores(event)});

// These fixture values are strictly for disconnected local sandbox mode, never the connected staging backend.
function syntheticContext(){
  const games=[{id:'g1',away:{key:'austin',label:'Austin'},home:{key:'denver',label:'Denver'}},{id:'g2',away:{key:'phoenix',label:'Phoenix'},home:{key:'seattle',label:'Seattle'}}];
  return{pool:{id:'demo-pool',slug:'demo-football-pool',display_name:'Neighborhood Pick’em',pool_type:'pickem'},seasons:[{id:'demo-season',season:2027,status:'active',entries:[
    {id:'11111111-1111-1111-1111-111111111111',entry_code:'E01',display_name:'Sample Player 01',status:'active',claimed:true,submissions:[{week:3,source:'participant',status:'submitted',revision:1}]},
    {id:'22222222-2222-2222-2222-222222222222',entry_code:'E02',display_name:'Sample Player 02',status:'active',claimed:false,submissions:[]}
  ],weeks:[{id:'demo-week',week:3,status:'open',deadline_at:new Date(Date.now()+86400000).toISOString(),config:{games,tiebreakRequired:true}}]}]};
}
function setAuth(){show('authCard',client.live&&!state.session);show('signOut',client.live&&!!state.session)}
function hidePool(){standingsBoard.hide();seasonBoard.hide();gameDayBoard.hide();for(const id of ['consoleCard','entriesCard','inviteCard','importCard','importPreview','newEntryReview','newWeekReview','scheduleReview','verifiedScheduleReview','verifiedOpenReview','verifiedScheduleSetup','createPoolReview','createSeasonReview','createPoolSetup','createSeasonSetup','finalResultAdmin'])show(id,false);state.context=null;state.season=null;state.week=null;state.preview=null;state.entryDraft=null;state.weekDraft=null;state.scheduleDraft=null}
function picker(){
  hidePool();$('poolCode').value=state.poolSlug||'';
  $('authorizedPoolSelect').replaceChildren();
  for(const pool of state.availablePools){
    const option=document.createElement('option');option.value=pool.slug;
    option.textContent=`${pool.display_name} (${pool.pool_type==='survivor'?'Survivor':'Pick’em'})`;
    $('authorizedPoolSelect').append(option);
  }
  show('authorizedPoolsWrap',state.availablePools.length>0);
  show('poolPickerCard',!!state.session&&client.live);
  (state.availablePools.length?$('authorizedPoolSelect'):$('poolCode')).focus();
}
async function load(){
  const session=state.session,slug=state.poolSlug;
  if(client.live&&!slugValid(slug)){picker();return}
  const context=client.live?await client.commissionerContext(slug):syntheticContext();
  if(session!==state.session||slug!==state.poolSlug)return;
  if(!context?.pool)throw new Error('This pool could not be opened. Check its code or ask the pool organizer for access.');
  state.context=context;show('poolPickerCard',false);renderConsole();
}
async function discoverCommissionerPools(){
  const session=state.session;
  let discovered;
  try{discovered=chooseCommissionerPool(await client.listCommissionerPools(),state.poolSlug)}
  catch(e){
    // Do not let API discovery failures grant access. A known link can still be verified
    // by the existing per-pool commissioner context; otherwise show a safe picker.
    if(session!==state.session)return;
    state.availablePools=[];
    if(state.poolSlug){try{await load();return}catch{}}
    picker();msg('poolPickerError','Your available pools could not be loaded. You can try a pool code from your commissioner link.');
    return;
  }
  if(session!==state.session)return;
  state.availablePools=discovered.available;
  if(discovered.selected){
    state.poolSlug=discovered.selected;
    try{await load();if(state.context)history.replaceState(null,'',`?pool=${encodeURIComponent(state.poolSlug)}`);return}
    catch(e){msg('poolPickerError',authErrorMessage(e?.code||e?.message))}
  }
  picker();
  if(!state.availablePools.length)msg('poolPickerError','No pools are assigned to this account. Ask your pool organizer to add you or check the account you used to sign in.');
}
// From here on the page is this account's: anything that writes is sent only once the server has confirmed that the
// browser is still signed in as it, and the page starts again when it is not (accountChanged).
async function openSession(notice=''){
  const session=state.session;client.bindSession(session,accountChanged);setAuth();msg('sessionError',notice);
  if(!client.live)return;
  await discoverCommissionerPools();
  if(session!==state.session)return;
}
$('sendCode').addEventListener('click',async()=>{msg('authError','');try{state.pendingEmail=await client.sendOtp($('email').value);show('otpWrap',true);$('otp').focus()}catch(e){msg('authError',authErrorMessage(e?.code||e?.message))}});
$('verifyCode').addEventListener('click',async()=>{msg('authError','');try{state.session=await client.verifyOtp(state.pendingEmail||$('email').value,$('otp').value)}catch(e){msg('authError',authErrorMessage(e?.code||e?.message));return}await openSession()});
$('otp').addEventListener('keydown',e=>{if(e.key==='Enter')$('verifyCode').click()});
$('openPool').addEventListener('click',async()=>{
  const slug=$('poolCode').value.trim().toLowerCase();msg('poolPickerError','');
  if(!slugValid(slug)){msg('poolPickerError','Enter the pool code from your commissioner link.');return}
  state.poolSlug=slug;
  try{await load();if(state.context)history.replaceState(null,'',`?pool=${encodeURIComponent(slug)}`)}
  catch(e){msg('poolPickerError',authErrorMessage(e?.code||e?.message))}
});
$('openAuthorizedPool').addEventListener('click',async()=>{
  const slug=$('authorizedPoolSelect').value;
  if(!state.availablePools.some(p=>p.slug===slug))return;
  state.poolSlug=slug;msg('poolPickerError','');
  try{await load();if(state.context)history.replaceState(null,'',`?pool=${encodeURIComponent(slug)}`)}
  catch(e){msg('poolPickerError',authErrorMessage(e?.code||e?.message))}
});
$('poolCode').addEventListener('keydown',e=>{if(e.key==='Enter')$('openPool').click()});
$('switchPool').addEventListener('click',picker);
function clearAccount(){
  client.bindSession(null);
  Object.assign(state,{session:null,context:null,season:null,week:null,pendingEmail:'',poolSlug:'',availablePools:[],preview:null,entryDraft:null,weekDraft:null,verifiedPreview:null,openReview:null,poolCreateDraft:null,seasonCreateDraft:null});
  hidePool();show('poolPickerCard',false);show('otpWrap',false);show('inviteLinkWrap',false);
  for(const id of ['seasonSelect','weekSelect','entriesBody','inviteEntry','guidedEntry','resultBody','guidedGames','authorizedPoolSelect'])$(id).replaceChildren();
  $('seasonSelect').onchange=null;$('weekSelect').onchange=null;
  $('poolName').textContent='Pool';$('weekStatus').textContent='';
  for(const id of ['email','otp','inviteEmail','inviteLink','csvFile','importText','guidedTiebreak','poolCode','newEntryCode','newEntryName','newWeekNumber','newWeekDeadline','newWeekOpening'])$(id).value='';
  $('importHelp').textContent='';$('importText').placeholder='';
  $('previewHelp').textContent='';$('advancedImport').open=false;
  finalResultState.version++;finalResultState.latest=null;finalResultState.rendered=null;
  invalidateFinalResultReview();
  $('finalResultDetails').open=false;$('finalResultGames').replaceChildren();
  for(const id of ['finalResultSource','finalResultCorrection'])$(id).value='';
  for(const id of ['finalResultStatus','finalResultSummary'])$(id).textContent='';
  for(const id of ['sessionError','authError','poolPickerError','inviteResult','inviteError','importError','importResult','finalResultError','finalResultSuccess'])msg(id,'');
  setAuth();
}
$('signOut').addEventListener('click',async()=>{
  try{await client.signOut()}catch(e){msg('sessionError',authErrorMessage(e?.code||e?.message));return}
  clearAccount();
});
// The browser is signed out, or signed in as someone else, since this page was opened: another tab did it. Nothing
// of the account this page was showing stays on it, and the page starts again as whoever is signed in now.
function accountChanged(){
  clearAccount();
  restartAfterSignInChange();
}
// Phase 9 onboarding: the browser only prepares a review; signed tenant-scoped
// database functions independently authorize and enforce pool/season uniqueness.
function cancelPoolCreation(){state.poolCreateDraft=null;show('createPoolReview',false);msg('createPoolError','')}
function cancelSeasonCreation(){state.seasonCreateDraft=null;show('createSeasonReview',false);msg('createSeasonError','')}
$('createPoolName').addEventListener('input',cancelPoolCreation);
$('createPoolType').addEventListener('change',cancelPoolCreation);
$('cancelCreatePool').addEventListener('click',cancelPoolCreation);
$('createSeasonYear').addEventListener('input',cancelSeasonCreation);
$('cancelCreateSeason').addEventListener('click',cancelSeasonCreation);
$('previewCreatePool').addEventListener('click',()=>{
  cancelPoolCreation();msg('createPoolResult','');
  const name=$('createPoolName').value.trim(),type=$('createPoolType').value;
  if(name.length<3||name.length>120){msg('createPoolError','Enter a pool name of 3–120 characters.');return}
  if(!['pickem','survivor'].includes(type)){msg('createPoolError','Choose Pick’em or Survivor.');return}
  const tenantId=state.context?.pool?.tenant_id;
  if(!client.live||!tenantId)return;
  state.poolCreateDraft={session:state.session,tenantId,displayName:name,poolType:type};
  $('createPoolSummary').textContent=`Create ${name} as a ${type==='pickem'?'Weekly Pick’em':'Survivor'} pool? The standard rules are ${type==='pickem'?'one point per correct pick; ties count as losses for both teams':'one team per week, no repeats; ties eliminate the selection'}. No participants or submissions are created.`;
  show('createPoolReview',true);
});
$('confirmCreatePool').addEventListener('click',async()=>{
  const draft=state.poolCreateDraft;
  if(!draft||draft.session!==state.session||draft.tenantId!==state.context?.pool?.tenant_id)return;
  cancelPoolCreation();$('confirmCreatePool').disabled=true;
  try{
    const created=await client.createPool(draft);
    if(draft.session!==state.session)return;
    state.availablePools.push(created);
    state.poolSlug=created.slug;state.season=null;state.week=null;
    await load();
    history.replaceState(null,'',`?pool=${encodeURIComponent(created.slug)}`);
    msg('createPoolResult',`${created.display_name} created. Add a season below before setting up weeks and inviting participants.`);
  }catch(e){if(draft.session===state.session)msg('createPoolError',authErrorMessage(e?.code||e?.message))}
  finally{$('confirmCreatePool').disabled=false}
});
$('previewCreateSeason').addEventListener('click',()=>{
  cancelSeasonCreation();msg('createSeasonResult','');
  const year=Number($('createSeasonYear').value),context=state.context;
  if(!Number.isInteger(year)||year<2020||year>2100){msg('createSeasonError','Enter a valid NFL season year.');return}
  if(!context?.pool?.id||!client.live)return;
  if((context.seasons||[]).some(s=>s.season===year)){msg('createSeasonError','This season already exists.');return}
  state.seasonCreateDraft={session:state.session,poolId:context.pool.id,year};
  $('createSeasonSummary').textContent=`Create season ${year} for ${context.pool.display_name}? It starts in setup, without weeks or picks.`;
  show('createSeasonReview',true);
});
$('confirmCreateSeason').addEventListener('click',async()=>{
  const draft=state.seasonCreateDraft;
  if(!draft||draft.session!==state.session||draft.poolId!==state.context?.pool.id)return;
  cancelSeasonCreation();$('confirmCreateSeason').disabled=true;
  try{
    const created=await client.createSeason({poolId:draft.poolId,season:draft.year});
    if(draft.session!==state.session)return;
    await load();
    const season=state.context?.seasons?.find(s=>s.id===created.id);
    if(season){state.season=season;$('seasonSelect').value=created.id;renderWeeks()}
    msg('createSeasonResult',`Season ${created.season} created in setup. You can now add a draft week.`);
  }catch(e){if(draft.session===state.session)msg('createSeasonError',authErrorMessage(e?.code||e?.message))}
  finally{$('confirmCreateSeason').disabled=false}
});
function currentSubmission(entry){return weekSubmission(entry,state.week)}
function invalidatePreview(){state.preview=null;show('importPreview',false);msg('importError','');msg('importResult','')}
function formatDate(value){const time=new Date(value);return Number.isFinite(time.getTime())?time.toLocaleString([],{dateStyle:'medium',timeStyle:'short'}):'Not set'}
function renderConsole(){
  const c=state.context;if(!c)return;
  const priorSeasonId=state.season?.id,priorWeekId=state.week?.id;
  $('poolName').textContent=c.pool.display_name;
  ['consoleCard','entriesCard','inviteCard','importCard'].forEach(id=>show(id,true));
  show('newEntryManagement',client.live);show('weekSetup',client.live);
  show('createPoolSetup',client.live&&!!c.pool.tenant_id);
  show('createSeasonSetup',client.live&&!!c.pool.id);
  const seasons=c.seasons||[];
  $('seasonSelect').innerHTML=seasons.map(s=>`<option value="${esc(s.id)}">${esc(s.season)}</option>`).join('');
  state.season=seasons.find(s=>s.id===priorSeasonId)||seasons.find(s=>s.status==='active')||seasons[0]||null;
  if(state.season)$('seasonSelect').value=state.season.id;
  $('seasonSelect').onchange=()=>{state.season=seasons.find(s=>s.id===$('seasonSelect').value)||seasons[0];renderWeeks()};renderWeeks(priorWeekId);
}
function renderWeeks(preferredWeekId=null){
  const weeks=state.season?.weeks||[];
  $('weekSelect').innerHTML=weeks.map(w=>`<option value="${esc(w.id)}">Week ${esc(w.week)} · ${esc(w.status)}</option>`).join('');
  state.week=weeks.find(w=>w.id===preferredWeekId)||weeks.find(w=>w.status==='open')||weeks[weeks.length-1]||null;
  if(state.week)$('weekSelect').value=state.week.id;
  $('weekSelect').onchange=()=>{state.week=weeks.find(w=>w.id===$('weekSelect').value)||state.week;renderEntries()};renderEntries();
}
function renderEntries(){
  invalidatePreview();invalidateEntryDraft();invalidateWeekDraft();invalidateScheduleDraft();renderScheduleEditor();renderVerifiedScheduleControls();const entries=state.season?.entries||[],open=weekCanAcceptPicks(state.week);
  $('weekStatus').textContent=state.week?`Week ${state.week.week} · ${open.ok?'Open for picks':open.reason} Deadline: ${formatDate(state.week.deadline_at)}.`:'No week is configured for this season.';
  $('entriesBody').innerHTML=entries.map(e=>{const sub=currentSubmission(e),status=!sub?'Not submitted':sub.source==='participant'?'Submitted by player':'Entered by commissioner';return`<tr><td><strong>${esc(e.display_name||e.entry_code)}</strong><small>${esc(e.entry_code)}</small></td><td>${e.claimed?'Accepted':'Not accepted'}</td><td>${esc(status)}</td></tr>`}).join('')||'<tr><td colspan="3">No entries yet.</td></tr>';
  $('inviteEntry').innerHTML=entries.map(e=>`<option value="${esc(e.id)}">${esc(e.display_name||e.entry_code)} · ${esc(e.entry_code)}</option>`).join('');
  const eligible=eligibleImportEntries(entries,state.week);
  $('guidedEntry').innerHTML=eligible.map(e=>`<option value="${esc(e.id)}">${esc(e.display_name||e.entry_code)} · ${esc(e.entry_code)}</option>`).join('');
  $('guidedPreview').disabled=!open.ok||!eligible.length;
  if(!eligible.length)msg('importError','No entries are available for commissioner entry this week. Player-submitted picks are protected.');
  $('importHelp').textContent=state.context?.pool.pool_type==='survivor'?'File columns: entry_code,team. Team codes and labels must match this week.':`File columns: entry_code, one column for each scheduled game, plus tiebreak if required. Use away/home or the team name for each game.`;
  $('importText').placeholder='Use “Load example for this week” to get a file format matched to the selected schedule.';
  renderGuided();
  void renderFinalResultControls();
  if(client.live&&state.context){
    void standingsBoard.show({poolId:state.context.pool.id,season:state.season?.season,
      week:state.week?.week,weekId:state.week?.id,config:state.week?.config});
    void seasonBoard.show({poolId:state.context.pool.id,season:state.season?.season});
    gameDayBoard.show({poolId:state.context.pool.id,season:state.season?.season,
      week:state.week?.week,config:state.week?.config});
  }else{standingsBoard.hide();seasonBoard.hide();gameDayBoard.hide();}
}
const finalResultState={version:0,latest:null,pending:null,rendered:null};
function invalidateFinalResultReview(){
  finalResultState.pending=null;
  show('finalResultReview',false);
  $('finalResultConfirmCheck').checked=false;
}
// What the panel shows depends on the week only through these values. A context load replaces state.week with a
// new object for the same week; comparing this key, not the object, tells whether anything changed.
const finalResultWeekKey=week=>week?JSON.stringify([week.id,week.status,week.deadline_at,week.config?.games??null]):null;
// The console is rendered again after every context load, usually for the same pool, week and session. Such a call
// changes nothing this panel shows, so it leaves the panel alone: rebuilding it would close it under the
// commissioner's hands and discard the scores they had typed and a review they had not yet confirmed.
// keepOpen: a reload that follows the commissioner's own action (a recorded revision, or a refused stale one)
// always rebuilds, and leaves the panel open so the message about that action is on screen. Any other rebuild
// starts collapsed.
async function renderFinalResultControls({keepOpen=false}={}){
  const week=state.week,poolId=state.context?.pool?.id,session=state.session;
  const key=finalResultWeekKey(week);
  const shown=finalResultState.rendered;
  if(!keepOpen&&shown&&shown.session===session&&shown.poolId===poolId&&shown.key===key
     &&!$('finalResultAdmin').classList.contains('hidden'))return;
  const token=++finalResultState.version;
  finalResultState.rendered=null;
  finalResultState.latest=null;invalidateFinalResultReview();
  show('finalResultAdmin',false);show('finalResultForm',false);
  msg('finalResultError','');msg('finalResultSuccess','');
  if(!client.live||!session||!poolId||!week?.id||!weekAcceptsFinalScores(week)||
     !Array.isArray(week.config?.games)||!week.config.games.length)return;
  show('finalResultAdmin',true);
  finalResultState.rendered={session,poolId,key};
  $('finalResultDetails').open=keepOpen;
  $('finalResultPreview').disabled=true;
  // A schedule that was never verified: there is nothing to type into, because the server refuses every score for
  // this week until each game has a verified kickoff time. The picks already made are not affected.
  const blockers=scheduleBlockers(week);
  if(blockers.length){
    $('finalResultGames').replaceChildren();
    $('finalResultStatus').textContent=`Final scores cannot be recorded for this week: ${blockers.join('; ')}. `
      +'Its schedule must be verified first. Picks already made are kept exactly as they are.';
    return;
  }
  $('finalResultStatus').textContent='Checking your pool’s previous final-score records…';
  $('finalResultGames').innerHTML=week.config.games.map((game,i)=>`
    <div class="final-score-row" role="group" aria-label="${esc(readableGame(game,i))}" data-final-game-row="${esc(game.id)}">
      <div class="final-score-matchup">${esc(readableGame(game,i))}</div>
      <label class="field"><span>Away · ${esc(game.away?.key||'away')}</span><input data-final-id="${esc(game.id)}"
        data-final-side="away_score" type="number" min="0" max="200" step="1"
        inputmode="numeric" autocomplete="off"></label>
      <label class="field"><span>Home · ${esc(game.home?.key||'home')}</span><input data-final-id="${esc(game.id)}"
        data-final-side="home_score" type="number" min="0" max="200" step="1"
        inputmode="numeric" autocomplete="off"></label>
    </div>`).join('');
  $('finalResultSource').value='';
  $('finalResultCorrection').value='';
  try{
    const latest=await client.weekResultSnapshot(week.id);
    if(token!==finalResultState.version||key!==finalResultWeekKey(state.week)||
       poolId!==state.context?.pool?.id||session!==state.session)return;
    if(latest?.week_id!==week.id||
       !['unpublished','commissioner_attested_not_official'].includes(latest.status))
      throw Error('Result revision state is unavailable.');
    finalResultState.latest=latest;
    const revision=latest.revision||0;
    show('finalResultCorrectionWrap',revision>0);
    if(revision>0){
      for(const game of week.config.games)for(const side of ['away_score','home_score']){
        const el=[...$('finalResultGames').querySelectorAll('input[data-final-id]')].find(
          x=>x.dataset.finalId===game.id&&x.dataset.finalSide===side);
        if(el&&Number.isInteger(latest.results?.[game.id]?.[side]))
          el.value=String(latest.results[game.id][side]);
      }
    }
    $('finalResultStatus').textContent=revision?
      `Existing commissioner attestation · revision ${revision}. Recording changes creates another auditable revision, not an official NFL certification.`:
      'No previous result attestation. Enter every final score only after independent verification.';
    show('finalResultForm',true);$('finalResultPreview').disabled=false;
  }catch(e){
    if(token!==finalResultState.version||key!==finalResultWeekKey(state.week)||session!==state.session)return;
    // Nothing usable is on screen, so the next render of the same week tries again.
    finalResultState.rendered=null;
    msg('finalResultError',finalResultErrorMessage(e?.code||e?.message,authErrorMessage));
    $('finalResultStatus').textContent='Final-score recording is unavailable for this week.';
  }
}
// The stored record changed, by this commissioner or by another: both standings views are replayed from it.
// Neither stores anything. Resolves when both have finished, whatever their outcome.
const replayStandings=()=>Promise.allSettled([standingsBoard.reload(),seasonBoard.refresh()]);
// The message for the commissioner's own last action, shown after any reload and brought on screen.
// `after`: the standings cards sit above this panel and grow when they are replayed. A browser that does not hold
// the visible content in place while the page grows above it would carry the message off screen, so once the
// replay has finished the same message, if it is still the one shown, is brought on screen again.
function announceFinalResult(id,text,after=null){
  msg(id,text);
  $(id).scrollIntoView?.({block:'nearest'});
  const session=state.session,weekId=state.week?.id;
  void after?.then(()=>{
    if(session===state.session&&weekId===state.week?.id&&$(id).textContent===text&&!$(id).classList.contains('hidden'))
      $(id).scrollIntoView?.({block:'nearest'});
  });
}
$('finalResultGames').addEventListener('input',invalidateFinalResultReview);
$('finalResultSource').addEventListener('input',invalidateFinalResultReview);
$('finalResultCorrection').addEventListener('input',invalidateFinalResultReview);
$('finalResultCancel').addEventListener('click',invalidateFinalResultReview);
$('finalResultPreview').addEventListener('click',()=>{
  invalidateFinalResultReview();msg('finalResultError','');msg('finalResultSuccess','');
  const current=finalResultState.latest,week=state.week;
  if(!current||!week||!state.session)return;
  const values={};
  for(const field of $('finalResultGames').querySelectorAll('input[data-final-id]')){
    const k=field.dataset.finalId,side=field.dataset.finalSide;
    if(!values[k])values[k]={};
    values[k][side]=field.value;
  }
  const review=reviewFinalScores({week,values,
    sourceReference:$('finalResultSource').value,
    currentRevision:current.revision||0,
    currentResults:current.results||null,
    correctionReason:$('finalResultCorrection').value
  });
  if(!review.ok){msg('finalResultError',review.reason);return}
  finalResultState.pending={...review,session:state.session,weekId:week.id,
    poolId:state.context?.pool.id,token:finalResultState.version};
  $('finalResultSummary').textContent=`${review.summary.map(x=>
    `${x.matchup}: ${x.away_score}–${x.home_score}`).join(' · ')}. ${review.expected_revision?
      'Record correction revision '+(review.expected_revision+1):
      'Record the initial commissioner attestation'}? This does not certify an official league result. Keep the independent source evidence.`;
  show('finalResultReview',true);
});
$('finalResultConfirm').addEventListener('click',async()=>{
  const pending=finalResultState.pending;
  if(!pending||pending.session!==state.session||
     pending.weekId!==state.week?.id||pending.poolId!==state.context?.pool?.id||
     pending.token!==finalResultState.version)return;
  if(!$('finalResultConfirmCheck').checked){
    msg('finalResultError','Confirm that you independently checked every game before recording.');return;
  }
  finalResultState.pending=null;show('finalResultReview',false);
  $('finalResultConfirm').disabled=true;msg('finalResultError','');
  const current=()=>pending.session===state.session&&pending.weekId===state.week?.id&&
    pending.poolId===state.context?.pool?.id;
  try{
    const digest=await manualAttestationFingerprint(pending);
    if(!current()||pending.token!==finalResultState.version)return;
    const written=await client.attestWeekFinalResults({weekId:pending.weekId,
      expectedRevision:pending.expected_revision,results:pending.results,
      sourceSha256:digest,sourceReference:pending.source_reference,
      correctionReason:pending.correction_reason});
    if(!current())return;
    await renderFinalResultControls({keepOpen:true});
    const replayed=replayStandings();
    if(current())
      announceFinalResult('finalResultSuccess',`Commissioner attestation revision ${written.revision} recorded. Picks were not changed. Source reference retained in the private audit record; retain the original evidence as well.`,replayed);
  }catch(e){
    if(!current())return;
    const refusal=String(e?.code||e?.message||'');
    // Someone else recorded this week first. Retrying the same request can never succeed, so load what is
    // stored now; the commissioner then reviews it and, if still needed, records a correction on top.
    let replayed=null;
    if(refusal.includes(STALE_RESULT_REVISION)){
      await renderFinalResultControls({keepOpen:true});
      if(!current())return;
      replayed=replayStandings();
    }
    announceFinalResult('finalResultError',finalResultErrorMessage(refusal,authErrorMessage),replayed);
  }finally{$('finalResultConfirm').disabled=false}
});

function renderGuided(){
  invalidatePreview();const c=state.context,w=state.week;if(!c||!w)return;
  if(c.pool.pool_type==='survivor'){
    const teams=survivorTeams(w.config);
    $('guidedGames').innerHTML=`<label class="field"><span>Choose one team for Week ${esc(w.week)}</span><select id="guidedTeam"><option value="">Choose a team…</option>${teams.map(t=>`<option value="${esc(t.key)}">${esc(t.label||t.key)}${t.label!==t.key?` (${esc(t.key)})`:''}</option>`).join('')}</select></label>`;
    show('guidedTiebreakWrap',false);
  }else{
    $('guidedGames').innerHTML=(w.config?.games||[]).map((g,i)=>`<label class="field"><span>Game ${i+1}: ${esc(readableGame(g,i))}</span><select data-game="${esc(g.id||`g${i+1}`)}" class="guidedChoice"><option value="">Choose winner…</option><option value="away">${esc(g.away?.label||g.away?.key||g.away||'Away')}</option><option value="home">${esc(g.home?.label||g.home?.key||g.home||'Home')}</option></select></label>`).join('');
    show('guidedTiebreakWrap',w.config?.tiebreakRequired===true||w.config?.tiebreak_required===true);
  }
}
$('guidedEntry').addEventListener('change',invalidatePreview);
$('guidedGames').addEventListener('change',invalidatePreview);
$('guidedTiebreak').addEventListener('input',invalidatePreview);
$('importText').addEventListener('input',invalidatePreview);
$('advancedImport').addEventListener('toggle',invalidatePreview);
function invalidateEntryDraft(){state.entryDraft=null;show('newEntryReview',false);msg('newEntryError','')}
$('newEntryCode').addEventListener('input',invalidateEntryDraft);
$('newEntryName').addEventListener('input',invalidateEntryDraft);
$('cancelNewEntry').addEventListener('click',invalidateEntryDraft);
$('previewNewEntry').addEventListener('click',()=>{
  invalidateEntryDraft();msg('newEntryResult','');
  const draft=newEntryDraft({entryCode:$('newEntryCode').value,displayName:$('newEntryName').value,season:state.season,entries:state.season?.entries||[]});
  if(!draft.ok){msg('newEntryError',draft.error);return}
  state.entryDraft={...draft,session:state.session};
  $('newEntryReviewText').textContent=`Create entry “${draft.name}” with code ${draft.code} for season ${state.season.season}? This does not submit picks or send an invitation.`;
  show('newEntryReview',true);
});
$('confirmNewEntry').addEventListener('click',async()=>{
  const draft=state.entryDraft;
  if(!draft||draft.session!==state.session||draft.seasonId!==state.season?.id)return;
  state.entryDraft=null;show('newEntryReview',false);
  $('confirmNewEntry').disabled=true;msg('newEntryError','');
  try{
    if(!client.live)throw new Error('Entry creation is available only with the connected pool service.');
    const created=await client.createEntry({seasonId:draft.seasonId,entryCode:draft.code,displayName:draft.name});
    if(draft.session!==state.session)return;
    await load();
    msg('newEntryResult',`Entry ${created.entry_code} created for ${created.display_name}. You can now send an invitation below.`);
  }catch(e){if(draft.session===state.session)msg('newEntryError',authErrorMessage(e?.code||e?.message))}
  finally{$('confirmNewEntry').disabled=false}
});
function invalidateWeekDraft(){state.weekDraft=null;show('newWeekReview',false);msg('newWeekError','')}
for(const id of ['newWeekNumber','newWeekDeadline','newWeekOpening'])$(id).addEventListener('input',invalidateWeekDraft);
$('cancelNewWeek').addEventListener('click',invalidateWeekDraft);
$('previewNewWeek').addEventListener('click',()=>{
  invalidateWeekDraft();msg('newWeekResult','');
  const draft=newDraftWeek({season:state.season,weekNumber:$('newWeekNumber').value,deadlineLocal:$('newWeekDeadline').value,opensLocal:$('newWeekOpening').value,weeks:state.season?.weeks||[]});
  if(!draft.ok){msg('newWeekError',draft.error);return}
  state.weekDraft={...draft,session:state.session};
  $('newWeekReviewText').textContent=`Create Week ${draft.week} as a draft for season ${state.season.season}? The deadline will be ${formatDate(draft.deadlineAt)}. This does not open picks or publish games.`;
  show('newWeekReview',true);
});
$('confirmNewWeek').addEventListener('click',async()=>{
  const draft=state.weekDraft;
  if(!draft||draft.session!==state.session||draft.seasonId!==state.season?.id)return;
  state.weekDraft=null;show('newWeekReview',false);$('confirmNewWeek').disabled=true;msg('newWeekError','');
  try{
    if(!client.live)throw new Error('Week creation is available only with the connected pool service.');
    const created=await client.createDraftWeek({seasonId:draft.seasonId,week:draft.week,deadlineAt:draft.deadlineAt,opensAt:draft.opensAt});
    if(draft.session!==state.session)return;
    state.week={id:created.id};
    await load();
    msg('newWeekResult',`Week ${created.week} was created as a draft. You must configure an accurate schedule before anyone can pick.`);
  }catch(e){if(draft.session===state.session)msg('newWeekError',authErrorMessage(e?.code||e?.message))}
  finally{$('confirmNewWeek').disabled=false}
});
// Draft-only NFL schedule editor. Its review state is invalidated on every change and
// the server re-checks verified Auth membership, week status and submissions atomically.
function invalidateScheduleDraft(){state.scheduleDraft=null;show('scheduleReview',false);msg('scheduleError','')}
function teamOptions(selected=''){
  return '<option value="">Select team…</option>'+NFL_TEAMS.map(t=>`<option value="${esc(t.key)}"${selected===t.key?' selected':''}>${esc(t.city)} ${esc(t.name)}</option>`).join('');
}
function addScheduleRow(data={}){
  const row=document.createElement('div');row.className='toolbar-grid schedule-row';
  const idx=$('scheduleGames').children.length+1;
  row.innerHTML=`<label class="field"><span>Game ${idx}: visiting team</span><select class="scheduleAway">${teamOptions(data.away)}</select></label>
    <label class="field"><span>Home team</span><select class="scheduleHome">${teamOptions(data.home)}</select></label>
    <label class="field"><span>Kickoff (local time)</span><input type="datetime-local" class="scheduleKickoff"></label>
    <button type="button" class="button secondary scheduleRemove">Remove game</button>`;
  row.querySelector('.scheduleKickoff').value=data.kickoffLocal||'';
  row.querySelector('.scheduleRemove').addEventListener('click',()=>{row.remove();invalidateScheduleDraft()});
  row.addEventListener('change',invalidateScheduleDraft);
  $('scheduleGames').append(row);invalidateScheduleDraft();
}
function renderScheduleEditor(){
  const draft=client.live&&state.week?.status==='draft'
    &&state.week?.config?.scheduleVerification!=='verified';
  show('scheduleSetup',draft);$('scheduleGames').replaceChildren();
  if(!draft)return;
  const games=state.week?.config?.games||[];
  for(const game of games){
    const kickoff=new Date(game.kickoff);
    const local=Number.isFinite(kickoff.getTime())?`${kickoff.getFullYear()}-${String(kickoff.getMonth()+1).padStart(2,'0')}-${String(kickoff.getDate()).padStart(2,'0')}T${String(kickoff.getHours()).padStart(2,'0')}:${String(kickoff.getMinutes()).padStart(2,'0')}`:'';
    addScheduleRow({away:game.away?.key,home:game.home?.key,kickoffLocal:local});
  }
  if(!games.length)addScheduleRow();
  $('scheduleTiebreak').checked=Boolean(state.week?.config?.tiebreakRequired);
  msg('scheduleResult','');invalidateScheduleDraft();
}
// Phase 9: preview is read from a privileged, source-validated catalog, never a
// client-provided games array. All writes independently recheck Auth and DB state.
function invalidateVerifiedPreview(){
  state.verifiedPreview=null;state.openReview=null;
  show('verifiedScheduleReview',false);show('verifiedOpenReview',false);
}
function renderVerifiedScheduleControls(){
  invalidateVerifiedPreview();
  const week=state.week,isDraft=client.live&&week?.status==='draft';
  show('verifiedScheduleSetup',isDraft);
  if(!isDraft)return;
  const verified=week?.config?.scheduleVerification==='verified';
  $('previewOpenVerifiedWeek').disabled=!verified;
  msg('verifiedScheduleError','');
  msg('verifiedScheduleStatus',verified
    ?'A source-validated schedule is on this draft. Review the deadline, then open picks.'
    :'This week is a draft. Load its source-validated NFL schedule before opening.');
}
$('cancelVerifiedSchedule').addEventListener('click',invalidateVerifiedPreview);
$('cancelOpenVerifiedWeek').addEventListener('click',()=>{state.openReview=null;show('verifiedOpenReview',false)});
$('loadVerifiedSchedule').addEventListener('click',async()=>{
  invalidateVerifiedPreview();msg('verifiedScheduleError','');msg('verifiedScheduleResult','');
  const session=state.session,week=state.week,season=state.season;
  if(!session||!week||week.status!=='draft')return;
  $('loadVerifiedSchedule').disabled=true;
  try{
    const data=await client.previewVerifiedSchedule({weekId:week.id});
    if(session!==state.session||week.id!==state.week?.id||season.id!==state.season?.id)return;
    if(!data.available){
      msg('verifiedScheduleStatus',data.status==='source_stale'
        ?'NFL schedule data is outdated. The trusted sync must refresh it before import.'
        :'A validated schedule has not been loaded for this week. Picks remain closed.');
      return;
    }
    if(!Array.isArray(data.games)||!data.games.length||!/^[0-9a-f]{64}$/.test(data.source_sha256||''))throw new Error('invalid_verified_schedule');
    show('verifiedTiebreakWrap',state.context?.pool?.pool_type==='pickem');
    $('verifiedTiebreak').checked=Boolean(week.config?.tiebreakRequired);
    state.verifiedPreview={session,weekId:week.id,digest:data.source_sha256};
    $('verifiedScheduleSummary').textContent=
      `Season ${data.season}, Week ${data.week} · ${data.games.length} games · ${data.bye_teams.length} teams on bye. Source: ${data.source}. Checked: ${formatDate(data.verified_at)}. Attribution: ${data.attribution}. Your submission deadline: ${formatDate(week.deadline_at)}.`;
    $('verifiedScheduleGames').replaceChildren();
    for(const [i,game] of data.games.entries()){
      const p=document.createElement('p');
      p.textContent=`${i+1}. ${game.away.city} ${game.away.name} at ${game.home.city} ${game.home.name} · ${formatDate(game.kickoff)}`;
      $('verifiedScheduleGames').append(p);
    }
    show('verifiedScheduleReview',true);
    msg('verifiedScheduleStatus','Review the games. Importing will not open picks.');
  }catch(e){if(session===state.session)msg('verifiedScheduleError',authErrorMessage(e?.code||e?.message))}
  finally{$('loadVerifiedSchedule').disabled=false}
});
$('confirmVerifiedSchedule').addEventListener('click',async()=>{
  const pending=state.verifiedPreview;
  if(!pending||pending.session!==state.session||pending.weekId!==state.week?.id||state.week.status!=='draft')return;
  invalidateVerifiedPreview();$('confirmVerifiedSchedule').disabled=true;
  msg('verifiedScheduleError','');
  try{
    const result=await client.applyVerifiedSchedule({weekId:pending.weekId,digest:pending.digest,
      tiebreakRequired:state.context?.pool.pool_type==='pickem'&&$('verifiedTiebreak').checked});
    if(pending.session!==state.session)return;
    await load();
    msg('verifiedScheduleResult',`${result.game_count} NFL games imported into this draft with provenance recorded. Picks are still closed until you confirm opening.`);
  }catch(e){if(pending.session===state.session)msg('verifiedScheduleError',authErrorMessage(e?.code||e?.message))}
  finally{$('confirmVerifiedSchedule').disabled=false}
});
$('previewOpenVerifiedWeek').addEventListener('click',async()=>{
  state.openReview=null;show('verifiedOpenReview',false);
  msg('verifiedScheduleError','');msg('verifiedScheduleResult','');
  const session=state.session,week=state.week;
  if(!session||week?.status!=='draft'||week.config?.scheduleVerification!=='verified')return;
  $('previewOpenVerifiedWeek').disabled=true;
  try{
    const data=await client.previewVerifiedSchedule({weekId:week.id});
    if(session!==state.session||week.id!==state.week?.id)return;
    if(!data.available||data.source_sha256!==week.config.scheduleDigest)
      throw new Error('schedule_changed_reload');
    state.openReview={session,weekId:week.id,digest:data.source_sha256};
    $('verifiedOpenSummary').textContent=`Open Week ${week.week} using ${data.games.length} reviewed games? ${data.bye_teams.length} teams have a bye. Picks become available ${week.opens_at?formatDate(week.opens_at):'immediately'} and stop at ${formatDate(week.deadline_at)} (your local time). Opening is audited; later schedule changes require a separate authorized correction.`;
    show('verifiedOpenReview',true);
  }catch(e){if(session===state.session)msg('verifiedScheduleError',authErrorMessage(e?.code||e?.message))}
  finally{$('previewOpenVerifiedWeek').disabled=false}
});
$('confirmOpenVerifiedWeek').addEventListener('click',async()=>{
  const pending=state.openReview;
  if(!pending||pending.session!==state.session||pending.weekId!==state.week?.id||state.week.status!=='draft')return;
  invalidateVerifiedPreview();$('confirmOpenVerifiedWeek').disabled=true;
  msg('verifiedScheduleError','');
  try{
    await client.openVerifiedWeek({weekId:pending.weekId,digest:pending.digest});
    if(pending.session!==state.session)return;
    await load();msg('verifiedScheduleResult',`Week ${state.week.week} is open. Participant access remains controlled by the server opening time and deadline.`);
  }catch(e){if(pending.session===state.session)msg('verifiedScheduleError',authErrorMessage(e?.code||e?.message))}
  finally{$('confirmOpenVerifiedWeek').disabled=false}
});
$('addScheduleGame').addEventListener('click',()=>{
  if($('scheduleGames').children.length>=18){msg('scheduleError','A week can contain no more than 18 games.');return}
  addScheduleRow();
});
$('clearScheduleGames').addEventListener('click',()=>{$('scheduleGames').replaceChildren();addScheduleRow()});
$('scheduleTiebreak').addEventListener('change',invalidateScheduleDraft);
$('cancelSchedule').addEventListener('click',invalidateScheduleDraft);
$('previewSchedule').addEventListener('click',()=>{
  invalidateScheduleDraft();msg('scheduleResult','');
  const rows=[...$('scheduleGames').children].map(row=>({away:row.querySelector('.scheduleAway').value,home:row.querySelector('.scheduleHome').value,kickoffLocal:row.querySelector('.scheduleKickoff').value}));
  const result=prepareManualSchedule({week:state.week,rows,tiebreakRequired:state.context?.pool?.pool_type==='pickem'&&$('scheduleTiebreak').checked});
  if(!result.ok){msg('scheduleError',result.error);return}
  state.scheduleDraft={weekId:state.week.id,session:state.session,config:result.config};
  $('scheduleReviewText').textContent=`Week ${state.week.week}: ${result.config.games.length} game(s). Confirm teams, dates and kickoffs against an official schedule.`;
  $('scheduleReviewGames').textContent=result.config.games.map(g=>`${g.away.city} ${g.away.name} at ${g.home.city} ${g.home.name} — ${formatDate(g.kickoff)}`).join(' | ');
  show('scheduleReview',true);
});
$('confirmSchedule').addEventListener('click',async()=>{
  const draft=state.scheduleDraft;
  if(!draft||draft.weekId!==state.week?.id||draft.session!==state.session||state.week.status!=='draft')return;
  state.scheduleDraft=null;show('scheduleReview',false);$('confirmSchedule').disabled=true;msg('scheduleError','');
  try{
    const result=await client.saveDraftSchedule({weekId:draft.weekId,config:draft.config});
    if(draft.session!==state.session)return;
    await load();
    msg('scheduleResult',`${result.game_count} games saved to draft. NFL schedule verification and opening are still required.`);
  }catch(e){if(draft.session===state.session)msg('scheduleError',authErrorMessage(e?.code||e?.message))}
  finally{$('confirmSchedule').disabled=false}
});
$('createInvite').addEventListener('click',async()=>{
  msg('inviteResult','');msg('inviteError','');show('inviteLinkWrap',false);
  const session=state.session,email=$('inviteEmail').value.trim();
  if(!validEmail(email)){msg('inviteError','Enter the participant’s email address to restrict who can accept this invitation.');return}
  const entryId=$('inviteEntry').value;if(!entryId){msg('inviteError','Choose a participant entry first.');return}
  try{
    const result=client.live?await client.createInvite({entryId,email,expiresHours:168}):{entry_id:entryId,expires_at:new Date(Date.now()+604800000).toISOString()};
    if(state.session!==session)return;
    $('inviteLink').value=participantInviteUrl(new URL('./participant.html',location.href),state.context.pool.slug,result.entry_id);
    show('inviteLinkWrap',true);
    msg('inviteResult',`Invitation ready for ${email}. Send the token-free link below directly to them. They must sign in with this verified email. Expires ${formatDate(result.expires_at)}.`);
  }catch(e){if(state.session===session)msg('inviteError',authErrorMessage(e?.code||e?.message))}
});
$('sampleImport').addEventListener('click',()=>{
  const text=sampleImport({poolType:state.context.pool.pool_type,entries:state.season?.entries,weekConfig:state.week?.config,week:state.week});
  if(!text){msg('importError','No unprotected entry or valid scheduled team is available for an example.');return}
  $('importText').value=text;invalidatePreview();
});
$('csvFile').addEventListener('change',async()=>{
  const file=$('csvFile').files?.[0],session=state.session;if(!file)return;
  if(file.size>128*1024){msg('importError','This CSV is larger than 128 KB. Split it into smaller files.');return}
  try{
    const text=await file.text();
    if(session!==state.session||file!==$('csvFile').files?.[0])return;
    $('importText').value=text;invalidatePreview();
  }catch{
    if(session===state.session&&file===$('csvFile').files?.[0])msg('importError','The selected file could not be read. Try a UTF-8 CSV file.');
  }
});
function describePick(item){
  const entry=state.season.entries.find(e=>e.id===item.entry_id),payload=item.payload;
  if(state.context.pool.pool_type==='survivor'){
    const team=survivorTeams(state.week.config).find(t=>t.key===payload.team);
    return`${entry?.display_name||entry?.entry_code||'Entry'}: ${team?.label||payload.team}`;
  }
  const picks=(state.week.config?.games||[]).map((g,i)=>{
    const id=g.id||`g${i+1}`,side=payload.picks[id];return `${readableGame(g,i)} → ${g[side]?.label||side}`;
  });
  return `${entry?.display_name||entry?.entry_code||'Entry'}: ${picks.join('; ')}${payload.tiebreak!==undefined?`; tiebreak ${payload.tiebreak}`:''}`;
}
function preview(text){
  invalidatePreview();
  if(!text.trim()){msg('importError','Enter a pick before previewing.');return}
  let result;
  try{result=previewCommissionerImport({text,poolType:state.context.pool.pool_type,entries:state.season.entries,weekConfig:state.week.config,week:state.week})}
  catch(e){msg('importError',authErrorMessage(e?.code||e?.message));return}
  const rows=[...result.errors.map(error=>({
    entry:error.row?`Row ${error.row}${error.entry_code?` · ${error.entry_code}`:''}`:error.entry_code||'CSV',
    result:error.row?describeImportError(error):importErrorText(error)
  })),
    ...result.items.map(item=>({entry:state.season.entries.find(e=>e.id===item.entry_id)?.display_name||'Entry',result:describePick(item)}))];
  $('resultBody').innerHTML=rows.map(r=>`<tr><td>${esc(r.entry)}</td><td>${esc(r.result)}</td></tr>`).join('');
  show('importPreview',true);
  if(result.errors.length){msg('importError',`${result.errors.length} problem(s) found. No picks were saved. Correct them and preview again.`);$('confirmImport').disabled=true;state.preview=null}
  else if(!result.items.length){msg('importError','There are no valid picks to save.');$('confirmImport').disabled=true}
  else{
    state.preview={items:result.items,weekId:state.week.id,session:state.session};
    $('confirmImport').disabled=false;
    $('previewHelp').textContent=`${result.items.length} ${result.items.length===1?'entry':'entries'} ready to save. ${result.warnings.join(' ')} This can replace a previous commissioner import, but never a player-submitted pick. Survivor teams previously used in other weeks will still be rejected by the database. Confirm only when the choices above are correct.`;
  }
  $('importPreview').scrollIntoView?.({block:'nearest'});
}
$('guidedPreview').addEventListener('click',()=>{
  const entry=state.season?.entries?.find(e=>e.id===$('guidedEntry').value);
  if(!entry){msg('importError','Select an entry that has not already been submitted by a player.');return}
  const c=state.context,w=state.week,choices={};
  document.querySelectorAll('.guidedChoice').forEach(el=>{choices[el.dataset.game]=el.value});
  const text=guidedCsv({poolType:c.pool.pool_type,entryCode:entry.entry_code,team:$('guidedTeam')?.value||'',choices,tiebreak:$('guidedTiebreak').value,weekConfig:w.config});
  preview(text);
});
$('runImport').addEventListener('click',()=>preview($('importText').value));
$('cancelImport').addEventListener('click',invalidatePreview);
$('confirmImport').addEventListener('click',async()=>{
  const pending=state.preview;if(!pending||pending.weekId!==state.week?.id||pending.session!==state.session)return;
  // Disable immediately to prevent duplicate-click submissions. The server is authoritative and will
  // independently reject a stale/deadline/source-conflicted request without replacing player picks.
  state.preview=null;$('confirmImport').disabled=true;msg('importError','');
  try{
    const results=client.live?await client.submitBatch({weekId:pending.weekId,source:SUBMISSION_SOURCES.COMMISSIONER_IMPORT,items:pending.items}):pending.items.map(item=>{
      const entry=state.season.entries.find(e=>e.id===item.entry_id),sub=currentSubmission(entry);
      if(sub&&sub.source!=='commissioner_import')return{entry_id:entry.id,ok:false,code:`source_conflict:${sub.source}`};
      entry.submissions=(entry.submissions||[]).filter(x=>x.week!==state.week.week);
      entry.submissions.push({week:state.week.week,source:'commissioner_import',status:'submitted',revision:(sub?.revision||0)+1});
      return{entry_id:entry.id,ok:true,result:{code:sub?'updated':'created'}};
    });
    if(state.session!==pending.session)return;
    const summary=summarizeBatchResults(results);
    const confirmation=`${summary.submitted} ${summary.submitted===1?'pick':'picks'} saved. ${summary.conflicts?`${summary.conflicts} player or other-source submission(s) protected. `:''}${summary.errors?`${summary.errors} other error(s).`:''}`;
    $('resultBody').innerHTML=results.map(r=>{
      const entry=state.season.entries.find(e=>e.id===r.entry_id),outcome=r.ok?'Saved':authErrorMessage(r.code);
      return `<tr><td>${esc(entry?.display_name||entry?.entry_code||'Entry')}</td><td>${esc(outcome)}</td></tr>`;
    }).join('');
    if(client.live)await load();else renderEntries();
    if(state.session!==pending.session)return;
    msg('importResult',confirmation);
    show('importPreview',true);$('confirmImport').disabled=true;$('previewHelp').textContent='Results are shown below. No further submission will occur unless you start a new preview.';
  }catch(e){if(state.session===pending.session)msg('importError',authErrorMessage(e?.code||e?.message))}
});
async function initialize(){
  await client.init();$('modePill').textContent=client.live?'Connected':'Local preview';
  $('platformFooter').textContent=client.live?'Secure pool management · connected to your configured pool service':'Local sample preview · no database connection';
  if(!client.live){setAuth();await load();return}
  state.session=await client.getSession();setAuth();
  watchSignIn(client);
  if(state.session)await openSession(signInChanged?SIGN_IN_CHANGED:'');
  else if(signInChanged)msg('authError',SIGNED_OUT_ELSEWHERE);
}
initialize().catch(e=>msg('sessionError',authErrorMessage(e?.code||e?.message)));
