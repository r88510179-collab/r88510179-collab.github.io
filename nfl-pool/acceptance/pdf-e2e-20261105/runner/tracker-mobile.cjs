'use strict';
// QA ONLY (PR #29). Read-back of the newly published synthetic weeks on the SSO-protected Vercel preview, in fresh browser
// sessions at 375 / 390 / 430 CSS px. Vercel protection stays on: access uses a temporary deployment share link that the
// runner reads from a local file and never logs (it is stripped from every recorded URL). The page is not modified; the
// runner only reads the DOM and measures geometry. Reads must come only from the QA child through the read-only gateway.
// Usage: node tracker-mobile.cjs <share-url file> <evidence dir> <expected pickem revision> <expected survivor revision>
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/opt/node-tools/node_modules/playwright');
const [shareFile,outDir,pickemRevision,survivorRevision]=process.argv.slice(2);
const share=new URL(fs.readFileSync(shareFile,'utf8').trim());
const ORIGIN=share.origin,SHARE_PARAM=share.searchParams.get('_vercel_share');
const shots=path.join(outDir,'screenshots'),logs=path.join(outDir,'logs');fs.mkdirSync(shots,{recursive:true});fs.mkdirSync(logs,{recursive:true});
const FORBIDDEN=[/ep-muddy-forest-au7eygkw/,/ep-silent-sunset-bbdqbm47/,/br-late-hat-b55ygmj4/,/picks\.smokkeventures\.com/];
const scrub=s=>String(s??'').split(SHARE_PARAM||'\u0000').join('[share-token-redacted]');
const results=[],network=[];
const measure=page=>page.evaluate(()=>{
  const $=id=>document.getElementById(id),txt=id=>$(id)?.innerText?.trim()??null,root=document.documentElement;
  return{innerWidth,innerHeight,clientWidth:root.clientWidth,scrollWidth:root.scrollWidth,bodyScrollWidth:document.body.scrollWidth,view:document.body.dataset.view||null,
    sync:txt('sync'),weekLine:txt('weekLine'),weekSelected:$('weekSelect')?.selectedOptions?.[0]?.textContent?.trim()??null,weekOptions:[...($('weekSelect')?.options||[])].map(o=>o.textContent.trim()),
    standings:[...document.querySelectorAll('#standings tr')].map(tr=>[...tr.children].map(td=>td.innerText.trim())),
    survivorWeek:$('survivorWeekSelect')?.selectedOptions?.[0]?.textContent?.trim()??null,survivorMeta:txt('svMeta'),survivorFeed:txt('svFeed'),
    survivorMetrics:{pool:txt('svPoolSize'),entered:txt('svEntered'),stillIn:txt('svStillIn'),pending:txt('svPending')},survivorTracked:txt('svTracked'),survivorError:txt('survivorError'),
    brokenImages:[...document.images].filter(i=>i.complete&&i.naturalWidth===0&&i.getBoundingClientRect().width>0).length,
    // Whether each visible week selector's chosen label fits its content box (a <select> clips its label silently).
    selectFit:['weekSelect','survivorWeekSelect'].map(id=>{const el=$(id);if(!el||!el.getClientRects().length)return null;const cs=getComputedStyle(el),ctx=document.createElement('canvas').getContext('2d');ctx.font=`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const label=el.selectedOptions?.[0]?.textContent?.trim()||'',text=Math.ceil(ctx.measureText(label).width),box=Math.floor(el.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight));
      return{id,label,textWidth:text,contentBoxWidth:box,selectWidth:Math.round(el.getBoundingClientRect().width),fits:text<=box}}).filter(Boolean)};
});
(async()=>{
  const browser=await chromium.launch();
  try{
    for(const width of [375,390,430]){
      const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,serviceWorkers:'block',locale:'en-US',timezoneId:'America/New_York'});
      const page=await context.newPage(),consoleLog=[],gateway=[];
      page.on('console',m=>{if(['error','warning'].includes(m.type())&&!/Service Worker registration blocked/.test(m.text()))consoleLog.push(`${m.type()}: ${scrub(m.text()).slice(0,300)}`)});
      page.on('pageerror',e=>consoleLog.push('pageerror: '+scrub(e.message).slice(0,300)));
      page.on('response',async r=>{const u=new URL(r.url());if(u.protocol.startsWith('http'))network.push({width,method:r.request().method(),host:u.host,path:u.pathname,status:r.status()});
        if(u.origin===ORIGIN&&u.pathname==='/api/qa-read'){const h=await r.allHeaders();gateway.push({resource:u.searchParams.get('resource')||u.searchParams.get('kind'),status:r.status(),backend:h['x-qa-backend']||null,readOnly:h['x-qa-read-only']||null})}});
      // Opening the share link sets the protection-bypass cookie for this fresh session only.
      await page.goto(share.href,{waitUntil:'domcontentloaded'});
      const run=async(label,query,ready)=>{
        await page.goto(`${ORIGIN}/nfl-pool/${query}`,{waitUntil:'networkidle'});
        await page.waitForFunction(ready,null,{timeout:60000}).catch(()=>{});
        await page.waitForTimeout(1500);
        const m=await measure(page);
        const file=path.join(shots,`tracker-${label}-${width}.jpg`);await page.screenshot({path:file,type:'jpeg',quality:60});
        return{...m,screenshot:path.relative(outDir,file)};
      };
      const pickem=await run('pickem-week10-standings','?view=standings&season=2026&week=10',()=>document.querySelectorAll('#standings tr').length>=4&&/Week 10/.test(document.getElementById('weekLine')?.textContent||''));
      const survivor=await run('survivor-week6','?view=survivor&season=2026&sw=6',()=>/Week 6/.test(document.getElementById('survivorWeekSelect')?.selectedOptions?.[0]?.textContent||'')&&(document.getElementById('svTracked')?.innerText||'').length>10);
      results.push({width,pickem,survivor,gateway,console:consoleLog,
        checks:{
          viewportIsRequestedWidth:pickem.innerWidth===width&&survivor.innerWidth===width,
          noDocumentOverflow:pickem.scrollWidth<=width&&survivor.scrollWidth<=width,
          pickemWeek10Revision:new RegExp(`^Week 10 · revision ${pickemRevision} · `).test(pickem.weekLine||''),
          survivorWeek6Revision:new RegExp(`^Week 6 · revision ${survivorRevision}$`).test(survivor.survivorMeta||''),
          pickemTrackedRows:pickem.standings.length>=4&&['D.C.','JC','DJS','Thaddeus'].every(n=>pickem.standings.some(r=>r.some(c=>c.includes(n)))),
          survivorWeek6Selected:/Week 6/.test(survivor.survivorWeek||''),
          survivorPool:survivor.survivorMetrics.pool==='4',
          gatewayChildOnly:gateway.length>0&&gateway.every(g=>g.backend===null||g.backend==='ep-shiny-snow-bbx446zt')&&gateway.some(g=>g.backend==='ep-shiny-snow-bbx446zt'),
          noBrokenImages:pickem.brokenImages===0&&survivor.brokenImages===0,
          weekSelectorLabelsFit:[...pickem.selectFit,...survivor.selectFit].every(f=>f.fits),
          noAppConsoleErrors:consoleLog.length===0
        }});
      await context.close();
    }
  }finally{await browser.close()}
  const forbidden=network.filter(n=>FORBIDDEN.some(re=>re.test(n.host)));
  const neonDirect=network.filter(n=>/neon\.tech$/.test(n.host));
  const summary={at:new Date().toISOString(),deploymentOrigin:ORIGIN,expected:{pickemRevision:Number(pickemRevision),survivorRevision:Number(survivorRevision)},
    widths:results.map(r=>({width:r.width,checks:r.checks,pass:Object.values(r.checks).every(Boolean)})),forbiddenRequests:forbidden.length,directNeonRequestsFromBrowser:neonDirect.length};
  summary.pass=summary.widths.every(w=>w.pass)&&forbidden.length===0&&neonDirect.length===0;
  fs.writeFileSync(path.join(logs,'tracker-mobile.json'),scrub(JSON.stringify({summary,results},null,1)));
  fs.writeFileSync(path.join(logs,'tracker-mobile-network.json'),scrub(JSON.stringify(network)));
  console.log(scrub(JSON.stringify(summary,null,1)));
  process.exitCode=summary.pass?0:1;
})().catch(e=>{console.error(scrub(e.stack||e));process.exitCode=2});
