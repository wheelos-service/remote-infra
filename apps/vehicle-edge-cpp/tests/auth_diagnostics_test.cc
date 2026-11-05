#include "vehicle_edge/diagnostics.h"
#include "vehicle_edge/http_client.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

void Require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}

struct TestResponse {
  TestResponse(int status, std::string body = {}, std::string request_id = {},
               std::string error_code = {},
               std::string interim_request_id = {},
               std::string interim_error_code = {},
               int delay_ms = 0)
      : status(status), body(std::move(body)),
        request_id(std::move(request_id)), error_code(std::move(error_code)),
        interim_request_id(std::move(interim_request_id)),
        interim_error_code(std::move(interim_error_code)),
        delay_ms(delay_ms) {}

  int status;
  std::string body;
  std::string request_id;
  std::string error_code;
  std::string interim_request_id;
  std::string interim_error_code;
  int delay_ms;
};

std::string Reason(int status) {
  if (status == 200)
    return "OK";
  if (status == 204)
    return "No Content";
  if (status == 401)
    return "Unauthorized";
  if (status == 403)
    return "Forbidden";
  if (status == 405)
    return "Method Not Allowed";
  return "Service Unavailable";
}

class LocalHTTPServer {
public:
  explicit LocalHTTPServer(std::vector<TestResponse> responses)
      : responses_(std::move(responses)) {
    socket_ = socket(AF_INET, SOCK_STREAM, 0);
    if (socket_ < 0)
      throw std::runtime_error("test socket setup failed");
    int reuse = 1;
    setsockopt(socket_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    if (bind(socket_, reinterpret_cast<sockaddr *>(&address), sizeof(address)) <
            0 ||
        listen(socket_, static_cast<int>(responses_.size())) < 0) {
      close(socket_);
      throw std::runtime_error("test HTTP listener setup failed");
    }
    socklen_t address_size = sizeof(address);
    if (getsockname(socket_, reinterpret_cast<sockaddr *>(&address),
                    &address_size) < 0) {
      close(socket_);
      throw std::runtime_error("test HTTP address lookup failed");
    }
    url_ = "http://127.0.0.1:" + std::to_string(ntohs(address.sin_port));
    worker_ = std::thread([this] { Serve(); });
  }

  ~LocalHTTPServer() {
    if (worker_.joinable()) {
      shutdown(socket_, SHUT_RDWR);
      close(socket_);
      worker_.join();
      socket_ = -1;
    }
    if (socket_ >= 0)
      close(socket_);
  }

  const std::string &URL() const { return url_; }
  const std::vector<std::string> &requests() const { return requests_; }

  void Finish() {
    if (worker_.joinable())
      worker_.join();
    close(socket_);
    socket_ = -1;
    Require(requests_.size() == responses_.size(),
            "unexpected number of local HTTP requests");
  }

private:
  void Serve() {
    for (const auto &response : responses_) {
      int client = accept(socket_, nullptr, nullptr);
      if (client < 0)
        return;
      std::string request;
      char buffer[2048];
      std::size_t expected = 0;
      while (request.find("\r\n\r\n") == std::string::npos ||
             request.size() < expected) {
        const auto count = recv(client, buffer, sizeof(buffer), 0);
        if (count <= 0)
          break;
        request.append(buffer, static_cast<std::size_t>(count));
        const auto headers_end = request.find("\r\n\r\n");
        if (headers_end != std::string::npos) {
          expected = headers_end + 4;
          const auto content_length = request.find("Content-Length:");
          if (content_length != std::string::npos &&
              content_length < headers_end) {
            const auto start = content_length + std::strlen("Content-Length:");
            expected += static_cast<std::size_t>(
                std::stoul(request.substr(start, headers_end - start)));
          }
        }
      }
      requests_.push_back(std::move(request));
      if (response.delay_ms > 0)
        std::this_thread::sleep_for(
            std::chrono::milliseconds(response.delay_ms));
      if (response.status == 0) {
        shutdown(client, SHUT_RDWR);
        close(client);
        continue;
      }
      const auto body = response.body;
      std::string wire;
      if (!response.interim_request_id.empty() ||
          !response.interim_error_code.empty()) {
        wire = "HTTP/1.1 103 Early Hints\r\n";
        if (!response.interim_request_id.empty())
          wire += "X-Request-ID: " + response.interim_request_id + "\r\n";
        if (!response.interim_error_code.empty())
          wire += "X-Error-Code: " + response.interim_error_code + "\r\n";
        wire += "\r\n";
      }
      wire += "HTTP/1.1 " + std::to_string(response.status) + " " +
                         Reason(response.status) + "\r\nContent-Length: " +
                         std::to_string(body.size()) +
                         "\r\nConnection: close\r\n";
      if (!response.request_id.empty())
        wire += "X-Request-ID: " + response.request_id + "\r\n";
      if (!response.error_code.empty())
        wire += "X-Error-Code: " + response.error_code + "\r\n";
      wire += "\r\n" + body;
      std::size_t sent = 0;
      while (sent < wire.size()) {
        const auto count = send(client, wire.data() + sent,
                                wire.size() - sent, MSG_NOSIGNAL);
        if (count <= 0)
          break;
        sent += static_cast<std::size_t>(count);
      }
      shutdown(client, SHUT_RDWR);
      close(client);
    }
  }

  int socket_ = -1;
  std::string url_;
  std::vector<TestResponse> responses_;
  std::vector<std::string> requests_;
  std::thread worker_;
};

class ProtectedConfigFile {
public:
  explicit ProtectedConfigFile(const std::string &contents) {
    path_ = ".vehicle_auth_diagnostics_" + std::to_string(getpid()) + ".json";
    const int fd =
        open(path_.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd < 0)
      throw std::runtime_error("could not create protected diagnostic config");
    std::size_t written = 0;
    while (written < contents.size()) {
      const auto count =
          write(fd, contents.data() + written, contents.size() - written);
      if (count <= 0) {
        close(fd);
        unlink(path_.c_str());
        throw std::runtime_error("could not write protected diagnostic config");
      }
      written += static_cast<std::size_t>(count);
    }
    struct stat info {};
    if (fchmod(fd, 0600) != 0 || fstat(fd, &info) != 0 ||
        !S_ISREG(info.st_mode) || info.st_uid != 0 ||
        (info.st_mode & 0777) != 0600) {
      close(fd);
      unlink(path_.c_str());
      throw std::runtime_error("test config is not protected as required");
    }
    close(fd);
  }

  ~ProtectedConfigFile() { unlink(path_.c_str()); }

  const std::string &path() const { return path_; }

private:
  std::string path_;
};

vehicle_edge::DeviceConfig Config(const std::string &url) {
  Json::Value config(Json::objectValue);
  config["vehicle_id"] = "car-a";
  config["gateway_url"] = url;
  config["token_url"] = url;
  config["client_id"] = "synthetic-client";
  config["client_secret"] = "synthetic-client-secret";
  config["allow_insecure_localhost"] = true;
  return vehicle_edge::ParseConfig(config);
}

std::string ConfigJSON(const std::string &url) {
  Json::Value config(Json::objectValue);
  config["vehicle_id"] = "car-a";
  config["gateway_url"] = url;
  config["token_url"] = url;
  config["client_id"] = "synthetic-client";
  config["client_secret"] = "synthetic-client-secret";
  config["allow_insecure_localhost"] = true;
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  return Json::writeString(writer, config);
}

std::vector<TestResponse> SuccessfulResponses() {
  return {{200, R"({"access_token":"synthetic-oauth-token","expires_in":60})",
           "", ""},
          {200, R"({"Name":"vehicle-car-a","Roles":["vehicle"]})",
           "gateway-identity-123", ""},
          {204, "", "gateway-mapping-456", ""},
          {200, R"({"token":"synthetic-livekit-token"})",
           "gateway-token-789", ""}};
}

void SuccessAndCompatibility() {
  LocalHTTPServer server(SuccessfulResponses());
  const auto report =
      vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
  server.Finish();
  Require(report.passed && report.stages.size() == 4 &&
              report.stages[0].name == "oauth_token_acquisition" &&
              report.stages[1].name == "gateway_identity" &&
              report.stages[2].name == "vehicle_subject_mapping" &&
              report.stages[3].name == "livekit_token_issuance",
          "programmatic diagnostic stages were not in expected order");
  Require(report.stages[0].label != "protected device configuration",
          "programmatic diagnostic made a protected-file claim");
  const auto text = vehicle_edge::DiagnosticReportText(report);
  Require(
      std::count(text.begin(), text.end(), '\n') == 4,
      "legacy text output did not include exactly one final scope note");
  Require(text.find("RTC/video/Cyber/control were not tested") !=
              std::string::npos,
          "legacy text output omitted the diagnostic scope note");
  const auto json = vehicle_edge::DiagnosticReportJSON(report);
  Json::Value decoded;
  std::string errors;
  Json::CharReaderBuilder reader_builder;
  std::unique_ptr<Json::CharReader> reader(reader_builder.newCharReader());
  Require(reader->parse(json.data(), json.data() + json.size(), &decoded,
                        &errors),
          "diagnostic output was not valid JSON");
  Require(decoded["stages"][1]["request_id"].asString() ==
              "gateway-identity-123" &&
              decoded["stages"][2]["request_id"].asString() ==
                  "gateway-mapping-456" &&
              decoded["stages"][3]["request_id"].asString() ==
                  "gateway-token-789",
          "Gateway request identifiers were not preserved");
  Require(decoded["scope_note"].asString().find("not tested") !=
              std::string::npos,
          "diagnostic scope note is missing");
  Require(json.find("synthetic-client-secret") == std::string::npos &&
              json.find("synthetic-oauth-token") == std::string::npos &&
              json.find("synthetic-livekit-token") == std::string::npos,
          "diagnostic JSON leaked a credential or issued token");
  Require(text.find("[OK] protected device configuration") ==
                  std::string::npos &&
              text.find("[OK] OAuth token accepted by Gateway with vehicle permission") !=
                  std::string::npos &&
              text.find("[OK] Gateway issued a short-lived vehicle LiveKit token; token discarded") !=
                  std::string::npos,
          "legacy text output was not preserved");
  for (const auto &request : server.requests()) {
    Require(request.find("Accept: application/json") != std::string::npos,
            "diagnostic did not request JSON errors");
  }
}

void ProtectedPathProducesSingleConfigurationStage() {
  if (geteuid() != 0) {
    std::cout << "SKIP protected config path regression: test requires root "
                 "to create the required root-owned mode-0600 file\n";
    return;
  }
  LocalHTTPServer server(SuccessfulResponses());
  ProtectedConfigFile config_file(ConfigJSON(server.URL()));
  const auto report =
      vehicle_edge::RunVehicleAuthDiagnostic(config_file.path());
  server.Finish();
  Require(report.passed && report.stages.size() == 5,
          "path diagnostic did not report five successful stages");
  const char *expected[] = {"configuration", "oauth_token_acquisition",
                            "gateway_identity", "vehicle_subject_mapping",
                            "livekit_token_issuance"};
  for (std::size_t i = 0; i < report.stages.size(); ++i)
    Require(report.stages[i].name == expected[i],
            "path diagnostic stages were duplicated or out of order");
  const auto text = vehicle_edge::DiagnosticReportText(report);
  const auto first = text.find("[OK] protected device configuration");
  Require(first != std::string::npos &&
              text.find("[OK] protected device configuration", first + 1) ==
                  std::string::npos,
          "path diagnostic printed duplicate configuration success");
}

void OAuthFailureIsSecretSafe() {
  LocalHTTPServer server({{401, "body contains synthetic-provider-secret", "",
                           ""}});
  const auto report =
      vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
  server.Finish();
  Require(!report.passed && report.stages.back().name ==
                                "oauth_token_acquisition" &&
              report.stages.back().code == "oauth_http_error" &&
              report.stages.back().http_status == 401,
          "OAuth HTTP failure was not assigned to its observed stage");
  const auto json = vehicle_edge::DiagnosticReportJSON(report);
  Require(json.find("synthetic-provider-secret") == std::string::npos &&
              json.find("synthetic-client-secret") == std::string::npos,
          "OAuth failure report leaked provider body or client secret");
  const auto text = vehicle_edge::DiagnosticReportText(report);
  Require(text.find("synthetic-provider-secret") == std::string::npos &&
              text.find("synthetic-client-secret") == std::string::npos,
          "OAuth text report leaked provider body or client secret");
}

void TransportFailuresRemainAtObservedStage() {
  {
    LocalHTTPServer server({{0, "", "", ""}});
    const auto report =
        vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
    server.Finish();
    Require(!report.passed &&
                report.stages.back().name == "oauth_token_acquisition" &&
                report.stages.back().code == "oauth_transport_error",
            "OAuth transport failure was not attributed to token acquisition");
  }
  {
    LocalHTTPServer server(
        {{200, R"({"access_token":"synthetic-oauth-token","expires_in":60})",
          "", ""},
         {0, "", "", ""}});
    const auto report =
        vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
    server.Finish();
    Require(!report.passed && report.stages.back().name == "gateway_identity" &&
                report.stages.back().code ==
                    "gateway_identity_transport_error",
            "Gateway transport failure was not attributed to identity");
  }
}

void ExpiredTokenRefreshKeepsOAuthFailureAtRequestStage() {
  LocalHTTPServer server(
      {{200, R"({"access_token":"synthetic-oauth-token","expires_in":5})", "",
        "", "", "", 1400},
       {200, R"({"Name":"vehicle-car-a","Roles":["vehicle"]})",
        "identity-request-id", "", "", "", 1400},
       {204, "", "mapping-request-id", "", "", "", 1400},
       {503, "provider secret", "", ""}});
  const auto report =
      vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
  server.Finish();
  const auto &failure = report.stages.back();
  Require(!report.passed && failure.name == "livekit_token_issuance" &&
              failure.code == "oauth_http_error" &&
              failure.http_status == 503 &&
              failure.message.find(
                  "OAuth refresh failed before vehicle LiveKit token issuance request") !=
                  std::string::npos,
          "lazy OAuth refresh failure was misreported as a Gateway transport error");
  const auto json = vehicle_edge::DiagnosticReportJSON(report);
  const auto text = vehicle_edge::DiagnosticReportText(report);
  Require(json.find("provider secret") == std::string::npos &&
              text.find("provider secret") == std::string::npos,
          "OAuth refresh failure leaked the provider response body");
}

void GatewayFailuresKeepSafeCodesAndRequestIDs() {
  {
    auto responses = SuccessfulResponses();
    responses.erase(responses.begin() + 2, responses.end());
    responses[0].body =
        R"({"access_token":"synthetic-oauth-token","expires_in":60})";
    responses[1] = {401, "raw body with synthetic-secret",
                    "gateway-auth-req", "AUTH_INVALID_TOKEN"};
    LocalHTTPServer server(std::move(responses));
    const auto report =
        vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
    server.Finish();
    const auto json = vehicle_edge::DiagnosticReportJSON(report);
    Require(report.stages.back().name == "gateway_identity" &&
                report.stages.back().code == "gateway_identity_http_error" &&
                report.stages.back().request_id == "gateway-auth-req" &&
                report.stages.back().gateway_error_code ==
                    "AUTH_INVALID_TOKEN",
            "Gateway identity failure details were not safely captured");
    Require(json.find("raw body") == std::string::npos &&
                json.find("synthetic-secret") == std::string::npos,
            "Gateway identity report leaked a raw error body");
    const auto text = vehicle_edge::DiagnosticReportText(report);
    Require(text.find("raw body") == std::string::npos &&
                text.find("synthetic-secret") == std::string::npos,
            "Gateway identity text report leaked a raw error body");
  }
  {
    auto responses = SuccessfulResponses();
    responses.erase(responses.begin() + 3, responses.end());
    responses[2] = {403, "legacy plain text failure", "mapping-req",
                    "VEHICLE_NOT_REGISTERED"};
    LocalHTTPServer server(std::move(responses));
    const auto report =
        vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
    server.Finish();
    Require(report.stages.back().name == "vehicle_subject_mapping" &&
                report.stages.back().gateway_error_code ==
                    "VEHICLE_NOT_REGISTERED" &&
                report.stages.back().request_id == "mapping-req",
            "vehicle mapping failure stage or correlation was lost");
  }
  {
    auto responses = SuccessfulResponses();
    responses[3] = {503, "provider secret in body", "media-req",
                    "MEDIA_TOKEN_ISSUANCE_FAILED"};
    LocalHTTPServer server(std::move(responses));
    const auto report =
        vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
    server.Finish();
    const auto json = vehicle_edge::DiagnosticReportJSON(report);
    Require(report.stages.back().name == "livekit_token_issuance" &&
                report.stages.back().gateway_error_code ==
                    "MEDIA_TOKEN_ISSUANCE_FAILED" &&
                report.stages.back().request_id == "media-req" &&
                json.find("provider secret") == std::string::npos,
            "token issuance failure was not stage-specific and secret-safe");
  }
}

void InvalidResponsesAndConfigurationAreSafe() {
  {
    LocalHTTPServer server({{200, "not json containing synthetic-secret", "",
                             ""}});
    const auto report =
        vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
    server.Finish();
    Require(report.stages.back().name == "oauth_token_acquisition" &&
                report.stages.back().code == "oauth_response_invalid",
            "malformed OAuth response was not attributed to token acquisition");
    Require(vehicle_edge::DiagnosticReportJSON(report).find(
                "synthetic-secret") == std::string::npos,
            "malformed OAuth response body leaked into report");
  }
  const auto report = vehicle_edge::RunVehicleAuthDiagnostic(
      "/dev/null");
  Require(!report.passed && report.stages.size() == 1 &&
              report.stages.front().name == "configuration" &&
              report.stages.front().code == "configuration_invalid",
          "configuration failure did not produce a diagnostic stage");
}

void InvalidRequestIDIsDiscarded() {
  for (const auto &request_id :
       {std::string("request-id-with space"), std::string(129, 'a')}) {
    LocalHTTPServer server(
        {{200, R"({"access_token":"synthetic-oauth-token","expires_in":60})",
          "", ""},
         {200, R"({"Name":"vehicle-car-a","Roles":["vehicle"]})",
          request_id, ""},
         {204, "", "", ""},
         {200, R"({"token":"synthetic-livekit-token"})", "", ""}});
    const auto report =
        vehicle_edge::RunVehicleAuthDiagnostic(Config(server.URL()));
    server.Finish();
    Require(report.passed && report.stages[1].request_id.empty(),
            "unsafe or oversized request identifier was not discarded");
  }
}

void InterimHeadersAndNewGatewayCodesAreHandled() {
  LocalHTTPServer server(
      {{200, "{}", "final-request-id", "", "interim-request-id",
        "AUTH_INVALID_TOKEN"},
       {503, "", "vehicle-service-id",
        "VEHICLE_IDENTITY_SERVICE_UNAVAILABLE"},
       {405, "", "method-not-allowed-id", "METHOD_NOT_ALLOWED"}});
  vehicle_edge::HTTPClient client;
  const auto interim = client.Get(server.URL(), "", true);
  const auto service =
      client.Get(server.URL(), "", true);
  const auto method = client.Get(server.URL(), "", true);
  server.Finish();
  Require(interim.status == 200 &&
              interim.request_id == "final-request-id" &&
              interim.error_code.empty(),
          "interim response headers were attributed to the final response");
  Require(service.error_code == "VEHICLE_IDENTITY_SERVICE_UNAVAILABLE" &&
              method.error_code == "METHOD_NOT_ALLOWED",
          "planned Gateway error code was not safely recognized");
}

} // namespace

int main() {
  try {
    SuccessAndCompatibility();
    ProtectedPathProducesSingleConfigurationStage();
    OAuthFailureIsSecretSafe();
    GatewayFailuresKeepSafeCodesAndRequestIDs();
    InvalidResponsesAndConfigurationAreSafe();
    TransportFailuresRemainAtObservedStage();
    ExpiredTokenRefreshKeepsOAuthFailureAtRequestStage();
    InvalidRequestIDIsDiscarded();
    InterimHeadersAndNewGatewayCodesAreHandled();
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
  return 0;
}
