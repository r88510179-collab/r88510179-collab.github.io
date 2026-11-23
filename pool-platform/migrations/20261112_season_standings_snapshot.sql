-- Read the season inputs for standings computed from commissioner-attested finals.
CREATE FUNCTION public.pool_platform_season_standings_snapshot(p_pool_id uuid, p_season integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $fn$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_season_id uuid;
  v_pool_type text;
  v_rules jsonb;
  v_now timestamptz;
  v_entries jsonb;
  v_weeks jsonb;
BEGIN
  -- FIRST executable statement: required by PlatformClient's one-time auth_required
  -- retry contract. No query precedes this guard.
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_pool_id IS NULL OR p_season IS NULL THEN RAISE EXCEPTION 'season_not_found'; END IF;

  SELECT p.tenant_id,s.id,p.pool_type,p.rules
    INTO v_tenant_id,v_season_id,v_pool_type,v_rules
  FROM public.pool_platform_pools p
  JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
  JOIN public.pool_platform_seasons s ON s.pool_id=p.id AND s.season=p_season
  WHERE p.id=p_pool_id AND p.status='active' AND t.status='active'
    AND s.status IN ('setup','active','complete');
  IF v_season_id IS NULL THEN RAISE EXCEPTION 'season_not_found'; END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM public.pool_platform_memberships m
      WHERE m.tenant_id=v_tenant_id AND m.auth_user_id=v_uid
        AND m.role IN ('owner','commissioner','co_commissioner'))
    OR EXISTS (SELECT 1 FROM public.pool_platform_entries e
      WHERE e.season_id=v_season_id AND e.owner_auth_user_id=v_uid
        AND e.status='active')
  ) THEN RAISE EXCEPTION 'season_not_found'; END IF;

  IF (SELECT count(*) FROM public.pool_platform_entries e
      WHERE e.season_id=v_season_id AND e.status IN ('active','eliminated'))>512
    THEN RAISE EXCEPTION 'standings_pool_too_large'; END IF;

  -- One instant decides which weeks are past their deadline, for the whole answer.
  v_now := clock_timestamp();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'entry_id',e.id,'entry_code',e.entry_code,
      'display_name',e.display_name,'entry_status',e.status
    ) ORDER BY e.entry_code,e.id),'[]'::jsonb)
    INTO v_entries
  FROM public.pool_platform_entries e
  WHERE e.season_id=v_season_id AND e.status IN ('active','eliminated');

  SELECT COALESCE(jsonb_agg(
    CASE WHEN v_now>=w.deadline_at THEN jsonb_build_object(
      'week',w.week,'week_id',w.id,'deadline_at',w.deadline_at,
      'visibility','after_deadline',
      'games',COALESCE(w.config->'games','[]'::jsonb),
      'result',(SELECT jsonb_build_object('revision',r.revision,'results',r.results)
        FROM public.pool_platform_week_result_revisions r
        WHERE r.week_id=w.id ORDER BY r.revision DESC LIMIT 1),
      'submissions',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'entry_id',sub.entry_id,'source',sub.source,'status',sub.status,
          'payload',CASE WHEN v_pool_type='pickem'
            THEN jsonb_build_object('picks',sub.payload->'picks')
            ELSE jsonb_build_object('team',sub.payload->'team') END
        ) ORDER BY sub.entry_id),'[]'::jsonb)
        FROM public.pool_platform_submissions sub
        JOIN public.pool_platform_entries e ON e.id=sub.entry_id
        WHERE sub.week_id=w.id AND sub.status IN ('submitted','locked')
          AND e.season_id=v_season_id AND e.status IN ('active','eliminated'))
    ) ELSE jsonb_build_object(
      'week',w.week,'week_id',w.id,'deadline_at',w.deadline_at,
      'visibility','sealed','games',NULL,'result',NULL,'submissions',NULL
    ) END ORDER BY w.week),'[]'::jsonb)
    INTO v_weeks
  FROM public.pool_platform_weeks w
  WHERE w.season_id=v_season_id AND w.status IN ('open','locked','final');

  RETURN jsonb_build_object(
    'pool_id',p_pool_id,'season',p_season,'pool_type',v_pool_type,
    -- Only the rules the grading understands; anything else stored on the pool stays there.
    'rules',jsonb_strip_nulls(jsonb_build_object(
      'tiesBothLose',v_rules->'tiesBothLose',
      'pointsPerCorrectPick',v_rules->'pointsPerCorrectPick',
      'tiesEliminate',v_rules->'tiesEliminate',
      'repeatTeamsAllowed',v_rules->'repeatTeamsAllowed',
      'missingSurvivorPick',v_rules->'missingSurvivorPick')),
    'entries',v_entries,'weeks',v_weeks,
    'status','commissioner_attested_not_official');
END;
$fn$;
REVOKE ALL ON FUNCTION public.pool_platform_season_standings_snapshot(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_season_standings_snapshot(uuid,integer) TO authenticated;
