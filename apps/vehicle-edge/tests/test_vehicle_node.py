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
