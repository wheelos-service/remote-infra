# Docker Compose Deployment

## Architecture

```text
Browser
  | HTTPS/WSS
  +-- client.example.com   -> Caddy -> frontend Nginx
  +-- api.example.com      -> Caddy -> Teleop Gateway
  +-- rtc.example.com      -> Caddy -> LiveKit

Vehicle edge agent
  | outbound HTTPS/WSS
  +-- api.example.com and rtc.example.com
```

The browser and vehicle run outside the server containers. Docker Compose runs
the primary frontend Nginx, Gateway, LiveKit, Redis and optionally Caddy.

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

## CI scope

`.github/workflows/ci.yml` runs shared state-machine, React, legacy integration,
Gateway and portable C++ SDK checks, validates Compose and builds the primary
frontend image. Portable SDK CI uses `EDGE_ENABLE_LIVEKIT=OFF`; actual LiveKit,
Cyber/hardware and physical handover are separate acceptance gates, not claimed
by this CI. Use `tests/driving-ui.py` with the documented native toolchain for
the real browser/C++ simulation chain.

## Vehicle Deployment

The current vehicle runtime is the C++ SDK. Follow its
[build and installation guide](../apps/vehicle-edge-cpp/README.md), with
`camera_layout=three`, `camera_source=simulation`, and `control_mode=simulation`
for the three-camera simulator. Physical actuation remains disabled.

### Legacy Python v1 reference

The following commands are for the legacy Python/standalone-console workflow,
not the React v2 simulator. The vehicle requires outbound access to the API and RTC domains and must not expose inbound ports:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r apps/vehicle-edge/docker/requirements.txt
PYTHONPATH=apps/vehicle-edge/src python -m vehicle_edge.vehicle_node \
  --gateway https://api.example.com \
  --vehicle-id car-001 \
  --livekit-url wss://rtc.example.com \
  --device-config /etc/teleop/device.yaml
```

## Limitations

The current implementation supports Compose-based integration testing and demos. VideoSession orchestration, LiveKit E2EE, recording, alerting, device management, and real safety actuators remain future work. Do not use this prototype to control a real vehicle without a completed safety review.

## Sources

- Operations and secrets: `docs/operations.md`
- Compose configuration: `docker-compose.yml`
- Caddy configuration: `infra/local-dev/Caddyfile`
