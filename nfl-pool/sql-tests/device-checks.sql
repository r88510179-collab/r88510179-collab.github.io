-- Pool Alerts device checks (migration 007) SQL gate. Run as the cluster superuser, connected to nfl_pool, after
-- migrations 006 and 007 and the Pool Alerts capture suite. Each assertion reports "CHECKS-TEST ok: <name>" or
-- "CHECKS-TEST FAIL: <name>: <detail>"; run.sh counts them against the plan printed at the end. Everything it writes is
-- rolled back.
\set ON_ERROR_STOP on
\set VERBOSITY terse
\o /dev/null
BEGIN;
CREATE SCHEMA checks_test;
CREATE FUNCTION checks_test.check(p_name text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS TRUE THEN RAISE NOTICE 'CHECKS-TEST ok: %', p_name;
  ELSE RAISE NOTICE 'CHECKS-TEST FAIL: %: %', p_name, COALESCE(p_detail, 'condition is ' || COALESCE(p_ok::text, 'NULL')); END IF;
END
$$;
-- The SQLSTATE of one statement, or NULL when it succeeds (in a subtransaction, so a failure leaves nothing behind).
CREATE FUNCTION checks_test.attempt(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE;
END
$$;
CREATE FUNCTION checks_test.as_sender(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  SET LOCAL ROLE pool_alerts_sender;
  v := checks_test.attempt(p_sql);
  RESET ROLE;
  RETURN v;
END
$$;
GRANT USAGE ON SCHEMA checks_test TO pool_alerts_sender;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA checks_test TO pool_alerts_sender;

-- Who may touch the checks: the sender role, and no Data API role or PUBLIC.
SELECT checks_test.check('the sender may read, add, change and remove device checks',
  has_table_privilege('pool_alerts_sender', 'pool_alerts.device_checks', 'SELECT, INSERT, UPDATE, DELETE'));
SELECT checks_test.check('no Data API role can reach the device checks',
  NOT has_table_privilege('anonymous', 'pool_alerts.device_checks', 'SELECT') AND NOT has_table_privilege('authenticated', 'pool_alerts.device_checks', 'SELECT')
  AND NOT has_schema_privilege('anonymous', 'pool_alerts', 'USAGE') AND NOT has_schema_privilege('authenticated', 'pool_alerts', 'USAGE'));
SELECT checks_test.check('PUBLIC holds nothing on the device checks',
  NOT EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid = 'pool_alerts.device_checks'::regclass AND a.grantee = 0));
SELECT checks_test.check('the sender still cannot read a public table',
  checks_test.as_sender('SELECT count(*) FROM public.nfl_pool_weeks') = '42501');
SELECT checks_test.check('the sender cannot change the environment marker',
  checks_test.as_sender($$UPDATE pool_alerts.environment SET name = 'production'$$) = '42501');

-- A device, as the sender enrolls one, with the coarse platform 007 adds.
INSERT INTO pool_alerts.subscriptions (id, endpoint, p256dh, auth, manage_token_sha256, origin, platform)
VALUES ('11111111-1111-4111-8111-111111111111', 'https://fcm.googleapis.com/fcm/send/checks-test-device-1', repeat('A', 87), repeat('B', 22),
  repeat('c', 64), 'https://picks.smokkeventures.com', 'android');
SELECT checks_test.check('a platform is android, ios or desktop, or unknown',
  checks_test.attempt($$UPDATE pool_alerts.subscriptions SET platform = 'iphone' WHERE id = '11111111-1111-4111-8111-111111111111'$$) = '23514'
  AND checks_test.attempt($$UPDATE pool_alerts.subscriptions SET platform = NULL WHERE id = '11111111-1111-4111-8111-111111111111'$$) IS NULL
  AND checks_test.attempt($$UPDATE pool_alerts.subscriptions SET platform = 'ios' WHERE id = '11111111-1111-4111-8111-111111111111'$$) IS NULL);
SELECT checks_test.check('the sender records a device''s own request to be checked',
  checks_test.as_sender($$UPDATE pool_alerts.subscriptions SET check_requested_at = clock_timestamp() WHERE id = '11111111-1111-4111-8111-111111111111'$$) IS NULL);

-- The shapes a check may have.
SELECT checks_test.check('a test names no week',
  checks_test.as_sender($$INSERT INTO pool_alerts.device_checks (subscription_id, ack_sha256, scenario, requested_by)
    VALUES ('11111111-1111-4111-8111-111111111111', repeat('1', 64), 'test', 'owner-token')$$) IS NULL
  AND checks_test.attempt($$INSERT INTO pool_alerts.device_checks (subscription_id, ack_sha256, scenario, season, week, revision, requested_by)
    VALUES ('11111111-1111-4111-8111-111111111111', repeat('2', 64), 'test', 2026, 12, 1, 'owner-token')$$) = '23514');
SELECT checks_test.check('a week check names exactly one published week',
  checks_test.as_sender($$INSERT INTO pool_alerts.device_checks (subscription_id, ack_sha256, scenario, season, week, revision, requested_by)
    VALUES ('11111111-1111-4111-8111-111111111111', repeat('3', 64), 'release', 2026, 12, 2, 'publisher')$$) IS NULL
  AND checks_test.attempt($$INSERT INTO pool_alerts.device_checks (subscription_id, ack_sha256, scenario, requested_by)
    VALUES ('11111111-1111-4111-8111-111111111111', repeat('4', 64), 'correction', 'owner-token')$$) = '23514'
  AND checks_test.attempt($$INSERT INTO pool_alerts.device_checks (subscription_id, ack_sha256, scenario, season, week, revision, requested_by)
    VALUES ('11111111-1111-4111-8111-111111111111', repeat('5', 64), 'release', 2026, 23, 1, 'owner-token')$$) = '23514');
SELECT checks_test.check('a receipt value is stored once, as a digest only',
  checks_test.attempt($$INSERT INTO pool_alerts.device_checks (subscription_id, ack_sha256, scenario, requested_by)
    VALUES ('11111111-1111-4111-8111-111111111111', repeat('1', 64), 'test', 'owner-token')$$) = '23505'
  AND checks_test.attempt($$INSERT INTO pool_alerts.device_checks (subscription_id, ack_sha256, scenario, requested_by)
    VALUES ('11111111-1111-4111-8111-111111111111', 'not-a-digest', 'test', 'owner-token')$$) = '23514');
SELECT checks_test.check('only the states a check can be in',
  checks_test.attempt($$UPDATE pool_alerts.device_checks SET state = 'delivered' WHERE ack_sha256 = repeat('1', 64)$$) = '23514'
  AND checks_test.attempt($$UPDATE pool_alerts.device_checks SET state = 'skipped', last_error = 'corrections-off' WHERE ack_sha256 = repeat('3', 64)$$) IS NULL);
SELECT checks_test.check('the owner''s verdict is pass or fail',
  checks_test.attempt($$UPDATE pool_alerts.device_checks SET owner_result = 'maybe' WHERE ack_sha256 = repeat('1', 64)$$) = '23514'
  AND checks_test.as_sender($$UPDATE pool_alerts.device_checks SET owner_result = 'pass', owner_note = 'Pixel 8, lock screen ok', confirmed_at = clock_timestamp()
    WHERE ack_sha256 = repeat('1', 64)$$) IS NULL);

-- Turning alerts off removes the device and everything about it, its checks included.
DO $$
DECLARE v_state text := checks_test.as_sender($q$DELETE FROM pool_alerts.subscriptions WHERE id = '11111111-1111-4111-8111-111111111111'$q$);
  v_left bigint := (SELECT count(*) FROM pool_alerts.device_checks WHERE subscription_id = '11111111-1111-4111-8111-111111111111');
BEGIN
  PERFORM checks_test.check('removing a device removes its checks', v_state IS NULL AND v_left = 0,
    format('delete SQLSTATE %s, %s check(s) left', COALESCE(v_state, 'none'), v_left));
END
$$;

-- Publishing still records events with 007 applied (the capture trigger is unchanged).
DO $$
DECLARE v_before bigint := (SELECT count(*) FROM pool_alerts.publication_events);
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at, locked_at)
  VALUES (2096, 1, 'locked', '{"schemaVersion":1,"season":2096,"week":1,"games":[],"participants":[]}', 1, now(), now());
  RESET ROLE;
  PERFORM checks_test.check('publishing is recorded as before with 007 applied',
    (SELECT count(*) FROM pool_alerts.publication_events) = v_before + 1);
END
$$;

\o
SELECT 'CHECKS-PLAN 14';
ROLLBACK;
