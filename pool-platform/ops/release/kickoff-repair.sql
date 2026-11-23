\set ON_ERROR_STOP on
-- Adds kickoff times to ONE existing week from the verified schedule catalog, and from nowhere else. A dry run
-- unless -v apply=yes: everything is checked, the result is shown, and the transaction is rolled back.
--   psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" \
--     -v week_id=<week uuid from kickoff-audit.sql> [-v apply=yes] -f ops/release/kickoff-repair.sql
--
-- It refuses, changing nothing, unless ALL of this holds:
--   * the catalog has a row for the week's season and week number, validated within the last 48 hours;
--   * the stored slate IS that verified slate: the same number of games and the same away/home team in every game;
--   * no stored game already has a different kickoff, and no verified kickoff is earlier than the pick deadline
--     (a pick made after a kickoff could not be told from one made before it).
-- It then sets only each game's kickoff and records where it came from. Game ids, teams, the deadline, the status
-- and every pick are left exactly as they are: the transaction fails if any other row or field changed. A slate
-- that matches no verified schedule (a synthetic fixture, for one) can never be repaired here, by design: such a
-- week stays closed to final scores.
\if :{?week_id}
\else
\set week_id ''
\endif
\if :{?apply}
\else
\set apply no
\endif
SELECT (:'apply'='yes') AS pool_kickoff_apply \gset
BEGIN;
\ir verify-target.sql
-- Said plainly, before anything names the catalog: without the release there is no verified schedule to repair from.
DO $installed$
BEGIN
  IF to_regclass('public.pool_platform_verified_schedule_catalog') IS NULL
     OR to_regclass('public.pool_platform_week_operations_audit') IS NULL
    THEN RAISE EXCEPTION 'kickoff_repair_refused: the release is not installed on this database'; END IF;
END
$installed$;
SELECT set_config('pool_release.week_id',:'week_id',true) AS week_id \gset pool_kickoff_
-- Everything a repair must leave alone, written down before it starts. Writers wait; readers are not blocked.
LOCK TABLE public.pool_platform_weeks,public.pool_platform_submissions,public.pool_platform_submission_audit,
  public.pool_platform_entries,public.pool_platform_entry_invites IN SHARE MODE;
CREATE FUNCTION pg_temp.pool_kickoff_untouched(p_week_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $untouched$
  SELECT jsonb_build_object(
    'submissions',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_submissions x),
    'audit',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id),'')) FROM public.pool_platform_submission_audit x),
    'entries',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_entries x),
    'invites',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_entry_invites x),
    'other_weeks',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_weeks x WHERE x.id<>p_week_id),
    -- The week itself with the only things a repair may set taken out: each game's kickoff, where the kickoffs
    -- came from, and the row's change time.
    'this_week',(SELECT md5((to_jsonb(x)-'updated_at'-'config')::text||'|'||
        ((x.config-'games'-'kickoffSource'-'kickoffDigest'-'kickoffVerifiedAt'-'kickoffRepairedAt')::text)||'|'||
        COALESCE((SELECT string_agg((g.value-'kickoff')::text,'|' ORDER BY g.ordinality)
                  FROM jsonb_array_elements(x.config->'games') WITH ORDINALITY g),''))
      FROM public.pool_platform_weeks x WHERE x.id=p_week_id))
$untouched$;
DO $repair$
DECLARE
  v_week_id uuid;
  v_season integer;
  v_week integer;
  v_status text;
  v_deadline timestamptz;
  v_config jsonb;
  v_catalog public.pool_platform_verified_schedule_catalog%ROWTYPE;
  v_before jsonb;
  v_games jsonb;
  v_stored integer;
  v_matched integer;
  v_new jsonb;
BEGIN
  BEGIN
    v_week_id:=NULLIF(current_setting('pool_release.week_id'),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN v_week_id:=NULL;
  END;
  IF v_week_id IS NULL THEN RAISE EXCEPTION 'kickoff_repair_refused: pass -v week_id=<uuid>'; END IF;
  SELECT s.season,w.week,w.status,w.deadline_at,w.config INTO v_season,v_week,v_status,v_deadline,v_config
  FROM public.pool_platform_weeks w JOIN public.pool_platform_seasons s ON s.id=w.season_id
  WHERE w.id=v_week_id FOR UPDATE OF w;
  IF NOT FOUND THEN RAISE EXCEPTION 'kickoff_repair_refused: no such week'; END IF;
  IF v_status NOT IN ('open','locked','final')
    THEN RAISE EXCEPTION 'kickoff_repair_refused: a % week takes its schedule through the commissioner page',v_status; END IF;
  IF jsonb_typeof(v_config->'games') IS DISTINCT FROM 'array' OR jsonb_array_length(v_config->'games')<1
    THEN RAISE EXCEPTION 'kickoff_repair_refused: the week has no stored games'; END IF;
  v_before:=pg_temp.pool_kickoff_untouched(v_week_id);

  SELECT * INTO v_catalog FROM public.pool_platform_verified_schedule_catalog
  WHERE season=v_season AND week=v_week FOR SHARE;
  IF v_catalog.season IS NULL
    THEN RAISE EXCEPTION 'kickoff_repair_refused: no verified schedule is loaded for season % week %',v_season,v_week; END IF;
  IF v_catalog.verified_at<now()-interval '48 hours' OR v_catalog.verified_at>now()+interval '5 minutes'
    THEN RAISE EXCEPTION 'kickoff_repair_refused: the verified schedule for season % week % was validated at %, not within the last 48 hours',v_season,v_week,v_catalog.verified_at; END IF;

  -- The stored slate must be the verified slate, game for game.
  v_stored:=jsonb_array_length(v_config->'games');
  SELECT count(*),jsonb_agg(s.value||jsonb_build_object('kickoff',c.value->>'kickoff') ORDER BY s.ordinality)
    INTO v_matched,v_games
  FROM jsonb_array_elements(v_config->'games') WITH ORDINALITY s
  JOIN jsonb_array_elements(v_catalog.games) c
    ON c.value#>>'{away,key}'=s.value#>>'{away,key}' AND c.value#>>'{home,key}'=s.value#>>'{home,key}';
  IF v_stored<>jsonb_array_length(v_catalog.games) OR COALESCE(v_matched,0)<>v_stored
     OR (SELECT count(DISTINCT (s.value#>>'{away,key}')||'@'||(s.value#>>'{home,key}'))
         FROM jsonb_array_elements(v_config->'games') s)<>v_stored
    THEN RAISE EXCEPTION 'kickoff_repair_refused: the stored slate is not the verified slate for season % week % (% stored games, % verified games, % with the same teams)',
      v_season,v_week,v_stored,jsonb_array_length(v_catalog.games),COALESCE(v_matched,0); END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_catalog.games) c
             WHERE (c.value->>'kickoff') IS NULL
                OR (c.value->>'kickoff') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{3})?Z$'
                OR NOT pg_input_is_valid(c.value->>'kickoff','timestamptz'))
    THEN RAISE EXCEPTION 'kickoff_repair_refused: the verified schedule holds a kickoff that is not a UTC timestamp'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_catalog.games) c WHERE (c.value->>'kickoff')::timestamptz<v_deadline)
    THEN RAISE EXCEPTION 'kickoff_repair_refused: a verified kickoff is earlier than the pick deadline %',v_deadline; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_config->'games') s
             JOIN jsonb_array_elements(v_catalog.games) c
               ON c.value#>>'{away,key}'=s.value#>>'{away,key}' AND c.value#>>'{home,key}'=s.value#>>'{home,key}'
             WHERE s.value ? 'kickoff' AND (s.value->>'kickoff') IS DISTINCT FROM (c.value->>'kickoff'))
    THEN RAISE EXCEPTION 'kickoff_repair_refused: a stored game already has a different kickoff'; END IF;

  v_new:=v_config||jsonb_build_object('games',v_games,'kickoffSource',v_catalog.source,
    'kickoffDigest',v_catalog.source_sha256,'kickoffVerifiedAt',v_catalog.verified_at,'kickoffRepairedAt',now());
  UPDATE public.pool_platform_weeks SET config=v_new,updated_at=now() WHERE id=v_week_id;
  INSERT INTO public.pool_platform_week_operations_audit(week_id,actor_auth_user_id,action,source_sha256,
    previous_status,next_status,previous_config,next_config)
  VALUES (v_week_id,'operator:'||session_user,'verified_schedule_import',v_catalog.source_sha256,
    v_status,v_status,v_config,v_new);

  IF pg_temp.pool_kickoff_untouched(v_week_id) IS DISTINCT FROM v_before
    THEN RAISE EXCEPTION 'kickoff_repair_refused: something other than the kickoff times changed'; END IF;
  RAISE NOTICE 'season % week %: % kickoff times set from verified schedule %; picks, entries, invitations and every other week unchanged',
    v_season,v_week,v_stored,left(v_catalog.source_sha256,12);
END
$repair$;
SELECT g.ordinality AS game,g.value->>'id' AS game_id,g.value#>>'{away,key}' AS away,g.value#>>'{home,key}' AS home,
  g.value->>'kickoff' AS kickoff_utc
FROM public.pool_platform_weeks w CROSS JOIN LATERAL jsonb_array_elements(w.config->'games') WITH ORDINALITY g
WHERE w.id=:'pool_kickoff_week_id'::uuid ORDER BY g.ordinality;
\if :pool_kickoff_apply
COMMIT;
\echo 'APPLIED: the kickoff times above are stored.'
\else
ROLLBACK;
\echo 'DRY RUN: nothing was changed. Review the kickoff times above, then repeat with -v apply=yes.'
\endif
