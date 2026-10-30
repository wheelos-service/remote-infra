#include <chrono>
#include <fstream>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>

#include <livekit/livekit.h>

#include "vehicle_edge/http_client.h"
#include "vehicle_edge/media_backend.h"
#include "vehicle_edge/media_service.h"

namespace {
using namespace std::chrono_literals;

void Require(bool condition, const char *reason) {
  if (!condition)
    throw std::runtime_error(reason);
}

struct Controller : livekit::RoomDelegate {
  std::mutex mutex;
  Json::Value feedback;
  void
  onUserPacketReceived(livekit::Room &,
                       const livekit::UserDataPacketEvent &event) override {
    if (event.topic != "vehicle.control.feedback.v2" ||
        event.kind != livekit::DataPacketKind::Reliable || !event.participant ||
        event.participant->identity() != "vehicle-car-2")
      return;
    const auto value = vehicle_edge::ParseHTTPJSON(
        std::string(event.data.begin(), event.data.end()));
    std::lock_guard<std::mutex> lock(mutex);
    feedback = value;
  }
  template <class Predicate> Json::Value Wait(Predicate predicate) {
    const auto until = std::chrono::steady_clock::now() + 10s;
    while (std::chrono::steady_clock::now() < until) {
      {
        std::lock_guard<std::mutex> lock(mutex);
        if (predicate(feedback))
          return feedback;
      }
      std::this_thread::sleep_for(10ms);
    }
    throw std::runtime_error("control feedback timeout");
  }
};

struct SDK {
  SDK() { livekit::initialize(livekit::LogLevel::Off); }
  ~SDK() { livekit::shutdown(); }
};

} // namespace

int main(int argc, char **argv) {
  try {
    if (argc == 2) {
      // Test-only worker loader. This binary is never shipped; the installed
      // vehicle_media_worker continues to require protected LoadConfig.
      std::ifstream file(argv[1]);
      Json::Value value;
      file >> value;
      return vehicle_edge::RunMediaBackend(vehicle_edge::ParseConfig(value));
    }
    Json::Value input;
    std::cin >> input;
    const auto config = vehicle_edge::ParseConfig(input["config"]);
    const auto signer = input["signer_url"].asString();
    vehicle_edge::HTTPClient http;
    const auto post = [&](const std::string &path, const Json::Value &body,
                          long expected) {
      const auto response =
          http.Post(config.gateway_url + path, "application/json",
                    vehicle_edge::EncodeJSON(body), "controller", true);
      Require(response.status == expected, "control HTTP mutation rejected");
      if (response.status != 200 && response.status != 202)
        return Json::Value();
      return response.body.empty() ? Json::Value()
                                   : vehicle_edge::ParseHTTPJSON(response.body);
    };
    const auto key = http.Get(signer + "/public", "", true);
    Require(key.status == 200, "frontend signer unavailable");
    Json::Value acquire = vehicle_edge::ParseHTTPJSON(key.body);
    acquire["protocol_version"] = 2;
    acquire["client_instance_id"] = "control-chain-test";
    const auto session =
        post("/api/vehicles/car-2/control/acquire", acquire, 200);
    // Same operator cannot control another vehicle, even with separate rooms.
    post("/api/vehicles/car-1/control/acquire", acquire, 409);

    SDK sdk;
    auto cache = std::make_shared<vehicle_edge::StateCache>();
    vehicle_edge::MediaService service(config, input["config_path"].asString(),
                                       cache, "control-chain");
    Controller delegate;
    livekit::Room room;
    room.setDelegate(&delegate);
    livekit::RoomOptions options;
    options.auto_subscribe = false;
    options.join_retries = 0;
    Require(
        room.connect(config.livekit_url, session["token"].asString(), options),
        "controller RTC connection failed");
    const auto local = room.localParticipant().lock();
    Require(local != nullptr, "controller unavailable");
    const auto ready = delegate.Wait(
        [](const Json::Value &v) { return v["status"] == "READY"; });
    Json::Value payload;
    payload["version"] = 2;
    payload["type"] = "control";
    payload["vehicle_id"] = "car-2";
    payload["session_id"] = session["session"]["session_id"];
    payload["client_instance_id"] = "control-chain-test";
    payload["receiver_instance_id"] = ready["receiver_instance_id"];
    payload["revision"] = ready["revision"];
    payload["sequence"] = 1;
    payload["timestamp_ms"] = Json::Int64(vehicle_edge::UnixMilliseconds());
    payload["command"]["steering"] = 100;
    payload["command"]["throttle"] = 100;
    payload["command"]["brake"] = 0;
    payload["command"]["direction"] = 1;
    const auto sign = [&] {
      payload["timestamp_ms"] = Json::Int64(vehicle_edge::UnixMilliseconds());
      const auto response =
          http.Post(signer + "/sign", "application/json",
                    vehicle_edge::EncodeJSON(payload), "", true);
      Require(response.status == 200, "frontend signing failed");
      return response.body;
    };
    const auto publish = [&](const std::string &body) {
      local->publishData(std::vector<std::uint8_t>(body.begin(), body.end()),
                         true, {}, "vehicle.control.v2");
    };
    const auto signed_body = sign();
    auto tampered = vehicle_edge::ParseHTTPJSON(signed_body);
    tampered["command"]["throttle"] = 200;
    publish(vehicle_edge::EncodeJSON(tampered));
    delegate.Wait([](const Json::Value &v) {
      return v["last_rejection"] == "invalid_signature";
    });
    // Refresh the timestamp after waiting for the rejection feedback.
    const auto fresh_signed_body = sign();
    publish(fresh_signed_body);
    delegate.Wait([](const Json::Value &v) {
      return v["status"] == "APPLIED" && v["accepted_sequence"] == 1;
    });
    publish(sign());
    delegate.Wait(
        [](const Json::Value &v) { return v["last_rejection"] == "replay"; });
    const auto stopped = delegate.Wait(
        [](const Json::Value &v) { return v["status"] == "LOCKED"; });
    Require(stopped["command"].isNull() &&
                stopped["reason"] == "command_timeout",
            "watchdog did not clear simulated execution");
    payload["sequence"] = 2;
    publish(sign());
    delegate.Wait([](const Json::Value &v) {
      return v["last_rejection"] == "not_authorized" &&
             v["accepted_sequence"] == 1;
    });
    post("/api/control/" + session["session"]["session_id"].asString() +
             "/release",
         Json::Value(Json::objectValue), 202);
    const auto until = std::chrono::steady_clock::now() + 5s;
    bool confirmed = false;
    while (std::chrono::steady_clock::now() < until) {
      const auto response =
          http.Get(config.gateway_url + "/api/vehicles/car-2/control/handover",
                   "controller", true);
      Require(response.status == 200, "handover read failed");
      const auto state = vehicle_edge::ParseHTTPJSON(response.body);
      if (state["state"] == "CONFIRMED" &&
          state["session_id"] == session["session"]["session_id"]) {
        confirmed = true;
        break;
      }
      std::this_thread::sleep_for(50ms);
    }
    Require(confirmed, "simulation handover did not complete");
    post("/api/vehicles/car-1/control/acquire", acquire, 200);
    service.Stop();
    room.disconnect();
    std::cout << "real Gateway + frontend Ed25519 + RTC + C++ IPC/simulator: "
                 "feedback, replay/tamper rejection, watchdog, handover and "
                 "single-vehicle switch passed\n";
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
