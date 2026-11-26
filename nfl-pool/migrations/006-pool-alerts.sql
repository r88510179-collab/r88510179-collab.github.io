-- Migration 006: Pool Alerts (Personal Pool background notifications).
--
-- NOT APPLIED TO PRODUCTION BY THIS REPOSITORY. Apply only with the owner's written production-migration approval, as
-- nfl_pool_owner, after a fresh Neon branch/snapshot backup. Exercised on disposable PostgreSQL by nfl-pool/sql-tests
-- (pool-alerts.sql, backup compatibility) and nfl-pool/push/integration.spec.mjs.
--
-- What it adds, and why it is safe for publishing:
--  * A private schema, pool_alerts, that no Data API role can use (no grant to PUBLIC, anonymous or authenticated).
--    It holds the notification outbox, the opt-in push subscriptions, sender settings and diagnostics.
--  * One AFTER ROW trigger on public.nfl_pool_weeks that records each publication fact (a locked revision appearing, or a
--    locked week being withdrawn) in pool_alerts.publication_events IN THE SAME TRANSACTION as the publication. A
--    publication that rolls back leaves no event; an event always means a committed publication. Draft rows, unchanged
--    rewrites and score refreshes (which never write this table) record nothing.
--  * The trigger never blocks or alters a publication: its insert runs in its own exception block and any failure only
--    raises a WARNING (the sender's hourly reconciliation then detects the gap and reports it).
--  * The trigger function lives in public and is owned by nfl_pool_owner on purpose: the Personal backup dumps only the
--    public schema and restores it with the documented prerequisite roles (smokke-dashboard
--    ops/personal-backup-restore-prereqs.sql). A function owned by nfl_pool_owner restores there, and because it
--    tolerates a missing pool_alerts schema, a restored copy still accepts writes. No table or sequence is added to
--    public (the backup preflight requires exactly five public tables).
--  * One NOLOGIN role, pool_alerts_sender, with access to pool_alerts only (nothing in public). The owner enables its
--    login with a generated password as a separate, reviewed step (see nfl-pool/push/README.md).
--
-- Refuses to run twice, and refuses any role but nfl_pool_owner. The whole file is one transaction.

BEGIN;

DO $pre$
BEGIN
  IF current_user <> 'nfl_pool_owner' THEN
    RAISE EXCEPTION 'migration 006 (pool alerts) must be applied as nfl_pool_owner, not %', current_user;
  END IF;
  IF to_regnamespace('pool_alerts') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 006 (pool alerts) is already applied: schema pool_alerts exists';
  END IF;
  IF to_regclass('public.nfl_pool_weeks') IS NULL THEN
    RAISE EXCEPTION 'migration 006 (pool alerts) needs public.nfl_pool_weeks';
  END IF;
  IF to_regprocedure('public.nfl_pool_alerts_capture()') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 006 (pool alerts): public.nfl_pool_alerts_capture() already exists';
  END IF;
END
$pre$;

CREATE SCHEMA pool_alerts AUTHORIZATION nfl_pool_owner;
REVOKE ALL ON SCHEMA pool_alerts FROM PUBLIC;
COMMENT ON SCHEMA pool_alerts IS 'Pool Alerts: private notification outbox, opt-in push subscriptions and sender diagnostics. Never exposed through the Data API.';

-- Which deployment this database is. Empty after the migration: the owner inserts exactly one row ('production' on the
-- Personal production database) after review. The sender refuses to run unless this row matches its own setting, so a
-- staging sender can never act on production data or the other way round.
CREATE TABLE pool_alerts.environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  name text NOT NULL CHECK (name IN ('production', 'staging', 'test')),
  set_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Publication facts, captured by the trigger below (source 'trigger') or, only for a locked revision the public Data API
-- shows but no trigger recorded, by the sender's reconciliation (source 'reconcile'). Append-only.
CREATE TABLE pool_alerts.publication_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season integer NOT NULL CHECK (season BETWEEN 2020 AND 2100),
  week integer NOT NULL CHECK (week BETWEEN 1 AND 22),
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('publish', 'withdraw')),
  content_changed boolean,
  previous_revision integer,
  previous_status text,
  published_at timestamptz,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL DEFAULT 'trigger' CHECK (source IN ('trigger', 'reconcile'))
);
CREATE INDEX publication_events_week ON pool_alerts.publication_events (season, week, id);

-- Sender switches. Sending starts DISABLED: nothing is delivered until the owner turns it on after acceptance.
CREATE TABLE pool_alerts.settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sending_enabled boolean NOT NULL DEFAULT false,
  enrollment_mode text NOT NULL DEFAULT 'open' CHECK (enrollment_mode IN ('open', 'invite', 'closed')),
  invite_code_sha256 text CHECK (invite_code_sha256 ~ '^[0-9a-f]{64}$'),
  max_active_subscriptions integer NOT NULL DEFAULT 500 CHECK (max_active_subscriptions BETWEEN 1 AND 100000),
  max_new_subscriptions_per_hour integer NOT NULL DEFAULT 60 CHECK (max_new_subscriptions_per_hour BETWEEN 1 AND 10000),
  max_notification_age_minutes integer NOT NULL DEFAULT 1440 CHECK (max_notification_age_minutes BETWEEN 10 AND 10080),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL DEFAULT 'migration 006',
  note text CHECK (length(note) <= 200),
  CHECK (enrollment_mode <> 'invite' OR invite_code_sha256 IS NOT NULL)
);
INSERT INTO pool_alerts.settings DEFAULT VALUES;

-- The last publication event the sender has planned. Empty until the first sender cycle, which sets it to the newest
-- event at that moment WITHOUT notifying anyone: the system never sends historical notifications when it starts.
CREATE TABLE pool_alerts.cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_event_id bigint NOT NULL CHECK (last_event_id >= 0),
  initialized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Opt-in devices. No name, email, account or pick is stored: only the browser's push endpoint and encryption keys, a
-- hash of the device's private management token, the site it enrolled from and its preferences.
CREATE TABLE pool_alerts.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint text NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 20 AND 2048 AND endpoint LIKE 'https://%'),
  p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{22}$'),
  manage_token_sha256 text NOT NULL CHECK (manage_token_sha256 ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL CHECK (origin ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'),
  releases boolean NOT NULL DEFAULT true,
  corrections boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_success_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text CHECK (length(disabled_reason) <= 120)
);
CREATE INDEX subscriptions_status ON pool_alerts.subscriptions (status, created_at);

-- One notification per publication event that is worth announcing (or a record of why it was not sent).
CREATE TABLE pool_alerts.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id bigint NOT NULL UNIQUE REFERENCES pool_alerts.publication_events (id),
  season integer NOT NULL,
  week integer NOT NULL,
  revision integer NOT NULL,
  base_kind text NOT NULL CHECK (base_kind IN ('release', 'correction')),
  status text NOT NULL CHECK (status IN ('queued', 'verified', 'done', 'superseded', 'withdrawn', 'stale', 'unchanged')),
  status_reason text CHECK (length(status_reason) <= 200),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX notifications_week ON pool_alerts.notifications (season, week, id);
CREATE INDEX notifications_open ON pool_alerts.notifications (status) WHERE status IN ('queued', 'verified');

-- One delivery per (notification, device). kind is decided per device: 'release' until the device has received an
-- announcement of that week, 'correction' afterwards. The primary key makes a second delivery of the same notification
-- to the same device impossible.
CREATE TABLE pool_alerts.deliveries (
  notification_id bigint NOT NULL REFERENCES pool_alerts.notifications (id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES pool_alerts.subscriptions (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('release', 'correction')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'retry', 'sent', 'failed', 'expired', 'cancelled', 'superseded')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  last_status integer,
  last_error text CHECK (length(last_error) <= 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  PRIMARY KEY (notification_id, subscription_id)
);
CREATE INDEX deliveries_due ON pool_alerts.deliveries (next_attempt_at) WHERE state IN ('pending', 'retry', 'sending');
CREATE INDEX deliveries_subscription ON pool_alerts.deliveries (subscription_id, state);

-- One row per sender cycle (dispatch after publishing, hourly check, owner action): the monitoring trail.
CREATE TABLE pool_alerts.runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger text NOT NULL CHECK (trigger IN ('dispatch', 'cron', 'owner')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('ok', 'partial', 'paused', 'error')),
  error_class text CHECK (length(error_class) <= 80),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX runs_started ON pool_alerts.runs (started_at DESC);

-- Owner and sender actions that change behavior (pause, resume, retry, test send, enrollment changes, capture gaps).
CREATE TABLE pool_alerts.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor text NOT NULL CHECK (actor IN ('publisher', 'owner-token', 'sender', 'owner-sql')),
  action text NOT NULL CHECK (length(action) <= 60),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- The capture trigger. SECURITY DEFINER (as nfl_pool_owner) only so the publishing Data API role needs no access to
-- pool_alerts; the body inserts fixed columns from the row being written, with a pinned search_path and no dynamic SQL.
CREATE FUNCTION public.nfl_pool_alerts_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $capture$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status = 'locked' THEN
        INSERT INTO pool_alerts.publication_events (season, week, revision, action, content_changed, published_at)
        VALUES (NEW.season, NEW.week, NEW.revision, 'publish', true, NEW.published_at);
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.season IS DISTINCT FROM NEW.season OR OLD.week IS DISTINCT FROM NEW.week THEN
        IF OLD.status = 'locked' THEN
          INSERT INTO pool_alerts.publication_events (season, week, revision, action, previous_revision, previous_status)
          VALUES (OLD.season, OLD.week, OLD.revision, 'withdraw', OLD.revision, OLD.status);
        END IF;
        IF NEW.status = 'locked' THEN
          INSERT INTO pool_alerts.publication_events (season, week, revision, action, content_changed, published_at)
          VALUES (NEW.season, NEW.week, NEW.revision, 'publish', true, NEW.published_at);
        END IF;
      ELSIF NEW.status = 'locked'
        AND (OLD.status IS DISTINCT FROM 'locked' OR NEW.revision IS DISTINCT FROM OLD.revision) THEN
        INSERT INTO pool_alerts.publication_events
          (season, week, revision, action, content_changed, previous_revision, previous_status, published_at)
        VALUES (NEW.season, NEW.week, NEW.revision, 'publish',
          OLD.status IS DISTINCT FROM 'locked' OR OLD.config IS DISTINCT FROM NEW.config
            OR OLD.source_sha256 IS DISTINCT FROM NEW.source_sha256,
          OLD.revision, OLD.status, NEW.published_at);
      ELSIF OLD.status = 'locked' AND NEW.status IS DISTINCT FROM 'locked' THEN
        INSERT INTO pool_alerts.publication_events (season, week, revision, action, previous_revision, previous_status)
        VALUES (NEW.season, NEW.week, OLD.revision, 'withdraw', OLD.revision, OLD.status);
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD.status = 'locked' THEN
        INSERT INTO pool_alerts.publication_events (season, week, revision, action, previous_revision, previous_status)
        VALUES (OLD.season, OLD.week, OLD.revision, 'withdraw', OLD.revision, OLD.status);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never block or alter a publication because of alerts. The sender's reconciliation reports the gap.
    RAISE WARNING 'Pool Alerts did not record this publication change (SQLSTATE %); the publication itself is unaffected', SQLSTATE;
  END;
  RETURN NULL;
END
$capture$;
REVOKE ALL ON FUNCTION public.nfl_pool_alerts_capture() FROM PUBLIC;
COMMENT ON FUNCTION public.nfl_pool_alerts_capture() IS 'Pool Alerts: records committed Pick''em publication facts in pool_alerts.publication_events. Fails open: never blocks a publication.';

CREATE TRIGGER nfl_pool_alerts_capture
AFTER INSERT OR UPDATE OR DELETE ON public.nfl_pool_weeks
FOR EACH ROW EXECUTE FUNCTION public.nfl_pool_alerts_capture();

-- The sender role: no login yet (the owner enables it with a generated password), no inheritance, no RLS bypass, a
-- small connection limit, and short timeouts so a stuck sender can never hold publication locks.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pool_alerts_sender') THEN
    CREATE ROLE pool_alerts_sender NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 5;
  END IF;
END
$role$;
ALTER ROLE pool_alerts_sender SET statement_timeout = '15s';
ALTER ROLE pool_alerts_sender SET lock_timeout = '5s';
ALTER ROLE pool_alerts_sender SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE pool_alerts_sender SET search_path = pg_catalog, pool_alerts;

GRANT USAGE ON SCHEMA pool_alerts TO pool_alerts_sender;
GRANT SELECT ON pool_alerts.environment TO pool_alerts_sender;
GRANT SELECT ON pool_alerts.settings TO pool_alerts_sender;
GRANT UPDATE (sending_enabled, enrollment_mode, invite_code_sha256, updated_at, updated_by, note)
  ON pool_alerts.settings TO pool_alerts_sender;
GRANT SELECT, INSERT ON pool_alerts.publication_events TO pool_alerts_sender;
GRANT SELECT, INSERT, UPDATE ON pool_alerts.cursor TO pool_alerts_sender;
GRANT SELECT, INSERT, UPDATE, DELETE ON pool_alerts.subscriptions TO pool_alerts_sender;
GRANT SELECT, INSERT, UPDATE ON pool_alerts.notifications TO pool_alerts_sender;
GRANT SELECT, INSERT, UPDATE, DELETE ON pool_alerts.deliveries TO pool_alerts_sender;
GRANT SELECT, INSERT, UPDATE, DELETE ON pool_alerts.runs TO pool_alerts_sender;
GRANT SELECT, INSERT ON pool_alerts.audit_log TO pool_alerts_sender;

-- The sender may add only reconciliation events (the trigger, running as the table owner, is not subject to this).
ALTER TABLE pool_alerts.publication_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY pool_alerts_sender_read ON pool_alerts.publication_events FOR SELECT TO pool_alerts_sender USING (true);
CREATE POLICY pool_alerts_sender_reconcile ON pool_alerts.publication_events FOR INSERT TO pool_alerts_sender
  WITH CHECK (source = 'reconcile' AND action = 'publish');

COMMIT;
