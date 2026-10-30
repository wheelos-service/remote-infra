#pragma once

#include <cstdint>
#include <set>
#include <string>

#include "vehicle_edge/state_cache.h"

namespace vehicle_edge {

struct MediaAuthorization {
  bool required = false;
  SteadyTime deadline{};
  std::uint64_t generation = 0;
};

// Owned by the polling task; callers synchronize access to this gate.
class DemandGate {
public:
  explicit DemandGate(std::string vehicle_id);
  bool Accept(const Json::Value &value, SteadyTime requested,
              SteadyTime received);
  void Fail();
  MediaAuthorization Current(SteadyTime now) const;

private:
  std::string vehicle_id_;
  std::string epoch_;
  std::set<std::string> retired_epochs_;
  Json::Value membership_;
  std::int64_t revision_ = 0;
  std::int64_t server_time_ = 0;
  MediaAuthorization authorization_;
};

} // namespace vehicle_edge
