"""Camera layouts and per-camera capture settings."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class CameraLayout(str, Enum):
    OFF = "off"
    SINGLE = "single"
    THREE = "three"
    SIX = "six"


@dataclass(frozen=True)
class CameraConfig:
    name: str
    index: int


@dataclass(frozen=True)
class CameraOptions:
    layout: CameraLayout = CameraLayout.OFF
    width: int = 0
    height: int = 0
    fps: int = 0
    video_width: int = 0
    video_height: int = 0
    indices: tuple[int, ...] | None = None

    def __post_init__(self) -> None:
        camera_configs(self.layout, self.indices)
        if (self.video_width, self.video_height) == (0, 0):
            return
        if any(value <= 0 or value % 2 for value in (self.video_width, self.video_height)):
            raise ValueError("video width and height must both be positive even numbers")


def camera_configs(layout: CameraLayout, indices: tuple[int, ...] | None = None) -> tuple[CameraConfig, ...]:
    names = {
        CameraLayout.OFF: (),
        CameraLayout.SINGLE: ("front",),
        CameraLayout.THREE: ("left", "center", "right"),
        CameraLayout.SIX: ("left", "center", "right", "rear-left", "rear-center", "rear-right"),
    }[layout]
    devices = tuple(range(len(names))) if indices is None else indices
    if (len(devices) != len(names) or len(set(devices)) != len(devices) or
            any(type(index) is not int or index < 0 for index in devices)):
        raise ValueError(f"camera indices must contain {len(names)} distinct nonnegative integers for {layout.value}")
    return tuple(CameraConfig(name, index) for name, index in zip(names, devices))
