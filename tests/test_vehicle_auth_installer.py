import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch


MODULE = pathlib.Path(__file__).resolve().parents[1] / "infra/scripts/install-vehicle-auth.py"
spec = importlib.util.spec_from_file_location("vehicle_auth_installer", MODULE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class VehicleAuthInstallerTest(unittest.TestCase):
    def test_retired_entrypoint_never_reads_writes_prompts_or_requests(self):
        with patch.object(installer, "protected_read") as read, \
                patch.object(installer, "protected_write") as write, \
                patch.object(installer, "request") as request, \
                patch.object(installer, "verify") as verify:
            with self.assertRaisesRegex(installer.InstallationError, "vehicle_bootstrap"):
                installer.main()
            for operation in (read, write, request, verify):
                operation.assert_not_called()

    def test_endpoints_refuse_credentials_redirects_and_insecure_remote(self):
        for value in ("http://remote.example", "https://u:p@remote.example",
                      "https://remote.example/?token=secret", "https://remote.example/#secret"):
            with self.assertRaises(installer.InstallationError):
                installer.endpoint(value, True)
        self.assertEqual(installer.endpoint("http://127.0.0.1:1234", True), "http://127.0.0.1:1234")
        with self.assertRaises(installer.InstallationError):
            installer.endpoint("http://127.0.0.1:1234")
        with self.assertRaises(installer.InstallationError):
            installer.NoRedirect().redirect_request(None, None, 302, "", None, "https://other.example")

    def test_configuration_is_protected_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "device.json"
            installer.protected_write(target, {"client_secret": "fixture-only"})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(installer.protected_read(target))["client_secret"], "fixture-only")
            with self.assertRaises(installer.InstallationError):
                installer.protected_write(target, {"client_secret": "replacement"})
            link = pathlib.Path(directory) / "link"
            link.symlink_to(target)
            with self.assertRaises(installer.InstallationError):
                installer.protected_read(link)
            target.chmod(0o644)
            with self.assertRaises(installer.InstallationError):
                installer.protected_read(target)

    def test_foreign_vehicle_or_gateway_cannot_be_installed(self):
        value = {"vehicle_id": "car-one", "gateway_url": "https://api.example",
                 "token_url": "https://idp.example/token", "client_id": "client", "client_secret": "secret"}
        config = installer.validate_config(value, "car-one", "https://api.example", False)
        self.assertFalse(config["media_enabled"])
        self.assertEqual(config["control_mode"], "disabled")
        for vehicle, gateway in (("car-other", "https://api.example"), ("car-one", "https://other.example")):
            with self.assertRaises(installer.InstallationError):
                installer.validate_config(value, vehicle, gateway, False)

    def test_installation_completion_follows_successful_bound_identity_check(self):
        config = {"gateway_url": "https://api.example", "token_url": "https://idp.example/token",
                  "vehicle_id": "car-one", "client_id": "client", "client_secret": "secret"}
        with patch.object(installer, "request", side_effect=[
            {"access_token": "fixture"}, {"Name": "car-other", "Roles": ["vehicle"]},
        ]) as request:
            with self.assertRaises(installer.InstallationError):
                installer.verify(config)
            self.assertEqual(request.call_count, 2)
        with patch.object(installer, "request", side_effect=[
            {"access_token": "fixture"}, {"Name": "car-one", "Roles": ["vehicle"]}, {}, {},
        ]) as request:
            installer.verify(config)
            self.assertTrue(request.call_args.args[0].endswith("/car-one/installation-complete"))
            self.assertEqual(request.call_args.kwargs["expected"], 204)


if __name__ == "__main__":
    unittest.main()
