"""Publish configured vehicle cameras as independent LiveKit tracks."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .camera_capture import CameraFormat, open_configured_camera, read_i420_frame
from .camera_config import CameraOptions, camera_configs
from .video_state import VideoProfile, VideoStateManager


def _bitrate_for_camera(
    profile: VideoProfile,
    width: int,
    height: int,
    fps: float,
) -> int:
    baseline = profile.width * profile.height * profile.fps
    actual = width * height * fps
    return max(1, round(profile.bitrate_bps * actual / baseline))


class LiveKitVideoPublisher:
    def __init__(self, rtc: Any, participant: Any) -> None:
        self._rtc = rtc
        self._participant = participant
        self._profile = VideoStateManager().set_mode("ACTIVE")
        self._tasks: dict[str, asyncio.Task] = {}
        self._publications: dict[str, Any] = {}

    async def start(self, options: CameraOptions) -> None:
        for config in camera_configs(options.layout, options.indices):
            camera = None
            try:
                camera, camera_format = open_configured_camera(
                    config.index,
                    options.width,
                    options.height,
                    options.fps or self._profile.fps,
                )
                video_format = CameraFormat(
                    options.video_width or camera_format.width,
                    options.video_height or camera_format.height,
                    camera_format.fps,
                )
                await self._publish_track(config.name, camera, camera_format, video_format)
                camera = None
            except Exception:
                logging.exception(
                    "[LIVEKIT] failed to publish %s camera (continuing)",
                    config.name,
                )
            finally:
                if camera is not None:
                    camera.release()

    async def _publish_track(
        self,
        name: str,
        camera: Any,
        camera_format: CameraFormat,
        video_format: CameraFormat,
    ) -> None:
        source = self._rtc.VideoSource(video_format.width, video_format.height)
        track = self._rtc.LocalVideoTrack.create_video_track(
            f"camera-{name}", source)
        options = self._rtc.TrackPublishOptions(
            source=self._rtc.TrackSource.SOURCE_CAMERA,
            simulcast=True,
            video_encoding=self._rtc.VideoEncoding(
                max_bitrate=_bitrate_for_camera(
                    self._profile,
                    video_format.width,
                    video_format.height,
                    video_format.fps,
                ),
                max_framerate=video_format.fps,
            ),
        )
        publication = await self._participant.publish_track(track, options)
        self._publications[name] = publication
        self._tasks[name] = asyncio.create_task(
            self._publish_frames(source, camera, camera_format, video_format))
        logging.info(
            "[LIVEKIT] published %s camera at %sx%s@%.2ffps",
            name,
            video_format.width,
            video_format.height,
            video_format.fps,
        )

    async def _publish_frames(
        self,
        source: Any,
        camera: Any,
        camera_format: CameraFormat,
        video_format: CameraFormat,
    ) -> None:
        frame_interval = 1 / camera_format.fps
        next_deadline = time.monotonic()
        try:
            while True:
                frame = await asyncio.to_thread(
                    read_i420_frame,
                    camera,
                    camera_format.width,
                    camera_format.height,
                    video_format.width,
                    video_format.height,
                )
                if frame is None:
                    raise RuntimeError("camera stopped returning frames")
                source.capture_frame(self._rtc.VideoFrame(
                    video_format.width,
                    video_format.height,
                    self._rtc.VideoBufferType.I420,
                    frame.tobytes(),
                ))
                next_deadline += frame_interval
                delay = next_deadline - time.monotonic()
                if delay <= 0:
                    next_deadline = time.monotonic()
                else:
                    await asyncio.sleep(delay)
        finally:
            logging.info("[CAMERA] releasing camera")
            camera.release()

    async def collect_finished(self) -> None:
        for name, task in tuple(self._tasks.items()):
            if not task.done():
                continue
            del self._tasks[name]
            try:
                task.result()
            except asyncio.CancelledError:
                pass
            except Exception:
                logging.exception("[LIVEKIT] %s camera stopped publishing", name)
                publication = self._publications.pop(name, None)
                if publication is not None:
                    try:
                        await self._participant.unpublish_track(publication.sid)
                    except Exception:
                        logging.exception(
                            "[LIVEKIT] failed to unpublish stopped %s camera",
                            name,
                        )

    async def close(self) -> None:
        for task in self._tasks.values():
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)
            self._tasks.clear()
