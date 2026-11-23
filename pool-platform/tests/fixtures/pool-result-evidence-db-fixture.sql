\set ON_ERROR_STOP on
-- Disposable PostgreSQL ONLY; run after both existing platform fixture files.
-- Ensures reviewable sources accompany all newly submitted attestations.
\i migrations/20261111_attestation_evidence.sql
CREATE ROLE evidence_outsider;
DO $check$
BEGIN
  IF has_table_privilege('authenticated','public.pool_platform_week_result_evidence','SELECT')
    OR has_table_privilege('authenticated','public.pool_platform_week_result_evidence','INSERT')
    OR has_table_privilege('authenticated','public.pool_platform_week_result_evidence','UPDATE')
    THEN RAISE EXCEPTION 'auth role can directly access evidence'; END IF;
  IF has_function_privilege('authenticated',
    'public.pool_platform_attest_week_final_results(uuid,integer,jsonb,text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'old non-evidence RPC remains browser callable'; END IF;
  IF NOT has_function_privilege('authenticated',
    'public.pool_platform_attest_week_final_results_with_source(uuid,integer,jsonb,text,text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'evidence RPC inaccessible to authenticated roles'; END IF;
  IF has_function_privilege('evidence_outsider',
    'public.pool_platform_attest_week_final_results_with_source(uuid,integer,jsonb,text,text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'PUBLIC can execute evidence RPC'; END IF;
END;
$check$;

SET ROLE authenticated;
DO $check$
DECLARE
  w uuid := '30000000-0000-0000-0000-000000000001';
  r jsonb := '{"g1":{"status":"final","away_score":21,"home_score":14}}'::jsonb;
  digest text := repeat('c',64);
  source_ref text := 'https://www.nfl.com/scores/2026/reg10';
  outcome jsonb;
  err text;
BEGIN
  PERFORM set_config('test.uid','alice',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(w,2,r,digest,source_ref,
      'Final result corrected after independent review');
    RAISE EXCEPTION 'participant was permitted to attest';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;
  PERFORM set_config('test.uid','commish_beta',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(w,2,r,digest,source_ref,
      'Final result corrected after independent review');
    RAISE EXCEPTION 'foreign commissioner was permitted to attest';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;
  PERFORM set_config('test.uid','commish_alpha',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(w,2,r,digest,'short',
      'Final result corrected after independent review');
    RAISE EXCEPTION 'short source reference accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'invalid_result_source_reference' THEN RAISE; END IF;
  END;
  outcome:=public.pool_platform_attest_week_final_results_with_source(w,2,r,digest,source_ref,
    'Final result corrected after independent review');
  IF (outcome->>'revision')::integer<>3 OR
     outcome->>'source_reference_saved'<>'true' THEN
    RAISE EXCEPTION 'atomic attestation/evidence write did not succeed'; END IF;
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(w,2,r,digest,source_ref,
      'Repeated final score correction');
    RAISE EXCEPTION 'stale revision succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'stale_result_revision' THEN RAISE; END IF;
  END;
  PERFORM set_config('test.uid','',false);
  BEGIN
    PERFORM public.pool_platform_attest_week_final_results_with_source(w,3,r,digest,source_ref,
      'Unauthenticated modification');
    RAISE EXCEPTION 'anonymous writes were permitted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'auth_required' THEN RAISE; END IF;
  END;
END;
$check$;
RESET ROLE;

DO $check$
DECLARE err text;
BEGIN
  IF (SELECT count(*) FROM public.pool_platform_week_result_evidence)<>1 OR
     (SELECT source_reference FROM public.pool_platform_week_result_evidence
      WHERE revision=3)<>'https://www.nfl.com/scores/2026/reg10'
    THEN RAISE EXCEPTION 'audit evidence missing or misplaced'; END IF;
  IF (SELECT count(*) FROM public.pool_platform_week_result_revisions
     WHERE week_id='30000000-0000-0000-0000-000000000001')<>3
    THEN RAISE EXCEPTION 'append-only history missing'; END IF;
  BEGIN
    UPDATE public.pool_platform_week_result_evidence
    SET source_reference='https://example.com/replaced' WHERE revision=3;
    RAISE EXCEPTION 'audited evidence was altered';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'result_revisions_are_append_only' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.pool_platform_submissions)<>2
    THEN RAISE EXCEPTION 'existing submissions were modified'; END IF;
END;
$check$;
\echo EPHEMERAL_EVIDENCE_ATTESTATION_IMMUTABLE_PASS
