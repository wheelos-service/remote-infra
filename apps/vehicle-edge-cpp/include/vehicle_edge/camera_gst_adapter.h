#pragma once

#include <gst/gst.h>

#include "vehicle_edge/media_service.h"

namespace vehicle_edge {

// Called by the owner's dedicated appsink callback; never owns camera capture.
class CameraGstAdapter {
public:
  explicit CameraGstAdapter(MediaService &service) : service_(service) {}
  FrameResult SubmitSample(GstSample *sample);
  VideoFeedback TakeFeedback() { return service_.TakeVideoFeedback(); }
  static void RequestKeyframe(GstElement *sink);
  static void SetBitrate(GstElement *encoder, std::uint64_t bitrate_bps);

private:
  MediaService &service_;
};

} // namespace vehicle_edge
