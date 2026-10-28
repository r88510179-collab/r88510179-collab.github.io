import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";

// Text contracts over the CRM SQL files. They run in CI without PostgreSQL and pin the properties the AUTH-C
// reconciliation relies on; the database-level checks are 004 (invariants), 008 (release gate) and 009 (catalog
// baseline), run on a post-AUTH-C validation branch.
const migrations=new URL("../migrations/",import.meta.url);
const read=name=>readFileSync(new URL(name,migrations),"utf8");
const files=readdirSync(migrations).filter(name=>name.endsWith(".sql")).sort();

// SQL with comments and string literals removed, so keywords inside has_table_privilege('…','INSERT') or a
// comment never count as statements.
function bare(sql){
  return sql.replace(/--[^\n]*/g,"").replace(/'(?:[^']|'')*'/g,"''");
}
const WRITE=/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COPY|LOCK|VACUUM|SET|SAVEPOINT|ROLLBACK|COMMIT|BEGIN|DO)\b/i;

function functionBody(sql,name){
  const start=sql.indexOf("FUNCTION public."+name+"(");
  assert.ok(start>=0,name+" is defined");
  const end=sql.indexOf("$$;",start);
  assert.ok(end>start,name+" body ends");
  return sql.slice(start,end);
}

test("migration files are the reviewed set",()=>{
  assert.deepEqual(files,[
    "001_crm_additive.sql","002_pool_scoped_authorization.sql","003_crm_read_models.sql",
    "004_validate_crm_invariants.sql","005_assistant_enrollment.sql","006_staging_role_simulation.sql",
    "007_staging_dues_simulation.sql","008_post_auth_c_readonly_gate.sql","009_crm_catalog_baseline.sql"
  ]);
});

test("F1: assistant enrollment mirrors the AUTH-C identity rule (no neon_auth.account row)",()=>{
  const add=functionBody(read("005_assistant_enrollment.sql"),"pool_platform_crm_add_assistant");
  assert.match(add,/u\."emailVerified"=true AND COALESCE\(u\.banned,false\)=false\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM neon_auth\.account a WHERE a\."userId"=u\.id\)/);
  assert.match(read("004_validate_crm_invariants.sql"),/crm_assistant_enrollment_admits_account_holders/);
  const gate=read("008_post_auth_c_readonly_gate.sql");
  assert.match(gate,/pool_platform_crm_add_assistant\(uuid,text,text,uuid\[\],text\[\]\)/);
  assert.match(gate,/'Assistant enrollment refuses account-holding users',add_def LIKE '%neon_auth\.account%' AND add_def LIKE '%not exists%'/);
});

test("no CRM migration redefines an AUTH-C identity helper outside the rolled-back simulations",()=>{
  const helpers=/FUNCTION public\.pool_platform_current_user_(id|email|has_verified_email)\b/;
  for(const name of files){
    const sql=read(name);
    if(name.startsWith("006_")||name.startsWith("007_")){
      assert.match(sql,/^SAVEPOINT crm_[a-z_]+;/m,name+" opens a savepoint");
      assert.match(sql,/ROLLBACK TO SAVEPOINT crm_[a-z_]+;\s*\n\s*RELEASE SAVEPOINT/,name+" rolls its mock back");
      assert.match(sql,/FUNCTION public\.pool_platform_current_user_id\(\)/,name+" mocks the identity inside the savepoint");
    }else{
      assert.doesNotMatch(sql,helpers,name+" must not touch an identity helper");
    }
  }
});

test("008 and 009 are single read-only SELECT statements",()=>{
  for(const name of ["008_post_auth_c_readonly_gate.sql","009_crm_catalog_baseline.sql"]){
    const sql=bare(read(name)).trim();
    assert.match(sql,/^WITH\b/,name+" starts with WITH");
    assert.equal((sql.match(/;/g)||[]).length,1,name+" is one statement");
    assert.ok(sql.endsWith(";"),name+" ends its one statement");
    assert.doesNotMatch(sql,WRITE,name+" holds no write or transaction keyword");
  }
});

test("F2: the CRM catalog baseline names every CRM table, function and policy of 001, 003 and 005",()=>{
  const baseline=read("009_crm_catalog_baseline.sql");
  for(const table of ["pool_platform_staff_grants","pool_platform_pool_features","pool_platform_dues_events","pool_platform_crm_staff_audit"]){
    assert.match(baseline,new RegExp("\\('"+table+"','"+table+"_read'\\)"),table+" and its policy");
  }
  const signatures=[
    "pool_platform_staff_can(uuid, text)","pool_platform_set_staff_grants(uuid, text, text, uuid[], text[])",
    "pool_platform_set_dues_enabled(uuid, boolean)","pool_platform_record_dues_event(uuid, text, bigint, text)",
    "pool_platform_dues_immutable()","pool_platform_crm_pools()","pool_platform_crm_dues_summary(uuid)",
    "pool_platform_crm_assistants(uuid)","pool_platform_crm_update_assistant(uuid, text, text, uuid[], text[])",
    "pool_platform_crm_add_assistant(uuid, text, text, uuid[], text[])","pool_platform_crm_can_manage_staff(uuid)"
  ];
  for(const signature of signatures)assert.ok(baseline.includes("('"+signature+"',"),signature+" is expected");
  // Every CREATE FUNCTION of the forward migrations is in the expected set, and nothing else is.
  const created=new Set();
  for(const name of ["001_crm_additive.sql","003_crm_read_models.sql","005_assistant_enrollment.sql"]){
    for(const match of read(name).matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(pool_platform_[a-z_]+)\(/g))created.add(match[1]);
  }
  assert.deepEqual([...created].sort(),signatures.map(s=>s.split("(")[0]).sort());
  // The AUTH-C verifier's expected findings after the CRM additions are stated in the file header.
  assert.match(baseline,/C02 and C03 \(13 tables, all with RLS\), C08 \(2 triggers\), C09 \(13 policies\), C10 \(25 functions\), C11 and C12\s*\n?-- ?\(9 more authenticated EXECUTE grants\), C14 \(13 table ACL entries\)/);
  assert.match(baseline,/its C02, C03, C08, C09, C10, C11, C12 and C14 findings are then the CRM additions and nothing else/);
});

test("002 rewrites the seven overlapping RPCs to pool scope and nothing else",()=>{
  const sql=read("002_pool_scoped_authorization.sql");
  const defined=[...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(pool_platform_[a-z_]+)\(/g)].map(m=>m[1]).sort();
  assert.deepEqual(defined,[
    "pool_platform_can_read_pool","pool_platform_can_read_season","pool_platform_commissioner_context",
    "pool_platform_create_entry_invite","pool_platform_is_tenant_commissioner","pool_platform_submit_batch",
    "pool_platform_submit_entry"
  ]);
  for(const name of ["pool_platform_commissioner_context","pool_platform_create_entry_invite","pool_platform_submit_batch","pool_platform_submit_entry"]){
    const body=sql.slice(sql.indexOf("FUNCTION public."+name+"("),sql.indexOf("$function$;",sql.indexOf("FUNCTION public."+name+"(")));
    assert.match(body,/pool_platform_staff_can\(/,name+" checks a pool capability");
    assert.doesNotMatch(body,/pool_platform_is_tenant_commissioner\(/,name+" no longer grants tenant-wide access");
  }
  const tenant=sql.slice(sql.indexOf("FUNCTION public.pool_platform_is_tenant_commissioner("),sql.indexOf("$function$;",sql.indexOf("FUNCTION public.pool_platform_is_tenant_commissioner(")));
  assert.doesNotMatch(tenant,/co_commissioner/);
});
