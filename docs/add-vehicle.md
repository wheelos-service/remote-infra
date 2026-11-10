# Add a vehicle

Configure the vehicle, run bootstrap to get a machine code, then register it in
the dashboard with a vehicle name and that code. Casdoor provisions the vehicle
identity after administrator approval.

## 1. Install the server CA on each new vehicle

The current LAN deployment uses a private CA. Vehicles connecting to the same
server trust the same **public root certificate**; do not generate a separate CA
for each vehicle. This trust is used for Gateway enrollment/telemetry, Casdoor
OAuth and LiveKit HTTPS/WSS connections. No CA field is needed in `bootstrap.json`.
If all endpoints already use certificates trusted by the container, skip this step.

**On the server computer**, copy only `root.crt` from the deployment state
directory. Change the destination IP for the new vehicle and the SSH username
if it is not `nvidia`. Use the existing trusted SSH connection; never copy
`root.key`, device credentials or the whole server state directory.

```bash
VEHICLE_IP=10.0.39.102 # Example: replace with the new vehicle's IP.
openssl x509 -in "$HOME/.local/state/teleop-registration/root.crt" \
  -noout -fingerprint -sha256
scp "$HOME/.local/state/teleop-registration/root.crt" \
  "nvidia@${VEHICLE_IP}:/tmp/teleop-root.crt"
ssh "nvidia@${VEHICLE_IP}"
```

If the server was deployed with another `--state` directory, use its `root.crt`.
Keep the printed fingerprint for comparison below.

**On the new vehicle host**, find the running Apollo container and copy the
certificate into it. Trusting the host alone does not configure container trust.

```bash
docker ps --format '{{.Names}}'
APOLLO_CONTAINER='replace-with-the-running-apollo-container-name'
docker cp /tmp/teleop-root.crt "${APOLLO_CONTAINER}:/tmp/teleop-root.crt"
docker exec -it "$APOLLO_CONTAINER" bash
```

**Inside the Apollo container**, ensure `ca-certificates`, `openssl` and `curl`
are available. If missing, install them with `sudo apt-get update` followed by
`sudo apt-get install -y ca-certificates openssl curl`.

Compare this fingerprint with the server's output before installing the
certificate. If they differ, stop and obtain the correct certificate from the
server administrator.

```bash
openssl x509 -in /tmp/teleop-root.crt -noout -fingerprint -sha256
```

After the fingerprints match:

```bash
sudo install -m 0644 /tmp/teleop-root.crt \
  /usr/local/share/ca-certificates/teleop-platform.crt
sudo update-ca-certificates
```

Verify Gateway and Casdoor using normal certificate validation. These are the
current server IP and ports; replace them if your deployment differs.

```bash
SERVER_IP=10.0.39.138
curl --noproxy '*' --fail --show-error --silent --output /dev/null \
  --write-out 'Gateway: HTTP %{http_code}; TLS verify %{ssl_verify_result}\n' \
  "https://${SERVER_IP}:8443/readyz"
curl --noproxy '*' --fail --show-error --silent --output /dev/null \
  --write-out 'Casdoor: HTTP %{http_code}; TLS verify %{ssl_verify_result}\n' \
  "https://${SERVER_IP}:8444/.well-known/openid-configuration"
```

Both checks must show `HTTP 200; TLS verify 0`. Do not use `curl -k` or disable
TLS verification. The certificate must cover the IP/hostname used in the URL;
installing a CA does not fix an incorrect hostname. If endpoints use different
private CAs, repeat the installation for each verified root with a distinct
`.crt` filename.

Repeat this on every new vehicle and after recreating its runtime container,
or include the public CA and `update-ca-certificates` in the runtime image.
Install the replacement root if the server CA changes. Restart existing vehicle
processes after updating trust so they reload it.

## 2. Prepare the vehicle

Continue inside the Apollo runtime container.

```bash
cd /apollo
bazel build --config=dev //modules/teleop:vehicle_bootstrap
sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 \
  "$(bazel cquery --config=dev --output=files //modules/teleop:vehicle_bootstrap)" \
  /usr/local/libexec/vehicle_bootstrap
sudo install -d -m 0700 /etc/teleop /var/lib/teleop/bootstrap
```

## 3. Edit `/etc/teleop/bootstrap.json`

```bash
sudoedit /etc/teleop/bootstrap.json
```

For a fresh vehicle, save this configuration. Replace
`https://gateway.example.com` and `https://console.example.com` with the
**server's IP and HTTPS port**. Vehicle name is entered only in the dashboard;
bootstrap does not need `name`, `serial`, or `platform`:

```json
{
  "gateway_url": "https://gateway.example.com",
  "console_url": "https://console.example.com",
  "state_directory": "/var/lib/teleop/bootstrap",
  "device_template": "/etc/teleop/device.template.json",
  "device_config": "/etc/teleop/device.json",
  "allow_insecure_localhost": false,
  "allow_legacy_complete_404": false
}
```

If `/etc/teleop/device.template.json` does not yet exist, create it with
`sudoedit /etc/teleop/device.template.json` and save:

```json
{
  "control_mode": "disabled",
  "media_enabled": false,
  "task_mode": "disabled"
}
```

```bash
sudo chown root:root /etc/teleop/bootstrap.json /etc/teleop/device.template.json
sudo chmod 0600 /etc/teleop/bootstrap.json /etc/teleop/device.template.json
```

## 4. Generate the machine code

Use the updated Gateway and SDK together. Existing bootstrap files with the
retired fields still work; new requests omit them. Preserve existing device
credentials, key files, and enrollment state when updating the configuration.

```bash
sudo /usr/local/libexec/vehicle_bootstrap --config /etc/teleop/bootstrap.json
```

## 5. Register in the dashboard

1. Sign in as an administrator, select the target organization, and open
   **车辆管理 → 注册车辆**.
2. Enter **车辆名称** (the dashboard display name) and **机器码** from the vehicle.
3. Click **核对车辆**. Confirm the machine code belongs to the intended vehicle;
   device details show its public-key fingerprint and request expiry.
4. Click **确认注册车辆**. For an existing vehicle recovery, use **确认恢复车辆**;
   recovery retains the original identity and organization.
5. Wait for bootstrap to save credentials, verify authentication, and acknowledge
   installation. The dashboard's **接入与邀请进度** shows provisioning progress.
