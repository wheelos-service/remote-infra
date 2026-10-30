#include <iostream>

#include "vehicle_edge/auth_client.h"
#include "vehicle_edge/data_client.h"
#include "vehicle_edge/media_demand.h"

int main() {
  try {
    vehicle_edge::DeviceConfig config;
    config.vehicle_id = "installed-test";
    config.gateway_url = "https://gateway.invalid";
    config.token_url = "https://identity.invalid/token";
    vehicle_edge::AuthenticatedClient auth(config);
    vehicle_edge::TelemetryUploader data(config);
    vehicle_edge::StateCache cache;
    const auto now = std::chrono::steady_clock::now();
    const auto packet = cache.Snapshot(config.vehicle_id, "installed-stream", 1,
                                       1700000000000, now);
    if (packet["vehicle_id"] != config.vehicle_id ||
        !packet["chassis"]["message"].isNull())
      return 1;
    vehicle_edge::DemandGate gate(config.vehicle_id);
    if (gate.Current(now).required)
      return 1;
    // Must fail before OAuth/network, even for an installed standalone SDK.
    try {
      auth.Get("https://other.invalid/api/vehicles");
      return 1;
    } catch (const std::invalid_argument &) {
    }
    std::cout << "installed auth/data/state/runtime SDK consumer passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
