INSERT INTO public.pool_platform_memberships(tenant_id,auth_user_id,role)
SELECT t.id,u.id::text,v.role
FROM (VALUES ('local-demo-group','pp-cv1-r1-a.commissioner@example.com','commissioner'),
             ('local-demo-group','pp-cv1-r1-b.cocommissioner@example.com','co_commissioner'),
             ('second-demo-group','pp-cv1-r1-c.tenantb.commissioner@example.com','commissioner')) v(slug,email,role)
JOIN public.pool_platform_tenants t ON t.slug=v.slug
JOIN neon_auth."user" u ON lower(u.email)=v.email;
