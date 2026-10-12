"""Camera layouts and per-camera capture settings."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class CameraLayout(str, Enum):
    OFF = "off"
    SINGLE = "single"
    THREE = "three"


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


def camera_configs(layout: CameraLayout) -> tuple[CameraConfig, ...]:
    if layout is CameraLayout.SINGLE:
        return (CameraConfig("front", 0),)
    if layout is CameraLayout.THREE:
        return (
            CameraConfig("left", 0),
            CameraConfig("center", 1),
            CameraConfig("right", 2),
        )
    return ()
