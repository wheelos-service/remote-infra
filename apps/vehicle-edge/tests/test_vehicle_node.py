import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from vehicle_edge.camera_config import CameraOptions
from vehicle_edge.vehicle_node import _serve_room


class VehicleNodeTest(unittest.IsolatedAsyncioTestCase):
    async def test_room_services_cancel_state_publisher(self):
        monitor_started = asyncio.Event()
        monitor_cancelled = asyncio.Event()
        transport = SimpleNamespace(send=AsyncMock())

        async def monitor_loop(send):
            self.assertIs(send, transport.send)
            monitor_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                monitor_cancelled.set()

        publisher = SimpleNamespace(run=monitor_loop)
        task = asyncio.create_task(_serve_room(object(), CameraOptions(), publisher, transport))
        await asyncio.wait_for(monitor_started.wait(), 1)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(monitor_cancelled.is_set())

    async def test_cli_accepts_video_scaling_with_cyber_control(self):
        from vehicle_edge.vehicle_node import _parse_args

        with patch("sys.argv", [
            "vehicle_node", "--gateway", "http://gateway", "--vehicle-id", "car-1",
            "--livekit-url", "ws://rtc", "--cyber", "--cyber-control",
            "--video-width", "640", "--video-height", "360",
        ]):
            args = _parse_args()
        self.assertTrue(args.cyber_control)
        self.assertEqual((args.video_width, args.video_height), (640, 360))

    async def test_cli_rejects_partial_video_size(self):
        from vehicle_edge.vehicle_node import _parse_args

        with patch("sys.argv", [
            "vehicle_node", "--gateway", "http://gateway", "--vehicle-id", "car-1",
            "--livekit-url", "ws://rtc", "--video-width", "640",
        ]), patch("sys.stderr", Mock()):
            with self.assertRaises(SystemExit) as error:
                _parse_args()
        self.assertEqual(error.exception.code, 2)

    async def test_cli_validates_cyber_limits(self):
        from vehicle_edge.vehicle_node import _parse_args

        base = ["vehicle_node", "--gateway", "http://gateway", "--vehicle-id", "car-1",
                "--livekit-url", "ws://rtc", "--cyber", "--cyber-control"]
        with patch("sys.argv", base + ["--cyber-max-forward-throttle-pct", "12",
                                       "--cyber-stop-brake-pct", "20"]):
            args = _parse_args()
        self.assertEqual(args.cyber_max_forward_throttle_pct, 12)
        self.assertEqual(args.cyber_stop_brake_pct, 20)
        self.assertEqual(args.cyber_max_reverse_throttle_pct, 0)
        for flags in (["--cyber-max-steering-pct", "101"],
                      ["--cyber-max-speed-mps", "nan"],
                      ["--cyber-stop-brake-pct", "0"]):
            with patch("sys.argv", base + flags), patch("sys.stderr", Mock()):
                with self.assertRaises(SystemExit) as error:
                    _parse_args()
            self.assertEqual(error.exception.code, 2)

    async def test_cli_rejects_control_without_cyber(self):
        from vehicle_edge.vehicle_node import _parse_args

        with patch("sys.argv", [
            "vehicle_node", "--gateway", "http://gateway", "--vehicle-id", "car-1",
            "--livekit-url", "ws://rtc", "--cyber-control",
        ]), patch("sys.stderr", Mock()):
            with self.assertRaises(SystemExit) as error:
                _parse_args()
        self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
