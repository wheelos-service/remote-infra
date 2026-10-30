#include "vehicle_edge/config.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_set>

#include <curl/curl.h>

#include "vehicle_edge/state_cache.h"

namespace vehicle_edge {
namespace {

struct FDCloser {
  void operator()(int *fd) const {
    close(*fd);
    delete fd;
  }
};

std::string RequiredString(const Json::Value &value, const char *field) {
  if (!value[field].isString() || value[field].asString().empty()) {
    throw std::invalid_argument(
        std::string("missing or invalid config field: ") + field);
  }
  return value[field].asString();
}

} // namespace

bool AllowedURL(const std::string &url, bool allow_insecure_localhost) {
  std::unique_ptr<CURLU, decltype(&curl_url_cleanup)> parsed(curl_url(),
                                                             curl_url_cleanup);
  if (!parsed ||
      curl_url_set(parsed.get(), CURLUPART_URL, url.c_str(), 0) != CURLUE_OK) {
    return false;
  }
  const auto part = [&parsed](CURLUPart key) {
    char *value = nullptr;
    const auto status = curl_url_get(parsed.get(), key, &value, 0);
    std::unique_ptr<char, decltype(&curl_free)> holder(value, curl_free);
    return status == CURLUE_OK ? std::string(value) : std::string();
  };
  const auto scheme = part(CURLUPART_SCHEME);
  const auto host = part(CURLUPART_HOST);
  if (!part(CURLUPART_USER).empty() || !part(CURLUPART_PASSWORD).empty() ||
      !part(CURLUPART_QUERY).empty() || !part(CURLUPART_FRAGMENT).empty() ||
      host.empty())
    return false;
  if (scheme == "https")
    return true;
  return allow_insecure_localhost && scheme == "http" &&
         (host == "localhost" || host == "127.0.0.1" || host == "[::1]");
}

DeviceConfig ParseConfig(const Json::Value &value) {
  const std::unordered_set<std::string> fields = {"vehicle_id",
                                                  "gateway_url",
                                                  "token_url",
                                                  "client_id",
                                                  "client_secret",
                                                  "chassis_channel",
                                                  "localization_channel",
                                                  "node_name",
                                                  "upload_interval_ms",
                                                  "media_enabled",
                                                  "livekit_url",
                                                  "media_worker_path",
                                                  "camera_source",
                                                  "control_mode",
                                                  "camera_track",
                                                  "mission_runtime_channel",
                                                  "mission_result_channel",
                                                  "system_status_channel",
                                                  "data_store_path",
                                                  "task_mode",
                                                  "map_id",
                                                  "vehicle_model",
                                                  "software_version",
                                                  "mission_request_channel",
                                                  "allow_insecure_localhost"};
  if (!value.isObject())
    throw std::invalid_argument("config must be an object");
  for (const auto &name : value.getMemberNames()) {
    if (fields.count(name) == 0)
      throw std::invalid_argument("unknown config field");
  }
  DeviceConfig config;
  config.vehicle_id = RequiredString(value, "vehicle_id");
  config.gateway_url = RequiredString(value, "gateway_url");
  config.token_url = RequiredString(value, "token_url");
  config.client_id = RequiredString(value, "client_id");
  config.client_secret = RequiredString(value, "client_secret");
  if (!ValidIdentifier(config.vehicle_id))
    throw std::invalid_argument("invalid vehicle_id");
  if (value.isMember("allow_insecure_localhost")) {
    if (!value["allow_insecure_localhost"].isBool()) {
      throw std::invalid_argument("allow_insecure_localhost must be boolean");
    }
    config.allow_insecure_localhost =
        value["allow_insecure_localhost"].asBool();
  }
  if (!AllowedURL(config.gateway_url, config.allow_insecure_localhost) ||
      !AllowedURL(config.token_url, config.allow_insecure_localhost)) {
    throw std::invalid_argument(
        "endpoints require HTTPS without credentials/query/fragment");
  }
  while (config.gateway_url.back() == '/')
    config.gateway_url.pop_back();
  if (value.isMember("upload_interval_ms")) {
    if (!value["upload_interval_ms"].isInt() ||
        value["upload_interval_ms"].asInt() < 200 ||
        value["upload_interval_ms"].asInt() > 60000) {
      throw std::invalid_argument(
          "upload_interval_ms must be within 200..60000");
    }
    config.upload_interval_ms = value["upload_interval_ms"].asInt();
  }
  if (value.isMember("chassis_channel")) {
    config.chassis_channel = RequiredString(value, "chassis_channel");
  }
  if (value.isMember("localization_channel")) {
    config.localization_channel = RequiredString(value, "localization_channel");
  }
  if (value.isMember("node_name"))
    config.node_name = RequiredString(value, "node_name");
  if (value.isMember("mission_runtime_channel"))
    config.mission_runtime_channel =
        RequiredString(value, "mission_runtime_channel");
  if (value.isMember("mission_result_channel"))
    config.mission_result_channel =
        RequiredString(value, "mission_result_channel");
  if (value.isMember("system_status_channel"))
    config.system_status_channel =
        RequiredString(value, "system_status_channel");
  for (const auto &entry :
       {std::pair<const char *, std::string *>{"data_store_path",
                                               &config.data_store_path},
        {"map_id", &config.map_id},
        {"vehicle_model", &config.vehicle_model},
        {"software_version", &config.software_version},
        {"mission_request_channel", &config.mission_request_channel}}) {
    if (value.isMember(entry.first))
      *entry.second = RequiredString(value, entry.first);
  }
  if (value.isMember("task_mode"))
    config.task_mode = RequiredString(value, "task_mode");
  if (config.task_mode != "disabled" && config.task_mode != "simulation" &&
      config.task_mode != "mission_query")
    throw std::invalid_argument("invalid task_mode");
  if ((!config.data_store_path.empty() &&
       config.data_store_path.front() != '/') ||
      (config.task_mode != "disabled" && config.data_store_path.empty()) ||
      config.map_id.size() > 128 || config.vehicle_model.size() > 128 ||
      config.software_version.size() > 128 ||
      (config.task_mode == "mission_query" &&
       (config.mission_request_channel.empty() ||
        config.mission_result_channel.empty())))
    throw std::invalid_argument(
        "invalid Data store/profile/task configuration");
  if (value.isMember("media_enabled")) {
    if (!value["media_enabled"].isBool())
      throw std::invalid_argument("media_enabled must be boolean");
    config.media_enabled = value["media_enabled"].asBool();
  }
  if (value.isMember("control_mode")) {
    config.control_mode = RequiredString(value, "control_mode");
    if (config.control_mode != "disabled" &&
        config.control_mode != "simulation")
      throw std::invalid_argument(
          "control_mode must be disabled or simulation");
    if (config.control_mode == "simulation" && !config.media_enabled)
      throw std::invalid_argument("simulation control requires media");
  }
  if (config.media_enabled) {
    config.livekit_url = RequiredString(value, "livekit_url");
    auto endpoint = config.livekit_url;
    if (endpoint.compare(0, 6, "wss://") == 0)
      endpoint.replace(0, 6, "https://");
    else if (endpoint.compare(0, 5, "ws://") == 0)
      endpoint.replace(0, 5, "http://");
    else
      throw std::invalid_argument("livekit_url requires wss");
    if (!AllowedURL(endpoint, config.allow_insecure_localhost))
      throw std::invalid_argument("invalid LiveKit endpoint");
    config.media_worker_path = RequiredString(value, "media_worker_path");
    if (config.media_worker_path.front() != '/')
      throw std::invalid_argument("media_worker_path must be absolute");
    config.camera_source = RequiredString(value, "camera_source");
    if (config.camera_source != "simulation" &&
        config.camera_source != "h264_annexb")
      throw std::invalid_argument(
          "camera_source must be simulation or h264_annexb");
    if (value.isMember("camera_track"))
      config.camera_track = RequiredString(value, "camera_track");
    if (!ValidIdentifier(config.camera_track))
      throw std::invalid_argument("invalid camera_track");
  }
  return config;
}

DeviceConfig LoadConfig(const std::string &path) {
  const int raw =
      open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (raw < 0)
    throw std::runtime_error("cannot open protected device config");
  std::unique_ptr<int, FDCloser> fd(new int(raw));
  struct stat info {};
  if (fstat(raw, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != 0 ||
      (info.st_mode & 0777) != 0600 || info.st_size > 16384) {
    throw std::runtime_error(
        "device config must be root-owned regular file mode 0600, <=16 KiB");
  }
  std::string text;
  char chunk[1024];
  ssize_t size;
  while ((size = read(raw, chunk, sizeof(chunk))) > 0) {
    text.append(chunk, static_cast<std::size_t>(size));
    if (text.size() > 16384)
      throw std::runtime_error("device config exceeds size limit");
  }
  if (size < 0)
    throw std::runtime_error("cannot read device config");
  Json::CharReaderBuilder builder;
  builder["rejectDupKeys"] = true;
  builder["failIfExtra"] = true;
  builder["allowComments"] = false;
  Json::Value value;
  std::string errors;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  if (!reader->parse(text.data(), text.data() + text.size(), &value, &errors)) {
    throw std::runtime_error("invalid device config JSON");
  }
  return ParseConfig(value);
}

} // namespace vehicle_edge
