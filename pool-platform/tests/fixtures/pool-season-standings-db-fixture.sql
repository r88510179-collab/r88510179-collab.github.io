\set ON_ERROR_STOP on
-- Disposable PostgreSQL ONLY. Never run against Neon staging, a QA branch or
-- production: it creates objects and writes rows.
--
-- Authorization, sealing and content of pool_platform_season_standings_snapshot
-- (20261112_season_standings_snapshot.sql), the one read behind the season
-- standings the pages show. Run in a database of its own, after
-- tests/e2e/final-results-e2e-db-fixture.sql, which installs that migration.

DO $privileges$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='season_snapshot_probe') THEN
    CREATE ROLE season_snapshot_probe;
  END IF;
  IF NOT has_function_privilege('authenticated','public.pool_platform_season_standings_snapshot(uuid,integer)','EXECUTE')
    THEN RAISE EXCEPTION 'signed-in users cannot call the season snapshot'; END IF;
  IF has_function_privilege('season_snapshot_probe','public.pool_platform_season_standings_snapshot(uuid,integer)','EXECUTE')
    THEN RAISE EXCEPTION 'PUBLIC can call the season snapshot'; END IF;
  IF NOT (SELECT p.prosecdef AND p.provolatile='s' FROM pg_proc p
          WHERE p.oid='public.pool_platform_season_standings_snapshot(uuid,integer)'::regprocedure)
    THEN RAISE EXCEPTION 'the season snapshot must be a STABLE SECURITY DEFINER function'; END IF;
END;
$privileges$;

-- Helpers; dropped at the end. season_snapshot_as returns the snapshot for a
-- signed-in subject, or the refusal text.
CREATE FUNCTION public.season_snapshot_as(p_uid text, p_pool uuid, p_season integer)
RETURNS jsonb LANGUAGE plpgsql AS $helper$
DECLARE
  v_message text;
BEGIN
  PERFORM set_config('test.uid', p_uid, true);
  RETURN public.pool_platform_season_standings_snapshot(p_pool, p_season);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
  RETURN jsonb_build_object('refused', v_message);
END;
$helper$;
GRANT EXECUTE ON FUNCTION public.season_snapshot_as(text, uuid, integer) TO authenticated;
CREATE FUNCTION public.season_fixture_fingerprint() RETURNS text LANGUAGE sql AS $fingerprint$
  SELECT md5(concat_ws('|',
    (SELECT string_agg(x::text, chr(10) ORDER BY x::text) FROM public.pool_platform_submissions x),
    (SELECT string_agg(x::text, chr(10) ORDER BY x::text) FROM public.pool_platform_weeks x),
    (SELECT string_agg(x::text, chr(10) ORDER BY x::text) FROM public.pool_platform_entries x),
    (SELECT string_agg(x::text, chr(10) ORDER BY x::text) FROM public.pool_platform_pools x),
    (SELECT string_agg(x::text, chr(10) ORDER BY x::text) FROM public.pool_platform_week_result_revisions x),
    (SELECT string_agg(x::text, chr(10) ORDER BY x::text) FROM public.pool_platform_week_result_evidence x)));
$fingerprint$;

-- More synthetic state than the browser fixture carries: an archived entry
-- with a pick, an eliminated entry, a pick in the week still before its
-- deadline, and a draft week.
INSERT INTO public.pool_platform_entries(id,season_id,entry_code,display_name,owner_auth_user_id,status) VALUES
 ('e0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000001','A4','SYNTHETIC Archived','dave','archived'),
 ('e0000000-0000-4000-8000-000000000005','c0000000-0000-4000-8000-000000000001','A5','SYNTHETIC Eliminated','erin','eliminated');
INSERT INTO public.pool_platform_submissions(week_id,entry_id,source,submitted_by_auth_user_id,payload) VALUES
 ('d0000000-0000-4000-8000-000000000009','e0000000-0000-4000-8000-000000000004','participant','dave',
  '{"picks":{"2026_09_JAX_BAL":"away","2026_09_CIN_ATL":"away"},"tiebreak":41}'),
 ('d0000000-0000-4000-8000-000000000010','e0000000-0000-4000-8000-000000000001','participant','alice',
  '{"picks":{"2026_10_BUF_MIA":"away","2026_10_DAL_NYG":"home"},"tiebreak":38}');
INSERT INTO public.pool_platform_weeks(id,season_id,week,status,deadline_at,config) VALUES
 ('d0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000001',14,'draft',now()-interval '1 hour','{"games":[]}');

-- Two revisions for week 9: the snapshot must carry the second and nothing
-- about who recorded either, on what evidence, or why it was corrected.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('test.uid','commish_alpha',true);
SELECT public.pool_platform_attest_week_final_results_with_source('d0000000-0000-4000-8000-000000000009',0,
  '{"2026_09_JAX_BAL":{"status":"final","away_score":20,"home_score":17},
    "2026_09_CIN_ATL":{"status":"final","away_score":10,"home_score":13}}',
  repeat('a',64),'SECRET-EVIDENCE-REFERENCE-ONE');
SELECT public.pool_platform_attest_week_final_results_with_source('d0000000-0000-4000-8000-000000000009',1,
  '{"2026_09_JAX_BAL":{"status":"final","away_score":20,"home_score":27},
    "2026_09_CIN_ATL":{"status":"final","away_score":10,"home_score":13}}',
  repeat('b',64),'SECRET-EVIDENCE-REFERENCE-TWO','SECRET-CORRECTION-REASON entered by the commissioner');
COMMIT;

SELECT public.season_fixture_fingerprint() AS before_reads \gset

BEGIN;
SET LOCAL ROLE authenticated;
DO $content$
DECLARE
  c_pool   constant uuid := 'b0000000-0000-4000-8000-000000000001';
  c_survivor constant uuid := 'b0000000-0000-4000-8000-000000000002';
  commish jsonb := public.season_snapshot_as('commish_alpha', c_pool, 2026);
  w jsonb;
BEGIN
  -- Every reader who is allowed gets the same document; there is no richer view for a commissioner.
  IF commish ? 'refused' THEN RAISE EXCEPTION 'the commissioner was refused: %', commish; END IF;
  IF public.season_snapshot_as('cocommish_alpha', c_pool, 2026) IS DISTINCT FROM commish
     OR public.season_snapshot_as('alice', c_pool, 2026) IS DISTINCT FROM commish
     OR public.season_snapshot_as('bob', c_pool, 2026) IS DISTINCT FROM commish
    THEN RAISE EXCEPTION 'an allowed reader got a different document'; END IF;

  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(commish) k)
     IS DISTINCT FROM ARRAY['entries','pool_id','pool_type','rules','season','status','weeks']
    THEN RAISE EXCEPTION 'unexpected top-level keys: %', (SELECT array_agg(k) FROM jsonb_object_keys(commish) k); END IF;
  IF commish->>'pool_type' <> 'pickem' OR commish->>'status' <> 'commissioner_attested_not_official'
     OR commish->'rules' <> '{}'::jsonb OR (commish->>'season')::integer <> 2026
    THEN RAISE EXCEPTION 'unexpected header: %', commish - 'entries' - 'weeks'; END IF;

  -- Entries: active and eliminated, never archived, and nothing about their owners.
  IF (SELECT array_agg(e->>'entry_code' ORDER BY ordinality) FROM jsonb_array_elements(commish->'entries') WITH ORDINALITY AS t(e, ordinality))
     IS DISTINCT FROM ARRAY['A1','A2','A3','A5']
    THEN RAISE EXCEPTION 'unexpected entries: %', commish->'entries'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(commish->'entries') e
             WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k)
                   IS DISTINCT FROM ARRAY['display_name','entry_code','entry_id','entry_status'])
    THEN RAISE EXCEPTION 'an entry carries an unexpected key'; END IF;

  -- Weeks: every non-draft week in order; the draft week 14 is absent.
  IF (SELECT array_agg((x->>'week')::integer ORDER BY ordinality) FROM jsonb_array_elements(commish->'weeks') WITH ORDINALITY AS t(x, ordinality))
     IS DISTINCT FROM ARRAY[9,10,11,12,13]
    THEN RAISE EXCEPTION 'unexpected weeks: %', (SELECT array_agg(x->>'week') FROM jsonb_array_elements(commish->'weeks') x); END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(commish->'weeks') x
             WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k)
                   IS DISTINCT FROM ARRAY['deadline_at','games','result','submissions','visibility','week','week_id'])
    THEN RAISE EXCEPTION 'a week carries an unexpected key'; END IF;

  -- Week 10 is still before its deadline: sealed to every role, although Alice has already picked.
  w := (SELECT x FROM jsonb_array_elements(commish->'weeks') x WHERE (x->>'week')::integer = 10);
  IF w->>'visibility' <> 'sealed' OR w->'games' <> 'null'::jsonb OR w->'result' <> 'null'::jsonb OR w->'submissions' <> 'null'::jsonb
    THEN RAISE EXCEPTION 'the week before its deadline is not sealed: %', w; END IF;

  -- Week 9: the latest revision only, the picks of listed entries only, trimmed to the picks.
  w := (SELECT x FROM jsonb_array_elements(commish->'weeks') x WHERE (x->>'week')::integer = 9);
  IF w->>'visibility' <> 'after_deadline' OR jsonb_array_length(w->'games') <> 2
     OR w->'result' IS DISTINCT FROM '{"revision":2,"results":{"2026_09_JAX_BAL":{"status":"final","away_score":20,"home_score":27},
          "2026_09_CIN_ATL":{"status":"final","away_score":10,"home_score":13}}}'::jsonb
    THEN RAISE EXCEPTION 'week 9 does not carry exactly its latest revision: %', w->'result'; END IF;
  IF w->'submissions' IS DISTINCT FROM '[
      {"entry_id":"e0000000-0000-4000-8000-000000000001","source":"participant","status":"submitted",
       "payload":{"picks":{"2026_09_JAX_BAL":"away","2026_09_CIN_ATL":"home"}}},
      {"entry_id":"e0000000-0000-4000-8000-000000000002","source":"participant","status":"submitted",
       "payload":{"picks":{"2026_09_JAX_BAL":"home","2026_09_CIN_ATL":"home"}}}]'::jsonb
    THEN RAISE EXCEPTION 'week 9 submissions are not exactly the two listed entries'' picks: %', w->'submissions'; END IF;

  -- Weeks past their deadline without recorded finals say so with a null result.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(commish->'weeks') x
             WHERE (x->>'week')::integer IN (11,12,13) AND (x->>'visibility' <> 'after_deadline' OR x->'result' <> 'null'::jsonb))
    THEN RAISE EXCEPTION 'a week without finals does not carry a null result'; END IF;

  -- Nothing about who attested, on what evidence, or why. The first revision's scores are gone from view too.
  IF commish::text ~ 'commish_alpha|SECRET-|aaaaaaaa|bbbbbbbb|"home_score": ?17|tiebreak|owner|alice|bob|dave|erin'
    THEN RAISE EXCEPTION 'the snapshot leaks an attester, evidence, a reason, an owner or a superseded score'; END IF;

  -- Everyone else gets the answer a missing season gets.
  IF public.season_snapshot_as('commish_beta', c_pool, 2026) <> '{"refused":"season_not_found"}'::jsonb
     OR public.season_snapshot_as('carol', c_pool, 2026) <> '{"refused":"season_not_found"}'::jsonb
     OR public.season_snapshot_as('mallory', c_pool, 2026) <> '{"refused":"season_not_found"}'::jsonb
     OR public.season_snapshot_as('dave', c_pool, 2026) <> '{"refused":"season_not_found"}'::jsonb
     OR public.season_snapshot_as('erin', c_pool, 2026) <> '{"refused":"season_not_found"}'::jsonb
     OR public.season_snapshot_as('alice', c_pool, 2025) <> '{"refused":"season_not_found"}'::jsonb
     OR public.season_snapshot_as('alice', '00000000-0000-4000-8000-000000000000', 2026) <> '{"refused":"season_not_found"}'::jsonb
     OR public.season_snapshot_as('alice', NULL, 2026) <> '{"refused":"season_not_found"}'::jsonb
     OR public.season_snapshot_as('alice', c_pool, NULL) <> '{"refused":"season_not_found"}'::jsonb
     OR public.season_snapshot_as('alice', c_survivor, 2026) <> '{"refused":"season_not_found"}'::jsonb
    THEN RAISE EXCEPTION 'someone without standing was not answered season_not_found'; END IF;
  IF public.season_snapshot_as('', c_pool, 2026) <> '{"refused":"auth_required"}'::jsonb
    THEN RAISE EXCEPTION 'a caller without a subject was not answered auth_required'; END IF;

  -- Survivor: the pick is the team and nothing else.
  commish := public.season_snapshot_as('carol', c_survivor, 2026);
  IF commish->>'pool_type' <> 'survivor'
     OR commish->'weeks'->0->'submissions' IS DISTINCT FROM
        '[{"entry_id":"e0000000-0000-4000-8000-000000000101","source":"participant","status":"submitted","payload":{"team":"KC"}}]'::jsonb
     OR public.season_snapshot_as('commish_beta', c_survivor, 2026) IS DISTINCT FROM commish
    THEN RAISE EXCEPTION 'unexpected Survivor snapshot: %', commish; END IF;
END;
$content$;
COMMIT;
\echo SEASON_SNAPSHOT_AUTHORIZED_SEALED_AND_MINIMAL

-- Exhaustive reader matrix: every subject the fixture knows, and one it does
-- not, against every pool season. Who may read is derived here from the tables,
-- not from the function under test; the calls are made as role authenticated.
BEGIN;
DO $matrix$
DECLARE
  cases jsonb;
  answers jsonb := '[]'::jsonb;
  c jsonb;
  got jsonb;
  allowed integer := 0;
  refused integer := 0;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('uid', s.uid, 'pool', p.id, 'season', se.season, 'season_id', se.id,
      'may_read',
        EXISTS (SELECT 1 FROM public.pool_platform_memberships m
                WHERE m.tenant_id = p.tenant_id AND m.auth_user_id = s.uid
                  AND m.role IN ('owner','commissioner','co_commissioner'))
        OR EXISTS (SELECT 1 FROM public.pool_platform_entries e
                   WHERE e.season_id = se.id AND e.owner_auth_user_id = s.uid AND e.status = 'active'))
      ORDER BY s.uid, p.id)
    INTO cases
  FROM (SELECT auth_user_id AS uid FROM public.pool_platform_memberships
        UNION SELECT owner_auth_user_id FROM public.pool_platform_entries WHERE owner_auth_user_id IS NOT NULL
        UNION SELECT 'mallory') s
  CROSS JOIN public.pool_platform_pools p
  JOIN public.pool_platform_seasons se ON se.pool_id = p.id;

  EXECUTE 'SET LOCAL ROLE authenticated';
  FOR c IN SELECT * FROM jsonb_array_elements(cases) LOOP
    answers := answers || jsonb_build_array(c || jsonb_build_object('got',
      public.season_snapshot_as(c->>'uid', (c->>'pool')::uuid, (c->>'season')::integer)));
  END LOOP;
  EXECUTE 'RESET ROLE';

  FOR c IN SELECT * FROM jsonb_array_elements(answers) LOOP
    got := c->'got';
    IF (c->>'may_read')::boolean THEN
      allowed := allowed + 1;
      IF got ? 'refused' OR got->>'pool_id' IS DISTINCT FROM c->>'pool' THEN
        RAISE EXCEPTION '% was refused a pool season it belongs to (%): %', c->>'uid', c->>'pool', got;
      END IF;
      -- Nothing in the document belongs to another pool season.
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(got->'entries') x
                 WHERE NOT EXISTS (SELECT 1 FROM public.pool_platform_entries e
                                   WHERE e.id::text = x->>'entry_id' AND e.season_id::text = c->>'season_id'))
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(got->'weeks') x
                    WHERE NOT EXISTS (SELECT 1 FROM public.pool_platform_weeks w
                                      WHERE w.id::text = x->>'week_id' AND w.season_id::text = c->>'season_id'))
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(got->'weeks') x,
                      jsonb_array_elements(CASE WHEN jsonb_typeof(x->'submissions') = 'array' THEN x->'submissions' ELSE '[]'::jsonb END) sub
                    WHERE NOT EXISTS (SELECT 1 FROM public.pool_platform_entries e
                                      WHERE e.id::text = sub->>'entry_id' AND e.season_id::text = c->>'season_id'))
      THEN
        RAISE EXCEPTION 'the document read by % for % carries a row of another pool season', c->>'uid', c->>'pool';
      END IF;
    ELSE
      refused := refused + 1;
      IF got IS DISTINCT FROM '{"refused":"season_not_found"}'::jsonb THEN
        RAISE EXCEPTION '% has no standing in % and was not answered season_not_found: %', c->>'uid', c->>'pool', got;
      END IF;
    END IF;
  END LOOP;
  -- Nine subjects by two pool seasons. A fixture change that shrinks this is noticed here.
  IF allowed <> 6 OR refused <> 12 THEN
    RAISE EXCEPTION 'the reader matrix is not the expected one: % allowed, % refused', allowed, refused;
  END IF;
END;
$matrix$;
COMMIT;
\echo SEASON_SNAPSHOT_READER_MATRIX_18_OF_18

SELECT public.season_fixture_fingerprint() AS after_reads \gset
SELECT :'before_reads' = :'after_reads' AS reads_changed_nothing \gset
\if :reads_changed_nothing
\else
  \echo reading the season snapshot changed a row
  \quit 1
\endif

-- States that are rolled back: only the rules the grading understands leave
-- the database; a paused pool, an archived tenant and an oversized pool are refused.
BEGIN;
UPDATE public.pool_platform_pools SET rules='{"missingSurvivorPick":"eliminate","tiesEliminate":true,"repeatTeamsAllowed":false,
  "internalNote":"SECRET-POOL-NOTE","payout":{"first":100}}' WHERE id='b0000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
DO $rules$
BEGIN
  IF public.season_snapshot_as('carol','b0000000-0000-4000-8000-000000000002',2026)->'rules'
     IS DISTINCT FROM '{"missingSurvivorPick":"eliminate","tiesEliminate":true,"repeatTeamsAllowed":false}'::jsonb
    THEN RAISE EXCEPTION 'rules are not limited to the grading rules'; END IF;
END;
$rules$;
ROLLBACK;
BEGIN;
UPDATE public.pool_platform_pools SET status='paused' WHERE id='b0000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
DO $paused$
BEGIN
  IF public.season_snapshot_as('commish_alpha','b0000000-0000-4000-8000-000000000001',2026) <> '{"refused":"season_not_found"}'::jsonb
    THEN RAISE EXCEPTION 'a paused pool was readable'; END IF;
END;
$paused$;
ROLLBACK;
BEGIN;
INSERT INTO public.pool_platform_entries(season_id,entry_code,display_name)
  SELECT 'c0000000-0000-4000-8000-000000000001','BULK'||n,'SYNTHETIC bulk '||n FROM generate_series(1,509) n;
SET LOCAL ROLE authenticated;
DO $large$
BEGIN
  IF public.season_snapshot_as('commish_alpha','b0000000-0000-4000-8000-000000000001',2026) <> '{"refused":"standings_pool_too_large"}'::jsonb
    THEN RAISE EXCEPTION 'a pool of 513 entries was not refused'; END IF;
END;
$large$;
ROLLBACK;

DROP FUNCTION public.season_snapshot_as(text, uuid, integer);
DROP FUNCTION public.season_fixture_fingerprint();
\echo SEASON_STANDINGS_SNAPSHOT_PASS
