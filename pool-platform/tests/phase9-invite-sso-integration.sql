\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database()<>'phase9_invite_fixture'
  THEN RAISE EXCEPTION 'fixture_database_required'; END IF; END $$;
BEGIN;
SELECT fixture.assert_true(
 NOT has_function_privilege('authenticated',
  'public.pool_platform_claim_entry_invite(text)','EXECUTE'),
 'legacy bearer claim inaccessible to browser role');
SELECT fixture.assert_true(
 NOT has_function_privilege('authenticated',
  'public.pool_platform_create_entry_invite(uuid,text,integer)','EXECUTE'),
 'legacy bearer issue inaccessible to browser role');
SELECT fixture.assert_true(
 NOT has_function_privilege('anonymous',
  'public.pool_platform_claim_email_invite(uuid)','EXECUTE'),
 'anonymous may not claim');
SELECT fixture.assert_true(
 NOT has_function_privilege('anonymous',
  'public.pool_platform_create_email_invite(uuid,text,integer)','EXECUTE'),
 'anonymous may not issue');
SELECT fixture.assert_true(
 has_function_privilege('authenticated',
  'public.pool_platform_claim_email_invite(uuid)','EXECUTE'),
 'authenticated recipient can call verified-email claim');
SELECT fixture.assert_true(
 NOT has_table_privilege('authenticated',
  'public.pool_platform_email_invite_grants','SELECT,INSERT,UPDATE,DELETE'),
 'authenticated role has no direct invite-table rights');
SELECT fixture.assert_true(
 (SELECT count(*)=0 FROM public.pool_platform_email_invite_grants),
 'migration does not create invitations');
SELECT fixture.assert_true(
 (SELECT count(*)=1 AND min(claimed_at) IS NULL AND min(revoked_at) IS NULL
  FROM public.pool_platform_entry_invites),
 'legacy invitations are preserved unchanged');


SET LOCAL ROLE anonymous;
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_claim_email_invite('40000000-0000-0000-0000-000000000001')$q$,
  'permission denied');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('fixture.subject','',true);
SELECT set_config('fixture.email','',true);
SELECT set_config('fixture.verified','off',true);
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_create_email_invite('40000000-0000-0000-0000-000000000001','alpha@example.test',168)$q$,
  'auth_required');
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_claim_email_invite('40000000-0000-0000-0000-000000000001')$q$,
  'auth_required');

SELECT set_config('fixture.subject','alpha-owner',true);
SELECT set_config('fixture.email','alpha-owner@example.test',true);
SELECT set_config('fixture.verified','on',true);
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_create_email_invite('40000000-0000-0000-0000-000000000002','beta@example.test',168)$q$,
  'commissioner_required');
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_create_email_invite('40000000-0000-0000-0000-000000000001','invalid',168)$q$,
  'invalid_invite_email');
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_create_email_invite('40000000-0000-0000-0000-000000000001','alpha@example.test',0)$q$,
  'invalid_invite_expiry');
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_create_email_invite('40000000-0000-0000-0000-000000000001','alpha@example.test',NULL)$q$,
  'invalid_invite_expiry');
SELECT fixture.assert_true(
 (public.pool_platform_create_email_invite(
  '40000000-0000-0000-0000-000000000001','alpha@example.test',168)) ? 'entry_id',
 'commissioner creates a recipient-bound invite');
RESET ROLE;
SELECT fixture.assert_true(
 (SELECT count(*)=1 FROM public.pool_platform_email_invite_grants
  WHERE entry_id='40000000-0000-0000-0000-000000000001'
  AND email_normalized='alpha@example.test' AND claimed_at IS NULL),
 'separate token-free email grant stored for verified recipient');
SELECT fixture.assert_true(
 NOT (SELECT jsonb_build_object('entry_id','40000000-0000-0000-0000-000000000001') ? 'invite_token'),
 'no browser invite token is needed');

SET LOCAL ROLE authenticated;
-- This account matches the email on a LEGACY bearer invitation for entry 3.
-- New claim RPC MUST NOT treat that old invitation as an email-grant credential.
SELECT set_config('fixture.subject','alpha-player',true);
SELECT set_config('fixture.email','alpha@example.test',true);
SELECT set_config('fixture.verified','on',true);
SELECT fixture.expect_error(
 $q$SELECT public.pool_platform_claim_email_invite('40000000-0000-0000-0000-000000000003')$q$,
 'invite_unavailable');
SELECT set_config('fixture.subject','beta-player',true);
SELECT set_config('fixture.email','beta@example.test',true);
SELECT set_config('fixture.verified','on',true);
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_claim_email_invite('40000000-0000-0000-0000-000000000001')$q$,
  'invite_unavailable');
SELECT set_config('fixture.subject','alpha-player',true);
SELECT set_config('fixture.email','alpha@example.test',true);
SELECT set_config('fixture.verified','off',true);
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_claim_email_invite('40000000-0000-0000-0000-000000000001')$q$,
  'invite_email_unverified');
SELECT set_config('fixture.verified','on',true);
SELECT fixture.assert_true(
 (public.pool_platform_claim_email_invite(
  '40000000-0000-0000-0000-000000000001')->>'claimed')::boolean,
 'only verified matching recipient can claim');
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_claim_email_invite('40000000-0000-0000-0000-000000000001')$q$,
  'invite_unavailable');
RESET ROLE;
SELECT fixture.assert_true(
 (SELECT owner_auth_user_id='alpha-player' FROM public.pool_platform_entries
  WHERE id='40000000-0000-0000-0000-000000000001'),
 'new owner bound to signed recipient');
SELECT fixture.assert_true(
 (SELECT claimed_by_auth_user_id='alpha-player' AND claimed_at IS NOT NULL
  FROM public.pool_platform_email_invite_grants
  WHERE entry_id='40000000-0000-0000-0000-000000000001'),
 'claim is marked consumed once');
SELECT fixture.assert_true(
 (SELECT count(*)=1 FROM public.pool_platform_email_invite_grants
  WHERE entry_id='40000000-0000-0000-0000-000000000001'),
 'wrong-email and no-auth attempts created no duplicate invites');

SET LOCAL ROLE authenticated;
SELECT set_config('fixture.subject','alpha-owner',true);
SELECT set_config('fixture.email','alpha-owner@example.test',true);
SELECT set_config('fixture.verified','on',true);
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_create_email_invite('40000000-0000-0000-0000-000000000001','alpha@example.test',168)$q$,
  'entry_unavailable');
SELECT public.pool_platform_create_email_invite(
  '40000000-0000-0000-0000-000000000003','alpha@example.test',168);
SELECT public.pool_platform_create_email_invite(
  '40000000-0000-0000-0000-000000000004','alpha@example.test',168);
RESET ROLE;
UPDATE public.pool_platform_email_invite_grants
 SET expires_at=now()-interval '1 minute'
 WHERE entry_id='40000000-0000-0000-0000-000000000003';
UPDATE public.pool_platform_email_invite_grants
 SET revoked_at=now()
 WHERE entry_id='40000000-0000-0000-0000-000000000004';
SET LOCAL ROLE authenticated;
SELECT set_config('fixture.subject','alpha-player',true);
SELECT set_config('fixture.email','alpha@example.test',true);
SELECT set_config('fixture.verified','on',true);
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_claim_email_invite('40000000-0000-0000-0000-000000000003')$q$,
  'invite_unavailable');
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_claim_email_invite('40000000-0000-0000-0000-000000000004')$q$,
  'invite_unavailable');
SELECT fixture.expect_error(
  $q$SELECT public.pool_platform_claim_entry_invite('0000000000000000000000000000000000000000000000000000000000000000')$q$,
  'permission denied');
RESET ROLE;
SELECT fixture.assert_true(
 (SELECT count(*)=1 FROM public.pool_platform_entries WHERE owner_auth_user_id IS NOT NULL),
 'only authorized entry ownership changed');
SELECT fixture.assert_true(
 (SELECT count(*)=0 FROM public.pool_platform_email_invite_grants
  WHERE entry_id IN ('40000000-0000-0000-0000-000000000003',
                     '40000000-0000-0000-0000-000000000004')
    AND claimed_at IS NOT NULL),
 'expired and revoked invites untouched');
SELECT fixture.assert_true(
 (SELECT count(*)=1 AND min(claimed_at) IS NULL AND min(revoked_at) IS NULL
  FROM public.pool_platform_entry_invites),
 'legacy invitation state remains untouched by new grant flow');

-- Reissuing an invitation for the same entry must invalidate earlier
-- recipient grants. This prevents two unrelated addresses from competing.
SET LOCAL ROLE authenticated;
SELECT set_config('fixture.subject','alpha-owner',true);
SELECT set_config('fixture.email','alpha-owner@example.test',true);
SELECT set_config('fixture.verified','on',true);
SELECT public.pool_platform_create_email_invite(
  '40000000-0000-0000-0000-000000000005','alpha@example.test',168);
SELECT public.pool_platform_create_email_invite(
  '40000000-0000-0000-0000-000000000005','beta@example.test',168);
RESET ROLE;
SELECT fixture.assert_true(
 (SELECT count(*)=2 AND count(*) FILTER(WHERE revoked_at IS NOT NULL)=1
  FROM public.pool_platform_email_invite_grants
  WHERE entry_id='40000000-0000-0000-0000-000000000005'),
 'reissue rotates previous unclaimed recipient');
SET LOCAL ROLE authenticated;
SELECT set_config('fixture.subject','alpha-player',true);
SELECT set_config('fixture.email','alpha@example.test',true);
SELECT set_config('fixture.verified','on',true);
SELECT fixture.expect_error(
 $q$SELECT public.pool_platform_claim_email_invite('40000000-0000-0000-0000-000000000005')$q$,
 'invite_unavailable');
SELECT set_config('fixture.subject','beta-player',true);
SELECT set_config('fixture.email','beta@example.test',true);
SELECT fixture.assert_true(
 (public.pool_platform_claim_email_invite(
 '40000000-0000-0000-0000-000000000005')->>'claimed')::boolean,
 'latest authorized verified recipient can claim after rotation');
RESET ROLE;
SELECT fixture.assert_true(
 (SELECT owner_auth_user_id='beta-player' FROM public.pool_platform_entries
  WHERE id='40000000-0000-0000-0000-000000000005'),
 'new recipient owns entry after replacement');
SELECT fixture.assert_true(
 (SELECT count(*)=1 AND min(claimed_at) IS NULL
  FROM public.pool_platform_entry_invites),
 'legacy bearer row remains unchanged through recipient rotation');

ROLLBACK;
