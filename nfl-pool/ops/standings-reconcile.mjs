#!/usr/bin/env node
// Independent, read-only Pool Center standings recomputation.
//
// Reads exactly what any participant's browser reads (the anonymous Data API token, the locked published Pick'em and
// Survivor rows, and the public nflscores2 score function) and re-derives every tracked entry's weekly record, group rank,
// tiebreak delta, full-field rank, season total and the Survivor counts with its own code. Nothing from the app is
// imported, so a bug in the page's scoring cannot hide here. It logs in nowhere, holds no credential and writes nothing.
//
//   node nfl-pool/ops/standings-reconcile.mjs                 # latest published season
//   node nfl-pool/ops/standings-reconcile.mjs --season 2026 --weeks 1-8 --json out.json
//
// Compare the printed table with the Standings view (or the share snapshot) for the same week. Exit code 2 means the
// public data could not be loaded; 1 means a published game could not be matched to the feed or the feed had a
// consistency problem; 0 otherwise. The pool rule applied: a final NFL tie is a loss for both picks, a missing pick is a
// loss once the game is final, and a game voided by a confirmed commissioner ruling scores nothing.
const AUTH='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const DATA='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const PROXY='https://br-late-hat-b55ygmj4-nflscores2.compute.c-7.us-east-2.aws.neon.tech/';
const ALIAS={JAC:'JAX',WSH:'WAS'};const norm=t=>ALIAS[t]||t;
const options={season:null,weeks:null,json:null};
for(let i=2;i<process.argv.length;i++){const a=process.argv[i],v=process.argv[i+1];if(!['--season','--weeks','--json'].includes(a)||v===undefined){console.error('usage: standings-reconcile.mjs [--season YYYY] [--weeks N-M] [--json file]');process.exit(2)}options[a.slice(2)]=v;i++}
let problems=0;const flag=msg=>{problems++;console.log('  ! '+msg)};
async function getJson(url,init){const r=await fetch(url,{...init,signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`${new URL(url).host} ${r.status}`);return r.json()}
let token,weeks,survivor,rulings;
try{
  token=(await getJson(`${AUTH}/token/anonymous`,{headers:{Accept:'application/json'}})).token;
  const read=q=>getJson(`${DATA}/${q}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  weeks=await read('nfl_pool_weeks?select=season,week,status,revision,published_at,config&status=eq.locked&order=season.asc,week.asc');
  survivor=await read('nfl_survivor_weeks?select=season,week,status,revision,published_at,config&status=eq.locked&order=season.asc,week.asc');
  rulings=await read('nfl_incident_rulings?select=contest_id,week,away_team,home_team,policy_revision,chain_seq,consequence&order=ruling_id.asc');
}catch(e){console.error('could not load the public data: '+(e.message||e));process.exit(2)}
const season=options.season?Number(options.season):Math.max(...weeks.map(w=>w.season));
const range=options.weeks?String(options.weeks).match(/^(\d{1,2})(?:-(\d{1,2}))?$/):null;
const inRange=w=>!range||(w>=Number(range[1])&&w<=Number(range[2]??range[1]));
const feeds=new Map();
async function feedResults(week){
  if(feeds.has(week))return feeds.get(week);
  const j=await getJson(`${PROXY}?season=${season}&week=${week}`,{headers:{Accept:'application/json'}});
  const byPair=new Map(),byTeam=new Map(),issues=[];
  for(const e of j.events||[]){
    const cs=e.competitions?.[0]?.competitors||[],away=cs.find(x=>x?.homeAway==='away'),home=cs.find(x=>x?.homeAway==='home');
    if(!away||!home||cs.length!==2){issues.push(`event ${e.id} malformed`);continue}
    const a=norm(away.team?.abbreviation),h=norm(home.team?.abbreviation),done=e.status?.type?.completed===true,name=e.status?.type?.name||'';
    const as=/^\d+$/.test(String(away.score))?Number(away.score):null,hs=/^\d+$/.test(String(home.score))?Number(home.score):null;
    let winner=null,tie=false;
    if(done){
      if(as===null||hs===null){issues.push(`event ${e.id} ${a}@${h} completed without scores`);continue}
      if(!/FINAL/.test(name)||/CANCEL|POSTPON|SUSPEND|FORFEIT/.test(name))issues.push(`event ${e.id} ${a}@${h} completed but status ${name}`);
      if(as===hs)tie=true;else winner=as>hs?a:h;
      if((away.winner===true&&winner!==a)||(home.winner===true&&winner!==h))issues.push(`event ${e.id} ${a}@${h} winner flag disagrees with the score`);
    }
    const rec={a,h,done,winner,tie,as,hs,eventId:String(e.id),name};
    if(byPair.has(`${a}@${h}`))issues.push(`duplicate listing ${a}@${h}`);byPair.set(`${a}@${h}`,rec);
    for(const t of [a,h]){if(byTeam.has(t))issues.push(`${t} appears in two events`);byTeam.set(t,rec)}
  }
  const out={byPair,byTeam,issues,fetchedAt:j.fetchedAt,count:(j.events||[]).length};feeds.set(week,out);return out;
}
const seasonTotals=new Map(),report=[];
for(const row of weeks.filter(w=>w.season===season&&inRange(w.week))){
  const c=row.config,week=row.week;let res;
  try{res=await feedResults(week)}catch(e){console.error(`Week ${week}: score feed unavailable (${e.message||e})`);process.exit(2)}
  const games=c.games.map((g,i)=>({i,away:norm(g.away),home:norm(g.home),awayNumber:g.awayNumber,homeNumber:g.homeNumber,eventId:g.eventId?String(g.eventId):null}));
  const numberTeam=new Map();games.forEach(g=>{numberTeam.set(g.awayNumber,{i:g.i,team:g.away});numberTeam.set(g.homeNumber,{i:g.i,team:g.home})});
  const result=games.map(g=>res.byPair.get(`${g.away}@${g.home}`)||null);
  const chains=new Map();for(const r of rulings.filter(r=>r.contest_id===`pool-center-${season}-pickem`&&r.week===week)){const k=`${r.away_team}@${r.home_team}|${r.policy_revision}`;if(!chains.has(k)||chains.get(k).chain_seq<r.chain_seq)chains.set(k,r)}
  const voided=new Set();for(const [k,r] of chains)if(r.consequence==='void'){const idx=games.findIndex(g=>`${g.away}@${g.home}`===k.split('|')[0]);if(idx>=0)voided.add(idx)}
  const picksOf=numbers=>games.map((g,i)=>{const n=numbers[i];if(n===null||n===0)return null;const hit=numberTeam.get(n);return hit&&hit.i===i?hit.team:null});
  const score=picks=>{let w=0,l=0,left=0;games.forEach((g,i)=>{if(voided.has(i))return;const r=result[i];if(!r||!r.done){left++;return}if(r.tie){l++;return}if(picks[i]===r.winner)w++;else l++});return{w,l,left}};
  const tbi=c.tiebreakGameIndex,tbr=result[tbi],tbTotal=tbr?.done&&!voided.has(tbi)?tbr.as+tbr.hs:null;
  const diffOf=guess=>tbTotal!==null&&Number.isInteger(guess)?Math.abs(guess-tbTotal):null;
  const tracked=c.participants.map((p,pi)=>({name:p.displayName,id:p.id??String(pi),...score(picksOf(p.pickNumbers)),diff:diffOf(p.tiebreak),tiebreak:p.tiebreak,noSubmission:p.pickNumbers.every(n=>n===null)&&p.tiebreak===null,order:pi}));
  const sortRows=rows=>rows.slice().sort((x,y)=>y.w-x.w||x.l-y.l||(tbTotal!==null?(x.diff??Infinity)-(y.diff??Infinity):0)||x.order-y.order);
  const same=(x,y)=>x.w===y.w&&x.l===y.l&&(tbTotal===null||x.diff===y.diff);
  const rank=rows=>{const sorted=sortRows(rows);let r=1;sorted.forEach((x,i)=>{if(i&&!same(x,sorted[i-1]))r=i+1;x.rank=r});sorted.forEach(x=>{x.ties=sorted.filter(y=>same(x,y)).length});return sorted};
  const trackedRanked=rank(tracked);
  let fieldSize=null;
  if(c.fullFieldReady===true&&Array.isArray(c.fieldEntries)){
    const all=rank([...tracked.map(t=>({...t})),...c.fieldEntries.map((f,fi)=>({id:f.id,...score(picksOf(f.pickNumbers)),diff:diffOf(f.tiebreak),order:tracked.length+fi}))]);
    fieldSize=all.length;const best=all[0].w;
    for(const t of trackedRanked){const m=all.find(x=>x.id===t.id);t.field=`${m.ties>1?'T-':'#'}${m.rank}`;t.topPercent=Math.max(1,Math.ceil(m.rank/all.length*100));t.behind=Math.max(0,best-t.w)}
  }
  for(const t of tracked){const tot=seasonTotals.get(t.id)||{name:t.name,w:0,l:0,noPicks:[]};tot.w+=t.w;tot.l+=t.l;if(t.noSubmission)tot.noPicks.push(week);seasonTotals.set(t.id,tot)}
  const tb=games[tbi];
  console.log(`\n${season} Week ${week} · revision ${row.revision} · ${games.length} published games, ${res.count} feed events, ${result.filter(r=>r?.done).length} final · tiebreak ${tb.away}@${tb.home} = ${tbTotal??'not final'}${fieldSize?` · field ${fieldSize}`:' · no full field'}${voided.size?` · VOID games ${[...voided].map(i=>`${games[i].away}@${games[i].home}`).join(', ')}`:''}`);
  for(const x of res.issues)flag(`feed: ${x}`);
  games.forEach((g,i)=>{if(!result[i])flag(`${g.away}@${g.home} is not in the Week ${week} feed`);else if(g.eventId&&result[i].eventId!==g.eventId)flag(`${g.away}@${g.home}: published event ${g.eventId} but the feed lists ${result[i].eventId}`)});
  for(const t of trackedRanked)console.log(`  ${String(t.rank).padStart(2)}  ${t.name.padEnd(10)} ${String(t.w).padStart(2)}-${String(t.l).padEnd(2)} left ${t.left}  tiebreak ${String(t.tiebreak??'—').padEnd(3)} Δ ${String(t.diff??'—').padEnd(3)}${fieldSize?`  overall ${t.field} · top ${t.topPercent}% · ${t.behind} back`:''}${t.noSubmission?'  (no submission)':''}`);
  report.push({season,week,revision:row.revision,games:games.length,feedEvents:res.count,feedFetchedAt:res.fetchedAt,tiebreak:`${tb.away}@${tb.home}`,tiebreakTotal:tbTotal,fieldSize,voided:[...voided],tracked:trackedRanked.map(t=>({name:t.name,id:t.id,rank:t.rank,w:t.w,l:t.l,left:t.left,tiebreak:t.tiebreak,diff:t.diff,field:t.field??null,topPercent:t.topPercent??null,behind:t.behind??null,noSubmission:t.noSubmission}))});
}
console.log(`\n${season} season to date (tracked entries, graded games only)`);
for(const t of seasonTotals.values())console.log(`  ${t.name.padEnd(10)} ${t.w}-${t.l}  ${(t.w+t.l)?(100*t.w/(t.w+t.l)).toFixed(1)+'%':'—'}${t.noPicks.length?`  no picks: week${t.noPicks.length>1?'s':''} ${t.noPicks.join(', ')}`:''}`);

// Survivor: the latest locked snapshot of the season, graded week by week from the feeds (no pick or a repeated team is
// out that week; a loss or an NFL tie is out; a team absent from the week feed or not final is pending).
const sv=survivor.filter(s=>s.season===season).at(-1);let survivorOut=null;
if(sv){
  const c=sv.config,entries=[...c.trackedEntries,...c.fieldEntries],results=[];
  try{for(let w=1;w<=c.week;w++)results.push((await feedResults(w)).byTeam)}catch(e){console.error(`Survivor: score feed unavailable (${e.message||e})`);process.exit(2)}
  const grade=(entry,through)=>{const used=new Set();for(let i=0;i<through;i++){const p=entry.picks[i];if(!p)return{status:'out',week:i+1,why:'no pick'};if(used.has(p))return{status:'out',week:i+1,why:'repeated team'};used.add(p);const r=results[i].get(p);if(!r)return{status:'pending',week:i+1,why:'absent from feed'};if(!r.done)return{status:'pending',week:i+1,why:'not final'};if(r.tie)return{status:'out',week:i+1,why:'tie'};if(r.winner!==p)return{status:'out',week:i+1,why:'loss'}}return{status:'alive',week:through}};
  const states=entries.map(e=>grade(e,c.week)),prior=entries.map(e=>grade(e,c.week-1));
  const eligible=entries.filter((e,i)=>prior[i].status==='alive'),legal=eligible.filter(e=>e.picks[c.week-1]&&!e.picks.slice(0,c.week-1).includes(e.picks[c.week-1]));
  const dist=new Map();for(const e of legal)dist.set(e.picks[c.week-1],(dist.get(e.picks[c.week-1])||0)+1);
  const counts={poolSize:entries.length,eligibleEntering:eligible.length,submitted:eligible.filter(e=>e.picks[c.week-1]).length,legalPicks:legal.length,stillIn:states.filter(s=>s.status==='alive'||s.status==='pending').length,pending:states.filter(s=>s.status==='pending').length,outBefore:states.filter(s=>s.status==='out'&&s.week<c.week).length,outThisWeek:states.filter(s=>s.status==='out'&&s.week===c.week).length};
  const perWeek=[];for(let w=1;w<=c.week;w++){const st=entries.map(e=>grade(e,w));perWeek.push({week:w,remaining:st.filter(s=>s.status!=='out').length,eliminated:st.filter(s=>s.status==='out'&&s.week===w).length})}
  console.log(`\nSurvivor ${season} Week ${sv.week} · revision ${sv.revision} · ${entries.length} entries (published competitionSize ${c.competitionSize}, currentWeekEntryCount ${c.currentWeekEntryCount})`);
  console.log(`  eligible entering ${counts.eligibleEntering} · submitted ${counts.submitted} · legal ${counts.legalPicks} · still in ${counts.stillIn} · pending ${counts.pending} · out before ${counts.outBefore} · out this week ${counts.outThisWeek}`);
  console.log('  tracked: '+c.trackedEntries.map((e,i)=>`${e.displayName} ${states[i].status.toUpperCase()}${states[i].status!=='alive'?` (Week ${states[i].week}, ${states[i].why})`:''}`).join(' · '));
  console.log('  distribution: '+[...dist].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([t,n])=>`${t} ${n} (${Math.round(100*n/legal.length)}%)`).join(', '));
  console.log('  attrition: '+perWeek.map(x=>`W${x.week} ${x.remaining} left / ${x.eliminated} out`).join(' · '));
  survivorOut={season,week:sv.week,revision:sv.revision,counts,tracked:c.trackedEntries.map((e,i)=>({name:e.displayName,...states[i]})),distribution:[...dist].map(([team,count])=>({team,count})),perWeek};
}else console.log(`\nSurvivor: no locked ${season} snapshot`);
const latestPool=weeks.filter(w=>w.season===season).at(-1);
if(latestPool&&sv&&sv.week<latestPool.week)console.log(`\nNote: the latest Survivor snapshot is Week ${sv.week} while Pick'em is published through Week ${latestPool.week}.`);
if(options.json){const fs=await import('node:fs');fs.writeFileSync(options.json,JSON.stringify({generatedAt:new Date().toISOString(),season,pickem:report,seasonTotals:[...seasonTotals.values()],survivor:survivorOut,problems},null,1));console.log(`\nwrote ${options.json}`)}
console.log(problems?`\n${problems} problem(s) found`:'\nno feed or matching problems');
process.exitCode=problems?1:0;
