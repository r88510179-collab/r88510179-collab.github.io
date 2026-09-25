-- REVIEW-ONLY forward migration for a commercial database that already applied 002_identity_submission_rls.sql
-- before the submit_entry authorization-order correction (002 as frozen at 5e59ddd). Do not run it before it has
-- been reviewed, and never on the personal Pool Center database.
--
-- It replaces only public.pool_platform_submit_entry(uuid,uuid,text,jsonb), with the definition 002 now carries
-- (byte for byte), and resets that one function's privileges exactly as 002 does. No table, policy, index,
-- trigger, sequence, row or other function changes. A database built from the current 001 and 002 already has
-- this definition, so running this file there changes nothing.
--
-- Run it like 001 and 002 (runbook steps 8 and 9): as the role that owns the migrations, as one transaction that
-- stops at the first error; then re-run validation/neon-catalog-verify.sql (C99 must be PASS):
--
--   psql "$COMMERCIAL_DEV_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
--     -f pool-platform/migrations/003_submit_entry_authorization_order.sql
--
-- The guard stops the transaction, leaving nothing behind, on the personal Pool Center database, when the function
-- is missing (a database without 002 needs 001 and 002, not this file), when a role other than its owner runs the
-- file, or when the current body is neither the reviewed pre-fix body nor the corrected one (SHA-256 of
-- pg_proc.prosrc), so a definition nobody reviewed is never overwritten.
DO $$
DECLARE
  v_fn regprocedure:=to_regprocedure('public.pool_platform_submit_entry(uuid,uuid,text,jsonb)');
  v_owner oid;
  v_body_sha256 text;
BEGIN
  IF current_database()='nfl_pool'
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relname IN ('nfl_pool_weeks','nfl_survivor_weeks'))
  THEN RAISE EXCEPTION 'personal Pool Center database: stop'; END IF;
  IF v_fn IS NULL
  THEN RAISE EXCEPTION 'public.pool_platform_submit_entry(uuid,uuid,text,jsonb) does not exist: stop'; END IF;
  SELECT p.proowner,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') INTO v_owner,v_body_sha256
  FROM pg_catalog.pg_proc p WHERE p.oid=v_fn;
  IF v_owner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=current_user)
  THEN RAISE EXCEPTION 'run as %, the owner of pool_platform_submit_entry, not %: stop',v_owner::regrole,current_user; END IF;
  -- effc4781...: the pre-fix body (002 at 5e59ddd). f5218373...: the corrected body below.
  IF v_body_sha256 NOT IN (
    'effc478183fb6390dcdef9174101f576a5fc2f0e6c931d8b9cb84b40d2681755',
    'f52183734e1f8c42c401e2a507e8c82323c259486909adca49d9537eed523c8f'
  ) THEN RAISE EXCEPTION 'pool_platform_submit_entry body sha256 % is not a reviewed definition: stop',v_body_sha256; END IF;
END
$$;

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

  -- Resolve and lock the entry row with its season, pool and tenant, whatever week was asked for: every
  -- submission for one entry (any week, any source) queues here, so the Survivor reuse check reads that
  -- entry's committed history. The unique index pool_platform_submissions_survivor_team_unique still
  -- guarantees the outcome on its own. The requested week is joined only within the entry's own season,
  -- and whether it matched is looked at only once the caller is authorized.
  SELECT p.tenant_id,e.owner_auth_user_id,e.status,w.id,w.status,w.opens_at,w.deadline_at,p.pool_type,w.config
  INTO v_tenant_id,v_owner,v_entry_status,v_week_id,v_week_status,v_opens,v_deadline,v_pool_type,v_week_config
  FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  LEFT JOIN public.pool_platform_weeks w ON w.id=p_week_id AND w.season_id=s.id
  WHERE e.id=p_entry_id
  FOR NO KEY UPDATE OF e;

  -- Authorize before the week or any entry-state, week-state, payload or history check, so a caller who is
  -- not the entry owner (participant) or a commissioner of the entry's tenant (commissioner sources) only
  -- ever sees that failure: it does not tell whether the entry exists or whether the week belongs to it. A
  -- missing entry has no owner and no tenant, so it fails the same way.
  IF p_source='participant' THEN
    IF v_owner IS NULL OR v_owner<>v_uid THEN RAISE EXCEPTION 'entry_not_owned'; END IF;
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
