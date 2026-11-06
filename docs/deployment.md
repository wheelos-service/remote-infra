# Deployment: Docker Compose and Static Frontend Hosting

## Architecture

```text
Browser
  | HTTPS/WSS
  +-- client.example.com   -> Caddy -> frontend Nginx
  +-- api.example.com      -> Caddy -> Teleop Gateway
  +-- rtc.example.com      -> Caddy -> LiveKit (WSS signaling)
  +-- WebRTC media/data    -> LiveKit (negotiated UDP or ICE TCP)

Vehicle edge agent
  | outbound HTTPS/WSS
  +-- api.example.com and rtc.example.com
```

The browser and vehicle run outside the server containers. Docker Compose runs
the primary frontend Nginx, Gateway, LiveKit, Redis and optionally Caddy.
This is the current all-in-one topology. The
[external static hosting recommendation](#cloudflare-pages-and-a-single-backend-host)
keeps the same API and RTC boundaries but serves the frontend from Cloudflare
Pages instead of the frontend container. Hosting changes do not grant control
authority or qualify physical vehicle operation.

## Server Preparation

Use a Linux host with Docker Compose. Point DNS records for the client, API,
RTC and Casdoor domains to the host:

```text
api.example.com  A  <server-ip>
rtc.example.com  A  <server-ip>
client.example.com  A  <server-ip>
```

Allow the following firewall traffic:

- TCP 80/443 for Caddy HTTP/HTTPS and WebSocket traffic.
- TCP 7881 for LiveKit TCP fallback.
- UDP 50000-50100 for LiveKit media.

These media ports are from `infra/local-dev/livekit.template.yaml`, not a
universal LiveKit default or a guaranteed concurrency limit. `7881` is ICE TCP,
not HTTPS or TURN/TLS. Verify the SFU advertises a reachable public IP
(`rtc.use_external_ip` is enabled), including cloud security groups and NAT
mapping. Opening HTTPS alone does not make media reachable. The current template
does not configure TURN; restrictive customer networks may require a separately
configured and tested TURN relay. TURN/TLS on 443 requires a compatible Layer-4
ingress or separate IP/host so it does not conflict with Caddy's HTTPS listener.

## Production Deployment

```bash
git clone <repository>
cd livekit-infra
cp .env.example .env
```

Set production values in `.env` without committing the file:

```dotenv
LIVEKIT_API_KEY=teleop_cloud_key
LIVEKIT_API_SECRET=<random-long-secret>
CLIENT_ORIGIN=https://client.example.com
CLIENT_DOMAIN=client.example.com
API_DOMAIN=api.example.com
RTC_DOMAIN=rtc.example.com
AUTHORIZATION_POLICY_DIR=/etc/teleop-auth
AUTHORIZATION_POLICY_FILE=/etc/teleop-auth/authorization-policy.json
```

Place the non-secret vehicle/operator authorization policy at
`AUTHORIZATION_POLICY_DIR/authorization-policy.json` on the host. It replaces
the three legacy `VEHICLE_REGISTRY_JSON`, `VEHICLE_SUBJECT_MAP_JSON`, and
`VEHICLE_ACL_JSON` settings; do not configure both forms. Keep per-vehicle
OAuth client secrets in each vehicle's protected config, not this server-side
policy file. See [authentication.md](authentication.md) for its schema and
the distinct operator and vehicle token flows.

For example, copy
`infra/local-dev/authorization-policy/authorization-policy.example.json` to
`/etc/teleop-auth/authorization-policy.json` before starting Compose, then
populate it with registered vehicle subjects and operator grants.

Start the services and verify health:

```bash
docker compose --profile cloud up -d --build
docker compose ps
curl https://api.example.com/healthz
curl https://api.example.com/readyz
docker compose logs -f teleop-backend livekit caddy
```

## Optional managed authorization pilot

The default deployment above keeps static authorization. The separate
`docker-compose.authorization.yml` overlay opts into the single-Gateway
managed deployment and adds PostgreSQL 16 with a persistent volume and
no host-published database port. It clears the static policy/JSON variables
and requires OIDC. Do not mix the two sources or fall back to static policy
when the authorization database is unavailable.

The overlay also pins LiveKit `v1.13.11` and changes the cloud RTC proxy to the
Gateway's signaling gate. For managed mode, **all** public `/rtc` signaling
must pass through that gate; do not combine this overlay with
`docker-compose.no-domain.yml` or expose LiveKit `7880` directly. The version
and ingress assertion flags must describe the actual deployed topology.
Use `--profile cloud` to start the Caddy entry after bootstrap and frontend
configuration; an alternative external HTTPS proxy needs the same exclusive
Gateway RTC routing.

Set `AUTHORIZATION_POSTGRES_PASSWORD` to a dedicated database password in the
protected `.env`, and set `AUTHORIZATION_DATABASE_URL` to the corresponding
PostgreSQL URL with host `authorization-db`, database/user
`teleop_authorization`. URL-encode password components; never put the actual
URL in documentation, browser runtime configuration or logs. For this
private Compose network only, the URL may select `sslmode=disable`; use
verified TLS when crossing hosts.

For optional automatic onboarding, use the existing protected authorization
directory mount and set `AUTHORIZATION_ONBOARDING_CONFIG_FILE` to its
container-side configuration path. Casdoor alone owns Email/SMTP and personnel
recovery; no second mail service is needed. See the exact protected configuration
and installation workflow in [auth-management.md](auth-management.md).

Validate the merged configuration without starting services:

```bash
docker compose -f docker-compose.yml -f docker-compose.authorization.yml config --quiet
```

Keep the same overlay on subsequent commands. Do not start a second Gateway
against the same database or bypass a rejected drain by restarting with a
different policy source. Retain the Redis persistence and operations volume.
See [managed pilot workflow and limitations](auth-management.md) before
provisioning any identities. This overlay is not a production online-revocation
or physical-driving qualification.

## Client Deployment

The `frontend` Compose service builds the primary React application and shared
package from the repository root. It serves static assets on
`127.0.0.1:${FRONTEND_PORT:-8000}`; the cloud Caddy profile proxies
`CLIENT_DOMAIN` to it over the container network. Start only the UI with:

```bash
docker compose up -d --build frontend
curl http://127.0.0.1:8000/
```

You can alternatively run `infra/scripts/build-frontend.sh` and host
`frontend/dist/` with a static server. The legacy console Dockerfile must also
use repository-root context:
`docker build -f apps/operator-console/Dockerfile -t teleop-console-legacy .`.

Mount a **public-only**, existing JavaScript file using `FRONTEND_CONFIG_PATH`.
Its contents set `window.__LIVEKIT_INFRA_CONFIG__` before `main.js`, for example:

```javascript
window.__LIVEKIT_INFRA_CONFIG__ = {
  gatewayUrl: 'https://api.example.com',
  livekitUrl: 'wss://rtc.example.com',
  authorizeUrl: 'https://casdoor.example.com/login/oauth/authorize',
  tokenUrl: 'https://casdoor.example.com/api/login/oauth/access_token',
  clientId: 'public-operator-client-id',
  simulationControl: false
};
```

No device credentials, client secrets or access tokens belong in this file.
Nginx serves it with `Cache-Control: no-store`; it does not proxy API calls or
generate configuration from unrestricted environment variables. Set CORS and
OIDC redirect URIs to match the actual frontend origin. Optional generated map
assets are mounted read-only from `FRONTEND_MAPS_PATH` (default
`./frontend/public/maps`) at `/usr/share/nginx/html/maps`; they are not baked
into the image or Git. Generate maps on the host before starting/restarting
the frontend service:

```bash
cd frontend
npm run prepare:maps -- --source /mnt/synology/map \
  --map xiaomo_port_inside_0.9.0 --map ruantong_hry_origin
cd ..
docker compose up -d --force-recreate frontend
```

The browser fetches map catalog and map JSON from the same HTTPS origin as the
frontend; no HTTP mixed-content endpoint is used.

The production real-time entry is:

```text
https://client.example.com/#/?page=drive
```

Use OIDC Authorization Code + PKCE. The client may receive public OIDC values such as `clientId` and endpoint URLs, but never a client secret, access token, or LiveKit API secret.

The home route is the authenticated unified platform; Mock requires explicit
development preview. Configure the public runtime settings
as described in [`frontend/README.md`](../frontend/README.md); enable simulation
control explicitly and only for allowlisted simulated vehicles.

## Cloudflare Pages and a single backend host

### Recommended scope and DNS

This is a reasonable initial pilot topology, not an already provisioned Pages
deployment or a high-availability design:

```text
Browser --HTTPS--> client.example.com (Cloudflare Pages: web assets)
Browser --HTTPS--> api.example.com --> Caddy --> Gateway
Browser --WSS----> rtc.example.com --> Caddy --> LiveKit signaling
Vehicle --------> api.example.com and rtc.example.com
Browser/Vehicle --WebRTC media/data--> LiveKit public IP
                                      (or a configured TURN relay)
```

In managed authorization mode, the WSS path is instead
`Caddy -> Gateway signaling gate -> LiveKit`. Direct media connectivity does
not permit bypassing that gate. Keep `docker-compose.authorization.yml` and its
RTC upstream/version assertions consistent with the deployed topology.

| Endpoint | Hosting/proxy recommendation | Responsibility |
| --- | --- | --- |
| `client.example.com` | Cloudflare Pages custom domain | Public HTML/JS/CSS and approved static assets |
| `api.example.com` | Backend host; optional Cloudflare HTTPS proxy | Authenticated Gateway API, never cached at the edge |
| `rtc.example.com` | Backend host, initially Cloudflare DNS only | HTTPS/WSS ingress; separate reachable SFU media ports |
| `casdoor.example.com` | Configured identity host or backend host | OIDC login and token endpoints |

Attach the client domain through Pages' custom-domain setup, not just a DNS
record pointing to a backend IP. The backend host runs one Gateway plus
LiveKit, Redis, the identity service/databases required by the chosen mode,
and Caddy or an equivalent ingress. Private databases and LiveKit's internal
`7880` listener must not acquire public host ports.

Cloudflare's ordinary orange-cloud HTTP proxy can proxy supported HTTPS/WSS
traffic, but not arbitrary UDP or `7881` ICE TCP. DNS-only RTC ingress is the
simplest baseline; it does not hide the SFU public IP or provide Cloudflare
proxy protection for media. Spectrum or TURN services are separate products
and integration decisions; generic transport support is not proof of LiveKit
compatibility. Select a server region close to vehicles/operators and measure
actual customer-network latency, packet loss and reachability. Faster webpage
delivery through Pages does not reduce the vehicle-to-SFU media path latency.

### Frontend publication

Build from the repository root, including the shared package:

```bash
infra/scripts/build-frontend.sh
```

Publish the resulting `frontend/dist/` through Pages Direct Upload or a
controlled CI pipeline. For Git-integrated builds, use repository-root build
context, the command above and output directory `frontend/dist`; pin a supported
Node version and install dependencies as documented in `AGENTS.md`.
The frontend is a static site, not a Gateway running in Pages Functions.

Before upload, replace the generated `frontend/dist/runtime-config.js` with
the **public-only** configuration shown under [Client Deployment](#client-deployment).
The build copies `public/runtime-config.js`, whose repository default is empty.
Cloudflare does not apply `FRONTEND_CONFIG_PATH` mounts or automatically turn
environment variables into browser configuration. Republish configuration
changes together with a compatible frontend release; keep source and deployment
credentials outside the static artifact.

Nginx headers also do not carry over to Pages. Add a `_headers` file directly
to the final upload directory, after the build, for example:

```text
/
  Cache-Control: no-store
/index.html
  Cache-Control: no-store
/runtime-config.js
  Cache-Control: no-store
/main.js
  Cache-Control: no-cache
/main.css
  Cache-Control: no-cache
```

The current build uses fixed `main.js`/`main.css` filenames: do not give them
long-lived immutable caching. Verify the actual response headers after
publication and prevent custom Cloudflare cache rules from overriding them.
Hash routes such as `/#/?page=drive` do not require a catch-all API proxy.
OIDC callbacks must serve the root page and preserve their query parameters.

Generated maps may already be copied into `dist/maps/` by the build. Inspect
the complete artifact before upload: application login does **not** restrict
direct access to Pages static files. Publish only explicitly approved maps;
confidential maps require an access-controlled delivery design, not merely
hiding the map link in the UI. Check current Pages asset size/count limits,
data-location requirements and customer access to Cloudflare before selection.

### Backend ingress and cross-origin configuration

The root Compose file still defines `frontend`, and its cloud Caddy service
depends on that container. `infra/local-dev/Caddyfile` also serves
`CLIENT_DOMAIN` from `frontend:80`. An unchanged
`docker compose --profile cloud up -d --build` therefore is **not** a
backend-only deployment.

To retire the frontend container, first prepare and validate a deployment-specific
Compose configuration and Caddy configuration that omit the frontend service,
its Caddy dependency and the client-domain site block. Preserve the API, RTC
and identity routes, persistent volumes and managed signaling gate. This guide
does not add such an override or change the current default deployment. Retaining
the unused loopback frontend container temporarily is possible, but the server
must not serve or request certificates for the Pages-owned client domain.

Set `CLIENT_ORIGIN=https://client.example.com` so Compose supplies the exact
frontend origin to Gateway `ALLOWED_ORIGINS`. Register the application's actual
OIDC redirect/logout URLs for that domain, and allow browser token exchange
from it as required by the identity provider. Use HTTPS/WSS throughout, OIDC
in production, and the existing public client/PKCE flow; do not introduce
browser client secrets. Production authorization should not broadly allow
arbitrary Pages preview origins.

If the API or identity endpoints use Cloudflare's HTTP proxy, bypass caching
for authenticated/dynamic endpoints and validate that WAF, challenge, rate-limit
and timeout settings do not break device requests, browser token exchange,
streams or WebSocket signaling. Do not make a browser challenge a prerequisite
for vehicle authentication.

### Acceptance and evolution

Before choosing this topology for customer use, verify login/callbacks, API
preflights, observer permissions, three-camera decoded video, session release
and reconnect from actual operator and vehicle networks. A loaded webpage,
`healthz`, or successful WSS handshake alone is not media acceptance. Test the
configured fallback path where UDP is blocked; do not assume TURN is present.

Retain independent frontend/backend release versions and rollback artifacts.
One backend host is a single point of failure. Size SFU egress from subscribed
camera bitrates and viewer counts, then measure CPU, bandwidth and end-to-end
latency; Pages does not carry those media bytes. Separate the media host when
measured contention or availability requirements warrant it, with explicit
private service connectivity and ingress configuration. Do not start multiple
Gateways until SQLite operations storage and authorization/lease/handover
consistency have an approved multi-instance design.

## CI scope

`.github/workflows/ci.yml` runs shared state-machine, React, legacy console and
Gateway checks, validates Compose and builds the primary frontend image.
Vehicle SDK, Cyber, media and hardware acceptance belong to `apollo-base` and
are not covered by this repository's CI. Local cross-component contract checks
are documented in [tests/README.md](../tests/README.md).

## Vehicle Deployment

Vehicle source, native builds and deployment now belong to `apollo-base`:

- `data/sdk-kit` (`@sdk_kit`): authentication SDK/checker and LiveKit media worker.
- `modules/teleop`: vehicle telemetry, control, media and Cyber adapters.
- `modules/guardian` and `modules/canbus`: vehicle arbitration and hardware control.

`remote-infra` retains the browser, Gateway, shared contracts and cloud Compose
stack. It no longer contains `apps/vehicle-edge-cpp`, the Python
`apps/vehicle-edge` runtime, or their C++/Python acceptance runners. Use the
build, configuration and deployment instructions in the matching `apollo-base`
checkout; do not build vehicle binaries from this repository.

Inside the Apollo development environment, from its repository root:

```bash
bazel test --lockfile_mode=off @sdk_kit//tests/... //modules/teleop/... \
  //modules/guardian/... //modules/canbus:canbus_test --test_output=errors
bazel run --lockfile_mode=off @sdk_kit//auth:vehicle_auth_check -- /etc/teleop/device.json
```

The managed enrollment helper remains here at `infra/scripts/install-vehicle-auth.py`.
It installs and verifies a protected device configuration independently of the
vehicle source tree. Preserve per-device credentials, endpoint trust and the
`teleop:vehicle` OAuth scope on both initial and refreshed token requests when
upgrading the external SDK. The scope requirement was fixed on the authentication
branch before the move; compatibility must be checked in the deployed Apollo SDK.

Existing staged binaries and deployment records in
[manual-account-authentication.md](manual-account-authentication.md) describe
pre-migration installations. They are not build instructions for a fresh checkout.
Do not replace a running vehicle process or its protected configuration as part
of a cloud/frontend update. The browser's simulation allowlist, session and
handover checks remain unchanged by this repository move.

## Limitations

The current implementation supports Compose-based integration testing and demos. VideoSession orchestration, LiveKit E2EE, recording, alerting, device management, and real safety actuators remain future work. Do not use this prototype to control a real vehicle without a completed safety review.

## Sources

- Operations and secrets: `docs/operations.md`
- Compose configuration: `docker-compose.yml`
- Caddy configuration: `infra/local-dev/Caddyfile`
- Cloudflare Pages: [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/), [custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/), [headers](https://developers.cloudflare.com/pages/configuration/headers/)
- Cloudflare proxy [network ports](https://developers.cloudflare.com/fundamentals/reference/network-ports/)
- LiveKit [ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
