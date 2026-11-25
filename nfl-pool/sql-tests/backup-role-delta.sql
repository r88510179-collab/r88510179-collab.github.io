-- What the live Personal database holds beyond the migrations: the scoped backup role's access. For the disposable
-- nfl_pool_prod_shape database that rebuild.sh builds, never for any other: it refuses to run anywhere else.
--
-- It restates, for comparison only, three guarded files of the dashboard repository that were applied by hand to the real
-- database (ops/personal-backup-rls-policy-20261106.sql, the role's SELECT on exactly five tables, and
-- ops/personal-backup-sequence-grant-20261112.sql). The role itself is a cluster object and is made by the caller.
-- Run as nfl_pool_owner, who owns the tables.
DO $delta$
DECLARE t text;
BEGIN
  IF current_database() <> 'nfl_pool_prod_shape' THEN
    RAISE EXCEPTION 'backup-role-delta.sql is only for the disposable nfl_pool_prod_shape database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smokke_personal_cloud_backup_ro' AND rolcanlogin
                 AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole) THEN
    RAISE EXCEPTION 'the backup role is missing or has more than it should';
  END IF;
  FOR t IN SELECT unnest(ARRAY['nfl_contest_policies','nfl_contests','nfl_incident_rulings','nfl_pool_weeks','nfl_survivor_weeks']) LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO smokke_personal_cloud_backup_ro',t);
    EXECUTE format('CREATE POLICY smokke_personal_cloud_backup_read ON public.%I AS PERMISSIVE FOR SELECT TO smokke_personal_cloud_backup_ro USING (true)',t);
  END LOOP;
  GRANT SELECT ON SEQUENCE public.nfl_incident_rulings_ruling_id_seq TO smokke_personal_cloud_backup_ro;
END
$delta$;
