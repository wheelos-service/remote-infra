import unittest

from vehicle_edge.video_state import VideoMode, VideoProfile, VideoStateManager


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


if __name__ == "__main__":
    unittest.main()
