\set ON_ERROR_STOP on
-- One transaction. Any error, including a failed check, rolls back every statement and leaves the database as it was.
BEGIN;
\ir verify-target.sql
\ir verify-baseline-schema.sql
\ir data-fingerprint.sql
\ir ../../migrations/20261103_commissioner_pool_discovery.sql
\ir ../../migrations/20261103_commissioner_entry_create.sql
\ir ../../migrations/20261103_commissioner_draft_week.sql
\ir ../../migrations/20261103_commissioner_draft_schedule.sql
\ir ../../migrations/20261103_participant_pool_discovery.sql
\ir ../../migrations/20261104_phase9_pool_season_onboarding.sql
\ir ../../migrations/20261104_phase9_sso_safe_email_invites.sql
\ir ../../migrations/20261104_phase9_verified_schedule_and_open.sql
\ir ../../migrations/20261106_pool_week_projection_snapshot.sql
\ir ../../migrations/20261111_week_final_attestations.sql
\ir ../../migrations/20261111_attestation_evidence.sql
\ir ../../migrations/20261112_final_attestation_hardening.sql
\ir ../../migrations/20261112_season_standings_snapshot.sql
\ir verify-postconditions.sql
\ir verify-data-unchanged.sql
COMMIT;
