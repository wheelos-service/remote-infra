"""Opt-in native middleware check, using isolated non-actuator channels."""

import asyncio
import faulthandler
import json
import os
import sys
import time
import unittest

from vehicle_edge.cyber_bridge import CyberBridge, CyberOptions
from vehicle_edge.state_publisher import StatePublisher


@unittest.skipUnless(os.environ.get("VEHICLE_CYBER_INTEGRATION") == "1",
                     "requires native Cyber runtime and generated WheelOS messages")
class NativeCyberTest(unittest.IsolatedAsyncioTestCase):
    async def test_native_publish_subscribe_and_control(self):
        faulthandler.dump_traceback_later(30)
        self.addCleanup(faulthandler.cancel_dump_traceback_later)
        from vehicle_edge.cyber_runtime import load_runtime

        cyber, Chassis, ControlCommand, LocalizationEstimate = load_runtime()

        prefix = f"/teleop/test/{os.getpid()}"
        bridge = CyberBridge(CyberOptions(
            enabled=True, control_enabled=True, node_name=f"teleop_test_{os.getpid()}",
            localization_channel=prefix + "/localization",
            chassis_channel=prefix + "/chassis",
            control_channel=prefix + "/control",
            max_forward_throttle_pct=100, max_steering_pct=100, max_speed_mps=5,
            throttle_rise_pct_s=1e9, steering_rate_pct_s=1e9,
        ))
        bridge.start()
        try:
            publisher = StatePublisher(bridge, lambda: {"state": "active"}, "test-vehicle")
            peer = cyber.Node(f"teleop_peer_{os.getpid()}")
            commands = []
            reader = peer.create_reader(prefix + "/control", ControlCommand, commands.append)
            localization_writer = peer.create_writer(prefix + "/localization", LocalizationEstimate)
            chassis_writer = peer.create_writer(prefix + "/chassis", Chassis)
            localization = LocalizationEstimate()
            localization.pose.position.x = 123.5
            localization.pose.position.y = 456.25
            localization.pose.heading = 0.75
            localization.trajectory_point.add().v = 9.5
            chassis = Chassis()
            chassis.speed_mps = 2.5
            chassis.driving_mode = Chassis.COMPLETE_AUTO_DRIVE
            chassis.gear_location = Chassis.GEAR_DRIVE
            chassis.surround.sonar_range.append(12.5)
            chassis.engine_rpm = float("nan")
            chassis.brake_percentage = float("nan")
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                self.assertTrue(localization_writer.write(localization))
                self.assertTrue(chassis_writer.write(chassis))
                if "chassis" not in bridge.snapshot():
                    await asyncio.sleep(0.05)
                    continue
                await bridge.apply_control("remote", {
                    "steering": -0.25, "throttle": 0.1, "brake": 0, "direction": 1,
                })
                await asyncio.sleep(0.05)
                state = publisher.packet()
                if commands and all(state[kind]["message"] is not None
                                    for kind in ("localization", "chassis")):
                    break
            else:
                self.fail("native Cyber pub/sub discovery or delivery timed out")
            self.assertIsNotNone(reader)
            self.assertEqual(state["localization"]["message"]["pose"]["position"]["x"], 123.5)
            self.assertEqual(state["chassis"]["message"]["speed_mps"], 2.5)
            self.assertNotIn("trajectory_point", state["localization"]["message"])
            self.assertNotIn("surround", state["chassis"]["message"])
            self.assertNotIn("engine_rpm", state["chassis"]["message"])
            self.assertIsNone(state["chassis"]["message"]["brake_percentage"])
            self.assertEqual(commands[-1].steering_target, 25)
            self.assertEqual(commands[-1].throttle, 10)
            self.assertEqual(commands[-1].gear_location, Chassis.GEAR_DRIVE)
            if os.environ.get("VEHICLE_CYBER_BACKEND") == "apollo":
                # Verify an independently initialized Apollo process can receive
                # the bridge's command, on an isolated non-actuator channel.
                child_code = '''
import json, sys, time
from vehicle_edge.cyber_runtime import load_runtime
cyber, _, ControlCommand, _ = load_runtime()
assert cyber.init("teleop_cross_process")
node = cyber.Node("teleop_cross_process")
messages = []
reader = node.create_reader(sys.argv[1], ControlCommand, messages.append)
assert reader is not None
print("READY", flush=True)
deadline = time.monotonic() + 8
while not messages and time.monotonic() < deadline:
    time.sleep(0.05)
result = [messages[-1].steering_target, messages[-1].throttle] if messages else None
cyber.shutdown()
print(json.dumps(result), flush=True)
'''
                env = dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path))
                process = await asyncio.create_subprocess_exec(
                    sys.executable, "-u", "-c", child_code, prefix + "/control",
                    env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                try:
                    self.assertEqual(await asyncio.wait_for(process.stdout.readline(), 5), b"READY\n")
                    received = asyncio.create_task(process.stdout.readline())
                    cross_deadline = time.monotonic() + 7
                    while not received.done() and time.monotonic() < cross_deadline:
                        self.assertTrue(chassis_writer.write(chassis))
                        await asyncio.sleep(0.05)
                        await bridge.apply_control("remote", {
                            "steering": -0.25, "throttle": 0.1, "brake": 0, "direction": 1,
                        })
                        await asyncio.sleep(0.05)
                    self.assertEqual(json.loads(await asyncio.wait_for(received, 2)), [25, 10])
                    self.assertEqual(await asyncio.wait_for(process.wait(), 3), 0)
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
            # No fresh chassis arrives after this point. Motion must fail closed
            # before writing another control command.
            await asyncio.sleep(bridge.options.chassis_timeout_s + 0.1)
            count = len(commands)
            with self.assertRaisesRegex(RuntimeError, "chassis feedback missing or stale"):
                await bridge.apply_control("remote", {
                    "steering": 0, "throttle": 0.1, "brake": 0, "direction": 1,
                })
            await asyncio.sleep(0.1)
            self.assertEqual(len(commands), count)
            count = len(commands)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                await bridge.emergency_brake("integration watchdog")
                await asyncio.sleep(0.05)
                if len(commands) > count:
                    break
            self.assertGreater(len(commands), count)
            self.assertEqual(commands[-1].brake, 100)
            self.assertEqual(commands[-1].throttle, 0)
            self.assertEqual(commands[-1].gear_location, Chassis.GEAR_DRIVE)
        finally:
            bridge.close()


if __name__ == "__main__":
    unittest.main()
