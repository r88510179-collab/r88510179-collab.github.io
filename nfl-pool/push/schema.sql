-- Isolated Personal Pool alert store. NOT part of production migration bundle.
-- Apply only on a reviewed disposable branch with a dedicated sender role.
BEGIN;
CREATE SCHEMA pool_alerts;
REVOKE ALL ON SCHEMA pool_alerts FROM PUBLIC;
CREATE TABLE pool_alerts.cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  season integer NOT NULL, week integer NOT NULL CHECK(week BETWEEN 1 AND 18),
  revision integer NOT NULL CHECK(revision>0), published_at timestamptz NOT NULL
);
CREATE TABLE pool_alerts.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint text NOT NULL UNIQUE, p256dh text NOT NULL, auth text NOT NULL,
  manage_token_hash text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  corrections boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pool_alerts.events (
  season integer NOT NULL, week integer NOT NULL CHECK(week BETWEEN 1 AND 18),
  revision integer NOT NULL CHECK(revision>0), kind text NOT NULL CHECK(kind IN ('release','correction')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(season,week,revision)
);
CREATE TABLE pool_alerts.deliveries (
  season integer NOT NULL, week integer NOT NULL, revision integer NOT NULL,
  subscription_id uuid NOT NULL REFERENCES pool_alerts.subscriptions(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','retry','expired','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  lease_token uuid,
  PRIMARY KEY(season,week,revision,subscription_id),
  FOREIGN KEY(season,week,revision) REFERENCES pool_alerts.events(season,week,revision)
);
CREATE INDEX delivery_due ON pool_alerts.deliveries(next_attempt_at) WHERE state IN ('pending','retry','sending');
REVOKE ALL ON ALL TABLES IN SCHEMA pool_alerts FROM PUBLIC;
COMMIT;
