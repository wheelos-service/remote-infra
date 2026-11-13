# Register a vehicle

This guide covers server-side registration. Vehicle software installation,
camera configuration, and Apollo setup are delivered separately. A prepared
vehicle must be able to generate an enrollment machine code and complete
credential installation with this Gateway.

## Device identity and approval

The normal flow is:

```text
Persistent device Ed25519 key -> signed enrollment request -> administrator approval
  -> organization + vehicle_id -> dedicated OAuth client -> installation confirmation
```

The public key identifies the device; signatures prove possession of its private
key. The server stores its binding separately from the human-readable vehicle
name. A machine code identifies a temporary application, not a permanent vehicle.
Administrators supply the display name during approval; the server generates a
vehicle number when none is supplied. No name, serial number, platform, client
secret, runtime template, or OAuth endpoint is required from the vehicle operator.

The vehicle keeps its private key locally. A new code for an already bound key
is a recovery request for the original vehicle and organization, not a new
vehicle. Recovery requires approval and the server's maintenance/drain guard.
Cloning the software private key clones this identity; it is not hardware
attestation. Control-session signing keys are separate from enrollment keys.

## Give the vehicle operator the endpoints

For a split-DNS LAN deployment, use the same endpoints as public clients:

- Gateway and console: `https://console.example.com`
- Login service: `https://login.example.com`
- LAN root CA certificate: `~/.local/state/teleop/root.crt` on the server

Configure internal DNS to resolve both names to the deployment's LAN IP.
Transfer only the public certificate over a trusted channel and compare its
SHA-256 fingerprint with the setup output. The vehicle must trust it inside
the environment running its software; host trust does not automatically
configure a runtime container. IP-only LAN deployments, including existing
saved state, are unsupported; migrate identity/data explicitly to a
domain-based deployment before connecting vehicles.
Never transfer the server's CA key, administrator password, or state directory.

For public deployment, use publicly trusted certificates on Gateway, console
and the Casdoor token endpoint instead of distributing a private CA.
Cloudflare Universal SSL automatically issues/renews the edge certificate for
covered proxied hostnames; use Full (strict) for the origin connection.
Origin CA certificates belong on that origin hop, not on a directly accessed
vehicle endpoint. DNS-only origins need their own publicly trusted certificate
or an explicitly provisioned private CA. WebRTC media/TURN reachability remains
separate from HTTPS/WebSocket proxying.

The vehicle operator configures the Gateway endpoint (`gateway_url`), verifies
HTTPS, and runs the SDK `vehicle_bootstrap --gateway-url HTTPS_URL` to obtain a
machine code, grouped SHA-256 fingerprint, and the server-configured console
URL. Preserve any existing device keys, credentials, and enrollment state during
recovery.
The SDK automatically gates `/api/v1/version` (`status=ok`,
`protocol_version=1`, `enrollment_protocol=teleop-enrollment-v1`) before
enrollment/OAuth, and checks host kernel time discipline without requiring
systemd. The returned issuer delegates an exact HTTPS origin for the token
endpoint; it does not use parent-domain matching and cannot protect against
complete compromise of the trusted Gateway.

## Approve in the dashboard

1. Sign in as an administrator and select the intended organization.
2. Open **车辆管理 → 注册车辆**.
3. Enter **车辆名称** and the **机器码** supplied by the vehicle operator.
4. Select **核对车辆** and confirm the device fingerprint and expiry with that
   operator over a trusted channel. The full fingerprint is shown by default;
   explicitly check the fingerprint confirmation checkbox before approval.
   Confirmation resets on lookup, details or administrator context changes.
   Approval sends `expected_fingerprint`; Gateway rejects missing or nonmatching
   values against the current enrollment key, including recovery and retries.
   This binds explicit API confirmation to that key; it does not prove a human
   actually performed the out-of-band comparison.
5. Select **确认注册车辆**. For recovery, use **确认恢复车辆**; recovery retains
   the original identity and organization.
6. Check **接入与邀请进度** until the vehicle has saved its credentials,
   verified authentication, and confirmed installation.

A code alone does not prove installation or healthy telemetry. If it expires,
the vehicle operator obtains a fresh code while preserving the device identity.
After activation, verify current telemetry and, separately, live camera frames.
Enrollment does not configure cameras or prove control readiness.

## Keep runtime deployment separate

After registration, use the vehicle runtime's generated safe defaults for the
first telemetry check. Do not copy OAuth fields into its runtime configuration
or require a database simply to verify current telemetry.

Deploy optional capabilities independently:

- **Durable data:** configure an application database and its protected parent
  directory through the vehicle deployment process, separate from enrollment
  state. The Apollo foreground runtime provides `--prepare-data-directory`
  to provision its configured parent with private permissions; opt in with
  `"data_store_path": "/var/lib/teleop/data/data.sqlite3"` and retain
  `"task_mode": "disabled"` for health-only deployment. Database activation
  does not enable task polling. No systemd service is required.
  A durable event/task queue does not imply historical telemetry
  replay.
- **Video:** configure the LiveKit endpoint, installed worker, and actual camera
  capture integration. Managed Gateway startup does not require `LIVEKIT_URL`
  when only enrollment and telemetry are deployed; when `LIVEKIT_URL` is set,
  the pinned LiveKit version and gated RTC ingress remain required, and
  credential-recovery drain checks fail closed if LiveKit room state cannot be
  verified. Selecting an encoded-frame source alone does not open a camera. RTC
  demand can come from viewing or control; camera publication has its own
  demand gate.
- **Control:** keep disabled during telemetry/video acceptance. This release's
  native-driving gate must not be bypassed with a simulation allowlist.

Vehicle runtime commands and hardware settings belong to its own release, not
to the server registration form. Apply configuration changes and restart at a
safe maintenance stop. A successful middleware publication is not proof of
physical actuation.

Only SDK bootstrap is the current vehicle enrollment entrypoint. The old
`infra/scripts/install-vehicle-auth.py` manual-ticket installer mixes runtime
and authentication and must not be used with this SDK; the console no longer
offers manual vehicle ticket issuance. The old Python CLI now exits before
parsing, prompting, networking or writing; there is no compatibility migration. The Apollo installer
wrapper also runs foreground bootstrap only, never systemd.
For protected non-root execution, use account-owned explicit bootstrap paths,
or administrator-provisioned root/dedicated-group readable runtime files;
directory traversal and credential rotation must preserve protection. Prepare
the optional database directory as the actual runtime account.

Retirement disables the vehicle, revokes OAuth mappings, unbinds enrollment
keys and invalidates tickets. Fresh authorization rejects old signed OAuth
tokens before expiry. Redis control/session indexes and active viewing demand
are purged; viewing leases retain released tombstones so old sessions cannot
renew/reacquire after reusing a vehicle ID. Room eviction is requested too;
actual LiveKit disconnect behavior still needs deployment acceptance.

Assign human operator access through [Administration](auth-management.md) only
when appropriate. Native driving is blocked in this server release pending
handover support; a simulation acknowledgement is not physical handover.
