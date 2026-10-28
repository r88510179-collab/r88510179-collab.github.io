-- CRM-009: READ ONLY catalog baseline for the Commissioner CRM additions. Companion to the AUTH-C verifier
-- (pool-platform/validation/neon-catalog-verify.sql), which stays unchanged for AUTH-C acceptance.
-- Run after CRM 001, 002, 003 and 005 on a post-AUTH-C branch (migration 004 applied), as the migration owner.
-- It is one SELECT over the system catalogs: it writes nothing and can be wrapped in BEGIN READ ONLY; ... ROLLBACK;.
--
-- After the CRM additions the AUTH-C verifier reports, by design, exactly these findings and no others:
-- C02 and C03 (13 tables, all with RLS), C08 (2 triggers), C09 (13 policies), C10 (25 functions), C11 and C12
-- (9 more authenticated EXECUTE grants), C14 (13 table ACL entries). K12 below recomputes those expectations so a
-- reviewer can see the two files agree; any other AUTH-C finding is real and stops the release.
--
-- required = true  -> a gate: ok must be true.    required = false -> informational.    K99 is the verdict.
WITH
ver AS (SELECT current_setting('server_version_num')::int AS num),
pub AS (SELECT to_regnamespace('public')::oid AS oid),
expected_tables(relname,policy) AS (VALUES
  ('pool_platform_staff_grants','pool_platform_staff_grants_read'),
  ('pool_platform_pool_features','pool_platform_pool_features_read'),
  ('pool_platform_dues_events','pool_platform_dues_events_read'),
  ('pool_platform_crm_staff_audit','pool_platform_crm_staff_audit_read')
),
-- rpc: EXECUTE for authenticated only. internal: nobody but the owner (the trigger function, and the un-audited
-- grant writer that 005 withdrew from authenticated).
expected_fn(signature,kind) AS (VALUES
  ('pool_platform_staff_can(uuid, text)','rpc'),
  ('pool_platform_set_staff_grants(uuid, text, text, uuid[], text[])','internal'),
  ('pool_platform_set_dues_enabled(uuid, boolean)','rpc'),
  ('pool_platform_record_dues_event(uuid, text, bigint, text)','rpc'),
  ('pool_platform_dues_immutable()','internal'),
  ('pool_platform_crm_pools()','rpc'),
  ('pool_platform_crm_dues_summary(uuid)','rpc'),
  ('pool_platform_crm_assistants(uuid)','rpc'),
  ('pool_platform_crm_update_assistant(uuid, text, text, uuid[], text[])','rpc'),
  ('pool_platform_crm_add_assistant(uuid, text, text, uuid[], text[])','rpc'),
  ('pool_platform_crm_can_manage_staff(uuid)','rpc')
),
-- The three AUTH-C identity helpers: no CRM file redefines them, so their bodies must still be 004's hardened ones.
expected_helper(sig,hardened) AS (VALUES
  ('public.pool_platform_current_user_id()','001b760143c8affb11125394a7cf0f5b2f52fe6b24bde10a61ed5056357dd8c8'),
  ('public.pool_platform_current_user_email()','b605c8f54b4b386607aff82a6fc92b70b116362462052f697e7671a3ee0974da'),
  ('public.pool_platform_current_user_has_verified_email(text)','7615a729ee19823e61363351fcd03a15b94f2bc74948d4509fc0a17f493e2271')
),
owner AS (SELECT c.relowner AS oid FROM pg_class c WHERE c.oid=to_regclass('public.pool_platform_pools')),
tbl AS (
  SELECT c.oid,e.relname,e.policy,c.relrowsecurity,c.relowner,c.relacl
  FROM expected_tables e
  LEFT JOIN pg_class c ON c.relnamespace=(SELECT oid FROM pub) AND c.relkind IN ('r','p') AND c.relname=e.relname
),
present AS (SELECT * FROM tbl WHERE oid IS NOT NULL),
fn AS (
  SELECT p.oid,e.signature,e.kind,p.prosecdef,p.proconfig,p.proowner,p.proacl
  FROM expected_fn e
  LEFT JOIN pg_proc p ON p.pronamespace=(SELECT oid FROM pub)
    AND p.proname||'('||oidvectortypes(p.proargtypes)||')'=e.signature
),
fn_present AS (SELECT * FROM fn WHERE oid IS NOT NULL),
privs(priv) AS (
  SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
  UNION ALL SELECT 'MAINTAIN' FROM ver WHERE num>=170000
),
tpriv AS (
  SELECT t.relname,r.role,pv.priv,has_table_privilege(r.role,t.oid,pv.priv) AS has
  FROM present t CROSS JOIN (VALUES ('anonymous'),('authenticated')) r(role) CROSS JOIN privs pv
),
tacl AS (
  SELECT t.relname,
         CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,
         a.privilege_type,a.is_grantable,pg_get_userbyid(a.grantor)::text AS grantor
  FROM present t CROSS JOIN LATERAL aclexplode(COALESCE(t.relacl,acldefault('r',t.relowner))) a
  WHERE a.grantee<>t.relowner
),
cpriv AS (
  SELECT t.relname,r.role,p.priv
  FROM present t CROSS JOIN (VALUES ('anonymous'),('authenticated')) r(role)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(priv)
  WHERE has_any_column_privilege(r.role,t.oid,p.priv) AND NOT (r.role='authenticated' AND p.priv='SELECT')
),
cacl AS (
  SELECT t.relname||'.'||quote_ident(a.attname) AS col
  FROM present t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
  WHERE a.attacl IS NOT NULL
),
fpriv AS (
  SELECT f.signature,f.kind,
         has_function_privilege('public',f.oid,'EXECUTE') AS pub,
         has_function_privilege('anonymous',f.oid,'EXECUTE') AS anon,
         has_function_privilege('authenticated',f.oid,'EXECUTE') AS auth
  FROM fn_present f
),
facl AS (
  SELECT f.signature,f.kind,
         CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,
         a.privilege_type,a.is_grantable
  FROM fn_present f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE a.grantee<>f.proowner
),
pol AS (
  SELECT t.relname,p.polname::text AS polname,p.polcmd::text AS polcmd,p.polpermissive,
         ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r ORDER BY 1) AS roles,
         p.polname=t.policy AS expected
  FROM pg_policy p JOIN present t ON t.oid=p.polrelid
),
trg AS (
  SELECT t.relname,tg.tgname::text AS tgname,tg.tgtype,tg.tgenabled::text AS tgenabled,
         tg.tgfoid=to_regprocedure('public.pool_platform_dues_immutable()') AS right_fn
  FROM pg_trigger tg JOIN present t ON t.oid=tg.tgrelid
  WHERE NOT tg.tgisinternal
),
seq AS (
  SELECT c.oid,c.relname::text AS relname,c.relowner,c.relacl
  FROM pg_class c
  WHERE c.relnamespace=(SELECT oid FROM pub) AND c.relkind='S' AND c.relname LIKE 'pool\_platform\_crm\_%'
),
spriv AS (
  SELECT s.relname,r.role FROM seq s CROSS JOIN (VALUES ('anonymous'),('authenticated')) r(role)
  WHERE has_sequence_privilege(r.role,s.oid,'USAGE,SELECT,UPDATE')
),
sacl AS (
  SELECT s.relname,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee
  FROM seq s CROSS JOIN LATERAL aclexplode(COALESCE(s.relacl,acldefault('s',s.relowner))) a
  WHERE a.grantee<>s.relowner
),
helpers AS (
  SELECT h.sig,h.hardened,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
  FROM expected_helper h LEFT JOIN pg_proc p ON p.oid=to_regprocedure(h.sig)
),
rewritten AS (
  SELECT n.name,lower(coalesce(pg_get_functiondef(to_regprocedure(n.sig)),'')) AS def
  FROM (VALUES
    ('is_tenant_commissioner','public.pool_platform_is_tenant_commissioner(uuid)'),
    ('can_read_pool','public.pool_platform_can_read_pool(uuid)'),
    ('can_read_season','public.pool_platform_can_read_season(uuid)'),
    ('commissioner_context','public.pool_platform_commissioner_context(text)'),
    ('create_entry_invite','public.pool_platform_create_entry_invite(uuid,text,integer)'),
    ('submit_entry','public.pool_platform_submit_entry(uuid,uuid,text,jsonb)'),
    ('submit_batch','public.pool_platform_submit_batch(uuid,text,jsonb)')
  ) n(name,sig)
),
pools_unique AS (
  SELECT k.conname::text AS conname,pg_get_constraintdef(k.oid) AS def
  FROM pg_constraint k WHERE k.conrelid=to_regclass('public.pool_platform_pools') AND k.contype='u'
),
scope_idx AS (
  SELECT pg_get_indexdef(i.indexrelid) AS def,i.indisunique,i.indisvalid,i.indnullsnotdistinct
  FROM pg_index i WHERE i.indexrelid=to_regclass('public.pool_platform_staff_grants_scope_unique')
),
legacy AS (
  SELECT count(*) AS lost FROM public.pool_platform_memberships m
  WHERE m.role='co_commissioner' AND EXISTS (
    SELECT 1 FROM (VALUES ('view_pool'),('manage_players'),('review_picks'),('edit_rules'),('send_updates'),('share_cards')) AS c(capability)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.pool_platform_staff_grants g
      WHERE g.tenant_id=m.tenant_id AND g.auth_user_id=m.auth_user_id AND g.pool_id IS NULL AND g.capability=c.capability
    )
  )
),
-- What the AUTH-C verifier will count after the CRM additions (its C02, C08, C09, C10, C11, C12 and C14 rows).
totals AS (
  SELECT (SELECT count(*) FROM pg_class c WHERE c.relnamespace=(SELECT oid FROM pub) AND c.relkind IN ('r','p') AND c.relname LIKE 'pool\_platform\_%') AS tables,
         (SELECT count(*) FROM pg_proc p WHERE p.pronamespace=(SELECT oid FROM pub) AND p.proname LIKE 'pool\_platform\_%') AS functions,
         (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace=(SELECT oid FROM pub) AND c.relname LIKE 'pool\_platform\_%') AS policies,
         (SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid WHERE c.relnamespace=(SELECT oid FROM pub) AND c.relname LIKE 'pool\_platform\_%' AND NOT tg.tgisinternal) AS triggers,
         (SELECT count(*) FROM pg_proc p WHERE p.pronamespace=(SELECT oid FROM pub) AND p.proname LIKE 'pool\_platform\_%' AND has_function_privilege('authenticated',p.oid,'EXECUTE')) AS auth_execute
),
checks AS (
  SELECT 'K01' AS check_id,'CRM tables' AS check_name,true AS required,'the 4 CRM tables exist with RLS enabled, owned by the commercial table owner' AS expected,
         (SELECT count(*)||'/4 present; '||count(*) FILTER (WHERE relrowsecurity)||' with RLS'
                 ||COALESCE('; missing: '||string_agg(relname,', ' ORDER BY relname) FILTER (WHERE oid IS NULL),'')
                 ||COALESCE('; other owner: '||string_agg(relname,', ' ORDER BY relname) FILTER (WHERE oid IS NOT NULL AND relowner<>(SELECT oid FROM owner)),'')
          FROM tbl) AS actual,
         (SELECT count(*)=4 AND bool_and(relrowsecurity) AND bool_and(relowner=(SELECT oid FROM owner)) FROM present) AS ok
  UNION ALL
  SELECT 'K02','CRM RLS policies',true,'exactly the 4 reviewed policies, one per CRM table, each permissive FOR SELECT TO authenticated',
         (SELECT count(*)||' policies'
                 ||COALESCE('; missing: '||(SELECT string_agg(e.relname||'.'||e.policy,', ' ORDER BY e.relname) FROM expected_tables e
                                            WHERE NOT EXISTS (SELECT 1 FROM pol p WHERE p.relname=e.relname AND p.polname=e.policy)),'')
                 ||COALESCE('; unexpected or changed: '||string_agg(relname||'.'||polname||' cmd='||polcmd||' permissive='||polpermissive||' roles='||array_to_string(roles,'+'),', ' ORDER BY relname,polname)
                                            FILTER (WHERE NOT (expected AND polcmd='r' AND polpermissive AND roles=ARRAY['authenticated'])),'')
          FROM pol),
         (SELECT count(*)=4 AND count(*) FILTER (WHERE expected AND polcmd='r' AND polpermissive AND roles=ARRAY['authenticated'])=4 FROM pol)
  UNION ALL
  SELECT 'K03','CRM table privileges (effective; MAINTAIN included on PostgreSQL 17+)',true,
         'anonymous: none; authenticated: SELECT only',
         COALESCE((SELECT string_agg(role||':'||priv||' on '||relname,'; ' ORDER BY role,priv,relname) FROM tpriv WHERE has<>(role='authenticated' AND priv='SELECT')),'as expected'),
         (SELECT count(*)=4 FROM present) AND NOT EXISTS (SELECT 1 FROM tpriv WHERE has<>(role='authenticated' AND priv='SELECT'))
  UNION ALL
  SELECT 'K04','CRM table ACL entries (non-owner)',true,
         'exactly authenticated:SELECT (no grant option), granted by the table owner, on each of the 4 tables',
         COALESCE((SELECT string_agg(relname||' -> '||grantee||':'||privilege_type||CASE WHEN is_grantable THEN '+grant_option' ELSE '' END||' by '||grantor,'; ' ORDER BY relname,grantee,privilege_type) FROM tacl
                   WHERE NOT (grantee='authenticated' AND privilege_type='SELECT' AND NOT is_grantable AND grantor=pg_get_userbyid((SELECT oid FROM owner)))),'as expected'),
         NOT EXISTS (SELECT 1 FROM tacl WHERE NOT (grantee='authenticated' AND privilege_type='SELECT' AND NOT is_grantable AND grantor=pg_get_userbyid((SELECT oid FROM owner))))
         AND (SELECT count(*) FROM tacl)=4 AND (SELECT count(DISTINCT relname) FROM tacl)=4
  UNION ALL
  SELECT 'K05','CRM functions',true,
         'all 11 reviewed signatures; 10 SECURITY DEFINER with search_path pg_catalog, public, neon_auth, pg_temp; the trigger function not SECURITY DEFINER; all owned by the table owner',
         (SELECT count(*)||'/11 present; '||count(*) FILTER (WHERE prosecdef)||' SECURITY DEFINER; '
                 ||count(*) FILTER (WHERE prosecdef AND array_to_string(proconfig,',')='search_path=pg_catalog, public, neon_auth, pg_temp')||' with the pinned search_path; '
                 ||count(*) FILTER (WHERE proowner=(SELECT oid FROM owner))||' owned by the table owner'
                 ||COALESCE('; missing: '||(SELECT string_agg(signature,', ' ORDER BY signature) FROM fn WHERE oid IS NULL),'')
          FROM fn_present),
         (SELECT count(*)=11
                 AND count(*) FILTER (WHERE prosecdef AND array_to_string(proconfig,',')='search_path=pg_catalog, public, neon_auth, pg_temp')=10
                 AND bool_and(prosecdef=(signature<>'pool_platform_dues_immutable()'))
                 AND bool_and(proowner=(SELECT oid FROM owner))
          FROM fn_present)
  UNION ALL
  SELECT 'K06','CRM function EXECUTE (effective)',true,
         'internal: nobody but the owner; rpc: authenticated only (not PUBLIC, not anonymous)',
         COALESCE((SELECT string_agg(signature||' public='||pub||' anonymous='||anon||' authenticated='||auth,'; ' ORDER BY signature) FROM fpriv
                   WHERE NOT ((kind='internal' AND NOT pub AND NOT anon AND NOT auth) OR (kind='rpc' AND NOT pub AND NOT anon AND auth))),'as expected'),
         (SELECT count(*)=11 FROM fn_present)
         AND NOT EXISTS (SELECT 1 FROM fpriv WHERE NOT ((kind='internal' AND NOT pub AND NOT anon AND NOT auth) OR (kind='rpc' AND NOT pub AND NOT anon AND auth)))
  UNION ALL
  SELECT 'K07','CRM function ACL entries (non-owner)',true,
         'exactly authenticated:EXECUTE (no grant option) on each of the 9 rpc functions; nothing else',
         COALESCE((SELECT string_agg(signature||' -> '||grantee||':'||privilege_type||CASE WHEN is_grantable THEN '+grant_option' ELSE '' END,'; ' ORDER BY signature,grantee) FROM facl
                   WHERE NOT (kind='rpc' AND grantee='authenticated' AND privilege_type='EXECUTE' AND NOT is_grantable)),'as expected'),
         NOT EXISTS (SELECT 1 FROM facl WHERE NOT (kind='rpc' AND grantee='authenticated' AND privilege_type='EXECUTE' AND NOT is_grantable))
         AND (SELECT count(*) FROM facl WHERE kind='rpc' AND grantee='authenticated')=9
  UNION ALL
  SELECT 'K08','user triggers on CRM tables',true,
         'exactly pool_platform_dues_events_immutable on pool_platform_dues_events: BEFORE UPDATE OR DELETE FOR EACH ROW (tgtype 27), enabled, pool_platform_dues_immutable()',
         COALESCE((SELECT string_agg(relname||'.'||tgname||' tgtype='||tgtype||' enabled='||tgenabled||' right_fn='||right_fn,'; ' ORDER BY relname,tgname) FROM trg),'none'),
         (SELECT count(*)=1 AND bool_and(relname='pool_platform_dues_events' AND tgname='pool_platform_dues_events_immutable' AND tgtype=27 AND tgenabled='O' AND right_fn) FROM trg)
  UNION ALL
  SELECT 'K09','composite pool key and grant scope index',true,
         'UNIQUE (tenant_id, id) on pool_platform_pools; pool_platform_staff_grants_scope_unique unique, valid, NULLS NOT DISTINCT',
         COALESCE((SELECT string_agg(conname||' '||def,'; ' ORDER BY conname) FROM pools_unique),'no unique constraint')
           ||'; scope index: '||COALESCE((SELECT 'unique='||indisunique||' valid='||indisvalid||' nulls_not_distinct='||indnullsnotdistinct FROM scope_idx),'MISSING'),
         EXISTS (SELECT 1 FROM pools_unique WHERE conname='pool_platform_pools_tenant_id_id_key' AND def='UNIQUE (tenant_id, id)')
         AND COALESCE((SELECT indisunique AND indisvalid AND indnullsnotdistinct FROM scope_idx),false)
  UNION ALL
  SELECT 'K10','CRM sequence privileges',true,
         'the audit identity sequence: no non-owner ACL entry and no USAGE, SELECT or UPDATE for anonymous/authenticated',
         (SELECT count(*)||' sequence(s)' FROM seq)
           ||COALESCE('; ACL: '||(SELECT string_agg(relname||' -> '||grantee,', ' ORDER BY relname,grantee) FROM sacl),'')
           ||COALESCE('; effective: '||(SELECT string_agg(role||' on '||relname,', ' ORDER BY role,relname) FROM spriv),''),
         (SELECT count(*)=1 FROM seq) AND NOT EXISTS (SELECT 1 FROM sacl) AND NOT EXISTS (SELECT 1 FROM spriv)
  UNION ALL
  SELECT 'K11','AUTH-C identity helpers untouched and RPC scope rewritten',true,
         'the three helper bodies hash to 004''s hardened column; context, invite, submit_entry and submit_batch check pool_platform_staff_can and not pool_platform_is_tenant_commissioner; can_read_pool/season use staff_can; is_tenant_commissioner excludes co_commissioner',
         (SELECT string_agg(regexp_replace(sig,'^public\.pool_platform_','')||'='||CASE WHEN body_sha256=hardened THEN 'hardened' WHEN body_sha256 IS NULL THEN 'MISSING' ELSE 'OTHER '||left(body_sha256,12) END,'; ' ORDER BY sig) FROM helpers)
           ||'; '||(SELECT string_agg(name||'='||CASE
                 WHEN name='is_tenant_commissioner' THEN (def NOT LIKE '%co_commissioner%' AND def LIKE '%commissioner%')::text
                 WHEN name IN ('can_read_pool','can_read_season') THEN (def LIKE '%pool_platform_staff_can%' AND def LIKE '%view_pool%')::text
                 ELSE (def LIKE '%pool_platform_staff_can%' AND def NOT LIKE '%pool_platform_is_tenant_commissioner%')::text END,'; ' ORDER BY name) FROM rewritten),
         (SELECT bool_and(body_sha256=hardened) FROM helpers)
         AND (SELECT bool_and(CASE
                 WHEN name='is_tenant_commissioner' THEN def NOT LIKE '%co_commissioner%' AND def LIKE '%commissioner%'
                 WHEN name IN ('can_read_pool','can_read_season') THEN def LIKE '%pool_platform_staff_can%' AND def LIKE '%view_pool%'
                 ELSE def LIKE '%pool_platform_staff_can%' AND def NOT LIKE '%pool_platform_is_tenant_commissioner%' END) FROM rewritten)
  UNION ALL
  SELECT 'K12','what the AUTH-C verifier will count',true,
         '13 pool_platform_* tables, 25 functions, 13 policies, 2 user triggers, 19 authenticated EXECUTE grants: its C02, C03, C08, C09, C10, C11, C12 and C14 findings are then the CRM additions and nothing else',
         'tables='||tables||' functions='||functions||' policies='||policies||' triggers='||triggers||' authenticated_execute='||auth_execute,
         tables=13 AND functions=25 AND policies=13 AND triggers=2 AND auth_execute=19
  FROM totals
  UNION ALL
  SELECT 'K13','column privileges on CRM tables',true,
         'no column ACL entries; no column INSERT, UPDATE or REFERENCES for anonymous/authenticated; no column SELECT for anonymous',
         COALESCE((SELECT string_agg(col,', ' ORDER BY col) FROM cacl),'no column ACLs')
           ||COALESCE('; effective: '||(SELECT string_agg(role||':'||priv||' on '||relname,'; ' ORDER BY role,priv,relname) FROM cpriv),''),
         NOT EXISTS (SELECT 1 FROM cacl) AND NOT EXISTS (SELECT 1 FROM cpriv)
  UNION ALL
  SELECT 'K14','legacy co-commissioner access preserved',true,
         'every co_commissioner membership holds the six tenant-wide capabilities (002 backfill); record_dues is never implied',
         (SELECT lost||' co-commissioner membership(s) missing a backfilled capability' FROM legacy),
         (SELECT lost=0 FROM legacy)
)
SELECT check_id,check_name,required,expected,actual,ok FROM checks
UNION ALL
SELECT 'K99','verdict',true,'every required row has ok = true',
       CASE WHEN bool_and(COALESCE(ok,false)) FILTER (WHERE required) THEN 'PASS'
            ELSE 'FINDINGS: '||string_agg(DISTINCT check_id,', ' ORDER BY check_id) FILTER (WHERE required AND ok IS NOT TRUE) END,
       COALESCE(bool_and(COALESCE(ok,false)) FILTER (WHERE required),false)
FROM checks
ORDER BY check_id;
