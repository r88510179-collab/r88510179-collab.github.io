-- Save the manual schedule for a draft week.
CREATE FUNCTION public.pool_platform_save_draft_schedule(p_week_id uuid, p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_status text;
  v_deadline timestamptz;
  v_config jsonb;
  v_games jsonb;
  v_game jsonb;
  v_n integer;
  v_key text;
  v_id text;
  v_kickoff text;
  v_seen_keys text[] := ARRAY[]::text[];
  v_seen_ids text[] := ARRAY[]::text[];
  v_kickoff_time timestamptz;
  v_count integer := 0;
BEGIN
  -- Mandatory first operation: reject missing managed Auth subject before any DB reads or writes.
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  -- This RPC intentionally accepts only unverified commissioner-managed manual games.
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object'
     OR p_config->>'scheduleSource' IS DISTINCT FROM 'commissioner_manual'
     OR p_config->>'scheduleVerification' IS DISTINCT FROM 'pending'
     OR jsonb_typeof(p_config->'games') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_config->'tiebreakRequired') IS DISTINCT FROM 'boolean'
  THEN RAISE EXCEPTION 'invalid_draft_schedule'; END IF;
  IF octet_length(p_config::text) > 32768 THEN RAISE EXCEPTION 'invalid_draft_schedule'; END IF;
  v_games := p_config->'games';
  v_n := jsonb_array_length(v_games);
  IF v_n NOT BETWEEN 1 AND 18 THEN RAISE EXCEPTION 'invalid_draft_schedule'; END IF;

  -- Lock the existing selected week, verify tenant authorization and immutable draft status.
  SELECT p.tenant_id,w.status,w.deadline_at INTO v_tenant_id,v_status,v_deadline
    FROM public.pool_platform_weeks w
    JOIN public.pool_platform_seasons s ON s.id=w.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
    WHERE w.id=p_week_id AND p.status='active' AND t.status='active'
      AND s.status IN ('setup','active')
    FOR UPDATE OF w;
  IF v_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  IF v_status <> 'draft' THEN RAISE EXCEPTION 'week_not_draft'; END IF;
  IF EXISTS(SELECT 1 FROM public.pool_platform_submissions s WHERE s.week_id=p_week_id)
    THEN RAISE EXCEPTION 'week_has_submissions'; END IF;

  FOR v_game IN SELECT value FROM jsonb_array_elements(v_games) LOOP
    v_count := v_count + 1;
    IF jsonb_typeof(v_game) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_game->'away') IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_game->'home') IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'invalid_draft_schedule'; END IF;
    v_id := v_game->>'id';
    v_kickoff := v_game->>'kickoff';
    IF v_id IS NULL OR v_id !~ '^MANUAL-[0-9]{8}-[A-Z]{2,3}-[A-Z]{2,3}$'
       OR v_id = ANY(v_seen_ids)
       OR v_kickoff IS NULL OR v_kickoff !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{3})?Z$'
    THEN RAISE EXCEPTION 'invalid_draft_schedule'; END IF;
    -- Check both sides for blank/duplicate keys and reasonable display field lengths.
    FOREACH v_key IN ARRAY ARRAY[v_game#>>'{away,key}',v_game#>>'{home,key}'] LOOP
      IF v_key IS NULL OR v_key <> ALL(ARRAY['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SF','SEA','TB','TEN','WAS']) OR v_key = ANY(v_seen_keys)
      THEN RAISE EXCEPTION 'invalid_draft_schedule'; END IF;
      v_seen_keys := array_append(v_seen_keys,v_key);
    END LOOP;
    IF v_id <> ('MANUAL-' || replace(substr(v_kickoff,1,10),'-','') || '-' ||
      (v_game#>>'{away,key}') || '-' || (v_game#>>'{home,key}'))
      THEN RAISE EXCEPTION 'invalid_draft_schedule'; END IF;
    IF length(coalesce(v_game#>>'{away,city}','')) NOT BETWEEN 1 AND 60
       OR length(coalesce(v_game#>>'{home,city}','')) NOT BETWEEN 1 AND 60
       OR length(coalesce(v_game#>>'{away,name}','')) NOT BETWEEN 1 AND 60
       OR length(coalesce(v_game#>>'{home,name}','')) NOT BETWEEN 1 AND 60
      THEN RAISE EXCEPTION 'invalid_draft_schedule'; END IF;
    BEGIN
      v_kickoff_time := v_kickoff::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'invalid_draft_schedule';
    END;
    IF v_kickoff_time < v_deadline THEN RAISE EXCEPTION 'kickoff_before_deadline'; END IF;
    IF v_kickoff_time < clock_timestamp() - interval '1 day'
       OR v_kickoff_time > clock_timestamp() + interval '18 months'
       THEN RAISE EXCEPTION 'invalid_draft_schedule'; END IF;
    v_seen_ids := array_append(v_seen_ids,v_id);
  END LOOP;
  -- Canonical storage retains only known presentation and pending-verification fields.
  v_config := jsonb_build_object('games',v_games,'tiebreakRequired',p_config->'tiebreakRequired',
    'scheduleSource','commissioner_manual','scheduleVerification','pending');
  UPDATE public.pool_platform_weeks SET config=v_config,updated_at=now()
    WHERE id=p_week_id AND status='draft';
  RETURN jsonb_build_object('week_id',p_week_id,'status','draft','game_count',v_count,
    'scheduleVerification','pending');
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_save_draft_schedule(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_save_draft_schedule(uuid,jsonb) TO authenticated;
