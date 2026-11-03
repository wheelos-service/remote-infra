# livekit-infra

LiveKit remote vehicle supervision prototype with three runtime boundaries:

```text
frontend/               React operator platform (Mock home; authorized /#/teleop)
apps/teleop-gateway/    Go Gateway
apps/vehicle-edge-cpp/  C++ vehicle SDKs (simulation control only)
infra/                  Compose, Kubernetes, and LiveKit configuration
```

`packages/teleop-shared/` owns the pure input/gamepad/camera state machines.
`apps/operator-console/` and `apps/vehicle-edge/` remain legacy v1 references,
not dependencies of the primary frontend. See [compatibility boundaries](docs/compatibility.md).

## Quick Start

```bash
cp .env.example .env
docker compose config
docker compose up -d --build redis livekit-config livekit teleop-backend
docker compose up -d --build frontend
# Open http://127.0.0.1:8000/ (Mock) or /#/teleop (authorized RTC).
```

The default home is an isolated Mock. `/#/teleop` is the authorized three-camera
entry; it requires a configured Gateway and a publishing C++ simulator.
See [`frontend/README.md`](frontend/README.md) for runtime configuration and
explicit simulation-control enablement. Compose binds the frontend to loopback;
the cloud Caddy profile serves it at `CLIENT_DOMAIN`.

Documentation:

- [`docs/spec.md`](docs/spec.md): authoritative architecture and security requirements.
- [`docs/local-dev.md`](docs/local-dev.md): local Gateway, browser, and vehicle setup.
- [`docs/operations.md`](docs/operations.md): runtime configuration and secret boundaries.
- [`docs/deployment.md`](docs/deployment.md): Docker Compose deployment, DNS, Caddy, and network ports.
- [`docs/architecture.md`](docs/architecture.md): module boundaries and data flow.

The current implementation covers OIDC/JWKS authentication, vehicle ACLs, Redis
control leases, ControlSession signing, VideoSession standby/active orchestration,
vehicle token refresh, LiveKit transport, and audit logging. Production safety
actuators and hardware validation remain future work. Do not use this prototype
to control a real vehicle without a completed safety review.

Kubernetes manifests are retained for a later deployment phase. The current
deployment target is Docker Compose.
