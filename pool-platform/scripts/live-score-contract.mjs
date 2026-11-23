// WP-2A — pure, offline contract for a FUTURE trusted live score adapter.
// This does NOT fetch a score feed, connect to a database, publish standings, or update picks.
// Upstream must independently authorize the source and map vendor IDs to exact verified-schedule game IDs.
const GAME_ID=/^[A-Za-z0-9_-]{1,100}$/;
const TEAM=/^[A-Z]{2,4}$/;
const UTC=/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const VALID_STATES=new Set(['scheduled','in_progress','halftime','delayed','suspended','postponed','canceled','final']);
const NONPLAYING=new Set(['scheduled','postponed','canceled']);
const MAX_SCORE=200;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const team=x=>typeof x==='string'?x:x?.key;
const validId=x=>typeof x==='string'&&GAME_ID.test(x);
const validTeam=x=>typeof x==='string'&&TEAM.test(x);
const validScore=x=>Number.isSafeInteger(x)&&x>=0&&x<=MAX_SCORE;
const parseStamp=x=>typeof x==='string'&&UTC.test(x)&&Number.isFinite(Date.parse(x))?Date.parse(x):NaN;
const keys=x=>obj(x)?Object.keys(x):[];

function normalize(o){
  return {game_id:o.game_id,away_team:o.away_team,home_team:o.home_team,status:o.status,
    away_score:o.away_score,home_score:o.home_score,observed_at:o.observed_at,source:o.source};
}
function coreEqual(a,b){
  return a.game_id===b.game_id&&a.away_team===b.away_team&&a.home_team===b.home_team
    &&a.status===b.status&&a.away_score===b.away_score&&a.home_score===b.home_score
    &&a.source===b.source;
}

// Atomic preview: if ONE record conflicts with verified identities, a final or a newer score,
// return no candidate updates. Caller must not infer this validates provider authenticity.
// `expectedSource` must be configured by the authenticated server, not supplied by a browser.
export function reviewLiveScoreBatch({verifiedGames,observations,previousById={},expectedSource,now,
  maxAgeMs=5*60_000}={}){
  const errors=[],updates=[],unchanged=[];
  if(!Array.isArray(verifiedGames)||verifiedGames.length<1||verifiedGames.length>16)
    errors.push('invalid_verified_games');
  if(!Array.isArray(observations)||observations.length<1||observations.length>16)
    errors.push('invalid_observations');
  if(!obj(previousById))errors.push('invalid_previous_state');
  if(typeof expectedSource!=='string'||!GAME_ID.test(expectedSource))errors.push('unapproved_score_source');
  const nowMs=typeof now==='string'?parseStamp(now):now instanceof Date?now.getTime():NaN;
  if(!Number.isFinite(nowMs)||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0||maxAgeMs>24*60*60_000)
    errors.push('invalid_clock_or_age_limit');
  if(errors.length)return {ok:false,errors,updates:[],unchanged:[]};

  const gameMap=new Map(),teams=new Set();
  for(const game of verifiedGames){
    const id=game?.id,a=team(game?.away),h=team(game?.home);
    if(!validId(id)||gameMap.has(id)||!validTeam(a)||!validTeam(h)
      ||a===h||teams.has(a)||teams.has(h)){
      errors.push('invalid_or_duplicate_verified_identity');continue;
    }
    gameMap.set(id,{away_team:a,home_team:h});
    teams.add(a);teams.add(h);
  }
  const seen=new Set();
  for(const raw of observations){
    const id=raw?.game_id;
    if(!validId(id)||seen.has(id)){errors.push('duplicate_or_invalid_score_id');continue}
    seen.add(id);
    const match=gameMap.get(id);
    if(!match||raw.away_team!==match.away_team||raw.home_team!==match.home_team){
      errors.push('score_identity_mismatch:'+id);continue;
    }
    if(raw.source!==expectedSource||!VALID_STATES.has(raw.status)){
      errors.push('unapproved_score_or_status:'+id);continue;
    }
    const stamp=parseStamp(raw.observed_at);
    if(!Number.isFinite(stamp)||stamp>nowMs+120_000||nowMs-stamp>maxAgeMs){
      errors.push('stale_or_future_score:'+id);continue;
    }
    if(!validScore(raw.away_score)||!validScore(raw.home_score)||
      (NONPLAYING.has(raw.status)&&(raw.away_score!==0||raw.home_score!==0))){
      errors.push('invalid_score:'+id);continue;
    }
    const next=normalize(raw),prev=previousById[id];
    if(prev!==undefined){
      if(!obj(prev)||prev.game_id!==id||
        prev.away_team!==match.away_team||prev.home_team!==match.home_team||
        prev.source!==expectedSource||!VALID_STATES.has(prev.status)){
        errors.push('untrusted_previous_state:'+id);continue;
      }
      const oldTime=parseStamp(prev.observed_at);
      if(!Number.isFinite(oldTime)){
        errors.push('invalid_previous_timestamp:'+id);continue;
      }
      // Final results are immutable in automatic ingestion. Corrections require human review.
      if(prev.status==='final'&&(!coreEqual(prev,next))){
        errors.push('final_correction_needs_review:'+id);continue;
      }
      if(stamp<oldTime||(stamp===oldTime&&!coreEqual(prev,next))){
        errors.push('out_of_order_score:'+id);continue;
      }
      // A transient provider regression must never reopen a game already in progress.
      if(['in_progress','halftime','suspended'].includes(prev.status)
        &&next.status==='scheduled'){
        errors.push('score_status_regression:'+id);continue;
      }
      if(stamp===oldTime&&coreEqual(prev,next)){
        unchanged.push(id);continue;
      }
      if(prev.status==='final'&&coreEqual(prev,next)){
        unchanged.push(id);continue;
      }
    }
    updates.push(next);
  }
  // Unknown persisted IDs are an upstream data-integrity failure, not an invitation to
  // delete or silently ignore a different season, tenant or verified schedule.
  for(const id of keys(previousById))if(!gameMap.has(id))errors.push('unknown_previous_game:'+id);
  return errors.length?{ok:false,errors,updates:[],unchanged:[]}:
    {ok:true,errors:[],updates,unchanged};
}
