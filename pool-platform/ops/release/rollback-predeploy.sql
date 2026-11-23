\set ON_ERROR_STOP on
-- Removes everything predeploy.sql added and nothing else, in one transaction, then proves the schema is the
-- baseline again. The usual rollback does NOT need this: the previous frontend never calls the new functions, so
-- publishing the previous deploy again is enough and the added schema can stay.
--
-- It refuses when a new table holds rows (invitations, recorded final scores or schedule records made since the
-- release): dropping the tables would destroy them. It refuses after retire-legacy-invites.sql as well, because the
-- database would be left with no invitation function a browser can call: run restore-legacy-invites.sql first.
BEGIN;
\ir verify-target.sql
\ir data-fingerprint.sql
DO $refuse$
DECLARE
  v_rows text;
BEGIN
  IF to_regclass('public.pool_platform_week_result_revisions') IS NULL
    THEN RAISE EXCEPTION 'commercial_release_rollback_refused: the release is not installed'; END IF;
  SELECT string_agg(t||' '||n,', ' ORDER BY t) INTO v_rows FROM (
    SELECT 'pool_platform_email_invite_grants' AS t,(SELECT count(*) FROM public.pool_platform_email_invite_grants) AS n
    UNION ALL SELECT 'pool_platform_verified_schedule_catalog',(SELECT count(*) FROM public.pool_platform_verified_schedule_catalog)
    UNION ALL SELECT 'pool_platform_week_operations_audit',(SELECT count(*) FROM public.pool_platform_week_operations_audit)
    UNION ALL SELECT 'pool_platform_week_result_revisions',(SELECT count(*) FROM public.pool_platform_week_result_revisions)
    UNION ALL SELECT 'pool_platform_week_result_evidence',(SELECT count(*) FROM public.pool_platform_week_result_evidence)) c
  WHERE n>0;
  IF v_rows IS NOT NULL
    THEN RAISE EXCEPTION 'commercial_release_rollback_refused: rows would be destroyed (%)',v_rows; END IF;
  IF NOT has_function_privilege('authenticated','public.pool_platform_create_entry_invite(uuid,text,integer)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.pool_platform_claim_entry_invite(text)','EXECUTE')
    THEN RAISE EXCEPTION 'commercial_release_rollback_refused: run restore-legacy-invites.sql first'; END IF;
END
$refuse$;
-- No CASCADE anywhere: an object this file does not name stops the rollback instead of disappearing with it.
DROP FUNCTION public.pool_platform_season_standings_snapshot(uuid,integer);
DROP FUNCTION public.pool_platform_attest_week_final_results_with_source(uuid,integer,jsonb,text,text,text);
DROP FUNCTION public.pool_platform_week_result_snapshot(uuid);
DROP FUNCTION public.pool_platform_attest_week_final_results(uuid,integer,jsonb,text,text);
DROP TABLE public.pool_platform_week_result_evidence;
DROP TABLE public.pool_platform_week_result_revisions;
DROP FUNCTION public.pool_platform_forbid_result_revision_change();
DROP FUNCTION public.pool_platform_week_projection_snapshot(uuid);
DROP FUNCTION public.pool_platform_open_verified_week(uuid,text,boolean);
DROP FUNCTION public.pool_platform_apply_verified_schedule(uuid,text,boolean);
DROP FUNCTION public.pool_platform_verified_schedule_preview(uuid);
DROP TABLE public.pool_platform_week_operations_audit;
DROP TABLE public.pool_platform_verified_schedule_catalog;
DROP FUNCTION public.pool_platform_claim_email_invite(uuid);
DROP FUNCTION public.pool_platform_create_email_invite(uuid,text,integer);
DROP TABLE public.pool_platform_email_invite_grants;
DROP FUNCTION public.pool_platform_create_season(uuid,integer);
DROP FUNCTION public.pool_platform_create_pool(uuid,text,text);
DROP INDEX public.pool_platform_pools_global_slug_idx;
DROP FUNCTION public.pool_platform_list_participant_pools();
DROP FUNCTION public.pool_platform_save_draft_schedule(uuid,jsonb);
DROP FUNCTION public.pool_platform_create_draft_week(uuid,integer,timestamptz,timestamptz);
DROP FUNCTION public.pool_platform_create_entry(uuid,text,text);
DROP FUNCTION public.pool_platform_list_commissioner_pools();
-- Exactly the baseline again: the fourteen original functions with their recorded bodies and the nine tables.
\ir verify-baseline-schema.sql
\ir verify-data-unchanged.sql
COMMIT;
