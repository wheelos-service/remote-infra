import asyncio
import base64
import json
import logging
import os
import sys
import time
from typing import Optional
import aiohttp
VEHICLE_EDGE = os.path.join(os.path.dirname(__file__), "..", "apps", "vehicle-edge")
VEHICLE_SRC = os.path.abspath(os.path.join(VEHICLE_EDGE, "src"))
if VEHICLE_SRC not in sys.path:
    sys.path.insert(0, VEHICLE_SRC)

from vehicle_edge.control_protocol import CONTROL_TYPE, PROTOCOL_VERSION, build_sign_message
from vehicle_edge.control_session_receiver import SessionCommandVerifier, SessionVehicleRuntime
from vehicle_edge.secure_receiver import EmergencyBrakeController

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


async def acquire_control(session: aiohttp.ClientSession, public_key_b64: str) -> dict:
    auth = "op-001|fleet-a|admin"
    url = "http://127.0.0.1:8080/api/vehicles/car-001/control/acquire"
    async with session.post(url, headers={"Authorization": f"Bearer {auth}"}, json={"public_key_b64": public_key_b64}) as resp:
        text = await resp.text()
        if resp.status != 200:
            raise RuntimeError(f"control acquire failed: {resp.status} {text}")
        return await resp.json()


async def renew_control(session: aiohttp.ClientSession, session_id: str) -> None:
    auth = "op-001|fleet-a|admin"
    url = f"http://127.0.0.1:8080/api/control/{session_id}/renew"
    while True:
        await asyncio.sleep(2)
        async with session.post(url, headers={"Authorization": f"Bearer {auth}"}) as resp:
            if resp.status != 200:
                raise RuntimeError(f"control renew failed: {resp.status} {await resp.text()}")


async def refresh_session(verifier: SessionCommandVerifier, session: aiohttp.ClientSession) -> None:
    while True:
        await verifier.refresh_session(session)
        await asyncio.sleep(1)


async def main():
    # 1. Start session & Get tokens
    async with aiohttp.ClientSession() as session:
        vehicle_token = await get_token(session, "vehicle")
        signing_key = SigningKey.generate()
        control = await acquire_control(
            session, base64.b64encode(bytes(signing_key.verify_key)).decode("utf-8"))
        operator_token = control["token"]

        verifier = SessionCommandVerifier(
            "http://127.0.0.1:8080", "car-001", "car-001|fleet-a|vehicle", max_age_ms=500, max_future_skew_ms=500)
        await verifier.refresh_session(session)

        brake = EmergencyBrakeController()
        runtime = SessionVehicleRuntime(verifier, brake)
        watchdog_task = asyncio.create_task(
            runtime.safety_watchdog(timeout_ms=500, check_interval_ms=50))
        renew_task = asyncio.create_task(
            renew_control(session, control["session"]["session_id"]))
        refresh_task = asyncio.create_task(refresh_session(verifier, session))

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
            participant = args[1] if len(args) > 1 else None
            identity = str(getattr(participant, "identity", ""))
            asyncio.create_task(runtime.on_datachannel_message(raw, identity))
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
        verifier.last_valid_cmd_time = time.monotonic()
        brake.in_emergency = False

        num_commands = 1000
        logging.info(f"Sending {num_commands} commands...")
        for seq in range(1, num_commands + 1):
            payload = {
            "version": PROTOCOL_VERSION,
            "type": CONTROL_TYPE,
            "session_id": verifier.session.session_id,
            "sequence": seq,
            "timestamp_ms": int(time.time() * 1000),
            "command": {"steering": 0.123, "throttle": 0.0, "brake": 0.0},
            }
            signature = signing_key.sign(build_sign_message(payload).encode("utf-8")).signature
            payload["signature"] = base64.b64encode(signature).decode("utf-8")

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
        for task in (watchdog_task, renew_task, refresh_task):
            task.cancel()
        await asyncio.gather(watchdog_task, renew_task, refresh_task, return_exceptions=True)

        # wait a bit for last packets
        await asyncio.sleep(2)

        # 6. Assertions
        await asyncio.gather(vehicle_room.disconnect(), operator_room.disconnect(), return_exceptions=True)

        success_ratio = received_count / num_commands
        logging.info(
            f"E2E QoS Test complete. Success ratio: {success_ratio*100:.2f}% (Loss approx: {(1-success_ratio)*100:.2f}%)")

        assert not brake.in_emergency, "Must not trigger false positive emergency brakes"
        assert success_ratio > 0.90, f"Success ratio too low: {success_ratio} <= 0.90"

        logging.info("ALL ASSERTIONS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
