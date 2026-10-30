#include <chrono>
#include <iostream>
#include <memory>
#include <thread>

#include "cyber/cyber.h"
#include "vehicle_edge/config.h"
#include "vehicle_edge/cyber_adapter.h"
#include "vehicle_edge/cyber_task_adapter.h"
#include "vehicle_edge/data_client.h"
#include "vehicle_edge/data_service.h"
#ifndef EDGE_DATA_ONLY
#include "vehicle_edge/media_service.h"
#endif
#include "vehicle_edge/source_service.h"
#include "vehicle_edge/state_cache.h"

int main(int argc, char **argv) {
  if (argc != 2) {
    std::cerr << "usage: vehicle_telemetry /etc/teleop/device.json\n";
    return 2;
  }
  bool initialized = false;
  try {
    const auto config = vehicle_edge::LoadConfig(argv[1]);
#ifdef EDGE_DATA_ONLY
    if (config.data_store_path.empty() || config.media_enabled)
      throw std::runtime_error(
          "vehicle_data requires data_store_path and media disabled");
#endif
    vehicle_edge::TelemetryUploader uploader(config);
    auto cache = std::make_shared<vehicle_edge::StateCache>();
    const auto stream_id = vehicle_edge::NewStreamID();
    if (!apollo::cyber::Init(argv[0])) {
      throw std::runtime_error("Cyber initialization failed");
    }
    initialized = true;
    {
      auto node = apollo::cyber::CreateNode(config.node_name);
      if (!node)
        throw std::runtime_error("Cyber node creation failed");
      const auto writer =
          config.task_mode == "mission_query"
              ? node->CreateWriter<apollo::mission::MissionRequest>(
                    config.mission_request_channel)
              : nullptr;
      if (config.task_mode == "mission_query" && !writer)
        throw std::runtime_error("Mission query writer creation failed");
      std::unique_ptr<vehicle_edge::TaskAdapter> task_adapter;
      vehicle_edge::CyberTaskAdapter *cyber_tasks = nullptr;
      if (writer) {
        auto native = std::make_unique<vehicle_edge::CyberTaskAdapter>(
            cache, [writer](const apollo::mission::MissionRequest &request) {
              return writer->Write(request);
            });
        cyber_tasks = native.get();
        task_adapter = std::move(native);
      }
      std::shared_ptr<vehicle_edge::DataService> data;
      if (!config.data_store_path.empty())
        data = std::make_shared<vehicle_edge::DataService>(
            config, cache, std::move(task_adapter));
      const auto chassis = node->CreateReader<apollo::canbus::Chassis>(
          config.chassis_channel,
          [cache](const std::shared_ptr<apollo::canbus::Chassis> &message) {
            vehicle_edge::ReceiveChassis(*message, cache.get(),
                                         std::chrono::steady_clock::now());
          });
      const auto localization =
          node->CreateReader<apollo::localization::LocalizationEstimate>(
              config.localization_channel,
              [cache](const std::shared_ptr<
                      apollo::localization::LocalizationEstimate> &message) {
                vehicle_edge::ReceiveLocalization(
                    *message, cache.get(), std::chrono::steady_clock::now());
              });
      if (!chassis || !localization)
        throw std::runtime_error("Cyber reader creation failed");
      const auto mission =
          config.mission_runtime_channel.empty()
              ? nullptr
              : node->CreateReader<apollo::mission::MissionRuntimeStatus>(
                    config.mission_runtime_channel,
                    [cache](const std::shared_ptr<
                            apollo::mission::MissionRuntimeStatus> &message) {
                      vehicle_edge::ReceiveMissionRuntime(
                          *message, cache.get(),
                          std::chrono::steady_clock::now());
                    });
      const auto result =
          config.mission_result_channel.empty()
              ? nullptr
              : node->CreateReader<apollo::mission::MissionRequestResult>(
                    config.mission_result_channel,
                    [cache, data, cyber_tasks](
                        const std::shared_ptr<
                            apollo::mission::MissionRequestResult> &message) {
                      const auto result = vehicle_edge::ReceiveMissionResult(
                          *message, cache.get(),
                          std::chrono::steady_clock::now());
                      if (data && cyber_tasks)
                        cyber_tasks->ObserveResult(result);
                    });
      const auto monitor =
          config.system_status_channel.empty()
              ? nullptr
              : node->CreateReader<apollo::monitor::SystemStatus>(
                    config.system_status_channel,
                    [cache,
                     data](const std::shared_ptr<apollo::monitor::SystemStatus>
                               &message) {
                      const auto sample = vehicle_edge::ReceiveSystemStatus(
                          *message, cache.get(),
                          std::chrono::steady_clock::now());
                      if (data) {
                        try {
                          data->ObserveHealth(sample);
                        } catch (const std::exception &error) {
                          std::cerr << "DURABLE HEALTH OBSERVATION FAILED: "
                                    << error.what() << "\n";
                        }
                      }
                    });
      if ((!config.mission_runtime_channel.empty() && !mission) ||
          (!config.mission_result_channel.empty() && !result) ||
          (!config.system_status_channel.empty() && !monitor))
        throw std::runtime_error(
            "optional read-only source reader creation failed");
      vehicle_edge::SourceService sources(config, cache);
#ifndef EDGE_DATA_ONLY
      vehicle_edge::MediaService media(config, argv[1], cache, stream_id);
#endif
      std::uint64_t sequence = 0;
      auto last_error = std::chrono::steady_clock::time_point::min();
      std::size_t consecutive_failures = 0;
      std::cerr << "read-only C++ telemetry started; no control writer\n";
      while (apollo::cyber::OK()) {
        const auto started = std::chrono::steady_clock::now();
        const auto packet =
            cache->Snapshot(config.vehicle_id, stream_id, ++sequence,
                            vehicle_edge::UnixMilliseconds(), started);
        try {
          if (!data)
            uploader.Upload(packet);
          if (consecutive_failures != 0)
            std::cerr << "telemetry upload recovered\n";
          consecutive_failures = 0;
        } catch (const std::exception &error) {
          ++consecutive_failures;
          if (consecutive_failures == 1 ||
              started - last_error >= std::chrono::seconds(10)) {
            std::cerr << "telemetry upload failed: " << error.what() << "\n";
            last_error = started;
          }
        }
        // Never queue an old snapshot during network or authentication failure.
        const auto deadline =
            started + std::chrono::milliseconds(config.upload_interval_ms);
        while (apollo::cyber::OK() &&
               std::chrono::steady_clock::now() < deadline) {
          std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
      }
    }
    apollo::cyber::Clear();
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "vehicle telemetry failed: " << error.what() << "\n";
    if (initialized)
      apollo::cyber::Clear();
    return 1;
  }
}
