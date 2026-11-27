-- Rollback of migration 007 (Pool Alerts device checks). Removes the device-check records and the two subscription
-- columns 007 added, and nothing else: the catalog is then exactly what migration 006 alone installs
-- (nfl-pool/sql-tests/run.sh proves it with nfl-pool/push/fingerprint.sql). Devices, alerts and publishing are untouched.
-- Use only with the owner's approval, as nfl_pool_owner, after a Neon branch backup. (006-pool-alerts-rollback.sql
-- removes everything, 007 included.)
BEGIN;
DO $pre$
BEGIN
  IF current_user <> 'nfl_pool_owner' THEN
    RAISE EXCEPTION 'the device-check rollback must be applied as nfl_pool_owner, not %', current_user;
  END IF;
  IF to_regclass('pool_alerts.device_checks') IS NULL THEN
    RAISE EXCEPTION 'migration 007 (pool alerts device checks) is not applied';
  END IF;
END
$pre$;
DROP TABLE pool_alerts.device_checks;
ALTER TABLE pool_alerts.subscriptions DROP COLUMN check_requested_at, DROP COLUMN platform;
COMMIT;
