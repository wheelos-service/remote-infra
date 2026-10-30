# Platform Architecture

## Current platform and SDK boundary

`frontend/` (React/TypeScript), `apps/teleop-gateway/` (Go), and
`apps/vehicle-edge-cpp/` (C++17 Auth/Teleop/optional Data SDKs) are the current
platform implementation. Operations telemetry/Monitor/events/tasks use
authenticated HTTPS and durable stores independently of driving DataChannel.
Viewing leases drive media demand; separate multi-vehicle observer Rooms never
grant control authority. One operator controls at most one vehicle, and HTTP
release is `202 PENDING` until authoritative device handover is confirmed.

The merged `cyber-apollo-base` Python agent and `apps/operator-console/` remain
legacy v1 integration references, not replacements for the modular C++ SDK.
Their pure input and camera-view state machines are reused by the React build
through typed adapters, without bundling the v1 sender, Python actuator adapter,
or their session lifecycle. Input conversion targets the existing signed v2
integer command contract; only allowlisted simulation is enabled. Gear/mode
actions are rejected, never downgraded to v1. Actual actuation and physical
handover remain disabled pending approved interfaces and bench evidence.

React observers support front/rear three-camera groups, single-front fallback,
manual selection, center focus and decoded-frame staleness. Only visible tiles
are attached and `adaptiveStream` stays enabled. This does not guarantee that
hidden cameras stop upstream encoding; the legacy console intentionally keeps
all six attached. Neither UI group selection nor a signed request is an actuator
acknowledgement. Device publication remains governed by media demand in the C++
SDK, not by whether a browser has selected a camera group.

Detailed platform/module diagrams:
[`agents/frontend-platform-architecture.md`](../agents/frontend-platform-architecture.md),
[`agents/frontend-platform-diagrams.md`](../agents/frontend-platform-diagrams.md).
Delivery gates: [SDK plan](../.agents/teleop-sdk-plan.md).

## Legacy v1 integration reference

This project is a LiveKit remote vehicle monitoring and teleoperation prototype with a browser client, cloud services, and a vehicle-side agent.

## Modules

- `apps/operator-console/`: OIDC Authorization Code + PKCE authentication, control-session acquisition, camera-track layout, and Ed25519-signed command publishing. Access tokens and private keys remain in page memory.
- `apps/teleop-gateway/`: identity validation, least-privilege LiveKit token issuance, Redis control leases, webhooks, telemetry, and auditing.
- `apps/vehicle-edge/src/vehicle_edge/`: vehicle session orchestration, OAuth client-credential refresh, LiveKit connection, camera configuration/capture/publishing modules, DataPacket handling, command verification, watchdog, and telemetry.
- `infra/`: Docker Compose, LiveKit, Caddy, build scripts, and deferred Kubernetes manifests.
- `tests/`: LiveKit QoS and vehicle-side security tests.

## Data Flow

1. The browser obtains an operator access token through OIDC Authorization Code + PKCE. The vehicle obtains a `teleop:vehicle` token with its device credentials. The Gateway validates identity, tenant, and scopes, then issues a short-lived token limited to `teleop-<vehicle_id>`.
2. Both participants join the same LiveKit room. The vehicle publishes either one front camera track or separate left, center, and right camera tracks; the browser subscribes and displays each track independently.
3. A Controller browser creates a one-time Ed25519 key pair and a Redis-backed Control Session. The Gateway atomically binds the vehicle, operator, public key, and short-lived LiveKit token.
4. The browser sends versioned control messages containing the session ID, sequence, timestamp, command, and signature through LiveKit DataPackets. Commands are either high-level driving intents (the default), signed high-level gear/mode requests, or explicit low-level actuator values. The vehicle validates and maps high-level intents before applying them. Gear/mode requests use the same session and signature boundary; gear changes require stopped autonomous feedback, and mode transitions use embedded `ControlCommand.pad_msg` START/RESET actions. The session is released when the page or RTC connection closes.
5. The vehicle polls for the active session and accepts only packets from the matching operator with a valid signature, sequence, timestamp, and unexpired session. A watchdog applies the configured safety action when control messages stop.
6. The Gateway audits login, vehicle access, control acquire/renew/release, and vehicle disconnect events. The vehicle rate-limits watchdog, rejected-command, and emergency-stop telemetry.

## Vehicle Runtime Responsibilities

The vehicle remains one process with one LiveKit room connection. It has no
additional broker or IPC bridge.

| Module | Responsibility |
|---|---|
| `vehicle_node.py` | Configuration, credentials, task composition and shutdown |
| `livekit_transport.py` | RTC lifecycle, token renewal on reconnect, topic routing, bounded command dispatch and lossy sending |
| `control_session_receiver.py` | Session/signature/replay/age checks, command resolution, safety policy and publication feedback |
| `cyber_bridge.py` | Typed Cyber subscriptions/writer, raw latest-sample cache, actuator units and gear mapping |
| `state_publisher.py` | Fixed-rate compact snapshots, stream/sequence envelope, bounded state sends |

`cyber_bridge` knows nothing about LiveKit, and the transport knows nothing about
protobuf messages. `vehicle_node` connects them through callbacks.

Real-time monitoring (`vehicle.state`, vehicle to room) uses reliable DataChannel
packets with a bounded publisher wait; control (`vehicle.control`, controller to
vehicle identity) uses lossy packets. Video remains on media tracks. Gateway HTTPS owns authentication,
control leases, audit and aggregate transport telemetry, not per-command relay.
Vehicle tokens permit data publication for monitoring; observer tokens still
cannot publish data. State recipients check the vehicle's participant identity;
control recipients independently verify the active session and signature.
Empty-topic control packets remain supported for existing clients.

State snapshots run at 5 Hz and contain only selected localization/chassis
fields, receive freshness, and control publication feedback. Callbacks retain
only the latest raw Cyber messages; high-frequency messages are not individually
JSON-encoded. The publisher drops state sends after 150 ms. One pending command
slot prevents ingress backlog; sequence/age checks remain authoritative.
The browser rejects old state packets, distinguishes restarted streams, and
independently marks stopped or stale telemetry.

Control is explicitly opt-in. The local watchdog acts after 300 ms without a
valid command, session expiry/revocation, RTC loss or publication failure, but
never arms an idle monitoring vehicle. Revocation is observed on the next
Gateway poll, not pushed through RTC. Safety handling precedes asynchronous
connection cleanup; reconnect acquires a new room token and restarts services
without replaying queued commands. Browser reconnect releases its lease and
requires explicit reacquisition. Middleware publication is not ECU acknowledgement.
An external autonomy/teleop arbiter, gear-change interlocks, chassis timeout and
physical emergency stop remain required before real-vehicle operation.

## Access Modes

Operators request either `access=observer` or `access=controller`. Observers can receive video and vehicle state but cannot publish data. Controllers can additionally publish signed control DataPackets. Redis leases ensure that each vehicle has at most one active Controller session; a conflicting acquire returns `409 Conflict`.

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
