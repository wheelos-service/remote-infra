# Authentication and authorization

This document describes current behavior and configuration. The proposed
multi-tenant identity, organization, provisioning, and authorization design is
in [authentication-plan.md](authentication-plan.md), including the explicit
boundary: Casdoor owns authentication; the Gateway owns business authorization
with an embedded Casbin policy engine and PostgreSQL persistence. The default
runtime remains static; the opt-in manual-provisioning management pilot is
described in [auth-management.md](auth-management.md). After one-time platform setup, the full target is
is for administrators to invite people, register vehicles and assign roles and
vehicle ranges, without manually editing identity mappings or policy files.

## Principles

Use one OIDC identity provider and the Gateway's OIDC/JWKS verifier for both
operators and vehicles, but keep their credentials and OAuth grants separate:

- Operators are public browser clients and use Authorization Code + PKCE.
- Vehicles are confidential machine clients and use client credentials, with a
  unique client credential per vehicle.
- The Gateway authenticates both token types, then applies the appropriate
  operator ACL or device-to-vehicle identity mapping.
- A LiveKit room token is short-lived transport authority, not a user/device
  credential and not control permission.
- Monitoring permission never implies control permission. Control additionally
  requires the Gateway control session/lease and vehicle-side command checks.

The current React client and C++ vehicle SDK are primary. The standalone
operator console and Python vehicle agent are legacy references.

## Embedded authorization and managed pilot

`apps/teleop-gateway/internal/authorization` contains the first implementation
of the target Go Casbin/PostgreSQL foundation. Existing static policy
configuration remains authoritative unless managed mode is explicitly selected.
The [optional deployment overlay](deployment.md#optional-managed-authorization-pilot)
adds PostgreSQL; the default deployment does not silently switch sources.
Managed mode requires verified identity bindings and protected bootstrap, not
JWT role strings or an anonymous first-user registration.

The package provides `NewStore(*sql.DB)`, explicit `Migrate`, `AssignRole`,
vehicle-scoped `Enforce`, and `Version`. It uses fixed role templates and one
role assignment per user/organization. Casbin `g` binds a namespaced user to
an assignment grant in an organization; `p` binds that grant to its fixed role,
actions and all/selected vehicle range. This intentionally differs from a flat
user-to-role wildcard policy: the role and range stay attached to the same
assignment, and cannot independently bypass each other.
The complete target action vocabulary remains in
[authorization-contract.md](authorization-contract.md). A pilot role must not
implicitly authorize task dispatch, general maintenance or physical driving.

Policy writes go through the store transaction, which updates policy, version,
audit and outbox together. The adapter rejects standalone Casbin mutation APIs.
Enforcement checks active user/membership/organization/vehicle state and reads
the database policy version in a consistent transaction; a stale snapshot is
reloaded, never used as a fallback after a load error. The managed runtime must
also serialize permission changes against live token/control issuance; this is
separate from Casbin enforcement.

The schema includes internal identity bindings and lifecycle records, not a
second account directory or duplicate role/vehicle ACL tables. The pilot adds
controlled registration, identity resolution, administrator bootstrap and role
assignment; it does not automate invitations, outbox-based online revocation
or vehicle credential provisioning. The HTTP PEP resolves trusted internal IDs.
Do not expose raw Casbin calls or policy/database writes to administrators.

Run foundation tests from `apps/teleop-gateway`:

```bash
go test ./internal/authorization
```

The real PostgreSQL integration test additionally requires
`AUTHZ_POSTGRES_TEST_DSN`, supplied through a protected test environment. It
creates and drops an isolated schema and requires schema-creation permissions;
use only a disposable test database, never production:

```bash
go test ./internal/authorization -run TestPostgresAuthorizationLifecycleAndTransactionalStore -count=1
```

Without that variable the PostgreSQL test is explicitly skipped, not reported
as a validated database deployment. Live Casdoor automation contracts, online
session revocation and migration remain production rollout gates; see
[authorization-contract.md](authorization-contract.md).

## Request flows

### Operator: monitor and control

1. The browser redirects to the OIDC provider using Authorization Code + PKCE.
   The OIDC client ID and endpoint URLs are public configuration; no client
   secret is delivered to the browser.
2. The browser validates the returned access token through Gateway
   `GET /api/auth/me`. The Gateway validates JWT signature, issuer, audience,
   expiry, subject, and scopes using its configured JWKS.
3. For monitoring, the browser requests vehicle state and `/data` APIs with the
   access token. Static mode requires the operator's observe role/scope and an
   observe ACL for that vehicle. Managed mode instead resolves its trusted
   database identity, organization, role and vehicle range.
4. For control, the operator must also have control permission for that
   vehicle. Managed pilot control is limited to allowlisted simulation, not
   physical driving. The Gateway creates a short-lived control session/lease and binds
   it to the operator, vehicle, and signing key. Vehicle-side session,
   signature, expiry, replay, and command checks remain required.

### Vehicle: monitoring data and optional media

1. Each vehicle has a distinct OAuth client credential. The vehicle uses
   `grant_type=client_credentials` to obtain a short-lived token with the
   `teleop:vehicle` permission.
2. The Gateway validates that token and maps its OIDC `sub` to exactly one
   registered `vehicle_id`.
3. The vehicle uses the same device identity for authenticated telemetry,
   Monitor/Data uploads, media demand, and requesting a short-lived token for
   its own LiveKit room.
4. The vehicle never receives the LiveKit API secret. Operator ACLs do not
   grant device identity, and device identity does not grant operator access.

## Configuration

### Request correlation and diagnostic errors

Every HTTP request served by the Gateway receives a server-generated
`X-Request-ID`. Incoming values are not trusted or reused. Authentication
failures, device-auth-check failures and vehicle media-token failures also
return a stable `X-Error-Code` and `Cache-Control: no-store`. These boundaries
return a JSON error when explicitly requested with `Accept: application/json`:

```json
{
  "error": "vehicle identity does not match registered vehicle",
  "code": "VEHICLE_IDENTITY_MISMATCH",
  "request_id": "<server-generated UUID>"
}
```

Without that Accept header, error bodies remain plain text. The successful
`/api/auth/me` payload and device-auth-check `204` response remain unchanged.
Allowed browser origins can read the diagnostic headers through CORS.
Gateway rejection logs and business audit events carry the request ID, without
logging bearer tokens or raw identity-provider errors.

| Code | Meaning / next check |
| --- | --- |
| `AUTH_BEARER_REQUIRED` | Missing or malformed Bearer authorization header |
| `AUTH_INVALID_TOKEN` | Gateway rejected the token; check trusted issuer/audience, expiry and verifier dependencies in platform diagnostics |
| `AUTH_SERVICE_UNAVAILABLE` | Gateway authenticator is unavailable |
| `VEHICLE_IDENTITY_MISMATCH` | Authenticated subject cannot act as the requested vehicle; check the registered mapping, not another vehicle's credentials |
| `VEHICLE_NOT_REGISTERED` | The subject matches this vehicle, but it is absent from the registry |
| `VEHICLE_REGISTRY_UNAVAILABLE` | Gateway registry dependency is unavailable |
| `VEHICLE_IDENTITY_REQUIRED` | Token does not satisfy the existing vehicle role/scope contract |
| `VEHICLE_IDENTITY_UNBOUND` | Strict subject mapping has no binding for the vehicle media-token request |
| `VEHICLE_IDENTITY_SERVICE_UNAVAILABLE` | Vehicle identity resolver is unavailable |
| `MEDIA_TOKEN_ISSUANCE_FAILED` | Gateway could not issue a media token; this does not diagnose RTC connectivity |

These are diagnostic boundaries, not a global conversion of every API error.
`AUTH_INVALID_TOKEN` intentionally does not expose whether credentials, claims,
or a JWKS fetch caused rejection. Authorized platform operators can correlate
`gateway_authentication_rejected` logs by request ID: sanitized reasons
distinguish token format, signing-key/JWKS failures, signature/claim decoding,
issuer, audience, time validity, missing subject, missing scope and explicit
non-access token type (`OIDC_TOKEN_TYPE_INVALID`). Raw tokens,
claims, provider bodies and URLs are not logged. These reasons describe the
observed failure, not a speculative root cause. Asynchronous onboarding `operation_id`, policy
version diagnostics and an administrator status page remain target capabilities.

### Identity provider

Configure the Gateway with `AUTH_MODE=oidc`, `OIDC_ISSUER`,
`OIDC_AUDIENCE`, and `OIDC_JWKS_URL`. The provider must issue signed, short-lived
JWTs with the expected issuer/audience, a stable subject, and the required
operator or vehicle permissions.
When the provider signs a `tokenType` claim, only `access-token` is accepted;
Casdoor ID and refresh JWTs cannot substitute for API access tokens, even if
their issuer, audience and scopes also match. Providers without this claim
retain the existing issuer/audience/scope contract. The browser must send the
OAuth response's `access_token`, never its `id_token`.

Register two client types at the provider:

- A public operator client for Authorization Code + PKCE with exact production
  redirect URIs and the observe scope. In static mode, control-capable operator
  tokens must also carry the controller/operator role or `teleop:control`
  permission. Managed business control requires the database assignment;
  IdP role strings alone do not grant it.
- A confidential vehicle client per vehicle, using client credentials and
  only the device scope. Rotate/revoke one vehicle without affecting others.

### Gateway authorization policy

The following file/JSON configuration is for **static mode**. Managed mode uses
the database as its only business authorization source and must reject these
settings instead of merging them. See [the managed pilot](auth-management.md)
for registration and assignment; token roles are not its business roles.

Prefer one non-secret JSON policy file over manually synchronizing the vehicle
registry, device subject map, and operator ACL environment variables. Mount the
file read-only into the Gateway container and set:

```dotenv
AUTHORIZATION_POLICY_DIR=/path/on/host/teleop-auth
AUTHORIZATION_POLICY_FILE=/etc/teleop-auth/authorization-policy.json
```

The policy contains vehicle IDs, display names, OIDC subjects, and operator
grants, but **never client secrets, access tokens, or LiveKit secrets**:

```json
{
  "vehicles": [
    {
      "vehicle_id": "car-001",
      "name": "Vehicle 001",
      "subject": "vehicle-subject-from-the-identity-provider"
    }
  ],
  "operators": [
    {
      "user_id": "operator-subject-from-the-identity-provider",
      "tenant_id": "fleet-a",
      "vehicle_id": "car-001",
      "permissions": ["observe"]
    }
  ]
}
```

Each device subject and vehicle ID must be unique. Operator grants can include
`observe` or `control`; a control grant also permits observation. ACL entries
must reference a vehicle in the same file. An empty policy denies all vehicle
and operator access. The old `VEHICLE_REGISTRY_JSON`,
`VEHICLE_SUBJECT_MAP_JSON`, and `VEHICLE_ACL_JSON` variables remain available
for migration, but must be unset/empty when `AUTHORIZATION_POLICY_FILE` is
configured. The Gateway fails startup rather than silently selecting between
two conflicting policy sources.

`AUTHORIZATION_POLICY_DIR` is a host-side Compose bind-mount source. Keep the
policy readable only by the deployment administrators and Gateway; it contains
identity and access-control data even though it contains no credentials.
For a new local policy file, start from
`infra/local-dev/authorization-policy/authorization-policy.example.json`, copy
it to `authorization-policy.json` in the mounted directory, then add only
registered OIDC subjects and operator grants.

### Vehicle configuration and secrets

The C++ device configuration still contains `vehicle_id`, `gateway_url`,
`token_url`, `client_id`, and `client_secret`, along with runtime settings.
Provision it as a root-owned regular file with mode `0600`; pass only the file
path to vehicle commands. Do not put credentials in the browser, command-line
arguments, environment variables, container images, or logs. Keep HTTPS
certificate validation enabled.

## Diagnostics and failure isolation

Build and run the device-side check on the vehicle host:

```bash
bazel build //:vehicle_auth_check
bazel-bin/vehicle_auth_check /etc/teleop/device.json
```

It checks protected configuration, OAuth/Gateway authentication, exact
device-to-registered-vehicle mapping, and LiveKit token issuance. It does not
connect to a LiveKit room or test camera, Cyber topics, operator ACLs, or
control-session behavior. It discards the returned LiveKit token and never
prints credentials or tokens.

Interpret failures by stage: configuration errors are local file/JSON/endpoint
problems; OAuth errors point to the token endpoint or device credential;
vehicle mapping errors point to the policy subject/ID or vehicle permission;
LiveKit token errors point to Gateway token issuance or server configuration.
Use Gateway status codes and server-side logs for further diagnosis; never log
bearer tokens, private keys, or device secrets.

## Operational acceptance

- Production uses `AUTH_MODE=oidc`; `AUTH_MODE=dev` is local-development only.
- Operator and vehicle OAuth clients are distinct; every vehicle has a unique,
  revocable machine identity.
- No matching operator ACL means deny; no matching device subject means deny
  when the policy file is enabled.
- Verify a monitor-only operator can observe but cannot acquire control.
- Verify a controller can control only explicitly ACL-authorized vehicles.
- Verify one vehicle's credentials cannot request another vehicle's device
  identity check or room token.
- Revoke/rotate a test vehicle credential and confirm it fails without changing
  other vehicles.
- Keep HTTPS/WSS, short token lifetimes, structured redacted audit logs, and
  restricted outbound/network access.

This prototype's simulation/control features are not production safety
certification.

## Installation and revocation status

The [account lifecycle guide](account-lifecycle.md) documents temporary package
installation and provider revocation. Successful invitation, credential installation,
authenticated data freshness, video readiness, and control authority are separate
facts. Previously issued JWTs remain cryptographically valid until expiry; local
managed binding denial and the existing RTC maintenance/drain boundary enforce
revoked access.
