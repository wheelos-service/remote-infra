import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("vehicle_setup", ROOT / "infra/scripts/setup-vehicle-bootstrap.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
PUBLIC = {"gateway_url": "https://api.example", "console_url": "https://console.example",
          "name": "Vehicle one", "serial": "SN-001", "platform": "apollo"}


class VehicleBootstrapSetupTest(unittest.TestCase):
    def test_cli_passes_only_protected_path_to_existing_sdk(self):
        info = SimpleNamespace(st_mode=0o100755, st_uid=0)
        config = Path("/etc/teleop/bootstrap.json")
        with patch.object(setup.os, "geteuid", return_value=0), patch.object(setup.os, "umask"), \
                patch.object(setup.Path, "lstat", return_value=info), patch.object(setup.os, "access", return_value=True), \
                patch.object(setup, "public_input", return_value=PUBLIC), \
                patch.object(setup, "prepare", return_value=config) as prepare, patch.object(setup.os, "execv") as execute:
            setup.main([])
            prepare.assert_called_once_with(PUBLIC)
            execute.assert_called_once_with("/usr/local/libexec/vehicle_bootstrap",
                                           ["/usr/local/libexec/vehicle_bootstrap", "--config", str(config)])
            execute.reset_mock()
            setup.main(["--prepare-only"])
            execute.assert_not_called()
        with patch.object(setup.os, "geteuid", return_value=1000), self.assertRaises(setup.SetupError):
            setup.main([])

    def test_public_input_rejects_secrets_unsafe_urls_duplicate_fields_and_controls(self):
        self.assertEqual(setup.validate(PUBLIC), PUBLIC)
        self.assertEqual(setup.validate({**PUBLIC, "serial": ""})["serial"], "")
        for change in ({"client_secret": "fixture"}, {"platform": "bad\nfield"},
                       {"gateway_url": "http://remote.example"}, {"gateway_url": "https://u:p@api.example"},
                       {"console_url": "https://example/#secret"}, {"console_url": "https://example/?x=y"},
                       {"console_url": "https://example:99999"}, {"name": "车" * 70}):
            with self.subTest(change=change), self.assertRaises(setup.SetupError):
                setup.validate({**PUBLIC, **change})
        for raw in ('{"name":"a","name":"b"}\n', 'x' * 8193, '[]\n', ''):
            with patch("sys.stdin", io.StringIO(raw)), self.assertRaises(setup.SetupError):
                setup.validate(setup.public_input())

    def test_paste_and_typed_input_have_identical_contract(self):
        with patch("sys.stdin", io.StringIO(json.dumps(PUBLIC) + "\n")):
            self.assertEqual(setup.public_input(), PUBLIC)
        with patch("sys.stdin", io.StringIO("\n")), patch("builtins.input", side_effect=[PUBLIC[k] for k in ("gateway_url", "console_url", "name", "serial", "platform")]):
            self.assertEqual(setup.public_input(), PUBLIC)

    def test_dashboard_bootstrap_multiline_json_uses_fixed_paths_and_empty_serial(self):
        public = {**PUBLIC, "serial": ""}
        config = {**public, **setup.BOOTSTRAP_DEFAULTS}
        with patch("sys.stdin", io.StringIO(json.dumps(config, indent=2) + "\n")):
            self.assertEqual(setup.validate(setup.public_input()), public)
        for change in ({"state_directory": "/tmp/untrusted"}, {"allow_legacy_complete_404": True},
                       {"allow_insecure_localhost": True}, {"allow_insecure_localhost": 0}):
            with self.subTest(change=change), self.assertRaises(setup.SetupError):
                setup.validate({**config, **change})

    def test_setup_is_repeatable_and_preserves_credentials_and_runtime_settings(self):
        # Use a non-world-writable ancestor like the real protected paths. /tmp
        # and macOS temporary-directory parents correctly fail the safety check.
        cache = ROOT / ".cache"
        cache.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache) as temp:
            base = Path(temp).resolve()
            config, state = base / "etc", base / "state"
            path = setup.prepare(PUBLIC, config, state)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            template = config / "device.template.json"
            self.assertEqual(json.loads(template.read_text())["control_mode"], "disabled")
            setup.create(config / "device.json", {"vehicle_id": "existing-id", "client_secret": "fixture-only"})
            template.write_text(json.dumps({"control_mode": "disabled", "media_enabled": True}))
            before = {p: p.read_bytes() for p in config.iterdir()}
            setup.prepare(PUBLIC, config, state)
            self.assertEqual(before, {p: p.read_bytes() for p in config.iterdir()})
            with self.assertRaises(setup.SetupError):
                setup.prepare({**PUBLIC, "gateway_url": "https://other.example"}, config, state)
            self.assertEqual(before, {p: p.read_bytes() for p in config.iterdir()})
            (base / "symlink").symlink_to(config, target_is_directory=True)
            with self.assertRaises(setup.SetupError):
                setup.prepare(PUBLIC, base / "symlink", state)
            path.chmod(0o644)
            with self.assertRaises(setup.SetupError):
                setup.prepare(PUBLIC, config, state)
            path.chmod(0o600)
            os.link(path, config / "alias.json")
            with self.assertRaises(setup.SetupError):
                setup.prepare(PUBLIC, config, state)
