ALTER TABLE authz_onboarding_operations ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS authz_lifecycle_operations (
    operation_id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES authz_organizations(org_id),
    actor_user_id UUID NOT NULL REFERENCES authz_users(user_id),
    idempotency_key UUID NOT NULL,
    fingerprint TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    authorization_version BIGINT NOT NULL,
    provider_status TEXT NOT NULL CHECK (provider_status IN ('not_required','pending','failed','manual_required','confirmed')),
    provider_name TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL DEFAULT '',
    binding_version BIGINT NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NOT NULL DEFAULT '',
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS authz_lifecycle_pending ON authz_lifecycle_operations(next_attempt_at) WHERE provider_status='pending';
CREATE INDEX IF NOT EXISTS authz_lifecycle_org ON authz_lifecycle_operations(org_id,created_at DESC,operation_id DESC);
CREATE INDEX IF NOT EXISTS authz_audit_org ON authz_audit_events(org_id,created_at DESC,event_id DESC);
