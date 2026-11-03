# API contracts

This folder holds cross-platform protocol contracts used by `apps/*` services.

- `schemas/` — JSON Schema / Protobuf IDL for DataChannel control messages and auth.

The HTTP API's primary/compatibility boundaries are recorded in
[`docs/compatibility.md`](../docs/compatibility.md); current handlers remain in
the Gateway. Add language-specific code generation only when the protocol
surface becomes stable enough to justify it.
