'use strict';
// Temporary read-only screenshot/geometry acceptance for the exact Personal PR files.
// Fixture snapshot mimics the approved Home test; no external network, auth, DB or production change.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {execFileSync}=require('node:child_process');
const out=path.resolve(process.cwd(),'mobile-qa-artifact');
fs.mkdirSync(out,{recursive:true});
const widths=[375,390,430],results=[];
const now=Date.now();
const fixture={
  pickem:{
    ready:true,contest:'pickem',season:2026,week:9,revision:3,
    games:{total:16,final:12,void:0,live:2,remaining:4},fieldSize:87,
    tiebreak:{final:false,void:false},
    entries:[
      {name:'D.C.',w:10,l:2,left:4,groupRank:1,leader:true,noPicks:false,tiebreakDelta:null,field:{rank:3,tieCount:1,label:'#3',topPercent:4,behind:1}},
      {name:'JC',w:9,l:3,left:4,groupRank:2,leader:false,noPicks:false,tiebreakDelta:null,field:{rank:8,tieCount:5,label:'T-8',topPercent:10,behind:2}},
      {name:'DJS',w:9,l:3,left:4,groupRank:2,leader:false,noPicks:false,tiebreakDelta:null,field:{rank:8,tieCount:5,label:'T-8',topPercent:10,behind:2}},
      {name:'Thaddeus',w:7,l:5,left:4,groupRank:4,leader:false,noPicks:false,tiebreakDelta:null,field:{rank:41,tieCount:9,label:'T-41',topPercent:48,behind:4}}
    ],
    feed:{fetchedAt:new Date(now-2000).toISOString(),failed:false,incomplete:false,warnings:0,review:false},
    hold:false,rulingsStale:false,publishedStale:false,
    race:{outcomes:81,racePaths:27,items:[{name:'D.C.',status:'ALIVE',note:'Ceiling 14 wins'},{name:'JC',status:'ALIVE',note:'Ceiling 13 wins'},{name:'DJS',status:'ALIVE',note:'Ceiling 13 wins'},{name:'Thaddeus',status:'OUT',note:'Cannot finish first'}]},
    spotlight:{away:'KC',home:'BUF',status:'3rd 7:41',live:true,final:false,awayScore:17,homeScore:14}
  },
  survivor:{
    ready:true,contest:'survivor',season:2026,week:9,revision:7,fieldSize:120,
    counts:{active:42,pending:8,out:78,outThisWeek:12,submitted:50,legalPicks:50,awaitingRuling:0,onHold:0},
    tracked:[{name:'D.C.',status:'ALIVE',team:'KC',reason:'Alive through Week 9',underReview:false},
      {name:'DJS',status:'OUT',team:'BUF',reason:'BUF lost in Week 3',underReview:false},
      {name:'Thaddeus',status:'PENDING',team:'SF',reason:'Week 9 game pending',underReview:false}],
    feed:{at:now-2000,failed:false,interval:60000},hold:false,flags:[],rulingsStale:false,publishedStale:false
  }
};
(async()=>{
  const chrome=process.env.CHROME_BIN||(fs.existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined);
  const browser=await chromium.launch({headless:true,...(chrome?{executablePath:chrome}:{}) ,args:['--no-sandbox']});
  try{
    for(const width of widths){
      const context=await browser.newContext({viewport:{width,height:width===375?812:width===390?844:932},deviceScaleFactor:1,isMobile:true,hasTouch:true,serviceWorkers:'block'});
      const page=await context.newPage();
      const errors=[];
      page.on('pageerror',err=>errors.push(err.message));
      await page.addInitScript(data=>{
        window.__qaFixture=data;
        document.addEventListener('poolcenter:share',e=>{
          if(e?.detail&&Object.hasOwn(window.__qaFixture,e.detail.contest))
            e.detail.snapshot=structuredClone(window.__qaFixture[e.detail.contest]);
        },true);
      },fixture);
      await page.route('**/*',route=>{
        const req=route.request(),url=new URL(req.url());
        if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost')return route.abort();
        if(/\/(weekly-app|survivor-app|picks-mobile|season-record|share-ui|pwa|score-feed-proxy)\.js$/.test(url.pathname))
          return route.fulfill({status:200,contentType:'text/javascript',body:'// intentionally disabled: fixture-only visual QA; no requests to QA Neon'});
        return route.continue();
      });
      await page.goto('http://127.0.0.1:8765/?view=home',{waitUntil:'networkidle',timeout:30000});
      await page.waitForFunction(()=>document.querySelector('#homeFieldPulse')?.dataset?.something||document.querySelector('#homeFieldPulse')?.querySelector('[data-field-pulse="ready"]'),{timeout:15000}).catch(()=>{});
      await page.evaluate(()=>{
        document.querySelector('#sync').textContent='LIVE · synthetic QA';
        document.querySelector('#weekLine').textContent='2026 · Week 9 · revision 3 · fixture only';
        document.querySelector('#leaderName').textContent='D.C.';
        document.querySelector('#leaderRecord').textContent='10–2';
        document.querySelector('#leaderNote').textContent='Four tracked entries compared to the published full pool';
        document.querySelector('#finals').textContent='12/16';
        document.querySelector('#liveCount').textContent='2';
        document.querySelector('#left').textContent='4';
        document.querySelector('#mnf').textContent='—';
        const rows=[
          ['1','D.C.','10–2','#3 / 87','Top 4% · 1 back'],
          ['2','JC','9–3','T-8 / 87','Top 10% · 2 back'],
          ['2','DJS','9–3','T-8 / 87','Top 10% · 2 back'],
          ['4','Thaddeus','7–5','T-41 / 87','Top 48% · 4 back']
        ];
        document.querySelector('#homeStandings').innerHTML=rows.map(([r,n,rec,rank,note])=>'<div class="home-standing-row"><span class="home-rank">'+r+'</span><span class="home-entry">'+n+'</span><span class="home-record">'+rec+'</span><span class="home-field"><b>'+rank+'</b><small>'+note+'</small></span></div>').join('');
      });
      const before=await page.evaluate(()=>{
        const selectors=['.app-shell','.dash-toolbar','#dash-standings-body','#homeFieldPulse','.field-pulse-grid','.field-pulse-stat','.home-standings','.bottom-nav','.dash-contests','.dash-survivor'];
        const rect=sel=>{const e=document.querySelector(sel);if(!e)return null;const b=e.getBoundingClientRect(),cs=getComputedStyle(e);return{left:Math.round(b.left),right:Math.round(b.right),width:Math.round(b.width),height:Math.round(b.height),fontSize:cs.fontSize,visible:b.height>0&&cs.display!=='none'}};
        const field=document.querySelector('#homeFieldPulse');
        return{innerWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,
          clientWidth:document.documentElement.clientWidth,pulseText:field.innerText,
          pulseCardCount:field.querySelectorAll('.group-field-pulse').length,
          pulseCaptionFontPx:parseFloat(getComputedStyle(field.querySelector('.field-pulse-caption')).fontSize),
          pulseOuterIsBare:!field.classList.contains('group-field-pulse'),
          positions:Object.fromEntries(selectors.map(x=>[x,rect(x)])),
          tinyTargets:[...document.querySelectorAll('button')].filter(x=>x.getBoundingClientRect().height>0).map(x=>({text:x.textContent.trim().slice(0,30),width:Math.round(x.getBoundingClientRect().width),height:Math.round(x.getBoundingClientRect().height)})).filter(x=>x.height<40||x.width<40).slice(0,20),
          offscreen:[...document.querySelectorAll('#dashSections *')].filter(e=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);return b.width>0&&b.height>0&&s.position!=='fixed'&&b.right>innerWidth+1&&b.left<innerWidth}).slice(0,30).map(x=>({tag:x.tagName,cls:x.className?.toString().slice(0,80),text:x.textContent.slice(0,24)}))
        };
      });
      await page.screenshot({path:path.join(out,'personal-home-'+width+'.png'),fullPage:true,animations:'disabled'});
      const customizable=await page.locator('[data-dash-customize]').isVisible();
      if(customizable){
        await page.locator('[data-dash-customize]').click();
        const dialogVisible=await page.locator('#dashPanel').isVisible();
        await page.screenshot({path:path.join(out,'personal-customize-'+width+'.png'),fullPage:false,animations:'disabled'});
        await page.locator('[data-dash-close]').first().click();
        before.customizeOpens=dialogVisible;
      }
      await page.locator('[data-dash-toggle="standings"]').click();
      before.collapseWorks=await page.locator('#dash-standings-body').isHidden();
      await page.locator('[data-dash-toggle="standings"]').click();
      before.expandWorks=await page.locator('#dash-standings-body').isVisible();
      before.javascriptErrors=errors;
      before.width=width;
      before.assertions={
        viewportMatches:before.innerWidth===width,
        noDocumentOverflow:before.documentWidth<=width+1,
        correctRank:before.pulseText.includes('#3')&&before.pulseText.includes('87'),
        oneComparisonCard:before.pulseCardCount===1&&before.pulseOuterIsBare,
        captionReadable:before.pulseCaptionFontPx>=11,
        correctTop25Count:before.pulseText.includes('3 of 4 submitted'),
        noteVisible:before.pulseText.includes('In-progress scores do not count until final'),
        standingsVisible:before.positions['#homeFieldPulse']?.visible===true,
        expandCollapse:before.collapseWorks&&before.expandWorks,
        customize:before.customizeOpens===true,
        noRuntimeErrors:errors.length===0
      };
      results.push(before);
      await context.close();
    }
  }finally{await browser.close()}
  const report={commit:process.env.GITHUB_SHA||'local',fixtureOnly:true,viewports:results,
    overallPass:results.every(r=>Object.values(r.assertions).every(Boolean))};
  fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify(report,null,2));
  console.log('=== PERSONAL MOBILE QA RESULTS (fixture, not authenticated live data) ===');
  for(const r of results)console.log(JSON.stringify({width:r.width,viewport:r.innerWidth,docWidth:r.documentWidth,checks:r.assertions,overflowCandidates:r.offscreen,smallTargets:r.tinyTargets,errors:r.javascriptErrors}));
  console.log('OVERALL='+String(report.overallPass));
  process.exitCode=report.overallPass?0:1;
})().catch(e=>{console.error(e.stack||e);process.exitCode=2;});
