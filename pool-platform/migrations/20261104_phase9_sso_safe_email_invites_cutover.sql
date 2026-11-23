-- Run after the deployed frontend has issued and claimed a verified-email invitation. Retire the original browser invitation functions.
DO $cutover$
BEGIN
  IF to_regprocedure('public.pool_platform_create_email_invite(uuid,text,integer)') IS NULL
    OR to_regprocedure('public.pool_platform_claim_email_invite(uuid)') IS NULL
    OR to_regclass('public.pool_platform_email_invite_grants') IS NULL
  THEN RAISE EXCEPTION 'invite_predeploy_missing'; END IF;
  IF NOT has_function_privilege('authenticated','public.pool_platform_create_email_invite(uuid,text,integer)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.pool_platform_claim_email_invite(uuid)','EXECUTE')
  THEN RAISE EXCEPTION 'email_invite_grants_missing'; END IF;
END;
$cutover$;

REVOKE ALL ON FUNCTION public.pool_platform_create_entry_invite(uuid,text,integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.pool_platform_create_entry_invite(uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_platform_claim_entry_invite(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.pool_platform_claim_entry_invite(text) FROM PUBLIC;
