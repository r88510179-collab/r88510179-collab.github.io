-- Create pools and seasons within existing tenant memberships.
CREATE UNIQUE INDEX IF NOT EXISTS pool_platform_pools_global_slug_idx
  ON public.pool_platform_pools(slug);

CREATE OR REPLACE FUNCTION public.pool_platform_create_pool(
  p_tenant_id uuid, p_display_name text, p_pool_type text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_name text := btrim(p_display_name);
  v_tenant_status text;
  v_slug text;
  v_rules jsonb;
  v_pool public.pool_platform_pools%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 3 AND 120
    THEN RAISE EXCEPTION 'invalid_pool_name'; END IF;
  IF p_pool_type IS NULL OR p_pool_type NOT IN ('pickem','survivor')
    THEN RAISE EXCEPTION 'invalid_pool_type'; END IF;
  SELECT status INTO v_tenant_status
    FROM public.pool_platform_tenants WHERE id=p_tenant_id;
  IF v_tenant_status IS DISTINCT FROM 'active'
     OR NOT EXISTS(
       SELECT 1 FROM public.pool_platform_memberships
       WHERE tenant_id=p_tenant_id AND auth_user_id=v_uid
         AND role IN ('owner','commissioner')
     ) THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  -- The internal slug is deterministic-looking but non-predictable, and never user supplied.
  -- Unique index is the definitive collision guard across all tenant pools.
  v_slug:=left(coalesce(nullif(trim(both '-' from
    regexp_replace(lower(v_name),'[^a-z0-9]+','-','g')),''),'pool'),40)
    ||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,12);
  v_rules := CASE WHEN p_pool_type='pickem'
      THEN '{"pointsPerCorrectPick":1,"tiesBothLose":true}'::jsonb
      ELSE '{"tiesEliminate":true,"repeatTeamsAllowed":false}'::jsonb END;
  INSERT INTO public.pool_platform_pools(tenant_id,slug,display_name,pool_type,status,rules)
    VALUES (p_tenant_id,v_slug,v_name,p_pool_type,'active',v_rules)
    RETURNING * INTO v_pool;
  RETURN jsonb_build_object('id',v_pool.id,'slug',v_pool.slug,
     'display_name',v_pool.display_name,'pool_type',v_pool.pool_type,
     'status','active','rules',v_pool.rules);
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_create_pool(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_create_pool(uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pool_platform_create_season(
  p_pool_id uuid, p_season integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_pool_type text;
  v_season public.pool_platform_seasons%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_season IS NULL OR p_season NOT BETWEEN 2020 AND 2100
    THEN RAISE EXCEPTION 'invalid_season_year'; END IF;
  SELECT p.tenant_id,p.pool_type INTO v_tenant_id,v_pool_type
    FROM public.pool_platform_pools p
    JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
    WHERE p.id=p_pool_id AND p.status='active' AND t.status='active';
  IF v_tenant_id IS NULL
    OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  IF EXISTS (SELECT 1 FROM public.pool_platform_seasons s
             WHERE s.pool_id=p_pool_id AND s.season=p_season)
    THEN RAISE EXCEPTION 'duplicate_season'; END IF;
  INSERT INTO public.pool_platform_seasons(pool_id,season,status,config)
    VALUES (p_pool_id,p_season,'setup',
      jsonb_build_object('createdBy','commissioner_dashboard','poolType',v_pool_type))
    RETURNING * INTO v_season;
  RETURN jsonb_build_object('id',v_season.id,'season',v_season.season,
    'status',v_season.status);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'duplicate_season';
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_create_season(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_create_season(uuid,integer) TO authenticated;
