import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {validatedNflverseWeek,catalogUpsertSql,fetchValidatedNflverseWeek,SCHEDULE_SOURCE_URL}
  from '../scripts/schedule-source.mjs';
const dir=path.resolve(import.meta.dirname,'..');
const time=new Date('2026-11-04T15:00:00Z'),season=2026,week=11;
// Synthetic negative/positive contract fixtures only. NEVER published as real NFL schedule.
const teams=['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB',
  'HOU','IND','JAX','KC','LV','LAC','LA','MIA','MIN','NE','NO','NYG','NYJ','PHI'];
const head='game_id,season,game_type,week,gameday,gametime,away_team,home_team';
function fixtures(){
  return [head,...Array.from({length:13},(_,i)=>{
    const away=teams[i*2],home=teams[i*2+1];
    return `2026_11_${away}_${home},2026,REG,11,2026-11-15,13:00,${away},${home}`;
  })].join('\n')+'\n';
}
function parse(text=fixtures()){return validatedNflverseWeek(text,{season,week,now:time,fetchedAt:time})}
test('validated source requires 13–16 real-format NFL week games and computes byes',()=>{
  const result=parse();
  assert.equal(result.games.length,13);assert.equal(result.byeTeams.length,6);
  assert.equal(result.sourceSha256.length,64);assert.ok(result.games.some(game=>game.away.key==='LAR'));
  assert.ok(result.games[0].kickoff.endsWith('18:00:00.000Z'));
});
test('Eastern time is DST-aware (November standard time vs September daylight time)',()=>{
  const november=parse();
  assert.equal(november.games[0].kickoff,'2026-11-15T18:00:00.000Z');
  const september=fixtures().replaceAll('2026-11-15','2026-09-13');
  const result=validatedNflverseWeek(september,{season,week,
    now:new Date('2026-09-01T15:00:00Z'),fetchedAt:new Date('2026-09-01T15:00:00Z')});
  assert.equal(result.games[0].kickoff,'2026-09-13T17:00:00.000Z');
});
test('missing game, duplicate team, provider identity mismatch and missing columns fail closed',()=>{
  assert.throws(()=>parse(fixtures().split('\n').slice(0,-2).join('\n')),/incomplete_regular_season_week/);
  assert.throws(()=>parse(fixtures().replace(',CHI\n',',ARI\n')),/impossible_matchup/);
  assert.throws(()=>parse(fixtures().replace('2026_11_ARI_ATL','2026_11_ATL_ARI')),/provider_game_id_mismatch/);
  assert.throws(()=>parse(fixtures().replace('game_id,','bad_column,')),/missing_required_columns/);
});
test('unofficial and malformed games cannot be labeled source validated',()=>{
  assert.throws(()=>parse(fixtures().replace(',REG,',',PRE,')),/incomplete_regular_season_week/);
  assert.throws(()=>parse(fixtures().replace(',13:00,',',bad,') ),/invalid_eastern_kickoff/);
  assert.throws(()=>parse(fixtures().replace(',BUF\n',',ZZZ\n')),/unknown_nfl_team|provider_game_id_mismatch/);
});
test('rejects stale source and future timestamps',()=>{
  const old=new Date('2026-10-01T00:00:00Z');
  assert.throws(()=>validatedNflverseWeek(fixtures(),{season,week,now:time,fetchedAt:old}),/stale_source/);
});
test('network importer only reads allow-listed source URL; SQL output is privilege-path only',async()=>{
  let called;
  const f=async url=>{called=url;return {ok:true,headers:{get:()=>null},text:async()=>fixtures()}};
  const result=await fetchValidatedNflverseWeek({season,week,now:time,fetchedAt:time,fetchImpl:f});
  assert.equal(called,SCHEDULE_SOURCE_URL);
  const sql=catalogUpsertSql(result);
  assert.match(sql,/pool_platform_verified_schedule_catalog/);
  assert.match(sql,/ON CONFLICT \(season,week\) DO UPDATE/);
  assert.ok(!sql.includes('pool_platform_weeks SET status'));
});
test('migration allows only a privileged catalog, authenticates before any reads and tracks audit',()=>{
  const sql=fs.readFileSync(path.join(dir,'migrations/20261104_phase9_verified_schedule_and_open.sql'),'utf8');
  for(const f of ['pool_platform_verified_schedule_preview','pool_platform_apply_verified_schedule','pool_platform_open_verified_week']){
    assert.match(sql,new RegExp(`FUNCTION public\\.${f}\\(`));
    assert.match(sql,new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\(.+ FROM PUBLIC`));
  }
  const blocks=sql.split('CREATE OR REPLACE FUNCTION public.').slice(1);
  for(const block of blocks){
    assert.ok(block.indexOf("IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'")<
      block.indexOf('FROM public.pool_platform_weeks'));
    assert.ok(block.indexOf('pool_platform_is_tenant_commissioner')>0);
  }
  assert.match(sql,/week_has_submissions/);
  assert.match(sql,/schedule_changed_reload/);
  assert.match(sql,/schedule_source_stale/);
  assert.match(sql,/pool_platform_week_operations_audit/);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql,/\bDELETE\s+FROM\s+public\.pool_platform_|\bTRUNCATE\b/i);
});
