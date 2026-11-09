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
It additionally exercises signed device-code registration, manager lookup and
approval, actual per-device OAuth provisioning, key-bound credential redemption
and lost-response retry, exact Gateway vehicle matching and installation
confirmation. PostgreSQL Gateway tests cover replay/expiry/denial, code refresh
without rebinding, cross-organization rejection and rejection of device-bound
tickets at the bearer-only installer.
It does not prove production email delivery, camera/actuation readiness, or
an existing deployment using another version.

The real Apollo C++ bootstrap can also exercise the Gateway wire contract:

```bash
cd apps/teleop-gateway
AUTHZ_POSTGRES_TEST_DSN='<disposable PostgreSQL DSN>' \
VEHICLE_BOOTSTRAP_TEST_BINARY='/absolute/path/to/vehicle_bootstrap' \
go test ./internal/gateway -run 'TestPostgresVehicleBootstrap(Client|DenialAndExpiry)$' -count=1 -v
```

Run this in an isolated root test container with Go 1.24, a compatible bootstrap
binary and disposable PostgreSQL. It creates protected temporary configuration
and state directories, approves registration, verifies credential persistence
and installation acknowledgment, then checks OAuth outages, wrong vehicle mapping,
same-identity `invalid_client` recovery, denied restarts, server-simulated expiry
and graceful cancellation without readiness. OAuth responses are synthetic here.
Never supply a production database DSN.

For the continuous real-C++/real-Casdoor chain, run from the repository root:

```bash
VEHICLE_BOOTSTRAP_TEST_BINARY='/absolute/path/to/vehicle_bootstrap' \
python3 tests/casdoor-contract.py
```

This opt-in uses an isolated root Go container and a host-compatible Linux
x86-64 bootstrap binary; it does not require running the host command as root.
It validates actual OAuth `teleop:vehicle` grants and Gateway JWT/JWKS enforcement,
discards the first successful credential response and installation acknowledgment,
restarts the vehicle client, and finishes administrator-approved same-vehicle
credential recovery. Recovery is rejected outside safely drained maintenance,
the old secret cannot obtain a new grant, and credential/state permissions remain
`0600`. It waits the actual **eleven-minute** Gateway quiet window without
advancing a test clock; allow about fifteen minutes plus cold downloads.
Only the disposable fixture's initially issued browser/device tokens are extended
to thirty minutes for that wait. The ordinary Casdoor invocation above remains supported without the C++
binary. No teleop process, systemd unit, existing service or real vehicle is started.

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

## Component unit tests

- Gateway unit tests: `cd apps/teleop-gateway && go test ./...`
- Shared state-machine tests: `npm --prefix packages/teleop-shared test`
- Frontend unit tests: `cd frontend && npm test`
- Vehicle C++ SDK & Apollo Teleop tests live in `apollo-base`:
  - `cd /apollo/data/sdk-kit && bazel test //...`
  - `cd /apollo && bazel test //modules/teleop/... //modules/guardian/... //modules/canbus:canbus_test`

With a shared `AUTHZ_POSTGRES_TEST_DSN`, use `go test -p 1 ./...` or separate
databases per package: the managed Gateway instance lock is database-wide,
so isolated schemas alone do not isolate simultaneous package fixtures.
`TestPostgresDeviceEnrollmentConcurrentFleet` exercises 100 simulated devices
sharing a loopback source, simultaneous same-request retries, pending progress,
and per-device poll throttling using actual Ed25519 proofs and PostgreSQL.
This is not a production fleet-size or cellular-network performance claim.

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
