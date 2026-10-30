#include "vehicle_edge/media_demand.h"

#include <algorithm>
#include <cctype>
#include <utility>

namespace vehicle_edge {
namespace {

bool UUID(const std::string &value) {
  if (value.size() != 36)
    return false;
  for (std::size_t i = 0; i < value.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (value[i] != '-')
        return false;
    } else if (!std::isxdigit(static_cast<unsigned char>(value[i]))) {
      return false;
    }
  }
  return true;
}

bool Integer(const Json::Value &value, Json::Int64 minimum,
             Json::Int64 maximum) {
  return value.isInt64() && value.asInt64() >= minimum &&
         value.asInt64() <= maximum;
}

} // namespace

DemandGate::DemandGate(std::string vehicle_id)
    : vehicle_id_(std::move(vehicle_id)) {}

void DemandGate::Fail() {
  if (authorization_.required)
    ++authorization_.generation;
  authorization_.required = false;
  authorization_.deadline = {};
}

bool DemandGate::Accept(const Json::Value &value, SteadyTime requested,
                        SteadyTime received) {
  const auto reject = [this] {
    Fail();
    return false;
  };
  constexpr Json::Int64 max = 9007199254740991LL;
  if (!value.isObject() || value.size() != 10 ||
      value["vehicle_id"] != vehicle_id_ || !value["epoch"].isString() ||
      !UUID(value["epoch"].asString()) || !Integer(value["revision"], 1, max) ||
      !value["rtc_required"].isBool() || !value["video_required"].isBool() ||
      !value["control_required"].isBool() ||
      !Integer(value["viewer_count"], 0, 64) ||
      !Integer(value["server_time_ms"], 1, max) ||
      !Integer(value["valid_until_ms"], 1, max) ||
      !Integer(value["retry_after_ms"], 1000, 1000) || received < requested)
    return reject();
  const auto ttl =
      value["valid_until_ms"].asInt64() - value["server_time_ms"].asInt64();
  const bool required =
      value["viewer_count"].asInt() > 0 || value["control_required"].asBool();
  if (ttl <= 0 || ttl > 5000 || value["rtc_required"].asBool() != required ||
      value["video_required"].asBool() != required)
    return reject();
  const auto deadline = requested + std::chrono::milliseconds(ttl);
  if (deadline <= received)
    return reject();

  const auto epoch = value["epoch"].asString();
  const auto revision = value["revision"].asInt64();
  Json::Value membership(Json::arrayValue);
  membership.append(value["viewer_count"]);
  membership.append(value["control_required"]);
  if (epoch != epoch_) {
    if (retired_epochs_.count(epoch) || retired_epochs_.size() >= 64)
      return reject();
    Fail();
    if (!epoch_.empty())
      retired_epochs_.insert(epoch_);
    epoch_ = epoch;
    revision_ = 0;
    server_time_ = 0;
  }
  if (revision < revision_ ||
      (revision == revision_ && membership != membership_) ||
      value["server_time_ms"].asInt64() <= server_time_)
    return reject();
  if (authorization_.required && received >= authorization_.deadline)
    Fail();
  revision_ = revision;
  server_time_ = value["server_time_ms"].asInt64();
  membership_ = membership;
  if (!required) {
    Fail();
  } else {
    if (!authorization_.required)
      ++authorization_.generation;
    authorization_.required = true;
    authorization_.deadline = deadline;
  }
  return true;
}

MediaAuthorization DemandGate::Current(SteadyTime now) const {
  auto result = authorization_;
  result.required = result.required && now < result.deadline;
  return result;
}

} // namespace vehicle_edge
