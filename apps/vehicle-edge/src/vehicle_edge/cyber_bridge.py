"""WheelOS Cyber monitoring and remote-control adapter."""

from __future__ import annotations

import logging
import math
import os
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
    max_forward_throttle_pct: float = 0.0
    max_reverse_throttle_pct: float = 0.0
    max_steering_pct: float = 0.0
    stop_brake_pct: float = 100.0
    emergency_brake_pct: float = 100.0
    max_speed_mps: float = 0.0
    chassis_timeout_s: float = 0.5
    shift_speed_mps: float = 0.05
    shift_timeout_s: float = 2.0
    throttle_rise_pct_s: float = 20.0
    steering_rate_pct_s: float = 80.0

    def __post_init__(self) -> None:
        for name in ("max_forward_throttle_pct", "max_reverse_throttle_pct",
                     "max_steering_pct", "stop_brake_pct", "emergency_brake_pct"):
            value = getattr(self, name)
            if not math.isfinite(value) or not 0 <= value <= 100:
                raise ValueError(f"{name} must be finite and within 0..100")
        if not 0 < self.stop_brake_pct <= self.emergency_brake_pct:
            raise ValueError("require 0 < stop_brake_pct <= emergency_brake_pct")
        for name in ("max_speed_mps", "shift_speed_mps", "chassis_timeout_s", "shift_timeout_s",
                     "throttle_rise_pct_s", "steering_rate_pct_s"):
            value = getattr(self, name)
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and nonnegative")
        if (self.chassis_timeout_s == 0 or self.shift_timeout_s == 0 or
                self.throttle_rise_pct_s == 0 or self.steering_rate_pct_s == 0):
            raise ValueError("timeouts and actuator change rates must be positive")


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
        self._pending_gear: int | None = None
        self._explicit_gear: int | None = None
        self._explicit_shift_started = 0.0
        self._shift_started = 0.0
        self._shift_fault = False
        self._motion_at: float | None = None
        self._output_steering = 0.0
        self._output_throttle = 0.0
        self._last_tx_log_at = float("-inf")
        self._last_tx_log_kind = None
        self._cyber: Any = None
        self._node: Any = None
        self._writer: Any = None
        self._readers: list[Any] = []

    def start(self) -> None:
        from .cyber_runtime import load_runtime

        cyber, Chassis, ControlCommand, LocalizationEstimate = load_runtime()

        self._control_type = ControlCommand
        self._chassis_type = Chassis
        self._cyber = cyber
        try:
            if not cyber.init(self.options.node_name):
                raise RuntimeError("Cyber initialization failed")
            logging.info(
                "[CYBER] backend=%s module=%s domain=%s ip=%s chassis=%s localization=%s control=%s",
                os.environ.get("VEHICLE_CYBER_BACKEND", "wheelos"),
                getattr(cyber, "__file__", "unknown"),
                os.environ.get("CYBER_DOMAIN_ID", "80"),
                os.environ.get("CYBER_IP", "127.0.0.1"),
                self.options.chassis_channel, self.options.localization_channel,
                self.options.control_channel if self.options.control_enabled else "disabled",
            )
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

    def _chassis(self, motion: bool = False):
        with self._lock:
            sample = self._samples.get("chassis")
        if sample is None or time.monotonic() - sample[1] > self.options.chassis_timeout_s:
            raise RuntimeError("chassis feedback missing or stale")
        chassis = sample[0]
        if not chassis.HasField("speed_mps") or not math.isfinite(chassis.speed_mps):
            raise RuntimeError("chassis speed missing or non-finite")
        if (not chassis.HasField("gear_location") or chassis.gear_location not in (
                self._chassis_type.GEAR_NEUTRAL, self._chassis_type.GEAR_DRIVE,
                self._chassis_type.GEAR_REVERSE, self._chassis_type.GEAR_PARKING,
                self._chassis_type.GEAR_LOW)):
            raise RuntimeError("chassis gear missing or invalid")
        if motion:
            if (not chassis.HasField("driving_mode") or
                    chassis.driving_mode != self._chassis_type.COMPLETE_AUTO_DRIVE):
                raise RuntimeError("chassis must be in COMPLETE_AUTO_DRIVE")
            if ((chassis.HasField("error_code") and chassis.error_code != 0) or
                    (chassis.HasField("chassis_error_mask") and chassis.chassis_error_mask != 0) or
                    (chassis.HasField("parking_brake") and chassis.parking_brake)):
                raise RuntimeError("chassis fault or parking brake prevents motion")
        return chassis, sample[1]

    def _hold_gear(self) -> int:
        with self._lock:
            reported = self._reported_gear
        # Braking may use the last observed valid gear after feedback loss.
        # Never substitute an unconfirmed shift request for observed gear.
        if reported:
            return reported[0]
        if self._last_gear is not None:
            return self._last_gear
        raise RuntimeError("cannot hold gear before receiving chassis gear")

    def _publish(self, steering: float, throttle: float, brake: float, gear: int,
                 pad_action: str | None = None) -> None:
        """Publish already guarded percentages. Safety braking bypasses motion limits."""
        if self._writer is None:
            raise RuntimeError("Cyber control writer is not available")
        message = self._control_type()
        self._sequence = (self._sequence + 1) & 0xFFFFFFFF
        message.header.timestamp_sec = time.time()
        message.header.module_name = self.options.node_name
        message.header.sequence_num = self._sequence
        message.steering_target = steering
        message.throttle = 0 if brake > 0 else throttle
        message.brake = brake
        message.gear_location = gear
        if pad_action is not None:
            # Resolve the enum from the selected runtime's actual protobuf type.
            try:
                action_enum = message.pad_msg.DESCRIPTOR.fields_by_name["action"].enum_type
                message.pad_msg.action = action_enum.values_by_name[pad_action].number
                message.pad_msg.header.CopyFrom(message.header)
            except (AttributeError, KeyError) as exc:
                raise RuntimeError("Cyber runtime does not support the requested pad action") from exc
        self._armed = True
        if not self._writer.write(message):
            raise RuntimeError("Cyber control publication failed")
        self._last_gear = gear
        self._motion_at = time.monotonic()
        self._output_steering = steering
        self._output_throttle = message.throttle
        kind = (gear, brake > 0, brake == self.options.emergency_brake_pct)
        if kind != self._last_tx_log_kind or self._motion_at - self._last_tx_log_at >= 1:
            logging.info(
                "[CYBER_TX] topic=%s seq=%s gear=%s steering_target_pct=%.2f "
                "throttle_pct=%.2f brake_pct=%.2f middleware_accepted=true actuator_ack=false",
                self.options.control_channel, self._sequence, gear,
                message.steering_target, message.throttle, message.brake,
            )
            self._last_tx_log_at = self._motion_at
            self._last_tx_log_kind = kind

    async def maintain_stop(self) -> None:
        if self._explicit_gear is not None:
            chassis, received_at = self._chassis(motion=True)
            if abs(chassis.speed_mps) > self.options.shift_speed_mps:
                raise RuntimeError("gear change requires vehicle stopped")
            if (chassis.gear_location == self._explicit_gear
                    and received_at > self._explicit_shift_started):
                self._explicit_gear = None
            elif time.monotonic() - self._explicit_shift_started >= self.options.shift_timeout_s:
                self._shift_fault = True
                raise RuntimeError("gear feedback confirmation timed out; stop before retry")
            else:
                self._publish(0, 0, self.options.stop_brake_pct, self._explicit_gear)
                return
        # Repeated normal braking still requires live speed/gear feedback.
        self._chassis()
        self._publish(0, 0, self.options.stop_brake_pct, self._hold_gear())

    async def _apply_vehicle_action(self, action: str) -> bool:
        gears = {"gear_park": self._chassis_type.GEAR_PARKING,
                 "gear_neutral": self._chassis_type.GEAR_NEUTRAL,
                 "gear_drive": self._chassis_type.GEAR_DRIVE,
                 "gear_reverse": self._chassis_type.GEAR_REVERSE}
        if action in gears:
            if self._shift_fault:
                raise RuntimeError("gear change fault; send stop before retry")
            chassis, _ = self._chassis(motion=True)
            if abs(chassis.speed_mps) > self.options.shift_speed_mps:
                raise RuntimeError("gear change requires vehicle stopped")
            if self._pending_gear is not None or self._explicit_gear is not None:
                raise RuntimeError("gear change already pending; stop before changing target")
            self._explicit_gear = gears[action]
            self._explicit_shift_started = time.monotonic()
            self._publish(0, 0, self.options.stop_brake_pct, gears[action])
        elif action in ("auto_enter", "auto_exit"):
            if action == "auto_enter":
                chassis, _ = self._chassis()
                if abs(chassis.speed_mps) > self.options.shift_speed_mps:
                    raise RuntimeError("entering auto requires vehicle stopped")
                if ((chassis.HasField("error_code") and chassis.error_code != 0) or
                        (chassis.HasField("chassis_error_mask") and chassis.chassis_error_mask != 0)):
                    raise RuntimeError("chassis fault prevents entering auto")
            self._explicit_gear = None
            self._pending_gear = None
            self._publish(0, 0, self.options.stop_brake_pct, self._hold_gear(),
                          "START" if action == "auto_enter" else "RESET")
        else:
            raise ValueError("unknown vehicle action")
        logging.info("[CYBER_ACTION] action=%s middleware_accepted=true actuator_ack=false", action)
        self.in_emergency = False
        return True

    async def apply_control(self, cmd: str, val: Any) -> bool:
        if not self.options.control_enabled:
            return False
        if cmd != "remote" or not isinstance(val, dict):
            raise ValueError("Cyber accepts only verified, resolved remote commands")
        if "vehicle_action" in val:
            return await self._apply_vehicle_action(val["vehicle_action"])
        steering, throttle, brake, direction = (
            val["steering"], val["throttle"], val["brake"], val["direction"])
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool)
                   and math.isfinite(value) for value in (steering, throttle, brake, direction)):
            raise ValueError("non-finite Cyber command")
        if not (-1 <= steering <= 1 and 0 <= throttle <= 1 and 0 <= brake <= 1
                and direction in (-1, 0, 1)):
            raise ValueError("Cyber command outside normalized range")
        brake_mode = val.get("brake_mode")
        if brake_mode == "emergency":
            self._explicit_gear = None
            self._pending_gear = None
            self._publish(0, 0, self.options.emergency_brake_pct, self._hold_gear())
            self.in_emergency = True
            return True
        if brake_mode == "stop":
            self._explicit_gear = None
            self._pending_gear = None
            await self.maintain_stop()
            self._shift_fault = False
            self.in_emergency = False
            return True

        if self._shift_fault:
            raise RuntimeError("gear change fault; send stop before retry")
        if self._explicit_gear is not None:
            await self.maintain_stop()
            if self._explicit_gear is not None:
                return True
        chassis, received_at = self._chassis(motion=True)
        gear = chassis.gear_location
        speed = abs(chassis.speed_mps)
        if brake == 0 and (speed > self.options.max_speed_mps or
                           (throttle > 0 and speed >= self.options.max_speed_mps)):
            raise RuntimeError("vehicle speed reached configured limit")
        if brake > 0:
            self._pending_gear = None
        target = (gear if brake > 0 else
                  self._chassis_type.GEAR_DRIVE if direction > 0 else
                  self._chassis_type.GEAR_REVERSE if direction < 0 else gear)
        if target != gear or self._pending_gear is not None:
            if speed > self.options.shift_speed_mps:
                self._shift_fault = True
                raise RuntimeError("gear change requires vehicle stopped")
            now = time.monotonic()
            if self._pending_gear is not None and self._pending_gear != target:
                self._shift_fault = True
                raise RuntimeError("gear change already pending; stop before changing target")
            if self._pending_gear is None:
                self._pending_gear = target
                self._shift_started = now
            if now - self._shift_started >= self.options.shift_timeout_s:
                self._shift_fault = True
                raise RuntimeError("gear feedback confirmation timed out; stop before retry")
            if gear != target or received_at <= self._shift_started:
                self._publish(0, 0, self.options.stop_brake_pct, target)
                self.in_emergency = False
                return True
            self._pending_gear = None
        if throttle > 0 and gear not in (self._chassis_type.GEAR_DRIVE, self._chassis_type.GEAR_REVERSE):
            raise RuntimeError("throttle requires confirmed drive or reverse gear")
        throttle_limit = (self.options.max_reverse_throttle_pct
                          if gear == self._chassis_type.GEAR_REVERSE
                          else self.options.max_forward_throttle_pct)
        # Normalize across the configured full travel, rather than clipping early.
        steering_target = -steering * self.options.max_steering_pct
        throttle_target = 0 if brake > 0 else throttle * throttle_limit
        now = time.monotonic()
        elapsed = 0.1 if self._motion_at is None else min(0.2, max(0, now - self._motion_at))
        step = self.options.steering_rate_pct_s * elapsed
        steering_target = max(self._output_steering - step,
                              min(steering_target, self._output_steering + step))
        steering_target = max(-self.options.max_steering_pct,
                              min(steering_target, self.options.max_steering_pct))
        # Throttle reduction and all safety braking bypass the rise limiter.
        throttle_target = min(throttle_target, self._output_throttle + self.options.throttle_rise_pct_s * elapsed)
        self._publish(steering_target, throttle_target, brake * self.options.stop_brake_pct, gear)
        self.in_emergency = False
        return True

    async def emergency_brake(self, reason: str) -> None:
        # Monitoring autonomous driving must never arm the remote actuator.
        if not self.options.control_enabled or not self._armed:
            return
        if not self.in_emergency:
            logging.error("[CYBER] remote emergency stop: %s", reason)
        self.in_emergency = True
        self._explicit_gear = None
        self._pending_gear = None
        self._publish(0, 0, self.options.emergency_brake_pct, self._hold_gear())

    def close(self) -> None:
        try:
            if self._armed and self._writer is not None:
                self._publish(0, 0, self.options.emergency_brake_pct, self._hold_gear())
        finally:
            self._armed = False
            self._writer = None
            self._readers.clear()
            if self._cyber is not None:
                self._cyber.shutdown()
                self._cyber = None
            self._node = None
