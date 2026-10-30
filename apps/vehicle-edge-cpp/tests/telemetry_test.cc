#include <arpa/inet.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "vehicle_edge/config.h"
#include "vehicle_edge/data_client.h"
#include "vehicle_edge/media_service.h"
#include "vehicle_edge/source_service.h"
#include "vehicle_edge/state_cache.h"
#include "vehicle_edge/teleop_client.h"

namespace {

void Require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}

template <typename F> void Rejects(F operation, const char *message) {
  bool rejected = false;
  try {
    operation();
  } catch (const std::exception &) {
    rejected = true;
  }
  Require(rejected, message);
}

class LoopbackServer {
public:
  explicit LoopbackServer(std::vector<std::string> responses)
      : responses_(std::move(responses)) {
    fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (fd_ < 0)
      throw std::runtime_error("test socket failed");
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    socklen_t size = sizeof(address);
    if (bind(fd_, reinterpret_cast<sockaddr *>(&address), size) != 0 ||
        getsockname(fd_, reinterpret_cast<sockaddr *>(&address), &size) != 0 ||
        listen(fd_, 4) != 0) {
      close(fd_);
      throw std::runtime_error("test listener failed");
    }
    port_ = ntohs(address.sin_port);
    thread_ = std::thread([this] { Serve(); });
  }

  ~LoopbackServer() {
    shutdown(fd_, SHUT_RDWR);
    thread_.join();
    close(fd_);
  }

  std::string URL() const {
    return "http://127.0.0.1:" + std::to_string(port_);
  }

  void Finish() {
    thread_.join();
    Require(!failed_, "loopback request did not complete");
    // Keep destructor's join safe after explicit completion.
    thread_ = std::thread([] {});
  }

  std::vector<std::string> requests;

private:
  void Serve() {
    for (const auto &response : responses_) {
      pollfd event{fd_, POLLIN, 0};
      if (poll(&event, 1, 5000) != 1) {
        failed_ = true;
        return;
      }
      const int client = accept(fd_, nullptr, nullptr);
      if (client < 0) {
        failed_ = true;
        return;
      }
      std::string request;
      char buffer[2048];
      bool complete = false;
      while (request.size() <= 65536) {
        pollfd incoming{client, POLLIN, 0};
        if (poll(&incoming, 1, 3000) != 1)
          break;
        const auto count = recv(client, buffer, sizeof(buffer), 0);
        if (count <= 0)
          break;
        request.append(buffer, static_cast<std::size_t>(count));
        const auto end = request.find("\r\n\r\n");
        const auto length = request.find("Content-Length: ");
        if (end != std::string::npos) {
          const auto body_size = length == std::string::npos
                                     ? 0
                                     : std::stoul(request.substr(length + 16));
          if (request.size() >= end + 4 + body_size) {
            complete = true;
            break;
          }
        }
      }
      if (complete) {
        requests.push_back(request);
        const auto sent =
            send(client, response.data(), response.size(), MSG_NOSIGNAL);
        if (sent != static_cast<ssize_t>(response.size()))
          failed_ = true;
      } else {
        failed_ = true;
      }
      close(client);
      if (failed_)
        return;
    }
  }

  int fd_;
  unsigned int port_;
  std::vector<std::string> responses_;
  std::thread thread_;
  bool failed_ = false;
};

std::string Response(int code, const std::string &body) {
  return "HTTP/1.1 " + std::to_string(code) +
         " Test\r\nContent-Type: application/json\r\nConnection: "
         "close\r\nContent-Length: " +
         std::to_string(body.size()) + "\r\n\r\n" + body;
}

Json::Value Config(const std::string &endpoint) {
  Json::Value value;
  value["vehicle_id"] = "car-a";
  value["gateway_url"] = endpoint;
  value["token_url"] = endpoint + "/oauth/token";
  value["client_id"] = "test-client";
  value["client_secret"] = "test-only-not-a-credential";
  value["allow_insecure_localhost"] = true;
  return value;
}

Json::Value Example() {
  vehicle_edge::StateCache cache;
  const auto now = std::chrono::steady_clock::now();
  vehicle_edge::ChassisState chassis;
  chassis.speed_mps = 2.5;
  chassis.gear_location = "GEAR_DRIVE";
  chassis.driving_mode = "COMPLETE_AUTO_DRIVE";
  chassis.battery_soc_percentage = 75;
  cache.UpdateChassis(chassis, {1000000, 0}, now);
  vehicle_edge::LocalizationState localization;
  localization.x = 123.5;
  localization.y = 456.25;
  localization.heading_rad = 0.75;
  localization.frame_id = "map";
  cache.UpdateLocalization(localization, {1000000, 5}, now);
  return cache.Snapshot("car-a", "boot-a", 1, 1000000, now);
}

void StateSemantics() {
  vehicle_edge::StateCache cache;
  const auto now = std::chrono::steady_clock::now();
  auto packet = cache.Snapshot("car-a", "boot-a", 1, 1000000, now);
  Require(packet["chassis"]["message"].isNull(), "missing sample is not null");
  Require(packet["chassis"]["age_ms"].isNull(), "missing sample looks fresh");
  vehicle_edge::ChassisState state;
  state.speed_mps = std::numeric_limits<double>::quiet_NaN();
  state.battery_soc_percentage = -1;
  state.steering_percentage = 101;
  state.gear_location = "NOT_A_GEAR";
  state.parking_brake = false;
  cache.UpdateChassis(state, {}, now);
  packet = cache.Snapshot("car-a", "boot-a", 2, 1000200,
                          now + std::chrono::milliseconds(200));
  const auto &chassis = packet["chassis"];
  Require(chassis["age_ms"].asInt() == 200, "sample did not age");
  Require(chassis["source_timestamp_ms"].isNull(),
          "source timestamp fabricated");
  Require(chassis["message"]["speed_mps"].isNull(), "NaN not normalized");
  Require(chassis["message"]["battery_soc_percentage"].isNull(),
          "missing SOC became zero");
  Require(chassis["message"]["steering_percentage"].isNull(),
          "invalid percentage accepted");
  Require(chassis["message"]["gear_location"].isNull(),
          "unknown gear accepted");
  Require(chassis["message"]["parking_brake"].isBool(), "false became missing");
  Require(vehicle_edge::EncodeJSON(packet).find("NaN") == std::string::npos,
          "JSON contains NaN");
  Rejects([&] { cache.Snapshot("../car", "boot", 1, 1, now); },
          "invalid id accepted");
  Rejects([&] { cache.Snapshot("car", "boot", 0, 1, now); },
          "invalid sequence accepted");
}

void URLAndConfigSemantics() {
  using vehicle_edge::AllowedURL;
  Require(AllowedURL("https://gateway.example.com", false), "HTTPS rejected");
  Require(!AllowedURL("http://gateway.example.com", true),
          "remote plaintext allowed");
  Require(!AllowedURL("http://127.0.0.1", false),
          "implicit insecure mode allowed");
  Require(!AllowedURL("https://u:password@example.com", false),
          "URL credentials allowed");
  Require(!AllowedURL("https://example.com?token=bad", false), "query allowed");
  Require(!AllowedURL("file:///etc/passwd", true), "non-HTTP protocol allowed");
  auto config = Config("http://127.0.0.1");
  Require(vehicle_edge::ParseConfig(config).vehicle_id == "car-a",
          "valid config rejected");
  Require(!vehicle_edge::ParseConfig(config).media_enabled,
          "media enabled without explicit configuration");
  auto media = config;
  media["media_enabled"] = true;
  Rejects([&] { vehicle_edge::ParseConfig(media); },
          "media enabled without explicit camera and endpoint");
  media["livekit_url"] = "ws://127.0.0.1:7880";
  media["media_worker_path"] = "/opt/vehicle-edge/bin/vehicle_media_worker";
  media["camera_source"] = "simulation";
  Require(vehicle_edge::ParseConfig(media).media_enabled,
          "explicit loopback simulation rejected");
  media["camera_source"] = "h264_annexb";
  Require(vehicle_edge::ParseConfig(media).camera_source == "h264_annexb",
          "explicit encoded-frame ingress rejected");
  media["camera_source"] = "v4l2";
  Rejects([&] { vehicle_edge::ParseConfig(media); },
          "unimplemented camera source accepted");
  media["camera_source"] = "simulation";
  media["livekit_url"] = "wss://rtc.example.com?token=forbidden";
  Rejects([&] { vehicle_edge::ParseConfig(media); },
          "RTC endpoint accepted a token query");
  media["livekit_url"] = "ws://rtc.example.com";
  Rejects([&] { vehicle_edge::ParseConfig(media); },
          "insecure nonloopback RTC accepted");
  config["upload_interval_ms"] = 0;
  Rejects([&] { vehicle_edge::ParseConfig(config); },
          "busy-loop config accepted");
  config.removeMember("upload_interval_ms");
  config["unknown"] = true;
  Rejects([&] { vehicle_edge::ParseConfig(config); },
          "unknown config field accepted");
}

void HTTPAndOAuthSemantics() {
  const auto invalid_config =
      vehicle_edge::ParseConfig(Config("http://127.0.0.1:1"));
  vehicle_edge::AuthenticatedClient auth(invalid_config);
  for (const auto *path :
       {"https://other.invalid/api/state", "//other.invalid/api/state",
        "/api/../token", "/api/./token", "/api/state/..", "/api/state/.",
        "/api/%2e%2e/token", "/api/state?token=invalid", "/api/state\t"}) {
    try {
      auth.Get(path);
      throw std::runtime_error("invalid SDK path was accepted");
    } catch (const std::invalid_argument &) {
    }
    try {
      auth.Get(std::string("/api/state\0ignored", 18));
      throw std::runtime_error("embedded NUL path was accepted");
    } catch (const std::invalid_argument &) {
    }
  }
  try {
    auth.Post("/api/state", std::string(65537, 'x'));
    throw std::runtime_error("unbounded SDK upload was accepted");
  } catch (const std::invalid_argument &) {
  }
  LoopbackServer server({
      Response(200,
               R"({"access_token":"synthetic-test-token","expires_in":60})"),
      Response(204, ""),
      Response(401, ""),
      Response(200, R"({"access_token":"renewed-test-token","expires_in":60})"),
      Response(204, ""),
  });
  vehicle_edge::TelemetryUploader uploader(
      vehicle_edge::ParseConfig(Config(server.URL())));
  uploader.Upload(Example());
  Rejects([&] { uploader.Upload(Example()); }, "401 reported upload success");
  uploader.Upload(Example());
  server.Finish();
  Require(server.requests.size() == 5, "unexpected request count");
  Require(server.requests[0].find("grant_type=client_credentials") !=
              std::string::npos,
          "OAuth form missing");
  Require(server.requests[1].find("POST /api/vehicles/car-a/state") !=
              std::string::npos,
          "wrong vehicle path");
  Require(
      server.requests[1].find("Authorization: Bearer synthetic-test-token") !=
          std::string::npos,
      "authorization missing");
  Require(server.requests[1].find("test-only-not-a-credential") ==
              std::string::npos,
          "device credential leaked to telemetry");
  Require(server.requests[4].find("Authorization: Bearer renewed-test-token") !=
              std::string::npos,
          "401 did not invalidate token");
  LoopbackServer redirect({Response(302, "")});
  vehicle_edge::HTTPClient http;
  Require(
      http.Post(redirect.URL(), "application/json", "{}", "", true).status ==
          302,
      "redirect not surfaced");
  redirect.Finish();

  LoopbackServer demand_server({
      Response(200,
               R"({"access_token":"synthetic-test-token","expires_in":60})"),
      Response(200, R"({"rtc_required":false})"),
      Response(401, ""),
      Response(200, R"({"access_token":"renewed-test-token","expires_in":60})"),
      Response(200, R"({"token":"synthetic-rtc-token"})"),
  });
  vehicle_edge::TeleopClient media_client(
      vehicle_edge::ParseConfig(Config(demand_server.URL())));
  Require(media_client.Demand()["rtc_required"] == false,
          "demand response was not decoded");
  Rejects([&] { media_client.Demand(); }, "demand 401 reported success");
  Require(media_client.MediaToken() == "synthetic-rtc-token",
          "media token response was not decoded");
  demand_server.Finish();
  Require(demand_server.requests[1].find(
              "GET /api/vehicles/car-a/media-demand ") != std::string::npos &&
              demand_server.requests[4].find("GET /api/token/vehicle ") !=
                  std::string::npos,
          "wrong device GET endpoint or HTTP method");
  Require(demand_server.requests[1].find("test-only-not-a-credential") ==
                  std::string::npos &&
              demand_server.requests[4].find("renewed-test-token") !=
                  std::string::npos,
          "GET credential separation or 401 refresh failed");

  LoopbackServer invalid_media_server({
      Response(200, R"({"access_token":"sdk-test-token","expires_in":60})"),
      Response(202, R"({"rtc_required":true})"),
      Response(200, "{}"),
      Response(200, R"({"token":""})"),
      Response(200, R"({"token":42})"),
      Response(200, R"({"token":"invalid\nheader"})"),
      Response(200, "not-json"),
      Response(200, R"({"token":"invalid\u0000suffix"})"),
      Response(200, R"({"token":"invalid token"})"),
  });
  vehicle_edge::TeleopClient invalid_media(
      vehicle_edge::ParseConfig(Config(invalid_media_server.URL())));
  Rejects([&] { invalid_media.Demand(); },
          "pending demand response reported success");
  for (int i = 0; i < 7; ++i)
    Rejects([&] { invalid_media.MediaToken(); },
            "malformed media token response reported success");
  invalid_media_server.Finish();

  LoopbackServer invalid_auth_server({
      Response(200,
               R"({"access_token":"invalid\u0000suffix","expires_in":60})"),
      Response(200, R"({"access_token":"invalid token","expires_in":60})"),
  });
  vehicle_edge::AuthenticatedClient invalid_auth(
      vehicle_edge::ParseConfig(Config(invalid_auth_server.URL())));
  Rejects([&] { invalid_auth.Get("/api/example"); },
          "OAuth accepted embedded NUL token");
  Rejects([&] { invalid_auth.Get("/api/example"); },
          "OAuth accepted whitespace token");
  invalid_auth_server.Finish();

  LoopbackServer sdk_server({
      Response(200, R"({"access_token":"sdk-test-token","expires_in":60})"),
      Response(200, "{}"),
      Response(202, ""),
  });
  vehicle_edge::AuthenticatedClient standalone_auth(
      vehicle_edge::ParseConfig(Config(sdk_server.URL())));
  Require(standalone_auth.Get("/api/vehicles/car..a/state").status == 200,
          "valid dotted vehicle identifier rejected by auth SDK");
  Require(
      standalone_auth.Post("/api/example", "{}").status == 202,
      "auth SDK must preserve application status without fabricating success");
  sdk_server.Finish();

  LoopbackServer partial_server({
      Response(200, R"({"access_token":"sdk-test-token","expires_in":60})"),
      Response(202, ""),
  });
  vehicle_edge::TelemetryUploader partial(
      vehicle_edge::ParseConfig(Config(partial_server.URL())));
  Rejects([&] { partial.Upload(Example()); },
          "pending response counted as completed telemetry persistence");
  partial_server.Finish();

  LoopbackServer mission_server({
      Response(200,
               R"({"access_token":"synthetic-test-token","expires_in":60})"),
      Response(204, ""),
  });
  auto mission_config = vehicle_edge::ParseConfig(Config(mission_server.URL()));
  mission_config.mission_runtime_channel = "/isolated/test/mission-runtime";
  Json::Value mission;
  mission["mission_id"] = "mission-a";
  mission["status"] = "running";
  mission["updated_at_ms"] = 1000000;
  mission["description"] = "Authoritative Mission runtime";
  auto source_cache = std::make_shared<vehicle_edge::StateCache>();
  {
    vehicle_edge::SourceService sources(mission_config, source_cache);
    source_cache->UpdateMissionRuntime(
        Json::Value(), {}, std::chrono::steady_clock::now(), mission);
    mission_server.Finish();
  }
  Require(
      mission_server.requests[1].find(
          "POST /api/vehicles/car-a/mission-status ") != std::string::npos &&
          mission_server.requests[1].find("Authoritative Mission runtime") !=
              std::string::npos &&
          mission_server.requests[1].find("test-only-not-a-credential") ==
              std::string::npos,
      "Mission device-self endpoint or credential separation mismatch");
}

void MediaFailureDoesNotBlockTelemetry() {
  LoopbackServer demand_server({
      Response(200,
               R"({"access_token":"synthetic-test-token","expires_in":60})"),
      Response(
          200,
          R"({"vehicle_id":"car-a","epoch":"12345678-1234-4234-8234-123456789abc","revision":1,"rtc_required":true,"video_required":true,"viewer_count":1,"control_required":false,"server_time_ms":10000,"valid_until_ms":11500,"retry_after_ms":1000})"),
  });
  LoopbackServer telemetry_server({
      Response(200,
               R"({"access_token":"synthetic-test-token","expires_in":60})"),
      Response(204, ""),
      Response(204, ""),
      Response(204, ""),
  });
  auto config = vehicle_edge::ParseConfig(Config(demand_server.URL()));
  config.media_enabled = true;
  config.camera_source = "simulation";
  config.media_worker_path = "/missing/vehicle-media-worker";
  auto cache = std::make_shared<vehicle_edge::StateCache>();
  const auto started = std::chrono::steady_clock::now();
  {
    vehicle_edge::MediaService service(config, "unused", cache, "test-stream");
    const auto attempted_by = started + std::chrono::seconds(1);
    while (service.state() != vehicle_edge::MediaState::ERROR &&
           std::chrono::steady_clock::now() < attempted_by)
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    Require(service.state() == vehicle_edge::MediaState::ERROR,
            "media startup failure did not reach ERROR");
    vehicle_edge::TelemetryUploader telemetry(
        vehicle_edge::ParseConfig(Config(telemetry_server.URL())));
    for (std::uint64_t sequence = 1; sequence <= 3; ++sequence) {
      vehicle_edge::ChassisState chassis;
      chassis.speed_mps = static_cast<double>(sequence);
      const auto now = std::chrono::steady_clock::now();
      cache->UpdateChassis(chassis, {}, now);
      const auto packet =
          cache->Snapshot("car-a", "test-stream", sequence,
                          vehicle_edge::UnixMilliseconds(), now);
      Require(packet["chassis"]["message"]["speed_mps"].asDouble() ==
                  static_cast<double>(sequence),
              "media failure froze the source cache");
      telemetry.Upload(packet);
    }
    Require(std::chrono::steady_clock::now() - started <
                std::chrono::seconds(1),
            "media failure blocked independent telemetry");
    const auto off_by = started + std::chrono::milliseconds(1800);
    while (service.state() != vehicle_edge::MediaState::OFF &&
           std::chrono::steady_clock::now() < off_by)
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    Require(service.state() == vehicle_edge::MediaState::OFF,
            "demand expiry did not stop media during polling backoff");
  }
  demand_server.Finish();
  telemetry_server.Finish();
}

void StandaloneMediaLifecycle() {
  LoopbackServer server({
      Response(200, R"({"access_token":"sdk-test-token","expires_in":60})"),
      Response(
          200,
          R"({"vehicle_id":"car-a","epoch":"12345678-1234-4234-8234-123456789abc","revision":1,"rtc_required":true,"video_required":true,"viewer_count":1,"control_required":false,"server_time_ms":10000,"valid_until_ms":15000,"retry_after_ms":1000})"),
  });
  auto config = vehicle_edge::ParseConfig(Config(server.URL()));
  config.media_enabled = true;
  config.camera_source = "h264_annexb";
  config.media_worker_path = "/proc/self/exe";
  auto cache = std::make_shared<vehicle_edge::StateCache>();
  vehicle_edge::MediaService service(config, "--test-sdk-worker", cache,
                                     "standalone-stream");
  vehicle_edge::EncodedFrame frame;
  frame.data = {0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x68, 0x01, 0, 0, 1, 0x65, 0x01};
  frame.width = 640;
  frame.height = 480;
  frame.keyframe = true;
  const auto ready_by =
      std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (service.state() != vehicle_edge::MediaState::ACTIVE &&
         std::chrono::steady_clock::now() < ready_by)
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  Require(service.state() == vehicle_edge::MediaState::ACTIVE,
          "standalone SDK did not activate without operations upload");
  frame.timestamp_us = 1;
  // ACTIVE is externally visible just before the ingress gate is activated.
  auto result = vehicle_edge::FrameResult::INACTIVE;
  while (result == vehicle_edge::FrameResult::INACTIVE &&
         std::chrono::steady_clock::now() < ready_by) {
    result = service.SubmitEncodedFrame(frame);
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  Require(result == vehicle_edge::FrameResult::ACCEPTED,
          "standalone SDK rejected encoded frame");
  bool received = false;
  const auto feedback_by =
      std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (!received && std::chrono::steady_clock::now() < feedback_by) {
    received = service.TakeVideoFeedback().target_bitrate_bps == 500000;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  Require(received, "standalone service did not return worker feedback");
  std::thread first([&] { service.Stop(); });
  std::thread second([&] { service.Stop(); });
  first.join();
  second.join();
  Require(service.state() == vehicle_edge::MediaState::OFF &&
              service.SubmitEncodedFrame(frame) ==
                  vehicle_edge::FrameResult::INACTIVE &&
              !service.TakeVideoFeedback().keyframe_requested,
          "terminal Stop retained input gate or encoder feedback");
  service.Stop();
  server.Finish();
  Require(server.requests.size() == 2 &&
              server.requests[1].find("/media-demand") != std::string::npos,
          "standalone SDK used operations endpoint");
}

void InvalidEmbeddingInputs() {
  vehicle_edge::DeviceConfig config;
  config.vehicle_id = "car-a";
  auto cache = std::make_shared<vehicle_edge::StateCache>();
  Rejects([&] { vehicle_edge::MediaService service(config, "", nullptr, "s"); },
          "null cache accepted");
  Rejects([&] { vehicle_edge::MediaService service(config, "", cache, ""); },
          "empty stream accepted");
  config.media_enabled = true;
  Rejects([&] { vehicle_edge::MediaService service(config, "", cache, "s"); },
          "enabled media accepted without worker/config/source");
}

void BoundedRTCFeedback() {
  auto snapshot = Example();
  const auto ordinary = vehicle_edge::EncodeRTCState(snapshot, Json::Value());
  Require(ordinary &&
              ordinary->find("\"schema_version\":2") != std::string::npos &&
              snapshot["schema_version"] == 1,
          "RTC v2 was not separated from nested HTTPS telemetry v1");
  Json::Value sources;
  sources["oversized"] = std::string(20000, 'x');
  const auto bounded = vehicle_edge::EncodeRTCState(snapshot, sources);
  Require(bounded &&
              bounded->find("\"sources_omitted\":true") != std::string::npos &&
              bounded->find("\"vehicle_id\":\"car-a\"") != std::string::npos,
          "large diagnostics prevented bounded primary RTC feedback");
  snapshot["oversized"] = std::string(20000, 'x');
  Require(!vehicle_edge::EncodeRTCState(snapshot, Json::Value()),
          "oversized primary feedback was sent to the RTC transport");
}

} // namespace

int main(int argc, char **argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--test-sdk-worker") {
      char buffer[65536];
      if (recv(3, buffer, sizeof(buffer), 0) <= 0 ||
          send(3, "A", 1, MSG_NOSIGNAL) != 1)
        return 2;
      while (!vehicle_edge::ReceiveEncodedFrame(4))
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      if (!vehicle_edge::SendVideoFeedback(4, {true, 500000, 15}))
        return 2;
      while (recv(3, buffer, sizeof(buffer), 0) > 0) {
      }
      return 0;
    }
    if (argc == 2 && std::string(argv[1]) == "--snapshot") {
      std::cout << vehicle_edge::EncodeJSON(Example()) << '\n';
      return 0;
    }
    StateSemantics();
    URLAndConfigSemantics();
    HTTPAndOAuthSemantics();
    MediaFailureDoesNotBlockTelemetry();
    StandaloneMediaLifecycle();
    InvalidEmbeddingInputs();
    BoundedRTCFeedback();
    std::cout << "state, config, HTTP and OAuth tests passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "telemetry test failed: " << error.what() << '\n';
    return 1;
  }
}
