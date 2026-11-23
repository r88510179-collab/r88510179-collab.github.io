// Expanded Pool Center: season standings recomputed from commissioner-attested final scores.
// Pure and deterministic: no DOM, no network, no storage, no clock, no credentials. It never changes a pick or a
// stored result, and what it produces is NOT an official result.
//
// History stays immutable and corrections are replayed, never patched: nothing derived is stored anywhere, so
// every view is a fresh replay from the season's first week over the LATEST revision of each week. A correction to
// an early week therefore changes every later week it affects (a Survivor entry that turns out to have lost in
// week 2 is out from week 2, whatever it picked afterwards), and the earlier revisions remain in the database.
import {previewPickemStandings,previewSurvivorOutcomes} from './results-grading.js';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const display=x=>typeof x==='string'&&x.length>0&&x.length<=120;
export const LAST_REGULAR_SEASON_WEEK=18;

// What a week without a pick means for a Survivor entry that is still in. The owner's ruling of 2026-11-13: it is a
// loss, and the entry is out from that week. A pool overrides this only with an explicit rule of its own,
// rules.missingSurvivorPick. The one rule this grading implements is 'eliminate': a pool that states any other gets
// no standings at all, never standings under a rule it does not have and never a week survived without a pick.
export const DEFAULT_MISSING_SURVIVOR_PICK='eliminate';
export const missingSurvivorPickRule=rules=>rules?.missingSurvivorPick===undefined?DEFAULT_MISSING_SURVIVOR_PICK:rules.missingSurvivorPick;

// The grading loop of the season replay. One implementation for the offline replay
// (server/season-replay-core.mjs), which first verifies each week's whole revision chain, and for the pages.
// `weeks` are consecutive weeks, earliest first: {week, games, results, submissions}. Fails closed with a reason and
// no rows; it never returns standings for part of what it was given.
export function gradeSeason({pool_type,entryIds,weeks,rules={}}={}){
  const fail=reason=>({ok:false,reason,rows:[]});
  if(!['pickem','survivor'].includes(pool_type)||!Array.isArray(weeks)||!object(rules))return fail('invalid_season_grading_input');
  const orderedIds=[...(entryIds??[])].sort();
  if(orderedIds.some(e=>!id(e))||new Set(orderedIds).size!==orderedIds.length)return fail('invalid_season_grading_input');
  if(pool_type==='survivor'&&missingSurvivorPickRule(rules)!=='eliminate')return fail('unsupported_missing_survivor_pick_rule');
  const totals=new Map(orderedIds.map(entry=>[entry,pool_type==='pickem'
    ?{entry_id:entry,correct:0,incorrect:0,ties_both_lose:0,
      submitted_weeks:0,missing_weeks:0,rank:null}
    :{entry_id:entry,status:'active',used_teams:[],advanced_weeks:0,
      eliminated_week:null,elimination_reason:null,ignored_later_submissions:0}]));
  for(const week of weeks){
    const submissions=week.submissions;
    const ids=new Set(submissions.map(s=>s.entry_id));
    const byId=new Map(submissions.map(s=>[s.entry_id,s]));
    if(pool_type==='pickem'){
      const scored=previewPickemStandings({games:week.games,results:week.results,submissions});
      if(!scored.ok)return fail('invalid_pickem_week:'+scored.errors[0]);
      for(const row of scored.rows){
        const total=totals.get(row.entry_id);
        total.correct+=row.correct;
        total.incorrect+=row.incorrect;
        total.ties_both_lose+=row.tiesBothLose;
        total.submitted_weeks++;
      }
      for(const entry of orderedIds)if(!ids.has(entry))totals.get(entry).missing_weeks++;
      continue;
    }
    // Survivor. An entry still in that has no pick this week is out (see DEFAULT_MISSING_SURVIVOR_PICK): it is
    // never carried forward as if it had survived.
    const active=orderedIds.filter(entry=>totals.get(entry).status==='active');
    // A correction to an earlier week can retroactively eliminate an entry that went on to submit valid picks.
    // Those later submissions stay in the database; they neither resurrect the entry nor fail the replay.
    for(const entry of orderedIds){
      if(totals.get(entry).status==='eliminated'&&ids.has(entry))
        totals.get(entry).ignored_later_submissions++;
    }
    const missing=active.filter(entry=>!ids.has(entry));
    const current=active.filter(entry=>ids.has(entry)).map(entry=>byId.get(entry));
    const history=Object.fromEntries(current.map(s=>[s.entry_id,totals.get(s.entry_id).used_teams]));
    const graded=previewSurvivorOutcomes({games:week.games,results:week.results,
      submissions:current,priorTeamsByEntry:history});
    if(!graded.ok)return fail('invalid_survivor_week:'+graded.errors[0]);
    for(const row of graded.rows){
      const e=totals.get(row.entry_id);
      e.used_teams=[...e.used_teams,row.team];
      if(row.outcome==='advanced')e.advanced_weeks++;
      else{
        e.status='eliminated';
        e.eliminated_week=week.week;
        e.elimination_reason=row.tie_elimination?'tie':'loss';
      }
    }
    for(const entry of missing){
      const e=totals.get(entry);
      e.status='eliminated';
      e.eliminated_week=week.week;
      e.elimination_reason='no_pick';
    }
  }
  const rows=[...totals.values()];
  if(pool_type==='pickem'){
    rows.sort((a,b)=>b.correct-a.correct||a.entry_id.localeCompare(b.entry_id));
    let previous=null,rank=0;
    rows.forEach((r,i)=>{if(previous!==r.correct){rank=i+1;previous=r.correct}r.rank=rank});
  }else rows.sort((a,b)=>(a.status==='active'?0:1)-(b.status==='active'?0:1)
    ||b.advanced_weeks-a.advanced_weeks||a.entry_id.localeCompare(b.entry_id));
  return {ok:true,reason:null,rows};
}

// The grading above implements exactly these rules. A pool configured otherwise gets no standings rather than
// standings computed under rules it does not have.
function rulesSupported(pool_type,rules){
  if(pool_type==='pickem')return (rules.tiesBothLose===undefined||rules.tiesBothLose===true)
    &&(rules.pointsPerCorrectPick===undefined||rules.pointsPerCorrectPick===1);
  return (rules.tiesEliminate===undefined||rules.tiesEliminate===true)
    &&(rules.repeatTeamsAllowed===undefined||rules.repeatTeamsAllowed===false)
    &&(rules.missingSurvivorPick===undefined||rules.missingSurvivorPick==='eliminate');
}

// Turns the database snapshot of one pool season (pool_platform_season_standings_snapshot) into what the page
// shows. Weeks are counted in order from the season's first week and counting stops at the first week that cannot
// be counted: not yet past its deadline, finals not recorded, or not gradable under the pool's rules. Later weeks
// are never counted across such a gap. `stopped` says why when the reason is anything but "the next week has not
// been played yet". For a Survivor pool `noPickRule` says what a week without a pick means and whether the pool
// states that itself or the default applies.
export function seasonStandingsFromSnapshot(snapshot,{poolId,season}={}){
  const fail=reason=>({ok:false,reason,kind:null,rows:[],weeks:[],throughWeek:null,countedWeeks:0,stopped:null,noPickRule:null,unofficial:true});
  if(!object(snapshot)||snapshot.pool_id!==poolId||snapshot.season!==season
    ||!['pickem','survivor'].includes(snapshot.pool_type)||!object(snapshot.rules)
    ||!Array.isArray(snapshot.entries)||snapshot.entries.length>512
    ||!Array.isArray(snapshot.weeks)||snapshot.weeks.length>25)return fail('invalid_season_snapshot');
  const kind=snapshot.pool_type,rules=snapshot.rules;
  if(!rulesSupported(kind,rules))return fail('unsupported_pool_rules');
  const entries=new Map();
  for(const e of snapshot.entries){
    if(!id(e?.entry_id)||entries.has(e.entry_id)||!display(e.entry_code)||!display(e.display_name)
      ||!['active','eliminated'].includes(e.entry_status))return fail('invalid_season_snapshot');
    entries.set(e.entry_id,e);
  }
  let previousWeek=0;
  for(const w of snapshot.weeks){
    if(!object(w)||!Number.isInteger(w.week)||w.week<=previousWeek||w.week>25
      ||!['sealed','after_deadline'].includes(w.visibility))return fail('invalid_season_snapshot');
    previousWeek=w.week;
    if(w.visibility==='sealed'){
      // Nothing about a week before its deadline may be used, whatever the snapshot carries.
      if(w.result!=null||w.submissions!=null)return fail('invalid_season_snapshot');
      continue;
    }
    if(!Array.isArray(w.games)||!Array.isArray(w.submissions)
      ||!(w.result===null||(object(w.result)&&Number.isInteger(w.result.revision)&&w.result.revision>=1&&object(w.result.results))))
      return fail('invalid_season_snapshot');
    const submitted=new Set();
    for(const s of w.submissions){
      if(!object(s)||!entries.has(s.entry_id)||submitted.has(s.entry_id))return fail('invalid_season_snapshot');
      submitted.add(s.entry_id);
    }
  }

  const entryIds=[...entries.keys()];
  const weeks=snapshot.weeks.map(w=>({week:w.week,state:'not_counted',revision:w.result?.revision??null}));
  let graded=gradeSeason({pool_type:kind,entryIds,weeks:[],rules}),counted=[],stopped=null;
  for(let i=0;i<snapshot.weeks.length;i++){
    const w=snapshot.weeks[i],expected=snapshot.weeks[0].week+i;
    if(w.week!==expected){stopped={week:expected,reason:'week_missing'};break}
    if(w.week>LAST_REGULAR_SEASON_WEEK){stopped={week:w.week,reason:'regular_season_only'};break}
    if(w.visibility==='sealed'){weeks[i].state='sealed';break}
    if(w.result===null){weeks[i].state='awaiting_finals';stopped={week:w.week,reason:'awaiting_finals'};break}
    const next=gradeSeason({pool_type:kind,entryIds,rules,
      weeks:[...counted,{week:w.week,games:w.games,results:w.result.results,submissions:w.submissions}]});
    if(!next.ok){weeks[i].state='not_gradable';stopped={week:w.week,reason:next.reason};break}
    counted=[...counted,{week:w.week,games:w.games,results:w.result.results,submissions:w.submissions}];
    graded=next;weeks[i].state='counted';
  }
  // Weeks after the stopping point keep 'not_counted', except that a week still before its deadline says so.
  snapshot.weeks.forEach((w,i)=>{if(weeks[i].state==='not_counted'&&w.visibility==='sealed')weeks[i].state='sealed'});
  const rows=graded.rows.map(row=>{
    const e=entries.get(row.entry_id);
    return {...row,name:e.display_name,code:e.entry_code,...(kind==='pickem'&&!counted.length?{rank:null}:{})};
  });
  if(kind==='pickem')rows.sort((a,b)=>b.correct-a.correct||a.code.localeCompare(b.code)||a.entry_id.localeCompare(b.entry_id));
  else rows.sort((a,b)=>(a.status==='active'?0:1)-(b.status==='active'?0:1)||b.advanced_weeks-a.advanced_weeks
    ||a.code.localeCompare(b.code)||a.entry_id.localeCompare(b.entry_id));
  return {ok:true,reason:null,kind,rows,weeks,throughWeek:counted.length?counted.at(-1).week:null,
    countedWeeks:counted.length,stopped,
    noPickRule:kind==='survivor'?{outcome:'eliminated',statedBy:rules.missingSurvivorPick===undefined?'default':'pool'}:null,
    unofficial:true};
}
