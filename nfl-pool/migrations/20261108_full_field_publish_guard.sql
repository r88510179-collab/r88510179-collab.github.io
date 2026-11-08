-- Prevent a genuine weekly full-pool PDF from being locked as a four-entry-only publication.
-- Existing legacy-seed weeks remain readable and unchanged. Apply only to the Personal nfl_pool database.
-- Safe to re-run. A database-level guard also protects old/cached Admin clients.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.nfl_pool_weeks'::regclass
      AND conname='nfl_pool_locked_weekly_full_field_check'
  ) THEN
    ALTER TABLE public.nfl_pool_weeks
      ADD CONSTRAINT nfl_pool_locked_weekly_full_field_check
      CHECK (
        CASE
          WHEN status='locked' AND config->'source'->>'kind'='weekly-upload' THEN
            CASE WHEN jsonb_typeof(config->'participants')='array'
                      AND jsonb_typeof(config->'fieldEntries')='array'
            THEN
                 coalesce(config->>'fullFieldReady','')='true'
             AND jsonb_array_length(config->'participants')=4
             AND jsonb_array_length(config->'fieldEntries')>0
             AND coalesce(config->>'fullFieldEntryCount','')=jsonb_array_length(config->'fieldEntries')::text
             AND coalesce(config->>'competitionSize','')=
               (jsonb_array_length(config->'participants')+jsonb_array_length(config->'fieldEntries'))::text
            ELSE false END
          ELSE true
        END
      );
  END IF;
END
$guard$;
