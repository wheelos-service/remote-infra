# livekit-infra

LiveKit remote vehicle supervision prototype with three runtime boundaries:

```text
frontend/               Unified authenticated React operations platform
apps/teleop-gateway/    Go Gateway
apps/vehicle-edge-cpp/  C++ vehicle SDKs (simulation control only)
infra/                  Compose, Kubernetes, and LiveKit configuration
```

`packages/teleop-shared/` owns the pure input/gamepad/camera state machines.
`apps/operator-console/` and `apps/vehicle-edge/` remain legacy v1 references,
not dependencies of the primary frontend. See [compatibility boundaries](docs/compatibility.md).

## Quick Start

For a domain-free LAN deployment, follow the short [setup guide](docs/setup.md).
With Docker Compose v2 and Python 3 installed, run from this directory using
the deployment machine's LAN IP:

```bash
python3 infra/scripts/deploy.py --lan-ip 192.168.1.50 all
```

Trust the generated CA certificate on each client, then open
`https://192.168.1.50:8443` from the host or another LAN computer.

The default entry is the unified authenticated operations platform. Use
`/#/?page=monitor` for viewing and `/#/?page=drive` for the three-camera
workbench; it requires a configured Gateway and a publishing C++ simulator.
Mock preview is available only through explicit `?preview=1` outside the hash.
See [`frontend/README.md`](frontend/README.md) for runtime configuration and
explicit simulation-control enablement.

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
