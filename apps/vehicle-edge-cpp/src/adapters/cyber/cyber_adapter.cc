#include "vehicle_edge/cyber_adapter.h"

#include <cmath>

namespace vehicle_edge {
namespace {

std::optional<std::int64_t> Timestamp(double seconds) {
  if (!std::isfinite(seconds) || seconds < 0.001 || seconds > 9007199254740.0)
    return std::nullopt;
  return static_cast<std::int64_t>(seconds * 1000);
}

SourceMetadata Header(const apollo::common::Header &header) {
  SourceMetadata source;
  if (header.has_timestamp_sec())
    source.timestamp_ms = Timestamp(header.timestamp_sec());
  if (header.has_sequence_num())
    source.sequence = header.sequence_num();
  return source;
}

Json::Value Text(bool present, const std::string &value,
                 std::size_t limit = 2048) {
  return present && value.size() <= limit ? Json::Value(value) : Json::Value();
}

Json::Value Component(const apollo::monitor::ComponentStatus &status) {
  Json::Value value;
  value["status"] =
      status.has_status()
          ? Json::Value(
                apollo::monitor::ComponentStatus::Status_Name(status.status()))
          : Json::Value();
  value["message"] = Text(status.has_message(), status.message(), 256);
  return value;
}

Json::Value
CommandIdentity(const apollo::planning::MissionCommandIdentity &identity) {
  Json::Value value;
  value["producer_epoch"] =
      Text(identity.has_producer_epoch(), identity.producer_epoch(), 128);
  value["aggregate_id"] =
      Text(identity.has_aggregate_id(), identity.aggregate_id(), 128);
  value["command_id"] =
      Text(identity.has_command_id(), identity.command_id(), 128);
  value["revision"] = identity.has_revision()
                          ? Json::Value(std::to_string(identity.revision()))
                          : Json::Value();
  return value;
}

} // namespace

void ReceiveChassis(const apollo::canbus::Chassis &message, StateCache *cache,
                    SteadyTime received) {
  ChassisState state;
  if (message.has_speed_mps())
    state.speed_mps = message.speed_mps();
  if (message.has_gear_location()) {
    state.gear_location =
        apollo::canbus::Chassis::GearPosition_Name(message.gear_location());
  }
  if (message.has_driving_mode()) {
    state.driving_mode =
        apollo::canbus::Chassis::DrivingMode_Name(message.driving_mode());
  }
  if (message.has_steering_percentage())
    state.steering_percentage = message.steering_percentage();
  if (message.has_throttle_percentage())
    state.throttle_percentage = message.throttle_percentage();
  if (message.has_brake_percentage())
    state.brake_percentage = message.brake_percentage();
  if (message.has_battery_soc_percentage())
    state.battery_soc_percentage = message.battery_soc_percentage();
  if (message.has_parking_brake())
    state.parking_brake = message.parking_brake();
  if (message.has_error_code())
    state.error_code = static_cast<int>(message.error_code());
  if (message.has_chassis_error_mask())
    state.chassis_error_mask = message.chassis_error_mask();
  cache->UpdateChassis(
      state, message.has_header() ? Header(message.header()) : SourceMetadata{},
      received);
}

void ReceiveLocalization(
    const apollo::localization::LocalizationEstimate &message,
    StateCache *cache, SteadyTime received) {
  LocalizationState state;
  if (message.has_pose()) {
    const auto &pose = message.pose();
    if (pose.has_position()) {
      if (pose.position().has_x())
        state.x = pose.position().x();
      if (pose.position().has_y())
        state.y = pose.position().y();
      if (pose.position().has_z())
        state.z = pose.position().z();
    }
    if (pose.has_heading())
      state.heading_rad = pose.heading();
  }
  auto source =
      message.has_header() ? Header(message.header()) : SourceMetadata{};
  if (message.has_measurement_time())
    source.timestamp_ms = Timestamp(message.measurement_time());
  if (message.has_header() && message.header().has_frame_id())
    state.frame_id = message.header().frame_id();
  cache->UpdateLocalization(state, source, received);
}

void ReceiveMissionRuntime(const apollo::mission::MissionRuntimeStatus &message,
                           StateCache *cache, SteadyTime received) {
  const auto source =
      message.has_header() ? Header(message.header()) : SourceMetadata{};
  Json::Value value;
  value["mission_id"] = Text(message.has_mission_id(), message.mission_id());
  value["task_name"] = Text(message.has_task_name(), message.task_name());
  value["state"] = message.has_state()
                       ? Json::Value(apollo::mission::MissionRuntimeState_Name(
                             message.state()))
                       : Json::Value();
  value["active_command_state"] =
      message.has_active_command_state()
          ? Json::Value(apollo::mission::MissionCommandState_Name(
                message.active_command_state()))
          : Json::Value();
  value["reason"] = Text(message.has_reason(), message.reason());
  value["operator_recovery_required"] =
      message.has_operator_recovery_required()
          ? Json::Value(message.operator_recovery_required())
          : Json::Value();
  value["contract_capabilities"] = Json::Value();
  if (message.has_contract_capabilities()) {
    const auto &capabilities = message.contract_capabilities();
    auto &out = value["contract_capabilities"];
    out["request_contract_version"] =
        capabilities.has_request_contract_version()
            ? Json::Value(capabilities.request_contract_version())
            : Json::Value();
    out["complete_inventory"] =
        capabilities.has_complete_inventory()
            ? Json::Value(capabilities.complete_inventory())
            : Json::Value();
    out["typed_dispatcher_implemented"] =
        capabilities.has_typed_dispatcher_implemented()
            ? Json::Value(capabilities.typed_dispatcher_implemented())
            : Json::Value();
    out["implemented_operations"] = Json::Value(Json::arrayValue);
    for (const auto operation : capabilities.implemented_operation())
      out["implemented_operations"].append(operation);
  }
  std::optional<Json::Value> report;
  if (message.has_mission_id() && ValidIdentifier(message.mission_id()) &&
      source.timestamp_ms && message.has_state()) {
    Json::Value packet;
    packet["mission_id"] = message.mission_id();
    packet["updated_at_ms"] = Json::Int64(*source.timestamp_ms);
    packet["description"] = value["reason"].isString() ? value["reason"] : "";
    switch (message.state()) {
    case apollo::mission::MISSION_RUNTIME_RUNNING:
      packet["status"] = "running";
      break;
    case apollo::mission::MISSION_RUNTIME_FAILED:
      packet["status"] = "failed";
      break;
    case apollo::mission::MISSION_RUNTIME_COMPLETED:
      packet["status"] = "succeeded";
      break;
    default:
      packet["status"] = "unknown";
    }
    report = std::move(packet);
  }
  cache->UpdateMissionRuntime(value, source, received, std::move(report));
}

Json::Value
ReceiveMissionResult(const apollo::mission::MissionRequestResult &message,
                     StateCache *cache, SteadyTime received) {
  Json::Value value;
  value["requested_mission_id"] =
      Text(message.has_requested_mission_id(), message.requested_mission_id());
  value["identity"] = Json::Value();
  if (message.has_identity()) {
    value["identity"]["client_epoch"] = message.identity().client_epoch();
    value["identity"]["request_id"] = message.identity().request_id();
  }
  value["outcome"] =
      message.has_outcome()
          ? Json::Value(
                apollo::mission::MissionRequestOutcome_Name(message.outcome()))
          : Json::Value();
  value["code"] = message.has_code()
                      ? Json::Value(apollo::mission::MissionRequestCode_Name(
                            message.code()))
                      : Json::Value();
  value["reason"] = Text(message.has_reason(), message.reason());
  value["durably_committed"] = message.has_durably_committed()
                                   ? Json::Value(message.durably_committed())
                                   : Json::Value();
  value["commit_sequence"] =
      message.has_commit_sequence()
          ? Json::Value(std::to_string(message.commit_sequence()))
          : Json::Value();
  value["retry_disposition"] =
      message.has_retry_disposition()
          ? Json::Value(apollo::mission::MissionRequestRetryDisposition_Name(
                message.retry_disposition()))
          : Json::Value();
  value["terminal_disposition"] =
      message.has_terminal_disposition()
          ? Json::Value(apollo::mission::MissionTaskDisposition_Name(
                message.terminal_disposition()))
          : Json::Value();
  value["affected_task_identity"] =
      message.has_affected_task_identity()
          ? CommandIdentity(message.affected_task_identity())
          : Json::Value();
  value["current_task_identity"] =
      message.has_current_task_identity()
          ? CommandIdentity(message.current_task_identity())
          : Json::Value();
  // This public result proto has no source timestamp; receipt is not source
  // time.
  cache->UpdateMissionResult(value, received);
  return value;
}

Json::Value ReceiveSystemStatus(const apollo::monitor::SystemStatus &message,
                                StateCache *cache, SteadyTime received) {
  Json::Value value;
  value["require_emergency_stop"] =
      message.has_require_emergency_stop()
          ? Json::Value(message.require_emergency_stop())
          : Json::Value();
  value["is_realtime_in_simulation"] =
      message.has_is_realtime_in_simulation()
          ? Json::Value(message.is_realtime_in_simulation())
          : Json::Value();
  value["passenger_msg"] =
      Text(message.has_passenger_msg(), message.passenger_msg(), 512);
  value["safety_mode_trigger_time"] =
      message.has_safety_mode_trigger_time() &&
              std::isfinite(message.safety_mode_trigger_time())
          ? Json::Value(message.safety_mode_trigger_time())
          : Json::Value();
  value["components"] = Json::Value(Json::objectValue);
  value["hmi_modules"] = Json::Value(Json::objectValue);
  value["other_components"] = Json::Value(Json::objectValue);
  bool truncated = false;
  for (const auto &entry : message.components()) {
    if (value["components"].size() >= 16 || !ValidIdentifier(entry.first)) {
      truncated = true;
      continue;
    }
    auto &component = value["components"][entry.first];
    component["summary"] = entry.second.has_summary()
                               ? Component(entry.second.summary())
                               : Json::Value();
    component["process"] = entry.second.has_process_status()
                               ? Component(entry.second.process_status())
                               : Json::Value();
    component["channel"] = entry.second.has_channel_status()
                               ? Component(entry.second.channel_status())
                               : Json::Value();
    component["resource"] = entry.second.has_resource_status()
                                ? Component(entry.second.resource_status())
                                : Json::Value();
    component["other"] = entry.second.has_other_status()
                             ? Component(entry.second.other_status())
                             : Json::Value();
    component["module"] = entry.second.has_module_status()
                              ? Component(entry.second.module_status())
                              : Json::Value();
  }
  const auto copy = [&truncated, &value](const char *name, const auto &map) {
    for (const auto &entry : map) {
      if (value[name].size() >= 16 || !ValidIdentifier(entry.first)) {
        truncated = true;
        continue;
      }
      value[name][entry.first] = Component(entry.second);
    }
  };
  copy("hmi_modules", message.hmi_modules());
  copy("other_components", message.other_components());
  value["components_truncated"] = truncated;
  const auto source =
      message.has_header() ? Header(message.header()) : SourceMetadata{};
  cache->UpdateSystemStatus(value, source, received);
  Json::Value sample;
  sample["message"] = value;
  sample["age_ms"] = 0;
  sample["source_timestamp_ms"] =
      source.timestamp_ms ? Json::Value(Json::Int64(*source.timestamp_ms))
                          : Json::Value();
  sample["source_sequence"] =
      source.sequence ? Json::Value(*source.sequence) : Json::Value();
  return sample;
}

} // namespace vehicle_edge
