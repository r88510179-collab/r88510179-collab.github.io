// Deterministic, offline replay of independently verified weekly NFL results.
// Reuses Phase 9's validated final-only Pick'em/Survivor grading. Does NOT
// authenticate users, query a database, publish a result, or grade live scores.
// Callers must supply a backend-authorized single-pool submission set and an
// append-only audit/revision history established by a separate secure publisher.
import {createHash} from 'node:crypto';
import {validateFinalWeek} from '../scripts/results-preview.mjs';
import {gradeSeason} from '../season-standings-core.js';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const entryId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const digest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/i.test(x);
const fail=code=>({ok:false,reason:code,unofficial:true,rows:[],revisions:[]});
const validDate=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&
  new Date(x).toISOString()===x;
const SHA=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

// A revision is an already-persisted, authenticated, externally verified
// statement, NOT a way for a caller to self-certify an NFL score. Revisions
// must form a gap-free append-only chain. An old revision is never overwritten.
function verifiedRevisionChain(week){
  if(!Array.isArray(week?.revisions)||!week.revisions.length||week.revisions.length>128)
    return {ok:false,reason:'missing_result_revision'};
  let previous=null;
  for(let i=0;i<week.revisions.length;i++){
    const rev=week.revisions[i];
    if(!object(rev)||rev.revision!==i+1||
       !digest(rev.source_sha256)||!validDate(rev.verified_at)||
       !entryId(rev.verified_by)||!object(rev.results))
      return {ok:false,reason:'invalid_result_revision'};
    if(i>0&&(!object(previous)||!rev.reason||
       typeof rev.reason!=='string'||rev.reason.trim().length<8||
       rev.reason.length>240||rev.verified_at<previous.verified_at))
      return {ok:false,reason:'invalid_correction_audit'};
    if(!validateFinalWeek({games:week.games,results:rev.results}).ok)
      return {ok:false,reason:'unverified_final_result'};
    previous=rev;
  }
  return {ok:true,revision:previous};
}

// Each week must have the same explicit, server-authorized pool/season identity.
// There is no implicit week fill-in. Missing weeks or missing Survivor picks
// cannot silently award advancement. A correction recomputes from week one.
export function replayVerifiedSeason({
  pool_id,season,pool_type,entries,weeks,start_week,rules={}
}={}){
  if(!uuid(pool_id)||!Number.isInteger(season)||season<2020||season>2100||
     !['pickem','survivor'].includes(pool_type)||
     !Array.isArray(entries)||entries.length<1||entries.length>512||
     !Array.isArray(weeks)||weeks.length<1||weeks.length>18||
     !Number.isInteger(start_week)||start_week<1||start_week>18||
     !object(rules))return fail('invalid_pool_replay_context');
  if(pool_type==='pickem'&&(
    (rules.tiesBothLose!==undefined&&rules.tiesBothLose!==true)||
    (rules.pointsPerCorrectPick!==undefined&&rules.pointsPerCorrectPick!==1)))
    return fail('unsupported_pickem_rules');
  const unique=new Set();
  for(const entry of entries){
    if(!entryId(entry?.entry_id)||unique.has(entry.entry_id))
      return fail('duplicate_or_invalid_pool_entry');
    unique.add(entry.entry_id);
  }
  const chronological=[...weeks].sort((a,b)=>(a?.week??0)-(b?.week??0));
  const checked=[];
  for(let i=0;i<chronological.length;i++){
    const w=chronological[i];
    if(!object(w)||w.pool_id!==pool_id||w.season!==season||
       w.week!==start_week+i||w.week>18||
       !Array.isArray(w.games)||!Array.isArray(w.submissions))
      return fail('wrong_pool_or_noncontiguous_final_weeks');
    const chain=verifiedRevisionChain(w);
    if(!chain.ok)return fail(chain.reason);
    const ids=new Set();
    for(const sub of w.submissions){
      if(!entryId(sub?.entry_id)||!unique.has(sub.entry_id)||ids.has(sub.entry_id))
        return fail('foreign_or_duplicate_submission');
      ids.add(sub.entry_id);
    }
    checked.push({week:w,revision:chain.revision,submissions:w.submissions});
  }
  // The grading itself is shared with the pages (../season-standings-core.js): one implementation, so what a
  // commissioner or participant sees and what this audited replay computes cannot drift apart.
  const graded=gradeSeason({pool_type,entryIds:[...unique],rules,
    weeks:checked.map(({week,revision,submissions})=>({week:week.week,games:week.games,
      results:revision.results,submissions}))});
  if(!graded.ok)return fail(graded.reason);
  const rows=graded.rows;
  const revisions=checked.map(({week,revision})=>({week:week.week,revision:revision.revision,
    source_sha256:revision.source_sha256}));
  const manifest={pool_id,season,pool_type,start_week,
    through_week:chronological.at(-1).week,revisions,rows};
  return {ok:true,reason:'offline_verified_replay_only',unofficial:true,
    ...manifest,fingerprint:SHA(manifest)};
}
