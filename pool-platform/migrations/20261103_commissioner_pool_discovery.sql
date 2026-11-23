-- List the active pools accessible to a signed-in commissioner.
CREATE FUNCTION public.pool_platform_list_commissioner_pools()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'slug', p.slug,
        'display_name', p.display_name,
        'pool_type', p.pool_type,
        'status', p.status
      ) ORDER BY lower(p.display_name), p.slug
    )
    FROM public.pool_platform_pools p
    JOIN public.pool_platform_tenants t ON t.id = p.tenant_id
    JOIN public.pool_platform_memberships m ON m.tenant_id = p.tenant_id
    WHERE m.auth_user_id = v_uid
      AND m.role IN ('owner', 'commissioner', 'co_commissioner')
      AND p.status <> 'archived'
      AND t.status = 'active'
  ), '[]'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_list_commissioner_pools() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_list_commissioner_pools() TO authenticated;
