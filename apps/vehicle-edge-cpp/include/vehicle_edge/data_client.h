#pragma once

#include <optional>

#include "vehicle_edge/auth_client.h"

namespace vehicle_edge {

class TelemetryUploader {
public:
  explicit TelemetryUploader(DeviceConfig config);
  void Upload(const Json::Value &packet);
  void UploadMission(const Json::Value &report);

private:
  std::string vehicle_id_;
  AuthenticatedClient client_;
};

class DataClient {
public:
  explicit DataClient(DeviceConfig config)
      : vehicle_id_(config.vehicle_id), client_(std::move(config)) {}
  void Publish(const std::string &kind, const Json::Value &payload);
  std::optional<Json::Value> PullTask();

private:
  std::string vehicle_id_;
  AuthenticatedClient client_;
};

} // namespace vehicle_edge
