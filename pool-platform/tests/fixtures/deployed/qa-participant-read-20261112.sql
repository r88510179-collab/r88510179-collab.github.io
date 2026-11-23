-- Disposable PostgreSQL ONLY. Never run against Neon: it creates objects.
--
-- The participant page's read path AS DEPLOYED: neither function is in this
-- repository's migrations. Each CREATE FUNCTION below is the exact text
-- returned by pg_get_functiondef on the isolated QA branch
-- the QA branch (PostgreSQL 18.6) on 2026-11-12 at 14:48 and
-- 14:49 UTC, and the block at the end fails unless each stored body still
-- has the SHA-256 the catalog reported.
--
-- Included by tests/e2e/final-results-e2e-db-fixture.sql, which provides the
-- base tables, the identity stand-in and pool_platform_is_tenant_commissioner.
-- pool_platform_can_read_pool: prosrc SHA-256 9467d14b40d59fc730b23cf2fc7ac000fd3c86eb24a1e12e807e83575bc211a6
CREATE OR REPLACE FUNCTION public.pool_platform_can_read_pool(p_pool_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.pool_platform_pools p
    WHERE p.id=p_pool_id
      AND (
        public.pool_platform_is_tenant_commissioner(p.tenant_id)
        OR EXISTS (
          SELECT 1
          FROM public.pool_platform_seasons s
          JOIN public.pool_platform_entries e ON e.season_id=s.id
          WHERE s.pool_id=p.id
            AND e.owner_auth_user_id=public.pool_platform_current_user_id()
        )
      )
  )
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_can_read_pool(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_can_read_pool(uuid) TO authenticated;
-- pool_platform_participant_context: prosrc SHA-256 e1fd95b1caaad63208814326390b4d3ccbb91ec93e88f67f0bcb609f6f4bcd53
CREATE OR REPLACE FUNCTION public.pool_platform_participant_context(p_pool_slug text, p_season integer DEFAULT NULL::integer, p_week integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_pool public.pool_platform_pools%ROWTYPE;
  v_season public.pool_platform_seasons%ROWTYPE;
  v_week public.pool_platform_weeks%ROWTYPE;
  v_entries jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;

  SELECT * INTO v_pool
  FROM public.pool_platform_pools
  WHERE slug=p_pool_slug AND status='active'
    AND public.pool_platform_can_read_pool(id)
  ORDER BY created_at DESC LIMIT 1;
  IF v_pool.id IS NULL THEN RAISE EXCEPTION 'pool_not_found'; END IF;

  SELECT * INTO v_season
  FROM public.pool_platform_seasons
  WHERE pool_id=v_pool.id
    AND (p_season IS NULL OR season=p_season)
    AND status IN ('setup','active')
  ORDER BY season DESC LIMIT 1;
  IF v_season.id IS NULL THEN RAISE EXCEPTION 'season_not_found'; END IF;

  SELECT * INTO v_week
  FROM public.pool_platform_weeks
  WHERE season_id=v_season.id
    AND (p_week IS NULL OR week=p_week)
    AND status IN ('open','locked','final')
  ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,week DESC
  LIMIT 1;
  IF v_week.id IS NULL THEN RAISE EXCEPTION 'week_not_found'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',e.id,
    'entry_code',e.entry_code,
    'display_name',e.display_name,
    'status',e.status,
    'submission',CASE WHEN sub.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',sub.id,'source',sub.source,'status',sub.status,'payload',sub.payload,
      'revision',sub.revision,'submitted_at',sub.submitted_at,'updated_at',sub.updated_at
    ) END,
    'history',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'week',hw.week,'source',hs.source,'status',hs.status,
        'payload',hs.payload,'revision',hs.revision
      ) ORDER BY hw.week)
      FROM public.pool_platform_submissions hs
      JOIN public.pool_platform_weeks hw ON hw.id=hs.week_id
      -- Every other week, earlier or later, so the browser marks the same teams used as the server does.
      WHERE hs.entry_id=e.id AND hw.season_id=v_season.id AND hw.week<>v_week.week
    ),'[]'::jsonb)
  ) ORDER BY e.entry_code),'[]'::jsonb)
  INTO v_entries
  FROM public.pool_platform_entries e
  LEFT JOIN public.pool_platform_submissions sub
    ON sub.entry_id=e.id AND sub.week_id=v_week.id
  WHERE e.season_id=v_season.id
    AND e.owner_auth_user_id=v_uid
    AND e.status='active';

  RETURN jsonb_build_object(
    'pool',jsonb_build_object(
      'id',v_pool.id,'slug',v_pool.slug,'display_name',v_pool.display_name,
      'pool_type',v_pool.pool_type,'rules',v_pool.rules,'branding',v_pool.branding
    ),
    'season',jsonb_build_object('id',v_season.id,'season',v_season.season,'config',v_season.config),
    'week',jsonb_build_object(
      'id',v_week.id,'week',v_week.week,'status',v_week.status,
      'opens_at',v_week.opens_at,'deadline_at',v_week.deadline_at,'config',v_week.config
    ),
    'entries',v_entries
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_participant_context(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_participant_context(text,integer,integer) TO authenticated;

DO $same_as_deployed$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('pool_platform_can_read_pool','9467d14b40d59fc730b23cf2fc7ac000fd3c86eb24a1e12e807e83575bc211a6'),
    ('pool_platform_participant_context','e1fd95b1caaad63208814326390b4d3ccbb91ec93e88f67f0bcb609f6f4bcd53')
  ) AS expected(fn,sha256) LOOP
    IF (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p
        WHERE p.pronamespace='public'::regnamespace AND p.proname=r.fn) IS DISTINCT FROM r.sha256
    THEN RAISE EXCEPTION 'the stored body of % is not the body read from the QA catalog', r.fn; END IF;
  END LOOP;
END;
$same_as_deployed$;
