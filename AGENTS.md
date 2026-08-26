# Agent Guide

## Commands
- Gateway tests: `cd apps/teleop-gateway && go test ./...`
- Vehicle tests: `pytest apps/vehicle-edge/tests`
- Frontend build: `cd apps/operator-console && npm run build`
- Backend build: `infra/scripts/build-backend.sh`
- Frontend static build: `infra/scripts/build-frontend.sh`
- Integration services: `docker compose up -d --build`

## Principles & Anti-Patterns
- **DO**: Read relevant code and tests first; follow the existing architecture, naming, and security boundaries.
- **DO**: Update relevant tests and documentation with behavior changes; run the narrowest relevant validation.
- **DO NOT**: Modify unrelated code or guess unverified interfaces, configuration, or deployment behavior.
- **DO NOT**: Put secrets, access tokens, device credentials, or the LiveKit API secret in frontend code, URLs, logs, or Git.
- **DO NOT**: Commit, create branches, or reset existing user changes unless explicitly requested.

## Knowledge (what the project is)
- `architecture.md` — Component boundaries, data flow, and authentication boundaries
- `conventions.md` — Code style, naming, and security constraints
- `troubleshooting.md` — Common startup, test, and deployment problems

## Skills (how to work)
- `testing/SKILL.md` — Writing, fixing, and validating tests
- `review/SKILL.md` — Code review and refactoring risk checks
- `release/SKILL.md` — Release checks and Docker Compose deployment
