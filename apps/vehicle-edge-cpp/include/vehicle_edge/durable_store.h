#pragma once

#include <mutex>
#include <optional>
#include <string>

#include <sqlite3.h>

#include "vehicle_edge/state_cache.h"

namespace vehicle_edge {

struct PendingUpload {
  std::int64_t id;
  std::string kind;
  Json::Value payload;
};
struct PendingTask {
  Json::Value request;
  std::string state;
  std::int64_t started_at_ms;
  bool unknown_reported;
};

// One process per private database; exact duplicate identities are idempotent.
// Retained deduplication records are never silently evicted on capacity
// pressure.
class DurableStore {
public:
  explicit DurableStore(const std::string &path, int capacity = 10000);
  ~DurableStore();
  DurableStore(const DurableStore &) = delete;
  DurableStore &operator=(const DurableStore &) = delete;
  void BindVehicle(const std::string &vehicle);
  Json::Value Statistics();
  void ObserveFault(const std::string &vehicle, const std::string &key,
                    const std::string &severity, const std::string &message,
                    std::int64_t source_ms);
  std::optional<PendingUpload> NextUpload();
  void Acknowledge(std::int64_t id);
  void ReceiveTask(const Json::Value &request);
  std::optional<PendingTask> NextTask();
  void BeginTask(const std::string &id, std::int64_t now_ms);
  void ReportTask(const std::string &id, const std::string &status,
                  const std::string &reason, const Json::Value &mission,
                  bool terminal);

private:
  void Capacity(const char *table);
  sqlite3 *db_ = nullptr;
  int lock_fd_ = -1;
  int capacity_;
  std::mutex mutex_;
};

} // namespace vehicle_edge
