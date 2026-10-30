#include "vehicle_edge/cyber_task_adapter.h"

#include <stdexcept>

namespace vehicle_edge {

void CyberTaskAdapter::Select(const PendingTask &task) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (active_request_["request_id"] != task.request["request_id"] ||
      active_request_["client_epoch"] != task.request["client_epoch"]) {
    active_request_ = task.request;
    result_.reset();
    requested_ = false;
  }
}

void CyberTaskAdapter::ObserveResult(const Json::Value &result) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!requested_ || active_request_.isNull() ||
      !result["outcome"].isString() || !result["code"].isString())
    return;
  const bool target_result =
      result["identity"]["client_epoch"] ==
          active_request_["parameters"]["target_client_epoch"] &&
      result["identity"]["request_id"] ==
          active_request_["parameters"]["target_request_id"];
  const bool query_result =
      result["identity"]["client_epoch"] == active_request_["client_epoch"] &&
      result["identity"]["request_id"] == active_request_["request_id"];
  if (target_result || query_result)
    result_ = result;
}

std::optional<TaskOutcome> CyberTaskAdapter::Execute(const PendingTask &task) {
  return Reconcile(task);
}
std::optional<TaskOutcome>
CyberTaskAdapter::Reconcile(const PendingTask &task) {
  if (task.request["operation"] != "query")
    return TaskOutcome{
        "rejected", "Cyber adapter permits typed query only", {}};
  Select(task);
  // Apollo returns the target ledger record on success; lookup errors carry
  // the query identity. Retain the matching response across unrelated messages.
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (result_)
      return TaskOutcome{
          "succeeded", "Mission query answered; not a motion completion claim",
          *result_};
  }
  apollo::mission::MissionRequest request;
  const auto runtime = cache_->AuxiliarySnapshot(
      std::chrono::steady_clock::now())["mission_runtime"];
  const auto &capabilities = runtime["message"]["contract_capabilities"];
  bool query_implemented = false;
  for (const auto &operation : capabilities["implemented_operations"])
    query_implemented |=
        operation.isInt() &&
        operation.asInt() == apollo::mission::MISSION_OPERATION_QUERY;
  if (!runtime["age_ms"].isInt64() || runtime["age_ms"].asInt64() > 2000 ||
      !capabilities["request_contract_version"].isUInt() ||
      capabilities["request_contract_version"].asUInt() != 1 ||
      capabilities["complete_inventory"] != true ||
      capabilities["typed_dispatcher_implemented"] != true ||
      !query_implemented)
    return std::nullopt;
  request.set_contract_version(1);
  request.mutable_identity()->set_client_epoch(
      task.request["client_epoch"].asString());
  request.mutable_identity()->set_request_id(
      task.request["request_id"].asString());
  auto *target = request.mutable_query()->mutable_request_identity();
  target->set_client_epoch(
      task.request["parameters"]["target_client_epoch"].asString());
  target->set_request_id(
      task.request["parameters"]["target_request_id"].asString());
  {
    std::lock_guard<std::mutex> lock(mutex_);
    requested_ = true;
  }
  if (!writer_(request))
    throw std::runtime_error("typed Mission query publication failed");
  return std::nullopt;
}

} // namespace vehicle_edge
