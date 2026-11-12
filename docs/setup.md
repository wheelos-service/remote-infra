# LAN setup

The prebuilt Ubuntu 22.04 x86_64 package requires only Docker Engine, usable by
your user without `sudo`. It includes all images and setup tools; no domain,
source checkout, compilation, or registry access is needed after downloading it.

## 1. Deploy

Extract `teleop-1.0.0-rc1-linux-amd64.tar.gz`. From the extracted directory,
replace the example IP with the machine's LAN IPv4 address (`hostname -I` lists
its addresses). Reserve that IP in your router or configure a static address.

```bash
./teleop --lan-ip 192.168.1.50 all
```

The launcher loads the images, generates secrets, and creates the first
administrator. Keep the default state directory `~/.local/state/teleop` private.
Allow LAN clients through the host firewall on TCP **8443/8444**; media also
uses TCP **7881** and UDP **51000–51100**.

To build from a source checkout instead, install Python 3 and Compose v2, then
run `python3 infra/scripts/deploy.py --lan-ip 192.168.1.50 all` from the repository.
That path needs internet access for build dependencies.

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

Use the same LAN IP on the host and other computers:

- Webpage: `https://192.168.1.50:8443`
- Backend API: `https://192.168.1.50:8443/api`
- Login service: `https://192.168.1.50:8444`

Read `~/.local/state/teleop/administrator.txt` on the host for the administrator
login. The fleet starts empty; vehicle setup is separate, and managed native
driving remains disabled pending handover support.

To restart or check the deployment, use the same OS user:

```bash
./teleop start
./teleop verify
```

Back up the state directory and Docker volumes together. `--local` is reserved
for loopback-only testing; use `--lan-ip` for shared access.
