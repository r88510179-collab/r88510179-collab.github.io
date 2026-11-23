\set ON_ERROR_STOP on
-- Disposable PostgreSQL ONLY; run after pool-standings, pool-result-attestations
-- and pool-result-evidence fixtures. Never run against Neon staging/production.
-- Part 1 proves the validation defect on the function as the two earlier
-- migrations left it; part 2 applies 20261112_final_attestation_hardening.sql
-- and proves the defect closed with every earlier guarantee still in force.
INSERT INTO public.pool_platform_weeks VALUES
 ('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001',11,'open','2020-01-01T00:00:00Z',
  '{"games":[{"id":"g4","away":{"key":"CIN"},"home":{"key":"ATL"},"kickoff":"2020-01-02T00:00:00Z"}]}'),
 ('30000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000001',12,'draft','2020-01-01T00:00:00Z',
  '{"games":[{"id":"g5","away":{"key":"CLE"},"home":{"key":"NO"},"kickoff":"2020-01-02T00:00:00Z"}]}'),
 ('30000000-0000-0000-0000-000000000006','20000000-0000-0000-0000-000000000001',13,'locked','2020-01-01T00:00:00Z',
  '{"games":[{"id":"g6","away":{"key":"DEN"},"home":{"key":"CAR"},"kickoff":"2020-01-02T00:00:00Z"},
             {"id":"g7","away":{"key":"DET"},"home":{"key":"MIA"},"kickoff":"2099-01-01T00:00:00Z"}]}'),
 ('30000000-0000-0000-0000-000000000007','20000000-0000-0000-0000-000000000002',10,'locked','2020-01-01T00:00:00Z',
  '{"games":[{"id":"g8","away":{"key":"LAR"},"home":{"key":"WAS"},"kickoff":"2020-01-02T00:00:00Z"}]}');

INSERT INTO public.pool_platform_weeks
SELECT ('30000000-0000-0000-0000-00000000001'||n)::uuid,
  '20000000-0000-0000-0000-000000000001',13+n,'locked','2020-01-01T00:00:00Z',
  jsonb_build_object('games',jsonb_build_array(jsonb_strip_nulls(
    '{"id":"g9","away":{"key":"CLE"},"home":{"key":"NO"}}'::jsonb||jsonb_build_object('kickoff',kickoff))))
FROM unnest(ARRAY[NULL,'','2020-01-02','2020-01-02T00:00:00','2020-02-30T00:00:00Z',
  '2020-01-02T24:00:00Z','-infinity','yesterday']) WITH ORDINALITY AS t(kickoff,n);

-- Part 1: the defect, inside a transaction that is rolled back so nothing it
-- wrote survives into part 2.
BEGIN;
SET LOCAL ROLE authenticated;
DO $defect$
DECLARE
  w uuid := '30000000-0000-0000-0000-000000000007';
  got jsonb;
BEGIN
  PERFORM set_config('test.uid','commish_beta',true);
  got:=public.pool_platform_attest_week_final_results_with_source(w,0,
    '{"g8":{"away_score":21,"home_score":14,"note":"not a final"}}'::jsonb,
    repeat('d',64),'https://www.nfl.com/scores/2026/reg10');
  IF (got->>'revision')::integer<>1 THEN
    RAISE EXCEPTION 'expected the unpatched function to accept a result without status';
  END IF;
  got:=public.pool_platform_attest_week_final_results_with_source(w,1,
    '{"g8":{"status":null,"away_score":21,"home_score":14}}'::jsonb,
    repeat('e',64),'https://www.nfl.com/scores/2026/reg10','Null status probe for the defect');
  IF (got->>'revision')::integer<>2 THEN
    RAISE EXCEPTION 'expected the unpatched function to accept a null status';
  END IF;
END;
$defect$;
ROLLBACK;
\echo UNPATCHED_NULL_STATUS_DEFECT_REPRODUCED

DO $clean$
BEGIN
  IF (SELECT count(*) FROM public.pool_platform_week_result_revisions
      WHERE week_id='30000000-0000-0000-0000-000000000007')<>0
    THEN RAISE EXCEPTION 'defect probe was not rolled back'; END IF;
END;
$clean$;

-- Part 2: the reviewed fix.
\i migrations/20261112_final_attestation_hardening.sql

DO $privileges$
BEGIN
  IF has_function_privilege('authenticated',
    'public.pool_platform_attest_week_final_results(uuid,integer,jsonb,text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'replacing the function re-opened the private RPC to browsers'; END IF;
  IF NOT has_function_privilege('authenticated',
    'public.pool_platform_attest_week_final_results_with_source(uuid,integer,jsonb,text,text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'evidence RPC no longer callable by signed-in users'; END IF;
  IF has_function_privilege('unprivileged_test',
    'public.pool_platform_attest_week_final_results(uuid,integer,jsonb,text,text)','EXECUTE')
    OR has_function_privilege('unprivileged_test',
    'public.pool_platform_attest_week_final_results_with_source(uuid,integer,jsonb,text,text,text)','EXECUTE')
    OR has_function_privilege('unprivileged_test',
    'public.pool_platform_forbid_result_revision_change()','EXECUTE')
    THEN RAISE EXCEPTION 'PUBLIC can execute a result function'; END IF;
  IF has_table_privilege('authenticated','public.pool_platform_week_result_revisions','TRUNCATE')
    OR has_table_privilege('authenticated','public.pool_platform_week_result_evidence','TRUNCATE')
    OR has_table_privilege('authenticated','public.pool_platform_week_result_evidence','DELETE')
    THEN RAISE EXCEPTION 'signed-in role holds a destructive table privilege'; END IF;
END;
$privileges$;

SET ROLE authenticated;
DO $fixed$
DECLARE
  beta_week uuid := '30000000-0000-0000-0000-000000000007';
  open_past uuid := '30000000-0000-0000-0000-000000000004';
  open_future uuid := '30000000-0000-0000-0000-000000000002';
  draft_week uuid := '30000000-0000-0000-0000-000000000005';
  future_kick uuid := '30000000-0000-0000-0000-000000000006';
  ref text := 'https://www.nfl.com/scores/2026/reg10';
  d text := repeat('f',64);
  got jsonb;
  err text;
  bad jsonb;
  n integer;
BEGIN
  PERFORM set_config('test.uid','commish_beta',false);
  -- Every malformed per-game object fails closed with the same code.
  FOREACH bad IN ARRAY ARRAY[
    '{"g8":{"away_score":21,"home_score":14,"note":"not a final"}}',
    '{"g8":{"status":null,"away_score":21,"home_score":14}}',
    '{"g8":{"status":"FINAL","away_score":21,"home_score":14}}',
    '{"g8":{"status":"final ","away_score":21,"home_score":14}}',
    '{"g8":{"status":true,"away_score":21,"home_score":14}}',
    '{"g8":{"status":"final","away_score":"21","home_score":14}}',
    '{"g8":{"status":"final","away_score":21.5,"home_score":14}}',
    '{"g8":{"status":"final","away_score":-1,"home_score":14}}',
    '{"g8":{"status":"final","away_score":201,"home_score":14}}',
    '{"g8":{"status":"final","away_score":null,"home_score":14}}',
    '{"g8":{"status":"final","away_score":21}}',
    '{"g8":{"status":"final","away_score":21,"home_score":14,"extra":1}}',
    '{"g8":["final",21,14]}',
    '{"g8":null}'
  ]::jsonb[] LOOP
    BEGIN
      PERFORM public.pool_platform_attest_week_final_results_with_source(beta_week,0,bad,d,ref);
      RAISE EXCEPTION 'malformed final result accepted: %',bad;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
      IF err<>'invalid_final_results' THEN RAISE; END IF;
    END;
  END LOOP;
  -- A well-formed final still records, 0–200 inclusive and ties included.
  got:=public.pool_platform_attest_week_final_results_with_source(beta_week,0,
    '{"g8":{"status":"final","away_score":0,"home_score":200}}'::jsonb,d,ref);
  IF (got->>'revision')::integer<>1 OR got->>'source_reference_saved'<>'true' THEN
    RAISE EXCEPTION 'valid final was refused after hardening'; END IF;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(beta_week,1,
      '{"g8":{"status":"final","away_score":17,"home_score":17}}'::jsonb,d,ref,
      E'Corrected after review\nsecond line');
    RAISE EXCEPTION 'control character accepted in correction reason';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'correction_reason_required' THEN RAISE; END IF;
  END;
  got:=public.pool_platform_attest_week_final_results_with_source(beta_week,1,
    '{"g8":{"status":"final","away_score":17,"home_score":17}}'::jsonb,d,ref,
    'Corrected after independent review');
  IF (got->>'revision')::integer<>2 THEN
    RAISE EXCEPTION 'valid correction was refused after hardening'; END IF;

  -- Cross-tenant and participant-only writes stay indistinguishable from a
  -- missing week, on the newly eligible open week as well.
  PERFORM set_config('test.uid','alice',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(open_past,0,
      '{"g4":{"status":"final","away_score":7,"home_score":3}}'::jsonb,d,ref);
    RAISE EXCEPTION 'participant attested an open week';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;
  PERFORM set_config('test.uid','commish_beta',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(open_past,0,
      '{"g4":{"status":"final","away_score":7,"home_score":3}}'::jsonb,d,ref);
    RAISE EXCEPTION 'foreign commissioner attested an open week';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;

  PERFORM set_config('test.uid','commish_alpha',false);
  -- Still refused: before the deadline, a draft, and a game not kicked off.
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(open_future,0,
      '{"g2":{"status":"final","away_score":7,"home_score":3}}'::jsonb,d,ref);
    RAISE EXCEPTION 'open week before its deadline accepted a final';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_eligible_for_final_attestation' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(draft_week,0,
      '{"g5":{"status":"final","away_score":7,"home_score":3}}'::jsonb,d,ref);
    RAISE EXCEPTION 'draft week accepted a final';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_eligible_for_final_attestation' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(future_kick,0,
      '{"g6":{"status":"final","away_score":7,"home_score":3},"g7":{"status":"final","away_score":1,"home_score":0}}'::jsonb,d,ref);
    RAISE EXCEPTION 'a game that has not kicked off was marked final';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'game_not_started_or_schedule_missing' THEN RAISE; END IF;
  END;
  FOR n IN 1..8 LOOP
    BEGIN
      PERFORM public.pool_platform_attest_week_final_results_with_source(
        ('30000000-0000-0000-0000-00000000001'||n)::uuid,0,
        '{"g9":{"status":"final","away_score":7,"home_score":3}}'::jsonb,d,ref);
      RAISE EXCEPTION 'invalid stored kickoff accepted for fixture %',n;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
      IF err<>(CASE WHEN n=1 THEN 'game_not_started_or_schedule_missing' ELSE 'invalid_verified_schedule' END)
        THEN RAISE; END IF;
    END;
  END LOOP;
  -- Newly eligible: an open week past its deadline with every game kicked off.
  got:=public.pool_platform_attest_week_final_results_with_source(open_past,0,
    '{"g4":{"status":"final","away_score":7,"home_score":3}}'::jsonb,d,ref);
  IF (got->>'revision')::integer<>1 THEN
    RAISE EXCEPTION 'open week past its deadline could not be attested'; END IF;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(open_past,0,
      '{"g4":{"status":"final","away_score":3,"home_score":7}}'::jsonb,d,ref);
    RAISE EXCEPTION 'stale revision accepted on an open week';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'stale_result_revision' THEN RAISE; END IF;
  END;
  -- A participant of that pool reads the attested open-week result; an
  -- outsider and a foreign commissioner still cannot tell it exists.
  PERFORM set_config('test.uid','alice',false);
  got:=public.pool_platform_week_result_snapshot(open_past);
  IF got->>'status'<>'commissioner_attested_not_official' OR (got->>'revision')::integer<>1
     OR got::text LIKE '%commish_alpha%' OR got::text LIKE '%nfl.com%' OR got ? 'source_sha256'
    THEN RAISE EXCEPTION 'participant snapshot wrong, or leaks attester or evidence'; END IF;
  PERFORM set_config('test.uid','commish_beta',false);
  BEGIN
    PERFORM public.pool_platform_week_result_snapshot(open_past);
    RAISE EXCEPTION 'foreign commissioner read an attested result';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;
  PERFORM set_config('test.uid','',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(open_past,1,
      '{"g4":{"status":"final","away_score":3,"home_score":7}}'::jsonb,d,ref,'Unauthenticated correction');
    RAISE EXCEPTION 'anonymous write was permitted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'auth_required' THEN RAISE; END IF;
  END;
END;
$fixed$;
RESET ROLE;

-- Owner-level checks: nothing the refused calls attempted was written, the
-- append-only guarantee now covers TRUNCATE, and picks are untouched.
DO $owner$
DECLARE err text;
BEGIN
  IF (SELECT count(*) FROM public.pool_platform_week_result_revisions
      WHERE week_id IN ('30000000-0000-0000-0000-000000000002',
        '30000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000006'))<>0
    THEN RAISE EXCEPTION 'a refused attestation left a revision behind'; END IF;
  IF EXISTS (SELECT 1 FROM public.pool_platform_week_result_revisions
      WHERE week_id::text LIKE '30000000-0000-0000-0000-00000000001_')
    THEN RAISE EXCEPTION 'an invalid kickoff left a revision behind'; END IF;
  IF EXISTS (SELECT 1 FROM public.pool_platform_week_result_revisions r,
      jsonb_each(r.results) g WHERE g.value->>'status' IS DISTINCT FROM 'final')
    THEN RAISE EXCEPTION 'a stored result is not a final'; END IF;
  IF (SELECT count(*) FROM public.pool_platform_week_result_revisions r
      LEFT JOIN public.pool_platform_week_result_evidence e USING (week_id,revision)
      WHERE r.week_id IN ('30000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000007')
        AND e.source_reference IS DISTINCT FROM 'https://www.nfl.com/scores/2026/reg10')<>0
    THEN RAISE EXCEPTION 'a revision recorded through the evidence RPC has no evidence row'; END IF;
  BEGIN
    TRUNCATE public.pool_platform_week_result_evidence;
    RAISE EXCEPTION 'evidence table was truncated';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'result_revisions_are_append_only' THEN RAISE; END IF;
  END;
  BEGIN
    TRUNCATE public.pool_platform_week_result_revisions CASCADE;
    RAISE EXCEPTION 'revision table was truncated';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'result_revisions_are_append_only' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.pool_platform_submissions)<>2 OR
     (SELECT payload->>'secret' FROM public.pool_platform_submissions
      WHERE id='50000000-0000-0000-0000-000000000001')<>'not permitted'
    THEN RAISE EXCEPTION 'an existing submission was altered'; END IF;
  IF (SELECT status FROM public.pool_platform_weeks
      WHERE id='30000000-0000-0000-0000-000000000004')<>'open'
    THEN RAISE EXCEPTION 'attestation changed the week row'; END IF;
END;
$owner$;
\echo EPHEMERAL_ATTESTATION_HARDENING_PASS
