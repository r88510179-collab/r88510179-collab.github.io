import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../migrations/20261106_pool_week_projection_snapshot.sql',import.meta.url),'utf8');
const app=readFileSync(new URL('../pool-standings-board.js',import.meta.url),'utf8');
const board=readFileSync(new URL('../game-day-board.js',import.meta.url),'utf8');
test('authenticated RPC fails closed before any database query or write',()=>{
  assert.match(sql,/SECURITY DEFINER/);
  assert.match(sql,/SET search_path TO 'public', 'neon_auth', 'pg_temp'/);
  const first=sql.indexOf("IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'");
  const query=sql.indexOf('FROM public.pool_platform_weeks');
  assert.ok(first>=0&&query>first);
  assert.match(sql,/REVOKE ALL ON FUNCTION public\.pool_platform_week_projection_snapshot\(uuid\) FROM PUBLIC/);
  assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.pool_platform_week_projection_snapshot\(uuid\) TO authenticated/);
  assert.doesNotMatch(sql,/\bINSERT\s+INTO\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
});
test('pool and tenant must be active with independently authorized membership',()=>{
  assert.match(sql,/WHERE w\.id=p_week_id AND p\.status='active' AND t\.status='active'/);
  assert.match(sql,/m\.tenant_id=v_tenant_id AND m\.auth_user_id=v_uid/);
  assert.match(sql,/m\.role IN \('owner','commissioner','co_commissioner'\)/);
  assert.match(sql,/e\.season_id=v_season_id AND e\.owner_auth_user_id=v_uid/);
  assert.match(sql,/IF NOT v_can_read THEN RAISE EXCEPTION 'week_not_found'/);
});
test('early deadline seal returns an empty entry array before any aggregation of others picks',()=>{
  const deadlineCheck=sql.indexOf("v_visible := v_status IN ('open','locked','final')");
  const sealedReturn=sql.indexOf("'visibility','sealed','entries','[]'::jsonb");
  const aggregate=sql.indexOf('SELECT COALESCE(jsonb_agg(jsonb_build_object(');
  assert.ok(deadlineCheck>=0&&sealedReturn>deadlineCheck&&aggregate>sealedReturn);
  assert.match(sql,/clock_timestamp\(\) >= v_deadline/);
  assert.match(sql,/WHERE e\.season_id=v_season_id AND e\.status IN \('active','eliminated'\)/);
  assert.match(sql,/standings_pool_too_large/);
});
test('RPC excludes player identifying or audit details from returned JSON objects',()=>{
  assert.doesNotMatch(sql,/'owner_auth_user_id'\s*,|'submitted_by_auth_user_id'\s*,|'actor_auth_user_id'\s*,|'email'\s*,|'audit'\s*,/);
  assert.match(sql,/jsonb_build_object\('picks',sub\.payload->'picks'\)/);
  assert.match(sql,/jsonb_build_object\('team',sub\.payload->'team'\)/);
  assert.doesNotMatch(sql,/sub\.payload\s*[),]/);
});
test('two role pages show one current pool and do not send picks to NFL gateway',()=>{
  for(const role of ['participant','commissioner']){
    const src=readFileSync(new URL('../'+role+'.js',import.meta.url),'utf8');
    const html=readFileSync(new URL('../'+role+'.html',import.meta.url),'utf8');
    assert.match(src,/createPoolStandingsBoard/);
    assert.match(src,/weekId:/);
    assert.match(html,/id="poolStandingsCard"/);
  }
  assert.match(app,/client\.weekProjectionSnapshot\(weekId\)/);
  assert.doesNotMatch(app,/\bPOST\b|submitEntry|submitBatch|createInvite|\bfetch\(/);
  assert.match(board,/onUpdate/);
  assert.doesNotMatch(board,/\/api\/nfl-scores\?[^;\n]*poolId/);
  // The address is built from SCORE_GATEWAY_PATH: season and week only, never a pool.
  assert.match(board,/const url=SCORE_GATEWAY_PATH\+'\?season='/);
  assert.doesNotMatch(board,/SCORE_GATEWAY_PATH\+[^;\n]*poolId/);
});
test('score-derived rankings are never labeled official',()=>{
  assert.match(app,/Unofficial live projection/);
  assert.match(app,/Official standings require separately verified final results/);
  assert.doesNotMatch(app,/Official standings have been published/);
});
