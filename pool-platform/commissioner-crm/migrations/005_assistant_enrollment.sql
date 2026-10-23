-- CRM-005: commissioner-managed assistant access, staging only.
-- This is NOT a payment or billing service.
-- A commissioner can enroll an EXISTING verified Neon Auth account as co-commissioner,
-- then assign all-pool or selected-pool permissions. New user sign-up is unchanged.
-- Execute only after CRM-001..004 on validation branch; no production application.
CREATE TABLE public.pool_platform_crm_staff_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.pool_platform_tenants(id),
  assistant_auth_user_id text NOT NULL,
  actor_auth_user_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('enroll','update')),
  previous_grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pool_platform_crm_staff_audit_tenant_time_idx
  ON public.pool_platform_crm_staff_audit(tenant_id,created_at DESC);
ALTER TABLE public.pool_platform_crm_staff_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pool_platform_crm_staff_audit FROM PUBLIC,authenticated;
GRANT SELECT ON public.pool_platform_crm_staff_audit TO authenticated;
CREATE POLICY pool_platform_crm_staff_audit_read
  ON public.pool_platform_crm_staff_audit FOR SELECT TO authenticated
  USING (public.pool_platform_is_tenant_commissioner(tenant_id));

CREATE OR REPLACE FUNCTION public.pool_platform_crm_assistants(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
DECLARE v_actor text:=public.pool_platform_current_user_id();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(p_tenant_id)
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',m.auth_user_id,
      'name',COALESCE(NULLIF(u.name,''),'Existing assistant'),
      'email',COALESCE(u.email,''),
      'scope',CASE WHEN EXISTS(
          SELECT 1 FROM public.pool_platform_staff_grants gg
          WHERE gg.tenant_id=m.tenant_id AND gg.auth_user_id=m.auth_user_id
            AND gg.pool_id IS NULL
        ) THEN 'all' ELSE 'selected' END,
      'pool_ids',COALESCE((
        SELECT jsonb_agg(DISTINCT g.pool_id)
        FROM public.pool_platform_staff_grants g
        WHERE g.tenant_id=m.tenant_id AND g.auth_user_id=m.auth_user_id
          AND g.pool_id IS NOT NULL
      ),'[]'::jsonb),
      'capabilities',COALESCE((
        SELECT jsonb_agg(DISTINCT gg.capability)
        FROM public.pool_platform_staff_grants gg
        WHERE gg.tenant_id=m.tenant_id AND gg.auth_user_id=m.auth_user_id
      ),'[]'::jsonb)
    ) ORDER BY lower(u.email),m.auth_user_id)
    FROM public.pool_platform_memberships m
    JOIN neon_auth."user" u ON u.id::text=m.auth_user_id
    WHERE m.tenant_id=p_tenant_id AND m.role='co_commissioner'
  ),'[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.pool_platform_crm_assistants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_crm_assistants(uuid) TO authenticated;

-- The existing grant helper is now an internal security-definer primitive;
-- all authenticated callers must use the audited wrapper below.
REVOKE EXECUTE ON FUNCTION public.pool_platform_set_staff_grants(uuid,text,text,uuid[],text[])
  FROM authenticated;

CREATE OR REPLACE FUNCTION public.pool_platform_crm_update_assistant(
  p_tenant_id uuid,
  p_staff_user_id text,
  p_scope text,
  p_pool_ids uuid[],
  p_capabilities text[]
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
DECLARE
  v_actor text:=public.pool_platform_current_user_id();
  v_before jsonb;
  v_after jsonb;
  v_count integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(p_tenant_id)
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  -- Serialize and record the entire change as one transaction.
  PERFORM 1 FROM public.pool_platform_memberships m
  WHERE m.tenant_id=p_tenant_id AND m.auth_user_id=p_staff_user_id
    AND m.role='co_commissioner'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'assistant_membership_required'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('pool_id',g.pool_id,'capability',g.capability)
      ORDER BY g.pool_id NULLS FIRST,g.capability),'[]'::jsonb)
    INTO v_before
  FROM public.pool_platform_staff_grants g
  WHERE g.tenant_id=p_tenant_id AND g.auth_user_id=p_staff_user_id;
  v_count:=public.pool_platform_set_staff_grants(
    p_tenant_id,p_staff_user_id,p_scope,p_pool_ids,p_capabilities
  );
  SELECT COALESCE(jsonb_agg(jsonb_build_object('pool_id',g.pool_id,'capability',g.capability)
      ORDER BY g.pool_id NULLS FIRST,g.capability),'[]'::jsonb)
    INTO v_after
  FROM public.pool_platform_staff_grants g
  WHERE g.tenant_id=p_tenant_id AND g.auth_user_id=p_staff_user_id;
  INSERT INTO public.pool_platform_crm_staff_audit(
    tenant_id,assistant_auth_user_id,actor_auth_user_id,action,previous_grants,next_grants
  ) VALUES (p_tenant_id,p_staff_user_id,v_actor,'update',v_before,v_after);
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.pool_platform_crm_update_assistant(uuid,text,text,uuid[],text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_crm_update_assistant(uuid,text,text,uuid[],text[])
  TO authenticated;

CREATE OR REPLACE FUNCTION public.pool_platform_crm_add_assistant(
  p_tenant_id uuid,
  p_email text,
  p_scope text,
  p_pool_ids uuid[],
  p_capabilities text[]
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
DECLARE
  v_actor text:=public.pool_platform_current_user_id();
  v_user_id text;
  v_count integer;
  v_role text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF p_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(p_tenant_id)
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  IF p_email IS NULL OR length(p_email)>254 OR p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  THEN RAISE EXCEPTION 'invalid_assistant_email'; END IF;
  -- The target must have signed up and verified their own account before staff enrollment.
  -- Return one generic response for unknown, banned and unverified accounts.
  SELECT u.id::text INTO v_user_id
  FROM neon_auth."user" u
  WHERE lower(u.email)=lower(btrim(p_email))
    AND u."emailVerified"=true AND COALESCE(u.banned,false)=false;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'assistant_account_not_ready'; END IF;
  IF v_user_id=v_actor THEN RAISE EXCEPTION 'assistant_self_enrollment_forbidden'; END IF;

  INSERT INTO public.pool_platform_memberships (tenant_id,auth_user_id,role)
  VALUES (p_tenant_id,v_user_id,'co_commissioner')
  ON CONFLICT (tenant_id,auth_user_id) DO NOTHING;

  SELECT m.role INTO v_role FROM public.pool_platform_memberships m
  WHERE m.tenant_id=p_tenant_id AND m.auth_user_id=v_user_id FOR UPDATE;
  IF v_role IS DISTINCT FROM 'co_commissioner'
  THEN RAISE EXCEPTION 'assistant_membership_conflict'; END IF;
  -- Enrollment and grant assignment either both succeed or both roll back.
  v_count:=public.pool_platform_set_staff_grants(
    p_tenant_id,v_user_id,p_scope,p_pool_ids,p_capabilities
  );

  INSERT INTO public.pool_platform_crm_staff_audit(
    tenant_id,assistant_auth_user_id,actor_auth_user_id,action,previous_grants,next_grants
  ) SELECT p_tenant_id,v_user_id,v_actor,'enroll','[]'::jsonb,
    COALESCE(jsonb_agg(jsonb_build_object('pool_id',g.pool_id,'capability',g.capability)
      ORDER BY g.pool_id NULLS FIRST,g.capability),'[]'::jsonb)
  FROM public.pool_platform_staff_grants g
  WHERE g.tenant_id=p_tenant_id AND g.auth_user_id=v_user_id;

  RETURN jsonb_build_object('ok',true,'grant_count',v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.pool_platform_crm_add_assistant(uuid,text,text,uuid[],text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_crm_add_assistant(uuid,text,text,uuid[],text[])
  TO authenticated;

-- Flag may only be presented to a tenant-wide owner/commissioner, never to an assistant.
CREATE OR REPLACE FUNCTION public.pool_platform_crm_can_manage_staff(p_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
  SELECT public.pool_platform_is_tenant_commissioner(p_tenant_id)
$$;
REVOKE ALL ON FUNCTION public.pool_platform_crm_can_manage_staff(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_crm_can_manage_staff(uuid) TO authenticated;
