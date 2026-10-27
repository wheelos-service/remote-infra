import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from vehicle_edge.cyber_bridge import CyberSample
from vehicle_edge.state_publisher import StatePublisher


class StatePublisherTest(unittest.IsolatedAsyncioTestCase):
    async def test_latest_state_sequence_stream_and_missing_samples(self):
        samples = {}
        publisher = StatePublisher(SimpleNamespace(snapshot=lambda: samples), lambda: {
            "state": "monitoring", "last_published_sequence": None,
        }, "car-1")
        first = publisher.packet()
        self.assertTrue(first["localization"]["stale"])
        self.assertIsNone(first["chassis"]["message"])
        self.assertEqual(first["sequence"], 1)
        samples["localization"] = CyberSample(object(), 100, 200)
        samples["chassis"] = CyberSample(object(), 100, 1001)
        with patch("vehicle_edge.state_publisher._summary", return_value={"speed_mps": 2.5}):
            second = publisher.packet()
        self.assertEqual(second["sequence"], 2)
        self.assertEqual(first["stream_id"], second["stream_id"])
        self.assertFalse(second["localization"]["stale"])
        self.assertTrue(second["chassis"]["stale"])
        self.assertEqual(second["chassis"]["message"], {"speed_mps": 2.5})
        self.assertEqual(second["control"]["state"], "monitoring")

    async def test_failed_or_blocked_send_is_dropped_and_next_sample_is_fresh(self):
        publisher = StatePublisher(SimpleNamespace(snapshot=lambda: {}), lambda: {}, "car-1")
        sent = []
        delivered = asyncio.Event()
        cancelled = asyncio.Event()

        async def send(payload, topic):
            packet = json.loads(payload)
            sent.append(packet["sequence"])
            self.assertEqual(topic, "vehicle.state")
            if len(sent) == 1:
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
            elif len(sent) == 2:
                raise ConnectionError("disconnected")
            else:
                delivered.set()

        task = asyncio.create_task(publisher.run(send))
        try:
            await asyncio.wait_for(delivered.wait(), 2)
            self.assertTrue(cancelled.is_set())
            self.assertEqual(sent, [1, 2, 3])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
