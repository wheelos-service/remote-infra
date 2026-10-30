#include <iostream>
#include <thread>

#include "vehicle_edge/data_service.h"

int main(int argc, char **argv) {
  if (argc != 3)
    return 2;
  try {
    Json::Value json;
    json["vehicle_id"] = "car-1";
    json["gateway_url"] = argv[1];
    json["token_url"] = std::string(argv[1]) + "/token";
    json["client_id"] = "test-device";
    json["client_secret"] = "local-test-only";
    json["allow_insecure_localhost"] = true;
    json["data_store_path"] = argv[2];
    json["task_mode"] = "simulation";
    json["map_id"] = "map-a";
    auto config = vehicle_edge::ParseConfig(json);
    auto cache = std::make_shared<vehicle_edge::StateCache>();
    vehicle_edge::InitializeHTTPTransport();
    vehicle_edge::DataService service(config, cache);
    const auto observe = [&](const char *severity) {
      const auto now = vehicle_edge::UnixMilliseconds();
      Json::Value monitor;
      monitor["components"] = Json::Value(Json::objectValue);
      monitor["hmi_modules"]["monitor"]["status"] = severity;
      monitor["hmi_modules"]["monitor"]["message"] = "test Monitor authority";
      monitor["other_components"] = Json::Value(Json::objectValue);
      monitor["components_truncated"] = false;
      monitor["require_emergency_stop"] = Json::Value();
      monitor["is_realtime_in_simulation"] = true;
      monitor["passenger_msg"] = Json::Value();
      monitor["safety_mode_trigger_time"] = Json::Value();
      vehicle_edge::SourceMetadata source;
      source.timestamp_ms = now;
      cache->UpdateSystemStatus(monitor, source,
                                std::chrono::steady_clock::now());
      vehicle_edge::ChassisState chassis;
      chassis.speed_mps = 2.5;
      chassis.gear_location = "GEAR_DRIVE";
      chassis.battery_soc_percentage = 75;
      cache->UpdateChassis(chassis, source, std::chrono::steady_clock::now());
      service.ObserveHealth(cache->AuxiliarySnapshot(
          std::chrono::steady_clock::now())["system_status"]);
    };
    observe("ERROR");
    std::this_thread::sleep_for(std::chrono::milliseconds(1000));
    observe("OK");
    std::this_thread::sleep_for(std::chrono::milliseconds(2100));
    observe("OK");
    std::this_thread::sleep_for(std::chrono::milliseconds(1800));
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
