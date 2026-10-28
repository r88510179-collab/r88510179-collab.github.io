-- CRM-008: READ ONLY. Run after an independently accepted and migrated AUTH-C release.
-- Every one of its 19 rows must be PASS before any CRM merge, production migration or Netlify build.
-- Do NOT fix a failure by bypassing another team's AUTH-C migration or recreating
-- its helper functions from an older migration. Never connect with real user tokens.
WITH definitions AS (
  SELECT
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_current_user_id()')),'')) AS identity_def,
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_current_user_has_verified_email(text)')),'')) AS email_def,
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_is_tenant_commissioner(uuid)')),'')) AS tenant_def,
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_can_read_pool(uuid)')),'')) AS pool_def,
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_can_read_season(uuid)')),'')) AS season_def,
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_commissioner_context(text)')),'')) AS context_def,
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_create_entry_invite(uuid,text,integer)')),'')) AS invite_def,
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_submit_entry(uuid,uuid,text,jsonb)')),'')) AS entry_def,
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_submit_batch(uuid,text,jsonb)')),'')) AS batch_def,
    lower(coalesce(pg_get_functiondef(to_regprocedure('public.pool_platform_crm_add_assistant(uuid,text,text,uuid[],text[])')),'')) AS add_def
)
SELECT test_name,
       CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result
FROM definitions, LATERAL (
 VALUES
  ('AUTH-C session subject checked',identity_def LIKE '%auth.session()%' AND identity_def LIKE '%sub%'),
  ('AUTH-C account exclusion present',identity_def LIKE '%neon_auth.account%' AND identity_def LIKE '%not exists%'),
  ('AUTH-C banned user guard present',identity_def LIKE '%banned%'),
  ('AUTH-C verified-email enforcement present',email_def LIKE '%emailverified%' AND email_def LIKE '%auth.session()%'),
  ('Co-commissioners are not tenant-wide commissioners',tenant_def NOT LIKE '%co_commissioner%' AND tenant_def LIKE '%commissioner%'),
  ('Pool read enforces scoped view',pool_def LIKE '%pool_platform_staff_can%' AND pool_def LIKE '%view_pool%'),
  ('Season read enforces scoped view',season_def LIKE '%pool_platform_staff_can%' AND season_def LIKE '%view_pool%'),
  ('Commissioner context uses scoped view',context_def LIKE '%pool_platform_staff_can%' AND context_def LIKE '%view_pool%'),
  ('Entry invitations require manage_players',invite_def LIKE '%pool_platform_staff_can%' AND invite_def LIKE '%manage_players%'),
  ('Single pick submission retains staff check',entry_def LIKE '%pool_platform_staff_can%' AND entry_def LIKE '%review_picks%'),
  ('Batch submission retains staff check',batch_def LIKE '%pool_platform_staff_can%' AND batch_def LIKE '%review_picks%'),
  ('CRM grant table RLS enabled',coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid=to_regclass('public.pool_platform_staff_grants')),false)),
  ('CRM ledger table RLS enabled',coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid=to_regclass('public.pool_platform_dues_events')),false)),
  ('CRM audit table RLS enabled',coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid=to_regclass('public.pool_platform_crm_staff_audit')),false)),
  ('Anonymous cannot read ledger',NOT coalesce(has_table_privilege('anonymous',to_regclass('public.pool_platform_dues_events'),'SELECT'),false)),
  ('Authenticated cannot write ledger directly',NOT coalesce(has_table_privilege('authenticated',to_regclass('public.pool_platform_dues_events'),'INSERT'),false)
     AND NOT coalesce(has_table_privilege('authenticated',to_regclass('public.pool_platform_dues_events'),'UPDATE'),false)),
  ('Unaudited grant writer is inaccessible',NOT coalesce(has_function_privilege('authenticated',to_regprocedure('public.pool_platform_set_staff_grants(uuid,text,text,uuid[],text[])'),'EXECUTE'),false)),
  ('Audited assistant updates are permitted',coalesce(has_function_privilege('authenticated',to_regprocedure('public.pool_platform_crm_update_assistant(uuid,text,text,uuid[],text[])'),'EXECUTE'),false)),
  ('Assistant enrollment refuses account-holding users',add_def LIKE '%neon_auth.account%' AND add_def LIKE '%not exists%')
) AS gate(test_name,passed)
ORDER BY test_name;
