---
name: release
description: Prepare repository releases, build backend and frontend images, run pre-release checks, and deploy with the documented Docker Compose workflow.
---

# Release

## When

Read this file when preparing a release, building images, deploying Docker Compose, or running pre-release checks.

## Rules

- Before release, confirm that tests, example configuration, deployment documentation, and image builds match the change.
- Use `infra/scripts/package-release.py` for the AMD64 bundle and `infra/scripts/deploy.py` for source deployment. The standalone backend/frontend build helpers remain available for development.
- Follow `docs/setup.md` or `docs/deploy-from-source.md`, then run the deployment's `verify` action and check logs. The release uses the generated state-directory Compose file.
- Managed release Gateways admit existing and future active enrollments automatically. For a control test, verify the operator's vehicle scope, receiver heartbeat, and camera readiness. The original 1.1.3 image used a site list. [Vehicle-side test guide](../../../docs/vehicle-control-test.md)
- A production rollout of vehicle actuation software requires a security review.
- Use HTTPS/WSS in production; open the required LiveKit media ports and never expose Redis publicly.
- Keep generated deployment state private and outside the repository; do not commit `.env` files or real credentials.

## Do NOTs

- Do not use `AUTH_MODE=dev` for production control.
- Do not infer the current production workflow from the future k3s roadmap; Docker Compose is the only supported deployment path.

## Sources (SSOT)

- Deployment workflow: `docs/deploy-from-source.md`
- Operations and secret boundaries: `docs/operations.md`
- Release configuration: `infra/scripts/deploy.py`, `infra/release/`
- Build scripts: `infra/scripts/package-release.py`, `infra/scripts/build-backend.sh`, `infra/scripts/build-frontend.sh`
- Pre-release validation: `tests/README.md`
