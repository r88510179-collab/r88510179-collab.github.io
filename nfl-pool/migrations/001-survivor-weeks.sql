-- Pool Center Survivor/Suicide weekly snapshots.
-- Apply only after the matching application candidate is reviewed and approved.

CREATE TABLE IF NOT EXISTS public.nfl_survivor_weeks (
  season integer NOT NULL CHECK (season BETWEEN 2020 AND 2100),
  week integer NOT NULL CHECK (week BETWEEN 1 AND 22),
  status text NOT NULL CHECK (status IN ('draft','locked')),
  config jsonb NOT NULL,
  source_filename text,
  source_sha256 text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season,week)
);

ALTER TABLE public.nfl_survivor_weeks ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.nfl_survivor_weeks TO anonymous;
GRANT SELECT,INSERT,UPDATE ON public.nfl_survivor_weeks TO authenticated;

DROP POLICY IF EXISTS nfl_survivor_public_read_locked ON public.nfl_survivor_weeks;
CREATE POLICY nfl_survivor_public_read_locked ON public.nfl_survivor_weeks
  FOR SELECT TO anonymous
  USING (status='locked');

DROP POLICY IF EXISTS nfl_survivor_admin_read ON public.nfl_survivor_weeks;
CREATE POLICY nfl_survivor_admin_read ON public.nfl_survivor_weeks
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM neon_auth."user" u
    WHERE u.id::text=auth.user_id()
      AND lower(u.email)='djsmokke@gmail.com'
      AND u.role='admin'
      AND COALESCE(u.banned,false)=false
  ));

DROP POLICY IF EXISTS nfl_survivor_admin_insert ON public.nfl_survivor_weeks;
CREATE POLICY nfl_survivor_admin_insert ON public.nfl_survivor_weeks
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM neon_auth."user" u
    WHERE u.id::text=auth.user_id()
      AND lower(u.email)='djsmokke@gmail.com'
      AND u.role='admin'
      AND COALESCE(u.banned,false)=false
  ));

DROP POLICY IF EXISTS nfl_survivor_admin_update ON public.nfl_survivor_weeks;
CREATE POLICY nfl_survivor_admin_update ON public.nfl_survivor_weeks
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM neon_auth."user" u
    WHERE u.id::text=auth.user_id()
      AND lower(u.email)='djsmokke@gmail.com'
      AND u.role='admin'
      AND COALESCE(u.banned,false)=false
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM neon_auth."user" u
    WHERE u.id::text=auth.user_id()
      AND lower(u.email)='djsmokke@gmail.com'
      AND u.role='admin'
      AND COALESCE(u.banned,false)=false
  ));
