# Vehicle Cyber and LiveKit Runtime

## When
Read this guide before changing vehicle Cyber, real-time monitoring/control,
LiveKit transport, or the vehicle's Gateway token permissions.

## Runtime boundaries
- Keep a single vehicle process and a single LiveKit room connection. Do not
  add a second broker, IPC layer, or module that combines network transport and
  Cyber/protobuf concerns.
- `apps/vehicle-edge/src/vehicle_edge/vehicle_node.py` owns configuration,
  credentials, component wiring, and shutdown.
- `cyber_bridge.py` owns typed Cyber subscriptions, raw latest-sample caching,
  and `ControlCommand` field/unit mapping. It must not import or call LiveKit.
- `state_publisher.py` owns the 5 Hz compact state envelope and bounded sends.
  It reads the latest Cyber samples; do not JSON-encode every Cyber callback or
  queue stale state for retransmission.
- `livekit_transport.py` owns one RTC connection, room-token refresh on
  reconnect, topic routing, bounded command dispatch, and lossy DataChannel
  sends. It must not import protobuf or map vehicle fields.
- `control_session_receiver.py` owns session, sender, signature, expiry,
  replay, command-age, safety-watchdog, and command-publication feedback logic.

## Wire and access contract
- Vehicle state is published every 200 ms on LiveKit topic `vehicle.state`,
  unreliable, as a compact JSON `vehicle_state` envelope with vehicle ID,
  publisher stream ID, monotonic sequence, timestamp, control status, and
  localization/chassis values plus per-sample receive age/staleness.
- Control uses the unreliable `vehicle.control` topic, addressed to the
  `vehicle-<vehicle_id>` identity. Accept that topic and the legacy empty topic
  only. A bounded single pending slot favors the newest packet; signed sequence
  and timestamp validation remains authoritative. Never treat a topic as
  authorization.
- The browser accepts monitoring only from the expected vehicle identity,
  rejects malformed, duplicate/reordered, or retired-stream samples, marks
  missing data stale, and renders remote values as text.
- Vehicle LiveKit tokens may publish data for monitoring in their own room.
  Observer tokens must not publish data; controller data remains authorized by
  the Gateway control lease and independently verified by the vehicle.
- Keep compatibility with the current version-1 signed control payload unless
  the browser, vehicle, schema, tests, and rollout are updated together.

## Safety and lifecycle invariants
- Cyber monitoring is opt-in with `--cyber`; it must not create a control
  writer. Remote actuation is separately opt-in with `--cyber-control`.
- Do not enable the Cyber watchdog while idle in monitoring mode. Once an
  accepted remote command arms control, missing commands for 300 ms, session
  expiry/revocation, RTC loss, or command-publication failure must invoke the
  safety path. An invalid or failed Gateway session refresh fails closed.
- A disconnect must stop control before asynchronous connection cleanup. An
  in-flight session refresh must not restore a session invalidated by that
  disconnect. On reconnect obtain a fresh LiveKit token; do not replay queued
  commands. The browser releases its lease on RTC reconnect and requires
  explicit reacquisition.
- A successful Cyber `write` means middleware accepted the protobuf, not that
  the ECU applied it. Never present it as actuator acknowledgement. Keep
  command scaling, steering direction, throttle/brake priority, and known-gear
  hold behavior covered by tests. Production vehicles still require an external
  autonomy/teleop arbiter, gear/speed interlocks, chassis-side timeout, and a
  physical emergency stop.
- Use `wheelos_msgs` `0.1.5.bcr.1` and `wheelos_core` `1.0.4.bcr.1` from
  `apps/vehicle-edge/MODULE.bazel`. Preserve the local node-close GIL-release
  patch: callback teardown can deadlock without it. Use the Bazel-provided
  protobuf and Cyber runtime; do not let host user-site packages shadow them.

## Validation
- Vehicle unit tests: `pytest apps/vehicle-edge/tests`
- Native Cyber pub/sub and protobuf integration: from `apps/vehicle-edge`,
  `bazel test //:cyber_integration_test --test_output=errors`
- Native vehicle build: from `apps/vehicle-edge`, `bazel build //:vehicle_node`
- Operator protocol, state display, and console wiring: from
  `apps/operator-console`, `npm test`
- Gateway: `cd apps/teleop-gateway && go test ./...`

## Sources of truth
- Runtime and deployment usage: `apps/vehicle-edge/README.md`
- Cross-component architecture: `docs/architecture.md`
- Control packet schema: `api/schemas/datachannel-control.schema.json`
- Vehicle transport, Cyber mapping, state shaping, and session safety:
  `apps/vehicle-edge/src/vehicle_edge/`
