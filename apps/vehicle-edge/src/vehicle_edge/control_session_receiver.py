"""Vehicle-side validation for active Gateway control sessions."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from dataclasses import dataclass
from typing import Any, Optional

import aiohttp
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from .control_protocol import CONTROL_TYPE, PROTOCOL_VERSION, build_sign_message, resolve_command, valid_command


@dataclass
class ActiveControlSession:
    session_id: str
    vehicle_id: str
    operator_id: str
    public_key_b64: str
    status: str
    expires_at_ms: int


class SessionCommandVerifier:
    def __init__(self, gateway_url: str, vehicle_id: str, auth_token: str, max_age_ms: int = 100, max_future_skew_ms: int = 100) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.vehicle_id = vehicle_id
        self.auth_token = auth_token
        self.max_age_ms = max_age_ms
        self.max_future_skew_ms = max_future_skew_ms
        self.session: Optional[ActiveControlSession] = None
        self.verify_key: Optional[VerifyKey] = None
        self.last_sequence = 0
        self.last_valid_cmd_time = time.monotonic()

    def _clear_session(self) -> None:
        self.session = None
        self.verify_key = None
        self.last_sequence = 0

    async def refresh_session(self, http_session: aiohttp.ClientSession) -> None:
        # Fail closed: a stale session must never survive a failed refresh.
        previous_session_id = self.session.session_id if self.session else None
        previous_sequence = self.last_sequence
        self._clear_session()
        headers = {"Authorization": f"Bearer {self.auth_token}"}
        url = f"{self.gateway_url}/api/vehicles/{self.vehicle_id}/control"
        async with http_session.get(url, headers=headers, timeout=2) as response:
            if response.status == 404:
                return
            if response.status != 200:
                raise RuntimeError(f"control session refresh failed: {response.status} {await response.text()}")
            payload = await response.json()
        data = payload["session"]
        session = ActiveControlSession(
            session_id=data["session_id"], vehicle_id=data["vehicle_id"],
            operator_id=data["operator_id"], public_key_b64=data["public_key_b64"],
            status=data["status"], expires_at_ms=int(data["expires_at_ms"]),
        )
        if session.vehicle_id != self.vehicle_id or session.status != "ACTIVE":
            raise RuntimeError("invalid active control session")
        try:
            verify_key = VerifyKey(base64.b64decode(session.public_key_b64, validate=True))
        except (ValueError, TypeError) as exc:
            raise RuntimeError("invalid session public key") from exc
        self.session = session
        self.verify_key = verify_key
        if session.session_id == previous_session_id:
            self.last_sequence = previous_sequence

    def verify_packet(self, raw_message: str, sender_identity: str) -> Optional[dict[str, Any]]:
        if self.session is None or self.verify_key is None:
            return None
        try:
            packet = json.loads(raw_message)
            required = {"version", "type", "session_id", "sequence", "timestamp_ms", "command", "signature"}
            if not required.issubset(packet) or packet["version"] != PROTOCOL_VERSION or packet["type"] != CONTROL_TYPE:
                return None
            if packet["session_id"] != self.session.session_id or sender_identity != f"operator-{self.session.operator_id}":
                return None
            now_ms = int(time.time() * 1000)
            if now_ms > self.session.expires_at_ms:
                self._clear_session()
                return None
            if now_ms - int(packet["timestamp_ms"]) > self.max_age_ms or int(packet["timestamp_ms"]) - now_ms > self.max_future_skew_ms:
                return None
            if int(packet["sequence"]) <= self.last_sequence or not valid_command(packet["command"]):
                return None
            self.verify_key.verify(build_sign_message(packet).encode(), base64.b64decode(packet["signature"], validate=True))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, BadSignatureError):
            return None
        self.last_sequence = int(packet["sequence"])
        self.last_valid_cmd_time = time.monotonic()
        return packet


class SessionVehicleRuntime:
    def __init__(self, verifier: SessionCommandVerifier, brake_controller: Any) -> None:
        self.verifier = verifier
        self.brake_controller = brake_controller
        self.running = True
        self.latencies: list[int] = []
        self.lost_count = 0
        self._last_sequence: Optional[int] = None
        self._audit_events: list[dict[str, str]] = []
        self._last_audit_at: dict[str, float] = {}

    def _queue_audit_event(self, event: str, reason: str) -> None:
        now = time.monotonic()
        if now - self._last_audit_at.get(event, 0) < 5:
            return
        self._last_audit_at[event] = now
        self._audit_events.append({"event": event, "reason": reason})

    async def on_datachannel_message(self, raw_message: str, sender_identity: str) -> None:
        packet = self.verifier.verify_packet(raw_message, sender_identity)
        if packet is None:
            self._queue_audit_event("command_rejected", "session command validation failed")
            return
        sequence = int(packet["sequence"])
        if self._last_sequence is not None and sequence > self._last_sequence + 1:
            self.lost_count += sequence - self._last_sequence - 1
        self._last_sequence = sequence
        self.latencies.append(max(0, int(time.time() * 1000) - int(packet["timestamp_ms"])))
        command = resolve_command(packet["command"])
        if command["brake"] >= 1:
            self._queue_audit_event("emergency_stop", "remote full brake command")
        await self.brake_controller.apply_control("remote", command)

    async def safety_watchdog(self, timeout_ms: int = 300, check_interval_ms: int = 50) -> None:
        while self.running:
            elapsed_ms = (time.monotonic() - self.verifier.last_valid_cmd_time) * 1000
            if elapsed_ms > timeout_ms:
                was_in_emergency = self.brake_controller.in_emergency
                await self.brake_controller.emergency_brake(f"no valid command for {int(elapsed_ms)}ms")
                if not was_in_emergency:
                    self._queue_audit_event("watchdog_timeout", "no valid remote control command")
            await asyncio.sleep(check_interval_ms / 1000)

    async def audit_loop(self, gateway_url: str, http_session: aiohttp.ClientSession) -> None:
        while self.running:
            await asyncio.sleep(1)
            events, self._audit_events = self._audit_events, []
            for event in events:
                session_id = self.verifier.session.session_id if self.verifier.session else ""
                try:
                    async with http_session.post(
                        f"{gateway_url.rstrip('/')}/api/audit/events",
                        json={**event, "session_id": session_id},
                        headers={"Authorization": f"Bearer {self.verifier.auth_token}"},
                        timeout=2,
                    ):
                        pass
                except aiohttp.ClientError:
                    pass

    async def telemetry_loop(self, gateway_url: str, vehicle_id: str, http_session: aiohttp.ClientSession) -> None:
        while self.running:
            await asyncio.sleep(10)
            if not self.latencies and not self.lost_count:
                continue
            latencies = sorted(self.latencies)
            self.latencies.clear()
            lost_count, self.lost_count = self.lost_count, 0
            payload = {
                "vehicle_id": vehicle_id,
                "p50": float(latencies[len(latencies) // 2]) if latencies else 0,
                "p99": float(latencies[min(len(latencies) - 1, int(len(latencies) * 0.99))]) if latencies else 0,
                "lost_count": lost_count,
            }
            try:
                async with http_session.post(
                    f"{gateway_url.rstrip('/')}/api/telemetry",
                    json=payload,
                    headers={"Authorization": f"Bearer {self.verifier.auth_token}"},
                    timeout=2,
                ):
                    pass
            except aiohttp.ClientError:
                pass
