# Docker Compose Deployment

## Architecture

```text
Browser
  | HTTPS/WSS
  +-- console.example.com  -> static operator console
  +-- api.example.com      -> Caddy -> Teleop Gateway
  +-- rtc.example.com      -> Caddy -> LiveKit

Vehicle edge agent
  | outbound HTTPS/WSS
  +-- api.example.com and rtc.example.com
```

The browser and vehicle run outside the server containers. Docker Compose runs the Gateway, LiveKit, Redis, and optionally Caddy.

## Server Preparation

Use a Linux host with Docker Compose. Point DNS records for the API and RTC domains to the host:

```text
api.example.com  A  <server-ip>
rtc.example.com  A  <server-ip>
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
API_DOMAIN=api.example.com
RTC_DOMAIN=rtc.example.com
```

Start the services and verify health:

```bash
docker compose --profile cloud up -d --build
docker compose ps
curl https://api.example.com/healthz
curl https://api.example.com/readyz
docker compose logs -f teleop-backend livekit caddy
```

## Client Deployment

Host the built `apps/operator-console/dist/` directory with static Web hosting, Nginx, a CDN, or another authenticated Web server. For local verification:

```bash
cd apps/operator-console
npm run build
python3 -m http.server 8000 --directory dist
```

A production client uses the API and RTC endpoints below:

```text
https://client.example.com/?backend=https://api.example.com&livekit=wss://rtc.example.com
```

Use OIDC Authorization Code + PKCE. The client may receive public OIDC values such as `clientId` and endpoint URLs, but never a client secret, access token, or LiveKit API secret.

## Vehicle Deployment

The vehicle requires outbound access to the API and RTC domains and must not expose inbound ports. Install the dependencies and start the vehicle agent with its protected device configuration:

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
