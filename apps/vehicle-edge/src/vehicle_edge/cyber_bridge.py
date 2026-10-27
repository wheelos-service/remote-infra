"""WheelOS Cyber monitoring and remote-control adapter."""

from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CyberOptions:
    enabled: bool = False
    control_enabled: bool = False
    node_name: str = "teleop_vehicle"
    localization_channel: str = "/apollo/localization/pose"
    chassis_channel: str = "/apollo/canbus/chassis"
    control_channel: str = "/apollo/control"


@dataclass(frozen=True)
class CyberSample:
    message: Any
    received_at_ms: int
    age_ms: int


class CyberBridge:
    def __init__(self, options: CyberOptions) -> None:
        self.options = options
        self.in_emergency = False
        self._armed = False
        self._sequence = 0
        self._lock = threading.Lock()
        self._samples: dict[str, tuple[Any, float, int]] = {}
        self._reported_gear: tuple[int, float] | None = None
        self._last_gear: int | None = None
        self._cyber: Any = None
        self._node: Any = None
        self._writer: Any = None
        self._readers: list[Any] = []

    def start(self) -> None:
        from cyber.python.cyber_py3 import cyber
        from wheelos_msgs.chassis_msgs.chassis_pb2 import Chassis
        from wheelos_msgs.control_msgs.control_cmd_pb2 import ControlCommand
        from wheelos_msgs.localization_msgs.localization_pb2 import LocalizationEstimate

        self._control_type = ControlCommand
        self._chassis_type = Chassis
        self._cyber = cyber
        try:
            if not cyber.init(self.options.node_name):
                raise RuntimeError("Cyber initialization failed")
            self._node = cyber.Node(self.options.node_name)
            for kind, channel, message_type in (
                ("localization", self.options.localization_channel, LocalizationEstimate),
                ("chassis", self.options.chassis_channel, Chassis),
            ):
                reader = self._node.create_reader(
                    channel, message_type, lambda message, kind=kind: self._receive(kind, message))
                if reader is None:
                    raise RuntimeError(f"Cyber reader creation failed: {channel}")
                self._readers.append(reader)
            if self.options.control_enabled:
                self._writer = self._node.create_writer(
                    self.options.control_channel, ControlCommand)
                if self._writer is None:
                    raise RuntimeError("Cyber control writer creation failed")
        except BaseException:
            self.close()
            raise

    def _receive(self, kind: str, message: Any) -> None:
        received = time.monotonic()
        with self._lock:
            self._samples[kind] = (message, received, int(time.time() * 1000))
            if (kind == "chassis" and message.HasField("gear_location")
                    and message.gear_location not in (
                        self._chassis_type.GEAR_INVALID, self._chassis_type.GEAR_NONE)):
                self._reported_gear = (message.gear_location, received)

    def snapshot(self) -> dict[str, CyberSample]:
        now = time.monotonic()
        with self._lock:
            samples = self._samples.copy()
        return {
            kind: CyberSample(message, received_at_ms, max(0, int((now - received) * 1000)))
            for kind, (message, received, received_at_ms) in samples.items()
        }

    def _publish(self, steering: float, throttle: float, brake: float, direction: int) -> None:
        if self._writer is None:
            raise RuntimeError("Cyber control writer is not available")
        message = self._control_type()
        self._sequence = (self._sequence + 1) & 0xFFFFFFFF
        message.header.timestamp_sec = time.time()
        message.header.module_name = self.options.node_name
        message.header.sequence_num = self._sequence
        # Console steering is negative-left; WheelOS is positive counterclockwise.
        message.steering_target = -steering * 100
        message.throttle = 0 if brake > 0 else throttle * 100
        message.brake = brake * 100
        if direction:
            gear = (
                self._chassis_type.GEAR_DRIVE if direction > 0 else self._chassis_type.GEAR_REVERSE)
        else:
            with self._lock:
                reported = self._reported_gear
            gear = reported[0] if reported and time.monotonic() - reported[1] <= 1 else self._last_gear
            if gear is None:
                raise RuntimeError("cannot hold gear before receiving chassis gear or a remote drive command")
        # Canbus reads gear even when absent; omission would select proto2 neutral.
        message.gear_location = gear
        self._last_gear = gear
        self._armed = True
        if not self._writer.write(message):
            raise RuntimeError("Cyber control publication failed")

    async def apply_control(self, cmd: str, val: Any) -> bool:
        if not self.options.control_enabled:
            return False
        if cmd != "remote" or not isinstance(val, dict):
            raise ValueError("Cyber accepts only verified, resolved remote commands")
        steering, throttle, brake, direction = (
            val["steering"], val["throttle"], val["brake"], val["direction"])
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool)
                   and math.isfinite(value) for value in (steering, throttle, brake, direction)):
            raise ValueError("non-finite Cyber command")
        if not (-1 <= steering <= 1 and 0 <= throttle <= 1 and 0 <= brake <= 1
                and direction in (-1, 0, 1)):
            raise ValueError("Cyber command outside normalized range")
        self._publish(steering, throttle, brake, int(direction))
        self.in_emergency = False
        return True

    async def emergency_brake(self, reason: str) -> None:
        # Monitoring autonomous driving must never arm the remote actuator.
        if not self.options.control_enabled or not self._armed:
            return
        if not self.in_emergency:
            logging.error("[CYBER] remote emergency stop: %s", reason)
        self.in_emergency = True
        self._publish(0, 0, 1, 0)

    def close(self) -> None:
        try:
            if self._armed and self._writer is not None:
                self._publish(0, 0, 1, 0)
        finally:
            self._armed = False
            self._writer = None
            self._readers.clear()
            if self._cyber is not None:
                self._cyber.shutdown()
                self._cyber = None
            self._node = None
