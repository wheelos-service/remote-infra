import asyncio
import base64
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from nacl.signing import SigningKey

from vehicle_edge.control_protocol import build_sign_message
from vehicle_edge.control_session_receiver import (
    ActiveControlSession,
    SessionCommandVerifier,
    SessionVehicleRuntime,
)
from vehicle_edge.cyber_bridge import CyberBridge, CyberOptions


class FakeControlCommand:
    def __init__(self):
        self.header = SimpleNamespace()


class CyberBridgeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.writer = Mock()
        self.writer.write.return_value = True
        self.node = Mock()
        self.node.create_writer.return_value = self.writer
        self.cyber = Mock()
        self.cyber.init.return_value = True
        self.cyber.Node.return_value = self.node
        self.chassis_type = SimpleNamespace(GEAR_DRIVE=1, GEAR_REVERSE=2, GEAR_INVALID=5, GEAR_NONE=6)
        modules = {
            "cyber.python.cyber_py3": SimpleNamespace(cyber=self.cyber),
            "wheelos_msgs.chassis_msgs.chassis_pb2": SimpleNamespace(Chassis=self.chassis_type),
            "wheelos_msgs.control_msgs.control_cmd_pb2": SimpleNamespace(ControlCommand=FakeControlCommand),
            "wheelos_msgs.localization_msgs.localization_pb2": SimpleNamespace(LocalizationEstimate=object),
        }
        self.module_patch = patch.dict("sys.modules", modules)
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)

    def start_bridge(self, control=False):
        bridge = CyberBridge(CyberOptions(enabled=True, control_enabled=control))
        bridge.start()
        self.addCleanup(bridge.close)
        return bridge

    async def test_monitoring_does_not_create_writer_or_brake(self):
        bridge = self.start_bridge()
        self.assertEqual(
            [call.args[0] for call in self.node.create_reader.call_args_list],
            ["/apollo/localization/pose", "/apollo/canbus/chassis"],
        )
        await bridge.apply_control("remote", {"throttle": 1})
        await bridge.emergency_brake("idle watchdog")
        self.node.create_writer.assert_not_called()
        self.writer.write.assert_not_called()

    async def test_control_scaling_sign_gear_and_brake_priority(self):
        bridge = self.start_bridge(control=True)
        for direction, gear in ((1, 1), (-1, 2)):
            await bridge.apply_control("remote", {
                "steering": -0.25, "throttle": 0.4, "brake": 0, "direction": direction,
            })
            message = self.writer.write.call_args.args[0]
            self.assertEqual(message.steering_target, 25)
            self.assertEqual(message.throttle, 40)
            self.assertEqual(message.brake, 0)
            self.assertEqual(message.gear_location, gear)
            self.assertEqual(message.header.module_name, "teleop_vehicle")
            self.assertGreater(message.header.timestamp_sec, 0)
        await bridge.apply_control("remote", {
            "steering": 0, "throttle": 1, "brake": 0.5, "direction": 0,
        })
        message = self.writer.write.call_args.args[0]
        self.assertEqual(message.throttle, 0)
        self.assertEqual(message.brake, 50)
        self.assertEqual(message.gear_location, 2)
        self.assertEqual(message.header.sequence_num, 3)

    async def test_invalid_actuator_values_never_publish(self):
        bridge = self.start_bridge(control=True)
        for field, value in (
            ("steering", float("nan")), ("throttle", float("inf")),
            ("brake", -0.1), ("direction", 0.5), ("throttle", 1.1),
            ("steering", "0.1"), ("direction", True),
        ):
            with self.subTest(field=field, value=value):
                command = {"steering": 0, "throttle": 0, "brake": 0, "direction": 1}
                command[field] = value
                with self.assertRaises(ValueError):
                    await bridge.apply_control("remote", command)
        self.writer.write.assert_not_called()

    async def test_watchdog_only_brakes_after_remote_command_and_repeats(self):
        bridge = self.start_bridge(control=True)
        await bridge.emergency_brake("not armed")
        self.writer.write.assert_not_called()
        await bridge.apply_control("remote", {
            "steering": 0.5, "throttle": 0.2, "brake": 0, "direction": -1,
        })
        for _ in range(2):
            await bridge.emergency_brake("timeout")
            message = self.writer.write.call_args.args[0]
            self.assertEqual((message.throttle, message.brake), (0, 100))
            self.assertEqual(message.gear_location, 2)
        self.assertTrue(bridge.in_emergency)
        await bridge.apply_control("remote", {
            "steering": 0, "throttle": 0, "brake": 1, "direction": 0,
        })
        self.assertFalse(bridge.in_emergency)

    async def test_failed_publication_can_be_retried_and_shutdown_stops(self):
        bridge = self.start_bridge(control=True)
        self.writer.write.return_value = False
        with self.assertRaises(RuntimeError):
            await bridge.apply_control("remote", {
                "steering": 0, "throttle": 0.2, "brake": 0, "direction": 1,
            })
        self.writer.write.return_value = True
        await bridge.emergency_brake("write failed")
        bridge.close()
        self.assertEqual(self.writer.write.call_args.args[0].brake, 100)
        self.cyber.shutdown.assert_called_once()

    async def test_initial_stop_requires_known_gear_and_preserves_chassis_gear(self):
        bridge = self.start_bridge(control=True)
        stop = {"steering": 0, "throttle": 0, "brake": 1, "direction": 0}
        with self.assertRaises(RuntimeError):
            await bridge.apply_control("remote", stop)
        self.writer.write.assert_not_called()
        bridge._receive("chassis", SimpleNamespace(gear_location=2, HasField=lambda name: True))
        await bridge.apply_control("remote", stop)
        self.assertEqual(self.writer.write.call_args.args[0].gear_location, 2)
        self.assertEqual(self.writer.write.call_args.args[0].brake, 100)

    async def test_snapshot_retains_pose_chassis_and_staleness(self):
        bridge = self.start_bridge()
        self.assertEqual(bridge.snapshot(), {})
        pose = object()
        chassis = SimpleNamespace(speed_mps=2.5, HasField=lambda name: False)
        callbacks = [call.args[2] for call in self.node.create_reader.call_args_list]
        with patch("vehicle_edge.cyber_bridge.time.monotonic", return_value=100):
            callbacks[0](pose)
            callbacks[1](chassis)
            fresh = bridge.snapshot()
        self.assertIs(fresh["localization"].message, pose)
        self.assertIs(fresh["chassis"].message, chassis)
        self.assertEqual(fresh["chassis"].age_ms, 0)
        with patch("vehicle_edge.cyber_bridge.time.monotonic", return_value=102):
            self.assertEqual(bridge.snapshot()["chassis"].age_ms, 2000)

    async def test_partial_start_failure_releases_cyber(self):
        self.node.create_reader.side_effect = [Mock(), None]
        bridge = CyberBridge(CyberOptions(enabled=True))
        with self.assertRaises(RuntimeError):
            bridge.start()
        self.cyber.shutdown.assert_called_once()

    async def test_signature_boundary_and_watchdog_reach_cyber(self):
        bridge = self.start_bridge(control=True)
        key = SigningKey.generate()
        verifier = SessionCommandVerifier("http://gateway", "car-1", "")
        verifier.session = ActiveControlSession(
            "session-1", "car-1", "driver-1",
            base64.b64encode(bytes(key.verify_key)).decode(), "ACTIVE",
            int(time.time() * 1000) + 5000,
        )
        verifier.verify_key = key.verify_key
        runtime = SessionVehicleRuntime(verifier, bridge)
        packet = {
            "version": 1, "type": "control", "session_id": "session-1",
            "sequence": 1, "timestamp_ms": int(time.time() * 1000),
            "command": {"steering": -0.2, "throttle": 0.1, "brake": 0},
        }
        packet["signature"] = base64.b64encode(
            key.sign(build_sign_message(packet).encode()).signature).decode()
        await runtime.on_datachannel_message(json.dumps(packet), "operator-other")
        self.writer.write.assert_not_called()
        await runtime.on_datachannel_message(json.dumps(packet), "operator-driver-1")
        self.assertEqual(self.writer.write.call_args.args[0].steering_target, 20)
        await runtime.on_datachannel_message(json.dumps(packet), "operator-driver-1")
        self.assertEqual(self.writer.write.call_count, 1)
        verifier.last_valid_cmd_time = time.monotonic() - 1
        task = asyncio.create_task(runtime.safety_watchdog(check_interval_ms=1))
        await asyncio.sleep(0.01)
        runtime.running = False
        await task
        self.assertTrue(bridge.in_emergency)
        self.assertEqual(self.writer.write.call_args.args[0].brake, 100)

    async def test_actuator_failure_does_not_kill_runtime_or_watchdog(self):
        bridge = self.start_bridge(control=True)
        verifier = Mock()
        verifier.verify_packet.return_value = {
            "sequence": 1, "timestamp_ms": int(time.time() * 1000), "session_id": "session-1",
            "command": {"steering": 0, "throttle": 0, "brake": 1, "mode": "low_level", "direction": 1},
        }
        verifier.last_valid_cmd_time = time.monotonic() - 1
        runtime = SessionVehicleRuntime(verifier, bridge)
        self.writer.write.return_value = False
        await runtime.on_datachannel_message("packet", "operator")
        task = asyncio.create_task(runtime.safety_watchdog(check_interval_ms=1))
        await asyncio.sleep(0.01)
        self.assertFalse(task.done())
        self.writer.write.return_value = True
        runtime.running = False
        await task


if __name__ == "__main__":
    unittest.main()
