\set ON_ERROR_STOP on
-- Read-only. For every week: whether final scores can be recorded, and if not, exactly why; then every game that has
-- no usable kickoff time. The rules are the ones pool_platform_attest_week_final_results enforces: the week is open,
-- locked or final, its pick deadline has passed, it has 1 to 16 games with distinct identities and teams, and every
-- game has a kickoff time that is in the past. Nothing is changed, and no kickoff time is ever inferred here.
--   psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -f ops/release/kickoff-audit.sql
BEGIN TRANSACTION READ ONLY;
\ir verify-target.sql
\pset pager off
-- One read of the weeks, kept as a document, so the three reports below describe the same instant.
WITH game AS (
  SELECT w.id AS week_id,g.ordinality AS position,g.value->>'id' AS game_id,
    g.value#>>'{away,key}' AS away,g.value#>>'{home,key}' AS home,g.value->>'kickoff' AS kickoff_text,
    COALESCE((g.value->>'kickoff') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{3})?Z$'
      AND pg_input_is_valid(g.value->>'kickoff','timestamptz'),false) AS kickoff_usable
  FROM public.pool_platform_weeks w
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(w.config->'games')='array' THEN w.config->'games'
                                               ELSE '[]'::jsonb END) WITH ORDINALITY AS g
), tally AS (
  SELECT g.week_id,count(*) AS games,count(*) FILTER (WHERE NOT g.kickoff_usable) AS without_kickoff,
    count(*) FILTER (WHERE CASE WHEN g.kickoff_usable THEN g.kickoff_text::timestamptz>now() ELSE false END) AS future_kickoff,
    count(*) FILTER (WHERE g.game_id IS NULL OR g.game_id !~ '^[A-Za-z0-9_-]{1,100}$'
      OR g.away IS NULL OR g.home IS NULL OR g.away !~ '^[A-Za-z0-9-]{2,16}$' OR g.home !~ '^[A-Za-z0-9-]{2,16}$'
      OR g.away=g.home) AS bad_identity,
    count(DISTINCT g.game_id) AS distinct_ids,
    (SELECT count(DISTINCT team) FROM (SELECT x.away AS team FROM game x WHERE x.week_id=g.week_id
                                       UNION ALL SELECT x.home FROM game x WHERE x.week_id=g.week_id) teams) AS distinct_teams
  FROM game g GROUP BY g.week_id
), week AS (
  SELECT t.slug AS tenant,p.slug AS pool,s.season,w.week,w.id AS week_id,w.status,
    to_char(w.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI"Z"') AS deadline_utc,
    (SELECT count(*) FROM public.pool_platform_submissions sub WHERE sub.week_id=w.id) AS submissions,
    COALESCE(k.games,0) AS games,COALESCE(k.without_kickoff,0) AS games_without_kickoff,
    COALESCE(w.config->>'scheduleVerification','none recorded') AS schedule,
    array_remove(ARRAY[
      CASE WHEN w.status NOT IN ('open','locked','final') THEN 'the week is '||w.status END,
      CASE WHEN now()<w.deadline_at THEN 'the pick deadline has not passed' END,
      CASE WHEN COALESCE(k.games,0) NOT BETWEEN 1 AND 16 THEN 'the slate has '||COALESCE(k.games,0)||' games' END,
      CASE WHEN COALESCE(k.bad_identity,0)>0 OR COALESCE(k.games,0)<>COALESCE(k.distinct_ids,0)
             OR COALESCE(k.games,0)*2<>COALESCE(k.distinct_teams,0)
           THEN 'a game or team identity is missing, malformed or repeated' END,
      CASE WHEN COALESCE(k.without_kickoff,0)>0
           THEN k.without_kickoff||' of '||k.games||' games have no kickoff time' END,
      CASE WHEN COALESCE(k.future_kickoff,0)>0 THEN k.future_kickoff||' games have not kicked off' END],NULL) AS blockers
  FROM public.pool_platform_weeks w
  JOIN public.pool_platform_seasons s ON s.id=w.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
  LEFT JOIN tally k ON k.week_id=w.id
)
SELECT jsonb_build_object(
  'weeks',(SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.tenant,w.pool,w.season,w.week),'[]'::jsonb) FROM week w),
  'games',(SELECT COALESCE(jsonb_agg(jsonb_build_object('tenant',w.tenant,'pool',w.pool,'season',w.season,'week',w.week,
      'week_id',w.week_id,'game',g.position,'game_id',g.game_id,'away',g.away,'home',g.home,
      'finding',CASE WHEN g.kickoff_text IS NULL THEN 'no kickoff recorded' ELSE 'kickoff is not a stored UTC timestamp' END,
      'picks_in_week',w.submissions) ORDER BY w.tenant,w.pool,w.season,w.week,g.position),'[]'::jsonb)
    FROM game g JOIN week w ON w.week_id=g.week_id WHERE NOT g.kickoff_usable))::text AS doc \gset pool_kickoff_
\echo '== weeks: can final scores be recorded? =='
SELECT w.pool,w.season,w.week,w.status,w.deadline_utc,w.submissions AS picks,w.games,w.games_without_kickoff AS no_kickoff,
  w.schedule,CASE WHEN cardinality(w.blockers)=0 THEN 'final scores can be recorded'
                  ELSE 'BLOCKED: '||array_to_string(w.blockers,'; ') END AS final_scores
FROM jsonb_to_recordset(:'pool_kickoff_doc'::jsonb->'weeks') AS w(tenant text,pool text,season integer,week integer,
  status text,deadline_utc text,submissions bigint,games bigint,games_without_kickoff bigint,schedule text,blockers text[])
ORDER BY w.tenant,w.pool,w.season,w.week;
\echo '== remediation list: every game without a usable kickoff time =='
SELECT g.pool,g.season,g.week,g.week_id,g.game,g.game_id,g.away,g.home,g.finding,g.picks_in_week
FROM jsonb_to_recordset(:'pool_kickoff_doc'::jsonb->'games') AS g(tenant text,pool text,season integer,week integer,
  week_id uuid,game bigint,game_id text,away text,home text,finding text,picks_in_week bigint)
ORDER BY g.tenant,g.pool,g.season,g.week,g.game;
\echo '== summary =='
SELECT count(*) AS weeks,count(*) FILTER (WHERE w.submissions>0) AS weeks_with_picks,
  count(*) FILTER (WHERE cardinality(w.blockers)>0) AS weeks_blocked,
  count(*) FILTER (WHERE w.submissions>0 AND cardinality(w.blockers)>0) AS weeks_with_picks_blocked,
  count(*) FILTER (WHERE w.submissions>0 AND w.games_without_kickoff>0) AS weeks_with_picks_missing_kickoffs,
  COALESCE(sum(w.games),0) AS games,COALESCE(sum(w.games_without_kickoff),0) AS games_without_kickoff,
  COALESCE(sum(w.submissions),0) AS picks
FROM jsonb_to_recordset(:'pool_kickoff_doc'::jsonb->'weeks') AS w(submissions bigint,games bigint,
  games_without_kickoff bigint,blockers text[]);
ROLLBACK;
