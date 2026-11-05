import datetime
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
    def test_package_validation_and_identity_boundary(self):
        value = {"schema_version": 1, "gateway_url": "https://api.example",
                 "vehicle_id": "car-one", "operation_id": "11111111-1111-4111-8111-111111111111",
                 "expires_at": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)).isoformat(),
                 "installation_ticket": "fixture-ticket"}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "package.json"
            installer.protected_write(path, value)
            self.assertEqual(installer.package_ticket(path, "https://api.example", "car-one"), "fixture-ticket")
            for fraction in ("1", "123", "123456", "123456789"):
                path.write_text(json.dumps({**value, "expires_at": "2099-01-01T00:00:00." + fraction + "Z"}))
                self.assertEqual(installer.package_ticket(path, "https://api.example", "car-one"), "fixture-ticket")
            for replacement in ({"schema_version": True}, {"schema_version": 2}, {"vehicle_id": "other"},
                                {"gateway_url": "https://other.example"}, {"operation_id": "bad"},
                                {"expires_at": "2000-01-01T00:00:00Z"}, {"expires_at": "2030-01-01"},
                                {"installation_ticket": "bad token"}, {"client_secret": "never-allowed"}):
                path.write_text(json.dumps({**value, **replacement}))
                with self.subTest(replacement=replacement), self.assertRaises(installer.InstallationError):
                    installer.package_ticket(path, "https://api.example", "car-one")
            for raw in ('{"schema_version":1,"schema_version":1}', '[]', '{', ' ' * 65537):
                path.write_text(raw)
                with self.assertRaises(installer.InstallationError):
                    installer.package_ticket(path, "https://api.example", "car-one")

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
