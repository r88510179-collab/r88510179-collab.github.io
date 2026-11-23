// Read-only presentation of public NFL scoreboard facts for ONE authorized pool's
// verified week. Never scores a pick, publishes standings, or changes an entry.
// Every event is matched by canonical teams; no cross-pool facts are accepted.
import {normalizeGames} from './participant-core.js';
const team=x=>x==='WSH'?'WAS':x;
const num=x=>{
  if(x===null||x===undefined)return null;
  if(typeof x==='string'&&!/^\d{1,3}$/.test(x))return null;
  const n=typeof x==='string'?Number(x):x;
  return Number.isSafeInteger(n)&&n>=0&&n<=200?n:null;
};
const match=e=>{
  const members=e?.competitions?.[0]?.competitors;
  if(!Array.isArray(members)||members.length!==2)return null;
  const away=members.filter(m=>m?.homeAway==='away'),home=members.filter(m=>m?.homeAway==='home');
  if(away.length!==1||home.length!==1)return null;
  return {away:away[0],home:home[0]};
};
export function validateGameDayFeed({season,week,config,feed,now=new Date()}={}){
  const invalid=reason=>({ok:false,reason,rows:[],fetchedAt:null});
  if(!Number.isInteger(season)||!Number.isInteger(week)||!config)
    return invalid('no_verified_week');
  const games=normalizeGames(config),seen=new Set();
  if(!games.length||games.length>16||games.some(g=>{
    if(seen.has(g.id))return true;seen.add(g.id);
    return !/^[A-Z]{2,4}$/.test(g.away.key)||!/^[A-Z]{2,4}$/.test(g.home.key);
  }))return invalid('invalid_pool_schedule');
  if(feed?.season!==season||feed?.week!==week
    ||feed?.source!=='espn_scoreboard_unofficial'||!Array.isArray(feed.events)
    ||feed.events.length<games.length||feed.events.length>16)return invalid('source_context_mismatch');
  const received=Date.parse(feed.fetched_at),clock=now instanceof Date?now.getTime():Date.parse(now);
  if(!Number.isFinite(received)||!Number.isFinite(clock)||received>clock+120000
    ||received<clock-10*60_000)return invalid('stale_or_future_feed');
  const seenEvents=new Set(),byTeams=new Map();
  for(const e of feed.events){
    if(!e||typeof e.id!=='string'||seenEvents.has(e.id)
      ||e.season?.year!==season||e.season?.type!==2||e.week?.number!==week)
      return invalid('invalid_event_identity');
    seenEvents.add(e.id);
    const p=match(e);
    if(!p)return invalid('invalid_competitors');
    const a=team(p.away.team?.abbreviation),h=team(p.home.team?.abbreviation),k=a+'|'+h;
    if(byTeams.has(k))return invalid('duplicate_matchup');
    byTeams.set(k,{e,p});
  }
  const rows=[];
  for(const g of games){
    const x=byTeams.get(g.away.key+'|'+g.home.key);
    if(!x)return invalid('game_missing');
    const {e,p}=x,s=e.status?.type,comp=e.competitions?.[0]?.status?.type;
    if(!s||!['pre','in','post'].includes(s.state)||typeof s.completed!=='boolean')
      return invalid('unknown_status');
    const name=s.name||'',halted=/CANCEL|SUSPEND|POSTPON|FORFEIT/i.test(name);
    const away=num(p.away.score),home=num(p.home.score);
    let status,label,showScores=false;
    if(halted){
      if(s.completed||s.state==='post'||(away!==null&&away!==0)||(home!==null&&home!==0))return invalid('halted_final_conflict');
      status='halted';label='HALTED';
    }else if(s.completed){
      if(s.state!=='post'||!/FINAL/i.test(name)
        ||(comp?.completed===false)
        ||(comp?.state!==undefined&&comp.state!=='post')
        ||(comp?.name!==undefined&&!/FINAL/i.test(comp.name))
        ||away===null||home===null
        ||(p.away.winner===true&&away<=home)||(p.home.winner===true&&home<=away))
        return invalid('unconfirmed_final');
      status='final';label=away===home?'FINAL TIE':'FINAL';showScores=true;
    }else if(s.state==='in'){
      if(away===null||home===null)return invalid('invalid_live_scores');
      status='live';label='LIVE';showScores=true;
    }else if(s.state==='pre'){
      if((away!==null&&away!==0)||(home!==null&&home!==0))
        return invalid('pregame_score_conflict');
      status='upcoming';label='SCHEDULED';
    }else return invalid('unknown_status');
    rows.push({id:g.id,away:g.away.label,home:g.home.label,status,label,
      awayScore:showScores?away:null,homeScore:showScores?home:null});
  }
  return {ok:true,reason:'',rows,fetchedAt:feed.fetched_at,
    ageSeconds:Math.max(0,Math.floor((clock-received)/1000))};
}
