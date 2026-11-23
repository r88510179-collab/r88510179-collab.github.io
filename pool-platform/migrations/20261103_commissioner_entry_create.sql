-- Create an unclaimed entry in a commissioner's existing season.
CREATE FUNCTION public.pool_platform_create_entry(
  p_season_id uuid,
  p_entry_code text,
  p_display_name text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_code text := upper(btrim(p_entry_code));
  v_name text := btrim(p_display_name);
  v_tenant_id uuid;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF v_code IS NULL OR v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,23}$'
    THEN RAISE EXCEPTION 'invalid_entry_code'; END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 1 AND 120
    THEN RAISE EXCEPTION 'invalid_entry_name'; END IF;

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

  IF EXISTS(SELECT 1 FROM public.pool_platform_entries e
            WHERE e.season_id=p_season_id AND e.entry_code=v_code)
    THEN RAISE EXCEPTION 'duplicate_entry_code'; END IF;

  INSERT INTO public.pool_platform_entries(season_id,entry_code,display_name,status)
  VALUES (p_season_id,v_code,v_name,'active') RETURNING id INTO v_id;

  RETURN jsonb_build_object('id',v_id,'entry_code',v_code,'display_name',v_name);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'duplicate_entry_code';
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_create_entry(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_create_entry(uuid,text,text) TO authenticated;
