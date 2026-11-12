ALTER TABLE authz_organizations ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE authz_users ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE authz_users ADD COLUMN IF NOT EXISTS platform_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE authz_vehicles ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE authz_vehicle_identities ADD COLUMN IF NOT EXISTS provisioning_mode TEXT NOT NULL DEFAULT 'external'
    CHECK (
        (provisioning_mode = 'manual' AND client_id IS NULL AND secret_reference IS NULL)
        OR (provisioning_mode = 'external' AND client_id IS NOT NULL AND secret_reference IS NOT NULL)
    );
ALTER TABLE authz_vehicle_identities ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE authz_vehicle_identities ALTER COLUMN secret_reference DROP NOT NULL;

CREATE TABLE IF NOT EXISTS authz_token_horizons (
    org_id UUID PRIMARY KEY REFERENCES authz_organizations(org_id),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS authz_runtime_drain (
    state_key SMALLINT PRIMARY KEY CHECK (state_key = 1),
    quiet_until TIMESTAMPTZ NOT NULL
);
