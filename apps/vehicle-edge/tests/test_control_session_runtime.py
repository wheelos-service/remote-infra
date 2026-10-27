import asyncio
import base64
import json
import time
import unittest
from unittest.mock import AsyncMock

from nacl.signing import SigningKey

from vehicle_edge.control_protocol import build_sign_message
from vehicle_edge.control_session_receiver import (
    ActiveControlSession, SessionCommandVerifier, SessionVehicleRuntime,
)


class Brake:
    def __init__(self):
        self.in_emergency = False
        self.applied = []
        self.stops = []
        self.fail = False

    async def apply_control(self, cmd, command):
        if self.fail:
            raise RuntimeError("writer failure")
        self.applied.append(command)
        self.in_emergency = False
        return True

    async def emergency_brake(self, reason):
        self.stops.append(reason)
        self.in_emergency = True


class Response:
    def __init__(self, status=200, session=None, gate=None):
        self.status = status
        self.session = session
        self.gate = gate
        self.entered = asyncio.Event()

    async def __aenter__(self):
        self.entered.set()
        if self.gate:
            await self.gate.wait()
        return self

    async def __aexit__(self, *args):
        return None

    async def json(self):
        return {"session": self.session.__dict__}

    async def text(self):
        return "request failed"


class HTTP:
    def __init__(self, response):
        self.response = response

    def get(self, *args, **kwargs):
        return self.response


class SessionRuntimeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.key = SigningKey.generate()
        self.verifier = SessionCommandVerifier("http://gateway", "car-1", "")
        self.verifier.session = ActiveControlSession(
            "session-1", "car-1", "driver-1",
            base64.b64encode(bytes(self.key.verify_key)).decode(), "ACTIVE",
            int(time.time() * 1000) + 5000,
        )
        self.verifier.verify_key = self.key.verify_key
        self.brake = Brake()
        self.runtime = SessionVehicleRuntime(self.verifier, self.brake)

    def packet(self, sequence=1):
        packet = {
            "version": 1, "type": "control", "session_id": self.verifier.session.session_id,
            "sequence": sequence, "timestamp_ms": int(time.time() * 1000),
            "command": {"steering": -0.2, "throttle": 0.1, "brake": 0},
        }
        packet["signature"] = base64.b64encode(
            self.key.sign(build_sign_message(packet).encode()).signature).decode()
        return json.dumps(packet)

    async def command(self, sequence=1):
        await self.runtime.on_datachannel_message(self.packet(sequence), "operator-driver-1")

    async def test_revocation_or_failed_poll_stops_without_waiting_for_command_timeout(self):
        for status in (404, 503):
            with self.subTest(status=status):
                self.setUp()
                await self.command()
                try:
                    await self.runtime.refresh_session(HTTP(Response(status=status)))
                except RuntimeError:
                    self.assertEqual(status, 503)
                self.assertIsNone(self.verifier.session)
                self.assertTrue(self.brake.in_emergency)
                self.assertEqual(self.brake.stops, ["control session invalidated"])

    async def test_refresh_preserves_replay_watermark_and_does_not_suspend_active_session(self):
        await self.command()
        response = Response(session=self.verifier.session, gate=asyncio.Event())
        task = asyncio.create_task(self.runtime.refresh_session(HTTP(response)))
        await response.entered.wait()
        await self.command(2)
        response.gate.set()
        await task
        self.assertEqual(self.verifier.last_sequence, 2)
        self.assertEqual(len(self.brake.applied), 2)
        self.assertEqual(self.brake.stops, [])
        await self.command(2)
        self.assertEqual(len(self.brake.applied), 2)

    async def test_disconnect_during_refresh_cannot_restore_old_session(self):
        await self.command()
        response = Response(session=self.verifier.session, gate=asyncio.Event())
        task = asyncio.create_task(self.runtime.refresh_session(HTTP(response)))
        await response.entered.wait()
        await self.runtime.transport_lost("disconnected")
        response.gate.set()
        await task
        self.assertFalse(self.runtime.connected)
        self.assertIsNone(self.verifier.session)
        self.assertTrue(self.brake.in_emergency)

    async def test_same_session_reconnect_preserves_replay_watermark(self):
        await self.command()
        session = self.verifier.session
        replay = self.packet()
        await self.runtime.transport_lost("disconnected")
        await self.runtime.refresh_session(HTTP(Response(session=session)))
        self.runtime.transport_ready()
        await self.runtime.on_datachannel_message(replay, "operator-driver-1")
        self.assertEqual(len(self.brake.applied), 1)
        await self.command(2)
        self.assertEqual(len(self.brake.applied), 2)

    async def test_idle_control_mode_never_arms_watchdog(self):
        self.verifier.last_valid_cmd_time = time.monotonic() - 10
        task = asyncio.create_task(self.runtime.safety_watchdog(check_interval_ms=1))
        await asyncio.sleep(0.01)
        self.runtime.running = False
        await task
        self.assertEqual(self.brake.stops, [])

    async def test_session_expiry_stops_even_with_fresh_command_timestamp(self):
        await self.command()
        self.verifier.session.expires_at_ms = int(time.time() * 1000) - 1
        self.brake.emergency_brake = AsyncMock(side_effect=self.brake.emergency_brake)
        task = asyncio.create_task(self.runtime.safety_watchdog(check_interval_ms=1))
        await asyncio.sleep(0.01)
        self.runtime.running = False
        await task
        self.brake.emergency_brake.assert_awaited()
        self.assertEqual(self.brake.stops[0], "control session expired or revoked")

    async def test_publication_feedback_advances_only_on_success_and_new_session_resets_loss(self):
        await self.command(10)
        self.assertEqual(self.runtime.control_status()["last_published_sequence"], 10)
        self.brake.fail = True
        await self.command(11)
        status = self.runtime.control_status()
        self.assertEqual(status["last_published_sequence"], 10)
        self.assertEqual(status["state"], "fault")
        self.assertEqual(status["fault"], "control publication failed")
        self.brake.fail = False
        self.verifier.session.session_id = "session-2"
        self.verifier.last_sequence = 0
        await self.command(1)
        status = self.runtime.control_status()
        self.assertEqual(status["last_published_session_id"], "session-2")
        self.assertEqual(status["last_published_sequence"], 1)
        self.assertEqual(status["state"], "active")
        self.assertIsNone(status["fault"])
        self.assertEqual(self.runtime.lost_count, 0)

    async def test_monitoring_ignores_control_and_malformed_packets_are_dropped(self):
        self.runtime.control_enabled = False
        await self.command()
        self.assertEqual(self.brake.applied, [])
        self.assertEqual(self.runtime.control_status()["state"], "monitoring")
        self.runtime.control_enabled = True
        for raw in ('null', '[]', '"control"', '{"sequence":1}', 'not json'):
            await self.runtime.on_datachannel_message(raw, "operator-driver-1")
        self.assertEqual(self.brake.applied, [])


if __name__ == "__main__":
    unittest.main()
