# Review

## When
Read this file when performing code review, refactoring, or assessing cross-component behavior changes.

## Rules
- Check behavior regressions, security boundaries, error handling, concurrency/lease semantics, and test gaps before style issues.
- Report reproducible findings by severity with the file path and concrete impact.
- Verify identity, scopes, Vehicle ACLs, control sessions, signatures, replay protection, token TTLs, and auditing.
- Check that the frontend exposes no secrets and that the server does not incorrectly expose Redis, internal Gateway ports, or LiveKit administration.
- Refactoring must preserve existing APIs, configuration, and deployment contracts unless the requirement explicitly changes them.

## Do NOTs
- Do not treat code that looks reasonable as proof of security or protocol correctness.
- Do not bury real risks under formatting, naming preferences, or unrelated refactoring.
- Do not ignore missing tests, stale documentation, or inconsistent production deployment configuration.

## Sources (SSOT)
- Security requirements: `docs/spec.md` and `docs/operations.md`
- Architecture boundaries: `docs/architecture.md`
- Deployment configuration: `docker-compose.yml`, `docker-compose.no-domain.yml`, `infra/local-dev/Caddyfile`
- Existing tests: `apps/teleop-gateway/internal/gateway/*_test.go`, `apps/vehicle-edge/tests/`
