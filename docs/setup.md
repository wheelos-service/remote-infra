# LAN setup

For a registry installation, download the Compose installer and its checksum.
After verifying and extracting the archive, run `./install.sh` to pull the
1.1.3 images from `registry.cn-hangzhou.aliyuncs.com/wheelos/saas`.
[Compose installer](https://github.com/wheelos-service/remote-infra/releases/download/1.1.3/teleop-1.1.3-compose.tar.gz) · [SHA-256 checksum](https://github.com/wheelos-service/remote-infra/releases/download/1.1.3/teleop-1.1.3-compose.tar.gz.sha256)

The offline Ubuntu 24.04 x86_64 package requires only Docker Engine, usable by
your user without `sudo`. It includes all images and setup tools; no source
checkout, compilation, or registry access is needed after downloading it.

## 1. Deploy

Extract `teleop-1.1.3-linux-amd64.tar.gz`. From the extracted directory,
replace the example LAN IP and hostnames. Reserve the IP in your router or
configure a static address. For the same application URLs in LAN and public
deployments, configure internal DNS so both names resolve to this LAN IP:

```bash
sha256sum --check teleop-1.1.3-linux-amd64.tar.gz.sha256
tar -xzf teleop-1.1.3-linux-amd64.tar.gz
cd teleop-1.1.3-linux-amd64
./teleop --lan-ip 192.168.1.50 \
  --domain console.example.com --auth-domain login.example.com all
```

Run the checksum and extraction commands from the download directory, before
entering the extracted bundle. Obtain the expected checksum through a trusted
release channel; a checksum supplied with a malicious archive is not a signature.
The launcher also checks bundle files before loading images and rejects images
whose IDs/architecture differ from the release manifest. Run `./teleop load` to
restore bundled images if local tags were replaced.

The LAN stack starts AdGuard Home in Docker and publishes DNS on that address.
On first startup, open `http://192.168.1.50:3000` to complete its setup; keep
the DNS port at 53, leave AdGuard's DHCP server disabled, and set its web
interface port to 3000 so the dashboard remains at that address. Create DNS
rewrites for `console.example.com` and
`login.example.com` to `192.168.1.50`, and configure the router's DHCP service
to give clients `192.168.1.50` as their DNS server. Renew client DHCP leases
after changing that setting. The launcher does not change router/DHCP config.

Verify from a LAN client with
`dig @192.168.1.50 console.example.com +short` and
`dig @192.168.1.50 login.example.com +short`; both should return
`192.168.1.50`. If the host already has a DNS service bound to its LAN address
on port 53, stop or reconfigure it before deployment. Do not expose AdGuard's
admin port (TCP 3000) beyond trusted administrators or forward it from the
public internet.

The launcher loads the images, generates secrets, and creates the first
administrator.
Keep the default state directory `~/.local/state/teleop` private. Allow LAN
clients through the host firewall on TCP **443**, TCP/UDP **53**, and (for
administration only) TCP **3000**; media also uses TCP **7881** and UDP
**51000–51100**.

The public deployment uses the same two hostnames and URLs, with public DNS
pointing to the public IP. LAN mode uses Caddy's private CA, so install the
generated `root.crt` on LAN clients as described below. LAN-only deployments
may use names available only on the internal DNS; no public domain is required.
The browser runtime URLs, Gateway API/CORS origin, Casdoor OIDC issuer and
redirect/token endpoints, and LiveKit signaling URL all use these same domain
origins and paths in both modes. DNS answers and certificate trust differ;
media address advertisement follows LAN versus public network reachability.

IP-only LAN deployments are unsupported, including existing deployments with
saved IP-only state; the launcher rejects them rather than serving an issuer
or URL that differs from public mode. The old state and volumes are not
deleted. To migrate, preserve them for an explicit identity/data migration and
create the domain-based deployment in a separate state directory.

To build from a source checkout instead, follow [Deploy from source](deploy-from-source.md).

For public domains, use the same launcher instead of the source command:

```bash
./teleop --domain console.example.com --auth-domain login.example.com \
  --acme-email ops@example.com all
```

Follow the [public DNS, ports and ACME requirements](deploy-from-source.md#optional-public-domains).
Public mode uses the system CA store; skip the private root installation below.
Offline image delivery does not make public ACME issuance/renewal offline.

## 2. Trust the certificate

Copy `~/.local/state/teleop/root.crt` from the host to each client, including the
host if using its browser. Check the certificate's SHA-256 fingerprint against
the deployment output. Share only this public certificate.

On an Ubuntu client, from the directory containing the copied `root.crt`:

```bash
sudo cp root.crt /usr/local/share/ca-certificates/teleop.crt
sudo update-ca-certificates
```

Restart the browser. If it uses a separate certificate store, import the same
certificate there as a trusted authority.

## 3. Open and sign in

With split DNS, the host and LAN clients use the same domain URLs as public clients:

- Webpage: `https://console.example.com`
- Backend API: `https://console.example.com/api`
- Login service: `https://login.example.com`

Read `~/.local/state/teleop/administrator.txt` on the host for the administrator
login. The fleet starts empty. Managed Gateways with automatic native-control
admission use the current enrollment registry, including vehicles added later.
The original 1.1.3 image used a per-vehicle list. [Release capabilities](compatibility.md)

To restart or check the deployment, use the same OS user:

```bash
./teleop start
./teleop verify
```

Back up the state directory and Docker volumes together. `--local` is reserved
for loopback-only testing. LAN deployments require `--lan-ip`, `--domain`, and
`--auth-domain`; public deployments use the same domain options without
`--lan-ip`.
See [Operations](operations.md) for logs, backups, and troubleshooting, and
[Administration](auth-management.md) to invite people and assign access.

## Update an existing deployment

For a standard registry installation, extract the new release's Compose kit into a
fresh directory. Back up the existing state and volumes, then run the new kit's
`./install.sh --state /absolute/path/to/existing-state --non-interactive` as the
installation owner. Run `./install.sh --verify` afterward. The kit's `UPGRADE.md`
covers recovery and backups.

For an image update that preserves a customized generated Compose configuration,
including external HTTPS ports and NAT mappings, install the [updater](../infra/scripts/teleop-update)
once from a source checkout with `sudo install -m 0755 infra/scripts/teleop-update /usr/local/bin/teleop-update`.
Run it as the deployment owner on the Docker host:

```bash
teleop-update 1.1.3
```

The updater discovers the state directory from the Gateway. Supply `--state PATH`
when the host has multiple Teleop deployments. Use `--check` to pull and verify
the target images and validate the proposed configuration while services are running.
Updates briefly stop the selected project and save its previous Compose file, private
state, and volumes in a timestamped directory beside the state directory, under
`<state-name>-backups/`. A successful update verifies the running images, Gateway
readiness, and login service discovery. Repeating the command checks an installed release.
On the public site, a repeat update to 1.1.3 verifies and preserves the recorded
Gateway patch. Updating to a different version selects that release's published
Gateway image.

Use this updater for subsequent image updates and the saved `compose.json` for
ordinary Compose operations. Running an older source or offline launcher can
regenerate the configuration with its own image versions. If startup fails, the
updater restarts the previous configuration and keeps the backup for data recovery.
