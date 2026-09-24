'use strict';
import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';
import {groupSurvivorPdfTextItems,parseSurvivorPages,validateSurvivorConfig} from './survivor-parser.js?v=2';
import {verifySurvivorSchedule,survivorPublishGuard} from './survivor-publish-checks.js?v=1';

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ESPN_SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ADMIN_EMAIL='djsmokke@gmail.com',neon=createClient({auth:{url:NEON_AUTH_URL},dataApi:{url:NEON_DATA_URL}});
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
let session=null,currentFile=null,candidate=null,busy=false,authBusy=false,publishInFlight=false,lastAttempt=null;
let fileGeneration=0,parseGeneration=0,dbGeneration=0,candidateFile=null,candidateFileGeneration=-1,candidateSeason=null;
const now=new Date(),DEFAULT_SEASON=now.getUTCMonth()<2?now.getUTCFullYear()-1:now.getUTCFullYear();

function msg(text,type='info'){$('message').className=`notice ${type}`;$('message').textContent=text;$('message').hidden=!text}
function selectedSeason(){const n=Number($('season').value);if(!Number.isInteger(n)||n<2020||n>2100)throw new Error('Season must be between 2020 and 2100');return n}
function seasonValue(){return Number($('season').value)}
function fileContextCurrent(file,generation){return !!file&&currentFile===file&&fileGeneration===generation}
function staleError(){const e=new Error('The selected file or season changed while validation was running.');e.name='StaleSurvivorContext';return e}
function assertParseContext(file,generation,operation,season){if(!fileContextCurrent(file,generation)||operation!==parseGeneration||seasonValue()!==season)throw staleError()}
function candidateCurrent(){return !!candidate&&candidateFile===currentFile&&candidateFileGeneration===fileGeneration&&candidateSeason===seasonValue()}
function dbCheckCurrent(c){return !!c?.db&&!!session&&session.user?.id===c.db.userId}
function canPublish(){return !!session&&!busy&&!authBusy&&!publishInFlight&&candidateCurrent()&&candidate.verified===true&&candidate.published!==true&&dbCheckCurrent(candidate)&&!candidate.guard.blocking.length&&(!candidate.guard.requiresConfirmation||$('confirmPartial').checked)}
function syncPublish(){$('publishBtn').disabled=!canPublish()}
function syncControls(){const locked=busy||publishInFlight;$('parseBtn').disabled=locked||!currentFile;$('file').disabled=locked;$('season').disabled=locked;$('replaceLocked').disabled=locked;$('confirmPartial').disabled=locked;$('sendCode').disabled=locked||authBusy;$('verifyCode').disabled=locked||authBusy;$('signOut').disabled=publishInFlight||authBusy;syncPublish()}
function setBusy(on,text='Working…'){busy=on;$('busy').hidden=!on;$('busyText').textContent=text;syncControls()}
function invalidateCandidate(){candidate=null;candidateFile=null;candidateFileGeneration=-1;candidateSeason=null;dbGeneration++;$('review').hidden=true;$('publishResult').hidden=true;$('replaceLocked').checked=false;$('confirmPartial').checked=false;$('confirmWrap').hidden=true;$('publishBtn').disabled=true}
function renderAuth(){const signed=!!session;$('signedOut').hidden=signed;$('signedIn').hidden=!signed;$('signedEmail').textContent=signed?session.user.email:'';$('authState').textContent=signed?'AUTHORIZED':'SIGN IN REQUIRED';$('authState').className=`pill ${signed?'ok':'warn'}`;syncControls()}
async function refreshSession(){
  const r=await neon.auth.getSession(),u=r?.data?.user,s=r?.data?.session;session=s&&u?{session:s,user:u}:null;
  if(session&&u.email?.toLowerCase()!==ADMIN_EMAIL){await neon.auth.signOut();session=null}
  renderAuth();
  if(candidate&&!dbCheckCurrent(candidate)){candidate.db=null;refreshGuard(candidate);if(session)void checkPublished(candidate)}
}
async function authAction(fn){if(authBusy)return;authBusy=true;syncControls();try{await fn()}finally{authBusy=false;syncControls()}}
$('sendCode').onclick=()=>authAction(async()=>{msg('');try{const {error}=await neon.auth.emailOtp.sendVerificationOtp({email:ADMIN_EMAIL,type:'sign-in'});if(error)throw error;$('otpWrap').hidden=false;$('otp').focus();msg(`Sign-in code sent to ${ADMIN_EMAIL}.`,'success')}catch(e){msg(`Could not send sign-in code: ${e.message||e}`,'error')}});
$('verifyCode').onclick=()=>authAction(async()=>{const code=$('otp').value.trim();if(!/^\d{4,10}$/.test(code)){msg('Enter the numeric code from your email.','error');return}msg('');try{const {error}=await neon.auth.signIn.emailOtp({email:ADMIN_EMAIL,otp:code});if(error)throw error;$('otp').value='';$('otpWrap').hidden=true;await refreshSession();if(!session)throw new Error('Authentication completed but no authorized session was created.');msg('Signed in securely.','success')}catch(e){msg(`Sign-in failed: ${e.message||e}`,'error')}});
$('signOut').onclick=()=>{if(publishInFlight)return;void authAction(async()=>{await neon.auth.signOut();session=null;renderAuth();if(candidate){candidate.db=null;refreshGuard(candidate)}})};

function setFile(file){
  if(publishInFlight){msg('Publishing is in progress. Wait for it to finish before changing files.','info');return}
  fileGeneration++;parseGeneration++;currentFile=file||null;invalidateCandidate();setBusy(false);
  $('fileName').textContent=file?`${file.name} · ${(file.size/1024).toFixed(0)} KB`:'No file selected';
}
$('file').addEventListener('change',e=>setFile(e.target.files?.[0]||null));['dragenter','dragover'].forEach(type=>$('drop').addEventListener(type,e=>{e.preventDefault();$('drop').classList.add('over')}));['dragleave','drop'].forEach(type=>$('drop').addEventListener(type,e=>{e.preventDefault();$('drop').classList.remove('over')}));$('drop').addEventListener('drop',e=>setFile(e.dataTransfer?.files?.[0]||null));
$('season').addEventListener('change',()=>{if(publishInFlight)return;parseGeneration++;const had=!!candidate;invalidateCandidate();setBusy(false);if(had)msg('Season changed. Read & validate the Survivor sheet again.','info')});
$('confirmPartial').addEventListener('change',syncPublish);

async function pdfPages(file){const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';const data=new Uint8Array(await file.arrayBuffer()),pdf=await pdfjs.getDocument({data}).promise,pages=[];for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),content=await page.getTextContent(),rows=groupSurvivorPdfTextItems(content.items);pages.push({pageNumber:n,rows})}return pages}
async function sha256(file){const bytes=await file.arrayBuffer();if(!bytes.byteLength)throw new Error('The selected file is empty.');const digest=await crypto.subtle.digest('SHA-256',bytes);return[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')}

// Weeks 1..W of the NFL regular season, through the shared score-feed proxy. Any failure blocks publication.
async function fetchSchedules(season,week){
  const out={};
  await Promise.all(Array.from({length:week},(_,i)=>i+1).map(async w=>{
    let r;
    try{r=await fetch(`${ESPN_SCOREBOARD}?dates=${season}&seasontype=2&week=${w}&limit=100&_=${Date.now()}`,{cache:'no-store',headers:{Accept:'application/json'}})}
    catch(e){throw new Error(`NFL Week ${w} schedule could not be loaded (${e.message||e}). Schedule verification is required before publishing; try Read & validate again.`)}
    if(!r.ok)throw new Error(`NFL schedule feed returned ${r.status} for Week ${w}. Schedule verification is required before publishing; try Read & validate again.`);
    try{out[w]=await r.json()}catch{throw new Error(`NFL schedule feed returned unreadable data for Week ${w}. Schedule verification is required before publishing.`)}
  }));
  return out;
}
async function readPublished(season,{withConfig=true}={}){
  const {data,error}=await neon.from('nfl_survivor_weeks').select(`season,week,status,revision,source_sha256,updated_at${withConfig?',config':''}`).eq('season',season);
  if(error)throw new Error(`Could not read published Survivor weeks for ${season}: ${error.message||error}`);
  if(!Array.isArray(data))throw new Error(`Could not read published Survivor weeks for ${season}.`);
  return data;
}
const publishedKey=rows=>rows.map(r=>`${r.week}:${r.status}:${r.revision}`).sort().join('|');
const sameInstant=(a,b)=>Number.isFinite(Date.parse(a))&&Date.parse(a)===Date.parse(b);
const attemptLanded=(row,attempt)=>!!row&&row.revision===attempt.revision&&row.source_sha256===attempt.digest&&sameInstant(row.updated_at,attempt.ts);

function refreshGuard(c){
  c.guard=survivorPublishGuard(c.config,{resultsByWeek:c.verification.resultsByWeek,currentGames:c.verification.weeks.find(w=>w.week===c.config.week)?.games||null,published:c.db?{checked:true,rows:c.db.rows}:{checked:false},detachedRows:c.review.detachedRows,contextUnexposed:c.verification.contextUnexposed});
  if(c===candidate)renderCandidate();
}
async function checkPublished(target){
  const op=++dbGeneration,userId=session?.user?.id;if(!userId||!target)return;
  try{
    const rows=await readPublished(target.config.season);
    if(op!==dbGeneration||candidate!==target||session?.user?.id!==userId)return;
    target.db={userId,rows,key:publishedKey(rows)};refreshGuard(target);
    msg(target.guard.requiresConfirmation?'Compared with published Survivor weeks. Review the publication checks and confirm before publishing.':'Compared with published Survivor weeks. Review before publishing.','success');
  }catch(e){if(op===dbGeneration&&candidate===target){target.db=null;refreshGuard(target);msg(e.message||String(e),'error')}}
}

function list(items){return items.length?`<ul>${items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}
function renderCandidate(){
  const c=candidate.config,g=candidate.guard,r=candidate.review,geo=r.geometry||{};$('review').hidden=false;
  $('reviewTitle').textContent=`${c.season} · Week ${c.week} · ${c.competitionSize} entries · ${c.currentWeekEntryCount} with Week ${c.week} pick`;
  const stateChip=g.blocking.length?'<span class="bad">✕ Publishing blocked — see below</span>':g.requiresConfirmation?'<span class="field-warn">⚠ Confirmation required before publishing</span>':'<span class="check">✓ Consistent with published Survivor state</span>';
  $('validation').innerHTML=`<span class="check">✓ Three tracked Survivor entries found</span><span class="check">✓ Anonymous field privacy enforced</span><span class="check">✓ Week columns and participant table validated</span><span class="check">✓ ${Number(c.competitionSize)} total entries</span><span class="check">✓ NFL schedule verified for Weeks 1–${Number(c.week)}</span>${stateChip}`;
  $('entryReview').innerHTML=c.trackedEntries.map(p=>`<tr><td><b>${esc(p.displayName)}</b></td><td class="nums">${p.picks.map((x,i)=>`W${i+1} ${esc(x||'—')}`).join(' · ')}</td><td>${esc(p.picks[c.week-1]||'NO PICK')}</td></tr>`).join('');
  const blank=r.blankEntrants.map(x=>`${x.label}${x.page!=null?` (page ${x.page})`:''}`),ignored=r.ignoredRows.map(x=>`${x.text}${x.page!=null?` (page ${x.page})`:''} — ${x.reason}`);
  const geometry=`Sheet geometry: Week column gap ${geo.weekGap??'—'}pt · pick text offset ${geo.columnOffset??'—'}pt · row pitch ${geo.rowPitch??'—'}pt · name x ${geo.nameX?geo.nameX.join('–'):'—'}.`;
  $('publishChecks').innerHTML=`<h3>Publication checks</h3>${g.blocking.length?`<p class="checks-warn"><b>Blocked:</b></p>${list(g.blocking)}`:''}${list(g.facts)}${g.reasons.length?`<p class="checks-warn"><b>Review before publishing:</b></p>${list(g.reasons)}`:''}${blank.length?`<p class="checks-note">Entrants with no picks at all (counted in the field; OUT in Week 1 for no pick):</p>${list(blank)}`:''}${ignored.length?`<p class="checks-note">Text outside the participant table (not counted):</p>${list(ignored)}`:''}<p class="checks-note">${esc(geometry)}</p>`;
  const showConfirm=!g.blocking.length&&g.requiresConfirmation,confirmKey=JSON.stringify([g.blocking,g.reasons,g.confirmText]);
  if(candidate.confirmKey!==confirmKey||!showConfirm){$('confirmPartial').checked=false;candidate.confirmKey=confirmKey}
  $('confirmWrap').hidden=!showConfirm;$('confirmText').textContent=g.confirmText;
  syncPublish();
}

$('parseBtn').onclick=async()=>{
  const sourceFile=currentFile,sourceGeneration=fileGeneration;if(!sourceFile||publishInFlight||busy)return;
  let season;try{season=selectedSeason()}catch(e){msg(e.message,'error');return}
  const operation=++parseGeneration;invalidateCandidate();setBusy(true,'Reading Survivor PDF…');msg('');
  try{
    const digest=await sha256(sourceFile);assertParseContext(sourceFile,sourceGeneration,operation,season);
    const pages=await pdfPages(sourceFile);assertParseContext(sourceFile,sourceGeneration,operation,season);
    const result=parseSurvivorPages(pages,{season,filename:sourceFile.name});if(result.errors.length)throw new Error(result.errors.join(' · '));
    const errs=validateSurvivorConfig(result.config);if(errs.length)throw new Error(errs.join(' · '));
    const week=result.config.week;setBusy(true,`Verifying NFL schedule for Weeks 1–${week}…`);
    const payloads=await fetchSchedules(season,week);assertParseContext(sourceFile,sourceGeneration,operation,season);
    const verification=verifySurvivorSchedule(result.config,payloads);
    if(!verification.ok)throw new Error(`NFL schedule verification failed; this sheet cannot be published: ${verification.errors.join(' · ')}`);
    const userId=session?.user?.id||null;let db=null;
    if(userId){setBusy(true,'Comparing with published Survivor weeks…');const rows=await readPublished(season);assertParseContext(sourceFile,sourceGeneration,operation,season);if(session?.user?.id===userId)db={userId,rows,key:publishedKey(rows)}}
    const next={config:result.config,configSnapshot:JSON.stringify(result.config),review:result.review,verification,digest,verified:true,db,guard:null};
    candidate=next;candidateFile=sourceFile;candidateFileGeneration=sourceGeneration;candidateSeason=season;refreshGuard(next);
    msg(`Survivor Week ${week} parsed and matched to the NFL schedule: ${result.config.competitionSize} entries, ${result.config.currentWeekEntryCount} with a Week ${week} pick. ${next.guard.blocking.length?'Sign in to compare it with published Survivor weeks before publishing.':next.guard.requiresConfirmation?'Review the publication checks and confirm before publishing.':'Review before publishing.'}`,'success');
    if(!db&&session)void checkPublished(next);
  }catch(e){
    if(e?.name==='StaleSurvivorContext')return;
    if(fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration){invalidateCandidate();msg(e.message||String(e),'error')}
  }finally{if(fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration)setBusy(false)}
};

function markPublished(c,revision,note=''){c.published=true;$('publishResult').hidden=false;$('replaceLocked').checked=false;$('confirmPartial').checked=false;msg(`Survivor Week ${c.config.week} published and locked. Revision ${revision}.${note}`,'success')}
async function reportWriteOutcome(attempt,error){
  const base=error?.message||String(error),code=error?.code?String(error.code):'';
  if(code==='23505'){lastAttempt=null;attempt.candidate.verified=false;msg(`Publish failed: another publish created Survivor Week ${attempt.week} first (${base}). This attempt wrote nothing. Read & validate again.`,'error');return}
  try{
    const rows=await readPublished(attempt.season,{withConfig:false}),row=rows.find(r=>r.week===attempt.week)||null;
    if(attemptLanded(row,attempt)){lastAttempt=null;markPublished(attempt.candidate,attempt.revision,' (confirmed by read-back after a lost response)');return}
    const unchanged=(row?row.revision:0)===attempt.revision-1;
    msg(`Publish failed: ${base}${code?` (${code})`:''}. Read-back shows Survivor Week ${attempt.week} ${row?`at revision ${row.revision}`:'is not published'}; this attempt wrote nothing. ${unchanged?'You can retry Publish.':'Read & validate again before retrying.'}`,'error');
    if(!unchanged)attempt.candidate.verified=false;
  }catch(readError){attempt.candidate.verified=false;msg(`Publish outcome unknown: ${base}. The published state could not be re-read (${readError.message||readError}). Reload this page and read the sheet again; it will show whether Week ${attempt.week} was published.`,'error')}
}

$('publishBtn').onclick=async()=>{
  if(publishInFlight)return;
  if(!session||session.user?.email?.toLowerCase()!==ADMIN_EMAIL){msg('Sign in before publishing.','error');return}
  if(!canPublish()){msg('This Survivor sheet is not fully validated for the current file, season and account. Read & validate it again before publishing.','error');return}
  const publishFile=currentFile,publishGeneration=fileGeneration,publishCandidate=candidate,publishSeason=candidateSeason,userId=session.user.id;
  const replaceLocked=$('replaceLocked').checked,confirmed=$('confirmPartial').checked,guard=publishCandidate.guard,cfg=structuredClone(publishCandidate.config);
  const assertPublishContext=()=>{if(!fileContextCurrent(publishFile,publishGeneration)||candidate!==publishCandidate||candidateFile!==publishFile||candidateFileGeneration!==publishGeneration||candidateSeason!==publishSeason||seasonValue()!==publishSeason||publishCandidate.guard!==guard||session?.user?.id!==userId||JSON.stringify(publishCandidate.config)!==publishCandidate.configSnapshot||$('replaceLocked').checked!==replaceLocked||$('confirmPartial').checked!==confirmed)throw staleError()};
  publishInFlight=true;setBusy(true,'Publishing Survivor week…');msg('');let attempt=null;
  try{
    const errors=validateSurvivorConfig(cfg);if(errors.length)throw new Error(errors.join(' · '));
    if(JSON.stringify(cfg)!==publishCandidate.configSnapshot||cfg.season!==publishSeason)throw staleError();
    assertPublishContext();
    const rows=await readPublished(cfg.season,{withConfig:false});assertPublishContext();
    const existing=rows.find(r=>r.week===cfg.week)||null;
    if(lastAttempt&&lastAttempt.season===cfg.season&&lastAttempt.week===cfg.week&&attemptLanded(existing,lastAttempt)){const revision=lastAttempt.revision;lastAttempt=null;markPublished(publishCandidate,revision,' (the previous attempt had already been written)');return}
    if(publishedKey(rows)!==publishCandidate.db.key){publishCandidate.verified=false;throw new Error(`Published Survivor weeks for ${cfg.season} changed since this sheet was validated. Nothing was written. Read & validate again.`)}
    if(existing?.status==='locked'&&!replaceLocked)throw new Error(`Survivor Week ${cfg.week} is already locked. Check replace only for an intentional correction. Nothing was written.`);
    if(existing&&!(Number.isSafeInteger(existing.revision)&&existing.revision>0))throw new Error(`Survivor Week ${cfg.week} has an unexpected revision value. Nothing was written.`);
    const digest=await sha256(publishFile);assertPublishContext();
    if(digest!==publishCandidate.digest){publishCandidate.verified=false;throw new Error('The selected file content changed since it was validated. Nothing was written. Select the file again and Read & validate it.')}
    const ts=new Date().toISOString(),revision=(existing?.revision||0)+1;
    cfg.source={kind:'survivor-upload',filename:publishFile.name,sha256:digest};
    const row={season:cfg.season,week:cfg.week,status:'locked',config:cfg,source_filename:publishFile.name,source_sha256:digest,revision,published_at:ts,locked_at:ts,updated_at:ts};
    assertPublishContext();attempt={season:cfg.season,week:cfg.week,revision,digest,ts,candidate:publishCandidate};lastAttempt=attempt;
    const write=existing?await neon.from('nfl_survivor_weeks').update(row).eq('season',cfg.season).eq('week',cfg.week).eq('revision',existing.revision).select('season,week,revision'):await neon.from('nfl_survivor_weeks').insert(row).select('season,week,revision');
    if(write.error)throw write.error;
    const written=Array.isArray(write.data)?write.data:null;
    if(written&&written.length===0){lastAttempt=null;publishCandidate.verified=false;msg(`Publish failed: Survivor Week ${cfg.week} changed before this write (no row matched revision ${existing?.revision}). This attempt wrote nothing. Read & validate again.`,'error');return}
    if(!written||written.length!==1||written[0]?.revision!==revision)throw new Error('The database did not confirm exactly one written Survivor row');
    lastAttempt=null;markPublished(publishCandidate,revision);
  }catch(e){
    if(e?.name==='StaleSurvivorContext'){invalidateCandidate();msg('The selected file, season, account or publish options changed before publishing completed. Nothing was written. Read & validate the current file again.','error')}
    else if(attempt)await reportWriteOutcome(attempt,e);
    else msg(e.message||String(e),'error');
  }finally{publishInFlight=false;setBusy(false)}
};

$('season').value=DEFAULT_SEASON;refreshSession();
