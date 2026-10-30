#include "vehicle_edge/data_client.h"

#include <stdexcept>

#include "vehicle_edge/state_cache.h"
#include "vehicle_edge/task_service.h"

namespace vehicle_edge {

TelemetryUploader::TelemetryUploader(DeviceConfig config)
    : vehicle_id_(config.vehicle_id), client_(std::move(config)) {}

void TelemetryUploader::Upload(const Json::Value &packet) {
  const auto body = EncodeJSON(packet);
  if (body.size() > 65536 || packet["vehicle_id"] != vehicle_id_)
    throw std::invalid_argument("telemetry size or vehicle mismatch");
  const auto response =
      client_.Post("/api/vehicles/" + vehicle_id_ + "/state", body);
  if (response.status != 204)
    throw std::runtime_error("telemetry rejected (HTTP " +
                             std::to_string(response.status) + ")");
}

void TelemetryUploader::UploadMission(const Json::Value &report) {
  const auto body = EncodeJSON(report);
  if (!report.isObject() || body.size() > 8192)
    throw std::invalid_argument("invalid mission report");
  const auto response =
      client_.Post("/api/vehicles/" + vehicle_id_ + "/mission-status", body);
  if (response.status != 204)
    throw std::runtime_error("mission report rejected (HTTP " +
                             std::to_string(response.status) + ")");
}

void DataClient::Publish(const std::string &kind, const Json::Value &payload) {
  if (kind != "health" && kind != "profile" && kind != "events" &&
      kind != "task-results" && kind != "diagnostics")
    throw std::invalid_argument("unsupported Data upload kind");
  const auto body = EncodeJSON(payload);
  const std::size_t limit = kind == "health"   ? 65536
                            : kind == "events" ? 4096
                                               : 8192;
  if (!payload.isObject() || body.size() > limit ||
      (kind != "task-results" && payload["vehicle_id"] != vehicle_id_))
    throw std::invalid_argument("invalid Data upload size/identity");
  const auto response =
      client_.Post("/api/vehicles/" + vehicle_id_ + "/data/" + kind, body);
  if (response.status != 204)
    throw std::runtime_error("Data upload rejected (HTTP " +
                             std::to_string(response.status) + ")");
}

std::optional<Json::Value> DataClient::PullTask() {
  const auto response =
      client_.Get("/api/vehicles/" + vehicle_id_ + "/data/tasks/next");
  if (response.status != 200)
    throw std::runtime_error("task pull rejected (HTTP " +
                             std::to_string(response.status) + ")");
  const auto body = ParseHTTPJSON(response.body);
  if (!body.isObject() || body.size() != 1 || !body.isMember("task") ||
      (!body["task"].isNull() && !ValidDataTask(body["task"], vehicle_id_)))
    throw std::runtime_error("invalid task pull response");
  if (body["task"].isNull())
    return std::nullopt;
  return body["task"];
}

} // namespace vehicle_edge
