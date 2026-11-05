# Manual account-authentication verification on the remote LAN server

This guide covers organization bootstrap, administrator login, personnel invitation, vehicle registration and installation, permission changes, diagnostics, removal/rejoin, revocation, replacement, and transfer. It describes the remote deployment prepared on 2026-11-05; it does not enable physical driving.

## 1. Deployment and client

| Component | Address or location |
| --- | --- |
| Application / fleet | <https://10.0.39.103:9443/> |
| Administration | <https://10.0.39.103:9443/#/admin> |
| Casdoor login | <https://10.0.39.103:9444> |
| Captured invitation mailbox | <https://10.0.39.103:9445> |
| Server | `whl@10.0.39.103` |
| Server source | `/home/whl/01code/remote-infra` |
| Compose project | `account-authentication-remote` |
| Protected server state | `/home/whl/01code/account-authentication-state` |
| Vehicle SSH | `zj@10.0.39.120` |
| Apollo container | `apollo_dev_zj` |
| Vehicle host mount | `/home/zj/01code/apollo-base` → `/apollo` |
| Isolated vehicle files | `/apollo/.account-authentication` inside the container |

The client may be a different computer on the LAN. Open the deployed application URL; no separate frontend installation is needed. The browser needs JavaScript, Web Crypto for PKCE, and trusted HTTPS access to both ports 9443 and 9444. Use a current desktop browser for the first verification. Broad browser/device compatibility has not been exhaustively tested. Viewing video additionally requires WebRTC/network media support; this authentication deployment does not publish media ports and has simulation control disabled.

Use the same application origin on every client. Do not substitute `localhost`, another IP, or a locally copied HTML file: the OAuth redirect URI and allowed origin are registered for `https://10.0.39.103:9443/`. Reserve this IP for the remote server. Changing the issuer IP requires a deliberate new deployment/migration, not editing URLs against existing identities.

The previous Mac project is stopped, with its volumes and protected state retained. Its test identities were not migrated: this remote stack has a new issuer, organization and credentials. The other user’s existing remote stack on ports 8443–8445 is unchanged. Use the new URLs, administrator credentials and CA below.

### Trust the deployment certificate

Obtain the **public** CA file from the operator at:

```text
/home/whl/01code/account-authentication-state/root.crt
```

Copy only the public certificate to your client:

```bash
scp whl@10.0.39.103:/home/whl/01code/account-authentication-state/root.crt ./account-authentication-root.crt
openssl x509 -in ./account-authentication-root.crt -noout -fingerprint -sha256
```

Verify its SHA-256 certificate fingerprint before importing it:

```text
6C:23:3A:C6:66:26:96:B7:B8:E6:FE:3E:74:F0:8F:A7:3D:7A:5D:C0:EC:C1:C9:FF:E7:EB:F9:40:8D:96:24:FD
```

On macOS, import the certificate into the testing user's Keychain and trust it for SSL. On Windows, use the testing user's Trusted Root Certification Authorities store. On Linux/Firefox, configure the trust store actually used by that browser. Restart the browser, then open the application, authentication and mailbox URLs. None should show a certificate error. Trust is needed on each client computer; it has already been configured inside the vehicle container.

For an Ubuntu client or the Ubuntu deployment host, use the repository script so the certificate is installed with the correct owner and permissions, the CA bundle is rebuilt, and HTTPS is checked immediately:

```bash
cd /home/whl/01code/remote-infra
sudo -v
bash infra/scripts/trust-authentication-ca.sh \
  --ca /home/whl/01code/account-authentication-state/root.crt \
  --fingerprint 6C:23:3A:C6:66:26:96:B7:B8:E6:FE:3E:74:F0:8F:A7:3D:7A:5D:C0:EC:C1:C9:FF:E7:EB:F9:40:8D:96:24:FD \
  --url https://10.0.39.103:9443/readyz
```

The script intentionally supports Ubuntu only and requires an interactive sudo-capable account. It installs `/usr/local/share/ca-certificates/account-authentication-remote.crt`; it does not copy private keys or modify the other remote deployment on ports 8443–8445.

The public certificate is also available at `/test-root-ca.crt`; verify it against the operator's copy, not solely against the download site. Do not copy Caddy's private CA keys or the whole state directory to clients.

### Credentials

The platform administrator's username/email/password are in `administrator.txt` inside the protected state directory. The mailbox login is in `mail-credentials.txt`. Read these locally as the server operator; they are deliberately absent from Git and this guide. The platform administrator is a user of the test organization, not Casdoor's built-in system-console administrator.

Invitations are captured locally. An address such as `manual-viewer@example.test` works for this exercise; no message is delivered to an external email account. Invitees set their own passwords using the captured Casdoor link.

## 2. Server commands and health

Connect to the deployment server and run these commands:

```bash
ssh whl@10.0.39.103
cd /home/whl/01code/remote-infra
export AUTH_STATE=/home/whl/01code/account-authentication-state

authctl() {
  python3 infra/scripts/authentication-test.py \
    --state "$AUTH_STATE" --host 10.0.39.103 \
    --project account-authentication-remote --base-port 9443 "$@"
}

dc() {
  docker compose -p account-authentication-remote \
    -f "$AUTH_STATE/compose.json" "$@"
}

dc ps
authctl verify
curl --fail --cacert "$AUTH_STATE/root.crt" https://10.0.39.103:9443/healthz
curl --fail --cacert "$AUTH_STATE/root.crt" https://10.0.39.103:9443/readyz
```

Expected: all eight services run, PostgreSQL is healthy, both endpoints return 200, and `verify` reports successful TLS/discovery/S256 PKCE/platform-admin context. Redis, PostgreSQL and LiveKit signaling have no direct published port; `/rtc` goes through the Gateway.

The deployment source is the Git clone on branch `feature/account-authentication`. Build and deployment commands run inside tmux session `account-authentication-deploy`. Attach from your client:

```bash
ssh -t whl@10.0.39.103 'tmux attach-session -t account-authentication-deploy'
```

Detach with **Ctrl-b**, then **d**. Docker runs the services in the background with `unless-stopped` restart policies; tmux preserves the deployment shell and output across SSH disconnects. Build output is saved to `$AUTH_STATE/deploy-tmux.log`, and `$AUTH_STATE/deploy-tmux.exit` records the last deployment exit code (`0` means success).

To rebuild/redeploy this same environment, attach to tmux, run the setup commands above (starting at `cd`, without opening another SSH session), and run:

```bash
set -o pipefail
authctl all 2>&1 | tee "$AUTH_STATE/deploy-tmux.log"
printf '%s\n' "${PIPESTATUS[0]}" > "$AUTH_STATE/deploy-tmux.exit"
```

Check the exit code and run `authctl verify` before considering deployment complete. If the tmux session is absent, create it with `tmux new-session -s account-authentication-deploy -c /home/whl/01code/remote-infra` first. The obsolete source directory `/home/whl/01code/remote-infra-account-authentication` and temporary migration bundles were removed after verifying that no container or process used them. The Git clone and protected state directory remain the active deployment. Reuse the same state directory, project, CA, encryption key and database volumes. `prepare`/`all` preserve the stored maintenance setting; `verify` does not regenerate configuration. Do not run `docker compose down -v` unless deliberately discarding the entire test environment.

## 3. Create an organization and establish its administrator

**There is currently no self-service “Create organization” button or organization-creation HTTP API.** The supported creation path is the protected offline `auth-admin` bootstrap. Creating a Casdoor organization alone does not create a Gateway organization.

The remote deployment has already performed initial bootstrap:

- Organization: **Authentication test fleet**.
- Gateway organization ID: `d41a620e-39aa-46e3-b37b-c88de3cb4246` (confirm against `bootstrap.json` if the environment is recreated).
- Platform administrator: the identity in `administrator.txt`.

For a fresh independent test environment, create a mode-0700 state directory outside the repository and use the deployment helper's `all` action with an unused project and LAN address/ports. Bootstrap automatically creates a new organization and verified administrator. Use `--base-port` to select three consecutive unused HTTPS ports. The existing deployment ports are already in use; do not run a second project on them simultaneously.

For an **additional organization in the same Gateway**, the operator workflow is:

1. Provision a new human identity in Casdoor using privileged provider administration. Verify its exact access-token `iss` and immutable `sub`; email/username is not a substitute. It must not already be bound to a Gateway user.
2. Generate new canonical UUIDs for `org_id` and `user_id`. Prepare a mode-0600 `bootstrap-new.json` in `AUTH_STATE` with the following fields, replacing every placeholder:

   ```json
   {
     "org_id": "<new canonical UUID>",
     "org_name": "Second verification fleet",
     "user_id": "<new canonical UUID>",
     "name": "Second fleet bootstrap administrator",
     "issuer": "https://10.0.39.103:9444",
     "subject": "<verified new Casdoor user UUID>"
   }
   ```

3. Close viewing/control sessions and complete maintenance/drain as described in section 7. Stop the Gateway, then run the explicit bootstrap:

   ```bash
   dc stop gateway
   dc run --rm --no-deps \
     --volume "$AUTH_STATE/auth-admin:/run/bootstrap/auth-admin:ro" \
     --volume "$AUTH_STATE/bootstrap-new.json:/run/bootstrap/input.json:ro" \
     --entrypoint /run/bootstrap/auth-admin \
     gateway --input /run/bootstrap/input.json
   dc up -d gateway
   ```

4. Sign in with the new verified identity and confirm the new organization. Bootstrap intentionally creates a **platform administrator**, so only a platform operator should execute it. It is not the ordinary member-invitation workflow.
5. An exact bootstrap repeat is a no-op. Reusing an existing identity with changed IDs or trying to bootstrap while the Gateway owns its exclusive lock must fail. Never edit the database directly to work around that rejection.

## 4. Administrator login and invite a member

1. Open the administration URL, click **管理员登录**, and use the credentials from `administrator.txt` on the Casdoor page.
2. Confirm the selected organization is **Authentication test fleet**. Open **人员管理**.
3. Expand the invitation form. Use a unique name and email, for example `Manual viewer` and `manual-viewer@example.test`. Leave role **viewer** and operation range **none**.
4. Submit once. Observe the durable operation progressing through provider creation, binding and invitation. Record its operation ID; do not record a password, token, reset link or mail body in test notes.
5. Open the protected mailbox. Find the invitation for that exact email. Follow **Set your password**, complete Casdoor verification/password setup, and return to the application.
6. In a separate browser profile/private session, log in as the invitee. Confirm the organization is available and the user can read its active vehicles. Confirm that the user cannot administer the organization or drive.
7. As the administrator, open that person's **注册诊断**. After a successful authenticated request, **首次成功 Gateway 认证请求** should have a timestamp. Invitation completion alone must not show a fabricated login timestamp.

Expected: `none` means no execution authority; active members still have organization-wide observation. Invitation success is not proof of external delivery or password setup. Existing unbound identities are never silently claimed by email.

An existing smoke-test invitation for `remote-viewer@example.test` is already in the local mailbox; its password has not been set by the deployment agent. Use a fresh email for an independent manual run. For a failed operation, inspect the sanitized code and retry explicitly when eligible. Avoid duplicate invitations created with different identities just to hide a failure.

## 5. Add a vehicle and download its package

1. As an administrator, open **车辆管理** and expand registration.
2. Enter a unique local vehicle number, for example `manual-120`, and a descriptive name. Submit once.
3. Wait for **等待车辆安装** (`awaiting_install`). The displayed full vehicle ID is generated by the server. Copy that full ID for installation; the short local number alone is insufficient.
4. Explicitly issue an installation ticket, then click **下载安装包**.
5. Protect the downloaded file immediately with `chmod 600`. Transfer it within five minutes. The package contains a bearer enrollment ticket, not a permanent client secret.

The deployment already registered and installed this smoke-test vehicle:

```text
v-d41a620e-apollo-120-e3b129db601b4d2e
```

Do not try to reinstall that completed operation. Use a new registration for a fresh-install test, or the replacement workflow in section 10 for the installed device.

### Install any new Apollo vehicle with the existing installer

Use `infra/scripts/install-vehicle-auth.py` inside the new car's Ubuntu Apollo container. The package already contains the full vehicle ID and Gateway origin; the command below passes those values explicitly so the installer can enforce the identity boundary. No car IP is needed by the installer. Packages are single-use and expire after five minutes, so issue a fresh package immediately before transfer.

On the client holding the downloaded package, obtain the public CA and installer from the deployment server, then transfer all three files to the new car host:

```bash
chmod 600 ./v-<vehicle>-enrollment.json
scp ./v-<vehicle>-enrollment.json <vehicle-ssh-host>:/path/to/apollo-base/.account-authentication/enrollment.json
scp whl@10.0.39.103:/home/whl/01code/account-authentication-state/root.crt \
  <vehicle-ssh-host>:/path/to/apollo-base/.account-authentication/root.crt
scp /home/whl/01code/remote-infra/infra/scripts/install-vehicle-auth.py \
  <vehicle-ssh-host>:/path/to/apollo-base/.account-authentication/install-vehicle-auth.py
```

Verify the CA fingerprint before trusting it. Then SSH to the vehicle host and replace only the host mount and container name below:

```bash
CONTAINER=<apollo-container-name>
MOUNT=/path/to/apollo-base/.account-authentication
VEHICLE_ID='v-<full vehicle ID from the package filename>'
GATEWAY=https://10.0.39.103:9443

# Copy the public CA and installer into the container.
docker cp "$MOUNT/root.crt" "$CONTAINER":/tmp/account-authentication-root.crt
docker cp "$MOUNT/install-vehicle-auth.py" "$CONTAINER":/tmp/install-vehicle-auth.py
docker cp "$MOUNT/enrollment.json" "$CONTAINER":/tmp/enrollment.json

# Trust only the public CA in this Ubuntu container.
docker exec -u 0 "$CONTAINER" install -m 0644 \
  /tmp/account-authentication-root.crt \
  /usr/local/share/ca-certificates/account-authentication-remote.crt
docker exec -u 0 "$CONTAINER" update-ca-certificates

# Keep each car's credential in its own protected directory.
docker exec -u 0 "$CONTAINER" install -d -m 700 \
  "/apollo/.account-authentication/vehicles/$VEHICLE_ID"
docker exec -u 0 "$CONTAINER" install -m 600 /tmp/enrollment.json \
  "/apollo/.account-authentication/vehicles/$VEHICLE_ID/enrollment.json"

docker exec -u 0 "$CONTAINER" python3 /tmp/install-vehicle-auth.py \
  --gateway "$GATEWAY" \
  --vehicle-id "$VEHICLE_ID" \
  --package "/apollo/.account-authentication/vehicles/$VEHICLE_ID/enrollment.json" \
  --output "/apollo/.account-authentication/vehicles/$VEHICLE_ID/device.json"
```

Expected: the existing installer validates the single-use package, exchanges the ticket, verifies OAuth, `/api/auth/me`, device mapping and installation completion, and writes a root-owned 0600 `device.json`. It refuses a foreign Gateway/vehicle, expired/reused ticket, unsafe permissions, symlinks, or an existing output path. The generated configuration has control, tasks and media disabled.

After a successful run, remove only the enrollment package and temporary copies. Keep `device.json`:

```bash
docker exec -u 0 "$CONTAINER" rm -f \
  /apollo/.account-authentication/vehicles/$VEHICLE_ID/enrollment.json \
  /tmp/enrollment.json /tmp/account-authentication-root.crt /tmp/install-vehicle-auth.py
rm -f "$MOUNT/enrollment.json" "$MOUNT/root.crt" "$MOUNT/install-vehicle-auth.py"
```

If the installer saved `device.json` but verification was interrupted, do not redeem another package. Run the same command with `--verify-existing`, omitting `--package`. If no configuration was saved and the ticket was consumed, issue a fresh package through the vehicle onboarding operation.

## 6. Verify the device and distinguish installation from online status

For the smoke-test vehicle already installed by this deployment:

```bash
ssh zj@10.0.39.120
docker exec apollo_dev_zj env -u LD_LIBRARY_PATH \
  /apollo/.account-authentication/source/apps/vehicle-edge-cpp/bazel-bin/vehicle_auth_check \
  --json /apollo/.account-authentication/config/device.json
```

For a newly installed vehicle, the setup script has already performed the same protected configuration, OAuth token acquisition, Gateway identity, vehicle mapping and installation-completion checks. If the container has a matching prebuilt read-only binary, start it explicitly with `--telemetry-bin` on the setup command; otherwise run the native checker and runtime using the installed path:

```bash
docker exec -u 0 "$CONTAINER" env -u LD_LIBRARY_PATH \
  /apollo/.account-authentication/source/apps/vehicle-edge-cpp/bazel-bin/vehicle_auth_check \
  --json /apollo/.account-authentication/vehicles/<full-vehicle-id>/device.json
```

The native client explicitly requests `teleop:vehicle`. The checker does not join a room or verify a camera, Cyber discovery or driving. It issues a short-lived RTC token, so it can extend the next maintenance/drain waiting period.

Open the vehicle's **注册诊断** and fleet/monitor pages:

- Installation should be completed and binding active.
- Online means recent authenticated telemetry received by the server, not merely successful installation.
- Missing chassis/localization samples remain unknown; an online telemetry process must not invent measurements.
- Video is unavailable in this authentication-only deployment; control and tasks are disabled.

The remote build/runtime commands and actual verification status are recorded in section 12. Stop only the dedicated test telemetry process when testing offline behavior. After the freshness window expires, refresh the directory/diagnostics and expect offline/stale. Restarting the test runtime should restore freshness with a new stream; never run two instances using the same credential concurrently.

## 7. Enter maintenance before changing existing access

Fresh automatic invitations/vehicle onboarding use the additive path. Role/scope edits, removal/rejoin, revocation, transfer and replacement activation require maintenance and a fully drained Gateway.

On the server:

```bash
authctl maintenance-on
```

1. Release control if any and close every viewing session. This deployment has no enabled control path.
2. Stop media clients. Keep all Redis fences and persisted token horizons intact.
3. Submit the intended guarded change once. An initial **MANAGED_DRAIN_REQUIRED** is expected: the first verified empty observation starts the real **11-minute quiet interval**.
4. Wait for that interval **and** all recorded token issuance horizons. Device RTC tokens may require approximately 30 minutes plus skew; the native auth checker can create one even without joining a room. Restarting Gateway does not shorten this wait.
5. Refresh state and explicitly retry the same intended change. A rejected mutation has not been queued for later execution. Dependency failures and active rooms keep rejecting it.
6. Complete the related verification, then leave maintenance:

   ```bash
   authctl maintenance-off
   authctl verify
   ```

Telemetry may continue during maintenance; new RTC sessions/tokens and renewals are blocked. Do not clear database rows/Redis keys, switch to static authorization or expose LiveKit 7880 to bypass the guard.

## 8. Roles, membership removal and rejoin

Use a non-bootstrap test member; never remove your only usable administrator during an exploratory test.

1. Enter/drain maintenance.
2. In **权限管理**, select the test person and assign `remote_operator` with one selected vehicle. Confirm the saved assignment, then inspect the audit event.
3. Change to `viewer / none`. Confirm the user still reads the organization fleet but cannot control. `org_admin` manages the organization and does not grant driving authority either.
4. In **人员成员状态**, select **移除成员**, enter a reason, verify organization/person and submit. Membership becomes removed; old organization grants must disappear.
5. In the member's browser session, refresh or make another API request. That organization's resource access must be denied. Memberships in other organizations and the global Casdoor identity remain intact.
6. Select **重新加入**. Confirm the fresh assignment is `viewer / none`, not the old operator/selected/all grant. Assign further execution scope only through another explicit guarded edit.
7. Test a stale form from another tab: it must conflict instead of overwriting a newer authorization version. Use **核对状态并重新确认版本**, inspect current state/history, then reconfirm. For an uncertain network response, retry with the existing action/key before starting a different action.

This deployment has an empty simulation allowlist; even a selected/all operator grant is not proof of executable driving.

## 9. Vehicle removal and reactivation

1. In drained maintenance, select **移除车辆**, provide a reason, and confirm the full ID.
2. Expect disabled vehicle state, denied device access, invalidated installation material and removed selected-vehicle grants. The ID, ownership and history remain reserved.
3. A platform administrator may **核实并重新加入** using the exact reverified current subject. A revoked identity must not be reactivated through this action.
4. Confirm removed selected grants are not restored. Existing `all` grants apply dynamically to active vehicles after reactivation.
5. Restart the dedicated telemetry process only after successful reactivation, then check freshness again.

## 10. Credential revocation and replacement

Use a test vehicle whose process you can stop; keep its current protected file until replacement is verified.

**Revocation:** in drained maintenance, choose **吊销凭据** with a reason. Local access must be denied immediately after commit. Operation history separately shows provider pending/failed/manual-required/confirmed. A provider outage must never restore access. Explicit retry is available after failure; manual provider confirmation requires platform authority and an actual external verification record.

**Replacement:** choose **替换凭据** on an installed managed device. A previously revoked credential is recoverable only after provider revocation is confirmed. Wait for replacement `awaiting_install`, then download its replacement installation package.

1. Stop the dedicated vehicle process.
2. Move the existing `device.json` into an operator-controlled root-owned mode-0700 backup directory; keep the file mode 0600. Do not overwrite it or add a force flag to the installer.
3. Run the installer with the new package and the same full vehicle ID. Pending replacement credentials may verify identity/mapping and finish installation only; they have no normal telemetry/media/control authority yet.
4. Final activation also requires the maintenance/drain guard. If it is rejected after the file was saved, preserve the file, complete draining, then use `--verify-existing`.
5. If a replacement ticket was consumed but its configuration was lost, start a **new replacement operation/new identity**. A consumed replacement cannot be reissued under the old identity.
6. Expect completed replacement, active binding, cleared pending ciphertext and rejected old identity/tickets. Restart the test runtime with the replacement file.

## 11. Transfer, diagnostics, audit and rejection checks

A cross-organization transfer is **platform-only** and requires a second active Gateway organization from section 3. In drained maintenance, choose **转移组织（保持禁用）**, provide the destination organization UUID, exact reverified current subject and a reason. Expect atomic ownership change, disabled state, source selected-grant cleanup and events in both organizations. Source organization administrators must lose access. The destination platform administrator explicitly reactivates after review; destination `all` grants then apply.

For routine verification:

| Check | Expected result |
| --- | --- |
| Viewer/non-admin opens administration | Denied/no management capability |
| Device token calls an admin route | Denied |
| Person or vehicle ID from another organization | Denied, including diagnostics/audit |
| Repeat a ticket redemption | Rejected |
| Existing installer output path | No overwrite |
| Expired or edited package | Rejected before credential delivery |
| Remove during installation | Late worker/ticket/completion cannot restore access |
| Remove last administrator as ordinary org admin | Rejected |
| Concurrent/stale authorization version | Conflict; explicit refresh/reconfirmation |
| Invitation completed without login | No fabricated authenticated timestamp |
| Installed vehicle with runtime stopped | Installation remains complete; presence becomes offline/stale |

In **操作审计**, filter by actor, target, action, outcome and RFC3339 time range. Test **下一页**, **首页**, and changing a filter after paging. Events remain organization-scoped. Record operation IDs and request IDs for failures, not token/credential values. Audit history is not a provider secret dump or proof of physical actuation.

## 12. Deployment verification record

The remote deployment passed TLS/discovery/S256 PKCE/admin-context and health/readiness verification with all eight services running. Its frontend build/typecheck passed, and the custom-port deployment/installer unit suite passed all eight checks. Browser interaction remains a manual verification step using this guide.

The original Mac credential was moved to the root-owned mode-0700 `/apollo/.account-authentication/config/mac-deployment-backup` directory before installing the remote credential. The new public CA is installed as `/usr/local/share/ca-certificates/account-authentication-remote.crt`. The actual installer and native authentication checker passed against the remote server; consumed package copies were removed. Installation is completed, binding active, and server-observed telemetry online.

Across the deployment checks, the agent performed actual TLS/discovery/PKCE/admin-context/health checks, created a dummy invitation in the local mailbox, registered the Apollo smoke-test vehicle, installed its credential inside `apollo_dev_zj`, and verified the native C++ authentication stages. The two native test targets `telemetry_test` and `auth_diagnostics_test` passed. The Python installer tests passed locally and the actual Python 3.8 installer completed in the container.

The original feature commit `b9660ce` includes two compatibility fixes found during the earlier Mac deployment: fractional timestamp normalization for Python 3.8 and explicit `teleop:vehicle` on initial/refreshed C++ OAuth requests.

The container's default GCC 9 cannot compile the pinned Cyber dependency's floating-point `std::to_chars`. GCC 11 packages from the [Ubuntu Toolchain PPA](https://launchpad.net/~ubuntu-toolchain-r/+archive/ubuntu/test) were verified against its published signing-key fingerprint and extracted under `/apollo/.account-authentication/toolchain`. They were **not installed system-wide**; the default compiler and shared libraries remain unchanged. The isolated build gives only its own build actions and executables an explicit path to the extracted C++ runtime:

```bash
docker exec -u zj \
  -w /apollo/.account-authentication/source/apps/vehicle-edge-cpp \
  apollo_dev_zj bash -lc '
    env -u LD_LIBRARY_PATH \
      CC=/apollo/.account-authentication/toolchain/usr/bin/gcc-11 \
      CXX=/apollo/.account-authentication/toolchain/usr/bin/g++-11 \
      bazelisk build --jobs=4 \
      --repository_cache=/home/zj/01code/apollo-base/.cache/bazel/repo_cache \
      --action_env=LD_LIBRARY_PATH=/apollo/.account-authentication/toolchain/usr/lib/x86_64-linux-gnu \
      --linkopt=-Wl,-rpath,/apollo/.account-authentication/toolchain/usr/lib/x86_64-linux-gnu \
      --host_linkopt=-Wl,-rpath,/apollo/.account-authentication/toolchain/usr/lib/x86_64-linux-gnu \
      //:vehicle_telemetry'
```

The native telemetry executable built successfully and is running as a dedicated read-only process. The earlier Mac verification confirmed that stopping/restarting this runtime changes offline/online presence. The remote deployment reuses that verified executable with a newly enrolled identity and has confirmed fresh online telemetry. The Gateway reports the enrolled vehicle **online**; installation is **completed** and binding **active**. Its startup log reports `read-only C++ telemetry started; no control writer`. Chassis/localization values are present only when real Cyber samples are available. No physical-control or video-readiness claim is made.

Runtime files are root-owned under `/apollo/.account-authentication/config`: `device.json`, `telemetry.pid`, and `telemetry.log`. The standalone process survives closing SSH, but it is not an installed service; after recreating/restarting the Apollo container, start it deliberately. Preserve the mounted directory and deployment CA when rebuilding that container.

To stop **only this test process**, run from the vehicle host:

```bash
docker exec -i apollo_dev_zj python3 - <<'PY_STOP'
from pathlib import Path
import os, signal
record = Path('/apollo/.account-authentication/config/telemetry.pid')
pid = int(record.read_text())
command = Path('/proc/' + str(pid) + '/cmdline').read_bytes()
if (b'vehicle_telemetry' not in command or
        b'/apollo/.account-authentication/config/device.json' not in command):
    raise SystemExit('PID does not identify this test runtime')
os.kill(pid, signal.SIGTERM)
record.unlink()
PY_STOP
```

Wait for the old process to exit and for the fleet freshness window to expire. Do not use `pkill` against other Apollo processes. To restart this specific test runtime after it has stopped:

```bash
docker exec -d apollo_dev_zj sh -c '
  umask 077
  cd /apollo/.account-authentication/source/apps/vehicle-edge-cpp
  test ! -e /apollo/.account-authentication/config/telemetry.pid || exit 1
  echo $$ > /apollo/.account-authentication/config/telemetry.pid
  exec env -u LD_LIBRARY_PATH ./bazel-bin/vehicle_telemetry \
    /apollo/.account-authentication/config/device.json \
    >> /apollo/.account-authentication/config/telemetry.log 2>&1'
```

Before restarting after a container recreation, verify that no live process already uses this credential; remove a stale PID file only after that check. For a separate manual vehicle, use its own config/PID/log paths and only one process per credential. Do not edit or launch the existing Apollo vehicle-control services as part of this authentication test.
