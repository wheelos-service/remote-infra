ALTER TABLE authz_users ADD COLUMN IF NOT EXISTS first_authenticated_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS authz_device_rotations (
    operation_id UUID PRIMARY KEY REFERENCES authz_lifecycle_operations(operation_id),
    provider_name TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL UNIQUE,
    credential_ciphertext BYTEA,
    status TEXT NOT NULL CHECK (status IN ('pending','awaiting_install','failed','completed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NOT NULL DEFAULT '',
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS authz_rotation_tickets (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash)=32),
    operation_id UUID NOT NULL REFERENCES authz_device_rotations(operation_id),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
