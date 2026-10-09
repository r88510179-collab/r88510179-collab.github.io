import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';
import {TARGETS,detectWeek,groupPdfTextItems,carryForwardWeekHints,parseDocumentGroups,chooseBestCandidate,validateConfig} from './parser-core.js?v=14';

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
let fileGeneration=0,parseGeneration=0,candidateFile=null,candidateFileGeneration=-1,candidateCompetitionSize,publishInFlight=false;
// The accepted Total pool entries value is the authoritative count; the field only displays it. An edit is accepted only
// while no publish is in flight: during a publish the value is frozen and the field is put back to it.
let totalEntriesInput={raw:'',badInput:false};
// A publish whose write the database neither confirmed nor refused: its read-back failed, or found nothing written yet (a
// write whose response was lost can still commit afterwards). The next publish of that week checks whether it landed
// before writing anything, so a write that did land is not written a second time.
let lastAttempt=null;
// HDC-14: the typed absent-game confirmation a candidate was validated with (WEEK N AWAY @ HOME ABSENT, one per line). A
// sheet game the week's NFL feed no longer lists (no listing of either team) is published only with its exact phrase, as
// an explicit exception the locked week records; it is published without an event id. The confirmation is part of the
// validated state: changing it invalidates the candidate, and it is frozen while a publish is running.
let candidateAbsence=null;
const ABSENT_EXCEPTION='absent-from-week-feed';

function selectedSeason(){const n=Number($('season').value);if(!Number.isInteger(n)||n<2020||n>2100)throw new Error('Season must be between 2020 and 2100.');return n}
function totalEntriesField(){const el=$('totalEntries');return{raw:String(el.value??'').trim(),badInput:!!el.validity?.badInput}}
function acceptTotalEntries(){if(!publishInFlight)totalEntriesInput=totalEntriesField()}
function totalEntriesShown(){const f=totalEntriesField();return f.raw===totalEntriesInput.raw&&f.badInput===totalEntriesInput.badInput}
function showTotalEntries(){$('totalEntries').value=totalEntriesInput.raw}
// Optional independent cross-check for the total pool entry count. Blank means the parser derives the full field directly
// from the validated weekly sheet, matching the normal weekly workflow. A supplied count is only compared, never used to shape it.
function totalEntriesState(){const {raw,badInput}=totalEntriesInput;if(badInput)return{ok:false};if(!raw)return{ok:true,value:null};const n=/^\d+$/.test(raw)?Number(raw):NaN;return Number.isSafeInteger(n)&&n>=TARGETS.length?{ok:true,value:n}:{ok:false}}
function selectedCompetitionSize(){acceptTotalEntries();const s=totalEntriesState();if(!s.ok)throw new Error(`Total pool entries must be a whole number of at least ${TARGETS.length}, or left blank.`);return s.value}
function competitionSizeCurrent(value){const s=totalEntriesState();return s.ok&&s.value===value}
const fieldUnavailableReason=c=>(c?.fullFieldIssues||[]).join('; ')||'regular competition field could not be validated';
const trackedNoSubmission=p=>Array.isArray(p?.pickNumbers)&&p.pickNumbers.length>0&&p.pickNumbers.every(n=>n===null)&&p.tiebreak===null;
function message(text,type='info'){$('message').className=`notice ${type}`;$('message').textContent=text;$('message').hidden=!text}
function fileContextCurrent(file,generation){return !!file&&currentFile===file&&fileGeneration===generation}
const absenceText=()=>String($('absenceConfirm').value??'');
const absenceShown=()=>absenceText()===candidateAbsence;
function canPublish(){return !!session&&!!candidate&&scheduleVerified&&candidateFile===currentFile&&candidateFileGeneration===fileGeneration&&competitionSizeCurrent(candidateCompetitionSize)&&totalEntriesShown()&&absenceShown()}
function setBusy(on,text='Working…'){$('busy').hidden=!on;$('busyText').textContent=text;$('parseBtn').disabled=on||!currentFile;$('publishBtn').disabled=on||!canPublish();$('sendCode').disabled=on;$('verifyCode').disabled=on;$('season').disabled=on;$('totalEntries').disabled=on;$('absenceConfirm').disabled=on;$('detectedWeek').disabled=on;$('tiebreakGame').disabled=on;$('replaceLocked').disabled=on}
function staleFileError(){const e=new Error('Selected file changed while validation was running.');e.name='StaleFileContext';return e}
function assertFileContext(file,generation,operation=null){if(!fileContextCurrent(file,generation)||(operation!==null&&operation!==parseGeneration))throw staleFileError()}
function invalidateParsedState(){candidates=[];candidate=null;scheduleVerified=false;candidateFile=null;candidateFileGeneration=-1;candidateCompetitionSize=undefined;$('review').hidden=true;$('publishResult').hidden=true;$('weekChoice').hidden=true;$('replaceLocked').checked=false;$('publishBtn').disabled=true}

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
function totalEntriesChanged(){if(publishInFlight){showTotalEntries();message('Publishing is in progress. Total pool entries cannot be changed until it finishes.','info');return}const had=!!candidate;acceptTotalEntries();parseGeneration++;invalidateParsedState();setBusy(false);if(had)message('Total pool entries changed. Read the weekly sheet again.','info')}
$('totalEntries').addEventListener('input',totalEntriesChanged);
$('totalEntries').addEventListener('change',totalEntriesChanged);
function absenceChanged(){if(publishInFlight){$('absenceConfirm').value=candidateAbsence??'';message('Publishing is in progress. The absent-game confirmation cannot be changed until it finishes.','info');return}const had=!!candidate;parseGeneration++;invalidateParsedState();setBusy(false);if(had)message('Absent-game confirmation changed. Read the weekly sheet again.','info')}
$('absenceConfirm').addEventListener('input',absenceChanged);
$('absenceConfirm').addEventListener('change',absenceChanged);
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
    const expectedCompetitionSize=selectedCompetitionSize(),typedAbsences=absenceText();
    const groups=await fileGroups(sourceFile);assertFileContext(sourceFile,sourceGeneration,operation);
    const season=selectedSeason(),localCandidates=parseDocumentGroups(groups,{filename:sourceFile.name,season,expectedCompetitionSize});assertFileContext(sourceFile,sourceGeneration,operation);
    const valid=localCandidates.filter(c=>!c.errors.length&&c.config.participants.length===TARGETS.length);
    if(!valid.length){const details=localCandidates.map(c=>`Week ${c.week}: ${c.errors.join('; ')||'not all tracked entries found'}`).join(' | ');throw new Error(`No complete tracked week was found. ${details}`)}
    const selected=chooseBestCandidate(localCandidates);assertFileContext(sourceFile,sourceGeneration,operation);
    candidates=localCandidates;candidate=selected;candidateFile=sourceFile;candidateFileGeneration=sourceGeneration;candidateCompetitionSize=expectedCompetitionSize;renderCandidateSelector(valid,sourceFile,sourceGeneration);
    await prepareCandidate(candidate,sourceFile,sourceGeneration,operation,typedAbsences);assertFileContext(sourceFile,sourceGeneration,operation);
    message(`${candidate.config.fullFieldReady===true?`Week ${candidate.week} parsed with ${candidate.config.competitionSize} competition entries and matched to the NFL schedule. Review it before publishing.`:`Week ${candidate.week} parsed. Full-field metrics unavailable — ${fieldUnavailableReason(candidate)}. The four tracked entries remain valid.`}${absentNote(candidate.config)}`,'success');
  }catch(e){
    if(e?.name==='StaleFileContext')return;
    if(fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration){message(e.message||String(e),'error');invalidateParsedState()}
  }finally{if(fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration)setBusy(false)}
});

function renderCandidateSelector(valid,sourceFile,sourceGeneration){
  const sel=$('detectedWeek');sel.innerHTML=valid.map(c=>`<option value="${c.week}">Week ${c.week} · ${c.gameCount} games · ${c.config.competitionSize||c.config.participants.length} entries</option>`).join('');sel.value=String(candidate.week);$('weekChoice').hidden=valid.length<2;
  sel.onchange=async()=>{
    assertFileContext(sourceFile,sourceGeneration);if(!candidates.length)return;const operation=++parseGeneration;candidate=valid.find(c=>c.week===Number(sel.value));candidateFile=sourceFile;candidateFileGeneration=sourceGeneration;scheduleVerified=false;$('publishBtn').disabled=true;setBusy(true,'Checking NFL schedule…');message('');
    try{await prepareCandidate(candidate,sourceFile,sourceGeneration,operation,absenceText());assertFileContext(sourceFile,sourceGeneration,operation);message(`Week ${candidate.week} selected and verified.${absentNote(candidate.config)}`,'success')}
    catch(e){if(e?.name!=='StaleFileContext'&&fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration){scheduleVerified=false;renderReview();message(e.message||String(e),'error')}}
    finally{if(fileContextCurrent(sourceFile,sourceGeneration)&&operation===parseGeneration)setBusy(false)}
  };
}

function eventPair(event){const cs=event?.competitions?.[0]?.competitors||[],a=cs.find(x=>x.homeAway==='away'),h=cs.find(x=>x.homeAway==='home');return{away:norm(a?.team?.abbreviation),home:norm(h?.team?.abbreviation)}}
async function readSchedule(season,week){
  const url=`${ESPN_SCOREBOARD}?dates=${season}&seasontype=2&week=${week}&limit=100&_=${Date.now()}`;
  const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`NFL schedule feed returned ${r.status}`);const j=await r.json();if(!Array.isArray(j.events)||!j.events.length)throw new Error('NFL schedule feed returned no games.');
  return j.events;
}
// HDC-14. A sheet game is absent from its week's feed only when every listing of the week is a readable pair and none names
// either team, in any orientation or against any opponent: a reversed, duplicate, re-paired or unreadable listing is never
// an absence, and no other week is ever read. The sheet must name each of its teams in this game only.
function readablePair(e){
  const cs=Array.isArray(e?.competitions)&&e.competitions.length===1?e.competitions[0]?.competitors:null;
  if(!Array.isArray(cs)||cs.length!==2)return false;
  const a=cs.filter(x=>x?.homeAway==='away'),h=cs.filter(x=>x?.homeAway==='home');
  return a.length===1&&h.length===1&&typeof a[0]?.team?.abbreviation==='string'&&typeof h[0]?.team?.abbreviation==='string'&&!!a[0].team.abbreviation&&a[0].team.abbreviation!==h[0].team.abbreviation;
}
const listedTeams=e=>(Array.isArray(e?.competitions)?e.competitions:[]).flatMap(c=>(Array.isArray(c?.competitors)?c.competitors:[]).map(x=>norm(String(x?.team?.abbreviation??''))));
function absentFromFeed(events,away,home){return events.every(readablePair)&&!events.some(e=>listedTeams(e).some(t=>t===away||t===home))}
const onlyGameOfItsTeams=(games,i)=>{const a=norm(games[i].away),h=norm(games[i].home);return !games.some((g,j)=>j!==i&&[norm(g.away),norm(g.home)].some(t=>t===a||t===h))};
const absencePhrase=(week,away,home)=>`WEEK ${week} ${away} @ ${home} ABSENT`;
const absenceLines=text=>String(text??'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
const absentNote=cfg=>(cfg?.publicationExceptions||[]).map(x=>` ${x.away} at ${x.home} is published as ABSENT FROM WEEK ${x.week} FEED by your typed exception.`).join('');
async function verifySchedule(config,typed=''){
  const events=await readSchedule(config.season,config.week);
  const confirmations=absenceLines(typed),confirmed=new Set(),exceptions=[],usedEventIds=new Set();
  const games=config.games.map((g,i)=>{
    const away=norm(g.away),home=norm(g.home);
    const matches=events.filter(e=>{const p=eventPair(e);return p.away===away&&p.home===home});
    // Found 0 matching NFL games stays an error unless the commissioner typed this game's exact absence phrase.
    if(!matches.length&&onlyGameOfItsTeams(config.games,i)&&absentFromFeed(events,away,home)){
      const phrase=absencePhrase(config.week,away,home);
      if(!confirmations.includes(phrase))throw new Error(`Schedule mismatch for ${g.away} at ${g.home}. Found 0 matching NFL games. Neither team is listed in the NFL Week ${config.week} feed. If this game was moved out of Week ${config.week}, type ${phrase} under Absent games and read the sheet again to publish it with an explicit absence exception.`);
      confirmed.add(phrase);exceptions.push({type:ABSENT_EXCEPTION,week:config.week,gameIndex:i,away,home,confirmation:phrase});
      return{...g,index:i};
    }
    if(matches.length!==1)throw new Error(`Schedule mismatch for ${g.away} at ${g.home}. Found ${matches.length} matching NFL games.`);
    const e=matches[0],eventId=String(e.id||'');
    if(!eventId)throw new Error(`Schedule event for ${g.away} at ${g.home} is missing an event ID.`);
    if(usedEventIds.has(eventId))throw new Error(`Schedule event ${eventId} was matched to more than one pool game.`);
    usedEventIds.add(eventId);
    return{...g,index:i,eventId,date:String(e.date||'').slice(0,10)};
  });
  for(const line of confirmations)if(!confirmed.has(line))throw new Error(`Absent-game confirmation "${line}" does not match a sheet game missing from the NFL Week ${config.week} feed. Correct or clear it, then read the sheet again.`);
  if(events.length<games.length-exceptions.length)throw new Error(`NFL feed has ${events.length} games but the sheet has ${games.length}.`);
  return exceptions.length?{...config,games,publicationExceptions:exceptions}:{...config,games};
}
async function prepareCandidate(c,sourceFile,sourceGeneration,operation,typedAbsences){
  assertFileContext(sourceFile,sourceGeneration,operation);let cfg=structuredClone(c.config);const localErrors=validateConfig(cfg);if(localErrors.length)throw new Error(localErrors.join(' · '));
  cfg=await verifySchedule(cfg,typedAbsences);assertFileContext(sourceFile,sourceGeneration,operation);c.config=cfg;candidateFile=sourceFile;candidateFileGeneration=sourceGeneration;candidateAbsence=typedAbsences;scheduleVerified=true;renderReview();
}

function renderReview(){
  if(!candidate)return;$('review').hidden=false;const cfg=candidate.config;$('reviewTitle').textContent=`${cfg.season} · Week ${cfg.week} · ${cfg.games.length} games · ${cfg.competitionSize||cfg.participants.length} entries`;
  $('gameReview').innerHTML=cfg.games.map((g,i)=>`<tr><td>${i+1}</td><td><b>${g.awayNumber}</b> ${esc(g.awayName||g.away)}</td><td>at</td><td><b>${g.homeNumber}</b> ${esc(g.homeName||g.home)}</td><td>${esc(g.date||'—')}</td></tr>`).join('');
  $('entryReview').innerHTML=cfg.participants.map(p=>{const blank=trackedNoSubmission(p);return`<tr><td>${esc(p.displayName)}</td><td class="nums">${blank?'NO PICKS SUBMITTED':p.pickNumbers.join(' ')}</td><td><b>${blank?'—':esc(p.tiebreak)}</b></td></tr>`}).join('');
  const tb=$('tiebreakGame');tb.innerHTML=cfg.games.map((g,i)=>`<option value="${i}">${i+1}. ${g.away} at ${g.home}</option>`).join('');tb.value=String(cfg.tiebreakGameIndex);tb.onchange=()=>{cfg.tiebreakGameIndex=Number(tb.value)};
  const fieldWarning=cfg.fullFieldReady===true?`<span class="check">✓ Full-field regular Pick'em data validated · ${cfg.competitionSize} entries</span>`:`<span class="field-warn">⚠ Full-field metrics unavailable — ${esc(fieldUnavailableReason(candidate))}. The four tracked entries remain valid.</span>`;
  const absent=(cfg.publicationExceptions||[]).map(x=>`<span class="field-warn">⚠ ${esc(x.away)} at ${esc(x.home)}: ABSENT FROM WEEK ${esc(x.week)} FEED — published by your typed absence exception; no NFL event is recorded for it, and it is ruled on separately</span>`).join('');
  $('validation').innerHTML=scheduleVerified?`<span class="check">✓ Tracked rows valid</span><span class="check">✓ Four tracked entries found</span><span class="check">✓ Anonymous privacy allowlist enforced</span>${fieldWarning}<span class="check">✓ NFL schedule matched</span>${absent}`:'<span class="bad">Schedule verification required</span>';
  $('publishBtn').disabled=!canPublish();
}

async function sha256(file){const buf=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('')}
// The publication boundary. An existing week is replaced only from the revision this publish read (compare-and-swap on
// season, week and revision); a new week is only inserted, never upserted, so a concurrent insert of the same week is
// refused by the database's unique season/week key. Only a response confirming exactly one row with the new revision is a
// normal success; any other outcome is decided by reading the week back. A write is identified by its season and week,
// revision, source digest, timestamp, status and configuration, so the read-back tells this exact write apart from no
// write and from any other publish's write, even one of the same file at the same revision and instant.
async function readWeek(season,week){
  const {data,error}=await neon.from('nfl_pool_weeks').select('season,week,status,revision,source_sha256,updated_at,config').eq('season',season).eq('week',week);if(error)throw error;
  if(!Array.isArray(data)||data.length>1||data.some(r=>r?.season!==season||r?.week!==week))throw new Error(`The database returned an unreadable result for Week ${week}.`);
  return data[0]||null;
}
// A configuration compared as the JSON a write sends: object keys sorted at every depth, arrays in their own order, so
// the key order a database returns (a JSONB column keeps none) never decides a comparison. A value that is not JSON has
// no canonical form (null), and a write whose configuration has none matches no row.
function canonicalJson(value){
  const text=v=>Array.isArray(v)?`[${v.map(text).join(',')}]`:v!==null&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${text(v[k])}`).join(',')}}`:JSON.stringify(v);
  try{const json=JSON.stringify(value);return json===undefined?null:text(JSON.parse(json))}catch{return null}
}
const sameInstant=(a,b)=>Number.isFinite(Date.parse(a))&&Date.parse(a)===Date.parse(b);
// What a read-back identifies a write by. Two publishes of one file can write the same revision at the same instant with
// different configurations, and only one of them lands, so the configuration (as canonical JSON) is part of it.
const writeIdentity=row=>row&&{season:row.season,week:row.week,revision:row.revision,source_sha256:row.source_sha256,updated_at:row.updated_at,status:row.status,config:canonicalJson(row.config)};
const sameWrite=(row,w)=>!!row&&!!w&&row.season===w.season&&row.week===w.week&&row.revision===w.revision&&row.source_sha256===w.source_sha256&&sameInstant(row.updated_at,w.updated_at)&&row.status===w.status&&w.config!==null&&canonicalJson(row.config)===w.config;
const attemptLanded=(row,attempt)=>sameWrite(row,attempt)&&row.status==='locked';
function markPublished(attempt,note=''){if(fileContextCurrent(attempt.file,attempt.generation)){message(`Week ${attempt.week} published and locked successfully. Revision ${attempt.revision}.${note}`,'success');$('publishResult').hidden=false;$('trackerLink').href=`../?season=${attempt.season}&week=${attempt.week}`;$('replaceLocked').checked=false}}
function requireRevalidation(text){parseGeneration++;invalidateParsedState();message(text,'error')}
async function reportWriteOutcome(attempt,error){
  const base=error?.message||String(error),code=error?.code?` (${error.code})`:'';
  if(String(error?.code)==='23505'){requireRevalidation(`Publish failed: another publish created Week ${attempt.week} before this write (${base}). Nothing from this attempt was written. Read and validate the sheet again before publishing.`);return}
  let row;
  try{row=await readWeek(attempt.season,attempt.week)}
  catch(readError){lastAttempt=attempt;requireRevalidation(`Publish outcome unknown: ${base}${code}. Week ${attempt.week} could not be read back (${readError?.message||readError}), so nothing was retried. Read and validate the sheet again; the next publish of this week checks whether this attempt was written before writing anything.`);return}
  if(attemptLanded(row,attempt)){markPublished(attempt,' Success confirmed by read-back after the database response was lost or incomplete.');return}
  // Still exactly as this publish read it (or still absent): nothing is written yet, so the validated page may publish
  // again. The attempt is remembered in case its write still commits after this read-back.
  if(attempt.prior?sameWrite(row,attempt.prior):row===null){lastAttempt=attempt;message(`Publish failed: ${base}${code}. Read-back shows Week ${attempt.week} ${row?`still at revision ${row.revision}`:'still unpublished'}, so this attempt wrote nothing. You can retry Publish.`,'error');return}
  requireRevalidation(`Publish not confirmed: ${base}${code}. Read-back does not show this attempt's write: Week ${attempt.week} is ${row?`at revision ${row.revision}`:'not published'}. Nothing was retried. Read and validate the sheet again before publishing.`);
}
$('publishBtn').addEventListener('click',async()=>{
  // One publish at a time. A disabled button does not stop script from invoking this listener, so the handler refuses
  // re-entry itself, before any check, message or database call; only the publish holding the flag releases it.
  if(publishInFlight)return;
  if(!session||session.user?.email?.toLowerCase()!==ADMIN_EMAIL){message('Sign in before publishing.','error');return}
  const publishFile=currentFile,publishGeneration=fileGeneration,publishCandidate=candidate,publishCompetitionSize=candidateCompetitionSize;
  if(!publishCandidate||!scheduleVerified||!fileContextCurrent(publishFile,publishGeneration)||candidateFile!==publishFile||candidateFileGeneration!==publishGeneration||!competitionSizeCurrent(publishCompetitionSize)||!totalEntriesShown()||!absenceShown()){invalidateParsedState();message('The selected file changed or is no longer validated. Read and validate it again before publishing.','error');return}
  publishInFlight=true;$('file').disabled=true;setBusy(true,'Publishing and locking week…');message('');
  const cfg=structuredClone(publishCandidate.config),configSnapshot=JSON.stringify(publishCandidate.config),replaceLocked=$('replaceLocked').checked,errors=validateConfig(cfg);
  const assertPublishContext=()=>{if(!fileContextCurrent(publishFile,publishGeneration)||candidate!==publishCandidate||candidateFile!==publishFile||candidateFileGeneration!==publishGeneration||!scheduleVerified||JSON.stringify(publishCandidate.config)!==configSnapshot||candidateCompetitionSize!==publishCompetitionSize||!competitionSizeCurrent(publishCompetitionSize)||!absenceShown())throw staleFileError()};
  let attempt=null;
  try{
    if(errors.length)throw new Error(errors.join(' · '));
    assertPublishContext();
    // HDC-14: an absence exception holds only while the week's feed still lists no game of either team; it is re-checked
    // against the same week before anything is read or written. No other week is ever read.
    const exceptions=Array.isArray(cfg.publicationExceptions)?cfg.publicationExceptions:[];
    if(exceptions.length){
      let events;
      try{events=await readSchedule(cfg.season,cfg.week)}
      catch(e){throw new Error(`Publish refused: the NFL Week ${cfg.week} feed could not be re-checked for ${exceptions.map(x=>`${x.away} at ${x.home}`).join(', ')} (${e?.message||e}). Nothing was written. You can retry Publish.`)}
      assertPublishContext();
      const back=exceptions.find(x=>!absentFromFeed(events,x.away,x.home));
      if(back){
        const listed=events.some(e=>listedTeams(e).some(t=>t===back.away||t===back.home));
        requireRevalidation(`Publish refused: ${back.away} at ${back.home} is no longer absent from the NFL Week ${cfg.week} feed (${listed?`a game of ${back.away} or ${back.home} is listed`:'the feed now lists a game it cannot read'}), so its absence exception no longer holds. Nothing was written. Read and validate the sheet again before publishing.`);return;
      }
    }
    const existing=await readWeek(cfg.season,cfg.week);assertPublishContext();
    const digest=await sha256(publishFile);assertPublishContext();
    cfg.source={kind:'weekly-upload',filename:publishFile.name,sha256:digest};
    // An undecided earlier attempt of this week that landed as exactly this configuration is this publication.
    const earlier=lastAttempt?.season===cfg.season&&lastAttempt.week===cfg.week?lastAttempt:null;
    if(earlier){lastAttempt=null;if(attemptLanded(existing,earlier)&&earlier.config===canonicalJson(cfg)){markPublished({...earlier,file:publishFile,generation:publishGeneration},' The earlier attempt of this publication had been written after all, so nothing new was written.');return}}
    if(existing?.status==='locked'&&!replaceLocked)throw new Error(`Week ${cfg.week} is already locked. Check “replace locked week” only if you intentionally need to correct it.`);
    if(existing&&!(Number.isSafeInteger(existing.revision)&&existing.revision>0))throw new Error(`Week ${cfg.week} has an unexpected revision value. Nothing was written.`);
    const nowIso=new Date().toISOString(),revision=(existing?.revision||0)+1;
    const row={season:cfg.season,week:cfg.week,status:'locked',config:cfg,source_filename:publishFile.name,source_sha256:digest,revision,published_at:nowIso,locked_at:nowIso,updated_at:nowIso};
    assertPublishContext();attempt={...writeIdentity(row),prior:writeIdentity(existing),file:publishFile,generation:publishGeneration};
    const write=existing?await neon.from('nfl_pool_weeks').update(row).eq('season',cfg.season).eq('week',cfg.week).eq('revision',existing.revision).select('season,week,revision'):await neon.from('nfl_pool_weeks').insert(row).select('season,week,revision');
    if(write?.error)throw write.error;
    const written=Array.isArray(write?.data)?write.data:null;
    if(existing&&written?.length===0){requireRevalidation(`Publish failed: Week ${cfg.week} changed before this write (no row matched revision ${existing.revision}). Nothing from this stale attempt was written. Read and validate the sheet again before publishing.`);return}
    if(written?.length!==1||written[0]?.season!==cfg.season||written[0]?.week!==cfg.week||written[0]?.revision!==revision)throw new Error('The database did not confirm exactly one written Pick\'em week');
    markPublished(attempt);
  }catch(e){
    // Once the write is dispatched, every failure is a write outcome to be decided, never a plain error.
    if(attempt)await reportWriteOutcome(attempt,e);
    else if(e?.name==='StaleFileContext'){invalidateParsedState();message('The selected file or publish settings changed before publishing completed. Validate the current file again.','error')}
    else message(e.message||String(e),'error')
  }finally{showTotalEntries();publishInFlight=false;$('file').disabled=false;setBusy(false)}
});

refreshSession();
