# Infrastructure

The release uses `scripts/deploy.py` to generate a single-host Compose deployment
with per-installation credentials, login configuration, and HTTPS.

- [Prebuilt LAN setup](../docs/setup.md): load the release and deploy without a source build.
- [Source deployment](../docs/deploy-from-source.md): build and run from this checkout.
- [Operations](../docs/operations.md): verification, logs, state, and backups.

`release/` contains the setup-image Dockerfile, bundle launcher, and bundled
instructions. `scripts/package-release.py` builds and exports the AMD64 package.
`frontend/` contains the frontend Nginx configuration.

The generated Compose file lives in the private deployment state directory.
The root Compose files and `local-dev/` assets are retained for compatibility
and development; they are not the release launcher's deployment configuration.
`k8s/` is outside the supported release workflow.

Browser runtime configuration contains only public URLs and a public OAuth
client ID. Never add credentials to it or distribute generated server state.
