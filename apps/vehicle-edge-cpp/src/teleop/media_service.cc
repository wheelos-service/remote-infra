#include "vehicle_edge/media_service.h"

#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <iostream>
#include <stdexcept>

#include "vehicle_edge/teleop_client.h"

extern char **environ;

namespace vehicle_edge {

MediaProcess::~MediaProcess() { Stop(); }

bool MediaProcess::Start(const std::string &executable,
                         const std::string &config_path) {
  Stop();
  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets) != 0) {
    state_ = MediaState::ERROR;
    return false;
  }
  int video[2];
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, video) != 0) {
    close(sockets[0]);
    close(sockets[1]);
    state_ = MediaState::ERROR;
    return false;
  }
  // Stage child descriptors away from both fixed inherited destinations.
  const int control_child = fcntl(sockets[1], F_DUPFD_CLOEXEC, 10);
  const int video_child = fcntl(video[1], F_DUPFD_CLOEXEC, 10);
  close(sockets[1]);
  close(video[1]);
  posix_spawn_file_actions_t actions;
  if (control_child < 0 || video_child < 0 ||
      posix_spawn_file_actions_init(&actions) != 0) {
    close(sockets[0]);
    close(video[0]);
    if (control_child >= 0)
      close(control_child);
    if (video_child >= 0)
      close(video_child);
    state_ = MediaState::ERROR;
    return false;
  }
  int error = posix_spawn_file_actions_adddup2(&actions, control_child, 3);
  if (!error)
    error = posix_spawn_file_actions_adddup2(&actions, video_child, 4);
  char *args[] = {const_cast<char *>(executable.c_str()),
                  const_cast<char *>(config_path.c_str()), nullptr};
  pid_t child = -1;
  if (!error)
    error = posix_spawn(&child, executable.c_str(), &actions, nullptr, args,
                        environ);
  posix_spawn_file_actions_destroy(&actions);
  close(control_child);
  close(video_child);
  if (error) {
    close(sockets[0]);
    close(video[0]);
    state_ = MediaState::ERROR;
    return false;
  }
  pid_ = child;
  socket_ = sockets[0];
  video_socket_ = video[0];
  frame_sequence_ = 0;
  state_ = MediaState::STARTING;
  return true;
}

bool MediaProcess::SendFrame(EncodedFrame frame) {
  frame.sequence = ++frame_sequence_;
  return SendEncodedFrame(video_socket_, frame);
}

std::optional<VideoFeedback> MediaProcess::Feedback() {
  return ReceiveVideoFeedback(video_socket_);
}

bool MediaProcess::Send(const Json::Value &snapshot,
                        const MediaAuthorization &authorization,
                        const Json::Value &sources,
                        const Json::Value &control_feedback) {
  if (socket_ < 0 || !authorization.required ||
      std::chrono::steady_clock::now() >= authorization.deadline)
    return false;
  Json::Value message;
  message["generation"] = Json::UInt64(authorization.generation);
  message["deadline_ns"] =
      Json::Int64(std::chrono::duration_cast<std::chrono::nanoseconds>(
                      authorization.deadline.time_since_epoch())
                      .count());
  message["snapshot"] = snapshot;
  message["sources"] = sources;
  message["control_feedback"] = control_feedback;
  const auto body = EncodeJSON(message);
  if (body.size() > 65536)
    return false;
  const auto sent =
      send(socket_, body.data(), body.size(), MSG_DONTWAIT | MSG_NOSIGNAL);
  // Drop snapshots under backpressure; the absolute deadline never moves.
  return sent == static_cast<ssize_t>(body.size()) ||
         (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
}

bool MediaProcess::Poll(ControlService *control) {
  if (pid_ < 0)
    return false;
  int status;
  const auto result = waitpid(pid_, &status, WNOHANG);
  if (result == pid_ || (result < 0 && errno == ECHILD)) {
    pid_ = -1;
    close(socket_);
    socket_ = -1;
    close(video_socket_);
    video_socket_ = -1;
    state_ = MediaState::ERROR;
    return false;
  }
  for (int i = 0; i < 16; ++i) {
    char buffer[4097];
    const auto count = recv(socket_, buffer, sizeof(buffer), MSG_DONTWAIT);
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
      break;
    if (count == 1 && buffer[0] == 'A') {
      state_ = MediaState::ACTIVE;
      continue;
    }
    if (count <= 0 || count > 4096 || !control)
      return false;
    try {
      const auto packet = ParseHTTPJSON(std::string(buffer, count));
      if (!packet.isObject() || packet.size() != 3 ||
          !packet["sender"].isString() || !packet["body"].isString() ||
          !packet["received_ns"].isInt64())
        return false;
      control->Receive(packet["sender"].asString(), packet["body"].asString(),
                       SteadyTime(std::chrono::nanoseconds(
                           packet["received_ns"].asInt64())));
    } catch (const std::exception &) {
      control->Invalidate("invalid_control_ipc");
      return false;
    }
  }
  return true;
}

void MediaProcess::Stop() {
  if (pid_ >= 0) {
    state_ = MediaState::STOPPING;
    int status;
    pid_t result;
    do {
      result = waitpid(pid_, &status, WNOHANG);
    } while (result < 0 && errno == EINTR);
    if (result == 0) {
      // Only signal a still-owned child, never a PID reaped by another handler.
      shutdown(socket_, SHUT_RDWR);
      kill(pid_, SIGTERM);
      const auto deadline =
          std::chrono::steady_clock::now() + std::chrono::milliseconds(200);
      for (;;) {
        result = waitpid(pid_, &status, WNOHANG);
        if (result == pid_ || (result < 0 && errno == ECHILD))
          break;
        if (std::chrono::steady_clock::now() >= deadline) {
          kill(pid_, SIGKILL);
          while (waitpid(pid_, &status, 0) < 0 && errno == EINTR) {
          }
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
    }
    pid_ = -1;
  }
  if (socket_ >= 0) {
    close(socket_);
    socket_ = -1;
  }
  if (video_socket_ >= 0) {
    close(video_socket_);
    video_socket_ = -1;
  }
  state_ = MediaState::OFF;
}

MediaService::MediaService(DeviceConfig config, std::string config_path,
                           std::shared_ptr<StateCache> cache,
                           std::string stream_id)
    : config_(std::move(config)), config_path_(std::move(config_path)),
      cache_(std::move(cache)), stream_id_(std::move(stream_id)),
      gate_(config_.vehicle_id) {
  if (!cache_ || !ValidIdentifier(config_.vehicle_id) ||
      !ValidIdentifier(stream_id_) ||
      (config_.control_mode != "disabled" &&
       config_.control_mode != "simulation") ||
      (!config_.media_enabled && config_.control_mode != "disabled"))
    throw std::invalid_argument("media requires cache, vehicle and stream IDs");
  if (config_.media_enabled) {
    if (config_.media_worker_path.empty() ||
        config_.media_worker_path.front() != '/' || config_path_.empty() ||
        (config_.camera_source != "simulation" &&
         config_.camera_source != "h264_annexb"))
      throw std::invalid_argument(
          "media requires worker/config path and source");
    InitializeHTTPTransport();
    if (config_.control_mode == "simulation")
      control_ = std::make_unique<ControlService>(config_);
    poll_thread_ = std::thread(&MediaService::PollDemand, this);
    try {
      media_thread_ = std::thread(&MediaService::RunMedia, this);
    } catch (...) {
      stop_ = true;
      if (control_)
        control_->Stop();
      poll_thread_.join();
      throw;
    }
  }
}

MediaService::~MediaService() { Stop(); }

void MediaService::Stop() {
  std::lock_guard<std::mutex> stop_lock(stop_mutex_);
  stop_ = true;
  if (control_)
    control_->Invalidate("service_stopped");
  video_.Activate(false);
  if (media_thread_.joinable())
    media_thread_.join();
  if (control_)
    control_->Stop();
  if (poll_thread_.joinable())
    poll_thread_.join();
  state_ = MediaState::OFF;
}

FrameResult MediaService::SubmitEncodedFrame(EncodedFrame frame) {
  if (stop_ || config_.camera_source != "h264_annexb")
    return FrameResult::INACTIVE;
  return video_.Submit(std::move(frame), std::chrono::steady_clock::now());
}

VideoFeedback MediaService::TakeVideoFeedback() {
  return video_.TakeFeedback();
}

void MediaService::PollDemand() {
  try {
    TeleopClient client(config_);
    bool failed = false;
    while (!stop_) {
      const auto requested = std::chrono::steady_clock::now();
      bool accepted = false;
      try {
        const auto demand = client.Demand();
        const auto received = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lock(mutex_);
        accepted = gate_.Accept(demand, requested, received);
      } catch (const std::exception &) {
        std::lock_guard<std::mutex> lock(mutex_);
        gate_.Fail();
      }
      if (!accepted && !failed)
        std::cerr << "media demand unavailable; media authorization revoked\n";
      failed = !accepted;
      const auto next = requested + std::chrono::seconds(1);
      while (!stop_ && std::chrono::steady_clock::now() < next)
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
  } catch (const std::exception &) {
    std::lock_guard<std::mutex> lock(mutex_);
    gate_.Fail();
    std::cerr << "media demand task stopped; telemetry remains independent\n";
  }
}

void MediaService::RunMedia() {
  MediaProcess process;
  try {
    std::uint64_t generation = 0;
    std::uint64_t sequence = 0;
    auto retry_at = SteadyTime{};
    auto next_snapshot = SteadyTime{};
    while (!stop_) {
      const auto now = std::chrono::steady_clock::now();
      if (control_)
        control_->Feedback();
      MediaAuthorization authorization;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        authorization = gate_.Current(now);
      }
      if (!authorization.required || generation != authorization.generation) {
        if (control_ && process.state() != MediaState::OFF)
          control_->Invalidate("media_authority_lost");
        video_.Activate(false);
        state_ = MediaState::STOPPING;
        process.Stop();
        state_ = MediaState::OFF;
        generation = authorization.generation;
        retry_at = now;
      }
      if (authorization.required && now >= retry_at) {
        bool healthy = true;
        if (process.state() == MediaState::OFF ||
            process.state() == MediaState::ERROR) {
          healthy = process.Start(config_.media_worker_path, config_path_);
          state_ = process.state();
          next_snapshot = now;
        }
        if (healthy && now >= next_snapshot) {
          healthy = process.Send(
              cache_->Snapshot(config_.vehicle_id, stream_id_, ++sequence,
                               UnixMilliseconds(), now),
              authorization, cache_->AuxiliarySnapshot(now),
              control_ ? control_->Feedback() : Json::Value());
          next_snapshot = now + std::chrono::milliseconds(control_ ? 50 : 100);
        }
        if (healthy)
          healthy = process.Poll(control_.get());
        if (healthy)
          state_ = process.state();
        if (healthy && config_.camera_source == "h264_annexb") {
          try {
            video_.Activate(process.state() == MediaState::ACTIVE);
            if (auto frame = video_.Take(now)) {
              if (!process.SendFrame(std::move(*frame)))
                video_.Discontinuity();
            }
            if (auto feedback = process.Feedback())
              video_.Feedback(*feedback);
          } catch (const std::runtime_error &) {
            healthy = false;
          }
        }
        if (!healthy) {
          if (control_)
            control_->Invalidate("media_worker_failed");
          video_.Activate(false);
          process.Stop();
          state_ = MediaState::ERROR;
          retry_at = now + std::chrono::seconds(1);
          std::cerr << "media worker failed; retry requires valid demand\n";
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
  } catch (const std::exception &) {
    if (control_)
      control_->Invalidate("media_lifecycle_failed");
    video_.Activate(false);
    state_ = MediaState::ERROR;
    std::lock_guard<std::mutex> lock(mutex_);
    gate_.Fail();
    std::cerr
        << "media lifecycle task stopped; telemetry remains independent\n";
  }
  video_.Activate(false);
}

} // namespace vehicle_edge
