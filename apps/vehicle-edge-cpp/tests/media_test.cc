#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

#include "vehicle_edge/media_demand.h"
#include "vehicle_edge/media_service.h"

namespace {

using vehicle_edge::DemandGate;
using vehicle_edge::MediaState;
using namespace std::chrono_literals;

void Require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}

Json::Value Demand(Json::Int64 revision = 1, Json::Int64 server_time = 10000,
                   bool required = true) {
  Json::Value value;
  value["vehicle_id"] = "car-a";
  value["epoch"] = "12345678-1234-4234-8234-123456789abc";
  value["revision"] = revision;
  value["rtc_required"] = required;
  value["video_required"] = required;
  value["viewer_count"] = required ? 1 : 0;
  value["control_required"] = false;
  value["server_time_ms"] = server_time;
  value["valid_until_ms"] = server_time + 5000;
  value["retry_after_ms"] = 1000;
  return value;
}

void GateSemantics() {
  const auto start = std::chrono::steady_clock::now();
  DemandGate gate("car-a");
  Require(!gate.Current(start).required, "initial authorization was ON");
  Require(gate.Accept(Demand(), start, start + 1500ms),
          "valid demand rejected");
  auto authorization = gate.Current(start + 1500ms);
  Require(authorization.required && authorization.deadline == start + 5s,
          "full request duration was not subtracted");
  Require(!gate.Current(start + 5s).required, "expiry had a grace period");
  Require(gate.Accept(Demand(1, 12000), start + 2s, start + 2200ms),
          "same revision renewal rejected");
  Require(gate.Current(start + 6s).required, "renewal did not extend deadline");
  auto old = Demand(1, 13000);
  old["revision"] = 0;
  Require(!gate.Accept(old, start + 3s, start + 3100ms) &&
              !gate.Current(start + 3100ms).required,
          "invalid revision did not fail closed");
  Require(gate.Accept(Demand(3, 14000), start + 4s, start + 4100ms),
          "new revision rejected");
  Require(!gate.Accept(Demand(2, 15000), start + 5s, start + 5100ms),
          "old same-epoch revision accepted");
  Require(!gate.Current(start + 5100ms).required,
          "stale response kept media ON");
  Require(gate.Accept(Demand(3, 16000), start + 6s, start + 6100ms),
          "recovery rejected");
  Require(!gate.Accept(Demand(3, 16000), start + 7s, start + 7100ms),
          "cached response extended authorization");
  auto epoch = Demand(1, 17000);
  epoch["epoch"] = "87654321-4321-4321-8321-cba987654321";
  const auto generation = gate.Current(start + 7s).generation;
  Require(gate.Accept(epoch, start + 8s, start + 8100ms) &&
              gate.Current(start + 8100ms).generation > generation,
          "epoch change did not invalidate generation");
  Require(!gate.Accept(Demand(99, 18000), start + 9s, start + 9100ms),
          "retired epoch revived");

  DemandGate off("car-a");
  Require(off.Accept(Demand(), start, start) &&
              off.Accept(Demand(2, 11000, false), start + 1s, start + 1s) &&
              !off.Current(start + 1s).required,
          "zero demand retained authorization");
  DemandGate expired("car-a");
  Require(!expired.Accept(Demand(), start, start + 5s),
          "late response accepted");
  auto malformed = Demand();
  malformed["valid_until_ms"] = 15001;
  Require(!expired.Accept(malformed, start, start),
          "TTL over five seconds accepted");
  malformed = Demand();
  malformed["vehicle_id"] = "car-b";
  Require(!expired.Accept(malformed, start, start), "other vehicle accepted");
  malformed = Demand();
  malformed["video_required"] = false;
  Require(!expired.Accept(malformed, start, start),
          "inconsistent demand accepted");
  malformed = Demand();
  malformed["extra"] = true;
  Require(!expired.Accept(malformed, start, start),
          "unknown demand field accepted");
  malformed = Demand();
  malformed["epoch"] = "not-a-uuid";
  Require(!expired.Accept(malformed, start, start), "invalid epoch accepted");
  malformed = Demand();
  malformed["control_required"] = true;
  malformed["viewer_count"] = 0;
  Require(expired.Accept(malformed, start, start),
          "active control demand without viewer rejected");
  expired.Fail();
  Require(!expired.Current(start).required,
          "transport error retained authorization");
}

void ProcessSemantics(const std::string &executable) {
  vehicle_edge::MediaProcess process;
  Require(!process.Start("/missing/vehicle-media-worker", "unused") &&
              process.state() == MediaState::ERROR,
          "missing executable did not report ERROR");
  Require(process.Start(executable, "--test-active-worker") &&
              process.state() == MediaState::STARTING,
          "worker did not enter STARTING");
  vehicle_edge::MediaAuthorization authorization;
  authorization.required = true;
  authorization.generation = 1;
  authorization.deadline = std::chrono::steady_clock::now() + 1s;
  Require(process.Send(Json::Value(Json::objectValue), authorization),
          "authorized snapshot not sent");
  const auto wait_until = std::chrono::steady_clock::now() + 1s;
  while (process.state() != MediaState::ACTIVE &&
         std::chrono::steady_clock::now() < wait_until) {
    Require(process.Poll(), "worker died before ACTIVE");
    std::this_thread::sleep_for(5ms);
  }
  Require(process.state() == MediaState::ACTIVE, "worker did not enter ACTIVE");
  vehicle_edge::EncodedFrame frame;
  frame.data = {0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x68, 0x01, 0, 0, 1, 0x65, 0x01};
  frame.width = 640;
  frame.height = 480;
  frame.keyframe = true;
  frame.timestamp_us = 1;
  Require(process.SendFrame(std::move(frame)),
          "owned worker encoded channel not inherited");
  bool feedback_received = false;
  const auto feedback_by = std::chrono::steady_clock::now() + 1s;
  while (!feedback_received && std::chrono::steady_clock::now() < feedback_by) {
    if (auto feedback = process.Feedback())
      feedback_received = feedback->keyframe_requested &&
                          feedback->target_bitrate_bps == 500000;
    std::this_thread::sleep_for(5ms);
  }
  Require(feedback_received, "owned worker video feedback not returned");
  authorization.required = false;
  Require(!process.Send(Json::Value(), authorization), "OFF snapshot sent");
  authorization.required = true;
  authorization.deadline = std::chrono::steady_clock::now() - 1ms;
  Require(!process.Send(Json::Value(), authorization), "expired snapshot sent");
  auto started = std::chrono::steady_clock::now();
  process.Stop();
  Require(process.state() == MediaState::OFF &&
              std::chrono::steady_clock::now() - started < 750ms,
          "stalled SDK cancellation was not bounded");
  Require(process.Start(executable, "--test-exit-worker"), "restart failed");
  const auto exit_by = std::chrono::steady_clock::now() + 1s;
  while (process.Poll() && std::chrono::steady_clock::now() < exit_by)
    std::this_thread::sleep_for(5ms);
  Require(process.state() == MediaState::ERROR, "worker failure was not ERROR");
  process.Stop();
}

} // namespace

int main(int argc, char **argv) {
  if (argc == 2 && std::string(argv[1]) == "--test-active-worker") {
    signal(SIGTERM, SIG_IGN);
    char buffer[65536];
    if (recv(3, buffer, sizeof(buffer), 0) <= 0 ||
        send(3, "A", 1, MSG_NOSIGNAL) != 1)
      return 2;
    while (!vehicle_edge::ReceiveEncodedFrame(4))
      std::this_thread::sleep_for(5ms);
    if (!vehicle_edge::SendVideoFeedback(4, {true, 500000, 15}))
      return 2;
    for (;;)
      pause();
  }
  if (argc == 2 && std::string(argv[1]) == "--test-exit-worker")
    return 3;
  try {
    GateSemantics();
    ProcessSemantics("/proc/self/exe");
    std::cout
        << "demand freshness, fail-closed and bounded lifecycle tests passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "media test failed: " << error.what() << '\n';
    return 1;
  }
}
