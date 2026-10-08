-- REVIEW-ONLY forward migration for a commercial database that applied 002_identity_submission_rls.sql before its
-- identity helpers were hardened against pre-registration takeover (002 as of 48e0ac4). Do not run it before it has been
-- reviewed, and never on the personal Pool Center database.
--
-- It replaces only the three identity helpers, public.pool_platform_current_user_id(),
-- public.pool_platform_current_user_email() and public.pool_platform_current_user_has_verified_email(text), with the
-- definitions 002 now carries (byte for byte), and resets those three functions' privileges exactly as 002 does. No
-- table, policy, index, trigger, sequence, row or other function changes. A database built from the current 001 and 002
-- already has these definitions, so running this file there changes nothing. Every policy and RPC names its caller
-- through these helpers, so from the commit on, a Neon Auth user with a password or OAuth account, or a JWT minted
-- before the email was verified, is nobody (see 002 and docs/PRE_REGISTRATION_HARDENING.md for the rollout order).
--
-- Run it like 001, 002 and 003 (runbook steps 8 and 9): as the role that owns the migrations, as one transaction that
-- stops at the first error; then re-run validation/neon-catalog-verify.sql (C99 must be PASS):
--
--   psql "$COMMERCIAL_DEV_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
--     -f pool-platform/migrations/004_identity_pre_registration_hardening.sql
--
-- The guard stops the transaction, leaving nothing behind, on the personal Pool Center database; when a helper is missing
-- (a database without 002 needs 001 and 002, not this file); when a role other than the helpers' owner runs the file;
-- when a helper's current body is neither the reviewed pre-hardening body nor the hardened one (SHA-256 of
-- pg_proc.prosrc), so a definition nobody reviewed is never overwritten; or when what the hardened helpers read is
-- missing or out of their owner's reach: auth.session() returning jsonb, and neon_auth.account."userId" of the type of
-- neon_auth."user".id.
DO $$
DECLARE
  v_helper record;
  v_fn regprocedure;
  v_owner oid;
  v_body_sha256 text;
  v_session regprocedure:=to_regprocedure('auth.session()');
  v_account regclass:=to_regclass('neon_auth.account');
  v_account_user_id smallint;
BEGIN
  IF current_database()='nfl_pool'
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relname IN ('nfl_pool_weeks','nfl_survivor_weeks'))
  THEN RAISE EXCEPTION 'personal Pool Center database: stop'; END IF;
  -- Per helper: the reviewed pre-hardening body (002 as of 48e0ac4, what the commercial database holds) and the
  -- hardened body below.
  FOR v_helper IN SELECT * FROM (VALUES
    ('public.pool_platform_current_user_id()','7702b14277266031188e451f3245a76b99b5a7a68153ed11075fe7356e932b5d','001b760143c8affb11125394a7cf0f5b2f52fe6b24bde10a61ed5056357dd8c8'),
    ('public.pool_platform_current_user_email()','2cf7b7b80696acc8b22486daaff2a0cfa26f1f9fecab991fcd823d17a64db3c5','b605c8f54b4b386607aff82a6fc92b70b116362462052f697e7671a3ee0974da'),
    ('public.pool_platform_current_user_has_verified_email(text)','5120424105ba729e50e82bfd365720ef31a2f1eb323afe66da36b2cf8fb1f0c3','7615a729ee19823e61363351fcd03a15b94f2bc74948d4509fc0a17f493e2271')
  ) AS h(sig,pre_hardening,hardened)
  LOOP
    v_fn:=to_regprocedure(v_helper.sig);
    IF v_fn IS NULL THEN RAISE EXCEPTION '% does not exist: stop',v_helper.sig; END IF;
    SELECT p.proowner,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') INTO v_owner,v_body_sha256
    FROM pg_catalog.pg_proc p WHERE p.oid=v_fn;
    IF v_owner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=current_user)
    THEN RAISE EXCEPTION 'run as %, the owner of %, not %: stop',v_owner::regrole,v_helper.sig,current_user; END IF;
    IF v_body_sha256 NOT IN (v_helper.pre_hardening,v_helper.hardened)
    THEN RAISE EXCEPTION '% body sha256 % is not a reviewed definition: stop',v_helper.sig,v_body_sha256; END IF;
  END LOOP;
  -- What the hardened helpers read, as their owner (current_user, checked above). CREATE FUNCTION would catch a missing
  -- function or table, but not a missing privilege, which would only show once every call failed.
  IF v_session IS NULL OR (SELECT p.prorettype FROM pg_catalog.pg_proc p WHERE p.oid=v_session)<>'jsonb'::regtype
  THEN RAISE EXCEPTION 'auth.session() returning jsonb (pg_session_jwt) is missing: stop'; END IF;
  IF NOT (has_schema_privilege('auth','USAGE') AND has_function_privilege(v_session,'EXECUTE'))
  THEN RAISE EXCEPTION '% cannot call auth.session(): stop',current_user; END IF;
  SELECT a.attnum INTO v_account_user_id
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=v_account AND a.attname='userId' AND a.attnum>0 AND NOT a.attisdropped
    AND a.atttypid=(SELECT u.atttypid FROM pg_catalog.pg_attribute u
                    WHERE u.attrelid=to_regclass('neon_auth."user"') AND u.attname='id' AND u.attnum>0 AND NOT u.attisdropped);
  IF v_account_user_id IS NULL
  THEN RAISE EXCEPTION 'neon_auth.account."userId" of the type of neon_auth."user".id is missing: stop'; END IF;
  IF NOT (has_schema_privilege('neon_auth','USAGE') AND has_column_privilege(v_account,v_account_user_id,'SELECT'))
  THEN RAISE EXCEPTION '% cannot read neon_auth.account."userId": stop',current_user; END IF;
END
$$;

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
    AND auth.session()->>'sub'=u.id::text
    AND auth.session()->'emailVerified'=to_jsonb(u."emailVerified")
    AND NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)
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
    AND auth.session()->>'sub'=u.id::text
    AND auth.session()->'emailVerified'=to_jsonb(u."emailVerified")
    AND NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)
  LIMIT 1
$$;

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
      AND auth.session()->>'sub'=u.id::text
      AND auth.session()->'emailVerified'=to_jsonb(u."emailVerified")
      AND NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)
  )
$$;

REVOKE ALL ON FUNCTION public.pool_platform_current_user_id() FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_current_user_email() FROM PUBLIC,anonymous,authenticated CASCADE;
REVOKE ALL ON FUNCTION public.pool_platform_current_user_has_verified_email(text) FROM PUBLIC,anonymous,authenticated CASCADE;
GRANT EXECUTE ON FUNCTION public.pool_platform_current_user_id() TO authenticated;
