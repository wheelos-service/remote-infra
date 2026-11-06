# livekit-infra

LiveKit remote vehicle supervision prototype with three runtime boundaries:

```text
frontend/               Unified authenticated React operations platform
apps/teleop-gateway/    Go Gateway
infra/                  Compose, Kubernetes, and LiveKit configuration
```

`packages/teleop-shared/` owns the pure input/gamepad/camera state machines.
`apps/operator-console/` remains a legacy v1 reference, independent of the primary
frontend. Vehicle SDKs and deployment now live in `apollo-base/data/sdk-kit` and
`apollo-base/modules/teleop`. See [vehicle deployment](docs/deployment.md#vehicle-deployment)
and [compatibility boundaries](docs/compatibility.md).

## Quick Start

For managed accounts, vehicle enrollment and repeatable server updates, use the
[deployment script and guide](docs/deployment.md). Host settings are supplied once
and saved in a private state directory outside the checkout.

```bash
cp .env.example .env
docker compose config
docker compose up -d --build redis livekit-config livekit teleop-backend
docker compose up -d --build frontend
# Open http://127.0.0.1:8000/#/ (authenticated operations).
```

The default entry is the unified authenticated operations platform. Use
`/#/?page=monitor` for viewing and `/#/?page=drive` for the three-camera
workbench; it requires a configured Gateway and a publishing C++ simulator.
Mock preview is available only through explicit `?preview=1` outside the hash.
See [`frontend/README.md`](frontend/README.md) for runtime configuration and
explicit simulation-control enablement. Compose binds the frontend to loopback;
the cloud Caddy profile serves it at `CLIENT_DOMAIN`.

Documentation:

- [`docs/spec.md`](docs/spec.md): authoritative architecture and security requirements.
- [`docs/local-dev.md`](docs/local-dev.md): local Gateway, browser, and vehicle setup.
- [`docs/operations.md`](docs/operations.md): runtime configuration and secret boundaries.
- [`docs/deployment.md`](docs/deployment.md): Docker Compose deployment, DNS, Caddy, and network ports.
- [`docs/architecture.md`](docs/architecture.md): module boundaries and data flow.
- [`docs/auth-management.md`](docs/auth-management.md): opt-in organization,
  people, vehicle and permission management pilot; manual IdP provisioning
  and safe rollout boundaries.

The current implementation covers OIDC/JWKS authentication, vehicle ACLs, Redis
control leases, ControlSession signing, VideoSession standby/active orchestration,
vehicle token refresh, LiveKit transport, and audit logging. Production safety
actuators and hardware validation remain future work. Do not use this prototype
to control a real vehicle without a completed safety review.

Kubernetes manifests are retained for a later deployment phase. The current
deployment target is Docker Compose.
