// OFFLINE compatibility adapter for the Personal NFL Pool's working nflscores2
// projection ({fetchedAt,events}). No fetch, credential or deployment access.
// This is NOT permission to redistribute ESPN facts or publish official results.
// Its source omits season/week; require independently verified schedule identity
// before attaching those fields to events. Fail closed rather than guessing.
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const alias=x=>x==='WSH'?'WAS':x==='JAC'?'JAX':x;
const code=x=>{
  const v=alias(typeof x==='string'?x:x?.key);
  return typeof v==='string'&&/^[A-Z]{2,4}$/.test(v)?v:null;
};
const pair=(a,h)=>a+'|'+h;
const score=x=>x==null||(Number.isSafeInteger(x)&&x>=0&&x<=200)||
  (typeof x==='string'&&/^\d{1,3}$/.test(x)&&Number(x)<=200);
const fail=reason=>({ok:false,reason,feed:null});

// verifiedGames comes from an independently maintained NFL schedule, never
// from user-supplied week/query fields or from the Personal proxy response.
// Each public game must specify both teams AND either a known kickoff or an
// independently verified provider event id. The verified schedule catalog stores\n// NFL kickoff in the field 'kickoff'; 'kickoffAt' is also accepted. No PII.
export function adaptPersonalScoreFeed(raw,{season,week,verifiedGames,now=new Date()}={}){
  if(!Number.isInteger(season)||season<2020||season>2100||
     !Number.isInteger(week)||week<1||week>18||
     !Array.isArray(verifiedGames)||!verifiedGames.length||verifiedGames.length>16)
    return fail('invalid_verified_schedule');
  const at=Date.parse(raw?.fetchedAt),clock=now instanceof Date?now.getTime():Date.parse(now);
  if(typeof raw?.fetchedAt!=='string'||!Number.isFinite(at)||!Number.isFinite(clock)||
     at>clock+120000||at<clock-600000)return fail('stale_or_invalid_source');
  const schedule=new Map();
  for(const g of verifiedGames){
    const a=code(g?.away),h=code(g?.home);
    if(!a||!h||a===h||schedule.has(pair(a,h)))return fail('invalid_verified_schedule');
    const kickoffValue=g?.kickoffAt??g?.kickoff??null;
    const kickoff=kickoffValue==null?null:Date.parse(kickoffValue);
    if(kickoffValue!=null&&!Number.isFinite(kickoff))return fail('invalid_schedule_kickoff');
    if(g?.providerId!=null&&(typeof g.providerId!=='string'||!g.providerId))
      return fail('invalid_schedule_identity');
    if(kickoff===null&&g?.providerId==null)return fail('missing_independent_game_identity');
    schedule.set(pair(a,h),{kickoff,providerId:g?.providerId??null});
  }
  if(!Array.isArray(raw?.events)||raw.events.length!==schedule.size)
    return fail('incomplete_week_events');
  const ids=new Set(),matched=new Set(),events=[];
  for(const e of raw.events){
    if(!record(e)||typeof e.id!=='string'||!e.id||ids.has(e.id))
      return fail('invalid_event_identity');
    ids.add(e.id);
    if(e.season!=null&&(Number(e.season.year)!==season||Number(e.season.type)!==2))
      return fail('contradictory_season');
    if(e.week!=null&&Number(e.week.number)!==week)return fail('contradictory_week');
    if(!Array.isArray(e.competitions)||e.competitions.length!==1)
      return fail('invalid_competition');
    const c=e.competitions[0],people=c?.competitors;
    if(!Array.isArray(people)||people.length!==2)return fail('invalid_competitors');
    const away=people.find(x=>x?.homeAway==='away');
    const home=people.find(x=>x?.homeAway==='home');
    if(!away||!home||away===home)return fail('invalid_home_away');
    const key=pair(code(away.team?.abbreviation),code(home.team?.abbreviation));
    const verified=schedule.get(key);
    if(!verified||matched.has(key))return fail('unmatched_or_duplicate_game');
    matched.add(key);
    if(verified.providerId&&e.id!==verified.providerId)return fail('provider_id_mismatch');
    if(verified.kickoff!==null){
      const kickoff=Date.parse(e.date);
      // A postponement beyond 36h requires independent schedule re-verification.
      if(!Number.isFinite(kickoff)||Math.abs(kickoff-verified.kickoff)>36*3600000)
        return fail('kickoff_mismatch');
    }
    const state=e.status?.type?.state,completed=e.status?.type?.completed;
    const name=e.status?.type?.name;
    if(!['pre','in','post'].includes(state)||typeof completed!=='boolean'||
       typeof name!=='string'||name.length>80)return fail('invalid_status');
    if(!score(away.score)||!score(home.score)||
       (away.winner!=null&&typeof away.winner!=='boolean')||
       (home.winner!=null&&typeof home.winner!=='boolean'))return fail('invalid_score');
    if(completed&&(state!=='post'||!/FINAL/i.test(name)||
      away.score==null||home.score==null))return fail('unverified_final');
    const as=away.score==null?null:Number(away.score),hs=home.score==null?null:Number(home.score);
    if(completed&&((away.winner===true&&as<=hs)||(home.winner===true&&hs<=as)||
      (away.winner===true&&home.winner===true)))return fail('contradictory_winner');
    const ct=c.status?.type;
    if(ct!=null&&(!record(ct)||
      (ct.state!=null&&!['pre','in','post'].includes(ct.state))||
      (ct.completed!=null&&typeof ct.completed!=='boolean')||
      (ct.name!=null&&typeof ct.name!=='string')))return fail('invalid_competition_status');
    if(completed&&ct&&(ct.completed===false||
      (ct.state!=null&&ct.state!=='post')||
      (ct.name!=null&&!/FINAL/i.test(ct.name))))return fail('contradictory_competition_final');
    const member=p=>({homeAway:p.homeAway,team:{abbreviation:code(p.team.abbreviation)},
      score:p.score??null,...(p.winner==null?{}:{winner:p.winner})});
    const status={state,completed,name};
    const competition={competitors:[member(away),member(home)]};
    if(ct)competition.status={type:Object.fromEntries(
      ['state','completed','name'].filter(k=>ct[k]!=null).map(k=>[k,ct[k]]))};
    events.push({id:e.id,season:{year:season,type:2},week:{number:week},
      status:{type:status},competitions:[competition]});
  }
  if(matched.size!==schedule.size)return fail('unmatched_schedule_games');
  return {ok:true,reason:null,feed:{season,week,
    source:'espn_scoreboard_unofficial',fetched_at:new Date(at).toISOString(),events}};
}
