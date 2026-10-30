#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>
#include <vector>

#include "vehicle_edge/state_cache.h"

namespace vehicle_edge {

constexpr std::size_t kMaxEncodedBytes = 128 * 1024;
constexpr auto kMaxEncodedAge = std::chrono::milliseconds(250);

struct EncodedFrame {
  std::vector<std::uint8_t> data;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::int64_t timestamp_us = 0;
  bool keyframe = false;
  std::uint64_t sequence = 0;
};

struct VideoFeedback {
  bool keyframe_requested = false;
  std::uint64_t target_bitrate_bps = 0;
  double framerate_fps = 0;
};

enum class FrameResult { ACCEPTED, INACTIVE, BUSY, INVALID, WAITING_KEYFRAME };

// Annex B AU contract: no B frames; every IDR includes SPS/PPS.
bool ValidEncodedFrame(const EncodedFrame &frame);

class EncodedIngress {
public:
  void Activate(bool active);
  FrameResult Submit(EncodedFrame frame, SteadyTime now);
  std::optional<EncodedFrame> Take(SteadyTime now);
  void Feedback(const VideoFeedback &feedback);
  VideoFeedback TakeFeedback();
  void Discontinuity();

private:
  struct Pending {
    EncodedFrame frame;
    SteadyTime received;
  };
  void ResetLocked();
  std::mutex mutex_;
  std::atomic<bool> dropped_{false};
  bool active_ = false;
  bool waiting_keyframe_ = true;
  std::int64_t last_timestamp_ = 0;
  std::deque<Pending> pending_;
  VideoFeedback feedback_;
};

// Dedicated inherited SOCK_SEQPACKET channel, never a public network endpoint.
bool SendEncodedFrame(int fd, const EncodedFrame &frame);
std::optional<EncodedFrame> ReceiveEncodedFrame(int fd);
bool SendVideoFeedback(int fd, const VideoFeedback &feedback);
std::optional<VideoFeedback> ReceiveVideoFeedback(int fd);

} // namespace vehicle_edge
