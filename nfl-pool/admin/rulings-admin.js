'use strict';
// HDC-13 Admin: the commissioner incident-ruling page. DOM, network and auth only; every decision is made by the pure
// incident-rulings.js and, finally, by the database function public.nfl_append_incident_ruling (migration 004), which
// re-checks the commissioner, the published data and the chain under the per-contest lock.
//
// Reads go through the existing Neon client as the signed-in commissioner (public columns only); scores through the same
// path the public pages use (score-feed-proxy.js -> nflscores2). The page loads on Load / refresh only: it never polls.
// Before every write the feed, the published week, the policy and the chain are read again, and anything material that
// changed since the preview cancels the submit. A submit is sent at most once per confirmed preview.
//
// HDC-14: a published game the week feed no longer lists is offered through the separate absent-game function
// (public.nfl_append_absent_incident_ruling, migration 005) as the absent-game actions, confirmed by typing the week, the
// matchup and the absence. A Survivor matchup is proved by the same-week locked Pick'em slate, read with the week.
import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';
import {PUBLIC_COLUMNS,RPC_FUNCTION,ACTIONS,scoreboardUrl,evidenceSourceFor,readFeed,contestOptions,pickemWeeks,survivorWeeks,
  pickemCandidates,survivorCandidates,buildRequest,writeProbeRequest,pickemPreview,survivorPreview,pickemState,survivorState,
  previewOutcome,sameOutcome,confirmationPhrase,confirmationMatches,preflightKey,rpcErrorInfo,classifyReadBack,probeOutcome,
  ABSENT_RPC_FUNCTION,ABSENCE_LABEL,buildAbsentRequest,absentWriteProbeRequest,absentActionPhrase,classifyAbsentReadBack,absentProbeOutcome} from './incident-rulings.js?v=2';

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ADMIN_EMAIL='djsmokke@gmail.com',neon=createClient({auth:{url:NEON_AUTH_URL},dataApi:{url:NEON_DATA_URL}});
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const ACTION_LABEL={rule:'Rule (first ruling)',reaffirm:'Reaffirm',withdraw:'Withdraw',rerule:'Re-rule'};
const ABSENT_ACTION_LABEL={rule:'Rule absent game (first ruling)',reaffirm:'Reaffirm absent-game ruling',withdraw:'Withdraw absent-game ruling',rerule:'Re-rule absent game'};
// The action select's values: the HDC-13 actions as they are, the absent-game actions prefixed "absent-".
const ABSENT_PREFIX='absent-';
const isAbsentValue=v=>typeof v==='string'&&v.startsWith(ABSENT_PREFIX);
const actionOf=v=>isAbsentValue(v)?v.slice(ABSENT_PREFIX.length):v;
const absentOffered=c=>ACTIONS.filter(a=>c?.absence?.actions?.[a]?.ok);
const anyOffered=c=>ACTIONS.some(a=>c.actions[a].ok)||absentOffered(c).length>0;
const CONSEQUENCE_LABEL={void:'VOID: removed from scoring',advance_team_used:'ADVANCE: pickers advance, team stays used',eliminate:'ELIMINATE: pickers are out',withdrawn:'WITHDRAWN'};
const TYPE_LABEL={pickem:"Pick'em",survivor:'Survivor'};

let session=null,authBusy=false,busy=false,submitting=false,probing=false,generation=0;
let contests=[],weeks=null,loaded=null,candidates=[],preview=null;

function msg(text,type='info'){$('message').className=`notice ${type}`;$('message').textContent=text;$('message').hidden=!text}
function showBusy(text){$('busy').hidden=!text;$('busyText').textContent=text||''}
const selectedContest=()=>contests.find(c=>c.contestId===$('contestSelect').value)||null;
const selectedWeek=()=>{const w=Number($('weekSelect').value);return Number.isInteger(w)&&w>=1&&w<=22&&weeks?.options.includes(w)?w:null};
const currentCandidate=()=>candidates.find(c=>c.key===$('matchupSelect').value)||null;
const canSubmit=()=>!!session&&!busy&&!submitting&&!probing&&!!preview&&!preview.done&&confirmationMatches($('confirmMatchup').value,preview.phrase);

function syncControls(){
  const signed=!!session,locked=busy||submitting||probing,c=currentCandidate();
  $('sendCode').disabled=authBusy||locked;$('verifyCode').disabled=authBusy||locked;$('signOut').disabled=authBusy||submitting||probing;
  $('contestSelect').disabled=!signed||locked;$('weekSelect').disabled=!signed||locked||!weeks;
  $('loadBtn').disabled=!signed||locked||!selectedContest()||!selectedWeek();
  $('probeBtn').disabled=!signed||locked||!loaded;$('probeAbsentBtn').disabled=!signed||locked||!loaded;
  $('matchupSelect').disabled=!signed||locked||!loaded;
  for(const id of ['actionSelect','consequenceSelect','publicNote','adminNote'])$(id).disabled=!signed||locked||!c;
  $('previewBtn').disabled=!signed||locked||!c||!anyOffered(c);
  $('confirmMatchup').disabled=!preview||locked;
  $('submitBtn').disabled=!canSubmit();
}
function renderAuth(){
  const signed=!!session;
  $('signedOut').hidden=signed;$('signedIn').hidden=!signed;$('signedEmail').textContent=signed?session.user.email:'';
  $('authState').textContent=signed?'AUTHORIZED':'SIGN IN REQUIRED';$('authState').className=`pill ${signed?'ok':'warn'}`;
  syncControls();
}

// ---- auth (the same Neon Auth email-code pattern as the other Admin pages; the database still decides) ----------------
async function refreshSession(){
  const r=await neon.auth.getSession(),u=r?.data?.user,s=r?.data?.session;
  session=s&&u?{session:s,user:u}:null;
  if(session&&u.email?.toLowerCase()!==ADMIN_EMAIL){await neon.auth.signOut();session=null}
  renderAuth();
  if(session&&!contests.length)await loadContests();
}
async function authAction(fn){if(authBusy)return;authBusy=true;syncControls();try{await fn()}finally{authBusy=false;syncControls()}}
$('sendCode').addEventListener('click',()=>authAction(async()=>{msg('');try{const {error}=await neon.auth.emailOtp.sendVerificationOtp({email:ADMIN_EMAIL,type:'sign-in'});if(error)throw error;$('otpWrap').hidden=false;$('otp').focus();msg(`Sign-in code sent to ${ADMIN_EMAIL}.`,'success')}catch(e){msg(`Could not send sign-in code: ${e?.message||e}`,'error')}}));
$('verifyCode').addEventListener('click',()=>authAction(async()=>{const code=String($('otp').value||'').trim();if(!/^\d{4,10}$/.test(code)){msg('Enter the numeric code from your email.','error');return}msg('');try{const {error}=await neon.auth.signIn.emailOtp({email:ADMIN_EMAIL,otp:code});if(error)throw error;$('otp').value='';$('otpWrap').hidden=true;await refreshSession();if(!session)throw new Error('Authentication completed but no authorized session was created.');msg('Signed in securely.','success')}catch(e){msg(`Sign-in failed: ${e?.message||e}`,'error')}}));
$('signOut').addEventListener('click',()=>{if(submitting||probing)return;void authAction(async()=>{await neon.auth.signOut();session=null;contests=[];weeks=null;clearLoaded();$('contestSelect').innerHTML='';$('weekSelect').innerHTML='';renderAuth();msg('Signed out.','info')})});

// ---- reads (public columns only) -----------------------------------------------------------------------------------------
async function read(table,columns,build){
  const {data,error}=await build(neon.from(table).select(columns.join(',')));
  if(error)throw new Error(`Could not read ${table}: ${error.message||error.code||'request failed'}`);
  if(!Array.isArray(data))throw new Error(`Could not read ${table}.`);
  return data;
}
const WEEK_COLUMNS=['season','week','status','revision','config'];
async function loadContests(){
  try{contests=contestOptions(await read('nfl_contests',PUBLIC_COLUMNS.contests,q=>q))}
  catch(e){contests=[];msg(e.message||String(e),'error')}
  $('contestSelect').innerHTML=`<option value="">Choose a contest</option>${contests.map(c=>`<option value="${esc(c.contestId)}">${esc(c.displayName)} · ${TYPE_LABEL[c.contestType]}</option>`).join('')}`;
  $('contestSelect').value='';syncControls();
}
async function publishedFor(contest,week){
  if(contest.contestType==='pickem'){
    const list=pickemWeeks(await read('nfl_pool_weeks',WEEK_COLUMNS,q=>q.eq('season',contest.season).eq('status','locked')),{season:contest.season});
    return{options:list.map(w=>w.week),pickem:Number.isInteger(week)?list.find(w=>w.week===week)||null:null};
  }
  const sw=survivorWeeks(await read('nfl_survivor_weeks',WEEK_COLUMNS,q=>q.eq('season',contest.season).eq('status','locked')),{season:contest.season});
  return{options:sw.weeks,snapshot:sw.snapshot};
}
async function fetchFeed(season,week){
  let r;
  try{r=await fetch(scoreboardUrl(season,week),{cache:'no-store',headers:{Accept:'application/json'}})}
  catch(e){return{ok:false,reason:`the Week ${week} score feed could not be reached (${e?.message||e})`,source:null,fetchedAt:null}}
  const source=evidenceSourceFor(r.url);
  if(!r.ok)return{ok:false,reason:`the Week ${week} score feed returned ${r.status}`,source,fetchedAt:null};
  let json;try{json=await r.json()}catch{return{ok:false,reason:`the Week ${week} score feed returned unreadable data`,source,fetchedAt:null}}
  return{...readFeed(json,{season,week}),source,fetchedAt:typeof json?.fetchedAt==='string'?json.fetchedAt:null};
}
// Everything a decision rests on, read fresh: the published week, the contest's public rows and the score feed (Pick'em:
// the week; Survivor: every week the snapshot covers, which the preview needs).
async function loadState(contest,week){
  const published=await publishedFor(contest,week),id=contest.contestId;
  if(contest.contestType==='pickem'&&!published.pickem)throw new Error(`Week ${week} is not a locked, published Pick'em week.`);
  if(contest.contestType==='survivor'&&!(published.snapshot&&published.snapshot.week>=week))throw new Error(`No locked Survivor snapshot covers Week ${week}.`);
  const last=contest.contestType==='pickem'?week:published.snapshot.week;
  const feedWeeks=contest.contestType==='pickem'?[week]:Array.from({length:last},(_,i)=>i+1);
  const [contestRows,policies,rulings,slates,...feeds]=await Promise.all([
    read('nfl_contests',PUBLIC_COLUMNS.contests,q=>q.eq('contest_id',id)),
    read('nfl_contest_policies',PUBLIC_COLUMNS.policies,q=>q.eq('contest_id',id).order('revision',{ascending:true})),
    read('nfl_incident_rulings',PUBLIC_COLUMNS.rulings,q=>contest.contestType==='pickem'?q.eq('contest_id',id).eq('week',week).order('chain_seq',{ascending:true})
      :q.eq('contest_id',id).lte('week',last).order('week',{ascending:true}).order('chain_seq',{ascending:true})),
    // HDC-14: the same-week locked Pick'em slate, the only proof of a Survivor matchup the feed no longer lists.
    contest.contestType==='survivor'?read('nfl_pool_weeks',WEEK_COLUMNS,q=>q.eq('season',contest.season).eq('week',week).eq('status','locked')):Promise.resolve([]),
    ...feedWeeks.map(w=>fetchFeed(contest.season,w))
  ]);
  const byWeek={};feedWeeks.forEach((w,i)=>{byWeek[w]=feeds[i]});
  return{contest,week,published:{...published,slate:slates.length===1?slates[0]:null},data:{contests:contestRows,policies,rulings},feeds:byWeek};
}
function candidatesFor(s){
  const feed=s.feeds[s.week],events=feed?.ok?feed.events:null,source=feed?.source??null;
  const common={contestId:s.contest.contestId,season:s.contest.season,week:s.week,events,source,data:s.data};
  return s.contest.contestType==='pickem'?pickemCandidates({...common,config:s.published.pickem.config}):survivorCandidates({...common,snapshot:s.published.snapshot,slate:s.published.slate});
}
const eventsByWeek=s=>Array.from({length:s.published.snapshot.week},(_,i)=>s.feeds[i+1]?.ok?s.feeds[i+1].events:null);

// ---- rendering ----------------------------------------------------------------------------------------------------------
function invalidatePreview(){
  preview=null;$('preview').hidden=true;
  for(const id of ['previewSummary','previewBefore','previewAfter'])$(id).innerHTML='';
  $('confirmPhrase').textContent='';$('confirmMatchup').value='';$('result').textContent='';
}
function clearLoaded(){
  generation++;loaded=null;candidates=[];invalidatePreview();
  $('matchupSelect').innerHTML='';$('matchupSelect').value='';$('candidateInfo').innerHTML='';$('feedState').textContent='';$('probeResult').textContent='';
  $('actionSelect').innerHTML='';$('actionSelect').value='';$('consequenceSelect').innerHTML='';$('consequenceSelect').value='';
}
const chainLabel=c=>c.chain.state==='empty'?'no ruling':c.chain.state==='withdrawn'?'withdrawn':`active ${String(c.chain.consequence).toUpperCase()}${c.underReview?' · UNDER REVIEW':''}`;
function renderLoaded(keep=''){
  const feed=loaded.feeds[loaded.week];
  $('feedState').textContent=`Score feed Week ${loaded.week}: ${feed?.source||'unknown source'} · ${feed?.ok?`${feed.events.length} listings`:feed?.reason||'unavailable'}${feed?.fetchedAt?` · fetched ${feed.fetchedAt}`:''}`;
  $('matchupSelect').innerHTML=`<option value="">Choose a game</option>${candidates.map(c=>`<option value="${esc(c.key)}">${esc(c.matchup)} · ${esc(chainLabel(c))}${c.absence?.label?` · ${esc(ABSENCE_LABEL)}`:''}${anyOffered(c)?'':' · no action'}</option>`).join('')}`;
  $('matchupSelect').value=candidates.some(c=>c.key===keep)?keep:'';
  renderCandidate();
}
function renderConsequences(){
  const c=currentCandidate(),a=actionOf($('actionSelect').value),list=c&&(a==='rule'||a==='rerule')?c.consequences:[];
  $('consequenceSelect').innerHTML=list.map(x=>`<option value="${esc(x)}">${esc(CONSEQUENCE_LABEL[x]||x)}</option>`).join('');
  $('consequenceSelect').value=list[0]||'';
}
function renderCandidate(){
  const c=currentCandidate();
  if(!c){$('actionSelect').innerHTML='';$('actionSelect').value='';renderConsequences();$('candidateInfo').innerHTML='';syncControls();return}
  const offered=[...ACTIONS.filter(a=>c.actions[a].ok).map(a=>[a,ACTION_LABEL[a]]),...absentOffered(c).map(a=>[`${ABSENT_PREFIX}${a}`,ABSENT_ACTION_LABEL[a]])];
  $('actionSelect').innerHTML=offered.map(([v,label])=>`<option value="${v}">${esc(label)}</option>`).join('');
  $('actionSelect').value=offered[0]?.[0]||'';renderConsequences();
  const o=c.observation,ev=c.evidence||c.absence?.evidence||null;
  const reading=o?`${o.kind}${o.status?` (${o.status})`:''}${o.eventId?` · event ${o.eventId}`:''}`:'unavailable';
  const lines=[`<b>${esc(c.matchup)}</b> · Week ${c.week} · policy ${c.policy?`revision ${c.policy.revision} (${esc(c.policy.policy)})`:'not ready'}`,
    `Chain: ${esc(chainLabel(c))}${c.chain.last?` · last ruling ${esc(c.chain.last.ruling_id)}`:''}`,
    `Feed reading: ${esc(reading)}${c.publishedEventId?` · published event ${esc(c.publishedEventId)}`:''}`,
    c.absence?.label?`<b>${esc(c.absence.label)}</b> · the commissioner attests the absence; it is not a feed-reported status${c.absence.slateRevision!=null?` · proved by the Week ${c.week} Pick'em slate (revision ${esc(c.absence.slateRevision)})`:''}`:'',
    ev?`Incident evidence: ${esc(ev.incidentStatus)} · event ${esc(ev.eventId??'none')} · ${esc(ev.evidenceSource??'unknown source')}`:''].filter(Boolean);
  const refused=[...ACTIONS.filter(a=>!c.actions[a].ok&&c.actions[a].reason).map(a=>`<li class="no">${esc(ACTION_LABEL[a])}: ${esc(c.actions[a].reason)}</li>`),
    ...(c.absence?.label?ACTIONS.filter(a=>!c.absence.actions[a].ok&&c.absence.actions[a].reason).map(a=>`<li class="no">${esc(ABSENT_ACTION_LABEL[a])}: ${esc(c.absence.actions[a].reason)}</li>`)
      :c.absence?.reason&&c.observation?.kind==='missing'?[`<li class="no">Absent-game path: ${esc(c.absence.reason)}</li>`]:[])].join('');
  $('candidateInfo').innerHTML=`${lines.map(l=>`<div>${l}</div>`).join('')}${offered.length?'':'<div class="no">No action is available for this game.</div>'}${refused?`<ul>${refused}</ul>`:''}`;
  syncControls();
}
function renderPickemSide(title,side,p){
  const game=!side.game?(side.graded?'graded from the NFL feed by the public page':'not a published game'):side.game.void?`VOID · commissioner ruling${side.game.underReview?' · UNDER REVIEW':''}`
    :side.game.hold?`HOLD · ${side.game.hold}`:side.game.completed?(side.game.winner?`FINAL · ${side.game.winner}`:'FINAL TIE'):'not graded (awaiting a ruling)';
  const rows=side.entries.map(e=>`<tr><td>${esc(e.name)}</td><td>${esc(e.pick)}</td><td>${esc(e.cell.toUpperCase())}</td><td>${e.w===null?'—':`${e.w}–${e.l} · ${e.left} left`}</td></tr>`).join('');
  const incident=(side.rules.incidents||[]).filter(x=>x.matchup===p.matchup).map(x=>`${esc(x.status)}: ${esc(x.detail)}`).join(' ')||'no ruling listed';
  return`<h3>${esc(title)}</h3><p>Game: <b>${esc(game)}</b>${side.remaining===null?'':` · ${side.remaining?'remaining':'not remaining'}`}${side.tiebreakVoid?' · tiebreak game void: no tiebreak this week':''}</p>`
    +`${rows?`<table><thead><tr><th>Entry</th><th>Pick</th><th>Game</th><th>This game</th></tr></thead><tbody>${rows}</tbody></table>`:'<p>No entry picked this game.</p>'}<p>Rules card: ${incident}</p>`;
}
function renderSurvivorSide(title,side,p,affected){
  const rows=affected.map(e=>`<tr><td>${esc(e.name)}</td><td>${esc(e.pick)}</td><td>${esc(e.label)}${e.underReview?' · UNDER REVIEW':''}</td><td>${e.nextWeekEligible?'eligible next week':'not eligible next week'} · used: ${esc(e.used.join(', ')||'none')}</td></tr>`).join('');
  const s=side.summary,incident=(side.rules.incidents||[]).filter(x=>x.matchup===p.matchup).map(x=>`${esc(x.status)}: ${esc(x.detail)}`).join(' ')||'no ruling listed';
  return`<h3>${esc(title)}</h3>${rows?`<table><thead><tr><th>Entry</th><th>Pick</th><th>Status</th><th>Next week</th></tr></thead><tbody>${rows}</tbody></table>`:'<p>No entry picked this game.</p>'}`
    +`<p>Summary: ${s.active} still in · ${s.pending} pending · ${s.eliminatedThisWeek} out this week · ${side.awaiting} awaiting a ruling · ${side.held} on hold</p><p>Rules card: ${incident}</p>`;
}
function renderPreview(){
  const {request:r,candidate:c,result:p}=preview,contest=loaded.contest,absent=preview.path==='absence';
  const ev=absent?c.absence?.evidence||{}:r.p_action==='rule'?{incidentStatus:r.p_incident_status,eventId:r.p_event_id,evidenceSource:r.p_evidence_source}:c.evidence||{};
  const consequence=r.p_action==='withdraw'?'withdrawn':r.p_action==='reaffirm'?c.chain.consequence:r.p_consequence;
  const facts=[['Contest',`${contest.displayName} (${TYPE_LABEL[contest.contestType]})`],['Week',`Week ${loaded.week}`],['Matchup',c.matchup],
    ...(absent?[['Incident',`${ABSENCE_LABEL} · attested by the commissioner; the score feed reported nothing for it, and no other week's game is linked`]]:[]),
    ['Event ID',ev.eventId??'none'],['Incident status',ev.incidentStatus??'—'],['Evidence source',ev.evidenceSource??'—'],['Policy',`Policy revision ${r.p_expected_policy_revision} · ${c.policy.policy}`],
    ['Action',`${r.p_action} · ${(absent?ABSENT_ACTION_LABEL:ACTION_LABEL)[r.p_action]}`],['Consequence',`${consequence} · ${CONSEQUENCE_LABEL[consequence]||consequence}`],['Affected entries',String(p.affected)],
    ['Public note',r.p_public_note],['Private note',r.p_admin_note??'none']];
  $('previewSummary').innerHTML=`<dl class="preview-facts">${facts.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  const affected=side=>p.entries.map(e=>side==='before'?e.before:e.after);
  $('previewBefore').innerHTML=p.contestType==='pickem'?renderPickemSide('Before',p.before,c):renderSurvivorSide('Before',p.before,c,affected('before'));
  $('previewAfter').innerHTML=p.contestType==='pickem'?renderPickemSide('After',p.after,c):renderSurvivorSide('After',p.after,c,affected('after'));
  $('confirmPhrase').textContent=preview.phrase;$('confirmMatchup').value='';$('preview').hidden=false;
}

// ---- selection ----------------------------------------------------------------------------------------------------------
async function task(text,fn){
  if(busy||submitting||probing||!session)return;
  busy=true;showBusy(text);syncControls();
  try{await fn()}catch(e){msg(e?.message||String(e),'error')}finally{busy=false;showBusy('');syncControls()}
}
$('contestSelect').addEventListener('change',()=>task('Reading the published weeks…',async()=>{
  clearLoaded();weeks=null;$('weekSelect').innerHTML='';$('weekSelect').value='';msg('');
  const contest=selectedContest();if(!contest)return;
  const g=generation,published=await publishedFor(contest,null);
  if(g!==generation||selectedContest()!==contest)return;
  weeks={contestId:contest.contestId,options:published.options};
  $('weekSelect').innerHTML=`<option value="">Choose a week</option>${published.options.map(w=>`<option value="${w}">Week ${w}</option>`).join('')}`;
  $('weekSelect').value='';
  if(!published.options.length)msg(`No published ${TYPE_LABEL[contest.contestType]} week was found for ${contest.season}.`,'error');
}));
$('weekSelect').addEventListener('change',()=>{clearLoaded();msg('');syncControls()});
$('loadBtn').addEventListener('click',()=>task('Loading the contest week and the score feed…',async()=>{
  const contest=selectedContest(),week=selectedWeek(),keep=$('matchupSelect').value;if(!contest||!week)return;
  clearLoaded();msg('');
  const g=generation,state=await loadState(contest,week);
  if(g!==generation)return;
  loaded=state;candidates=candidatesFor(state);renderLoaded(keep);
}));
$('matchupSelect').addEventListener('change',()=>{invalidatePreview();renderCandidate()});
$('actionSelect').addEventListener('change',()=>{invalidatePreview();renderConsequences();syncControls()});
$('consequenceSelect').addEventListener('change',()=>{invalidatePreview();syncControls()});
for(const id of ['publicNote','adminNote'])$(id).addEventListener('input',()=>{invalidatePreview();syncControls()});
$('confirmMatchup').addEventListener('input',syncControls);

// ---- preview ------------------------------------------------------------------------------------------------------------
const nextId=rows=>rows.reduce((m,r)=>Number.isSafeInteger(r?.ruling_id)&&r.ruling_id>m?r.ruling_id:m,0)+1;
function buildPreview(state,c,request,path=null){
  const common={contestId:state.contest.contestId,season:state.contest.season,week:state.week,data:state.data,request,candidate:c,path,
    rulingId:nextId(state.data.rulings),createdAt:new Date().toISOString()};
  if(state.contest.contestType==='pickem'){const f=state.feeds[state.week];return pickemPreview({...common,config:state.published.pickem.config,events:f?.ok?f.events:null})}
  const missing=Object.entries(state.feeds).filter(([,f])=>!f.ok).map(([w])=>w);
  if(missing.length)throw new Error(`The Survivor preview needs every week through Week ${state.published.snapshot.week}; the score feed for Week ${missing.join(', ')} could not be read. Load again.`);
  return survivorPreview({...common,snapshot:state.published.snapshot,eventsByWeek:eventsByWeek(state)});
}
$('previewBtn').addEventListener('click',()=>task('Building the preview…',async()=>{
  invalidatePreview();msg('');
  const c=currentCandidate();if(!c||!loaded){msg('Load the contest week and choose a game first.','error');return}
  const value=$('actionSelect').value,absent=isAbsentValue(value),action=actionOf(value);
  const built=(absent?buildAbsentRequest:buildRequest)({contestId:loaded.contest.contestId,week:loaded.week,candidate:c,action,
    consequence:$('consequenceSelect').value||null,publicNote:$('publicNote').value,adminNote:$('adminNote').value});
  if(!built.ok){msg(`Cannot build the preview: ${built.reason}.`,'error');return}
  const path=absent?'absence':null,result=buildPreview(loaded,c,built.request,path);
  preview={request:built.request,candidate:c,key:preflightKey(c),phrase:absent?absentActionPhrase(c,action):confirmationPhrase(c),result,outcome:previewOutcome(result.after),
    done:false,path,eventId:absent?c.absence?.evidence?.eventId??null:null};
  renderPreview();
  msg(`Review the preview, then type ${preview.phrase} to confirm.`,'info');
}));

// ---- submit -------------------------------------------------------------------------------------------------------------
const stateAfter=(state,data,c,absent=false)=>state.contest.contestType==='pickem'
  ?pickemState({contestId:state.contest.contestId,season:state.contest.season,week:state.week,config:state.published.pickem.config,
    events:state.feeds[state.week]?.ok?state.feeds[state.week].events:null,data,candidate:c,absent})
  :survivorState({contestId:state.contest.contestId,season:state.contest.season,week:state.week,snapshot:state.published.snapshot,eventsByWeek:eventsByWeek(state),data,candidate:c});
// Read the chain back after a write: the reloaded rows, with the feed and published week the preview used, must render
// exactly the preview's AFTER. A difference is reported; nothing is ever retried automatically.
async function readBack(p,state){
  const contest=state.contest,id=contest.contestId,last=contest.contestType==='pickem'?state.week:state.published.snapshot.week;
  const [contestRows,policies,rulings]=await Promise.all([
    read('nfl_contests',PUBLIC_COLUMNS.contests,q=>q.eq('contest_id',id)),
    read('nfl_contest_policies',PUBLIC_COLUMNS.policies,q=>q.eq('contest_id',id).order('revision',{ascending:true})),
    read('nfl_incident_rulings',PUBLIC_COLUMNS.rulings,q=>contest.contestType==='pickem'?q.eq('contest_id',id).eq('week',state.week).order('chain_seq',{ascending:true})
      :q.eq('contest_id',id).lte('week',last).order('week',{ascending:true}).order('chain_seq',{ascending:true}))]);
  return{contests:contestRows,policies,rulings};
}
function settle(state,data,keep){loaded={...state,data};candidates=candidatesFor(loaded);renderLoaded(keep)}
function recorded(p,state,data,note){
  const same=sameOutcome(previewOutcome(stateAfter(state,data,p.candidate,p.path==='absence')),p.outcome);
  p.done=true;settle(state,data,p.candidate.key);
  msg(`Ruling recorded: ${p.request.p_action} for ${p.candidate.matchup}, Week ${state.week}.${note}`,'success');
  $('result').textContent=same?'Read-back: the recorded chain matches the preview.'
    :'Read-back WARNING: the recorded result does not match the preview. Nothing was retried. Load / refresh and review the chain before doing anything else.';
}
$('submitBtn').addEventListener('click',()=>submit());
async function submit(){
  if(submitting||busy||probing)return;
  const p=preview;
  if(!p||p.done)return;
  if(!confirmationMatches($('confirmMatchup').value,p.phrase)){msg(`Type the matchup exactly as shown (${p.phrase}) to confirm.`,'error');return}
  if(!session||session.user?.email?.toLowerCase()!==ADMIN_EMAIL){msg('Sign in before recording a ruling.','error');return}
  submitting=true;showBusy('Re-reading the score feed, the published week, the policy and the chain…');syncControls();
  try{
    let fresh,c;
    try{fresh=await loadState(loaded.contest,loaded.week);c=candidatesFor(fresh).find(x=>x.key===p.candidate.key)||null}
    catch(e){invalidatePreview();msg(`Nothing was sent: the pre-submit check could not read the current state (${e?.message||e}). Load / refresh and build a new preview.`,'error');return}
    const stillOffered=p.path==='absence'?c?.absence?.actions?.[p.request.p_action]?.ok:c?.actions[p.request.p_action]?.ok;
    if(!c||preflightKey(c)!==p.key||!stillOffered){
      settle(fresh,fresh.data,p.candidate.key);invalidatePreview();
      msg('The score feed, the published week, the policy or the ruling chain changed since the preview was built. Nothing was sent. Build a new preview and confirm again.','error');return;
    }
    showBusy('Recording the ruling…');
    let response;
    try{response=p.path==='absence'?await neon.rpc(ABSENT_RPC_FUNCTION,p.request):await neon.rpc(RPC_FUNCTION,p.request)}catch(e){response={data:null,error:e}}
    if(response&&!response.error&&response.data){
      let data;
      try{data=await readBack(p,fresh)}catch(e){p.done=true;invalidatePreview();msg(`Ruling recorded, but the chain could not be read back (${e?.message||e}). Load / refresh to check it.`,'success');return}
      recorded(p,fresh,data,'');return;
    }
    const info=rpcErrorInfo(response?.error);
    if(info.definitive){invalidatePreview();msg(info.text,'error');return}
    // A lost response: read the chain back and classify. Nothing is retried automatically.
    let data;
    try{data=await readBack(p,fresh)}
    catch(e){invalidatePreview();msg(`Outcome unknown: ${info.text} The chain could not be read back (${e?.message||e}). Load / refresh and check the chain before acting again.`,'error');return}
    const verdict=p.path==='absence'?classifyAbsentReadBack({beforeRows:fresh.data.rulings,afterRows:data.rulings,request:p.request,chain:c.chain,eventId:p.eventId})
      :classifyReadBack({beforeRows:fresh.data.rulings,afterRows:data.rulings,request:p.request,chain:c.chain});
    if(verdict==='LANDED'){recorded(p,fresh,data,' LANDED: the response was lost, and the read-back shows this exact row was written.');return}
    if(verdict==='NOT_WRITTEN'){settle(fresh,data,p.candidate.key);invalidatePreview();msg('NOT WRITTEN: the response was lost and the read-back shows the chain unchanged. Build a new preview to try again.','error');return}
    settle(fresh,data,p.candidate.key);invalidatePreview();
    msg('CHANGED: the response was lost and the chain now differs from both the preview and its previous state. The preview is no longer valid; review the chain before acting.','error');
  }finally{submitting=false;showBusy('');syncControls()}
}

// ---- the write-access check (writes nothing) ------------------------------------------------------------------------------
$('probeBtn').addEventListener('click',()=>probe());
async function probe(){
  if(probing||busy||submitting||!session||!loaded)return;
  const c=currentCandidate()||candidates.find(x=>x.policy)||null;
  if(!c?.policy){$('probeResult').textContent='Load a contest week whose policy is ready before checking write access.';return}
  probing=true;showBusy('Checking write access…');syncControls();
  try{
    const id=loaded.contest.contestId,count=async()=>(await read('nfl_incident_rulings',PUBLIC_COLUMNS.rulings,q=>q.eq('contest_id',id))).length;
    const before=await count();
    let response;
    try{response=await neon.rpc(RPC_FUNCTION,writeProbeRequest({contestId:id,week:loaded.week,away:c.away,home:c.home,policyRevision:c.policy.revision}))}
    catch(e){response={data:null,error:e}}
    const outcome=probeOutcome(response||{}),after=await count();
    $('probeResult').textContent=`${outcome.text} ${after===before?"0 rows written (the contest's ruling count is unchanged).":`WARNING: the contest's ruling count changed from ${before} to ${after}. Load / refresh and review the chain.`}`;
  }catch(e){$('probeResult').textContent=`The write-access check could not finish: ${e?.message||e}`}
  finally{probing=false;showBusy('');syncControls()}
}

// HDC-14: the absent-game function's write-access check (writes nothing).
$('probeAbsentBtn').addEventListener('click',()=>probeAbsent());
async function probeAbsent(){
  if(probing||busy||submitting||!session||!loaded)return;
  const c=currentCandidate()||candidates.find(x=>x.policy)||null;
  if(!c?.policy){$('probeResult').textContent='Load a contest week whose policy is ready before checking absent-game write access.';return}
  probing=true;showBusy('Checking absent-game write access…');syncControls();
  try{
    const id=loaded.contest.contestId,count=async()=>(await read('nfl_incident_rulings',PUBLIC_COLUMNS.rulings,q=>q.eq('contest_id',id))).length;
    const before=await count();
    let response;
    try{response=await neon.rpc(ABSENT_RPC_FUNCTION,absentWriteProbeRequest({contestId:id,week:loaded.week,away:c.away,home:c.home,policyRevision:c.policy.revision}))}
    catch(e){response={data:null,error:e}}
    const outcome=absentProbeOutcome(response||{}),after=await count();
    $('probeResult').textContent=`${outcome.text} ${after===before?"0 rows written (the contest's ruling count is unchanged).":`WARNING: the contest's ruling count changed from ${before} to ${after}. Load / refresh and review the chain.`}`;
  }catch(e){$('probeResult').textContent=`The absent-game write-access check could not finish: ${e?.message||e}`}
  finally{probing=false;showBusy('');syncControls()}
}

renderAuth();
refreshSession().catch(e=>{session=null;renderAuth();msg(`Could not check the sign-in session: ${e?.message||e}`,'error')});
