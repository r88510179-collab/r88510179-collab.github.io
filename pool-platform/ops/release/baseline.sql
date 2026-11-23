\set ON_ERROR_STOP on
-- Read-only. Prints what the release must preserve, so the same command before and after a release step shows it did:
-- a count and fingerprint for each of the ten original application tables, the identity map, and what is installed.
-- It prints counts and hashes only: no address, name, pick, token or key.
--   psql -X -v expected_project="$COMMERCIAL_PROJECT" -v expected_branch="$COMMERCIAL_BRANCH" -f ops/release/baseline.sql
BEGIN TRANSACTION READ ONLY;
\ir verify-target.sql
\pset expanded on
\echo '== target =='
SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS read_at,current_database() AS database,
  current_setting('neon.project_id',true) AS project,current_setting('neon.branch_id',true) AS branch,
  current_setting('server_version') AS postgresql;
\echo '== the ten original application tables: rows:fingerprint =='
SELECT
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_tenants x) AS tenants,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.tenant_id::text,x.auth_user_id),'')) FROM public.pool_platform_memberships x) AS memberships,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_pools x) AS pools,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_seasons x) AS seasons,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_entries x) AS entries,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_weeks x) AS weeks,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_submissions x) AS submissions,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id),'')) FROM public.pool_platform_submission_audit x) AS audit,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_entry_invites x) AS invites,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY to_jsonb(x)::text),'')) FROM pool_platform_private.auth_issuer x) AS auth_issuer;
\echo '== totals and the identity map =='
SELECT
 (SELECT count(*) FROM public.pool_platform_tenants)+(SELECT count(*) FROM public.pool_platform_memberships)
 +(SELECT count(*) FROM public.pool_platform_pools)+(SELECT count(*) FROM public.pool_platform_seasons)
 +(SELECT count(*) FROM public.pool_platform_entries)+(SELECT count(*) FROM public.pool_platform_weeks)
 +(SELECT count(*) FROM public.pool_platform_submissions)+(SELECT count(*) FROM public.pool_platform_submission_audit)
 +(SELECT count(*) FROM public.pool_platform_entry_invites)+(SELECT count(*) FROM pool_platform_private.auth_issuer) AS application_rows,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(u.id::text||'|'||lower(u.email)||'|'||u."emailVerified"::text||'|'||COALESCE(u.banned,false)::text,';' ORDER BY u.id::text),'')) FROM neon_auth."user" u) AS identities,
 (SELECT count(*) FROM neon_auth."user" u WHERE NOT EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id)) AS identities_the_app_accepts,
 (SELECT count(*) FROM public.pool_platform_memberships m WHERE NOT EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text=m.auth_user_id)) AS memberships_without_identity,
 (SELECT count(*) FROM public.pool_platform_entries e WHERE e.owner_auth_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text=e.owner_auth_user_id)) AS claimed_entries_without_identity,
 (SELECT count(*) FROM public.pool_platform_entries WHERE owner_auth_user_id IS NOT NULL) AS claimed_entries;
\echo '== invitations and release state =='
SELECT
 (SELECT count(*) FROM public.pool_platform_entry_invites i
    JOIN public.pool_platform_entries e ON e.id=i.entry_id JOIN public.pool_platform_seasons s ON s.id=e.season_id
    JOIN public.pool_platform_pools p ON p.id=s.pool_id JOIN public.pool_platform_tenants t ON t.id=p.tenant_id
    WHERE i.claimed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND e.owner_auth_user_id IS NULL
      AND e.status='active' AND s.status IN ('setup','active') AND p.status='active' AND t.status='active') AS outstanding_legacy_invitations,
 to_regclass('public.pool_platform_week_result_revisions') IS NOT NULL AS release_schema_installed,
 has_function_privilege('authenticated','public.pool_platform_claim_entry_invite(text)','EXECUTE') AS legacy_invitations_callable,
 (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'pool\_platform\_%') AS pool_platform_functions,
 (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'pool\_platform\_%' AND has_function_privilege('anonymous',p.oid,'EXECUTE')) AS functions_callable_without_sign_in,
 (SELECT issuer FROM pool_platform_private.auth_issuer) AS issuer;
COMMIT;
