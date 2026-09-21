import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';
import {TARGETS,detectWeek,groupPdfTextItems,carryForwardWeekHints,parseDocumentGroups,chooseBestCandidate,validateConfig} from './parser-core.js?v=7';

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ESPN_SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ADMIN_EMAIL='djsmokke@gmail.com';
const now=new Date(),DEFAULT_SEASON=now.getUTCMonth()<2?now.getUTCFullYear()-1:now.getUTCFullYear();
const neon=createClient({auth:{url:NEON_AUTH_URL},dataApi:{url:NEON_DATA_URL}});

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=x=>({JAC:'JAX',WSH:'WAS'}[x]||x);
let session=null,currentFile=null,candidates=[],candidate=null,scheduleVerified=false;
let fileGeneration=0,parseGeneration=0,candidateFile=null,candidateFileGeneration=-1,publishInFlight=false;

function selectedSeason(){const n=Number($('season').value);if(!Number.isInteger(n)||n<2020||n>2100)throw new Error('Season must be between 2020 and 2100.');return n}
function message(text,type='info'){$('message').className=`notice ${type}`;$('message').textContent=text;$('message').hidden=!text}
function fileContextCurrent(file,generation){return !!file&&currentFile===file&&fileGeneration===generation}
function canPublish(){return !!session&&!!candidate&&scheduleVerified&&candidateFile===currentFile&&candidateFileGeneration===fileGeneration}
function setBusy(on,text='Working…'){$('busy').hidden=!on;$('busyText').textContent=text;$('parseBtn').disabled=on||!currentFile;$('publishBtn').disabled=on||!canPublish();$('sendCode').disabled=on;$('verifyCode').disabled=on;$('season').disabled=on;$('detectedWeek').disabled=on;$('tiebreakGame').disabled=on;$('replaceLocked').disabled=on}
function staleFileError(){const e=new Error('Selected file changed while validation was running.');e.name='StaleFileContext';return e}
function assertFileContext(file,generation,operation=null){if(!fileContextCurrent(file,generation)||(operation!==null&&operation!==parseGeneration))throw staleFileError()}
function invalidateParsedState(){candidates=[];candidate=null;scheduleVerified=false;candidateFile=null;candidateFileGeneration=-1;$('review').hidden=true;$('publishResult').hidden=true;$('weekChoice').hidden=true;$('replaceLocked').checked=false;$('publishBtn').disabled=true}

async function refreshSession(){
  const result=await neon.auth.getSession();
  const data=result?.data||null,user=data?.user||null,s=data?.session||null;
  if(result?.error)console.warn('Session check failed',result.error);
  session=s&&user?{session:s,user}:null;
  if(session&&session.user?.email?.toLowerCase()!==ADMIN_EMAIL){await neon.auth.signOut();session=null}
  renderAuth();
}
function renderAuth(){const signed=!!session;$('signedOut').hidden=signed;$('signedIn').hidden=!signed;$('signedEmail').textContent=signed?session.user.email:'';$('publishBtn').disabled=!canPublish();$('authState').textContent=signed?'AUTHORIZED':'SIGN IN REQUIRED';$('authState').className=`pill ${signed?'ok':'warn'}`}
function setCurrentFile(file){
  if(publishInFlight){message('Publishing is in progress. Wait for it to finish before changing files.','info');return}
  fileGeneration++;parseGeneration++;currentFile=file||null;invalidateParsedState();setBusy(false);
  $('fileName').textContent=currentFile?`${currentFile.name} · ${(currentFile.size/1024).toFixed(0)} KB`:'No file selected';$('parseBtn').disabled=!currentFile;
}

$('sendCode').addEventListener('click',async()=>{
  $('sendCode').disabled=true;message('');
  try{
    const {error}=await neon.auth.emailOtp.sendVerificationOtp({email:ADMIN_EMAIL,type:'sign-in'});
    if(error)throw error;
    $('otpWrap').hidden=false;$('otp').focus();message(`Sign-in code sent to ${ADMIN_EMAIL}.`,'success');
  }catch(e){message(`Could not send sign-in code: ${e.message||e}`,'error')}
  finally{$('sendCode').disabled=false}
});
$('verifyCode').addEventListener('click',async()=>{
  const otp=$('otp').value.trim();if(!/^\d{4,10}$/.test(otp)){message('Enter the numeric code from your email.','error');return}
  setBusy(true,'Verifying sign-in…');message('');
  try{
    const {error}=await neon.auth.signIn.emailOtp({email:ADMIN_EMAIL,otp});if(error)throw error;
    $('otp').value='';$('otpWrap').hidden=true;await refreshSession();
    if(!session)throw new Error('Authentication completed but no authorized session was created.');
    message('Signed in securely.','success');
  }catch(e){message(`Sign-in failed: ${e.message||e}`,'error')}
  finally{setBusy(false)}
});
$('otp').addEventListener('keydown',e=>{if(e.key==='Enter'){$('verifyCode').click()}});
$('signOut').addEventListener('click',async()=>{await neon.auth.signOut();session=null;renderAuth();message('Signed out.','info')});

$('season').value=String(DEFAULT_SEASON);
$('season').addEventListener('change',()=>{parseGeneration++;invalidateParsedState();message('Season changed. Read the weekly sheet again.','info')});
$('file').addEventListener('change',()=>setCurrentFile($('file').files?.[0]||null));
$('drop').addEventListener('dragover',e=>{e.preventDefault();$('drop').classList.add('over')});
$('drop').addEventListener('dragleave',()=>$('drop').classList.remove('over'));
$('drop').addEventListener('drop',e=>{e.preventDefault();$('drop').classList.remove('over');const f=e.dataTransfer.files?.[0];if(f)setCurrentFile(f)});

async function pdfGroups(file){
  const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const data=new Uint8Array(await file.arrayBuffer()),pdf=await pdfjs.getDocument({data}).promise,groups=[];
  for(let n=1;n<=pdf.numPages;n++){
    const page=await pdf.getPage(n),content=await page.getTextContent(),sourceRows=groupPdfTextItems(content.items).map(r=>({...r,kind:'pdf',pageNumber:n})),lines=sourceRows.map(r=>r.text),week=lines.map(detectWeek).find(Boolean)||null;
    groups.push({week,lines,sourceRows,pageNumber:n,pageFingerprint:lines.join('\n').replace(/\s+/g,' ').trim().toLowerCase()});
  }
  return carryForwardWeekHints(groups);
}
async function spreadsheetGroups(file){
  const XLSX=await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs');
  const wb=XLSX.read(await file.arrayBuffer(),{type:'array'}),groups=[];
  for(const sheetName of wb.SheetNames){
    const ws=wb.Sheets[sheetName],rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''});
    const sourceRows=rows.map((row,i)=>{const cells=row.map(v=>String(v).trim());return{kind:'spreadsheet',sheetName,rowNumber:i+1,cells,text:cells.filter(Boolean).join(' ')}}).filter(r=>r.text);
    const lines=sourceRows.map(r=>r.text),week=detectWeek(sheetName)||lines.map(detectWeek).find(Boolean)||null;
    groups.push({week,lines,sourceRows,sheetName});
  }
  return groups;
}
async function fileGroups(file){const ext=file.name.toLowerCase().split('.').pop();if(ext==='pdf'||file.type==='application/pdf')return pdfGroups(file);if(['xlsx','xls','xlsm'].includes(ext))return spreadsheetGroups(file);throw new Error('Use a PDF, XLSX, XLS, or XLSM weekly sheet.')}

$('parseBtn').addEventListener('click',async()=>{
  const sourceFile=currentFile,sourceGeneration=fileGeneration;if(!sourceFile)return;const operation=++parseGeneration;
  setBusy(true,'Reading weekly sheet…');message('');invalidateParsedState();
  try{
    const groups=await fileGroups(sourceFile);assertFileContext(sourceFile,sourceGeneration,operation);
    const season=selectedSeason(),localCandidates=parseDocumentGroups(groups,{filename:sourceFile.name,season});assertFileContext(sourceFile,sourceGeneration,operation);
    const valid=localCandidates.filter(c=>!c.errors.length&&c.config.participants.length===TARGETS.length);
    if(!valid.length){const details=localCandidates.map(c=>`Week ${c.week}: ${c.errors.join('; ')||'not all tracked entries found'}`).join(' | ');throw new Error(`No complete tracked week was found. ${details}`)}
    const selected=chooseBestCandidate(localCandidates);assertFileContext(sourceFile,sourceGeneration,operation);
    candidates=localCandidates;candidate=selected;candidateFile=sourceFile;candidateFileGeneration=sourceGeneration;renderCandidateSelector(valid,sourceFile,sourceGeneration);
    await prepareCandidate(candidate,sourceFile,sourceGeneration,operation);assertFileContext(sourceFile,sourceGeneration,operation);
    message(candidate.config.fullFieldReady===true?`Week ${candidate.week} parsed with ${candidate.config.competitionSize} competition entries and matched to the NFL schedule. Review it before publishing.`:`Week ${candidate.week} parsed. Full-field metrics unavailable — regular competition field could not be validated. The four tracked entries remain valid.`,'success');
  }catch(e){
    if(e?.name==='StaleFileContext')return;
    if(fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration){message(e.message||String(e),'error');invalidateParsedState()}
  }finally{if(fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration)setBusy(false)}
});

function renderCandidateSelector(valid,sourceFile,sourceGeneration){
  const sel=$('detectedWeek');sel.innerHTML=valid.map(c=>`<option value="${c.week}">Week ${c.week} · ${c.gameCount} games · ${c.config.competitionSize||c.config.participants.length} entries</option>`).join('');sel.value=String(candidate.week);$('weekChoice').hidden=valid.length<2;
  sel.onchange=async()=>{
    assertFileContext(sourceFile,sourceGeneration);const operation=++parseGeneration;candidate=valid.find(c=>c.week===Number(sel.value));candidateFile=sourceFile;candidateFileGeneration=sourceGeneration;scheduleVerified=false;$('publishBtn').disabled=true;setBusy(true,'Checking NFL schedule…');message('');
    try{await prepareCandidate(candidate,sourceFile,sourceGeneration,operation);assertFileContext(sourceFile,sourceGeneration,operation);message(`Week ${candidate.week} selected and verified.`,'success')}
    catch(e){if(e?.name!=='StaleFileContext'&&fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration){scheduleVerified=false;renderReview();message(e.message||String(e),'error')}}
    finally{if(fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration)setBusy(false)}
  };
}

function eventPair(event){const cs=event?.competitions?.[0]?.competitors||[],a=cs.find(x=>x.homeAway==='away'),h=cs.find(x=>x.homeAway==='home');return{away:norm(a?.team?.abbreviation),home:norm(h?.team?.abbreviation)}}
async function verifySchedule(config){
  const url=`${ESPN_SCOREBOARD}?dates=${config.season}&seasontype=2&week=${config.week}&limit=100&_=${Date.now()}`;
  const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`NFL schedule feed returned ${r.status}`);const j=await r.json();if(!Array.isArray(j.events)||!j.events.length)throw new Error('NFL schedule feed returned no games.');
  const usedEventIds=new Set();
  const games=config.games.map((g,i)=>{
    const matches=j.events.filter(e=>{const p=eventPair(e);return p.away===norm(g.away)&&p.home===norm(g.home)});
    if(matches.length!==1)throw new Error(`Schedule mismatch for ${g.away} at ${g.home}. Found ${matches.length} matching NFL games.`);
    const e=matches[0],eventId=String(e.id||'');
    if(!eventId)throw new Error(`Schedule event for ${g.away} at ${g.home} is missing an event ID.`);
    if(usedEventIds.has(eventId))throw new Error(`Schedule event ${eventId} was matched to more than one pool game.`);
    usedEventIds.add(eventId);
    return{...g,index:i,eventId,date:String(e.date||'').slice(0,10)};
  });
  if(j.events.length<games.length)throw new Error(`NFL feed has ${j.events.length} games but the sheet has ${games.length}.`);
  return{...config,games};
}
async function prepareCandidate(c,sourceFile,sourceGeneration,operation){
  assertFileContext(sourceFile,sourceGeneration,operation);let cfg=structuredClone(c.config);const localErrors=validateConfig(cfg);if(localErrors.length)throw new Error(localErrors.join(' · '));
  cfg=await verifySchedule(cfg);assertFileContext(sourceFile,sourceGeneration,operation);c.config=cfg;candidateFile=sourceFile;candidateFileGeneration=sourceGeneration;scheduleVerified=true;renderReview();
}

function renderReview(){
  if(!candidate)return;$('review').hidden=false;const cfg=candidate.config;$('reviewTitle').textContent=`${cfg.season} · Week ${cfg.week} · ${cfg.games.length} games · ${cfg.competitionSize||cfg.participants.length} entries`;
  $('gameReview').innerHTML=cfg.games.map((g,i)=>`<tr><td>${i+1}</td><td><b>${g.awayNumber}</b> ${esc(g.awayName||g.away)}</td><td>at</td><td><b>${g.homeNumber}</b> ${esc(g.homeName||g.home)}</td><td>${esc(g.date||'—')}</td></tr>`).join('');
  $('entryReview').innerHTML=cfg.participants.map(p=>`<tr><td>${esc(p.displayName)}</td><td class="nums">${p.pickNumbers.join(' ')}</td><td><b>${p.tiebreak}</b></td></tr>`).join('');
  const tb=$('tiebreakGame');tb.innerHTML=cfg.games.map((g,i)=>`<option value="${i}">${i+1}. ${g.away} at ${g.home}</option>`).join('');tb.value=String(cfg.tiebreakGameIndex);tb.onchange=()=>{cfg.tiebreakGameIndex=Number(tb.value)};
  const fieldWarning=cfg.fullFieldReady===true?`<span class="check">✓ Full-field regular Pick'em data validated · ${cfg.competitionSize} entries</span>`:`<span class="field-warn">⚠ Full-field metrics unavailable — regular competition field could not be validated. The four tracked entries remain valid.</span>`;
  $('validation').innerHTML=scheduleVerified?`<span class="check">✓ Tracked picks valid</span><span class="check">✓ Four tracked entries found</span><span class="check">✓ Anonymous privacy allowlist enforced</span>${fieldWarning}<span class="check">✓ NFL schedule matched</span>`:'<span class="bad">Schedule verification required</span>';
  $('publishBtn').disabled=!canPublish();
}

async function sha256(file){const buf=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('')}
$('publishBtn').addEventListener('click',async()=>{
  if(!session||session.user?.email?.toLowerCase()!==ADMIN_EMAIL){message('Sign in before publishing.','error');return}
  const publishFile=currentFile,publishGeneration=fileGeneration,publishCandidate=candidate;
  if(!publishCandidate||!scheduleVerified||!fileContextCurrent(publishFile,publishGeneration)||candidateFile!==publishFile||candidateFileGeneration!==publishGeneration){invalidateParsedState();message('The selected file changed or is no longer validated. Read and validate it again before publishing.','error');return}
  publishInFlight=true;$('file').disabled=true;setBusy(true,'Publishing and locking week…');message('');
  const cfg=structuredClone(publishCandidate.config),configSnapshot=JSON.stringify(publishCandidate.config),replaceLocked=$('replaceLocked').checked,errors=validateConfig(cfg);
  const assertPublishContext=()=>{if(!fileContextCurrent(publishFile,publishGeneration)||candidate!==publishCandidate||candidateFile!==publishFile||candidateFileGeneration!==publishGeneration||!scheduleVerified||JSON.stringify(publishCandidate.config)!==configSnapshot)throw staleFileError()};
  try{
    if(errors.length)throw new Error(errors.join(' · '));
    assertPublishContext();
    const {data:rows,error:readError}=await neon.from('nfl_pool_weeks').select('season,week,status,revision').eq('season',cfg.season).eq('week',cfg.week).limit(1);if(readError)throw readError;assertPublishContext();
    const existing=Array.isArray(rows)&&rows.length?rows[0]:null;
    if(existing?.status==='locked'&&!replaceLocked)throw new Error(`Week ${cfg.week} is already locked. Check “replace locked week” only if you intentionally need to correct it.`);
    const digest=await sha256(publishFile);assertPublishContext();const nowIso=new Date().toISOString(),revision=(existing?.revision||0)+1;
    cfg.source={kind:'weekly-upload',filename:publishFile.name,sha256:digest};
    const row={season:cfg.season,week:cfg.week,status:'locked',config:cfg,source_filename:publishFile.name,source_sha256:digest,revision,published_at:nowIso,locked_at:nowIso,updated_at:nowIso};
    assertPublishContext();let write;
    if(existing)write=await neon.from('nfl_pool_weeks').update(row).eq('season',cfg.season).eq('week',cfg.week).select('season,week,revision');
    else write=await neon.from('nfl_pool_weeks').insert(row).select('season,week,revision');
    if(write.error)throw write.error;
    if(fileContextCurrent(publishFile,publishGeneration)){message(`Week ${cfg.week} published and locked successfully. Revision ${revision}.`,'success');$('publishResult').hidden=false;$('trackerLink').href=`../?season=${cfg.season}&week=${cfg.week}`;$('replaceLocked').checked=false}
  }catch(e){
    if(e?.name==='StaleFileContext'){invalidateParsedState();message('The selected file or publish settings changed before publishing completed. Validate the current file again.','error')}
    else message(e.message||String(e),'error')
  }finally{publishInFlight=false;$('file').disabled=false;setBusy(false)}
});

refreshSession();
