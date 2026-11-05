# Authentication management MVP and evolution

Status: single-entry automated onboarding implemented and isolated acceptance
validated; manual fallback preserved. Existing production deployment remains
an explicit operator acceptance gate.
This file tracks the agreed delivery scope;
current runtime configuration remains in `docs/authentication.md`.

## Goal and boundaries

### Organization-centered operations integration

The next delivery integrates authentication into the existing operations platform,
not another monitoring console. Preserve `/#/?page=fleet`, `monitor`, `drive`,
`alerts` and `tasks` as the business entry points. The standalone `/#/teleop`
becomes a compatibility redirect after its real viewing/control lifecycle is
reused inside the existing platform.

Use one global personnel identity with trusted organization memberships.
After login, choose an available organization; a single membership enters
directly. All members, not only administrators, need a server-authorized
organization/capability context. An empty membership list must display an
explicit no-organization state, never load mock data as a successful fallback.
Shared organization selection also applies to personnel/vehicle/permission
management. Cross-organization access is rejected by the Gateway.

Display three simple roles: organization administrator, operator and viewer.
Keep existing Casbin actions as the authority; do not silently grant control
to existing administrators. Task dispatch and physical control remain explicit
unavailable capabilities until their execution contracts are implemented.
Platform administration is separate from organization administration.

Changing organizations clears old selections, in-flight requests and realtime
resources. Active control must be safely released before navigation, logout
or organization changes. Keep mock/preview behavior only behind explicit
development selection and identify it visibly.

Acceptance includes real browser login into the root platform, legacy route
compatibility, selected organization filtering, direct `page=drive` navigation,
shared management context, and denial/empty states without synthesized
operational data.

Administrators add people and vehicles, then assign a fixed organization role
and a none/all/selected vehicle range. New personnel default to none (no current
or future vehicle access) and can be assigned vehicles later. People monitor authorized vehicles, explicitly
start video, and optionally acquire simulation control. Vehicles continue HTTPS
telemetry and demand-driven RTC. Business task dispatch and physical actuation
are not part of this release.

Keep Casdoor PKCE/client credentials, embedded Go Casbin, PostgreSQL lifecycle
and policy storage, Redis live leases/fences, LiveKit, and SQLite operations.
Do not introduce long-lived API keys, vehicle WSS, PostgreSQL live leases,
custom roles or another task service in this release.

## Milestones

| Milestone | Delivery | Acceptance |
| --- | --- | --- |
| M0 | Fixed org_admin/viewer/remote_operator roles, trusted issuer/subject binding, explicit manual IdP pilot | No subject/client_id guessing, no first-login administrator |
| M1 | Persistent people/vehicle lifecycle, controlled registration/binding and assignment APIs, organization authorization, opt-in runtime PEP | Default deny, no mixed policy authority or fallback, cross-org and selected-range rejection |
| M2 | Authenticated people/vehicle/permission UI, server correlation and visible failures | No browser secrets or raw policy editor; manual IdP provisioning explicitly identified |
| M3 | Reuse authorized telemetry and viewing/media demand, safe dynamic change gating | Old sessions cannot silently survive permission reduction; no claim that token issuance proves video readiness |
| M4 | Reuse simulation Lease/signature/revision/watchdog chain | No timeout-based fence deletion, no promotion of org_admin into control, no physical driving claims |
| M5 | Verified IdP automation and safe credential delivery/rotation | Durable worker, native invitation/recovery and protected installation/reissue verified with actual isolated v4.25.0; target deployment still requires acceptance |

Use an opt-in managed mode; legacy deployments must retain existing behavior.
Managed mode must reject legacy policy configuration rather than merge it.
Bootstrap runs through an explicit protected operator command/configuration,
not a public endpoint. Database faults must not authorize stale permissions.

The first pilot may use pre-provisioned Casdoor identities with verified binding
by platform operators. This is not automated invitation or credential issuance.
Identity binding is privileged; ordinary organization admins must not bind an
arbitrary existing principal or grant themselves control.

## Diagnostics and verification

Expose identity/binding, authorization, telemetry freshness, RTC/video and
control/handover as separate states. Reuse request_id, stable error codes and
vehicle_auth_check --json. External lifecycle operations need operation_id;
request_id is not an idempotency key.

Validate actual PostgreSQL transactions/constraints, Gateway routes, frontend
tests/type/build, and relevant simulation/viewing boundaries. Include denial,
unknown identities, duplicate registration, database loss and restart behavior.
Never use production credentials or enable physical actuation for validation.

## Evolution triggers

Add push/WSS only when measured polling cost or freshness misses requirements.
Before a second Gateway, validate cross-instance policy/connection freshness.
Change device authentication only after measuring IdP limitations and designing
credential lifecycle. Migrate operations storage only for demonstrated capacity,
backup or maintenance needs. Implement task dispatch after defining idempotency,
cancel/timeout and execution feedback. Qualify physical driving separately.

## Single-entry onboarding increment

Extend the existing Gateway and `/#/admin`, not a new identity service or
second authorization database. One protected operator configuration enables
Casdoor provisioning and notification delivery. Ordinary administrators never
enter token subjects, OAuth secrets or per-vehicle deployment audiences.

- Personnel: submit name/email plus the initial fixed role and vehicle scope
  together, defaulting to no vehicles. Casdoor's native mailed setup link
  performs account recovery/password setup; subsequent login uses the verified
  email/password PKCE flow. Casdoor remains responsible for login and account recovery;
  Gateway owns the trusted binding and business permission transaction.
  Never adopt an existing account solely because its email matches.
- Vehicles: submit customer-local vehicle number/name. Generate a stable ID
  from the trusted creation-organization short code, local number and random
  suffix; keep ownership separate and never rename the ID on transfer.
  Provision a separate confidential client,
  verify its actual access token, persist the exact issuer/subject/audience
  binding and deliver credentials only through short-lived single-use
  installation authorization. Permanent secrets stay out of the admin UI.
- Operations: persist idempotency and progress in the existing PostgreSQL
  database. Reconcile unknown external outcomes before retry. Report failure
  explicitly, with operation ID and safe stage/error codes.
- Fresh identities only: an additive transaction may run alongside existing
  monitoring/RTC sessions if it proves identity/resource uniqueness and
  rechecks the actor's current authority. Initial person binding and role are
  atomic. Existing permission changes, disable, transfers and rebinding retain
  the maintenance/drain boundary.
- Installation: write an owner-only device configuration without overwrite,
  acquire a real OAuth token, verify Gateway identity and vehicle mapping,
  then report authentication installation. This is not a camera or driving
  readiness certificate. Unknown delivery requires explicit recovery, not
  repeated retrieval of an already consumed secret.

Acceptance must launch disposable actual Casdoor and PostgreSQL, exercise
authenticated Gateway routes, capture test notification delivery and execute
the actual installer. Verify duplicate requests, unknown/retried operations,
foreign identity/audience rejection, expired/replayed installation tickets and
continued existing-session service. Preserve static/manual mode when the
automation configuration is absent. Online revocation, multi-instance,
dispatch and physical actuation remain outside this increment.

## Delivery log

- Prior foundation: isolated Casbin/PostgreSQL store, stable Gateway diagnostic
  boundaries and structured C++ auth checker exist; runtime integration pending.
- This iteration: protected bootstrap, persistent management APIs, fixed-role
  and vehicle-range forms at /#/admin, opt-in runtime identity/PEP integration,
  maintenance drain guard and optional PostgreSQL Compose overlay implemented.
- Initial manual-pilot deviation (fresh automatic onboarding now excepted):
  management writes require maintenance and
  whole-deployment drain, persisted token-expiry horizon, Redis handover/session
  checks, absent LiveKit teleop rooms and a persisted 11-minute quiet interval.
  Pin LiveKit v1.13.11; route all public RTC signaling through Gateway's
  maintenance gate. No direct 7880/no-domain bypass. This is not online forced
  revocation.
- Default static mode and the existing vehicle protocol remain available;
  managed driving is allowlisted v2 simulation only, not legacy actuation.
- Validation so far: real PostgreSQL16 whole-Gateway test/vet/race; frontend
  84 tests/typecheck/production build; 49 shared state-machine cases; 7 portable
  CTests; platform JSON contracts and actual C++ Data-to-Gateway-to-frontend
  chain passed. Native Cyber/physical hardware remain separate gates.
- Managed HTTP integration exercises signed RS256/JWKS authentication,
  PostgreSQL binding, registration, assignment, list/observe/simulation control,
  delegation-scope rejection and dependency failure. This uses isolated test
  identities. Additional actual Casdoor v4.25.0 acceptance now covers public
  PKCE, wrong verifier/code replay, independent machine credentials, creation/
  reconciliation, strict scopes and rotation. Provider access tokens pass
  through the production Gateway verifier and PostgreSQL identity/role binding.
- Actual LiveKit v1.13.11 signaling acceptance passed (660.35 seconds):
  WebSocket join, signed server refresh lifetime, old/refreshed join rejection
  during maintenance, real room cleanup and the actual 11-minute persisted
  quiet interval through runtime reconstruction. No accelerated clock.
  External production ingress topology, camera media and physical safety are
  not proven by this loopback signaling test.
- Actual Casdoor ID-token substitution was reproduced, then fixed by rejecting
  signed non-access tokenType values. Valid actual PKCE/machine access tokens
  and legacy providers without that field remain supported.
- Managed writes/token barriers use the dedicated lifetime-lock PostgreSQL
  connection; connection loss cannot fall back to a healthy pooled connection
  and commit outside the single-runtime boundary. Bootstrap requires no running
  managed Gateway. Parallel integration runners need separate databases because
  this exclusivity lock deliberately spans schemas.
- Reproducible runners: tests/casdoor-contract.py and
  tests/managed-auth-chain.py; prerequisites/results in tests/README.md and
  docs/auth-management.md. Temporary containers and configuration are owned
  by each invocation and cleaned on exit.
- Single-entry increment: PostgreSQL-backed operations, bounded retries and
  provider reconciliation; no separate queue/service. Personnel creation
  includes the initial fixed-role/range transaction. Casdoor alone owns native
  invitation/recovery delivery and personnel passwords; no second Gateway SMTP
  configuration. Fresh identities/resources can be added online without
  acquiring the long-lived RTC exclusive lock. Existing rights changes still
  require drain.
- Protected vehicle enrollment uses hashed short-lived single-use tickets,
  AES-GCM pending credentials and exact persisted issuer/subject/audience
  verification. Explicit reissue rotates the old secret; completion erases
  stored recoverable ciphertext. The installer writes owner-only configuration
  without overwrite and checks actual OAuth/Gateway identity before completion.
- Actual acceptance now covers native Casdoor invitation email captured by
  loopback SMTP, verification/reset with browser cookies, subsequent S256 PKCE
  login and viewer authorization; real vehicle creation, credential rotation/
  lost-response recovery, actual Python installation and replay rejection.
  The updated RTC runtime also passed the real 660.41-second quiet barrier.
- Production version/tenant privileges, native Email/CAPTCHA policies, real
  mailbox delivery and exclusive ingress remain operator acceptance gates.
  Existing-account import, general online rotation/revocation, multi-instance
  and physical actuation are not part of this increment.
