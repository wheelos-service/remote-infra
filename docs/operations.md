# Operations Guide

This document describes the runtime boundaries, startup procedures, and secret handling for the current prototype.

## Component Relationship

```text
Browser operator console
    | HTTPS/WSS
Cloud apps/teleop-gateway and infra/
    |-- Teleop Gateway
    |-- LiveKit
    |-- Redis
    `-- Caddy (optional HTTPS/WSS entry point)
    ^
    | outbound HTTPS/WSS
Vehicle edge agent
```

The client and vehicle do not need to run in the cloud. Both obtain short-lived LiveKit tokens from the server and join a room named `teleop-<vehicle_id>`.

## Secret Classification

Never commit or publish the following: `LIVEKIT_API_SECRET`, Casdoor `client_secret`, device secrets, `TURN_SECRET`, Redis/database passwords, TLS private keys, webhook secrets, or the operator Ed25519 private key.

Short-lived operator and vehicle LiveKit tokens, Casdoor access tokens, and TURN credentials must not be logged, placed in URLs, or persisted in unsafe storage.

API domains, RTC domains, LiveKit key IDs, Casdoor client IDs, room names, vehicle IDs, and operator public keys may be shared as runtime public configuration when appropriate.

## Cloud Startup

Set `.env` using server-side environment or a Secret Manager:

```dotenv
LIVEKIT_API_KEY=teleop_cloud_key
LIVEKIT_API_SECRET=<random-long-secret>
CLIENT_ORIGIN=https://client.example.com
API_DOMAIN=api.example.com
RTC_DOMAIN=rtc.example.com
```

Start and check the stack:

```bash
docker compose --profile cloud up -d --build
docker compose ps
curl https://api.example.com/healthz
curl https://api.example.com/readyz
docker compose logs -f teleop-backend livekit caddy
```

Expose only the Caddy entry point and required LiveKit media ports. Never expose Redis publicly.

## Client Startup

For local testing:

```bash
cd apps/operator-console
npm run build
python3 -m http.server 8000 --directory dist
```

For production, host the static client at `https://client.example.com/` and use:

```text
https://client.example.com/?backend=https://api.example.com&livekit=wss://rtc.example.com
```

Production authentication uses OIDC Authorization Code + PKCE. The browser receives only public OIDC configuration; access tokens and Ed25519 private keys remain in page memory.

## Vehicle Startup

The vehicle needs a unique ID, independent device credentials, API and RTC addresses, and camera/controller configuration. It requires outbound access only and must not receive the LiveKit API secret.

```bash
PYTHONPATH=apps/vehicle-edge/src python -m vehicle_edge.vehicle_node \
  --gateway https://api.example.com \
  --vehicle-id car-001 \
  --livekit-url wss://rtc.example.com \
  --device-config /etc/teleop/device.yaml
```

The device configuration must be root-owned with mode `0600`.

## Production Boundaries

Use `AUTH_MODE=oidc` in production. Keep `CLIENT_ORIGIN` equal to the actual browser origin. Use HTTPS/WSS, short token TTLs, structured audit logs, and a reviewed Vehicle ACL. The prototype is not production safety certification and does not yet integrate a real CAN/ECU emergency-brake actuator.

## Sources

- Architecture: `docs/architecture.md`
- Deployment: `docs/deployment.md`
- Local development: `docs/local-dev.md`
