-- REVIEW-ONLY commercial V1 foundation.
-- Do not apply to the existing personal Pool Center production database without a separate review.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.pool_platform_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pool_platform_memberships (
  tenant_id uuid NOT NULL REFERENCES public.pool_platform_tenants(id) ON DELETE CASCADE,
  auth_user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','commissioner','co_commissioner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,auth_user_id)
);

CREATE TABLE IF NOT EXISTS public.pool_platform_pools (
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

CREATE TABLE IF NOT EXISTS public.pool_platform_seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES public.pool_platform_pools(id) ON DELETE CASCADE,
  season integer NOT NULL CHECK (season BETWEEN 2020 AND 2100),
  status text NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','active','complete','archived')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id,season)
);

CREATE TABLE IF NOT EXISTS public.pool_platform_entries (
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

CREATE TABLE IF NOT EXISTS public.pool_platform_weeks (
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
  CHECK (opens_at IS NULL OR opens_at < deadline_at)
);

CREATE TABLE IF NOT EXISTS public.pool_platform_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id uuid NOT NULL REFERENCES public.pool_platform_weeks(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.pool_platform_entries(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('participant','commissioner_import','commissioner_manual')),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','locked')),
  submitted_by_auth_user_id text,
  payload jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_id,entry_id)
);

CREATE TABLE IF NOT EXISTS public.pool_platform_submission_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES public.pool_platform_submissions(id) ON DELETE CASCADE,
  actor_auth_user_id text,
  action text NOT NULL CHECK (action IN ('created','updated','locked','correction')),
  source text NOT NULL CHECK (source IN ('participant','commissioner_import','commissioner_manual','system')),
  previous_payload jsonb,
  next_payload jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.pool_platform_guard_submission_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.source<>OLD.source THEN
    RAISE EXCEPTION 'submission source is immutable once claimed';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='locked' THEN
    RAISE EXCEPTION 'locked submission cannot be modified';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pool_platform_submission_source_guard ON public.pool_platform_submissions;
CREATE TRIGGER pool_platform_submission_source_guard
BEFORE UPDATE ON public.pool_platform_submissions
FOR EACH ROW EXECUTE FUNCTION public.pool_platform_guard_submission_source();

ALTER TABLE public.pool_platform_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pool_platform_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pool_platform_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pool_platform_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pool_platform_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pool_platform_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pool_platform_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pool_platform_submission_audit ENABLE ROW LEVEL SECURITY;

-- Policies intentionally deferred to a separate auth/RLS review.
-- This migration must not be deployed until tenant membership and participant identity
-- policies have been independently reviewed against the chosen production auth model.
