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
`vehicle.state` to participants in its vehicle room. It contains `version: 1`,
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
sequence, and age checks reach this writer. Normalized throttle/brake become
percentages; braking suppresses throttle. Steering is negated and scaled by
100 because console negative-left corresponds to WheelOS positive-CCW.
Forward/reverse select drive/reverse. A stop explicitly retains the most recent
fresh chassis gear, falling back to the last remote gear: Apollo's consumer reads
even an absent gear field as proto2's default neutral. If neither source is known,
an initial stop is rejected rather than guessing a gear. No pad message or
automatic driving-mode takeover is generated.

Browser control uses the lossy `vehicle.control` topic, directed to the vehicle
identity. The receiver accepts both this topic and legacy empty-topic packets;
other topics are ignored before decoding or verification. Topic routing is not
authorization. One bounded dispatch slot replaces pending commands with the
latest arrival; verification still rejects out-of-order sequences and expired
commands. The browser also permits only one in-flight command send.

The watchdog does not publish while only monitoring or before the first accepted
remote command. Once remote control has been armed, loss of valid commands for
300 ms publishes zero throttle and full brake repeatedly at the watchdog's
50 ms interval. Session expiry is checked at the same interval; Gateway polling
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
