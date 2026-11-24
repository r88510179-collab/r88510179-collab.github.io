-- CRM-004: staging-only read-only invariant checks.
-- Run after 001, 002 and 003. Fail the transaction if protections regress.
DO $crm_test$
DECLARE
  v_n integer;
  v_fn text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname='public' AND c.relname IN
    ('pool_platform_staff_grants','pool_platform_pool_features','pool_platform_dues_events')
    AND c.relrowsecurity;
  IF v_n<>3 THEN RAISE EXCEPTION 'crm_rls_missing'; END IF;

  IF has_table_privilege('authenticated','public.pool_platform_dues_events','INSERT')
     OR has_table_privilege('authenticated','public.pool_platform_staff_grants','INSERT')
     OR has_table_privilege('authenticated','public.pool_platform_pool_features','UPDATE')
  THEN RAISE EXCEPTION 'crm_table_direct_mutation_exposed'; END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.proname IN
    ('pool_platform_commissioner_context','pool_platform_create_entry_invite',
     'pool_platform_submit_batch','pool_platform_submit_entry')
     AND pg_get_functiondef(p.oid) NOT ILIKE '%pool_platform_is_tenant_commissioner%'
     AND pg_get_functiondef(p.oid) ILIKE '%pool_platform_staff_can%';
  IF v_n<>4 THEN RAISE EXCEPTION 'crm_old_rpc_still_tenant_scoped'; END IF;

  SELECT pg_get_functiondef(oid) INTO v_fn FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='pool_platform_is_tenant_commissioner';
  IF v_fn ILIKE '%''co_commissioner''%' THEN RAISE EXCEPTION 'crm_old_tenant_privilege'; END IF;

  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname='public'
   AND policyname IN ('pool_platform_tenant_read','pool_platform_entry_read',
     'pool_platform_invite_read','pool_platform_submission_read','pool_platform_audit_read')
     AND qual ILIKE '%pool_platform_staff_can%';
  IF v_n<>5 THEN RAISE EXCEPTION 'crm_read_policies_not_scoped'; END IF;

  SELECT count(*) INTO v_n FROM public.pool_platform_memberships m
  WHERE m.role='co_commissioner' AND EXISTS (
    SELECT 1 FROM (VALUES ('view_pool'),('manage_players'),('review_picks'),
       ('edit_rules'),('send_updates'),('share_cards')) AS c(capability)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.pool_platform_staff_grants g
      WHERE g.tenant_id=m.tenant_id AND g.auth_user_id=m.auth_user_id
        AND g.pool_id IS NULL AND g.capability=c.capability
    )
  );
  IF v_n>0 THEN RAISE EXCEPTION 'crm_existing_assistant_access_lost'; END IF;

  IF NOT pg_has_role('authenticated','USAGE') AND NOT EXISTS (
     SELECT 1 FROM pg_roles WHERE rolname='authenticated'
  ) THEN RAISE EXCEPTION 'crm_auth_role_missing'; END IF;

  SELECT count(*) INTO v_n FROM information_schema.routine_privileges
  WHERE routine_schema='public' AND grantee='authenticated'
   AND routine_name IN ('pool_platform_crm_pools','pool_platform_crm_dues_summary',
     'pool_platform_set_staff_grants','pool_platform_record_dues_event');
  IF v_n<>4 THEN RAISE EXCEPTION 'crm_rpc_execute_grants_missing'; END IF;

  IF public.pool_platform_staff_can('00000000-0000-0000-0000-000000000000'::uuid,'view_pool')
  THEN RAISE EXCEPTION 'crm_unknown_pool_allowed'; END IF;
END;
$crm_test$;
