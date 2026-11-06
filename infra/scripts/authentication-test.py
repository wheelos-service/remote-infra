#!/usr/bin/env python3
"""Deploy and verify a managed single-server environment.

Settings are stored outside Git. Use up for initial deployment, update to rebuild
and restart application services, and verify to check TLS and administrator login.
"""

import argparse
import base64
import hashlib
import fcntl
import ipaddress
import json
import os
import re
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
BIND_ADDRESS = None
MEDIA_IP = None
APP = f"https://{IP}:8443"
AUTH = f"https://{IP}:8444"
MAIL = f"https://{IP}:8445"


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


def prepare(state, media_port=0):
    maintenance = "false"
    if (state / "compose.json").exists():
        previous = json.loads((state / "compose.json").read_text())
        maintenance = previous["services"]["gateway"]["environment"].get(
            "AUTHORIZATION_MANAGED_MAINTENANCE", "false")
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
          f"Login: {APP}/#/admin\nClick 管理员登录, then enter the email and password.\n"
          "Tenant: authentication-test\nApplication: authentication-test-browser\n"
          "Do not use the Casdoor built-in administrator/system console login.\n")
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
        "certificate": "cert-built-in", "gateway_url": APP,
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
    rtc = (f"  tcp_port: {media_port}\n  udp_port: {media_port}\n  node_ip: {MEDIA_IP or IP}\n"
           if media_port else
           "  tcp_port: 7881\n  port_range_start: 51000\n  port_range_end: 51010\n")
    write(state / "livekit.yaml",
          "port: 7880\nrtc:\n" + rtc + "  use_external_ip: false\n"
          "redis:\n  address: redis:6379\nkeys:\n"
          f"  authentication_test: {values['livekit']}\n")
    write(state / "runtime-config.js", "window.__LIVEKIT_INFRA_CONFIG__ = " + json.dumps({
        "gatewayUrl": APP, "livekitUrl": APP.replace("https:", "wss:"),
        "authorizeUrl": AUTH + "/login/oauth/authorize",
        "tokenUrl": AUTH + "/api/login/oauth/access_token",
        "clientId": values["browser_id"], "simulationControl": False,
    }) + ";\n")
    # This file is public browser configuration; Nginx's worker must read it.
    (state / "runtime-config.js").chmod(0o644)
    write(state / "Caddyfile", f"""{{
  admin off
  auto_https disable_redirects
  default_sni {IP}
}}
{APP} {{
  tls internal
  @gateway path /api/* /rtc /rtc/* /healthz /readyz
  handle /test-root-ca.crt {{
    rewrite * /root.crt
    root * /data/caddy/pki/authorities/local
    file_server
  }}
  handle @gateway {{
    reverse_proxy gateway:8080
  }}
  handle {{
    reverse_proxy frontend:80
  }}
}}
{AUTH} {{
  tls internal
  reverse_proxy casdoor:8000
}}
{MAIL} {{
  tls internal
  reverse_proxy mailpit:8025
}}
""")
    volume = lambda name, target: f"{state / name}:{target}:ro"
    env = {
        "LIVEKIT_API_KEY": "authentication_test", "LIVEKIT_API_SECRET": values["livekit"],
        "LIVEKIT_URL": "http://livekit:7880", "REDIS_URL": "redis:6379",
        "AUTH_MODE": "oidc", "OIDC_ISSUER": AUTH, "OIDC_AUDIENCE": values["browser_id"],
        "OIDC_JWKS_URL": AUTH + "/.well-known/jwks", "AUTHORIZATION_MODE": "managed",
        "AUTHORIZATION_DATABASE_URL":
            f"postgres://teleop:{values['postgres']}@postgres:5432/teleop?sslmode=disable",
        "AUTHORIZATION_MANAGED_MAINTENANCE": maintenance,
        "AUTHORIZATION_LIVEKIT_SERVER_VERSION": "v1.13.11",
        "AUTHORIZATION_LIVEKIT_INGRESS_GATED": "true",
        "AUTHORIZATION_ONBOARDING_CONFIG_FILE": "/run/auth/onboarding.json",
        "CONTROL_HANDOVER_ACK_ENABLED": "false", "SIMULATED_CONTROL_VEHICLES_JSON": "[]",
        "ALLOWED_ORIGINS": APP, "OPERATIONS_DB_PATH": "/var/lib/teleop/operations.db",
        "SSL_CERT_FILE": "/run/auth/root.crt",
    }
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
            "image": f"{PROJECT}-gateway:local", "environment": env,
            "user": f"{os.getuid()}:{os.getgid()}",
            "volumes": [volume(name, "/run/auth/" + name)
                        for name in ("onboarding.json", "onboarding.key", "root.crt")]
                       + ["operations:/var/lib/teleop"],
            "depends_on": {"postgres": {"condition": "service_healthy"},
                           "redis": {"condition": "service_started"},
                           "livekit": {"condition": "service_started"}},
        },
        "frontend": {
            "image": f"{PROJECT}-frontend:local",
            "volumes": [volume("runtime-config.js", "/usr/share/nginx/html/runtime-config.js")],
        },
        "caddy": {
            "image": "caddy:2-alpine",
            "user": f"{os.getuid()}:{os.getgid()}",
            "environment": {"XDG_CONFIG_HOME": "/data/config"},
            "ports": [f"{BIND_ADDRESS or IP}:{urllib.parse.urlsplit(origin).port}:{urllib.parse.urlsplit(origin).port}"
                      for origin in (APP, AUTH, MAIL)],
            "volumes": [volume("Caddyfile", "/etc/caddy/Caddyfile"),
                        f"{state / 'caddy-data'}:/data", "caddy-config:/config"],
        },
    }
    if media_port:
        services["livekit"]["ports"] = [
            f"{BIND_ADDRESS or IP}:{media_port}:{media_port}/tcp",
            f"{BIND_ADDRESS or IP}:{media_port}:{media_port}/udp",
        ]
    for service in services.values():
        service["restart"] = "unless-stopped"
    write(state / "compose.json", {
        "services": services,
        "volumes": {name: {} for name in
                    ("postgres", "redis", "mailpit", "operations", "caddy-config")},
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
    run(["docker", "build", "--quiet", "-t", f"{PROJECT}-gateway:local",
         "-f", str(state / "Gateway.Dockerfile"), "."], cwd=ROOT)
    if not had_backend:
        backend.unlink()
    # Keep the protected bootstrap executable out of the application image.
    context = state / "frontend-image"
    context.mkdir(mode=0o700, exist_ok=True)
    if (context / "dist").exists():
        shutil.rmtree(context / "dist")
    shutil.copytree(ROOT / "frontend/dist", context / "dist")
    write(context / "nginx.conf", (ROOT / "infra/frontend/nginx.conf").read_text())
    write(context / "Dockerfile",
          "FROM nginx:stable-alpine\n"
          "COPY nginx.conf /etc/nginx/conf.d/default.conf\n"
          "COPY dist/ /usr/share/nginx/html/\n"
          "RUN chmod -R a+rX /usr/share/nginx/html\n")
    run(["docker", "build", "--quiet", "-t", f"{PROJECT}-frontend:local",
         str(context)], cwd=ROOT)


def request(state, path, body=None, admin=True, origin=None, form=False, bearer=None):
    if origin is None:
        origin = AUTH
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
    context = ssl.create_default_context(cafile=str(state / "root.crt"))
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


def start(state, values, reload_network=False):
    compose(state, "up", "-d", "postgres", "redis", "casdoor", "mailpit", "livekit", "caddy")
    if reload_network:
        # Compose does not detect changes inside bind-mounted configuration files.
        compose(state, "up", "-d", "--no-deps", "--force-recreate", "livekit", "caddy")
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
    success(request(state, "/api/add-provider", provider), "private Email provider creation")
    browser = {
        "owner": "admin", "name": "authentication-test-browser",
        "displayName": "Authentication test", "organization": organization["name"],
        "cert": "cert-built-in", "clientId": values["browser_id"],
        "grantTypes": ["authorization_code"], "tokenFormat": "JWT", "expireInHours": 0.1,
        "enablePassword": True, "enableSignUp": False,
        "signinMethods": [{"name": "Password", "displayName": "Password", "rule": "All"}],
        "providers": [{"name": provider["name"], "rule": "forget"}],
        "redirectUris": [APP + "/"],
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


def verify_frontend(state):
    context = ssl.create_default_context(cafile=str(state / "root.crt"))
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
    assets = {"/": state / "frontend-image/dist/index.html",
              "/main.js": state / "frontend-image/dist/main.js",
              "/main.css": state / "frontend-image/dist/main.css",
              "/runtime-config.js": state / "runtime-config.js"}
    for path, source in assets.items():
        expected = source.read_bytes()
        with opener.open(APP + path, timeout=30) as response:
            if response.status != 200 or response.read(len(expected) + 1) != expected:
                raise RuntimeError("served frontend does not match the built artifact: " + path)


def verify(state, values):
    for _ in range(120):
        try:
            for path in ("/healthz", "/readyz"):
                request(state, path, admin=False, origin=APP)
            verify_frontend(state)
            break
        except (OSError, RuntimeError):
            time.sleep(0.5)
    else:
        raise RuntimeError("Gateway readiness or served frontend verification failed")
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
    context = request(state, "/api/admin/context", admin=False, origin=APP,
                      bearer=token["access_token"])
    if not context.get("platform_admin"):
        raise RuntimeError("real administrator does not have platform administration")
    print("PASS: verified TLS, frontend assets, discovery, health/readiness, real S256 PKCE/admin context.")
    print(f"Admin: {APP}/#/admin\nCasdoor: {AUTH}\nProtected mailbox: {MAIL}")
    print(f"Credentials: {state / 'administrator.txt'} and {state / 'mail-credentials.txt'}")
    print(f"Trust CA: {state / 'root.crt'}")
    ports = json.loads((state / "compose.json").read_text())["services"]["livekit"].get("ports", [])
    print("LiveKit media ports: " + (", ".join(ports) if ports else "disabled"))
    print("Simulation control disabled. Camera publishing requires separate verification.")


def deployment_settings(parser, args, saved):
    """Resolve saved options before any file or service changes."""
    if not saved and args.host is None:
        parser.error("--host is required for a new environment")
    settings = dict(saved)
    defaults = {"project": "teleop", "base_port": 8443, "media_port": 0}
    for name in ("host", "project", "base_port", "media_port", "bind_address", "media_ip"):
        supplied = getattr(args, name)
        settings[name] = supplied if supplied is not None else saved.get(name, defaults.get(name))
    host = settings["host"]
    try:
        host_ip = str(ipaddress.IPv4Address(host))
    except ipaddress.AddressValueError:
        host_ip = None
        if (len(host) > 253 or not all(re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label)
                                      for label in host.split("."))):
            parser.error("--host must be an IPv4 address or DNS hostname, without a URL or port")
    project = settings["project"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        parser.error("--project must use lowercase letters, digits, hyphens or underscores")
    base_port, media_port = settings["base_port"], settings["media_port"]
    if not 1024 <= base_port <= 65533:
        parser.error("--base-port must be between 1024 and 65533")
    if media_port != 0 and not 1024 <= media_port <= 65535:
        parser.error("--media-port must be 0 or between 1024 and 65535")
    if media_port in range(base_port, base_port + 3):
        parser.error("--media-port must not overlap the HTTPS ports")
    settings["bind_address"] = settings["bind_address"] or host_ip or "0.0.0.0"
    settings["media_ip"] = settings["media_ip"] or host_ip
    for name in ("bind_address", "media_ip"):
        if settings[name] is not None:
            try:
                settings[name] = str(ipaddress.IPv4Address(settings[name]))
            except ipaddress.AddressValueError:
                parser.error("--" + name.replace("_", "-") + " must be an IPv4 address")
    if media_port and not settings["media_ip"]:
        parser.error("a DNS host with media enabled requires --media-ip (the reachable server IPv4 address)")
    if saved:
        for name in ("host", "project", "base_port"):
            if settings[name] != saved.get(name, defaults.get(name)):
                parser.error("state belongs to another host/project/HTTPS port; use its original settings or a new state directory")
        for name in ("media_port", "bind_address", "media_ip"):
            previous = saved.get(name, {"media_port": 0, "bind_address": host_ip or "0.0.0.0", "media_ip": host_ip}[name])
            if settings[name] != previous and args.action != "prepare":
                parser.error("network changes require explicit prepare, then start; update preserves saved configuration")
    return settings


def execute(state, settings, action):
    """Keep routine builds/updates separate from configuration generation."""
    if action in ("status", "logs", "stop"):
        commands = {"status": ("ps",), "logs": ("logs", "--tail=100", "gateway", "frontend"), "stop": ("stop",)}
        compose(state, *commands[action])
        return
    if action == "prepare" or not (state / "compose.json").exists():
        write(state / "deployment.json", settings)
        values = prepare(state, settings["media_port"])
    else:
        values = json.loads((state / "secrets.json").read_text())
    if action in ("maintenance-on", "maintenance-off"):
        config = json.loads((state / "compose.json").read_text())
        config["services"]["gateway"]["environment"]["AUTHORIZATION_MANAGED_MAINTENANCE"] = (
            "true" if action == "maintenance-on" else "false")
        write(state / "compose.json", config)
        compose(state, "up", "-d", "--no-deps", "--force-recreate", "gateway")
        return
    if action in ("build", "all", "up", "update"):
        compose(state, "config", "--quiet")
        build(state)
    if action == "update":
        compose(state, "up", "-d", "--no-deps", "--force-recreate", "gateway", "frontend")
    elif action in ("start", "all", "up"):
        start(state, values, reload_network=action == "start")
    if action in ("verify", "all", "up", "update"):
        verify(state, values)


def main(argv=None):
    global IP, APP, AUTH, MAIL, PROJECT, BIND_ADDRESS, MEDIA_IP
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path, help="private state directory outside the checkout; created on first deployment")
    parser.add_argument("--host", help="server IPv4 address or DNS name; required only on first deployment")
    parser.add_argument("--project", help="unique Compose project name (default: teleop)")
    parser.add_argument("--base-port", type=int, help="first of three HTTPS ports (default: 8443)")
    parser.add_argument("--media-port", type=int, help="LAN TCP/UDP media port; 0 disables it (default)")
    parser.add_argument("--bind-address", help="local IPv4 to bind (default: host IP, or 0.0.0.0 for DNS)")
    parser.add_argument("--media-ip", help="reachable server IPv4 advertised to media clients (default: host IP)")
    parser.add_argument("action", choices=("up", "update", "verify", "status", "logs", "stop", "prepare", "build", "start", "all", "maintenance-on", "maintenance-off"))
    args = parser.parse_args(argv)
    state = args.state.resolve()
    if ROOT == state or ROOT in state.parents:
        parser.error("--state must be outside the repository")
    if state.exists():
        info = state.stat()
        if not state.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            parser.error("--state must be owned by the current user with mode 0700")
    saved_path = state / "deployment.json"
    saved = json.loads(saved_path.read_text()) if saved_path.exists() else {}
    settings = deployment_settings(parser, args, saved)
    IP, PROJECT = settings["host"], settings["project"]
    BIND_ADDRESS, MEDIA_IP = settings["bind_address"], settings["media_ip"]
    APP, AUTH, MAIL = (f"https://{IP}:{settings['base_port'] + offset}" for offset in range(3))
    config_path = state / "compose.json"
    if config_path.exists():
        previous = json.loads(config_path.read_text())
        if previous["services"]["gateway"]["environment"]["OIDC_ISSUER"] != AUTH:
            parser.error("existing identities use another issuer; use their original host/port or a new state directory")
        if not saved:
            parser.error("existing Compose state is missing deployment.json; restore its saved identity before continuing")
        if not (state / "secrets.json").is_file():
            parser.error("existing environment is missing secrets.json; restore its protected state instead of generating new identities")
    elif args.action in ("update", "verify", "status", "logs", "stop", "maintenance-on", "maintenance-off"):
        parser.error("environment is not initialized; run up first")
    os.umask(0o077)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Prevent two deployment commands from writing shared state/recreating services.
    fd = os.open(state / ".deploy.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("another deployment command is running for this state directory")
        if (json.loads(saved_path.read_text()) if saved_path.exists() else {}) != saved:
            parser.error("deployment settings changed; retry the command")
        execute(state, settings, args.action)


if __name__ == "__main__":
    main()
