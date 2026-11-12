#!/usr/bin/env python3
"""Prepare and run a self-contained single-host Teleop deployment.

Requires Docker Engine with Compose v2 and Python 3; no host Go/Node toolchain.
For deployment on a local machine, use its LAN IPv4 address:

  python3 infra/scripts/deploy.py --lan-ip 192.168.1.50 all

Both the host and other LAN computers use https://192.168.1.50:8443.
The backend is at the same origin under /api; login uses port 8444.
No domain, public IP or DNS setup is required. Allow TCP 8443/8444 and,
for media, TCP 7881 and UDP 51000-51100 from the local network.
Use a stable/reserved LAN IP. Each client must trust the generated root.crt
in its OS/browser certificate store; check its printed SHA-256 fingerprint.
On Ubuntu clients: copy root.crt to /usr/local/share/ca-certificates/teleop.crt,
then run sudo update-ca-certificates and restart the browser.

--local is loopback-only HTTP testing without media or LAN access.
--domain plus --auth-domain remains available for public HTTPS on TCP 80/443.

Secrets and persistent identity settings live outside Git in --state (0700).
Subsequent commands need only --state and an action. Back up that directory
and the project's Docker volumes together. No vehicle configuration is seeded.
"""

import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
PROJECT = "teleop"
TENANT = "teleop"
ADMIN_NAME = "platform-admin"
PUBLIC_TLS = False
ACME_EMAIL = ""
ACME_STAGING = False
ACME_PRODUCTION_URL = "https://acme-v02.api.letsencrypt.org/directory"
ACME_STAGING_URL = "https://acme-staging-v02.api.letsencrypt.org/directory"
MEDIA_IP = ""
IP = "127.0.0.1"
APP = f"https://{IP}:8443"
AUTH = f"https://{IP}:8444"
LOCAL = False
MEDIA = False
DASHBOARD_SESSION_HOURS = 7 * 24
RELEASE_IMAGES = None


def load_release_images(path):
    manifest = json.loads(path.read_text())
    names = {"gateway", "frontend", "postgres", "redis", "casdoor", "livekit", "caddy", "storage-init"}
    images = manifest.get("images")
    if (manifest.get("platform") != "linux/amd64" or not isinstance(images, dict) or
            set(images) != names or any(not isinstance(value, str) or
            not re.fullmatch(r"[a-z0-9][a-z0-9./:@_-]+", value) for value in images.values())):
        raise RuntimeError("invalid prebuilt release image manifest")
    image_ids = manifest.get("image_ids")
    if (not isinstance(image_ids, dict) or set(image_ids) != names or
            any(not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value)
                for value in image_ids.values())):
        raise RuntimeError("release manifest requires an exact image ID for every service")
    for name, image in images.items():
        result = run(["docker", "image", "inspect", image], capture_output=True, text=True)
        info = json.loads(result.stdout)
        if (len(info) != 1 or info[0].get("Id") != image_ids[name] or
                info[0].get("Os") != "linux" or info[0].get("Architecture") != "amd64"):
            raise RuntimeError(f"release image mismatch for {name}; reload the verified release bundle")
    return images


def lan_address(value):
    try:
        address = ipaddress.IPv4Address(value)
        if any(address in ipaddress.IPv4Network(network)
               for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
            return str(address)
    except ipaddress.AddressValueError:
        pass
    raise argparse.ArgumentTypeError("use a private LAN IPv4 address assigned to this computer")


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def write(path, value):
    if path.exists() and (path.is_symlink() or path.stat().st_uid != os.getuid()):
        raise RuntimeError("refusing an unowned or symlink state file")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(value if isinstance(value, str) else json.dumps(value, indent=2))
    path.chmod(0o600)


def compose(state, *args, **kwargs):
    return run(["docker", "compose", "-p", PROJECT, "-f", str(state / "compose.json"),
                *args], **kwargs)


def check_project(state):
    result = run(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={PROJECT}",
                  "--format", '{{.Label "com.docker.compose.project.config_files"}}'],
                 capture_output=True, text=True)
    expected = str(state / "compose.json")
    if any(line.strip() != expected for line in result.stdout.splitlines()):
        raise RuntimeError("Compose project already belongs to another state directory; choose --project")


def prepare(state):
    previous = state / "onboarding.json"
    if previous.exists() and any(json.loads(previous.read_text()).get(key) != expected
                                 for key, expected in (("gateway_url", APP), ("casdoor_url", AUTH))):
        raise RuntimeError("deployment address changed; use a separate state directory")
    secrets_file = state / "secrets.json"
    if not secrets_file.exists():
        if previous.exists():
            raise RuntimeError("deployment secrets are missing; restore state from backup")
        write(secrets_file, {
            "postgres": secrets.token_hex(24), "livekit": secrets.token_urlsafe(36),
            "management_id": "management-" + secrets.token_hex(12),
            "management_secret": secrets.token_urlsafe(36),
            "browser_id": "browser-" + secrets.token_hex(12),
            "admin_password": secrets.token_urlsafe(24),
            "casdoor_admin_password": secrets.token_urlsafe(32),
            "admin_id": str(uuid.uuid4()), "org_id": str(uuid.uuid4()),
            "user_id": str(uuid.uuid4()),
            "encryption": base64.b64encode(secrets.token_bytes(32)).decode(),
        })
    values = json.loads(secrets_file.read_text())
    write(state / "administrator.txt",
          "Gateway platform administrator (not Casdoor built-in system administrator)\n"
          f"Username: {ADMIN_NAME}\n"
          f"Temporary password: {values['admin_password']}\n"
          f"Login: {APP}/#/admin\nClick 管理员登录, then enter the username and password.\n"
          f"Tenant: {TENANT}\nApplication: {TENANT}-browser\n"
          "Do not use the Casdoor built-in administrator/system console login.\n")
    write(state / "onboarding.key", values["encryption"])
    write(state / "onboarding.json", {
        "supported_version": "4.25.0", "casdoor_url": AUTH,
        "jwks_url": AUTH + "/.well-known/jwks",
        "management_client_id": values["management_id"],
        "management_client_secret": values["management_secret"],
        "casdoor_organization": TENANT,
        "browser_application": TENANT + "-browser",
        "certificate": "cert-built-in", "gateway_url": APP, "console_url": APP,
        "encryption_key_file": "/run/auth/onboarding.key",
    })
    write(state / "casdoor.conf",
          "appname = casdoor\nhttpaddr = 0.0.0.0\nhttpport = 8000\nrunmode = prod\n"
          "copyrequestbody = true\ndriverName = sqlite\n"
          "dataSourceName = file:/data/casdoor.db?cache=shared\ndbName = casdoor\n"
          "showSql = false\nlogPostOnly = true\n"
          "initDataFile = /conf/init_data.json\ninitDataNewOnly = true\n"
          f"initAdminPassword = {values['casdoor_admin_password']}\n"
          f"origin = {AUTH}\noriginFrontend = {AUTH}\n"
          f"defaultApplication = {TENANT}-browser\n")
    write(state / "casdoor-seed.json", {"applications": [{
        "owner": "admin", "name": TENANT + "-management",
        "organization": "built-in", "cert": "cert-built-in",
        "clientId": values["management_id"], "clientSecret": values["management_secret"],
        "grantTypes": ["client_credentials"], "tokenFormat": "JWT", "expireInHours": 0.1,
    }]})
    write(state / "livekit.yaml",
          "port: 7880\nrtc:\n  tcp_port: 7881\n  port_range_start: 51000\n"
          f"  port_range_end: 51100\n  use_external_ip: {str(PUBLIC_TLS and not MEDIA_IP).lower()}\n"
          "redis:\n  address: redis:6379\nkeys:\n"
          f"  teleop: {values['livekit']}\n"
          f"webhook:\n  api_key: teleop\n  urls:\n    - http://{'caddy' if LOCAL else 'gateway'}:8080/api/webhook/livekit\n")
    write(state / "runtime-config.js", "window.__LIVEKIT_INFRA_CONFIG__ = " + json.dumps({
        "gatewayUrl": APP, "livekitUrl": APP.replace("https:", "wss:").replace("http:", "ws:"),
        "authorizeUrl": AUTH + "/login/oauth/authorize",
        "tokenUrl": AUTH + "/api/login/oauth/access_token",
        "clientId": values["browser_id"],
    }) + ";\n")
    # This file is public browser configuration; Nginx's worker must read it.
    (state / "runtime-config.js").chmod(0o644)
    tls = "" if LOCAL or PUBLIC_TLS else "  tls internal\n"
    if PUBLIC_TLS:
        ca = ACME_STAGING_URL if ACME_STAGING else ACME_PRODUCTION_URL
        email = f"      email {ACME_EMAIL}\n" if ACME_EMAIL else ""
        tls = f"  tls {{\n    issuer acme {{\n      dir {ca}\n{email}    }}\n  }}\n"
    ca_route = "" if LOCAL or PUBLIC_TLS else """  @rootCA path /teleop-root-ca.crt /test-root-ca.crt
  handle @rootCA {
    header Content-Disposition "attachment; filename=teleop-root-ca.crt"
    rewrite * /root.crt
    root * /data/caddy/pki/authorities/local
    file_server
  }
"""
    global_options = ("" if PUBLIC_TLS else "  auto_https off" if LOCAL else
                      f"  auto_https disable_redirects\n  default_sni {IP}")
    write(state / "Caddyfile", f"""{{
  admin off
{global_options}
}}
{APP} {{
{tls}  @gateway path /api/* /rtc /rtc/* /healthz /readyz
{ca_route}  handle @gateway {{
    reverse_proxy {'127.0.0.1' if LOCAL else 'gateway'}:8080
  }}
  handle {{
    reverse_proxy frontend:80
  }}
}}
{AUTH} {{
{tls}  reverse_proxy {'127.0.0.1' if LOCAL else 'casdoor'}:8000
}}
""")
    volume = lambda name, target: f"{state / name}:{target}:ro"
    env = {
        "LIVEKIT_API_KEY": "teleop", "LIVEKIT_API_SECRET": values["livekit"],
        "LIVEKIT_URL": "http://livekit:7880", "REDIS_URL": "redis:6379",
        "AUTH_MODE": "oidc", "OIDC_ISSUER": AUTH, "OIDC_AUDIENCE": values["browser_id"],
        "OIDC_JWKS_URL": AUTH + "/.well-known/jwks", "AUTHORIZATION_MODE": "managed",
        "AUTHORIZATION_DATABASE_URL":
            f"postgres://teleop:{values['postgres']}@postgres:5432/teleop?sslmode=disable",
        "AUTHORIZATION_MANAGED_MAINTENANCE": "false",
        "AUTHORIZATION_ONLINE_MUTATIONS": "true",
        "AUTHORIZATION_LIVEKIT_SERVER_VERSION": "v1.13.11",
        "AUTHORIZATION_LIVEKIT_INGRESS_GATED": "true",
        "AUTHORIZATION_ONBOARDING_CONFIG_FILE": "/run/auth/onboarding.json",
        "CONTROL_HANDOVER_ACK_ENABLED": "false", "SIMULATED_CONTROL_VEHICLES_JSON": "[]",
        "ALLOWED_ORIGINS": APP, "OPERATIONS_DB_PATH": "/var/lib/teleop/operations.db",
    }
    if not LOCAL and not PUBLIC_TLS:
        env["SSL_CERT_FILE"] = "/run/auth/root.crt"
    services = {
        "postgres": {
            "image": "postgres:16-alpine",
            "environment": {"POSTGRES_USER": "teleop", "POSTGRES_DB": "teleop",
                            "POSTGRES_PASSWORD": values["postgres"]},
            "volumes": ["postgres:/var/lib/postgresql/data"],
            "healthcheck": {"test": ["CMD", "pg_isready", "-U", "teleop", "-d", "teleop"],
                            "interval": "2s", "timeout": "2s", "retries": 30},
        },
        "redis": {
            "image": "redis:7-alpine",
            "command": ["redis-server", "--appendonly", "yes", "--appendfsync", "always",
                        "--maxmemory-policy", "noeviction"],
            "volumes": ["redis:/data"],
            "healthcheck": {"test": ["CMD", "redis-cli", "ping"],
                            "interval": "2s", "timeout": "2s", "retries": 30},
        },
        "casdoor": {
            "image": "casbin/casdoor:v4.25.0", "user": f"{os.getuid()}:{os.getgid()}",
            "volumes": [volume("casdoor.conf", "/conf/app.conf"),
                        volume("casdoor-seed.json", "/conf/init_data.json"),
                        f"{state / 'casdoor-data'}:/data",
                        f"{state / 'casdoor-logs'}:/logs"],
        },
        "livekit": {
            "image": "livekit/livekit-server:v1.13.11",
            "command": ["--config", "/etc/livekit.yaml"],
            "volumes": [volume("livekit.yaml", "/etc/livekit.yaml")],
            "depends_on": ["redis"],
        },
        "gateway": {
            "image": PROJECT + "-gateway:local", "environment": env,
            "build": {"context": str(ROOT / "teleop-gateway")},
            "user": f"{os.getuid()}:{os.getgid()}",
            "volumes": [volume(name, "/run/auth/" + name)
                        for name in (("onboarding.json", "onboarding.key") if LOCAL or PUBLIC_TLS else
                                     ("onboarding.json", "onboarding.key", "root.crt"))]
                       + ["operations:/var/lib/teleop"],
            "depends_on": {"postgres": {"condition": "service_healthy"},
                           "storage-init": {"condition": "service_completed_successfully"},
                           "redis": {"condition": "service_healthy"},
                           "livekit": {"condition": "service_started"}},
        },
        "frontend": {
            "image": PROJECT + "-frontend:local",
            "build": {"context": str(ROOT), "dockerfile": "frontend/Dockerfile"},
            "volumes": [volume("runtime-config.js", "/usr/share/nginx/html/runtime-config.js")],
        },
        "caddy": {
            "image": "caddy:2-alpine",
            "user": f"{os.getuid()}:{os.getgid()}",
            "environment": {"XDG_CONFIG_HOME": "/data/config"},
            "ports": [f"{IP}:{port}:{port}" for port in (8443, 8444)],
            "volumes": [volume("Caddyfile", "/etc/caddy/Caddyfile"),
                        f"{state / 'caddy-data'}:/data", "caddy-config:/config"],
        },
    }
    if PUBLIC_TLS:
        services["caddy"]["ports"] = ["80:80", "443:443"]
        services["caddy"]["networks"] = {"default": {"aliases": [
            urllib.parse.urlsplit(APP).hostname, urllib.parse.urlsplit(AUTH).hostname]}}
        services["caddy"]["sysctls"] = {"net.ipv4.ip_unprivileged_port_start": "0"}
    if MEDIA:
        if LOCAL:
            raise RuntimeError("media requires HTTPS")
        if MEDIA_IP or not PUBLIC_TLS:
            services["livekit"]["command"] += ["--node-ip", MEDIA_IP or IP]
        bind = "0.0.0.0" if PUBLIC_TLS else IP
        services["livekit"]["ports"] = [
            f"{bind}:7881:7881/tcp", f"{bind}:51000-51100:51000-51100/udp",
        ]
    if LOCAL:
        # Share loopback so the same public issuer and token URL work inside the
        # containers and on the host without sending credentials over plain LAN HTTP.
        services["gateway"]["network_mode"] = "service:caddy"
        services["gateway"]["depends_on"]["casdoor"] = {"condition": "service_started"}
        services["gateway"]["depends_on"]["caddy"] = {"condition": "service_started"}
        services["casdoor"]["network_mode"] = "service:caddy"
        services["casdoor"]["depends_on"] = ["caddy"]
    for service in services.values():
        service["restart"] = "unless-stopped"
    services["storage-init"] = {
        "image": "alpine:3.20", "restart": "no", "user": "0:0",
        "command": ["sh", "-c", f"chown {os.getuid()}:{os.getgid()} /var/lib/teleop && chmod 0700 /var/lib/teleop"],
        "volumes": ["operations:/var/lib/teleop"],
    }
    if RELEASE_IMAGES is not None:
        for name, service in services.items():
            service["image"] = RELEASE_IMAGES[name]
            service["platform"] = "linux/amd64"
            service["pull_policy"] = "never"
            service.pop("build", None)
    write(state / "compose.json", {
        "services": services,
        "volumes": {name: {} for name in
                    ("postgres", "redis", "operations", "caddy-config")},
    })
    for name in ("casdoor-data", "casdoor-logs", "caddy-data"):
        (state / name).mkdir(mode=0o700, exist_ok=True)
    compose(state, "config", "--quiet")
    return values


def build(state):
    if RELEASE_IMAGES is not None:
        raise RuntimeError("this release is already compiled; use start or all")
    # Build from lockfiles inside Linux containers; no host Go/Node toolchain.
    compose(state, "build", "gateway", "frontend")


def request(state, path, body=None, admin=True, origin=None, form=False, bearer=None):
    origin = origin or AUTH
    values = json.loads((state / "secrets.json").read_text())
    headers = {}
    if admin:
        credentials = f"{values['management_id']}:{values['management_secret']}"
        headers["Authorization"] = "Basic " + base64.b64encode(credentials.encode()).decode()
    if bearer is not None:
        headers["Authorization"] = "Bearer " + bearer
    payload = None
    if body is not None:
        payload = (urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
        headers["Content-Type"] = (
            "application/x-www-form-urlencoded" if form else "application/json")
    context = (ssl.create_default_context(cafile=str(state / "root.crt"))
               if not LOCAL and not PUBLIC_TLS else ssl.create_default_context())
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
    try:
        with opener.open(urllib.request.Request(origin + path, payload, headers), timeout=15) as response:
            data = response.read()
            if "json" in response.headers.get("Content-Type", ""):
                return json.loads(data)
            return {"_http_status": response.status}
    except urllib.error.HTTPError as error:
        # Do not log provider bodies: they can contain credentials and codes.
        raise RuntimeError(f"request failed with HTTP {error.code}") from None


def success(value, stage):
    if value.get("status") != "ok":
        raise RuntimeError(f"Casdoor operation failed: {stage}; response withheld")
    return value.get("data")


def start(state, values):
    compose(state, "up", "-d", "storage-init", "postgres", "redis", "casdoor", "livekit", "caddy")
    if not LOCAL and not PUBLIC_TLS:
        root = state / "caddy-data/caddy/pki/authorities/local/root.crt"
        for _ in range(120):
            if root.exists():
                write(state / "root.crt", root.read_text())
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("local CA did not initialize")
    for _ in range(120):
        try:
            request(state, "/api/health", admin=False)
            break
        except (OSError, RuntimeError):
            time.sleep(0.5)
    else:
        raise RuntimeError("Casdoor did not become ready")
    if not (state / "configured").exists():
        configure(state, values)
        write(state / "configured", "Casdoor tenant initialized\n")
    configure_dashboard_session(state, values)
    if not (state / "bootstrapped").exists():
        write(state / "bootstrap.json", {
            "org_id": values["org_id"], "org_name": "Fleet",
            "user_id": values["user_id"], "name": "Platform administrator",
            "issuer": AUTH, "subject": values["admin_id"],
        })
        compose(state, "run", "--rm", "--no-deps",
                "--volume", f"{state / 'bootstrap.json'}:/run/bootstrap/bootstrap.json:ro",
                "--entrypoint", "/usr/local/bin/auth-admin",
                "gateway", "--input", "/run/bootstrap/bootstrap.json")
        write(state / "bootstrapped", "Explicit platform administrator bootstrapped\n")
    compose(state, "up", "-d", "--force-recreate", "gateway", "frontend")


def ensure_object(state, kind, desired, identity_fields=()):
    query = urllib.parse.urlencode({"id": desired["owner"] + "/" + desired["name"]})
    current = success(request(state, f"/api/get-{kind}?" + query), f"{kind} inspection")
    if current is None:
        success(request(state, f"/api/add-{kind}", desired), f"{kind} creation")
        current = success(request(state, f"/api/get-{kind}?" + query), f"{kind} verification")
    fields = ("owner", "name", *identity_fields)
    if not isinstance(current, dict) or any(current.get(k) != desired[k] for k in fields):
        raise RuntimeError(f"{kind} identity mismatch; existing object unchanged")


def configure(state, values):
    organization = {
        "owner": "admin", "name": TENANT, "displayName": "Teleop",
        "passwordType": "bcrypt", "defaultTokenFormat": "JWT",
        "defaultApplication": TENANT + "-browser",
    }
    ensure_object(state, "organization", organization)
    browser = {
        "owner": "admin", "name": TENANT + "-browser",
        "displayName": "Teleop", "organization": organization["name"],
        "cert": "cert-built-in", "clientId": values["browser_id"],
        "grantTypes": ["authorization_code"], "tokenFormat": "JWT",
        "expireInHours": DASHBOARD_SESSION_HOURS,
        "cookieExpireInHours": DASHBOARD_SESSION_HOURS,
        "enablePassword": True, "enableSignUp": True, "disableSelfSignup": True,
        "signupItems": [
            {"name": name, "visible": True, "required": True}
            for name in ("Username", "Password", "Confirm password", "Invitation code")
        ],
        "signinMethods": [{"name": "Password", "displayName": "Password", "rule": "All"}],
        "providers": [],
        "redirectUris": [APP + "/"],
        "homepageUrl": APP + "/",
        "scopes": [{"name": name, "displayName": name}
                   for name in ("openid", "profile", "teleop:observe")],
    }
    native = success(request(state, "/api/get-application?id=admin/app-built-in"),
                     "native sign-in policy inspection")
    browser["signinItems"] = native["signinItems"]
    ensure_object(state, "application", browser, ("clientId", "organization"))
    ensure_object(state, "user", {
        "owner": organization["name"], "name": ADMIN_NAME,
        "displayName": "Platform administrator", "password": values["admin_password"],
        "id": values["admin_id"],
        "type": "normal-user", "isAdmin": False, "signupApplication": browser["name"],
    }, ("id",))


def configure_dashboard_session(state, values):
    """Reconcile existing deployments without replacing users or app settings."""
    identity = {
        "owner": "admin", "name": TENANT + "-browser",
        "organization": TENANT, "clientId": values["browser_id"],
    }
    query = urllib.parse.urlencode({"id": "admin/" + TENANT + "-browser"})
    application = success(request(state, "/api/get-application?" + query),
                          "dashboard session policy inspection")
    if not isinstance(application, dict) or any(application.get(k) != v for k, v in identity.items()):
        raise RuntimeError("dashboard application identity mismatch; session policy unchanged")
    desired = {"expireInHours": DASHBOARD_SESSION_HOURS,
               "cookieExpireInHours": DASHBOARD_SESSION_HOURS}
    if all(application.get(k) == v for k, v in desired.items()):
        return
    backup = state / "dashboard-session-before.json"
    if not backup.exists():
        write(backup, {"application": identity["name"],
                       **{k: application.get(k) for k in desired}})
    success(request(state, "/api/update-application?" + query,
                    {**application, **desired}), "dashboard session policy update")
    saved = success(request(state, "/api/get-application?" + query),
                    "dashboard session policy verification")
    if not isinstance(saved, dict) or any(saved.get(k) != v for k, v in {**identity, **desired}.items()):
        raise RuntimeError("dashboard session policy did not persist")


def verify(state, values, login=True):
    for _ in range(120):
        try:
            for path in ("/healthz", "/readyz"):
                request(state, path, admin=False, origin=APP)
            break
        except (OSError, RuntimeError):
            time.sleep(0.5)
    else:
        raise RuntimeError("Gateway health/readiness failed")
    discovery = request(state, "/.well-known/openid-configuration", admin=False)
    if discovery["issuer"] != AUTH or discovery["jwks_uri"] != AUTH + "/.well-known/jwks":
        raise RuntimeError("public discovery issuer/JWKS mismatch")
    for path in ("/api/admin/context", "/api/vehicles", "/rtc?access_token=invalid"):
        try:
            request(state, path, admin=False, origin=APP)
        except RuntimeError as error:
            if str(error) not in ("request failed with HTTP 401", "request failed with HTTP 403"):
                raise
        else:
            raise RuntimeError("unauthenticated access was not rejected")
    if not login:
        print(f"PASS: discovery and health/readiness. Console: {APP}")
        return
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    query = urllib.parse.urlencode({
        "clientId": values["browser_id"], "responseType": "code", "redirectUri": APP + "/",
        "scope": "openid profile teleop:observe", "state": secrets.token_urlsafe(24),
        "code_challenge_method": "S256", "code_challenge": challenge,
    })
    code = success(request(state, "/api/login?" + query, {
        "type": "code", "organization": TENANT,
        "application": TENANT + "-browser", "username": ADMIN_NAME,
        "password": values["admin_password"], "signinMethod": "Password", "autoSignin": False,
    }, admin=False), "actual administrator PKCE login")
    token = request(state, "/api/login/oauth/access_token", {
        "grant_type": "authorization_code", "client_id": values["browser_id"],
        "code": code, "code_verifier": verifier, "redirect_uri": APP + "/",
    }, admin=False, form=True)
    if not token.get("access_token"):
        raise RuntimeError("actual PKCE exchange failed; response withheld")
    claims_raw = token["access_token"].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(claims_raw + "=" * (-len(claims_raw) % 4)))
    if claims.get("iss") != AUTH or claims.get("sub") != values["admin_id"]:
        raise RuntimeError("actual administrator issuer/subject differs from bootstrap")
    if (type(claims.get("iat")) is not int or type(claims.get("exp")) is not int
            or claims["exp"] - claims["iat"] != DASHBOARD_SESSION_HOURS * 3600):
        raise RuntimeError("dashboard access token does not have the configured one-week lifetime")
    context = request(state, "/api/admin/context", admin=False, origin=APP,
                      bearer=token["access_token"])
    if not context.get("platform_admin"):
        raise RuntimeError("real administrator does not have platform administration")
    print("PASS: verified discovery, health/readiness, real S256 PKCE/admin context, "
          "and one-week dashboard token lifetime.")


def connection_info(state):
    print(f"Webpage (use this address on the host and clients): {APP}/")
    print(f"Backend API: {APP}/api\nHealth: {APP}/healthz\nLogin: {AUTH}")
    print(f"Administrator credentials (host only): {state / 'administrator.txt'}")
    if not LOCAL and not PUBLIC_TLS:
        print("LAN access: allow TCP 8443/8444 from your local network.")
        print("Use this LAN IP on every computer, including the deployment host; keep it reserved/static.")
        root = state / "root.crt"
        print(f"Trust this public CA certificate on each client's OS/browser: {root}")
        print(f"Certificate download: {APP}/teleop-root-ca.crt")
        if root.exists():
            fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(root.read_text())).hexdigest().upper()
            print("CA SHA-256: " + ":".join(fingerprint[i:i + 2] for i in range(0, len(fingerprint), 2)))
        print("Copy only root.crt to clients; keep the rest of the state directory private.")
    elif LOCAL:
        print("Loopback only: other computers cannot connect. Use --lan-ip with a separate state for LAN access.")
    elif PUBLIC_TLS:
        ca = ACME_STAGING_URL if ACME_STAGING else ACME_PRODUCTION_URL
        print(f"Automatic server certificates: Let's Encrypt ACME ({ca}).")
        print("Use DNS-only records pointing to this host; allow public TCP 80/443 and outbound HTTPS.")
        print(f"Certificate/account storage: {state / 'caddy-data'} (keep private and persistent).")
        if ACME_STAGING:
            print("STAGING ONLY: certificates are not publicly trusted; do not enroll vehicles.")
        else:
            print("Caddy renews certificates automatically while running; clients use their system CA store.")
    if MEDIA:
        print("WebRTC media: TCP 7881 and UDP 51000-51100; no vehicles preconfigured.")
    else:
        print("No media ports published; no vehicles preconfigured.")


def domain_name(value):
    value = value.lower()
    if (len(value) > 253 or "." not in value or
            any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in value.split("."))):
        raise argparse.ArgumentTypeError("use a DNS hostname without scheme, path or port")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise argparse.ArgumentTypeError("use --lan-ip for an IP address")


def acme_email(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9.-]+", value):
        raise argparse.ArgumentTypeError("use an ACME contact email without whitespace or Caddyfile syntax")
    local, host = value.split("@")
    return local + "@" + domain_name(host)


def project_name(value):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,40}", value):
        raise argparse.ArgumentTypeError("use a lowercase name starting with a letter (max 41 characters)")
    return value


def deployment_settings(state, args):
    """Persist identity/topology so restarts cannot silently change the issuer."""
    settings = state / "deployment.json"
    supplied = {key: getattr(args, key) for key in
                ("local", "lan_ip", "domain", "auth_domain", "project", "media_ip",
                 "acme_email", "acme_staging")
                if getattr(args, key) is not None}
    if settings.exists():
        saved = json.loads(settings.read_text())
        if any(saved.get(key) != value for key, value in supplied.items()):
            raise RuntimeError("deployment settings changed; use a separate state directory")
        return saved
    if not (args.local or args.lan_ip or args.domain):
        raise RuntimeError("first deployment requires --domain, --lan-ip or --local")
    if bool(args.domain) != bool(args.auth_domain) or args.domain and args.domain == args.auth_domain:
        raise RuntimeError("public HTTPS requires distinct --domain and --auth-domain")
    if args.media_ip and not args.domain:
        raise RuntimeError("--media-ip is only used with --domain")
    if (args.acme_email or args.acme_staging) and not args.domain:
        raise RuntimeError("ACME options require --domain and --auth-domain")
    if (state / "secrets.json").exists() or (state / "onboarding.json").exists():
        raise RuntimeError("state belongs to another deployment tool; use a new directory")
    saved = dict(local=bool(args.local), lan_ip=args.lan_ip, domain=args.domain,
                 auth_domain=args.auth_domain, project=args.project or "teleop", media_ip=args.media_ip,
                 acme_email=args.acme_email, acme_staging=bool(args.acme_staging))
    write(settings, saved)
    return saved


def main():
    global LOCAL, MEDIA, IP, APP, AUTH, PROJECT, PUBLIC_TLS, MEDIA_IP, RELEASE_IMAGES, ACME_EMAIL, ACME_STAGING
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--state", type=Path, default=Path.home() / ".local/state/teleop",
                        help="private persistent directory (default: ~/.local/state/teleop)")
    address = parser.add_mutually_exclusive_group()
    address.add_argument("--local", "--loopback", action="store_true", default=None,
                         help="loopback HTTP acceptance deployment; no media")
    address.add_argument("--lan-ip", type=lan_address,
                         help="LAN deployment: private IPv4 address assigned to this host (no domain needed)")
    address.add_argument("--domain", type=domain_name, help="public console/Gateway DNS hostname")
    parser.add_argument("--auth-domain", type=domain_name, help="public Casdoor DNS hostname")
    parser.add_argument("--acme-email", type=acme_email, help="Let's Encrypt ACME contact email")
    parser.add_argument("--acme-staging", action="store_true", default=None,
                        help="prepare only: test certificate issuance with untrusted Let's Encrypt staging")
    parser.add_argument("--project", type=project_name, help="Compose project name (default: teleop)")
    parser.add_argument("--media-ip", type=ipaddress.IPv4Address,
                        help="explicit public media IPv4 address, otherwise discover automatically")
    parser.add_argument("--login-check", action="store_true",
                        help="verify initial administrator PKCE login before changing its password")
    parser.add_argument("--images", type=Path, help="prebuilt release image manifest (no compilation or pulls)")
    parser.add_argument("action", choices=("prepare", "build", "start", "verify", "all", "configure-session"))
    args = parser.parse_args()
    image_manifest = args.images or Path(__file__).with_name("release-images.json")
    if args.images or image_manifest.exists():
        RELEASE_IMAGES = load_release_images(image_manifest)
    if args.media_ip is not None:
        args.media_ip = str(args.media_ip)
    state = args.state.expanduser().resolve()
    if ROOT == state or ROOT in state.parents:
        parser.error("--state must be outside the repository")
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = state.stat()
    if not state.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        parser.error("--state must be owned by the current user with mode 0700")
    os.umask(0o077)
    config = deployment_settings(state, args)
    ACME_EMAIL, ACME_STAGING = config.get("acme_email") or "", config.get("acme_staging", False)
    if ACME_STAGING and args.action != "prepare":
        parser.error("ACME staging supports prepare only; use a separate production state for trusted HTTPS")
    LOCAL, PUBLIC_TLS = config["local"], bool(config["domain"])
    PROJECT, MEDIA_IP = config["project"], config["media_ip"] or ""
    check_project(state)
    MEDIA = not LOCAL
    IP = config["lan_ip"] or "127.0.0.1"
    if PUBLIC_TLS:
        APP, AUTH = "https://" + config["domain"], "https://" + config["auth_domain"]
    else:
        scheme = "http" if LOCAL else "https"
        APP, AUTH = (f"{scheme}://{IP}:{port}" for port in (8443, 8444))
    first_boot = not (state / "bootstrapped").exists()
    values = prepare(state)
    if args.action == "build" or args.action == "all" and RELEASE_IMAGES is None:
        build(state)
    if args.action in ("start", "all"):
        start(state, values)
    if args.action == "configure-session":
        configure_dashboard_session(state, values)
    if args.action in ("verify", "start", "all", "configure-session"):
        verify(state, values, login=args.login_check or first_boot)
    connection_info(state)
    print(f"Deployment state: {state} (keep private; back up with Docker volumes)")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        # Never dump provider bodies, credentials, or generated Compose environment.
        raise SystemExit(str(error)) from None
