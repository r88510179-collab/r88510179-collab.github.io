// Expanded Pool Center: pure read-only standings projections. Not an official result.
// Authoritative pool/entry visibility is enforced by the database snapshot RPC.
// NFL result facts must first pass game-day-core's season/week/matchup validation.
// No browser scoring may alter a submitted pick or declare an official winner.
import {normalizeGames} from './participant-core.js';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const display=x=>typeof x==='string'&&x.length>0&&x.length<=120;
const score=x=>Number.isSafeInteger(x)&&x>=0&&x<=200;
const statuses=new Set(['final','live','upcoming','halted']);
const side=new Set(['away','home']);

// The final scores a commissioner attested for one week (pool_platform_week_result_snapshot), as the score facts
// the projection below reads. Null unless the result names every scheduled game and no other, each as a final with
// two valid scores: a partial or malformed record is never graded.
export function attestedScoreFacts(config,result){
  const games=normalizeGames(config);
  if(!object(result)||result.status!=='commissioner_attested_not_official'
    ||!Number.isInteger(result.revision)||result.revision<1||!object(result.results)
    ||games.length<1||Object.keys(result.results).length!==games.length)return null;
  const rows=[];
  for(const g of games){
    const r=Object.hasOwn(result.results,g.id)?result.results[g.id]:null;
    if(!object(r)||r.status!=='final'||!score(r.away_score)||!score(r.home_score))return null;
    rows.push({id:g.id,status:'final',awayScore:r.away_score,homeScore:r.home_score});
  }
  return {rows,revision:result.revision};
}

export function projectPoolStandings({snapshot,config,scoreFacts,poolId,season,week}={}){
  const fail=reason=>({ok:false,reason,rows:[],kind:null,completed:0,total:0,unofficial:true});
  if(!object(snapshot)||snapshot.pool_id!==poolId||snapshot.season!==season
    ||snapshot.week!==week||!['pickem','survivor'].includes(snapshot.pool_type))
    return fail('pool_context_mismatch');
  if(snapshot.visibility==='sealed')return {ok:true,reason:'deadline_not_passed',rows:[],
    kind:snapshot.pool_type,completed:0,total:0,unofficial:true};
  if(snapshot.visibility!=='after_deadline'||!Array.isArray(snapshot.entries)
    ||snapshot.entries.length>512)return fail('invalid_pool_snapshot');

  const games=normalizeGames(config),byGame=new Map(),seenTeams=new Set();
  if(games.length<1||games.length>16)return fail('invalid_games');
  for(const g of games){
    if(!id(g.id)||byGame.has(g.id)||!id(g.away?.key)||!id(g.home?.key)
      ||g.away.key===g.home.key||seenTeams.has(g.away.key)||seenTeams.has(g.home.key))
      return fail('duplicate_or_invalid_game_identity');
    byGame.set(g.id,g);seenTeams.add(g.away.key);seenTeams.add(g.home.key);
  }
  const seenEntries=new Set(),raw=[];
  for(const e of snapshot.entries){
    if(!id(e?.entry_id)||seenEntries.has(e.entry_id)
      ||!display(e.entry_code)||!display(e.display_name)
      ||!['active','eliminated'].includes(e.entry_status))
      return fail('invalid_or_duplicate_entry');
    seenEntries.add(e.entry_id);
    const sub=e.submission;
    if(sub!==null&&sub!==undefined&&(!object(sub)
      ||!['participant','commissioner_manual','commissioner_import'].includes(sub.source)
      ||!['submitted','locked'].includes(sub.status)||!object(sub.payload)))
      return fail('invalid_submission');
    raw.push({...e,submission:sub||null});
  }
  const facts=new Map();
  if(scoreFacts!==null&&scoreFacts!==undefined){
    if(!object(scoreFacts)||!Array.isArray(scoreFacts.rows)||scoreFacts.rows.length!==games.length)
      return fail('score_context_mismatch');
    for(const r of scoreFacts.rows){
      if(!id(r?.id)||!byGame.has(r.id)||facts.has(r.id)||!statuses.has(r.status))
        return fail('score_game_identity_mismatch');
      if(['final','live'].includes(r.status)&&(!score(r.awayScore)||!score(r.homeScore)))
        return fail('invalid_score');
      if(!['final','live'].includes(r.status)&&(r.awayScore!==null||r.homeScore!==null))
        return fail('unstarted_game_has_score');
      facts.set(r.id,r);
    }
  }
  const completed=[...facts.values()].filter(g=>g.status==='final').length;
  const hasScores=facts.size===games.length;
  const noScore=()=>({ok:true,reason:'scores_unavailable',kind:snapshot.pool_type,completed:0,
    total:games.length,unofficial:true,
    rows:raw.map(e=>({entry_id:e.entry_id,name:e.display_name,code:e.entry_code,
      submission:e.submission?'submitted':'missing',rank:null,label:'Waiting for NFL scores'}))});
  if(!hasScores)return noScore();

  if(snapshot.pool_type==='pickem'){
    const rows=[];
    for(const entry of raw){
      const s=entry.submission,picks=s?.payload?.picks;
      if(!s){
        rows.push({entry_id:entry.entry_id,name:entry.display_name,code:entry.entry_code,
          submission:'missing',rank:null,confirmed:0,provisional:0,pending:games.length,
          losses:0,tiedGames:0,projected:0,label:'Not submitted'});continue;
      }
      if(!object(picks)||Object.keys(picks).length!==games.length
        ||games.some(g=>!side.has(picks[g.id]))
        ||Object.keys(picks).some(k=>!byGame.has(k)))
        return fail('invalid_picks');
      let confirmed=0,provisional=0,pending=0,losses=0,tiedGames=0;
      for(const g of games){
        const f=facts.get(g.id);
        if(f.status!=='final'&&f.status!=='live'){pending++;continue}
        if(f.awayScore===f.homeScore){
          if(f.status==='final'){losses++;tiedGames++}
          else pending++;
          continue;
        }
        const leader=f.awayScore>f.homeScore?'away':'home';
        if(f.status==='final'){
          if(picks[g.id]===leader)confirmed++;else losses++;
        }else if(picks[g.id]===leader)provisional++;
      }
      rows.push({entry_id:entry.entry_id,name:entry.display_name,code:entry.entry_code,
        submission:'submitted',rank:null,confirmed,provisional,pending,losses,tiedGames,
        projected:confirmed+provisional,label:'Unofficial projection'});
    }
    rows.sort((a,b)=>(b.submission==='submitted')-(a.submission==='submitted')
      ||b.projected-a.projected||a.code.localeCompare(b.code));
    let rank=0,prior=null;
    rows.forEach((row,i)=>{
      if(row.submission==='missing')return;
      if(row.projected!==prior){rank=i+1;prior=row.projected}
      row.rank=rank;
    });
    return {ok:true,reason:'unofficial_projection',rows,kind:'pickem',
      completed,total:games.length,unofficial:true};
  }

  const rows=[];
  for(const entry of raw){
    const sub=entry.submission,team=sub?.payload?.team;
    if(!sub){
      rows.push({entry_id:entry.entry_id,name:entry.display_name,code:entry.entry_code,
        submission:'missing',rank:null,label:'No Survivor pick'});continue;
    }
    if(!id(team))return fail('invalid_survivor_team');
    const game=games.find(g=>g.away.key===team||g.home.key===team);
    if(!game)return fail('team_not_scheduled');
    const f=facts.get(game.id);
    let label='Pending';
    if(entry.entry_status==='eliminated')label='Previously eliminated';
    else if(f.status==='final'){
      label=f.awayScore===f.homeScore?'Eliminated (tie)':
        (f.awayScore>f.homeScore?game.away.key:game.home.key)===team?'Advanced':'Eliminated';
    }else if(f.status==='live'){
      const own=game.away.key===team?f.awayScore:f.homeScore;
      const other=game.away.key===team?f.homeScore:f.awayScore;
      label=own>other?'Leading — provisional':own<other?'Trailing — not final':'Tied — not final';
    }else if(f.status==='halted')label='Game delayed — awaiting result';
    rows.push({entry_id:entry.entry_id,name:entry.display_name,code:entry.entry_code,
      submission:'submitted',team,rank:null,label});
  }
  rows.sort((a,b)=>a.code.localeCompare(b.code));
  return {ok:true,reason:'unofficial_projection',rows,kind:'survivor',
    completed,total:games.length,unofficial:true};
}
