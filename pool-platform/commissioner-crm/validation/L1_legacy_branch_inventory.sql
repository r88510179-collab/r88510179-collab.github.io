-- L1 (READ ONLY): what the legacy CRM validation branch (br-orange-forest-b5nyu8ov, cloned from production on
-- 2026-10-23 before the AUTH-C window) holds, captured once before the branch is retired. Catalog and CRM-table
-- row counts only: it never reads neon_auth (users, accounts, sessions, keys), and it returns no id, email, token
-- or key. Run as the migration owner inside BEGIN READ ONLY; ... ROLLBACK;. Every row is informational; the
-- expected values restate what the CRM README and PR #19 recorded for this branch.
WITH
helper(sig,pre_hardening,hardened) AS (VALUES
  ('public.pool_platform_current_user_id()','7702b14277266031188e451f3245a76b99b5a7a68153ed11075fe7356e932b5d','001b760143c8affb11125394a7cf0f5b2f52fe6b24bde10a61ed5056357dd8c8'),
  ('public.pool_platform_current_user_email()','2cf7b7b80696acc8b22486daaff2a0cfa26f1f9fecab991fcd823d17a64db3c5','b605c8f54b4b386607aff82a6fc92b70b116362462052f697e7671a3ee0974da'),
  ('public.pool_platform_current_user_has_verified_email(text)','5120424105ba729e50e82bfd365720ef31a2f1eb323afe66da36b2cf8fb1f0c3','7615a729ee19823e61363351fcd03a15b94f2bc74948d4509fc0a17f493e2271')
),
helper_state AS (
  SELECT h.sig,CASE WHEN p.oid IS NULL THEN 'MISSING'
                    WHEN encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=h.pre_hardening THEN 'pre-hardening (expected on this branch)'
                    WHEN encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=h.hardened THEN 'hardened'
                    ELSE 'OTHER '||left(encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),12) END AS state
  FROM helper h LEFT JOIN pg_proc p ON p.oid=to_regprocedure(h.sig)
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
counts AS (
  SELECT (SELECT count(*) FROM public.pool_platform_staff_grants) AS staff_grants,
         (SELECT count(*) FROM public.pool_platform_staff_grants WHERE pool_id IS NULL) AS tenant_wide_grants,
         (SELECT count(*) FROM public.pool_platform_pool_features) AS pool_features,
         (SELECT count(*) FROM public.pool_platform_dues_events) AS dues_events,
         (SELECT count(*) FROM public.pool_platform_crm_staff_audit) AS staff_audit,
         (SELECT count(*) FROM public.pool_platform_memberships WHERE role='co_commissioner') AS co_commissioners
  WHERE to_regclass('public.pool_platform_staff_grants') IS NOT NULL
    AND to_regclass('public.pool_platform_pool_features') IS NOT NULL
    AND to_regclass('public.pool_platform_dues_events') IS NOT NULL
    AND to_regclass('public.pool_platform_crm_staff_audit') IS NOT NULL
)
SELECT 'L01' AS item,'CRM tables present' AS name,
       'all 4 (001 and 005 were applied here)' AS expected,
       (SELECT count(*)||'/4: '||COALESCE(string_agg(relname,', ' ORDER BY relname),'none') FROM crm_tables WHERE to_regclass('public.'||relname) IS NOT NULL) AS actual
UNION ALL
SELECT 'L02','CRM functions present','all 11',
       (SELECT count(DISTINCT p.proname)||'/11' FROM pg_proc p JOIN crm_fn f ON f.name=p.proname WHERE p.pronamespace=to_regnamespace('public'))
UNION ALL
SELECT 'L03','identity helpers','pre-hardening on all three (the branch predates 004)',
       (SELECT string_agg(regexp_replace(sig,'^public\.pool_platform_','')||'='||state,'; ' ORDER BY sig) FROM helper_state)
UNION ALL
SELECT 'L04','pool-scoped RPCs','the four commissioner RPCs reference pool_platform_staff_can (CRM 002 was applied here)',
       (SELECT count(*)||'/4 reference staff_can' FROM pg_proc p
        WHERE p.pronamespace=to_regnamespace('public')
          AND p.proname IN ('pool_platform_commissioner_context','pool_platform_create_entry_invite','pool_platform_submit_batch','pool_platform_submit_entry')
          AND pg_get_functiondef(p.oid) ILIKE '%pool_platform_staff_can%')
UNION ALL
SELECT 'L05','CRM row counts',
       'staff_grants = six tenant-wide backfilled grants per legacy co-commissioner; pool_features 0; dues_events 0 (007 rolled back); staff_audit 0 (006 rolled back)',
       COALESCE((SELECT 'staff_grants='||staff_grants||' (tenant-wide '||tenant_wide_grants||'); pool_features='||pool_features||'; dues_events='||dues_events
                        ||'; staff_audit='||staff_audit||'; co_commissioner memberships='||co_commissioners FROM counts),'CRM tables absent')
UNION ALL
SELECT 'L06','release gate 008 on this branch (run separately)',
       '15 PASS / 4 FAIL: the three AUTH-C rows and the new assistant-enrollment row fail here by design (pre-004 branch, 005 without the account-row predicate)',
       'see the 008 output recorded beside this file'
UNION ALL
SELECT 'L07','database identity','the legacy branch, not production',
       current_database()||' as '||current_user::text||'; server '||current_setting('server_version')
ORDER BY item;
