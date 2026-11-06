import importlib.util
import fcntl
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "infra/scripts/authentication-test.py"
spec = importlib.util.spec_from_file_location("authentication_deployment", SOURCE)
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class AuthenticationDeploymentTest(unittest.TestCase):
    def setUp(self):
        self.original_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.original_umask)
        for name in ("IP", "APP", "AUTH", "MAIL", "PROJECT", "BIND_ADDRESS", "MEDIA_IP"):
            original = getattr(deployment, name)
            self.addCleanup(setattr, deployment, name, original)

    def test_isolated_host_project_and_private_services(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(deployment, "compose"), \
                patch.multiple(deployment, IP="192.0.2.10", PROJECT="test-isolation",
                               APP="https://192.0.2.10:9443", AUTH="https://192.0.2.10:9444",
                               MAIL="https://192.0.2.10:9445"):
            state = Path(directory)
            deployment.prepare(state)
            config = json.loads((state / "compose.json").read_text())
            services = config["services"]
            self.assertEqual(services["gateway"]["environment"]["OIDC_ISSUER"], deployment.AUTH)
            self.assertEqual(services["gateway"]["image"], "test-isolation-gateway:local")
            self.assertEqual(services["caddy"]["ports"], [
                "192.0.2.10:9443:9443", "192.0.2.10:9444:9444", "192.0.2.10:9445:9445"])
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

    def create_environment(self, state, *options):
        with patch.object(deployment, "compose"):
            deployment.main(["--state", str(state), "--host", "192.0.2.20",
                             "--project", "test-isolation", "--base-port", "9443",
                             *options, "prepare"])

    def test_initial_up_creates_private_state_and_verifies_after_start(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "compose"), \
                patch.object(deployment, "build") as build, \
                patch.object(deployment, "start") as start, \
                patch.object(deployment, "verify") as verify:
            state = Path(directory) / "new-environment"
            order = []
            build.side_effect = lambda *_: order.append("build")
            start.side_effect = lambda *_, **__: order.append("start")
            verify.side_effect = lambda *_: order.append("verify")
            deployment.main(["--state", str(state), "--host", "192.0.2.20", "up"])
            self.assertEqual(order, ["build", "start", "verify"])
            self.assertEqual(state.stat().st_mode & 0o777, 0o700)
            self.assertEqual(json.loads((state / "deployment.json").read_text())["host"], "192.0.2.20")

    def test_update_preserves_custom_configuration_keys_and_media(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.create_environment(state, "--media-port", "9781")
            config = json.loads((state / "compose.json").read_text())
            config["services"]["gateway"]["environment"]["AUTHORIZATION_MANAGED_MAINTENANCE"] = "true"
            config["services"]["frontend"]["labels"] = {"custom": "keep"}
            deployment.write(state / "compose.json", config)
            # Existing remote metadata predates bind_address/media_ip options.
            saved = json.loads((state / "deployment.json").read_text())
            saved.pop("bind_address")
            saved.pop("media_ip")
            deployment.write(state / "deployment.json", saved)
            before = {p.name: p.read_bytes() for p in state.iterdir() if p.is_file()}
            order = []
            with patch.object(deployment, "prepare") as prepare, \
                    patch.object(deployment, "start") as start, \
                    patch.object(deployment, "build", side_effect=lambda *_: order.append("build")), \
                    patch.object(deployment, "verify", side_effect=lambda *_: order.append("verify")), \
                    patch.object(deployment, "compose", side_effect=lambda _, *cmd: order.append(cmd)):
                deployment.main(["--state", str(state), "update"])
                prepare.assert_not_called()
                start.assert_not_called()
            self.assertEqual(order, [("config", "--quiet"), "build",
                                     ("up", "-d", "--no-deps", "--force-recreate", "gateway", "frontend"), "verify"])
            self.assertEqual(before, {p.name: p.read_bytes() for p in state.iterdir() if p.is_file()})
            self.assertEqual(config["services"]["livekit"]["ports"],
                             ["192.0.2.20:9781:9781/tcp", "192.0.2.20:9781:9781/udp"])

    def test_failed_build_never_restarts_services(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.create_environment(state)
            with patch.object(deployment, "build", side_effect=RuntimeError("build failed")), \
                    patch.object(deployment, "compose") as compose, \
                    patch.object(deployment, "verify") as verify:
                with self.assertRaisesRegex(RuntimeError, "build failed"):
                    deployment.main(["--state", str(state), "update"])
                compose.assert_called_once_with(state.resolve(), "config", "--quiet")
                verify.assert_not_called()

    def test_verification_failure_propagates(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.create_environment(state)
            with patch.object(deployment, "build"), patch.object(deployment, "compose"), \
                    patch.object(deployment, "verify", side_effect=RuntimeError("not ready")):
                with self.assertRaisesRegex(RuntimeError, "not ready"):
                    deployment.main(["--state", str(state), "update"])

    def test_verify_and_status_do_not_rewrite_saved_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.create_environment(state)
            before = {p.name: p.read_bytes() for p in state.iterdir() if p.is_file()}
            with patch.object(deployment, "prepare") as prepare, \
                    patch.object(deployment, "verify") as verify, patch.object(deployment, "compose") as compose:
                deployment.main(["--state", str(state), "verify"])
                deployment.main(["--state", str(state), "status"])
                verify.assert_called_once()
                compose.assert_called_once_with(state.resolve(), "ps")
                prepare.assert_not_called()
            self.assertEqual(before, {p.name: p.read_bytes() for p in state.iterdir() if p.is_file()})

    def test_rejects_identity_and_network_changes_before_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.create_environment(state)
            before = {p.name: p.read_bytes() for p in state.iterdir() if p.is_file()}
            for option in (("--host", "192.0.2.21"), ("--project", "another"),
                           ("--base-port", "8443"), ("--media-port", "9781")):
                with self.subTest(option=option), patch.object(deployment, "execute") as execute:
                    with self.assertRaises(SystemExit):
                        deployment.main(["--state", str(state), *option, "update"])
                    execute.assert_not_called()
            self.assertEqual(before, {p.name: p.read_bytes() for p in state.iterdir() if p.is_file()})

    def test_invalid_initial_options_leave_no_state(self):
        with tempfile.TemporaryDirectory() as directory:
            for index, options in enumerate(([], ["--host", "https://bad.invalid"],
                    ["--host", "192.0.2.20", "--media-port", "8444"],
                    ["--host", "fleet.example.test", "--media-port", "9781"])):
                state = Path(directory) / str(index)
                with self.subTest(options=options), self.assertRaises(SystemExit):
                    deployment.main(["--state", str(state), *options, "up"])
                self.assertFalse(state.exists())

    def test_dns_host_separates_bind_address_and_advertised_media_ip(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "compose"):
            state = Path(directory)
            deployment.main(["--state", str(state), "--host", "fleet.example.test",
                             "--bind-address", "192.0.2.20", "--media-ip", "198.51.100.20",
                             "--media-port", "9781", "prepare"])
            config = json.loads((state / "compose.json").read_text())
            self.assertEqual(config["services"]["gateway"]["environment"]["OIDC_ISSUER"],
                             "https://fleet.example.test:8444")
            self.assertIn("192.0.2.20:8443:8443", config["services"]["caddy"]["ports"])
            self.assertIn("node_ip: 198.51.100.20", (state / "livekit.yaml").read_text())

    def test_concurrent_deployment_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.create_environment(state)
            with (state / ".deploy.lock").open("w") as lock, patch.object(deployment, "execute") as execute:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(SystemExit):
                    deployment.main(["--state", str(state), "update"])
                execute.assert_not_called()

    def test_missing_saved_secrets_cannot_generate_new_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.create_environment(state)
            (state / "secrets.json").unlink()
            with patch.object(deployment, "execute") as execute, self.assertRaises(SystemExit):
                deployment.main(["--state", str(state), "prepare"])
            execute.assert_not_called()
            self.assertFalse((state / "secrets.json").exists())

    def test_explicit_prepare_preserves_media_and_maintenance(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "compose"):
            state = Path(directory)
            self.create_environment(state, "--media-port", "9781")
            config = json.loads((state / "compose.json").read_text())
            config["services"]["gateway"]["environment"]["AUTHORIZATION_MANAGED_MAINTENANCE"] = "true"
            deployment.write(state / "compose.json", config)
            deployment.main(["--state", str(state), "prepare"])
            current = json.loads((state / "compose.json").read_text())
            self.assertEqual(current["services"]["livekit"]["ports"], config["services"]["livekit"]["ports"])
            self.assertEqual(current["services"]["gateway"]["environment"]["AUTHORIZATION_MANAGED_MAINTENANCE"], "true")

    def test_explicit_start_reloads_mounted_network_config_without_recreating_databases(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployment, "compose") as compose, \
                patch.object(deployment, "request", return_value={}):
            state = Path(directory)
            ca = state / "caddy-data/caddy/pki/authorities/local/root.crt"
            ca.parent.mkdir(parents=True)
            ca.write_text("test CA")
            (state / "configured").touch()
            (state / "bootstrapped").touch()
            deployment.start(state, {}, reload_network=True)
            recreated = [call.args[1:] for call in compose.call_args_list if "--force-recreate" in call.args]
            self.assertEqual(recreated, [
                ("up", "-d", "--no-deps", "--force-recreate", "livekit", "caddy"),
                ("up", "-d", "--force-recreate", "gateway", "frontend"),
            ])

    def test_frontend_verification_checks_served_build_and_public_config(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(deployment.ssl, "create_default_context"), \
                patch.object(deployment.urllib.request, "build_opener") as build:
            state = Path(directory)
            dist = state / "frontend-image/dist"
            dist.mkdir(parents=True)
            for name in ("index.html", "main.js", "main.css"):
                (dist / name).write_text(name)
            (state / "runtime-config.js").write_text("public endpoints")
            response = build.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.side_effect = [b"index.html", b"main.js", b"main.css", b"public endpoints"]
            deployment.verify_frontend(state)
            self.assertEqual(build.return_value.open.call_count, 4)
            response.read.side_effect = [b"old index"]
            with self.assertRaisesRegex(RuntimeError, "served frontend does not match"):
                deployment.verify_frontend(state)


if __name__ == "__main__":
    unittest.main()
