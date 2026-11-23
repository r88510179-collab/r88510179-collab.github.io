-- Retain the evidence reference for each recorded score revision. Run after the final-attestations migration.
CREATE TABLE public.pool_platform_week_result_evidence (
  week_id uuid NOT NULL,
  revision integer NOT NULL,
  source_reference text NOT NULL
    CHECK (length(btrim(source_reference)) BETWEEN 12 AND 500
      AND source_reference !~ '[[:cntrl:]]'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(week_id,revision),
  FOREIGN KEY(week_id,revision)
    REFERENCES public.pool_platform_week_result_revisions(week_id,revision)
);
ALTER TABLE public.pool_platform_week_result_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pool_platform_week_result_evidence FROM PUBLIC;
CREATE TRIGGER pool_platform_result_evidence_immutable
BEFORE UPDATE OR DELETE ON public.pool_platform_week_result_evidence
FOR EACH ROW EXECUTE FUNCTION public.pool_platform_forbid_result_revision_change();

-- Replace the browser-callable entrypoint, keeping the old RPC private to the
-- owner-defined wrapper. If the evidence insert fails, the underlying result
-- revision INSERT rolls back in the same PostgreSQL transaction.
CREATE FUNCTION public.pool_platform_attest_week_final_results_with_source(
  p_week_id uuid,
  p_expected_revision integer,
  p_results jsonb,
  p_source_sha256 text,
  p_source_reference text,
  p_correction_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public','neon_auth','pg_temp'
AS $fn$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_reference text;
  v_result jsonb;
  v_revision integer;
BEGIN
  -- MUST be the first executable guard because the browser's auth_required
  -- retry is only safe before reads, locks, or writes.
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  v_reference:=btrim(p_source_reference);
  IF v_reference IS NULL OR length(v_reference) NOT BETWEEN 12 AND 500
    OR v_reference ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_result_source_reference';
  END IF;
  v_result:=public.pool_platform_attest_week_final_results(
    p_week_id,p_expected_revision,p_results,p_source_sha256,p_correction_reason);
  v_revision:=(v_result->>'revision')::integer;
  INSERT INTO public.pool_platform_week_result_evidence
    (week_id,revision,source_reference)
  VALUES(p_week_id,v_revision,v_reference);
  RETURN v_result || jsonb_build_object('source_reference_saved',true);
END;
$fn$;
REVOKE ALL ON FUNCTION public.pool_platform_attest_week_final_results_with_source(uuid,integer,jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_attest_week_final_results_with_source(uuid,integer,jsonb,text,text,text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pool_platform_attest_week_final_results(uuid,integer,jsonb,text,text) FROM authenticated;
