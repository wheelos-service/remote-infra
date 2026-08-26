"""Versioned, signed remote-control packet protocol."""

from __future__ import annotations

from typing import Any, Mapping

PROTOCOL_VERSION = 1
CONTROL_TYPE = "control"
HIGH_LEVEL_MODE = "high_level"
LOW_LEVEL_MODE = "low_level"
HIGH_LEVEL_ACTIONS = frozenset({"forward", "reverse", "left", "right", "stop", "emergency_stop"})


def build_sign_message(packet: Mapping[str, Any]) -> str:
    command = packet["command"]
    fields = [
        str(packet["version"]),
        str(packet["type"]),
        str(packet["session_id"]),
        str(packet["sequence"]),
        str(packet["timestamp_ms"]),
    ]
    if command.get("mode") == HIGH_LEVEL_MODE:
        fields.extend((HIGH_LEVEL_MODE, str(command["action"])))
    elif command.get("mode") == LOW_LEVEL_MODE:
        fields.extend((
            LOW_LEVEL_MODE,
            str(command["steering"]),
            str(command["throttle"]),
            str(command["brake"]),
            str(command.get("direction", 1)),
        ))
    else:
        fields.extend((
            str(command["steering"]),
            str(command["throttle"]),
            str(command["brake"]),
        ))
    return "|".join(fields)


def valid_command(command: Any) -> bool:
    if not isinstance(command, dict):
        return False
    if command.get("mode") == HIGH_LEVEL_MODE:
        return set(command) == {"mode", "action"} and command["action"] in HIGH_LEVEL_ACTIONS
    if command.get("mode") == LOW_LEVEL_MODE:
        if set(command) != {"mode", "steering", "throttle", "brake", "direction"}:
            return False
        direction = command["direction"]
    elif set(command) == {"steering", "throttle", "brake"}:
        direction = 1
    else:
        return False
    try:
        steering = float(command["steering"])
        throttle = float(command["throttle"])
        brake = float(command["brake"])
        direction = int(direction)
    except (TypeError, ValueError):
        return False
    return -1 <= steering <= 1 and 0 <= throttle <= 1 and 0 <= brake <= 1 and direction in {-1, 0, 1}


def resolve_command(command: Mapping[str, Any]) -> dict[str, float]:
    """Map a high-level intent or low-level command to actuator values."""
    if command.get("mode") == HIGH_LEVEL_MODE:
        action = command["action"]
        if action == "forward":
            return {"steering": 0.0, "throttle": 1.0, "brake": 0.0, "direction": 1.0}
        if action == "reverse":
            return {"steering": 0.0, "throttle": 1.0, "brake": 0.0, "direction": -1.0}
        if action == "left":
            return {"steering": -1.0, "throttle": 0.0, "brake": 0.0, "direction": 1.0}
        if action == "right":
            return {"steering": 1.0, "throttle": 0.0, "brake": 0.0, "direction": 1.0}
        return {"steering": 0.0, "throttle": 0.0, "brake": 1.0, "direction": 0.0}
    return {
        "steering": float(command["steering"]),
        "throttle": float(command["throttle"]),
        "brake": float(command["brake"]),
        "direction": float(command.get("direction", 1)),
    }
