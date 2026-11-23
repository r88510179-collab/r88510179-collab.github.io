// Season standings, recounted independently. Thousands of random seasons in the database's snapshot shape are
// given to the code the pages run (seasonStandingsFromSnapshot) and to a second, deliberately naive count written
// here without any of that code's helpers. They must agree on every entry, every total, every place and every
// week's state: before a correction, and again after a week's finals are replaced by a later revision.
//
// The seasons come from a fixed seed, so a failure reproduces exactly. This checks arithmetic and rules. Who may
// read a season is the database's job (tests/fixtures/pool-season-standings-db-fixture.sql).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {seasonStandingsFromSnapshot} from '../season-standings-core.js';
import {recount} from './season-recount.mjs';

const POOL='b0000000-0000-4000-8000-0000000000aa',SEASON=2026;
const TEAMS=['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC',
  'LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];
const SOURCES=['participant','commissioner_import','commissioner_manual'];

function generator(seed){
  let a=seed|0;
  const rand=()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296};
  const int=(lo,hi)=>lo+Math.floor(rand()*(hi-lo+1));
  const shuffle=list=>{const x=[...list];for(let i=x.length-1;i>0;i--){const j=int(0,i);[x[i],x[j]]=[x[j],x[i]]}return x};
  return {rand,int,shuffle,chance:p=>rand()<p,pick:list=>list[int(0,list.length-1)]};
}

const finals=(g,games)=>Object.fromEntries(games.map(game=>{
  const away=g.int(0,45);
  return [game.id,{status:'final',away_score:away,home_score:g.chance(0.1)?away:g.int(0,45)}];
}));

// One random season exactly as pool_platform_season_standings_snapshot returns it. The generator knows nothing
// about grading: every entry, whatever became of it, either skips a week or submits a structurally valid pick.
function randomSeason(g,kind,rules){
  const entryCount=g.int(2,7),weekCount=g.int(1,18),firstWeek=g.int(1,19-weekCount);
  const codes=g.shuffle(Array.from({length:entryCount},(_,i)=>'E'+String(i+1).padStart(2,'0')));
  const entries=codes.map((code,i)=>({entry_id:`entry-${g.int(100,999)}-${i}`,entry_code:code,
    display_name:`Entry ${code}`,entry_status:'active'}));
  const usedTeams=new Map(entries.map(e=>[e.entry_id,new Set()]));
  const weeks=[];
  for(let n=0;n<weekCount;n++){
    const week=firstWeek+n,teams=g.shuffle(TEAMS).slice(0,2*g.int(2,8));
    const games=Array.from({length:teams.length/2},(_,i)=>({id:`w${week}g${i+1}`,away:{key:teams[2*i]},home:{key:teams[2*i+1]},
      kickoff:'2026-09-13T17:00:00.000Z'}));
    const submissions=[];
    for(const e of g.shuffle(entries)){
      if(g.chance(0.12))continue;
      const base={entry_id:e.entry_id,source:g.pick(SOURCES),status:g.pick(['submitted','locked'])};
      if(kind==='pickem'){
        submissions.push({...base,payload:{picks:Object.fromEntries(games.map(game=>[game.id,g.pick(['away','home'])]))}});
        continue;
      }
      const free=teams.filter(t=>!usedTeams.get(e.entry_id).has(t));
      if(!free.length)continue;
      const team=g.pick(free);
      usedTeams.get(e.entry_id).add(team);
      submissions.push({...base,payload:{team}});
    }
    weeks.push({week,week_id:`week-${week}`,deadline_at:'2026-09-10T00:00:00Z',visibility:'after_deadline',games,
      result:{revision:g.int(1,3),results:finals(g,games)},submissions});
  }
  // Sometimes the season is interrupted: a week whose finals are not recorded yet, or a week still before its
  // deadline. Weeks after it keep their finals, which must not be counted.
  if(g.chance(0.35)){
    const at=g.int(0,weekCount-1);
    if(g.chance(0.5))weeks[at]={...weeks[at],result:null};
    else weeks[at]={week:weeks[at].week,week_id:weeks[at].week_id,deadline_at:'2099-01-01T00:00:00Z',visibility:'sealed',
      games:null,result:null,submissions:null};
  }
  return {pool_id:POOL,season:SEASON,pool_type:kind,rules,entries,weeks,status:'commissioner_attested_not_official'};
}

const page=snapshot=>seasonStandingsFromSnapshot(snapshot,{poolId:POOL,season:SEASON});

// Compares the pages' code with the recount on `count` seasons, then corrects one counted week of each season
// (a later revision with different finals) and compares again. Returns what happened, so that a run which
// exercised nothing cannot pass.
function compare({kind,rules,seed,count}){
  const g=generator(seed);
  const seen={seasons:0,weeksCounted:0,interrupted:0,corrections:0,correctionChangedStandings:0,
    broughtBack:0,putOutEarlier:0,ties:0,sharedPlaces:0,ignoredLaterPicks:0,outForNoPick:0};
  for(let n=0;n<count;n++){
    const snapshot=randomSeason(g,kind,rules),frozen=JSON.stringify(snapshot);
    const shown=page(snapshot),expected=recount(snapshot);
    assert.deepEqual(shown,expected,`season ${n} of seed ${seed}`);
    assert.deepEqual(page(snapshot),shown,'the same input gives the same standings');
    assert.equal(JSON.stringify(snapshot),frozen,'the input is never modified');
    seen.seasons++;seen.weeksCounted+=shown.countedWeeks;
    if(shown.countedWeeks<snapshot.weeks.length)seen.interrupted++;
    if(shown.rows.some(r=>r.elimination_reason==='no_pick'))seen.outForNoPick++;
    if(kind==='pickem'){
      if(shown.rows.some(r=>r.ties_both_lose>0))seen.ties++;
      if(shown.countedWeeks&&new Set(shown.rows.map(r=>r.rank)).size<shown.rows.length)seen.sharedPlaces++;
    }else{
      if(shown.rows.some(r=>r.elimination_reason==='tie'))seen.ties++;
      if(shown.rows.some(r=>r.ignored_later_submissions>0))seen.ignoredLaterPicks++;
    }
    if(!shown.countedWeeks)continue;
    // A correction: one counted week gets a later revision. Nothing else about the season changes.
    const at=g.int(0,shown.countedWeeks-1),corrected=structuredClone(snapshot);
    corrected.weeks[at].result={revision:snapshot.weeks[at].result.revision+1,results:finals(g,snapshot.weeks[at].games)};
    const after=page(corrected);
    assert.deepEqual(after,recount(corrected),`season ${n} of seed ${seed}, after correcting week ${corrected.weeks[at].week}`);
    assert.equal(after.weeks[at].revision,snapshot.weeks[at].result.revision+1,'the corrected week reports its latest revision');
    assert.equal(JSON.stringify(snapshot),frozen,'the season before the correction is untouched');
    seen.corrections++;
    if(JSON.stringify(after.rows)!==JSON.stringify(shown.rows))seen.correctionChangedStandings++;
    if(kind==='survivor'){
      const before=new Map(shown.rows.map(r=>[r.entry_id,r]));
      for(const row of after.rows){
        const was=before.get(row.entry_id),wasOut=was.eliminated_week??Infinity,isOut=row.eliminated_week??Infinity;
        if(isOut>wasOut)seen.broughtBack++;
        if(isOut<wasOut)seen.putOutEarlier++;
      }
    }
  }
  return seen;
}

test('Pick’em: 4,000 random seasons agree with an independent recount, before and after a correction',t=>{
  const seen=compare({kind:'pickem',rules:{tiesBothLose:true,pointsPerCorrectPick:1},seed:20261112,count:4000});
  t.diagnostic(JSON.stringify(seen));
  assert.equal(seen.seasons,4000);
  for(const key of ['weeksCounted','interrupted','corrections','correctionChangedStandings','ties','sharedPlaces'])
    assert.ok(seen[key]>=200,`${key} was exercised only ${seen[key]} times`);
});

test('Survivor with the no-pick ruling: 4,000 random seasons agree with an independent recount, and a correction brings entries back or puts them out earlier',t=>{
  const seen=compare({kind:'survivor',rules:{tiesEliminate:true,repeatTeamsAllowed:false,missingSurvivorPick:'eliminate'},
    seed:20261113,count:4000});
  t.diagnostic(JSON.stringify(seen));
  assert.equal(seen.seasons,4000);
  for(const key of ['weeksCounted','interrupted','corrections','correctionChangedStandings','ties','ignoredLaterPicks','broughtBack','putOutEarlier','outForNoPick'])
    assert.ok(seen[key]>=200,`${key} was exercised only ${seen[key]} times`);
});

test('Survivor in a pool that states no rule for a missing pick: 4,000 random seasons agree with the recount, and the default is the same loss',t=>{
  const rules={tiesEliminate:true,repeatTeamsAllowed:false};
  const seen=compare({kind:'survivor',rules,seed:20261114,count:4000});
  t.diagnostic(JSON.stringify(seen));
  assert.equal(seen.seasons,4000);
  for(const key of ['weeksCounted','interrupted','corrections','correctionChangedStandings','outForNoPick','broughtBack','putOutEarlier'])
    assert.ok(seen[key]>=200,`${key} was exercised only ${seen[key]} times`);
  // The same seasons under the same rule stated by the pool: identical in everything but whose rule it is.
  const g=generator(20261114);
  for(let n=0;n<500;n++){
    const snapshot=randomSeason(g,'survivor',rules);
    const byDefault=page(snapshot),stated=page({...snapshot,rules:{...rules,missingSurvivorPick:'eliminate'}});
    assert.deepEqual({...byDefault,noPickRule:null},{...stated,noPickRule:null},`season ${n}`);
    assert.deepEqual([byDefault.noPickRule.statedBy,stated.noPickRule.statedBy],['default','pool']);
    // And a pool that states another rule is never graded under the default.
    assert.deepEqual([page({...snapshot,rules:{...rules,missingSurvivorPick:'advance'}}).reason],['unsupported_pool_rules']);
  }
});
