#include "vehicle_edge/state_cache.h"

#include <cmath>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace vehicle_edge {
namespace {

constexpr std::uint64_t kMaxSafeInteger = 9007199254740991ULL;

Json::Value Number(const std::optional<double> &value) {
  return value && std::isfinite(*value) ? Json::Value(*value) : Json::Value();
}

Json::Value Percentage(const std::optional<double> &value, double minimum) {
  return value && std::isfinite(*value) && *value >= minimum && *value <= 100
             ? Json::Value(*value)
             : Json::Value();
}

Json::Value Enum(const std::optional<std::string> &value,
                 std::initializer_list<const char *> allowed) {
  if (value) {
    for (const auto *option : allowed) {
      if (*value == option)
        return *value;
    }
  }
  return Json::Value();
}

} // namespace

bool ValidIdentifier(const std::string &value) {
  if (value.empty() || value.size() > 64)
    return false;
  const auto alphanumeric = [](char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9');
  };
  if (!alphanumeric(value.front()))
    return false;
  for (const char c : value) {
    if (!alphanumeric(c) && c != '_' && c != '.' && c != '-')
      return false;
  }
  return true;
}

void StateCache::UpdateChassis(const ChassisState &state,
                               const SourceMetadata &source,
                               SteadyTime received) {
  Json::Value message(Json::objectValue);
  message["speed_mps"] = Number(state.speed_mps);
  message["gear_location"] =
      Enum(state.gear_location,
           {"GEAR_NEUTRAL", "GEAR_DRIVE", "GEAR_REVERSE", "GEAR_PARKING",
            "GEAR_LOW", "GEAR_INVALID", "GEAR_NONE"});
  message["driving_mode"] =
      Enum(state.driving_mode,
           {"COMPLETE_MANUAL", "COMPLETE_AUTO_DRIVE", "AUTO_STEER_ONLY",
            "AUTO_SPEED_ONLY", "EMERGENCY_MODE"});
  message["steering_percentage"] = Percentage(state.steering_percentage, -100);
  message["throttle_percentage"] = Percentage(state.throttle_percentage, 0);
  message["brake_percentage"] = Percentage(state.brake_percentage, 0);
  message["battery_soc_percentage"] =
      Percentage(state.battery_soc_percentage, 0);
  message["parking_brake"] =
      state.parking_brake ? Json::Value(*state.parking_brake) : Json::Value();
  message["error_code"] =
      state.error_code && *state.error_code >= 0 && *state.error_code <= 9
          ? Json::Value(*state.error_code)
          : Json::Value();
  message["chassis_error_mask"] = state.chassis_error_mask
                                      ? Json::Value(*state.chassis_error_mask)
                                      : Json::Value();
  std::lock_guard<std::mutex> lock(mutex_);
  chassis_ = {std::move(message), source, received};
}

void StateCache::UpdateLocalization(const LocalizationState &state,
                                    const SourceMetadata &source,
                                    SteadyTime received) {
  Json::Value message(Json::objectValue);
  Json::Value position(Json::objectValue);
  position["x"] = Number(state.x);
  position["y"] = Number(state.y);
  position["z"] = Number(state.z);
  message["position"] = std::move(position);
  message["heading_rad"] = Number(state.heading_rad);
  message["frame_id"] = state.frame_id && state.frame_id->size() <= 128
                            ? Json::Value(*state.frame_id)
                            : Json::Value();
  std::lock_guard<std::mutex> lock(mutex_);
  localization_ = {std::move(message), source, received};
}

Json::Value StateCache::EncodeSample(const Sample &sample, SteadyTime now) {
  Json::Value result(Json::objectValue);
  if (sample.received) {
    const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(
                         now - *sample.received)
                         .count();
    result["age_ms"] = Json::Int64(age > 0 ? age : 0);
  } else {
    result["age_ms"] = Json::Value();
  }
  result["source_timestamp_ms"] =
      sample.source.timestamp_ms && *sample.source.timestamp_ms > 0 &&
              static_cast<std::uint64_t>(*sample.source.timestamp_ms) <=
                  kMaxSafeInteger
          ? Json::Value(Json::Int64(*sample.source.timestamp_ms))
          : Json::Value();
  result["source_sequence"] = sample.source.sequence
                                  ? Json::Value(*sample.source.sequence)
                                  : Json::Value();
  result["message"] = sample.message;
  return result;
}

Json::Value StateCache::Snapshot(const std::string &vehicle_id,
                                 const std::string &stream_id,
                                 std::uint64_t sequence,
                                 std::int64_t published_at_ms,
                                 SteadyTime now) const {
  if (!ValidIdentifier(vehicle_id) || !ValidIdentifier(stream_id) ||
      sequence == 0 || sequence > kMaxSafeInteger || published_at_ms <= 0 ||
      static_cast<std::uint64_t>(published_at_ms) > kMaxSafeInteger) {
    throw std::invalid_argument("invalid telemetry envelope");
  }
  Json::Value packet(Json::objectValue);
  packet["schema_version"] = 1;
  packet["type"] = "vehicle_telemetry";
  packet["vehicle_id"] = vehicle_id;
  packet["stream_id"] = stream_id;
  packet["sequence"] = Json::UInt64(sequence);
  packet["published_at_ms"] = Json::Int64(published_at_ms);
  std::lock_guard<std::mutex> lock(mutex_);
  packet["chassis"] = EncodeSample(chassis_, now);
  packet["localization"] = EncodeSample(localization_, now);
  return packet;
}

void StateCache::UpdateMissionRuntime(const Json::Value &message,
                                      const SourceMetadata &source,
                                      SteadyTime received,
                                      std::optional<Json::Value> report) {
  std::lock_guard<std::mutex> lock(mutex_);
  mission_runtime_ = {message, source, received};
  mission_report_ = std::move(report);
}

void StateCache::UpdateMissionResult(const Json::Value &message,
                                     SteadyTime received) {
  std::lock_guard<std::mutex> lock(mutex_);
  mission_result_ = {message, {}, received};
}

void StateCache::UpdateSystemStatus(const Json::Value &message,
                                    const SourceMetadata &source,
                                    SteadyTime received) {
  std::lock_guard<std::mutex> lock(mutex_);
  system_status_ = {message, source, received};
}

Json::Value StateCache::AuxiliarySnapshot(SteadyTime now) const {
  std::lock_guard<std::mutex> lock(mutex_);
  Json::Value value;
  value["mission_runtime"] = EncodeSample(mission_runtime_, now);
  value["mission_result"] = EncodeSample(mission_result_, now);
  value["system_status"] = EncodeSample(system_status_, now);
  return value;
}

std::optional<Json::Value> StateCache::MissionReport() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return mission_report_;
}

std::string EncodeJSON(const Json::Value &value) {
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  builder["useSpecialFloats"] = false;
  return Json::writeString(builder, value);
}

std::optional<std::string> EncodeRTCState(const Json::Value &snapshot,
                                          const Json::Value &sources) {
  Json::Value packet;
  packet["type"] = "vehicle.state";
  packet["schema_version"] = 2;
  packet["telemetry"] = snapshot;
  packet["sources"] = sources;
  auto encoded = EncodeJSON(packet);
  if (encoded.size() > 12000) {
    packet["sources"] = Json::Value();
    packet["sources_omitted"] = true;
    encoded = EncodeJSON(packet);
  }
  if (encoded.size() > 12000)
    return std::nullopt;
  return encoded;
}

std::int64_t UnixMilliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string NewStreamID() {
  std::ifstream random("/dev/urandom", std::ios::binary);
  unsigned char bytes[16];
  if (!random.read(reinterpret_cast<char *>(bytes), sizeof(bytes))) {
    throw std::runtime_error("cannot read stream identifier entropy");
  }
  std::ostringstream result;
  for (const auto byte : bytes) {
    result << std::hex << std::setw(2) << std::setfill('0')
           << static_cast<unsigned int>(byte);
  }
  return result.str();
}

} // namespace vehicle_edge
