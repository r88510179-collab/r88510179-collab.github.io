-- Pool Center HDC-12: contest-scoped halted-game rulings (schema only).
--
-- Apply only after the matching application candidate is reviewed and approved, then migration 003, then refresh the
-- Data API schema cache, and only then deploy the pages that read these tables (until both migrations are applied the
-- 2026 Pick'em and Survivor pages show ON HOLD, by design). This file creates three tables and their guards. It inserts no
-- contest, policy or ruling (003 bootstraps the two personal 2026 contests), defines no RPC, and gives anonymous and
-- authenticated no INSERT, UPDATE, DELETE or TRUNCATE privilege and no write policy: HDC-12 is read-only for every Data
-- API role. Commissioner writes (confirm, reaffirm, withdraw, policy revisions) are HDC-13 and are not authorized here.
--
-- Three layers stay apart. An NFL fact (the score feed) is never stored here. A contest policy (nfl_contest_policies) is
-- the halted-game rule the commissioner chose; it never changes a standing by itself. An incident ruling
-- (nfl_incident_rulings) is the confirmed consequence for one halted game in one contest week, and the only thing that
-- changes a pool result. Its identity is contest + week + away team + home team + policy revision; event_id is evidence.
--
-- Privacy: created_by and admin_note are private. RLS chooses rows, column privileges choose columns: anonymous and
-- authenticated get no table-level privilege at all, only SELECT on the public columns named in the column grants at the
-- end (the same lists as PUBLIC_COLUMNS in nfl-pool/contest-rulings.js). select=*, or a filter, order or embed that names
-- a private column, is refused for both roles.
--
-- History is append-only. UPDATE, DELETE and TRUNCATE raise for every role, the owner included, and every insert is
-- checked against the rows already there: policy revisions are contiguous, never move their effective week backward,
-- never reach a week that already has a ruling and, after the contest starts, are prospective only; ruling rows extend
-- exactly one chain by one step. created_at is always the server clock at insert.

BEGIN;

CREATE TABLE public.nfl_contests (
  contest_id text PRIMARY KEY CHECK (contest_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(contest_id) <= 64),
  season integer NOT NULL CHECK (season BETWEEN 2020 AND 2100),
  contest_type text NOT NULL CHECK (contest_type IN ('pickem','survivor')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80 AND display_name = btrim(display_name)),
  -- The verified Week-1 kickoff. Never updated: a policy revision after this instant is prospective only.
  starts_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 200),
  CONSTRAINT nfl_contests_id_type_key UNIQUE (contest_id, contest_type)
);

CREATE TABLE public.nfl_contest_policies (
  contest_id text NOT NULL,
  contest_type text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  effective_week integer NOT NULL CHECK (effective_week BETWEEN 1 AND 22),
  halted_game_policy text NOT NULL,
  public_note text CHECK (public_note IS NULL OR length(public_note) BETWEEN 1 AND 500),
  admin_note text CHECK (admin_note IS NULL OR length(admin_note) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 200),
  PRIMARY KEY (contest_id, revision),
  CONSTRAINT nfl_contest_policies_contest_fkey FOREIGN KEY (contest_id, contest_type)
    REFERENCES public.nfl_contests (contest_id, contest_type),
  -- Revision 1 is the contest's initial policy and is in force from Week 1.
  CONSTRAINT nfl_contest_policies_initial_week CHECK (revision > 1 OR effective_week = 1),
  CONSTRAINT nfl_contest_policies_value CHECK (
    (contest_type = 'survivor' AND halted_game_policy IN ('advance_team_used','eliminate','commissioner_decides'))
    OR (contest_type = 'pickem' AND halted_game_policy = 'void'))
);

CREATE TABLE public.nfl_incident_rulings (
  ruling_id bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.nfl_incident_rulings_ruling_id_seq) PRIMARY KEY,
  contest_id text NOT NULL,
  contest_type text NOT NULL,
  week integer NOT NULL CHECK (week BETWEEN 1 AND 22),
  away_team text NOT NULL,
  home_team text NOT NULL,
  policy_revision integer NOT NULL,
  -- Position in the incident's append-only chain: 1 is the original ruling, each later row follows the one before it.
  chain_seq integer NOT NULL CHECK (chain_seq > 0),
  parent_ruling_id bigint REFERENCES public.nfl_incident_rulings (ruling_id),
  consequence text NOT NULL,
  -- Factual evidence recorded at confirmation: the halted status the feed reported (only the three supported v1
  -- statuses; a forfeit is out of scope and cannot be ruled on), the feed event id where the feed had one, and which
  -- feed reported it. The chain's first row is the original incident; later rows may not name a different event.
  incident_status text NOT NULL CHECK (incident_status IN ('STATUS_CANCELED','STATUS_POSTPONED','STATUS_SUSPENDED')),
  event_id text CHECK (event_id IS NULL OR event_id ~ '^[0-9]{1,20}$'),
  evidence_source text CHECK (evidence_source IS NULL OR evidence_source IN ('espn-scoreboard','nflscores2')),
  public_note text CHECK (public_note IS NULL OR length(public_note) BETWEEN 1 AND 500),
  admin_note text CHECK (admin_note IS NULL OR length(admin_note) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 200),
  CONSTRAINT nfl_incident_rulings_contest_fkey FOREIGN KEY (contest_id, contest_type)
    REFERENCES public.nfl_contests (contest_id, contest_type),
  CONSTRAINT nfl_incident_rulings_policy_fkey FOREIGN KEY (contest_id, policy_revision)
    REFERENCES public.nfl_contest_policies (contest_id, revision),
  CONSTRAINT nfl_incident_rulings_chain_position_key UNIQUE (contest_id, week, away_team, home_team, policy_revision, chain_seq),
  CONSTRAINT nfl_incident_rulings_teams CHECK (
    away_team IN ('ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS')
    AND home_team IN ('ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS')
    AND away_team <> home_team),
  -- Exactly one root per incident: the first row has no predecessor and every later row has one.
  CONSTRAINT nfl_incident_rulings_root CHECK ((chain_seq = 1) = (parent_ruling_id IS NULL)),
  -- A chain cannot start by withdrawing a ruling that does not exist.
  CONSTRAINT nfl_incident_rulings_first_not_withdrawn CHECK (chain_seq > 1 OR consequence <> 'withdrawn'),
  CONSTRAINT nfl_incident_rulings_consequence CHECK (
    (contest_type = 'survivor' AND consequence IN ('advance_team_used','eliminate','withdrawn'))
    OR (contest_type = 'pickem' AND consequence IN ('void','withdrawn')))
);

-- Append-only guard for all three tables.
CREATE FUNCTION public.nfl_contest_history_reject_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'public.% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END
$$;

-- The insert checks run as the table owner (SECURITY DEFINER, fixed search_path, schema-qualified names) so they always
-- see every committed row whichever role inserts, and only under READ COMMITTED, where each query below reads the rows
-- committed before the per-contest lock was granted. They are trigger functions: they cannot be called as an RPC.
CREATE FUNCTION public.nfl_contests_check_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;

-- Policy revisions: contiguous from 1, effective week never backward, never reaching a week that already has a ruling (so
-- a later revision can never reinterpret an existing ruling), and once the contest has started only prospective: the
-- revision's week must nominally start (verified Week-1 kickoff + 168 hours per week) more than 72 hours from now: absolute
-- time, never calendar days in the session time zone, so the rule is the evaluator's exactly. Revision 1, the contest's
-- initial policy, is exempt from the timing rule, so it can record the policy in force from Week 1. A revision is never
-- dated before the revision it follows.
CREATE FUNCTION public.nfl_contest_policies_check_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  contest_start timestamptz;
  latest_revision integer;
  latest_week integer;
  latest_created timestamptz;
  ruled_week integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'contest history is written only under READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.nfl_contest_history'), hashtext(NEW.contest_id));
  NEW.created_at := clock_timestamp();
  SELECT c.starts_at INTO contest_start FROM public.nfl_contests c
    WHERE c.contest_id = NEW.contest_id AND c.contest_type = NEW.contest_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no % contest %', NEW.contest_type, NEW.contest_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT p.revision, p.effective_week, p.created_at INTO latest_revision, latest_week, latest_created
    FROM public.nfl_contest_policies p WHERE p.contest_id = NEW.contest_id ORDER BY p.revision DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'the first policy revision of % must be revision 1', NEW.contest_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revision <> latest_revision + 1 THEN
    RAISE EXCEPTION 'policy revisions of % are contiguous: the next revision is %', NEW.contest_id, latest_revision + 1
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_at < latest_created THEN
    RAISE EXCEPTION 'policy revision % of % would be dated before revision %', NEW.revision, NEW.contest_id, latest_revision
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.effective_week < latest_week THEN
    RAISE EXCEPTION 'policy revision % of % would move the effective week back from % to %', NEW.revision, NEW.contest_id,
      latest_week, NEW.effective_week USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(r.week) INTO ruled_week FROM public.nfl_incident_rulings r WHERE r.contest_id = NEW.contest_id;
  IF ruled_week IS NOT NULL AND NEW.effective_week <= ruled_week THEN
    RAISE EXCEPTION 'policy revision % of % would reach Week %, which already has a ruling', NEW.revision, NEW.contest_id,
      ruled_week USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_at >= contest_start
     AND contest_start + (NEW.effective_week - 1) * interval '168 hours' - interval '72 hours' <= NEW.created_at THEN
    RAISE EXCEPTION 'after % starts a policy revision is prospective only: Week % may already be under way',
      NEW.contest_id, NEW.effective_week USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Ruling rows: the policy revision named must be the one in force for the incident week and must permit the consequence;
-- one team is covered by at most one active incident per contest week (an incident whose last row is a withdrawal has no
-- active ruling and covers nothing, so a mistaken ruling, once withdrawn, never blocks the correct one, and is re-ruled
-- only while no other incident covers its teams); each row extends its own incident's chain by exactly one step from the
-- current last row; a later row names no event other than the one the chain's first row recorded (none at all when the
-- first row recorded none); a consequence changes only through a withdrawal, and only an active ruling can be withdrawn.
CREATE FUNCTION public.nfl_incident_rulings_check_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  in_force integer;
  allowed_policy text;
  last_seq integer;
  prior_id bigint;
  prior_consequence text;
  root_event text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'contest history is written only under READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.nfl_contest_history'), hashtext(NEW.contest_id));
  NEW.created_at := clock_timestamp();
  SELECT p.revision INTO in_force FROM public.nfl_contest_policies p
    WHERE p.contest_id = NEW.contest_id AND p.effective_week <= NEW.week ORDER BY p.revision DESC LIMIT 1;
  IF in_force IS DISTINCT FROM NEW.policy_revision THEN
    RAISE EXCEPTION 'Week % of % is governed by policy revision %, not %', NEW.week, NEW.contest_id, in_force,
      NEW.policy_revision USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.halted_game_policy INTO allowed_policy FROM public.nfl_contest_policies p
    WHERE p.contest_id = NEW.contest_id AND p.revision = NEW.policy_revision;
  IF NEW.consequence <> 'withdrawn' AND NOT (NEW.consequence = allowed_policy
      OR (allowed_policy = 'commissioner_decides' AND NEW.consequence IN ('advance_team_used','eliminate'))) THEN
    RAISE EXCEPTION 'policy % does not permit consequence %', allowed_policy, NEW.consequence USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.consequence <> 'withdrawn' AND EXISTS (SELECT 1 FROM public.nfl_incident_rulings r
      WHERE r.contest_id = NEW.contest_id AND r.week = NEW.week
        AND (r.away_team IN (NEW.away_team, NEW.home_team) OR r.home_team IN (NEW.away_team, NEW.home_team))
        AND (r.away_team, r.home_team, r.policy_revision) IS DISTINCT FROM (NEW.away_team, NEW.home_team, NEW.policy_revision)
        AND r.consequence <> 'withdrawn'
        AND r.chain_seq = (SELECT max(l.chain_seq) FROM public.nfl_incident_rulings l
          WHERE l.contest_id = r.contest_id AND l.week = r.week AND l.away_team = r.away_team
            AND l.home_team = r.home_team AND l.policy_revision = r.policy_revision)) THEN
    RAISE EXCEPTION 'Week % of %: % or % is already covered by another incident', NEW.week, NEW.contest_id, NEW.away_team,
      NEW.home_team USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(r.chain_seq) INTO last_seq FROM public.nfl_incident_rulings r
    WHERE r.contest_id = NEW.contest_id AND r.week = NEW.week AND r.away_team = NEW.away_team
      AND r.home_team = NEW.home_team AND r.policy_revision = NEW.policy_revision;
  IF NEW.chain_seq <> COALESCE(last_seq, 0) + 1 THEN
    RAISE EXCEPTION 'the next row of this incident chain is chain_seq %', COALESCE(last_seq, 0) + 1 USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.chain_seq > 1 THEN
    SELECT r.ruling_id, r.consequence INTO prior_id, prior_consequence FROM public.nfl_incident_rulings r
      WHERE r.contest_id = NEW.contest_id AND r.week = NEW.week AND r.away_team = NEW.away_team
        AND r.home_team = NEW.home_team AND r.policy_revision = NEW.policy_revision AND r.chain_seq = NEW.chain_seq - 1;
    IF prior_id IS DISTINCT FROM NEW.parent_ruling_id THEN
      RAISE EXCEPTION 'parent_ruling_id must be ruling %, the preceding row of the same incident', prior_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF prior_consequence = 'withdrawn' AND NEW.consequence = 'withdrawn' THEN
      RAISE EXCEPTION 'there is no active ruling to withdraw' USING ERRCODE = 'check_violation';
    END IF;
    IF prior_consequence <> 'withdrawn' AND NEW.consequence NOT IN (prior_consequence, 'withdrawn') THEN
      RAISE EXCEPTION 'change % to % by withdrawing it first', prior_consequence, NEW.consequence USING ERRCODE = 'check_violation';
    END IF;
    SELECT r.event_id INTO root_event FROM public.nfl_incident_rulings r
      WHERE r.contest_id = NEW.contest_id AND r.week = NEW.week AND r.away_team = NEW.away_team
        AND r.home_team = NEW.home_team AND r.policy_revision = NEW.policy_revision AND r.chain_seq = 1;
    IF NEW.event_id IS NOT NULL AND NEW.event_id IS DISTINCT FROM root_event THEN
      RAISE EXCEPTION 'a later row may only repeat the event the incident''s first row recorded; a makeup game is never linked to it'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER nfl_contests_check_insert BEFORE INSERT ON public.nfl_contests
  FOR EACH ROW EXECUTE FUNCTION public.nfl_contests_check_insert();
CREATE TRIGGER nfl_contests_append_only BEFORE UPDATE OR DELETE ON public.nfl_contests
  FOR EACH ROW EXECUTE FUNCTION public.nfl_contest_history_reject_change();
CREATE TRIGGER nfl_contests_no_truncate BEFORE TRUNCATE ON public.nfl_contests
  FOR EACH STATEMENT EXECUTE FUNCTION public.nfl_contest_history_reject_change();
CREATE TRIGGER nfl_contest_policies_check_insert BEFORE INSERT ON public.nfl_contest_policies
  FOR EACH ROW EXECUTE FUNCTION public.nfl_contest_policies_check_insert();
CREATE TRIGGER nfl_contest_policies_append_only BEFORE UPDATE OR DELETE ON public.nfl_contest_policies
  FOR EACH ROW EXECUTE FUNCTION public.nfl_contest_history_reject_change();
CREATE TRIGGER nfl_contest_policies_no_truncate BEFORE TRUNCATE ON public.nfl_contest_policies
  FOR EACH STATEMENT EXECUTE FUNCTION public.nfl_contest_history_reject_change();
CREATE TRIGGER nfl_incident_rulings_check_insert BEFORE INSERT ON public.nfl_incident_rulings
  FOR EACH ROW EXECUTE FUNCTION public.nfl_incident_rulings_check_insert();
CREATE TRIGGER nfl_incident_rulings_append_only BEFORE UPDATE OR DELETE ON public.nfl_incident_rulings
  FOR EACH ROW EXECUTE FUNCTION public.nfl_contest_history_reject_change();
CREATE TRIGGER nfl_incident_rulings_no_truncate BEFORE TRUNCATE ON public.nfl_incident_rulings
  FOR EACH STATEMENT EXECUTE FUNCTION public.nfl_contest_history_reject_change();

-- None of these functions is callable by a Data API role (a trigger function cannot be called directly anyway).
REVOKE ALL ON FUNCTION public.nfl_contest_history_reject_change() FROM PUBLIC, anonymous, authenticated;
REVOKE ALL ON FUNCTION public.nfl_contests_check_insert() FROM PUBLIC, anonymous, authenticated;
REVOKE ALL ON FUNCTION public.nfl_contest_policies_check_insert() FROM PUBLIC, anonymous, authenticated;
REVOKE ALL ON FUNCTION public.nfl_incident_rulings_check_insert() FROM PUBLIC, anonymous, authenticated;

ALTER TABLE public.nfl_contests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nfl_contest_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nfl_incident_rulings ENABLE ROW LEVEL SECURITY;

-- Every row is participant-visible; the column grants below decide which columns. There is no INSERT, UPDATE or DELETE
-- policy, so even a write privilege granted by mistake would match no row.
CREATE POLICY nfl_contests_public_read ON public.nfl_contests FOR SELECT TO anonymous, authenticated USING (true);
CREATE POLICY nfl_contest_policies_public_read ON public.nfl_contest_policies FOR SELECT TO anonymous, authenticated USING (true);
CREATE POLICY nfl_incident_rulings_public_read ON public.nfl_incident_rulings FOR SELECT TO anonymous, authenticated USING (true);

-- Clear anything a default privilege may have granted on creation, then grant column-level SELECT on public columns only.
REVOKE ALL ON TABLE public.nfl_contests, public.nfl_contest_policies, public.nfl_incident_rulings FROM PUBLIC, anonymous, authenticated;
REVOKE ALL ON SEQUENCE public.nfl_incident_rulings_ruling_id_seq FROM PUBLIC, anonymous, authenticated;

GRANT SELECT (contest_id, season, contest_type, display_name, starts_at, created_at)
  ON public.nfl_contests TO anonymous, authenticated;
GRANT SELECT (contest_id, contest_type, revision, effective_week, halted_game_policy, public_note, created_at)
  ON public.nfl_contest_policies TO anonymous, authenticated;
GRANT SELECT (ruling_id, contest_id, contest_type, week, away_team, home_team, policy_revision, chain_seq, parent_ruling_id,
  consequence, incident_status, event_id, evidence_source, public_note, created_at)
  ON public.nfl_incident_rulings TO anonymous, authenticated;

COMMIT;
