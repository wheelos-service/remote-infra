#include "vehicle_edge/auth_client.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace vehicle_edge {

AuthClientError::AuthClientError(std::string code, const std::string &message,
                                 long http_status)
    : std::runtime_error(message), code_(std::move(code)),
      http_status_(http_status) {}

AuthenticatedClient::AuthenticatedClient(DeviceConfig config)
    : config_(std::move(config)) {}

void AuthenticatedClient::RefreshToken() {
  const auto started = std::chrono::steady_clock::now();
  HTTPResponse response{};
  try {
    response =
        http_.Post(config_.token_url, "application/x-www-form-urlencoded",
                   "grant_type=client_credentials&client_id=" +
                       http_.Escape(config_.client_id) +
                       "&client_secret=" + http_.Escape(config_.client_secret),
                   "", config_.allow_insecure_localhost);
  } catch (...) {
    throw AuthClientError("oauth_transport_error",
                          "OAuth token request failed at the transport");
  }
  if (response.status != 200)
    throw AuthClientError("oauth_http_error",
                          "OAuth token endpoint rejected the request",
                          response.status);
  Json::Value value;
  try {
    value = ParseHTTPJSON(response.body);
  } catch (...) {
    throw AuthClientError("oauth_response_invalid",
                          "OAuth token response was not valid JSON");
  }
  if (!value["access_token"].isString() ||
      !ValidBearerToken(value["access_token"].asString()) ||
      !value["expires_in"].isNumeric())
    throw AuthClientError("oauth_response_invalid",
                          "OAuth token response was incomplete or invalid");
  const auto seconds = value["expires_in"].asDouble();
  if (!std::isfinite(seconds) || seconds < 5 || seconds > 86400)
    throw AuthClientError("oauth_expiry_invalid",
                          "OAuth expiry was outside the supported range");
  access_token_ = value["access_token"].asString();
  expires_at_ = started + std::chrono::milliseconds(
                              static_cast<std::int64_t>(seconds * 800));
}

void AuthenticatedClient::EnsureToken() {
  if (access_token_.empty() || std::chrono::steady_clock::now() >= expires_at_)
    RefreshToken();
}

void AuthenticatedClient::AcquireToken() { EnsureToken(); }

void AuthenticatedClient::ValidatePath(const std::string &path) const {
  if (path.rfind("/api/", 0) != 0 ||
      std::any_of(path.begin(), path.end(),
                  [](unsigned char ch) { return ch <= 0x20 || ch >= 0x7f; }) ||
      path.find_first_of("?#\\\r\n") != std::string::npos ||
      path.find("/../") != std::string::npos ||
      path.find("/./") != std::string::npos ||
      (path.size() >= 3 && path.compare(path.size() - 3, 3, "/..") == 0) ||
      (path.size() >= 2 && path.compare(path.size() - 2, 2, "/.") == 0) ||
      path.find('%') != std::string::npos)
    throw std::invalid_argument("device request requires a literal API path");
}

HTTPResponse AuthenticatedClient::Get(const std::string &path) {
  ValidatePath(path);
  EnsureToken();
  auto response = http_.Get(config_.gateway_url + path, access_token_,
                            config_.allow_insecure_localhost);
  if (response.status == 401)
    access_token_.clear();
  return response;
}

HTTPResponse AuthenticatedClient::Post(const std::string &path,
                                       const std::string &body) {
  ValidatePath(path);
  if (body.size() > 65536)
    throw std::invalid_argument("device request body exceeds 64 KiB");
  EnsureToken();
  auto response =
      http_.Post(config_.gateway_url + path, "application/json", body,
                 access_token_, config_.allow_insecure_localhost);
  if (response.status == 401)
    access_token_.clear();
  return response;
}

} // namespace vehicle_edge
