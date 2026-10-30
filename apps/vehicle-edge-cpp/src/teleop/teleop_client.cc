#include "vehicle_edge/teleop_client.h"

#include "vehicle_edge/state_cache.h"
#include <stdexcept>

namespace vehicle_edge {

TeleopClient::TeleopClient(DeviceConfig config)
    : vehicle_id_(config.vehicle_id), client_(std::move(config)) {}

Json::Value TeleopClient::Get(const std::string &path) {
  const auto response = client_.Get(path);
  if (response.status != 200)
    throw std::runtime_error("device request rejected (HTTP " +
                             std::to_string(response.status) + ")");
  return ParseHTTPJSON(response.body);
}

Json::Value TeleopClient::Demand() {
  return Get("/api/vehicles/" + vehicle_id_ + "/media-demand");
}

std::string TeleopClient::MediaToken() {
  const auto response = Get("/api/token/vehicle");
  if (!response["token"].isString() ||
      !ValidBearerToken(response["token"].asString()))
    throw std::runtime_error("invalid media token response");
  return response["token"].asString();
}

Json::Value TeleopClient::ControlContext() {
  return Get("/api/vehicles/" + vehicle_id_ + "/control/context");
}

void TeleopClient::ConfirmSimulation(const std::string &session_id,
                                     std::int64_t revision) {
  Json::Value ack;
  ack["session_id"] = session_id;
  ack["revision"] = Json::Int64(revision);
  if (client_
          .Post("/api/vehicles/" + vehicle_id_ + "/control/simulation-ack",
                EncodeJSON(ack))
          .status != 204)
    throw std::runtime_error("simulation handover rejected");
}

} // namespace vehicle_edge
