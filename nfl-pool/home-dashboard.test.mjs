// Home dashboard regressions. home-dashboard.js's pure parts directly (preferences and their validation, the statuses and
// summaries, the Quick Overview and Survivor Quick View markup), and its page part on a small DOM built from the real Home
// panel of index.html (so the markup the module needs is the markup the page ships), with the two apps stood in for by
// poolcenter:share listeners that answer with fixtures and poolcenter:update announcements, exactly as weekly-app.js and
// survivor-app.js do. share-ui.js runs on the same DOM for the Home share menu.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {STORAGE_KEY,PREFERENCES_VERSION,SECTIONS,DENSITIES,SPOTLIGHT_ENTRANT,defaultPreferences,normalizePreferences,readPreferences,writePreferences,
  formatAge,contestStatus,leaderText,spotlightText,sectionSummary,overviewHtml,survivorQuickViewHtml} from './home-dashboard.js';

const failures=[];
const check=async(name,fn)=>{try{await fn()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
const flush=async(n=10)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};
const NOW=Date.parse('2026-10-11T19:42:10Z'),iso=ms=>new Date(ms).toISOString();
const index=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const HOME_PANEL=index.slice(index.indexOf('<section class="view-panel" data-view-panel="home">'),index.indexOf('<section class="view-panel" data-view-panel="standings"'));
assert(HOME_PANEL.includes('id="dashSections"')&&HOME_PANEL.includes('id="dashPanel"'),'the Home panel of index.html holds the dashboard');

// ---- Snapshots, as the apps answer them (weekly-app.test.mjs and survivor-app.test.mjs check that they do).
const entry=(name,w,l,left,groupRank,field,o={})=>({name,w,l,left,groupRank,leader:groupRank===1,noPicks:false,tiebreakDelta:null,field,...o});
const rank=(r,tieCount,topPercent,behind)=>({rank:r,tieCount,label:`${tieCount>1?'T-':'#'}${r}`,topPercent,behind});
const pickem=(o={})=>({ready:true,contest:'pickem',season:2026,week:5,revision:2,games:{total:16,final:12,void:0,live:2,remaining:4},fieldSize:87,tiebreak:{final:false,void:false},
  entries:[entry('D.C.',10,2,4,1,rank(3,1,4,1)),entry('JC',9,3,4,2,rank(8,5,10,2)),entry('DJS',9,3,4,2,rank(8,5,10,2)),entry('Thaddeus',7,5,4,4,rank(41,9,48,4))],
  feed:{fetchedAt:iso(NOW-8000),failed:false,incomplete:false,warnings:0,review:false},hold:false,rulingsStale:false,publishedStale:false,
  race:{outcomes:81,racePaths:27,items:[{name:'D.C.',status:'ALIVE',note:'Ceiling 14 wins'},{name:'JC',status:'ALIVE',note:'Ceiling 13 wins'},{name:'DJS',status:'ALIVE',note:'Ceiling 13 wins'},{name:'Thaddeus',status:'OUT',note:'Cannot finish first'}]},
  spotlight:{away:'KC',home:'BUF',status:'3rd 7:41',live:true,final:false,awayScore:17,homeScore:14},...o});
const tracked=(name,status,team,reason,underReview=false)=>({name,status,team,reason,underReview});
const survivor=(o={})=>({ready:true,contest:'survivor',season:2026,week:5,revision:7,fieldSize:120,counts:{active:42,pending:8,out:78,outThisWeek:12,submitted:50,legalPicks:50,awaitingRuling:0,onHold:0},
  tracked:[tracked('D.C.','ALIVE','KC','Alive through Week 5'),tracked('DJS','OUT','BUF','BUF lost in Week 3'),tracked('Thaddeus','PENDING','SF','Week 5 game pending')],
  feed:{at:NOW-6000,failed:false,interval:60000},hold:false,flags:[],rulingsStale:false,publishedStale:false,...o});
// The page part reads the real clock, so page fixtures are fresh against it.
const pickemFresh=(o={})=>({...pickem(),feed:{...pickem().feed,fetchedAt:iso(Date.now()-2000)},...o});
const survivorFresh=(o={})=>({...survivor(),feed:{...survivor().feed,at:Date.now()-2000},...o});
const DEFAULT_ORDER=['overview','standings','survivor','pulse','scenarios','games'];

// ---- Preferences.
await check('the defaults: six sections in order, none hidden, the three optional ones collapsed, compact; the Quick Overview is the one required section',()=>{
  assert.equal(STORAGE_KEY,'poolcenter.home.dashboard.v1');assert.equal(PREFERENCES_VERSION,1);assert.deepEqual(DENSITIES,['compact','detailed']);assert.equal(SPOTLIGHT_ENTRANT,'DJS');
  assert.deepEqual(SECTIONS.map(s=>[s.id,s.title,s.required,s.expanded]),[['overview','Quick Overview',true,true],['standings','Live Standings',false,true],['survivor','Survivor Quick View',false,true],['pulse','Pool Status',false,false],['scenarios','Group Scenarios',false,false],['games','Game Watch',false,false]]);
  assert.deepEqual(defaultPreferences(),{version:1,order:DEFAULT_ORDER,hidden:[],collapsed:['pulse','scenarios','games'],density:'compact'});
  assert(Object.isFrozen(SECTIONS)&&Object.isFrozen(SECTIONS[0]));
  const a=defaultPreferences(),b=defaultPreferences();a.order.push('x');assert.deepEqual(b.order,DEFAULT_ORDER,'each call is a fresh copy');
});
await check('stored preferences are validated: unknown versions and shapes are the defaults, unknown or repeated sections are dropped and missing ones follow, the required section is never hidden, an unknown density is compact',()=>{
  const valid={version:1,order:['games','survivor','overview','standings','pulse','scenarios'],hidden:['pulse','games'],collapsed:['overview'],density:'detailed'};
  assert.deepEqual(normalizePreferences(valid),valid);
  for(const raw of [null,undefined,'{}',42,[],{},{version:2,order:DEFAULT_ORDER},{version:'1',order:DEFAULT_ORDER},{version:1}])assert.deepEqual(normalizePreferences(raw),defaultPreferences(),JSON.stringify(raw));
  assert.deepEqual(normalizePreferences({version:1,order:['games','bogus','games','overview']}).order,['games','overview','standings','survivor','pulse','scenarios'],'unknown and repeated ids dropped, the rest follow in default order');
  assert.deepEqual(normalizePreferences({version:1,order:'games'}).order,DEFAULT_ORDER,'an order that is not a list is the default');
  assert.deepEqual(normalizePreferences({version:1,hidden:['overview','pulse','pulse','nope',7]}).hidden,['pulse'],'the required section cannot be hidden');
  assert.deepEqual(normalizePreferences({version:1,collapsed:[]}).collapsed,[],'everything expanded is a choice');
  assert.deepEqual(normalizePreferences({version:1,collapsed:'x'}).collapsed,['pulse','scenarios','games'],'a collapsed list that is not a list is the default');
  assert.deepEqual(normalizePreferences({version:1,collapsed:['overview','nope']}).collapsed,['overview']);
  for(const density of ['huge',null,1,'DETAILED'])assert.equal(normalizePreferences({version:1,density}).density,'compact',String(density));
  assert.equal(normalizePreferences({version:1,density:'detailed'}).density,'detailed');
});
await check('reading storage: absent, refusing, empty, malformed or old values are the defaults; writing touches only the one key and reports failure instead of throwing',()=>{
  const store=new Map(),storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v)};
  assert.deepEqual(readPreferences(storage),defaultPreferences(),'nothing stored');
  assert.deepEqual(readPreferences(undefined),defaultPreferences(),'no storage at all');
  assert.deepEqual(readPreferences({getItem(){throw new Error('denied')}}),defaultPreferences(),'storage that refuses');
  store.set(STORAGE_KEY,'{not json');assert.deepEqual(readPreferences(storage),defaultPreferences(),'malformed');
  store.set(STORAGE_KEY,JSON.stringify({version:0,order:['games']}));assert.deepEqual(readPreferences(storage),defaultPreferences(),'an older version');
  store.set(STORAGE_KEY,JSON.stringify({version:1,order:['games'],hidden:['overview'],collapsed:[],density:'detailed'}));
  assert.deepEqual(readPreferences(storage),{version:1,order:['games','overview','standings','survivor','pulse','scenarios'],hidden:[],collapsed:[],density:'detailed'});
  store.set('other','keep');
  assert.equal(writePreferences(defaultPreferences(),storage),true);
  assert.deepEqual([...store.keys()].sort(),['other',STORAGE_KEY]);assert.deepEqual(JSON.parse(store.get(STORAGE_KEY)),defaultPreferences());assert.equal(store.get('other'),'keep');
  assert.equal(writePreferences(defaultPreferences(),undefined),false);
  assert.equal(writePreferences(defaultPreferences(),{setItem(){throw new Error('quota')}}),false);
});

// ---- Statuses and summaries.
await check('a contest’s chip: the share card’s own status when the snapshot is ready, LOADING or UNAVAILABLE with the app’s reason when not, UNAVAILABLE when no app answered',()=>{
  assert.deepEqual(contestStatus('pickem',null),{label:'UNAVAILABLE',tone:'bad',detail:"Pick'em has not answered. Reload the page to try again.",flags:[],ready:false});
  assert.deepEqual(contestStatus('survivor',undefined).label,'UNAVAILABLE');
  assert.deepEqual(contestStatus('survivor',{ready:false,reason:'Survivor results are still loading.'}),{label:'LOADING',tone:'muted',detail:'Survivor results are still loading.',flags:[],ready:false});
  assert.deepEqual(contestStatus('pickem',{ready:false,reason:"Pick'em standings have not loaded yet."}).label,'LOADING');
  assert.deepEqual(contestStatus('pickem',{ready:false,reason:'Another week is loading. Share again once it is on screen.'}).label,'LOADING');
  assert.deepEqual(contestStatus('survivor',{ready:false,reason:'Survivor results for this week could not be loaded, so there is nothing to share yet.'}),{label:'UNAVAILABLE',tone:'bad',detail:'Survivor results for this week could not be loaded, so there is nothing to share yet.',flags:[],ready:false});
  assert.deepEqual(contestStatus('survivor',{ready:false,reason:'Survivor is not published yet: No published Survivor weeks found'}).label,'UNAVAILABLE');
  assert.deepEqual(contestStatus('pickem',{ready:false}).detail,"Pick'em has nothing to show yet.");
  const pk=contestStatus('pickem',pickem(),{now:NOW});
  assert.deepEqual([pk.label,pk.tone,pk.detail,pk.ready],['LIVE','ok','12 of 16 games final · 2 live',true]);
  assert.deepEqual(contestStatus('pickem',pickem({games:{total:16,final:16,void:0,live:0,remaining:0},entries:pickem().entries.map(e=>({...e,left:0,w:e.w+4}))}),{now:NOW}).label,'FINAL');
  assert.equal(contestStatus('pickem',pickem({feed:{...pickem().feed,fetchedAt:iso(NOW-45000)}}),{now:NOW}).label,'DELAYED');
  assert.equal(contestStatus('pickem',pickem({hold:true}),{now:NOW}).label,'ON HOLD');
  const sv=contestStatus('survivor',survivor(),{now:NOW});
  assert.deepEqual([sv.label,sv.tone,sv.detail,sv.ready],['LIVE','ok','8 entries pending',true]);
  assert.equal(contestStatus('survivor',survivor({feed:{at:NOW-50000,failed:false,interval:60000}}),{now:NOW}).label,'LIVE','50 s old at a 60 s interval is live on Home');
  assert.equal(contestStatus('survivor',survivor({feed:{at:NOW-100000,failed:false,interval:60000}}),{now:NOW}).label,'DELAYED');
  assert.equal(contestStatus('survivor',survivor({feed:{at:NOW-50000,failed:false}}),{now:NOW}).label,'DELAYED','without an interval the 30 s limit stands');
  assert.equal(contestStatus('survivor',survivor({feed:{at:NOW-6000,failed:true,interval:60000}}),{now:NOW}).label,'RESULT FEED UNAVAILABLE');
  assert.equal(contestStatus('survivor',survivor({publishedStale:true}),{now:NOW}).label,'PUBLISHED DATA STALE');
  assert.deepEqual(contestStatus('survivor',survivor({flags:['1 TEAM RESULT UNVERIFIED']}),{now:NOW}).flags,['1 TEAM RESULT UNVERIFIED']);
  assert.equal(contestStatus('pickem',{ready:true,contest:'pickem'},{now:NOW}).label,'UNAVAILABLE','a snapshot that cannot be read never throws');
});
await check('ages, leaders and the spotlight game read as the page says them',()=>{
  assert.deepEqual([formatAge(NOW-1000,NOW),formatAge(NOW-5000,NOW),formatAge(NOW-59000,NOW),formatAge(NOW-60000,NOW),formatAge(NOW-3599000,NOW),formatAge(NOW-7200000,NOW),formatAge(NaN,NOW),formatAge(NOW+5000,NOW)],
    ['just now','5s ago','59s ago','1m ago','59m ago','2h ago','age unknown','just now']);
  assert.equal(leaderText(pickem()),'D.C. 10–2');
  assert.equal(leaderText(pickem({entries:pickem().entries.map((e,i)=>({...e,groupRank:i<2?1:i+1,leader:i<2,w:i<2?10:e.w,l:i<2?2:e.l}))})),'D.C. / JC 10–2');
  assert.equal(leaderText({entries:[]}),'—');
  assert.equal(spotlightText(pickem().spotlight),'KC 17–14 BUF · 3rd 7:41');
  assert.equal(spotlightText({away:'DEN',home:'KC',status:'Sun 4:25 PM',live:false,final:false,awayScore:null,homeScore:null}),'DEN @ KC · Sun 4:25 PM');
  assert.equal(spotlightText({away:'DEN',home:'KC',status:'VOID',live:false,final:true,awayScore:24,homeScore:17}),'DEN 24–17 KC · VOID');
  assert.equal(spotlightText(null),'');
});
await check('the collapsed summaries come from the same snapshots as the expanded sections: both chips, the leader, the field’s counts with the spotlight entrant, the slate, the race and the game',()=>{
  const both={pickem:pickem(),survivor:survivor()},o={now:NOW};
  assert.deepEqual(DEFAULT_ORDER.map(id=>sectionSummary(id,both,o)),["Pick'em LIVE · Survivor LIVE",'D.C. 10–2','42 of 120 remaining · 8 pending · DJS OUT','12/16 final · 2 live','D.C. ALIVE · JC ALIVE · DJS ALIVE · Thaddeus OUT','KC 17–14 BUF · 3rd 7:41']);
  assert.equal(sectionSummary('pulse',{pickem:pickem({games:{total:16,final:11,void:1,live:0,remaining:4}})},o),'11/16 final · 1 void · 4 left');
  assert.equal(sectionSummary('pulse',{pickem:pickem({games:{total:16,final:16,void:0,live:0,remaining:0}})},o),'16/16 final');
  assert.equal(sectionSummary('survivor',{survivor:survivor({counts:{...survivor().counts,pending:0}})},o),'42 of 120 remaining · DJS OUT');
  assert.equal(sectionSummary('survivor',{survivor:survivor({tracked:survivor().tracked.filter(t=>t.name!=='DJS')})},o),'42 of 120 remaining · 8 pending');
  assert.equal(sectionSummary('scenarios',{pickem:pickem({race:null})},o),'—');
  assert.equal(sectionSummary('games',{pickem:pickem({spotlight:null})},o),'No games');
  const loading={pickem:{ready:false,reason:'Scores for this week are still loading.'},survivor:{ready:false,reason:'Survivor results for this week could not be loaded, so there is nothing to share yet.'}};
  assert.deepEqual(DEFAULT_ORDER.map(id=>sectionSummary(id,loading,o)),["Pick'em LOADING · Survivor UNAVAILABLE",'Loading…','Unavailable','Loading…','Loading…','Loading…']);
  assert.deepEqual(DEFAULT_ORDER.map(id=>sectionSummary(id,{},o)),["Pick'em UNAVAILABLE · Survivor UNAVAILABLE",'Unavailable','Unavailable','Unavailable','Unavailable','Unavailable']);
  assert.equal(sectionSummary('nope',both,o),'');
});
await check('the Quick Overview markup: each contest its own panel, chip, week and revision, facts and (only when it says more) the chip’s detail; names are escaped',()=>{
  const html=overviewHtml({pickem:pickem(),survivor:survivor()},{now:NOW});
  assert.match(html,/^<div class="dash-contest dash-contest-pickem" data-dash-contest="pickem"><div class="dash-contest-head"><span class="dash-contest-name">Pick&#39;em<\/span><span class="dash-status tone-ok">LIVE<\/span><\/div><div class="dash-contest-line">Week 5 · revision 2 · data 8s ago<\/div><div class="dash-contest-facts"><span>Leader <b>D.C. 10–2<\/b><\/span><span>Field <b>87<\/b> entries<\/span><span>Games <b>12\/16<\/b> final · 2 live<\/span><\/div><\/div>/);
  assert.match(html,/<div class="dash-contest dash-contest-survivor" data-dash-contest="survivor"><div class="dash-contest-head"><span class="dash-contest-name">Survivor<\/span><span class="dash-status tone-ok">LIVE<\/span><\/div><div class="dash-contest-line">Week 5 · revision 7 · results 6s ago<\/div><div class="dash-contest-facts"><span>Remaining <b>42<\/b> of 120<\/span><span>Pending <b>8<\/b><\/span><span>DJS <span class="status-pill survivor-out">OUT<\/span><\/span><\/div><\/div>$/);
  assert(!html.includes('dash-contest-note'),'a clean LIVE adds no note');
  const warned=overviewHtml({pickem:pickem({feed:{...pickem().feed,failed:true}}),survivor:survivor({publishedStale:true})},{now:NOW});
  assert.match(warned,/tone-bad">FEED UNAVAILABLE<\/span>[\s\S]*<div class="dash-contest-note">Score feed unavailable · last verified \d{1,2}:\d{2} [AP]M · 12 of 16 games final · 2 live<\/div>/,'the page shows the time in the device’s own zone');
  assert.match(warned,/tone-warn">PUBLISHED DATA STALE<\/span>[\s\S]*<div class="dash-contest-note">Newest publication not verified · revision 7 shown · 8 entries pending<\/div>/);
  const unpublished=overviewHtml({pickem:pickem({fieldSize:null,entries:pickem().entries.map(e=>({...e,field:null}))}),survivor:null},{now:NOW});
  assert(unpublished.includes('<span>Field <b>not published</b></span>'));
  assert.match(unpublished,/dash-contest-survivor[\s\S]*tone-bad">UNAVAILABLE<\/span><\/div><div class="dash-contest-line">—<\/div><div class="dash-contest-note">Survivor has not answered\. Reload the page to try again\.<\/div>/);
  assert(!/<div class="dash-contest-facts">/.test(unpublished.split('dash-contest-survivor')[1]),'no facts without a snapshot');
  const loading=overviewHtml({pickem:{ready:false,reason:'Scores for this week are still loading.'},survivor:{ready:false,reason:'Survivor results are still loading.'}},{now:NOW});
  assert.equal((loading.match(/tone-muted">LOADING<\/span>/g)||[]).length,2);
  const hostile=overviewHtml({pickem:pickem({entries:pickem().entries.map((e,i)=>i?e:{...e,name:'<img src=x onerror=alert(1)>'})}),survivor:survivor({tracked:[tracked('DJS','ALIVE','<b>','x')]})},{now:NOW});
  assert(!hostile.includes('<img')&&hostile.includes('&lt;img src=x onerror=alert(1)&gt;'),'names are escaped');
});
await check('the Survivor Quick View markup: the four counts, the tracked rows as badges (with their reasons when detailed), the week’s own status; nothing is shown as zero before results load',()=>{
  const compact=survivorQuickViewHtml(survivor(),{density:'compact',now:NOW});
  assert.match(compact,/^<div class="dash-survivor-metrics"><div class="dash-metric"><span>Total field<\/span><b>120<\/b><\/div><div class="dash-metric"><span>Remaining<\/span><b>42<\/b><\/div><div class="dash-metric"><span>Pending<\/span><b>8<\/b><\/div><div class="dash-metric"><span>Submissions<\/span><b>50<\/b><\/div><\/div>/);
  assert.match(compact,/<div class="dash-entrant"><span class="dash-entrant-name">D\.C\.<\/span><span class="dash-entrant-pick">KC<\/span><span class="dash-entrant-status"><span class="status-pill survivor-alive">ALIVE<\/span><\/span><\/div><div class="dash-entrant"><span class="dash-entrant-name">DJS<\/span><span class="dash-entrant-pick">BUF<\/span><span class="dash-entrant-status"><span class="status-pill survivor-out">OUT<\/span><\/span><\/div><div class="dash-entrant"><span class="dash-entrant-name">Thaddeus<\/span><span class="dash-entrant-pick">SF<\/span><span class="dash-entrant-status"><span class="status-pill survivor-pending">PENDING<\/span><\/span><\/div>/);
  assert.match(compact,/<div class="dash-survivor-status"><span class="dash-status tone-ok">LIVE<\/span><span>Week 5 · revision 7 · 8 entries pending · results 6s ago<\/span><\/div>$/);
  assert(!compact.includes('dash-entrant-reason')&&!compact.includes('dash-survivor-note'));
  const detailed=survivorQuickViewHtml(survivor({counts:{...survivor().counts,awaitingRuling:1,onHold:0,active:41},flags:['1 TEAM RESULT AWAITING RULING']}),{density:'detailed',now:NOW});
  assert.deepEqual([...detailed.matchAll(/<small class="dash-entrant-reason">([^<]*)<\/small>/g)].map(m=>m[1]),['Alive through Week 5','BUF lost in Week 3','Week 5 game pending']);
  assert.match(detailed,/<p class="dash-survivor-note">50 submitted · 50 legal picks · 78 out \(12 this week\) · 1 awaiting a ruling · 1 TEAM RESULT AWAITING RULING<\/p>$/);
  const states=survivorQuickViewHtml(survivor({tracked:[tracked('D.C.','RULING','KC','Awaiting a pool ruling'),tracked('DJS','ALIVE',null,'Advanced by ruling',true),tracked('Thaddeus','HOLD','SF','Ruling data unusable')]}),{now:NOW});
  assert.match(states,/survivor-pending">RULING<\/span>/);assert.match(states,/<span class="dash-entrant-pick none">NO PICK<\/span><span class="dash-entrant-status"><span class="status-pill survivor-alive">ALIVE<\/span><span class="status-pill survivor-review">UNDER REVIEW<\/span><\/span>/);assert.match(states,/survivor-hold">HOLD<\/span>/);
  for(const [snapshot,label,detail] of [[null,'UNAVAILABLE','Survivor has not answered. Reload the page to try again.'],[{ready:false,reason:'Survivor results are still loading.'},'LOADING','Survivor results are still loading.'],[{ready:false,reason:'Survivor is not published yet: No published Survivor weeks found'},'UNAVAILABLE','Survivor is not published yet: No published Survivor weeks found']]){
    const html=survivorQuickViewHtml(snapshot,{now:NOW});
    assert.equal(html,`<div class="dash-survivor-empty"><span class="dash-status tone-${label==='LOADING'?'muted':'bad'}">${label}</span><p>${detail}</p></div>`);
    assert(!/\b0\b/.test(html),'no zero');
  }
  const hostile=survivorQuickViewHtml(survivor({tracked:[tracked('<script>x</script>','ALIVE','KC','<i>r</i>')]}),{density:'detailed',now:NOW});
  assert(!hostile.includes('<script>')&&hostile.includes('&lt;script&gt;')&&hostile.includes('&lt;i&gt;r&lt;/i&gt;'));
});

// ---- A small DOM: elements with attributes, classList, dataset, hidden, disabled, checked, value, textContent and innerHTML
// (parsed), simple selectors (tag, #id, .class, [attr], [attr="value"], compounds and descendants), events that bubble to the
// document, focus and dialogs. Only what home-dashboard.js and share-ui.js use.
const VOID=new Set(['img','input','br','hr','meta','link','path','source','wbr']);
const decode=s=>s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[m]));
const encode=s=>String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
const kebab=k=>k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());
class TextNode{constructor(text){this.nodeType=3;this.text=text;this.parent=null}get textContent(){return this.text}}
class ClassList{
  constructor(node){this.node=node}
  get list(){return (this.node.getAttribute('class')||'').split(/\s+/).filter(Boolean)}
  set(list){this.node.setAttribute('class',list.join(' '))}
  contains(c){return this.list.includes(c)}
  add(...cs){const l=this.list;for(const c of cs)if(!l.includes(c))l.push(c);this.set(l)}
  remove(...cs){this.set(this.list.filter(c=>!cs.includes(c)))}
  toggle(c,force){const has=this.contains(c),want=force===undefined?!has:!!force;if(want&&!has)this.add(c);if(!want&&has)this.remove(c);return want}
}
function callListeners(node,event){for(const l of (node.listeners.get(event.type)||[]).slice()){if(l.once)node.listeners.set(event.type,node.listeners.get(event.type).filter(x=>x!==l));l.fn.call(node,event)}}
class Element{
  constructor(tag,doc){
    this.nodeType=1;this.localName=tag.toLowerCase();this.tagName=this.localName.toUpperCase();this.doc=doc;this.children=[];this.parent=null;this.attrs=new Map();this.listeners=new Map();this.classList=new ClassList(this);
    this.dataset=new Proxy({},{get:(_,k)=>typeof k==='string'?(this.getAttribute('data-'+kebab(k))??undefined):undefined,set:(_,k,v)=>{this.setAttribute('data-'+kebab(k),String(v));return true},has:(_,k)=>this.hasAttribute('data-'+kebab(k))});
    if(this.localName==='dialog'){this.showModal=()=>{this.open=true};this.close=()=>{if(!this.open)return;this.open=false;this.dispatchEvent({type:'close',bubbles:false})}}
    if(this.localName==='canvas'){this.getContext=()=>recorder();this.toBlob=(cb,type)=>{setTimeout(()=>cb(new Blob(['PNG-BYTES'],{type})))}}
    if(this.localName==='a')this.click=()=>{};
  }
  setAttribute(k,v){this.attrs.set(k,String(v))}getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null}hasAttribute(k){return this.attrs.has(k)}removeAttribute(k){this.attrs.delete(k)}
  get id(){return this.getAttribute('id')||''}set id(v){this.setAttribute('id',v)}
  get className(){return this.getAttribute('class')||''}set className(v){this.setAttribute('class',v)}
  get hidden(){return this.hasAttribute('hidden')}set hidden(v){if(v)this.setAttribute('hidden','');else this.removeAttribute('hidden')}
  get disabled(){return this.hasAttribute('disabled')}set disabled(v){if(v)this.setAttribute('disabled','');else this.removeAttribute('disabled')}
  get checked(){return this.hasAttribute('checked')}set checked(v){if(v)this.setAttribute('checked','');else this.removeAttribute('checked')}
  get open(){return this.hasAttribute('open')}set open(v){if(v)this.setAttribute('open','');else this.removeAttribute('open')}
  get value(){return this._value??this.getAttribute('value')??''}set value(v){this._value=String(v)}
  appendChild(c){if(c.parent)c.parent.children=c.parent.children.filter(x=>x!==c);c.parent=this;this.children.push(c);return c}
  append(...cs){for(const c of cs)this.appendChild(typeof c==='string'?new TextNode(c):c)}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null}}
  replaceChildren(...cs){for(const c of this.children)c.parent=null;this.children=[];this.append(...cs)}
  get textContent(){return this.children.map(c=>c.textContent).join('')}
  set textContent(v){this.replaceChildren();if(v!==''&&v!=null)this.appendChild(new TextNode(String(v)))}
  get innerHTML(){return this.children.map(serialize).join('')}
  set innerHTML(html){this.replaceChildren();for(const c of parse(String(html),this.doc))this.appendChild(c)}
  get elements(){const out=[];(function walk(n){for(const c of n.children)if(c.nodeType===1){out.push(c);walk(c)}})(this);return out}
  querySelectorAll(sel){return this.elements.filter(e=>matchesSelector(e,sel))}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null}
  matches(sel){return matchesSelector(this,sel)}
  closest(sel){let n=this;while(n&&n.nodeType===1){if(n.matches(sel))return n;n=n.parent}return null}
  addEventListener(type,fn,options){const list=this.listeners.get(type)||[];list.push({fn,once:!!(options&&options.once)});this.listeners.set(type,list)}
  removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)||[]).filter(l=>l.fn!==fn))}
  dispatchEvent(event){
    try{if(event.target==null)event.target=this}catch{}
    for(let node=this;node;node=node.parent){callListeners(node,event);if(event.bubbles===false||event.cancelBubble)return !event.defaultPrevented}
    callListeners(this.doc,event);
    return !event.defaultPrevented;
  }
  click(){this.dispatchEvent({type:'click',bubbles:true,target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true},stopPropagation(){this.cancelBubble=true}})}
  focus(){this.doc.activeElement=this}
  blur(){if(this.doc.activeElement===this)this.doc.activeElement=null}
}
function matchesCompound(el,compound){
  const re=/([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;let m,any=false;
  while((m=re.exec(compound))){
    any=true;
    if(m[1]){if(el.localName!==m[1].toLowerCase())return false}
    else if(m[2]){if(el.id!==m[2])return false}
    else if(m[3]){if(!el.classList.contains(m[3]))return false}
    else if(m[4]){if(!el.hasAttribute(m[4]))return false;if(m[5]!==undefined&&el.getAttribute(m[4])!==m[5])return false}
  }
  return any;
}
function matchesSelector(el,selector){
  return String(selector).split(',').some(s=>{
    const parts=s.trim().split(/\s+/);let node=el;
    if(!matchesCompound(node,parts[parts.length-1]))return false;
    for(let k=parts.length-2;k>=0;k--){node=node.parent;while(node&&node.nodeType===1&&!matchesCompound(node,parts[k]))node=node.parent;if(!node||node.nodeType!==1)return false}
    return true;
  });
}
const serialize=n=>n.nodeType===3?encode(n.text):`<${n.localName}${[...n.attrs].map(([k,v])=>v===''?` ${k}`:` ${k}="${v.replace(/"/g,'&quot;')}"`).join('')}>${VOID.has(n.localName)?'':n.children.map(serialize).join('')+`</${n.localName}>`}`;
function parse(html,doc){
  const root=[],stack=[];let i=0;
  const push=n=>{if(stack.length){stack[stack.length-1].children.push(n);n.parent=stack[stack.length-1]}else root.push(n)};
  while(i<html.length){
    if(html.startsWith('<!--',i)){const end=html.indexOf('-->',i);i=end<0?html.length:end+3;continue}
    if(html[i]==='<'){
      const end=html.indexOf('>',i);let tag=html.slice(i+1,end);i=end+1;
      if(tag.startsWith('/')){const name=tag.slice(1).trim().toLowerCase();for(let k=stack.length-1;k>=0;k--)if(stack[k].localName===name){stack.length=k;break}continue}
      const selfClosing=tag.trim().endsWith('/');if(selfClosing)tag=tag.trim().slice(0,-1);
      const m=/^([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec(tag.trim()),el=new Element(m[1],doc),attrs=/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;let a;
      while((a=attrs.exec(m[2])))el.setAttribute(a[1],decode(a[2]??a[3]??a[4]??''));
      push(el);if(!selfClosing&&!VOID.has(el.localName))stack.push(el);
    }else{const next=html.indexOf('<',i),text=html.slice(i,next<0?html.length:next);i=next<0?html.length:next;if(text)push(new TextNode(decode(text)))}
  }
  return root;
}
// A Canvas 2D stand-in for share-ui.js's PNG export, as in share-card.test.mjs.
function recorder(){
  let font='10px sans-serif';
  return{fillStyle:'#000',strokeStyle:'#000',lineWidth:1,textAlign:'start',textBaseline:'alphabetic',letterSpacing:'0px',globalAlpha:1,lineCap:'butt',lineJoin:'miter',shadowColor:'',shadowBlur:0,shadowOffsetY:0,
    get font(){return font},set font(v){font=v},
    measureText(text){const size=Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]);return{width:String(text).length*size*0.6}},
    fillText(){},strokeText(){},save(){},restore(){},translate(){},scale(){},beginPath(){},moveTo(){},lineTo(){},arcTo(){},arc(){},rect(){},closePath(){},fill(){},stroke(){},clip(){},fillRect(){},
    createLinearGradient(){return{addColorStop(){}}},createRadialGradient(){return{addColorStop(){}}}};
}
function makeDocument(html){
  const doc={listeners:new Map(),activeElement:null,
    createElement:tag=>new Element(tag,doc),
    getElementById:id=>doc.body.elements.find(e=>e.id===id)||null,
    querySelectorAll:sel=>doc.body.querySelectorAll(sel),querySelector:sel=>doc.body.querySelector(sel),
    addEventListener(type,fn,options){const list=doc.listeners.get(type)||[];list.push({fn,once:!!(options&&options.once)});doc.listeners.set(type,list)},
    removeEventListener(type,fn){doc.listeners.set(type,(doc.listeners.get(type)||[]).filter(l=>l.fn!==fn))},
    dispatchEvent(event){try{if(event.target==null)event.target=doc}catch{}callListeners(doc,event);return !event.defaultPrevented},
    execCommand:()=>false};
  doc.body=new Element('body',doc);doc.body.innerHTML=html;doc.body.dataset.view='home';
  return doc;
}
let instance=0;
// A Home page: the real Home panel, the two apps as listeners (answering a share request with their fixture, or null for an
// app that is not there), storage as configured, and the dashboard module booted on it; share-ui.js too when asked.
async function page({pickemAnswer=()=>pickemFresh(),survivorAnswer=()=>survivorFresh(),storage='ok',stored=null,withShareUi=false}={}){
  const doc=makeDocument(HOME_PANEL);
  globalThis.document=doc;
  globalThis.location={href:'https://example.test/nfl-pool/?view=home',search:'?view=home'};
  Object.defineProperty(globalThis,'navigator',{value:{},configurable:true,writable:true});
  const store=new Map(),writes=[];
  if(stored!==null)store.set(STORAGE_KEY,typeof stored==='string'?stored:JSON.stringify(stored));
  const localStorage=storage==='absent'?undefined:storage==='throws'?{getItem(){throw new Error('denied')},setItem(){throw new Error('denied')}}
    :{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{writes.push([k,String(v)]);store.set(k,String(v))},removeItem:k=>store.delete(k)};
  if(localStorage)globalThis.localStorage=localStorage;else delete globalThis.localStorage;
  const answers={pickem:pickemAnswer,survivor:survivorAnswer};
  doc.addEventListener('poolcenter:share',e=>{const answer=answers[e.detail.contest];if(answer)e.detail.snapshot=answer()});
  const timers=[],realSetInterval=globalThis.setInterval,realSetTimeout=globalThis.setTimeout;
  globalThis.setInterval=(fn,ms)=>{timers.push(['setInterval',ms]);return 0};
  globalThis.setTimeout=(fn,ms,...a)=>{if(ms>0)timers.push(['setTimeout',ms]);return realSetTimeout(fn,ms,...a)};
  try{
    if(withShareUi)await import(`./share-ui.js?dash=${++instance}`);
    await import(`./home-dashboard.js?instance=${++instance}`);
  }finally{globalThis.setInterval=realSetInterval;globalThis.setTimeout=realSetTimeout}
  await flush();
  return{doc,store,writes,answers,timers,
    section:id=>doc.querySelector(`[data-dash-section="${id}"]`),toggle:id=>doc.querySelector(`[data-dash-toggle="${id}"]`),body:id=>doc.getElementById(`dash-${id}-body`),
    summary:id=>doc.querySelector(`[data-dash-summary="${id}"]`).textContent,
    order:()=>doc.getElementById('dashSections').children.filter(c=>c.nodeType===1).map(c=>c.dataset.dashSection),
    update:contest=>doc.dispatchEvent(new CustomEvent('poolcenter:update',{detail:{contest}})),
    prefs:()=>JSON.parse(store.get(STORAGE_KEY)||'null'),
    panel:()=>doc.getElementById('dashPanel'),customize:()=>doc.querySelector('[data-dash-customize]'),
    text:sel=>doc.querySelector(sel)?.textContent??null,
    shareDialog:()=>doc.body.children.find(n=>n.nodeType===1&&n.localName==='dialog'&&n.classList.contains('share-dialog'))||null};
}
const change=node=>node.dispatchEvent({type:'change',bubbles:true,target:node,defaultPrevented:false,preventDefault(){},stopPropagation(){}});

// ---- The page part.
await check('boot: the default layout on the real Home panel markup, nothing written, no timer started, the Customize button shown, the apps’ elements still in place',async()=>{
  const p=await page();
  assert.deepEqual(p.order(),DEFAULT_ORDER);
  for(const id of ['overview','standings','survivor']){assert.equal(p.body(id).hidden,false,id);assert.equal(p.toggle(id).getAttribute('aria-expanded'),'true',id);assert.equal(p.section(id).classList.contains('is-collapsed'),false,id)}
  for(const id of ['pulse','scenarios','games']){assert.equal(p.body(id).hidden,true,id);assert.equal(p.toggle(id).getAttribute('aria-expanded'),'false',id);assert.equal(p.section(id).classList.contains('is-collapsed'),true,id)}
  assert(DEFAULT_ORDER.every(id=>!p.section(id).hidden),'nothing hidden');
  assert.equal(p.doc.getElementById('dashSections').dataset.dashDensity,'compact');
  assert.equal(p.customize().hidden,false);
  assert.deepEqual(p.writes,[],'nothing is written until a choice is made');
  assert.deepEqual(p.timers,[],'no timer: the apps say when something changed');
  for(const id of ['leaderName','leaderRecord','finals','homeStandings','pulseWeek','entryCount','progressBar','tbNote','scenarioCount','raceList','homeGamePreview'])assert(p.doc.getElementById(id),`#${id} stays for weekly-app.js`);
  assert.equal(p.doc.getElementById('homeStandings').closest('[data-dash-section]').dataset.dashSection,'standings');
  assert.equal(p.doc.getElementById('raceList').closest('[data-dash-section]').dataset.dashSection,'scenarios');
  assert.equal(p.doc.getElementById('homeGamePreview').closest('[data-dash-section]').dataset.dashSection,'games');
  assert.equal(p.doc.getElementById('leaderName').closest('[data-dash-section]').dataset.dashSection,'overview');
});
await check('the Quick Overview and the Survivor Quick View show the snapshots the apps answer with, each contest its own, and follow each app’s poolcenter:update',async()=>{
  const p=await page();
  assert.equal(p.text('[data-dash-contest="pickem"] .dash-status'),'LIVE');
  assert.match(p.text('[data-dash-contest="pickem"] .dash-contest-line'),/^Week 5 · revision 2 · data (just now|\ds ago)$/);
  assert.equal(p.text('[data-dash-contest="pickem"] .dash-contest-facts'),'Leader D.C. 10–2Field 87 entriesGames 12/16 final · 2 live');
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'LIVE');
  assert.match(p.text('[data-dash-contest="survivor"] .dash-contest-line'),/^Week 5 · revision 7 · results (just now|\ds ago)$/);
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-contest-facts'),'Remaining 42 of 120Pending 8DJS OUT');
  assert.deepEqual(DEFAULT_ORDER.map(id=>p.summary(id)),["Pick'em LIVE · Survivor LIVE",'D.C. 10–2','42 of 120 remaining · 8 pending · DJS OUT','12/16 final · 2 live','D.C. ALIVE · JC ALIVE · DJS ALIVE · Thaddeus OUT','KC 17–14 BUF · 3rd 7:41']);
  const sv=p.doc.getElementById('dashSurvivor');
  assert.deepEqual(sv.querySelectorAll('.dash-metric b').map(b=>b.textContent),['120','42','8','50']);
  assert.deepEqual(sv.querySelectorAll('.dash-entrant').map(r=>[r.querySelector('.dash-entrant-name').textContent,r.querySelector('.dash-entrant-pick').textContent,r.querySelector('.status-pill').textContent]),[['D.C.','KC','ALIVE'],['DJS','BUF','OUT'],['Thaddeus','SF','PENDING']]);
  assert.equal(sv.querySelectorAll('.dash-entrant-reason').length,0,'compact: no reasons');
  assert.equal(sv.querySelector('.dash-survivor-status .dash-status').textContent,'LIVE');
  // Survivor publishes a new week: its half moves on, Pick'em keeps its own week and revision.
  p.answers.survivor=()=>survivorFresh({week:6,revision:1,counts:{...survivor().counts,active:30,out:90},tracked:[tracked('D.C.','OUT','KC','KC lost in Week 6'),tracked('DJS','ALIVE','PIT','Alive through Week 6'),tracked('Thaddeus','OUT','SF','SF lost in Week 5')]});
  p.update('survivor');
  assert.match(p.text('[data-dash-contest="survivor"] .dash-contest-line'),/^Week 6 · revision 1/);
  assert.match(p.text('[data-dash-contest="pickem"] .dash-contest-line'),/^Week 5 · revision 2/,"Pick'em keeps its own week");
  assert.equal(p.summary('survivor'),'30 of 120 remaining · 8 pending · DJS ALIVE');
  assert.equal(p.summary('overview'),"Pick'em LIVE · Survivor LIVE");
  assert.deepEqual(sv.querySelectorAll('.dash-entrant .status-pill').map(x=>x.textContent),['OUT','ALIVE','OUT']);
  // Pick'em moves to a later week on its own.
  p.answers.pickem=()=>pickemFresh({week:6,revision:1,games:{total:14,final:0,void:0,live:0,remaining:14},entries:pickem().entries.map((e,i)=>({...e,w:0,l:0,left:14,groupRank:1,leader:true,field:null})),fieldSize:null,spotlight:{away:'DEN',home:'KC',status:'Sun 4:25 PM',live:false,final:false,awayScore:null,homeScore:null}});
  p.update('pickem');
  assert.match(p.text('[data-dash-contest="pickem"] .dash-contest-line'),/^Week 6 · revision 1/);
  assert.equal(p.text('[data-dash-contest="pickem"] .dash-contest-facts'),'Leader D.C. / JC / DJS / Thaddeus 0–0Field not publishedGames 0/14 final');
  assert.deepEqual([p.summary('standings'),p.summary('pulse'),p.summary('games')],['D.C. / JC / DJS / Thaddeus 0–0','0/14 final · 14 left','DEN @ KC · Sun 4:25 PM']);
  assert.match(p.text('[data-dash-contest="survivor"] .dash-contest-line'),/^Week 6 · revision 1/,'Survivor keeps its own');
  p.doc.dispatchEvent(new CustomEvent('poolcenter:update',{detail:{contest:'admin'}}));
  assert.equal(p.summary('standings'),'D.C. / JC / DJS / Thaddeus 0–0','an unknown announcement changes nothing');
});
await check('Survivor failing, not yet loaded or absent leaves the Pick’em sections untouched and never shows unloaded results as zero; Pick’em not ready leaves Survivor’s section untouched',async()=>{
  const p=await page({survivorAnswer:()=>({ready:false,reason:'Survivor results are still loading.'})});
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'LOADING');assert.equal(p.text('[data-dash-contest="survivor"] .dash-contest-note'),'Survivor results are still loading.');
  assert.equal(p.doc.getElementById('dashSurvivor').querySelectorAll('.dash-metric').length,0,'no counts, so no zeros');
  assert.equal(p.text('#dashSurvivor .dash-status'),'LOADING');assert.equal(p.text('#dashSurvivor p'),'Survivor results are still loading.');
  assert.deepEqual([p.summary('overview'),p.summary('survivor'),p.summary('standings')],["Pick'em LIVE · Survivor LOADING",'Loading…','D.C. 10–2']);
  p.answers.survivor=()=>({ready:false,reason:'Survivor results for this week could not be loaded, so there is nothing to share yet.'});p.update('survivor');
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'UNAVAILABLE');assert.equal(p.summary('survivor'),'Unavailable');
  p.answers.survivor=()=>null;p.update('survivor');
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'UNAVAILABLE');assert.match(p.text('#dashSurvivor p'),/^Survivor has not answered/);
  p.answers.survivor=()=>survivorFresh();p.update('survivor');
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'LIVE','Survivor recovers');
  p.answers.survivor=()=>survivorFresh({feed:{at:Date.now()-2000,failed:true,interval:60000}});p.update('survivor');
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'RESULT FEED UNAVAILABLE');
  assert.deepEqual(p.doc.getElementById('dashSurvivor').querySelectorAll('.dash-metric b').map(b=>b.textContent),['120','42','8','50'],'the last verified counts stay, labelled');
  assert.equal(p.text('[data-dash-contest="pickem"] .dash-status'),'LIVE','Pick’em throughout');
  const q=await page({pickemAnswer:()=>({ready:false,reason:'Scores for this week are still loading.'})});
  assert.equal(q.text('[data-dash-contest="pickem"] .dash-status'),'LOADING');
  assert.deepEqual([q.summary('standings'),q.summary('pulse'),q.summary('scenarios'),q.summary('games'),q.summary('survivor')],['Loading…','Loading…','Loading…','Loading…','42 of 120 remaining · 8 pending · DJS OUT']);
  const none=await page({pickemAnswer:()=>null,survivorAnswer:()=>null});
  assert.equal(none.summary('overview'),"Pick'em UNAVAILABLE · Survivor UNAVAILABLE");
  const detail={contest:'pickem',snapshot:null};none.doc.dispatchEvent(new CustomEvent('poolcenter:share',{detail}));
  assert.equal(detail.snapshot,null,'the dashboard never answers a share request itself');
});
await check('the Survivor chip on Home is LIVE within the Home refresh window (90 s at the 60 s interval the snapshot names), DELAYED past it; stale, held and failed states show as such; the Pick’em chip keeps its 30 s limit',async()=>{
  const p=await page({survivorAnswer:()=>survivorFresh({feed:{at:Date.now()-50000,failed:false,interval:60000}})});
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'LIVE');
  p.answers.survivor=()=>survivorFresh({feed:{at:Date.now()-100000,failed:false,interval:60000}});p.update('survivor');
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'DELAYED');assert.match(p.text('[data-dash-contest="survivor"] .dash-contest-note'),/^Results as of /);
  assert.match(p.text('#dashSurvivor .dash-survivor-status'),/^DELAYEDWeek 5 · revision 7 · Results as of .+ · 8 entries pending · results 1m ago$/);
  p.answers.survivor=()=>survivorFresh({publishedStale:true});p.update('survivor');assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'PUBLISHED DATA STALE');
  p.answers.survivor=()=>survivorFresh({hold:true,counts:{active:0,pending:0,out:0,outThisWeek:0,submitted:0,legalPicks:0,awaitingRuling:0,onHold:120},tracked:survivor().tracked.map(t=>({...t,status:'HOLD'}))});p.update('survivor');
  assert.equal(p.text('[data-dash-contest="survivor"] .dash-status'),'ON HOLD');
  assert.deepEqual(p.doc.getElementById('dashSurvivor').querySelectorAll('.dash-entrant .status-pill').map(x=>x.textContent),['HOLD','HOLD','HOLD']);
  p.answers.pickem=()=>pickemFresh({feed:{...pickem().feed,fetchedAt:iso(Date.now()-45000)}});p.update('pickem');
  assert.equal(p.text('[data-dash-contest="pickem"] .dash-status'),'DELAYED');
  p.answers.pickem=()=>pickemFresh({feed:{...pickem().feed,fetchedAt:iso(Date.now()-2000),failed:true}});p.update('pickem');
  assert.equal(p.text('[data-dash-contest="pickem"] .dash-status'),'FEED UNAVAILABLE');assert.equal(p.summary('overview'),"Pick'em FEED UNAVAILABLE · Survivor ON HOLD");
});
await check('a tap on a section header collapses or expands it: presentation only, the apps’ elements stay, a summary shows while collapsed, and the choice is saved under the one versioned key',async()=>{
  const p=await page();
  const t=p.toggle('standings');
  assert.equal(t.localName,'button');assert.equal(t.getAttribute('type'),'button');assert.equal(t.getAttribute('aria-controls'),'dash-standings-body');
  t.click();
  assert.equal(p.body('standings').hidden,true);assert.equal(t.getAttribute('aria-expanded'),'false');assert(p.section('standings').classList.contains('is-collapsed'));
  assert(p.doc.getElementById('homeStandings'),'the standings element stays in the page for weekly-app.js to render into');
  assert.equal(p.summary('standings'),'D.C. 10–2');
  assert.deepEqual(p.prefs(),{version:1,order:DEFAULT_ORDER,hidden:[],collapsed:['standings','pulse','scenarios','games'],density:'compact'});
  t.click();
  assert.equal(p.body('standings').hidden,false);assert.equal(t.getAttribute('aria-expanded'),'true');assert.deepEqual(p.prefs().collapsed,['pulse','scenarios','games']);
  p.toggle('pulse').click();assert.equal(p.body('pulse').hidden,false);assert.deepEqual(p.prefs().collapsed,['scenarios','games']);
  p.toggle('overview').click();assert.equal(p.body('overview').hidden,true);assert.equal(p.summary('overview'),"Pick'em LIVE · Survivor LIVE",'the overview collapsed still says both statuses');
  assert(p.writes.length>=4&&p.writes.every(([k])=>k===STORAGE_KEY),'only the dashboard key is written');assert.equal(p.store.size,1);
  p.answers.survivor=()=>survivorFresh({counts:{...survivor().counts,active:41,out:79}});p.update('survivor');
  assert.equal(p.summary('survivor'),'41 of 120 remaining · 8 pending · DJS OUT','a collapsed or expanded section keeps following the apps');
});
await check('Customize Dashboard: show or hide, expand or collapse, move up or down, density and Restore default layout, each applied at once and saved; the Quick Overview can never be hidden',async()=>{
  const p=await page();
  p.customize().click();
  const panel=p.panel();assert.equal(panel.open,true);assert.equal(panel.getAttribute('aria-labelledby'),'dashPanelTitle');
  const rows=()=>panel.querySelectorAll('[data-dash-row]').map(r=>r.dataset.dashRow),show=id=>panel.querySelector(`[data-dash-show="${id}"]`),expand=id=>panel.querySelector(`[data-dash-expand="${id}"]`),move=(id,dir)=>panel.querySelector(`[data-dash-move="${id}"][data-dash-dir="${dir}"]`);
  assert.deepEqual(rows(),DEFAULT_ORDER);
  assert.deepEqual([show('overview').disabled,show('overview').checked,show('standings').disabled,show('standings').checked],[true,true,false,true]);
  assert.equal(panel.querySelector('label[for="dashShow-overview"]').textContent,'Quick Overview (always shown)');
  assert.deepEqual([move('overview','up').disabled,move('overview','down').disabled,move('games','down').disabled,move('games','up').disabled],[true,false,true,false]);
  assert.deepEqual(['overview','standings','pulse'].map(id=>[expand(id).textContent,expand(id).getAttribute('aria-pressed')]),[['Collapse','true'],['Collapse','true'],['Expand','false']]);
  assert.equal(p.doc.activeElement,show('overview'),'focus moves into the dialog');
  show('pulse').checked=false;change(show('pulse'));
  assert.equal(p.section('pulse').hidden,true);assert.deepEqual(p.prefs().hidden,['pulse']);
  show('pulse').checked=true;change(show('pulse'));
  assert.equal(p.section('pulse').hidden,false);assert.deepEqual(p.prefs().hidden,[]);
  move('survivor','up').click();
  assert.deepEqual(p.order(),['overview','survivor','standings','pulse','scenarios','games']);assert.deepEqual(rows(),p.order());
  assert.equal(p.doc.activeElement,move('survivor','up'),'focus stays on the control after the list re-renders');
  move('survivor','up').click();
  assert.deepEqual(p.order(),['survivor','overview','standings','pulse','scenarios','games']);
  assert.equal(move('survivor','up').disabled,true);assert.equal(p.doc.activeElement,move('survivor','down'),'at the top, focus moves to the other direction');
  assert.deepEqual(p.prefs().order,['survivor','overview','standings','pulse','scenarios','games']);
  move('games','up').click();assert.deepEqual(p.order(),['survivor','overview','standings','pulse','games','scenarios']);
  move('survivor','up').click();assert.deepEqual(p.order(),['survivor','overview','standings','pulse','games','scenarios'],'a disabled move changes nothing');
  expand('standings').click();
  assert.equal(p.body('standings').hidden,true);assert.deepEqual([expand('standings').textContent,expand('standings').getAttribute('aria-pressed')],['Expand','false']);assert.equal(p.doc.activeElement,expand('standings'));
  expand('scenarios').click();assert.equal(p.body('scenarios').hidden,false);assert.deepEqual(p.prefs().collapsed,['standings','pulse','games']);
  const detailed=panel.querySelector('input[name="dashDensity"][value="detailed"]');detailed.checked=true;change(detailed);
  assert.equal(p.doc.getElementById('dashSections').dataset.dashDensity,'detailed');assert.equal(p.prefs().density,'detailed');
  assert.deepEqual(p.doc.getElementById('dashSurvivor').querySelectorAll('.dash-entrant-reason').map(x=>x.textContent),['Alive through Week 5','BUF lost in Week 3','Week 5 game pending']);
  assert.equal(p.text('#dashSurvivor .dash-survivor-note'),'50 submitted · 50 legal picks · 78 out (12 this week)');
  panel.querySelector('[data-dash-reset]').click();
  assert.deepEqual(p.order(),DEFAULT_ORDER);assert.deepEqual(p.prefs(),defaultPreferences());assert.deepEqual(rows(),DEFAULT_ORDER);
  assert.equal(p.doc.getElementById('dashSections').dataset.dashDensity,'compact');assert.equal(p.doc.getElementById('dashSurvivor').querySelectorAll('.dash-entrant-reason').length,0);
  for(const id of ['pulse','scenarios','games'])assert.equal(p.body(id).hidden,true,id);
  assert.equal(panel.querySelector('input[name="dashDensity"][value="compact"]').checked,true);
  panel.querySelector('.dash-panel-actions .share-action.primary').click();
  assert.equal(panel.open,false);assert.equal(p.doc.activeElement,p.customize(),'focus returns to Customize');
});
await check('saved preferences apply on boot; malformed, old or foreign values fall back to the defaults without throwing or rewriting; a browser without storage works for the page and says so in the dialog',async()=>{
  const saved={version:1,order:['survivor','games','overview','standings','pulse','scenarios'],hidden:['pulse'],collapsed:['overview'],density:'detailed'};
  const p=await page({stored:saved});
  assert.deepEqual(p.order(),saved.order);assert.equal(p.section('pulse').hidden,true);assert.equal(p.body('overview').hidden,true);assert.equal(p.body('games').hidden,false);
  assert.equal(p.doc.getElementById('dashSections').dataset.dashDensity,'detailed');assert.equal(p.doc.getElementById('dashSurvivor').querySelectorAll('.dash-entrant-reason').length,3);
  assert.deepEqual(p.writes,[]);
  for(const [label,stored,order] of [['malformed JSON','{not json',DEFAULT_ORDER],['an older version',{version:0,order:['games']},DEFAULT_ORDER],['a foreign shape',[1,2,3],DEFAULT_ORDER],['a string',JSON.stringify('games'),DEFAULT_ORDER],
      ['unknown sections and a hidden required section',{version:1,order:['bogus','games'],hidden:['overview','nope'],collapsed:['overview','nope'],density:'huge'},['games','overview','standings','survivor','pulse','scenarios']]]){
    const q=await page({stored});
    assert.deepEqual(q.order(),order,label);
    assert.equal(q.section('overview').hidden,false,`${label}: the required section stays`);
    assert.deepEqual(q.writes,[],`${label}: nothing is rewritten until a choice is made`);assert.equal(q.store.get(STORAGE_KEY),typeof stored==='string'?stored:JSON.stringify(stored),`${label}: the stored value is left alone`);
    q.toggle('standings').click();assert.equal(q.body('standings').hidden,true,`${label}: the page works`);
    assert.deepEqual(q.prefs().order,order,`${label}: the first choice saves a valid set`);
  }
  const absent=await page({storage:'absent'});
  absent.toggle('standings').click();assert.equal(absent.body('standings').hidden,true);
  absent.customize().click();assert.equal(absent.doc.getElementById('dashPanelStorage').hidden,false);assert.match(absent.text('#dashPanelStorage'),/^Preferences could not be saved in this browser/);
  const denied=await page({storage:'throws'});
  denied.toggle('standings').click();assert.equal(denied.body('standings').hidden,true);
  denied.customize().click();assert.equal(denied.doc.getElementById('dashPanelStorage').hidden,false);
  const ok=await page();ok.toggle('standings').click();ok.customize().click();assert.equal(ok.doc.getElementById('dashPanelStorage').hidden,true);
});
await check('mobile accessibility: every control is a native button or input with a name, each toggle says what it controls and whether it is expanded, move buttons are labelled, the dialog is labelled and closes from its header, its Done button and a tap on the backdrop',async()=>{
  const p=await page();
  for(const id of DEFAULT_ORDER){
    const t=p.toggle(id),title=t.querySelector('.dash-title');
    assert.equal(t.localName,'button',id);assert(title.textContent.length>0,`${id} has a visible title`);
    assert.equal(t.getAttribute('aria-controls'),`dash-${id}-body`);assert(['true','false'].includes(t.getAttribute('aria-expanded')));
    assert.equal(p.section(id).getAttribute('aria-labelledby'),title.id,`${id} is labelled by its title`);
    assert.equal(p.body(id).id,`dash-${id}-body`);
  }
  assert.equal(p.customize().getAttribute('aria-haspopup'),'dialog');
  p.customize().click();const panel=p.panel();
  for(const b of panel.querySelectorAll('[data-dash-move]')){assert.equal(b.localName,'button');assert.match(b.getAttribute('aria-label'),/^Move .+ (up|down)$/)}
  for(const b of panel.querySelectorAll('[data-dash-expand]')){assert.equal(b.localName,'button');assert.match(b.getAttribute('aria-label'),/^(Expand|Collapse) .+$/)}
  for(const c of panel.querySelectorAll('[data-dash-show]')){assert.equal(c.getAttribute('type'),'checkbox');assert(panel.querySelector(`label[for="${c.id}"]`).textContent.length>0,c.id)}
  panel.querySelector('.dash-panel-head [data-dash-close]').click();assert.equal(panel.open,false);
  p.customize().click();assert.equal(panel.open,true);panel.querySelector('.dash-panel-actions [data-dash-close]').click();assert.equal(panel.open,false);
  p.customize().click();panel.dispatchEvent({type:'click',bubbles:true,target:panel,defaultPrevented:false,preventDefault(){},stopPropagation(){}});assert.equal(panel.open,false,'a tap on the backdrop closes');
});
await check('the Home share menu runs through share-ui.js: each contest’s own card, the combined card and Copy dashboard link work from Home without leaving it; choosing a card closes the menu, as do Escape and a tap elsewhere',async()=>{
  const p=await page({withShareUi:true});
  const menu=p.doc.querySelector('.dash-share-menu'),buttons=p.doc.querySelectorAll('.dash-share-popover [data-share-card]');
  assert.deepEqual(buttons.map(b=>[b.dataset.shareCard,b.hidden]),[['dashboard',false],['pickem',false],['survivor',false]]);
  assert.equal(p.doc.querySelector('[data-share-link]').hidden,false);
  menu.setAttribute('open','');buttons[1].click();await flush();
  const dialog=p.shareDialog();
  assert(dialog&&dialog.open,'the preview dialog opens');assert.equal(dialog.querySelector('#shareTitle').textContent,"Share Pick'em standings");
  assert.equal(dialog.querySelector('.share-image').hidden,false);
  assert.equal(menu.hasAttribute('open'),false,'the menu closes');assert.equal(p.doc.body.dataset.view,'home','still on Home');
  dialog.close();
  menu.setAttribute('open','');buttons[2].click();await flush();
  assert.equal(dialog.querySelector('#shareTitle').textContent,'Share Survivor results');assert.equal(dialog.querySelector('.share-image').hidden,false);dialog.close();
  menu.setAttribute('open','');buttons[0].click();await flush();
  assert.equal(dialog.querySelector('#shareTitle').textContent,'Share combined dashboard card');
  assert.match(dialog.querySelector('.share-image').alt,/^Weekly Dashboard card, 2026: Pick'em Week 5 LIVE, D\.C\. 10–2 first of the tracked group; Survivor Week 5 LIVE, 42 of 120 entries remaining\.$/);
  dialog.close();
  p.doc.querySelector('[data-share-link]').click();await flush();
  assert.equal(p.text('[data-share-link-status]'),'Couldn’t copy automatically. Press and hold to copy the link:\nhttps://example.test/nfl-pool/?view=home&season=2026&week=5&sw=5','no clipboard here: the link itself is shown');
  assert.equal(p.shareDialog().open,false,'Copy dashboard link opens no preview');
  menu.setAttribute('open','');p.doc.dispatchEvent({type:'keydown',key:'Escape'});assert.equal(menu.hasAttribute('open'),false,'Escape closes the menu');
  menu.setAttribute('open','');p.toggle('standings').click();assert.equal(menu.hasAttribute('open'),false,'a tap elsewhere closes the menu');
  menu.setAttribute('open','');p.doc.querySelector('[data-share-link]').click();await flush();assert.equal(menu.hasAttribute('open'),true,'Copy dashboard link keeps the menu open for its status line');
});
await check('a hidden or collapsed section never stops a card: sharing reads the apps, not the dashboard; a contest that is not ready refuses only the cards that need it',async()=>{
  const p=await page({withShareUi:true,stored:{version:1,order:DEFAULT_ORDER,hidden:['survivor','standings'],collapsed:DEFAULT_ORDER,density:'compact'}});
  assert.equal(p.section('survivor').hidden,true);assert.equal(p.body('overview').hidden,true);
  const card=sel=>p.doc.querySelector(`.dash-share-popover [data-share-card="${sel}"]`);
  card('survivor').click();await flush();
  const dialog=p.shareDialog();assert.equal(dialog.querySelector('.share-image').hidden,false,'the Survivor card from a hidden section');dialog.close();
  card('dashboard').click();await flush();assert.equal(dialog.querySelector('.share-image').hidden,false,'the combined card with everything collapsed');dialog.close();
  p.answers.survivor=()=>({ready:false,reason:'Survivor results are still loading.'});p.update('survivor');
  card('dashboard').click();await flush();
  assert.equal(dialog.querySelector('.share-placeholder').textContent,"Survivor results are still loading. The combined card needs both contests; Pick'em standings can be shared on their own meanwhile.");
  assert.equal(dialog.querySelector('.share-actions').hidden,true);dialog.close();
  card('pickem').click();await flush();assert.equal(dialog.querySelector('.share-image').hidden,false,"Pick'em alone still shares");dialog.close();
});

assert.equal(failures.length,0,`Home dashboard regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
console.log('Home dashboard regressions passed: default layout, validated and restored preferences (corrupt, old and absent storage included), expand and collapse, show and hide, reordering, density, independent contest statuses and summaries from the apps’ snapshots, Survivor freshness on Home, feed failure and recovery, no timers, accessibility, and the Home share menu through share-ui.js');
