-- DISPOSABLE PostgreSQL ONLY, after production-replica-schema.sql. Synthetic rows shaped like the live Commercial
-- database as counted on 2026-11-18 (read-only): 267 rows in the ten application tables and 12 identities. No row is
-- copied from production; every address is under example.test.
--   tenants 2 · memberships 3 · pools 3 · seasons 3 · entries 49 (42 claimed) · weeks 28 · submissions 61 in 20 weeks
--   · submission audit 70 · invitations 47 (42 claimed, 1 revoked, 4 expired, none outstanding) · issuer 1
-- The pools, seasons, weeks and entries are the very statements that seeded production (validation/live/owner/
-- F1_fixtures.sql): every game is {id, away, home} and none has a kickoff. Week 5 of the Pick'em pool is the one
-- owner/O2_fixture_states.sql added, with the deadline it ended up with.
\set ON_ERROR_STOP on
DO $guard$
BEGIN
  IF current_database()<>'neondb' OR COALESCE(current_setting('neon.project_id',true),'') NOT IN ('','rehearsal-project')
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('cloud_admin','neon_superuser'))
    THEN RAISE EXCEPTION 'replica_data_requires_the_disposable_neondb'; END IF;
  IF EXISTS (SELECT 1 FROM public.pool_platform_tenants) THEN RAISE EXCEPTION 'replica_data_already_loaded'; END IF;
END
$guard$;

\ir ../../validation/live/owner/F1_fixtures.sql
INSERT INTO public.pool_platform_weeks(season_id,week,status,deadline_at,config)
SELECT w.season_id,5,'open','2026-09-25T14:33:05Z',w.config
FROM public.pool_platform_weeks w
JOIN public.pool_platform_seasons s ON s.id=w.season_id
JOIN public.pool_platform_pools p ON p.id=s.pool_id
WHERE p.slug='neighborhood-pickem' AND w.week=7;

-- Twelve identities. Five signed in with an emailed code and are verified; seven were made by the validation kit
-- with a password, so each has an account row and the hardened identity helpers refuse them.
INSERT INTO neon_auth."user"(id,name,email,"emailVerified") VALUES
 ('a0000000-0000-4000-8000-000000000001','Rehearsal Commissioner','commissioner@example.test',true),
 ('a0000000-0000-4000-8000-000000000002','Synthetic Co-Commissioner','cocommissioner@example.test',false),
 ('a0000000-0000-4000-8000-000000000003','Synthetic Second-Group Commissioner','tenantb.commissioner@example.test',false),
 ('a0000000-0000-4000-8000-000000000004','Rehearsal Participant One','participant.one@example.test',true),
 ('a0000000-0000-4000-8000-000000000005','Rehearsal Participant Two','participant.two@example.test',true),
 ('a0000000-0000-4000-8000-000000000006','Synthetic Outsider','outsider@example.test',false),
 ('a0000000-0000-4000-8000-000000000007','Synthetic Unverified','unverified@example.test',false),
 ('a0000000-0000-4000-8000-000000000008','Rehearsal Participant Three','participant.three@example.test',true),
 ('a0000000-0000-4000-8000-000000000009','Synthetic Diagnostic One','diag.one@example.test',false),
 ('a0000000-0000-4000-8000-000000000010','Synthetic Diagnostic Two','diag.two@example.test',false),
 ('a0000000-0000-4000-8000-000000000011','Rehearsal Newcomer','newcomer@example.test',true),
 ('a0000000-0000-4000-8000-000000000012','Synthetic Probe','probe@example.test',false);
INSERT INTO neon_auth.account("userId","providerId")
SELECT u.id,'credential' FROM neon_auth."user" u WHERE NOT u."emailVerified";

INSERT INTO public.pool_platform_memberships(tenant_id,auth_user_id,role)
SELECT t.id,v.uid,v.role
FROM (VALUES ('local-demo-group','a0000000-0000-4000-8000-000000000001','commissioner'),
             ('local-demo-group','a0000000-0000-4000-8000-000000000002','co_commissioner'),
             ('second-demo-group','a0000000-0000-4000-8000-000000000003','commissioner')) v(slug,uid,role)
JOIN public.pool_platform_tenants t ON t.slug=v.slug;

-- 42 of the 49 entries are claimed: 35 by participant one, 6 by participant two, 1 by participant three. The seven
-- entries the validation kit made for its invitation checks were never claimed.
WITH ranked AS (
  SELECT e.id,row_number() OVER (ORDER BY p.slug COLLATE "C",e.entry_code COLLATE "C") AS n
  FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id
  WHERE e.entry_code NOT LIKE 'PK-INV-%')
UPDATE public.pool_platform_entries e
SET owner_auth_user_id=CASE WHEN r.n<=35 THEN 'a0000000-0000-4000-8000-000000000004'
                            WHEN r.n<=41 THEN 'a0000000-0000-4000-8000-000000000005'
                            ELSE 'a0000000-0000-4000-8000-000000000008' END
FROM ranked r WHERE r.id=e.id;

-- 47 legacy invitations, all issued 2026-10-05 for a week: 42 claimed, 1 revoked and 4 long expired.
INSERT INTO public.pool_platform_entry_invites(entry_id,token_sha256,email_normalized,expires_at,
  claimed_by_auth_user_id,claimed_at,created_by_auth_user_id,created_at)
SELECT e.id,sha256(convert_to('rehearsal-claimed-'||e.id::text,'UTF8')),NULL,'2026-10-12T17:25:00Z',
  e.owner_auth_user_id,'2026-10-05T17:30:00Z','a0000000-0000-4000-8000-000000000001','2026-10-05T17:25:00Z'
FROM public.pool_platform_entries e WHERE e.owner_auth_user_id IS NOT NULL;
WITH unclaimed AS (
  SELECT e.id,row_number() OVER (ORDER BY e.entry_code COLLATE "C") AS n
  FROM public.pool_platform_entries e WHERE e.owner_auth_user_id IS NULL)
INSERT INTO public.pool_platform_entry_invites(entry_id,token_sha256,email_normalized,expires_at,revoked_at,
  created_by_auth_user_id,created_at)
SELECT u.id,sha256(convert_to('rehearsal-open-'||u.id::text,'UTF8')),
  CASE WHEN u.n<=4 THEN 'invited'||u.n||'@example.test' END,'2026-10-12T17:25:00Z',
  CASE WHEN u.n=5 THEN '2026-10-06T00:00:00Z'::timestamptz END,
  'a0000000-0000-4000-8000-000000000001','2026-10-05T17:25:00Z'
FROM unclaimed u WHERE u.n<=5;

-- 61 submissions in the same 20 weeks, with the same count in each, as production holds.
CREATE TEMP TABLE replica_week_load(slug text,week integer,submissions integer) ON COMMIT DROP;
INSERT INTO replica_week_load VALUES
 ('neighborhood-pickem',5,2),('neighborhood-pickem',6,1),('neighborhood-pickem',7,5),('neighborhood-pickem',8,7),
 ('neighborhood-pickem',9,9),('neighborhood-pickem',10,4),('neighborhood-pickem',12,1),('neighborhood-pickem',14,5),
 ('neighborhood-survivor',2,2),('neighborhood-survivor',3,1),('neighborhood-survivor',4,4),('neighborhood-survivor',5,4),
 ('neighborhood-survivor',6,4),('neighborhood-survivor',7,2),('neighborhood-survivor',8,2),('neighborhood-survivor',9,2),
 ('neighborhood-survivor',10,1),('neighborhood-survivor',11,1),('neighborhood-survivor',12,2),
 ('second-demo-pickem',1,2);
WITH pool_entries AS (
  SELECT p.slug,p.pool_type,e.id AS entry_id,count(*) OVER (PARTITION BY p.id) AS entries,
    row_number() OVER (PARTITION BY p.id ORDER BY e.entry_code COLLATE "C")-1 AS n
  FROM public.pool_platform_entries e
  JOIN public.pool_platform_seasons s ON s.id=e.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id),
picked AS (
  SELECT w.id AS week_id,w.week,w.config,pe.pool_type,pe.entry_id,k
  FROM replica_week_load l
  JOIN public.pool_platform_pools p ON p.slug=l.slug
  JOIN public.pool_platform_seasons s ON s.pool_id=p.id
  JOIN public.pool_platform_weeks w ON w.season_id=s.id AND w.week=l.week
  CROSS JOIN LATERAL generate_series(0,l.submissions-1) AS k
  JOIN pool_entries pe ON pe.slug=l.slug AND pe.n=(l.week*3+k)%pe.entries)
INSERT INTO public.pool_platform_submissions(week_id,entry_id,source,status,submitted_by_auth_user_id,payload,
  submitted_at,updated_at)
SELECT week_id,entry_id,CASE WHEN k%3=2 THEN 'commissioner_import' ELSE 'participant' END,'submitted',
  'a0000000-0000-4000-8000-000000000004',
  CASE WHEN pool_type='survivor'
    -- One team a week, taken in turn from the ten the fixture slate holds, so no entry repeats a team.
    THEN jsonb_build_object('team',(ARRAY['NYG','DAL','NYJ','BUF','PHI','WAS','KC','DEN','SF','SEA'])[(week-2)%10+1])
    ELSE jsonb_build_object('picks',(SELECT jsonb_object_agg(g->>'id',CASE WHEN (k+o)%2=0 THEN 'away' ELSE 'home' END)
                                      FROM jsonb_array_elements(config->'games') WITH ORDINALITY AS t(g,o)))
         ||CASE WHEN config->>'tiebreakRequired'='true' THEN jsonb_build_object('tiebreak',40+k) ELSE '{}'::jsonb END
  END,'2026-10-05T17:20:00Z','2026-10-05T17:23:00Z'
FROM picked;

-- 70 audit rows: one for each submission, and nine picks that were changed once.
INSERT INTO public.pool_platform_submission_audit(submission_id,actor_auth_user_id,action,source,previous_payload,
  next_payload,created_at)
SELECT s.id,s.submitted_by_auth_user_id,'created',s.source,NULL,s.payload,'2026-10-05T17:20:00Z'
FROM public.pool_platform_submissions s;
INSERT INTO public.pool_platform_submission_audit(submission_id,actor_auth_user_id,action,source,previous_payload,
  next_payload,created_at)
SELECT s.id,s.submitted_by_auth_user_id,'updated',s.source,s.payload,s.payload,'2026-10-05T17:23:00Z'
FROM public.pool_platform_submissions s ORDER BY s.id LIMIT 9;

-- The shape the rehearsal relies on, checked here so a change to this file cannot quietly make it another shape.
DO $shape$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tenants',(SELECT count(*) FROM public.pool_platform_tenants),
    'memberships',(SELECT count(*) FROM public.pool_platform_memberships),
    'pools',(SELECT count(*) FROM public.pool_platform_pools),
    'seasons',(SELECT count(*) FROM public.pool_platform_seasons),
    'entries',(SELECT count(*) FROM public.pool_platform_entries),
    'claimed_entries',(SELECT count(*) FROM public.pool_platform_entries WHERE owner_auth_user_id IS NOT NULL),
    'weeks',(SELECT count(*) FROM public.pool_platform_weeks),
    'games',(SELECT count(*) FROM public.pool_platform_weeks w,jsonb_array_elements(w.config->'games') g),
    'games_with_kickoff',(SELECT count(*) FROM public.pool_platform_weeks w,jsonb_array_elements(w.config->'games') g WHERE g ? 'kickoff'),
    'submissions',(SELECT count(*) FROM public.pool_platform_submissions),
    'weeks_with_submissions',(SELECT count(DISTINCT week_id) FROM public.pool_platform_submissions),
    'audit',(SELECT count(*) FROM public.pool_platform_submission_audit),
    'invites',(SELECT count(*) FROM public.pool_platform_entry_invites),
    'claimed_invites',(SELECT count(*) FROM public.pool_platform_entry_invites WHERE claimed_at IS NOT NULL),
    'outstanding_invites',(SELECT count(*) FROM public.pool_platform_entry_invites WHERE claimed_at IS NULL AND revoked_at IS NULL AND expires_at>now()),
    'issuer',(SELECT count(*) FROM pool_platform_private.auth_issuer),
    'identities',(SELECT count(*) FROM neon_auth."user"),
    'identities_with_account',(SELECT count(DISTINCT "userId") FROM neon_auth.account)) INTO v;
  IF v IS DISTINCT FROM '{"tenants":2,"memberships":3,"pools":3,"seasons":3,"entries":49,"claimed_entries":42,"weeks":28,
    "games":142,"games_with_kickoff":0,"submissions":61,"weeks_with_submissions":20,"audit":70,"invites":47,
    "claimed_invites":42,"outstanding_invites":0,"issuer":1,"identities":12,"identities_with_account":7}'::jsonb
    THEN RAISE EXCEPTION 'replica_data_shape_mismatch: %',v; END IF;
END
$shape$;
