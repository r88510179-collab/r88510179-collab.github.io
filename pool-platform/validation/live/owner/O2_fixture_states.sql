UPDATE public.pool_platform_entry_invites i SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day'
FROM public.pool_platform_entries e WHERE e.id=i.entry_id AND e.entry_code='PK-INV-EXP' AND i.claimed_at IS NULL;
UPDATE public.pool_platform_entry_invites i SET revoked_at=now()
FROM public.pool_platform_entries e WHERE e.id=i.entry_id AND e.entry_code='PK-INV-REV' AND i.claimed_at IS NULL;
UPDATE public.pool_platform_submissions s SET status='locked'
FROM public.pool_platform_entries e,public.pool_platform_weeks w,public.pool_platform_seasons se,public.pool_platform_pools p
WHERE e.id=s.entry_id AND w.id=s.week_id AND se.id=w.season_id AND p.id=se.pool_id
  AND p.slug='neighborhood-pickem' AND w.week=7 AND e.entry_code IN ('PK-LOCK-P','PK-LOCK-C');
INSERT INTO public.pool_platform_weeks(season_id,week,status,deadline_at,config)
SELECT s.id,5,'open',now()+interval '180 seconds',w.config
FROM public.pool_platform_seasons s JOIN public.pool_platform_pools p ON p.id=s.pool_id
JOIN public.pool_platform_weeks w ON w.season_id=s.id AND w.week=7
WHERE p.slug='neighborhood-pickem';
