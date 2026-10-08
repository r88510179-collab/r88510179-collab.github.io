import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {after,afterEach,before,describe,test} from 'node:test';

// Opt-in, end-to-end check of migrations 001 + 002 on a disposable LOCAL PostgreSQL cluster (never Neon):
//   POOL_PLATFORM_TEST_PG_CLUSTER=postgresql://postgres@127.0.0.1:5432/postgres \
//     node --test pool-platform/migration-integration.test.mjs
// The URL must be a superuser on localhost. The run creates the roles authenticated, anonymous,
// pool_platform_it_owner and pool_platform_it_other when missing, creates its own databases and drops them
// afterwards. Neon Auth is stood in for by neon_auth."user", neon_auth.account and neon_auth.session (columns as
// Neon publishes them), auth.user_id() reading a session setting, and auth.session() returning the JWT claims a
// second setting holds (JSON null when there are none, as pg_session_jwt answers). Both migrations are applied as the NOLOGIN
// owner role under hostile default privileges (every function, table and sequence the owner creates in public
// starts out granted to anonymous and authenticated), and races use real concurrent psql sessions. The 004
// forward migration is checked from the live pre-hardening helpers. Run it on PostgreSQL 16, 17 and 18: the
// privilege checks follow the server version, since 17 adds the table MAINTAIN privilege and 18 adds none. A
// second block runs clean and hostile privilege scenarios in small separate databases, together with the
// read-only live Neon validation kit in validation/.
const CLUSTER=process.env.POOL_PLATFORM_TEST_PG_CLUSTER||'';
const SKIP=CLUSTER?false:'set POOL_PLATFORM_TEST_PG_CLUSTER to a disposable local superuser URL';
const OWNER='pool_platform_it_owner';
const OTHER_ROLE='pool_platform_it_other';
const DB_NAME=`pool_platform_it_${process.pid}_${Date.now().toString(36)}`;
const urlFor=name=>{const u=new URL(CLUSTER);u.pathname=`/${name}`;return u.toString()};
const dbUrl=()=>urlFor(DB_NAME);
const readMigration=name=>fs.readFileSync(new URL(`./migrations/${name}`,import.meta.url),'utf8');
const readValidation=name=>fs.readFileSync(new URL(`./validation/${name}`,import.meta.url),'utf8');
const TABLES=['pool_platform_tenants','pool_platform_memberships','pool_platform_pools','pool_platform_seasons','pool_platform_entries','pool_platform_weeks','pool_platform_submissions','pool_platform_submission_audit','pool_platform_entry_invites'];
const AUDIT_SEQUENCE='pool_platform_submission_audit_id_seq';

function psqlSync(url,sql){
  const run=spawnSync('psql',[url,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8'});
  if(run.error)throw run.error;
  assert.equal(run.status,0,run.stderr);
  return run.stdout.trim();
}

// Like psqlSync, but carries on past errors and hands back stderr, where psql prints warnings.
function psqlRun(url,sql){
  const run=spawnSync('psql',[url,'-X','-q','-A','-t','-v','ON_ERROR_STOP=0'],{input:sql,encoding:'utf8'});
  if(run.error)throw run.error;
  return run;
}

const ensureRoles=()=>psqlSync(CLUSTER,`DO $$BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${OWNER}') THEN CREATE ROLE ${OWNER} NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${OTHER_ROLE}') THEN CREATE ROLE ${OTHER_ROLE} NOLOGIN; END IF;
END$$;`);
const assertLocalCluster=()=>{
  const host=new URL(CLUSTER).hostname;
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(host),`refusing non-local database host ${host}`);
};

// Table privileges PostgreSQL 16 knows. 17 adds MAINTAIN (LOCK in any mode, VACUUM, ANALYZE, REINDEX, CLUSTER),
// and before 17 has_table_privilege rejects that name outright, so every privilege check follows the server. 18
// adds none. VERIFIED_MAJORS are the versions this suite has been run on and the only ones the preflight (P01)
// admits; on any other the first privilege-scenario test fails.
const VERIFIED_MAJORS=[16,17,18];
const PG16_TABLE_PRIVILEGES=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
let serverVersion=0;
const pgVersion=()=>serverVersion||(serverVersion=Number(psqlSync(CLUSTER,'SHOW server_version_num')));
const hasMaintain=()=>pgVersion()>=170000;
const tablePrivileges=()=>[...PG16_TABLE_PRIVILEGES,...(hasMaintain()?['MAINTAIN']:[])].sort();

// The privilege state 002 must leave, read straight from the catalogs (independently of the validation kit):
// effective table rights per role and privilege, exact non-owner ACL entries on the tables and the audit
// sequence, column privileges, sequence rights, and the neon_auth."user" ACL that 002 must not touch.
function privilegeState(url){
  const privs=tablePrivileges().map(p=>`'${p}'`).join(',');
  return JSON.parse(psqlSync(url,`WITH t AS (
  SELECT c.oid,c.relname,c.relowner,COALESCE(c.relacl,acldefault('r',c.relowner)) AS acl FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'pool_platform_%'
), s AS (
  SELECT c.oid,c.relname,c.relowner,COALESCE(c.relacl,acldefault('s',c.relowner)) AS acl FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND c.relname LIKE 'pool_platform_%'
), roles(role) AS (VALUES ('anonymous'),('authenticated'))
SELECT json_build_object(
  'tables',(SELECT count(*) FROM t),
  'rights',(SELECT json_object_agg(r.role||' '||t.relname,ARRAY(SELECT p FROM unnest(ARRAY[${privs}]) p WHERE has_table_privilege(r.role,t.oid,p) ORDER BY p)) FROM t CROSS JOIN roles r),
  'acl',(SELECT json_object_agg(x.relname,ARRAY(
      SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type||CASE WHEN a.is_grantable THEN '+grant_option' ELSE '' END||' by '||pg_get_userbyid(a.grantor)
      FROM aclexplode(x.acl) a WHERE a.grantee<>x.relowner ORDER BY 1))
    FROM (SELECT relname,relowner,acl FROM t UNION ALL SELECT relname,relowner,acl FROM s) x),
  'columnAcl',ARRAY(SELECT t.relname||'.'||a.attname||'='||a.attacl::text FROM t JOIN pg_attribute a ON a.attrelid=t.oid WHERE a.attacl IS NOT NULL ORDER BY 1),
  'columnRights',ARRAY(SELECT r.role||':'||p||' on '||t.relname FROM t CROSS JOIN roles r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
    WHERE has_any_column_privilege(r.role,t.oid,p) AND NOT (r.role='authenticated' AND p='SELECT') ORDER BY 1),
  'sequenceRights',ARRAY(SELECT r.role||':'||p||' on '||s.relname FROM s CROSS JOIN roles r CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p
    WHERE has_sequence_privilege(r.role,s.oid,p) ORDER BY 1),
  'neonAuthAcl',(SELECT COALESCE(relacl::text,'default') FROM pg_class WHERE oid='neon_auth."user"'::regclass)
)`));
}

function assertPrivilegeContract(state,label){
  assert.equal(state.tables,TABLES.length,label);
  for(const table of TABLES){
    assert.deepEqual(state.rights[`anonymous ${table}`],[],`${label}: anonymous must hold no privilege on ${table}`);
    assert.deepEqual(state.rights[`authenticated ${table}`],['SELECT'],`${label}: authenticated must hold SELECT only on ${table}`);
    assert.deepEqual(state.acl[table],[`authenticated:SELECT by ${OWNER}`],`${label}: exact non-owner ACL of ${table}`);
  }
  assert.deepEqual(state.acl[AUDIT_SEQUENCE],[],`${label}: no non-owner ACL entry on ${AUDIT_SEQUENCE}`);
  assert.deepEqual(state.columnAcl,[],`${label}: no column privileges`);
  assert.deepEqual(state.columnRights,[],`${label}: no column rights for anonymous or authenticated`);
  assert.deepEqual(state.sequenceRights,[],`${label}: no sequence rights for anonymous or authenticated`);
}

// has_table_privilege('authenticated', table, 'MAINTAIN') must be false from 17 on; on 16 the privilege does not exist.
function assertNoMaintain(url,label){
  if(hasMaintain()){
    assert.equal(psqlSync(url,`SELECT string_agg(c.relname,',') FILTER (WHERE has_table_privilege('authenticated',c.oid,'MAINTAIN')) IS NULL AND count(*)=${TABLES.length}
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'pool_platform_%'`),'t',`${label}: authenticated must not hold MAINTAIN`);
  }else{
    const run=psqlRun(url,`SELECT has_table_privilege('authenticated','public.pool_platform_pools','MAINTAIN');`);
    assert.match(run.stderr,/unrecognized privilege type: "MAINTAIN"/,`${label}: PostgreSQL ${pgVersion()} has no MAINTAIN privilege`);
  }
}

// What MAINTAIN (or any write privilege) would allow. authenticated must be refused all of it on every table.
const MAINTENANCE=table=>[
  `LOCK TABLE public.${table} IN ACCESS EXCLUSIVE MODE`,`LOCK TABLE public.${table} IN SHARE MODE`,
  `REINDEX TABLE public.${table}`,`CLUSTER public.${table} USING ${table}_pkey`,`TRUNCATE public.${table}`
];
async function assertMaintenanceDenied(url,label){
  const s=openSession(url,`pp_it_maintenance_${process.pid}`);
  try{
    rowsOf(await s.run('SET ROLE authenticated'));
    for(const table of TABLES){
      for(const sql of MAINTENANCE(table)){
        rowsOf(await s.run('BEGIN'));
        const result=await s.run(sql);
        await s.run('ROLLBACK');
        assert.equal(result.error?.sqlstate,'42501',`${label}: authenticated must not run ${sql}`);
      }
    }
  }finally{await s.close()}
  // VACUUM and ANALYZE skip, with a warning, the tables the caller may not maintain.
  const run=psqlRun(url,`SET ROLE authenticated;\n${TABLES.map(t=>`VACUUM public.${t};\nANALYZE public.${t};`).join('\n')}`);
  for(const table of TABLES){
    assert.ok(run.stderr.includes(`permission denied to vacuum "${table}", skipping it`),`${label}: VACUUM ${table}\n${run.stderr}`);
    assert.ok(run.stderr.includes(`permission denied to analyze "${table}", skipping it`),`${label}: ANALYZE ${table}\n${run.stderr}`);
  }
}

// Runs a validation kit file exactly as shipped (one SELECT) inside a READ ONLY transaction, as the migration
// owner unless role is '' (the superuser from the cluster URL). Returns the rows as objects.
function runKit(url,file,{role=OWNER,before='',transform=sql=>sql}={}){
  const sql=transform(readValidation(file)).trim().replace(/;$/,'');
  return JSON.parse(psqlSync(url,`${role?`SET ROLE ${role};`:''}\n${before}\nBEGIN READ ONLY;\nSELECT json_agg(r) FROM (\n${sql}\n) r;\nROLLBACK;`));
}
const verdictOf=rows=>rows.find(r=>/^[PC]99$/.test(r.check_id));
const failingChecks=rows=>[...new Set(rows.filter(r=>r.required&&r.ok!==true&&!/^[PC]99$/.test(r.check_id)).map(r=>r.check_id))].sort();

const FUNCTION_ACLS_SQL=`SELECT p.proname||'='||string_agg(g.entry,',' ORDER BY g.entry)
    FROM pg_proc p CROSS JOIN LATERAL (
      SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type||CASE WHEN a.is_grantable THEN '+grant_option' ELSE '' END AS entry
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    ) g
    WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'pool_platform_%' GROUP BY p.proname`;

// Every commercial function (full definition, owner and ACL), table (ACL and RLS) and policy, to show that a
// migration left everything else exactly as it was.
const CATALOG_SNAPSHOT_SQL=`SELECT json_build_object(
  'functions',(SELECT json_object_agg(p.oid::regprocedure::text,json_build_object('def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text))
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'pool_platform_%'),
  'tables',(SELECT json_object_agg(c.relname,json_build_object('acl',c.relacl::text,'rls',c.relrowsecurity))
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'pool_platform_%'),
  'policies',(SELECT json_agg(p ORDER BY p.tablename,p.policyname) FROM pg_policies p WHERE p.schemaname='public'))`;

// One long-lived psql backend driven over stdin; run() resolves with the rows of one command and its
// SQLSTATE/message once psql echoes a unique marker, so several sessions can hold open transactions at once.
function openSession(url,name){
  const child=spawn('psql',[url,'-X','-q','-A','-t','-v','ON_ERROR_STOP=0'],{
    stdio:['pipe','pipe','pipe'],env:{...process.env,PGAPPNAME:name}
  });
  let out='',err='',exited=false,seq=0,waiters=[];
  const wake=()=>{for(const w of [...waiters])w()};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',d=>{out+=d;wake()});
  child.stderr.on('data',d=>{err+=d});
  child.on('close',()=>{exited=true;wake()});
  const run=sql=>{
    const id=`__pp_${name}_${++seq}__`;
    const text=/(;|\\g[^\n]*)\s*$/.test(sql.trim())?sql.trim():`${sql.trim()};`;
    child.stdin.write(`${text}\n\\echo ${id} :ERROR :SQLSTATE\n\\echo :LAST_ERROR_MESSAGE\n\\echo ${id}_END\n`);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waiters=waiters.filter(w=>w!==check);reject(new Error(`${name}: no reply to ${text}\n${err}`))},20000);
      function check(){
        const end=out.indexOf(`${id}_END\n`);
        if(end<0){if(exited){clearTimeout(timer);reject(new Error(`${name} exited\n${err}`))}return}
        clearTimeout(timer);waiters=waiters.filter(w=>w!==check);
        const start=out.indexOf(`${id} `),lineEnd=out.indexOf('\n',start);
        const rows=out.slice(0,start).split('\n').filter(Boolean);
        const [flag,sqlstate]=out.slice(start+id.length+1,lineEnd).split(' ');
        const message=out.slice(lineEnd+1,end).trim();
        out=out.slice(end+id.length+5);
        resolve({rows,error:flag==='true'?{sqlstate,message}:null});
      }
      waiters.push(check);check();
    });
  };
  const close=()=>new Promise(resolve=>{
    if(exited)return resolve();
    const kill=setTimeout(()=>child.kill('SIGTERM'),5000);
    child.on('close',()=>{clearTimeout(kill);resolve()});
    child.stdin.end('\\q\n');
  });
  return{name,run,close};
}

const rowsOf=result=>{assert.equal(result.error,null,JSON.stringify(result.error));return result.rows};
const jsonOf=result=>JSON.parse(rowsOf(result)[0]);
const failsWith=(result,message)=>{
  assert.ok(result.error,`expected ${message} but the call succeeded: ${result.rows}`);
  assert.equal(result.error.message,message);
};
const lit=value=>`$j$${typeof value==='string'?value:JSON.stringify(value)}$j$::jsonb`;
const uuid=(prefix,n)=>`${prefix}-0000-4000-8000-${String(n).padStart(12,'0')}`;

const U={
  commish:uuid('00000000',0xc1),rival:uuid('00000000',0xc2),p1:uuid('00000000',0xa1),p2:uuid('00000000',0xa2),
  p3:uuid('00000000',0xa3),wrong:uuid('00000000',0xa4),pending:uuid('00000000',0xb1),drifter:uuid('00000000',0xb2),
  racer1:uuid('00000000',0xd1),racer2:uuid('00000000',0xd2),racer3:uuid('00000000',0xd3),racer4:uuid('00000000',0xd4),
  victim:uuid('00000000',0xe1),squatter:uuid('00000000',0xe2),linked:uuid('00000000',0xe3),banned:uuid('00000000',0xe4),
  raced:uuid('00000000',0xf1),straddled:uuid('00000000',0xf2)
};
const UNVERIFIED=new Set(['pending','drifter','racer4','victim','squatter','raced','straddled']);
const T1=uuid('10000000',1),T2=uuid('10000000',2);
const SURV=uuid('20000000',1),PICK=uuid('20000000',2),RIVAL=uuid('20000000',3);
const S_SURV=uuid('30000000',1),S_PICK=uuid('30000000',2),S_RIVAL=uuid('30000000',3);
const W3=uuid('40000000',3),W4=uuid('40000000',4),W5_LOCKED=uuid('40000000',5),W6_PAST=uuid('40000000',6);
const W7_TYPED=uuid('40000000',7),W8_TYPED=uuid('40000000',8);
const K1=uuid('41000000',1),K2=uuid('41000000',2),R1=uuid('42000000',1);
// Well-formed UUIDs that name no week and no entry.
const W_MISSING=uuid('49000000',1),E_MISSING=uuid('59000000',1);
const ENTRY_DEFS=[
  ['OOO','p1'],['RACE','p1'],['B1','p1'],['B2','p2'],['C','p1'],['D','p1'],['D2','p1'],['IDX','p1'],['MAP','p1'],
  ['AUTH','p1'],['INACTIVE','p1','inactive'],['ELIMINATED','p1','eliminated'],['ARCHIVED','p1','archived'],
  ['ACTIVE','p1'],['BATCH','p1'],['LOCK','p1'],['INV1',null],['INV2',null],['INV3',null],['INV4',null],
  ['RINV1',null],['RINV2',null],['RINV3',null],['TYPED','p1'],['TYPED_BATCH','p1'],['TYPED_RR','p1'],['TYPED_RR2','p1'],
  ['PRE_BOUND',null],['PRE_BEARER',null],['ID_BOUND',null],['ID_BEARER',null],['RACE_A_BOUND',null],['RACE_B_BOUND',null]
];
const E=Object.fromEntries(ENTRY_DEFS.map(([code],i)=>[code,uuid('50000000',i+1)]));
const K_P2=uuid('51000000',1),K_RIVAL=uuid('51000000',2);
const SURVIVOR_GAMES=[{id:'g1',away:{key:'austin'},home:{key:'denver'}},{id:'g2',away:{key:'phoenix'},home:{key:'seattle'}}];
const PICKEM_CONFIG={tiebreakRequired:true,games:[{id:'g1'},{id:'g2'}]};
// Configured keys equal to what ->> renders for non-string JSON teams (123, true, ["austin"], {"k": "v"}, ...),
// so a non-string pick can only be rejected by its JSON type, not by a key mismatch.
const TYPED_GAMES=[{id:'t1',away:{key:'123'},home:{key:'true'}},{id:'t2',away:{key:'["austin"]'},home:{key:'{"k": "v"}'}},{id:'t3',away:{key:'false'},home:{key:'1.5'}}];
const INTERNAL_FUNCTIONS=['pool_platform_current_user_email','pool_platform_current_user_has_verified_email','pool_platform_payload_valid','pool_platform_guard_submission_source'];
const AUTHENTICATED_FUNCTIONS=['pool_platform_current_user_id','pool_platform_is_tenant_commissioner','pool_platform_can_read_pool','pool_platform_can_read_season','pool_platform_create_entry_invite','pool_platform_claim_entry_invite','pool_platform_submit_entry','pool_platform_submit_batch','pool_platform_participant_context','pool_platform_commissioner_context'];
// Exact grantee:privilege list per function: the owner alone for internal helpers, plus a plain (no grant
// option) authenticated EXECUTE for the RLS helpers and RPCs. Nothing for PUBLIC or anonymous.
const EXPECTED_FUNCTION_ACLS=Object.fromEntries([
  ...INTERNAL_FUNCTIONS.map(name=>[name,`${OWNER}:EXECUTE`]),
  ...AUTHENTICATED_FUNCTIONS.map(name=>[name,`authenticated:EXECUTE,${OWNER}:EXECUTE`])
]);

const STUB=`
CREATE SCHEMA neon_auth;
CREATE TABLE neon_auth."user" (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  "emailVerified" boolean NOT NULL,
  image text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  role text,
  banned boolean,
  "banReason" text,
  "banExpires" timestamptz,
  CONSTRAINT user_email_key UNIQUE (email)
);
CREATE TABLE neon_auth.account (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX "account_userId_idx" ON neon_auth.account("userId");
CREATE TABLE neon_auth.session (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid NOT NULL REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
  "impersonatedBy" text,
  "activeOrganizationId" text,
  CONSTRAINT session_token_key UNIQUE (token)
);
CREATE INDEX "session_userId_idx" ON neon_auth.session("userId");
CREATE SCHEMA auth;
CREATE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('pp_test.user_id', true), '') $$;
CREATE FUNCTION auth.session() RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT COALESCE(NULLIF(current_setting('pp_test.session', true), '')::jsonb, 'null'::jsonb) $$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT USAGE ON SCHEMA neon_auth TO ${OWNER};
GRANT SELECT ON neon_auth."user" TO ${OWNER};
GRANT SELECT ON neon_auth.account TO ${OWNER};
GRANT SELECT ON neon_auth.session TO ${OWNER};
`;

function seedSql(){
  const users=Object.entries(U).map(([key,id])=>`('${id}','${key}','${key}@example.test',${!UNVERIFIED.has(key)})`).join(',\n');
  const week=(id,season,n,status,deadline,config)=>`('${id}','${season}',${n},'${status}',${deadline},${lit(config)})`;
  const entries=ENTRY_DEFS.map(([code,owner,status='active'])=>
    `('${E[code]}','${S_SURV}','${code}','Entry ${code}',${owner?`'${U[owner]}'`:'NULL'},'${status}')`).join(',\n');
  return `
INSERT INTO neon_auth."user"(id,name,email,"emailVerified") VALUES
${users};
-- victim, squatter, raced and straddled carry the password a pre-registration attaches; linked signed in with Google once.
INSERT INTO neon_auth.account("accountId","providerId","userId",password,"updatedAt") VALUES
('${U.victim}','credential','${U.victim}','pp-it-password-hash',now()),
('${U.squatter}','credential','${U.squatter}','pp-it-password-hash',now()),
('${U.raced}','credential','${U.raced}','pp-it-password-hash',now()),
('${U.straddled}','credential','${U.straddled}','pp-it-password-hash',now()),
('pp-it-google-subject','google','${U.linked}',NULL,now());
UPDATE neon_auth."user" SET banned=true WHERE id='${U.banned}';
INSERT INTO public.pool_platform_tenants(id,slug,display_name) VALUES ('${T1}','it-group','IT Group'),('${T2}','it-rival','IT Rival');
INSERT INTO public.pool_platform_memberships(tenant_id,auth_user_id,role) VALUES ('${T1}','${U.commish}','owner'),('${T2}','${U.rival}','owner');
INSERT INTO public.pool_platform_pools(id,tenant_id,slug,display_name,pool_type) VALUES
('${SURV}','${T1}','it-survivor','IT Survivor','survivor'),('${PICK}','${T1}','it-pickem','IT Pickem','pickem'),
('${RIVAL}','${T2}','it-rival-survivor','IT Rival Survivor','survivor');
INSERT INTO public.pool_platform_seasons(id,pool_id,season,status) VALUES
('${S_SURV}','${SURV}',2027,'active'),('${S_PICK}','${PICK}',2027,'active'),('${S_RIVAL}','${RIVAL}',2027,'active');
INSERT INTO public.pool_platform_weeks(id,season_id,week,status,deadline_at,config) VALUES
${week(W3,S_SURV,3,'open',"now()+interval '2 days'",{games:SURVIVOR_GAMES})},
${week(W4,S_SURV,4,'open',"now()+interval '9 days'",{games:SURVIVOR_GAMES})},
${week(W5_LOCKED,S_SURV,5,'locked',"now()+interval '16 days'",{games:SURVIVOR_GAMES})},
${week(W6_PAST,S_SURV,6,'open',"now()-interval '1 hour'",{games:SURVIVOR_GAMES})},
${week(W7_TYPED,S_SURV,7,'open',"now()+interval '23 days'",{games:TYPED_GAMES})},
${week(W8_TYPED,S_SURV,8,'open',"now()+interval '30 days'",{games:TYPED_GAMES})},
${week(K1,S_PICK,1,'open',"now()+interval '2 days'",PICKEM_CONFIG)},
${week(K2,S_PICK,2,'open',"now()+interval '9 days'",PICKEM_CONFIG)},
${week(R1,S_RIVAL,1,'open',"now()+interval '2 days'",{games:SURVIVOR_GAMES})};
INSERT INTO public.pool_platform_entries(id,season_id,entry_code,display_name,owner_auth_user_id,status) VALUES
${entries};
INSERT INTO public.pool_platform_entries(id,season_id,entry_code,display_name,owner_auth_user_id) VALUES
('${K_P2}','${S_PICK}','K01','Pickem 01','${U.p2}'),('${K_RIVAL}','${S_RIVAL}','R01','Rival 01',NULL);
`;
}

describe('commercial migrations on a throwaway local PostgreSQL (opt-in)',{skip:SKIP},()=>{
  let admin;
  const open=[];
  const session=name=>{const s=openSession(dbUrl(),`pp_it_${name}`);open.push(s);return s};
  // A Neon Auth JWT carries the user's emailVerified as it was when the JWT was minted, and auth.session() returns its
  // claims. actor() mints one from the user's row as it stands now; actorWith() takes the user id and claims as given
  // (null: not set), for JWTs minted earlier and for missing or malformed claims. Either session keeps its JWT.
  const mint=async userKey=>rowsOf(await admin.run(`SELECT json_build_object('sub',id::text,'email',email,'emailVerified',"emailVerified",'role','authenticated')::text FROM neon_auth."user" WHERE id='${U[userKey]}'`))[0];
  const actorWith=async(name,userId,claims,role='authenticated')=>{
    const s=session(name);
    rowsOf(await s.run(`SET ROLE ${role}`));
    if(userId!==null)rowsOf(await s.run(`SELECT set_config('pp_test.user_id','${userId}',false)`));
    if(claims!==null)rowsOf(await s.run(`SELECT set_config('pp_test.session',$claims$${claims}$claims$,false)`));
    return s;
  };
  const actor=async(name,userKey)=>actorWith(name,U[userKey],await mint(userKey));
  const submit=(s,week,entry,source,payload)=>
    s.run(`SELECT public.pool_platform_submit_entry('${week}','${entry}',${source===null?'NULL':`'${source}'`},${lit(payload)})`);
  const waitForLockWait=async s=>{
    for(let i=0;i<200;i++){
      const [n]=rowsOf(await admin.run(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${s.name}' AND wait_event_type='Lock'`));
      if(n==='1')return;
      await new Promise(r=>setTimeout(r,25));
    }
    assert.fail(`${s.name} never waited on a lock`);
  };
  const scalar=async sql=>rowsOf(await admin.run(sql))[0];
  const teams=async entry=>rowsOf(await admin.run(
    `SELECT w.week||':'||s.source||':'||(s.payload->>'team') FROM public.pool_platform_submissions s JOIN public.pool_platform_weeks w ON w.id=s.week_id WHERE s.entry_id='${entry}' ORDER BY w.week`));
  const functionAcls=async()=>Object.fromEntries(rowsOf(await admin.run(FUNCTION_ACLS_SQL)).map(r=>r.split('=')));
  let neonAuthAclBefore;

  before(()=>{
    assertLocalCluster();
    ensureRoles();
    psqlSync(CLUSTER,`CREATE DATABASE ${DB_NAME} OWNER ${OWNER};`);
    psqlSync(dbUrl(),STUB);
    neonAuthAclBefore=privilegeState(dbUrl()).neonAuthAcl;
    // Hostile defaults, as a Data API environment might configure them: the migrations must still end with
    // the intended privilege matrix. On PostgreSQL 17, ALL on tables includes MAINTAIN.
    psqlSync(dbUrl(),`ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anonymous,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT ALL ON TABLES TO anonymous,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT ALL ON SEQUENCES TO anonymous,authenticated;`);
    psqlSync(dbUrl(),`SET ROLE ${OWNER};\n${readMigration('001_foundation.sql')}\n${readMigration('002_identity_submission_rls.sql')}`);
    psqlSync(dbUrl(),seedSql());
    admin=openSession(dbUrl(),'pp_it_admin');
  });

  afterEach(async()=>{await Promise.all(open.splice(0).map(s=>s.close()))});

  after(async()=>{
    await Promise.all([...open.splice(0),...(admin?[admin]:[])].map(s=>s.close()));
    psqlSync(CLUSTER,`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`);
  });

  test('catalog: tables with RLS, source trigger, unique indexes, SECURITY DEFINER functions with fixed search_path',async()=>{
    const tables=rowsOf(await admin.run(`SELECT relname||':'||relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname LIKE 'pool_platform_%' ORDER BY 1`));
    assert.equal(tables.length,9);
    for(const row of tables)assert.match(row,/:true$/,`RLS must be enabled: ${row}`);
    assert.equal(await scalar(`SELECT count(*) FROM pg_trigger WHERE tgname='pool_platform_submission_source_guard' AND tgrelid='public.pool_platform_submissions'::regclass`),'1');
    const indexes=rowsOf(await admin.run(`SELECT indexrelid::regclass||' '||pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid IN ('public.pool_platform_submissions'::regclass,'public.pool_platform_pools'::regclass) AND indisunique ORDER BY 1`)).join('\n');
    assert.match(indexes,/pool_platform_submissions_week_id_entry_id_key .*\(week_id, entry_id\)/);
    assert.match(indexes,/pool_platform_pool_slug_global_unique .*\(slug\)/);
    assert.match(indexes,/pool_platform_submissions_survivor_team_unique CREATE UNIQUE INDEX .* ON public\.pool_platform_submissions USING btree \(entry_id, \(\(payload ->> 'team'::text\)\)\) WHERE \(jsonb_typeof\(\(payload -> 'team'::text\)\) = 'string'::text\)/);
    const functions=rowsOf(await admin.run(`SELECT proname||':'||prosecdef||':'||array_to_string(proconfig,',')||':'||pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'pool_platform_%' AND proname<>'pool_platform_guard_submission_source' ORDER BY 1`));
    assert.equal(functions.length,13);
    for(const row of functions)assert.match(row,new RegExp(`:true:search_path=(pg_catalog, )?public, neon_auth, pg_temp:${OWNER}$`),row);
  });

  test('grants: anonymous has nothing; authenticated has SELECT-only tables and EXECUTE on the intended functions only',async()=>{
    // The hostile defaults granted ALL on tables and sequences (MAINTAIN included on PostgreSQL 17); only
    // authenticated SELECT (no grant option) may remain, on every table, for every privilege the server knows.
    const defaults=Object.fromEntries(rowsOf(await admin.run(`SELECT d.defaclobjtype::text||'='||string_agg(DISTINCT a.privilege_type,',' ORDER BY a.privilege_type)
      FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE a.grantee='authenticated'::regrole GROUP BY d.defaclobjtype`)).map(r=>r.split('=')));
    assert.equal(defaults.r,tablePrivileges().join(','),'setup: authenticated is defaulted ALL table privileges');
    assert.equal(defaults.S,'SELECT,UPDATE,USAGE','setup: authenticated is defaulted ALL sequence privileges');
    assertPrivilegeContract(privilegeState(dbUrl()),'hostile defaults');
    assertNoMaintain(dbUrl(),'hostile defaults');
    assert.equal(privilegeState(dbUrl()).neonAuthAcl,neonAuthAclBefore,'002 must not change privileges on neon_auth."user"');
    const fnRights=Object.fromEntries(rowsOf(await admin.run(`SELECT p.proname||'='||has_function_privilege('authenticated',p.oid,'EXECUTE')||','||has_function_privilege('anonymous',p.oid,'EXECUTE')||','||has_function_privilege('public',p.oid,'EXECUTE') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'pool_platform_%'`)).map(r=>r.split('=')));
    for(const internal of INTERNAL_FUNCTIONS)assert.equal(fnRights[internal],'false,false,false',internal);
    for(const rpc of AUTHENTICATED_FUNCTIONS)assert.equal(fnRights[rpc],'true,false,false',rpc);
    assert.deepEqual(await functionAcls(),EXPECTED_FUNCTION_ACLS,'default privileges granted every function to anonymous and authenticated; the migration must leave only this');
    assert.equal(await scalar(`SELECT has_schema_privilege('authenticated','public','CREATE')::text||has_schema_privilege('anonymous','public','CREATE')::text`),'falsefalse');
  });

  test('grants: re-applying 002 strips hostile pre-existing table, column, sequence and function grants, grant options and re-grants included',async()=>{
    const fns=rowsOf(await admin.run(`SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'pool_platform_%' ORDER BY 1`));
    assert.equal(fns.length,14);
    psqlSync(dbUrl(),[
      ...fns.map(f=>`GRANT EXECUTE ON FUNCTION ${f} TO PUBLIC,anonymous;\nGRANT EXECUTE ON FUNCTION ${f} TO authenticated WITH GRANT OPTION;`),
      ...TABLES.map(t=>`GRANT ALL ON public.${t} TO PUBLIC,anonymous;\nGRANT ALL ON public.${t} TO authenticated WITH GRANT OPTION;`),
      'GRANT UPDATE (status) ON public.pool_platform_entries TO authenticated;',
      `GRANT ALL ON SEQUENCE public.${AUDIT_SEQUENCE} TO PUBLIC;\nGRANT ALL ON SEQUENCE public.${AUDIT_SEQUENCE} TO authenticated WITH GRANT OPTION;`,
      'SET ROLE authenticated;',
      ...fns.map(f=>`GRANT EXECUTE ON FUNCTION ${f} TO anonymous;`),
      ...TABLES.map(t=>`GRANT SELECT,INSERT${hasMaintain()?',MAINTAIN':''} ON public.${t} TO anonymous;`),
      `GRANT USAGE ON SEQUENCE public.${AUDIT_SEQUENCE} TO anonymous;`
    ].join('\n'));
    const hostile=await functionAcls();
    for(const name of INTERNAL_FUNCTIONS){
      for(const grant of ['PUBLIC:EXECUTE','anonymous:EXECUTE','authenticated:EXECUTE+grant_option'])assert.ok(hostile[name].split(',').includes(grant),`${name} setup: ${hostile[name]}`);
    }
    const hostileTables=privilegeState(dbUrl());
    for(const table of TABLES){
      assert.deepEqual(hostileTables.rights[`anonymous ${table}`],tablePrivileges(),`setup: anonymous holds everything on ${table}`);
      assert.ok(hostileTables.acl[table].includes(`authenticated:SELECT+grant_option by ${OWNER}`),`setup: ${table} grant option`);
      assert.ok(hostileTables.acl[table].includes(`anonymous:SELECT by authenticated`),`setup: ${table} re-granted by authenticated`);
    }
    const p1=await actor('hostile_p1','p1');
    assert.equal(rowsOf(await p1.run(`SELECT public.pool_platform_payload_valid('survivor','{}'::jsonb,NULL,NULL,'{}'::jsonb)`))[0],'f','setup: the hostile grant really makes the helper callable');
    rowsOf(await p1.run('BEGIN'));
    rowsOf(await p1.run('LOCK TABLE public.pool_platform_submissions IN ACCESS EXCLUSIVE MODE'));
    await p1.run('ROLLBACK');
    await p1.close();
    if(hasMaintain()){
      // On 17 the MAINTAIN grant alone lets authenticated vacuum the table (PostgreSQL 16 would skip it).
      const vacuum=psqlRun(dbUrl(),'SET ROLE authenticated;\nVACUUM public.pool_platform_weeks;');
      assert.equal(vacuum.status,0,vacuum.stderr);
      assert.doesNotMatch(vacuum.stderr,/skipping it/,'setup: MAINTAIN really lets authenticated vacuum');
    }
    psqlSync(dbUrl(),`SET ROLE ${OWNER};\n${readMigration('002_identity_submission_rls.sql')}`);
    assertPrivilegeContract(privilegeState(dbUrl()),'re-applied 002');
    assertNoMaintain(dbUrl(),'re-applied 002');
    assert.deepEqual(await functionAcls(),EXPECTED_FUNCTION_ACLS);
    const again=await actor('hostile_again','p1'),anon=session('hostile_anon');
    rowsOf(await anon.run('SET ROLE anonymous'));
    for(const s of [again,anon]){
      for(const sql of [
        `SELECT public.pool_platform_payload_valid('survivor','{}'::jsonb,NULL,NULL,'{}'::jsonb)`,
        `SELECT public.pool_platform_current_user_email()`,
        `SELECT public.pool_platform_current_user_has_verified_email('p1@example.test')`
      ])assert.equal((await s.run(sql)).error?.sqlstate,'42501',`${s.name}: ${sql}`);
    }
    assert.equal((await anon.run(`SELECT public.pool_platform_participant_context('it-survivor')`)).error?.sqlstate,'42501');
  });

  test('MAINTAIN-class operations: authenticated cannot LOCK, REINDEX, CLUSTER, TRUNCATE, VACUUM or ANALYZE a commercial table',async()=>{
    await assertMaintenanceDenied(dbUrl(),'seeded database');
    assert.equal(await scalar(`SELECT count(*)>0 FROM public.pool_platform_entries`),'t','the denied TRUNCATEs left the data in place');
  });

  test('RLS: reads are scoped to the caller; no direct writes; anonymous is denied',async()=>{
    const p1=await actor('rls_p1','p1'),p2=await actor('rls_p2','p2'),commish=await actor('rls_commish','commish'),rival=await actor('rls_rival','rival');
    const count=async s=>rowsOf(await s.run('SELECT count(*) FROM public.pool_platform_entries'))[0];
    assert.equal(await count(p1),String(ENTRY_DEFS.filter(d=>d[1]==='p1').length));
    assert.equal(await count(p2),'2');
    assert.equal(await count(commish),String(ENTRY_DEFS.length+1));
    assert.equal(await count(rival),'1');
    for(const sql of [
      `INSERT INTO public.pool_platform_submissions(week_id,entry_id,source,payload) VALUES ('${W3}','${E.OOO}','participant','{"team":"austin"}')`,
      `UPDATE public.pool_platform_entries SET status='active' WHERE id='${E.INACTIVE}'`,
      `DELETE FROM public.pool_platform_submissions`,
      `SELECT public.pool_platform_payload_valid('survivor','{}'::jsonb,NULL,NULL,'{}'::jsonb)`,
      `SELECT public.pool_platform_current_user_has_verified_email('p1@example.test')`
    ]){
      const result=await p1.run(sql);
      assert.equal(result.error?.sqlstate,'42501',`${sql} must be denied`);
    }
    const anon=session('rls_anon');
    rowsOf(await anon.run('SET ROLE anonymous'));
    assert.equal((await anon.run('SELECT count(*) FROM public.pool_platform_pools')).error?.sqlstate,'42501');
    assert.equal((await anon.run(`SELECT public.pool_platform_participant_context('it-survivor')`)).error?.sqlstate,'42501');
  });

  test('Survivor: out-of-order reuse is rejected; same-row edits and unused teams stay allowed',async()=>{
    const p1=await actor('ooo','p1');
    assert.equal(jsonOf(await submit(p1,W4,E.OOO,'participant',{team:'austin'})).code,'created');
    failsWith(await submit(p1,W3,E.OOO,'participant',{team:'austin'}),'team_already_used');
    assert.equal(jsonOf(await submit(p1,W4,E.OOO,'participant',{team:'austin'})).revision,2,'same row may keep its team');
    assert.equal(jsonOf(await submit(p1,W3,E.OOO,'participant',{team:'denver'})).code,'created');
    failsWith(await submit(p1,W4,E.OOO,'participant',{team:'denver'}),'team_already_used');
    assert.equal(jsonOf(await submit(p1,W4,E.OOO,'participant',{team:'seattle'})).revision,3,'same row may switch to an unused team');
    assert.equal(jsonOf(await submit(p1,W3,E.OOO,'participant',{team:'austin'})).revision,2,'a team freed by an edit becomes available');
    assert.deepEqual(await teams(E.OOO),['3:participant:austin','4:participant:seattle']);
    const context=jsonOf(await p1.run(`SELECT public.pool_platform_participant_context('it-survivor',2027,3)`));
    const entry=context.entries.find(e=>e.id===E.OOO);
    assert.equal(entry.submission.payload.team,'austin');
    assert.deepEqual(entry.history.map(h=>`${h.week}:${h.payload.team}`),['4:seattle'],'the browser sees later-week picks as used too');
    assert.equal(context.entries.some(e=>[E.INACTIVE,E.ELIMINATED,E.ARCHIVED].includes(e.id)),false);
  });

  test('Survivor A: concurrent Week 3 / Week 4 picks of one team for one entry — exactly one commits',async()=>{
    const a=await actor('race_a','p1'),b=await actor('race_b','p1');
    rowsOf(await a.run('BEGIN'));rowsOf(await b.run('BEGIN'));
    assert.equal(jsonOf(await submit(a,W3,E.RACE,'participant',{team:'phoenix'})).code,'created');
    const pending=submit(b,W4,E.RACE,'participant',{team:'phoenix'});
    await waitForLockWait(b);
    rowsOf(await a.run('COMMIT'));
    failsWith(await pending,'team_already_used');
    await b.run('ROLLBACK');
    assert.deepEqual(await teams(E.RACE),['3:participant:phoenix']);
  });

  test('Survivor: the unique index alone rejects a concurrent duplicate written around submit_entry',async()=>{
    const a=session('idx_a'),b=session('idx_b');
    const insert=(s,week)=>s.run(`INSERT INTO public.pool_platform_submissions(week_id,entry_id,source,payload) VALUES ('${week}','${E.IDX}','commissioner_manual','{"team":"denver"}')`);
    rowsOf(await a.run('BEGIN'));rowsOf(await b.run('BEGIN'));
    rowsOf(await insert(a,W3));
    const pending=insert(b,W4);
    await waitForLockWait(b);
    rowsOf(await a.run('COMMIT'));
    const result=await pending;
    assert.equal(result.error?.sqlstate,'23505');
    assert.match(result.error.message,/pool_platform_submissions_survivor_team_unique/);
    await b.run('ROLLBACK');
    assert.deepEqual(await teams(E.IDX),['3:commissioner_manual:denver']);
  });

  test('Survivor: a unique-index violation inside submit_entry is reported as team_already_used',async()=>{
    const writer=session('map_writer'),p1=await actor('map_p1','p1');
    rowsOf(await writer.run('BEGIN'));
    rowsOf(await writer.run(`INSERT INTO public.pool_platform_submissions(week_id,entry_id,source,payload) VALUES ('${W4}','${E.MAP}','participant','{"team":"seattle"}')`));
    const pending=submit(p1,W3,E.MAP,'participant',{team:'seattle'});
    await waitForLockWait(p1);
    rowsOf(await writer.run('COMMIT'));
    const result=await pending;
    assert.equal(result.error?.sqlstate,'P0001');
    failsWith(result,'team_already_used');
    assert.deepEqual(await teams(E.MAP),['4:participant:seattle']);
  });

  test('Survivor B: different entries may use the same team concurrently',async()=>{
    const a=await actor('diff_a','p1'),b=await actor('diff_b','p2');
    rowsOf(await a.run('BEGIN'));rowsOf(await b.run('BEGIN'));
    assert.equal(jsonOf(await submit(a,W3,E.B1,'participant',{team:'austin'})).code,'created');
    assert.equal(jsonOf(await submit(b,W3,E.B2,'participant',{team:'austin'})).code,'created');
    rowsOf(await a.run('COMMIT'));rowsOf(await b.run('COMMIT'));
    assert.deepEqual([...await teams(E.B1),...await teams(E.B2)],['3:participant:austin','3:participant:austin']);
  });

  test('Survivor C: one entry may use different teams in different weeks concurrently',async()=>{
    const a=await actor('teams_a','p1'),b=await actor('teams_b','p1');
    rowsOf(await a.run('BEGIN'));rowsOf(await b.run('BEGIN'));
    assert.equal(jsonOf(await submit(a,W3,E.C,'participant',{team:'austin'})).code,'created');
    const pending=submit(b,W4,E.C,'participant',{team:'denver'});
    await waitForLockWait(b);
    rowsOf(await a.run('COMMIT'));
    assert.equal(jsonOf(await pending).code,'created');
    rowsOf(await b.run('COMMIT'));
    assert.deepEqual(await teams(E.C),['3:participant:austin','4:participant:denver']);
  });

  test('Source lock D: participant vs commissioner on one entry/week — exactly one source claims the row',async()=>{
    const p1=await actor('d_p1','p1'),commish=await actor('d_commish','commish');
    rowsOf(await p1.run('BEGIN'));rowsOf(await commish.run('BEGIN'));
    assert.equal(jsonOf(await submit(p1,W3,E.D,'participant',{team:'seattle'})).code,'created');
    const pending=submit(commish,W3,E.D,'commissioner_import',{team:'phoenix'});
    await waitForLockWait(commish);
    rowsOf(await p1.run('COMMIT'));
    failsWith(await pending,'source_conflict:participant');
    await commish.run('ROLLBACK');
    assert.deepEqual(await teams(E.D),['3:participant:seattle']);

    rowsOf(await commish.run('BEGIN'));rowsOf(await p1.run('BEGIN'));
    assert.equal(jsonOf(await submit(commish,W3,E.D2,'commissioner_import',{team:'phoenix'})).code,'created');
    const reverse=submit(p1,W3,E.D2,'participant',{team:'seattle'});
    await waitForLockWait(p1);
    rowsOf(await commish.run('COMMIT'));
    failsWith(await reverse,'source_conflict:commissioner_import');
    await p1.run('ROLLBACK');
    assert.deepEqual(await teams(E.D2),['3:commissioner_import:phoenix']);
  });

  test('Source lock regressions: batch conflicts, same-source revisions, deadline, closed week, locked row, immutable source',async()=>{
    const commish=await actor('lock_commish','commish'),p1=await actor('lock_p1','p1');
    const batch=async items=>jsonOf(await commish.run(`SELECT public.pool_platform_submit_batch('${W4}','commissioner_import',${lit(items)})`));
    assert.equal(jsonOf(await submit(p1,W4,E.D,'participant',{team:'austin'})).code,'created');
    const first=await batch([{entry_id:E.D,payload:{team:'denver'}},{entry_id:E.BATCH,payload:{team:'denver'}}]);
    assert.deepEqual(first.map(r=>r.ok?r.result.code:r.code),['source_conflict:participant','created']);
    const second=await batch([{entry_id:E.BATCH,payload:{team:'seattle'}}]);
    assert.equal(second[0].result.revision,2);
    failsWith(await submit(p1,W6_PAST,E.LOCK,'participant',{team:'austin'}),'deadline_passed');
    failsWith(await submit(p1,W5_LOCKED,E.LOCK,'participant',{team:'austin'}),'week_not_open');
    assert.equal(jsonOf(await submit(p1,W3,E.LOCK,'participant',{team:'phoenix'})).code,'created');
    rowsOf(await admin.run(`UPDATE public.pool_platform_submissions SET status='locked' WHERE entry_id='${E.LOCK}'`));
    failsWith(await submit(p1,W3,E.LOCK,'participant',{team:'seattle'}),'submission_locked');
    const moved=await admin.run(`UPDATE public.pool_platform_submissions SET source='commissioner_manual' WHERE entry_id='${E.BATCH}'`);
    assert.equal(moved.error?.message,'submission source is immutable once claimed');
    const audit=rowsOf(await admin.run(`SELECT a.action||':'||COALESCE(a.previous_payload->>'team','-')||'>'||(a.next_payload->>'team') FROM public.pool_platform_submission_audit a JOIN public.pool_platform_submissions s ON s.id=a.submission_id WHERE s.entry_id='${E.BATCH}' ORDER BY a.id`));
    assert.deepEqual(audit,['created:->denver','updated:denver>seattle']);
  });

  test('authorization precedes validation: unauthorized callers only ever see the authorization failure',async()=>{
    const p1=await actor('auth_p1','p1'),p2=await actor('auth_p2','p2'),rival=await actor('auth_rival','rival');
    assert.equal(jsonOf(await submit(p1,W3,E.AUTH,'participant',{team:'austin'})).code,'created');
    const probes=[
      [W4,E.AUTH,{team:'austin'}],[W4,E.AUTH,{team:'denver'}],[W4,E.AUTH,{team:'houston'}],[W4,E.AUTH,'[1,2]'],
      [W4,E.AUTH,{team:'austin',note:'x'}],[W6_PAST,E.AUTH,{team:'denver'}],[W5_LOCKED,E.AUTH,{team:'denver'}],
      [W4,E.INACTIVE,{team:'denver'}],[W4,E.ELIMINATED,{team:'austin'}]
    ];
    for(const [week,entry,payload] of probes){
      failsWith(await submit(p2,week,entry,'participant',payload),'entry_not_owned');
      failsWith(await submit(p2,week,entry,'commissioner_import',payload),'commissioner_required');
      failsWith(await submit(rival,week,entry,'commissioner_manual',payload),'commissioner_required');
    }
    failsWith(await rival.run(`SELECT public.pool_platform_submit_batch('${W4}','commissioner_import',${lit([{entry_id:E.AUTH,payload:{team:'austin'}}])})`),'commissioner_required');
    failsWith(await submit(p1,R1,E.AUTH,'participant',{team:'austin'}),'invalid_entry_week');
    failsWith(await submit(p1,W4,E.AUTH,'participant',{team:'austin'}),'team_already_used');
    failsWith(await submit(p1,W4,E.AUTH,'participant',{team:'houston'}),'invalid_payload');
    failsWith(await submit(p1,W4,E.AUTH,'participant','[1,2]'),'invalid_payload');
    failsWith(await submit(p1,W4,E.AUTH,null,{team:'denver'}),'invalid_source');
    assert.deepEqual(await teams(E.AUTH),['3:participant:austin']);
  });

  // Whether a week belongs to an entry's season, and whether an entry exists at all, is told only to the entry
  // owner (participant source) or a commissioner of the entry's tenant (commissioner sources).
  test('authorization precedes the entry/week match: unauthorized callers get the same failure for the matching, an unrelated or a missing week',async()=>{
    const callers={};
    for(const [key,user] of [['p1','p1'],['p2','p2'],['commish','commish'],['rival','rival'],['outsider','wrong']])callers[key]=await actor(`match_${key}`,user);
    assert.equal(await scalar(`SELECT (SELECT count(*) FROM public.pool_platform_weeks WHERE id='${W_MISSING}')+(SELECT count(*) FROM public.pool_platform_entries WHERE id='${E_MISSING}')`),'0');
    const writes=()=>scalar(`SELECT (SELECT count(*) FROM public.pool_platform_submissions)||'/'||(SELECT count(*) FROM public.pool_platform_submission_audit)`);
    const before=await writes();
    const probe=async(key,week,entry,source)=>{
      const r=await submit(callers[key],week,entry,source,{team:'denver'});
      assert.ok(r.error,`${key} ${source} ${week}/${entry} succeeded`);
      return `${r.error.sqlstate} ${r.error.message}`;
    };
    // E.AUTH is p1's entry in the Tenant 1 Survivor season: W4 is its own week, K1 a Tenant 1 week of another
    // season, R1 a Tenant 2 week (the rival commissioner's own), W_MISSING no week at all.
    const weeks={matching:W4,otherSeason:K1,otherTenant:R1,missing:W_MISSING};
    for(const [source,expected,keys] of [
      ['participant','entry_not_owned',['p2','commish','rival','outsider']],
      ['commissioner_import','commissioner_required',['p1','p2','rival','outsider']],
      ['commissioner_manual','commissioner_required',['p1','p2','rival','outsider']]
    ]){
      for(const key of keys){
        for(const [label,week] of Object.entries(weeks)){
          assert.equal(await probe(key,week,E.AUTH,source),`P0001 ${expected}`,`${key} ${source}: another's real entry with the ${label} week`);
        }
        for(const [label,week] of Object.entries(weeks)){
          assert.equal(await probe(key,week,E_MISSING,source),`P0001 ${expected}`,`${key} ${source}: a missing entry with the ${label} week`);
        }
      }
    }
    // Authorized callers still learn that the week is not the entry's: the owner and the Tenant 1 commissioner. A
    // missing entry has no owner and no tenant, so it stays an authorization failure for them too.
    for(const [key,source,denied] of [['p1','participant','entry_not_owned'],['commish','commissioner_import','commissioner_required'],['commish','commissioner_manual','commissioner_required']]){
      for(const [label,week] of Object.entries(weeks)){
        if(label!=='matching')assert.equal(await probe(key,week,E.AUTH,source),'P0001 invalid_entry_week',`${key} ${source}: own entry with the ${label} week`);
        assert.equal(await probe(key,week,E_MISSING,source),`P0001 ${denied}`,`${key} ${source}: a missing entry with the ${label} week`);
      }
    }
    // Batch items go through submit_entry: an entry of another season of the caller's tenant is invalid_entry_week;
    // another tenant's entry and a missing entry are both commissioner_required, whichever of them exists.
    const batch=async(s,week,entries)=>jsonOf(await s.run(`SELECT public.pool_platform_submit_batch('${week}','commissioner_import',${lit(entries.map(entry_id=>({entry_id,payload:{team:'denver'}})))})`))
      .map(r=>r.ok?r.result.code:r.code);
    assert.deepEqual(await batch(callers.commish,W4,[K_P2,K_RIVAL,E_MISSING]),['invalid_entry_week','commissioner_required','commissioner_required']);
    assert.deepEqual(await batch(callers.rival,R1,[E.AUTH,E_MISSING]),['commissioner_required','commissioner_required']);
    assert.equal(await writes(),before,'no probe wrote a submission or an audit row');
    assert.deepEqual(await teams(E.AUTH),['3:participant:austin']);
  });

  test('the entry row is locked before authorization whatever week is asked for: unauthorized probes queue on it alike, then fail alike',async()=>{
    const holder=await actor('lockall_holder','p1');
    rowsOf(await holder.run('BEGIN'));
    assert.equal(jsonOf(await submit(holder,W4,E.AUTH,'participant',{team:'denver'})).code,'created');
    const probes=[
      ['p2','participant',W4,'entry_not_owned'],['p2','participant',R1,'entry_not_owned'],['p2','participant',W_MISSING,'entry_not_owned'],
      ['rival','commissioner_manual',W4,'commissioner_required'],['rival','commissioner_manual',K1,'commissioner_required'],
      ['rival','commissioner_manual',W_MISSING,'commissioner_required']
    ];
    const sessions=[];
    for(const [i,[key]] of probes.entries())sessions.push(await actor(`lockall_${i}`,key));
    const pending=probes.map(([,source,week],i)=>submit(sessions[i],week,E.AUTH,source,{team:'seattle'}));
    // Before the fix only the matching week reached the entry lock; the others answered at once.
    for(const s of sessions)await waitForLockWait(s);
    await holder.run('ROLLBACK');
    const results=await Promise.all(pending);
    results.forEach((r,i)=>failsWith(r,probes[i][3]));
    assert.deepEqual(await teams(E.AUTH),['3:participant:austin']);
  });

  test('entry status: inactive, eliminated and archived entries cannot submit through any ordinary channel',async()=>{
    const p1=await actor('status_p1','p1'),commish=await actor('status_commish','commish');
    for(const code of ['INACTIVE','ELIMINATED','ARCHIVED']){
      failsWith(await submit(p1,W3,E[code],'participant',{team:'austin'}),'entry_not_active');
      failsWith(await submit(commish,W3,E[code],'commissioner_manual',{team:'austin'}),'entry_not_active');
    }
    const batch=jsonOf(await commish.run(`SELECT public.pool_platform_submit_batch('${W3}','commissioner_import',${lit(['INACTIVE','ELIMINATED','ARCHIVED','ACTIVE'].map(code=>({entry_id:E[code],payload:{team:'denver'}})))})`));
    assert.deepEqual(batch.map(r=>r.ok?r.result.code:r.code),['entry_not_active','entry_not_active','entry_not_active','created']);
    assert.equal(await scalar(`SELECT count(*) FROM public.pool_platform_submissions WHERE entry_id IN ('${E.INACTIVE}','${E.ELIMINATED}','${E.ARCHIVED}')`),'0');
  });

  test('invites: verified matching email claims; unverified or wrong email is rejected and the invite stays open',async()=>{
    const commish=await actor('inv_commish','commish');
    const invite=async(entry,email)=>jsonOf(await commish.run(`SELECT public.pool_platform_create_entry_invite('${entry}',${email===null?'NULL':`'${email}'`},24)`)).invite_token;
    const claim=async(userKey,token)=>{const s=await actor(`inv_${userKey}_${token.slice(0,6)}`,userKey);return s.run(`SELECT public.pool_platform_claim_entry_invite('${token}')`)};
    const owner=entry=>scalar(`SELECT COALESCE(owner_auth_user_id,'-') FROM public.pool_platform_entries WHERE id='${entry}'`);

    const boundToP3=await invite(E.INV1,'  P3@Example.TEST ');
    failsWith(await claim('wrong',boundToP3),'invite_email_mismatch');
    assert.equal(jsonOf(await claim('p3',boundToP3)).claimed,true);
    assert.equal(await owner(E.INV1),U.p3);
    failsWith(await claim('p3',boundToP3),'invite_unavailable');

    const boundToPending=await invite(E.INV2,'pending@example.test');
    failsWith(await claim('pending',boundToPending),'invite_email_unverified');
    assert.equal(await owner(E.INV2),'-');
    assert.equal(await scalar(`SELECT count(*) FROM public.pool_platform_entry_invites WHERE entry_id='${E.INV2}' AND claimed_at IS NULL`),'1');
    rowsOf(await admin.run(`UPDATE neon_auth."user" SET "emailVerified"=true WHERE id='${U.pending}'`));
    assert.equal(jsonOf(await claim('pending',boundToPending)).claimed,true,'claim succeeds once the same email is verified');
    assert.equal(await owner(E.INV2),U.pending);

    const unbound=await invite(E.INV3,null);
    assert.equal(jsonOf(await claim('drifter',unbound)).claimed,true,'an unbound invite remains a bearer token');
    assert.equal(await owner(E.INV3),U.drifter);

    const expired=await invite(E.INV4,null);
    rowsOf(await admin.run(`UPDATE public.pool_platform_entry_invites SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE entry_id='${E.INV4}'`));
    failsWith(await claim('p1',expired),'invite_unavailable');
  });

  test('invite race: exactly one concurrent claimant wins, including email-bound variants',async()=>{
    const commish=await actor('race_inv_commish','commish');
    const invite=async(entry,email)=>jsonOf(await commish.run(`SELECT public.pool_platform_create_entry_invite('${entry}',${email===null?'NULL':`'${email}'`},24)`)).invite_token;
    const claimSql=token=>`SELECT public.pool_platform_claim_entry_invite('${token}')`;
    const owner=entry=>scalar(`SELECT COALESCE(owner_auth_user_id,'-') FROM public.pool_platform_entries WHERE id='${entry}'`);

    const unbound=await invite(E.RINV1,null);
    const a=await actor('rinv_a','racer1'),b=await actor('rinv_b','racer2');
    rowsOf(await a.run('BEGIN'));rowsOf(await b.run('BEGIN'));
    assert.equal(jsonOf(await a.run(claimSql(unbound))).claimed,true);
    const loser=b.run(claimSql(unbound));
    await waitForLockWait(b);
    rowsOf(await a.run('COMMIT'));
    failsWith(await loser,'invite_unavailable');
    await b.run('ROLLBACK');
    assert.equal(await owner(E.RINV1),U.racer1);

    const bound=await invite(E.RINV2,'racer3@example.test');
    const c=await actor('rinv_c','racer3'),d=await actor('rinv_d','wrong');
    rowsOf(await c.run('BEGIN'));rowsOf(await d.run('BEGIN'));
    assert.equal(jsonOf(await c.run(claimSql(bound))).claimed,true);
    const wrongEmail=d.run(claimSql(bound));
    await waitForLockWait(d);
    rowsOf(await c.run('COMMIT'));
    failsWith(await wrongEmail,'invite_unavailable');
    await d.run('ROLLBACK');
    assert.equal(await owner(E.RINV2),U.racer3);

    // A rejected claim aborts its transaction at once (releasing the row lock), so both run side by side.
    const boundUnverified=await invite(E.RINV3,'racer4@example.test');
    const e=await actor('rinv_e','racer4'),f=await actor('rinv_f','wrong');
    rowsOf(await e.run('BEGIN'));rowsOf(await f.run('BEGIN'));
    const [unverified,mismatch]=await Promise.all([e.run(claimSql(boundUnverified)),f.run(claimSql(boundUnverified))]);
    failsWith(unverified,'invite_email_unverified');
    failsWith(mismatch,'invite_email_mismatch');
    await e.run('ROLLBACK');await f.run('ROLLBACK');
    assert.equal(await owner(E.RINV3),'-');
    assert.equal(await scalar(`SELECT count(*) FROM public.pool_platform_entry_invites WHERE entry_id='${E.RINV3}' AND claimed_at IS NULL`),'1');
  });

  test('identity: a caller is named only by a JSON-boolean emailVerified claim equal to the stored state, for the JWT\'s own user, with no password or OAuth account',async()=>{
    const claims=(key,patch={})=>JSON.stringify({sub:U[key],email:`${key}@example.test`,emailVerified:!UNVERIFIED.has(key),role:'authenticated',...patch});
    const without=(key,field)=>{const c=JSON.parse(claims(key));delete c[field];return JSON.stringify(c)};
    // All three helpers, read as their owner (the only role that may call the two internal ones): id, email, and whether
    // the caller is a verified identity for that email.
    const probe=async(label,userId,session,email)=>{
      const s=await actorWith(`id_${label}`,userId,session,OWNER);
      return rowsOf(await s.run(`SELECT concat_ws(' ',COALESCE(public.pool_platform_current_user_id(),'-'),COALESCE(public.pool_platform_current_user_email(),'-'),public.pool_platform_current_user_has_verified_email('${email}')::text)`))[0];
    };
    const NONE='- - false';
    for(const [label,userId,session,email,expected] of [
      ['verified',U.p1,claims('p1'),'p1@example.test',`${U.p1} p1@example.test true`],
      ['no_jwt',null,null,'p1@example.test',NONE],
      ['no_claims',U.p1,null,'p1@example.test',NONE],
      ['sub_other',U.p1,claims('p1',{sub:U.p2}),'p1@example.test',NONE],
      ['sub_missing',U.p1,without('p1','sub'),'p1@example.test',NONE],
      ['claim_missing',U.p1,without('p1','emailVerified'),'p1@example.test',NONE],
      ['claim_null',U.p1,claims('p1',{emailVerified:null}),'p1@example.test',NONE],
      ['claim_string',U.p1,claims('p1',{emailVerified:'true'}),'p1@example.test',NONE],
      ['claim_number',U.p1,claims('p1',{emailVerified:1}),'p1@example.test',NONE],
      ['claim_array',U.p1,claims('p1',{emailVerified:[true]}),'p1@example.test',NONE],
      ['claim_object',U.p1,claims('p1',{emailVerified:{value:true}}),'p1@example.test',NONE],
      ['claim_stale',U.p1,claims('p1',{emailVerified:false}),'p1@example.test',NONE],
      ['session_array',U.p1,JSON.stringify([JSON.parse(claims('p1'))]),'p1@example.test',NONE],
      ['session_string',U.p1,JSON.stringify(claims('p1')),'p1@example.test',NONE],
      ['unknown_user',uuid('00000000',0xff),claims('p1',{sub:uuid('00000000',0xff)}),'p1@example.test',NONE],
      // Unverified, with no password or OAuth account: still the caller (an unbound invite stays a bearer token), never
      // a verified one, and never on a claim of a verification it does not have.
      ['unverified',U.drifter,claims('drifter'),'drifter@example.test',`${U.drifter} drifter@example.test false`],
      ['unverified_claims_true',U.drifter,claims('drifter',{emailVerified:true}),'drifter@example.test',NONE],
      ['oauth_account',U.linked,claims('linked'),'linked@example.test',NONE],
      ['password_account',U.squatter,claims('squatter'),'squatter@example.test',NONE],
      ['banned',U.banned,claims('banned'),'banned@example.test',NONE]
    ]){
      assert.equal(await probe(label,userId,session,email),expected,label);
    }

    // Through the claim RPC: a refused caller leaves an email-bound invite open; an unbound one stays a bearer token
    // for any identity, whatever its email.
    const commish=await actor('id_commish','commish');
    const invite=async(entry,email)=>jsonOf(await commish.run(`SELECT public.pool_platform_create_entry_invite('${entry}',${email===null?'NULL':`'${email}'`},24)`)).invite_token;
    const claimWith=async(label,userId,session,token)=>(await actorWith(`id_claim_${label}`,userId,session)).run(`SELECT public.pool_platform_claim_entry_invite('${token}')`);
    const bound=await invite(E.ID_BOUND,'p1@example.test');
    for(const [label,userId,session] of [
      ['no_jwt',null,null],['no_claims',U.p1,null],['claim_missing',U.p1,without('p1','emailVerified')],
      ['claim_string',U.p1,claims('p1',{emailVerified:'true'})],['claim_stale',U.p1,claims('p1',{emailVerified:false})],
      ['sub_other',U.p1,claims('p1',{sub:U.p2})]
    ])failsWith(await claimWith(label,userId,session,bound),'auth_required');
    assert.equal(await scalar(`SELECT count(*) FROM public.pool_platform_entry_invites WHERE entry_id='${E.ID_BOUND}' AND claimed_at IS NULL`),'1');
    assert.equal(jsonOf(await claimWith('verified',U.p1,claims('p1'),bound)).claimed,true);
    assert.equal(await scalar(`SELECT owner_auth_user_id FROM public.pool_platform_entries WHERE id='${E.ID_BOUND}'`),U.p1);
    const bearer=await invite(E.ID_BEARER,null);
    assert.equal(jsonOf(await claimWith('bearer_other_email',U.p2,claims('p2'),bearer)).claimed,true,'an unbound invite needs no email match');
    assert.equal(await scalar(`SELECT owner_auth_user_id FROM public.pool_platform_entries WHERE id='${E.ID_BEARER}'`),U.p2);
  });

  test('pre-registration takeover: a password-registered identity, and a JWT minted before the email was verified, claim nothing and act for no one',async()=>{
    const commish=await actor('pre_commish','commish');
    const invite=async(entry,email)=>jsonOf(await commish.run(`SELECT public.pool_platform_create_entry_invite('${entry}',${email===null?'NULL':`'${email}'`},24)`)).invite_token;
    const claim=(s,token)=>s.run(`SELECT public.pool_platform_claim_entry_invite('${token}')`);
    const openInvites=entry=>scalar(`SELECT count(*) FROM public.pool_platform_entry_invites WHERE entry_id='${entry}' AND claimed_at IS NULL`);
    const owner=entry=>scalar(`SELECT COALESCE(owner_auth_user_id,'-') FROM public.pool_platform_entries WHERE id='${entry}'`);
    const bound=await invite(E.PRE_BOUND,'victim@example.test'),bearer=await invite(E.PRE_BEARER,null);

    // Someone signed up with the victim's address and a password before the victim ever signed in: the row is
    // unverified, carries a credential account, and that JWT says emailVerified false. It stays in this session.
    const early=await actor('pre_early','victim');
    for(const token of [bound,bearer])failsWith(await claim(early,token),'auth_required');

    // The victim's first Email OTP sign-in verifies the same row. Where Neon Auth keeps the password (Better Auth
    // before 1.6.22), the identity stays contested: the victim's fresh JWT is refused as the password holder's is.
    rowsOf(await admin.run(`UPDATE neon_auth."user" SET "emailVerified"=true WHERE id='${U.victim}'`));
    const contested=await actor('pre_contested','victim');
    for(const s of [contested,early])for(const token of [bound,bearer])failsWith(await claim(s,token),'auth_required');
    assert.deepEqual([await openInvites(E.PRE_BOUND),await openInvites(E.PRE_BEARER)],['1','1']);

    // Where Neon Auth removes the unproven password on that sign-in, the victim's fresh JWT is a V1 identity. The JWT
    // minted before verification still names the same user for up to 15 minutes, and stays refused everywhere.
    rowsOf(await admin.run(`DELETE FROM neon_auth.account WHERE "userId"='${U.victim}'`));
    for(const token of [bound,bearer])failsWith(await claim(early,token),'auth_required');
    const victim=await actor('pre_victim','victim');
    assert.equal(jsonOf(await claim(victim,bound)).claimed,true);
    assert.equal(await owner(E.PRE_BOUND),U.victim);
    failsWith(await submit(early,W3,E.PRE_BOUND,'participant',{team:'austin'}),'auth_required');
    failsWith(await early.run(`SELECT public.pool_platform_participant_context('it-survivor')`),'auth_required');
    const visible=async s=>rowsOf(await s.run(`SELECT count(*) FROM public.pool_platform_entries WHERE id='${E.PRE_BOUND}'`))[0];
    assert.equal(await visible(early),'0');
    assert.equal(await visible(victim),'1');
    assert.equal(jsonOf(await submit(victim,W3,E.PRE_BOUND,'participant',{team:'austin'})).code,'created');
    assert.equal(await openInvites(E.PRE_BEARER),'1','the bearer link is still there for whoever holds it');
  });

  // The concurrent-session race (docs/PRE_REGISTRATION_HARDENING.md, Race A and Race B), which 004 alone cannot close.
  // Better Auth 1.6.22 to 1.6.33, the range the live Neon Auth host fingerprints in, runs the first Email OTP sign-in of
  // an unverified user as separate autocommit statements: it deletes the credential account, then the user's sessions,
  // and only then sets "emailVerified" and creates the owner's session. /sign-in/email reads the user with its accounts
  // once, hashes the password and creates a session; only require_email_verification (N0) makes it check
  // emailVerified, on that one read. A JWT is minted by findSession, which without native joins reads the session and
  // then the user in two queries, and it carries the user as read. Each step below runs on its own backend, as Neon
  // Auth's would, in an order the race allows. The helpers are 004's.
  test('pre-registration race residual: a session created, or a JWT minted, while the owner\'s first Email OTP sign-in verifies a pre-registered row names the owner, and no identity helper can tell it apart (Race A, Race B)',async()=>{
    const neonAuth=session('race_neon_auth'),signIn=session('race_password_sign_in'),findSession=session('race_find_session');
    const commish=await actor('race_commish','commish');
    const invite=async(entry,email)=>jsonOf(await commish.run(`SELECT public.pool_platform_create_entry_invite('${entry}','${email}',24)`)).invite_token;
    const createSession=(s,token,userId)=>
      s.run(`INSERT INTO neon_auth.session(token,"userId","expiresAt","updatedAt") VALUES ('${token}','${userId}',now()+interval '7 days',now())`);
    // The owner's /sign-in/email-otp on a row that is still unverified, one statement per step, up to its own session.
    const otpSignIn=async userId=>{
      for(const sql of [
        `DELETE FROM neon_auth.account WHERE "userId"='${userId}' AND "providerId"='credential'`,
        `DELETE FROM neon_auth.session WHERE "userId"='${userId}'`,
        `UPDATE neon_auth."user" SET "emailVerified"=true WHERE id='${userId}'`
      ])rowsOf(await neonAuth.run(sql));
    };
    // findSession's two queries; the JWT claims are the user row as the second one reads it.
    const sessionUser=async token=>rowsOf(await findSession.run(`SELECT "userId" FROM neon_auth.session WHERE token='${token}' AND "expiresAt">now()`))[0];
    const claimsOf=async userId=>rowsOf(await findSession.run(`SELECT json_build_object('sub',id::text,'email',email,'emailVerified',"emailVerified",'role','authenticated')::text FROM neon_auth."user" WHERE id='${userId}'`))[0];
    const mintFrom=async token=>{const userId=await sessionUser(token);return userId===undefined?undefined:claimsOf(userId)};
    // 004's three checks, read directly for a JWT: sub is the user, emailVerified equals the stored state, no account.
    const checks004=claims=>scalar(`SELECT concat_ws(' ',(c->>'sub')=u.id::text,(c->'emailVerified')=to_jsonb(u."emailVerified"),NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id))
      FROM (SELECT $c$${claims}$c$::jsonb AS c) j JOIN neon_auth."user" u ON u.id::text=j.c->>'sub'`);
    // What the helpers make of a JWT (id, email, verified for that email), and the claim RPC under it.
    const probe=async(label,claims,email)=>{
      const s=await actorWith(`race_probe_${label}`,JSON.parse(claims).sub,claims,OWNER);
      return rowsOf(await s.run(`SELECT concat_ws(' ',COALESCE(public.pool_platform_current_user_id(),'-'),COALESCE(public.pool_platform_current_user_email(),'-'),public.pool_platform_current_user_has_verified_email('${email}')::text)`))[0];
    };
    const claim=async(label,claims,token)=>(await actorWith(`race_claim_${label}`,JSON.parse(claims).sub,claims)).run(`SELECT public.pool_platform_claim_entry_invite('${token}')`);

    // Race A. Someone pre-registered raced@ with a password while require_email_verification was false. Their
    // /sign-in/email reads the row (unverified, with that password) just before the owner's first Email OTP sign-in.
    const raced=U.raced,racedEmail='raced@example.test',boundA=await invite(E.RACE_A_BOUND,racedEmail);
    assert.equal(rowsOf(await signIn.run(`SELECT u."emailVerified"::text||' '||count(a.id) FROM neon_auth."user" u
      LEFT JOIN neon_auth.account a ON a."userId"=u.id AND a."providerId"='credential' WHERE u.id='${raced}' GROUP BY u.id`))[0],'false 1',
      'the password sign-in reads an unverified row with its password: under N0 it would stop here');
    // While it hashes the password, the owner's sign-in removes the password and every session and verifies the row.
    await otpSignIn(raced);
    rowsOf(await createSession(neonAuth,'race-a-owner',raced));
    // Without N0 the password sign-in checks nothing more. Its session lands after the revocation, so nothing removes
    // it, and no constraint refuses it.
    rowsOf(await createSession(signIn,'race-a-password',raced));
    const ownerA=await mintFrom('race-a-owner'),passwordA=await mintFrom('race-a-password');
    assert.deepEqual(JSON.parse(passwordA),JSON.parse(ownerA),'both sessions mint the same claims');
    assert.equal(await checks004(passwordA),'t t t','the password holder\'s JWT meets all three of 004\'s checks');
    for(const [label,claims] of [['a_owner',ownerA],['a_password',passwordA]])
      assert.equal(await probe(label,claims,racedEmail),`${raced} ${racedEmail} true`,label);
    assert.equal(jsonOf(await claim('a_password',passwordA,boundA)).claimed,true,'it claims the invite bound to the owner\'s address');
    assert.equal(await scalar(`SELECT owner_auth_user_id FROM public.pool_platform_entries WHERE id='${E.RACE_A_BOUND}'`),raced);
    // Revoking that session stops new JWTs from it, but one already minted stays valid at the Data API until it expires
    // (15 minutes, and about 30 s of skew): the helpers read the JWT, never the session.
    rowsOf(await neonAuth.run(`DELETE FROM neon_auth.session WHERE token='race-a-password'`));
    assert.equal(await mintFrom('race-a-password'),undefined);
    assert.equal(await probe('a_revoked',passwordA,racedEmail),`${raced} ${racedEmail} true`);

    // Race B. straddled@ was pre-registered too, and its password holder signed in while require_email_verification
    // was false: a session minted before N0, which N0 does not remove.
    const straddled=U.straddled,straddledEmail='straddled@example.test',boundB=await invite(E.RACE_B_BOUND,straddledEmail);
    rowsOf(await createSession(signIn,'race-b-password',straddled));
    // What 004 closes: a JWT minted from it before the owner verifies says emailVerified false, and names nobody, both
    // before the owner's sign-in and after it (the claim no longer equals the stored state).
    const early=await mintFrom('race-b-password');
    assert.equal(JSON.parse(early).emailVerified,false);
    assert.equal(await probe('b_early',early,straddledEmail),'- - false');
    failsWith(await claim('b_early',early,boundB),'auth_required');
    // The owner's first Email OTP sign-in, with the password holder's findSession straddling it: the session query runs
    // before the revocation, the user query after the row is verified.
    assert.equal(await sessionUser('race-b-password'),straddled);
    await otpSignIn(straddled);
    const straddledB=await claimsOf(straddled);
    rowsOf(await createSession(neonAuth,'race-b-owner',straddled));
    assert.equal(await sessionUser('race-b-password'),undefined,'the revocation removed the password holder\'s session');
    assert.equal(await probe('b_early_after',early,straddledEmail),'- - false');
    failsWith(await claim('b_early_after',early,boundB),'auth_required');
    // What 004 cannot close: the straddled JWT carries the owner's own claims, for a row with no account left, and names
    // the owner for up to 15 minutes, minted from a session that no longer exists.
    assert.deepEqual(JSON.parse(straddledB),JSON.parse(await mintFrom('race-b-owner')));
    assert.equal(await checks004(straddledB),'t t t');
    assert.equal(await probe('b_straddled',straddledB,straddledEmail),`${straddled} ${straddledEmail} true`);
    assert.equal(jsonOf(await claim('b_straddled',straddledB,boundB)).claimed,true);
    assert.equal(await scalar(`SELECT owner_auth_user_id FROM public.pool_platform_entries WHERE id='${E.RACE_B_BOUND}'`),straddled);
  });

  test('Survivor team must be a JSON string: number, boolean, array, object and null picks are invalid_payload even when their text is a configured key',async()=>{
    const p1=await actor('typed_p1','p1'),commish=await actor('typed_commish','commish');
    const nonString=[123,1.5,true,false,['austin'],{k:'v'},null];
    for(const team of nonString){
      failsWith(await submit(p1,W7_TYPED,E.TYPED,'participant',{team}),'invalid_payload');
      failsWith(await submit(commish,W7_TYPED,E.TYPED_BATCH,'commissioner_manual',{team}),'invalid_payload');
    }
    const batch=jsonOf(await commish.run(`SELECT public.pool_platform_submit_batch('${W7_TYPED}','commissioner_import',${lit(nonString.map(team=>({entry_id:E.TYPED_BATCH,payload:{team}})))})`));
    assert.deepEqual(batch.map(r=>r.ok?r.result.code:r.code),nonString.map(()=>'invalid_payload'));
    assert.equal(jsonOf(await submit(p1,W7_TYPED,E.TYPED,'participant',{team:'123'})).code,'created','the same key as a JSON string is a valid pick');
    failsWith(await submit(p1,W8_TYPED,E.TYPED,'participant',{team:'123'}),'team_already_used');
    failsWith(await submit(p1,W8_TYPED,E.TYPED,'participant',{team:123}),'invalid_payload');
    // A same-row edit cannot switch to a non-string team either.
    failsWith(await submit(p1,W7_TYPED,E.TYPED,'participant',{team:123}),'invalid_payload');
    assert.deepEqual(await teams(E.TYPED),['7:participant:123']);
    assert.deepEqual(await teams(E.TYPED_BATCH),[]);
    assert.equal(await scalar(`SELECT count(*) FROM public.pool_platform_submissions WHERE payload ? 'team' AND jsonb_typeof(payload->'team')<>'string'`),'0');
  });

  test('Survivor under REPEATABLE READ: a numeric repeat of a committed pick is rejected outright; a string repeat still hits the index',async()=>{
    const a=await actor('rr_a','p1'),b=await actor('rr_b','p1');
    // a's snapshot predates b's commit, so a's history check cannot see b's pick; only the payload type (for
    // a number) and the unique index (for a string) stand between a and a reused team.
    rowsOf(await a.run('BEGIN ISOLATION LEVEL REPEATABLE READ'));
    rowsOf(await a.run('SELECT count(*) FROM public.pool_platform_submissions'));
    assert.equal(jsonOf(await submit(b,W7_TYPED,E.TYPED_RR,'participant',{team:'123'})).code,'created');
    failsWith(await submit(a,W8_TYPED,E.TYPED_RR,'participant',{team:123}),'invalid_payload');
    await a.run('ROLLBACK');
    assert.deepEqual(await teams(E.TYPED_RR),['7:participant:123']);

    rowsOf(await a.run('BEGIN ISOLATION LEVEL REPEATABLE READ'));
    rowsOf(await a.run('SELECT count(*) FROM public.pool_platform_submissions'));
    assert.equal(jsonOf(await submit(b,W7_TYPED,E.TYPED_RR2,'participant',{team:'true'})).code,'created');
    failsWith(await submit(a,W8_TYPED,E.TYPED_RR2,'participant',{team:'true'}),'team_already_used');
    await a.run('ROLLBACK');
    assert.deepEqual(await teams(E.TYPED_RR2),['7:participant:true']);
  });

  test('Pickem payloads are untouched by the Survivor index and a blank tiebreak is never zero',async()=>{
    const p2=await actor('pickem_p2','p2');
    failsWith(await submit(p2,K1,K_P2,'participant',{picks:{g1:'away',g2:'home'}}),'invalid_payload');
    failsWith(await submit(p2,K1,K_P2,'participant',{picks:{g1:'away',g2:'home'},tiebreak:''}),'invalid_payload');
    failsWith(await submit(p2,K1,K_P2,'participant',{picks:{g1:'away',g2:'home'},tiebreak:0,team:'austin'}),'invalid_payload');
    assert.equal(jsonOf(await submit(p2,K1,K_P2,'participant',{picks:{g1:'away',g2:'home'},tiebreak:0})).code,'created');
    assert.equal(jsonOf(await submit(p2,K2,K_P2,'participant',{picks:{g1:'away',g2:'home'},tiebreak:0})).code,'created','identical Pickem payloads in two weeks are fine');
    assert.equal(jsonOf(await submit(p2,K2,K_P2,'participant',{picks:{g1:'home',g2:'home'},tiebreak:'47'})).revision,2);
    assert.equal(await scalar(`SELECT count(*) FROM public.pool_platform_submissions WHERE entry_id='${K_P2}' AND payload ? 'team'`),'0');
  });
});

// Privilege scenarios in small separate databases (no seed), and the live Neon validation kit run exactly as
// shipped against each of them. Every database here is created by this block and dropped afterwards.
describe('privilege scenarios and the live Neon validation kit on throwaway local PostgreSQL (opt-in)',{skip:SKIP},()=>{
  const created=[];
  const scenario=(suffix,{stub=true,setup=''}={})=>{
    const name=`${DB_NAME}_${suffix}`;
    created.push(name);
    psqlSync(CLUSTER,`CREATE DATABASE ${name} OWNER ${OWNER};`);
    if(stub)psqlSync(urlFor(name),STUB);
    if(setup)psqlSync(urlFor(name),setup);
    return urlFor(name);
  };
  const apply=(url,...files)=>psqlSync(url,`SET ROLE ${OWNER};\n${files.map(readMigration).join('\n')}`);
  const functionAclsOf=url=>Object.fromEntries(psqlSync(url,FUNCTION_ACLS_SQL).split('\n').map(r=>r.split('=')));
  const assertPreflightPasses=(url,label)=>{
    const rows=runKit(url,'neon-preflight.sql');
    assert.deepEqual(failingChecks(rows),[],label);
    assert.deepEqual([verdictOf(rows).actual,verdictOf(rows).ok],['PASS',true],label);
    return rows;
  };
  const assertCatalogPasses=(url,label)=>{
    const rows=runKit(url,'neon-catalog-verify.sql');
    assert.deepEqual(failingChecks(rows),[],label);
    assert.deepEqual([verdictOf(rows).actual,verdictOf(rows).ok],['PASS',true],label);
    const maintain=rows.find(r=>r.check_id==='C21');
    assert.deepEqual([maintain.required,maintain.ok],hasMaintain()?[true,true]:[false,null],`${label}: C21 is required exactly from PostgreSQL 17`);
    return rows;
  };

  before(()=>{assertLocalCluster();ensureRoles()});
  after(()=>{for(const name of created)psqlSync(CLUSTER,`DROP DATABASE IF EXISTS ${name} WITH (FORCE);`)});

  test('the server is a verified major version and knows exactly the table, sequence and function privileges checked here',()=>{
    assert.ok(VERIFIED_MAJORS.includes(Math.floor(pgVersion()/10000)),`server_version_num ${pgVersion()} is not one of PostgreSQL ${VERIFIED_MAJORS.join(', ')}`);
    // acldefault gives the owner every privilege the server supports on an object type, so a privilege a newer
    // version adds would show up here instead of going unchecked.
    const known=type=>psqlSync(CLUSTER,`SELECT string_agg(privilege_type,',' ORDER BY privilege_type) FROM aclexplode(acldefault('${type}','${OWNER}'::regrole)) WHERE grantee='${OWNER}'::regrole`);
    assert.equal(known('r'),tablePrivileges().join(','),'table privileges');
    assert.equal(known('s'),'SELECT,UPDATE,USAGE','sequence privileges');
    assert.equal(known('f'),'EXECUTE','function privileges');
  });

  test('A. clean default privileges: anonymous ends with nothing, authenticated with SELECT only, and the kit passes',async()=>{
    const url=scenario('clean');
    assertPreflightPasses(url,'clean preflight');
    const neonAuthAcl=privilegeState(url).neonAuthAcl;
    apply(url,'001_foundation.sql','002_identity_submission_rls.sql');
    const state=privilegeState(url);
    assertPrivilegeContract(state,'clean defaults');
    assert.equal(state.neonAuthAcl,neonAuthAcl,'neon_auth."user" is untouched');
    assertNoMaintain(url,'clean defaults');
    await assertMaintenanceDenied(url,'clean defaults');
    assert.deepEqual(functionAclsOf(url),EXPECTED_FUNCTION_ACLS);
    assertCatalogPasses(url,'clean catalog');
  });

  test('B. hostile default privileges: authenticated granted ALL on tables before 002 still ends with SELECT only',async()=>{
    const url=scenario('hostile',{setup:`ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT ALL ON TABLES TO authenticated;`});
    const pre=assertPreflightPasses(url,'hostile preflight: 002 resets these defaults');
    assert.match(pre.find(r=>r.check_id==='P19').actual,new RegExp(`tables in public: authenticated:${hasMaintain()?'MAINTAIN':'TRIGGER'};`),'P19 reports the defaults 002 resets');
    apply(url,'001_foundation.sql');
    // Between 001 and 002 the default really has granted authenticated every table privilege, MAINTAIN on 17.
    const between=privilegeState(url);
    for(const table of TABLES.filter(t=>t!=='pool_platform_entry_invites'))assert.deepEqual(between.rights[`authenticated ${table}`],tablePrivileges(),`setup: ${table}`);
    apply(url,'002_identity_submission_rls.sql');
    assertPrivilegeContract(privilegeState(url),'hostile defaults');
    assertNoMaintain(url,'hostile defaults');
    await assertMaintenanceDenied(url,'hostile defaults');
    assertCatalogPasses(url,'hostile catalog');
  });

  test('hostile default privileges with grant options, PUBLIC, sequences and functions are all reset by 002',()=>{
    const url=scenario('hostile_all',{setup:`
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT ALL ON TABLES TO authenticated WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT ALL ON TABLES TO PUBLIC,anonymous;
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT ALL ON SEQUENCES TO anonymous,authenticated WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT ALL ON SEQUENCES TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT EXECUTE ON FUNCTIONS TO anonymous,authenticated WITH GRANT OPTION;`});
    assertPreflightPasses(url,'hostile preflight with grant options');
    apply(url,'001_foundation.sql','002_identity_submission_rls.sql');
    assertPrivilegeContract(privilegeState(url),'hostile defaults with grant options');
    assertNoMaintain(url,'hostile defaults with grant options');
    assert.deepEqual(functionAclsOf(url),EXPECTED_FUNCTION_ACLS);
    assertCatalogPasses(url,'hostile catalog with grant options');
  });

  test('grants made between 001 and 002, grant-option chains and PUBLIC included, are reset by 002',async()=>{
    const url=scenario('between');
    apply(url,'001_foundation.sql');
    psqlSync(url,`GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated WITH GRANT OPTION;
GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated WITH GRANT OPTION;
SET ROLE authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anonymous;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anonymous;`);
    const between=privilegeState(url);
    assert.deepEqual(between.rights['anonymous pool_platform_weeks'],tablePrivileges(),'setup: anonymous holds everything through the chain');
    assert.ok(between.acl.pool_platform_weeks.includes(`authenticated:SELECT+grant_option by ${OWNER}`),'setup: grant option');
    apply(url,'002_identity_submission_rls.sql');
    assertPrivilegeContract(privilegeState(url),'grants between 001 and 002');
    assertNoMaintain(url,'grants between 001 and 002');
    await assertMaintenanceDenied(url,'grants between 001 and 002');
    assertCatalogPasses(url,'catalog after grants between 001 and 002');
  });

  test('re-applying 002 over unwanted grants made after an earlier application restores the contract',async()=>{
    const url=scenario('reapply');
    apply(url,'001_foundation.sql','002_identity_submission_rls.sql');
    psqlSync(url,`GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC,anonymous;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated WITH GRANT OPTION;
GRANT UPDATE (status) ON public.pool_platform_entries TO authenticated;
GRANT INSERT (payload) ON public.pool_platform_submissions TO anonymous;
GRANT ALL ON SEQUENCE public.${AUDIT_SEQUENCE} TO PUBLIC,anonymous;
GRANT ALL ON SEQUENCE public.${AUDIT_SEQUENCE} TO authenticated WITH GRANT OPTION;
SET ROLE authenticated;
GRANT SELECT,INSERT${hasMaintain()?',MAINTAIN':''} ON ALL TABLES IN SCHEMA public TO anonymous;
GRANT USAGE ON SEQUENCE public.${AUDIT_SEQUENCE} TO anonymous;`);
    const hostile=runKit(url,'neon-catalog-verify.sql');
    assert.deepEqual(failingChecks(hostile),['C13','C14','C16',...(hasMaintain()?['C21']:[]),'C22'],'the verifier reports the unwanted grants');
    assert.equal(verdictOf(hostile).ok,false);
    const s=openSession(url,'pp_it_reapply');
    rowsOf(await s.run('SET ROLE authenticated'));rowsOf(await s.run('BEGIN'));
    rowsOf(await s.run('LOCK TABLE public.pool_platform_submissions IN ACCESS EXCLUSIVE MODE'));
    await s.run('ROLLBACK');await s.close();
    apply(url,'002_identity_submission_rls.sql');
    assertPrivilegeContract(privilegeState(url),'re-applied 002');
    assertNoMaintain(url,'re-applied 002');
    await assertMaintenanceDenied(url,'re-applied 002');
    assert.deepEqual(functionAclsOf(url),EXPECTED_FUNCTION_ACLS);
    assertCatalogPasses(url,'catalog after re-applying 002');
  });

  // 003 is the forward migration for a database that applied 002 before the submit_entry authorization-order fix.
  // On a database built from the current 002 it changes nothing; its guard stops it anywhere else.
  test('003 forward migration: replaces only submit_entry and resets only its privileges; stops, leaving nothing behind, on the wrong database, role or definition',()=>{
    const FN='public.pool_platform_submit_entry(uuid,uuid,text,jsonb)';
    const snapshot=url=>JSON.parse(psqlSync(url,CATALOG_SNAPSHOT_SQL));
    const bodySha=url=>psqlSync(url,`SELECT COALESCE((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('${FN}')),'missing')`);
    // As the runbook applies migrations (psql --single-transaction): a stop rolls all of 003 back.
    const forward=(url,role=OWNER)=>psqlRun(url,`\\set ON_ERROR_STOP 1\n${role?`SET ROLE ${role};\n`:''}BEGIN;\n${readMigration('003_submit_entry_authorization_order.sql')}\nCOMMIT;`);
    const stops=(url,message,label,role)=>{
      const run=forward(url,role);
      assert.notEqual(run.status,0,`${label}: 003 must stop`);
      assert.match(run.stderr,message,label);
    };

    const url=scenario('forward');
    apply(url,'001_foundation.sql','002_identity_submission_rls.sql');
    const fixed=bodySha(url),clean=snapshot(url);
    let run=forward(url);
    assert.equal(run.status,0,run.stderr);
    assert.deepEqual(snapshot(url),clean,'on a database built from the current 002, 003 changes nothing');
    assertCatalogPasses(url,'catalog after 003');

    // Unwanted grants made after 002: 003 resets submit_entry's and leaves every other function's as it found them.
    psqlSync(url,['pool_platform_submit_entry(uuid,uuid,text,jsonb)','pool_platform_submit_batch(uuid,text,jsonb)'].map(f=>
      `GRANT EXECUTE ON FUNCTION public.${f} TO PUBLIC,anonymous;\nGRANT EXECUTE ON FUNCTION public.${f} TO authenticated WITH GRANT OPTION;`).join('\n'));
    const granted=functionAclsOf(url);
    assert.notEqual(granted.pool_platform_submit_entry,EXPECTED_FUNCTION_ACLS.pool_platform_submit_entry,'setup: submit_entry carries unwanted grants');
    run=forward(url);
    assert.equal(run.status,0,run.stderr);
    assert.deepEqual(functionAclsOf(url),{...granted,pool_platform_submit_entry:EXPECTED_FUNCTION_ACLS.pool_platform_submit_entry});
    apply(url,'002_identity_submission_rls.sql');
    assert.deepEqual(snapshot(url),clean);

    // Each guard stops 003 and leaves the database as it was.
    stops(url,/run as pool_platform_it_owner, the owner of pool_platform_submit_entry, not [^:]+: stop/,'a superuser instead of the migration owner','');
    psqlSync(url,'CREATE TABLE public.nfl_survivor_weeks(season integer);');
    stops(url,/personal Pool Center database: stop/,'a personal Pool Center table');
    psqlSync(url,'DROP TABLE public.nfl_survivor_weeks;');
    assert.deepEqual(snapshot(url),clean);
    const create=readMigration('002_identity_submission_rls.sql').match(/CREATE OR REPLACE FUNCTION public\.pool_platform_submit_entry\([\s\S]*?\n\$\$;/)[0];
    psqlSync(url,`SET ROLE ${OWNER};\n${create.replace('\nBEGIN\n','\nBEGIN\n  -- an unreviewed edit\n')}`);
    const drifted=bodySha(url);
    assert.notEqual(drifted,fixed);
    stops(url,new RegExp(`pool_platform_submit_entry body sha256 ${drifted} is not a reviewed definition: stop`),'an unreviewed definition');
    assert.equal(bodySha(url),drifted,'an unreviewed definition is left for review, not overwritten');
    apply(url,'002_identity_submission_rls.sql');
    assert.deepEqual(snapshot(url),clean);

    const bare=scenario('forward_bare');
    apply(bare,'001_foundation.sql');
    stops(bare,/public\.pool_platform_submit_entry\(uuid,uuid,text,jsonb\) does not exist: stop/,'a database without 002');
    assert.equal(bodySha(bare),'missing','003 never creates the function');
  });

  // 004 is the forward migration for a database that applied 002 before its identity helpers were hardened against
  // pre-registration. The live helpers are 002's definitions without their three identity checks:
  // migration-contract.test.mjs pins that, by SHA-256, to what the commercial database holds.
  test('004 forward migration: hardens only the three identity helpers and resets only their privileges; stops, leaving nothing behind, on the wrong database, role, definition or prerequisites',()=>{
    const HELPERS={
      pool_platform_current_user_id:'public.pool_platform_current_user_id()',
      pool_platform_current_user_email:'public.pool_platform_current_user_email()',
      pool_platform_current_user_has_verified_email:'public.pool_platform_current_user_has_verified_email(text)'
    };
    const CHECKS=[`AND auth.session()->>'sub'=u.id::text`,`AND auth.session()->'emailVerified'=to_jsonb(u."emailVerified")`,
      'AND NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)'];
    const definition=name=>readMigration('002_identity_submission_rls.sql').match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0];
    const liveHelpers=Object.keys(HELPERS).map(name=>definition(name).split('\n').filter(line=>!CHECKS.includes(line.trim())).join('\n')).join('\n');
    const snapshot=url=>JSON.parse(psqlSync(url,CATALOG_SNAPSHOT_SQL));
    const bodySha=url=>Object.fromEntries(Object.entries(HELPERS).map(([name,sig])=>[name,
      psqlSync(url,`SELECT COALESCE((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('${sig}')),'missing')`)]));
    // As the runbook applies migrations (psql --single-transaction): a stop rolls all of 004 back.
    const forward=(url,role=OWNER)=>psqlRun(url,`\\set ON_ERROR_STOP 1\n${role?`SET ROLE ${role};\n`:''}BEGIN;\n${readMigration('004_identity_pre_registration_hardening.sql')}\nCOMMIT;`);
    const stops=(url,message,label,role)=>{
      const run=forward(url,role);
      assert.notEqual(run.status,0,`${label}: 004 must stop`);
      assert.match(run.stderr,message,label);
    };

    const url=scenario('forward4');
    apply(url,'001_foundation.sql','002_identity_submission_rls.sql');
    const hardened=bodySha(url),clean=snapshot(url);
    let run=forward(url);
    assert.equal(run.status,0,run.stderr);
    assert.deepEqual(snapshot(url),clean,'on a database built from the current 002, 004 changes nothing');
    assertCatalogPasses(url,'catalog after 004');

    // The live state: the pre-hardening helpers, here with unwanted grants on one of them and on another function.
    psqlSync(url,`SET ROLE ${OWNER};\n${liveHelpers}`);
    const live=bodySha(url);
    for(const name of Object.keys(HELPERS))assert.notEqual(live[name],hardened[name],`setup: ${name} is the pre-hardening body`);
    psqlSync(url,`GRANT EXECUTE ON FUNCTION ${HELPERS.pool_platform_current_user_email} TO authenticated WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.pool_platform_submit_batch(uuid,text,jsonb) TO anonymous;`);
    const granted=functionAclsOf(url);
    assert.notEqual(granted.pool_platform_current_user_email,EXPECTED_FUNCTION_ACLS.pool_platform_current_user_email,'setup: the email helper carries an unwanted grant');
    run=forward(url);
    assert.equal(run.status,0,run.stderr);
    assert.deepEqual(bodySha(url),hardened,'004 installs the hardened helpers');
    assert.deepEqual(functionAclsOf(url),{...granted,pool_platform_current_user_email:EXPECTED_FUNCTION_ACLS.pool_platform_current_user_email},
      '004 resets the identity helpers\' privileges and leaves every other function\'s as it found them');
    apply(url,'002_identity_submission_rls.sql');
    assert.deepEqual(snapshot(url),clean);

    // Each guard stops 004 and leaves the database as it was.
    psqlSync(url,`SET ROLE ${OWNER};\n${liveHelpers}`);
    const before=snapshot(url);
    stops(url,/run as pool_platform_it_owner, the owner of public\.pool_platform_current_user_id\(\), not [^:]+: stop/,'a superuser instead of the migration owner','');
    psqlSync(url,'CREATE TABLE public.nfl_survivor_weeks(season integer);');
    stops(url,/personal Pool Center database: stop/,'a personal Pool Center table');
    psqlSync(url,'DROP TABLE public.nfl_survivor_weeks;');
    const unreviewed=liveHelpers.replace('    WHERE u.id::text=auth.user_id()\n      AND','    WHERE u.id::text=auth.user_id() -- an unreviewed edit\n      AND');
    assert.notEqual(unreviewed,liveHelpers,'setup: the edit applies');
    psqlSync(url,`SET ROLE ${OWNER};\n${unreviewed}`);
    const drifted=bodySha(url).pool_platform_current_user_has_verified_email;
    assert.notEqual(drifted,live.pool_platform_current_user_has_verified_email);
    stops(url,new RegExp(`public\\.pool_platform_current_user_has_verified_email\\(text\\) body sha256 ${drifted} is not a reviewed definition: stop`),'an unreviewed definition');
    assert.equal(bodySha(url).pool_platform_current_user_has_verified_email,drifted,'an unreviewed definition is left for review, not overwritten');
    psqlSync(url,`SET ROLE ${OWNER};\n${liveHelpers}`);
    for(const [label,fault,undo,message] of [
      ['no auth.session()','ALTER FUNCTION auth.session() RENAME TO session_elsewhere','ALTER FUNCTION auth.session_elsewhere() RENAME TO session',
        /auth\.session\(\) returning jsonb \(pg_session_jwt\) is missing: stop/],
      ['the owner cannot call auth.session()','REVOKE EXECUTE ON FUNCTION auth.session() FROM PUBLIC','GRANT EXECUTE ON FUNCTION auth.session() TO PUBLIC',
        /pool_platform_it_owner cannot call auth\.session\(\): stop/],
      ['no neon_auth.account."userId"','ALTER TABLE neon_auth.account RENAME COLUMN "userId" TO user_id','ALTER TABLE neon_auth.account RENAME COLUMN user_id TO "userId"',
        /neon_auth\.account\."userId" of the type of neon_auth\."user"\.id is missing: stop/],
      ['the owner cannot read neon_auth.account',`REVOKE SELECT ON neon_auth.account FROM ${OWNER}`,`GRANT SELECT ON neon_auth.account TO ${OWNER}`,
        /pool_platform_it_owner cannot read neon_auth\.account\."userId": stop/]
    ]){
      psqlSync(url,`${fault};`);
      stops(url,message,label);
      psqlSync(url,`${undo};`);
    }
    assert.deepEqual(snapshot(url),before,'every stop left the database as it was');
    assert.deepEqual(bodySha(url),live);
    run=forward(url);
    assert.equal(run.status,0,run.stderr);
    assert.deepEqual(bodySha(url),hardened);
    assertCatalogPasses(url,'catalog after 004 from the live helpers');

    const bare=scenario('forward4_bare');
    apply(bare,'001_foundation.sql');
    stops(bare,/public\.pool_platform_current_user_id\(\) does not exist: stop/,'a database without 002');
    assert.equal(bodySha(bare).pool_platform_current_user_id,'missing','004 never creates the helpers');
  });

  test('the catalog verifier reports each single fault on an otherwise correct database, and only that fault',()=>{
    const url=scenario('faults');
    apply(url,'001_foundation.sql','002_identity_submission_rls.sql');
    assertCatalogPasses(url,'baseline');
    const extra=hasMaintain()?'MAINTAIN':'TRIGGER';
    const helper='public.pool_platform_payload_valid(text,jsonb,uuid,uuid,jsonb)';
    for(const [fault,undo,expected] of [
      [`GRANT ${extra} ON public.pool_platform_weeks TO authenticated`,`REVOKE ${extra} ON public.pool_platform_weeks FROM authenticated`,['C13','C14',...(hasMaintain()?['C21']:[])]],
      ['GRANT SELECT ON public.pool_platform_pools TO PUBLIC','REVOKE SELECT ON public.pool_platform_pools FROM PUBLIC',['C13','C14','C22']],
      ['GRANT SELECT ON public.pool_platform_pools TO authenticated WITH GRANT OPTION','REVOKE GRANT OPTION FOR SELECT ON public.pool_platform_pools FROM authenticated',['C14']],
      ['GRANT UPDATE (status) ON public.pool_platform_entries TO authenticated','REVOKE UPDATE (status) ON public.pool_platform_entries FROM authenticated',['C22']],
      [`GRANT EXECUTE ON FUNCTION ${helper} TO authenticated`,`REVOKE EXECUTE ON FUNCTION ${helper} FROM authenticated`,['C11','C12']],
      ['CREATE TRIGGER pp_it_extra BEFORE INSERT ON public.pool_platform_weeks FOR EACH ROW EXECUTE FUNCTION public.pool_platform_guard_submission_source()','DROP TRIGGER pp_it_extra ON public.pool_platform_weeks',['C08']],
      ['ALTER TABLE public.pool_platform_weeks DISABLE ROW LEVEL SECURITY','ALTER TABLE public.pool_platform_weeks ENABLE ROW LEVEL SECURITY',['C03']],
      ['ALTER POLICY pool_platform_week_read ON public.pool_platform_weeks TO PUBLIC','ALTER POLICY pool_platform_week_read ON public.pool_platform_weeks TO authenticated',['C09']],
      [`GRANT USAGE ON SEQUENCE public.${AUDIT_SEQUENCE} TO anonymous`,`REVOKE USAGE ON SEQUENCE public.${AUDIT_SEQUENCE} FROM anonymous`,['C16']],
      ['CREATE FUNCTION public.pp_it_extra() RETURNS integer LANGUAGE sql AS $$SELECT 1$$','DROP FUNCTION public.pp_it_extra()',['C17']],
      [`REVOKE SELECT ON neon_auth."user" FROM ${OWNER}`,`GRANT SELECT ON neon_auth."user" TO ${OWNER}`,['C24']],
      [`REVOKE SELECT ON neon_auth.account FROM ${OWNER}`,`GRANT SELECT ON neon_auth.account TO ${OWNER}`,['C24']],
      ['REVOKE EXECUTE ON FUNCTION auth.session() FROM PUBLIC','GRANT EXECUTE ON FUNCTION auth.session() TO PUBLIC',['C24']]
    ]){
      psqlSync(url,`${fault};`);
      const rows=runKit(url,'neon-catalog-verify.sql');
      assert.deepEqual(failingChecks(rows),expected,fault);
      assert.equal(verdictOf(rows).ok,false,fault);
      psqlSync(url,`${undo};`);
    }
    assertCatalogPasses(url,'every fault undone');
  });

  test('the preflight stops on each unsafe condition, and only on that condition',()=>{
    const clean=scenario('pf_clean');
    assertPreflightPasses(clean,'clean');
    const stops=(url,options)=>failingChecks(runKit(url,'neon-preflight.sql',options));
    assert.deepEqual(stops(scenario('pf_no_auth',{stub:false})),['P07','P08','P10','P11','P12','P22','P23'],'no Neon Auth schema, no auth.user_id() and no auth.session()');
    assert.deepEqual(stops(scenario('pf_no_session',{setup:'DROP FUNCTION auth.session();'})),['P22'],'no auth.session()');
    assert.deepEqual(stops(scenario('pf_session_private',{setup:'REVOKE EXECUTE ON FUNCTION auth.session() FROM PUBLIC;'})),['P22'],'the migration role cannot call auth.session()');
    assert.deepEqual(stops(scenario('pf_no_account',{setup:'DROP TABLE neon_auth.account;'})),['P23'],'no neon_auth.account');
    assert.deepEqual(stops(scenario('pf_account_private',{setup:`REVOKE SELECT ON neon_auth.account FROM ${OWNER};`})),['P23'],'the migration role cannot read neon_auth.account');
    assert.deepEqual(stops(scenario('pf_other',{setup:`ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT SELECT ON TABLES TO ${OTHER_ROLE};`})),['P20'],'a default 002 does not reset');
    const applied=scenario('pf_applied');
    apply(applied,'001_foundation.sql','002_identity_submission_rls.sql');
    assert.deepEqual(stops(applied),['P05'],'not a fresh database');
    assert.deepEqual(stops(clean,{role:''}),['P16'],'run as a superuser');
    assert.deepEqual(stops(scenario('pf_personal',{setup:'CREATE TABLE public.nfl_pool_weeks(season integer);'})),['P04'],'personal Pool Center table');
    assert.deepEqual(stops(scenario('pf_create',{setup:'GRANT CREATE ON SCHEMA public TO PUBLIC;'})),['P18'],'PUBLIC CREATE on public');
    assert.deepEqual(stops(clean,{before:'SET search_path=neon_auth,public;'}),['P14'],'extensions would not land in public');
    assert.deepEqual(stops(scenario('pf_crypto',{setup:'CREATE SCHEMA pp_it_ext;\nCREATE EXTENSION pgcrypto SCHEMA pp_it_ext;'})),['P13'],'pgcrypto outside public');
    const member=scenario('pf_member');
    psqlSync(CLUSTER,`GRANT ${OWNER} TO authenticated;`);
    try{assert.deepEqual(stops(member),['P17'],'authenticated inherits the migration role')}
    finally{psqlSync(CLUSTER,`REVOKE ${OWNER} FROM authenticated;`)}
    // The database-name guard, exercised without creating a database named like the personal one.
    const name=new URL(clean).pathname.slice(1);
    assert.deepEqual(stops(clean,{transform:sql=>sql.replace("current_database()<>'nfl_pool'",`current_database()<>'${name}'`)}),['P03'],'personal database name');
    // The version gate, exercised for versions other than this server's: only the verified majors pass P01.
    const version="current_setting('server_version_num')::int AS num";
    for(const major of [15,...VERIFIED_MAJORS,19]){
      const faked=stops(clean,{transform:sql=>{assert.ok(sql.includes(version));return sql.replace(version,`${major*10000} AS num`)}});
      assert.deepEqual(faked,VERIFIED_MAJORS.includes(major)?[]:['P01'],`server_version_num ${major*10000}`);
    }
    assertPreflightPasses(clean,'clean again');
  });

  test('the identity audit counts pre-registration shapes and the sessions Race B needs, names no identity, and stops until those sessions are revoked',()=>{
    const url=scenario('audit');
    apply(url,'001_foundation.sql','002_identity_submission_rls.sql');
    const id=n=>uuid('00000000',0x100+n);
    // n: email, verified, account provider, live sessions, expired sessions
    const USERS=[
      [1,'v1@example.test',true,null,2,1],[2,'v2@example.test',true,null,0,0],
      [3,'pp-cv1-t1-a@example.com',false,'credential',0,0],[4,'pp-cv1-t1-b@example.com',false,'credential',1,0],
      [5,' Prereg@Example.org',false,'credential',1,1],[6,'contested@example.test',true,'credential',1,0],
      [7,'google@example.test',true,'google',0,0],[8,'fresh@example.test',false,null,1,0]
    ];
    const T=uuid('11000000',1),P=uuid('21000000',1),S=uuid('31000000',1);
    const sessions=USERS.flatMap(([n,,,,live,expired])=>[
      ...Array.from({length:live},(_,i)=>`('tok-${n}-live-${i}','${id(n)}',now()+interval '7 days',now(),${n===1&&i===1?`'${id(2)}'`:'NULL'})`),
      ...Array.from({length:expired},(_,i)=>`('tok-${n}-expired-${i}','${id(n)}',now()-interval '1 minute',now(),NULL)`)
    ]);
    psqlSync(url,`INSERT INTO neon_auth."user"(id,name,email,"emailVerified",banned) VALUES
${USERS.map(([n,email,verified])=>`('${id(n)}','u${n}','${email}',${verified},${n===2})`).join(',\n')};
INSERT INTO neon_auth.account("accountId","providerId","userId","updatedAt") VALUES
${USERS.filter(u=>u[3]).map(([n,,,provider])=>`('acct-${n}','${provider}','${id(n)}',now())`).join(',\n')};
INSERT INTO neon_auth.session(token,"userId","expiresAt","updatedAt","impersonatedBy") VALUES
${sessions.join(',\n')};
INSERT INTO public.pool_platform_tenants(id,slug,display_name) VALUES ('${T}','audit-group','Audit Group');
INSERT INTO public.pool_platform_memberships(tenant_id,auth_user_id,role) VALUES ('${T}','${id(1)}','owner'),('${T}','${id(6)}','commissioner'),('${T}','${id(7)}','co_commissioner');
INSERT INTO public.pool_platform_pools(id,tenant_id,slug,display_name,pool_type) VALUES ('${P}','${T}','audit-survivor','Audit Survivor','survivor');
INSERT INTO public.pool_platform_seasons(id,pool_id,season,status) VALUES ('${S}','${P}',2027,'active');
INSERT INTO public.pool_platform_entries(id,season_id,entry_code,display_name,owner_auth_user_id) VALUES
('${uuid('51000000',0x100)}','${S}','A1','Audit 1','${id(1)}'),('${uuid('51000000',0x101)}','${S}','A6','Audit 6','${id(6)}');`);
    const audit=()=>{
      const rows=runKit(url,'neon-identity-audit.sql');
      // Counts only: no id, email, token or provider subject of any seeded row reaches the output.
      const text=JSON.stringify(rows);
      for(const [n,email] of USERS){
        for(const secret of [id(n),email.trim(),email.trim().toLowerCase(),`tok-${n}-`,`acct-${n}`])assert.ok(!text.includes(secret),`the audit output must not contain ${secret}`);
      }
      return Object.fromEntries(rows.map(r=>[r.check_id,[r.required,r.actual,r.ok]]));
    };
    const expected=(pending,live)=>({
      I01:[false,'total=8; verified=4; unverified=4; banned=1',null],
      I02:[false,'credential=4; google=1',null],
      I03:[false,'3 (synthetic pp-cv1-*@example.com: 2; other: 1)',null],
      I04:[false,'2',null],
      I05:[true,pending?'3 sessions of 3 users':'0 sessions of 0 users',!pending],
      I06:[true,pending?'3 sessions of 3 users':'0 sessions of 0 users',!pending],
      I07:[false,`total=${live}; of verified users with no account=2; impersonated=1`,null],
      I08:[false,'memberships=2; entries owned=1',null],
      I99:[true,pending?'STOP: I05, I06':'PASS',!pending]
    });
    // A password session of a synthetic and of an unknown pre-registered user, a session of a contested (verified,
    // password) user and one of an unverified user with no account: the audit stops on each class.
    assert.deepEqual(audit(),expected(true,6));
    // The operator revokes those users' sessions (never deletes a user): the audit passes; the users and their V1
    // standing are still reported.
    psqlSync(url,`DELETE FROM neon_auth.session s USING neon_auth."user" u WHERE u.id=s."userId"
  AND (NOT u."emailVerified" OR EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id));`);
    assert.deepEqual(audit(),expected(false,2));
    // A role that cannot read a table it counts gets an error, which is a STOP, not a pass.
    psqlSync(url,`REVOKE SELECT ON neon_auth.session FROM ${OWNER};`);
    assert.throws(()=>runKit(url,'neon-identity-audit.sql'),/permission denied for table session/);
  });
});
