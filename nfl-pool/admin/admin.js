import {createClient} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import {TARGETS,detectWeek,groupPdfTextItems,parseDocumentGroups,chooseBestCandidate,validateConfig} from './parser-core.js?v=1';

const SUPABASE_URL='https://txbrowtmemwldywdpgiy.supabase.co';
const SUPABASE_KEY='sb_publishable_oJ-Cg1WcikC1Wio70Ek_Dw_dKvJpgMd';
const SCORE_URL=`${SUPABASE_URL}/functions/v1/nfl-pool-scores-v2`;
const ADMIN_EMAIL='djsmokke@gmail.com';
const SEASON=2026;
const supabase=createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,detectSessionInUrl:true,autoRefreshToken:true}});

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=x=>({JAC:'JAX',WSH:'WAS'}[x]||x);
let session=null,currentFile=null,candidates=[],candidate=null,scheduleVerified=false;

function message(text,type='info'){$('message').className=`notice ${type}`;$('message').textContent=text;$('message').hidden=!text}
function setBusy(on,text='Working…'){$('busy').hidden=!on;$('busyText').textContent=text;$('parseBtn').disabled=on;$('publishBtn').disabled=on||!candidate||!scheduleVerified||!session}

async function refreshSession(){const {data:{session:s}}=await supabase.auth.getSession();session=s;if(session&&session.user?.email?.toLowerCase()!==ADMIN_EMAIL){await supabase.auth.signOut();session=null}renderAuth()}
function renderAuth(){const signed=!!session;$('signedOut').hidden=signed;$('signedIn').hidden=!signed;$('signedEmail').textContent=signed?session.user.email:'';$('publishBtn').disabled=!signed||!candidate||!scheduleVerified;$('authState').textContent=signed?'AUTHORIZED':'SIGN IN REQUIRED';$('authState').className=`pill ${signed?'ok':'warn'}`}

$('sendLink').addEventListener('click',async()=>{
  $('sendLink').disabled=true;message('');
  const redirect=new URL('./',location.href).href.split('#')[0].split('?')[0];
  const {error}=await supabase.auth.signInWithOtp({email:ADMIN_EMAIL,options:{emailRedirectTo:redirect,shouldCreateUser:true}});
  $('sendLink').disabled=false;
  if(error){message(`Could not send sign-in link: ${error.message}`,'error');return}
  message(`Magic sign-in link sent to ${ADMIN_EMAIL}. Open it on this device, then return here.`,'success');
});
$('signOut').addEventListener('click',async()=>{await supabase.auth.signOut();session=null;renderAuth();message('Signed out.','info')});
supabase.auth.onAuthStateChange((_event,s)=>{session=s;if(session?.user?.email?.toLowerCase()!==ADMIN_EMAIL)session=null;renderAuth()});

$('file').addEventListener('change',()=>{currentFile=$('file').files?.[0]||null;$('fileName').textContent=currentFile?`${currentFile.name} · ${(currentFile.size/1024).toFixed(0)} KB`:'No file selected';$('parseBtn').disabled=!currentFile});
$('drop').addEventListener('dragover',e=>{e.preventDefault();$('drop').classList.add('over')});
$('drop').addEventListener('dragleave',()=>$('drop').classList.remove('over'));
$('drop').addEventListener('drop',e=>{e.preventDefault();$('drop').classList.remove('over');const f=e.dataTransfer.files?.[0];if(f){currentFile=f;$('fileName').textContent=`${f.name} · ${(f.size/1024).toFixed(0)} KB`;$('parseBtn').disabled=false}});

async function pdfGroups(file){
  const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const data=new Uint8Array(await file.arrayBuffer()),pdf=await pdfjs.getDocument({data}).promise,groups=[];
  for(let n=1;n<=pdf.numPages;n++){
    setBusy(true,`Reading PDF page ${n} of ${pdf.numPages}…`);
    const page=await pdf.getPage(n),content=await page.getTextContent(),lines=groupPdfTextItems(content.items),week=lines.map(detectWeek).find(Boolean)||null;
    groups.push({week,lines});
  }
  return groups;
}
async function spreadsheetGroups(file){
  const XLSX=await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs');
  const wb=XLSX.read(await file.arrayBuffer(),{type:'array'}),groups=[];
  for(const sheetName of wb.SheetNames){const ws=wb.Sheets[sheetName],rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''}),lines=rows.map(row=>row.map(v=>String(v).trim()).filter(Boolean).join(' ')).filter(Boolean),week=detectWeek(sheetName)||lines.map(detectWeek).find(Boolean)||null;groups.push({week,lines})}
  return groups;
}
async function fileGroups(file){const ext=file.name.toLowerCase().split('.').pop();if(ext==='pdf'||file.type==='application/pdf')return pdfGroups(file);if(['xlsx','xls','xlsm'].includes(ext))return spreadsheetGroups(file);throw new Error('Use a PDF, XLSX, XLS, or XLSM weekly sheet.')}

$('parseBtn').addEventListener('click',async()=>{
  if(!currentFile)return;setBusy(true,'Reading weekly sheet…');message('');scheduleVerified=false;candidate=null;candidates=[];$('review').hidden=true;
  try{
    const groups=await fileGroups(currentFile);candidates=parseDocumentGroups(groups,{filename:currentFile.name,season:SEASON});
    const valid=candidates.filter(c=>!c.errors.length&&c.config.participants.length===TARGETS.length);
    if(!valid.length){const details=candidates.map(c=>`Week ${c.week}: ${c.errors.join('; ')||'not all tracked entries found'}`).join(' | ');throw new Error(`No complete tracked week was found. ${details}`)}
    candidate=chooseBestCandidate(candidates);renderCandidateSelector(valid);await prepareCandidate(candidate);message(`Week ${candidate.week} parsed and matched to the NFL schedule. Review it before publishing.`,'success');
  }catch(e){message(e.message||String(e),'error');candidate=null;scheduleVerified=false;$('review').hidden=true}
  finally{setBusy(false)}
});

function renderCandidateSelector(valid){const sel=$('detectedWeek');sel.innerHTML=valid.map(c=>`<option value="${c.week}">Week ${c.week} · ${c.gameCount} games</option>`).join('');sel.value=String(candidate.week);$('weekChoice').hidden=valid.length<2;sel.onchange=async()=>{candidate=valid.find(c=>c.week===Number(sel.value));setBusy(true,'Checking NFL schedule…');try{await prepareCandidate(candidate);message(`Week ${candidate.week} selected and verified.`,'success')}catch(e){scheduleVerified=false;renderReview();message(e.message,'error')}finally{setBusy(false)}}}

function eventPair(event){const cs=event?.competitions?.[0]?.competitors||[],a=cs.find(x=>x.homeAway==='away'),h=cs.find(x=>x.homeAway==='home');return{away:norm(a?.team?.abbreviation),home:norm(h?.team?.abbreviation)}}
async function verifySchedule(config){
  const r=await fetch(`${SCORE_URL}?season=${config.season}&week=${config.week}&t=${Date.now()}`,{cache:'no-store'});if(!r.ok)throw new Error(`NFL schedule feed returned ${r.status}`);const j=await r.json();if(!Array.isArray(j.events)||!j.events.length)throw new Error('NFL schedule feed returned no games.');
  const games=config.games.map((g,i)=>{const matches=j.events.filter(e=>{const p=eventPair(e);return p.away===norm(g.away)&&p.home===norm(g.home)});if(matches.length!==1)throw new Error(`Schedule mismatch for ${g.away} at ${g.home}. Found ${matches.length} matching NFL games.`);const e=matches[0];return{...g,index:i,eventId:String(e.id||''),date:String(e.date||'').slice(0,10)}});
  if(j.events.length<games.length)throw new Error(`NFL feed has ${j.events.length} games but the sheet has ${games.length}.`);
  return{...config,games};
}
async function prepareCandidate(c){let cfg=structuredClone(c.config);const localErrors=validateConfig(cfg);if(localErrors.length)throw new Error(localErrors.join(' · '));cfg=await verifySchedule(cfg);c.config=cfg;scheduleVerified=true;renderReview()}

function renderReview(){
  if(!candidate)return;$('review').hidden=false;const cfg=candidate.config;$('reviewTitle').textContent=`Week ${cfg.week} · ${cfg.games.length} games`;
  $('gameReview').innerHTML=cfg.games.map((g,i)=>`<tr><td>${i+1}</td><td><b>${g.awayNumber}</b> ${esc(g.awayName||g.away)}</td><td>at</td><td><b>${g.homeNumber}</b> ${esc(g.homeName||g.home)}</td><td>${esc(g.date||'—')}</td></tr>`).join('');
  $('entryReview').innerHTML=cfg.participants.map(p=>`<tr><td>${esc(p.displayName)}</td><td class="nums">${p.pickNumbers.join(' ')}</td><td><b>${p.tiebreak}</b></td></tr>`).join('');
  const tb=$('tiebreakGame');tb.innerHTML=cfg.games.map((g,i)=>`<option value="${i}">${i+1}. ${g.away} at ${g.home}</option>`).join('');tb.value=String(cfg.tiebreakGameIndex);tb.onchange=()=>{cfg.tiebreakGameIndex=Number(tb.value)};
  $('validation').innerHTML=scheduleVerified?'<span class="check">✓ Numeric picks valid</span><span class="check">✓ Four tracked entries found</span><span class="check">✓ NFL schedule matched</span>':'<span class="bad">Schedule verification required</span>';
  $('publishBtn').disabled=!session||!scheduleVerified;
}

async function sha256(file){const buf=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('')}
$('publishBtn').addEventListener('click',async()=>{
  if(!session||session.user?.email?.toLowerCase()!==ADMIN_EMAIL){message('Sign in before publishing.','error');return}if(!candidate||!scheduleVerified||!currentFile)return;
  const cfg=structuredClone(candidate.config),errors=validateConfig(cfg);if(errors.length){message(errors.join(' · '),'error');return}
  setBusy(true,'Publishing and locking week…');message('');
  try{
    const {data:existing,error:readError}=await supabase.from('nfl_pool_weeks').select('season,week,status,revision').eq('season',cfg.season).eq('week',cfg.week).maybeSingle();if(readError)throw readError;
    if(existing?.status==='locked'&&!$('replaceLocked').checked)throw new Error(`Week ${cfg.week} is already locked. Check “replace locked week” only if you intentionally need to correct it.`);
    const now=new Date().toISOString(),digest=await sha256(currentFile),revision=(existing?.revision||0)+1;
    cfg.source={kind:'weekly-upload',filename:currentFile.name,sha256:digest};
    const row={season:cfg.season,week:cfg.week,status:'locked',config:cfg,source_filename:currentFile.name,source_sha256:digest,revision,published_at:now,locked_at:now,updated_at:now};
    const {error}=await supabase.from('nfl_pool_weeks').upsert(row,{onConflict:'season,week'});if(error)throw error;
    message(`Week ${cfg.week} published and locked successfully. Revision ${revision}.`,'success');$('publishResult').hidden=false;$('trackerLink').href=`../?season=${cfg.season}&week=${cfg.week}`;$('replaceLocked').checked=false;
  }catch(e){message(e.message||String(e),'error')}
  finally{setBusy(false)}
});

refreshSession();
