'use strict';
import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';
import {groupSurvivorPdfTextItems,parseSurvivorPages,validateSurvivorConfig} from './survivor-parser.js?v=1';

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ADMIN_EMAIL='djsmokke@gmail.com',neon=createClient({auth:{url:NEON_AUTH_URL},dataApi:{url:NEON_DATA_URL}});
const $=id=>document.getElementById(id);let session=null,currentFile=null,candidate=null,busy=false;
const now=new Date(),DEFAULT_SEASON=now.getUTCMonth()<2?now.getUTCFullYear()-1:now.getUTCFullYear();

function msg(text,type='info'){$('message').className=`notice ${type}`;$('message').textContent=text;$('message').hidden=!text}
function setBusy(on,text='Working…'){busy=on;$('busy').hidden=!on;$('busyText').textContent=text;$('parseBtn').disabled=on||!currentFile;$('publishBtn').disabled=on||!session||!candidate;$('file').disabled=on;$('season').disabled=on;$('replaceLocked').disabled=on}
function selectedSeason(){const n=Number($('season').value);if(!Number.isInteger(n)||n<2020||n>2100)throw new Error('Season must be between 2020 and 2100');return n}
function renderAuth(){const signed=!!session;$('signedOut').hidden=signed;$('signedIn').hidden=!signed;$('signedEmail').textContent=signed?session.user.email:'';$('authState').textContent=signed?'AUTHORIZED':'SIGN IN REQUIRED';$('authState').className=`pill ${signed?'ok':'warn'}`;$('publishBtn').disabled=busy||!signed||!candidate}
async function refreshSession(){const r=await neon.auth.getSession(),u=r?.data?.user,s=r?.data?.session;session=s&&u?{session:s,user:u}:null;if(session&&u.email?.toLowerCase()!==ADMIN_EMAIL){await neon.auth.signOut();session=null}renderAuth()}
$('sendCode').onclick=async()=>{setBusy(true,'Sending sign-in code…');try{const r=await neon.auth.signIn.email({email:ADMIN_EMAIL});if(r?.error)throw r.error;$('otpWrap').hidden=false;msg('Sign-in code sent.','success')}catch(e){msg(e.message||String(e),'error')}finally{setBusy(false)}};
$('verifyCode').onclick=async()=>{setBusy(true,'Verifying…');try{const code=$('otp').value.trim();const r=await neon.auth.signIn.emailOtp({email:ADMIN_EMAIL,otp:code});if(r?.error)throw r.error;await refreshSession();msg('Signed in.','success')}catch(e){msg(e.message||String(e),'error')}finally{setBusy(false)}};
$('signOut').onclick=async()=>{await neon.auth.signOut();session=null;renderAuth()};

function setFile(file){currentFile=file||null;candidate=null;$('review').hidden=true;$('publishResult').hidden=true;$('fileName').textContent=file?`${file.name} · ${(file.size/1024).toFixed(0)} KB`:'No file selected';$('parseBtn').disabled=!file}
$('file').addEventListener('change',e=>setFile(e.target.files?.[0]||null));['dragenter','dragover'].forEach(type=>$('drop').addEventListener(type,e=>{e.preventDefault();$('drop').classList.add('over')}));['dragleave','drop'].forEach(type=>$('drop').addEventListener(type,e=>{e.preventDefault();$('drop').classList.remove('over')}));$('drop').addEventListener('drop',e=>setFile(e.dataTransfer?.files?.[0]||null));

async function pdfPages(file){const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';const data=new Uint8Array(await file.arrayBuffer()),pdf=await pdfjs.getDocument({data}).promise,pages=[];for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),content=await page.getTextContent(),rows=groupSurvivorPdfTextItems(content.items);pages.push({pageNumber:n,rows})}return pages}
async function sha256(file){const bytes=await file.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);return[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')}

function renderCandidate(){
  const c=candidate.config;$('review').hidden=false;$('reviewTitle').textContent=`${c.season} · Week ${c.week} · ${c.competitionSize} entries · ${c.currentWeekEntryCount} with Week ${c.week} pick`;
  $('validation').innerHTML='<span class="check">✓ Three tracked Survivor entries found</span><span class="check">✓ Anonymous field privacy enforced</span><span class="check">✓ Week columns validated</span><span class="check">✓ '+c.competitionSize+' total entries</span>';
  $('entryReview').innerHTML=c.trackedEntries.map(p=>`<tr><td><b>${p.displayName}</b></td><td class="nums">${p.picks.map((x,i)=>`W${i+1} ${x||'—'}`).join(' · ')}</td><td>${p.picks[c.week-1]||'NO PICK'}</td></tr>`).join('');
  $('publishBtn').disabled=!session;
}

$('parseBtn').onclick=async()=>{if(!currentFile)return;setBusy(true,'Reading Survivor PDF…');msg('');try{const pages=await pdfPages(currentFile),result=parseSurvivorPages(pages,{season:selectedSeason(),filename:currentFile.name});if(result.errors.length)throw new Error(result.errors.join(' · '));const errs=validateSurvivorConfig(result.config);if(errs.length)throw new Error(errs.join(' · '));candidate=result;renderCandidate();msg(`Survivor Week ${result.config.week} parsed: ${result.config.competitionSize} entries, ${result.config.currentWeekEntryCount} with a current-week pick. Review before publishing.`,'success')}catch(e){candidate=null;$('review').hidden=true;msg(e.message||String(e),'error')}finally{setBusy(false)}};

$('publishBtn').onclick=async()=>{if(!session||!candidate||!currentFile)return;setBusy(true,'Publishing Survivor week…');msg('');try{const cfg=structuredClone(candidate.config),errors=validateSurvivorConfig(cfg);if(errors.length)throw new Error(errors.join(' · '));const {data:rows,error:readError}=await neon.from('nfl_survivor_weeks').select('season,week,status,revision').eq('season',cfg.season).eq('week',cfg.week).limit(1);if(readError)throw readError;const existing=rows?.[0]||null;if(existing?.status==='locked'&&!$('replaceLocked').checked)throw new Error(`Survivor Week ${cfg.week} is already locked. Check replace only for an intentional correction.`);const digest=await sha256(currentFile),ts=new Date().toISOString(),revision=(existing?.revision||0)+1;cfg.source={kind:'survivor-upload',filename:currentFile.name,sha256:digest};const row={season:cfg.season,week:cfg.week,status:'locked',config:cfg,source_filename:currentFile.name,source_sha256:digest,revision,published_at:ts,locked_at:ts,updated_at:ts};const write=existing?await neon.from('nfl_survivor_weeks').update(row).eq('season',cfg.season).eq('week',cfg.week).select('season,week,revision'):await neon.from('nfl_survivor_weeks').insert(row).select('season,week,revision');if(write.error)throw write.error;$('publishResult').hidden=false;$('replaceLocked').checked=false;msg(`Survivor Week ${cfg.week} published and locked. Revision ${revision}.`,'success')}catch(e){msg(e.message||String(e),'error')}finally{setBusy(false)}};

$('season').value=DEFAULT_SEASON;refreshSession();
