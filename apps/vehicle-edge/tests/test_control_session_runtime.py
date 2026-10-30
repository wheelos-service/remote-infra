import asyncio
import base64
import json
import time
import unittest
from unittest.mock import AsyncMock, patch

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

    async def test_rejection_reasons_and_time_limits_preserve_fail_closed_behavior(self):
        now = int(time.time() * 1000)
        cases = [
            ({"timestamp_ms": now - 101}, "operator-driver-1", "packet_too_old", 101),
            ({"timestamp_ms": now + 101}, "operator-driver-1", "packet_from_future", -101),
            ({"session_id": "other-session"}, "operator-driver-1", "session_mismatch", None),
            ({}, "operator-other", "sender_mismatch", None),
            ({"sequence": 0}, "operator-driver-1", "sequence_not_increasing", 0),
            ({"command": {"mode": "high_level", "action": "invalid"}},
             "operator-driver-1", "invalid_command", 0),
            ({"signature": base64.b64encode(bytes(64)).decode()},
             "operator-driver-1", "invalid_signature", 0),
            ({"type": "wrong"}, "operator-driver-1", "invalid_envelope", None),
        ]
        with patch("vehicle_edge.control_session_receiver.time.time", return_value=now / 1000):
            for changes, sender, reason, age in cases:
                with self.subTest(reason=reason):
                    packet = json.loads(self.packet())
                    packet.update(changes)
                    await self.runtime.on_datachannel_message(json.dumps(packet), sender)
                    self.assertEqual(self.verifier.last_reject_reason, reason)
                    self.assertEqual(self.verifier.last_packet_age_ms, age)
                    self.assertEqual(self.verifier.last_sequence, 0)
                    self.assertEqual(self.brake.applied, [])
            for age in (-100, 0, 50, 99, 100):
                with self.subTest(accepted_age=age):
                    packet = json.loads(self.packet(self.verifier.last_sequence + 1))
                    packet["timestamp_ms"] = now - age
                    packet["signature"] = base64.b64encode(
                        self.key.sign(build_sign_message(packet).encode()).signature).decode()
                    await self.runtime.on_datachannel_message(json.dumps(packet), "operator-driver-1")
                    self.assertIsNone(self.verifier.last_reject_reason)
            self.assertEqual(len(self.brake.applied), 5)

    async def test_reject_log_reports_reason_without_packet_secrets(self):
        packet = json.loads(self.packet())
        packet["session_id"] = "private-session"
        with self.assertLogs(level="WARNING") as logs:
            await self.runtime.on_datachannel_message(json.dumps(packet), "operator-driver-1")
        output = "\n".join(logs.output)
        self.assertIn("reason=session_mismatch", output)
        self.assertNotIn("private-session", output)
        self.assertNotIn(packet["signature"], output)
        self.assertNotIn(self.verifier.session.public_key_b64, output)

    async def test_missing_expired_and_malformed_session_rejection_diagnostics(self):
        raw = self.packet()
        self.assertIsNone(self.verifier.verify_packet("not json", "operator-driver-1"))
        self.assertEqual(self.verifier.last_reject_reason, "malformed_packet")
        self.verifier.session.expires_at_ms = 0
        self.assertIsNone(self.verifier.verify_packet(raw, "operator-driver-1"))
        self.assertEqual(self.verifier.last_reject_reason, "session_expired_or_inactive")
        self.assertIsNone(self.verifier.verify_packet(raw, "operator-driver-1"))
        self.assertEqual(self.verifier.last_reject_reason, "no_active_session")

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
