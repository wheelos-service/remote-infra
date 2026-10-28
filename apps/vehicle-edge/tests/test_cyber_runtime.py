import unittest
from types import SimpleNamespace
from unittest.mock import patch

from vehicle_edge.cyber_runtime import load_runtime


class CyberRuntimeTest(unittest.TestCase):
    def test_apollo_selects_local_messages(self):
        cyber = object()
        chassis, control, localization = object(), object(), object()
        modules = {
            "cyber.python.cyber_py3": SimpleNamespace(cyber=cyber),
            "modules.common_msgs.chassis_msgs.chassis_pb2": SimpleNamespace(Chassis=chassis),
            "modules.common_msgs.control_msgs.control_cmd_pb2": SimpleNamespace(ControlCommand=control),
            "modules.common_msgs.localization_msgs.localization_pb2": SimpleNamespace(LocalizationEstimate=localization),
        }
        with patch.dict("os.environ", {"VEHICLE_CYBER_BACKEND": "apollo"}), patch.dict("sys.modules", modules):
            self.assertEqual(load_runtime(), (cyber, chassis, control, localization))

    def test_unknown_backend_fails_before_importing_cyber(self):
        with patch.dict("os.environ", {"VEHICLE_CYBER_BACKEND": "typo"}):
            with self.assertRaisesRegex(RuntimeError, "unsupported VEHICLE_CYBER_BACKEND"):
                load_runtime()

    def test_missing_apollo_messages_does_not_fall_back_to_wheelos(self):
        with patch.dict("os.environ", {"VEHICLE_CYBER_BACKEND": "apollo"}), patch.dict(
            "sys.modules", {
                "cyber.python.cyber_py3": SimpleNamespace(cyber=object()),
                "modules.common_msgs.chassis_msgs.chassis_pb2": None,
            },
        ):
            with self.assertRaises(ImportError):
                load_runtime()
