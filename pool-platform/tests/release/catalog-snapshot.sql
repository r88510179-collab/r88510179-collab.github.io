-- Read-only. One document describing the application schema: columns, constraints, indexes, triggers, policies,
-- row-level security, function bodies (as SHA-256) and what the browser roles may do. The rehearsal compares it
-- before a release and after its rollback, and with the value recorded from the live Commercial catalog.
SELECT jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,COALESCE(pg_get_expr(d.adbin,d.adrelid),''),a.attidentity) ORDER BY n.nspname,c.relname,a.attnum)
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE n.nspname IN ('public','pool_platform_private') AND c.relkind='r' AND c.relname LIKE ANY(ARRAY['pool_platform_%','auth_issuer']) AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid)) ORDER BY n.nspname,c.relname,k.conname)
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','pool_platform_private') AND c.relname LIKE ANY(ARRAY['pool_platform_%','auth_issuer']) AND k.contype<>'n'),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(schemaname,tablename,indexname,indexdef) ORDER BY schemaname,tablename,indexname)
   FROM pg_indexes WHERE schemaname IN ('public','pool_platform_private') AND tablename LIKE ANY(ARRAY['pool_platform_%','auth_issuer'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid)) ORDER BY n.nspname,c.relname,t.tgname)
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname IN ('public','pool_platform_private')),
 'policies',(SELECT jsonb_agg(jsonb_build_array(schemaname,tablename,policyname,cmd,roles::text,qual,COALESCE(with_check,'')) ORDER BY schemaname,tablename,policyname)
   FROM pg_policies WHERE schemaname IN ('public','pool_platform_private')),
 'rls',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','pool_platform_private') AND c.relname LIKE ANY(ARRAY['pool_platform_%','auth_issuer'])),
 'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),l.lanname,p.prosecdef,p.provolatile,COALESCE(array_to_string(p.proconfig,'|'),''),encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
   WHERE n.nspname IN ('public','pool_platform_private') AND p.proname LIKE 'pool_platform_%'),
 'function_acl',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),
     has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('anonymous',p.oid,'EXECUTE'),
     EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee=0)) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','pool_platform_private') AND p.proname LIKE 'pool_platform_%'),
 'table_acl',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,
     (SELECT COALESCE(string_agg(pr,',' ORDER BY pr),'') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pr WHERE has_table_privilege('authenticated',c.oid,pr)),
     (SELECT COALESCE(string_agg(pr,',' ORDER BY pr),'') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pr WHERE has_table_privilege('anonymous',c.oid,pr)),
     EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE x.grantee=0)) ORDER BY n.nspname,c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','S') AND n.nspname IN ('public','pool_platform_private') AND c.relname LIKE ANY(ARRAY['pool_platform_%','auth_issuer']))
) AS snapshot
