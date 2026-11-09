-- Full-field publication guard (migration 20261108_full_field_publish_guard.sql), exercised on the throwaway PostgreSQL
-- after migrations 001-005, the guard and fixtures. Run as the cluster superuser, connected to nfl_pool. Every write is
-- made the way the Data API makes it for the signed-in commissioner (role authenticated, JWT claims, row-level security),
-- so a stale cached Admin page that skips the browser checks meets the same refusal. Each check prints
-- "GUARD-TEST ok: ..." or "GUARD-TEST FAIL: ..."; run.sh requires every planned check to pass.
\set ON_ERROR_STOP on
\echo GUARD-PLAN 9

DO $guard_tests$
DECLARE
  base jsonb := jsonb_build_object(
    'schemaVersion', 1, 'season', 2098, 'week', 1, 'label', 'Week 1', 'tiePoints', 0, 'tiebreakGameIndex', 0,
    'games', jsonb_build_array(jsonb_build_object('away', 'CIN', 'home', 'ATL', 'awayNumber', 1, 'homeNumber', 2)),
    'participants', jsonb_build_array(jsonb_build_object('id', 'dc'), jsonb_build_object('id', 'jc'),
                                      jsonb_build_object('id', 'djs'), jsonb_build_object('id', 'thaddeus')),
    'source', jsonb_build_object('kind', 'weekly-upload', 'filename', 'synthetic.pdf'));
  complete jsonb;
  item record;
  outcome text;
BEGIN
  complete := base || jsonb_build_object('fullFieldReady', true, 'fullFieldEntryCount', 2, 'competitionSize', 6,
    'fieldEntries', jsonb_build_array(jsonb_build_object('id', 'field-001', 'pickNumbers', jsonb_build_array(1), 'tiebreak', 40),
                                      jsonb_build_object('id', 'field-002', 'pickNumbers', jsonb_build_array(0), 'tiebreak', NULL)));
  FOR item IN SELECT * FROM (VALUES
    ('refused',  'locked', 'a tracked-only locked weekly upload (the Week 9 incident shape a stale Admin page published)', base || '{"fullFieldReady": false}'::jsonb),
    ('refused',  'locked', 'fullFieldReady false alongside anonymous entries', complete || '{"fullFieldReady": false}'::jsonb),
    ('refused',  'locked', 'an empty anonymous field', complete || '{"fieldEntries": [], "fullFieldEntryCount": 0, "competitionSize": 4}'::jsonb),
    ('refused',  'locked', 'a competitionSize that is not participants plus fieldEntries', complete || '{"competitionSize": 7}'::jsonb),
    ('refused',  'locked', 'a fullFieldEntryCount that does not match fieldEntries', complete || '{"fullFieldEntryCount": 3}'::jsonb),
    ('refused',  'locked', 'three tracked entries', complete || jsonb_build_object('participants', (complete -> 'participants') - 3, 'competitionSize', 5)),
    ('accepted', 'locked', 'a complete full-field locked weekly upload', complete),
    ('accepted', 'draft',  'an unpublished draft weekly upload', base || '{"fullFieldReady": false}'::jsonb),
    ('accepted', 'locked', 'a legacy-seed week without a full field', base || '{"fullFieldReady": false, "source": {"kind": "legacy-seed"}}'::jsonb)
  ) AS t(expect, status, label, cfg) LOOP
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
      SET LOCAL ROLE authenticated;
      INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision) VALUES (2098, 1, item.status, item.cfg, 1);
      RESET ROLE;
      DELETE FROM public.nfl_pool_weeks WHERE season = 2098 AND week = 1;
      outcome := 'accepted';
    EXCEPTION WHEN check_violation THEN
      outcome := 'refused';
    END;
    IF outcome = item.expect THEN
      RAISE NOTICE 'GUARD-TEST ok: % is %', item.label, outcome;
    ELSE
      RAISE NOTICE 'GUARD-TEST FAIL: % was % (expected %)', item.label, outcome, item.expect;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.nfl_pool_weeks WHERE season = 2098) THEN
    RAISE EXCEPTION 'guard tests left a row behind';
  END IF;
END
$guard_tests$;
