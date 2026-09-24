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
  SELECT lower(u.email)
  FROM neon_auth."user" u
  WHERE u.id::text=auth.user_id()
    AND COALESCE(u.banned,false)=false
  LIMIT 1
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
  IF v_inv.email_normalized IS NOT NULL AND v_inv.email_normalized<>v_email
  THEN RAISE EXCEPTION 'invite_email_mismatch'; END IF;

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
  v_week_status text;
  v_opens timestamptz;
  v_deadline timestamptz;
  v_existing public.pool_platform_submissions%ROWTYPE;
  v_created public.pool_platform_submissions%ROWTYPE;
  v_previous_payload jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_source NOT IN ('participant','commissioner_import','commissioner_manual')
  THEN RAISE EXCEPTION 'invalid_source'; END IF;
  IF jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>20000
  THEN RAISE EXCEPTION 'invalid_payload'; END IF;

  SELECT p.tenant_id,e.owner_auth_user_id,w.status,w.opens_at,w.deadline_at
  INTO v_tenant_id,v_owner,v_week_status,v_opens,v_deadline
  FROM public.pool_platform_weeks w
  JOIN public.pool_platform_seasons s ON s.id=w.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  JOIN public.pool_platform_entries e ON e.season_id=s.id
  WHERE w.id=p_week_id AND e.id=p_entry_id;

  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'invalid_entry_week'; END IF;
  IF v_week_status<>'open' THEN RAISE EXCEPTION 'week_not_open'; END IF;
  IF v_opens IS NOT NULL AND now()<v_opens THEN RAISE EXCEPTION 'week_not_open'; END IF;
  IF now()>=v_deadline THEN RAISE EXCEPTION 'deadline_passed'; END IF;

  IF p_source='participant' THEN
    IF v_owner IS NULL OR v_owner<>v_uid THEN RAISE EXCEPTION 'entry_not_owned'; END IF;
  ELSE
    IF NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  END IF;

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
      WHERE hs.entry_id=e.id AND hw.season_id=v_season.id AND hw.week<v_week.week
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

REVOKE ALL ON FUNCTION public.pool_platform_current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_current_user_email() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_is_tenant_commissioner(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_can_read_pool(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_can_read_season(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_create_entry_invite(uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_claim_entry_invite(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_submit_entry(uuid,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_submit_batch(uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_participant_context(text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_commissioner_context(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.pool_platform_create_entry_invite(uuid,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_claim_entry_invite(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_submit_entry(uuid,uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_submit_batch(uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_participant_context(text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_commissioner_context(text) TO authenticated;

-- No anonymous access and no direct authenticated INSERT/UPDATE/DELETE grants are added.
-- Mutation flows go through reviewed SECURITY DEFINER functions that perform authorization.
