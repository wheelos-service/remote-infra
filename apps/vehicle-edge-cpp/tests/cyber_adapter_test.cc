#include <cmath>
#include <iostream>
#include <stdexcept>

#include "vehicle_edge/cyber_adapter.h"
#include "vehicle_edge/cyber_task_adapter.h"

int main() {
  try {
    vehicle_edge::StateCache cache;
    const auto now = std::chrono::steady_clock::now();
    apollo::canbus::Chassis chassis;
    vehicle_edge::ReceiveChassis(chassis, &cache, now);
    auto packet = cache.Snapshot("car-a", "boot-a", 1, 1000000, now);
    if (!packet["chassis"]["message"]["driving_mode"].isNull() ||
        !packet["chassis"]["message"]["gear_location"].isNull()) {
      throw std::runtime_error("missing proto2 enums became measured defaults");
    }
    chassis.set_speed_mps(2.5);
    chassis.set_driving_mode(apollo::canbus::Chassis::COMPLETE_AUTO_DRIVE);
    chassis.set_gear_location(apollo::canbus::Chassis::GEAR_REVERSE);
    chassis.mutable_header()->set_timestamp_sec(1000);
    chassis.mutable_header()->set_sequence_num(0);
    vehicle_edge::ReceiveChassis(chassis, &cache, now);
    apollo::localization::LocalizationEstimate location;
    location.mutable_pose()->mutable_position()->set_x(123);
    location.mutable_pose()->set_heading(0.5);
    location.mutable_header()->set_timestamp_sec(999);
    location.mutable_header()->set_frame_id("map");
    location.set_measurement_time(998);
    vehicle_edge::ReceiveLocalization(location, &cache, now);
    packet = cache.Snapshot("car-a", "boot-a", 2, 1000000, now);
    if (packet["chassis"]["message"]["speed_mps"].asDouble() != 2.5 ||
        packet["chassis"]["message"]["gear_location"] != "GEAR_REVERSE" ||
        packet["chassis"]["source_sequence"].asUInt() != 0 ||
        packet["localization"]["source_timestamp_ms"].asInt64() != 998000 ||
        packet["localization"]["message"]["position"]["x"].asDouble() != 123 ||
        !packet["localization"]["message"]["position"]["y"].isNull()) {
      throw std::runtime_error("Cyber sample conversion mismatch");
    }
    apollo::mission::MissionRuntimeStatus mission;
    vehicle_edge::ReceiveMissionRuntime(mission, &cache, now);
    auto sources = cache.AuxiliarySnapshot(now);
    if (cache.MissionReport() ||
        !sources["mission_runtime"]["message"]["state"].isNull() ||
        !sources["mission_runtime"]["message"]["operator_recovery_required"]
             .isNull())
      throw std::runtime_error("missing Mission fields became known defaults");
    mission.set_mission_id("mission-a");
    mission.set_state(apollo::mission::MISSION_RUNTIME_RUNNING);
    mission.mutable_header()->set_timestamp_sec(1000);
    mission.set_reason("Authoritative Mission runtime");
    vehicle_edge::ReceiveMissionRuntime(mission, &cache, now);
    const auto report = cache.MissionReport();
    if (!report || (*report)["status"] != "running" ||
        (*report)["updated_at_ms"].asInt64() != 1000000)
      throw std::runtime_error("authoritative Mission mapping mismatch");
    mission.mutable_header()->set_timestamp_sec(NAN);
    vehicle_edge::ReceiveMissionRuntime(mission, &cache, now);
    if (cache.MissionReport())
      throw std::runtime_error(
          "Mission receipt was substituted for source timestamp");
    apollo::mission::MissionRequestResult result;
    result.set_requested_mission_id("mission-a");
    result.set_outcome(apollo::mission::MISSION_REQUEST_COMMITTED);
    result.set_durably_committed(false);
    vehicle_edge::ReceiveMissionResult(result, &cache, now);
    apollo::monitor::SystemStatus monitor;
    vehicle_edge::ReceiveSystemStatus(monitor, &cache, now);
    sources = cache.AuxiliarySnapshot(now);
    if (!sources["system_status"]["message"]["require_emergency_stop"]
             .isNull() ||
        !sources["mission_result"]["source_timestamp_ms"].isNull() ||
        sources["mission_result"]["message"]["outcome"] !=
            "MISSION_REQUEST_COMMITTED" ||
        sources["mission_result"]["message"]["durably_committed"] != false)
      throw std::runtime_error(
          "Monitor/result presence or source time was invented");
    monitor.set_require_emergency_stop(true);
    monitor.set_safety_mode_trigger_time(NAN);
    monitor.mutable_header()->set_timestamp_sec(1001);
    for (int i = 0; i < 17; ++i)
      (*monitor.mutable_components())["component-" + std::to_string(i)]
          .mutable_summary()
          ->set_status(apollo::monitor::ComponentStatus::WARN);
    vehicle_edge::ReceiveSystemStatus(monitor, &cache, now);
    sources = cache.AuxiliarySnapshot(now + std::chrono::milliseconds(30));
    if (sources["system_status"]["message"]["require_emergency_stop"] != true ||
        !sources["system_status"]["message"]["safety_mode_trigger_time"]
             .isNull() ||
        sources["system_status"]["message"]["components"].size() != 16 ||
        sources["system_status"]["message"]["components_truncated"] != true ||
        sources["system_status"]["age_ms"].asInt64() != 30)
      throw std::runtime_error("read-only Monitor bounds or aging mismatch");
    const auto &components = sources["system_status"]["message"]["components"];
    if (components[components.getMemberNames()[0]]["summary"]["status"] !=
        "WARN")
      throw std::runtime_error("Monitor per-check status was lost");
    auto task_cache = std::make_shared<vehicle_edge::StateCache>();
    int publications = 0;
    vehicle_edge::CyberTaskAdapter adapter(
        task_cache, [&](const apollo::mission::MissionRequest &request) {
          ++publications;
          if (!request.has_query() || request.has_submit_task() ||
              request.has_task_name() ||
              request.identity().request_id() != "query-1" ||
              request.query().request_identity().request_id() != "target-1")
            throw std::runtime_error(
                "typed query mapping crossed operation/identity boundary");
          return true;
        });
    vehicle_edge::PendingTask task;
    task.state = "reconciling";
    task.started_at_ms = vehicle_edge::UnixMilliseconds();
    task.unknown_reported = false;
    task.request["operation"] = "query";
    task.request["request_id"] = "query-1";
    task.request["client_epoch"] = "cloud-epoch";
    task.request["parameters"]["target_request_id"] = "target-1";
    task.request["parameters"]["target_client_epoch"] = "target-epoch";
    if (adapter.Execute(task) || publications != 0)
      throw std::runtime_error("missing capabilities permitted dispatch");
    Json::Value unsolicited;
    unsolicited["identity"]["client_epoch"] = "target-epoch";
    unsolicited["identity"]["request_id"] = "target-1";
    unsolicited["outcome"] = "MISSION_REQUEST_COMMITTED";
    unsolicited["code"] = "MISSION_REQUEST_OK";
    adapter.ObserveResult(unsolicited);
    if (adapter.Reconcile(task))
      throw std::runtime_error(
          "unsolicited result bypassed query capability gate");
    auto *capabilities = mission.mutable_contract_capabilities();
    capabilities->set_request_contract_version(1);
    capabilities->set_complete_inventory(true);
    capabilities->set_typed_dispatcher_implemented(true);
    capabilities->add_implemented_operation(
        apollo::mission::MISSION_OPERATION_QUERY);
    vehicle_edge::ReceiveMissionRuntime(mission, task_cache.get(),
                                        std::chrono::steady_clock::now());
    if (adapter.Execute(task) || publications != 1)
      throw std::runtime_error("verified query capability did not publish");
    result.mutable_identity()->set_client_epoch("target-epoch");
    result.mutable_identity()->set_request_id("target-1");
    result.set_code(apollo::mission::MISSION_REQUEST_OK);
    result.set_commit_sequence(UINT64_MAX);
    adapter.ObserveResult(vehicle_edge::ReceiveMissionResult(
        result, task_cache.get(), std::chrono::steady_clock::now()));
    result.mutable_identity()->set_request_id("unrelated");
    adapter.ObserveResult(vehicle_edge::ReceiveMissionResult(
        result, task_cache.get(), std::chrono::steady_clock::now()));
    auto answer = adapter.Reconcile(task);
    if (!answer || answer->status != "succeeded" ||
        answer->mission_result["identity"]["request_id"] != "target-1" ||
        answer->mission_result["commit_sequence"] != "18446744073709551615")
      throw std::runtime_error(
          "target-ledger identity or uint64 precision lost");
    std::cout << "Cyber protobuf presence and coordinate semantics passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
