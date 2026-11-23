\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database()<>'phase9_invite_fixture'
  THEN RAISE EXCEPTION 'fixture_database_required'; END IF; END $$;
SELECT fixture.assert_true(
  has_function_privilege('authenticated','public.pool_platform_create_entry_invite(uuid,text,integer)','EXECUTE'),
  'PREDEPLOY must not break the still-running legacy frontend');
SELECT fixture.assert_true(
  has_function_privilege('authenticated','public.pool_platform_claim_entry_invite(text)','EXECUTE'),
  'PREDEPLOY must not break outstanding legacy invitation claims');
SELECT fixture.assert_true(
  has_function_privilege('authenticated','public.pool_platform_create_email_invite(uuid,text,integer)','EXECUTE')
  AND has_function_privilege('authenticated','public.pool_platform_claim_email_invite(uuid)','EXECUTE'),
  'new verified email RPCs available for staged frontend');
SELECT fixture.assert_true(
 NOT has_table_privilege('authenticated','public.pool_platform_email_invite_grants','SELECT,INSERT,UPDATE,DELETE'),
  'new grants table direct access denied');
SELECT fixture.assert_true(
 (SELECT count(*)=0 FROM public.pool_platform_email_invite_grants),
 'predeploy does not create invitation grants');
SELECT fixture.assert_true(
 (SELECT count(*)=1 AND min(claimed_at) IS NULL AND min(revoked_at) IS NULL
    FROM public.pool_platform_entry_invites),
 'preexisting legacy invite record unchanged');
