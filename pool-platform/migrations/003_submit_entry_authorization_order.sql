-- REVIEW-ONLY forward fix for a commercial/dev database that already has 001 + 002 applied.
-- Do not apply to the existing personal Pool Center production database.
--
-- Replaces public.pool_platform_submit_entry(uuid,uuid,text,jsonb) and nothing else, with the exact definition now
-- in 002_identity_submission_rls.sql: the entry is resolved and locked on its own, the caller is authorized against
-- it (entry_not_owned / commissioner_required), and only then is the requested week checked against the entry's
-- season (invalid_entry_week). Before this, a caller with no authority over an entry could tell from
-- invalid_entry_week versus the authorization error whether a (week, entry) pair belonged together.
--
-- Signature, return type, SECURITY DEFINER, search_path, owner and every other object are unchanged. The ACL lines
-- are the same two 002 uses for this function, so the result matches a fresh 001 + 002 exactly. It is idempotent,
-- and on a database built from the corrected 002 it changes nothing.
--
-- Apply as the migration owner (the function owner), in one transaction, like 002:
--   psql "$COMMERCIAL_DEV_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
--     -f pool-platform/migrations/003_submit_entry_authorization_order.sql
-- then re-run validation/neon-catalog-verify.sql (C99 must be PASS).

DO $guard$
BEGIN
  IF to_regprocedure('public.pool_platform_submit_entry(uuid,uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '003 replaces pool_platform_submit_entry from 002; apply 001 and 002 first';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.pool_platform_submit_entry(
  p_week_id uuid,
  p_entry_id uuid,
  p_source text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_owner text;
  v_entry_status text;
  v_week_id uuid;
  v_week_status text;
  v_opens timestamptz;
  v_deadline timestamptz;
  v_pool_type text;
  v_week_config jsonb;
  v_existing public.pool_platform_submissions%ROWTYPE;
  v_created public.pool_platform_submissions%ROWTYPE;
  v_previous_payload jsonb;
  v_constraint text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_source IS NULL OR p_source NOT IN ('participant','commissioner_import','commissioner_manual')
  THEN RAISE EXCEPTION 'invalid_source'; END IF;

  -- Resolve and lock the entry row alone: every submission for one entry (any week, any source) queues here,
  -- so the Survivor reuse check reads that entry's committed history. The unique index
  -- pool_platform_submissions_survivor_team_unique still guarantees the outcome on its own. The requested week
  -- is LEFT JOINed only within the entry's own season, so whether it matches never decides which error an
  -- unauthorized caller sees.
  SELECT p.tenant_id,e.owner_auth_user_id,e.status,w.id,w.status,w.opens_at,w.deadline_at,p.pool_type,w.config
  INTO v_tenant_id,v_owner,v_entry_status,v_week_id,v_week_status,v_opens,v_deadline,v_pool_type,v_week_config
  FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  LEFT JOIN public.pool_platform_weeks w ON w.id=p_week_id AND w.season_id=e.season_id
  WHERE e.id=p_entry_id
  FOR NO KEY UPDATE OF e;

  -- Authorize on the entry alone, before the week/season relationship or any entry-state, week-state, payload
  -- or history check, so a caller who is not the entry owner (participant) or a commissioner of the entry's
  -- tenant (commissioner sources) only ever sees that failure: a missing entry, a mismatched week and a
  -- nonexistent week all look the same to them.
  IF p_source='participant' THEN
    IF v_tenant_id IS NULL OR v_owner IS NULL OR v_owner<>v_uid THEN RAISE EXCEPTION 'entry_not_owned'; END IF;
  ELSE
    IF v_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  END IF;

  -- Only an authorized caller learns whether the week belongs to the entry's season.
  IF v_week_id IS NULL THEN RAISE EXCEPTION 'invalid_entry_week'; END IF;

  -- Ordinary submissions need an active entry; inactive, eliminated and archived entries are closed.
  IF v_entry_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'entry_not_active'; END IF;

  IF v_week_status<>'open' THEN RAISE EXCEPTION 'week_not_open'; END IF;
  IF v_opens IS NOT NULL AND now()<v_opens THEN RAISE EXCEPTION 'week_not_open'; END IF;
  IF now()>=v_deadline THEN RAISE EXCEPTION 'deadline_passed'; END IF;

  IF p_payload IS NULL OR COALESCE(jsonb_typeof(p_payload),'')<>'object' OR octet_length(p_payload::text)>20000
  THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.pool_platform_payload_valid(v_pool_type,v_week_config,p_entry_id,p_week_id,p_payload)
  THEN RAISE EXCEPTION 'invalid_payload'; END IF;

  INSERT INTO public.pool_platform_submissions(
    week_id,entry_id,source,status,submitted_by_auth_user_id,payload,revision,submitted_at,updated_at
  ) VALUES (
    p_week_id,p_entry_id,p_source,'submitted',v_uid,p_payload,1,now(),now()
  )
  ON CONFLICT (week_id,entry_id) DO NOTHING
  RETURNING * INTO v_created;

  IF v_created.id IS NOT NULL THEN
    INSERT INTO public.pool_platform_submission_audit(
      submission_id,actor_auth_user_id,action,source,previous_payload,next_payload
    ) VALUES (v_created.id,v_uid,'created',p_source,NULL,p_payload);
    RETURN jsonb_build_object(
      'ok',true,'code','created','submission_id',v_created.id,
      'source',v_created.source,'status',v_created.status,'revision',v_created.revision
    );
  END IF;

  SELECT * INTO v_existing
  FROM public.pool_platform_submissions
  WHERE week_id=p_week_id AND entry_id=p_entry_id
  FOR UPDATE;

  IF v_existing.source<>p_source
  THEN RAISE EXCEPTION 'source_conflict:%',v_existing.source; END IF;
  IF v_existing.status='locked'
  THEN RAISE EXCEPTION 'submission_locked'; END IF;

  v_previous_payload:=v_existing.payload;

  UPDATE public.pool_platform_submissions
  SET payload=p_payload,revision=revision+1,submitted_by_auth_user_id=v_uid,updated_at=now()
  WHERE id=v_existing.id
  RETURNING * INTO v_existing;

  INSERT INTO public.pool_platform_submission_audit(
    submission_id,actor_auth_user_id,action,source,previous_payload,next_payload
  ) VALUES (v_existing.id,v_uid,'updated',p_source,v_previous_payload,p_payload);

  RETURN jsonb_build_object(
    'ok',true,'code','updated','submission_id',v_existing.id,
    'source',v_existing.source,'status',v_existing.status,'revision',v_existing.revision
  );
EXCEPTION WHEN unique_violation THEN
  -- The Survivor team index can only be violated by the INSERT/UPDATE above; report it plainly.
  GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
  IF v_constraint='pool_platform_submissions_survivor_team_unique'
  THEN RAISE EXCEPTION 'team_already_used'; END IF;
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.pool_platform_submit_entry(uuid,uuid,text,jsonb) FROM PUBLIC,anonymous,authenticated CASCADE;
GRANT EXECUTE ON FUNCTION public.pool_platform_submit_entry(uuid,uuid,text,jsonb) TO authenticated;
