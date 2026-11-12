#!/usr/bin/env python3
"""Launch an isolated, simulation-only authentication acceptance deployment.

Run with --state pointing to an existing owner-only directory outside Git.
The directory holds generated Compose configuration, secrets and the local CA.
Use --local for loopback HTTP, or --lan-ip for a private LAN IPv4 address.
For LAN HTTPS, trust root.crt on each testing workstation. Use --no-email
to omit the legacy test mailbox and email provider.
Existing projects, ports 443/8000, real vehicles and external SMTP are untouched.
"""

import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
PROJECT = "authentication-test"
IP = "127.0.0.1"
APP = f"https://{IP}:8443"
AUTH = f"https://{IP}:8444"
MAIL = f"https://{IP}:8445"
LOCAL = False
NO_EMAIL = False
MEDIA = False
DASHBOARD_SESSION_HOURS = 7 * 24


def email_enabled():
    return not LOCAL and not NO_EMAIL


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


def prepare(state):
    previous = state / "onboarding.json"
    if previous.exists() and json.loads(previous.read_text()).get("gateway_url") != APP:
        raise RuntimeError("deployment address changed; use a separate state directory")
    secrets_file = state / "secrets.json"
    if not secrets_file.exists():
        write(secrets_file, {
            "postgres": secrets.token_hex(24), "livekit": secrets.token_urlsafe(36),
            "management_id": "management-" + secrets.token_hex(12),
            "management_secret": secrets.token_urlsafe(36),
            "browser_id": "browser-" + secrets.token_hex(12),
            "admin_password": secrets.token_urlsafe(24),
            "casdoor_admin_password": secrets.token_urlsafe(32),
            "admin_id": str(uuid.uuid4()), "org_id": str(uuid.uuid4()),
            "user_id": str(uuid.uuid4()), "mail_password": secrets.token_urlsafe(24),
            "encryption": base64.b64encode(secrets.token_bytes(32)).decode(),
        })
    values = json.loads(secrets_file.read_text())
    write(state / "administrator.txt",
          "Gateway platform administrator (not Casdoor built-in system administrator)\n"
          "Username: test-admin\nEmail: admin@example.test\n"
          f"Temporary password: {values['admin_password']}\n"
          f"Login: {APP}/#/admin\nClick 管理员登录, then enter the username and password.\n"
          "Tenant: authentication-test\nApplication: authentication-test-browser\n"
          "Do not use the Casdoor built-in administrator/system console login.\n")
    if email_enabled():
        write(state / "mail-credentials.txt",
              f"URL: {MAIL}\nUsername: mailbox\nPassword: {values['mail_password']}\n")
    write(state / "onboarding.key", values["encryption"])
    write(state / "onboarding.json", {
        "supported_version": "4.25.0", "casdoor_url": AUTH,
        "jwks_url": AUTH + "/.well-known/jwks",
        "management_client_id": values["management_id"],
        "management_client_secret": values["management_secret"],
        "casdoor_organization": "authentication-test",
        "browser_application": "authentication-test-browser",
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
          "defaultApplication = authentication-test-browser\n")
    write(state / "casdoor-seed.json", {"applications": [{
        "owner": "admin", "name": "authentication-test-management",
        "organization": "built-in", "cert": "cert-built-in",
        "clientId": values["management_id"], "clientSecret": values["management_secret"],
        "grantTypes": ["client_credentials"], "tokenFormat": "JWT", "expireInHours": 0.1,
    }]})
    write(state / "livekit.yaml",
          "port: 7880\nrtc:\n  tcp_port: 7881\n  port_range_start: 51000\n"
          "  port_range_end: 51010\n  use_external_ip: false\n"
          "redis:\n  address: redis:6379\nkeys:\n"
          f"  authentication_test: {values['livekit']}\n")
    write(state / "runtime-config.js", "window.__LIVEKIT_INFRA_CONFIG__ = " + json.dumps({
        "gatewayUrl": APP, "livekitUrl": APP.replace("https:", "wss:").replace("http:", "ws:"),
        "authorizeUrl": AUTH + "/login/oauth/authorize",
        "tokenUrl": AUTH + "/api/login/oauth/access_token",
        "clientId": values["browser_id"],
    }) + ";\n")
    # This file is public browser configuration; Nginx's worker must read it.
    (state / "runtime-config.js").chmod(0o644)
    tls = "" if LOCAL else "  tls internal\n"
    ca_route = "" if LOCAL else """  handle /test-root-ca.crt {
    rewrite * /root.crt
    root * /data/caddy/pki/authorities/local
    file_server
  }
"""
    global_options = "  auto_https off" if LOCAL else f"  auto_https disable_redirects\n  default_sni {IP}"
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
""" + (f"""{MAIL} {{
  tls internal
  reverse_proxy mailpit:8025
}}
""" if email_enabled() else ""))
    volume = lambda name, target: f"{state / name}:{target}:ro"
    env = {
        "LIVEKIT_API_KEY": "authentication_test", "LIVEKIT_API_SECRET": values["livekit"],
        "LIVEKIT_URL": "http://livekit:7880", "REDIS_URL": "redis:6379",
        "AUTH_MODE": "oidc", "OIDC_ISSUER": AUTH, "OIDC_AUDIENCE": values["browser_id"],
        "OIDC_JWKS_URL": AUTH + "/.well-known/jwks", "AUTHORIZATION_MODE": "managed",
        "AUTHORIZATION_DATABASE_URL":
            f"postgres://teleop:{values['postgres']}@postgres:5432/teleop?sslmode=disable",
        "AUTHORIZATION_MANAGED_MAINTENANCE": "false",
        "AUTHORIZATION_LIVEKIT_SERVER_VERSION": "v1.13.11",
        "AUTHORIZATION_LIVEKIT_INGRESS_GATED": "true",
        "AUTHORIZATION_ONBOARDING_CONFIG_FILE": "/run/auth/onboarding.json",
        "CONTROL_HANDOVER_ACK_ENABLED": "false", "SIMULATED_CONTROL_VEHICLES_JSON": "[]",
        "ALLOWED_ORIGINS": APP, "OPERATIONS_DB_PATH": "/var/lib/teleop/operations.db",
    }
    if not LOCAL:
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
        },
        "casdoor": {
            "image": "casbin/casdoor:v4.25.0", "user": f"{os.getuid()}:{os.getgid()}",
            "volumes": [volume("casdoor.conf", "/conf/app.conf"),
                        volume("casdoor-seed.json", "/conf/init_data.json"),
                        f"{state / 'casdoor-data'}:/data",
                        f"{state / 'casdoor-logs'}:/logs"],
        },
        "mailpit": {
            "image": "axllent/mailpit:v1.29.2",
            "environment": {"MP_UI_AUTH": "mailbox:" + values["mail_password"]},
            "volumes": ["mailpit:/data"], "command": ["--database", "/data/mailpit.db"],
        },
        "livekit": {
            "image": "livekit/livekit-server:v1.13.11",
            "command": ["--config", "/etc/livekit.yaml"],
            "volumes": [volume("livekit.yaml", "/etc/livekit.yaml")],
            "depends_on": ["redis"],
        },
        "gateway": {
            "image": "authentication-test-gateway:local", "environment": env,
            "user": f"{os.getuid()}:{os.getgid()}",
            "volumes": [volume(name, "/run/auth/" + name)
                        for name in (("onboarding.json", "onboarding.key") if LOCAL else
                                     ("onboarding.json", "onboarding.key", "root.crt"))]
                       + ["operations:/var/lib/teleop"],
            "depends_on": {"postgres": {"condition": "service_healthy"},
                           "redis": {"condition": "service_started"},
                           "livekit": {"condition": "service_started"}},
        },
        "frontend": {
            "image": "authentication-test-frontend:local",
            "volumes": [volume("runtime-config.js", "/usr/share/nginx/html/runtime-config.js")],
        },
        "caddy": {
            "image": "caddy:2-alpine",
            "user": f"{os.getuid()}:{os.getgid()}",
            "environment": {"XDG_CONFIG_HOME": "/data/config"},
            "ports": [f"{IP}:{port}:{port}" for port in
                      ((8443, 8444, 8445) if email_enabled() else (8443, 8444))],
            "volumes": [volume("Caddyfile", "/etc/caddy/Caddyfile"),
                        f"{state / 'caddy-data'}:/data", "caddy-config:/config"],
        },
    }
    if not email_enabled():
        del services["mailpit"]
    if MEDIA:
        if LOCAL:
            raise RuntimeError("LAN media requires --lan-ip")
        services["livekit"]["command"] += ["--node-ip", IP]
        services["livekit"]["ports"] = [
            f"{IP}:7881:7881/tcp", f"{IP}:51000-51010:51000-51010/udp",
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
    write(state / "compose.json", {
        "services": services,
        "volumes": {name: {} for name in
                    ("postgres", "redis", "operations", "caddy-config")
                    + (("mailpit",) if email_enabled() else ())},
    })
    for name in ("casdoor-data", "casdoor-logs", "caddy-data"):
        (state / name).mkdir(mode=0o700, exist_ok=True)
    compose(state, "config", "--quiet")
    return values


def build(state):
    backend = ROOT / "apps/teleop-gateway/teleop-backend"
    had_backend = backend.exists()
    run([str(ROOT / "infra/scripts/build-backend.sh")], cwd=ROOT)
    run([str(ROOT / "infra/scripts/build-frontend.sh")], cwd=ROOT)
    run(["docker", "run", "--rm", "-v", f"{ROOT / 'apps/teleop-gateway'}:/app",
         "-v", f"{state}:/output", "-w", "/app",
         "-e", "GOPROXY=" + os.environ.get("GOPROXY", "https://proxy.golang.org,direct"), "golang:1.24",
         "go", "build", "-mod=readonly", "-o", "/output/auth-admin", "./cmd/auth-admin"])
    write(state / "Gateway.Dockerfile",
          "FROM golang:1.24\nCOPY apps/teleop-gateway/teleop-backend /usr/local/bin/\n"
          f"RUN mkdir -p /var/lib/teleop && chown {os.getuid()}:{os.getgid()} /var/lib/teleop\n"
          "ENTRYPOINT [\"/usr/local/bin/teleop-backend\"]\n")
    run(["docker", "build", "--quiet", "-t", "authentication-test-gateway:local",
         "-f", str(state / "Gateway.Dockerfile"), "."], cwd=ROOT)
    if not had_backend:
        backend.unlink()
    # Keep the protected bootstrap executable out of the application image.
    context = state / "frontend-image"
    context.mkdir(mode=0o700, exist_ok=True)
    shutil.copytree(ROOT / "frontend/dist", context / "dist", dirs_exist_ok=True)
    write(context / "nginx.conf", (ROOT / "infra/frontend/nginx.conf").read_text())
    write(context / "Dockerfile",
          "FROM nginx:stable-alpine\n"
          "COPY nginx.conf /etc/nginx/conf.d/default.conf\n"
          "COPY dist/ /usr/share/nginx/html/\n"
          "RUN chmod -R a+rX /usr/share/nginx/html\n")
    run(["docker", "build", "--quiet", "-t", "authentication-test-frontend:local",
         str(context)], cwd=ROOT)


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
    context = ssl.create_default_context(cafile=str(state / "root.crt")) if not LOCAL else None
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
    compose(state, "up", "-d", "postgres", "redis", "casdoor", "livekit", "caddy",
            *(["mailpit"] if email_enabled() else []))
    if not LOCAL:
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
            "org_id": values["org_id"], "org_name": "Authentication test fleet",
            "user_id": values["user_id"], "name": "Test platform administrator",
            "issuer": AUTH, "subject": values["admin_id"],
        })
        compose(state, "run", "--rm", "--no-deps",
                "--volume", f"{state / 'auth-admin'}:/run/bootstrap/auth-admin:ro",
                "--volume", f"{state / 'bootstrap.json'}:/run/bootstrap/bootstrap.json:ro",
                "--entrypoint", "/run/bootstrap/auth-admin",
                "gateway", "--input", "/run/bootstrap/bootstrap.json")
        write(state / "bootstrapped", "Explicit platform administrator bootstrapped\n")
    compose(state, "up", "-d", "--force-recreate", "gateway", "frontend")


def configure(state, values):
    organization = {
        "owner": "admin", "name": "authentication-test", "displayName": "Authentication test",
        "passwordType": "bcrypt", "defaultTokenFormat": "JWT",
        "defaultApplication": "authentication-test-browser",
    }
    success(request(state, "/api/add-organization", organization), "organization creation")
    provider = {
        "owner": "admin", "name": "authentication-test-email", "category": "Email",
        "type": "Default", "clientId": "", "clientSecret": "",
        "clientId2": "no-reply@example.test", "host": "mailpit", "port": 1025,
        "sslMode": "Disable", "title": "Set up your authentication test account",
        "content": "<p>Verification code: %s</p><reset-link>"
                   '<p><a href="%link">Set your password</a></p></reset-link>',
    }
    if email_enabled():
        success(request(state, "/api/add-provider", provider), "private Email provider creation")
    browser = {
        "owner": "admin", "name": "authentication-test-browser",
        "displayName": "Authentication test", "organization": organization["name"],
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
        "providers": [{"name": provider["name"], "rule": "forget"}] if email_enabled() else [],
        "redirectUris": [APP + "/"],
        "homepageUrl": APP + "/",
        "scopes": [{"name": name, "displayName": name}
                   for name in ("openid", "profile", "teleop:observe")],
    }
    native = success(request(state, "/api/get-application?id=admin/app-built-in"),
                     "native sign-in policy inspection")
    browser["signinItems"] = native["signinItems"]
    success(request(state, "/api/add-application", browser), "public PKCE application creation")
    success(request(state, "/api/add-user", {
        "owner": organization["name"], "name": "test-admin",
        "displayName": "Test platform administrator", "password": values["admin_password"],
        "email": "admin@example.test", "id": values["admin_id"],
        "type": "normal-user", "isAdmin": False, "signupApplication": browser["name"],
    }), "administrator identity creation")


def configure_dashboard_session(state, values):
    """Reconcile existing deployments without replacing users or app settings."""
    identity = {
        "owner": "admin", "name": "authentication-test-browser",
        "organization": "authentication-test", "clientId": values["browser_id"],
    }
    query = urllib.parse.urlencode({"id": "admin/authentication-test-browser"})
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


def verify(state, values):
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
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    query = urllib.parse.urlencode({
        "clientId": values["browser_id"], "responseType": "code", "redirectUri": APP + "/",
        "scope": "openid profile teleop:observe", "state": secrets.token_urlsafe(24),
        "code_challenge_method": "S256", "code_challenge": challenge,
    })
    code = success(request(state, "/api/login?" + query, {
        "type": "code", "organization": "authentication-test",
        "application": "authentication-test-browser", "username": "test-admin",
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
    print(f"Admin: {APP}/#/admin\nCasdoor: {AUTH}")
    print(f"Credentials: {state / 'administrator.txt'}")
    if email_enabled():
        print(f"Protected mailbox: {MAIL}\nCredentials: {state / 'mail-credentials.txt'}")
    if not LOCAL:
        print(f"Verified TLS. Trust CA: {state / 'root.crt'}")
    if MEDIA:
        print("LAN WebRTC media: TCP 7881 and UDP 51000-51010; simulation control disabled.")
    else:
        print("No vehicle/media ports published; simulation control disabled.")


def main():
    global LOCAL, NO_EMAIL, MEDIA, IP, APP, AUTH, MAIL
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path)
    address = parser.add_mutually_exclusive_group(required=True)
    address.add_argument("--local", action="store_true",
                         help="bind to loopback HTTP with no email service or CA installation")
    address.add_argument("--lan-ip", type=lan_address,
                         help="bind HTTPS to this computer's private LAN IPv4 address")
    parser.add_argument("--no-email", action="store_true", help="omit the legacy email provider and mailbox")
    parser.add_argument("--media", action="store_true",
                        help="publish WebRTC media ports on --lan-ip for camera testing")
    parser.add_argument("action", choices=("prepare", "build", "start", "verify", "all", "configure-session"))
    args = parser.parse_args()
    LOCAL = args.local
    NO_EMAIL = args.no_email
    MEDIA = args.media
    if MEDIA and not args.lan_ip:
        parser.error("--media requires --lan-ip")
    if LOCAL:
        IP = "127.0.0.1"
    elif args.lan_ip:
        IP = args.lan_ip
    scheme = "http" if LOCAL else "https"
    APP, AUTH, MAIL = (f"{scheme}://{IP}:{port}" for port in (8443, 8444, 8445))
    state = args.state.resolve(strict=True)
    if ROOT == state or ROOT in state.parents:
        parser.error("--state must be outside the repository")
    info = state.stat()
    if not state.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        parser.error("--state must be owned by the current user with mode 0700")
    os.umask(0o077)
    values = prepare(state)
    if args.action in ("build", "all"):
        build(state)
    if args.action in ("start", "all"):
        start(state, values)
    if args.action == "configure-session":
        configure_dashboard_session(state, values)
    if args.action in ("verify", "all", "configure-session"):
        verify(state, values)


if __name__ == "__main__":
    main()
