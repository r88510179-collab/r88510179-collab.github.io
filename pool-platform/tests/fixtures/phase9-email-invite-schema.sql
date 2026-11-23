-- Disposable local PostgreSQL CI fixture only: NOT a Neon migration, not real Auth.
DO $$ BEGIN IF current_database()<>'phase9_invite_fixture'
  THEN RAISE EXCEPTION 'fixture_database_required'; END IF; END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anonymous NOLOGIN;
CREATE SCHEMA neon_auth;
CREATE SCHEMA fixture;
CREATE TABLE public.pool_platform_tenants(id uuid PRIMARY KEY,status text NOT NULL);
CREATE TABLE public.pool_platform_pools(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.pool_platform_tenants,status text NOT NULL);
CREATE TABLE public.pool_platform_seasons(id uuid PRIMARY KEY,pool_id uuid NOT NULL REFERENCES public.pool_platform_pools,status text NOT NULL);
CREATE TABLE public.pool_platform_entries(
  id uuid PRIMARY KEY,season_id uuid NOT NULL REFERENCES public.pool_platform_seasons,
  owner_auth_user_id text,status text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.pool_platform_memberships(
  tenant_id uuid NOT NULL,auth_user_id text NOT NULL,role text NOT NULL
);
CREATE TABLE public.pool_platform_entry_invites(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.pool_platform_entries,
  token_sha256 bytea NOT NULL UNIQUE,
  email_normalized text,
  expires_at timestamptz NOT NULL,
  claimed_by_auth_user_id text,
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_by_auth_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Only for the disposable fixture: real staging uses signed Neon Auth helpers.
CREATE FUNCTION public.pool_platform_current_user_id() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
  AS $$ SELECT nullif(current_setting('fixture.subject',true),'') $$;
CREATE FUNCTION public.pool_platform_current_user_email() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
  AS $$ SELECT nullif(lower(current_setting('fixture.email',true)),'') $$;
CREATE FUNCTION public.pool_platform_current_user_has_verified_email(p_email_normalized text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
  AS $$ SELECT current_setting('fixture.verified',true)='on'
    AND lower(current_setting('fixture.email',true))=p_email_normalized
    AND nullif(current_setting('fixture.subject',true),'') IS NOT NULL $$;
CREATE FUNCTION public.pool_platform_is_tenant_commissioner(p_tenant_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
  AS $$ SELECT EXISTS(SELECT 1 FROM public.pool_platform_memberships
    WHERE tenant_id=p_tenant_id
      AND auth_user_id=public.pool_platform_current_user_id()
      AND role IN ('owner','commissioner','co_commissioner')) $$;

-- Stand-in legacy endpoints so the migration must revoke their browser grants.
CREATE FUNCTION public.pool_platform_create_entry_invite(uuid,text,integer)
  RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.pool_platform_claim_entry_invite(text)
  RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
GRANT EXECUTE ON FUNCTION public.pool_platform_create_entry_invite(uuid,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_claim_entry_invite(text) TO authenticated;

INSERT INTO public.pool_platform_tenants VALUES
 ('10000000-0000-0000-0000-000000000001','active'),
 ('10000000-0000-0000-0000-000000000002','active');
INSERT INTO public.pool_platform_pools VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','active'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','active');
INSERT INTO public.pool_platform_seasons VALUES
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','active'),
 ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','active');
INSERT INTO public.pool_platform_entries(id,season_id,status) VALUES
 ('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','active'),
 ('40000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002','active'),
 ('40000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001','active'),
 ('40000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001','active'),
 ('40000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000001','active');
INSERT INTO public.pool_platform_memberships VALUES
 ('10000000-0000-0000-0000-000000000001','alpha-owner','owner'),
 ('10000000-0000-0000-0000-000000000002','beta-owner','owner');

-- One legacy email-bound bearer invitation (intentionally NOT a new grant).
-- Its old token is synthetic and is never returned to a browser.
INSERT INTO public.pool_platform_entry_invites(
  entry_id,token_sha256,email_normalized,expires_at,created_by_auth_user_id
) VALUES (
 '40000000-0000-0000-0000-000000000003',
 digest('fixture-legacy-secret-not-a-real-token','sha256'),
 'alpha@example.test',now()+interval '7 days','alpha-owner'
);

CREATE FUNCTION fixture.assert_true(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAILED: %',label; END IF; END $$;
CREATE FUNCTION fixture.expect_error(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE err text;
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF position(expected IN err)>0 THEN RETURN; END IF;
    RAISE EXCEPTION 'Expected %, got %',expected,err;
  END;
  RAISE EXCEPTION 'Expected error %, statement succeeded',expected;
END $$;
GRANT USAGE ON SCHEMA fixture TO authenticated,anonymous;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA fixture TO authenticated,anonymous;
