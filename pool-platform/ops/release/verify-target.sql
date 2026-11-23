-- Called inside the release transaction. Both identifiers come from the selected Neon branch.
SELECT set_config('pool_release.project', :'expected_project', true),
       set_config('pool_release.branch', :'expected_branch', true);
DO $target$
BEGIN
  IF current_database() <> 'neondb'
     OR current_setting('neon.project_id', true) IS DISTINCT FROM current_setting('pool_release.project')
     OR current_setting('neon.branch_id', true) IS DISTINCT FROM current_setting('pool_release.branch')
     OR current_setting('pool_release.project') = '' OR current_setting('pool_release.branch') = '' THEN
    RAISE EXCEPTION 'commercial_release_target_mismatch';
  END IF;
END
$target$;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';
