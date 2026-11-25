-- 000: the baseline of the Pick'em publication table, public.nfl_pool_weeks.
--
-- The table was created in the Personal Neon database by hand, before the repository kept migrations, and every later
-- migration depends on it (004 and 005 read it, 20261108 adds a constraint to it, the backup and the SQL gate expect
-- it). Until this file the only record of its shape was an emulation in sql-tests/neon-shape.sql, copied from a
-- read-only look at production. With this file an empty database can be rebuilt from the repository alone, in this
-- order: 000, 001, 002, 003, 004, 005, 20261108. sql-tests/rebuild.sh does that on a disposable database and shows the
-- result is the very schema the emulation describes.
--
-- Safe by construction where the table already exists: it then does nothing at all, not even a grant, so a database
-- that has the table (production) is never touched. It never alters, and it never drops. Do not apply it to
-- production: nothing needs it there, and applying a migration to production is the owner's decision.
--
-- Apply as the database owner (nfl_pool_owner), like the others. Needs the roles anonymous and authenticated, the
-- schema neon_auth with its "user" table, and the function auth.user_id(), which Neon provides.
DO $baseline$
BEGIN
  IF to_regclass('public.nfl_pool_weeks') IS NOT NULL THEN
    RAISE NOTICE '000: public.nfl_pool_weeks already exists; nothing changed';
    RETURN;
  END IF;

  CREATE TABLE public.nfl_pool_weeks (
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
    PRIMARY KEY (season, week)
  );
  ALTER TABLE public.nfl_pool_weeks ENABLE ROW LEVEL SECURITY;
  GRANT SELECT ON public.nfl_pool_weeks TO anonymous;
  GRANT SELECT, INSERT, UPDATE ON public.nfl_pool_weeks TO authenticated;
  -- Anyone may read a locked week; only the commissioner (the one admin account) reads drafts or writes.
  CREATE POLICY nfl_pool_public_read_locked ON public.nfl_pool_weeks FOR SELECT TO anonymous USING (status = 'locked');
  CREATE POLICY nfl_pool_admin_read ON public.nfl_pool_weeks FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text = auth.user_id() AND lower(u.email) = 'djsmokke@gmail.com'
      AND u.role = 'admin' AND COALESCE(u.banned, false) = false));
  CREATE POLICY nfl_pool_admin_insert ON public.nfl_pool_weeks FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text = auth.user_id() AND lower(u.email) = 'djsmokke@gmail.com'
      AND u.role = 'admin' AND COALESCE(u.banned, false) = false));
  CREATE POLICY nfl_pool_admin_update ON public.nfl_pool_weeks FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text = auth.user_id() AND lower(u.email) = 'djsmokke@gmail.com'
      AND u.role = 'admin' AND COALESCE(u.banned, false) = false))
    WITH CHECK (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text = auth.user_id() AND lower(u.email) = 'djsmokke@gmail.com'
      AND u.role = 'admin' AND COALESCE(u.banned, false) = false));
END
$baseline$;
