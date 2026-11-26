-- Pool Alerts (migration 006) SQL gate. Run as the cluster superuser, connected to nfl_pool, after neon-shape.sql,
-- migrations 001-006, fixtures.sql and the existing behavior and race suites (so every publication those suites wrote
-- went through the capture trigger). Publications are written the way the Data API writes them: in a transaction,
-- with request.jwt.claims set and SET LOCAL ROLE authenticated. Each assertion reports "ALERTS-TEST ok: <name>" or
-- "ALERTS-TEST FAIL: <name>: <detail>"; run.sh counts them against the plan printed at the end.

\set ON_ERROR_STOP on
\set VERBOSITY terse
\o /dev/null

CREATE SCHEMA alerts_test;

CREATE FUNCTION alerts_test.check(p_name text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS TRUE THEN
    RAISE NOTICE 'ALERTS-TEST ok: %', p_name;
  ELSE
    RAISE NOTICE 'ALERTS-TEST FAIL: %: %', p_name, COALESCE(p_detail, 'condition is ' || COALESCE(p_ok::text, 'NULL'));
  END IF;
END
$$;

-- The commissioner's Data API identity (fixtures.sql) and a signed-in non-admin participant.
CREATE FUNCTION alerts_test.publisher_claims() RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}' $$;
CREATE FUNCTION alerts_test.participant_claims() RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}' $$;

-- Run one statement as a Data API role in its own subtransaction; returns NULL on success or the SQLSTATE.
CREATE FUNCTION alerts_test.as_role(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_sql;
    RESET ROLE;
    RETURN NULL;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RETURN SQLSTATE;
  END;
END
$$;

CREATE FUNCTION alerts_test.events_for(p_season integer, p_week integer)
RETURNS TABLE (action text, revision integer, content_changed boolean, previous_status text, source text)
LANGUAGE sql AS $$
  SELECT action, revision, content_changed, previous_status, source FROM pool_alerts.publication_events
  WHERE season = p_season AND week = p_week ORDER BY id
$$;

\o

-- 1. Catalog: the private schema, the trigger, the function and the sender role are exactly as reviewed.
DO $$
DECLARE r record;
BEGIN
  PERFORM alerts_test.check('schema pool_alerts is owned by nfl_pool_owner',
    (SELECT pg_get_userbyid(nspowner) = 'nfl_pool_owner' FROM pg_namespace WHERE nspname = 'pool_alerts'));
  FOR r IN SELECT unnest(ARRAY['anonymous', 'authenticated', 'authenticator', 'neon_auth']) AS role LOOP
    PERFORM alerts_test.check(format('%s has no USAGE on pool_alerts', r.role),
      NOT has_schema_privilege(r.role, 'pool_alerts', 'USAGE'));
  END LOOP;
  PERFORM alerts_test.check('PUBLIC has no privilege on schema pool_alerts',
    NOT EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
                WHERE n.nspname = 'pool_alerts' AND a.grantee = 0));
  PERFORM alerts_test.check('no pool_alerts table is granted to PUBLIC, anonymous or authenticated',
    NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
                aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
                WHERE n.nspname = 'pool_alerts' AND (a.grantee = 0 OR a.grantee IN ('anonymous'::regrole, 'authenticated'::regrole))));
  PERFORM alerts_test.check('public gains no table or sequence (the backup requires exactly five public tables)',
    (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') = 5
    AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
                    AND c.relname LIKE '%alert%'));
  PERFORM alerts_test.check('capture function is SECURITY DEFINER, owned by nfl_pool_owner, with a pinned search_path',
    (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'nfl_pool_owner'
            AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
     FROM pg_proc p WHERE p.oid = 'public.nfl_pool_alerts_capture()'::regprocedure));
  FOR r IN SELECT unnest(ARRAY['anonymous', 'authenticated', 'authenticator', 'pool_alerts_sender']) AS role LOOP
    PERFORM alerts_test.check(format('%s cannot EXECUTE the capture function directly', r.role),
      NOT has_function_privilege(r.role, 'public.nfl_pool_alerts_capture()', 'EXECUTE'));
  END LOOP;
  PERFORM alerts_test.check('one enabled AFTER ROW INSERT/UPDATE/DELETE trigger on nfl_pool_weeks',
    (SELECT count(*) = 1 AND bool_and(t.tgenabled = 'O') AND bool_and(t.tgtype & 1 = 1) AND bool_and(t.tgtype & 2 = 0)
            AND bool_and(t.tgtype & 28 = 28)
     FROM pg_trigger t WHERE t.tgrelid = 'public.nfl_pool_weeks'::regclass AND NOT t.tgisinternal
       AND t.tgfoid = 'public.nfl_pool_alerts_capture()'::regprocedure));
  PERFORM alerts_test.check('sender role cannot log in yet, has no superuser, createrole, createdb or RLS bypass',
    (SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls
            AND NOT rolinherit AND rolconnlimit = 5 FROM pg_roles WHERE rolname = 'pool_alerts_sender'));
  PERFORM alerts_test.check('sender role is a member of no other role',
    NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'pool_alerts_sender'::regrole));
  FOR r IN SELECT unnest(ARRAY['public.nfl_pool_weeks', 'public.nfl_survivor_weeks', 'public.nfl_contests',
                               'public.nfl_contest_policies', 'public.nfl_incident_rulings']) AS t LOOP
    PERFORM alerts_test.check(format('sender role has no privilege on %s', r.t),
      NOT has_table_privilege('pool_alerts_sender', r.t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  END LOOP;
  PERFORM alerts_test.check('sender role has no USAGE on neon_auth or auth',
    NOT has_schema_privilege('pool_alerts_sender', 'neon_auth', 'USAGE')
    AND NOT has_schema_privilege('pool_alerts_sender', 'auth', 'USAGE'));
  PERFORM alerts_test.check('sender role cannot change event history or the settings it must not',
    NOT has_table_privilege('pool_alerts_sender', 'pool_alerts.publication_events', 'UPDATE,DELETE,TRUNCATE')
    AND NOT has_column_privilege('pool_alerts_sender', 'pool_alerts.settings', 'max_active_subscriptions', 'UPDATE')
    AND NOT has_table_privilege('pool_alerts_sender', 'pool_alerts.environment', 'INSERT,UPDATE,DELETE'));
  PERFORM alerts_test.check('sending starts disabled and enrollment open, with one settings row',
    (SELECT count(*) = 1 AND bool_and(NOT sending_enabled) AND bool_and(enrollment_mode = 'open')
     FROM pool_alerts.settings));
  PERFORM alerts_test.check('environment marker is empty until the owner sets it',
    NOT EXISTS (SELECT 1 FROM pool_alerts.environment));
END
$$;

-- 2. The race suite ran with the trigger live (migration 006 is applied after fixtures and the behavior suite, as it
-- would be on production with weeks already published). Its concurrent publish-update races each commit exactly one
-- new revision of 2026 Weeks 11 and 12: both were captured, the losing writer of each race left no event, and every
-- week with events ends on the state the table holds. Weeks published before 006 have no event (no history replay).
DO $$
BEGIN
  PERFORM alerts_test.check('the race suite''s committed Week 11 and Week 12 revisions were each captured once',
    (SELECT count(*) FROM pool_alerts.publication_events e JOIN public.nfl_pool_weeks w USING (season, week)
     WHERE e.season = 2026 AND e.week IN (11, 12) AND e.action = 'publish' AND e.revision = w.revision) = 2,
    (SELECT string_agg(season || '/' || week || ' ' || action || ' r' || revision, ', ' ORDER BY id) FROM pool_alerts.publication_events));
  PERFORM alerts_test.check('no event exists for a revision the table never committed (the losing racer wrote nothing)',
    NOT EXISTS (SELECT 1 FROM pool_alerts.publication_events e JOIN public.nfl_pool_weeks w USING (season, week)
                WHERE e.action = 'publish' AND e.revision > w.revision));
  PERFORM alerts_test.check('every week with events ends on the table''s state (publish of its locked revision, or a withdraw)',
    NOT EXISTS (
      SELECT 1 FROM public.nfl_pool_weeks w
      JOIN LATERAL (SELECT * FROM pool_alerts.publication_events x WHERE x.season = w.season AND x.week = w.week
                    ORDER BY x.id DESC LIMIT 1) e ON true
      WHERE (w.status = 'locked' AND NOT (e.action = 'publish' AND e.revision = w.revision))
         OR (w.status <> 'locked' AND e.action <> 'withdraw')));
  PERFORM alerts_test.check('weeks published before the migration produced no event (nothing historical to replay)',
    NOT EXISTS (SELECT 1 FROM pool_alerts.publication_events WHERE season = 2026 AND week IN (3, 4, 6, 7, 10, 13)));
  PERFORM alerts_test.check('every captured event so far came from the trigger',
    NOT EXISTS (SELECT 1 FROM pool_alerts.publication_events WHERE source <> 'trigger'));
END
$$;

-- 3. Trigger semantics, written as the Data API publisher (authenticated, commissioner claims). Season 2096 is unused
-- by every other suite.
BEGIN;
DO $$
DECLARE s text;
BEGIN
  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at, locked_at)
       VALUES (2096, 1, 'locked', '{"schemaVersion":1,"season":2096,"week":1,"games":[],"participants":[]}', 1, now(), now())$q$);
  PERFORM alerts_test.check('publisher inserts a locked week', s IS NULL, s);
  PERFORM alerts_test.check('a locked insert records one publish event (content changed)',
    (SELECT count(*) = 1 AND bool_and(action = 'publish' AND revision = 1 AND content_changed AND source = 'trigger')
     FROM alerts_test.events_for(2096, 1)));

  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision)
       VALUES (2096, 2, 'draft', '{"schemaVersion":1,"season":2096,"week":2,"games":[],"participants":[]}', 1)$q$);
  PERFORM alerts_test.check('a draft insert records nothing', s IS NULL AND NOT EXISTS (SELECT 1 FROM alerts_test.events_for(2096, 2)), s);

  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$UPDATE public.nfl_pool_weeks SET status = 'locked', revision = 2, published_at = now(), locked_at = now()
       WHERE season = 2096 AND week = 2 AND revision = 1$q$);
  PERFORM alerts_test.check('locking a draft records a publish from draft',
    s IS NULL AND (SELECT count(*) = 1 AND bool_and(action = 'publish' AND revision = 2 AND previous_status = 'draft' AND content_changed)
                   FROM alerts_test.events_for(2096, 2)), s);

  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$UPDATE public.nfl_pool_weeks SET revision = 2, published_at = now(),
         config = '{"schemaVersion":1,"season":2096,"week":1,"games":[],"participants":[],"organizerCorrections":[{"n":1}]}'
       WHERE season = 2096 AND week = 1 AND revision = 1$q$);
  PERFORM alerts_test.check('a correction (new revision, changed content) records a changed publish',
    s IS NULL AND (SELECT action = 'publish' AND revision = 2 AND content_changed AND previous_status = 'locked'
                   FROM alerts_test.events_for(2096, 1) OFFSET 1 LIMIT 1), s);

  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$UPDATE public.nfl_pool_weeks SET revision = 3, published_at = now()
       WHERE season = 2096 AND week = 1 AND revision = 2$q$);
  PERFORM alerts_test.check('a republish of identical content records a publish marked unchanged',
    s IS NULL AND (SELECT action = 'publish' AND revision = 3 AND content_changed = false
                   FROM alerts_test.events_for(2096, 1) OFFSET 2 LIMIT 1), s);

  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$UPDATE public.nfl_pool_weeks SET updated_at = now() + interval '1 second', source_filename = 'renamed.pdf'
       WHERE season = 2096 AND week = 1$q$);
  PERFORM alerts_test.check('a write that changes no status or revision records nothing',
    s IS NULL AND (SELECT count(*) = 3 FROM alerts_test.events_for(2096, 1)), s);

  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$UPDATE public.nfl_pool_weeks SET status = 'draft' WHERE season = 2096 AND week = 1$q$);
  PERFORM alerts_test.check('unlocking a published week records a withdraw of the withdrawn revision',
    s IS NULL AND (SELECT action = 'withdraw' AND revision = 3 AND previous_status = 'locked'
                   FROM alerts_test.events_for(2096, 1) OFFSET 3 LIMIT 1), s);

  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$UPDATE public.nfl_pool_weeks SET status = 'locked', revision = 4, published_at = now() WHERE season = 2096 AND week = 1$q$);
  PERFORM alerts_test.check('republishing a withdrawn week records a publish from draft',
    s IS NULL AND (SELECT action = 'publish' AND revision = 4 AND previous_status = 'draft' AND content_changed
                   FROM alerts_test.events_for(2096, 1) OFFSET 4 LIMIT 1), s);

  -- A compare-and-swap that matches no row (stale revision) writes nothing and records nothing.
  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$UPDATE public.nfl_pool_weeks SET revision = 9 WHERE season = 2096 AND week = 1 AND revision = 1$q$);
  PERFORM alerts_test.check('a stale compare-and-swap records nothing', s IS NULL AND (SELECT count(*) = 5 FROM alerts_test.events_for(2096, 1)), s);

  -- A non-admin signed-in user is refused by RLS: no row changes and no event.
  s := alerts_test.as_role('authenticated', alerts_test.participant_claims(),
    $q$INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at)
       VALUES (2096, 3, 'locked', '{"schemaVersion":1,"season":2096,"week":3,"games":[],"participants":[]}', 1, now())$q$);
  PERFORM alerts_test.check('an RLS-refused publication records nothing',
    s = '42501' AND NOT EXISTS (SELECT 1 FROM alerts_test.events_for(2096, 3)), COALESCE(s, 'no error'));

  -- A publication that fails a database constraint (the full-field guard) rolls back with its would-be event.
  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at)
       VALUES (2096, 4, 'locked', '{"schemaVersion":1,"season":2096,"week":4,"games":[],"participants":[],"source":{"kind":"weekly-upload"}}', 1, now())$q$);
  PERFORM alerts_test.check('a publication refused by a constraint records nothing',
    s = '23514' AND NOT EXISTS (SELECT 1 FROM alerts_test.events_for(2096, 4)), COALESCE(s, 'no error'));

  -- Anonymous readers keep exactly their published read and gain nothing in pool_alerts.
  s := alerts_test.as_role('anonymous', NULL, 'SELECT count(*) FROM pool_alerts.publication_events');
  PERFORM alerts_test.check('anonymous cannot read publication events', s = '42501', COALESCE(s, 'no error'));
  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(), 'SELECT count(*) FROM pool_alerts.subscriptions');
  PERFORM alerts_test.check('even the signed-in publisher cannot read subscriptions through the Data API role', s = '42501', COALESCE(s, 'no error'));
END
$$;
ROLLBACK;

-- 4. The capture trigger fails open: with its table unavailable, a publication still commits (with only a WARNING).
DO $$
DECLARE s text;
BEGIN
  ALTER TABLE pool_alerts.publication_events RENAME TO publication_events_parked;
  s := alerts_test.as_role('authenticated', alerts_test.publisher_claims(),
    $q$INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at, locked_at)
       VALUES (2096, 5, 'locked', '{"schemaVersion":1,"season":2096,"week":5,"games":[],"participants":[]}', 1, now(), now())$q$);
  ALTER TABLE pool_alerts.publication_events_parked RENAME TO publication_events;
  PERFORM alerts_test.check('a publication still succeeds when the alert store cannot record it', s IS NULL, s);
  PERFORM alerts_test.check('...and its row is committed and locked',
    EXISTS (SELECT 1 FROM public.nfl_pool_weeks WHERE season = 2096 AND week = 5 AND status = 'locked'));
  PERFORM alerts_test.check('...and no event exists for it (the reconciliation will report the gap)',
    NOT EXISTS (SELECT 1 FROM alerts_test.events_for(2096, 5)));
  DELETE FROM public.nfl_pool_weeks WHERE season = 2096 AND week = 5;
  PERFORM alerts_test.check('deleting a locked week records a withdraw',
    (SELECT count(*) = 1 AND bool_and(action = 'withdraw') FROM alerts_test.events_for(2096, 5)));
END
$$;

-- 5. The sender role: reads events, may add only reconciliation publishes, cannot forge trigger events.
BEGIN;
DO $$
DECLARE s text;
BEGIN
  s := alerts_test.as_role('pool_alerts_sender', NULL, 'SELECT count(*) FROM pool_alerts.publication_events');
  PERFORM alerts_test.check('sender reads publication events', s IS NULL, s);
  s := alerts_test.as_role('pool_alerts_sender', NULL,
    $q$INSERT INTO pool_alerts.publication_events (season, week, revision, action, content_changed, source)
       VALUES (2096, 6, 1, 'publish', true, 'reconcile')$q$);
  PERFORM alerts_test.check('sender may record a reconciliation publish', s IS NULL, s);
  s := alerts_test.as_role('pool_alerts_sender', NULL,
    $q$INSERT INTO pool_alerts.publication_events (season, week, revision, action) VALUES (2096, 6, 2, 'publish')$q$);
  PERFORM alerts_test.check('sender cannot forge a trigger event', s = '42501', COALESCE(s, 'no error'));
  s := alerts_test.as_role('pool_alerts_sender', NULL,
    $q$INSERT INTO pool_alerts.publication_events (season, week, revision, action, source) VALUES (2096, 6, 2, 'withdraw', 'reconcile')$q$);
  PERFORM alerts_test.check('sender cannot forge a withdrawal', s = '42501', COALESCE(s, 'no error'));
  s := alerts_test.as_role('pool_alerts_sender', NULL, 'DELETE FROM pool_alerts.publication_events');
  PERFORM alerts_test.check('sender cannot delete event history', s = '42501', COALESCE(s, 'no error'));
  s := alerts_test.as_role('pool_alerts_sender', NULL, 'SELECT count(*) FROM public.nfl_pool_weeks');
  PERFORM alerts_test.check('sender cannot read the publication table directly', s = '42501', COALESCE(s, 'no error'));
  s := alerts_test.as_role('pool_alerts_sender', NULL, $q$UPDATE pool_alerts.settings SET sending_enabled = true, updated_by = 'test'$q$);
  PERFORM alerts_test.check('sender may switch sending (owner endpoints use this)', s IS NULL, s);
  s := alerts_test.as_role('pool_alerts_sender', NULL, 'UPDATE pool_alerts.settings SET max_active_subscriptions = 99999');
  PERFORM alerts_test.check('sender cannot raise its own capacity limits', s = '42501', COALESCE(s, 'no error'));
  s := alerts_test.as_role('pool_alerts_sender', NULL, $q$INSERT INTO pool_alerts.environment (name) VALUES ('production')$q$);
  PERFORM alerts_test.check('sender cannot set the environment marker', s = '42501', COALESCE(s, 'no error'));
  s := alerts_test.as_role('pool_alerts_sender', NULL,
    $q$INSERT INTO pool_alerts.runs (trigger) VALUES ('cron')$q$);
  PERFORM alerts_test.check('sender writes run history (identity column needs no sequence grant)', s IS NULL, s);
END
$$;
ROLLBACK;

DROP SCHEMA alerts_test CASCADE;

-- The plan: every assertion above, counted by hand. run.sh requires exactly this many "ok" lines and no FAIL.
\echo ALERTS-PLAN 58
