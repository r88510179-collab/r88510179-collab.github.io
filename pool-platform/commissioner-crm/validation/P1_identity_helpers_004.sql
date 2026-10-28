-- P1 (READ ONLY): installed state of migration 004 on the commercial production branch.
-- Run as the migration owner (the role that owns the pool_platform_* tables), wrapped in
-- BEGIN READ ONLY; ... ROLLBACK;. One SELECT over the catalogs: it reads no table row and no neon_auth data, and it
-- returns no id, email, token or key. H99 is the verdict. The hardened and pre-hardening fingerprints are the
-- ones migration 004 itself carries (SHA-256 of pg_proc.prosrc), reproduced from the repository.
WITH
expected(sig,hardened,pre_hardening) AS (VALUES
  ('public.pool_platform_current_user_id()','001b760143c8affb11125394a7cf0f5b2f52fe6b24bde10a61ed5056357dd8c8','7702b14277266031188e451f3245a76b99b5a7a68153ed11075fe7356e932b5d'),
  ('public.pool_platform_current_user_email()','b605c8f54b4b386607aff82a6fc92b70b116362462052f697e7671a3ee0974da','2cf7b7b80696acc8b22486daaff2a0cfa26f1f9fecab991fcd823d17a64db3c5'),
  ('public.pool_platform_current_user_has_verified_email(text)','7615a729ee19823e61363351fcd03a15b94f2bc74948d4509fc0a17f493e2271','5120424105ba729e50e82bfd365720ef31a2f1eb323afe66da36b2cf8fb1f0c3')
),
owner AS (SELECT c.relowner AS oid FROM pg_class c WHERE c.oid=to_regclass('public.pool_platform_pools')),
helpers AS (
  SELECT e.sig,e.hardened,e.pre_hardening,p.oid,p.prosecdef,array_to_string(p.proconfig,',') AS config,p.proowner,
         encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
  FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.sig)
),
fpriv AS (
  SELECT h.sig,
         has_function_privilege('public',h.oid,'EXECUTE') AS pub,
         has_function_privilege('anonymous',h.oid,'EXECUTE') AS anon,
         has_function_privilege('authenticated',h.oid,'EXECUTE') AS auth
  FROM helpers h WHERE h.oid IS NOT NULL
),
session_fn AS (SELECT p.oid,p.prorettype FROM pg_proc p WHERE p.oid=to_regprocedure('auth.session()')),
account_col AS (
  SELECT a.attrelid,a.attnum FROM pg_attribute a
  WHERE a.attrelid=to_regclass('neon_auth.account') AND a.attname='userId' AND a.attnum>0 AND NOT a.attisdropped
    AND a.atttypid=(SELECT u.atttypid FROM pg_attribute u
                    WHERE u.attrelid=to_regclass('neon_auth."user"') AND u.attname='id' AND u.attnum>0 AND NOT u.attisdropped)
),
checks(check_id,check_name,required,expected,actual,ok) AS (
  SELECT 'H01','identity helper bodies',true,'each of the three hashes to 004''s hardened column',
         (SELECT string_agg(regexp_replace(sig,'^public\.pool_platform_','')||'='
                 ||CASE WHEN body_sha256=hardened THEN 'hardened' WHEN body_sha256=pre_hardening THEN 'PRE-HARDENING'
                        WHEN oid IS NULL THEN 'MISSING' ELSE 'UNREVIEWED '||left(body_sha256,12) END,'; ' ORDER BY sig) FROM helpers),
         (SELECT count(*)=3 AND bool_and(body_sha256=hardened) FROM helpers)
  UNION ALL
  SELECT 'H02','helper attributes',true,'SECURITY DEFINER; search_path=public, neon_auth, pg_temp; owned by the commercial table owner',
         COALESCE((SELECT string_agg(regexp_replace(sig,'^public\.pool_platform_','')||' secdef='||prosecdef||' config='||COALESCE(config,'')
                 ||' owner_ok='||(proowner=(SELECT oid FROM owner)),'; ' ORDER BY sig) FROM helpers WHERE oid IS NOT NULL),'MISSING'),
         (SELECT count(*)=3 AND bool_and(prosecdef AND config='search_path=public, neon_auth, pg_temp' AND proowner=(SELECT oid FROM owner)) FROM helpers WHERE oid IS NOT NULL)
  UNION ALL
  SELECT 'H03','helper EXECUTE privileges',true,
         'current_user_id(): authenticated only; email and has_verified_email: nobody but the owner; nothing for PUBLIC or anonymous',
         COALESCE((SELECT string_agg(regexp_replace(sig,'^public\.pool_platform_','')||' public='||pub||' anonymous='||anon||' authenticated='||auth,'; ' ORDER BY sig) FROM fpriv),'MISSING'),
         (SELECT count(*)=3 AND bool_and(NOT pub AND NOT anon AND auth=(sig='public.pool_platform_current_user_id()')) FROM fpriv)
  UNION ALL
  SELECT 'H04','auth.session() returns jsonb',true,'present and returning jsonb (pg_session_jwt)',
         COALESCE((SELECT 'present, returns '||format_type(prorettype,NULL) FROM session_fn),'MISSING'),
         COALESCE((SELECT prorettype='jsonb'::regtype FROM session_fn),false)
  UNION ALL
  SELECT 'H05','neon_auth.account."userId"',true,'present, of the type of neon_auth."user".id',
         CASE WHEN EXISTS (SELECT 1 FROM account_col) THEN 'present' ELSE 'MISSING or of another type' END,
         EXISTS (SELECT 1 FROM account_col)
  UNION ALL
  SELECT 'H06','the helpers'' owner can read what 004 reads',true,
         'USAGE on auth and EXECUTE on auth.session(); USAGE on neon_auth and SELECT on neon_auth.account."userId"',
         'auth.session()='||COALESCE((SELECT (has_schema_privilege((SELECT oid FROM owner),to_regnamespace('auth'),'USAGE')
                                              AND has_function_privilege((SELECT oid FROM owner),oid,'EXECUTE'))::text FROM session_fn),'MISSING')
           ||'; account.userId='||COALESCE((SELECT (has_schema_privilege((SELECT oid FROM owner),to_regnamespace('neon_auth'),'USAGE')
                                                    AND has_column_privilege((SELECT oid FROM owner),attrelid,attnum,'SELECT'))::text FROM account_col),'MISSING'),
         COALESCE((SELECT has_schema_privilege((SELECT oid FROM owner),to_regnamespace('auth'),'USAGE')
                          AND has_function_privilege((SELECT oid FROM owner),oid,'EXECUTE') FROM session_fn),false)
         AND COALESCE((SELECT has_schema_privilege((SELECT oid FROM owner),to_regnamespace('neon_auth'),'USAGE')
                              AND has_column_privilege((SELECT oid FROM owner),attrelid,attnum,'SELECT') FROM account_col),false)
  UNION ALL
  SELECT 'H07','session role',false,'report: the role running this file, and whether it is the commercial table owner',
         current_user::text||' owner='||(current_user=pg_get_userbyid((SELECT oid FROM owner))),NULL
)
SELECT check_id,check_name,required,expected,actual,ok FROM checks
UNION ALL
SELECT 'H99','verdict',true,'every required row has ok = true',
       CASE WHEN bool_and(COALESCE(ok,false)) FILTER (WHERE required) THEN 'PASS'
            ELSE 'FINDINGS: '||string_agg(DISTINCT check_id,', ' ORDER BY check_id) FILTER (WHERE required AND ok IS NOT TRUE) END,
       COALESCE(bool_and(COALESCE(ok,false)) FILTER (WHERE required),false)
FROM checks
ORDER BY check_id;
