# Vehicle Edge Deployment

The recommended vehicle deployment is Docker Compose with one V4L2 camera. The
vehicle process only makes outbound connections to the Gateway and LiveKit; it
does not need to expose an HTTP port.

## Prerequisites

- Linux host with Docker Engine and the Compose plugin
- A camera visible as `/dev/video0` (`v4l2-ctl --list-devices`)
- Network access from the vehicle to the Gateway and LiveKit URLs
- A root-owned, mode `0600` device credential file

Install the credential file on the host:

```bash
sudo install -d -m 700 /etc/teleop
sudo install -o root -g root -m 600 config/device.example.yaml /etc/teleop/device.yaml
# Edit /etc/teleop/device.yaml with this vehicle's credentials.
```

## Start with Docker Compose

Run these commands from `apps/vehicle-edge`:

```bash
export GATEWAY_URL=https://api.example.com
export LIVEKIT_URL=wss://rtc.example.com
export VEHICLE_ID=car-001
export CAMERA_DEVICE=/dev/video0

docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml logs -f vehicle-edge
```

For a temporary IP-based deployment:

```bash
export GATEWAY_URL=http://118.145.117.118:8080
export LIVEKIT_URL=ws://118.145.117.118:7880
```

The server must actually publish those ports and allow them through its
firewall. The production setup should use HTTPS/WSS through the reverse proxy.

## Verify camera access

Before starting the container:

```bash
v4l2-ctl --list-formats-ext -d /dev/video0
docker compose -f docker/docker-compose.yml run --rm vehicle-edge --help
```

The application requests the ACTIVE profile, reads back the resolution and FPS
accepted by the V4L2 driver, and logs the actual format before publishing. The
Compose file maps the selected host device to `/dev/video0` inside the
container, so the application always uses camera index `0`.

For a camera whose full fisheye image is not 16:9, leave the width and height
unset so the driver keeps its default mode. To select a specific supported mode,
pass the dimensions and FPS explicitly, for example:

```bash
--camera-width 1280 --camera-height 960 --camera-fps 30
```

Choose the values from `v4l2-ctl --list-formats-ext -d /dev/video0`.

## Operations

```bash
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs --tail=100 vehicle-edge
docker compose -f docker/docker-compose.yml restart vehicle-edge
docker compose -f docker/docker-compose.yml down
```

Do not put `client_secret` or access tokens in Compose environment variables or
command-line arguments. Keep them in the mounted credential file.

## When to use native systemd instead

For a host without Docker, run the same command in a dedicated Python virtual
environment under a systemd service. Native systemd has less overhead and
slightly simpler V4L2 permissions, but Docker Compose is easier to reproduce
and update across multiple vehicles.
