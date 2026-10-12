"""V4L2 camera setup and frame conversion."""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class CameraFormat:
    width: int
    height: int
    fps: float


def _open_camera(camera_index: int):
    import cv2

    if sys.platform == "darwin":
        backend = cv2.CAP_AVFOUNDATION
    elif sys.platform.startswith("linux"):
        backend = cv2.CAP_V4L2
    else:
        backend = 0
    camera = cv2.VideoCapture(camera_index, backend)
    if not camera.isOpened():
        raise RuntimeError(f"cannot open camera {camera_index}")
    return camera


def open_configured_camera(
    camera_index: int,
    requested_width: int,
    requested_height: int,
    requested_fps: int,
):
    """Open a camera, request a mode, and return the mode the driver accepted."""
    import cv2

    camera = _open_camera(camera_index)
    try:
        if requested_width > 0 and requested_height > 0:
            camera.set(cv2.CAP_PROP_FRAME_WIDTH, requested_width)
            camera.set(cv2.CAP_PROP_FRAME_HEIGHT, requested_height)
        if requested_fps > 0:
            camera.set(cv2.CAP_PROP_FPS, requested_fps)

        width = int(camera.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = camera.get(cv2.CAP_PROP_FPS)
        if width <= 0 or height <= 0:
            raise RuntimeError(f"camera {camera_index} returned an invalid frame size")
        if width % 2 or height % 2:
            raise RuntimeError(
                f"camera {camera_index} returned odd frame size {width}x{height}; "
                "I420 requires even width and height"
            )
        if requested_width > 0 and requested_height > 0 and (
            width != requested_width or height != requested_height
        ):
            raise RuntimeError(
                f"camera {camera_index} rejected requested mode "
                f"{requested_width}x{requested_height}; accepted {width}x{height}"
            )

        actual = CameraFormat(
            width,
            height,
            fps if fps > 0 else float(requested_fps or 30),
        )
        logging.info(
            "[CAMERA] camera=%s accepted width=%s height=%s fps=%.2f",
            camera_index,
            actual.width,
            actual.height,
            actual.fps,
        )
        return camera, actual
    except Exception:
        camera.release()
        raise


def read_i420_frame(camera, width: int, height: int):
    import cv2

    ok, frame = camera.read()
    if not ok or frame is None:
        return None
    if frame.shape[1] != width or frame.shape[0] != height:
        raise RuntimeError(
            f"camera returned frame {frame.shape[1]}x{frame.shape[0]}, "
            f"expected {width}x{height}"
        )
    return cv2.cvtColor(frame, cv2.COLOR_BGR2YUV_I420)
