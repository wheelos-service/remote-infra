#pragma once

#include <chrono>

#include "vehicle_edge/http_client.h"

namespace vehicle_edge {

// One instance per network task; tokens and curl handles are not shared.
class AuthenticatedClient {
public:
  explicit AuthenticatedClient(DeviceConfig config);
  HTTPResponse Get(const std::string &path);
  HTTPResponse Post(const std::string &path, const std::string &body);

private:
  void RefreshToken();
  void EnsureToken();
  void ValidatePath(const std::string &path) const;
  DeviceConfig config_;
  HTTPClient http_;
  std::string access_token_;
  std::chrono::steady_clock::time_point expires_at_;
};

} // namespace vehicle_edge
