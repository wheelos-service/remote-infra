import asyncio
import unittest
from unittest.mock import patch

from vehicle_edge.camera_capture import CameraFormat
from vehicle_edge.camera_config import CameraLayout, CameraOptions, camera_configs
from vehicle_edge.vehicle_node import _parse_args
from vehicle_edge.video_publisher import LiveKitVideoPublisher
from test_video_publisher import FakeRTC, FakeParticipant, FakeCamera


class SixCamerasTest(unittest.IsolatedAsyncioTestCase):
    def test_named_layout_and_explicit_device_mapping(self):
        configs = camera_configs(CameraLayout.SIX, (0, 2, 4, 6, 8, 10))
        self.assertEqual([c.name for c in configs],
                         ['left', 'center', 'right', 'rear-left', 'rear-center', 'rear-right'])
        self.assertEqual([c.index for c in configs], [0, 2, 4, 6, 8, 10])
        self.assertEqual([c.index for c in camera_configs(CameraLayout.SIX)], list(range(6)))
        for indices in ((0, 1, 2), (0, 1, 2, 3, 4, 4), (0, 1, 2, 3, 4, -1)):
            with self.assertRaises(ValueError):
                CameraOptions(layout=CameraLayout.SIX, indices=indices)

    def test_cli_parses_six_camera_devices(self):
        with patch('sys.argv', ['vehicle_node', '--gateway', 'http://test', '--vehicle-id', 'test',
                               '--livekit-url', 'ws://test', '--camera-layout', 'six',
                               '--camera-indices', '0', '2', '4', '6', '8', '10']):
            args = _parse_args()
        self.assertEqual(args.camera_layout, 'six')
        self.assertEqual(args.camera_indices, [0, 2, 4, 6, 8, 10])

    async def test_six_publishing_keeps_healthy_rear_and_front_tracks_after_failure(self):
        participant = FakeParticipant()
        publisher = LiveKitVideoPublisher(FakeRTC, participant)
        opened = []
        cameras = []

        def open_camera(index, width, height, fps):
            opened.append(index)
            if index == 6:
                raise RuntimeError('rear left disconnected')
            camera = FakeCamera()
            cameras.append(camera)
            return camera, CameraFormat(1920, 1080, 30)

        async def hold(source, camera, capture_format, video_format):
            try:
                await asyncio.Event().wait()
            finally:
                camera.release()

        publisher._publish_frames = hold
        with patch('vehicle_edge.video_publisher.open_configured_camera', open_camera):
            await publisher.start(CameraOptions(layout=CameraLayout.SIX, indices=(0, 2, 4, 6, 8, 10),
                                                video_width=640, video_height=360))
        await asyncio.sleep(0)
        self.assertEqual(opened, [0, 2, 4, 6, 8, 10])
        self.assertEqual([t.name for t, _ in participant.published_tracks],
                         ['camera-left', 'camera-center', 'camera-right', 'camera-rear-center', 'camera-rear-right'])
        await publisher.close()
        self.assertTrue(all(c.released for c in cameras))
