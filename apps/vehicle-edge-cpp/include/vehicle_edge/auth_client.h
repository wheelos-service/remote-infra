#pragma once

#include <chrono>
#include <stdexcept>
#include <string>

#include "vehicle_edge/http_client.h"

namespace vehicle_edge {

class AuthClientError : public std::runtime_error {
public:
  AuthClientError(std::string code, const std::string &message,
                  long http_status = 0);
  const std::string &code() const noexcept { return code_; }
  long http_status() const noexcept { return http_status_; }

private:
  std::string code_;
  long http_status_;
};

// One instance per network task; tokens and curl handles are not shared.
class AuthenticatedClient {
public:
  explicit AuthenticatedClient(DeviceConfig config);
  void AcquireToken();
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
