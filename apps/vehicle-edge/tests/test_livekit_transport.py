import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from vehicle_edge.livekit_transport import LiveKitTransport


class FakeRoom:
    def __init__(self):
        self.callbacks = {}
        self.local_participant = SimpleNamespace(publish_data=AsyncMock())
        self.connect = AsyncMock()
        self.disconnect = AsyncMock()

    def on(self, name, callback):
        self.callbacks[name] = callback

    def packet(self, data=b'{"type":"control"}', topic="vehicle.control", identity="operator-1"):
        self.callbacks["data_received"](SimpleNamespace(
            data=data, topic=topic, participant=SimpleNamespace(identity=identity)))


class LiveKitTransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_topic_filter_legacy_and_latest_only_dispatch(self):
        room = FakeRoom()
        ready = asyncio.Event()
        received = asyncio.Event()
        command = AsyncMock(side_effect=lambda *args: received.set())
        lost = AsyncMock()
        transport = LiveKitTransport("ws://rtc", AsyncMock(return_value="token"), command, lost, ready.set)

        async def serve(participant):
            await asyncio.Event().wait()

        rtc = SimpleNamespace(Room=lambda: room, RoomOptions=lambda **kwargs: kwargs)
        task = asyncio.create_task(transport._connect(rtc, serve))
        try:
            await asyncio.wait_for(ready.wait(), 1)
            room.packet(topic="vehicle.state")
            room.packet(identity="vehicle-car-1")
            room.packet(data=b"\xff")
            room.packet(data=b"x" * 4097)
            room.packet(data=b"old")
            room.packet(data=b"new", topic="")
            await asyncio.wait_for(received.wait(), 1)
            command.assert_awaited_once_with("new", "operator-1")
            await transport.send(b"state", "vehicle.state")
            room.local_participant.publish_data.assert_awaited_once_with(
                b"state", reliable=False, topic="vehicle.state")
            room.callbacks["reconnecting"]()
            room.packet(data=b"late")
            await asyncio.wait_for(task, 1)
            command.assert_awaited_once()
            lost.assert_awaited_once()
            room.disconnect.assert_awaited_once()
            with self.assertRaises(ConnectionError):
                await transport.send(b"state", "vehicle.state")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_reconnect_refreshes_token_restarts_services_and_ignores_old_room(self):
        rooms = [FakeRoom(), FakeRoom()]
        tokens = AsyncMock(side_effect=["token-1", "token-2"])
        ready = asyncio.Event()
        command = AsyncMock()
        lost = AsyncMock()
        transport = LiveKitTransport("ws://rtc", tokens, command, lost, Mock())
        calls = 0
        cancelled = []

        async def serve(participant):
            nonlocal calls
            index = calls
            calls += 1
            try:
                if index == 0:
                    rooms[0].callbacks["disconnected"]()
                else:
                    ready.set()
                await asyncio.Event().wait()
            finally:
                cancelled.append(index)

        rtc = SimpleNamespace(Room=Mock(side_effect=rooms), RoomOptions=lambda **kwargs: kwargs)
        with patch.dict("sys.modules", {"livekit": SimpleNamespace(rtc=rtc)}):
            task = asyncio.create_task(transport.run(serve))
            try:
                await asyncio.wait_for(ready.wait(), 2)
                self.assertEqual(tokens.await_count, 2)
                rooms[0].connect.assert_awaited_once_with("ws://rtc", "token-1", {"dynacast": True})
                rooms[1].connect.assert_awaited_once_with("ws://rtc", "token-2", {"dynacast": True})
                rooms[0].packet(data=b"old connection")
                await asyncio.sleep(0)
                command.assert_not_awaited()
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(cancelled, [0, 1])
        self.assertEqual(lost.await_count, 2)
        self.assertTrue(all(room.disconnect.await_count == 1 for room in rooms))


if __name__ == "__main__":
    unittest.main()
