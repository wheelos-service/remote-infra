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

The client and vehicle do not need to run in the cloud. Media sessions use
short-lived LiveKit tokens and a room named `teleop-<vehicle_id>`. Independent
fleet telemetry does not join that room. The new native vehicle entry point and
its currently supported capabilities are documented in
[`apps/vehicle-edge-cpp/README.md`](../apps/vehicle-edge-cpp/README.md); the Python
command below is the separate legacy entry point, not the C++ media service.

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

### Persistent platform data and upgrades

Compose persists replay fences, viewing demand and control handover guards in
`redis-data`, with AOF `appendfsync always` and `noeviction`. It stores operations
history in the Gateway's `operations-data` volume. These are separate durability
boundaries; Redis latest state is not a substitute for SQL business history.
Use one Gateway instance for the SQLite operations store. Do not mount its WAL
database over NFS or assume separate replica-local files provide shared history.
Scaling the operations service requires a shared database migration.

Telemetry ingestion commits Redis latest state before SQLite history. A SQL
failure returns 503 and may leave an accepted latest snapshot without history.
Only the exact current unarchived packet can be retried without refreshing its
original receipt; an older missing packet cannot override Redis replay fencing.
History explicitly exposes sequence gaps. Monitor 503 rates and disk capacity;
do not treat Redis success alone as durable business-record acceptance.

Back up both stores with application-consistent procedures. Use SQLite's online
backup API or stop the Gateway before copying the database and associated WAL;
copying only an actively written `.db` file is not a consistent backup. Protect
backups as vehicle operational data, restrict filesystem access, and define the
deployment's retention and disk monitoring policy. Retention limits in the
Gateway are per vehicle; disk capacity must account for the configured fleet.

Do not delete volumes or restore old control/replay records to restart a stuck
session. A stale Redis restore can resurrect authority or erase replay guards.
Before migrating from the previous ephemeral Redis configuration, take the
system out of remote-control service and independently confirm every vehicle's
handover. Existing ephemeral state is not automatically recovered by adding a
volume. Restore/reprovision only under that same maintenance boundary.

HTTP control release returns `202 PENDING`; lease expiry does not permit a
different vehicle or operator to take over. The device's separate current
revision acknowledgement is required. `CONTROL_HANDOVER_ACK_ENABLED` defaults
to false and must remain false until a native revocation and physical handover
policy has been approved and bench-tested. There is no browser force-unlock.
See the Gateway README for the wire contract and explicit limitations.

### Data SDK capacity and export

Vehicle detail, alerts and tasks pages read the authenticated `/data` read model.
It includes cloud event/task retention counts, pending/unknown tasks,
unacknowledged events and the latest device `/data/diagnostics`. Device counters
cover retained/pending outbox and inbox entries and fault keys. Check publication
and receipt ages: a reachable Gateway or an old zero backlog is not proof of an
online healthy device. UI warnings start at 80% retention; off-platform
pager/email/webhook escalation is not configured.

Cloud limits remain 10000 events and 1000 tasks per vehicle; each local SDK table
retains at most 10000 records by default. Acknowledged records still occupy
deduplication storage. Exports and human acknowledgements do **not** free capacity.
Exhaustion explicitly rejects new writes (cloud HTTP 507), rather than losing
transitions or forgetting old task identities.

Observers with the vehicle ACL may fetch non-destructive exports through:

```text
GET /api/vehicles/{id}/data/records?kind=events&after=0&through=0
GET /api/vehicles/{id}/data/records?kind=tasks&after=0&through=0
```

Each response contains at most 100 records, `through` (initial high-water cursor),
`next`, and `has_more`. Continue with returned `next` as `after`, keeping `through`
unchanged until `has_more=false`. Events include their current human
acknowledgement; tasks include their latest report. New inserts above `through`
are excluded; reports and acknowledgements may change between pages. Exports
support investigation/archival, not transactionally consistent backup or restore.
The UI produces a download only after all pages pass schema/identity/cursor checks.

Before reaching capacity:

1. Review cloud counters and device diagnostics, including freshness.
2. Export business records, restrict file access and verify record counts.
3. Take a consistent SQLite backup using its online backup API (or stop the owning
   service and preserve database/WAL together), plus the existing Redis backup.
4. Investigate unknown tasks by original request identities; never fabricate a
   failure or blindly resubmit motion requests.

Automatic rotation, deduplication-window expiration and purging are not implemented.
Do not truncate tables/delete the device database to clear an alarm; that destroys
fault state or permits replay. A rotation policy must specify retained
identity/tombstone semantics and recovery before destructive maintenance is enabled.
SQLite remains single-owner/local disk, without multi-replica/NFS guarantees.

Deploy the updated Gateway before the new frontend: the strict UI requires
`can_manage`, `capacity` and nullable `diagnostics` in `/data`. An older vehicle
SDK may omit diagnostics uploads (displayed as unknown); upgrade its Auth + Data
packages to enable device counters. This addition requires no migration beyond
the existing SQLite schema v2. The `/operations` compatibility contract remains
unchanged.

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
