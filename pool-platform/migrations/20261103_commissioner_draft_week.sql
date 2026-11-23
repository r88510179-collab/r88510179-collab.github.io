-- Create a draft week in an authorized season.
CREATE FUNCTION public.pool_platform_create_draft_week(
  p_season_id uuid,
  p_week integer,
  p_deadline_at timestamptz,
  p_opens_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_id uuid;
BEGIN
  -- Must be first, prior to any reads or writes, for retry-on-auth_required safety.
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_week IS NULL OR p_week NOT BETWEEN 1 AND 25
    THEN RAISE EXCEPTION 'invalid_week_number'; END IF;
  IF p_deadline_at IS NULL
    OR p_deadline_at <= clock_timestamp() + interval '5 minutes'
    OR p_deadline_at > clock_timestamp() + interval '18 months'
    THEN RAISE EXCEPTION 'invalid_week_deadline'; END IF;
  IF p_opens_at IS NOT NULL AND p_opens_at >= p_deadline_at
    THEN RAISE EXCEPTION 'invalid_week_opening'; END IF;

  SELECT p.tenant_id INTO v_tenant_id
  FROM public.pool_platform_seasons s
  JOIN public.pool_platform_pools p ON p.id = s.pool_id
  JOIN public.pool_platform_tenants t ON t.id = p.tenant_id
  WHERE s.id = p_season_id
    AND s.status IN ('setup', 'active')
    AND p.status = 'active'
    AND t.status = 'active';
  IF v_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  IF EXISTS(SELECT 1 FROM public.pool_platform_weeks w
            WHERE w.season_id=p_season_id AND w.week=p_week)
    THEN RAISE EXCEPTION 'duplicate_week_number'; END IF;

  -- Create EMPTY draft only. Picks cannot be submitted until a separately
  -- reviewed, accurate NFL schedule is configured and authorized week opening is implemented.
  INSERT INTO public.pool_platform_weeks(season_id,week,status,opens_at,deadline_at,config)
  VALUES(p_season_id,p_week,'draft',p_opens_at,p_deadline_at,'{"games":[]}'::jsonb)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id',v_id,'week',p_week,'status','draft','deadline_at',p_deadline_at);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'duplicate_week_number';
END;
$function$;

REVOKE ALL ON FUNCTION public.pool_platform_create_draft_week(uuid,integer,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_create_draft_week(uuid,integer,timestamptz,timestamptz) TO authenticated;
