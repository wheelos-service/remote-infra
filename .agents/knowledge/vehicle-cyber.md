# Vehicle Cyber, LiveKit Runtime, and Apollo Remote Driving Arbitration

## When
Read this guide before changing vehicle Cyber, real-time monitoring/control,
LiveKit transport, the vehicle's Gateway token permissions, or Apollo
`Guardian` / `Canbus` remote driving arbitration.

## 5-Module Runtime Boundaries
- Keep a single vehicle process and a single LiveKit room connection. Do not
  add a second broker, IPC layer, or module that combines network transport and
  Cyber/protobuf concerns.
- **1. Teleop Edge (`apollo-base/data/sdk-kit` (`@sdk_kit`) and `apollo-base/modules/teleop`)**:
  - `@sdk_kit//auth:vehicle_auth_sdk`, `@sdk_kit//auth:vehicle_auth_check`, and
    `@sdk_kit//auth:vehicle_bootstrap` (in `apollo-base/data/sdk-kit/auth`):
    zero-Cyber standalone authentication and device-code enrollment SDK
    providing `AuthConfig`, `HTTPClient`, thread-safe single-flight
    `SharedTokenProvider`, `AuthenticatedClient`, `auth_diagnostics`,
    `vehicle_auth_check`, and certificate-free Ed25519 `vehicle_bootstrap`.
  - `@sdk_kit//livekit:vehicle_media_worker` and `@sdk_kit//livekit:encoded_video`
    (in `apollo-base/data/sdk-kit/livekit`, consuming pure third-party
    `@livekit_sdk//:livekit_sdk` from `apollo-base/data/bazel-central-registry/modules/livekit_sdk/1.13.0`):
    - Pre-fetches the LiveKit room token (`media_token`) in the parent process
      (or accepts it inline from `/media-demand`) and passes `media_token` and
      `video_required` over `SOCK_SEQPACKET` (`FD 3`) so the isolated worker
      connects to LiveKit immediately without repeating OAuth/token HTTP RTTs.
    - Uses `poll()`-driven IPC (`MediaProcess::WaitForEvent` in parent, `poll()`
      on `FD 3` + `FD 4` in worker) for sub-millisecond control and video
      dispatch without 10 ms sleep jitter.
    - Supports **Data-Only Standby Lease** (`rtc_required=true`,
      `control_required=true`, `video_required=false`): connects the LiveKit
      DataChannel for low-latency control/standby heartbeats without publishing
      camera tracks until `video_required=true`.
    - Supports both 1-camera (`camera0`) and 3-camera
      (`camera_front`, `camera_left`, `camera_right`) layouts for both
      `simulation` and `h264_annexb` (routing Annex-B frames by
      `camera_index` `0..2` with independent per-camera IDR/GOP state).
    - Accepts both `Lossy` and `Reliable` WebRTC DataChannel packets for
      incoming `vehicle.control.v2`, while keeping `vehicle.state` and
      `vehicle.control.feedback.v2` `Reliable`.
  - `apollo-base/modules/teleop` (`common/`, `data/`, `control/`, `media/`,
    `cyber/`, `camera_gst/`, `apps/`):
    - `DataService` + `SourceService` + `DurableStore`: share a single
      `SharedTokenProvider` with `TeleopClient`/`ControlService` so telemetry
      upload, durable SQLite queue, demand polling, and control lease fetches
      never duplicate OAuth `client_credentials` token handshakes.
    - `ControlReceiver`: network & cryptographic verification (`session_id`,
      `vehicle_id`, `sender_id`, Ed25519 signature, anti-replay `seq`/`ts`,
      `revision`, and 300 ms watchdog). Returns `ACCEPTED` (never `APPLIED`).
    - `ControlService`: routes verified `ControlIntent` by `control_mode`
      (`disabled | simulation | cyber`). In `simulation`, integrates a synthetic
      setpoint and returns `APPLIED` (`simulation=true`). In `cyber`, delegates to
      `CyberAdapter` to publish `apollo::control::ControlCommand` on
      `/apollo/teleop/control` and returns `ACCEPTED` (`simulation=false`).
    - `CyberAdapter`: owns Cyber RT readers/writers and unit/sign conversion
      (`steer [-1,1]` right `+` -> `steering_target [-100,100]%` left `+`;
      `throttle/brake [0,1]` -> `[0,100]%`; gear standstill interlock). Never
      writes directly to `/apollo/control` or Canbus hardware.
- **2. Autonomous Control (`apollo-base/modules/control` + `SafetyManager`)**:
  - Owns AD trajectory tracking and internal AD health checks (`PreCheck` /
    `PostCheck` for Localization/Planning/Chassis timeouts).
  - When `chassis.driving_mode() != COMPLETE_AUTO_DRIVE` (i.e.,
    `COMPLETE_MANUAL` or `COMPLETE_REMOTE_DRIVE`),
    `ControlComponent::ResetAndProduceZeroControlCommand()` automatically resets
    `controller_agent_` (preventing PID/LQR/MPC windup) and tracks actual
    `chassis.steering_percentage()`, while `Planning` (`TrajectoryStitcher`)
    continuously replans from actual vehicle state (`x, y, v, a, heading`) every
    100 ms.
- **3. Guardian Single Command Gate (`apollo-base/modules/guardian`)**:
  - Sole multi-source arbiter before Canbus (`--receive_guardian=true`).
  - Subscribes to `/apollo/canbus/chassis`, `/apollo/control`,
    `/apollo/teleop/control`, `/apollo/planning`, and
    `/apollo/monitor/system_status`; publishes `/apollo/guardian`
    (`GuardianCommand`).
  - Maintains two orthogonal state variables:
    - `ControlSource`: `{MANUAL, AUTO, REMOTE}`
    - `SafetyOverride`: `{NONE, SOFT_STOP, HARD_ESTOP}` (`HARD_ESTOP > SOFT_STOP > NONE`)
  - Applies a 300 ms slew-rate transition filter (`ApplyTransitionFilter`) on
    `steering_target`, `throttle`, and `brake` during `AUTO <-> REMOTE`
    switches, and preserves the upstream command's `header.timestamp_sec`
    (`source_timestamp_sec`) so Canbus freshness checks remain active.
- **4. Canbus Hardware DBW Layer (`apollo-base/modules/canbus` + `VehicleController`)**:
  - Consumes `/apollo/guardian` (`GuardianCommand`).
  - `Chassis::DrivingMode` includes `COMPLETE_REMOTE_DRIVE = 5`.
  - `VehicleController` treats both `COMPLETE_AUTO_DRIVE` and
    `COMPLETE_REMOTE_DRIVE` as DBW-active (`IsDbwActiveMode`), switches
    seamlessly between `COMPLETE_AUTO_DRIVE` and `COMPLETE_REMOTE_DRIVE` without
    dropping DBW enablement, and guarantees that physical driver override
    (`MANUAL_INTERVENTION`) unconditionally returns to `COMPLETE_MANUAL`.

## Two-Stage Pre-Authorization & Arbitration State Machine
- **Stage 1 — Standby Lease (`RemoteLeaseState`: `DISCONNECTED <-> STANDBY_READY`)**:
  - Entering the cockpit pre-acquires the Gateway/Redis lease, completes
    Ed25519 challenge-response, and maintains a continuous 10-20 Hz standby
    heartbeat (`pad_msg.action = RESET`, `is_in_safe_mode = false`) on the same
    LiveKit data channel. Network/auth overhead (~200-500 ms) is paid once up
    front.
- **Stage 2 — In-Band Arbitration (`GuardianComponent`, < 20 ms)**:
  - **Any-speed Emergency Stop (`AUTO -> SafetyOverride`)**:
    - Remote `estop` (`is_in_safe_mode = true`, `pad_msg.action = STOP`)
      immediately triggers `SafetyOverride::{SOFT_STOP, HARD_ESTOP}` at any
      vehicle speed without switching `ControlSource` to `REMOTE`.
    - `ApplySafetyOverride` MUST hold `latest_chassis_.steering_percentage()`
      (never set `steering_target(0.0)`) and latches until
      `|speed_mps| <= max_stationary_speed_mps` and cleared (`RESET`).
  - **Low-speed Remote Takeover (`AUTO -> REMOTE`)**:
    - Allowed when remote sends `pad_msg.action = START` (`is_in_safe_mode = false`),
      remote command is fresh (`< 150 ms`),
      `|speed_mps| <= max_takeover_speed_mps` (default `2.0 m/s`), and
      actuator alignment holds (`|remote_steer - chassis_steer| <= 10%`,
      `remote_throttle <= 5%`).
  - **Low-speed Handback to AD (`REMOTE -> AUTO`)**:
    - Allowed without disconnecting the remote session when remote returns to
      standby (`pad_msg.action = RESET`,
      `pad_msg.driving_mode = COMPLETE_AUTO_DRIVE`), `SafetyOverride == NONE`,
      `|speed_mps| <= max_handback_speed_mps` (default `3.0 m/s`),
      `/apollo/planning` trajectory is fresh (`< 200 ms`) and non-empty, and
      `/apollo/control` command is fresh (`< 100 ms`).

## Wire and Cyber Topic Contract
- LiveKit topics:
  - `vehicle.state` / `vehicle_telemetry`: unreliable 5-10 Hz state envelope.
  - `vehicle.control` / `control`: unreliable signed v2 control packet addressed
    to `vehicle-<vehicle_id>`.
- Cyber RT topics:
  - `/apollo/canbus/chassis` (`apollo.canbus.Chassis`)
  - `/apollo/localization/pose` (`apollo.localization.LocalizationEstimate`)
  - `/apollo/monitor/system_status` (`apollo.monitor.SystemStatus`)
  - `/apollo/planning` (`apollo.planning.ADCTrajectory`)
  - `/apollo/control` (`apollo.control.ControlCommand`)
  - `/apollo/teleop/control` (`apollo.control.ControlCommand` from `vehicle-edge-cpp`)
  - `/apollo/guardian` (`apollo.guardian.GuardianCommand` from `GuardianComponent`)
  - `/apollo/mission/request` (`apollo.mission.MissionRequest`)
  - `/apollo/mission/runtime_status` (`apollo.mission.MissionRuntimeStatus`)

## Safety and Lifecycle Invariants
- `control_mode` in `apps/vehicle-edge-cpp` is `disabled | simulation | cyber`
  (default `disabled`). `simulation` never writes to Cyber; `cyber` publishes
  verified commands to `/apollo/teleop/control`.
- Missing active remote commands for `> 300 ms`, session expiry/revocation, or
  RTC loss while `ControlSource == REMOTE` immediately triggers
  `SafetyOverride::HARD_ESTOP` in `Guardian`.
- Reverse/Park/Drive gear transitions (`D <-> R`, `-> P`) are rejected unless
  `|speed_mps| <= 0.1 m/s` and `brake >= 10%`.
- In `CanbusComponent::OnGuardianCommand`, preserve the upstream command's
  `header.timestamp_sec` so `VehicleController::ControlCommandFreshnessMonitor`
  can detect stalled upstream sources.

## Validation
- Apollo Teleop, Guardian, Canbus & SDK-Kit Bazel tests (inside `apollo_dev_wfh_29599a1b`):
  `docker exec -u wfh -w /apollo apollo_dev_wfh_29599a1b bazel test --lockfile_mode=off @sdk_kit//tests/... //modules/teleop/... //modules/guardian/... //modules/canbus:canbus_test --test_output=errors`
- Apollo LiveKit media worker smoke check:
  `docker exec -u wfh -w /apollo apollo_dev_wfh_29599a1b bazel run --lockfile_mode=off //modules/teleop:vehicle_media_worker -- --sdk-smoke`
- Gateway tests: `cd apps/teleop-gateway && go test ./...`
- Frontend tests: `cd frontend && npm test`

## Sources of truth
- WheelOS SDK-Kit (`@sdk_kit`): `/home/wfh/01code/apollo-base/data/sdk-kit/`
- BCR `livekit_sdk` package: `/home/wfh/01code/apollo-base/data/bazel-central-registry/modules/livekit_sdk/1.13.0/`
- Apollo Teleop module: `/home/wfh/01code/apollo-base/modules/teleop/`
- Apollo Guardian arbiter: `/home/wfh/01code/apollo-base/modules/guardian/`
- Apollo Canbus & VehicleController: `/home/wfh/01code/apollo-base/modules/canbus/`
- Cross-component architecture: `docs/architecture.md`
- Control packet schema: `api/schemas/datachannel-control.schema.json`
