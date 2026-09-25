INSERT INTO public.pool_platform_tenants(slug,display_name) VALUES ('local-demo-group','Local Demo Group'),('second-demo-group','Second Demo Group');
INSERT INTO public.pool_platform_pools(tenant_id,slug,display_name,pool_type,branding)
SELECT t.id,v.slug,v.name,v.ptype,'{"synthetic_fixture":true,"fixture_set":"cv1-live-validation"}'::jsonb
FROM (VALUES ('local-demo-group','neighborhood-pickem','Neighborhood Pick''em','pickem'),
             ('local-demo-group','neighborhood-survivor','Neighborhood Survivor','survivor'),
             ('second-demo-group','second-demo-pickem','Second Demo Pick''em','pickem')) v(tslug,slug,name,ptype)
JOIN public.pool_platform_tenants t ON t.slug=v.tslug;
INSERT INTO public.pool_platform_seasons(pool_id,season,status,config)
SELECT p.id,2027,'active','{"synthetic_fixture":true,"fixture_set":"cv1-live-validation","note":"Synthetic validation data only; no real participants, entries or picks."}'::jsonb
FROM public.pool_platform_pools p WHERE p.slug IN ('neighborhood-pickem','neighborhood-survivor','second-demo-pickem');
WITH g AS (SELECT '[{"id":"g1","away":{"key":"NYG","label":"New York"},"home":{"key":"DAL","label":"Dallas"}},{"id":"g2","away":{"key":"NYJ","label":"New York"},"home":{"key":"BUF","label":"Buffalo"}},{"id":"g3","away":{"key":"PHI","label":"Philadelphia"},"home":{"key":"WAS","label":"Washington"}},{"id":"g4","away":{"key":"KC","label":"Kansas City"},"home":{"key":"DEN","label":"Denver"}},{"id":"g5","away":{"key":"SF","label":"San Francisco"},"home":{"key":"SEA","label":"Seattle"}}]'::jsonb AS games),
v(slug,week,status,opens_at,deadline_at,kind) AS (
  VALUES ('neighborhood-pickem',1,'open',NULL::timestamptz,'2026-09-01T17:00:00Z'::timestamptz,'pk_tb'),
         ('neighborhood-pickem',2,'open','2027-08-01T00:00:00Z','2027-09-19T17:00:00Z','pk_tb'),
         ('neighborhood-pickem',3,'draft',NULL,'2027-09-26T17:00:00Z','pk_tb'),
         ('neighborhood-pickem',4,'locked',NULL,'2027-10-03T17:00:00Z','pk_tb'),
         ('neighborhood-pickem',6,'open',NULL,'2027-10-17T17:00:00Z','pk_notb'),
         ('neighborhood-survivor',1,'open',NULL,'2026-09-01T17:00:00Z','sv'),
         ('neighborhood-survivor',2,'open',NULL,'2027-09-19T17:00:00Z','sv_typed'),
         ('neighborhood-survivor',3,'open',NULL,'2027-09-26T17:00:00Z','sv_dup'),
         ('second-demo-pickem',1,'open',NULL,'2027-09-12T17:00:00Z','pk_tb'),
         ('second-demo-pickem',2,'open',NULL,'2027-09-19T17:00:00Z','pk_tb')
  UNION ALL SELECT 'neighborhood-pickem',n,'open',NULL,'2027-10-24T17:00:00Z'::timestamptz+(n-7)*168*interval '1 hour','pk_tb' FROM generate_series(7,14) n
  UNION ALL SELECT 'neighborhood-survivor',n,'open',NULL,'2027-10-03T17:00:00Z'::timestamptz+(n-4)*168*interval '1 hour','sv' FROM generate_series(4,12) n
)
INSERT INTO public.pool_platform_weeks(season_id,week,status,opens_at,deadline_at,config)
SELECT s.id,v.week,v.status,v.opens_at,v.deadline_at,
  CASE v.kind
    WHEN 'pk_tb' THEN jsonb_build_object('tiebreakRequired',true,'games',g.games)
    WHEN 'pk_notb' THEN jsonb_build_object('tiebreakRequired',false,'games',g.games)
    WHEN 'sv' THEN jsonb_build_object('games',g.games)
    WHEN 'sv_typed' THEN jsonb_build_object('games',g.games||'[{"id":"g6","away":{"key":"123","label":"Synthetic Typed 123"},"home":{"key":"true","label":"Synthetic Typed true"}}]'::jsonb)
    WHEN 'sv_dup' THEN jsonb_build_object('games',g.games||'[{"id":"g6","away":{"key":"NYG","label":"New York"},"home":{"key":"MIA","label":"Miami"}}]'::jsonb)
  END
FROM v CROSS JOIN g
JOIN public.pool_platform_pools p ON p.slug=v.slug
JOIN public.pool_platform_seasons s ON s.pool_id=p.id AND s.season=2027;
INSERT INTO public.pool_platform_entries(season_id,entry_code,display_name,status)
SELECT s.id,v.code,v.name,v.status
FROM (VALUES
  ('neighborhood-pickem','E1','Synthetic Entry E1','active'),
  ('neighborhood-pickem','e1','Synthetic Entry e1 (lowercase)','active'),
  ('neighborhood-pickem','E01','Synthetic Entry E01','active'),
  ('neighborhood-pickem','PK-D01','Synthetic Participant-1 Entry 01','active'),
  ('neighborhood-pickem','PK-D02','Synthetic Participant-1 Entry 02','active'),
  ('neighborhood-pickem','PK-D03','Synthetic Participant-1 Entry 03','active'),
  ('neighborhood-pickem','PK-E01','Synthetic Participant-2 Entry 01','active'),
  ('neighborhood-pickem','PK-H01','Synthetic Operator-Mailbox Entry 01','active'),
  ('neighborhood-pickem','PK-G01','Synthetic Unverified-User Entry 01','active'),
  ('neighborhood-pickem','PK-INV-UNB','Synthetic Unbound Invite Entry','active'),
  ('neighborhood-pickem','PK-INV-EXP','Synthetic Expired Invite Entry','active'),
  ('neighborhood-pickem','PK-INV-REV','Synthetic Revoked Invite Entry','active'),
  ('neighborhood-pickem','PK-INV-RACE1','Synthetic Invite Race Entry 1','active'),
  ('neighborhood-pickem','PK-INV-RACE2','Synthetic Invite Race Entry 2','active'),
  ('neighborhood-pickem','PK-INV-RACE3','Synthetic Invite Race Entry 3','active'),
  ('neighborhood-pickem','PK-INV-DUAL','Synthetic Dual-Invite Race Entry','active'),
  ('neighborhood-pickem','PK-RACE01','Synthetic Source Race Entry 01','active'),
  ('neighborhood-pickem','PK-RACE02','Synthetic Source Race Entry 02','active'),
  ('neighborhood-pickem','PK-RACE03','Synthetic Source Race Entry 03','active'),
  ('neighborhood-pickem','PK-RACE04','Synthetic Source Race Entry 04','active'),
  ('neighborhood-pickem','PK-RACE05','Synthetic Source Race Entry 05','active'),
  ('neighborhood-pickem','PK-RACE06','Synthetic Source Race Entry 06','active'),
  ('neighborhood-pickem','PK-INACTIVE','Synthetic Inactive Entry','inactive'),
  ('neighborhood-pickem','PK-ELIMINATED','Synthetic Eliminated Entry','eliminated'),
  ('neighborhood-pickem','PK-ARCHIVED','Synthetic Archived Entry','archived'),
  ('neighborhood-pickem','PK-LOCK-P','Synthetic Locked Participant-Row Entry','active'),
  ('neighborhood-pickem','PK-LOCK-C','Synthetic Locked Commissioner-Row Entry','active'),
  ('neighborhood-pickem','PK-DL','Synthetic Deadline Entry','active'),
  ('neighborhood-pickem','PK-PAY','Synthetic Payload Matrix Entry','active'),
  ('neighborhood-pickem','PK-MAN','Synthetic Commissioner-Manual Entry','active'),
  ('neighborhood-pickem','PK-BATCH01','Synthetic Batch Entry 01','active'),
  ('neighborhood-pickem','PK-BATCH02','Synthetic Batch Entry 02','active'),
  ('neighborhood-pickem','PK-BATCH03','Synthetic Batch Entry 03','active'),
  ('neighborhood-survivor','SV-D01','Synthetic Survivor Participant-1 Entry 01','active'),
  ('neighborhood-survivor','SV-D02','Synthetic Survivor Participant-1 Entry 02','active'),
  ('neighborhood-survivor','SV-D03','Synthetic Survivor Participant-1 Entry 03','active'),
  ('neighborhood-survivor','SV-E01','Synthetic Survivor Participant-2 Entry 01','active'),
  ('neighborhood-survivor','SV-RACE01','Synthetic Survivor Race Entry 01','active'),
  ('neighborhood-survivor','SV-RACE02','Synthetic Survivor Race Entry 02','active'),
  ('neighborhood-survivor','SV-RACE03','Synthetic Survivor Race Entry 03','active'),
  ('neighborhood-survivor','SV-RACE04','Synthetic Survivor Race Entry 04','active'),
  ('neighborhood-survivor','SV-DIFF01','Synthetic Survivor Different-Entry 01','active'),
  ('neighborhood-survivor','SV-DIFF02','Synthetic Survivor Different-Entry 02','active'),
  ('neighborhood-survivor','SV-TYPED01','Synthetic Survivor Typed-Team Entry 01','active'),
  ('neighborhood-survivor','SV-TYPED02','Synthetic Survivor Typed-Team Entry 02','active'),
  ('neighborhood-survivor','SV-ELIM','Synthetic Survivor Eliminated Entry','eliminated'),
  ('second-demo-pickem','B-01','Synthetic Second Group Entry 01','active'),
  ('second-demo-pickem','B-02','Synthetic Second Group Entry 02','active'),
  ('second-demo-pickem','B-03','Synthetic Second Group Entry 03','active')
) v(slug,code,name,status)
JOIN public.pool_platform_pools p ON p.slug=v.slug
JOIN public.pool_platform_seasons s ON s.pool_id=p.id AND s.season=2027;
