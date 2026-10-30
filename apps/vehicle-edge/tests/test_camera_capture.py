import unittest

import cv2
import numpy as np

from vehicle_edge.camera_capture import fit_frame, read_i420_frame
from vehicle_edge.camera_config import CameraOptions


class CameraScalingTest(unittest.TestCase):
    def test_full_capture_edges_survive_downscaling(self):
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        frame[:90] = (0, 0, 255)
        frame[-90:] = (0, 255, 0)
        frame[:, :90] = (255, 0, 0)
        frame[:, -90:] = (255, 255, 255)
        output = fit_frame(frame, 640, 360)
        self.assertEqual(output.shape, (360, 640, 3))
        for y, x, color in (
            (0, 320, (0, 0, 255)), (359, 320, (0, 255, 0)),
            (180, 0, (255, 0, 0)), (180, 639, (255, 255, 255)),
        ):
            np.testing.assert_array_equal(output[y, x], color)

    def test_different_aspect_ratio_is_padded(self):
        frame = np.full((480, 640, 3), 255, dtype=np.uint8)
        output = fit_frame(frame, 640, 360)
        self.assertEqual(output.shape, (360, 640, 3))
        self.assertTrue(np.all(output[:, :80] == 0))
        self.assertTrue(np.all(output[:, 80:560] == 255))
        self.assertTrue(np.all(output[:, 560:] == 0))

    def test_i420_uses_output_size(self):
        frame = np.full((1080, 1920, 3), 128, dtype=np.uint8)

        class Camera:
            def read(self):
                return True, frame

        output = read_i420_frame(Camera(), 1920, 1080, 640, 360)
        self.assertEqual(output.shape, (540, 640))
        np.testing.assert_array_equal(
            output, cv2.cvtColor(fit_frame(frame, 640, 360), cv2.COLOR_BGR2YUV_I420),
        )

    def test_invalid_output_dimensions_are_rejected(self):
        for width, height in ((640, 0), (0, 360), (-2, 360), (641, 360)):
            with self.subTest(width=width, height=height):
                with self.assertRaises(ValueError):
                    CameraOptions(video_width=width, video_height=height)
