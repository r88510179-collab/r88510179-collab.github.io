// QA ONLY — final Personal Pool browser E2E (2026-11-06). Drives the unmodified current-main pages served by qa-serve.mjs
// (only the counted endpoint/identity substitutions differ) in Playwright Chromium against the isolated QA child
// br-damp-credit-bbn7d0zr. Real file inputs, real clicks, the page's own Neon Auth email-code sign-in, real Data API calls.
//
// Safety: every context runs behind a fail-closed network allowlist (this harness origin, the QA child's Neon Auth and Data
// API, and GET-only public CDNs). Any request to a production or QA-parent host is aborted and recorded as a violation; any
// other host is aborted and recorded as refused. Service workers are blocked so every read is fresh. No credential, token,
// cookie or sign-in code is written to the evidence folder: the code hand-off file and the auth storage state live only in
// $QA_SCRATCH (outside the repository) and are deleted at the end.
//
// Usage: QA_SCRATCH=<dir outside repo> node e2e.cjs <scenario...>
//   smoke, negatives, tracker, readback  — need no publisher session (run 2026-11-06, see REPORT.md)
//   week5                                 — read-only check of the QA W5 r3 / Survivor W8 r3 rows published later
//                                           (QA_PASSWORD_E2E_CLOSEOUT.md); needs NODE_USE_ENV_PROXY=1 for ESPN
//   pickem, survivor                      — need an authorized QA publisher session: BLOCKED on 2026-11-06 at sign-in
//   cleanup                               — removes the auth storage state from $QA_SCRATCH
// Optional: QA_ONLY_STEPS=T04,T06 reruns only those steps; QA_SHOT_TAG names a tagged rerun's log and stale screenshot.
'use strict';
const {chromium}=require('playwright');
const fs=require('fs'),path=require('path'),crypto=require('crypto');

const ORIGIN='http://localhost:8765',BASE=`${ORIGIN}/nfl-pool/`;
const EVID=path.resolve(__dirname,'..'),FIX=path.join(EVID,'fixtures'),SHOTS=path.join(EVID,'screenshots'),LOGS=path.join(EVID,'logs');
const SCRATCH=process.env.QA_SCRATCH;
if(!SCRATCH||path.resolve(SCRATCH).startsWith(path.resolve(EVID,'../../..')))throw new Error('QA_SCRATCH must be a directory outside the repository');
const STATE=path.join(SCRATCH,'publisher-auth-state.json');
const QA_AUTH_HOST='ep-shiny-snow-bbx446zt.neonauth.c-15.us-east-1.aws.neon.tech';
const QA_DATA_HOST='ep-shiny-snow-bbx446zt.apirest.c-15.us-east-1.aws.neon.tech';
const QA_AUTH=`https://${QA_AUTH_HOST}/nfl_pool/auth`,QA_DATA=`https://${QA_DATA_HOST}/nfl_pool/rest/v1`;
const PUBLISHER='qa.pdf-e2e.publisher@example.com';
const FORBIDDEN_HOST=[/ep-muddy-forest-au7eygkw/i,/ep-silent-sunset-bbdqbm47/i,/nflscores2/i,/(^|\.)r88510179-collab\.github\.io$/i,/(^|\.)smokkeventures\.com$/i,/(^|\.)supabase\.co$/i,/(^|\.)netlify\.app$/i,/(^|\.)vercel\.app$/i];
const GET_HOSTS=new Set(['cdn.jsdelivr.net','a.espncdn.com']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha256=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ------------------------------------------------------------------------------------------------ recording + guard
function recorder(name){return{scenario:name,startedAt:new Date().toISOString(),browser:null,steps:[],writes:[],network:[],violations:[],refused:[],console:[],pageErrors:[]}}
const SAFE_Q=new Set(['select','season','week','status','order','revision','contest_id','chain_seq','dates','seasontype','limit']);
function redact(u){
  if(u.hostname===QA_AUTH_HOST)return u.origin+u.pathname;                       // never keep auth query strings
  const q=[...u.searchParams.keys()].map(k=>`${k}=${SAFE_Q.has(k)?u.searchParams.get(k):'…'}`).join('&');
  return u.origin+u.pathname+(q?`?${q}`:'');
}
async function newContext(browser,rec,opts={}){
  const context=await browser.newContext({serviceWorkers:'block',...opts});
  await context.route('**/*',async route=>{
    const req=route.request();let u;try{u=new URL(req.url())}catch{return route.abort()}
    const e={t:new Date().toISOString(),method:req.method(),url:redact(u),type:req.resourceType()};
    if(FORBIDDEN_HOST.some(r=>r.test(u.hostname))){rec.violations.push(e);return route.abort('blockedbyclient')}
    if(u.origin===ORIGIN)return route.continue();
    if(u.protocol==='https:'&&u.hostname===QA_AUTH_HOST&&u.pathname.startsWith('/nfl_pool/auth/'))return route.continue();
    if(u.protocol==='https:'&&u.hostname===QA_DATA_HOST&&u.pathname.startsWith('/nfl_pool/rest/v1/'))return route.continue();
    if(u.protocol==='https:'&&GET_HOSTS.has(u.hostname)&&(req.method()==='GET'||req.method()==='HEAD'))return route.continue();
    rec.refused.push(e);return route.abort('blockedbyclient');
  });
  context.on('requestfinished',async req=>{
    let u;try{u=new URL(req.url())}catch{return}
    const res=await req.response().catch(()=>null),entry={t:new Date().toISOString(),method:req.method(),url:redact(u),status:res?res.status():null};
    rec.network.push(entry);
    if(u.hostname===QA_DATA_HOST&&!['GET','HEAD','OPTIONS'].includes(req.method()))rec.writes.push(entry);
  });
  context.on('requestfailed',req=>{let u;try{u=new URL(req.url())}catch{return}rec.network.push({t:new Date().toISOString(),method:req.method(),url:redact(u),failed:req.failure()?.errorText||'failed'})});
  context.on('page',page=>watchPage(page,rec));
  return context;
}
function watchPage(page,rec){
  page.on('console',m=>rec.console.push({t:new Date().toISOString(),page:pageName(page),type:m.type(),text:m.text().slice(0,400)}));
  page.on('pageerror',e=>rec.pageErrors.push({t:new Date().toISOString(),page:pageName(page),text:String(e?.message||e).slice(0,400)}));
}
const pageName=page=>{try{const u=new URL(page.url());return u.pathname+u.search}catch{return'?'}};
// QA_ONLY_STEPS=T04,T06 reruns just those steps (saved as a separate *-rerun log; the full run's log is kept).
const ONLY=(process.env.QA_ONLY_STEPS||'').split(',').map(x=>x.trim()).filter(Boolean);
async function step(rec,id,title,fn,{fatal=false}={}){
  if(ONLY.length&&!ONLY.includes(id))return{id,skipped:true};
  const s={id,title,start:new Date().toISOString()};
  try{const r=await fn();s.result='PASS';if(r!==undefined)s.evidence=r}
  catch(e){s.result='FAIL';s.error=String(e?.message||e).slice(0,1500)}
  s.end=new Date().toISOString();rec.steps.push(s);
  console.log(`${s.result} ${id} ${title}${s.error?` :: ${s.error}`:''}`);
  if(fatal&&s.result!=='PASS')throw new Error(`fatal step ${id} failed`);
  return s;
}
function expect(cond,msg){if(!cond)throw new Error(msg)}
function save(rec){
  rec.finishedAt=new Date().toISOString();
  rec.summary={steps:rec.steps.length,pass:rec.steps.filter(s=>s.result==='PASS').length,fail:rec.steps.filter(s=>s.result!=='PASS').length,writes:rec.writes.length,violations:rec.violations.length,refused:rec.refused.length,pageErrors:rec.pageErrors.length,consoleErrors:rec.console.filter(c=>c.type==='error').length,consoleWarnings:rec.console.filter(c=>c.type==='warning').length};
  const text=JSON.stringify(rec,null,1);
  if(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text))throw new Error('refusing to save a log that contains a JWT-shaped string');
  const file=`e2e-${rec.scenario}${ONLY.length?`-rerun-${ONLY.join('_')}`:''}${process.env.QA_SHOT_TAG?`-${process.env.QA_SHOT_TAG}`:''}.json`;
  fs.writeFileSync(path.join(LOGS,file),text);
  console.log(`saved logs/${file}`,JSON.stringify(rec.summary));
  // Evidence is always saved, but a failed step or a blocked/forbidden request must never let the run exit green.
  if(rec.summary.fail||rec.summary.violations||rec.summary.refused)process.exitCode=1;
}
const shot=(page,name,opts={})=>page.screenshot({path:path.join(SHOTS,`${name}.jpg`),type:'jpeg',quality:72,fullPage:true,...opts}).then(()=>`screenshots/${name}.jpg`);

// --------------------------------------------------------------------------------------------- sign-in code hand-off
// The page sends its normal email sign-in code; a person who can receive that code for the authorized QA publisher
// identity drops it into $QA_SCRATCH/otp-<label>.txt (never into the repository). Nothing about the code is logged.
// 2026-11-06 run: BLOCKED. The synthetic QA publisher's reserved example.com address has no mailbox and Neon Auth stores
// codes hashed, so no code can be supplied; the publish scenarios stop at the sign-in step (see REPORT.md).
async function waitForCode(label){
  const file=path.join(SCRATCH,`otp-${label}.txt`);
  console.log(`OTP_REQUESTED ${label} ${new Date().toISOString()}`);
  for(let i=0;i<540;i++){
    if(fs.existsSync(file)){const v=fs.readFileSync(file,'utf8').trim();fs.unlinkSync(file);if(!/^\d{4,10}$/.test(v))throw new Error('code file is not numeric');return v}
    await sleep(1000);
  }
  throw new Error('no sign-in code was provided within 9 minutes');
}
async function adminText(page){
  return page.evaluate(()=>{const $=id=>document.getElementById(id);return{authState:$('authState')?.textContent,message:$('message')?.hidden?'':$('message')?.textContent,messageClass:$('message')?.className,reviewHidden:$('review')?.hidden,reviewTitle:$('reviewTitle')?.textContent,publishDisabled:$('publishBtn')?.disabled,validation:$('validation')?.innerText}});
}
async function waitIdle(page,timeout=90000){
  await page.waitForFunction(()=>{const b=document.getElementById('busy');const m=document.getElementById('message');return b&&b.hidden===true&&m&&!m.hidden&&m.textContent.trim().length>0},null,{timeout});
}
async function signIn(page,rec,id,label){
  return step(rec,id,`Email-code sign-in of the synthetic publisher (${label})`,async()=>{
    await page.waitForFunction(()=>document.getElementById('authState')?.textContent==='SIGN IN REQUIRED',null,{timeout:30000});
    const shown=await page.evaluate(()=>document.querySelector('#signedOut .muted')?.textContent);
    expect(shown===PUBLISHER,`page names ${shown} as the authorized email`);
    await page.click('#sendCode');
    await page.waitForFunction(e=>document.getElementById('message')?.textContent?.includes(`Sign-in code sent to ${e}`),PUBLISHER,{timeout:30000});
    const code=await waitForCode(label);
    await page.fill('#otp',code);
    await page.click('#verifyCode');
    await page.waitForFunction(()=>document.getElementById('authState')?.textContent==='AUTHORIZED',null,{timeout:60000});
    const signed=await page.evaluate(()=>({email:document.getElementById('signedEmail')?.textContent,otpCleared:document.getElementById('otp')?.value==='',message:document.getElementById('message')?.textContent}));
    expect(signed.email===PUBLISHER,`signed in as ${signed.email}`);
    expect(signed.otpCleared,'code field not cleared');
    return{displayedAuthorizedEmail:shown,...signed};
  },{fatal:true});
}

// ------------------------------------------------------------------------------------------------- Pick'em publisher
async function pickemParse(page,file){
  await page.setInputFiles('#file',path.join(FIX,file));
  await page.waitForFunction(()=>!document.getElementById('parseBtn').disabled,null,{timeout:10000});
  await page.click('#parseBtn');
  await waitIdle(page);
  return adminText(page);
}
async function pickemReview(page){
  return page.evaluate(()=>({
    title:document.getElementById('reviewTitle').textContent,
    games:[...document.querySelectorAll('#gameReview tr')].map(tr=>[...tr.cells].map(td=>td.textContent.trim())),
    entries:[...document.querySelectorAll('#entryReview tr')].map(tr=>[...tr.cells].map(td=>td.textContent.trim())),
    validation:[...document.querySelectorAll('#validation span')].map(s=>s.textContent.trim()),
    tiebreakGame:document.getElementById('tiebreakGame').value
  }));
}
async function pickemPublish(page,rec,{replace=false}={}){
  if(replace)await page.check('#replaceLocked');
  const before=rec.writes.length;
  await page.click('#publishBtn');
  await waitIdle(page);
  await sleep(500);
  return{...(await adminText(page)),writes:rec.writes.slice(before)};
}
const EXPECTED_EASTERN_DATES=['2026-10-08','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-11','2026-10-12'];

async function scenarioPickem(browser){
  const rec=recorder('pickem');rec.browser=browser.version();
  const context=await newContext(browser,rec,{viewport:{width:1280,height:900}});
  const page=await context.newPage();
  try{
    await step(rec,'P00','Publisher page loads the QA-retargeted current-main admin',async()=>{
      await page.goto(BASE+'admin/',{waitUntil:'networkidle'});
      const t=await adminText(page);expect(t.authState==='SIGN IN REQUIRED',`auth state ${t.authState}`);
      return{authState:t.authState,screenshot:await shot(page,'pickem-00-signed-out')};
    },{fatal:true});
    await step(rec,'P01','Signed out: a valid sheet parses and previews, but Publish stays disabled',async()=>{
      const t=await pickemParse(page,'QA-FINAL-E2E-Pickem-2026-W5-r1.pdf');
      expect(t.messageClass.includes('success'),`message ${t.message}`);
      expect(t.reviewHidden===false,'review hidden');expect(t.publishDisabled===true,'publish enabled while signed out');
      return{...t,screenshot:await shot(page,'pickem-01-signed-out-preview-publish-disabled')};
    });
    await signIn(page,rec,'P02','pickem');
    await step(rec,'P02b','Signed in state shown',async()=>({screenshot:await shot(page,'pickem-02-signed-in')}));
    const negatives=[
      ['P03','Malformed PDF bytes are rejected','QA-FINAL-E2E-malformed.pdf',/Invalid PDF structure/i],
      ['P04','Tracked row with a missing pick is rejected','QA-FINAL-E2E-Pickem-2026-W5-missing-picks.pdf',/JC: regular weekly row is structurally invalid/],
      ['P05','Two rows for one tracked entry are rejected','QA-FINAL-E2E-Pickem-2026-W5-duplicate-tracked.pdf',/Multiple DJS rows found/],
      ['P06','A team in two matchups is rejected (validation added after PR #29)','QA-FINAL-E2E-Pickem-2026-W5-duplicate-team.pdf',/Game 14: team GB appears again \(game 10\)/],
      ['P07','A matchup not on the NFL Week 5 schedule is rejected','QA-FINAL-E2E-Pickem-2026-W5-invalid-schedule.pdf',/Schedule mismatch for BAL at KC\. Found 0 matching NFL games/]
    ];
    for(const [id,title,file,pattern] of negatives){
      await step(rec,id,title,async()=>{
        const before=rec.writes.length,t=await pickemParse(page,file);
        expect(t.messageClass.includes('error'),`not an error: ${t.message}`);
        expect(pattern.test(t.message),`unexpected message: ${t.message}`);
        expect(t.reviewHidden===true&&t.publishDisabled===true,'review shown or publish enabled after a rejected sheet');
        expect(rec.writes.length===before,'a write was sent');
        return{file,fixtureSha256:sha256(path.join(FIX,file)),message:t.message,publishDisabled:t.publishDisabled,writes:0,screenshot:await shot(page,`pickem-${id.toLowerCase()}-${path.basename(file,'.pdf').replace(/^QA-FINAL-E2E-(Pickem-2026-W5-)?/,'')}`)};
      });
    }
    let review;
    await step(rec,'P08','Revision 1 sheet: parse, NFL schedule match, full preview with Eastern kickoff dates',async()=>{
      const t=await pickemParse(page,'QA-FINAL-E2E-Pickem-2026-W5-r1.pdf');
      expect(t.messageClass.includes('success'),`message ${t.message}`);
      review=await pickemReview(page);
      expect(review.title==='2026 · Week 5 · 15 games · 38 entries',`title ${review.title}`);
      expect(review.games.length===15,'games');
      const dates=review.games.map(g=>g[4]);
      expect(JSON.stringify(dates)===JSON.stringify(EXPECTED_EASTERN_DATES),`dates ${dates.join(',')}`);
      expect(review.validation.some(v=>v.includes('NFL schedule matched'))&&review.validation.some(v=>v.includes('Full-field regular Pick\'em data validated · 38 entries')),'validation chips');
      expect(t.publishDisabled===false,'publish disabled for a valid signed-in sheet');
      return{message:t.message,review,screenshot:await shot(page,'pickem-08-r1-preview')};
    });
    await step(rec,'P09','Publish revision 1: exactly one INSERT, locked, revision 1',async()=>{
      const r=await pickemPublish(page,rec);
      expect(/Week 5 published and locked successfully\. Revision 1\./.test(r.message),`message ${r.message}`);
      const posts=r.writes.filter(w=>w.method==='POST');
      expect(posts.length===1&&posts[0].status===201&&r.writes.length===1,`writes ${JSON.stringify(r.writes)}`);
      const link=await page.getAttribute('#trackerLink','href');
      return{message:r.message,writes:r.writes,trackerLink:link,screenshot:await shot(page,'pickem-09-r1-published')};
    });
    await step(rec,'P10','Publishing the same week again without "replace" is refused with no write',async()=>{
      const r=await pickemPublish(page,rec);
      expect(/Week 5 is already locked/.test(r.message),`message ${r.message}`);
      expect(r.writes.length===0,'a write was sent');
      return{message:r.message,writes:0,screenshot:await shot(page,'pickem-10-duplicate-refused')};
    });
    await step(rec,'P11','Revision 2 sheet without "replace" is refused with no write',async()=>{
      const t=await pickemParse(page,'QA-FINAL-E2E-Pickem-2026-W5-r2.pdf');
      expect(t.messageClass.includes('success'),`parse ${t.message}`);
      const r=await pickemPublish(page,rec);
      expect(/Week 5 is already locked/.test(r.message)&&r.writes.length===0,`message ${r.message} writes ${r.writes.length}`);
      return{message:r.message,writes:0};
    });
    await step(rec,'P12','Revision 2 with "replace": one compare-and-swap UPDATE from revision 1, revision 2',async()=>{
      const r=await pickemPublish(page,rec,{replace:true});
      expect(/Week 5 published and locked successfully\. Revision 2\./.test(r.message),`message ${r.message}`);
      expect(r.writes.length===1&&r.writes[0].method==='PATCH'&&r.writes[0].status===200&&/revision=eq\.1/.test(r.writes[0].url),`writes ${JSON.stringify(r.writes)}`);
      return{message:r.message,writes:r.writes,review:await pickemReview(page),screenshot:await shot(page,'pickem-12-r2-published')};
    });
    // Stale-writer race: tab A validates and dispatches an UPDATE from revision 2; the request is held (unchanged) until tab B
    // has published revision 3, then released. The database must refuse A by its compare-and-swap (0 rows matched).
    await step(rec,'P13','Concurrent stale publish is refused by compare-and-swap (held request released after another publish)',async()=>{
      const a=await context.newPage(),b=await context.newPage();
      for(const p of [a,b]){await p.goto(BASE+'admin/',{waitUntil:'networkidle'});await p.waitForFunction(()=>document.getElementById('authState')?.textContent==='AUTHORIZED',null,{timeout:30000})}
      let release,held=false;const gate=new Promise(r=>{release=r});
      await a.route(u=>u.hostname===QA_DATA_HOST&&u.pathname.endsWith('/nfl_pool_weeks'),async route=>{
        if(route.request().method()==='PATCH'&&!held){held=true;await gate}
        return route.fallback();
      });
      const ta=await pickemParse(a,'QA-FINAL-E2E-Pickem-2026-W5-r1.pdf');expect(ta.messageClass.includes('success'),`A parse ${ta.message}`);
      await a.check('#replaceLocked');
      const before=rec.writes.length;
      await a.click('#publishBtn');
      for(let i=0;i<100&&!held;i++)await sleep(100);
      expect(held,'tab A never dispatched its UPDATE');
      const tb=await pickemParse(b,'QA-FINAL-E2E-Pickem-2026-W5-r2.pdf');expect(tb.messageClass.includes('success'),`B parse ${tb.message}`);
      const rb=await pickemPublish(b,rec,{replace:true});
      expect(/Revision 3\./.test(rb.message),`B ${rb.message}`);
      release();
      await waitIdle(a);await sleep(500);
      const ma=await adminText(a);
      expect(/changed before this write \(no row matched revision 2\)/.test(ma.message),`A ${ma.message}`);
      const writes=rec.writes.slice(before);
      expect(writes.filter(w=>w.method==='PATCH').length===2&&writes.every(w=>w.status===200),`writes ${JSON.stringify(writes)}`);
      const shotA=await shot(a,'pickem-13a-stale-writer-refused'),shotB=await shot(b,'pickem-13b-concurrent-revision-3');
      await a.close();await b.close();
      return{tabB:rb.message,tabA:ma.message,writes,screenshots:[shotA,shotB]};
    });
    await context.storageState({path:STATE});
  }finally{await context.close();save(rec)}
}

// ------------------------------------------------------------------------------------------------ Survivor publisher
async function survivorParse(page,file){
  await page.setInputFiles('#file',path.join(FIX,file));
  await page.waitForFunction(()=>!document.getElementById('parseBtn').disabled,null,{timeout:10000});
  await page.click('#parseBtn');
  await waitIdle(page);
  await sleep(1200);   // the signed-in comparison with published weeks may finish just after the parse message
  return page.evaluate(()=>{const $=id=>document.getElementById(id);return{message:$('message').hidden?'':$('message').textContent,messageClass:$('message').className,reviewHidden:$('review').hidden,reviewTitle:$('reviewTitle').textContent,validation:[...document.querySelectorAll('#validation span')].map(s=>s.textContent.trim()),checks:$('publishChecks').innerText,entries:[...document.querySelectorAll('#entryReview tr')].map(tr=>[...tr.cells].map(td=>td.textContent.trim())),confirmShown:!$('confirmWrap').hidden,confirmText:$('confirmText').textContent,publishDisabled:$('publishBtn').disabled}});
}
async function survivorPublish(page,rec,{replace=false,confirm=true}={}){
  if(replace)await page.check('#replaceLocked');
  if(confirm&&await page.isVisible('#confirmWrap'))await page.check('#confirmPartial');
  const enabled=!(await page.isDisabled('#publishBtn'));
  const before=rec.writes.length;
  if(enabled){await page.click('#publishBtn');await waitIdle(page);await sleep(500)}
  return{enabledBeforeClick:enabled,message:await page.evaluate(()=>document.getElementById('message').textContent),writes:rec.writes.slice(before)};
}
async function scenarioSurvivor(browser){
  const rec=recorder('survivor');rec.browser=browser.version();
  const context=await newContext(browser,rec,{viewport:{width:1280,height:900},storageState:fs.existsSync(STATE)?STATE:undefined});
  const page=await context.newPage();
  try{
    await step(rec,'S00','Survivor publisher loads; the publisher session from the Pick\'em sign-in is recognized',async()=>{
      await page.goto(BASE+'admin/survivor.html',{waitUntil:'networkidle'});
      let state=await page.evaluate(()=>document.getElementById('authState').textContent);
      if(state!=='AUTHORIZED'){await signIn(page,rec,'S00b','survivor');state=await page.evaluate(()=>document.getElementById('authState').textContent)}
      expect(state==='AUTHORIZED',`auth ${state}`);
      return{authState:state,signedEmail:await page.textContent('#signedEmail'),screenshot:await shot(page,'survivor-00-signed-in')};
    },{fatal:true});
    const negatives=[
      ['S01','Malformed PDF bytes are rejected','QA-FINAL-E2E-malformed.pdf',/Invalid PDF structure/i],
      ['S02','Unknown team code is rejected','QA-FINAL-E2E-Survivor-2026-W8-unknown-team.pdf',/DJS: unknown Week 4 team XYZ/],
      ['S03','Two rows for one tracked entry are rejected','QA-FINAL-E2E-Survivor-2026-W8-duplicate-tracked.pdf',/Multiple DJS Survivor rows found/],
      ['S04','A pick of a team on bye is rejected by NFL schedule verification','QA-FINAL-E2E-Survivor-2026-W8-bye-pick.pdf',/Week 8: SF is not scheduled in verified NFL Week 8/]
    ];
    for(const [id,title,file,pattern] of negatives){
      await step(rec,id,title,async()=>{
        const before=rec.writes.length,t=await survivorParse(page,file);
        expect(t.messageClass.includes('error')&&pattern.test(t.message),`unexpected: ${t.message}`);
        expect(t.reviewHidden===true&&t.publishDisabled===true,'review shown or publish enabled');
        expect(rec.writes.length===before,'a write was sent');
        return{file,fixtureSha256:sha256(path.join(FIX,file)),message:t.message,writes:0,screenshot:await shot(page,`survivor-${id.toLowerCase()}-${path.basename(file,'.pdf').replace(/^QA-FINAL-E2E-(Survivor-2026-W8-)?/,'')}`)};
      });
    }
    await step(rec,'S05','Revision 1 sheet: parse, Weeks 1–8 schedule verification, comparison with published weeks; publish needs confirmation',async()=>{
      const t=await survivorParse(page,'QA-FINAL-E2E-Survivor-2026-W8-r1.pdf');
      expect(t.messageClass.includes('success'),`message ${t.message}`);
      expect(t.reviewTitle==='2026 · Week 8 · 4 entries · 1 with Week 8 pick',`title ${t.reviewTitle}`);
      expect(t.validation.some(v=>v.includes('NFL schedule verified for Weeks 1–8')),'schedule chip');
      expect(/Entry count and Weeks 1–6 pick histories match published Week 6 \(revision 2\)/.test(t.checks),'history comparison');
      expect(/already eliminated before Week 8 still shows a Week 8 pick \(1 OUT by SF's Week 7 loss\)/.test(t.checks),'elimination note');
      expect(t.confirmShown===true&&t.publishDisabled===true,'confirmation gate');
      return{...t,screenshot:await shot(page,'survivor-05-r1-preview-checks')};
    });
    await step(rec,'S06','Publish revision 1 after confirmation: exactly one INSERT, revision 1',async()=>{
      const r=await survivorPublish(page,rec);
      expect(r.enabledBeforeClick,'publish not enabled after confirmation');
      expect(/Survivor Week 8 published and locked\. Revision 1\./.test(r.message),`message ${r.message}`);
      expect(r.writes.length===1&&r.writes[0].method==='POST'&&r.writes[0].status===201,`writes ${JSON.stringify(r.writes)}`);
      return{...r,screenshot:await shot(page,'survivor-06-r1-published')};
    });
    await step(rec,'S07','Same week again without "replace" is refused with no write',async()=>{
      const t=await survivorParse(page,'QA-FINAL-E2E-Survivor-2026-W8-r1.pdf');
      expect(t.messageClass.includes('success'),`parse ${t.message}`);
      const r=await survivorPublish(page,rec);
      expect(/Survivor Week 8 is already locked/.test(r.message)&&r.writes.length===0,`message ${r.message}`);
      return{checks:t.checks,...r,screenshot:await shot(page,'survivor-07-duplicate-refused')};
    });
    await step(rec,'S08','Revision 2 correction with "replace": one compare-and-swap UPDATE from revision 1, revision 2',async()=>{
      const t=await survivorParse(page,'QA-FINAL-E2E-Survivor-2026-W8-r2.pdf');
      expect(t.messageClass.includes('success'),`parse ${t.message}`);
      expect(/This replaces published Week 8 revision 1/.test(t.checks),'replacement comparison');
      const r=await survivorPublish(page,rec,{replace:true});
      expect(/Survivor Week 8 published and locked\. Revision 2\./.test(r.message),`message ${r.message}`);
      expect(r.writes.length===1&&r.writes[0].method==='PATCH'&&r.writes[0].status===200&&/revision=eq\.1/.test(r.writes[0].url),`writes ${JSON.stringify(r.writes)}`);
      return{checks:t.checks,entries:t.entries,...r,screenshot:await shot(page,'survivor-08-r2-published')};
    });
    await step(rec,'S09','A sheet validated before another publish is refused as stale (published weeks changed)',async()=>{
      const a=await context.newPage(),b=await context.newPage();
      for(const p of [a,b]){await p.goto(BASE+'admin/survivor.html',{waitUntil:'networkidle'});await p.waitForFunction(()=>document.getElementById('authState')?.textContent==='AUTHORIZED',null,{timeout:30000})}
      const ta=await survivorParse(a,'QA-FINAL-E2E-Survivor-2026-W8-r1.pdf');expect(ta.messageClass.includes('success'),`A parse ${ta.message}`);
      const tb=await survivorParse(b,'QA-FINAL-E2E-Survivor-2026-W8-r2.pdf');expect(tb.messageClass.includes('success'),`B parse ${tb.message}`);
      const rb=await survivorPublish(b,rec,{replace:true});
      expect(/Revision 3\./.test(rb.message),`B ${rb.message}`);
      const ra=await survivorPublish(a,rec,{replace:true});
      expect(/changed since this sheet was validated\. Nothing was written/.test(ra.message)&&ra.writes.length===0,`A ${ra.message}`);
      const shots=[await shot(a,'survivor-09a-stale-validation-refused'),await shot(b,'survivor-09b-concurrent-revision-3')];
      await a.close();await b.close();
      return{tabB:rb.message,tabA:ra.message,writesB:rb.writes,screenshots:shots};
    });
  }finally{await context.close();save(rec)}
}

// ----------------------------------------------------------------------------------------------------------- tracker
async function trackerState(page){
  return page.evaluate(()=>{
    const $=id=>document.getElementById(id),txt=id=>($(id)?.innerText||'').trim();
    const sel=$('weekSelect');
    return{
      view:document.body.dataset.view,sync:txt('sync'),weekLine:txt('weekLine'),weekSelected:sel?.options[sel.selectedIndex]?.text,
      weekOptions:[...(sel?.options||[])].map(o=>o.text),finals:txt('finals'),left:txt('left'),entryCount:txt('entryCount'),gameCount:txt('gameCount'),
      error:txt('error'),leader:`${txt('leaderName')} ${txt('leaderRecord')}`.trim(),fieldPulse:txt('homeFieldPulse'),
      standings:[...document.querySelectorAll('#standings tr')].map(tr=>[...tr.cells].map(td=>td.innerText.trim().replace(/\s+/g,' '))).filter(r=>r.length),
      footer:txt('footerRule'),tbNote:txt('tbNote'),season:txt('seasonRecord').slice(0,600)
    };
  });
}
async function measure(page){
  return page.evaluate(()=>{
    const de=document.documentElement,sel=document.getElementById('weekSelect'),cs=sel?getComputedStyle(sel):null,r=sel?.getBoundingClientRect();
    let weekSelect=null;
    if(sel&&r&&r.width){const ctx=document.createElement('canvas').getContext('2d');ctx.font=cs.font;const label=sel.options[sel.selectedIndex]?.text||'';const content=r.width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-parseFloat(cs.borderLeftWidth)-parseFloat(cs.borderRightWidth);weekSelect={label,textWidth:+ctx.measureText(label).width.toFixed(1),contentWidth:+content.toFixed(1),boxWidth:+r.width.toFixed(1),height:+r.height.toFixed(1),fits:ctx.measureText(label).width<=content}}
    const targets=['.app-menu summary','#weekSelect','#refresh','.bottom-nav button','.header-actions button','.dash-tool','.share-btn','.pm-segment','.pm-toggle','.pm-slates-action','.brand-lockup'];
    const sizes={};
    for(const s of targets){const els=[...document.querySelectorAll(s)].filter(el=>{const b=el.getBoundingClientRect();return b.width>0&&b.height>0});if(els.length)sizes[s]={count:els.length,minHeight:Math.min(...els.map(el=>+el.getBoundingClientRect().height.toFixed(1))),minWidth:Math.min(...els.map(el=>+el.getBoundingClientRect().width.toFixed(1)))}}
    return{innerWidth,innerHeight,devicePixelRatio,clientWidth:de.clientWidth,scrollWidth:de.scrollWidth,bodyScrollWidth:document.body.scrollWidth,horizontalOverflow:de.scrollWidth>de.clientWidth,weekSelect,touchTargets:sizes};
  });
}
async function openTracker(browser,rec,{width=1280,height=900,mobile=false,url=BASE,setup}={}){
  const opts=mobile?{viewport:{width,height},deviceScaleFactor:2,isMobile:true,hasTouch:true}:{viewport:{width,height}};
  const context=await newContext(browser,rec,opts),page=await context.newPage();
  if(setup)await setup(page);
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>{const s=document.getElementById('sync')?.textContent||'';return s&&!/Connecting/.test(s)},null,{timeout:60000});
  return{context,page};
}
async function chooseWeek(page,label,week){
  const value=await page.evaluate(l=>[...document.getElementById('weekSelect').options].find(o=>o.text===l)?.value,label);
  if(!value)throw new Error(`week option ${label} not listed`);
  await page.selectOption('#weekSelect',value);
  await page.waitForFunction(({l,w})=>{const s=document.getElementById('weekSelect');return s.options[s.selectedIndex]?.text===l&&(document.getElementById('weekLine')?.textContent||'').includes(`Week ${w} ·`)},{l:label,w:week},{timeout:30000});
  await waitScored(page);
}
async function waitScored(page){
  await page.waitForFunction(()=>/LIVE|DELAYED|FEED UNAVAILABLE|ON HOLD|INCOMPLETE|STALE/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});
  await sleep(1500);
}
async function view(page,name){
  const nav=page.locator(`.bottom-nav [data-view-target="${name}"]`);
  if(await nav.isVisible().catch(()=>false))await nav.click();
  else await page.evaluate(n=>document.querySelector(`[data-view-target="${n}"]`).click(),name);
  await sleep(900);
}
async function survivorWeek(page,label){
  await page.waitForFunction(l=>[...document.getElementById('survivorWeekSelect').options].some(o=>o.text===l),label,{timeout:60000});
  const v=await page.evaluate(l=>[...document.getElementById('survivorWeekSelect').options].find(o=>o.text===l).value,label);
  await page.selectOption('#survivorWeekSelect',v);
  await page.waitForFunction(w=>(document.getElementById('svMeta')?.innerText||'').includes(w),label.split(' · ')[1],{timeout:60000});
  await page.waitForFunction(()=>!/LOADING/.test(document.getElementById('svFeed')?.innerText||''),null,{timeout:60000}).catch(()=>{});
  await sleep(2500);
  return page.evaluate(()=>({selected:document.getElementById('survivorWeekSelect').selectedOptions[0]?.text,options:[...document.getElementById('survivorWeekSelect').options].map(o=>o.text),meta:document.getElementById('svMeta')?.innerText,feed:document.getElementById('svFeed')?.innerText,poolSize:document.getElementById('svPoolSize')?.innerText,entered:document.getElementById('svEntered')?.innerText,stillIn:document.getElementById('svStillIn')?.innerText,pending:document.getElementById('svPending')?.innerText,note:document.getElementById('svSummaryNote')?.innerText,tracked:(document.getElementById('svTracked')?.innerText||'').replace(/\n+/g,' | '),progress:(document.getElementById('svProgress')?.innerText||'').replace(/\n+/g,' | ').slice(0,700),error:document.getElementById('survivorError')?.innerText,archiveNotice:[...document.querySelectorAll('[data-view-panel="survivor"] .group-survivor-complete')].map(e=>e.innerText.replace(/\s+/g,' ')).join(' / ')}));
}
// Expected from the existing QA publication 2026 Week 9 revision 3 and the real JAX 33-10 BAL final (Thu Nov 5, 2026):
// JC and Thaddeus picked JAX (1), D.C. and DJS picked BAL (2); the one anonymous field entry picked JAX.
const W9_EXPECTED={'JC':'1-0','Thaddeus':'1-0','D.C.':'0-1','DJS':'0-1'};
function standingWL(rows){const out={};for(const r of rows){const name=r[1];if(name)out[name]=`${r[3]}-${r[4]}`}return out}

async function scenarioTracker(browser){
  const rec=recorder('tracker');rec.browser=browser.version();
  try{
    await step(rec,'T01','Fresh anonymous session: default week, published-week selector, switch to 2026 · Week 9',async()=>{
      const {context,page}=await openTracker(browser,rec);
      try{
        await waitScored(page);
        const first=await trackerState(page);
        expect(JSON.stringify(first.weekOptions)===JSON.stringify(['2026 · Week 9','2026 · Week 10']),`options ${first.weekOptions}`);
        expect(first.weekSelected==='2026 · Week 10','default week is not the latest publication');
        const firstShot=await shot(page,'tracker-01a-desktop-home-default-week10');
        await chooseWeek(page,'2026 · Week 9',9);
        const s=await trackerState(page);
        expect(/Week 9 · revision 3/.test(s.weekLine),`week line ${s.weekLine}`);
        return{defaultWeek:first.weekSelected,defaultWeekLine:first.weekLine,options:first.weekOptions,afterSelect:{weekLine:s.weekLine,sync:s.sync,finals:s.finals,url:page.url()},screenshots:[firstShot,await shot(page,'tracker-01b-desktop-home-week9')]};
      }finally{await context.close()}
    });
    await step(rec,'T02','Week 9 r3 read-back after a real final: W–L, ranks, finals, positive group-vs-field pulse, Eastern header dates',async()=>{
      const {context,page}=await openTracker(browser,rec,{url:BASE+'?season=2026&week=9'});
      try{
        await page.waitForFunction(()=>/Week 9 · revision 3/.test(document.getElementById('weekLine')?.textContent||''),null,{timeout:30000});
        await page.waitForFunction(()=>/LIVE|DELAYED/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});
        await page.waitForFunction(()=>document.querySelector('#homeFieldPulse [data-field-pulse]')?.dataset.fieldPulse==='ready',null,{timeout:30000}).catch(()=>{});
        await sleep(1500);
        const home=await trackerState(page);
        const pulseState=await page.evaluate(()=>document.querySelector('#homeFieldPulse [data-field-pulse]')?.dataset.fieldPulse);
        const homeShot=await shot(page,'tracker-02a-desktop-home-week9-field-pulse');
        await view(page,'standings');const st=await trackerState(page);const stShot=await shot(page,'tracker-02b-desktop-standings-week9');
        await view(page,'games');const games=await page.evaluate(()=>[...document.querySelectorAll('#gamegrid > *')].map(el=>el.innerText.replace(/\s+/g,' ').trim()).filter(Boolean));const gShot=await shot(page,'tracker-02c-desktop-games-week9');
        await view(page,'picks');const pShot=await shot(page,'tracker-02d-desktop-picks-week9');
        const wl=standingWL(st.standings);
        for(const [name,exp] of Object.entries(W9_EXPECTED))expect(wl[name]===exp,`${name} ${wl[name]} != ${exp} (${JSON.stringify(st.standings)})`);
        expect(st.finals==='1/15',`finals ${st.finals}`);
        expect(/Nov 5–Nov 9, 2026/.test(st.weekLine),`week line dates ${st.weekLine}`);
        expect(pulseState==='ready'&&/T-1/.test(home.fieldPulse)&&/of 5/.test(home.fieldPulse)&&/Top 20%/.test(home.fieldPulse)&&/2\s*of 4 submitted/.test(home.fieldPulse),`field pulse ${pulseState}: ${home.fieldPulse}`);
        expect(games.some(g=>/JAX/.test(g)&&/BAL/.test(g)&&/FINAL/.test(g)),'JAX-BAL final card missing');
        return{weekLine:st.weekLine,sync:st.sync,finals:st.finals,left:st.left,leader:home.leader,fieldPulseState:pulseState,fieldPulse:home.fieldPulse,standings:st.standings,finalCard:games.find(g=>/JAX/.test(g)&&/BAL/.test(g)),footer:st.footer,screenshots:[homeShot,stShot,gShot,pShot]};
      }finally{await context.close()}
    });
    for(const width of [375,390,430]){
      await step(rec,`T03-${width}`,`Mobile ${width} CSS px: Week 10 (two-digit label) Home + Standings, Week 9 Picks, Survivor archive Week 6 — overflow, label and touch targets measured`,async()=>{
        const {context,page}=await openTracker(browser,rec,{width,height:844,mobile:true,url:BASE});
        try{
          await waitScored(page);
          const home=await measure(page),s=await trackerState(page);
          expect(s.weekSelected==='2026 · Week 10',`selected ${s.weekSelected}`);
          const homeShot=await shot(page,`tracker-03-mobile-${width}-home-week10`);
          await view(page,'standings');const st=await measure(page);const stShot=await shot(page,`tracker-03-mobile-${width}-standings-week10`);
          await chooseWeek(page,'2026 · Week 9',9);await view(page,'picks');const pk=await measure(page);const pkShot=await shot(page,`tracker-03-mobile-${width}-picks-week9`);
          await view(page,'survivor');const sv=await survivorWeek(page,'2026 · Week 6');
          const arch=await measure(page);const archShot=await shot(page,`tracker-03-mobile-${width}-archive-survivor-week6`);
          for(const m of [home,st,pk,arch])expect(!m.horizontalOverflow&&m.innerWidth===width&&m.clientWidth===width&&m.scrollWidth===width,`overflow ${JSON.stringify(m)}`);
          expect(home.weekSelect?.fits===true,`week label clipped ${JSON.stringify(home.weekSelect)}`);
          const small=Object.entries(home.touchTargets).filter(([,v])=>v.minHeight<44).map(([k,v])=>`${k} ${v.minHeight}px`);
          expect(!small.length,`touch targets under 44px: ${small.join(', ')}`);
          return{measure:{home,standings:st,picks:pk,archive:arch},weekLine:s.weekLine,sync:s.sync,survivor:sv,screenshots:[homeShot,stShot,pkShot,archShot]};
        }finally{await context.close()}
      });
    }
    await step(rec,'T04','Injected fault: score gateway answers 502 → FEED UNAVAILABLE and nothing graded; Refresh after recovery grades the final',async()=>{
      let down=true;
      const {context,page}=await openTracker(browser,rec,{url:BASE+'?season=2026&week=9&view=standings',setup:p=>p.route(u=>u.pathname.startsWith('/__qa-nflscores2'),r=>down?r.fulfill({status:502,contentType:'application/json',body:'{"error":"upstream_unavailable"}'}):r.fallback())});
      try{
        await page.waitForFunction(()=>/FEED UNAVAILABLE/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});await sleep(800);
        const failed=await trackerState(page);const failShot=await shot(page,'tracker-04a-feed-unavailable');
        const wlFailed=standingWL(failed.standings);
        expect(Object.values(wlFailed).every(v=>v==='0-0'),`graded without a feed: ${JSON.stringify(wlFailed)}`);
        // Refresh is the Game Center control (Games view); the Standings view does not display it.
        down=false;await view(page,'games');await page.click('#refresh');
        await page.waitForFunction(()=>/LIVE|DELAYED/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});await sleep(1500);
        await view(page,'standings');
        const recovered=await trackerState(page);const okShot=await shot(page,'tracker-04b-feed-recovered');
        const wl=standingWL(recovered.standings);
        for(const [name,exp] of Object.entries(W9_EXPECTED))expect(wl[name]===exp,`after recovery ${name} ${wl[name]}`);
        return{failed:{sync:failed.sync,error:failed.error,finals:failed.finals,wl:wlFailed},recovered:{sync:recovered.sync,finals:recovered.finals,wl},screenshots:[failShot,okShot]};
      }finally{await context.close()}
    });
    await step(rec,'T05','Injected fault: contest rules/rulings unreadable → ON HOLD; no game graded from the feed alone; field pulse withheld',async()=>{
      const {context,page}=await openTracker(browser,rec,{url:BASE+'?season=2026&week=9',setup:p=>p.route(u=>u.hostname===QA_DATA_HOST&&/\/(nfl_contests|nfl_contest_policies|nfl_incident_rulings)$/.test(u.pathname),r=>r.abort('failed'))});
      try{
        await page.waitForFunction(()=>/ON HOLD/.test(document.getElementById('sync')?.textContent||''),null,{timeout:90000});await sleep(1000);
        const home=await trackerState(page);const homeShot=await shot(page,'tracker-05a-on-hold-home');
        await view(page,'standings');const s=await trackerState(page);
        const wl=standingWL(s.standings);
        expect(Object.values(wl).every(v=>v==='0-0'),`graded while on hold: ${JSON.stringify(wl)}`);
        expect(/ON HOLD/.test(s.error),'hold banner missing');
        return{sync:s.sync,error:s.error,wl,fieldPulse:home.fieldPulse,screenshots:[homeShot,await shot(page,'tracker-05b-on-hold-standings')]};
      }finally{await context.close()}
    });
    await step(rec,'T06','Injected fault: publication index unreadable on refresh → PUBLISHED DATA STALE; last verified revision kept',async()=>{
      let block=false;
      const {context,page}=await openTracker(browser,rec,{url:BASE+'?season=2026&week=9&view=standings',setup:p=>p.route(u=>u.hostname===QA_DATA_HOST&&u.pathname.endsWith('/nfl_pool_weeks'),r=>block?r.abort('failed'):r.fallback())});
      try{
        await page.waitForFunction(()=>/LIVE|DELAYED/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});
        block=true;await view(page,'games');await page.click('#refresh');
        await page.waitForFunction(()=>/PUBLISHED DATA STALE/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});await sleep(1000);
        await view(page,'standings');
        const s=await trackerState(page),wl=standingWL(s.standings);
        const staleShot=await shot(page,`tracker-06-published-data-stale${process.env.QA_SHOT_TAG?`-${process.env.QA_SHOT_TAG}`:''}`);
        expect(/PUBLISHED DATA STALE/.test(s.weekLine)&&/revision 3/.test(s.weekLine),`week line ${s.weekLine}`);
        // Defect found by the first run (main 756f2ac): the stale strip fell back to the stored UTC range "Nov 6–Nov 10".
        expect(/revision 3 · Nov 5–Nov 9, 2026 · /.test(s.weekLine),`stale strip dates are not the verified Eastern range: ${s.weekLine}`);
        for(const [name,exp] of Object.entries(W9_EXPECTED))expect(wl[name]===exp,`stale view lost ${name}`);
        return{sync:s.sync,weekLine:s.weekLine,error:s.error,wl,screenshot:staleShot};
      }finally{await context.close()}
    });
    await step(rec,'T07','Survivor archive read-back (desktop): Week 6 r2 — loss, NFL tie and reused-team eliminations; Week 2 and Week 9 listed',async()=>{
      const {context,page}=await openTracker(browser,rec,{url:BASE+'?view=survivor'});
      try{
        const s=await survivorWeek(page,'2026 · Week 6');
        expect(JSON.stringify(s.options)===JSON.stringify(['2026 · Week 2','2026 · Week 6','2026 · Week 9']),`options ${s.options}`);
        expect(/tie/i.test(s.tracked),'tie elimination not shown');
        return{...s,screenshot:await shot(page,'tracker-07-desktop-archive-survivor-week6')};
      }finally{await context.close()}
    });
  }finally{save(rec)}
}

// ------------------------------------------------------------------------------- public Data API read-back + negative
async function scenarioReadback(browser){
  const rec=recorder('readback');rec.browser=browser.version();
  const context=await newContext(browser,rec,{viewport:{width:800,height:600}}),page=await context.newPage();
  try{
    await page.goto(BASE+'assets/pool-center-icon.svg');
    await step(rec,'R01','Anonymous Data API read-back (the public pages\' path): locked publication index and rows',async()=>{
      return page.evaluate(async({auth,data})=>{
        const token=(await (await fetch(`${auth}/token/anonymous`,{cache:'no-store'})).json()).token;
        const get=async q=>{const r=await fetch(`${data}/${q}`,{cache:'no-store',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});return{status:r.status,rows:await r.json()}};
        const index=await get('nfl_pool_weeks?select=season,week,revision,status,source_sha256&order=season.asc,week.asc');
        const sindex=await get('nfl_survivor_weeks?select=season,week,revision,status,source_sha256&order=season.asc,week.asc');
        const w9=await get('nfl_pool_weeks?select=season,week,status,revision,config&season=eq.2026&week=eq.9');
        const s6=await get('nfl_survivor_weeks?select=season,week,status,revision,config&season=eq.2026&week=eq.6');
        const p=w9.rows[0],s=s6.rows[0];
        return{pickemIndex:index,survivorIndex:sindex,
          week9:{status:w9.status,revision:p?.revision,games:p?.config?.games?.length,competitionSize:p?.config?.competitionSize,storedDates:p?.config?.games?.map(g=>g.date),tracked:p?.config?.participants?.map(x=>`${x.displayName}: ${x.pickNumbers.join(' ')}`)},
          survivorWeek6:{status:s6.status,revision:s?.revision,tracked:s?.config?.trackedEntries?.map(x=>`${x.displayName}: ${x.picks.join(',')}`),field:s?.config?.fieldEntries?.map(x=>`${x.id}: ${x.picks.join(',')}`)}};
      },{auth:QA_AUTH,data:QA_DATA});
    });
    // Only an INSERT of an unused key with status 'draft' is attempted, so a broken policy could never alter an existing
    // QA publication or appear on a public page.
    await step(rec,'R02','Anonymous INSERT of a new draft row is refused by the database',async()=>{
      const r=await page.evaluate(async({auth,data})=>{
        const token=(await (await fetch(`${auth}/token/anonymous`,{cache:'no-store'})).json()).token;
        const res=await fetch(`${data}/nfl_pool_weeks`,{method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/json','Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({season:2026,week:18,status:'draft',revision:1,config:{season:2026,week:18,label:'QA anonymous-write negative test'}})});
        let code=null,message=null;try{const j=await res.json();code=j?.code??null;message=typeof j?.message==='string'?j.message.slice(0,160):null}catch{}
        return{status:res.status,code,message};
      },{auth:QA_AUTH,data:QA_DATA});
      expect(r.status===401||r.status===403,`anonymous insert not refused: ${JSON.stringify(r)}`);
      return r;
    });
  }finally{await context.close();save(rec)}
}

// Signed-out import rejections and previews on current main (parsing and NFL schedule checks need no sign-in).
async function scenarioNegatives(browser){
  const rec=recorder('imports-signed-out');rec.browser=browser.version();
  const context=await newContext(browser,rec,{viewport:{width:1280,height:900}});
  const page=await context.newPage();
  try{
    await page.goto(BASE+'admin/',{waitUntil:'networkidle'});
    const negatives=[
      ['P03','Malformed PDF bytes are rejected','QA-FINAL-E2E-malformed.pdf',/Invalid PDF structure/i],
      ['P04','Tracked row with a missing pick is rejected','QA-FINAL-E2E-Pickem-2026-W5-missing-picks.pdf',/JC: regular weekly row is structurally invalid/],
      ['P05','Two rows for one tracked entry are rejected','QA-FINAL-E2E-Pickem-2026-W5-duplicate-tracked.pdf',/Multiple DJS rows found/],
      ['P06','A team in two matchups is rejected (validation added after PR #29)','QA-FINAL-E2E-Pickem-2026-W5-duplicate-team.pdf',/Game 14: team GB appears again \(game 10\)/],
      ['P07','A matchup not on the NFL Week 5 schedule is rejected','QA-FINAL-E2E-Pickem-2026-W5-invalid-schedule.pdf',/Schedule mismatch for BAL at KC\. Found 0 matching NFL games/]
    ];
    for(const [id,title,file,pattern] of negatives){
      await step(rec,id,title,async()=>{
        const before=rec.writes.length,t=await pickemParse(page,file);
        expect(t.messageClass.includes('error')&&pattern.test(t.message),`unexpected: ${t.message}`);
        expect(t.reviewHidden===true&&t.publishDisabled===true,'review shown or publish enabled after a rejected sheet');
        expect(rec.writes.length===before,'a write was sent');
        return{file,fixtureSha256:sha256(path.join(FIX,file)),message:t.message,publishDisabled:t.publishDisabled,screenshot:await shot(page,`imports-${id.toLowerCase()}-${path.basename(file,'.pdf').replace(/^QA-FINAL-E2E-(Pickem-2026-W5-)?/,'')}`)};
      });
    }
    for(const [id,file] of [['P08','QA-FINAL-E2E-Pickem-2026-W5-r1.pdf'],['P08b','QA-FINAL-E2E-Pickem-2026-W5-r2.pdf']]){
      await step(rec,id,`Valid sheet ${path.basename(file)}: preview with NFL schedule match and Eastern kickoff dates; Publish disabled while signed out`,async()=>{
        const t=await pickemParse(page,file),review=await pickemReview(page);
        expect(t.messageClass.includes('success')&&t.publishDisabled===true,`state ${t.message} publishDisabled=${t.publishDisabled}`);
        expect(review.title==='2026 · Week 5 · 15 games · 38 entries',`title ${review.title}`);
        expect(JSON.stringify(review.games.map(g=>g[4]))===JSON.stringify(EXPECTED_EASTERN_DATES),`dates ${review.games.map(g=>g[4])}`);
        return{file,fixtureSha256:sha256(path.join(FIX,file)),message:t.message,review,screenshot:await shot(page,`imports-${id.toLowerCase()}-preview-${path.basename(file,'.pdf').slice(-2)}`)};
      });
    }
    await page.goto(BASE+'admin/survivor.html',{waitUntil:'networkidle'});
    const sNeg=[
      ['S01','Malformed PDF bytes are rejected','QA-FINAL-E2E-malformed.pdf',/Invalid PDF structure/i],
      ['S02','Unknown team code is rejected','QA-FINAL-E2E-Survivor-2026-W8-unknown-team.pdf',/DJS: unknown Week 4 team XYZ/],
      ['S03','Two rows for one tracked entry are rejected','QA-FINAL-E2E-Survivor-2026-W8-duplicate-tracked.pdf',/Multiple DJS Survivor rows found/],
      ['S04','A pick of a team on bye is rejected by NFL schedule verification','QA-FINAL-E2E-Survivor-2026-W8-bye-pick.pdf',/Week 8: SF is not scheduled in verified NFL Week 8/]
    ];
    for(const [id,title,file,pattern] of sNeg){
      await step(rec,id,title,async()=>{
        const before=rec.writes.length,t=await survivorParse(page,file);
        expect(t.messageClass.includes('error')&&pattern.test(t.message),`unexpected: ${t.message}`);
        expect(t.reviewHidden===true&&t.publishDisabled===true,'review shown or publish enabled');
        expect(rec.writes.length===before,'a write was sent');
        return{file,fixtureSha256:sha256(path.join(FIX,file)),message:t.message,screenshot:await shot(page,`imports-${id.toLowerCase()}-${path.basename(file,'.pdf').replace(/^QA-FINAL-E2E-(Survivor-2026-W8-)?/,'')}`)};
      });
    }
    await step(rec,'S05','Valid Survivor Week 8 sheet: Weeks 1–8 schedule verified; publishing blocked until a publisher signs in',async()=>{
      const t=await survivorParse(page,'QA-FINAL-E2E-Survivor-2026-W8-r1.pdf');
      expect(t.messageClass.includes('success')&&t.publishDisabled===true,`state ${t.message}`);
      expect(t.reviewTitle==='2026 · Week 8 · 4 entries · 1 with Week 8 pick',`title ${t.reviewTitle}`);
      expect(t.validation.some(v=>v.includes('NFL schedule verified for Weeks 1–8')),'schedule chip');
      expect(/Published Survivor weeks for this season have not been checked\. Sign in/.test(t.checks),'sign-in block missing');
      return{fixtureSha256:sha256(path.join(FIX,'QA-FINAL-E2E-Survivor-2026-W8-r1.pdf')),...t,screenshot:await shot(page,'imports-s05-survivor-preview-blocked-signed-out')};
    });
    expect(rec.writes.length===0,'a write was sent');
  }finally{await context.close();save(rec)}
}

// Independent read-back of the QA child's 2026 Week 5 Pick'em and Week 8 Survivor publications (published outside this
// runner by the authorized child-only QA publisher; see QA_PASSWORD_E2E_CLOSEOUT.md). Anonymous and read-only. Expected
// values are computed here, NOT by app code: from the published config (anonymous Data API, the public pages' path) and
// ESPN's final scores fetched directly by Node, with the documented rules (an NFL tie is a loss for either pick; the
// tiebreak is the absolute difference from the designated game's total once it is final; competition ranks).
async function espnWeek(season,week){
  const r=await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}&limit=100`,{headers:{Accept:'application/json'}});
  if(!r.ok)throw new Error(`ESPN ${r.status}`);return r.json();
}
async function publishedRow(page,table,season,week){
  return page.evaluate(async({auth,data,table,season,week})=>{
    const token=(await (await fetch(`${auth}/token/anonymous`,{cache:'no-store'})).json()).token;
    const r=await fetch(`${data}/${table}?select=season,week,status,revision,source_filename,source_sha256,config&season=eq.${season}&week=eq.${week}&status=eq.locked`,{cache:'no-store',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
    return{status:r.status,rows:await r.json()};
  },{auth:QA_AUTH,data:QA_DATA,table,season,week});
}
function expectedPickem(cfg,events){
  const byId=new Map(events.map(e=>[String(e.id),e]));
  const games=cfg.games.map((g,i)=>{
    const e=byId.get(String(g.eventId));if(!e)throw new Error(`no ESPN event ${g.eventId} for game ${i+1}`);
    const c=e.competitions[0],a=c.competitors.find(x=>x.homeAway==='away'),h=c.competitors.find(x=>x.homeAway==='home');
    const as=Number(a.score),hs=Number(h.score),final=e.status?.type?.completed===true;
    return{i,away:g.away,home:g.home,final,tie:final&&as===hs,winner:!final?null:as>hs?g.awayNumber:hs>as?g.homeNumber:null,total:as+hs,score:`${a.team.abbreviation} ${as}-${hs} ${h.team.abbreviation}`};
  });
  const tb=games[cfg.tiebreakGameIndex],tbFinal=tb.final;
  const grade=(nums,tiebreak)=>{let w=0,l=0;games.forEach((g,i)=>{if(!g.final)return;if(g.winner!==null&&nums?.[i]===g.winner)w++;else l++});return{w,l,diff:tbFinal?(Number.isInteger(tiebreak)?Math.abs(tiebreak-tb.total):Infinity):null}};
  const tracked=cfg.participants.map((p,i)=>({name:p.displayName,i,...grade(p.pickNumbers,p.tiebreak),tiePick:(()=>{const t=games.find(g=>g.tie);return t?p.pickNumbers[t.i]:null})()}));
  const field=(cfg.fieldEntries||[]).map((f,i)=>({name:`field-${i}`,...grade(f.pickNumbers,f.tiebreak)}));
  const all=[...tracked.map((t,k)=>({...t,order:k,tracked:true})),...field.map((f,k)=>({...f,order:tracked.length+k,tracked:false}))];
  const same=(a,b)=>a.w===b.w&&a.l===b.l&&(!tbFinal||a.diff===b.diff);
  all.sort((a,b)=>b.w-a.w||a.l-b.l||(tbFinal?a.diff-b.diff:0)||a.order-b.order);
  let rank=1;all.forEach((x,i)=>{if(i&&!same(x,all[i-1]))rank=i+1;x.rank=rank});
  all.forEach(x=>{x.tieCount=all.filter(y=>same(x,y)).length});
  const size=all.length,trackedRanked=all.filter(x=>x.tracked);
  const groupOrder=[...tracked].sort((a,b)=>b.w-a.w||a.l-b.l||(tbFinal?a.diff-b.diff:0)||a.i-b.i).map(x=>x.name);
  const best=trackedRanked.reduce((a,b)=>b.rank<a.rank?b:a),pct=x=>Math.max(1,Math.ceil(x.rank/size*100));
  return{games,tiebreak:{game:`${tb.away}@${tb.home}`,total:tb.total,final:tbFinal},tieGames:games.filter(g=>g.tie).map(g=>g.score),
    tracked:Object.fromEntries(trackedRanked.map(x=>[x.name,{w:x.w,l:x.l,diff:x.diff,rank:x.rank,tieCount:x.tieCount,label:x.tieCount>1?`T-${x.rank}`:`#${x.rank}`,tiePick:x.tiePick}])),
    groupOrder,fieldSize:size,pulse:{bestName:best.name,bestLabel:best.tieCount>1?`T-${best.rank}`:`#${best.rank}`,bestPercent:pct(best),topQuarter:trackedRanked.filter(x=>pct(x)<=25).length,submitted:trackedRanked.length}};
}
async function scenarioWeek5(browser){
  const rec=recorder('week5-week8-readback');rec.browser=browser.version();
  let expected=null,pub=null;
  try{
    await step(rec,'V00','Published rows (anonymous Data API) + independent expectations from ESPN finals',async()=>{
      const {context,page}=await openTracker(browser,rec);
      try{
        const pk=await publishedRow(page,'nfl_pool_weeks',2026,5),sv=await publishedRow(page,'nfl_survivor_weeks',2026,8);
        expect(pk.status===200&&pk.rows.length===1&&sv.status===200&&sv.rows.length===1,'published rows not readable');
        pub={pickem:pk.rows[0],survivor:sv.rows[0]};
        const espn=await espnWeek(2026,5);
        expected=expectedPickem(pub.pickem.config,espn.events);
        return{pickem:{revision:pub.pickem.revision,source_filename:pub.pickem.source_filename,source_sha256:pub.pickem.source_sha256,games:pub.pickem.config.games.length,competitionSize:pub.pickem.config.competitionSize},
          survivor:{revision:pub.survivor.revision,source_filename:pub.survivor.source_filename,source_sha256:pub.survivor.source_sha256,tracked:pub.survivor.config.trackedEntries.map(x=>`${x.displayName}: ${x.picks.map(v=>v||'-').join(',')}`)},
          espnFetchedAt:new Date().toISOString(),expected};
      }finally{await context.close()}
    },{fatal:true});
    await step(rec,'V01','Desktop: selector → 2026 · Week 5; revision 3; Eastern header; 15/15 final; LIVE',async()=>{
      const {context,page}=await openTracker(browser,rec);
      try{
        await waitScored(page);await chooseWeek(page,'2026 · Week 5',5);
        const s=await trackerState(page);
        expect(/^Week 5 · revision 3 · Oct 8–Oct 12, 2026 · /.test(s.weekLine),`week line ${s.weekLine}`);
        expect(s.finals==='15/15'&&s.left==='0',`finals ${s.finals} left ${s.left}`);
        expect(/^LIVE/.test(s.sync),`sync ${s.sync}`);
        return{weekLine:s.weekLine,sync:s.sync,finals:s.finals,left:s.left,leader:s.leader,screenshot:await shot(page,'w5-01-desktop-home-week5-r3')};
      }finally{await context.close()}
    });
    await step(rec,'V02','Standings equal the independent computation (W–L, group order, Overall rank) — NYG 27–27 WSH graded as a loss for every tracked pick',async()=>{
      const {context,page}=await openTracker(browser,rec,{url:BASE+'?season=2026&week=5&view=standings'});
      try{
        await page.waitForFunction(()=>/Week 5 · revision 3/.test(document.getElementById('weekLine')?.textContent||''),null,{timeout:30000});
        await page.waitForFunction(()=>/LIVE|DELAYED/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});await sleep(1500);
        const s=await trackerState(page),rows=s.standings.map(r=>({name:r[1],overall:r[2],w:Number(r[3]),l:Number(r[4]),left:Number(r[5])}));
        expect(rows.map(r=>r.name).join()===expected.groupOrder.join(),`group order ${rows.map(r=>r.name)} != ${expected.groupOrder}`);
        for(const r of rows){const e=expected.tracked[r.name];expect(e&&r.w===e.w&&r.l===e.l&&r.left===0,`${r.name} ${r.w}-${r.l} != ${e?.w}-${e?.l}`);expect(r.overall.startsWith(e.label),`${r.name} overall "${r.overall}" != ${e.label}`)}
        const tieGrades=await page.evaluate(()=>{const d={contest:'pickem',snapshot:null};document.dispatchEvent(new CustomEvent('poolcenter:picks',{detail:d}));const g=(d.snapshot?.games||[]).find(x=>x.kind==='tie');return g?{status:g.status,away:g.away.code,home:g.home.code,awayScore:g.awayScore,homeScore:g.homeScore,picks:g.picks.map(p=>`${p.name}:${p.team}:${p.result}`)}:null});
        expect(tieGrades&&tieGrades.picks.length===4&&tieGrades.picks.every(p=>p.endsWith(':tie')),`tie game grades ${JSON.stringify(tieGrades)}`);
        expect(new Set(tieGrades.picks.map(p=>p.split(':')[1])).size===2,'tracked picks do not cover both sides of the tie');
        return{standings:s.standings,expected:expected.tracked,groupOrder:expected.groupOrder,tieGame:tieGrades,tbNote:s.tbNote,footer:s.footer,screenshot:await shot(page,'w5-02-desktop-standings-week5-r3')};
      }finally{await context.close()}
    });
    await step(rec,'V03','Home group-vs-field pulse equals the independent field ranking',async()=>{
      const {context,page}=await openTracker(browser,rec,{url:BASE+'?season=2026&week=5'});
      try{
        await page.waitForFunction(()=>document.querySelector('#homeFieldPulse [data-field-pulse]')?.dataset.fieldPulse==='ready',null,{timeout:60000});await sleep(800);
        const s=await trackerState(page),p=expected.pulse;
        expect(s.fieldPulse.includes(p.bestLabel)&&s.fieldPulse.includes(`of ${expected.fieldSize}`)&&s.fieldPulse.includes(`${p.bestName} · Top ${p.bestPercent}%`)&&new RegExp(`${p.topQuarter}\\s*of ${p.submitted} submitted`).test(s.fieldPulse),`pulse "${s.fieldPulse}" vs ${JSON.stringify(p)} of ${expected.fieldSize}`);
        return{fieldPulse:s.fieldPulse,expected:{...p,fieldSize:expected.fieldSize},screenshot:await shot(page,'w5-03-desktop-home-field-pulse-week5-r3')};
      }finally{await context.close()}
    });
    await step(rec,'V04','Games view: NYG–WAS card shows the final tie',async()=>{
      const {context,page}=await openTracker(browser,rec,{url:BASE+'?season=2026&week=5&view=games'});
      try{
        await page.waitForFunction(()=>/LIVE|DELAYED/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});await sleep(1500);
        const cards=await page.evaluate(()=>[...document.querySelectorAll('#gamegrid > *')].map(el=>el.innerText.replace(/\s+/g,' ').trim()).filter(Boolean));
        const tie=cards.find(c=>/NYG/.test(c)&&/WAS|WSH/.test(c));
        expect(tie&&/TIE/.test(tie)&&/27/.test(tie),`tie card ${tie}`);
        return{tieCard:tie,cards:cards.length,screenshot:await shot(page,'w5-04-desktop-games-week5-r3')};
      }finally{await context.close()}
    });
    await step(rec,'V05','Mobile 390: Week 5 standings and picks; no horizontal overflow',async()=>{
      const {context,page}=await openTracker(browser,rec,{width:390,height:844,mobile:true,url:BASE+'?season=2026&week=5&view=standings'});
      try{
        await page.waitForFunction(()=>/LIVE|DELAYED/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});await sleep(1500);
        const st=await measure(page),stShot=await shot(page,'w5-05-mobile-390-standings-week5-r3');
        await view(page,'picks');const pk=await measure(page),pkShot=await shot(page,'w5-05-mobile-390-picks-week5-r3');
        for(const m of [st,pk])expect(!m.horizontalOverflow&&m.innerWidth===390&&m.clientWidth===390&&m.scrollWidth===390,`overflow ${JSON.stringify(m)}`);
        return{measure:{standings:st,picks:pk},screenshots:[stShot,pkShot]};
      }finally{await context.close()}
    });
    await step(rec,'V06','Survivor archive Week 8 revision 3: every tracked entry OUT — W1 loss, W5 NFL tie, W8 loss',async()=>{
      const {context,page}=await openTracker(browser,rec,{url:BASE+'?view=survivor'});
      try{
        const s=await survivorWeek(page,'2026 · Week 8');
        expect(/Week 8 · revision 3/.test(s.meta),`meta ${s.meta}`);
        expect(s.stillIn==='0',`still in ${s.stillIn}`);
        const parts=s.tracked.split(' | ');
        const names=['D.C.','DJS','Thaddeus'];
        const status=name=>{const i=parts.indexOf(name);expect(i>=0,`${name} missing from the archive`);const ends=names.map(n=>parts.indexOf(n)).filter(j=>j>i);return parts.slice(i,ends.length?Math.min(...ends):parts.length).join(' | ')};
        expect(/OUT/.test(status('D.C.'))&&/Week 1/.test(status('D.C.')),'D.C. not OUT in Week 1');
        expect(/OUT/.test(status('DJS'))&&/tie/i.test(status('DJS')),'DJS not OUT by the tie');
        expect(/OUT/.test(status('Thaddeus'))&&/Week 8/.test(status('Thaddeus')),'Thaddeus not OUT in Week 8');
        return{...s,screenshot:await shot(page,'w5-06-desktop-archive-survivor-week8-r3')};
      }finally{await context.close()}
    });
  }finally{save(rec)}
}

// Signed-out run before any write: harness, network guard and publisher gates. Zero writes expected.
async function scenarioSmoke(browser){
  const rec=recorder('smoke-signed-out');rec.browser=browser.version();
  const context=await newContext(browser,rec,{viewport:{width:1280,height:900}});
  const page=await context.newPage();
  try{
    await step(rec,'Z01','Pick\'em publisher signed out: valid sheet previews; Publish disabled; nothing written',async()=>{
      await page.goto(BASE+'admin/',{waitUntil:'networkidle'});
      const shown=await page.evaluate(()=>document.querySelector('#signedOut .muted')?.textContent);
      const t=await pickemParse(page,'QA-FINAL-E2E-Pickem-2026-W5-r1.pdf');
      expect(t.messageClass.includes('success')&&t.publishDisabled===true,`state ${JSON.stringify(t)}`);
      const review=await pickemReview(page);
      return{authorizedEmailShown:shown,authState:t.authState,message:t.message,publishDisabled:t.publishDisabled,reviewTitle:review.title,dates:review.games.map(g=>g[4])};
    });
    await step(rec,'Z02','Survivor publisher signed out: valid sheet verifies, publishing blocked until sign-in',async()=>{
      await page.goto(BASE+'admin/survivor.html',{waitUntil:'networkidle'});
      const t=await survivorParse(page,'QA-FINAL-E2E-Survivor-2026-W8-r1.pdf');
      expect(t.messageClass.includes('success')&&t.publishDisabled===true&&/Sign in/.test(t.checks+t.message),`state ${JSON.stringify(t).slice(0,600)}`);
      return{message:t.message,reviewTitle:t.reviewTitle,publishDisabled:t.publishDisabled,blockingText:t.checks.split('\n').slice(0,3)};
    });
    await step(rec,'Z03','Tracker loads anonymously from the QA child through the local gateway',async()=>{
      await page.goto(BASE,{waitUntil:'networkidle'});
      await page.waitForFunction(()=>/LIVE|DELAYED|FEED UNAVAILABLE|ON HOLD|INCOMPLETE|STALE/.test(document.getElementById('sync')?.textContent||''),null,{timeout:60000});
      const s=await trackerState(page);
      return{sync:s.sync,weekSelected:s.weekSelected,weekOptions:s.weekOptions,weekLine:s.weekLine};
    });
    expect(rec.writes.length===0,'smoke run sent a write');
  }finally{await context.close();save(rec)}
}

(async()=>{
  const scenarios=process.argv.slice(2);
  const browser=await chromium.launch();
  try{
    for(const s of scenarios){
      if(s==='smoke')await scenarioSmoke(browser);
      else if(s==='negatives')await scenarioNegatives(browser);
      else if(s==='week5')await scenarioWeek5(browser);
      else if(s==='pickem')await scenarioPickem(browser);
      else if(s==='survivor')await scenarioSurvivor(browser);
      else if(s==='tracker')await scenarioTracker(browser);
      else if(s==='readback')await scenarioReadback(browser);
      else if(s==='cleanup'){if(fs.existsSync(STATE))fs.unlinkSync(STATE);console.log('auth storage state removed')}
      else throw new Error(`unknown scenario ${s}`);
    }
  }finally{await browser.close()}
})().catch(e=>{console.error('RUNNER ERROR',e?.message||e);process.exitCode=1});
