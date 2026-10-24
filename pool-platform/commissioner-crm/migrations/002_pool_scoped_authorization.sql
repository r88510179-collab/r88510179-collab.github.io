-- CRM-002 pool scoped authorization; proposed deployment order requires AUTH-C reconciliation.
-- ADDITIVE grant backfill protects the existing co-commissioner's prior tenant-wide powers.
-- Execute in one transaction with 001 already present. Do NOT run against production without acceptance.
-- Staff scope is now enforced in every commissioner RPC and RLS policy, not just the UI.
-- No rule, deadline, source-lock, pick payload or invited participant logic is changed.
-- Verified on the isolated Neon validation branch only.


INSERT INTO public.pool_platform_staff_grants
(tenant_id,auth_user_id,pool_id,capability,created_by_auth_user_id)
SELECT m.tenant_id,m.auth_user_id,NULL,c.capability,m.auth_user_id
FROM public.pool_platform_memberships m
CROSS JOIN (VALUES ('view_pool'),('manage_players'),('review_picks'),('edit_rules'),('send_updates'),('share_cards')) AS c(capability)
WHERE m.role='co_commissioner'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.pool_platform_is_tenant_commissioner(p_tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.pool_platform_memberships m
    WHERE m.tenant_id=p_tenant_id
      AND m.auth_user_id=public.pool_platform_current_user_id()
      AND m.role IN ('owner','commissioner')
  )
$function$;


CREATE OR REPLACE FUNCTION public.pool_platform_can_read_pool(p_pool_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.pool_platform_pools p
    WHERE p.id=p_pool_id
      AND (
        public.pool_platform_staff_can(p.id,'view_pool')
        OR EXISTS (
          SELECT 1
          FROM public.pool_platform_seasons s
          JOIN public.pool_platform_entries e ON e.season_id=s.id
          WHERE s.pool_id=p.id
            AND e.owner_auth_user_id=public.pool_platform_current_user_id()
        )
      )
  )
$function$;


CREATE OR REPLACE FUNCTION public.pool_platform_can_read_season(p_season_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.pool_platform_seasons s
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    WHERE s.id=p_season_id
      AND (
        public.pool_platform_staff_can(p.id,'view_pool')
        OR EXISTS (
          SELECT 1 FROM public.pool_platform_entries e
          WHERE e.season_id=s.id
            AND e.owner_auth_user_id=public.pool_platform_current_user_id()
        )
      )
  )
$function$;


CREATE OR REPLACE FUNCTION public.pool_platform_commissioner_context(p_pool_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_pool public.pool_platform_pools%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;

  SELECT * INTO v_pool
  FROM public.pool_platform_pools
  WHERE slug=p_pool_slug AND status<>'archived'
  ORDER BY created_at DESC LIMIT 1;

  IF v_pool.id IS NULL OR NOT public.pool_platform_staff_can(v_pool.id,'view_pool')
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
$function$;


CREATE OR REPLACE FUNCTION public.pool_platform_create_entry_invite(p_entry_id uuid, p_email text DEFAULT NULL::text, p_expires_hours integer DEFAULT 168)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_pool_id uuid;
  v_raw text;
  v_expires timestamptz;
  v_email text:=NULLIF(lower(btrim(p_email)),'');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_expires_hours<1 OR p_expires_hours>720 THEN RAISE EXCEPTION 'invalid_invite_expiry'; END IF;

  SELECT p.id INTO v_pool_id
  FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  WHERE e.id=p_entry_id;

  IF v_pool_id IS NULL OR NOT public.pool_platform_staff_can(v_pool_id,'manage_players')
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
$function$;


CREATE OR REPLACE FUNCTION public.pool_platform_submit_batch(p_week_id uuid, p_source text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_pool_id uuid;
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

  SELECT p.id INTO v_pool_id
  FROM public.pool_platform_weeks w
  JOIN public.pool_platform_seasons s ON s.id=w.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  WHERE w.id=p_week_id;

  IF v_pool_id IS NULL OR NOT public.pool_platform_staff_can(v_pool_id,'review_picks')
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
$function$;


CREATE OR REPLACE FUNCTION public.pool_platform_submit_entry(p_week_id uuid, p_entry_id uuid, p_source text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_pool_id uuid;
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
  SELECT p.id,e.owner_auth_user_id,e.status,w.id,w.status,w.opens_at,w.deadline_at,p.pool_type,w.config
  INTO v_pool_id,v_owner,v_entry_status,v_week_id,v_week_status,v_opens,v_deadline,v_pool_type,v_week_config
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
    IF v_pool_id IS NULL OR NOT public.pool_platform_staff_can(v_pool_id,'review_picks')
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
$function$;


ALTER POLICY pool_platform_membership_read ON public.pool_platform_memberships USING (auth_user_id=public.pool_platform_current_user_id() OR public.pool_platform_is_tenant_commissioner(tenant_id));

ALTER POLICY pool_platform_tenant_read ON public.pool_platform_tenants USING (public.pool_platform_is_tenant_commissioner(id) OR EXISTS (
   SELECT 1 FROM public.pool_platform_pools p WHERE p.tenant_id=pool_platform_tenants.id
     AND public.pool_platform_staff_can(p.id,'view_pool')
) OR EXISTS (
   SELECT 1 FROM public.pool_platform_pools p
   JOIN public.pool_platform_seasons s ON s.pool_id=p.id
   JOIN public.pool_platform_entries e ON e.season_id=s.id
   WHERE p.tenant_id=pool_platform_tenants.id AND e.owner_auth_user_id=public.pool_platform_current_user_id()
));

ALTER POLICY pool_platform_entry_read ON public.pool_platform_entries USING (owner_auth_user_id=public.pool_platform_current_user_id() OR EXISTS (
  SELECT 1 FROM public.pool_platform_seasons s
  WHERE s.id=pool_platform_entries.season_id
  AND public.pool_platform_staff_can(s.pool_id,'view_pool')
));

ALTER POLICY pool_platform_invite_read ON public.pool_platform_entry_invites USING (EXISTS(
  SELECT 1 FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  WHERE e.id=pool_platform_entry_invites.entry_id AND public.pool_platform_staff_can(s.pool_id,'manage_players')
));

ALTER POLICY pool_platform_submission_read ON public.pool_platform_submissions USING (EXISTS (
 SELECT 1 FROM public.pool_platform_entries e
 WHERE e.id=pool_platform_submissions.entry_id AND e.owner_auth_user_id=public.pool_platform_current_user_id()
) OR EXISTS (
 SELECT 1 FROM public.pool_platform_entries e
 JOIN public.pool_platform_seasons s ON s.id=e.season_id
 WHERE e.id=pool_platform_submissions.entry_id AND public.pool_platform_staff_can(s.pool_id,'view_pool')
));

ALTER POLICY pool_platform_audit_read ON public.pool_platform_submission_audit USING (EXISTS (
 SELECT 1 FROM public.pool_platform_submissions sub
 JOIN public.pool_platform_entries e ON e.id=sub.entry_id
 JOIN public.pool_platform_seasons s ON s.id=e.season_id
 WHERE sub.id=pool_platform_submission_audit.submission_id
 AND public.pool_platform_staff_can(s.pool_id,'review_picks')
));
