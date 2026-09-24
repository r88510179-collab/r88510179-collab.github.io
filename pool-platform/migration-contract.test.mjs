import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const m1=fs.readFileSync(new URL('./migrations/001_foundation.sql',import.meta.url),'utf8');
const m2=fs.readFileSync(new URL('./migrations/002_identity_submission_rls.sql',import.meta.url),'utf8');

test('entry/week uniqueness and immutable source are database-enforced',()=>{
  assert.match(m1,/UNIQUE\s*\(week_id,entry_id\)/);
  assert.match(m1,/NEW\.source<>OLD\.source/);
  assert.match(m2,/ON CONFLICT \(week_id,entry_id\) DO NOTHING/);
  assert.match(m2,/source_conflict:/);
});

test('authenticated clients have reads but no direct table writes',()=>{
  assert.doesNotMatch(m2,/GRANT\s+(?:INSERT|UPDATE|DELETE)/i);
  assert.match(m2,/REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public\.pool_platform_submissions FROM authenticated/);
  assert.match(m2,/Mutation flows go through reviewed SECURITY DEFINER functions/);
  assert.match(m2,/GRANT EXECUTE ON FUNCTION public\.pool_platform_current_user_id\(\) TO authenticated/);
  assert.match(m2,/GRANT EXECUTE ON FUNCTION public\.pool_platform_can_read_pool\(uuid\) TO authenticated/);
});

test('tenant and participant authorization are checked server-side',()=>{
  assert.match(m2,/pool_platform_is_tenant_commissioner/);
  assert.match(m2,/owner_auth_user_id=v_uid/);
  assert.match(m2,/commissioner_required/);
  assert.match(m2,/entry_not_owned/);
  assert.match(m2,/now\(\)>=v_deadline/);
});

test('invites store only a hash and enforce expiry/email ownership',()=>{
  assert.match(m2,/token_sha256 bytea NOT NULL UNIQUE/);
  assert.match(m2,/digest\(v_raw,'sha256'\)/);
  assert.match(m2,/expires_at>now\(\)/);
  assert.match(m2,/invite_email_mismatch/);
});

test('payload shape is revalidated in Postgres for Pickem and Survivor',()=>{
  assert.match(m2,/pool_platform_payload_valid/);
  assert.match(m2,/p_pool_type='pickem'/);
  assert.match(m2,/p_pool_type='survivor'/);
  assert.match(m2,/team_already_used|s\.payload->>'team'=v_team/);
  assert.match(m2,/invalid_payload/);
  assert.match(m2,/COALESCE\(jsonb_typeof\(p_payload\),'\'\'\)/);
  assert.match(m2,/count\(DISTINCT g->>'id'\)/);
});
