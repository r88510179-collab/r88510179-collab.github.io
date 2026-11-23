// Season standings from commissioner-attested finals: the pure core the pages run, checked without a browser or a
// database. The database side (who may read what, and when) is tests/fixtures/pool-season-standings-db-fixture.sql;
// the pages themselves are tests/e2e/final-results.e2e.test.mjs.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {gradeSeason,seasonStandingsFromSnapshot} from '../season-standings-core.js';
import {attestedScoreFacts,projectPoolStandings} from '../pool-projection.js';
import {replayVerifiedSeason} from '../server/season-replay-core.mjs';

const POOL='b0000000-0000-4000-8000-000000000001';
const final=(away,home)=>({status:'final',away_score:away,home_score:home});
const game=(id,away,home)=>({id,away:{key:away},home:{key:home},kickoff:'2026-09-13T17:00:00.000Z'});
const GAMES={
  1:[game('w1a','ARI','ATL'),game('w1b','BAL','BUF')],
  2:[game('w2a','CAR','CHI'),game('w2b','CIN','CLE')],
  3:[game('w3a','DAL','DEN'),game('w3b','DET','GB')]
};
const entry=(id,code,name,status='active')=>({entry_id:id,entry_code:code,display_name:name,entry_status:status});
const ENTRIES=[entry('e1','A1','Alice'),entry('e2','A2','Bob'),entry('e3','A3','Cy')];
const picks=(entryId,choices)=>({entry_id:entryId,source:'participant',status:'submitted',payload:{picks:choices}});
const team=(entryId,key,source='participant')=>({entry_id:entryId,source,status:'submitted',payload:{team:key}});
const played=(week,result,submissions)=>({week,week_id:`week-${week}`,deadline_at:'2026-09-10T00:00:00Z',visibility:'after_deadline',
  games:GAMES[week],result,submissions});
const sealed=week=>({week,week_id:`week-${week}`,deadline_at:'2099-01-01T00:00:00Z',visibility:'sealed',games:null,result:null,submissions:null});
const rev=(revision,results)=>({revision,results});
const snapshot=(pool_type,weeks,{rules={},entries=ENTRIES}={})=>({pool_id:POOL,season:2026,pool_type,rules,entries,weeks,
  status:'commissioner_attested_not_official'});
const view=(snap,context={poolId:POOL,season:2026})=>seasonStandingsFromSnapshot(snap,context);

const pickemSeason=({week1=rev(1,{w1a:final(21,14),w1b:final(10,17)}),week3=rev(1,{w3a:final(3,30),w3b:final(27,24)})}={})=>snapshot('pickem',[
  played(1,week1,[picks('e1',{w1a:'away',w1b:'home'}),picks('e2',{w1a:'home',w1b:'home'})]),
  played(2,rev(1,{w2a:final(20,20),w2b:final(7,31)}),[picks('e1',{w2a:'away',w2b:'home'}),picks('e2',{w2a:'home',w2b:'away'}),picks('e3',{w2a:'home',w2b:'home'})]),
  played(3,week3,[picks('e1',{w3a:'home',w3b:'home'}),picks('e2',{w3a:'home',w3b:'away'})])
]);

test('Pick’em: totals add up week by week, a tied game counts against both sides, a week without picks is a missing week',()=>{
  const v=view(pickemSeason());
  assert.equal(v.ok,true);
  assert.deepEqual([v.kind,v.throughWeek,v.countedWeeks,v.stopped,v.unofficial],['pickem',3,3,null,true]);
  assert.deepEqual(v.rows.map(r=>[r.rank,r.name,r.code,r.correct,r.incorrect,r.ties_both_lose,r.submitted_weeks,r.missing_weeks]),[
    [1,'Alice','A1',4,2,1,3,0],
    [2,'Bob','A2',3,3,1,3,0],
    [3,'Cy','A3',1,1,1,1,2]]);
  assert.deepEqual(v.weeks,[{week:1,state:'counted',revision:1},{week:2,state:'counted',revision:1},{week:3,state:'counted',revision:1}]);
});

test('a correction is replayed, not patched: the latest revision of an early week changes the season, and the input is never modified',()=>{
  const before=pickemSeason(),after=pickemSeason({week1:rev(2,{w1a:final(14,21),w1b:final(10,17)})});
  const frozen=JSON.stringify(after);
  const v=view(after);
  assert.equal(JSON.stringify(after),frozen,'the snapshot is read, never written');
  assert.deepEqual(view(before).rows.map(r=>[r.rank,r.name,r.correct]),[[1,'Alice',4],[2,'Bob',3],[3,'Cy',1]]);
  assert.deepEqual(v.rows.map(r=>[r.rank,r.name,r.correct]),[[1,'Bob',4],[2,'Alice',3],[3,'Cy',1]]);
  assert.deepEqual(v.weeks[0],{week:1,state:'counted',revision:2});
  assert.deepEqual(view(after),v,'the same record always gives the same standings');
});

test('equal totals share a place, in entry-code order; nothing is ranked before a week is counted',()=>{
  const tied=view(snapshot('pickem',[played(1,rev(1,{w1a:final(21,14),w1b:final(10,17)}),
    [picks('e2',{w1a:'away',w1b:'home'}),picks('e1',{w1a:'away',w1b:'home'})])]));
  assert.deepEqual(tied.rows.map(r=>[r.rank,r.code,r.correct]),[[1,'A1',2],[1,'A2',2],[3,'A3',0]]);
  const none=view(snapshot('pickem',[played(1,null,[picks('e1',{w1a:'away',w1b:'home'})]),sealed(2)]));
  assert.deepEqual([none.ok,none.countedWeeks,none.throughWeek],[true,0,null]);
  assert.deepEqual(none.stopped,{week:1,reason:'awaiting_finals'});
  assert.deepEqual(none.rows.map(r=>[r.rank,r.correct]),[[null,0],[null,0],[null,0]]);
});

test('counting stops at the first week that cannot be counted and never resumes across it',()=>{
  const s=pickemSeason();
  // Week 2 has no finals yet although week 3 does: week 3 is shown as recorded but not counted.
  const gap=view(snapshot('pickem',[s.weeks[0],{...s.weeks[1],result:null},s.weeks[2]]));
  assert.deepEqual([gap.throughWeek,gap.countedWeeks],[1,1]);
  assert.deepEqual(gap.stopped,{week:2,reason:'awaiting_finals'});
  assert.deepEqual(gap.weeks.map(w=>w.state),['counted','awaiting_finals','not_counted']);
  assert.equal(gap.weeks[2].revision,1);
  assert.deepEqual(gap.rows.map(r=>[r.name,r.correct]),[['Alice',2],['Bob',1],['Cy',0]]);
  // The next week simply has not been played: that is not a problem to report.
  const upcoming=view(snapshot('pickem',[s.weeks[0],sealed(2),sealed(3)]));
  assert.deepEqual([upcoming.throughWeek,upcoming.stopped],[1,null]);
  assert.deepEqual(upcoming.weeks.map(w=>w.state),['counted','sealed','sealed']);
  // A week number that is not there, and a week beyond the regular season.
  const missing=view(snapshot('pickem',[s.weeks[0],s.weeks[2]]));
  assert.deepEqual([missing.throughWeek,missing.stopped],[1,{week:2,reason:'week_missing'}]);
  const late=view(snapshot('pickem',[{...s.weeks[0],week:18},{...s.weeks[1],week:19}]));
  assert.deepEqual([late.throughWeek,late.stopped],[18,{week:19,reason:'regular_season_only'}]);
  // Stored picks that do not match the schedule stop the count at that week, with the weeks before it intact.
  const broken=view(snapshot('pickem',[s.weeks[0],{...s.weeks[1],submissions:[picks('e1',{w2a:'away'})]},s.weeks[2]]));
  assert.deepEqual([broken.throughWeek,broken.stopped],[1,{week:2,reason:'invalid_pickem_week:invalid_picks:e1'}]);
  assert.deepEqual(broken.weeks.map(w=>w.state),['counted','not_gradable','not_counted']);
});

const survivorSeason=({week1=rev(1,{w1a:final(21,14),w1b:final(10,17)}),rules={},week3Picks=[team('e1','DAL'),team('e2','DEN')]}={})=>snapshot('survivor',[
  played(1,week1,[team('e1','ARI'),team('e2','BUF'),team('e3','ATL')]),
  played(2,rev(1,{w2a:final(20,20),w2b:final(7,31)}),[team('e1','CLE'),team('e2','CAR')]),
  played(3,rev(1,{w3a:final(3,30),w3b:final(27,24)}),week3Picks)
],{rules});

test('Survivor: winners advance, a loss or a tied game eliminates, and an eliminated entry stays out',()=>{
  const v=view(survivorSeason());
  assert.equal(v.ok,true);
  assert.deepEqual(v.rows.map(r=>[r.name,r.status,r.advanced_weeks,r.eliminated_week,r.elimination_reason,r.used_teams]),[
    ['Alice','eliminated',2,3,'loss',['ARI','CLE','DAL']],
    ['Bob','eliminated',1,2,'tie',['BUF','CAR']],
    ['Cy','eliminated',0,1,'loss',['ATL']]]);
  assert.deepEqual([v.throughWeek,v.countedWeeks,v.stopped],[3,3,null]);
  // Bob went out in week 2 on the tie; the pick he still made in week 3 is kept in the record and ignored.
  assert.equal(v.rows.find(r=>r.name==='Bob').ignored_later_submissions,1);
});

test('Survivor: a corrected early result retroactively eliminates an entry, whatever it picked afterwards',()=>{
  const rules={missingSurvivorPick:'eliminate'},corrected=rev(2,{w1a:final(14,21),w1b:final(10,17)});
  const before=view(survivorSeason({rules})),after=view(survivorSeason({rules,week1:corrected}));
  assert.deepEqual(before.rows.map(r=>[r.name,r.eliminated_week,r.elimination_reason]),[['Alice',3,'loss'],['Bob',2,'tie'],['Cy',1,'loss']]);
  // ARI is now the loser of week 1: Alice is out from week 1, and Cy, who had ATL, survived it.
  assert.deepEqual(after.rows.map(r=>[r.name,r.status,r.advanced_weeks,r.eliminated_week,r.elimination_reason]),[
    ['Bob','eliminated',1,2,'tie'],
    ['Cy','eliminated',1,2,'no_pick'],
    ['Alice','eliminated',0,1,'loss']]);
  assert.equal(after.rows.find(r=>r.name==='Alice').ignored_later_submissions,2,'her picks in weeks 2 and 3 stay on record and change nothing');
  assert.deepEqual([after.throughWeek,after.stopped,after.weeks[0]],[3,null,{week:1,state:'counted',revision:2}]);
  // A pool that states no rule for a missing pick gets the same standings: the default is a loss.
  const unstated=view(survivorSeason({week1:corrected}));
  assert.deepEqual(unstated.rows,after.rows);
  assert.deepEqual([unstated.throughWeek,unstated.stopped,unstated.noPickRule],[3,null,{outcome:'eliminated',statedBy:'default'}]);
  assert.deepEqual(after.noPickRule,{outcome:'eliminated',statedBy:'pool'});
});

test('Survivor: a week without a pick is a loss, by default or by the pool’s own rule; a pool stating another rule gets no standings',()=>{
  const lateEntry=[team('e1','ARI'),team('e2','BUF')];
  const base=snapshot('survivor',[played(1,rev(1,{w1a:final(21,14),w1b:final(10,17)}),lateEntry),
    played(2,rev(1,{w2a:final(20,3),w2b:final(7,31)}),[team('e1','CLE'),team('e2','CAR')])]);
  const expected=[['Alice','active',null,null,2],['Bob','active',null,null,2],['Cy','eliminated',1,'no_pick',0]];
  const shape=v=>v.rows.map(r=>[r.name,r.status,r.eliminated_week,r.elimination_reason,r.advanced_weeks]);
  // The pool states nothing: the ruling of 2026-11-13 applies. Cy never picked and is out from week 1.
  const byDefault=view(base);
  assert.deepEqual(shape(byDefault),expected);
  assert.deepEqual([byDefault.ok,byDefault.throughWeek,byDefault.countedWeeks,byDefault.stopped],[true,2,2,null]);
  assert.deepEqual(byDefault.noPickRule,{outcome:'eliminated',statedBy:'default'});
  // The pool states the same rule itself: the same standings, and the card can say whose rule it is.
  const stated=view({...base,rules:{missingSurvivorPick:'eliminate'}});
  assert.deepEqual(shape(stated),expected);
  assert.deepEqual(stated.noPickRule,{outcome:'eliminated',statedBy:'pool'});
  // The pool states a different rule: it is not overridden by the default, and nothing is computed under it.
  for(const other of ['advance','carry_over','',null,false]){
    const refused=view({...base,rules:{missingSurvivorPick:other}});
    assert.deepEqual([refused.ok,refused.reason,refused.rows,refused.noPickRule],[false,'unsupported_pool_rules',[],null],String(other));
    const direct=gradeSeason({pool_type:'survivor',entryIds:ENTRIES.map(e=>e.entry_id),rules:{missingSurvivorPick:other},weeks:[]});
    assert.deepEqual([direct.ok,direct.reason,direct.rows],[false,'unsupported_missing_survivor_pick_rule',[]],String(other));
  }
  // An entry that is out stays out: the week it missed is never counted as survived.
  assert.equal(byDefault.rows.find(r=>r.name==='Cy').used_teams.length,0);
  // Pick’em has no such rule: a week without picks is a week with nothing correct, and nobody is removed.
  assert.equal(view(pickemSeason()).noPickRule,null);
});

test('Survivor: a reused team or a team that did not play is never graded',()=>{
  const reused=view(survivorSeason({week3Picks:[team('e1','ARI'),team('e2','DEN')]}));
  assert.deepEqual([reused.throughWeek,reused.stopped],[2,{week:3,reason:'invalid_survivor_week:invalid_or_reused_survivor_team:e1'}]);
  assert.equal(reused.rows.find(r=>r.name==='Alice').status,'active','Alice is not eliminated by a week that could not be graded');
});

test('rules the grading does not implement give no standings at all',()=>{
  for(const rules of [{tiesBothLose:false},{pointsPerCorrectPick:2}])
    assert.deepEqual([view({...pickemSeason(),rules}).ok,view({...pickemSeason(),rules}).reason],[false,'unsupported_pool_rules']);
  for(const rules of [{tiesEliminate:false},{repeatTeamsAllowed:true},{missingSurvivorPick:'advance'}])
    assert.equal(view(survivorSeason({rules})).reason,'unsupported_pool_rules');
  assert.equal(view({...pickemSeason(),rules:{tiesBothLose:true,pointsPerCorrectPick:1}}).ok,true);
  assert.equal(view(survivorSeason({rules:{tiesEliminate:true,repeatTeamsAllowed:false,missingSurvivorPick:'eliminate'}})).ok,true);
});

test('a snapshot that is not exactly what the database returns for this pool season is refused whole',()=>{
  const s=pickemSeason();
  const refused=(snap,context)=>{const v=view(snap,context);assert.deepEqual([v.ok,v.reason,v.rows,v.weeks],[false,'invalid_season_snapshot',[],[]])};
  refused(s,{poolId:'b0000000-0000-4000-8000-000000000002',season:2026});
  refused(s,{poolId:POOL,season:2025});
  refused({...s,pool_type:'confidence'});
  refused({...s,rules:null});
  refused({...s,entries:[...ENTRIES,entry('e1','A9','Duplicate id')]});
  refused({...s,entries:[entry('e1','A1','Alice','archived')]});
  refused({...s,entries:Array.from({length:513},(_,i)=>entry(`x${i}`,`X${i}`,`Entry ${i}`))});
  refused({...s,weeks:[s.weeks[1],s.weeks[0]]});
  refused({...s,weeks:[{...s.weeks[0],visibility:'public'}]});
  refused({...s,weeks:[{...s.weeks[0],result:{revision:0,results:{}}}]});
  refused({...s,weeks:[{...s.weeks[0],result:{revision:1}}]});
  refused({...s,weeks:[{...s.weeks[0],submissions:[picks('stranger',{w1a:'away',w1b:'home'})]}]});
  refused({...s,weeks:[{...s.weeks[0],submissions:[s.weeks[0].submissions[0],s.weeks[0].submissions[0]]}]});
  // Nothing about a week before its deadline may be used, even if a snapshot carried it.
  refused({...s,weeks:[s.weeks[0],{...sealed(2),submissions:[picks('e1',{w2a:'away',w2b:'home'})]}]});
  refused({...s,weeks:[s.weeks[0],{...sealed(2),result:rev(1,{w2a:final(1,0),w2b:final(1,0)})}]});
  for(const junk of [null,undefined,[],'x',42])refused(junk);
});

test('the pages and the audited offline replay grade with the same engine and agree',()=>{
  const audited=(results,revision=1)=>[{revision:1,source_sha256:'a'.repeat(64),verified_at:'2026-11-01T00:00:00.000Z',verified_by:'commish',results},
    ...(revision>1?[{revision:2,source_sha256:'b'.repeat(64),verified_at:'2026-11-02T00:00:00.000Z',verified_by:'commish',results,reason:'Corrected after review'}]:[])];
  for(const [season,rules] of [[pickemSeason(),{}],[survivorSeason({rules:{missingSurvivorPick:'eliminate'}}),{missingSurvivorPick:'eliminate'}]]){
    const offline=replayVerifiedSeason({pool_id:POOL,season:2026,pool_type:season.pool_type,entries:ENTRIES.map(e=>({entry_id:e.entry_id})),start_week:1,rules,
      weeks:season.weeks.map(w=>({pool_id:POOL,season:2026,week:w.week,games:w.games,submissions:w.submissions,revisions:audited(w.result.results)}))});
    assert.equal(offline.ok,true,offline.reason);
    const shown=view(season);
    const strip=({name,code,...row})=>row;
    assert.deepEqual(shown.rows.map(strip).sort((a,b)=>a.entry_id.localeCompare(b.entry_id)),
      [...offline.rows].sort((a,b)=>a.entry_id.localeCompare(b.entry_id)));
    const direct=gradeSeason({pool_type:season.pool_type,entryIds:ENTRIES.map(e=>e.entry_id),rules,
      weeks:season.weeks.map(w=>({week:w.week,games:w.games,results:w.result.results,submissions:w.submissions}))});
    assert.deepEqual(direct.rows,offline.rows);
  }
  assert.deepEqual(gradeSeason({pool_type:'pickem',entryIds:['e1','e1'],weeks:[]}).ok,false);
  assert.deepEqual(gradeSeason({pool_type:'bracket',entryIds:['e1'],weeks:[]}).ok,false);
});

test('this week’s card reads the attested finals only when they cover exactly the scheduled games',()=>{
  const config={games:GAMES[1]};
  const attested={week_id:'w',status:'commissioner_attested_not_official',revision:2,results:{w1a:final(21,14),w1b:final(10,17)}};
  assert.deepEqual(attestedScoreFacts(config,attested),{revision:2,rows:[
    {id:'w1a',status:'final',awayScore:21,homeScore:14},{id:'w1b',status:'final',awayScore:10,homeScore:17}]});
  for(const bad of [null,{...attested,status:'unpublished'},{...attested,status:'sealed'},{...attested,revision:0},
    {...attested,results:{w1a:final(21,14)}},{...attested,results:{...attested.results,extra:final(1,0)}},
    {...attested,results:{w1a:final(21,14),w1b:{status:'live',away_score:10,home_score:17}}},
    {...attested,results:{w1a:final(21,14),w1b:final(10,-1)}},{...attested,results:{w1a:final(21,14),w1b:final(10,'17')}}])
    assert.equal(attestedScoreFacts(config,bad),null);
  const week={pool_id:POOL,season:2026,week:1,pool_type:'pickem',visibility:'after_deadline',entries:[
    {...ENTRIES[0],submission:{source:'participant',status:'submitted',payload:{picks:{w1a:'away',w1b:'home'}}}},
    {...ENTRIES[1],submission:{source:'participant',status:'submitted',payload:{picks:{w1a:'home',w1b:'home'}}}},
    {...ENTRIES[2],submission:null}]};
  const projected=projectPoolStandings({snapshot:week,config,scoreFacts:attestedScoreFacts(config,attested),poolId:POOL,season:2026,week:1});
  assert.deepEqual(projected.rows.map(r=>[r.rank,r.name,r.confirmed??null,r.losses??null,r.submission]),[
    [1,'Alice',2,0,'submitted'],[2,'Bob',1,1,'submitted'],[null,'Cy',0,0,'missing']]);
  assert.deepEqual([projected.completed,projected.total],[2,2]);
});

test('the standings code is pure, and the season read is one read-only function that returns no attester or evidence',()=>{
  for(const name of ['season-standings-core.js','results-grading.js']){
    const code=readFileSync(new URL(`../${name}`,import.meta.url),'utf8').replace(/^\s*\/\/.*$/gm,'');
    assert.doesNotMatch(code,/\bfetch\s*\(|XMLHttpRequest|WebSocket|\bdocument\b|\bwindow\b|localStorage|sessionStorage|indexedDB|Date\.now|new Date|Math\.random|process\.|\bimport\s*\(/,name);
    assert.deepEqual([...code.matchAll(/^import .* from '([^']+)';$/gm)].map(m=>m[1]),name==='results-grading.js'?[]:['./results-grading.js'],name);
  }
  const board=readFileSync(new URL('../season-standings-board.js',import.meta.url),'utf8');
  assert.doesNotMatch(board,/innerHTML|insertAdjacentHTML|outerHTML|localStorage|sessionStorage|\bfetch\s*\(/);
  const sqlText=readFileSync(new URL('../migrations/20261112_season_standings_snapshot.sql',import.meta.url),'utf8');
  const statements=sqlText.replace(/^\s*--.*$/gm,'');
  assert.equal((statements.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi)??[]).length,1);
  assert.doesNotMatch(statements,/\bCREATE\s+OR\s+REPLACE\b|\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|ALTER|DROP|CREATE\s+TABLE|CREATE\s+TRIGGER)\b/i);
  assert.match(statements,/LANGUAGE plpgsql STABLE SECURITY DEFINER\s+SET search_path TO 'public', 'neon_auth', 'pg_temp'/);
  assert.doesNotMatch(statements,/attested_by|source_sha256|source_reference|correction_reason|owner_auth_user_id\s*,|submitted_by|email|pool_platform_submission_audit|pool_platform_week_result_evidence/i);
  // The first executable statement refuses a caller without a subject, before any query: the browser client's
  // one-time retry of auth_required depends on that for every RPC it can call.
  const body=statements.slice(statements.indexOf('BEGIN')+5).trimStart();
  assert.match(body,/^IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;/);
  assert.match(statements,/REVOKE ALL ON FUNCTION public\.pool_platform_season_standings_snapshot\(uuid,integer\) FROM PUBLIC;\s*GRANT EXECUTE ON FUNCTION public\.pool_platform_season_standings_snapshot\(uuid,integer\) TO authenticated;\s*$/);
});
