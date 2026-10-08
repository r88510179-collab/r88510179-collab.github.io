-- HDC-13 SQL behavior harness fixtures. Run as the cluster superuser, connected to nfl_pool, after migrations 001-004.
-- Accounts are Neon Auth rows; the published Pick'em weeks and Survivor snapshots are what the Admin publishers write;
-- the fixture contests are written as nfl_pool_owner, so the unchanged HDC-12 insert checks accept them. Every pair a
-- behavior or race test rules on belongs to that test alone: ruling rows are append-only and are never cleaned up.

\set ON_ERROR_STOP on

-- Accounts. The commissioner's stored email has mixed case (the predicate compares lower(email)) and banned NULL (the
-- predicate reads COALESCE(banned, false)).
INSERT INTO neon_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Commissioner', 'DJSmokke@Gmail.com', true, now(), now(), 'admin', NULL),
  ('00000000-0000-4000-8000-000000000002', 'Participant', 'participant@example.com', true, now(), now(), 'user', false),
  ('00000000-0000-4000-8000-000000000003', 'Other Admin', 'other.admin@example.com', true, now(), now(), 'admin', false);

-- Published Pick'em weeks, season 2026 (the shape admin.js publishes: canonical or alias codes, eventId where the schedule
-- check recorded one).
INSERT INTO public.nfl_pool_weeks (season, week, status, config, revision, published_at, locked_at) VALUES
  -- Week 3: the behavior-suite games. JAC @ WSH is stored with alias codes; NYJ @ NE has no eventId (as production Week 1).
  (2026, 3, 'locked', '{"schemaVersion":1,"season":2026,"week":3,"label":"Week 3","tiebreakGameIndex":1,
    "games":[{"away":"DEN","home":"KC","awayNumber":1,"homeNumber":2,"date":"2026-09-27","eventId":"401437900"},
             {"away":"BUF","home":"CIN","awayNumber":3,"homeNumber":4,"date":"2026-09-28","eventId":"401437947"},
             {"away":"JAC","home":"WSH","awayNumber":5,"homeNumber":6,"date":"2026-09-28","eventId":"401437960"},
             {"away":"NYJ","home":"NE","awayNumber":7,"homeNumber":8,"date":"2026-09-28"}],
    "participants":[{"id":"dc","displayName":"D.C.","pickNumbers":[1,3,5,7],"tiebreak":41},
                    {"id":"djs","displayName":"DJS","pickNumbers":[2,4,6,8],"tiebreak":44}]}', 1, now(), now()),
  -- Week 4: the same pair published twice (not exactly once).
  (2026, 4, 'locked', '{"schemaVersion":1,"season":2026,"week":4,"tiebreakGameIndex":0,
    "games":[{"away":"MIA","home":"BUF","awayNumber":1,"homeNumber":2,"eventId":"401437970"},
             {"away":"MIA","home":"BUF","awayNumber":3,"homeNumber":4,"eventId":"401437971"}],"participants":[]}', 1, now(), now()),
  -- Week 5: a draft, never published.
  (2026, 5, 'draft', '{"schemaVersion":1,"season":2026,"week":5,"tiebreakGameIndex":0,
    "games":[{"away":"BUF","home":"CIN","awayNumber":1,"homeNumber":2,"eventId":"401437980"}],"participants":[]}', 1, now(), NULL),
  -- Week 6: locked, but its configuration names another week.
  (2026, 6, 'locked', '{"schemaVersion":1,"season":2026,"week":7,"tiebreakGameIndex":0,
    "games":[{"away":"DET","home":"GB","awayNumber":1,"homeNumber":2,"eventId":"401437985"}],"participants":[]}', 1, now(), now()),
  -- Week 7: CLE published in two games (a ruled team elsewhere in the published week).
  (2026, 7, 'locked', '{"schemaVersion":1,"season":2026,"week":7,"tiebreakGameIndex":0,
    "games":[{"away":"PIT","home":"CLE","awayNumber":1,"homeNumber":2,"eventId":"401437986"},
             {"away":"CLE","home":"BAL","awayNumber":3,"homeNumber":4,"eventId":"401437987"}],"participants":[]}', 1, now(), now()),
  -- Week 10: race games, one pair per race.
  (2026, 10, 'locked', '{"schemaVersion":1,"season":2026,"week":10,"tiebreakGameIndex":0,
    "games":[{"away":"LAR","home":"SEA","awayNumber":1,"homeNumber":2,"eventId":"401438001"},
             {"away":"ATL","home":"TB","awayNumber":3,"homeNumber":4,"eventId":"401438002"},
             {"away":"CAR","home":"NO","awayNumber":5,"homeNumber":6,"eventId":"401438003"},
             {"away":"DAL","home":"PHI","awayNumber":7,"homeNumber":8,"eventId":"401438004"}],"participants":[]}', 1, now(), now()),
  -- Week 11: publish-update races.
  (2026, 11, 'locked', '{"schemaVersion":1,"season":2026,"week":11,"tiebreakGameIndex":0,
    "games":[{"away":"GB","home":"MIN","awayNumber":1,"homeNumber":2,"eventId":"401438011"},
             {"away":"HOU","home":"TEN","awayNumber":3,"homeNumber":4,"eventId":"401438012"},
             {"away":"IND","home":"JAX","awayNumber":5,"homeNumber":6,"eventId":"401438013"}],"participants":[]}', 1, now(), now()),
  -- Season 2099 (the fixture Pick'em contest that has not started): policy-revision races.
  (2099, 6, 'locked', '{"schemaVersion":1,"season":2099,"week":6,"tiebreakGameIndex":0,
    "games":[{"away":"CHI","home":"DET","awayNumber":1,"homeNumber":2,"eventId":"409900601"}],"participants":[]}', 1, now(), now()),
  (2099, 7, 'locked', '{"schemaVersion":1,"season":2099,"week":7,"tiebreakGameIndex":0,
    "games":[{"away":"CLE","home":"BAL","awayNumber":1,"homeNumber":2,"eventId":"409900701"}],"participants":[]}', 1, now(), now());

-- Published Survivor snapshots, season 2026: Week 3 locked (it covers Weeks 1-3), Week 5 only a draft.
INSERT INTO public.nfl_survivor_weeks (season, week, status, config, revision, published_at, locked_at) VALUES
  (2026, 3, 'locked', '{"schemaVersion":1,"season":2026,"week":3,"label":"Survivor Week 3","competitionSize":2,"currentWeekEntryCount":2,
    "trackedEntries":[{"id":"dc","displayName":"D.C.","picks":["PIT","SF","KC"]}],"fieldEntries":[{"id":"survivor-001","picks":["CLE","ARI","DEN"]}]}', 1, now(), now()),
  (2026, 5, 'draft', '{"schemaVersion":1,"season":2026,"week":5,"trackedEntries":[],"fieldEntries":[]}', 1, now(), NULL);

-- Fixture contests, written as the table owner through the HDC-12 insert checks: two Survivor contests whose revision-1
-- policy is eliminate and commissioner_decides, and a Pick'em contest of season 2099 that has not started, so a later
-- policy revision is still allowed for it (the races).
SET ROLE nfl_pool_owner;
INSERT INTO public.nfl_contests (contest_id, season, contest_type, display_name, starts_at) VALUES
  ('fixture-2026-survivor-eliminate', 2026, 'survivor', 'Fixture 2026 Survivor (eliminate)', '2026-09-10T00:20:00+00:00'),
  ('fixture-2026-survivor-decides', 2026, 'survivor', 'Fixture 2026 Survivor (commissioner decides)', '2026-09-10T00:20:00+00:00'),
  ('fixture-2099-pickem', 2099, 'pickem', 'Fixture 2099 Pick''em', '2099-09-10T00:20:00+00:00');
INSERT INTO public.nfl_contest_policies (contest_id, contest_type, revision, effective_week, halted_game_policy, public_note) VALUES
  ('fixture-2026-survivor-eliminate', 'survivor', 1, 1, 'eliminate', 'Fixture policy: eliminate.'),
  ('fixture-2026-survivor-decides', 'survivor', 1, 1, 'commissioner_decides', 'Fixture policy: commissioner decides.'),
  ('fixture-2099-pickem', 'pickem', 1, 1, 'void', 'Fixture policy: void.');
RESET ROLE;
