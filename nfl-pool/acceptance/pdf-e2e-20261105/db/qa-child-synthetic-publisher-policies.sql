-- QA ONLY — draft PR #29. Applied ONLY to Neon project green-base-66242978, child branch br-damp-credit-bbn7d0zr,
-- database nfl_pool. Never apply to the QA parent br-dawn-fire-bb923034 or to production. Not a migration.
--
-- Why: the child's existing publisher policies authorize exactly one identity, the production publisher's email, which
-- this acceptance must not use. These six ADDITIVE policies authorize exactly one synthetic identity on the child with the
-- SAME predicate (JWT user id = neon_auth user id, exact email, role 'admin', not banned). The 11 existing policies, RLS
-- enablement, grants, anonymous locked-only reads and the absence of any DELETE policy are all left unchanged.
-- The synthetic account (qa.pdf-e2e.publisher@example.com) was created through the child's own Neon Auth sign-up and
-- given role 'admin' through the Neon Auth admin API on the child only. Its password exists only in the QA runner's
-- local scratchpad and is never committed, logged or displayed.

BEGIN;
CREATE POLICY qa_synthetic_publisher_insert ON public.nfl_pool_weeks AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE ((u.id)::text = auth.user_id()) AND (lower(u.email) = 'qa.pdf-e2e.publisher@example.com'::text) AND (u.role = 'admin'::text) AND (COALESCE(u.banned, false) = false)));
CREATE POLICY qa_synthetic_publisher_read ON public.nfl_pool_weeks AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE ((u.id)::text = auth.user_id()) AND (lower(u.email) = 'qa.pdf-e2e.publisher@example.com'::text) AND (u.role = 'admin'::text) AND (COALESCE(u.banned, false) = false)));
CREATE POLICY qa_synthetic_publisher_update ON public.nfl_pool_weeks AS PERMISSIVE FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE ((u.id)::text = auth.user_id()) AND (lower(u.email) = 'qa.pdf-e2e.publisher@example.com'::text) AND (u.role = 'admin'::text) AND (COALESCE(u.banned, false) = false)))
  WITH CHECK (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE ((u.id)::text = auth.user_id()) AND (lower(u.email) = 'qa.pdf-e2e.publisher@example.com'::text) AND (u.role = 'admin'::text) AND (COALESCE(u.banned, false) = false)));
CREATE POLICY qa_synthetic_publisher_insert ON public.nfl_survivor_weeks AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE ((u.id)::text = auth.user_id()) AND (lower(u.email) = 'qa.pdf-e2e.publisher@example.com'::text) AND (u.role = 'admin'::text) AND (COALESCE(u.banned, false) = false)));
CREATE POLICY qa_synthetic_publisher_read ON public.nfl_survivor_weeks AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE ((u.id)::text = auth.user_id()) AND (lower(u.email) = 'qa.pdf-e2e.publisher@example.com'::text) AND (u.role = 'admin'::text) AND (COALESCE(u.banned, false) = false)));
CREATE POLICY qa_synthetic_publisher_update ON public.nfl_survivor_weeks AS PERMISSIVE FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE ((u.id)::text = auth.user_id()) AND (lower(u.email) = 'qa.pdf-e2e.publisher@example.com'::text) AND (u.role = 'admin'::text) AND (COALESCE(u.banned, false) = false)))
  WITH CHECK (EXISTS (SELECT 1 FROM neon_auth."user" u WHERE ((u.id)::text = auth.user_id()) AND (lower(u.email) = 'qa.pdf-e2e.publisher@example.com'::text) AND (u.role = 'admin'::text) AND (COALESCE(u.banned, false) = false)));
COMMIT;

-- Revert (owner decision; not run by this acceptance):
--   DROP POLICY qa_synthetic_publisher_insert ON public.nfl_pool_weeks;
--   DROP POLICY qa_synthetic_publisher_read   ON public.nfl_pool_weeks;
--   DROP POLICY qa_synthetic_publisher_update ON public.nfl_pool_weeks;
--   DROP POLICY qa_synthetic_publisher_insert ON public.nfl_survivor_weeks;
--   DROP POLICY qa_synthetic_publisher_read   ON public.nfl_survivor_weeks;
--   DROP POLICY qa_synthetic_publisher_update ON public.nfl_survivor_weeks;
