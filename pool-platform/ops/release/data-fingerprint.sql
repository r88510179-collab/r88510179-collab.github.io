-- Called inside a release transaction. Blocks writes to the ten tables that held application rows before this
-- release (reads go on), then records one count and fingerprint for each. verify-data-unchanged.sql compares them
-- again before COMMIT, so a release script that changed, added or removed any of those rows rolls itself back.
-- The lock waits at most the lock_timeout verify-target.sql set, and is released with the transaction.
LOCK TABLE public.pool_platform_tenants,public.pool_platform_memberships,public.pool_platform_pools,
  public.pool_platform_seasons,public.pool_platform_entries,public.pool_platform_weeks,
  public.pool_platform_submissions,public.pool_platform_submission_audit,public.pool_platform_entry_invites,
  pool_platform_private.auth_issuer IN SHARE MODE;
CREATE FUNCTION pg_temp.pool_release_fingerprint() RETURNS jsonb LANGUAGE sql STABLE AS $fingerprint$
  SELECT jsonb_build_object(
    'tenants',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_tenants x),
    'memberships',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.tenant_id::text,x.auth_user_id),'')) FROM public.pool_platform_memberships x),
    'pools',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_pools x),
    'seasons',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_seasons x),
    'entries',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_entries x),
    'weeks',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_weeks x),
    'submissions',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_submissions x),
    'audit',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id),'')) FROM public.pool_platform_submission_audit x),
    'invites',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_entry_invites x),
    'auth_issuer',(SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY to_jsonb(x)::text),'')) FROM pool_platform_private.auth_issuer x))
$fingerprint$;
CREATE TEMP TABLE pool_release_before ON COMMIT DROP AS SELECT pg_temp.pool_release_fingerprint() AS fingerprint;
