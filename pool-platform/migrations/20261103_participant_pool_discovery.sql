-- List the pools where the participant owns an active entry.
CREATE FUNCTION public.pool_platform_list_participant_pools()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
BEGIN
  -- Mandatory first operation for the browser client's auth_required retry contract.
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', owned.id,
      'slug', owned.slug,
      'display_name', owned.display_name,
      'pool_type', owned.pool_type,
      'season', owned.season
    ) ORDER BY lower(owned.display_name), owned.slug, owned.id)
    FROM (
      SELECT p.id,p.slug,p.display_name,p.pool_type,max(s.season) AS season
      FROM public.pool_platform_pools p
      JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
      JOIN public.pool_platform_seasons s ON s.pool_id=p.id
      JOIN public.pool_platform_entries e ON e.season_id=s.id
      WHERE p.status='active' AND t.status='active'
        AND s.status IN ('setup','active')
        AND e.status='active' AND e.owner_auth_user_id=v_uid
      GROUP BY p.id,p.slug,p.display_name,p.pool_type
    ) owned
  ),'[]'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_list_participant_pools() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_list_participant_pools() TO authenticated;
