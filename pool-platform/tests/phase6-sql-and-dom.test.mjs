import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');
const sqlFiles=['migrations/20261103_commissioner_pool_discovery.sql','migrations/20261103_commissioner_entry_create.sql','migrations/20261103_commissioner_draft_week.sql'];
for(const filename of sqlFiles){
  test(`${filename}: authenticated and tenant-scoped, not world-executable`,()=>{
    const sql=read(filename);
    assert.match(sql,/SECURITY DEFINER/);
    assert.match(sql,/SET search_path TO 'public', 'neon_auth', 'pg_temp'/);
    assert.match(sql,/REVOKE ALL ON FUNCTION .* FROM PUBLIC/);
    assert.match(sql,/GRANT EXECUTE ON FUNCTION .* TO authenticated/);
    assert.ok(sql.indexOf("IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'")<sql.indexOf('FROM public.pool_platform_'));
    assert.match(sql,/public\.pool_platform_memberships|public\.pool_platform_is_tenant_commissioner/);
  });
}
test('entry creation checks commissioner before inserting rows',()=>{
  const sql=read(sqlFiles[1]);
  assert.ok(sql.indexOf('public.pool_platform_is_tenant_commissioner')<sql.indexOf('INSERT INTO public.pool_platform_entries'));
  assert.match(sql,/s\.status IN \('setup', 'active'\)/);
  assert.match(sql,/p\.status = 'active'/);
  assert.match(sql,/v_code !~ '\^\[A-Z0-9\]/);
  assert.match(sql,/EXCEPTION WHEN unique_violation/);
});
test('pool discovery never writes database records',()=>{
  const sql=read(sqlFiles[0]);
  assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b\s+(INTO|FROM|public)/i);
  assert.match(sql,/m\.auth_user_id = v_uid/);
  assert.match(sql,/m\.role IN \('owner', 'commissioner', 'co_commissioner'\)/);
});
test('commissioner page has controls referenced by its controller',()=>{
  const html=read('commissioner.html'),controller=read('commissioner.js');
  const declared=new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(x=>x[1]));
  const referenced=[...controller.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(x=>x[1]);
  // The Survivor team selector is generated dynamically inside renderGuided().
  const generated=new Set([...controller.matchAll(/\bid=\"([A-Za-z0-9_-]+)\"/g)].map(x=>x[1]));
  const missing=[...new Set(referenced.filter(x=>!declared.has(x)&&!generated.has(x)))];
  assert.deepEqual(missing,[]);
});

test('draft week creation keeps scheduled games empty and does not open picks',()=>{
  const sql=read('migrations/20261103_commissioner_draft_week.sql');
  assert.ok(sql.indexOf('public.pool_platform_is_tenant_commissioner')<sql.indexOf('INSERT INTO public.pool_platform_weeks'));
  assert.match(sql,/VALUES\(p_season_id,p_week,'draft'/);
  assert.match(sql,/'\{"games":\[\]\}'::jsonb/);
  assert.match(sql,/EXCEPTION WHEN unique_violation/);
});
