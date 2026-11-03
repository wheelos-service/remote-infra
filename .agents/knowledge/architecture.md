# Architecture

## When
Read this file when you need to understand component boundaries, request paths, authentication, or real-time media and control data flow.

## Rules
- Current runtimes are `frontend/`, the Go Teleop Gateway, LiveKit/Redis infrastructure, and the C++ vehicle SDKs. Python vehicle edge and the standalone console remain legacy v1 references.
- Pure input/gamepad/camera state machines are owned only by `packages/teleop-shared/`; neither browser imports the other application's source.
- The Gateway owns identity validation, Vehicle ACLs, short-lived LiveKit tokens, control leases, and auditing.
- The browser holds only short-lived tokens and the operator private key in page memory; the LiveKit API secret, Redis password, and device credentials must never reach the browser.
- A Controller operates a vehicle through a Control Session and signed DataPackets; an Observer can only watch.
- Vehicle Cyber monitoring and teleoperation stay in the existing single vehicle process and single LiveKit connection; see `vehicle-cyber.md` for module ownership, topics, and safety invariants.
- Docker Compose is the current deployment path; the Kubernetes manifests are deferred deployment assets.

## Do NOTs
- Do not bypass the Gateway by generating LiveKit administrative credentials in the browser.
- Do not combine client, Gateway, LiveKit, and vehicle-edge responsibilities in one module.
- Do not treat this prototype's safety controls as production certification for real vehicles.

## Sources (SSOT)
- Architecture and data flow: `docs/architecture.md`
- Primary/legacy contracts: `docs/compatibility.md`
- Requirements and security boundaries: `docs/spec.md`
- Gateway routes and implementation: `apps/teleop-gateway/`
- Current vehicle SDKs and control receiver: `apps/vehicle-edge-cpp/`
- Legacy v1 vehicle runtime: `apps/vehicle-edge/src/vehicle_edge/`
- Cyber/LiveKit vehicle runtime invariants: `.agents/knowledge/vehicle-cyber.md`
