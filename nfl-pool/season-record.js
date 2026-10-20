// Pool Center season record: each tracked entry's season-to-date Pick'em record and winning percentage, beside the selected
// week's, on Home (under the Live Standings rows) and on Standings (the Season Record card). Every week is graded by
// weekly-app.js exactly as the page grades the week on screen (poolcenter:season): the week on screen is the page's own,
// verified data; every other published week of its season is graded from that week's own published row (accepted by the
// page's own checks), its own week's score feed (through the page's protected path) and its own week's rules and rulings.
// This module reads, keeps, adds up and shows; it grades and ranks nothing itself.
//
// Reads: only what the page cannot hand over, read-only and time-limited like the page's own reads (READ_TIMEOUT_MS each):
// another week's published row once per revision; that week's score feed until every game is resolved (never again after,
// unless its revision changes); and the season's rules and rulings at most once per RULINGS_EVERY_MS while the season has a
// week other than the one on screen. Nothing is read on a timer of its own: reads follow the page's own refresh
// notifications (poolcenter:update), so they stop whenever the page's do (hidden, or Survivor has the page), and the week on
// screen is never read here. A week chosen in place of another hands its verified grade over, so nothing is read again.
//
// Kept: for this page only (no storage), each week's grade at the revision it was graded at. A newer revision replaces the
// week whole, never adds to it, so a week counts once however often it is refreshed, reloaded or revised.
//
// Shown: a season record only while every published week from Week 1 through the latest one is verified at the revision
// the publication index lists. A week loading, missing, unavailable, on hold or with games the feed could not verify is said
// explicitly instead of a total.
import {PUBLIC_COLUMNS,FIRST_RULING_SEASON,contestIdFor} from './contest-rulings.js?v=2';

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ESPN_SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const PUB_ROW_COLUMNS='season,week,status,revision,published_at,config';
// Each read (its token, headers and body together) is abandoned after READ_TIMEOUT_MS, the page's own limit. An unresolved
// week's feed is read at most once per FEED_EVERY_MS (once per page refresh), the rules and rulings once per
// RULINGS_EVERY_MS, and a failed read is tried again RETRY_MS later, with a later page refresh. At most MAX_READS run at once.
export const READ_TIMEOUT_MS=15000,FEED_EVERY_MS=15000,RULINGS_EVERY_MS=60000,RETRY_MS=15000,MAX_READS=4;
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const plural=(n,word,many=`${word}s`)=>`${n} ${n===1?word:many}`;

// ---- Records, from the grades alone.
// Winning percentage: wins / (wins + losses) x 100 to one decimal, rounded half up in whole numbers (never through a
// binary fraction), or an em dash while no game has been graded.
export function winPct(w,l){
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(l)||w<0||l<0||w+l===0)return'—';
  const n=w+l,tenths=Math.floor((2000*w+n)/(2*n));
  return`${Math.floor(tenths/10)}.${tenths%10}%`;
}
export const recordText=(w,l)=>`${w}–${l}`;
// "Week 4", "Weeks 1–6", "Weeks 3 and 6", "Weeks 1–3 and 5".
export function weekList(weeks){
  const sorted=[...new Set(weeks)].sort((a,b)=>a-b),runs=[];
  for(const w of sorted){const run=runs.at(-1);if(run&&w===run[1]+1)run[1]=w;else runs.push([w,w])}
  const parts=runs.map(([a,b])=>a===b?String(a):`${a}–${b}`);
  if(!parts.length)return'';
  return`${sorted.length===1?'Week':'Weeks'} ${parts.length===1?parts[0]:`${parts.slice(0,-1).join(', ')} and ${parts.at(-1)}`}`;
}
// Why one week cannot count yet, or what it counts with. g is the page's grade of the week (weekly-app.js weekGrade).
function judged(base,{feedFailed=false,publishedStale=false,rulingsError=null}={}){
  const g=base.graded,w=base.week;
  if(!g||g.rulings==='none')return{...base,status:rulingsError?'unavailable':'loading',reason:rulingsError?`the Week ${w} rules and rulings could not be loaded`:`Week ${w} is loading`};
  if(g.rulings==='hold')return{...base,status:'hold',reason:`Week ${w} is on hold: its rules and rulings could not be loaded or verified`};
  if(g.unverified)return{...base,status:'incomplete',reason:`Week ${w} has ${plural(g.unverified,'game')} the score feed could not verify`};
  const late=[feedFailed&&`Week ${w} scores could not be refreshed`,g.rulings==='stale'&&`Week ${w} rulings could not be refreshed`,publishedStale&&`the newest Week ${w} publication could not be verified`].filter(Boolean);
  return{...base,status:late.length?'delayed':'verified',reason:late.join(' · ')||null};
}
// The week on screen, as the page has it (state.current), and any other week, as the history keeps it.
function pageWeek(state){
  const c=state.current,base={week:state.week,revision:state.revision,graded:c.graded};
  if(c.feed.fetchedAt===null)return{...base,status:c.feed.failed?'unavailable':'loading',reason:c.feed.failed?`Week ${state.week} scores could not be loaded`:`Week ${state.week} is loading`};
  return judged(base,{feedFailed:c.feed.failed,publishedStale:state.publishedStale});
}
function historyWeek(week,e,revision,rulingsError){
  if(!e?.prepared||e.revision<revision)return{week,status:e?.rowError?'unavailable':'loading',reason:e?.rowError?`Week ${week} could not be loaded (${e.rowError})`:`Week ${week} is loading`};
  if(!e.feedAt)return{week,revision:e.revision,status:e.feedError?'unavailable':'loading',reason:e.feedError?`Week ${week} scores could not be loaded`:`Week ${week} is loading`};
  return judged({week,revision:e.revision,graded:e.graded},{feedFailed:e.feedError!==null,rulingsError});
}
const counts=c=>c.status==='verified'||c.status==='delayed';
// The season of the week on screen, Week 1 through the latest published week: what each week contributes (the week on screen
// from the page, or, while the page is still loading it, from the history at the same revision; every other week from the
// history, only at the revision the index lists or a later one), whether the season can be totalled, and for each tracked
// entry of the week on screen, in published order, its selected-week record and its season record. Entries are matched
// across weeks by their published id, never by name or position; a week without exactly one entry of that id leaves that
// entry's season unshown.
export function seasonSummary(state,history=new Map(),{rulingsError=null}={}){
  const season=state.season,listed=new Map(state.index.filter(x=>x.season===season).map(x=>[x.week,x.revision]));
  const latest=Math.max(state.week,...listed.keys()),weeks=[];
  for(let week=1;week<=latest;week++){
    let c;
    if(week===state.week){
      c=pageWeek(state);
      if(c.status==='loading'){const kept=historyWeek(week,history.get(week),state.revision,rulingsError);if(counts(kept))c=kept}
    }else c=listed.has(week)?historyWeek(week,history.get(week),listed.get(week),rulingsError):{week,status:'missing',reason:`Week ${week} is not published`};
    weeks.push(c);
  }
  const blocking=weeks.filter(c=>['missing','unavailable','hold','incomplete'].includes(c.status)),loading=weeks.filter(c=>c.status==='loading'),late=weeks.filter(c=>c.status==='delayed');
  const status=blocking.length?'incomplete':loading.length?'loading':late.length?'delayed':'complete',total=status==='complete'||status==='delayed';
  const people=state.current.week.tracked.map((p,i)=>{
    const wk=state.current.graded.records[i],out={id:p.id,name:p.name,week:{w:wk.w,l:wk.l,left:wk.left,noSubmission:wk.noSubmission},season:null,reason:null,noPicks:[]};
    if(!total)return out;
    if(!p.identified){out.reason=`${p.name} has no published entry id, so the weeks cannot be matched`;return out}
    let w=0,l=0;const noPicks=[];
    for(const c of weeks){
      const hits=c.graded.records.filter(r=>r.identified&&r.id===p.id);
      if(hits.length!==1){out.reason=`${p.name} is ${hits.length?'listed more than once':'not tracked'} in Week ${c.week}`;return out}
      w+=hits[0].w;l+=hits[0].l;if(hits[0].noSubmission)noPicks.push(c.week);
    }
    return{...out,season:{w,l},noPicks};
  });
  const games=total?weeks.reduce((t,c)=>{const g=c.graded.games;t.graded+=g.final;t.void+=g.void;t.hold+=g.hold;t.pending+=g.total-g.final-g.void-g.hold;return t},{graded:0,void:0,hold:0,pending:0}):null;
  return{season,week:state.week,latest,status,weeks,people,games,
    reasons:(blocking.length?blocking:loading.length?[]:late).map(c=>c.reason).filter(Boolean)};
}
// One line on what the season record shows, or why it is not shown; null when it is complete.
export function seasonStatusText(s){
  if(!s||s.status==='complete')return null;
  if(s.status==='loading')return'Loading the season record…';
  if(s.status==='delayed')return`Season record as last verified · ${s.reasons.join(' · ')}.`;
  const more=s.reasons.length>1?` (and ${plural(s.reasons.length-1,'more week')})`:'';
  return`Season record incomplete: ${s.reasons[0]}${more}. It returns once every published week is verified.`;
}
const shownSeason=(s,p)=>(s.status==='complete'||s.status==='delayed')&&p.season?p.season:null;
// The card's head: the season and the weeks it covers, with the graded game count once it can be totalled.
export function seasonMetaText(s){
  if(!s)return'Season record unavailable';
  const covers=`${s.season} season · ${weekList(Array.from({length:s.latest},(_,i)=>i+1))}`;
  return s.status==='complete'||s.status==='delayed'?`${covers} · ${plural(s.games.graded,'graded game')}`:s.status==='loading'?`${covers} · loading`:`${covers} · incomplete`;
}
// Home: under the Live Standings rows, each tracked entry's season W–L and winning percentage, in published order.
export function homeSeasonHtml(s){
  if(!s)return'';
  const chips=s.people.map(p=>{const r=shownSeason(s,p);return`<div class="season-chip"><span class="season-chip-name">${esc(p.name)}</span><span class="season-chip-record">${r?recordText(r.w,r.l):'—'}</span><span class="season-chip-pct">${r?winPct(r.w,r.l):'—'}</span></div>`}).join('');
  const notes=[seasonStatusText(s),...s.people.filter(p=>p.reason).map(p=>`${p.reason}.`)].filter(Boolean);
  return`<div class="season-strip-head"><span class="section-kicker">Season record</span><span class="season-strip-meta">${esc(`${s.season} · ${weekList(Array.from({length:s.latest},(_,i)=>i+1))}`)}</span></div><div class="season-strip-grid">${chips}</div>${notes.map(n=>`<p class="season-strip-status">${esc(n)}</p>`).join('')}`;
}
// Standings: the selected week's and the season's W–L and winning percentage side by side, then what they leave out.
export function standingsSeasonHtml(s){
  if(!s)return'<div class="empty">Season record unavailable.</div>';
  const head=`<thead><tr><th scope="col" rowspan="2">Entry</th><th scope="colgroup" colspan="2" class="c season-group">Week ${s.week}</th><th scope="colgroup" colspan="2" class="c season-group">Season</th></tr><tr><th scope="col" class="c">W–L</th><th scope="col" class="c">Win %</th><th scope="col" class="c">W–L</th><th scope="col" class="c">Win %</th></tr></thead>`;
  const rows=s.people.map(p=>{const r=shownSeason(s,p);return`<tr><td class="entry"><span class="season-name">${esc(p.name)}</span>${p.week.noSubmission?'<span class="season-flag">No picks</span>':''}</td><td class="c">${recordText(p.week.w,p.week.l)}</td><td class="c">${winPct(p.week.w,p.week.l)}</td><td class="c season-total">${r?recordText(r.w,r.l):'—'}</td><td class="c season-total">${r?winPct(r.w,r.l):'—'}</td></tr>`}).join('');
  const g=s.games,notes=[];
  const status=seasonStatusText(s);if(status)notes.push(`<p class="season-status">${esc(status)}</p>`);
  for(const p of s.people)if(p.reason)notes.push(`<p class="season-status">${esc(p.reason)}.</p>`);
  for(const p of s.people)if(shownSeason(s,p)&&p.noPicks.length)notes.push(`<p>${esc(`${p.name}: no picks submitted in ${weekList(p.noPicks)}. Every graded game ${p.noPicks.length===1?'that week':'in those weeks'} counts as a loss, as in the weekly standings.`)}</p>`);
  if(g){const left=[g.pending&&`${plural(g.pending,'live or upcoming game')} not graded yet`,g.void&&`${plural(g.void,'game')} void by commissioner ruling, not counted`,g.hold&&`${plural(g.hold,'game')} on hold, not graded`].filter(Boolean);if(left.length)notes.push(`<p>${esc(`${left.join(' · ')}.`)}</p>`)}
  notes.push('<p>Win % = wins ÷ (wins + losses), to one decimal; — until a game is graded. An NFL tie is a loss for both picks. Win % is a win–loss rate, not the field percentile (Top %) in Your Group.</p>');
  return`<table class="season-table">${head}<tbody>${rows}</tbody></table><div class="season-notes">${notes.join('')}</div>`;
}

// ---- The page part.
function jwtExpiry(token){try{const part=token.split('.')[1],json=atob(part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'=')),exp=Number(JSON.parse(json)?.exp);return Number.isFinite(exp)?exp*1000:0}catch{return 0}}
// The rows of the season's rules and rulings that belong to one week, as the page's own week-scoped read returns them. A row
// that cannot be attributed to a week reaches every week, so the evaluator holds each of them rather than any being trusted.
export function weekRulings(data,week){
  const rows=Array.isArray(data?.rulings)?data.rulings:[],attributable=rows.every(r=>r&&typeof r==='object'&&!Array.isArray(r)&&Number.isInteger(r.week)&&r.week>=1&&r.week<=22);
  return{contests:data?.contests,policies:data?.policies,rulings:attributable?rows.filter(r=>r.week===week):rows};
}
export function boot(){
  const history=new Map(),reads=new Set();
  let rulings={season:null,data:null,at:0,tried:0,error:null},state=null,last=null,running=false,again=false,shown={};
  let token=null,tokenExpiresAt=0,tokenRequest=null;
  const ask=(op,extra={})=>{const detail={op,...extra,result:null};document.dispatchEvent(new CustomEvent('poolcenter:season',{detail}));return detail.result};
  const key=(season,week)=>`${season}-${week}`;
  const entry=(season,week)=>{const k=key(season,week);if(!history.has(k))history.set(k,{season,week,prepared:null,revision:0,rowError:null,rowTried:0,nfl:null,events:null,issues:[],feedAt:0,feedTried:0,feedError:null,rulings:null,graded:null});return history.get(k)};
  const seasonHistory=season=>new Map([...history.values()].filter(e=>e.season===season).map(e=>[e.week,e]));
  // A read and everything it waits for (token, headers, body) share one time limit.
  function limited(read){
    const c=new AbortController,t=setTimeout(()=>c.abort(),READ_TIMEOUT_MS);
    const fail=new Promise((_,reject)=>c.signal.addEventListener('abort',()=>reject(new Error('timed out')),{once:true}));fail.catch(()=>{});
    const race=p=>Promise.race([p,fail]);
    return Promise.resolve().then(()=>read(c.signal,race)).finally(()=>clearTimeout(t));
  }
  // The anonymous token, shared by this module's reads, with its own time limit (as the page's), so a token request that
  // never answers is abandoned and the next read asks again.
  async function anonymousToken(){
    if(token&&Date.now()<tokenExpiresAt-60000)return token;
    if(!tokenRequest){const c=new AbortController,t=setTimeout(()=>c.abort(),READ_TIMEOUT_MS);tokenRequest=fetch(`${NEON_AUTH_URL}/token/anonymous`,{cache:'no-store',headers:{Accept:'application/json'},signal:c.signal}).then(async r=>{if(!r.ok)throw new Error(`anonymous auth ${r.status}`);const j=await r.json();if(!j?.token)throw new Error('anonymous auth returned no token');token=j.token;tokenExpiresAt=jwtExpiry(token)||Date.now()+5*60*1000;return token}).finally(()=>{clearTimeout(t);tokenRequest=null})}
    return tokenRequest;
  }
  async function dataApi(path,label,signal,race){
    const auth=await race(anonymousToken()),r=await race(fetch(`${NEON_DATA_URL}/${path}`,{cache:'no-store',headers:{Authorization:`Bearer ${auth}`,Accept:'application/json'},signal}));
    if(!r.ok)throw new Error(`${label} ${r.status}`);
    const data=await race(r.json());if(!Array.isArray(data))throw new Error(`${label} is not a list`);return data;
  }
  const readers={
    row:({season,week},signal,race)=>dataApi(`nfl_pool_weeks?select=${PUB_ROW_COLUMNS}&season=eq.${season}&week=eq.${week}&status=eq.locked`,'week data',signal,race),
    async feed({season,week},signal,race){
      const r=await race(fetch(`${ESPN_SCOREBOARD}?dates=${season}&seasontype=2&week=${week}&limit=100&_=${Date.now()}`,{signal,cache:'no-store',headers:{Accept:'application/json'}}));
      if(!r.ok)throw new Error(`ESPN ${r.status}`);
      const j=await race(r.json());if(!j||!Array.isArray(j.events))throw new Error('invalid ESPN payload');return{events:j.events};
    },
    async rulings({season},signal,race){
      const id=encodeURIComponent(contestIdFor(season,'pickem'));
      const [contests,policies,rows]=await Promise.all([
        dataApi(`nfl_contests?select=${PUBLIC_COLUMNS.contests.join(',')}&contest_id=eq.${id}`,'nfl_contests',signal,race),
        dataApi(`nfl_contest_policies?select=${PUBLIC_COLUMNS.policies.join(',')}&contest_id=eq.${id}&order=revision.asc`,'nfl_contest_policies',signal,race),
        dataApi(`nfl_incident_rulings?select=${PUBLIC_COLUMNS.rulings.join(',')}&contest_id=eq.${id}&order=week.asc,chain_seq.asc`,'nfl_incident_rulings',signal,race)
      ]);
      return{contests,policies,rulings:rows};
    }
  };
  const readKey=t=>t.kind==='rulings'?`rulings-${t.season}`:`${t.kind}-${t.season}-${t.week}`;
  const failure=e=>e?.message||String(e);
  // What the season of the week on screen still needs, given what is kept and when it was last read.
  function due(now){
    if(!state?.ready)return[];
    const season=state.season,others=state.index.filter(x=>x.season===season&&x.week!==state.week),tasks=[];
    for(const x of others){
      const e=history.get(key(season,x.week));
      if(!e?.prepared||e.revision<x.revision){if(!reads.has(readKey({kind:'row',...x}))&&now-(e?.rowTried||0)>=RETRY_MS)tasks.push({kind:'row',season,week:x.week,revision:x.revision});continue}
      if((!e.feedAt||!e.graded?.settled)&&!reads.has(readKey({kind:'feed',...x}))&&now-Math.max(e.feedAt,e.feedTried)>=FEED_EVERY_MS)tasks.push({kind:'feed',season,week:x.week,revision:e.revision});
    }
    const fresh=rulings.season===season&&rulings.at&&now-rulings.at<RULINGS_EVERY_MS;
    if(season>=FIRST_RULING_SEASON&&others.length&&!fresh&&!reads.has(`rulings-${season}`)&&(rulings.season!==season||now-rulings.tried>=RETRY_MS))tasks.push({kind:'rulings',season});
    return tasks;
  }
  // The rules and rulings a week is graded with: the week's rows of the last good season read (stale while the latest read
  // failed), the failure itself when no read has succeeded, or nothing yet.
  const rulingsFor=week=>week.season<FIRST_RULING_SEASON?{rulings:{data:null}}:rulings.season!==week.season?{}:rulings.data?{rulings:{data:weekRulings(rulings.data,week.week)},stale:rulings.error!==null}:rulings.error?{rulings:{error:new Error(rulings.error)}}:{};
  // One read's answer (or failure), applied to what is kept; a failed read keeps whatever was verified before it.
  function apply({task,ok,data,error,at}){
    if(task.kind==='rulings'){
      rulings=ok?{season:task.season,data,at,tried:at,error:null}:{...(rulings.season===task.season?rulings:{data:null,at:0}),season:task.season,tried:at,error};
      for(const e of history.values())if(e.season===task.season&&e.prepared){
        const r=ask('grade',{week:e.prepared,nfl:e.nfl,events:e.events,issues:e.issues,rulings:ok?{data:weekRulings(data,e.week)}:{error:new Error(error)},previous:e.rulings});
        if(r?.ok)Object.assign(e,{rulings:r.rulings,graded:r.graded});
      }
      return;
    }
    const e=entry(task.season,task.week);
    if(task.kind==='row'){
      e.rowTried=at;
      const r=ok?ask('prepare',{entry:{season:task.season,week:task.week,revision:task.revision},data}):null;
      if(!r?.ok){e.rowError=ok?(r?.error||'the published row could not be accepted'):error;return}
      if(e.prepared&&e.revision>=r.week.revision){e.rowError=null;return}
      // A new revision replaces the week whole: its games may differ, so nothing graded before is kept and its feed is read
      // again; its rules and rulings are evaluated afresh from the season read, as the page does for a revision it installs.
      const g=ask('grade',{week:r.week,...rulingsFor(r.week)});
      Object.assign(e,{prepared:r.week,revision:r.week.revision,rowError:null,nfl:null,events:null,issues:[],feedAt:0,feedTried:0,feedError:null,rulings:g?.ok?g.rulings:null,graded:g?.ok?g.graded:null});
    }else if(task.kind==='feed'){
      if(!e.prepared||e.revision!==task.revision)return;
      e.feedTried=at;
      const r=ok?ask('grade',{week:e.prepared,nfl:e.nfl,events:data.events,parse:true,previous:e.rulings}):null;
      if(!r?.ok){e.feedError=ok?(r?.error||'the score feed could not be read'):error;return}
      Object.assign(e,{nfl:r.nfl,events:data.events,issues:r.issues,rulings:r.rulings,graded:r.graded,feedAt:at,feedError:null});
    }
  }
  // The week the page had on screen before another was chosen keeps the grade the page gave it: its facts, raw feed, issues
  // and rulings, as the page verified them, unless the history already has a newer revision of it.
  function handOver(next){
    if(!last||(last.season===next.season&&last.week===next.week))return;
    const c=last.current,e=history.get(key(last.season,last.week));
    if(c.feed.fetchedAt===null||c.rulings===null||(e?.prepared&&e.revision>last.revision))return;
    Object.assign(entry(last.season,last.week),{prepared:c.week,revision:last.revision,rowError:null,nfl:c.nfl,events:c.events,issues:c.issues,rulings:c.rulings,graded:c.graded,
      feedAt:Date.parse(c.feed.fetchedAt)||Date.now(),feedTried:0,feedError:c.feed.failed?'the latest score refresh failed':null});
  }
  function render(){
    if(state&&!state.ready&&state.switching)return;
    const summary=state?.ready?seasonSummary(state,seasonHistory(state.season),{rulingsError:rulings.season===state.season&&!rulings.data?rulings.error:null}):null;
    const put=(id,html,text=false)=>{const node=document.getElementById(id);if(!node||shown[id]===html)return;shown[id]=html;if(text)node.textContent=html;else node.innerHTML=html};
    put('homeSeason',summary?homeSeasonHtml(summary):'');
    put('seasonRecord',summary?standingsSeasonHtml(summary):`<div class="empty">${esc(state?.reason?`Season record unavailable: ${state.reason}.`:'Loading season record…')}</div>`);
    put('seasonMeta',summary?seasonMetaText(summary):'Season record unavailable',true);
  }
  // Nothing unexpected here may stop the history or reach the page that announced a change: it is reported and skipped.
  function read(){try{state=ask('state');if(state?.ready){handOver(state);last=state}render()}catch(e){console.warn(e)}}
  // Every read that is due starts, at most MAX_READS at a time; each one's answer is applied as it arrives and starts whatever
  // it made due (a week's feed once its row is accepted), so a slow read never holds up the others. A read just answered or
  // just failed is not due again until its interval has passed, so this always settles.
  async function run(){
    if(running){again=true;return}
    running=true;
    try{
      await new Promise(done=>{
        let active=0;
        const start=task=>{
          const k=readKey(task);reads.add(k);active++;
          limited((signal,race)=>readers[task.kind](task,signal,race))
            .then(data=>({task,ok:true,data,at:Date.now()}),e=>({task,ok:false,error:failure(e),at:Date.now()}))
            .then(result=>{reads.delete(k);active--;try{apply(result)}catch(e){console.warn(e)}read();pump()});
        };
        const pump=()=>{let tasks=[];try{tasks=due(Date.now())}catch(e){console.warn(e)}for(const task of tasks){if(active>=MAX_READS)break;if(!reads.has(readKey(task)))start(task)}if(!active)done()};
        pump();
      });
    }finally{running=false;if(again){again=false;read();void run()}}
  }
  document.addEventListener('poolcenter:update',event=>{if(event?.detail?.contest!=='pickem')return;read();void run()});
  // Until Pick'em first says it has a week on screen (or that it could not load one), the page's own "Loading season
  // record…" stays. Either may already be so when this module starts.
  const first=ask('state');
  if(first?.ready){read();void run()}else if(first?.failed)read();
  return{history,get rulings(){return rulings},get state(){return state},run,render};
}
if(typeof document!=='undefined'&&typeof document.addEventListener==='function'&&typeof document.dispatchEvent==='function')boot();
