#include <iostream>
#include <memory>
#include <string>

#include <livekit/livekit.h>

#include "vehicle_edge/config.h"
#include "vehicle_edge/media_backend.h"

int main(int argc, char **argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--sdk-smoke") {
      livekit::initialize(livekit::LogLevel::Off);
      {
        livekit::Room room;
        auto source = std::make_shared<livekit::VideoSource>(640, 480);
        auto frame = livekit::VideoFrame::create(
            640, 480, livekit::VideoBufferType::RGBA);
        source->captureFrame(frame);
      }
      livekit::shutdown();
      return 0;
    }
    if (argc != 2)
      return 2;
    return vehicle_edge::RunMediaBackend(vehicle_edge::LoadConfig(argv[1]));
  } catch (const std::exception &) {
    std::cerr << "media worker failed (details suppressed)\n";
    return 1;
  }
}
