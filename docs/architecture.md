# Three-Component Architecture

This project is a LiveKit remote vehicle monitoring and teleoperation prototype with a browser client, cloud services, and a vehicle-side agent.

## Modules

- `apps/operator-console/`: OIDC Authorization Code + PKCE authentication, control-session acquisition, video subscription, and Ed25519-signed command publishing. Access tokens and private keys remain in page memory.
- `apps/teleop-gateway/`: identity validation, least-privilege LiveKit token issuance, Redis control leases, webhooks, telemetry, and auditing.
- `apps/vehicle-edge/src/vehicle_edge/`: vehicle session orchestration, OAuth client-credential refresh, LiveKit connection, DataPacket handling, command verification, watchdog, and telemetry.
- `infra/`: Docker Compose, LiveKit, Caddy, build scripts, and deferred Kubernetes manifests.
- `tests/`: LiveKit QoS and vehicle-side security tests.

## Data Flow

1. The browser obtains an operator access token through OIDC Authorization Code + PKCE. The vehicle obtains a `teleop:vehicle` token with its device credentials. The Gateway validates identity, tenant, and scopes, then issues a short-lived token limited to `teleop-<vehicle_id>`.
2. Both participants join the same LiveKit room. The vehicle publishes camera video and the browser subscribes to it.
3. A Controller browser creates a one-time Ed25519 key pair and a Redis-backed Control Session. The Gateway atomically binds the vehicle, operator, public key, and short-lived LiveKit token.
4. The browser sends versioned control messages containing the session ID, sequence, timestamp, command, and signature through LiveKit DataPackets. Commands are either high-level driving intents (the default) or explicit low-level actuator values. The vehicle validates and maps high-level intents before applying them. The session is released when the page or RTC connection closes.
5. The vehicle polls for the active session and accepts only packets from the matching operator with a valid signature, sequence, timestamp, and unexpired session. A watchdog applies the configured safety action when control messages stop.
6. The Gateway audits login, vehicle access, control acquire/renew/release, and vehicle disconnect events. The vehicle rate-limits watchdog, rejected-command, and emergency-stop telemetry.

## Access Modes

Operators request either `access=observer` or `access=controller`. Observers can subscribe to video only. Controllers can subscribe to video and publish signed control DataPackets. Redis leases ensure that each vehicle has at most one active Controller session; a conflicting acquire returns `409 Conflict`.

## Authentication and Secret Boundaries

- `AUTH_MODE=dev` is for local development only. Production uses `AUTH_MODE=oidc` with JWT signature, issuer, audience, expiry, subject, tenant, role, and scope validation.
- Vehicle ACLs independently authorize each operator for a vehicle and `observe`/`control` permission. No matching ACL entry means deny.
- The LiveKit API secret remains in the Gateway. Browsers and vehicles receive only short-lived room tokens.
- Device credentials belong in a root-owned `0600` configuration file on the vehicle and must not be passed through command-line arguments, environment variables, or images.
- Production traffic must use HTTPS/WSS. Redis must not be publicly exposed.

## Deployment Status

Docker Compose is the current deployment target. Kubernetes manifests are retained for a later phase. Real CAN/ECU emergency-brake integration, mTLS, E2EE, and production safety certification are not complete.

## Sources

- Requirements: `docs/spec.md`
- Runtime operations: `docs/operations.md`
- Gateway implementation: `apps/teleop-gateway/`
- Vehicle implementation: `apps/vehicle-edge/src/vehicle_edge/`
