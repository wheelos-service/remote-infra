#pragma once

#include <chrono>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>

#include <json/json.h>

namespace vehicle_edge {

using SteadyTime = std::chrono::steady_clock::time_point;

struct SourceMetadata {
  std::optional<std::int64_t> timestamp_ms;
  std::optional<std::uint32_t> sequence;
};

struct ChassisState {
  std::optional<double> speed_mps;
  std::optional<std::string> gear_location;
  std::optional<std::string> driving_mode;
  std::optional<double> steering_percentage;
  std::optional<double> throttle_percentage;
  std::optional<double> brake_percentage;
  std::optional<double> battery_soc_percentage;
  std::optional<bool> parking_brake;
  std::optional<int> error_code;
  std::optional<std::int32_t> chassis_error_mask;
};

struct LocalizationState {
  std::optional<double> x;
  std::optional<double> y;
  std::optional<double> z;
  std::optional<double> heading_rad;
  std::optional<std::string> frame_id;
};

class StateCache {
public:
  void UpdateChassis(const ChassisState &state, const SourceMetadata &source,
                     SteadyTime received);
  void UpdateLocalization(const LocalizationState &state,
                          const SourceMetadata &source, SteadyTime received);
  void UpdateMissionRuntime(const Json::Value &message,
                            const SourceMetadata &source, SteadyTime received,
                            std::optional<Json::Value> report);
  void UpdateMissionResult(const Json::Value &message, SteadyTime received);
  void UpdateSystemStatus(const Json::Value &message,
                          const SourceMetadata &source, SteadyTime received);
  Json::Value AuxiliarySnapshot(SteadyTime now) const;
  std::optional<Json::Value> MissionReport() const;
  Json::Value Snapshot(const std::string &vehicle_id,
                       const std::string &stream_id, std::uint64_t sequence,
                       std::int64_t published_at_ms, SteadyTime now) const;

private:
  struct Sample {
    Json::Value message;
    SourceMetadata source;
    std::optional<SteadyTime> received;
  };
  static Json::Value EncodeSample(const Sample &sample, SteadyTime now);
  mutable std::mutex mutex_;
  Sample chassis_;
  Sample localization_;
  Sample mission_runtime_;
  Sample mission_result_;
  Sample system_status_;
  std::optional<Json::Value> mission_report_;
};

std::string EncodeJSON(const Json::Value &value);
std::optional<std::string> EncodeRTCState(const Json::Value &snapshot,
                                          const Json::Value &sources);
std::int64_t UnixMilliseconds();
std::string NewStreamID();
bool ValidIdentifier(const std::string &value);

} // namespace vehicle_edge
