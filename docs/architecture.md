# Platform Architecture

## Current platform and SDK boundary

`frontend/` (React/TypeScript), `apps/teleop-gateway/` (Go), and
`apps/vehicle-edge-cpp/` (C++17 Auth/Teleop/optional Data SDKs) are the current
platform implementation. Operations telemetry/Monitor/events/tasks use
authenticated HTTPS and durable stores independently of driving DataChannel.
Viewing leases drive media demand; separate multi-vehicle observer Rooms never
grant control authority. One operator controls at most one vehicle, and HTTP
release is `202 PENDING` until authoritative device handover is confirmed.

The Python agent and `apps/operator-console/` remain legacy v1 references,
not replacements for the modular C++ SDK. Their shared input and camera-view
state machines now live only in `packages/teleop-shared/`; both clients import
that transport-free library. The React build does not bundle the v1 sender,
Python actuator adapter or legacy session lifecycle. Input conversion targets the signed v2
integer command contract; only allowlisted simulation is enabled. Gear/mode
actions are rejected, never downgraded to v1. Actual actuation and physical
handover remain disabled pending approved interfaces and bench evidence.

The unified React `/#/?page=drive` workbench uses three independent front cameras
(`camera-left/center/right`), center focus and decoded-frame staleness; it has
no stitching, rear view or single-camera fallback. All three feeds must be fresh
to enable simulation control. Mock is available only through explicit development
preview; the default entry is the authenticated organization operations platform.
Neither video readiness nor a signed request is an actuator acknowledgement.
Device publication remains governed by media demand in the C++ SDK.

## Hosting and deployment boundaries

Frontend hosting and browser execution are different boundaries. `frontend/`
builds static assets; the authenticated application runs in the operator's
browser, whether those assets come from the Compose Nginx service, a separate
static server, or Cloudflare Pages. No per-operator frontend installation is
required. Keep the monorepo and release the web assets and backend independently
with compatible API/protocol versions; a directory rename or repository split
is not required.

For an initial pilot, the recommended topology is Cloudflare Pages for public
web assets plus one Linux server running one Gateway, LiveKit, Redis, the
configured identity service/databases and HTTPS ingress. The existing all-in-one
Compose deployment remains supported. External static hosting requires ingress
and release configuration changes described in
[deployment.md](deployment.md#cloudflare-pages-and-a-single-backend-host);
there is no dedicated backend-only Compose configuration in this repository.

The browser obtains authorized sessions from the Gateway and connects to
LiveKit. WSS carries RTC signaling; video and RTC DataChannel traffic use the
negotiated WebRTC transport to the SFU, or an explicitly configured TURN relay.
The static host/CDN and the Gateway's business HTTP endpoints are not video
relays. In managed mode, the Gateway signaling gate remains mandatory even
when media connects directly to the SFU.

Cloudflare's ordinary HTTP proxy does not relay arbitrary UDP media or ICE TCP.
DNS-only RTC ingress is the simple initial option; TURN and specialized
transport proxies are separate deployment work, not provided by Pages.
Static hosting does not protect uploaded maps through the application's OIDC
login, nor does it remove the need for vehicle ACLs and short-lived RTC tokens.

A single backend host is a pilot tradeoff, not high availability or a capacity
guarantee. Scale media infrastructure based on measured bandwidth and latency;
multiple Gateway instances require resolving SQLite operations storage,
authorization freshness and lease/handover consistency first.

## Repository ownership

```text
frontend/src/features/     Routed layout and task UI
frontend/src/pages/        Routed workbenches and page-level composition
frontend/src/lib/          Domain models and strict protocol adapters
packages/teleop-shared/    Single input/gamepad/view implementation
apps/teleop-gateway/       Gateway API, authority and storage
apps/vehicle-edge-cpp/     Auth/Data/Teleop SDKs, workers and native adapters
api/schemas/              Versioned cross-language payload contracts
infra/                    Build, static hosting and Compose/Kubernetes assets
tests/                    Cross-component acceptance; unit tests stay with owners
docs/                     Current contracts, architecture and operations
```

[compatibility.md](compatibility.md) identifies primary and retained APIs.
`.agents/design/` contains historical design proposals; `.agents/knowledge/`,
`.agents/skills/` and the implementation plans contain contributor guidance that
points here, not parallel architecture specifications. CMake owns portable C++ SDK packaging; Bazel owns
native Cyber builds. They use the same source implementations.

## Identity and authorization architecture

[authentication-plan.md](authentication-plan.md) defines the full target:
Casdoor authenticates people and per-vehicle machine clients; the Gateway owns
business authorization and embeds Go Casbin as its policy engine. Admin APIs,
the policy enforcement point (PEP), provisioning orchestration and Control Lease
remain modules in the same backend, not separate authorization microservices.

The PEP validates JWTs/scopes, resolves trusted identity and resource ownership,
checks lifecycle state, then calls Casbin for role/action/vehicle-range decisions.
PostgreSQL stores business lifecycle records and the single authoritative Casbin
policy set; no parallel RBAC or ACL tables are synchronized with it. Policy
versions, durable revocation and multi-instance freshness checks are required.
Redis remains authoritative for live control leases, revisions and handover
fences. Vehicle-side session/signature/sequence/expiry checks remain independent.
Existing SQLite operations storage is not migrated as part of this design.

After one-time platform setup, the target administrator workflow is to invite
people, register vehicles and assign organization roles plus vehicle ranges.
The backend handles identity binding, independent machine credentials, policy
persistence and diagnostics. Invitation acceptance and secure vehicle credential
installation/verification remain necessary; enrollment is not driving readiness.
Current runtime configuration remains documented in
[authentication.md](authentication.md). The default deployment retains static
authorization. An opt-in, single-Gateway
[managed deployment](auth-management.md) connects Casbin/PostgreSQL to controlled
registration and fixed-role assignment. Optional single-entry onboarding adds
a durable Gateway worker, Casdoor-native invitations and protected vehicle
installation, without a second SMTP configuration or per-vehicle deployment
audience edits. Manual identity binding remains the fallback. Only fresh
onboarding runs online; existing rights changes retain conservative session
drain boundaries. Production online revocation and multi-instance convergence
are not implied. The current phased plan and evolution triggers are
in [`.agents/auth-management-plan.md`](../.agents/auth-management-plan.md).

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
- Preferred vehicle/operator policy configuration is one non-secret authorization policy file containing the registered vehicle, device OIDC subject mapping, and operator ACL. OAuth client secrets remain outside that file; see [authentication.md](authentication.md).
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
