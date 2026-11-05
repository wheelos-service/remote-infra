#include "vehicle_edge/http_client.h"

#include <algorithm>
#include <cctype>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string_view>

namespace vehicle_edge {
namespace {

constexpr std::size_t kMaxResponseBytes = 65536;

std::size_t Receive(char *data, std::size_t size, std::size_t count,
                    void *context) {
  auto *body = static_cast<std::string *>(context);
  if (size != 0 && count > kMaxResponseBytes / size)
    return 0;
  const auto bytes = size * count;
  if (body->size() + bytes > kMaxResponseBytes)
    return 0;
  body->append(data, bytes);
  return bytes;
}

bool IsKnownGatewayErrorCode(std::string_view code) {
  static constexpr std::string_view codes[] = {
      "AUTH_BEARER_REQUIRED",
      "AUTH_INVALID_TOKEN",
      "AUTH_SERVICE_UNAVAILABLE",
      "VEHICLE_REGISTRY_UNAVAILABLE",
      "VEHICLE_IDENTITY_MISMATCH",
      "VEHICLE_IDENTITY_SERVICE_UNAVAILABLE",
      "VEHICLE_NOT_REGISTERED",
      "VEHICLE_IDENTITY_REQUIRED",
      "VEHICLE_IDENTITY_UNBOUND",
      "MEDIA_TOKEN_ISSUANCE_FAILED",
      "METHOD_NOT_ALLOWED",
  };
  return std::find(std::begin(codes), std::end(codes), code) !=
         std::end(codes);
}

std::size_t ReceiveHeader(char *data, std::size_t size, std::size_t count,
                          void *context) {
  if (size != 0 && count > 8192 / size)
    return 0;
  const auto bytes = size * count;
  const std::string_view line(data, bytes);
  if (line.rfind("HTTP/", 0) == 0) {
    auto *response = static_cast<HTTPResponse *>(context);
    response->request_id.clear();
    response->error_code.clear();
    return bytes;
  }
  const auto colon = line.find(':');
  if (colon == std::string_view::npos)
    return bytes;

  auto equal_ascii_case_insensitive = [](std::string_view left,
                                         std::string_view right) {
    if (left.size() != right.size())
      return false;
    for (std::size_t i = 0; i < left.size(); ++i) {
      if (std::tolower(static_cast<unsigned char>(left[i])) !=
          std::tolower(static_cast<unsigned char>(right[i])))
        return false;
    }
    return true;
  };

  const std::string_view name = line.substr(0, colon);
  const auto value_start = line.find_first_not_of(" \t", colon + 1);
  if (value_start == std::string_view::npos)
    return bytes;
  auto value_end = line.find_last_not_of(" \t\r\n");
  if (value_end == std::string_view::npos || value_end < value_start)
    return bytes;
  const auto value = line.substr(value_start, value_end - value_start + 1);
  auto *response = static_cast<HTTPResponse *>(context);
  if (equal_ascii_case_insensitive(name, "X-Request-ID")) {
    const bool safe = value.size() <= 128 &&
                      !value.empty() &&
                      std::all_of(value.begin(), value.end(), [](char ch) {
                        const auto c = static_cast<unsigned char>(ch);
                        return (c >= 'A' && c <= 'Z') ||
                               (c >= 'a' && c <= 'z') ||
                               (c >= '0' && c <= '9') || c == '.' ||
                               c == '_' || c == '-';
                      });
    response->request_id = safe ? std::string(value) : std::string();
  } else if (equal_ascii_case_insensitive(name, "X-Error-Code") &&
             IsKnownGatewayErrorCode(value)) {
    response->error_code = std::string(value);
  }
  return bytes;
}

void Check(CURLcode result) {
  if (result != CURLE_OK)
    throw std::runtime_error("cannot configure HTTP transport");
}

} // namespace

bool ValidBearerToken(const std::string &token) {
  return !token.empty() &&
         std::all_of(token.begin(), token.end(),
                     [](unsigned char ch) { return ch > 0x20 && ch < 0x7f; });
}

Json::Value ParseHTTPJSON(const std::string &text) {
  Json::CharReaderBuilder builder;
  builder["rejectDupKeys"] = true;
  builder["failIfExtra"] = true;
  Json::Value result;
  std::string errors;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  if (!reader->parse(text.data(), text.data() + text.size(), &result,
                     &errors)) {
    throw std::runtime_error("invalid HTTP response JSON");
  }
  return result;
}

void InitializeHTTPTransport() {
  static const auto initialized = curl_global_init(CURL_GLOBAL_DEFAULT);
  if (initialized != CURLE_OK)
    throw std::runtime_error("cannot initialize HTTP transport");
}

HTTPClient::HTTPClient() : handle_(nullptr) {
  InitializeHTTPTransport();
  handle_ = curl_easy_init();
  if (!handle_)
    throw std::runtime_error("cannot allocate HTTP transport");
}

HTTPClient::~HTTPClient() { curl_easy_cleanup(handle_); }

HTTPResponse HTTPClient::Post(const std::string &url,
                              const std::string &content_type,
                              const std::string &body,
                              const std::string &bearer,
                              bool allow_insecure_localhost) {
  return Request(url, content_type, body, bearer, allow_insecure_localhost,
                 true);
}

HTTPResponse HTTPClient::Get(const std::string &url, const std::string &bearer,
                             bool allow_insecure_localhost) {
  return Request(url, "application/json", "", bearer, allow_insecure_localhost,
                 false);
}

HTTPResponse HTTPClient::Request(const std::string &url,
                                 const std::string &content_type,
                                 const std::string &body,
                                 const std::string &bearer,
                                 bool allow_insecure_localhost, bool post) {
  if (!AllowedURL(url, allow_insecure_localhost) ||
      (!bearer.empty() && !ValidBearerToken(bearer))) {
    throw std::invalid_argument("invalid request endpoint or token");
  }
  curl_easy_reset(handle_);
  HTTPResponse response{};
  curl_slist *raw =
      curl_slist_append(nullptr, ("Content-Type: " + content_type).c_str());
  if (!raw)
    throw std::runtime_error("cannot allocate HTTP headers");
  std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> headers(
      raw, curl_slist_free_all);
  if (!bearer.empty()) {
    auto *updated =
        curl_slist_append(raw, ("Authorization: Bearer " + bearer).c_str());
    if (!updated)
      throw std::runtime_error("cannot allocate authorization header");
    headers.release();
    headers.reset(updated);
  }
  auto *updated =
      curl_slist_append(headers.get(), "Accept: application/json");
  if (!updated)
    throw std::runtime_error("cannot allocate HTTP headers");
  headers.release();
  headers.reset(updated);
  Check(curl_easy_setopt(handle_, CURLOPT_URL, url.c_str()));
  Check(curl_easy_setopt(handle_, CURLOPT_HTTPHEADER, headers.get()));
  if (post) {
    Check(curl_easy_setopt(handle_, CURLOPT_POST, 1L));
    Check(curl_easy_setopt(handle_, CURLOPT_POSTFIELDS, body.data()));
    Check(curl_easy_setopt(handle_, CURLOPT_POSTFIELDSIZE_LARGE,
                           static_cast<curl_off_t>(body.size())));
  } else {
    Check(curl_easy_setopt(handle_, CURLOPT_HTTPGET, 1L));
  }
  Check(curl_easy_setopt(handle_, CURLOPT_CONNECTTIMEOUT_MS, 1000L));
  Check(curl_easy_setopt(handle_, CURLOPT_TIMEOUT_MS, 2000L));
  Check(curl_easy_setopt(handle_, CURLOPT_NOSIGNAL, 1L));
  Check(curl_easy_setopt(handle_, CURLOPT_FOLLOWLOCATION, 0L));
  Check(curl_easy_setopt(handle_, CURLOPT_SSL_VERIFYPEER, 1L));
  Check(curl_easy_setopt(handle_, CURLOPT_SSL_VERIFYHOST, 2L));
  Check(curl_easy_setopt(handle_, CURLOPT_WRITEFUNCTION, Receive));
  Check(curl_easy_setopt(handle_, CURLOPT_WRITEDATA, &response.body));
  Check(curl_easy_setopt(handle_, CURLOPT_HEADERFUNCTION, ReceiveHeader));
  Check(curl_easy_setopt(handle_, CURLOPT_HEADERDATA, &response));
  const auto status = curl_easy_perform(handle_);
  if (status != CURLE_OK) {
    throw std::runtime_error("HTTP transport failed (curl code " +
                             std::to_string(static_cast<int>(status)) + ")");
  }
  Check(curl_easy_getinfo(handle_, CURLINFO_RESPONSE_CODE, &response.status));
  return response;
}

std::string HTTPClient::Escape(const std::string &value) const {
  char *escaped =
      curl_easy_escape(handle_, value.c_str(), static_cast<int>(value.size()));
  if (!escaped)
    throw std::runtime_error("cannot encode OAuth request");
  std::unique_ptr<char, decltype(&curl_free)> holder(escaped, curl_free);
  return escaped;
}

} // namespace vehicle_edge
