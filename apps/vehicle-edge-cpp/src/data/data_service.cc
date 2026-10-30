#include "vehicle_edge/data_service.h"

#include <iostream>
#include <stdexcept>

namespace vehicle_edge {

DataService::DataService(DeviceConfig config, std::shared_ptr<StateCache> cache,
                         std::unique_ptr<TaskAdapter> adapter)
    : config_(std::move(config)), cache_(std::move(cache)),
      store_(config_.data_store_path), health_(config_.vehicle_id, store_),
      adapter_(adapter ? std::move(adapter)
               : config_.task_mode == "simulation"
                   ? std::make_unique<SimulationTaskAdapter>()
                   : nullptr),
      tasks_(config_.vehicle_id, config_.task_mode, config_.map_id, store_,
             adapter_.get()),
      telemetry_client_(config_), health_client_(config_),
      reliable_client_(config_), stream_id_(NewStreamID()) {
  if (!cache_ || (config_.task_mode == "mission_query" && !adapter_))
    throw std::invalid_argument(
        "Data service requires cache and configured task adapter");
  if (!ValidIdentifier(config_.vehicle_id) ||
      (config_.task_mode != "disabled" && config_.task_mode != "simulation" &&
       config_.task_mode != "mission_query"))
    throw std::invalid_argument("invalid Data service vehicle/task mode");
  InitializeHTTPTransport();
  try {
    telemetry_thread_ = std::thread([this] { RunTelemetry(); });
    health_thread_ = std::thread([this] { RunHealth(); });
    task_thread_ = std::thread([this] { RunTasks(); });
  } catch (...) {
    stop_ = true;
    if (telemetry_thread_.joinable())
      telemetry_thread_.join();
    if (health_thread_.joinable())
      health_thread_.join();
    throw;
  }
}
DataService::~DataService() {
  stop_ = true;
  telemetry_thread_.join();
  health_thread_.join();
  task_thread_.join();
}
void DataService::Sleep(int milliseconds) {
  for (int elapsed = 0; elapsed < milliseconds && !stop_; elapsed += 50)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
}
void DataService::ObserveHealth(const Json::Value &sample) {
  health_.Observe(sample, UnixMilliseconds());
}
void DataService::RunTelemetry() {
  std::uint64_t sequence = 0;
  bool failed = false;
  while (!stop_) {
    try {
      telemetry_client_.Upload(cache_->Snapshot(
          config_.vehicle_id, stream_id_, ++sequence, UnixMilliseconds(),
          std::chrono::steady_clock::now()));
      if (failed)
        std::cerr << "data telemetry upload recovered\n";
      failed = false;
    } catch (const std::exception &error) {
      if (!failed)
        std::cerr << "data telemetry upload failed: " << error.what() << "\n";
      failed = true;
    }
    Sleep(config_.upload_interval_ms);
  }
}
void DataService::RunHealth() {
  std::uint64_t sequence = 0;
  bool profile_sent = false, failed = false;
  while (!stop_) {
    try {
      Json::Value packet;
      packet["schema_version"] = 1;
      packet["vehicle_id"] = config_.vehicle_id;
      packet["stream_id"] = stream_id_;
      packet["sequence"] = Json::UInt64(++sequence);
      packet["published_at_ms"] = Json::Int64(UnixMilliseconds());
      if (!profile_sent) {
        packet["type"] = "vehicle_profile";
        packet["model"] = config_.vehicle_model;
        packet["software_version"] = config_.software_version;
        packet["map_id"] = config_.map_id;
        packet["task_mode"] = config_.task_mode;
        health_client_.Publish("profile", packet);
        profile_sent = true;
      }
      packet["type"] = "vehicle_health";
      packet.removeMember("model");
      packet.removeMember("software_version");
      packet.removeMember("map_id");
      packet.removeMember("task_mode");
      packet["sample"] = cache_->AuxiliarySnapshot(
          std::chrono::steady_clock::now())["system_status"];
      health_client_.Publish("health", packet);
      packet.removeMember("sample");
      packet["type"] = "vehicle_data_diagnostics";
      packet["store"] = store_.Statistics();
      health_client_.Publish("diagnostics", packet);
      if (failed)
        std::cerr << "data health upload recovered\n";
      failed = false;
    } catch (const std::exception &error) {
      if (!failed)
        std::cerr << "data health upload failed: " << error.what() << "\n";
      failed = true;
    }
    Sleep(config_.upload_interval_ms);
  }
}
void DataService::RunTasks() {
  bool failed = false;
  while (!stop_) {
    try {
      tasks_.Tick(UnixMilliseconds());
      const auto upload = store_.NextUpload();
      if (upload) {
        reliable_client_.Publish(upload->kind, upload->payload);
        store_.Acknowledge(upload->id);
      }
      // Local reconciliation continues even when the network is unavailable.
      if (!store_.NextTask()) {
        const auto task = reliable_client_.PullTask();
        if (task)
          tasks_.Receive(*task);
      }
      if (failed)
        std::cerr << "data task/event transport recovered\n";
      failed = false;
    } catch (const std::exception &error) {
      if (!failed)
        std::cerr << "data task/event processing failed: " << error.what()
                  << "\n";
      failed = true;
    }
    Sleep(200);
  }
}

} // namespace vehicle_edge
