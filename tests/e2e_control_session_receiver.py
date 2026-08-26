import base64
import asyncio
import json
import os
import sys
import time

from nacl.signing import SigningKey

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
AGENT_SRC = os.path.abspath(os.path.join(CURRENT_DIR, "..", "apps", "vehicle-edge", "src"))
if AGENT_SRC not in sys.path:
    sys.path.insert(0, AGENT_SRC)

from vehicle_edge.control_protocol import CONTROL_TYPE, PROTOCOL_VERSION, build_sign_message
from vehicle_edge.control_session_receiver import ActiveControlSession, SessionCommandVerifier, SessionVehicleRuntime
from vehicle_edge.secure_receiver import EmergencyBrakeController

def make_verifier(signing_key: SigningKey, expires_at_ms: int | None = None) -> SessionCommandVerifier:
    verifier = SessionCommandVerifier("http://gateway", "vehicle-001", "vehicle-token")
    verifier.session = ActiveControlSession(
        session_id="session-001",
        vehicle_id="vehicle-001",
        operator_id="operator-001",
        public_key_b64=base64.b64encode(bytes(signing_key.verify_key)).decode(),
        status="ACTIVE",
        expires_at_ms=expires_at_ms or int(time.time() * 1000) + 5_000,
    )
    verifier.verify_key = signing_key.verify_key
    return verifier


def make_packet(signing_key: SigningKey, sequence: int, session_id: str = "session-001", timestamp_ms: int | None = None) -> str:
    packet = {
        "version": PROTOCOL_VERSION,
        "type": CONTROL_TYPE,
        "session_id": session_id,
        "sequence": sequence,
        "timestamp_ms": timestamp_ms or int(time.time() * 1000),
        "command": {"steering": 0.2, "throttle": 0.1, "brake": 0.0},
    }
    packet["signature"] = base64.b64encode(signing_key.sign(build_sign_message(packet).encode()).signature).decode()
    return json.dumps(packet)


class FakeResponse:
    status = 200

    def __init__(self, session: ActiveControlSession) -> None:
        self.session = session

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args) -> None:
        return None

    async def text(self) -> str:
        return ""

    async def json(self) -> dict:
        return {"session": self.session.__dict__}


class FakeHTTPSession:
    def __init__(self, session: ActiveControlSession) -> None:
        self.session = session

    def get(self, *args, **kwargs) -> FakeResponse:
        return FakeResponse(self.session)


async def main() -> None:
    signing_key = SigningKey.generate()
    verifier = make_verifier(signing_key)
    valid = make_packet(signing_key, 1)
    assert verifier.verify_packet(valid, "operator-operator-001") is not None
    assert verifier.verify_packet(valid, "operator-operator-001") is None
    assert verifier.verify_packet(make_packet(signing_key, 2), "operator-other") is None
    assert verifier.verify_packet(make_packet(signing_key, 3, "session-old"), "operator-operator-001") is None
    assert verifier.verify_packet(make_packet(SigningKey.generate(), 4), "operator-operator-001") is None
    assert verifier.verify_packet(
        make_packet(signing_key, 4, timestamp_ms=int(time.time() * 1000) - 1_000),
        "operator-operator-001",
    ) is None

    await verifier.refresh_session(FakeHTTPSession(verifier.session))
    assert verifier.verify_packet(make_packet(signing_key, 1), "operator-operator-001") is None
    assert verifier.verify_packet(make_packet(signing_key, 2), "operator-operator-001") is not None

    expired = make_verifier(signing_key, int(time.time() * 1000) - 1)
    assert expired.verify_packet(make_packet(signing_key, 1), "operator-operator-001") is None

    brake = EmergencyBrakeController()
    runtime = SessionVehicleRuntime(make_verifier(signing_key), brake)
    watchdog = asyncio.create_task(runtime.safety_watchdog(timeout_ms=20, check_interval_ms=5))
    await await_watchdog(runtime, watchdog)
    print("[E2E] control session verifier passed")


async def await_watchdog(runtime: SessionVehicleRuntime, watchdog: asyncio.Task) -> None:
    await asyncio.sleep(30 / 1000)
    runtime.running = False
    await watchdog
    assert runtime.brake_controller.in_emergency is True


if __name__ == "__main__":
    asyncio.run(main())
