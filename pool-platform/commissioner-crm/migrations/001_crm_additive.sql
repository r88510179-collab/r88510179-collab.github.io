-- CRM-001: additive foundation ONLY. Not approved for production application.
-- RLS and all existing protected RPCs remain unchanged. See README / CRM-002 gate.
-- Apply in a dedicated isolated Neon branch; test and review before production.
BEGIN;

-- Composite FK guarantees no pool grant points at another tenant's pool.
ALTER TABLE public.pool_platform_pools
  ADD CONSTRAINT pool_platform_pools_tenant_id_id_key UNIQUE (tenant_id,id);

CREATE TABLE public.pool_platform_staff_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  auth_user_id text NOT NULL,
  pool_id uuid,
  capability text NOT NULL CHECK (capability IN (
    'view_pool','manage_players','review_picks','edit_rules',
    'send_updates','share_cards','record_dues'
  )),
  created_by_auth_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pool_platform_staff_grants_membership_fk
    FOREIGN KEY (tenant_id,auth_user_id)
    REFERENCES public.pool_platform_memberships(tenant_id,auth_user_id)
    ON DELETE CASCADE,
  CONSTRAINT pool_platform_staff_grants_pool_fk
    FOREIGN KEY (tenant_id,pool_id)
    REFERENCES public.pool_platform_pools(tenant_id,id)
    ON DELETE CASCADE
);
CREATE UNIQUE INDEX pool_platform_staff_grants_scope_unique
  ON public.pool_platform_staff_grants
  (tenant_id,auth_user_id,pool_id,capability) NULLS NOT DISTINCT;
CREATE INDEX pool_platform_staff_grants_user_idx
  ON public.pool_platform_staff_grants(auth_user_id,tenant_id);

ALTER TABLE public.pool_platform_staff_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pool_platform_staff_grants FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.pool_platform_staff_grants TO authenticated;

CREATE POLICY pool_platform_staff_grants_read
ON public.pool_platform_staff_grants FOR SELECT TO authenticated
USING (
  auth_user_id=public.pool_platform_current_user_id()
  OR EXISTS (
    SELECT 1 FROM public.pool_platform_memberships m
    WHERE m.tenant_id=pool_platform_staff_grants.tenant_id
      AND m.auth_user_id=public.pool_platform_current_user_id()
      AND m.role IN ('owner','commissioner')
  )
);

-- A null pool_id grants that capability across ALL pools of this tenant.
-- Explicit pool_id grants apply only to that pool. No privilege may be passed via client role claims.
CREATE FUNCTION public.pool_platform_staff_can(p_pool_id uuid,p_capability text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
  SELECT COALESCE((
    SELECT EXISTS (
      SELECT 1
      FROM public.pool_platform_pools p
      JOIN public.pool_platform_memberships m
        ON m.tenant_id=p.tenant_id
       AND m.auth_user_id=public.pool_platform_current_user_id()
      WHERE p.id=p_pool_id
        AND (
          m.role IN ('owner','commissioner')
          OR (
            m.role='co_commissioner'
            AND EXISTS (
              SELECT 1 FROM public.pool_platform_staff_grants g
              WHERE g.tenant_id=p.tenant_id
                AND g.auth_user_id=m.auth_user_id
                AND (g.pool_id IS NULL OR g.pool_id=p.id)
                AND g.capability=p_capability
            )
          )
        )
    )
  ),false)
$$;
REVOKE ALL ON FUNCTION public.pool_platform_staff_can(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pool_platform_staff_can(uuid,text) TO authenticated;

CREATE FUNCTION public.pool_platform_set_staff_grants(
  p_tenant_id uuid,
  p_staff_user_id text,
  p_scope text,
  p_pool_ids uuid[],
  p_capabilities text[]
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
DECLARE
  v_actor text:=public.pool_platform_current_user_id();
  v_pool_id uuid;
  v_cap text;
  v_grants int:=0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pool_platform_memberships m
    WHERE m.tenant_id=p_tenant_id AND m.auth_user_id=v_actor
      AND m.role IN ('owner','commissioner')
  ) THEN RAISE EXCEPTION 'commissioner_required'; END IF;

  -- Serialize concurrent updates to this assistant's complete set of grants.
  PERFORM 1 FROM public.pool_platform_memberships m
  WHERE m.tenant_id=p_tenant_id AND m.auth_user_id=p_staff_user_id
    AND m.role='co_commissioner'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'assistant_membership_required'; END IF;

  IF p_scope NOT IN ('all','selected') OR p_scope IS NULL
  THEN RAISE EXCEPTION 'invalid_scope'; END IF;
  IF p_capabilities IS NULL
     OR cardinality(p_capabilities)>7
     OR EXISTS (
       SELECT 1 FROM unnest(p_capabilities) cap
       WHERE cap IS NULL OR cap NOT IN (
         'view_pool','manage_players','review_picks','edit_rules',
         'send_updates','share_cards','record_dues'
       )
     )
  THEN RAISE EXCEPTION 'invalid_capabilities'; END IF;

  IF p_scope='selected' THEN
    IF p_pool_ids IS NULL OR cardinality(p_pool_ids)=0
       OR cardinality(p_pool_ids)>50
    THEN RAISE EXCEPTION 'invalid_selected_pools'; END IF;
    IF EXISTS (
      SELECT 1 FROM unnest(p_pool_ids) requested(id)
      LEFT JOIN public.pool_platform_pools p ON p.id=requested.id
      WHERE requested.id IS NULL OR p.id IS NULL OR p.tenant_id<>p_tenant_id
    ) THEN RAISE EXCEPTION 'invalid_selected_pools'; END IF;
  END IF;

  -- Fully replace grants. Zero capabilities means intentional view revocation.
  DELETE FROM public.pool_platform_staff_grants
  WHERE tenant_id=p_tenant_id AND auth_user_id=p_staff_user_id;

  IF p_scope='all' THEN
    FOR v_cap IN SELECT DISTINCT cap FROM unnest(p_capabilities) cap LOOP
      INSERT INTO public.pool_platform_staff_grants(
        tenant_id,auth_user_id,pool_id,capability,created_by_auth_user_id
      ) VALUES (p_tenant_id,p_staff_user_id,NULL,v_cap,v_actor);
      v_grants:=v_grants+1;
    END LOOP;
  ELSE
    FOR v_pool_id IN SELECT DISTINCT id FROM unnest(p_pool_ids) id LOOP
      FOR v_cap IN SELECT DISTINCT cap FROM unnest(p_capabilities) cap LOOP
        INSERT INTO public.pool_platform_staff_grants(
          tenant_id,auth_user_id,pool_id,capability,created_by_auth_user_id
        ) VALUES (p_tenant_id,p_staff_user_id,v_pool_id,v_cap,v_actor);
        v_grants:=v_grants+1;
      END LOOP;
    END LOOP;
  END IF;
  RETURN v_grants;
END;
$$;
REVOKE ALL ON FUNCTION public.pool_platform_set_staff_grants(uuid,text,text,uuid[],text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pool_platform_set_staff_grants(uuid,text,text,uuid[],text[]) TO authenticated;

CREATE TABLE public.pool_platform_pool_features (
  pool_id uuid PRIMARY KEY REFERENCES public.pool_platform_pools(id) ON DELETE CASCADE,
  dues_tracking_enabled boolean NOT NULL DEFAULT false,
  updated_by_auth_user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pool_platform_pool_features ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pool_platform_pool_features FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.pool_platform_pool_features TO authenticated;
CREATE POLICY pool_platform_pool_features_read ON public.pool_platform_pool_features
FOR SELECT TO authenticated
USING (public.pool_platform_staff_can(pool_id,'view_pool'));

CREATE FUNCTION public.pool_platform_set_dues_enabled(p_pool_id uuid,p_enabled boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
DECLARE v_actor text:=public.pool_platform_current_user_id();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF NOT public.pool_platform_staff_can(p_pool_id,'edit_rules')
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'invalid_setting'; END IF;
  INSERT INTO public.pool_platform_pool_features(pool_id,dues_tracking_enabled,updated_by_auth_user_id)
  VALUES (p_pool_id,p_enabled,v_actor)
  ON CONFLICT (pool_id) DO UPDATE SET
    dues_tracking_enabled=EXCLUDED.dues_tracking_enabled,
    updated_by_auth_user_id=EXCLUDED.updated_by_auth_user_id,
    updated_at=now();
  RETURN p_enabled;
END;
$$;
REVOKE ALL ON FUNCTION public.pool_platform_set_dues_enabled(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pool_platform_set_dues_enabled(uuid,boolean) TO authenticated;

-- Manual bookkeeping ONLY: no payment token, processor reference, card details, or money movement.
CREATE TABLE public.pool_platform_dues_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.pool_platform_entries(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('charge','payment','credit','refund')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  currency_code text NOT NULL DEFAULT 'USD' CHECK (currency_code='USD'),
  note text CHECK (note IS NULL OR length(note)<=250),
  recorded_by_auth_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pool_platform_dues_events_entry_time_idx
ON public.pool_platform_dues_events(entry_id,created_at DESC);

ALTER TABLE public.pool_platform_dues_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pool_platform_dues_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.pool_platform_dues_events TO authenticated;
CREATE POLICY pool_platform_dues_events_read ON public.pool_platform_dues_events
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.pool_platform_entries e
    JOIN public.pool_platform_seasons s ON s.id=e.season_id
    WHERE e.id=pool_platform_dues_events.entry_id
      AND public.pool_platform_staff_can(s.pool_id,'record_dues')
  )
);

CREATE FUNCTION public.pool_platform_record_dues_event(
  p_entry_id uuid,p_kind text,p_amount_cents bigint,p_note text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,neon_auth,pg_temp
AS $$
DECLARE
  v_actor text:=public.pool_platform_current_user_id();
  v_pool_id uuid;
  v_enabled boolean;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  SELECT s.pool_id INTO v_pool_id
  FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  WHERE e.id=p_entry_id;
  IF v_pool_id IS NULL OR NOT public.pool_platform_staff_can(v_pool_id,'record_dues')
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;

  SELECT COALESCE(dues_tracking_enabled,false) INTO v_enabled
  FROM public.pool_platform_pool_features WHERE pool_id=v_pool_id;
  IF COALESCE(v_enabled,false) IS NOT TRUE
  THEN RAISE EXCEPTION 'dues_tracking_disabled'; END IF;
  IF p_kind NOT IN ('charge','payment','credit','refund') OR p_kind IS NULL
    OR p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 1 AND 100000000
    OR length(COALESCE(p_note,''))>250
  THEN RAISE EXCEPTION 'invalid_dues_event'; END IF;

  INSERT INTO public.pool_platform_dues_events(
    entry_id,kind,amount_cents,note,recorded_by_auth_user_id
  ) VALUES (p_entry_id,p_kind,p_amount_cents,NULLIF(btrim(p_note),''),v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pool_platform_record_dues_event(uuid,text,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pool_platform_record_dues_event(uuid,text,bigint,text) TO authenticated;

-- Ledger changes are append-only. A mistake is corrected with another event.
CREATE FUNCTION public.pool_platform_dues_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dues_history_is_append_only';
END;
$$;
REVOKE ALL ON FUNCTION public.pool_platform_dues_immutable() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER pool_platform_dues_events_immutable
  BEFORE UPDATE OR DELETE ON public.pool_platform_dues_events
  FOR EACH ROW EXECUTE FUNCTION public.pool_platform_dues_immutable();

COMMIT;
