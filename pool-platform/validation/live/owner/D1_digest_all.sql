SELECT
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_tenants x) AS tenants,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.tenant_id::text,x.auth_user_id),'')) FROM public.pool_platform_memberships x) AS memberships,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_pools x) AS pools,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_seasons x) AS seasons,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_entries x) AS entries,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_weeks x) AS weeks,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_submissions x) AS submissions,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id),'')) FROM public.pool_platform_submission_audit x) AS audit,
 (SELECT count(*)||':'||md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id::text),'')) FROM public.pool_platform_entry_invites x) AS invites
