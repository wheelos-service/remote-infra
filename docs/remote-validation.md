# Remote Three-Process Validation

The server, vehicle, and operator client can be deployed and restarted independently.

## 1. Server

Run this on the server host. Redis and LiveKit stay private to the Compose network; expose
only the Gateway and LiveKit ports required by remote clients.

Before starting the server, point these DNS records at the server's public IP:

```text
api.example.com -> <server-public-ip>
rtc.example.com -> <server-public-ip>
```

On the server host:

```bash
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
LIVEKIT_API_KEY=teleop_prod_key
LIVEKIT_API_SECRET=<long-random-secret>
AUTH_MODE=oidc
OIDC_ISSUER=https://casdoor.example.com/
OIDC_AUDIENCE=teleop-api
OIDC_JWKS_URL=https://casdoor.example.com/.well-known/jwks.json
CLIENT_ORIGIN=http://127.0.0.1:8000
API_DOMAIN=api.example.com
RTC_DOMAIN=rtc.example.com
VEHICLE_ACL_JSON=[{"user_id":"operator-001","tenant_id":"fleet-a","vehicle_id":"car-001","permissions":["observe","control"]}]
```

Start all server services, including the TLS reverse proxy:

```bash
docker compose --profile cloud up -d --build
docker compose ps
curl https://api.example.com/healthz
curl https://api.example.com/readyz
```

The server firewall must allow these ports:

```text
80/tcp                         # ACME HTTP challenge
443/tcp                        # API HTTPS and LiveKit WSS
7881/tcp                       # LiveKit RTC/TCP fallback
50000-50100/udp                # LiveKit WebRTC media
```

The Caddy proxy maps `https://api.example.com` to the Gateway and
`wss://rtc.example.com` to LiveKit. The Gateway container uses
`LIVEKIT_URL=http://livekit:7880` internally; local vehicle and browser processes must use
the externally reachable `wss://rtc.example.com` address.

Do not expose Redis or the Gateway's container hostname to the public network.

## No-Domain Temporary Validation

If the server has no DNS name yet, use its public IP for temporary development validation.
This mode is HTTP/WS only and must not be used as a production deployment. It publishes
Gateway and LiveKit directly, so the server firewall must allow `8080/tcp`, `7880/tcp`,
`7881/tcp`, and `50000-50100/udp`.

On the server:

```bash
docker compose -f docker-compose.yml -f docker-compose.no-domain.yml up -d --build
curl http://<server-ip>:8080/healthz
curl http://<server-ip>:8080/readyz
```

For a development token setup, use `AUTH_MODE=dev` and open the client with `dev=1`:

```text
http://127.0.0.1:8000/?dev=1&backend=http://<server-ip>:8080&livekit=ws://<server-ip>:7880
```

The client will prompt for a development token in the existing format:

```text
operator-001|fleet-a|observer,controller
```

Start the local vehicle with the same IP endpoints:

```bash
PYTHONPATH=apps/vehicle-edge/src python3 -m vehicle_edge.vehicle_node \
  --gateway http://<server-ip>:8080 \
  --vehicle-id car-001 \
  --device-config /etc/teleop/device.yaml \
  --livekit-url ws://<server-ip>:7880 \
  --publish-video
```

This direct-IP mode has no browser-trusted TLS certificate and provides no encrypted
transport. Switch to the cloud profile and real HTTPS/WSS certificates before exposing the
system beyond a controlled test network.

For production, set `AUTH_MODE=oidc`, configure the Casdoor issuer, audience, JWKS URL, and
vehicle ACL. Do not use the development token parser on an internet-facing deployment.

## 2. Vehicle

Install dependencies on the vehicle, provision the credential file as root-owned mode 0600,
and start the vehicle process independently from the server:

```bash
cd apps/vehicle-edge
python3 -m pip install -r requirements.txt
sudo install -o root -g root -m 0600 device.yaml /etc/teleop/device.yaml
PYTHONPATH=src python3 -m vehicle_edge.vehicle_node \
  --gateway https://api.example.com \
  --vehicle-id car-001 \
  --device-config /etc/teleop/device.yaml \
  --livekit-url wss://rtc.example.com \
  --publish-video
```

The vehicle needs outbound HTTPS/WSS access to the server. It does not need Redis, Casdoor
JWKS, or the Gateway's private network address.

For a container deployment, pass the same arguments after the image name:

```bash
docker run --rm --network host \
  -v /etc/teleop/device.yaml:/etc/teleop/device.yaml:ro \
  wheelos-vehicle-edge \
  --gateway https://api.example.com \
  --vehicle-id car-001 \
  --device-config /etc/teleop/device.yaml \
  --livekit-url wss://rtc.example.com \
  --publish-video
```

## 3. Operator client

Run the static client on the operator workstation. This process does not need Redis or the
vehicle credential:

```bash
cd apps/operator-console
npm run build
python3 -m http.server 8000 --directory dist
```

Open the page with the externally reachable endpoints. Do not use `http://livekit:7880`
or `http://teleop-backend:8080` from the local machine:

```text
http://127.0.0.1:8000/?backend=https://api.example.com&livekit=wss://rtc.example.com&casdoor=https://casdoor.example.com
```

In production, serve the client itself over HTTPS and configure the Casdoor OIDC application
for the client origin.

## 4. Independent verification order

1. Server: `/healthz` and `/readyz` return 200.
2. Vehicle: token refresh succeeds, then the vehicle joins the `teleop-<vehicle_id>` room.
3. Client: operator authentication succeeds and the vehicle appears through the Gateway ACL.
4. Observer: `video/acquire` returns `mode: ACTIVE`.
5. Controller: acquire control with an in-memory Ed25519 public key; the control session and
   video session must both be active.
6. Release control and verify that observer video remains active. Release the last viewer and
   verify grace period, then `STANDBY`.
7. Stop LiveKit or the vehicle process and verify the vehicle watchdog enters its safe state.

## 5. Local automated checks

```bash
cd apps/teleop-gateway && go test ./...
cd apps/vehicle-edge && PYTHONPATH=src python3 -m unittest discover -s tests -p 'test*.py' -v
python3 tests/e2e_secure_receiver.py
python3 tests/e2e_control_session_receiver.py
```

The VideoSession tests use an in-memory Redis server and do not require an external Redis
process. The control lease integration tests require a reachable Redis instance and can be
run with `REDIS_URL=redis://127.0.0.1:6379/0`.
