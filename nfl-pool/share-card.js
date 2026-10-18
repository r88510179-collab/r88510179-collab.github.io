// Pool Center shareable cards, the pure part (share-ui.js is the page part). An app answers the poolcenter:share event with a
// snapshot of what it shows: weekly-app.js the Pick'em standings, survivor-app.js the Survivor week. This module checks that
// snapshot, decides the one status the card may truthfully claim, and turns it into the card: its text, its deep link and its
// 1080 x 1350 PNG layout drawn on any Canvas 2D context. No DOM, no network and no scoring: every record, rank and count comes
// from the snapshot, so a card says only what the page says, and a snapshot that does not hold together is refused.

export const CARD_WIDTH=1080,CARD_HEIGHT=1350;
// Scores or results older than this when the snapshot is taken are DELAYED, never LIVE or FINAL. weekly-app.js calls its feed
// DELAYED past the same age, and both apps refresh every 20 s while their view is visible, so only a page that is not keeping
// up (just resumed, or on a stalled network) reaches it.
export const FRESH_SECONDS=30;
// The tracked rows a card has room for at a readable size (cardLayout keeps every row at least 78 px tall up to these):
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
function pickemCard(s,options){
  const g=s.games,size=s.fieldSize;
  return{
    title:"Pick'em Standings",kicker:'YOUR GROUP VS THE FULL FIELD',status:pickemStatus(s,options),fieldSize:size,
    metrics:[
      {label:'POOL SIZE',value:size===null?'—':String(size),sub:size===null?'field not published':'entries'},
      {label:'GAMES FINAL',value:`${g.final}/${g.total}`,sub:g.void?`${g.void} void by ruling`:g.remaining?'NFL finals':'slate complete'},
      {label:'REMAINING',value:String(g.remaining),sub:g.live?`${g.live} live now`:g.remaining?'still to play':'none left'}
    ],
    rows:s.entries.map(e=>({
      rank:String(e.groupRank),name:e.name.trim(),record:`${e.w}–${e.l}`,leader:e.leader,noPicks:e.noPicks,
      note:e.noPicks?'No picks submitted':e.field?`Top ${e.field.topPercent}% · ${e.field.behind?`${e.field.behind} back of the field lead`:'at the field lead'}`:`${plural(e.left,'game')} left`,
      tiebreak:s.tiebreak.final&&e.tiebreakDelta!==null?`Tiebreak Δ ${e.tiebreakDelta}`:null,
      overall:e.field?e.field.label:null,overallOf:e.field?`of ${size}`:null
    })),
    fieldNote:size===null?'Full-field ranks are not published for this week.':null
  };
}
function survivorCard(s,options){
  // tone names the composition-bar segment a metric is, so its dot keys the bar.
  const c=s.counts,metrics=[
    {label:'OUT',value:String(c.out),sub:c.outThisWeek?`${c.outThisWeek} this week`:'none this week',tone:'out'},
    {label:'PENDING',value:String(c.pending),sub:'not yet decided',tone:'pending'},
    {label:'SUBMITTED',value:String(c.submitted),sub:c.legalPicks===c.submitted?`Week ${s.week} picks`:`${c.legalPicks} legal picks`,tone:null}
  ];
  if(c.awaitingRuling)metrics.push({label:'AWAITING RULING',value:String(c.awaitingRuling),sub:'halted games',tone:'ruling'});
  if(c.onHold)metrics.push({label:'ON HOLD',value:String(c.onHold),sub:'ruling data unusable',tone:'hold'});
  return{
    title:'Survivor Pool',kicker:'FULL-FIELD SURVIVOR STATUS',status:survivorStatus(s,options),fieldSize:s.fieldSize,counts:{...c},
    hero:{value:String(c.active),label:'STILL IN',sub:`of ${plural(s.fieldSize,'entry','entries')}`},
    metrics,
    segments:[['alive',c.active-c.pending,'Alive'],['pending',c.pending,'Pending'],['ruling',c.awaitingRuling,'Awaiting ruling'],['hold',c.onHold,'On hold'],['out',c.out,'Out']]
      .filter(([,n])=>n>0).map(([tone,n,label])=>({tone,n,label})),
    rows:s.tracked.map(t=>({name:t.name.trim(),team:t.team,status:t.status,review:t.underReview,note:t.underReview?`UNDER REVIEW · ${t.reason}`:t.reason}))
  };
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
      // A break inside a segment moves back to the segment's start when the line stays at least half full.
      if(end<tokens.length&&tokens[end].sep===' ')for(let k=end-1;k>start;k--)if(tokens[k].sep===' · '){if(width(tokens.slice(start,k))>=maxWidth/2)end=k;break}
    }
    lines.push(fitText(ctx,join(tokens.slice(start,end)),maxWidth));start=end;
  }
  return lines;
}

// ---- Drawing. The palette is the page's (style.css, survivor.css). There are no images, so drawing never needs the network
// and can never taint the canvas; the emblem is the app icon's own path data.
const FONT='Inter, Roboto, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const W=CARD_WIDTH,H=CARD_HEIGHT,X=72,R=W-72,CW=R-X,FOOTER=1214,BODY_END=FOOTER-24;
const C={text:'#f4f5f7',muted:'#989fa8',dim:'#6f7781',silver:'#d6d9dd',kicker:'#d84a50',red:'#d52d34',panel:'rgba(13,17,22,.9)',line:'rgba(255,255,255,.08)'};
const TONES={
  ok:{fg:'#8ce3b2',bg:'rgba(66,201,121,.14)',border:'rgba(66,201,121,.5)',mark:'#42c979'},
  final:{fg:'#f4f5f7',bg:'rgba(214,217,221,.10)',border:'rgba(214,217,221,.5)',mark:'#d6d9dd'},
  warn:{fg:'#ffd278',bg:'rgba(243,189,66,.12)',border:'rgba(243,189,66,.5)',mark:'#f3bd42'},
  bad:{fg:'#ffb1b5',bg:'rgba(213,45,52,.18)',border:'rgba(213,45,52,.62)',mark:'#ef4b52'}
};
const PILLS={ALIVE:TONES.ok,LIVE:TONES.warn,RULING:TONES.warn,PENDING:{fg:'#c1c6cc',bg:'rgba(255,255,255,.06)',border:'rgba(255,255,255,.18)'},
  HOLD:{fg:'#ffc391',bg:'rgba(242,138,61,.14)',border:'rgba(242,138,61,.55)'},OUT:{fg:'#ff9ca1',bg:'rgba(213,45,52,.16)',border:'rgba(213,45,52,.5)'}};
const SEGMENTS={alive:'#42c979',pending:'#f3bd42',ruling:'#b9a7ff',hold:'#f28a3d',out:'rgba(213,45,52,.62)'};
const TEAM_COLORS={ARI:'#97233F',ATL:'#A71930',BAL:'#241773',BUF:'#00338D',CAR:'#0085CA',CHI:'#0B162A',CIN:'#FB4F14',CLE:'#311D00',DAL:'#003594',DEN:'#FB4F14',DET:'#0076B6',GB:'#203731',HOU:'#03202F',IND:'#002C5F',JAX:'#006778',KC:'#E31837',LV:'#111111',LAC:'#0080C6',LAR:'#003594',MIA:'#008E97',MIN:'#4F2683',NE:'#002244',NO:'#B3995D',NYG:'#0B2265',NYJ:'#125740',PHI:'#004C54',PIT:'#FFB612',SF:'#AA0000',SEA:'#002244',TB:'#D50A0A',TEN:'#4B92DB',WAS:'#5A1414'};
const EMBLEM={
  outer:'M256 78 401 134v126c0 91-54 157-145 197-91-40-145-106-145-197V134z',
  inner:'M256 101 378 148v111c0 73-42 128-122 167-80-39-122-94-122-167V148z',
  letters:['M166 174h88c31 0 53 20 53 50 0 30-22 50-53 50h-43v82h-45zm45 38v25h39c9 0 15-5 15-13s-6-12-15-12z',
    'M354 198c-15-18-34-27-58-27-52 0-88 40-88 93 0 54 36 95 88 95 25 0 46-10 61-29l-31-29c-8 10-17 15-29 15-25 0-42-21-42-52 0-30 17-50 42-50 12 0 22 5 30 15z'],
  stripes:['M151 330 231 380','M158 306 245 360','M176 291 256 341']
};
let family=FONT;
function font(ctx,weight,size,spacing='0px'){ctx.font=`${weight} ${size}px ${family}`;if('letterSpacing' in ctx)ctx.letterSpacing=spacing}
// The largest size from max down to min at which the text fits; text() still fits it at min.
function fitSize(ctx,value,maxWidth,weight,max,min,spacing='0px'){for(let size=max;size>min;size-=2){font(ctx,weight,size,spacing);if(ctx.measureText(value).width<=maxWidth)return size}font(ctx,weight,min,spacing);return min}
function text(ctx,value,x,y,maxWidth,color=C.text,align='left',baseline='alphabetic'){
  const s=fitText(ctx,value,maxWidth);if(!s)return 0;
  ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline=baseline;ctx.fillText(s,x,y,maxWidth);
  return ctx.measureText(s).width;
}
function roundRect(ctx,x,y,w,h,r){const q=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x+q,y);ctx.arcTo(x+w,y,x+w,y+h,q);ctx.arcTo(x+w,y+h,x,y+h,q);ctx.arcTo(x,y+h,x,y,q);ctx.arcTo(x,y,x+w,y,q);ctx.closePath()}
function box(ctx,x,y,w,h,r,fill,stroke,lineWidth=2){roundRect(ctx,x,y,w,h,r);ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lineWidth;ctx.stroke()}}
function gradient(ctx,x0,y0,x1,y1,stops){const g=ctx.createLinearGradient(x0,y0,x1,y1);for(const [at,color] of stops)g.addColorStop(at,color);return g}
function glow(ctx,x,y,radius,color){const g=ctx.createRadialGradient(x,y,0,x,y,radius);g.addColorStop(0,color);g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.fillRect(0,0,W,H)}
function dot(ctx,x,y,r,color){ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill()}
const rgb=hex=>{const n=parseInt(hex.slice(1),16);return[n>>16&255,n>>8&255,n&255]};
const light=hex=>{const [r,g,b]=rgb(hex);return 0.2126*r+0.7152*g+0.0722*b>150};
const shade=hex=>{const [r,g,b]=rgb(hex).map(v=>Math.round(v*.45));return`rgb(${r},${g},${b})`};
function emblem(ctx,x,y,size,P,{tile=true,alpha=1}={}){
  if(typeof P!=='function')return;
  ctx.save();ctx.globalAlpha=alpha;ctx.translate(x,y);ctx.scale(size/512,size/512);
  if(tile){
    ctx.save();ctx.shadowColor='rgba(0,0,0,.6)';ctx.shadowBlur=40;ctx.shadowOffsetY=16;box(ctx,0,0,512,512,104,gradient(ctx,0,0,512,512,[[0,'#151b22'],[1,'#07090d']]));ctx.restore();
    ctx.save();roundRect(ctx,0,0,512,512,104);ctx.clip();const g=ctx.createRadialGradient(256,265,0,256,265,230);g.addColorStop(0,'rgba(213,45,52,.3)');g.addColorStop(1,'rgba(213,45,52,0)');ctx.fillStyle=g;ctx.fillRect(0,0,512,512);ctx.restore();
  }
  const red=gradient(ctx,0,101,0,457,[[0,'#ef4b52'],[.52,'#c52b32'],[1,'#7d1016']]);
  ctx.lineJoin='round';ctx.lineCap='round';
  const outer=new P(EMBLEM.outer);ctx.fillStyle='#0c0f14';ctx.fill(outer);ctx.strokeStyle=gradient(ctx,111,78,401,457,[[0,'#f6b0b4'],[.25,'#7b1015'],[.7,'#f06a70'],[1,'#590b0f']]);ctx.lineWidth=15;ctx.stroke(outer);
  ctx.strokeStyle=red;ctx.lineWidth=18;ctx.stroke(new P(EMBLEM.inner));
  for(const d of EMBLEM.letters){const p=new P(d);ctx.fillStyle=red;ctx.fill(p);ctx.strokeStyle='#571015';ctx.lineWidth=5;ctx.stroke(p)}
  for(const [color,width,a] of [['#8f171d',10,1],['#ef6c72',2,.85]]){ctx.globalAlpha=alpha*a;ctx.strokeStyle=color;ctx.lineWidth=width;for(const d of EMBLEM.stripes)ctx.stroke(new P(d))}
  ctx.restore();
}

// ---- Layout. The card is planned before anything is drawn. The header and footer are fixed; the sections between them
// take their size from the roomiest density at which every tracked row keeps its minimum height, so the title, the status
// detail, the tiles and the spacing give way before the rows do, and a long status never squeezes the standings off the card.
const DENSITY=[
  {title:86,lines:2,tile:144,stat:54,head:60,gap:14,row:[100,122]},
  {title:76,lines:2,tile:128,stat:48,head:56,gap:12,row:[92,112]},
  {title:68,lines:1,tile:116,stat:44,head:52,gap:10,row:[86,104]},
  {title:60,lines:1,tile:104,stat:40,head:48,gap:8,row:[78,96]}
];
const PILL_H=64,CHIP={size:20,height:46,pad:22},GAP=14;
function chipWidth(ctx,label){font(ctx,800,CHIP.size,'2px');return Math.min(ctx.measureText(label).width+CHIP.pad*2,CW)}
// The qualifiers beside and under the status pill: in order, on at most two rows, and whatever does not fit summed up as
// +N MORE at the end of the second (the copied summary names them all). widthOf gives a chip's drawn width.
export function chipRows(labels,widthOf,firstStart,start,end,gap){
  const rows=[[],[]],x=[firstStart,start];let r=0,i=0;
  for(;i<labels.length;i++){
    const w=widthOf(labels[i]);
    while(r<2&&x[r]+w>end)r++;
    if(r===2)break;
    rows[r].push(labels[i]);x[r]+=w+gap;
  }
  if(i<labels.length){
    let hidden=labels.length-i;
    while(rows[1].length&&x[1]+widthOf(`+${hidden} MORE`)>end){x[1]-=widthOf(rows[1].pop())+gap;hidden++}
    rows[1].push(`+${hidden} MORE`);
  }
  return rows;
}
function layoutAt(ctx,card,d){
  const p={d,titleY:244+Math.round(d.title*.95)};
  p.statusY=p.titleY+34;
  font(ctx,900,30,'3px');p.pillW=Math.min(ctx.measureText(card.status.label).width,CW-96)+96;
  p.chips=chipRows(card.status.flags,label=>chipWidth(ctx,label),X+p.pillW+GAP,X,R,GAP);
  font(ctx,600,26);p.detail=wrapText(ctx,card.status.detail,CW,d.lines);
  p.detailY=p.statusY+PILL_H+(p.chips[1].length?CHIP.height+12:0)+44;
  p.bodyY=p.detailY+36*(p.detail.length-1)+38;
  // Survivor's panel holds the hero count and one stat line per metric, above its composition bar.
  p.bodyH=card.contest==='pickem'?d.tile:Math.max(Math.round(d.title*2.3),56+card.metrics.length*d.stat)+40;
  p.headY=p.bodyY+p.bodyH+d.head;p.rowsY=p.headY+22;p.gap=d.gap;
  const n=card.rows.length,end=BODY_END-(card.fieldNote?40:0);
  p.rowH=Math.min(d.row[1],Math.floor((end-p.rowsY-d.gap*(n-1))/n));
  return p;
}
export function cardLayout(ctx,card){
  let p;
  for(const d of DENSITY){p=layoutAt(ctx,card,d);if(p.rowH>=d.row[0])break}
  return p;
}

// ---- Sections.
function background(ctx,P){
  ctx.fillStyle=gradient(ctx,0,0,0,H,[[0,'#13171d'],[.42,'#0a0d11'],[1,'#07090d']]);ctx.fillRect(0,0,W,H);
  glow(ctx,W/2,-90,780,'rgba(213,45,52,.30)');glow(ctx,96,30,300,'rgba(255,255,255,.07)');glow(ctx,W-96,30,300,'rgba(255,255,255,.07)');
  // Yard lines fading in from mid-card, the midfield line red, as on the page.
  for(let i=1;i<10;i++){const x=Math.round(i*W/10),mid=i===5;ctx.fillStyle=gradient(ctx,0,520,0,H,[[0,'rgba(0,0,0,0)'],[.55,mid?'rgba(213,45,52,.16)':'rgba(255,255,255,.035)'],[1,'rgba(0,0,0,0)']]);ctx.fillRect(x-1,520,mid?3:2,H-520)}
  emblem(ctx,560,170,560,P,{tile:false,alpha:.045});
}
function header(ctx,card,P){
  emblem(ctx,X,58,92,P);
  font(ctx,800,20,'3px');const season=`${card.season} SEASON`,seasonWidth=Math.min(ctx.measureText(season).width,320);text(ctx,season,R,92,320,C.muted,'right');
  font(ctx,900,56,'1px');const week=`WEEK ${card.week}`,weekWidth=Math.min(ctx.measureText(week).width,320);text(ctx,week,R,148,320,C.text,'right');
  // The wordmark: NFL in the brand red, POOL CENTER in white, in whatever room the week leaves.
  const left=X+92+26,room=R-Math.max(seasonWidth,weekWidth)-40-left;
  fitSize(ctx,'NFL POOL CENTER',room,900,44,26,'2px');const nfl=text(ctx,'NFL',left,122,room,C.red),gap=ctx.measureText(' ').width;
  text(ctx,'POOL CENTER',left+nfl+gap,122,room-nfl-gap,C.text);
  ctx.fillStyle=gradient(ctx,X,0,R,0,[[0,'rgba(213,45,52,.8)'],[.45,'rgba(213,45,52,.25)'],[1,'rgba(255,255,255,.04)']]);ctx.fillRect(X,186,CW,2);
}
function titleBlock(ctx,card,p){
  font(ctx,900,22,'5px');text(ctx,card.kicker,X,244,CW,C.kicker);
  const title=card.title.toUpperCase().replace(/'/g,'’');fitSize(ctx,title,CW,900,p.d.title,Math.round(p.d.title*.7),'-1px');text(ctx,title,X,p.titleY,CW);
}
function statusBlock(ctx,card,p){
  const st=card.status,tone=TONES[st.tone],top=p.statusY;
  box(ctx,X,top,p.pillW,PILL_H,PILL_H/2,tone.bg,tone.border);
  if(st.tone==='final'){ctx.strokeStyle=tone.mark;ctx.lineWidth=5;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(X+23,top+33);ctx.lineTo(X+31,top+41);ctx.lineTo(X+45,top+24);ctx.stroke()}
  else dot(ctx,X+33,top+PILL_H/2,10,tone.mark);
  font(ctx,900,30,'3px');text(ctx,st.label,X+60,top+PILL_H/2+1,CW-96,tone.fg,'left','middle');
  p.chips.forEach((labels,r)=>{
    let x=r===0?X+p.pillW+GAP:X;const y=r===0?top+(PILL_H-CHIP.height)/2:top+PILL_H+12;
    for(const label of labels){
      const w=chipWidth(ctx,label),chipTone=BAD.has(label)?TONES.bad:TONES.warn;
      box(ctx,x,y,w,CHIP.height,CHIP.height/2,chipTone.bg,chipTone.border);text(ctx,label,x+CHIP.pad,y+CHIP.height/2+1,w-CHIP.pad*2,chipTone.fg,'left','middle');
      x+=w+GAP;
    }
  });
  font(ctx,600,26);p.detail.forEach((line,i)=>text(ctx,line,X,p.detailY+i*36,CW,C.muted));
}
function sectionHead(ctx,label,y,columns=[]){
  font(ctx,900,22,'5px');text(ctx,label,X,y,CW/2,C.kicker);
  font(ctx,800,19,'3px');for(const [value,x] of columns)text(ctx,value,x,y,200,C.dim,'center');
}
function tile(ctx,m,x,y,w,h){
  const valueSize=Math.round(h*.4),pad=26,inner=w-pad*2;
  box(ctx,x,y,w,h,22,'rgba(11,14,19,.92)',C.line);
  font(ctx,800,20,'3px');text(ctx,m.label,x+pad,y+Math.round(h*.27),inner,C.dim);
  fitSize(ctx,m.value,inner,900,valueSize,Math.round(valueSize*.6));text(ctx,m.value,x+pad,y+Math.round(h*.64),inner);
  font(ctx,600,21);text(ctx,m.sub,x+pad,y+Math.round(h*.88),inner,C.muted);
}
function pickemBody(ctx,card,p){
  const tileW=(CW-2*18)/3,overallW=150,overallX=R-14-overallW,recordRight=overallX-28;
  card.metrics.forEach((m,i)=>tile(ctx,m,X+i*(tileW+18),p.bodyY,tileW,p.bodyH));
  sectionHead(ctx,'YOUR GROUP',p.headY,[['RECORD',recordRight-66],['OVERALL',overallX+overallW/2]]);
  card.rows.forEach((r,i)=>{
    const y=p.rowsY+i*(p.rowH+p.gap),h=p.rowH,mid=y+h/2,badge=Math.min(58,h-30);
    box(ctx,X,y,CW,h,20,r.leader?gradient(ctx,X,0,R,0,[[0,'rgba(213,45,52,.2)'],[.6,'rgba(213,45,52,.06)'],[1,C.panel]]):C.panel,r.leader?'rgba(213,45,52,.5)':C.line);
    box(ctx,X+22,mid-badge/2,badge,badge,14,r.leader?gradient(ctx,0,mid-badge/2,0,mid+badge/2,[[0,'#ef4b52'],[1,'#9e171e']]):'#151a21',r.leader?null:'rgba(255,255,255,.1)');
    font(ctx,900,Math.round(badge*.48));text(ctx,r.rank,X+22+badge/2,mid+1,badge-8,r.leader?'#fff':'#c1c6cc','center','middle');
    const nameX=X+22+badge+24;
    font(ctx,900,Math.round(Math.min(48,h*.44)));const recordWidth=Math.min(ctx.measureText(r.record).width,200);
    text(ctx,r.record,recordRight,mid+Math.round(h*.16),200,r.noPicks?C.muted:C.text,'right');
    const room=recordRight-recordWidth-28-nameX;
    fitSize(ctx,r.name,room,900,Math.round(Math.min(42,h*.4)),26);text(ctx,r.name,nameX,y+Math.round(h*.48),room);
    font(ctx,600,Math.round(Math.max(20,Math.min(23,h*.21))));text(ctx,r.tiebreak?`${r.note} · ${r.tiebreak}`:r.note,nameX,y+Math.round(h*.8),room,r.noPicks?'#ffd278':C.muted);
    box(ctx,overallX,y+12,overallW,h-24,16,'rgba(7,9,13,.7)','rgba(255,255,255,.1)');
    const ox=overallX+overallW/2;
    if(r.overall){fitSize(ctx,r.overall,overallW-20,900,Math.round(Math.min(38,h*.36)),24);text(ctx,r.overall,ox,mid+Math.round(h*.07),overallW-20,C.text,'center');font(ctx,600,Math.round(Math.max(17,Math.min(19,h*.18))));text(ctx,r.overallOf,ox,mid+Math.round(h*.3),overallW-20,C.dim,'center')}
    else{font(ctx,900,30);text(ctx,'—',ox,mid+2,overallW-20,C.dim,'center','middle')}
  });
  if(card.fieldNote){font(ctx,600,21);text(ctx,card.fieldNote,X,BODY_END-8,CW,C.dim)}
}
// Segment widths in proportion to their counts, each nonzero segment at least min wide, the widest giving up the difference.
export function segmentWidths(counts,total,width,min=8){
  const widths=counts.map(n=>n>0?Math.max(min,width*n/total):0),excess=widths.reduce((a,b)=>a+b,0)-width;
  if(excess>0){const widest=widths.indexOf(Math.max(...widths));widths[widest]=Math.max(min,widths[widest]-excess)}
  return widths;
}
function survivorBody(ctx,card,p){
  const d=p.d,top=p.bodyY,h=p.bodyH,content=h-40;
  box(ctx,X,top,CW,h,24,gradient(ctx,0,top,0,top+h,[[0,'rgba(22,27,34,.95)'],[1,'rgba(11,14,18,.95)']]),C.line);
  // The hero count, keyed green like the alive part of the bar.
  dot(ctx,X+41,top+45,8,SEGMENTS.alive);font(ctx,900,22,'5px');text(ctx,card.hero.label,X+60,top+53,280,C.kicker);
  const valueSize=fitSize(ctx,card.hero.value,300,900,Math.min(124,content-104),56);text(ctx,card.hero.value,X+30,top+53+Math.round(valueSize*.92),300);
  font(ctx,600,24);text(ctx,card.hero.sub,X+34,top+53+Math.round(valueSize*.92)+42,300,C.muted);
  // One line per metric: its dot (the bar segment it is), label and note on the left, the count on the right.
  const x0=X+380,x1=R-30;
  card.metrics.forEach((m,i)=>{
    const y=top+28+i*d.stat,base=y+Math.round(d.stat*.64);
    if(i){ctx.fillStyle=C.line;ctx.fillRect(x0,y,x1-x0,1)}
    let lx=x0;if(m.tone){dot(ctx,lx+7,base-8,7,SEGMENTS[m.tone]);lx+=24}
    font(ctx,900,Math.round(d.stat*.72));const valueWidth=Math.min(ctx.measureText(m.value).width,160);text(ctx,m.value,x1,base+4,160,C.text,'right');
    font(ctx,800,20,'2px');const labelWidth=text(ctx,m.label,lx,base,x1-valueWidth-24-lx,C.dim);
    font(ctx,600,20);text(ctx,m.sub,lx+labelWidth+14,base,x1-valueWidth-24-(lx+labelWidth+14),C.muted);
  });
  const barX=X+30,barW=CW-60,barY=top+h-34,widths=segmentWidths(card.segments.map(s=>s.n),card.fieldSize,barW);
  ctx.save();roundRect(ctx,barX,barY,barW,14,7);ctx.fillStyle='rgba(255,255,255,.06)';ctx.fill();ctx.clip();
  let bx=barX;card.segments.forEach((s,i)=>{ctx.fillStyle=SEGMENTS[s.tone];ctx.fillRect(bx,barY,widths[i],14);bx+=widths[i]});ctx.restore();
  const pillW=176,chipW=112,pillX=R-22-pillW,chipX=pillX-16-chipW;
  sectionHead(ctx,'YOUR ENTRIES',p.headY,[['PICK',chipX+chipW/2],['STATUS',pillX+pillW/2]]);
  card.rows.forEach((r,i)=>{
    const y=p.rowsY+i*(p.rowH+p.gap),rh=p.rowH,mid=y+rh/2,nameX=X+30,room=chipX-24-nameX,pill=PILLS[r.status];
    box(ctx,X,y,CW,rh,20,C.panel,r.status==='OUT'?'rgba(213,45,52,.28)':r.status==='ALIVE'?'rgba(66,201,121,.3)':C.line);
    fitSize(ctx,r.name,room,900,Math.round(Math.min(42,rh*.4)),26);text(ctx,r.name,nameX,y+Math.round(rh*.48),room);
    font(ctx,600,Math.round(Math.max(20,Math.min(22,rh*.2))));text(ctx,r.note,nameX,y+Math.round(rh*.8),room,r.review?'#ffd278':C.muted);
    const ch=Math.min(62,rh-30);
    if(r.team){const color=TEAM_COLORS[r.team]||'#33465f';box(ctx,chipX,mid-ch/2,chipW,ch,14,gradient(ctx,0,mid-ch/2,0,mid+ch/2,[[0,color],[1,shade(color)]]),'rgba(255,255,255,.22)');font(ctx,900,Math.round(ch*.48),'1px');text(ctx,r.team,chipX+chipW/2,mid+1,chipW-16,light(color)?'#0b0e12':'#fff','center','middle')}
    else{box(ctx,chipX,mid-ch/2,chipW,ch,14,'#151a21','rgba(255,255,255,.1)');font(ctx,800,18,'1px');text(ctx,'NO PICK',chipX+chipW/2,mid+1,chipW-12,C.muted,'center','middle')}
    const ph=Math.min(56,rh-34);box(ctx,pillX,mid-ph/2,pillW,ph,ph/2,pill.bg,pill.border);
    font(ctx,900,Math.round(ph*.43),'2px');text(ctx,r.status,pillX+pillW/2,mid+1,pillW-24,pill.fg,'center','middle');
  });
}
function footer(ctx,card){
  ctx.fillStyle='rgba(255,255,255,.08)';ctx.fillRect(X,FOOTER,CW,2);
  font(ctx,800,17,'3px');text(ctx,`SNAPSHOT · REVISION ${card.revision}`,X,FOOTER+44,CW/2-20,C.dim);text(ctx,'GENERATED FROM NFL POOL CENTER',R,FOOTER+44,CW/2-20,C.dim,'right');
  font(ctx,700,22);const linkWidth=Math.min(ctx.measureText(card.linkLabel).width,CW*.55);text(ctx,card.linkLabel,R,FOOTER+82,CW*.55,C.muted,'right');
  font(ctx,700,24);text(ctx,card.snapshot,X,FOOTER+82,CW-linkWidth-36,C.silver);
}
// Draws the whole card at 1080 x 1350 on ctx. The font stack is the page's; a context that cannot parse it uses sans-serif.
export function drawCard(ctx,card,{Path2D:P=globalThis.Path2D}={}){
  family=FONT;ctx.font=`700 20px ${FONT}`;if(!/20px/.test(String(ctx.font)))family='sans-serif';
  ctx.save();
  const p=cardLayout(ctx,card);
  background(ctx,P);header(ctx,card,P);titleBlock(ctx,card,p);statusBlock(ctx,card,p);
  if(card.contest==='pickem')pickemBody(ctx,card,p);else survivorBody(ctx,card,p);
  footer(ctx,card);
  ctx.restore();
  return p;
}
