# Remote Control & Viewing Resilience Architecture

> Full stage-by-stage flowcharts and exception lookup tables for video, control,
> and feedback live in [`teleop-flows-and-exceptions.md`](teleop-flows-and-exceptions.md).
> The current browser workbench is observation-only, including simulation. The
> dual-end disconnect handling and remaining validation are in section 2.3 of
> that document; browser gating does not protect other API clients.

## Purpose

Prevent brief wireless/WebRTC jitter from forcing operators through repeated full
session tear-downs (`acquire -> release -> vehicle handover -> re-acquire`),
while preserving deterministic vehicle fail-safe guarantees.

## Core Separation Principle

Separate **physical motion safety** from **control-session ownership**:

1. **Viewing Recovery (Read-Only)**:
   - HTTP viewing leases (`POST /viewing/.../renew`) are completely decoupled
     from LiveKit `Room` connectivity.
   - During `RoomEvent.Reconnecting`, allow the LiveKit SDK up to 30 seconds.
     After a retryable `Disconnected` or SDK timeout, rebuild the `Room` inside
     a separate 15-second budget with bounded backoff and
     `POST /viewing/{id}/token`, without extending the lease. Stop on terminal
     removal or duplicate identity. Transport recovery does not prove frames;
     60 seconds without displayed track progress ends read-only viewing.
   - Surface per-camera subscription failures and recovery counts (`x/3`) rather
     than silently hiding missing streams.

2. **Control Channel Transport & Pre-Shutdown Tolerance**:
   - Send high-frequency `vehicle.control.v2` commands over **Unreliable /
     Lossy** WebRTC DataChannel (`reliable: false`), avoiding SCTP head-of-line
     blocking and stale queued command bursts after transient packet loss. Keep
     `vehicle.control.feedback.v2` and `vehicle.state` `Reliable`.
   - `RoomEvent.Reconnecting` on the control Room must **disarm** local inputs
     immediately (neutralize stick inputs and require manual re-enable) while
     preserving the control session up to `rtcReconnectGraceMs` (`1200 ms`)
     and refreshing in-flight `pendingCommands` timestamps on `Reconnected` so
     late reliable ACKs are consumed rather than misclassified as
     `unexpected_ack`.

3. **Implemented Cross-Component `PAUSED_HOLD` & Future Consolidation**:
   - Apollo `ControlReceiver` (`apollo-base/modules/teleop`) implements a
     two-stage watchdog (`300 ms -> PAUSED` requiring `throttle == 0` recovery,
     `1500 ms -> LOCKED`) paired with `5,000 ms` bounded context deadline, while
     `Guardian` (`guardian_component.cc`) enforces its `300 ms`
     `/apollo/teleop/control` timeout (`HARD_ESTOP`).
   - Behavior across `apollo-base`, `teleop-gateway`, and `frontend`:
     - **0 – 300 ms**: Packet-loss tolerance via `Lossy` DataChannel replacement.
     - **300 ms – 1500 ms (`PAUSED_HOLD`)**: `ControlReceiver` enters
       recoverable `PAUSED` and `CyberControlPublisher` refreshes 25% gentle
       service braking (`DrivingAction::START`, `is_in_safe_mode=false`) every
       200 ms without triggering `Guardian` `HARD_ESTOP` or destroying
       `session_id` / Ed25519 key binding; frontend retains the session and
       continues HTTP lease renewal.
     - **Recovery**: Once the control link (or 3 front cameras within 5 s)
       recovers, neutral/brake (`throttle == 0`) packets restore `ACCEPTED`;
       transient `<= 5 s` pauses automatically re-enable the gamepad only if
       the tab remains active/focused and the physical gamepad passes
       `GamepadInput`'s `needsNeutral` + `enableHeld` safety gate (zero motion
       until sticks are centered and enable is re-pressed).
     - **`> 1500 ms` / `> 5 s` video loss / lease loss / hardware `FAULT` / explicit exit**:
       Permanently lock/revoke the session, emit `STOP` (`Guardian HARD_ESTOP`),
       automatically release & complete `handover` confirmation (`PENDING ->
       CONFIRMED -> closed`) while keeping a persistent fault notice visible.
   - Future enhancement: consolidate workbench video and control `Room`
     lifecycles into a single authenticated Room if RBAC token separation is
     unified, and extend `PAUSED_HOLD` to longer windows (`8–15 s`) with an
     explicit 1-step `Re-Arm` if physical road tests require it.

## Resolved & Remaining Cross-Repo Status (`apollo-base` `v1` + `data/sdk-kit` `v2`)

Resolved across `apollo-base` (`v1`), `data/sdk-kit` (`v2`), and `livekit-infra`:

1. **`MediaService::PollDemand` resilience**
   (`modules/teleop/src/media/media_service.cc`): transient HTTP errors no
   longer clear `gate_` immediately via `gate_.Fail()`; existing bounded
   `authorization_.deadline` (up to 5 s) absorbs brief 1 s polling blips without
   tearing down `vehicle_media_worker` or physical camera GStreamer pipelines.
2. **Per-camera discontinuity isolation**
   (`data/sdk-kit/livekit/encoded_video.{h,cc}`,
   `modules/teleop/src/camera_gst/camera_gst_{adapter,capture}.cc`): single-camera
   errors/timeouts reset only the affected `camera_index` via
   `Discontinuity(camera_index)` instead of resetting all 3 streams.
3. **`ControlService::Poll` & `ControlReceiver` resilience + clock calibration**:
   - `ControlService::Poll` polls every `500 ms` steady (`250 ms` on transient
     HTTP errors, `100 ms` while awaiting `LOCKED` handover) and lets
     `receiver_.Tick(now)` honor the remaining `5,000 ms` context deadline
     instead of invalidating on one HTTP blip.
   - `MediaProcess::Poll` + `media_backend.cc` forward changed
     `control_feedback` immediately without waiting 50 ms, and `EncodeRTCState`
     preserves `sources["vehicle_status"]` when trimming oversized (`> 12 KB`)
     auxiliary telemetry payloads.
   - `ControlReceiver::Receive` uses a `-450 ms / +150 ms` freshness window
     paired with Gateway `server_time_ms` clock-offset calibration in
     `ControlSessionClient` so PC clock skew does not trigger `stale_command`.
4. **Neutral coasting vs `DrivingAction::RESET` separation**
   (`modules/teleop/src/cyber/cyber_adapter.cc`): while `active_takeover_` is
   true, all-zero neutral commands emit `DrivingAction::START` (holding `REMOTE`
   instead of triggering `Guardian` `kStandby` handback/`SOFT_STOP`) and keep
   `active_takeover_` armed so a subsequent `LOCKED` emits `STOP`.
5. **Canbus upstream freshness & UI arbitration visibility**:
   - `CanbusComponent::OnGuardianCommand` preserves
     `guardian_command.source_timestamp_sec()` when `safety_override == NONE`.
   - `DrivingControlPanel` parses `vehicle.state` (`vehicle_status` + `chassis`)
     to display authoritative Guardian arbitration and chassis mode.
6. **True 300 ms watchdog boundary & single-camera IDR PTS resync**:
   - `ControlService::Feedback()` / `Poll()` emit to the Cyber sink only on
     status/revision transitions (never re-stamping stale `ACCEPTED` commands),
     and `CyberControlPublisher::Publish` ignores rejected or duplicate
     `accepted_sequence` feedback so `Guardian` sees real packet stalls at
     300 ms instead of 600 ms.
   - `media_backend.cc` receives `EncodedFrame::discontinuity` across the
     IPC boundary (`encoded_video.{h,cc}`) and re-anchors `base_pts[cam]` /
     `base_time[cam]` on the recovery IDR keyframe so single-camera pipeline
     restarts do not trip the 250 ms PTS freshness check across restarts.
   - `CONTROL_TIMING.tickMs` is 50 ms (20 Hz), tolerating up to 5 consecutive
     `Lossy` drops before the 300 ms watchdog.
7. **Explicit brake-hold remote takeover (`Guardian` gate alignment) & `0–100` / `speed` mode normalization**:
   - Wire protocol `vehicle.control.v2` (`api/schemas/vehicle-control.schema.json`,
     `control-protocol.ts`, `ControlReceiver`) normalizes `steering` to
     `[-100, 100]` (`%`) and `throttle`/`brake` to `[0, 100]` (`%`), matching
     Apollo `ControlCommand` directly (`1:1`).
   - Vehicle `DeviceConfig` (`control_longitudinal_mode`: `"throttle" | "speed"`,
     `max_remote_speed_mps` default `5.0`) and frontend `teleopConfig` allow
     switching longitudinal commands between direct `throttle%` and target
     `speed` (m/s, gated by `GuardianComponent::CanEnterRemote` against
     `max_takeover_speed_mps`).
   - `CyberControlPublisher::Publish` (`modules/teleop/src/cyber/cyber_adapter.cc`)
     reserves `DrivingAction::STOP` / `is_in_safe_mode(true)` for full
     emergency stop (`brake >= 100`, `direction == 0`, `throttle == 0`), so
     partial service braking (`0 < brake < 100`) stays in `DrivingAction::START`
     with `0%` throttle.
   - `DrivingControlPanel` exposes an explicit `请求接管（制动保持）` action
     aligned to current `chassis.steering_percentage` (`throttle=0, brake=20%`),
     allowing clean entry into `CONTROL_SOURCE_REMOTE` before proportional
     gamepad driving inputs (keyboard WASD driving is removed; `Space` remains
     a global emergency brake).
8. **4-tier fault model, `503` classification & L1 video-pause brake-hold**:
   - **L0 (<300 ms / HTTP 503)**: `ControlReceiver::UpdateContext` aligns its
     bounded context horizon to **5,000 ms** (`2,000 ms` max single-request RTT)
     and `ControlService::Poll` polls every **500 ms** in steady state (`250 ms`
     on transient errors, `100 ms` while awaiting `LOCKED` handover), reducing
     Gateway hot-path pressure 5x while keeping the 300 ms DataChannel motion
     watchdog strict. `viewing-api.ts` and `control-session-client.ts` separate
     non-retryable policy/maintenance `503` responses from transient retryable `503`s;
     `ViewingLifecycle.start()` and `ControlSessionClient.acquire()` briefly
     retry transient HTTP `503` rejections, and explicit HTTP `4xx/503`
     acquire failures leave `ControlSessionClient` in `idle` (only uncertain
     timeouts `status=0` latch `locked`).
   - **L1 (0.3 s – 5 s recoverable pause)**:
     - **Video pause (`mediaPauseGraceMs = 5000`)**: When `videoReady` drops
       while `ControlSessionClient.state === 'ready'`, `DrivingControlPanel`
       immediately disables driving inputs and applies 20% service brake hold
       after the required standby ACK when an explicit Guardian `REMOTE` report
       from this session is younger than its negotiated `feedbackTimeoutMs`
       (browser monotonic receipt time). Omitted status cannot renew evidence.
       A non-REMOTE Guardian state or a reported chassis mode other than
       `COMPLETE_REMOTE_DRIVE` invalidates it until a consistent explicit
       `REMOTE` report arrives. An active emergency stop takes priority.
       Otherwise missing or expired evidence selects neutral standby. Emergency `Space` and the red brake button remain enabled
       whenever `controller.state === 'ready'`. `useDrivingCameras` preserves
       existing `<video>` tracks across `RoomEvent.Reconnecting` (only clearing
       tracks/remounting on actual `Room` rebuild). Current read-only viewing
       tracks transport and current displayed frames independently; the
       separate three-camera gate applies only to driving.
     - **Control link pause (`300 ms – 1500 ms` `PAUSED_HOLD`)**: When
       `RoomEvent.Reconnecting` fires, `ControlSessionClient` pauses outbound
       ticks up to `rtcReconnectGraceMs = 1200 ms`, while vehicle
       `ControlReceiver` enters `PAUSED` at `300 ms` (emitting `25%` gentle
       brake-hold via `CyberControlPublisher` every `200 ms` without tripping
       `Guardian` `HARD_ESTOP`) and recovers on neutral/brake (`throttle == 0`),
       before locking terminally at `1500 ms`.
     - **Real-camera & `503` resilience**: `media_backend` self-heals
       single-camera >500 ms PTS jumps via per-camera IDR resync instead of
       crashing `vehicle_media_worker`; `DemandGate` ignores duplicate-ms polls
       without dropping an unexpired lease; Gateway `ManagedRuntime` isolates
       `instanceMu` from `additiveMu` so admin writes never stall
       `/media-demand` or `/control/context`.
   - **L2 / L3**: Long outages / explicit exit automatically release + complete
     handover (`closed`) while keeping the fault banner visible; CAN/chassis/
     Monitor faults and `Space` trigger immediate `HARD_ESTOP`.
9. **Gateway SSOT `timing_policy`, adaptive `T_frame_stall`, & weak-dependency video display**:
   - Gateway `/control/acquire`, `/control/renew`, and `/control/context` emit
     a single derived `timing_policy` contract (`control_tick_ms`,
     `watchdog_pause_ms`, `watchdog_lock_ms`, `rtc_reconnect_grace_ms`,
     `media_pause_grace_ms`, `ack_budget_ms`, `feedback_timeout_ms`,
     `context_ttl_ms`) consumed with local safety clamps by both
     `ControlSessionClient` and `ControlReceiver`.
   - `camera-feed.ts` adapts `T_frame_stall` from each camera's measured
     frame-interval EMA (`clamp(ema * 6, 900, 1500)` after 3 samples) and
     emits `camera_stats` to `TeleopDiagnosticsBuffer`.
   - `ThreeCameraView.tsx` treats `<video>` visibility as a weak dependency:
     once a track renders its first frame (`hasRendered`), transient stalls
     keep the last video frame visible with a compact corner badge instead of
     blanking/hiding the slot, while `videoReady = false` continues to gate
     takeover and drive L1 brake-hold.

Remaining items before unattended/physical driving rollout:
- Real-browser validation of `capture_time_us` -> `VideoFrameCallbackMetadata.captureTime`
  (now populated in `CameraGstAdapter::SubmitSample`, see
  `video-freshness-verification.md`).
- Single-Room workbench consolidation (if RBAC token separation is unified),
  graceful normal-release exit (without `REMOTE_CMD_TIMEOUT` alert), and
  deployment enablement/bench sign-off of physical `/control/handover/ack`
  (`ControlService` already reports `StateCache`-verified ACKs for `cyber`
  vehicles when `CONTROL_HANDOVER_ACK_ENABLED=true`).

