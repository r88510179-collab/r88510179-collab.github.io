// Pool Center shareable cards, the pure part (share-ui.js is the page part). An app answers the poolcenter:share event with a
// snapshot of what it shows: weekly-app.js the Pick'em standings, survivor-app.js the Survivor week. This module checks that
// snapshot, decides the one status the card may truthfully claim, and turns it into the card: its text, its deep link and its
// 1080 x 1350 PNG layout drawn on any Canvas 2D context. No DOM, no network and no scoring: every record, rank and count comes
// from the snapshot, so a card says only what the page says, and a snapshot that does not hold together is refused. The
// drawing is the stadium broadcast design (night stadium, floodlights, metallic titles, a gold plate for the Pick'em group
// leader, dark steel rows), made from shapes, gradients and system fonts only.

export const CARD_WIDTH=1080,CARD_HEIGHT=1350;
// Scores or results older than this when the snapshot is taken are DELAYED, never LIVE or FINAL. weekly-app.js calls its feed
// DELAYED past the same age, and both apps refresh every 20 s while their view is visible, so only a page that is not keeping
// up (just resumed, or on a stalled network) reaches it.
export const FRESH_SECONDS=30;
// The tracked rows a card has room for at a readable size (cardLayout keeps every row at least MIN_ROW px tall up to these):
// Pick'em tracks four entries and Survivor exactly three (survivor-app.js validates three).
export const MAX_ROWS={pickem:5,survivor:3};
export const SURVIVOR_STATUSES=['ALIVE','LIVE','PENDING','RULING','HOLD','OUT'];

const isInt=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const isBool=v=>v===true||v===false;
const isText=(v,max)=>typeof v==='string'&&v.trim()!==''&&v.length<=max;
const plural=(n,one,many=`${one}s`)=>`${n} ${n===1?one:many}`;
const refuse=reason=>({ok:false,reason});
function unique(rows){const seen=new Set();for(const x of rows){const key=x.name.trim().toLowerCase();if(seen.has(key))return false;seen.add(key)}return true}

// ---- Checks. A snapshot is the app's own state, so none of these can fail on a working page; each one stands between a
// regression elsewhere and a card that would present it as fact.
function identityProblem(s){
  if(!isInt(s.season,1)||!isInt(s.week,1))return 'the season and week are missing';
  if(!isInt(s.revision,1))return 'the publication record for this week is missing';
  return null;
}
const stateProblem=s=>[s.hold,s.rulingsStale,s.publishedStale].every(isBool)?null:'the ruling and publication state is missing';
// A full-field rank as fieldRankLabel() wrote it: its digits are the rank, and the rank and its ties lie inside the field.
const fieldRankValid=(x,size)=>!!x&&isInt(x.rank,1)&&isInt(x.tieCount,1)&&x.rank+x.tieCount-1<=size&&typeof x.label==='string'&&x.label.length<=8&&
  x.label.replace(/\D/g,'')===String(x.rank)&&isInt(x.topPercent,1)&&x.topPercent<=100&&isInt(x.behind);
function pickemProblem(s){
  const problem=identityProblem(s)||stateProblem(s);if(problem)return problem;
  const g=s.games,f=s.feed,rows=s.entries;
  if(!g||![g.total,g.final,g.void,g.live,g.remaining].every(n=>isInt(n))||g.total<1||g.final+g.void+g.remaining!==g.total||g.live>g.remaining)return 'the game counts do not add up';
  if(!f||typeof f.fetchedAt!=='string'||!Number.isFinite(Date.parse(f.fetchedAt))||!isBool(f.failed)||!isBool(f.incomplete)||!isInt(f.warnings)||!isBool(f.review))return 'the score feed state is missing';
  if(!s.tiebreak||!isBool(s.tiebreak.final)||!isBool(s.tiebreak.void))return 'the tiebreak state is missing';
  if(s.fieldSize!==null&&!isInt(s.fieldSize,1))return 'the field size is invalid';
  if(!Array.isArray(rows)||!rows.length)return 'there are no tracked entries';
  if(rows.length>MAX_ROWS.pickem)return `only ${MAX_ROWS.pickem} tracked entries fit on a card`;
  if(s.fieldSize!==null&&s.fieldSize<rows.length)return 'the field is smaller than the tracked group';
  for(const [i,e] of rows.entries()){
    if(!e||!isText(e.name,60))return 'a tracked entry has no name';
    // A void game is no win, no loss and no game left, so every record covers exactly the other games.
    if(![e.w,e.l,e.left].every(n=>isInt(n))||e.w+e.l+e.left!==g.total-g.void)return `the record of ${e.name} does not match this week's games`;
    // Competition ranking, in standings order: 1 first, then either the rank above (tied) or the row's own position.
    if(!isInt(e.groupRank,1)||(i===0?e.groupRank!==1:e.groupRank!==rows[i-1].groupRank&&e.groupRank!==i+1))return 'the group standings are out of order';
    if(!isBool(e.leader)||e.leader!==(e.groupRank===1)||!isBool(e.noPicks))return `the standing of ${e.name} is invalid`;
    if(e.tiebreakDelta!==null&&!isInt(e.tiebreakDelta))return `the tiebreak of ${e.name} is invalid`;
    if(s.fieldSize===null?e.field!==null:!fieldRankValid(e.field,s.fieldSize))return `the full-field rank of ${e.name} is invalid`;
  }
  if(!unique(rows))return 'the tracked entries are not unique';
  return null;
}
const COUNT_KEYS=['active','pending','out','outThisWeek','submitted','legalPicks','awaitingRuling','onHold'];
function survivorProblem(s){
  const problem=identityProblem(s)||stateProblem(s);if(problem)return problem;
  const c=s.counts,f=s.feed,rows=s.tracked;
  if(!isInt(s.fieldSize,1))return 'the field size is invalid';
  if(!c||!COUNT_KEYS.every(k=>isInt(c[k])))return 'the field counts are missing';
  // Every entry is exactly one of: still in (alive or pending), out, awaiting a ruling, on hold.
  if(c.active+c.out+c.awaitingRuling+c.onHold!==s.fieldSize||c.pending>c.active||c.outThisWeek>c.out||c.legalPicks>c.submitted||c.submitted>s.fieldSize)return 'the field counts do not add up';
  if(!f||!Number.isFinite(f.at)||!isBool(f.failed))return 'the result feed state is missing';
  if(!Array.isArray(s.flags)||s.flags.some(x=>!isText(x,60)))return 'the result flags are invalid';
  if(!Array.isArray(rows)||!rows.length)return 'there are no tracked entries';
  if(rows.length>MAX_ROWS.survivor)return `only ${MAX_ROWS.survivor} tracked entries fit on a card`;
  if(rows.length>s.fieldSize)return 'the field is smaller than the tracked entries';
  for(const t of rows){
    if(!t||!isText(t.name,60))return 'a tracked entry has no name';
    if(!SURVIVOR_STATUSES.includes(t.status))return `the status of ${t.name} is invalid`;
    if(t.team!==null&&!(typeof t.team==='string'&&/^[A-Z]{2,3}$/.test(t.team)))return `the team of ${t.name} is invalid`;
    if(typeof t.reason!=='string'||t.reason.length>200||!isBool(t.underReview))return `the state of ${t.name} is invalid`;
  }
  if(!unique(rows))return 'the tracked entries are not unique';
  return null;
}

// ---- Status. The precedence is the page header's (weekly-app.js setSync and its FEED UNAVAILABLE path; survivor-app.js
// updateScores), made stricter for an image that outlives the page: rulings that could not be refreshed are named first,
// data past FRESH_SECONDS is DELAYED, and FINAL is claimed only when nothing at all qualifies the result.
export function clockTime(ms,timeZone){return new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone}).format(ms)}
export function snapshotLabel(ms,timeZone){return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short',timeZone}).format(ms)}
// The age of a reading, as weekly-app.js ageSeconds() takes it: unknown when the time is invalid or more than a minute ahead.
export function ageSeconds(ms,now){if(!Number.isFinite(ms))return null;const delta=now-ms;return delta<-60000?null:Math.max(0,Math.floor(delta/1000))}
const BAD=new Set(['FEED UNAVAILABLE','RESULT FEED UNAVAILABLE','ON HOLD']);
// The first state that holds is claimed and every other one rides along as a qualifier, except DELAYED under a feed that
// failed (it says no more than that), and a card that is behind always says as of when. With no state at all, the clean
// claim (LIVE or FINAL) stands; qualifiers the app adds (Survivor's team flags) make it a warning.
function settle(states,clean,{flags=[],asOf}){
  const [primary,...rest]=states,delayed=states.some(x=>x.label==='DELAYED');
  if(!primary)return{...clean,tone:flags.length?'warn':clean.tone,flags};
  const unavailable=primary.label.endsWith('FEED UNAVAILABLE'),extra=rest.filter(x=>!(unavailable&&x.label==='DELAYED')).map(x=>x.label);
  return{label:primary.label,tone:BAD.has(primary.label)?'bad':'warn',detail:delayed&&!unavailable&&primary.label!=='DELAYED'?`${primary.detail} · ${asOf}`:primary.detail,flags:[...extra,...flags]};
}
export function pickemStatus(s,{now=Date.now(),timeZone}={}){
  const {total,final,void:voids,live,remaining}=s.games,at=Date.parse(s.feed.fetchedAt),age=ageSeconds(at,now);
  const progress=remaining?`${final} of ${total} games final${voids?` · ${voids} void`:''}${live?` · ${live} live`:''}`
    :voids?`All ${total} games resolved · ${voids} void`:`All ${total} games final`;
  const asOf=clockTime(at,timeZone);
  const states=[
    s.feed.failed&&{label:'FEED UNAVAILABLE',detail:`Score feed unavailable · last verified ${asOf} · ${progress}`},
    s.hold&&{label:'ON HOLD',detail:'Ruling data unavailable · no game is graded until the rulings load'},
    s.feed.incomplete&&{label:'INCOMPLETE',detail:`${plural(s.feed.warnings,'feed warning')} · unverified feed data is not counted · ${progress}`},
    s.feed.review&&{label:'UNDER REVIEW',detail:`A commissioner ruling is under review · ${progress}`},
    s.publishedStale&&{label:'PUBLISHED DATA STALE',detail:`Newest publication not verified · revision ${s.revision} shown · ${progress}`},
    s.rulingsStale&&{label:'RULINGS STALE',detail:`Rulings not refreshed · last verified rulings apply · ${progress}`},
    (age===null||age>FRESH_SECONDS)&&{label:'DELAYED',detail:`Scores as of ${asOf} · ${progress}`}
  ].filter(Boolean);
  return settle(states,remaining?{label:'LIVE',tone:'ok',detail:progress}:{label:'FINAL',tone:'final',detail:progress},{asOf:`scores as of ${asOf}`});
}
export function survivorStatus(s,{now=Date.now(),timeZone}={}){
  const c=s.counts,age=ageSeconds(s.feed.at,now),asOf=clockTime(s.feed.at,timeZone),open=c.pending||c.awaitingRuling||c.onHold;
  const progress=open?[c.pending&&`${plural(c.pending,'entry','entries')} pending`,c.awaitingRuling&&`${c.awaitingRuling} awaiting a ruling`,c.onHold&&`${c.onHold} on hold`].filter(Boolean).join(' · ')
    :`All ${plural(s.fieldSize,'entry','entries')} decided`;
  const states=[
    s.feed.failed&&{label:'RESULT FEED UNAVAILABLE',detail:`Result feed unavailable · last verified ${asOf} · ${progress}`},
    s.hold&&{label:'ON HOLD',detail:'Ruling data unavailable · no result is graded until the rulings load'},
    s.publishedStale&&{label:'PUBLISHED DATA STALE',detail:`Newest publication not verified · revision ${s.revision} shown · ${progress}`},
    s.rulingsStale&&{label:'RULINGS STALE',detail:`Rulings not refreshed · last verified rulings apply · ${progress}`},
    (age===null||age>FRESH_SECONDS)&&{label:'DELAYED',detail:`Results as of ${asOf} · ${progress}`}
  ].filter(Boolean);
  // The team flags the header shows (unverified, awaiting a ruling, on hold, under review) always ride along, and a week
  // with any of them is never FINAL.
  return settle(states,open||s.flags.length?{label:'LIVE',tone:'ok',detail:progress}:{label:'FINAL',tone:'final',detail:`Week ${s.week} results final · ${progress.toLowerCase()}`},{flags:s.flags,asOf:`results as of ${asOf}`});
}

// ---- Links and names. A link opens the same published week in the same view, in the spelling each app boots from: Pick'em
// reads view, season and week; Survivor reads view=survivor, season and sw.
export function shareLink(contest,{season,week},href){
  const u=new URL('./',href);u.search='';u.hash='';
  const params=contest==='pickem'?[['view','standings'],['season',season],['week',week]]:[['view','survivor'],['season',season],['sw',week]];
  for(const [k,v] of params)u.searchParams.set(k,String(v));
  return u.href;
}
export function linkLabel(href){const u=new URL('./',href);return`${u.host}${u.pathname}`.replace(/\/+$/,'')}
export function shareFileName(card){return`nfl-pool-center-${card.contest}-${card.season}-week-${card.week}.png`}

// ---- The card.
export function buildCard(contest,snapshot,{now=Date.now(),href,timeZone}={}){
  if(contest!=='pickem'&&contest!=='survivor')return refuse('There is no card for this view.');
  if(!snapshot||typeof snapshot!=='object')return refuse('Sharing needs the latest Pool Center. Reload the page and try again.');
  if(snapshot.ready!==true)return refuse(isText(snapshot.reason,200)?snapshot.reason:'There is nothing to share yet.');
  if(snapshot.contest!==contest)return refuse('The page answered for a different contest. Reload the page and try again.');
  const problem=contest==='pickem'?pickemProblem(snapshot):survivorProblem(snapshot);
  if(problem)return refuse(`A card can't be made right now: ${problem}.`);
  const base={ok:true,contest,season:snapshot.season,week:snapshot.week,revision:snapshot.revision,capturedAt:now,
    snapshot:snapshotLabel(now,timeZone),link:shareLink(contest,snapshot,href),linkLabel:linkLabel(href)};
  const card=contest==='pickem'?{...base,...pickemCard(snapshot,{now,timeZone})}:{...base,...survivorCard(snapshot,{now,timeZone})};
  card.fileName=shareFileName(card);
  card.summary=summaryText(card);
  card.shareTitle=`NFL Pool Center · ${card.season} Week ${card.week} ${card.title}`;
  card.shareText=`${card.season} Week ${card.week} ${card.title} · ${card.status.label}\n${card.link}`;
  card.alt=`${card.title} card, ${card.season} Week ${card.week}: ${card.summary.split('\n').slice(1,-2).join('. ')}`;
  return card;
}
// The tracked group's place as the card shows it: tied entries share a place (T-2), a sole leader's ribbon reads 1ST. Gold
// marks the leader, or the tied leaders, only while someone trails them: when every entry is level nobody leads. A row's
// note says what its record alone does not: no picks submitted, or, where records are level, the tiebreak that split them.
function pickemCard(s,options){
  const size=s.fieldSize,leads=s.entries.some(e=>!e.leader);
  const rows=s.entries.map(e=>{
    const tied=s.entries.filter(x=>x.groupRank===e.groupRank).length>1,record=`${e.w}–${e.l}`;
    const tiebreak=s.tiebreak.final&&e.tiebreakDelta!==null?`Tiebreak Δ ${e.tiebreakDelta}`:null,level=s.entries.some(x=>x!==e&&x.w===e.w&&x.l===e.l);
    return{rank:String(e.groupRank),place:e.groupRank===1&&!tied?'1ST':`${tied?'T-':''}${e.groupRank}`,name:e.name.trim(),record,leader:e.leader,gold:leads&&e.leader,noPicks:e.noPicks,
      note:e.noPicks?'No picks submitted':tiebreak&&level?tiebreak:null,tiebreak,overall:e.field?e.field.label:null,overallOf:e.field?`of ${size}`:null};
  });
  return{title:"Pick'em Standings",status:pickemStatus(s,options),fieldSize:size,rows,
    total:size===null?null:{label:'TOTAL POOL ENTRIES:',value:String(size)},
    fieldNote:size===null?'Full-field ranks are not published for this week.':null};
}
// Survivor's panels are the field's own counts (never the Pick'em pool's): the whole field, the entries still in, this
// week's submissions and the entries still pending. The rows lead with entries still in play, then the eliminated ones, each
// group in the page's order; ALIVE is green, never gold, since a tracked entry is not the field's leader.
const SURVIVOR_ORDER={ALIVE:0,LIVE:1,PENDING:2,RULING:3,HOLD:4,OUT:5};
function survivorCard(s,options){
  const c=s.counts;
  return{title:'Survivor Pool',status:survivorStatus(s,options),fieldSize:s.fieldSize,counts:{...c},
    metrics:[{label:'TOTAL FIELD:',value:String(s.fieldSize),accent:true},{label:'REMAINING:',value:String(c.active)},{label:'SUBMISSIONS:',value:String(c.submitted)},
      {label:'PENDING:',value:String(c.pending),tone:c.pending?'pending':'neutral'}],
    rows:s.tracked.map((t,i)=>({t,i})).sort((a,b)=>SURVIVOR_ORDER[a.t.status]-SURVIVOR_ORDER[b.t.status]||a.i-b.i)
      .map(({t})=>({name:t.name.trim(),team:t.team,status:t.status,review:t.underReview,note:t.underReview?`UNDER REVIEW · ${t.reason}`:t.reason})),
    total:{label:'TOTAL SURVIVOR ENTRIES:',value:String(s.fieldSize)}};
}
function summaryText(card){
  const st=card.status,lines=[`NFL Pool Center · ${card.season} Week ${card.week} · ${card.title}`,`${[st.label,...st.flags].join(' · ')} — ${st.detail}`];
  if(card.contest==='pickem'){
    for(const r of card.rows)lines.push(`${r.rank}. ${r.name} ${r.record}${r.overall?` · ${r.overall} ${r.overallOf} overall`:''}${r.tiebreak?` · ${r.tiebreak}`:''}${r.noPicks?' · no picks submitted':''}`);
    lines.push(card.fieldNote||`Pool size: ${card.fieldSize} entries`);
  }else{
    const c=card.counts;
    lines.push([`Still in ${c.active} of ${card.fieldSize}`,`Out ${c.out}`,`Pending ${c.pending}`,c.awaitingRuling&&`Awaiting ruling ${c.awaitingRuling}`,c.onHold&&`On hold ${c.onHold}`,`Submitted ${c.submitted}`].filter(Boolean).join(' · '));
    for(const r of card.rows)lines.push(`${r.name}: ${r.status}${r.team?` · ${r.team}`:''}${r.note?` — ${r.note}`:''}`);
  }
  lines.push(`Snapshot ${card.snapshot} · revision ${card.revision}`,card.link);
  return lines.join('\n');
}

// ---- Native sharing. Files are offered to the share sheet only where the browser says it can share them; anything else
// downloads instead. The title and text ride along only where the browser accepts them with the file.
export function shareSupport(nav,file){
  const share=typeof nav?.share==='function';
  let files=false;
  if(share&&file&&typeof nav.canShare==='function'){try{files=nav.canShare({files:[file]})===true}catch{files=false}}
  return{share,files,clipboard:typeof nav?.clipboard?.writeText==='function'};
}
export function sharePayload(card,file,nav){
  const full={files:[file],title:card.shareTitle,text:card.shareText};
  try{if(nav.canShare(full))return full}catch{}
  return{files:[file]};
}

// ---- Text fitting. Every string is measured in the font it is drawn in and drawn with that width as its limit, so nothing a
// snapshot names (a long entry name, a long status) can run past its column or off the card.
export function fitText(ctx,value,maxWidth){
  const s=String(value??'');
  if(ctx.measureText(s).width<=maxWidth)return s;
  const chars=[...s],cut=n=>`${chars.slice(0,n).join('').trimEnd()}…`;
  if(ctx.measureText('…').width>maxWidth)return'';
  let lo=0,hi=chars.length-1;
  while(lo<hi){const mid=(lo+hi+1)>>1;if(ctx.measureText(cut(mid)).width<=maxWidth)lo=mid;else hi=mid-1}
  return cut(lo);
}
// Lines at most maxWidth wide, broken between ' · ' segments where possible (a line never starts with the separator) and
// between words otherwise. The last line takes whatever is left and ends with an ellipsis if that does not fit.
export function wrapText(ctx,value,maxWidth,maxLines=2){
  const tokens=[];
  String(value??'').split(' · ').forEach((part,pi)=>part.split(/\s+/).filter(Boolean).forEach((word,wi)=>tokens.push({word,sep:wi?' ':pi?' · ':''})));
  const join=list=>list.map((t,i)=>i?t.sep+t.word:t.word).join(''),width=list=>ctx.measureText(join(list)).width,lines=[];
  let start=0;
  while(start<tokens.length&&lines.length<maxLines){
    let end=tokens.length;
    if(lines.length<maxLines-1){
      end=start+1;while(end<tokens.length&&width(tokens.slice(start,end+1))<=maxWidth)end++;
      // A break inside a segment moves back to the segment's start when the line stays at least half full, unless that leaves
      // more than the last line can hold where the break inside the segment would not.
      if(end<tokens.length&&tokens[end].sep===' ')for(let k=end-1;k>start;k--)if(tokens[k].sep===' · '){
        const cuts=lines.length===maxLines-2&&width(tokens.slice(k))>maxWidth&&width(tokens.slice(end))<=maxWidth;
        if(width(tokens.slice(start,k))>=maxWidth/2&&!cuts)end=k;break}
    }
    lines.push(fitText(ctx,join(tokens.slice(start,end)),maxWidth));start=end;
  }
  return lines;
}

// ---- Drawing: the stadium broadcast design. A night stadium with two floodlight banks, chrome titles with a gold edge, the
// Pool Center emblem (the app icon's own path data, so there are no images: drawing never needs the network and can never
// taint the canvas), a gold plate and 1ST ribbon for the Pick'em group leader, dark steel rows, and Survivor's four metric
// panels. Every string is fitted to its column and drawn with that width as its limit: a little too wide is condensed
// (never below MIN_CONDENSE), then set smaller, then cut with an ellipsis, so nothing a snapshot names can run off the card.
export const MIN_CONDENSE=0.78;
export const PALETTE=Object.freeze({background:'#0D1117',container:'#1C2128',gold:'#D4AF37',alive:'#2EA043',out:'#F85149',pending:'#D29922',final:'#E53935',text:'#FFFFFF',muted:'#8B949E'});
const W=CARD_WIDTH,H=CARD_HEIGHT;
// Bold condensed system faces first (Windows, Apple, Android), then any bold sans. A context that cannot parse a stack draws
// in sans-serif instead (drawCard checks).
const DISPLAY_FONTS='Bahnschrift,"DIN Condensed","Avenir Next Condensed","Roboto Condensed",sans-serif-condensed,"Arial Narrow","Helvetica Neue",Inter,Roboto,"Segoe UI",Arial,sans-serif';
const TEXT_FONTS='"Roboto Condensed",sans-serif-condensed,"Avenir Next Condensed","DIN Condensed",Bahnschrift,"Helvetica Neue",Inter,Roboto,"Segoe UI",Arial,sans-serif';
let DISPLAY=DISPLAY_FONTS,TEXT=TEXT_FONTS;
function setFont(ctx,size,weight,family,tracking=0){
  ctx.font=`${weight} ${size}px ${family}`;
  if('fontStretch' in ctx)ctx.fontStretch=family===DISPLAY_FONTS?'condensed':'normal';
  if('letterSpacing' in ctx)ctx.letterSpacing=`${Math.round(size*tracking*10)/10}px`;
}
function measure(ctx,text,size,weight,family,tracking){setFont(ctx,size,weight,family,tracking);return ctx.measureText(text).width}
// The size, condensing and (only when nothing else fits) the ellipsis at which text fits width; width is what it is drawn at.
function fitLine(ctx,value,{size,min=Math.round(size*0.62),width,weight=800,family=TEXT,tracking=0,condense=0.84}){
  const text=String(value??'');min=Math.min(min,size);width=Math.max(8,width);
  for(let s=size;;s=Math.max(min,Math.floor(s*0.95))){
    const w=measure(ctx,text,s,weight,family,tracking);
    if(w<=width)return{text,size:s,width:w,weight,family,tracking};
    if(w*condense<=width)return{text,size:s,width,weight,family,tracking};
    if(s===min){
      let t=text;
      while(t.length>1&&measure(ctx,`${t}…`,s,weight,family,tracking)*condense>width)t=t.slice(0,-1).trimEnd();
      const out=`${t}…`;return{text:out,size:s,width:Math.min(measure(ctx,out,s,weight,family,tracking),width),weight,family,tracking,truncated:true};
    }
  }
}
// Draws fitted text at (x, y) with its width as the limit and records it, with the column it was given, in the layout.
function drawText(ctx,L,f,x,y,{align='left',fill='#fff',shadow=null,role,box}){
  ctx.save();setFont(ctx,f.size,f.weight,f.family,f.tracking);ctx.textAlign=align;ctx.textBaseline='alphabetic';
  if(shadow){ctx.shadowColor=shadow.color;ctx.shadowBlur=shadow.blur;ctx.shadowOffsetY=shadow.y||0}
  ctx.fillStyle=typeof fill==='function'?fill(ctx,f,y):fill;ctx.fillText(f.text,x,y,f.width);ctx.restore();
  const left=align==='left'?x:align==='right'?x-f.width:x-f.width/2;
  L.texts.push({role,text:f.text,x:left,width:f.width,top:y-f.size*0.78,bottom:y+f.size*0.22,size:f.size,truncated:!!f.truncated,box});
}
function linear(ctx,x0,y0,x1,y1,stops){const g=ctx.createLinearGradient(x0,y0,x1,y1);for(const [o,c] of stops)g.addColorStop(o,c);return g}
function radial(ctx,x,y,r0,r1,stops){const g=ctx.createRadialGradient(x,y,r0,x,y,r1);for(const [o,c] of stops)g.addColorStop(o,c);return g}
const GOLD_TEXT=[[0,'#fff1b8'],[0.45,'#e9c75a'],[0.62,PALETTE.gold],[1,'#a37a1f']];
const SILVER_TEXT=[[0,'#ffffff'],[0.2,'#eef1f4'],[0.46,'#c5ccd4'],[0.5,'#8e97a2'],[0.58,'#aeb6bf'],[0.82,'#e2e6eb'],[1,'#f7f9fb']];
const verticalFill=stops=>(ctx,f,y)=>linear(ctx,0,y-f.size*0.8,0,y+f.size*0.12,stops);
function roundRect(ctx,x,y,w,h,r){const q=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x+q,y);ctx.arcTo(x+w,y,x+w,y+h,q);ctx.arcTo(x+w,y+h,x,y+h,q);ctx.arcTo(x,y+h,x,y,q);ctx.arcTo(x,y,x+w,y,q);ctx.closePath()}
function chamfer(ctx,x,y,w,h,c){ctx.beginPath();ctx.moveTo(x+c,y);ctx.lineTo(x+w-c,y);ctx.lineTo(x+w,y+c);ctx.lineTo(x+w,y+h-c);ctx.lineTo(x+w-c,y+h);ctx.lineTo(x+c,y+h);ctx.lineTo(x,y+h-c);ctx.lineTo(x,y+c);ctx.closePath()}
const shade=(hex,k)=>{const n=parseInt(hex.slice(1),16),c=[n>>16,n>>8&255,n&255].map(v=>Math.max(0,Math.min(255,Math.round(k>0?v+(255-v)*k:v*(1+k)))));return`rgb(${c.join(',')})`};
// A small seeded generator, so the stadium's scattered lights are the same on every render of a card.
function seeded(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}

// The night stadium: navy sky, two floodlight banks with their beams, the stands, the field in perspective and a vignette.
// Pick'em's banks are blue and warm gold, Survivor's both blue, as in the two designs.
function paintStadium(ctx,contest){
  ctx.fillStyle=linear(ctx,0,0,0,H,[[0,'#04070c'],[0.3,'#0a1322'],[0.58,PALETTE.background],[1,'#030508']]);ctx.fillRect(0,0,W,H);
  ctx.save();ctx.globalCompositeOperation='lighter';
  ctx.fillStyle=radial(ctx,W/2,560,0,640,[[0,'rgba(38,74,132,0.30)'],[0.6,'rgba(24,46,86,0.12)'],[1,'rgba(0,0,0,0)']]);ctx.fillRect(0,0,W,H);
  const banks=contest==='pickem'?[{x:58,y:448,c:[150,196,255]},{x:1022,y:448,c:[255,214,140]}]:[{x:40,y:312,c:[150,196,255]},{x:1040,y:312,c:[150,196,255]}];
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
  const rand=seeded(contest==='pickem'?20261:20262);
  ctx.save();ctx.fillStyle=linear(ctx,0,700,0,1010,[[0,'rgba(8,14,24,0)'],[0.35,'rgba(10,18,30,0.75)'],[1,'rgba(6,10,16,0.9)']]);ctx.fillRect(0,700,W,310);
  ctx.strokeStyle='rgba(120,150,190,0.06)';ctx.lineWidth=2;for(let y=760;y<1000;y+=34){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y+((y/34)%2?6:-6));ctx.stroke()}
  for(let i=0;i<150;i++){const x=rand()*W,y=730+rand()*260,r=0.8+rand()*2.2;ctx.fillStyle=`rgba(${rand()<0.3?'255,220,150':'170,200,255'},${(0.05+rand()*0.22).toFixed(3)})`;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill()}
  ctx.restore();
  // The field: turf below the stands with yard lines converging on the far end.
  ctx.save();ctx.beginPath();ctx.rect(0,1000,W,H-1000);ctx.clip();
  ctx.fillStyle=linear(ctx,0,1000,0,H,[[0,'#06110b'],[0.5,'#0a1d12'],[1,'#040a06']]);ctx.fillRect(0,1000,W,H-1000);
  ctx.lineWidth=2;
  for(let i=-6;i<=6;i++){const bx=W/2+i*230;ctx.strokeStyle=`rgba(230,240,255,${i===0?0.14:0.07})`;ctx.beginPath();ctx.moveTo(W/2+(bx-W/2)*0.28,1000);ctx.lineTo(bx,H);ctx.stroke()}
  for(let y=1030,k=0;y<H;y+=26+k*9,k++){ctx.strokeStyle='rgba(230,240,255,0.05)';ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke()}
  ctx.restore();
  ctx.fillStyle=radial(ctx,W/2,H*0.44,280,980,[[0,'rgba(0,0,0,0)'],[1,'rgba(0,0,0,0.68)']]);ctx.fillRect(0,0,W,H);
}
// Faint broadcast dot matrix over the sky.
function paintDots(ctx,y1,alpha){ctx.save();ctx.fillStyle=`rgba(150,180,220,${alpha})`;ctx.beginPath();for(let y=0;y<y1;y+=10)for(let x=(y/10)%2*5;x<W;x+=10)ctx.rect(x,y,1.6,1.6);ctx.fill();ctx.restore()}
// Survivor's broadcast frame: angular blue and gold accents in two corners.
function paintFrame(ctx){
  ctx.save();ctx.lineJoin='miter';
  ctx.shadowColor='rgba(56,139,253,0.8)';ctx.shadowBlur=14;ctx.strokeStyle='rgba(56,139,253,0.85)';ctx.lineWidth=3;
  ctx.beginPath();ctx.moveTo(760,16);ctx.lineTo(880,16);ctx.lineTo(906,42);ctx.lineTo(W,42);ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,1046);ctx.lineTo(26,1072);ctx.lineTo(26,1200);ctx.stroke();
  ctx.shadowColor='rgba(212,175,55,0.7)';ctx.shadowBlur=10;ctx.strokeStyle=PALETTE.gold;ctx.lineWidth=4;
  ctx.beginPath();ctx.moveTo(924,26);ctx.lineTo(W,26);ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,1090);ctx.lineTo(46,1136);ctx.lineTo(46,1238);ctx.lineTo(0,1284);ctx.stroke();
  ctx.shadowColor='transparent';
  ctx.fillStyle=linear(ctx,0,1100,60,1260,[[0,'rgba(31,111,235,0.55)'],[1,'rgba(31,111,235,0.08)']]);
  ctx.beginPath();ctx.moveTo(0,1112);ctx.lineTo(30,1142);ctx.lineTo(30,1232);ctx.lineTo(0,1262);ctx.closePath();ctx.fill();
  ctx.restore();
}
// The Pool Center emblem from the paths of the app's own icon (assets/pool-center-icon.svg, 512 × 512).
const EMBLEM={shield:'M256 78 401 134v126c0 91-54 157-145 197-91-40-145-106-145-197V134z',inner:'M256 101 378 148v111c0 73-42 128-122 167-80-39-122-94-122-167V148z',
  letters:['M166 174h88c31 0 53 20 53 50 0 30-22 50-53 50h-43v82h-45zm45 38v25h39c9 0 15-5 15-13s-6-12-15-12z',
    'M354 198c-15-18-34-27-58-27-52 0-88 40-88 93 0 54 36 95 88 95 25 0 46-10 61-29l-31-29c-8 10-17 15-29 15-25 0-42-21-42-52 0-30 17-50 42-50 12 0 22 5 30 15z'],
  stripes:['M151 330 231 380','M158 306 245 360','M176 291 256 341']};
function paintEmblem(ctx,x,y,size,P){
  if(typeof P!=='function')return;
  const red=()=>linear(ctx,0,0,0,512,[[0,'#ef4b52'],[0.52,'#c52b32'],[1,'#7d1016']]);
  ctx.save();ctx.translate(x,y);ctx.scale(size/512,size/512);
  ctx.shadowColor='rgba(0,0,0,0.7)';ctx.shadowBlur=30;ctx.shadowOffsetY=12;
  roundRect(ctx,0,0,512,512,104);ctx.fillStyle=linear(ctx,0,0,512,512,[[0,'#151b22'],[1,'#07090d']]);ctx.fill();
  ctx.shadowColor='transparent';ctx.strokeStyle='rgba(255,255,255,0.10)';ctx.lineWidth=6;ctx.stroke();
  ctx.fillStyle=radial(ctx,256,265,0,190,[[0,'rgba(213,45,52,0.30)'],[1,'rgba(213,45,52,0)']]);ctx.fillRect(0,0,512,512);
  ctx.lineJoin='round';
  const shield=new P(EMBLEM.shield);ctx.fillStyle='#0c0f14';ctx.fill(shield);
  ctx.strokeStyle=linear(ctx,0,0,512,512,[[0,'#f6b0b4'],[0.25,'#7b1015'],[0.7,'#f06a70'],[1,'#590b0f']]);ctx.lineWidth=15;ctx.stroke(shield);
  ctx.strokeStyle=red();ctx.lineWidth=18;ctx.stroke(new P(EMBLEM.inner));
  for(const d of EMBLEM.letters){const p=new P(d);ctx.fillStyle=red();ctx.fill(p);ctx.strokeStyle='#571015';ctx.lineWidth=5;ctx.stroke(p)}
  ctx.lineCap='round';for(const d of EMBLEM.stripes){const p=new P(d);ctx.strokeStyle='#8f171d';ctx.lineWidth=10;ctx.stroke(p);ctx.strokeStyle='rgba(239,108,114,0.85)';ctx.lineWidth=2;ctx.stroke(p)}
  ctx.restore();
}
// The emblem and the POOL CENTER wordmark, centred: on a gold-edged plate for Pick'em, between gold rules for Survivor.
function paintBrand(ctx,L,contest,cy,P){
  const pickem=contest==='pickem',icon=pickem?74:70,gap=20,f=fitLine(ctx,'POOL CENTER',{size:pickem?48:52,width:520,weight:900,family:DISPLAY,tracking:0.07});
  const total=icon+gap+f.width,x=Math.round(W/2-total/2);
  ctx.save();
  if(pickem){
    const px=x-30,pw=total+60,py=cy-icon/2-14,ph=icon+28;
    ctx.shadowColor='rgba(0,0,0,0.6)';ctx.shadowBlur=24;ctx.shadowOffsetY=8;chamfer(ctx,px,py,pw,ph,18);
    ctx.fillStyle=linear(ctx,0,py,0,py+ph,[[0,'#1b2a44'],[0.5,'#101a2c'],[1,'#0a111e']]);ctx.fill();ctx.shadowColor='transparent';
    ctx.strokeStyle=linear(ctx,0,py,0,py+ph,[[0,'#f6e3a1'],[0.5,PALETTE.gold],[1,'#7a5a17']]);ctx.lineWidth=3;ctx.stroke();
  }else for(const [y,h] of [[cy-icon/2-12,1.5],[cy+icon/2+12,3]]){ctx.fillStyle=linear(ctx,x+icon+gap,0,x+total,0,[[0,'rgba(212,175,55,0)'],[0.15,PALETTE.gold],[0.85,'#f3dc8a'],[1,'rgba(212,175,55,0)']]);ctx.fillRect(x+icon+gap,y-h/2,f.width,h)}
  ctx.restore();
  paintEmblem(ctx,x,cy-icon/2,icon,P);
  drawText(ctx,L,f,x+icon+gap,cy+f.size*0.36,{fill:verticalFill(SILVER_TEXT),shadow:{color:'rgba(0,0,0,0.7)',blur:10,y:4},role:'brand',box:[x+icon+gap,x+total]});
}
// Chrome title lettering with a gold edge, a dark outline and a drop shadow.
function paintTitle(ctx,L,text,baseline,{size,width}){
  const f=fitLine(ctx,text,{size,min:Math.round(size*0.7),width,weight:900,family:DISPLAY,tracking:0.01,condense:MIN_CONDENSE}),cx=W/2,top=baseline-f.size*0.76,bottom=baseline+f.size*0.04;
  ctx.save();setFont(ctx,f.size,f.weight,f.family,f.tracking);ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.lineJoin='round';
  ctx.shadowColor='rgba(0,0,0,0.8)';ctx.shadowBlur=30;ctx.shadowOffsetY=14;ctx.strokeStyle='#04060a';ctx.lineWidth=f.size*0.09;ctx.strokeText(f.text,cx,baseline,f.width);ctx.shadowColor='transparent';
  ctx.fillStyle='#2d333b';ctx.fillText(f.text,cx,baseline+f.size*0.04,f.width);
  ctx.strokeStyle=linear(ctx,0,top,0,bottom,[[0,'#fbe9a6'],[0.5,PALETTE.gold],[1,'#8c6a1c']]);ctx.lineWidth=f.size*0.046;ctx.strokeText(f.text,cx,baseline,f.width);
  ctx.fillStyle=linear(ctx,0,top,0,bottom,SILVER_TEXT);ctx.fillText(f.text,cx,baseline,f.width);
  ctx.restore();
  L.texts.push({role:'title',text:f.text,x:cx-f.width/2,width:f.width,top:baseline-f.size*0.78,bottom:baseline+f.size*0.22,size:f.size,truncated:!!f.truncated,box:[cx-width/2,cx+width/2]});
}
// A glossy status pill. LIVE is green, FINAL red, a qualified state amber with dark lettering, and an unavailable or held state
// an outline on dark, so it never reads as a settled result.
const TONE={final:PALETTE.final,live:PALETTE.alive,pending:PALETTE.pending,alive:PALETTE.alive,out:PALETTE.out,bad:PALETTE.out};
const STATUS_TONE={ok:'live',final:'final',warn:'pending',bad:'bad'};
function paintPill(ctx,L,text,tone,cx,cy,{w,h,size,role}){
  const color=TONE[tone]||PALETTE.pending,x=cx-w/2,y=cy-h/2,r=Math.min(h/2,18),outline=tone==='bad',amber=tone==='pending';
  ctx.save();ctx.shadowColor=color;ctx.shadowBlur=outline?14:22;roundRect(ctx,x,y,w,h,r);
  ctx.fillStyle=outline?linear(ctx,0,y,0,y+h,[[0,'#2b1214'],[1,'#120607']]):linear(ctx,0,y,0,y+h,[[0,shade(color,0.28)],[0.48,color],[0.52,shade(color,-0.12)],[1,shade(color,-0.38)]]);ctx.fill();
  ctx.shadowColor='transparent';ctx.strokeStyle=outline?color:shade(color,0.45);ctx.lineWidth=outline?4:2.5;ctx.stroke();
  if(!outline){roundRect(ctx,x+5,y+4,w-10,h*0.42,Math.max(2,r-5));ctx.fillStyle='rgba(255,255,255,0.14)';ctx.fill()}
  ctx.restore();L.boxes.push({role,tone,x,y,w,h});
  const f=fitLine(ctx,text,{size,width:w-28,weight:900,family:DISPLAY,tracking:0.03});
  drawText(ctx,L,f,cx,cy+f.size*0.35,{align:'center',fill:outline?shade(color,0.35):amber?'#1d1503':'#ffffff',shadow:amber?{color:'rgba(255,236,180,0.35)',blur:2,y:1}:{color:'rgba(0,0,0,0.55)',blur:4,y:2},role,box:[x+14,x+w-14]});
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
  // The brushed lines replaced the current path, so the outline is traced again before it is stroked.
  chamfer(ctx,x,y,w,h,c);ctx.strokeStyle=gold?linear(ctx,0,y,0,y+h,[[0,'#fff3c4'],[0.5,'#c79b35'],[1,'#7a5913']]):linear(ctx,0,y,0,y+h,[[0,'#e9edf1'],[0.5,'#8b949e'],[1,'#525a64']]);ctx.lineWidth=gold?4:3;ctx.stroke();
  chamfer(ctx,x+9,y+8,w-18,h-16,Math.max(4,c-6));ctx.strokeStyle=gold?'rgba(92,66,12,0.55)':'rgba(255,255,255,0.08)';ctx.lineWidth=2;ctx.stroke();
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'rgba(255,255,255,0)'],[0.5,gold?'rgba(255,252,235,0.95)':'rgba(220,232,255,0.75)'],[1,'rgba(255,255,255,0)']]);ctx.fillRect(x+c,y-1,w-2*c,2.5);ctx.fillRect(x+c+w*0.2,y+h-1.5,w-2*c-w*0.4,2);
  ctx.restore();
}
// The leader's ribbon, hanging from the top edge of the gold plate.
function paintRibbon(ctx,L,text,x,y,w,h){
  const notch=Math.round(w*0.2);
  ctx.save();ctx.shadowColor='rgba(0,0,0,0.45)';ctx.shadowBlur=14;ctx.shadowOffsetY=6;
  ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+w,y);ctx.lineTo(x+w,y+h);ctx.lineTo(x+w/2,y+h-notch);ctx.lineTo(x,y+h);ctx.closePath();
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'#b48a2c'],[0.5,'#f2d989'],[1,'#a98128']]);ctx.fill();ctx.shadowColor='transparent';
  ctx.strokeStyle='#6f5214';ctx.lineWidth=2.5;ctx.stroke();
  ctx.beginPath();ctx.moveTo(x+6,y+6);ctx.lineTo(x+w-6,y+6);ctx.lineTo(x+w-6,y+h-8);ctx.lineTo(x+w/2,y+h-notch-6);ctx.lineTo(x+6,y+h-8);ctx.closePath();ctx.strokeStyle='rgba(111,82,20,0.55)';ctx.lineWidth=1.5;ctx.stroke();
  ctx.restore();
  const f=fitLine(ctx,text,{size:Math.round(w*0.42),width:w-16,weight:900,family:DISPLAY,tracking:0.01});
  drawText(ctx,L,f,x+w/2,y+(h-notch)*0.5+f.size*0.36,{align:'center',fill:'#241a05',role:'place',box:[x+8,x+w-8]});
}

// ---- Layout. Planned before anything is drawn: the brand, title and footer are fixed; the status line takes one line (its
// pill beside the week) or two (a long state under it), its qualifiers and detail at most two lines, and the rows share what
// is left, the Pick'em leader's plate a little taller, all shrunk together when the content needs more room.
const STATUS={pickem:{cy:512,top:568},survivor:{cy:396,top:458}};
function statusDetail(card){
  const st=card.status;
  if(st.label==='FINAL'&&!st.flags.length)return /void/i.test(st.detail)?st.detail:'';
  return [...st.flags,st.detail].filter(Boolean).join(' · ');
}
// Rows and gaps shrink together, but never below MIN_ROW: past that the gaps give way instead.
export const MIN_ROW=78;
function rowBoxes(rows,top,bottom,{base,gap,lead=1,inset}){
  const n=rows.length,tall=rows.filter(r=>r.gold).length,room=bottom-top,need=(h,g)=>tall*h*lead+(n-tall)*h+(n-1)*g;
  let h=base,g=gap;
  if(need(h,g)>room){h=Math.max(MIN_ROW,base*room/need(base,gap));g=gap*h/base;if(need(h,g)>room)g=Math.max(6,(room-need(h,0))/Math.max(1,n-1))}
  let y=top+Math.max(0,(room-need(h,g))/2);
  // Whole pixels, rounded down, so the last row never ends past bottom.
  return rows.map(r=>{const rh=Math.floor(r.gold?h*lead:h),box={...inset(r),y:Math.floor(y),h:rh};y+=rh+g;return box});
}
export function cardLayout(ctx,card){
  const pickem=card.contest==='pickem',st=card.status,gold=pickem&&st.label==='FINAL'&&!st.flags.length,s=STATUS[card.contest];
  const head=`SEASON ${card.season} • WEEK ${card.week}`,p={gold,head,cy:s.cy};
  if(!gold){
    const hf=fitLine(ctx,head,{size:pickem?46:50,width:620,weight:800,family:DISPLAY,tracking:pickem?0.05:0.03}),pillSize=pickem?38:42,pillH=pickem?62:68;
    const label=fitLine(ctx,st.label,{size:pillSize,width:860,weight:900,family:DISPLAY,tracking:0.03}),pillW=Math.min(900,Math.max(190,label.width+76));
    p.pill={w:pillW,h:pillH,size:pillSize};p.inline=hf.width+24+pillW<=960;
    p.bottom=p.inline?s.cy+pillH/2:s.cy+pillH+18+pillH/2;
  }else p.bottom=s.cy+30;
  // The detail is set smaller, down to 22 px, before anything of it is cut.
  const detail=statusDetail(card).toUpperCase();
  for(const size of [26,24,22]){setFont(ctx,size,800,TEXT,0.06);p.detail=wrapText(ctx,detail,940,2);p.detailSize=size;p.detailLead=Math.round(size*1.31);if(!p.detail.at(-1)?.endsWith('…'))break}
  p.detailY=p.bottom+(p.inline===false?40:46);
  let top=Math.max(s.top,p.detail.length?p.detailY+(p.detail.length-1)*p.detailLead+30:p.bottom+44);
  if(!pickem){p.metricsY=top;p.metricsH=150;top+=150+28}
  p.rows=pickem?rowBoxes(card.rows,top,1176,{base:122,gap:22,lead:1.22,inset:r=>r.gold?{x:56,w:968}:{x:96,w:888}})
    :rowBoxes(card.rows,top,1124,{base:136,gap:22,inset:()=>({x:56,w:968})});
  p.rowsY=p.rows[0]?.y??top;p.rowH=Math.min(...p.rows.map(b=>b.h));p.gap=p.rows.length>1?p.rows[1].y-(p.rows[0].y+p.rows[0].h):0;
  p.end=p.rows.length?p.rows.at(-1).y+p.rows.at(-1).h:top;
  return p;
}

// ---- Sections.
function paintStatus(ctx,L,card,p){
  const st=card.status,shadow={color:'rgba(0,0,0,0.85)',blur:12,y:4},pickem=card.contest==='pickem';
  if(p.gold){
    const f=fitLine(ctx,`${p.head} ${st.label}`,{size:48,width:920,weight:800,family:DISPLAY,tracking:0.05});
    drawText(ctx,L,f,W/2,p.cy+f.size*0.35,{align:'center',fill:verticalFill(GOLD_TEXT),shadow,role:'status',box:[80,1000]});
  }else{
    const hf=fitLine(ctx,p.head,{size:pickem?46:50,width:620,weight:800,family:DISPLAY,tracking:pickem?0.05:0.03}),gap=24,fill=verticalFill(pickem?GOLD_TEXT:SILVER_TEXT);
    if(p.inline){
      const x=W/2-(hf.width+gap+p.pill.w)/2;
      drawText(ctx,L,hf,x,p.cy+hf.size*0.35,{fill,shadow,role:'status',box:[x,x+hf.width]});
      paintPill(ctx,L,st.label,STATUS_TONE[st.tone],x+hf.width+gap+p.pill.w/2,p.cy,{...p.pill,role:'status-pill'});
    }else{
      drawText(ctx,L,hf,W/2,p.cy+hf.size*0.35,{align:'center',fill,shadow,role:'status',box:[W/2-310,W/2+310]});
      paintPill(ctx,L,st.label,STATUS_TONE[st.tone],W/2,p.cy+p.pill.h+18,{...p.pill,role:'status-pill'});
    }
  }
  const warn=st.tone==='warn'||st.tone==='bad';
  setFont(ctx,p.detailSize,800,TEXT,0.06);
  p.detail.forEach((line,i)=>{const width=Math.min(ctx.measureText(line).width,940);drawText(ctx,L,{text:line,size:p.detailSize,width,weight:800,family:TEXT,tracking:0.06},W/2,p.detailY+i*p.detailLead,{align:'center',fill:warn?shade(PALETTE.pending,0.25):'#b4bdc8',shadow:{color:'rgba(0,0,0,0.8)',blur:8,y:2},role:'detail',box:[70,1010]})});
}
// The label in chrome and the count in gold, condensed together and set smaller only if condensing is not enough.
function paintTotal(ctx,L,total,cy){
  const tracking=0.02,label=`${total.label} `,max=920;let size=52,lw,vw;
  for(;;size-=2){lw=measure(ctx,label,size,900,DISPLAY,tracking);vw=measure(ctx,total.value,size,900,DISPLAY,tracking);if((lw+vw)*MIN_CONDENSE<=max||size<=30)break}
  const k=Math.min(1,max/(lw+vw)),f1={text:label,size,width:lw*k,weight:900,family:DISPLAY,tracking},f2={text:total.value,size,width:vw*k,weight:900,family:DISPLAY,tracking},x=W/2-(f1.width+f2.width)/2;
  const shadow={color:'rgba(0,0,0,0.85)',blur:14,y:5},box=[W/2-max/2,W/2+max/2];
  drawText(ctx,L,f1,x,cy+size*0.35,{fill:verticalFill(SILVER_TEXT),shadow,role:'total',box});
  drawText(ctx,L,f2,x+f1.width,cy+size*0.35,{fill:verticalFill(GOLD_TEXT),shadow,role:'total-value',box});
}
function paintFooter(ctx,L,card,{metaY,siteY,siteSize}){
  const meta=fitLine(ctx,`SNAPSHOT ${card.snapshot.toUpperCase()} · REVISION ${card.revision}`,{size:22,min:16,width:920,weight:700,tracking:0.1});
  drawText(ctx,L,meta,W/2,metaY+meta.size*0.35,{align:'center',fill:'#9aa4b0',role:'meta',box:[80,1000]});
  const site=fitLine(ctx,card.linkLabel,{size:siteSize,min:18,width:860,weight:800,tracking:0.05});
  drawText(ctx,L,site,W/2,siteY+site.size*0.35,{align:'center',fill:'#d4dae1',shadow:{color:'rgba(0,0,0,0.8)',blur:8,y:2},role:'site',box:[110,970]});
}
function paintPickem(ctx,L,card,p,P){
  paintStadium(ctx,'pickem');paintDots(ctx,640,0.035);
  paintBrand(ctx,L,'pickem',100,P);
  const [first,second]=card.title.toUpperCase().replace(/'/g,'’').split(' ');
  paintTitle(ctx,L,first,318,{size:150,width:800});paintTitle(ctx,L,second,452,{size:150,width:900});
  paintStatus(ctx,L,card,p);
  const ranked=card.rows.some(r=>r.overall),recordRight=ranked?742:900;
  L.boxes.push(...p.rows.map((b,i)=>({role:'row',gold:card.rows[i].gold,...b})));
  card.rows.forEach((row,i)=>{
    const b=p.rows[i],h=b.h,gold=row.gold,dark={color:'rgba(0,0,0,0.6)',blur:6,y:2};
    paintPlate(ctx,b,gold);
    let nameX;
    if(gold){
      const rw=Math.round(h*0.78);paintRibbon(ctx,L,row.place,b.x+38,b.y-12,rw,Math.round(h*0.9));nameX=b.x+38+rw+30;
      if(ranked){
        const right=b.x+b.w-52,lf=fitLine(ctx,'FIELD RANK',{size:Math.round(h*0.16),width:200,weight:800,tracking:0.12});
        drawText(ctx,L,lf,right,b.y+h*0.36,{align:'right',fill:'#4a380c',role:'rank-label',box:[right-200,right]});
        const vf=fitLine(ctx,row.overall??'—',{size:Math.round(h*0.4),width:200,weight:900,family:DISPLAY,tracking:0.01});
        drawText(ctx,L,vf,right,b.y+h*0.78,{align:'right',fill:'#1c1404',role:'rank',box:[right-200,right]});
      }
    }else{
      const pf=fitLine(ctx,row.place,{size:Math.round(h*0.42),width:104,weight:900,family:DISPLAY,tracking:0.01});
      drawText(ctx,L,pf,b.x+74,b.y+h*0.5+pf.size*0.36,{align:'center',fill:verticalFill(GOLD_TEXT),shadow:dark,role:'place',box:[b.x+22,b.x+126]});
      nameX=b.x+148;
      if(ranked){
        const right=b.x+b.w-46,vf=fitLine(ctx,row.overall??'—',{size:Math.round(h*0.4),width:190,weight:900,family:DISPLAY,tracking:0.01});
        drawText(ctx,L,vf,right,b.y+h*0.5+vf.size*0.36,{align:'right',fill:verticalFill(GOLD_TEXT),shadow:dark,role:'rank',box:[right-190,right]});
      }
    }
    const rf=fitLine(ctx,row.record,{size:Math.round(h*(gold?0.44:0.4)),width:170,weight:900,family:DISPLAY,tracking:0.01});
    drawText(ctx,L,rf,recordRight,b.y+h*0.5+rf.size*0.36,{align:'right',fill:gold?'#1c1404':verticalFill(SILVER_TEXT),shadow:gold?null:dark,role:'record',box:[recordRight-170,recordRight]});
    const nameMax=recordRight-rf.width-34-nameX,nf=fitLine(ctx,row.name,{size:Math.round(h*(gold?0.48:0.44)),min:Math.round(h*0.28),width:nameMax,weight:900,family:DISPLAY,tracking:0.005});
    const nameY=row.note?b.y+h*0.5+nf.size*0.12:b.y+h*0.5+nf.size*0.36;
    drawText(ctx,L,nf,nameX,nameY,{fill:gold?'#16110a':'#ffffff',shadow:gold?{color:'rgba(255,240,190,0.45)',blur:2,y:1}:{color:'rgba(0,0,0,0.7)',blur:6,y:3},role:'name',box:[nameX,nameX+nameMax]});
    if(row.note){const of=fitLine(ctx,row.note.toUpperCase(),{size:Math.max(18,Math.round(h*0.16)),min:16,width:nameMax,weight:800,tracking:0.08});drawText(ctx,L,of,nameX,nameY+of.size*1.5,{fill:gold?'#4a380c':row.noPicks?'#f2c45a':PALETTE.muted,role:'note',box:[nameX,nameX+nameMax]})}
  });
  if(card.total)paintTotal(ctx,L,card.total,1222);
  else{const f=fitLine(ctx,card.fieldNote.toUpperCase(),{size:28,min:20,width:920,weight:800,tracking:0.05});drawText(ctx,L,f,W/2,1222+f.size*0.35,{align:'center',fill:'#aeb7c2',role:'total',box:[80,1000]})}
  paintFooter(ctx,L,card,{metaY:1270,siteY:1314,siteSize:28});
}
function paintMetric(ctx,L,m,x,y,w,h){
  ctx.save();ctx.shadowColor='rgba(0,0,0,0.6)';ctx.shadowBlur=22;ctx.shadowOffsetY=8;
  for(const side of [x-7,x+w-3]){roundRect(ctx,side,y+h*0.24,10,h*0.52,4);ctx.fillStyle=linear(ctx,0,y,0,y+h,[[0,'#e9edf1'],[0.5,'#8b949e'],[1,'#4a525b']]);ctx.fill()}
  roundRect(ctx,x,y,w,h,20);ctx.fillStyle=linear(ctx,0,y,0,y+h,[[0,'#2a3039'],[0.5,PALETTE.container],[0.52,'#161b22'],[1,'#0f1318']]);ctx.fill();ctx.shadowColor='transparent';
  ctx.strokeStyle=m.accent?linear(ctx,0,y,0,y+h,[[0,'#f6e3a1'],[0.5,PALETTE.gold],[1,'#7a5a17']]):linear(ctx,0,y,0,y+h,[[0,'#dfe4e9'],[0.5,'#7d8590'],[1,'#4a525b']]);ctx.lineWidth=m.accent?3.5:3;ctx.stroke();
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'rgba(255,255,255,0)'],[0.5,'rgba(220,232,255,0.6)'],[1,'rgba(255,255,255,0)']]);ctx.fillRect(x+20,y-1,w-40,2);
  ctx.restore();
  const lf=fitLine(ctx,m.label,{size:25,min:18,width:w-28,weight:800,tracking:0.03});
  drawText(ctx,L,lf,x+w/2,y+46,{align:'center',fill:'#e8d7a8',role:'metric-label',box:[x+14,x+w-14]});
  const vf=fitLine(ctx,m.value,{size:76,min:40,width:w-30,weight:900,family:DISPLAY,tracking:0.01});
  const fill=m.tone==='neutral'?verticalFill(SILVER_TEXT):m.tone==='pending'?shade(PALETTE.pending,0.1):verticalFill(GOLD_TEXT);
  drawText(ctx,L,vf,x+w/2,y+h-24,{align:'center',fill,shadow:{color:'rgba(0,0,0,0.7)',blur:10,y:4},role:'metric-value',box:[x+15,x+w-15]});
}
const ROW_TONE={ALIVE:'alive',OUT:'out'};
function paintSurvivorRow(ctx,L,row,{x,y,w,h}){
  const split=x+w-316,tone=ROW_TONE[row.status]||'pending',alive=tone==='alive',accent=TONE[tone];
  ctx.save();ctx.shadowColor=alive?'rgba(46,160,67,0.45)':'rgba(0,0,0,0.6)';ctx.shadowBlur=alive?36:24;ctx.shadowOffsetY=alive?0:10;
  roundRect(ctx,x,y,w,h,22);ctx.fillStyle=linear(ctx,0,y,0,y+h,[[0,'#2d343d'],[0.48,'#1b2028'],[0.5,'#161b22'],[1,'#0d1116']]);ctx.fill();ctx.shadowColor='transparent';
  ctx.save();ctx.clip();
  if(alive){ctx.fillStyle=linear(ctx,x,0,split,0,[[0,'rgba(46,160,67,0.30)'],[0.55,'rgba(46,160,67,0.06)'],[1,'rgba(46,160,67,0)']]);ctx.fillRect(x,y,split-x,h)}
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'rgba(255,255,255,0)'],[0.45,'rgba(255,255,255,0.07)'],[1,'rgba(255,255,255,0)']]);ctx.fillRect(x,y,w,h*0.48);
  ctx.fillStyle='rgba(5,8,12,0.55)';ctx.fillRect(split,y,x+w-split,h);
  ctx.restore();
  ctx.strokeStyle=alive?linear(ctx,0,y,0,y+h,[[0,'#7ee2a0'],[0.5,PALETTE.alive],[1,'#1a6b30']]):linear(ctx,0,y,0,y+h,[[0,'#e6eaee'],[0.5,'#8b949e'],[1,'#4b535c']]);ctx.lineWidth=alive?4:3;ctx.stroke();
  ctx.strokeStyle='rgba(139,148,158,0.55)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(split,y+3);ctx.lineTo(split,y+h-3);ctx.stroke();
  roundRect(ctx,split+16,y+14,x+w-split-32,h-28,14);ctx.strokeStyle=alive?'rgba(126,226,160,0.55)':`${accent}55`;ctx.lineWidth=2;ctx.shadowColor=accent;ctx.shadowBlur=10;ctx.stroke();ctx.shadowColor='transparent';
  if(alive){ctx.fillStyle=linear(ctx,0,y,0,y+h,[[0,'#7ee2a0'],[1,'#1a6b30']]);roundRect(ctx,x+10,y+18,7,h-36,3);ctx.fill()}
  ctx.fillStyle=linear(ctx,x,0,x+w,0,[[0,'rgba(255,255,255,0)'],[0.5,'rgba(220,232,255,0.7)'],[1,'rgba(255,255,255,0)']]);ctx.fillRect(x+30,y-1,split-x-60,2);
  ctx.restore();
  // The note names the shown pick unless the reason already does.
  const note=row.note?`${row.team&&!row.note.includes(row.team)?`${row.team} · `:''}${row.note}`:row.team;
  const nameMax=split-x-90,nf=fitLine(ctx,row.name,{size:Math.round(h*0.5),min:Math.round(h*0.3),width:nameMax,weight:900,family:DISPLAY,tracking:0.005});
  const nameY=note?y+h*0.5+nf.size*0.1:y+h*0.5+nf.size*0.36;
  drawText(ctx,L,nf,x+52,nameY,{fill:verticalFill(SILVER_TEXT),shadow:{color:'rgba(0,0,0,0.75)',blur:8,y:3},role:'name',box:[x+52,x+52+nameMax]});
  if(note){const of=fitLine(ctx,note.toUpperCase(),{size:Math.max(20,Math.round(h*0.16)),min:18,width:nameMax,weight:800,tracking:0.06});drawText(ctx,L,of,x+52,nameY+of.size*1.6,{fill:alive?'#8fd6a5':row.review?'#f2c45a':PALETTE.muted,role:'note',box:[x+52,x+52+nameMax]})}
  paintPill(ctx,L,row.status,tone,split+(x+w-split)/2,y+h/2,{w:x+w-split-64,h:Math.round(h*0.56),size:Math.round(h*0.33),role:'row-status'});
}
function paintSurvivor(ctx,L,card,p,P){
  paintStadium(ctx,'survivor');paintDots(ctx,700,0.05);paintFrame(ctx);
  paintBrand(ctx,L,'survivor',96,P);
  paintTitle(ctx,L,card.title.toUpperCase(),318,{size:172,width:900});
  paintStatus(ctx,L,card,p);
  const gap=22,mw=(W-2*58-3*gap)/4;
  card.metrics.forEach((m,i)=>{const x=58+i*(mw+gap);L.boxes.push({role:'metric',x,y:p.metricsY,w:mw,h:p.metricsH});paintMetric(ctx,L,m,x,p.metricsY,mw,p.metricsH)});
  L.boxes.push(...p.rows.map((b,i)=>({role:'row',tone:ROW_TONE[card.rows[i].status]||'pending',...b})));
  card.rows.forEach((row,i)=>paintSurvivorRow(ctx,L,row,p.rows[i]));
  paintTotal(ctx,L,card.total,1168);
  ctx.save();ctx.fillStyle=linear(ctx,0,1256,0,H,[[0,'rgba(10,14,20,0.92)'],[1,'#05070a']]);ctx.fillRect(0,1256,W,H-1256);
  ctx.fillStyle=linear(ctx,0,0,W,0,[[0,'rgba(139,148,158,0)'],[0.5,'rgba(220,226,232,0.85)'],[1,'rgba(139,148,158,0)']]);ctx.fillRect(0,1255,W,2);
  ctx.fillStyle=linear(ctx,900,0,W,0,[[0,'rgba(212,175,55,0)'],[1,PALETTE.gold]]);ctx.beginPath();ctx.moveTo(880,1268);ctx.lineTo(W,1268);ctx.lineTo(W,1280);ctx.lineTo(892,1280);ctx.closePath();ctx.fill();
  ctx.restore();
  paintFooter(ctx,L,card,{metaY:1214,siteY:1306,siteSize:30});
}
// Draws the whole card at 1080 × 1350 on ctx and returns its layout: the planned positions, every text drawn with the column
// it was given, and every row and metric panel. A context that cannot parse the font stacks draws in sans-serif.
export function drawCard(ctx,card,{Path2D:P=globalThis.Path2D}={}){
  const parses=stack=>{ctx.font=`700 20px ${stack}`;return /20px/.test(String(ctx.font))};
  DISPLAY=parses(DISPLAY_FONTS)?DISPLAY_FONTS:'sans-serif';TEXT=parses(TEXT_FONTS)?TEXT_FONTS:'sans-serif';
  ctx.save();
  const p=cardLayout(ctx,card),L={...p,texts:[],boxes:[]};
  if(card.contest==='pickem')paintPickem(ctx,L,card,p,P);else paintSurvivor(ctx,L,card,p,P);
  ctx.restore();
  return L;
}
