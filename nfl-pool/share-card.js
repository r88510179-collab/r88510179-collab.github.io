'use strict';
// Shareable Cards V1: the Pick'em and Survivor share cards. A card is built from the snapshot an app answers the
// poolcenter:sharesnapshot request with (weekly-app.js, survivor-app.js) and drawn with Canvas 2D at 1080 × 1350 from
// shapes, gradients and system fonts only: no image, font or network request, and no dependency. Every name, number,
// rank and state on a card comes from that snapshot; a snapshot that is missing, still loading or ON HOLD makes no card.

export const CARD_WIDTH=1080,CARD_HEIGHT=1350;
// The verified public address: the image names it compactly and the share action carries the selected week's deep link.
export const PUBLIC_URL='https://r88510179-collab.github.io/nfl-pool/';
export const SITE_LABEL='r88510179-collab.github.io/nfl-pool';
export const PALETTE=Object.freeze({background:'#0D1117',container:'#1C2128',gold:'#D4AF37',alive:'#2EA043',out:'#F85149',pending:'#D29922',final:'#E53935',text:'#FFFFFF',muted:'#8B949E'});
// Scores older than LIVE_FRESH_MS read DELAYED while games remain, as the page header says. A resolved week can no longer
// move with the scores, only with a republished revision or a ruling, which every refresh re-verifies; one not re-verified
// within FINAL_FRESH_MS reads DELAYED too.
export const LIVE_FRESH_MS=30000,FINAL_FRESH_MS=5*60*1000;
const MAX_ROWS=8;

const plural=(n,one,many=`${one}S`)=>`${n} ${n===1?one:many}`;
const upper=s=>String(s??'').toUpperCase();
function stampParts(ms,timeZone){
  const parts=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short',...(timeZone?{timeZone}:{})}).formatToParts(new Date(ms));
  const get=type=>parts.find(p=>p.type===type)?.value||'';
  return{date:`${get('month')} ${get('day')}, ${get('year')}`,time:`${get('hour')}:${get('minute')} ${get('dayPeriod')} ${get('timeZoneName')}`.trim()};
}
// "Oct 18, 2026 · 12:05 PM EDT" in the viewer's time zone (or the one given), named so the stamp is never ambiguous.
export function formatStamp(ms,timeZone){const {date,time}=stampParts(ms,timeZone);return`${date} · ${time}`}
const formatClock=(ms,timeZone)=>stampParts(ms,timeZone).time;
const validWeek=s=>Number.isSafeInteger(s?.season)&&s.season>0&&Number.isSafeInteger(s?.week)&&s.week>0&&Number.isSafeInteger(s?.revision)&&s.revision>0;

// The selected week's deep link: the view the card was made from, at that season and week.
export function deepLink(contest,season,week){
  const u=new URL(PUBLIC_URL);
  u.searchParams.set('view',contest==='survivor'?'survivor':'standings');
  u.searchParams.set('season',String(season));
  u.searchParams.set(contest==='survivor'?'sw':'week',String(week));
  return u.href;
}

// When the scores behind a snapshot were last verified, and whether that is too long ago for its state.
function delayed(s,now,resolved,timeZone){
  const at=Date.parse(s.scoresAt),age=now-at;
  if(Number.isFinite(at)&&age>=-60000&&age<=(resolved?FINAL_FRESH_MS:LIVE_FRESH_MS))return null;
  return Number.isFinite(at)?`SCORES LAST VERIFIED ${upper(formatClock(at,timeZone))}`:'SCORE AGE UNKNOWN';
}
// One status per card, most serious first: STALE (the publication or the latest refresh could not be verified) over
// PROVISIONAL (warnings, rulings under review or stale, unresolved entries) over DELAYED over FINAL or LIVE. The detail
// names the reasons, then a live week's progress.
function cardStatus({stale,provisional,late,resolved,progress}){
  const detail=reasons=>[...reasons,progress].filter(Boolean).join(' · ')||null;
  if(stale.length)return{key:'stale',label:'STALE',tone:'stale',detail:detail(stale)};
  if(provisional.length)return{key:'provisional',label:'PROVISIONAL',tone:'pending',detail:detail(provisional)};
  if(late)return{key:'delayed',label:'DELAYED',tone:'pending',detail:detail([late])};
  return resolved?{key:'final',label:'FINAL',tone:'final',detail:detail([])}:{key:'live',label:'LIVE',tone:'live',detail:detail([])};
}

export function pickemStatus(s,now=Date.now(),timeZone){
  if(!s||s.contest!=='pickem'||!validWeek(s))return{ok:false,reason:"Pick'em standings have not loaded yet."};
  if(s.hold)return{ok:false,reason:`Pick'em standings are on hold (${s.hold}), so no card can be made until the contest rules and rulings load.`};
  if(!s.scoresAt)return{ok:false,reason:s.scoresFailed?`Week ${s.week} scores could not be loaded yet. Try again after the next refresh.`:`Week ${s.week} scores are still loading.`};
  if(!Array.isArray(s.entries)||!s.entries.length||!s.games)return{ok:false,reason:'No tracked entries are published for this week.'};
  const g=s.games,resolved=g.remaining===0;
  const stale=[s.publicationStale?'PUBLISHED DATA STALE':'',s.scoresFailed?'SCORE FEED UNAVAILABLE':''].filter(Boolean);
  const provisional=[s.warnings?plural(s.warnings,'FEED WARNING'):'',s.underReview?`${plural(s.underReview,'RULING')} UNDER REVIEW`:'',s.rulingsStale?'RULINGS STALE':''].filter(Boolean);
  const voids=g.void?`${plural(g.void,'GAME')} VOID BY RULING`:'',noTiebreak=s.tiebreak?.void?'NO TIEBREAK THIS WEEK':'';
  const progress=resolved?[voids,noTiebreak].filter(Boolean).join(' · '):[`${g.final} OF ${plural(g.total,'GAME')} FINAL`,g.live?`${g.live} LIVE`:'',voids].filter(Boolean).join(' · ');
  return{ok:true,...cardStatus({stale,provisional,late:delayed(s,now,resolved,timeZone),resolved,progress})};
}

export function survivorStatus(s,now=Date.now(),timeZone){
  if(!s||s.contest!=='survivor'||!validWeek(s))return{ok:false,reason:'Survivor results have not loaded yet.'};
  if(s.hold)return{ok:false,reason:`Survivor results are on hold (${s.hold}), so no card can be made until the contest rules and rulings load.`};
  if(!s.scoresAt)return{ok:false,reason:s.scoresFailed?`Week ${s.week} results could not be loaded yet. Try again after the next refresh.`:`Week ${s.week} results are still loading.`};
  if(!Array.isArray(s.entries)||!s.entries.length||!s.totals)return{ok:false,reason:'No tracked Survivor entries are published for this week.'};
  const resolved=s.totals.pending===0;
  const stale=[s.publicationStale?'PUBLISHED DATA STALE':'',s.scoresFailed?'RESULT FEED UNAVAILABLE':''].filter(Boolean);
  const entries=n=>plural(n,'ENTRY','ENTRIES');
  const provisional=[...(s.flags||[]),s.awaitingRuling?`${entries(s.awaitingRuling)} AWAITING RULING`:'',s.onHold?`${entries(s.onHold)} ON HOLD`:'',
    s.unresolvedPrior?`${entries(s.unresolvedPrior)} AWAITING AN EARLIER RESULT`:'',s.awaitingRulingPrior?`${entries(s.awaitingRulingPrior)} AWAITING AN EARLIER RULING`:'',
    s.onHoldPrior?`${entries(s.onHoldPrior)} ON HOLD IN AN EARLIER WEEK`:'',s.rulingsStale?'RULINGS STALE':''].filter(Boolean);
  return{ok:true,...cardStatus({stale,provisional,late:delayed(s,now,resolved,timeZone),resolved,progress:''})};
}

// The tracked group's placement: tied entries share a rank (T-), a sole leader's ribbon reads 1ST.
const placeLabel=e=>e.rank===1&&!e.tied?'1ST':`${e.tied?'T-':''}${e.rank}`;
const record=e=>`${e.w}–${e.l}`;
function finish(card,s,status,now,timeZone){
  const stamp=formatStamp(now,timeZone),url=deepLink(card.contest,s.season,s.week);
  return{...card,ok:true,season:s.season,week:s.week,revision:s.revision,status,url,urlLabel:SITE_LABEL,
    meta:upper(`Snapshot ${stamp} · revision ${s.revision}`),stamp,
    filename:`pool-center-${card.contest}-${s.season}-week-${s.week}.png`,
    shareTitle:`Pool Center · ${card.heading} · ${s.season} Week ${s.week}`};
}

export function pickemCard(s,{now=Date.now(),timeZone}={}){
  const status=pickemStatus(s,now,timeZone);
  if(!status.ok)return{ok:false,contest:'pickem',reason:status.reason};
  const shown=s.entries.slice(0,MAX_ROWS),field=Number.isSafeInteger(s.fieldSize)&&s.fieldSize>0?s.fieldSize:null;
  // Gold marks the group's leader, or its tied leaders, only while someone trails them: when every entry is level (as before
  // a week's first final) nobody leads, so no row is gold.
  const leads=s.entries.some(e=>e.rank!==1);
  const rows=shown.map(e=>({place:placeLabel(e),name:String(e.name),record:record(e),rank:field&&e.fieldRank?e.fieldRank:null,leader:leads&&e.rank===1,note:e.noSubmission?'NO PICKS SUBMITTED':null}));
  const card=finish({contest:'pickem',heading:"Pick'em Standings",title:['PICK\u2019EM','STANDINGS'],rows,more:s.entries.length-shown.length,
    total:field?{label:'TOTAL POOL ENTRIES:',value:String(field)}:null,fieldNote:field?null:'FULL-FIELD RANKS UNAVAILABLE FOR THIS WEEK'},s,status,now,timeZone);
  const lines=[`Pool Center · Pick'em Standings`,`${s.season} Week ${s.week} · ${status.label}${status.detail?` (${status.detail.toLowerCase()})`:''}`,
    ...s.entries.map(e=>`${placeLabel(e)}  ${e.name}  ${record(e)}${field&&e.fieldRank?`  · field ${e.fieldRank}`:''}${e.noSubmission?'  · no picks submitted':''}`),
    field?`Total pool entries: ${field}`:'Full-field ranks unavailable for this week',`Snapshot ${card.stamp} · revision ${s.revision}`,card.url];
  return{...card,text:lines.join('\n'),
    alt:`Pick'em standings card, ${s.season} Week ${s.week}, ${status.label}. ${s.entries.map(e=>`${placeLabel(e)} ${e.name} ${record(e)}${field&&e.fieldRank?`, field rank ${e.fieldRank}`:''}`).join('; ')}.${field?` Total pool entries ${field}.`:''}`};
}

// Survivor rows lead with entries still in play, then the eliminated ones, longest survivor first.
const SURVIVOR_ORDER={ALIVE:0,LIVE:1,PENDING:2,RULING:3,HOLD:4,OUT:5};
const SURVIVOR_TONE={ALIVE:'alive',LIVE:'pending',PENDING:'pending',RULING:'pending',HOLD:'pending',OUT:'out'};
export function survivorCard(s,{now=Date.now(),timeZone}={}){
  const status=survivorStatus(s,now,timeZone);
  if(!status.ok)return{ok:false,contest:'survivor',reason:status.reason};
  const t=s.totals,sorted=s.entries.slice().sort((a,b)=>(SURVIVOR_ORDER[a.status]??9)-(SURVIVOR_ORDER[b.status]??9)||(b.eliminatedWeek??0)-(a.eliminatedWeek??0)||a.order-b.order);
  const rows=sorted.slice(0,MAX_ROWS).map(e=>({name:String(e.name),status:String(e.status),tone:SURVIVOR_TONE[e.status]||'pending',note:[e.reason,e.underReview?'under review':''].filter(Boolean).join(' · ')||null}));
  const metrics=[{label:'TOTAL FIELD:',value:String(t.field),accent:true},{label:'REMAINING:',value:String(t.remaining)},{label:'SUBMISSIONS:',value:String(t.submissions)},{label:'PENDING:',value:String(t.pending),tone:t.pending>0?'pending':'neutral'}];
  const card=finish({contest:'survivor',heading:'Survivor Pool',title:['SURVIVOR POOL'],rows,more:s.entries.length-rows.length,metrics,
    total:{label:'TOTAL SURVIVOR ENTRIES:',value:String(t.field)}},s,status,now,timeZone);
  const lines=['Pool Center · Survivor Pool',`${s.season} Week ${s.week} · ${status.label}${status.detail?` (${status.detail.toLowerCase()})`:''}`,
    `Total field ${t.field} · Remaining ${t.remaining} · Submissions ${t.submissions} · Pending ${t.pending}`,
    ...sorted.map(e=>`${e.name}: ${e.status}${e.reason?` · ${e.reason}`:''}`),`Snapshot ${card.stamp} · revision ${s.revision}`,card.url];
  return{...card,text:lines.join('\n'),
    alt:`Survivor pool card, ${s.season} Week ${s.week}, ${status.label}. Total field ${t.field}, remaining ${t.remaining}, submissions ${t.submissions}, pending ${t.pending}. ${sorted.map(e=>`${e.name} ${e.status}`).join('; ')}.`};
}

// ---- Drawing. Everything below draws on a 1080 × 1350 Canvas 2D context; nothing reads the page or the network.

// Bold condensed system faces first (Windows, Apple, Android), then any bold sans: text that is still too wide is
// squeezed a little, then set smaller, then shortened with an ellipsis, so nothing is ever clipped.
const DISPLAY='Bahnschrift,"DIN Condensed","Avenir Next Condensed","Roboto Condensed",sans-serif-condensed,"Arial Narrow","Helvetica Neue",Inter,Roboto,"Segoe UI",Arial,sans-serif';
const TEXT='"Roboto Condensed",sans-serif-condensed,"Avenir Next Condensed","DIN Condensed",Bahnschrift,"Helvetica Neue",Inter,Roboto,"Segoe UI",Arial,sans-serif';
function setFont(ctx,size,weight,family,tracking){
  ctx.font=`${weight} ${size}px ${family}`;
  if('fontStretch' in ctx)ctx.fontStretch=family===DISPLAY?'condensed':'normal';
  if('letterSpacing' in ctx)ctx.letterSpacing=`${Math.round(size*tracking*10)/10}px`;
}
function measure(ctx,text,size,weight,family,tracking){setFont(ctx,size,weight,family,tracking);return ctx.measureText(text).width}
export function fitText(ctx,text,{size,min=Math.round(size*0.62),width,weight=800,family=TEXT,tracking=0,squeeze=0.84}){
  text=String(text??'');min=Math.min(min,size);width=Math.max(8,width);
  for(let s=size;;s=Math.max(min,Math.floor(s*0.95))){
    const w=measure(ctx,text,s,weight,family,tracking);
    if(w<=width)return{text,size:s,scale:1,width:w,weight,family,tracking};
    if(w*squeeze<=width)return{text,size:s,scale:width/w,width,weight,family,tracking};
    if(s===min){
      let t=text;
      while(t.length>1&&measure(ctx,`${t}…`,s,weight,family,tracking)*squeeze>width)t=t.slice(0,-1).trimEnd();
      const out=`${t}…`,ow=measure(ctx,out,s,weight,family,tracking);
      return{text:out,size:s,scale:Math.min(1,width/ow),width:Math.min(ow,width),weight,family,tracking,truncated:true};
    }
  }
}
// Draws fitted text and records the box it was given, so a test (or a review) can prove every text fits where it is drawn.
function drawText(ctx,L,f,x,y,{align='left',fill='#fff',shadow=null,role,box}){
  ctx.save();setFont(ctx,f.size,f.weight,f.family,f.tracking);ctx.textAlign=align;ctx.textBaseline='alphabetic';
  if(shadow){ctx.shadowColor=shadow.color;ctx.shadowBlur=shadow.blur;ctx.shadowOffsetY=shadow.y||0}
  ctx.translate(x,y);if(f.scale!==1)ctx.scale(f.scale,1);
  ctx.fillStyle=typeof fill==='function'?fill(ctx,f):fill;ctx.fillText(f.text,0,0);ctx.restore();
  const left=align==='left'?x:align==='right'?x-f.width:x-f.width/2;
  L.texts.push({role,text:f.text,x:left,width:f.width,top:y-f.size*0.78,bottom:y+f.size*0.22,size:f.size,scale:f.scale,truncated:!!f.truncated,box});
}
function linear(ctx,x0,y0,x1,y1,stops){const g=ctx.createLinearGradient(x0,y0,x1,y1);for(const [o,c] of stops)g.addColorStop(o,c);return g}
function radial(ctx,x,y,r0,r1,stops){const g=ctx.createRadialGradient(x,y,r0,x,y,r1);for(const [o,c] of stops)g.addColorStop(o,c);return g}
const GOLD_TEXT=[[0,'#fff1b8'],[0.45,'#e9c75a'],[0.62,PALETTE.gold],[1,'#a37a1f']];
const SILVER_TEXT=[[0,'#ffffff'],[0.2,'#eef1f4'],[0.46,'#c5ccd4'],[0.5,'#8e97a2'],[0.58,'#aeb6bf'],[0.82,'#e2e6eb'],[1,'#f7f9fb']];
const verticalFill=stops=>(ctx,f)=>linear(ctx,0,-f.size*0.8,0,f.size*0.12,stops);
function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
function chamfer(ctx,x,y,w,h,c){ctx.beginPath();ctx.moveTo(x+c,y);ctx.lineTo(x+w-c,y);ctx.lineTo(x+w,y+c);ctx.lineTo(x+w,y+h-c);ctx.lineTo(x+w-c,y+h);ctx.lineTo(x+c,y+h);ctx.lineTo(x,y+h-c);ctx.lineTo(x,y+c);ctx.closePath()}
// A small seeded generator, so the stadium's scattered lights are the same on every render of a card.
function seeded(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}

// The night stadium: navy sky, two floodlight banks with their beams, the stands, the field in perspective and a vignette.
function paintStadium(ctx,theme){
  const W=CARD_WIDTH,H=CARD_HEIGHT;
  ctx.fillStyle=linear(ctx,0,0,0,H,[[0,'#04070c'],[0.3,'#0a1322'],[0.58,PALETTE.background],[1,'#030508']]);ctx.fillRect(0,0,W,H);
  ctx.save();ctx.globalCompositeOperation='lighter';
  ctx.fillStyle=radial(ctx,W/2,560,0,640,[[0,'rgba(38,74,132,0.30)'],[0.6,'rgba(24,46,86,0.12)'],[1,'rgba(0,0,0,0)']]);ctx.fillRect(0,0,W,H);
  // Pick'em's banks are blue and warm gold, Survivor's both blue, as in the two designs.
  const banks=theme==='pickem'?[{x:58,y:448,c:[150,196,255]},{x:1022,y:448,c:[255,214,140]}]:[{x:40,y:312,c:[150,196,255]},{x:1040,y:312,c:[150,196,255]}];
  for(const b of banks){
    const rgb=a=>`rgba(${b.c[0]},${b.c[1]},${b.c[2]},${a})`,dir=b.x<W/2?1:-1;
    ctx.fillStyle=radial(ctx,b.x,b.y,0,560,[[0,rgb(0.5)],[0.3,rgb(0.17)],[1,rgb(0)]]);ctx.fillRect(0,0,W,H);
    for(const [spread,alpha] of [[0.16,0.2],[0.32,0.11],[0.5,0.06]]){
      ctx.beginPath();ctx.moveTo(b.x,b.y-30);ctx.lineTo(b.x+dir*W*(0.62+spread),b.y+H*(0.28+spread*0.4));ctx.lineTo(b.x+dir*W*(0.30+spread*0.2),b.y+H*(0.62+spread*0.3));ctx.closePath();
      ctx.fillStyle=linear(ctx,b.x,b.y,b.x+dir*W*0.6,b.y+H*0.45,[[0,rgb(alpha)],[1,rgb(0)]]);ctx.fill();
    }
    for(let r=0;r<4;r++)for(let c=0;c<3;c++){
      const x=b.x+dir*(c*30-30+r*6),y=b.y-62+r*30;
      ctx.fillStyle=radial(ctx,x,y,0,20,[[0,'rgba(255,255,255,1)'],[0.32,rgb(0.85)],[1,rgb(0)]]);ctx.fillRect(x-20,y-20,40,40);
    }
  }
  // The stadium's ring of lights, a soft band behind the rows.
  ctx.fillStyle=linear(ctx,0,640,0,780,[[0,'rgba(47,111,214,0)'],[0.5,'rgba(47,111,214,0.26)'],[1,'rgba(47,111,214,0)']]);ctx.fillRect(0,640,W,140);
  ctx.restore();
  // The stands: tiers of seats and scattered lights, kept faint so the rows stay the focus.
  const rand=seeded(theme==='pickem'?20261:20262);
  ctx.save();ctx.fillStyle=linear(ctx,0,700,0,1010,[[0,'rgba(8,14,24,0)'],[0.35,'rgba(10,18,30,0.75)'],[1,'rgba(6,10,16,0.9)']]);ctx.fillRect(0,700,W,310);
  ctx.strokeStyle='rgba(120,150,190,0.06)';ctx.lineWidth=2;for(let y=760;y<1000;y+=34){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y+((y/34)%2?6:-6));ctx.stroke()}
  for(let i=0;i<150;i++){const x=rand()*W,y=730+rand()*260,r=0.8+rand()*2.2;ctx.fillStyle=`rgba(${rand()<0.3?'255,220,150':'170,200,255'},${(0.05+rand()*0.22).toFixed(3)})`;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill()}
  ctx.restore();
  // The field: turf below the stands with yard lines converging on the far end.
  ctx.save();ctx.beginPath();ctx.rect(0,1000,W,H-1000);ctx.clip();
  ctx.fillStyle=linear(ctx,0,1000,0,H,[[0,'#06110b'],[0.5,'#0a1d12'],[1,'#040a06']]);ctx.fillRect(0,1000,W,H-1000);
  const vx=W/2;ctx.lineWidth=2;
  for(let i=-6;i<=6;i++){const bx=vx+i*230;ctx.strokeStyle=`rgba(230,240,255,${i===0?0.14:0.07})`;ctx.beginPath();ctx.moveTo(vx+(bx-vx)*0.28,1000);ctx.lineTo(bx,H);ctx.stroke()}
  for(let y=1030,k=0;y<H;y+=26+k*9,k++){ctx.strokeStyle='rgba(230,240,255,0.05)';ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke()}
  ctx.restore();
  ctx.fillStyle=radial(ctx,W/2,H*0.44,280,980,[[0,'rgba(0,0,0,0)'],[1,'rgba(0,0,0,0.68)']]);ctx.fillRect(0,0,W,H);
}
// Faint broadcast dot matrix over the sky.
function paintDots(ctx,y0,y1,alpha){ctx.save();ctx.fillStyle=`rgba(150,180,220,${alpha})`;ctx.beginPath();for(let y=y0;y<y1;y+=10)for(let x=(y/10)%2*5;x<CARD_WIDTH;x+=10)ctx.rect(x,y,1.6,1.6);ctx.fill();ctx.restore()}
// Survivor's broadcast frame: angular blue and gold accents in two corners.
function paintFrame(ctx){
  ctx.save();ctx.lineJoin='miter';
  const glow=(color,blur)=>{ctx.shadowColor=color;ctx.shadowBlur=blur};
  glow('rgba(56,139,253,0.8)',14);ctx.strokeStyle='rgba(56,139,253,0.85)';ctx.lineWidth=3;
  ctx.beginPath();ctx.moveTo(760,16);ctx.lineTo(880,16);ctx.lineTo(906,42);ctx.lineTo(1080,42);ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,1046);ctx.lineTo(26,1072);ctx.lineTo(26,1200);ctx.stroke();
  glow('rgba(212,175,55,0.7)',10);ctx.strokeStyle=PALETTE.gold;ctx.lineWidth=4;
  ctx.beginPath();ctx.moveTo(924,26);ctx.lineTo(1080,26);ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,1090);ctx.lineTo(46,1136);ctx.lineTo(46,1238);ctx.lineTo(0,1284);ctx.stroke();
  ctx.shadowColor='transparent';
  ctx.fillStyle=linear(ctx,0,1100,60,1260,[[0,'rgba(31,111,235,0.55)'],[1,'rgba(31,111,235,0.08)']]);
  ctx.beginPath();ctx.moveTo(0,1112);ctx.lineTo(30,1142);ctx.lineTo(30,1232);ctx.lineTo(0,1262);ctx.closePath();ctx.fill();
  ctx.restore();
}

// The Pool Center emblem, drawn from the paths of the app's own icon (assets/pool-center-icon.svg, 512 × 512).
const EMBLEM={shield:'M256 78 401 134v126c0 91-54 157-145 197-91-40-145-106-145-197V134z',inner:'M256 101 378 148v111c0 73-42 128-122 167-80-39-122-94-122-167V148z',
  p:'M166 174h88c31 0 53 20 53 50 0 30-22 50-53 50h-43v82h-45zm45 38v25h39c9 0 15-5 15-13s-6-12-15-12z',
  c:'M354 198c-15-18-34-27-58-27-52 0-88 40-88 93 0 54 36 95 88 95 25 0 46-10 61-29l-31-29c-8 10-17 15-29 15-25 0-42-21-42-52 0-30 17-50 42-50 12 0 22 5 30 15z',
  laces:['M151 330 231 380','M158 306 245 360','M176 291 256 341']};
function paintEmblem(ctx,x,y,size){
  if(typeof Path2D!=='function')return;
  const path=d=>new Path2D(d),red=()=>linear(ctx,0,0,0,512,[[0,'#ef4b52'],[0.52,'#c52b32'],[1,'#7d1016']]);
  ctx.save();ctx.translate(x,y);ctx.scale(size/512,size/512);
  ctx.shadowColor='rgba(0,0,0,0.7)';ctx.shadowBlur=30;ctx.shadowOffsetY=12;
  roundRect(ctx,0,0,512,512,104);ctx.fillStyle=linear(ctx,0,0,512,512,[[0,'#151b22'],[1,'#07090d']]);ctx.fill();
  ctx.shadowColor='transparent';ctx.strokeStyle='rgba(255,255,255,0.10)';ctx.lineWidth=6;ctx.stroke();
  ctx.fillStyle=radial(ctx,256,265,0,190,[[0,'rgba(213,45,52,0.30)'],[1,'rgba(213,45,52,0)']]);ctx.fillRect(0,0,512,512);
  ctx.lineJoin='round';
  ctx.fillStyle='#0c0f14';ctx.fill(path(EMBLEM.shield));
  ctx.strokeStyle=linear(ctx,0,0,512,512,[[0,'#f6b0b4'],[0.25,'#7b1015'],[0.7,'#f06a70'],[1,'#590b0f']]);ctx.lineWidth=15;ctx.stroke(path(EMBLEM.shield));
  ctx.strokeStyle=red();ctx.lineWidth=18;ctx.stroke(path(EMBLEM.inner));
  for(const d of [EMBLEM.p,EMBLEM.c]){ctx.fillStyle=red();ctx.fill(path(d));ctx.strokeStyle='#571015';ctx.lineWidth=5;ctx.stroke(path(d))}
  ctx.lineCap='round';for(const d of EMBLEM.laces){ctx.strokeStyle='#8f171d';ctx.lineWidth=10;ctx.stroke(path(d));ctx.strokeStyle='rgba(239,108,114,0.85)';ctx.lineWidth=2;ctx.stroke(path(d))}
  ctx.restore();
}
// The emblem and the POOL CENTER wordmark, centred: on a gold-edged plate for Pick'em, between gold rules for Survivor.
function paintBrand(ctx,L,theme,cy){
  const icon=theme==='pickem'?74:70,gap=20,f=fitText(ctx,'POOL CENTER',{size:theme==='pickem'?48:52,width:520,weight:900,family:DISPLAY,tracking:0.07});
  const total=icon+gap+f.width,x=Math.round(CARD_WIDTH/2-total/2);
  if(theme==='pickem'){
    const px=x-30,pw=total+60,py=cy-icon/2-14,ph=icon+28;
    ctx.save();ctx.shadowColor='rgba(0,0,0,0.6)';ctx.shadowBlur=24;ctx.shadowOffsetY=8;chamfer(ctx,px,py,pw,ph,18);
    ctx.fillStyle=linear(ctx,0,py,0,py+ph,[[0,'#1b2a44'],[0.5,'#101a2c'],[1,'#0a111e']]);ctx.fill();ctx.shadowColor='transparent';
    ctx.strokeStyle=linear(ctx,0,py,0,py+ph,[[0,'#f6e3a1'],[0.5,PALETTE.gold],[1,'#7a5a17']]);ctx.lineWidth=3;ctx.stroke();ctx.restore();
  }else{
    ctx.save();for(const [y,w] of [[cy-icon/2-12,1.5],[cy+icon/2+12,3]]){ctx.fillStyle=linear(ctx,x+icon+gap,0,x+total,0,[[0,'rgba(212,175,55,0)'],[0.15,PALETTE.gold],[0.85,'#f3dc8a'],[1,'rgba(212,175,55,0)']]);ctx.fillRect(x+icon+gap,y-w/2,f.width,w)}ctx.restore();
  }
  paintEmblem(ctx,x,cy-icon/2,icon);
  drawText(ctx,L,f,x+icon+gap,cy+f.size*0.36,{fill:verticalFill(SILVER_TEXT),shadow:{color:'rgba(0,0,0,0.7)',blur:10,y:4},role:'brand',box:[x+icon+gap,x+total]});
}
// Chrome title lettering with a gold edge, a dark outline and a drop shadow.
function paintTitle(ctx,L,text,cx,baseline,{size,width}){
  const f=fitText(ctx,text,{size,min:Math.round(size*0.7),width,weight:900,family:DISPLAY,tracking:0.01,squeeze:0.78});
  ctx.save();setFont(ctx,f.size,f.weight,f.family,f.tracking);ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.lineJoin='round';
  ctx.translate(cx,baseline);if(f.scale!==1)ctx.scale(f.scale,1);
  const top=-f.size*0.76,bottom=f.size*0.04;
  ctx.shadowColor='rgba(0,0,0,0.8)';ctx.shadowBlur=30;ctx.shadowOffsetY=14;ctx.strokeStyle='#04060a';ctx.lineWidth=f.size*0.09;ctx.strokeText(f.text,0,0);ctx.shadowColor='transparent';
  ctx.fillStyle='#2d333b';ctx.fillText(f.text,0,f.size*0.04);
  ctx.strokeStyle=linear(ctx,0,top,0,bottom,[[0,'#fbe9a6'],[0.5,PALETTE.gold],[1,'#8c6a1c']]);ctx.lineWidth=f.size*0.046;ctx.strokeText(f.text,0,0);
  ctx.fillStyle=linear(ctx,0,top,0,bottom,SILVER_TEXT);ctx.fillText(f.text,0,0);
  ctx.restore();
  L.texts.push({role:'title',text:f.text,x:cx-f.width/2,width:f.width,top:baseline-f.size*0.78,bottom:baseline+f.size*0.22,size:f.size,scale:f.scale,truncated:!!f.truncated,box:[cx-width/2,cx+width/2]});
}
const TONE={final:PALETTE.final,live:PALETTE.alive,pending:PALETTE.pending,stale:PALETTE.pending,alive:PALETTE.alive,out:PALETTE.out};
const shade=(hex,k)=>{const n=parseInt(hex.slice(1),16),c=[n>>16,n>>8&255,n&255].map(v=>Math.max(0,Math.min(255,Math.round(k>0?v+(255-v)*k:v*(1+k)))));return`rgb(${c.join(',')})`};
// A glossy status pill in its tone's colour; amber pills carry dark lettering, and STALE is an amber outline on dark, so
// it never reads as a settled state.
function paintPill(ctx,L,text,tone,cx,cy,{w,h,size,role}){
  const color=TONE[tone]||PALETTE.pending,x=cx-w/2,y=cy-h/2,r=Math.min(h/2,18),outline=tone==='stale',amber=color===PALETTE.pending&&!outline;
  ctx.save();ctx.shadowColor=color;ctx.shadowBlur=outline?14:22;roundRect(ctx,x,y,w,h,r);
  ctx.fillStyle=outline?linear(ctx,0,y,0,y+h,[[0,'#2b2210'],[1,'#120d04']]):linear(ctx,0,y,0,y+h,[[0,shade(color,0.28)],[0.48,color],[0.52,shade(color,-0.12)],[1,shade(color,-0.38)]]);ctx.fill();
  ctx.shadowColor='transparent';ctx.strokeStyle=outline?color:shade(color,0.45);ctx.lineWidth=outline?4:2.5;ctx.stroke();
  if(!outline){roundRect(ctx,x+5,y+4,w-10,h*0.42,Math.max(2,r-5));ctx.fillStyle='rgba(255,255,255,0.14)';ctx.fill()}
  ctx.restore();
  const f=fitText(ctx,text,{size,width:w-28,weight:900,family:DISPLAY,tracking:0.03});
  drawText(ctx,L,f,cx,cy+f.size*0.35,{align:'center',fill:outline?shade(color,0.3):amber?'#1d1503':'#ffffff',shadow:amber?{color:'rgba(255,236,180,0.35)',blur:2,y:1}:{color:'rgba(0,0,0,0.55)',blur:4,y:2},role,box:[x+14,x+w-14]});
}
// A metallic plate with chamfered corners: gold for the Pick'em group leader, dark steel otherwise.
function paintPlate(ctx,{x,y,w,h},gold){
  const c=Math.round(h*0.17);
  ctx.save();
  ctx.shadowColor=gold?'rgba(212,175,55,0.42)':'rgba(0,0,0,0.6)';ctx.shadowBlur=gold?44:26;ctx.shadowOffsetY=gold?0:10;chamfer(ctx,x,y,w,h,c);
  ctx.fillStyle=gold?linear(ctx,0,y,0,y+h,[[0,'#f8e7a4'],[0.2,'#e5c463'],[0.52,'#c9a043'],[0.82,'#a77f2b'],[1,'#d6b257']]):linear(ctx,0,y,0,y+h,[[0,'#2c323b'],[0.5,'#171c23'],[1,'#0e1217']]);
  ctx.fill();ctx.shadowColor='transparent';
  ctx.save();ctx.clip();
  ctx.globalAlpha=gold?0.10:0.05;ctx.strokeStyle=gold?'#5a420c':'#ffffff';ctx.lineWidth=1;for(let yy=y+3;yy<y+h;yy+=4){ctx.beginPath();ctx.moveTo(x,yy);ctx.lineTo(x+w,yy);ctx.stroke()}
  ctx.globalAlpha=1;ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'rgba(255,255,255,0)'],[0.5,`rgba(255,255,255,${gold?0.30:0.06})`],[1,'rgba(255,255,255,0)']]);ctx.fillRect(x,y,w,h*0.48);
  ctx.restore();
  // The texture lines replaced the current path, so the outline is traced again before it is stroked.
  chamfer(ctx,x,y,w,h,c);ctx.strokeStyle=gold?linear(ctx,0,y,0,y+h,[[0,'#fff3c4'],[0.5,'#c79b35'],[1,'#7a5913']]):linear(ctx,0,y,0,y+h,[[0,'#e9edf1'],[0.5,'#8b949e'],[1,'#525a64']]);ctx.lineWidth=gold?4:3;ctx.stroke();
  chamfer(ctx,x+9,y+8,w-18,h-16,Math.max(4,c-6));ctx.strokeStyle=gold?'rgba(92,66,12,0.55)':'rgba(255,255,255,0.08)';ctx.lineWidth=2;ctx.stroke();
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'rgba(255,255,255,0)'],[0.5,gold?'rgba(255,252,235,0.95)':'rgba(220,232,255,0.75)'],[1,'rgba(255,255,255,0)']]);ctx.fillRect(x+c,y-1,w-2*c,2.5);ctx.fillRect(x+c+w*0.2,y+h-1.5,w-2*c-w*0.4,2);
  ctx.restore();
}
// The leader's 1ST ribbon, hanging from the top edge of the gold plate.
function paintRibbon(ctx,L,text,x,y,w,h){
  const notch=Math.round(w*0.2);
  ctx.save();ctx.shadowColor='rgba(0,0,0,0.45)';ctx.shadowBlur=14;ctx.shadowOffsetY=6;
  ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+w,y);ctx.lineTo(x+w,y+h);ctx.lineTo(x+w/2,y+h-notch);ctx.lineTo(x,y+h);ctx.closePath();
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'#b48a2c'],[0.5,'#f2d989'],[1,'#a98128']]);ctx.fill();ctx.shadowColor='transparent';
  ctx.strokeStyle='#6f5214';ctx.lineWidth=2.5;ctx.stroke();
  ctx.beginPath();ctx.moveTo(x+6,y+6);ctx.lineTo(x+w-6,y+6);ctx.lineTo(x+w-6,y+h-8);ctx.lineTo(x+w/2,y+h-notch-6);ctx.lineTo(x+6,y+h-8);ctx.closePath();ctx.strokeStyle='rgba(111,82,20,0.55)';ctx.lineWidth=1.5;ctx.stroke();
  ctx.restore();
  const f=fitText(ctx,text,{size:Math.round(w*0.42),width:w-16,weight:900,family:DISPLAY,tracking:0.01});
  drawText(ctx,L,f,x+w/2,y+(h-notch)*0.5+f.size*0.36,{align:'center',fill:'#241a05',role:'place',box:[x+8,x+w-8]});
}
// A status line: "SEASON 2026 • WEEK 5" with the status after it. Pick'em's FINAL is part of its gold line, as designed;
// every other Pick'em state and every Survivor state is a pill, so a state that is not final stands apart from the gold.
function paintStatusLine(ctx,L,card,cy,{gold}){
  const head=`SEASON ${card.season} • WEEK ${card.week}`,s=card.status,shadow={color:'rgba(0,0,0,0.85)',blur:12,y:4};
  if(!gold||s.key!=='final'){
    const size=gold?46:50,f=fitText(ctx,head,{size,width:620,weight:800,family:DISPLAY,tracking:gold?0.05:0.03}),pw=Math.max(190,Math.min(340,s.label.length*30+70)),gap=24,total=f.width+gap+pw,x=CARD_WIDTH/2-total/2;
    drawText(ctx,L,f,x,cy+f.size*0.35,{fill:verticalFill(gold?GOLD_TEXT:SILVER_TEXT),shadow,role:'status',box:[x,x+f.width]});
    paintPill(ctx,L,s.label,s.tone,x+f.width+gap+pw/2,cy,{w:pw,h:gold?62:68,size:gold?38:42,role:'status-pill'});
    return;
  }
  const text=`${head} ${s.label}`,f=fitText(ctx,text,{size:48,width:920,weight:800,family:DISPLAY,tracking:0.05});
  drawText(ctx,L,f,CARD_WIDTH/2,cy+f.size*0.35,{align:'center',fill:verticalFill(GOLD_TEXT),shadow,role:'status',box:[80,1000]});
}
function paintDetail(ctx,L,card,cy){
  const s=card.status,detail=[s.detail,card.more>0?`+${card.more} MORE TRACKED`:''].filter(Boolean).join(' · ');
  if(!detail)return;
  const f=fitText(ctx,detail,{size:26,min:20,width:940,weight:800,tracking:0.08});
  drawText(ctx,L,f,CARD_WIDTH/2,cy+f.size*0.35,{align:'center',fill:s.tone==='pending'||s.tone==='stale'?shade(PALETTE.pending,0.25):'#b4bdc8',shadow:{color:'rgba(0,0,0,0.8)',blur:8,y:2},role:'detail',box:[70,1010]});
}
function paintTotal(ctx,L,total,cy){
  const size=52,tracking=0.02,lw=measure(ctx,`${total.label} `,size,900,DISPLAY,tracking),vw=measure(ctx,total.value,size,900,DISPLAY,tracking),max=920,k=Math.min(1,max/(lw+vw));
  const f1={text:`${total.label} `,size,scale:k,width:lw*k,weight:900,family:DISPLAY,tracking},f2={text:total.value,size,scale:k,width:vw*k,weight:900,family:DISPLAY,tracking},x=CARD_WIDTH/2-(f1.width+f2.width)/2;
  const shadow={color:'rgba(0,0,0,0.85)',blur:14,y:5},box=[CARD_WIDTH/2-max/2,CARD_WIDTH/2+max/2];
  drawText(ctx,L,f1,x,cy+size*0.35,{fill:verticalFill(SILVER_TEXT),shadow,role:'total',box});
  drawText(ctx,L,f2,x+f1.width,cy+size*0.35,{fill:verticalFill(GOLD_TEXT),shadow,role:'total-value',box});
}
function paintMeta(ctx,L,text,cy){
  const f=fitText(ctx,text,{size:22,min:16,width:920,weight:700,tracking:0.1});
  drawText(ctx,L,f,CARD_WIDTH/2,cy+f.size*0.35,{align:'center',fill:'#9aa4b0',role:'meta',box:[80,1000]});
}
function paintSite(ctx,L,text,cy,size){
  const f=fitText(ctx,text,{size,min:18,width:860,weight:800,tracking:0.05});
  drawText(ctx,L,f,CARD_WIDTH/2,cy+f.size*0.35,{align:'center',fill:'#d4dae1',shadow:{color:'rgba(0,0,0,0.8)',blur:8,y:2},role:'site',box:[110,970]});
}

// The rows' boxes: equal rows (leaders a little taller on Pick'em), shrunk together when the content needs more room and
// centred when it needs less.
function rowBoxes(rows,top,bottom,{base,gap,lead=1,inset}){
  const n=rows.length,tall=rows.filter(r=>r.leader).length,need=h=>tall*h*lead+(n-tall)*h+(n-1)*gap*(h/base);
  let h=base;if(need(h)>bottom-top)h=Math.max(56,base*(bottom-top)/need(base));
  const g=gap*(h/base);let y=top+Math.max(0,(bottom-top-need(h))/2);
  return rows.map(r=>{const rh=Math.round(r.leader?h*lead:h),box={...inset(r),y:Math.round(y),h:rh};y+=rh+g;return box});
}

function paintPickem(ctx,L,card){
  paintStadium(ctx,'pickem');paintDots(ctx,0,640,0.035);
  paintBrand(ctx,L,'pickem',100);
  paintTitle(ctx,L,card.title[0],CARD_WIDTH/2,318,{size:150,width:800});
  paintTitle(ctx,L,card.title[1],CARD_WIDTH/2,452,{size:150,width:900});
  paintStatusLine(ctx,L,card,512,{gold:true});
  const detail=!!(card.status.detail||card.more>0);if(detail)paintDetail(ctx,L,card,556);
  const ranked=card.rows.some(r=>r.rank),boxes=rowBoxes(card.rows,detail?592:568,1176,{base:122,gap:22,lead:1.22,inset:r=>r.leader?{x:56,w:968}:{x:96,w:888}});
  L.boxes.push(...boxes.map(b=>({role:'row',...b})));
  const recordRight=ranked?742:900;
  card.rows.forEach((row,i)=>{
    const b=boxes[i],h=b.h,gold=row.leader;
    paintPlate(ctx,b,gold);
    let nameX;
    if(gold){
      const rw=Math.round(h*0.78);paintRibbon(ctx,L,row.place,b.x+38,b.y-12,rw,Math.round(h*0.9));nameX=b.x+38+rw+30;
      if(ranked){
        const lf=fitText(ctx,'FIELD RANK',{size:Math.round(h*0.16),width:200,weight:800,tracking:0.12}),right=b.x+b.w-52;
        drawText(ctx,L,lf,right,b.y+h*0.36,{align:'right',fill:'#4a380c',role:'rank-label',box:[right-200,right]});
        const vf=fitText(ctx,row.rank,{size:Math.round(h*0.4),width:200,weight:900,family:DISPLAY,tracking:0.01});
        drawText(ctx,L,vf,right,b.y+h*0.78,{align:'right',fill:'#1c1404',role:'rank',box:[right-200,right]});
      }
    }else{
      const pf=fitText(ctx,row.place,{size:Math.round(h*0.42),width:104,weight:900,family:DISPLAY,tracking:0.01});
      drawText(ctx,L,pf,b.x+74,b.y+h*0.5+pf.size*0.36,{align:'center',fill:verticalFill(GOLD_TEXT),shadow:{color:'rgba(0,0,0,0.6)',blur:6,y:2},role:'place',box:[b.x+22,b.x+126]});
      nameX=b.x+148;
      if(ranked){
        const right=b.x+b.w-46,vf=fitText(ctx,row.rank,{size:Math.round(h*0.4),width:190,weight:900,family:DISPLAY,tracking:0.01});
        drawText(ctx,L,vf,right,b.y+h*0.5+vf.size*0.36,{align:'right',fill:verticalFill(GOLD_TEXT),shadow:{color:'rgba(0,0,0,0.6)',blur:6,y:2},role:'rank',box:[right-190,right]});
      }
    }
    const rf=fitText(ctx,row.record,{size:Math.round(h*(gold?0.44:0.4)),width:170,weight:900,family:DISPLAY,tracking:0.01});
    drawText(ctx,L,rf,recordRight,b.y+h*0.5+rf.size*0.36,{align:'right',fill:gold?'#1c1404':verticalFill(SILVER_TEXT),shadow:gold?null:{color:'rgba(0,0,0,0.6)',blur:6,y:2},role:'record',box:[recordRight-170,recordRight]});
    const nameMax=recordRight-rf.width-34-nameX,nf=fitText(ctx,row.name,{size:Math.round(h*(gold?0.48:0.44)),min:Math.round(h*0.28),width:nameMax,weight:900,family:DISPLAY,tracking:0.005});
    const nameY=row.note?b.y+h*0.5+nf.size*0.12:b.y+h*0.5+nf.size*0.36;
    drawText(ctx,L,nf,nameX,nameY,{fill:gold?'#16110a':'#ffffff',shadow:gold?{color:'rgba(255,240,190,0.45)',blur:2,y:1}:{color:'rgba(0,0,0,0.7)',blur:6,y:3},role:'name',box:[nameX,nameX+nameMax]});
    if(row.note){const of=fitText(ctx,row.note,{size:Math.max(18,Math.round(h*0.16)),min:16,width:nameMax,weight:800,tracking:0.08});drawText(ctx,L,of,nameX,nameY+of.size*1.5,{fill:gold?'#4a380c':PALETTE.muted,role:'note',box:[nameX,nameX+nameMax]})}
  });
  if(card.total)paintTotal(ctx,L,card.total,1222);
  else{const f=fitText(ctx,card.fieldNote,{size:30,min:20,width:920,weight:800,tracking:0.06});drawText(ctx,L,f,CARD_WIDTH/2,1222+f.size*0.35,{align:'center',fill:'#aeb7c2',role:'total',box:[80,1000]})}
  paintMeta(ctx,L,card.meta,1270);
  paintSite(ctx,L,card.urlLabel,1314,28);
}

function paintMetric(ctx,L,m,x,y,w,h){
  ctx.save();ctx.shadowColor='rgba(0,0,0,0.6)';ctx.shadowBlur=22;ctx.shadowOffsetY=8;
  for(const side of [x-7,x+w-3]){roundRect(ctx,side,y+h*0.24,10,h*0.52,4);ctx.fillStyle=linear(ctx,0,y,0,y+h,[[0,'#e9edf1'],[0.5,'#8b949e'],[1,'#4a525b']]);ctx.fill()}
  roundRect(ctx,x,y,w,h,20);ctx.fillStyle=linear(ctx,0,y,0,y+h,[[0,'#2a3039'],[0.5,PALETTE.container],[0.52,'#161b22'],[1,'#0f1318']]);ctx.fill();ctx.shadowColor='transparent';
  ctx.strokeStyle=m.accent?linear(ctx,0,y,0,y+h,[[0,'#f6e3a1'],[0.5,PALETTE.gold],[1,'#7a5a17']]):linear(ctx,0,y,0,y+h,[[0,'#dfe4e9'],[0.5,'#7d8590'],[1,'#4a525b']]);ctx.lineWidth=m.accent?3.5:3;ctx.stroke();
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'rgba(255,255,255,0)'],[0.5,'rgba(220,232,255,0.6)'],[1,'rgba(255,255,255,0)']]);ctx.fillRect(x+20,y-1,w-40,2);
  ctx.restore();
  const lf=fitText(ctx,m.label,{size:25,min:18,width:w-28,weight:800,tracking:0.03});
  drawText(ctx,L,lf,x+w/2,y+46,{align:'center',fill:'#e8d7a8',role:'metric-label',box:[x+14,x+w-14]});
  const vf=fitText(ctx,m.value,{size:76,min:40,width:w-30,weight:900,family:DISPLAY,tracking:0.01});
  const fill=m.tone==='neutral'?verticalFill(SILVER_TEXT):m.tone==='pending'?shade(PALETTE.pending,0.1):verticalFill(GOLD_TEXT);
  drawText(ctx,L,vf,x+w/2,y+h-24,{align:'center',fill,shadow:{color:'rgba(0,0,0,0.7)',blur:10,y:4},role:'metric-value',box:[x+15,x+w-15]});
}
function paintSurvivorRow(ctx,L,row,b){
  const {x,y,w,h}=b,split=x+w-316,alive=row.tone==='alive',accent=TONE[row.tone]||PALETTE.pending;
  ctx.save();ctx.shadowColor=alive?'rgba(46,160,67,0.45)':'rgba(0,0,0,0.6)';ctx.shadowBlur=alive?36:24;ctx.shadowOffsetY=alive?0:10;
  roundRect(ctx,x,y,w,h,22);ctx.fillStyle=linear(ctx,0,y,0,y+h,[[0,'#2d343d'],[0.48,'#1b2028'],[0.5,'#161b22'],[1,'#0d1116']]);ctx.fill();ctx.shadowColor='transparent';
  ctx.save();ctx.clip();
  if(alive){ctx.fillStyle=linear(ctx,x,0,split,0,[[0,'rgba(46,160,67,0.30)'],[0.55,'rgba(46,160,67,0.06)'],[1,'rgba(46,160,67,0)']]);ctx.fillRect(x,y,split-x,h)}
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'rgba(255,255,255,0)'],[0.45,'rgba(255,255,255,0.07)'],[1,'rgba(255,255,255,0)']]);ctx.fillRect(x,y,w,h*0.48);
  ctx.fillStyle='rgba(5,8,12,0.55)';ctx.fillRect(split,y,x+w-split,h);
  ctx.restore();
  ctx.strokeStyle=alive?linear(ctx,0,y,0,y+h,[[0,'#7ee2a0'],[0.5,PALETTE.alive],[1,'#1a6b30']]):linear(ctx,0,y,0,y+h,[[0,'#e6eaee'],[0.5,'#8b949e'],[1,'#4b535c']]);ctx.lineWidth=alive?4:3;ctx.stroke();
  ctx.strokeStyle='rgba(139,148,158,0.55)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(split,y+3);ctx.lineTo(split,y+h-3);ctx.stroke();
  roundRect(ctx,split+16,y+14,x+w-split-32,h-28,14);ctx.strokeStyle=alive?'rgba(126,226,160,0.55)':`${accent}55`;ctx.lineWidth=2;ctx.shadowColor=alive?PALETTE.alive:accent;ctx.shadowBlur=10;ctx.stroke();ctx.shadowColor='transparent';
  if(alive){ctx.fillStyle=linear(ctx,0,y,0,y+h,[[0,'#7ee2a0'],[1,'#1a6b30']]);roundRect(ctx,x+10,y+18,7,h-36,3);ctx.fill()}
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'rgba(255,255,255,0)'],[0.5,'rgba(220,232,255,0.7)'],[1,'rgba(255,255,255,0)']]);ctx.fillRect(x+30,y-1,split-x-60,2);
  ctx.restore();
  const nameMax=split-x-90,nf=fitText(ctx,row.name,{size:Math.round(h*0.5),min:Math.round(h*0.3),width:nameMax,weight:900,family:DISPLAY,tracking:0.005});
  const nameY=row.note?y+h*0.5+nf.size*0.1:y+h*0.5+nf.size*0.36;
  drawText(ctx,L,nf,x+52,nameY,{fill:verticalFill(SILVER_TEXT),shadow:{color:'rgba(0,0,0,0.75)',blur:8,y:3},role:'name',box:[x+52,x+52+nameMax]});
  if(row.note){const of=fitText(ctx,upper(row.note),{size:Math.max(20,Math.round(h*0.16)),min:18,width:nameMax,weight:800,tracking:0.06});drawText(ctx,L,of,x+52,nameY+of.size*1.6,{fill:alive?'#8fd6a5':PALETTE.muted,role:'note',box:[x+52,x+52+nameMax]})}
  paintPill(ctx,L,row.status,row.tone,split+(x+w-split)/2,y+h/2,{w:x+w-split-64,h:Math.round(h*0.56),size:Math.round(h*0.33),role:'row-status'});
}
function paintSurvivor(ctx,L,card){
  paintStadium(ctx,'survivor');paintDots(ctx,0,700,0.05);paintFrame(ctx);
  paintBrand(ctx,L,'survivor',96);
  paintTitle(ctx,L,card.title[0],CARD_WIDTH/2,318,{size:172,width:900});
  paintStatusLine(ctx,L,card,396,{gold:false});
  const detail=!!(card.status.detail||card.more>0);if(detail)paintDetail(ctx,L,card,452);
  const my=detail?482:462,mh=150,gap=22,mw=(CARD_WIDTH-2*58-3*gap)/4;
  card.metrics.forEach((m,i)=>{L.boxes.push({role:'metric',x:58+i*(mw+gap),y:my,w:mw,h:mh});paintMetric(ctx,L,m,58+i*(mw+gap),my,mw,mh)});
  const boxes=rowBoxes(card.rows,my+mh+28,1124,{base:136,gap:22,inset:()=>({x:56,w:968})});
  L.boxes.push(...boxes.map(b=>({role:'row',...b})));
  card.rows.forEach((row,i)=>paintSurvivorRow(ctx,L,row,boxes[i]));
  paintTotal(ctx,L,card.total,1168);
  paintMeta(ctx,L,card.meta,1214);
  ctx.save();ctx.fillStyle=linear(ctx,0,1256,0,CARD_HEIGHT,[[0,'rgba(10,14,20,0.92)'],[1,'#05070a']]);ctx.fillRect(0,1256,CARD_WIDTH,CARD_HEIGHT-1256);
  ctx.fillStyle=linear(ctx,0,0,CARD_WIDTH,0,[[0,'rgba(139,148,158,0)'],[0.5,'rgba(220,226,232,0.85)'],[1,'rgba(139,148,158,0)']]);ctx.fillRect(0,1255,CARD_WIDTH,2);
  ctx.fillStyle=linear(ctx,900,0,CARD_WIDTH,0,[[0,'rgba(212,175,55,0)'],[1,PALETTE.gold]]);ctx.beginPath();ctx.moveTo(880,1268);ctx.lineTo(CARD_WIDTH,1268);ctx.lineTo(CARD_WIDTH,1280);ctx.lineTo(892,1280);ctx.closePath();ctx.fill();
  ctx.restore();
  paintSite(ctx,L,card.urlLabel,1306,30);
}

// Draws a ready card (pickemCard / survivorCard) and returns where everything went: each text with the box it was given and
// its fitted width and size, and each row and metric box.
export function drawShareCard(ctx,card){
  if(!card?.ok)throw new Error('Only a ready share card can be drawn');
  const L={width:CARD_WIDTH,height:CARD_HEIGHT,texts:[],boxes:[]};
  ctx.save();ctx.clearRect(0,0,CARD_WIDTH,CARD_HEIGHT);
  if(card.contest==='pickem')paintPickem(ctx,L,card);else paintSurvivor(ctx,L,card);
  ctx.restore();
  return L;
}
