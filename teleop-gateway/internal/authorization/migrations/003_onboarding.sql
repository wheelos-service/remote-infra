CREATE TABLE IF NOT EXISTS authz_onboarding_operations (
    operation_id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES authz_organizations(org_id),
    actor_user_id UUID NOT NULL REFERENCES authz_users(user_id),
    idempotency_key UUID NOT NULL,
    request JSONB NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('person','vehicle')),
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    vehicle_id TEXT NOT NULL DEFAULT '',
    planned_identity_id UUID NOT NULL UNIQUE,
    provider_name TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL DEFAULT '',
    credential_ciphertext BYTEA,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','failed','awaiting_install','completed')),
    stage TEXT NOT NULL DEFAULT 'planned' CHECK (stage IN ('planned','provider','binding','invitation','installation','completed')),
    error_code TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id UUID REFERENCES authz_users(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS authz_onboarding_vehicle_reservation
    ON authz_onboarding_operations(vehicle_id) WHERE kind='vehicle';
CREATE UNIQUE INDEX IF NOT EXISTS authz_onboarding_vehicle_number_reservation
    ON authz_onboarding_operations(org_id, (request->>'vehicle_number'))
    WHERE kind='vehicle' AND COALESCE(request->>'vehicle_number','') <> '';
CREATE UNIQUE INDEX IF NOT EXISTS authz_onboarding_email_reservation
    ON authz_onboarding_operations(lower(email)) WHERE kind='person';
CREATE TABLE IF NOT EXISTS authz_onboarding_events (
    event_id UUID PRIMARY KEY,
    operation_id UUID NOT NULL REFERENCES authz_onboarding_operations(operation_id),
    event_type TEXT NOT NULL,
    error_code TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS authz_installation_tickets (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash)=32),
    operation_id UUID NOT NULL REFERENCES authz_onboarding_operations(operation_id),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
