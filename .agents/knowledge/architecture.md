# Architecture

## When
Read this file when you need to understand component boundaries, request paths, authentication, or real-time media and control data flow.

## Rules
- The system consists of the browser operator console, the Go Teleop Gateway, LiveKit/Redis infrastructure, and the Python vehicle edge agent.
- The Gateway owns identity validation, Vehicle ACLs, short-lived LiveKit tokens, control leases, and auditing.
- The browser holds only short-lived tokens and the operator private key in page memory; the LiveKit API secret, Redis password, and device credentials must never reach the browser.
- A Controller operates a vehicle through a Control Session and signed DataPackets; an Observer can only watch.
- Docker Compose is the current deployment path; the Kubernetes manifests are deferred deployment assets.

## Do NOTs
- Do not bypass the Gateway by generating LiveKit administrative credentials in the browser.
- Do not combine client, Gateway, LiveKit, and vehicle-edge responsibilities in one module.
- Do not treat this prototype's safety controls as production certification for real vehicles.

## Sources (SSOT)
- Architecture and data flow: `docs/architecture.md`
- Requirements and security boundaries: `docs/spec.md`
- Gateway routes and implementation: `apps/teleop-gateway/`
- Vehicle sessions and control receiver: `apps/vehicle-edge/src/vehicle_edge/`
