# livekit-infra

LiveKit remote vehicle supervision server and browser console:

```text
frontend/               Unified authenticated React operations platform
apps/teleop-gateway/    Go Gateway
infra/                  Deployment tools and release packaging
```

`packages/teleop-shared/` provides shared input and view state machines.
`apps/operator-console/` and `apps/vehicle-edge/` are legacy v1 references,
not dependencies of the primary frontend. See [release capabilities](docs/compatibility.md).

## Quick start

For the prebuilt Ubuntu x86_64 release, follow the short [LAN setup guide](docs/setup.md).
It requires Docker Engine and includes compiled applications and setup tools.
To build from this checkout instead, install Docker Compose v2 and Python 3,
then run using the deployment machine's LAN IP:

```bash
python3 infra/scripts/deploy.py --lan-ip 192.168.1.50 all
```

Trust the generated CA certificate on each client, then open
`https://192.168.1.50:8443` from the host or another LAN computer.
Sign in with the administrator created during setup. The fleet starts empty;
vehicle software installation is handled separately. Managed native driving
is disabled until handover support is complete.

The [user documentation index](docs/readme.md) covers source deployment,
operations, administration, vehicle registration, and release limitations.
Docker Compose on one host is the supported release deployment; retained
Kubernetes manifests are outside this release workflow.
