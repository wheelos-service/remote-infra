#include "vehicle_edge/task_service.h"

#include <stdexcept>

namespace vehicle_edge {
namespace {
bool Fields(const Json::Value &value,
            std::initializer_list<const char *> names) {
  if (!value.isObject() || value.size() != names.size())
    return false;
  for (const auto *name : names)
    if (!value.isMember(name))
      return false;
  return true;
}
bool SafeTime(const Json::Value &value) {
  return value.isInt64() && value.asInt64() > 0 &&
         value.asInt64() <= 9007199254740991LL;
}
bool Identifier(const Json::Value &value) {
  return value.isString() && ValidIdentifier(value.asString());
}
} // namespace

bool ValidDataTask(const Json::Value &task, const std::string &vehicle) {
  if (!Fields(task, {"schema_version", "vehicle_id", "request_id",
                     "client_epoch", "operation", "created_at_ms",
                     "expires_at_ms", "map_id", "parameters"}) ||
      !task["schema_version"].isInt() || task["schema_version"].asInt() != 1 ||
      task["vehicle_id"] != vehicle || !Identifier(task["request_id"]) ||
      !Identifier(task["client_epoch"]) || !SafeTime(task["created_at_ms"]) ||
      !SafeTime(task["expires_at_ms"]) || !task["map_id"].isString() ||
      task["map_id"].asString().size() > 128)
    return false;
  const auto duration =
      task["expires_at_ms"].asInt64() - task["created_at_ms"].asInt64();
  const auto &p = task["parameters"];
  if (duration <= 0 || duration > 86400000 ||
      !Fields(p, {"duration_ms", "target_request_id", "target_client_epoch"}) ||
      !p["duration_ms"].isInt())
    return false;
  if (task["operation"] == "simulate_wait")
    return p["duration_ms"].asInt() >= 1 && p["duration_ms"].asInt() <= 60000 &&
           p["target_request_id"].isNull() && p["target_client_epoch"].isNull();
  return task["operation"] == "query" && p["duration_ms"].asInt() == 0 &&
         Identifier(p["target_request_id"]) &&
         Identifier(p["target_client_epoch"]);
}

std::optional<TaskOutcome>
SimulationTaskAdapter::Execute(const PendingTask &task) {
  return Reconcile(task);
}
std::optional<TaskOutcome>
SimulationTaskAdapter::Reconcile(const PendingTask &task) {
  if (task.request["operation"] != "simulate_wait")
    return TaskOutcome{
        "rejected", "simulation adapter supports simulate_wait only", {}};
  if (UnixMilliseconds() - task.started_at_ms <
      task.request["parameters"]["duration_ms"].asInt())
    return std::nullopt;
  return TaskOutcome{
      "succeeded", "simulation wait completed; no vehicle actuation", {}};
}

void TaskService::Receive(const Json::Value &request) {
  if (!ValidDataTask(request, vehicle_))
    throw std::invalid_argument("invalid or unsupported task envelope");
  store_.ReceiveTask(request);
}

void TaskService::Tick(std::int64_t now_ms) {
  auto pending = store_.NextTask();
  if (!pending)
    return;
  auto &task = *pending;
  if (!ValidDataTask(task.request, vehicle_))
    throw std::runtime_error("persistent task identity/contract mismatch");
  const auto id = task.request["request_id"].asString();
  std::optional<TaskOutcome> outcome;
  if (task.state == "received") {
    std::string rejection;
    if (task.request["expires_at_ms"].asInt64() <= now_ms ||
        task.request["created_at_ms"].asInt64() > now_ms + 1000)
      rejection = "expired or future-created task";
    else if (!adapter_ || mode_ == "disabled")
      rejection = "task adapter disabled";
    else if (task.request["map_id"] != map_id_)
      rejection = "map identity mismatch";
    else if ((mode_ == "mission_query" &&
              task.request["operation"] != "query") ||
             (mode_ == "simulation" &&
              task.request["operation"] != "simulate_wait"))
      rejection = "operation not supported by active capability";
    if (!rejection.empty()) {
      store_.ReportTask(id, "rejected", rejection, {}, true);
      return;
    }
    store_.BeginTask(id, now_ms);
    task.state = "reconciling";
    task.started_at_ms = now_ms;
    outcome = adapter_->Execute(task);
  } else if (adapter_) {
    outcome = adapter_->Reconcile(task);
  }
  if (outcome) {
    if (outcome->status == "unknown" && task.unknown_reported)
      return;
    store_.ReportTask(id, outcome->status, outcome->reason,
                      outcome->mission_result, outcome->status != "unknown");
  } else if (!task.unknown_reported && now_ms - task.started_at_ms >= 5000) {
    store_.ReportTask(id, "unknown",
                      "awaiting identity reconciliation; not resubmitted", {},
                      false);
  }
}

} // namespace vehicle_edge
