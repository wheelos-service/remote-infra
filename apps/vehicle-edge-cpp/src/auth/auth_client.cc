#include "vehicle_edge/auth_client.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace vehicle_edge {

AuthenticatedClient::AuthenticatedClient(DeviceConfig config)
    : config_(std::move(config)) {}

void AuthenticatedClient::RefreshToken() {
  const auto started = std::chrono::steady_clock::now();
  const auto response =
      http_.Post(config_.token_url, "application/x-www-form-urlencoded",
                 "grant_type=client_credentials&client_id=" +
                     http_.Escape(config_.client_id) +
                     "&client_secret=" + http_.Escape(config_.client_secret),
                 "", config_.allow_insecure_localhost);
  if (response.status != 200)
    throw std::runtime_error("OAuth request rejected (HTTP " +
                             std::to_string(response.status) + ")");
  const auto value = ParseHTTPJSON(response.body);
  if (!value["access_token"].isString() ||
      !ValidBearerToken(value["access_token"].asString()) ||
      !value["expires_in"].isNumeric())
    throw std::runtime_error(
        "OAuth response requires access_token and expires_in");
  const auto seconds = value["expires_in"].asDouble();
  if (!std::isfinite(seconds) || seconds < 5 || seconds > 86400)
    throw std::runtime_error("OAuth expiry must be within 5..86400 seconds");
  access_token_ = value["access_token"].asString();
  expires_at_ = started + std::chrono::milliseconds(
                              static_cast<std::int64_t>(seconds * 800));
}

void AuthenticatedClient::EnsureToken() {
  if (access_token_.empty() || std::chrono::steady_clock::now() >= expires_at_)
    RefreshToken();
}

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
