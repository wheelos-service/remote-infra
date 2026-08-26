# Local Development

## 1. Start the Server

From the repository root:

```bash
cp .env.example .env
docker compose up -d --build redis livekit-config livekit teleop-backend
docker compose ps
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
```

The default local setup uses `AUTH_MODE=dev` and `CLIENT_ORIGIN=http://localhost:8000`.

## 2. Start the Operator Client

In a second terminal:

```bash
cd apps/operator-console
npm run build
python3 -m http.server 8000 --directory dist
```

Open:

```text
http://localhost:8000/?backend=http://localhost:8080&livekit=ws://localhost:7880&dev=1
```

Click Sign in and enter the local development credential `operator-001|fleet-a|operator`. The credential remains in page memory and must not be placed in a URL, bookmark, or configuration file.

Add `&access=observer` for read-only monitoring. The default `access=controller` creates a short-lived Control Session and renews its lease.

## 3. Start the Vehicle Agent

Install dependencies:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r apps/vehicle-edge/docker/requirements.txt
```

Start the vehicle agent with a protected device configuration:

```bash
PYTHONPATH=apps/vehicle-edge/src python -m vehicle_edge.vehicle_node \
  --gateway http://localhost:8080 \
  --vehicle-id car-001 \
  --livekit-url ws://localhost:7880 \
  --device-config /etc/teleop/device.yaml
```

The vehicle obtains a `teleop:vehicle` token using its device credentials, refreshes it before expiry, obtains a short-lived LiveKit token, and joins the `teleop-car-001` room.

## 4. Acceptance Checklist

- Server: `healthz` and `readyz` return HTTP 200.
- Vehicle: logs show the room connection and a published test video track.
- Client: the video track appears and the state reaches `DRIVING` or `MONITORING`.
- Controller: control-session creation enables the control buttons.
- Vehicle: stopping the control path causes the watchdog safety action.
- Server: `teleop-backend` logs contain the corresponding structured audit events.

## 5. Stop the Environment

```bash
docker compose down
```

Development credentials are for integration testing only. Production requires `AUTH_MODE=oidc`, OIDC issuer/audience/JWKS configuration, HTTPS/WSS, and a reviewed Vehicle ACL. Do not expose secrets, device credentials, or production endpoints during local testing.

## Sources

- Test workflow: `.agents/skills/testing/SKILL.md`
- Deployment workflow: `docs/deployment.md`
- Runtime configuration: `docs/operations.md`
