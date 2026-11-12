# Deploy from source

Use this instead of the prebuilt package in [LAN setup](setup.md). You need a
checkout of tag `1.1.0`, Git, Python 3, Docker Engine, and Docker Compose v2.
Your OS user must be able to run Docker. Docker compiles the applications;
host Go and Node.js installations are unnecessary. Builds require internet access.

## Deploy on the LAN

Run from the repository root. Replace the example with a stable private IPv4
address assigned to the server:

```bash
docker info
docker compose version
python3 infra/scripts/deploy.py --lan-ip 192.168.1.50 all
```

This generates credentials and configuration, builds the Gateway and frontend,
starts the services, creates the first administrator, and verifies the deployment.
No `.env` file or existing vehicle configuration is needed.

Persistent setup files live in `~/.local/state/teleop`, outside the checkout.
The script uses that directory's `compose.json`, not the root Compose file.
Do not edit generated files: subsequent commands regenerate them.

Allow LAN access to TCP 8443/8444, TCP 7881, and UDP 51000–51100.
Follow [certificate trust and sign-in](setup.md#2-trust-the-certificate) before
opening `https://192.168.1.50:8443` on the host or another LAN computer.

## Run individual steps

```bash
python3 infra/scripts/deploy.py --lan-ip 192.168.1.50 prepare
python3 infra/scripts/deploy.py build
python3 infra/scripts/deploy.py start
python3 infra/scripts/deploy.py verify
```

`prepare` writes configuration without starting services. `start` reuses built
images, completes initialization if needed, and verifies service health.
`all` builds and starts. The first start also tests administrator login.

For a custom installation, pass `--state /absolute/private/directory` and
`--project unique-name` on initial setup. Pass the same `--state` on later
commands; the project name and address are saved. The directory must belong
to your user, have mode `0700`, and be outside the repository.

## Optional public domains

For a new deployment with console and login DNS names pointing at this server:

```bash
python3 infra/scripts/deploy.py --domain console.example.com \
  --auth-domain login.example.com all
```

Public-domain mode uses Caddy's public HTTPS certificates on TCP 80/443.
Make those ports reachable and also expose the media ports listed above.
For media behind NAT, `--media-ip` can set the advertised public IPv4 address.
Domain mode is optional; the LAN workflow needs no DNS or internet-facing ports.

For loopback-only testing, use `--local` with a separate state directory and
project. It uses HTTP, publishes no media ports, and is not for LAN clients.

Keep the saved address for the lifetime of an installation. Changing it requires
a separate deployment state and an explicit data/identity migration; the script
does not migrate existing identities to another issuer. See [operations](operations.md)
for maintenance and backups.
