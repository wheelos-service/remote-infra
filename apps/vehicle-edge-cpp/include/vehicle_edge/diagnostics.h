#pragma once

#include <chrono>
#include <string>
#include <vector>

#include "vehicle_edge/config.h"

namespace vehicle_edge {

struct DiagnosticStage {
  std::string name;
  std::string label;
  long long elapsed_ms = 0;
  bool passed = false;
  std::string code;
  std::string message;
  long http_status = 0;
  std::string request_id;
  std::string gateway_error_code;
  std::chrono::steady_clock::time_point started_at;
};

struct DiagnosticReport {
  std::vector<DiagnosticStage> stages;
  bool passed = false;
};

DiagnosticReport RunVehicleAuthDiagnostic(const std::string &config_path);
DiagnosticReport RunVehicleAuthDiagnostic(const DeviceConfig &config);
std::string DiagnosticReportJSON(const DiagnosticReport &report);
std::string DiagnosticReportText(const DiagnosticReport &report);

} // namespace vehicle_edge
