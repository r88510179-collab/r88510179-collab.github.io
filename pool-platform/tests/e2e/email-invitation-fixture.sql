-- Only the loopback Playwright database uses these synthetic verified accounts.
DO $$ BEGIN
  IF current_database() <> 'pool_e2e' THEN RAISE EXCEPTION 'fixture_database_required'; END IF;
END $$;

CREATE FUNCTION public.pool_platform_current_user_email() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE public.pool_platform_current_user_id()
    WHEN 'alice' THEN 'alice@e2e.invalid'
    WHEN 'outsider' THEN 'outsider@e2e.invalid'
  END
$$;

CREATE FUNCTION public.pool_platform_current_user_has_verified_email(email text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT email IN ('alice@e2e.invalid','outsider@e2e.invalid')
    AND email=public.pool_platform_current_user_email()
$$;

\ir ../../migrations/20261104_phase9_sso_safe_email_invites.sql
