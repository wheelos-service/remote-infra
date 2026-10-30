#pragma once

#include "vehicle_edge/config.h"

namespace vehicle_edge {

// Runs in the dedicated worker with supervisor socket descriptor 3.
int RunMediaBackend(const DeviceConfig &config);

} // namespace vehicle_edge
