# Architecture

## When
Read this file when you need to understand repository module boundaries, multi-tenant entity relationships, organization/person/vehicle registration and binding flows, or real-time media, telemetry, task, and control data paths.

## 1. Repository Module Breakdown & Responsibilities

| Module | Responsibilities |
| --- | --- |
| **`apps/teleop-gateway/`** | Go backend service:<br>- `cmd/teleop-gateway`: Main HTTP/WebSocket gateway server.<br>- `cmd/auth-admin`: Offline bootstrap CLI (`--input bootstrap.json`) that initializes an `Organization`, initial `platform_admin` `User`, Casdoor `(issuer, subject)` binding, and `org_admin` Casbin rule.<br>- `internal/authorization`: Multi-tenant PostgreSQL lifecycle store (`001_authz.sql`–`004_device_enrollments.sql`), embedded Casbin RBAC/ABAC engine (`model.conf`), automated person/vehicle onboarding (`onboarding.go`), Ed25519 device-code enrollment (`device_enrollment.go`), and audit/outbox persistence.<br>- `internal/gateway`: OIDC/JWKS token verification, organization/admin HTTP APIs (`managed_admin.go`, `onboarding.go`, `device_enrollment.go`), fast-path 5 Hz telemetry + SQLite durable operations/tasks (`vehicle_telemetry.go`, `data_api.go`, `operations.go`), demand-gated media & LiveKit room tokens (`viewing_lease.go`, `video_session.go`, `livekit_token.go`), and Redis 12 s single-writer control leases (`control_lease.go`, `control_session.go`). |
| **`frontend/`** | Unified React + TypeScript SPA:<br>- Operations workbench (`/#/?page=fleet\|monitor\|drive\|alerts\|tasks`): fleet overview, live monitoring, WebRTC remote driving cockpit (in-memory ephemeral Ed25519 command signing), alerts, and tasks.<br>- Organization admin console (`/#/admin`): organization switcher, **车辆管理** (device-code lookup/approval & vehicle onboarding), **人员管理** (automated email invitation & cross-org member addition), and **权限管理** (role & vehicle scope assignment). |
| **`packages/teleop-shared/`** | Zero-DOM, framework-agnostic TypeScript state machines for remote control session lifecycle, gamepad/keyboard normalization and deadman gating, camera layout, and telemetry schema/freshness validation. |
| **`api/` & `docs/`** | OpenAPI (`rest.openapi.yaml`), AsyncAPI, control/telemetry JSON schemas (`api/schemas/`), and architecture/security/operations specifications (`docs/`). |
| **`infra/` & `tests/`** | Docker Compose stack (Gateway, Frontend/Caddy, LiveKit SFU, Redis, PostgreSQL, Casdoor) and cross-component contract/E2E test suites. |
| **Vehicle C++ Runtime** (`/home/wfh/01code/apollo-base`) | Production vehicle code lives in `apollo-base/data/sdk-kit` (`@sdk_kit//auth` for Ed25519 device-code bootstrap & single-flight OAuth tokens; `@sdk_kit//livekit` for isolated LiveKit worker) and `apollo-base/modules/teleop` (telemetry/data/task sync, control signature verification, and Cyber/Guardian/Canbus integration). `apps/vehicle-edge-cpp/` and `apps/vehicle-edge/` in this repo remain standalone SDK / legacy v1 references. |

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

## 3. Registration & Organization Binding Flows

### 3.1 Creating an Organization
- Executed offline via `cmd/auth-admin --input bootstrap.json --database-url-file db.dsn` while the Gateway is stopped (enforced by PostgreSQL advisory lock `7439102342056781`).
- Atomically creates the `Organization`, initial `platform_admin` `User`, `(issuer, subject)` binding, membership, and `org_admin` policy.

### 3.2 Registering & Adding People to an Organization
- **Path A — Automated Email Invitation (New Person, Primary Flow)**:
  1. Admin submits `{kind: "person", name, email, role, scope, vehicle_ids, idempotency_key}` to `POST /api/admin/organizations/{org_id}/onboarding`.
  2. Gateway reserves an immutable `planned_identity_id` in `authz_onboarding_operations` (`stage: planned -> provider -> binding -> invitation -> completed`).
  3. Background worker creates the Casdoor user, binds `(issuer, subject) -> user_id`, inserts `authz_organization_memberships(org_id, user_id)`, writes Casbin rules, and triggers Casdoor's native verification/password-setup email (`%link`).
  4. The user sets their password directly in Casdoor (Gateway never handles user passwords) and signs in via OIDC PKCE.
- **Path B — Adding an Existing User to Another Organization**:
  - Admin submits `{subject}` to `POST /api/admin/organizations/{org_id}/members` (`Store.AddExistingMember`). Gateway never merges or adopts accounts by mutable email address.

### 3.3 Registering & Binding Vehicles to an Organization
- **Path A — Vehicle-Initiated Ed25519 Device-Code Enrollment (Recommended Zero-Touch Flow)**:
  1. Vehicle runs `vehicle_bootstrap`, generates a persistent `0600` Ed25519 keypair (`/etc/teleop/device-key.pem`), and signs `POST /api/v1/device-enrollments` (`request_id`, `public_key`, `name`, `serial`, `platform`, `timestamp`, `nonce`, `signature`) to receive an 8-character `user_code` (`XXXX-XXXX`) and `device_code`.
  2. Admin selects the target organization in `/#/admin`, looks up `user_code` (`POST /api/admin/organizations/{org_id}/device-enrollments/lookup`), and approves with `{name, vehicle_number}` (`POST .../approve`).
  3. Gateway atomically binds the enrollment and `public_key` (`authz_enrolled_device_keys`) to `org_id`, generates `vehicle_id`, and provisions the Casdoor confidential client in the background.
  4. Vehicle polls `POST /api/v1/device-enrollments/token` -> receives a 5-minute key-bound `ticket` -> immediately redeems `POST /api/v1/device-enrollments/complete` -> writes `/etc/teleop/device.json` -> verifies OAuth `client_credentials` (`teleop:vehicle`) + `/api/vehicles/{vehicle_id}/device-auth-check` -> calls `POST /api/vehicles/{vehicle_id}/installation-complete` (`status = active`).
  5. **Credential Recovery**: If `/etc/teleop/device.json` is lost on the vehicle, re-running `vehicle_bootstrap` with the same `device-key.pem` automatically sets `recovery = true`; admin approval rotates the Casdoor secret under the drain guard while preserving the existing `vehicle_id` and `org_id`.
- **Path B — Admin Pre-Created Installation Ticket (Fallback Flow)**:
  - Admin creates `{kind: "vehicle", name, vehicle_number}` via `POST /api/admin/organizations/{org_id}/onboarding`, issues a 5-minute one-time bearer ticket (`POST .../installation-ticket`), and runs `infra/scripts/install-vehicle-auth.py` on the vehicle.

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

### 5.2 Stateless Multi-Instance Gateway (`apps/teleop-gateway`)

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
- Keep pure browser/input state machines in `packages/teleop-shared/`; neither frontend app imports another app's source.
- The browser holds only short-lived tokens and the ephemeral operator private key in page memory; the LiveKit API secret, Redis password, Casdoor admin credentials, and vehicle secrets must never reach the browser.
- Never merge or adopt human accounts by mutable email address; always bind verified `(issuer, subject)` to internal UUIDs.
- Do not bypass the Gateway by generating LiveKit administrative credentials in the browser or combining client, Gateway, LiveKit, and vehicle-edge responsibilities in one module.

## Sources (SSOT)
- Architecture and data flow: `docs/architecture.md`
- Managed authentication, onboarding, and device enrollment: `docs/auth-management.md`
- Primary/legacy contracts: `docs/compatibility.md`
- Requirements and security boundaries: `docs/spec.md`
- Gateway implementation: `apps/teleop-gateway/`
- Cyber/LiveKit vehicle runtime invariants: `.agents/knowledge/vehicle-cyber.md`
