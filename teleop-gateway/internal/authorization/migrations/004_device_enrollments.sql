CREATE TABLE IF NOT EXISTS authz_device_enrollments (
    enrollment_id UUID PRIMARY KEY,
    public_key BYTEA NOT NULL CHECK (octet_length(public_key)=32),
    device_code_hash BYTEA NOT NULL CHECK (octet_length(device_code_hash)=32),
    device_code_ciphertext BYTEA NOT NULL,
    user_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    serial TEXT NOT NULL,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','active')),
    org_id UUID REFERENCES authz_organizations(org_id),
    actor_user_id UUID REFERENCES authz_users(user_id),
    operation_id UUID REFERENCES authz_onboarding_operations(operation_id),
    recovery BOOLEAN NOT NULL DEFAULT false,
    ticket_hash BYTEA,
    ticket_ciphertext BYTEA,
    ticket_expires_at TIMESTAMPTZ,
    next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS authz_device_enrollments_pending_key
    ON authz_device_enrollments(public_key) WHERE status IN ('pending','approved');
ALTER TABLE authz_installation_tickets ADD COLUMN IF NOT EXISTS device_enrollment_id UUID
    REFERENCES authz_device_enrollments(enrollment_id);
CREATE TABLE IF NOT EXISTS authz_enrolled_device_keys (
    public_key BYTEA PRIMARY KEY CHECK (octet_length(public_key)=32),
    operation_id UUID NOT NULL UNIQUE REFERENCES authz_onboarding_operations(operation_id)
);
CREATE TABLE IF NOT EXISTS authz_device_enrollment_nonces (
    public_key BYTEA NOT NULL,
    nonce UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(public_key,nonce)
);
CREATE INDEX IF NOT EXISTS authz_device_enrollment_nonce_expiry
    ON authz_device_enrollment_nonces(created_at);
CREATE TABLE IF NOT EXISTS authz_device_enrollment_events (
    event_id UUID PRIMARY KEY,
    enrollment_id UUID NOT NULL REFERENCES authz_device_enrollments(enrollment_id),
    actor_user_id UUID REFERENCES authz_users(user_id),
    event_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
