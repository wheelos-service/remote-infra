#pragma once

#include <string>

#include <curl/curl.h>

#include "vehicle_edge/config.h"

namespace vehicle_edge {

struct HTTPResponse {
  long status;
  std::string body;
};

Json::Value ParseHTTPJSON(const std::string &text);
bool ValidBearerToken(const std::string &token);
void InitializeHTTPTransport();

class HTTPClient {
public:
  HTTPClient();
  ~HTTPClient();
  HTTPClient(const HTTPClient &) = delete;
  HTTPClient &operator=(const HTTPClient &) = delete;
  HTTPResponse Post(const std::string &url, const std::string &content_type,
                    const std::string &body, const std::string &bearer,
                    bool allow_insecure_localhost);
  HTTPResponse Get(const std::string &url, const std::string &bearer,
                   bool allow_insecure_localhost);
  std::string Escape(const std::string &value) const;

private:
  HTTPResponse Request(const std::string &url, const std::string &content_type,
                       const std::string &body, const std::string &bearer,
                       bool allow_insecure_localhost, bool post);
  CURL *handle_;
};

} // namespace vehicle_edge
