# Prototype note

This document is retained as historical context for the first LiveKit proof of concept.
Its startup commands and authentication flow are obsolete. Use [`SPEC.md`](./SPEC.md),
[`LOCAL-DEV.md`](./LOCAL-DEV.md), and [`OPERATIONS.md`](./OPERATIONS.md) for current workflows.

## Historical status

The current vehicle path uses LiveKit as the only realtime transport, OIDC/JWKS for
production Gateway authentication, and a unique OAuth client credential stored in
`/etc/teleop/device.yaml` with mode `0600` and root ownership. Browser access tokens
and Ed25519 private keys remain in memory only.
