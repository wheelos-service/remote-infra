# Infrastructure

The release uses `scripts/deploy.py` to generate a single-host Compose deployment
with per-installation credentials, login configuration, and HTTPS.

- [Prebuilt LAN setup](../docs/setup.md): load the release and deploy without a source build.
- [Source deployment](../docs/deploy-from-source.md): build and run from this checkout.
- [Operations](../docs/operations.md): verification, logs, state, and backups.

`release/` contains the setup-image Dockerfile, bundle launcher, and bundled
instructions. `scripts/package-release.py` builds and exports the AMD64 package.
The frontend owns its Nginx configuration at `../frontend/nginx.conf`; infra
owns deployment generation and release packaging, not application runtime
configuration.

The generated Compose file in the private deployment state directory is the
only supported deployment configuration; do not add a parallel root-level
Compose stack. Kubernetes manifests are not maintained in this repository.

## One runtime workflow, two build inputs

| Responsibility | Source checkout | Prebuilt AMD64 bundle |
| --- | --- | --- |
| Build applications | `deploy.py build` uses the two application Dockerfiles | `package-release.py` builds those same Dockerfiles on an AMD64 build host |
| Deliver dependencies | Compose obtains runtime images | Packager exports all runtime images and the setup-tool image |
| Configure, initialize, start, verify | `deploy.py` | The setup image contains the same `deploy.py`; the launcher forwards arguments |
| Persistent deployment data | Private external state directory and volumes | Same layout, never embedded in the release |

The packager does not initialize a fleet or generate installation secrets.
The launcher does not implement an alternative initialization state machine.
Source `all` prepares Compose, builds Gateway/Frontend, starts and verifies;
prebuilt `all` skips builds and registry pulls. Do not run the standalone build
helpers as additional mandatory deployment steps.

The bundle verifies file checksums before loading, pins the setup image ID, and
checks each service image ID and architecture before deployment. Checksums detect
corruption, not publisher impersonation: obtain the archive and its expected
checksum through a trusted distribution channel.

Browser runtime configuration contains only public URLs and a public OAuth
client ID. Never add credentials to it or distribute generated server state.
