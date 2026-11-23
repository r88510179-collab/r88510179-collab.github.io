\set ON_ERROR_STOP on
-- One transaction. Run only after the published frontend has issued and claimed a verified-email invitation.
BEGIN;
\ir verify-target.sql
-- Also blocks new legacy invitations between the check below and the revocation.
\ir data-fingerprint.sql
DO $invites$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pool_platform_entry_invites i
    JOIN public.pool_platform_entries e ON e.id = i.entry_id
    JOIN public.pool_platform_seasons s ON s.id = e.season_id
    JOIN public.pool_platform_pools p ON p.id = s.pool_id
    JOIN public.pool_platform_tenants t ON t.id = p.tenant_id
    WHERE i.claimed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      AND e.owner_auth_user_id IS NULL AND e.status = 'active'
      AND s.status IN ('setup','active') AND p.status = 'active' AND t.status = 'active'
  ) THEN
    RAISE EXCEPTION 'outstanding_legacy_invitations_require_review';
  END IF;
END
$invites$;
\ir ../../migrations/20261104_phase9_sso_safe_email_invites_cutover.sql
DO $retired$
BEGIN
  IF has_function_privilege('authenticated','public.pool_platform_create_entry_invite(uuid,text,integer)','EXECUTE')
     OR has_function_privilege('authenticated','public.pool_platform_claim_entry_invite(text)','EXECUTE')
     OR has_function_privilege('anonymous','public.pool_platform_create_entry_invite(uuid,text,integer)','EXECUTE')
     OR has_function_privilege('anonymous','public.pool_platform_claim_entry_invite(text)','EXECUTE')
    THEN RAISE EXCEPTION 'legacy_invitation_functions_still_callable'; END IF;
  IF NOT has_function_privilege('authenticated','public.pool_platform_create_email_invite(uuid,text,integer)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.pool_platform_claim_email_invite(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'email_invite_grants_missing'; END IF;
END
$retired$;
-- Every invitation, claimed or not, and every claimed entry is exactly as it was: only two grants changed.
\ir verify-data-unchanged.sql
COMMIT;
