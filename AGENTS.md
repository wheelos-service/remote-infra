# Agent Guide

## Commands
- Gateway tests: `cd apps/teleop-gateway && go test ./...`
- Apollo Teleop/Guardian/Canbus & SDK-Kit Bazel tests: `docker exec -u wfh -w /apollo apollo_dev_wfh_29599a1b bazel test --lockfile_mode=off @sdk_kit//tests/... //modules/teleop/... //modules/guardian/... //modules/canbus:canbus_test --test_output=errors`
- Apollo LiveKit media worker smoke check: `docker exec -u wfh -w /apollo apollo_dev_wfh_29599a1b bazel run --lockfile_mode=off //modules/teleop:vehicle_media_worker -- --sdk-smoke`
- Frontend build: `cd frontend && npm run build`
- Frontend tests: `cd frontend && npm test`
- Shared state-machine tests: `npm --prefix packages/teleop-shared test`
- Backend build: `infra/scripts/build-backend.sh`
- Frontend static build: `infra/scripts/build-frontend.sh`
- Integration services: `docker compose up -d --build`
- Install shared/frontend dependencies: `npm ci --prefix packages/teleop-shared && npm ci --prefix frontend`

## Principles & Anti-Patterns
- **DO**: Read relevant code and tests first; follow the existing architecture, naming, and security boundaries.
- **DO**: Update relevant tests and documentation with behavior changes; run the narrowest relevant validation.
- **DO NOT**: Modify unrelated code or guess unverified interfaces, configuration, or deployment behavior.
- **DO NOT**: Put secrets, access tokens, device credentials, or the LiveKit API secret in frontend code, URLs, logs, or Git.
- **DO NOT**: Commit, create branches, or reset existing user changes unless explicitly requested.
- For vehicle Cyber/LiveKit changes, read `.agents/knowledge/vehicle-cyber.md` first; preserve its module boundaries and safety invariants.

## Knowledge (what the project is)
- `architecture.md` — Module breakdown, multi-tenant entity model (`Organization`, `Person`, `Vehicle`, `Role`/`Scope`), registration & binding flows, and 4-layer runtime authentication
- `conventions.md` — Code style, naming, and security constraints
- Current API/runtime compatibility boundaries: `docs/compatibility.md`
- `vehicle-cyber.md` — Cyber/LiveKit module ownership, wire contract, and control safety invariants
- `troubleshooting.md` — Common startup, test, and deployment problems

## Skills (how to work)
- `testing/SKILL.md` — Writing, fixing, and validating tests
- `review/SKILL.md` — Code review and refactoring risk checks
- `release/SKILL.md` — Release checks and Docker Compose deployment
