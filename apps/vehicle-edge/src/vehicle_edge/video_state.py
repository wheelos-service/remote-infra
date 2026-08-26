"""Local video mode state and configurable encoding profiles."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class VideoMode(str, Enum):
    STANDBY = "STANDBY"
    ACTIVE = "ACTIVE"


@dataclass(frozen=True)
class VideoProfile:
    width: int
    height: int
    fps: int
    bitrate_bps: int


class VideoStateManager:
    def __init__(
        self,
        standby: VideoProfile = VideoProfile(640, 360, 1, 100_000),
        active: VideoProfile = VideoProfile(1280, 720, 20, 1_500_000),
    ) -> None:
        self.profiles = {VideoMode.STANDBY: standby, VideoMode.ACTIVE: active}
        self.mode = VideoMode.STANDBY

    @property
    def profile(self) -> VideoProfile:
        return self.profiles[self.mode]

    def set_mode(self, mode: VideoMode | str) -> VideoProfile:
        self.mode = VideoMode(mode)
        return self.profile
