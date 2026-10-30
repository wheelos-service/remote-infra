#include <csignal>
#include <iostream>
#include <memory>
#include <string>
#include <thread>

#include "vehicle_edge/config.h"
#include "vehicle_edge/media_service.h"

namespace {

volatile std::sig_atomic_t stopping = 0;
void OnSignal(int) { stopping = 1; }

} // namespace

int main(int argc, char **argv) {
  if (argc == 2 && std::string(argv[1]) == "--help") {
    std::cout << "teleop_simulation /etc/teleop/device.json [--check-config]\n"
                 "Synthetic video and optional simulation-only control; "
                 "no data uploader or vehicle writer.\n";
    return 0;
  }
  if (argc < 2 || argc > 3 ||
      (argc == 3 && std::string(argv[2]) != "--check-config")) {
    std::cerr
        << "usage: teleop_simulation protected-device.json [--check-config]\n";
    return 2;
  }
  try {
    const auto config = vehicle_edge::LoadConfig(argv[1]);
    if (argc == 3) {
      std::cout
          << "protected configuration valid; no network or camera started\n";
      return 0;
    }
    if (!config.media_enabled || config.camera_source != "simulation") {
      std::cerr
          << "example requires explicitly enabled simulation; "
             "real frames must be supplied by an embedding camera owner\n";
      return 2;
    }
    std::signal(SIGINT, OnSignal);
    std::signal(SIGTERM, OnSignal);
    auto cache = std::make_shared<vehicle_edge::StateCache>();
    vehicle_edge::MediaService teleop(config, argv[1], cache,
                                      vehicle_edge::NewStreamID());
    std::cerr << "synthetic media waiting for demand; vehicle samples remain "
                 "missing; control_mode="
              << config.control_mode << "; no physical vehicle writer\n";
    auto previous = vehicle_edge::MediaState::OFF;
    while (!stopping) {
      const auto state = teleop.state();
      if (state != previous) {
        std::cerr << "media state=" << static_cast<int>(state) << '\n';
        previous = state;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    teleop.Stop();
    return 0;
  } catch (const std::exception &) {
    std::cerr
        << "teleop example failed; check protected config and installation "
           "(details suppressed)\n";
    return 1;
  }
}
