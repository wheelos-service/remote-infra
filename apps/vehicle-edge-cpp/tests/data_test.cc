#include <sys/stat.h>
#include <unistd.h>

#include <iostream>
#include <stdexcept>

#include "vehicle_edge/health_service.h"
#include "vehicle_edge/task_service.h"

using namespace vehicle_edge;

namespace {
void Require(bool condition, const char *reason) {
  if (!condition)
    throw std::runtime_error(reason);
}
template <typename F> void Rejects(F operation) {
  bool rejected = false;
  try {
    operation();
  } catch (const std::exception &) {
    rejected = true;
  }
  Require(rejected, "expected explicit rejection");
}
Json::Value Task(const std::string &id, std::int64_t now) {
  Json::Value task;
  task["schema_version"] = 1;
  task["vehicle_id"] = "car-1";
  task["request_id"] = id;
  task["client_epoch"] = "epoch-1";
  task["operation"] = "simulate_wait";
  task["created_at_ms"] = Json::Int64(now);
  task["expires_at_ms"] = Json::Int64(now + 60000);
  task["map_id"] = "map-a";
  task["parameters"]["duration_ms"] = 1;
  task["parameters"]["target_request_id"] = Json::Value();
  task["parameters"]["target_client_epoch"] = Json::Value();
  return task;
}
Json::Value Health(const std::string &severity, std::int64_t now) {
  Json::Value sample;
  sample["source_timestamp_ms"] = Json::Int64(now);
  sample["age_ms"] = 0;
  sample["message"]["components_truncated"] = false;
  sample["message"]["hmi_modules"]["monitor"]["status"] = severity;
  sample["message"]["hmi_modules"]["monitor"]["message"] = "test observation";
  return sample;
}
class AmbiguousAdapter : public TaskAdapter {
public:
  int executions = 0, queries = 0;
  bool answer = false;
  std::optional<TaskOutcome> Execute(const PendingTask &) override {
    ++executions;
    return std::nullopt;
  }
  std::optional<TaskOutcome> Reconcile(const PendingTask &) override {
    ++queries;
    if (answer)
      return TaskOutcome{"succeeded", "identity query answered", {}};
    return std::nullopt;
  }
};

void TestHealth() {
  DurableStore store(":memory:");
  HealthService health("car-1", store);
  const auto now = UnixMilliseconds();
  health.Observe(Health("ERROR", now), now);
  auto event = store.NextUpload();
  Require(event && event->payload["transition"] == "raised",
          "fault not queued");
  store.Acknowledge(event->id);
  health.Observe(Health("ERROR", now), now);
  Require(!store.NextUpload(), "duplicate observation produced an event");
  health.Observe(Health("OK", now + 1), now + 1);
  auto missing = Health("OK", now + 1001);
  missing["message"].removeMember("hmi_modules");
  health.Observe(missing, now + 1001);
  health.Observe(Health("OK", now + 2001), now + 2001);
  Require(!store.NextUpload(), "missing source falsely recovered a fault");
  auto truncated = Health("OK", now + 4001);
  truncated["message"]["components_truncated"] = true;
  health.Observe(truncated, now + 4001);
  health.Observe(Health("UNKNOWN", now + 5001), now + 5001);
  auto stale = Health("OK", now + 5001);
  health.Observe(stale, now + 10001);
  Require(!store.NextUpload(), "unknown/truncated/stale source recovered");
  health.Observe(Health("OK", now + 11000), now + 11000);
  health.Observe(Health("OK", now + 13000), now + 13000);
  event = store.NextUpload();
  Require(event && event->payload["transition"] == "recovered",
          "recovery hysteresis failed");
  store.Acknowledge(event->id);
  health.Observe(Health("ERROR", now + 14000), now + 14000);
  event = store.NextUpload();
  store.Acknowledge(event->id);
  health.Observe(Health("OK", now + 15000), now + 15000);
  health.Observe(Health("OK", now + 25000), now + 25000);
  Require(!store.NextUpload(), "long source gap falsely satisfied recovery");
  Rejects([&] {
    store.ObserveFault("car-1", "hmi_modules/monitor", "OK", "conflict",
                       now + 14000);
  });
}
void TestCapacityAtomicity() {
  DurableStore store(":memory:", 1);
  store.ObserveFault("car-1", "monitor/process", "ERROR", "failed", 1);
  Rejects([&] {
    store.ObserveFault("car-1", "monitor/process", "OK", "recovered", 2);
  });
  auto first = store.NextUpload();
  Require(first && first->payload["severity"] == "ERROR",
          "queue failure lost fault");
  store.Acknowledge(first->id);
  const auto statistics = store.Statistics();
  Require(statistics["outbox_retained"].asInt64() == 1 &&
              statistics["outbox_pending"].asInt64() == 0 &&
              statistics["faults_retained"].asInt64() == 1,
          "acknowledged dedup identity not counted");
  Rejects([&] {
    store.ObserveFault("car-1", "monitor/process", "OK", "recovered", 2);
  });
}
void TestRestart(const std::string &path) {
  const auto now = UnixMilliseconds();
  AmbiguousAdapter adapter;
  {
    DurableStore store(path);
    store.BindVehicle("car-1");
    Rejects([&] { store.BindVehicle("car-2"); });
    Rejects([&] { DurableStore duplicate(path); });
    TaskService tasks("car-1", "simulation", "map-a", store, &adapter);
    const auto request = Task("req-1", now);
    tasks.Receive(request);
    tasks.Receive(request);
    auto changed = request;
    changed["parameters"]["duration_ms"] = 2;
    Rejects([&] { tasks.Receive(changed); });
    tasks.Tick(now);
    Require(adapter.executions == 1, "task was not dispatched exactly once");
    const auto statistics = store.Statistics();
    Require(statistics["inbox_retained"].asInt64() == 1 &&
                statistics["inbox_pending"].asInt64() == 1 &&
                statistics["outbox_pending"].asInt64() == 2,
            "task backlog counters wrong");
    auto receipt = store.NextUpload();
    Require(receipt && receipt->payload["status"] == "received",
            "missing durable receipt");
    store.Acknowledge(receipt->id);
  }
  {
    DurableStore store(path);
    TaskService tasks("car-1", "simulation", "map-a", store, &adapter);
    tasks.Tick(now + 6000);
    Require(adapter.executions == 1 && adapter.queries == 1,
            "restart resubmitted task");
    Require(store.NextTask()->unknown_reported, "timeout must remain unknown");
    adapter.answer = true;
    tasks.Tick(now + 7000);
    Require(!store.NextTask(), "reconciliation did not finish");
    int reports = 0;
    while (auto upload = store.NextUpload()) {
      ++reports;
      store.Acknowledge(upload->id);
    }
    Require(reports == 3, "dispatch/unknown/terminal reports not durable");
    auto expired = Task("req-expired", now - 120000);
    tasks.Receive(expired);
    tasks.Tick(now);
    Require(adapter.executions == 1 && !store.NextTask(),
            "expired task executed");
    auto wrong_map = Task("req-map", now);
    wrong_map["map_id"] = "wrong-map";
    tasks.Receive(wrong_map);
    tasks.Tick(now);
    Require(adapter.executions == 1 && !store.NextTask(),
            "map mismatch executed");
  }
}
} // namespace

int main() {
  char directory[] = "/tmp/vehicle-data-test-XXXXXX";
  if (!mkdtemp(directory))
    return 2;
  const std::string path = std::string(directory) + "/data.sqlite";
  int status = 0;
  try {
    TestHealth();
    TestCapacityAtomicity();
    TestRestart(path);
    std::cout << "Data durability, health and task tests passed\n";
  } catch (const std::exception &error) {
    std::cerr << error.what() << "\n";
    status = 1;
  }
  for (const auto *suffix : {"", "-wal", "-shm", ".lock"})
    unlink((path + suffix).c_str());
  rmdir(directory);
  return status;
}
