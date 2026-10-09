-- HDC-13 SQL behavior suite. Run as the cluster superuser, connected to nfl_pool, after neon-shape.sql, migrations
-- 001-004 and fixtures.sql. Every call of public.nfl_append_incident_ruling is made the way the Data API makes it: in its
-- own transaction (or, where a test must leave nothing behind, inside one rolled-back transaction), with
-- request.jwt.claims set for the transaction and the role switched with SET LOCAL ROLE (anonymous, authenticated, or
-- authenticator itself). The cold-backend section starts a new backend (\connect) and puts the pg_session_jwt stand-in
-- in its cold or trap state (neon-shape.sql). Each assertion reports one notice, "HDC13-TEST ok: <name>" or
-- "HDC13-TEST FAIL: <name>: <detail>"; run.sh counts them against the plan echoed at the end. A missing function is an
-- assertion failure, never an aborted script: the function is only ever named through to_regprocedure or dynamic SQL,
-- except in the two sections guarded by \if :has_fn.

\set ON_ERROR_STOP on
\set VERBOSITY terse
\o /dev/null

\set fn 'public.nfl_append_incident_ruling(text,integer,text,text,text,text,integer,bigint,text,text,text,text,text)'
SELECT to_regprocedure(:'fn') IS NOT NULL AS has_fn \gset
-- HDC-14: the absent-game write path (migration 005), named only through to_regprocedure, dynamic SQL or \if :has_absent_fn.
\set absent_fn 'public.nfl_append_absent_incident_ruling(text,integer,text,text,text,text,integer,bigint,text,text)'
SELECT to_regprocedure(:'absent_fn') IS NOT NULL AS has_absent_fn \gset

CREATE SCHEMA hdc13_test;
CREATE TYPE hdc13_test.outcome AS (sqlstate text, message text, hint text, result jsonb);
CREATE TABLE hdc13_test.memo (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE hdc13_test.preset (name text PRIMARY KEY, args jsonb NOT NULL);

CREATE FUNCTION hdc13_test.check(p_name text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS TRUE THEN
    RAISE NOTICE 'HDC13-TEST ok: %', p_name;
  ELSE
    RAISE NOTICE 'HDC13-TEST FAIL: %: %', p_name, COALESCE(p_detail, 'condition is ' || COALESCE(p_ok::text, 'NULL'));
  END IF;
END
$$;

CREATE FUNCTION hdc13_test.claims(p_sub text, p_role text DEFAULT 'authenticated') RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_sub IS NULL THEN jsonb_build_object('role', p_role) ELSE jsonb_build_object('sub', p_sub, 'role', p_role) END
$$;
CREATE FUNCTION hdc13_test.commissioner() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT hdc13_test.claims('00000000-0000-4000-8000-000000000001')
$$;

-- One Data API call of the RPC: claims for this transaction, SET LOCAL ROLE, the 13 named arguments (a missing key is NULL).
CREATE FUNCTION hdc13_test.rpc(p_role text, p_claims jsonb, p_args jsonb) RETURNS hdc13_test.outcome LANGUAGE plpgsql AS $$
DECLARE
  v jsonb;
  s text;
  m text;
  h text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims::text, ''), true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE 'SELECT public.nfl_append_incident_ruling($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)' INTO v
      USING p_args->>'p_contest_id', (p_args->>'p_week')::integer, p_args->>'p_away_team', p_args->>'p_home_team',
            p_args->>'p_action', p_args->>'p_consequence', (p_args->>'p_expected_policy_revision')::integer,
            (p_args->>'p_expected_parent_ruling_id')::bigint, p_args->>'p_incident_status', p_args->>'p_event_id',
            p_args->>'p_evidence_source', p_args->>'p_public_note', p_args->>'p_admin_note';
    RESET ROLE;
    RETURN ROW('00000', NULL, NULL, v)::hdc13_test.outcome;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT, h = PG_EXCEPTION_HINT;
    RETURN ROW(s, m, NULLIF(h, ''), NULL)::hdc13_test.outcome;
  END;
END
$$;

-- Any other statement as a Data API role; query() returns the rows read as a JSON array.
CREATE FUNCTION hdc13_test.exec(p_role text, p_claims jsonb, p_sql text) RETURNS hdc13_test.outcome LANGUAGE plpgsql AS $$
DECLARE
  s text;
  m text;
  h text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims::text, ''), true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_sql;
    RESET ROLE;
    RETURN ROW('00000', NULL, NULL, NULL)::hdc13_test.outcome;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT, h = PG_EXCEPTION_HINT;
    RETURN ROW(s, m, NULLIF(h, ''), NULL)::hdc13_test.outcome;
  END;
END
$$;
CREATE FUNCTION hdc13_test.query(p_role text, p_claims jsonb, p_sql text) RETURNS hdc13_test.outcome LANGUAGE plpgsql AS $$
DECLARE
  v jsonb;
  s text;
  m text;
  h text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims::text, ''), true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE 'SELECT COALESCE(jsonb_agg(q), ''[]''::jsonb) FROM (' || p_sql || ') AS q' INTO v;
    RESET ROLE;
    RETURN ROW('00000', NULL, NULL, v)::hdc13_test.outcome;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT, h = PG_EXCEPTION_HINT;
    RETURN ROW(s, m, NULLIF(h, ''), NULL)::hdc13_test.outcome;
  END;
END
$$;

-- An error with exactly this SQLSTATE: with a token, the HINT is the token and the message starts with "<token>: ";
-- without one, no HDC13 token at all (PostgreSQL's own permission or integrity error).
CREATE FUNCTION hdc13_test.expect_error(p_name text, o hdc13_test.outcome, p_sqlstate text, p_token text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM hdc13_test.check(p_name,
    o.sqlstate = p_sqlstate AND CASE WHEN p_token IS NULL
      THEN COALESCE(o.hint, '') NOT LIKE 'HDC13%' AND COALESCE(o.message, '') NOT LIKE 'HDC13%'
      ELSE o.hint = p_token AND starts_with(o.message, p_token || ': ') END,
    format('expected %s %s, got %s "%s" (hint %s)', p_sqlstate, COALESCE(p_token, '(no HDC13 token)'), o.sqlstate, o.message, COALESCE(o.hint, 'none')));
END
$$;
-- A successful call; its result is remembered under p_memo for later steps.
CREATE FUNCTION hdc13_test.expect_ok(p_name text, o hdc13_test.outcome, p_memo text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF o.sqlstate = '00000' AND o.result IS NOT NULL AND p_memo IS NOT NULL THEN
    INSERT INTO hdc13_test.memo VALUES (p_memo, o.result) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  END IF;
  PERFORM hdc13_test.check(p_name, o.sqlstate = '00000' AND o.result IS NOT NULL,
    format('expected success, got %s "%s" (hint %s)', o.sqlstate, o.message, COALESCE(o.hint, 'none')));
END
$$;

CREATE FUNCTION hdc13_test.memo(p_key text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT value FROM hdc13_test.memo WHERE key = p_key $$;
CREATE FUNCTION hdc13_test.id(p_key text) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT (value->>'ruling_id')::bigint FROM hdc13_test.memo WHERE key = p_key $$;
-- The stored row, private columns included (read by the superuser).
CREATE FUNCTION hdc13_test.stored(p_key text) RETURNS public.nfl_incident_rulings LANGUAGE sql STABLE AS $$
  SELECT r FROM public.nfl_incident_rulings r WHERE r.ruling_id = hdc13_test.id(p_key)
$$;
CREATE FUNCTION hdc13_test.rows() RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM public.nfl_incident_rulings $$;
CREATE FUNCTION hdc13_test.req(p_preset text, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT (SELECT args FROM hdc13_test.preset WHERE name = p_preset) || COALESCE(p_over, '{}')
$$;
-- A later chain row of a preset's incident: no consequence and no evidence (the server derives and copies them), the
-- given expected parent and a private note.
CREATE FUNCTION hdc13_test.later(p_preset text, p_action text, p_parent bigint, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT hdc13_test.req(p_preset, jsonb_build_object('p_action', p_action, 'p_consequence', NULL, 'p_incident_status', NULL,
    'p_event_id', NULL, 'p_evidence_source', NULL, 'p_expected_parent_ruling_id', p_parent,
    'p_public_note', 'Later chain row: ' || p_action || '.', 'p_admin_note', 'Recorded by the HDC-13 SQL behavior suite.') || COALESCE(p_over, '{}'))
$$;
CREATE FUNCTION hdc13_test.public_row(p_key text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(x) FROM (SELECT r.ruling_id, r.contest_id, r.contest_type, r.week, r.away_team, r.home_team, r.policy_revision,
    r.chain_seq, r.parent_ruling_id, r.consequence, r.incident_status, r.event_id, r.evidence_source, r.public_note, r.created_at
    FROM public.nfl_incident_rulings r WHERE r.ruling_id = hdc13_test.id(p_key)) x
$$;

-- One Data API call of the RPC as authenticated on a backend whose pg_session_jwt is in the given state (neon-shape.sql:
-- 'warm', 'cold' or 'trap'), with request.jwt.claims set to exactly the given text for the transaction (verified, empty or
-- malformed claims); NULL leaves the setting as the backend has it, never set at all on a new backend.
CREATE FUNCTION hdc13_test.rpc_on(p_backend text, p_claims text, p_args jsonb) RETURNS hdc13_test.outcome LANGUAGE plpgsql AS $$
DECLARE
  v jsonb;
  s text;
  m text;
  h text;
BEGIN
  PERFORM set_config('hdc13_test.jwt_backend', p_backend, true);
  IF p_claims IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', p_claims, true);
  END IF;
  BEGIN
    SET LOCAL ROLE authenticated;
    EXECUTE 'SELECT public.nfl_append_incident_ruling($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)' INTO v
      USING p_args->>'p_contest_id', (p_args->>'p_week')::integer, p_args->>'p_away_team', p_args->>'p_home_team',
            p_args->>'p_action', p_args->>'p_consequence', (p_args->>'p_expected_policy_revision')::integer,
            (p_args->>'p_expected_parent_ruling_id')::bigint, p_args->>'p_incident_status', p_args->>'p_event_id',
            p_args->>'p_evidence_source', p_args->>'p_public_note', p_args->>'p_admin_note';
    RESET ROLE;
    RETURN ROW('00000', NULL, NULL, v)::hdc13_test.outcome;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT, h = PG_EXCEPTION_HINT;
    RETURN ROW(s, m, NULLIF(h, ''), NULL)::hdc13_test.outcome;
  END;
END
$$;
-- query() on a backend whose pg_session_jwt is in the given state.
CREATE FUNCTION hdc13_test.query_on(p_backend text, p_claims jsonb, p_sql text) RETURNS hdc13_test.outcome LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('hdc13_test.jwt_backend', p_backend, true);
  RETURN hdc13_test.query('authenticated', p_claims, p_sql);
END
$$;
-- The pg_session_jwt stand-in itself, as one request on a backend in the given state sees it (the superuser may call it
-- directly): the claims before the call, what it returns or the SQLSTATE it raises, and the claims after it.
CREATE FUNCTION hdc13_test.stand_in(p_backend text, p_claims text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_before text;
  v_user text;
  v_state text := '00000';
BEGIN
  PERFORM set_config('hdc13_test.jwt_backend', p_backend, true);
  PERFORM set_config('request.jwt.claims', p_claims, true);
  v_before := current_setting('request.jwt.claims', true);
  BEGIN
    v_user := auth.user_id();
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  RETURN jsonb_build_object('before', v_before, 'user_id', v_user, 'sqlstate', v_state, 'after', current_setting('request.jwt.claims', true));
END
$$;
-- The ruling history and the published Pick'em weeks and Survivor snapshots (counts and digests), to prove that a
-- rolled-back test left them exactly as they were.
CREATE FUNCTION hdc13_test.history() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'rulings', (SELECT count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(r)::text, '|' ORDER BY r.ruling_id), '')) FROM public.nfl_incident_rulings r),
    'weeks', (SELECT count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(w)::text, '|' ORDER BY w.season, w.week), '')) FROM public.nfl_pool_weeks w),
    'snapshots', (SELECT count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(w)::text, '|' ORDER BY w.season, w.week), '')) FROM public.nfl_survivor_weeks w))
$$;

INSERT INTO hdc13_test.preset VALUES
  ('pk', '{"p_contest_id":"pool-center-2026-pickem","p_week":3,"p_away_team":"BUF","p_home_team":"CIN","p_action":"rule",
    "p_consequence":"void","p_expected_policy_revision":1,"p_expected_parent_ruling_id":null,"p_incident_status":"STATUS_CANCELED",
    "p_event_id":"401437947","p_evidence_source":"nflscores2","p_public_note":"  Canceled by the league; void for this contest.  ",
    "p_admin_note":"Line one\n\tLine two"}'),
  ('denkc', '{"p_contest_id":"pool-center-2026-pickem","p_week":3,"p_away_team":"DEN","p_home_team":"KC","p_action":"rule",
    "p_consequence":"void","p_expected_policy_revision":1,"p_expected_parent_ruling_id":null,"p_incident_status":"STATUS_POSTPONED",
    "p_event_id":"401437900","p_evidence_source":"nflscores2","p_public_note":"Postponed by the league.","p_admin_note":null}'),
  ('sv', '{"p_contest_id":"pool-center-2026-survivor","p_week":2,"p_away_team":"SF","p_home_team":"ARI","p_action":"rule",
    "p_consequence":"advance_team_used","p_expected_policy_revision":1,"p_expected_parent_ruling_id":null,
    "p_incident_status":"STATUS_CANCELED","p_event_id":"401547001","p_evidence_source":"nflscores2",
    "p_public_note":"Canceled by the league; pickers advance and SF stays used.","p_admin_note":null}'),
  ('probe', '{"p_contest_id":"pool-center-2026-pickem","p_week":3,"p_away_team":"DEN","p_home_team":"KC","p_action":"withdraw",
    "p_consequence":null,"p_expected_policy_revision":1,"p_expected_parent_ruling_id":9007199254740991,"p_incident_status":null,
    "p_event_id":null,"p_evidence_source":null,"p_public_note":"HDC-13 write-access check; writes nothing.",
    "p_admin_note":"Write-access check with an impossible expected parent."}');

\set commissioner 'hdc13_test.commissioner()'
\set participant 'hdc13_test.claims(''00000000-0000-4000-8000-000000000002'')'
\set other_admin 'hdc13_test.claims(''00000000-0000-4000-8000-000000000003'')'

-- =====================================================================================================================
-- Shape: migration 004 adds exactly one function and changes nothing of HDC-12.
-- =====================================================================================================================
SELECT hdc13_test.check('migration 004 created public.nfl_append_incident_ruling with the 13-argument signature', :'has_fn'::boolean);
SELECT hdc13_test.check('the HDC-12 trigger functions are byte-identical to production (md5 of each body)',
  (SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname NOT IN ('nfl_append_incident_ruling', 'nfl_append_absent_incident_ruling'))
  = 'nfl_contest_history_reject_change:e8dbb29fadbaf7c236a1c8b3a030a259,nfl_contest_policies_check_insert:e79eaeb62ee5cba8f4b1580a294f7382,nfl_contests_check_insert:10dd8ce68f5ba50fccf9b15acb3f51dc,nfl_incident_rulings_check_insert:13a3f489440dc7051320a73769c06cff');
SELECT hdc13_test.check('the HDC-12 triggers on nfl_incident_rulings are unchanged',
  (SELECT string_agg(t.tgname || '>' || t.tgfoid::regproc::text, ',' ORDER BY t.tgname) FROM pg_trigger t
     WHERE t.tgrelid = 'public.nfl_incident_rulings'::regclass AND NOT t.tgisinternal)
  = 'nfl_incident_rulings_append_only>nfl_contest_history_reject_change,nfl_incident_rulings_check_insert>nfl_incident_rulings_check_insert,nfl_incident_rulings_no_truncate>nfl_contest_history_reject_change');
SELECT hdc13_test.check('public holds the four HDC-12 functions and the one HDC-13 function, nothing else (the HDC-14 function aside)',
  (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'nfl_append_absent_incident_ruling') = 5);

-- =====================================================================================================================
-- Grants: EXECUTE for authenticated only; no table or sequence write privilege anywhere.
-- =====================================================================================================================
SELECT hdc13_test.check('anonymous has no EXECUTE on the function', NOT has_function_privilege('anonymous', to_regprocedure(:'fn'), 'EXECUTE'));
SELECT hdc13_test.check('authenticated has EXECUTE on the function', has_function_privilege('authenticated', to_regprocedure(:'fn'), 'EXECUTE'));
SELECT hdc13_test.check('authenticator itself has no EXECUTE (it only SETs ROLE)', NOT has_function_privilege('authenticator', to_regprocedure(:'fn'), 'EXECUTE'));
SELECT hdc13_test.check('PUBLIC has no EXECUTE: the ACL is exactly the owner and authenticated',
  (SELECT string_agg(g.entry, ',' ORDER BY g.entry) FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
     || ':' || a.privilege_type AS entry FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure(:'fn')) g)
  = 'authenticated:EXECUTE,nfl_pool_owner:EXECUTE');
SELECT hdc13_test.check('the function is owned by nfl_pool_owner, the owner of the HDC-12 tables',
  (SELECT pg_get_userbyid(p.proowner) = 'nfl_pool_owner' AND p.proowner = (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.nfl_incident_rulings'::regclass)
     FROM pg_proc p WHERE p.oid = to_regprocedure(:'fn')));
SELECT hdc13_test.check('LANGUAGE plpgsql, VOLATILE, SECURITY DEFINER, SET search_path = pg_catalog, pg_temp',
  (SELECT l.lanname = 'plpgsql' AND p.provolatile = 'v' AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = to_regprocedure(:'fn')));
SELECT hdc13_test.check('exactly the 13 approved named arguments, no defaults, returns jsonb',
  (SELECT p.pronargs = 13 AND p.pronargdefaults = 0 AND p.prorettype = 'jsonb'::regtype AND p.proargnames = ARRAY['p_contest_id','p_week',
     'p_away_team','p_home_team','p_action','p_consequence','p_expected_policy_revision','p_expected_parent_ruling_id','p_incident_status',
     'p_event_id','p_evidence_source','p_public_note','p_admin_note'] FROM pg_proc p WHERE p.oid = to_regprocedure(:'fn')));
SELECT hdc13_test.check('no dynamic SQL in the function body',
  (SELECT p.prosrc !~* '\mexecute\M' AND p.prosrc !~* '\mformat\s*\(' FROM pg_proc p WHERE p.oid = to_regprocedure(:'fn')));
SELECT hdc13_test.check('every table and neon_auth reference in the body is schema-qualified',
  (SELECT p.prosrc !~ '(?<!public\.)\mnfl_(contests|contest_policies|incident_rulings|pool_weeks|survivor_weeks)\M'
      AND p.prosrc !~ '(?<!neon_auth\.)"user"'
     FROM pg_proc p WHERE p.oid = to_regprocedure(:'fn')));
SELECT hdc13_test.check('cold-backend identity: the body never calls pg_session_jwt (no auth.* reference, no user_id() call)',
  (SELECT p.prosrc !~* '\mauth\s*\.|"auth"\s*\.' AND p.prosrc !~* '\muser_id\s*\('
     FROM pg_proc p WHERE p.oid = to_regprocedure(:'fn')));
SELECT hdc13_test.check('the body has no exception handler: nothing in it can swallow a refusal or a trapped pg_session_jwt call',
  (SELECT p.prosrc !~* '\mexception\s+when\M' FROM pg_proc p WHERE p.oid = to_regprocedure(:'fn')));
SELECT hdc13_test.check('anonymous and authenticated still have no INSERT, UPDATE, DELETE or TRUNCATE on any HDC-12 table',
  NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anonymous','authenticated']) AS r(role), unnest(ARRAY['public.nfl_contests','public.nfl_contest_policies','public.nfl_incident_rulings']) AS t(tab)
    WHERE has_any_column_privilege(r.role, t.tab, 'INSERT') OR has_any_column_privilege(r.role, t.tab, 'UPDATE')
       OR has_table_privilege(r.role, t.tab, 'DELETE') OR has_table_privilege(r.role, t.tab, 'TRUNCATE')));
SELECT hdc13_test.check('anonymous and authenticated still have no privilege on the ruling id sequence',
  NOT has_sequence_privilege('anonymous', 'public.nfl_incident_rulings_ruling_id_seq', 'USAGE, SELECT, UPDATE')
  AND NOT has_sequence_privilege('authenticated', 'public.nfl_incident_rulings_ruling_id_seq', 'USAGE, SELECT, UPDATE'));
SELECT hdc13_test.check('the public column grants on nfl_incident_rulings are unchanged',
  (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = 'nfl_incident_rulings' AND grantee = 'authenticated' AND privilege_type = 'SELECT')
  = 'away_team,chain_seq,consequence,contest_id,contest_type,created_at,event_id,evidence_source,home_team,incident_status,parent_ruling_id,policy_revision,public_note,ruling_id,week');

-- =====================================================================================================================
-- Unauthorized callers: refused before anything else, and nothing is written.
-- =====================================================================================================================
SELECT hdc13_test.check('setup: no ruling exists before the first call', hdc13_test.rows() = 0);
SELECT hdc13_test.expect_error('anonymous: permission denied for the function (no EXECUTE)',
  hdc13_test.rpc('anonymous', NULL, hdc13_test.req('denkc')), '42501');
SELECT hdc13_test.expect_error('anonymous carrying the commissioner''s sub: still permission denied',
  hdc13_test.rpc('anonymous', :commissioner, hdc13_test.req('denkc')), '42501');
SELECT hdc13_test.expect_error('authenticator without SET ROLE: permission denied',
  hdc13_test.rpc('authenticator', :commissioner, hdc13_test.req('denkc')), '42501');
SELECT hdc13_test.expect_error('an unrelated authenticated user: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc('authenticated', :participant, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('another admin user: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc('authenticated', :other_admin, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
UPDATE neon_auth."user" SET banned = true WHERE id = '00000000-0000-4000-8000-000000000001';
SELECT hdc13_test.expect_error('the banned commissioner: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
UPDATE neon_auth."user" SET banned = NULL, role = 'user' WHERE id = '00000000-0000-4000-8000-000000000001';
SELECT hdc13_test.expect_error('the commissioner''s email without the admin role: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
UPDATE neon_auth."user" SET role = 'admin' WHERE id = '00000000-0000-4000-8000-000000000001';
SELECT hdc13_test.expect_error('claims without a sub: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc('authenticated', hdc13_test.claims(NULL), hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('no claims at all: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc('authenticated', NULL, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('a sub that is not a user id: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc('authenticated', hdc13_test.claims('not-a-uuid'), hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('a well-formed sub of no account: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc('authenticated', hdc13_test.claims('00000000-0000-4000-8000-0000000000ff'), hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('authorization is checked first: an invalid request from a non-commissioner is HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc('authenticated', :participant, hdc13_test.req('denkc', '{"p_action":"confirm","p_week":99,"p_public_note":null}')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.check('no unauthorized call wrote a row', hdc13_test.rows() = 0);

-- Direct table access is still refused to the commissioner's own Data API role.
SELECT hdc13_test.expect_error('direct INSERT into nfl_incident_rulings: permission denied',
  hdc13_test.exec('authenticated', :commissioner, $$INSERT INTO public.nfl_incident_rulings (contest_id, contest_type, week, away_team,
    home_team, policy_revision, chain_seq, consequence, incident_status, public_note) VALUES ('pool-center-2026-pickem', 'pickem', 3, 'DEN',
    'KC', 1, 1, 'void', 'STATUS_CANCELED', 'direct')$$), '42501');
SELECT hdc13_test.expect_error('direct INSERT by anonymous: permission denied',
  hdc13_test.exec('anonymous', NULL, $$INSERT INTO public.nfl_incident_rulings (contest_id, contest_type, week, away_team,
    home_team, policy_revision, chain_seq, consequence, incident_status) VALUES ('pool-center-2026-pickem', 'pickem', 3, 'DEN',
    'KC', 1, 1, 'void', 'STATUS_CANCELED')$$), '42501');
SELECT hdc13_test.expect_error('direct UPDATE: permission denied',
  hdc13_test.exec('authenticated', :commissioner, 'UPDATE public.nfl_incident_rulings SET public_note = ''x'''), '42501');
SELECT hdc13_test.expect_error('direct DELETE: permission denied',
  hdc13_test.exec('authenticated', :commissioner, 'DELETE FROM public.nfl_incident_rulings'), '42501');
SELECT hdc13_test.expect_error('direct TRUNCATE: permission denied',
  hdc13_test.exec('authenticated', :commissioner, 'TRUNCATE public.nfl_incident_rulings'), '42501');
SELECT hdc13_test.expect_error('the ruling id sequence: permission denied',
  hdc13_test.exec('authenticated', :commissioner, 'SELECT nextval(''public.nfl_incident_rulings_ruling_id_seq'')'), '42501');

-- =====================================================================================================================
-- Input validation (the commissioner): nothing is written for any refused request.
-- =====================================================================================================================
SELECT hdc13_test.expect_error('an unknown action: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_action":"confirm"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('a wrong contest: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_contest_id":"pool-center-2025-pickem"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('week 0: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_week":0}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('week 23: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_week":23}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('no week: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_week":null}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('an alias team code (JAC) is not a canonical code: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_away_team":"JAC"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('a lower-case team code: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_away_team":"den"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('the same team twice: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_home_team":"DEN"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('no expected policy revision: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_expected_policy_revision":null}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('a non-positive expected parent: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_expected_parent_ruling_id":0}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('a wrong policy revision: HDC13_STALE_POLICY', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_expected_policy_revision":2}')), 'P0001', 'HDC13_STALE_POLICY');
SELECT hdc13_test.expect_error('consequence "advance" is outside the vocabulary: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_consequence":"advance"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('consequence "advance_team_not_used" is outside the vocabulary: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_consequence":"advance_team_not_used"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('consequence "forfeit" is outside the vocabulary: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_consequence":"forfeit"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('consequence "withdrawn" is a chain action, not a ruling: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_consequence":"withdrawn"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('a first ruling without a consequence: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_consequence":null}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('Pick''em eliminate is not permitted (policy void): HDC13_NOT_PERMITTED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_consequence":"eliminate"}')), 'P0001', 'HDC13_NOT_PERMITTED');
SELECT hdc13_test.expect_error('a forfeit is never ruled on: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_incident_status":"STATUS_FORFEIT"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('STATUS_FINAL is not a halted status: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_incident_status":"STATUS_FINAL"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('a status must match exactly (no case folding): HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_incident_status":"status_canceled"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('a first ruling without a status: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_incident_status":null}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('a first ruling without an event id: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_event_id":null}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('an event id that is not digits: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_event_id":"40143790a"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('an event id of 21 digits: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_event_id":"123456789012345678901"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('a first ruling without an evidence source: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_evidence_source":null}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('an unknown evidence source: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_evidence_source":"espn"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note missing: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":null}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note empty: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":""}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note of spaces only: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":"    "}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note of 501 characters: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', jsonb_build_object('p_public_note', repeat('x', 501)))), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note of 501 non-BMP characters: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', jsonb_build_object('p_public_note', repeat(U&'\+01F3C8', 501)))), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note with a newline: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":"Two\nlines"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note with a carriage return: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":"Two\rlines"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note with a tab: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":"Tab\there"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note with a leading tab is not trimmed into validity: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":"\tPostponed."}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note with a control character: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":"Bell\u0007"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note with a C1 control (NEL): HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":"Next\u0085line"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('public note with a Unicode line separator: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_public_note":"Line separator"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('admin note of 2001 characters: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', jsonb_build_object('p_admin_note', repeat('y', 2001)))), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('admin note with a control character: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_admin_note":"Bell\u0007"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.check('no refused request wrote a row', hdc13_test.rows() = 0);

-- Published data (Pick'em): the locked week, the pair exactly once in its orientation, its recorded event.
SELECT hdc13_test.expect_error('a pair the published week does not contain: HDC13_NOT_PUBLISHED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_away_team":"MIA","p_home_team":"SEA","p_event_id":"401437991"}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('the published pair inverted (KC @ DEN): HDC13_NOT_PUBLISHED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_away_team":"KC","p_home_team":"DEN"}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('a week with no published row: HDC13_NOT_PUBLISHED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_week":9}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('a draft week is not published: HDC13_NOT_PUBLISHED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('pk', '{"p_week":5,"p_event_id":"401437980"}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('a locked row whose configuration names another week: HDC13_NOT_PUBLISHED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_week":6,"p_away_team":"DET","p_home_team":"GB","p_event_id":"401437985"}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('a pair published twice in the week: HDC13_NOT_PUBLISHED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_week":4,"p_away_team":"MIA","p_home_team":"BUF","p_event_id":"401437970"}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('a ruled team also published in another game that week: HDC13_NOT_PUBLISHED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_week":7,"p_away_team":"PIT","p_home_team":"CLE","p_event_id":"401437986"}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('an event id other than the published game''s: HDC13_EVENT_MISMATCH', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc', '{"p_event_id":"401437999"}')), 'P0001', 'HDC13_EVENT_MISMATCH');
SELECT hdc13_test.check('no refused published-data request wrote a row', hdc13_test.rows() = 0);

-- Isolation: READ COMMITTED only (and authorization still first).
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT hdc13_test.expect_error('REPEATABLE READ: HDC13_ISOLATION', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc')), '25000', 'HDC13_ISOLATION');
COMMIT;
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT hdc13_test.expect_error('SERIALIZABLE: HDC13_ISOLATION', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc')), '25000', 'HDC13_ISOLATION');
COMMIT;
BEGIN ISOLATION LEVEL READ UNCOMMITTED;
SELECT hdc13_test.expect_error('READ UNCOMMITTED (another level name): HDC13_ISOLATION', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc')), '25000', 'HDC13_ISOLATION');
COMMIT;
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT hdc13_test.expect_error('a non-commissioner under REPEATABLE READ is refused as not the commissioner first', hdc13_test.rpc('authenticated', :participant, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
COMMIT;
SELECT hdc13_test.check('no isolation-refused request wrote a row', hdc13_test.rows() = 0);

-- =====================================================================================================================
-- The write-access probe: withdraw with an impossible expected parent. Authorized: HDC13_STALE_CHAIN, 0 rows written.
-- =====================================================================================================================
SELECT hdc13_test.expect_error('write-access probe by the commissioner: HDC13_STALE_CHAIN', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('probe')), 'P0001', 'HDC13_STALE_CHAIN');
SELECT hdc13_test.expect_error('write-access probe by another account: HDC13_NOT_COMMISSIONER', hdc13_test.rpc('authenticated', :participant, hdc13_test.req('probe')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('write-access probe by anonymous: permission denied', hdc13_test.rpc('anonymous', NULL, hdc13_test.req('probe')), '42501');
SELECT hdc13_test.check('the write-access probes wrote 0 rows', hdc13_test.rows() = 0);

-- =====================================================================================================================
-- Cold Neon backends (HDC-13 child-branch rehearsal, finding F1). On a new backend behind the Data API the first call
-- into pg_session_jwt returns no identity although request.jwt.claims holds the verified claims, and clears
-- request.jwt.claims for the rest of the transaction; later requests on that, now warm, backend identify correctly. The
-- stand-in reproduces it ('cold') and can fail any call ('trap'). The function must identify its caller from the
-- verified claims alone, so whether the commissioner is authorized never depends on which backend serves the request.
-- =====================================================================================================================
\connect
SELECT hdc13_test.check('setup: a new backend has never set request.jwt.claims', current_setting('request.jwt.claims', true) IS NULL);
SELECT hdc13_test.expect_error('missing claims (request.jwt.claims never set on a new backend): HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', NULL, hdc13_test.req('probe')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('the commissioner''s first call on a new cold backend: the write-access probe is HDC13_STALE_CHAIN, not HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', :commissioner::text, hdc13_test.req('probe')), 'P0001', 'HDC13_STALE_CHAIN');
SELECT hdc13_test.expect_error('cold backend, the commissioner''s claims with registered claims (iat, exp) too: HDC13_STALE_CHAIN',
  hdc13_test.rpc_on('cold', (:commissioner || '{"iat":1791500000,"exp":1791503600}')::text, hdc13_test.req('probe')), 'P0001', 'HDC13_STALE_CHAIN');
SELECT hdc13_test.check('the cold-backend probes wrote 0 rows', hdc13_test.rows() = 0);

-- The stand-in reproduces the rehearsal's observations, so the cases below exercise the real failure mechanism.
SELECT hdc13_test.check('stand-in fidelity (cold): auth.user_id() returns NULL for the commissioner''s valid claims and clears request.jwt.claims for the rest of the transaction',
  hdc13_test.stand_in('cold', :commissioner::text) = jsonb_build_object('before', :commissioner::text, 'user_id', NULL, 'sqlstate', '00000', 'after', ''));
SELECT hdc13_test.check('stand-in fidelity (warm): the same claims identify the commissioner',
  hdc13_test.stand_in('warm', :commissioner::text) = jsonb_build_object('before', :commissioner::text, 'user_id', '00000000-0000-4000-8000-000000000001',
    'sqlstate', '00000', 'after', :commissioner::text));
SELECT hdc13_test.check('stand-in fidelity (trap): any auth.user_id() call fails with SQLSTATE HT000',
  hdc13_test.stand_in('trap', :commissioner::text) ->> 'sqlstate' = 'HT000');
SELECT hdc13_test.check('stand-in fidelity: on a cold backend the unchanged publication policies (auth.user_id()) show the commissioner no Pick''em week, on a warm one every week (pre-existing; a separate follow-up)',
  (hdc13_test.query_on('cold', :commissioner, 'SELECT w.season, w.week FROM public.nfl_pool_weeks w')).result = '[]'::jsonb
  AND jsonb_array_length((hdc13_test.query_on('warm', :commissioner, 'SELECT w.season, w.week FROM public.nfl_pool_weeks w')).result)
    = (SELECT count(*) FROM public.nfl_pool_weeks));

-- Everyone else is still refused on a cold backend, and no claims shape leaks a JSON or UUID error.
SELECT hdc13_test.expect_error('cold backend, an unrelated authenticated user''s claims: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', :participant::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, another admin''s claims: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', :other_admin::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
BEGIN;
UPDATE neon_auth."user" SET banned = true WHERE id = '00000000-0000-4000-8000-000000000001';
SELECT hdc13_test.expect_error('cold backend, the banned commissioner''s claims: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', :commissioner::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
ROLLBACK;
BEGIN;
UPDATE neon_auth."user" SET role = 'user' WHERE id = '00000000-0000-4000-8000-000000000001';
SELECT hdc13_test.expect_error('cold backend, the commissioner''s account without the admin role: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', :commissioner::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
ROLLBACK;
BEGIN;
UPDATE neon_auth."user" SET email = 'former.commissioner@example.com' WHERE id = '00000000-0000-4000-8000-000000000001';
SELECT hdc13_test.expect_error('cold backend, the commissioner''s account under another email: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', :commissioner::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
ROLLBACK;
SELECT hdc13_test.expect_error('cold backend, empty claims: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', '', hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, claims that are not JSON (truncated, with the commissioner''s sub): HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"', hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, claims JSON that is not valid jsonb (a \u0000 escape) with the commissioner''s sub: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', '{"sub":"00000000-0000-4000-8000-000000000001","name":"\u0000"}', hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, claims that are a JSON array holding the commissioner''s id: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', '["00000000-0000-4000-8000-000000000001"]', hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, claims without a sub: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', hdc13_test.claims(NULL)::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, a sub that is not a UUID: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', hdc13_test.claims('not-a-uuid')::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, a sub that is a JSON number: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', '{"sub":1,"role":"authenticated"}', hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, the commissioner''s id in braces (only its canonical text identifies, as before): HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', hdc13_test.claims('{00000000-0000-4000-8000-000000000001}')::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, the commissioner''s id with a trailing line break: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', hdc13_test.claims(E'00000000-0000-4000-8000-000000000001\n')::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, a well-formed sub of no account: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', hdc13_test.claims('00000000-0000-4000-8000-0000000000ff')::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('cold backend, a participant''s claims naming the commissioner''s email, admin role and id in other claims: HDC13_NOT_COMMISSIONER',
  hdc13_test.rpc_on('cold', jsonb_build_object('sub', '00000000-0000-4000-8000-000000000002', 'role', 'admin', 'email', 'djsmokke@gmail.com',
    'id', '00000000-0000-4000-8000-000000000001', 'user_id', '00000000-0000-4000-8000-000000000001')::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.check('no refused cold-backend call wrote a row', hdc13_test.rows() = 0);

-- No pg_session_jwt call at all: on a trapped backend any auth.user_id() call fails the request.
SELECT hdc13_test.expect_error('trapped backend: the commissioner''s write-access probe never calls auth.user_id() (HDC13_STALE_CHAIN)',
  hdc13_test.rpc_on('trap', :commissioner::text, hdc13_test.req('probe')), 'P0001', 'HDC13_STALE_CHAIN');
SELECT hdc13_test.expect_error('trapped backend: an unrelated user is refused without calling auth.user_id() (HDC13_NOT_COMMISSIONER)',
  hdc13_test.rpc_on('trap', :participant::text, hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('trapped backend: malformed claims are refused without calling auth.user_id() (HDC13_NOT_COMMISSIONER)',
  hdc13_test.rpc_on('trap', '{"sub":', hdc13_test.req('denkc')), '42501', 'HDC13_NOT_COMMISSIONER');

-- No identity argument: the browser cannot supply created_by (or any caller) to the function.
SELECT hdc13_test.expect_error('a request naming created_by (the commissioner''s id) matches no function: undefined function',
  hdc13_test.exec('authenticated', :participant, $$SELECT public.nfl_append_incident_ruling(p_contest_id => 'pool-center-2026-pickem', p_week => 3,
    p_away_team => 'DEN', p_home_team => 'KC', p_action => 'rule', p_consequence => 'void', p_expected_policy_revision => 1,
    p_expected_parent_ruling_id => NULL, p_incident_status => 'STATUS_POSTPONED', p_event_id => '401437900', p_evidence_source => 'nflscores2',
    p_public_note => 'Postponed by the league.', p_admin_note => NULL, created_by => '00000000-0000-4000-8000-000000000001')$$), '42883');

-- Writes on cold and trapped backends, rolled back: a whole chain and a Survivor ruling, each row created by the sub of
-- the verified claims.
BEGIN;
SELECT hdc13_test.expect_ok('cold backend: the commissioner''s first call records a Pick''em VOID ruling',
  hdc13_test.rpc_on('cold', :commissioner::text, hdc13_test.req('denkc', '{"p_admin_note":"Private: recorded on a cold backend."}')), 'cold-1');
SELECT hdc13_test.check('cold backend: created_by is the sub of the verified request.jwt.claims',
  (SELECT r.created_by = hdc13_test.commissioner() ->> 'sub' FROM hdc13_test.stored('cold-1') r));
SELECT hdc13_test.check('cold backend: the function returns the stored public row, never created_by or admin_note',
  hdc13_test.memo('cold-1') = hdc13_test.public_row('cold-1') AND NOT (hdc13_test.memo('cold-1') ?| ARRAY['created_by','admin_note'])
  AND (SELECT r.admin_note = 'Private: recorded on a cold backend.' FROM hdc13_test.stored('cold-1') r));
SELECT hdc13_test.expect_ok('cold backend: the commissioner reaffirms', hdc13_test.rpc_on('cold', :commissioner::text, hdc13_test.later('denkc', 'reaffirm', hdc13_test.id('cold-1'))), 'cold-2');
SELECT hdc13_test.expect_ok('cold backend: the commissioner withdraws', hdc13_test.rpc_on('cold', :commissioner::text, hdc13_test.later('denkc', 'withdraw', hdc13_test.id('cold-2'))), 'cold-3');
SELECT hdc13_test.expect_ok('cold backend: the commissioner re-rules', hdc13_test.rpc_on('cold', :commissioner::text, hdc13_test.later('denkc', 'rerule', hdc13_test.id('cold-3'), '{"p_consequence":"void"}')), 'cold-4');
SELECT hdc13_test.expect_ok('cold backend: the commissioner records a Survivor ruling',
  hdc13_test.rpc_on('cold', :commissioner::text, hdc13_test.req('sv', '{"p_away_team":"LV","p_home_team":"KC","p_event_id":"401547002"}')), 'cold-sv');
SELECT hdc13_test.check('cold backend: the chain reads void, void, withdrawn, void and all five rows are created by the claims'' sub',
  (SELECT string_agg(r.consequence, ',' ORDER BY r.chain_seq) = 'void,void,withdrawn,void' FROM public.nfl_incident_rulings r
     WHERE r.contest_id = 'pool-center-2026-pickem' AND r.week = 3 AND r.away_team = 'DEN' AND r.home_team = 'KC')
  AND (SELECT count(*) = 5 AND bool_and(r.created_by = '00000000-0000-4000-8000-000000000001') FROM public.nfl_incident_rulings r
     WHERE r.ruling_id IN (SELECT hdc13_test.id(k) FROM unnest(ARRAY['cold-1','cold-2','cold-3','cold-4','cold-sv']) AS k)));
ROLLBACK;
BEGIN;
SELECT hdc13_test.expect_ok('trapped backend: the commissioner records a ruling without any auth.user_id() call',
  hdc13_test.rpc_on('trap', :commissioner::text, hdc13_test.req('denkc')), 'trap-1');
SELECT hdc13_test.check('trapped backend: created_by is the sub of the verified request.jwt.claims',
  (SELECT r.created_by = '00000000-0000-4000-8000-000000000001' FROM hdc13_test.stored('trap-1') r));
ROLLBACK;
SELECT hdc13_test.check('the cold-backend and trapped-backend writes were rolled back: no ruling remains', hdc13_test.rows() = 0);

-- =====================================================================================================================
-- Authorized: Pick'em VOID, then reaffirm, withdraw and re-rule on one incident.
-- =====================================================================================================================
SELECT hdc13_test.expect_ok('the commissioner records a Pick''em VOID ruling', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('pk')), 'pk-1');
SELECT hdc13_test.check('the VOID is chain position 1 under the governing revision, with no parent',
  (SELECT r.chain_seq = 1 AND r.parent_ruling_id IS NULL AND r.consequence = 'void' AND r.policy_revision = 1 AND r.contest_type = 'pickem'
     AND r.week = 3 AND r.away_team = 'BUF' AND r.home_team = 'CIN' FROM hdc13_test.stored('pk-1') r));
SELECT hdc13_test.check('created_by is set by the server to the caller''s auth.user_id()',
  (SELECT r.created_by = '00000000-0000-4000-8000-000000000001' FROM hdc13_test.stored('pk-1') r));
SELECT hdc13_test.check('the root records the supplied evidence', (SELECT (r.incident_status, r.event_id, r.evidence_source)
  = ('STATUS_CANCELED', '401437947', 'nflscores2') FROM hdc13_test.stored('pk-1') r));
SELECT hdc13_test.check('the public note is stored trimmed', (SELECT r.public_note = 'Canceled by the league; void for this contest.' FROM hdc13_test.stored('pk-1') r));
SELECT hdc13_test.check('the private admin note keeps its newline and tab', (SELECT r.admin_note = E'Line one\n\tLine two' FROM hdc13_test.stored('pk-1') r));
SELECT hdc13_test.check('created_at is the server clock at insert', (SELECT r.created_at BETWEEN now() - interval '5 minutes' AND clock_timestamp() FROM hdc13_test.stored('pk-1') r));
SELECT hdc13_test.check('the function returns exactly the public columns of the written row',
  (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(hdc13_test.memo('pk-1')) k) = ARRAY['away_team','chain_seq','consequence','contest_id',
   'contest_type','created_at','event_id','evidence_source','home_team','incident_status','parent_ruling_id','policy_revision','public_note','ruling_id','week']);
SELECT hdc13_test.check('the function output carries no private field', NOT (hdc13_test.memo('pk-1') ?| ARRAY['created_by','admin_note']));
SELECT hdc13_test.check('the function output equals the stored public row', hdc13_test.memo('pk-1') = hdc13_test.public_row('pk-1'));

SELECT hdc13_test.expect_error('a second root with no expected parent (double click, two tabs): HDC13_STALE_CHAIN', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('pk')), 'P0001', 'HDC13_STALE_CHAIN');
SELECT hdc13_test.expect_error('a second root naming the current parent: HDC13_INVALID_TRANSITION', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('pk', jsonb_build_object('p_expected_parent_ruling_id', hdc13_test.id('pk-1')))), 'P0001', 'HDC13_INVALID_TRANSITION');
SELECT hdc13_test.expect_error('re-rule while active: HDC13_INVALID_TRANSITION', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'rerule', hdc13_test.id('pk-1'), '{"p_consequence":"void"}')), 'P0001', 'HDC13_INVALID_TRANSITION');
SELECT hdc13_test.expect_error('reaffirm supplying evidence: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'reaffirm', hdc13_test.id('pk-1'), '{"p_event_id":"401437947"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('reaffirm supplying a replacement status: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'reaffirm', hdc13_test.id('pk-1'), '{"p_incident_status":"STATUS_POSTPONED"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('reaffirm supplying an evidence source: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'reaffirm', hdc13_test.id('pk-1'), '{"p_evidence_source":"nflscores2"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('reaffirm supplying a consequence: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'reaffirm', hdc13_test.id('pk-1'), '{"p_consequence":"void"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('reaffirm naming a stale parent: HDC13_STALE_CHAIN', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'reaffirm', 999999)), 'P0001', 'HDC13_STALE_CHAIN');
SELECT hdc13_test.expect_ok('the commissioner reaffirms the VOID', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'reaffirm', hdc13_test.id('pk-1'))), 'pk-2');
SELECT hdc13_test.check('reaffirm: chain position 2, parent the root, consequence derived from the active ruling',
  (SELECT r.chain_seq = 2 AND r.parent_ruling_id = hdc13_test.id('pk-1') AND r.consequence = 'void' FROM hdc13_test.stored('pk-2') r));
SELECT hdc13_test.expect_error('withdraw without a private note: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'withdraw', hdc13_test.id('pk-2'), '{"p_admin_note":null}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('withdraw with a private note of whitespace only: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'withdraw', hdc13_test.id('pk-2'), '{"p_admin_note":" \n\t "}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('withdraw supplying a consequence: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'withdraw', hdc13_test.id('pk-2'), '{"p_consequence":"withdrawn"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_ok('the commissioner withdraws the VOID', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'withdraw', hdc13_test.id('pk-2'))), 'pk-3');
SELECT hdc13_test.check('withdraw: chain position 3 appends "withdrawn"; the earlier rows are unchanged',
  (SELECT r.chain_seq = 3 AND r.parent_ruling_id = hdc13_test.id('pk-2') AND r.consequence = 'withdrawn' FROM hdc13_test.stored('pk-3') r)
  AND hdc13_test.public_row('pk-1') = hdc13_test.memo('pk-1') AND hdc13_test.public_row('pk-2') = hdc13_test.memo('pk-2'));
SELECT hdc13_test.expect_error('withdraw twice: HDC13_INVALID_TRANSITION', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'withdraw', hdc13_test.id('pk-3'))), 'P0001', 'HDC13_INVALID_TRANSITION');
SELECT hdc13_test.expect_error('withdraw twice from a stale page: HDC13_STALE_CHAIN', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'withdraw', hdc13_test.id('pk-2'))), 'P0001', 'HDC13_STALE_CHAIN');
SELECT hdc13_test.expect_error('reaffirm after withdrawal: HDC13_INVALID_TRANSITION', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'reaffirm', hdc13_test.id('pk-3'))), 'P0001', 'HDC13_INVALID_TRANSITION');
SELECT hdc13_test.expect_error('re-rule without a private note: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'rerule', hdc13_test.id('pk-3'), '{"p_consequence":"void","p_admin_note":null}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('re-rule supplying replacement evidence: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'rerule', hdc13_test.id('pk-3'), '{"p_consequence":"void","p_event_id":"401437948"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('re-rule without a consequence: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'rerule', hdc13_test.id('pk-3'))), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_ok('the commissioner re-rules the withdrawn incident', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'rerule', hdc13_test.id('pk-3'), '{"p_consequence":"void"}')), 'pk-4');
SELECT hdc13_test.check('re-rule: chain position 4 under the same incident identity',
  (SELECT r.chain_seq = 4 AND r.parent_ruling_id = hdc13_test.id('pk-3') AND r.consequence = 'void' AND r.policy_revision = 1
     AND (r.contest_id, r.week, r.away_team, r.home_team) = ('pool-center-2026-pickem', 3, 'BUF', 'CIN') FROM hdc13_test.stored('pk-4') r));
SELECT hdc13_test.check('every later row carries the root''s status, event id and evidence source, copied by the server',
  (SELECT bool_and((r.incident_status, r.event_id, r.evidence_source) = ('STATUS_CANCELED', '401437947', 'nflscores2')) AND count(*) = 4
     FROM public.nfl_incident_rulings r WHERE r.contest_id = 'pool-center-2026-pickem' AND r.week = 3 AND r.away_team = 'BUF'));
SELECT hdc13_test.check('every chain row is created by the commissioner', (SELECT bool_and(r.created_by = '00000000-0000-4000-8000-000000000001')
  FROM public.nfl_incident_rulings r WHERE r.contest_id = 'pool-center-2026-pickem' AND r.week = 3 AND r.away_team = 'BUF'));
SELECT hdc13_test.expect_error('the write-access probe on an active chain still writes nothing: HDC13_STALE_CHAIN', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('probe', '{"p_away_team":"BUF","p_home_team":"CIN"}')), 'P0001', 'HDC13_STALE_CHAIN');
SELECT hdc13_test.check('the chain still has exactly four rows', (SELECT count(*) = 4 FROM public.nfl_incident_rulings r WHERE r.away_team = 'BUF' AND r.home_team = 'CIN'));

-- Alias normalization, boundary notes, a published game without an event id, optional private note.
SELECT hdc13_test.expect_ok('a pair published with alias codes (JAC @ WSH) is ruled on as JAX @ WAS; 500-character public note, 2000-character private note',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('pk', jsonb_build_object('p_away_team', 'JAX', 'p_home_team', 'WAS', 'p_event_id', '401437960',
    'p_public_note', repeat('x', 500), 'p_admin_note', repeat('y', 2000)))), 'pk-alias');
SELECT hdc13_test.check('the alias game is stored with canonical codes and the full-length notes',
  (SELECT r.away_team = 'JAX' AND r.home_team = 'WAS' AND length(r.public_note) = 500 AND length(r.admin_note) = 2000 FROM hdc13_test.stored('pk-alias') r));
SELECT hdc13_test.expect_ok('a published game without an event id accepts the feed''s event id; no private note',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('pk', '{"p_away_team":"NYJ","p_home_team":"NE","p_event_id":"401437999","p_admin_note":null}')), 'pk-noevent');
SELECT hdc13_test.check('an absent private note is stored as NULL', (SELECT r.admin_note IS NULL AND r.event_id = '401437999' FROM hdc13_test.stored('pk-noevent') r));

-- =====================================================================================================================
-- Authorized: Survivor.
-- =====================================================================================================================
SELECT hdc13_test.expect_ok('the commissioner records a Survivor advance_team_used ruling', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('sv')), 'sv-1');
SELECT hdc13_test.check('the Survivor ruling is stored as advance_team_used, chain position 1',
  (SELECT r.consequence = 'advance_team_used' AND r.contest_type = 'survivor' AND r.chain_seq = 1 FROM hdc13_test.stored('sv-1') r));
SELECT hdc13_test.expect_error('eliminate under an advance_team_used policy: HDC13_NOT_PERMITTED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('sv', '{"p_away_team":"LV","p_home_team":"KC","p_event_id":"401547002","p_consequence":"eliminate"}')), 'P0001', 'HDC13_NOT_PERMITTED');
SELECT hdc13_test.expect_error('void in a Survivor contest: HDC13_NOT_PERMITTED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('sv', '{"p_away_team":"LV","p_home_team":"KC","p_event_id":"401547002","p_consequence":"void"}')), 'P0001', 'HDC13_NOT_PERMITTED');
SELECT hdc13_test.expect_error('a Survivor week no locked snapshot covers: HDC13_NOT_PUBLISHED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('sv', '{"p_week":4,"p_event_id":"401547004"}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_ok('a Survivor week covered by a later locked snapshot (Week 3); a 500-character non-BMP public note',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('sv', jsonb_build_object('p_week', 3, 'p_away_team', 'DEN', 'p_home_team', 'KC', 'p_event_id', '401547003',
    'p_public_note', repeat(U&'\+01F3C8', 500)))), 'sv-3');
SELECT hdc13_test.check('the non-BMP note is 500 characters', (SELECT length(r.public_note) = 500 FROM hdc13_test.stored('sv-3') r));
SELECT hdc13_test.expect_ok('eliminate on the fixture contest whose policy is eliminate',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('sv', '{"p_contest_id":"fixture-2026-survivor-eliminate","p_consequence":"eliminate"}')), 'svx-1');
SELECT hdc13_test.check('the fixture ruling is stored as eliminate', (SELECT r.consequence = 'eliminate' FROM hdc13_test.stored('svx-1') r));
SELECT hdc13_test.expect_error('advance_team_used under an eliminate policy: HDC13_NOT_PERMITTED', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('sv', '{"p_contest_id":"fixture-2026-survivor-eliminate","p_away_team":"LV","p_home_team":"KC","p_event_id":"401547002"}')), 'P0001', 'HDC13_NOT_PERMITTED');
SELECT hdc13_test.expect_ok('commissioner_decides permits advance_team_used', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('sv', '{"p_contest_id":"fixture-2026-survivor-decides"}')), 'svd-1');
SELECT hdc13_test.expect_error('a direct flip of the active consequence (re-rule eliminate while active): HDC13_INVALID_TRANSITION', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('sv', 'rerule', hdc13_test.id('svd-1'), '{"p_contest_id":"fixture-2026-survivor-decides","p_consequence":"eliminate"}')), 'P0001', 'HDC13_INVALID_TRANSITION');
SELECT hdc13_test.expect_error('a direct flip through reaffirm (consequence eliminate): HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('sv', 'reaffirm', hdc13_test.id('svd-1'), '{"p_contest_id":"fixture-2026-survivor-decides","p_consequence":"eliminate"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_ok('withdraw the advance', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('sv', 'withdraw', hdc13_test.id('svd-1'), '{"p_contest_id":"fixture-2026-survivor-decides"}')), 'svd-2');
SELECT hdc13_test.expect_ok('re-rule eliminate after the withdrawal (commissioner_decides permits it)', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('sv', 'rerule', hdc13_test.id('svd-2'), '{"p_contest_id":"fixture-2026-survivor-decides","p_consequence":"eliminate"}')), 'svd-3');
SELECT hdc13_test.check('the commissioner_decides chain reads advance_team_used, withdrawn, eliminate, with the root evidence on every row',
  (SELECT string_agg(r.consequence, ',' ORDER BY r.chain_seq) = 'advance_team_used,withdrawn,eliminate' AND bool_and(r.event_id = '401547001' AND r.incident_status = 'STATUS_CANCELED')
     FROM public.nfl_incident_rulings r WHERE r.contest_id = 'fixture-2026-survivor-decides'));

-- =====================================================================================================================
-- MINOR-1: a withdrawal stays available after the incident's game is no longer published; reaffirm and re-rule do not.
-- Test state only: the published week or snapshot changes inside a transaction that is rolled back.
-- =====================================================================================================================
INSERT INTO hdc13_test.memo VALUES ('before-minor-1', hdc13_test.history());
BEGIN;
SELECT hdc13_test.expect_ok('MINOR-1 setup: an active Pick''em ruling on a published game (DEN @ KC, Week 3)',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('denkc')), 'm1-1');
UPDATE public.nfl_pool_weeks w SET config = jsonb_set(w.config, '{games}', (SELECT jsonb_agg(g) FROM jsonb_array_elements(w.config -> 'games') AS g
    WHERE g ->> 'away' <> 'DEN')), revision = w.revision + 1, updated_at = now()
  WHERE w.season = 2026 AND w.week = 3;
SELECT hdc13_test.check('MINOR-1 setup: Week 3 is republished without DEN @ KC',
  NOT EXISTS (SELECT 1 FROM public.nfl_pool_weeks w, jsonb_array_elements(w.config -> 'games') AS g WHERE w.season = 2026 AND w.week = 3 AND g ->> 'away' = 'DEN'));
SELECT hdc13_test.expect_error('MINOR-1: reaffirm of the active ruling after its game was unpublished: HDC13_NOT_PUBLISHED',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('denkc', 'reaffirm', hdc13_test.id('m1-1'))), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_ok('MINOR-1: withdraw after the game was unpublished succeeds',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('denkc', 'withdraw', hdc13_test.id('m1-1'))), 'm1-2');
SELECT hdc13_test.expect_error('MINOR-1: re-rule after the withdrawal while the game is still unpublished: HDC13_NOT_PUBLISHED',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('denkc', 'rerule', hdc13_test.id('m1-2'), '{"p_consequence":"void"}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.check('MINOR-1: the chain is exactly void, withdrawn with the root evidence (the refused reaffirm and re-rule wrote nothing)',
  (SELECT string_agg(r.consequence, ',' ORDER BY r.chain_seq) = 'void,withdrawn' AND bool_and(r.event_id = '401437900') FROM public.nfl_incident_rulings r
     WHERE r.contest_id = 'pool-center-2026-pickem' AND r.week = 3 AND r.away_team = 'DEN' AND r.home_team = 'KC'));
ROLLBACK;
BEGIN;
SELECT hdc13_test.expect_ok('MINOR-1 setup: an active Survivor ruling covered by the locked Week 3 snapshot (LV @ KC, Week 2)',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('sv', '{"p_away_team":"LV","p_home_team":"KC","p_event_id":"401547002"}')), 'm1-sv1');
UPDATE public.nfl_survivor_weeks w SET status = 'draft', revision = w.revision + 1, updated_at = now() WHERE w.season = 2026 AND w.week = 3;
SELECT hdc13_test.expect_error('MINOR-1: Survivor reaffirm once no locked snapshot covers the week: HDC13_NOT_PUBLISHED',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('sv', 'reaffirm', hdc13_test.id('m1-sv1'), '{"p_away_team":"LV","p_home_team":"KC"}')), 'P0001', 'HDC13_NOT_PUBLISHED');
SELECT hdc13_test.expect_ok('MINOR-1: Survivor withdraw once no locked snapshot covers the week succeeds',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('sv', 'withdraw', hdc13_test.id('m1-sv1'), '{"p_away_team":"LV","p_home_team":"KC"}')), 'm1-sv2');
SELECT hdc13_test.expect_error('MINOR-1: Survivor re-rule after the withdrawal while still unpublished: HDC13_NOT_PUBLISHED',
  hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('sv', 'rerule', hdc13_test.id('m1-sv2'), '{"p_away_team":"LV","p_home_team":"KC","p_consequence":"advance_team_used"}')),
  'P0001', 'HDC13_NOT_PUBLISHED');
ROLLBACK;
SELECT hdc13_test.check('MINOR-1: rolled back: the ruling history, the published weeks and the snapshots are exactly as before',
  hdc13_test.history() = hdc13_test.memo('before-minor-1'));

-- =====================================================================================================================
-- Privacy: created_by and admin_note stay private; public_note is public.
-- =====================================================================================================================
SELECT hdc13_test.expect_error('authenticated cannot read created_by', hdc13_test.query('authenticated', :commissioner, 'SELECT created_by FROM public.nfl_incident_rulings'), '42501');
SELECT hdc13_test.expect_error('authenticated cannot read admin_note', hdc13_test.query('authenticated', :commissioner, 'SELECT admin_note FROM public.nfl_incident_rulings'), '42501');
SELECT hdc13_test.expect_error('anonymous cannot read created_by', hdc13_test.query('anonymous', NULL, 'SELECT created_by FROM public.nfl_incident_rulings'), '42501');
SELECT hdc13_test.expect_error('anonymous cannot read admin_note', hdc13_test.query('anonymous', NULL, 'SELECT admin_note FROM public.nfl_incident_rulings'), '42501');
SELECT hdc13_test.expect_error('anonymous cannot select * (it names the private columns)', hdc13_test.query('anonymous', NULL, 'SELECT * FROM public.nfl_incident_rulings'), '42501');
SELECT hdc13_test.check('anonymous reads the public note of the ruling',
  (hdc13_test.query('anonymous', NULL, format('SELECT r.public_note FROM public.nfl_incident_rulings r WHERE r.ruling_id = %s', hdc13_test.id('pk-1')))).result
  = '[{"public_note": "Canceled by the league; void for this contest."}]'::jsonb);
SELECT hdc13_test.check('anonymous reads the public columns of every chain row, exactly as the function returned them',
  (hdc13_test.query('anonymous', NULL, 'SELECT r.ruling_id, r.contest_id, r.contest_type, r.week, r.away_team, r.home_team, r.policy_revision, r.chain_seq,
     r.parent_ruling_id, r.consequence, r.incident_status, r.event_id, r.evidence_source, r.public_note, r.created_at FROM public.nfl_incident_rulings r
     WHERE r.away_team = ''BUF'' AND r.home_team = ''CIN'' ORDER BY r.chain_seq')).result
  = jsonb_build_array(hdc13_test.memo('pk-1'), hdc13_test.memo('pk-2'), hdc13_test.memo('pk-3'), hdc13_test.memo('pk-4')));
SELECT hdc13_test.check('no function output carries a private field', NOT EXISTS (SELECT 1 FROM hdc13_test.memo m WHERE m.value ?| ARRAY['created_by','admin_note']));

-- The HDC-12 append-only guard still applies to the owner itself.
SELECT hdc13_test.expect_error('the owner still cannot UPDATE a ruling (HDC-12 append-only trigger)', hdc13_test.exec('nfl_pool_owner', NULL, 'UPDATE public.nfl_incident_rulings SET public_note = ''changed'''), '23001');
SELECT hdc13_test.expect_error('the owner still cannot DELETE a ruling (HDC-12 append-only trigger)', hdc13_test.exec('nfl_pool_owner', NULL, 'DELETE FROM public.nfl_incident_rulings'), '23001');

-- =====================================================================================================================
-- Kill switch and removal: REVOKE gives permission denied; DROP leaves the history intact. Both rolled back.
-- =====================================================================================================================
\if :has_fn
BEGIN;
SET LOCAL ROLE nfl_pool_owner;
REVOKE EXECUTE ON FUNCTION public.nfl_append_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text, text, text, text) FROM authenticated;
RESET ROLE;
SELECT hdc13_test.expect_error('kill switch: after REVOKE EXECUTE FROM authenticated the commissioner gets permission denied', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('probe')), '42501');
ROLLBACK;
SELECT hdc13_test.expect_error('the kill switch rolled back: the probe is answered again', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('probe')), 'P0001', 'HDC13_STALE_CHAIN');
BEGIN;
CREATE TEMP TABLE hdc13_history ON COMMIT DROP AS
  SELECT count(*) AS n, md5(string_agg(to_jsonb(r)::text, '|' ORDER BY r.ruling_id)) AS digest FROM public.nfl_incident_rulings r;
SET LOCAL ROLE nfl_pool_owner;
DROP FUNCTION public.nfl_append_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text, text, text, text);
RESET ROLE;
SELECT hdc13_test.check('DROP FUNCTION removes the write path', to_regprocedure(:'fn') IS NULL);
SELECT hdc13_test.check('DROP FUNCTION leaves every ruling row in place, byte for byte',
  (SELECT h.n = (SELECT count(*) FROM public.nfl_incident_rulings) AND h.digest = (SELECT md5(string_agg(to_jsonb(r)::text, '|' ORDER BY r.ruling_id)) FROM public.nfl_incident_rulings r) FROM hdc13_history h));
SELECT hdc13_test.check('after DROP the public history still reads', (hdc13_test.query('anonymous', NULL, 'SELECT r.ruling_id, r.consequence FROM public.nfl_incident_rulings r')).sqlstate = '00000');
SELECT hdc13_test.expect_error('after DROP a call fails as an undefined function', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('probe')), '42883');
ROLLBACK;
\else
SELECT hdc13_test.check('kill switch: after REVOKE EXECUTE FROM authenticated the commissioner gets permission denied', false, 'the function does not exist');
SELECT hdc13_test.check('the kill switch rolled back: the probe is answered again', false, 'the function does not exist');
SELECT hdc13_test.check('DROP FUNCTION removes the write path', false, 'the function does not exist');
SELECT hdc13_test.check('DROP FUNCTION leaves every ruling row in place, byte for byte', false, 'the function does not exist');
SELECT hdc13_test.check('after DROP the public history still reads', false, 'the function does not exist');
SELECT hdc13_test.check('after DROP a call fails as an undefined function', false, 'the function does not exist');
\endif
SELECT hdc13_test.check('the function exists again after the rolled-back DROP', to_regprocedure(:'fn') IS NOT NULL);

-- =====================================================================================================================
-- HDC-14: absent-game adjudication (migration 005). A game proved by a locked published Pick'em week (Survivor: a locked
-- snapshot covering the week and the same-week locked Pick'em slate) whose original week's feed no longer lists it, attested
-- absent by the commissioner, through public.nfl_append_absent_incident_ruling. Its evidence is server-derived and never a
-- feed fact: incident_status STATUS_ABSENT, evidence_source commissioner-attestation, event_id the original published
-- game's eventId (none: NULL). No game of another week is ever read. The function is named only through dynamic SQL,
-- to_regprocedure or \if :has_absent_fn, so a missing function is an assertion failure, never an aborted script.
-- =====================================================================================================================

-- One Data API call of the absent-game RPC: claims for this transaction, SET LOCAL ROLE, the 10 named arguments (a
-- missing key is NULL).
CREATE FUNCTION hdc13_test.arpc(p_role text, p_claims jsonb, p_args jsonb) RETURNS hdc13_test.outcome LANGUAGE plpgsql AS $$
DECLARE
  v jsonb;
  s text;
  m text;
  h text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims::text, ''), true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE 'SELECT public.nfl_append_absent_incident_ruling($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)' INTO v
      USING p_args->>'p_contest_id', (p_args->>'p_week')::integer, p_args->>'p_away_team', p_args->>'p_home_team',
            p_args->>'p_action', p_args->>'p_consequence', (p_args->>'p_expected_policy_revision')::integer,
            (p_args->>'p_expected_parent_ruling_id')::bigint, p_args->>'p_public_note', p_args->>'p_admin_note';
    RESET ROLE;
    RETURN ROW('00000', NULL, NULL, v)::hdc13_test.outcome;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT, h = PG_EXCEPTION_HINT;
    RETURN ROW(s, m, NULLIF(h, ''), NULL)::hdc13_test.outcome;
  END;
END
$$;
-- The same call as authenticated on a backend whose pg_session_jwt stand-in is in the given state (see rpc_on).
CREATE FUNCTION hdc13_test.arpc_on(p_backend text, p_claims text, p_args jsonb) RETURNS hdc13_test.outcome LANGUAGE plpgsql AS $$
DECLARE
  v jsonb;
  s text;
  m text;
  h text;
BEGIN
  PERFORM set_config('hdc13_test.jwt_backend', p_backend, true);
  IF p_claims IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', p_claims, true);
  END IF;
  BEGIN
    SET LOCAL ROLE authenticated;
    EXECUTE 'SELECT public.nfl_append_absent_incident_ruling($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)' INTO v
      USING p_args->>'p_contest_id', (p_args->>'p_week')::integer, p_args->>'p_away_team', p_args->>'p_home_team',
            p_args->>'p_action', p_args->>'p_consequence', (p_args->>'p_expected_policy_revision')::integer,
            (p_args->>'p_expected_parent_ruling_id')::bigint, p_args->>'p_public_note', p_args->>'p_admin_note';
    RESET ROLE;
    RETURN ROW('00000', NULL, NULL, v)::hdc13_test.outcome;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT, h = PG_EXCEPTION_HINT;
    RETURN ROW(s, m, NULLIF(h, ''), NULL)::hdc13_test.outcome;
  END;
END
$$;
-- An error with exactly this SQLSTATE and no HDC-13 or HDC-14 token at all (PostgreSQL's own permission, lookup or
-- integrity error), optionally naming a constraint.
CREATE FUNCTION hdc13_test.expect_plain_error(p_name text, o hdc13_test.outcome, p_sqlstate text, p_names text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM hdc13_test.check(p_name,
    o.sqlstate = p_sqlstate AND COALESCE(o.hint, '') !~ '^HDC1[34]_' AND COALESCE(o.message, '') !~ '^HDC1[34]_'
      AND (p_names IS NULL OR position(p_names IN COALESCE(o.message, '')) > 0),
    format('expected %s%s, got %s "%s" (hint %s)', p_sqlstate, COALESCE(' naming ' || p_names, ''), o.sqlstate, o.message, COALESCE(o.hint, 'none')));
END
$$;
-- A later row of an absent-game preset's incident: no consequence (the server derives it), the given expected parent and
-- a private note.
CREATE FUNCTION hdc13_test.alater(p_preset text, p_action text, p_parent bigint, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT hdc13_test.req(p_preset, jsonb_build_object('p_action', p_action, 'p_consequence', NULL, 'p_expected_parent_ruling_id', p_parent,
    'p_public_note', 'Later absent-game chain row: ' || p_action || '.', 'p_admin_note', 'Recorded by the HDC-14 SQL behavior suite.') || COALESCE(p_over, '{}'))
$$;
-- The evidence of a stored row, as one comparable value.
CREATE FUNCTION hdc13_test.evidence(p_key text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT concat_ws('|', r.incident_status, COALESCE(r.event_id, 'NULL'), COALESCE(r.evidence_source, 'NULL')) FROM hdc13_test.stored(p_key) r
$$;

INSERT INTO hdc13_test.preset VALUES
  ('apk', '{"p_contest_id":"pool-center-2026-pickem","p_week":12,"p_away_team":"PIT","p_home_team":"TEN","p_action":"rule",
    "p_consequence":"void","p_expected_policy_revision":1,"p_expected_parent_ruling_id":null,
    "p_public_note":"  PIT @ TEN left the Week 12 feed; void for this contest.  ","p_admin_note":"Absent from the Week 12 feed.\n\tChecked on nflscores2."}'),
  ('akc', '{"p_contest_id":"pool-center-2026-pickem","p_week":12,"p_away_team":"LV","p_home_team":"KC","p_action":"rule",
    "p_consequence":"void","p_expected_policy_revision":1,"p_expected_parent_ruling_id":null,
    "p_public_note":"LV @ KC left the Week 12 feed; void for this contest.","p_admin_note":null}'),
  ('asv', '{"p_contest_id":"fixture-2099-survivor","p_week":8,"p_away_team":"PIT","p_home_team":"TEN","p_action":"rule",
    "p_consequence":"advance_team_used","p_expected_policy_revision":1,"p_expected_parent_ruling_id":null,
    "p_public_note":"PIT @ TEN left the Week 8 feed; pickers advance and their team stays used.","p_admin_note":null}'),
  ('aprobe', '{"p_contest_id":"pool-center-2026-pickem","p_week":12,"p_away_team":"LV","p_home_team":"KC","p_action":"withdraw",
    "p_consequence":null,"p_expected_policy_revision":1,"p_expected_parent_ruling_id":9007199254740991,
    "p_public_note":"HDC-14 write-access check; writes nothing.","p_admin_note":"Write-access check with an impossible expected parent."}');
INSERT INTO hdc13_test.memo VALUES ('hdc14-start', jsonb_build_object('rows', hdc13_test.rows()));
CREATE FUNCTION hdc13_test.rows_since_start() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT hdc13_test.rows() - (hdc13_test.memo('hdc14-start') ->> 'rows')::bigint
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 shape: one new function, the evidence CHECKs extended, an explicit absence pairing, nothing else of HDC-12.
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hdc13_test.check('HDC-14: migration 005 created public.nfl_append_absent_incident_ruling with the 10-argument signature', :'has_absent_fn'::boolean);
SELECT hdc13_test.check('HDC-14: the HDC-13 write path is byte-identical to production (md5 of its body)',
  (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(:'fn')) = '3ba1d1115839763214c9ac24caa611bf');
SELECT hdc13_test.check('HDC-14: public holds exactly the four HDC-12 functions, the HDC-13 and the HDC-14 write paths',
  (SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace)
  = 'nfl_append_absent_incident_ruling,nfl_append_incident_ruling,nfl_contest_history_reject_change,nfl_contest_policies_check_insert,nfl_contests_check_insert,nfl_incident_rulings_check_insert');
SELECT hdc13_test.check('HDC-14: incident_status CHECK is the three feed-reported halted statuses and STATUS_ABSENT',
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.nfl_incident_rulings'::regclass AND c.conname = 'nfl_incident_rulings_incident_status_check')
  = 'CHECK ((incident_status = ANY (ARRAY[''STATUS_CANCELED''::text, ''STATUS_POSTPONED''::text, ''STATUS_SUSPENDED''::text, ''STATUS_ABSENT''::text])))');
SELECT hdc13_test.check('HDC-14: evidence_source CHECK is NULL, the two feed sources and commissioner-attestation',
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.nfl_incident_rulings'::regclass AND c.conname = 'nfl_incident_rulings_evidence_source_check')
  = 'CHECK (((evidence_source IS NULL) OR (evidence_source = ANY (ARRAY[''espn-scoreboard''::text, ''nflscores2''::text, ''commissioner-attestation''::text]))))');
SELECT hdc13_test.check('HDC-14: the pairing CHECK: STATUS_ABSENT exactly when the evidence source is commissioner-attestation',
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.nfl_incident_rulings'::regclass AND c.conname = 'nfl_incident_rulings_absence_attestation_check')
  = 'CHECK (((incident_status = ''STATUS_ABSENT''::text) = (NOT (evidence_source IS DISTINCT FROM ''commissioner-attestation''::text))))');
SELECT hdc13_test.check('HDC-14: nfl_incident_rulings keeps exactly its HDC-12 constraints, plus the pairing CHECK',
  (SELECT string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid = 'public.nfl_incident_rulings'::regclass)
  = 'nfl_incident_rulings_absence_attestation_check,nfl_incident_rulings_admin_note_check,nfl_incident_rulings_chain_position_key,nfl_incident_rulings_chain_seq_check,'
    'nfl_incident_rulings_consequence,nfl_incident_rulings_contest_fkey,nfl_incident_rulings_created_by_check,nfl_incident_rulings_event_id_check,'
    'nfl_incident_rulings_evidence_source_check,nfl_incident_rulings_first_not_withdrawn,nfl_incident_rulings_incident_status_check,nfl_incident_rulings_parent_ruling_id_fkey,'
    'nfl_incident_rulings_pkey,nfl_incident_rulings_policy_fkey,nfl_incident_rulings_public_note_check,nfl_incident_rulings_root,nfl_incident_rulings_teams,nfl_incident_rulings_week_check');
SELECT hdc13_test.check('HDC-14: the nfl_incident_rulings columns are unchanged (no column added)',
  (SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'public.nfl_incident_rulings'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
  = 'ruling_id,contest_id,contest_type,week,away_team,home_team,policy_revision,chain_seq,parent_ruling_id,consequence,incident_status,event_id,evidence_source,public_note,admin_note,created_at,created_by');

-- Grants: EXECUTE for authenticated only; the function is SECURITY DEFINER as the HDC-12 table owner.
SELECT hdc13_test.check('HDC-14: anonymous has no EXECUTE on the absent-game function', NOT has_function_privilege('anonymous', to_regprocedure(:'absent_fn'), 'EXECUTE'));
SELECT hdc13_test.check('HDC-14: authenticated has EXECUTE on the absent-game function', has_function_privilege('authenticated', to_regprocedure(:'absent_fn'), 'EXECUTE'));
SELECT hdc13_test.check('HDC-14: authenticator itself has no EXECUTE (it only SETs ROLE)', NOT has_function_privilege('authenticator', to_regprocedure(:'absent_fn'), 'EXECUTE'));
SELECT hdc13_test.check('HDC-14: PUBLIC has no EXECUTE: the ACL is exactly the owner and authenticated',
  (SELECT string_agg(g.entry, ',' ORDER BY g.entry) FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
     || ':' || a.privilege_type AS entry FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure(:'absent_fn')) g)
  = 'authenticated:EXECUTE,nfl_pool_owner:EXECUTE');
SELECT hdc13_test.check('HDC-14: the absent-game function is owned by nfl_pool_owner, the owner of the HDC-12 tables',
  (SELECT pg_get_userbyid(p.proowner) = 'nfl_pool_owner' AND p.proowner = (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.nfl_incident_rulings'::regclass)
     FROM pg_proc p WHERE p.oid = to_regprocedure(:'absent_fn')));
SELECT hdc13_test.check('HDC-14: LANGUAGE plpgsql, VOLATILE, SECURITY DEFINER, SET search_path = pg_catalog, pg_temp',
  (SELECT l.lanname = 'plpgsql' AND p.provolatile = 'v' AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = to_regprocedure(:'absent_fn')));
SELECT hdc13_test.check('HDC-14: exactly the 10 approved named arguments (no status, event id, evidence source or identity), no defaults, returns jsonb',
  (SELECT p.pronargs = 10 AND p.pronargdefaults = 0 AND p.prorettype = 'jsonb'::regtype AND p.proargnames = ARRAY['p_contest_id','p_week',
     'p_away_team','p_home_team','p_action','p_consequence','p_expected_policy_revision','p_expected_parent_ruling_id','p_public_note','p_admin_note']
     FROM pg_proc p WHERE p.oid = to_regprocedure(:'absent_fn')));
SELECT hdc13_test.check('HDC-14: no dynamic SQL in the absent-game function body',
  (SELECT p.prosrc !~* '\mexecute\M' AND p.prosrc !~* '\mformat\s*\(' FROM pg_proc p WHERE p.oid = to_regprocedure(:'absent_fn')));
SELECT hdc13_test.check('HDC-14: every table and neon_auth reference in the body is schema-qualified',
  (SELECT p.prosrc !~ '(?<!public\.)\mnfl_(contests|contest_policies|incident_rulings|pool_weeks|survivor_weeks)\M'
      AND p.prosrc !~ '(?<!neon_auth\.)"user"'
     FROM pg_proc p WHERE p.oid = to_regprocedure(:'absent_fn')));
SELECT hdc13_test.check('HDC-14: the body never calls pg_session_jwt (no auth.* reference, no user_id() call)',
  (SELECT p.prosrc !~* '\mauth\s*\.|"auth"\s*\.' AND p.prosrc !~* '\muser_id\s*\('
     FROM pg_proc p WHERE p.oid = to_regprocedure(:'absent_fn')));
SELECT hdc13_test.check('HDC-14: the body has no exception handler',
  (SELECT p.prosrc !~* '\mexception\s+when\M' FROM pg_proc p WHERE p.oid = to_regprocedure(:'absent_fn')));
SELECT hdc13_test.check('HDC-14: the body reads published rows of the ruling''s own week only: every nfl_pool_weeks read is pinned to w.week = p_week, the one week range is the Survivor snapshot''s coverage, no week arithmetic',
  (SELECT regexp_count(p.prosrc, 'public\.nfl_pool_weeks') >= 1
      AND regexp_count(p.prosrc, 'FROM public\.nfl_pool_weeks w\s+WHERE w\.season = v_season AND w\.week = p_week AND w\.status = ''locked''') = regexp_count(p.prosrc, 'public\.nfl_pool_weeks')
      AND regexp_count(p.prosrc, 'w\.week\s*(<|>|BETWEEN)') = 1
      AND p.prosrc ~ 'FROM public\.nfl_survivor_weeks w\s+WHERE w\.season = v_season AND w\.week >= p_week AND w\.status = ''locked'''
      AND p.prosrc !~ 'p_week\s*[-+]'
     FROM pg_proc p WHERE p.oid = to_regprocedure(:'absent_fn')));

-- The absence pairing at the table: no write path, the owner included, can store an absence as a feed fact or a feed
-- status as an attestation. Rolled back.
BEGIN;
SELECT hdc13_test.expect_plain_error('HDC-14: the owner cannot store STATUS_ABSENT as an nflscores2 fact (pairing CHECK)',
  hdc13_test.exec('nfl_pool_owner', NULL, $$INSERT INTO public.nfl_incident_rulings (contest_id, contest_type, week, away_team, home_team,
    policy_revision, chain_seq, consequence, incident_status, event_id, evidence_source, public_note) VALUES ('fixture-2099-pickem', 'pickem', 8,
    'MIA', 'NE', 1, 1, 'void', 'STATUS_ABSENT', '409900807', 'nflscores2', 'direct')$$), '23514', 'nfl_incident_rulings_absence_attestation_check');
SELECT hdc13_test.expect_plain_error('HDC-14: the owner cannot store STATUS_ABSENT without its attestation source (pairing CHECK)',
  hdc13_test.exec('nfl_pool_owner', NULL, $$INSERT INTO public.nfl_incident_rulings (contest_id, contest_type, week, away_team, home_team,
    policy_revision, chain_seq, consequence, incident_status, event_id, evidence_source, public_note) VALUES ('fixture-2099-pickem', 'pickem', 8,
    'MIA', 'NE', 1, 1, 'void', 'STATUS_ABSENT', NULL, NULL, 'direct')$$), '23514', 'nfl_incident_rulings_absence_attestation_check');
SELECT hdc13_test.expect_plain_error('HDC-14: the owner cannot store a feed status (STATUS_POSTPONED) as a commissioner attestation (pairing CHECK)',
  hdc13_test.exec('nfl_pool_owner', NULL, $$INSERT INTO public.nfl_incident_rulings (contest_id, contest_type, week, away_team, home_team,
    policy_revision, chain_seq, consequence, incident_status, event_id, evidence_source, public_note) VALUES ('fixture-2099-pickem', 'pickem', 8,
    'MIA', 'NE', 1, 1, 'void', 'STATUS_POSTPONED', '409900807', 'commissioner-attestation', 'direct')$$), '23514', 'nfl_incident_rulings_absence_attestation_check');
SELECT hdc13_test.check('HDC-14: an attested absence (STATUS_ABSENT, commissioner-attestation) passes the CHECKs and the unchanged HDC-12 insert check',
  (hdc13_test.exec('nfl_pool_owner', NULL, $$INSERT INTO public.nfl_incident_rulings (contest_id, contest_type, week, away_team, home_team,
    policy_revision, chain_seq, consequence, incident_status, event_id, evidence_source, public_note) VALUES ('fixture-2099-pickem', 'pickem', 8,
    'MIA', 'NE', 1, 1, 'void', 'STATUS_ABSENT', NULL, 'commissioner-attestation', 'direct')$$)).sqlstate = '00000');
ROLLBACK;
SELECT hdc13_test.check('HDC-14: the direct table checks were rolled back (no row written)', hdc13_test.rows_since_start() = 0);

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 unauthorized callers: refused before anything else; nothing written.
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hdc13_test.expect_plain_error('HDC-14 anonymous: permission denied for the function (no EXECUTE)',
  hdc13_test.arpc('anonymous', NULL, hdc13_test.req('apk')), '42501');
SELECT hdc13_test.expect_plain_error('HDC-14 anonymous carrying the commissioner''s sub: still permission denied',
  hdc13_test.arpc('anonymous', :commissioner, hdc13_test.req('apk')), '42501');
SELECT hdc13_test.expect_plain_error('HDC-14 authenticator without SET ROLE: permission denied',
  hdc13_test.arpc('authenticator', :commissioner, hdc13_test.req('apk')), '42501');
SELECT hdc13_test.expect_error('HDC-14 an unrelated authenticated user: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', :participant, hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('HDC-14 another admin user: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', :other_admin, hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
BEGIN;
UPDATE neon_auth."user" SET banned = true WHERE id = '00000000-0000-4000-8000-000000000001';
SELECT hdc13_test.expect_error('HDC-14 the banned commissioner: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
ROLLBACK;
BEGIN;
UPDATE neon_auth."user" SET role = 'user' WHERE id = '00000000-0000-4000-8000-000000000001';
SELECT hdc13_test.expect_error('HDC-14 the commissioner''s email without the admin role: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
ROLLBACK;
BEGIN;
UPDATE neon_auth."user" SET email = 'former.commissioner@example.com' WHERE id = '00000000-0000-4000-8000-000000000001';
SELECT hdc13_test.expect_error('HDC-14 the commissioner''s account under another email: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
ROLLBACK;
SELECT hdc13_test.expect_error('HDC-14 claims without a sub: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', hdc13_test.claims(NULL), hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('HDC-14 no claims at all: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', NULL, hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('HDC-14 a sub that is not a user id: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', hdc13_test.claims('not-a-uuid'), hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('HDC-14 a well-formed sub of no account: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', hdc13_test.claims('00000000-0000-4000-8000-0000000000ff'), hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('HDC-14 a participant''s claims naming the commissioner''s email, admin role and id in other claims: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', jsonb_build_object('sub', '00000000-0000-4000-8000-000000000002', 'role', 'admin', 'email', 'djsmokke@gmail.com',
    'id', '00000000-0000-4000-8000-000000000001', 'user_id', '00000000-0000-4000-8000-000000000001'), hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('HDC-14 authorization is checked first: an invalid request from a non-commissioner is HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc('authenticated', :participant, hdc13_test.req('apk', '{"p_action":"confirm","p_week":99,"p_public_note":null}')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.check('HDC-14: no unauthorized call wrote a row', hdc13_test.rows_since_start() = 0);

-- No evidence or identity argument: the browser can supply no status, event id, evidence source or caller.
SELECT hdc13_test.expect_plain_error('HDC-14 a request naming p_incident_status (STATUS_POSTPONED) matches no function: undefined function',
  hdc13_test.exec('authenticated', :commissioner, $$SELECT public.nfl_append_absent_incident_ruling(p_contest_id => 'pool-center-2026-pickem', p_week => 12,
    p_away_team => 'PIT', p_home_team => 'TEN', p_action => 'rule', p_consequence => 'void', p_expected_policy_revision => 1,
    p_expected_parent_ruling_id => NULL, p_public_note => 'Moved.', p_admin_note => NULL, p_incident_status => 'STATUS_POSTPONED')$$), '42883');
SELECT hdc13_test.expect_plain_error('HDC-14 a request naming p_event_id (the makeup event) matches no function: undefined function',
  hdc13_test.exec('authenticated', :commissioner, $$SELECT public.nfl_append_absent_incident_ruling(p_contest_id => 'pool-center-2026-pickem', p_week => 12,
    p_away_team => 'PIT', p_home_team => 'TEN', p_action => 'rule', p_consequence => 'void', p_expected_policy_revision => 1,
    p_expected_parent_ruling_id => NULL, p_public_note => 'Moved.', p_admin_note => NULL, p_event_id => '401438199')$$), '42883');
SELECT hdc13_test.expect_plain_error('HDC-14 a request naming p_evidence_source (nflscores2) matches no function: undefined function',
  hdc13_test.exec('authenticated', :commissioner, $$SELECT public.nfl_append_absent_incident_ruling(p_contest_id => 'pool-center-2026-pickem', p_week => 12,
    p_away_team => 'PIT', p_home_team => 'TEN', p_action => 'rule', p_consequence => 'void', p_expected_policy_revision => 1,
    p_expected_parent_ruling_id => NULL, p_public_note => 'Moved.', p_admin_note => NULL, p_evidence_source => 'nflscores2')$$), '42883');
SELECT hdc13_test.expect_plain_error('HDC-14 a request naming created_by (the commissioner''s id) matches no function: undefined function',
  hdc13_test.exec('authenticated', :participant, $$SELECT public.nfl_append_absent_incident_ruling(p_contest_id => 'pool-center-2026-pickem', p_week => 12,
    p_away_team => 'PIT', p_home_team => 'TEN', p_action => 'rule', p_consequence => 'void', p_expected_policy_revision => 1,
    p_expected_parent_ruling_id => NULL, p_public_note => 'Moved.', p_admin_note => NULL, created_by => '00000000-0000-4000-8000-000000000001')$$), '42883');

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 input validation (the commissioner): nothing is written for any refused request.
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hdc13_test.expect_error('HDC-14 an unknown action: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_action":"confirm"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 a wrong contest: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_contest_id":"pool-center-2025-pickem"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 no contest: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_contest_id":null}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 week 0: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_week":0}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 week 23: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_week":23}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 no week: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_week":null}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 an alias team code (JAC) is not a canonical code: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"JAC","p_home_team":"WAS"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 a lower-case team code: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"pit"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 the same team twice: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_home_team":"PIT"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 no expected policy revision: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_expected_policy_revision":null}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 a non-positive expected parent: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_expected_parent_ruling_id":0}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 consequence "advance" is outside the vocabulary: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_consequence":"advance"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 consequence "forfeit" is outside the vocabulary: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_consequence":"forfeit"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 consequence "withdrawn" is a chain action, not a ruling: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_consequence":"withdrawn"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 a first ruling without a consequence: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_consequence":null}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 reaffirm supplying a consequence: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_action":"reaffirm","p_consequence":"void"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 withdraw supplying a consequence: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('aprobe', '{"p_consequence":"withdrawn"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 withdraw without a private note: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('aprobe', '{"p_admin_note":null}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 re-rule without a private note: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_action":"rerule","p_admin_note":" \n\t "}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 Pick''em eliminate is not permitted (policy void): HDC14_NOT_PERMITTED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_consequence":"eliminate"}')), 'P0001', 'HDC14_NOT_PERMITTED');
SELECT hdc13_test.expect_error('HDC-14 public note missing: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_public_note":null}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 public note of spaces only: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_public_note":"    "}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 public note of 501 characters: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', jsonb_build_object('p_public_note', repeat('x', 501)))), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 public note with a newline: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_public_note":"Two\nlines"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 public note with a tab: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_public_note":"Tab\there"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 public note with a Unicode line separator: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_public_note":"Line\u2028separator"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 admin note of 2001 characters: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', jsonb_build_object('p_admin_note', repeat('y', 2001)))), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 admin note with a control character: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_admin_note":"Bell\u0007"}')), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 a wrong policy revision: HDC14_STALE_POLICY', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_expected_policy_revision":2}')), 'P0001', 'HDC14_STALE_POLICY');
SELECT hdc13_test.check('HDC-14: no refused request wrote a row', hdc13_test.rows_since_start() = 0);

-- Isolation: READ COMMITTED only (authorization still first).
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT hdc13_test.expect_error('HDC-14 REPEATABLE READ: HDC14_ISOLATION', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk')), '25000', 'HDC14_ISOLATION');
COMMIT;
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT hdc13_test.expect_error('HDC-14 SERIALIZABLE: HDC14_ISOLATION', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk')), '25000', 'HDC14_ISOLATION');
COMMIT;
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT hdc13_test.expect_error('HDC-14 a non-commissioner under REPEATABLE READ is refused as not the commissioner first', hdc13_test.arpc('authenticated', :participant, hdc13_test.req('apk')), '42501', 'HDC14_NOT_COMMISSIONER');
COMMIT;

-- The write-access probe: withdraw with an impossible expected parent writes nothing.
SELECT hdc13_test.expect_error('HDC-14 write-access probe by the commissioner: HDC14_STALE_CHAIN', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('aprobe')), 'P0001', 'HDC14_STALE_CHAIN');
SELECT hdc13_test.expect_error('HDC-14 write-access probe by another account: HDC14_NOT_COMMISSIONER', hdc13_test.arpc('authenticated', :participant, hdc13_test.req('aprobe')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.expect_plain_error('HDC-14 write-access probe by anonymous: permission denied', hdc13_test.arpc('anonymous', NULL, hdc13_test.req('aprobe')), '42501');
SELECT hdc13_test.check('HDC-14: the write-access probes and isolation refusals wrote 0 rows', hdc13_test.rows_since_start() = 0);

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 cold and trapped Neon backends: the caller is the verified sub alone; pg_session_jwt is never called.
-- ---------------------------------------------------------------------------------------------------------------------
\connect
SELECT hdc13_test.expect_error('HDC-14 the commissioner''s first call on a new cold backend: the probe is HDC14_STALE_CHAIN, not HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc_on('cold', :commissioner::text, hdc13_test.req('aprobe')), 'P0001', 'HDC14_STALE_CHAIN');
SELECT hdc13_test.expect_error('HDC-14 cold backend, a participant''s claims: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc_on('cold', :participant::text, hdc13_test.req('akc')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('HDC-14 cold backend, claims that are not JSON: HDC14_NOT_COMMISSIONER',
  hdc13_test.arpc_on('cold', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"', hdc13_test.req('akc')), '42501', 'HDC14_NOT_COMMISSIONER');
SELECT hdc13_test.expect_error('HDC-14 trapped backend: the commissioner''s probe never calls auth.user_id() (HDC14_STALE_CHAIN)',
  hdc13_test.arpc_on('trap', :commissioner::text, hdc13_test.req('aprobe')), 'P0001', 'HDC14_STALE_CHAIN');
SELECT hdc13_test.expect_error('HDC-14 trapped backend: a participant is refused without calling auth.user_id() (HDC14_NOT_COMMISSIONER)',
  hdc13_test.arpc_on('trap', :participant::text, hdc13_test.req('akc')), '42501', 'HDC14_NOT_COMMISSIONER');
BEGIN;
SELECT hdc13_test.expect_ok('HDC-14 cold backend: the commissioner''s first call records an absent-game VOID',
  hdc13_test.arpc_on('cold', :commissioner::text, hdc13_test.req('akc', '{"p_admin_note":"Private: recorded on a cold backend."}')), 'acold-1');
SELECT hdc13_test.check('HDC-14 cold backend: created_by is the sub of the verified request.jwt.claims',
  (SELECT r.created_by = '00000000-0000-4000-8000-000000000001' FROM hdc13_test.stored('acold-1') r));
ROLLBACK;
BEGIN;
SELECT hdc13_test.expect_ok('HDC-14 trapped backend: the commissioner records an absent-game ruling without any auth.user_id() call',
  hdc13_test.arpc_on('trap', :commissioner::text, hdc13_test.req('akc')), 'atrap-1');
ROLLBACK;
SELECT hdc13_test.check('HDC-14: the cold-backend and trapped-backend writes were rolled back', hdc13_test.rows_since_start() = 0);

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 published data, Pick'em: the locked contest week alone proves the game; no other week is ever read.
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hdc13_test.expect_error('HDC-14 a pair the published week does not contain: HDC14_NOT_PUBLISHED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"MIA","p_home_team":"SEA"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('HDC-14 the published pair reversed (TEN @ PIT): HDC14_NOT_PUBLISHED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"TEN","p_home_team":"PIT"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('HDC-14 a pair published only in a later week (TB @ CAR, Week 13): HDC14_NOT_PUBLISHED, later weeks are never searched', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"TB","p_home_team":"CAR"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('HDC-14 a week with no published row (Week 14) while Week 13 lists PIT @ TEN: HDC14_NOT_PUBLISHED, no makeup is adopted', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_week":14}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('HDC-14 a draft week is not published: HDC14_NOT_PUBLISHED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_week":5,"p_away_team":"BUF","p_home_team":"CIN"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('HDC-14 a locked row whose configuration names another week: HDC14_NOT_PUBLISHED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_week":6,"p_away_team":"DET","p_home_team":"GB"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('HDC-14 a pair published twice in the week (a duplicate listing): HDC14_NOT_PUBLISHED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_week":4,"p_away_team":"MIA","p_home_team":"BUF"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('HDC-14 a ruled team also published in another game that week (re-paired): HDC14_NOT_PUBLISHED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_week":7,"p_away_team":"PIT","p_home_team":"CLE"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('HDC-14 a published eventId that is not an event id (40143812x) is never recorded: HDC14_NOT_PUBLISHED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"CIN","p_home_team":"CLE"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.check('HDC-14: no refused published-data request wrote a row', hdc13_test.rows_since_start() = 0);

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 authorized, Pick'em (Control C, the 2020 PIT @ TEN shape): rule, reaffirm, withdraw and re-rule on one incident.
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hdc13_test.expect_ok('HDC-14: the commissioner records an absent-game VOID for PIT @ TEN, Week 12', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk')), 'a-1');
SELECT hdc13_test.check('HDC-14: the VOID is chain position 1 under the governing revision, with no parent',
  (SELECT r.chain_seq = 1 AND r.parent_ruling_id IS NULL AND r.consequence = 'void' AND r.policy_revision = 1 AND r.contest_type = 'pickem'
     AND r.week = 12 AND r.away_team = 'PIT' AND r.home_team = 'TEN' FROM hdc13_test.stored('a-1') r));
SELECT hdc13_test.check('HDC-14: the root records the server-derived absence: STATUS_ABSENT, Week 12''s published event 401438121 (never Week 13''s makeup 401438199), commissioner-attestation',
  hdc13_test.evidence('a-1') = 'STATUS_ABSENT|401438121|commissioner-attestation');
SELECT hdc13_test.check('HDC-14: created_by is set by the server to the verified caller', (SELECT r.created_by = '00000000-0000-4000-8000-000000000001' FROM hdc13_test.stored('a-1') r));
SELECT hdc13_test.check('HDC-14: the public note is stored trimmed; the private note keeps its newline and tab',
  (SELECT r.public_note = 'PIT @ TEN left the Week 12 feed; void for this contest.' AND r.admin_note = E'Absent from the Week 12 feed.\n\tChecked on nflscores2.' FROM hdc13_test.stored('a-1') r));
SELECT hdc13_test.check('HDC-14: the function returns exactly the public columns of the written row, equal to the stored public row',
  (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(hdc13_test.memo('a-1')) k) = ARRAY['away_team','chain_seq','consequence','contest_id',
   'contest_type','created_at','event_id','evidence_source','home_team','incident_status','parent_ruling_id','policy_revision','public_note','ruling_id','week']
  AND hdc13_test.memo('a-1') = hdc13_test.public_row('a-1'));
SELECT hdc13_test.expect_error('HDC-14 a second root with no expected parent (double click, two tabs): HDC14_STALE_CHAIN', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk')), 'P0001', 'HDC14_STALE_CHAIN');
SELECT hdc13_test.expect_error('HDC-14 a second root naming the current parent: HDC14_INVALID_TRANSITION', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', jsonb_build_object('p_expected_parent_ruling_id', hdc13_test.id('a-1')))), 'P0001', 'HDC14_INVALID_TRANSITION');
SELECT hdc13_test.expect_error('HDC-14 re-rule while active: HDC14_INVALID_TRANSITION', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'rerule', hdc13_test.id('a-1'), '{"p_consequence":"void"}')), 'P0001', 'HDC14_INVALID_TRANSITION');
SELECT hdc13_test.expect_error('HDC-14 reaffirm naming a stale parent: HDC14_STALE_CHAIN', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'reaffirm', 999999)), 'P0001', 'HDC14_STALE_CHAIN');
SELECT hdc13_test.expect_ok('HDC-14: the commissioner reaffirms the absent-game VOID', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'reaffirm', hdc13_test.id('a-1'))), 'a-2');
SELECT hdc13_test.check('HDC-14 reaffirm: chain position 2, parent the root, consequence derived from the active ruling',
  (SELECT r.chain_seq = 2 AND r.parent_ruling_id = hdc13_test.id('a-1') AND r.consequence = 'void' FROM hdc13_test.stored('a-2') r));
SELECT hdc13_test.expect_ok('HDC-14: the commissioner withdraws the absent-game VOID', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'withdraw', hdc13_test.id('a-2'))), 'a-3');
SELECT hdc13_test.check('HDC-14 withdraw: chain position 3 appends "withdrawn"; the earlier rows are unchanged',
  (SELECT r.chain_seq = 3 AND r.parent_ruling_id = hdc13_test.id('a-2') AND r.consequence = 'withdrawn' FROM hdc13_test.stored('a-3') r)
  AND hdc13_test.public_row('a-1') = hdc13_test.memo('a-1') AND hdc13_test.public_row('a-2') = hdc13_test.memo('a-2'));
SELECT hdc13_test.expect_error('HDC-14 withdraw twice: HDC14_INVALID_TRANSITION', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'withdraw', hdc13_test.id('a-3'))), 'P0001', 'HDC14_INVALID_TRANSITION');
SELECT hdc13_test.expect_error('HDC-14 withdraw twice from a stale page: HDC14_STALE_CHAIN', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'withdraw', hdc13_test.id('a-2'))), 'P0001', 'HDC14_STALE_CHAIN');
SELECT hdc13_test.expect_error('HDC-14 reaffirm after withdrawal: HDC14_INVALID_TRANSITION', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'reaffirm', hdc13_test.id('a-3'))), 'P0001', 'HDC14_INVALID_TRANSITION');
SELECT hdc13_test.expect_error('HDC-14 re-rule without a consequence: HDC14_INVALID_INPUT', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'rerule', hdc13_test.id('a-3'))), '22023', 'HDC14_INVALID_INPUT');
SELECT hdc13_test.expect_ok('HDC-14: the commissioner re-rules the withdrawn absent-game incident', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'rerule', hdc13_test.id('a-3'), '{"p_consequence":"void"}')), 'a-4');
SELECT hdc13_test.check('HDC-14: the chain reads void, void, withdrawn, void; every row carries the root''s absence evidence, copied by the server, and is created by the commissioner',
  (SELECT string_agg(r.consequence, ',' ORDER BY r.chain_seq) = 'void,void,withdrawn,void'
      AND bool_and((r.incident_status, r.event_id, r.evidence_source) = ('STATUS_ABSENT', '401438121', 'commissioner-attestation'))
      AND bool_and(r.created_by = '00000000-0000-4000-8000-000000000001') AND count(*) = 4
     FROM public.nfl_incident_rulings r WHERE r.contest_id = 'pool-center-2026-pickem' AND r.week = 12 AND r.away_team = 'PIT' AND r.home_team = 'TEN'));
SELECT hdc13_test.expect_error('HDC-14 the write-access probe on an active absent-game chain still writes nothing: HDC14_STALE_CHAIN', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('aprobe', '{"p_away_team":"PIT","p_home_team":"TEN"}')), 'P0001', 'HDC14_STALE_CHAIN');
SELECT hdc13_test.check('HDC-14: the PIT @ TEN chain still has exactly four rows and no row names Week 13', (SELECT count(*) = 4 FROM public.nfl_incident_rulings r WHERE r.away_team = 'PIT' AND r.home_team = 'TEN' AND r.contest_id = 'pool-center-2026-pickem')
  AND NOT EXISTS (SELECT 1 FROM public.nfl_incident_rulings r WHERE r.week = 13 OR r.event_id = '401438199'));

-- Event evidence: a published game without an eventId (published through an absence exception) records none; alias codes.
SELECT hdc13_test.expect_ok('HDC-14: NYG @ DAL, published without an eventId, is ruled absent', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"NYG","p_home_team":"DAL","p_admin_note":null}')), 'a-nyg');
SELECT hdc13_test.check('HDC-14: no event is fabricated: event_id NULL, STATUS_ABSENT, commissioner-attestation; no private note stored', hdc13_test.evidence('a-nyg') = 'STATUS_ABSENT|NULL|commissioner-attestation'
  AND (SELECT r.admin_note IS NULL FROM hdc13_test.stored('a-nyg') r));
SELECT hdc13_test.expect_ok('HDC-14: a pair published with alias codes (JAC @ WSH) is ruled absent as JAX @ WAS', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"JAX","p_home_team":"WAS"}')), 'a-jax');
SELECT hdc13_test.check('HDC-14: the alias game is stored with canonical codes and its published event 401438123', (SELECT r.away_team = 'JAX' AND r.home_team = 'WAS' FROM hdc13_test.stored('a-jax') r)
  AND hdc13_test.evidence('a-jax') = 'STATUS_ABSENT|401438123|commissioner-attestation');

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 evidence-class ownership: one factual evidence class per incident chain.
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hdc13_test.expect_ok('HDC-14 setup (Control B): an HDC-13 STATUS_POSTPONED ruling on LAR @ ARI, Week 12', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('pk',
  '{"p_week":12,"p_away_team":"LAR","p_home_team":"ARI","p_incident_status":"STATUS_POSTPONED","p_event_id":"401438127","p_admin_note":null}')), 'f-1');
SELECT hdc13_test.expect_error('HDC-14 an absent-game root on the feed-evidence chain (no expected parent): HDC14_STALE_CHAIN', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"LAR","p_home_team":"ARI"}')), 'P0001', 'HDC14_STALE_CHAIN');
SELECT hdc13_test.expect_error('HDC-14 the absent-game path cannot withdraw a feed-evidence chain: HDC14_NOT_ABSENCE_CHAIN', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'withdraw', hdc13_test.id('f-1'), '{"p_away_team":"LAR","p_home_team":"ARI"}')), 'P0001', 'HDC14_NOT_ABSENCE_CHAIN');
SELECT hdc13_test.expect_error('HDC-14 the absent-game path cannot reaffirm a feed-evidence chain: HDC14_NOT_ABSENCE_CHAIN', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'reaffirm', hdc13_test.id('f-1'), '{"p_away_team":"LAR","p_home_team":"ARI"}')), 'P0001', 'HDC14_NOT_ABSENCE_CHAIN');
SELECT hdc13_test.expect_ok('HDC-14 setup: the HDC-13 path withdraws its own chain', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'withdraw', hdc13_test.id('f-1'), '{"p_week":12,"p_away_team":"LAR","p_home_team":"ARI"}')), 'f-2');
SELECT hdc13_test.expect_error('HDC-14 the absent-game path cannot re-rule a withdrawn feed-evidence chain: HDC14_NOT_ABSENCE_CHAIN', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('apk', 'rerule', hdc13_test.id('f-2'), '{"p_away_team":"LAR","p_home_team":"ARI","p_consequence":"void"}')), 'P0001', 'HDC14_NOT_ABSENCE_CHAIN');
SELECT hdc13_test.check('HDC-14: the feed-evidence chain stays feed evidence on every row (STATUS_POSTPONED, 401438127, nflscores2)',
  (SELECT string_agg(r.consequence, ',' ORDER BY r.chain_seq) = 'void,withdrawn' AND bool_and((r.incident_status, r.event_id, r.evidence_source) = ('STATUS_POSTPONED', '401438127', 'nflscores2'))
     FROM public.nfl_incident_rulings r WHERE r.contest_id = 'pool-center-2026-pickem' AND r.week = 12 AND r.away_team = 'LAR'));
SELECT hdc13_test.expect_error('HDC-14 the unchanged HDC-13 path cannot root an absence (STATUS_ABSENT): HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('pk',
  '{"p_week":12,"p_away_team":"MIA","p_home_team":"NE","p_incident_status":"STATUS_ABSENT","p_event_id":"401438124"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_error('HDC-14 the unchanged HDC-13 path cannot claim commissioner-attestation as feed evidence: HDC13_INVALID_INPUT', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('pk',
  '{"p_week":12,"p_away_team":"MIA","p_home_team":"NE","p_incident_status":"STATUS_POSTPONED","p_event_id":"401438124","p_evidence_source":"commissioner-attestation"}')), '22023', 'HDC13_INVALID_INPUT');
SELECT hdc13_test.expect_ok('HDC-14 setup: an absent-game VOID on IND @ HOU, Week 12', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('apk', '{"p_away_team":"IND","p_home_team":"HOU"}')), 'h-1');
SELECT hdc13_test.expect_ok('HDC-14: the frozen HDC-13 path, given an absence chain, still appends only a copy of its root (a withdrawal)', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.later('pk', 'withdraw', hdc13_test.id('h-1'), '{"p_week":12,"p_away_team":"IND","p_home_team":"HOU"}')), 'h-2');
SELECT hdc13_test.check('HDC-14: the HDC-13 row copies the absence root (STATUS_ABSENT, 401438128, commissioner-attestation): the evidence class cannot change',
  hdc13_test.evidence('h-2') = 'STATUS_ABSENT|401438128|commissioner-attestation' AND hdc13_test.evidence('h-1') = hdc13_test.evidence('h-2'));

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 Survivor: a locked snapshot covering the week and the same-week locked Pick'em slate proving the pair.
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hdc13_test.expect_ok('HDC-14: the commissioner records an absent-game advance_team_used for PIT @ TEN, Survivor Week 8', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv')), 's-1');
SELECT hdc13_test.check('HDC-14 Survivor: STATUS_ABSENT with the Week 8 slate''s event 409900801 (never Week 9''s makeup 409900999), commissioner-attestation',
  hdc13_test.evidence('s-1') = 'STATUS_ABSENT|409900801|commissioner-attestation'
  AND (SELECT r.consequence = 'advance_team_used' AND r.contest_type = 'survivor' AND r.chain_seq = 1 FROM hdc13_test.stored('s-1') r));
SELECT hdc13_test.expect_ok('HDC-14 Survivor: eliminate (commissioner_decides permits it) for SEA @ SF, Week 8', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_away_team":"SEA","p_home_team":"SF","p_consequence":"eliminate"}')), 's-2');
SELECT hdc13_test.check('HDC-14 Survivor: the eliminate root records event 409900804', hdc13_test.evidence('s-2') = 'STATUS_ABSENT|409900804|commissioner-attestation');
SELECT hdc13_test.expect_ok('HDC-14 Survivor: NYG @ DAL, on the slate without an eventId', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_away_team":"NYG","p_home_team":"DAL"}')), 's-3');
SELECT hdc13_test.check('HDC-14 Survivor: no event is fabricated', hdc13_test.evidence('s-3') = 'STATUS_ABSENT|NULL|commissioner-attestation');
SELECT hdc13_test.expect_ok('HDC-14 Survivor: a slate pair with alias codes (JAC @ WSH) as JAX @ WAS', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_away_team":"JAX","p_home_team":"WAS"}')), 's-4');
SELECT hdc13_test.expect_error('HDC-14 Survivor void: HDC14_NOT_PERMITTED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_away_team":"LAR","p_home_team":"ARI","p_consequence":"void"}')), 'P0001', 'HDC14_NOT_PERMITTED');
SELECT hdc13_test.expect_error('HDC-14 Survivor: a week no locked snapshot covers (Week 10, although its slate exists): HDC14_NOT_PUBLISHED', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_week":10,"p_away_team":"CAR","p_home_team":"ATL"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_error('HDC-14 Survivor: no same-week Pick''em slate (Week 4): HDC14_ABSENCE_NOT_ATTESTABLE', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_week":4}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
SELECT hdc13_test.expect_error('HDC-14 Survivor: the slate omits the team (the Thursday game, TB @ ATL): HDC14_ABSENCE_NOT_ATTESTABLE', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_week":5,"p_away_team":"TB","p_home_team":"ATL"}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
SELECT hdc13_test.expect_error('HDC-14 Survivor: a team the slate lists in two games (BUF): HDC14_ABSENCE_NOT_ATTESTABLE', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_week":5,"p_away_team":"BUF","p_home_team":"MIA"}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
SELECT hdc13_test.expect_error('HDC-14 Survivor: a pair the slate lists twice (LV @ LAC): HDC14_ABSENCE_NOT_ATTESTABLE', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_week":5,"p_away_team":"LV","p_home_team":"LAC"}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
SELECT hdc13_test.expect_error('HDC-14 Survivor: the slate pair reversed (DEN @ KC for KC @ DEN): HDC14_ABSENCE_NOT_ATTESTABLE', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_week":5,"p_away_team":"DEN","p_home_team":"KC"}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
SELECT hdc13_test.expect_error('HDC-14 Survivor: a draft slate is no proof (Week 3): HDC14_ABSENCE_NOT_ATTESTABLE', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_week":3,"p_away_team":"ATL","p_home_team":"CAR"}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
SELECT hdc13_test.expect_error('HDC-14 Survivor: a slate whose configuration names another week is no proof (Week 2): HDC14_ABSENCE_NOT_ATTESTABLE', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_week":2,"p_away_team":"ATL","p_home_team":"CAR"}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
SELECT hdc13_test.expect_error('HDC-14 Survivor: a slate eventId that is not an event id (CIN @ CLE): HDC14_ABSENCE_NOT_ATTESTABLE', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_away_team":"CIN","p_home_team":"CLE"}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
SELECT hdc13_test.expect_ok('HDC-14 Survivor: withdraw the PIT @ TEN advance', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('asv', 'withdraw', hdc13_test.id('s-1'))), 's-5');
SELECT hdc13_test.expect_ok('HDC-14 Survivor: re-rule eliminate after the withdrawal (commissioner_decides permits it)', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('asv', 'rerule', hdc13_test.id('s-5'), '{"p_consequence":"eliminate"}')), 's-6');
SELECT hdc13_test.check('HDC-14 Survivor: the chain reads advance_team_used, withdrawn, eliminate with the root''s absence evidence on every row',
  (SELECT string_agg(r.consequence, ',' ORDER BY r.chain_seq) = 'advance_team_used,withdrawn,eliminate'
      AND bool_and((r.incident_status, r.event_id, r.evidence_source) = ('STATUS_ABSENT', '409900801', 'commissioner-attestation'))
     FROM public.nfl_incident_rulings r WHERE r.contest_id = 'fixture-2099-survivor' AND r.week = 8 AND r.away_team = 'PIT'));
SELECT hdc13_test.check('HDC-14: the refused requests wrote nothing: 13 absent-game rows and 3 HDC-13 rows in this section',
  hdc13_test.rows_since_start() = 16);

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 MINOR-1 analogs: a withdrawal stays available whatever the published data now says; nothing else does. Test
-- state only: every change is rolled back.
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO hdc13_test.memo VALUES ('before-hdc14-minor', hdc13_test.history());
BEGIN;
SELECT hdc13_test.expect_ok('HDC-14 MINOR-1 setup: an active absent-game VOID on LV @ KC, Week 12', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('akc')), 'am-1');
UPDATE public.nfl_pool_weeks w SET config = jsonb_set(w.config, '{games}', (SELECT jsonb_agg(g) FROM jsonb_array_elements(w.config -> 'games') AS g
    WHERE g ->> 'away' <> 'LV')), revision = w.revision + 1, updated_at = now()
  WHERE w.season = 2026 AND w.week = 12;
SELECT hdc13_test.expect_error('HDC-14 MINOR-1: reaffirm once the game is no longer published: HDC14_NOT_PUBLISHED',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('akc', 'reaffirm', hdc13_test.id('am-1'))), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_ok('HDC-14 MINOR-1: withdraw once the game is no longer published succeeds',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('akc', 'withdraw', hdc13_test.id('am-1'))), 'am-2');
SELECT hdc13_test.expect_error('HDC-14 MINOR-1: re-rule while the game is still unpublished: HDC14_NOT_PUBLISHED',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('akc', 'rerule', hdc13_test.id('am-2'), '{"p_consequence":"void"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
ROLLBACK;
BEGIN;
SELECT hdc13_test.expect_ok('HDC-14 event-mismatch setup: an active absent-game VOID on LV @ KC (published event 401438130)', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('akc')), 'ae-1');
UPDATE public.nfl_pool_weeks w SET config = jsonb_set(w.config, '{games}', (SELECT jsonb_agg(CASE WHEN g ->> 'away' = 'LV' THEN jsonb_set(g, '{eventId}', '"401438999"') ELSE g END)
    FROM jsonb_array_elements(w.config -> 'games') AS g)), revision = w.revision + 1, updated_at = now()
  WHERE w.season = 2026 AND w.week = 12;
SELECT hdc13_test.expect_error('HDC-14: reaffirm after the week was republished with another event for the game: HDC14_EVENT_MISMATCH',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('akc', 'reaffirm', hdc13_test.id('ae-1'))), 'P0001', 'HDC14_EVENT_MISMATCH');
SELECT hdc13_test.expect_ok('HDC-14: withdraw after the republish succeeds and copies the root evidence',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('akc', 'withdraw', hdc13_test.id('ae-1'))), 'ae-2');
SELECT hdc13_test.check('HDC-14: the withdrawal keeps the root''s event 401438130, not the republished one', hdc13_test.evidence('ae-2') = 'STATUS_ABSENT|401438130|commissioner-attestation');
ROLLBACK;
BEGIN;
SELECT hdc13_test.expect_ok('HDC-14 MINOR-1 setup: an active Survivor absent-game advance on MIA @ NE, Week 8', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_away_team":"MIA","p_home_team":"NE"}')), 'ams-1');
UPDATE public.nfl_survivor_weeks w SET status = 'draft', revision = w.revision + 1, updated_at = now() WHERE w.season = 2099 AND w.week = 9;
SELECT hdc13_test.expect_error('HDC-14 MINOR-1: Survivor reaffirm once no locked snapshot covers the week: HDC14_NOT_PUBLISHED',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('asv', 'reaffirm', hdc13_test.id('ams-1'), '{"p_away_team":"MIA","p_home_team":"NE"}')), 'P0001', 'HDC14_NOT_PUBLISHED');
SELECT hdc13_test.expect_ok('HDC-14 MINOR-1: Survivor withdraw once no locked snapshot covers the week succeeds',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('asv', 'withdraw', hdc13_test.id('ams-1'), '{"p_away_team":"MIA","p_home_team":"NE"}')), 'ams-2');
ROLLBACK;
BEGIN;
SELECT hdc13_test.expect_ok('HDC-14 MINOR-1 setup: an active Survivor absent-game advance on MIA @ NE, Week 8 (again)', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('asv', '{"p_away_team":"MIA","p_home_team":"NE"}')), 'ams-3');
UPDATE public.nfl_pool_weeks w SET status = 'draft', revision = w.revision + 1, updated_at = now() WHERE w.season = 2099 AND w.week = 8;
SELECT hdc13_test.expect_error('HDC-14 MINOR-1: Survivor reaffirm once the same-week slate is no longer locked: HDC14_ABSENCE_NOT_ATTESTABLE',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('asv', 'reaffirm', hdc13_test.id('ams-3'), '{"p_away_team":"MIA","p_home_team":"NE"}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
SELECT hdc13_test.expect_ok('HDC-14 MINOR-1: Survivor withdraw once the same-week slate is no longer locked succeeds',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('asv', 'withdraw', hdc13_test.id('ams-3'), '{"p_away_team":"MIA","p_home_team":"NE"}')), 'ams-4');
SELECT hdc13_test.expect_error('HDC-14 MINOR-1: Survivor re-rule while the slate is unlocked: HDC14_ABSENCE_NOT_ATTESTABLE',
  hdc13_test.arpc('authenticated', :commissioner, hdc13_test.alater('asv', 'rerule', hdc13_test.id('ams-4'), '{"p_away_team":"MIA","p_home_team":"NE","p_consequence":"advance_team_used"}')), 'P0001', 'HDC14_ABSENCE_NOT_ATTESTABLE');
ROLLBACK;
SELECT hdc13_test.check('HDC-14 MINOR-1: rolled back: the ruling history, the published weeks and the snapshots are exactly as before',
  hdc13_test.history() = hdc13_test.memo('before-hdc14-minor'));

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 privacy: the absent-game rows are public through their public columns only.
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hdc13_test.check('HDC-14: anonymous reads the public columns of the absent-game chain, exactly as the function returned them',
  (hdc13_test.query('anonymous', NULL, 'SELECT r.ruling_id, r.contest_id, r.contest_type, r.week, r.away_team, r.home_team, r.policy_revision, r.chain_seq,
     r.parent_ruling_id, r.consequence, r.incident_status, r.event_id, r.evidence_source, r.public_note, r.created_at FROM public.nfl_incident_rulings r
     WHERE r.contest_id = ''pool-center-2026-pickem'' AND r.week = 12 AND r.away_team = ''PIT'' ORDER BY r.chain_seq')).result
  = jsonb_build_array(hdc13_test.memo('a-1'), hdc13_test.memo('a-2'), hdc13_test.memo('a-3'), hdc13_test.memo('a-4')));
SELECT hdc13_test.check('HDC-14: no absent-game function output carries a private field',
  NOT EXISTS (SELECT 1 FROM hdc13_test.memo m WHERE m.value ?| ARRAY['created_by','admin_note']));

-- ---------------------------------------------------------------------------------------------------------------------
-- HDC-14 kill switch and removal: REVOKE gives permission denied and leaves HDC-13 untouched; DROP leaves the history
-- (absent-game rows included) intact. Both rolled back.
-- ---------------------------------------------------------------------------------------------------------------------
\if :has_absent_fn
BEGIN;
SET LOCAL ROLE nfl_pool_owner;
REVOKE EXECUTE ON FUNCTION public.nfl_append_absent_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text) FROM authenticated;
RESET ROLE;
SELECT hdc13_test.expect_plain_error('HDC-14 kill switch: after REVOKE EXECUTE FROM authenticated the commissioner gets permission denied', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('aprobe')), '42501');
SELECT hdc13_test.expect_error('HDC-14 kill switch: the HDC-13 write path still answers its probe', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('probe')), 'P0001', 'HDC13_STALE_CHAIN');
ROLLBACK;
SELECT hdc13_test.expect_error('HDC-14 the kill switch rolled back: the absent-game probe is answered again', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('aprobe')), 'P0001', 'HDC14_STALE_CHAIN');
BEGIN;
CREATE TEMP TABLE hdc14_history ON COMMIT DROP AS
  SELECT count(*) AS n, md5(string_agg(to_jsonb(r)::text, '|' ORDER BY r.ruling_id)) AS digest FROM public.nfl_incident_rulings r;
SET LOCAL ROLE nfl_pool_owner;
DROP FUNCTION public.nfl_append_absent_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text);
RESET ROLE;
SELECT hdc13_test.check('HDC-14 DROP FUNCTION removes the absent-game write path', to_regprocedure(:'absent_fn') IS NULL);
SELECT hdc13_test.check('HDC-14 DROP FUNCTION leaves every ruling row in place, byte for byte',
  (SELECT h.n = (SELECT count(*) FROM public.nfl_incident_rulings) AND h.digest = (SELECT md5(string_agg(to_jsonb(r)::text, '|' ORDER BY r.ruling_id)) FROM public.nfl_incident_rulings r) FROM hdc14_history h));
SELECT hdc13_test.check('HDC-14 after DROP the absent-game rows still read publicly', jsonb_array_length((hdc13_test.query('anonymous', NULL,
  'SELECT r.ruling_id FROM public.nfl_incident_rulings r WHERE r.incident_status = ''STATUS_ABSENT''')).result) = 14);
SELECT hdc13_test.expect_plain_error('HDC-14 after DROP a call fails as an undefined function', hdc13_test.arpc('authenticated', :commissioner, hdc13_test.req('aprobe')), '42883');
SELECT hdc13_test.expect_error('HDC-14 after DROP the HDC-13 write path still answers its probe', hdc13_test.rpc('authenticated', :commissioner, hdc13_test.req('probe')), 'P0001', 'HDC13_STALE_CHAIN');
ROLLBACK;
\else
SELECT hdc13_test.check('HDC-14 kill switch: after REVOKE EXECUTE FROM authenticated the commissioner gets permission denied', false, 'the absent-game function does not exist');
SELECT hdc13_test.check('HDC-14 kill switch: the HDC-13 write path still answers its probe', false, 'the absent-game function does not exist');
SELECT hdc13_test.check('HDC-14 the kill switch rolled back: the absent-game probe is answered again', false, 'the absent-game function does not exist');
SELECT hdc13_test.check('HDC-14 DROP FUNCTION removes the absent-game write path', false, 'the absent-game function does not exist');
SELECT hdc13_test.check('HDC-14 DROP FUNCTION leaves every ruling row in place, byte for byte', false, 'the absent-game function does not exist');
SELECT hdc13_test.check('HDC-14 after DROP the absent-game rows still read publicly', false, 'the absent-game function does not exist');
SELECT hdc13_test.check('HDC-14 after DROP a call fails as an undefined function', false, 'the absent-game function does not exist');
SELECT hdc13_test.check('HDC-14 after DROP the HDC-13 write path still answers its probe', false, 'the absent-game function does not exist');
\endif
SELECT hdc13_test.check('HDC-14: the absent-game function exists again after the rolled-back DROP', to_regprocedure(:'absent_fn') IS NOT NULL);


\echo HDC13-PLAN 409
