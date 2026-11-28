-- Migration 007: Pool Alerts device checks, and the figures the Maintenance Center reads.
--
-- NOT APPLIED TO PRODUCTION BY THIS REPOSITORY. Apply only with the owner's production-migration approval, as
-- nfl_pool_owner, after migration 006 and a fresh Neon branch backup. Exercised by nfl-pool/sql-tests (pool-alerts.sql,
-- device-checks.sql, rollback) and nfl-pool/push/integration.spec.mjs.
--
-- What it adds (pool_alerts only; nothing in public, so the Personal backup and its restore are unchanged):
--  * subscriptions.platform: 'android', 'ios' or 'desktop', as the device's own browser reports it at enrollment (no
--    user agent, model or version is stored), so the owner can tell their phones apart in an acceptance check.
--  * subscriptions.check_requested_at: the device's own request to be checked by the owner ("Device check" on the Pool
--    Alerts card). A device appears in the owner's acceptance list for 24 hours after asking, and only then.
--  * device_checks: owner-run check alerts to ONE device (a test, a real week's release, an exact repeat, a correction),
--    each with the SHA-256 of a one-time value only that device can decrypt. The device's service worker sends the value
--    back when it shows the alert (and whether it replaced an identical one) and when it is tapped: proof of delivery to
--    the physical device, distinct from a push service merely accepting the request. The owner's own pass/fail is
--    recorded beside it. Deleting a device (turning alerts off) deletes its checks.
-- Refuses to run twice, before 006, or as any role but nfl_pool_owner. One transaction.
BEGIN;

DO $pre$
BEGIN
  IF current_user <> 'nfl_pool_owner' THEN
    RAISE EXCEPTION 'migration 007 (pool alerts device checks) must be applied as nfl_pool_owner, not %', current_user;
  END IF;
  IF to_regclass('pool_alerts.subscriptions') IS NULL THEN
    RAISE EXCEPTION 'migration 007 (pool alerts device checks) needs migration 006';
  END IF;
  IF to_regclass('pool_alerts.device_checks') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 007 (pool alerts device checks) is already applied';
  END IF;
END
$pre$;

ALTER TABLE pool_alerts.subscriptions
  ADD COLUMN platform text CHECK (platform IN ('android', 'ios', 'desktop')),
  ADD COLUMN check_requested_at timestamptz;

CREATE TABLE pool_alerts.device_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES pool_alerts.subscriptions (id) ON DELETE CASCADE,
  ack_sha256 text NOT NULL UNIQUE CHECK (ack_sha256 ~ '^[0-9a-f]{64}$'),
  scenario text NOT NULL CHECK (scenario IN ('test', 'release', 'repeat', 'correction')),
  season integer CHECK (season BETWEEN 2000 AND 2100),
  week integer CHECK (week BETWEEN 1 AND 22),
  revision integer CHECK (revision >= 1),
  CHECK ((scenario = 'test') = (season IS NULL AND week IS NULL AND revision IS NULL)),
  state text NOT NULL DEFAULT 'sending' CHECK (state IN ('sending', 'sent', 'failed', 'expired', 'skipped')),
  last_status integer,
  last_error text CHECK (length(last_error) <= 120),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  received_at timestamptz,
  received_repeat boolean,
  opened_at timestamptz,
  owner_result text CHECK (owner_result IN ('pass', 'fail')),
  owner_note text CHECK (length(owner_note) <= 200),
  confirmed_at timestamptz
);
CREATE INDEX device_checks_recent ON pool_alerts.device_checks (created_at DESC);
CREATE INDEX device_checks_subscription ON pool_alerts.device_checks (subscription_id, created_at DESC);

REVOKE ALL ON pool_alerts.device_checks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON pool_alerts.device_checks TO pool_alerts_sender;

-- The figure the hourly housekeeping removes after 30 days is enforced by the sender (store.housekeeping); the database
-- keeps no other schedule.
COMMIT;
