import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from vehicle_edge.camera_capture import CameraFormat
from vehicle_edge.camera_config import CameraLayout, CameraOptions
from vehicle_edge.video_publisher import LiveKitVideoPublisher


class FakeCamera:
    def __init__(self):
        self.released = False

    def release(self):
        self.released = True


class FakeTrack:
    @staticmethod
    def create_video_track(name, source):
        return SimpleNamespace(name=name, source=source)


class FakeVideoSource:
    def __init__(self, width, height):
        self.width = width
        self.height = height


class FakeRTC:
    VideoSource = FakeVideoSource
    LocalVideoTrack = FakeTrack
    TrackSource = SimpleNamespace(SOURCE_CAMERA="camera")
    TrackPublishOptions = staticmethod(lambda **options: options)
    VideoEncoding = staticmethod(lambda **options: options)


class FakeParticipant:
    def __init__(self):
        self.published_tracks = []
        self.unpublished_tracks = []

    async def publish_track(self, track, options):
        self.published_tracks.append((track, options))
        return SimpleNamespace(sid=f"sid-{track.name}")

    async def unpublish_track(self, track_sid):
        self.unpublished_tracks.append(track_sid)


class LiveKitVideoPublisherTest(unittest.IsolatedAsyncioTestCase):
    async def test_failed_camera_does_not_block_other_tracks(self):
        cameras = {}
        participant = FakeParticipant()
        publisher = LiveKitVideoPublisher(FakeRTC, participant)
        stopped = asyncio.Event()

        def open_camera(index, width, height, fps):
            if index == 0:
                raise RuntimeError("left camera unavailable")
            camera = FakeCamera()
            cameras[index] = camera
            return camera, CameraFormat(640, 480, 20)

        async def hold_camera(source, camera, camera_format):
            try:
                await stopped.wait()
            finally:
                camera.release()

        publisher._publish_frames = hold_camera
        with patch("vehicle_edge.video_publisher.open_configured_camera", open_camera):
            await publisher.start(CameraOptions(layout=CameraLayout.THREE))
        await asyncio.sleep(0)

        self.assertEqual(
            [track.name for track, _ in participant.published_tracks],
            ["camera-center", "camera-right"],
        )
        await publisher.close()
        self.assertTrue(all(camera.released for camera in cameras.values()))

    async def test_failed_frame_capture_unpublishes_its_track(self):
        camera = FakeCamera()
        participant = FakeParticipant()
        publisher = LiveKitVideoPublisher(FakeRTC, participant)
        stop_camera = asyncio.Event()

        def open_camera(index, width, height, fps):
            return camera, CameraFormat(640, 480, 20)

        async def fail_after_start(source, active_camera, camera_format):
            try:
                await stop_camera.wait()
                raise RuntimeError("camera stopped")
            finally:
                active_camera.release()

        publisher._publish_frames = fail_after_start
        with patch("vehicle_edge.video_publisher.open_configured_camera", open_camera):
            await publisher.start(CameraOptions(layout=CameraLayout.SINGLE))
        await asyncio.sleep(0)
        stop_camera.set()
        await asyncio.sleep(0)

        await publisher.collect_finished()

        self.assertEqual(participant.unpublished_tracks, ["sid-camera-front"])
        self.assertTrue(camera.released)


if __name__ == "__main__":
    unittest.main()
