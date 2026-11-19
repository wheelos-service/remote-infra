# Shared teleoperation state machines

Transport-free input intent, keyboard/pointer scheduling, gamepad mapping and
camera-view intent. The primary React frontend depends on this local package.
It has no Gateway client, session lease, signing key, v1/v2 wire encoder or
vehicle writer. The React adapter rejects gear/mode intents and converts
normalized values to the signed v2 integer contract.

```bash
npm ci --prefix packages/teleop-shared
npm --prefix packages/teleop-shared test
```

The React build runs the shared build before type-checking and bundles the
result. Build the frontend Dockerfile with the repository root as context.
See [release capabilities](../../docs/compatibility.md) and
[payload schemas](../../api/schemas/) for the browser/server contracts.
