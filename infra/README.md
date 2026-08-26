# Infrastructure

This directory contains deployment and local development assets:

- `local-dev/` contains the local Caddy, LiveKit, and Casdoor configuration
  used by the Docker Compose Demo.
- `scripts/` contains the repeatable frontend and backend build helpers.
- `k8s/` contains staging/production Kubernetes manifests and is optional for
  the current Docker Compose Demo.

The normal Demo only requires the root `docker-compose.yml` and the
`local-dev/` assets it references. Kubernetes manifests are retained for a
later deployment target.
