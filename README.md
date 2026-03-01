# livekit-infra

This repository contains infrastructure and helper services to run a LiveKit-based
teleoperation (remote takeover) stack. It includes LiveKit configuration, a small
teleoperation backend for token issuance and webhook handling, a Caddy gateway, and
optional services like Casdoor for identity management.

Quick start & high-level layout are detailed in `docs/README.md` — the sections
below summarize startup steps, SLOs and runbook highlights.

## Deployment (Kubernetes-first)

This repository is organized for Kubernetes-based production deployments. The
preferred path is to apply the manifests under `deploy/k8s/` which provide
Deployments, Services, ConfigMaps and recommended probes/limits for each
component.

Quick steps (local testing with kubectl / kind):

```bash
# apply all manifests (namespace-scoped as needed)
kubectl apply -f deploy/k8s/

# check pods
kubectl get pods -A

# forward teleop-backend for local testing
kubectl port-forward deploy/teleop-backend 8080:8080
```

For convenience there are still `tests/e2e_qos_test.sh` and `tests/e2e_qos_test.py`
which perform local E2E checks using LiveKit and `tc` network emulation. These
are intended for CI verification and developer smoke-tests; prefer ephemeral
Kubernetes test clusters (`kind`, `k3d`) for integration testing that better
match production networking.

## SLO (examples)

- Control path P99 latency (operator input -> vehicle actuation): < 150ms
- Control path availability: >= 99.9%
- Reconnect success (same-network): > 99% within 5s

## Runbook highlights

- On vehicle disconnect: mark `lost`, notify operators, trigger emergency stop
  via redundant safety channel (e.g. MQTT -> CAN-bus bridge).
- On signature verification failure: reject commands, place vehicle in safe mode,
  rotate keys and investigate.

## Repo layout (recommended)

- `deploy/k8s/` — Kubernetes manifests (production)
- `backend/` — Go teleop gateway (token issuance, webhook, metrics)
- `vehicle-agent/` — Python vehicle runtime and verifier
- `livekit/` — LiveKit server configuration
- `caddy/` — Caddy ingress / proxy configuration
- `tests/` — CI E2E tests and network emulation scripts
- `docs/` — architecture notes and runbooks

See `docs/ARCHITECTURE.md` for a concise description of components, data
flows and migration notes.

