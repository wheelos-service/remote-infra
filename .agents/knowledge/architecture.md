# Architecture

## When
Read this file when you need to understand repository module boundaries, multi-tenant entity relationships, organization/person/vehicle registration and binding flows, or real-time media, telemetry, task, and control data paths.

## 1. Repository Module Breakdown & Responsibilities

| Module | Responsibilities |
| --- | --- |
| **`teleop-gateway/`** | Go backend service, with executable entrypoints under `cmd/` and non-exported implementation packages under `internal/`. `cmd/teleop-gateway` runs the HTTP/WebSocket service; `cmd/auth-admin` provides offline bootstrap. `internal/authorization` owns PostgreSQL lifecycle storage, Casbin RBAC/ABAC, onboarding, device enrollment and audit persistence. `internal/gateway` owns OIDC/JWKS, HTTP APIs, telemetry, operations, LiveKit tokens, viewing and Redis-backed control leases. |
| **`frontend/`** | Unified React + TypeScript SPA:<br>- Operations workbench (`/#/?page=fleet\|monitor\|drive\|alerts\|tasks`): fleet overview, live monitoring, WebRTC remote driving cockpit (in-memory ephemeral Ed25519 command signing), alerts, and tasks.<br>- Organization admin console (`/#/admin`): organization switcher, **车辆管理** (device-code lookup/approval & vehicle onboarding), **人员管理** (automated email invitation & cross-org member addition), and **权限管理** (role & vehicle scope assignment). |
| **`packages/teleop-shared/`** | Independently testable, zero-DOM TypeScript input and camera-view state machines. The primary React frontend adapts their intents to the signed v2 wire contract; the package does not own transport, credentials or vehicle writes. |
| **`api/` & `docs/`** | OpenAPI (`rest.openapi.yaml`), AsyncAPI, control/telemetry JSON schemas (`api/schemas/`), and user deployment and operations guides (`docs/`). |
| **`infra/` & `tests/`** | Generated Compose deployment, release packaging and deployment helpers; cross-component contract/E2E test suites. |
| **Vehicle C++ Runtime** | Production vehicle code and configuration live in the Apollo workspace, separate from this server repository. The frontend/server repo owns no vehicle-side runtime implementation. |

## 2. Core Entities & Multi-Tenant Relationships

Authentication (Casdoor IdP) is strictly decoupled from authorization and tenant ownership (Gateway PostgreSQL + Casbin):

- **`Organization` (`authz_organizations`)**: Top-level multi-tenant boundary (`org_id` UUID, `name`, `status`). Owns memberships, vehicles, and `org:<org_id>` Casbin policies.
- **`Person / User` (`authz_users`) & `External Identity Binding` (`authz_external_identity_bindings`)**:
  - Each human has an immutable internal `user_id` (UUID) bound 1:1 to a verified Casdoor `(issuer, subject)` (`identity_kind = 'user'`).
  - **`Membership` (`authz_organization_memberships`)**: **N:M** between `User` and `Organization`. One person can belong to multiple organizations and switch the active organization in the UI (`GET /api/organizations/context`).
- **`Role` & `Scope` (`casbin_rule`)**:
  - Roles per `(user_id, org_id)`: `viewer`, `remote_operator`, `org_admin` (plus internal action sets for `maintainer`, `dispatcher`).
  - **Baseline read access**: Every `active` member of an organization automatically has read/monitoring access (`vehicle.read`, `camera.live.view`, `task.read`) to all `active` vehicles in that organization.
  - **Execution `Scope` (`none | selected | all`)**: Restricts execution permissions (`remote_control.request`, `task.manage`). New personnel default to `scope = none` (zero control authority); `org_admin` manages the organization (`authorization.manage`) and uses `scope = all` for visibility, but `org_admin` never automatically grants remote driving control.
- **`Vehicle` (`authz_vehicles`) & `Vehicle Identity` (`authz_vehicle_identities`)**:
  - **N:1 with `Organization`**: A vehicle belongs to exactly one `org_id`.
  - Immutable `vehicle_id` format: `v-<org_uuid_prefix8>-<customer_vehicle_number>-<random16>` (e.g., `v-12ab34cd-truck-001-8f02a31d65b746cb`).
  - Bound to a dedicated Casdoor confidential OAuth client (`client_id = teleop-device-<op_id>`, `subject = admin/teleop-<op_id>`, `identity_kind = 'vehicle'`) and, for device-code enrollment, anchored to the vehicle's hardware/persistent Ed25519 public key in `authz_enrolled_device_keys`.

## 3. Registration, Organization Binding & Full Lifecycle Management

### 3.1 Organization Lifecycle (Create & Disable)
- **Offline Initial Bootstrap**: `cmd/auth-admin --input bootstrap.json --database-url-file db.dsn` while the Gateway is stopped (enforced by PostgreSQL advisory lock `7439102342056781`) atomically creates the first `Organization`, initial `platform_admin` `User`, `(issuer, subject)` binding, membership, and `org_admin` policy.
- **Online Organization Creation (`POST /api/admin/organizations`)**: `platform_admin` creates new organizations online (`Store.CreateOrganization`), automatically binding the creator as initial `org_admin` (`scope = all`) without service interruption.
- **Online Organization Decommission (`DELETE /api/admin/organizations/{org_id}`)**: `platform_admin` soft-disables an organization (`Store.DisableOrganization`), atomically setting `authz_organizations.status = 'disabled'`, marking all memberships `removed`, disabling all vehicles and revoking `authz_vehicle_identities`, releasing `authz_enrolled_device_keys` and `vehicle_number` reservations, expiring pending enrollments/tickets, clearing `org:<org_id>` Casbin policies, and triggering `ManagedRuntime.EvictVehicles` to purge Redis control/viewing/video leases and close active LiveKit rooms.

### 3.2 Person Lifecycle (Register, Join, Kick & Re-join)
- **Path A — Automated Email Invitation (New Person, Primary Flow)**:
  1. Admin submits `{kind: "person", name, email, role, scope, vehicle_ids, idempotency_key}` to `POST /api/admin/organizations/{org_id}/onboarding`.
  2. Gateway reserves an immutable `planned_identity_id` in `authz_onboarding_operations` (`stage: planned -> provider -> binding -> invitation -> completed`).
  3. Background worker creates the Casdoor user, binds `(issuer, subject) -> user_id`, inserts `authz_organization_memberships(org_id, user_id)`, writes Casbin rules, and triggers Casdoor's native verification/password-setup email (`%link`).
  4. The user sets their password directly in Casdoor (Gateway never handles user passwords) and signs in via OIDC PKCE.
- **Path B — Adding an Existing User to Another Organization (`POST /api/admin/organizations/{org_id}/members`)**:
  - Admin submits `{subject}` (`Store.AddExistingMember`). Gateway never merges or adopts accounts by mutable email address.
- **Kicking a Member (`DELETE /api/admin/organizations/{org_id}/members/{user_id}`) & Re-joining**:
  - `Store.RemoveOrganizationMember` prevents self-removal and last-admin removal, sets `authz_organization_memberships.status = 'removed'`, deletes all `casbin_rule` grants in that organization while preserving the user's global identity and memberships in other organizations, and invokes `ManagedRuntime.EvictMember` to immediately release any active Redis control lease (transitioning the vehicle to the `PENDING` handover fence) and remove the participant from LiveKit rooms.
  - A previously kicked (`removed`) or `suspended` user can cleanly re-join the organization via `POST .../members` or `POST .../people` (`ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'active'`).

### 3.3 Vehicle Lifecycle (Enroll, Bind, Kick & Re-enroll)
- **Path A — Vehicle-Initiated Ed25519 Device-Code Enrollment (Recommended Zero-Touch Flow)**:
  1. Vehicle runs `vehicle_bootstrap`, generates a persistent `0600` Ed25519 keypair (`/etc/teleop/device-key.pem`), and signs `POST /api/v1/device-enrollments` (`request_id`, `public_key`, `name`, `serial`, `platform`, `timestamp`, `nonce`, `signature`) to receive an 8-character `user_code` (`XXXX-XXXX`) and `device_code`.
  2. Admin selects the target organization in `/#/admin`, looks up `user_code` (`POST /api/admin/organizations/{org_id}/device-enrollments/lookup`), and approves with `{name, vehicle_number}` (`POST .../approve`).
  3. Gateway atomically binds the enrollment and `public_key` (`authz_enrolled_device_keys`) to `org_id`, generates `vehicle_id`, and provisions the Casdoor confidential client in the background.
  4. Vehicle polls `POST /api/v1/device-enrollments/token` -> receives a 5-minute key-bound `ticket` -> immediately redeems `POST /api/v1/device-enrollments/complete` -> writes `/etc/teleop/device.json` -> verifies OAuth `client_credentials` (`teleop:vehicle`) + `/api/vehicles/{vehicle_id}/device-auth-check` -> calls `POST /api/vehicles/{vehicle_id}/installation-complete` (`status = active`).
  5. **Credential Recovery**: If `/etc/teleop/device.json` is lost on the vehicle, re-running `vehicle_bootstrap` with the same `device-key.pem` automatically sets `recovery = true`; admin approval rotates the Casdoor secret under the guard while preserving the existing `vehicle_id` and `org_id`.
- **Path B — Admin Pre-Created Installation Ticket (Fallback Flow)**:
  - Admin creates `{kind: "vehicle", name, vehicle_number}` via `POST /api/admin/organizations/{org_id}/onboarding`, issues a 5-minute one-time bearer ticket (`POST .../installation-ticket`), and runs `infra/scripts/install-vehicle-auth.py` on the vehicle.
- **Kicking / Unbinding a Vehicle (`DELETE /api/admin/organizations/{org_id}/vehicles/{vehicle_id}`) & Re-enrolling**:
  - `Store.RemoveVehicle` sets `authz_vehicles.status = 'disabled'`, revokes `authz_vehicle_identities`, deletes `authz_enrolled_device_keys`, clears `vehicle_number` uniqueness reservations, expires pending enrollments/tickets, removes the vehicle from `selected` Casbin grants (downgrading any grant that loses its last selected vehicle to `ScopeNone`), and triggers `ManagedRuntime.EvictVehicles` (`PurgeVehicleLeases` + LiveKit `DeleteRoom`).
  - Once removed, the vehicle's hardware `device-key.pem` and `vehicle_number` are free to re-enroll into the same or another organization.

### 3.4 Human Permission Lifecycle (Grant, Narrow & Revoke)
- **Granting / Updating Permissions (`POST /api/admin/organizations/{org_id}/assignments`)**:
  - Assigns `role` (`viewer | remote_operator | org_admin`) and `scope` (`none | selected | all` + `vehicle_ids`).
  - If an operator's role is downgraded or their `selected` vehicle set is narrowed while holding a control lease on an excluded vehicle, `ManagedRuntime.EvictMember(..., keepAllowedControl=true)` immediately revokes that control lease (`ReleaseControlSession` -> `PENDING` handover fence).
- **Revoking Permissions (`DELETE /api/admin/organizations/{org_id}/assignments/{user_id}`)**:
  - `Store.RevokeManagedRole` clears the member's Casbin role/scope in the organization (returning them to baseline organization read-only membership without kicking them from the organization) and immediately revokes any active control lease.
- **Online Execution (`AUTHORIZATION_ONLINE_MUTATIONS=true` / `AUTHORIZATION_MULTI_INSTANCE=true`)**:
  - Management mutations execute online via `BeforeAdditive` + `SERIALIZABLE` PostgreSQL transactions + targeted Redis/LiveKit eviction (`EvictVehicles`, `EvictMember`), eliminating the legacy 11-minute global maintenance drain barrier while preserving strict single-instance drain semantics when `onlineMutations` is disabled.

### 3.4 Human vs. Vehicle Registration Summary

| Dimension | Human Registration (`person`) | Vehicle Registration (`vehicle`) |
| --- | --- | --- |
| **Initiator** | Admin-invited from `/#/admin` (no public sign-up) | Vehicle-initiated (`vehicle_bootstrap`) + Admin approval in `/#/admin` |
| **Credential Anchor** | Interactive user password / OIDC PKCE session in Casdoor | Persistent Ed25519 private key (`device-key.pem`) + OAuth `client_credentials` (`device.json`) |
| **Secret Delivery** | Out-of-band email setup link (`%link`) from Casdoor | Ed25519 proof-of-possession over `/device-enrollments/{token,complete}` |
| **Org Cardinality** | **N:M** (`authz_organization_memberships`) | **N:1** (`authz_vehicles.org_id`) |
| **Default Authority** | `scope = none` (read/view all org vehicles; no control) | `teleop:vehicle` scope for own `vehicle_id` only (`control_mode = disabled`) |

## 4. Post-Enrollment Runtime Authentication & Data Planes

Once enrolled, the vehicle and Gateway operate across 4 zero-redundancy authentication layers:
1. **L0 Hardware/Enrollment Anchor (`device-key.pem`)**: Used only by `vehicle_bootstrap` during initial enrollment or credential recovery.
2. **L1 Machine Identity (`SharedTokenProvider` -> OAuth `client_credentials` JWT)**:
   - Shared across all vehicle HTTP services (`DataService`, `SourceService`, `TeleopClient`, `ControlService`) with single-flight refresh and TCP/TLS connection reuse.
   - Authenticates **Vehicle Telemetry & Durable Data** (`POST /api/vehicles/{id}/telemetry`, `/profile`, `/health`, `/events`, `/faults`, `/diagnostics`), **Task Pull & Execution Reporting** (`POST /api/vehicles/{id}/tasks/pull`, `/tasks/{task_id}/status`), and **Demand Polling** (`GET /api/vehicles/{id}/media-demand`).
3. **L2 Real-Time Media & Telemetry Plane (Inline `media_token` -> LiveKit Room)**:
   - When an authorized member views or controls a vehicle, `/media-demand` returns `rtc_required = true` (`video_required` gated separately) and an inline short-lived LiveKit `media_token`, passed over `SOCK_SEQPACKET` (`FD 3`) to `vehicle_media_worker`.
4. **L3 Remote Driving Control Lease (Redis Lease + Ephemeral Operator Ed25519 Signature)**:
   - Operator acquires a 12 s Redis lease (`POST /api/vehicles/{id}/control/acquire`) with an in-memory Ed25519 public key (`operator_public_key`) and monotonic `revision`.
   - `ControlReceiver` on the vehicle verifies `session_id`, `vehicle_id`, `sender_id`, `revision`, `seq`/`ts`, and Ed25519 signature on every DataChannel packet (`vehicle.control.v2`) with a 300 ms watchdog before forwarding to Apollo `Guardian` / `Canbus`. See `vehicle-cyber.md` for full Cyber/Guardian/Canbus arbitration invariants.

## 5. Horizontal Scaling, Load Balancing & Service Topology

### 5.1 Traffic Separation & Topology

Traffic in teleoperation and fleet management separates into three distinct planes and must not be funneled through a single undifferentiated proxy:
1. **Static Web Assets (`console.wheelos.cn`)**: Pure static SPA (`frontend/dist/` with Hash routing `/#/`, `/#/vehicles/:id`, `/#/admin`, `/#/device` and `window.__LIVEKIT_INFRA_CONFIG__` runtime config injection). Hosted on CDN/OSS/S3 or standalone Nginx; configure `ALLOWED_ORIGINS` on the Gateway and register the frontend origin's Redirect URI in Casdoor.
2. **Control Plane & Signaling (`api.wheelos.cn`, L7 HTTPS/WSS)**: Handled by an L7 Load Balancer (Nginx / Caddy / Cloud ALB) terminating TLS and routing by path to stateless `teleop-gateway` and `casdoor` replicas.
3. **Real-Time Media & High-Frequency Control (`livekit` SFU Mesh, Direct UDP / L4 NLB)**: WebRTC media and `vehicle.control.v2` DataChannel packets (`UDP 7882` / `50000-60000`, `TCP 7881`, `TURN/UDP 3478`, `TURN/TLS 5349`) bypass the L7 proxy directly to SFU node public IPs (`rtc.use_external_ip: true`).

### 5.2 Stateless Multi-Instance Gateway (`teleop-gateway`)

- **`AUTHORIZATION_MULTI_INSTANCE=true`**: Enables multiple Gateway replicas to run concurrently without acquiring the single-instance pilot advisory lock (`pg_try_advisory_lock(7439102342056781)`). Policy writes coordinate via `SERIALIZABLE` PostgreSQL transactions and `authz_policy_state.version` increments, triggering automatic Casbin snapshot reloads on all replicas. Schema migrations serialize via `pg_advisory_xact_lock(7439102342056782)`.
- **`OPERATIONS_DATABASE_URL` (Shared PostgreSQL Operations Store)**: Replaces per-node SQLite (`OPERATIONS_DB_PATH`) in multi-replica deployments so all Gateway instances share `operations_history`, `operations_error_state`, `operations_alerts`, `operations_missions`, `data_snapshots`, `data_events`, `data_event_acknowledgements`, and `data_tasks`.
- **Worker & Rate-Limit Coordination**: Onboarding workers claim pending operations atomically (`WHERE ... AND (status='pending' OR (status='running' AND next_attempt_at<=now()))`), and `enrollmentRateLimiter` coordinates device-enrollment rate limits across instances via shared Redis (`SetRateLimitRedis`) with automatic in-memory fallback.

### 5.3 L7/L4 Load Balancing Rules

- **`/api/*`, `/healthz`, `/readyz` -> `teleop-gateway:8080` Pool**:
  - **Algorithm**: Round-Robin or Least-Connections (no sticky sessions required; all state lives in PostgreSQL and Redis).
  - **Health Check**: `GET /readyz` (verifies Redis, `OperationsStore`, and `ManagedRuntime` PostgreSQL connectivity).
- **`/rtc`, `/rtc/*` -> `teleop-gateway:8080` Pool -> `livekit:7880`**:
  - **WebSocket Upgrade**: Preserve `Upgrade: websocket` and `Connection: upgrade`; set `proxy_read_timeout` / `idle_timeout >= 3600s`.
- **`/login/*`, `/oauth/*`, `/.well-known/*`, `/api/login*`, `/api/get-account*` -> `casdoor:8000` Pool**:
  - **Algorithm**: Round-Robin.
- **WebRTC Media & TURN -> `livekit` SFU Nodes**:
  - Signaling returns the assigned SFU node's external IP/UDP port via SDP/ICE; LiveKit nodes coordinate rooms (`vehicle-<id>`) across the cluster via shared `REDIS_URL`. Use L4 NLB for TURN (`3478/udp`, `5349/tcp`) when enterprise firewall traversal is required.

### 5.4 Backend Service Allocation & Sizing

| Service Tier | Scaling Model | Recommended Sizing | Responsibilities & Key Config |
| --- | --- | --- | --- |
| **Control & Auth Plane** (`teleop-gateway` + `casdoor`) | **Stateless** (CPU/IO light) | **2–4 replicas** across AZs (`2 vCPU / 2–4 GiB RAM` each) | `AUTHORIZATION_MODE=managed`, `AUTHORIZATION_MULTI_INSTANCE=true`, `AUTHORIZATION_DATABASE_URL`, `OPERATIONS_DATABASE_URL`, `REDIS_URL`. Handles REST authz, enrollment, control leases, task dispatch, telemetry ingest, and `/rtc` signaling admission. |
| **Real-Time Media Plane** (`livekit-server` SFU) | **Redis-Coordinated Mesh** (Bandwidth & PPS intensive) | **2–M nodes** (`4–8 vCPU / 8 GiB RAM`, dedicated public EIP, `hostNetwork: true`) | Shared `REDIS_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`; `rtc.use_external_ip: true`; direct firewall ingress for `7882/udp`, `7881/tcp`, `3478/udp`. ~30–50 concurrent active streaming vehicles per `4 vCPU` SFU node. |
| **Real-Time State Plane** (`Redis`) | **Stateful In-Memory** (Low latency) | **1 Primary + 1 Replica + Sentinel** (or managed Redis HA, `2 vCPU / 4 GiB RAM`) | 12 s exclusive control leases (`control:*`), handover state machine, on-demand viewing leases (`viewing:*`), latest telemetry snapshots, global enrollment rate limits, and LiveKit distributed room routing. |
| **Durable Storage Plane** (`PostgreSQL 16`) | **Stateful ACID** | **1 Primary + 1 Standby HA** (or managed RDS, `2–4 vCPU / 8 GiB RAM` + SSD) | Hosts `authz_*` (organizations, users, vehicles, Ed25519 enrollments, Casbin policy versions), `operations_*` / `data_*` (telemetry history, alerts, missions, tasks, events), and `casdoor` OIDC identity tables. |

### 5.5 Phased Evolution Roadmap

- **Stage 1 (1–30 Vehicles, Single/Dual Host Starter)**:
  - Host static frontend on CDN/Nginx; run `2 × teleop-gateway` + `1 × livekit` + managed/containerized `PostgreSQL` & `Redis` on 1–2 nodes for minimal operational overhead.
- **Stage 2 (30–500+ Vehicles, Decoupled Compute & Media Mesh)**:
  - Separate **LiveKit SFU into a dedicated public-EIP media node pool** scaling linearly with concurrent active vehicles, place **2–4 stateless `teleop-gateway` and `casdoor` replicas behind an L7 ALB**, and back them with HA RDS PostgreSQL and Redis Primary/Replica.

## Rules & Do NOTs
- Keep pure browser/input state machines in `packages/teleop-shared/`; deployed applications must not import one another's source.
- The browser holds only short-lived tokens and the ephemeral operator private key in page memory; the LiveKit API secret, Redis password, Casdoor admin credentials, and vehicle secrets must never reach the browser.
- Never merge or adopt human accounts by mutable email address; always bind verified `(issuer, subject)` to internal UUIDs.
- Do not bypass the Gateway by generating LiveKit administrative credentials in the browser or combining client, Gateway, LiveKit, and vehicle-edge responsibilities in one module.

## Sources (SSOT)
- Managed authentication, onboarding, and device enrollment: `docs/auth-management.md`
- Primary/legacy contracts: `docs/compatibility.md`
- Payload contracts: `api/schemas/`
- Gateway implementation: `teleop-gateway/`
- Cyber/LiveKit vehicle runtime invariants: `.agents/knowledge/vehicle-cyber.md`
