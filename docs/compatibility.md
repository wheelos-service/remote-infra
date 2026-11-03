# Primary and compatibility boundaries

This document records the maintained interface boundaries. Current architecture
is in [architecture.md](architecture.md); requirements are in
[spec.md](spec.md), payload contracts in `api/schemas/`, and operational setup in
[operations.md](operations.md) and [deployment.md](deployment.md).
Design proposals under `agents/` and progress notes under `.agents/` are not
alternative runtime specifications.

## Runtimes

| Component | Status | Ownership |
| --- | --- | --- |
| `frontend/` | Primary browser | Mock home; authorized three-front-camera `/#/teleop` with explicit v2 simulation |
| `packages/teleop-shared/` | Shared library | Input/gamepad/view state machines only; no protocol or authorization |
| `apps/teleop-gateway/` | Primary server | Identity/ACL, Redis leases and handover fences, HTTPS data and SQLite persistence |
| `apps/vehicle-edge-cpp/` | Primary vehicle SDK | Separate Auth/Data/Teleop, native adapters and isolated RTC worker |
| `apps/operator-console/` | Legacy v1 reference | Compatibility sender and standalone UI; re-exports shared state machines |
| `apps/vehicle-edge/` | Legacy v1 reference | Python/Cyber sessions, media and control; never started by the C++ SDK |

Legacy runtimes are not built or launched by the primary frontend/Compose path.
Do not remove them while explicit legacy tests/deployment consumers remain.
The shared library no longer depends on either legacy runtime.

## Gateway surfaces

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
