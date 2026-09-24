-- Commercial V1 Step 2 - live Neon CATALOG VERIFICATION (read-only).
-- Run on the dedicated commercial/dev branch AFTER 001 and 002 have been applied. One SELECT statement, so it
-- runs unchanged in psql, the Neon SQL Editor, or a single HTTP SQL call. It reads only catalogs.
--
-- ok = false  -> finding; report it with the actual value (severity is decided in the validation report).
-- ok = NULL   -> informational; record the value.
WITH
ver AS (SELECT current_setting('server_version_num')::int AS num),
expected_tables(name) AS (VALUES
  ('pool_platform_tenants'),('pool_platform_memberships'),('pool_platform_pools'),('pool_platform_seasons'),
  ('pool_platform_entries'),('pool_platform_weeks'),('pool_platform_submissions'),
  ('pool_platform_submission_audit'),('pool_platform_entry_invites')
),
tbl AS (
  SELECT c.oid,c.relname::text AS relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner,c.relacl
  FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND c.relname LIKE 'pool\_platform\_%'
),
internal_fn(name) AS (VALUES
  ('pool_platform_current_user_email'),('pool_platform_current_user_has_verified_email'),
  ('pool_platform_payload_valid'),('pool_platform_guard_submission_source')
),
rpc_fn(name) AS (VALUES
  ('pool_platform_current_user_id'),('pool_platform_is_tenant_commissioner'),('pool_platform_can_read_pool'),
  ('pool_platform_can_read_season'),('pool_platform_create_entry_invite'),('pool_platform_claim_entry_invite'),
  ('pool_platform_submit_entry'),('pool_platform_submit_batch'),('pool_platform_participant_context'),
  ('pool_platform_commissioner_context')
),
fn AS (
  SELECT p.oid,p.proname::text AS proname,p.prosecdef,p.proconfig,p.proowner,p.proacl,
         CASE WHEN p.proname IN (SELECT name FROM internal_fn) THEN 'internal'
              WHEN p.proname IN (SELECT name FROM rpc_fn) THEN 'rpc'
              ELSE 'unexpected' END AS kind
  FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'pool\_platform\_%'
),
owner AS (SELECT min(relowner) AS oid,count(DISTINCT relowner) AS n FROM tbl),
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
         a.privilege_type,a.is_grantable,pg_get_userbyid(a.grantor) AS grantor
  FROM tbl t CROSS JOIN LATERAL aclexplode(COALESCE(t.relacl,acldefault('r',t.relowner))) a
  WHERE a.grantee<>t.relowner
),
fpriv AS (
  SELECT f.proname,f.kind,
         has_function_privilege('public',f.oid,'EXECUTE') AS pub,
         has_function_privilege('anonymous',f.oid,'EXECUTE') AS anon,
         has_function_privilege('authenticated',f.oid,'EXECUTE') AS auth
  FROM fn f
),
facl AS (
  SELECT f.proname,f.kind,
         CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,
         a.privilege_type,a.is_grantable,pg_get_userbyid(a.grantor) AS grantor
  FROM fn f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE a.grantee<>f.proowner
),
other_fn AS (
  SELECT p.proname::text AS proname,
         has_function_privilege('anonymous',p.oid,'EXECUTE') AS anon,
         has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth
  FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace AND p.proname NOT LIKE 'pool\_platform\_%'
),
seqacl AS (
  SELECT c.relname::text AS relname,r.role,
         has_sequence_privilege(r.role,c.oid,'USAGE,SELECT,UPDATE') AS has
  FROM pg_class c CROSS JOIN (VALUES ('anonymous'),('authenticated')) r(role)
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND c.relname LIKE 'pool\_platform\_%'
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
  SELECT tg.tgname::text AS tgname,tg.tgtype,tg.tgenabled::text AS tgenabled,
         tg.tgfoid=to_regprocedure('public.pool_platform_guard_submission_source()') AS right_fn
  FROM pg_trigger tg
  WHERE tg.tgrelid=to_regclass('public.pool_platform_submissions') AND NOT tg.tgisinternal
),
pol AS (
  SELECT c.relname::text AS relname,p.polname::text AS polname,p.polcmd::text AS polcmd,p.polpermissive,
         ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r ORDER BY 1) AS roles
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'pool\_platform\_%'
),
role_flags AS (
  SELECT rolname::text AS rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname IN ('anonymous','authenticated')
)
SELECT check_id,check_name,expected,actual,ok FROM (
  SELECT 'C01' AS check_id,'server version' AS check_name,'report' AS expected,version() AS actual,NULL::boolean AS ok
  UNION ALL
  SELECT 'C02','commercial tables','exactly the 9 pool_platform_* tables',
         (SELECT count(*)||' tables'||COALESCE('; missing: '||(SELECT string_agg(name,', ') FROM expected_tables WHERE name NOT IN (SELECT relname FROM tbl)),'')
                 ||COALESCE('; unexpected: '||(SELECT string_agg(relname,', ') FROM tbl WHERE relname NOT IN (SELECT name FROM expected_tables)),'') FROM tbl),
         (SELECT count(*)=9 FROM tbl) AND NOT EXISTS (SELECT 1 FROM expected_tables WHERE name NOT IN (SELECT relname FROM tbl))
  UNION ALL
  SELECT 'C03','RLS enabled','all 9 tables',
         (SELECT count(*) FILTER (WHERE relrowsecurity)||'/'||count(*)||' enabled'
                 ||COALESCE('; disabled: '||string_agg(relname,', ') FILTER (WHERE NOT relrowsecurity),'') FROM tbl),
         (SELECT bool_and(relrowsecurity) AND count(*)=9 FROM tbl)
  UNION ALL
  SELECT 'C04','FORCE RLS','report (owner-run SECURITY DEFINER functions rely on owner bypass)',
         (SELECT count(*) FILTER (WHERE relforcerowsecurity)||'/'||count(*)||' forced' FROM tbl),NULL
  UNION ALL
  SELECT 'C05','UNIQUE (week_id, entry_id) on submissions','a unique constraint on exactly (week_id, entry_id)',
         COALESCE((SELECT string_agg(conname||' '||def,'; ') FROM submissions_unique),'MISSING'),
         EXISTS (SELECT 1 FROM submissions_unique WHERE cols=ARRAY['week_id','entry_id'])
  UNION ALL
  SELECT 'C06','global pool slug uniqueness','CREATE UNIQUE INDEX pool_platform_pool_slug_global_unique ON public.pool_platform_pools USING btree (slug); valid',
         COALESCE((SELECT def||'; valid='||indisvalid FROM idx WHERE name LIKE '%pool_slug_global_unique'),'MISSING'),
         COALESCE((SELECT def='CREATE UNIQUE INDEX pool_platform_pool_slug_global_unique ON public.pool_platform_pools USING btree (slug)'
                          AND indisunique AND indisvalid AND indisready FROM idx WHERE name LIKE '%pool_slug_global_unique'),false)
  UNION ALL
  SELECT 'C07','Survivor partial unique index',
         'CREATE UNIQUE INDEX pool_platform_submissions_survivor_team_unique ON public.pool_platform_submissions USING btree (entry_id, ((payload ->> ''team''::text))) WHERE (jsonb_typeof((payload -> ''team''::text)) = ''string''::text); valid',
         COALESCE((SELECT def||'; valid='||indisvalid FROM idx WHERE name LIKE '%survivor_team_unique'),'MISSING'),
         COALESCE((SELECT def='CREATE UNIQUE INDEX pool_platform_submissions_survivor_team_unique ON public.pool_platform_submissions USING btree (entry_id, ((payload ->> ''team''::text))) WHERE (jsonb_typeof((payload -> ''team''::text)) = ''string''::text)'
                          AND indisunique AND indisvalid AND indisready FROM idx WHERE name LIKE '%survivor_team_unique'),false)
  UNION ALL
  SELECT 'C08','source mutation trigger','pool_platform_submission_source_guard: BEFORE UPDATE FOR EACH ROW, enabled, guard function',
         COALESCE((SELECT string_agg(tgname||' tgtype='||tgtype||' enabled='||tgenabled||' guard_fn='||right_fn,'; ') FROM trg),'MISSING'),
         EXISTS (SELECT 1 FROM trg WHERE tgname='pool_platform_submission_source_guard' AND tgtype=19 AND tgenabled='O' AND right_fn)
  UNION ALL
  SELECT 'C09','RLS policies','9 policies, one per table, each permissive FOR SELECT TO authenticated only',
         (SELECT count(*)||' policies; '||COALESCE(string_agg(relname||':'||polname||':'||polcmd||':'||array_to_string(roles,'+'),', ' ORDER BY relname),'') FROM pol),
         (SELECT count(*)=9 AND count(DISTINCT relname)=9 AND bool_and(polcmd='r' AND polpermissive AND roles=ARRAY['authenticated']) FROM pol)
  UNION ALL
  SELECT 'C10','SECURITY DEFINER functions','14 pool_platform_* functions; 13 SECURITY DEFINER with a fixed search_path, owned by the table owner; trigger function not SECURITY DEFINER',
         (SELECT count(*)||' functions; '||count(*) FILTER (WHERE prosecdef)||' SECURITY DEFINER; '
                 ||count(*) FILTER (WHERE prosecdef AND array_to_string(proconfig,',') LIKE 'search_path=%')||' with search_path; '
                 ||count(*) FILTER (WHERE proowner=(SELECT oid FROM owner))||' owned by the table owner'
                 ||COALESCE('; unexpected: '||string_agg(proname,', ') FILTER (WHERE kind='unexpected'),'') FROM fn),
         (SELECT count(*)=14
                 AND count(*) FILTER (WHERE prosecdef AND array_to_string(proconfig,',') ~ '^search_path=(pg_catalog, )?public, neon_auth, pg_temp$')=13
                 AND bool_and(prosecdef=(proname<>'pool_platform_guard_submission_source'))
                 AND bool_and(proowner=(SELECT oid FROM owner))
                 AND count(*) FILTER (WHERE kind='unexpected')=0
            FROM fn) AND (SELECT n=1 FROM owner)
  UNION ALL
  SELECT 'C11','function EXECUTE matrix (effective)',
         'internal helpers: nobody but the owner; 10 RPC/RLS helpers: authenticated only (not PUBLIC, not anonymous)',
         COALESCE((SELECT string_agg(proname||' public='||pub||' anonymous='||anon||' authenticated='||auth,'; ' ORDER BY proname) FROM fpriv
                   WHERE NOT ((kind='internal' AND NOT pub AND NOT anon AND NOT auth) OR (kind='rpc' AND NOT pub AND NOT anon AND auth))),'as expected'),
         NOT EXISTS (SELECT 1 FROM fpriv
                     WHERE NOT ((kind='internal' AND NOT pub AND NOT anon AND NOT auth) OR (kind='rpc' AND NOT pub AND NOT anon AND auth)))
  UNION ALL
  SELECT 'C12','function ACL entries (non-owner, with grantor)','exactly authenticated:EXECUTE (no grant option) on the 10 RPC/RLS helpers; nothing else',
         COALESCE((SELECT string_agg(proname||' -> '||grantee||':'||privilege_type||CASE WHEN is_grantable THEN '+grant_option' ELSE '' END||' by '||grantor,'; ' ORDER BY proname,grantee) FROM facl
                   WHERE NOT (kind='rpc' AND grantee='authenticated' AND privilege_type='EXECUTE' AND NOT is_grantable)),'as expected'),
         NOT EXISTS (SELECT 1 FROM facl WHERE NOT (kind='rpc' AND grantee='authenticated' AND privilege_type='EXECUTE' AND NOT is_grantable))
         AND (SELECT count(*) FROM facl WHERE kind='rpc' AND grantee='authenticated')=10
  UNION ALL
  SELECT 'C13','table privilege matrix (effective, incl. MAINTAIN on PG17+)','anonymous: nothing; authenticated: SELECT only',
         COALESCE((SELECT string_agg(role||':'||priv||' on '||relname,'; ' ORDER BY role,priv,relname) FROM tpriv
                   WHERE has<>(role='authenticated' AND priv='SELECT')),'as expected'),
         NOT EXISTS (SELECT 1 FROM tpriv WHERE has<>(role='authenticated' AND priv='SELECT'))
  UNION ALL
  SELECT 'C14','table ACL entries (non-owner, with grantor)','exactly authenticated:SELECT (no grant option) on each of the 9 tables',
         COALESCE((SELECT string_agg(relname||' -> '||grantee||':'||privilege_type||CASE WHEN is_grantable THEN '+grant_option' ELSE '' END||' by '||grantor,'; ' ORDER BY relname,grantee,privilege_type) FROM tacl
                   WHERE NOT (grantee='authenticated' AND privilege_type='SELECT' AND NOT is_grantable)),'as expected'),
         NOT EXISTS (SELECT 1 FROM tacl WHERE NOT (grantee='authenticated' AND privilege_type='SELECT' AND NOT is_grantable))
         AND (SELECT count(*) FROM tacl WHERE grantee='authenticated' AND privilege_type='SELECT')=9
  UNION ALL
  SELECT 'C15','CREATE on schema public','anonymous=false authenticated=false',
         'anonymous='||has_schema_privilege('anonymous','public','CREATE')||' authenticated='||has_schema_privilege('authenticated','public','CREATE'),
         NOT has_schema_privilege('anonymous','public','CREATE') AND NOT has_schema_privilege('authenticated','public','CREATE')
  UNION ALL
  SELECT 'C16','pool_platform_* sequence privileges','anonymous/authenticated: no USAGE, SELECT or UPDATE (002 does not manage sequences)',
         COALESCE((SELECT string_agg(role||' on '||relname,'; ') FROM seqacl WHERE has),'none'),
         NOT EXISTS (SELECT 1 FROM seqacl WHERE has)
  UNION ALL
  SELECT 'C17','other public-schema functions callable by anonymous/authenticated',
         'none (anything listed is extra Data API RPC surface, e.g. pgcrypto created in public by 001)',
         COALESCE((SELECT count(*)||': '||string_agg(DISTINCT proname,', ') FROM other_fn WHERE anon OR auth HAVING count(*)>0),'none'),
         NOT EXISTS (SELECT 1 FROM other_fn WHERE anon OR auth)
  UNION ALL
  SELECT 'C18','pgcrypto in public','installed in public (digest/gen_random_bytes are called unqualified)',
         COALESCE((SELECT 'installed in '||n.nspname||' '||e.extversion FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'),'MISSING'),
         COALESCE((SELECT n.nspname='public' FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'),false)
  UNION ALL
  SELECT 'C19','Data API role flags','anonymous/authenticated: not superuser, no BYPASSRLS',
         COALESCE((SELECT string_agg(rolname||' super='||rolsuper||' bypassrls='||rolbypassrls||' login='||rolcanlogin,'; ' ORDER BY rolname) FROM role_flags),'MISSING'),
         (SELECT count(*)=2 AND bool_and(NOT rolsuper AND NOT rolbypassrls) FROM role_flags)
  UNION ALL
  SELECT 'C20','table owner','one owner for all 9 tables, not a Data API role',
         COALESCE((SELECT string_agg(DISTINCT pg_get_userbyid(relowner),', ') FROM tbl),'MISSING'),
         (SELECT n=1 FROM owner) AND (SELECT pg_get_userbyid(oid) NOT IN ('anonymous','authenticated') FROM owner)
) checks
ORDER BY check_id;
