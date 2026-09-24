import {PLATFORM_CONFIG} from './platform-config.js';
import {PlatformClient} from './platform-client.js';
import {SUBMISSION_SOURCES} from './submission-core.js';
import {prepareCommissionerImport,summarizeBatchResults} from './import-core.js';

const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const poolSlug=params.get('pool')||PLATFORM_CONFIG.defaultPoolSlug,client=new PlatformClient(PLATFORM_CONFIG);
const state={session:null,context:null,season:null,week:null,pendingEmail:''};
function show(id,on=true){$(id).classList.toggle('hidden',!on)}
function msg(id,text){$(id).textContent=text;show(id,!!text)}
function syntheticContext(){
  const games=[{id:'g1',away:{key:'austin',label:'Austin'},home:{key:'denver',label:'Denver'}},{id:'g2',away:{key:'phoenix',label:'Phoenix'},home:{key:'seattle',label:'Seattle'}},{id:'g3',away:{key:'nashville',label:'Nashville'},home:{key:'baltimore',label:'Baltimore'}}];
  return{pool:{id:'demo-pool',slug:'demo-football-pool',display_name:'Neighborhood Pick’em',pool_type:'pickem'},seasons:[{id:'demo-season',season:2027,status:'active',config:{},entries:[
    {id:'11111111-1111-1111-1111-111111111111',entry_code:'E01',display_name:'Demo Entry 01',status:'active',claimed:true,submissions:[{week:3,source:'participant',status:'submitted',revision:1}]},
    {id:'22222222-2222-2222-2222-222222222222',entry_code:'E02',display_name:'Demo Entry 02',status:'active',claimed:false,submissions:[]},
    {id:'33333333-3333-3333-3333-333333333333',entry_code:'E03',display_name:'Demo Entry 03',status:'active',claimed:true,submissions:[]}
  ],weeks:[{id:'demo-week',week:3,status:'open',deadline_at:new Date(Date.now()+86400000).toISOString(),config:{games,tiebreakRequired:true}}]}]};
}
function setAuth(){show('authCard',client.live&&!state.session);show('signOut',client.live&&!!state.session)}
async function load(){state.context=client.live?await client.commissionerContext(poolSlug):syntheticContext();renderConsole()}
$('sendCode').addEventListener('click',async()=>{msg('authError','');try{state.pendingEmail=await client.sendOtp($('email').value);show('otpWrap',true);$('otp').focus()}catch(e){msg('authError',e.message)}});
$('verifyCode').addEventListener('click',async()=>{msg('authError','');try{state.session=await client.verifyOtp(state.pendingEmail||$('email').value,$('otp').value);setAuth();await load()}catch(e){msg('authError',e.message)}});
$('signOut').addEventListener('click',async()=>{await client.signOut();state.session=null;state.context=null;['consoleCard','entriesCard','inviteCard','importCard'].forEach(id=>show(id,false));setAuth()});
function currentSubmission(entry){return(entry.submissions||[]).find(x=>x.week===state.week?.week)||null}
function renderConsole(){
  const c=state.context;if(!c)return;$('poolName').textContent=c.pool.display_name;['consoleCard','entriesCard','inviteCard','importCard'].forEach(id=>show(id,true));
  const seasons=c.seasons||[];$('seasonSelect').innerHTML=seasons.map(s=>`<option value="${s.id}">${s.season}</option>`).join('');state.season=seasons[0]||null;
  $('seasonSelect').onchange=()=>{state.season=seasons.find(s=>s.id===$('seasonSelect').value)||seasons[0];renderWeeks()};renderWeeks();
}
function renderWeeks(){
  const weeks=state.season?.weeks||[];$('weekSelect').innerHTML=weeks.map(w=>`<option value="${w.id}">Week ${w.week} · ${w.status}</option>`).join('');
  state.week=weeks.find(w=>w.status==='open')||weeks[weeks.length-1]||null;if(state.week)$('weekSelect').value=state.week.id;
  $('weekSelect').onchange=()=>{state.week=weeks.find(w=>w.id===$('weekSelect').value)||state.week;renderEntries()};renderEntries();
}
function renderEntries(){
  const entries=state.season?.entries||[];$('entriesBody').innerHTML=entries.map(e=>{const sub=currentSubmission(e),source=sub?.source||'—';return`<tr><td><strong>${esc(e.entry_code)}</strong><small>${esc(e.display_name)}</small></td><td>${e.claimed?'Yes':'No'}</td><td>${esc(source)}</td></tr>`}).join('');
  $('inviteEntry').innerHTML=entries.map(e=>`<option value="${e.id}">${esc(e.entry_code)} · ${esc(e.display_name)}</option>`).join('');
  const gameIds=(state.week?.config?.games||[]).map((g,i)=>g.id||`g${i+1}`);
  $('importHelp').textContent=state.context.pool.pool_type==='survivor'?'CSV headers: entry_code,team':`CSV headers: entry_code,${gameIds.join(',')}${state.week?.config?.tiebreakRequired?',tiebreak':''}. Pick values may use away/home or the displayed city/team label.`;
  $('importText').placeholder=state.context.pool.pool_type==='survivor'?'entry_code,team\nE02,Miami':`entry_code,${gameIds.join(',')},tiebreak\nE02,${gameIds.map((_,i)=>i%2?'home':'away').join(',')},47`;
}
$('createInvite').addEventListener('click',async()=>{
  msg('inviteResult','');msg('importError','');
  try{
    const entryId=$('inviteEntry').value,email=$('inviteEmail').value.trim()||null;
    const result=client.live?await client.createInvite({entryId,email,expiresHours:168}):{invite_token:'a'.repeat(64),entry_id:entryId,expires_at:new Date(Date.now()+7*86400000).toISOString()};
    const url=new URL('./participant.html',location.href);url.searchParams.set('pool',state.context.pool.slug);url.searchParams.set('invite',result.invite_token);
    msg('inviteResult',`Invite ready: ${url.href} · expires ${new Date(result.expires_at).toLocaleString()}`);
  }catch(e){msg('importError',e.message)}
});
$('sampleImport').addEventListener('click',()=>{
  const entries=state.season?.entries||[],codes=entries.slice(0,3).map(e=>e.entry_code);
  if(state.context.pool.pool_type==='survivor')$('importText').value=`entry_code,team\n${codes[0]||'E01'},Miami\n${codes[1]||'E02'},Denver`;
  else{
    const ids=(state.week?.config?.games||[]).map((g,i)=>g.id||`g${i+1}`);
    $('importText').value=`entry_code,${ids.join(',')},tiebreak\n${codes[0]||'E01'},${ids.map((_,i)=>i%2?'home':'away').join(',')},47\n${codes[1]||'E02'},${ids.map((_,i)=>i%2?'away':'home').join(',')},44`;
  }
});
$('runImport').addEventListener('click',async()=>{
  msg('importError','');msg('importResult','');show('resultTableWrap',false);
  try{
    if(!state.week)throw new Error('Choose a week.');
    const prepared=prepareCommissionerImport({text:$('importText').value,poolType:state.context.pool.pool_type,entries:state.season.entries,weekConfig:state.week.config});
    if(prepared.errors.length)throw new Error(`Import validation found ${prepared.errors.length} row error(s). Fix them before submission.`);
    let results;
    if(client.live)results=await client.submitBatch({weekId:state.week.id,source:SUBMISSION_SOURCES.COMMISSIONER_IMPORT,items:prepared.items});
    else{
      const byId=new Map(state.season.entries.map(e=>[e.id,e]));
      results=prepared.items.map(item=>{const e=byId.get(item.entry_id),sub=currentSubmission(e);if(sub&&sub.source==='participant')return{entry_id:e.id,ok:false,code:'source_conflict:participant'};if(sub&&sub.source!=='commissioner_import')return{entry_id:e.id,ok:false,code:`source_conflict:${sub.source}`};e.submissions=(e.submissions||[]).filter(x=>x.week!==state.week.week);e.submissions.push({week:state.week.week,source:'commissioner_import',status:'submitted',revision:(sub?.revision||0)+1});return{entry_id:e.id,ok:true,result:{code:sub?'updated':'created'}}});
    }
    const summary=summarizeBatchResults(results);msg('importResult',`${summary.submitted} submitted · ${summary.conflicts} source conflict(s) · ${summary.errors} other error(s). Participant submissions were not overwritten.`);
    $('resultBody').innerHTML=results.map(r=>{const entry=state.season.entries.find(e=>e.id===r.entry_id),label=entry?.entry_code||r.entry_id,value=r.ok?(r.result?.code||'submitted'):r.code;return`<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`}).join('');show('resultTableWrap',true);renderEntries();if(client.live)await load();
  }catch(e){msg('importError',e.message)}
});
async function initialize(){await client.init();$('modePill').textContent=client.live?'LIVE · secure':'SANDBOX · synthetic';if(client.live){state.session=await client.getSession();setAuth();if(state.session)await load()}else{setAuth();await load()}}
initialize().catch(e=>msg('authError',e.message));
if('serviceWorker' in navigator){navigator.serviceWorker.register('./service-worker.js').catch(()=>{})}
