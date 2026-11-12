Teleop release for Ubuntu 22.04 x86_64

Requires Docker Engine usable by your user. No source checkout, Python, Go,
Node, Compose installation, domain, or build step is needed on the user machine.

1. Extract the archive and run from its directory (substitute your LAN IP):
     ./teleop --lan-ip 192.168.1.50 all
   The launcher loads the bundled images and generates private instance config.

2. Copy ~/.local/state/teleop/root.crt to each client and trust it in the OS/browser.
   Check the printed SHA-256 fingerprint. On Ubuntu clients:
     sudo cp root.crt /usr/local/share/ca-certificates/teleop.crt
     sudo update-ca-certificates
   Restart the browser. Share only root.crt, not the state directory.

3. Open https://192.168.1.50:8443 on the host or another LAN computer.
   Backend: same address under /api. Login: https://192.168.1.50:8444.
   Administrator login is in ~/.local/state/teleop/administrator.txt on the host.

Allow LAN traffic on TCP 8443/8444; media also uses TCP 7881 and UDP 51000-51100.
Reserve the host's LAN IP. Keep the state directory private and back it up with
Docker volumes. No vehicle credentials or fleet settings are included.
Managed native driving remains gated pending the separate vehicle handover work.

Later commands, from this directory and the same OS user:
  ./teleop start
  ./teleop verify
  ./teleop --help

Use --state /absolute/private/path for a different persistent directory.
"./teleop load" imports images without starting services. No public registry
access is needed after this archive has been transferred.
