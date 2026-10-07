-- Pool Center HDC-12 bootstrap: the two personal 2026 contests and their revision-1 halted-game policies.
--
-- Controlled rollout artifact. Run it once, after migration 002 has been applied and verified, as the table owner, in a
-- single psql session on a direct (not pooled) connection that first supplies the verified 2026 Week-1 kickoff. This file
-- does not contain that value and never guesses it:
--
--   SET nfl_pool.contest_start_2026 = '<verified 2026 Week-1 kickoff: YYYY-MM-DDTHH:MM:SS+HH:MM>';
--   \i nfl-pool/migrations/003-pool-center-2026-contests.sql
--
-- Without the setting, or with a value that is not an ISO 8601 timestamp with an explicit offset, that is not in 2026
-- (UTC) or that is still in the future (the 2026 contests have already begun), the script raises and changes nothing.
-- It reports the kickoff it read, in UTC, before committing.
--
-- It creates exactly two contests, pool-center-2026-pickem and pool-center-2026-survivor, each with policy revision 1 in
-- force from Week 1: void for Pick'em, advance_team_used for Survivor. The 2026 contests began before Pool Center moved to
-- contest-scoped rulings, so revision 1 is a one-time capture of the approved baseline policy as it stood at contest
-- start, not a rule change after the start; every later revision is prospective only (002's insert check). The bootstrap
-- creates no incident ruling, rewrites no NFL fact and changes no standing by itself.
--
-- Nothing is ever updated or overwritten. A row that already exists must equal the bootstrap row field for field (its
-- private created_by included, which the bootstrap leaves NULL; created_at is the server clock and is not compared), or
-- the script raises and changes nothing, so re-running it after a successful run is a no-op.

BEGIN;

DO $$
DECLARE
  supplied text := current_setting('nfl_pool.contest_start_2026', true);
  kickoff timestamptz;
  spec record;
  existing record;
BEGIN
  IF supplied IS NULL OR btrim(supplied) = '' THEN
    RAISE EXCEPTION 'migration 003 needs the verified 2026 Week-1 kickoff: SET nfl_pool.contest_start_2026 = ''YYYY-MM-DDTHH:MM:SS+HH:MM'' in this session first';
  END IF;
  supplied := btrim(supplied);
  IF supplied !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
    RAISE EXCEPTION 'nfl_pool.contest_start_2026 must be an ISO 8601 timestamp with an explicit UTC offset, got %', supplied;
  END IF;
  BEGIN
    kickoff := supplied::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'nfl_pool.contest_start_2026 is not a valid timestamp: %', supplied;
  END;
  IF extract(year FROM kickoff AT TIME ZONE 'UTC') <> 2026 THEN
    RAISE EXCEPTION 'nfl_pool.contest_start_2026 must fall in 2026 (UTC), got %', supplied;
  END IF;
  IF kickoff > clock_timestamp() THEN
    RAISE EXCEPTION 'nfl_pool.contest_start_2026 is in the future (%); the 2026 contests have already begun', supplied;
  END IF;
  RAISE NOTICE 'migration 003: 2026 contest start (Week-1 kickoff) read as % UTC', to_char(kickoff AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');

  FOR spec IN
    SELECT * FROM (VALUES
      ('pool-center-2026-pickem', 'pickem', 'Pool Center 2026 Pick''em', 'void',
       'Approved halted-game policy for this contest, in force from Week 1: a canceled, postponed or suspended game that is never completed is void once the commissioner confirms a ruling for it, with no win, no loss and no points. Recorded as revision 1 when Pool Center moved to contest-scoped rulings.'),
      ('pool-center-2026-survivor', 'survivor', 'Pool Center 2026 Survivor', 'advance_team_used',
       'Approved halted-game policy for this contest, in force from Week 1: when the commissioner confirms a ruling for a canceled, postponed or suspended game that is never completed, its pickers advance and the team still counts as used. Recorded as revision 1 when Pool Center moved to contest-scoped rulings.')
    ) AS v(contest_id, contest_type, display_name, halted_game_policy, public_note)
  LOOP
    SELECT c.season, c.contest_type, c.display_name, c.starts_at, c.created_by INTO existing
      FROM public.nfl_contests c WHERE c.contest_id = spec.contest_id;
    IF FOUND THEN
      IF (existing.season, existing.contest_type, existing.display_name, existing.starts_at, existing.created_by)
         IS DISTINCT FROM (2026, spec.contest_type, spec.display_name, kickoff, NULL::text) THEN
        RAISE EXCEPTION 'contest % already exists and differs from the bootstrap; nothing was changed', spec.contest_id;
      END IF;
    ELSE
      INSERT INTO public.nfl_contests (contest_id, season, contest_type, display_name, starts_at)
        VALUES (spec.contest_id, 2026, spec.contest_type, spec.display_name, kickoff);
    END IF;

    SELECT p.contest_type, p.effective_week, p.halted_game_policy, p.public_note, p.admin_note, p.created_by INTO existing
      FROM public.nfl_contest_policies p WHERE p.contest_id = spec.contest_id AND p.revision = 1;
    IF FOUND THEN
      IF (existing.contest_type, existing.effective_week, existing.halted_game_policy, existing.public_note, existing.admin_note,
          existing.created_by)
         IS DISTINCT FROM (spec.contest_type, 1, spec.halted_game_policy, spec.public_note,
           'HDC-12 migration 003: approved 2026 baseline policy captured as revision 1.', NULL::text) THEN
        RAISE EXCEPTION 'policy revision 1 of % already exists and differs from the bootstrap; nothing was changed', spec.contest_id;
      END IF;
    ELSE
      INSERT INTO public.nfl_contest_policies (contest_id, contest_type, revision, effective_week, halted_game_policy, public_note, admin_note)
        VALUES (spec.contest_id, spec.contest_type, 1, 1, spec.halted_game_policy, spec.public_note,
          'HDC-12 migration 003: approved 2026 baseline policy captured as revision 1.');
    END IF;
  END LOOP;
END
$$;

COMMIT;
