// Shareable cards. share-card.js on its own: the snapshot checks, the status a card may claim, the card model and its
// privacy, the copied summary, the deep links, and the layout and drawing on a recording Canvas 2D stand-in. share-ui.js on a
// fake DOM: the Share buttons, the preview of the exact PNG, native file sharing, cancel, Download and the copy fallbacks.
// The apps' answers to the share request are checked in weekly-app.test.mjs and survivor-app.test.mjs.
import assert from 'node:assert/strict';
import {buildCard,drawCard,cardLayout,pickemStatus,survivorStatus,shareLink,linkLabel,shareFileName,shareSupport,sharePayload,
  fitText,wrapText,chipRows,segmentWidths,ageSeconds,CARD_WIDTH,CARD_HEIGHT,FRESH_SECONDS,MAX_ROWS} from './share-card.js';

const failures=[];
const check=async(name,fn)=>{try{await fn()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
const NOW=Date.parse('2026-10-11T19:42:10Z'),TZ='America/New_York',HREF='https://r88510179-collab.github.io/nfl-pool/index.html?view=standings&week=2#top';
const iso=ms=>new Date(ms).toISOString();
const entry=(name,w,l,left,groupRank,field,o={})=>({name,w,l,left,groupRank,leader:groupRank===1,noPicks:false,tiebreakDelta:null,field,...o});
const rank=(rank,tieCount,topPercent,behind)=>({rank,tieCount,label:`${tieCount>1?'T-':'#'}${rank}`,topPercent,behind});
const pickem=(o={})=>({ready:true,contest:'pickem',season:2026,week:5,revision:2,
  games:{total:16,final:12,void:0,live:2,remaining:4},fieldSize:87,tiebreak:{final:false,void:false},
  entries:[entry('D.C.',10,2,4,1,rank(3,1,4,1)),entry('JC',9,3,4,2,rank(8,5,10,2)),entry('DJS',9,3,4,2,rank(8,5,10,2)),entry('Thaddeus',7,5,4,4,rank(41,9,48,4))],
  feed:{fetchedAt:iso(NOW-8000),failed:false,incomplete:false,warnings:0,review:false},hold:false,rulingsStale:false,publishedStale:false,...o});
const tracked=(name,status,team,reason,underReview=false)=>({name,status,team,reason,underReview});
const survivor=(o={})=>({ready:true,contest:'survivor',season:2026,week:5,revision:7,fieldSize:120,
  counts:{active:42,pending:8,out:78,outThisWeek:12,submitted:50,legalPicks:50,awaitingRuling:0,onHold:0},
  tracked:[tracked('D.C.','ALIVE','KC','Alive through Week 5'),tracked('DJS','OUT','BUF','BUF lost in Week 3'),tracked('Thaddeus','PENDING','SF','Week 5 game pending')],
  feed:{at:NOW-6000,failed:false},hold:false,flags:[],rulingsStale:false,publishedStale:false,...o});
const build=(contest,snapshot,o={})=>buildCard(contest,snapshot,{now:NOW,href:HREF,timeZone:TZ,...o});
const allFinal=()=>pickem({games:{total:16,final:16,void:0,live:0,remaining:0},entries:pickem().entries.map(e=>({...e,w:e.w+2,l:e.l+2,left:0}))});

// A Canvas 2D stand-in that measures text from the font size in ctx.font and records every fillText.
function recorder({parsesFonts=true}={}){
  const calls=[];let font='10px sans-serif';
  const ctx={
    fillStyle:'#000',strokeStyle:'#000',lineWidth:1,textAlign:'start',textBaseline:'alphabetic',letterSpacing:'0px',globalAlpha:1,lineCap:'butt',lineJoin:'miter',shadowColor:'',shadowBlur:0,shadowOffsetY:0,
    get font(){return font},set font(v){if(parsesFonts||/^\d+ \d+px sans-serif$/.test(v))font=v},
    measureText(text){const size=Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]),spacing=parseFloat(this.letterSpacing)||0;let w=0;for(const ch of String(text))w+=size*(ch===' '?.28:/[A-Z0-9#–—@]/.test(ch)?.7:/[a-z]/.test(ch)?.56:.5)+spacing;return{width:w}},
    fillText(text,x,y,maxWidth){calls.push({text:String(text),x,y,maxWidth,font,align:this.textAlign,width:this.measureText(text).width})},
    save(){},restore(){},translate(){},scale(){},beginPath(){},moveTo(){},lineTo(){},arcTo(){},arc(){},closePath(){},fill(){},stroke(){},clip(){},fillRect(){},
    createLinearGradient(){return{addColorStop(){}}},createRadialGradient(){return{addColorStop(){}}}
  };
  return{ctx,calls};
}
const drawn=card=>{const r=recorder();const layout=drawCard(r.ctx,card,{Path2D:undefined});return{...r,layout,texts:r.calls.map(c=>c.text)}};
const edges=c=>{const left=c.align==='right'?c.x-c.width:c.align==='center'?c.x-c.width/2:c.x;return{left,right:left+c.width}};

// ---- Pick'em cards.
await check("a Pick'em card is the selected week's standings: every tracked entry in standings order with its record and full-field rank",()=>{
  const card=build('pickem',pickem());
  assert.equal(card.ok,true);
  assert.deepEqual([card.season,card.week,card.revision,card.title],[2026,5,2,"Pick'em Standings"]);
  assert.deepEqual(card.rows.map(r=>[r.rank,r.name,r.record,r.overall,r.overallOf,r.leader]),[
    ['1','D.C.','10–2','#3','of 87',true],['2','JC','9–3','T-8','of 87',false],['2','DJS','9–3','T-8','of 87',false],['4','Thaddeus','7–5','T-41','of 87',false]]);
  assert.deepEqual(card.metrics.map(m=>[m.label,m.value,m.sub]),[['POOL SIZE','87','entries'],['GAMES FINAL','12/16','NFL finals'],['REMAINING','4','2 live now']]);
  assert.equal(card.rows[0].note,'Top 4% · 1 back of the field lead');
  assert.deepEqual([card.status.label,card.status.tone,card.status.detail,card.status.flags],['LIVE','ok','12 of 16 games final · 2 live',[]]);
});
await check('ties: tied entries share the group rank and the T- label; a sole rank keeps #',()=>{
  const card=build('pickem',pickem());
  assert.deepEqual(card.rows.map(r=>r.rank),['1','2','2','4']);
  assert.deepEqual(card.rows.map(r=>r.overall),['#3','T-8','T-8','T-41']);
  const all=build('pickem',pickem({entries:pickem().entries.map(e=>({...e,w:9,l:3,groupRank:1,leader:true,field:rank(8,5,10,2)}))}));
  assert.deepEqual(all.rows.map(r=>[r.rank,r.leader]),[['1',true],['1',true],['1',true],['1',true]],'all tied: all leaders at 1');
});
await check('full-field ranks unavailable: no rank and no pool size are invented, and the card says so',()=>{
  const card=build('pickem',pickem({fieldSize:null,entries:pickem().entries.map(e=>({...e,field:null}))}));
  assert.equal(card.ok,true);
  assert.deepEqual(card.rows.map(r=>[r.overall,r.overallOf,r.note]),Array(4).fill(null).map(()=>[null,null,'4 games left']));
  assert.deepEqual(card.metrics[0],{label:'POOL SIZE',value:'—',sub:'field not published'});
  assert.equal(card.fieldNote,'Full-field ranks are not published for this week.');
  assert.match(card.summary,/Full-field ranks are not published for this week\./);
  assert.doesNotMatch(card.summary,/ of \d+ overall|Pool size/);
  const d=drawn(card);
  assert(d.texts.includes('Full-field ranks are not published for this week.'));
  assert(!d.texts.some(t=>/^(#|T-)\d+$/.test(t)),'no rank is drawn');
});
await check('a full-field rank that does not fit the field or its label is refused',()=>{
  const bad=[
    ['label digits differ',{field:{...rank(3,1,4,1),label:'#4'}}],
    ['rank past the field',{field:rank(88,1,100,9)}],
    ['ties past the field',{field:rank(86,3,99,9)}],
    ['percent out of range',{field:{...rank(3,1,4,1),topPercent:0}}]
  ];
  for(const [label,change] of bad){
    const card=build('pickem',pickem({entries:[{...pickem().entries[0],...change},...pickem().entries.slice(1)]}));
    assert.equal(card.ok,false,label);assert.match(card.reason,/full-field rank of D\.C\. is invalid/,label);
  }
  const mixed=build('pickem',pickem({fieldSize:null}));
  assert.equal(mixed.ok,false,'a rank without a published field');
});
await check('records that do not cover the week, or standings out of order, are refused (partially updated state)',()=>{
  const short=build('pickem',pickem({entries:[{...pickem().entries[0],left:3},...pickem().entries.slice(1)]}));
  assert.equal(short.ok,false);assert.match(short.reason,/record of D\.C\. does not match this week's games/);
  const voided=build('pickem',pickem({games:{total:16,final:11,void:1,live:2,remaining:4},entries:pickem().entries.map(e=>({...e,w:e.w-1}))}));
  assert.equal(voided.ok,true,'a void game is no win, no loss and no game left');
  assert.match(voided.status.detail,/11 of 16 games final · 1 void · 2 live/);
  for(const groupRanks of [[2,2,3,4],[1,3,3,4],[1,2,2,3]]){
    const card=build('pickem',pickem({entries:pickem().entries.map((e,i)=>({...e,groupRank:groupRanks[i],leader:groupRanks[i]===1}))}));
    assert.equal(card.ok,false,String(groupRanks));
  }
  const leader=build('pickem',pickem({entries:pickem().entries.map((e,i)=>({...e,leader:i<2}))}));
  assert.equal(leader.ok,false,'a leader that is not ranked first');
  const counts=build('pickem',pickem({games:{total:16,final:12,void:0,live:5,remaining:4}}));
  assert.equal(counts.ok,false,'more live games than remaining');
});
await check('duplicated tracked entries are refused',()=>{
  const card=build('pickem',pickem({entries:[...pickem().entries.slice(0,3),{...pickem().entries[3],name:' d.c. '}]}));
  assert.equal(card.ok,false);assert.match(card.reason,/not unique/);
});
await check('a missing publication record or week is refused; not-ready, missing and foreign snapshots explain themselves',()=>{
  for(const [o,reason] of [[{revision:0},/publication record/],[{revision:null},/publication record/],[{week:0},/season and week/],[{season:'2026'},/season and week/]])
    assert.match(build('pickem',pickem(o)).reason,reason,JSON.stringify(o));
  assert.deepEqual(build('pickem',{ready:false,reason:'Scores for this week are still loading.'}),{ok:false,reason:'Scores for this week are still loading.'});
  assert.match(build('pickem',null).reason,/Reload the page/,'no app answered: a module from before share cards');
  assert.match(build('survivor',pickem()).reason,/different contest/);
  assert.match(build('games',pickem()).reason,/no card/);
  assert.match(build('pickem',pickem({feed:{...pickem().feed,fetchedAt:'not a time'}})).reason,/score feed state/);
});
await check(`more than ${MAX_ROWS.pickem} tracked entries are refused rather than squeezed`,()=>{
  const six=[...pickem().entries,entry('E5',6,6,4,5,rank(60,1,69,5)),entry('E6',5,7,4,6,rank(70,1,80,6))];
  assert.equal(build('pickem',pickem({entries:six.slice(0,5)})).ok,true);
  const card=build('pickem',pickem({entries:six}));
  assert.equal(card.ok,false);assert.match(card.reason,/only 5 tracked entries fit/);
});
await check('no picks submitted and a final tiebreak are shown from the snapshot',()=>{
  const card=build('pickem',allFinal());
  const withNotes=build('pickem',{...allFinal(),tiebreak:{final:true,void:false},entries:allFinal().entries.map((e,i)=>({...e,tiebreakDelta:i===3?null:i+2,noPicks:i===3,field:i===3?rank(80,8,92,9):e.field}))});
  assert.equal(card.status.label,'FINAL');
  assert.equal(withNotes.rows[0].tiebreak,'Tiebreak Δ 2');assert.equal(withNotes.rows[3].tiebreak,null);
  assert.equal(withNotes.rows[3].note,'No picks submitted');assert.match(withNotes.summary,/4\. Thaddeus 9–7 · T-80 of 87 overall · no picks submitted/);
});

// ---- Status.
await check("Pick'em status follows the header's precedence, and every other state that holds rides along",()=>{
  const feed=o=>({feed:{...pickem().feed,...o}});
  const cases=[
    [{},'LIVE',[]],
    [feed({failed:true}),'FEED UNAVAILABLE',[]],
    [{...feed({failed:true}),hold:true,rulingsStale:true,publishedStale:true},'FEED UNAVAILABLE',['ON HOLD','PUBLISHED DATA STALE','RULINGS STALE']],
    [{hold:true,...feed({incomplete:true,warnings:2})},'ON HOLD',['INCOMPLETE']],
    [{...feed({incomplete:true,warnings:2,review:true})},'INCOMPLETE',['UNDER REVIEW']],
    [{...feed({review:true}),publishedStale:true},'UNDER REVIEW',['PUBLISHED DATA STALE']],
    [{publishedStale:true,rulingsStale:true},'PUBLISHED DATA STALE',['RULINGS STALE']],
    [{rulingsStale:true},'RULINGS STALE',[]],
    [feed({fetchedAt:iso(NOW-31000)}),'DELAYED',[]],
    [{publishedStale:true,...feed({fetchedAt:iso(NOW-31000)})},'PUBLISHED DATA STALE',['DELAYED']]
  ];
  for(const [o,label,flags] of cases){const st=pickemStatus(pickem(o),{now:NOW,timeZone:TZ});assert.deepEqual([st.label,st.flags],[label,flags],JSON.stringify(o))}
  assert.equal(pickemStatus(pickem(feed({failed:true})),{now:NOW,timeZone:TZ}).tone,'bad');
  assert.equal(pickemStatus(pickem({hold:true}),{now:NOW,timeZone:TZ}).tone,'bad');
  assert.equal(pickemStatus(pickem({rulingsStale:true}),{now:NOW,timeZone:TZ}).tone,'warn');
});
await check('FINAL is claimed only when every game is resolved and nothing qualifies the result',()=>{
  const fin=allFinal();
  assert.deepEqual(pickemStatus(fin,{now:NOW,timeZone:TZ}),{label:'FINAL',tone:'final',detail:'All 16 games final',flags:[]});
  for(const o of [{rulingsStale:true},{publishedStale:true},{hold:true},{feed:{...fin.feed,failed:true}},{feed:{...fin.feed,review:true}},{feed:{...fin.feed,fetchedAt:iso(NOW-120000)}}])
    assert.notEqual(pickemStatus({...fin,...o},{now:NOW,timeZone:TZ}).label,'FINAL',JSON.stringify(o));
  const voided=pickemStatus({...fin,games:{total:16,final:15,void:1,live:0,remaining:0}},{now:NOW,timeZone:TZ});
  assert.deepEqual([voided.label,voided.detail],['FINAL','All 16 games resolved · 1 void']);
});
await check(`stale scores are never LIVE: older than ${FRESH_SECONDS} s at the snapshot, or of unknown age, the card is DELAYED and says as of when`,()=>{
  const at=age=>pickemStatus(pickem({feed:{...pickem().feed,fetchedAt:iso(NOW-age)}}),{now:NOW,timeZone:TZ});
  assert.equal(at(FRESH_SECONDS*1000).label,'LIVE','exactly the limit is fresh');
  assert.deepEqual([at(FRESH_SECONDS*1000+1000).label,at(FRESH_SECONDS*1000+1000).detail],['DELAYED','Scores as of 3:41 PM · 12 of 16 games final · 2 live']);
  assert.equal(at(-120000).label,'DELAYED','a time far in the future has no known age');
  assert.equal(ageSeconds(Number.NaN,NOW),null);assert.equal(ageSeconds(NOW+30000,NOW),0);
  const stale=pickemStatus(pickem({rulingsStale:true,feed:{...pickem().feed,fetchedAt:iso(NOW-300000)}}),{now:NOW,timeZone:TZ});
  assert.deepEqual([stale.label,stale.flags],['RULINGS STALE',['DELAYED']]);assert.match(stale.detail,/ · scores as of 3:37 PM$/);
  const final=pickemStatus({...allFinal(),feed:{...allFinal().feed,fetchedAt:iso(NOW-300000)}},{now:NOW,timeZone:TZ});
  assert.equal(final.label,'DELAYED','a complete slate that is behind is DELAYED, not FINAL');
});
await check('a failed feed is FEED UNAVAILABLE with the last verified time, and DELAYED never repeats it',()=>{
  const st=pickemStatus(pickem({feed:{...pickem().feed,failed:true,fetchedAt:iso(NOW-600000)}}),{now:NOW,timeZone:TZ});
  assert.deepEqual([st.label,st.flags,st.detail],['FEED UNAVAILABLE',[],'Score feed unavailable · last verified 3:32 PM · 12 of 16 games final · 2 live']);
});
await check('Survivor status: RESULT FEED UNAVAILABLE, ON HOLD, PUBLISHED DATA STALE, RULINGS STALE, DELAYED; team flags always ride along; FINAL only when every entry is decided',()=>{
  const st=o=>survivorStatus(survivor(o),{now:NOW,timeZone:TZ});
  assert.deepEqual([st({}).label,st({}).tone,st({}).detail],['LIVE','ok','8 entries pending']);
  assert.deepEqual([st({feed:{at:NOW-90000,failed:true},hold:true}).label,st({feed:{at:NOW-90000,failed:true},hold:true}).flags],['RESULT FEED UNAVAILABLE',['ON HOLD']]);
  assert.match(st({feed:{at:NOW-90000,failed:true}}).detail,/^Result feed unavailable · last verified 3:40 PM · /);
  assert.deepEqual([st({hold:true,publishedStale:true}).label,st({hold:true,publishedStale:true}).flags],['ON HOLD',['PUBLISHED DATA STALE']]);
  assert.deepEqual([st({publishedStale:true,rulingsStale:true}).label,st({publishedStale:true,rulingsStale:true}).flags],['PUBLISHED DATA STALE',['RULINGS STALE']]);
  assert.equal(st({feed:{at:NOW-45000,failed:false}}).label,'DELAYED');
  const flagged=st({flags:['1 TEAM RESULT AWAITING RULING'],counts:{...survivor().counts,active:41,awaitingRuling:1}});
  assert.deepEqual([flagged.label,flagged.tone,flagged.flags],['LIVE','warn',['1 TEAM RESULT AWAITING RULING']]);
  assert.equal(flagged.detail,'8 entries pending · 1 awaiting a ruling');
  const decided={counts:{...survivor().counts,active:34,pending:0,out:86,outThisWeek:20}};
  assert.deepEqual([st(decided).label,st(decided).tone,st(decided).detail],['FINAL','final','Week 5 results final · all 120 entries decided']);
  for(const o of [{flags:['1 TEAM RESULT UNDER REVIEW']},{rulingsStale:true},{publishedStale:true},{feed:{at:NOW-45000,failed:false}},{counts:{...decided.counts,active:33,onHold:1}}])
    assert.notEqual(st({...decided,...o}).label,'FINAL',JSON.stringify(o));
});

// ---- Survivor cards.
await check('a Survivor card is the selected week: field size, still in, out, pending, submissions and the tracked states, from the snapshot',()=>{
  const card=build('survivor',survivor());
  assert.equal(card.ok,true);
  assert.deepEqual([card.season,card.week,card.revision,card.title,card.fieldSize],[2026,5,7,'Survivor Pool',120]);
  assert.deepEqual(card.hero,{value:'42',label:'STILL IN',sub:'of 120 entries'});
  assert.deepEqual(card.metrics.map(m=>[m.label,m.value,m.sub]),[['OUT','78','12 this week'],['PENDING','8','not yet decided'],['SUBMITTED','50','Week 5 picks']]);
  assert.deepEqual(card.segments.map(s=>[s.tone,s.n]),[['alive',34],['pending',8],['out',78]]);
  assert.deepEqual(card.rows.map(r=>[r.name,r.status,r.team,r.note]),[['D.C.','ALIVE','KC','Alive through Week 5'],['DJS','OUT','BUF','BUF lost in Week 3'],['Thaddeus','PENDING','SF','Week 5 game pending']]);
  const ruled=build('survivor',survivor({counts:{active:39,pending:8,out:78,outThisWeek:12,submitted:50,legalPicks:48,awaitingRuling:1,onHold:2}}));
  assert.deepEqual(ruled.metrics.map(m=>[m.label,m.value]),[['OUT','78'],['PENDING','8'],['SUBMITTED','50'],['AWAITING RULING','1'],['ON HOLD','2']]);
  assert.equal(ruled.metrics[2].sub,'48 legal picks');
  assert.match(ruled.summary,/^Still in 39 of 120 · Out 78 · Pending 8 · Awaiting ruling 1 · On hold 2 · Submitted 50$/m);
});
await check('Survivor counts that do not account for every entry are refused',()=>{
  for(const counts of [{active:43},{pending:43},{outThisWeek:79},{legalPicks:51},{submitted:121,legalPicks:50},{onHold:1}]){
    const card=build('survivor',survivor({counts:{...survivor().counts,...counts}}));
    assert.equal(card.ok,false,JSON.stringify(counts));assert.match(card.reason,/field counts do not add up/);
  }
});
await check('Survivor tracked entries carry only the states the page shows; anything else is refused',()=>{
  for(const status of ['ALIVE','LIVE','PENDING','RULING','HOLD','OUT'])assert.equal(build('survivor',survivor({tracked:[tracked('D.C.',status,'KC','x')]})).ok,true,status);
  assert.match(build('survivor',survivor({tracked:[tracked('D.C.','WON','KC','x')]})).reason,/status of D\.C\. is invalid/);
  assert.match(build('survivor',survivor({tracked:[tracked('D.C.','ALIVE','Kansas City','x')]})).reason,/team of D\.C\. is invalid/);
  assert.equal(build('survivor',survivor({tracked:[tracked('D.C.','OUT',null,'No pick in Week 1')]})).rows[0].team,null);
  assert.match(build('survivor',survivor({tracked:[...survivor().tracked,tracked('Extra','OUT','NE','x')]})).reason,/only 3 tracked entries fit/);
  assert.match(build('survivor',survivor({tracked:[tracked('D.C.','ALIVE','KC','x'),tracked('D.C.','OUT','NE','y')]})).reason,/not unique/);
  const review=build('survivor',survivor({tracked:[tracked('D.C.','ALIVE','KC','Alive through Week 5',true)]}));
  assert.equal(review.rows[0].note,'UNDER REVIEW · Alive through Week 5');
});

// ---- Privacy: the card is built from named public fields only.
await check('a card, its summary and its drawing carry only public values, never a field entry or anything else a snapshot holds',()=>{
  const leaky={fieldEntries:[{id:'field-001',pickNumbers:[1,4],tiebreak:42}],admin_note:'PRIVATE ADMIN NOTE',created_by:'auth-user-7f3a',config:{secret:true}};
  for(const [contest,snapshot] of [['pickem',pickem({...leaky,entries:pickem().entries.map(e=>({...e,id:'dc',pickNumbers:[1,3],picks:['DEN']}))})],['survivor',survivor({...leaky,tracked:survivor().tracked.map(t=>({...t,id:'dc',picks:['PIT','SF']}))})]]){
    const card=build(contest,snapshot),text=JSON.stringify(card)+drawn(card).texts.join('\n');
    for(const secret of ['field-001','PRIVATE','auth-user','pickNumbers','"picks"','"id"','secret','DEN'])assert(!text.includes(secret),`${contest}: ${secret}`);
  }
});

// ---- Links, names and the summary.
await check('deep links keep the view and the selected week in the spelling each app boots from, at the canonical page path',()=>{
  assert.equal(shareLink('pickem',{season:2026,week:5},HREF),'https://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=5');
  assert.equal(shareLink('survivor',{season:2026,week:5},'https://r88510179-collab.github.io/nfl-pool/?view=survivor&sw=3&season=2025'),'https://r88510179-collab.github.io/nfl-pool/?view=survivor&season=2026&sw=5');
  assert.equal(shareLink('pickem',{season:2026,week:18},'https://example.test/nfl-pool/'),'https://example.test/nfl-pool/?view=standings&season=2026&week=18');
  const card=build('pickem',pickem()),u=new URL(card.link);
  assert.deepEqual([u.searchParams.get('view'),u.searchParams.get('season'),u.searchParams.get('week')],['standings','2026','5'],'the snapshot week, not the page URL week (2)');
  const sv=new URL(build('survivor',survivor()).link);
  assert.deepEqual([sv.searchParams.get('view'),sv.searchParams.get('season'),sv.searchParams.get('sw'),sv.searchParams.has('week')],['survivor','2026','5',false]);
  assert.equal(linkLabel(HREF),'r88510179-collab.github.io/nfl-pool');
  assert.equal(shareFileName(card),'nfl-pool-center-pickem-2026-week-5.png');
  assert.equal(build('survivor',survivor()).fileName,'nfl-pool-center-survivor-2026-week-5.png');
});
await check('the copied summary names the week, the claimed status with every qualifier, each tracked entry, the snapshot time and the link',()=>{
  const card=build('pickem',pickem({rulingsStale:true}));
  assert.equal(card.summary,["NFL Pool Center · 2026 Week 5 · Pick'em Standings",'RULINGS STALE — Rulings not refreshed · last verified rulings apply · 12 of 16 games final · 2 live',
    '1. D.C. 10–2 · #3 of 87 overall','2. JC 9–3 · T-8 of 87 overall','2. DJS 9–3 · T-8 of 87 overall','4. Thaddeus 7–5 · T-41 of 87 overall','Pool size: 87 entries',
    'Snapshot Oct 11, 2026, 3:42 PM EDT · revision 2','https://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=5'].join('\n'));
  const sv=build('survivor',survivor({flags:['2 TEAM RESULTS UNVERIFIED']}));
  assert.equal(sv.summary,['NFL Pool Center · 2026 Week 5 · Survivor Pool','LIVE · 2 TEAM RESULTS UNVERIFIED — 8 entries pending','Still in 42 of 120 · Out 78 · Pending 8 · Submitted 50',
    'D.C.: ALIVE · KC — Alive through Week 5','DJS: OUT · BUF — BUF lost in Week 3','Thaddeus: PENDING · SF — Week 5 game pending',
    'Snapshot Oct 11, 2026, 3:42 PM EDT · revision 7','https://r88510179-collab.github.io/nfl-pool/?view=survivor&season=2026&sw=5'].join('\n'));
  assert.equal(card.shareText,"2026 Week 5 Pick'em Standings · RULINGS STALE\nhttps://r88510179-collab.github.io/nfl-pool/?view=standings&season=2026&week=5");
  assert.match(card.alt,/^Pick'em Standings card, 2026 Week 5: RULINGS STALE — /);
});

// ---- Layout and drawing.
const longNames=pickem({entries:[entry('Maximilian Featherstonehaugh-Worthington III',10,2,4,1,rank(3,1,4,1)),entry('JC',9,3,4,2,rank(8,5,10,2)),entry('DJS',9,3,4,2,rank(8,5,10,2)),entry('Thaddeus',7,5,4,4,rank(41,9,48,4))]});
const worstPickem=pickem({publishedStale:true,rulingsStale:true,fieldSize:null,feed:{...pickem().feed,incomplete:true,warnings:2,review:true,fetchedAt:iso(NOW-95000)},
  entries:[...pickem().entries,entry('Maximilian Featherstonehaugh-Worthington',6,6,4,5,null)].map(e=>({...e,field:null}))});
const worstSurvivor=survivor({flags:['1 TEAM RESULT AWAITING RULING','2 TEAM RESULTS UNVERIFIED','1 TEAM RESULT UNDER REVIEW','3 TEAM RESULTS ON HOLD'],publishedStale:true,rulingsStale:true,feed:{at:NOW-70000,failed:false},
  counts:{active:39,pending:8,out:78,outThisWeek:12,submitted:50,legalPicks:48,awaitingRuling:1,onHold:2},
  tracked:[tracked('Bartholomew-Alexander Featherstone','RULING','KC','Week 5 KC game halted (STATUS_SUSPENDED): awaiting pool ruling'),tracked('DJS','HOLD','BUF','Week 5 BUF on hold: ruling information unavailable'),tracked('Thaddeus','ALIVE','PIT','Alive through Week 5 · Week 4 PIT advanced by commissioner ruling',true)]});
const CARDS={pickem:pickem(),final:allFinal(),longNames,worstPickem,hold:pickem({hold:true}),unavailable:pickem({feed:{...pickem().feed,failed:true}}),survivor:survivor(),worstSurvivor};
await check('every string drawn fits its width and stays on the card, in every state and the worst cases',()=>{
  for(const [name,snapshot] of Object.entries(CARDS)){
    const card=build(snapshot.contest,snapshot);assert.equal(card.ok,true,name);
    const {calls}=drawn(card);assert(calls.length>30,`${name}: drawn`);
    for(const c of calls){
      assert(c.text.length>0,`${name}: an empty string is never drawn`);
      assert(Number.isFinite(c.maxWidth)&&c.width<=c.maxWidth+.01,`${name}: "${c.text}" is ${c.width.toFixed(1)} wide in a ${c.maxWidth} column`);
      const {left,right}=edges(c);
      assert(left>=0&&right<=CARD_WIDTH&&c.y>0&&c.y<CARD_HEIGHT,`${name}: "${c.text}" at ${left.toFixed(1)}..${right.toFixed(1)}, ${c.y} is on the card`);
    }
  }
});
await check('the card draws what it claims: brand, season and week, title, status, every tracked entry, record and rank, the snapshot and the link',()=>{
  const {texts}=drawn(build('pickem',pickem()));
  for(const t of ['NFL','POOL CENTER','2026 SEASON','WEEK 5','PICK’EM STANDINGS','LIVE','12 of 16 games final · 2 live','87','12/16','D.C.','10–2','#3','of 87','JC','T-8','DJS','Thaddeus','7–5','T-41',
    'SNAPSHOT · REVISION 2','Oct 11, 2026, 3:42 PM EDT','GENERATED FROM NFL POOL CENTER','r88510179-collab.github.io/nfl-pool'])assert(texts.includes(t),`drawn: ${t}`);
  const sv=drawn(build('survivor',survivor())).texts;
  for(const t of ['SURVIVOR POOL','STILL IN','42','of 120 entries','OUT','78','12 this week','PENDING','8','SUBMITTED','50','KC','ALIVE','BUF','OUT','SF','PENDING','Thaddeus'])assert(sv.includes(t),`drawn: ${t}`);
});
await check('tracked rows keep a readable height in the worst cases (two qualifier rows, two detail lines, five metrics, the most rows)',()=>{
  const typical=cardLayout(recorder().ctx,build('pickem',pickem()));
  assert(typical.rowH>=100,`typical Pick'em rows ${typical.rowH}`);assert.equal(typical.d.title,86,'the roomiest density');
  for(const [name,snapshot] of [['Pick’em worst',worstPickem],['Survivor worst',worstSurvivor]]){
    const card=build(snapshot.contest,snapshot),layout=cardLayout(recorder().ctx,card);
    assert(layout.rowH>=78,`${name} rows ${layout.rowH}`);
    assert(layout.rowsY+card.rows.length*layout.rowH+(card.rows.length-1)*layout.gap<=1190,`${name} rows end above the footer`);
  }
});
await check('a long name is cut with an ellipsis before the record, never drawn over it',()=>{
  const {calls}=drawn(build('pickem',longNames)),name=calls.find(c=>c.text.startsWith('Maximilian')),record=calls.find(c=>c.text==='10–2');
  assert(name.text.endsWith('…'),name.text);assert(edges(name).right<=edges(record).left-20,'the name ends before the record');
});
await check('the font falls back to sans-serif where the canvas cannot parse the page font stack',()=>{
  const r=recorder({parsesFonts:false});drawCard(r.ctx,build('pickem',pickem()),{Path2D:undefined});
  assert(r.calls.length>30&&r.calls.every(c=>/ sans-serif$/.test(c.font)),'every string is drawn in sans-serif');
});
await check('fitText and wrapText: an ellipsis where text does not fit; breaks between segments, never a line that starts with the separator',()=>{
  const {ctx}=recorder();ctx.font='600 20px x';
  assert.equal(fitText(ctx,'Short',500),'Short');
  const cut=fitText(ctx,'Featherstonehaugh-Worthington',150);assert(cut.endsWith('…')&&ctx.measureText(cut).width<=150,cut);
  assert.equal(fitText(ctx,'Anything',3),'');
  const lines=wrapText(ctx,'Score feed unavailable · last verified 3:32 PM · 12 of 16 games final · 2 live',560,2);
  assert.equal(lines.length,2);assert(lines.every(l=>!l.startsWith('·')&&ctx.measureText(l).width<=560),JSON.stringify(lines));
  assert.equal(lines.join(' · '),'Score feed unavailable · last verified 3:32 PM · 12 of 16 games final · 2 live','nothing is lost when it fits');
  const one=wrapText(ctx,'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',200,1);
  assert.equal(one.length,1);assert(one[0].endsWith('…'));
  assert.deepEqual(wrapText(ctx,'',300,2),[]);
});
await check('chipRows: qualifiers stay in order on at most two rows, and the rest are summed up as +N MORE',()=>{
  const width=label=>label.length*10;
  assert.deepEqual(chipRows(['AAAA','BBBB'],width,50,0,200,10),[['AAAA','BBBB'],[]]);
  assert.deepEqual(chipRows(['AAAAAAAAAA','BBBBBBBBBB','CCCCCCCCCC'],width,120,0,250,10),[['AAAAAAAAAA'],['BBBBBBBBBB','CCCCCCCCCC']],'beside the pill while it fits, then the second row');
  const rows=chipRows(['A'.repeat(9),'B'.repeat(9),'C'.repeat(9),'D'.repeat(9),'E'.repeat(9)],width,0,0,200,10);
  assert.deepEqual(rows,[['AAAAAAAAA','BBBBBBBBB'],['CCCCCCCCC','+2 MORE']]);
  const tight=chipRows(['A'.repeat(19),'B'.repeat(19),'C'.repeat(19)],width,0,0,200,10);
  assert.deepEqual(tight,[['AAAAAAAAAAAAAAAAAAA'],['+2 MORE']],'a +N MORE that does not fit replaces the chip before it');
});
await check('segmentWidths: in proportion, every nonzero segment visible, filling the bar exactly',()=>{
  const w=segmentWidths([34,8,1,0,77],120,876);
  assert.equal(w[3],0);assert(w[2]>=8,'one awaiting entry stays visible');
  assert(Math.abs(w.reduce((a,b)=>a+b,0)-876)<1e-9);
  assert.deepEqual(segmentWidths([10,10],20,100),[50,50]);
});

// ---- Native sharing helpers.
await check('file sharing is offered only where navigator.share and canShare({files}) both allow it',()=>{
  const file={name:'card.png'};
  assert.deepEqual(shareSupport({share(){},canShare:x=>Array.isArray(x.files),clipboard:{writeText(){}}},file),{share:true,files:true,clipboard:true});
  assert.deepEqual(shareSupport({share(){},canShare:()=>false},file),{share:true,files:false,clipboard:false},'share without files (text only)');
  assert.deepEqual(shareSupport({share(){}},file),{share:true,files:false,clipboard:false},'share without canShare (no file support)');
  assert.deepEqual(shareSupport({share(){},canShare(){throw new TypeError('bad')}},file),{share:true,files:false,clipboard:false},'canShare throwing');
  assert.deepEqual(shareSupport({},file),{share:false,files:false,clipboard:false},'no Web Share at all');
  assert.deepEqual(shareSupport(undefined,file),{share:false,files:false,clipboard:false});
  assert.deepEqual(shareSupport({share(){},canShare:()=>true},null),{share:true,files:false,clipboard:false},'no File to offer');
  const card=build('pickem',pickem());
  assert.deepEqual(sharePayload(card,file,{canShare:()=>true}),{files:[file],title:card.shareTitle,text:card.shareText});
  assert.deepEqual(sharePayload(card,file,{canShare:x=>!x.text}),{files:[file]},'the file alone where text cannot ride along');
  assert.deepEqual(sharePayload(card,file,{canShare(){throw new Error('x')}}),{files:[file]});
});

// ---- share-ui.js on a fake DOM.
class FakeNode{
  constructor(tag,doc){this.tagName=tag.toUpperCase();this.doc=doc;this.children=[];this.attributes={};this.listeners={};this.hidden=false;this.disabled=false;this.className='';this.textContent='';this.dataset={};this.parent=null;this.value=''}
  setAttribute(k,v){this.attributes[k]=String(v);if(k==='href')this.href=String(v);if(k==='download')this.download=String(v)}
  getAttribute(k){return this.attributes[k]??null}
  removeAttribute(k){delete this.attributes[k];if(k==='src')this.src=undefined;if(k==='open')this.open=false}
  appendChild(c){c.parent=this;this.children.push(c);return c}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null}}
  addEventListener(t,f){(this.listeners[t]||=[]).push(f)}
  fire(t,event={}){for(const f of this.listeners[t]||[])f({target:this,...event})}
  focus(){this.doc.focused=this}
}
function fakePage({share=null,canShare=null,clipboard=null,execCommand=()=>false,toBlob='ok',context=true,provider=null,href='https://example.test/nfl-pool/?view=standings'}={}){
  const listeners={},doc={focused:null,downloads:[],shares:[],copies:[],revoked:[],created:[],pendingBlob:null};
  const document={
    body:null,
    querySelectorAll:sel=>sel==='[data-share-card]'?doc.buttons:[],
    createElement:tag=>{
      const node=new FakeNode(tag,doc);
      if(tag==='dialog'){node.open=false;node.showModal=()=>{node.open=true};node.close=()=>{if(!node.open)return;node.open=false;node.fire('close')}}
      if(tag==='canvas'){node.getContext=()=>context?recorder().ctx:null;node.toBlob=(cb,type)=>{doc.blobType=type;
        if(toBlob==='ok')setTimeout(()=>cb(new Blob(['PNG-BYTES'],{type})));else if(toBlob==='null')setTimeout(()=>cb(null));else if(toBlob==='hold')doc.pendingBlob=()=>cb(new Blob(['LATE'],{type}));else throw new Error('toBlob exploded')}}
      if(tag==='a')node.click=()=>doc.downloads.push({href:node.href,download:node.download});
      if(tag==='textarea')node.select=()=>{doc.selected=node.value};
      return node;
    },
    addEventListener:(t,f)=>{(listeners[t]||=[]).push(f)},
    dispatchEvent:e=>{for(const f of listeners[e.type]||[])f(e);return true},
    execCommand:cmd=>{doc.commands=(doc.commands||[]).concat(cmd);return execCommand(doc)}
  };
  document.body=new FakeNode('body',doc);
  doc.buttons=['pickem','survivor'].map(contest=>{const b=new FakeNode('button',doc);b.hidden=true;b.dataset.shareCard=contest;return b});
  if(provider)document.addEventListener('poolcenter:share',event=>{event.detail.snapshot=provider(event.detail.contest)});
  const navigator={};
  if(share)navigator.share=data=>{doc.shares.push(data);return share(data)};
  if(canShare)navigator.canShare=canShare;
  if(clipboard)navigator.clipboard={writeText:async value=>{doc.copies.push(value);return clipboard(value)}};
  globalThis.document=document;
  Object.defineProperty(globalThis,'navigator',{value:navigator,configurable:true,writable:true});
  globalThis.location={href};
  const realCreate=URL.createObjectURL,realRevoke=URL.revokeObjectURL;
  URL.createObjectURL=blob=>{const url=realCreate(blob);doc.created.push({url,blob});return url};
  URL.revokeObjectURL=url=>{doc.revoked.push(url);realRevoke(url)};
  doc.restore=()=>{URL.createObjectURL=realCreate;URL.revokeObjectURL=realRevoke};
  return doc;
}
let uiInstance=0;
const flush=async(n=10)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};
async function shareUi(options){
  const doc=fakePage(options);
  await import(`./share-ui.js?instance=${++uiInstance}`);
  const body=globalThis.document.body,dialog=()=>body.children.find(n=>n.tagName==='DIALOG');
  const find=(node,pred)=>{if(pred(node))return node;for(const c of node.children){const hit=find(c,pred);if(hit)return hit}return null};
  const byText=text=>find(dialog(),n=>n.tagName==='BUTTON'&&n.textContent===text);
  const ui={doc,dialog,byText,
    image:()=>find(dialog(),n=>n.tagName==='IMG'),message:()=>find(dialog(),n=>n.className==='share-placeholder'),status:()=>find(dialog(),n=>/^share-status/.test(n.className)),
    actions:()=>find(dialog(),n=>n.className==='share-actions'),title:()=>find(dialog(),n=>n.tagName==='H2'),
    open:async(contest='pickem')=>{doc.buttons[contest==='pickem'?0:1].fire('click');await flush()},
    click:async text=>{byText(text).fire('click');await flush()}};
  return ui;
}
// share-ui.js reads the real clock, so the page's snapshots are fresh against it, as on a page that is refreshing.
const fresh=snapshot=>snapshot.contest==='pickem'?{...snapshot,feed:{...snapshot.feed,fetchedAt:iso(Date.now()-2000)}}:{...snapshot,feed:{...snapshot.feed,at:Date.now()-2000}};
const pickemProvider=(snap=()=>pickem())=>contest=>fresh(contest==='pickem'?snap():survivor());
const fileShare={share:async()=>{},canShare:x=>Array.isArray(x.files)&&x.files.every(f=>f instanceof File)};

await check('the Share buttons stay hidden until share-ui.js runs, then each previews its own contest',async()=>{
  const doc=fakePage({});assert.deepEqual(doc.buttons.map(b=>b.hidden),[true,true]);doc.restore();
  const ui=await shareUi({...fileShare,provider:pickemProvider()});
  try{
    assert.deepEqual(ui.doc.buttons.map(b=>b.hidden),[false,false]);
    await ui.open('survivor');
    assert.equal(ui.dialog().open,true);assert.equal(ui.title().textContent,'Share Survivor results');
    assert.match(ui.image().alt,/^Survivor Pool card, 2026 Week 5: LIVE — /);
    assert.equal(ui.doc.blobType,'image/png');
  }finally{ui.doc.restore()}
});
await check('Share graphic hands the previewed PNG to navigator.share as a file, in the tap, and downloads nothing',async()=>{
  const ui=await shareUi({...fileShare,provider:pickemProvider()});
  try{
    await ui.open('pickem');
    const preview=ui.image();assert.equal(preview.hidden,false);assert.match(preview.src,/^blob:/);
    assert.equal(ui.byText('Share graphic').disabled,false);assert.equal(ui.byText('Share graphic').hidden,false);
    ui.byText('Share graphic').fire('click');
    assert.equal(ui.doc.shares.length,1,'navigator.share is called synchronously in the tap');
    await flush();
    const [{files,title,text}]=ui.doc.shares,[file]=files;
    assert(file instanceof File);assert.deepEqual([file.name,file.type],['nfl-pool-center-pickem-2026-week-5.png','image/png']);
    assert.equal(await file.text(),await ui.doc.created[0].blob.text(),'the shared file is the previewed PNG');
    assert.equal(ui.doc.created[0].url,preview.src);
    assert.match(title,/^NFL Pool Center · 2026 Week 5 Pick'em Standings$/);assert.match(text,/\?view=standings&season=2026&week=5$/);
    assert.equal(ui.status().textContent,'Shared.');assert.deepEqual(ui.doc.downloads,[]);
  }finally{ui.doc.restore()}
});
await check('a second tap while the share sheet is open starts no second share; the button returns when the sheet closes',async()=>{
  let close;
  const ui=await shareUi({share:()=>new Promise(resolve=>{close=resolve}),canShare:fileShare.canShare,provider:pickemProvider()});
  try{
    await ui.open();
    ui.byText('Share graphic').fire('click');ui.byText('Share graphic').fire('click');await flush();
    assert.equal(ui.doc.shares.length,1);assert.equal(ui.byText('Share graphic').disabled,true,'disabled while the sheet is open');
    close();await flush();
    assert.equal(ui.byText('Share graphic').disabled,false);assert.equal(ui.status().textContent,'Shared.');
  }finally{ui.doc.restore()}
});
await check('cancelling the share sheet only says so: nothing is downloaded or sent instead',async()=>{
  const ui=await shareUi({share:async()=>{throw new DOMException('Share canceled','AbortError')},canShare:fileShare.canShare,provider:pickemProvider()});
  try{
    await ui.open();await ui.click('Share graphic');
    assert.equal(ui.status().textContent,'Share canceled. Nothing was sent.');assert.deepEqual(ui.doc.downloads,[]);assert.equal(ui.doc.shares.length,1);
  }finally{ui.doc.restore()}
});
await check('a share that fails says why and points to Download and Copy link',async()=>{
  const ui=await shareUi({share:async()=>{throw new DOMException('Permission denied','NotAllowedError')},canShare:fileShare.canShare,provider:pickemProvider()});
  try{
    await ui.open();await ui.click('Share graphic');
    assert.match(ui.status().textContent,/Sharing didn’t work here \(Permission denied\)\. Use Download PNG or Copy link instead\./);assert.equal(ui.status().className,'share-status error');
    assert.deepEqual(ui.doc.downloads,[]);
  }finally{ui.doc.restore()}
});
await check('without file sharing, Share graphic is hidden and Download PNG is the main action; Download saves the previewed PNG',async()=>{
  for(const nav of [{},{share:async()=>{}},{share:async()=>{},canShare:()=>false}]){
    const ui=await shareUi({...nav,provider:pickemProvider()});
    try{
      await ui.open();
      assert.equal(ui.byText('Share graphic').hidden,true);assert.equal(ui.byText('Download PNG').className,'share-action primary');
      assert.match(ui.status().textContent,/can’t share images directly/);
      await ui.click('Download PNG');
      assert.deepEqual(ui.doc.downloads,[{href:ui.image().src,download:'nfl-pool-center-pickem-2026-week-5.png'}]);
      assert.equal(ui.doc.shares.length,0);
    }finally{ui.doc.restore()}
  }
});
await check('Copy link and Copy summary use the clipboard, fall back to the copy command, and show the text when neither works',async()=>{
  let ui=await shareUi({...fileShare,clipboard:()=>{},provider:pickemProvider()});
  try{
    await ui.open();await ui.click('Copy link');
    assert.deepEqual(ui.doc.copies,['https://example.test/nfl-pool/?view=standings&season=2026&week=5']);assert.equal(ui.status().textContent,'Link copied.');
    await ui.click('Copy summary');assert.match(ui.doc.copies[1],/^NFL Pool Center · 2026 Week 5 · Pick'em Standings\n/);assert.equal(ui.status().textContent,'Summary copied.');
  }finally{ui.doc.restore()}
  ui=await shareUi({...fileShare,clipboard:()=>{throw new Error('denied')},execCommand:doc=>doc.selected?.startsWith('https://'),provider:pickemProvider()});
  try{await ui.open();await ui.click('Copy link');assert.equal(ui.status().textContent,'Link copied.');assert.deepEqual(ui.doc.commands,['copy'])}finally{ui.doc.restore()}
  ui=await shareUi({...fileShare,provider:pickemProvider()});
  try{
    await ui.open();await ui.click('Copy summary');
    assert.match(ui.status().textContent,/^Couldn’t copy automatically\. Press and hold to copy the summary:\nNFL Pool Center/);assert.equal(ui.status().className,'share-status error');
  }finally{ui.doc.restore()}
});
await check('no card is made from a missing, not-ready or inconsistent snapshot: the reason is shown and no action is offered',async()=>{
  for(const [provider,reason] of [[null,/Reload the page/],[()=>({ready:false,reason:'Scores for this week are still loading.'}),/still loading/],[()=>pickem({revision:0}),/publication record/]]){
    const ui=await shareUi({...fileShare,provider});
    try{
      await ui.open();
      assert.match(ui.message().textContent,reason);assert.equal(ui.actions().hidden,true);assert.equal(ui.image().hidden,true);
      assert.equal(ui.doc.created.length,0,'no PNG is made');
    }finally{ui.doc.restore()}
  }
});
await check('a PNG that cannot be made is reported; the link and the summary can still be copied',async()=>{
  for(const option of [{toBlob:'null'},{toBlob:'throw'},{context:false}]){
    const ui=await shareUi({...fileShare,clipboard:()=>{},...option,provider:pickemProvider()});
    try{
      await ui.open();
      assert.match(ui.message().textContent,/^The image could not be created on this device \(.+\)\. You can still copy the link or the summary\.$/,JSON.stringify(option));
      assert.equal(ui.byText('Share graphic').hidden,true);assert.equal(ui.byText('Download PNG').hidden,true);
      await ui.click('Copy link');assert.equal(ui.status().textContent,'Link copied.');
    }finally{ui.doc.restore()}
  }
});
await check('closing releases the PNG and returns focus to the Share button; a late export never repaints a closed preview',async()=>{
  let ui=await shareUi({...fileShare,provider:pickemProvider()});
  try{
    await ui.open();const url=ui.image().src;ui.dialog().close();
    assert.equal(ui.dialog().open,false);assert.deepEqual(ui.doc.revoked,[url]);assert.equal(ui.doc.focused,ui.doc.buttons[0]);
  }finally{ui.doc.restore()}
  ui=await shareUi({...fileShare,toBlob:'hold',provider:pickemProvider()});
  try{
    await ui.open();ui.dialog().close();ui.doc.pendingBlob();await flush();
    assert.equal(ui.image().src,undefined);assert.equal(ui.doc.created.length,0,'no URL is made for a closed preview');
  }finally{ui.doc.restore()}
});
await check('the card is one snapshot: a refresh after the preview opens does not change what is shared or copied',async()=>{
  let snapshot=pickem();
  const ui=await shareUi({...fileShare,clipboard:()=>{},provider:pickemProvider(()=>snapshot),href:'https://example.test/nfl-pool/?view=standings&season=2026&week=2'});
  try{
    await ui.open();
    snapshot=pickem({week:6,entries:pickem().entries.map(e=>({...e,w:e.w+1,left:e.left-1})),games:{total:16,final:13,void:0,live:1,remaining:3}});
    await ui.click('Copy summary');
    assert.match(ui.doc.copies[0],/2026 Week 5 · Pick'em Standings[\s\S]*1\. D\.C\. 10–2/);assert.match(ui.doc.copies[0],/&week=5$/,'the snapshot week, not the page URL week');
    await ui.open();await ui.click('Copy link');
    assert.match(ui.doc.copies[1],/&week=6$/,'reopening Share takes a new snapshot');
  }finally{ui.doc.restore()}
});

assert.equal(failures.length,0,`share-card regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
console.log('share-card snapshot checks, truthful status (FINAL, LIVE, DELAYED, stale, unavailable, on hold, under review), privacy, deep links, summaries, layout and text fitting, native file sharing, cancel, download and copy fallbacks and PNG failure regressions passed');
