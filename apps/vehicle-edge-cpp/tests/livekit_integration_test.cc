#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <fcntl.h>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>

#include <livekit/livekit.h>

#include "vehicle_edge/encoded_video.h"
#include "vehicle_edge/media_backend.h"
#include "vehicle_edge/state_cache.h"

namespace {

using namespace std::chrono_literals;

struct Child {
  pid_t pid = -1;
  int socket = -1;
  int video_socket = -1;
  ~Child() {
    if (socket >= 0)
      close(socket);
    if (video_socket >= 0)
      close(video_socket);
    if (pid > 0) {
      kill(pid, SIGKILL);
      waitpid(pid, nullptr, 0);
    }
  }
};

struct Observer : livekit::RoomDelegate {
  std::mutex mutex;
  std::shared_ptr<livekit::Track> track;
  std::shared_ptr<livekit::VideoStream> stream;
  std::thread reader;
  std::atomic<int> frames{0};
  std::atomic<int> states{0};

  ~Observer() override { Close(); }

  void Close() {
    if (stream)
      stream->close();
    if (reader.joinable())
      reader.join();
  }

  void onTrackSubscribed(livekit::Room &,
                         const livekit::TrackSubscribedEvent &event) override {
    if (event.track->kind() == livekit::TrackKind::KIND_VIDEO) {
      std::lock_guard<std::mutex> lock(mutex);
      track = event.track;
    }
  }

  void
  onUserPacketReceived(livekit::Room &,
                       const livekit::UserDataPacketEvent &event) override {
    if (event.topic != "vehicle.state" ||
        event.kind != livekit::DataPacketKind::Reliable)
      return;
    Json::CharReaderBuilder builder;
    std::unique_ptr<Json::CharReader> parser(builder.newCharReader());
    Json::Value value;
    std::string errors;
    const auto *data = reinterpret_cast<const char *>(event.data.data());
    if (parser->parse(data, data + event.data.size(), &value, &errors) &&
        value["type"] == "vehicle.state" && value["schema_version"] == 2 &&
        value["telemetry"]["vehicle_id"] == "car-test" &&
        value["telemetry"]["chassis"]["age_ms"].isInt64())
      ++states;
  }

  void StartReader() {
    std::lock_guard<std::mutex> lock(mutex);
    if (!track || reader.joinable())
      return;
    livekit::VideoStream::Options options;
    options.capacity = 2;
    stream = livekit::VideoStream::fromTrack(track, options);
    reader = std::thread([this] {
      livekit::VideoFrameEvent event;
      while (stream->read(event)) {
        if (event.frame.width() == 640 && event.frame.height() == 480)
          ++frames;
      }
    });
  }
};

void Require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}

} // namespace

int main() {
  Child child;
  try {
    Json::Value input;
    std::cin >> input;
    const auto config = vehicle_edge::ParseConfig(input["config"]);
    int sockets[2];
    Require(socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sockets) == 0,
            "socketpair failed");
    int video[2];
    Require(socketpair(AF_UNIX, SOCK_SEQPACKET, 0, video) == 0,
            "video socketpair failed");
    const int control_child = fcntl(sockets[1], F_DUPFD_CLOEXEC, 10);
    const int video_child = fcntl(video[1], F_DUPFD_CLOEXEC, 10);
    Require(control_child >= 0 && video_child >= 0, "fd staging failed");
    close(sockets[1]);
    close(video[1]);
    child.pid = fork();
    Require(child.pid >= 0, "fork failed");
    if (child.pid == 0) {
      close(sockets[0]);
      close(video[0]);
      dup2(control_child, 3);
      dup2(video_child, 4);
      close(control_child);
      close(video_child);
      try {
        _exit(vehicle_edge::RunMediaBackend(config));
      } catch (...) {
        _exit(1);
      }
    }
    close(control_child);
    close(video_child);
    child.socket = sockets[0];
    child.video_socket = video[0];
    if (input["mismatched_vehicle"].asBool()) {
      const auto now = std::chrono::steady_clock::now();
      Json::Value update;
      update["generation"] = Json::UInt64(1);
      update["deadline_ns"] =
          Json::Int64(std::chrono::duration_cast<std::chrono::nanoseconds>(
                          (now + 1500ms).time_since_epoch())
                          .count());
      vehicle_edge::StateCache cache;
      update["snapshot"] =
          cache.Snapshot("different-vehicle", "wrong-stream", 1,
                         vehicle_edge::UnixMilliseconds(), now);
      const auto body = vehicle_edge::EncodeJSON(update);
      Require(send(child.socket, body.data(), body.size(), MSG_NOSIGNAL) > 0,
              "mismatched fixture not sent");
      int status = 0;
      pid_t result = 0;
      const auto exit_by = now + 1s;
      while (std::chrono::steady_clock::now() < exit_by &&
             (result = waitpid(child.pid, &status, WNOHANG)) == 0)
        std::this_thread::sleep_for(10ms);
      Require(result == child.pid, "vehicle mismatch did not stop worker");
      child.pid = -1;
      Require(WIFEXITED(status) && WEXITSTATUS(status) == 1,
              "mismatched vehicle was not rejected");
      std::cout << "mismatched vehicle rejected before media authorization\n";
      return 0;
    }
    const bool encoded = config.camera_source == "h264_annexb";
    vehicle_edge::EncodedFrame encoded_frame;
    if (encoded) {
      encoded_frame.width = 640;
      encoded_frame.height = 480;
      encoded_frame.keyframe = true;
      for (const auto &byte : input["encoded_frame"])
        encoded_frame.data.push_back(static_cast<std::uint8_t>(byte.asUInt()));
      encoded_frame.timestamp_us = 1;
      Require(vehicle_edge::ValidEncodedFrame(encoded_frame),
              "offline encoded fixture invalid");
    }
    livekit::initialize(livekit::LogLevel::Off);
    {
      Observer delegate;
      livekit::Room observer;
      observer.setDelegate(&delegate);
      livekit::RoomOptions options;
      options.join_retries = 0;
      Require(observer.connect(config.livekit_url,
                               input["observer_token"].asString(), options),
              "observer connect failed");
      vehicle_edge::StateCache cache;
      vehicle_edge::ChassisState chassis;
      chassis.speed_mps = 0.0;
      cache.UpdateChassis(chassis, {}, std::chrono::steady_clock::now());
      const auto deadline = std::chrono::steady_clock::now() + 10s;
      std::uint64_t sequence = 0;
      bool received_feedback = false;
      bool worker_ready = false;
      while (std::chrono::steady_clock::now() < deadline &&
             (delegate.frames < 3 || delegate.states < 3)) {
        const auto now = std::chrono::steady_clock::now();
        Json::Value update;
        update["generation"] = Json::UInt64(1);
        update["deadline_ns"] =
            Json::Int64(std::chrono::duration_cast<std::chrono::nanoseconds>(
                            (now + 1500ms).time_since_epoch())
                            .count());
        update["snapshot"] =
            cache.Snapshot("car-test", "test-stream", ++sequence,
                           vehicle_edge::UnixMilliseconds(), now);
        const auto body = vehicle_edge::EncodeJSON(update);
        Require(send(child.socket, body.data(), body.size(),
                     MSG_NOSIGNAL | MSG_DONTWAIT) >= 0,
                "backend exited before receiving frames/state");
        char ready;
        if (recv(child.socket, &ready, 1, MSG_DONTWAIT) == 1 && ready == 'A')
          worker_ready = true;
        if (encoded && worker_ready) {
          encoded_frame.sequence = sequence;
          encoded_frame.timestamp_us =
              static_cast<std::int64_t>(sequence) * 100000;
          Require(
              vehicle_edge::SendEncodedFrame(child.video_socket, encoded_frame),
              "encoded fixture backpressured unexpectedly");
          if (auto feedback =
                  vehicle_edge::ReceiveVideoFeedback(child.video_socket))
            received_feedback |= feedback->keyframe_requested ||
                                 feedback->target_bitrate_bps != 0;
        }
        delegate.StartReader();
        std::this_thread::sleep_for(100ms);
      }
      const bool received = delegate.frames >= 3 && delegate.states >= 3;
      delegate.Close();
      if (!received)
        std::cerr << "received frames=" << delegate.frames
                  << " states=" << delegate.states << '\n';
      Require(received,
              "actual video frames or vehicle.state were not received");
      Require(!encoded || received_feedback,
              "encoded source feedback did not return over IPC");
      // Stop renewing authorization while the observer remains in the Room.
      const auto stopped_by = std::chrono::steady_clock::now() + 4s;
      int status = 0;
      pid_t result = 0;
      while (std::chrono::steady_clock::now() < stopped_by &&
             (result = waitpid(child.pid, &status, WNOHANG)) == 0)
        std::this_thread::sleep_for(20ms);
      Require(result == child.pid, "backend did not leave on demand expiry");
      child.pid = -1;
      Require(WIFEXITED(status) && WEXITSTATUS(status) == 0,
              "backend cleanup did not complete successfully");
      observer.disconnect();
    }
    livekit::shutdown();
    std::cout << (encoded ? "encoded H264" : "simulation")
              << " RTC video/state received; demand expiry left Room\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "LiveKit integration test failed: " << error.what() << '\n';
    return 1;
  }
}
