# livekit-infra

LiveKit remote vehicle supervision prototype with three runtime boundaries:

```text
apps/operator-console/  browser operator console
apps/teleop-gateway/    Go Gateway
apps/vehicle-edge/      vehicle-side agent
infra/                  Compose, Kubernetes, and LiveKit configuration
```

## Quick Start

```bash
cp .env.example .env
docker compose config
docker compose up -d --build redis livekit-config livekit teleop-backend
cd apps/operator-console && npm run build && python3 -m http.server 8000 --directory dist
```

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
