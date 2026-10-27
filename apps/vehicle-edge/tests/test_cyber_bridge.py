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
        self.chassis_type = SimpleNamespace(GEAR_DRIVE=1, GEAR_REVERSE=2, GEAR_INVALID=5, GEAR_NONE=6,
                                            GEAR_NEUTRAL=0, GEAR_PARKING=3, GEAR_LOW=4, COMPLETE_AUTO_DRIVE=1)
        modules = {
            "cyber.python.cyber_py3": SimpleNamespace(cyber=self.cyber),
            "wheelos_msgs.chassis_msgs.chassis_pb2": SimpleNamespace(Chassis=self.chassis_type),
            "wheelos_msgs.control_msgs.control_cmd_pb2": SimpleNamespace(ControlCommand=FakeControlCommand),
            "wheelos_msgs.localization_msgs.localization_pb2": SimpleNamespace(LocalizationEstimate=object),
        }
        self.module_patch = patch.dict("sys.modules", modules)
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)

    def chassis(self, bridge, gear=1, speed=0.0, mode=1, **fields):
        values = dict(gear_location=gear, speed_mps=speed, driving_mode=mode, **fields)
        bridge._receive("chassis", SimpleNamespace(**values, HasField=lambda name: name in values))

    def start_bridge(self, control=False, **options):
        defaults = dict(max_forward_throttle_pct=100, max_reverse_throttle_pct=100,
                        max_steering_pct=100, max_speed_mps=5,
                        throttle_rise_pct_s=1e9, steering_rate_pct_s=1e9)
        defaults.update(options)
        bridge = CyberBridge(CyberOptions(enabled=True, control_enabled=control, **defaults))
        bridge.start()
        self.chassis(bridge)
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
            self.chassis(bridge, gear=gear)
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
        self.chassis(bridge, gear=2)
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
        bridge._samples.clear()
        bridge._reported_gear = None
        with self.assertRaises(RuntimeError):
            await bridge.apply_control("remote", stop)
        self.writer.write.assert_not_called()
        self.chassis(bridge, gear=2)
        await bridge.apply_control("remote", stop)
        self.assertEqual(self.writer.write.call_args.args[0].gear_location, 2)
        self.assertEqual(self.writer.write.call_args.args[0].brake, 100)

    async def test_snapshot_retains_pose_chassis_and_staleness(self):
        bridge = self.start_bridge()
        bridge._samples.clear()
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

    async def test_limits_apply_to_low_level_and_default_motion_is_zero(self):
        bridge = self.start_bridge(control=True, max_forward_throttle_pct=12,
                                   max_reverse_throttle_pct=7, max_steering_pct=15)
        for gear, direction, expected in ((1, 1, 12), (2, -1, 7)):
            self.chassis(bridge, gear=gear)
            await bridge.apply_control("remote", {
                "steering": -1, "throttle": 1, "brake": 0, "direction": direction})
            message = self.writer.write.call_args.args[0]
            self.assertEqual((message.throttle, message.steering_target), (expected, 15))
        bridge.options = CyberOptions(enabled=True, control_enabled=True, max_speed_mps=1)
        await bridge.apply_control("remote", {
            "steering": 1, "throttle": 1, "brake": 0, "direction": -1})
        message = self.writer.write.call_args.args[0]
        self.assertEqual((message.throttle, message.steering_target), (0, 0))

    async def test_bad_feedback_and_speed_prevent_motion(self):
        bridge = self.start_bridge(control=True)
        command = {"steering": 0, "throttle": 1, "brake": 0, "direction": 1}
        for changes in ({"speed": float("nan")}, {"speed": 5}, {"mode": 0},
                        {"parking_brake": True}, {"error_code": 1}, {"chassis_error_mask": 1},
                        {"gear": 5}):
            self.chassis(bridge, **changes)
            with self.assertRaises(RuntimeError):
                await bridge.apply_control("remote", command)
        self.chassis(bridge)
        with self.stale_chassis(bridge):
            with self.assertRaises(RuntimeError):
                await bridge.apply_control("remote", command)
        bridge._receive("chassis", SimpleNamespace(HasField=lambda name: False))
        with self.assertRaises(RuntimeError):
            await bridge.apply_control("remote", command)
        self.writer.write.assert_not_called()

    def stale_chassis(self, bridge):
        return patch("vehicle_edge.cyber_bridge.time.monotonic",
                     return_value=bridge._samples["chassis"][1] + 1)

    async def test_shift_requires_stop_and_new_feedback_before_throttle(self):
        bridge = self.start_bridge(control=True)
        command = {"steering": 0, "throttle": 1, "brake": 0, "direction": -1}
        self.chassis(bridge, speed=1)
        with self.assertRaisesRegex(RuntimeError, "requires vehicle stopped"):
            await bridge.apply_control("remote", command)
        self.writer.write.assert_not_called()
        self.chassis(bridge)
        await bridge.apply_control("remote", {"steering": 0, "throttle": 0, "brake": 1,
                                             "direction": 0, "brake_mode": "stop"})
        await bridge.apply_control("remote", command)
        message = self.writer.write.call_args.args[0]
        self.assertEqual((message.gear_location, message.throttle, message.brake), (2, 0, 100))
        await bridge.apply_control("remote", command)
        self.assertEqual(self.writer.write.call_args.args[0].throttle, 0)
        self.chassis(bridge, gear=2)
        await bridge.apply_control("remote", command)
        self.assertEqual(self.writer.write.call_args.args[0].throttle, 100)

    async def test_shift_deadline_and_target_change_rejected(self):
        bridge = self.start_bridge(control=True)
        command = {"steering": 0, "throttle": 1, "brake": 0, "direction": -1}
        await bridge.apply_control("remote", command)
        with self.assertRaisesRegex(RuntimeError, "already pending"):
            await bridge.apply_control("remote", dict(command, direction=1))
        self.chassis(bridge)
        await bridge.apply_control("remote", {"steering": 0, "throttle": 0, "brake": 1,
                                             "direction": 0, "brake_mode": "stop"})
        await bridge.apply_control("remote", command)
        bridge._shift_started -= 3
        with self.assertRaisesRegex(RuntimeError, "confirmation timed out"):
            await bridge.apply_control("remote", command)
        await bridge.emergency_brake("shift failed")
        with self.assertRaisesRegex(RuntimeError, "send stop before retry"):
            await bridge.apply_control("remote", command)

    async def test_normal_stop_emergency_and_steering_gear_are_separate(self):
        from vehicle_edge.control_protocol import resolve_command
        bridge = self.start_bridge(control=True, stop_brake_pct=20, emergency_brake_pct=90)
        self.chassis(bridge, gear=2)
        await bridge.apply_control("remote", resolve_command({"mode": "high_level", "action": "left"}))
        self.assertEqual(self.writer.write.call_args.args[0].gear_location, 2)
        for action, expected in (("stop", 20), ("emergency_stop", 90)):
            await bridge.apply_control("remote", resolve_command({"mode": "high_level", "action": action}))
            message = self.writer.write.call_args.args[0]
            self.assertEqual((message.throttle, message.brake, message.gear_location), (0, expected, 2))
            self.assertEqual(bridge.in_emergency, action == "emergency_stop")
        await bridge.emergency_brake("timeout")
        self.assertEqual(self.writer.write.call_args.args[0].brake, 90)

    async def test_normal_stop_hold_does_not_turn_into_timeout_emergency(self):
        bridge = self.start_bridge(control=True, stop_brake_pct=20)
        verifier = Mock()
        verifier.session.session_id = "session-1"
        verifier.session_valid.return_value = True
        verifier.last_valid_cmd_time = time.monotonic() - 1
        runtime = SessionVehicleRuntime(verifier, bridge)
        runtime._command_session_id = "session-1"
        runtime._normal_stop = True
        task = asyncio.create_task(runtime.safety_watchdog(check_interval_ms=1))
        await asyncio.sleep(0.01)
        runtime.running = False
        await task
        self.assertEqual(self.writer.write.call_args.args[0].brake, 20)
        self.assertFalse(bridge.in_emergency)
        bridge._samples.clear()
        runtime.running = True
        task = asyncio.create_task(runtime.safety_watchdog(check_interval_ms=1))
        await asyncio.sleep(0.01)
        runtime.running = False
        await task
        self.assertTrue(bridge.in_emergency)
        self.assertEqual(self.writer.write.call_args.args[0].brake, 100)

    async def test_signed_normal_stop_and_emergency_reach_distinct_brakes(self):
        bridge = self.start_bridge(control=True, stop_brake_pct=20, emergency_brake_pct=90)
        key = SigningKey.generate()
        verifier = SessionCommandVerifier("http://gateway", "car-1", "")
        verifier.session = ActiveControlSession(
            "session-1", "car-1", "driver-1",
            base64.b64encode(bytes(key.verify_key)).decode(), "ACTIVE",
            int(time.time() * 1000) + 5000)
        verifier.verify_key = key.verify_key
        runtime = SessionVehicleRuntime(verifier, bridge)
        for sequence, action, brake in ((1, "stop", 20), (2, "emergency_stop", 90)):
            packet = dict(version=1, type="control", session_id="session-1",
                          sequence=sequence, timestamp_ms=int(time.time() * 1000),
                          command={"mode": "high_level", "action": action})
            packet["signature"] = base64.b64encode(
                key.sign(build_sign_message(packet).encode()).signature).decode()
            await runtime.on_datachannel_message(json.dumps(packet), "operator-driver-1")
            self.assertEqual(self.writer.write.call_args.args[0].brake, brake)
            self.assertEqual(runtime._normal_stop, action == "stop")
            if action == "stop":
                self.assertFalse(any(e["event"] == "emergency_stop" for e in runtime._audit_events))
        self.assertTrue(bridge.in_emergency)

    async def test_partial_travel_scales_to_each_direction_limit(self):
        bridge = self.start_bridge(control=True, max_forward_throttle_pct=20,
                                   max_reverse_throttle_pct=10, max_steering_pct=40)
        for gear, direction, expected in ((1, 1, 10), (2, -1, 5)):
            self.chassis(bridge, gear=gear)
            await bridge.apply_control("remote", {
                "steering": -.5, "throttle": .5, "brake": 0, "direction": direction})
            message = self.writer.write.call_args.args[0]
            self.assertAlmostEqual(message.throttle, expected)
            self.assertAlmostEqual(message.steering_target, 20)

    async def test_slew_limits_brake_priority_and_idle_do_not_allow_jumps(self):
        bridge = self.start_bridge(control=True, max_forward_throttle_pct=20,
                                   max_steering_pct=40, throttle_rise_pct_s=20,
                                   steering_rate_pct_s=80, stop_brake_pct=30)
        command = dict(steering=-1, throttle=1, brake=0, direction=1)
        with patch("vehicle_edge.cyber_bridge.time.monotonic", return_value=100):
            self.chassis(bridge)
            await bridge.apply_control("remote", command)
        message = self.writer.write.call_args.args[0]
        self.assertAlmostEqual(message.throttle, 2)
        self.assertAlmostEqual(message.steering_target, 8)
        with patch("vehicle_edge.cyber_bridge.time.monotonic", return_value=100.1):
            await bridge.apply_control("remote", command)
        message = self.writer.write.call_args.args[0]
        self.assertAlmostEqual(message.throttle, 4)
        self.assertAlmostEqual(message.steering_target, 16)
        with patch("vehicle_edge.cyber_bridge.time.monotonic", return_value=100.2):
            await bridge.apply_control("remote", dict(command, throttle=.05))
            self.assertAlmostEqual(self.writer.write.call_args.args[0].throttle, 1)
            await bridge.emergency_brake("test")
        message = self.writer.write.call_args.args[0]
        self.assertEqual((message.throttle, message.steering_target, message.brake), (0, 0, 100))
        with patch("vehicle_edge.cyber_bridge.time.monotonic", return_value=110):
            self.chassis(bridge)
            await bridge.apply_control("remote", command)
        self.assertAlmostEqual(self.writer.write.call_args.args[0].throttle, 4)
        self.assertAlmostEqual(self.writer.write.call_args.args[0].steering_target, 16)

    async def test_tx_logs_only_successful_publication_and_limits_motion_log_rate(self):
        bridge = self.start_bridge(control=True)
        command = dict(steering=-.5, throttle=.5, brake=0, direction=1)
        with patch("vehicle_edge.cyber_bridge.time.monotonic", return_value=100):
            self.chassis(bridge)
            with self.assertLogs(level="INFO") as logs:
                await bridge.apply_control("remote", command)
                await bridge.apply_control("remote", command)
                await bridge.emergency_brake("test")
        output = [entry for entry in logs.output if "[CYBER_TX]" in entry]
        self.assertEqual(len(output), 2)
        self.assertIn("middleware_accepted=true actuator_ack=false", output[0])
        self.assertIn("throttle_pct=50.00", output[0])
        self.assertIn("brake_pct=100.00", output[1])
        self.writer.write.return_value = False
        with patch("vehicle_edge.cyber_bridge.logging.info") as info:
            with self.assertRaises(RuntimeError):
                await bridge.emergency_brake("failed write")
        info.assert_not_called()
        self.writer.write.return_value = True

    async def test_accept_and_reject_logs_never_dump_packet_or_credentials(self):
        bridge = self.start_bridge(control=True)
        verifier = Mock()
        verifier.verify_packet.return_value = {
            "sequence": 1, "timestamp_ms": int(time.time() * 1000), "session_id": "private-session",
            "command": dict(mode="low_level", steering=.5, throttle=.25, brake=0, direction=1)}
        runtime = SessionVehicleRuntime(verifier, bridge)
        with self.assertLogs(level="INFO") as logs:
            await runtime.on_datachannel_message("private-raw-packet", "operator")
            await runtime.on_datachannel_message("private-raw-packet", "operator")
            verifier.verify_packet.return_value = None
            await runtime.on_datachannel_message("private-raw-packet", "operator")
            await runtime.on_datachannel_message("private-raw-packet", "operator")
        text = "\n".join(logs.output)
        self.assertEqual(text.count("[CONTROL_ACCEPT]"), 1)
        self.assertEqual(text.count("[CONTROL_REJECT]"), 1)
        self.assertIn("throttle=0.250", text)
        self.assertNotIn("private-session", text)
        self.assertNotIn("private-raw-packet", text)

    async def test_propulsion_and_both_steering_directions_publish_together_in_both_gears(self):
        bridge = self.start_bridge(control=True, max_forward_throttle_pct=20,
                                   max_reverse_throttle_pct=10, max_steering_pct=40)
        for gear, direction, throttle in ((1, 1, 10), (2, -1, 5)):
            self.chassis(bridge, gear=gear)
            for steering in (-.5, .5):
                await bridge.apply_control("remote", dict(steering=steering, throttle=.5,
                                                          brake=0, direction=direction))
                message = self.writer.write.call_args.args[0]
                self.assertAlmostEqual(message.throttle, throttle)
                self.assertAlmostEqual(message.steering_target, -steering * 40)
                self.assertEqual(message.brake, 0)
                self.assertEqual(message.gear_location, gear)

    def test_options_reject_invalid_and_disabled_limits(self):
        for fields in ({"max_steering_pct": float("nan")}, {"max_forward_throttle_pct": 101},
                       {"max_reverse_throttle_pct": -1}, {"max_speed_mps": -1},
                       {"chassis_timeout_s": 0}, {"shift_timeout_s": 0},
                       {"throttle_rise_pct_s": 0}, {"steering_rate_pct_s": float("inf")},
                       {"stop_brake_pct": 0}, {"emergency_brake_pct": 10}):
            with self.assertRaises(ValueError):
                CyberOptions(**fields)


if __name__ == "__main__":
    unittest.main()
