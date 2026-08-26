# API contracts

This folder holds cross-platform protocol contracts used by `apps/*` services.

- `schemas/` — JSON Schema / Protobuf IDL for DataChannel control messages and auth.

The HTTP API is documented alongside the component workflows in `docs/` and the
Gateway handlers. Add language-specific code generation only when the protocol
surface becomes stable enough to justify it.
