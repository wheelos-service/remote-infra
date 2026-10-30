#include "vehicle_edge/durable_store.h"

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <filesystem>
#include <memory>
#include <stdexcept>

#include "vehicle_edge/http_client.h"

namespace vehicle_edge {
namespace {

void SQL(sqlite3 *db, const char *sql) {
  if (sqlite3_exec(db, sql, nullptr, nullptr, nullptr) != SQLITE_OK)
    throw std::runtime_error("durable data SQL operation failed");
}

class Statement {
public:
  Statement(sqlite3 *db, const char *sql) {
    if (sqlite3_prepare_v2(db, sql, -1, &stmt_, nullptr) != SQLITE_OK)
      throw std::runtime_error("durable data statement failed");
  }
  ~Statement() { sqlite3_finalize(stmt_); }
  void Text(int index, const std::string &v) {
    if (sqlite3_bind_text(stmt_, index, v.data(), v.size(), SQLITE_TRANSIENT) !=
        SQLITE_OK)
      throw std::runtime_error("durable data bind failed");
  }
  void Int(int index, std::int64_t v) {
    if (sqlite3_bind_int64(stmt_, index, v) != SQLITE_OK)
      throw std::runtime_error("durable data bind failed");
  }
  bool Step() {
    const int code = sqlite3_step(stmt_);
    if (code != SQLITE_ROW && code != SQLITE_DONE)
      throw std::runtime_error("durable data write/read failed");
    return code == SQLITE_ROW;
  }
  std::string Text(int column) const {
    const auto *v = sqlite3_column_text(stmt_, column);
    return v ? reinterpret_cast<const char *>(v) : "";
  }
  std::int64_t Int(int column) const {
    return sqlite3_column_int64(stmt_, column);
  }

private:
  sqlite3_stmt *stmt_ = nullptr;
};

class Transaction {
public:
  explicit Transaction(sqlite3 *db) : db_(db) { SQL(db_, "BEGIN IMMEDIATE"); }
  ~Transaction() {
    if (!committed_)
      sqlite3_exec(db_, "ROLLBACK", nullptr, nullptr, nullptr);
  }
  void Commit() {
    SQL(db_, "COMMIT");
    committed_ = true;
  }

private:
  sqlite3 *db_;
  bool committed_ = false;
};

void Queue(sqlite3 *db, const std::string &kind, const std::string &key,
           const Json::Value &payload) {
  Statement insert(db,
                   "INSERT INTO outbox(kind,identity,payload) VALUES(?,?,?)");
  insert.Text(1, kind);
  insert.Text(2, key);
  insert.Text(3, EncodeJSON(payload));
  insert.Step();
}

void QueueTaskReport(sqlite3 *db, const std::string &id, std::int64_t sequence,
                     const std::string &status, const std::string &reason,
                     const Json::Value &mission = {}) {
  Json::Value report;
  report["request_id"] = id;
  report["report_sequence"] = Json::Int64(sequence);
  report["status"] = status;
  report["reason"] = reason;
  report["mission_result"] = mission;
  Queue(db, "task-results", "task-" + id + "-" + std::to_string(sequence),
        report);
}
} // namespace

DurableStore::DurableStore(const std::string &path, int capacity)
    : capacity_(capacity) {
  if (path.empty() || capacity < 1 || capacity > 100000)
    throw std::invalid_argument("invalid durable data path/capacity");
  try {
    if (path != ":memory:") {
      const auto directory = std::filesystem::path(path).parent_path();
      struct stat info {};
      if (directory.empty() || lstat(directory.c_str(), &info) != 0 ||
          !S_ISDIR(info.st_mode) || info.st_uid != geteuid() ||
          (info.st_mode & 0077) != 0)
        throw std::runtime_error("data directory must be owned and mode 0700");
      lock_fd_ = open((path + ".lock").c_str(),
                      O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
      if (lock_fd_ < 0 || fstat(lock_fd_, &info) != 0 ||
          !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
          (info.st_mode & 0777) != 0600 ||
          flock(lock_fd_, LOCK_EX | LOCK_NB) != 0)
        throw std::runtime_error("durable data database is already owned");
      const int fd =
          open(path.c_str(), O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
      if (fd < 0)
        throw std::runtime_error("cannot open durable data database");
      const bool valid = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
                         info.st_uid == geteuid() &&
                         (info.st_mode & 0777) == 0600;
      close(fd);
      if (!valid)
        throw std::runtime_error(
            "data database must be owned regular mode 0600");
    }
    if (sqlite3_open(path.c_str(), &db_) != SQLITE_OK)
      throw std::runtime_error("cannot initialize durable data database");
    SQL(db_, "PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;"
             "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    Statement version(db_, "PRAGMA user_version");
    version.Step();
    if (version.Int(0) > 1)
      throw std::runtime_error("unsupported durable data database version");
    SQL(db_, "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value "
             "TEXT NOT NULL);"
             "CREATE TABLE IF NOT EXISTS outbox("
             "id INTEGER PRIMARY KEY,kind TEXT NOT NULL,identity TEXT UNIQUE "
             "NOT NULL,"
             "payload TEXT NOT NULL CHECK(length(payload)<=8192),acked INTEGER "
             "NOT NULL DEFAULT 0);"
             "CREATE TABLE IF NOT EXISTS faults("
             "fault_key TEXT PRIMARY KEY,severity TEXT NOT NULL,source_ms "
             "INTEGER NOT NULL);"
             "CREATE TABLE IF NOT EXISTS inbox("
             "request_id TEXT PRIMARY KEY,payload TEXT NOT NULL "
             "CHECK(length(payload)<=8192),"
             "state TEXT NOT NULL DEFAULT 'received',started_ms INTEGER NOT "
             "NULL DEFAULT 0,"
             "report_sequence INTEGER NOT NULL DEFAULT 0,unknown_reported "
             "INTEGER NOT NULL DEFAULT 0);"
             "PRAGMA user_version=1;");
  } catch (...) {
    if (db_)
      sqlite3_close(db_);
    if (lock_fd_ >= 0)
      close(lock_fd_);
    throw;
  }
}

DurableStore::~DurableStore() {
  sqlite3_close(db_);
  if (lock_fd_ >= 0)
    close(lock_fd_);
}

void DurableStore::BindVehicle(const std::string &vehicle) {
  if (!ValidIdentifier(vehicle))
    throw std::invalid_argument("invalid durable store vehicle identity");
  std::lock_guard<std::mutex> lock(mutex_);
  Transaction transaction(db_);
  Statement query(db_, "SELECT value FROM metadata WHERE key='vehicle_id'");
  if (query.Step()) {
    if (query.Text(0) != vehicle)
      throw std::runtime_error("durable data store belongs to another vehicle");
    return;
  }
  Statement insert(db_, "INSERT INTO metadata VALUES('vehicle_id',?)");
  insert.Text(1, vehicle);
  insert.Step();
  transaction.Commit();
}

void DurableStore::Capacity(const char *table) {
  const std::string query = std::string("SELECT COUNT(*) FROM ") + table;
  Statement count(db_, query.c_str());
  count.Step();
  if (count.Int(0) >= capacity_)
    throw std::runtime_error(
        "durable data capacity exhausted; archive required");
}

Json::Value DurableStore::Statistics() {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement query(db_, "SELECT (SELECT COUNT(*) FROM outbox),"
                       "(SELECT COUNT(*) FROM outbox WHERE acked=0),"
                       "(SELECT COUNT(*) FROM inbox),"
                       "(SELECT COUNT(*) FROM inbox WHERE state!='done'),"
                       "(SELECT COUNT(*) FROM faults)");
  query.Step();
  Json::Value value;
  value["capacity"] = capacity_;
  const char *names[] = {"outbox_retained", "outbox_pending", "inbox_retained",
                         "inbox_pending", "faults_retained"};
  for (int i = 0; i < 5; ++i)
    value[names[i]] = Json::Int64(query.Int(i));
  return value;
}

void DurableStore::ObserveFault(const std::string &vehicle,
                                const std::string &key,
                                const std::string &severity,
                                const std::string &message,
                                std::int64_t source_ms) {
  if (!ValidIdentifier(vehicle) || key.empty() || key.size() > 256 ||
      message.size() > 512 || source_ms <= 0 ||
      (severity != "OK" && severity != "WARN" && severity != "ERROR" &&
       severity != "FATAL"))
    throw std::invalid_argument("invalid fault observation");
  std::lock_guard<std::mutex> lock(mutex_);
  Transaction transaction(db_);
  Statement previous(db_,
                     "SELECT severity,source_ms FROM faults WHERE fault_key=?");
  previous.Text(1, key);
  const bool exists = previous.Step();
  const std::string old = exists ? previous.Text(0) : "OK";
  if (exists && source_ms == previous.Int(1) && old != severity)
    throw std::runtime_error("conflicting health observation timestamp");
  if (exists && source_ms <= previous.Int(1))
    return;
  if (old != severity) {
    Capacity("outbox");
    Json::Value event;
    event["schema_version"] = 1;
    event["type"] = "vehicle_event";
    event["vehicle_id"] = vehicle;
    event["event_id"] = NewStreamID();
    event["fault_key"] = key;
    event["severity"] = severity;
    event["transition"] = severity == "OK" ? "recovered"
                          : old == "OK"    ? "raised"
                                           : "changed";
    event["occurred_at_ms"] = Json::Int64(source_ms);
    event["message"] = message;
    Queue(db_, "events", event["event_id"].asString(), event);
  }
  if (!exists)
    Capacity("faults");
  Statement upsert(
      db_,
      "INSERT INTO faults VALUES(?,?,?) ON CONFLICT(fault_key)"
      " DO UPDATE SET severity=excluded.severity,source_ms=excluded.source_ms");
  upsert.Text(1, key);
  upsert.Text(2, severity);
  upsert.Int(3, source_ms);
  upsert.Step();
  transaction.Commit();
}

std::optional<PendingUpload> DurableStore::NextUpload() {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement query(
      db_,
      "SELECT id,kind,payload FROM outbox WHERE acked=0 ORDER BY id LIMIT 1");
  if (!query.Step())
    return std::nullopt;
  return PendingUpload{query.Int(0), query.Text(1),
                       ParseHTTPJSON(query.Text(2))};
}

void DurableStore::Acknowledge(std::int64_t id) {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement update(db_, "UPDATE outbox SET acked=1 WHERE id=?");
  update.Int(1, id);
  update.Step();
}

void DurableStore::ReceiveTask(const Json::Value &request) {
  const auto id = request["request_id"].asString();
  const auto payload = EncodeJSON(request);
  if (!ValidIdentifier(id) || payload.size() > 8192)
    throw std::invalid_argument("invalid task inbox packet");
  std::lock_guard<std::mutex> lock(mutex_);
  Transaction transaction(db_);
  Statement query(db_, "SELECT payload FROM inbox WHERE request_id=?");
  query.Text(1, id);
  if (query.Step()) {
    if (ParseHTTPJSON(query.Text(0)) != request)
      throw std::runtime_error("task identity payload conflict");
    return;
  }
  Capacity("inbox");
  Statement insert(db_, "INSERT INTO inbox(request_id,payload) VALUES(?,?)");
  insert.Text(1, id);
  insert.Text(2, payload);
  insert.Step();
  Capacity("outbox");
  QueueTaskReport(db_, id, 1, "received",
                  "persisted in device inbox; not executed");
  Statement receipt(db_,
                    "UPDATE inbox SET report_sequence=1 WHERE request_id=?");
  receipt.Text(1, id);
  receipt.Step();
  transaction.Commit();
}

std::optional<PendingTask> DurableStore::NextTask() {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement query(db_,
                  "SELECT payload,state,started_ms,unknown_reported FROM inbox"
                  " WHERE state!='done' ORDER BY rowid LIMIT 1");
  if (!query.Step())
    return std::nullopt;
  return PendingTask{ParseHTTPJSON(query.Text(0)), query.Text(1), query.Int(2),
                     query.Int(3) != 0};
}

void DurableStore::BeginTask(const std::string &id, std::int64_t now_ms) {
  std::lock_guard<std::mutex> lock(mutex_);
  Transaction transaction(db_);
  Capacity("outbox");
  QueueTaskReport(db_, id, 2, "reconciling",
                  "dispatch fenced; execution outcome not yet known");
  Statement update(db_, "UPDATE inbox SET state='reconciling',started_ms=?"
                        " WHERE request_id=? AND state='received'");
  update.Int(1, now_ms);
  update.Text(2, id);
  update.Step();
  if (sqlite3_changes(db_) != 1)
    throw std::runtime_error("task dispatch was not durably fenced");
  Statement sequence(db_,
                     "UPDATE inbox SET report_sequence=2 WHERE request_id=?");
  sequence.Text(1, id);
  sequence.Step();
  transaction.Commit();
}

void DurableStore::ReportTask(const std::string &id, const std::string &status,
                              const std::string &reason,
                              const Json::Value &mission, bool terminal) {
  if (reason.size() > 512 ||
      (status != "succeeded" && status != "rejected" && status != "unknown") ||
      (terminal == (status == "unknown")))
    throw std::invalid_argument("invalid task report");
  std::lock_guard<std::mutex> lock(mutex_);
  Transaction transaction(db_);
  Statement query(
      db_,
      "SELECT report_sequence FROM inbox WHERE request_id=? AND state!='done'");
  query.Text(1, id);
  if (!query.Step())
    throw std::runtime_error("task report without active inbox identity");
  const auto sequence = query.Int(0) + 1;
  Capacity("outbox");
  QueueTaskReport(db_, id, sequence, status, reason, mission);
  Statement update(
      db_, "UPDATE inbox SET state=?,report_sequence=?,unknown_reported=? "
           "WHERE request_id=?");
  update.Text(1, terminal ? "done" : "reconciling");
  update.Int(2, sequence);
  update.Int(3, !terminal);
  update.Text(4, id);
  update.Step();
  transaction.Commit();
}

} // namespace vehicle_edge
