import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vehicle_edge.device_credentials import FileDeviceCredentialProvider, VehicleTokenManager


class FakeResponse:
    status = 200

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        return False

    async def json(self):
        return {"access_token": "vehicle-access-token", "expires_in": 900}


class FakeSession:
    def __init__(self):
        self.payload = None

    def post(self, url, data, timeout):
        self.url = url
        self.payload = data
        self.timeout = timeout
        return FakeResponse()


class DeviceCredentialProviderTest(unittest.TestCase):
    def test_rejects_non_root_owned_file(self):
        with tempfile.NamedTemporaryFile() as credential_file:
            os.chmod(credential_file.name, 0o600)
            metadata = os.stat_result((stat.S_IFREG | 0o600, 0, 0, 1, 1000, 0, 0, 0, 0, 0))
            with self.assertRaisesRegex(RuntimeError, "owned by root"):
                with patch.object(Path, "stat", return_value=metadata):
                    FileDeviceCredentialProvider(credential_file.name).load()

    def test_loads_root_owned_mode_600_file(self):
        with tempfile.NamedTemporaryFile(mode="w") as credential_file:
            credential_file.write(
                "vehicle_id: car-001\n"
                "client_id: vehicle-car-001\n"
                "client_secret: secret\n"
                "token_url: https://issuer.example.com/oauth/token\n"
                "scope: teleop:vehicle\n"
            )
            credential_file.flush()
            metadata = os.stat_result((stat.S_IFREG | 0o600,) + (0,) * 9)
            with patch.object(Path, "stat", return_value=metadata):
                credentials = FileDeviceCredentialProvider(credential_file.name).load()

        self.assertEqual(credentials.vehicle_id, "car-001")
        self.assertEqual(credentials.scope, "teleop:vehicle")


class VehicleTokenManagerTest(unittest.IsolatedAsyncioTestCase):
    async def test_refresh_uses_client_credentials_and_requested_scope(self):
        with tempfile.NamedTemporaryFile(mode="w") as credential_file:
            credential_file.write(
                "vehicle_id: car-001\n"
                "client_id: vehicle-car-001\n"
                "client_secret: secret\n"
                "token_url: https://issuer.example.com/oauth/token\n"
                "audience: teleop-api\n"
                "scope: teleop:vehicle\n"
            )
            credential_file.flush()
            metadata = os.stat_result((stat.S_IFREG | 0o600,) + (0,) * 9)
            with patch.object(Path, "stat", return_value=metadata):
                credentials = FileDeviceCredentialProvider(credential_file.name).load()

        session = FakeSession()
        manager = VehicleTokenManager(credentials)
        token = await manager.refresh(session)

        self.assertEqual(token, "vehicle-access-token")
        self.assertEqual(manager.access_token, token)
        self.assertEqual(session.url, credentials.token_url)
        self.assertEqual(session.payload["grant_type"], "client_credentials")
        self.assertEqual(session.payload["scope"], "teleop:vehicle")
        self.assertEqual(session.payload["audience"], "teleop-api")