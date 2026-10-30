#pragma once

#include <functional>
#include <optional>

#include "vehicle_edge/durable_store.h"

namespace vehicle_edge {

struct TaskOutcome {
  std::string status;
  std::string reason;
  Json::Value mission_result;
};

// Execute is called only after a durable dispatch fence. Following restart or
// ambiguity, Reconcile must query identity, never repeat a mutating operation.
class TaskAdapter {
public:
  virtual ~TaskAdapter() = default;
  virtual std::optional<TaskOutcome> Execute(const PendingTask &task) = 0;
  virtual std::optional<TaskOutcome> Reconcile(const PendingTask &task) = 0;
};

class SimulationTaskAdapter : public TaskAdapter {
public:
  std::optional<TaskOutcome> Execute(const PendingTask &task) override;
  std::optional<TaskOutcome> Reconcile(const PendingTask &task) override;
};

bool ValidDataTask(const Json::Value &task, const std::string &vehicle);

class TaskService {
public:
  TaskService(std::string vehicle, std::string mode, std::string map_id,
              DurableStore &store, TaskAdapter *adapter)
      : vehicle_(std::move(vehicle)), mode_(std::move(mode)),
        map_id_(std::move(map_id)), store_(store), adapter_(adapter) {
    store_.BindVehicle(vehicle_);
  }
  void Receive(const Json::Value &request);
  void Tick(std::int64_t now_ms);

private:
  std::string vehicle_, mode_, map_id_;
  DurableStore &store_;
  TaskAdapter *adapter_;
};

} // namespace vehicle_edge
