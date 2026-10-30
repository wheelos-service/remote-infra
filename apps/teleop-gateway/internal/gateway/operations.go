package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const (
	// OperationsHistoryRetention bounds persisted snapshots per vehicle to 1000
	// (each at most 64 KiB, about 64 MiB payload per vehicle). This is count-based,
	// not time-based retention; SQLite may retain freed pages for reuse.
	OperationsHistoryRetention = 1000
	// OperationsAlertRetention and OperationsMissionRetention bound each vehicle's
	// persisted events/snapshots. Oldest resolved alerts are discarded first.
	OperationsAlertRetention   = 1000
	OperationsMissionRetention = 1000
	OperationsHistoryLimit     = 300
	OperationsAlertLimit       = 100
	OperationsMissionLimit     = 100
	OperationsFreshnessMS      = int64(10000)
)

var (
	ErrOperationsConflict = errors.New("operations snapshot conflicts with stored snapshot")
	ErrMissionOutdated    = errors.New("mission snapshot is older than stored snapshot")
)

type OperationsStore struct {
	db *sql.DB
}

// OpenOperationsStore opens a real SQLite database (or explicit :memory: for
// tests), creates private parent directories, and applies versioned migrations.
// Disk errors are fatal; there is never an implicit in-memory fallback.
// Call Close at shutdown. The process must have sole responsibility for the
// configured database directory; SQLite WAL/SHM files live beside the database.
// Deploy one Gateway per database on local storage. Do not share SQLite over
// NFS or run replicas with separate databases and claim shared operations data.
func OpenOperationsStore(path string) (*OperationsStore, error) {
	if path == "" || strings.HasPrefix(path, "file:") {
		return nil, errors.New("operations database requires a filesystem path or :memory:")
	}
	dsn := ":memory:"
	if path != ":memory:" {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("operations database path: %w", err)
		}
		if err := os.MkdirAll(filepath.Dir(absolute), 0700); err != nil {
			return nil, fmt.Errorf("operations database directory: %w", err)
		}
		if info, err := os.Lstat(absolute); err == nil && !info.Mode().IsRegular() {
			return nil, errors.New("operations database must be a regular file, not a symlink")
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("operations database stat: %w", err)
		}
		file, err := os.OpenFile(absolute, os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return nil, fmt.Errorf("operations database file: %w", err)
		}
		chmodErr := file.Chmod(0600)
		closeErr := file.Close()
		if chmodErr != nil {
			return nil, fmt.Errorf("operations database permissions: %w", chmodErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("operations database close: %w", closeErr)
		}
		// URI escaping prevents '?' or '#' in a filesystem path becoming options.
		dsn = operationsFileURI(absolute)
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open operations database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &OperationsStore{db: db}
	if err := store.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("initialize operations database: %w", err)
	}
	return store, nil
}

func (s *OperationsStore) Close() error { return s.db.Close() }

// HasTelemetry checks the exact retained history key for partial-ingest recovery.
// False is not replay authorization: the caller must first verify that the
// payload exactly matches Redis's current snapshot, then reuse Redis's original
// receipt timestamp. Ordinary archived duplicates remain conflicts.
// Every accepted snapshot is archived (no downsampling), subject to the
// OperationsHistoryRetention count limit; older keys may have been pruned.
func (s *OperationsStore) HasTelemetry(ctx context.Context, vehicle, stream string, sequence int64) (bool, error) {
	if !telemetryIdentifier.MatchString(vehicle) || !telemetryIdentifier.MatchString(stream) ||
		sequence <= 0 || sequence > maxTelemetryInteger {
		return false, errors.New("invalid operations telemetry key")
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(
 SELECT 1 FROM operations_history WHERE vehicle_id=? AND stream_id=? AND sequence=?)`,
		vehicle, stream, sequence).Scan(&exists); err != nil {
		return false, fmt.Errorf("check operations telemetry history: %w", err)
	}
	return exists, nil
}

// Ping checks database availability for readiness, including the migrated schema.
func (s *OperationsStore) Ping(ctx context.Context) error {
	var version int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("operations database readiness: %w", err)
	}
	if version != 2 {
		return fmt.Errorf("operations database readiness: unsupported schema version %d", version)
	}
	for _, table := range []string{"operations_error_state", "data_snapshots", "data_events", "data_event_acknowledgements", "data_tasks"} {
		var exists int
		if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM "+table+")").Scan(&exists); err != nil {
			return fmt.Errorf("operations database readiness: %w", err)
		}
	}
	return nil
}

func (s *OperationsStore) migrate() error {
	for _, statement := range []string{
		"PRAGMA busy_timeout=5000", "PRAGMA foreign_keys=ON",
		"PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL",
	} {
		if _, err := s.db.Exec(statement); err != nil {
			return err
		}
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > 2 {
		return fmt.Errorf("unsupported operations schema version %d", version)
	}
	if version == 0 {
		_, err = tx.Exec(`
CREATE TABLE operations_history (
 id INTEGER PRIMARY KEY,
 vehicle_id TEXT NOT NULL, stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,
 published_at_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL,
 payload BLOB NOT NULL CHECK(length(payload) <= 65536),
 UNIQUE(vehicle_id, stream_id, sequence)
);
CREATE INDEX operations_history_latest ON operations_history(vehicle_id, received_at_ms DESC, id DESC);
CREATE TABLE operations_error_state (
 vehicle_id TEXT PRIMARY KEY, received_at_ms INTEGER NOT NULL,
 stream_id TEXT NOT NULL, sequence INTEGER NOT NULL, error_code INTEGER NOT NULL
);
CREATE TABLE operations_alerts (
 id INTEGER PRIMARY KEY, vehicle_id TEXT NOT NULL, event_id TEXT NOT NULL,
 occurred_at_ms INTEGER NOT NULL, severity TEXT NOT NULL, code TEXT NOT NULL,
 message TEXT NOT NULL, status TEXT NOT NULL, resolved_at_ms INTEGER,
 UNIQUE(vehicle_id, event_id)
);
CREATE INDEX operations_alerts_latest ON operations_alerts(vehicle_id, occurred_at_ms DESC, id DESC);
CREATE TABLE operations_missions (
 vehicle_id TEXT NOT NULL, mission_id TEXT NOT NULL, status TEXT NOT NULL,
 updated_at_ms INTEGER NOT NULL, description TEXT NOT NULL,
 PRIMARY KEY(vehicle_id, mission_id)
);
CREATE INDEX operations_missions_latest ON operations_missions(vehicle_id, updated_at_ms DESC, mission_id);
PRAGMA user_version=1;`)
		if err != nil {
			return err
		}
	}
	if version < 2 {
		if _, err := tx.Exec(dataSchema); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type operationsSample struct {
	AgeMS             *int64          `json:"age_ms"`
	SourceTimestampMS *int64          `json:"source_timestamp_ms"`
	Message           json.RawMessage `json:"message"`
}

type operationsTelemetry struct {
	PublishedAtMS int64            `json:"published_at_ms"`
	Chassis       operationsSample `json:"chassis"`
	Localization  operationsSample `json:"localization"`
}

// Telemetry permits exact integral JSON numbers including exponent notation.
// Decode those without float rounding or encoding/json's int64 lexical limits.
func (snapshot *operationsTelemetry) decode(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var obj map[string]any
	if err := decoder.Decode(&obj); err != nil {
		return err
	}
	snapshot.PublishedAtMS, _ = telemetryInteger(obj["published_at_ms"], 1, maxTelemetryInteger)
	for _, field := range []struct {
		name   string
		sample *operationsSample
	}{{"chassis", &snapshot.Chassis}, {"localization", &snapshot.Localization}} {
		value, ok := obj[field.name].(map[string]any)
		if !ok {
			return errors.New("invalid operations sample")
		}
		if n, ok := telemetryInteger(value["age_ms"], 0, maxTelemetryInteger); ok {
			field.sample.AgeMS = &n
		}
		if n, ok := telemetryInteger(value["source_timestamp_ms"], 1, maxTelemetryInteger); ok {
			field.sample.SourceTimestampMS = &n
		}
		message, err := json.Marshal(value["message"])
		if err != nil {
			return err
		}
		field.sample.Message = message
	}
	return nil
}

func (sample operationsSample) errorCode() *int64 {
	decoder := json.NewDecoder(bytes.NewReader(sample.Message))
	decoder.UseNumber()
	var message map[string]any
	if decoder.Decode(&message) != nil {
		return nil
	}
	if code, ok := telemetryInteger(message["error_code"], 0, 9); ok {
		return &code
	}
	return nil
}

func (sample operationsSample) received() bool {
	return len(sample.Message) > 0 && string(sample.Message) != "null"
}

// RecordTelemetry must run after Redis accepts the latest validated telemetry,
// before the ingest route sends 204. A SQL failure must return 503 even though
// Redis has already changed. The caller may retry an identical Redis snapshot;
// it must not bypass Redis's stream/sequence fence for a different payload.
//
// The (vehicle,stream,sequence) key is idempotent while retained. Conflicting
// payloads fail explicitly. Redis remains the durable replay authority beyond
// the bounded SQL history window. Records arriving out of order cannot regress
// error transitions. Missing/stale/error_code:null samples never resolve alerts.
func (s *OperationsStore) RecordTelemetry(ctx context.Context, state validatedTelemetry, receivedAtMS int64) error {
	if receivedAtMS <= 0 || receivedAtMS > maxTelemetryInteger || len(state.Payload) > maxVehicleTelemetryBytes {
		return errors.New("invalid operations telemetry receipt or size")
	}
	checked, err := validateVehicleTelemetry(state.Payload)
	if err != nil || checked.VehicleID != state.VehicleID || checked.StreamID != state.StreamID || checked.Sequence != state.Sequence {
		return errors.New("invalid operations telemetry")
	}
	var snapshot operationsTelemetry
	if err := snapshot.decode(state.Payload); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var previous []byte
	err = tx.QueryRowContext(ctx, `SELECT payload FROM operations_history WHERE vehicle_id=? AND stream_id=? AND sequence=?`,
		state.VehicleID, state.StreamID, state.Sequence).Scan(&previous)
	if err == nil {
		// Compare JSON structurally: retries may change insignificant whitespace.
		if !operationsJSONEqual(previous, state.Payload) {
			return ErrOperationsConflict
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO operations_history
 (vehicle_id,stream_id,sequence,published_at_ms,received_at_ms,payload) VALUES(?,?,?,?,?,?)`,
		state.VehicleID, state.StreamID, state.Sequence, snapshot.PublishedAtMS, receivedAtMS, []byte(state.Payload)); err != nil {
		return err
	}
	if err := recordOperationsErrors(ctx, tx, state, snapshot, receivedAtMS); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM operations_history WHERE vehicle_id=? AND id NOT IN
 (SELECT id FROM operations_history WHERE vehicle_id=? ORDER BY received_at_ms DESC,id DESC LIMIT ?)`,
		state.VehicleID, state.VehicleID, OperationsHistoryRetention); err != nil {
		return err
	}
	return tx.Commit()
}

func recordOperationsErrors(ctx context.Context, tx *sql.Tx, state validatedTelemetry, snapshot operationsTelemetry, received int64) error {
	var lastReceived, lastSequence, lastCode int64
	var lastStream string
	err := tx.QueryRowContext(ctx, `SELECT received_at_ms,stream_id,sequence,error_code FROM operations_error_state WHERE vehicle_id=?`,
		state.VehicleID).Scan(&lastReceived, &lastStream, &lastSequence, &lastCode)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	exists := err == nil
	if exists && (received < lastReceived ||
		(state.StreamID == lastStream && state.Sequence <= lastSequence) ||
		(received == lastReceived && state.StreamID != lastStream)) {
		return nil
	}
	if !exists {
		lastCode = -1
	}
	code := snapshot.Chassis.errorCode()
	age, clock := operationsSampleAge(snapshot.Chassis, snapshot.PublishedAtMS, received, received)
	fresh := code != nil && !clock && age != nil && *age <= OperationsFreshnessMS
	if fresh && *code == 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE operations_alerts SET status='resolved',resolved_at_ms=?
 WHERE vehicle_id=? AND status='open'`, received, state.VehicleID); err != nil {
			return err
		}
	} else if fresh && *code != lastCode {
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s/%s/%d/chassis_error_%d", state.VehicleID, state.StreamID, state.Sequence, *code)))
		eventID := hex.EncodeToString(sum[:])
		if _, err := tx.ExecContext(ctx, `INSERT INTO operations_alerts
 (vehicle_id,event_id,occurred_at_ms,severity,code,message,status) VALUES(?,?,?,'critical',?,?,'open')`,
			state.VehicleID, eventID, received, fmt.Sprintf("chassis_error_%d", *code),
			fmt.Sprintf("Chassis reported error code %d", *code)); err != nil {
			return err
		}
	}
	if fresh {
		lastCode = *code
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO operations_error_state(vehicle_id,received_at_ms,stream_id,sequence,error_code)
 VALUES(?,?,?,?,?) ON CONFLICT(vehicle_id) DO UPDATE SET
 received_at_ms=excluded.received_at_ms,stream_id=excluded.stream_id,sequence=excluded.sequence,error_code=excluded.error_code`,
		state.VehicleID, received, state.StreamID, state.Sequence, lastCode); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM operations_alerts WHERE vehicle_id=? AND id NOT IN
 (SELECT id FROM operations_alerts WHERE vehicle_id=? ORDER BY (status='open') DESC,occurred_at_ms DESC,id DESC LIMIT ?)`,
		state.VehicleID, state.VehicleID, OperationsAlertRetention)
	return err
}

type OperationsMission struct {
	MissionID   string `json:"mission_id"`
	Status      string `json:"status"`
	UpdatedAtMS int64  `json:"updated_at_ms"`
	Description string `json:"description"`
}

// RecordMission persists authoritative device snapshots, not mission commands.
// Equal timestamps are accepted only for an identical snapshot; older reports
// return ErrMissionOutdated without regressing state. No native Mission ingest
// is implied: a device must explicitly publish this separate HTTP contract.
func (s *OperationsStore) RecordMission(ctx context.Context, vehicleID string, mission OperationsMission) error {
	if !telemetryIdentifier.MatchString(vehicleID) || !validOperationsMission(mission) {
		return errors.New("invalid mission snapshot")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var old OperationsMission
	err = tx.QueryRowContext(ctx, `SELECT mission_id,status,updated_at_ms,description FROM operations_missions WHERE vehicle_id=? AND mission_id=?`,
		vehicleID, mission.MissionID).Scan(&old.MissionID, &old.Status, &old.UpdatedAtMS, &old.Description)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		if mission.UpdatedAtMS < old.UpdatedAtMS {
			return ErrMissionOutdated
		}
		if mission.UpdatedAtMS == old.UpdatedAtMS {
			if mission != old {
				return ErrOperationsConflict
			}
			return tx.Commit()
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO operations_missions(vehicle_id,mission_id,status,updated_at_ms,description)
 VALUES(?,?,?,?,?) ON CONFLICT(vehicle_id,mission_id) DO UPDATE SET
 status=excluded.status,updated_at_ms=excluded.updated_at_ms,description=excluded.description`,
		vehicleID, mission.MissionID, mission.Status, mission.UpdatedAtMS, mission.Description); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM operations_missions WHERE vehicle_id=? AND mission_id NOT IN
 (SELECT mission_id FROM operations_missions WHERE vehicle_id=? ORDER BY updated_at_ms DESC,mission_id LIMIT ?)`,
		vehicleID, vehicleID, OperationsMissionRetention); err != nil {
		return err
	}
	return tx.Commit()
}
