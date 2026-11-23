// Reusable NFL scoreboard validation pattern from the Personal NFL Pool Center.
// Pure and offline: never fetches ESPN, shares the Personal score proxy, reads secrets,
// authorizes a pool, scores a submission or publishes results.
// A future scoped service may validate a response against one season/week and a trusted
// schedule, then separately apply access controls and contest-specific rulings.
import {NFL_TEAMS} from '../schedule-core.js';
import {reviewLiveScoreBatch} from './live-score-contract.mjs';

export const ESPN_SCORE_SOURCE='espn_scoreboard';
const TEAM_SET=new Set(NFL_TEAMS.map(t=>t.key));
const GAME_ID=/^[A-Za-z0-9_-]{1,100}$/;
const EVENT_ID=/^[A-Za-z0-9_-]{1,60}$/;
const FINAL=/FINAL/i;
const HALTED=/CANCEL|POSTPON|SUSPEND|FORFEIT/i;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const ts=x=>typeof x==='string'&&/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(x)
  &&Number.isFinite(Date.parse(x));
const canonicalCode=code=>{
  if(typeof code!=='string'||!/^[A-Z]{2,4}$/.test(code))return null;
  const resolved=code==='WSH'?'WAS':code;
  return TEAM_SET.has(resolved)?resolved:null;
};
const teamCode=x=>typeof x==='string'?x:x?.key;
const validScore=value=>{
  if(typeof value==='string'){
    if(!/^\d{1,3}$/.test(value))return null;
    value=Number(value);
  }
  return Number.isSafeInteger(value)&&value>=0&&value<=200?value:null;
};
function pair(event){
  const competitors=event?.competitions?.[0]?.competitors;
  if(!Array.isArray(competitors)||competitors.length!==2)return null;
  const away=competitors.filter(x=>x?.homeAway==='away');
  const home=competitors.filter(x=>x?.homeAway==='home');
  return away.length===1&&home.length===1?{away:away[0],home:home[0]}:null;
}
function parseStatus(event,pair){
  const type=event?.status?.type,comp=event?.competitions?.[0]?.status?.type;
  if(!object(type)||!['pre','in','post'].includes(type.state)
    ||typeof type.completed!=='boolean')return {error:'invalid_event_status'};
  const names=[type.name,comp?.name].filter(x=>x!==undefined&&x!==null);
  if(names.some(x=>typeof x!=='string'))return {error:'invalid_event_status_name'};
  if(names.some(x=>HALTED.test(x))){
    if(type.completed||type.state==='post')return {error:'contradictory_halted_result'};
    const halted=names.join(' ').toUpperCase();
    if(halted.includes('FORFEIT'))return {error:'unreviewed_forfeit'};
    // Never erase a previously observed in-game score by replacing a
    // suspended/halted match with invented zeroes. Leave last-good facts intact.
    const away=validScore(pair.away?.score),home=validScore(pair.home?.score);
    if((away!==null&&away!==0)||(home!==null&&home!==0))return {error:'halted_with_score'};
    const status=halted.includes('POSTPON')?'postponed':
      halted.includes('SUSPEND')?'suspended':'canceled';
    return {status,away_score:0,home_score:0};
  }
  if(type.completed){
    if(type.state!=='post'||!FINAL.test(type.name||'')
      ||comp?.completed===false
      ||(comp?.state!==undefined&&comp.state!=='post')
      ||(comp?.name!==undefined&&!FINAL.test(comp.name)))return {error:'unverified_final'};
  }else if(type.state==='post')return {error:'unverified_final'};
  else if(type.state==='pre'&&(comp?.completed===true||comp?.state==='post'))
    return {error:'contradictory_pre'};
  const away=validScore(pair.away?.score),home=validScore(pair.home?.score);
  if(type.state==='in'||type.completed){
    if(away===null||home===null)return {error:'invalid_score'};
    if(type.completed&&((pair.away.winner===true&&!(away>home))
      ||(pair.home.winner===true&&!(home>away))))
      return {error:'contradictory_winner_flag'};
    return {status:type.completed?'final':'in_progress',away_score:away,home_score:home};
  }
  if((away!==null&&away!==0)||(home!==null&&home!==0))
    return {error:'score_before_kickoff'};
  return {status:'scheduled',away_score:0,home_score:0};
}

// All-or-nothing candidate. The context of one source response must match the
// authenticated pool's verified schedule season/week. This parser is not a
// credential or a license for a future ESPN API integration.
export function inspectEspnWeek({feed,verifiedGames,season,week,fetchedAt,previousById={}}={}){
  const errors=[],empty={ok:false,errors,updates:[],unchanged:[],providerReferences:[]};
  if(!Number.isInteger(season)||season<2000||season>2100
    ||!Number.isInteger(week)||week<1||week>18||!ts(fetchedAt)
    ||!Array.isArray(verifiedGames)||verifiedGames.length<1
    ||verifiedGames.length>16||!object(feed)||!Array.isArray(feed.events)
    ||feed.events.length>32)return {...empty,errors:['invalid_feed_or_context']};
  const byMatchup=new Map(),scheduledTeams=new Set();
  for(const g of verifiedGames){
    const away=teamCode(g?.away),home=teamCode(g?.home);
    if(typeof g?.id!=='string'||!GAME_ID.test(g.id)
      ||!TEAM_SET.has(away)||!TEAM_SET.has(home)||away===home
      ||scheduledTeams.has(away)||scheduledTeams.has(home)){
      errors.push('invalid_verified_schedule');continue;
    }
    scheduledTeams.add(away);scheduledTeams.add(home);
    byMatchup.set(away+'|'+home,g.id);
  }
  const observations=[],providerReferences=[],seenIds=new Set(),seenGames=new Set();
  for(const event of feed.events){
    const id=event?.id;
    if((typeof id!=='string'&&!Number.isSafeInteger(id))
      ||!EVENT_ID.test(String(id))||seenIds.has(String(id))){
      errors.push('invalid_or_duplicate_event_id');continue;
    }
    seenIds.add(String(id));
    if(event?.season?.year!==season||event?.season?.type!==2||event?.week?.number!==week){
      errors.push('season_week_mismatch');continue;
    }
    const x=pair(event);
    if(!x){errors.push('invalid_competitors');continue}
    const away=canonicalCode(x.away?.team?.abbreviation);
    const home=canonicalCode(x.home?.team?.abbreviation);
    const gameId=byMatchup.get(away+'|'+home);
    if(!gameId||seenGames.has(gameId)){
      errors.push('unmatched_or_duplicate_matchup');continue;
    }
    seenGames.add(gameId);
    const outcome=parseStatus(event,x);
    if(outcome.error){errors.push(outcome.error+':'+gameId);continue}
    observations.push({game_id:gameId,away_team:away,home_team:home,
      status:outcome.status,away_score:outcome.away_score,home_score:outcome.home_score,
      observed_at:fetchedAt,source:ESPN_SCORE_SOURCE});
    providerReferences.push({game_id:gameId,provider_event_id:String(id)});
  }
  if(seenGames.size!==verifiedGames.length)errors.push('missing_verified_games');
  if(errors.length)return empty;
  const reviewed=reviewLiveScoreBatch({verifiedGames,observations,previousById,
    expectedSource:ESPN_SCORE_SOURCE,now:fetchedAt});
  return {...reviewed,providerReferences:reviewed.ok?providerReferences:[]};
}
