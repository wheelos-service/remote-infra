# Vehicle Edge Deployment

The recommended vehicle deployment is Docker Compose. By default it publishes
one front-facing V4L2 camera. An optional Compose override publishes separate
left, center, and right camera tracks. The vehicle process only makes outbound
connections to the Gateway and LiveKit; it does not need to expose an HTTP port.

## Prerequisites

- Linux host with Docker Engine and the Compose plugin
- A camera visible as `/dev/video0` (`v4l2-ctl --list-devices`)
- Network access from the vehicle to the Gateway and LiveKit URLs
- A root-owned, mode `0600` device credential file

Install the credential file on the host:

```bash
sudo install -d -m 700 /etc/teleop
sudo install -o root -g root -m 600 config/device.example.yaml /etc/teleop/device.yaml
# Edit /etc/teleop/device.yaml with this vehicle's credentials.
```

## Start with Docker Compose

Run these commands from `apps/vehicle-edge`:

```bash
export GATEWAY_URL=https://api.example.com
export LIVEKIT_URL=wss://rtc.example.com
export VEHICLE_ID=car-001
export CAMERA_DEVICE=/dev/video0

docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml logs -f vehicle-edge
```

This default configuration publishes one track named `camera-front`.
`CAMERA_LAYOUT=off` disables camera publishing. To publish three cameras, set
the host device paths and use the three-camera Compose override:

```bash
export CAMERA_LEFT_DEVICE=/dev/video0
export CAMERA_CENTER_DEVICE=/dev/video1
export CAMERA_RIGHT_DEVICE=/dev/video2

docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.three-camera.yml \
  build
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.three-camera.yml \
  up -d
```

The override changes only the camera layout and device mappings, leaving the
shared command, volume, and build configuration in the base Compose file. It
maps cameras into the container as `/dev/video0`, `/dev/video1`, and
`/dev/video2`; they are published as `camera-left`, `camera-center`, and
`camera-right`. Set the device variables to match the host's V4L2 devices.
`--camera-width`, `--camera-height`, and `--camera-fps` apply to every camera.
If an individual camera cannot be opened or stops returning frames, the other
camera tracks continue publishing.

For a temporary IP-based deployment:

```bash
export GATEWAY_URL=http://118.145.117.118:8080
export LIVEKIT_URL=ws://118.145.117.118:7880
```

The server must actually publish those ports and allow them through its
firewall. The production setup should use HTTPS/WSS through the reverse proxy.

## Verify camera access

Before starting the container:

```bash
v4l2-ctl --list-formats-ext -d /dev/video0
docker compose -f docker/docker-compose.yml run --rm vehicle-edge --help
```

For a three-camera deployment, also inspect `/dev/video1` and `/dev/video2`.
The application requests the ACTIVE profile, reads back the resolution and FPS
accepted by each V4L2 driver, and logs the actual format before publishing.
The single-camera Compose configuration maps the selected host device to
`/dev/video0`; the three-camera override maps all three devices to those
container paths.

For a camera whose full fisheye image is not 16:9, leave the width and height
unset so the driver keeps its default mode. To select a specific supported mode,
pass the dimensions and FPS explicitly, for example:

```bash
--camera-width 1280 --camera-height 960 --camera-fps 30
```

Choose the values from `v4l2-ctl --list-formats-ext -d /dev/video0`.

### Capture full frames and publish smaller video

`--camera-width` and `--camera-height` select the hardware capture mode.
For a camera supporting only 1080p/30, capture that supported mode and use
`--video-width` and `--video-height` to reduce the published video independently:

```bash
PYTHONPATH=src python3 -m vehicle_edge.vehicle_node \
  --gateway https://api.example.com \
  --vehicle-id car-001 \
  --livekit-url wss://rtc.example.com \
  --device-config /etc/teleop/device.yaml \
  --camera-layout three \
  --camera-width 1920 --camera-height 1080 --camera-fps 30 \
  --video-width 640 --video-height 360
```

Every captured frame is scaled to fit the output without cropping or stretching;
different aspect ratios receive black padding. Both video dimensions must be
positive even numbers, or both omitted to publish at the capture size. All
cameras share these settings. The encoder bitrate is calculated from the output
size and actual capture FPS. Capture and conversion still incur the cost of the
hardware capture mode; software scaling does not recover any field of view
already cropped by that mode. `[CAMERA]` logs report capture dimensions, while
`[LIVEKIT] published` logs report output dimensions. There is no independent
output FPS option; the camera driver determines the accepted capture FPS.

### Six cameras: three front and three rear

Use `--camera-layout six` to publish all six independent tracks continuously.
The default capture indices are 0–5; override them with six distinct indices in
front-left, front-center, front-right, rear-left, rear-center, rear-right order:

```bash
--camera-layout six \
--camera-indices 0 1 2 3 4 5 \
--camera-width 1920 --camera-height 1080 --camera-fps 30 \
--video-width 640 --video-height 360
```

These are device indices, not guaranteed physical positions. Confirm each V4L2
capture device and its orientation before assigning it; some USB cameras expose
extra metadata nodes, so the usable indices may instead be 0, 2, 4, 6, 8, 10.
Custom `--camera-indices` also supports `single` (one index) and `three` (three
indices); invalid counts, duplicate indices and negative values are rejected.

Tracks are named `camera-left`, `camera-center`, `camera-right`,
`camera-rear-left`, `camera-rear-center`, `camera-rear-right`. Front track names
preserve the existing three-camera interface. All six use the same capture,
output size and FPS settings; failure of one camera does not stop the others.
The browser subscribes to all six and changes only display groups. Reverse
requests show rear immediately; stop and emergency retain the selected group.
Fresh chassis gear provides confirmation and observer view selection. The
browser's front/rear manual selector is independent of vehicle gear commands.
With no rear hardware there is no synthesized rear view: the rear slots show
missing-video messages. Real six-camera switching still requires hardware/browser
validation. Account for six simultaneous capture, encoding and upload streams.

## Operations

```bash
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs --tail=100 vehicle-edge
docker compose -f docker/docker-compose.yml restart vehicle-edge
docker compose -f docker/docker-compose.yml down
```

Do not put `client_secret` or access tokens in Compose environment variables or
command-line arguments. Keep them in the mounted credential file.

## When to use native systemd instead

For a host without Docker, run the same command in a dedicated Python virtual
environment under a systemd service. Native systemd has less overhead and
slightly simpler V4L2 permissions, but Docker Compose is easier to reproduce
and update across multiple vehicles.

## WheelOS Cyber monitoring and control (Python bindings)

The optional native Cyber target pins `wheelos_msgs = 0.1.5.bcr.1` and
`wheelos_core = 1.0.4.bcr.1` with Bzlmod. Run it in the vehicle's WheelOS
environment (same Cyber domain, network/shared-memory namespace, runtime
configuration, and permissions as Apollo). The camera-only Docker image does
not include Cyber; do not enable these flags in that image without supplying
the matching native runtime and generated messages.

The Bazel run/test targets disable user-site packages to prevent an unrelated
host protobuf installation from shadowing the pinned runtime. When launching
`bazel-bin/vehicle_node` directly, also set `PYTHONNOUSERSITE=1`.
The pinned core has a local one-line binding patch releasing the GIL during
native node close; otherwise callback teardown can deadlock. Existing native
Python environments must include this lifecycle fix as well.

From `apps/vehicle-edge`, using the existing Bazel repository/disk caches:

```bash
bazel build //:vehicle_node
bazel run //:vehicle_node -- \
  --gateway https://api.example.com \
  --vehicle-id car-001 \
  --livekit-url wss://rtc.example.com \
  --device-config /etc/teleop/device.yaml \
  --cyber
```

`--cyber` is monitoring-only: it creates no control writer. Subscribers use
`LocalizationEstimate` on `/apollo/localization/pose` and `Chassis` on
`/apollo/canbus/chassis`. Override these with `--cyber-localization-channel`
and `--cyber-chassis-channel`; override the node name with `--cyber-node-name`.
The generated message classes are imported from `wheelos_msgs`, and the native
binding from `cyber.python.cyber_py3`. An existing Python environment containing
these matching bindings and generated messages may also run
`python -m vehicle_edge.vehicle_node` with the same arguments.

Every 200 ms, the vehicle publishes a JSON DataPacket with LiveKit topic
`vehicle.state` to participants in its vehicle room using reliable delivery,
because full snapshots can exceed LiveKit's recommended 1300-byte lossy payload.
Each send still has a 150 ms timeout; snapshots are not queued by the publisher.
It contains `version: 1`,
`type: "vehicle_state"`, `vehicle_id`, `stream_id`, `sequence`, `timestamp_ms`,
`control`, and `localization` / `chassis` entries. `stream_id` changes only when
the state publisher is recreated; `sequence` increases across RTC reconnects.
Each sample contains `received_at_ms`, `age_ms`, `stale`, and `message`
(a compact protobuf JSON summary with snake_case field names).
Before the first message, `message` and timestamps are null and `stale` is true.
Samples are marked stale after one second without a callback; this describes
local receive freshness, not sensor timestamp validity. Non-finite measurements
are null, not measured zeroes; absent protobuf fields are omitted.
Position is `localization.message.pose.position` in map ENU meters, and heading
is in radians. The summary includes orientation and linear velocity; chassis
includes speed in m/s, driving mode, gear, actuator percentages, parking brake,
error codes/mask, and battery state. Trajectories, sonar arrays, and other large
diagnostic fields are not sent. Cyber callbacks only replace raw latest samples;
the 5 Hz publisher selects and converts fields on demand. State sends have a
150 ms deadline and are discarded on timeout/failure, never queued or replayed.

The browser displays position, chassis, freshness, and control publication
feedback. It accepts state only from the Gateway-assigned `vehicle-<vehicle_id>`
participant, rejects older/duplicate sequence numbers and retired streams, and
marks data stale after a second without updates, independently of video.
All vehicle-supplied values are rendered as text.

`control` contains `enabled`, `connected`, `state` (`monitoring`, `idle`,
`active`, `emergency`, or `fault`), current `session_id`,
`last_published_session_id`, `last_published_sequence`, `safety_reason`, and
`fault`. The published sequence advances only on a successful command write;
it never claims that an actuator executed that command.

Add **`--cyber-control`** to explicitly enable `ControlCommand` publication on
`/apollo/control`, or choose an arbiter's input with `--cyber-control-channel`.
Only commands accepted by the existing ControlSession signature, sender,
sequence, and age checks reach this writer. All high-level and low-level commands
pass through the same vehicle-side percentage limits. Normalized throttle and
steering multiply their configured ceilings, rather than clipping at those ceilings. Braking suppresses throttle.
Steering is negated because console negative-left corresponds to WheelOS
positive-CCW. High-level left/right retain the reported gear and request no throttle;
they no longer select DRIVE. No pad message or automatic driving-mode takeover is
generated.

### Vehicle-side control limits and guards

Motion output defaults to disabled: both throttle limits, steering limit, and speed
limit default to zero. Configure calibrated values explicitly; no default or example
percentage is a safe vehicle calibration. The CLI accepts:

| Flag | Default | Meaning |
| --- | ---: | --- |
| `--cyber-max-forward-throttle-pct` | 0 | Forward throttle ceiling, 0–100 percent |
| `--cyber-max-reverse-throttle-pct` | 0 | Reverse throttle ceiling, 0–100 percent |
| `--cyber-max-steering-pct` | 0 | Absolute steering ceiling, 0–100 percent, not degrees |
| `--cyber-stop-brake-pct` | 100 | Normal stop and shift-hold brake percentage |
| `--cyber-emergency-brake-pct` | 100 | Explicit emergency, faults, timeout, and shutdown brake percentage |
| `--cyber-max-speed-mps` | 0 | Speed threshold for rejecting motion; not closed-loop speed regulation |
| `--cyber-chassis-timeout-s` | 0.5 | Maximum age since the last local chassis callback |
| `--cyber-shift-speed-mps` | 0.05 | Maximum absolute reported speed permitting a gear request |
| `--cyber-shift-timeout-s` | 2 | Time allowed for target gear feedback |
| `--cyber-throttle-rise-pct-s` | 20 | Maximum throttle increase in percentage points per second |
| `--cyber-steering-rate-pct-s` | 80 | Maximum absolute steering change in percentage points per second |

Percentages must be finite and in range; require
`0 < stop_brake_pct <= emergency_brake_pct <= 100`. Timeouts must be positive.
Ordinary low-level brake travel scales by the normal stop percentage; an explicit
high-level `emergency_stop` uses the emergency percentage. Both braking defaults
remain 100 to preserve the former braking request until calibrated independently.

Append these flags to the existing `bazel run //:vehicle_node -- ... --cyber
--cyber-control` command using your calibrated shell variables:

```bash
--cyber-max-forward-throttle-pct "${FORWARD_THROTTLE_PCT:?set calibrated value}" \
--cyber-max-reverse-throttle-pct "${REVERSE_THROTTLE_PCT:?set calibrated value}" \
--cyber-max-steering-pct "${STEERING_PCT:?set calibrated value}" \
--cyber-stop-brake-pct "${STOP_BRAKE_PCT:?set calibrated value}" \
--cyber-emergency-brake-pct "${EMERGENCY_BRAKE_PCT:?set calibrated value}" \
--cyber-max-speed-mps "${MAX_SPEED_MPS:?set calibrated value}"
```

Motion requires fresh chassis feedback with explicitly present finite `speed_mps`,
a valid `gear_location`, and `driving_mode=COMPLETE_AUTO_DRIVE`. Reported chassis
errors, a nonzero error mask, or an engaged parking brake reject motion. At the
speed threshold further throttle is rejected; exceeding it rejects steering-only
motion too. The runtime then requests emergency braking. Partial-auto/manual modes
are intentionally not accepted, and another autonomous controller must not publish
competing commands on the actuator channel.

A direction change above the shift-speed threshold is rejected. When stopped,
the bridge requests the target gear with zero throttle, zero steering, and normal
stop braking. Repeated commands keep braking until a chassis callback newer than
the shift request confirms the target gear. Confirmation timeout, a target change
while shifting, or movement above the shift threshold rejects the request. Send a
normal stop with valid feedback before retrying a failed shift. Sending stop cancels
a pending shift. Braking retains the last observed gear rather than guessing a gear;
before any valid gear observation, even braking cannot safely form a gear command
and is rejected.

High-level `stop` and `emergency_stop` now remain distinct internally without
changing the signed packet format. A successful normal stop uses the normal brake
setting. If command input then goes quiet, the watchdog repeats normal braking
instead of reporting a movement timeout. It continues requiring fresh valid speed
and gear feedback; loss of that feedback escalates to emergency braking. Session
loss, transport loss, and publication failures still take priority and trigger
emergency braking. Motion silence still triggers the existing 300 ms watchdog.
Emergency braking can retain the last observed valid gear when chassis data is
stale and is not reduced by throttle/steering/normal-brake caps.

Additional signed `high_level` actions are `gear_park`, `gear_neutral`,
`gear_drive`, `gear_reverse`, `auto_enter`, and `auto_exit`. They use the existing
session, sender identity, timestamp, sequence and signature validation, with
canonical signing text ending in `high_level|<action>`. No new unsigned actuator
fields are accepted. Deploy the matching operator console and vehicle agent.

Explicit gear requests require fresh valid chassis feedback in
`COMPLETE_AUTO_DRIVE`, no chassis faults or parking brake, and speed at or below
`--cyber-shift-speed-mps`. The bridge requests the selected gear with zero
steering/throttle and normal braking. The normal-stop watchdog repeats that
target until a newer chassis callback confirms it, or `--cyber-shift-timeout-s`
expires and emergency braking takes over. Motion arriving before confirmation
continues braking. Normal stop cancels the explicit request; stop is required
after a shift timeout before retry, as with existing direction changes.

`auto_enter` requires fresh valid speed/gear feedback, stopped speed and no
reported chassis error code/mask; it intentionally allows manual driving mode.
It publishes the selected runtime's `ControlCommand.pad_msg.action=START`.
`auto_exit` publishes `RESET`, including during movement or feedback staleness,
provided an observed valid gear is available. Both request zero steering/throttle
and normal braking while retaining observed gear. Actions are published on the
configured control channel, using the canbus controller's embedded pad-message
interface. Subsequent watchdog braking does not repeat START/RESET. Neither
request changes the bridge's original motion guard: fresh feedback must report
`COMPLETE_AUTO_DRIVE` before motion is accepted. Publication status confirms only
middleware acceptance; use chassis `driving_mode`/`gear_location` to confirm the
vehicle transition. An old/incompatible runtime without pad actions rejects the
mode request. The existing lossy transport may require a manual request retry.

Throttle increases and steering changes are rate-limited using elapsed monotonic
time; idle gaps contribute at most 0.2 seconds of slew budget. Throttle reduction,
normal stop, emergency braking, and shift-hold braking bypass the motion rise
limiter. These are command-percentage rate limits, not measured acceleration or
steering-wheel velocity limits. These guards do not implement actuator calibration,
a speed controller, a latched physical emergency stop, or independent
Canbus-side enforcement. Chassis age measures callback freshness, not source
sensor timestamp validity. Native tests use isolated test channels; vehicle
calibration and physical braking still require separate validation.

Browser control uses the lossy `vehicle.control` topic, directed to the vehicle
identity. The receiver accepts both this topic and legacy empty-topic packets;
other topics are ignored before decoding or verification. Topic routing is not
authorization. One bounded dispatch slot replaces pending commands with the
latest arrival; verification still rejects out-of-order sequences and expired
commands. The browser also permits only one in-flight command send.

The watchdog does not publish while only monitoring or before the first accepted
remote command. Once remote control has been armed, loss of valid movement commands for
300 ms publishes zero throttle and the configured emergency brake repeatedly at
the watchdog's 50 ms interval. A successful explicit normal stop instead maintains
the configured normal brake while chassis feedback remains valid. Session expiry is checked at the same interval; Gateway polling
detects revocation at its next response (normally every second). Failed polls
invalidate the session and stop control, without waiting for the command timeout.
A successful poll does not interrupt control or reset its anti-replay sequence.
Transport loss clears the session and stops control before awaiting media/network
cleanup. An in-flight poll cannot restore a session cleared by disconnect.
Shutdown attempts a final stop before releasing Cyber resources.
Publication failure is logged and retried by the watchdog. A successful write
means middleware acceptance, **not** actuator acknowledgement or physical braking.
Do not run competing autonomy and teleop writers on the same actuator channel.
Before real-vehicle use, provide an external control arbiter, gear-change/speed
interlocks, chassis-side command timeout, physical emergency stop, and a completed
vehicle safety review. This prototype is not a certified safety controller.

The transport obtains a fresh room token from the Gateway on every connection,
using the current vehicle OAuth token, and retries with capped exponential
backoff. Each connection owns its command worker, media/state tasks, and event
handlers; disconnected handlers cannot deliver commands into a new connection.
Video and monitoring restart on reconnect without buffering old data. Browser
reconnection releases remote control; disconnect/connect explicitly to reacquire.

To exercise the real Python bindings and protobuf types without actuator
traffic, run `bazel test //:cyber_integration_test --test_output=errors`.
It uses process-specific `/teleop/test/...` channels, publishes localization and
chassis samples, receives the bridge's normalized control and emergency-stop
messages, and shuts down Cyber. Ordinary `pytest` skips this native check
unless `VEHICLE_CYBER_INTEGRATION=1` is set in a configured WheelOS environment.
Update the Python lock with
`pip-compile requirements-cyber.in --output-file=requirements-cyber.txt`.


### Proportional-gamepad simulation profile

#### Apollo-native Cyber runtime

In this Apollo checkout, `run-simulation.sh` uses `run-apollo.sh` to build against
the **local Apollo Cyber**, its Fast RTPS dependency and its generated messages.
The standalone `bazel run //:vehicle_node` target still uses WheelOS Core; do not
use that target to connect to this Apollo Dreamview runtime. Matching channel
names, `CYBER_IP` and `CYBER_DOMAIN_ID` alone does not establish compatibility
between the two middleware builds.

Run inside the managed Apollo development container as the development user:

```bash
cd /apollo/remote-infra/apps/vehicle-edge
bash run-apollo.sh probe  # read-only: requires running SimControl feedback
bash run-apollo.sh test   # isolated, non-actuator test channels
bash run-simulation.sh
```

`prepare_apollo.py` creates a source view in `.apollo-local/workspace`. Apollo
source files are referenced through symlinks; the generated MODULE selects Python
3.10 for this build and adds vehicle-edge's pinned dependencies. This rebuilds
Apollo's Python bindings for 3.10 without loading its existing Python 3.8 `.so`
files. As in Apollo's `cyber/setup.bash`, the launcher selects protobuf's pure
Python implementation so an incompatible host-built protobuf extension is not
loaded. The generated copy of the shutdown binding releases the GIL while Cyber
joins callback threads. No Apollo source files, default toolchain settings or
existing running processes are changed. Outputs, dependency caches and diagnostic
logs stay in `.apollo-local/`, which is ignored by Git. The initial build needs
the same system prerequisites as Apollo and access to its Bazel registries.
`APOLLO_ROOT_DIR` selects another local Apollo source tree;
`VEHICLE_BUILD_JOBS` sets build concurrency (default 4). The isolated integration
test checks control delivery to a separate process and the stale-feedback stop.

The Apollo entry point explicitly selects `VEHICLE_CYBER_BACKEND=apollo` and
imports `modules.common_msgs` messages. A missing import fails startup; there is
no automatic fallback to WheelOS. `[CYBER]` logs the loaded module, domain, IP and
channels. `probe` creates no control writer and requires fresh chassis and
localization feedback for a full second, including valid speed and gear. It
exits unsuccessfully when feedback is unavailable. Run `bash run-apollo.sh build`
to build the vehicle executable without starting cameras or remote connections.

The 0.5-second chassis timeout, gear checks, speed limits and emergency braking
remain active. Dreamview's Simulation Perfect Control follows planning
trajectories; this runtime change does not add `/apollo/control` actuation to
that model. Use a simulator that consumes control commands for a driving test.

`run-simulation.sh` supplies the expanded simulation ceilings: forward throttle
20%, reverse throttle 10%, absolute steering 40%, speed threshold 4 m/s. These
are twice the previous simulation ceilings. Normal brake remains 30%, emergency
brake 100%; throttle rise is 20 percentage points/s and steering change 80
percentage points/s. Production/default `CyberOptions` still have zero motion
ceilings. The speed threshold is a rejection/braking threshold, not cruise control.

Run directly inside the managed Cyber container:

```bash
cd /apollo/remote-infra/apps/vehicle-edge
./run-simulation.sh
```

The script includes the current simulation endpoints (`http://118.145.117.118:8080`
and `ws://118.145.117.118:7880`), vehicle `car-001`, and the existing development
identity `car-001|fleet-a|vehicle`. This identity is only for the current development
setup; do not put production credentials in this script. Trailing arguments can
still override defaults, for example `./run-simulation.sh --camera-layout three
--camera-indices 0 1 2`.

The script includes six cameras, 1920x1080 capture at 30 FPS and 640x360 output.
Camera indices follow the selected layout automatically: six uses 0–5, three
uses 0–2, single uses 0, and off uses no cameras. Append `--camera-layout three`,
`--camera-layout single`, or `--camera-layout off` to switch layouts. Pass custom
`--camera-indices` matching the selected layout when needed; for example,
`./run-simulation.sh --camera-layout three --camera-indices 0 2 4`.
Additional CLI arguments override the profile defaults.
Use existing development auth options only in the applicable development setup.
Only the development identity above is included; no production credentials belong in the script. At 50% effective travel, steady requests
are forward throttle 10%, reverse throttle 5%, steering magnitude 20%, reached
subject to the motion rate limits. Keyboard high-level commands still request
full configured travel; emergency remains independent of the analog magnitude.
The simulation values are not vehicle actuator calibration.


### Control debugging logs

Monitoring logs `[STATE] publisher started` on each room connection and
`[STATE] published` after the first successful data publication, then every
30 seconds. The publication line reports sequence, payload size and Cyber sample
freshness; it does not confirm browser receipt. Transport drops report exception
types, and snapshot generation failures report their exception type before
propagating to room reconnect. No state payloads or credentials are logged.
Camera open failures are independent of state publication. For simulation
without cameras, append `--camera-layout off` to `./run-simulation.sh`.

Default INFO logging prints `[CONTROL_ACCEPT]` after session/signature validation:
sequence, command mode/action, normalized steering/throttle/brake and direction.
`[CYBER_TX]` is emitted only after a successful Cyber writer call and reports the
control topic, publication sequence, gear enum number, steering/throttle/brake
percentages after scaling and rate limits. This is middleware acceptance, not
actuator acknowledgement. Steady commands log at most once per second; direction,
braking, and explicit stop/emergency transitions are logged immediately. Analog
value changes within one motion state are summarized by the next periodic line.
`[CONTROL_REJECT]` reports failed packet validation at most once per second,
including `reason`, `packet_age_ms`, `max_age_ms`, and `max_future_skew_ms`.
Reasons distinguish `no_active_session`, `session_mismatch`, `sender_mismatch`,
`session_expired_or_inactive`, `packet_too_old`, `packet_from_future`,
`sequence_not_increasing`, `invalid_command`, `invalid_signature`,
`invalid_envelope`, and `malformed_packet`. A positive packet age means the
packet timestamp is behind the vehicle clock; it includes clock offset and
transport delay, and does not alone measure network latency. A negative age
means the browser timestamp is ahead. The default maximum packet age is 3000 ms;
the future-skew limit is 100 ms. Rejected-packet metadata is diagnostic and unverified.
No packet bodies, keys, signatures or session identifiers are included.
Restart the vehicle process to enable these diagnostics;
application/state/gear errors keep their existing `[CONTROL]` error logs.
No packet contents, signatures, session identifiers or credentials are logged.
Restart the vehicle process after updating; no additional logging flag is needed.
