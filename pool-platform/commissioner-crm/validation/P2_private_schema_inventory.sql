-- P2 (READ ONLY): inventory of the schema pool_platform_private, which the production Data API lists among the
-- schemas it could expose (it exposes public only) and which no migration on any branch of this repository
-- creates. Catalog only: no row of any table is read and no function is executed; function bodies are reported
-- as SHA-256 fingerprints, never as text. Run as the migration owner inside BEGIN READ ONLY; ... ROLLBACK;.
-- Every row is informational: the owner decides, from this inventory and the window record, what the schema is.
WITH
ns AS (
  SELECT n.oid,n.nspname::text AS nspname,pg_get_userbyid(n.nspowner)::text AS owner,n.nspacl,
         obj_description(n.oid,'pg_namespace') AS comment
  FROM pg_namespace n WHERE n.nspname='pool_platform_private'
),
rel AS (
  SELECT c.oid,c.relname::text AS relname,c.relkind::text AS relkind,pg_get_userbyid(c.relowner)::text AS owner,
         c.relrowsecurity,c.relacl,(SELECT s.n_live_tup FROM pg_stat_all_tables s WHERE s.relid=c.oid) AS live_rows
  FROM pg_class c JOIN ns ON ns.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','S','f')
),
fn AS (
  SELECT p.oid,p.proname||'('||oidvectortypes(p.proargtypes)||')' AS sig,p.prosecdef,
         pg_get_userbyid(p.proowner)::text AS owner,array_to_string(p.proconfig,',') AS config,p.proacl,
         (SELECT l.lanname::text FROM pg_language l WHERE l.oid=p.prolang) AS lang,
         encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
  FROM pg_proc p JOIN ns ON ns.oid=p.pronamespace
),
ext AS (
  SELECT d.objid,x.extname::text AS extname
  FROM pg_depend d JOIN pg_extension x ON x.oid=d.refobjid
  WHERE d.refclassid='pg_extension'::regclass AND d.deptype='e'
),
-- OIDs are assigned in creation order (absent wraparound), so the schema's OID against the newest reviewed
-- commercial function hints whether it was created after migration 003.
marker AS (
  SELECT (SELECT max(p.oid)::bigint FROM pg_proc p
          WHERE p.pronamespace=to_regnamespace('public') AND p.proname LIKE 'pool\_platform\_%') AS newest_commercial_fn,
         (SELECT oid::bigint FROM ns) AS schema_oid
)
SELECT 'schema' AS kind,nspname AS name,owner,
       'acl='||COALESCE(nspacl::text,'default')||'; comment='||COALESCE(comment,'(none)')
         ||'; usage: anonymous='||has_schema_privilege('anonymous',oid,'USAGE')||' authenticated='||has_schema_privilege('authenticated',oid,'USAGE')
         ||'; create: anonymous='||has_schema_privilege('anonymous',oid,'CREATE')||' authenticated='||has_schema_privilege('authenticated',oid,'CREATE') AS detail,
       oid::bigint AS oid
FROM ns
UNION ALL
SELECT 'relation',relname,owner,
       'kind='||relkind||' rls='||relrowsecurity||' acl='||COALESCE(relacl::text,'default')||' live_rows~'||COALESCE(live_rows::text,'n/a')
         ||COALESCE(' extension='||e.extname,''),
       rel.oid::bigint
FROM rel LEFT JOIN ext e ON e.objid=rel.oid
UNION ALL
SELECT 'function',sig,owner,
       'lang='||COALESCE(lang,'')||' secdef='||prosecdef||' config='||COALESCE(config,'')||' acl='||COALESCE(proacl::text,'default')
         ||' body_sha256='||body_sha256||COALESCE(' extension='||e.extname,''),
       fn.oid::bigint
FROM fn LEFT JOIN ext e ON e.objid=fn.oid
UNION ALL
SELECT 'provenance hint','oid order','',
       CASE WHEN schema_oid IS NULL THEN 'schema absent'
            WHEN schema_oid>newest_commercial_fn THEN 'the schema OID is newer than every reviewed pool_platform_* function: created after migration 003'
            ELSE 'the schema OID predates the newest reviewed function' END
         ||' (schema_oid='||COALESCE(schema_oid::text,'none')||', newest_commercial_fn_oid='||COALESCE(newest_commercial_fn::text,'none')||')',
       NULL::bigint
FROM marker
ORDER BY kind,name;
