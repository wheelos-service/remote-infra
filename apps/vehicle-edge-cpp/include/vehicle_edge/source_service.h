#pragma once

#include <atomic>
#include <memory>
#include <thread>

#include "vehicle_edge/config.h"
#include "vehicle_edge/state_cache.h"

namespace vehicle_edge {

class SourceService {
public:
  SourceService(DeviceConfig config, std::shared_ptr<StateCache> cache);
  ~SourceService();
  SourceService(const SourceService &) = delete;
  SourceService &operator=(const SourceService &) = delete;

private:
  void Run();
  DeviceConfig config_;
  std::shared_ptr<StateCache> cache_;
  std::atomic<bool> stop_{false};
  std::thread thread_;
};

} // namespace vehicle_edge
