#include <iostream>

#include "vehicle_edge/encoded_video.h"
#include "vehicle_edge/media_service.h"
#include "vehicle_edge/teleop_client.h"
#ifdef CONSUMER_CAMERA_GST
#include "vehicle_edge/camera_gst_adapter.h"
#endif

int main() {
  try {
    vehicle_edge::DeviceConfig config;
    config.vehicle_id = "standalone-test";
    config.gateway_url = "https://gateway.invalid";
    config.token_url = "https://identity.invalid/token";
    config.media_enabled = false;
    vehicle_edge::AuthenticatedClient auth(config);
    vehicle_edge::TeleopClient teleop(config);
    vehicle_edge::ControlReceiver control(config.vehicle_id);
    if (control.Feedback()["status"] != "DISABLED")
      return 1;
    vehicle_edge::DemandGate gate(config.vehicle_id);
    if (gate.Current(std::chrono::steady_clock::now()).required)
      return 1;
    vehicle_edge::EncodedIngress ingress;
    if (ingress.Submit({}, std::chrono::steady_clock::now()) !=
        vehicle_edge::FrameResult::INACTIVE)
      return 1;
    auto cache = std::make_shared<vehicle_edge::StateCache>();
    vehicle_edge::MediaService service(config, "", cache, "standalone-stream");
    if (service.state() != vehicle_edge::MediaState::OFF)
      return 1;
#ifdef CONSUMER_CAMERA_GST
    vehicle_edge::CameraGstAdapter camera(service);
    if (camera.SubmitSample(nullptr) != vehicle_edge::FrameResult::INVALID)
      return 1;
#endif
    try {
      auth.Get("https://other.invalid/api/state");
      return 1;
    } catch (const std::invalid_argument &) {
    }
    std::cout << "standalone auth + teleop consumer passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
