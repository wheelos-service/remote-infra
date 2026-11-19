# LAN setup

The prebuilt Ubuntu 22.04 x86_64 package requires only Docker Engine, usable by
your user without `sudo`. It includes all images and setup tools; no source
checkout, compilation, or registry access is needed after downloading it.

## 1. Deploy

Extract `teleop-1.1.0-linux-amd64.tar.gz`. From the extracted directory,
replace the example LAN IP and hostnames. Reserve the IP in your router or
configure a static address. For the same application URLs in LAN and public
deployments, configure internal DNS so both names resolve to this LAN IP:

```bash
sha256sum --check teleop-1.1.0-linux-amd64.tar.gz.sha256
tar -xzf teleop-1.1.0-linux-amd64.tar.gz
cd teleop-1.1.0-linux-amd64
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
login. The fleet starts empty; vehicle setup is separate, and managed native
driving remains disabled pending handover support.

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
