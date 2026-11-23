-- Store commissioner-attested final scores for a completed slate.
CREATE TABLE public.pool_platform_week_result_revisions (
  week_id uuid NOT NULL REFERENCES public.pool_platform_weeks(id),
  revision integer NOT NULL CHECK (revision >= 1),
  results jsonb NOT NULL CHECK (jsonb_typeof(results)='object'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  attested_by_auth_user_id text NOT NULL,
  correction_reason text,
  attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (week_id,revision),
  CHECK ((revision=1 AND correction_reason IS NULL) OR
         (revision>1 AND length(btrim(correction_reason)) BETWEEN 8 AND 240))
);
REVOKE ALL ON TABLE public.pool_platform_week_result_revisions FROM PUBLIC;
ALTER TABLE public.pool_platform_week_result_revisions ENABLE ROW LEVEL SECURITY;
-- No direct authenticated/anonymous row policies: access only through
-- the reviewed SECURITY DEFINER RPCs and existing verified session identity.
CREATE FUNCTION public.pool_platform_forbid_result_revision_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  RAISE EXCEPTION 'result_revisions_are_append_only';
END;
$fn$;
CREATE TRIGGER pool_platform_result_revisions_immutable
BEFORE UPDATE OR DELETE ON public.pool_platform_week_result_revisions
FOR EACH ROW EXECUTE FUNCTION public.pool_platform_forbid_result_revision_change();

-- Commissioner attestation with compare-and-insert revision semantics.
-- A separately approved final verification and season-grading publisher is
-- still required before exposing these as official final pool rankings.
CREATE FUNCTION public.pool_platform_attest_week_final_results(
  p_week_id uuid,
  p_expected_revision integer,
  p_results jsonb,
  p_source_sha256 text,
  p_correction_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public','neon_auth','pg_temp'
AS $fn$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_games jsonb;
  v_deadline timestamptz;
  v_status text;
  v_game_count integer;
  v_results_count integer;
  v_seen_games text[] := ARRAY[]::text[];
  v_seen_teams text[] := ARRAY[]::text[];
  v_game jsonb;
  v_result jsonb;
  v_game_id text;
  v_away text;
  v_home text;
  v_score text;
  v_keys integer;
  v_kickoff timestamptz;
  v_last integer;
  v_previous jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_week_id IS NULL THEN RAISE EXCEPTION 'week_not_found'; END IF;

  -- The same not-found error for missing and foreign pool weeks. Only an
  -- authorized member can acquire the row lock used to serialize revisions.
  SELECT w.config->'games',w.deadline_at,w.status
    INTO v_games,v_deadline,v_status
  FROM public.pool_platform_weeks w
  JOIN public.pool_platform_seasons s ON s.id=w.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
  JOIN public.pool_platform_memberships m ON m.tenant_id=t.id
  WHERE w.id=p_week_id AND m.auth_user_id=v_uid
    AND m.role IN ('owner','commissioner','co_commissioner')
    AND t.status='active' AND p.status='active'
    AND s.status IN ('setup','active','complete')
  FOR UPDATE OF w;
  IF NOT FOUND THEN RAISE EXCEPTION 'week_not_found'; END IF;

  IF v_status NOT IN ('locked','final') OR
     v_deadline IS NULL OR clock_timestamp()<v_deadline THEN
    RAISE EXCEPTION 'week_not_eligible_for_final_attestation';
  END IF;
  IF jsonb_typeof(v_games) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_verified_schedule';
  END IF;
  v_game_count:=jsonb_array_length(v_games);
  IF v_game_count<1 OR v_game_count>16 THEN
    RAISE EXCEPTION 'invalid_verified_schedule';
  END IF;
  IF jsonb_typeof(p_results) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_final_results';
  END IF;
  SELECT count(*) INTO v_results_count FROM jsonb_object_keys(p_results);
  IF v_results_count<>v_game_count OR
     p_source_sha256 IS NULL OR p_source_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_final_results';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<0 THEN
    RAISE EXCEPTION 'invalid_expected_revision';
  END IF;
  FOR v_game IN SELECT value FROM jsonb_array_elements(v_games) AS t(value) LOOP
    v_game_id:=v_game->>'id';
    v_away:=v_game->'away'->>'key';
    v_home:=v_game->'home'->>'key';
    IF v_game_id IS NULL OR v_game_id !~ '^[A-Za-z0-9_-]{1,100}$'
      OR v_game_id=ANY(v_seen_games)
      OR v_away IS NULL OR v_home IS NULL
      OR v_away !~ '^[A-Za-z0-9-]{2,16}$'
      OR v_home !~ '^[A-Za-z0-9-]{2,16}$'
      OR v_away=v_home OR v_away=ANY(v_seen_teams)
      OR v_home=ANY(v_seen_teams) THEN
      RAISE EXCEPTION 'invalid_verified_schedule';
    END IF;
    v_seen_games:=array_append(v_seen_games,v_game_id);
    v_seen_teams:=array_append(array_append(v_seen_teams,v_away),v_home);

    -- A future kickoff cannot be manually marked final. A missing kickoff
    -- requires correcting/verifying the schedule before any attestation.
    BEGIN
      v_kickoff:=(v_game->>'kickoff')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_verified_schedule';
    END;
    IF v_kickoff IS NULL OR v_kickoff>clock_timestamp() THEN
      RAISE EXCEPTION 'game_not_started_or_schedule_missing';
    END IF;

    IF NOT (p_results ? v_game_id) THEN RAISE EXCEPTION 'invalid_final_results'; END IF;
    v_result:=p_results->v_game_id;
    IF jsonb_typeof(v_result) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'invalid_final_results';
    END IF;
    SELECT count(*) INTO v_keys FROM jsonb_object_keys(v_result);
    IF v_keys<>3 OR v_result->>'status'<>'final'
      OR NOT (v_result ? 'away_score') OR NOT (v_result ? 'home_score')
      OR jsonb_typeof(v_result->'away_score')<>'number'
      OR jsonb_typeof(v_result->'home_score')<>'number' THEN
      RAISE EXCEPTION 'invalid_final_results';
    END IF;
    FOR v_score IN SELECT value FROM jsonb_each_text(v_result)
      WHERE key IN ('away_score','home_score') LOOP
      IF v_score !~ '^(0|[1-9][0-9]{0,2})$' OR
        v_score::integer>200 THEN RAISE EXCEPTION 'invalid_final_results'; END IF;
    END LOOP;
  END LOOP;

  SELECT coalesce(max(revision),0) INTO v_last
    FROM public.pool_platform_week_result_revisions
    WHERE week_id=p_week_id;
  IF v_last<>p_expected_revision THEN RAISE EXCEPTION 'stale_result_revision'; END IF;
  IF v_last=0 THEN
    IF p_correction_reason IS NOT NULL THEN
      RAISE EXCEPTION 'initial_attestation_cannot_be_correction';
    END IF;
  ELSE
    IF p_correction_reason IS NULL OR length(btrim(p_correction_reason)) NOT BETWEEN 8 AND 240
      THEN RAISE EXCEPTION 'correction_reason_required'; END IF;
    SELECT results INTO v_previous FROM public.pool_platform_week_result_revisions
      WHERE week_id=p_week_id AND revision=v_last;
    IF v_previous=p_results THEN RAISE EXCEPTION 'no_result_change'; END IF;
  END IF;
  INSERT INTO public.pool_platform_week_result_revisions
    (week_id,revision,results,source_sha256,attested_by_auth_user_id,correction_reason)
  VALUES (p_week_id,v_last+1,p_results,p_source_sha256,v_uid,p_correction_reason);
  RETURN jsonb_build_object('week_id',p_week_id,'revision',v_last+1,
    'status','commissioner_attested_not_official','source_sha256',p_source_sha256);
END;
$fn$;
REVOKE ALL ON FUNCTION public.pool_platform_attest_week_final_results(uuid,integer,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_attest_week_final_results(uuid,integer,jsonb,text,text) TO authenticated;

-- Reader is pool- or owned-entry-scoped and yields a generic not-found on
-- foreign weeks. The source digest and commissioner identity remain private.
CREATE FUNCTION public.pool_platform_week_result_snapshot(p_week_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public','neon_auth','pg_temp'
AS $fn$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_season_id uuid;
  v_tenant_id uuid;
  v_pool_id uuid;
  v_deadline timestamptz;
  v_rev integer;
  v_results jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_week_id IS NULL THEN RAISE EXCEPTION 'week_not_found'; END IF;
  SELECT s.id,p.tenant_id,p.id,w.deadline_at
    INTO v_season_id,v_tenant_id,v_pool_id,v_deadline
  FROM public.pool_platform_weeks w
  JOIN public.pool_platform_seasons s ON s.id=w.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
  WHERE w.id=p_week_id AND p.status='active' AND t.status='active';
  IF v_pool_id IS NULL THEN RAISE EXCEPTION 'week_not_found'; END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM public.pool_platform_memberships m
      WHERE m.tenant_id=v_tenant_id AND m.auth_user_id=v_uid
      AND m.role IN ('owner','commissioner','co_commissioner'))
    OR EXISTS (SELECT 1 FROM public.pool_platform_entries e
      WHERE e.season_id=v_season_id AND e.owner_auth_user_id=v_uid
      AND e.status='active')
  ) THEN RAISE EXCEPTION 'week_not_found'; END IF;
  IF v_deadline IS NULL OR clock_timestamp()<v_deadline THEN
    RETURN jsonb_build_object('week_id',p_week_id,'status','sealed');
  END IF;
  SELECT revision,results INTO v_rev,v_results
    FROM public.pool_platform_week_result_revisions
    WHERE week_id=p_week_id ORDER BY revision DESC LIMIT 1;
  IF v_rev IS NULL THEN
    RETURN jsonb_build_object('week_id',p_week_id,'status','unpublished');
  END IF;
  RETURN jsonb_build_object('week_id',p_week_id,'status','commissioner_attested_not_official',
    'revision',v_rev,'results',v_results);
END;
$fn$;
REVOKE ALL ON FUNCTION public.pool_platform_week_result_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_week_result_snapshot(uuid) TO authenticated;
