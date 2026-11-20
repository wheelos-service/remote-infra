# Shared teleoperation state machines

Transport-free input intent, keyboard scheduling, gamepad mapping and
camera-view intent. The primary React frontend depends on this local package.
It has no Gateway client, session lease, signing key, v1/v2 wire encoder,
session safety policy or vehicle writer. Window/page interruption only disarms
local input here; the frontend owns control-session release and fault policy.
The React adapter rejects gear/mode intents and converts normalized values to
the signed v2 integer contract.

```bash
npm ci --prefix packages/teleop-shared
npm --prefix packages/teleop-shared test
```

The React build runs the shared build before type-checking and bundles the
result. Build the frontend Dockerfile with the repository root as context.
See [release capabilities](../../docs/compatibility.md) and
[payload schemas](../../api/schemas/) for the browser/server contracts.
