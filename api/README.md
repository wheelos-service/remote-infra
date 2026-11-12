# API contracts

This folder holds cross-component API and wire contracts consumed by the
frontend, Gateway, and vehicle clients.

- `schemas/vehicle-control-handover-ack.schema.json` — device handover acknowledgement.
- `schemas/vehicle-control-v2.schema.json` — signed v2 vehicle-control packets.
- `schemas/vehicle-media-demand.schema.json` — device media-demand response.
- `schemas/vehicle-telemetry.schema.json` — vehicle telemetry snapshots.
- `schemas/vehicle-operations-response.schema.json` — read-only operations API response;
  it reuses telemetry definitions from the telemetry schema.

Schema filenames use lowercase kebab-case resource names, an optional purpose
or protocol-major suffix, and the `.schema.json` extension. `$id` values match
their filenames; shared structures use `$ref` instead of duplicated schemas.

The HTTP API's primary/compatibility boundaries are recorded in
[`docs/compatibility.md`](../docs/compatibility.md); current handlers remain in
`teleop-gateway/`. Add language-specific code generation only when the
protocol surface becomes stable enough to justify it.
