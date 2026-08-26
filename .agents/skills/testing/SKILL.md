# Testing

## When
Read this file when writing, fixing, or extending tests, or when validating a behavior change.

## Rules
- Read the relevant implementation and neighboring tests first; prioritize boundaries with the highest regression risk.
- Run Gateway tests with `go test ./...` from `apps/teleop-gateway/`.
- Run vehicle tests with `pytest apps/vehicle-edge/tests`; install dependencies according to the project documentation when necessary.
- For cross-component changes, run the applicable integration or E2E scripts under `tests/` and record service prerequisites.
- When a test fails, determine whether it is a code regression, an environment prerequisite, or a pre-existing failure before changing code.

## Do NOTs
- Do not test only the happy path; cover rejection, timeout, expiry, duplicate requests, and resource release where applicable.
- Do not mock away the security boundary or database/lease semantics under test.
- Do not run tests with real secrets, vehicle credentials, or production endpoints.

## Sources (SSOT)
- Gateway tests: `apps/teleop-gateway/internal/gateway/*_test.go`
- Vehicle tests: `apps/vehicle-edge/tests/`
- Integration test instructions: `docs/remote-validation.md`
- Test dependency configuration: `apps/vehicle-edge/pyproject.toml`
