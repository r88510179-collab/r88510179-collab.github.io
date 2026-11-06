'use strict';
// QA ONLY (PR #29). Real-browser publisher acceptance against the isolated QA child branch only.
// Chromium loads the committed QA publisher pages from the local static server; files are chosen through the real file
// input; parsing, NFL schedule validation, sign-in and publishing run unmodified in the page. The runner never edits the
// DOM or responses. Its only network intervention is holding ONE publish PATCH (unchanged) to create a deterministic
// compare-and-swap race. Credentials come from a local file outside the repository and are never logged or saved;
// screenshots are taken only after the page has cleared its password field.
// Usage: node browser-e2e.cjs <credentials.json> <evidence dir> [phase: pickem|survivor|all]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/opt/node-tools/node_modules/playwright');
const [credsFile,outDir,phase='all']=process.argv.slice(2);
// Dry phases stop before the first publish, so selectors and gates can be checked without writing anything.
const DRY=phase.endsWith('-dry');
const creds=JSON.parse(fs.readFileSync(credsFile,'utf8'));
const BASE='http://localhost:8765/nfl-pool/admin/';
const FIX=path.resolve(__dirname,'../fixtures');
const manifest=JSON.parse(fs.readFileSync(path.join(FIX,'fixtures-manifest.json'),'utf8'));
const shots=path.join(outDir,'screenshots'),logs=path.join(outDir,'logs');
fs.mkdirSync(shots,{recursive:true});fs.mkdirSync(logs,{recursive:true});
const CHILD='ep-shiny-snow-bbx446zt';
const FORBIDDEN=[/ep-muddy-forest-au7eygkw/,/ep-silent-sunset-bbdqbm47/,/br-late-hat-b55ygmj4/,/picks\.smokkeventures\.com/,/r88510179-collab\.github\.io/];
const secretValues=[creds.publisher.password,creds.intruder.password];
const scrub=text=>{let s=String(text??'');for(const v of secretValues)if(v)s=s.split(v).join('[redacted]');return s.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,'[jwt-redacted]')};

const steps=[],network=[];let browser;
const stamp=()=>new Date().toISOString();
async function newPage(label){
  const context=await browser.newContext({viewport:{width:1180,height:900},deviceScaleFactor:2,serviceWorkers:'block',locale:'en-US',timezoneId:'America/New_York'});
  const page=await context.newPage(),consoleLog=[];
  page.on('console',m=>{if(['error','warning'].includes(m.type()))consoleLog.push(`${m.type()}: ${scrub(m.text()).slice(0,300)}`)});
  page.on('pageerror',e=>consoleLog.push(`pageerror: ${scrub(e.message).slice(0,300)}`));
  page.on('requestfinished',async r=>{const resp=await r.response().catch(()=>null);logRequest(label,r,resp?.status()??null,null)});
  page.on('requestfailed',r=>logRequest(label,r,null,r.failure()?.errorText||'failed'));
  return{context,page,label,consoleLog};
}
function logRequest(label,r,status,failure){
  const u=new URL(r.url());if(u.protocol==='data:'||u.protocol==='blob:')return;
  const isData=u.hostname===`${CHILD}.apirest.c-15.us-east-1.aws.neon.tech`;
  network.push({ctx:label,at:stamp(),method:r.method(),host:u.host,path:u.pathname,query:isData?u.search:undefined,type:r.resourceType(),status,failure});
}
async function shot(page,name){const file=path.join(shots,`${name}.jpg`);await page.screenshot({path:file,fullPage:true,type:'jpeg',quality:55});return path.relative(outDir,file)}
async function state(page){
  return page.evaluate(()=>{
    const $=id=>document.getElementById(id),txt=id=>$(id)?.textContent?.trim()??null;
    return{banner:txt('qaBanner'),bannerClass:$('qaBanner')?.className,identityNote:$('qaIdentityNote')?.hidden?null:txt('qaIdentityNote'),auth:txt('authState'),signedEmail:txt('signedEmail'),
      message:$('message')?.hidden?'':txt('message'),messageClass:$('message')?.className,busy:!$('busy')?.hidden,reviewHidden:$('review')?.hidden,
      reviewTitle:txt('reviewTitle'),validation:[...($('validation')?.querySelectorAll('span')||[])].map(s=>s.textContent.trim()),
      publishDisabled:$('publishBtn')?.disabled,replaceLocked:$('replaceLocked')?.checked,confirmShown:$('confirmWrap')?!$('confirmWrap').hidden:null,
      entries:[...($('entryReview')?.querySelectorAll('tr')||[])].map(tr=>[...tr.children].map(td=>td.textContent.trim())),
      games:[...($('gameReview')?.querySelectorAll('tr')||[])].map(tr=>[...tr.children].map(td=>td.textContent.trim())),
      checks:$('publishChecks')?.innerText?.trim()??null,confirmText:txt('confirmText'),
      qa:window.__qaPublisher?{verified:window.__qaPublisher.verified,networkRefusals:window.__qaPublisher.networkRefusals,identityRefusals:window.__qaPublisher.identityRefusals.map(r=>r.refusal)}:null};
  });
}
async function settle(page,predicate,arg,timeout=120000){
  await page.waitForFunction(([src,a])=>{const fn=new Function('s','a',`return (${src})(s,a)`);const $=id=>document.getElementById(id);
    const s={message:$('message')?.hidden?'':$('message')?.textContent||'',busy:!$('busy')?.hidden,reviewHidden:$('review')?.hidden,auth:$('authState')?.textContent||''};
    return !s.busy&&fn(s,a)},[predicate.toString(),arg],{timeout,polling:250});
  return state(page);
}
const writesTo=(label,table)=>network.filter(n=>n.ctx===label&&n.host.startsWith(`${CHILD}.apirest`)&&n.path.endsWith('/'+table)&&['POST','PATCH','DELETE'].includes(n.method));
async function step(id,name,fn){
  const started=stamp();
  try{const out=await fn();const pass=out.pass!==false;steps.push({id,name,started,finished:stamp(),pass,...out});console.log(`${pass?'PASS':'FAIL'} ${id} ${name}`);if(!pass)console.log('   observed: '+JSON.stringify(out.observed||{}).slice(0,600));return pass}
  catch(e){steps.push({id,name,started,finished:stamp(),pass:false,error:scrub(e.stack||e).slice(0,900)});console.log(`FAIL ${id} ${name}: ${scrub(e.message)}`);return false}
}
async function signIn(p,who){
  await p.page.fill('#qaEmail',creds[who].email);await p.page.fill('#qaPassword',creds[who].password);
  await p.page.click('#qaSignIn');
  return settle(p.page,s=>/^Sign(ed in securely|-in failed)/.test(s.message));
}
async function choose(p,file){await p.page.setInputFiles('#file',path.join(FIX,file));}
async function parse(p,predicate,timeout){await p.page.click('#parseBtn');return settle(p.page,predicate,null,timeout)}
const sha=file=>manifest[file].sha256;
const has=(text,part)=>String(text||'').includes(part);

async function pickem(){
  const A=await newPage('pickem-A');
  await step('P01','QA publisher page loads fail-closed configuration bound to the QA child; email codes hidden',async()=>{
    await A.page.goto(BASE,{waitUntil:'networkidle'});const s=await settle(A.page,s=>/SIGN IN REQUIRED|AUTHORIZED/.test(s.auth));
    const otpHidden=await A.page.evaluate(()=>document.getElementById('sendCode').hidden&&document.getElementById('otpWrap').hidden);
    return{observed:{banner:s.banner,bannerClass:s.bannerClass,auth:s.auth,otpHidden,qa:s.qa},screenshot:await shot(A.page,'pickem-01-qa-banner-signed-out'),
      pass:s.qa?.verified===true&&s.bannerClass==='qa-banner ok'&&has(s.banner,'child branch br-damp-credit-bbn7d0zr')&&has(s.banner,'endpoint ep-shiny-snow-bbx446zt')&&s.auth==='SIGN IN REQUIRED'&&otpHidden};
  });
  await step('P02','wrong account (synthetic, no publisher rights) is refused and signed out by the publisher',async()=>{
    const s=await signIn(A,'intruder');
    return{observed:{message:s.message,identityNote:s.identityNote,auth:s.auth,identityRefusals:s.qa?.identityRefusals},screenshot:await shot(A.page,'pickem-02-wrong-account-refused'),
      pass:s.message==='Sign-in failed: Authentication completed but no authorized session was created.'&&has(s.identityNote,'qa.pdf-e2e.intruder@example.com is not the authorized synthetic QA publisher')&&s.auth==='SIGN IN REQUIRED'};
  });
  await step('P03','synthetic QA publisher signs in through the QA child Neon Auth',async()=>{
    const s=await signIn(A,'publisher');
    return{observed:{message:s.message,auth:s.auth,signedEmail:s.signedEmail},screenshot:await shot(A.page,'pickem-03-publisher-signed-in'),
      pass:s.auth==='AUTHORIZED'&&s.signedEmail==='qa.pdf-e2e.publisher@example.com'&&s.message==='Signed in securely as the synthetic QA publisher.'};
  });
  const negative=async(id,name,file,expect,shotName)=>step(id,name,async()=>{
    await choose(A,file);const s=await parse(A,(s,a)=>s.message.length>0&&!/^Reading|^Signed in/.test(s.message));
    const ok=expect.every(part=>has(s.message,part));
    return{fixture:file,fixtureSha256:sha(file),observed:{message:s.message,messageClass:s.messageClass,reviewHidden:s.reviewHidden,publishDisabled:s.publishDisabled},screenshot:await shot(A.page,shotName),
      pass:ok&&s.messageClass==='notice error'&&s.reviewHidden===true&&s.publishDisabled===true&&writesTo('pickem-A','nfl_pool_weeks').length===0};
  });
  await negative('P04','malformed PDF is rejected by the PDF reader; nothing published','QA-PDF-E2E-malformed.pdf',['PDF READER FAILED (both pinned CDN sources)','No data has been published.'],'pickem-04-malformed-pdf');
  await negative('P05','tracked entry with a missing pick cell is rejected','QA-PDF-E2E-Pickem-2026-W10-missing-picks.pdf',['No complete tracked week was found.','JC: regular weekly row is structurally invalid'],'pickem-05-missing-picks');
  await negative('P06','duplicate tracked entry row is rejected','QA-PDF-E2E-Pickem-2026-W10-duplicate-tracked.pdf',['Multiple DJS rows found'],'pickem-06-duplicate-tracked');
  await negative('P07','sheet game that is not on the NFL Week 10 schedule is rejected','QA-PDF-E2E-Pickem-2026-W10-invalid-schedule.pdf',['Schedule mismatch for CHI at CIN. Found 0 matching NFL games.'],'pickem-07-invalid-schedule');
  for(const [id,variant,issue] of [['P08','unanchored','Participant-shaped PDF row exists outside the proven regular participant table'],['P09','duplicate-page','Duplicate PDF page or repeated source table region detected']]){
    await step(id,`field gate: ${variant} sheet keeps tracked entries valid but withholds full-field metrics (not published)`,async()=>{
      const file=`QA-PDF-E2E-Pickem-2026-W10-${variant}.pdf`;await choose(A,file);
      const s=await parse(A,s=>s.message.length>0&&!/^Reading/.test(s.message));
      return{fixture:file,fixtureSha256:sha(file),observed:{message:s.message,reviewTitle:s.reviewTitle,validation:s.validation},screenshot:await shot(A.page,`pickem-${id.slice(1)}-${variant}-field-gate`),
        pass:has(s.message,`Full-field metrics unavailable — ${issue}`)&&s.validation.some(v=>has(v,'Full-field metrics unavailable'))&&s.validation.includes('✓ NFL schedule matched')&&s.reviewTitle==='2026 · Week 10 · 14 games · 4 entries'};
    });
  }
  const r1='QA-PDF-E2E-Pickem-2026-W10-r1.pdf',r2='QA-PDF-E2E-Pickem-2026-W10-r2.pdf';
  await step('P10','revision-1 multi-page sheet: parser preview, tracked rows, 43-entry field and NFL Week 10 schedule match',async()=>{
    await choose(A,r1);const s=await parse(A,s=>!s.reviewHidden||/error/.test(s.message));
    const byName=Object.fromEntries(s.entries.map(r=>[r[0],r]));
    return{fixture:r1,fixtureSha256:sha(r1),observed:{message:s.message,reviewTitle:s.reviewTitle,validation:s.validation,entries:s.entries,games:s.games},screenshot:await shot(A.page,'pickem-10-r1-preview'),
      pass:s.message==='Week 10 parsed with 43 competition entries and matched to the NFL schedule. Review it before publishing.'&&s.reviewTitle==='2026 · Week 10 · 14 games · 43 entries'
        &&['✓ Tracked rows valid','✓ Four tracked entries found','✓ Anonymous privacy allowlist enforced',"✓ Full-field regular Pick'em data validated · 43 entries",'✓ NFL schedule matched'].every(v=>s.validation.includes(v))
        &&s.entries.length===4&&byName.Thaddeus?.[1]==='NO PICKS SUBMITTED'&&['D.C.','JC','DJS'].every(n=>byName[n]?.[1]?.split(' ').length===14)
        &&s.games.length===14&&s.games.every(g=>/^2026-11-1[3-7]$/.test(g[4]))&&s.publishDisabled===false};
  });
  if(DRY){steps.push({id:'pickem-A-guard',name:'pickem-A: network guard and identity log (dry run)',pass:true,observed:(await state(A.page)).qa,console:A.consoleLog});await A.context.close();return}
  await step('P11','publish revision 1 (double-dispatched click) writes exactly one locked row',async()=>{
    const before=writesTo('pickem-A','nfl_pool_weeks').length;
    await A.page.evaluate(()=>{const b=document.getElementById('publishBtn');b.dispatchEvent(new Event('click'));b.dispatchEvent(new Event('click'))});
    const s=await settle(A.page,s=>/published and locked|failed|refused|error/i.test(s.message));
    const writes=writesTo('pickem-A','nfl_pool_weeks').slice(before);
    return{fixture:r1,observed:{message:s.message,writes},screenshot:await shot(A.page,'pickem-11-r1-published'),
      pass:s.message==='Week 10 published and locked successfully. Revision 1.'&&writes.length===1&&writes[0].method==='POST'&&writes[0].status===201};
  });
  await step('P12','duplicate submission: publishing the locked week again is refused without a write',async()=>{
    const before=writesTo('pickem-A','nfl_pool_weeks').length;
    await A.page.click('#publishBtn');const first=await settle(A.page,s=>/already locked/.test(s.message));
    await choose(A,r1);await parse(A,s=>!s.reviewHidden);await A.page.click('#publishBtn');
    const second=await settle(A.page,s=>/already locked/.test(s.message));
    return{observed:{sameCandidate:first.message,freshUploadOfSameFile:second.message,writes:writesTo('pickem-A','nfl_pool_weeks').length-before},screenshot:await shot(A.page,'pickem-12-duplicate-refused'),
      pass:[first,second].every(s=>s.message==='Week 10 is already locked. Check “replace locked week” only if you intentionally need to correct it.')&&writesTo('pickem-A','nfl_pool_weeks').length===before};
  });
  // Revision 2 and a deterministic compare-and-swap race between two signed-in publisher sessions.
  const B=await newPage('pickem-B'),C=await newPage('pickem-C');
  for(const p of [B,C]){await p.page.goto(BASE,{waitUntil:'networkidle'});await settle(p.page,s=>/REQUIRED|AUTHORIZED/.test(s.auth));await signIn(p,'publisher')}
  await step('P13','revision-2 sheet parses; without “replace” the locked week is refused (locking)',async()=>{
    await choose(B,r2);const s=await parse(B,s=>!s.reviewHidden||/error/.test(s.message));
    await B.page.click('#publishBtn');const locked=await settle(B.page,s=>/already locked/.test(s.message));
    const thaddeus=s.entries.find(r=>r[0]==='Thaddeus');
    return{fixture:r2,fixtureSha256:sha(r2),observed:{reviewTitle:s.reviewTitle,thaddeus,locked:locked.message,writes:writesTo('pickem-B','nfl_pool_weeks').length},screenshot:await shot(B.page,'pickem-13-r2-locked-without-replace'),
      pass:s.reviewTitle==='2026 · Week 10 · 14 games · 43 entries'&&thaddeus?.[1]?.split(' ').length===14&&thaddeus?.[2]==='41'&&has(locked.message,'Week 10 is already locked.')&&writesTo('pickem-B','nfl_pool_weeks').length===0};
  });
  let release;
  await step('P14','stale-revision race: a held write from a second session loses compare-and-swap after revision 2 lands',async()=>{
    await choose(C,r2);await parse(C,s=>!s.reviewHidden);await C.page.check('#replaceLocked');
    let held=false;const gate=new Promise(r=>{release=r});
    await C.page.route('**/nfl_pool/rest/v1/nfl_pool_weeks**',async route=>{if(route.request().method()==='PATCH'&&!held){held=true;await gate}await route.continue()});
    await C.page.click('#publishBtn');
    for(let i=0;i<120&&!held;i++)await C.page.waitForTimeout(250);
    if(!held)throw new Error('the second session never dispatched its write');
    await B.page.check('#replaceLocked');await B.page.click('#publishBtn');
    const b=await settle(B.page,s=>/published and locked|failed|error/i.test(s.message));
    release();
    const c=await settle(C.page,s=>/Publish failed|published and locked|not confirmed|unknown/.test(s.message));
    const bWrites=writesTo('pickem-B','nfl_pool_weeks'),cWrites=writesTo('pickem-C','nfl_pool_weeks');
    return{fixture:r2,observed:{winner:b.message,loser:c.message,winnerWrites:bWrites,loserWrites:cWrites},screenshots:[await shot(B.page,'pickem-14a-r2-revision-2-published'),await shot(C.page,'pickem-14b-stale-cas-refused')],
      pass:b.message==='Week 10 published and locked successfully. Revision 2.'&&c.message==='Publish failed: Week 10 changed before this write (no row matched revision 1). Nothing from this stale attempt was written. Read and validate the sheet again before publishing.'
        &&bWrites.length===1&&/revision=eq\.1/.test(bWrites[0].query)&&bWrites[0].status===200&&cWrites.length===1&&/revision=eq\.1/.test(cWrites[0].query)&&cWrites[0].status===200};
  }).finally?.(()=>release?.());
  for(const p of [A,B,C])steps.push({id:`${p.label}-guard`,name:`${p.label}: network guard and identity log at end of session`,pass:true,observed:(await state(p.page)).qa,console:p.consoleLog});
  for(const p of [A,B,C])await p.context.close();
}

async function survivor(){
  const URL=BASE+'survivor.html';
  const A=await newPage('survivor-A');
  await step('S01','Survivor QA publisher page loads the QA child configuration; synthetic publisher signs in',async()=>{
    await A.page.goto(URL,{waitUntil:'networkidle'});const before=await settle(A.page,s=>/REQUIRED|AUTHORIZED/.test(s.auth));
    const s=await signIn(A,'publisher');
    return{observed:{banner:before.banner,auth:s.auth,message:s.message},screenshot:await shot(A.page,'survivor-01-signed-in'),
      pass:before.qa?.verified===true&&has(before.banner,'child branch br-damp-credit-bbn7d0zr')&&s.auth==='AUTHORIZED'};
  });
  const negative=async(id,name,file,expect,shotName)=>step(id,name,async()=>{
    await choose(A,file);await A.page.click('#parseBtn');
    const s=await settle(A.page,s=>s.message.length>0&&/error|failed|Multiple|unknown|cannot/i.test(s.message),null,150000);
    return{fixture:file,fixtureSha256:sha(file),observed:{message:s.message,reviewHidden:s.reviewHidden,publishDisabled:s.publishDisabled},screenshot:await shot(A.page,shotName),
      pass:expect.every(part=>has(s.message,part))&&s.reviewHidden===true&&s.publishDisabled===true&&writesTo('survivor-A','nfl_survivor_weeks').length===0};
  });
  await negative('S02','malformed PDF is rejected by the PDF reader','QA-PDF-E2E-malformed.pdf',['PDF READER FAILED (both pinned CDN sources)'],'survivor-02-malformed-pdf');
  await negative('S03','unknown team code is rejected by the parser','QA-PDF-E2E-Survivor-2026-W6-unknown-team.pdf',['DJS: unknown Week 4 team XYZ'],'survivor-03-unknown-team');
  await negative('S04','duplicate tracked Survivor row is rejected','QA-PDF-E2E-Survivor-2026-W6-duplicate-tracked.pdf',['Multiple DJS Survivor rows found'],'survivor-04-duplicate-tracked');
  await negative('S05','pick of a team on its bye week (absent from the NFL Week 5 schedule) blocks publication','QA-PDF-E2E-Survivor-2026-W6-bye-pick.pdf',['NFL schedule verification failed; this sheet cannot be published','Week 5: KC is not scheduled in verified NFL Week 5 (bye or invalid team)'],'survivor-05-bye-week-pick');
  const r1='QA-PDF-E2E-Survivor-2026-W6-r1.pdf',r2='QA-PDF-E2E-Survivor-2026-W6-r2.pdf';
  await step('S06','revision-1 Survivor sheet: selection history, eligibility, tie, reused-team and loss checks require explicit confirmation',async()=>{
    await choose(A,r1);await A.page.click('#parseBtn');
    const after=await settle(A.page,s=>/parsed and matched to the NFL schedule|failed|error/i.test(s.message),null,150000);
    return{fixture:r1,fixtureSha256:sha(r1),observed:{message:after.message,reviewTitle:after.reviewTitle,validation:after.validation,entries:after.entries,checks:after.checks,confirmShown:after.confirmShown,confirmText:after.confirmText,publishDisabled:after.publishDisabled},screenshot:await shot(A.page,'survivor-06-r1-preview-checks'),
      pass:after.reviewTitle==='2026 · Week 6 · 4 entries · 3 with Week 6 pick'&&after.validation.includes('✓ NFL schedule verified for Weeks 1–6')
        &&has(after.checks,'1 of 1 entries alive entering Week 6 has no Week 6 pick (including Thaddeus). Publishing shows it OUT (no pick) in Week 6.')
        &&has(after.checks,"3 entries already eliminated before Week 6 still show a Week 6 pick (1 OUT by NE's Week 1 loss; 1 OUT by NYG's Week 5 tie; 1 OUT by repeating KC in Week 3).")
        &&has(after.checks,'Entry count and Weeks 1–2 pick histories match published Week 2 (revision 2).')
        &&after.entries.find(r=>r[0]==='Thaddeus')?.[2]==='NO PICK'&&after.confirmShown===true&&after.publishDisabled===true};
  });
  if(DRY){steps.push({id:'survivor-A-guard',name:'survivor-A: network guard and identity log (dry run)',pass:true,observed:(await state(A.page)).qa,console:A.consoleLog});await A.context.close();return}
  await step('S07','publish revision 1 after confirmation (double-dispatched click) writes exactly one locked row',async()=>{
    await A.page.check('#confirmPartial');
    await A.page.evaluate(()=>{const b=document.getElementById('publishBtn');b.dispatchEvent(new Event('click'));b.dispatchEvent(new Event('click'))});
    const s=await settle(A.page,s=>/published and locked|failed|refused|error/i.test(s.message));
    const writes=writesTo('survivor-A','nfl_survivor_weeks');
    return{fixture:r1,observed:{message:s.message,writes,publishDisabledAfter:s.publishDisabled},screenshot:await shot(A.page,'survivor-07-r1-published'),
      pass:s.message==='Survivor Week 6 published and locked. Revision 1.'&&writes.length===1&&writes[0].method==='POST'&&writes[0].status===201&&s.publishDisabled===true};
  });
  await step('S08','duplicate submission: the same sheet re-validated is identical to revision 1 and is refused while locked',async()=>{
    await choose(A,r1);await A.page.click('#parseBtn');
    const s=await settle(A.page,s=>/parsed and matched to the NFL schedule|failed|error/i.test(s.message),null,150000);
    await A.page.check('#confirmPartial');await A.page.click('#publishBtn');
    const r=await settle(A.page,s=>/already locked/.test(s.message));
    return{observed:{checks:s.checks,message:r.message,writes:writesTo('survivor-A','nfl_survivor_weeks').length},screenshot:await shot(A.page,'survivor-08-duplicate-refused'),
      pass:has(s.checks,'This sheet is identical to published Week 6 revision 1 (entries and Weeks 1–6 pick histories).')&&has(s.checks,'Published Survivor weeks visible for 2026: 2, 6, 9.')
        &&r.message==='Survivor Week 6 is already locked. Check replace only for an intentional correction. Nothing was written.'&&writesTo('survivor-A','nfl_survivor_weeks').length===1};
  });
  const B=await newPage('survivor-B'),C=await newPage('survivor-C');
  for(const p of [B,C]){await p.page.goto(URL,{waitUntil:'networkidle'});await settle(p.page,s=>/REQUIRED|AUTHORIZED/.test(s.auth));await signIn(p,'publisher')}
  await step('S09','stale validation: a sheet validated before another session publishes revision 2 is refused without writing',async()=>{
    for(const p of [C,B]){await choose(p,r2);await p.page.click('#parseBtn');await settle(p.page,s=>/parsed and matched to the NFL schedule|failed|error/i.test(s.message),null,150000);await p.page.check('#confirmPartial');await p.page.check('#replaceLocked')}
    const pre=await state(B.page);
    await B.page.click('#publishBtn');const b=await settle(B.page,s=>/published and locked|failed|error/i.test(s.message));
    await C.page.click('#publishBtn');const c=await settle(C.page,s=>/changed since|published and locked|failed/i.test(s.message));
    const bWrites=writesTo('survivor-B','nfl_survivor_weeks'),cWrites=writesTo('survivor-C','nfl_survivor_weeks');
    return{fixture:r2,fixtureSha256:sha(r2),observed:{checksBeforePublish:pre.checks,thaddeus:pre.entries.find(r=>r[0]==='Thaddeus'),winner:b.message,stale:c.message,winnerWrites:bWrites,staleWrites:cWrites.length},screenshots:[await shot(B.page,'survivor-09a-r2-revision-2-published'),await shot(C.page,'survivor-09b-stale-validation-refused')],
      pass:b.message==='Survivor Week 6 published and locked. Revision 2.'&&bWrites.length===1&&/revision=eq\.1/.test(bWrites[0].query)&&bWrites[0].status===200
        &&c.message==='Published Survivor weeks for 2026 changed since this sheet was validated. Nothing was written. Read & validate again.'&&cWrites.length===0
        &&has(pre.checks,'This replaces published Week 6 revision 1:')&&pre.entries.find(r=>r[0]==='Thaddeus')?.[2]==='PIT'};
  });
  const D=await newPage('survivor-D');
  await step('S10','wrong account is refused on the Survivor publisher',async()=>{
    await D.page.goto(URL,{waitUntil:'networkidle'});await settle(D.page,s=>/REQUIRED|AUTHORIZED/.test(s.auth));
    const s=await signIn(D,'intruder');
    return{observed:{message:s.message,identityNote:s.identityNote,auth:s.auth},screenshot:await shot(D.page,'survivor-10-wrong-account-refused'),
      pass:s.message==='Sign-in failed: Authentication completed but no authorized session was created.'&&has(s.identityNote,'is not the authorized synthetic QA publisher')&&s.auth==='SIGN IN REQUIRED'};
  });
  const E=await newPage('survivor-E');
  await step('S11','new browser session: authenticated publisher comparison reads back revision 2 exactly',async()=>{
    await E.page.goto(URL,{waitUntil:'networkidle'});await settle(E.page,s=>/REQUIRED|AUTHORIZED/.test(s.auth));await signIn(E,'publisher');
    await choose(E,r2);await E.page.click('#parseBtn');const s=await settle(E.page,s=>/parsed and matched to the NFL schedule|failed|error/i.test(s.message),null,150000);
    return{fixture:r2,observed:{checks:s.checks,entries:s.entries},screenshot:await shot(E.page,'survivor-11-new-session-readback'),
      pass:has(s.checks,'This sheet is identical to published Week 6 revision 2 (entries and Weeks 1–6 pick histories).')&&has(s.checks,'Published Survivor weeks visible for 2026: 2, 6, 9.')&&writesTo('survivor-E','nfl_survivor_weeks').length===0};
  });
  for(const p of [A,B,C,D,E])steps.push({id:`${p.label}-guard`,name:`${p.label}: network guard and identity log at end of session`,pass:true,observed:(await state(p.page)).qa,console:p.consoleLog});
  for(const p of [A,B,C,D,E])await p.context.close();
}

(async()=>{
  browser=await chromium.launch();
  const meta={startedAt:stamp(),browser:`chromium ${browser.version()}`,base:BASE,phase,fixtures:Object.fromEntries(Object.entries(manifest).map(([k,v])=>[k,v.sha256]))};
  try{if(/^pickem|^all/.test(phase))await pickem();if(/^survivor|^all/.test(phase))await survivor()}
  finally{await browser.close()}
  const forbidden=network.filter(n=>FORBIDDEN.some(re=>re.test(n.host)));
  const neonHosts=[...new Set(network.filter(n=>/neon\.tech$/.test(n.host)).map(n=>n.host))];
  const isolation={forbiddenRequests:forbidden,neonHostsContacted:neonHosts,onlyChildNeon:neonHosts.every(h=>h.startsWith(CHILD+'.')),pass:forbidden.length===0&&neonHosts.every(h=>h.startsWith(CHILD+'.'))};
  const summary={...meta,finishedAt:stamp(),steps:steps.length,passed:steps.filter(s=>s.pass).length,failed:steps.filter(s=>!s.pass).map(s=>s.id),isolation};
  const tag=phase==='all'?'':`-${phase}`;
  fs.writeFileSync(path.join(logs,`browser-e2e${tag}.json`),scrub(JSON.stringify({summary,steps},null,1)));
  fs.writeFileSync(path.join(logs,`browser-network${tag}.json`),scrub(JSON.stringify(network,null,0).replace(/\},\{/g,'},\n{')));
  console.log(JSON.stringify(summary,null,1));
  process.exitCode=summary.failed.length||!isolation.pass?1:0;
})().catch(e=>{console.error(scrub(e.stack||e));process.exitCode=2});
