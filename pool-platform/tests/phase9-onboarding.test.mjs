import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const sql=read('migrations/20261104_phase9_pool_season_onboarding.sql');
const js=read('commissioner.js'),html=read('commissioner.html'),client=read('platform-client.js');
test('pool creation is assigned only to verified existing tenant commissioner, not anyone signed in',()=>{
  const f=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.pool_platform_create_pool('),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.pool_platform_create_season('));
  assert.ok(f.indexOf("IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'")<f.indexOf('FROM public.pool_platform_tenants'));
  assert.match(f,/role IN \('owner','commissioner'\)/);
  assert.match(f,/auth_user_id=v_uid/);
  assert.match(f,/v_tenant_status IS DISTINCT FROM 'active'/);
  assert.match(f,/RANDOM_DOES_NOT_EXIST|gen_random_uuid/);
  assert.match(sql,/CREATE UNIQUE INDEX IF NOT EXISTS pool_platform_pools_global_slug_idx/);
  assert.doesNotMatch(f,/\bINSERT INTO public\.pool_platform_memberships\b/);
});
test('pool rules enforce consistent approved tie and Survivor policy defaults',()=>{
  assert.match(sql,/pointsPerCorrectPick/);
  assert.match(sql,/tiesBothLose/);
  assert.match(sql,/tiesEliminate/);
  assert.match(sql,/repeatTeamsAllowed/);
});
test('season creation checks authorized pool, active tenant and unique season',()=>{
  const f=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.pool_platform_create_season('));
  assert.ok(f.indexOf("IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'")<f.indexOf('FROM public.pool_platform_pools'));
  assert.match(f,/pool_platform_is_tenant_commissioner\(v_tenant_id\)/);
  assert.match(f,/duplicate_season/);
  assert.match(f,/VALUES \(p_pool_id,p_season,'setup'/);
  assert.doesNotMatch(f,/UPDATE public\.pool_platform_(?:submissions|weeks|submission_audit)/i);
});
test('both RPCs are only callable by authenticated role with secure function environment',()=>{
  for(const f of ['pool_platform_create_pool','pool_platform_create_season']){
    assert.match(sql,new RegExp('REVOKE ALL ON FUNCTION public\\.'+f));
    assert.match(sql,new RegExp('GRANT EXECUTE ON FUNCTION public\\.'+f+'.*TO authenticated;'));
  }
  assert.equal((sql.match(/SECURITY DEFINER/g)||[]).length,2);
  assert.equal((sql.match(/SET search_path TO 'public', 'neon_auth', 'pg_temp'/g)||[]).length,2);
});
test('frontend requires review then confirmation, never browser SQL or generated id',()=>{
  for(const id of ['createPoolSetup','createPoolName','createPoolType','previewCreatePool','confirmCreatePool',
    'createSeasonSetup','createSeasonYear','previewCreateSeason','confirmCreateSeason']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(js,/client\.createPool\(draft\)/);
  assert.match(js,/client\.createSeason\(\{/);
  assert.match(js,/state\.poolCreateDraft/);
  assert.match(js,/state\.seasonCreateDraft/);
  assert.match(client,/pool_platform_create_pool/);
  assert.match(client,/pool_platform_create_season/);
});
