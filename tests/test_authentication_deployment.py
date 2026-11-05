import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "infra/scripts/authentication-test.py"
spec = importlib.util.spec_from_file_location("authentication_deployment", SOURCE)
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class AuthenticationDeploymentTest(unittest.TestCase):
    def test_isolated_host_project_and_private_services(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(deployment, "compose"), \
                patch.multiple(deployment, IP="192.0.2.10", PROJECT="test-isolation",
                               APP="https://192.0.2.10:8443", AUTH="https://192.0.2.10:8444",
                               MAIL="https://192.0.2.10:8445"):
            state = Path(directory)
            deployment.prepare(state)
            config = json.loads((state / "compose.json").read_text())
            services = config["services"]
            self.assertEqual(services["gateway"]["environment"]["OIDC_ISSUER"], deployment.AUTH)
            self.assertEqual(services["gateway"]["image"], "test-isolation-gateway:local")
            self.assertEqual(services["caddy"]["ports"][0], "192.0.2.10:8443:8443")
            for service in ("postgres", "redis", "gateway", "livekit"):
                self.assertNotIn("ports", services[service])
            self.assertEqual((state / "secrets.json").stat().st_mode & 0o077, 0)

    def test_prepare_preserves_keys_and_maintenance(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "compose"):
            state = Path(directory)
            values = deployment.prepare(state)
            config = json.loads((state / "compose.json").read_text())
            config["services"]["gateway"]["environment"]["AUTHORIZATION_MANAGED_MAINTENANCE"] = "true"
            deployment.write(state / "compose.json", config)
            self.assertEqual(deployment.prepare(state), values)
            current = json.loads((state / "compose.json").read_text())
            self.assertEqual(current["services"]["gateway"]["environment"]["AUTHORIZATION_MANAGED_MAINTENANCE"], "true")

    def test_provider_requests_use_selected_origin(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(deployment, "AUTH", "https://192.0.2.20:8444"), \
                patch.object(deployment.ssl, "create_default_context"), \
                patch.object(deployment.urllib.request, "build_opener") as build:
            state = Path(directory)
            deployment.write(state / "secrets.json", {})
            response = build.return_value.open.return_value.__enter__.return_value
            response.headers.get.return_value = "text/plain"
            response.status = 200
            deployment.request(state, "/api/health", admin=False)
            request = build.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://192.0.2.20:8444/api/health")


if __name__ == "__main__":
    unittest.main()
