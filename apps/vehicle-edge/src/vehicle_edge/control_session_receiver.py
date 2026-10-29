"""Vehicle-side validation for active Gateway control sessions."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
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
    def __init__(self, gateway_url: str, vehicle_id: str, auth_token: str, max_age_ms: int = 3000, max_future_skew_ms: int = 100) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.vehicle_id = vehicle_id
        self.auth_token = auth_token
        self.max_age_ms = max_age_ms
        self.max_future_skew_ms = max_future_skew_ms
        self.session: Optional[ActiveControlSession] = None
        self.verify_key: Optional[VerifyKey] = None
        self.last_sequence = 0
        self.last_valid_cmd_time = time.monotonic()
        self._generation = 0
        self._sequence_session_id: Optional[str] = None
        self.last_reject_reason: Optional[str] = None
        self.last_packet_age_ms: Optional[int] = None

    def clear_session(self) -> None:
        self._generation += 1
        if self.session is not None:
            self._sequence_session_id = self.session.session_id
        self.session = None
        self.verify_key = None

    async def refresh_session(self, http_session: aiohttp.ClientSession) -> None:
        try:
            await self._refresh_session(http_session)
        except Exception:
            self.clear_session()
            raise

    def session_valid(self) -> bool:
        return (self.session is not None and self.session.status == "ACTIVE"
                and int(time.time() * 1000) < self.session.expires_at_ms)

    async def _refresh_session(self, http_session: aiohttp.ClientSession) -> None:
        generation = self._generation
        headers = {"Authorization": f"Bearer {self.auth_token}"}
        url = f"{self.gateway_url}/api/vehicles/{self.vehicle_id}/control"
        async with http_session.get(url, headers=headers, timeout=2) as response:
            if response.status == 404:
                self.clear_session()
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
        # Keep the existing session while polling, but fail closed on any error.
        # Commands accepted during the request must retain their replay watermark.
        if generation != self._generation:
            return
        previous_id = self.session.session_id if self.session else self._sequence_session_id
        if session.session_id != previous_id:
            self.last_sequence = 0
        elif self.session is not None and session.public_key_b64 != self.session.public_key_b64:
            raise RuntimeError("session public key changed")
        self.session = session
        self.verify_key = verify_key

    def verify_packet(self, raw_message: str, sender_identity: str) -> Optional[dict[str, Any]]:
        self.last_reject_reason = None
        self.last_packet_age_ms = None
        if self.session is None or self.verify_key is None:
            self.last_reject_reason = "no_active_session"
            return None
        try:
            packet = json.loads(raw_message)
            required = {"version", "type", "session_id", "sequence", "timestamp_ms", "command", "signature"}
            if not isinstance(packet, dict) or not required.issubset(packet) or packet["version"] != PROTOCOL_VERSION or packet["type"] != CONTROL_TYPE:
                self.last_reject_reason = "invalid_envelope"
                return None
            if packet["session_id"] != self.session.session_id:
                self.last_reject_reason = "session_mismatch"
                return None
            if sender_identity != f"operator-{self.session.operator_id}":
                self.last_reject_reason = "sender_mismatch"
                return None
            now_ms = int(time.time() * 1000)
            if not self.session_valid():
                self.clear_session()
                self.last_reject_reason = "session_expired_or_inactive"
                return None
            self.last_packet_age_ms = now_ms - int(packet["timestamp_ms"])
            if self.last_packet_age_ms > self.max_age_ms:
                self.last_reject_reason = "packet_too_old"
                return None
            if self.last_packet_age_ms < -self.max_future_skew_ms:
                self.last_reject_reason = "packet_from_future"
                return None
            if int(packet["sequence"]) <= self.last_sequence:
                self.last_reject_reason = "sequence_not_increasing"
                return None
            if not valid_command(packet["command"]):
                self.last_reject_reason = "invalid_command"
                return None
            self.verify_key.verify(build_sign_message(packet).encode(), base64.b64decode(packet["signature"], validate=True))
        except BadSignatureError:
            self.last_reject_reason = "invalid_signature"
            return None
        except (KeyError, TypeError, ValueError, OverflowError, json.JSONDecodeError):
            self.last_reject_reason = "malformed_packet"
            return None
        self.last_sequence = int(packet["sequence"])
        self._sequence_session_id = packet["session_id"]
        self.last_valid_cmd_time = time.monotonic()
        return packet


class SessionVehicleRuntime:
    def __init__(self, verifier: SessionCommandVerifier, brake_controller: Any, control_enabled: bool = True) -> None:
        self.verifier = verifier
        self.brake_controller = brake_controller
        self.running = True
        self.latencies: list[int] = []
        self.lost_count = 0
        self._last_sequence: Optional[int] = None
        self._audit_events: list[dict[str, str]] = []
        self._last_audit_at: dict[str, float] = {}
        self.control_enabled = control_enabled
        self.connected = True
        self._command_session_id: Optional[str] = None
        self._received_session_id: Optional[str] = None
        self._published_session_id: Optional[str] = None
        self._published_sequence: Optional[int] = None
        self._fault: Optional[str] = None
        self._safety_reason: Optional[str] = None
        self._normal_stop = False
        self._last_control_log_at = float("-inf")
        self._last_control_log_kind = None
        self._last_reject_log_at = float("-inf")

    async def refresh_session(self, http_session: aiohttp.ClientSession) -> None:
        try:
            await self.verifier.refresh_session(http_session)
        finally:
            if self._command_session_id is not None and not self._owns_session():
                await self._emergency_brake("control session invalidated")

    def _owns_session(self) -> bool:
        return (self.verifier.session_valid() and self.verifier.session is not None
                and self.verifier.session.session_id == self._command_session_id)

    def transport_ready(self) -> None:
        self.connected = True

    async def transport_lost(self, reason: str) -> None:
        self.connected = False
        self.verifier.clear_session()
        if self._command_session_id is not None:
            await self._emergency_brake(reason)

    def control_status(self) -> dict[str, Any]:
        state = "monitoring" if not self.control_enabled else "idle"
        if self.control_enabled:
            if self._fault:
                state = "fault"
            elif self.brake_controller.in_emergency:
                state = "emergency"
            elif self._published_sequence is not None and self.connected and self._owns_session():
                state = "active"
        return {
            "enabled": self.control_enabled, "connected": self.connected, "state": state,
            "session_id": self.verifier.session.session_id if self.verifier.session_valid() else None,
            "last_published_session_id": self._published_session_id,
            "last_published_sequence": self._published_sequence,
            "safety_reason": self._safety_reason, "fault": self._fault,
        }

    def _queue_audit_event(self, event: str, reason: str) -> None:
        now = time.monotonic()
        if now - self._last_audit_at.get(event, 0) < 5:
            return
        self._last_audit_at[event] = now
        self._audit_events.append({"event": event, "reason": reason})

    async def on_datachannel_message(self, raw_message: str, sender_identity: str) -> None:
        if not self.connected or not self.control_enabled:
            return
        packet = self.verifier.verify_packet(raw_message, sender_identity)
        if packet is None:
            now = time.monotonic()
            if now - self._last_reject_log_at >= 1:
                logging.warning(
                    "[CONTROL_REJECT] reason=%s packet_age_ms=%s max_age_ms=%s "
                    "max_future_skew_ms=%s (packet contents omitted)",
                    self.verifier.last_reject_reason, self.verifier.last_packet_age_ms,
                    self.verifier.max_age_ms, self.verifier.max_future_skew_ms,
                )
                self._last_reject_log_at = now
            self._queue_audit_event("command_rejected", "session command validation failed")
            return
        sequence = int(packet["sequence"])
        if packet["session_id"] != self._received_session_id:
            self._last_sequence = None
            self._received_session_id = packet["session_id"]
        if self._last_sequence is not None and sequence > self._last_sequence + 1:
            self.lost_count += sequence - self._last_sequence - 1
        self._last_sequence = sequence
        self.latencies.append(max(0, int(time.time() * 1000) - int(packet["timestamp_ms"])))
        command = resolve_command(packet["command"])
        original = packet["command"]
        kind = (original.get("mode"), original.get("action"), command["direction"],
                command["brake"] > 0, command.get("brake_mode"))
        now = time.monotonic()
        if kind != self._last_control_log_kind or now - self._last_control_log_at >= 1:
            logging.info(
                "[CONTROL_ACCEPT] seq=%s mode=%s action=%s steering=%.3f throttle=%.3f "
                "brake=%.3f direction=%s brake_mode=%s normalized=true",
                sequence, original.get("mode", "legacy"), original.get("action", "analog"),
                command["steering"], command["throttle"], command["brake"],
                command["direction"], command.get("brake_mode", "normal"),
            )
            self._last_control_log_at = now
            self._last_control_log_kind = kind
        if command.get("brake_mode") == "emergency":
            self._queue_audit_event("emergency_stop", "remote full brake command")
        self._normal_stop = False
        try:
            self._command_session_id = packet["session_id"]
            applied = await self.brake_controller.apply_control("remote", command)
            if applied is not False:
                self._normal_stop = (command.get("brake_mode") == "stop"
                                     or "vehicle_action" in command)
                self._published_session_id = packet["session_id"]
                self._published_sequence = sequence
                self._fault = None
                self._safety_reason = None
        except (RuntimeError, ValueError) as exc:
            self._fault = "control publication failed"
            logging.error("[CONTROL] command application failed: %s", exc)
            self._queue_audit_event("command_rejected", "actuator command application failed")
            await self._emergency_brake("command application failed")

    async def _emergency_brake(self, reason: str) -> None:
        self._normal_stop = False
        self._safety_reason = reason
        try:
            await self.brake_controller.emergency_brake(reason)
        except RuntimeError as exc:
            self._fault = "emergency publication failed"
            logging.error("[CONTROL] emergency publication failed: %s", exc)

    async def safety_watchdog(self, timeout_ms: int = 300, check_interval_ms: int = 50) -> None:
        while self.running:
            elapsed_ms = (time.monotonic() - self.verifier.last_valid_cmd_time) * 1000
            reason = None
            if self._command_session_id is not None and not self._owns_session():
                reason = "control session expired or revoked"
            elif self._command_session_id is not None and not self.connected:
                reason = "LiveKit connection lost"
            elif self._fault:
                reason = "control publication failed"
            elif self._command_session_id is not None and elapsed_ms > timeout_ms:
                maintain_stop = getattr(type(self.brake_controller), "maintain_stop", None)
                if self._normal_stop and maintain_stop is not None:
                    try:
                        await self.brake_controller.maintain_stop()
                    except RuntimeError:
                        reason = "normal stop feedback or publication failed"
                else:
                    reason = "remote command timeout"
            if self.control_enabled and reason:
                was_in_emergency = self.brake_controller.in_emergency
                await self._emergency_brake(reason)
                if not was_in_emergency and self.brake_controller.in_emergency:
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
