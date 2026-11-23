\set ON_ERROR_STOP on
-- Disposable PostgreSQL ONLY (GitHub Actions service or a local throwaway
-- cluster). NEVER run against Neon staging, a QA branch or production: it
-- creates tables and replaces the identity function with a test stand-in.
--
-- Base tables: column names, types, defaults and CHECK/UNIQUE constraints as
-- read from information_schema and pg_constraint on the isolated QA branch
-- the QA branch on 2026-11-12 (the base DDL is not in this repo).
-- Row-level policies and the neon_auth schema are not reproduced: every
-- browser path under test goes through SECURITY DEFINER RPCs.
-- pool_platform_is_tenant_commissioner and pool_platform_commissioner_context
-- are the bodies read from pg_get_functiondef on the same branch.
-- pool_platform_current_user_id is a STAND-IN: the real one derives the
-- subject from a verified Neon Auth JWT; this one reads test.uid, which only
-- the test Data API stand-in (e2e-server.mjs) sets.
-- pool_platform_can_read_pool and pool_platform_participant_context, the
-- participant page's read path, are the deployed bodies as well
-- (fixtures/deployed/qa-participant-read-20261112.sql).
-- Pass -v hardening=0 to leave out 20261112_final_attestation_hardening.sql,
-- and -v season=0 to leave out 20261112_season_standings_snapshot.sql (a
-- backend that does not have the season read yet).
\if :{?hardening}
\else
\set hardening 1
\endif
\if :{?season}
\else
\set season 1
\endif
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
END;
$role$;

CREATE TABLE public.pool_platform_tenants(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.pool_platform_memberships(
  tenant_id uuid NOT NULL REFERENCES public.pool_platform_tenants(id) ON DELETE CASCADE,
  auth_user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','commissioner','co_commissioner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,auth_user_id)
);
CREATE TABLE public.pool_platform_pools(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.pool_platform_tenants(id) ON DELETE CASCADE,
  slug text NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  sport text NOT NULL DEFAULT 'football' CHECK (sport='football'),
  pool_type text NOT NULL CHECK (pool_type IN ('pickem','survivor')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,slug)
);
CREATE UNIQUE INDEX pool_platform_pools_global_slug_idx ON public.pool_platform_pools(slug);
CREATE TABLE public.pool_platform_seasons(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES public.pool_platform_pools(id) ON DELETE CASCADE,
  season integer NOT NULL CHECK (season BETWEEN 2020 AND 2100),
  status text NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','active','complete','archived')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id,season)
);
CREATE TABLE public.pool_platform_weeks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES public.pool_platform_seasons(id) ON DELETE CASCADE,
  week integer NOT NULL CHECK (week BETWEEN 1 AND 25),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','locked','final')),
  opens_at timestamptz,
  deadline_at timestamptz NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id,week),
  CHECK (opens_at IS NULL OR opens_at<deadline_at)
);
CREATE TABLE public.pool_platform_entries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES public.pool_platform_seasons(id) ON DELETE CASCADE,
  entry_code text NOT NULL CHECK (length(entry_code) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  owner_auth_user_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','eliminated','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id,entry_code)
);
CREATE TABLE public.pool_platform_submissions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id uuid NOT NULL REFERENCES public.pool_platform_weeks(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.pool_platform_entries(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('participant','commissioner_import','commissioner_manual')),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','locked')),
  submitted_by_auth_user_id text,
  payload jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_id,entry_id)
);
-- e2e-server.mjs refuses to serve any database that lacks this marker.
CREATE TABLE public.e2e_disposable_marker(purpose text PRIMARY KEY);
INSERT INTO public.e2e_disposable_marker VALUES ('disposable-e2e-only');
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

CREATE FUNCTION public.pool_platform_current_user_id()
RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('test.uid',true),'') $$;

CREATE FUNCTION public.pool_platform_is_tenant_commissioner(p_tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.pool_platform_memberships m
    WHERE m.tenant_id=p_tenant_id
      AND m.auth_user_id=public.pool_platform_current_user_id()
      AND m.role IN ('owner','commissioner','co_commissioner')
  )
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_is_tenant_commissioner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_is_tenant_commissioner(uuid) TO authenticated;

CREATE FUNCTION public.pool_platform_commissioner_context(p_pool_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid text:=public.pool_platform_current_user_id();
  v_pool public.pool_platform_pools%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;

  SELECT * INTO v_pool
  FROM public.pool_platform_pools
  WHERE slug=p_pool_slug AND status<>'archived'
  ORDER BY created_at DESC LIMIT 1;

  IF v_pool.id IS NULL OR NOT public.pool_platform_is_tenant_commissioner(v_pool.tenant_id)
  THEN RAISE EXCEPTION 'commissioner_required'; END IF;

  RETURN jsonb_build_object(
    'pool',jsonb_build_object(
      'id',v_pool.id,'tenant_id',v_pool.tenant_id,'slug',v_pool.slug,
      'display_name',v_pool.display_name,'pool_type',v_pool.pool_type,
      'rules',v_pool.rules,'branding',v_pool.branding
    ),
    'seasons',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',s.id,'season',s.season,'status',s.status,'config',s.config,
        'entries',COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id',e.id,'entry_code',e.entry_code,'display_name',e.display_name,
            'status',e.status,'claimed',e.owner_auth_user_id IS NOT NULL,
            'submissions',COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'week',sw.week,'source',ss.source,'status',ss.status,
                'revision',ss.revision,'submitted_at',ss.submitted_at
              ) ORDER BY sw.week)
              FROM public.pool_platform_submissions ss
              JOIN public.pool_platform_weeks sw ON sw.id=ss.week_id
              WHERE ss.entry_id=e.id
            ),'[]'::jsonb)
          ) ORDER BY e.entry_code)
          FROM public.pool_platform_entries e WHERE e.season_id=s.id
        ),'[]'::jsonb),
        'weeks',COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id',w.id,'week',w.week,'status',w.status,
            'opens_at',w.opens_at,'deadline_at',w.deadline_at,'config',w.config
          ) ORDER BY w.week)
          FROM public.pool_platform_weeks w WHERE w.season_id=s.id
        ),'[]'::jsonb)
      ) ORDER BY s.season DESC)
      FROM public.pool_platform_seasons s WHERE s.pool_id=v_pool.id
    ),'[]'::jsonb)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.pool_platform_commissioner_context(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pool_platform_commissioner_context(text) TO authenticated;

-- The reviewed migrations themselves, unmodified, in the order they apply.
\ir ../../migrations/20261103_commissioner_pool_discovery.sql
\ir ../../migrations/20261106_pool_week_projection_snapshot.sql
\ir ../../migrations/20261111_week_final_attestations.sql
\ir ../../migrations/20261111_attestation_evidence.sql
\if :hardening
\ir ../../migrations/20261112_final_attestation_hardening.sql
\endif
\ir ../../migrations/20261103_participant_pool_discovery.sql
\ir ../fixtures/deployed/qa-participant-read-20261112.sql
\if :season
\ir ../../migrations/20261112_season_standings_snapshot.sql
\endif

-- Two synthetic tenants. Every time is relative to now(), so the fixture
-- never goes stale: w9 locked, w10 open before its deadline, w11 open past
-- its deadline, w12 locked with one game not yet kicked off, w13 final with a
-- full 16-game slate.
CREATE FUNCTION pg_temp.e2e_time(p interval) RETURNS text LANGUAGE sql AS
$$ SELECT to_char((now()+p) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"') $$;
CREATE FUNCTION pg_temp.e2e_game(p_week int,p_away text,p_home text,p_kick interval) RETURNS jsonb LANGUAGE sql AS
$$ SELECT jsonb_build_object('id',format('2026_%s_%s_%s',lpad(p_week::text,2,'0'),p_away,p_home),
     'away',jsonb_build_object('key',p_away,'city','Synthetic','name',p_away||' Away'),
     'home',jsonb_build_object('key',p_home,'city','Synthetic','name',p_home||' Home'),
     'kickoff',pg_temp.e2e_time(p_kick)) $$;

INSERT INTO public.pool_platform_tenants(id,slug,display_name) VALUES
 ('a0000000-0000-4000-8000-000000000001','e2e-alpha','E2E Alpha'),
 ('a0000000-0000-4000-8000-000000000002','e2e-beta','E2E Beta');
INSERT INTO public.pool_platform_memberships(tenant_id,auth_user_id,role) VALUES
 ('a0000000-0000-4000-8000-000000000001','commish_alpha','commissioner'),
 ('a0000000-0000-4000-8000-000000000001','cocommish_alpha','co_commissioner'),
 ('a0000000-0000-4000-8000-000000000002','commish_beta','owner');
INSERT INTO public.pool_platform_pools(id,tenant_id,slug,display_name,pool_type) VALUES
 ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','e2e-alpha-pickem','E2E Alpha Pickem','pickem'),
 ('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002','e2e-beta-survivor','E2E Beta Survivor','survivor');
INSERT INTO public.pool_platform_seasons(id,pool_id,season,status) VALUES
 ('c0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',2026,'active'),
 ('c0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000002',2026,'active');
INSERT INTO public.pool_platform_weeks(id,season_id,week,status,deadline_at,config) VALUES
 ('d0000000-0000-4000-8000-000000000009','c0000000-0000-4000-8000-000000000001',9,'locked',now()-interval '3 days',
  jsonb_build_object('games',jsonb_build_array(
    pg_temp.e2e_game(9,'JAX','BAL','-2 days'),pg_temp.e2e_game(9,'CIN','ATL','-2 days')))),
 ('d0000000-0000-4000-8000-000000000010','c0000000-0000-4000-8000-000000000001',10,'open',now()+interval '7 days',
  jsonb_build_object('games',jsonb_build_array(
    pg_temp.e2e_game(10,'BUF','MIA','8 days'),pg_temp.e2e_game(10,'DAL','NYG','8 days')))),
 ('d0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000001',11,'open',now()-interval '2 days',
  jsonb_build_object('games',jsonb_build_array(
    pg_temp.e2e_game(11,'DEN','CAR','-1 day'),pg_temp.e2e_game(11,'DET','CHI','-1 day')))),
 ('d0000000-0000-4000-8000-000000000012','c0000000-0000-4000-8000-000000000001',12,'locked',now()-interval '1 day',
  jsonb_build_object('games',jsonb_build_array(
    pg_temp.e2e_game(12,'GB','NE','-20 hours'),pg_temp.e2e_game(12,'HOU','LAC','2 days')))),
 ('d0000000-0000-4000-8000-000000000013','c0000000-0000-4000-8000-000000000001',13,'final',now()-interval '5 days',
  jsonb_build_object('games',(SELECT jsonb_agg(pg_temp.e2e_game(13,g.away,g.home,'-4 days') ORDER BY g.n)
    FROM (VALUES (1,'ARI','ATL'),(2,'BAL','BUF'),(3,'CAR','CHI'),(4,'CIN','CLE'),(5,'DAL','DEN'),
      (6,'DET','GB'),(7,'HOU','IND'),(8,'JAX','KC'),(9,'LAC','LAR'),(10,'LV','MIA'),(11,'MIN','NE'),
      (12,'NO','NYG'),(13,'NYJ','PHI'),(14,'PIT','SEA'),(15,'SF','TB'),(16,'TEN','WAS')) AS g(n,away,home)))),
 ('d0000000-0000-4000-8000-000000000109','c0000000-0000-4000-8000-000000000002',9,'locked',now()-interval '3 days',
  jsonb_build_object('games',jsonb_build_array(
    pg_temp.e2e_game(9,'KC','LV','-2 days'),pg_temp.e2e_game(9,'SEA','SF','-2 days'))));
INSERT INTO public.pool_platform_entries(id,season_id,entry_code,display_name,owner_auth_user_id) VALUES
 ('e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','A1','SYNTHETIC Alice','alice'),
 ('e0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001','A2','SYNTHETIC Bob','bob'),
 ('e0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000001','A3','SYNTHETIC Unclaimed',NULL),
 ('e0000000-0000-4000-8000-000000000101','c0000000-0000-4000-8000-000000000002','B1','SYNTHETIC Carol','carol');
INSERT INTO public.pool_platform_submissions(id,week_id,entry_id,source,submitted_by_auth_user_id,payload) VALUES
 ('f0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000009','e0000000-0000-4000-8000-000000000001',
  'participant','alice','{"picks":{"2026_09_JAX_BAL":"away","2026_09_CIN_ATL":"home"}}'),
 ('f0000000-0000-4000-8000-000000000002','d0000000-0000-4000-8000-000000000009','e0000000-0000-4000-8000-000000000002',
  'participant','bob','{"picks":{"2026_09_JAX_BAL":"home","2026_09_CIN_ATL":"home"}}'),
 ('f0000000-0000-4000-8000-000000000101','d0000000-0000-4000-8000-000000000109','e0000000-0000-4000-8000-000000000101',
  'participant','carol','{"team":"KC"}');
\echo E2E_FINAL_RESULTS_FIXTURE_READY
