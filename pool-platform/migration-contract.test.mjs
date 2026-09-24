import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

const m1=fs.readFileSync(new URL('./migrations/001_foundation.sql',import.meta.url),'utf8');
const m2=fs.readFileSync(new URL('./migrations/002_identity_submission_rls.sql',import.meta.url),'utf8');

const TABLES=[
  'pool_platform_tenants','pool_platform_memberships','pool_platform_pools','pool_platform_seasons',
  'pool_platform_entries','pool_platform_weeks','pool_platform_submissions','pool_platform_submission_audit',
  'pool_platform_entry_invites'
];
const FUNCTIONS_001=['pool_platform_guard_submission_source'];
const FUNCTIONS_002={
  pool_platform_current_user_id:'',
  pool_platform_current_user_email:'',
  pool_platform_current_user_has_verified_email:'text',
  pool_platform_is_tenant_commissioner:'uuid',
  pool_platform_can_read_pool:'uuid',
  pool_platform_can_read_season:'uuid',
  pool_platform_create_entry_invite:'uuid,text,integer',
  pool_platform_claim_entry_invite:'text',
  pool_platform_payload_valid:'text,jsonb,uuid,uuid,jsonb',
  pool_platform_submit_entry:'uuid,uuid,text,jsonb',
  pool_platform_submit_batch:'uuid,text,jsonb',
  pool_platform_participant_context:'text,integer,integer',
  pool_platform_commissioner_context:'text'
};
const AUTHENTICATED_EXECUTE=[
  'pool_platform_current_user_id','pool_platform_is_tenant_commissioner','pool_platform_can_read_pool',
  'pool_platform_can_read_season','pool_platform_create_entry_invite','pool_platform_claim_entry_invite',
  'pool_platform_submit_entry','pool_platform_submit_batch','pool_platform_participant_context',
  'pool_platform_commissioner_context'
];
const INTERNAL_ONLY=['pool_platform_current_user_email','pool_platform_current_user_has_verified_email','pool_platform_payload_valid','pool_platform_guard_submission_source'];

// Minimal PostgreSQL lexer: comments, '' strings, "" identifiers, $tag$ dollar quotes, parentheses and
// top-level semicolons. It reports malformed/unterminated quoting instead of guessing.
function scanSql(sql){
  const statements=[],errors=[];
  const lineOf=pos=>sql.slice(0,pos).split('\n').length;
  const dollar=/\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
  let i=0,start=0,depth=0;
  while(i<sql.length){
    const c=sql[i],d=sql[i+1];
    if(c==='-'&&d==='-'){const j=sql.indexOf('\n',i);i=j<0?sql.length:j+1;continue}
    if(c==='/'&&d==='*'){const j=sql.indexOf('*/',i+2);if(j<0){errors.push(`unterminated block comment at line ${lineOf(i)}`);break}i=j+2;continue}
    if(c==="'"){
      let j=i+1;
      for(;;){
        const k=sql.indexOf("'",j);
        if(k<0){errors.push(`unterminated string literal at line ${lineOf(i)}`);j=sql.length;break}
        if(sql[k+1]==="'"){j=k+2;continue}
        j=k+1;break;
      }
      i=j;continue;
    }
    if(c==='"'){const k=sql.indexOf('"',i+1);if(k<0){errors.push(`unterminated identifier at line ${lineOf(i)}`);break}i=k+1;continue}
    if(c==='$'){
      dollar.lastIndex=i;
      const m=dollar.exec(sql);
      if(m){
        const k=sql.indexOf(m[0],i+m[0].length);
        if(k<0){errors.push(`unterminated dollar quote ${m[0]} at line ${lineOf(i)}`);break}
        i=k+m[0].length;continue;
      }
      if(/[0-9]/.test(d??'')){i++;continue}
      errors.push(`malformed dollar quote at line ${lineOf(i)}`);i++;continue;
    }
    if(c==='('){depth++;i++;continue}
    if(c===')'){depth--;i++;continue}
    if(c===';'&&depth===0){
      const text=sql.slice(start,i+1).replace(/^(?:\s*--[^\n]*\n?)*/,'').trim();
      if(text.length>1)statements.push({text,line:lineOf(start+sql.slice(start,i).search(/\S/))});
      start=i+1;i++;continue;
    }
    i++;
  }
  if(depth!==0)errors.push('unbalanced parentheses');
  if(sql.slice(start).replace(/--[^\n]*/g,'').trim())errors.push(`trailing text without a terminating semicolon at line ${lineOf(start)}`);
  return{statements,errors};
}

const scan1=scanSql(m1),scan2=scanSql(m2);
const functionName=stmt=>/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z_]+)\s*\(/i.exec(stmt.text)?.[1]??null;
const functionStatements=scan=>scan.statements.filter(functionName);
const functionBody=name=>{
  const stmt=functionStatements(scan2).find(s=>functionName(s)===name);
  assert.ok(stmt,`missing function ${name}`);
  const open=stmt.text.indexOf('AS $$'),close=stmt.text.lastIndexOf('$$');
  assert.ok(open>0&&close>open+4,`function ${name} must use an AS $$ ... $$ body`);
  return stmt.text.slice(open+5,close);
};
const pickemBranch=()=>{
  const body=functionBody('pool_platform_payload_valid');
  const from=body.indexOf("IF p_pool_type='pickem' THEN"),to=body.indexOf("IF p_pool_type='survivor' THEN");
  assert.ok(from>=0&&to>from,'payload_valid must contain a pickem branch followed by a survivor branch');
  return body.slice(from,to);
};

test('entry/week uniqueness and immutable source are database-enforced',()=>{
  assert.match(m1,/UNIQUE\s*\(week_id,entry_id\)/);
  assert.match(m1,/NEW\.source<>OLD\.source/);
  assert.match(m1,/OLD\.status='locked'/);
  assert.match(m2,/ON CONFLICT \(week_id,entry_id\) DO NOTHING/);
  assert.match(m2,/source_conflict:/);
  assert.match(m2,/submission_locked/);
  assert.match(m2,/CREATE UNIQUE INDEX IF NOT EXISTS pool_platform_pool_slug_global_unique\s+ON public\.pool_platform_pools\(slug\)/);
});

test('both migrations are lexically well-formed (no malformed dollar quotes or stray fragments)',()=>{
  assert.deepEqual(scan1.errors,[]);
  assert.deepEqual(scan2.errors,[]);
  assert.doesNotMatch(m2,/\bAS \$\s*$/m,'a bare "AS $" is a corrupted dollar quote');
  assert.doesNotMatch(m2,/^\$;\s*$/m,'a bare "$;" is a corrupted dollar-quote terminator');
  for(const stmt of [...scan1.statements,...scan2.statements]){
    assert.match(stmt.text,/^(CREATE|ALTER|DROP|GRANT|REVOKE)\b/,`unexpected statement start at line ${stmt.line}: ${stmt.text.slice(0,60)}`);
  }
  for(const stmt of [...functionStatements(scan1),...functionStatements(scan2)]){
    assert.match(stmt.text,/\bAS \$\$\n[\s\S]*\n\$\$;$/,`function at line ${stmt.line} must have one AS $$ ... $$; body`);
  }
});

test('each intended function is defined exactly once',()=>{
  const count=(scan,name)=>functionStatements(scan).filter(s=>functionName(s)===name).length;
  assert.deepEqual(functionStatements(scan1).map(functionName),FUNCTIONS_001);
  assert.deepEqual(functionStatements(scan2).map(functionName).sort(),Object.keys(FUNCTIONS_002).sort());
  for(const name of Object.keys(FUNCTIONS_002)){
    assert.equal(count(scan2,name),1,`${name} must be defined exactly once`);
    assert.equal(m2.split(`FUNCTION public.${name}(`).length-1,2+(AUTHENTICATED_EXECUTE.includes(name)?1:0),
      `${name} must appear once as a definition plus only its REVOKE/GRANT lines`);
  }
});

test('submit_entry revalidates payloads server-side before writing; no stale duplicate submit paths',()=>{
  const body=functionBody('pool_platform_submit_entry');
  const validate=body.indexOf('public.pool_platform_payload_valid(v_pool_type,v_week_config,p_entry_id,p_week_id,p_payload)');
  const insert=body.indexOf('INSERT INTO public.pool_platform_submissions(');
  assert.ok(validate>0,'submit_entry must call pool_platform_payload_valid');
  assert.ok(insert>validate,'payload validation must happen before the submission insert');
  assert.match(body,/RAISE EXCEPTION 'invalid_payload'/);
  assert.match(body,/p_payload IS NULL OR COALESCE\(jsonb_typeof\(p_payload\),''\)<>'object'/);
  assert.equal(m2.match(/CREATE OR REPLACE FUNCTION public\.pool_platform_submit_entry\(/g).length,1);
  assert.equal(m2.match(/CREATE OR REPLACE FUNCTION public\.pool_platform_submit_batch\(/g).length,1);
  assert.match(functionBody('pool_platform_submit_batch'),/public\.pool_platform_submit_entry\(/);
});

test('authenticated clients have reads but no direct table writes',()=>{
  assert.doesNotMatch(m2,/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL)\b/i);
  for(const table of TABLES){
    assert.match(m2,new RegExp(`GRANT SELECT ON public\\.${table} TO authenticated;`));
  }
  assert.match(m2,/Mutation flows go through reviewed SECURITY DEFINER functions/);
});

// A named REVOKE list removes only what it names: a default or earlier GRANT ALL on PostgreSQL 17 also carries
// MAINTAIN (LOCK, VACUUM, REINDEX, CLUSTER), and grant options, column privileges and PUBLIC grants outlive a
// list too. Every table is reset with REVOKE ALL for PUBLIC, anonymous and authenticated, then SELECT returns.
test('table privileges: every table is reset for PUBLIC, anonymous and authenticated before SELECT is granted back',()=>{
  const tableStatements=scan2.statements.filter(s=>/^(GRANT|REVOKE)\b[^;]*\bON (?:TABLE )?public\.pool_platform_/.test(s.text));
  for(const table of TABLES){
    const reset=tableStatements.findIndex(s=>s.text===`REVOKE ALL PRIVILEGES ON TABLE public.${table} FROM PUBLIC,anonymous,authenticated CASCADE;`);
    const grant=tableStatements.findIndex(s=>s.text===`GRANT SELECT ON public.${table} TO authenticated;`);
    assert.ok(reset>=0,`${table} must be reset with REVOKE ALL PRIVILEGES ... FROM PUBLIC,anonymous,authenticated CASCADE`);
    assert.ok(grant>reset,`${table} SELECT must be granted only after the reset`);
  }
  assert.equal(tableStatements.length,TABLES.length*2,'no other table privilege statements');
  assert.doesNotMatch(m2,/^REVOKE\s+(?!ALL PRIVILEGES\b|ALL ON FUNCTION\b|CREATE ON SCHEMA\b)/m,'a named privilege list must not return');
  assert.deepEqual(scan2.statements.filter(s=>/^(GRANT|REVOKE)\b/.test(s.text)&&/neon_auth/.test(s.text)),[],'002 must not change privileges on neon_auth objects');
});

test('the audit identity sequence is reset for PUBLIC, anonymous and authenticated and never granted',()=>{
  const sequenceSource=/GENERATED (?:ALWAYS|BY DEFAULT) AS IDENTITY|\b(?:SMALL|BIG)?SERIAL\b|CREATE SEQUENCE/gi;
  assert.match(m1,/CREATE TABLE IF NOT EXISTS public\.pool_platform_submission_audit \(\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,/,
    'pool_platform_submission_audit_id_seq is the identity sequence of pool_platform_submission_audit.id');
  assert.equal(m1.match(sequenceSource).length,1,'it is the only sequence 001 creates');
  assert.equal(m2.match(sequenceSource),null,'002 creates no sequence');
  assert.deepEqual(scan2.statements.filter(s=>/\bSEQUENCES?\b/.test(s.text)).map(s=>s.text),
    ['REVOKE ALL PRIVILEGES ON SEQUENCE public.pool_platform_submission_audit_id_seq FROM PUBLIC,anonymous,authenticated CASCADE;']);
});

test('anonymous has no commercial table or function access',()=>{
  for(const table of TABLES)assert.match(m2,new RegExp(`REVOKE ALL PRIVILEGES ON TABLE public\\.${table} FROM PUBLIC,anonymous,authenticated CASCADE;`));
  assert.doesNotMatch(m2,/GRANT[^;]*\bTO\s+(?:anonymous|PUBLIC)\b/i);
  assert.match(m2,/REVOKE CREATE ON SCHEMA public FROM anonymous,authenticated;/);
});

test('function privileges: every function is reset for PUBLIC, anonymous and authenticated; only the RLS helpers and RPCs are granted back',()=>{
  const lastDefinition=Math.max(...functionStatements(scan2).map(s=>scan2.statements.indexOf(s)));
  const privilegeStatements=scan2.statements.filter(s=>/^(GRANT|REVOKE)\b[^;]*\bON FUNCTION\b/.test(s.text));
  assert.ok(privilegeStatements.length>0);
  for(const stmt of privilegeStatements){
    assert.ok(scan2.statements.indexOf(stmt)>lastDefinition,`function privilege statement before the last definition at line ${stmt.line}`);
  }
  // REVOKE ... FROM PUBLIC alone leaves grants made directly to anonymous/authenticated (default privileges,
  // an earlier run) in place, and CREATE OR REPLACE keeps them; CASCADE also drops grants they passed on.
  for(const [name,args] of Object.entries({...FUNCTIONS_002,pool_platform_guard_submission_source:''})){
    const sig=`public.${name}(${args})`.replace(/[.()]/g,'\\$&');
    assert.equal(privilegeStatements.filter(s=>new RegExp(`^REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC,anonymous,authenticated CASCADE;$`).test(s.text)).length,1,`${name} must be reset for PUBLIC, anonymous and authenticated once`);
    const grants=privilegeStatements.filter(s=>new RegExp(`^GRANT EXECUTE ON FUNCTION ${sig} TO authenticated;$`).test(s.text)).length;
    assert.equal(grants,AUTHENTICATED_EXECUTE.includes(name)?1:0,`${name} EXECUTE grant`);
    const revoke=privilegeStatements.findIndex(s=>s.text.startsWith(`REVOKE ALL ON FUNCTION public.${name}(`));
    const grant=privilegeStatements.findIndex(s=>s.text.startsWith(`GRANT EXECUTE ON FUNCTION public.${name}(`));
    if(grant>=0)assert.ok(grant>revoke,`${name} must be granted only after it is reset`);
  }
  assert.equal(privilegeStatements.length,Object.keys(FUNCTIONS_002).length+1+AUTHENTICATED_EXECUTE.length,'no other function privilege statements');
  assert.doesNotMatch(m2,/FROM PUBLIC;/,'the PUBLIC-only revoke form must not return');
  for(const name of INTERNAL_ONLY)assert.doesNotMatch(m2,new RegExp(`GRANT[^;]*${name}`));
  for(const helper of ['pool_platform_current_user_id\\(\\)','pool_platform_is_tenant_commissioner\\(uuid\\)','pool_platform_can_read_pool\\(uuid\\)','pool_platform_can_read_season\\(uuid\\)']){
    assert.match(m2,new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${helper} TO authenticated;`));
  }
});

test('SECURITY DEFINER functions pin a fixed search_path',()=>{
  for(const stmt of functionStatements(scan2)){
    assert.match(stmt.text,/\bSECURITY DEFINER\b/,functionName(stmt));
    assert.match(stmt.text,/\nSET search_path=(?:pg_catalog,)?public,neon_auth,pg_temp\n/,functionName(stmt));
  }
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
  assert.match(m2,/revoked_at IS NULL/);
  assert.match(m2,/claimed_at IS NULL/);
  assert.match(m2,/invite_email_mismatch/);
  assert.match(m2,/entry_already_claimed/);
});

test('email-bound invites require a matching AND verified Neon Auth email; unbound invites stay bearer tokens',()=>{
  const helper=functionBody('pool_platform_current_user_has_verified_email');
  assert.match(helper,/FROM neon_auth\."user" u/);
  assert.match(helper,/u\.id::text=auth\.user_id\(\)/);
  assert.match(helper,/COALESCE\(u\.banned,false\)=false/);
  assert.match(helper,/u\."emailVerified" IS TRUE/,'Neon Auth stores verification in the camelCase "emailVerified" column');
  assert.match(helper,/lower\(btrim\(u\.email\)\)=p_email_normalized/);
  assert.match(functionBody('pool_platform_current_user_email'),/SELECT lower\(btrim\(u\.email\)\)/);

  const claim=functionBody('pool_platform_claim_entry_invite');
  const bound=claim.indexOf('IF v_inv.email_normalized IS NOT NULL THEN');
  const mismatch=claim.indexOf("RAISE EXCEPTION 'invite_email_mismatch'");
  const unverified=claim.indexOf("RAISE EXCEPTION 'invite_email_unverified'");
  const claimWrite=claim.indexOf('UPDATE public.pool_platform_entries');
  assert.ok(bound>0&&mismatch>bound&&unverified>mismatch&&claimWrite>unverified,'both email checks run inside the bound-invite branch before any write');
  assert.match(claim,/IF v_email IS NULL OR v_inv\.email_normalized<>v_email/,'a missing account email must fail closed');
  assert.match(claim,/IF NOT public\.pool_platform_current_user_has_verified_email\(v_inv\.email_normalized\)/);
  assert.doesNotMatch(claim,/v_inv\.email_normalized IS NOT NULL AND v_inv\.email_normalized<>v_email/,'the NULL-unsafe comparison must not return');
});

test('Survivor team reuse is blocked atomically per entry by a partial unique index',()=>{
  assert.match(m2,/CREATE UNIQUE INDEX IF NOT EXISTS pool_platform_submissions_survivor_team_unique\n  ON public\.pool_platform_submissions\(entry_id,\(payload->>'team'\)\)\n  WHERE jsonb_typeof\(payload->'team'\)='string';/);
  const valid=functionBody('pool_platform_payload_valid');
  assert.match(valid,/AND s\.week_id<>p_week_id\n/,'history check must cover later weeks too (out-of-order submissions)');
  assert.doesNotMatch(valid,/w\.week<v_week/,'an earlier-weeks-only check misses out-of-order reuse');
  assert.match(valid,/\) THEN RAISE EXCEPTION 'team_already_used'; END IF;/);
  assert.match(functionBody('pool_platform_participant_context'),/WHERE hs\.entry_id=e\.id AND hw\.season_id=v_season\.id AND hw\.week<>v_week\.week\n/,
    'participant history must list every other week so the browser marks the same teams used');
  const submit=functionBody('pool_platform_submit_entry');
  assert.match(submit,/WHERE w\.id=p_week_id AND e\.id=p_entry_id\n  FOR NO KEY UPDATE OF e;/,'submissions for one entry must serialize on the entry row');
  assert.match(submit,/EXCEPTION WHEN unique_violation THEN\n[\s\S]*GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;\n  IF v_constraint='pool_platform_submissions_survivor_team_unique'\n  THEN RAISE EXCEPTION 'team_already_used'; END IF;\n  RAISE;\nEND;\n$/);
});

test('submit_entry authorizes before entry-state, week-state, payload and history checks',()=>{
  const body=functionBody('pool_platform_submit_entry');
  const at=text=>{const i=body.indexOf(text);assert.ok(i>0,`missing ${text}`);return i};
  const resolved=at("RAISE EXCEPTION 'invalid_entry_week'");
  const owner=at("RAISE EXCEPTION 'entry_not_owned'");
  const commissioner=at("RAISE EXCEPTION 'commissioner_required'");
  const entryState=at("RAISE EXCEPTION 'entry_not_active'");
  const weekState=at("RAISE EXCEPTION 'week_not_open'");
  const deadline=at("RAISE EXCEPTION 'deadline_passed'");
  const payloadShape=at("RAISE EXCEPTION 'invalid_payload'");
  const history=at('public.pool_platform_payload_valid(');
  assert.ok(resolved<owner&&owner<commissioner,'authorization runs right after the entry/week pair resolves');
  for(const [name,i] of Object.entries({entryState,weekState,deadline,payloadShape,history})){
    assert.ok(i>commissioner,`${name} must come after authorization`);
  }
  assert.match(body,/IF p_source IS NULL OR p_source NOT IN \('participant','commissioner_import','commissioner_manual'\)/);
  assert.match(body,/IF v_entry_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'entry_not_active'; END IF;/);
  assert.match(body,/SELECT p\.tenant_id,e\.owner_auth_user_id,e\.status,w\.status,/);
});

test('audit history records the genuine previous payload',()=>{
  const body=functionBody('pool_platform_submit_entry');
  const capture=body.indexOf('v_previous_payload:=v_existing.payload;');
  const update=body.indexOf('UPDATE public.pool_platform_submissions');
  assert.ok(capture>0&&update>capture,'previous payload must be captured before the update');
  assert.match(body,/VALUES \(v_created\.id,v_uid,'created',p_source,NULL,p_payload\)/);
  assert.match(body,/VALUES \(v_existing\.id,v_uid,'updated',p_source,v_previous_payload,p_payload\)/);
});

test('Survivor payload_valid accepts only a JSON-string team, before any key, history or index logic',()=>{
  const body=functionBody('pool_platform_payload_valid');
  const branch=body.slice(body.indexOf("IF p_pool_type='survivor' THEN"));
  const at=text=>{const i=branch.indexOf(text);assert.ok(i>0,`missing ${text}`);return i};
  const typeCheck=at("IF COALESCE(jsonb_typeof(p_payload->'team'),'')<>'string' THEN RETURN false; END IF;");
  assert.ok(typeCheck<at("v_team:=NULLIF(p_payload->>'team','');"),'type check before the team text is read');
  assert.ok(typeCheck<at('WHERE team=v_team'),'type check before the configured-key match');
  assert.ok(typeCheck<at('FROM public.pool_platform_weeks w WHERE w.id=p_week_id'),'type check before any table read');
  assert.ok(typeCheck<at("RAISE EXCEPTION 'team_already_used'"),'type check before the history check');
});

test('payload shape is revalidated in Postgres for Pickem and Survivor',()=>{
  assert.match(m2,/pool_platform_payload_valid/);
  assert.match(m2,/p_pool_type='pickem'/);
  assert.match(m2,/p_pool_type='survivor'/);
  assert.match(m2,/s\.payload->>'team'=v_team/);
  assert.match(m2,/invalid_payload/);
  assert.match(m2,/COALESCE\(jsonb_typeof\(p_payload\),''\)<>'object'/);
  assert.match(m2,/count\(DISTINCT g->>'id'\)/);
});

test('Pickem per-game pick check fails closed on missing, null or non-string picks',()=>{
  const branch=pickemBranch();
  assert.doesNotMatch(branch,/NOT IN \('away','home'\)/,'NOT IN lets NULL (missing/null pick) through');
  assert.match(branch,/WHERE NOT COALESCE\(/);
  assert.match(branch,/jsonb_typeof\(g\)='object'/);
  assert.match(branch,/\(g->>'id'\)<>''/);
  assert.match(branch,/jsonb_typeof\(p_payload->'picks'->\(g->>'id'\)\)='string'/);
  assert.match(branch,/\(p_payload->'picks'->>\(g->>'id'\)\) IN \('away','home'\),\s*false\s*\)/);
  assert.match(branch,/IF v_tb_text IS NULL OR v_tb_text!~'\^\[0-9\]\{1,3\}\$' THEN RETURN false; END IF;/);
  assert.match(branch,/IF v_tb_text::integer>200 THEN RETURN false; END IF;/);
});

// Live Neon validation kit: both files must stay read-only and describe the same contract as the migrations.
const preflight=fs.readFileSync(new URL('./validation/neon-preflight.sql',import.meta.url),'utf8');
const verify=fs.readFileSync(new URL('./validation/neon-catalog-verify.sql',import.meta.url),'utf8');

// The SQL with comments, string literals, quoted identifiers and dollar quotes blanked, lexed as scanSql does.
function codeOnly(sql){
  let out='',i=0;
  const dollar=/\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
  while(i<sql.length){
    const c=sql[i],d=sql[i+1];
    if(c==='-'&&d==='-'){const j=sql.indexOf('\n',i);i=j<0?sql.length:j;out+=' ';continue}
    if(c==='/'&&d==='*'){const j=sql.indexOf('*/',i+2);i=j<0?sql.length:j+2;out+=' ';continue}
    if(c==="'"){
      let j=i+1;
      for(;;){const k=sql.indexOf("'",j);if(k<0){j=sql.length;break}if(sql[k+1]==="'"){j=k+2;continue}j=k+1;break}
      i=j;out+="''";continue;
    }
    if(c==='"'){const k=sql.indexOf('"',i+1);i=k<0?sql.length:k+1;out+='""';continue}
    if(c==='$'){dollar.lastIndex=i;const m=dollar.exec(sql);if(m){const k=sql.indexOf(m[0],i+m[0].length);i=k<0?sql.length:k+m[0].length;out+="''";continue}}
    out+=c;i++;
  }
  return out;
}

test('validation kit: each file is one read-only SELECT over the catalogs',()=>{
  for(const [name,sql] of Object.entries({preflight,verify})){
    const scan=scanSql(sql);
    assert.deepEqual(scan.errors,[],name);
    assert.equal(scan.statements.length,1,`${name} must be exactly one statement`);
    assert.match(scan.statements[0].text,/^WITH\n/,`${name} must be a single WITH ... SELECT`);
    const code=codeOnly(sql);
    assert.doesNotMatch(code,/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COPY|CALL|DO|SET|RESET|LOCK|VACUUM|ANALYZE|CLUSTER|REINDEX|REFRESH|COMMENT|SECURITY|NOTIFY|LISTEN|PREPARE|EXECUTE|DISCARD|IMPORT|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RETURNING|INTO)\b/i,`${name} must not change anything`);
    assert.doesNotMatch(code,/\b(?:nextval|setval|set_config|pg_advisory\w*|pg_try_advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_notify|lo_\w+|dblink\w*|pg_stat_reset\w*)\s*\(/i,`${name} must not call functions with side effects`);
    assert.doesNotMatch(code,/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b/i,`${name} must not take row locks`);
    // Fail closed: the verdict is false unless every required row is exactly true.
    assert.match(sql,/COALESCE\(bool_and\(COALESCE\(ok,false\)\) FILTER \(WHERE required\),false\)\nFROM checks\nORDER BY check_id/);
  }
  assert.match(preflight,/SELECT 'P99','verdict',true,/);
  assert.match(verify,/SELECT 'C99','verdict',true,/);
});

test('validation kit: the catalog verifier expects exactly the tables, policies and functions the migrations create',()=>{
  const policies=[...m2.matchAll(/CREATE POLICY (\w+) ON public\.(\w+)/g)].map(([,policy,table])=>`('${table}','${policy}')`);
  assert.deepEqual(policies.map(p=>p.split("'")[1]).sort(),[...TABLES].sort(),'one policy per commercial table');
  for(const row of policies)assert.ok(verify.includes(`  ${row}`),`verifier must expect ${row}`);
  assert.equal(verify.match(/^  \('pool_platform_\w+','pool_platform_\w+'\)/gm).length,TABLES.length,'no other expected tables');
  const signature=(name,args)=>`${name}(${args.split(',').filter(Boolean).join(', ')})`;
  const expectedFunctions={...FUNCTIONS_002,pool_platform_guard_submission_source:''};
  for(const [name,args] of Object.entries(expectedFunctions)){
    const kind=AUTHENTICATED_EXECUTE.includes(name)?'rpc':'internal';
    assert.equal(kind==='internal',INTERNAL_ONLY.includes(name),name);
    assert.ok(verify.includes(`  ('${signature(name,args)}','${kind}')`),`verifier must expect ${signature(name,args)} as ${kind}`);
  }
  assert.equal(verify.match(/^  \('pool_platform_\w+\([^)]*\)','(?:rpc|internal)'\)/gm).length,Object.keys(expectedFunctions).length,'no other expected functions');
  assert.match(verify,/'pool_platform_submission_source_guard'/);
  assert.match(verify,/to_regclass\('public\.pool_platform_pool_slug_global_unique'\)/);
  assert.match(verify,/to_regclass\('public\.pool_platform_submissions_survivor_team_unique'\)/);
});

test('validation kit: MAINTAIN is only checked where PostgreSQL knows it, and is required from 17 on',()=>{
  // has_table_privilege rejects MAINTAIN before PostgreSQL 17, so it may only come from the version-gated row.
  assert.match(verify,/UNION ALL SELECT 'MAINTAIN' FROM ver WHERE num>=170000\n/);
  assert.doesNotMatch(verify+preflight,/has_table_privilege\([^)]*'MAINTAIN'/);
  assert.match(verify,/SELECT 'C21','authenticated MAINTAIN \(PostgreSQL 17\+\)',\(SELECT num>=170000 FROM ver\),/);
  assert.match(verify,/WHERE has<>\(role='authenticated' AND priv='SELECT'\)\),'as expected'\)/,'C13: anonymous nothing, authenticated SELECT only');
});

test('validation kit: preflight gates the personal Pool Center, Neon Auth, auth.user_id() and default privileges',()=>{
  assert.match(preflight,/current_database\(\)<>'nfl_pool'/);
  assert.match(preflight,/WHERE c\.relname IN \('nfl_pool_weeks','nfl_survivor_weeks'\)/);
  assert.match(preflight,/WHERE polname LIKE 'nfl\\_survivor\\_%'/);
  assert.match(preflight,/to_regprocedure\('auth\.user_id\(\)'\)/);
  // The columns 002's identity helpers read from neon_auth."user".
  for(const column of ['u.id::text','u.email','COALESCE(u.banned,false)','u."emailVerified"'])assert.ok(m2.includes(column),column);
  assert.match(preflight,/unnest\(ARRAY\['id','email','emailVerified','banned'\]\) c\(name\)/);
  assert.match(preflight,/FROM pg_default_acl d CROSS JOIN LATERAL aclexplode\(d\.defaclacl\) x/);
  assert.match(preflight,/SELECT 'P20','default privileges 002 does not reset',true,/);
  assert.match(preflight,/num\/10000 IN \(16,17,18\) AS ok/);
});

// Behaviour fixtures for pool_platform_payload_valid. Survivor cases here all return before the
// function reads any table, so they run without the commercial schema.
const PICKEM=JSON.stringify({tiebreakRequired:true,games:[{id:'g1'},{id:'g2'}]});
const PICKEM_NO_TB=JSON.stringify({games:[{id:'g1'},{id:'g2'}]});
const SURVIVOR=JSON.stringify({games:[{id:'g1',away:{key:'austin'},home:{key:'denver'}},{id:'g2',away:{key:'dup'},home:{key:'seattle'}},{id:'g3',away:{key:'dup'},home:{key:'miami'}}]});
// Configured keys equal to what ->> renders for non-string JSON teams, so only the type check can reject them.
const SURVIVOR_TYPED=JSON.stringify({games:[{id:'t1',away:{key:'123'},home:{key:'true'}},{id:'t2',away:{key:'["austin"]'},home:{key:'{"k": "v"}'}},{id:'t3',away:{key:'false'},home:{key:'1.5'}}]});
const PAYLOAD_CASES=[
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"},"tiebreak":47}',true,'valid complete payload'],
  ['pickem',PICKEM_NO_TB,'{"picks":{"g1":"home","g2":"away"}}',true,'valid payload without optional tiebreak'],
  ['pickem',PICKEM,'{"tiebreak":47}',false,'missing picks object'],
  ['pickem',PICKEM,'{"picks":null,"tiebreak":47}',false,'null picks'],
  ['pickem',PICKEM,'{"picks":{},"tiebreak":47}',false,'empty picks object'],
  ['pickem',PICKEM,'{"picks":{"g1":"away"},"tiebreak":47}',false,'one missing configured game'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":null},"tiebreak":47}',false,'game explicitly null'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":""},"tiebreak":47}',false,'empty string pick'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"draw"},"tiebreak":47}',false,'arbitrary string pick'],
  ['pickem',PICKEM,'{"picks":{"g1":"AWAY","g2":"home"},"tiebreak":47}',false,'case variant pick'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":1},"tiebreak":47}',false,'numeric pick'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":true},"tiebreak":47}',false,'boolean pick'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":["home"]},"tiebreak":47}',false,'array pick'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":{"side":"home"}},"tiebreak":47}',false,'object pick'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home","g3":"away"},"tiebreak":47}',false,'extra game'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"},"tiebreak":47,"note":"x"}',false,'extra top-level key'],
  ['pickem','{"games":[{"id":"g1"},{"id":"g1"}]}','{"picks":{"g1":"away"}}',false,'duplicate configured game id'],
  ['pickem','{"games":[]}','{"picks":{}}',false,'empty configured games'],
  ['pickem','{"games":[{"id":"g1"},{"id":""}]}','{"picks":{"g1":"away","":"home"}}',false,'empty configured game id'],
  ['pickem','{"games":[{"id":"g1"},{"away":"a","home":"b"}]}','{"picks":{"g1":"away"}}',false,'configured game without id'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"},"tiebreak":0}',true,'valid tiebreak 0'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"},"tiebreak":200}',true,'valid tiebreak 200'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"}}',false,'missing required tiebreak'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"},"tiebreak":null}',false,'null required tiebreak'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"},"tiebreak":-1}',false,'negative tiebreak'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"},"tiebreak":47.5}',false,'decimal tiebreak'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"},"tiebreak":201}',false,'tiebreak above 200'],
  ['pickem',PICKEM,'{"picks":{"g1":"away","g2":"home"},"tiebreak":"abc"}',false,'non-numeric tiebreak'],
  ['pickem',PICKEM,null,false,'SQL NULL payload'],
  ['pickem',PICKEM,'null',false,'JSON null payload'],
  ['pickem',PICKEM,'[{"g1":"away"}]',false,'array payload'],
  ['survivor',SURVIVOR,'{}',false,'survivor missing team'],
  ['survivor',SURVIVOR,'{"team":""}',false,'survivor empty team'],
  ['survivor',SURVIVOR,'{"team":null}',false,'survivor null team'],
  ['survivor',SURVIVOR,'{"team":"austin","note":"x"}',false,'survivor extra key'],
  ['survivor',SURVIVOR,'{"team":"houston"}',false,'survivor unknown team'],
  ['survivor',SURVIVOR,'{"team":"dup"}',false,'survivor ambiguous duplicate team'],
  ['survivor','{"games":{"g1":{}}}','{"team":"austin"}',false,'survivor schedule not an array'],
  ['survivor',SURVIVOR_TYPED,'{"team":123}',false,'survivor numeric team'],
  ['survivor',SURVIVOR_TYPED,'{"team":1.5}',false,'survivor decimal team'],
  ['survivor',SURVIVOR_TYPED,'{"team":true}',false,'survivor boolean true team'],
  ['survivor',SURVIVOR_TYPED,'{"team":false}',false,'survivor boolean false team'],
  ['survivor',SURVIVOR_TYPED,'{"team":["austin"]}',false,'survivor array team'],
  ['survivor',SURVIVOR_TYPED,'{"team":{"k":"v"}}',false,'survivor object team'],
  ['survivor',SURVIVOR_TYPED,'{"team":null}',false,'survivor null team with typed schedule']
];

test('payload fixtures cover the required Pickem and Survivor cases',()=>{
  const names=PAYLOAD_CASES.map(c=>c[4]);
  assert.equal(new Set(names).size,names.length);
  for(const required of ['valid complete payload','missing picks object','null picks','one missing configured game','game explicitly null','empty string pick','arbitrary string pick','numeric pick','boolean pick','array pick','object pick','extra game','duplicate configured game id','empty configured games','valid tiebreak 0','missing required tiebreak','negative tiebreak','decimal tiebreak','tiebreak above 200','survivor null team','survivor numeric team','survivor boolean true team','survivor array team','survivor object team']){
    assert.ok(names.includes(required),required);
  }
});

// Opt-in: POOL_PLATFORM_TEST_PG=postgresql://user@127.0.0.1:5432/throwaway node --test pool-platform/migration-contract.test.mjs
// Runs only against a local server, inside BEGIN/ROLLBACK, using a pg_temp copy of pool_platform_payload_valid.
const LIVE_PG=process.env.POOL_PLATFORM_TEST_PG||'';
test('payload fixtures against a local throwaway PostgreSQL (opt-in)',{skip:LIVE_PG?false:'set POOL_PLATFORM_TEST_PG to a local throwaway database URL'},()=>{
  const host=new URL(LIVE_PG).hostname;
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(host),`refusing non-local database host ${host}`);
  const definition=functionStatements(scan2).find(s=>functionName(s)==='pool_platform_payload_valid').text
    .split('FUNCTION public.pool_platform_payload_valid(').join('FUNCTION pg_temp.pool_platform_payload_valid(');
  const lit=value=>value===null?'NULL':`$fixture$${value}$fixture$::jsonb`;
  const rows=PAYLOAD_CASES.map(([type,config,payload],i)=>`(${i},'${type}',${lit(config)},${lit(payload)})`).join(',\n');
  const sql=`BEGIN;\n${definition}\nSELECT json_agg(json_build_object('i',i,'valid',pg_temp.pool_platform_payload_valid(t,c,NULL,NULL,p)) ORDER BY i)\nFROM (VALUES\n${rows}\n) AS cases(i,t,c,p);\nROLLBACK;\n`;
  const run=spawnSync('psql',[LIVE_PG,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const results=JSON.parse(run.stdout.trim());
  for(const {i,valid} of results){
    assert.equal(valid,PAYLOAD_CASES[i][3],PAYLOAD_CASES[i][4]);
  }
  assert.equal(results.length,PAYLOAD_CASES.length);
});
