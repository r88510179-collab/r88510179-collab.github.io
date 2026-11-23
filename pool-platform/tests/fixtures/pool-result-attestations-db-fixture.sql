\set ON_ERROR_STOP on
-- This fixture runs ONLY in ephemeral GitHub Actions PostgreSQL, after
-- pool-standings-db-fixture.sql. Never run it against Neon staging/production.
-- Verify the new RPC cannot mutate existing picks or bypass pool membership.
UPDATE public.pool_platform_weeks
SET config=jsonb_set(config,'{games,0,kickoff}','"2020-01-01T00:00:00Z"'::jsonb)
WHERE id IN (
 '30000000-0000-0000-0000-000000000001',
 '30000000-0000-0000-0000-000000000002',
 '30000000-0000-0000-0000-000000000003'
);
\i migrations/20261111_week_final_attestations.sql

-- The Data API role can only use the two RPCs, not the revision table.
CREATE ROLE unprivileged_test;
DO $test$
BEGIN
  IF has_table_privilege('authenticated','public.pool_platform_week_result_revisions','SELECT') OR
     has_table_privilege('authenticated','public.pool_platform_week_result_revisions','INSERT') OR
     has_table_privilege('authenticated','public.pool_platform_week_result_revisions','UPDATE') OR
     has_table_privilege('authenticated','public.pool_platform_week_result_revisions','DELETE')
    THEN RAISE EXCEPTION 'direct authenticated table privilege detected'; END IF;
  IF NOT has_function_privilege('authenticated',
    'public.pool_platform_attest_week_final_results(uuid,integer,jsonb,text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'commissioner attest RPC inaccessible'; END IF;
  IF has_function_privilege('unprivileged_test',
    'public.pool_platform_attest_week_final_results(uuid,integer,jsonb,text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'public function execution unexpectedly allowed'; END IF;
END;
$test$;

SET ROLE authenticated;
DO $test$
DECLARE
  got jsonb;
  err text;
  g1 jsonb := '{"g1":{"status":"final","away_score":21,"home_score":14}}'::jsonb;
  g1fixed jsonb := '{"g1":{"status":"final","away_score":14,"home_score":21}}'::jsonb;
  digest_a text := repeat('a',64);
  digest_b text := repeat('b',64);
  week_a uuid := '30000000-0000-0000-0000-000000000001';
  week_open uuid := '30000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM set_config('test.uid','alice',false);
  got:=public.pool_platform_week_result_snapshot(week_a);
  IF got->>'status'<>'unpublished' THEN
    RAISE EXCEPTION 'participant cannot read unpublished state'; END IF;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_a,0,g1,digest_a);
    RAISE EXCEPTION 'participant was able to attest final results';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;

  PERFORM set_config('test.uid','commish_beta',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_a,0,g1,digest_a);
    RAISE EXCEPTION 'foreign commissioner was able to attest';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_week_result_snapshot(week_a);
    RAISE EXCEPTION 'foreign commissioner was able to read result';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;

  PERFORM set_config('test.uid','commish_alpha',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_open,0,
      '{"g2":{"status":"final","away_score":7,"home_score":3}}'::jsonb,digest_a);
    RAISE EXCEPTION 'open future-deadline week accepted final';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_eligible_for_final_attestation' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_a,0,
      '{"g1":{"status":"live","away_score":21,"home_score":14}}'::jsonb,digest_a);
    RAISE EXCEPTION 'live score accepted as verified final';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'invalid_final_results' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_a,0,
      '{"g1":{"status":"final","away_score":21,"home_score":14},"forged":{"status":"final","away_score":0,"home_score":0}}'::jsonb,digest_a);
    RAISE EXCEPTION 'extra game accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'invalid_final_results' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_a,0,
      '{"g1":{"status":"final","away_score":21,"home_score":14,"secret":"x"}}'::jsonb,digest_a);
    RAISE EXCEPTION 'unrecognized result metadata accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'invalid_final_results' THEN RAISE; END IF;
  END;

  got:=public.pool_platform_attest_week_final_results(week_a,0,g1,digest_a);
  IF got->>'status'<>'commissioner_attested_not_official' OR
     (got->>'revision')::integer<>1 THEN
    RAISE EXCEPTION 'initial commissioner attestation failed'; END IF;

  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_a,0,g1,digest_a);
    RAISE EXCEPTION 'stale initial revision accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'stale_result_revision' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_a,1,g1fixed,digest_b);
    RAISE EXCEPTION 'unreasoned correction accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'correction_reason_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_a,1,g1,digest_b,
      'No real final result changed');
    RAISE EXCEPTION 'no-op correction accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'no_result_change' THEN RAISE; END IF;
  END;
  got:=public.pool_platform_attest_week_final_results(week_a,1,g1fixed,digest_b,
    'Corrected final score after independent verification');
  IF (got->>'revision')::integer<>2 THEN
    RAISE EXCEPTION 'corrected results not versioned'; END IF;
  got:=public.pool_platform_week_result_snapshot(week_a);
  IF got->>'status'<>'commissioner_attested_not_official' OR
     (got->>'revision')::integer<>2 OR
     (got->'results'->'g1'->>'away_score')::integer<>14 OR
     got::text LIKE '%commish_alpha%' OR got::text LIKE '%source_sha256%'
    THEN RAISE EXCEPTION 'latest authorized result snapshot is wrong or leaks actor'; END IF;

  PERFORM set_config('test.uid','alice',false);
  got:=public.pool_platform_week_result_snapshot(week_a);
  IF (got->>'revision')::integer<>2 THEN
    RAISE EXCEPTION 'participant cannot see their own pool attestation'; END IF;
  PERFORM set_config('test.uid','outsider',false);
  BEGIN
    PERFORM public.pool_platform_week_result_snapshot(week_a);
    RAISE EXCEPTION 'outsider was able to see result';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;
  PERFORM set_config('test.uid','',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results(week_a,2,g1,digest_a,
      'Attempted unauthenticated correction');
    RAISE EXCEPTION 'anonymous write granted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'auth_required' THEN RAISE; END IF;
  END;
END;
$test$;
RESET ROLE;

DO $test$
DECLARE
  err text;
BEGIN
  IF (SELECT count(*) FROM public.pool_platform_week_result_revisions
     WHERE week_id='30000000-0000-0000-0000-000000000001')<>2
    THEN RAISE EXCEPTION 'revision count not append only'; END IF;
  BEGIN
    DELETE FROM public.pool_platform_week_result_revisions WHERE revision=1;
    RAISE EXCEPTION 'revision delete succeeded despite immutability';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'result_revisions_are_append_only' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.pool_platform_submissions)<>2 OR
     (SELECT payload->>'secret' FROM public.pool_platform_submissions
      WHERE id='50000000-0000-0000-0000-000000000001')<>'not permitted'
    THEN RAISE EXCEPTION 'an existing submission was altered'; END IF;
END;
$test$;
\echo EPHEMERAL_POOL_RESULT_ATTESTATION_AND_IMMUTABILITY_PASS
