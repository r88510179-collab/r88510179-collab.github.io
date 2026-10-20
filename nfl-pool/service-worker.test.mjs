import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./service-worker.js',import.meta.url),'utf8');
const index=readFileSync(new URL('./index.html',import.meta.url),'utf8');
// HDC-12 regressions run through this collector so every one of them reports, not only the first; the suite fails at the
// end if any did.
const hdc12Failures=[];
const hdc12=async(name,check)=>{try{await check()}catch(error){hdc12Failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
const hdc14Failures=[];
const hdc14=async(name,check)=>{try{await check()}catch(error){hdc14Failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
const hdc15Failures=[];
const hdc15=async(name,check)=>{try{await check()}catch(error){hdc15Failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
// Shareable cards (after HDC-15) add exactly these three shell assets and this page markup, and change the worker only by
// their precache entries (with its cache name and the two app versions). The earlier phases' checks below allow exactly
// these and still hold for every other asset and every other byte; the share-cards block at the end checks the change itself.
const SHARE_ICON='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SHARE_CARDS={
  assets:new Set(['share-card.js','share-ui.js','share.css']),
  page:['<link rel="stylesheet" href="share.css?v=1">\n',
    `<button type="button" class="share-btn" data-share-card="pickem" aria-label="Share Pick'em standings" hidden>${SHARE_ICON}<span>Share</span></button>`,
    '<div class="share-slot">',
    `<button type="button" class="share-btn" data-share-card="survivor" aria-label="Share Survivor results" hidden>${SHARE_ICON}<span>Share</span></button></div>`,
    '<script type="module" src="share-ui.js?v=1"></script>\n'],
  worker:"  './share-card.js?v=1',\n  './share-ui.js?v=1',\n  './share.css?v=1',\n"
};
const withoutShareCards=page=>SHARE_CARDS.page.reduce((text,addition)=>text.replace(addition,''),page);
const sc1Failures=[];
const sc1=async(name,check)=>{try{await check()}catch(error){sc1Failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
// The Home dashboard (after share cards) adds exactly these two shell assets, this head link and this module script, replaces
// the page's Home panel (the baseline panel below) with the dashboard, moves weekly-app.js, survivor-app.js, share-card.js and
// share-ui.js to the versions named here, and changes the worker only by its cache name and precache entries. Every earlier
// check sees the page, the worker and the modules as they were before it (withoutHomeDashboard) and still holds for every
// other byte; the Home dashboard block at the end checks the change itself.
const HOME_DASHBOARD={
  assets:new Set(['home-dashboard.js','home-dashboard.css']),
  versions:[['weekly-app.js','weekly-v21','weekly-v22'],['survivor-app.js','10','11'],['share-card.js','1','2'],['share-ui.js','1','2']],
  cache:['pool-center-shell-v24','pool-center-shell-v25'],
  page:['<link rel="stylesheet" href="home-dashboard.css?v=1">\n','<script type="module" src="home-dashboard.js?v=1"></script>\n'],
  worker:"  './home-dashboard.js?v=1',\n  './home-dashboard.css?v=1',\n",
  panel:{start:'    <section class="view-panel" data-view-panel="home">',end:'    <section class="view-panel" data-view-panel="standings"',baseline:`    <section class="view-panel" data-view-panel="home">
      <section class="card hero hero-stadium" aria-label="Pool leader and game summary">
        <img class="hero-nfl-shield" src="https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png" alt="" aria-hidden="true">
        <div class="hero-main">
          <div class="kicker" id="leaderKicker">Current leader</div>
          <div class="leader"><div class="leader-name" id="leaderName">—</div><div class="record" id="leaderRecord">0–0</div></div>
          <div class="note" id="leaderNote">Standings update automatically as games go final.</div>
        </div>
        <div class="metrics">
          <div class="metric"><span>Final</span><b id="finals">0/—</b></div>
          <div class="metric"><span>Live</span><b id="liveCount">0</b></div>
          <div class="metric"><span>Remaining</span><b id="left">—</b></div>
          <div class="metric"><span>TB Total</span><b id="mnf">—</b></div>
        </div>
      </section>

      <div class="home-grid">
        <section class="card home-standings-card">
          <div class="head"><div><span class="section-kicker">Leaderboard</span><h2>Live Standings</h2></div><button class="text-action" type="button" data-view-target="standings">View all</button></div>
          <div class="home-standings" id="homeStandings"></div>
        </section>

        <aside class="card pulse" aria-labelledby="pulse-title">
          <div class="head compact"><div><span class="section-kicker">Week pulse</span><h2 id="pulse-title">Pool Status</h2></div><div class="meta" id="pulseWeek">Week —</div></div>
          <div class="pulse-grid">
            <div class="pulse-box"><span>Pool Size</span><b id="entryCount">—</b></div>
            <div class="pulse-box"><span>Games</span><b id="gameCount">—</b></div>
            <div class="pulse-box"><span>Field Best</span><b id="bestWins">0</b></div>
            <div class="pulse-box"><span>Swing Left</span><b id="swingLeft">—</b></div>
          </div>
          <div class="progressline"><span>Slate progress</span><span id="progressText">0%</span></div>
          <div class="progress"><i id="progressBar"></i></div>
          <div class="tb" id="tbNote">Tiebreak guesses load with the selected week.</div>
        </aside>
      </div>

      <div class="home-grid race-grid">
        <section class="card race" aria-labelledby="race-title">
          <div class="head"><div><span class="section-kicker">Your four entries</span><h2 id="race-title">Group Scenarios</h2><div class="meta">Exact remaining-outcome math inside your group · field position tracked separately</div></div><div class="meta" id="scenarioCount">—</div></div>
          <div class="race-list" id="raceList"></div>
        </section>
        <section class="card home-games-card">
          <div class="head"><div><span class="section-kicker">Now & next</span><h2>Game Watch</h2></div><button class="text-action" type="button" data-view-target="games">All games</button></div>
          <div class="home-game-preview" id="homeGamePreview"></div>
        </section>
      </div>
    </section>

`}
};
const withoutHomeDashboard=text=>{
  let out=text;
  for(const [asset,before,after] of HOME_DASHBOARD.versions)out=out.split(`${asset}?v=${after}`).join(`${asset}?v=${before}`);
  out=out.replace(`const CACHE='${HOME_DASHBOARD.cache[1]}'`,`const CACHE='${HOME_DASHBOARD.cache[0]}'`).replace(HOME_DASHBOARD.worker,'');
  for(const addition of HOME_DASHBOARD.page)out=out.replace(addition,'');
  const start=out.indexOf(HOME_DASHBOARD.panel.start),end=out.indexOf(HOME_DASHBOARD.panel.end);
  if(start>=0&&end>start)out=out.slice(0,start)+HOME_DASHBOARD.panel.baseline+out.slice(end);
  return out;
};
// The V1.3 mobile UX (after the Home dashboard) adds exactly these two shell assets, this head link and this module script,
// replaces the Games and Survivor Rules & rulings cards with their collapsible form and adds the card and filter containers to
// the Picks panel (the baselines below), moves weekly-app.js and survivor-app.js to the versions named here, and changes the
// worker only by its cache name and precache entries. Every earlier check sees the page, the worker and the modules as they
// were before it (withoutPicksMobile) and still holds for every other byte; the mobile UX block at the end checks the change
// itself.
const PICKS_MOBILE={
  assets:new Set(['picks-mobile.js','picks-mobile.css']),
  versions:[['weekly-app.js','weekly-v22','weekly-v23'],['survivor-app.js','11','12']],
  cache:['pool-center-shell-v25','pool-center-shell-v26'],
  page:['<link rel="stylesheet" href="picks-mobile.css?v=1">\n','<script type="module" src="picks-mobile.js?v=1"></script>\n'],
  worker:"  './picks-mobile.js?v=1',\n  './picks-mobile.css?v=1',\n",
  regions:[
    {start:'      <section class="card rules-card rules-collapsible is-collapsed" aria-labelledby="pickem-rules-title"',end:'    </section>\n\n    <section class="view-panel" data-view-panel="survivor" hidden>',baseline:`      <section class="card rules-card" aria-labelledby="pickem-rules-title">
        <div class="head"><div><span class="section-kicker">Halted games</span><h2 id="pickem-rules-title">Rules &amp; rulings</h2><div class="meta">Contest policy and commissioner-confirmed rulings for this week</div></div></div>
        <div class="rules-body" id="pickemRules"><div class="empty">Loading contest rules and rulings…</div></div>
      </section>
`},
    {start:'      <section class="card rules-card rules-collapsible is-collapsed" style="margin-top:10px" aria-labelledby="survivor-rules-title"',end:'    </section>\n\n    <section class="view-panel" data-view-panel="picks" hidden>',baseline:`      <section class="card rules-card" style="margin-top:10px" aria-labelledby="survivor-rules-title"><div class="head"><div><span class="section-kicker">Halted games</span><h2 id="survivor-rules-title">Rules &amp; rulings</h2><div class="meta">Contest policy and commissioner-confirmed rulings through this week</div></div></div><div class="rules-body" id="svRules"><div class="empty">Loading contest rules and rulings…</div></div></section>
`},
    {start:'        <div class="picks-filters" id="picksFilters" hidden></div>\n',end:'        <div class="scroll"><table><thead id="pickHead">',baseline:''}
  ]
};
const withoutPicksMobile=text=>{
  let out=text;
  for(const [asset,before,after] of PICKS_MOBILE.versions)out=out.split(`${asset}?v=${after}`).join(`${asset}?v=${before}`);
  out=out.replace(`const CACHE='${PICKS_MOBILE.cache[1]}'`,`const CACHE='${PICKS_MOBILE.cache[0]}'`).replace(PICKS_MOBILE.worker,'');
  for(const addition of PICKS_MOBILE.page)out=out.replace(addition,'');
  for(const {start,end,baseline} of PICKS_MOBILE.regions){
    const s=out.indexOf(start),e=s>=0?out.indexOf(end,s):-1;
    if(s>=0&&e>s)out=out.slice(0,s)+baseline+out.slice(e);
  }
  return out;
};
// The V1.4 premium compact Picks UX (after the V1.3 mobile UX) adds no shell asset: it changes the bytes of picks-mobile.js and
// picks-mobile.css (each rolled to v=2) and of the page (the Picks panel's copy per layout and its entry selection panel, the
// baselines below), and changes the worker only by its cache name and the two mobile entries' versions. Every earlier check
// sees the page, the worker and the modules as they were before it (withoutPicksCompact) and still holds for every other byte;
// the compact UX block at the end checks the change itself.
const PICKS_COMPACT={
  assets:new Set(),
  versions:[['picks-mobile.js','1','2'],['picks-mobile.css','1','2']],
  cache:['pool-center-shell-v26','pool-center-shell-v27'],
  regions:[
    {start:'      <section class="page-title"><span class="section-kicker">Weekly selections</span><h1>Picks</h1><p><span class="pm-copy-table">',end:'</p></section>\n      <section class="card picks"',baseline:'      <section class="page-title"><span class="section-kicker">Weekly selections</span><h1>Picks</h1><p>Side-by-side picks for D.C., JC, DJS and Thaddeus. Matchup headers show full-field ownership when available.'},
    {start:'      <dialog class="pm-dialog" id="picksEntrants"',end:'    </section>\n  </div>\n\n  <footer',baseline:''}
  ]
};
const withoutPicksCompact=text=>{
  let out=text;
  for(const [asset,before,after] of PICKS_COMPACT.versions)out=out.split(`${asset}?v=${after}`).join(`${asset}?v=${before}`);
  out=out.replace(`const CACHE='${PICKS_COMPACT.cache[1]}'`,`const CACHE='${PICKS_COMPACT.cache[0]}'`);
  for(const {start,end,baseline} of PICKS_COMPACT.regions){
    const s=out.indexOf(start),e=s>=0?out.indexOf(end,s):-1;
    if(s>=0&&e>s)out=out.slice(0,s)+baseline+out.slice(e);
  }
  return out;
};
// The V1.4 final premium polish (after the compact UX: compact pick chips, card name labels and Disagreements only) adds no
// shell asset: it changes the bytes of picks-mobile.js and picks-mobile.css (each rolled to v=3) and of the page (the entry
// selection panel's card name labels setting, the region below), and changes the worker only by its cache name and the two
// mobile entries' versions. Every earlier check sees the page, the worker and the modules as they were before it
// (withoutPicksPolish) and still holds for every other byte; the polish block at the end checks the change itself.
const PICKS_POLISH={
  assets:new Set(),
  versions:[['picks-mobile.js','2','3'],['picks-mobile.css','2','3']],
  cache:['pool-center-shell-v27','pool-center-shell-v28'],
  regions:[{start:'          <div class="pm-sheet-setting" role="group" aria-labelledby="picksLabelsTitle">',end:'          <p class="pm-sheet-status" data-picks-dialog-note',baseline:''}]
};
const withoutPicksPolish=text=>{
  let out=text;
  for(const [asset,before,after] of PICKS_POLISH.versions)out=out.split(`${asset}?v=${after}`).join(`${asset}?v=${before}`);
  out=out.replace(`const CACHE='${PICKS_POLISH.cache[1]}'`,`const CACHE='${PICKS_POLISH.cache[0]}'`);
  for(const {start,end,baseline} of PICKS_POLISH.regions){
    const s=out.indexOf(start),e=s>=0?out.indexOf(end,s):-1;
    if(s>=0&&e>s)out=out.slice(0,s)+baseline+out.slice(e);
  }
  return out;
};
// The V1.4 collapsible slate groups (after the final polish) add no shell asset and no page markup: they change the bytes of
// picks-mobile.js and picks-mobile.css (each rolled to v=4), the page only by those two versions, and the worker only by its
// cache name and the two mobile entries' versions. Every earlier check sees the page, the worker and the modules as they were
// before it (withoutPicksAccordion) and still holds for every other byte; the slate groups block at the end checks the change
// itself.
const PICKS_ACCORDION={
  assets:new Set(),
  versions:[['picks-mobile.js','3','4'],['picks-mobile.css','3','4']],
  cache:['pool-center-shell-v28','pool-center-shell-v29']
};
const withoutPicksAccordion=text=>{
  let out=text;
  for(const [asset,before,after] of PICKS_ACCORDION.versions)out=out.split(`${asset}?v=${after}`).join(`${asset}?v=${before}`);
  return out.replace(`const CACHE='${PICKS_ACCORDION.cache[1]}'`,`const CACHE='${PICKS_ACCORDION.cache[0]}'`);
};
// The V1.4 multi-select slates (after the collapsible slate groups) add no shell asset: they change the bytes of
// picks-mobile.js and picks-mobile.css (each rolled to v=5) and of the page (the slate selection panel after the entry selection
// panel, the region below), and change the worker only by its cache name and the two mobile entries' versions. Every earlier
// check sees the page, the worker and the modules as they were before it (withoutPicksSlates) and still holds for every other
// byte; the multi-select slates block at the end checks the change itself.
const PICKS_SLATES={
  assets:new Set(),
  versions:[['picks-mobile.js','4','5'],['picks-mobile.css','4','5']],
  cache:['pool-center-shell-v29','pool-center-shell-v30'],
  regions:[{start:'      <dialog class="pm-dialog" id="picksSlates"',end:'    </section>\n  </div>\n\n  <footer',baseline:''}]
};
const withoutPicksSlates=text=>{
  let out=text;
  for(const [asset,before,after] of PICKS_SLATES.versions)out=out.split(`${asset}?v=${after}`).join(`${asset}?v=${before}`);
  out=out.replace(`const CACHE='${PICKS_SLATES.cache[1]}'`,`const CACHE='${PICKS_SLATES.cache[0]}'`);
  for(const {start,end,baseline} of PICKS_SLATES.regions){
    const s=out.indexOf(start),e=s>=0?out.indexOf(end,s):-1;
    if(s>=0&&e>s)out=out.slice(0,s)+baseline+out.slice(e);
  }
  return out;
};
// The season record (after the multi-select slates) adds exactly two shell assets (season-record.js and season-record.css), this
// head link and this module script, the season strip container in the Live Standings body and the Season Record card on
// Standings (the regions below), moves weekly-app.js to the version named here (its poolcenter:season answers), and changes the
// worker only by its cache name and precache entries. Every earlier check sees the page, the worker and the modules as they
// were before it: the page and the worker through withoutSeasonRecord, the shell without the two new assets
// (shellBeforeSeasonRecord), and the existing files whose bytes it changes by their bytes in pool-center-shell-v30 (main
// 6f4a3b8), which the season record block at the end checks are the bytes it started from. That block checks the change itself.
const SEASON_RECORD={
  assets:new Set(['season-record.js','season-record.css']),
  versions:[['weekly-app.js','weekly-v23','weekly-v24']],
  cache:['pool-center-shell-v30','pool-center-shell-v31'],
  page:['<link rel="stylesheet" href="season-record.css?v=1">\n','<script type="module" src="season-record.js?v=1"></script>\n','<div class="season-strip" id="homeSeason"></div>'],
  worker:"  './season-record.js?v=1',\n  './season-record.css?v=1',\n",
  regions:[{start:'      <section class="card season-card" aria-labelledby="season-title">',end:'    </section>\n\n    <section class="view-panel" data-view-panel="games" hidden>',baseline:''}],
  before:{'index.html':'1670f05f397d0483800d170aa43cd7ee2fcb68ffe8206dc87df2cfc6cb6f97a3','weekly-app.js':'7efcceefa199c211581262b977a70c86d5a7b6a586f714fb72dd79015c3eb782'}
};
const withoutSeasonRecord=text=>{
  let out=text;
  for(const [asset,before,after] of SEASON_RECORD.versions)out=out.split(`${asset}?v=${after}`).join(`${asset}?v=${before}`);
  out=out.replace(`const CACHE='${SEASON_RECORD.cache[1]}'`,`const CACHE='${SEASON_RECORD.cache[0]}'`).replace(SEASON_RECORD.worker,'');
  for(const addition of SEASON_RECORD.page)out=out.replace(addition,'');
  for(const {start,end,baseline} of SEASON_RECORD.regions){
    const s=out.indexOf(start),e=s>=0?out.indexOf(end,s):-1;
    if(s>=0&&e>s)out=out.slice(0,s)+baseline+out.slice(e);
  }
  return out;
};
const shellBeforeSeasonRecord=urls=>urls.filter(url=>![...SEASON_RECORD.assets].some(asset=>url.endsWith(`/${asset}?v=1`))).map(withoutSeasonRecord);
// The page and the worker as the V1.4 multi-select slates left them (pool-center-shell-v30), for the multi-select slates' own
// byte checks, as the V1.4 collapsible slate groups left them (pool-center-shell-v29), for the slate groups', as the V1.4 final
// polish left them (pool-center-shell-v28), for the polish's, as the V1.4 compact UX left them (pool-center-shell-v27), for the
// compact UX's, as the V1.3 mobile UX left them (pool-center-shell-v26), for the mobile UX's, and as the Home dashboard left
// them (pool-center-shell-v25), for the dashboard's.
const indexBeforeSeason=withoutSeasonRecord(index),sourceBeforeSeason=withoutSeasonRecord(source);
const indexBeforeSlates=withoutPicksSlates(indexBeforeSeason),sourceBeforeSlates=withoutPicksSlates(sourceBeforeSeason);
const indexBeforeAccordion=withoutPicksAccordion(indexBeforeSlates),sourceBeforeAccordion=withoutPicksAccordion(sourceBeforeSlates);
const indexBeforePolish=withoutPicksPolish(indexBeforeAccordion),sourceBeforePolish=withoutPicksPolish(sourceBeforeAccordion);
const indexBeforeCompact=withoutPicksCompact(indexBeforePolish),sourceBeforeCompact=withoutPicksCompact(sourceBeforePolish);
const indexBeforePicks=withoutPicksMobile(indexBeforeCompact),sourceBeforePicks=withoutPicksMobile(sourceBeforeCompact);
const indexBefore=withoutHomeDashboard(indexBeforePicks),sourceBefore=withoutHomeDashboard(sourceBeforePicks);
const hdFailures=[];
const hd=async(name,check)=>{try{await check()}catch(error){hdFailures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
// HDC-12 changes weekly-app.js, survivor-app.js, survivor-math.js, weekly.css and survivor.css and adds contest-rulings.js,
// so each is precached and loaded at its new version and none at the version it replaces.
await hdc12('HDC-12 precache and page versions',()=>{
  for(const asset of [
    './public-math.js?v=3',
    './survivor-math.js?v=7',
    './weekly.css?v=premium-v3',
    './survivor.css?v=4',
    './score-feed-proxy.js?v=2'
  ])assert(source.includes(`'${asset}'`),`precache must include ${asset}`);
  for(const [asset,label] of [['./weekly-app.js?v=weekly-v16','weekly-v16 module'],['./survivor-app.js?v=6','survivor-app v6 module'],
    ['./survivor-math.js?v=6','survivor-math v6 module'],['./weekly.css?v=premium-v2','weekly.css premium-v2 stylesheet'],['./survivor.css?v=3','survivor.css v3 stylesheet']])
    assert(!source.includes(`'${asset}'`),`the superseded ${label} must no longer be precached`);
  assert(!index.includes('weekly-app.js?v=weekly-v16'),'the Pool Center page must no longer load weekly-v16');
  assert(!index.includes('survivor-app.js?v=6'),'the Pool Center page must no longer load survivor-app v6');
  assert(index.includes('weekly.css?v=premium-v3')&&!index.includes('weekly.css?v=premium-v2'),'the Pool Center page must load weekly.css premium-v3 only');
  assert(index.includes('survivor.css?v=4')&&!index.includes('survivor.css?v=3'),'the Pool Center page must load survivor.css v4 only');
});
// HDC-14 changes contest-rulings.js (the absence evidence) and, through their imports, weekly-app.js and survivor-app.js:
// each is precached and loaded at its new version and none at the version it replaces. Nothing else moves.
await hdc14('HDC-14 precache and page versions',()=>{
  assert(source.includes("'./contest-rulings.js?v=2'"),'precache must include ./contest-rulings.js?v=2');
  for(const [asset,label] of [['./weekly-app.js?v=weekly-v17','weekly-v17 module'],['./survivor-app.js?v=7','survivor-app v7 module'],['./contest-rulings.js?v=1','contest-rulings v1 module']])
    assert(!source.includes(`'${asset}'`),`the superseded ${label} must no longer be precached`);
  assert(!index.includes('weekly-app.js?v=weekly-v17'),'the Pool Center page must no longer load weekly-v17');
  assert(!index.includes('survivor-app.js?v=7'),'the Pool Center page must no longer load survivor-app v7');
});
// HDC-15 changes weekly-app.js and survivor-app.js (the public refresh lifecycle): each is precached and loaded at its new
// version and none at the version it replaces. Nothing else moves.
await hdc15('HDC-15 precache and page versions',()=>{
  for(const asset of ['./weekly-app.js?v=weekly-v24','./survivor-app.js?v=12'])assert(source.includes(`'${asset}'`),`precache must include ${asset}`);
  for(const [asset,label] of [['./weekly-app.js?v=weekly-v18','weekly-v18 module'],['./survivor-app.js?v=8','survivor-app v8 module']])
    assert(!source.includes(`'${asset}'`),`the superseded ${label} must no longer be precached`);
  assert(index.includes('weekly-app.js?v=weekly-v24')&&!index.includes('weekly-app.js?v=weekly-v18'),'the Pool Center page must load weekly-v24 only');
  assert(index.includes('survivor-app.js?v=12')&&!index.includes('survivor-app.js?v=8'),'the Pool Center page must load survivor-app v12 only');
});
assert(!source.includes("'./weekly-app.js?v=weekly-v15'"),'the superseded weekly-v15 module must no longer be precached');
assert(!source.includes("'./survivor-app.js?v=5'"),'the superseded survivor-app v5 module must no longer be precached');
assert(!source.includes("'./survivor-math.js?v=5'"),'the superseded survivor-math v5 module must no longer be precached');
assert(!source.includes("'./survivor-math.js?v=4'"));
assert(!source.includes("'./score-feed-proxy.js?v=1'"));
assert(!source.includes("'./admin/"),'Admin pages are network-dependent and must not be precached');
assert(!index.includes('weekly-app.js?v=weekly-v15'),'the Pool Center page must no longer load weekly-v15');
assert(!index.includes('survivor-app.js?v=5'),'the Pool Center page must no longer load survivor-app v5');
assert(index.includes('score-feed-proxy.js?v=2'));

const listeners={},deleted=[],fetchCalls=[],fetchInitCalls=[],matchCalls=[],putCalls=[],opened=[],addAllCalls=[];
let network=()=>okResponse,skipWaitingCalls=0;
const fallback={kind:'public-shell'},okResponse={ok:true,clone(){return this}};
const offline=new Error('offline'),cached=new Map([['./index.html',fallback]]);
const httpResponse=status=>{const response={status,ok:status>=200&&status<300,clone:()=>({status,ok:response.ok,cloneOf:response})};return response};
const cache={addAll:async requests=>{addAllCalls.push(Array.from(requests))},put:async(request,response)=>{putCalls.push({request,response})}};
const caches={
  open:async name=>{opened.push(name);return cache},
  keys:async()=>['pool-center-shell-v12','pool-center-shell-v13','pool-center-shell-v14','pool-center-shell-v15','pool-center-shell-v16','pool-center-shell-v17','pool-center-shell-v18','pool-center-shell-v19','pool-center-shell-v20','pool-center-shell-v21','pool-center-shell-v22','pool-center-shell-v23','pool-center-shell-v24','pool-center-shell-v25','pool-center-shell-v26','pool-center-shell-v27','pool-center-shell-v28','pool-center-shell-v29','pool-center-shell-v30','pool-center-shell-v31'],
  delete:async key=>{deleted.push(key);return true},
  match:async key=>{matchCalls.push(key);return cached.get(typeof key==='string'?key:key.url)}
};
// The worker is served at /nfl-pool/service-worker.js. In a ServiceWorkerGlobalScope a relative URL passed to new Request()
// resolves against the worker script's URL, as Cache.addAll resolves a URL string.
const workerURL='https://example.test/nfl-pool/service-worker.js';
// Test-only stand-in for the browser's Request: the resolved URL and the cache mode ('default' unless one is given) are all
// the install regressions inspect.
class Request{constructor(input,init={}){this.url=new URL(input,workerURL).href;this.cache=init.cache??'default'}}
const self={
  location:{origin:'https://example.test',href:workerURL},
  clients:{claim:async()=>{}},
  skipWaiting:async()=>{skipWaitingCalls++},
  addEventListener(t,f){listeners[t]=f}
};
const fetch=async(request,init)=>{fetchCalls.push(request);fetchInitCalls.push(init);return network(request,init)};
vm.runInNewContext(source,{self,caches,fetch,URL,Promise,console,Request});

let installPromise;
listeners.install({waitUntil:p=>{installPromise=p}});await installPromise;
// HDC-07. A request with the default cache mode may be answered from the browser's HTTP cache while that copy is fresh, and
// Pages serves max-age=600. cache.addAll(SHELL) passed URL strings, so a new shell cache could be filled with the page
// from before the deploy: pool-center-shell-v15 was observed holding an index.html that loads weekly-app.js?v=weekly-v13
// next to the weekly-v14 module. Install must give Cache.addAll one Request per shell asset with cache:'reload', which
// skips any HTTP-cache copy on the way to the origin and stores the origin's response in the HTTP cache on the way back,
// so a new shell cache holds one deployment.
const shell=[
  './','./index.html','./style.css?v=premium-v3','./slate.css?v=slate-v1','./weekly.css?v=premium-v3',
  './weekly-app.js?v=weekly-v24','./public-math.js?v=3','./survivor.css?v=4','./survivor-app.js?v=12','./survivor-math.js?v=7',
  './contest-rulings.js?v=2','./score-feed-proxy.js?v=2','./pwa.js?v=1','./share-card.js?v=2','./share-ui.js?v=2','./share.css?v=1',
  './home-dashboard.js?v=1','./home-dashboard.css?v=1','./picks-mobile.js?v=5','./picks-mobile.css?v=5','./season-record.js?v=1',
  './season-record.css?v=1','./manifest.webmanifest',
  './assets/pool-center-icon.svg','./assets/pool-center-icon-192.svg','./assets/pool-center-icon-512.svg'
].map(path=>new URL(path,workerURL).href);
assert.equal(addAllCalls.length,1,'install must precache the whole shell with one all-or-nothing Cache.addAll');
const installRequests=addAllCalls[0];
// It changes how each shell asset is fetched, never which: the HDC-06 shell, in the same order, every query string intact.
// A URL string is resolved as Cache.addAll would resolve it.
const precached=installRequests.map(request=>request instanceof Request?request.url:new URL(request,workerURL).href);
assert(precached.includes('https://example.test/nfl-pool/public-math.js?v=3'));
assert(!precached.some(url=>new URL(url).pathname.startsWith('/nfl-pool/admin')),'Admin pages must not be precached');
await hdc12('HDC-12 precached shell',()=>{
  assert(precached.includes('https://example.test/nfl-pool/survivor-math.js?v=7'),'survivor-math.js?v=7 must be precached');
  assert(precached.some(url=>/\/nfl-pool\/contest-rulings\.js\?v=\d+$/.test(url)),'the HDC-12 ruling evaluator must be precached');
});
await hdc14('HDC-14 precached shell',()=>{
  assert(precached.includes('https://example.test/nfl-pool/contest-rulings.js?v=2'),'the HDC-14 ruling evaluator (v2) must be precached');
});
await hdc15('HDC-15 precached shell',()=>{
  assert.deepEqual(precached,shell,'install must precache exactly the public shell, each asset at its own URL');
});
assert.deepEqual(installRequests.map(request=>request.cache),precached.map(()=>'reload'),
  'every shell asset must be requested with cache:"reload", never answered from a fresh HTTP-cache copy');
for(const mode of ['default','no-cache','no-store','force-cache','only-if-cached']){
  assert(!installRequests.some(request=>request.cache===mode),`no shell asset may be requested with cache:"${mode}"`);
}
assert(installRequests.every(request=>request instanceof Request),'install must give Cache.addAll Request objects, not URL strings');
await hdc15('HDC-15 weekly-v22 and survivor-app v11 reload requests',()=>{
  for(const asset of ['weekly-app.js?v=weekly-v24','survivor-app.js?v=12','share-card.js?v=2','share-ui.js?v=2','share.css?v=1','home-dashboard.js?v=1','home-dashboard.css?v=1','picks-mobile.js?v=5','picks-mobile.css?v=5','season-record.js?v=1','season-record.css?v=1'])
    assert.equal(installRequests[shell.indexOf(`https://example.test/nfl-pool/${asset}`)]?.url,`https://example.test/nfl-pool/${asset}`,`the reload request must keep the ${asset} query string`);
});
assert.deepEqual([fetchCalls.length,putCalls.length],[0,0],'install must fetch and store the shell only through Cache.addAll');
assert.equal(skipWaitingCalls,1,'a completed install skips waiting once');
await hdc15('HDC-15 install cache generation',()=>assert.deepEqual(opened,['pool-center-shell-v31'],'install must write the shell to pool-center-shell-v31'));
{
  // HDC-07 keeps Cache.addAll all-or-nothing. When any shell response is not OK the browser rejects addAll and stores none
  // of the shell; install must reject with that same error and never skip waiting, so the previous worker keeps control
  // with its complete shell instead of a partly filled one activating.
  const failure=new TypeError('Cache.addAll: ./survivor.css?v=3 answered HTTP 404'),failedListeners={},failedOpens=[],failedCalls=[];
  let failedSkips=0,failedInstall;
  vm.runInNewContext(source,{
    self:{location:self.location,clients:self.clients,skipWaiting:async()=>{failedSkips++},addEventListener(t,f){failedListeners[t]=f}},
    caches:{open:async name=>{failedOpens.push(name);return{addAll:async requests=>{failedCalls.push(Array.from(requests));throw failure},put:async()=>{throw new Error('install must not call cache.put')}}}},
    fetch:async()=>{throw new Error('install must not fetch outside Cache.addAll')},
    URL,Promise,console,Request
  });
  failedListeners.install({waitUntil:p=>{failedInstall=p}});
  await assert.rejects(failedInstall,error=>error===failure,'a shell asset that fails must fail the install with the Cache.addAll error');
  assert.equal(failedSkips,0,'a failed install must never skip waiting');
  assert.equal(failedCalls.length,1,'a failed Cache.addAll must not be retried or replaced by a partial precache');
  assert.equal(failedCalls[0].length,precached.length);
  await hdc15('HDC-15 failed-install cache generation',()=>assert.deepEqual(failedOpens,['pool-center-shell-v31']));
}

let activatePromise;
listeners.activate({waitUntil:p=>{activatePromise=p}});await activatePromise;
// HDC-05 rolls the shell cache so a v12 cache that may hold runtime-cached Admin modules is deleted on activation. Its
// corrective rolls it again: v13 was filled while noncanonical Admin paths (/nfl-pool//admin/, /nfl-pool/%61dmin/, ...)
// still reached networkFirst, so v13 may hold runtime-cached Admin modules under those paths and is deleted too. HDC-06
// rolls it to v15 with weekly-app.js?v=weekly-v14, so v14, which holds the weekly-v13 module and the page that loads it,
// is deleted as well. HDC-07 rolls it to v16: v15 may have been installed from still-fresh HTTP-cache copies, such as the
// page from before the HDC-06 deploy that loads weekly-v13, so v15 is deleted too. HDC-08 rolls it to v17 because v16
// may already contain runtime responses accepted from a still-fresh browser HTTP-cache copy. HDC-10 rolls it to v18 with
// weekly-app.js?v=weekly-v15, so v17, which holds the weekly-v14 module and the page that loads it, is deleted as well.
// HDC-11 rolls it to v19 with weekly-app.js?v=weekly-v16, survivor-app.js?v=6 and survivor-math.js?v=6, so v18, which
// holds the weekly-v15, survivor-app v5 and survivor-math v5 modules and the page that loads them, is deleted too.
// HDC-12 rolls it to v20 with weekly-app.js?v=weekly-v17, survivor-app.js?v=7, survivor-math.js?v=7, weekly.css premium-v3,
// survivor.css v4 and the new contest-rulings.js?v=1, so v19, which holds the modules, stylesheets and page they replace,
// is deleted too. HDC-14 rolls it to v21 with weekly-app.js?v=weekly-v18, survivor-app.js?v=8 and contest-rulings.js?v=2, so
// v20, which holds the weekly-v17, survivor-app v7 and contest-rulings v1 modules and the page that loads them, is deleted
// too. HDC-15 rolls it to v22 with weekly-app.js?v=weekly-v20 and survivor-app.js?v=9, so v21, which holds the weekly-v18 and
// survivor-app v8 modules and the page that loads them, is deleted too. The NFL-tie scoring change rolls it to v23 with
// weekly-app.js?v=weekly-v20 and public-math.js?v=3. Shareable cards roll it to v24 with weekly-app.js?v=weekly-v21,
// survivor-app.js?v=10 and the new share-card.js, share-ui.js and share.css, so v23, which holds the weekly-v20 and
// survivor-app v9 modules and the page that loads them, is deleted too. The Home dashboard rolls it to v25 with
// weekly-app.js?v=weekly-v22, survivor-app.js?v=11, share-card.js?v=2, share-ui.js?v=2 and the new home-dashboard.js and
// home-dashboard.css, so v24, which holds the modules they replace and the page that loads them, is deleted too. The V1.3 mobile
// UX rolls it to v26 with weekly-app.js?v=weekly-v23, survivor-app.js?v=12 and the new picks-mobile.js and picks-mobile.css, so
// v25, which holds the weekly-v22 and survivor-app v11 modules and the page that loads them, is deleted too. The V1.4 compact
// Picks UX rolls it to v27 with picks-mobile.js?v=2 and picks-mobile.css?v=2, so v26, which holds v=1 of both and the page that
// loads them, is deleted too. The V1.4 final polish rolls it to v28 with picks-mobile.js?v=3 and picks-mobile.css?v=3, so v27,
// which holds v=2 of both and the page that loads them, is deleted too. The V1.4 collapsible slate groups roll it to v29 with
// picks-mobile.js?v=4 and picks-mobile.css?v=4, so v28, which holds v=3 of both and the page that loads them, is deleted too.
// The V1.4 multi-select slates roll it to v30 with picks-mobile.js?v=5 and picks-mobile.css?v=5, so v29, which holds v=4 of both
// and the page that loads them, is deleted too. The season record rolls it to v31 with weekly-app.js?v=weekly-v24 and the new
// season-record.js and season-record.css, so v30, which holds the weekly-v23 module and the page that loads it, is deleted
// too. Only v31 is kept.
await hdc15('HDC-15 activation rollover',()=>assert.deepEqual(deleted,['pool-center-shell-v12','pool-center-shell-v13','pool-center-shell-v14','pool-center-shell-v15','pool-center-shell-v16','pool-center-shell-v17','pool-center-shell-v18','pool-center-shell-v19','pool-center-shell-v20','pool-center-shell-v21','pool-center-shell-v22','pool-center-shell-v23','pool-center-shell-v24','pool-center-shell-v25','pool-center-shell-v26','pool-center-shell-v27','pool-center-shell-v28','pool-center-shell-v29','pool-center-shell-v30'],'activation must delete v12 through v30 and keep only v31'));

const adminRequest={method:'GET',mode:'navigate',url:'https://example.test/nfl-pool/admin/survivor.html'};
let adminResponse;
const matchBefore=matchCalls.length;
listeners.fetch({request:adminRequest,respondWith:p=>{adminResponse=p}});
assert.equal(await adminResponse,okResponse);
assert.equal(matchCalls.length,matchBefore,'Admin navigation must not use a public-page fallback');

network=()=>{throw offline};
const publicRequest={method:'GET',mode:'navigate',url:'https://example.test/nfl-pool/?view=home'};
let publicResponse;
listeners.fetch({request:publicRequest,respondWith:p=>{publicResponse=p}});
assert.equal(await publicResponse,fallback,'offline public navigation should fall back to cached Pool Center shell');
assert(matchCalls.includes('./index.html'));

const page=path=>({method:'GET',mode:'navigate',url:`https://example.test${path}`});
const asset=path=>({method:'GET',mode:'no-cors',url:`https://example.test${path}`});
async function route(request){
  const seen=[fetchCalls.length,matchCalls.length,putCalls.length],initBefore=fetchInitCalls.length;
  let responded,result,error;
  listeners.fetch({request,respondWith:p=>{responded=p}});
  try{result=await responded}catch(err){error=err}
  return{result,error,fetched:fetchCalls.slice(seen[0]),fetchInit:fetchInitCalls.slice(initBefore),matched:matchCalls.slice(seen[1]),put:putCalls.slice(seen[2])};
}

// HDC-08. Model the browser HTTP cache separately from the origin. With ordinary default fetch semantics, a still-fresh
// response from the prior deployment wins. Managed runtime requests must instead use reload semantics, reach the NEW
// origin response, return it, and write only that NEW response into the active Cache API generation.
for(const request of [
  page('/nfl-pool/'),
  page('/nfl-pool/index.html'),
  page('/nfl-pool/?view=survivor'),
  page('/nfl-pool/?view=survivor&sw=4&season=2026'),
  asset('/nfl-pool/weekly-app.js?v=weekly-v17')
]){
  const stale=httpResponse(200),fresh=httpResponse(200);
  network=(_request,init)=>init?.cache==='reload'?fresh:stale;
  assert.equal(network(request),stale,`the modeled default-cache fetch for ${request.url} must receive the OLD HTTP-cache response`);
  const seen=await route(request);
  assert.equal(seen.result,fresh,`${request.url} must bypass the stale ordinary HTTP cache and return the NEW origin response`);
  assert.deepEqual(seen.fetched,[request]);
  assert.equal(seen.fetchInit.length,1);
  assert.equal(seen.fetchInit[0]?.cache,'reload',`${request.url} runtime fetch must force HTTP-cache reload semantics`);
  assert.deepEqual(seen.matched,[],'a successful fresh runtime response must not consult the Cache API fallback');
  assert.equal(seen.put.length,1,'a successful fresh runtime response must be cached');
  assert.equal(seen.put[0].request,request,'the fresh response must be cached under the originally requested resource');
  assert.equal(seen.put[0].response.cloneOf,fresh,'only the NEW origin response may be written into the active Cache API generation');
}

// A. HTTP 503 with the requested resource cached: its last-good copy wins over the error and the shell.
for(const request of [page('/nfl-pool/?view=survivor'),asset('/nfl-pool/weekly-app.js?v=weekly-v17')]){
  const lastGood=httpResponse(200),unavailable=httpResponse(503);
  cached.set(request.url,lastGood);
  network=()=>unavailable;
  const {result,matched,put}=await route(request);
  assert.equal(result,lastGood,`HTTP 503 for ${request.url} must serve its cached copy, not the error`);
  assert.deepEqual(matched,[request],'the requested resource is looked up before any configured fallback');
  assert.deepEqual(put,[],'an HTTP 503 must never be written to the cache');
  cached.delete(request.url);
}
{
  // B. HTTP 503 for a page that is not cached: the configured Pool Center shell fallback is served.
  const request=page('/nfl-pool/?view=weekly'),unavailable=httpResponse(503);
  network=()=>unavailable;
  const {result,matched,put}=await route(request);
  assert.equal(result,fallback,'HTTP 503 for an uncached page must fall back to the cached Pool Center shell');
  assert.deepEqual(matched,[request,'./index.html']);
  assert.deepEqual(put,[],'an HTTP 503 must never be written to the cache');
}
{
  // C. HTTP 503 with no cached copy and no configured fallback: the original response is returned as-is.
  const request=asset('/nfl-pool/slate.css?v=slate-v1'),unavailable=httpResponse(503);
  network=()=>unavailable;
  const {result,matched,put}=await route(request);
  assert.equal(result,unavailable,'with nothing cached the original HTTP 503 must be returned, not a replacement');
  assert.deepEqual(matched,[request]);
  assert.deepEqual(put,[],'an HTTP 503 must never be written to the cache');
}
{
  // C. The shell fallback is configured but not cached: the original response is still returned as-is.
  cached.delete('./index.html');
  const request=page('/nfl-pool/?view=weekly'),unavailable=httpResponse(503);
  network=()=>unavailable;
  const {result,matched,put}=await route(request);
  assert.equal(result,unavailable,'with neither the page nor the shell cached the original HTTP 503 must be returned');
  assert.deepEqual(matched,[request,'./index.html']);
  assert.deepEqual(put,[],'an HTTP 503 must never be written to the cache');
  cached.set('./index.html',fallback);
}
// D. HTTP 200: the network response itself is returned and a clone is cached under the request, as before.
for(const request of [page('/nfl-pool/?view=home'),asset('/nfl-pool/weekly-app.js?v=weekly-v17')]){
  const fresh=httpResponse(200);
  network=()=>fresh;
  const {result,matched,put}=await route(request);
  assert.equal(result,fresh,'a successful network response must be returned as-is');
  assert.equal(put.length,1,'a successful network response must be cached');
  assert.equal(put[0].request,request,'the successful response is cached under the requested resource');
  assert.equal(put[0].response.cloneOf,fresh,'the cache receives a clone of the successful response');
  assert.deepEqual(matched,[],'a successful network response does not consult the cache');
}
{
  // E. fetch throws with the requested resource cached: the cached copy is still served, before the shell.
  const request=page('/nfl-pool/?view=survivor'),lastGood=httpResponse(200);
  cached.set(request.url,lastGood);
  network=()=>{throw offline};
  const {result,matched,put}=await route(request);
  assert.equal(result,lastGood,'offline navigation must serve the cached requested page');
  assert.deepEqual(matched,[request]);
  assert.deepEqual(put,[]);
  cached.delete(request.url);
}
{
  // fetch throws with nothing cached and no configured fallback: the original network error still propagates.
  const request=asset('/nfl-pool/slate.css?v=slate-v1');
  network=()=>{throw offline};
  const {result,error,matched}=await route(request);
  assert.equal(error,offline,'an uncached offline request must reject with the original network error');
  assert.equal(result,undefined);
  assert.deepEqual(matched,[request]);
}
{
  // F. Admin navigation stays direct-network: neither an HTTP error nor an offline failure is replaced by a
  // cached copy or the public shell, even when both are available, and no Admin response is cached.
  const request=page('/nfl-pool/admin/'),unavailable=httpResponse(503),fresh=httpResponse(200);
  cached.set(request.url,httpResponse(200));
  network=()=>unavailable;
  let seen=await route(request);
  assert.equal(seen.result,unavailable,'Admin navigation must return the direct network response, even an HTTP error');
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[],'Admin navigation must not consult the cache or the public-page fallback');
  assert.deepEqual(seen.put,[]);
  network=()=>{throw offline};
  seen=await route(request);
  assert.equal(seen.error,offline,'offline Admin navigation must fail rather than receive the public shell');
  assert.deepEqual(seen.matched,[]);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[],'Admin navigation responses are never cached');
  cached.delete(request.url);
}
{
  // G. A public navigation the origin answers with a redirect reaches the worker as an opaqueredirect (status 0,
  // ok false). It is a redirect, not an HTTP error: the exact response is returned so the browser follows it, even
  // with the requested page and the Pool Center shell both cached; neither is consulted and nothing is cached.
  const request=page('/nfl-pool/?view=survivor'),lastGood=httpResponse(200);
  const redirect={type:'opaqueredirect',status:0,ok:false,clone:()=>({type:'opaqueredirect',status:0,ok:false,cloneOf:redirect})};
  cached.set(request.url,lastGood);
  assert.equal(cached.get(request.url),lastGood,'the requested page is cached for this regression');
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  network=()=>redirect;
  let seen=await route(request);
  assert.equal(seen.result,redirect,'a public navigation redirect must be returned unchanged, not a cached page or the shell');
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[],'a redirect must consult neither the requested page cache nor the ./index.html fallback');
  assert.deepEqual(seen.put,[],'a redirect must never be written to the cache');
  // With only the shell cached, the redirect is still not replaced by the ./index.html fallback.
  cached.delete(request.url);
  seen=await route(request);
  assert.equal(seen.result,redirect,'a public navigation redirect must not be replaced by the cached shell');
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  // A non-OK response that is not a redirect, such as an HTTP 404, still takes the HTTP error fallback.
  cached.set(request.url,lastGood);
  network=()=>Object.assign(httpResponse(404),{type:'basic'});
  seen=await route(request);
  assert.equal(seen.result,lastGood,'an HTTP 404 must still serve the cached copy of the requested page');
  assert.deepEqual(seen.matched,[request]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}

// Route boundary (RB). Pool Center is one document, /nfl-pool/ or /nfl-pool/index.html, whose views are selected by
// query string (?view=home, ?view=survivor, ...), never by pathname. index.html loads its CSS, JavaScript and icons by
// relative URL, so the shell renders only at those two paths. Any other navigation under the /nfl-pool/ scope is not a
// Pool Center route: it gets the exact network result, never a cached copy of itself or the ./index.html shell, and the
// worker neither reads nor writes the cache for it.
const opaqueRedirect=()=>{const response={type:'opaqueredirect',status:0,ok:false,clone:()=>({type:'opaqueredirect',status:0,ok:false,cloneOf:response})};return response};
const outcome=response=>response.type==='opaqueredirect'?'a redirect':`HTTP ${response.status}`;
const documentPaths=['/nfl-pool/','/nfl-pool/index.html','/nfl-pool/?view=home','/nfl-pool/?view=survivor','/nfl-pool/?view=survivor&sw=3&season=2026','/nfl-pool/index.html?view=picks'];
const invalidPaths=['/nfl-pool/assets/','/nfl-pool/foo','/nfl-pool/assets/missing/','/nfl-pool/not-a-route','/nfl-pool/assets/?view=home','/nfl-pool/foo?view=survivor&sw=3&season=2026','/nfl-pool/index.html/','/nfl-pool/assets/index.html'];
for(const path of documentPaths){
  // RB-A, RB-B, RB-C. Both document paths, with or without a query string, keep the HDC-02 navigation behavior.
  const request=page(path),lastGood=httpResponse(200);
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  for(const status of [404,503]){
    // RB-K. An HTTP error serves the cached copy of the requested page, else the ./index.html shell, else the original
    // response; it is never cached.
    const failed=httpResponse(status);
    network=()=>failed;
    cached.set(request.url,lastGood);
    let seen=await route(request);
    assert.equal(seen.result,lastGood,`HTTP ${status} for ${path} must serve the cached copy of the requested page`);
    assert.deepEqual(seen.fetched,[request]);
    assert.deepEqual(seen.matched,[request],'the requested page is looked up before the shell');
    assert.deepEqual(seen.put,[],`HTTP ${status} must never be written to the cache`);
    cached.delete(request.url);
    seen=await route(request);
    assert.equal(seen.result,fallback,`HTTP ${status} for uncached ${path} must fall back to the cached Pool Center shell`);
    assert.deepEqual(seen.matched,[request,'./index.html']);
    assert.deepEqual(seen.put,[]);
    cached.delete('./index.html');
    seen=await route(request);
    assert.equal(seen.result,failed,`HTTP ${status} for ${path} with nothing cached must be returned as-is`);
    assert.deepEqual(seen.matched,[request,'./index.html']);
    assert.deepEqual(seen.put,[]);
    cached.set('./index.html',fallback);
  }
  // RB-L. A thrown fetch serves the cached copy of the requested page, else the shell, else rejects with the original
  // network error.
  network=()=>{throw offline};
  cached.set(request.url,lastGood);
  let seen=await route(request);
  assert.equal(seen.result,lastGood,`offline ${path} must serve the cached copy of the requested page`);
  assert.deepEqual(seen.matched,[request]);
  cached.delete(request.url);
  seen=await route(request);
  assert.equal(seen.result,fallback,`offline uncached ${path} must fall back to the cached Pool Center shell`);
  assert.deepEqual(seen.matched,[request,'./index.html']);
  cached.delete('./index.html');
  seen=await route(request);
  assert.equal(seen.error,offline,`offline ${path} with nothing cached must reject with the original network error`);
  assert.deepEqual(seen.matched,[request,'./index.html']);
  assert.deepEqual(seen.put,[]);
  cached.set('./index.html',fallback);
  // RB-M. A successful response is returned as-is and a clone is cached under the request.
  const fresh=httpResponse(200);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh,`a successful ${path} response must be returned as-is`);
  assert.deepEqual(seen.matched,[]);
  assert.equal(seen.put.length,1,`a successful ${path} response must be cached`);
  assert.equal(seen.put[0].request,request);
  assert.equal(seen.put[0].response.cloneOf,fresh);
  // RB-N. A redirect is returned unchanged, even with the requested page cached, and is never cached.
  const redirect=opaqueRedirect();
  network=()=>redirect;
  cached.set(request.url,lastGood);
  seen=await route(request);
  assert.equal(seen.result,redirect,`a ${path} redirect must be returned unchanged`);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
{
  // RB-D, RB-F, RB-G, RB-H. The production-observed case: /nfl-pool/assets/ is a directory, not a Pool Center route.
  // Its HTTP 404 is returned unchanged whether the invalid URL itself, the ./index.html shell, both or neither are
  // cached; the worker calls neither caches.match nor cache.put for it.
  const request=page('/nfl-pool/assets/'),notFound=httpResponse(404);
  network=()=>notFound;
  for(const [state,urlCached,shellCached] of [
    ['the invalid URL and the shell both cached',true,true],
    ['only the invalid URL cached',true,false],
    ['only the ./index.html shell cached',false,true],
    ['nothing cached',false,false]
  ]){
    if(urlCached)cached.set(request.url,httpResponse(200));else cached.delete(request.url);
    if(shellCached)cached.set('./index.html',fallback);else cached.delete('./index.html');
    const seen=await route(request);
    assert.equal(seen.result,notFound,`HTTP 404 for /nfl-pool/assets/ with ${state} must be returned unchanged`);
    assert.deepEqual(seen.fetched,[request]);
    assert.deepEqual(seen.matched,[],`/nfl-pool/assets/ with ${state} must not call caches.match`);
    assert.deepEqual(seen.put,[],`/nfl-pool/assets/ with ${state} must not call cache.put`);
  }
  cached.delete(request.url);
  cached.set('./index.html',fallback);
}
for(const path of invalidPaths){
  // RB-E, RB-C, RB-H. Every invalid public pathname, nested or not, with or without a query string, and near-misses of
  // the two document paths get the exact network result even with their own URL and the shell cached.
  const request=page(path);
  cached.set(request.url,httpResponse(200));
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  for(const response of [httpResponse(404),httpResponse(500),httpResponse(503),opaqueRedirect()]){
    network=()=>response;
    const seen=await route(request);
    assert.equal(seen.result,response,`${outcome(response)} for ${path} must be returned unchanged`);
    assert.deepEqual(seen.fetched,[request]);
    assert.deepEqual(seen.matched,[],`${path} is not a Pool Center route and must not call caches.match`);
    assert.deepEqual(seen.put,[],`${path} is not a Pool Center route and must not call cache.put`);
  }
  // RB-I. A successful response is returned directly and is not cached by this worker.
  const fresh=httpResponse(200);
  network=()=>fresh;
  let seen=await route(request);
  assert.equal(seen.result,fresh,`a successful ${path} response must be returned as-is`);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[],`a successful ${path} response must not be cached by this worker`);
  // RB-J. A thrown fetch propagates the original network failure; no cached copy or shell replaces it.
  network=()=>{throw offline};
  seen=await route(request);
  assert.equal(seen.error,offline,`offline ${path} must reject with the original network error`);
  assert.equal(seen.result,undefined);
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
for(const path of ['/nfl-pool/admin','/nfl-pool/admin/','/nfl-pool/admin/survivor.html?season=2026']){
  // RB-O. Admin navigation stays direct-network: an HTTP 404 is returned unchanged with the Admin page and the shell
  // cached, and a successful response is not cached.
  const request=page(path),notFound=httpResponse(404),fresh=httpResponse(200);
  cached.set(request.url,httpResponse(200));
  network=()=>notFound;
  let seen=await route(request);
  assert.equal(seen.result,notFound,`Admin ${path} must return the direct network response`);
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[],'Admin navigation must not consult the cache or the public shell');
  assert.deepEqual(seen.put,[]);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[],'Admin navigation responses are never cached');
  cached.delete(request.url);
}
for(const path of ['/nfl-pool/style.css?v=premium-v3','/nfl-pool/pwa.js?v=1','/nfl-pool/assets/pool-center-icon.svg','/nfl-pool/manifest.webmanifest']){
  // RB-P. Public static assets keep networkFirst with their own cached copy as the only fallback: an HTTP 404 or a
  // thrown fetch serves the cached copy, an uncached 404 is returned as-is (never the shell), and a success is cached.
  const request=asset(path),lastGood=httpResponse(200),notFound=httpResponse(404),fresh=httpResponse(200);
  cached.set(request.url,lastGood);
  network=()=>notFound;
  let seen=await route(request);
  assert.equal(seen.result,lastGood,`HTTP 404 for ${path} must serve its cached copy`);
  assert.deepEqual(seen.matched,[request]);
  assert.deepEqual(seen.put,[]);
  network=()=>{throw offline};
  seen=await route(request);
  assert.equal(seen.result,lastGood,`offline ${path} must serve its cached copy`);
  assert.deepEqual(seen.matched,[request]);
  cached.delete(request.url);
  network=()=>notFound;
  seen=await route(request);
  assert.equal(seen.result,notFound,`HTTP 404 for uncached ${path} must be returned as-is, never the shell`);
  assert.deepEqual(seen.matched,[request]);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh);
  assert.equal(seen.put.length,1,`a successful ${path} response must be cached`);
  assert.equal(seen.put[0].request,request);
}

// Admin boundary (AB). Admin is production write-capable, so the worker never decides that an older copy of an Admin page,
// module or stylesheet may stand in for its current network representation. Every same-origin GET whose pathname is
// exactly /nfl-pool/admin or begins /nfl-pool/admin/ is direct network whatever its request mode, file extension or query
// string: the worker calls fetch(request) once and returns exactly what it yields, an HTTP error included, lets a thrown
// fetch reject with the original error, and never calls caches.match or cache.put for it, even with a copy of that Admin
// resource and the ./index.html shell both cached. The boundary is the request's own pathname: the shared public resources
// an Admin page loads, and paths that merely begin with "admin", keep the existing public routing.
const adminLoad=(path,mode)=>({method:'GET',mode,url:`https://example.test${path}`,referrer:'https://example.test/nfl-pool/admin/'});
async function assertDirectNetwork(request,label){
  cached.set(request.url,httpResponse(200));
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  for(const response of [httpResponse(200),httpResponse(404),httpResponse(500),httpResponse(503),opaqueRedirect()]){
    network=()=>response;
    const seen=await route(request);
    assert.equal(seen.result,response,`${outcome(response)} for Admin ${label} must be returned exactly, never a cached copy`);
    assert.equal(seen.fetched.length,1,`Admin ${label} must be fetched from the network once`);
    assert.equal(seen.fetched[0],request,`Admin ${label} must be fetched as requested`);
    assert.equal(seen.fetchInit.length,1);
    assert.equal(seen.fetchInit[0],undefined,`Admin ${label} must keep ordinary direct-network fetch semantics`);
    assert.deepEqual(seen.matched,[],`Admin ${label} must not call caches.match`);
    assert.deepEqual(seen.put,[],`Admin ${label} must not call cache.put`);
  }
  network=()=>{throw offline};
  const seen=await route(request);
  assert.equal(seen.error,offline,`offline Admin ${label} must reject with the original network error, never a cached copy`);
  assert.equal(seen.result,undefined);
  assert.equal(seen.fetched.length,1);
  assert.deepEqual(seen.matched,[],`offline Admin ${label} must not call caches.match`);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
async function assertNetworkFirst(request,label){
  const lastGood=httpResponse(200),notFound=httpResponse(404),fresh=httpResponse(200);
  cached.set(request.url,lastGood);
  for(const response of [httpResponse(404),httpResponse(503)]){
    network=()=>response;
    const seen=await route(request);
    assert.equal(seen.result,lastGood,`${outcome(response)} for ${label} must still serve its cached copy`);
    assert.deepEqual(seen.matched,[request]);
    assert.deepEqual(seen.put,[]);
  }
  network=()=>{throw offline};
  let seen=await route(request);
  assert.equal(seen.result,lastGood,`offline ${label} must still serve its cached copy`);
  assert.deepEqual(seen.matched,[request]);
  cached.delete(request.url);
  network=()=>notFound;
  seen=await route(request);
  assert.equal(seen.result,notFound,`HTTP 404 for uncached ${label} must be returned as-is, never the shell`);
  assert.deepEqual(seen.matched,[request]);
  network=()=>fresh;
  seen=await route(request);
  assert.equal(seen.result,fresh);
  assert.deepEqual(seen.matched,[]);
  assert.equal(seen.put.length,1,`a successful ${label} response must still be cached`);
  assert.equal(seen.put[0].request,request);
  assert.equal(seen.put[0].response.cloneOf,fresh);
}
for(const [url,mode] of [
  ['/nfl-pool/admin/admin.js?v=10','cors'],                  // module script of admin/index.html (Pick'em Admin)
  ['/nfl-pool/admin/parser-core.js?v=11','cors'],            // imported by admin.js
  ['/nfl-pool/admin/survivor-admin.js?v=3','cors'],          // module script of admin/survivor.html (Survivor Admin)
  ['/nfl-pool/admin/survivor-parser.js?v=3','cors'],         // imported by survivor-admin.js and survivor-publish-checks.js
  ['/nfl-pool/admin/survivor-publish-checks.js?v=2','cors'], // imported by survivor-admin.js
  ['/nfl-pool/admin/admin.css?v=premium-v3','no-cors']       // stylesheet of both Admin pages
]){
  // AB-A, AB-B, AB-C. The current Admin module or stylesheet URL, in the mode its page requests it: a success is not
  // cached, an HTTP 404/500/503 is not replaced by the cached copy, and a thrown fetch is not answered from the cache.
  await assertDirectNetwork(adminLoad(url,mode),url);
  // AB-D. Only the pathname decides: another version, or no query string at all, routes identically.
  const pathname=url.slice(0,url.indexOf('?'));
  for(const other of [`${pathname}?v=999`,pathname])await assertDirectNetwork(adminLoad(other,mode),other);
  // AB-E. So does every other request mode, a navigation to the file included.
  for(const other of ['cors','no-cors','same-origin','navigate'].filter(m=>m!==mode))await assertDirectNetwork(adminLoad(url,other),`${url} (${other})`);
}
for(const path of ['/nfl-pool/admin','/nfl-pool/admin/','/nfl-pool/admin/index.html','/nfl-pool/admin/survivor.html']){
  // AB-F. Admin page navigations keep their direct-network behavior, and a non-navigation request for the same Admin
  // path is direct network too instead of reaching the public static-resource cache.
  await assertDirectNetwork(page(path),`${path} navigation`);
  await assertDirectNetwork(adminLoad(path,'cors'),path);
}
for(const path of ['/nfl-pool/administrator/','/nfl-pool/admin-old.js','/nfl-pool/admin2/','/nfl-pool/admin.js?v=10','/nfl-pool/assets/nfl-pool/admin/admin.js']){
  // AB-G. The gate has a path boundary and is anchored at the start of the pathname: siblings that merely begin with
  // "admin", an Admin-named file outside the directory and a path that nests the Admin directory deeper are not Admin.
  // As subresources they keep networkFirst; as navigations they stay non-document routes with the exact network result.
  await assertNetworkFirst(asset(path),path);
  const request=page(path),notFound=httpResponse(404);
  cached.set(request.url,httpResponse(200));
  network=()=>notFound;
  const seen=await route(request);
  assert.equal(seen.result,notFound,`${path} navigation is not a Pool Center route: its HTTP 404 must be returned unchanged`);
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
for(const [path,mode] of [
  ['/nfl-pool/style.css?v=premium-v3','no-cors'],
  ['/nfl-pool/slate.css?v=slate-v1','no-cors'],
  ['/nfl-pool/score-feed-proxy.js?v=2','no-cors'],
  ['/nfl-pool/pwa.js?v=1','no-cors'],
  ['/nfl-pool/assets/pool-center-icon.svg','no-cors'],
  ['/nfl-pool/manifest.webmanifest','cors'],
  ['/nfl-pool/survivor-math.js?v=4','cors']                  // imported by admin/survivor-publish-checks.js
]){
  // AB-H. The boundary is the request's own pathname, never the page that asked for it: the shared public resources the
  // Admin pages load keep networkFirst with their own cached copy as the only fallback.
  await assertNetworkFirst(adminLoad(path,mode),`${path} requested by an Admin page`);
}
{
  // AB-I. An Admin path that appears only in the query string does not make a public request Admin: the public asset
  // keeps networkFirst and the public document keeps the HDC-02 shell fallback.
  await assertNetworkFirst(asset('/nfl-pool/style.css?v=premium-v3&from=/nfl-pool/admin/'),'a public asset with an Admin path in its query');
  const request=page('/nfl-pool/?view=home&from=/nfl-pool/admin/'),unavailable=httpResponse(503);
  network=()=>unavailable;
  const seen=await route(request);
  assert.equal(seen.result,fallback,'an Admin path in the query string must not take a public document out of the shell fallback');
  assert.deepEqual(seen.matched,[request,'./index.html']);
  assert.deepEqual(seen.put,[]);
}
for(const request of [
  {method:'POST',mode:'cors',url:'https://example.test/nfl-pool/admin/admin.js?v=10'},
  {method:'GET',mode:'cors',url:'https://cdn.example/nfl-pool/admin/admin.js?v=10'}
]){
  // AB-J. The gate runs after the existing GET and same-origin checks: a non-GET request and another origin's Admin-shaped
  // path are still left to the browser, untouched by the worker.
  network=()=>okResponse;
  const seen=await route(request);
  assert.deepEqual(seen.fetched,[],`${request.method} ${request.url} must not be handled by the worker`);
  assert.equal(seen.result,undefined);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
}
for(const [path,mode] of [
  ['/nfl-pool/admin/sub/path/module.js','cors'],
  ['/nfl-pool/admin/sub/path/module.js?v=1','cors'],
  ['/nfl-pool/admin/sub/path/theme.css?v=1','no-cors'],
  ['/nfl-pool/admin/sub/path/icon.svg','no-cors'],
  ['/nfl-pool/admin/sub/','cors'],
  ['/nfl-pool/admin/sub/path/module.js','navigate'],
  ['/nfl-pool/admin/sub/','navigate']
]){
  // AB-K. Every depth below /nfl-pool/admin/ is Admin: a nested module, stylesheet, icon or directory, requested as a
  // subresource or navigated to, is direct network exactly like a top-level Admin file, with its own stale copy and the
  // shell both cached.
  await assertDirectNetwork(adminLoad(path,mode),`${path} (${mode})`);
}
async function assertExactNavigation(path){
  const request=page(path),notFound=httpResponse(404);
  cached.set(request.url,httpResponse(200));
  network=()=>notFound;
  const seen=await route(request);
  assert.equal(seen.result,notFound,`${path} navigation is not a Pool Center route: its HTTP 404 must be returned unchanged`);
  assert.deepEqual(seen.fetched,[request]);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
  cached.delete(request.url);
}
for(const path of ['/nfl-pool/admin.css','/nfl-pool/admin.css?v=premium-v3']){
  // AB-L. A stylesheet beside the Admin directory whose name merely begins with "admin" is not the Admin stylesheet
  // (/nfl-pool/admin/admin.css): as a subresource it keeps networkFirst with its own cached copy as the only fallback,
  // and as a navigation it keeps the exact network result.
  await assertNetworkFirst(asset(path),path);
  await assertExactNavigation(path);
}
for(const path of ['/nfl-pool/administrator','/nfl-pool/administer','/nfl-pool/admin-old']){
  // AB-M. Extensionless siblings that merely begin with "admin" are not Admin. An Admin path is always answered with
  // fetch(request); these are not static resources either, so in every subresource mode the worker still leaves them to
  // the browser, even with a copy of them cached, and as navigations they keep the exact network result.
  for(const mode of ['cors','no-cors','same-origin']){
    const request={...asset(path),mode};
    cached.set(request.url,httpResponse(200));
    network=()=>okResponse;
    const seen=await route(request);
    assert.deepEqual(seen.fetched,[],`${path} (${mode}) is not Admin and must not be answered by the worker`);
    assert.equal(seen.result,undefined);
    assert.deepEqual(seen.matched,[]);
    assert.deepEqual(seen.put,[]);
    cached.delete(request.url);
  }
  await assertExactNavigation(path);
}

// Noncanonical Admin paths (NC). GitHub Pages also serves the Admin directory at spellings other than /nfl-pool/admin/:
// it decodes each %XX escape once, merges repeated slashes and then removes dot segments, so /nfl-pool//admin/,
// /nfl-pool///admin/, /nfl-pool/%61dmin/, /nfl-pool/a%64min/, /nfl-pool%2Fadmin/ and /nfl-pool/x%2F..%2Fadmin/ all return
// the real Admin page and modules (checked against production with read-only GETs). An Admin page opened at such a path
// loads its modules and stylesheet relative to it, under the same spelling. Every such request is Admin and gets exactly
// the direct-network behavior of the canonical path, fetched as it was made; paths that only look similar, and the shared
// public resources such a page loads, keep their existing routing.
const ncLoad=(path,mode,referrer='/nfl-pool//admin/')=>({method:'GET',mode,url:`https://example.test${path}`,referrer:`https://example.test${referrer}`});
const allModes=['navigate','cors','no-cors','same-origin'];
{
  // NC-A. The production defect. With a stale copy of the Pick'em Admin module cached under the spelling its page at
  // /nfl-pool//admin/ requests, a success must be returned without being cached, and an HTTP 503 must be returned as the
  // 503 itself, never answered with the stale copy of write-capable Admin code.
  const request=ncLoad('/nfl-pool//admin/admin.js?v=10','cors'),stale=httpResponse(200),fresh=httpResponse(200),unavailable=httpResponse(503);
  const answered=response=>response===stale?'the stale cached copy':response===fresh?'the network HTTP 200':response===unavailable?'the network HTTP 503':'another response';
  cached.set(request.url,stale);
  network=()=>fresh;
  const healthy=await route(request);
  network=()=>unavailable;
  const failed=await route(request);
  cached.delete(request.url);
  assert.deepEqual({
    'HTTP 200 answered with':answered(healthy.result),'HTTP 200 cache.put calls':healthy.put.length,
    'HTTP 503 answered with':answered(failed.result),'HTTP 503 caches.match calls':failed.matched.length
  },{
    'HTTP 200 answered with':'the network HTTP 200','HTTP 200 cache.put calls':0,
    'HTTP 503 answered with':'the network HTTP 503','HTTP 503 caches.match calls':0
  },'/nfl-pool//admin/admin.js?v=10 is Admin: it must be direct network, never cached and never answered from the cache');
}
for(const path of ['/nfl-pool//admin/','/nfl-pool//admin/admin.js?v=10','/nfl-pool///admin/parser-core.js?v=11']){
  // NC-B. The repeated-slash Admin directory and the modules its page loads, in every request mode: a success is not
  // cached, an HTTP 404/500/503 or a redirect is returned exactly and a thrown fetch rejects, with a stale copy of the
  // resource and the shell both cached. Two slashes or three make no difference.
  for(const mode of allModes)await assertDirectNetwork(ncLoad(path,mode),`${path} (${mode})`);
}
for(const path of ['/nfl-pool/%61dmin/','/nfl-pool/%61dmin/admin.js?v=10','/nfl-pool/a%64min/','/nfl-pool/a%64min/parser-core.js?v=11']){
  // NC-C. A percent-encoded letter of "admin" names the same directory, in every request mode, for the directory itself
  // and for its modules alike.
  for(const mode of allModes)await assertDirectNetwork(ncLoad(path,mode,'/nfl-pool/%61dmin/'),`${path} (${mode})`);
}
for(const prefix of [
  '/nfl-pool//admin/','/nfl-pool///admin/','/nfl-pool////admin/','//nfl-pool/admin/','/nfl-pool//admin//',
  '/nfl-pool/%61dmin/','/nfl-pool/a%64min/','/nfl-pool/%61%64%6D%69%6E/','/nfl-pool/%61%64%6d%69%6e/',
  '/nfl-pool%2Fadmin/','/nfl-pool/admin%2F','/nfl-pool%2F%2Fadmin%2F','/nfl-pool/.%2Fadmin/',
  '/nfl-pool/x%2F..%2Fadmin/','/nfl-pool/x%2F%2E%2E%2Fadmin/','/nfl-pool/x//..%2Fadmin/'
]){
  // NC-D. Every current Admin page, module and stylesheet, in the mode its page requests it, under each spelling Pages
  // resolves to /nfl-pool/admin/: repeated slashes anywhere, encoded letters in either hex case, an encoded slash, an
  // encoded single-dot segment, and an encoded dot-dot segment that climbs back into the Admin directory (Pages merges
  // repeated slashes before removing it).
  for(const [file,mode] of [
    ['index.html','navigate'],['survivor.html','navigate'],['admin.css?v=premium-v3','no-cors'],
    ['admin.js?v=10','cors'],['parser-core.js?v=11','cors'],['survivor-admin.js?v=3','cors'],
    ['survivor-parser.js?v=3','cors'],['survivor-publish-checks.js?v=2','cors']
  ])await assertDirectNetwork(ncLoad(prefix+file,mode,prefix),`${prefix}${file} (${mode})`);
}
for(const path of ['/nfl-pool//admin/%E0%A4%A.js','/nfl-pool/%61dmin/%ZZ.js','/nfl-pool/a%64min/%','/nfl-pool//admin/%C3.css']){
  // NC-E. A malformed escape (a % without two hex digits after it, or an incomplete UTF-8 sequence) is one that
  // decodeURIComponent cannot decode. It must never throw out of the fetch handler: it stays literal text and the rest of
  // the path is still classified, so a request inside the Admin directory stays Admin and direct network (Pages answers
  // such a path HTTP 400, which reaches the page exactly) ...
  for(const mode of ['cors','navigate'])await assertDirectNetwork(ncLoad(path,mode),`${path} (${mode})`);
}
for(const path of ['/nfl-pool/%ZZ/style.css','/nfl-pool//%E0%A4%A.css','/nfl-pool/adm%ZZin/admin.js','/nfl-pool/%61dm%ZZin/x.js']){
  // ... while a malformed escape anywhere else, including inside what would be the "admin" segment, does not make a
  // public request Admin: as a subresource it keeps networkFirst, and as a navigation the exact network result.
  await assertNetworkFirst(asset(path),path);
  await assertExactNavigation(path);
}
for(const path of [
  '/nfl-pool//administrator/','/nfl-pool//admin-old.js','/nfl-pool//admin2/',
  '/nfl-pool/%61dministrator/','/nfl-pool/%61dmin-old.js','/nfl-pool/%61dmin2/',
  '/nfl-pool/%2561dmin/admin.js?v=10','/nfl-pool/Admin/admin.js?v=10','/nfl-pool/admin%5Cadmin.js?v=10',
  '/nfl-pool//..%2Fadmin/admin.js?v=10','/nfl-pool/admin%2F..%2Fstyle.css?v=premium-v3'
]){
  // NC-F. Normalization does not widen the boundary. Siblings that merely begin with "admin" stay public however they are
  // spelled, and so do the spellings Pages itself does not resolve into the Admin directory: a double-encoded escape
  // (decoded once, it is %61dmin), another letter case, an encoded backslash, a dot segment that climbs out of /nfl-pool/
  // before "admin" (the slashes merge first, so it lands on /admin/) and one that climbs out of the Admin directory to a
  // public file. As subresources they keep networkFirst with their own cached copy as the only fallback, and as
  // navigations the exact network result.
  await assertNetworkFirst(asset(path),path);
  await assertExactNavigation(path);
}
for(const query of ['from=/nfl-pool//admin/','from=/nfl-pool/%61dmin/','from=%2Fnfl-pool%2F%2Fadmin%2F']){
  // NC-G. A noncanonical Admin spelling that appears only in the query string does not make a public request Admin: the
  // public asset keeps networkFirst and the public document keeps the HDC-02 shell fallback.
  await assertNetworkFirst(asset(`/nfl-pool/style.css?v=premium-v3&${query}`),`a public asset with ${query} in its query`);
  const request=page(`/nfl-pool/?view=home&${query}`),unavailable=httpResponse(503);
  network=()=>unavailable;
  const seen=await route(request);
  assert.equal(seen.result,fallback,`${query} in the query string must not take a public document out of the shell fallback`);
  assert.deepEqual(seen.matched,[request,'./index.html']);
  assert.deepEqual(seen.put,[]);
}
for(const request of [
  {method:'POST',mode:'cors',url:'https://example.test/nfl-pool//admin/admin.js?v=10'},
  {method:'POST',mode:'navigate',url:'https://example.test/nfl-pool/%61dmin/'},
  {method:'GET',mode:'cors',url:'https://cdn.example/nfl-pool//admin/admin.js?v=10'},
  {method:'GET',mode:'cors',url:'https://cdn.example/nfl-pool/%61dmin/admin.js?v=10'}
]){
  // NC-H. Normalization runs after the existing GET and same-origin checks: a non-GET request and another origin's
  // noncanonical Admin-shaped path are still left to the browser, untouched by the worker.
  network=()=>okResponse;
  const seen=await route(request);
  assert.deepEqual(seen.fetched,[],`${request.method} ${request.url} must not be handled by the worker`);
  assert.equal(seen.result,undefined);
  assert.deepEqual(seen.matched,[]);
  assert.deepEqual(seen.put,[]);
}
for(const [path,mode,referrer] of [
  ['/nfl-pool//style.css?v=premium-v3','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//slate.css?v=slate-v1','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//score-feed-proxy.js?v=2','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//pwa.js?v=1','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//assets/pool-center-icon.svg','no-cors','/nfl-pool//admin/'],
  ['/nfl-pool//manifest.webmanifest','cors','/nfl-pool//admin/'],
  ['/nfl-pool//survivor-math.js?v=4','cors','/nfl-pool//admin/survivor-publish-checks.js?v=2'],
  ['/nfl-pool///style.css?v=premium-v3','no-cors','/nfl-pool///admin/'],
  ['/nfl-pool///survivor-math.js?v=4','cors','/nfl-pool///admin/survivor-publish-checks.js?v=2'],
  ['/nfl-pool/style.css?v=premium-v3','no-cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/slate.css?v=slate-v1','no-cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/score-feed-proxy.js?v=2','no-cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/pwa.js?v=1','no-cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/survivor-math.js?v=4','cors','/nfl-pool/%61dmin/survivor-publish-checks.js?v=2'],
  ['/nfl-pool/manifest.webmanifest','cors','/nfl-pool/%61dmin/'],
  ['/nfl-pool/weekly-app.js?v=weekly-v17','cors','/nfl-pool/'],
  ['/nfl-pool/assets/pool-center-icon-192.svg','no-cors','/nfl-pool/'],
  ['/nfl-pool/assets/pool-center-icon-512.svg','no-cors','/nfl-pool/']
]){
  // NC-I. The shared public resources a noncanonical Admin page loads are not Admin: by ../ from /nfl-pool//admin/ they
  // keep the repeated slash, from /nfl-pool/%61dmin/ they are the canonical public files. Like the rest of the public
  // static shell they keep networkFirst with their own cached copy as the only fallback.
  await assertNetworkFirst(ncLoad(path,mode,referrer),`${path} requested by ${referrer}`);
}
for(const path of ['/nfl-pool//','/nfl-pool//index.html','/nfl-pool///?view=home','/nfl-pool/%69ndex.html','/nfl-pool/index%2Ehtml']){
  // NC-J. Only the Admin gate reads the normalized path. The Pool Center document is still exactly /nfl-pool/ or
  // /nfl-pool/index.html as written (its relative assets resolve only there), so another spelling of either is not a
  // document path: it gets the exact network result, never the shell or a cached copy, and nothing is cached for it.
  const request=page(path);
  cached.set(request.url,httpResponse(200));
  assert.equal(cached.get('./index.html'),fallback,'the Pool Center shell is cached for this regression');
  for(const response of [httpResponse(404),httpResponse(503),httpResponse(200)]){
    network=()=>response;
    const seen=await route(request);
    assert.equal(seen.result,response,`${outcome(response)} for ${path} must be returned unchanged`);
    assert.deepEqual(seen.fetched,[request]);
    assert.deepEqual(seen.matched,[],`${path} is not a document path and must not call caches.match`);
    assert.deepEqual(seen.put,[],`${path} is not a document path and must not call cache.put`);
  }
  network=()=>{throw offline};
  const seen=await route(request);
  assert.equal(seen.error,offline,`offline ${path} must reject with the original network error, never the shell`);
  assert.deepEqual(seen.matched,[]);
  cached.delete(request.url);
}
for(const path of ['/nfl-pool/admin/x%2F..%2F..%2Fstyle.css?v=premium-v3','/nfl-pool/admin/%2E%2E%2Fslate.css?v=slate-v1','/nfl-pool/admin/..%2F..%2Findex.html']){
  // NC-K. Normalization only adds Admin spellings and never removes one: a pathname that begins /nfl-pool/admin/ as
  // written stays Admin, as HDC-05 made it, even where an encoded dot segment reads it out of the Admin directory (Pages
  // answers the first with the public stylesheet). It is direct network in every request mode, never a cached copy.
  for(const mode of allModes)await assertDirectNetwork(ncLoad(path,mode,'/nfl-pool/admin/'),`${path} (${mode})`);
}
// Every cache the worker opened, at install and before each runtime cache.put above, is pool-center-shell-v24.
assert.equal(opened.length,1+putCalls.length,'install and each runtime cache.put open the shell cache once');
await hdc15('HDC-15 runtime cache generation',()=>assert.deepEqual([...new Set(opened)],['pool-center-shell-v31'],'the worker must write only to pool-center-shell-v31'));

// ---- HDC-12 version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v19 (main 8caafa6): an asset whose bytes changed is requested at a new version, an asset whose bytes did
// not change keeps its version (no unrelated bump), a new asset carries an explicit version, and any change to the shell's
// contents rolls the shell cache. The page, the worker and the public modules reference each shell asset at exactly its
// precached version and at no other.
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?createHash('sha256').update(b).digest('hex'):null)};
  const V19={
    'index.html':[null,'f1eb28a1d4a3dff17638f0842846e5bc9dad4bdea39cd9fa6eb1123f1ec308c7'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v2','93125860c48b3cbeed37419fe04a375a02130e90647c629e53def1db804107ab'],
    'weekly-app.js':['weekly-v16','b95b5bb5e124f211bd76e1b65eab1dc94ae6ada109ff781431fd93a7b2263112'],
    'public-math.js':['2','1dd847931f83cc021341a657b8913eab208a8ab62721705b5cf4cd0803cc79db'],
    'survivor.css':['3','6f3da84a8772d14ba35bbade0c83168a0715a1019d58ae97d8ad35685d73c396'],
    'survivor-app.js':['6','460f7acae675c983911831022bbd4790faab28a687ce15956f30b4b609d6b7ef'],
    'survivor-math.js':['6','505b10a7c67b53144ddd72d30b88920a6d80b30bef06b98b510c6835a3c507aa'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=precached.map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await hdc12('HDC-12 changed bytes roll the version, unchanged bytes keep it',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V19[path];
      if(!before){if(!version)problems.push(`${path} is new to the shell and must carry an explicit version`);continue}
      const changed=sha(path)!==before[1];
      if(before[0]===null)continue; // unversioned (the page, the manifest, the icons): only the shell cache can roll
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
    }
    assert.deepEqual(problems,[]);
  });
  await hdc12('HDC-12 shell cache rolls when shell contents change',()=>{
    const shellChanged=entries.some(({path})=>!V19[path]||sha(path)!==V19[path][1])||Object.keys(V19).some(path=>!entries.some(e=>e.path===path));
    assert(shellChanged,'HDC-12 changes the shell');
    assert.notEqual(cacheName,'pool-center-shell-v19','a changed shell must not reuse pool-center-shell-v19');
  });
  await hdc12('HDC-12 references match the precache exactly',()=>{
    const shellVersion=new Map(entries.map(e=>[e.path,e.version]));
    const refs=[...index.matchAll(/(?:src|href)="([^":]+?\.(?:js|css)(?:\?[^"]*)?)"/g)].map(m=>['index.html',m[1]]);
    for(const file of ['weekly-app.js','survivor-app.js','survivor-math.js','contest-rulings.js','public-math.js']){
      const text=bytes(file)?.toString('utf8');
      if(text)for(const m of text.matchAll(/(?:from|import)\s*\(?\s*'(\.\/[^']+)'/g))refs.push([file,m[1]]);
    }
    for(const app of ['weekly-app.js','survivor-app.js'])
      assert(refs.some(([from,ref])=>from===app&&/^\.\/contest-rulings\.js\?v=\d+$/.test(ref)),`${app} must import the versioned ./contest-rulings.js`);
    for(const [from,ref] of refs){
      const u=new URL(ref,'https://example.test/nfl-pool/'),path=u.pathname.replace('/nfl-pool/','');
      assert(shellVersion.has(path),`${from} loads ${ref}, which must be precached`);
      assert.equal(u.searchParams.get('v'),shellVersion.get(path),`${from} must load ${path} at its precached version`);
    }
    // No stale query string: each versioned shell asset is named at one version only in the worker and the page.
    for(const {path,version} of entries)if(version){
      const escaped=path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      for(const [label,text] of [['service-worker.js',source],['index.html',index]]){
        const versions=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert(versions.size<=1&&(!versions.size||versions.has(version)),`${label} names ${path} at ${[...versions].join(', ')}; only v=${version} is precached`);
      }
    }
  });
  // Review-driven regression (added after the implementation's adversarial review): both apps render their Rules & rulings
  // card into a container the page must actually have; the app harnesses create any element they are asked for.
  await hdc12('index.html has exactly one Rules & rulings container in each contest panel',()=>{
    // A panel runs from its opening tag to its own matching </section>, never into the markup that follows it.
    const panelOf=name=>{
      const start=index.indexOf(`<section class="view-panel" data-view-panel="${name}"`),tags=/<section\b[^>]*>|<\/section>/g;
      if(start<0)return'';
      tags.lastIndex=start;let depth=0,m;
      while((m=tags.exec(index))){depth+=m[0][1]==='/'?-1:1;if(!depth)return index.slice(start,m.index)}
      return'';
    };
    for(const [id,panel] of [['pickemRules','games'],['svRules','survivor']]){
      assert.equal(index.split(`id="${id}"`).length-1,1,`index.html has exactly one #${id}`);
      assert(panelOf(panel).includes(`id="${id}"`),`#${id} is inside the ${panel} panel`);
    }
  });
}

// ---- HDC-14 version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v20 (main 6a3c6a7, the production baseline): an asset whose bytes changed is requested at a new version,
// an asset whose bytes did not change keeps its version (no unrelated bump), and any change to the shell's contents rolls
// the shell cache to v21. The public modules reference the evaluator at exactly its precached version.
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?createHash('sha256').update(b).digest('hex'):null)};
  const V20={
    'index.html':[null,'73673852dbd92ac0661898b1cc4c9b51f9e7ffd4307657dea6231f7867352a9e'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v17','98fbf75550a86aefe8a71271ed5934cfc8a96df6684609ae1f3cc401ed022974'],
    'public-math.js':['2','1dd847931f83cc021341a657b8913eab208a8ab62721705b5cf4cd0803cc79db'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['7','4b5e8256aabb60e4dc135751d6b8a09b958f1ac9859ae55f596c549a4c06eb25'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['1','10ce2d245e396c404697fb8d2628785a9d5dccfe7df3cac42e5722d51926556a'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=precached.map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await hdc14('HDC-14 changed bytes roll the version, unchanged bytes keep it (against pool-center-shell-v20)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V20[path];
      if(!before){if(!SHARE_CARDS.assets.has(path)&&!HOME_DASHBOARD.assets.has(path)&&!PICKS_MOBILE.assets.has(path)&&!SEASON_RECORD.assets.has(path))problems.push(`${path} is new to the shell: HDC-14 adds no shell asset`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
    }
    for(const path of ['contest-rulings.js','weekly-app.js','survivor-app.js'])if(sha(path)===V20[path][1])problems.push(`${path} must change for HDC-14`);
    for(const path of ['survivor-math.js','style.css','slate.css','weekly.css','survivor.css','score-feed-proxy.js','pwa.js'])
      if(sha(path)!==V20[path][1])problems.push(`${path} is outside HDC-14 and must keep its bytes`);
    assert.deepEqual(problems,[]);
  });
  await hdc14('HDC-14 shell cache rolls from pool-center-shell-v20',()=>{
    assert.notEqual(cacheName,'pool-center-shell-v20','a changed shell must not reuse pool-center-shell-v20');
  });
  await hdc14('HDC-14 both apps import the evaluator at its precached version (contest-rulings.js?v=2)',()=>{
    for(const app of ['weekly-app.js','survivor-app.js'])
      assert(bytes(app)?.toString('utf8').includes("from './contest-rulings.js?v=2';"),`${app} must import ./contest-rulings.js?v=2`);
  });
}

// ---- HDC-15 version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v21 (main 2c901a8, the production baseline): HDC-15 changes the bytes of weekly-app.js and survivor-app.js
// only, so exactly those two roll their version and every other asset keeps its bytes and version; the shell cache rolls to
// v22. Mixed versions stay safe: the page differs from the baseline page only in those two module versions (a new module
// needs no new markup, so a page cached before the deploy runs it correctly), and the worker differs from the baseline worker
// only in its cache name and those two precache entries (the network-first strategy is unchanged).
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const digest=b=>createHash('sha256').update(b).digest('hex'),sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?digest(b):null)};
  const V21={
    'index.html':[null,'58920e778fb613bbc970bbfa4af960d00f8374f0ca43e65268f2ad0af96e79ba'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v18','4519c602f004065cdb8c46395b0f9c2452026d251e2e0b7e49e4b0be7465cf7f'],
    'public-math.js':['2','1dd847931f83cc021341a657b8913eab208a8ab62721705b5cf4cd0803cc79db'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['8','974b37ded9241e83fe6e1b5a13446ed3319986cc45efe2650872bb6e29f3ca30'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['2','5422cd96a48333f4eceaaf0d6b300b30f0a09d24b34de42a619e20e8fc401a77'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const V21_WORKER='4233e9ab36cfd10442ab13f88ed0c6f4f6bd5a2a25e0592122f6b49532f314e0';
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=precached.map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await hdc15('HDC-15 changes exactly weekly-app.js and survivor-app.js and rolls exactly their versions (against pool-center-shell-v21)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V21[path];
      if(!before){if(!SHARE_CARDS.assets.has(path)&&!HOME_DASHBOARD.assets.has(path)&&!PICKS_MOBILE.assets.has(path)&&!SEASON_RECORD.assets.has(path))problems.push(`${path} is new to the shell: HDC-15 adds no shell asset`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
    }
    for(const path of ['weekly-app.js','survivor-app.js'])if(sha(path)===V21[path][1])problems.push(`${path} must change for HDC-15`);
    for(const path of ['contest-rulings.js','survivor-math.js','style.css','slate.css','weekly.css','survivor.css','score-feed-proxy.js','pwa.js','manifest.webmanifest','assets/pool-center-icon.svg','assets/pool-center-icon-192.svg','assets/pool-center-icon-512.svg'])
      if(sha(path)!==V21[path][1])problems.push(`${path} is outside HDC-15 and must keep its bytes`);
    assert.notEqual(sha('public-math.js'),V21['public-math.js'][1],'tie-loss scoring intentionally updates public-math.js');
    assert.deepEqual(problems,[]);
  });
  await hdc15('HDC-15 shell cache rolls from pool-center-shell-v21 to v22',()=>{
    assert.notEqual(cacheName,'pool-center-shell-v21','a changed shell must not reuse pool-center-shell-v21');
    assert.equal(cacheName,'pool-center-shell-v31');
  });
  await hdc15('HDC-15 mixed versions: the page changes only its two module versions, so either page runs either module set',()=>{
    const page=withoutHomeDashboard(withoutPicksMobile(withoutPicksCompact(withoutPicksPolish(withoutPicksAccordion(withoutPicksSlates(withoutSeasonRecord(bytes('index.html').toString('utf8'))))))));
    assert.equal(page.split('weekly-app.js?v=weekly-v21').length-1,1,'the page loads weekly-v21 exactly once');
    assert.equal(page.split('survivor-app.js?v=10"').length-1,1,'the page loads survivor-app v10 exactly once');
    const baselineSpelling=withoutShareCards(page).replace('weekly-app.js?v=weekly-v21','weekly-app.js?v=weekly-v18').replace('survivor-app.js?v=10"','survivor-app.js?v=8"')
      .replace('tie = 1 loss','tie = 0').replace('NFL ties = 1 loss for both picks.','NFL ties = 0 points.');
    assert.equal(digest(Buffer.from(baselineSpelling,'utf8')),V21['index.html'][1],'apart from the two module versions the page is byte-identical to the baseline page: no markup the new modules depend on');
  });
  await hdc15('HDC-15 the worker changes only its cache name and the two module precache entries (strategy unchanged)',()=>{
    const baselineSpelling=sourceBefore.replace("const CACHE='pool-center-shell-v24'","const CACHE='pool-center-shell-v21'").replace(SHARE_CARDS.worker,'')
      .replace("'./weekly-app.js?v=weekly-v21'","'./weekly-app.js?v=weekly-v18'").replace("'./survivor-app.js?v=10'","'./survivor-app.js?v=8'")
      .replace("'./public-math.js?v=3'","'./public-math.js?v=2'");
    assert.equal(digest(Buffer.from(baselineSpelling,'utf8')),V21_WORKER,'apart from the cache name and the two module versions the worker is byte-identical to the baseline worker');
  });
  await hdc15('HDC-15 the page and the worker name each app at one version, the precached one',()=>{
    for(const [path,version] of [['weekly-app.js','weekly-v24'],['survivor-app.js','12']]){
      const escaped=path.replace(/[.]/g,'\\.');
      for(const [label,text] of [['index.html',index],['service-worker.js',source]]){
        const named=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert.deepEqual([...named],[version],`${label} names ${path} at ${[...named].join(', ')}; only v=${version} is precached`);
      }
    }
  });
}

// ---- Shareable cards version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v23 (main 834328b, the production baseline). The feature changes the bytes of index.html, weekly-app.js
// and survivor-app.js only, so exactly the two modules roll their version; it adds exactly share-card.js, share-ui.js and
// share.css, each at v=1; every other asset keeps its bytes and version, and the shell cache rolls to v24. Mixed versions
// stay safe: a page cached before the deploy never loads share-ui.js, the new app modules only answer a share request that
// nothing else sends, and share-ui.js makes no card when the module behind a view does not answer.
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const digest=b=>createHash('sha256').update(b).digest('hex'),sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?digest(b):null)};
  const V23={
    'index.html':[null,'cc1cf1231a501693dc4edbf24c2877530c721143072f863ef2f81a19b655b784'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v20','b20312d0f392c8df6321da19adb069b38149f0e4c4d29bcd910af8539dc57d0c'],
    'public-math.js':['3','9603a2703316bde8f223ff9e58389110b8851f6f95b588cd87254fab0c12c694'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['9','2e03383ae2b4e03ccb2c6f4ec13aadf6bbf3f0f8fc74452b6c5d313ff09dcfc1'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['2','5422cd96a48333f4eceaaf0d6b300b30f0a09d24b34de42a619e20e8fc401a77'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const V23_WORKER='99ce7a6b6938dca8172f9ad5139119a8c15f5a2c45dd172351188e623db76b06';
  // The shell as share cards left it: without the Home dashboard's two assets, at the versions before it.
  const cacheName=sourceBefore.match(/const CACHE='([^']+)'/)?.[1];
  const entries=shellBeforeSeasonRecord(precached).map(withoutPicksSlates).map(withoutPicksAccordion).map(withoutPicksPolish).map(withoutPicksCompact).filter(url=>![...HOME_DASHBOARD.assets,...PICKS_MOBILE.assets].some(asset=>url.endsWith(`/${asset}?v=1`))).map(url=>withoutHomeDashboard(withoutPicksMobile(url)))
    .map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await sc1('share cards change exactly index.html, weekly-app.js and survivor-app.js and add exactly the three share assets (against pool-center-shell-v23)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V23[path];
      if(!before){if(!SHARE_CARDS.assets.has(path))problems.push(`${path} is new to the shell but is not a share-card asset`);else if(version!=='1')problems.push(`${path} is new and must be precached at v=1, not v=${version}`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
    }
    for(const path of SHARE_CARDS.assets)if(!entries.some(e=>e.path===path))problems.push(`${path} must be precached`);
    for(const path of ['index.html','weekly-app.js','survivor-app.js'])if(sha(path)===V23[path][1])problems.push(`${path} must change for share cards`);
    for(const path of ['style.css','slate.css','weekly.css','public-math.js','survivor.css','survivor-math.js','contest-rulings.js','score-feed-proxy.js','pwa.js','manifest.webmanifest','assets/pool-center-icon.svg','assets/pool-center-icon-192.svg','assets/pool-center-icon-512.svg'])
      if(sha(path)!==V23[path][1])problems.push(`${path} is outside share cards and must keep its bytes`);
    assert.deepEqual(problems,[]);
  });
  await sc1('share cards roll the shell cache from pool-center-shell-v23 to v24',()=>assert.equal(cacheName,'pool-center-shell-v24'));
  await sc1('share cards: the page differs from the baseline page only in the two module versions and the share additions',()=>{
    const page=indexBefore;
    for(const addition of SHARE_CARDS.page)assert.equal(page.split(addition).length-1,1,`the page carries ${addition.slice(0,60)}… exactly once`);
    const baselineSpelling=withoutShareCards(page).replace('weekly-app.js?v=weekly-v21','weekly-app.js?v=weekly-v20').replace('survivor-app.js?v=10"','survivor-app.js?v=9"');
    assert.equal(digest(Buffer.from(baselineSpelling,'utf8')),V23['index.html'][1],'apart from the two module versions and the share additions the page is byte-identical to the baseline page');
  });
  await sc1('share cards: the worker differs from the baseline worker only in its cache name, the two module versions and the three share entries (strategy unchanged)',()=>{
    const baselineSpelling=sourceBefore.replace("const CACHE='pool-center-shell-v24'","const CACHE='pool-center-shell-v23'").replace(SHARE_CARDS.worker,'')
      .replace("'./weekly-app.js?v=weekly-v21'","'./weekly-app.js?v=weekly-v20'").replace("'./survivor-app.js?v=10'","'./survivor-app.js?v=9'");
    assert.equal(digest(Buffer.from(baselineSpelling,'utf8')),V23_WORKER,'apart from those entries the worker is byte-identical to the baseline worker');
  });
  await sc1('share cards: superseded app versions are neither precached nor loaded',()=>{
    for(const asset of ['weekly-app.js?v=weekly-v20','survivor-app.js?v=9\'']){assert(!source.includes(`'./${asset}`),`the worker must no longer precache ${asset}`)}
    assert(!index.includes('weekly-app.js?v=weekly-v20')&&!index.includes('survivor-app.js?v=9"'),'the page must no longer load weekly-v20 or survivor-app v9');
  });
  await sc1('share cards: share-ui.js imports only share-card.js at its precached version; share-card.js and the apps import nothing new',()=>{
    const imports=file=>[...withoutHomeDashboard(withoutPicksMobile(bytes(file).toString('utf8'))).matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m=>m[1]);
    assert.deepEqual(imports('share-ui.js'),['./share-card.js?v=1']);
    assert.deepEqual(imports('share-card.js'),[]);
    assert.deepEqual(imports('weekly-app.js'),['./public-math.js?v=3','./contest-rulings.js?v=2']);
    assert.deepEqual(imports('survivor-app.js'),['./survivor-math.js?v=7','./contest-rulings.js?v=2']);
  });
  await sc1('share cards reach no network and load no remote resource',()=>{
    for(const file of ['share-card.js','share-ui.js','share.css']){
      const text=bytes(file).toString('utf8');
      assert(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/.test(text),`${file} must not make requests`);
      assert(!/https?:\/\//.test(text),`${file} must not name a remote resource`);
    }
    for(const addition of SHARE_CARDS.page)assert(!/(?:src|href)="(?:https?:)?\/\//.test(addition),'the share markup loads nothing remote');
  });
  await sc1('index.html has exactly one hidden Share button in each contest panel',()=>{
    const panelOf=name=>{
      const start=index.indexOf(`<section class="view-panel" data-view-panel="${name}"`),tags=/<section\b[^>]*>|<\/section>/g;
      if(start<0)return'';
      tags.lastIndex=start;let depth=0,m;
      while((m=tags.exec(index))){depth+=m[0][1]==='/'?-1:1;if(!depth)return index.slice(start,m.index)}
      return'';
    };
    for(const [contest,panel] of [['pickem','standings'],['survivor','survivor']]){
      assert.equal(indexBefore.split(`data-share-card="${contest}"`).length-1,1,`index.html has exactly one ${contest} Share button`);
      assert(panelOf(panel).includes(`data-share-card="${contest}"`),`the ${contest} Share button is inside the ${panel} panel`);
      assert(new RegExp(`<button type="button" class="share-btn" data-share-card="${contest}" aria-label="[^"]+" hidden>`).test(index),`the ${contest} Share button starts hidden and has an accessible name`);
    }
  });
}

// ---- Home dashboard version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v24 (main acebd80, the production baseline). The feature changes the bytes of index.html, weekly-app.js,
// survivor-app.js, share-card.js and share-ui.js, so exactly those four modules roll their version; it adds exactly
// home-dashboard.js and home-dashboard.css, each at v=1; every other asset keeps its bytes and version, and the shell cache
// rolls to v25. Mixed versions stay safe: a page cached before the deploy never loads home-dashboard.js, and the new app
// modules depend on nothing in the dashboard markup (they only announce poolcenter:update, which nothing else listens for).
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const digest=b=>createHash('sha256').update(b).digest('hex'),sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?digest(b):null)};
  const V24={
    'index.html':[null,'1ac61a494570fb04ce9fc64b635b2098c7599478ab74da58dfc6e65a512058ec'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v21','7f596078b1d62b4e924a01fad58a17e60c37265bf60b09f44ce9146f648a400c'],
    'public-math.js':['3','9603a2703316bde8f223ff9e58389110b8851f6f95b588cd87254fab0c12c694'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['10','1fe84299841e4e2cc32ee6b8c09ded1d48d7bc4820d189901063a6202ff71aa1'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['2','5422cd96a48333f4eceaaf0d6b300b30f0a09d24b34de42a619e20e8fc401a77'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'share-card.js':['1','66f011f0fd1d78f93f8f99fc7a7d5cbb312870adeea98cc89363897a6ef1074e'],
    'share-ui.js':['1','90e85c14fffe86600d5df1b01c6a80738021799bb5e303e8d53a7ce41e54721d'],
    'share.css':['1','32beaa9657dcae9ac5ff899261ee64f6188011f8e82e3de8de606721964f5dd4'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const V24_WORKER='fbcee402edea2084992259cb9db681f145053a36d6da11ea038a354875d8288a';
  const CHANGED=new Set(['index.html','weekly-app.js','survivor-app.js','share-card.js','share-ui.js']);
  // The shell as the Home dashboard left it: without the mobile UX's two assets, at the versions before it.
  const cacheName=sourceBeforePicks.match(/const CACHE='([^']+)'/)?.[1];
  const entries=shellBeforeSeasonRecord(precached).map(withoutPicksSlates).map(withoutPicksAccordion).map(withoutPicksPolish).map(withoutPicksCompact).filter(url=>![...PICKS_MOBILE.assets].some(asset=>url.endsWith(`/${asset}?v=1`))).map(url=>withoutPicksMobile(url)).map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await hd('the Home dashboard changes exactly the page and the four modules, rolls exactly their versions and adds exactly its two assets at v=1 (against pool-center-shell-v24)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V24[path];
      if(!before){if(!HOME_DASHBOARD.assets.has(path))problems.push(`${path} is new to the shell but is not a Home dashboard asset`);else if(version!=='1')problems.push(`${path} is new and must be precached at v=1, not v=${version}`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
      if(changed&&!CHANGED.has(path))problems.push(`${path} is outside the Home dashboard and must keep its bytes`);
    }
    for(const path of HOME_DASHBOARD.assets)if(!entries.some(e=>e.path===path))problems.push(`${path} must be precached`);
    for(const path of CHANGED)if(sha(path)===V24[path][1])problems.push(`${path} must change for the Home dashboard`);
    for(const [asset,,after] of HOME_DASHBOARD.versions)if(entries.find(e=>e.path===asset)?.version!==after)problems.push(`${asset} must be precached at v=${after}`);
    for(const path of Object.keys(V24))if(!CHANGED.has(path)&&sha(path)!==V24[path][1])problems.push(`${path} is outside the Home dashboard and must keep its bytes`);
    assert.deepEqual(problems,[]);
  });
  await hd('the Home dashboard rolls the shell cache from pool-center-shell-v24 to v25',()=>assert.equal(cacheName,HOME_DASHBOARD.cache[1]));
  await hd('the page differs from the baseline page only in the dashboard link and script, the Home panel and the four module versions',()=>{
    const page=indexBeforePicks;
    for(const addition of HOME_DASHBOARD.page)assert.equal(page.split(addition).length-1,1,`the page carries ${addition.slice(0,60)}… exactly once`);
    assert.equal(digest(Buffer.from(withoutHomeDashboard(page),'utf8')),V24['index.html'][1],'with the dashboard taken out, the page is byte-identical to the baseline page');
    assert.notEqual(digest(Buffer.from(page,'utf8')),V24['index.html'][1]);
  });
  await hd('the worker differs from the baseline worker only in its cache name, the two dashboard entries and the four module versions (strategy unchanged)',()=>{
    assert.equal(digest(Buffer.from(sourceBefore,'utf8')),V24_WORKER,'with the dashboard taken out, the worker is byte-identical to the baseline worker');
  });
  await hd('the page and the worker name each changed or new asset at one version, the precached one; superseded versions are neither precached nor loaded',()=>{
    for(const [path,version] of [['weekly-app.js','weekly-v24'],['survivor-app.js','12'],['share-ui.js','2'],['home-dashboard.js','1'],['home-dashboard.css','1']]){
      const escaped=path.replace(/[.]/g,'\\.');
      for(const [label,text] of [['index.html',index],['service-worker.js',source]]){
        const named=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert.deepEqual([...named],[version],`${label} names ${path} at ${[...named].join(', ')}; only v=${version} is precached`);
      }
    }
    assert.deepEqual([...source.matchAll(/share-card\.js\?v=([^'"&\s]+)/g)].map(m=>m[1]),['2'],'the worker precaches share-card.js at v=2 only');
    for(const asset of ['weekly-app.js?v=weekly-v21','survivor-app.js?v=10\'','share-card.js?v=1\'','share-ui.js?v=1\''])assert(!source.includes(`'./${asset}`),`the worker must no longer precache ${asset}`);
    assert(!index.includes('weekly-app.js?v=weekly-v21')&&!index.includes('survivor-app.js?v=10"')&&!index.includes('share-ui.js?v=1"'),'the page must no longer load the superseded module versions');
  });
  await hd('home-dashboard.js imports only share-card.js at its precached version; share-ui.js imports it at v=2; share-card.js and the apps import nothing new',()=>{
    const imports=file=>[...bytes(file).toString('utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m=>m[1]);
    assert.deepEqual(imports('home-dashboard.js'),['./share-card.js?v=2']);
    assert.deepEqual(imports('share-ui.js'),['./share-card.js?v=2']);
    assert.deepEqual(imports('share-card.js'),[]);
    assert.deepEqual(imports('weekly-app.js'),['./public-math.js?v=3','./contest-rulings.js?v=2']);
    assert.deepEqual(imports('survivor-app.js'),['./survivor-math.js?v=7','./contest-rulings.js?v=2']);
  });
  await hd('the dashboard module and stylesheet reach no network, load no remote resource and start no timer; the apps depend on no dashboard markup',()=>{
    for(const file of ['home-dashboard.js','home-dashboard.css']){
      const text=bytes(file).toString('utf8');
      assert(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/.test(text),`${file} must not make requests`);
      assert(!/https?:\/\//.test(text),`${file} must not name a remote resource`);
      assert(!/setInterval|setTimeout/.test(text),`${file} must start no timer`);
    }
    for(const addition of HOME_DASHBOARD.page)assert(!/(?:src|href)="(?:https?:)?\/\//.test(addition),'the dashboard markup loads nothing remote');
    for(const app of ['weekly-app.js','survivor-app.js'])assert(!/getElementById\(['"`]dash|\$\(['"`]dash|data-dash/.test(bytes(app).toString('utf8')),`${app} must not look for dashboard markup`);
  });
  await hd('index.html: the Home panel holds the six dashboard sections in default order, each with its toggle, summary and body, the elements weekly-app.js renders into, the share menu and the customization dialog',()=>{
    const start=index.indexOf(HOME_DASHBOARD.panel.start),end=index.indexOf(HOME_DASHBOARD.panel.end),panel=index.slice(start,end);
    assert(start>=0&&end>start);
    const sections=[...panel.matchAll(/data-dash-section="([^"]+)"/g)].map(m=>m[1]);
    assert.deepEqual(sections,['overview','standings','survivor','pulse','scenarios','games']);
    for(const id of sections){
      assert.equal(panel.split(`data-dash-toggle="${id}"`).length-1,1,`one toggle for ${id}`);
      assert(new RegExp(`<button type="button" class="dash-toggle" data-dash-toggle="${id}" aria-expanded="(true|false)" aria-controls="dash-${id}-body">`).test(panel),`${id}: the toggle is a button with its expanded state and the body it controls`);
      assert.equal(panel.split(`id="dash-${id}-body"`).length-1,1,`one body for ${id}`);
      assert.equal(panel.split(`data-dash-summary="${id}"`).length-1,1,`one summary for ${id}`);
    }
    for(const id of ['pulse','scenarios','games'])assert(new RegExp(`data-dash-toggle="${id}" aria-expanded="false"`).test(panel)&&new RegExp(`id="dash-${id}-body" hidden`).test(panel),`${id} starts collapsed`);
    for(const id of ['overview','standings','survivor'])assert(new RegExp(`data-dash-toggle="${id}" aria-expanded="true"`).test(panel)&&!new RegExp(`id="dash-${id}-body" hidden`).test(panel),`${id} starts expanded`);
    for(const id of ['leaderKicker','leaderName','leaderRecord','leaderNote','finals','liveCount','left','mnf','homeStandings','pulseWeek','entryCount','gameCount','bestWins','swingLeft','progressText','progressBar','tbNote','scenarioCount','raceList','homeGamePreview','dashSections','dashContests','dashSurvivor','dashPanel','dashPanelList','dashPanelStorage'])
      assert.equal(index.split(`id="${id}"`).length-1,1,`index.html has exactly one #${id}`);
    for(const id of ['leaderName','homeStandings','pulseWeek','scenarioCount','raceList','homeGamePreview','dashContests','dashSurvivor'])assert(panel.includes(`id="${id}"`),`#${id} is inside the Home panel`);
    for(const button of ['data-share-card="dashboard"','data-share-card="pickem"','data-share-card="survivor"','data-share-link="dashboard"'])
      assert(new RegExp(`<button type="button" ${button} hidden>`).test(panel),`the share menu's ${button} button starts hidden`);
    assert(panel.includes('data-share-link-status'),'the share menu has a status line');
    assert(/<button type="button" class="dash-tool" data-dash-customize aria-haspopup="dialog" hidden>/.test(panel),'the Customize button starts hidden (the module shows it)');
    assert(/<dialog class="dash-panel" id="dashPanel" aria-labelledby="dashPanelTitle">/.test(panel),'the customization dialog is a dialog with a label');
    assert.equal(panel.split('data-dash-close').length-1,2,'the dialog can be closed from its header and its Done button');
    assert.equal(panel.split('name="dashDensity"').length-1,2,'two density choices');
    assert(panel.includes('data-dash-reset'),'Restore default layout');
    for(const target of ['standings','survivor','games'])assert(panel.includes(`data-view-target="${target}"`),`a link to the full ${target} view`);
  });
}

// ---- V1.3 mobile UX version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v25 (main 83a7c22, the production baseline). The feature changes the bytes of index.html, weekly-app.js
// and survivor-app.js, so exactly the two app modules roll their version; it adds exactly picks-mobile.js and
// picks-mobile.css, each at v=1; every other asset keeps its bytes and version, and the shell cache rolls to v26. Mixed
// versions stay safe: a page cached before the deploy never loads picks-mobile.js, the new app modules only answer picks and
// rules requests that nothing else sends (and carry a kickoff only they read), and the module shows its loading text when an
// app does not answer.
const pmFailures=[];
const pm=async(name,check)=>{try{await check()}catch(error){pmFailures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const digest=b=>createHash('sha256').update(b).digest('hex'),sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?digest(b):null)};
  const V25={
    'index.html':[null,'82e1b237af2a3c9b83e6d5f707440241a92401ff55551908c4a5a2553865743e'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v22','3cd5ed3a773bc4dd822c96086e703a4e0296d429258c113fddf7c4d86b0df924'],
    'public-math.js':['3','9603a2703316bde8f223ff9e58389110b8851f6f95b588cd87254fab0c12c694'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['11','ef756467c99437da738559c2f7c314c171cab14a69ba0b6615e483046ba6eeb7'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['2','5422cd96a48333f4eceaaf0d6b300b30f0a09d24b34de42a619e20e8fc401a77'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'share-card.js':['2','e5653e8837ed9ab0df03d64d56c5390817913c89ba6e1ea531f1f87f5fb4ae83'],
    'share-ui.js':['2','be272771bf91024b6604f395843e6d9889bc5989d54b67db8e4388728d4fdf12'],
    'share.css':['1','32beaa9657dcae9ac5ff899261ee64f6188011f8e82e3de8de606721964f5dd4'],
    'home-dashboard.js':['1','cab9d67b73b4eb3e97d0f2faf6a6282c26f1cf6a05bb21ca830768ff5669a6f0'],
    'home-dashboard.css':['1','f11331d27e0db68f71d488bcab35b5dcd0353ce780874155d395da2e76c8722c'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const V25_WORKER='f1f1d39ab50e2ec885d46a672e93823075005fd6409bddb7658111e74abde81d';
  const CHANGED=new Set(['index.html','weekly-app.js','survivor-app.js']);
  // The shell as the V1.3 mobile UX left it: the two mobile assets at v=1, the cache at v26.
  const index=indexBeforeCompact,source=sourceBeforeCompact;
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=shellBeforeSeasonRecord(precached).map(withoutPicksSlates).map(withoutPicksAccordion).map(withoutPicksPolish).map(withoutPicksCompact).map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await pm('the mobile UX changes exactly the page and the two app modules, rolls exactly their versions and adds exactly its two assets at v=1 (against pool-center-shell-v25)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V25[path];
      if(!before){if(!PICKS_MOBILE.assets.has(path))problems.push(`${path} is new to the shell but is not a mobile UX asset`);else if(version!=='1')problems.push(`${path} is new and must be precached at v=1, not v=${version}`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
      if(changed&&!CHANGED.has(path))problems.push(`${path} is outside the mobile UX and must keep its bytes`);
    }
    for(const path of PICKS_MOBILE.assets)if(!entries.some(e=>e.path===path))problems.push(`${path} must be precached`);
    for(const path of CHANGED)if(sha(path)===V25[path][1])problems.push(`${path} must change for the mobile UX`);
    for(const [asset,,after] of PICKS_MOBILE.versions)if(entries.find(e=>e.path===asset)?.version!==after)problems.push(`${asset} must be precached at v=${after}`);
    for(const path of Object.keys(V25))if(!CHANGED.has(path)&&sha(path)!==V25[path][1])problems.push(`${path} is outside the mobile UX and must keep its bytes`);
    assert.deepEqual(problems,[]);
  });
  await pm('the mobile UX rolls the shell cache from pool-center-shell-v25 to v26',()=>assert.equal(cacheName,PICKS_MOBILE.cache[1]));
  await pm('the page differs from the baseline page only in the mobile link and script, the two Rules & rulings cards, the Picks containers and the two module versions',()=>{
    const page=index;
    for(const addition of PICKS_MOBILE.page)assert.equal(page.split(addition).length-1,1,`the page carries ${addition.slice(0,60)}… exactly once`);
    assert.equal(digest(Buffer.from(withoutPicksMobile(page),'utf8')),V25['index.html'][1],'with the mobile UX taken out, the page is byte-identical to the baseline page');
    assert.notEqual(digest(Buffer.from(page,'utf8')),V25['index.html'][1]);
  });
  await pm('the worker differs from the baseline worker only in its cache name, the two mobile entries and the two module versions (strategy unchanged)',()=>{
    assert.equal(digest(Buffer.from(withoutPicksMobile(source),'utf8')),V25_WORKER,'with the mobile UX taken out, the worker is byte-identical to the baseline worker');
  });
  await pm('the page and the worker name each changed or new asset at one version, the precached one; superseded versions are neither precached nor loaded',()=>{
    for(const [path,version] of [['weekly-app.js','weekly-v23'],['survivor-app.js','12'],['picks-mobile.js','1'],['picks-mobile.css','1']]){
      const escaped=path.replace(/[.]/g,'\\.');
      for(const [label,text] of [['index.html',index],['service-worker.js',source]]){
        const named=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert.deepEqual([...named],[version],`${label} names ${path} at ${[...named].join(', ')}; only v=${version} is precached`);
      }
    }
    for(const asset of ['weekly-app.js?v=weekly-v22','survivor-app.js?v=11\''])assert(!source.includes(`'./${asset}`),`the worker must no longer precache ${asset}`);
    assert(!index.includes('weekly-app.js?v=weekly-v22')&&!index.includes('survivor-app.js?v=11"'),'the page must no longer load the superseded module versions');
  });
  await pm('picks-mobile.js imports nothing; the apps import nothing new',()=>{
    const imports=file=>[...bytes(file).toString('utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m=>m[1]);
    assert.deepEqual(imports('picks-mobile.js'),[]);
    assert.deepEqual(imports('weekly-app.js'),['./public-math.js?v=3','./contest-rulings.js?v=2']);
    assert.deepEqual(imports('survivor-app.js'),['./survivor-math.js?v=7','./contest-rulings.js?v=2']);
  });
  await pm('the mobile module and stylesheet reach no network, load no remote resource and start no timer; the apps depend on no mobile markup',()=>{
    for(const file of ['picks-mobile.js','picks-mobile.css']){
      const text=bytes(file).toString('utf8');
      assert(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/.test(text),`${file} must not make requests`);
      assert(!/https?:\/\//.test(text),`${file} must not name a remote resource`);
      assert(!/setInterval|setTimeout/.test(text),`${file} must start no timer`);
    }
    for(const addition of PICKS_MOBILE.page)assert(!/(?:src|href)="(?:https?:)?\/\//.test(addition),'the mobile markup loads nothing remote');
    for(const app of ['weekly-app.js','survivor-app.js'])assert(!/getElementById\(['"`](?:picks|pm-)|\$\(['"`]picks|data-picks|data-rules|rules-toggle|picksBoard|picksFilters/.test(bytes(app).toString('utf8')),`${app} must not look for mobile markup`);
  });
  await pm('index.html: each contest panel holds one collapsed Rules & rulings card whose control is a labelled button, with the summary and the alerts outside the hidden body and the app container inside it; the Picks panel holds the hidden card and filter containers beside the table',()=>{
    const panelOf=name=>{
      const start=index.indexOf(`<section class="view-panel" data-view-panel="${name}"`),tags=/<section\b[^>]*>|<\/section>/g;
      if(start<0)return'';
      tags.lastIndex=start;let depth=0,m;
      while((m=tags.exec(index))){depth+=m[0][1]==='/'?-1:1;if(!depth)return index.slice(start,m.index)}
      return'';
    };
    for(const [contest,panel,container] of [['pickem','games','pickemRules'],['survivor','survivor','svRules']]){
      const text=panelOf(panel);
      assert.equal(text.split(`data-rules-card="${contest}"`).length-1,1,`one ${contest} rules card`);
      assert(new RegExp(`<button type="button" class="rules-toggle" data-rules-toggle="${contest}" aria-expanded="false" aria-controls="${contest}-rules-body" aria-label="Expand Rules &amp; rulings">`).test(text),`${contest}: the toggle is a button, collapsed, naming the body it controls and what it does`);
      assert.equal(text.split(`data-rules-toggle="${contest}"`).length-1,1,`${contest}: one toggle`);
      assert.equal(text.split(`id="${contest}-rules-body" hidden`).length-1,1,`${contest}: the body starts hidden`);
      const body=text.indexOf(`id="${contest}-rules-body"`),summary=text.indexOf(`data-rules-summary="${contest}"`),alerts=text.indexOf(`data-rules-alerts="${contest}"`),inner=text.indexOf(`id="${container}"`);
      assert(summary>=0&&alerts>=0&&body>=0&&inner>=0,`${contest}: summary, alerts, body and container are all present`);
      assert(summary<body&&alerts<body,`${contest}: the summary and the alerts are outside the hidden body`);
      assert(inner>body,`${contest}: #${container} is inside the hidden body`);
      assert(text.includes(`data-rules-alerts="${contest}" role="status" aria-live="polite"`),`${contest}: the alerts are a live status region`);
      assert(text.includes('class="card rules-card rules-collapsible is-collapsed"'),`${contest}: the card starts collapsed`);
      assert(text.includes(`<h2 id="${contest==='pickem'?'pickem':'survivor'}-rules-title">Rules &amp; rulings</h2>`),`${contest}: the heading is kept`);
    }
    const picks=panelOf('picks');
    assert.equal(picks.split('id="picksFilters" hidden').length-1,1,'the filter container starts hidden');
    assert.equal(picks.split('id="picksBoard" hidden').length-1,1,'the card container starts hidden');
    assert(picks.indexOf('id="picksBoard"')<picks.indexOf('id="pickHead"'),'the cards come before the table');
    assert(picks.includes('<div class="scroll"><table><thead id="pickHead"></thead><tbody id="pickBody"></tbody></table></div>'),'the comparison table is unchanged');
    for(const id of ['pickHead','pickBody','picksFilters','picksBoard','pickemRules','svRules','pickem-rules-body','survivor-rules-body'])assert.equal(index.split(`id="${id}"`).length-1,1,`index.html has exactly one #${id}`);
  });
}

// ---- V1.4 premium compact Picks UX version discipline. Each precached asset is checked against the bytes and version it had
// in pool-center-shell-v26 (main 78fa54a, the production baseline). The feature changes the bytes of index.html (the Picks
// panel's copy per layout and its entry selection panel), picks-mobile.js and picks-mobile.css, so exactly the two mobile
// assets roll their version (to v=2); it adds no shell asset and touches no app module; every other asset keeps its bytes and
// version, and the shell cache rolls to v27. Mixed versions stay safe: the page names the module and the stylesheet at one
// version, a page cached before the deploy loads v=1 of both with the markup v=1 needs, and the apps answer the same picks
// and rules requests as before.
const pcFailures=[];
const pc=async(name,check)=>{try{await check()}catch(error){pcFailures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const digest=b=>createHash('sha256').update(b).digest('hex'),sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?digest(b):null)};
  const V26={
    'index.html':[null,'8fbf4df1e0db1d2e1fcb19b14198fdba62e9b39d4bad91c6853dbedfe9c62528'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v23','7efcceefa199c211581262b977a70c86d5a7b6a586f714fb72dd79015c3eb782'],
    'public-math.js':['3','9603a2703316bde8f223ff9e58389110b8851f6f95b588cd87254fab0c12c694'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['12','be0a2f03ecf92fc419b0d5ec77f63ef372d5e7598d74d5f666dc06a379f38d06'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['2','5422cd96a48333f4eceaaf0d6b300b30f0a09d24b34de42a619e20e8fc401a77'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'share-card.js':['2','e5653e8837ed9ab0df03d64d56c5390817913c89ba6e1ea531f1f87f5fb4ae83'],
    'share-ui.js':['2','be272771bf91024b6604f395843e6d9889bc5989d54b67db8e4388728d4fdf12'],
    'share.css':['1','32beaa9657dcae9ac5ff899261ee64f6188011f8e82e3de8de606721964f5dd4'],
    'home-dashboard.js':['1','cab9d67b73b4eb3e97d0f2faf6a6282c26f1cf6a05bb21ca830768ff5669a6f0'],
    'home-dashboard.css':['1','f11331d27e0db68f71d488bcab35b5dcd0353ce780874155d395da2e76c8722c'],
    'picks-mobile.js':['1','72cd5f87a95b9deb3021238f664c7e3a3e72fa380ab019b7c8aa27b750061bf6'],
    'picks-mobile.css':['1','50f8b4b4bc728a72943e3934af33714f191ecd0ffb93762f9ecd0a5b7a722f3f'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const V26_WORKER='e3db5e4572909b3cf1ef2b3605eaaaec7f785a41380aa5fe9ddf6b253e4975e0';
  const CHANGED=new Set(['index.html','picks-mobile.js','picks-mobile.css']);
  // The shell as the compact UX left it: the two mobile assets at v=2, the cache at v27.
  const index=indexBeforePolish,source=sourceBeforePolish;
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=shellBeforeSeasonRecord(precached).map(withoutPicksSlates).map(withoutPicksAccordion).map(withoutPicksPolish).map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await pc('the compact UX changes exactly the page, the mobile module and the mobile stylesheet, rolls exactly the two mobile versions to v=2 and adds no shell asset (against pool-center-shell-v26)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V26[path];
      if(!before){problems.push(`${path} is new to the shell: the compact UX adds no shell asset`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
      if(changed&&!CHANGED.has(path))problems.push(`${path} is outside the compact UX and must keep its bytes`);
    }
    for(const path of Object.keys(V26))if(!entries.some(e=>e.path===path))problems.push(`${path} must stay precached`);
    for(const path of CHANGED)if(sha(path)===V26[path][1])problems.push(`${path} must change for the compact UX`);
    for(const [asset,,after] of PICKS_COMPACT.versions)if(entries.find(e=>e.path===asset)?.version!==after)problems.push(`${asset} must be precached at v=${after}`);
    for(const path of Object.keys(V26))if(!CHANGED.has(path)&&sha(path)!==V26[path][1])problems.push(`${path} is outside the compact UX and must keep its bytes`);
    assert.deepEqual(problems,[]);
  });
  await pc('the compact UX rolls the shell cache from pool-center-shell-v26 to v27',()=>assert.equal(cacheName,PICKS_COMPACT.cache[1]));
  await pc('the page differs from the baseline page only in the Picks panel’s copy per layout, its entry selection panel and the two mobile versions',()=>{
    for(const {start} of PICKS_COMPACT.regions)assert.equal(index.split(start).length-1,1,`the page carries ${start.trim().slice(0,60)}… exactly once`);
    assert.equal(digest(Buffer.from(withoutPicksCompact(index),'utf8')),V26['index.html'][1],'with the compact UX taken out, the page is byte-identical to the baseline page');
    assert.notEqual(digest(Buffer.from(index,'utf8')),V26['index.html'][1]);
  });
  await pc('the worker differs from the baseline worker only in its cache name and the two mobile versions (strategy unchanged)',()=>{
    assert.equal(digest(Buffer.from(withoutPicksCompact(source),'utf8')),V26_WORKER,'with the compact UX taken out, the worker is byte-identical to the baseline worker');
  });
  await pc('the page and the worker name the module and the stylesheet at one version, v=2, the precached one; v=1 is neither precached nor loaded',()=>{
    for(const [path,version] of [['picks-mobile.js','2'],['picks-mobile.css','2']]){
      const escaped=path.replace(/[.]/g,'\\.');
      for(const [label,text] of [['index.html',index],['service-worker.js',source]]){
        const named=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert.deepEqual([...named],[version],`${label} names ${path} at ${[...named].join(', ')}; only v=${version} is precached`);
      }
    }
    for(const asset of ['picks-mobile.js?v=1','picks-mobile.css?v=1'])assert(!source.includes(`'./${asset}'`),`the worker must no longer precache ${asset}`);
    assert(!index.includes('picks-mobile.js?v=1"')&&!index.includes('picks-mobile.css?v=1"'),'the page must no longer load the superseded mobile versions');
  });
  await pc('picks-mobile.js still imports nothing, reaches no network, loads no remote resource and starts no timer; the apps keep their baseline bytes and look for no mobile markup',()=>{
    assert.deepEqual([...bytes('picks-mobile.js').toString('utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m=>m[1]),[]);
    for(const file of ['picks-mobile.js','picks-mobile.css']){
      const text=bytes(file).toString('utf8');
      assert(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/.test(text),`${file} must not make requests`);
      assert(!/https?:\/\//.test(text),`${file} must not name a remote resource`);
      assert(!/setInterval|setTimeout/.test(text),`${file} must start no timer`);
    }
    for(const app of ['weekly-app.js','survivor-app.js']){
      assert.equal(sha(app),V26[app][1],`${app} keeps its bytes`);
      assert(!/getElementById\(['"`](?:picks|pm-)|\$\(['"`]picks|data-picks|data-rules|rules-toggle|picksBoard|picksFilters|picksEntrants/.test(bytes(app).toString('utf8')),`${app} must not look for mobile markup`);
    }
  });
  await pc('index.html: the Picks panel keeps the hidden card and filter containers before the unchanged table, carries the table copy and the card copy, and holds one entry selection dialog after the table with a labelled title, two close controls, Select all and a live status that loads nothing remote',()=>{
    const panelOf=name=>{
      const start=index.indexOf(`<section class="view-panel" data-view-panel="${name}"`),tags=/<section\b[^>]*>|<\/section>/g;
      if(start<0)return'';
      tags.lastIndex=start;let depth=0,m;
      while((m=tags.exec(index))){depth+=m[0][1]==='/'?-1:1;if(!depth)return index.slice(start,m.index)}
      return'';
    };
    const picks=panelOf('picks');
    assert.equal(picks.split('id="picksFilters" hidden').length-1,1,'the filter container starts hidden');
    assert.equal(picks.split('id="picksBoard" hidden').length-1,1,'the card container starts hidden');
    assert(picks.indexOf('id="picksBoard"')<picks.indexOf('id="pickHead"'),'the cards come before the table');
    assert(picks.includes('<div class="scroll"><table><thead id="pickHead"></thead><tbody id="pickBody"></tbody></table></div>'),'the comparison table is unchanged');
    assert.match(picks,/<p><span class="pm-copy-table">Side-by-side picks for D\.C\., JC, DJS and Thaddeus\. Matchup headers show full-field ownership when available\.<\/span><span class="pm-copy-cards">[^<]+<\/span><\/p>/,'the table copy is kept and the card copy is beside it');
    assert.equal(picks.split('<dialog class="pm-dialog" id="picksEntrants" aria-labelledby="picksEntrantsTitle">').length-1,1,'one entry selection dialog');
    assert(picks.indexOf('<dialog')>picks.indexOf('id="pickBody"'),'the dialog follows the table');
    assert(picks.includes('<h2 id="picksEntrantsTitle">Entries to compare</h2>'));
    assert.equal(picks.split('data-picks-close').length-1,2,'a close control in the head and Done');
    assert(picks.includes('<div class="pm-sheet-list" data-picks-entrants></div>'));
    assert(picks.includes('<button type="button" class="share-action" data-picks-entrant="*">Select all</button>'));
    assert(picks.includes('<p class="pm-sheet-status" data-picks-dialog-note role="status" aria-live="polite"></p>'));
    assert(!/(?:src|href)="(?:https?:)?\/\//.test(picks.slice(picks.indexOf('<dialog'),picks.indexOf('</dialog>'))),'the dialog loads nothing remote');
    for(const id of ['pickHead','pickBody','picksFilters','picksBoard','picksEntrants','picksEntrantsTitle'])assert.equal(index.split(`id="${id}"`).length-1,1,`index.html has exactly one #${id}`);
  });
}

// ---- V1.4 final premium polish version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v27 (the compact UX candidate b52afd6, PR #15). The polish changes the bytes of index.html (the entry
// selection panel's card name labels setting), picks-mobile.js and picks-mobile.css, so exactly the two mobile assets roll
// their version (to v=3); it adds no shell asset and touches no app module; every other asset keeps its bytes and version,
// and the shell cache rolls to v28. Mixed versions stay safe: the page names the module and the stylesheet at one version, a
// page cached before the deploy loads v=2 of both with the markup v=2 needs (only v=3 reads the setting), and the apps answer
// the same picks and rules requests as before.
const ppFailures=[];
const pp=async(name,check)=>{try{await check()}catch(error){ppFailures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const digest=b=>createHash('sha256').update(b).digest('hex'),sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?digest(b):null)};
  const V27={
    'index.html':[null,'bf260f31e185bdffe8e202a7aff691910467add32f33702c5a779a782a6bb600'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v23','7efcceefa199c211581262b977a70c86d5a7b6a586f714fb72dd79015c3eb782'],
    'public-math.js':['3','9603a2703316bde8f223ff9e58389110b8851f6f95b588cd87254fab0c12c694'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['12','be0a2f03ecf92fc419b0d5ec77f63ef372d5e7598d74d5f666dc06a379f38d06'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['2','5422cd96a48333f4eceaaf0d6b300b30f0a09d24b34de42a619e20e8fc401a77'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'share-card.js':['2','e5653e8837ed9ab0df03d64d56c5390817913c89ba6e1ea531f1f87f5fb4ae83'],
    'share-ui.js':['2','be272771bf91024b6604f395843e6d9889bc5989d54b67db8e4388728d4fdf12'],
    'share.css':['1','32beaa9657dcae9ac5ff899261ee64f6188011f8e82e3de8de606721964f5dd4'],
    'home-dashboard.js':['1','cab9d67b73b4eb3e97d0f2faf6a6282c26f1cf6a05bb21ca830768ff5669a6f0'],
    'home-dashboard.css':['1','f11331d27e0db68f71d488bcab35b5dcd0353ce780874155d395da2e76c8722c'],
    'picks-mobile.js':['2','071687886cb9bfd21f899c96432581dde0c3125831eb13f8a073b008f565d370'],
    'picks-mobile.css':['2','a9be121b117121ff05ea450995568b89f6992e51ada8f26e4b2c2dbaf377b322'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const V27_WORKER='283cd4ed86229ae9b6d106fc1e4f3d3d34688792d2fd590244bd4defc2458f1f';
  const CHANGED=new Set(['index.html','picks-mobile.js','picks-mobile.css']);
  // The shell as the polish left it: the two mobile assets at v=3, the cache at v28.
  const index=indexBeforeAccordion,source=sourceBeforeAccordion;
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=shellBeforeSeasonRecord(precached).map(withoutPicksSlates).map(withoutPicksAccordion).map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await pp('the polish changes exactly the page, the mobile module and the mobile stylesheet, rolls exactly the two mobile versions to v=3 and adds no shell asset (against pool-center-shell-v27)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V27[path];
      if(!before){problems.push(`${path} is new to the shell: the polish adds no shell asset`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
      if(changed&&!CHANGED.has(path))problems.push(`${path} is outside the polish and must keep its bytes`);
    }
    for(const path of Object.keys(V27))if(!entries.some(e=>e.path===path))problems.push(`${path} must stay precached`);
    for(const path of CHANGED)if(sha(path)===V27[path][1])problems.push(`${path} must change for the polish`);
    for(const [asset,,after] of PICKS_POLISH.versions)if(entries.find(e=>e.path===asset)?.version!==after)problems.push(`${asset} must be precached at v=${after}`);
    for(const path of Object.keys(V27))if(!CHANGED.has(path)&&sha(path)!==V27[path][1])problems.push(`${path} is outside the polish and must keep its bytes`);
    assert.deepEqual(problems,[]);
  });
  await pp('the polish rolls the shell cache from pool-center-shell-v27 to v28',()=>assert.equal(cacheName,PICKS_POLISH.cache[1]));
  await pp('the page differs from the compact UX page only in the panel’s card name labels setting and the two mobile versions',()=>{
    for(const {start} of PICKS_POLISH.regions)assert.equal(index.split(start).length-1,1,`the page carries ${start.trim().slice(0,60)}… exactly once`);
    assert.equal(digest(Buffer.from(withoutPicksPolish(index),'utf8')),V27['index.html'][1],'with the polish taken out, the page is byte-identical to the compact UX page');
    assert.notEqual(digest(Buffer.from(index,'utf8')),V27['index.html'][1]);
  });
  await pp('the worker differs from the compact UX worker only in its cache name and the two mobile versions (strategy unchanged)',()=>{
    assert.equal(digest(Buffer.from(withoutPicksPolish(source),'utf8')),V27_WORKER,'with the polish taken out, the worker is byte-identical to the compact UX worker');
  });
  await pp('the page and the worker name the module and the stylesheet at one version, v=3, the precached one; v=2 is neither precached nor loaded',()=>{
    for(const [path,version] of [['picks-mobile.js','3'],['picks-mobile.css','3']]){
      const escaped=path.replace(/[.]/g,'\\.');
      for(const [label,text] of [['index.html',index],['service-worker.js',source]]){
        const named=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert.deepEqual([...named],[version],`${label} names ${path} at ${[...named].join(', ')}; only v=${version} is precached`);
      }
    }
    for(const asset of ['picks-mobile.js?v=2','picks-mobile.css?v=2'])assert(!source.includes(`'./${asset}'`),`the worker must no longer precache ${asset}`);
    assert(!index.includes('picks-mobile.js?v=2"')&&!index.includes('picks-mobile.css?v=2"'),'the page must no longer load the superseded mobile versions');
  });
  await pp('picks-mobile.js still imports nothing, reaches no network, loads no remote resource and starts no timer; the apps keep their baseline bytes and look for no mobile markup',()=>{
    assert.deepEqual([...bytes('picks-mobile.js').toString('utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m=>m[1]),[]);
    for(const file of ['picks-mobile.js','picks-mobile.css']){
      const text=bytes(file).toString('utf8');
      assert(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/.test(text),`${file} must not make requests`);
      assert(!/https?:\/\//.test(text),`${file} must not name a remote resource`);
      assert(!/setInterval|setTimeout/.test(text),`${file} must start no timer`);
    }
    for(const app of ['weekly-app.js','survivor-app.js']){
      assert.equal(sha(app),V27[app][1],`${app} keeps its bytes`);
      assert(!/getElementById\(['"`](?:picks|pm-)|\$\(['"`]picks|data-picks|data-rules|rules-toggle|picksBoard|picksFilters|picksEntrants|picksLabels/.test(bytes(app).toString('utf8')),`${app} must not look for mobile markup`);
    }
  });
  await pp('index.html: the entry selection dialog holds the card name labels setting after the list and before the status line, a labelled group with the Compact and Full labels buttons and nothing remote; the rest of the panel is as the compact UX left it',()=>{
    const open=index.indexOf('<dialog class="pm-dialog" id="picksEntrants"'),dialog=index.slice(open,index.indexOf('</dialog>',open));
    assert.equal(dialog.split('<div class="pm-sheet-setting" role="group" aria-labelledby="picksLabelsTitle">').length-1,1,'one setting group');
    assert(dialog.includes('<span class="pm-sheet-setting-title" id="picksLabelsTitle">Card name labels</span>'),'the group is named');
    assert(dialog.includes('<button type="button" class="pm-segment" data-picks-labels="compact" aria-pressed="false">Compact</button><button type="button" class="pm-segment" data-picks-labels="full" aria-pressed="false">Full labels</button>'),'two pressed-state buttons');
    assert.equal(dialog.split('data-picks-labels=').length-1,2,'exactly two label modes');
    const list=dialog.indexOf('data-picks-entrants'),setting=dialog.indexOf('pm-sheet-setting'),status=dialog.indexOf('data-picks-dialog-note'),actions=dialog.indexOf('pm-sheet-actions');
    assert(list>=0&&list<setting&&setting<status&&status<actions,'the list, then the setting, then the status, then the actions');
    assert(!/(?:src|href)="(?:https?:)?\/\//.test(dialog),'the dialog loads nothing remote');
    assert.equal(dialog.split('data-picks-close').length-1,2,'a close control in the head and Done');
    assert(dialog.includes('<div class="pm-sheet-list" data-picks-entrants></div>')&&dialog.includes('<button type="button" class="share-action" data-picks-entrant="*">Select all</button>'));
    for(const id of ['picksEntrants','picksEntrantsTitle','picksLabelsTitle'])assert.equal(index.split(`id="${id}"`).length-1,1,`index.html has exactly one #${id}`);
  });
}

// ---- V1.4 collapsible slate groups version discipline. Each precached asset is checked against the bytes and version it
// had in pool-center-shell-v28 (main 8ed545c, the production baseline). The feature changes the bytes of picks-mobile.js and
// picks-mobile.css, so exactly the two mobile assets roll their version (to v=4); it changes the page only by those two
// versions (the slates are rendered by the module into the containers the page already has), adds no shell asset and touches
// no app module; every other asset keeps its bytes and version, and the shell cache rolls to v29. Mixed versions stay safe:
// the page names the module and the stylesheet at one version, a page cached before the deploy loads v=3 of both with the
// markup it has, and the apps answer the same picks and rules requests as before.
const paFailures=[];
const pa=async(name,check)=>{try{await check()}catch(error){paFailures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const digest=b=>createHash('sha256').update(b).digest('hex'),sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?digest(b):null)};
  const V28={
    'index.html':[null,'801009d08fef64668582990035e428bec5899a228f9f102b8954f826d5641948'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v23','7efcceefa199c211581262b977a70c86d5a7b6a586f714fb72dd79015c3eb782'],
    'public-math.js':['3','9603a2703316bde8f223ff9e58389110b8851f6f95b588cd87254fab0c12c694'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['12','be0a2f03ecf92fc419b0d5ec77f63ef372d5e7598d74d5f666dc06a379f38d06'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['2','5422cd96a48333f4eceaaf0d6b300b30f0a09d24b34de42a619e20e8fc401a77'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'share-card.js':['2','e5653e8837ed9ab0df03d64d56c5390817913c89ba6e1ea531f1f87f5fb4ae83'],
    'share-ui.js':['2','be272771bf91024b6604f395843e6d9889bc5989d54b67db8e4388728d4fdf12'],
    'share.css':['1','32beaa9657dcae9ac5ff899261ee64f6188011f8e82e3de8de606721964f5dd4'],
    'home-dashboard.js':['1','cab9d67b73b4eb3e97d0f2faf6a6282c26f1cf6a05bb21ca830768ff5669a6f0'],
    'home-dashboard.css':['1','f11331d27e0db68f71d488bcab35b5dcd0353ce780874155d395da2e76c8722c'],
    'picks-mobile.js':['3','8450f8679947a90aed891f1f617c8ecd3f52fb35d2a2a5ceea5ae97a9939b7a9'],
    'picks-mobile.css':['3','3b0a028f1b28cc2c57408cce025a0422d79479cd18b5368299ff6cb9a2da0d92'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const V28_WORKER='070d27ebddd5bbb248efdeba5c2524463f4b38db4a51d9f3da4074eeb0e794bd';
  const CHANGED=new Set(['index.html','picks-mobile.js','picks-mobile.css']);
  // The shell as the slate groups left it: the two mobile assets at v=4, the cache at v29.
  const index=indexBeforeSlates,source=sourceBeforeSlates;
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=shellBeforeSeasonRecord(precached).map(withoutPicksSlates).map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await pa('the slate groups change exactly the page, the mobile module and the mobile stylesheet, roll exactly the two mobile versions to v=4 and add no shell asset (against pool-center-shell-v28)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V28[path];
      if(!before){problems.push(`${path} is new to the shell: the slate groups add no shell asset`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
      if(changed&&!CHANGED.has(path))problems.push(`${path} is outside the slate groups and must keep its bytes`);
    }
    for(const path of Object.keys(V28))if(!entries.some(e=>e.path===path))problems.push(`${path} must stay precached`);
    for(const path of CHANGED)if(sha(path)===V28[path][1])problems.push(`${path} must change for the slate groups`);
    for(const [asset,,after] of PICKS_ACCORDION.versions)if(entries.find(e=>e.path===asset)?.version!==after)problems.push(`${asset} must be precached at v=${after}`);
    for(const path of Object.keys(V28))if(!CHANGED.has(path)&&sha(path)!==V28[path][1])problems.push(`${path} is outside the slate groups and must keep its bytes`);
    assert.deepEqual(problems,[]);
  });
  await pa('the slate groups roll the shell cache from pool-center-shell-v28 to v29',()=>assert.equal(cacheName,PICKS_ACCORDION.cache[1]));
  await pa('the page differs from the polish page only in the two mobile versions: no markup the slate groups depend on',()=>{
    assert.equal(digest(Buffer.from(withoutPicksAccordion(index),'utf8')),V28['index.html'][1],'with the slate groups taken out, the page is byte-identical to the polish page');
    assert.notEqual(digest(Buffer.from(index,'utf8')),V28['index.html'][1]);
    assert(!/data-picks-slate|pm-slate/.test(index),'the slates are rendered by the module into the containers the page already has');
  });
  await pa('the worker differs from the polish worker only in its cache name and the two mobile versions (strategy unchanged)',()=>{
    assert.equal(digest(Buffer.from(withoutPicksAccordion(source),'utf8')),V28_WORKER,'with the slate groups taken out, the worker is byte-identical to the polish worker');
  });
  await pa('the page and the worker name the module and the stylesheet at one version, v=4, the precached one; v=3 is neither precached nor loaded',()=>{
    for(const [path,version] of [['picks-mobile.js','4'],['picks-mobile.css','4']]){
      const escaped=path.replace(/[.]/g,'\\.');
      for(const [label,text] of [['index.html',index],['service-worker.js',source]]){
        const named=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert.deepEqual([...named],[version],`${label} names ${path} at ${[...named].join(', ')}; only v=${version} is precached`);
      }
    }
    for(const asset of ['picks-mobile.js?v=3','picks-mobile.css?v=3'])assert(!source.includes(`'./${asset}'`),`the worker must no longer precache ${asset}`);
    assert(!index.includes('picks-mobile.js?v=3"')&&!index.includes('picks-mobile.css?v=3"'),'the page must no longer load the superseded mobile versions');
  });
  await pa('picks-mobile.js still imports nothing, reaches no network, loads no remote resource and starts no timer; the apps keep their baseline bytes and look for no mobile markup',()=>{
    assert.deepEqual([...bytes('picks-mobile.js').toString('utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m=>m[1]),[]);
    for(const file of ['picks-mobile.js','picks-mobile.css']){
      const text=bytes(file).toString('utf8');
      assert(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/.test(text),`${file} must not make requests`);
      assert(!/https?:\/\//.test(text),`${file} must not name a remote resource`);
      assert(!/setInterval|setTimeout/.test(text),`${file} must start no timer`);
    }
    for(const app of ['weekly-app.js','survivor-app.js']){
      assert.equal(sha(app),V28[app][1],`${app} keeps its bytes`);
      assert(!/getElementById\(['"`](?:picks|pm-)|\$\(['"`]picks|data-picks|data-rules|rules-toggle|picksBoard|picksFilters|picksEntrants|picksLabels|pm-slate/.test(bytes(app).toString('utf8')),`${app} must not look for mobile markup`);
    }
  });
  await pa('picks-mobile.js renders each kickoff slate as a disclosure (a heading whose one control is a button with aria-expanded and aria-controls) with the Expand all and Collapse all controls, and the stylesheet gives the controls 44px and 42px targets and visible focus',()=>{
    const module=bytes('picks-mobile.js').toString('utf8'),css=bytes('picks-mobile.css').toString('utf8');
    assert(module.includes('<h3 class="pm-group-title"><button type="button" class="pm-slate-toggle" data-picks-slate-toggle="'),'the heading holds the control');
    assert(module.includes('aria-expanded="${on}" aria-controls="${esc(id)}"')&&module.includes('<div class="pm-slate-body" id="${esc(id)}"'),'the control names its state and the body it controls');
    assert(module.includes('data-picks-slates="expand">Expand all</button>')&&module.includes('data-picks-slates="collapse">Collapse all</button>'),'Expand all and Collapse all');
    assert.match(css,/\.pm-slate-toggle\{[^}]*min-height:44px/);assert.match(css,/\.pm-slates-action\{[^}]*min-height:42px/);
    assert(css.includes('.pm-slate-toggle:focus-visible')&&css.includes('.pm-slates-action:focus-visible'),'visible focus');
  });
}

// ---- V1.4 multi-select slates version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v29 (main 4cd23e0, the production baseline). The feature changes the bytes of index.html (the slate
// selection panel), picks-mobile.js and picks-mobile.css, so exactly the two mobile assets roll their version (to v=5); it adds
// no shell asset and touches no app module; every other asset keeps its bytes and version, and the shell cache rolls to v30.
// Mixed versions stay safe: the page names the module and the stylesheet at one version, a page cached before the deploy loads
// v=4 of both with the markup v=4 needs (only v=5 reads the slate panel), and the apps answer the same picks and rules requests
// as before.
const psFailures=[];
const ps=async(name,check)=>{try{await check()}catch(error){psFailures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const digest=b=>createHash('sha256').update(b).digest('hex'),sha=path=>{const b=bytes(path);return SEASON_RECORD.before[path]??(b?digest(b):null)};
  const V29={
    'index.html':[null,'6f407c4585cf994456c257ec411b39ba839b0f77bf73e981c13a295587032322'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v23','7efcceefa199c211581262b977a70c86d5a7b6a586f714fb72dd79015c3eb782'],
    'public-math.js':['3','9603a2703316bde8f223ff9e58389110b8851f6f95b588cd87254fab0c12c694'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['12','be0a2f03ecf92fc419b0d5ec77f63ef372d5e7598d74d5f666dc06a379f38d06'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['2','5422cd96a48333f4eceaaf0d6b300b30f0a09d24b34de42a619e20e8fc401a77'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'share-card.js':['2','e5653e8837ed9ab0df03d64d56c5390817913c89ba6e1ea531f1f87f5fb4ae83'],
    'share-ui.js':['2','be272771bf91024b6604f395843e6d9889bc5989d54b67db8e4388728d4fdf12'],
    'share.css':['1','32beaa9657dcae9ac5ff899261ee64f6188011f8e82e3de8de606721964f5dd4'],
    'home-dashboard.js':['1','cab9d67b73b4eb3e97d0f2faf6a6282c26f1cf6a05bb21ca830768ff5669a6f0'],
    'home-dashboard.css':['1','f11331d27e0db68f71d488bcab35b5dcd0353ce780874155d395da2e76c8722c'],
    'picks-mobile.js':['4','9f01e491b11dde3d648eb80bc192aa3e6c85655df9aae0186b565fa5af19f7a0'],
    'picks-mobile.css':['4','840e21a3955ab580efed8a3a9e0f28a65003f01f407a89ccb3a0a586296eb4f1'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const V29_WORKER='a2c98c486b49f91be07b5504e8c97f69a54b416f657990707c83629dbf62753c';
  const CHANGED=new Set(['index.html','picks-mobile.js','picks-mobile.css']);
  // The shell as the multi-select slates left it: before the season record's assets, page markup and weekly-app.js version.
  const index=indexBeforeSeason,source=sourceBeforeSeason;
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=shellBeforeSeasonRecord(precached).map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await ps('the multi-select slates change exactly the page, the mobile module and the mobile stylesheet, roll exactly the two mobile versions to v=5 and add no shell asset (against pool-center-shell-v29)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V29[path];
      if(!before){problems.push(`${path} is new to the shell: the multi-select slates add no shell asset`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
      if(changed&&!CHANGED.has(path))problems.push(`${path} is outside the multi-select slates and must keep its bytes`);
    }
    for(const path of Object.keys(V29))if(!entries.some(e=>e.path===path))problems.push(`${path} must stay precached`);
    for(const path of CHANGED)if(sha(path)===V29[path][1])problems.push(`${path} must change for the multi-select slates`);
    for(const [asset,,after] of PICKS_SLATES.versions)if(entries.find(e=>e.path===asset)?.version!==after)problems.push(`${asset} must be precached at v=${after}`);
    for(const path of Object.keys(V29))if(!CHANGED.has(path)&&sha(path)!==V29[path][1])problems.push(`${path} is outside the multi-select slates and must keep its bytes`);
    assert.deepEqual(problems,[]);
  });
  await ps('the multi-select slates roll the shell cache from pool-center-shell-v29 to v30',()=>assert.equal(cacheName,PICKS_SLATES.cache[1]));
  await ps('the page differs from the slate groups page only in the slate selection panel and the two mobile versions',()=>{
    for(const {start} of PICKS_SLATES.regions)assert.equal(index.split(start).length-1,1,`the page carries ${start.trim().slice(0,60)}… exactly once`);
    assert.equal(digest(Buffer.from(withoutPicksSlates(index),'utf8')),V29['index.html'][1],'with the multi-select slates taken out, the page is byte-identical to the slate groups page');
    assert.notEqual(digest(Buffer.from(index,'utf8')),V29['index.html'][1]);
  });
  await ps('the worker differs from the slate groups worker only in its cache name and the two mobile versions (strategy unchanged)',()=>{
    assert.equal(digest(Buffer.from(withoutPicksSlates(source),'utf8')),V29_WORKER,'with the multi-select slates taken out, the worker is byte-identical to the slate groups worker');
  });
  await ps('the page and the worker name the module and the stylesheet at one version, v=5, the precached one; v=4 is neither precached nor loaded',()=>{
    for(const [path,version] of [['picks-mobile.js','5'],['picks-mobile.css','5']]){
      const escaped=path.replace(/[.]/g,'\\.');
      for(const [label,text] of [['index.html',index],['service-worker.js',source]]){
        const named=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert.deepEqual([...named],[version],`${label} names ${path} at ${[...named].join(', ')}; only v=${version} is precached`);
      }
    }
    for(const asset of ['picks-mobile.js?v=4','picks-mobile.css?v=4'])assert(!source.includes(`'./${asset}'`),`the worker must no longer precache ${asset}`);
    assert(!index.includes('picks-mobile.js?v=4"')&&!index.includes('picks-mobile.css?v=4"'),'the page must no longer load the superseded mobile versions');
  });
  await ps('picks-mobile.js still imports nothing, reaches no network, loads no remote resource and starts no timer, and remembers the slates under their own versioned key; the apps keep their baseline bytes and look for no mobile markup',()=>{
    const module=bytes('picks-mobile.js').toString('utf8');
    assert.deepEqual([...module.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m=>m[1]),[]);
    for(const file of ['picks-mobile.js','picks-mobile.css']){
      const text=bytes(file).toString('utf8');
      assert(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/.test(text),`${file} must not make requests`);
      assert(!/https?:\/\//.test(text),`${file} must not name a remote resource`);
      assert(!/setInterval|setTimeout/.test(text),`${file} must start no timer`);
    }
    assert(module.includes("export const SLATES_KEY='poolcenter.picks.slates.v1';")&&module.includes("export const STORAGE_KEY='poolcenter.picks.v1';")&&module.includes("export const LABELS_KEY='poolcenter.picks.labels.v1';"),'three keys, the earlier two unchanged');
    for(const app of ['weekly-app.js','survivor-app.js']){
      assert.equal(sha(app),V29[app][1],`${app} keeps its bytes`);
      assert(!/getElementById\(['"`](?:picks|pm-)|\$\(['"`]picks|data-picks|data-rules|rules-toggle|picksBoard|picksFilters|picksEntrants|picksLabels|picksSlates|pm-slate/.test(bytes(app).toString('utf8')),`${app} must not look for mobile markup`);
    }
  });
  await ps('index.html: the slate selection dialog follows the entry selection dialog, a labelled modal panel built like it (a close control and Done, Select all, the list the module fills, a live status line) and loads nothing remote; the slate selector is gone and no slate control is permanently on the page',()=>{
    const open=index.indexOf('<dialog class="pm-dialog" id="picksSlates"'),dialog=index.slice(open,index.indexOf('</dialog>',open));
    assert(open>index.indexOf('<dialog class="pm-dialog" id="picksEntrants"'),'after the entry selection dialog');
    assert(dialog.startsWith('<dialog class="pm-dialog" id="picksSlates" aria-labelledby="picksSlatesTitle">')&&dialog.includes('<h2 id="picksSlatesTitle">Slates to show</h2>'),'a labelled dialog');
    assert.equal(dialog.split('data-picks-slates-close').length-1,2,'a close control in the head and Done');
    assert(dialog.includes('<div class="pm-sheet-list" data-picks-slate-list></div>')&&dialog.includes('<button type="button" class="share-action" data-picks-slate-choice="*">Select all</button>'));
    assert(dialog.includes('<p class="pm-sheet-status" data-picks-slates-note role="status" aria-live="polite"></p>'),'a live status line');
    assert(!/(?:src|href)="(?:https?:)?\/\//.test(dialog),'the dialog loads nothing remote');
    assert(!/data-picks-slate-choice|data-picks-slates-open|data-picks-slate-list/.test(index.slice(0,index.indexOf('<dialog class="pm-dialog" id="picksEntrants"'))),'no slate control outside the panel');
    for(const id of ['picksSlates','picksSlatesTitle','picksEntrants','picksEntrantsTitle','picksBoard','picksFilters'])assert.equal(index.split(`id="${id}"`).length-1,1,`index.html has exactly one #${id}`);
  });
  await ps('picks-mobile.js renders one Slates control that opens the slate panel in place of the slate selector, and the stylesheet keeps it a 44px target that never widens its row',()=>{
    const module=bytes('picks-mobile.js').toString('utf8'),css=bytes('picks-mobile.css').toString('utf8');
    assert(module.includes('data-picks-slates-open aria-haspopup="dialog" aria-expanded="false" aria-controls="picksSlates"'),'one control naming the panel it opens');
    assert(!/<select|data-picks-slate>|pm-select/.test(module)&&!/\.pm-select/.test(css),'no slate selector');
    assert.match(css,/\.pm-compare\{[^}]*min-height:44px/);assert.match(css,/\.pm-compare\{[^}]*flex:1 1 150px;min-width:0;/);
    assert(css.includes('.pm-compare b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}'),'a long summary is cut, never widening the row');
  });
}

// ---- Season record version discipline. Each precached asset is checked against the bytes and version it had in
// pool-center-shell-v30 (main 6f4a3b8, the production baseline). The feature changes the bytes of index.html (the season
// strip container in the Live Standings body, the Season Record card on Standings, its stylesheet link and module script) and
// of weekly-app.js (its poolcenter:season answers), so exactly weekly-app.js rolls its version (to weekly-v24); it adds
// exactly season-record.js and season-record.css, each at v=1; every other asset keeps its bytes and version, and the shell
// cache rolls to v31. Mixed versions stay safe: a page cached before the deploy has no season containers and never loads
// season-record.js; weekly-v24 only answers a poolcenter:season request, which nothing else sends; and season-record.js reads
// nothing and shows nothing until weekly-v24 answers that request with a week on screen.
const ssFailures=[];
const ss=async(name,check)=>{try{await check()}catch(error){ssFailures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
{
  const {createHash}=await import('node:crypto');
  const bytes=path=>{try{return readFileSync(new URL(`./${path}`,import.meta.url))}catch{return null}};
  const digest=b=>createHash('sha256').update(b).digest('hex'),sha=path=>{const b=bytes(path);return b?digest(b):null};
  const V30={
    'index.html':[null,'1670f05f397d0483800d170aa43cd7ee2fcb68ffe8206dc87df2cfc6cb6f97a3'],
    'style.css':['premium-v3','83cce4ed122a251791d3f272b9cf5bed94c849dac9a0ad74d39bef784dcdf815'],
    'slate.css':['slate-v1','58f87ea913d974f98f9bab54c1c3d74bd608f723b47fe491128d96016937abdb'],
    'weekly.css':['premium-v3','fe917b9123af034c887fc3290e052c07ba6d1a7ed72ff0e9286a6f53ea6a1f44'],
    'weekly-app.js':['weekly-v23','7efcceefa199c211581262b977a70c86d5a7b6a586f714fb72dd79015c3eb782'],
    'public-math.js':['3','9603a2703316bde8f223ff9e58389110b8851f6f95b588cd87254fab0c12c694'],
    'survivor.css':['4','ec104e2e22394460c9a0ee473e84d47d87eb5e72eb7cf1f67135f626978b4938'],
    'survivor-app.js':['12','be0a2f03ecf92fc419b0d5ec77f63ef372d5e7598d74d5f666dc06a379f38d06'],
    'survivor-math.js':['7','3aebca4ad08412658e7d0fc4b9f0207d829e2b9f718579f556594e13373b634f'],
    'contest-rulings.js':['2','5422cd96a48333f4eceaaf0d6b300b30f0a09d24b34de42a619e20e8fc401a77'],
    'score-feed-proxy.js':['2','b13635d4706099c67272b8ae739e9a363b21342bb2a87af1581847dc936747b7'],
    'pwa.js':['1','febf3af70464731d65d56beb3a88ee5f8587808eeebf52f97b06211d47bb34da'],
    'share-card.js':['2','e5653e8837ed9ab0df03d64d56c5390817913c89ba6e1ea531f1f87f5fb4ae83'],
    'share-ui.js':['2','be272771bf91024b6604f395843e6d9889bc5989d54b67db8e4388728d4fdf12'],
    'share.css':['1','32beaa9657dcae9ac5ff899261ee64f6188011f8e82e3de8de606721964f5dd4'],
    'home-dashboard.js':['1','cab9d67b73b4eb3e97d0f2faf6a6282c26f1cf6a05bb21ca830768ff5669a6f0'],
    'home-dashboard.css':['1','f11331d27e0db68f71d488bcab35b5dcd0353ce780874155d395da2e76c8722c'],
    'picks-mobile.js':['5','557223c6d920e4652b96da512198ed16e210b6c7bb758ac886159ca5b2269960'],
    'picks-mobile.css':['5','870d2fb477ac88ec6054763c3424f2d31955205ecddf53cbe34114f8836cc255'],
    'manifest.webmanifest':[null,'b6508c471231b597c8296084d4749d9004fe07cb33247a2e52e57775c35d53cf'],
    'assets/pool-center-icon.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3'],
    'assets/pool-center-icon-192.svg':[null,'7cbd4c5a5fc061fb572e4b6e284ced95310da3d8a46c538c5ba3717d2d8a86e9'],
    'assets/pool-center-icon-512.svg':[null,'9fd6f65b0c367cee1988f3a573301279f1d11768577ef52ab1a72cf26d0604a3']
  };
  const V30_WORKER='60229252c894222666533b40566315fd2d4599ed942bb8c9ca94f0fd366a0683';
  const CHANGED=new Set(['index.html','weekly-app.js']);
  const cacheName=source.match(/const CACHE='([^']+)'/)?.[1];
  const entries=precached.map(url=>{const u=new URL(url),path=u.pathname.replace('/nfl-pool/','')||'index.html';return{url,path,version:u.searchParams.get('v')}});
  await ss('the season record changes exactly the page and weekly-app.js, rolls exactly weekly-app.js to weekly-v24 and adds exactly season-record.js and season-record.css at v=1 (against pool-center-shell-v30)',()=>{
    const problems=[];
    for(const {path,version} of entries){
      const before=V30[path];
      if(!before){if(!SEASON_RECORD.assets.has(path))problems.push(`${path} is new to the shell but is not a season record asset`);else if(version!=='1')problems.push(`${path} is new and must be precached at v=1, not v=${version}`);continue}
      if(before[0]===null)continue;
      const changed=sha(path)!==before[1];
      if(changed&&version===before[0])problems.push(`${path} changed but is still precached at v=${version}`);
      if(!changed&&version!==before[0])problems.push(`${path} is unchanged but its version moved from v=${before[0]} to v=${version}`);
      if(changed&&!CHANGED.has(path))problems.push(`${path} is outside the season record and must keep its bytes`);
    }
    for(const path of Object.keys(V30))if(!entries.some(e=>e.path===path))problems.push(`${path} must stay precached`);
    for(const path of SEASON_RECORD.assets)if(!entries.some(e=>e.path===path))problems.push(`${path} must be precached`);
    for(const path of CHANGED)if(sha(path)===V30[path][1])problems.push(`${path} must change for the season record`);
    for(const [asset,,after] of SEASON_RECORD.versions)if(entries.find(e=>e.path===asset)?.version!==after)problems.push(`${asset} must be precached at v=${after}`);
    for(const path of Object.keys(V30))if(!CHANGED.has(path)&&sha(path)!==V30[path][1])problems.push(`${path} is outside the season record and must keep its bytes`);
    // Every earlier layer sees the changed files at these bytes, so they must be exactly the bytes the feature started from.
    for(const [path,hash] of Object.entries(SEASON_RECORD.before))if(!CHANGED.has(path)||hash!==V30[path][1])problems.push(`${path}: the earlier layers must see its pool-center-shell-v30 bytes`);
    assert.deepEqual(problems,[]);
  });
  await ss('the season record rolls the shell cache from pool-center-shell-v30 to v31',()=>assert.equal(cacheName,SEASON_RECORD.cache[1]));
  await ss('the page differs from the multi-select slates page only in the season containers, its stylesheet link and module script, and the weekly-app.js version',()=>{
    for(const addition of SEASON_RECORD.page)assert.equal(index.split(addition).length-1,1,`the page carries ${addition.trim()} exactly once`);
    for(const {start} of SEASON_RECORD.regions)assert.equal(index.split(start).length-1,1,`the page carries ${start.trim()}… exactly once`);
    assert.equal(digest(Buffer.from(withoutSeasonRecord(index),'utf8')),V30['index.html'][1],'with the season record taken out, the page is byte-identical to the multi-select slates page');
    assert.notEqual(digest(Buffer.from(index,'utf8')),V30['index.html'][1]);
  });
  await ss('the worker differs from the multi-select slates worker only in its cache name, the weekly-app.js version and the two season record entries (strategy unchanged)',()=>{
    assert.equal(digest(Buffer.from(withoutSeasonRecord(source),'utf8')),V30_WORKER,'with the season record taken out, the worker is byte-identical to the multi-select slates worker');
  });
  await ss('the page and the worker name each changed or new asset at one version, the precached one; weekly-v23 is neither precached nor loaded',()=>{
    for(const [path,version] of [['weekly-app.js','weekly-v24'],['season-record.js','1'],['season-record.css','1']]){
      const escaped=path.replace(/[.]/g,'\\.');
      for(const [label,text] of [['index.html',index],['service-worker.js',source]]){
        const named=new Set([...text.matchAll(new RegExp(`${escaped}\\?v=([^'"&\\s]+)`,'g'))].map(m=>m[1]));
        assert.deepEqual([...named],[version],`${label} names ${path} at ${[...named].join(', ')}; only v=${version} is precached`);
      }
    }
    assert(!source.includes("'./weekly-app.js?v=weekly-v23'")&&!index.includes('weekly-app.js?v=weekly-v23"'),'weekly-v23 is superseded');
  });
  await ss('weekly-app.js keeps exactly its two imports, so every page harness still loads it as it is; season-record.js imports only the evaluator, at its precached version',()=>{
    const imports=file=>[...bytes(file).toString('utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m=>m[1]);
    assert.deepEqual(imports('weekly-app.js'),['./public-math.js?v=3','./contest-rulings.js?v=2']);
    assert.deepEqual(imports('season-record.js'),['./contest-rulings.js?v=2']);
  });
  await ss('season-record.js only reads, with plain GET requests, from the hosts the page itself reads; it starts no timer of its own and keeps nothing beyond the page; its stylesheet loads nothing',()=>{
    const module=bytes('season-record.js').toString('utf8'),css=bytes('season-record.css').toString('utf8'),app=bytes('weekly-app.js').toString('utf8');
    const hosts=[...new Set([...module.matchAll(/https:\/\/[^'`\s/]+/g)].map(m=>m[0]))].sort();
    assert.deepEqual(hosts,['https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech','https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech','https://site.api.espn.com']);
    for(const host of hosts)assert(app.includes(host),`weekly-app.js reads ${host} too`);
    assert(!/method\s*:|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/.test(module),'no write, beacon, socket or dynamic import');
    assert(!/setInterval/.test(module),'no timer of its own: it reads after the page’s own refresh notifications');
    assert(!/localStorage|sessionStorage|indexedDB|caches\./.test(module),'nothing kept beyond the page');
    assert(!/https?:\/\/|url\(|@import/.test(css),'the stylesheet loads nothing');
  });
  await ss('index.html: the season strip sits in the Live Standings body after the rows weekly-app.js renders, the Season Record card follows Your Group on Standings, and each container appears exactly once',()=>{
    assert(index.includes('<div class="dash-body" id="dash-standings-body"><div class="home-standings" id="homeStandings"></div><div class="season-strip" id="homeSeason"></div></div>'),'the strip is inside the Live Standings body, after #homeStandings');
    const standings=index.slice(index.indexOf('<section class="view-panel" data-view-panel="standings" hidden>'),index.indexOf('<section class="view-panel" data-view-panel="games" hidden>'));
    assert(standings.indexOf('<section class="card season-card" aria-labelledby="season-title">')>standings.indexOf('<tbody id="standings"></tbody>'),'the card follows Your Group');
    assert(standings.includes('<div class="meta" id="seasonMeta">Loading season record…</div>')&&standings.includes('<div class="season-body" id="seasonRecord"><div class="empty">Loading season record…</div></div>'),'loading text until the season record is ready');
    for(const id of ['homeSeason','seasonRecord','seasonMeta','season-title','homeStandings','standings'])assert.equal(index.split(`id="${id}"`).length-1,1,`index.html has exactly one #${id}`);
  });
}

assert.equal(hdc12Failures.length,0,`HDC-12 service-worker regressions failed (${hdc12Failures.length}):\n  ${hdc12Failures.join('\n  ')}`);
assert.equal(hdc14Failures.length,0,`HDC-14 service-worker regressions failed (${hdc14Failures.length}):\n  ${hdc14Failures.join('\n  ')}`);
assert.equal(hdc15Failures.length,0,`HDC-15 service-worker regressions failed (${hdc15Failures.length}):\n  ${hdc15Failures.join('\n  ')}`);
assert.equal(sc1Failures.length,0,`Share-card service-worker regressions failed (${sc1Failures.length}):\n  ${sc1Failures.join('\n  ')}`);
assert.equal(hdFailures.length,0,`Home dashboard service-worker regressions failed (${hdFailures.length}):\n  ${hdFailures.join('\n  ')}`);
assert.equal(pmFailures.length,0,`V1.3 mobile UX service-worker regressions failed (${pmFailures.length}):\n  ${pmFailures.join('\n  ')}`);
assert.equal(pcFailures.length,0,`V1.4 compact Picks UX service-worker regressions failed (${pcFailures.length}):\n  ${pcFailures.join('\n  ')}`);
assert.equal(ppFailures.length,0,`V1.4 final polish service-worker regressions failed (${ppFailures.length}):\n  ${ppFailures.join('\n  ')}`);
assert.equal(paFailures.length,0,`V1.4 collapsible slate groups service-worker regressions failed (${paFailures.length}):\n  ${paFailures.join('\n  ')}`);
assert.equal(psFailures.length,0,`V1.4 multi-select slates service-worker regressions failed (${psFailures.length}):\n  ${psFailures.join('\n  ')}`);
assert.equal(ssFailures.length,0,`Season record service-worker regressions failed (${ssFailures.length}):\n  ${ssFailures.join('\n  ')}`);

console.log('service-worker precache graph (share-card, Home dashboard, V1.3 mobile UX, V1.4 compact Picks UX, V1.4 final polish, V1.4 collapsible slate groups, V1.4 multi-select slates and season record versions), fresh (cache:"reload") precache requests, all-or-nothing install, cache rollover, public fallback, HTTP error fallback, navigation redirect, public route boundary, Admin isolation, Admin path boundary and noncanonical Admin path regressions passed');
