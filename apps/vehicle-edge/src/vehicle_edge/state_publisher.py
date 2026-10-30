"""Rate-limited wire snapshots; no Cyber or LiveKit lifecycle management."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
import uuid
from typing import Any, Awaitable, Callable

STATE_TOPIC = "vehicle.state"

_LOCALIZATION_FIELDS = ("header", "measurement_time", "pose")
_POSE_FIELDS = ("position", "orientation", "heading", "linear_velocity")
_CHASSIS_FIELDS = (
    "header", "speed_mps", "gear_location", "driving_mode", "error_code",
    "chassis_error_mask", "throttle_percentage", "brake_percentage",
    "steering_percentage", "parking_brake", "battery_soc_percentage",
)


def _finite_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _finite_json(item) for key, item in value.items()}
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, str) and value in ("NaN", "Infinity", "-Infinity"):
        return None
    return value


def _summary(message: Any, kind: str) -> dict[str, Any]:
    from google.protobuf.json_format import MessageToDict

    fields = _LOCALIZATION_FIELDS if kind == "localization" else _CHASSIS_FIELDS
    selected = type(message)()
    for field in fields:
        if not message.HasField(field):
            continue
        value = getattr(message, field)
        if field == "pose":
            for name in _POSE_FIELDS:
                if value.HasField(name):
                    target = getattr(selected.pose, name)
                    if name == "heading":
                        selected.pose.heading = value.heading
                    else:
                        target.CopyFrom(getattr(value, name))
        elif field == "header":
            selected.header.CopyFrom(value)
        else:
            setattr(selected, field, value)
    return _finite_json(MessageToDict(selected, preserving_proto_field_name=True))


class StatePublisher:
    def __init__(self, source: Any, control_status: Callable[[], dict[str, Any]], vehicle_id: str) -> None:
        self.source = source
        self.control_status = control_status
        self.vehicle_id = vehicle_id
        self.stream_id = uuid.uuid4().hex
        self.sequence = 0

    def packet(self) -> dict[str, Any]:
        self.sequence += 1
        samples = self.source.snapshot()
        packet: dict[str, Any] = {
            "version": 1, "type": "vehicle_state", "vehicle_id": self.vehicle_id,
            "stream_id": self.stream_id, "sequence": self.sequence,
            "timestamp_ms": int(time.time() * 1000), "control": self.control_status(),
        }
        for kind in ("localization", "chassis"):
            sample = samples.get(kind)
            packet[kind] = {
                "received_at_ms": sample.received_at_ms if sample else None,
                "age_ms": sample.age_ms if sample else None,
                "stale": sample is None or sample.age_ms > 1000,
                "message": _summary(sample.message, kind) if sample else None,
            }
        return packet

    async def run(self, send: Callable[[bytes, str], Awaitable[None]]) -> None:
        last_log_at = float("-inf")
        logging.info("[STATE] publisher started topic=%s rate_hz=5", STATE_TOPIC)
        while True:
            started = time.monotonic()
            try:
                packet = self.packet()
                payload = json.dumps(packet, allow_nan=False, separators=(",", ":")).encode()
                await asyncio.wait_for(send(payload, STATE_TOPIC), timeout=0.15)
                if started - last_log_at >= 30:
                    logging.info(
                        "[STATE] published topic=%s sequence=%s bytes=%s "
                        "localization_stale=%s chassis_stale=%s receiver_ack=false",
                        STATE_TOPIC, packet["sequence"], len(payload),
                        packet["localization"]["stale"], packet["chassis"]["stale"],
                    )
                    last_log_at = started
            except (asyncio.TimeoutError, ConnectionError) as exc:
                logging.warning(
                    "[STATE] dropped snapshot: transport unavailable error_type=%s cause_type=%s",
                    type(exc).__name__, type(exc.__cause__).__name__ if exc.__cause__ else "none",
                )
            except Exception as exc:
                logging.error("[STATE] snapshot failed error_type=%s", type(exc).__name__)
                raise
            await asyncio.sleep(max(0, 0.2 - (time.monotonic() - started)))
