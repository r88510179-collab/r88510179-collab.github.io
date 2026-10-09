-- Pool Center HDC-14: absent-game adjudication.
--
-- A game that Pool Center's published data proves belongs to its original contest week, but that the NFL score feed no
-- longer lists in that week (the 2020 Week 4 PIT @ TEN shape: the original listing disappeared and the matchup later
-- appeared as a distinct event in another week), can be ruled on for that original week and matchup. The feed reported
-- nothing for the game, so its factual evidence is the commissioner's attestation of the absence, never a feed status:
--
--   incident_status  STATUS_ABSENT
--   evidence_source  commissioner-attestation
--   event_id         the eventId the original published game records (Pick'em: the contest's locked week; Survivor: the
--                    same-week locked Pick'em slate), or NULL when it records none. It is never supplied by the caller.
--
-- No game of another week is ever read: a later makeup listing is a separate NFL event and is never linked.
--
-- Apply only after the matching application candidate is reviewed and approved, after migrations 002, 003 and 004, as
-- nfl_pool_owner (the HDC-12 table owner) on a direct (not pooled) connection; then refresh the Data API schema cache, and
-- only then deploy the Admin page that calls it. The file refuses to run as any other role, a second time, or over any
-- HDC-12 or HDC-13 object that is not exactly as migrations 002 and 004 created it, and verifies its own result before
-- committing.
--
--   Admin client -> authenticated Data API RPC -> public.nfl_append_absent_incident_ruling (SECURITY DEFINER)
--     -> one ordinary INSERT -> the unchanged HDC-12 tables and insert trigger
--
-- It changes exactly this and nothing else: no table, column, policy, trigger, sequence or table grant changes, and the
-- HDC-12 trigger functions and the HDC-13 write path stay byte-identical.
--   - nfl_incident_rulings_incident_status_check also admits STATUS_ABSENT
--   - nfl_incident_rulings_evidence_source_check also admits commissioner-attestation
--   - the new nfl_incident_rulings_absence_attestation_check pairs them: a row is STATUS_ABSENT exactly when its evidence
--     source is commissioner-attestation, so no writer, the table owner included, can store an absence as a feed fact or
--     a feed status as an attestation
--   - the new function public.nfl_append_absent_incident_ruling, EXECUTE granted to authenticated only
-- The unchanged HDC-13 function still refuses STATUS_ABSENT and commissioner-attestation for a first ruling (its own input
-- checks). On a chain whose root is an attested absence it can only append a copy of that root's evidence, so the
-- evidence class of a chain never changes; the HDC-14 function continues only absence chains.
--
-- The function:
--   - authorizes first, exactly as the HDC-13 write path does: the caller must be the commissioner as the publication
--     policies define it (the caller's neon_auth."user" row, lower(email) = 'djsmokke@gmail.com', role = 'admin', not
--     banned); anyone else gets HDC14_NOT_COMMISSIONER (42501) before anything else is read or checked. The caller is the
--     "sub" claim of the JWT the Data API verified, read from request.jwt.claims and accepted only as the canonical text of
--     a UUID. No argument carries an identity, and pg_session_jwt is never called (on a new Neon backend its first call
--     returns no identity and clears request.jwt.claims for the rest of the transaction)
--   - refuses any isolation level but READ COMMITTED (HDC14_ISOLATION, 25000)
--   - validates the request's shape (HDC14_INVALID_INPUT, 22023). No argument carries an incident status, an event id or
--     an evidence source: every one of them is derived by the server
--   - takes the per-contest advisory lock of the HDC-12 insert checks before deriving anything from stored rows
--   - compares, never writes, its two concurrency tokens: the governing policy revision for the week
--     (HDC14_STALE_POLICY) and the current last ruling of the incident's chain (HDC14_STALE_CHAIN)
--   - applies the state machine EMPTY -rule-> ACTIVE -reaffirm-> ACTIVE -withdraw-> WITHDRAWN -rerule-> ACTIVE
--     (anything else is HDC14_INVALID_TRANSITION)
--   - continues only a chain whose first row is an attested absence (HDC14_NOT_ABSENCE_CHAIN): a chain rooted in feed
--     evidence continues through the HDC-13 write path
--   - applies the governing policy's permission (HDC14_NOT_PERMITTED)
--   - proves the game from the published Pool Center data of the incident's own week, read FOR SHARE so a concurrent
--     publish of that week and the ruling are serialized: Pick'em, the locked week of the contest season with the pair
--     exactly once in its orientation (the canonical alias map JAC -> JAX, WSH -> WAS only), neither team in another
--     published game, and its eventId, if any, an event id (HDC14_NOT_PUBLISHED); Survivor, a locked snapshot of the
--     season covering the week (HDC14_NOT_PUBLISHED) and the same-week locked Pick'em slate proving the pair the same way
--     (HDC14_ABSENCE_NOT_ATTESTABLE: the opponent is never inferred from another week, a makeup, the feed or the
--     request). A later row is refused when the published game now records an event other than the chain's
--     (HDC14_EVENT_MISMATCH). A withdrawal is not checked against published data: it is always available for an active
--     chain
--   - derives every server value: created_by (the authorized caller), policy_revision, chain_seq, parent_ruling_id, the
--     consequence of reaffirm (the active one) and withdraw ('withdrawn'), the first row's evidence (STATUS_ABSENT, the
--     published eventId or NULL, commissioner-attestation), and for every later row a copy of the first row's evidence
--   - returns the written row's public columns as jsonb: never created_by or admin_note
-- Every refusal raises a stable token: the message starts with "<token>: " and the HINT is the token.
--
-- Kill switch (the history and the HDC-13 write path are unaffected):
--   REVOKE EXECUTE ON FUNCTION public.nfl_append_absent_incident_ruling(text, integer, text, text, text, text, integer,
--     bigint, text, text) FROM authenticated;
-- Removal (the history, absent-game rows included, is unaffected):
--   DROP FUNCTION public.nfl_append_absent_incident_ruling(text, integer, text, text, text, text, integer, bigint, text,
--     text);
-- The extended CHECKs are kept after a removal: the ruling history is append-only, and an attested-absence row, once
-- written, stays valid.

BEGIN;

-- Preconditions: applied once, as nfl_pool_owner (which owns the tables the function reads and writes, so the function's
-- SECURITY DEFINER identity is the HDC-12 table owner), over the HDC-12 and HDC-13 objects exactly as migrations 002 and
-- 004 created them.
DO $$
DECLARE
  t text;
  f record;
BEGIN
  IF current_user <> 'nfl_pool_owner' THEN
    RAISE EXCEPTION 'migration 005 must be applied as nfl_pool_owner, the HDC-12 table owner (current user: %)', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'nfl_append_absent_incident_ruling')
     OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'nfl_incident_rulings_absence_attestation_check') THEN
    RAISE EXCEPTION 'migration 005 has already been applied: public.nfl_append_absent_incident_ruling or the absence pairing CHECK exists';
  END IF;
  FOREACH t IN ARRAY ARRAY['public.nfl_contests', 'public.nfl_contest_policies', 'public.nfl_incident_rulings',
                           'public.nfl_pool_weeks', 'public.nfl_survivor_weeks'] LOOP
    IF to_regclass(t) IS NULL OR (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass(t)) <> 'nfl_pool_owner' THEN
      RAISE EXCEPTION 'migration 005 needs % to exist and be owned by nfl_pool_owner', t;
    END IF;
  END LOOP;
  -- The HDC-13 write path, with its exact signature and the body migration 004 created (the production body).
  IF to_regprocedure('public.nfl_append_incident_ruling(text,integer,text,text,text,text,integer,bigint,text,text,text,text,text)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.nfl_append_incident_ruling(text,integer,text,text,text,text,integer,bigint,text,text,text,text,text)'))
        <> '3ba1d1115839763214c9ac24caa611bf'
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'nfl_append_incident_ruling') <> 1 THEN
    RAISE EXCEPTION 'migration 005 needs the HDC-13 write path public.nfl_append_incident_ruling exactly as migration 004 created it';
  END IF;
  -- The HDC-12 trigger functions, byte-identical to migration 002, and their nine triggers.
  FOR f IN SELECT * FROM (VALUES ('nfl_contest_history_reject_change', 'e8dbb29fadbaf7c236a1c8b3a030a259'),
                                 ('nfl_contests_check_insert', '10dd8ce68f5ba50fccf9b15acb3f51dc'),
                                 ('nfl_contest_policies_check_insert', 'e79eaeb62ee5cba8f4b1580a294f7382'),
                                 ('nfl_incident_rulings_check_insert', '13a3f489440dc7051320a73769c06cff')) AS v(name, digest) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f.name AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype)
       IS DISTINCT FROM f.digest THEN
      RAISE EXCEPTION 'migration 005 needs the HDC-12 trigger function public.%() exactly as migration 002 created it', f.name;
    END IF;
  END LOOP;
  IF (SELECT string_agg(c.relname || '.' || tg.tgname || ':' || p.proname || ':' || tg.tgtype::text || ':' || tg.tgenabled::text, ','
                        ORDER BY (c.relname || '.' || tg.tgname) COLLATE "C")
        FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE NOT tg.tgisinternal AND c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('nfl_contests', 'nfl_contest_policies', 'nfl_incident_rulings'))
     IS DISTINCT FROM 'nfl_contest_policies.nfl_contest_policies_append_only:nfl_contest_history_reject_change:27:O,'
       'nfl_contest_policies.nfl_contest_policies_check_insert:nfl_contest_policies_check_insert:7:O,'
       'nfl_contest_policies.nfl_contest_policies_no_truncate:nfl_contest_history_reject_change:34:O,'
       'nfl_contests.nfl_contests_append_only:nfl_contest_history_reject_change:27:O,'
       'nfl_contests.nfl_contests_check_insert:nfl_contests_check_insert:7:O,'
       'nfl_contests.nfl_contests_no_truncate:nfl_contest_history_reject_change:34:O,'
       'nfl_incident_rulings.nfl_incident_rulings_append_only:nfl_contest_history_reject_change:27:O,'
       'nfl_incident_rulings.nfl_incident_rulings_check_insert:nfl_incident_rulings_check_insert:7:O,'
       'nfl_incident_rulings.nfl_incident_rulings_no_truncate:nfl_contest_history_reject_change:34:O' THEN
    RAISE EXCEPTION 'migration 005 needs exactly the nine HDC-12 triggers of migration 002, enabled';
  END IF;
  -- The two evidence CHECKs this file extends, exactly as migration 002 created them.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.nfl_incident_rulings'::regclass AND c.conname = 'nfl_incident_rulings_incident_status_check')
     IS DISTINCT FROM 'CHECK ((incident_status = ANY (ARRAY[''STATUS_CANCELED''::text, ''STATUS_POSTPONED''::text, ''STATUS_SUSPENDED''::text])))'
     OR (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
          WHERE c.conrelid = 'public.nfl_incident_rulings'::regclass AND c.conname = 'nfl_incident_rulings_evidence_source_check')
     IS DISTINCT FROM 'CHECK (((evidence_source IS NULL) OR (evidence_source = ANY (ARRAY[''espn-scoreboard''::text, ''nflscores2''::text]))))' THEN
    RAISE EXCEPTION 'migration 005 needs the incident_status and evidence_source CHECKs exactly as migration 002 created them';
  END IF;
END
$$;

-- The explicit absence evidence: two extended CHECKs (same names) and the pairing CHECK. Existing rows are validated.
ALTER TABLE public.nfl_incident_rulings
  DROP CONSTRAINT nfl_incident_rulings_incident_status_check,
  ADD CONSTRAINT nfl_incident_rulings_incident_status_check
    CHECK (incident_status IN ('STATUS_CANCELED', 'STATUS_POSTPONED', 'STATUS_SUSPENDED', 'STATUS_ABSENT')),
  DROP CONSTRAINT nfl_incident_rulings_evidence_source_check,
  ADD CONSTRAINT nfl_incident_rulings_evidence_source_check
    CHECK (evidence_source IS NULL OR evidence_source IN ('espn-scoreboard', 'nflscores2', 'commissioner-attestation')),
  ADD CONSTRAINT nfl_incident_rulings_absence_attestation_check
    CHECK ((incident_status = 'STATUS_ABSENT') = (evidence_source IS NOT DISTINCT FROM 'commissioner-attestation'));

CREATE FUNCTION public.nfl_append_absent_incident_ruling(
  p_contest_id text,
  p_week integer,
  p_away_team text,
  p_home_team text,
  p_action text,
  p_consequence text,
  p_expected_policy_revision integer,
  p_expected_parent_ruling_id bigint,
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
  v_claims_text text;
  v_claims jsonb;
  v_caller_id uuid;
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
  v_proved boolean;
  v_pairs bigint;
  v_games bigint;
  v_published_event text;
  v_row record;
BEGIN
  -- 1. Authorization, before anything else is read or checked: the commissioner, exactly as the publication policies and
  -- the HDC-13 write path define the commissioner. The caller is the "sub" claim the Data API verified, read once from
  -- request.jwt.claims and accepted only as the canonical text of a UUID; pg_session_jwt is never called.
  v_claims_text := pg_catalog.current_setting('request.jwt.claims', true);
  IF pg_catalog.pg_input_is_valid(v_claims_text, 'pg_catalog.jsonb') THEN
    v_claims := v_claims_text::jsonb;
  END IF;
  IF pg_catalog.jsonb_typeof(v_claims) = 'object' AND pg_catalog.jsonb_typeof(v_claims -> 'sub') = 'string'
     AND (v_claims ->> 'sub') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_caller_id := (v_claims ->> 'sub')::uuid;
  END IF;
  IF v_caller_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM neon_auth."user" u
        WHERE u.id = v_caller_id
          AND pg_catalog.lower(u.email) = 'djsmokke@gmail.com'
          AND u.role = 'admin'
          AND COALESCE(u.banned, false) = false) THEN
    RAISE EXCEPTION 'HDC14_NOT_COMMISSIONER: only the commissioner can record absent-game rulings'
      USING ERRCODE = '42501', HINT = 'HDC14_NOT_COMMISSIONER';
  END IF;
  v_caller := v_caller_id::text;

  -- 2. Contest history is written only under READ COMMITTED, as the HDC-12 insert checks require.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HDC14_ISOLATION: absent-game rulings are written only under READ COMMITTED'
      USING ERRCODE = '25000', HINT = 'HDC14_ISOLATION';
  END IF;

  -- 3. The request's shape, before any stored row is read; the notes exactly as the HDC-13 write path validates them.
  -- There is no status, event or evidence-source argument: the server derives all three.
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
    WHEN p_public_note IS NULL OR p_public_note ~ '[\x01-\x1f\x7f-\x9f  ]' OR pg_catalog.length(v_public_note) NOT BETWEEN 1 AND 500
      THEN 'p_public_note must be one line of plain text of 1 to 500 characters'
    WHEN p_admin_note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]' OR pg_catalog.length(v_admin_note) > 2000
      THEN 'p_admin_note must be at most 2000 characters, with no control character but tabs and line breaks'
    WHEN p_action IN ('withdraw', 'rerule') AND v_admin_note IS NULL
      THEN 'withdraw and rerule need a private p_admin_note'
  END;
  IF v_invalid IS NOT NULL THEN
    RAISE EXCEPTION 'HDC14_INVALID_INPUT: %', v_invalid USING ERRCODE = '22023', HINT = 'HDC14_INVALID_INPUT';
  END IF;

  -- 4. The per-contest lock of the HDC-12 insert checks and the HDC-13 write path, before the policy revision, chain,
  -- parent or transition is derived. The insert trigger takes it again in this transaction.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.nfl_contest_history'), pg_catalog.hashtext(p_contest_id));

  SELECT c.contest_type, c.season INTO v_contest_type, v_season
    FROM public.nfl_contests c WHERE c.contest_id = p_contest_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HDC14_INVALID_INPUT: there is no contest %', p_contest_id USING ERRCODE = '22023', HINT = 'HDC14_INVALID_INPUT';
  END IF;

  -- 5. Compare-and-swap, first the governing policy revision of the week, then the chain's current last ruling.
  SELECT p.revision, p.halted_game_policy INTO v_policy_revision, v_policy
    FROM public.nfl_contest_policies p
   WHERE p.contest_id = p_contest_id AND p.effective_week <= p_week
   ORDER BY p.revision DESC LIMIT 1;
  IF v_policy_revision IS DISTINCT FROM p_expected_policy_revision THEN
    RAISE EXCEPTION 'HDC14_STALE_POLICY: Week % of % is governed by policy revision %, not %', p_week, p_contest_id,
      COALESCE(v_policy_revision::text, 'none'), p_expected_policy_revision USING ERRCODE = 'P0001', HINT = 'HDC14_STALE_POLICY';
  END IF;

  SELECT r.ruling_id, r.chain_seq, r.consequence INTO v_last_id, v_last_seq, v_last_consequence
    FROM public.nfl_incident_rulings r
   WHERE r.contest_id = p_contest_id AND r.week = p_week AND r.away_team = p_away_team AND r.home_team = p_home_team
     AND r.policy_revision = v_policy_revision
   ORDER BY r.chain_seq DESC LIMIT 1;
  IF v_last_id IS DISTINCT FROM p_expected_parent_ruling_id THEN
    RAISE EXCEPTION 'HDC14_STALE_CHAIN: the incident chain ends at ruling %, not %', COALESCE(v_last_id::text, 'none (no ruling)'),
      COALESCE(p_expected_parent_ruling_id::text, 'none') USING ERRCODE = 'P0001', HINT = 'HDC14_STALE_CHAIN';
  END IF;

  -- 6. The state machine: EMPTY -rule-> ACTIVE -reaffirm-> ACTIVE -withdraw-> WITHDRAWN -rerule-> ACTIVE.
  v_state := CASE WHEN v_last_id IS NULL THEN 'empty' WHEN v_last_consequence = 'withdrawn' THEN 'withdrawn' ELSE 'active' END;
  IF v_state <> (CASE p_action WHEN 'rule' THEN 'empty' WHEN 'rerule' THEN 'withdrawn' ELSE 'active' END) THEN
    RAISE EXCEPTION 'HDC14_INVALID_TRANSITION: % is not valid for an incident that is %', p_action,
      (CASE v_state WHEN 'empty' THEN 'not ruled on' ELSE v_state END) USING ERRCODE = 'P0001', HINT = 'HDC14_INVALID_TRANSITION';
  END IF;
  v_consequence := CASE p_action WHEN 'reaffirm' THEN v_last_consequence WHEN 'withdraw' THEN 'withdrawn' ELSE p_consequence END;

  -- 7. One factual evidence class per chain: a chain is continued here only when its first row is an attested absence,
  -- whose evidence every later row copies. A chain rooted in feed evidence continues through the HDC-13 write path.
  IF v_last_id IS NOT NULL THEN
    SELECT r.incident_status, r.event_id, r.evidence_source INTO v_status, v_event, v_source
      FROM public.nfl_incident_rulings r
     WHERE r.contest_id = p_contest_id AND r.week = p_week AND r.away_team = p_away_team AND r.home_team = p_home_team
       AND r.policy_revision = v_policy_revision AND r.chain_seq = 1;
    IF v_status IS DISTINCT FROM 'STATUS_ABSENT' OR v_source IS DISTINCT FROM 'commissioner-attestation' THEN
      RAISE EXCEPTION 'HDC14_NOT_ABSENCE_CHAIN: this incident''s chain records feed evidence (%), not an attested absence; it continues only through the HDC-13 ruling path',
        COALESCE(v_status, 'none') USING ERRCODE = 'P0001', HINT = 'HDC14_NOT_ABSENCE_CHAIN';
    END IF;
  END IF;

  -- 8. A ruling or re-ruling must be a consequence the governing policy permits for the contest type: void permits void,
  -- advance_team_used and eliminate each permit themselves, commissioner_decides permits either Survivor consequence.
  IF p_action IN ('rule', 'rerule') AND NOT (
       (v_contest_type = 'pickem' AND v_policy = 'void' AND p_consequence = 'void')
    OR (v_contest_type = 'survivor' AND p_consequence IN ('advance_team_used', 'eliminate')
        AND (v_policy = p_consequence OR v_policy = 'commissioner_decides'))) THEN
    RAISE EXCEPTION 'HDC14_NOT_PERMITTED: policy % of this % contest does not permit %', v_policy, v_contest_type, p_consequence
      USING ERRCODE = 'P0001', HINT = 'HDC14_NOT_PERMITTED';
  END IF;

  -- 9. The published Pool Center data of the incident's own week, read FOR SHARE so a concurrent publish of that week
  -- waits for this ruling (or this ruling waits for it and reads what it published). No other week is ever read. A
  -- withdrawal needs no published game.
  IF p_action <> 'withdraw' THEN
    IF v_contest_type = 'survivor' THEN
      PERFORM 1
         FROM public.nfl_survivor_weeks w
        WHERE w.season = v_season AND w.week >= p_week AND w.status = 'locked'
        LIMIT 1
          FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'HDC14_NOT_PUBLISHED: no locked Survivor snapshot of the % season covers Week %', v_season, p_week
          USING ERRCODE = 'P0001', HINT = 'HDC14_NOT_PUBLISHED';
      END IF;
    END IF;
    -- Pick'em: the contest's locked week. Survivor: the same-week locked Pick'em slate, the only proof of the matchup.
    SELECT w.config INTO v_config
      FROM public.nfl_pool_weeks w
     WHERE w.season = v_season AND w.week = p_week AND w.status = 'locked'
       FOR SHARE;
    v_proved := FOUND AND v_config -> 'season' IS NOT DISTINCT FROM pg_catalog.to_jsonb(v_season)
      AND v_config -> 'week' IS NOT DISTINCT FROM pg_catalog.to_jsonb(p_week)
      AND pg_catalog.jsonb_typeof(v_config -> 'games') IS NOT DISTINCT FROM 'array';
    IF v_proved THEN
      SELECT pg_catalog.count(*) FILTER (WHERE g.away = p_away_team AND g.home = p_home_team),
             pg_catalog.count(*) FILTER (WHERE g.away IN (p_away_team, p_home_team) OR g.home IN (p_away_team, p_home_team)),
             pg_catalog.max(g.event_id) FILTER (WHERE g.away = p_away_team AND g.home = p_home_team)
        INTO v_pairs, v_games, v_published_event
        FROM (SELECT CASE e ->> 'away' WHEN 'JAC' THEN 'JAX' WHEN 'WSH' THEN 'WAS' ELSE e ->> 'away' END AS away,
                     CASE e ->> 'home' WHEN 'JAC' THEN 'JAX' WHEN 'WSH' THEN 'WAS' ELSE e ->> 'home' END AS home,
                     e ->> 'eventId' AS event_id
                FROM pg_catalog.jsonb_array_elements(v_config -> 'games') AS e) AS g;
      v_proved := v_pairs = 1 AND v_games = 1 AND (v_published_event IS NULL OR v_published_event ~ '^[0-9]{1,20}$');
    END IF;
    IF NOT v_proved THEN
      IF v_contest_type = 'pickem' THEN
        RAISE EXCEPTION 'HDC14_NOT_PUBLISHED: % @ % is not one game of the locked Pick''em Week % of the % season (exactly once, in that orientation, with no other game of its teams and no malformed event id)',
          p_away_team, p_home_team, p_week, v_season USING ERRCODE = 'P0001', HINT = 'HDC14_NOT_PUBLISHED';
      END IF;
      RAISE EXCEPTION 'HDC14_ABSENCE_NOT_ATTESTABLE: the locked Pick''em slate of Week % of the % season does not prove % @ % (exactly once, in that orientation, with no other game of its teams and no malformed event id)',
        p_week, v_season, p_away_team, p_home_team USING ERRCODE = 'P0001', HINT = 'HDC14_ABSENCE_NOT_ATTESTABLE';
    END IF;
    -- 10. Evidence: a first ruling records the attested absence of the published game, with its published event (none:
    -- NULL); a later row repeats the first row's, and the published game may not now record another event.
    IF p_action = 'rule' THEN
      v_status := 'STATUS_ABSENT';
      v_event := v_published_event;
      v_source := 'commissioner-attestation';
    ELSIF v_published_event IS NOT NULL AND v_published_event IS DISTINCT FROM v_event THEN
      RAISE EXCEPTION 'HDC14_EVENT_MISMATCH: the published game records event %, the incident records %', v_published_event,
        COALESCE(v_event, 'none') USING ERRCODE = 'P0001', HINT = 'HDC14_EVENT_MISMATCH';
    END IF;
  END IF;

  -- 11. One ordinary INSERT through the unchanged HDC-12 insert trigger; the written row's public columns are returned.
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
REVOKE ALL ON FUNCTION public.nfl_append_absent_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nfl_append_absent_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text) FROM anonymous;
REVOKE ALL ON FUNCTION public.nfl_append_absent_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.nfl_append_absent_incident_ruling(text, integer, text, text, text, text, integer, bigint, text, text) TO authenticated;

-- Postconditions, checked before committing: the function's owner, security, search path and grant surface; no write
-- privilege for the Data API roles; the exact CHECKs; and the HDC-12 and HDC-13 functions still byte-identical.
DO $$
DECLARE
  f oid := 'public.nfl_append_absent_incident_ruling(text,integer,text,text,text,text,integer,bigint,text,text)'::regprocedure;
  t text;
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = f) <> 'nfl_pool_owner'
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f)
     OR (SELECT p.provolatile FROM pg_proc p WHERE p.oid = f) <> 'v'
     OR (SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = f) <> 'plpgsql'
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = f) IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
    RAISE EXCEPTION 'migration 005: the function must be plpgsql, VOLATILE, SECURITY DEFINER, owned by nfl_pool_owner, with search_path pg_catalog, pg_temp';
  END IF;
  IF (SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ','
                        ORDER BY (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C")
        FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = f) IS DISTINCT FROM 'authenticated:EXECUTE,nfl_pool_owner:EXECUTE'
     OR has_function_privilege('anonymous', f, 'EXECUTE') OR has_function_privilege('authenticator', f, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 005: EXECUTE must belong to the owner and authenticated only (not PUBLIC, anonymous or authenticator)';
  END IF;
  FOREACH t IN ARRAY ARRAY['public.nfl_contests', 'public.nfl_contest_policies', 'public.nfl_incident_rulings'] LOOP
    IF has_any_column_privilege('anonymous', t, 'INSERT') OR has_any_column_privilege('authenticated', t, 'INSERT')
       OR has_any_column_privilege('anonymous', t, 'UPDATE') OR has_any_column_privilege('authenticated', t, 'UPDATE')
       OR has_table_privilege('anonymous', t, 'DELETE, TRUNCATE') OR has_table_privilege('authenticated', t, 'DELETE, TRUNCATE') THEN
      RAISE EXCEPTION 'migration 005: the Data API roles must have no write privilege on %', t;
    END IF;
  END LOOP;
  IF has_sequence_privilege('anonymous', 'public.nfl_incident_rulings_ruling_id_seq', 'USAGE, SELECT, UPDATE')
     OR has_sequence_privilege('authenticated', 'public.nfl_incident_rulings_ruling_id_seq', 'USAGE, SELECT, UPDATE') THEN
    RAISE EXCEPTION 'migration 005: the Data API roles must have no privilege on the ruling id sequence';
  END IF;
  IF (SELECT string_agg(c.conname || ' ' || pg_get_constraintdef(c.oid), ' | ' ORDER BY c.conname COLLATE "C") FROM pg_constraint c
       WHERE c.conrelid = 'public.nfl_incident_rulings'::regclass
         AND c.conname IN ('nfl_incident_rulings_absence_attestation_check', 'nfl_incident_rulings_evidence_source_check',
                           'nfl_incident_rulings_incident_status_check'))
     IS DISTINCT FROM 'nfl_incident_rulings_absence_attestation_check CHECK (((incident_status = ''STATUS_ABSENT''::text) = (NOT (evidence_source IS DISTINCT FROM ''commissioner-attestation''::text))))'
       ' | nfl_incident_rulings_evidence_source_check CHECK (((evidence_source IS NULL) OR (evidence_source = ANY (ARRAY[''espn-scoreboard''::text, ''nflscores2''::text, ''commissioner-attestation''::text]))))'
       ' | nfl_incident_rulings_incident_status_check CHECK ((incident_status = ANY (ARRAY[''STATUS_CANCELED''::text, ''STATUS_POSTPONED''::text, ''STATUS_SUSPENDED''::text, ''STATUS_ABSENT''::text])))'
     OR (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.nfl_incident_rulings'::regclass AND c.contype IN ('c', 'f', 'p', 'u')) <> 18 THEN
    RAISE EXCEPTION 'migration 005: the nfl_incident_rulings CHECKs are not exactly the HDC-14 evidence CHECKs';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = 'public.nfl_append_incident_ruling(text,integer,text,text,text,text,integer,bigint,text,text,text,text,text)'::regprocedure)
       <> '3ba1d1115839763214c9ac24caa611bf'
     OR (SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname COLLATE "C") FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'nfl_append_absent_incident_ruling')
       IS DISTINCT FROM 'nfl_append_incident_ruling:3ba1d1115839763214c9ac24caa611bf,'
         'nfl_contest_history_reject_change:e8dbb29fadbaf7c236a1c8b3a030a259,'
         'nfl_contest_policies_check_insert:e79eaeb62ee5cba8f4b1580a294f7382,'
         'nfl_contests_check_insert:10dd8ce68f5ba50fccf9b15acb3f51dc,'
         'nfl_incident_rulings_check_insert:13a3f489440dc7051320a73769c06cff' THEN
    RAISE EXCEPTION 'migration 005: the HDC-12 trigger functions and the HDC-13 write path must stay byte-identical';
  END IF;
END
$$;

COMMIT;
