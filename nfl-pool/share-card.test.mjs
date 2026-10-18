// Shareable Cards V1 regressions: the card models (share-card.js), the Canvas renderer on a recording context, the
// snapshots weekly-app.js and survivor-app.js answer with, and the share sheet (share-sheet.js) on a small fake DOM.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARD_WIDTH,CARD_HEIGHT,PUBLIC_URL,SITE_LABEL,LIVE_FRESH_MS,FINAL_FRESH_MS,pickemCard,survivorCard,pickemStatus,survivorStatus,deepLink,formatStamp,drawShareCard,fitText} from './share-card.js';

const failures=[],nativeFetch=globalThis.fetch;
const test=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: ${error?.stack||error}`)}};
const flush=async(n=24)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};
const NOW=Date.parse('2026-10-18T16:05:00Z'),TZ='America/New_York';
const at=ms=>new Date(ms).toISOString();

// ---- Synthetic snapshots shaped exactly as the apps answer (weekly-app.js / survivor-app.js shareSnapshot). The values
// follow the 2026 Week 5 reference: DJS leads, JC and Thaddeus tie for second, D.C. trails; 281 Pick'em and 247 Survivor
// entries, two separate fields.
const pickem=(o={})=>({contest:'pickem',season:2026,week:5,revision:1,publishedAt:'2026-10-11T17:47:50.49+00:00',scoresAt:at(NOW-5000),scoresFailed:false,hold:null,rulingsStale:false,
  publicationStale:null,warnings:0,underReview:0,games:{total:14,final:14,void:0,live:0,remaining:0},tiebreak:{final:true,void:false},fieldSize:281,
  entries:[{name:'DJS',rank:1,w:8,l:6,left:0,noSubmission:false,fieldRank:'T-132',tied:false},{name:'JC',rank:2,w:8,l:6,left:0,noSubmission:false,fieldRank:'T-153',tied:true},
    {name:'Thaddeus',rank:2,w:8,l:6,left:0,noSubmission:false,fieldRank:'T-153',tied:true},{name:'D.C.',rank:4,w:6,l:8,left:0,noSubmission:false,fieldRank:'T-257',tied:false}],...o});
const survivor=(o={})=>({contest:'survivor',season:2026,week:5,revision:1,publishedAt:'2026-10-11T17:49:40.715+00:00',scoresAt:at(NOW-5000),scoresFailed:false,hold:null,rulingsStale:false,
  publicationStale:null,flags:[],awaitingRuling:0,onHold:0,unresolvedPrior:0,awaitingRulingPrior:0,onHoldPrior:0,totals:{field:247,remaining:52,submissions:77,pending:0},
  entries:[{name:'D.C.',status:'OUT',eliminatedWeek:5,reason:'DAL lost in Week 5',underReview:false,order:0},{name:'DJS',status:'ALIVE',eliminatedWeek:null,reason:'Alive through Week 5',underReview:false,order:1},
    {name:'Thaddeus',status:'OUT',eliminatedWeek:1,reason:'LAC lost in Week 1',underReview:false,order:2}],...o});
const opts={now:NOW,timeZone:TZ};

await test("Pick'em card: the Week 5 reference, with JC and Thaddeus tied for second",()=>{
  const card=pickemCard(pickem(),opts);
  assert.equal(card.ok,true);
  assert.equal(card.title.join(' ').replace('’',"'"),"PICK'EM STANDINGS",'the title reads PICK\'EM STANDINGS');
  assert.deepEqual(card.rows.map(r=>[r.place,r.name,r.record,r.rank,r.leader]),[['1ST','DJS','8–6','T-132',true],['T-2','JC','8–6','T-153',false],['T-2','Thaddeus','8–6','T-153',false],['4','D.C.','6–8','T-257',false]]);
  assert.deepEqual(card.total,{label:'TOTAL POOL ENTRIES:',value:'281'});
  assert.equal(card.status.key,'final');assert.equal(card.status.label,'FINAL');assert.equal(card.status.detail,null);
  assert.equal(card.url,'https://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=5');
  assert.equal(card.urlLabel,SITE_LABEL);assert.equal(card.filename,'pool-center-pickem-2026-week-5.png');
  assert.equal(card.meta,'SNAPSHOT OCT 18, 2026 · 12:05 PM EDT · REVISION 1');
  assert.equal(card.text,["Pool Center · Pick'em Standings",'2026 Week 5 · FINAL','1ST  DJS  8–6  · field T-132','T-2  JC  8–6  · field T-153','T-2  Thaddeus  8–6  · field T-153','4  D.C.  6–8  · field T-257',
    'Total pool entries: 281','Snapshot Oct 18, 2026 · 12:05 PM EDT · revision 1','https://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=5'].join('\n'));
  assert.match(card.alt,/^Pick'em standings card, 2026 Week 5, FINAL\. 1ST DJS 8–6, field rank T-132; T-2 JC 8–6, field rank T-153; T-2 Thaddeus 8–6, field rank T-153; 4 D\.C\. 6–8, field rank T-257\. Total pool entries 281\.$/);
  assert(card.text.split('\n').includes('T-2  Thaddeus  8–6  · field T-153')&&!/^3\b.*Thaddeus/m.test(card.text),'Thaddeus ties JC for second and is never placed third');
});
await test("Pick'em card: every value comes from the snapshot",()=>{
  const card=pickemCard(pickem({week:4,revision:3,fieldSize:279,entries:[{name:'JC',rank:1,w:11,l:4,left:0,noSubmission:false,fieldRank:'T-49',tied:false},{name:'Thaddeus',rank:2,w:9,l:6,left:0,noSubmission:false,fieldRank:'T-138',tied:false},
    {name:'D.C.',rank:3,w:9,l:6,left:0,noSubmission:false,fieldRank:'T-169',tied:false},{name:'DJS',rank:4,w:8,l:7,left:0,noSubmission:false,fieldRank:'T-210',tied:false}],games:{total:15,final:15,void:0,live:0,remaining:0}}),opts);
  assert.deepEqual(card.rows.map(r=>[r.place,r.name,r.record,r.rank]),[['1ST','JC','11–4','T-49'],['2','Thaddeus','9–6','T-138'],['3','D.C.','9–6','T-169'],['4','DJS','8–7','T-210']]);
  assert.equal(card.total.value,'279');assert.equal(card.week,4);assert.equal(card.revision,3);
  assert.equal(card.url,deepLink('pickem',2026,4));assert.match(card.meta,/REVISION 3$/);
  const all=JSON.stringify(card);
  for(const sample of ['281','T-132','T-153','T-257','DJS  8–6'])assert(!all.includes(sample),`no Week 5 value (${sample}) survives into Week 4`);
});
await test("Pick'em card: gold marks leaders only while someone trails them",()=>{
  const level=pickemCard(pickem({games:{total:13,final:0,void:0,live:1,remaining:13},tiebreak:{final:false,void:false},fieldSize:276,entries:['D.C.','JC','DJS','Thaddeus'].map(name=>({name,rank:1,w:0,l:0,left:13,noSubmission:name==='Thaddeus',fieldRank:'T-1',tied:true}))}),opts);
  assert.deepEqual(level.rows.map(r=>[r.place,r.leader,r.note]),[['T-1',false,null],['T-1',false,null],['T-1',false,null],['T-1',false,'NO PICKS SUBMITTED']]);
  assert.equal(level.status.key,'live');assert.equal(level.status.detail,'0 OF 13 GAMES FINAL · 1 LIVE');
  const tiedLead=pickemCard(pickem({entries:[{name:'A',rank:1,w:9,l:5,left:0,fieldRank:'T-3',tied:true},{name:'B',rank:1,w:9,l:5,left:0,fieldRank:'T-3',tied:true},{name:'C',rank:3,w:7,l:7,left:0,fieldRank:'#90',tied:false}]}),opts);
  assert.deepEqual(tiedLead.rows.map(r=>[r.place,r.leader]),[['T-1',true],['T-1',true],['3',false]]);
});
await test("Pick'em card: no full-field data means no ranks and no pool total, never a guessed one",()=>{
  const card=pickemCard(pickem({fieldSize:null,entries:pickem().entries.map(e=>({...e,fieldRank:null}))}),opts);
  assert(card.rows.every(r=>r.rank===null));assert.equal(card.total,null);assert.equal(card.fieldNote,'FULL-FIELD RANKS UNAVAILABLE FOR THIS WEEK');
  assert.match(card.text,/Full-field ranks unavailable for this week/);assert(!/Total pool entries/.test(card.text));
});
await test("Pick'em status: unavailable states make no card, every other state is labeled",()=>{
  for(const [snapshot,reason] of [[null,/have not loaded yet/],[undefined,/have not loaded yet/],[pickem({hold:'ruling data unavailable'}),/on hold \(ruling data unavailable\)/],
    [pickem({scoresAt:null}),/still loading/],[pickem({scoresAt:null,scoresFailed:true}),/could not be loaded yet/],[pickem({entries:[]}),/No tracked entries/],[pickem({week:0}),/have not loaded yet/],[survivor(),/have not loaded yet/]]){
    const card=pickemCard(snapshot,opts);assert.equal(card.ok,false);assert.match(card.reason,reason);
    assert.throws(()=>drawShareCard(mockContext(),card),/Only a ready share card/);
  }
  const label=o=>{const s=pickemStatus(pickem(o),NOW,TZ);return[s.label,s.detail]};
  assert.deepEqual(label({publicationStale:'the published week list could not be checked'}),['STALE','PUBLISHED DATA STALE']);
  assert.deepEqual(label({scoresFailed:true,warnings:2}),['STALE','SCORE FEED UNAVAILABLE'],'STALE outranks PROVISIONAL');
  assert.deepEqual(label({warnings:1}),['PROVISIONAL','1 FEED WARNING']);
  assert.deepEqual(label({warnings:2,underReview:1,rulingsStale:true}),['PROVISIONAL','2 FEED WARNINGS · 1 RULING UNDER REVIEW · RULINGS STALE']);
  assert.deepEqual(label({games:{total:14,final:9,void:1,live:3,remaining:4},warnings:1}),['PROVISIONAL','1 FEED WARNING · 9 OF 14 GAMES FINAL · 3 LIVE · 1 GAME VOID BY RULING']);
  assert.deepEqual(label({games:{total:14,final:13,void:1,live:0,remaining:0},tiebreak:{final:false,void:true}}),['FINAL','1 GAME VOID BY RULING · NO TIEBREAK THIS WEEK']);
  // Data age: as the page header, a live week is DELAYED after 30 s; a resolved week after 5 minutes without re-verification.
  const live={games:{total:14,final:6,void:0,live:2,remaining:8}};
  assert.equal(pickemStatus(pickem({...live,scoresAt:at(NOW-LIVE_FRESH_MS)}),NOW,TZ).label,'LIVE');
  assert.deepEqual([pickemStatus(pickem({...live,scoresAt:at(NOW-LIVE_FRESH_MS-1000)}),NOW,TZ)].map(s=>[s.label,s.detail])[0],['DELAYED','SCORES LAST VERIFIED 12:04 PM EDT · 6 OF 14 GAMES FINAL · 2 LIVE']);
  assert.equal(pickemStatus(pickem({scoresAt:at(NOW-FINAL_FRESH_MS)}),NOW,TZ).label,'FINAL');
  assert.equal(pickemStatus(pickem({scoresAt:at(NOW-FINAL_FRESH_MS-1000)}),NOW,TZ).label,'DELAYED');
  assert.equal(pickemStatus(pickem({scoresAt:'not a time'}),NOW,TZ).detail,'SCORE AGE UNKNOWN');
});
await test('Survivor card: the Week 5 reference, with its own field and ALIVE in green',()=>{
  const card=survivorCard(survivor(),opts);
  assert.equal(card.ok,true);assert.deepEqual(card.title,['SURVIVOR POOL']);
  assert.deepEqual(card.metrics.map(m=>[m.label,m.value]),[['TOTAL FIELD:','247'],['REMAINING:','52'],['SUBMISSIONS:','77'],['PENDING:','0']]);
  assert.deepEqual(card.rows.map(r=>[r.name,r.status,r.tone]),[['DJS','ALIVE','alive'],['D.C.','OUT','out'],['Thaddeus','OUT','out']],'entries still in play lead, then the longest survivor');
  assert(!('leader' in card.rows[0]),'no Survivor row is styled as an overall leader');
  assert.deepEqual(card.total,{label:'TOTAL SURVIVOR ENTRIES:',value:'247'});
  assert.equal(card.status.label,'FINAL');assert.equal(card.status.tone,'final');
  assert.equal(card.url,'https://r88510179-collab.github.io/nfl-pool/?view=survivor&season=2026&sw=5');assert.equal(card.filename,'pool-center-survivor-2026-week-5.png');
  assert.equal(card.text,['Pool Center · Survivor Pool','2026 Week 5 · FINAL','Total field 247 · Remaining 52 · Submissions 77 · Pending 0','DJS: ALIVE · Alive through Week 5','D.C.: OUT · DAL lost in Week 5',
    'Thaddeus: OUT · LAC lost in Week 1','Snapshot Oct 18, 2026 · 12:05 PM EDT · revision 1','https://r88510179-collab.github.io/nfl-pool/?view=survivor&season=2026&sw=5'].join('\n'));
  assert(!JSON.stringify(card).includes('281'),'the Pick\'em pool size never appears on the Survivor card');
  assert(!JSON.stringify(pickemCard(pickem(),opts)).includes('247'),'the Survivor field never appears on the Pick\'em card');
});
await test('Survivor status: provisional, live, stale and unavailable states',()=>{
  const label=o=>{const s=survivorStatus(survivor(o),NOW,TZ);return[s.label,s.detail]};
  assert.deepEqual(label({totals:{field:247,remaining:51,submissions:52,pending:51}}),['LIVE',null]);
  assert.deepEqual(label({flags:['2 TEAM RESULTS UNVERIFIED'],awaitingRuling:1,onHold:2,rulingsStale:true}),['PROVISIONAL','2 TEAM RESULTS UNVERIFIED · 1 ENTRY AWAITING RULING · 2 ENTRIES ON HOLD · RULINGS STALE']);
  assert.deepEqual(label({unresolvedPrior:3,awaitingRulingPrior:1,onHoldPrior:1}),['PROVISIONAL','3 ENTRIES AWAITING AN EARLIER RESULT · 1 ENTRY AWAITING AN EARLIER RULING · 1 ENTRY ON HOLD IN AN EARLIER WEEK']);
  assert.deepEqual(label({publicationStale:'x',scoresFailed:true}),['STALE','PUBLISHED DATA STALE · RESULT FEED UNAVAILABLE']);
  for(const [snapshot,reason] of [[survivor({hold:'ruling data unavailable'}),/on hold/],[survivor({scoresAt:null}),/still loading/],[survivor({totals:null}),/No tracked Survivor entries/],[pickem(),/have not loaded yet/],[null,/have not loaded yet/]])
    assert.match(survivorCard(snapshot,opts).reason,reason);
  const sorted=survivorCard(survivor({entries:[{name:'A',status:'OUT',eliminatedWeek:2,reason:'',order:0},{name:'B',status:'PENDING',eliminatedWeek:null,reason:'Week 5 game pending',order:1},
    {name:'C',status:'OUT',eliminatedWeek:4,reason:'',order:2},{name:'D',status:'ALIVE',eliminatedWeek:null,reason:'',order:3},{name:'E',status:'RULING',eliminatedWeek:null,reason:'',underReview:true,order:4}]}),opts);
  assert.deepEqual(sorted.rows.map(r=>[r.name,r.tone]),[['D','alive'],['B','pending'],['E','pending'],['C','out'],['A','out']]);
  assert.deepEqual(sorted.rows.map(r=>r.note),[null,'Week 5 game pending','under review',null,null]);
});
await test('Deep links, stamps and the public address',()=>{
  assert.equal(PUBLIC_URL,'https://r88510179-collab.github.io/nfl-pool/');assert.equal(SITE_LABEL,'r88510179-collab.github.io/nfl-pool');
  assert.equal(deepLink('pickem',2026,6),'https://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=6');
  assert.equal(deepLink('survivor',2027,1),'https://r88510179-collab.github.io/nfl-pool/?view=survivor&season=2027&sw=1');
  assert.equal(formatStamp(Date.parse('2026-10-12T03:30:00Z'),TZ),'Oct 11, 2026 · 11:30 PM EDT');
  for(const card of [pickemCard(pickem(),opts),survivorCard(survivor(),opts)])assert(!/nflpoolcenter/i.test(JSON.stringify(card)),'no invented domain');
});

// ---- The renderer, on a context that records every call and measures text with a stand-in font (wide or narrow).
function mockContext({factor=1}={}){
  const calls=[],texts=[],stack=[];let m=[1,0,0,1,0,0];
  const state={font:'10px sans-serif',letterSpacing:'0px',fontStretch:'normal',fillStyle:'#000',strokeStyle:'#000',lineWidth:1,textAlign:'start',textBaseline:'alphabetic',shadowColor:'transparent',
    shadowBlur:0,shadowOffsetX:0,shadowOffsetY:0,globalAlpha:1,globalCompositeOperation:'source-over',lineJoin:'miter',lineCap:'butt'};
  const charWidth=c=>/[WM@]/.test(c)?0.95:/[A-Z0-9#]/.test(c)?0.68:/[il.,'’:;!| ]/.test(c)?0.3:/[–—…•]/.test(c)?0.7:0.56;
  const size=()=>Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1]||10),spacing=()=>Number(String(state.letterSpacing).replace('px',''))||0;
  const measure=text=>[...String(text)].reduce((w,c)=>w+charWidth(c)*size()*factor+spacing(),0);
  const gradient=()=>({addColorStop(o,c){assert(o>=0&&o<=1,`gradient stop ${o}`);assert.equal(typeof c,'string')}});
  const record=(kind,text,x,y)=>{
    const ax=m[0]*x+m[2]*y+m[4],ay=m[1]*x+m[3]*y+m[5],w=measure(text)*m[0];
    const left=state.textAlign==='center'?ax-w/2:state.textAlign==='right'||state.textAlign==='end'?ax-w:ax;
    texts.push({kind,text:String(text),left,right:left+w,y:ay,size:size()*m[3]});calls.push([kind,String(text)]);
  };
  const ctx={...state,calls,texts,
    save(){stack.push({m:m.slice(),state:Object.fromEntries(Object.keys(state).map(k=>[k,ctx[k]]))});calls.push(['save'])},
    restore(){const s=stack.pop();assert(s,'restore without save');m=s.m;Object.assign(ctx,s.state);Object.assign(state,s.state);calls.push(['restore'])},
    translate(x,y){m[4]+=m[0]*x+m[2]*y;m[5]+=m[1]*x+m[3]*y;calls.push(['translate',x,y])},
    scale(x,y){assert(x>0&&y>0,`scale ${x},${y} must keep text upright and unmirrored`);m[0]*=x;m[1]*=x;m[2]*=y;m[3]*=y;calls.push(['scale',x,y])},
    measureText(text){return{width:measure(text)}},
    fillText(text,x,y){Object.assign(state,{font:ctx.font,letterSpacing:ctx.letterSpacing,textAlign:ctx.textAlign});record('fill',text,x,y)},
    strokeText(text,x,y){Object.assign(state,{font:ctx.font,letterSpacing:ctx.letterSpacing,textAlign:ctx.textAlign});record('stroke',text,x,y)},
    createLinearGradient:gradient,createRadialGradient:gradient
  };
  for(const name of ['fillRect','clearRect','strokeRect','beginPath','moveTo','lineTo','arc','arcTo','rect','closePath','fill','stroke','clip'])ctx[name]=(...a)=>{calls.push([name,...a.map(v=>typeof v==='number'?Math.round(v*100)/100:typeof v)])};
  // measureText reads the font through the shared state, so keep it in step with the context's own properties.
  return new Proxy(ctx,{set(t,k,v){t[k]=v;if(k in state)state[k]=v;return true}});
}
globalThis.Path2D=class{constructor(d){this.d=d}};
function assertLayout(L,ctx,label){
  for(const t of L.texts){
    if(t.box)assert(t.x>=t.box[0]-0.5&&t.x+t.width<=t.box[1]+0.5,`${label}: "${t.text}" (${t.role}) is ${t.width.toFixed(1)} wide at ${t.x.toFixed(1)} but its box is ${t.box.map(v=>v.toFixed(1)).join('–')}`);
    assert(t.x>=0&&t.x+t.width<=CARD_WIDTH&&t.top>=0&&t.bottom<=CARD_HEIGHT,`${label}: "${t.text}" leaves the card`);
  }
  for(const t of ctx.texts)assert(t.left>=-0.5&&t.right<=CARD_WIDTH+0.5&&t.y-t.size*0.8>=0&&t.y+t.size*0.25<=CARD_HEIGHT,`${label}: drawn "${t.text}" at ${t.left.toFixed(1)}–${t.right.toFixed(1)}, ${t.y.toFixed(1)} leaves the canvas`);
  const rows=L.boxes.filter(b=>b.role==='row').sort((a,b)=>a.y-b.y);
  rows.forEach((b,i)=>{assert(b.x>=0&&b.x+b.w<=CARD_WIDTH&&b.y>=0&&b.y+b.h<=CARD_HEIGHT,`${label}: row ${i+1} leaves the card`);if(i)assert(rows[i-1].y+rows[i-1].h<=b.y,`${label}: rows ${i} and ${i+1} overlap`)});
  const status=L.texts.filter(t=>t.role==='status'||t.role==='status-pill'||t.role==='detail'),footer=L.texts.filter(t=>t.role==='total'||t.role==='total-value');
  if(rows.length&&status.length)assert(rows[0].y>=Math.max(...status.map(t=>t.bottom))-2,`${label}: the rows start below the status line`);
  if(rows.length&&footer.length)assert(rows.at(-1).y+rows.at(-1).h<=Math.min(...footer.map(t=>t.top))+2,`${label}: the rows end above the total`);
  return rows;
}
const drawn=ctx=>ctx.texts.filter(t=>t.kind==='fill').map(t=>t.text);
await test('Renderer: both cards draw at 1080 × 1350 with nothing clipped, in a wide and a narrow font',()=>{
  assert.equal(CARD_WIDTH,1080);assert.equal(CARD_HEIGHT,1350);
  for(const factor of [0.72,1,1.3]){
    const p=mockContext({factor}),pl=drawShareCard(p,pickemCard(pickem(),opts));
    assert.equal(assertLayout(pl,p,`pickem ×${factor}`).length,4,'four Pick\'em rows');
    const s=mockContext({factor}),sl=drawShareCard(s,survivorCard(survivor(),opts));
    assert.equal(assertLayout(sl,s,`survivor ×${factor}`).length,3,'three Survivor rows');
    assert.equal(sl.boxes.filter(b=>b.role==='metric').length,4,'four Survivor metric panels');
  }
});
await test('Renderer: the drawn text is the card\'s, with none of the reference artwork\'s errors',()=>{
  const p=mockContext();drawShareCard(p,pickemCard(pickem(),opts));const pt=drawn(p);
  for(const text of ['POOL CENTER','SEASON 2026 • WEEK 5 FINAL','1ST','DJS','8–6','T-132','T-2','JC','Thaddeus','T-153','4','D.C.','6–8','T-257','FIELD RANK','TOTAL POOL ENTRIES: ','281',SITE_LABEL,'SNAPSHOT OCT 18, 2026 · 12:05 PM EDT · REVISION 1'])
    assert(pt.includes(text),`Pick'em card draws "${text}"`);
  assert(p.texts.some(t=>t.kind==='stroke'&&t.text==='PICK’EM')&&p.texts.some(t=>t.kind==='stroke'&&t.text==='STANDINGS'),'the title is drawn as PICK\'EM STANDINGS');
  for(const wrong of ['3','3.','NFLPOOLCENTER.COM','NFL POOL CENTER'])assert(!pt.includes(wrong),`Pick'em card never draws "${wrong}"`);
  const s=mockContext();drawShareCard(s,survivorCard(survivor(),opts));const st=drawn(s);
  for(const text of ['SURVIVOR POOL','SEASON 2026 • WEEK 5','FINAL','TOTAL FIELD:','247','REMAINING:','52','SUBMISSIONS:','77','PENDING:','0','DJS','ALIVE','D.C.','OUT','Thaddeus','TOTAL SURVIVOR ENTRIES: ',SITE_LABEL])
    assert(st.includes(text)||s.texts.some(t=>t.text===text),`Survivor card draws "${text}"`);
  assert(!st.includes('281')&&!st.some(t=>/NFLPOOLCENTER/i.test(t)),'the Survivor card never draws the Pick\'em pool size or an invented domain');
});
await test('Renderer: long names, more rows and every status still fit',()=>{
  const long='Bartholomew Montgomery-Fitzgerald the Third';let shortened=0;
  for(const n of [2,3,4,5,6,8,11]){
    const entries=Array.from({length:n},(_,i)=>({name:i===1?long:`Entry ${i+1}`,rank:i<2?1:i+1,w:20-i,l:i,left:1,noSubmission:i===n-1,fieldRank:i<2?'T-1':`#${1000+i}`,tied:i<2}));
    const card=pickemCard(pickem({entries,fieldSize:9999,warnings:3,games:{total:16,final:9,void:1,live:3,remaining:6}}),opts);
    assert.equal(card.rows.length,Math.min(n,8));assert.equal(card.more,Math.max(0,n-8));
    for(const factor of [0.8,1.3]){
      const ctx=mockContext({factor}),L=drawShareCard(ctx,card);assert.equal(assertLayout(L,ctx,`${n} rows ×${factor}`).length,card.rows.length);
      const name=L.texts.filter(t=>t.role==='name')[1];
      assert(name.text===long||name.truncated&&name.text.endsWith('…')&&long.startsWith(name.text.slice(0,-1)),`${n} rows ×${factor}: the long name is drawn whole or shortened with an ellipsis`);
      if(name.truncated)shortened++;
    }
  }
  assert(shortened>0,'a name too long for its row is shortened rather than clipped');
  for(const status of [{publicationStale:'x'},{scoresFailed:true},{warnings:9},{scoresAt:at(NOW-60000),games:{total:14,final:3,void:0,live:4,remaining:11}}]){
    const ctx=mockContext({factor:1.3});assertLayout(drawShareCard(ctx,pickemCard(pickem(status),opts)),ctx,JSON.stringify(status));
    const sctx=mockContext({factor:1.3});assertLayout(drawShareCard(sctx,survivorCard(survivor({...status,flags:['12 TEAM RESULTS UNVERIFIED'],totals:{field:12470,remaining:9352,submissions:11077,pending:812},
      entries:[{name:long,status:'RULING',eliminatedWeek:null,reason:'Week 5 DAL game halted (STATUS_POSTPONED): awaiting pool ruling',underReview:true,order:0}]}),opts)),sctx,`survivor ${JSON.stringify(status)}`);
  }
});
await test('Renderer: text fitting squeezes, then shrinks, then shortens, and never mirrors or overflows',()=>{
  const ctx=mockContext();
  assert.deepEqual((({text,size,scale})=>({text,size,scale}))(fitText(ctx,'DJS',{size:60,width:400})),{text:'DJS',size:60,scale:1},'text that fits is drawn as it is');
  const squeezed=fitText(ctx,'THADDEUS',{size:60,width:300});assert(squeezed.size===60&&squeezed.scale<1&&squeezed.scale>=0.84&&squeezed.width<=300,'a little too wide: squeezed at full size');
  const smaller=fitText(ctx,'THADDEUS',{size:60,width:200});assert(smaller.size<60&&smaller.width<=200&&!smaller.truncated,'too wide to squeeze: set smaller');
  const shortened=fitText(ctx,'BARTHOLOMEW MONTGOMERY-FITZGERALD',{size:60,min:40,width:220});assert(shortened.truncated&&shortened.text.endsWith('…')&&shortened.size===40&&shortened.width<=220,'too wide at the smallest size: shortened');
  for(const width of [0,-50,3]){const f=fitText(ctx,'D.C.',{size:40,width});assert(f.scale>0&&f.width>0&&f.width<=8.0001,`a box ${width} wide still yields upright text within the minimum box`)}
});
await test('Renderer: the same card draws the same image every time',()=>{
  const a=mockContext(),b=mockContext();drawShareCard(a,pickemCard(pickem(),opts));drawShareCard(b,pickemCard(pickem(),opts));
  assert.deepEqual(a.calls,b.calls);
  const c=mockContext(),d=mockContext();drawShareCard(c,survivorCard(survivor(),opts));drawShareCard(d,survivorCard(survivor(),opts));
  assert.deepEqual(c.calls,d.calls);
  assert.equal(a.calls.filter(x=>x[0]==='save').length,a.calls.filter(x=>x[0]==='restore').length,'every save is restored');
});

// ---- The apps' snapshots: weekly-app.js and survivor-app.js loaded in a fake DOM with the publication tables, the rules
// and rulings and the score feeds served locally, as their own suites do. The share snapshot must be the state the page
// shows: the same ranks and ties as the standings table, the same Survivor counts as the field status.
class El{constructor(){this.text='';this.innerHTML='';this.className='';this.value='';this.hidden=false;this.disabled=false;this.style={};this.listeners={};this.children=[];this.dataset={}}
  get textContent(){return this.text}set textContent(v){this.text=v==null?'':String(v)}
  addEventListener(t,f){(this.listeners[t]||=[]).push(f)}replaceChildren(...n){this.children=[...n]}appendChild(n){this.children.push(n);return n}setAttribute(){}removeAttribute(){}}
const RULING_COLUMNS={nfl_contests:['contest_id','season','contest_type','display_name','starts_at','created_at'],nfl_contest_policies:['contest_id','contest_type','revision','effective_week','halted_game_policy','public_note','created_at'],
  nfl_incident_rulings:['ruling_id','contest_id','contest_type','week','away_team','home_team','policy_revision','chain_seq','parent_ruling_id','consequence','incident_status','event_id','evidence_source','public_note','created_at']};
const rulingStore=(type,policy)=>({nfl_contests:[{contest_id:`pool-center-2026-${type}`,season:2026,contest_type:type,display_name:`Pool Center 2026 ${type}`,starts_at:'2026-09-01T00:00:00+00:00',created_at:'2026-10-08T12:00:00+00:00'}],
  nfl_contest_policies:[{contest_id:`pool-center-2026-${type}`,contest_type:type,revision:1,effective_week:1,halted_game_policy:policy,public_note:'Approved policy.',created_at:'2026-10-08T12:00:00+00:00'}],nfl_incident_rulings:[]});
const answer=body=>({ok:true,status:200,json:async()=>structuredClone(body)}),refuse=status=>({ok:false,status,json:async()=>({})});
function table(rows,u){
  if(typeof rows==='number')return refuse(rows);
  const select=(u.searchParams.get('select')||'').split(','),filters=[...u.searchParams].filter(([k])=>k!=='select'&&k!=='order');
  const keep=row=>filters.every(([k,v])=>{const [op,...rest]=v.split('.'),want=rest.join('.'),have=row[k],w=typeof have==='number'?Number(want):want;return op==='eq'?have===w:op==='lte'?have<=w:false});
  return answer(rows.filter(keep).map(row=>Object.fromEntries(select.map(c=>[c,row[c]??null]))));
}
const feedEvent=(away,home,week,{as='24',hs='10',done=true}={})=>({id:`${week}-${away}-${home}`,season:{year:2026,type:2},week:{number:week},
  status:{type:done?{state:'post',completed:true,name:'STATUS_FINAL',shortDetail:'Final'}:{state:'pre',completed:false,name:'STATUS_SCHEDULED',shortDetail:'Sun 1:00 PM'}},
  competitions:[{competitors:[{homeAway:'away',team:{abbreviation:away},score:done?as:'0'},{homeAway:'home',team:{abbreviation:home},score:done?hs:'0'}]}]});
async function loadApp(file,{weeksTable,published,store,scores,search,view}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El());return els.get(id)},listeners={};let tick=null;
  const doc={body:{dataset:view?{view}:{}},title:'',visibilityState:'hidden',getElementById:$,querySelectorAll(){return[]},createElement(){return new El()},
    addEventListener(t,f){(listeners[t]||=[]).push(f)},dispatchEvent(e){for(const f of listeners[e.type]||[])f(e);return true}};
  globalThis.document=doc;globalThis.window={addEventListener(){},scrollTo(){}};globalThis.location={href:`https://example.test/nfl-pool/${search}`,search};
  globalThis.history={state:null,pushState(){},replaceState(){}};globalThis.setInterval=fn=>{tick=fn;return 0};
  const io={indexFailure:false,scoreFailure:false,rulingsFailure:false};
  const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.y';
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/token/anonymous'))return answer({token});
    if(u.pathname.endsWith(`/${weeksTable}`)){const isRow=(u.searchParams.get('select')||'').includes('config');if(!isRow&&io.indexFailure)return refuse(503);return table(published,u)}
    const t=Object.keys(RULING_COLUMNS).find(n=>u.pathname.endsWith(`/${n}`));
    if(t)return io.rulingsFailure?refuse(503):table(store[t],u);
    const week=Number(u.searchParams.get('week'));
    if(io.scoreFailure)return refuse(503);
    return answer({events:structuredClone(scores[week]||[])});
  };
  const source=readFileSync(new URL(`./${file}`,import.meta.url),'utf8').replace(/from '\.\/([^']+)'/g,(_,p)=>`from '${new URL(`./${p}`,import.meta.url).href}'`);
  const warn=console.warn;console.warn=()=>{};
  try{await import(`data:text/javascript;base64,${Buffer.from(`${source}\n//${file} ${Math.random()}`).toString('base64')}`);await flush()}finally{console.warn=warn}
  const snapshot=contest=>{const detail={contest,snapshot:undefined};doc.dispatchEvent(new CustomEvent('poolcenter:sharesnapshot',{detail}));return detail.snapshot};
  const refresh=async()=>{const w=console.warn;console.warn=()=>{};try{doc.visibilityState='visible';tick();await flush()}finally{console.warn=w;doc.visibilityState='hidden'}};
  return{$,io,snapshot,refresh,doc};
}
// Pick'em: three games, the tracked group and three anonymous field entries. DJS goes 3–0; JC and Thaddeus go 2–1 with
// the same tiebreak difference, so they tie for second as JC and Thaddeus did in Week 5; D.C. goes 0–3.
const pkWeek=(week,{tiebreaks=[30,25,21,19]}={})=>({schemaVersion:1,season:2026,week,tiebreakGameIndex:2,fullFieldReady:true,fullFieldValidationVersion:3,competitionSize:7,fullFieldEntryCount:3,
  games:[{away:'DEN',home:'KC',awayNumber:1,homeNumber:2,date:'2026-10-11'},{away:'MIA',home:'BUF',awayNumber:3,homeNumber:4,date:'2026-10-11'},{away:'NYJ',home:'NE',awayNumber:5,homeNumber:6,date:'2026-10-12'}],
  participants:[{id:'dc',displayName:'D.C.',pickNumbers:[2,3,6],tiebreak:tiebreaks[0]},{id:'jc',displayName:'JC',pickNumbers:[1,4,6],tiebreak:tiebreaks[1]},{id:'djs',displayName:'DJS',pickNumbers:[1,4,5],tiebreak:tiebreaks[2]},{id:'thaddeus',displayName:'Thaddeus',pickNumbers:[2,4,5],tiebreak:tiebreaks[3]}],
  fieldEntries:[{id:'f1',pickNumbers:[1,4,5],tiebreak:22},{id:'f2',pickNumbers:[1,3,5],tiebreak:20},{id:'f3',pickNumbers:[2,3,6],tiebreak:40}]});
const pkScores=(week,done=[true,true,true])=>[feedEvent('DEN','KC',week,{as:'24',hs:'17',done:done[0]}),feedEvent('MIA','BUF',week,{as:'10',hs:'20',done:done[1]}),feedEvent('NYJ','NE',week,{as:'13',hs:'9',done:done[2]})];
const standingRows=v=>v.$('standings').innerHTML.split('</tr>').filter(Boolean).map(row=>{const cells=[...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(m=>m[1]);return{rank:Number(cells[0]),name:cells[1],fieldRank:/standing-overall">([^<]+)/.exec(cells[2])?.[1]??null}});
await test("Pick'em snapshot: the page's ranks, ties and field, and its state",async()=>{
  const published=[{season:2026,week:4,status:'locked',revision:2,published_at:'2026-10-04T14:00:00+00:00',config:pkWeek(4,{tiebreaks:[30,28,21,35]})},{season:2026,week:5,status:'locked',revision:1,published_at:'2026-10-11T17:47:50+00:00',config:pkWeek(5)}];
  const v=await loadApp('weekly-app.js',{weeksTable:'nfl_pool_weeks',published,store:rulingStore('pickem','void'),scores:{4:pkScores(4),5:pkScores(5)},search:'?view=standings&season=2026&week=5'});
  const s=v.snapshot('pickem');
  assert.equal(v.snapshot('survivor'),undefined,'Pick\'em answers only for itself');
  assert.deepEqual([s.season,s.week,s.revision,s.fieldSize,s.hold,s.publicationStale,s.scoresFailed,s.warnings],[2026,5,1,7,null,null,false,0]);
  assert.equal(typeof s.scoresAt,'string');assert.deepEqual(s.games,{total:3,final:3,void:0,live:0,remaining:0});assert.deepEqual(s.tiebreak,{final:true,void:false});
  assert.deepEqual(s.entries.map(e=>[e.name,e.rank,e.tied,`${e.w}-${e.l}`,e.fieldRank]),[['DJS',1,false,'3-0','#2'],['JC',2,true,'2-1','T-4'],['Thaddeus',2,true,'2-1','T-4'],['D.C.',4,false,'0-3','#6']]);
  assert.deepEqual(s.entries.map(e=>({rank:e.rank,name:e.name,fieldRank:e.fieldRank})),standingRows(v),'the snapshot is the standings table');
  assert.equal(String(s.fieldSize),v.$('entryCount').textContent,'the field size is the page\'s pool size');
  assert.deepEqual(Object.keys(s.entries[0]).sort(),['fieldRank','l','left','name','noSubmission','rank','tied','w'],'only public standing fields');
  assert(!JSON.stringify(s).includes('f1')&&!JSON.stringify(s).includes('pickNumbers'),'no field entry and no pick reaches the snapshot');
  assert.deepEqual(pickemCard(s,{now:Date.parse(s.scoresAt)}).rows.map(r=>r.place),['1ST','T-2','T-2','4']);
  // A failed score refresh keeps the verified standings and marks the card STALE.
  v.io.scoreFailure=true;await v.refresh();
  let next=v.snapshot('pickem');assert.equal(next.scoresFailed,true);assert.deepEqual(next.entries,s.entries);assert.equal(pickemStatus(next,Date.parse(next.scoresAt)).label,'STALE');
  v.io.scoreFailure=false;await v.refresh();assert.equal(v.snapshot('pickem').scoresFailed,false);
  // A publication that cannot be verified is PUBLISHED DATA STALE on the page and STALE on the card.
  v.io.indexFailure=true;await v.refresh();
  next=v.snapshot('pickem');assert.match(next.publicationStale,/could not be checked/);assert.equal(pickemStatus(next,Date.parse(next.scoresAt)).detail,'PUBLISHED DATA STALE');
  v.io.indexFailure=false;await v.refresh();assert.equal(v.snapshot('pickem').publicationStale,null);
  // Another published week: the snapshot follows the week on screen.
  v.$('weekSelect').value='2026-4';for(const f of v.$('weekSelect').listeners.change)f();await flush();
  next=v.snapshot('pickem');assert.deepEqual([next.week,next.revision],[4,2]);
  assert.deepEqual(next.entries.map(e=>[e.name,e.rank,e.tied,e.fieldRank]),[['DJS',1,false,'#2'],['JC',2,false,'#4'],['Thaddeus',3,false,'#5'],['D.C.',4,false,'#6']]);
  assert.deepEqual(next.entries.map(e=>({rank:e.rank,name:e.name,fieldRank:e.fieldRank})),standingRows(v));
});
await test("Pick'em snapshot: loading and ON HOLD make no card",async()=>{
  const published=[{season:2026,week:5,status:'locked',revision:1,published_at:null,config:pkWeek(5)}];
  const live=await loadApp('weekly-app.js',{weeksTable:'nfl_pool_weeks',published,store:rulingStore('pickem','void'),scores:{5:pkScores(5,[true,false,false])},search:'?view=home'});
  const s=live.snapshot('pickem');assert.deepEqual(s.games,{total:3,final:1,void:0,live:0,remaining:2});
  assert.equal(pickemStatus(s,Date.parse(s.scoresAt)).label,'LIVE');assert.equal(pickemStatus(s,Date.parse(s.scoresAt)).detail,'1 OF 3 GAMES FINAL');
  const held=await loadApp('weekly-app.js',{weeksTable:'nfl_pool_weeks',published,store:{nfl_contests:503,nfl_contest_policies:503,nfl_incident_rulings:503},scores:{5:pkScores(5)},search:'?view=home'});
  held.io.rulingsFailure=true;await held.refresh();
  const h=held.snapshot('pickem');assert.equal(typeof h.hold,'string');const card=pickemCard(h);assert.equal(card.ok,false);assert.match(card.reason,/on hold/);
});
// Survivor: Week 2 of a six-entry field. D.C. survives both weeks, DJS loses in Week 2, Thaddeus in Week 1.
const svWeek=week=>({schemaVersion:1,season:2026,week,label:`Survivor Week ${week}`,sheetWeeks:18,competitionSize:6,currentWeekEntryCount:3,
  trackedEntries:[{id:'dc',displayName:'D.C.',picks:['PIT','SF']},{id:'djs',displayName:'DJS',picks:['LV','ATL']},{id:'thaddeus',displayName:'Thaddeus',picks:['KC',null]}],
  fieldEntries:[{id:'survivor-001',picks:['JAX','BAL']},{id:'survivor-002',picks:['CLE',null]},{id:'survivor-003',picks:['JAX',null]}]});
const svScores=(done=true)=>({1:[feedEvent('PIT','CLE',1),feedEvent('LV','NE',1),feedEvent('KC','LAC',1,{as:'10',hs:'24'}),feedEvent('JAX','CAR',1)],
  2:[feedEvent('SF','ARI',2,{done}),feedEvent('ATL','BAL',2,{as:'10',hs:'24'}),feedEvent('CLE','DAL',2)],3:[feedEvent('MIA','BUF',3,{done:false})]});
await test('Survivor snapshot: the page\'s own field status, entries and state',async()=>{
  const published=[{season:2026,week:2,status:'locked',revision:1,published_at:'2026-09-21T19:30:44+00:00',config:svWeek(2)}];
  const v=await loadApp('survivor-app.js',{weeksTable:'nfl_survivor_weeks',published,store:rulingStore('survivor','advance_team_used'),scores:svScores(),search:'?view=survivor&season=2026&sw=2',view:'survivor'});
  const s=v.snapshot('survivor');
  assert.equal(v.snapshot('pickem'),undefined,'Survivor answers only for itself');
  assert.deepEqual(s.totals,{field:6,remaining:2,submissions:3,pending:0});
  assert.deepEqual([v.$('svPoolSize').textContent,v.$('svStillIn').textContent,v.$('svPending').textContent].map(Number),[s.totals.field,s.totals.remaining,s.totals.pending],'the snapshot is the field status');
  assert.match(v.$('svSummaryNote').textContent,new RegExp(`\\b${s.totals.submissions} submitted\\b`));
  assert.deepEqual(s.entries.map(e=>[e.name,e.status,e.eliminatedWeek,e.reason]),[['D.C.','ALIVE',null,'Alive through Week 2'],['DJS','OUT',2,'ATL lost in Week 2'],['Thaddeus','OUT',1,'KC lost in Week 1']]);
  assert.deepEqual([s.hold,s.publicationStale,s.scoresFailed,s.flags,s.awaitingRuling,s.onHold,s.unresolvedPrior],[null,null,false,[],0,0,0]);
  assert(!JSON.stringify(s).includes('survivor-00'),'no field entry reaches the snapshot');
  const card=survivorCard(s,{now:Date.parse(s.scoresAt)});
  assert.deepEqual(card.metrics.map(m=>m.value),['6','2','3','0']);assert.deepEqual(card.rows.map(r=>[r.name,r.status]),[['D.C.','ALIVE'],['DJS','OUT'],['Thaddeus','OUT']]);assert.equal(card.status.label,'FINAL');
  v.io.scoreFailure=true;await v.refresh();
  const failed=v.snapshot('survivor');assert.equal(failed.scoresFailed,true);assert.deepEqual(failed.totals,s.totals);assert.equal(survivorStatus(failed,Date.parse(failed.scoresAt)).label,'STALE');
});
await test('Survivor snapshot: a week still being played is LIVE, ON HOLD makes no card',async()=>{
  const published=[{season:2026,week:2,status:'locked',revision:1,published_at:null,config:svWeek(2)}];
  const v=await loadApp('survivor-app.js',{weeksTable:'nfl_survivor_weeks',published,store:rulingStore('survivor','advance_team_used'),scores:svScores(false),search:'?view=survivor',view:'survivor'});
  const s=v.snapshot('survivor');assert.deepEqual(s.totals,{field:6,remaining:2,submissions:3,pending:1});assert.equal(s.entries[0].status,'PENDING');
  assert.equal(survivorStatus(s,Date.parse(s.scoresAt)).label,'LIVE');
  const held=await loadApp('survivor-app.js',{weeksTable:'nfl_survivor_weeks',published,store:{nfl_contests:[],nfl_contest_policies:[],nfl_incident_rulings:[]},scores:svScores(),search:'?view=survivor',view:'survivor'});
  const h=held.snapshot('survivor');assert.equal(typeof h.hold,'string');assert.match(survivorCard(h).reason,/on hold/);
});

// ---- The share sheet on a small fake DOM: the buttons it mounts, the dialog, the native share, the fallbacks and copying.
const camel=s=>s.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
function fakeDom(){
  const doc={activeElement:null,listeners:{},execResult:false,execCalls:0,downloads:[]};
  const matches=(n,sel)=>sel.split(',').some(one=>{const s=one.trim();if(s.startsWith('.'))return n.className.split(/\s+/).includes(s.slice(1));const a=/^\[([\w-]+)="([^"]*)"\]$/.exec(s);if(a)return n.getAttribute(a[1])===a[2];return n.tagName===s.toUpperCase()});
  const walk=n=>[n,...n.children.flatMap(walk)];
  class Node{
    constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.attrs={};this.listeners={};this.hidden=false;this.textContent='';this.className='';this.disabled=false;this.dataset={};this.style={};
      this.classList={add:c=>{if(!this.classList.contains(c))this.className=`${this.className} ${c}`.trim()},remove:c=>{this.className=this.className.split(/\s+/).filter(x=>x&&x!==c).join(' ')},
        toggle:(c,on)=>{(on??!this.classList.contains(c))?this.classList.add(c):this.classList.remove(c)},contains:c=>this.className.split(/\s+/).includes(c)}}
    get id(){return this.attrs.id??''}set id(v){this.attrs.id=String(v)}
    setAttribute(k,v){this.attrs[k]=String(v);if(k==='hidden')this.hidden=true;if(k.startsWith('data-'))this.dataset[camel(k.slice(5))]=String(v)}
    getAttribute(k){return k in this.attrs?this.attrs[k]:null}removeAttribute(k){delete this.attrs[k];if(k==='hidden')this.hidden=false;if(k==='src')delete this.src}
    appendChild(c){c.parentElement=this;this.children.push(c);return c}
    after(n){const p=this.parentElement;n.parentElement=p;p.children.splice(p.children.indexOf(this)+1,0,n)}
    remove(){const p=this.parentElement;if(p){p.children.splice(p.children.indexOf(this),1);this.parentElement=null}}
    addEventListener(t,f){(this.listeners[t]||=[]).push(f)}
    dispatch(type,extra={}){const e={type,target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true},...extra};for(const f of this.listeners[type]||[])f(e);return e}
    click(){this.dispatch('click')}focus(){doc.activeElement=this}select(){}setSelectionRange(){}
    closest(sel){let n=this;while(n){if(matches(n,sel))return n;n=n.parentElement}return null}
    querySelector(sel){return walk(this).slice(1).find(n=>matches(n,sel))||null}querySelectorAll(sel){return walk(this).slice(1).filter(n=>matches(n,sel))}
    get text(){return walk(this).map(n=>n.textContent).join('')}
  }
  const make=tag=>{
    const n=new Node(tag);
    if(tag==='dialog'){n.open=false;n.showModal=()=>{n.open=true};n.close=()=>{n.open=false}}
    if(tag==='canvas'){n.width=300;n.height=150;n.context=mockContext();n.getContext=()=>n.context;n.toBlob=(cb,type)=>{const w=n.width,h=n.height;setTimeout(()=>cb(new Blob([JSON.stringify({w,h,calls:n.context.calls.length})],{type})),0)}}
    if(tag==='a')n.click=()=>doc.downloads.push({href:n.href??n.getAttribute('href'),download:n.download??n.getAttribute('download'),attached:!!n.parentElement});
    return n;
  };
  const body=make('body'),html=make('html');html.appendChild(body);
  const card=(cls,child)=>{const c=make('section');c.className=cls;c.appendChild(child);body.appendChild(c);return child};
  const home=card('card home-standings-card',make('div'));home.id='homeStandings';
  const tbody=make('tbody');tbody.id='standings';const tableWrap=make('div');tableWrap.className='table-wrap';const t=make('table');t.appendChild(tbody);tableWrap.appendChild(t);card('card standings',tableWrap);
  const note=card('card survivor-hero',make('div'));note.id='svSummaryNote';
  Object.assign(doc,{body,documentElement:html,createElement:make,createElementNS:(_,tag)=>make(tag),getElementById:id=>walk(html).find(n=>n.id===id)||null,
    addEventListener(t,f){(doc.listeners[t]||=[]).push(f)},dispatchEvent(e){for(const f of doc.listeners[e.type]||[])f(e);return true},
    execCommand(cmd){doc.execCalls++;assert.equal(cmd,'copy');return doc.execResult},nodes:()=>walk(html)});
  return doc;
}
const sheetSource=readFileSync(new URL('./share-sheet.js',import.meta.url),'utf8');
assert(sheetSource.includes("from './share-card.js?v=1';"),'the share sheet imports share-card.js at its precached version');
const sheetModule=sheetSource.replace("from './share-card.js?v=1';",`from '${new URL('./share-card.js?v=1',import.meta.url).href}';`);
async function loadSheet({snapshots={},share=null,canShare=null,clipboard=true}={}){
  const doc=fakeDom();globalThis.document=doc;
  for(const [contest,make] of Object.entries(snapshots))doc.addEventListener('poolcenter:sharesnapshot',e=>{if(e.detail.contest===contest)e.detail.snapshot=make()});
  const nav={shares:[],clipboard:clipboard?{writes:[],async writeText(t){if(clipboard==='reject')throw new Error('denied');this.writes.push(t)}}:undefined};
  if(share)nav.share=d=>{nav.shares.push(d);return share(d)};if(canShare)nav.canShare=canShare;
  Object.defineProperty(globalThis,'navigator',{value:nav,configurable:true,writable:true});
  const mod=await import(`data:text/javascript;base64,${Buffer.from(`${sheetModule}\n//sheet ${Math.random()}`).toString('base64')}`);
  const button=contest=>doc.nodes().find(n=>n.getAttribute('data-share-card')===contest);
  const action=name=>doc.nodes().find(n=>n.getAttribute('data-share-action')===name);
  const dialog=()=>doc.nodes().find(n=>n.tagName==='DIALOG');
  return{doc,nav,mod,button,action,dialog,img:()=>dialog().querySelector('.share-preview').children[0],feedback:()=>dialog().querySelector('.share-feedback').textContent,state:()=>dialog().querySelector('.share-state').textContent};
}
const pngShare=d=>Array.isArray(d?.files)&&d.files.length>0&&d.files.every(f=>f.type==='image/png');
const realSetTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...a)=>{const t=realSetTimeout(fn,ms,...a);if(ms>=10000)t.unref?.();return t};
const nowSnapshot=make=>()=>make({scoresAt:new Date().toISOString()});
await test('Share sheet: the Share buttons sit at the foot of each contest\'s standings',async()=>{
  const s=await loadSheet();
  const buttons=s.doc.nodes().filter(n=>n.getAttribute('data-share-card'));
  assert.deepEqual(buttons.map(b=>[b.getAttribute('data-share-card'),b.closest('.card')?.className,b.getAttribute('type'),b.getAttribute('aria-haspopup'),b.text]),
    [['pickem','card home-standings-card','button','dialog','Share standings card'],['pickem','card standings','button','dialog','Share standings card'],['survivor','card survivor-hero','button','dialog','Share Survivor card']]);
});
await test('Share sheet: preview, native PNG share with the deep link, and a cancelled share that downloads nothing',async()=>{
  let resolveShare;const s=await loadSheet({snapshots:{pickem:nowSnapshot(pickem)},canShare:pngShare,share:()=>new Promise((_,reject)=>{resolveShare=reject})});
  s.button('pickem').click();await flush();
  const d=s.dialog();assert.equal(d.open,true);assert.equal(d.getAttribute('aria-labelledby'),'share-sheet-title');
  assert.equal(d.querySelector('h2').textContent,"Share Pick'em standings");assert.match(s.state(),/^FINAL · 2026 Week 5 · revision 1$/);
  const img=s.img();assert.equal(img.hidden,false);assert.match(img.src,/^blob:/);assert.match(img.alt,/^Pick'em standings card, 2026 Week 5, FINAL\./);
  assert.equal(s.doc.documentElement.classList.contains('share-open'),true);
  assert.deepEqual(['share','share-link','download','copy-link','copy-text'].map(n=>s.action(n).hidden),[false,true,false,false,false]);
  assert.equal(s.doc.activeElement,s.action('share'),'focus moves to Share image once the card is ready');
  // The preview, the shared file and the download are the same 1080 × 1350 PNG blob.
  const preview=await (await nativeFetch(img.src)).text();assert.deepEqual(JSON.parse(preview).w,1080);assert.deepEqual(JSON.parse(preview).h,1350);
  s.action('share').click();
  assert.equal(s.nav.shares.length,1,'navigator.share runs straight from the tap');
  const shared=s.nav.shares[0];assert.equal(shared.files.length,1);assert.equal(shared.files[0].name,'pool-center-pickem-2026-week-5.png');assert.equal(shared.files[0].type,'image/png');
  assert.equal(await shared.files[0].text(),preview,'the shared file is the previewed image');
  assert.equal(shared.title,"Pool Center · Pick'em Standings · 2026 Week 5");assert.equal(shared.text,"Pool Center · Pick'em Standings · 2026 Week 5 · FINAL\nhttps://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=5");
  assert.equal(shared.url,undefined,'the link travels in the text, beside the file');
  assert.equal(s.action('share').disabled,true,'a second tap cannot start a second share');
  const abort=new Error('Share canceled');abort.name='AbortError';resolveShare(abort);await flush();
  assert.equal(s.feedback(),'Sharing cancelled.');assert.deepEqual(s.doc.downloads,[],'a cancelled share never downloads');assert.equal(s.action('share').disabled,false);
  s.action('download').click();
  assert.equal(s.doc.downloads.length,1);assert.equal(s.doc.downloads[0].download,'pool-center-pickem-2026-week-5.png');assert.equal(await (await nativeFetch(s.doc.downloads[0].href)).text(),preview,'the download is the previewed image');
  s.action('copy-link').click();await flush();assert.deepEqual(s.nav.clipboard.writes,['https://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=5']);assert.equal(s.feedback(),'Link copied.');
  s.action('copy-text').click();await flush();
  const copied=s.nav.clipboard.writes[1].split('\n'),expected=pickemCard(pickem({scoresAt:new Date().toISOString()}),{now:Date.now()}).text.split('\n'),stamp=l=>l.startsWith('Snapshot ');
  assert.deepEqual(copied.filter(l=>!stamp(l)),expected.filter(l=>!stamp(l)),'Copy text copies the card\'s text summary');assert.match(copied.find(stamp),/^Snapshot [A-Z][a-z]{2} \d{1,2}, \d{4} · \d{1,2}:\d{2} [AP]M \S+ · revision 1$/);
  assert.equal(s.feedback(),'Text summary copied.');
  // Escape (the dialog's cancel event) closes it and returns focus to the button that opened it.
  const cancel=d.dispatch('cancel');assert.equal(cancel.defaultPrevented,true);assert.equal(d.open,false);assert.equal(s.doc.activeElement,s.button('pickem'));
  assert.equal(s.doc.documentElement.classList.contains('share-open'),false);
});
await test('Share sheet: a share that fails for another reason explains itself and downloads nothing',async()=>{
  for(const [name,text] of [['NotAllowedError',/wasn't allowed just now/],['DataError',/couldn't share the image/],['TypeError',/couldn't share the image/]]){
    const s=await loadSheet({snapshots:{survivor:nowSnapshot(survivor)},canShare:pngShare,share:async()=>{const e=new Error('no');e.name=name;throw e}});
    s.button('survivor').click();await flush();s.action('share').click();await flush();
    assert.match(s.feedback(),text);assert.deepEqual(s.doc.downloads,[]);
    assert.equal(s.nav.shares[0].text,'Pool Center · Survivor Pool · 2026 Week 5 · FINAL\nhttps://r88510179-collab.github.io/nfl-pool/?view=survivor&season=2026&sw=5');
  }
  const ok=await loadSheet({snapshots:{survivor:nowSnapshot(survivor)},canShare:pngShare,share:async()=>{}});
  ok.button('survivor').click();await flush();ok.action('share').click();await flush();assert.equal(ok.feedback(),'Card shared.');assert.deepEqual(ok.doc.downloads,[]);
});
await test('Share sheet: without file sharing, Download PNG leads and the link can still be shared',async()=>{
  const linkOnly=await loadSheet({snapshots:{survivor:nowSnapshot(survivor)},canShare:()=>false,share:async()=>{}});
  linkOnly.button('survivor').click();await flush();
  assert.deepEqual(['share','share-link','download','copy-link','copy-text'].map(n=>linkOnly.action(n).hidden),[true,false,false,false,false]);
  assert.equal(linkOnly.action('download').classList.contains('primary'),true);assert.equal(linkOnly.dialog().querySelector('.share-note').hidden,false);
  assert.equal(linkOnly.doc.activeElement,linkOnly.action('download'));
  linkOnly.action('share-link').click();await flush();
  assert.deepEqual(linkOnly.nav.shares[0],{title:'Pool Center · Survivor Pool · 2026 Week 5',text:'Pool Center · Survivor Pool · 2026 Week 5 · FINAL',url:'https://r88510179-collab.github.io/nfl-pool/?view=survivor&season=2026&sw=5'});
  assert.deepEqual(linkOnly.doc.downloads,[]);
  const none=await loadSheet({snapshots:{pickem:nowSnapshot(pickem)}});
  none.button('pickem').click();await flush();
  assert.deepEqual(['share','share-link','download','copy-link','copy-text'].map(n=>none.action(n).hidden),[true,true,false,false,false],'no Web Share at all: Download, Copy link and Copy text');
});
await test('Share sheet: copying falls back to the copy command, then to selected text',async()=>{
  const s=await loadSheet({snapshots:{pickem:nowSnapshot(pickem)},clipboard:'reject'});
  s.button('pickem').click();await flush();
  s.doc.execResult=true;s.action('copy-link').click();await flush();
  assert.equal(s.doc.execCalls,1);assert.equal(s.feedback(),'Link copied.');assert.equal(s.dialog().querySelector('.share-manual').hidden,true);
  s.doc.execResult=false;s.action('copy-link').click();await flush();
  const manual=s.dialog().querySelector('.share-manual');assert.equal(manual.hidden,false);assert.equal(manual.value,'https://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=5');
  assert.match(s.feedback(),/press and hold it to copy/);
});
await test('Share sheet: unavailable data is explained and offers no image',async()=>{
  const missing=await loadSheet();
  missing.button('pickem').click();await flush();
  assert.equal(missing.dialog().open,true);assert.match(missing.state(),/still updating/);
  assert.deepEqual(['share','share-link','download','copy-link','copy-text'].map(n=>missing.action(n).hidden),[true,true,true,true,true]);
  assert.equal(missing.img().hidden,true);
  const held=await loadSheet({snapshots:{pickem:()=>pickem({hold:'ruling data unavailable'})},canShare:pngShare,share:async()=>{}});
  held.button('pickem').click();await flush();
  assert.match(held.state(),/on hold/);assert.deepEqual(['share','download','copy-text','copy-link'].map(n=>held.action(n).hidden),[true,true,true,false],'only the week\'s link');
  held.action('copy-link').click();await flush();assert.deepEqual(held.nav.clipboard.writes,['https://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=5']);
  assert.equal(held.nav.shares.length,0);
  const close=held.dialog().querySelector('.share-close');assert.equal(close.getAttribute('aria-label'),'Close share dialog');close.click();assert.equal(held.dialog().open,false);
});
await test('Share sheet: a card closed while drawing never fills the next one',async()=>{
  const s=await loadSheet({snapshots:{pickem:nowSnapshot(pickem),survivor:nowSnapshot(survivor)},canShare:pngShare,share:async()=>{}});
  s.button('pickem').click();s.dialog().querySelector('.share-close').click();s.button('survivor').click();await flush();
  assert.equal(s.dialog().querySelector('h2').textContent,'Share Survivor status');assert.match(s.img().alt,/^Survivor pool card/);
  s.action('share').click();await flush();assert.equal(s.nav.shares[0].files[0].name,'pool-center-survivor-2026-week-5.png');
});
globalThis.setTimeout=realSetTimeout;

assert.equal(failures.length,0,`Shareable Cards V1 regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
console.log('Shareable Cards V1 card model, status, renderer fit, app snapshot, native share, fallback and copy regressions passed');
