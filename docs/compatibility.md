# Primary and compatibility boundaries

This document records the maintained interface boundaries. Current architecture
is in [architecture.md](architecture.md); requirements are in
[spec.md](spec.md), payload contracts in `api/schemas/`, and operational setup in
[operations.md](operations.md) and [deployment.md](deployment.md).
Design proposals under `.agents/design/` and contributor notes under `.agents/`
are not alternative runtime specifications.

## Runtimes

| Component | Status | Ownership |
| --- | --- | --- |
| `frontend/` | Primary browser | Unified authenticated `/#/?page=…` operations; three-front-camera drive workbench with explicit v2 simulation; explicit development Mock preview only |
| `packages/teleop-shared/` | Shared library | Input/gamepad/view state machines only; no protocol or authorization |
| `apps/teleop-gateway/` | Primary server | Identity/ACL, Redis leases and handover fences, HTTPS data and SQLite persistence |
| `apps/vehicle-edge-cpp/` | Primary vehicle SDK | Separate Auth/Data/Teleop, native adapters and isolated RTC worker |
| `apps/operator-console/` | Legacy v1 reference | Compatibility sender and standalone UI; re-exports shared state machines |
| `apps/vehicle-edge/` | Legacy v1 reference | Python/Cyber sessions, media and control; never started by the C++ SDK |

Legacy runtimes are not built or launched by the primary frontend/Compose path.
Do not remove them while explicit legacy tests/deployment consumers remain.
The shared library no longer depends on either legacy runtime.

The opt-in [managed authorization pilot](auth-management.md) is a new,
single-Gateway deployment mode, not a transparent import of legacy JWT roles
or static ACLs. Its `/#/admin` UI supports opt-in automatic Casdoor onboarding,
using Casdoor signup invitation links without email and vehicle-name/machine-code
approval after [vehicle-side bootstrap setup](add-vehicle.md), with manually verified
identity bindings as the fallback, fixed business roles
and vehicle ranges. Fresh automatic onboarding may run online; existing rights
changes retain the maintenance/drain boundary. Default static mode remains
compatible. Managed mode is limited to monitoring and explicitly allowlisted
v2 simulation; it must not enable legacy physical control or general task
dispatch merely because a user can request simulation control.

## Gateway surfaces

Opt-in managed onboarding also exposes proof-authenticated
`/api/v1/device-enrollments` creation/polling/redemption and OIDC-protected
organization approval endpoints. These do not replace machine OAuth,
vehicle-ID matching, control leases or the legacy manual installer; see
[device-code registration](auth-management.md#vehicle-initiated-device-code-registration-no-client-certificate).
The machine code is the existing enrollment `user_code`. Bootstrap configuration
and new vehicle requests omit `name`, `serial`, and `platform`; the administrator
names the vehicle at approval. The v1 signature retains three empty metadata
slots, and legacy signed creation requests remain accepted for pending-request
retries. Existing keys, credentials, and database history are preserved.
Lookup responses now contain identity/status details without retired metadata,
and the manager-only setup endpoint returns only Gateway/console URLs. Deploy
the updated frontend and Gateway before the SDK; older Gateways reject creation
without a name/platform. Existing bootstrap files remain readable by the new SDK.

| Surface | Use | Compatibility rule |
| --- | --- | --- |
| `/api/vehicles` and device `/state` | Primary directory and latest telemetry | Same device identity, registry and operator ACL boundaries |
| `/data/*` | Primary Monitor/profile/events, durable task queries and results | `DataAPI` uses the existing `OperationsStore`; do not create a parallel database |
| `/operations`, `/mission-status` | Compatibility aggregate/runtime reporting | Preserve existing readers and schema; reuse `OperationsStore`, not a second task/event implementation |
| `/viewing/*`, `/media-demand` | Primary on-demand observation | Viewing TTL never grants control; media demand is vehicle-authenticated |
| `/video/*` and `VideoSessionStore` | Retained video orchestration | Also referenced by control acquire/release; not removable just because observation has a new API |
| `/control/*`, `/control/context` | Shared session authority with explicit protocol version | Keep owner, vehicle, revision, expiry and pending-handover checks |
| `/control/simulation-ack` | Allowlisted v2 simulator only | Cannot confirm physical handover |

The implementation already shares authenticated middleware, registry/identity
resolution, ACL helpers, Redis authority and SQLite storage. Similar HTTP paths
are not interchangeable leases. A retirement requires inventorying consumers,
contract migration tests and a documented release change, not a naming cleanup.

## Control protocols

| Contract | Legacy v1 | Current v2 simulator |
| --- | --- | --- |
| Intent | High/low-level normalized commands including legacy gear/mode | Integer per-mille command after capability-restricted input conversion |
| Signature | Pipe-separated canonical fields | Compact JSON array with vehicle/client/receiver/revision binding |
| Channel | Legacy `vehicle.control` behavior | Reliable `vehicle.control.v2` and feedback topic |
| Sender | Legacy operator/session binding | RTC-authenticated `control-<session_id>` |
| Execution evidence | Legacy middleware feedback, not ECU ACK | `simulation: true`; APPLIED is not actuation |

No automatic v2-to-v1 downgrade, payload-derived sender fallback, merged
watchdog, or synthesized physical handover is permitted. Camera readiness is
decoded-frame freshness, not certified end-to-end image age.

The v2 browser checks its 250 ms signing/publication budget and local authority
deadlines immediately after asynchronous sends as well as on ticks. ACK liveness
uses actual dispatches with a 450 ms monotonic deadline instead of raw signed
sequence distance; locally discarded signatures do not count as outstanding
commands. The first fault disconnects RTC and remains visible through cleanup.
These checks preserve the reliable v2 wire contract and do not establish
receiver-side freshness under clock skew. See the
[latency implementation status](control-latency-review-2026-11-11.md#repository-implementation-follow-up)
for diagnostics and the remaining coordinated v3 work.
