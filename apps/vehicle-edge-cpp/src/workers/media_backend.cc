#include <poll.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <livekit/encoded_video_source.h>
#include <livekit/livekit.h>

#include "vehicle_edge/config.h"
#include "vehicle_edge/encoded_video.h"
#include "vehicle_edge/media_backend.h"
#include "vehicle_edge/state_cache.h"
#include "vehicle_edge/teleop_client.h"

namespace {

volatile sig_atomic_t stopping = 0;
void Stop(int) { stopping = 1; }

struct SDKLifetime {
  SDKLifetime() { livekit::initialize(livekit::LogLevel::Off); }
  ~SDKLifetime() { livekit::shutdown(); }
};

struct ControlDelegate : livekit::RoomDelegate {
  bool enabled = false;
  std::atomic<bool> failed{false};
  explicit ControlDelegate(const vehicle_edge::DeviceConfig &config)
      : enabled(config.control_mode == "simulation") {}
  void
  onUserPacketReceived(livekit::Room &,
                       const livekit::UserDataPacketEvent &event) override {
    if (!enabled || event.topic != "vehicle.control.v2" ||
        event.kind != livekit::DataPacketKind::Reliable || !event.participant)
      return;
    if (event.data.size() > 2048)
      return;
    Json::Value packet;
    packet["sender"] = event.participant->identity();
    packet["body"] = std::string(event.data.begin(), event.data.end());
    packet["received_ns"] =
        Json::Int64(std::chrono::duration_cast<std::chrono::nanoseconds>(
                        std::chrono::steady_clock::now().time_since_epoch())
                        .count());
    const auto body = vehicle_edge::EncodeJSON(packet);
    if (body.size() > 4096 ||
        send(3, body.data(), body.size(), MSG_DONTWAIT | MSG_NOSIGNAL) !=
            static_cast<ssize_t>(body.size()))
      failed = true;
  }
};

struct Update {
  std::string vehicle_id;
  Json::Value snapshot;
  Json::Value sources;
  Json::Value control_feedback;
  vehicle_edge::SteadyTime deadline{};
  Json::UInt64 generation = 0;
};

bool Authorized(const Update &update) {
  return !stopping && update.generation != 0 &&
         std::chrono::steady_clock::now() < update.deadline;
}

bool Receive(Update *update, bool wait) {
  pollfd descriptor{3, POLLIN, 0};
  if (poll(&descriptor, 1, wait ? 20 : 0) <= 0)
    return false;
  char buffer[65537];
  const auto size = recv(3, buffer, sizeof(buffer), MSG_DONTWAIT);
  if (size == 0) {
    stopping = 1;
    return false;
  }
  if (size <= 0 || size > 65536)
    throw std::runtime_error("media supervisor disconnected");
  Json::CharReaderBuilder builder;
  builder["rejectDupKeys"] = true;
  builder["failIfExtra"] = true;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value value;
  std::string errors;
  if (!reader->parse(buffer, buffer + size, &value, &errors) ||
      !value["generation"].isUInt64() || value["generation"].asUInt64() == 0 ||
      !value["deadline_ns"].isInt64() || !value["snapshot"].isObject())
    throw std::runtime_error("invalid supervisor message");
  if (value["snapshot"]["vehicle_id"] != update->vehicle_id)
    throw std::runtime_error("supervisor vehicle identity mismatch");
  const auto deadline = vehicle_edge::SteadyTime(
      std::chrono::nanoseconds(value["deadline_ns"].asInt64()));
  if (deadline > std::chrono::steady_clock::now() + std::chrono::seconds(5) ||
      (update->generation != 0 &&
       value["generation"].asUInt64() != update->generation))
    throw std::runtime_error("invalid supervisor authorization");
  update->deadline = deadline;
  update->generation = value["generation"].asUInt64();
  update->snapshot = value["snapshot"];
  update->sources = value["sources"];
  update->control_feedback = value["control_feedback"];
  return true;
}

void Drain(Update *update) {
  while (Receive(update, false)) {
  }
}

void SimulationFrame(livekit::VideoSource *source, std::uint64_t sequence) {
  constexpr int width = 640;
  constexpr int height = 480;
  auto frame = livekit::VideoFrame::create(width, height,
                                           livekit::VideoBufferType::RGBA);
  auto *pixels = frame.data();
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const auto offset = (y * width + x) * 4;
      const bool stripe = (x + static_cast<int>(sequence % width)) % 80 < 40;
      pixels[offset] = stripe ? 220 : 30;
      pixels[offset + 1] = static_cast<std::uint8_t>(y * 255 / height);
      pixels[offset + 2] = stripe ? 30 : 220;
      pixels[offset + 3] = 255;
    }
  }
  source->captureFrame(frame);
}

} // namespace

int vehicle_edge::RunMediaBackend(const DeviceConfig &config) {
  const auto parent = getppid();
  if (parent <= 1 || prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 ||
      getppid() != parent)
    throw std::runtime_error("media supervisor unavailable");
  stopping = 0;
  signal(SIGTERM, Stop);
  signal(SIGINT, Stop);
  const bool encoded = config.camera_source == "h264_annexb";
  if (!config.media_enabled ||
      (!encoded && config.camera_source != "simulation"))
    throw std::runtime_error("media is not explicitly enabled");
  Update update;
  update.vehicle_id = config.vehicle_id;
  while (!stopping && !Receive(&update, true)) {
  }
  if (!Authorized(update))
    return 0;
  vehicle_edge::TeleopClient client(config);
  const auto token = client.MediaToken();
  Drain(&update);
  if (!Authorized(update))
    return 0;
  // SDK diagnostics are suppressed: upstream transport errors may contain URLs.
  SDKLifetime sdk;
  {
    ControlDelegate control(config);
    livekit::Room room;
    room.setDelegate(&control);
    livekit::RoomOptions options;
    options.auto_subscribe = false;
    options.join_retries = 0;
    if (!room.connect(config.livekit_url, token, options))
      throw std::runtime_error("RTC connection failed");
    Drain(&update);
    if (!Authorized(update)) {
      room.disconnect();
      return 0;
    }
    const auto participant = room.localParticipant().lock();
    if (!participant)
      throw std::runtime_error("RTC participant unavailable");
    std::shared_ptr<livekit::EncodedVideoSource> encoded_source;
    std::shared_ptr<livekit::VideoSource> source;
    if (encoded) {
      encoded_source = std::make_shared<livekit::EncodedVideoSource>(
          livekit::VideoCodec::H264, 640, 480);
      source = encoded_source;
    } else {
      source = std::make_shared<livekit::VideoSource>(640, 480);
    }
    auto track = participant->publishVideoTrack(
        config.camera_track, source, livekit::TrackSource::SOURCE_CAMERA);
    if (!track)
      throw std::runtime_error("RTC video publication failed");
    Drain(&update);
    if (!Authorized(update)) {
      room.disconnect();
      return 0;
    }
    if (send(3, "A", 1, MSG_NOSIGNAL | MSG_DONTWAIT) != 1)
      throw std::runtime_error("media supervisor unavailable");
    std::uint64_t sequence = 0;
    auto next_frame = vehicle_edge::SteadyTime{};
    auto next_state = vehicle_edge::SteadyTime{};
    auto next_control = vehicle_edge::SteadyTime{};
    bool waiting_keyframe = true;
    std::uint64_t last_sequence = 0;
    std::int64_t last_pts = 0;
    std::int64_t base_pts = 0;
    std::int64_t base_time = 0;
    vehicle_edge::VideoFeedback feedback;
    feedback.keyframe_requested = encoded;
    while (Authorized(update)) {
      if (room.connectionState() != livekit::ConnectionState::Connected)
        throw std::runtime_error("RTC disconnected");
      Drain(&update);
      if (!Authorized(update))
        break;
      const auto now = std::chrono::steady_clock::now();
      if (control.failed)
        throw std::runtime_error("control IPC unavailable");
      if (control.enabled && update.control_feedback.isObject()) {
        if (now >= next_control) {
          const auto body = vehicle_edge::EncodeJSON(update.control_feedback);
          participant->publishData(
              std::vector<std::uint8_t>(body.begin(), body.end()), true, {},
              "vehicle.control.feedback.v2");
          next_control = now + std::chrono::milliseconds(50);
        }
      }
      if (encoded) {
        const auto requested = encoded_source->takeFeedback();
        feedback.keyframe_requested |= requested.keyframe_requested;
        if (requested.rate_control) {
          feedback.target_bitrate_bps =
              requested.rate_control->target_bitrate_bps;
          feedback.framerate_fps = requested.rate_control->framerate_fps;
        }
        if (feedback.keyframe_requested || feedback.target_bitrate_bps) {
          if (vehicle_edge::SendVideoFeedback(4, feedback))
            feedback = {};
        }
        // Bound work per supervisor iteration, even if a producer floods IPC.
        for (int count = 0; count < 2 && Authorized(update); ++count) {
          auto frame = vehicle_edge::ReceiveEncodedFrame(4);
          if (!frame)
            break;
          if (frame->sequence != last_sequence + 1)
            waiting_keyframe = true;
          last_sequence = frame->sequence;
          if (frame->timestamp_us <= last_pts)
            throw std::runtime_error("nonmonotonic encoded timestamp");
          last_pts = frame->timestamp_us;
          if (waiting_keyframe && !frame->keyframe) {
            feedback.keyframe_requested = true;
            continue;
          }
          waiting_keyframe = false;
          if (!base_pts) {
            base_pts = frame->timestamp_us;
            base_time = std::chrono::duration_cast<std::chrono::microseconds>(
                            now.time_since_epoch())
                            .count();
          }
          const auto elapsed_us = frame->timestamp_us - base_pts;
          const auto clock_us =
              std::chrono::duration_cast<std::chrono::microseconds>(
                  now.time_since_epoch())
                  .count();
          if (elapsed_us > clock_us - base_time + 250000 ||
              clock_us - base_time - elapsed_us > 250000)
            throw std::runtime_error("encoded PTS outside freshness window");
          livekit::EncodedVideoSource::Frame input_frame;
          input_frame.is_keyframe = frame->keyframe;
          input_frame.width = frame->width;
          input_frame.height = frame->height;
          input_frame.timestamp_us = base_time + elapsed_us;
          input_frame.data = std::move(frame->data);
          if (!encoded_source->captureFrame(input_frame)) {
            waiting_keyframe = true;
            feedback.keyframe_requested = true;
          }
        }
      } else if (now >= next_frame) {
        SimulationFrame(source.get(), ++sequence);
        next_frame = now + std::chrono::milliseconds(100);
      }
      if (!Authorized(update))
        break;
      if (now >= next_state) {
        const auto data =
            vehicle_edge::EncodeRTCState(update.snapshot, update.sources);
        if (data)
          participant->publishData(
              std::vector<std::uint8_t>(data->begin(), data->end()), true, {},
              "vehicle.state");
        next_state = now + std::chrono::milliseconds(200);
      }
      Receive(&update, true);
    }
    participant->unpublishTrack(track->sid());
    track.reset();
    source.reset();
    encoded_source.reset();
    room.disconnect();
  }
  return 0;
}
