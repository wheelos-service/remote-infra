# Tests

## Managed authentication acceptance

```bash
python3 tests/casdoor-contract.py
python3 tests/managed-auth-chain.py
```

Requires Docker and Linux host networking, plus Go 1.24 or the `golang:1.24`
image. Both runners create uniquely named disposable services on loopback,
never use production credentials or modify the Compose deployment, and clean
their containers on exit. Docker fallback caches Go dependencies under
`.cache/managed-auth-go-cache`. The opt-in Go tests skip in ordinary unit runs.

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

Deployment configuration, saved-setting preservation, failure ordering and command
locking also run without services:

```bash
python3 -m unittest discover -s tests -p test_authentication_deployment.py
```

CI additionally generates a disposable DNS/media deployment with `deploy.py prepare`
and validates it with Docker Compose, without starting services.

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
  - `cd /apollo && bazel test --lockfile_mode=off @sdk_kit//tests/...`
  - `cd /apollo && bazel test //modules/teleop/... //modules/guardian/... //modules/canbus:canbus_test`

The former `data-chain.sh`, `control-chain.py`, `driving-ui.py`, Python vehicle
security/QoS and chaos runners were removed with the vehicle source. Vehicle
media/control acceptance must use the matching `apollo-base` checkout.
`TestControlChainServer` remains a disposable Gateway fixture for external
runners: set `CONTROL_CHAIN_FIXTURE` to an output JSON path, run that Go test,
then create `<path>.stop` before its 90-second deadline. It is skipped in normal
unit runs and does not itself validate a vehicle or browser.

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
