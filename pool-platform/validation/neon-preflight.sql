-- Commercial V1 Step 2 - live Neon PREFLIGHT (read-only).
-- Run on the dedicated commercial/dev database AFTER Neon Auth and the Data API are provisioned and BEFORE
-- 001/002 are applied, connected as the role that will run and own the migrations. It is one SELECT over the
-- system catalogs: it runs unchanged in psql, the Neon SQL Editor or a single HTTP SQL call, writes nothing,
-- and can be wrapped in BEGIN READ ONLY; ... ROLLBACK;.
--
-- required = true  -> a gate: ok must be true.
-- required = false -> informational: record actual in the validation report.
-- P99 is the verdict. Unless P99 has ok = true, STOP and do not apply the migrations. An error while running
-- this file is also a STOP.
WITH
ver AS (SELECT current_setting('server_version_num')::int AS num),
me AS (SELECT oid,rolname::text AS rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user),
pub AS (SELECT to_regnamespace('public')::oid AS oid),
-- The personal Pool Center (nfl-pool/) uses database nfl_pool with public.nfl_pool_weeks and
-- public.nfl_survivor_weeks; its RLS policies are named nfl_survivor_*.
personal AS (
  SELECT 'relation '||n.nspname||'.'||c.relname AS found
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relname IN ('nfl_pool_weeks','nfl_survivor_weeks')
  UNION ALL
  SELECT 'policy '||polname FROM pg_policy WHERE polname LIKE 'nfl\_survivor\_%'
),
existing AS (
  SELECT (SELECT count(*) FROM pg_class WHERE relnamespace=(SELECT oid FROM pub) AND relname LIKE 'pool\_platform\_%') AS rels,
         (SELECT count(*) FROM pg_proc WHERE pronamespace=(SELECT oid FROM pub) AND proname LIKE 'pool\_platform\_%') AS procs
),
roles AS (
  SELECT r.name,a.oid IS NOT NULL AS present,a.rolcanlogin,a.rolsuper,a.rolbypassrls
  FROM unnest(ARRAY['anonymous','authenticated']) r(name)
  LEFT JOIN pg_roles a ON a.rolname=r.name
),
-- Every other role anonymous/authenticated belong to, directly or through other roles. 002 cannot undo what
-- membership in a privileged role gives them.
reach AS (
  SELECT m.rolname::text AS member,g.rolname::text AS granted,
         g.rolname=current_user OR g.rolsuper OR g.rolbypassrls
         OR g.rolname IN ('pg_read_all_data','pg_write_all_data','pg_maintain','pg_database_owner',
                          'pg_execute_server_program','pg_read_server_files','pg_write_server_files') AS privileged
  FROM pg_roles m JOIN pg_roles g ON g.oid<>m.oid AND pg_has_role(m.oid,g.oid,'MEMBER')
  WHERE m.rolname IN ('anonymous','authenticated')
),
authfn AS (
  SELECT format_type(p.prorettype,NULL) AS rettype
  FROM pg_proc p WHERE p.oid=to_regprocedure('auth.user_id()')
),
-- The columns 002's identity helpers read; they run as the migration role, so it must be able to read them.
authcol AS (
  SELECT c.name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
         has_column_privilege(current_user,a.attrelid,a.attnum,'SELECT') AS readable
  FROM unnest(ARRAY['id','email','emailVerified','banned']) c(name)
  LEFT JOIN pg_attribute a
    ON a.attrelid=to_regclass('neon_auth."user"') AND a.attname=c.name AND a.attnum>0 AND NOT a.attisdropped
),
pgcrypto AS (
  SELECT n.nspname::text AS nsp FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'
),
defacl AS (
  SELECT d.defaclrole,d.defaclnamespace,d.defaclobjtype::text AS objtype,x.grantee,
         pg_get_userbyid(d.defaclrole)::text AS for_role,
         CASE WHEN d.defaclnamespace=0 THEN 'all schemas' ELSE d.defaclnamespace::regnamespace::text END AS in_schema,
         CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences' WHEN 'f' THEN 'functions'
              WHEN 'T' THEN 'types' WHEN 'n' THEN 'schemas' ELSE d.defaclobjtype::text END AS objects,
         CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END AS grantee_name,
         x.privilege_type||CASE WHEN x.is_grantable THEN '+grant_option' ELSE '' END AS privilege
  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
),
-- Default privileges that will apply to the tables, sequence and functions the migration role creates in
-- public. 002 revokes ALL from PUBLIC, anonymous and authenticated on every one of them (on PostgreSQL 17
-- that includes table MAINTAIN), so only entries for other grantees survive the migrations.
applies AS (
  SELECT defacl.*,grantee=0 OR grantee_name IN ('anonymous','authenticated') AS reset_by_002
  FROM defacl
  WHERE defaclrole=(SELECT oid FROM me) AND defaclnamespace IN (0,(SELECT oid FROM pub)) AND grantee<>defaclrole
    AND objtype IN ('r','S','f')
),
checks AS (
  SELECT 'P01' AS check_id,'PostgreSQL major version' AS check_name,true AS required,
         '16 or 17: the versions the local integration suite verifies (17 adds the table MAINTAIN privilege)' AS expected,
         version()||' (server_version_num '||num||')' AS actual,
         num/10000 IN (16,17) AS ok
  FROM ver
  UNION ALL
  SELECT 'P02','connection identity',false,'report',
         'database '||current_database()||' (oid '||(SELECT oid FROM pg_database WHERE datname=current_database())
           ||'); current_user '||current_user||'; session_user '||session_user||'; search_path '||current_setting('search_path'),
         NULL
  UNION ALL
  SELECT 'P03','not the personal Pool Center database',true,'current_database() is not nfl_pool',
         current_database(),current_database()<>'nfl_pool'
  UNION ALL
  SELECT 'P04','no personal Pool Center objects',true,
         'no nfl_pool_weeks or nfl_survivor_weeks relation and no nfl_survivor_* policy in any schema',
         COALESCE((SELECT string_agg(found,', ' ORDER BY found) FROM personal),'none'),
         NOT EXISTS (SELECT 1 FROM personal)
  UNION ALL
  SELECT 'P05','fresh database: no pool_platform_* objects in public',true,'0 relations, 0 functions',
         rels||' relations, '||procs||' functions',rels=0 AND procs=0
  FROM existing
  UNION ALL
  SELECT 'P06','role '||name||' (Data API)',true,'present; not superuser; no BYPASSRLS',
         CASE WHEN present THEN 'present; login='||rolcanlogin||'; super='||rolsuper||'; bypassrls='||rolbypassrls ELSE 'MISSING' END,
         present AND NOT rolsuper AND NOT rolbypassrls
  FROM roles
  UNION ALL
  SELECT 'P07','auth.user_id() (pg_session_jwt)',true,'function auth.user_id() returning text',
         COALESCE((SELECT 'returns '||rettype FROM authfn),'MISSING'),
         COALESCE((SELECT rettype='text' FROM authfn),false)
  UNION ALL
  SELECT 'P08','migration role can call auth.user_id()',true,
         'USAGE on schema auth and EXECUTE on auth.user_id() (002''s SECURITY DEFINER helpers call it as their owner)',
         'schema USAGE='||COALESCE(has_schema_privilege(current_user,to_regnamespace('auth'),'USAGE')::text,'no schema')
           ||'; EXECUTE='||COALESCE(has_function_privilege(current_user,to_regprocedure('auth.user_id()'),'EXECUTE')::text,'no function'),
         COALESCE(has_schema_privilege(current_user,to_regnamespace('auth'),'USAGE')
                  AND has_function_privilege(current_user,to_regprocedure('auth.user_id()'),'EXECUTE'),false)
  UNION ALL
  SELECT 'P09','pg_session_jwt extension',false,'report',
         COALESCE((SELECT extname||' '||extversion||' in schema '||extnamespace::regnamespace::text FROM pg_extension WHERE extname='pg_session_jwt'),'not installed'),
         NULL
  UNION ALL
  SELECT 'P10','neon_auth."user" table (Neon Auth)',true,'present',
         CASE WHEN to_regclass('neon_auth."user"') IS NULL THEN 'MISSING' ELSE 'present' END,
         to_regclass('neon_auth."user"') IS NOT NULL
  UNION ALL
  SELECT 'P11','neon_auth."user".'||quote_ident(name),true,
         CASE name WHEN 'id' THEN 'present (compared as text)' WHEN 'email' THEN 'text or character varying' ELSE 'boolean' END,
         COALESCE(type||CASE WHEN attnotnull THEN ' NOT NULL' ELSE ' NULL' END,'MISSING'),
         COALESCE(CASE name WHEN 'id' THEN type IS NOT NULL
                            WHEN 'email' THEN type IN ('text','character varying')
                            ELSE type='boolean' END,false)
  FROM authcol
  UNION ALL
  SELECT 'P12','migration role can read neon_auth."user"',true,
         'USAGE on schema neon_auth and SELECT on id, email, "emailVerified", banned (read as the helpers'' owner)',
         'schema USAGE='||COALESCE(has_schema_privilege(current_user,to_regnamespace('neon_auth'),'USAGE')::text,'no schema')
           ||'; readable columns '||(SELECT count(*) FILTER (WHERE readable) FROM authcol)||'/4',
         COALESCE(has_schema_privilege(current_user,to_regnamespace('neon_auth'),'USAGE'),false)
           AND (SELECT count(*) FILTER (WHERE readable)=4 FROM authcol)
  UNION ALL
  SELECT 'P13','pgcrypto location',true,'not installed yet (001 creates it) or installed in public',
         COALESCE((SELECT 'installed in '||nsp FROM pgcrypto),'not installed'),
         COALESCE((SELECT nsp='public' FROM pgcrypto),true)
  UNION ALL
  SELECT 'P14','extension creation schema',true,'public (001 runs CREATE EXTENSION pgcrypto without a schema)',
         COALESCE((current_schemas(false))[1],'(none)'),
         COALESCE((current_schemas(false))[1]='public',false)
  UNION ALL
  SELECT 'P15','migration role can CREATE in public',true,'true',
         COALESCE(has_schema_privilege(current_user,(SELECT oid FROM pub),'CREATE')::text,'no schema public'),
         COALESCE(has_schema_privilege(current_user,(SELECT oid FROM pub),'CREATE'),false)
  UNION ALL
  SELECT 'P16','migration role',true,
         'not a superuser and not a Data API role (it will own the SECURITY DEFINER functions)',
         rolname||'; super='||rolsuper||'; bypassrls='||rolbypassrls,
         NOT rolsuper AND rolname NOT IN ('anonymous','authenticated')
  FROM me
  UNION ALL
  SELECT 'P17','anonymous/authenticated role memberships',true,
         'no membership in the migration role, a superuser or BYPASSRLS role, or a privileged predefined role',
         COALESCE((SELECT string_agg(member||' in '||granted||CASE WHEN privileged THEN ' (privileged)' ELSE '' END,', ' ORDER BY member,granted) FROM reach),'none'),
         NOT EXISTS (SELECT 1 FROM reach WHERE privileged)
  UNION ALL
  SELECT 'P18','CREATE on schema public for PUBLIC',true,
         'not granted (002 revokes CREATE only from anonymous and authenticated, who would inherit it from PUBLIC)',
         COALESCE((SELECT string_agg(entry,', ' ORDER BY entry)
                   FROM (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END||':'||a.privilege_type AS entry
                         FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
                         WHERE n.oid=(SELECT oid FROM pub) AND a.grantee<>n.nspowner) s),'no non-owner entries'),
         NOT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
                     WHERE n.oid=(SELECT oid FROM pub) AND a.grantee=0 AND a.privilege_type='CREATE')
  UNION ALL
  SELECT 'P19','default privileges 002 resets',false,
         'report: PUBLIC/anonymous/authenticated defaults on the tables, sequence and functions the migration role creates in public',
         COALESCE((SELECT string_agg(objects||' in '||in_schema||': '||grantee_name||':'||privilege,'; '
                                     ORDER BY objects,in_schema,grantee_name,privilege) FROM applies WHERE reset_by_002),'none'),
         NULL
  UNION ALL
  SELECT 'P20','default privileges 002 does not reset',true,
         'none: a default for any other grantee on tables, sequences or functions would survive the migrations',
         COALESCE((SELECT string_agg(objects||' in '||in_schema||': '||grantee_name||':'||privilege,'; '
                                     ORDER BY objects,in_schema,grantee_name,privilege) FROM applies WHERE NOT reset_by_002),'none'),
         NOT EXISTS (SELECT 1 FROM applies WHERE NOT reset_by_002)
  UNION ALL
  SELECT 'P21','all default privileges (any role, any schema)',false,'report',
         COALESCE((SELECT string_agg(for_role||' in '||in_schema||' '||objects||': '||grantee_name||':'||privilege,'; '
                                     ORDER BY for_role,in_schema,objects,grantee_name,privilege) FROM defacl),'none'),
         NULL
)
SELECT check_id,check_name,required,expected,actual,ok FROM checks
UNION ALL
SELECT 'P99','verdict',true,'every required row has ok = true',
       CASE WHEN bool_and(COALESCE(ok,false)) FILTER (WHERE required) THEN 'PASS'
            ELSE 'STOP: '||string_agg(DISTINCT check_id,', ' ORDER BY check_id) FILTER (WHERE required AND ok IS NOT TRUE) END,
       COALESCE(bool_and(COALESCE(ok,false)) FILTER (WHERE required),false)
FROM checks
ORDER BY check_id,check_name;
