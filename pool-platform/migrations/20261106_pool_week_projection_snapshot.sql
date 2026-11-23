-- Return the authorized week's projection inputs after its deadline.
CREATE FUNCTION public.pool_platform_week_projection_snapshot(p_week_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_pool_id uuid;
  v_tenant_id uuid;
  v_season_id uuid;
  v_season integer;
  v_week integer;
  v_status text;
  v_pool_type text;
  v_deadline timestamptz;
  v_games jsonb;
  v_can_read boolean := false;
  v_visible boolean;
  v_entries jsonb;
BEGIN
  -- FIRST executable statement: required by PlatformClient's idempotent
  -- one-time auth_required retry contract. No query precedes this guard.
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_week_id IS NULL THEN RAISE EXCEPTION 'week_not_found'; END IF;

  SELECT p.id,p.tenant_id,s.id,s.season,w.week,w.status,p.pool_type,w.deadline_at,w.config->'games'
    INTO v_pool_id,v_tenant_id,v_season_id,v_season,v_week,v_status,v_pool_type,v_deadline,v_games
  FROM public.pool_platform_weeks w
  JOIN public.pool_platform_seasons s ON s.id=w.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
  WHERE w.id=p_week_id AND p.status='active' AND t.status='active'
    AND s.status IN ('setup','active','complete');

  IF v_pool_id IS NULL THEN RAISE EXCEPTION 'week_not_found'; END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.pool_platform_memberships m
    WHERE m.tenant_id=v_tenant_id AND m.auth_user_id=v_uid
      AND m.role IN ('owner','commissioner','co_commissioner')
  ) OR EXISTS(
    SELECT 1 FROM public.pool_platform_entries e
    WHERE e.season_id=v_season_id AND e.owner_auth_user_id=v_uid
      AND e.status='active'
  ) INTO v_can_read;
  -- Same generic error for missing/unauthorized week; do not reveal its existence.
  IF NOT v_can_read THEN RAISE EXCEPTION 'week_not_found'; END IF;

  -- Final state does NOT itself make submitted picks visible before the real
  -- deadline. A public schedule never grants access to this database.
  v_visible := v_status IN ('open','locked','final')
    AND clock_timestamp() >= v_deadline;
  IF NOT v_visible THEN
    RETURN jsonb_build_object(
      'pool_id',v_pool_id,'season',v_season,'week',v_week,
      'week_id',p_week_id,'pool_type',v_pool_type,'deadline_at',v_deadline,
      'visibility','sealed','entries','[]'::jsonb
    );
  END IF;

  IF (SELECT count(*) FROM public.pool_platform_entries e
      WHERE e.season_id=v_season_id AND e.status IN ('active','eliminated'))>512
    THEN RAISE EXCEPTION 'standings_pool_too_large'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'entry_id', e.id,
    'entry_code', e.entry_code,
    'display_name', e.display_name,
    'entry_status', e.status,
    'submission', CASE WHEN sub.id IS NULL THEN NULL ELSE jsonb_build_object(
      'status', sub.status,
      'source', sub.source,
      'payload',CASE WHEN v_pool_type='pickem' THEN
        jsonb_build_object('picks',sub.payload->'picks')
      ELSE jsonb_build_object('team',sub.payload->'team') END
    ) END
  ) ORDER BY e.entry_code,e.id), '[]'::jsonb)
    INTO v_entries
  FROM public.pool_platform_entries e
  LEFT JOIN public.pool_platform_submissions sub
    ON sub.entry_id=e.id AND sub.week_id=p_week_id
    AND sub.status IN ('submitted','locked')
  WHERE e.season_id=v_season_id AND e.status IN ('active','eliminated');

  RETURN jsonb_build_object(
    'pool_id',v_pool_id,'season',v_season,'week',v_week,
    'week_id',p_week_id,'pool_type',v_pool_type,'deadline_at',v_deadline,
    'visibility','after_deadline',
    'entries',v_entries
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_week_projection_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_week_projection_snapshot(uuid) TO authenticated;
