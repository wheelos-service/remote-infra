# Deployment

Run commands from the repository root on the deployment host. Use the same
workflow for each environment, with its own address, Compose project and state
directory. Vehicle builds and services belong to `apollo-base`.

## Requirements

- Linux server with Docker Engine and Compose v2, Python 3.8+, Node.js 22 and npm.
- A stable IPv4 address or DNS name reachable from browsers, vehicles and containers.
- Three available HTTPS ports; the default is 8443–8445.
- A writable state directory outside the Git checkout. The script creates it with
  mode 0700 and stores configuration, credentials and certificates there.

Builds use the standard Docker registries and Go module proxy. Configure Docker
registry mirrors and `GOPROXY` in the host environment if your network requires them.

This workflow creates one Gateway, frontend, Casdoor, PostgreSQL, Redis, LiveKit,
Caddy and a private test mailbox. It uses managed authorization and a private CA.
Invitations stay in the test mailbox; driving is disabled. For public certificates,
external email or a separate static frontend, use the [cloud reference](deployment-cloud.md).

## First deployment

Check out the intended revision, then run:

```bash
python3 infra/scripts/deploy.py --state ../teleop-state \
  --host SERVER_IP_OR_DNS --project teleop --base-port 8443 up
```

Replace `SERVER_IP_OR_DNS` with your server address. The command creates protected
configuration, builds both application images, starts services, bootstraps the
administrator and verifies TLS, served frontend assets, health/readiness and a real PKCE login.
Host, project and port settings are saved; later commands need only `--state`.

| Endpoint | Default URL |
| --- | --- |
| Application and administration | `https://HOST:8443/` and `https://HOST:8443/#/admin` |
| Login | `https://HOST:8444/` |
| Test mailbox | `https://HOST:8445/` |

Read `administrator.txt` and `mail-credentials.txt` inside the state directory
on the server. Copy only its public `root.crt` to clients, verify its fingerprint
with the server operator and trust it in each browser/vehicle trust store.
For Ubuntu clients, the helper installs and verifies it in one command:

```bash
bash infra/scripts/trust-authentication-ca.sh --ca /path/to/root.crt \
  --fingerprint EXPECTED_SHA256 --url https://HOST:8443/readyz
```

To enable camera media, add `--media-port 9781` to the first deployment command
and allow that port over TCP and UDP. With a DNS host, also pass
`--media-ip REACHABLE_SERVER_IPV4`. `--bind-address LOCAL_IPV4` selects a local
interface; its default is the host IP, or all IPv4 interfaces for a DNS host.
Media clients must reach the advertised IP/port; NAT requires matching forwarding.
RTC signaling stays behind the Gateway. Opening media ports does not enable driving.

## Update

Update the checkout to the intended revision, then run:

```bash
python3 infra/scripts/deploy.py --state ../teleop-state update
```

This builds the images, recreates only Gateway/frontend and verifies the result.
It preserves saved configuration, certificates, credentials, maintenance mode,
media settings and database volumes. A build failure does not restart services;
a verification failure exits nonzero—inspect logs before treating the update as successful.
The script does not fetch Git or overwrite local source changes.

For an existing deployment, point `--state` at its existing directory; saved
`deployment.json` settings are supported. Do not initialize a second state
directory for the same Compose project. Changing the host or HTTPS ports changes
the issuer and requires a separate environment or a deliberate identity migration.

## Everyday commands

```bash
python3 infra/scripts/deploy.py --state ../teleop-state status
python3 infra/scripts/deploy.py --state ../teleop-state verify
python3 infra/scripts/deploy.py --state ../teleop-state logs
python3 infra/scripts/deploy.py --state ../teleop-state stop
python3 infra/scripts/deploy.py --state ../teleop-state up
```

`stop` retains state and volumes; `up` rebuilds and starts the saved environment.
Use a persistent terminal such as tmux for long remote builds. Never delete state
or run `docker compose down -v` during an update. Back up the protected state and
persistent databases together before an upgrade.

Existing access changes use `maintenance-on` / `maintenance-off` with the same
script and state argument. Follow the [maintenance/drain procedure](auth-management.md);
restarting does not bypass its waiting period. Use the
[user and vehicle onboarding guide](onboarding.md) after deployment.

`prepare` is an explicit configuration-regeneration action. Use it only when
changing generated settings, for example `--media-port 9781 prepare`, then `start`
to apply and `verify` to check. It can replace manual edits to generated files;
routine `update` never calls it. The previous `authentication-test.py` entry point
and `all` action remain supported.

## Vehicle Deployment

Vehicle SDKs live in `apollo-base/data/sdk-kit`; telemetry, media and control
live in `apollo-base/modules/teleop`. Follow that checkout's build and deployment
guide. This repository provides cloud services and `infra/scripts/install-vehicle-auth.py`
for protected enrollment. Installation alone does not start vehicle telemetry.

Inside the Apollo development environment, run its SDK and module checks:

```bash
bazel test --lockfile_mode=off @sdk_kit//tests/... //modules/teleop/... \
  //modules/guardian/... //modules/canbus:canbus_test --test_output=errors
```

Preserve `teleop:vehicle` on initial and refreshed OAuth requests in the vehicle
SDK. Cloud health checks do not verify camera publishing or physical control.

## Optional managed authorization pilot

For an existing public-domain Compose stack, use the
[managed authorization overlay](deployment-cloud.md#optional-managed-authorization-pilot).

## Client Deployment

Public runtime configuration and standalone frontend hosting are documented in
[the cloud reference](deployment-cloud.md#client-deployment).

## Cloudflare Pages and a single backend host

See [separate static hosting](deployment-cloud.md#cloudflare-pages-and-a-single-backend-host)
for DNS, ingress, caching and cross-origin configuration.
