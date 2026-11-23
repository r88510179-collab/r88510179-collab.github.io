\set ON_ERROR_STOP on
-- Disposable PostgreSQL ONLY. Never run against Neon staging, a QA branch or
-- production: it creates objects and writes rows.
--
-- Precondition for 20261112_final_attestation_hardening.sql, which lets a
-- commissioner record finals for a week that is still 'open' once its
-- deadline has passed. That is only sound if nothing can create, change or
-- remove a pick, or change the week itself, after that deadline. This file
-- proves it on the code AS DEPLOYED on the isolated QA branch:
--
--   * the pick-writing functions come from fixtures/deployed/, the exact text
--     read from that branch's catalog;
--   * save_draft_schedule, apply_verified_schedule and open_verified_week come
--     from the repository migrations, whose bodies are byte-identical to the
--     deployed ones (SHA-256 of prosrc compared on 2026-11-12).
--
-- What a local test cannot prove, and the catalog read on the same day does:
-- on that branch no table grants INSERT, UPDATE, DELETE or TRUNCATE to
-- authenticated, anonymous or PUBLIC; pool_platform_submit_entry is the only
-- one of the 34 pool_platform_* functions that writes submissions; and none
-- of the 34 contains DELETE, MERGE or dynamic SQL.
--
-- Run in a database of its own, after tests/e2e/final-results-e2e-db-fixture.sql.
\ir ../../migrations/20261103_commissioner_draft_schedule.sql
\ir ../../migrations/20261104_phase9_verified_schedule_and_open.sql
\ir deployed/qa-submission-paths-20261112.sql

-- Table privileges of the signed-in role as on the QA branch: SELECT only.
GRANT SELECT ON public.pool_platform_submissions, public.pool_platform_submission_audit,
  public.pool_platform_weeks, public.pool_platform_entries TO authenticated;

-- Test helpers; dropped at the end. late_change_expect runs one statement as
-- the given signed-in subject and fails unless the outcome is the expected
-- one: the exception text for an application refusal, the SQLSTATE otherwise,
-- or ACCEPTED.
CREATE FUNCTION public.late_change_expect(p_uid text, p_sql text, p_expected text)
RETURNS text LANGUAGE plpgsql AS $helper$
DECLARE
  v_state text;
  v_message text;
  v_outcome text := 'ACCEPTED';
BEGIN
  PERFORM set_config('test.uid', p_uid, true);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_outcome := CASE WHEN v_state = 'P0001' THEN v_message ELSE v_state END;
  END;
  IF v_outcome IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'as %: expected %, got % for: %', p_uid, p_expected, v_outcome, p_sql;
  END IF;
  RETURN v_outcome;
END;
$helper$;
GRANT EXECUTE ON FUNCTION public.late_change_expect(text, text, text) TO authenticated;

-- Everything a late change could touch, as one value.
CREATE FUNCTION public.late_change_fingerprint() RETURNS text LANGUAGE sql AS $fingerprint$
  SELECT md5(concat_ws('|',
    (SELECT string_agg(s::text, E'\n' ORDER BY s.id) FROM public.pool_platform_submissions s),
    (SELECT string_agg(a::text, E'\n' ORDER BY a.id) FROM public.pool_platform_submission_audit a),
    (SELECT string_agg(w::text, E'\n' ORDER BY w.id) FROM public.pool_platform_weeks w),
    (SELECT string_agg(e::text, E'\n' ORDER BY e.id) FROM public.pool_platform_entries e)));
$fingerprint$;
REVOKE ALL ON FUNCTION public.late_change_fingerprint() FROM PUBLIC;

-- Week 11 is open and its deadline passed two days ago. Alice picked in time;
-- Bob and the unclaimed entry never did.
INSERT INTO public.pool_platform_submissions(id,week_id,entry_id,source,submitted_by_auth_user_id,payload,submitted_at,updated_at)
VALUES ('f0000000-0000-4000-8000-000000000011','d0000000-0000-4000-8000-000000000011',
  'e0000000-0000-4000-8000-000000000001','participant','alice',
  '{"picks":{"2026_11_DEN_CAR":"away","2026_11_DET_CHI":"home"}}',now()-interval '3 days',now()-interval '3 days');
INSERT INTO public.pool_platform_submission_audit(submission_id,actor_auth_user_id,action,source,previous_payload,next_payload,created_at)
VALUES ('f0000000-0000-4000-8000-000000000011','alice','created','participant',NULL,
  '{"picks":{"2026_11_DEN_CAR":"away","2026_11_DET_CHI":"home"}}',now()-interval '3 days');

-- 1. Positive control: before a deadline the same functions accept. Week 10
--    closes in seven days.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT public.late_change_expect('alice', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000010','e0000000-0000-4000-8000-000000000001',
    'participant','{"picks":{"2026_10_BUF_MIA":"away","2026_10_DAL_NYG":"home"}}') $q$, 'ACCEPTED');
SELECT public.late_change_expect('alice', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000010','e0000000-0000-4000-8000-000000000001',
    'participant','{"picks":{"2026_10_BUF_MIA":"home","2026_10_DAL_NYG":"home"}}') $q$, 'ACCEPTED');
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_submit_batch('d0000000-0000-4000-8000-000000000010','commissioner_manual',
    '[{"entry_id":"e0000000-0000-4000-8000-000000000003","payload":{"picks":{"2026_10_BUF_MIA":"away","2026_10_DAL_NYG":"away"}}}]') $q$, 'ACCEPTED');
COMMIT;
DO $control$
BEGIN
  IF (SELECT revision FROM public.pool_platform_submissions
      WHERE week_id='d0000000-0000-4000-8000-000000000010' AND entry_id='e0000000-0000-4000-8000-000000000001') <> 2
    THEN RAISE EXCEPTION 'positive control: the in-time pick was not created and then updated'; END IF;
  IF (SELECT count(*) FROM public.pool_platform_submissions
      WHERE week_id='d0000000-0000-4000-8000-000000000010') <> 2
    THEN RAISE EXCEPTION 'positive control: the commissioner batch did not store its item'; END IF;
  IF (SELECT string_agg(a.action, ',' ORDER BY a.id) FROM public.pool_platform_submission_audit a
      JOIN public.pool_platform_submissions s ON s.id=a.submission_id
      WHERE s.week_id='d0000000-0000-4000-8000-000000000010') <> 'created,updated,created'
    THEN RAISE EXCEPTION 'positive control: the audit trail is not created, updated, created'; END IF;
END;
$control$;
\echo IN_TIME_SUBMISSIONS_ACCEPTED

-- 2. The boundary is exact. now() is the transaction's start time in the
--    function and here, so a deadline equal to now() has passed and one a
--    microsecond later has not. Rolled back.
BEGIN;
INSERT INTO public.pool_platform_weeks(id,season_id,week,status,deadline_at,config) VALUES
 ('d0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000001',14,'open',now(),
  '{"games":[{"id":"2026_14_AAA_BBB","away":{"key":"AAA"},"home":{"key":"BBB"},"kickoff":"2099-01-01T00:00:00.000Z"}]}'),
 ('d0000000-0000-4000-8000-000000000015','c0000000-0000-4000-8000-000000000001',15,'open',now()+interval '1 microsecond',
  '{"games":[{"id":"2026_15_CCC_DDD","away":{"key":"CCC"},"home":{"key":"DDD"},"kickoff":"2099-01-01T00:00:00.000Z"}]}');
SET LOCAL ROLE authenticated;
SELECT public.late_change_expect('alice', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000014','e0000000-0000-4000-8000-000000000001',
    'participant','{"picks":{"2026_14_AAA_BBB":"away"}}') $q$, 'deadline_passed');
SELECT public.late_change_expect('alice', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000015','e0000000-0000-4000-8000-000000000001',
    'participant','{"picks":{"2026_15_CCC_DDD":"away"}}') $q$, 'ACCEPTED');
ROLLBACK;
\echo DEADLINE_BOUNDARY_IS_EXACT

SELECT public.late_change_fingerprint() AS before_late_attempts \gset

-- 3. After the deadline, every submission path is refused for every source
--    and every role, whether the pick would be new or would replace one.
BEGIN;
SET LOCAL ROLE authenticated;
-- the owner replacing a pick made in time
SELECT public.late_change_expect('alice', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000001',
    'participant','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'deadline_passed');
-- an owner who never picked
SELECT public.late_change_expect('bob', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002',
    'participant','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'deadline_passed');
-- the commissioner entering a pick by hand, for an unclaimed entry and for a claimed one
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000003',
    'commissioner_manual','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'deadline_passed');
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000001',
    'commissioner_manual','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'deadline_passed');
-- the commissioner import source, and a co-commissioner
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002',
    'commissioner_import','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'deadline_passed');
SELECT public.late_change_expect('cocommish_alpha', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002',
    'commissioner_manual','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'deadline_passed');
-- people with no standing learn nothing about the week
SELECT public.late_change_expect('commish_beta', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002',
    'commissioner_manual','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'commissioner_required');
SELECT public.late_change_expect('mallory', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000001',
    'participant','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'entry_not_owned');
-- weeks that are locked or final
SELECT public.late_change_expect('alice', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000009','e0000000-0000-4000-8000-000000000001',
    'participant','{"picks":{"2026_09_JAX_BAL":"home","2026_09_CIN_ATL":"home"}}') $q$, 'week_not_open');
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000013','e0000000-0000-4000-8000-000000000003',
    'commissioner_manual','{"picks":{}}') $q$, 'week_not_open');
COMMIT;

-- The batch import reports each item instead of raising. Every item must be refused.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('test.uid','commish_alpha',true);
DO $batch$
DECLARE
  got jsonb;
BEGIN
  got := public.pool_platform_submit_batch('d0000000-0000-4000-8000-000000000011','commissioner_import', '[
    {"entry_id":"e0000000-0000-4000-8000-000000000001","payload":{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}},
    {"entry_id":"e0000000-0000-4000-8000-000000000002","payload":{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}},
    {"entry_id":"e0000000-0000-4000-8000-000000000003","payload":{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}}]');
  IF jsonb_array_length(got) <> 3
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(got) item
                WHERE (item->>'ok')::boolean IS DISTINCT FROM false OR item->>'code' IS DISTINCT FROM 'deadline_passed')
    THEN RAISE EXCEPTION 'a late batch item was not refused as deadline_passed: %', got; END IF;
END;
$batch$;
COMMIT;
\echo LATE_SUBMISSIONS_REFUSED_FOR_EVERY_SOURCE_AND_ROLE

-- 4. Once a week is open, nothing can move its deadline, replace its games or
--    put it back into draft: each function that writes a week row accepts a
--    draft only, and the remaining one only inserts a new draft.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_save_draft_schedule('d0000000-0000-4000-8000-000000000011',
    '{"scheduleSource":"commissioner_manual","scheduleVerification":"pending","tiebreakRequired":false,
      "games":[{"id":"MANUAL-20991231-AAA-BBB","away":"AAA","home":"BBB","kickoff":"2099-12-31T00:00:00Z"}]}') $q$, 'week_not_draft');
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_apply_verified_schedule('d0000000-0000-4000-8000-000000000011',repeat('a',64),false) $q$, 'week_not_draft');
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_open_verified_week('d0000000-0000-4000-8000-000000000011',repeat('a',64),true) $q$, 'week_not_draft');
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_create_draft_week('c0000000-0000-4000-8000-000000000001',11,now()+interval '30 days',NULL) $q$,
  'duplicate_week_number');
COMMIT;
\echo OPEN_WEEK_CANNOT_BE_REOPENED_OR_RESCHEDULED

-- 5. Direct table writes by the signed-in role are refused by privilege
--    (42501), for picks, their audit trail, weeks and entries.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT public.late_change_expect('alice', $q$ UPDATE public.pool_platform_submissions SET payload='{}' $q$, '42501');
SELECT public.late_change_expect('alice', $q$ DELETE FROM public.pool_platform_submissions $q$, '42501');
SELECT public.late_change_expect('alice', $q$ TRUNCATE public.pool_platform_submissions CASCADE $q$, '42501');
SELECT public.late_change_expect('alice', $q$
  INSERT INTO public.pool_platform_submissions(week_id,entry_id,source,payload)
  VALUES ('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002','participant','{}') $q$, '42501');
SELECT public.late_change_expect('alice', $q$ DELETE FROM public.pool_platform_submission_audit $q$, '42501');
SELECT public.late_change_expect('commish_alpha', $q$
  UPDATE public.pool_platform_weeks SET deadline_at=now()+interval '1 day' $q$, '42501');
SELECT public.late_change_expect('commish_alpha', $q$ UPDATE public.pool_platform_weeks SET status='draft' $q$, '42501');
SELECT public.late_change_expect('commish_alpha', $q$ DELETE FROM public.pool_platform_weeks $q$, '42501');
SELECT public.late_change_expect('commish_alpha', $q$ DELETE FROM public.pool_platform_entries $q$, '42501');
COMMIT;
\echo DIRECT_TABLE_WRITES_REFUSED

SELECT public.late_change_fingerprint() AS after_late_attempts \gset
SELECT :'before_late_attempts' = :'after_late_attempts' AS nothing_changed \gset
\if :nothing_changed
\else
  \echo a refused attempt changed a pick, its audit trail, a week or an entry
  \quit 1
\endif

-- 6. With the hardening migration (loaded by the e2e fixture), finals are
--    recorded for the open week past its deadline, and that changes neither
--    a pick nor the week. The late paths stay closed afterwards.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_attest_week_final_results_with_source('d0000000-0000-4000-8000-000000000010',0,
    '{"2026_10_BUF_MIA":{"status":"final","away_score":20,"home_score":17},
      "2026_10_DAL_NYG":{"status":"final","away_score":10,"home_score":13}}',
    repeat('a',64),'https://example.invalid/synthetic-evidence') $q$, 'week_not_eligible_for_final_attestation');
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_attest_week_final_results_with_source('d0000000-0000-4000-8000-000000000011',0,
    '{"2026_11_DEN_CAR":{"status":"final","away_score":20,"home_score":17},
      "2026_11_DET_CHI":{"status":"final","away_score":10,"home_score":13}}',
    repeat('a',64),'https://example.invalid/synthetic-evidence') $q$, 'ACCEPTED');
SELECT public.late_change_expect('alice', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000001',
    'participant','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'deadline_passed');
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_submit_entry('d0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000003',
    'commissioner_manual','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"home"}}') $q$, 'deadline_passed');
SELECT public.late_change_expect('commish_alpha', $q$
  SELECT public.pool_platform_save_draft_schedule('d0000000-0000-4000-8000-000000000011',
    '{"scheduleSource":"commissioner_manual","scheduleVerification":"pending","tiebreakRequired":false,
      "games":[{"id":"MANUAL-20991231-AAA-BBB","away":"AAA","home":"BBB","kickoff":"2099-12-31T00:00:00Z"}]}') $q$, 'week_not_draft');
COMMIT;
DO $recorded$
BEGIN
  IF (SELECT count(*) FROM public.pool_platform_week_result_revisions
      WHERE week_id='d0000000-0000-4000-8000-000000000011') <> 1
    THEN RAISE EXCEPTION 'the open week past its deadline did not get exactly one result revision'; END IF;
  IF (SELECT count(*) FROM public.pool_platform_week_result_revisions
      WHERE week_id='d0000000-0000-4000-8000-000000000010') <> 0
    THEN RAISE EXCEPTION 'a week before its deadline got a result revision'; END IF;
END;
$recorded$;
SELECT public.late_change_fingerprint() AS after_attestation \gset
SELECT :'before_late_attempts' = :'after_attestation' AS attestation_changed_nothing \gset
\if :attestation_changed_nothing
\else
  \echo recording finals changed a pick, its audit trail, a week or an entry
  \quit 1
\endif

DROP FUNCTION public.late_change_expect(text, text, text);
DROP FUNCTION public.late_change_fingerprint();
\echo LATE_CHANGE_PATHS_ALL_REFUSED_PASS
