'use strict';
// PR #30 final mobile acceptance (6 Nov 2026): inspection-only Week 10 selector check on the existing PR #29 QA preview.
//
// Target: SSO-protected Vercel preview dpl_B5FasHyJc66368k2Dmp5Cu6MUqEa (QA app commit 68feca1). Its tracker reads the
// synthetic Pick'em Week 10 revision-2 publication from Neon green-base-66242978 / br-damp-credit-bbn7d0zr / nfl_pool,
// only through the read-only same-origin /api/qa-read gateway. Vercel protection stays on: access reuses the existing
// temporary deployment share link, read from a local file and scrubbed from every output.
//
// The only change to the page is a <style> element holding the exact bytes of nfl-pool/week-selector.css from PR #30
// commit 34788854, inserted directly after the season-record.css <link> (where PR #30 adds its own <link>), inside
// throwaway browser contexts. No request, response, storage, application data or database is altered: the runner reads
// the DOM, measures geometry, takes screenshots, and switches weeks with the selector the way a user would.
//
// Usage (from a checkout containing the commits below): node week-selector-mobile.cjs <share-url file> <evidence dir>
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const PW=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=require(PW),PLAYWRIGHT_VERSION=require(PW+'/package.json').version;

const FIX='34788854438144868fefe6f3c61aeb0676e9b5a6';   // PR #30 head: exact CSS under test
const BASE='cdd66095a7834edf1111c319736db6e7bddee17d';  // PR #30 base (main): production CSS baseline
const APP='68feca130fc81f3e5331b893861c61f52784bb1e';   // app commit of the QA deployment
const PR29='e39368f65b34372309c7fe7583bf59c1aa5bd431';  // PR #29 evidence commit: recorded Week 10 read-back
const DEPLOYMENT='dpl_B5FasHyJc66368k2Dmp5Cu6MUqEa',CHILD_ENDPOINT='ep-shiny-snow-bbx446zt';
const WIDTHS=[375,390,430],WEEK10='/nfl-pool/?view=standings&season=2026&week=10';
const FORBIDDEN=[/ep-muddy-forest-au7eygkw/,/ep-silent-sunset-bbdqbm47/,/br-late-hat-b55ygmj4/,/picks\.smokkeventures\.com/];
const PROBE_FONTS=['DejaVu Sans','Liberation Sans','FreeSans']; // wider installed faces: margin check for device fonts
const TWO_DIGIT=Array.from({length:9},(_,i)=>`2026 · Week ${10+i}`);
const INSPECTION_ID='pr30-week-selector';

const git=(...args)=>execFileSync('git',args,{cwd:__dirname,maxBuffer:64<<20});
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
const CSS_BYTES=git('show',`${FIX}:nfl-pool/week-selector.css`),CSS=CSS_BYTES.toString('utf8');
const CSS_BLOB=git('rev-parse',`${FIX}:nfl-pool/week-selector.css`).toString().trim();
const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
const pr29=JSON.parse(git('show',`${PR29}:nfl-pool/acceptance/pdf-e2e-20261105/logs/tracker-mobile.json`).toString('utf8'));
const REFERENCE=Object.fromEntries(pr29.results.map(r=>[r.width,{weekLine:r.pickem.weekLine,weekOptions:r.pickem.weekOptions,
  standings:r.pickem.standings.map(row=>row.map(norm)),selectFit:r.pickem.selectFit}]));

const [shareFile,outDir]=process.argv.slice(2);
const share=new URL(fs.readFileSync(shareFile,'utf8').trim());
const ORIGIN=share.origin,SHARE_PARAM=share.searchParams.get('_vercel_share');
if(!SHARE_PARAM)throw new Error('share link file has no _vercel_share parameter');
const scrub=s=>String(s??'').split(SHARE_PARAM).join('[share-token-redacted]');
const shots=path.join(outDir,'screenshots'),logs=path.join(outDir,'logs');
fs.mkdirSync(shots,{recursive:true});fs.mkdirSync(logs,{recursive:true});

// Runs in the page before any app script; places the PR #30 rules where PR #30's <link> goes. Top frame only.
function insertInspectionStyle({css,id}){
  if(window.top!==window)return;
  const make=()=>{const s=document.createElement('style');s.setAttribute('data-qa-inspection',id);s.textContent=css;return s};
  const place=()=>{
    if(document.querySelector(`style[data-qa-inspection="${id}"]`))return true;
    const link=document.querySelector('link[rel="stylesheet"][href="season-record.css?v=1"]');
    if(!link)return false;link.after(make());return true;
  };
  if(place())return;
  const mo=new MutationObserver(()=>{if(place())mo.disconnect()});
  mo.observe(document,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',()=>{mo.disconnect();if(!place())document.head.appendChild(make())},{once:true});
}

// Read-only geometry/DOM measurement (canvas text metrics use the select's computed font, as in PR #29).
function measureInPage({probeFonts,twoDigit,id}){
  window.scrollTo({left:0,top:0,behavior:'instant'});
  const $=x=>document.getElementById(x),root=document.documentElement,vw=innerWidth;
  const box=el=>{const b=el.getBoundingClientRect();return{left:+b.left.toFixed(2),right:+b.right.toFixed(2),width:+b.width.toFixed(2),top:+b.top.toFixed(2),height:+b.height.toFixed(2)}};
  const sel=$('weekSelect'),strip=document.querySelector('.week-strip'),copy=strip.querySelector(':scope > .week-copy'),line=$('weekLine');
  const cs=getComputedStyle(sel),ccs=getComputedStyle(copy),scs=getComputedStyle(strip),lcs=getComputedStyle(line);
  const ctx=document.createElement('canvas').getContext('2d');
  const textW=(text,style=cs,family=style.fontFamily)=>{ctx.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${family}`;
    ctx.letterSpacing=style.letterSpacing==='normal'?'0px':style.letterSpacing;return ctx.measureText(text).width};
  const label=(sel.selectedOptions[0]?.textContent||'').trim();
  const padL=parseFloat(cs.paddingLeft),padR=parseFloat(cs.paddingRight),contentBox=sel.clientWidth-padL-padR,labelWidth=textW(label);
  // The adjacent week summary may truncate by design; record what remains visible before the ellipsis.
  const full=line.textContent.trim();let visible=full;
  if(line.scrollWidth>line.clientWidth){const avail=line.clientWidth-textW('…',lcs);let n=0;while(n<full.length&&textW(full.slice(0,n+1),lcs)<=avail)n++;visible=full.slice(0,n).trimEnd()+'…'}
  const sx=scrollX,sy=scrollY;window.scrollTo({left:100000,top:sy,behavior:'instant'});const maxScrollX=scrollX;window.scrollTo({left:sx,top:sy,behavior:'instant'});
  const stripBox=box(strip),selBox=box(sel),copyBox=box(copy);
  const stripInnerRight=stripBox.right-parseFloat(scs.borderRightWidth)-parseFloat(scs.paddingRight);
  const injected=document.querySelector(`style[data-qa-inspection="${id}"]`);
  const sheets=[...document.styleSheets].map(s=>s.href?(u=>u.pathname.split('/').pop()+u.search)(new URL(s.href)):(s.ownerNode?.getAttribute?.('data-qa-inspection')?'inline:'+s.ownerNode.getAttribute('data-qa-inspection'):'inline'));
  const widest=twoDigit.reduce((m,t)=>Math.max(m,textW(t)),0);
  return{
    innerWidth:vw,innerHeight,devicePixelRatio,clientWidth:root.clientWidth,scrollWidth:root.scrollWidth,bodyScrollWidth:document.body.scrollWidth,maxScrollX,
    view:document.body.dataset.view||null,url:location.pathname+location.search,sync:$('sync')?.innerText?.trim()??null,
    weekLine:full,weekLineVisible:visible,weekLineTruncated:line.scrollWidth>line.clientWidth,
    weekSelected:label,weekValue:sel.value,weekOptions:[...sel.options].map(o=>o.textContent.trim()),
    standings:[...document.querySelectorAll('#standings tr')].map(tr=>[...tr.children].map(td=>td.innerText.replace(/\s+/g,' ').trim())),
    brokenImages:[...document.images].filter(i=>i.complete&&i.naturalWidth===0&&i.getBoundingClientRect().width>0).length,
    select:{box:selBox,clientWidth:sel.clientWidth,paddingLeft:padL,paddingRight:padR,borderLeft:parseFloat(cs.borderLeftWidth),borderRight:parseFloat(cs.borderRightWidth),
      contentBoxWidth:+contentBox.toFixed(2),font:`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,letterSpacing:cs.letterSpacing,disabled:sel.disabled,
      computed:{width:cs.width,minWidth:cs.minWidth,maxWidth:cs.maxWidth,flexGrow:cs.flexGrow,flexShrink:cs.flexShrink,flexBasis:cs.flexBasis}},
    label:{text:label,width:+labelWidth.toFixed(2),textWidthCeil:Math.ceil(labelWidth),contentBoxFloor:Math.floor(contentBox),
      fits:Math.ceil(labelWidth)<=Math.floor(contentBox),headroom:+(contentBox-labelWidth).toFixed(2)},
    twoDigitLabels:{widest:+widest.toFixed(2),allFit:Math.ceil(widest)<=Math.floor(contentBox)},
    probeFonts:probeFonts.map(f=>{const w=twoDigit.reduce((m,t)=>Math.max(m,textW(t,cs,`"${f}"`)),0);return{family:f,widestTwoDigitLabel:+w.toFixed(2),fits:Math.ceil(w)<=Math.floor(contentBox)}}),
    copy:{box:copyBox,computed:{flexGrow:ccs.flexGrow,flexShrink:ccs.flexShrink,flexBasis:ccs.flexBasis,minWidth:ccs.minWidth}},
    line:{box:box(line),clientWidth:line.clientWidth,scrollWidth:line.scrollWidth},
    strip:{box:stripBox,contentRight:+stripInnerRight.toFixed(2),count:document.querySelectorAll('.week-strip').length},
    layout:{stripInsideViewport:stripBox.left>=-0.5&&stripBox.right<=vw+0.5,selectInsideStrip:selBox.left>=stripBox.left&&selBox.right<=stripInnerRight+0.5,
      copyEndsBeforeSelect:copyBox.right<=selBox.left+0.5},
    hitTest:(()=>{const b=sel.getBoundingClientRect();return[[b.left+8,b.top+b.height/2],[b.left+b.width/2,b.top+b.height/2],[b.right-8,b.top+b.height/2]].map(([x,y])=>document.elementFromPoint(x,y)===sel)})(),
    injection:injected?{present:true,inHead:injected.parentNode===document.head,
      afterSeasonRecordLink:injected.previousElementSibling?.matches('link[rel="stylesheet"][href="season-record.css?v=1"]')??false,
      matched:{weekCopy:document.querySelectorAll('.week-strip > .week-copy').length,weekSelect:document.querySelectorAll('.week-strip > #weekSelect').length},
      laterStylesheets:sheets.slice(sheets.indexOf('inline:'+id)+1),text:injected.textContent}:{present:false},
    stylesheets:sheets
  };
}

(async()=>{
  const browser=await chromium.launch(),CHROMIUM_VERSION=browser.version();
  const network=[],servedCss={},servedIndex={},results=[];
  try{
    for(const width of WIDTHS){
      const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,
        serviceWorkers:'block',locale:'en-US',timezoneId:'America/New_York'});
      const page=await context.newPage();let phase='share-link';
      const appConsole=[],harnessConsole=[],pageErrors=[],failedRequests=[],abortedRequests=[],httpErrors=[],gateway=[];
      page.on('console',m=>{if(!['error','warning'].includes(m.type()))return;const t=`${m.type()}: ${scrub(m.text()).slice(0,300)}`;
        (/Service Worker registration blocked/i.test(m.text())?harnessConsole:appConsole).push({phase,text:t})});
      page.on('pageerror',e=>pageErrors.push({phase,text:scrub(e.message).slice(0,300)}));
      page.on('requestfailed',r=>{let u;try{u=new URL(r.url())}catch{return}const f=r.failure()?.errorText||'';
        const row={phase,method:r.method(),host:u.host,path:u.pathname,failure:f};(f==='net::ERR_ABORTED'?abortedRequests:failedRequests).push(row)});
      page.on('response',async r=>{
        let u;try{u=new URL(r.url())}catch{return}if(!u.protocol.startsWith('http'))return;
        const row={width,phase,method:r.request().method(),host:u.host,path:u.pathname,status:r.status(),type:r.request().resourceType()};network.push(row);
        if(r.status()>=400)httpErrors.push(row);
        if(u.origin!==ORIGIN)return;
        if(u.pathname==='/api/qa-read'){const h=await r.allHeaders();gateway.push({phase,resource:u.searchParams.get('resource')||u.searchParams.get('kind'),status:r.status(),backend:h['x-qa-backend']||null,readOnly:h['x-qa-read-only']||null})}
        else if(/^\/nfl-pool\/[^/]+\.css$/.test(u.pathname)&&r.status()===200){try{servedCss[u.pathname.split('/').pop()+u.search]=sha256(await r.body())}catch{}}
        else if(u.pathname==='/nfl-pool/'&&r.request().resourceType()==='document'&&r.status()===200){try{servedIndex[width]=sha256(await r.body())}catch{}}
      });
      const ready=(re)=>page.waitForFunction(src=>document.querySelectorAll('#standings tr').length>=4&&new RegExp(src).test(document.getElementById('weekLine')?.textContent||''),re,{timeout:60000}).then(()=>true,()=>false);
      const measure=()=>page.evaluate(measureInPage,{probeFonts:PROBE_FONTS,twoDigit:TWO_DIGIT,id:INSPECTION_ID});
      const shot=(name)=>path.join(shots,name);

      // Opening the share link sets the protection-bypass cookie for this fresh session only.
      await page.goto(share.href,{waitUntil:'domcontentloaded'});

      // Control: the deployed production CSS alone (expected to reproduce PR #29's clipped "Week 1").
      phase='control-main-css';
      await page.goto(ORIGIN+WEEK10,{waitUntil:'networkidle'});
      const controlReady=await ready('^Week 10 · revision 2 · ');await page.waitForTimeout(1500);
      const control=await measure();
      await page.locator('.week-strip').screenshot({path:shot(`pickem-week10-strip-control-${width}.png`)});

      // PR #30 CSS present from first render, at PR #30's <link> position; fresh load of the same Week 10 view.
      phase='pr30-css';
      await page.addInitScript(insertInspectionStyle,{css:CSS,id:INSPECTION_ID});
      await page.goto(ORIGIN+WEEK10,{waitUntil:'networkidle'});
      const fixReady=await ready('^Week 10 · revision 2 · ');await page.waitForTimeout(1500);
      const fixed=await measure();
      await page.locator('.week-strip').screenshot({path:shot(`pickem-week10-strip-pr30-${width}.png`)});
      await page.screenshot({path:shot(`pickem-week10-viewport-pr30-${width}.jpg`),type:'jpeg',quality:80});

      // Usability: actionability (no tap is dispatched), then Week 10 -> 9 -> 10 through the selector itself.
      phase='pr30-css-switch';
      const sel=page.locator('#weekSelect');
      const usable={visible:await sel.isVisible(),enabled:await sel.isEnabled(),
        trialTap:await sel.tap({trial:true,timeout:10000}).then(()=>true,e=>scrub(e.message).slice(0,200))};
      await sel.selectOption('2026-9');
      usable.week9Loaded=await page.waitForFunction(()=>/^Week 9 · /.test(document.getElementById('weekLine')?.textContent||''),null,{timeout:30000}).then(()=>true,()=>false);
      await page.waitForTimeout(1000);
      const week9=await measure();
      await page.locator('.week-strip').screenshot({path:shot(`pickem-week9-strip-pr30-${width}.png`)});
      await sel.selectOption('2026-10');
      usable.week10Reloaded=await ready('^Week 10 · revision 2 · ');await page.waitForTimeout(1000);
      const back=await measure();
      await page.locator('section.card.standings').screenshot({path:shot(`pickem-week10-standings-pr30-${width}.png`)});

      const ref=REFERENCE[width],injectedText=fixed.injection.text;
      for(const m of [control,fixed,week9,back])if(m.injection.present)delete m.injection.text;
      const dataMatches=m=>m.weekLine===ref.weekLine&&JSON.stringify(m.weekOptions)===JSON.stringify(ref.weekOptions)&&JSON.stringify(m.standings)===JSON.stringify(ref.standings);
      const noOverflow=m=>m.innerWidth===width&&m.clientWidth===width&&m.scrollWidth<=width&&m.bodyScrollWidth<=width&&m.maxScrollX===0;
      const rulesApplied=m=>{const s=m.select.computed,c=m.copy.computed;return s.width==='150px'&&s.minWidth==='150px'&&s.maxWidth==='150px'&&s.flexBasis==='150px'&&s.flexGrow==='0'&&s.flexShrink==='0'
        &&c.flexGrow==='1'&&c.flexShrink==='1'&&c.flexBasis==='0px'&&c.minWidth==='0px'&&m.injection.matched?.weekCopy===1&&m.injection.matched?.weekSelect===1};
      const checks={
        viewportIsRequestedWidth:[fixed,week9,back].every(m=>m.innerWidth===width),
        noDocumentOverflow:[fixed,week9,back].every(noOverflow),
        injectedCssIsExactPr30File:!!injectedText&&sha256(Buffer.from(injectedText,'utf8'))===sha256(CSS_BYTES)&&fixed.injection.inHead&&fixed.injection.afterSeasonRecordLink&&back.injection.present,
        pr30RulesApplied:[fixed,week9,back].every(rulesApplied),
        week10LabelSelected:fixed.weekSelected==='2026 · Week 10'&&back.weekSelected==='2026 · Week 10',
        week10LabelFullyVisible:fixed.label.fits&&back.label.fits,
        week10to18LabelsFit:fixed.twoDigitLabels.allFit,
        week10DataMatchesPr29ReadBack:fixReady&&/^Week 10 · revision 2 · /.test(fixed.weekLine)&&dataMatches(fixed)&&dataMatches(back),
        weekSummaryShowsWeekAndRevision:fixed.weekLineVisible.startsWith('Week 10 · revision 2'),
        stripLayoutContained:[fixed,week9,back].every(m=>Object.values(m.layout).every(Boolean)),
        selectorUsable:usable.visible&&usable.enabled&&usable.trialTap===true&&fixed.hitTest.every(Boolean)&&!fixed.select.disabled
          &&usable.week9Loaded&&week9.weekSelected==='2026 · Week 9'&&week9.label.fits&&usable.week10Reloaded&&back.hitTest.every(Boolean),
        gatewayChildOnly:gateway.length>0&&gateway.every(g=>g.status===200&&g.readOnly==='1'&&(g.backend===null||g.backend===CHILD_ENDPOINT))&&gateway.some(g=>g.backend===CHILD_ENDPOINT),
        noBrokenImages:[fixed,week9,back].every(m=>m.brokenImages===0),
        noBrowserErrors:appConsole.length===0&&pageErrors.length===0&&failedRequests.length===0&&httpErrors.length===0
      };
      const control_={ready:controlReady,label:control.label,select:{box:control.select.box,contentBoxWidth:control.select.contentBoxWidth,computedMinWidth:control.select.computed.minWidth},
        reproducesPr29Clip:!control.label.fits&&control.label.textWidthCeil===ref.selectFit[0].textWidth&&Math.floor(control.select.contentBoxWidth)===ref.selectFit[0].contentBoxWidth,
        dataMatchesPr29ReadBack:dataMatches(control),noDocumentOverflow:noOverflow(control),injectionAbsent:!control.injection.present};
      results.push({width,checks,pass:Object.values(checks).every(Boolean),control:control_,usable,
        measured:{control,pr30:fixed,week9,week10AfterSwitch:back},gateway,
        browser:{appConsole,harnessConsole,pageErrors,failedRequests,abortedRequests,httpErrors}});
      await context.close();
    }
  }finally{await browser.close().catch(()=>{})}

  const expectedCss=Object.fromEntries(Object.keys(servedCss).map(k=>[k,sha256(git('show',`${BASE}:nfl-pool/${k.split('?')[0]}`))]));
  const expectedIndex=sha256(git('show',`${APP}:nfl-pool/index.html`));
  const forbidden=network.filter(n=>FORBIDDEN.some(re=>re.test(n.host)||re.test(n.path)));
  const neonDirect=network.filter(n=>/neon\.tech$/.test(n.host));
  const writes=network.filter(n=>!['GET','HEAD','OPTIONS'].includes(n.method));
  const global={
    servedCssEqualsMain:Object.keys(servedCss).length>=8&&Object.keys(servedCss).every(k=>servedCss[k]===expectedCss[k]),
    servedIndexEqualsQaAppCommit:WIDTHS.every(w=>servedIndex[w]===expectedIndex),
    noForbiddenRequests:forbidden.length===0,noDirectNeonFromBrowser:neonDirect.length===0,noWriteRequests:writes.length===0,
    controlReproducesPr29ClipAtAllWidths:results.every(r=>r.control.reproducesPr29Clip)
  };
  const summary={at:new Date().toISOString(),deployment:DEPLOYMENT,deploymentOrigin:ORIGIN,qaAppCommit:APP,
    cssUnderTest:{commit:FIX,path:'nfl-pool/week-selector.css',gitBlob:CSS_BLOB,sha256:sha256(CSS_BYTES),bytes:CSS_BYTES.length},
    reference:{pr29EvidenceCommit:PR29,file:'nfl-pool/acceptance/pdf-e2e-20261105/logs/tracker-mobile.json'},
    environment:{playwright:PLAYWRIGHT_VERSION,chromium:CHROMIUM_VERSION,node:process.version,emulation:'headless Chromium; CSS viewport W x 844, DPR 2, isMobile, hasTouch; service workers blocked'},
    global,servedCss:Object.fromEntries(Object.keys(servedCss).map(k=>[k,{served:servedCss[k],main:expectedCss[k]}])),
    widths:results.map(r=>({width:r.width,pass:r.pass,checks:r.checks,
      control:{select:r.control.select.box.width,contentBox:r.control.select.contentBoxWidth,label:r.control.label.text,textWidth:r.control.label.width,fits:r.control.label.fits},
      pr30:{select:r.measured.pr30.select.box.width,contentBox:r.measured.pr30.select.contentBoxWidth,label:r.measured.pr30.label.text,textWidth:r.measured.pr30.label.width,
        headroom:r.measured.pr30.label.headroom,widestWeek10to18:r.measured.pr30.twoDigitLabels.widest,probeFonts:r.measured.pr30.probeFonts,
        innerWidth:r.measured.pr30.innerWidth,clientWidth:r.measured.pr30.clientWidth,scrollWidth:r.measured.pr30.scrollWidth,bodyScrollWidth:r.measured.pr30.bodyScrollWidth,maxScrollX:r.measured.pr30.maxScrollX,
        weekLineVisible:r.measured.pr30.weekLineVisible},
      browserErrors:{app:r.browser.appConsole.length,pageErrors:r.browser.pageErrors.length,failedRequests:r.browser.failedRequests.length,httpErrors:r.browser.httpErrors.length,
        harnessOnly:r.browser.harnessConsole.length,abortedByNavigation:r.browser.abortedRequests.length}})),
    forbiddenRequests:forbidden.length,directNeonRequestsFromBrowser:neonDirect.length,writeRequests:writes.length};
  summary.pass=summary.widths.every(w=>w.pass)&&Object.values(global).every(Boolean);
  fs.writeFileSync(path.join(logs,'week-selector-mobile.json'),scrub(JSON.stringify({summary,results},null,1)));
  fs.writeFileSync(path.join(logs,'week-selector-mobile-network.json'),scrub(JSON.stringify(network)));
  console.log(scrub(JSON.stringify(summary,null,1)));
  process.exitCode=summary.pass?0:1;
})().catch(e=>{console.error(scrub(e.stack||e));process.exitCode=2});
