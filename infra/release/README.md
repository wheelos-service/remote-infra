Teleop release for Ubuntu 22.04 x86_64

Requires Docker Engine usable by your user. No source checkout, Python, Go,
Node, Compose installation, public domain, or build step is needed on the
user machine. LAN-only names can be managed by the router or internal DNS.

1. Reserve the server's LAN IP, then extract the archive and run from its directory:
     ./teleop --lan-ip 192.168.1.50 --domain console.example.com \
       --auth-domain login.example.com all
   The launcher loads the bundled images and generates private instance config.
   Verify the outer archive against its trusted .sha256 before extraction.
   Bundle checksums are checked before image loading. Setup and service image
   IDs are checked before deployment; use ./teleop load if local tags changed.

2. AdGuard Home runs in the LAN stack. Complete its first-run wizard at
   http://192.168.1.50:3000; keep DNS on port 53, DHCP disabled, and set the
   web interface port to 3000. Add exact
   rewrites for console.example.com and login.example.com to 192.168.1.50,
   then configure router DHCP to advertise 192.168.1.50 as DNS. Renew client
   leases and verify both names resolve to that IP.

3. Copy ~/.local/state/teleop/root.crt to each client and trust it in the OS/browser.
   Check the printed SHA-256 fingerprint. On Ubuntu clients:
     sudo cp root.crt /usr/local/share/ca-certificates/teleop.crt
     sudo update-ca-certificates
   Restart the browser. Share only root.crt, not the state directory.

4. Open https://console.example.com on the host or another LAN computer.
   Backend: same address under /api. Login: https://login.example.com.
   Administrator login is in ~/.local/state/teleop/administrator.txt on the host.

Allow LAN DNS on TCP/UDP 53, HTTPS on TCP 443, and media on TCP 7881 and UDP
51000-51100. Restrict AdGuard TCP 3000 to trusted admins; never forward
these ports publicly.
Reserve the host's LAN IP. The same domain URLs work in public mode; public DNS
points them to the public IP and Caddy uses Let's Encrypt. Keep the state
directory private and back it up with Docker volumes. No vehicle credentials
or fleet settings are included.
Managed native driving remains gated pending the separate vehicle handover work.

Later commands, from this directory and the same OS user:
  ./teleop start
  ./teleop verify
  ./teleop --help

Use --state /absolute/private/path for a different persistent directory.
"./teleop load" imports images without starting services. No public registry
access is needed after this archive has been transferred.

All LAN deployments require DNS names. IP-only LAN deployments, including
existing saved states, are rejected to keep their URLs and issuer consistent
with public mode. The launcher does not delete old state or volumes; migrate
identity/data explicitly into a separate domain-based deployment.

Public domains can use the same launcher:
  ./teleop --domain console.example.com --auth-domain login.example.com \
    --acme-email ops@example.com all
Use DNS-only records pointing to this host, public TCP 80/443, and outbound
DNS/HTTPS. Caddy obtains/renews Let's Encrypt certificates; do not install the
LAN root certificate in this mode. Public issuance still requires network access.
