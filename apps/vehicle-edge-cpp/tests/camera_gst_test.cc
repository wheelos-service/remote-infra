#include <iostream>
#include <stdexcept>

#include "vehicle_edge/camera_gst_adapter.h"

namespace {

void Require(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}

} // namespace

int main() {
  gst_init(nullptr, nullptr);
  int result = 0;
  try {
    vehicle_edge::DeviceConfig config;
    config.vehicle_id = "offline-test";
    config.camera_source = "h264_annexb";
    auto cache = std::make_shared<vehicle_edge::StateCache>();
    vehicle_edge::MediaService service(config, "", cache, "offline-stream");
    vehicle_edge::CameraGstAdapter adapter(service);
    Require(adapter.SubmitSample(nullptr) == vehicle_edge::FrameResult::INVALID,
            "null sample accepted");
    auto *caps = gst_caps_from_string(
        "video/"
        "x-h264,stream-format=byte-stream,alignment=au,width=640,height=480");
    const std::uint8_t bytes[] = {0,    0,    1, 0x67, 0x42, 0,    0,   1,
                                  0x68, 0x01, 0, 0,    1,    0x65, 0x01};
    auto *buffer = gst_buffer_new_allocate(nullptr, sizeof(bytes), nullptr);
    gst_buffer_fill(buffer, 0, bytes, sizeof(bytes));
    GST_BUFFER_PTS(buffer) = 0;
    auto *sample = gst_sample_new(buffer, caps, nullptr, nullptr);
    Require(adapter.SubmitSample(sample) == vehicle_edge::FrameResult::INACTIVE,
            "valid AU bypassed inactive session");
    GST_BUFFER_FLAG_SET(buffer, GST_BUFFER_FLAG_CORRUPTED);
    Require(adapter.SubmitSample(sample) == vehicle_edge::FrameResult::INVALID,
            "corrupted sample accepted");
    GST_BUFFER_FLAG_UNSET(buffer, GST_BUFFER_FLAG_CORRUPTED);
    GST_BUFFER_PTS(buffer) = GST_CLOCK_TIME_NONE;
    Require(adapter.SubmitSample(sample) == vehicle_edge::FrameResult::INVALID,
            "missing PTS accepted");
    gst_sample_unref(sample);
    gst_buffer_unref(buffer);
    gst_caps_unref(caps);
    auto *rtp_caps = gst_caps_from_string(
        "application/x-rtp,media=video,encoding-name=H264");
    auto *rtp_buffer = gst_buffer_new_allocate(nullptr, 4, nullptr);
    auto *rtp_sample = gst_sample_new(rtp_buffer, rtp_caps, nullptr, nullptr);
    Require(adapter.SubmitSample(rtp_sample) ==
                vehicle_edge::FrameResult::INVALID,
            "RTP sample accepted as an encoded access unit");
    gst_sample_unref(rtp_sample);
    gst_buffer_unref(rtp_buffer);
    gst_caps_unref(rtp_caps);
    bool rejected = false;
    try {
      adapter.SetBitrate(nullptr, 500000);
    } catch (const std::invalid_argument &) {
      rejected = true;
    }
    Require(rejected, "missing encoder silently accepted");
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    result = 1;
  }
  gst_deinit();
  return result;
}
