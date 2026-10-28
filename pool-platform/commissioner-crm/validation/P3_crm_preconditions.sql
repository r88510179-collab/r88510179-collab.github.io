-- P3 (READ ONLY): CRM migration preconditions on the production branch, where nothing of the CRM is applied yet.
-- Run as the migration owner inside BEGIN READ ONLY; ... ROLLBACK;. One SELECT: X01 to X04 and X06 read the
-- catalogs only; X05 counts membership rows and, through neon_auth."user" and neon_auth.account, how many of the
-- legacy co-commissioners are identities the AUTH-C helpers still accept. Counts only: no id, email, token or
-- key is returned. The seven baseline fingerprints are SHA-256 of pg_proc.prosrc, reproduced from the repository
-- (002 as of 48e0ac4e, submit_entry as 003 corrected it; the hardening in 004 touches none of these seven).
WITH
expected_rpc(sig,baseline_sha256) AS (VALUES
  ('public.pool_platform_is_tenant_commissioner(uuid)','0d9d03c29d8ff189dd13819f1d76601219fa5d9675ce9061d049acb67960ef5b'),
  ('public.pool_platform_can_read_pool(uuid)','9467d14b40d59fc730b23cf2fc7ac000fd3c86eb24a1e12e807e83575bc211a6'),
  ('public.pool_platform_can_read_season(uuid)','569d2db7a38ee95a80116fdafe4fb68f9953647176ff6b6ed22da71c8233b02f'),
  ('public.pool_platform_commissioner_context(text)','2c926e8002393bfadbbe3154fca287e828ba43cb86e1b4d84443075d5b5c4ad8'),
  ('public.pool_platform_create_entry_invite(uuid,text,integer)','844b4e4f599a97735ccf54a77f5f241107eaf9f08d3e9d1358f422ba1bf5f6dc'),
  ('public.pool_platform_submit_batch(uuid,text,jsonb)','d8738a157683c5a35d899c496bea78a2bc32a651686856f999402d47ab66098c'),
  ('public.pool_platform_submit_entry(uuid,uuid,text,jsonb)','f52183734e1f8c42c401e2a507e8c82323c259486909adca49d9537eed523c8f')
),
rpc AS (
  SELECT e.sig,e.baseline_sha256,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
  FROM expected_rpc e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.sig)
),
crm_tables(relname) AS (VALUES
  ('pool_platform_staff_grants'),('pool_platform_pool_features'),('pool_platform_dues_events'),('pool_platform_crm_staff_audit')
),
crm_fn(name) AS (VALUES
  ('pool_platform_staff_can'),('pool_platform_set_staff_grants'),('pool_platform_set_dues_enabled'),
  ('pool_platform_record_dues_event'),('pool_platform_dues_immutable'),('pool_platform_crm_pools'),
  ('pool_platform_crm_dues_summary'),('pool_platform_crm_assistants'),('pool_platform_crm_update_assistant'),
  ('pool_platform_crm_add_assistant'),('pool_platform_crm_can_manage_staff')
),
found_tables AS (SELECT relname FROM crm_tables WHERE to_regclass('public.'||relname) IS NOT NULL),
found_fn AS (
  SELECT DISTINCT p.proname::text AS name FROM pg_proc p JOIN crm_fn f ON f.name=p.proname
  WHERE p.pronamespace=to_regnamespace('public')
),
pools_key AS (
  SELECT k.conname::text AS conname FROM pg_constraint k
  WHERE k.conrelid=to_regclass('public.pool_platform_pools') AND k.conname='pool_platform_pools_tenant_id_id_key'
),
co AS (
  SELECT count(*) AS memberships,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM neon_auth."user" u
           WHERE u.id::text=m.auth_user_id AND u."emailVerified" IS TRUE AND COALESCE(u.banned,false)=false
             AND NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)
         )) AS acceptable_identities
  FROM public.pool_platform_memberships m WHERE m.role='co_commissioner'
),
checks(check_id,check_name,required,expected,actual,ok) AS (
  SELECT 'X01','no CRM table exists yet',true,'none of the 4 CRM tables',
         COALESCE((SELECT string_agg(relname,', ' ORDER BY relname) FROM found_tables),'none'),
         NOT EXISTS (SELECT 1 FROM found_tables)
  UNION ALL
  SELECT 'X02','no CRM function exists yet',true,'none of the 11 CRM function names',
         COALESCE((SELECT string_agg(name,', ' ORDER BY name) FROM found_fn),'none'),
         NOT EXISTS (SELECT 1 FROM found_fn)
  UNION ALL
  SELECT 'X03','CRM constraint and index names are free',true,
         'no pool_platform_pools_tenant_id_id_key constraint and no pool_platform_staff_grants_scope_unique index',
         'constraint='||CASE WHEN EXISTS (SELECT 1 FROM pools_key) THEN 'present' ELSE 'absent' END
           ||'; index='||CASE WHEN to_regclass('public.pool_platform_staff_grants_scope_unique') IS NULL THEN 'absent' ELSE 'present' END,
         NOT EXISTS (SELECT 1 FROM pools_key) AND to_regclass('public.pool_platform_staff_grants_scope_unique') IS NULL
  UNION ALL
  SELECT 'X04','the seven RPC bodies CRM 002 replaces are the reviewed baseline bodies',true,
         'each hashes to its 48e0ac4e / 003 fingerprint (CRM 002 then overwrites only reviewed definitions)',
         (SELECT string_agg(regexp_replace(sig,'^public\.pool_platform_(.*)\(.*$','\1')||'='
                 ||CASE WHEN body_sha256=baseline_sha256 THEN 'baseline' WHEN body_sha256 IS NULL THEN 'MISSING' ELSE 'OTHER '||left(body_sha256,12) END,'; ' ORDER BY sig) FROM rpc),
         (SELECT count(*)=7 AND bool_and(body_sha256=baseline_sha256) FROM rpc)
  UNION ALL
  SELECT 'X05','legacy co-commissioner memberships (counts only)',false,
         'report: CRM 002 backfills six tenant-wide capabilities per co_commissioner membership; a membership whose identity the AUTH-C helpers refuse stays inert',
         (SELECT memberships||' membership(s); '||acceptable_identities||' with an identity the helpers accept' FROM co),NULL
  UNION ALL
  SELECT 'X06','pgcrypto in public',true,'installed in public (the rewritten create_entry_invite calls digest and gen_random_bytes unqualified)',
         COALESCE((SELECT 'installed in '||n.nspname||' '||e.extversion FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'),'MISSING'),
         COALESCE((SELECT n.nspname='public' FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'),false)
)
SELECT check_id,check_name,required,expected,actual,ok FROM checks
UNION ALL
SELECT 'X99','verdict',true,'every required row has ok = true',
       CASE WHEN bool_and(COALESCE(ok,false)) FILTER (WHERE required) THEN 'PASS'
            ELSE 'FINDINGS: '||string_agg(DISTINCT check_id,', ' ORDER BY check_id) FILTER (WHERE required AND ok IS NOT TRUE) END,
       COALESCE(bool_and(COALESCE(ok,false)) FILTER (WHERE required),false)
FROM checks
ORDER BY check_id;
