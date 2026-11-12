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
- Use HTTPS/WSS in production; open the required LiveKit media ports and never expose Redis publicly.
- Keep generated deployment state private and outside the repository; do not commit `.env` files or real credentials.

## Do NOTs

- Do not use `AUTH_MODE=dev` for production control.
- Do not deploy this prototype into a real vehicle control path without a security review.
- Do not infer the current production workflow from the Kubernetes manifests; Docker Compose is the current primary path.

## Sources (SSOT)

- Deployment workflow: `docs/deploy-from-source.md`
- Operations and secret boundaries: `docs/operations.md`
- Release configuration: `infra/scripts/deploy.py`, `infra/release/`
- Build scripts: `infra/scripts/package-release.py`, `infra/scripts/build-backend.sh`, `infra/scripts/build-frontend.sh`
- Pre-release validation: `tests/README.md`
