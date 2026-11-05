#include "vehicle_edge/diagnostics.h"

#include <chrono>
#include <exception>
#include <iterator>
#include <memory>
#include <utility>

#include "vehicle_edge/auth_client.h"

namespace vehicle_edge {
namespace {

using Clock = std::chrono::steady_clock;

DiagnosticStage MakeStage(std::string name, std::string label,
                          Clock::time_point started) {
  DiagnosticStage stage;
  stage.name = std::move(name);
  stage.label = std::move(label);
  stage.started_at = started;
  return stage;
}

void AddFailure(DiagnosticReport &report, DiagnosticStage stage,
                const std::string &code, const std::string &message,
                long status = 0, const HTTPResponse *response = nullptr) {
  stage.elapsed_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() -
                                                            stage.started_at)
          .count();
  stage.passed = false;
  stage.code = code;
  stage.message = message;
  stage.http_status = status;
  if (response != nullptr) {
    stage.request_id = response->request_id;
    stage.gateway_error_code = response->error_code;
  }
  report.stages.push_back(std::move(stage));
  report.passed = false;
}

void AddSuccess(DiagnosticReport &report, DiagnosticStage stage,
               const HTTPResponse *response = nullptr) {
  stage.elapsed_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() -
                                                            stage.started_at)
          .count();
  stage.passed = true;
  if (response != nullptr)
    stage.request_id = response->request_id;
  report.stages.push_back(std::move(stage));
}

bool Contains(const Json::Value &values, const std::string &wanted) {
  if (!values.isArray())
    return false;
  for (const auto &value : values) {
    if (value.isString() && value.asString() == wanted)
      return true;
  }
  return false;
}

bool FailStatus(DiagnosticReport &report, const DiagnosticStage &stage,
               const HTTPResponse &response, const std::string &code,
               const std::string &message, long expected_status) {
  if (response.status == expected_status)
    return false;
  AddFailure(report, stage, code, message, response.status,
             &response);
  return true;
}

} // namespace

DiagnosticReport RunVehicleAuthDiagnostic(const std::string &config_path) {
  DiagnosticReport report;
  const auto started = Clock::now();
  DeviceConfig config;
  try {
    config = LoadConfig(config_path);
    auto stage =
        MakeStage("configuration", "protected device configuration", started);
    AddSuccess(report, std::move(stage));
  } catch (const std::exception &) {
    auto stage =
        MakeStage("configuration", "protected device configuration", started);
    AddFailure(report, std::move(stage), "configuration_invalid",
               "Protected device configuration could not be loaded or validated");
    return report;
  } catch (...) {
    auto stage =
        MakeStage("configuration", "protected device configuration", started);
    AddFailure(report, std::move(stage), "configuration_invalid",
               "Protected device configuration could not be loaded or validated");
    return report;
  }
  auto runtime = RunVehicleAuthDiagnostic(config);
  report.stages.insert(report.stages.end(),
                       std::make_move_iterator(runtime.stages.begin()),
                       std::make_move_iterator(runtime.stages.end()));
  report.passed = runtime.passed;
  return report;
}

DiagnosticReport RunVehicleAuthDiagnostic(const DeviceConfig &config) {
  DiagnosticReport report;
  std::unique_ptr<AuthenticatedClient> client;
  {
    const auto started = Clock::now();
    auto stage =
        MakeStage("oauth_token_acquisition", "OAuth token acquisition", started);
    try {
      client = std::make_unique<AuthenticatedClient>(config);
      client->AcquireToken();
      AddSuccess(report, std::move(stage));
    } catch (const AuthClientError &error) {
      AddFailure(report, std::move(stage), error.code(),
                 "OAuth token acquisition failed; check the configured issuer and client setup",
                 error.http_status());
      return report;
    } catch (...) {
      AddFailure(report, std::move(stage), "oauth_transport_error",
                 "OAuth token request failed at the transport");
      return report;
    }
  }

  HTTPResponse identity;
  {
    const auto started = Clock::now();
    auto stage = MakeStage("gateway_identity", "OAuth/Gateway authentication",
                           started);
    try {
      identity = client->Get("/api/auth/me");
    } catch (const AuthClientError &error) {
      AddFailure(report, std::move(stage), error.code(),
                 "OAuth refresh failed before Gateway identity request",
                 error.http_status());
      return report;
    } catch (...) {
      AddFailure(report, std::move(stage), "gateway_identity_transport_error",
                 "Gateway identity request failed at the transport");
      return report;
    }
    if (FailStatus(report, std::move(stage), identity,
                   "gateway_identity_http_error",
                   "Gateway did not accept the vehicle identity", 200))
      return report;

    try {
      const auto claims = ParseHTTPJSON(identity.body);
      if (!claims["Name"].isString() || claims["Name"].asString().empty() ||
          (!Contains(claims["Roles"], "vehicle") &&
           !Contains(claims["Scopes"], "teleop:vehicle"))) {
        AddFailure(report, std::move(stage),
                   "gateway_identity_invalid",
                   "Gateway identity is missing a vehicle subject or vehicle permission",
                   identity.status, &identity);
        return report;
      }
    } catch (...) {
      AddFailure(report, std::move(stage), "gateway_identity_invalid",
                 "Gateway identity response was missing or invalid",
                 identity.status, &identity);
      return report;
    }
    AddSuccess(report, std::move(stage), &identity);
  }

  {
    const auto started = Clock::now();
    auto stage = MakeStage("vehicle_subject_mapping",
                           "vehicle registration/subject mapping", started);
    HTTPResponse mapped;
    try {
      mapped = client->Get("/api/vehicles/" + config.vehicle_id +
                           "/device-auth-check");
    } catch (const AuthClientError &error) {
      AddFailure(report, std::move(stage), error.code(),
                 "OAuth refresh failed before vehicle subject mapping request",
                 error.http_status());
      return report;
    } catch (...) {
      AddFailure(report, std::move(stage), "vehicle_mapping_transport_error",
                 "Vehicle subject mapping request failed at the transport");
      return report;
    }
    if (FailStatus(report, std::move(stage), mapped,
                   "vehicle_mapping_http_error",
                   "Gateway did not confirm the configured vehicle mapping",
                   204))
      return report;
    AddSuccess(report, std::move(stage), &mapped);
  }

  {
    const auto started = Clock::now();
    auto stage = MakeStage("livekit_token_issuance",
                           "vehicle LiveKit token issuance", started);
    HTTPResponse media;
    try {
      media = client->Get("/api/token/vehicle");
    } catch (const AuthClientError &error) {
      AddFailure(report, std::move(stage), error.code(),
                 "OAuth refresh failed before vehicle LiveKit token issuance request",
                 error.http_status());
      return report;
    } catch (...) {
      AddFailure(report, std::move(stage), "livekit_token_transport_error",
                 "Vehicle token request failed at the transport");
      return report;
    }
    if (FailStatus(report, std::move(stage), media,
                   "livekit_token_http_error",
                   "Gateway did not issue a vehicle LiveKit token", 200))
      return report;
    try {
      const auto token_response = ParseHTTPJSON(media.body);
      if (!token_response["token"].isString() ||
          !ValidBearerToken(token_response["token"].asString())) {
        AddFailure(report, std::move(stage),
                   "livekit_token_response_invalid",
                   "Gateway returned an invalid vehicle token response",
                   media.status, &media);
        return report;
      }
    } catch (...) {
      AddFailure(report, std::move(stage), "livekit_token_response_invalid",
                 "Gateway returned an invalid vehicle token response",
                 media.status, &media);
      return report;
    }
    AddSuccess(report, std::move(stage), &media);
  }

  report.passed = true;
  return report;
}

std::string DiagnosticReportJSON(const DiagnosticReport &report) {
  Json::Value result(Json::objectValue);
  result["ok"] = report.passed;
  result["scope_note"] =
      "Checks local configuration, OAuth/Gateway identity, vehicle mapping, "
      "and token issuance only; RTC/video/Cyber/control are not tested.";
  Json::Value stages(Json::arrayValue);
  for (const auto &stage : report.stages) {
    Json::Value item(Json::objectValue);
    item["stage"] = stage.name;
    item["status"] = stage.passed ? "passed" : "failed";
    item["elapsed_ms"] = Json::Int64(stage.elapsed_ms);
    if (!stage.passed) {
      item["code"] = stage.code;
      item["message"] = stage.message;
      if (stage.http_status != 0)
        item["http_status"] = Json::Int64(stage.http_status);
      if (!stage.gateway_error_code.empty())
        item["gateway_error_code"] = stage.gateway_error_code;
    }
    if (!stage.request_id.empty())
      item["request_id"] = stage.request_id;
    stages.append(std::move(item));
  }
  result["stages"] = std::move(stages);
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "  ";
  return Json::writeString(writer, result);
}

std::string DiagnosticReportText(const DiagnosticReport &report) {
  std::string output;
  for (const auto &stage : report.stages) {
    if (stage.passed) {
      if (stage.name == "configuration")
        output += "[OK] protected device configuration\n";
      else if (stage.name == "gateway_identity")
        output += "[OK] OAuth token accepted by Gateway with vehicle permission\n";
      else if (stage.name == "vehicle_subject_mapping")
        output += "[OK] device subject maps to the configured registered vehicle\n";
      else if (stage.name == "livekit_token_issuance")
        output += "[OK] Gateway issued a short-lived vehicle LiveKit token; token discarded\n";
      continue;
    }
    output += "[FAIL] " + stage.label + ": " + stage.message +
              " (code=" + stage.code;
    if (stage.http_status != 0)
      output += ", HTTP " + std::to_string(stage.http_status);
    output += ")\n";
    if (!stage.gateway_error_code.empty())
      output += "Gateway error code: " + stage.gateway_error_code + "\n";
    if (!stage.request_id.empty())
      output += "Gateway request ID: " + stage.request_id + "\n";
  }
  output += "Scope: checks configuration, OAuth/Gateway identity, vehicle "
            "mapping, and token issuance only; RTC/video/Cyber/control were "
            "not tested.\n";
  return output;
}

} // namespace vehicle_edge
