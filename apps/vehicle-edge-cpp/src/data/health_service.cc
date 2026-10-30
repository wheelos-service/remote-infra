#include "vehicle_edge/health_service.h"

#include <algorithm>
#include <set>

namespace vehicle_edge {

void HealthService::Observe(const Json::Value &sample, std::int64_t now_ms) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!sample["age_ms"].isInt64() || sample["age_ms"].asInt64() > 2000 ||
      !sample["source_timestamp_ms"].isInt64() ||
      sample["source_timestamp_ms"].asInt64() < now_ms - 3000 ||
      sample["source_timestamp_ms"].asInt64() > now_ms + 100 ||
      !sample["message"].isObject()) {
    recovery_since_.clear();
    return;
  }
  const auto stamp = sample["source_timestamp_ms"].asInt64();
  const auto &message = sample["message"];
  const bool complete = message["components_truncated"].isBool() &&
                        !message["components_truncated"].asBool();
  std::set<std::string> seen;
  const auto observe = [&](const std::string &key, const Json::Value &status) {
    if (!status["status"].isString()) {
      recovery_since_.erase(key);
      return;
    }
    const auto severity = status["status"].asString();
    const auto text = status["message"].isString()
                          ? status["message"].asString()
                          : std::string();
    if (severity == "WARN" || severity == "ERROR" || severity == "FATAL") {
      recovery_since_.erase(key);
      store_.ObserveFault(vehicle_, key, severity, text, stamp);
    } else if (severity == "OK" && complete) {
      seen.insert(key);
      auto inserted = recovery_since_.emplace(key, Recovery{stamp, stamp});
      auto &recovery = inserted.first->second;
      if (stamp - recovery.last_ms > 2500)
        recovery.first_ms = stamp;
      recovery.last_ms = std::max(recovery.last_ms, stamp);
      // Unknown/missing/stale/truncated observations cannot satisfy hysteresis.
      if (stamp - recovery.first_ms >= 2000)
        store_.ObserveFault(vehicle_, key, severity, text, stamp);
    } else {
      recovery_since_.erase(key);
    }
  };
  for (const auto *group : {"components", "hmi_modules", "other_components"}) {
    const auto &entries = message[group];
    if (!entries.isObject())
      continue;
    for (const auto &name : entries.getMemberNames()) {
      if (!ValidIdentifier(name))
        continue;
      const auto key = std::string(group) + "/" + name;
      if (std::string(group) == "components") {
        for (const auto *check :
             {"summary", "process", "channel", "resource", "other", "module"})
          observe(key + "/" + check, entries[name][check]);
      } else {
        observe(key, entries[name]);
      }
      if (message["require_emergency_stop"].isBool()) {
        Json::Value status;
        status["status"] =
            message["require_emergency_stop"].asBool() ? "FATAL" : "OK";
        status["message"] = "Monitor require_emergency_stop";
        observe("monitor/require_emergency_stop", status);
      }
    }
  }
  for (auto it = recovery_since_.begin(); it != recovery_since_.end();) {
    if (!seen.count(it->first))
      it = recovery_since_.erase(it);
    else
      ++it;
  }
}

} // namespace vehicle_edge
