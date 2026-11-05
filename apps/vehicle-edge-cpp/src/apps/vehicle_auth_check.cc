#include <iostream>
#include <string>

#include "vehicle_edge/diagnostics.h"

int main(int argc, char **argv) {
  bool json = false;
  std::string config_path;
  bool valid = argc == 2 || argc == 3;
  for (int i = 1; valid && i < argc; ++i) {
    const std::string argument(argv[i]);
    if (argument == "--json") {
      if (json)
        valid = false;
      json = true;
    } else if (argument.empty() || argument.front() == '-' ||
               !config_path.empty()) {
      valid = false;
    } else {
      config_path = argument;
    }
  }
  valid = valid && !config_path.empty();
  if (!valid) {
    const std::string usage =
        "usage: vehicle_auth_check [--json] /etc/teleop/device.json\n";
    std::cerr << usage;
    return 2;
  }

  const auto report =
      vehicle_edge::RunVehicleAuthDiagnostic(config_path);
  const auto output = json ? vehicle_edge::DiagnosticReportJSON(report)
                           : vehicle_edge::DiagnosticReportText(report);
  (report.passed || json ? std::cout : std::cerr) << output;
  if (json)
    std::cout << '\n';
  return report.passed ? 0 : 1;
}
