-- Read-only. What catalog-snapshot.sql does not describe: the things around schema public that differ between a hosted
-- database and a rebuilt one for reasons that are expected, so they can be listed and read by a person instead of being
-- mistaken for schema drift. The database and its owner, the server's major version and time zone, the schemas, the
-- extensions, the roles that are not PostgreSQL's own (name and attributes only: no password, no hash, no setting that could
-- hold a secret) and who is a member of whom. Nothing in it names a row of the application. compare-catalog.py --environment
-- lists the differences between two of these. Run it only where the person running it may read the catalog.
SELECT jsonb_build_object(
 'database',(SELECT jsonb_agg(jsonb_build_array(d.datname,pg_get_userbyid(d.datdba),pg_encoding_to_char(d.encoding)))
   FROM pg_database d WHERE d.datname=current_database()),
 'settings',jsonb_build_array(jsonb_build_array('server_major',(current_setting('server_version_num')::int/10000)::text),
   jsonb_build_array('timezone',current_setting('TimeZone'))),
 'schemas',(SELECT jsonb_agg(jsonb_build_array(n.nspname,pg_get_userbyid(n.nspowner)) ORDER BY n.nspname)
   FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'),
 'extensions',(SELECT jsonb_agg(jsonb_build_array(e.extname,e.extversion,n.nspname) ORDER BY e.extname)
   FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace),
 'roles',(SELECT jsonb_agg(jsonb_build_array(r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreaterole,r.rolbypassrls,r.rolcreatedb) ORDER BY r.rolname)
   FROM pg_roles r WHERE r.rolname !~ '^pg_'),
 'memberships',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(m.member),pg_get_userbyid(m.roleid)) ORDER BY 1,2)
   FROM pg_auth_members m WHERE pg_get_userbyid(m.roleid) !~ '^pg_' AND pg_get_userbyid(m.member) !~ '^pg_')
) AS environment;
