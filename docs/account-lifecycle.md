# Account lifecycle and installation packages

This increment extends the managed authorization pilot on the `frontend` platform. The primary management page is `/#/admin`, and installed device configuration targets `apps/vehicle-edge-cpp`. Static authorization is unchanged. Managed authorization still requires one Gateway, PostgreSQL, OIDC, pinned LiveKit v1.13.11, exclusively gated `/rtc`, and the existing maintenance/drain boundary.

## Authority and state

| Action | Organization administrator | Platform administrator | Runtime requirement |
| --- | --- | --- | --- |
| Fresh automatic onboarding | Within authorized organization and allowed initial roles | Yes | Existing additive guard |
| Bind manually verified identity | No | Yes | Maintenance/drain |
| Add already-bound member | Yes | Yes | Maintenance/drain |
| Remove membership | Yes, last-admin protected | Yes, protected recovery authority | Maintenance/drain |
| Rejoin removed membership | Yes | Yes | Maintenance/drain; viewer/none default |
| Remove vehicle | Own organization only | Yes | Maintenance/drain |
| Reactivate removed vehicle | No | Yes, exact verified subject required | Maintenance/drain; valid retained identity |
| Revoke vehicle credentials | Own organization only | Yes | Maintenance/drain before local denial |
| Replace installed device credentials | Own organization, automatic provisioning required | Yes | Drain before denial and final activation |
| Transfer vehicle | No | Yes, exact subject and active destination required | Global drain; remains disabled |
| Confirm external/manual provider revocation | No | Yes, with verification record | Maintenance/drain |
| Read diagnostics/audit/lifecycle operations | Own managed organizations | Managed organizations | Server-side authorization |

A membership removal retains the user's global identity and other memberships. Rejoin creates a fresh viewer/none assignment; it does not restore prior grants. Active none-scope members retain organization-wide observation. Admin/viewer roles do not authorize driving; managed control remains explicitly allowlisted v2 simulation.

Vehicle removal changes the vehicle to `disabled`, retaining its immutable ID, organization, binding, and history. It cancels pending onboarding, clears pending ciphertext, revokes installation tickets, and removes selected vehicle grants. If a selected assignment loses its last vehicle it becomes `none`, preserving a valid role policy. Organization-wide `all` assignments remain dynamic and apply if the vehicle is later reactivated.

Same-organization reactivation requires a platform administrator to reverify and submit the exact retained subject. It rejects revoked identities, credential-revocation history for the current binding generation, and incomplete automatic installation. It never restores selected grants. A revoked device cannot be reactivated with the old identity through this endpoint.

## Lifecycle APIs

All routes below are under `/api/admin/organizations/{org_id}`. Existing registration and assignment routes remain available.

| Method and suffix | Effect |
| --- | --- |
| `POST /members/{user_id}/remove` | Remove membership and its organization grants. |
| `POST /members/{user_id}/rejoin` | Explicitly restore membership as viewer/none. |
| `POST /vehicles/{vehicle_id}/remove` | Disable and remove from active fleet. |
| `POST /vehicles/{vehicle_id}/reactivate` | Reverify retained identity and reactivate a safely removed vehicle. |
| `POST /vehicles/{vehicle_id}/credential-revocations` | Deny the local binding and persist provider revocation work. |
| `POST /vehicles/{vehicle_id}/credential-rotations` | Replace an installed or recoverable managed identity. |
| `POST /vehicles/{vehicle_id}/transfer` | Change ownership; keep vehicle disabled until reviewed reactivation. |
| `POST /lifecycle-operations/{operation_id}/installation-ticket` | Issue a replacement package ticket before redemption. |
| `GET /lifecycle-operations` | Most recent 100 scoped operations. |
| `GET /lifecycle-operations/{operation_id}` | Read a durable result after a lost response. |
| `POST /lifecycle-operations/{operation_id}/retry` | Manually retry failed provider reconciliation. |
| `POST /lifecycle-operations/{operation_id}/confirm` | Platform attestation of completed external/manual provider revocation. |
| `GET /people/{user_id}/registration` | Personnel membership/binding/onboarding diagnostics. |
| `GET /vehicles/{vehicle_id}/registration` | Device binding/installation/onboarding diagnostics. |
| `GET /audit` | Paginated authorization and onboarding events. |

Initial lifecycle mutation bodies require `idempotency_key` (canonical UUID), `expected_version` (current authorization version), and `reason` (1–500 printable characters). Vehicle reactivation also requires `verified_subject`. The management context now includes `authorization_version`; assignment writes accept an optional `expected_version` for compatibility with older clients. The updated UI supplies it.

The same actor, key, and canonical payload returns the same operation. Reusing a key with a different payload or actor conflicts. Version conflicts require rereading state and deliberate reconfirmation. Timeout is an unknown result, not a failure guarantee: retry the same key/payload or inspect operation history. A drain rejection applies nothing and does not queue a future permission change.

Retry/confirm bodies contain `reason`. Retry is accepted only from failed provider state; manual confirmation only from `manual_required` and only by a platform administrator. Repeating an already-applied transition returns a conflict; read status to reconcile instead of blindly repeating it.

### Provider revocation

Local denial, ticket invalidation, cancellation, version advancement, audit/outbox, and provider intent commit together. Provider work is serialized with onboarding and lifecycle mutations and reconciled outside the database transaction. Binding versions fence stale completion. Local denial remains in force if the provider is down, the worker restarts, or retries are exhausted.

For Gateway-created Casdoor applications, the adapter verifies the immutable application identity, replaces its secret with a fresh random value that is never delivered or retained, and rereads the application to confirm the replacement. An absent application is already revoked. A lost update response is reconciled by rereading; mismatched application metadata fails closed. This invalidates new grants using installed credentials; it does not erase already-issued JWTs. The Gateway's revoked binding rejects those JWTs locally, and pre-existing RTC authority was handled by maintenance/drain before the mutation.

Provider states are `pending`, `failed`, `manual_required`, `confirmed`, or `not_required`. Automatic attempts are bounded to three with delayed retries. For manual bindings, operations must revoke at Casdoor independently and record verification before a platform administrator confirms it. Do not infer client IDs from OIDC subjects or treat a local denial as provider confirmation.

## Version-1 installation package

The admin page obtains an existing five-minute single-use installation ticket, then creates a temporary JSON download containing exactly:

- `schema_version`: integer `1`.
- `gateway_url`: trusted public HTTPS origin.
- `vehicle_id`: immutable vehicle ID.
- `operation_id`: onboarding or replacement operation UUID.
- `expires_at`: timezone-qualified timestamp, informational; server expiry remains authoritative.
- `installation_ticket`: temporary bearer ticket.

The package contains no permanent client secret or OAuth token. Treat the ticket as a secret: use a controlled transfer channel, no URL/query parameters, logs, screenshots, persistent browser storage, or repository files. A browser cannot set the downloaded file's mode; protect it before use:

```sh
chmod 600 ./vehicle-enrollment.json
python3 infra/scripts/install-vehicle-auth.py \
  --gateway https://gateway.example.invalid \
  --vehicle-id vehicle-example \
  --package ./vehicle-enrollment.json
```

The installer requires the package origin and vehicle ID to match those explicit trusted arguments. Origin comparison is conservative: use the same canonical origin spelling. It rejects unsupported versions, duplicate/extra fields, malformed/expired metadata, oversized input, unsafe permissions, and symlinks. The loopback HTTP exception remains explicitly test-only.

Existing `--ticket-file` and hidden prompt input remain supported. `--package`, `--ticket-file`, and `--verify-existing` are mutually exclusive. Output remains `/etc/teleop/device.json`, exclusively created with mode 0600 and fsync, with control/tasks/media disabled. The installer never overwrites an existing credential.

After exchange, OAuth, auth/me, device-auth-check, and installation-complete must all succeed. If the file was saved but verification/completion was interrupted, use the same trusted arguments with `--verify-existing`; do not redeem again. For initial onboarding, if redemption consumed the ticket but no configuration was saved, explicitly reissue through administration; this rotates pending installation material and invalidates prior tickets. For replacement onboarding, start a new replacement operation instead: a consumed replacement identity cannot be reissued. Delete the local package after successful installation.

## Diagnostics and audit

Personnel diagnostics distinguish membership/binding from provider provisioning and invitation state. An accepted invitation request is not proof of mail delivery, password setup, or login. Vehicle diagnostics distinguish installation from authenticated telemetry freshness. The UI uses the existing vehicle state endpoint and server receipt timestamp; missing/dependency-failed presence is unknown, not online. Replayed telemetry cannot make a device fresh. Video and driving readiness remain in the existing monitoring/control flows.

Audit accepts `actor`, `target`, `action`, `outcome`, `from`, `until`, `limit`, and `cursor`. Dates are RFC3339, outcome is `applied` or `failed`, default limit is 25, maximum 100. Unknown/duplicate query fields and invalid bounds are rejected. Cursors bind organization, filters, timestamp, and event ID. Authorization is checked within a repeatable-read transaction before returning data. Onboarding events use `onboarding.` action prefixes and version 0 when they do not change policy; authorization mutations retain their committed version.

Provider attempts and confirmation appear in lifecycle details and audit events. Raw provider messages, credentials, ciphertext, and ticket hashes are excluded. Denied requests continue through existing structured diagnostics. This increment does not add unrestricted audit exports or cross-organization search.

## Migration, rollout, and recovery

Migration `004_lifecycle.sql` adds cancellation metadata, lifecycle operation persistence, and scoped indexes. Migration `005_device_recovery.sql` adds replacement operations/tickets and first-authenticated observation. It is explicitly embedded in `Store.Migrate`, is additive, and runs transactionally on startup. Preserve the existing PostgreSQL volume and protected onboarding config/encryption key. No new secret settings or services are required.

Deploy the compatible Gateway/schema before the frontend. First pilot a fresh non-actuating vehicle and verify package installation and pending-secret cleanup. Exercise removals and revocations only after enabling maintenance, ending sessions, and allowing recorded token horizons and the real 11-minute quiet interval to expire. A failed drain check must not be bypassed by deleting Redis keys, fences, or database horizons.

Monitor lifecycle pending/failed counts, operation age, sanitized error codes, installation verification failures, drain rejections, and unknown/stale presence. These facts are available through the management routes and existing diagnostics; never attach secrets to monitoring events.

A frontend rollback can hide new controls while denial and reconciliation remain active. Do not run an older Gateway that ignores `cancelled_at`: it could resume a cancelled operation. Keep maintenance and the current backend, or apply a reviewed forward fix. Never switch to static ACLs or restore a stale authorization snapshot to bypass a failed release; both can resurrect revoked grants. Reconcile all revocation/cancellation history before any disaster recovery restore.

Custom roles, public organization creation, alternate invitation-code authentication, and precise IdP login tracking remain outside this increment.

## Included follow-ons

### First authenticated observation

Personnel diagnostics expose `first_authenticated_at`, recorded only after the managed runtime resolves a verified human identity and its authenticated handler completes with a successful 2xx response. It is a Gateway observation, not Casdoor password completion or exact login time. The database sets it once; the single Gateway caches successful recording to avoid repeated writes. Device, denied, and unbound requests do not record a human observation. Restart preserves the timestamp.

### Cross-organization vehicle transfer

Platform administrators may `POST /vehicles/{vehicle_id}/transfer` with the usual lifecycle body plus `destination_org_id` and `verified_subject`. Both organizations must be active and the exact existing binding reverified. The current drain guard is global to the single Gateway, so both source and destination sessions/token horizons are checked.

Transfer keeps the vehicle disabled, clears source selected grants and installation material, cancels incomplete replacement work, preserves the ID and trusted binding, and records audit in both organizations. It rejects incomplete initial installation and revoked/pending identities. The destination platform administrator must explicitly reactivate after review. Destination `all` assignments then apply; source selected grants are never restored. Source administrators cannot read the transferred vehicle through source-scoped diagnostics.

### Installed-device replacement rotation

`POST /vehicles/{vehicle_id}/credential-rotations` uses the lifecycle idempotency/version/reason body and requires automatic provider management. It accepts installed Gateway-managed credentials, recovery from a pending/cancelled replacement identity, or a previously revoked installed credential after provider revocation is confirmed. Failed replacement provisioning may be superseded after that confirmation; a concurrent pending replacement is rejected. It drains, disables the vehicle, denies the old binding, revokes tickets, and persists encrypted replacement intent. The worker first confirms revocation of the previous provider credential, then creates/reconciles and verifies a **new provider application/client and exact subject**. Old JWTs cannot match the replacement binding.

Replacement state is `pending`, `awaiting_install`, `failed`, `completed`, or `cancelled`, exposed as `installation_status` alongside provider revocation status. Pending replacement identities are accepted only by GET auth/me, GET that vehicle's device-auth-check, and POST that vehicle's installation-complete. They cannot post telemetry, request media, or use control/data APIs. Verification requires the exact replacement subject, audience, scope, and current binding generation.

When awaiting installation, `POST /lifecycle-operations/{operation_id}/installation-ticket` issues the same version-1 package ticket contract. Before redemption, a ticket may be reissued with pending credential rotation. After any successful redemption, reissue is rejected: if configuration was lost, start a new replacement operation with a new provider identity. This prevents an older pending JWT from activating reissued credentials. If configuration was saved, use `--verify-existing` instead.

Stop the device service before replacing configuration. Move the existing credential file into an operator-controlled owner-only backup directory and explicitly select the new installation output; do not overwrite or delete it automatically. The existing installer then writes a new 0600 JSON file, preserving disabled control/tasks/media. Final activation requires the existing maintenance/drain guard again, the current subject/client, a consumed non-revoked ticket, the current generation, and continued manager authority. Activation clears replacement ciphertext. A lost completion response can be retried without reactivating anything twice.

Removal, transfer, or membership loss cancels unfinished replacement work and invalidates its tickets. Failed provider/provisioning work remains locally denied and supports explicit authorized retry. Completed replacements cannot be reopened; a later rotation creates a new operation and identity.

## Acceptance and operational limits

The local acceptance run on 2026-11-05 used disposable PostgreSQL, Casdoor 4.25.0 with an isolated SMTP sink, and LiveKit v1.13.11. It exercised native invitation/password setup/PKCE, actual installer package exchange, credential denial and replacement, and the real 660-second RTC quiet interval followed by guarded replacement activation. The complete test/build record is in [the implementation plan](../plan.md#implementation-evidence).

Use a protected PostgreSQL backup and verify restoration in an isolated environment before rollout. Preserve the database, pending encrypted operations, and matching encryption key together; test migration on the restored copy before deploying the compatible Gateway. Failed migrations roll back transactionally. A compatible restart/forward fix preserves denial and pending reconciliation; a schema downgrade or pre-feature backend rollback is not a supported recovery path.

Human membership removal is organization-scoped. Global human IdP account disabling remains a privileged provider operation and does not instantly invalidate existing JWTs; use maintenance and remove affected memberships through the guarded management flow. This increment adds no global-human revocation HTTP endpoint or CLI command. The existing `auth-admin` CLI bootstraps verified platform identity only.

The acceptance configuration is a single-Gateway, non-actuating pilot. No production deployment, production email delivery, physical vehicle operation, multi-Gateway availability, or real fleet rollout is claimed.
