#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "vehicle_edge/config.h"
#include "vehicle_edge/control_service.h"
#include "vehicle_edge/encoded_video.h"
#include "vehicle_edge/media_demand.h"

namespace vehicle_edge {

enum class MediaState { OFF, STARTING, ACTIVE, STOPPING, ERROR };

// The SDK lives in an owned process: its blocking connect/publish/destructor
// cannot prevent lease expiry, polling, telemetry, or bounded cancellation.
class MediaProcess {
public:
  MediaProcess() = default;
  ~MediaProcess();
  MediaProcess(const MediaProcess &) = delete;
  MediaProcess &operator=(const MediaProcess &) = delete;
  bool Start(const std::string &executable, const std::string &config_path);
  bool Send(const Json::Value &snapshot,
            const MediaAuthorization &authorization,
            const Json::Value &sources = Json::Value(),
            const Json::Value &control_feedback = Json::Value());
  bool Poll(ControlService *control = nullptr);
  bool SendFrame(EncodedFrame frame);
  std::optional<VideoFeedback> Feedback();
  void Stop();
  MediaState state() const { return state_; }

private:
  int pid_ = -1;
  int socket_ = -1;
  int video_socket_ = -1;
  std::uint64_t frame_sequence_ = 0;
  MediaState state_ = MediaState::OFF;
};

class MediaService {
public:
  MediaService(DeviceConfig config, std::string config_path,
               std::shared_ptr<StateCache> cache, std::string stream_id);
  ~MediaService();
  MediaService(const MediaService &) = delete;
  MediaService &operator=(const MediaService &) = delete;
  MediaState state() const { return state_.load(); }
  // Terminal and idempotent. Concurrent Stop calls are serialized.
  void Stop();
  FrameResult SubmitEncodedFrame(EncodedFrame frame);
  VideoFeedback TakeVideoFeedback();
  void EncodedDiscontinuity() { video_.Discontinuity(); }

private:
  void PollDemand();
  void RunMedia();
  DeviceConfig config_;
  std::string config_path_;
  std::shared_ptr<StateCache> cache_;
  std::string stream_id_;
  std::atomic<bool> stop_{false};
  std::atomic<MediaState> state_{MediaState::OFF};
  std::mutex stop_mutex_;
  std::mutex mutex_;
  DemandGate gate_;
  EncodedIngress video_;
  std::unique_ptr<ControlService> control_;
  std::thread poll_thread_;
  std::thread media_thread_;
};

} // namespace vehicle_edge
