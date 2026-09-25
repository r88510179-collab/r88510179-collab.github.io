SELECT
 (SELECT md5(string_agg(t.slug||'|'||t.display_name||'|'||t.status,';' ORDER BY t.slug COLLATE "C")) FROM public.pool_platform_tenants t) AS tenants_md5,
 (SELECT md5(string_agg(t.slug||'|'||p.slug||'|'||p.display_name||'|'||p.pool_type||'|'||p.status||'|'||p.rules::text||'|'||p.branding::text,';' ORDER BY p.slug COLLATE "C")) FROM public.pool_platform_pools p JOIN public.pool_platform_tenants t ON t.id=p.tenant_id) AS pools_md5,
 (SELECT md5(string_agg(p.slug||'|'||s.season||'|'||s.status||'|'||s.config::text,';' ORDER BY p.slug COLLATE "C")) FROM public.pool_platform_seasons s JOIN public.pool_platform_pools p ON p.id=s.pool_id) AS seasons_md5,
 (SELECT md5(string_agg(p.slug||'|'||w.week||'|'||w.status||'|'||COALESCE(extract(epoch FROM w.opens_at)::bigint::text,'-')||'|'||extract(epoch FROM w.deadline_at)::bigint||'|'||w.config::text,';' ORDER BY p.slug COLLATE "C",w.week)) FROM public.pool_platform_weeks w JOIN public.pool_platform_seasons s ON s.id=w.season_id JOIN public.pool_platform_pools p ON p.id=s.pool_id) AS weeks_md5,
 (SELECT md5(string_agg(p.slug||'|'||e.entry_code||'|'||e.display_name||'|'||e.status||'|'||COALESCE(e.owner_auth_user_id,'-'),';' ORDER BY p.slug COLLATE "C",e.entry_code COLLATE "C")) FROM public.pool_platform_entries e JOIN public.pool_platform_seasons s ON s.id=e.season_id JOIN public.pool_platform_pools p ON p.id=s.pool_id) AS entries_md5,
 (SELECT count(*) FROM public.pool_platform_weeks) AS weeks,
 (SELECT count(*) FROM public.pool_platform_entries) AS entries
