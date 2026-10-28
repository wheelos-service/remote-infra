"""Select a build's Cyber messages explicitly; never fall back between runtimes."""

import os


def load_runtime():
    backend = os.environ.get("VEHICLE_CYBER_BACKEND", "wheelos")
    if backend not in ("apollo", "wheelos"):
        raise RuntimeError(f"unsupported VEHICLE_CYBER_BACKEND: {backend}")

    from cyber.python.cyber_py3 import cyber

    if backend == "apollo":
        from modules.common_msgs.chassis_msgs.chassis_pb2 import Chassis
        from modules.common_msgs.control_msgs.control_cmd_pb2 import ControlCommand
        from modules.common_msgs.localization_msgs.localization_pb2 import LocalizationEstimate
    else:
        from wheelos_msgs.chassis_msgs.chassis_pb2 import Chassis
        from wheelos_msgs.control_msgs.control_cmd_pb2 import ControlCommand
        from wheelos_msgs.localization_msgs.localization_pb2 import LocalizationEstimate
    return cyber, Chassis, ControlCommand, LocalizationEstimate
