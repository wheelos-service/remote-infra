# Shared teleoperation state machines

Transport-free input intent, keyboard/pointer scheduling, gamepad mapping and
camera-view intent. Both browser clients depend on this local package.
It has no Gateway client, session lease, signing key, v1/v2 wire encoder or
vehicle writer. The React adapter rejects gear/mode intents and converts
normalized values to the signed v2 integer contract; the legacy sender owns v1.

```bash
npm ci --prefix packages/teleop-shared
npm --prefix packages/teleop-shared test
```

Consumers run the shared build before type-checking or serving. The React build
bundles it; the legacy console copies its JavaScript to `dist/shared/` and uses
an import map. Build either Dockerfile with the repository root as context.
See [architecture](../../docs/architecture.md) and
[compatibility boundaries](../../docs/compatibility.md) for current contracts.
