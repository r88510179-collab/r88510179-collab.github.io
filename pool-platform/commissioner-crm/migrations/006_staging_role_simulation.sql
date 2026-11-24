-- CRM-006: STAGING SIMULATION ONLY (not a real JWT integration test).
-- Transaction runner must execute all 5 statements AS ONE TRANSACTION.
-- SAVEPOINT + ROLLBACK TO SAVEPOINT guarantee no mock auth function or staff
-- assignment survives successful execution; errors abort and roll back all.
-- Never execute this against production or with a real user session.
SAVEPOINT crm_role_simulation;

CREATE OR REPLACE FUNCTION public.pool_platform_current_user_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$ SELECT NULLIF(current_setting('crm.test_actor',true),'') $$;

DO $crm_case$
DECLARE
  v_tenant uuid;
  v_comm text;
  v_assistant text;
  v_pool_a uuid;
  v_pool_b uuid;
  v_pool_other uuid;
  v_slug_a text;
  v_slug_b text;
  v_entry_b uuid;
  v_week_b uuid;
  v_count integer;
  v_msg text;
BEGIN
  SELECT m.tenant_id,m.auth_user_id INTO STRICT v_tenant,v_assistant
  FROM public.pool_platform_memberships m WHERE m.role='co_commissioner' LIMIT 1;
  SELECT m.auth_user_id INTO STRICT v_comm
  FROM public.pool_platform_memberships m
  WHERE m.tenant_id=v_tenant AND m.role IN ('owner','commissioner') LIMIT 1;
  SELECT p.id,p.slug INTO STRICT v_pool_a,v_slug_a
  FROM public.pool_platform_pools p WHERE p.tenant_id=v_tenant
  ORDER BY p.id LIMIT 1;
  SELECT p.id,p.slug INTO STRICT v_pool_b,v_slug_b
  FROM public.pool_platform_pools p WHERE p.tenant_id=v_tenant AND p.id<>v_pool_a LIMIT 1;
  SELECT p.id INTO STRICT v_pool_other FROM public.pool_platform_pools p
  WHERE p.tenant_id<>v_tenant LIMIT 1;
  SELECT e.id,w.id INTO STRICT v_entry_b,v_week_b
  FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  JOIN public.pool_platform_weeks w ON w.season_id=s.id
  WHERE s.pool_id=v_pool_b ORDER BY w.week LIMIT 1;

  PERFORM set_config('crm.test_actor',v_comm,true);
  IF NOT public.pool_platform_crm_can_manage_staff(v_tenant)
    OR NOT public.pool_platform_staff_can(v_pool_b,'review_picks')
  THEN RAISE EXCEPTION 'commissioner_rights_broken'; END IF;

  -- Narrow existing legacy all-pool assistant to exactly one pool.
  PERFORM public.pool_platform_crm_update_assistant(
    v_tenant,v_assistant,'selected',ARRAY[v_pool_a],
    ARRAY['view_pool','manage_players']
  );
  SELECT count(*) INTO v_count FROM public.pool_platform_crm_staff_audit
  WHERE tenant_id=v_tenant AND assistant_auth_user_id=v_assistant AND action='update';
  IF v_count<1 THEN RAISE EXCEPTION 'permission_audit_missing'; END IF;

  PERFORM set_config('crm.test_actor',v_assistant,true);
  IF public.pool_platform_crm_can_manage_staff(v_tenant)
    OR NOT public.pool_platform_staff_can(v_pool_a,'view_pool')
    OR public.pool_platform_staff_can(v_pool_b,'view_pool')
    OR public.pool_platform_staff_can(v_pool_a,'review_picks')
    OR public.pool_platform_staff_can(v_pool_other,'view_pool')
  THEN RAISE EXCEPTION 'pool_or_capability_leaked'; END IF;

  -- A permitted context succeeds; unassigned and foreign contexts do not.
  PERFORM public.pool_platform_commissioner_context(v_slug_a);
  BEGIN
    PERFORM public.pool_platform_commissioner_context(v_slug_b);
    RAISE EXCEPTION 'unassigned_commissioner_context_exposed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
    IF v_msg<>'commissioner_required' THEN RAISE; END IF;
  END;

  -- Trying to use old invitation and pick-write RPCs must fail BEFORE week validation.
  BEGIN
    PERFORM public.pool_platform_create_entry_invite(v_entry_b,NULL,168);
    RAISE EXCEPTION 'unassigned_invite_exposed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
    IF v_msg<>'commissioner_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_submit_entry(
      v_week_b,v_entry_b,'commissioner_manual','{}'::jsonb
    );
    RAISE EXCEPTION 'unassigned_submission_exposed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
    IF v_msg<>'commissioner_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_submit_batch(
      v_week_b,'commissioner_import','[]'::jsonb
    );
    RAISE EXCEPTION 'unassigned_batch_exposed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
    IF v_msg<>'commissioner_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_crm_assistants(v_tenant);
    RAISE EXCEPTION 'assistant_staff_directory_exposed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
    IF v_msg<>'commissioner_required' THEN RAISE; END IF;
  END;

  -- RLS is checked under the same database role used by Neon Data API callers.
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_count FROM public.pool_platform_pools WHERE id=v_pool_a;
  IF v_count<>1 THEN RAISE EXCEPTION 'assigned_pool_not_readable'; END IF;
  SELECT count(*) INTO v_count FROM public.pool_platform_pools WHERE id IN (v_pool_b,v_pool_other);
  IF v_count<>0 THEN RAISE EXCEPTION 'rls_pool_leak'; END IF;
  SELECT count(*) INTO v_count FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  WHERE s.pool_id=v_pool_b;
  IF v_count<>0 THEN RAISE EXCEPTION 'rls_entries_leak'; END IF;
  EXECUTE 'RESET ROLE';
END;
$crm_case$;

ROLLBACK TO SAVEPOINT crm_role_simulation;

RELEASE SAVEPOINT crm_role_simulation;
