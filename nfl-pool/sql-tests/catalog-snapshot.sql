-- Read-only. One document describing everything the Personal database holds in schema public: tables with their columns,
-- defaults, identity, constraints, indexes, triggers, row-level security and policies; functions with their language,
-- result, SECURITY DEFINER flag, volatility, settings, owner and a SHA-256 of their body; sequences; and every privilege
-- on a table, sequence or function by grantee. rebuild.sh compares it between a database rebuilt from the migrations and
-- the production shape the SQL gate emulates. It only reads the catalog, so it is also what can be run against the real
-- database, by someone allowed to, to compare with the value rebuild.sh prints. Nothing in it names a row.
SELECT jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,COALESCE(pg_get_expr(d.adbin,d.adrelid),''),a.attidentity,a.attgenerated) ORDER BY c.relname,a.attnum)
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relkind,pg_get_userbyid(c.relowner),c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname)
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND k.contype<>'n'),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(tablename,indexname,indexdef) ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='public'),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,t.tgenabled::text,pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname)
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public'),
 'policies',(SELECT jsonb_agg(jsonb_build_array(tablename,policyname,permissive,cmd,roles::text,COALESCE(qual,''),COALESCE(with_check,'')) ORDER BY tablename,policyname) FROM pg_policies WHERE schemaname='public'),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),l.lanname,p.prosecdef,p.provolatile::text,
     COALESCE(array_to_string(p.proconfig,'|'),''),pg_get_userbyid(p.proowner),encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public'),
 'privileges',(SELECT jsonb_agg(jsonb_build_array(kind,name,grantee,privilege,grantable) ORDER BY kind,name,grantee,privilege) FROM (
     SELECT CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind,c.relname::text AS name,COALESCE(r.rolname,'PUBLIC') AS grantee,x.privilege_type AS privilege,x.is_grantable AS grantable
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END::"char",c.relowner))) x
       LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE n.nspname='public' AND c.relkind IN ('r','p','S')
     UNION ALL
     SELECT 'function',p.oid::regprocedure::text,COALESCE(r.rolname,'PUBLIC'),x.privilege_type,x.is_grantable
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
       LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE n.nspname='public'
     UNION ALL
     SELECT 'column',c.relname||'.'||a.attname,COALESCE(r.rolname,'PUBLIC'),x.privilege_type,x.is_grantable
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL aclexplode(a.attacl) x LEFT JOIN pg_roles r ON r.oid=x.grantee
       WHERE n.nspname='public' AND a.attacl IS NOT NULL AND NOT a.attisdropped) g)
) AS snapshot;
