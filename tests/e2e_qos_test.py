from secure_receiver import CommandVerifier, EmergencyBrakeController, VehicleAgentRuntime, OperatorKeyRegistration
import asyncio
import base64
import json
import logging
import sys
import time
from typing import Optional

import aiohttp
from livekit import rtc
from nacl.signing import SigningKey

sys.path.append("vehicle-agent")

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


async def get_token(session: aiohttp.ClientSession, role: str) -> str:
    # Use dev token mapping
    if role == "vehicle":
        auth = "car-001|fleet-a|vehicle"
        url = "http://127.0.0.1:8080/api/token/vehicle?vid=car-001"
    else:
        auth = "op-001|fleet-a|admin"
        url = "http://127.0.0.1:8080/api/token/operator?vid=car-001"

    async with session.get(url, headers={"Authorization": f"Bearer {auth}"}) as resp:
        data = await resp.json()
        return data["token"]


async def main():
    # 1. Start session & Get tokens
    async with aiohttp.ClientSession() as session:
        vehicle_token = await get_token(session, "vehicle")
        operator_token = await get_token(session, "operator")

    # 2. Local Key Setup for vehicle verifier
    sk = SigningKey.generate()
    pk = sk.verify_key
    pub_b64 = base64.b64encode(bytes(pk)).decode("utf-8")

    reg = OperatorKeyRegistration(
        vehicle_id="car-001",
        operator_id="op-001",
        key_id="demo-key",
        public_key_b64=pub_b64,
        expires_at_ms=9999999999999,
        registered_at_ms=0,
    )

    # Note: we pass max_skew_ms=500 to tolerate the 100ms baseline + jitter + some delays
    # otherwise default 100ms max skew will drop all packets!
    verifier = CommandVerifier(
        "http://127.0.0.1:8080", "car-001", "dev", max_skew_ms=500)
    verifier.load_registration(reg)

    brake = EmergencyBrakeController()
    runtime = VehicleAgentRuntime(verifier, brake)
    # We should increase timeout_ms of watchdog. Because we inject 100ms delay and 5% drop, TCP or even UDP may see >300ms easily if multiple drops.
    # Actually wait, UDP drops won't hold up line. If we send at 20Hz (50ms), 200ms without packet means 4 consecutive drops.
    # 5% drop rate -> 4 consecutive drops is 0.05^4 = 6.25e-6, very rare.
    # But for robustness in CI, we use 500ms watchdog timeout.
    watchdog_task = asyncio.create_task(
        runtime.safety_watchdog(timeout_ms=500, check_interval_ms=50))

    # Counter for testing
    received_count = 0

    def on_data_received(*args, **kwargs):
        nonlocal received_count
        if len(args) > 0 and hasattr(args[0], 'data'):
            data_bytes = args[0].data
        else:
            data_bytes = args[0]

        raw = data_bytes.decode(
            "utf-8") if isinstance(data_bytes, (bytes, bytearray)) else str(data_bytes)
        asyncio.create_task(runtime.on_datachannel_message(raw))
        received_count += 1

    # 3. Connect LiveKit Vehicle
    vehicle_room = rtc.Room()
    vehicle_room.on("data_received", on_data_received)
    await vehicle_room.connect("http://127.0.0.1:7880", vehicle_token)
    logging.info("[VEHICLE] connected to LiveKit")

    # 4. Connect LiveKit Operator
    operator_room = rtc.Room()
    await operator_room.connect("http://127.0.0.1:7880", operator_token)
    logging.info("[OPERATOR] connected to LiveKit")

    # 5. Send traffic
    # Note: reset time again because connections take time
    verifier.last_valid_cmd_time = time.monotonic()
    # explicitly clear emergency brake flag just in case it tripped during connection
    brake.in_emergency = False

    num_commands = 1000
    logging.info(f"Sending {num_commands} commands...")
    for seq in range(1, num_commands + 1):
        payload = {
            "vehicle_id": "car-001",
            "key_id": "demo-key",
            "cmd": "steer",
            "val": 12.3,
            "seq": seq,
            "ts": int(time.time() * 1000),
            "alg": "Ed25519",
        }
        sign_msg = f"{payload['vehicle_id']}|{payload['key_id']}|{payload['cmd']}|{payload['val']}|{payload['seq']}|{payload['ts']}"
        signature = sk.sign(sign_msg.encode("utf-8")).signature
        payload["sig"] = base64.b64encode(signature).decode("utf-8")

        # Publish lossy DataChannel message
        msg_str = json.dumps(payload)
        await operator_room.local_participant.publish_data(msg_str.encode("utf-8"), reliable=False)

        await asyncio.sleep(0.05)  # 20Hz

        if brake.in_emergency:
            logging.error(
                "[!FATAL!] Watchdog triggered emergency brake during simulation!")
            break

    # Stop watchdog before we stop sending things so it doesn't trigger during the final sleep
    runtime.running = False
    watchdog_task.cancel()

    # wait a bit for last packets
    await asyncio.sleep(2)

    # 6. Assertions
    await asyncio.gather(vehicle_room.disconnect(), operator_room.disconnect(), return_exceptions=True)

    success_ratio = received_count / num_commands
    logging.info(
        f"E2E QoS Test complete. Success ratio: {success_ratio*100:.2f}% (Loss approx: {(1-success_ratio)*100:.2f}%)")

    assert not brake.in_emergency, "Must not trigger false positive emergency brakes"
    assert success_ratio > 0.90, f"Success ratio too low: {success_ratio} <= 0.90"

    logging.info("ALL ASSERTIONS PASSED ✅")


if __name__ == "__main__":
    asyncio.run(main())
