-- Install the verified schedule catalog and the commissioner's week-opening functions.
CREATE TABLE IF NOT EXISTS public.pool_platform_verified_schedule_catalog (
  season integer NOT NULL CHECK (season BETWEEN 2020 AND 2100),
  week integer NOT NULL CHECK (week BETWEEN 1 AND 18),
  source text NOT NULL CHECK (source = 'nflverse_schedules'),
  source_url text NOT NULL CHECK (source_url = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  raw_source_sha256 text NOT NULL CHECK (raw_source_sha256 ~ '^[0-9a-f]{64}$'),
  source_fetched_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  games jsonb NOT NULL CHECK (jsonb_typeof(games) = 'array'),
  bye_teams jsonb NOT NULL CHECK (jsonb_typeof(bye_teams) = 'array'),
  PRIMARY KEY (season, week)
);
ALTER TABLE public.pool_platform_verified_schedule_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pool_platform_verified_schedule_catalog FROM PUBLIC;
REVOKE ALL ON TABLE public.pool_platform_verified_schedule_catalog FROM authenticated;

CREATE TABLE IF NOT EXISTS public.pool_platform_week_operations_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id uuid NOT NULL REFERENCES public.pool_platform_weeks(id),
  actor_auth_user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('verified_schedule_import', 'verified_week_open')),
  source_sha256 text NOT NULL,
  previous_status text NOT NULL,
  next_status text NOT NULL,
  previous_config jsonb NOT NULL,
  next_config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pool_platform_week_operations_audit_week_idx
  ON public.pool_platform_week_operations_audit(week_id, created_at);
ALTER TABLE public.pool_platform_week_operations_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pool_platform_week_operations_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.pool_platform_week_operations_audit FROM authenticated;

CREATE OR REPLACE FUNCTION public.pool_platform_verified_schedule_preview(p_week_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_season integer;
  v_week integer;
  v_status text;
  v_catalog public.pool_platform_verified_schedule_catalog%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  SELECT p.tenant_id,s.season,w.week,w.status INTO v_tenant_id,v_season,v_week,v_status
    FROM public.pool_platform_weeks w
    JOIN public.pool_platform_seasons s ON s.id=w.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
    WHERE w.id=p_week_id AND p.status='active' AND t.status='active'
      AND s.status IN ('setup','active');
  IF v_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  IF v_week NOT BETWEEN 1 AND 18 THEN RAISE EXCEPTION 'regular_season_only'; END IF;
  SELECT * INTO v_catalog FROM public.pool_platform_verified_schedule_catalog
    WHERE season=v_season AND week=v_week;
  IF v_catalog.season IS NULL THEN
    RETURN jsonb_build_object('available',false,'status','source_not_synced',
      'season',v_season,'week',v_week,'week_status',v_status);
  END IF;
  RETURN jsonb_build_object('available',
      v_catalog.verified_at >= now()-interval '48 hours',
    'status',CASE WHEN v_catalog.verified_at < now()-interval '48 hours'
      THEN 'source_stale' ELSE 'source_validated' END,
    'season',v_season,'week',v_week,'week_status',v_status,
    'source','nflverse schedules (community maintained; not an official NFL feed)',
    'attribution','nflverse and Lee Sharpe / nfldata; CC BY 4.0',
    'source_url',v_catalog.source_url,
    'verified_at',v_catalog.verified_at,
    'source_sha256',v_catalog.source_sha256,
    'games',v_catalog.games,'bye_teams',v_catalog.bye_teams);
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_verified_schedule_preview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_verified_schedule_preview(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.pool_platform_apply_verified_schedule(
  p_week_id uuid, p_expected_source_sha256 text, p_tiebreak_required boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_season integer;
  v_week integer;
  v_week_status text;
  v_deadline timestamptz;
  v_pool_type text;
  v_prior jsonb;
  v_catalog public.pool_platform_verified_schedule_catalog%ROWTYPE;
  v_game jsonb;
  v_id text;
  v_away text;
  v_home text;
  v_kickoff timestamptz;
  v_seen_ids text[] := ARRAY[]::text[];
  v_seen_teams text[] := ARRAY[]::text[];
  v_teams text[] := ARRAY['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB',
    'HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT',
    'SF','SEA','TB','TEN','WAS'];
  v_new jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  SELECT p.tenant_id,s.season,w.week,w.status,w.deadline_at,p.pool_type,w.config
    INTO v_tenant_id,v_season,v_week,v_week_status,v_deadline,v_pool_type,v_prior
    FROM public.pool_platform_weeks w
    JOIN public.pool_platform_seasons s ON s.id=w.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
    WHERE w.id=p_week_id AND p.status='active' AND t.status='active'
      AND s.status IN ('setup','active')
    FOR UPDATE OF w;
  IF v_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  IF v_week_status <> 'draft' THEN RAISE EXCEPTION 'week_not_draft'; END IF;
  IF v_week NOT BETWEEN 1 AND 18 THEN RAISE EXCEPTION 'regular_season_only'; END IF;
  IF EXISTS(SELECT 1 FROM public.pool_platform_submissions WHERE week_id=p_week_id)
    THEN RAISE EXCEPTION 'week_has_submissions'; END IF;
  SELECT * INTO v_catalog FROM public.pool_platform_verified_schedule_catalog
    WHERE season=v_season AND week=v_week FOR SHARE;
  IF v_catalog.season IS NULL THEN RAISE EXCEPTION 'schedule_source_not_synced'; END IF;
  IF p_expected_source_sha256 IS DISTINCT FROM v_catalog.source_sha256
     THEN RAISE EXCEPTION 'schedule_changed_reload'; END IF;
  IF v_catalog.verified_at < now()-interval '48 hours'
     OR v_catalog.verified_at > now()+interval '5 minutes'
     THEN RAISE EXCEPTION 'schedule_source_stale'; END IF;
  IF jsonb_typeof(v_catalog.games) <> 'array'
     OR jsonb_array_length(v_catalog.games) NOT BETWEEN 13 AND 16
     THEN RAISE EXCEPTION 'invalid_verified_schedule'; END IF;
  FOR v_game IN SELECT value FROM jsonb_array_elements(v_catalog.games) LOOP
    v_id:=v_game->>'id';
    v_away:=v_game#>>'{away,key}';
    v_home:=v_game#>>'{home,key}';
    IF v_away IS NULL OR v_home IS NULL
       OR NOT(v_away=ANY(v_teams)) OR NOT(v_home=ANY(v_teams))
       OR v_away=v_home OR v_away=ANY(v_seen_teams) OR v_home=ANY(v_seen_teams)
       OR v_id IS DISTINCT FROM
          (v_season::text||'_'||lpad(v_week::text,2,'0')||'_'||v_away||'_'||v_home)
       OR v_id=ANY(v_seen_ids)
       OR coalesce(length(v_game#>>'{away,city}'),0) NOT BETWEEN 1 AND 60
       OR coalesce(length(v_game#>>'{home,city}'),0) NOT BETWEEN 1 AND 60
       OR coalesce(length(v_game#>>'{away,name}'),0) NOT BETWEEN 1 AND 60
       OR coalesce(length(v_game#>>'{home,name}'),0) NOT BETWEEN 1 AND 60
       OR (v_game->>'kickoff') IS NULL
       OR (v_game->>'kickoff') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{3})?Z$'
       THEN RAISE EXCEPTION 'invalid_verified_schedule'; END IF;
    BEGIN
      v_kickoff := (v_game->>'kickoff')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'invalid_verified_schedule';
    END;
    IF v_kickoff < v_deadline THEN RAISE EXCEPTION 'kickoff_before_deadline'; END IF;
    v_seen_ids:=array_append(v_seen_ids,v_id);
    v_seen_teams:=array_append(v_seen_teams,v_away);
    v_seen_teams:=array_append(v_seen_teams,v_home);
  END LOOP;
  IF v_catalog.bye_teams IS DISTINCT FROM to_jsonb(ARRAY(
      SELECT t FROM unnest(v_teams) AS t
      WHERE NOT(t=ANY(v_seen_teams)) ORDER BY t
    )) THEN RAISE EXCEPTION 'invalid_verified_schedule'; END IF;
  v_new:=jsonb_build_object(
    'games',v_catalog.games,'tiebreakRequired',
       CASE WHEN v_pool_type='pickem' THEN coalesce(p_tiebreak_required,false) ELSE false END,
    'scheduleSource','nflverse_schedules','scheduleVerification','verified',
    'scheduleDigest',v_catalog.source_sha256,
    'scheduleVerifiedAt',v_catalog.verified_at,
    'scheduleAttribution','nflverse and Lee Sharpe / nfldata (CC BY 4.0)',
    'scheduleByeTeams',v_catalog.bye_teams);
  UPDATE public.pool_platform_weeks SET config=v_new,updated_at=now()
    WHERE id=p_week_id AND status='draft';
  INSERT INTO public.pool_platform_week_operations_audit(
    week_id,actor_auth_user_id,action,source_sha256,previous_status,next_status,
    previous_config,next_config
  ) VALUES (p_week_id,v_uid,'verified_schedule_import',v_catalog.source_sha256,
    'draft','draft',v_prior,v_new);
  RETURN jsonb_build_object('week_id',p_week_id,'status','draft',
    'game_count',jsonb_array_length(v_catalog.games),'scheduleVerification','verified',
    'source_sha256',v_catalog.source_sha256);
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_apply_verified_schedule(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_apply_verified_schedule(uuid,text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.pool_platform_open_verified_week(
  p_week_id uuid, p_expected_source_sha256 text, p_confirm boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_status text;
  v_season_id uuid;
  v_season integer;
  v_week integer;
  v_deadline timestamptz;
  v_opens timestamptz;
  v_config jsonb;
  v_catalog public.pool_platform_verified_schedule_catalog%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  SELECT p.tenant_id,w.status,s.id,s.season,w.week,w.deadline_at,w.opens_at,w.config
    INTO v_tenant_id,v_status,v_season_id,v_season,v_week,v_deadline,v_opens,v_config
    FROM public.pool_platform_weeks w
    JOIN public.pool_platform_seasons s ON s.id=w.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
    WHERE w.id=p_week_id AND p.status='active' AND t.status='active'
      AND s.status IN ('setup','active')
    FOR UPDATE OF w;
  IF v_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  IF p_confirm IS DISTINCT FROM true THEN RAISE EXCEPTION 'opening_confirmation_required'; END IF;
  IF v_status <> 'draft' THEN RAISE EXCEPTION 'week_not_draft'; END IF;
  IF EXISTS(SELECT 1 FROM public.pool_platform_submissions WHERE week_id=p_week_id)
    THEN RAISE EXCEPTION 'week_has_submissions'; END IF;
  SELECT * INTO v_catalog FROM public.pool_platform_verified_schedule_catalog
    WHERE season=v_season AND week=v_week FOR SHARE;
  IF v_catalog.season IS NULL OR v_catalog.verified_at < now()-interval '48 hours'
     OR v_catalog.verified_at > now()+interval '5 minutes'
    THEN RAISE EXCEPTION 'schedule_source_stale'; END IF;
  IF p_expected_source_sha256 IS DISTINCT FROM v_catalog.source_sha256
     OR v_config->>'scheduleDigest' IS DISTINCT FROM v_catalog.source_sha256
     OR v_config->>'scheduleSource' IS DISTINCT FROM 'nflverse_schedules'
     OR v_config->>'scheduleVerification' IS DISTINCT FROM 'verified'
     OR v_config->'games' IS DISTINCT FROM v_catalog.games
    THEN RAISE EXCEPTION 'schedule_changed_reload'; END IF;
  IF v_deadline <= clock_timestamp()+interval '5 minutes'
     OR v_opens IS NOT NULL AND v_opens>=v_deadline
     THEN RAISE EXCEPTION 'invalid_week_deadline'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_catalog.games) g
       WHERE (g->>'kickoff') IS NULL
          OR (g->>'kickoff') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{3})?Z$'
          OR NOT pg_input_is_valid(g->>'kickoff','timestamptz'))
    THEN RAISE EXCEPTION 'invalid_verified_schedule'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_catalog.games) g
       WHERE (g->>'kickoff')::timestamptz < v_deadline)
    THEN RAISE EXCEPTION 'kickoff_before_deadline'; END IF;
  UPDATE public.pool_platform_weeks SET status='open',updated_at=now()
    WHERE id=p_week_id AND status='draft';
  UPDATE public.pool_platform_seasons SET status='active',updated_at=now()
    WHERE id=v_season_id AND status='setup';
  INSERT INTO public.pool_platform_week_operations_audit(
    week_id,actor_auth_user_id,action,source_sha256,previous_status,next_status,
    previous_config,next_config
  ) VALUES (p_week_id,v_uid,'verified_week_open',v_catalog.source_sha256,
    'draft','open',v_config,v_config);
  RETURN jsonb_build_object('week_id',p_week_id,'status','open',
    'deadline_at',v_deadline,'opens_at',v_opens,
    'scheduleDigest',v_catalog.source_sha256);
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_open_verified_week(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_open_verified_week(uuid,text,boolean) TO authenticated;
