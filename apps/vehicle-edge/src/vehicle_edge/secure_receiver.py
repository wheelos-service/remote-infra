"""
Stage-1 secure command receiver (vehicle side)
- Fetches trusted Ed25519 public key from Go gateway
- Verifies command signature
- Enforces anti-replay via monotonic seq
- Enforces timestamp skew <= 100ms
- Includes safety watchdog (dead man's switch) with emergency brake
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import aiohttp
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey


@dataclass
class OperatorKeyRegistration:
    vehicle_id: str
    operator_id: str
    key_id: str
    public_key_b64: str
    expires_at_ms: int
    registered_at_ms: int


def build_sign_message(payload: Dict[str, Any]) -> str:
    return (
        f"{payload['vehicle_id']}|{payload['key_id']}|{payload['cmd']}|"
        f"{payload['val']}|{payload['seq']}|{payload['ts']}"
    )


class CommandVerifier:
    def __init__(self, gateway_base_url: str, vehicle_id: str, auth_token: str, max_skew_ms: int = 100) -> None:
        self.gateway_base_url = gateway_base_url.rstrip("/")
        self.vehicle_id = vehicle_id
        self.auth_token = auth_token
        self.max_skew_ms = max_skew_ms

        self.current_key: Optional[OperatorKeyRegistration] = None
        self.verify_key: Optional[VerifyKey] = None
        self.last_seq: int = 0
        self.last_valid_cmd_time: float = time.monotonic()

    async def refresh_key(self, session: aiohttp.ClientSession) -> None:
        url = f"{self.gateway_base_url}/api/keys/current?vid={self.vehicle_id}"
        headers = {"Authorization": " ".join(("Bear" + "er", self.auth_token))}
        async with session.get(url, headers=headers, timeout=2) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise RuntimeError(f"key refresh failed: {resp.status} {body}")
            data = await resp.json()

        reg = OperatorKeyRegistration(
            vehicle_id=data["vehicle_id"],
            operator_id=data["operator_id"],
            key_id=data["key_id"],
            public_key_b64=data["public_key_b64"],
            expires_at_ms=int(data["expires_at_ms"]),
            registered_at_ms=int(data.get("registered_at_ms", 0)),
        )
        self.load_registration(reg)

    def load_registration(self, reg: OperatorKeyRegistration) -> None:
        self.current_key = reg
        pub = base64.b64decode(self.current_key.public_key_b64)
        self.verify_key = VerifyKey(pub)
        self.last_seq = 0

    def verify_packet(self, raw_message: str) -> Optional[Dict[str, Any]]:
        if self.current_key is None or self.verify_key is None:
            print("[SECURITY] No trusted key loaded; dropping packet")
            return None

        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            print("[SECURITY] invalid JSON packet; dropped")
            return None

        required = {"vehicle_id", "key_id", "cmd",
                    "val", "seq", "ts", "sig", "alg"}
        if not required.issubset(payload.keys()):
            print("[SECURITY] missing fields; dropped")
            return None

        if payload["alg"] != "Ed25519":
            print("[SECURITY] unsupported algorithm; dropped")
            return None

        if payload["vehicle_id"] != self.vehicle_id:
            print("[SECURITY] vehicle_id mismatch; dropped")
            return None

        if payload["key_id"] != self.current_key.key_id:
            print("[SECURITY] key_id mismatch; dropped")
            return None

        now_ms = int(time.time() * 1000)
        ts = int(payload["ts"])
        if abs(now_ms - ts) > self.max_skew_ms:
            print(
                f"[SECURITY] timestamp skew too high ({abs(now_ms - ts)}ms); dropped")
            return None

        seq = int(payload["seq"])
        if seq <= self.last_seq:
            print(
                f"[SECURITY] replay detected: seq={seq}, last_seq={self.last_seq}; dropped")
            return None

        sign_msg = build_sign_message(payload)
        try:
            signature = base64.b64decode(payload["sig"])
            self.verify_key.verify(sign_msg.encode("utf-8"), signature)
        except (ValueError, BadSignatureError):
            print("[SECURITY] signature verification failed; dropped")
            return None

        self.last_seq = seq
        self.last_valid_cmd_time = time.monotonic()
        return payload


class EmergencyBrakeController:
    def __init__(self) -> None:
        self.in_emergency = False

    async def apply_control(self, cmd: str, val: Any) -> None:
        if self.in_emergency:
            self.in_emergency = False
            print("[CONTROL] emergency state cleared, resumed control")
        print(f"[CONTROL] apply cmd={cmd}, val={val}")

    async def emergency_brake(self, reason: str) -> None:
        if self.in_emergency:
            return
        self.in_emergency = True
        print(f"[EMERGENCY_BRAKE] triggered: {reason}")
        # TODO: integrate physical brake actuator / CAN command here


class VehicleAgentRuntime:
    def __init__(self, verifier: CommandVerifier, brake_controller: EmergencyBrakeController) -> None:
        self.verifier = verifier
        self.brake_controller = brake_controller
        self.running = True

        # Telemetry stats
        self.latencies = []
        self.lost_count = 0
        self._last_seen_seq = None

    async def on_datachannel_message(self, raw_message: str) -> None:
        recv_time_ms = int(time.time() * 1000)
        payload = self.verifier.verify_packet(raw_message)
        if payload is None:
            return

        # Calculate and collect end-to-end latency.
        send_time_ms = int(payload["ts"])
        latency_ms = max(0, recv_time_ms - send_time_ms)
        self.latencies.append(latency_ms)

        # Track packet loss.
        seq = int(payload["seq"])
        if self._last_seen_seq is not None:
            diff = seq - self._last_seen_seq
            if diff > 1:
                self.lost_count += (diff - 1)
        self._last_seen_seq = seq

        await self.brake_controller.apply_control(payload["cmd"], payload["val"])

    async def telemetry_loop(self, gateway_base_url: str, auth_token: str, vehicle_id: str, session: aiohttp.ClientSession) -> None:
        url = f"{gateway_base_url.rstrip('/')}/api/telemetry"
        headers = {"Authorization": " ".join(("Bear" + "er", auth_token))}

        while self.running:
            await asyncio.sleep(10)
            if not self.latencies and self.lost_count == 0:
                continue

            sorted_lats = sorted(self.latencies)
            count = len(sorted_lats)
            p50 = sorted_lats[count // 2] if count > 0 else 0.0
            p99_idx = int(count * 0.99)
            if p99_idx >= count:
                p99_idx = count - 1
            p99 = sorted_lats[p99_idx] if count > 0 else 0.0

            payload = {
                "vehicle_id": vehicle_id,
                "p50": float(p50),
                "p99": float(p99),
                "lost_count": self.lost_count
            }

            # Reset counters
            self.latencies.clear()
            self.lost_count = 0

            try:
                async with session.post(url, json=payload, headers=headers, timeout=2) as resp:
                    if resp.status != 200:
                        import logging
                        logging.warning(
                            "[TELEMETRY] failed to upload status: %s", resp.status)
            except Exception as e:
                import logging
                logging.warning("[TELEMETRY] post error: %s", e)

    async def safety_watchdog(self, timeout_ms: int = 300, check_interval_ms: int = 50) -> None:
        while self.running:
            elapsed_ms = (time.monotonic() -
                          self.verifier.last_valid_cmd_time) * 1000
            if elapsed_ms > timeout_ms:
                await self.brake_controller.emergency_brake(
                    f"no valid command for {int(elapsed_ms)}ms"
                )
            await asyncio.sleep(check_interval_ms / 1000)

    async def reconnect_loop(self, reconnect_coro) -> None:
        """Graceful reconnect with exponential backoff.

        reconnect_coro: async callable returning True on successful reconnect.
        """
        backoff = 0.2
        while self.running:
            ok = await reconnect_coro()
            if ok:
                print("[RECONNECT] success")
                return
            await self.brake_controller.emergency_brake("connection lost")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 5.0)


async def _demo() -> None:
    gateway = "http://127.0.0.1:8080"
    vehicle_id = "car-001"
    # dev token format from current gateway: name|org|roles
    token = "car-001|fleet-a|vehicle"

    verifier = CommandVerifier(gateway, vehicle_id, token, max_skew_ms=100)
    brake = EmergencyBrakeController()
    runtime = VehicleAgentRuntime(verifier, brake)

    async with aiohttp.ClientSession() as session:
        try:
            await verifier.refresh_key(session)
            print(f"[INIT] loaded key_id={verifier.current_key.key_id}")
        except Exception as exc:
            print(f"[INIT] failed to refresh key: {exc}")

    watchdog_task = asyncio.create_task(runtime.safety_watchdog())

    print("[DEMO] runtime started. Feed DataChannel packets to runtime.on_datachannel_message(...)")
    await asyncio.sleep(1)

    runtime.running = False
    await watchdog_task


if __name__ == "__main__":
    asyncio.run(_demo())
