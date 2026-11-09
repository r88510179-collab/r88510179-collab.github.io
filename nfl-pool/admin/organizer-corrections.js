import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';
import {detectWeek,groupPdfTextItems,carryForwardWeekHints,parseDocumentGroups,validateConfig} from './parser-core.js?v=16';
import {pdfRecoveryApplies,attemptPdfFieldRecovery} from './pdf-field-recovery.js?v=3';
import {planOrganizerCorrection,finalizeOrganizerCorrection} from './organizer-correction-core.js?v=1';

const ADMIN_EMAIL='djsmokke@gmail.com';
const neon=createClient({auth:{url:'https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth'},
  dataApi:{url:'https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1'}});
const $=id=>document.getElementById(id);
let session=null,published=null,plan=null,operation=0,busy=false;
const now=new Date();$('season').value=String(now.getUTCMonth()<2?now.getUTCFullYear()-1:now.getUTCFullYear());
function message(s,type='info'){$('message').className='notice '+type;$('message').textContent=s;$('message').hidden=!s}
function invalidate(){operation++;plan=null;$('review').hidden=true;$('confirm').checked=false;$('publish').disabled=true}
function setBusy(v){busy=v;for(const id of ['sendCode','verifyCode','loadWeek','preview','publish'])$(id).disabled=v;
  for(const id of ['sourceFile','season','week','participantName','picks','tiebreak','noticeSubject','noticeType','confirm'])$(id).disabled=v;
  if(!v){$('loadWeek').disabled=!session;$('preview').disabled=!session||!published;$('publish').disabled=!session||!plan||!$('confirm').checked;}}
async function refreshSession(){
  const result=await neon.auth.getSession();const data=result?.data;
  session=data?.session&&data?.user&&data.user.email?.toLowerCase()===ADMIN_EMAIL?{user:data.user,session:data.session}:null;
  if(data?.user&&data.user.email?.toLowerCase()!==ADMIN_EMAIL){await neon.auth.signOut();session=null}
  $('signedOut').hidden=!!session;$('signedIn').hidden=!session;$('signedEmail').textContent=session?.user?.email||'';
  $('authState').textContent=session?'AUTHORIZED':'SIGN IN REQUIRED';$('authState').className='pill '+(session?'ok':'warn');
  setBusy(false);
}
$('sendCode').addEventListener('click',async()=>{
  setBusy(true);message('');
  try{const {error}=await neon.auth.emailOtp.sendVerificationOtp({email:ADMIN_EMAIL,type:'sign-in'});if(error)throw error;
    $('otpWrap').hidden=false;message('Email sign-in code sent.','success')}
  catch(e){message(e?.message||String(e),'error')}
  finally{setBusy(false)}
});
$('verifyCode').addEventListener('click',async()=>{
  const otp=$('otp').value.trim();if(!/^\d{4,10}$/.test(otp)){message('Enter the numeric email code.','error');return}
  setBusy(true);try{const {error}=await neon.auth.signIn.emailOtp({email:ADMIN_EMAIL,otp});if(error)throw error;
    $('otp').value='';$('otpWrap').hidden=true;await refreshSession();if(!session)throw new Error('No authorized publisher session was created.');message('Signed in.','success')}
  catch(e){message(e?.message||String(e),'error')}
  finally{setBusy(false)}
});
$('signOut').addEventListener('click',async()=>{await neon.auth.signOut();session=null;published=null;invalidate();$('weekDetails').textContent='';$('history').hidden=true;await refreshSession();message('Signed out.')});
$('otp').addEventListener('keydown',e=>{if(e.key==='Enter')$('verifyCode').click()});
for(const id of ['sourceFile','participantName','picks','tiebreak','noticeType','noticeSubject']){
  $(id).addEventListener('input',invalidate);$(id).addEventListener('change',invalidate);
}
for(const id of ['season','week'])$(id).addEventListener('change',()=>{invalidate();published=null;$('weekDetails').textContent='';$('history').hidden=true;setBusy(false)});
$('confirm').addEventListener('change',()=>{$('publish').disabled=!session||!plan||!$('confirm').checked||busy});
// Compare PostgreSQL JSONB values by meaning, not property insertion order.
function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function exactCorrectionLanded(row,previous,expected){
  return !!row&&row.season===previous.season&&row.week===previous.week&&
    row.revision===previous.revision+1&&row.status==='locked'&&
    row.source_sha256===previous.source_sha256&&canonical(row.config)===canonical(expected);
}
async function readWeek(season,week){
  const {data,error}=await neon.from('nfl_pool_weeks').select('season,week,revision,status,config,source_sha256,updated_at').eq('season',season).eq('week',week);
  if(error)throw error;
  if(!Array.isArray(data)||data.length!==1)throw new Error('Expected exactly one published week; stop and verify the season/week.');
  return data[0];
}
function showHistory(){
  const history=Array.isArray(published?.config?.organizerCorrections)?published.config.organizerCorrections:[];
  $('history').hidden=history.length===0;
  $('history').replaceChildren();
  if(history.length){const heading=document.createElement('strong');heading.textContent=history.length+' organizer correction(s) recorded';$('history').append(heading);
    for(const c of history.slice(-5).reverse()){
      const p=document.createElement('p');p.textContent=`Revision ${c.priorRevision} → ${Number(c.priorRevision)+1} · ${c.entryId} · ${c.noticeSubject||c.sourceType||'Organizer notice'} · ${c.recordedAt||''}`;
      $('history').append(p);
    }
  }
}
$('loadWeek').addEventListener('click',async()=>{
  if(!session)return message('Sign in first.','error');
  const season=Number($('season').value),week=Number($('week').value);
  if(!Number.isInteger(season)||season<2020||season>2100||!Number.isInteger(week)||week<1||week>22)return message('Enter a valid NFL season and week.','error');
  invalidate();published=null;setBusy(true);message('');
  try{const row=await readWeek(season,week);if(row.status!=='locked'||row.config?.fullFieldReady!==true)throw new Error('This is not a locked, complete published week.');
    published=row;$('weekDetails').textContent=`Season ${season}, Week ${week} · revision ${row.revision} · ${row.config.competitionSize} entries · original source: ${row.config.source?.filename||'unavailable'}`;
    showHistory();message('Published week loaded. Choose its exact original source file, then enter the organizer correction.','success')}
  catch(e){message(e?.message||String(e),'error')}
  finally{setBusy(false)}
});
async function digest(file){const data=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return Array.from(new Uint8Array(data),b=>b.toString(16).padStart(2,'0')).join('')}
async function readSource(file){
  const ext=file.name.toLowerCase().split('.').pop();
  if(ext==='pdf'||file.type==='application/pdf'){
    const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    const pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
    const groups=[];
    for(let i=1;i<=pdf.numPages;i++){
      const page=await pdf.getPage(i),content=await page.getTextContent();
      const sourceRows=groupPdfTextItems(content.items).map(r=>({...r,kind:'pdf',pageNumber:i}));
      const lines=sourceRows.map(r=>r.text);
      groups.push({week:lines.map(detectWeek).find(Boolean)||null,lines,sourceRows,pageNumber:i,pageFingerprint:lines.join('\n').replace(/\s+/g,' ').trim().toLowerCase()});
    }
    return carryForwardWeekHints(groups);
  }
  if(!['xlsx','xls','xlsm'].includes(ext))throw new Error('Choose the original PDF, XLSX, XLS or XLSM file.');
  const XLSX=await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs');
  const wb=XLSX.read(await file.arrayBuffer(),{type:'array'}),groups=[];
  for(const sheetName of wb.SheetNames){
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{header:1,raw:false,defval:''});
    const sourceRows=rows.map((row,i)=>{const cells=row.map(v=>String(v).trim());return{kind:'spreadsheet',sheetName,rowNumber:i+1,cells,text:cells.filter(Boolean).join(' ')}}).filter(r=>r.text);
    const lines=sourceRows.map(r=>r.text);
    groups.push({week:detectWeek(sheetName)||lines.map(detectWeek).find(Boolean)||null,lines,sourceRows,sheetName});
  }
  return groups;
}
function showPlan(p){
  $('review').hidden=false;
  $('reviewSummary').textContent=`Published revision ${p.priorRevision} → ${p.priorRevision+1} · ${p.entryId} · ${p.changes.length} changed game pick(s) · no other entries affected`;
  $('changes').replaceChildren();
  for(const c of p.changes){
    const tr=document.createElement('tr');
    for(const s of [`Game ${c.gameIndex+1}: ${c.game.away} at ${c.game.home}`,String(c.before),String(c.after)]){const td=document.createElement('td');td.textContent=s;tr.append(td)}
    $('changes').append(tr);
  }
  $('tieChange').textContent=`Tiebreak: ${p.previousTiebreak===null?'blank':p.previousTiebreak} → ${p.correctedTiebreak}`;
  $('confirm').checked=false;$('publish').disabled=true;
}
$('preview').addEventListener('click',async()=>{
  if(!session||!published)return message('Sign in and load the published week first.','error');
  const file=$('sourceFile').files?.[0];if(!file)return message('Select the exact original organizer PDF or Excel file first.','error');
  const generation=++operation;plan=null;$('review').hidden=true;setBusy(true);message('');
  try{
    const sha=await digest(file);if(sha!==published.source_sha256)throw new Error('File fingerprint does not match the original published source. No correction was prepared.');
    const groups=await readSource(file);if(generation!==operation)throw new Error('Inputs changed; try again.');
    const parsed=parseDocumentGroups(groups,{filename:file.name,season:published.season,expectedCompetitionSize:published.config.competitionSize});
    let source=parsed.find(c=>c.week===published.week);if(!source)throw new Error('Original file did not contain the selected week.');
    if(pdfRecoveryApplies(groups.filter(g=>g.week===source.week),source)){
      const recovered=attemptPdfFieldRecovery(groups.filter(g=>g.week===source.week),source,published.config.competitionSize);
      if(!recovered.candidate)throw new Error('Source PDF recovery could not prove every participant row: '+(recovered.reason||'unknown reason'));
      source=recovered.candidate;
    }
    if(source.errors.length||source.fullFieldIssues.length||!source.config.fullFieldReady)
      throw new Error('Original sheet field validation failed. '+[...source.errors,...source.fullFieldIssues].join(' · '));
    const next=planOrganizerCorrection({published,source,digest:sha,participantName:$('participantName').value,
      picksText:$('picks').value,tiebreakText:$('tiebreak').value,sourceType:$('noticeType').value,noticeSubject:$('noticeSubject').value});
    if(generation!==operation)throw new Error('Inputs changed during validation; preview again.');
    plan=next;showPlan(plan);message('Correction validated. Review each changed game, then explicitly approve the new revision.','success');
  }catch(e){if(generation===operation){invalidate();message(e?.message||String(e),'error')}}
  finally{setBusy(false)}
});
$('publish').addEventListener('click',async()=>{
  if(busy||!session||!published||!plan||!$('confirm').checked)return;
  const approved=plan,previous=published,operationAtClick=operation;
  setBusy(true);message('');
  let attempted=false;
  try{
    const current=await readWeek(previous.season,previous.week);
    if(current.revision!==previous.revision||current.status!=='locked'||
       current.source_sha256!==previous.source_sha256||
       canonical(current.config)!==canonical(previous.config))
      throw new Error('This week changed after preview. No write attempted. Reload and preview again.');
    if(operation!==operationAtClick)throw new Error('Correction inputs changed. Preview again.');
    const timestamp=new Date().toISOString(),cfg=finalizeOrganizerCorrection(approved,previous,timestamp);
    const newRevision=previous.revision+1;
    const write={revision:newRevision,config:cfg,published_at:timestamp,locked_at:timestamp,updated_at:timestamp};
    attempted=true;
    const {data,error}=await neon.from('nfl_pool_weeks').update(write)
      .eq('season',previous.season).eq('week',previous.week).eq('revision',previous.revision)
      .eq('status','locked').eq('source_sha256',previous.source_sha256)
      .select('season,week,revision');
    if(error)throw error;
    if(!Array.isArray(data)||data.length!==1||data[0]?.revision!==newRevision)
      throw new Error('Correction write was not confirmed: the previous revision may have changed.');
    const verified=await readWeek(previous.season,previous.week);
    if(!exactCorrectionLanded(verified,previous,cfg))
      throw new Error('The complete updated week and correction history could not be verified by read-back.');
    published=verified;invalidate();showHistory();$('weekDetails').textContent=`Season ${verified.season}, Week ${verified.week} · revision ${verified.revision} · ${verified.config.competitionSize} entries`;
    message(`Official correction published and read-back verified as Week ${verified.week} revision ${newRevision}. Other entries were preserved.`,'success');
  }catch(e){
    if(attempted){
      try{const latest=await readWeek(previous.season,previous.week);
        if(exactCorrectionLanded(latest,previous,cfg)){
          published=latest;invalidate();showHistory();message('Correction did reach the database; confirmed by read-back. Reload the public week.','success');return;
        }
      }catch{}
      invalidate();message('Write result is not confirmed: '+(e?.message||e)+'. Do NOT retry without loading the latest week and validating again.','error');
    }else{invalidate();message(e?.message||String(e),'error')}
  }finally{setBusy(false)}
});
refreshSession().catch(e=>message('Could not check publisher sign-in: '+(e?.message||e),'error'));
