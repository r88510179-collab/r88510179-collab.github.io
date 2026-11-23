-- Install verified-email invitations before deploying the new frontend. Existing invitations keep their original grants until cutover.
CREATE TABLE IF NOT EXISTS public.pool_platform_email_invite_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.pool_platform_entries(id),
  email_normalized text NOT NULL
    CHECK (
      length(email_normalized) BETWEEN 3 AND 254
      AND email_normalized = lower(btrim(email_normalized))
      AND email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
  expires_at timestamptz NOT NULL,
  claimed_by_auth_user_id text,
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_by_auth_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pool_platform_email_invite_grants_entry_idx
  ON public.pool_platform_email_invite_grants(entry_id,created_at DESC);
ALTER TABLE public.pool_platform_email_invite_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pool_platform_email_invite_grants FROM PUBLIC;
REVOKE ALL ON TABLE public.pool_platform_email_invite_grants FROM authenticated;

CREATE OR REPLACE FUNCTION public.pool_platform_create_email_invite(
  p_entry_id uuid, p_email text, p_expires_hours integer DEFAULT 168
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_email text := NULLIF(lower(btrim(p_email)), '');
  v_tenant_id uuid;
  v_owner text;
  v_entry_status text;
  v_pool_status text;
  v_season_status text;
  v_tenant_status text;
  v_expires timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF v_email IS NULL OR length(v_email) > 254
     OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    THEN RAISE EXCEPTION 'invalid_invite_email'; END IF;
  IF p_expires_hours IS NULL OR p_expires_hours NOT BETWEEN 1 AND 720
    THEN RAISE EXCEPTION 'invalid_invite_expiry'; END IF;

  -- Entry-first lock ordering is also used by claim_email_invite.
  -- New grant issuance serializes with claims and rotates older grants.
  SELECT p.tenant_id, e.owner_auth_user_id, e.status, p.status, s.status, t.status
    INTO v_tenant_id, v_owner, v_entry_status, v_pool_status,
         v_season_status, v_tenant_status
    FROM public.pool_platform_entries e
    JOIN public.pool_platform_seasons s ON s.id=e.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
   WHERE e.id=p_entry_id
   FOR UPDATE OF e;
  IF v_tenant_id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_tenant_id)
    THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  IF v_owner IS NOT NULL OR v_entry_status <> 'active'
     OR v_pool_status <> 'active' OR v_tenant_status <> 'active'
     OR v_season_status NOT IN ('setup','active')
    THEN RAISE EXCEPTION 'entry_unavailable'; END IF;

  v_expires := now()+make_interval(hours=>p_expires_hours);
  -- Reissuing invalidates all earlier UNCLAIMED email grants for this entry,
  -- including ones addressed to a different recipient. Legacy bearer invites
  -- stay untouched; only their browser grants are retired during cutover.
  UPDATE public.pool_platform_email_invite_grants
     SET revoked_at=now()
   WHERE entry_id=p_entry_id AND claimed_at IS NULL AND revoked_at IS NULL;
  INSERT INTO public.pool_platform_email_invite_grants(
    entry_id, email_normalized, expires_at, created_by_auth_user_id
  ) VALUES (p_entry_id,v_email,v_expires,v_uid);

  -- A sender can share an entry UUID only. The intended recipient MUST
  -- separately prove ownership of this email through Neon Auth.
  RETURN jsonb_build_object('entry_id',p_entry_id, 'expires_at',v_expires,
                            'delivery','verified_email');
END;
$function$;

REVOKE ALL ON FUNCTION public.pool_platform_create_email_invite(uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_create_email_invite(uuid,text,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.pool_platform_claim_email_invite(p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
DECLARE
  v_uid text := public.pool_platform_current_user_id();
  v_email text;
  v_inv public.pool_platform_email_invite_grants%ROWTYPE;
  v_owner text;
  v_entry_status text;
  v_pool_status text;
  v_season_status text;
  v_tenant_status text;
BEGIN
  -- Client retries auth_required once. It must precede every read/lock/write.
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  v_email := public.pool_platform_current_user_email();
  IF v_email IS NULL OR NOT public.pool_platform_current_user_has_verified_email(v_email)
    THEN RAISE EXCEPTION 'invite_email_unverified'; END IF;

  -- Entry UUID is a lookup hint, not a credential.
  -- Lock ENTRY first in both issuance and claim to avoid lock-order deadlocks.
  SELECT e.owner_auth_user_id,e.status,p.status,s.status,t.status
    INTO v_owner,v_entry_status,v_pool_status,v_season_status,v_tenant_status
    FROM public.pool_platform_entries e
    JOIN public.pool_platform_seasons s ON s.id=e.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id
    JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
   WHERE e.id=p_entry_id
   FOR UPDATE OF e;
  IF NOT FOUND OR v_entry_status <> 'active' OR v_pool_status <> 'active'
     OR v_tenant_status <> 'active' OR v_season_status NOT IN ('setup','active')
    THEN RAISE EXCEPTION 'invite_unavailable'; END IF;

  SELECT * INTO v_inv
    FROM public.pool_platform_email_invite_grants
   WHERE entry_id=p_entry_id AND email_normalized=v_email
     AND revoked_at IS NULL AND claimed_at IS NULL AND expires_at>now()
   ORDER BY created_at DESC, id DESC
   LIMIT 1 FOR UPDATE;
  IF v_inv.id IS NULL THEN RAISE EXCEPTION 'invite_unavailable'; END IF;
  IF v_owner IS NOT NULL THEN RAISE EXCEPTION 'entry_already_claimed'; END IF;

  UPDATE public.pool_platform_entries
     SET owner_auth_user_id=v_uid,updated_at=now()
   WHERE id=p_entry_id AND owner_auth_user_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'entry_already_claimed'; END IF;
  UPDATE public.pool_platform_email_invite_grants
     SET claimed_by_auth_user_id=v_uid,claimed_at=now()
   WHERE id=v_inv.id AND claimed_at IS NULL AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invite_unavailable'; END IF;

  RETURN jsonb_build_object('entry_id',p_entry_id,'claimed',true);
END;
$function$;

REVOKE ALL ON FUNCTION public.pool_platform_claim_email_invite(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_claim_email_invite(uuid) TO authenticated;
