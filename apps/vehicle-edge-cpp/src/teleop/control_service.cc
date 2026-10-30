#include "vehicle_edge/control_service.h"

#include <stdexcept>

namespace vehicle_edge {

ControlService::ControlService(DeviceConfig config)
    : config_(std::move(config)), receiver_(config_.vehicle_id) {
  if (config_.control_mode != "simulation")
    throw std::invalid_argument("control requires explicit simulation mode");
  InitializeHTTPTransport();
  client_ = std::make_unique<TeleopClient>(config_);
  poll_ = std::thread(&ControlService::Poll, this);
}

ControlService::~ControlService() { Stop(); }

void ControlService::Stop() {
  std::lock_guard<std::mutex> stopping(stop_mutex_);
  stopped_ = true;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    receiver_.Invalidate("service_stopped");
  }
  wake_.notify_all();
  if (poll_.joinable())
    poll_.join();
}

Json::Value ControlService::Receive(const std::string &sender,
                                    const std::string &body,
                                    SteadyTime received) {
  std::lock_guard<std::mutex> lock(mutex_);
  return receiver_.Receive(sender, body, received,
                           std::chrono::steady_clock::now(),
                           UnixMilliseconds());
}

Json::Value ControlService::Feedback() {
  std::lock_guard<std::mutex> lock(mutex_);
  receiver_.Tick(std::chrono::steady_clock::now());
  return receiver_.Feedback();
}

void ControlService::Invalidate(const std::string &reason) {
  std::lock_guard<std::mutex> lock(mutex_);
  receiver_.Invalidate(reason);
}

void ControlService::Poll() {
  auto &client = *client_;
  while (!stopped_) {
    try {
      const auto started = std::chrono::steady_clock::now();
      const auto context = client.ControlContext();
      bool acknowledge = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopped_)
          return;
        receiver_.UpdateContext(context, started,
                                std::chrono::steady_clock::now());
        const auto feedback = receiver_.Feedback();
        acknowledge = context["state"] == "PENDING" &&
                      context["simulation"] == true &&
                      context["session_id"] == feedback["session_id"] &&
                      context["revision"] == feedback["revision"] &&
                      feedback["status"] == "LOCKED";
      }
      if (acknowledge && !stopped_)
        client.ConfirmSimulation(context["session_id"].asString(),
                                 context["revision"].asInt64());
    } catch (const std::exception &) {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!stopped_)
        receiver_.Invalidate("context_unavailable");
    }
    std::unique_lock<std::mutex> wait(wait_mutex_);
    wake_.wait_for(wait, std::chrono::milliseconds(100),
                   [this] { return stopped_.load(); });
  }
}

} // namespace vehicle_edge
