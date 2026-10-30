#pragma once

#include <memory>

#include "vehicle_edge/task_service.h"
#include "wheelos_msgs/mission_msgs/mission_request.pb.h"

namespace vehicle_edge {

// Only the public typed query operation is mapped. No legacy task_name
// fallback.
class CyberTaskAdapter : public TaskAdapter {
public:
  using Writer = std::function<bool(const apollo::mission::MissionRequest &)>;
  CyberTaskAdapter(std::shared_ptr<StateCache> cache, Writer writer)
      : cache_(std::move(cache)), writer_(std::move(writer)) {}
  std::optional<TaskOutcome> Execute(const PendingTask &task) override;
  std::optional<TaskOutcome> Reconcile(const PendingTask &task) override;
  void ObserveResult(const Json::Value &result);

private:
  void Select(const PendingTask &task);
  std::shared_ptr<StateCache> cache_;
  Writer writer_;
  std::mutex mutex_;
  Json::Value active_request_;
  std::optional<Json::Value> result_;
  bool requested_ = false;
};

} // namespace vehicle_edge
