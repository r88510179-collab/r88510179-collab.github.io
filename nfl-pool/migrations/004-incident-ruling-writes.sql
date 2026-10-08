-- Pool Center HDC-13: the commissioner incident-ruling write path.
--
-- Apply only after the matching application candidate is reviewed and approved, after migrations 002 and 003, as
-- nfl_pool_owner (the HDC-12 table owner) on a direct (not pooled) connection; then refresh the Data API schema cache, and
-- only then deploy the Admin page that calls it. The file refuses to run as any other role and verifies its own grants
-- before committing.
--
--   Admin client -> authenticated Data API RPC -> public.nfl_append_incident_ruling (SECURITY DEFINER)
--     -> one ordinary INSERT -> the unchanged HDC-12 tables and insert trigger
--
-- It creates exactly one function and changes nothing else: no table, column, policy, trigger, sequence or table grant.
-- anonymous and authenticated still cannot INSERT, UPDATE, DELETE or TRUNCATE any HDC-12 table or use its sequence; the
-- HDC-12 insert trigger stays the final structural and integrity boundary (it takes the same per-contest lock again and
-- re-checks the governing revision, the consequence, coverage, chain position, parent and event).
--
-- The function:
--   - authorizes first: the caller must be the commissioner exactly as the publication policies define it
--     (neon_auth."user".id::text = auth.user_id(), lower(email) = 'djsmokke@gmail.com', role = 'admin', not banned);
--     anyone else gets HDC13_NOT_COMMISSIONER (42501) before anything else is read or checked
--   - refuses any isolation level but READ COMMITTED (HDC13_ISOLATION, 25000)
--   - validates the request's shape (HDC13_INVALID_INPUT, 22023), then takes the per-contest advisory lock of the HDC-12
--     insert checks before deriving anything from stored rows
--   - compares, never writes, its two concurrency tokens: the governing policy revision for the week
--     (HDC13_STALE_POLICY) and the current last ruling of the incident's chain (HDC13_STALE_CHAIN), so a double click, a
--     retry, two tabs or two simultaneous actions fail safely
--   - applies the state machine EMPTY -rule-> ACTIVE -reaffirm-> ACTIVE -withdraw-> WITHDRAWN -rerule-> ACTIVE
--     (anything else is HDC13_INVALID_TRANSITION) and the governing policy's permission (HDC13_NOT_PERMITTED)
--   - checks the published Pool Center data: Pick'em, the locked week of the contest season with the pair exactly once in
--     its orientation (the canonical alias map JAC -> JAX, WSH -> WAS only), neither team in another published game, and
--     the published eventId, where the game has one, equal to the incident's root event (HDC13_NOT_PUBLISHED,
--     HDC13_EVENT_MISMATCH); Survivor, a locked snapshot of the season covering the week. The published row is read FOR
--     SHARE, so a concurrent publish of that week and the ruling are serialized. A withdrawal is not checked against
--     published data: it is always available for an active chain.
--   - derives every server value: created_by (auth.user_id()), policy_revision, chain_seq, parent_ruling_id, the
--     consequence of reaffirm (the active one) and withdraw ('withdrawn'), and, for every row after the first, the root's
--     incident_status, event_id and evidence_source (a later request that supplies any of them is refused)
--   - returns the written row's public columns as jsonb: never created_by or admin_note
-- Every refusal raises a stable token: the message starts with "<token>: " and the HINT is the token.
--
-- Kill switch (the history is unaffected):
--   REVOKE EXECUTE ON FUNCTION public.nfl_append_incident_ruling(text, integer, text, text, text, text, integer, bigint,
--     text, text, text, text, text) FROM authenticated;
-- Removal (the history is unaffected):
--   DROP FUNCTION public.nfl_append_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text,
--     text, text, text);

BEGIN;

-- Preconditions: applied as nfl_pool_owner, which owns the tables the function reads and writes, so the function's
-- SECURITY DEFINER identity is the HDC-12 table owner.
DO $$
DECLARE
  t text;
BEGIN
  IF current_user <> 'nfl_pool_owner' THEN
    RAISE EXCEPTION 'migration 004 must be applied as nfl_pool_owner, the HDC-12 table owner (current user: %)', current_user;
  END IF;
  FOREACH t IN ARRAY ARRAY['public.nfl_contests', 'public.nfl_contest_policies', 'public.nfl_incident_rulings',
                           'public.nfl_pool_weeks', 'public.nfl_survivor_weeks'] LOOP
    IF to_regclass(t) IS NULL OR (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass(t)) <> 'nfl_pool_owner' THEN
      RAISE EXCEPTION 'migration 004 needs % to exist and be owned by nfl_pool_owner', t;
    END IF;
  END LOOP;
END
$$;

CREATE FUNCTION public.nfl_append_incident_ruling(
  p_contest_id text,
  p_week integer,
  p_away_team text,
  p_home_team text,
  p_action text,
  p_consequence text,
  p_expected_policy_revision integer,
  p_expected_parent_ruling_id bigint,
  p_incident_status text,
  p_event_id text,
  p_evidence_source text,
  p_public_note text,
  p_admin_note text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_teams CONSTANT text[] := ARRAY['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC',
    'LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];
  v_caller text;
  v_invalid text;
  v_public_note text;
  v_admin_note text;
  v_contest_type text;
  v_season integer;
  v_policy_revision integer;
  v_policy text;
  v_last_id bigint;
  v_last_seq integer;
  v_last_consequence text;
  v_state text;
  v_consequence text;
  v_status text;
  v_event text;
  v_source text;
  v_config jsonb;
  v_pairs bigint;
  v_games bigint;
  v_published_event text;
  v_row record;
BEGIN
  -- 1. Authorization, before anything else is read or checked: the commissioner, exactly as the publication policies
  -- define the commissioner. The browser's email check is a convenience; this is the boundary.
  IF NOT EXISTS (
       SELECT 1 FROM neon_auth."user" u
        WHERE u.id::text = auth.user_id()
          AND pg_catalog.lower(u.email) = 'djsmokke@gmail.com'
          AND u.role = 'admin'
          AND COALESCE(u.banned, false) = false) THEN
    RAISE EXCEPTION 'HDC13_NOT_COMMISSIONER: only the commissioner can record incident rulings'
      USING ERRCODE = '42501', HINT = 'HDC13_NOT_COMMISSIONER';
  END IF;
  v_caller := auth.user_id();

  -- 2. Contest history is written only under READ COMMITTED, as the HDC-12 insert checks require.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HDC13_ISOLATION: incident rulings are written only under READ COMMITTED'
      USING ERRCODE = '25000', HINT = 'HDC13_ISOLATION';
  END IF;

  -- 3. The request's shape, before any stored row is read. The public note is trimmed of spaces and must be one line of
  -- plain text with no control character; the private note may keep tabs and line breaks and is trimmed of whitespace.
  v_public_note := pg_catalog.btrim(p_public_note);
  v_admin_note := NULLIF(pg_catalog.btrim(p_admin_note, ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13)), '');
  v_invalid := CASE
    WHEN p_action IS NULL OR p_action NOT IN ('rule', 'reaffirm', 'withdraw', 'rerule')
      THEN 'p_action must be rule, reaffirm, withdraw or rerule'
    WHEN p_contest_id IS NULL
      THEN 'p_contest_id is required'
    WHEN p_week IS NULL OR p_week NOT BETWEEN 1 AND 22
      THEN 'p_week must be a week from 1 to 22'
    WHEN p_away_team IS NULL OR p_home_team IS NULL OR NOT (p_away_team = ANY (v_teams)) OR NOT (p_home_team = ANY (v_teams))
         OR p_away_team = p_home_team
      THEN 'p_away_team and p_home_team must be two different canonical NFL team codes'
    WHEN p_expected_policy_revision IS NULL OR p_expected_policy_revision < 1
      THEN 'p_expected_policy_revision must be the governing policy revision'
    WHEN p_expected_parent_ruling_id IS NOT NULL AND p_expected_parent_ruling_id < 1
      THEN 'p_expected_parent_ruling_id must be NULL or a ruling id'
    WHEN p_action IN ('rule', 'rerule') AND (p_consequence IS NULL OR p_consequence NOT IN ('advance_team_used', 'eliminate', 'void'))
      THEN 'rule and rerule need p_consequence advance_team_used, eliminate or void'
    WHEN p_action IN ('reaffirm', 'withdraw') AND p_consequence IS NOT NULL
      THEN 'reaffirm and withdraw derive their consequence: p_consequence must be NULL'
    WHEN p_action = 'rule' AND (p_incident_status IS NULL OR p_incident_status NOT IN ('STATUS_CANCELED', 'STATUS_POSTPONED', 'STATUS_SUSPENDED'))
      THEN 'a first ruling needs p_incident_status STATUS_CANCELED, STATUS_POSTPONED or STATUS_SUSPENDED'
    WHEN p_action = 'rule' AND (p_event_id IS NULL OR p_event_id !~ '^[0-9]{1,20}$')
      THEN 'a first ruling needs p_event_id of 1 to 20 digits'
    WHEN p_action = 'rule' AND (p_evidence_source IS NULL OR p_evidence_source NOT IN ('nflscores2', 'espn-scoreboard'))
      THEN 'a first ruling needs p_evidence_source nflscores2 or espn-scoreboard'
    WHEN p_action <> 'rule' AND (p_incident_status IS NOT NULL OR p_event_id IS NOT NULL OR p_evidence_source IS NOT NULL)
      THEN 'a later row repeats the original incident evidence: p_incident_status, p_event_id and p_evidence_source must be NULL'
    WHEN p_public_note IS NULL OR p_public_note ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]' OR pg_catalog.length(v_public_note) NOT BETWEEN 1 AND 500
      THEN 'p_public_note must be one line of plain text of 1 to 500 characters'
    WHEN p_admin_note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]' OR pg_catalog.length(v_admin_note) > 2000
      THEN 'p_admin_note must be at most 2000 characters, with no control character but tabs and line breaks'
    WHEN p_action IN ('withdraw', 'rerule') AND v_admin_note IS NULL
      THEN 'withdraw and rerule need a private p_admin_note'
  END;
  IF v_invalid IS NOT NULL THEN
    RAISE EXCEPTION 'HDC13_INVALID_INPUT: %', v_invalid USING ERRCODE = '22023', HINT = 'HDC13_INVALID_INPUT';
  END IF;

  -- 4. The per-contest lock of the HDC-12 insert checks, before the policy revision, chain, parent or transition is
  -- derived. The insert trigger takes it again in this transaction.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.nfl_contest_history'), pg_catalog.hashtext(p_contest_id));

  SELECT c.contest_type, c.season INTO v_contest_type, v_season
    FROM public.nfl_contests c WHERE c.contest_id = p_contest_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HDC13_INVALID_INPUT: there is no contest %', p_contest_id USING ERRCODE = '22023', HINT = 'HDC13_INVALID_INPUT';
  END IF;

  -- 5. Compare-and-swap, first the governing policy revision of the week, then the chain's current last ruling.
  SELECT p.revision, p.halted_game_policy INTO v_policy_revision, v_policy
    FROM public.nfl_contest_policies p
   WHERE p.contest_id = p_contest_id AND p.effective_week <= p_week
   ORDER BY p.revision DESC LIMIT 1;
  IF v_policy_revision IS DISTINCT FROM p_expected_policy_revision THEN
    RAISE EXCEPTION 'HDC13_STALE_POLICY: Week % of % is governed by policy revision %, not %', p_week, p_contest_id,
      COALESCE(v_policy_revision::text, 'none'), p_expected_policy_revision USING ERRCODE = 'P0001', HINT = 'HDC13_STALE_POLICY';
  END IF;

  SELECT r.ruling_id, r.chain_seq, r.consequence INTO v_last_id, v_last_seq, v_last_consequence
    FROM public.nfl_incident_rulings r
   WHERE r.contest_id = p_contest_id AND r.week = p_week AND r.away_team = p_away_team AND r.home_team = p_home_team
     AND r.policy_revision = v_policy_revision
   ORDER BY r.chain_seq DESC LIMIT 1;
  IF v_last_id IS DISTINCT FROM p_expected_parent_ruling_id THEN
    RAISE EXCEPTION 'HDC13_STALE_CHAIN: the incident chain ends at ruling %, not %', COALESCE(v_last_id::text, 'none (no ruling)'),
      COALESCE(p_expected_parent_ruling_id::text, 'none') USING ERRCODE = 'P0001', HINT = 'HDC13_STALE_CHAIN';
  END IF;

  -- 6. The state machine: EMPTY -rule-> ACTIVE -reaffirm-> ACTIVE -withdraw-> WITHDRAWN -rerule-> ACTIVE.
  v_state := CASE WHEN v_last_id IS NULL THEN 'empty' WHEN v_last_consequence = 'withdrawn' THEN 'withdrawn' ELSE 'active' END;
  IF v_state <> (CASE p_action WHEN 'rule' THEN 'empty' WHEN 'rerule' THEN 'withdrawn' ELSE 'active' END) THEN
    RAISE EXCEPTION 'HDC13_INVALID_TRANSITION: % is not valid for an incident that is %', p_action,
      (CASE v_state WHEN 'empty' THEN 'not ruled on' ELSE v_state END) USING ERRCODE = 'P0001', HINT = 'HDC13_INVALID_TRANSITION';
  END IF;
  v_consequence := CASE p_action WHEN 'reaffirm' THEN v_last_consequence WHEN 'withdraw' THEN 'withdrawn' ELSE p_consequence END;

  -- 7. A ruling or re-ruling must be a consequence the governing policy permits for the contest type: void permits void,
  -- advance_team_used and eliminate each permit themselves, commissioner_decides permits either Survivor consequence.
  IF p_action IN ('rule', 'rerule') AND NOT (
       (v_contest_type = 'pickem' AND v_policy = 'void' AND p_consequence = 'void')
    OR (v_contest_type = 'survivor' AND p_consequence IN ('advance_team_used', 'eliminate')
        AND (v_policy = p_consequence OR v_policy = 'commissioner_decides'))) THEN
    RAISE EXCEPTION 'HDC13_NOT_PERMITTED: policy % of this % contest does not permit %', v_policy, v_contest_type, p_consequence
      USING ERRCODE = 'P0001', HINT = 'HDC13_NOT_PERMITTED';
  END IF;

  -- 8. Evidence: a first ruling records what the request supplied; every later row repeats the chain root's.
  IF p_action = 'rule' THEN
    v_status := p_incident_status;
    v_event := p_event_id;
    v_source := p_evidence_source;
  ELSE
    SELECT r.incident_status, r.event_id, r.evidence_source INTO v_status, v_event, v_source
      FROM public.nfl_incident_rulings r
     WHERE r.contest_id = p_contest_id AND r.week = p_week AND r.away_team = p_away_team AND r.home_team = p_home_team
       AND r.policy_revision = v_policy_revision AND r.chain_seq = 1;
  END IF;

  -- 9. The published Pool Center data, read FOR SHARE so a concurrent publish of the same week waits for this ruling (or
  -- this ruling waits for it and reads what it published). A withdrawal needs no published game.
  IF p_action <> 'withdraw' THEN
    IF v_contest_type = 'pickem' THEN
      SELECT w.config INTO v_config
        FROM public.nfl_pool_weeks w
       WHERE w.season = v_season AND w.week = p_week AND w.status = 'locked'
         FOR SHARE;
      IF NOT FOUND OR v_config -> 'season' IS DISTINCT FROM pg_catalog.to_jsonb(v_season)
         OR v_config -> 'week' IS DISTINCT FROM pg_catalog.to_jsonb(p_week)
         OR pg_catalog.jsonb_typeof(v_config -> 'games') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'HDC13_NOT_PUBLISHED: Week % of the % season is not a locked, published Pick''em week', p_week, v_season
          USING ERRCODE = 'P0001', HINT = 'HDC13_NOT_PUBLISHED';
      END IF;
      SELECT pg_catalog.count(*) FILTER (WHERE g.away = p_away_team AND g.home = p_home_team),
             pg_catalog.count(*) FILTER (WHERE g.away IN (p_away_team, p_home_team) OR g.home IN (p_away_team, p_home_team)),
             pg_catalog.max(g.event_id) FILTER (WHERE g.away = p_away_team AND g.home = p_home_team)
        INTO v_pairs, v_games, v_published_event
        FROM (SELECT CASE e ->> 'away' WHEN 'JAC' THEN 'JAX' WHEN 'WSH' THEN 'WAS' ELSE e ->> 'away' END AS away,
                     CASE e ->> 'home' WHEN 'JAC' THEN 'JAX' WHEN 'WSH' THEN 'WAS' ELSE e ->> 'home' END AS home,
                     e ->> 'eventId' AS event_id
                FROM pg_catalog.jsonb_array_elements(v_config -> 'games') AS e) AS g;
      IF v_pairs <> 1 OR v_games <> 1 THEN
        RAISE EXCEPTION 'HDC13_NOT_PUBLISHED: % @ % is not published exactly once, in that orientation and with no other game of its teams, in Week %',
          p_away_team, p_home_team, p_week USING ERRCODE = 'P0001', HINT = 'HDC13_NOT_PUBLISHED';
      END IF;
      IF v_published_event IS NOT NULL AND v_published_event IS DISTINCT FROM v_event THEN
        RAISE EXCEPTION 'HDC13_EVENT_MISMATCH: the published game records event %, the incident records %', v_published_event,
          COALESCE(v_event, 'none') USING ERRCODE = 'P0001', HINT = 'HDC13_EVENT_MISMATCH';
      END IF;
    ELSE
      PERFORM 1
         FROM public.nfl_survivor_weeks w
        WHERE w.season = v_season AND w.week >= p_week AND w.status = 'locked'
        LIMIT 1
          FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'HDC13_NOT_PUBLISHED: no locked Survivor snapshot of the % season covers Week %', v_season, p_week
          USING ERRCODE = 'P0001', HINT = 'HDC13_NOT_PUBLISHED';
      END IF;
    END IF;
  END IF;

  -- 10. One ordinary INSERT through the unchanged HDC-12 insert trigger; the written row's public columns are returned.
  INSERT INTO public.nfl_incident_rulings AS r (contest_id, contest_type, week, away_team, home_team, policy_revision, chain_seq,
      parent_ruling_id, consequence, incident_status, event_id, evidence_source, public_note, admin_note, created_by)
    VALUES (p_contest_id, v_contest_type, p_week, p_away_team, p_home_team, v_policy_revision, COALESCE(v_last_seq, 0) + 1,
      v_last_id, v_consequence, v_status, v_event, v_source, v_public_note, v_admin_note, v_caller)
    RETURNING r.ruling_id, r.contest_id, r.contest_type, r.week, r.away_team, r.home_team, r.policy_revision, r.chain_seq,
      r.parent_ruling_id, r.consequence, r.incident_status, r.event_id, r.evidence_source, r.public_note, r.created_at
    INTO v_row;

  RETURN pg_catalog.jsonb_build_object(
    'ruling_id', v_row.ruling_id, 'contest_id', v_row.contest_id, 'contest_type', v_row.contest_type, 'week', v_row.week,
    'away_team', v_row.away_team, 'home_team', v_row.home_team, 'policy_revision', v_row.policy_revision,
    'chain_seq', v_row.chain_seq, 'parent_ruling_id', v_row.parent_ruling_id, 'consequence', v_row.consequence,
    'incident_status', v_row.incident_status, 'event_id', v_row.event_id, 'evidence_source', v_row.evidence_source,
    'public_note', v_row.public_note, 'created_at', v_row.created_at);
END
$$;

-- PostgreSQL grants EXECUTE on a new function to PUBLIC. Clear that and anything granted to the Data API roles, then
-- grant EXECUTE to authenticated only: anonymous cannot call the function, and an authenticated caller who is not the
-- commissioner is refused inside it.
REVOKE ALL ON FUNCTION public.nfl_append_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nfl_append_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text, text, text, text) FROM anonymous;
REVOKE ALL ON FUNCTION public.nfl_append_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.nfl_append_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text, text, text, text) TO authenticated;

-- Postconditions, checked before committing: owner, security, search path, and the grant surface.
DO $$
DECLARE
  f oid := 'public.nfl_append_incident_ruling(text,integer,text,text,text,text,integer,bigint,text,text,text,text,text)'::regprocedure;
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = f) <> 'nfl_pool_owner'
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f)
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = f) IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
    RAISE EXCEPTION 'migration 004: the function must be SECURITY DEFINER, owned by nfl_pool_owner, with search_path pg_catalog, pg_temp';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = f AND a.grantee = 0)
     OR has_function_privilege('anonymous', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 004: EXECUTE must belong to authenticated only (not PUBLIC, not anonymous)';
  END IF;
  IF has_any_column_privilege('anonymous', 'public.nfl_incident_rulings', 'INSERT') OR has_any_column_privilege('authenticated', 'public.nfl_incident_rulings', 'INSERT')
     OR has_any_column_privilege('anonymous', 'public.nfl_incident_rulings', 'UPDATE') OR has_any_column_privilege('authenticated', 'public.nfl_incident_rulings', 'UPDATE')
     OR has_table_privilege('anonymous', 'public.nfl_incident_rulings', 'DELETE, TRUNCATE') OR has_table_privilege('authenticated', 'public.nfl_incident_rulings', 'DELETE, TRUNCATE')
     OR has_sequence_privilege('anonymous', 'public.nfl_incident_rulings_ruling_id_seq', 'USAGE, SELECT, UPDATE')
     OR has_sequence_privilege('authenticated', 'public.nfl_incident_rulings_ruling_id_seq', 'USAGE, SELECT, UPDATE') THEN
    RAISE EXCEPTION 'migration 004: the Data API roles must have no write privilege on nfl_incident_rulings or its sequence';
  END IF;
END
$$;

COMMIT;
