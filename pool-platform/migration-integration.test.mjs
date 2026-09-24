import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {after,afterEach,before,describe,test} from 'node:test';

// Opt-in, end-to-end check of migrations 001 + 002 on a disposable LOCAL PostgreSQL cluster (never Neon):
//   POOL_PLATFORM_TEST_PG_CLUSTER=postgresql://postgres@127.0.0.1:5432/postgres \
//     node --test pool-platform/migration-integration.test.mjs
// The URL must be a superuser on localhost. The run creates the roles authenticated, anonymous and
// pool_platform_it_owner when missing, creates its own database and drops it afterwards. Neon Auth is stood
// in for by neon_auth."user" (columns as Neon publishes them) and auth.user_id() reading a session setting.
// Both migrations are applied as the NOLOGIN owner role under hostile default privileges (every function and
// table the owner creates in public starts out granted to anonymous and authenticated), and races use real
// concurrent psql sessions.
const CLUSTER=process.env.POOL_PLATFORM_TEST_PG_CLUSTER||'';
const SKIP=CLUSTER?false:'set POOL_PLATFORM_TEST_PG_CLUSTER to a disposable local superuser URL';
const OWNER='pool_platform_it_owner';
const DB_NAME=`pool_platform_it_${process.pid}_${Date.now().toString(36)}`;
const dbUrl=()=>{const u=new URL(CLUSTER);u.pathname=`/${DB_NAME}`;return u.toString()};
const readMigration=name=>fs.readFileSync(new URL(`./migrations/${name}`,import.meta.url),'utf8');

function psqlSync(url,sql){
  const run=spawnSync('psql',[url,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8'});
  if(run.error)throw run.error;
  assert.equal(run.status,0,run.stderr);
  return run.stdout.trim();
}

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
  racer1:uuid('00000000',0xd1),racer2:uuid('00000000',0xd2),racer3:uuid('00000000',0xd3),racer4:uuid('00000000',0xd4)
};
const UNVERIFIED=new Set(['pending','drifter','racer4']);
const T1=uuid('10000000',1),T2=uuid('10000000',2);
const SURV=uuid('20000000',1),PICK=uuid('20000000',2),RIVAL=uuid('20000000',3);
const S_SURV=uuid('30000000',1),S_PICK=uuid('30000000',2),S_RIVAL=uuid('30000000',3);
const W3=uuid('40000000',3),W4=uuid('40000000',4),W5_LOCKED=uuid('40000000',5),W6_PAST=uuid('40000000',6);
const W7_TYPED=uuid('40000000',7),W8_TYPED=uuid('40000000',8);
const K1=uuid('41000000',1),K2=uuid('41000000',2),R1=uuid('42000000',1);
const ENTRY_DEFS=[
  ['OOO','p1'],['RACE','p1'],['B1','p1'],['B2','p2'],['C','p1'],['D','p1'],['D2','p1'],['IDX','p1'],['MAP','p1'],
  ['AUTH','p1'],['INACTIVE','p1','inactive'],['ELIMINATED','p1','eliminated'],['ARCHIVED','p1','archived'],
  ['ACTIVE','p1'],['BATCH','p1'],['LOCK','p1'],['INV1',null],['INV2',null],['INV3',null],['INV4',null],
  ['RINV1',null],['RINV2',null],['RINV3',null],['TYPED','p1'],['TYPED_BATCH','p1'],['TYPED_RR','p1'],['TYPED_RR2','p1']
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
CREATE SCHEMA auth;
CREATE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('pp_test.user_id', true), '') $$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT USAGE ON SCHEMA neon_auth TO ${OWNER};
GRANT SELECT ON neon_auth."user" TO ${OWNER};
`;

function seedSql(){
  const users=Object.entries(U).map(([key,id])=>`('${id}','${key}','${key}@example.test',${!UNVERIFIED.has(key)})`).join(',\n');
  const week=(id,season,n,status,deadline,config)=>`('${id}','${season}',${n},'${status}',${deadline},${lit(config)})`;
  const entries=ENTRY_DEFS.map(([code,owner,status='active'])=>
    `('${E[code]}','${S_SURV}','${code}','Entry ${code}',${owner?`'${U[owner]}'`:'NULL'},'${status}')`).join(',\n');
  return `
INSERT INTO neon_auth."user"(id,name,email,"emailVerified") VALUES
${users};
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
  const actor=async(name,userKey)=>{
    const s=session(name);
    rowsOf(await s.run('SET ROLE authenticated'));
    rowsOf(await s.run(`SELECT set_config('pp_test.user_id','${U[userKey]}',false)`));
    return s;
  };
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
  const functionAcls=async()=>Object.fromEntries(rowsOf(await admin.run(`SELECT p.proname||'='||string_agg(g.entry,',' ORDER BY g.entry)
    FROM pg_proc p CROSS JOIN LATERAL (
      SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type||CASE WHEN a.is_grantable THEN '+grant_option' ELSE '' END AS entry
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    ) g
    WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'pool_platform_%' GROUP BY p.proname`)).map(r=>r.split('=')));

  before(()=>{
    const host=new URL(CLUSTER).hostname;
    assert.ok(['localhost','127.0.0.1','[::1]'].includes(host),`refusing non-local database host ${host}`);
    psqlSync(CLUSTER,`DO $$BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${OWNER}') THEN CREATE ROLE ${OWNER} NOLOGIN; END IF;
    END$$;`);
    psqlSync(CLUSTER,`CREATE DATABASE ${DB_NAME} OWNER ${OWNER};`);
    psqlSync(dbUrl(),STUB);
    // Hostile defaults, as a Data API environment might configure them: the migrations must still end with
    // the intended privilege matrix.
    psqlSync(dbUrl(),`ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anonymous,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT ALL ON TABLES TO anonymous,authenticated;`);
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
    const tableRights=rowsOf(await admin.run(`SELECT c.relname||':'||has_table_privilege('anonymous',c.oid,'SELECT')||':'||has_table_privilege('authenticated',c.oid,'SELECT')||':'||has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'pool_platform_%' ORDER BY 1`));
    for(const row of tableRights)assert.match(row,/:false:true:false$/,row);
    // Exact non-owner table ACLs: the hostile default granted ALL to anonymous and authenticated, and only
    // authenticated SELECT (no grant option) may remain.
    const tableAcls=rowsOf(await admin.run(`SELECT c.relname||'='||COALESCE(string_agg(g.entry,',' ORDER BY g.entry),'')
      FROM pg_class c LEFT JOIN LATERAL (
        SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type||CASE WHEN a.is_grantable THEN '+grant_option' ELSE '' END AS entry
        FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner
      ) g ON true
      WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'pool_platform_%' GROUP BY c.relname ORDER BY 1`));
    assert.equal(tableAcls.length,9);
    for(const row of tableAcls)assert.match(row,/^pool_platform_[a-z_]+=authenticated:SELECT$/,row);
    const fnRights=Object.fromEntries(rowsOf(await admin.run(`SELECT p.proname||'='||has_function_privilege('authenticated',p.oid,'EXECUTE')||','||has_function_privilege('anonymous',p.oid,'EXECUTE')||','||has_function_privilege('public',p.oid,'EXECUTE') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'pool_platform_%'`)).map(r=>r.split('=')));
    for(const internal of INTERNAL_FUNCTIONS)assert.equal(fnRights[internal],'false,false,false',internal);
    for(const rpc of AUTHENTICATED_FUNCTIONS)assert.equal(fnRights[rpc],'true,false,false',rpc);
    assert.deepEqual(await functionAcls(),EXPECTED_FUNCTION_ACLS,'default privileges granted every function to anonymous and authenticated; the migration must leave only this');
    assert.equal(await scalar(`SELECT has_schema_privilege('authenticated','public','CREATE')::text||has_schema_privilege('anonymous','public','CREATE')::text`),'falsefalse');
  });

  test('grants: re-applying 002 strips hostile pre-existing function grants, grant options and re-grants included',async()=>{
    const fns=rowsOf(await admin.run(`SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'pool_platform_%' ORDER BY 1`));
    assert.equal(fns.length,14);
    psqlSync(dbUrl(),[
      ...fns.map(f=>`GRANT EXECUTE ON FUNCTION ${f} TO PUBLIC,anonymous;\nGRANT EXECUTE ON FUNCTION ${f} TO authenticated WITH GRANT OPTION;`),
      'SET ROLE authenticated;',
      ...fns.map(f=>`GRANT EXECUTE ON FUNCTION ${f} TO anonymous;`)
    ].join('\n'));
    const hostile=await functionAcls();
    for(const name of INTERNAL_FUNCTIONS){
      for(const grant of ['PUBLIC:EXECUTE','anonymous:EXECUTE','authenticated:EXECUTE+grant_option'])assert.ok(hostile[name].split(',').includes(grant),`${name} setup: ${hostile[name]}`);
    }
    const p1=await actor('hostile_p1','p1');
    assert.equal(rowsOf(await p1.run(`SELECT public.pool_platform_payload_valid('survivor','{}'::jsonb,NULL,NULL,'{}'::jsonb)`))[0],'f','setup: the hostile grant really makes the helper callable');
    await p1.close();
    psqlSync(dbUrl(),`SET ROLE ${OWNER};\n${readMigration('002_identity_submission_rls.sql')}`);
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
