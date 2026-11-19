---
name: testing
description: Write, fix, or extend repository tests and validate behavior changes using the relevant Gateway, vehicle, integration, or E2E checks.
---

# Testing

## When

Read this file when writing, fixing, or extending tests, or when validating a behavior change.

## Rules

- Read the relevant implementation and neighboring tests first; prioritize boundaries with the highest regression risk.
- Run Gateway tests with `go test ./...` from `teleop-gateway/`.
- Run frontend and shared input state-machine tests with the documented npm scripts; run cross-component checks from `tests/README.md`.
- For cross-component changes, run the applicable integration or E2E scripts under `tests/` and record service prerequisites.
- When a test fails, determine whether it is a code regression, an environment prerequisite, or a pre-existing failure before changing code.

## Do NOTs

- Do not test only the happy path; cover rejection, timeout, expiry, duplicate requests, and resource release where applicable.
- Do not mock away the security boundary or database/lease semantics under test.
- Do not run tests with real secrets, vehicle credentials, or production endpoints.

## Sources (SSOT)

- Gateway tests: `teleop-gateway/internal/gateway/*_test.go`
- Integration test instructions: `tests/README.md`
