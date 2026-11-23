-- Called inside the predeployment transaction, after the migrations and before COMMIT. The release is committed only
-- when the schema is exactly what was reviewed and no browser role can reach more than was reviewed. Anything else
-- stops here and rolls the whole predeployment back. Nothing here writes.
DO $post$
DECLARE
  -- Every function a signed-in browser may call after predeployment. The two legacy invitation functions stay
  -- callable until retire-legacy-invites.sql, so the frontend still published keeps working in between.
  v_browser constant text[] := ARRAY[
    'pool_platform_apply_verified_schedule(p_week_id uuid, p_expected_source_sha256 text, p_tiebreak_required boolean)',
    'pool_platform_attest_week_final_results_with_source(p_week_id uuid, p_expected_revision integer, p_results jsonb, p_source_sha256 text, p_source_reference text, p_correction_reason text)',
    'pool_platform_can_read_pool(p_pool_id uuid)',
    'pool_platform_can_read_season(p_season_id uuid)',
    'pool_platform_claim_email_invite(p_entry_id uuid)',
    'pool_platform_claim_entry_invite(p_invite_token text)',
    'pool_platform_commissioner_context(p_pool_slug text)',
    'pool_platform_create_draft_week(p_season_id uuid, p_week integer, p_deadline_at timestamp with time zone, p_opens_at timestamp with time zone)',
    'pool_platform_create_email_invite(p_entry_id uuid, p_email text, p_expires_hours integer)',
    'pool_platform_create_entry(p_season_id uuid, p_entry_code text, p_display_name text)',
    'pool_platform_create_entry_invite(p_entry_id uuid, p_email text, p_expires_hours integer)',
    'pool_platform_create_pool(p_tenant_id uuid, p_display_name text, p_pool_type text)',
    'pool_platform_create_season(p_pool_id uuid, p_season integer)',
    'pool_platform_current_user_id()',
    'pool_platform_is_tenant_commissioner(p_tenant_id uuid)',
    'pool_platform_list_commissioner_pools()',
    'pool_platform_list_participant_pools()',
    'pool_platform_open_verified_week(p_week_id uuid, p_expected_source_sha256 text, p_confirm boolean)',
    'pool_platform_participant_context(p_pool_slug text, p_season integer, p_week integer)',
    'pool_platform_save_draft_schedule(p_week_id uuid, p_config jsonb)',
    'pool_platform_season_standings_snapshot(p_pool_id uuid, p_season integer)',
    'pool_platform_submit_batch(p_week_id uuid, p_source text, p_items jsonb)',
    'pool_platform_submit_entry(p_week_id uuid, p_entry_id uuid, p_source text, p_payload jsonb)',
    'pool_platform_verified_schedule_preview(p_week_id uuid)',
    'pool_platform_week_projection_snapshot(p_week_id uuid)',
    'pool_platform_week_result_snapshot(p_week_id uuid)'];
  -- Functions that exist for the owner's own functions and triggers only.
  v_private constant text[] := ARRAY[
    'pool_platform_attest_week_final_results(p_week_id uuid, p_expected_revision integer, p_results jsonb, p_source_sha256 text, p_correction_reason text)',
    'pool_platform_current_user_email()',
    'pool_platform_current_user_has_verified_email(p_email_normalized text)',
    'pool_platform_forbid_result_revision_change()',
    'pool_platform_guard_submission_source()',
    'pool_platform_payload_valid(p_pool_type text, p_week_config jsonb, p_entry_id uuid, p_week_id uuid, p_payload jsonb)'];
  -- The nine tables a signed-in browser may read through their row-level policies, and the five new tables no
  -- browser role may touch at all.
  v_readable constant text[] := ARRAY['pool_platform_entries','pool_platform_entry_invites','pool_platform_memberships',
    'pool_platform_pools','pool_platform_seasons','pool_platform_submission_audit','pool_platform_submissions',
    'pool_platform_tenants','pool_platform_weeks'];
  v_closed constant text[] := ARRAY['pool_platform_email_invite_grants','pool_platform_verified_schedule_catalog',
    'pool_platform_week_operations_audit','pool_platform_week_result_evidence','pool_platform_week_result_revisions'];
  v_problem text;
  r record;
BEGIN
  -- Functions: exactly the reviewed set, each owned by the role running the release.
  SELECT string_agg(f,'; ' ORDER BY f) INTO v_problem FROM (
    SELECT COALESCE(a.f,e.f)||CASE WHEN e.f IS NULL THEN ' is not part of the release' ELSE ' is missing' END AS f
    FROM (SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS f
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname LIKE 'pool\_platform\_%') a
    FULL JOIN (SELECT unnest(v_browser||v_private) AS f) e ON e.f=a.f
    WHERE a.f IS NULL OR e.f IS NULL) d;
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: %',v_problem; END IF;

  FOR r IN SELECT p.oid,p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS f,p.prosecdef,p.proowner,
             COALESCE(array_to_string(p.proconfig,','),'') AS config,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee=0) AS open_to_public
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname LIKE 'pool\_platform\_%' LOOP
    IF r.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
      THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: % is not owned by %',r.f,current_user; END IF;
    IF r.open_to_public OR has_function_privilege('anonymous',r.oid,'EXECUTE')
      THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: % is callable without signing in',r.f; END IF;
    IF has_function_privilege('authenticated',r.oid,'EXECUTE') IS DISTINCT FROM (r.f=ANY(v_browser))
      THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: % has the wrong browser access',r.f; END IF;
    -- A browser-callable function runs as its owner, so it must pin its own search path.
    IF r.f=ANY(v_browser) AND (NOT r.prosecdef OR r.config NOT LIKE 'search_path=%')
      THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: % must be SECURITY DEFINER with a fixed search_path',r.f; END IF;
  END LOOP;

  -- Tables: exactly the reviewed set, row-level security on every one, and no browser role beyond reading the nine.
  SELECT string_agg(t,'; ' ORDER BY t) INTO v_problem FROM (
    SELECT COALESCE(a.t,e.t)||CASE WHEN e.t IS NULL THEN ' is not part of the release' ELSE ' is missing' END AS t
    FROM (SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname LIKE 'pool\_platform\_%') a
    FULL JOIN (SELECT unnest(v_readable||v_closed) AS t) e ON e.t=a.t
    WHERE a.t IS NULL OR e.t IS NULL) d;
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: %',v_problem; END IF;

  FOR r IN SELECT c.oid,n.nspname||'.'||c.relname AS t,c.relname::text AS name,c.relkind,c.relrowsecurity,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END::"char",c.relowner))) x WHERE x.grantee=0) AS open_to_public
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE c.relkind IN ('r','p','S') AND ((n.nspname='public' AND c.relname LIKE 'pool\_platform\_%')
              OR (n.nspname='pool_platform_private')) LOOP
    IF r.open_to_public THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: % is granted to PUBLIC',r.t; END IF;
    IF r.relkind='S' THEN
      IF has_sequence_privilege('authenticated',r.oid,'USAGE') OR has_sequence_privilege('authenticated',r.oid,'SELECT')
         OR has_sequence_privilege('authenticated',r.oid,'UPDATE') OR has_sequence_privilege('anonymous',r.oid,'USAGE')
         OR has_sequence_privilege('anonymous',r.oid,'SELECT') OR has_sequence_privilege('anonymous',r.oid,'UPDATE')
        THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: a browser role can use sequence %',r.t; END IF;
      CONTINUE;
    END IF;
    IF NOT r.relrowsecurity THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: % has no row-level security',r.t; END IF;
    IF has_any_column_privilege('anonymous',r.oid,'SELECT') OR has_any_column_privilege('anonymous',r.oid,'INSERT')
       OR has_any_column_privilege('anonymous',r.oid,'UPDATE') OR has_table_privilege('anonymous',r.oid,'DELETE')
       OR has_table_privilege('anonymous',r.oid,'TRUNCATE') OR has_any_column_privilege('anonymous',r.oid,'REFERENCES')
       OR has_table_privilege('anonymous',r.oid,'TRIGGER')
      THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: % is reachable without signing in',r.t; END IF;
    IF has_any_column_privilege('authenticated',r.oid,'INSERT') OR has_any_column_privilege('authenticated',r.oid,'UPDATE')
       OR has_table_privilege('authenticated',r.oid,'DELETE') OR has_table_privilege('authenticated',r.oid,'TRUNCATE')
       OR has_any_column_privilege('authenticated',r.oid,'REFERENCES') OR has_table_privilege('authenticated',r.oid,'TRIGGER')
      THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: a signed-in browser can write %',r.t; END IF;
    IF has_any_column_privilege('authenticated',r.oid,'SELECT') IS DISTINCT FROM (r.t LIKE 'public.%' AND r.name=ANY(v_readable))
      THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: % has the wrong browser read access',r.t; END IF;
  END LOOP;

  -- The new tables have no policy, so even a stray grant would show a browser role no row; the nine keep theirs.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=ANY(v_closed))
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename=ANY(v_readable))<>9
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname IN ('public','pool_platform_private')
                AND (cmd<>'SELECT' OR roles::text<>'{authenticated}'))
    THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: the row-level policies are not the nine reviewed read policies'; END IF;

  -- Recorded final scores and their evidence can only be added to: UPDATE, DELETE and TRUNCATE are all refused.
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND t.tgenabled='O' AND n.nspname='public'
        AND c.relname IN ('pool_platform_week_result_revisions','pool_platform_week_result_evidence')
        AND t.tgfoid='public.pool_platform_forbid_result_revision_change()'::regprocedure)<>4
    THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: the append-only guards on recorded results are incomplete'; END IF;

  -- A fresh installation: the release itself records nothing.
  IF EXISTS (SELECT 1 FROM public.pool_platform_email_invite_grants)
     OR EXISTS (SELECT 1 FROM public.pool_platform_verified_schedule_catalog)
     OR EXISTS (SELECT 1 FROM public.pool_platform_week_operations_audit)
     OR EXISTS (SELECT 1 FROM public.pool_platform_week_result_revisions)
     OR EXISTS (SELECT 1 FROM public.pool_platform_week_result_evidence)
    THEN RAISE EXCEPTION 'commercial_release_postcondition_failed: a new table already holds rows'; END IF;
  RAISE NOTICE 'schema and privileges are as reviewed: % browser functions, % private functions, % readable tables, % closed tables',
    cardinality(v_browser),cardinality(v_private),cardinality(v_readable),cardinality(v_closed);
END
$post$;
