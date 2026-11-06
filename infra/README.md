# Infrastructure

This directory contains deployment and local development assets:

- `local-dev/` contains the local Caddy, LiveKit, and Casdoor configuration
  used by the Docker Compose Demo.
- `scripts/` contains the repeatable frontend and backend build helpers.
- `frontend/` contains primary static hosting configuration. Build
  `frontend/Dockerfile` from the repository root; Compose serves the result on
  loopback port 8000, with the cloud Caddy profile proxying `CLIENT_DOMAIN`.
- `k8s/` contains staging/production Kubernetes manifests and is optional for
  the current Docker Compose Demo.

The normal Demo only requires the root `docker-compose.yml` and the
`local-dev/` assets it references. Kubernetes manifests are retained for a
later deployment target.

Only `frontend/public/runtime-config.js` (or an explicit public-only override)
is mounted as browser configuration. It must contain no credentials.
Primary commands and endpoint setup live in
[`docs/deployment.md`](../docs/deployment.md), not historical design proposals.

The frontend may instead be published to Cloudflare Pages, with one backend
host for the pilot. This is an external-hosting recommendation, not a supplied
backend-only Compose profile: the current Caddy service still depends on
`frontend` and proxies its domain. Required ingress changes, public runtime
configuration, cache rules and independent RTC media connectivity are documented
in [the static-hosting deployment guide](../docs/deployment.md#cloudflare-pages-and-a-single-backend-host).

For a managed environment, `python3 infra/scripts/deploy.py --help` provides
initial deployment, update, verification and service commands. Follow the
[deployment guide](../docs/deployment.md); keep state outside the checkout.
