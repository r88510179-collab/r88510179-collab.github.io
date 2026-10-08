-- HDC-13 SQL behavior harness: the production Neon shape that migrations 001-004 are applied on, emulated in a throwaway
-- PostgreSQL 17.11. Run once as the cluster superuser, connected to the "postgres" database; it creates the nfl_pool
-- database and switches to it. Nothing here is a migration and nothing here is ever applied to Neon.
--
-- Emulated from the read-only production snapshot (project flat-cake-85432375, branch main, database nfl_pool):
--   roles      anonymous and authenticated (NOLOGIN), authenticator (LOGIN NOINHERIT, member of both without inherit, as
--              the Data API connects and then SETs ROLE per request), neon_auth (LOGIN NOINHERIT, owns neon_auth),
--              neon_superuser (pg_read_all_data, pg_write_all_data, ...), and nfl_pool_owner (LOGIN, CREATEDB, CREATEROLE,
--              BYPASSRLS, REPLICATION; inherits anonymous, authenticated, neon_auth and neon_superuser; owns the database)
--   auth       a schema the Data API roles have no USAGE on, with auth.user_id() executable by PUBLIC. Production runs
--              pg_session_jwt; here auth.user_id() is a deterministic stand-in that returns the "sub" claim of the
--              request.jwt.claims setting (NULL when the setting, or its sub, is missing), the claims the Data API sets
--              per request with set_config(..., true)
--   neon_auth  the Neon Auth schema (USAGE for authenticated) and its "user" table, of which authenticated may SELECT
--              only id, email, role and banned, the four columns the commissioner predicate reads
--   public     USAGE for PUBLIC, anonymous and authenticated; nfl_pool_weeks, the Pick'em publication table no
--              repository migration creates, with its production columns, defaults, constraints, RLS policies and grants
--   TimeZone   GMT (set on the server by run.sh), as in production

\set ON_ERROR_STOP on

CREATE ROLE neon_superuser NOLOGIN CREATEDB CREATEROLE BYPASSRLS REPLICATION;
GRANT pg_read_all_data, pg_write_all_data, pg_monitor, pg_signal_backend, pg_create_subscription, pg_maintain TO neon_superuser;
CREATE ROLE anonymous NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator LOGIN NOINHERIT;
CREATE ROLE neon_auth LOGIN NOINHERIT;
CREATE ROLE nfl_pool_owner LOGIN CREATEDB CREATEROLE BYPASSRLS REPLICATION;
GRANT anonymous TO authenticator WITH INHERIT FALSE, SET TRUE;
GRANT authenticated TO authenticator WITH INHERIT FALSE, SET TRUE;
GRANT anonymous TO nfl_pool_owner WITH INHERIT TRUE, SET TRUE;
GRANT authenticated TO nfl_pool_owner WITH INHERIT TRUE, SET TRUE;
GRANT neon_auth TO nfl_pool_owner WITH INHERIT TRUE, SET TRUE;
GRANT neon_superuser TO nfl_pool_owner WITH INHERIT TRUE, SET TRUE;

CREATE DATABASE nfl_pool OWNER nfl_pool_owner;
\connect nfl_pool

-- public: USAGE for PUBLIC (the PostgreSQL 15+ default), anonymous and authenticated; CREATE only for the database owner.
GRANT USAGE ON SCHEMA public TO anonymous, authenticated;

-- auth: the pg_session_jwt stand-in. Owned by the superuser with no grant on the schema, as cloud_admin owns it in Neon.
CREATE SCHEMA auth;
CREATE FUNCTION auth.user_id() RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  claims text := current_setting('request.jwt.claims', true);
BEGIN
  IF claims IS NULL OR btrim(claims) = '' THEN
    RETURN NULL;
  END IF;
  RETURN claims::jsonb ->> 'sub';
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

-- neon_auth: owned by neon_auth; authenticated may use the schema and read the four columns the predicate needs.
CREATE SCHEMA neon_auth AUTHORIZATION neon_auth;
GRANT USAGE ON SCHEMA neon_auth TO authenticated;
SET ROLE neon_auth;
CREATE TABLE neon_auth."user" (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  "emailVerified" boolean NOT NULL,
  image text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  role text,
  banned boolean,
  "banReason" text,
  "banExpires" timestamptz
);
GRANT SELECT (id, email, role, banned) ON neon_auth."user" TO authenticated;
RESET ROLE;

-- nfl_pool_weeks: the Pick'em publication table (production shape; created outside the repository migrations).
SET ROLE nfl_pool_owner;
CREATE TABLE public.nfl_pool_weeks (
  season integer NOT NULL CHECK (season BETWEEN 2020 AND 2100),
  week integer NOT NULL CHECK (week BETWEEN 1 AND 22),
  status text NOT NULL CHECK (status IN ('draft','locked')),
  config jsonb NOT NULL,
  source_filename text,
  source_sha256 text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season, week)
);
ALTER TABLE public.nfl_pool_weeks ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.nfl_pool_weeks TO anonymous;
GRANT SELECT, INSERT, UPDATE ON public.nfl_pool_weeks TO authenticated;
CREATE POLICY nfl_pool_public_read_locked ON public.nfl_pool_weeks FOR SELECT TO anonymous USING (status = 'locked');
CREATE POLICY nfl_pool_admin_read ON public.nfl_pool_weeks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text = auth.user_id() AND lower(u.email) = 'djsmokke@gmail.com'
    AND u.role = 'admin' AND COALESCE(u.banned, false) = false));
CREATE POLICY nfl_pool_admin_insert ON public.nfl_pool_weeks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text = auth.user_id() AND lower(u.email) = 'djsmokke@gmail.com'
    AND u.role = 'admin' AND COALESCE(u.banned, false) = false));
CREATE POLICY nfl_pool_admin_update ON public.nfl_pool_weeks FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text = auth.user_id() AND lower(u.email) = 'djsmokke@gmail.com'
    AND u.role = 'admin' AND COALESCE(u.banned, false) = false))
  WITH CHECK (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text = auth.user_id() AND lower(u.email) = 'djsmokke@gmail.com'
    AND u.role = 'admin' AND COALESCE(u.banned, false) = false));
RESET ROLE;
