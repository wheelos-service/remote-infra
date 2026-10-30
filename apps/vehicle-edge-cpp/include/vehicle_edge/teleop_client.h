#pragma once

#include "vehicle_edge/auth_client.h"

namespace vehicle_edge {

// Session transport only; media demand and tokens do not grant driving
// authority.
class TeleopClient {
public:
  explicit TeleopClient(DeviceConfig config);
  Json::Value Demand();
  std::string MediaToken();
  Json::Value ControlContext();
  void ConfirmSimulation(const std::string &session_id, std::int64_t revision);

private:
  Json::Value Get(const std::string &path);
  std::string vehicle_id_;
  AuthenticatedClient client_;
};

} // namespace vehicle_edge
