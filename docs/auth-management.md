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

- **车辆管理**: searchable vehicle directory, expandable registration form, and
  vehicle-only onboarding progress/installation actions.
- **人员管理**: searchable personnel directory, expandable email invitation form,
  and person-only invitation progress. Initial permissions are optional advanced
  fields; **配置权限** opens the selected person's current assignment.
- **权限管理**: edit a person's role and vehicle scope, inspect current assignments,
  and expand the role reference. Existing permission changes still require
  maintenance/drain; switching tabs does not bypass backend checks.

Technical subject/operation identifiers are under expandable details rather than
mixed into the main list. Installation tickets are cleared when switching tabs;
pending onboarding operations continue to be tracked.
The administration header has only **返回运营平台** and logout; it reuses the
shared organization context and does not advertise separate monitor or Mock entries.

Administrators submit a person's name/email, initial role and **操作车辆范围**
in one form, or a vehicle's local number/name in one form. Operation range
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
application. Configure its native Email provider for the `forget` rule, password
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
  "encryption_key_file": "/etc/teleop-auth/onboarding.key"
}
```

Use the actual discovery `jwks_uri`, certificate and application URLs, not
unverified example values. The dedicated management application needs the
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

The automatic form asks only for the customer's local vehicle number, such
as `truck-001` (1-24 ASCII letters/digits/dot/underscore/hyphen, first character
alphanumeric; normalized lowercase). The server creates:

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

## Account lifecycle extension

See [account lifecycle and installation packages](account-lifecycle.md) for the
managed removal/rejoin, credential revocation, registration diagnostics, scoped
audit, version/idempotency contracts, and downloadable installation package.
Existing manual/additive provisioning boundaries and maintenance drain still apply.

The implementation and disposable acceptance evidence dated 2026-11-05 are recorded in [plan.md](../plan.md#implementation-evidence), including replacement rotation, platform-only transfer, authenticated observation, and the real RTC drain interval. Earlier planning/validation caveats in this document are historical; production rollout still requires the documented maintenance and pilot procedure.

For the deployed account-authentication LAN environment on `10.0.39.138`, including browser certificate trust and the Apollo container at `zj@10.0.39.120`, follow [Manual account-authentication verification](manual-account-authentication.md). This is a separate protected Compose project from the older `10.0.39.103` example.
