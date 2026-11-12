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

Configuration generation precedes Compose builds because the generated Compose
file defines build contexts and services. This is one preparation step, not a
second deployment system. The prebuilt launcher uses the same preparation,
initialization and verification code but skips application builds.

Persistent setup files live in `~/.local/state/teleop`, outside the checkout.
The script uses that directory's `compose.json`. Do not edit generated files:
subsequent commands regenerate them.

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

## Build a prebuilt AMD64 package

On a Linux AMD64 build host with Docker and internet access:

```bash
python3 infra/scripts/package-release.py --version 1.1.0 \
  --output /absolute/path/outside-the-checkout
```

The packager builds the same Gateway/Frontend Dockerfiles, bundles their runtime
dependencies, and embeds `deploy.py` in a setup image. It exports an image-ID
manifest, checked bundle files, and an outer archive checksum. It does not start
services or create deployment credentials. ARM64 hosts are rejected rather than
silently emitting an unvalidated AMD64 package.

On the destination AMD64 host, follow [LAN setup](setup.md). The destination
needs Docker Engine and standard Linux shell/checksum utilities, not Go, Node,
Python or the host Compose plugin; the setup image includes Python and Compose.
Use the bundle's `./teleop` launcher, not source build commands.

## Optional public domains

For a new deployment with console and login DNS names pointing at this server:

```bash
python3 infra/scripts/deploy.py --domain console.example.com \
  --auth-domain login.example.com --acme-email ops@example.com all
```

The script explicitly configures Let's Encrypt ACME for both domains. Caddy
obtains the server certificates on startup, serves HTTPS, and automatically
renews them while running. No certificate download, manual replacement, private
root installation, or Cloudflare API token is required. The optional ACME email
is saved with the deployment settings; keep a working operational contact.
This issues server certificates, not a new CA or vehicle client certificates.

Before starting:

- Own two public DNS names. Set their A records to the origin's public IPv4;
  publish AAAA only if IPv6 actually reaches this host.
- Use DNS-only/direct records (Cloudflare grey cloud if using Cloudflare).
  Any DNS provider works. Do not use Cloudflare Origin CA for direct clients.
- Forward public TCP 80/443 through NAT/firewalls to this host. Caddy uses ACME
  HTTP-01/TLS-ALPN-01 challenges; no DNS API access is needed.
- Allow outbound DNS and HTTPS to the ACME service. If CAA records restrict
  issuance, allow `letsencrypt.org`.
- Synchronize server/client clocks and maintain their system CA packages.

Also expose the media ports listed above.
For media behind NAT, `--media-ip` can set the advertised public IPv4 address.
LiveKit signaling uses the same console/Gateway HTTPS origin through the gated
`/rtc` route; WebRTC media uses its separate TCP/UDP ports, not an HTTP CDN.

The private `caddy-data/` directory in deployment state holds ACME account keys,
certificates and private keys. Preserve it across restarts and releases. Do not
delete it to force reissuance: this loses continuity and can hit CA rate limits.
`start`/`verify` use normal system trust, so an untrusted or incorrectly named
certificate cannot silently pass deployment verification.

### Test issuance before production

Use a separate state and Compose project to avoid consuming production issuance
limits during setup:

```bash
python3 infra/scripts/deploy.py --state "$HOME/.local/state/teleop-acme-test" \
  --project teleop-acme-test --domain console.example.com \
  --auth-domain login.example.com --acme-email ops@example.com \
  --acme-staging prepare
docker compose -p teleop-acme-test \
  -f "$HOME/.local/state/teleop-acme-test/compose.json" up -d --no-deps caddy
docker compose -p teleop-acme-test \
  -f "$HOME/.local/state/teleop-acme-test/compose.json" logs --tail=100 caddy
docker compose -p teleop-acme-test \
  -f "$HOME/.local/state/teleop-acme-test/compose.json" stop caddy
```

Successful certificate acquisition in the Caddy logs confirms the challenge
path. Staging certificates are deliberately untrusted; application upstreams
are not started by this test. Do not enroll vehicles or bypass TLS verification.
The launcher refuses staging `start`, `all` and `verify`. Stop the test proxy
before production so it releases ports 80/443, then use the production command
above with a different state/project. The chosen CA environment is pinned in
state; it cannot silently change on a later invocation.

This implementation needs reachable public challenge ports. If they cannot be
opened, DNS-01 with a DNS-provider module is a separate deployment option, not
implemented here. The private LAN PKI workflow is unchanged and independent of
Cloudflare or public ACME.

For loopback-only testing, use `--local` with a separate state directory and
project. It uses HTTP, publishes no media ports, and is not for LAN clients.

Keep the saved address for the lifetime of an installation. Changing it requires
a separate deployment state and an explicit data/identity migration; the script
does not migrate existing identities to another issuer. See [operations](operations.md)
for maintenance and backups.
