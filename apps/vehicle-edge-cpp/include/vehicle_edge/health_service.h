#pragma once

#include <map>
#include <mutex>

#include "vehicle_edge/durable_store.h"

namespace vehicle_edge {

class HealthService {
public:
  HealthService(std::string vehicle, DurableStore &store)
      : vehicle_(std::move(vehicle)), store_(store) {
    store_.BindVehicle(vehicle_);
  }
  void Observe(const Json::Value &sample, std::int64_t now_ms);

private:
  std::string vehicle_;
  DurableStore &store_;
  std::mutex mutex_;
  struct Recovery {
    std::int64_t first_ms, last_ms;
  };
  std::map<std::string, Recovery> recovery_since_;
};

} // namespace vehicle_edge
