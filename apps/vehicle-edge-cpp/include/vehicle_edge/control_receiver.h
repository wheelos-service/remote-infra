#pragma once

#include "vehicle_edge/state_cache.h"

namespace vehicle_edge {

// Single-threaded protocol engine. Output is a simulated setpoint, never a
// Cyber/actuator write. The host must call Tick at least every 20 ms.
class ControlReceiver {
public:
  explicit ControlReceiver(std::string vehicle_id);
  ControlReceiver(const ControlReceiver &) = delete;
  ControlReceiver &operator=(const ControlReceiver &) = delete;
  void UpdateContext(const Json::Value &value, SteadyTime request_started,
                     SteadyTime now);
  Json::Value Receive(const std::string &sender, const std::string &body,
                      SteadyTime received, SteadyTime now,
                      std::int64_t wall_ms);
  void Tick(SteadyTime now);
  void Invalidate(const std::string &reason);
  Json::Value Feedback() const;

private:
  std::string vehicle_id_, session_id_, client_id_, sender_, public_key_;
  std::string instance_id_;
  std::string status_ = "DISABLED", reason_ = "no_session";
  std::string rejection_;
  std::int64_t revision_ = 0, sequence_ = 0;
  SteadyTime deadline_{}, last_command_{};
  Json::Value command_;
  bool latched_ = false;
};

} // namespace vehicle_edge
