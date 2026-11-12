package gateway

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/stdlib"
)

func init() {
	sql.Register("pgx-operations", &pgOperationsDriver{base: stdlib.GetDefaultDriver()})
}

const postgresOperationsSchema = `
CREATE TABLE IF NOT EXISTS operations_schema_version (
 version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operations_history (
 id BIGSERIAL PRIMARY KEY,
 vehicle_id TEXT NOT NULL, stream_id TEXT NOT NULL, sequence BIGINT NOT NULL,
 published_at_ms BIGINT NOT NULL, received_at_ms BIGINT NOT NULL,
 payload BYTEA NOT NULL CHECK(length(payload) <= 65536),
 UNIQUE(vehicle_id, stream_id, sequence)
);
CREATE INDEX IF NOT EXISTS operations_history_latest ON operations_history(vehicle_id, received_at_ms DESC, id DESC);
CREATE TABLE IF NOT EXISTS operations_error_state (
 vehicle_id TEXT PRIMARY KEY, received_at_ms BIGINT NOT NULL,
 stream_id TEXT NOT NULL, sequence BIGINT NOT NULL, error_code BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS operations_alerts (
 id BIGSERIAL PRIMARY KEY, vehicle_id TEXT NOT NULL, event_id TEXT NOT NULL,
 occurred_at_ms BIGINT NOT NULL, severity TEXT NOT NULL, code TEXT NOT NULL,
 message TEXT NOT NULL, status TEXT NOT NULL, resolved_at_ms BIGINT,
 UNIQUE(vehicle_id, event_id)
);
CREATE INDEX IF NOT EXISTS operations_alerts_latest ON operations_alerts(vehicle_id, occurred_at_ms DESC, id DESC);
CREATE TABLE IF NOT EXISTS operations_missions (
 vehicle_id TEXT NOT NULL, mission_id TEXT NOT NULL, status TEXT NOT NULL,
 updated_at_ms BIGINT NOT NULL, description TEXT NOT NULL,
 PRIMARY KEY(vehicle_id, mission_id)
);
CREATE INDEX IF NOT EXISTS operations_missions_latest ON operations_missions(vehicle_id, updated_at_ms DESC, mission_id);
CREATE TABLE IF NOT EXISTS data_snapshots (
 vehicle_id TEXT NOT NULL, kind TEXT NOT NULL, stream_id TEXT NOT NULL,
 sequence BIGINT NOT NULL, published_at_ms BIGINT NOT NULL, received_at_ms BIGINT NOT NULL,
 payload BYTEA NOT NULL CHECK(length(payload) <= 65536),
 PRIMARY KEY(vehicle_id, kind)
);
CREATE TABLE IF NOT EXISTS data_events (
 id BIGSERIAL PRIMARY KEY,
 vehicle_id TEXT NOT NULL, event_id TEXT NOT NULL,
 payload BYTEA NOT NULL CHECK(length(payload) <= 4096), received_at_ms BIGINT NOT NULL,
 UNIQUE(vehicle_id, event_id)
);
CREATE INDEX IF NOT EXISTS data_events_latest ON data_events(vehicle_id, id DESC);
CREATE TABLE IF NOT EXISTS data_event_acknowledgements (
 vehicle_id TEXT NOT NULL, event_id TEXT NOT NULL, operator_id TEXT NOT NULL,
 acknowledged_at_ms BIGINT NOT NULL,
 PRIMARY KEY(vehicle_id, event_id),
 FOREIGN KEY(vehicle_id, event_id) REFERENCES data_events(vehicle_id, event_id)
);
CREATE TABLE IF NOT EXISTS data_tasks (
 rowid BIGSERIAL,
 vehicle_id TEXT NOT NULL, request_id TEXT NOT NULL, payload BYTEA NOT NULL,
 result BYTEA, result_sequence BIGINT NOT NULL DEFAULT 0,
 created_at_ms BIGINT NOT NULL,
 PRIMARY KEY(vehicle_id, request_id)
);
CREATE INDEX IF NOT EXISTS data_tasks_latest ON data_tasks(vehicle_id, created_at_ms DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS data_tasks_rowid ON data_tasks(vehicle_id, rowid);
`

// OpenOperationsStoreFromEnvironment opens PostgreSQL when OPERATIONS_DATABASE_URL
// is configured (for shared multi-instance deployments), otherwise SQLite at OPERATIONS_DB_PATH.
func OpenOperationsStoreFromEnvironment() (*OperationsStore, error) {
	if dsn := strings.TrimSpace(os.Getenv("OPERATIONS_DATABASE_URL")); dsn != "" {
		return OpenPostgresOperationsStore(dsn)
	}
	databasePath := os.Getenv("OPERATIONS_DB_PATH")
	if databasePath == "" {
		databasePath = "data/operations.db"
	}
	return OpenOperationsStore(databasePath)
}

// OpenPostgresOperationsStore opens a shared PostgreSQL-backed OperationsStore
// suitable for horizontal multi-instance Gateway deployments.
func OpenPostgresOperationsStore(dsn string) (*OperationsStore, error) {
	dsn = strings.TrimSpace(dsn)
	if dsn == "" {
		return nil, errors.New("operations postgres database requires a non-empty DSN")
	}
	db, err := sql.Open("pgx-operations", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres operations database: %w", err)
	}
	store := &OperationsStore{db: db}
	if err := store.migratePostgres(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("initialize postgres operations database: %w", err)
	}
	return store, nil
}

func (s *OperationsStore) migratePostgres() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("SELECT pg_advisory_xact_lock(7439102342056783)"); err != nil {
		return err
	}
	for _, stmt := range strings.Split(postgresOperationsSchema, ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if _, err := tx.Exec(stmt); err != nil {
			return err
		}
	}
	var count int
	if err := tx.QueryRow("SELECT COUNT(*) FROM operations_schema_version").Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		if _, err := tx.Exec("INSERT INTO operations_schema_version(version) VALUES(2)"); err != nil {
			return err
		}
	} else {
		var version int
		if err := tx.QueryRow("SELECT version FROM operations_schema_version LIMIT 1").Scan(&version); err != nil {
			return err
		}
		if version > 2 {
			return fmt.Errorf("unsupported operations schema version %d", version)
		}
		if version < 2 {
			if _, err := tx.Exec("UPDATE operations_schema_version SET version=2"); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

type pgOperationsDriver struct {
	base driver.Driver
}

func (d *pgOperationsDriver) Open(name string) (driver.Conn, error) {
	conn, err := d.base.Open(name)
	if err != nil {
		return nil, err
	}
	return &pgOperationsConn{Conn: conn}, nil
}

type pgOperationsConn struct {
	driver.Conn
}

func (c *pgOperationsConn) Prepare(query string) (driver.Stmt, error) {
	return c.Conn.Prepare(rewritePostgresOperationsSQL(query))
}

func (c *pgOperationsConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if prep, ok := c.Conn.(driver.ConnPrepareContext); ok {
		return prep.PrepareContext(ctx, rewritePostgresOperationsSQL(query))
	}
	return c.Prepare(query)
}

func (c *pgOperationsConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if execer, ok := c.Conn.(driver.ExecerContext); ok {
		return execer.ExecContext(ctx, rewritePostgresOperationsSQL(query), args)
	}
	return nil, driver.ErrSkip
}

func (c *pgOperationsConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if queryer, ok := c.Conn.(driver.QueryerContext); ok {
		return queryer.QueryContext(ctx, rewritePostgresOperationsSQL(query), args)
	}
	return nil, driver.ErrSkip
}

func (c *pgOperationsConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if beginner, ok := c.Conn.(driver.ConnBeginTx); ok {
		return beginner.BeginTx(ctx, opts)
	}
	return c.Conn.Begin()
}

func (c *pgOperationsConn) Ping(ctx context.Context) error {
	if pinger, ok := c.Conn.(driver.Pinger); ok {
		return pinger.Ping(ctx)
	}
	return nil
}

func rewritePostgresOperationsSQL(query string) string {
	trimmed := strings.TrimSpace(query)
	if trimmed == "PRAGMA user_version" {
		return "SELECT version FROM operations_schema_version LIMIT 1"
	}
	rewritten := strings.ReplaceAll(query, "json_extract(result,'$.status')", "(convert_from(result,'UTF8')::jsonb->>'status')")
	rewritten = strings.ReplaceAll(rewritten, "MAX(rowid),0) FROM data_events", "MAX(id),0) FROM data_events")
	rewritten = strings.ReplaceAll(rewritten, "e.rowid", "e.id")
	var out strings.Builder
	out.Grow(len(rewritten) + 16)
	param := 1
	inLiteral := false
	for i := 0; i < len(rewritten); i++ {
		ch := rewritten[i]
		if ch == '\'' {
			inLiteral = !inLiteral
			out.WriteByte(ch)
			continue
		}
		if ch == '?' && !inLiteral {
			out.WriteByte('$')
			out.WriteString(strconv.Itoa(param))
			param++
			continue
		}
		out.WriteByte(ch)
	}
	return out.String()
}
