#pragma once

#include <string>

#include <json/json.h>

namespace vehicle_edge {

struct DeviceConfig {
  std::string vehicle_id;
  std::string gateway_url;
  std::string token_url;
  std::string client_id;
  std::string client_secret;
  std::string chassis_channel = "/apollo/canbus/chassis";
  std::string localization_channel = "/apollo/localization/pose";
  std::string node_name = "remote_vehicle_telemetry";
  int upload_interval_ms = 1000;
  bool allow_insecure_localhost = false;
  bool media_enabled = false;
  std::string livekit_url;
  std::string media_worker_path;
  std::string camera_source;
  std::string control_mode = "disabled";
  std::string camera_track = "camera0";
  std::string mission_runtime_channel;
  std::string mission_result_channel;
  std::string system_status_channel;
  std::string data_store_path;
  std::string task_mode = "disabled";
  std::string map_id;
  std::string vehicle_model;
  std::string software_version;
  std::string mission_request_channel;
};

DeviceConfig ParseConfig(const Json::Value &value);
DeviceConfig LoadConfig(const std::string &path);
bool AllowedURL(const std::string &url, bool allow_insecure_localhost);

} // namespace vehicle_edge
