-- Commercial V1 Step 2 - live Neon CATALOG VERIFICATION (read-only).
-- Run on the dedicated commercial/dev database AFTER 001 and 002 have been applied, as the migration role. It
-- is one SELECT over the system catalogs: it runs unchanged in psql, the Neon SQL Editor or a single HTTP SQL
-- call, writes nothing, and can be wrapped in BEGIN READ ONLY; ... ROLLBACK;.
--
-- required = true  -> part of the reviewed contract: ok = false is a finding; do not continue the runbook.
-- required = false -> informational: record actual (C23 is the pgcrypto surface the live Data API check covers).
-- C99 is the verdict: ok = true only when every required row has ok = true.
WITH
ver AS (SELECT current_setting('server_version_num')::int AS num),
pub AS (SELECT to_regnamespace('public')::oid AS oid),
expected_tables(relname,policy) AS (VALUES
  ('pool_platform_tenants','pool_platform_tenant_read'),
  ('pool_platform_memberships','pool_platform_membership_read'),
  ('pool_platform_pools','pool_platform_pool_read'),
  ('pool_platform_seasons','pool_platform_season_read'),
  ('pool_platform_entries','pool_platform_entry_read'),
  ('pool_platform_weeks','pool_platform_week_read'),
  ('pool_platform_submissions','pool_platform_submission_read'),
  ('pool_platform_submission_audit','pool_platform_audit_read'),
  ('pool_platform_entry_invites','pool_platform_invite_read')
),
-- internal: callable only by the owner (the trigger function and the helpers the SECURITY DEFINER functions
-- use); rpc: EXECUTE for authenticated only (the RLS helpers and the browser-callable RPCs).
expected_fn(signature,kind) AS (VALUES
  ('pool_platform_guard_submission_source()','internal'),
  ('pool_platform_current_user_email()','internal'),
  ('pool_platform_current_user_has_verified_email(text)','internal'),
  ('pool_platform_payload_valid(text, jsonb, uuid, uuid, jsonb)','internal'),
  ('pool_platform_current_user_id()','rpc'),
  ('pool_platform_is_tenant_commissioner(uuid)','rpc'),
  ('pool_platform_can_read_pool(uuid)','rpc'),
  ('pool_platform_can_read_season(uuid)','rpc'),
  ('pool_platform_create_entry_invite(uuid, text, integer)','rpc'),
  ('pool_platform_claim_entry_invite(text)','rpc'),
  ('pool_platform_submit_entry(uuid, uuid, text, jsonb)','rpc'),
  ('pool_platform_submit_batch(uuid, text, jsonb)','rpc'),
  ('pool_platform_participant_context(text, integer, integer)','rpc'),
  ('pool_platform_commissioner_context(text)','rpc')
),
tbl AS (
  SELECT c.oid,c.relname::text AS relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner,c.relacl
  FROM pg_class c
  WHERE c.relnamespace=(SELECT oid FROM pub) AND c.relkind IN ('r','p') AND c.relname LIKE 'pool\_platform\_%'
),
owner AS (SELECT min(relowner) AS oid,count(DISTINCT relowner) AS n FROM tbl),
fn AS (
  SELECT p.oid,s.signature,p.prosecdef,p.proconfig,p.proowner,p.proacl,COALESCE(e.kind,'unexpected') AS kind
  FROM pg_proc p
  CROSS JOIN LATERAL (SELECT p.proname::text||'('||oidvectortypes(p.proargtypes)||')' AS signature) s
  LEFT JOIN expected_fn e ON e.signature=s.signature
  WHERE p.pronamespace=(SELECT oid FROM pub) AND p.proname LIKE 'pool\_platform\_%'
),
-- has_table_privilege only knows MAINTAIN from PostgreSQL 17 on.
privs(priv) AS (
  SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
  UNION ALL SELECT 'MAINTAIN' FROM ver WHERE num>=170000
),
tpriv AS (
  SELECT t.relname,r.role,pv.priv,has_table_privilege(r.role,t.oid,pv.priv) AS has
  FROM tbl t CROSS JOIN (VALUES ('anonymous'),('authenticated')) r(role) CROSS JOIN privs pv
),
tacl AS (
  SELECT t.relname,
         CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,
         a.privilege_type,a.is_grantable,pg_get_userbyid(a.grantor)::text AS grantor
  FROM tbl t CROSS JOIN LATERAL aclexplode(COALESCE(t.relacl,acldefault('r',t.relowner))) a
  WHERE a.grantee<>t.relowner
),
cacl AS (
  SELECT t.relname||'.'||quote_ident(a.attname) AS col,a.attacl::text AS acl
  FROM tbl t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
  WHERE a.attacl IS NOT NULL
),
cpriv AS (
  SELECT t.relname,r.role,p.priv
  FROM tbl t CROSS JOIN (VALUES ('anonymous'),('authenticated')) r(role)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(priv)
  WHERE has_any_column_privilege(r.role,t.oid,p.priv) AND NOT (r.role='authenticated' AND p.priv='SELECT')
),
fpriv AS (
  SELECT f.signature,f.kind,
         has_function_privilege('public',f.oid,'EXECUTE') AS pub,
         has_function_privilege('anonymous',f.oid,'EXECUTE') AS anon,
         has_function_privilege('authenticated',f.oid,'EXECUTE') AS auth
  FROM fn f
),
facl AS (
  SELECT f.signature,f.kind,
         CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,
         a.privilege_type,a.is_grantable,pg_get_userbyid(a.grantor)::text AS grantor
  FROM fn f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE a.grantee<>f.proowner
),
-- Other public functions anonymous/authenticated can call, with the extension that installed them (if any).
other_fn AS (
  SELECT p.proname::text AS proname,x.extname::text AS extname
  FROM pg_proc p
  LEFT JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e'
  LEFT JOIN pg_extension x ON x.oid=d.refobjid
  WHERE p.pronamespace=(SELECT oid FROM pub) AND p.proname NOT LIKE 'pool\_platform\_%'
    AND (has_function_privilege('anonymous',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))
),
seq AS (
  SELECT c.oid,c.relname::text AS relname,c.relowner,c.relacl
  FROM pg_class c WHERE c.relnamespace=(SELECT oid FROM pub) AND c.relkind='S' AND c.relname LIKE 'pool\_platform\_%'
),
sacl AS (
  SELECT s.relname,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,a.privilege_type
  FROM seq s CROSS JOIN LATERAL aclexplode(COALESCE(s.relacl,acldefault('s',s.relowner))) a
  WHERE a.grantee<>s.relowner
),
spriv AS (
  SELECT s.relname,r.role FROM seq s CROSS JOIN (VALUES ('anonymous'),('authenticated')) r(role)
  WHERE has_sequence_privilege(r.role,s.oid,'USAGE,SELECT,UPDATE')
),
submissions_unique AS (
  SELECT k.conname::text AS conname,pg_get_constraintdef(k.oid) AS def,
         (SELECT array_agg(a.attname::text ORDER BY u.ord)
          FROM unnest(k.conkey) WITH ORDINALITY u(attnum,ord)
          JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.attnum) AS cols
  FROM pg_constraint k
  WHERE k.conrelid=to_regclass('public.pool_platform_submissions') AND k.contype='u'
),
idx AS (
  SELECT i.indexrelid::regclass::text AS name,pg_get_indexdef(i.indexrelid) AS def,i.indisunique,i.indisvalid,i.indisready
  FROM pg_index i
  WHERE i.indexrelid IN (to_regclass('public.pool_platform_pool_slug_global_unique'),
                         to_regclass('public.pool_platform_submissions_survivor_team_unique'))
),
trg AS (
  SELECT t.relname,tg.tgname::text AS tgname,tg.tgtype,tg.tgenabled::text AS tgenabled,
         tg.tgfoid=to_regprocedure('public.pool_platform_guard_submission_source()') AS right_fn
  FROM pg_trigger tg JOIN tbl t ON t.oid=tg.tgrelid
  WHERE NOT tg.tgisinternal
),
pol AS (
  SELECT t.relname,p.polname::text AS polname,p.polcmd::text AS polcmd,p.polpermissive,
         ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r ORDER BY 1) AS roles,
         EXISTS (SELECT 1 FROM expected_tables e WHERE e.relname=t.relname AND e.policy=p.polname) AS expected
  FROM pg_policy p JOIN tbl t ON t.oid=p.polrelid
),
role_flags AS (
  SELECT rolname::text AS rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname IN ('anonymous','authenticated')
),
-- The owner runs the SECURITY DEFINER identity helpers, so it must reach auth.user_id() and neon_auth."user".
owner_auth AS (
  SELECT has_schema_privilege((SELECT oid FROM owner),to_regnamespace('auth'),'USAGE')
           AND has_function_privilege((SELECT oid FROM owner),to_regprocedure('auth.user_id()'),'EXECUTE') AS user_id_ok,
         has_schema_privilege((SELECT oid FROM owner),to_regnamespace('neon_auth'),'USAGE') AS neon_auth_usage,
         (SELECT count(*) FROM unnest(ARRAY['id','email','emailVerified','banned']) c(name)
          JOIN pg_attribute a ON a.attrelid=to_regclass('neon_auth."user"') AND a.attname=c.name AND a.attnum>0 AND NOT a.attisdropped
          WHERE has_column_privilege((SELECT oid FROM owner),a.attrelid,a.attnum,'SELECT')) AS readable_columns
),
personal AS (
  SELECT 'relation '||n.nspname||'.'||c.relname AS found
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relname IN ('nfl_pool_weeks','nfl_survivor_weeks')
  UNION ALL
  SELECT 'policy '||polname FROM pg_policy WHERE polname LIKE 'nfl\_survivor\_%'
),
checks AS (
  SELECT 'C01' AS check_id,'server version' AS check_name,false AS required,'report' AS expected,
         version()||' (server_version_num '||num||')' AS actual,NULL::boolean AS ok
  FROM ver
  UNION ALL
  SELECT 'C02','commercial tables',true,'exactly the 9 pool_platform_* tables',
         (SELECT count(*)||' tables'
                 ||COALESCE('; missing: '||(SELECT string_agg(relname,', ' ORDER BY relname) FROM expected_tables WHERE relname NOT IN (SELECT relname FROM tbl)),'')
                 ||COALESCE('; unexpected: '||(SELECT string_agg(relname,', ' ORDER BY relname) FROM tbl WHERE relname NOT IN (SELECT relname FROM expected_tables)),'')
          FROM tbl),
         (SELECT count(*)=9 FROM tbl) AND NOT EXISTS (SELECT 1 FROM expected_tables WHERE relname NOT IN (SELECT relname FROM tbl))
  UNION ALL
  SELECT 'C03','RLS enabled',true,'all 9 tables',
         (SELECT count(*) FILTER (WHERE relrowsecurity)||'/'||count(*)||' enabled'
                 ||COALESCE('; disabled: '||string_agg(relname,', ' ORDER BY relname) FILTER (WHERE NOT relrowsecurity),'') FROM tbl),
         (SELECT count(*)=9 AND bool_and(relrowsecurity) FROM tbl)
  UNION ALL
  SELECT 'C04','FORCE RLS',false,'report (the owner-run SECURITY DEFINER functions rely on owner bypass)',
         (SELECT count(*) FILTER (WHERE relforcerowsecurity)||'/'||count(*)||' forced' FROM tbl),NULL
  UNION ALL
  SELECT 'C05','UNIQUE (week_id, entry_id) on submissions',true,'a unique constraint on exactly (week_id, entry_id)',
         COALESCE((SELECT string_agg(conname||' '||def,'; ' ORDER BY conname) FROM submissions_unique),'MISSING'),
         EXISTS (SELECT 1 FROM submissions_unique WHERE cols=ARRAY['week_id','entry_id'])
  UNION ALL
  SELECT 'C06','global pool slug uniqueness',true,
         'CREATE UNIQUE INDEX pool_platform_pool_slug_global_unique ON public.pool_platform_pools USING btree (slug); valid',
         COALESCE((SELECT def||'; valid='||indisvalid FROM idx WHERE name LIKE '%pool_slug_global_unique'),'MISSING'),
         COALESCE((SELECT def='CREATE UNIQUE INDEX pool_platform_pool_slug_global_unique ON public.pool_platform_pools USING btree (slug)'
                          AND indisunique AND indisvalid AND indisready FROM idx WHERE name LIKE '%pool_slug_global_unique'),false)
  UNION ALL
  SELECT 'C07','Survivor partial unique index',true,
         'CREATE UNIQUE INDEX pool_platform_submissions_survivor_team_unique ON public.pool_platform_submissions USING btree (entry_id, ((payload ->> ''team''::text))) WHERE (jsonb_typeof((payload -> ''team''::text)) = ''string''::text); valid',
         COALESCE((SELECT def||'; valid='||indisvalid FROM idx WHERE name LIKE '%survivor_team_unique'),'MISSING'),
         COALESCE((SELECT def='CREATE UNIQUE INDEX pool_platform_submissions_survivor_team_unique ON public.pool_platform_submissions USING btree (entry_id, ((payload ->> ''team''::text))) WHERE (jsonb_typeof((payload -> ''team''::text)) = ''string''::text)'
                          AND indisunique AND indisvalid AND indisready FROM idx WHERE name LIKE '%survivor_team_unique'),false)
  UNION ALL
  SELECT 'C08','user triggers on commercial tables',true,
         'exactly pool_platform_submission_source_guard on pool_platform_submissions: BEFORE UPDATE FOR EACH ROW, enabled, guard function',
         COALESCE((SELECT string_agg(relname||'.'||tgname||' tgtype='||tgtype||' enabled='||tgenabled||' guard_fn='||right_fn,'; ' ORDER BY relname,tgname) FROM trg),'none'),
         (SELECT count(*)=1 AND bool_and(relname='pool_platform_submissions' AND tgname='pool_platform_submission_source_guard'
                                         AND tgtype=19 AND tgenabled='O' AND right_fn) FROM trg)
  UNION ALL
  SELECT 'C09','RLS policies',true,'exactly the 9 reviewed policies, one per table, each permissive FOR SELECT TO authenticated',
         (SELECT count(*)||' policies'
                 ||COALESCE('; missing: '||(SELECT string_agg(e.relname||'.'||e.policy,', ' ORDER BY e.relname)
                                            FROM expected_tables e WHERE NOT EXISTS (SELECT 1 FROM pol p WHERE p.relname=e.relname AND p.polname=e.policy)),'')
                 ||COALESCE('; unexpected or changed: '||string_agg(relname||'.'||polname||' cmd='||polcmd||' permissive='||polpermissive||' roles='||array_to_string(roles,'+'),', ' ORDER BY relname,polname)
                                            FILTER (WHERE NOT (expected AND polcmd='r' AND polpermissive AND roles=ARRAY['authenticated'])),'')
          FROM pol),
         (SELECT count(*)=9 AND count(*) FILTER (WHERE expected AND polcmd='r' AND polpermissive AND roles=ARRAY['authenticated'])=9 FROM pol)
         AND NOT EXISTS (SELECT 1 FROM expected_tables e WHERE NOT EXISTS (SELECT 1 FROM pol p WHERE p.relname=e.relname AND p.polname=e.policy))
  UNION ALL
  SELECT 'C10','pool_platform_* functions',true,
         'exactly the 14 reviewed signatures; 13 SECURITY DEFINER with the pinned search_path; the trigger function not SECURITY DEFINER; all owned by the table owner',
         (SELECT count(*)||' functions; '||count(*) FILTER (WHERE prosecdef)||' SECURITY DEFINER; '
                 ||count(*) FILTER (WHERE prosecdef AND array_to_string(proconfig,',') ~ '^search_path=(pg_catalog, )?public, neon_auth, pg_temp$')||' with the pinned search_path; '
                 ||count(*) FILTER (WHERE proowner=(SELECT oid FROM owner))||' owned by the table owner'
                 ||COALESCE('; missing: '||(SELECT string_agg(signature,', ' ORDER BY signature) FROM expected_fn WHERE signature NOT IN (SELECT signature FROM fn)),'')
                 ||COALESCE('; unexpected: '||string_agg(signature,', ' ORDER BY signature) FILTER (WHERE kind='unexpected'),'')
          FROM fn),
         (SELECT count(*)=14 AND count(*) FILTER (WHERE kind='unexpected')=0
                 AND count(*) FILTER (WHERE prosecdef AND array_to_string(proconfig,',') ~ '^search_path=(pg_catalog, )?public, neon_auth, pg_temp$')=13
                 AND bool_and(prosecdef=(signature<>'pool_platform_guard_submission_source()'))
                 AND bool_and(proowner=(SELECT oid FROM owner))
          FROM fn)
         AND NOT EXISTS (SELECT 1 FROM expected_fn WHERE signature NOT IN (SELECT signature FROM fn))
         AND (SELECT n=1 FROM owner)
  UNION ALL
  SELECT 'C11','function EXECUTE (effective)',true,
         'internal helpers: nobody but the owner; the 10 RLS helpers and RPCs: authenticated only (not PUBLIC, not anonymous)',
         COALESCE((SELECT string_agg(signature||' public='||pub||' anonymous='||anon||' authenticated='||auth,'; ' ORDER BY signature) FROM fpriv
                   WHERE NOT ((kind='internal' AND NOT pub AND NOT anon AND NOT auth) OR (kind='rpc' AND NOT pub AND NOT anon AND auth))),'as expected'),
         NOT EXISTS (SELECT 1 FROM fpriv
                     WHERE NOT ((kind='internal' AND NOT pub AND NOT anon AND NOT auth) OR (kind='rpc' AND NOT pub AND NOT anon AND auth)))
  UNION ALL
  SELECT 'C12','function ACL entries (non-owner)',true,
         'exactly authenticated:EXECUTE (no grant option) on each of the 10 RLS helpers and RPCs; nothing else',
         COALESCE((SELECT string_agg(signature||' -> '||grantee||':'||privilege_type||CASE WHEN is_grantable THEN '+grant_option' ELSE '' END||' by '||grantor,'; ' ORDER BY signature,grantee) FROM facl
                   WHERE NOT (kind='rpc' AND grantee='authenticated' AND privilege_type='EXECUTE' AND NOT is_grantable)),'as expected'),
         NOT EXISTS (SELECT 1 FROM facl WHERE NOT (kind='rpc' AND grantee='authenticated' AND privilege_type='EXECUTE' AND NOT is_grantable))
         AND (SELECT count(*) FROM facl WHERE kind='rpc' AND grantee='authenticated')=10
  UNION ALL
  SELECT 'C13','table privileges (effective; MAINTAIN included on PostgreSQL 17+)',true,
         'anonymous: none of SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER (, MAINTAIN); authenticated: SELECT only',
         COALESCE((SELECT string_agg(role||':'||priv||' on '||relname,'; ' ORDER BY role,priv,relname) FROM tpriv
                   WHERE has<>(role='authenticated' AND priv='SELECT')),'as expected'),
         NOT EXISTS (SELECT 1 FROM tpriv WHERE has<>(role='authenticated' AND priv='SELECT'))
  UNION ALL
  SELECT 'C14','table ACL entries (non-owner)',true,
         'exactly authenticated:SELECT (no grant option), granted by the table owner, on each of the 9 tables; nothing for PUBLIC or anonymous',
         COALESCE((SELECT string_agg(relname||' -> '||grantee||':'||privilege_type||CASE WHEN is_grantable THEN '+grant_option' ELSE '' END||' by '||grantor,'; ' ORDER BY relname,grantee,privilege_type) FROM tacl
                   WHERE NOT (grantee='authenticated' AND privilege_type='SELECT' AND NOT is_grantable AND grantor=pg_get_userbyid((SELECT oid FROM owner)))),'as expected'),
         NOT EXISTS (SELECT 1 FROM tacl WHERE NOT (grantee='authenticated' AND privilege_type='SELECT' AND NOT is_grantable AND grantor=pg_get_userbyid((SELECT oid FROM owner))))
         AND (SELECT count(*) FROM tacl)=9 AND (SELECT count(DISTINCT relname) FROM tacl)=9
  UNION ALL
  SELECT 'C15','CREATE on schema public',true,'anonymous=false authenticated=false',
         'anonymous='||has_schema_privilege('anonymous',(SELECT oid FROM pub),'CREATE')||' authenticated='||has_schema_privilege('authenticated',(SELECT oid FROM pub),'CREATE'),
         NOT has_schema_privilege('anonymous',(SELECT oid FROM pub),'CREATE') AND NOT has_schema_privilege('authenticated',(SELECT oid FROM pub),'CREATE')
  UNION ALL
  SELECT 'C16','pool_platform_* sequence privileges',true,
         'no non-owner ACL entry and no USAGE, SELECT or UPDATE for anonymous/authenticated (002 resets the audit identity sequence)',
         (SELECT count(*)||' sequence(s)' FROM seq)
           ||COALESCE('; ACL: '||(SELECT string_agg(relname||' -> '||grantee||':'||privilege_type,', ' ORDER BY relname,grantee,privilege_type) FROM sacl),'')
           ||COALESCE('; effective: '||(SELECT string_agg(role||' on '||relname,', ' ORDER BY role,relname) FROM spriv),''),
         NOT EXISTS (SELECT 1 FROM sacl) AND NOT EXISTS (SELECT 1 FROM spriv)
  UNION ALL
  SELECT 'C17','other public functions callable by anonymous/authenticated (outside pgcrypto)',true,
         'none: anything listed is extra Data API RPC surface the review did not cover',
         COALESCE((SELECT count(*)||': '||string_agg(DISTINCT proname||COALESCE(' ('||extname||')',''),', ') FROM other_fn
                   WHERE extname IS DISTINCT FROM 'pgcrypto' HAVING count(*)>0),'none'),
         NOT EXISTS (SELECT 1 FROM other_fn WHERE extname IS DISTINCT FROM 'pgcrypto')
  UNION ALL
  SELECT 'C18','pgcrypto in public',true,'installed in public (002 calls digest and gen_random_bytes unqualified)',
         COALESCE((SELECT 'installed in '||n.nspname||' '||e.extversion FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'),'MISSING'),
         COALESCE((SELECT n.nspname='public' FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'),false)
  UNION ALL
  SELECT 'C19','Data API role flags',true,'anonymous/authenticated: present, not superuser, no BYPASSRLS',
         COALESCE((SELECT string_agg(rolname||' super='||rolsuper||' bypassrls='||rolbypassrls||' login='||rolcanlogin,'; ' ORDER BY rolname) FROM role_flags),'MISSING'),
         (SELECT count(*)=2 AND bool_and(NOT rolsuper AND NOT rolbypassrls) FROM role_flags)
  UNION ALL
  SELECT 'C20','table owner',true,'one owner for all 9 tables; not a Data API role; not a superuser',
         COALESCE((SELECT string_agg(DISTINCT r.rolname||' super='||r.rolsuper,', ') FROM tbl t JOIN pg_roles r ON r.oid=t.relowner),'MISSING'),
         COALESCE((SELECT n=1 FROM owner) AND (SELECT r.rolname NOT IN ('anonymous','authenticated') AND NOT r.rolsuper FROM pg_roles r WHERE r.oid=(SELECT oid FROM owner)),false)
  UNION ALL
  SELECT 'C21','authenticated MAINTAIN (PostgreSQL 17+)',(SELECT num>=170000 FROM ver),
         'false on every commercial table (no LOCK, VACUUM, REINDEX or CLUSTER); PostgreSQL 16 has no MAINTAIN privilege',
         CASE WHEN (SELECT num<170000 FROM ver) THEN 'not applicable before PostgreSQL 17'
              ELSE COALESCE('granted on: '||(SELECT string_agg(relname,', ' ORDER BY relname) FROM tpriv WHERE role='authenticated' AND priv='MAINTAIN' AND has),'none') END,
         CASE WHEN (SELECT num<170000 FROM ver) THEN NULL
              ELSE NOT EXISTS (SELECT 1 FROM tpriv WHERE role='authenticated' AND priv='MAINTAIN' AND has) END
  UNION ALL
  SELECT 'C22','column privileges',true,
         'no column ACL entries; no column INSERT, UPDATE or REFERENCES for anonymous/authenticated; no column SELECT for anonymous',
         COALESCE((SELECT string_agg(col||'='||acl,'; ' ORDER BY col) FROM cacl),'no column ACLs')
           ||COALESCE('; effective: '||(SELECT string_agg(role||':'||priv||' on '||relname,'; ' ORDER BY role,priv,relname) FROM cpriv),''),
         NOT EXISTS (SELECT 1 FROM cacl) AND NOT EXISTS (SELECT 1 FROM cpriv)
  UNION ALL
  SELECT 'C23','pgcrypto functions callable by anonymous/authenticated',false,
         'report: pgcrypto sits in public with the default PUBLIC EXECUTE; whether the Data API exposes them is a live check (runbook step 11)',
         (SELECT count(*)||' callable' FROM other_fn WHERE extname='pgcrypto'),NULL
  UNION ALL
  SELECT 'C24','owner can reach auth.user_id() and neon_auth."user"',true,
         'USAGE on auth and EXECUTE on auth.user_id(); USAGE on neon_auth and SELECT on id, email, "emailVerified", banned',
         'auth.user_id()='||COALESCE(user_id_ok::text,'MISSING')||'; neon_auth USAGE='||COALESCE(neon_auth_usage::text,'MISSING')||'; readable columns '||readable_columns||'/4',
         COALESCE(user_id_ok AND neon_auth_usage,false) AND readable_columns=4
  FROM owner_auth
  UNION ALL
  SELECT 'C25','authenticated USAGE on schema public',true,'true (needed to call the RPCs and read the tables)',
         has_schema_privilege('authenticated',(SELECT oid FROM pub),'USAGE')::text,
         has_schema_privilege('authenticated',(SELECT oid FROM pub),'USAGE')
  UNION ALL
  SELECT 'C26','not the personal Pool Center database',true,
         'database is not nfl_pool; no nfl_pool_weeks or nfl_survivor_weeks relation and no nfl_survivor_* policy',
         current_database()||COALESCE('; found: '||(SELECT string_agg(found,', ' ORDER BY found) FROM personal),''),
         current_database()<>'nfl_pool' AND NOT EXISTS (SELECT 1 FROM personal)
)
SELECT check_id,check_name,required,expected,actual,ok FROM checks
UNION ALL
SELECT 'C99','verdict',true,'every required row has ok = true',
       CASE WHEN bool_and(COALESCE(ok,false)) FILTER (WHERE required) THEN 'PASS'
            ELSE 'FINDINGS: '||string_agg(DISTINCT check_id,', ' ORDER BY check_id) FILTER (WHERE required AND ok IS NOT TRUE) END,
       COALESCE(bool_and(COALESCE(ok,false)) FILTER (WHERE required),false)
FROM checks
ORDER BY check_id;
