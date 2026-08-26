# Release

## When
Read this file when preparing a release, building images, deploying Docker Compose, or running pre-release checks.

## Rules
- Before release, confirm that tests, example configuration, deployment documentation, and image builds match the change.
- Use `infra/scripts/build-backend.sh` and `infra/scripts/build-frontend.sh` for the repository's defined builds.
- Deploy to the cloud with `docker compose --profile cloud up -d --build`, then verify `/healthz`, `/readyz`, logs, and key domains.
- Use HTTPS/WSS in production; open the required LiveKit media ports and never expose Redis publicly.
- Inject secrets through the server environment or a Secret Manager; do not commit `.env` files or real credentials.

## Do NOTs
- Do not use `AUTH_MODE=dev` for production control.
- Do not deploy this prototype into a real vehicle control path without a security review.
- Do not infer the current production workflow from the Kubernetes manifests; Docker Compose is the current primary path.

## Sources (SSOT)
- Deployment workflow: `docs/deployment.md`
- Operations and secret boundaries: `docs/operations.md`
- Compose configuration: `docker-compose.yml`, `docker-compose.no-domain.yml`
- Build scripts: `infra/scripts/build-backend.sh`, `infra/scripts/build-frontend.sh`
- Pre-release validation: `docs/remote-validation.md`
