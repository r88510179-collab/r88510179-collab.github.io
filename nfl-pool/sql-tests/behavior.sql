-- HDC-13 SQL behavior suite. Run as the cluster superuser, connected to nfl_pool, after neon-shape.sql, migrations
-- 001-004 and fixtures.sql. Every call of public.nfl_append_incident_ruling is made the way the Data API makes it: in its
-- own transaction, with request.jwt.claims set for the transaction and the role switched with SET LOCAL ROLE (anonymous,
-- authenticated, or authenticator itself). Each assertion reports one notice, "HDC13-TEST ok: <name>" or
-- "HDC13-TEST FAIL: <name>: <detail>"; run.sh counts them against the plan echoed at the end. A missing function is an
-- assertion failure, never an aborted script: the function is only ever named through to_regprocedure or dynamic SQL,
-- except in the two sections guarded by \if :has_fn.

\set ON_ERROR_STOP on
\set VERBOSITY terse
\o /dev/null

\set fn 'public.nfl_append_incident_ruling(text,integer,text,text,text,text,integer,bigint,text,text,text,text,text)'
SELECT to_regprocedure(:'fn') IS NOT NULL AS has_fn \gset

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
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'nfl_append_incident_ruling')
  = 'nfl_contest_history_reject_change:e8dbb29fadbaf7c236a1c8b3a030a259,nfl_contest_policies_check_insert:e79eaeb62ee5cba8f4b1580a294f7382,nfl_contests_check_insert:10dd8ce68f5ba50fccf9b15acb3f51dc,nfl_incident_rulings_check_insert:13a3f489440dc7051320a73769c06cff');
SELECT hdc13_test.check('the HDC-12 triggers on nfl_incident_rulings are unchanged',
  (SELECT string_agg(t.tgname || '>' || t.tgfoid::regproc::text, ',' ORDER BY t.tgname) FROM pg_trigger t
     WHERE t.tgrelid = 'public.nfl_incident_rulings'::regclass AND NOT t.tgisinternal)
  = 'nfl_incident_rulings_append_only>nfl_contest_history_reject_change,nfl_incident_rulings_check_insert>nfl_incident_rulings_check_insert,nfl_incident_rulings_no_truncate>nfl_contest_history_reject_change');
SELECT hdc13_test.check('public holds the four HDC-12 functions and the one HDC-13 function, nothing else',
  (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace) = 5);

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
SELECT hdc13_test.check('every table, auth and neon_auth reference in the body is schema-qualified',
  (SELECT p.prosrc !~ '(?<!public\.)\mnfl_(contests|contest_policies|incident_rulings|pool_weeks|survivor_weeks)\M'
      AND p.prosrc !~ '(?<!neon_auth\.)"user"' AND p.prosrc !~ '(?<!auth\.)\muser_id\(' AND p.prosrc ~ 'auth\.user_id\(\)'
     FROM pg_proc p WHERE p.oid = to_regprocedure(:'fn')));
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

\echo HDC13-PLAN 169
