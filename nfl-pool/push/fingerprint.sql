-- Read-only fingerprint of everything Pool Alerts installs in the Personal Pool database (migrations 006 and 007): the
-- private pool_alerts schema's tables, sequences, columns, defaults, constraints, indexes and grants; its functions and
-- the capture function public.nfl_pool_alerts_capture() with their definitions and grants; the capture trigger; the
-- sender role's settings. The owner of an object is written as <owner>, so a disposable test database and production
-- give the same schema_sha256 for the same migrations. Whether the sender role may log in (the owner gives it a password
-- at deployment) is reported apart and is not part of schema_sha256. Every text ordering is COLLATE "C", so the value does
-- not depend on the database's collation (a Docker image's en_US.UTF-8 and Neon's C.UTF-8 give the same fingerprint), and
-- indexes are listed by definition, not by their physical order in pg_index. Run with psql -X -At; it changes nothing.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
WITH owner_names AS (
  SELECT DISTINCT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='pool_alerts'
),
acl AS (
  -- One line per privilege: grantee (the owner as <owner>, PUBLIC for 0), privilege, grantable. Grantor omitted.
  SELECT kind, id, string_agg(grantee||'='||privilege_type||CASE WHEN is_grantable THEN '*' ELSE '' END, ',' ORDER BY grantee COLLATE "C", privilege_type COLLATE "C") AS acl
  FROM (
    SELECT 'f' AS kind, p.oid AS id, CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN r.rolname IN (SELECT rolname FROM owner_names) OR a.grantee=p.proowner THEN '<owner>' ELSE r.rolname END AS grantee,
      a.privilege_type, a.is_grantable
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE n.nspname='pool_alerts' OR (n.nspname='public' AND p.proname='nfl_pool_alerts_capture')
    UNION ALL
    SELECT 'r', c.oid, CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN r.rolname IN (SELECT rolname FROM owner_names) OR a.grantee=c.relowner THEN '<owner>' ELSE r.rolname END,
      a.privilege_type, a.is_grantable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END::"char", c.relowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE n.nspname='pool_alerts' AND c.relkind IN ('r','S')
  ) x GROUP BY kind, id
),
functions AS (
  SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS id,
    pg_get_functiondef(p.oid)||'|'||coalesce((SELECT acl FROM acl WHERE kind='f' AND acl.id=p.oid),'') AS def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='pool_alerts' OR (n.nspname='public' AND p.proname='nfl_pool_alerts_capture')
),
relations AS (
  SELECT c.relname AS id, c.relkind::text||'|'||coalesce((SELECT acl FROM acl WHERE kind='r' AND acl.id=c.oid),'')||'|'||
    coalesce((SELECT string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||CASE WHEN a.attnotnull THEN ' not null' ELSE '' END||
      coalesce(' default '||pg_get_expr(d.adbin,d.adrelid),'')||CASE WHEN a.attidentity<>'' THEN ' identity '||a.attidentity::text ELSE '' END, ', ' ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'')||'|'||
    coalesce((SELECT string_agg(pg_get_constraintdef(k.oid), '; ' ORDER BY pg_get_constraintdef(k.oid) COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid),'')||'|'||
    coalesce((SELECT string_agg(ix.def, '; ' ORDER BY ix.def COLLATE "C") FROM (SELECT regexp_replace(pg_get_indexdef(i.indexrelid),'^CREATE (UNIQUE )?INDEX \S+ ','CREATE \1INDEX ') AS def
      FROM pg_index i WHERE i.indrelid=c.oid) ix),'') AS def
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='pool_alerts' AND c.relkind IN ('r','S')
),
triggers AS (
  SELECT t.tgname AS id, pg_get_triggerdef(t.oid)||'|'||t.tgenabled::text AS def FROM pg_trigger t
  WHERE t.tgname='nfl_pool_alerts_capture' AND NOT t.tgisinternal
),
sender AS (
  SELECT 'connlimit='||rolconnlimit||' super='||rolsuper||' createrole='||rolcreaterole||' createdb='||rolcreatedb||' inherit='||rolinherit||
    ' replication='||rolreplication||' bypassrls='||rolbypassrls||' config='||coalesce(array_to_string(ARRAY(SELECT s FROM unnest(rolconfig) AS s ORDER BY s COLLATE "C"),','),'') AS def,
    rolcanlogin AS can_login
  FROM pg_roles WHERE rolname='pool_alerts_sender'
),
parts AS (
  SELECT
    encode(sha256(convert_to(coalesce((SELECT string_agg(id||'='||def, E'\n' ORDER BY id COLLATE "C") FROM functions),''),'UTF8')),'hex') AS functions_sha256,
    encode(sha256(convert_to(coalesce((SELECT string_agg(id||'='||def, E'\n' ORDER BY id COLLATE "C") FROM relations),''),'UTF8')),'hex') AS relations_sha256,
    encode(sha256(convert_to(coalesce((SELECT string_agg(id||'='||def, E'\n' ORDER BY id COLLATE "C") FROM triggers),''),'UTF8')),'hex') AS triggers_sha256,
    encode(sha256(convert_to(coalesce((SELECT def FROM sender),''),'UTF8')),'hex') AS sender_role_sha256,
    (SELECT count(*) FROM functions) AS functions, (SELECT count(*) FROM relations) AS relations, (SELECT count(*) FROM triggers) AS triggers,
    (SELECT can_login FROM sender) AS sender_can_login
)
SELECT 'schema_sha256='||encode(sha256(convert_to(functions_sha256||relations_sha256||triggers_sha256||sender_role_sha256,'UTF8')),'hex'),
  'functions='||functions||' relations='||relations||' triggers='||triggers||' sender_can_login='||coalesce(sender_can_login::text,'no-role'),
  'functions_sha256='||functions_sha256, 'relations_sha256='||relations_sha256, 'triggers_sha256='||triggers_sha256,
  'sender_role_sha256='||sender_role_sha256
FROM parts;
COMMIT;
