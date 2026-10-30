from vehicle_edge.control_protocol import (
    HIGH_LEVEL_MODE,
    LOW_LEVEL_MODE,
    resolve_command,
    valid_command,
    VEHICLE_ACTIONS,
    build_sign_message,
)


def test_high_level_commands_are_valid_and_resolved() -> None:
    command = {"mode": HIGH_LEVEL_MODE, "action": "reverse"}

    assert valid_command(command)
    assert resolve_command(command) == {
        "steering": 0.0,
        "throttle": 1.0,
        "brake": 0.0,
        "direction": -1.0,
    }


def test_low_level_commands_require_explicit_direction() -> None:
    command = {
        "mode": LOW_LEVEL_MODE,
        "steering": 0.25,
        "throttle": 0.5,
        "brake": 0.0,
        "direction": 1,
    }

    assert valid_command(command)
    assert resolve_command(command)["steering"] == 0.25


def test_unknown_high_level_action_is_rejected() -> None:
    assert not valid_command({"mode": HIGH_LEVEL_MODE, "action": "spin"})


def test_vehicle_actions_are_signed_and_resolved_without_propulsion() -> None:
    for action in VEHICLE_ACTIONS:
        command = {"mode": HIGH_LEVEL_MODE, "action": action}
        assert valid_command(command)
        resolved = resolve_command(command)
        assert resolved["vehicle_action"] == action
        assert resolved["throttle"] == 0
        assert resolved["direction"] == 0
        assert not valid_command({**command, "gear": "GEAR_DRIVE"})
        assert not valid_command({**command, "vehicle_action": action})
        packet = dict(version=1, type="control", session_id="s", sequence=1,
                      timestamp_ms=123, command=command)
        assert build_sign_message(packet) == f"1|control|s|1|123|high_level|{action}"


def test_stop_and_emergency_are_distinct_internal_intents() -> None:
    for action, brake_mode in (("stop", "stop"), ("emergency_stop", "emergency")):
        command = resolve_command({"mode": HIGH_LEVEL_MODE, "action": action})
        assert command["brake_mode"] == brake_mode
        assert command["direction"] == 0
    for action in ("left", "right"):
        assert resolve_command({"mode": HIGH_LEVEL_MODE, "action": action})["direction"] == 0
    # This internal metadata cannot be supplied as a signed wire command.
    assert not valid_command({"mode": HIGH_LEVEL_MODE, "action": "stop", "brake_mode": "stop"})
