#pragma once

#include "vehicle_edge/state_cache.h"
#include "wheelos_msgs/chassis_msgs/chassis.pb.h"
#include "wheelos_msgs/localization_msgs/localization.pb.h"
#include "wheelos_msgs/mission_msgs/mission_runtime_status.pb.h"
#include "wheelos_msgs/monitor_msgs/system_status.pb.h"

namespace vehicle_edge {

void ReceiveChassis(const apollo::canbus::Chassis &message, StateCache *cache,
                    SteadyTime received);
void ReceiveLocalization(
    const apollo::localization::LocalizationEstimate &message,
    StateCache *cache, SteadyTime received);
void ReceiveMissionRuntime(const apollo::mission::MissionRuntimeStatus &message,
                           StateCache *cache, SteadyTime received);
Json::Value
ReceiveMissionResult(const apollo::mission::MissionRequestResult &message,
                     StateCache *cache, SteadyTime received);
Json::Value ReceiveSystemStatus(const apollo::monitor::SystemStatus &message,
                                StateCache *cache, SteadyTime received);

} // namespace vehicle_edge
