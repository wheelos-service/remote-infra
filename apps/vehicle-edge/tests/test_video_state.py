import unittest

from vehicle_edge.video_state import VideoMode, VideoProfile, VideoStateManager
from vehicle_edge.camera_config import CameraLayout, camera_configs


class VideoStateManagerTest(unittest.TestCase):
    def test_starts_in_standby(self):
        manager = VideoStateManager()
        self.assertEqual(manager.mode, VideoMode.STANDBY)
        self.assertEqual(manager.profile.fps, 1)

    def test_switches_to_configured_active_profile(self):
        manager = VideoStateManager(
            standby=VideoProfile(320, 180, 1, 75_000),
            active=VideoProfile(1280, 720, 30, 2_000_000),
        )
        profile = manager.set_mode("ACTIVE")
        self.assertEqual(manager.mode, VideoMode.ACTIVE)
        self.assertEqual(profile.fps, 30)
        self.assertEqual(profile.bitrate_bps, 2_000_000)


class CameraConfigsTest(unittest.TestCase):
    def test_single_layout_publishes_front_camera(self):
        self.assertEqual(
            [(camera.name, camera.index) for camera in camera_configs(CameraLayout.SINGLE)],
            [("front", 0)],
        )

    def test_three_camera_layout_uses_named_device_indices(self):
        self.assertEqual(
            [(camera.name, camera.index) for camera in camera_configs(CameraLayout.THREE)],
            [("left", 0), ("center", 1), ("right", 2)],
        )

    def test_off_layout_has_no_camera_tracks(self):
        self.assertEqual(camera_configs(CameraLayout.OFF), ())


if __name__ == "__main__":
    unittest.main()
