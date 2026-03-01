from secure_receiver import (
    CommandVerifier,
    EmergencyBrakeController,
    OperatorKeyRegistration,
    VehicleAgentRuntime,
    build_sign_message,
)
import asyncio
import base64
import json
import os
import sys
import time
from dataclasses import asdict

from nacl.signing import SigningKey

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
if AGENT_DIR not in sys.path:
    sys.path.insert(0, AGENT_DIR)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("utf-8")


def make_signed_packet(signing_key: SigningKey, *, vehicle_id: str, key_id: str, cmd: str, val, seq: int, ts: int):
    payload = {
        "vehicle_id": vehicle_id,
        "key_id": key_id,
        "cmd": cmd,
        "val": val,
        "seq": seq,
        "ts": ts,
    }
    msg = build_sign_message(payload)
    sig = signing_key.sign(msg.encode("utf-8")).signature
    packet = {
        **payload,
        "sig": b64(sig),
        "alg": "Ed25519",
    }
    return packet


async def test_forged_signature() -> None:
    vehicle_id = "car-001"
    auth_token = "car-001|fleet-a|vehicle"

    trusted_signing_key = SigningKey.generate()
    trusted_verify_key = trusted_signing_key.verify_key

    reg = OperatorKeyRegistration(
        vehicle_id=vehicle_id,
        operator_id="driver-105",
        key_id="kid-1",
        public_key_b64=b64(bytes(trusted_verify_key)),
        expires_at_ms=int(time.time() * 1000) + 3600_000,
        registered_at_ms=int(time.time() * 1000),
    )

    verifier = CommandVerifier("http://127.0.0.1:8080", vehicle_id, auth_token)
    verifier.load_registration(reg)

    # forged packet is signed by attacker key, not trusted key
    attacker_key = SigningKey.generate()
    forged_packet = make_signed_packet(
        attacker_key,
        vehicle_id=vehicle_id,
        key_id=reg.key_id,
        cmd="steer",
        val=10,
        seq=1,
        ts=int(time.time() * 1000),
    )

    result = verifier.verify_packet(json.dumps(forged_packet))
    assert result is None, "forged signature must be rejected"


async def test_replay_attack() -> None:
    vehicle_id = "car-001"
    auth_token = "car-001|fleet-a|vehicle"

    signing_key = SigningKey.generate()
    verify_key = signing_key.verify_key

    reg = OperatorKeyRegistration(
        vehicle_id=vehicle_id,
        operator_id="driver-105",
        key_id="kid-2",
        public_key_b64=b64(bytes(verify_key)),
        expires_at_ms=int(time.time() * 1000) + 3600_000,
        registered_at_ms=int(time.time() * 1000),
    )

    verifier = CommandVerifier("http://127.0.0.1:8080", vehicle_id, auth_token)
    verifier.load_registration(reg)

    packet = make_signed_packet(
        signing_key,
        vehicle_id=vehicle_id,
        key_id=reg.key_id,
        cmd="steer",
        val=20,
        seq=5,
        ts=int(time.time() * 1000),
    )
    packet_json = json.dumps(packet)

    first = verifier.verify_packet(packet_json)
    assert first is not None, "first valid packet should pass"

    replay = verifier.verify_packet(packet_json)
    assert replay is None, "replay packet must be rejected"


async def test_watchdog_emergency_brake() -> None:
    vehicle_id = "car-001"
    auth_token = "car-001|fleet-a|vehicle"

    signing_key = SigningKey.generate()
    verify_key = signing_key.verify_key

    reg = OperatorKeyRegistration(
        vehicle_id=vehicle_id,
        operator_id="driver-105",
        key_id="kid-3",
        public_key_b64=b64(bytes(verify_key)),
        expires_at_ms=int(time.time() * 1000) + 3600_000,
        registered_at_ms=int(time.time() * 1000),
    )

    verifier = CommandVerifier("http://127.0.0.1:8080", vehicle_id, auth_token)
    verifier.load_registration(reg)

    brake = EmergencyBrakeController()
    runtime = VehicleAgentRuntime(verifier, brake)

    # feed one valid command
    packet = make_signed_packet(
        signing_key,
        vehicle_id=vehicle_id,
        key_id=reg.key_id,
        cmd="steer",
        val=30,
        seq=1,
        ts=int(time.time() * 1000),
    )
    await runtime.on_datachannel_message(json.dumps(packet))

    # start watchdog and wait beyond timeout to trigger emergency
    task = asyncio.create_task(runtime.safety_watchdog(
        timeout_ms=300, check_interval_ms=50))
    await asyncio.sleep(0.45)
    runtime.running = False
    await task

    assert brake.in_emergency is True, "watchdog must trigger emergency brake after timeout"


async def main() -> None:
    print("[E2E] test_forged_signature")
    await test_forged_signature()
    print("[E2E] passed: forged signature rejected")

    print("[E2E] test_replay_attack")
    await test_replay_attack()
    print("[E2E] passed: replay rejected")

    print("[E2E] test_watchdog_emergency_brake")
    await test_watchdog_emergency_brake()
    print("[E2E] passed: watchdog triggered emergency brake")

    print("[E2E] all tests passed")


if __name__ == "__main__":
    asyncio.run(main())
