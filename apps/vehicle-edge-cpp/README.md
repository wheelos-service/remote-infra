# C++ vehicle Auth / Teleop / Data SDKs

Read-only Apollo Cyber telemetry and explicitly enabled on-demand LiveKit media.
The Gateway remains Go and the browser remains React/TypeScript. This process
subscribes to chassis/localization, caches the latest samples, and uploads a
bounded HTTPS snapshot independently of LiveKit. By default it creates **no
camera capture, video encoder or RTC connection**. It never creates a control
writer. Optional v2 simulation control is explicitly enabled separately.

The existing Python agent remains a separate legacy media/control entry point.
It is not silently launched by this service. C++ signed reception, session
revocation and **simulated** execution/handover are implemented; no physical
vehicle adapter or physical handover policy is enabled. Optional Mission/Monitor readers require
explicitly verified topics; frame policy and live capability remain unknown
until verified.

## SDK modules and installation

The reusable C++17 SDK has separate CMake and Bazel targets. Cyber and
WheelOS protobuf dependencies remain in the native adapter/executable, not in
the SDK. Existing native `:telemetry` is an aggregate compatibility target.

| CMake target / Bazel target | Responsibility |
| --- | --- |
| `VehicleEdge::state` / `:state` | Identifiers, normalized cache, nullable samples, timestamps and JSON encoding |
| `VehicleEdge::config` / `:config` | Protected configuration and endpoint validation |
| `VehicleEdge::transport` / `:transport` | Bounded HTTPS without redirects, verified TLS |
| `VehicleEdge::auth` / `:auth` | `AuthenticatedClient`, OAuth refresh and 401 invalidation |
| `VehicleEdge::teleop` / `:teleop` | Session client, media supervisor, signed v2 receiver, watchdog and simulation service; no operations dependency |
| `VehicleEdge::data` / `:data` | Latest telemetry, Monitor health/events, SQLite inbox/outbox, typed task coordinator; Auth only |
| `VehicleEdge::runtime` / `:runtime` | Compatibility Mission runtime uploader; no Teleop dependency |
| optional `VehicleEdge::camera_gst` / `:camera_gst` | GStreamer H.264 sample conversion and explicit encoder feedback helpers; does not own capture |
| native `:cyber_adapter` | Actual WheelOS protobuf normalization; requires target Cyber build |
| optional `vehicle_media_worker` | Official LiveKit SDK, simulation or supplied H.264 AUs; no camera capture |

### Directory ownership

```text
include/vehicle_edge/       Stable public include paths; installs are split by SDK
src/common/                Config, HTTP transport, normalized state
src/auth/                  OAuth client
src/teleop/                Session client, media gate/supervisor, bounded H.264 IPC
src/data/                  Telemetry, health/events, durable tasks and service composition
src/adapters/cyber/         WheelOS conversion and typed Mission query adapter
src/adapters/camera_gst/    Optional GstSample adapter; depends on teleop
src/workers/               Isolated LiveKit backend and executable
src/apps/                  Native Cyber telemetry executable composition
cmake/                     SDK exports, install/package rules and pinned LiveKit
bazel/                     Optional target-host dependency discovery
tests/                     Boundary/RTC tests and external installed consumers
```

Public headers and exported target names remain unchanged when sources move.
The native Cyber adapter uses state/Data, never Teleop/LiveKit.

`data_client.h` now owns `TelemetryUploader`; applications that previously
included `http_client.h` for that class must change their include.
Use one `AuthenticatedClient`/`TeleopClient`/`TelemetryUploader` instance per network task,
never a shared unsynchronized token/curl handle. Auth requests accept literal
`/api/` paths only; errors/status codes remain visible. Telemetry counts only
the documented 204 as persisted, not an arbitrary 2xx.
Embedding applications using older libcurl builds without thread-safe global
initialization must call `InitializeHTTPTransport()` during process bootstrap,
before starting Cyber/GStreamer or other threads. Auth clients initialize it
idempotently, and MediaService initializes it before starting its own tasks;
it deliberately does not call global cleanup while other SDK users may exist.
OAuth/media tokens must contain only visible ASCII without whitespace or control
bytes; embedded NUL is rejected rather than being truncated by the HTTP library.

### SDK completion boundary

| Capability | Current SDK delivery |
| --- | --- |
| Device authentication and HTTP data upload | Implemented; separate Auth and optional Data packages |
| Read-only RTC state, on-demand media, H.264 input/feedback | Implemented and exercised with actual RTC on Linux x86_64 |
| Shared camera ownership and actual sensor/encoder integration | Adapter available; driver wiring and hardware qualification pending |
| C++ signed command reception, session revocation and execution feedback | Implemented for explicit v2 simulator mode; no vehicle writer |
| Physical handover and Orin/aarch64 RTC runtime | Not qualified |

Auth + Teleop now provide a testable software control loop in addition to
read-only media. This is **not a qualified physical driving controller**;
installing the packages does not establish vehicle-specific safety behavior.
Teleop requires OpenSSL >= 1.1.1 (Ed25519), in addition to the documented
libcurl/JsonCpp/optional LiveKit dependencies.

`MediaService` starts its tasks during construction when explicitly enabled.
It requires a non-null shared state cache and valid vehicle/stream identifiers.
Keep that cache updated from the owning vehicle adapter with actual units and
timestamps; missing samples remain missing, never manufactured zeros.
The low-level `(DeviceConfig, config_path, cache, stream_id)` constructor requires
the programmatic config and worker's protected file to describe the same device.
The worker rejects snapshots for another vehicle before requesting its media
token; do not hot-swap config underneath an existing service.

Use terminal, idempotent `MediaService::Stop()` before releasing the owning
component. Concurrent Stop calls are serialized. Stop closes media first and
joins both tasks; returning means input is inactive and state is OFF.
It does not restart this object, issue physical handover ACKs, or change actuators.
The destructor calls Stop as well. MediaProcess cannot be copied, preventing
duplicate ownership of child PIDs/descriptors.
Stop camera callbacks before destruction; the adapter references the service
and does not extend its lifetime. Feedback is cleared between sessions, and
external discontinuity can request a new IDR without waiting for another frame.

### Auth + Teleop standalone delivery

The delivery plan is [`.agents/teleop-sdk-plan.md`](../../.agents/teleop-sdk-plan.md).
Customers needing only teleop install two matching component archives:
`vehicle-edge-sdk-0.1.0-Linux-auth.tar.gz` and
`vehicle-edge-sdk-0.1.0-Linux-teleop.tar.gz`. The `data` archive is optional.
All retain internal modular libraries; the two-package contract does not remove
platform prerequisites or provide an already-qualified vehicle controller.

`TeleopClient` in `vehicle_edge/teleop_client.h` now owns `Demand()` and
`MediaToken()`, moved from `TelemetryUploader`. Migrate media callers to this
class; telemetry/Mission uploads remain unchanged. Auth does not grant control,
and media tokens/demand are not control authorization.

Build with `EDGE_ENABLE_LIVEKIT=ON` to include the actual media worker and its
pinned shared libraries in the teleop archive. With it OFF, the teleop archive
contains the reusable session client/supervisor only, not a runnable RTC worker.
The installed public packages are `VehicleAuthSDK`, `VehicleTeleopSDK`, and
optional `VehicleDataSDK`; `VehicleEdgeSDK` remains the full aggregate.
The Auth package also carries shared configuration/state/HTTP libraries.

Extract both archives into one empty prefix (TGZ does not install dependencies
automatically), or use `cmake --install ... --component auth` and then
`--component teleop` with the same prefix. For example, after the build below:

```bash
mkdir -p apps/vehicle-edge-cpp/build/teleop-install
tar -xzf apps/vehicle-edge-cpp/build/packages/vehicle-edge-sdk-0.1.0-Linux-auth.tar.gz \
  -C apps/vehicle-edge-cpp/build/teleop-install
tar -xzf apps/vehicle-edge-cpp/build/packages/vehicle-edge-sdk-0.1.0-Linux-teleop.tar.gz \
  -C apps/vehicle-edge-cpp/build/teleop-install
cmake -S apps/vehicle-edge-cpp/tests/teleop_consumer \
  -B apps/vehicle-edge-cpp/build/teleop-consumer \
  -DCMAKE_PREFIX_PATH="$PWD/apps/vehicle-edge-cpp/build/teleop-install"
cmake --build apps/vehicle-edge-cpp/build/teleop-consumer -j 2
ctest --test-dir apps/vehicle-edge-cpp/build/teleop-consumer --output-on-failure
```

Consumers use:

```cmake
find_package(VehicleAuthSDK 0.1 CONFIG REQUIRED)
find_package(VehicleTeleopSDK 0.1 CONFIG REQUIRED)
target_link_libraries(my_teleop_component PRIVATE VehicleEdge::teleop)
```

The repeatable delivery check is now part of CTest:

```bash
# Build the selected SDK configuration first.
ctest --test-dir apps/vehicle-edge-cpp/build -R '^sdk_delivery$' --output-on-failure
```

It generates real component TGZs, extracts only Auth + Teleop into a new prefix,
checks that Data is absent, then builds/runs an external consumer and builds the
example shipped inside the archive. Optional GStreamer targets are linked when
enabled; optional LiveKit runtime is checked from its relocated worker.
Temporary verification prefixes stay under the ignored build directory.
For CTest older than 3.20, change into the build directory and run
`ctest -R '^sdk_delivery$' --output-on-failure` instead of `--test-dir`.

### Standalone simulation example

The Teleop archive contains `share/vehicle-edge/examples/teleop`, including its
own CMake project and a disabled configuration template:

```bash
cmake -S /opt/vehicle-edge/share/vehicle-edge/examples/teleop \
  -B build/teleop-example -DCMAKE_PREFIX_PATH=/opt/vehicle-edge
cmake --build build/teleop-example -j 2
build/teleop-example/teleop_simulation --help
```

Provision a root-owned regular configuration file, mode 0600, as required by
`LoadConfig`; placeholders must be replaced through a protected editor or
secret provisioning, never command-line arguments. With permission to read it:

```bash
build/teleop-example/teleop_simulation /etc/teleop/device.json --check-config
```

That check opens no camera or network. Running without `--check-config` requires
explicitly enabled `simulation`, valid cloud endpoints and a LiveKit-enabled
SDK package; Ctrl-C/SIGTERM calls Stop. `control_mode` defaults to `disabled`;
explicit `simulation` additionally starts the simulator described below.
It never uploads operations data, emits
actuator commands, or claims synthetic video is a real vehicle camera.
An actual camera owner embeds MediaService/CameraGstAdapter instead of using
this synthetic-video executable.

### Testable v2 control loop

The public modules `control_receiver.h` and `control_service.h` are in Teleop,
not Data. `MediaService` owns the simulator service **outside** the RTC worker:
HTTP control-context polling and simulation handover survive Room shutdown.
The worker only relays bounded command envelopes over its existing supervised
socket; it has no actuator access. Invalid/overflowed IPC invalidates control.
The simulator stores a normalized setpoint, not a physics model or Cyber writer.

```text
frontend WebCrypto -> reliable vehicle.control.v2 -> LiveKit worker
  -> bounded IPC -> C++ signature/session/freshness checks -> simulated setpoint
  -> vehicle.control.feedback.v2 -> frontend
Gateway atomic Redis context -> C++ local monotonic authorization deadline
release/expiry -> local revocation -> simulation-ack -> next vehicle permitted
```

Protocol: [`datachannel-control-v2.schema.json`](../../api/schemas/datachannel-control-v2.schema.json).
It is additive; legacy v1 is never accepted by this receiver. Commands use
integer per-mille steering (-1000..1000), throttle/brake (0..1000), direction
(-1/0/1), with conflicting pedals rejected. These are **not** actuator units.
The Ed25519 signed UTF-8 bytes are exactly the compact JSON array, without
whitespace/newline:

```text
[version,type,vehicle_id,session_id,client_instance_id,receiver_instance_id,
 revision,sequence,timestamp_ms,steering,throttle,brake,direction]
```

All strings are constrained ASCII identifiers/literals and all numbers are safe
integers, avoiding JavaScript/Python/C++ floating-point string differences.
Signature/key encoding is canonical standard Base64. The receiver checks the
actual RTC participant `control-<session_id>`, not a claimed payload sender.
A random receiver instance binds signatures to this SDK process: restarting
cannot replay an old process's signed packets. The UI locks on instance changes.

`GET /api/vehicles/{id}/control/context` is device-self-only and atomically reads
the Redis lease, persistent fence revision, pending session and remaining TTL.
The SDK caps authority to 500 ms, subtracting the entire request RTT, polls every
100 ms and rejects command timestamps older than 250 ms or >100 ms in the future.
Hosts must synchronize clocks. IPC arrival age is independently capped at 250 ms.
An accepted command starts a 300 ms deadman watchdog. Expiry, HTTP failure,
worker failure or watchdog clears the simulated setpoint and latches the session
off: renewals/reconnects cannot rearm it; release and a new acquire are required.
`ControlReceiver` is single-threaded; its host must call `Tick` at least every
20 ms. `ControlService` serializes access; MediaService's host loop performs
that ticking. These are software budgets, not hard-real-time safety guarantees.

Feedback is reliable, up to 20 Hz, containing `receiver_instance_id`, session,
revision, accepted sequence, status, last rejection and simulated command.
`APPLIED` means **simulator applied**, never actuator execution or physical
handover. No `control/handover/ack` request is emitted by this implementation.

#### Run the isolated acceptance test

```bash
cmake -S apps/vehicle-edge-cpp -B apps/vehicle-edge-cpp/build -DEDGE_ENABLE_LIVEKIT=ON
cmake --build apps/vehicle-edge-cpp/build -j 2
python3 tests/control-chain.py
```

Requires Docker, frontend npm dependencies, and Go or the `golang:1.24` image.
The runner starts an isolated Gateway with the real production HTTP handlers and
Redis Lua semantics (miniredis), real loopback LiveKit, a test-only signer using
the **actual frontend protocol module**, and the production SDK supervisor/RTC
backend. Only OAuth identities and the execution endpoint are synthetic.
It checks identity/signatures, replay/tampering, watchdog/no automatic recovery,
single-operator arbitration, simulation handover and switching. Its test-only
worker loader is not installed; production protected-config loading is unchanged.
Temporary files, containers and signer processes are cleaned on exit.

#### Manual browser simulator

Use **disposable registered vehicle IDs**, with appropriate operator ACL/device
subject mapping. Never reuse a physical vehicle ID:

1. Gateway: set `SIMULATED_CONTROL_VEHICLES_JSON='["sim-car-1","sim-car-2"]'`.
   Keep `CONTROL_HANDOVER_ACK_ENABLED=false`.
2. Protected device config: set `media_enabled=true`, `camera_source=simulation`,
   `control_mode=simulation` and matching Gateway/LiveKit/worker settings.
   Run the installed `teleop_simulation` example. No Data SDK is required.
3. Frontend: set runtime `simulationControl: true`, or on localhost use
   `?dev=1&control=simulation` with the existing local endpoint settings.
   WebCrypto requires a secure context (localhost or HTTPS).
4. Open a read-only observer panel for the simulator, choose its operating target,
   request simulation control, wait for READY, hold
   the forward/reverse/turn buttons and observe increasing accepted sequence.
   Keyboard WASD/arrows and a confirmed standard gamepad mapping (LB deadman)
   also pass through the same v2 adapter. Gear/mode actions are rejected.
   Release, wait for confirmed **simulation** handover, then select another car.

The controller's separate Room does not subscribe to video a second time;
the observer panel displays it (`camera0`, `camera`, or `camera-front` map to front).
It also recognizes front/rear three-camera groups. Manual camera switching never
sends a control command; fresh directory gear only assists automatic view
selection and does not prove execution. Only the selected camera group is
attached with adaptive streaming; this is not proof of stopped upstream encoding.

The browser clears propulsion and sends simulated braking when input is released; blur/hidden,
RTC reconnect/disconnect, renewal/feedback failure or stalled signing locks off
publication. It does not silently recover or acquire a second vehicle.
Server-side arbitration remains authoritative across tabs/devices.

The standalone consumer deliberately requires no operations headers/libraries.
Encoded-frame ingestion and bounded worker IPC are implemented. Wiring the
adapter into Apollo's shared camera branch, hardware qualification,
vehicle-specific control/handover and Orin/aarch64 remain subsequent gates.

Build/install the SDK without Cyber or LiveKit:

```bash
cmake -S apps/vehicle-edge-cpp -B apps/vehicle-edge-cpp/build/portable \
  -DCMAKE_BUILD_TYPE=Release -DEDGE_ENABLE_LIVEKIT=OFF
cmake --build apps/vehicle-edge-cpp/build/portable -j 2
ctest --test-dir apps/vehicle-edge-cpp/build/portable --output-on-failure
cmake --install apps/vehicle-edge-cpp/build/portable --prefix /opt/vehicle-edge
cpack --config apps/vehicle-edge-cpp/build/portable/CPackConfig.cmake \
  -B apps/vehicle-edge-cpp/build/packages
```

Install requires permission to the prefix. CPack creates target-platform component
TGZs of libraries, public headers and relocatable CMake metadata; it never includes
device credentials. JsonCpp, libcurl, a compatible C++ runtime and threads are
host prerequisites, not vendored runtime claims. Link only needed modules:

```cmake
find_package(VehicleEdgeSDK 0.1 CONFIG REQUIRED COMPONENTS auth data)
target_link_libraries(my_vehicle_component PRIVATE VehicleEdge::data)
```

Set `CMAKE_PREFIX_PATH=/opt/vehicle-edge` in the consuming build. The independent
`tests/sdk_consumer` project verifies installation rather than using source-tree
headers or targets:

```bash
cmake -S apps/vehicle-edge-cpp/tests/sdk_consumer \
  -B apps/vehicle-edge-cpp/build/sdk-consumer -DCMAKE_PREFIX_PATH=/opt/vehicle-edge
cmake --build apps/vehicle-edge-cpp/build/sdk-consumer -j 2
ctest --test-dir apps/vehicle-edge-cpp/build/sdk-consumer --output-on-failure
```

`EDGE_ENABLE_LIVEKIT=ON` additionally packages the worker
and pinned LiveKit runtime; it currently supports x86_64, not Orin/aarch64.
To include the native executable, pass
`-DEDGE_CYBER_EXECUTABLE=/absolute/path/to/bazel-bin/vehicle_telemetry`, built
in the matching target environment. This does not bundle Cyber libraries,
protobuf resources, a system service, or hardware drivers. Installing the SDK
alone does not start a vehicle process or enable driving.

`camera_gst` integration uses a different adapter boundary: its GPU callback
is NVMM, and its existing stream branch is H.264/RTP over UDP, not Cyber Image
or a ready LiveKit input. The intended direct integration taps H.264 access
units before RTP packetization and passes them to LiveKit's
`EncodedVideoSource`, with keyframe/rate feedback returned to GStreamer.
The optional adapter and bounded IPC below implement this SDK boundary; the
Apollo driver has not been modified. Do not send RTP datagrams as encoded
frames or shut down shared autonomy camera capture when remote demand ends.

### camera_gst integration boundary

Build `-DEDGE_ENABLE_GSTREAMER=ON` to include `VehicleEdge::camera_gst` in the
Teleop package. The build host needs development packages discoverable by
`pkg-config` for `gstreamer-app-1.0` and `gstreamer-video-1.0`.
Bazel `:camera_gst` and `:camera_gst_test` are explicit/manual targets:

```bash
# In the managed native build environment, with GStreamer development packages:
bazelisk test //:camera_gst_test
```

Bazel discovers system include roots through `bazel/gstreamer_repository.bzl`;
no hardcoded x86_64/Orin GLib include directories are needed.
Consumers additionally link `VehicleEdge::camera_gst`.

The camera owner must add a **dedicated remote branch**, with caps:

```text
h264parse config-interval=-1
! video/x-h264,stream-format=byte-stream,alignment=au
! appsink name=teleop_encoded emit-signals=true max-buffers=1 drop=false sync=false
```

From that sink's `new-sample` callback, pull a sample, pass it to
`CameraGstAdapter::SubmitSample`, then unref the sample. The SDK copies at most
128 KiB and never retains GstBuffer/NVMM pointers or calls the network from
the capture callback. Stop/disconnect callbacks before destroying the adapter
or its referenced `MediaService`. This library deliberately does not install
callbacks into an existing sink or take ownership of the pipeline.

Set protected config `camera_source` to `h264_annexb`. The SDK does not open a
camera: an embedding application must feed the adapter or call
`MediaService::SubmitEncodedFrame` directly. The existing `vehicle_telemetry`
executable does not wire a camera; selecting this mode alone produces no video.
Public `MediaState::ACTIVE` means the worker/track is available, not that frames
have arrived or driving is authorized.

The initial supported contract is Annex B H.264, complete access units, no
B frames, positive monotonically increasing microsecond PTS (the Gst adapter
maps valid zero-based PTS to positive values), dimensions up to 4096x4096,
and SPS/PPS **before** IDR slices in every keyframe. The byte limit is explicit;
tune encoder bitrate/resolution if keyframes exceed it. Local structural
checks do not qualify encoder profile negotiation or sensor-to-display latency.

`FrameResult` reports acceptance, inactive session, contention, invalid input,
or waiting for a keyframe; record/counter errors in the embedding application.
The two-frame ingress queue drops its reference chain on overflow, invalid
input, stale arrival (>250 ms), contention or discontinuity, then requests IDR.
Do not silently drop encoded AUs in another queue: call
`EncodedDiscontinuity()` for any upstream encoded drop. Prefer leaking raw
frames **before** the encoder, not encoded deltas after it.

The inherited descriptor 3 carries authorization/state; descriptor 4 carries
versioned, bounded H.264 packets and reverse feedback. Neither is a public
socket. IPC is nonblocking; sequence gaps require an IDR. Stale IPC frames or
nonmonotonic/out-of-window PTS fail the worker and retry only under valid demand.
PTS maps to the worker's local monotonic clock; this does not prove source-clock
or camera freshness, which requires separate target validation.

On a non-capture management thread, consume `TakeFeedback()`. Forward keyframe
requests with `CameraGstAdapter::RequestKeyframe(sink)`. Apply bounded bitrate
targets with `SetBitrate(encoder, bps)` only for `nvv4l2h264enc`; other encoders
need explicit unit/property adapters. `framerate_fps` is returned to the owner
for supported caps renegotiation, not silently applied. Unsupported properties
and rejected events throw, rather than pretending they were accepted.
Hardware event/bitrate handling remains unqualified until an approved bench.

Only while the media session is active should the owner acquire its remote
encoding branch; release only that demand on OFF/ERROR. Existing Apollo
`StartStreaming/StopStreaming` operate on a shared branch and cannot be treated
as per-consumer reference counting. That ownership integration is still pending.

## On-demand native media

Media is disabled unless `media_enabled` is explicitly true. The optional worker
uses the actual official [LiveKit C++ SDK v1.13.0](https://github.com/livekit/client-sdk-cpp/releases/tag/v1.13.0),
tag `e7d33fd86201b288b43d7002516d52ab9b0d3641`, with the Ubuntu 22.04 x86_64 archive
pinned by SHA-256 in `cmake/LiveKitSDK.cmake`. There is no Python bridge or fake
production backend. Other architectures currently fail configuration explicitly.

To build and install the worker (CMake 3.20+, Linux x86_64):

```bash
cmake -S apps/vehicle-edge-cpp -B apps/vehicle-edge-cpp/build \
  -DCMAKE_BUILD_TYPE=Debug -DEDGE_ENABLE_LIVEKIT=ON
cmake --build apps/vehicle-edge-cpp/build -j 2
ctest --test-dir apps/vehicle-edge-cpp/build --output-on-failure
cmake --install apps/vehicle-edge-cpp/build --prefix /opt/vehicle-edge
```

Installation preserves both SDK shared libraries beside the worker with a
relative runtime library path. The native Bazel executable remains independent
of SDK ABI/dependencies and launches the installed worker. Add these fields to
the protected device config only for an isolated simulator/approved bench:

```json
{
  "media_enabled": true,
  "livekit_url": "wss://rtc.example.com",
  "media_worker_path": "/opt/vehicle-edge/bin/vehicle_media_worker",
  "camera_source": "simulation",
  "camera_track": "camera0"
}
```

The `simulation` source generates 640x480 RGBA at up to 10 fps.
The `h264_annexb` source accepts externally supplied encoded AUs through the SDK.
Neither opens, claims or stops a real camera. Raw Cyber image subscription and
real vehicle camera deployment are not yet validated; do not label synthetic
or offline encoded video as real sensor output.

The independent demand task uses the same OAuth implementation as telemetry and
authenticated `GET /api/vehicles/{vehicle_id}/media-demand`. Each task owns its
own curl handle/token state. Full request duration, including OAuth refresh, is
subtracted from the Redis TTL; deadlines use the monotonic clock and cannot
exceed 5 seconds. The gate rejects malformed/inconsistent/mismatched demand,
nonadvancing server time (cached responses), lower revisions, and retired epochs.
Equal revisions with advancing server time can renew validity. Epoch changes
invalidate the previous generation; retired epoch storage is bounded at 64 and
fails closed when exhausted. Authentication, transport and parsing errors revoke
authorization; stale validity has zero grace.

The lifecycle is `OFF -> STARTING -> ACTIVE -> STOPPING -> OFF`, with `ERROR`
and bounded retries only under valid demand. Polling, supervision and telemetry
are separate tasks. SDK connect/publish/destruction are blocking upstream APIs,
so RTC runs in an owned process, supervised every 20 ms. Stop requests graceful
cleanup then signals only that owned child; a 200 ms deadline escalates to
SIGKILL and reaps it. This bounds SDK stalls rather than leaking detached threads.
Linux parent-death signaling also prevents an orphaned blocked SDK worker if
the supervisor process itself crashes.
Shutdown waits at most the current bounded OAuth/HTTP request for the poll task.
The worker's 200 ms termination bound is not the whole Stop call's latency:
an in-flight OAuth refresh followed by the demand request can take about four
seconds under the current two-second per-request timeout.
Healthy workers unpublish their track, release generated frames/encoding and
leave the Room. Forced cancellation closes all owned process resources.

Only authorized workers request `GET /api/token/vehicle` (response `{"token":...}`)
and connect using configured `livekit_url`. They publish camera video and reliable
topic `vehicle.state` at up to 5 Hz, with envelope
`{"type":"vehicle.state","schema_version":2,"telemetry":<vehicle_telemetry snapshot>,"sources":<optional read-only sources>}`.
This intentionally differs from the legacy `origin/cyber` flat
`{"version":1,"type":"vehicle_state",...}` protocol on the same topic.
Legacy consumers must reject it; consumers need explicit read-only v2 parsing.
The nested HTTPS telemetry snapshot retains its independent `schema_version: 1`.
The snapshot comes from the same mutex-protected chassis/localization cache as
HTTPS telemetry, including independent sample ages and missing fields. This is a
read-only versioned feedback envelope, **not** legacy control readiness or a
handover acknowledgement. Gateway vehicle tokens must allow publishing data;
observer tokens must not. SDK error details are suppressed to avoid URL/token
leakage; credentials/token values travel only in protected config/HTTPS or the
worker's memory, never command-line arguments.
Feedback packets are bounded to 12 KB: oversized optional sources are omitted
with `sources_omitted: true`; oversized primary feedback is dropped without
stopping camera video or independent HTTPS telemetry.

### Verified media evidence and remaining gates

Portable CTest covers stale/equal revision handling, conservative RTT expiry,
epoch generations, malformed demand, zero demand, control-only demand, OAuth
GET/401 refresh, bounded stalled-worker cancellation, failed-worker recovery,
and telemetry/cache progress while media fails and polling blocks.
The SDK smoke test creates a real Room, VideoSource and frame without network.
The optional acceptance test requires Docker, FFmpeg with libx264, and the pinned existing
LiveKit server image in `tests/livekit_e2e.py`:

```bash
python3 apps/vehicle-edge-cpp/tests/livekit_e2e.py
```

It exercises both generated RGBA and an offline baseline H.264 AU over actual
LiveKit, checking decoded video, reliable state, encoded feedback and expiry.
No actual camera or actuator is involved.

It creates only its own loopback server/container, authenticates the real SDK
backend against an isolated test token endpoint, receives decoded video frames
and `vehicle.state` in a separate read-only Room participant, then stops demand
renewal and verifies the worker exits cleanly while the observer remains joined.
All test credentials are disposable fixtures; no vehicle or production endpoint
is used. The pinned SDK build, three portable CTests, this RTC acceptance test,
native Bazel tests and native executable build passed on Ubuntu 22.04.
This is not evidence of real camera, production network, bandwidth/CPU/GPU,
road/HIL, live Mission/Monitor topic discovery, or control/handover readiness.

## Optional read-only Mission and Monitor sources

The pinned native `wheelos_msgs` protobufs were inspected and compiled directly.
Readers for `MissionRuntimeStatus`, `MissionRequestResult` and Monitor
`SystemStatus` are created only when the protected config explicitly supplies
`mission_runtime_channel`, `mission_result_channel` and/or
`system_status_channel`. No default topic names, live capability, clock
synchronization or coordinate-frame policy are guessed. Missing readers/samples,
proto2 fields and source timestamps remain unknown; callback receipt is never
substituted for source time. This code creates **no Mission request writer,
safety writer, control writer, acknowledgement or actuator action**.

The same cache makes bounded, aged read-only source samples available in RTC
`vehicle.state.sources`. Monitor includes explicit emergency-stop/simulation
presence, finite safety trigger time and up to 16 summaries per component map
with a truncation flag; it is an observation, not an instruction. Result packets
preserve declared outcome/code/disposition and commitment presence. The public
result proto has no source timestamp, so its timestamp remains null and it
cannot manufacture a timed mission-status update.

With `mission_runtime_channel` configured, a separate task posts changed latest
Mission reports to authenticated `POST /api/vehicles/{vehicle_id}/mission-status`,
independently of telemetry, polling and media. It uses the actual runtime header
timestamp, valid mission ID and explicit state; it skips reports without those
facts. Running/failed/completed map to running/failed/succeeded; other states
remain unknown, never inferred accepted or executable. No old reports are queued.
The Gateway owns persistence, authorization and stale-report rejection.
Monitor/result samples currently have no independent Gateway persistence API;
they are cache/RTC diagnostics only, not a claim that the fleet diagnostics page
has switched from telemetry-derived health to authoritative Monitor health.
Native tests cover missing fields, invalid source time, result time unknown,
Monitor bounds and source aging. A loopback test exercises the actual Mission
upload task and device-self endpoint without vehicle credentials.

## Contract and freshness

The request implements [`vehicle-telemetry.schema.json`](../../api/schemas/vehicle-telemetry.schema.json),
not the older LiveKit `vehicle.state` protocol:

- Every process start uses a new random `stream_id`; sequence increases per
  snapshot, including failed upload attempts. No old snapshots are queued.
- Each sample has its own monotonic callback age, source timestamp and optional
  source sequence. Missing source timestamps remain unknown, not measured zero.
- Proto2 `has_*` guards preserve missing enums, booleans and numeric fields.
  NaN, infinity, unavailable battery SOC and invalid percentages become null.
- Speed remains m/s, steering remains percent, heading remains radians and
  position remains map-frame meters. No geographic projection is guessed.
- Localization measurement time is preferred when present; invalid measurement
  time is unknown, not silently replaced with a different timestamp.
- Transport errors and rejected uploads are explicitly reported without payloads,
  tokens or device credentials. A callback continuing to receive old measurements
  does not make their source timestamp fresh.

The Gateway pins an active stream and rejects another instance while it is online.
A new stream can take over only after the previous instance has been silent for
more than 10 seconds. Retired streams cannot resume. After 64 retired streams the
Gateway fails closed and requires deliberate maintenance; automatic device
instance registration/recovery is a later milestone.

## Configuration and identity

Start from [`config/device.example.json`](config/device.example.json), replace
the public endpoints and supply a registered device's OAuth client credentials.
The server must register the vehicle in `VEHICLE_REGISTRY_JSON` and map its
authenticated subject using `VEHICLE_SUBJECT_MAP_JSON`. Operator access still
requires the existing vehicle ACL.

The real config must be a root-owned regular file with mode `0600`, not a symlink.
The service needs permission to read that file; do not weaken ownership or mode
checks to run a convenience demo. Native builds/tests run as the mapped non-root
development user and do not require device credentials.

Only the config **path** is accepted as an argument:

```bash
bazel-bin/vehicle_telemetry /etc/teleop/device.json
```

No secrets belong in Git, environment variables, command-line flags, log output
or URLs. OAuth uses client credentials with `client_secret` in the HTTPS form body,
requires a finite `expires_in`, refreshes before expiry and invalidates the token
on HTTP 401. TLS verification stays enabled, redirects are not followed, and
connect/total request deadlines are 1/2 seconds. Response bodies are limited to
64 KiB. Only explicitly configured literal loopback HTTP is allowed for isolated
local tests; production endpoints must use HTTPS.

The OAuth server must issue the existing Gateway-compatible vehicle role/scope
and registered subject. This service does not invent an alternative identity
format or fall back to an anonymous/development token.

## Portable tests

Requires C++17, CMake, JsonCpp development files and libcurl development files.
This tests normalization, snapshot aging, input configuration, bounded HTTP,
OAuth refresh/error propagation and token separation without Apollo:

```bash
cmake -S apps/vehicle-edge-cpp -B apps/vehicle-edge-cpp/build \
  -DCMAKE_BUILD_TYPE=Debug -DEDGE_ENABLE_LIVEKIT=OFF
cmake --build apps/vehicle-edge-cpp/build -j 2
ctest --test-dir apps/vehicle-edge-cpp/build --output-on-failure
```

The CMake build intentionally does not produce an executable pretending to have
Cyber integration. The real executable and protobuf adapter tests use Bazel.

## Auth + Data SDK

Install the matching `auth` and `data` TGZs into one prefix, then use
`find_package(VehicleDataSDK 0.1.0 EXACT CONFIG REQUIRED)` and link
`VehicleEdge::data`. SQLite3, libcurl and JsonCpp are system prerequisites.
Neither Teleop nor LiveKit nor OpenSSL is imported by this package.
The CTest `sdk_delivery` test actually extracts both minimal package combinations,
builds their consumers, and runs durable restart tests against the installed Data SDK.

`DataService(config, cache, adapter)` composes three independent HTTP owners:
latest-wins telemetry (no disconnected backlog), latest health/static profile,
and reliable events/task reports with a SQLite inbox/outbox. Keep `cache` updated
with actual units and timestamps. Call `ObserveHealth(sample)` for **each** Monitor
observation, not a sampled UI snapshot; the native executable already does this.
This call commits local disk only, never HTTP. Keep it off real-time control
threads, surface exceptions, and retain the service until readers have stopped.
The service joins its HTTP threads on destruction; the HTTP timeout is not a
physical-control deadline.

Add these fields to the protected device config to opt into durable Data:

```json
{
  "data_store_path": "/var/lib/vehicle-data/inbox.sqlite",
  "task_mode": "disabled",
  "map_id": "verified-map-version",
  "vehicle_model": "fleet-model",
  "software_version": "vehicle-release"
}
```

The database directory must already exist, be owned by the service user, and
have mode `0700`. Database/lock files must be owned regular `0600` files.
One process owns each database; its persisted vehicle binding cannot be reused
for another vehicle. Do not copy a live SQLite database without its WAL or put
it on shared/NFS storage. Preserve the inbox/outbox and identities on restart.
`system_status_channel` must be explicitly configured to the verified Monitor
topic. Missing/unconfigured sources remain unknown; no values are fabricated.

Monitor stays the health authority. Normalization preserves summary/process/
channel/resource/other/module checks, HMI/other components, emergency-stop
requirement, source time and truncation. Fault keys are stable group/name/check
paths. Severity transitions are atomically persisted with their upload records;
explicit OK requires two seconds of observations with no gap over 2.5 seconds.
Unknown, missing, stale, future or truncated samples never recover a fault.
Recovery hysteresis restarts after process restart. Transport retries retain
the original event ID/time. Queue or disk failures are explicit, not silent drops.
Cyber transport delivery itself is not guaranteed by this SDK.

Gateway routes (all beneath `/api/vehicles/{vehicle_id}`):

| Route | Authorization and semantics |
| --- | --- |
| `POST /state` | Existing registered device-self telemetry contract |
| `POST /data/profile`, `/data/health` | Device-self latest snapshot; device publication and server receipt times remain distinct |
| `POST /data/diagnostics` | Device-self local SQLite retention/backlog counters; independent of reliable outbox delivery |
| `POST /data/events` | Device-self immutable fault transition; exact event-ID retries succeed, conflicting reuse is 409 |
| `POST /data/events/{event_id}/acknowledge` | Controller role + vehicle control ACL, body `{}`; records human acknowledgement, never vehicle recovery |
| `POST /data/tasks` | Controller role + vehicle control ACL; 202 means cloud-persisted, not vehicle accepted/executed |
| `GET /data/tasks/next` | Device-self 750 ms bounded long poll; at-least-once delivery |
| `POST /data/task-results` | Device-self ordered reports, immutable terminal result |
| `GET /data` | Observer/controller role + vehicle observe ACL; latest profile/health, last 100 events/tasks/acknowledgements |

Strict UTF-8/duplicate-key/exact-field/size/range checks apply at ingress.
The existing `/operations` response contract is unchanged. Gateway schema v1
upgrades transactionally to v2 and retains existing telemetry/alerts/Missions.
Only one Gateway may own the local SQLite store; this is not multi-replica shared storage.

Example task (replace both times with actual Unix milliseconds, TTL <= 24 h):

```json
{
  "schema_version": 1,
  "vehicle_id": "car-001",
  "request_id": "globally-unique-request-id",
  "client_epoch": "stable-cloud-producer-epoch",
  "operation": "query",
  "created_at_ms": 1800000000000,
  "expires_at_ms": 1800000060000,
  "map_id": "verified-map-version",
  "parameters": {
    "duration_ms": 0,
    "target_request_id": "original-request-id",
    "target_client_epoch": "original-producer-epoch"
  }
}
```

Reports contain exactly `request_id`, `report_sequence` (starting at 1),
`status`, `reason`, and nullable `mission_result`. Progress is
`received` (durable device inbox), `reconciling` (durable dispatch fence),
optional `unknown`, then `succeeded`/`rejected`. Expired, wrong-map, disabled or
unsupported requests are rejected before dispatch. Five seconds without an
answer reports **unknown**, never fabricated failure/completion; reconciliation
continues after restart without repeating a mutating Execute call.

Two concrete adapters are provided:

- `task_mode=simulation`: `simulate_wait` with duration 1..60000 ms and null
  query targets; cloud requires `SIMULATED_CONTROL_VEHICLES_JSON` allowlisting.
  This only waits; it never actuates a vehicle.
- `task_mode=mission_query`: native public typed Mission query only. Configure
  verified `mission_request_channel`, `mission_result_channel` and
  `mission_runtime_channel`. Fresh runtime capability inventory must explicitly
  implement contract v1/query/typed dispatcher. Successful ledger queries carry
  the target identity; lookup errors carry the query identity. Matching callback
  results are retained across unrelated messages. The original Mission outcome,
  retry/commit/terminal facts and command identities are preserved; uint64 values
  use decimal strings. SDK query `succeeded` means answered, **not motion completed**.

`TaskAdapter` is the explicit extension boundary. The shipped cloud contract does
**not** enable submit/replace/cancel/suspend/resume, arbitrary Cyber/protobuf,
safety reset or real motion. Adding those requires a versioned contract plus
approved vehicle-mode arbitration and execution adapter; authentication/media
presence/capability inventory alone never grants motion authority.

Local capacity is 10000 retained entries per table; cloud capacity is 10000 events
and 1000 tasks per vehicle. Acknowledged deduplication records are retained, not
silently pruned; reaching capacity stops new writes explicitly (cloud HTTP 507).
Archival/retention rotation is an operator procedure, not implemented automatic
deletion; these limits must be monitored before deployment.
`DurableStore::Statistics()` reads retained and pending counts without changing
deduplication identities. DataService uploads `/data/diagnostics` on its health
HTTP owner so reliable-outbox pressure remains observable. `/data` includes cloud
`capacity`, nullable device `diagnostics` and caller-specific `can_manage`.
The frontend consumes this model for Monitor health, human acknowledgement,
typed query receipt/reconciliation and 80% capacity warnings.
`GET /data/records?kind=events|tasks&after=0&through=0` offers observer-ACL-scoped,
non-destructive pages of at most 100 records with a fixed insertion high-water
cursor. Export does not reclaim capacity; see `docs/operations.md` for backup
and archival boundaries.

Native `:vehicle_data` excludes Teleop; `:vehicle_telemetry` remains the combined
entry point. `EDGE_CYBER_DATA_EXECUTABLE` optionally installs a target-built
`vehicle_data` in the Data component. The legacy `EDGE_CYBER_EXECUTABLE` installs
the combined executable in a separate `native` component that depends on all
three SDKs, rather than contaminating Auth + Data delivery.

```bash
bash tests/data-chain.sh
```

Run this from the repository root. It exercises real C++ OAuth/HTTP/services and
Go authentication/ACL/validators/SQLite, including committed-but-lost ACK retry,
Monitor raise/recovery, staged task reports and restart deduplication. No RTC,
vehicle credentials, Cyber runtime or real vehicle is needed. Native adapter
tests separately use actual generated WheelOS protobufs.

## Native Apollo build

Use the Apollo managed development container as its mapped non-root user.
Keep this directory accessible there and enter it before running:

```bash
env -u LD_LIBRARY_PATH bazelisk test --test_env=LD_LIBRARY_PATH= //:telemetry_test //:media_test //:cyber_adapter_test
env -u LD_LIBRARY_PATH bazelisk build //:vehicle_telemetry
```

The `.bazelversion` matches the inspected Apollo toolchain. Bzlmod pins WheelOS
core/messages; libcurl comes from the managed system. Reuse the configured
repository and disk caches. Do not build native Apollo targets on the host,
change the Apollo checkout, or mix shared libraries from another Bazel workspace.
The adapter test uses real generated protobuf classes but does not publish on
actuator channels.

Before deployment, verify actual Cyber discovery/domain, topic overrides, source
clock synchronization and coordinate frames against an isolated simulator or
approved bench. No such runtime readiness is implied by a successful compile.
