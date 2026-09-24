-- REVIEW-ONLY commercial V1 identity, tenant authorization, invites, and atomic submissions.
-- Apply only to a dedicated commercial/dev database after independent review.
-- Do not apply to the existing personal Pool Center production database.

CREATE TABLE IF NOT EXISTS public.pool_platform_entry_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.pool_platform_entries(id) ON DELETE CASCADE,
  token_sha256 bytea NOT NULL UNIQUE,
  email_normalized text,
  expires_at timestamptz NOT NULL,
  claimed_by_auth_user_id text,
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_by_auth_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email_normalized IS NULL OR email_normalized=lower(btrim(email_normalized))),
  CHECK (expires_at>created_at),
  CHECK ((claimed_at IS NULL)=(claimed_by_auth_user_id IS NULL))
);

ALTER TABLE public.pool_platform_entry_invites ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS pool_platform_pool_slug_global_unique
  ON public.pool_platform_pools(slug);

-- Survivor: an entry may use each team once. entry_id belongs to exactly one season, so this is one
-- non-null Survivor team per entry across that entry's season, whatever order weeks are submitted in and
-- however submissions interleave. Pick'em payloads never carry a top-level "team" (payload_valid only
-- accepts picks/tiebreak), so the predicate leaves them out. This index is the authoritative guard;
-- submit_entry reports its violation as team_already_used.
CREATE UNIQUE INDEX IF NOT EXISTS pool_platform_submissions_survivor_team_unique
  ON public.pool_platform_submissions(entry_id,(payload->>'team'))
  WHERE jsonb_typeof(payload->'team')='string';

REVOKE CREATE ON SCHEMA public FROM anonymous,authenticated;

CREATE OR REPLACE FUNCTION public.pool_platform_current_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
  SELECT u.id::text
  FROM neon_auth."user" u
  WHERE u.id::text=auth.user_id()
    AND COALESCE(u.banned,false)=false
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.pool_platform_current_user_email()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
  SELECT lower(btrim(u.email))
  FROM neon_auth."user" u
  WHERE u.id::text=auth.user_id()
    AND COALESCE(u.banned,false)=false
  LIMIT 1
$$;

-- Neon Auth (Better Auth) keeps verification state in neon_auth."user"."emailVerified" (boolean NOT NULL).
-- Email, ban and verification state are read in one query so an email change cannot slip in between.
CREATE OR REPLACE FUNCTION public.pool_platform_current_user_has_verified_email(p_email_normalized text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM neon_auth."user" u
    WHERE u.id::text=auth.user_id()
      AND COALESCE(u.banned,false)=false
      AND u."emailVerified" IS TRUE
      AND lower(btrim(u.email))=p_email_normalized
  )
$$;

CREATE OR REPLACE FUNCTION public.pool_platform_is_tenant_commissioner(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pool_platform_memberships m
    WHERE m.tenant_id=p_tenant_id
      AND m.auth_user_id=public.pool_platform_current_user_id()
      AND m.role IN ('owner','commissioner','co_commissioner')
  )
$$;

CREATE OR REPLACE FUNCTION public.pool_platform_can_read_pool(p_pool_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pool_platform_pools p
    WHERE p.id=p_pool_id
      AND (
        public.pool_platform_is_tenant_commissioner(p.tenant_id)
        OR EXISTS (
          SELECT 1
          FROM public.pool_platform_seasons s
          JOIN public.pool_platform_entries e ON e.season_id=s.id
          WHERE s.pool_id=p.id
            AND e.owner_auth_user_id=public.pool_platform_current_user_id()
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.pool_platform_can_read_season(p_season_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pool_platform_seasons s
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    WHERE s.id=p_season_id
      AND (
        public.pool_platform_is_tenant_commissioner(p.tenant_id)
        OR EXISTS (
          SELECT 1 FROM public.pool_platform_entries e
          WHERE e.season_id=s.id
            AND e.owner_auth_user_id=public.pool_platform_current_user_id()
        )
      )
  )
$$;

REVOKE ALL ON public.pool_platform_tenants FROM anonymous;
REVOKE ALL ON public.pool_platform_memberships FROM anonymous;
REVOKE ALL ON public.pool_platform_pools FROM anonymous;
REVOKE ALL ON public.pool_platform_seasons FROM anonymous;
REVOKE ALL ON public.pool_platform_entries FROM anonymous;
REVOKE ALL ON public.pool_platform_weeks FROM anonymous;
REVOKE ALL ON public.pool_platform_submissions FROM anonymous;
REVOKE ALL ON public.pool_platform_submission_audit FROM anonymous;
REVOKE ALL ON public.pool_platform_entry_invites FROM anonymous;

GRANT SELECT ON public.pool_platform_tenants TO authenticated;
GRANT SELECT ON public.pool_platform_memberships TO authenticated;
GRANT SELECT ON public.pool_platform_pools TO authenticated;
GRANT SELECT ON public.pool_platform_seasons TO authenticated;
GRANT SELECT ON public.pool_platform_entries TO authenticated;
GRANT SELECT ON public.pool_platform_weeks TO authenticated;
GRANT SELECT ON public.pool_platform_submissions TO authenticated;
GRANT SELECT ON public.pool_platform_submission_audit TO authenticated;
GRANT SELECT ON public.pool_platform_entry_invites TO authenticated;

REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pool_platform_tenants FROM authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pool_platform_memberships FROM authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pool_platform_pools FROM authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pool_platform_seasons FROM authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pool_platform_entries FROM authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pool_platform_weeks FROM authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pool_platform_submissions FROM authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pool_platform_submission_audit FROM authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pool_platform_entry_invites FROM authenticated;

DROP POLICY IF EXISTS pool_platform_tenant_read ON public.pool_platform_tenants;
CREATE POLICY pool_platform_tenant_read ON public.pool_platform_tenants
FOR SELECT TO authenticated
USING (
  public.pool_platform_is_tenant_commissioner(id)
  OR EXISTS (
    SELECT 1
    FROM public.pool_platform_pools p
    JOIN public.pool_platform_seasons s ON s.pool_id=p.id
    JOIN public.pool_platform_entries e ON e.season_id=s.id
    WHERE p.tenant_id=pool_platform_tenants.id
      AND e.owner_auth_user_id=public.pool_platform_current_user_id()
  )
);

DROP POLICY IF EXISTS pool_platform_membership_read ON public.pool_platform_memberships;
CREATE POLICY pool_platform_membership_read ON public.pool_platform_memberships
FOR SELECT TO authenticated
USING (
  auth_user_id=public.pool_platform_current_user_id()
  OR public.pool_platform_is_tenant_commissioner(tenant_id)
);

DROP POLICY IF EXISTS pool_platform_pool_read ON public.pool_platform_pools;
CREATE POLICY pool_platform_pool_read ON public.pool_platform_pools
FOR SELECT TO authenticated
USING (public.pool_platform_can_read_pool(id));

DROP POLICY IF EXISTS pool_platform_season_read ON public.pool_platform_seasons;
CREATE POLICY pool_platform_season_read ON public.pool_platform_seasons
FOR SELECT TO authenticated
USING (public.pool_platform_can_read_season(id));

DROP POLICY IF EXISTS pool_platform_entry_read ON public.pool_platform_entries;
CREATE POLICY pool_platform_entry_read ON public.pool_platform_entries
FOR SELECT TO authenticated
USING (
  owner_auth_user_id=public.pool_platform_current_user_id()
  OR EXISTS (
    SELECT 1
    FROM public.pool_platform_seasons s
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    WHERE s.id=pool_platform_entries.season_id
      AND public.pool_platform_is_tenant_commissioner(p.tenant_id)
  )
);

DROP POLICY IF EXISTS pool_platform_week_read ON public.pool_platform_weeks;
CREATE POLICY pool_platform_week_read ON public.pool_platform_weeks
FOR SELECT TO authenticated
USING (public.pool_platform_can_read_season(season_id));

DROP POLICY IF EXISTS pool_platform_submission_read ON public.pool_platform_submissions;
CREATE POLICY pool_platform_submission_read ON public.pool_platform_submissions
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.pool_platform_entries e
    WHERE e.id=pool_platform_submissions.entry_id
      AND e.owner_auth_user_id=public.pool_platform_current_user_id()
  )
  OR EXISTS (
    SELECT 1
    FROM public.pool_platform_entries e
    JOIN public.pool_platform_seasons s ON s.id=e.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    WHERE e.id=pool_platform_submissions.entry_id
      AND public.pool_platform_is_tenant_commissioner(p.tenant_id)
  )
);

DROP POLICY IF EXISTS pool_platform_audit_read ON public.pool_platform_submission_audit;
CREATE POLICY pool_platform_audit_read ON public.pool_platform_submission_audit
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.pool_platform_submissions sub
    JOIN public.pool_platform_entries e ON e.id=sub.entry_id
    JOIN public.pool_platform_seasons s ON s.id=e.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    WHERE sub.id=pool_platform_submission_audit.submission_id
      AND public.pool_platform_is_tenant_commissioner(p.tenant_id)
  )
);

DROP POLICY IF EXISTS pool_platform_invite_read ON public.pool_platform_entry_invites;
CREATE POLICY pool_platform_invite_read ON public.pool_platform_entry_invites
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.pool_platform_entries e
    JOIN public.pool_platform_seasons s ON s.id=e.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    WHERE e.id=pool_platform_entry_invites.entry_id
      AND public.pool_platform_is_tenant_commissioner(p.tenant_id)
  )
);

CREATE OR REPLACE FUNCTION public.pool_platform_create_entry_invite(
  p_entry_id uuid,
  p_email text DEFAULT NULL,
  p_expires_hours integer DEFAULT 168
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_raw text;
  v_expires timestamptz;
  v_email text:=NULLIF(lower(btrim(p_email)),'');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_expires_hours<1 OR p_expires_hours>720 THEN RAISE EXCEPTION 'invalid_invite_expiry'; END IF;

  SELECT p.tenant_id INTO v_tenant_id
  FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  WHERE e.id=p_entry_id;

  IF v_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;

  v_raw:=encode(gen_random_bytes(32),'hex');
  v_expires:=now()+make_interval(hours=>p_expires_hours);

  INSERT INTO public.pool_platform_entry_invites(
    entry_id,token_sha256,email_normalized,expires_at,created_by_auth_user_id
  ) VALUES (
    p_entry_id,digest(v_raw,'sha256'),v_email,v_expires,v_uid
  );

  RETURN jsonb_build_object('entry_id',p_entry_id,'invite_token',v_raw,'expires_at',v_expires);
END;
$$;

CREATE OR REPLACE FUNCTION public.pool_platform_claim_entry_invite(p_invite_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_email text:=public.pool_platform_current_user_email();
  v_inv public.pool_platform_entry_invites%ROWTYPE;
  v_owner text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_invite_token IS NULL OR p_invite_token!~'^[0-9a-fA-F]{64}$'
  THEN RAISE EXCEPTION 'invalid_invite_token'; END IF;

  SELECT * INTO v_inv
  FROM public.pool_platform_entry_invites
  WHERE token_sha256=digest(lower(p_invite_token),'sha256')
    AND revoked_at IS NULL
    AND claimed_at IS NULL
    AND expires_at>now()
  FOR UPDATE;

  IF v_inv.id IS NULL THEN RAISE EXCEPTION 'invite_unavailable'; END IF;
  -- An email-bound invite needs the signed-in account's normalized email to match AND be verified.
  -- An unbound invite stays a bearer token. Rejections leave the invite unclaimed.
  IF v_inv.email_normalized IS NOT NULL THEN
    IF v_email IS NULL OR v_inv.email_normalized<>v_email
    THEN RAISE EXCEPTION 'invite_email_mismatch'; END IF;
    IF NOT public.pool_platform_current_user_has_verified_email(v_inv.email_normalized)
    THEN RAISE EXCEPTION 'invite_email_unverified'; END IF;
  END IF;

  SELECT owner_auth_user_id INTO v_owner
  FROM public.pool_platform_entries
  WHERE id=v_inv.entry_id
  FOR UPDATE;

  IF v_owner IS NOT NULL AND v_owner<>v_uid
  THEN RAISE EXCEPTION 'entry_already_claimed'; END IF;

  UPDATE public.pool_platform_entries
  SET owner_auth_user_id=v_uid,updated_at=now()
  WHERE id=v_inv.entry_id;

  UPDATE public.pool_platform_entry_invites
  SET claimed_by_auth_user_id=v_uid,claimed_at=now()
  WHERE id=v_inv.id;

  RETURN jsonb_build_object('entry_id',v_inv.entry_id,'claimed',true);
END;
$$;


CREATE OR REPLACE FUNCTION public.pool_platform_payload_valid(
  p_pool_type text,
  p_week_config jsonb,
  p_entry_id uuid,
  p_week_id uuid,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public,neon_auth,pg_temp
AS $$
DECLARE
  v_required_tb boolean;
  v_tb_text text;
  v_team text;
  v_week integer;
  v_season_id uuid;
BEGIN
  IF p_payload IS NULL OR COALESCE(jsonb_typeof(p_payload),'')<>'object' THEN RETURN false; END IF;

  IF p_pool_type='pickem' THEN
    IF COALESCE(jsonb_typeof(p_week_config->'games'),'')<>'array'
       OR COALESCE(jsonb_typeof(p_payload->'picks'),'')<>'object'
    THEN RETURN false; END IF;

    IF (SELECT count(*) FROM jsonb_array_elements(p_week_config->'games'))=0
       OR (SELECT count(*) FROM jsonb_array_elements(p_week_config->'games'))
          <> (SELECT count(DISTINCT g->>'id') FROM jsonb_array_elements(p_week_config->'games') g)
    THEN RETURN false; END IF;

    -- Fail closed: every configured game needs a nonempty id and a JSON string pick of exactly
    -- 'away' or 'home'. A missing or JSON-null pick makes the inner expression NULL, which
    -- COALESCE turns into false, so the game is rejected instead of skipped.
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_week_config->'games') g
      WHERE NOT COALESCE(
        jsonb_typeof(g)='object'
        AND jsonb_typeof(g->'id') IN ('string','number')
        AND (g->>'id')<>''
        AND jsonb_typeof(p_payload->'picks'->(g->>'id'))='string'
        AND (p_payload->'picks'->>(g->>'id')) IN ('away','home'),
        false
      )
    ) THEN RETURN false; END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_object_keys(p_payload->'picks') k
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_week_config->'games') g
        WHERE g->>'id'=k
      )
    ) THEN RETURN false; END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_payload) k
      WHERE k NOT IN ('picks','tiebreak')
    ) THEN RETURN false; END IF;

    v_required_tb:=lower(COALESCE(p_week_config->>'tiebreakRequired',p_week_config->>'tiebreak_required','false'))='true';
    v_tb_text:=p_payload->>'tiebreak';
    IF v_required_tb OR v_tb_text IS NOT NULL THEN
      IF v_tb_text IS NULL OR v_tb_text!~'^[0-9]{1,3}$' THEN RETURN false; END IF;
      IF v_tb_text::integer>200 THEN RETURN false; END IF;
    END IF;
    RETURN true;
  END IF;

  IF p_pool_type='survivor' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k<>'team')
    THEN RETURN false; END IF;
    -- The team must be a JSON string. ->> renders a number, boolean, array or object as text that can still
    -- equal a configured key, and pool_platform_submissions_survivor_team_unique only covers string teams,
    -- so a non-string pick would get past the index; it is rejected before any key, history or index logic.
    IF COALESCE(jsonb_typeof(p_payload->'team'),'')<>'string' THEN RETURN false; END IF;
    v_team:=NULLIF(p_payload->>'team','');
    IF v_team IS NULL OR COALESCE(jsonb_typeof(p_week_config->'games'),'')<>'array'
    THEN RETURN false; END IF;

    IF (
      SELECT count(*)
      FROM (
        SELECT COALESCE(NULLIF(g->'away'->>'key',''),NULLIF(g->>'away','')) AS team
        FROM jsonb_array_elements(p_week_config->'games') g
        UNION ALL
        SELECT COALESCE(NULLIF(g->'home'->>'key',''),NULLIF(g->>'home','')) AS team
        FROM jsonb_array_elements(p_week_config->'games') g
      ) teams
      WHERE team=v_team
    )<>1 THEN RETURN false; END IF;

    SELECT w.week,w.season_id INTO v_week,v_season_id
    FROM public.pool_platform_weeks w WHERE w.id=p_week_id;
    IF v_week IS NULL THEN RETURN false; END IF;

    -- Defense in depth behind pool_platform_submissions_survivor_team_unique: the team must be unused by
    -- this entry in every OTHER week of the season, earlier or later, so out-of-order submissions are
    -- caught too. Only a structurally valid pick gets here; reuse raises team_already_used instead of
    -- returning false so submit_entry can tell an authorized caller exactly why it was rejected.
    IF EXISTS (
      SELECT 1
      FROM public.pool_platform_submissions s
      JOIN public.pool_platform_weeks w ON w.id=s.week_id
      WHERE s.entry_id=p_entry_id
        AND w.season_id=v_season_id
        AND s.week_id<>p_week_id
        AND s.payload->>'team'=v_team
    ) THEN RAISE EXCEPTION 'team_already_used'; END IF;
    RETURN true;
  END IF;

  RETURN false;
END;
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

  -- Resolve the entry/week pair and lock the entry row: every submission for one entry (any week, any
  -- source) queues here, so the Survivor reuse check reads that entry's committed history. The unique
  -- index pool_platform_submissions_survivor_team_unique still guarantees the outcome on its own.
  SELECT p.tenant_id,e.owner_auth_user_id,e.status,w.status,w.opens_at,w.deadline_at,p.pool_type,w.config
  INTO v_tenant_id,v_owner,v_entry_status,v_week_status,v_opens,v_deadline,v_pool_type,v_week_config
  FROM public.pool_platform_weeks w
  JOIN public.pool_platform_seasons s ON s.id=w.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  JOIN public.pool_platform_entries e ON e.season_id=s.id
  WHERE w.id=p_week_id AND e.id=p_entry_id
  FOR NO KEY UPDATE OF e;

  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'invalid_entry_week'; END IF;

  -- Authorize before any entry-state, week-state, payload or history check, so a caller who is not the
  -- entry owner (participant) or a tenant commissioner (commissioner sources) only ever sees that failure.
  IF p_source='participant' THEN
    IF v_owner IS NULL OR v_owner<>v_uid THEN RAISE EXCEPTION 'entry_not_owned'; END IF;
  ELSE
    IF NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  END IF;

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

CREATE OR REPLACE FUNCTION public.pool_platform_submit_batch(
  p_week_id uuid,
  p_source text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_tenant_id uuid;
  v_item jsonb;
  v_result jsonb:='[]'::jsonb;
  v_one jsonb;
  v_entry uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_source NOT IN ('commissioner_import','commissioner_manual')
  THEN RAISE EXCEPTION 'commissioner_source_required'; END IF;
  IF jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)>500
  THEN RAISE EXCEPTION 'invalid_batch'; END IF;

  SELECT p.tenant_id INTO v_tenant_id
  FROM public.pool_platform_weeks w
  JOIN public.pool_platform_seasons s ON s.id=w.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  WHERE w.id=p_week_id;

  IF v_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      v_entry:=(v_item->>'entry_id')::uuid;
      v_one:=public.pool_platform_submit_entry(
        p_week_id,v_entry,p_source,COALESCE(v_item->'payload','{}'::jsonb)
      );
      v_result:=v_result||jsonb_build_array(
        jsonb_build_object('entry_id',v_entry,'ok',true,'result',v_one)
      );
    EXCEPTION WHEN OTHERS THEN
      v_result:=v_result||jsonb_build_array(
        jsonb_build_object(
          'entry_id',COALESCE(v_item->>'entry_id',''),
          'ok',false,'code',SQLERRM
        )
      );
    END;
  END LOOP;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.pool_platform_participant_context(
  p_pool_slug text,
  p_season integer DEFAULT NULL,
  p_week integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_pool public.pool_platform_pools%ROWTYPE;
  v_season public.pool_platform_seasons%ROWTYPE;
  v_week public.pool_platform_weeks%ROWTYPE;
  v_entries jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;

  SELECT * INTO v_pool
  FROM public.pool_platform_pools
  WHERE slug=p_pool_slug AND status='active'
    AND public.pool_platform_can_read_pool(id)
  ORDER BY created_at DESC LIMIT 1;
  IF v_pool.id IS NULL THEN RAISE EXCEPTION 'pool_not_found'; END IF;

  SELECT * INTO v_season
  FROM public.pool_platform_seasons
  WHERE pool_id=v_pool.id
    AND (p_season IS NULL OR season=p_season)
    AND status IN ('setup','active')
  ORDER BY season DESC LIMIT 1;
  IF v_season.id IS NULL THEN RAISE EXCEPTION 'season_not_found'; END IF;

  SELECT * INTO v_week
  FROM public.pool_platform_weeks
  WHERE season_id=v_season.id
    AND (p_week IS NULL OR week=p_week)
    AND status IN ('open','locked','final')
  ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,week DESC
  LIMIT 1;
  IF v_week.id IS NULL THEN RAISE EXCEPTION 'week_not_found'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',e.id,
    'entry_code',e.entry_code,
    'display_name',e.display_name,
    'status',e.status,
    'submission',CASE WHEN sub.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',sub.id,'source',sub.source,'status',sub.status,'payload',sub.payload,
      'revision',sub.revision,'submitted_at',sub.submitted_at,'updated_at',sub.updated_at
    ) END,
    'history',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'week',hw.week,'source',hs.source,'status',hs.status,
        'payload',hs.payload,'revision',hs.revision
      ) ORDER BY hw.week)
      FROM public.pool_platform_submissions hs
      JOIN public.pool_platform_weeks hw ON hw.id=hs.week_id
      -- Every other week, earlier or later, so the browser marks the same teams used as the server does.
      WHERE hs.entry_id=e.id AND hw.season_id=v_season.id AND hw.week<>v_week.week
    ),'[]'::jsonb)
  ) ORDER BY e.entry_code),'[]'::jsonb)
  INTO v_entries
  FROM public.pool_platform_entries e
  LEFT JOIN public.pool_platform_submissions sub
    ON sub.entry_id=e.id AND sub.week_id=v_week.id
  WHERE e.season_id=v_season.id
    AND e.owner_auth_user_id=v_uid
    AND e.status='active';

  RETURN jsonb_build_object(
    'pool',jsonb_build_object(
      'id',v_pool.id,'slug',v_pool.slug,'display_name',v_pool.display_name,
      'pool_type',v_pool.pool_type,'rules',v_pool.rules,'branding',v_pool.branding
    ),
    'season',jsonb_build_object('id',v_season.id,'season',v_season.season,'config',v_season.config),
    'week',jsonb_build_object(
      'id',v_week.id,'week',v_week.week,'status',v_week.status,
      'opens_at',v_week.opens_at,'deadline_at',v_week.deadline_at,'config',v_week.config
    ),
    'entries',v_entries
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.pool_platform_commissioner_context(p_pool_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=public,neon_auth,pg_temp
AS $$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_pool public.pool_platform_pools%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;

  SELECT * INTO v_pool
  FROM public.pool_platform_pools
  WHERE slug=p_pool_slug AND status<>'archived'
  ORDER BY created_at DESC LIMIT 1;

  IF v_pool.id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_pool.tenant_id)
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;

  RETURN jsonb_build_object(
    'pool',jsonb_build_object(
      'id',v_pool.id,'tenant_id',v_pool.tenant_id,'slug',v_pool.slug,
      'display_name',v_pool.display_name,'pool_type',v_pool.pool_type,
      'rules',v_pool.rules,'branding',v_pool.branding
    ),
    'seasons',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',s.id,'season',s.season,'status',s.status,'config',s.config,
        'entries',COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id',e.id,'entry_code',e.entry_code,'display_name',e.display_name,
            'status',e.status,'claimed',e.owner_auth_user_id IS NOT NULL,
            'submissions',COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'week',sw.week,'source',ss.source,'status',ss.status,
                'revision',ss.revision,'submitted_at',ss.submitted_at
              ) ORDER BY sw.week)
              FROM public.pool_platform_submissions ss
              JOIN public.pool_platform_weeks sw ON sw.id=ss.week_id
              WHERE ss.entry_id=e.id
            ),'[]'::jsonb)
          ) ORDER BY e.entry_code)
          FROM public.pool_platform_entries e WHERE e.season_id=s.id
        ),'[]'::jsonb),
        'weeks',COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id',w.id,'week',w.week,'status',w.status,
            'opens_at',w.opens_at,'deadline_at',w.deadline_at,'config',w.config
          ) ORDER BY w.week)
          FROM public.pool_platform_weeks w WHERE w.season_id=s.id
        ),'[]'::jsonb)
      ) ORDER BY s.season DESC)
      FROM public.pool_platform_seasons s WHERE s.pool_id=v_pool.id
    ),'[]'::jsonb)
  );
END;
$$;

-- Function privileges are set explicitly rather than relying on REVOKE ... FROM PUBLIC alone: default
-- privileges or an earlier run may already have given anonymous or authenticated EXECUTE (even with grant
-- option), and CREATE OR REPLACE keeps it. Every function is reset for PUBLIC, anonymous and authenticated
-- (CASCADE also drops what they passed on), then only the RLS helpers and RPCs below are granted to
-- authenticated. The internal helpers pool_platform_current_user_email,
-- pool_platform_current_user_has_verified_email, pool_platform_payload_valid and the 001 trigger function
-- stay callable only by their owner, which is how the SECURITY DEFINER functions reach them.
REVOKE ALL ON FUNCTION public.pool_platform_guard_submission_source() FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_current_user_id() FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_current_user_email() FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_current_user_has_verified_email(text) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_is_tenant_commissioner(uuid) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_can_read_pool(uuid) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_can_read_season(uuid) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_payload_valid(text,jsonb,uuid,uuid,jsonb) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_create_entry_invite(uuid,text,integer) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_claim_entry_invite(text) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_submit_entry(uuid,uuid,text,jsonb) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_submit_batch(uuid,text,jsonb) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_participant_context(text,integer,integer) FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_commissioner_context(text) FROM PUBLIC,anonymous,authenticated CASCADE;

-- RLS helpers: the read policies call these as the authenticated role.
GRANT EXECUTE ON FUNCTION public.pool_platform_current_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_is_tenant_commissioner(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_can_read_pool(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_can_read_season(uuid) TO authenticated;

-- RPCs: the browser-callable surface.
GRANT EXECUTE ON FUNCTION public.pool_platform_create_entry_invite(uuid,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_claim_entry_invite(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_submit_entry(uuid,uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_submit_batch(uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_participant_context(text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_commissioner_context(text) TO authenticated;

-- No anonymous access and no direct authenticated INSERT/UPDATE/DELETE grants are added.
-- Mutation flows go through reviewed SECURITY DEFINER functions that perform authorization.
