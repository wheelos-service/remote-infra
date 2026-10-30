#pragma once

#include <atomic>
#include <memory>
#include <thread>

#include "vehicle_edge/data_client.h"
#include "vehicle_edge/health_service.h"
#include "vehicle_edge/task_service.h"

namespace vehicle_edge {

// Telemetry, health, and reliable events/tasks have independent HTTP owners.
// Call ObserveHealth for every received Monitor sample, not just UI snapshots.
class DataService {
public:
  DataService(DeviceConfig config, std::shared_ptr<StateCache> cache,
              std::unique_ptr<TaskAdapter> adapter = nullptr);
  ~DataService();
  DataService(const DataService &) = delete;
  DataService &operator=(const DataService &) = delete;
  void ObserveHealth(const Json::Value &sample);

private:
  void RunTelemetry();
  void RunHealth();
  void RunTasks();
  void Sleep(int milliseconds);
  DeviceConfig config_;
  std::shared_ptr<StateCache> cache_;
  DurableStore store_;
  HealthService health_;
  std::unique_ptr<TaskAdapter> adapter_;
  TaskService tasks_;
  TelemetryUploader telemetry_client_;
  DataClient health_client_, reliable_client_;
  std::string stream_id_;
  std::atomic<bool> stop_{false};
  std::thread telemetry_thread_, health_thread_, task_thread_;
};

} // namespace vehicle_edge
