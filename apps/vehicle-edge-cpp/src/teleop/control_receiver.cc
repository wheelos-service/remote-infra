#include "vehicle_edge/control_receiver.h"

#include <algorithm>
#include <memory>
#include <stdexcept>

#include <openssl/evp.h>
#include <openssl/rand.h>

namespace vehicle_edge {
namespace {

constexpr std::int64_t kMaxInteger = 9007199254740991LL;

bool Fields(const Json::Value &v, std::initializer_list<const char *> fields) {
  if (!v.isObject() || v.size() != fields.size())
    return false;
  return std::all_of(fields.begin(), fields.end(),
                     [&](const char *key) { return v.isMember(key); });
}

bool Integer(const Json::Value &v, std::int64_t low, std::int64_t high) {
  return (v.type() == Json::intValue || v.type() == Json::uintValue) &&
         v.isInt64() && v.asInt64() >= low && v.asInt64() <= high;
}

std::string Decode64(const std::string &value, std::size_t size) {
  if (value.size() != 4 * ((size + 2) / 3))
    return {};
  std::string decoded(value.size(), '\0');
  int length = EVP_DecodeBlock(
      reinterpret_cast<unsigned char *>(decoded.data()),
      reinterpret_cast<const unsigned char *>(value.data()), value.size());
  if (length < 0)
    return {};
  for (auto it = value.rbegin(); it != value.rend() && *it == '='; ++it)
    --length;
  if (length != static_cast<int>(size))
    return {};
  decoded.resize(size);
  std::string canonical(value.size(), '\0');
  EVP_EncodeBlock(reinterpret_cast<unsigned char *>(canonical.data()),
                  reinterpret_cast<const unsigned char *>(decoded.data()),
                  size);
  return canonical == value ? decoded : std::string();
}

bool Verify(const std::string &key, const std::string &signature,
            const std::string &message) {
  const auto sig = Decode64(signature, 64);
  if (sig.empty())
    return false;
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> public_key(
      EVP_PKEY_new_raw_public_key(
          EVP_PKEY_ED25519, nullptr,
          reinterpret_cast<const unsigned char *>(key.data()), key.size()),
      EVP_PKEY_free);
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(
      EVP_MD_CTX_new(), EVP_MD_CTX_free);
  return public_key && context &&
         EVP_DigestVerifyInit(context.get(), nullptr, nullptr, nullptr,
                              public_key.get()) == 1 &&
         EVP_DigestVerify(
             context.get(), reinterpret_cast<const unsigned char *>(sig.data()),
             sig.size(),
             reinterpret_cast<const unsigned char *>(message.data()),
             message.size()) == 1;
}

} // namespace

ControlReceiver::ControlReceiver(std::string vehicle_id)
    : vehicle_id_(std::move(vehicle_id)) {
  if (!ValidIdentifier(vehicle_id_))
    throw std::invalid_argument("invalid control vehicle");
  unsigned char bytes[16];
  if (RAND_bytes(bytes, sizeof(bytes)) != 1)
    throw std::runtime_error("control instance entropy unavailable");
  for (const auto byte : bytes) {
    instance_id_ += "0123456789abcdef"[byte >> 4];
    instance_id_ += "0123456789abcdef"[byte & 15];
  }
}

void ControlReceiver::Invalidate(const std::string &reason) {
  latched_ = true;
  status_ = "LOCKED";
  reason_ = reason;
  command_ = Json::nullValue;
}

void ControlReceiver::UpdateContext(const Json::Value &v, SteadyTime started,
                                    SteadyTime now) {
  if (!Fields(v, {"vehicle_id", "revision", "state", "session_id", "ttl_ms",
                  "session", "simulation"}) ||
      v["vehicle_id"] != vehicle_id_ || v["simulation"] != true ||
      !Integer(v["revision"], 0, kMaxInteger) || !v["state"].isString() ||
      !v["session_id"].isString() || !Integer(v["ttl_ms"], 0, 60000) ||
      now < started || now - started >= std::chrono::milliseconds(500)) {
    Invalidate("invalid_context");
    return;
  }
  const auto revision = v["revision"].asInt64();
  if (revision < revision_) {
    Invalidate("context_rollback");
    return;
  }
  if (v["state"] != "ACTIVE") {
    Invalidate("session_revoked");
    // Keep the fence even when a session has never been observed active.
    revision_ = revision;
    session_id_ = v["session_id"].asString();
    return;
  }
  const auto &s = v["session"];
  if (!s.isObject() || s["vehicle_id"] != vehicle_id_ ||
      !Integer(s["protocol_version"], 2, 2) || s["status"] != "ACTIVE" ||
      !s["session_id"].isString() ||
      !ValidIdentifier(s["session_id"].asString()) ||
      s["session_id"] != v["session_id"] ||
      !s["client_instance_id"].isString() ||
      !ValidIdentifier(s["client_instance_id"].asString()) ||
      s["sender_identity"] != "control-" + s["session_id"].asString() ||
      !s["public_key_b64"].isString() || revision == 0) {
    Invalidate("invalid_session");
    return;
  }
  const auto key = Decode64(s["public_key_b64"].asString(), 32);
  if (key.empty()) {
    Invalidate("invalid_public_key");
    return;
  }
  const auto deadline =
      started + std::chrono::milliseconds(
                    std::min<std::int64_t>(500, v["ttl_ms"].asInt64()));
  if (deadline <= now) {
    Invalidate("context_expired");
    return;
  }
  if (revision == revision_) {
    if (session_id_ != s["session_id"].asString() || key != public_key_ ||
        client_id_ != s["client_instance_id"].asString()) {
      Invalidate("session_mutated");
      return;
    }
    if (latched_)
      return;
    // Expired authority may not be silently recovered by a late HTTP response.
    Tick(now);
    if (latched_)
      return;
  } else {
    revision_ = revision;
    session_id_ = s["session_id"].asString();
    client_id_ = s["client_instance_id"].asString();
    sender_ = s["sender_identity"].asString();
    public_key_ = key;
    sequence_ = 0;
    last_command_ = {};
    command_ = Json::nullValue;
    rejection_.clear();
    latched_ = false;
    status_ = "READY";
    reason_ = "awaiting_command";
  }
  deadline_ = deadline;
}

void ControlReceiver::Tick(SteadyTime now) {
  if (!latched_ && !session_id_.empty() &&
      (now >= deadline_ ||
       (last_command_ != SteadyTime{} &&
        now - last_command_ >= std::chrono::milliseconds(300))))
    Invalidate(now >= deadline_ ? "authority_expired" : "command_timeout");
}

Json::Value ControlReceiver::Receive(const std::string &sender,
                                     const std::string &body,
                                     SteadyTime received, SteadyTime now,
                                     std::int64_t wall_ms) {
  Tick(now);
  const auto reject = [this](const char *reason) {
    rejection_ = reason;
    auto feedback = Feedback();
    feedback["rejected"] = reason;
    return feedback;
  };
  if (latched_ || status_ == "DISABLED" || now < received ||
      now - received >= std::chrono::milliseconds(250))
    return reject("not_authorized");
  if (body.size() > 2048 || sender != sender_)
    return reject("sender_or_size");
  Json::CharReaderBuilder builder;
  builder["rejectDupKeys"] = true;
  builder["failIfExtra"] = true;
  builder["allowComments"] = false;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value v;
  std::string errors;
  if (!reader->parse(body.data(), body.data() + body.size(), &v, &errors) ||
      !Fields(v, {"version", "type", "vehicle_id", "session_id",
                  "client_instance_id", "receiver_instance_id", "revision",
                  "sequence", "timestamp_ms", "command", "signature"}) ||
      !Integer(v["version"], 2, 2) || v["type"] != "control" ||
      v["vehicle_id"] != vehicle_id_ || v["session_id"] != session_id_ ||
      v["client_instance_id"] != client_id_ ||
      v["receiver_instance_id"] != instance_id_ ||
      !Integer(v["revision"], revision_, revision_) ||
      !Integer(v["sequence"], 1, kMaxInteger) ||
      !Integer(v["timestamp_ms"], 1, kMaxInteger) || !v["signature"].isString())
    return reject("invalid_envelope");
  const auto timestamp = v["timestamp_ms"].asInt64();
  if (timestamp < wall_ms - 250 || timestamp > wall_ms + 100)
    return reject("stale_command");
  if (v["sequence"].asInt64() <= sequence_)
    return reject("replay");
  const auto &c = v["command"];
  if (!Fields(c, {"steering", "throttle", "brake", "direction"}) ||
      !Integer(c["steering"], -1000, 1000) ||
      !Integer(c["throttle"], 0, 1000) || !Integer(c["brake"], 0, 1000) ||
      !Integer(c["direction"], -1, 1) ||
      (c["throttle"].asInt() > 0 && c["brake"].asInt() > 0))
    return reject("invalid_command");
  Json::Value canonical(Json::arrayValue);
  for (const char *field :
       {"version", "type", "vehicle_id", "session_id", "client_instance_id",
        "receiver_instance_id", "revision", "sequence", "timestamp_ms"})
    canonical.append(v[field]);
  for (const char *field : {"steering", "throttle", "brake", "direction"})
    canonical.append(c[field]);
  if (!Verify(public_key_, v["signature"].asString(), EncodeJSON(canonical)))
    return reject("invalid_signature");
  sequence_ = v["sequence"].asInt64();
  rejection_.clear();
  last_command_ = received;
  command_ = c;
  status_ = "APPLIED";
  reason_ = "simulated_not_physical";
  return Feedback();
}

Json::Value ControlReceiver::Feedback() const {
  Json::Value v;
  v["version"] = 2;
  v["type"] = "control.feedback";
  v["vehicle_id"] = vehicle_id_;
  v["session_id"] = session_id_;
  v["revision"] = Json::Int64(revision_);
  v["receiver_instance_id"] = instance_id_;
  v["accepted_sequence"] = Json::Int64(sequence_);
  v["status"] = status_;
  v["reason"] = reason_;
  v["last_rejection"] = rejection_;
  v["simulation"] = true;
  v["command"] = command_;
  return v;
}

} // namespace vehicle_edge
