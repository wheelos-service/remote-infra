ALTER TABLE authz_onboarding_operations DROP CONSTRAINT IF EXISTS authz_onboarding_operations_status_check;
ALTER TABLE authz_onboarding_operations ADD CONSTRAINT authz_onboarding_operations_status_check
    CHECK (status IN ('pending','running','failed','awaiting_install','awaiting_registration','completed'));
ALTER TABLE authz_onboarding_operations DROP CONSTRAINT IF EXISTS authz_onboarding_operations_stage_check;
ALTER TABLE authz_onboarding_operations ADD CONSTRAINT authz_onboarding_operations_stage_check
    CHECK (stage IN ('planned','provider','binding','invitation','registration','installation','completed'));
DROP INDEX IF EXISTS authz_onboarding_email_reservation;
CREATE UNIQUE INDEX authz_onboarding_email_reservation
    ON authz_onboarding_operations(lower(email)) WHERE kind='person' AND email<>'';
CREATE UNIQUE INDEX IF NOT EXISTS authz_onboarding_username_reservation
    ON authz_onboarding_operations(lower(name)) WHERE kind='person' AND email='' AND error_code<>'REGISTRATION_EXPIRED';
