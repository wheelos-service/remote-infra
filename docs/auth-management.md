# Managed authentication and onboarding

The implementation/evolution checklist is
[`.agents/auth-management-plan.md`](../.agents/auth-management-plan.md).
This pilot keeps Casdoor authentication, embeds Casbin in the Gateway and
stores identity bindings, organization/vehicle lifecycle and policies in
PostgreSQL. Redis control fences, SQLite operations and the existing C++
HTTPS/media-demand protocol are not replaced.
Casdoor's existing account database is separate; adding the authorization
PostgreSQL database does not migrate or replace Casdoor's own storage.

## Single-entry automated onboarding

### User registration by link (no email)

In **人员管理**, enter a username, choose **管理员 / 操作员 / 查看者**, and
select **生成注册链接**. Once ready, **复制注册链接** copies a single-use
Casdoor signup link. Send that link to the user yourself. The user sets their
password on Casdoor and then signs into the console. No email provider is
needed for this flow. Usernames use 2–64 ASCII characters, start with a letter,
and may contain letters, digits, and single hyphens or underscores.

The Gateway reserves an onboarding operation, creates a Casdoor invitation
restricted to that username and browser application (`quota: 1`, seven-day
expiry), and waits for Casdoor signup. It verifies the provider's immutable user
ID, invitation name/code, application, organization, account state and creation
time before atomically binding membership and role. It never adopts an existing
username or matches accounts by email. Pending invitations grant no access.
The worker checks registration at five-second intervals; allow a few seconds for
the new account to appear in the organization. Expired links cannot be retried;
submit the username again to issue a fresh invitation.

The initial scope is `none` for viewers/operators and `all` for administrators.
Assign operator vehicle access separately in **权限管理**. Only platform
administrators can invite another administrator, preserving the existing role
boundary. Final binding rechecks the inviter's authority.

| Endpoint | Contract |
| --- | --- |
| `POST /api/admin/organizations/{org_id}/onboarding` | `{kind:"person", name, role, idempotency_key}`; role is `org_admin`, `remote_operator`, or `viewer`; no email |
| `GET /api/admin/organizations/{org_id}/onboarding` | Progress includes `awaiting_registration`; never returns invitation credentials |
| `POST /api/admin/organizations/{org_id}/onboarding/{id}/registration-link` | Organization manager only, empty body; returns `{url, expires_at}` while waiting; `Cache-Control: no-store` |

Configure the pinned Casdoor **4.25.0** browser application once:

- Enable password login and signup; disable self signup.
- Make **Username**, **Password**, **Confirm password**, and **Invitation code**
  visible and required. Hide **Email**, **Phone**, and **Email and phone**.
- Set the application's homepage to the public console URL and retain its PKCE
  redirect URIs. Grant the protected management client `get-application`,
  `get-user`, `get-invitation`, and `add-invitation` access in the intended tenant.

This uses Casdoor's native [invitation contract](https://github.com/casdoor/casdoor/blob/v4.25.0/object/invitation.go)
and [signup provenance](https://github.com/casdoor/casdoor/blob/v4.25.0/controllers/account.go).
The invitation code is encrypted in Gateway storage, shown only on explicit
manager request, and cleared after binding. Do not log or persist copied links
in browser storage. The legacy email onboarding API remains available for
existing integrations, but the registration UI never requests or sends email.

### Vehicle-initiated device-code registration (no client certificate)

Managed deployments with `AUTHORIZATION_ONBOARDING_CONFIG_FILE` configured also
accept vehicle-initiated enrollment. Static/manual deployments do not expose
these endpoints. No vehicle client certificate is needed; HTTPS server
certificate validation remains mandatory. Private-CA deployments require the
server's public root certificate in each client's trust store, including inside
the Apollo runtime container. Follow the
[CA setup steps for a new vehicle](add-vehicle.md#1-install-the-server-ca-on-each-new-vehicle)
to copy the public certificate, verify its fingerprint, install it and test HTTPS.

Follow [Add a vehicle](add-vehicle.md) on the vehicle: edit the server IP and
HTTPS port in `gateway_url` and `console_url` in
`/etc/teleop/bootstrap.json`. Then run
`sudo /usr/local/libexec/vehicle_bootstrap --config /etc/teleop/bootstrap.json`
to obtain the machine code. The guide includes the complete bootstrap JSON,
protected paths, and a safe device template for a fresh installation. Keep
`allow_insecure_localhost` and `allow_legacy_complete_404` false for HTTPS
deployments. No device credentials are in the bootstrap JSON.

The vehicle bootstrap generates and persistently protects an Ed25519 software
key, submits a signed request without vehicle metadata and displays an
eight-character user code (shown as **机器码** in the dashboard). A manager signs into `/#/admin`,
selects the correct organization and enters **车辆名称** and **机器码** under
**车辆管理 → 注册车辆**. **核对车辆** shows the public-key fingerprint and expiry;
**确认注册车辆** approves the administrator's display name. The dashboard does
not require generating or copying JSON. Vehicle numbers are generated by the server.
The key proves possession, without manufacturer attestation. Approval
atomically reserves the existing Casdoor onboarding operation and binds the key;
the background worker provisions the independent machine client as before.
Nothing in this flow grants operator control permission.

| Endpoint | Authentication / result |
| --- | --- |
| `GET /api/admin/organizations/{org_id}/device-enrollments/setup` | Bound OIDC manager; only configured `gateway_url`, `console_url`; never derived from request Host |
| `POST /api/v1/device-enrollments` | Signed device request; returns secret `device_code`, display-only `user_code`, expiry and polling interval |
| `POST /api/v1/device-enrollments/token` | Device code plus signature; pending/provisioning/failed/denied/expired/active status, or a five-minute key-bound installation ticket |
| `POST /api/v1/device-enrollments/complete` | Code, ticket and signature; delivers only that vehicle's existing OAuth configuration |
| `POST /api/admin/organizations/{org_id}/device-enrollments/lookup` | Bound OIDC manager and `{user_code}`; returns non-secret confirmation details |
| `POST /api/admin/organizations/{org_id}/device-enrollments/{id}/approve` | Same management check; `{name}` for a new key (`vehicle_number` remains optional for existing clients), `{}` for recovery |
| `POST /api/admin/organizations/{org_id}/device-enrollments/{id}/deny` | Same management check and `{}`; rejects a pending request |

Public requests contain `request_id` (canonical UUID), `public_key` (raw 32-byte
Ed25519 base64url without padding), `device_code`,
`ticket`, `timestamp` (Unix seconds), `nonce` (fresh UUID for every HTTP attempt)
and `signature` (raw 64-byte base64url). Sign the newline-joined fields below,
without a trailing newline:

```text
teleop-enrollment-v1
<create|poll|complete>
<request_id>
<public_key>
<legacy_name_or_empty>
<legacy_serial_or_empty>
<legacy_platform_or_empty>
<device_code>
<ticket>
<timestamp>
<nonce>
```

New requests omit `name`, `serial`, and `platform`. Their three positions in
the v1 signing string remain empty lines. Creation uses empty code/ticket;
polling uses an empty ticket. Legacy clients may still include validated,
signature-bound metadata on creation; saved pre-upgrade create requests retain
it for idempotent retries. Polling and redemption allow only omitted or empty
metadata. Historical database columns are retained for those retries, while
lookup responses omit them. The administrator supplies the final vehicle name
on approval. The server checks
the signature and a two-minute clock window, persistently rejects reused nonces,
limits request rates and enforces a five-second polling interval. Pending codes
expire after fifteen minutes; approval extends installation eligibility to
twenty-four hours. A new request UUID refreshes the device/user code while
keeping the same persistent key and previously bound vehicle/client IDs.

Unlike the legacy bearer-only installer, proof-authenticated retries can retrieve
the same pending credential after a lost HTTP response. A fresh signature/nonce
is required, the ticket must remain unexpired, and the legacy
`/api/vehicle/install` endpoint refuses these key-bound tickets. The vehicle must
atomically persist the root-owned mode-0600 configuration, verify OAuth and its
exact Gateway vehicle binding, then call the existing authenticated
`installation-complete` endpoint. That confirmation marks the enrollment active
and erases pending credential/ticket ciphertext; possession of a code or ticket
alone cannot reactivate or retrieve it.
Both the standalone bootstrap and runtime authentication SDK explicitly request
OAuth scope `teleop:vehicle`. A token returned by Casdoor without that scope is
not sufficient evidence of successful Gateway authentication.

| Failure | Recovery |
| --- | --- |
| Network/timeout/5xx | Keep the key and request ID; bounded jittered backoff, not new registrations |
| Polling too fast/429 | Observe `Retry-After`/minimum interval |
| Expired/unavailable code | Generate a new request ID/code, retaining the same device key |
| Explicit denial | Stop; never continually generate new codes to evade rejection |
| Provider provisioning failure | Keep the operation and code; administrator retries the existing onboarding operation |
| Lost credential response | Retry proof-authenticated redemption; an expired ticket can be replaced by polling |
| Ticket expires during redemption | `410 ENROLLMENT_TICKET_EXPIRED`; discard only the ticket and poll the same approved enrollment, without a new code or approval |
| Confirmed OAuth client-credential rejection | Refresh enrollment code using the same key; manager approves recovery for the original vehicle |
| Gateway scope/mapping denial, clock/proof error, disabled lifecycle | Surface the diagnostic; do not rotate credentials or silently recreate a vehicle |

Recovery never accepts another organization/vehicle binding or overwrites an
inactive identity. Rotating an already provisioned client's secret remains
behind the existing maintenance/drain guard: a revoked secret does not revoke
previously signed JWTs or active RTC/control authority. Software keys and OAuth
secrets remain cloneable if the vehicle filesystem is compromised; this MVP is
not TPM-backed attestation or physical-driving certification.

Progress is available in three separate places:

- The administrator's onboarding operation exposes `status`, `stage` and
  `error_code`, keyed by the enrollment's `operation_id`. The vehicle-management
  panel follows provisioning and installation; an approved application is not
  yet a completed installation.
- The vehicle persists its request and phase in protected `enrollment.json`.
  Safe troubleshooting can inspect only `request_id`, `status`, `stage`,
  `failures`, `last_error_code`, `last_error_hint`, `last_http_status` and
  `next_attempt_at`; never dump the complete state, key or device configuration.
  `journalctl -u vehicle-bootstrap.service` shows the human code, deduplicated
  retry/provisioning/blocked stage diagnostics and terminal messages. Exit `0`
  also means graceful cancellation: require local `status=installed` and
  completed backend installation, not exit status alone.
- Gateway diagnostics include request correlation/error codes; enrollment and
  onboarding audit events retain approval/delivery history in PostgreSQL.

The example independent timer checks authentication after boot and every ten
minutes after a run becomes inactive, with up to sixty seconds of jitter. It
does not receive immediate authentication-failure events from a running Teleop
process. Existing-client recovery additionally requires the Gateway's global
maintenance/quiet window (at least eleven minutes and any longer issued-token
horizon); enabling maintenance alone does not immediately permit rotation.
Registration completion does not start Teleop, reload its credentials, establish
vehicle telemetry, or grant remote driving permission.

### Unified organization operations entry

The normal operations entry is `/#/`, with `?page=fleet`, `monitor`, `drive`,
`alerts` or `tasks` inside the hash. Authentication is shared across operations
and `/#/admin`; moving to organization settings does not create another login
session. The former standalone teleop route and redirect have been removed.
Mock operations are available only through explicit `?preview=1` outside the
hash and remain visibly identified as non-real data.

After Casdoor login, `GET /api/organizations/context` returns `mode: "managed"` and the caller's
trusted active organizations, roles, operation scopes (`scope`, `vehicle_ids`)
and management capabilities. All members
can select their organization, not only administrators. Vehicle requests carry
the selected organization and the Gateway validates membership and resource
ownership before returning data. A missing organization or authorization
produces an explicit empty/denied state, never synthesized fleet data.

The same authenticated endpoint exists in default/static deployments and returns
`mode: "static"`, an empty `organizations` array and `control_vehicle_ids` derived
from the existing registered vehicles, signed operator roles and static ACLs.
The single operations platform uses this explicit context without requiring or
inventing managed organization membership, sending no organization-selection
header. Vehicle visibility, video access and control remain enforced by the
existing static Gateway authorization. Missing/failed context responses never
fall back to static mode.

The selected organization is shared with the administration workspace.
Existing known identities can be added to the current organization through
the protected member-binding operation using their verified subject, not by
email-based account merging. New personnel continue to use the invitation
flow below. Arbitrary identity registration remains platform-privileged.

The three displayed roles are administrator, operator (`remote_operator`) and
viewer. Every trusted active organization member automatically receives the
Casbin baseline `vehicle.read`, `camera.live.view` and safe `task.read` for all
active vehicles owned by that organization, including later registrations.
This intentionally supersedes the previous `none`-means-no-read behavior for
both new and existing memberships, without rewriting stored policies or scope.
`none` now means no execution; `selected` and `all` limit explicitly granted
operations, not reading. Viewers and administrators gain no control action.
Control still requires a valid lease, fencing and simulation session. Task
dispatch remains unavailable; its page shows the existing organization vehicle
directory read-only. The operational alert feed is also explicitly unavailable.
An authenticated navigation shell does not prove these execution paths exist.

Active control blocks navigation, organization switching and logout until
safe release. Changing organizations clears selected resources; request and
viewing-session cleanup retain the organization in which they were created.

The operating pages have separate responsibilities: vehicle monitoring uses
the realtime/health/vehicle-information detail tabs with explicit video start;
remote driving uses the driving workbench. Alert and task pages keep their own
navigation, toolbar and unavailable-service states, not an embedded fleet
overview. Developer-oriented authorization explanations belong in this guide,
not permanent banners in each operating page. Action errors and control
release/simulation safeguards remain visible when relevant.

The existing `/#/admin` can use Gateway-managed onboarding when
`AUTHORIZATION_ONBOARDING_CONFIG_FILE` points to a protected operator
configuration. With that option disabled, the manual pilot below remains
available. Static deployments are unchanged.

The administration workspace has three tabs:

- **车辆管理**: searchable vehicle directory, name/machine-code registration, and
  vehicle-only onboarding progress/installation actions.
- **人员管理**: username and role form, copyable Casdoor registration links,
  and registration progress; **配置权限** opens the selected person's assignment.
- **权限管理**: edit a person's role and vehicle scope, inspect current assignments,
  and expand the role reference. Existing permission changes still require
  maintenance/drain; switching tabs does not bypass backend checks.

Technical subject/operation identifiers are under expandable details rather than
mixed into the main list. Installation tickets are cleared when switching tabs;
pending onboarding operations continue to be tracked.
The administration header has only **返回运营平台** and logout; it reuses the
shared organization context and does not advertise separate monitor or Mock entries.

Administrators submit a username and role, or a vehicle name. Operation range
defaults to `none`: the member can read and monitor all own-organization active
vehicles but cannot drive, control or execute tasks. Later use the existing
personnel-assignment form to explicitly grant an operation role and selected/all
operation scope. Existing permission changes
still require maintenance/drain; `org_admin` is an explicit exception requiring
`all`, not the default onboarding role.

The Gateway provisions and
reconciles the Casdoor identity, commits the trusted binding and personnel
permissions, and displays persistent operation progress in the same page.
Subjects and per-vehicle deployment audience lists are no longer operator
form inputs. Casdoor still owns passwords, login and account recovery.

### One-time operator setup

For the isolated LAN acceptance environment on `10.0.39.103`, use
`https://10.0.39.103:8443/#/admin` and click **管理员登录**. The account in
`administrator.txt` belongs to the test organization, not Casdoor's built-in
system console. Trust the generated `root.crt` on the testing workstation first.
The public certificate is also served at `/test-root-ca.crt`; verify it against
the server copy before trusting it. `https://10.0.39.103:8445` is an authenticated
test mailbox: messages are captured locally, not delivered to real email accounts.

`infra/scripts/authentication-test.py --state <protected-directory> all` prepares,
builds, starts and verifies this simulation-only stack. The existing state directory
must be outside Git, owned by the operator and mode `0700`. It holds the generated
Compose configuration, CA and protected `administrator.txt` and
`mail-credentials.txt` files. Reuse that directory to preserve the test identities;
do not publish its contents. This environment does not expose real vehicle
actuation or LiveKit media ports.

Use the supported Casdoor `4.25.0` contract and the existing public browser
application as described above for link registration. The following Email provider
configuration is needed only by legacy email-based clients: configure the `forget` rule, password
recovery and an invitation/recovery template containing `%s` (the verification
code) and Casdoor's native `%link` placeholder:

```html
<p>Complete your WheelOS account setup.</p>
<reset-link><p><a href="%link">Set your password</a></p></reset-link>
<p>Verification code: %s</p>
```

Set Casdoor's trusted `origin`/`originFrontend` to its actual public HTTPS
origin. The native link includes the intended username and a short-lived
verification code, not an administrator-assigned password. Casdoor removes
the reset-link block when the request host is not trusted; acceptance must
check the real delivered link, not merely a successful send response. Users
open it, verify/set their own password in Casdoor and return to the platform
login. Actual pinned-version acceptance verifies email-plus-password PKCE
login after setup. Never log the full setup link or mail body.

**SMTP is configured only in
Casdoor**, not a second time in Gateway. Account setup and verification codes
are sent by Casdoor; the Gateway does not collect or set personnel passwords.
If the application's policy requires interactive CAPTCHA for that request,
automated sending fails visibly; it must not bypass or disable CAPTCHA.
Rate-limited/unknown delivery results remain durable, retry after at least
70 seconds and stop after three attempts. A successful send is not proof of
mailbox delivery or first login.

Casdoor remains the authentication authority, not merely an email relay.
Day-to-day administrators use only WheelOS; the mail provider and public
application are configured once in Casdoor. WeChat QR login is an optional
Casdoor identity-provider configuration requiring its own application
credentials and callbacks. It is not enabled by this increment. Existing
email accounts must not be silently merged with a new WeChat identity.

Reuse the existing read-only `/etc/teleop-auth` mount
(`AUTHORIZATION_POLICY_DIR` on the host). Put an effective-Gateway-user-owned,
mode `0600` regular `onboarding.json` there, plus a separate mode `0600` file
containing a base64-encoded random 32-byte encryption key. Back up the key
separately from PostgreSQL; losing it prevents recovery of pending credentials.
Do not regenerate it on every restart.

```json
{
  "supported_version": "4.25.0",
  "casdoor_url": "https://auth.example.com",
  "jwks_url": "https://auth.example.com/.well-known/jwks",
  "management_client_id": "<dedicated server-side management client>",
  "management_client_secret": "<protected management secret>",
  "casdoor_organization": "wheelos",
  "browser_application": "wheelos-browser",
  "certificate": "<configured Casdoor signing certificate name>",
  "gateway_url": "https://api.example.com",
  "console_url": "https://console.example.com",
  "encryption_key_file": "/etc/teleop-auth/onboarding.key"
}
```

Use the actual discovery `jwks_uri`, certificate and application URLs, not
unverified example values. Set `console_url` for deployments with a separate
console host; when omitted it defaults to `gateway_url` for compatibility.
The dedicated management application needs the
Casdoor permissions required for account/client creation and reconciliation,
application/provider inspection and invitation delivery; do not expose its
credentials to the public browser application. Verify its privileges in the
authorized target tenant before enabling automation.

Set only `AUTHORIZATION_ONBOARDING_CONFIG_FILE=/etc/teleop-auth/onboarding.json`
in the existing managed deployment configuration and recreate the Gateway.
Invalid/incomplete protected configuration fails startup, rather than falling
back to manual provisioning. Initial platform administrator bootstrap remains
the protected one-time procedure below.

Fresh onboarding can run alongside existing monitoring and RTC connections.
This exception applies only to proven-new identities/resources; it does not
permit rebinding an existing identity or changing an existing user's rights.
Existing assignment changes continue to require maintenance and drain.

Vehicle installation uses a short-lived single-use enrollment token, not a
permanent secret displayed in the browser. Copy it to the installation
operator through an approved protected channel, then on the vehicle run:

```bash
python3 infra/scripts/install-vehicle-auth.py \
  --gateway https://api.example.com --vehicle-id truck-001
```

The tool prompts without echo, refuses redirects/insecure remote endpoints,
writes `/etc/teleop/device.json` with owner-only permissions without overwrite,
obtains an actual OAuth access token and verifies the Gateway vehicle mapping.
Create the destination directory beforehand with appropriate ownership and
without group/world write permission. `--output` selects another protected
configuration path. If verification fails after saving, use
`--verify-existing` with the same arguments; do not redeem again.

Lost enrollment responses require explicit reissue from the operation, which
rotates the client secret. Previously issued JWTs may survive until expiry;
this recovery mechanism is not online revocation. A completed installation
cannot be used as a general credential-rotation interface.

The operation distinguishes registration, pending installation and completed
authentication installation. It does not certify telemetry freshness, camera
frames, remote-driving readiness or physical safety. Permanent credentials
are encrypted in PostgreSQL with an operator-owned key kept outside that
database, and are not returned by operation/list APIs.

### Vehicle identifier rule

The current registration form asks only for the vehicle name. Approval generates
a stable local number `vehicle-<first 12 enrollment UUID hex characters>`.
Existing API clients may still supply a customer-local number such as `truck-001`
(1–24 ASCII letters/digits/dot/underscore/hyphen, first character alphanumeric).
The server creates:

```text
v-<organization UUID short code>-<local vehicle number>-<random operation suffix>
v-12ab34cd-truck-001-8f02a31d65b746cb
```

The organization code comes from the authenticated management context, never
a user-entered customer name. The random suffix and database primary key
provide uniqueness; idempotent retries preserve the same generated ID.
The same customer-local number is reserved only once within its organization;
different organizations may reuse it. A duplicate registration returns a
conflict rather than creating a second vehicle.
This is an identifier, not an authentication secret. Keep it immutable through
customer/organization transfers; ownership remains separate server-side data.
The short organization code records creation context, not current ownership.
No new customer-code table is needed just to name vehicles. Existing explicit
vehicle IDs remain supported by the legacy/manual API.

## Manual fallback prerequisites

A platform operator must first provision the public browser application,
people and independent vehicle confidential clients in Casdoor. Verify the
actual JWT issuer and subject in an authorized test environment; a Casdoor
username or OAuth client ID is not necessarily the token subject. Never paste
a token or secret into the management forms.

Without automated onboarding configured, the management UI records already
verified subjects and assigns business permissions. In that fallback it does
not create Casdoor accounts, send invitations, distribute vehicle secrets or
rotate credentials. Enable the protected onboarding configuration above only
after target-deployment acceptance. A saved vehicle is not proof
that credentials were installed or that the vehicle can drive.

Only a protected platform bootstrap may establish the first administrator.
There is no public registration or first-login administrator. Subject binding
is a platform-operator capability, not a way for organization administrators
to take over arbitrary existing people or vehicles.

## Administrator workflow

Before first use, build the Gateway image and start only the private database:

```bash
docker compose -f docker-compose.yml -f docker-compose.authorization.yml build teleop-backend
docker compose -f docker-compose.yml -f docker-compose.authorization.yml up -d authorization-db
```

Create an operator-owned mode `0600` JSON file outside the repository. It must
contain `org_id` and `user_id` (canonical UUIDs chosen once), `org_name`, `name`,
`issuer` (exactly the configured `OIDC_ISSUER`) and `subject` (the verified
administrator access-token subject). Run bootstrap **before starting Gateway**;
do not use it to bypass the running instance's drain guard.

```bash
docker compose -f docker-compose.yml -f docker-compose.authorization.yml run --rm --no-deps \
  --user "$(id -u):$(id -g)" \
  --volume /absolute/protected/bootstrap.json:/run/auth-bootstrap.json:ro \
  --entrypoint /usr/local/bin/auth-admin teleop-backend \
  --input /run/auth-bootstrap.json
```

The command uses the service's server-only database URL, applies additive
migrations and transactionally creates the explicit platform administrator.
An exact repeat is a no-op; conflicting bindings fail, rather than resetting
an existing administrator. The file must be owned by the command's effective
user; symlinks, non-regular files and group/world-accessible input are rejected.
The same PostgreSQL exclusivity lock refuses bootstrap while a managed Gateway
is running; an offline command cannot bypass the runtime's mutation gate.
For a host-built binary, use `--database-url-file` with another protected file
instead of placing a database password in command arguments.

Start the stack with the same overlay and public frontend OIDC configuration.
Automatic fresh onboarding uses the single-entry flow above. For manual
registration and later permission changes use the maintenance procedure below.

1. Sign in at `/#/admin` using the existing PKCE browser application.
2. Select the bootstrapped organization. Platform operators register verified
   people and vehicles; ordinary organization administrators work within their
   existing organization and cannot arbitrarily bind identities.
3. Assign a fixed role and an operation range (default `none`, or explicit
   `selected`/`all`). For executable actions, `all` includes future vehicles;
   `selected` grants only those selected. Active membership automatically gives
   read/live-view access to all active vehicles registered in its own organization.
4. Open `/#/?page=monitor` to select an authorized vehicle and start viewing. Use only
   explicitly allowlisted simulators for driving. The home fleet is still a
   separate Mock, not the live management registry.

`viewer` observes; `remote_operator` observes and may request simulation
control. `org_admin` manages the organization but does not automatically gain
control. A role is not a Lease: acquire, fencing revision, signatures, sequence
checks, watchdog and safe handover still apply.

## Safe authorization changes

This is a **single-Gateway deployment**, not a production online-revocation
service. Do not edit the PostgreSQL lifecycle/policy tables
directly, run a second Gateway, switch to static configuration to bypass a
rejection, or clear Redis session/fence keys.

An authorization change must not leave reusable old room tokens or an active
control session behind. A rejected change is not queued and must not be shown
as effective. Manual registration and existing-permission management writes require
`AUTHORIZATION_MANAGED_MAINTENANCE=true` and a fully drained deployment:

1. Finish control release and the required device-confirmed safe handover;
   never delete a pending fence. Close viewing sessions.
2. Set maintenance in protected deployment configuration and recreate only
   the Gateway using the same overlay. New tokens, acquisitions and renewals
   are then refused; telemetry and authorized safe cleanup remain available.
3. Stop media clients and wait until all previously issued LiveKit tokens plus
   the persisted clock-skew margin expire. Restart does not reset that horizon.
   Ensure `teleop-*` rooms have disappeared from LiveKit; existing connected
   participants can survive JWT expiry. Unavailable drain dependencies reject
   the change rather than assuming an empty room.
   The first verified empty observation also starts a persisted 11-minute
   quiet interval for the pinned LiveKit release's server-refreshed tokens;
   retries must satisfy both that interval and the recorded issuance horizon.
   A room/dependency failure resets the quiet observation.
4. Submit registration/assignment in `/#/admin`. On rejection, nothing is queued
   to become effective later. Fix the reported condition and manually retry.
5. After confirmed changes, restore maintenance to `false` and recreate only
   the Gateway. Reconnect viewers and explicitly reacquire simulation control.

The pilot conservatively drains the whole deployment, not just one organization.
This intentionally trades online administration for a verifiable initial
boundary; production background revocation is not being simulated by a UI
success message. `VEHICLE_LIVEKIT_TOKEN_TTL_MINUTES` affects the waiting window
and defaults to 30 minutes; avoid issuing tokens unnecessarily during setup.

The managed overlay pins LiveKit `v1.13.11` and sends RTC signaling through
Gateway `/rtc` and `/rtc/*`, including WebSocket upgrades. Maintenance rejects
new joins/reconnects at that gate, not just new token issuance. Use the cloud
Caddy entry with `RTC_UPSTREAM=teleop-backend:8080`; never expose LiveKit's
signaling port `7880` directly, add another public RTC proxy, or combine this
pilot with `docker-compose.no-domain.yml`. Required LiveKit media ports are
not the signaling API. The startup flags
`AUTHORIZATION_LIVEKIT_SERVER_VERSION` and `AUTHORIZATION_LIVEKIT_INGRESS_GATED`
declare deployment invariants; they cannot discover or prevent a separate
misconfigured public ingress. An unverified ingress topology blocks rollout.

Local acceptance now includes disposable actual Casdoor `v4.25.0` and LiveKit
`v1.13.11`, not only JWT/JWKS or signaling fixtures:

```bash
python3 tests/casdoor-contract.py
python3 tests/managed-auth-chain.py
```

The first verifies actual public-client S256 PKCE, incorrect verifier/code
replay, machine client credentials, administrative creation/reconciliation and
rotation, then verifies provider JWTs through Gateway and PostgreSQL identity
bindings. The second verifies an actual signaling WebSocket join, signed
server-refreshed JWT lifetime, maintenance rejection of joins/reconnects,
RoomService drain and the real 11-minute persisted quiet interval, including
runtime reconstruction. See [test prerequisites](../tests/README.md).

These are reproducible isolated acceptance results, not proof of an existing
deployment's version, external proxy topology, email invitation delivery,
camera media or physical safety. Before opening the pilot, verify the deployed
versions and exclusive signaling ingress; do not waive those gates by setting
the assertion flags alone.

### Verified Casdoor configuration constraints

The isolated pinned-version results establish these contracts, not defaults
that may be guessed for a different deployment:

- Personnel `sub` is the immutable Casdoor user ID, not its username or
  `organization/username`. The actual PKCE token must be verified before binding.
- Machine `sub` is the application's owner/name (the test observed
  `admin/contract-vehicle`), **not** `client_id`. Rotating its secret preserves
  the observed subject.
- Default JWT `aud` is that application's `client_id`. The Gateway's explicit
  `OIDC_AUDIENCE` allowlist must match personnel/manual-client audiences.
  Automatically provisioned vehicles instead require their persisted exact
  issuer, subject and client audience, active vehicle/organization and a
  signed, strictly vehicle-scoped access token; adding them does not require
  editing the deployment allowlist. A placeholder
  such as `teleop-api` does not work without a separately verified resource/
  audience configuration. Do not disable audience verification or use a
  wildcard to avoid configuring new vehicle clients.
- Public browser applications explicitly delegate `openid`, `profile` and
  `teleop:observe`. The test confirmed that omitting the first two from a
  configured scope allowlist rejects the current browser's PKCE request.
  Vehicle applications delegate only `teleop:vehicle`; requesting personnel
  scope from them must fail.
- Casdoor signs `tokenType`; the Gateway accepts only `access-token` when this
  field is present. The isolated test reproduced ID-token substitution before
  the check was added and now verifies rejection of the actual provider ID
  token while valid personnel/device access tokens still work.
- Management credentials can use HTTP Basic headers; do not put client secrets
  in management API URLs. The disposable acceptance administrator has broad
  privileges for test setup, not a production least-privilege recommendation.
- The organization needs its application before person creation. Duplicate
  creation is not a successful retry: reconcile its immutable identity and
  never adopt an unrelated existing account.
- Secret rotation rejects new grants using the old secret; already issued
  JWTs remain valid until expiry unless the Gateway's authorization/session
  revocation boundary denies them. Rotation is not instant session revocation.

The Gateway now has a persistent operation worker, bounded retries, trusted
provider reconciliation and encrypted pending installation credentials.
Casdoor alone sends the native invitation/recovery mail. The real-provider
runner verifies the actual native reset and subsequent public PKCE login, plus
the protected Python installation and explicit lost-response recovery. It also
checks that pending credentials are ciphertext and are erased on completion.
These are isolated results, not acceptance of another tenant's permissions,
mailbox delivery, CAPTCHA policy or deployment. Test scripts remain disposable
acceptance harnesses, not production credential-distribution services.

Production lifecycle disable/transfer, online forced revocation, real mailbox delivery,
multi-instance policy/connection convergence, background operation recovery
and physical driving remain separate acceptance gates. Do not represent an
outbox row or a successful Casbin write as completion of those gates.

Back up the authorization database alongside the separate Redis and operations
durability boundaries. Restore only during a maintenance window with issuance
stopped, prior RTC participants disconnected and previously issued tokens
expired. An older database backup can restore revoked roles or shorten a token
barrier; it is not a safe automatic rollback. Reconcile current identity and
policy state before reopening access.

## Locate a problem by layer

| Observed state | Check |
| --- | --- |
| Cannot sign in | PKCE application, exact redirect URI, JWT issuer/audience/JWKS and API delegation scope |
| Login succeeds but management is denied | Trusted subject binding, active membership and org_admin role; token admin strings do not grant business administration |
| Vehicle missing from list | Trusted active membership, selected organization and active registration; operation scope does not limit reading and device packets do not register vehicles |
| Device denied | Unique issuer/subject binding, device delegation scope and exact registered vehicle ID; run `vehicle_auth_check --json` |
| Vehicle listed but offline | HTTPS telemetry publication and server receipt age, not just OAuth success |
| No camera frames | Viewing/media demand, RTC network, camera publication and decoded-frame freshness |
| Cannot acquire control | Assigned control range, simulation allowlist, current Lease/handover fence and camera readiness |
| Permission change rejected | Drain requirements and dependencies; do not delete the Lease or retry as a different role |

Management failures expose the Gateway correlation ID when available. Locate
the corresponding server event without logging bearer tokens, raw provider
responses, client secrets or database URLs. Authentication, authorization,
media readiness and physical safety are distinct states.
