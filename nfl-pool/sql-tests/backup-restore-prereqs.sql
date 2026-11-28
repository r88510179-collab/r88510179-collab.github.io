-- Personal Pool restore PROOF only. Run in a DISPOSABLE PostgreSQL database, never in Neon
-- production and never in Commercial V1/CRM.
--
-- The backup archive holds the `public` schema only. Its row-level-security policies name
-- three roles and refer to two objects that live outside `public` in production (the Neon
-- Auth user table and auth.user_id() from the pg_session_jwt extension). Without these names
-- the tables and rows still restore, but every policy fails to restore ("role ... does not
-- exist"), leaving the restored copy with row security on and no policies.
--
-- The owner role allows pg_restore to preserve application object ownership and grants.
-- The stand-ins contain no data or credentials.
DO $restore_prereqs$
BEGIN
  IF current_database() = 'nfl_pool' THEN
    RAISE EXCEPTION 'Refusing to run in a database named nfl_pool; use a disposable database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nfl_pool_owner') THEN
    CREATE ROLE nfl_pool_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anonymous') THEN
    CREATE ROLE anonymous NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smokke_personal_cloud_backup_ro') THEN
    CREATE ROLE smokke_personal_cloud_backup_ro NOLOGIN;
  END IF;
END
$restore_prereqs$;
CREATE SCHEMA neon_auth;
CREATE TABLE neon_auth."user" (id uuid, email text, role text, banned boolean);
CREATE SCHEMA auth;
CREATE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE AS 'SELECT NULL::text';
