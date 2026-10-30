#include "vehicle_edge/camera_gst_adapter.h"

#include <gst/video/video-event.h>

#include <cstring>
#include <stdexcept>

namespace vehicle_edge {

FrameResult CameraGstAdapter::SubmitSample(GstSample *sample) {
  const auto invalid = [this] {
    service_.EncodedDiscontinuity();
    return FrameResult::INVALID;
  };
  if (!sample)
    return invalid();
  auto *caps = gst_sample_get_caps(sample);
  auto *buffer = gst_sample_get_buffer(sample);
  if (!caps || gst_caps_get_size(caps) != 1 || !buffer)
    return invalid();
  const auto *format = gst_caps_get_structure(caps, 0);
  const auto *alignment = gst_structure_get_string(format, "alignment");
  const auto *stream_format = gst_structure_get_string(format, "stream-format");
  int width = 0, height = 0;
  if (!gst_structure_has_name(format, "video/x-h264") || !alignment ||
      std::strcmp(alignment, "au") != 0 || !stream_format ||
      std::strcmp(stream_format, "byte-stream") != 0 ||
      !gst_structure_get_int(format, "width", &width) ||
      !gst_structure_get_int(format, "height", &height) || width <= 0 ||
      height <= 0 || width > 4096 || height > 4096 ||
      !GST_BUFFER_PTS_IS_VALID(buffer) ||
      GST_BUFFER_FLAG_IS_SET(buffer, GST_BUFFER_FLAG_CORRUPTED) ||
      gst_buffer_get_size(buffer) == 0 ||
      gst_buffer_get_size(buffer) > kMaxEncodedBytes)
    return invalid();
  if (GST_BUFFER_FLAG_IS_SET(buffer, GST_BUFFER_FLAG_DISCONT))
    service_.EncodedDiscontinuity();
  GstMapInfo mapping = GST_MAP_INFO_INIT;
  if (!gst_buffer_map(buffer, &mapping, GST_MAP_READ))
    return invalid();
  EncodedFrame frame;
  frame.width = static_cast<std::uint32_t>(width);
  frame.height = static_cast<std::uint32_t>(height);
  // Preserve relative PTS, including the valid first timestamp zero.
  frame.timestamp_us =
      static_cast<std::int64_t>(GST_BUFFER_PTS(buffer) / 1000) + 1;
  frame.keyframe = !GST_BUFFER_FLAG_IS_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);
  try {
    frame.data.assign(mapping.data, mapping.data + mapping.size);
  } catch (...) {
    gst_buffer_unmap(buffer, &mapping);
    throw;
  }
  gst_buffer_unmap(buffer, &mapping);
  return service_.SubmitEncodedFrame(std::move(frame));
}

void CameraGstAdapter::RequestKeyframe(GstElement *sink) {
  if (!sink ||
      !gst_element_send_event(sink, gst_video_event_new_upstream_force_key_unit(
                                        GST_CLOCK_TIME_NONE, TRUE, 0)))
    throw std::runtime_error("camera branch rejected keyframe request");
}

void CameraGstAdapter::SetBitrate(GstElement *encoder,
                                  std::uint64_t bitrate_bps) {
  if (!encoder)
    throw std::invalid_argument("missing camera encoder");
  auto *property =
      g_object_class_find_property(G_OBJECT_GET_CLASS(encoder), "bitrate");
  if (!property || !G_IS_PARAM_SPEC_UINT(property) ||
      !(property->flags & G_PARAM_WRITABLE))
    throw std::invalid_argument(
        "encoder requires uint bitrate property in bps");
  const auto *range = G_PARAM_SPEC_UINT(property);
  if (bitrate_bps < range->minimum || bitrate_bps > range->maximum)
    throw std::invalid_argument("encoder bitrate outside supported range");
  // Nvidia nvv4l2h264enc uses bps; x264enc uses kbps and is not this contract.
  auto *factory = gst_element_get_factory(encoder);
  if (!factory ||
      std::strcmp(gst_plugin_feature_get_name(factory), "nvv4l2h264enc") != 0)
    throw std::invalid_argument(
        "automatic bitrate adapter supports NVENC only");
  g_object_set(encoder, "bitrate", static_cast<guint>(bitrate_bps), nullptr);
}

} // namespace vehicle_edge
