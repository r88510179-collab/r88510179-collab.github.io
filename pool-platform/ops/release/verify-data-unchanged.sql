-- Called inside a release transaction, after data-fingerprint.sql and after the changes. Any difference in the ten
-- tables that held application rows stops the transaction, which rolls back everything the script did.
DO $unchanged$
DECLARE
  v_before jsonb := (SELECT fingerprint FROM pool_release_before);
  v_after jsonb := pg_temp.pool_release_fingerprint();
BEGIN
  IF v_before IS NULL OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'commercial_release_changed_existing_rows: %',
      (SELECT string_agg(k||' '||COALESCE(v_before->>k,'none')||' -> '||COALESCE(v_after->>k,'none'),'; ' ORDER BY k)
       FROM jsonb_object_keys(v_after) AS k WHERE (v_before->>k) IS DISTINCT FROM (v_after->>k));
  END IF;
  RAISE NOTICE 'existing application rows unchanged: %',v_after;
END
$unchanged$;
