-- Read-only. What catalog-snapshot.sql does not describe: the things around schema public that differ between a hosted
-- database and a rebuilt one for reasons that are expected, so they can be listed and read by a person instead of being
-- mistaken for schema drift. The database and its owner, the server's major version and time zone, the schemas, the
-- extensions, the roles that are not PostgreSQL's own (name and attributes only: no password, no hash, no setting that could
-- hold a secret), who is a member of whom, and what each such role can actually do to the application's tables and sequences.
-- Nothing in it names a row of the application. compare-catalog.py --environment lists the differences between two of these.
-- Run it only where the person running it may read the catalog.
--
-- Why memberships and effective privileges are here. catalog-snapshot.sql lists the privileges that are GRANTed: the entries
-- of each object's access list. A role can hold much more than that without any entry of its own: by being a member of a
-- role that holds the privilege and inherits it, by being a member of a predefined role (pg_read_all_data reads every table
-- and sequence, pg_write_all_data writes them), by owning the object, by being a superuser; and whether row-level security
-- applies to it at all depends on BYPASSRLS, which is an attribute of the role and is NOT inherited through membership.
-- So three things are kept apart in 'effective_privileges':
--   explicit   the role has an entry of its own in the object's access list (what catalog-snapshot.sql shows)
--   effective  the server would let it (has_table_privilege / has_sequence_privilege: inheritance, predefined roles, ownership,
--              superuser and PUBLIC grants all counted)
--   via        how, when it is not explicit: superuser, owner, pg_read_all_data, pg_write_all_data, inherited from <roles>, public
-- and rls_exempt says that row-level security is on for the table and does not apply to this role (superuser, BYPASSRLS, or an
-- owner of a table without FORCE ROW LEVEL SECURITY), so that its read sees every row whatever the policies say.
-- Only rows where explicit or effective is true are listed. A 'memberships' row names the predefined roles too (a member of
-- pg_read_all_data is the case that matters); 'inherits' is the answer the server uses: the membership's INHERIT option from
-- PostgreSQL 16 on, the member's INHERIT attribute before.
WITH roles AS (
  SELECT r.* FROM pg_roles r WHERE r.rolname !~ '^pg_'
), relations AS (
  SELECT c.oid, c.relname::text AS name, CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind, c.relowner AS owner,
         c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
         COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END::"char",c.relowner)) AS acl
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p','S')
), privileges AS (
  SELECT 'table' AS kind, p AS privilege
    FROM unnest(CASE WHEN current_setting('server_version_num')::int>=170000
                     THEN ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']
                     ELSE ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] END) p
  UNION ALL SELECT 'sequence', p FROM unnest(ARRAY['USAGE','SELECT','UPDATE']) p
), reach AS (
  SELECT r.rolname AS role, k.kind, k.name AS object, p.privilege,
    EXISTS (SELECT 1 FROM aclexplode(k.acl) a WHERE a.grantee=r.oid AND a.privilege_type=p.privilege) AS explicit,
    CASE k.kind WHEN 'table' THEN has_table_privilege(r.oid,k.oid,p.privilege) ELSE has_sequence_privilege(r.oid,k.oid,p.privilege) END AS effective,
    CASE
      WHEN EXISTS (SELECT 1 FROM aclexplode(k.acl) a WHERE a.grantee=r.oid AND a.privilege_type=p.privilege) THEN 'direct'
      WHEN r.rolsuper THEN 'superuser'
      WHEN pg_has_role(r.oid,k.owner,'USAGE') THEN 'owner'
      WHEN k.kind='table' AND p.privilege='SELECT' AND pg_has_role(r.oid,'pg_read_all_data','USAGE') THEN 'pg_read_all_data'
      WHEN k.kind='table' AND p.privilege IN ('INSERT','UPDATE','DELETE') AND pg_has_role(r.oid,'pg_write_all_data','USAGE') THEN 'pg_write_all_data'
      WHEN k.kind='sequence' AND p.privilege IN ('USAGE','SELECT') AND pg_has_role(r.oid,'pg_read_all_data','USAGE') THEN 'pg_read_all_data'
      WHEN k.kind='sequence' AND p.privilege IN ('USAGE','UPDATE') AND pg_has_role(r.oid,'pg_write_all_data','USAGE') THEN 'pg_write_all_data'
      ELSE COALESCE((SELECT 'inherited from '||string_agg(g.rolname,',' ORDER BY g.rolname)
                       FROM aclexplode(k.acl) a JOIN pg_roles g ON g.oid=a.grantee
                      WHERE a.privilege_type=p.privilege AND g.oid<>r.oid AND pg_has_role(r.oid,g.oid,'USAGE')),
                    CASE WHEN EXISTS (SELECT 1 FROM aclexplode(k.acl) a WHERE a.grantee=0 AND a.privilege_type=p.privilege) THEN 'public' END,
                    'unexplained')
    END AS via,
    k.rls AND (r.rolsuper OR r.rolbypassrls OR (pg_has_role(r.oid,k.owner,'USAGE') AND NOT k.force_rls)) AS rls_exempt
  FROM roles r CROSS JOIN relations k JOIN privileges p ON p.kind=k.kind
)
SELECT jsonb_build_object(
 'database',(SELECT jsonb_agg(jsonb_build_array(d.datname,pg_get_userbyid(d.datdba),pg_encoding_to_char(d.encoding)))
   FROM pg_database d WHERE d.datname=current_database()),
 'settings',jsonb_build_array(jsonb_build_array('server_major',(current_setting('server_version_num')::int/10000)::text),
   jsonb_build_array('timezone',current_setting('TimeZone'))),
 'schemas',(SELECT jsonb_agg(jsonb_build_array(n.nspname,pg_get_userbyid(n.nspowner)) ORDER BY n.nspname)
   FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'),
 'extensions',(SELECT jsonb_agg(jsonb_build_array(e.extname,e.extversion,n.nspname) ORDER BY e.extname)
   FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace),
 'roles',(SELECT jsonb_agg(jsonb_build_array(r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreaterole,r.rolbypassrls,r.rolcreatedb,
     r.rolinherit,r.rolreplication,r.rolconnlimit) ORDER BY r.rolname) FROM roles r),
 'memberships',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(m.member),pg_get_userbyid(m.roleid),m.admin_option,
     (to_jsonb(m)->>'inherit_option')::boolean,(to_jsonb(m)->>'set_option')::boolean,
     COALESCE((to_jsonb(m)->>'inherit_option')::boolean,mr.rolinherit))
     ORDER BY pg_get_userbyid(m.member),pg_get_userbyid(m.roleid),pg_get_userbyid(m.grantor))
   FROM pg_auth_members m JOIN pg_roles mr ON mr.oid=m.member WHERE mr.rolname !~ '^pg_'),
 'effective_privileges',(SELECT jsonb_agg(jsonb_build_array(role,kind,object,privilege,explicit,effective,via,rls_exempt)
     ORDER BY role,kind,object,privilege) FROM reach WHERE explicit OR effective)
) AS environment;
