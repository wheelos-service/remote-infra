# Codex Implementation Spec

## WheelOS Remote Supervision & Teleoperation

**Status:** Implementation Specification
**Target:** Production-oriented remote supervision foundation
**Identity Provider:** Casdoor
**Realtime Transport:** LiveKit
**Runtime State:** Redis
**Vehicle Safety Boundary:** Vehicle-side SafetyManager + Watchdog

---

# 1. Objective

Refactor the existing remote supervision system into a production-oriented architecture supporting:

* authenticated operators;
* authenticated vehicles;
* vehicle-level authorization;
* multiple observers per vehicle;
* exactly one active controller per vehicle;
* secure control sessions;
* Ed25519 command authentication;
* replay protection;
* vehicle-side watchdog;
* on-demand video streaming;
* low-bandwidth standby video;
* dynamic video activation;
* auditability.

The implementation MUST preserve the existing LiveKit-based realtime transport.

Do NOT introduce a second WebSocket control channel.

---

# 2. Final Architecture

```text
                         ┌──────────────────┐
                         │     Casdoor      │
                         │                  │
                         │ OIDC / OAuth2     │
                         │ JWKS             │
                         └────────┬─────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
                 ▼                                 ▼
        Operator Web UI                     Vehicle Node
        OIDC + PKCE                        Client Credentials
                 │                                 │
                 │ JWT                             │ JWT
                 └────────────────┬────────────────┘
                                  ▼
                       ┌─────────────────────┐
                       │   Teleop Gateway    │
                       │---------------------│
                       │ JWT/JWKS            │
                       │ Vehicle ACL         │
                       │ Control Lease       │
                       │ Control Session     │
                       │ Video Session       │
                       │ LiveKit Token       │
                       │ Audit               │
                       └──────────┬──────────┘
                                  │
                             Redis / DB
                                  │
                                  ▼
                              LiveKit
                                  │
                     ┌────────────┴────────────┐
                     │                         │
                 Operator                  Vehicle
                     │                         │
               Video / Data               Video / Data
                                               │
                                        Ed25519 Verify
                                               │
                                          SafetyManager
                                               │
                                              ECU
```

---

# 3. Security Model

The system MUST separate four security layers.

```text
Layer 1: Identity
    Casdoor

Layer 2: Authorization
    Gateway Vehicle ACL

Layer 3: Control Ownership
    Redis Control Lease

Layer 4: Vehicle Safety
    Ed25519 + replay protection + watchdog + SafetyManager
```

Casdoor proves:

```text
WHO
```

Gateway ACL determines:

```text
WHICH VEHICLE
```

Control Lease determines:

```text
WHO CURRENTLY CONTROLS
```

Vehicle SafetyManager determines:

```text
WHETHER THE COMMAND IS SAFE TO EXECUTE
```

Casdoor MUST NOT be treated as the realtime control authorization mechanism.

---

# 4. Identity Architecture

## 4.1 Human Operator

Use:

```text
OIDC Authorization Code + PKCE
```

Recommended identity providers behind Casdoor:

```text
Feishu
Enterprise WeChat
Other enterprise IdP
```

Authentication flow:

```text
Browser
  ↓
Casdoor
  ↓
Enterprise Identity Provider
  ↓
Authorization Code
  ↓
PKCE
  ↓
Web UI
  ↓
Access Token
  ↓
Gateway
```

The operator private/session credentials MUST NOT be stored in URLs.

Do not persist access tokens in `localStorage`.

Prefer in-memory token storage.

---

# 5. Human Authorization

JWT claims may contain coarse-grained information:

```json
{
  "sub": "operator-001",
  "role": "operator",
  "tenant": "tenant-a",
  "fleet": ["fleet-a"],
  "scope": [
    "teleop:observe",
    "teleop:control"
  ]
}
```

Do NOT rely exclusively on fleet claims for vehicle authorization.

Final authorization MUST be performed by Gateway:

```text
JWT
 ↓
operator_id
 ↓
tenant
 ↓
vehicle_id
 ↓
Vehicle ACL
 ↓
permission
```

Example:

```text
operator-001
    fleet-a
        vehicle-001: observe + control
        vehicle-002: observe
        vehicle-003: no access
```

Vehicle ACL MUST be checked for every privileged API operation.

---

# 6. Vehicle Identity

Vehicle authentication uses:

```text
OAuth 2.0 Client Credentials
```

Flow:

```text
vehicle_node.py
      |
      | client_id + client_secret
      v
   Casdoor
      |
      | access_token
      v
vehicle_node.py
      |
      v
Teleop Gateway
```

Each vehicle MUST have an independent credential.

Correct:

```text
vehicle-001 -> credential-A
vehicle-002 -> credential-B
vehicle-003 -> credential-C
```

Incorrect:

```text
fleet-a -> shared credential
```

Compromise of one vehicle credential MUST NOT automatically authenticate another vehicle.

---

# 7. Vehicle Credential Storage

Development:

```text
/etc/teleop/device.yaml
```

Minimum permissions:

```text
0600
root:root
```

The secret MUST NOT appear in:

```text
Git
Docker image
logs
journalctl
crash dumps
debug output
URLs
command-line arguments
```

If hardware-backed secure storage is available, design the credential provider so it can later support:

```text
TPM
Secure Element
Hardware Key Store
```

Do not make TPM mandatory for Phase 1.

---

# 8. Vehicle Token Lifetime

Vehicle access tokens MUST be short-lived.

Target:

```text
15-30 minutes
```

The exact TTL MUST be configurable and verified against the deployed Casdoor version.

Vehicle MUST proactively refresh the token before expiry.

Example:

```text
Token TTL = 30 min

refresh around:
    20-25 min
```

Do not use multi-day access tokens.

---

# 9. Token Refresh Failure

If Casdoor becomes temporarily unavailable:

```text
Existing valid session
        |
        v
Continue according to current session policy
```

Do NOT immediately trigger an emergency stop solely because Casdoor is unavailable.

However:

```text
No valid token
+
Need to create new privileged session
        |
        v
Reject
```

Existing control safety remains governed by:

```text
ControlSession
Control Lease
Watchdog
Vehicle SafetyManager
```

Casdoor MUST NOT become a hard realtime dependency.

---

# 10. Gateway JWT Verification

Gateway MUST validate JWT locally.

Required checks:

```text
signature
iss
aud
exp
sub
tenant
scope
```

Use Casdoor JWKS.

JWKS SHOULD be cached in memory.

Do NOT call Casdoor on every API request.

Architecture:

```text
Casdoor
   |
   | JWKS
   v
Gateway JWKS Cache
   |
   v
Local JWT verification
```

---

# 11. JWKS Key Rotation

Gateway MUST support key rotation.

Normal:

```text
JWT
 ↓
cached JWKS
 ↓
verify
```

If JWT contains an unknown `kid`:

```text
unknown kid
    ↓
refresh JWKS
    ↓
retry verification
```

Gateway MUST NOT permanently pin a single public key.

---

# 12. JWT Revocation Semantics

JWT validation is NOT realtime revocation.

When an operator/vehicle is disabled in Casdoor:

```text
Disable identity/client
        ↓
Prevent new token issuance
        ↓
Existing short-lived token expires
        ↓
New privileged session rejected
```

Do NOT implement:

```text
Casdoor unavailable
    =>
all existing RTC sessions immediately terminate
```

Session-level revocation remains the responsibility of Gateway.

---

# 13. LiveKit

LiveKit remains the only realtime transport.

Use LiveKit for:

```text
video
control DataChannel
realtime signaling where appropriate
```

Do NOT add:

```text
WebSocket control channel
MQTT control channel
second RTC system
```

unless explicitly required in a future architecture revision.

---

# 14. LiveKit Room

Use one room per vehicle:

```text
teleop-<vehicle_id>
```

Examples:

```text
teleop-vehicle-001
teleop-vehicle-002
```

Gateway MUST generate the room name.

Clients MUST NOT be allowed to arbitrarily select rooms.

---

# 15. LiveKit Token Permissions

## Observer

```text
canSubscribe = true
canPublish = false
canPublishData = false
```

## Controller

```text
canSubscribe = true
canPublish = false
canPublishData = true
```

## Vehicle

Vehicle token MUST only contain capabilities required by the existing implementation:

```text
publish video
subscribe control data
```

Exact SDK fields MUST follow the currently installed LiveKit SDK.

---

# 16. Control Lease

Redis is the source of truth for active controller ownership.

Key:

```text
control:{vehicle_id}
```

Value:

```json
{
  "vehicle_id": "vehicle-001",
  "operator_id": "operator-001",
  "session_id": "uuid",
  "public_key": "base64",
  "created_at": 1754870000,
  "expires_at": 1754870005
}
```

Acquire MUST be atomic:

```text
SET key value NX EX <ttl>
```

Only one controller can own a vehicle.

---

# 17. Control Lease API

## Acquire

```http
POST /api/vehicles/{vehicle_id}/control/acquire
```

Required steps:

```text
1. Authenticate JWT
2. Validate tenant
3. Validate Vehicle ACL
4. Require teleop:control
5. Create session_id
6. Register controller public key
7. Atomically acquire Redis lease
8. Create ControlSession
9. Generate controller LiveKit token
10. Activate video
11. Return session information
```

If already controlled:

```http
409 Conflict
```

Response reason:

```text
CONTROL_BUSY
```

Never silently replace an existing controller.

---

# 18. Control Lease Renewal

```http
POST /api/control/{session_id}/renew
```

Must validate:

```text
operator_id
vehicle_id
session_id
session status
```

Renew Redis TTL.

Recommended:

```text
renew_interval = lease_ttl / 2
```

All timing values MUST be configurable.

---

# 19. Control Release

```http
POST /api/control/{session_id}/release
```

Only the owner can release.

State:

```text
ACTIVE -> RELEASED
```

Redis lease MUST be removed atomically.

---

# 20. ControlSession

Replace any existing:

```text
latest public key
```

design.

Use:

```python
ControlSession(
    session_id,
    vehicle_id,
    operator_id,
    public_key,
    status,
    created_at,
    expires_at
)
```

States:

```text
ACTIVE
RELEASED
EXPIRED
REVOKED
```

A command is valid only when:

```text
ControlSession exists
AND status == ACTIVE
AND vehicle_id matches
AND session_id matches
AND operator identity matches
```

---

# 21. Ed25519 Command Authentication

Keep the existing Ed25519 design.

Operator private key:

```text
browser memory only
```

Never store it in:

```text
localStorage
server
database
URL
logs
```

Public key is associated with the ControlSession.

---

# 22. Control Packet

Use a versioned packet:

```json
{
  "version": 1,
  "type": "control",
  "session_id": "session-uuid",
  "sequence": 12345,
  "timestamp_ms": 1754870000123,
  "command": {
    "steering": 0.12,
    "throttle": 0.08,
    "brake": 0.0
  },
  "signature": "base64"
}
```

Signature MUST cover:

```text
version
type
session_id
sequence
timestamp_ms
command
```

Do NOT sign only the command payload.

---

# 23. Vehicle Command Validation

Validation order:

```text
1. Schema
2. session_id
3. vehicle identity
4. ControlSession state
5. timestamp
6. sequence
7. Ed25519 signature
8. command range
9. command rate
10. vehicle state
11. SafetyManager
12. execute
```

Any failure MUST result in:

```text
REJECT
```

Never partially execute an invalid command.

---

# 24. Replay Protection

Maintain:

```text
last_sequence
```

per ControlSession.

Accept:

```text
sequence > last_sequence
```

Reject:

```text
sequence <= last_sequence
```

A new ControlSession starts a new sequence context.

Packets from expired/released sessions MUST remain invalid.

---

# 25. Timestamp Validation

Use configurable:

```text
max_command_age_ms
max_future_skew_ms
```

Reject commands outside the allowed time window.

Codex MUST NOT invent final production safety thresholds.

---

# 26. Vehicle Safety Boundary

The final execution path MUST be:

```text
LiveKit DataChannel
        |
        v
RemoteControlReceiver
        |
        v
CommandVerifier
        |
        v
SafetyManager
        |
        v
Vehicle Control Interface
        |
        v
CAN / ECU
```

Remote control MUST NOT bypass:

```text
SafetyManager
vehicle mode validation
range validation
rate limits
```

---

# 27. Vehicle Watchdog

The vehicle MUST have an independent watchdog.

```text
REMOTE_CONTROL
      |
      | no valid command
      v
REMOTE_CONTROL_LOST
      |
      v
SAFE_STOP / MIN_RISK
```

The watchdog MUST continue working if:

```text
Gateway crashes
Redis crashes
Casdoor is unavailable
LiveKit disconnects
operator browser crashes
network disconnects
```

The watchdog MUST NOT depend on Casdoor.

---

# 28. Controller / Observer Model

A vehicle may have:

```text
observer-A
observer-B
observer-C
controller-A
```

Example:

```text
vehicle-001
├── observer-A
├── observer-B
├── observer-C
└── controller-A
```

Multiple observers are allowed.

Exactly one controller is allowed.

---

# 29. Controller Takeover

Do NOT implement automatic takeover in the initial version.

If another operator requests control:

```text
existing controller
    +
new controller request
        |
        v
409 CONTROL_BUSY
```

Future supervisor takeover may be implemented separately with:

```text
teleop:supervise
explicit reason
audit
old session revocation
```

---

# 30. Video Architecture

Video MUST NOT continuously stream high bitrate after vehicle boot.

Use:

```text
VIDEO_OFF
VIDEO_STANDBY
VIDEO_ACTIVE
```

Normal vehicle online state:

```text
VIDEO_STANDBY
```

---

# 31. Video Modes

## STANDBY

Initial engineering target:

```text
resolution: 360p
fps: 1
bitrate: 50-150 kbps
```

Purpose:

```text
fleet overview
low-bandwidth monitoring
```

All parameters MUST be configurable.

If periodic JPEG/snapshot is more efficient with the current camera stack, it is acceptable.

---

## ACTIVE

Initial target:

```text
720p
15-30 fps
1-3 Mbps
```

Purpose:

```text
remote supervision
remote control
incident monitoring
```

Actual encoder behavior MUST be verified on the target hardware.

---

# 32. VideoSession

Implement:

```python
VideoSession(
    vehicle_id,
    session_id,
    mode,
    viewer_count,
    controller_session_id,
    created_at,
    expires_at
)
```

Modes:

```text
STANDBY
ACTIVE
```

ControlSession and VideoSession MUST remain separate.

---

# 33. Video Activation

Video becomes ACTIVE when:

```text
authorized viewer requests video
OR
controller acquires control
OR
configured safety/incident event requests video
```

Mandatory invariant:

```text
ControlSession ACTIVE
        =>
VideoSession ACTIVE
```

---

# 34. Video Release

When an observer leaves:

```text
viewer_count -= 1
```

Do NOT immediately stop ACTIVE video.

Use configurable grace period.

Recommended initial:

```text
30-60 seconds
```

If another viewer joins during the grace period:

```text
remain ACTIVE
```

Otherwise:

```text
ACTIVE -> STANDBY
```

---

# 35. Video State Machine

```text
             viewer/control request
                     |
                     v
              +-------------+
              |   STANDBY   |
              +------+------+
                     |
                     v
              +-------------+
              |    ACTIVE   |
              +------+------+
                     |
             no viewers/controller
                     |
                grace timer
                     |
                     v
              +-------------+
              |   STANDBY   |
              +-------------+
```

Do not destroy/recreate the camera hardware unnecessarily.

Prefer reconfiguration when supported.

---

# 36. Video Start Signaling

Do NOT use raw LiveKit `participant_connected` as the only authorization mechanism.

Correct flow:

```text
Operator
   |
   v
Gateway
   |
   v
VideoSession
   |
   v
Vehicle
   |
   v
VideoStateManager
```

LiveKit may carry the realtime signaling message if appropriate.

Do not introduce a second control transport.

---

# 37. Video Failure

If video cannot start:

```text
VideoSession ACTIVE
        |
        v
VIDEO_ERROR
```

Generate audit event:

```text
video_start_failed
video_publish_failed
video_disconnected
video_recovered
```

If video is mandatory for remote control under configured safety policy:

```text
video unavailable
      |
      v
control session invalidation / safe state
```

The exact safety behavior MUST be configurable and validated against vehicle requirements.

---

# 38. Control / Video Interaction

Mandatory:

```text
Control ACTIVE => Video ACTIVE
```

Controller acquisition:

```text
Control acquire
      |
      +--> ControlSession ACTIVE
      |
      +--> Video ACTIVE
```

Controller release:

```text
Control release
      |
      +--> ControlSession RELEASED
      |
      +--> Video remains ACTIVE if observers exist
      |
      +--> otherwise grace timer
```

---

# 39. API

Implement or adapt the existing API to provide:

```http
GET  /api/auth/me

GET  /api/vehicles
GET  /api/vehicles/{vehicle_id}

POST /api/vehicles/{vehicle_id}/livekit-token

POST /api/vehicles/{vehicle_id}/control/acquire
POST /api/control/{session_id}/renew
POST /api/control/{session_id}/release
GET  /api/vehicles/{vehicle_id}/control

POST /api/vehicles/{vehicle_id}/video/acquire
POST /api/video/{session_id}/release
GET  /api/vehicles/{vehicle_id}/video
```

Existing API naming conventions may be preserved if equivalent semantics are maintained.

---

# 40. LiveKit Token Generation

Only Gateway may hold:

```text
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
```

Clients MUST never receive the API secret.

Token identity should be traceable:

```text
operator:<operator_id>:<session_id>
vehicle:<vehicle_id>
```

Room MUST be:

```text
teleop-<vehicle_id>
```

---

# 41. Token Lifetime

Recommended initial values:

```text
Observer:    15-30 min
Controller:  10-15 min
Vehicle:     30-60 min
```

All values MUST be configurable.

Token renewal MUST be supported.

---

# 42. Audit

Record at minimum:

```text
login
vehicle_access
control_acquire
control_busy
control_renew
control_release
control_expire
control_revoke

video_acquire
video_release
video_start
video_stop
video_mode_change
video_error

command_rejected
emergency_stop
vehicle_disconnect
watchdog_timeout
```

Audit record:

```json
{
  "timestamp": "...",
  "operator_id": "...",
  "vehicle_id": "...",
  "control_session_id": "...",
  "video_session_id": "...",
  "event": "...",
  "reason": "...",
  "result": "..."
}
```

Do NOT store every high-frequency control packet as a persistent audit event in Phase 1.

---

# 43. Redis

Redis is used for short-lived runtime state.

Examples:

```text
control:{vehicle_id}
control_session:{session_id}
video_session:{vehicle_id}
```

Redis MUST NOT become the vehicle's final safety authority.

Persistent data belongs in a database.

---

# 44. Failure Isolation

## Casdoor failure

```text
Casdoor DOWN
      |
      +--> existing valid JWT may continue
      |
      +--> new authentication fails
      |
      +--> new privileged session fails
      |
      +--> vehicle watchdog remains independent
```

## Gateway failure

```text
Gateway DOWN
      |
      +--> existing RTC behavior follows session/watchdog policy
      |
      +--> no new control session
      |
      +--> vehicle safety remains local
```

## Redis failure

```text
Redis DOWN
      |
      +--> do not create new controller lease
      |
      +--> existing vehicle safety remains local
```

## LiveKit failure

```text
LiveKit DOWN
      |
      +--> control packets stop
      |
      +--> watchdog detects timeout
      |
      +--> vehicle enters configured safe state
```

---

# 45. Security Invariants

Codex MUST preserve these invariants:

```text
1. One vehicle has at most one active controller.

2. Multiple observers are allowed.

3. Observer cannot send control commands.

4. Controller must have teleop:control permission.

5. Vehicle ACL is checked before control acquisition.

6. LiveKit does not determine control authorization.

7. Casdoor does not determine realtime control ownership.

8. Control Lease determines current controller.

9. Every control command belongs to a ControlSession.

10. Every command is authenticated with Ed25519.

11. Replay commands are rejected.

12. Expired sessions cannot control vehicles.

13. Vehicle performs final command validation.

14. Watchdog is independent of cloud services.

15. Control ACTIVE implies Video ACTIVE.

16. Normal vehicle operation does not continuously send high-bitrate video.

17. LiveKit secrets never reach clients.

18. Vehicle credentials are unique per vehicle.

19. JWT verification is performed locally using cached JWKS.

20. Casdoor outage must not directly become a vehicle safety dependency.
```

---

# 46. Repository Structure

Adapt to the existing repository rather than forcing unnecessary restructuring.

Preferred conceptual structure:

```text
gateway/
├── auth/
│   ├── casdoor/
│   ├── jwt/
│   └── jwks/
├── acl/
├── control/
│   ├── lease/
│   ├── session/
│   └── service/
├── video/
│   ├── session/
│   └── service/
├── livekit/
└── audit/

vehicle/
├── auth/
├── control/
│   ├── receiver/
│   ├── verifier/
│   └── session/
├── safety/
├── video/
│   ├── manager/
│   ├── encoder/
│   └── publisher/
└── livekit/
```

Do not perform unrelated repository-wide refactoring.

---

# 47. Implementation Phases

## Phase 1 — Casdoor Integration

Implement:

```text
Casdoor OIDC
Casdoor Client Credentials
JWT validation
JWKS cache
```

Tests:

```text
valid JWT
expired JWT
invalid signature
invalid issuer
invalid audience
unknown kid + JWKS refresh
```

---

## Phase 2 — Vehicle ACL

Implement:

```text
tenant
fleet
vehicle ACL
```

Tests:

```text
authorized vehicle
unauthorized vehicle
wrong tenant
observer permission
controller permission
```

---

## Phase 3 — Control Lease

Implement:

```text
Redis lease
acquire
renew
release
expiry
```

Tests:

```text
A acquire -> success
B acquire -> 409
A renew -> success
A release -> success
B acquire -> success
lease expiry -> available
```

---

## Phase 4 — ControlSession

Implement:

```text
session_id
operator_id
vehicle_id
public_key
status
expiry
```

Replace existing latest-public-key behavior.

---

## Phase 5 — Secure Vehicle Control

Implement:

```text
Ed25519
sequence
timestamp
session validation
command validation
watchdog
```

Tests:

```text
valid command
invalid signature
replay
expired session
invalid timestamp
invalid command range
watchdog timeout
```

---

## Phase 6 — VideoSession

Implement:

```text
VIDEO_STANDBY
VIDEO_ACTIVE
VideoSession
viewer count
grace period
```

---

## Phase 7 — Dynamic Video

Implement:

```text
viewer -> ACTIVE
controller -> ACTIVE
last viewer -> grace
grace expiry -> STANDBY
```

Test actual camera/encoder behavior on target vehicle hardware.

---

## Phase 8 — Control/Video Integration

Guarantee:

```text
Control ACTIVE
       =>
Video ACTIVE
```

Test:

```text
controller + observer
controller release + observer
controller release + no observer
video failure during control
```

---

## Phase 9 — Audit

Implement audit events and structured logging.

---

## Phase 10 — Production Security

Implement:

```text
HTTPS
WSS
credential protection
short-lived tokens
JWKS rotation
security headers
rate limiting
```

---

## Phase 11 — Future Device Security

Not required for Phase 1, but architecture MUST allow:

```text
mTLS
device certificate
TPM
Secure Element
certificate rotation
```

Do not implement unless explicitly requested.

---

# 48. Required Tests

## Authentication

```text
[ ] OIDC login
[ ] PKCE
[ ] valid JWT
[ ] expired JWT
[ ] invalid JWT
[ ] invalid issuer
[ ] invalid audience
[ ] JWKS refresh
```

## Vehicle Authentication

```text
[ ] valid client credentials
[ ] invalid client secret
[ ] disabled vehicle credential
[ ] expired vehicle token
[ ] token refresh
```

## Authorization

```text
[ ] tenant isolation
[ ] fleet isolation
[ ] vehicle ACL
[ ] observer permission
[ ] controller permission
```

## Control

```text
[ ] single controller
[ ] multiple observers
[ ] control conflict
[ ] lease renewal
[ ] lease expiry
[ ] release
[ ] session expiry
[ ] session revoke
[ ] invalid signature
[ ] replay protection
[ ] timestamp validation
```

## Video

```text
[ ] standby
[ ] active
[ ] viewer join
[ ] viewer leave
[ ] grace period
[ ] new viewer during grace
[ ] controller acquisition
[ ] controller release
[ ] video reconnect
[ ] encoder failure
```

## Safety

```text
[ ] LiveKit disconnect
[ ] Gateway disconnect
[ ] Redis disconnect
[ ] Casdoor disconnect
[ ] command timeout
[ ] invalid command
[ ] vehicle state restriction
[ ] watchdog
```

---

# 49. Definition of Done

The implementation is complete only when:

```text
[ ] Casdoor OIDC works for operators
[ ] Casdoor Client Credentials works for vehicles
[ ] Gateway validates JWT locally
[ ] JWKS is cached and supports rotation
[ ] Vehicle credentials are unique
[ ] Vehicle ACL is enforced
[ ] Multiple observers can watch one vehicle
[ ] Exactly one controller can control one vehicle
[ ] Control ownership uses Redis lease
[ ] ControlSession replaces latest-public-key logic
[ ] Ed25519 verification works
[ ] Replay protection works
[ ] Timestamp validation works
[ ] Vehicle command validation works
[ ] Independent watchdog works
[ ] Video has STANDBY and ACTIVE modes
[ ] High-bitrate video is not continuously streamed
[ ] Viewer can activate video
[ ] Controller acquisition activates video
[ ] Grace period works
[ ] Control ACTIVE implies Video ACTIVE
[ ] Audit events are generated
[ ] LiveKit remains the realtime transport
[ ] LiveKit API secret never reaches clients
[ ] Casdoor outage does not directly become vehicle safety dependency
[ ] Existing functionality remains operational
[ ] Unit tests pass
[ ] Integration tests pass
```

---

# 50. Non-Goals

Do NOT implement:

```text
OTA
cloud video recording
video storage
file transfer
AI analytics
automatic controller takeover
complex RBAC
new WebSocket control channel
MQTT control channel
new RTC infrastructure
TPM integration
full PKI infrastructure
```

These belong to future phases.

---

# 51. Final Decision

The implementation MUST use:

```text
Human:
Casdoor
OIDC Authorization Code + PKCE

Vehicle:
Casdoor
OAuth 2.0 Client Credentials

Gateway:
JWT + JWKS
Vehicle ACL
Redis Control Lease
ControlSession
VideoSession
Audit

Realtime:
LiveKit

Command security:
Ed25519
Sequence
Timestamp
Replay protection

Vehicle safety:
SafetyManager
Watchdog
Local command limits

Video:
STANDBY
ACTIVE
On-demand activation
Grace period
```

Final security chain:

```text
Human:

Casdoor
   ↓
OIDC / PKCE
   ↓
JWT
   ↓
Gateway
   ↓
Vehicle ACL
   ↓
Control Lease
   ↓
ControlSession
   ↓
Ed25519
   ↓
Vehicle SafetyManager
   ↓
ECU
```

Vehicle:

```text
Vehicle
   ↓
Client Credentials
   ↓
Casdoor
   ↓
Short-lived JWT
   ↓
Gateway
   ↓
Vehicle identity
   ↓
LiveKit
```

Video:

```text
Vehicle
   ↓
STANDBY
   ↓
Authorized Viewer
   ↓
Gateway VideoSession
   ↓
ACTIVE
   ↓
LiveKit
   ↓
Operator
```

The most important architectural invariant is:

```text
Casdoor answers:
    "Who are you?"

Gateway ACL answers:
    "Can you access this vehicle?"

Control Lease answers:
    "Are you the current controller?"

Ed25519 answers:
    "Did this command come from this session?"

SafetyManager answers:
    "Is this command safe to execute?"

Watchdog answers:
    "What happens if control disappears?"
```

No single component MUST be trusted to answer all five questions.
