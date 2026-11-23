\set ON_ERROR_STOP on
-- Undoes retire-legacy-invites.sql: a signed-in browser may call the two original invitation functions again, as
-- migration 002 granted them. Needed only when the previous frontend is published again after the retirement.
BEGIN;
\ir verify-target.sql
\ir data-fingerprint.sql
GRANT EXECUTE ON FUNCTION public.pool_platform_create_entry_invite(uuid,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pool_platform_claim_entry_invite(text) TO authenticated;
DO $restored$
BEGIN
  IF NOT has_function_privilege('authenticated','public.pool_platform_create_entry_invite(uuid,text,integer)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.pool_platform_claim_entry_invite(text)','EXECUTE')
     OR has_function_privilege('anonymous','public.pool_platform_create_entry_invite(uuid,text,integer)','EXECUTE')
     OR has_function_privilege('anonymous','public.pool_platform_claim_entry_invite(text)','EXECUTE')
    THEN RAISE EXCEPTION 'legacy_invitation_restore_failed'; END IF;
END
$restored$;
\ir verify-data-unchanged.sql
COMMIT;
