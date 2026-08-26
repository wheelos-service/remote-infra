from vehicle_edge.control_protocol import (
    HIGH_LEVEL_MODE,
    LOW_LEVEL_MODE,
    resolve_command,
    valid_command,
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
