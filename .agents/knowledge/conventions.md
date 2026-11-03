# Conventions

## When
Read this file when adding or modifying code, configuration, tests, logs, or security-sensitive behavior.

## Rules
- Follow each language's existing style: use `gofmt` and package tests for Go, the existing module layout for Python, and keep the frontend within its static-page and TypeScript boundaries.
- Reuse existing types, APIs, configuration, and test fixtures; update tests and documentation for public behavior changes.
- Shared browser state machines belong in `packages/teleop-shared/`; app-to-app source imports are not permitted.
- Inject configuration through environment variables or protected configuration files; example configuration committed to the repository must contain no real secrets.
- Validate input, identity, tenant, scope, vehicle permissions, and control sessions on the server.
- Keep audit logs structured and exclude tokens, private keys, passwords, and device credentials.

## Do NOTs
- Do not put secrets in command lines, URLs, frontend static files, Docker images, or logs for convenience.
- Do not replace existing structured parsing, encoding, or validation with string concatenation.
- Do not refactor or reformat unrelated files as part of a change.

## Sources (SSOT)
- General engineering constraints: `.github/copilot-instructions.md`
- Runtime configuration and secret classification: `docs/operations.md`
- Current API compatibility/ownership: `docs/compatibility.md`
- API schema: `api/schemas/datachannel-control.schema.json`
- Go module: `apps/teleop-gateway/go.mod`
- Python project configuration: `apps/vehicle-edge/pyproject.toml`
