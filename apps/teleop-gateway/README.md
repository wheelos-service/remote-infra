# Teleop Gateway

The Gateway is a small Go service for the operator-console and vehicle-edge
demo. It authenticates users, issues scoped LiveKit tokens, manages Redis-backed
control/video sessions, and records audit and telemetry events.

## Layout

```text
cmd/teleop-gateway/       # Process entrypoint only
internal/gateway/         # Gateway application and focused domain files
  app.go                  # Dependency wiring, routes, middleware, probes
  oidc_auth.go            # Authentication and claims
  vehicle_acl.go          # Vehicle permissions and identity mapping
  livekit_token.go        # Scoped LiveKit token creation
  control_*.go            # Control session and Redis lease behavior
  video_session*.go       # Video session state and HTTP API
  viewing_lease*.go       # Individual observer leases and device media demand
  operations*.go          # Durable read-only business history and mission status
  audit.go                # Audit and telemetry handling
  turn_auth.go            # TURN credential helper
*_test.go                 # Tests colocated with the implementation
```

## Local commands

```bash
go test ./...
go build -o teleop-backend ./cmd/teleop-gateway
```

The Docker Compose service and `infra/scripts/build-backend.sh` use the same
`./cmd/teleop-gateway` entrypoint.

## Opt-in v2 simulation control

Legacy acquire remains compatible. V2 acquire additionally requires
`protocol_version: 2` and a valid `client_instance_id`, and only accepts vehicle
IDs explicitly listed in `SIMULATED_CONTROL_VEHICLES_JSON` (default `[]`).
Use disposable simulator IDs only. The returned RTC token is bound to
`control-<session_id>`, not a reusable operator-wide identity.

`GET /api/vehicles/{id}/control/context` is restricted to that registered device.
One Redis Lua evaluation returns active session, persistent fence revision,
remaining TTL and pending revocation state atomically.
`POST /api/vehicles/{id}/control/simulation-ack` requires the matching device,
simulation allowlist and pending v2 session/revision; it cannot clear legacy
physical-control sessions. This separate simulated ACK never enables
`CONTROL_HANDOVER_ACK_ENABLED`, which remains false by default.
The existing per-vehicle/per-tenant-operator singleton fences still apply.

See [`tests/control-chain.py`](../../tests/control-chain.py) for the disposable
cross-end acceptance runner and the
[SDK protocol/testing guide](../vehicle-edge-cpp/README.md#testable-v2-control-loop).

## Registered vehicle snapshots

Set `VEHICLE_REGISTRY_JSON` to an array of `{"vehicle_id":"car-1","name":"First"}`.
Invalid entries, unknown configuration fields, and duplicate IDs fail startup.
An unset value or `[]` registers no vehicles. Device packets never register cars.
IDs must match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`.

- `POST /api/vehicles/{vehicle_id}/state`: authenticated device identity must
  match the registered path and payload vehicle. Uses the existing
  `VEHICLE_SUBJECT_MAP_JSON` identity rules. The body must match
  `api/schemas/vehicle-telemetry.schema.json`, with a maximum size of 64 KiB.
  Unknown fields, duplicate object keys (at any level), trailing JSON, and numbers
  overflowing or underflowing finite float64 representation are rejected.
  Success is `204`; stale,
  duplicate, conflicting streams, or exhausted stream history return `409`.
- `GET /api/vehicles`: `{ "vehicles": [...] }`, filtered by observer role and
  tenant-aware observe ACL. An empty registry or no grants yields an empty array.
- `GET /api/vehicles/{vehicle_id}/state`: one registered, observe-authorized entry.

Each entry contains `vehicle_id`, `name`, `state` (the unchanged envelope or
`null`), `received_at_ms` (or `null`), `server_time_ms`, `online`, and
`control: {status: "free" | "occupied" | "unknown", is_self: boolean}`.
No control-session ID, operator identity, or public key is exposed. Control is
unknown if the lease component is unconfigured or an older lease cannot be
interpreted as an active session; Redis errors return `503`, never a free lease.
All new vehicle list/state responses use `Cache-Control: no-store`, including errors.

Validate a real C++ publisher snapshot against the gateway contract with:

```bash
TELEMETRY_FIXTURE=/path/to/snapshot.json go test ./internal/gateway -run '^TestVehicleTelemetryExternalFixture$' -v -count=1
```

This is polling, not SSE. Online means a server receipt no more than ten seconds
old; it does not certify fresh/valid sensor data. Per-sample source timestamps
and ages are retained, including null values. Publish timestamps do not determine
online status. Gateway instances need synchronized clocks; writes observed
before the previous server receipt are rejected rather than refreshing state.

Redis atomically fences stream IDs and sequences per vehicle. A different stream
can take over only after the previous receipt is more than ten seconds old.
Retired IDs can never return. At most 64 retired IDs are retained per vehicle;
further takeovers fail closed, while the current stream can continue. Snapshots
and replay fences have **no TTL**, so offline snapshots remain available and a
Redis expiry cannot resurrect old streams. Use durable Redis persistence and a
`noeviction` policy: deleting/evicting these keys destroys replay protection.
Plan a coordinated, authenticated device/registry reprovisioning procedure before
exhausting the stream limit; do not casually clear Redis keys to restart devices.

## Persistent operations

The running Gateway requires a persistent SQLite database, configured with
`OPERATIONS_DB_PATH` (default `data/operations.db`). `:memory:` is test-only and
rejected at startup. The database uses versioned migrations, WAL and FULL
synchronization; directory/file permissions are 0700/0600. Startup and readiness
fail explicitly when the database cannot be opened or queried. Compose mounts
`operations-data`; this deployment supports **one Gateway**, not replica-local
databases pretending to share history.

`GET /api/vehicles/{vehicle_id}/operations` requires observe role and current
tenant/vehicle ACL. It returns telemetry-derived diagnostics, chassis error
transitions, read-only Mission snapshots and recent telemetry history, matching
[`vehicle-operations.schema.json`](../../api/schemas/vehicle-operations.schema.json).
It does not certify SystemStatus health, geographical projection, complete
replay or driving readiness. Retention is 1000 snapshots, alerts and missions
each per vehicle; responses contain at most 300 snapshots, 100 alerts and
100 missions. No background recording or video history is created.

`POST /api/vehicles/{vehicle_id}/mission-status` is matching-device-only and
accepts exactly `mission_id`, `status`, `updated_at_ms` and `description`, with
an 8 KiB body limit. Updates are newer-only, exact retries are idempotent and
conflicting/outdated records return 409. This is snapshot ingestion, **not**
task dispatch or a native Mission adapter.

Telemetry is first accepted by Redis, then archived in SQLite before returning
204. These stores are not one transaction. An archive failure returns 503 even
if Redis already accepted the latest state. An exact retry of that current,
unarchived packet can finish SQL persistence without refreshing the original
receipt or online deadline. Already archived duplicates, different payloads
and superseded packets still return 409; a missing older archive does not
bypass the replay fence. Sequence gaps remain visible rather than fabricated.
Monitor disk capacity and use consistent backups as described in
[`docs/operations.md`](../../docs/operations.md).

## Data SDK business APIs

The independent `/api/vehicles/{vehicle_id}/data` namespace uses the same
SQLite store (schema v2) without changing `/operations`. All requests require
authentication and vehicle-scoped authorization:

| Method and suffix | Permission and meaning |
| --- | --- |
| `GET /data` | Observe role + observe ACL; profile/Monitor/diagnostics snapshots, latest 100 events/tasks and acknowledgements for those visible events |
| `POST /data/profile`, `/data/health` | Matching device only; latest versioned snapshots, not driving feedback |
| `POST /data/diagnostics` | Matching device only; bounded retained/pending local SQLite counters, 8 KiB maximum |
| `POST /data/events` | Matching device only; immutable Monitor transition identity, exact retries idempotent |
| `POST /data/events/{event_id}/acknowledge` | Controller role + control ACL; human awareness, not fault recovery |
| `POST /data/tasks` | Controller role + control ACL; typed read-only query or explicitly allowlisted simulation; 202 means cloud-persisted only |
| `GET /data/tasks/next`, `POST /data/task-results` | Matching device only; durable receipt/dispatch/unknown/terminal reporting |
| `GET /data/records?kind=events\|tasks&after=0&through=0` | Observe role + observe ACL; non-destructive export, at most 100 records/page |

`GET /data` includes caller-specific `can_manage`, cloud `capacity` and nullable
device `diagnostics` (`payload` plus `received_at_ms`). Diagnostics type
`vehicle_data_diagnostics`, schema version 1, carries `vehicle_id`, `stream_id`,
`sequence`, `published_at_ms` and `store`:

```json
{
  "capacity": 10000,
  "outbox_retained": 12,
  "outbox_pending": 1,
  "inbox_retained": 3,
  "inbox_pending": 1,
  "faults_retained": 4
}
```

Pending counts cannot exceed retained counts; all retained counts are bounded
by capacity. Source/publication/receipt ages remain distinct. Frontend contracts
live in `frontend/src/lib/vehicle-data-api.ts`; `tests/data-chain.sh` validates
actual C++ uploads and HTTP read/export responses against them.

Export returns `through`, `next`, `has_more`, and `records`. Continue with
`after=next` and the original `through`; new inserts cannot extend that export.
Task reports and acknowledgements remain live between pages. This is not a
consistent database backup, and export never frees retained deduplication
identities. Cloud limits are 10000 events/1000 tasks per vehicle, with explicit
507 on exhaustion. See [`docs/operations.md`](../../docs/operations.md) for
80% warnings, backup/archival and rollout order. Real motion tasks, safety reset
and autonomous/teleop mode arbitration are not enabled by these APIs.

## Individual viewing leases and media demand

The platform observer workbench uses the following **new** APIs. The original
`/video` APIs remain legacy compatibility endpoints; their shared counter is not
an authority for the new demand model. Do not mix the two lifecycles.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/vehicles/{vehicle_id}/viewing/acquire` | Create one independently expiring viewer |
| POST | `/api/vehicles/{vehicle_id}/viewing/{viewing_session_id}/renew` | Extend this viewer only |
| POST | `/api/vehicles/{vehicle_id}/viewing/{viewing_session_id}/release` | Idempotently release this viewer |
| GET | `/api/vehicles/{vehicle_id}/media-demand` | Authenticated device-self demand synchronization |

Acquire requires exactly `{"request_id":"<uuid>","client_instance_id":"<uuid>"}`.
Reuse both values only when retrying the **same** attempt. The resulting session
ID is bound to the vehicle, tenant, operator, instance and request. Renew/release
require an empty body and recheck observe ACL and owner. Duplicate acquire does
not extend the deadline or increase the count. Expired/released requests return
`409`; use a new request ID for a new attempt. Release returns `204` even if an
already-gone lease is retried; a known foreign owner returns `403`.

Acquire returns `vehicle_id`, `viewing_session_id`, `expires_at_ms`,
`server_time_ms`, `renew_after_ms` and a read-only `token`. Renew returns the same
fields without a token. The lease lasts 30 seconds; renew after 10 seconds.
The token's identity is `observer-<viewing_session_id>`, not the legacy
`operator-<operator_id>`. Distinct instances cannot evict each other through an
identical observer identity. Controller identity/signing behavior is unchanged.
Observer grants never publish tracks or data.

Demand follows [`media-demand.schema.json`](../../api/schemas/media-demand.schema.json):
`rtc_required = video_required = (viewer_count > 0 || control_required)`.
Control demand reads the **actual active control lease** and its Redis TTL, never
the legacy cached controller reference. Viewing expiry and count updates run
atomically in Redis Lua using Redis TIME, across Gateway instances. Maximum 64
active viewers per vehicle; excess acquisition returns `429`. Expiry is lazy on
the next mutation/demand read, so no cleanup worker is required. Released and
expired request records remain for up to 24 hours to prevent delayed retries
from reviving them; idempotency does not extend beyond that retention window.

Each registered vehicle's demand has a persistent random `epoch` and increasing
`revision`. Reads do not increment the revision unless effective membership or
control demand changed; successful lease mutations do. Renewed control TTL may
change the validity deadline without changing the revision. The device must
accept newer validity on an equal revision, reject lower revisions in the same
epoch, and invalidate its previous authorization on an epoch change.
Responses expire after **at most 5 seconds**, clipped to the latest contributing
lease expiry, with a suggested 1-second poll interval. Convert
`valid_until_ms - server_time_ms` to a local monotonic deadline, conservatively
subtract request duration, and never extend authorization using cached or late
responses. Demand has zero grace for now; a later media lifecycle may not extend
this deadline to implement grace. A missing Room, token request, telemetry read,
legacy viewer count or stale controller reference does not create demand.

All responses, including authentication errors, disable caching. Corruption or
Redis failure is `503`, not an OFF/free success-shaped fallback. Redis must be
time-synchronized; detected backward clock movement also fails closed with `503`
until the clock catches up, rather than resurrecting expired leases. Redis must be
durable, `noeviction`, and standalone (the existing control keys are not Redis
Cluster hash-slot compatible). Persistent epoch/revision keys must not be
selectively cleared while active devices retain old demand. Apply deployment
request-rate limits in addition to the active-viewer cap and 24-hour record TTL.

The browser disconnects on renewal failure and releases with its original
credentials. This lease is a **media demand**, not an SFU access-revocation
mechanism: previously issued observer JWTs have their own lifetime; other
viewers/control may keep the Room alive. Immediate per-viewer SFU removal/token
revocation is not implemented. The C++ service now implements demand polling and
an optional real-SDK media worker with an explicitly synthetic camera. Real
camera deployment and production resource/bandwidth evidence remain unverified.
No unattended-zero-video deployment claim is made, and lease release does not
confirm physical vehicle handover.

Run optional real-Redis compatibility checks only against a disposable instance:

```bash
VIEWING_TEST_REDIS_ADDR=127.0.0.1:6379 go test ./internal/gateway -run '^TestViewingRealRedis$' -count=1
```

## Control handover fences

Control acquisition now atomically reserves both the vehicle and its operator
within the authenticated tenant. One account cannot hold two vehicles via
different tabs or Gateway instances. Persistent vehicle/operator fences are
**not** removed by lease expiry, token failure after allocation, or HTTP release.
Deleting these keys or restoring an older Redis backup can destroy this
protection; use durable standalone Redis with `noeviction`.

`POST /api/control/{session_id}/release` now returns **202**, with the handover
state, rather than a 204 implying completion. This is an intentional control API
behavior change. A release accepted by HTTP means `PENDING`, not physical
handover. Existing senders must stop input immediately and may not acquire B
until A's handover is `CONFIRMED`; the server enforces that rule independently
of client UI. Expiry likewise becomes pending on the next handover read.
An unresolved handover makes fleet control occupancy `unknown`, never `free`.
Renew/release check authenticated tenant, role and current vehicle control ACL.

`GET /api/vehicles/{vehicle_id}/control/handover` is available to the matching
device and observe-authorized operators. The response includes `vehicle_id`,
`session_id`, monotonic `revision`, `state` (`NONE`, `ACTIVE`, `PENDING` or
`CONFIRMED`) and separate `edge_revocation_applied` and
`vehicle_handover_confirmed` flags. The operator's cross-vehicle guard is removed
only by a current-session/revision acknowledgement after the lease is gone.

`POST /api/vehicles/{vehicle_id}/control/handover/ack` requires the matching
authenticated device and the strict
[`control-handover.schema.json`](../../api/schemas/control-handover.schema.json)
body. Native revocation must be true. Reporting physical confirmation as false
returns `202 PENDING` and records only `edge_revocation_applied`; both persistent
guards remain. A later current-revision report with physical confirmation true
completes handover. Incomplete, duplicate-key, stale-session and stale-revision
requests cannot unlock another vehicle. Exact successful retries are idempotent.
This endpoint is disabled unless `CONTROL_HANDOVER_ACK_ENABLED=true`, which is
an explicit **deployment safety gate**, not an implementation of a vehicle
policy. Do not enable it until the native revocation and physical handover
criteria have been verified on an approved bench. A zero speed, writer success,
HTTP acknowledgement or lease timeout alone is not such evidence.

The new C++ agent does not implement actuation or physical handover
acknowledgements; platform driving stays unavailable. Existing legacy control
clients may encounter a persistent pending handover after their first release
or expiry. There is deliberately no force-unlock browser endpoint, automatic
timeout bypass, or fake simulator confirmation in the live API.
Vehicle Room tokens now allow data publication for `vehicle.state` feedback;
observers still cannot publish tracks or data.
