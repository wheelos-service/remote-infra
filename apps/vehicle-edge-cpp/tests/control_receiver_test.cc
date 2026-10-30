#include "vehicle_edge/control_receiver.h"

#include <iostream>
#include <memory>
#include <stdexcept>

#include <openssl/evp.h>

namespace {
using namespace std::chrono_literals;
using vehicle_edge::EncodeJSON;

void Require(bool condition, const char *reason) {
  if (!condition)
    throw std::runtime_error(reason);
}

std::string Base64(const unsigned char *data, std::size_t size) {
  std::string text(4 * ((size + 2) / 3), '\0');
  EVP_EncodeBlock(reinterpret_cast<unsigned char *>(text.data()), data, size);
  return text;
}

struct Fixture {
  vehicle_edge::ControlReceiver receiver{"car-test"};
  vehicle_edge::SteadyTime now = std::chrono::steady_clock::now();
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key{nullptr,
                                                          EVP_PKEY_free};
  Json::Value context, command;
  Fixture() {
    std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> generator(
        EVP_PKEY_CTX_new_id(EVP_PKEY_ED25519, nullptr), EVP_PKEY_CTX_free);
    EVP_PKEY *raw = nullptr;
    Require(generator && EVP_PKEY_keygen_init(generator.get()) == 1 &&
                EVP_PKEY_keygen(generator.get(), &raw) == 1,
            "key generation failed");
    key.reset(raw);
    unsigned char public_key[32];
    std::size_t size = sizeof(public_key);
    Require(EVP_PKEY_get_raw_public_key(key.get(), public_key, &size) == 1,
            "public key failed");
    context["vehicle_id"] = "car-test";
    context["simulation"] = true;
    context["revision"] = 1;
    context["session_id"] = "session-test";
    context["state"] = "ACTIVE";
    context["ttl_ms"] = 10000;
    auto &session = context["session"];
    session["session_id"] = "session-test";
    session["vehicle_id"] = "car-test";
    session["status"] = "ACTIVE";
    session["protocol_version"] = 2;
    session["sender_identity"] = "control-session-test";
    session["client_instance_id"] = "browser-test";
    session["public_key_b64"] = Base64(public_key, size);
    receiver.UpdateContext(context, now, now);
    command["version"] = 2;
    command["type"] = "control";
    command["vehicle_id"] = "car-test";
    command["session_id"] = "session-test";
    command["client_instance_id"] = "browser-test";
    command["receiver_instance_id"] =
        receiver.Feedback()["receiver_instance_id"];
    command["revision"] = 1;
    command["sequence"] = 1;
    command["timestamp_ms"] = Json::Int64(1700000000000LL);
    auto &c = command["command"];
    c["steering"] = -100;
    c["throttle"] = 100;
    c["brake"] = 0;
    c["direction"] = 1;
  }
  std::string Sign() {
    Json::Value canonical(Json::arrayValue);
    for (const char *field :
         {"version", "type", "vehicle_id", "session_id", "client_instance_id",
          "receiver_instance_id", "revision", "sequence", "timestamp_ms"})
      canonical.append(command[field]);
    for (const char *field : {"steering", "throttle", "brake", "direction"})
      canonical.append(command["command"][field]);
    const auto message = EncodeJSON(canonical);
    std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> signer(
        EVP_MD_CTX_new(), EVP_MD_CTX_free);
    unsigned char signature[64];
    std::size_t size = sizeof(signature);
    Require(EVP_DigestSignInit(signer.get(), nullptr, nullptr, nullptr,
                               key.get()) == 1 &&
                EVP_DigestSign(
                    signer.get(), signature, &size,
                    reinterpret_cast<const unsigned char *>(message.data()),
                    message.size()) == 1,
            "signature failed");
    command["signature"] = Base64(signature, size);
    return EncodeJSON(command);
  }
  Json::Value Receive(const std::string &body,
                      const std::string &sender = "control-session-test") {
    return receiver.Receive(sender, body, now, now, 1700000000000LL);
  }
};
} // namespace

int main(int argc, char **) {
  try {
    if (argc > 1) {
      // Cross-language harness receives a context, then emits its random
      // instance before the frontend signs a command bound to this process.
      Json::Value input;
      std::string line;
      std::getline(std::cin, line);
      Json::CharReaderBuilder builder;
      std::unique_ptr<Json::CharReader> parser(builder.newCharReader());
      std::string errors;
      Require(parser->parse(line.data(), line.data() + line.size(), &input,
                            &errors),
              "invalid vector context");
      vehicle_edge::ControlReceiver receiver("car-test");
      auto now = std::chrono::steady_clock::now();
      receiver.UpdateContext(input, now, now);
      std::cout << EncodeJSON(receiver.Feedback()) << std::endl;
      std::getline(std::cin, line);
      now = std::chrono::steady_clock::now();
      const auto feedback = receiver.Receive("control-session-test", line, now,
                                             now, 1700000000000LL);
      Require(feedback["status"] == "APPLIED", "frontend signature rejected");
      std::cout << EncodeJSON(feedback) << std::endl;
      return 0;
    }
    Fixture valid;
    const auto signed_body = valid.Sign();
    Require(valid.Receive(signed_body)["status"] == "APPLIED",
            "signed command rejected");
    Require(valid.Receive(signed_body)["rejected"] == "replay",
            "replay accepted");
    Require(valid.Receive(signed_body, "operator-imposter")["rejected"] ==
                "sender_or_size",
            "sender not bound");
    valid.command["sequence"] = 2;
    valid.Sign();
    valid.command["command"]["throttle"] = 200;
    Require(valid.Receive(EncodeJSON(valid.command))["rejected"] ==
                "invalid_signature",
            "tampered command accepted");
    valid.command["timestamp_ms"] = Json::Int64(1699999999000LL);
    Require(valid.Receive(valid.Sign())["rejected"] == "stale_command",
            "stale command accepted");
    valid.command["timestamp_ms"] = Json::Int64(1700000000000LL);
    valid.command["command"]["throttle"] = 1001;
    Require(valid.Receive(valid.Sign())["rejected"] == "invalid_command",
            "unbounded command accepted");
    valid.command["command"]["throttle"] = 0.1;
    Require(valid.Receive(valid.Sign())["rejected"] == "invalid_command",
            "float command accepted");
    valid.command["command"]["throttle"] = 10;
    valid.command["command"]["brake"] = 10;
    Require(valid.Receive(valid.Sign())["rejected"] == "invalid_command",
            "conflicting pedals accepted");
    valid.command["command"]["brake"] = 0;
    const auto duplicate = valid.Sign();
    auto invalid_duplicate = duplicate;
    invalid_duplicate.insert(1, "\"sequence\":2,");
    Require(valid.Receive(invalid_duplicate)["rejected"] == "invalid_envelope",
            "duplicate JSON fields accepted");
    Require(valid.receiver.Receive(
                "control-session-test", valid.Sign(), valid.now - 251ms,
                valid.now, 1700000000000LL)["rejected"] == "not_authorized",
            "delayed IPC accepted");
    valid.command["receiver_instance_id"] = std::string(32, '0');
    Require(valid.Receive(valid.Sign())["rejected"] == "invalid_envelope",
            "old receiver instance accepted");
    valid.receiver.Tick(valid.now + 301ms);
    Require(valid.receiver.Feedback()["status"] == "LOCKED" &&
                valid.receiver.Feedback()["command"].isNull(),
            "watchdog did not clear simulation setpoint");
    valid.receiver.UpdateContext(valid.context, valid.now + 301ms,
                                 valid.now + 301ms);
    Require(valid.receiver.Feedback()["status"] == "LOCKED",
            "poll silently rearmed watchdog");
    Fixture expiry;
    expiry.receiver.Tick(expiry.now + 501ms);
    Require(expiry.receiver.Feedback()["reason"] == "authority_expired",
            "authorization deadline ignored");
    Fixture latency;
    latency.receiver.UpdateContext(latency.context, latency.now,
                                   latency.now + 501ms);
    Require(latency.receiver.Feedback()["status"] == "LOCKED",
            "slow context extended authority");
    Fixture revoked;
    revoked.context["state"] = "PENDING";
    revoked.context["session"] = Json::nullValue;
    revoked.context["ttl_ms"] = 0;
    revoked.receiver.UpdateContext(revoked.context, revoked.now, revoked.now);
    Require(revoked.Receive(revoked.Sign())["rejected"] == "not_authorized",
            "revoked session accepted");
    revoked.context["state"] = "ACTIVE";
    revoked.context["session"] = valid.context["session"];
    revoked.context["ttl_ms"] = 10000;
    revoked.context["revision"] = 2;
    revoked.context["session_id"] = "second-session";
    revoked.context["session"]["session_id"] = "second-session";
    revoked.context["session"]["sender_identity"] = "control-second-session";
    revoked.receiver.UpdateContext(revoked.context, revoked.now, revoked.now);
    Require(revoked.receiver.Feedback()["status"] == "READY" &&
                revoked.receiver.Feedback()["last_rejection"] == "" &&
                revoked.receiver.Feedback()["accepted_sequence"] == 0,
            "new session inherited stale state");
    std::cout << "control signatures, bounds, replay, expiry, revocation and "
                 "watchdog passed\n";
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
