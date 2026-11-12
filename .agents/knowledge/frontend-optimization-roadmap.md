# Frontend follow-up roadmap

This document tracks work that still depends on backend capabilities. Current
frontend behavior and deployment boundaries are documented in
[`frontend/README.md`](../../frontend/README.md) and the user guides in
[`docs/`](../../docs/readme.md).

## Alert response workflow

- Define a vehicle incident with one active response context per vehicle, one
  owner, and multiple collaborators.
- Keep device recovery separate from human response state; support notes,
  verification, closure, and recurrence.
- The backend must provide authorization, optimistic concurrency, persistence,
  audit history, and complete incident history before the frontend integrates
  collaborative updates.
- Do not simulate cross-user collaboration with local frontend state.
- Validate concurrent updates, authorization failures, offline/retry behavior,
  recurrence after closure, refresh, and cross-user consistency.

## Remote-driving readiness data

- The UI distinguishes telemetry, video, network, authorization, and control
  readiness; unknown or unconnected states must not appear ready.
- Entering the workspace is view-only. A control request must separately
  confirm the target vehicle and obtain server authorization.
- Integrate authoritative session, lease, and video measurements when their
  backend contracts are available.
- Validate stale data, another operator holding the lease, disconnection, and
  release behavior.
- Do not imply that a displayed readiness state proves a real vehicle control
  connection or physical handover.
