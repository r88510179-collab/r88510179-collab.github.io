-- Rollback of migration 006 (Pool Alerts). Removes the capture trigger, its function, the private pool_alerts schema
-- (outbox, subscriptions, diagnostics) and the sender role. Publishing and every public table are untouched.
--
-- Use only with the owner's approval, as nfl_pool_owner, after a fresh Neon branch/snapshot backup (the subscriptions
-- are deleted with the schema; devices re-enroll by themselves the next time Pool Center opens, once alerts are
-- reinstated). First pause sending and stop the sender (disable its Function Trigger), so nothing connects while this
-- runs. Exercised by nfl-pool/sql-tests/run.sh (rollback, publish, re-apply).
BEGIN;
DO $pre$
BEGIN
  IF current_user <> 'nfl_pool_owner' THEN
    RAISE EXCEPTION 'the Pool Alerts rollback must be applied as nfl_pool_owner, not %', current_user;
  END IF;
END
$pre$;
DROP TRIGGER IF EXISTS nfl_pool_alerts_capture ON public.nfl_pool_weeks;
DROP FUNCTION IF EXISTS public.nfl_pool_alerts_capture();
DROP SCHEMA IF EXISTS pool_alerts CASCADE;
DO $role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pool_alerts_sender') THEN
    EXECUTE 'DROP ROLE pool_alerts_sender';
  END IF;
END
$role$;
COMMIT;
