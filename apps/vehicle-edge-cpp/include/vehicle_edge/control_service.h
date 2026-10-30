#pragma once

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>

#include "vehicle_edge/control_receiver.h"
#include "vehicle_edge/teleop_client.h"

namespace vehicle_edge {

// Explicit simulation-only host. No physical ACK or vehicle writer is linked.
class ControlService {
public:
  explicit ControlService(DeviceConfig config);
  ~ControlService();
  ControlService(const ControlService &) = delete;
  ControlService &operator=(const ControlService &) = delete;
  Json::Value Receive(const std::string &sender, const std::string &body,
                      SteadyTime received);
  Json::Value Feedback();
  void Invalidate(const std::string &reason);
  void Stop();

private:
  void Poll();
  DeviceConfig config_;
  ControlReceiver receiver_;
  std::unique_ptr<TeleopClient> client_;
  std::mutex mutex_, stop_mutex_, wait_mutex_;
  std::condition_variable wake_;
  std::atomic<bool> stopped_{false};
  std::thread poll_;
};

} // namespace vehicle_edge
