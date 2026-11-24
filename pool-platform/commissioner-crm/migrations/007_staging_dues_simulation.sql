-- CRM-007: STAGING ONLY: rollback-only manual ledger permission simulation.
-- Requires 001..005. No simulated events survive; not a real JWT integration test.
SAVEPOINT crm_dues_simulation;

CREATE OR REPLACE FUNCTION public.pool_platform_current_user_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$ SELECT NULLIF(current_setting('crm.test_actor',true),'') $$;

DO $crm_dues$
DECLARE
  v_tenant uuid;v_comm text;v_co text;v_foreign_comm text;
  v_pool uuid;v_entry uuid;v_event uuid;v_result jsonb;v_balance bigint;
  v_msg text;
BEGIN
  SELECT m.tenant_id,m.auth_user_id INTO STRICT v_tenant,v_co
  FROM public.pool_platform_memberships m WHERE m.role='co_commissioner' LIMIT 1;
  SELECT auth_user_id INTO STRICT v_comm
  FROM public.pool_platform_memberships WHERE tenant_id=v_tenant AND role IN ('owner','commissioner') LIMIT 1;
  SELECT auth_user_id INTO STRICT v_foreign_comm
  FROM public.pool_platform_memberships WHERE tenant_id<>v_tenant AND role IN ('owner','commissioner') LIMIT 1;
  SELECT p.id INTO STRICT v_pool FROM public.pool_platform_pools p WHERE p.tenant_id=v_tenant ORDER BY p.id LIMIT 1;
  SELECT e.id INTO STRICT v_entry
  FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  WHERE s.pool_id=v_pool ORDER BY s.season DESC,e.entry_code LIMIT 1;

  PERFORM set_config('crm.test_actor',v_comm,true);
  PERFORM public.pool_platform_set_dues_enabled(v_pool,true);
  PERFORM public.pool_platform_record_dues_event(v_entry,'charge',1000,'Dues owed');
  PERFORM public.pool_platform_record_dues_event(v_entry,'payment',500,'Received outside app');
  PERFORM public.pool_platform_record_dues_event(v_entry,'refund',200,'Repaid outside app');
  PERFORM public.pool_platform_record_dues_event(v_entry,'credit',100,'Adjustment');
  SELECT COALESCE(SUM(CASE WHEN kind IN ('charge','refund') THEN amount_cents ELSE -amount_cents END),0)
    INTO v_balance FROM public.pool_platform_dues_events WHERE entry_id=v_entry;
  IF v_balance<>600 THEN RAISE EXCEPTION 'ledger_calculation_bad'; END IF;
  v_result:=public.pool_platform_crm_dues_summary(v_pool);
  IF jsonb_typeof(v_result)<>'array' OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result) record
    WHERE record->>'id'=v_entry::text AND (record->>'balance_cents')::bigint=600
  ) THEN RAISE EXCEPTION 'dues_summary_bad'; END IF;

  SELECT id INTO STRICT v_event FROM public.pool_platform_dues_events WHERE entry_id=v_entry AND kind='charge' LIMIT 1;
  BEGIN
    UPDATE public.pool_platform_dues_events SET amount_cents=999 WHERE id=v_event;
    RAISE EXCEPTION 'append_only_update_failed_open';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
    IF v_msg<>'dues_history_is_append_only' THEN RAISE; END IF;
  END;

  PERFORM set_config('crm.test_actor',v_co,true);
  BEGIN
    PERFORM public.pool_platform_record_dues_event(v_entry,'payment',100,NULL);
    RAISE EXCEPTION 'assistant_without_dues_access_wrote';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
    IF v_msg<>'commissioner_required' THEN RAISE; END IF;
  END;

  PERFORM set_config('crm.test_actor',v_foreign_comm,true);
  BEGIN
    PERFORM public.pool_platform_crm_dues_summary(v_pool);
    RAISE EXCEPTION 'foreign_tenant_read_ledger';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
    IF v_msg<>'commissioner_required' THEN RAISE; END IF;
  END;

  IF has_table_privilege('authenticated','public.pool_platform_dues_events','INSERT')
    OR has_table_privilege('authenticated','public.pool_platform_dues_events','UPDATE')
  THEN RAISE EXCEPTION 'authenticated_direct_ledger_write'; END IF;
END;
$crm_dues$;

ROLLBACK TO SAVEPOINT crm_dues_simulation;

RELEASE SAVEPOINT crm_dues_simulation;
