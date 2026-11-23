-- Called inside the release transaction, before any migration. The migrations were rehearsed against one exact
-- starting schema: the live Commercial database as its catalog read on 2026-11-18. This stops the release when the
-- target is not that schema: a function body someone changed, a release object that already exists (the release was
-- applied before), a table without row-level security, or a missing Data API role. Nothing here writes.
DO $baseline$
DECLARE
  -- SHA-256 of pg_proc.prosrc for every pool_platform function in public, keyed by its identity.
  v_expected constant jsonb := '{
    "pool_platform_can_read_pool(p_pool_id uuid)":"9467d14b40d59fc730b23cf2fc7ac000fd3c86eb24a1e12e807e83575bc211a6",
    "pool_platform_can_read_season(p_season_id uuid)":"569d2db7a38ee95a80116fdafe4fb68f9953647176ff6b6ed22da71c8233b02f",
    "pool_platform_claim_entry_invite(p_invite_token text)":"3d786e2c1df719e319099b5d0b31bb70bd4137f3d65d413c0fb54b35c5cc5084",
    "pool_platform_commissioner_context(p_pool_slug text)":"2c926e8002393bfadbbe3154fca287e828ba43cb86e1b4d84443075d5b5c4ad8",
    "pool_platform_create_entry_invite(p_entry_id uuid, p_email text, p_expires_hours integer)":"844b4e4f599a97735ccf54a77f5f241107eaf9f08d3e9d1358f422ba1bf5f6dc",
    "pool_platform_current_user_email()":"bce5cb07c7d761471a55ea89258e4aa26a961a8cf77047558a26d2d32b9c4a40",
    "pool_platform_current_user_has_verified_email(p_email_normalized text)":"a867473bfe429b0dab267a8fecd85adf341ec6cc6d81317f925c90a275bf6a24",
    "pool_platform_current_user_id()":"f71e1d4db89862e8cd6e569f716a29c74d77e63420cc1141d37d0d5cbf0caf4c",
    "pool_platform_guard_submission_source()":"8292052734241e2f9502e5aa2cd994a948360c1aea6c4c03eacb89af74abce4a",
    "pool_platform_is_tenant_commissioner(p_tenant_id uuid)":"0d9d03c29d8ff189dd13819f1d76601219fa5d9675ce9061d049acb67960ef5b",
    "pool_platform_participant_context(p_pool_slug text, p_season integer, p_week integer)":"e1fd95b1caaad63208814326390b4d3ccbb91ec93e88f67f0bcb609f6f4bcd53",
    "pool_platform_payload_valid(p_pool_type text, p_week_config jsonb, p_entry_id uuid, p_week_id uuid, p_payload jsonb)":"584e061834f72a5671e27fdfe9c840da544f9a0ee791d5af3d094c41a14f2b66",
    "pool_platform_submit_batch(p_week_id uuid, p_source text, p_items jsonb)":"d8738a157683c5a35d899c496bea78a2bc32a651686856f999402d47ab66098c",
    "pool_platform_submit_entry(p_week_id uuid, p_entry_id uuid, p_source text, p_payload jsonb)":"f52183734e1f8c42c401e2a507e8c82323c259486909adca49d9537eed523c8f"
  }';
  v_tables constant text[] := ARRAY['pool_platform_entries','pool_platform_entry_invites','pool_platform_memberships',
    'pool_platform_pools','pool_platform_seasons','pool_platform_submission_audit','pool_platform_submissions',
    'pool_platform_tenants','pool_platform_weeks'];
  v_actual jsonb;
  v_found text[];
  v_difference text;
BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('authenticated','anonymous'))<>2
    THEN RAISE EXCEPTION 'commercial_release_baseline_mismatch: the Data API roles authenticated and anonymous must both exist'; END IF;

  SELECT COALESCE(jsonb_object_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
           encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')),'{}'::jsonb)
    INTO v_actual
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'pool\_platform\_%';
  IF v_actual IS DISTINCT FROM v_expected THEN
    SELECT string_agg(k||CASE WHEN NOT (v_expected ? k) THEN ' exists but is not part of the baseline'
                              WHEN NOT (v_actual ? k) THEN ' is missing'
                              ELSE ' has another body' END,'; ' ORDER BY k)
      INTO v_difference
    FROM (SELECT jsonb_object_keys(v_expected) AS k UNION SELECT jsonb_object_keys(v_actual)) keys
    WHERE (v_expected->>k) IS DISTINCT FROM (v_actual->>k);
    RAISE EXCEPTION 'commercial_release_baseline_mismatch: %',v_difference;
  END IF;

  SELECT COALESCE(array_agg(c.relname::text ORDER BY c.relname),ARRAY[]::text[]) INTO v_found
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname LIKE 'pool\_platform\_%';
  IF v_found IS DISTINCT FROM v_tables
    THEN RAISE EXCEPTION 'commercial_release_baseline_mismatch: tables found are %',array_to_string(v_found,', '); END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname=ANY(v_tables) AND NOT c.relrowsecurity)
     OR NOT COALESCE((SELECT c.relrowsecurity FROM pg_class c
                      WHERE c.oid=to_regclass('pool_platform_private.auth_issuer')),false)
    THEN RAISE EXCEPTION 'commercial_release_baseline_mismatch: every application table must have row-level security'; END IF;
  IF (SELECT count(*) FROM pool_platform_private.auth_issuer)<>1
    THEN RAISE EXCEPTION 'commercial_release_baseline_mismatch: pool_platform_private.auth_issuer must hold exactly one issuer'; END IF;
END
$baseline$;
