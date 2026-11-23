-- DISPOSABLE PostgreSQL ONLY. Never run this against Neon.
--
-- Rebuilds, in an empty database named neondb, the schema the live Commercial database had before this release,
-- as read from its catalog on 2026-11-18 (read-only): migrations 001 to 003, then the identity hardening that was
-- applied to that database directly and exists in no migration file (pool_platform_private.auth_issuer and the three
-- identity helpers that check the token's subject, issuer, audience and verified-email claim and refuse an account
-- that has a password or social login). The last statement compares every function body with the SHA-256 recorded
-- from the live catalog, so a replica that drifts from production stops here instead of rehearsing something else.
--
-- Run as a superuser of a disposable cluster, from pool-platform/ (the rehearsal test also insists on a loopback
-- address; a CI service container behind a mapped port does not look like loopback from the server's side):
--   psql -X -v ON_ERROR_STOP=1 -d neondb -f tests/release/production-replica-schema.sql
\set ON_ERROR_STOP on
DO $guard$
BEGIN
  IF current_database()<>'neondb' THEN RAISE EXCEPTION 'replica_requires_a_database_named_neondb'; END IF;
  -- Never a Neon compute: one reports its project and has Neon's own administrative roles. A disposable cluster
  -- reports no project, or the name this file sets for the rehearsal.
  IF COALESCE(current_setting('neon.project_id',true),'') NOT IN ('','rehearsal-project')
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('cloud_admin','neon_superuser'))
    THEN RAISE EXCEPTION 'replica_refuses_a_neon_project'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname LIKE 'pool_platform_%')
    THEN RAISE EXCEPTION 'replica_requires_an_empty_database'; END IF;
END
$guard$;

-- Roles as Neon provides them: the database owner is not a superuser; the Data API runs requests as authenticated
-- or anonymous.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='neondb_owner') THEN CREATE ROLE neondb_owner LOGIN NOSUPERUSER; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='neon_auth') THEN CREATE ROLE neon_auth NOLOGIN; END IF;
END
$roles$;
ALTER DATABASE neondb OWNER TO neondb_owner;
GRANT authenticated,anonymous TO neondb_owner;
-- What a Neon compute reports about itself, and what ops/release/verify-target.sql compares. New sessions see them.
ALTER DATABASE neondb SET neon.project_id='rehearsal-project';
ALTER DATABASE neondb SET neon.branch_id='br-rehearsal';

-- Stand-ins for what Neon owns. auth.session() is the verified token's claims; here they come from a setting the
-- rehearsal sets for each simulated request. Neon Auth's tables carry only the columns the helpers read.
CREATE SCHEMA auth;
CREATE FUNCTION auth.session() RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claims',true),'')::jsonb $$;
CREATE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT auth.session()->>'sub' $$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
CREATE SCHEMA neon_auth AUTHORIZATION neon_auth;
CREATE TABLE neon_auth."user" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  banned boolean
);
CREATE TABLE neon_auth.account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES neon_auth."user"(id),
  "providerId" text NOT NULL
);
ALTER TABLE neon_auth."user" OWNER TO neon_auth;
ALTER TABLE neon_auth.account OWNER TO neon_auth;
GRANT USAGE ON SCHEMA neon_auth TO neondb_owner;
GRANT SELECT ON neon_auth."user",neon_auth.account TO neondb_owner;

SET ROLE neondb_owner;
\ir ../../migrations/001_foundation.sql
\ir ../../migrations/002_identity_submission_rls.sql
\ir ../../migrations/003_submit_entry_authorization_order.sql

-- The identity hardening, exactly as the live catalog holds it.
CREATE SCHEMA pool_platform_private;
CREATE TABLE pool_platform_private.auth_issuer (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  issuer text NOT NULL CHECK (issuer ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$')
);
ALTER TABLE pool_platform_private.auth_issuer ENABLE ROW LEVEL SECURITY;
-- The one issuer every accepted token must name. Production holds its own Neon Auth origin here.
INSERT INTO pool_platform_private.auth_issuer(issuer) VALUES ('https://rehearsal-auth.invalid');

CREATE OR REPLACE FUNCTION public.pool_platform_current_user_id()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
  SELECT u.id::text
  FROM neon_auth."user" u
  WHERE u.id::text=auth.user_id()
    AND COALESCE(u.banned,false)=false
    AND auth.session()->>'sub'=u.id::text
    AND auth.session()->'emailVerified'=to_jsonb(u."emailVerified")
    AND rtrim(auth.session()->>'iss','/')=(SELECT i.issuer FROM pool_platform_private.auth_issuer i)
    AND rtrim(auth.session()->>'aud','/')=(SELECT i.issuer FROM pool_platform_private.auth_issuer i)
    AND NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.pool_platform_current_user_email()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
  SELECT lower(btrim(u.email))
  FROM neon_auth."user" u
  WHERE u.id::text=auth.user_id()
    AND COALESCE(u.banned,false)=false
    AND auth.session()->>'sub'=u.id::text
    AND auth.session()->'emailVerified'=to_jsonb(u."emailVerified")
    AND rtrim(auth.session()->>'iss','/')=(SELECT i.issuer FROM pool_platform_private.auth_issuer i)
    AND rtrim(auth.session()->>'aud','/')=(SELECT i.issuer FROM pool_platform_private.auth_issuer i)
    AND NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.pool_platform_current_user_has_verified_email(p_email_normalized text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'neon_auth', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM neon_auth."user" u
    WHERE u.id::text=auth.user_id()
      AND COALESCE(u.banned,false)=false
      AND u."emailVerified" IS TRUE
      AND lower(btrim(u.email))=p_email_normalized
      AND auth.session()->>'sub'=u.id::text
      AND auth.session()->'emailVerified'=to_jsonb(u."emailVerified")
      AND rtrim(auth.session()->>'iss','/')=(SELECT i.issuer FROM pool_platform_private.auth_issuer i)
      AND rtrim(auth.session()->>'aud','/')=(SELECT i.issuer FROM pool_platform_private.auth_issuer i)
      AND NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)
  )
$function$;
RESET ROLE;

-- The replica is the live schema only if every function body is the one the live catalog holds.
\ir ../../ops/release/verify-baseline-schema.sql
