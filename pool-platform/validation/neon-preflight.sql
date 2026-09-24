-- Commercial V1 Step 2 - live Neon PREFLIGHT (read-only).
-- Run on the dedicated commercial/dev branch as the role that will own the migrations, AFTER Neon Auth and
-- the Data API are enabled and BEFORE 001/002 are applied. One SELECT statement, so it runs unchanged in
-- psql, the Neon SQL Editor, or a single HTTP SQL call. It reads only catalogs; it writes nothing.
--
-- ok = false  -> STOP: do not apply the migrations; report the row.
-- ok = NULL   -> informational; record the value in the validation report.
WITH
personal AS (
  SELECT string_agg(t,', ') AS found
  FROM unnest(ARRAY['public.nfl_pool_weeks','public.nfl_survivor_weeks']) t
  WHERE to_regclass(t) IS NOT NULL
),
existing AS (
  SELECT
    (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'pool\_platform\_%') AS rels,
    (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'pool\_platform\_%') AS procs
),
roles AS (
  SELECT r.name,a.oid IS NOT NULL AS present,a.rolcanlogin,a.rolsuper,a.rolbypassrls
  FROM unnest(ARRAY['authenticated','anonymous']) r(name)
  LEFT JOIN pg_roles a ON a.rolname=r.name
),
authfn AS (
  SELECT format_type(p.prorettype,NULL) AS rettype
  FROM pg_proc p WHERE p.oid=to_regprocedure('auth.user_id()')
),
authcol AS (
  SELECT c.name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
  FROM unnest(ARRAY['id','email','emailVerified','banned']) c(name)
  LEFT JOIN pg_attribute a
    ON a.attrelid=to_regclass('neon_auth."user"') AND a.attname=c.name AND a.attnum>0 AND NOT a.attisdropped
),
defacl AS (
  SELECT pg_get_userbyid(d.defaclrole) AS for_role,
         COALESCE(n.nspname,'(all schemas)') AS in_schema,
         d.defaclobjtype::text AS objtype,
         CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,
         x.privilege_type
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) x
  WHERE d.defaclnamespace=0 OR n.nspname='public'
),
members AS (
  SELECT m.rolname AS member,g.rolname AS granted
  FROM pg_auth_members am
  JOIN pg_roles m ON m.oid=am.member
  JOIN pg_roles g ON g.oid=am.roleid
  WHERE m.rolname IN ('authenticated','anonymous')
)
SELECT check_id,check_name,expected,actual,ok FROM (
  SELECT 'P01' AS check_id,'server version' AS check_name,
         'report; PG17+ has the table MAINTAIN privilege' AS expected,
         version() AS actual,NULL::boolean AS ok
  UNION ALL
  SELECT 'P02','connected role / database','report',
         current_user||' @ '||current_database(),NULL
  UNION ALL
  SELECT 'P03','not the personal Pool Center database','database is not nfl_pool',
         current_database(),current_database()<>'nfl_pool'
  UNION ALL
  SELECT 'P04','no personal Pool Center tables','none of public.nfl_pool_weeks, public.nfl_survivor_weeks',
         COALESCE((SELECT found FROM personal),'none'),(SELECT found FROM personal) IS NULL
  UNION ALL
  SELECT 'P05','fresh database: no pool_platform_* objects yet','0 relations, 0 functions',
         (SELECT rels||' relations, '||procs||' functions' FROM existing),
         (SELECT rels=0 AND procs=0 FROM existing)
  UNION ALL
  SELECT 'P06','role '||name||' exists (Data API)','present; not superuser; no BYPASSRLS',
         CASE WHEN present THEN 'present; login='||rolcanlogin||'; super='||rolsuper||'; bypassrls='||rolbypassrls ELSE 'MISSING' END,
         present AND NOT rolsuper AND NOT rolbypassrls
  FROM roles
  UNION ALL
  SELECT 'P07','auth.user_id() exists (pg_session_jwt)','function auth.user_id() returning text',
         COALESCE((SELECT 'returns '||rettype FROM authfn),'MISSING'),
         COALESCE((SELECT rettype='text' FROM authfn),false)
  UNION ALL
  SELECT 'P08','pg_session_jwt extension','report',
         COALESCE((SELECT extname||' '||extversion FROM pg_extension WHERE extname='pg_session_jwt'),'not installed'),NULL
  UNION ALL
  SELECT 'P09','neon_auth."user" table exists (Neon Auth)','present',
         CASE WHEN to_regclass('neon_auth."user"') IS NULL THEN 'MISSING' ELSE 'present' END,
         to_regclass('neon_auth."user"') IS NOT NULL
  UNION ALL
  SELECT 'P10','neon_auth."user".'||quote_ident(name),
         CASE name WHEN 'id' THEN 'present (compared as text)'
                   WHEN 'email' THEN 'text'
                   WHEN 'emailVerified' THEN 'boolean (NOT NULL per the reviewed comment)'
                   ELSE 'boolean' END,
         COALESCE(type||CASE WHEN attnotnull THEN ' NOT NULL' ELSE ' NULL' END,'MISSING'),
         COALESCE(CASE name WHEN 'id' THEN type IS NOT NULL
                            WHEN 'email' THEN type IN ('text','character varying')
                            ELSE type='boolean' END,false)
  FROM authcol
  UNION ALL
  SELECT 'P11','pgcrypto location','not installed yet (001 creates it) or installed in public',
         COALESCE((SELECT 'installed in '||n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'),'not installed'),
         COALESCE((SELECT n.nspname='public' FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'),true)
  UNION ALL
  SELECT 'P12','extension creation schema','public (001 runs CREATE EXTENSION pgcrypto unqualified)',
         COALESCE((current_schemas(false))[1],'(none)'),(current_schemas(false))[1]='public'
  UNION ALL
  SELECT 'P13','migration role can CREATE in public','true',
         has_schema_privilege(current_user,'public','CREATE')::text,has_schema_privilege(current_user,'public','CREATE')
  UNION ALL
  SELECT 'P14','default table privileges 002 would NOT revoke from authenticated',
         'none (002 revokes only INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER; PG17 MAINTAIN would survive)',
         COALESCE((SELECT string_agg(DISTINCT for_role||' in '||in_schema||': '||privilege_type,'; ')
                   FROM defacl WHERE objtype='r' AND grantee='authenticated'
                     AND privilege_type NOT IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')),'none'),
         NOT EXISTS (SELECT 1 FROM defacl WHERE objtype='r' AND grantee='authenticated'
                       AND privilege_type NOT IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'))
  UNION ALL
  SELECT 'P15','all default privileges in public / all schemas','report',
         COALESCE((SELECT string_agg(for_role||' in '||in_schema||' '||objtype||' -> '||grantee||':'||privilege_type,'; '
                                     ORDER BY for_role,in_schema,objtype,grantee,privilege_type) FROM defacl),'none'),NULL
  UNION ALL
  SELECT 'P16','authenticated/anonymous role memberships',
         'no pg_read_all_data, pg_write_all_data or pg_maintain',
         COALESCE((SELECT string_agg(member||' in '||granted,', ' ORDER BY member,granted) FROM members),'none'),
         NOT EXISTS (SELECT 1 FROM members WHERE granted IN ('pg_read_all_data','pg_write_all_data','pg_maintain'))
) checks
ORDER BY check_id,check_name;
