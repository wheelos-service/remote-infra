#include "vehicle_edge/source_service.h"

#include <chrono>
#include <iostream>

#include "vehicle_edge/data_client.h"

namespace vehicle_edge {

SourceService::SourceService(DeviceConfig config,
                             std::shared_ptr<StateCache> cache)
    : config_(std::move(config)), cache_(std::move(cache)) {
  if (!config_.mission_runtime_channel.empty())
    thread_ = std::thread(&SourceService::Run, this);
}

SourceService::~SourceService() {
  stop_ = true;
  if (thread_.joinable())
    thread_.join();
}

void SourceService::Run() {
  try {
    TelemetryUploader client(config_);
    std::string last_uploaded;
    auto last_error = SteadyTime{};
    while (!stop_) {
      const auto now = std::chrono::steady_clock::now();
      const auto report = cache_->MissionReport();
      if (report) {
        const auto encoded = EncodeJSON(*report);
        if (encoded != last_uploaded) {
          try {
            client.UploadMission(*report);
            last_uploaded = encoded;
          } catch (const std::exception &) {
            if (now - last_error >= std::chrono::seconds(10)) {
              std::cerr << "read-only Mission upload failed; telemetry remains "
                           "independent\n";
              last_error = now;
            }
          }
        }
      }
      const auto next = now + std::chrono::seconds(1);
      while (!stop_ && std::chrono::steady_clock::now() < next)
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
  } catch (const std::exception &) {
    std::cerr
        << "read-only Mission task stopped; telemetry remains independent\n";
  }
}

} // namespace vehicle_edge
