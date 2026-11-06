#!/usr/bin/env python3
"""Verify pinned, disposable Casdoor API contracts without production secrets."""

import base64
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

IMAGE = "casbin/casdoor:v4.25.0"
ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    name = "managed-casdoor-" + uuid.uuid4().hex[:12]
    database = name + "-db"
    runner = name + "-go"
    client, secret = "management-" + uuid.uuid4().hex, secrets.token_urlsafe(32)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        casdoor_port = reservation.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="managed-casdoor-") as directory:
        work = pathlib.Path(directory)
        config = work / "app.conf"
        config.write_text(
            f"appname = casdoor\nhttpaddr = 127.0.0.1\nhttpport = {casdoor_port}\nrunmode = prod\n"
            f"origin = http://127.0.0.1:{casdoor_port}\noriginFrontend = http://127.0.0.1:{casdoor_port}\n"
            "copyrequestbody = true\ndriverName = sqlite\n"
            "dataSourceName = file:/tmp/contract.db?cache=shared\n"
            "dbName = casdoor\nshowSql = false\n"
            "initDataFile = /conf/init_data.json\ninitDataNewOnly = true\n"
            f"initAdminPassword = {secrets.token_urlsafe(32)}\n"
            "logPostOnly = true\n"
        )
        seed = {
            "applications": [{
                "owner": "admin", "name": "contract-management",
                "organization": "built-in", "cert": "cert-built-in",
                "clientId": client, "clientSecret": secret,
                "grantTypes": ["client_credentials"], "tokenFormat": "JWT",
                "expireInHours": 0.1,
            }],
        }
        data_file = work / "init_data.json"
        data_file.write_text(json.dumps(seed))
        config.chmod(0o600)
        data_file.chmod(0o600)
        started = []
        try:
            subprocess.run([
                "docker", "run", "--rm", "-d", "--name", name,
                "--user", "0:0", "--network", "host",
                "-v", f"{config}:/conf/app.conf:ro",
                "-v", f"{data_file}:/conf/init_data.json:ro", IMAGE,
            ], check=True, stdout=subprocess.DEVNULL)
            started.append(name)
            origin = f"http://127.0.0.1:{casdoor_port}"
            for _ in range(300):
                try:
                    with urllib.request.urlopen(origin + "/api/health", timeout=1):
                        break
                except OSError:
                    time.sleep(0.2)
            else:
                raise RuntimeError("pinned disposable Casdoor did not become ready")

            def request(path, body=None, admin=True, form=False):
                headers = {}
                if admin:
                    encoded = base64.b64encode(f"{client}:{secret}".encode()).decode()
                    headers["Authorization"] = "Basic " + encoded
                payload = None
                if body is not None:
                    payload = (urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
                    headers["Content-Type"] = (
                        "application/x-www-form-urlencoded" if form else "application/json"
                    )
                req = urllib.request.Request(origin + path, data=payload, headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=10) as response:
                        return json.load(response)
                except urllib.error.HTTPError as error:
                    # Parse only in memory. Never print provider bodies or tokens.
                    return json.loads(error.read())

            def success(value, stage):
                if value.get("status") != "ok":
                    message = str(value.get("msg", "")).lower()
                    categories = [word for word in (
                        "password", "scope", "redirect", "application", "disabled",
                        "invalid", "unauthorized", "state", "captcha", "required", "empty",
                    ) if word in message]
                    raise RuntimeError(f"Casdoor contract failed at {stage}; categories={categories}")
                return value.get("data")

            org = {
                "owner": "admin", "name": "contract-fleet", "displayName": "Disposable contract",
                "passwordType": "bcrypt", "defaultTokenFormat": "JWT",
                "defaultApplication": "contract-browser",
            }
            success(request("/api/add-organization", org), "organization creation")
            browser = {
                "owner": "admin", "name": "contract-browser",
                "organization": "contract-fleet", "cert": "cert-built-in",
                "clientId": "browser-" + uuid.uuid4().hex,
                "grantTypes": ["authorization_code"], "tokenFormat": "JWT",
                "expireInHours": 0.1, "enablePassword": True, "enableSignUp": False,
                "signinMethods": [{"name": "Password", "displayName": "Password", "rule": "All"}],
                "redirectUris": ["http://127.0.0.1:8000/"],
                "scopes": [
                    {"name": "openid", "displayName": "Identity"},
                    {"name": "profile", "displayName": "Profile"},
                    {"name": "teleop:observe", "displayName": "Observe"},
                ],
            }
            success(request("/api/add-application", browser), "browser application creation")
            user = {
                "owner": "contract-fleet", "name": "contract-person",
                "displayName": "Disposable person", "password": secrets.token_urlsafe(32),
                "id": str(uuid.uuid4()), "type": "normal-user", "isAdmin": False,
                "signupApplication": "contract-browser",
            }
            success(request("/api/add-user", user), "person creation")
            registered = success(request("/api/get-user?id=contract-fleet/contract-person"),
                                 "person reconciliation")
            if not registered.get("id") or registered.get("isAdmin"):
                raise RuntimeError("person creation did not preserve immutable non-admin identity")
            verifier = secrets.token_urlsafe(48)
            challenge = base64.urlsafe_b64encode(
                hashlib.sha256(verifier.encode()).digest()
            ).rstrip(b"=").decode()
            authorization = {
                "clientId": browser["clientId"], "responseType": "code",
                "redirectUri": browser["redirectUris"][0],
                "scope": "openid profile teleop:observe", "state": secrets.token_urlsafe(24),
                "code_challenge_method": "S256", "code_challenge": challenge,
            }
            code = success(request("/api/login?" + urllib.parse.urlencode(authorization), {
                "type": "code", "organization": user["owner"], "application": browser["name"],
                "username": user["name"], "password": user["password"],
                "signinMethod": "Password", "autoSignin": False,
            }, admin=False), "person PKCE login")
            if not isinstance(code, str) or not code:
                raise RuntimeError("PKCE login did not return authorization code")
            exchange = {
                "grant_type": "authorization_code", "client_id": browser["clientId"],
                "code": code, "code_verifier": verifier,
                "redirect_uri": browser["redirectUris"][0],
            }
            if request("/api/login/oauth/access_token",
                       {**exchange, "code_verifier": secrets.token_urlsafe(48)},
                       admin=False, form=True).get("access_token"):
                raise RuntimeError("PKCE exchange accepted incorrect verifier")
            human = request("/api/login/oauth/access_token", exchange, admin=False, form=True)
            if not human.get("access_token") or not human.get("id_token"):
                raise RuntimeError("public PKCE token exchange failed")
            if request("/api/login/oauth/access_token", exchange, admin=False,
                       form=True).get("access_token"):
                raise RuntimeError("authorization code replay accepted")
            duplicate = request("/api/add-user", user)
            if duplicate.get("status") == "ok":
                raise RuntimeError("duplicate identity creation unexpectedly succeeded")
            reconciled = success(request("/api/get-user?id=contract-fleet/contract-person"),
                                 "duplicate identity reconciliation")
            if reconciled.get("id") != registered["id"] or reconciled.get("isAdmin"):
                raise RuntimeError("duplicate identity changed immutable identity or privilege")
            vehicle = {
                "owner": "admin", "name": "contract-vehicle", "organization": "contract-fleet",
                "displayName": "Disposable vehicle", "cert": "cert-built-in",
                "clientId": "vehicle-" + uuid.uuid4().hex,
                "clientSecret": secrets.token_urlsafe(32),
                "grantTypes": ["client_credentials"], "tokenFormat": "JWT",
                "scopes": [{"name": "teleop:vehicle", "displayName": "Vehicle API"}],
                "expireInHours": 0.1,
            }
            success(request("/api/add-application", vehicle), "vehicle client creation")

            def token(secret_value, scope="teleop:vehicle"):
                return request("/api/login/oauth/access_token", {
                    "grant_type": "client_credentials", "client_id": vehicle["clientId"],
                    "client_secret": secret_value, "scope": scope,
                }, admin=False, form=True)

            def claims(value):
                raw = value.get("access_token")
                if not raw:
                    raise RuntimeError("device token issuance failed")
                segment = raw.split(".")[1]
                return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))

            issued = token(vehicle["clientSecret"])
            actual = claims(issued)
            if actual.get("sub") != "admin/contract-vehicle":
                raise RuntimeError("actual device subject differs from pinned application identity contract")
            if actual.get("aud") not in ([vehicle["clientId"]], vehicle["clientId"]):
                raise RuntimeError("actual device audience differs from client audience contract")
            if actual.get("scope") != "teleop:vehicle":
                raise RuntimeError("actual device scope missing or broadened")
            if token(vehicle["clientSecret"], "teleop:observe").get("access_token"):
                raise RuntimeError("device client accepted undelegated human scope")
            if token("incorrect").get("access_token"):
                raise RuntimeError("incorrect device secret accepted")
            previous = vehicle["clientSecret"]
            vehicle = success(request("/api/get-application?id=admin/contract-vehicle"),
                              "vehicle reconciliation")
            vehicle["clientSecret"] = secrets.token_urlsafe(32)
            success(request("/api/update-application?id=admin/contract-vehicle", vehicle),
                    "vehicle secret rotation")
            if token(previous).get("access_token"):
                raise RuntimeError("rotated-out secret still issued a new access token")
            rotated = token(vehicle["clientSecret"])
            if claims(rotated).get("sub") != actual["sub"]:
                raise RuntimeError("credential rotation changed device identity")
            discovery = request("/.well-known/openid-configuration", admin=False)
            if not discovery.get("jwks_uri") or discovery.get("issuer") != actual.get("iss"):
                raise RuntimeError("discovery and actual issuer disagree")
            subprocess.run([
                "docker", "run", "--rm", "-d", "--name", database,
                "-e", "POSTGRES_PASSWORD=disposable-loopback-only",
                "-e", "POSTGRES_DB=casdoor_test", "-p", "127.0.0.1::5432",
                "postgres:16-alpine",
            ], check=True, stdout=subprocess.DEVNULL)
            started.append(database)
            db_port = subprocess.check_output(
                ["docker", "port", database, "5432/tcp"], text=True
            ).strip().rsplit(":", 1)[1]
            for _ in range(100):
                result = subprocess.run(
                    ["docker", "exec", database, "pg_isready", "-U", "postgres",
                     "-d", "casdoor_test"], capture_output=True, check=False,
                )
                if result.returncode == 0:
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("disposable PostgreSQL did not become ready")
            database_host = "127.0.0.1"
            if os.environ.get("AUTH_TEST_CONTAINER_RUNNER") == "true":
                database_host = subprocess.check_output([
                    "docker", "inspect", "--format",
                    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", database,
                ], text=True).strip()
                db_port = "5432"
            env = {
                **os.environ,
                "CASDOOR_CONTRACT_ACCESS_TOKEN": rotated["access_token"],
                "CASDOOR_CONTRACT_ISSUER": actual["iss"],
                "CASDOOR_CONTRACT_JWKS_URL": discovery["jwks_uri"],
                "CASDOOR_CONTRACT_AUDIENCE": vehicle["clientId"],
                "CASDOOR_CONTRACT_PERSON_TOKEN": human["access_token"],
                "CASDOOR_CONTRACT_ID_TOKEN": human["id_token"],
                "CASDOOR_CONTRACT_PERSON_AUDIENCE": browser["clientId"],
                "CASDOOR_CONTRACT_PERSON_SUBJECT": registered["id"],
                "CASDOOR_CONTRACT_MANAGEMENT_CLIENT": client,
                "CASDOOR_CONTRACT_MANAGEMENT_SECRET": secret,
                "CASDOOR_CONTRACT_BROWSER_CLIENT": browser["clientId"],
                "CASDOOR_CONTRACT_BROWSER_APPLICATION": browser["name"],
                "CASDOOR_CONTRACT_ORGANIZATION": user["owner"],
                "AUTHZ_POSTGRES_TEST_DSN":
                    f"postgres://postgres:disposable-loopback-only@{database_host}:{db_port}/casdoor_test?sslmode=disable",
            }
            test = ["go", "test", "-mod=readonly", "-p", "1", "./internal/gateway",
                    "-run", "^Test(CasdoorRealDeviceTokenAndBinding|AutomatedOnboardingActualFlow)$",
                    "-count=1", "-v", "-timeout=180s"]
            command = test
            if not shutil.which("go"):
                cache = ROOT / ".cache/managed-auth-go-cache"
                cache.mkdir(parents=True, exist_ok=True)
                command = [
                    "docker", "run", "--rm", "--name", runner, "--network", "host",
                    "--user", f"{os.getuid()}:{os.getgid()}",
                    "-v", f"{ROOT}:/src:ro", "-v", f"{cache}:/cache",
                    "-e", "GOCACHE=/cache/build", "-e", "GOMODCACHE=/cache/mod",
                    "-w", "/src/apps/teleop-gateway",
                ]
                for key in ("CASDOOR_CONTRACT_ACCESS_TOKEN", "CASDOOR_CONTRACT_ISSUER",
                            "CASDOOR_CONTRACT_JWKS_URL", "CASDOOR_CONTRACT_AUDIENCE",
                            "CASDOOR_CONTRACT_PERSON_TOKEN", "CASDOOR_CONTRACT_PERSON_AUDIENCE",
                            "CASDOOR_CONTRACT_ID_TOKEN",
                            "CASDOOR_CONTRACT_PERSON_SUBJECT",
                            "CASDOOR_CONTRACT_MANAGEMENT_CLIENT",
                            "CASDOOR_CONTRACT_MANAGEMENT_SECRET",
                            "CASDOOR_CONTRACT_BROWSER_CLIENT",
                            "CASDOOR_CONTRACT_BROWSER_APPLICATION",
                            "CASDOOR_CONTRACT_ORGANIZATION",
                            "AUTHZ_POSTGRES_TEST_DSN"):
                    command.extend(["-e", key])
                command.extend(["golang:1.24", *test])
                started.append(runner)
            subprocess.run(command, cwd=ROOT / "apps/teleop-gateway", env=env,
                           check=True, timeout=300)
            print("PASS Casdoor v4.25.0: Basic-header management, create/reconcile person and vehicle, "
                  "actual personnel PKCE and client_credentials subject/audience/scope, "
                  "negative scope/secret, rotation; native invitation/recovery/first login, "
                  "Gateway onboarding and actual protected Python installation.")
            print("Rotation rejects future grants with the old secret; already issued JWTs remain "
                  "subject to Gateway expiry/revocation. Mail is captured in an isolated SMTP sink; "
                  "no production delivery or physical-driving claim.")
        finally:
            for container in reversed(started):
                present = subprocess.check_output([
                    "docker", "container", "ls", "-a", "--filter", f"name=^/{container}$",
                    "--format", "{{.ID}}",
                ], text=True, timeout=15).strip()
                if present:
                    subprocess.run(["docker", "stop", "-t", "1", container],
                                   check=True, stdout=subprocess.DEVNULL, timeout=15)


if __name__ == "__main__":
    main()
