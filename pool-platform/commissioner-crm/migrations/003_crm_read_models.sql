-- CRM-003: authenticated read model for the React CRM.
-- For use ONLY after CRM-001 + CRM-002 and AUTH-C compatibility acceptance.
-- No secret, payment capture, payment processor, or unrestricted table write.
CREATE OR REPLACE FUNCTION public.pool_platform_crm_pools()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
DECLARE
  v_actor text := public.pool_platform_current_user_id();
BEGIN
  -- Important: MUST be the first statement before any table read, for auth_required retry safety.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',p.id,
      'tenant_id',p.tenant_id,
      'slug',p.slug,
      'display_name',p.display_name,
      'pool_type',p.pool_type,
      'status',p.status,
      'dues_tracking_enabled',COALESCE(features.dues_tracking_enabled,false),
      'permissions',jsonb_build_object(
        'view_pool',true,
        'manage_staff',public.pool_platform_is_tenant_commissioner(p.tenant_id),
        'manage_players',public.pool_platform_staff_can(p.id,'manage_players'),
        'review_picks',public.pool_platform_staff_can(p.id,'review_picks'),
        'edit_rules',public.pool_platform_staff_can(p.id,'edit_rules'),
        'send_updates',public.pool_platform_staff_can(p.id,'send_updates'),
        'share_cards',public.pool_platform_staff_can(p.id,'share_cards'),
        'record_dues',public.pool_platform_staff_can(p.id,'record_dues')
      )
    ) ORDER BY p.display_name,p.id)
    FROM public.pool_platform_pools p
    LEFT JOIN public.pool_platform_pool_features features ON features.pool_id=p.id
    WHERE p.status<>'archived'
      AND public.pool_platform_staff_can(p.id,'view_pool')
  ),'[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.pool_platform_crm_pools() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_crm_pools() TO authenticated;

-- Row-level dues report: external manual records only.
CREATE OR REPLACE FUNCTION public.pool_platform_crm_dues_summary(p_pool_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
DECLARE
  v_actor text := public.pool_platform_current_user_id();
  v_enabled boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  -- Refuse before returning any pool, entry or ledger details.
  IF p_pool_id IS NULL OR NOT public.pool_platform_staff_can(p_pool_id,'record_dues')
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;

  SELECT COALESCE(f.dues_tracking_enabled,false) INTO v_enabled
  FROM public.pool_platform_pool_features f WHERE f.pool_id=p_pool_id;
  IF COALESCE(v_enabled,false) IS NOT TRUE
  THEN RETURN '[]'::jsonb; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',e.id,
      'entry_code',e.entry_code,
      'display_name',e.display_name,
      'balance_cents',COALESCE(summary.balance_cents,0),
      'charged_cents',COALESCE(summary.charged_cents,0),
      'paid_cents',COALESCE(summary.paid_cents,0)
    ) ORDER BY e.entry_code)
    FROM public.pool_platform_seasons s
    JOIN public.pool_platform_entries e ON e.season_id=s.id
    LEFT JOIN LATERAL (
      SELECT
        SUM(CASE WHEN d.kind IN ('charge','refund') THEN d.amount_cents ELSE -d.amount_cents END) AS balance_cents,
        SUM(CASE WHEN d.kind='charge' THEN d.amount_cents ELSE 0 END) AS charged_cents,
        SUM(CASE WHEN d.kind='payment' THEN d.amount_cents ELSE 0 END) AS paid_cents
      FROM public.pool_platform_dues_events d WHERE d.entry_id=e.id
    ) summary ON true
    WHERE s.id=(
      SELECT ss.id FROM public.pool_platform_seasons ss
      WHERE ss.pool_id=p_pool_id ORDER BY ss.season DESC,ss.created_at DESC LIMIT 1
    )
  ),'[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.pool_platform_crm_dues_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_crm_dues_summary(uuid) TO authenticated;
