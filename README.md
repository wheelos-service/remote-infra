# livekit-infra

LiveKit remote vehicle supervision server and browser console:

```text
frontend/               Unified authenticated React operations platform
teleop-gateway/         Go Gateway
infra/                  Deployment tools and release packaging
packages/teleop-shared/  Framework-independent browser input state machines
api/schemas/            Versioned cross-component JSON Schema contracts
docs/                    Deployment, administration and operations guides
tests/                   Unit, contract and deployment acceptance checks
```

`packages/teleop-shared/` provides shared input and view state machines.
Vehicle SDK builds and Apollo configuration are managed separately from this
server repository.
See [release capabilities](docs/compatibility.md).

The Gateway is a root-level Go module; its `cmd/` executables and `internal/`
packages follow standard Go application boundaries. `infra/scripts/deploy.py`
is the sole deployment lifecycle owner: it generates the private Compose
configuration, initializes, starts and verifies both source and prebuilt
deployments.

## Quick start

For the prebuilt Ubuntu x86_64 release, follow the [LAN setup guide](docs/setup.md).
It requires Docker Engine and includes compiled applications and setup tools.
To build from this checkout, install Docker Compose v2 and Python 3. For stable
URLs shared with a public deployment, configure split DNS for both hostnames
and deploy with the server's LAN IP:

```bash
python3 infra/scripts/deploy.py --lan-ip 192.168.1.50 \
  --domain console.example.com --auth-domain login.example.com all
```

The LAN stack runs AdGuard Home; add rewrites for both hostnames to the LAN IP
and configure router DHCP to distribute that DNS server. Trust the generated
CA certificate on each LAN client, then open
`https://console.example.com` from the host or another LAN computer.
Sign in with the administrator created during setup. The fleet starts empty;
vehicle software installation is handled separately. Managed native driving
is disabled until handover support is complete.

The [user documentation index](docs/readme.md) covers source deployment,
operations, administration, vehicle registration, and release limitations.
Docker Compose on one host is the only supported release deployment.
