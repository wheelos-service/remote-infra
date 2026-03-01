# Architecture Overview — K8s-first Teleop Platform

This repository implements an industrial teleoperation platform. The codebase is organised with Kubernetes as the primary deployment target. The following summarizes modules, data flows and recommended operational practices.

## High-level modules

- `backend/` — Go-based Teleop Gateway
  - Responsibilities: operator/vehicle token exchange, lock (session) management, key registration, LiveKit token issuance, webhook handling, telemetry `/api/telemetry` endpoint, Prometheus metrics.
  - Deploy using `deploy/k8s/teleop-backend.yaml` (Deployment + Service). Use the provided resource requests/limits and probes.

- `vehicle-agent/` — Python vehicle runtime
  - Responsibilities: fetch operator public key, verify Ed25519-signed control packets, watchdog/emergency brake, optional LiveKit publishing/subscribing.
  - Run on edge devices (container or native). Use `mode=livekit` in production; `mode=ws` remains available for local demo/test.

- `deploy/k8s/` — Kubernetes manifests
  - Contains manifests for `livekit`, `coturn`, `redis`, `casdoor`, and `teleop-backend` (with probes, limits, and hostNetwork where required).

- `tests/` — E2E test helpers and CI scripts
  - `e2e_qos_test.py` and `e2e_qos_test.sh` implement CI QoS tests with `tc netem` for network emulation.

## Data flow

1. Operator requests a token from `backend` (`/api/token/operator`) — gateway issues a LiveKit operator token (Room: `teleop-<vehicle_id>`). If operator acquires lock, token includes `CanPublishData=true`.
2. Vehicle (edge) requests a token (`/api/token/vehicle`) to join LiveKit room as `vehicle-<id>` and subscribes to DataChannel messages.
3. Operators publish signed control packets via DataChannel. `vehicle-agent` verifies signature, seq and timestamp and applies control if valid.
4. Gateway manages locks (preemption), emits Prometheus metrics and accepts `/api/keys/register` and `/api/keys/current` for operator key rotation.
5. Telemetry: `vehicle-agent` reports P50/P99 latency and lost packets to `/api/telemetry`, gateway exposes them through Prometheus metrics.

## Migration notes / Good practices

- Prefer Kubernetes manifests under `deploy/k8s/` for production. Manifests already include `hostNetwork: true` for LiveKit/Coturn where low-latency UDP is required.
- Remove `docker-compose` orchestration; CI should rely on `kind`, `k3s`, or mocked services for integration tests. For short-lived CI jobs we provide `tests/e2e_qos_test.sh` which starts local services using Docker compose for convenience — consider migrating CI to use an ephemeral `kind` cluster for stronger parity with production.
- Secrets: do not check secrets into git. Use K8s Secrets / sealed-secrets / external secret managers in production.
- Observability: scrape `/metrics` on the Teleop Gateway. Use `teleop_active_sessions`, `teleop_lock_preemptions_total`, `teleop_auth_failures_total`, and `teleop_e2e_latency_p99_milliseconds{vehicle_id}`.

## Operational checklist

- Ensure `LIVEKIT_API_KEY/SECRET` are provided in the Teleop Deployment as K8s Secrets.
- Run `kubectl apply -f deploy/k8s/` to deploy all manifests.
- Verify readiness with `kubectl get pods` and `kubectl port-forward` or via LoadBalancer/ingress as appropriate.

## Files to review

- `backend/main.go` — core gateway logic and newly added Prometheus metrics.
- `vehicle-agent/secure_receiver.py` — verifier and telemetry loop.
- `deploy/k8s/` — production manifests (LiveKit, Coturn, Redis, Teleop backend, Casdoor).

---
This document is intentionally concise — open issues or PRs if you want a more detailed runbook (helm charts, kustomize overlays, and CI `kind` cluster setup).
