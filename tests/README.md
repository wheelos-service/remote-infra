# Tests

## Managed authentication acceptance

```bash
python3 tests/casdoor-contract.py
python3 tests/managed-auth-chain.py
```

Requires Docker and Linux host networking, plus Go 1.24 or the `golang:1.24`
image. Both runners create uniquely named disposable services on loopback,
never use production credentials or modify the Compose deployment, and clean
their containers on exit. Docker fallback caches Go dependencies under the
ignored C++ build directory. The opt-in Go tests skip in ordinary unit runs.

The Casdoor runner pins `casbin/casdoor:v4.25.0`. It verifies management
credentials in Basic headers (not URLs), person/application creation and
reconciliation, actual public-client S256 PKCE, incorrect verifier/code replay,
independent vehicle client credentials, scope/secret rejection and rotation.
Actual provider JWTs pass through the production Gateway JWKS verifier and
PostgreSQL subject binding/role enforcement. It uses disposable SQLite for
Casdoor and PostgreSQL for Gateway; it does not migrate Casdoor's deployed DB.
The same runner starts actual Gateway HTTP onboarding routes, configures
Casdoor's native Email provider against a loopback SMTP sink, consumes the
invitation verification code, completes native account recovery with browser
cookie continuity from the actual delivered setup link and performs a new
email/password public S256 PKCE login. It verifies default no-vehicle authority,
later explicit selected authorization, generated organization/number/random
vehicle IDs and idempotent submissions without stopping a live
RTC reader. The actual Python installer redeems a one-time ticket, saves a
mode-0600 configuration, obtains OAuth credentials and verifies identity/
vehicle mapping before reporting completion. Explicit recovery rotates a
previously delivered secret; ticket replay is rejected.
It does not prove production email delivery, camera/actuation readiness, or
an existing deployment using another version.

Installer rejection and filesystem checks can also run without services:

```bash
python3 -m unittest discover -s tests -p test_vehicle_auth_installer.py
```

The RTC runner pins `livekit/livekit-server:v1.13.11`. It verifies a real
WebSocket upgrade/join, server-issued reconnect-token signature/expiry,
maintenance rejection for old and refreshed tokens, actual RoomService drain,
and PostgreSQL quiet state across runtime reconstruction. It waits the actual
**11-minute interval**, without advancing a test clock. Allow about 15 minutes
plus cold dependency downloads. It verifies signaling/authorization, not
camera media, physical control, or an external production proxy topology.

## C++ Data SDK chain

```bash
bash tests/data-chain.sh
```

Requires CMake/C++17, SQLite3/JsonCpp/libcurl development dependencies and Go 1.24
or Docker (`golang:1.24`), Node and installed `frontend` dependencies.
`DATA_CHAIN_GO_CACHE` selects an existing writable Go
cache; `DATA_SDK_BUILD_DIR` selects the C++ build directory. This uses actual C++
DataService/OAuth/HTTP and Gateway authentication, ACL, validators and SQLite,
not mock HTTP responses: device profile/telemetry, Monitor health and durable
raise/recovery events, lost ACK after server commit, staged task reports and
process restart deduplication. Actual C++ diagnostics and actual Gateway HTTP
responses/export pages also pass through the frontend strict parsers.
Only vehicle observations, credentials and the
wait-only executor are synthetic. Owned test files and servers are cleaned.

`ctest --test-dir apps/vehicle-edge-cpp/build --output-on-failure` also verifies
SQLite restart/capacity/conflicts/unknown reconciliation, and actual Auth + Data
archive extraction/linking without Teleop/LiveKit. Native
`//:cyber_adapter_test` verifies typed queries against generated WheelOS protos;
`//:vehicle_data` is the Data-only Cyber entry point. This does not qualify real
motion, map readiness, physical handover or hardware.

## C++ SDK and controller simulation chain

```bash
cmake -S apps/vehicle-edge-cpp -B apps/vehicle-edge-cpp/build -DEDGE_ENABLE_LIVEKIT=ON
cmake --build apps/vehicle-edge-cpp/build -j 2
ctest --test-dir apps/vehicle-edge-cpp/build --output-on-failure
python3 tests/control-chain.py
```

Requires Docker, frontend npm dependencies, and Go or `golang:1.24`.
`CONTROL_CHAIN_GO_CACHE` selects an existing writable Go cache for Docker;
otherwise it uses the ignored C++ build directory. This is a **simulator-only**
acceptance test, not a physical vehicle test.

The chain uses real Gateway HTTP handlers and Redis Lua semantics (miniredis),
actual shared input conversion and frontend WebCrypto signing, real loopback LiveKit, production C++
supervision/IPC/verifier and a simulated execution endpoint. It covers session
identity, normalized forward/turn/reverse/stop conversion, cross-language signature validation, tamper/replay rejection,
watchdog/no automatic rearm, operator singleton, simulated handover and switching.
Only fixture identities and execution are synthetic. Test-only worker config
loading is not shipped. All owned temporary services/files are cleaned on exit.

`cd frontend && npm test` additionally covers controller cancellation, stalled
requests/publication, receiver changes and feedback expiry, input capability
gates, gamepad-to-v2 conversion and camera group/pending-intent semantics. Manual browser
steps and the v2 signature contract are in
[`apps/vehicle-edge-cpp/README.md`](../apps/vehicle-edge-cpp/README.md#testable-v2-control-loop).

The tests are grouped by scope:

- `e2e_control_session_receiver.py` and `e2e_secure_receiver.py` are focused
  security and control-session checks.
- `e2e_qos_test.py` exercises LiveKit command delivery under simulated network
  loss and delay.
- `chaos_network.sh` is an optional manual network-chaos experiment; it is not
  required for the normal Demo startup.

The component unit tests remain next to their implementations under
`apps/teleop-gateway/internal/gateway/` and `apps/vehicle-edge/tests/`.

The shared input/view modules and their listener cleanup are tested in their
own package:
`npm ci --prefix packages/teleop-shared && npm --prefix packages/teleop-shared test`.
Install it before the frontend or legacy console. Legacy UI/protocol integration
tests remain under `apps/operator-console` (`npm test`); they are not a second
copy of the shared state-machine tests. For Python
reference tests use an environment with `apps/vehicle-edge/docker/requirements.txt`
and pytest installed, then run from repository root:

```bash
PYTHONPATH=apps/vehicle-edge/src python3 -m pytest -q apps/vehicle-edge/tests
```

The native Cyber test is opt-in and skipped without its runtime. Camera tests
use synthetic OpenCV images, not physical camera hardware. No production service,
vehicle endpoint or actuator is used by these automated merge regressions.

## Platform mock contracts

Run from the repository root, with frontend dependencies already installed:

```bash
python3 -m venv /tmp/remote-infra-contract-venv
/tmp/remote-infra-contract-venv/bin/pip install -r tests/platform-contract-requirements.txt
PLATFORM_PYTHON=/tmp/remote-infra-contract-venv/bin/python bash tests/platform-contract.sh
```

Requires Go 1.24 or Docker (`golang:1.24`), Node, frontend dependencies and a
Python Draft 2020-12 JSON Schema validator. `PLATFORM_PYTHON` selects an isolated
interpreter; it defaults to `python3`. Docker users may set
`PLATFORM_GO_CACHE_DIR` to an existing writable directory to reuse Go caches.
No live Gateway, Redis, LiveKit, vehicle credentials or real vehicle is needed.

Synthetic device packets exercise the actual Gateway HTTP middleware, payload
validation, Redis-compatible test server and SQLite store. Actual response JSON
is then passed through frontend Zod parsers and freshness/history assertions,
followed by published JSON Schema validation. Temporary JSON is removed on exit.
This tests data contracts, not rendered-browser behavior or physical safety.

The 16 HTTP scenarios cover no data, driving/parking/reverse, error occurrence,
missing/stale samples not resolving errors, future clocks, explicit recovery,
all six Mission statuses, offline retained values and stream restart/history
gaps. Wrong-device/tenant and malformed input rejection are also checked.
The same runner validates 20 frontend snapshots across ten explicit preview
scenarios. Existing Gateway and frontend suites additionally exercise duplicate/
out-of-order packets, SQL partial-failure recovery, viewing expiry/cancellation,
independent Rooms and pending-handover fences.
