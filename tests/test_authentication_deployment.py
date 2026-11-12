import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "authentication_deployment", ROOT / "infra/scripts/authentication-test.py")
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class AuthenticationDeploymentTest(unittest.TestCase):
    def local_settings(self):
        return patch.multiple(deployment, LOCAL=True, IP="127.0.0.1",
                              APP="http://127.0.0.1:8443", AUTH="http://127.0.0.1:8444",
                              MAIL="http://127.0.0.1:8445")

    def test_local_ports_and_identity_urls_stay_on_loopback_without_email(self):
        with tempfile.TemporaryDirectory() as directory, self.local_settings(), \
                patch.object(deployment, "compose"):
            state = Path(directory)
            values = deployment.prepare(state)
            config = json.loads((state / "compose.json").read_text())
            services = config["services"]
            self.assertNotIn("mailpit", services)
            self.assertNotIn("mailpit", config["volumes"])
            self.assertEqual(services["caddy"]["ports"],
                             ["127.0.0.1:8443:8443", "127.0.0.1:8444:8444"])
            for name, service in services.items():
                if name != "caddy":
                    self.assertNotIn("ports", service)
            for name in ("gateway", "casdoor"):
                self.assertEqual(services[name]["network_mode"], "service:caddy")
            onboarding = json.loads((state / "onboarding.json").read_text())
            self.assertEqual(onboarding["casdoor_url"], deployment.AUTH)
            self.assertEqual(onboarding["gateway_url"], deployment.APP)
            self.assertEqual(onboarding["console_url"], deployment.APP)
            environment = services["gateway"]["environment"]
            self.assertEqual(environment["OIDC_ISSUER"], deployment.AUTH)
            self.assertEqual(environment["OIDC_JWKS_URL"], onboarding["jwks_url"])
            self.assertEqual(environment["AUTH_MODE"], "oidc")
            self.assertEqual(environment["SIMULATED_CONTROL_VEHICLES_JSON"], "[]")
            self.assertNotIn("SSL_CERT_FILE", environment)
            self.assertFalse((state / "mail-credentials.txt").exists())
            public = (state / "runtime-config.js").read_text()
            self.assertIn('"livekitUrl": "ws://127.0.0.1:8443"', public)
            for key in ("management_secret", "admin_password", "encryption", "postgres", "livekit"):
                self.assertNotIn(values[key], public)
            for name in ("secrets.json", "administrator.txt", "onboarding.json", "onboarding.key"):
                self.assertEqual((state / name).stat().st_mode & 0o777, 0o600)
            self.assertEqual(deployment.prepare(state)["admin_password"], values["admin_password"])
            seed = json.loads((state / "casdoor-seed.json").read_text())
            self.assertEqual(seed["applications"][0]["expireInHours"], 0.1)

    def test_lan_deployment_keeps_tls_and_private_mailbox(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "compose"):
            state = Path(directory)
            deployment.prepare(state)
            services = json.loads((state / "compose.json").read_text())["services"]
            self.assertIn("mailpit", services)
            self.assertNotIn("network_mode", services["gateway"])
            self.assertEqual(services["gateway"]["environment"]["SSL_CERT_FILE"], "/run/auth/root.crt")
            self.assertIn("tls internal", (state / "Caddyfile").read_text())
            self.assertEqual(services["caddy"]["ports"],
                             [f"{deployment.IP}:{port}:{port}" for port in (8443, 8444, 8445)])

    def test_changing_issuer_requires_a_separate_state_directory(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "compose"):
            state = Path(directory)
            deployment.prepare(state)
            before = (state / "onboarding.json").read_bytes()
            with self.local_settings(), self.assertRaisesRegex(RuntimeError, "separate state directory"):
                deployment.prepare(state)
            self.assertEqual((state / "onboarding.json").read_bytes(), before)

    def test_selected_lan_address_uses_tls_without_enabling_email(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "compose"), \
                patch.multiple(deployment, LOCAL=False, NO_EMAIL=True, IP="10.0.39.138",
                               APP="https://10.0.39.138:8443", AUTH="https://10.0.39.138:8444",
                               MAIL="https://10.0.39.138:8445"):
            state = Path(directory)
            deployment.prepare(state)
            services = json.loads((state / "compose.json").read_text())["services"]
            self.assertEqual(services["caddy"]["ports"],
                             ["10.0.39.138:8443:8443", "10.0.39.138:8444:8444"])
            self.assertNotIn("mailpit", services)
            self.assertNotIn("network_mode", services["gateway"])
            self.assertEqual(services["gateway"]["environment"]["OIDC_ISSUER"], deployment.AUTH)
            self.assertEqual(services["gateway"]["environment"]["SSL_CERT_FILE"], "/run/auth/root.crt")
            self.assertNotIn("127.0.0.1", (state / "runtime-config.js").read_text())
            self.assertIn("tls internal", (state / "Caddyfile").read_text())
            self.assertNotIn("8445", (state / "Caddyfile").read_text())
            self.assertFalse((state / "mail-credentials.txt").exists())

    def test_lan_address_rejects_non_lan_and_non_ip_inputs(self):
        for address in ("10.0.39.138", "172.16.4.2", "192.168.1.10"):
            self.assertEqual(deployment.lan_address(address), address)
        for address in ("127.0.0.1", "0.0.0.0", "169.254.1.1", "8.8.8.8", "::1", "example.com", "10.0.39.138:8443"):
            with self.subTest(address=address), self.assertRaises(deployment.argparse.ArgumentTypeError):
                deployment.lan_address(address)

    def test_lan_media_advertises_reachable_ip_and_keeps_signaling_behind_gateway(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "compose"), \
                patch.multiple(deployment, LOCAL=False, NO_EMAIL=True, MEDIA=True, IP="10.0.39.138",
                               APP="https://10.0.39.138:8443", AUTH="https://10.0.39.138:8444"):
            state = Path(directory)
            deployment.prepare(state)
            services = json.loads((state / "compose.json").read_text())["services"]
            self.assertEqual(services["livekit"]["command"][-2:], ["--node-ip", "10.0.39.138"])
            self.assertEqual(services["livekit"]["ports"],
                             ["10.0.39.138:7881:7881/tcp", "10.0.39.138:51000-51010:51000-51010/udp"])
            for service in services.values():
                self.assertFalse(any(":7880" in port for port in service.get("ports", [])))
            self.assertEqual(services["gateway"]["environment"]["LIVEKIT_URL"], "http://livekit:7880")
            self.assertIn("reverse_proxy gateway:8080", (state / "Caddyfile").read_text())
            self.assertNotIn('simulationControl', (state / "runtime-config.js").read_text())

    def test_local_signup_policy_requires_invitation_without_email_provider(self):
        def response(state, path, body=None):
            return {"status": "ok", "data": {"signinItems": []}}

        values = {"browser_id": "fixture-browser", "admin_password": "fixture-only",
                  "admin_id": "fixture-subject"}
        with self.local_settings(), patch.object(deployment, "request", side_effect=response) as request:
            deployment.configure(Path("/unused"), values)
        calls = request.call_args_list
        self.assertNotIn("/api/add-provider", [call.args[1] for call in calls])
        browser = next(call.args[2] for call in calls if call.args[1] == "/api/add-application")
        self.assertTrue(browser["enableSignUp"])
        self.assertTrue(browser["disableSelfSignup"])
        self.assertEqual(browser["providers"], [])
        self.assertEqual(browser["expireInHours"], 168)
        self.assertEqual(browser["cookieExpireInHours"], 168)
        self.assertEqual({item["name"] for item in browser["signupItems"]},
                         {"Username", "Password", "Confirm password", "Invitation code"})

    def test_existing_dashboard_session_update_preserves_application_settings(self):
        original = {
            "owner": "admin", "name": "authentication-test-browser",
            "organization": "authentication-test", "clientId": "fixture-browser",
            "expireInHours": 0.1, "cookieExpireInHours": 0,
            "redirectUris": ["https://console.example.test/"],
            "grantTypes": ["authorization_code"], "disableSelfSignup": True,
            "signinItems": [{"name": "Password"}], "custom_setting": "preserve",
        }
        saved = {**original, "expireInHours": 168, "cookieExpireInHours": 168}
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "request", side_effect=[
            {"status": "ok", "data": original}, {"status": "ok", "data": "Affected"},
            {"status": "ok", "data": saved},
        ]) as request:
            state = Path(directory)
            deployment.configure_dashboard_session(state, {"browser_id": "fixture-browser"})
            self.assertEqual(request.call_args_list[1].args[2], saved)
            self.assertIn("/api/update-application?", request.call_args_list[1].args[1])
            before = state / "dashboard-session-before.json"
            self.assertEqual(json.loads(before.read_text()), {
                "application": original["name"], "expireInHours": 0.1, "cookieExpireInHours": 0,
            })
            self.assertEqual(before.stat().st_mode & 0o777, 0o600)
        self.assertEqual(original["expireInHours"], 0.1)

    def test_dashboard_session_update_is_idempotent_and_checks_identity(self):
        original = {
            "owner": "admin", "name": "authentication-test-browser",
            "organization": "authentication-test", "clientId": "fixture-browser",
            "expireInHours": 168, "cookieExpireInHours": 168,
        }
        with patch.object(deployment, "request", return_value={"status": "ok", "data": original}) as request:
            deployment.configure_dashboard_session(Path("/unused"), {"browser_id": "fixture-browser"})
            self.assertEqual(request.call_count, 1)
        for field in ("owner", "name", "organization", "clientId"):
            with self.subTest(field=field), patch.object(deployment, "request", return_value={
                "status": "ok", "data": {**original, field: "different", "expireInHours": 0.1},
            }) as request, self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                deployment.configure_dashboard_session(Path("/unused"), {"browser_id": "fixture-browser"})
            self.assertEqual(request.call_count, 1)

    def test_dashboard_session_update_rejects_provider_failure_and_stale_readback(self):
        original = {
            "owner": "admin", "name": "authentication-test-browser",
            "organization": "authentication-test", "clientId": "fixture-browser",
            "expireInHours": 0.1, "cookieExpireInHours": 0,
        }
        for response in ({"status": "error", "data": None}, {"status": "ok", "data": "Affected"}):
            with self.subTest(response=response["status"]), tempfile.TemporaryDirectory() as directory, \
                    patch.object(deployment, "request", side_effect=[
                        {"status": "ok", "data": original}, response,
                        {"status": "ok", "data": original},
                    ]), self.assertRaises(RuntimeError):
                deployment.configure_dashboard_session(Path(directory), {"browser_id": "fixture-browser"})

    def test_start_reconciles_session_policy_for_an_already_configured_deployment(self):
        with tempfile.TemporaryDirectory() as directory, self.local_settings(), \
                patch.object(deployment, "compose"), patch.object(deployment, "request"), \
                patch.object(deployment, "configure") as configure, \
                patch.object(deployment, "configure_dashboard_session") as reconcile:
            state = Path(directory)
            (state / "configured").touch()
            (state / "bootstrapped").touch()
            values = {"browser_id": "fixture-browser"}
            deployment.start(state, values)
            configure.assert_not_called()
            reconcile.assert_called_once_with(state, values)


if __name__ == "__main__":
    unittest.main()
