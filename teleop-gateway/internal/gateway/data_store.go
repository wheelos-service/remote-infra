package gateway

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

const dataSchema = `
CREATE TABLE data_snapshots (
 vehicle_id TEXT NOT NULL, kind TEXT NOT NULL, stream_id TEXT NOT NULL,
 sequence INTEGER NOT NULL, published_at_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL,
 payload BLOB NOT NULL CHECK(length(payload)<=65536), PRIMARY KEY(vehicle_id,kind)
);
CREATE TABLE data_events (
 id INTEGER PRIMARY KEY, vehicle_id TEXT NOT NULL, event_id TEXT NOT NULL,
 payload BLOB NOT NULL CHECK(length(payload)<=4096), received_at_ms INTEGER NOT NULL,
 UNIQUE(vehicle_id,event_id)
);
CREATE TABLE data_event_acknowledgements (
 vehicle_id TEXT NOT NULL,event_id TEXT NOT NULL,operator_id TEXT NOT NULL,
 acknowledged_at_ms INTEGER NOT NULL,PRIMARY KEY(vehicle_id,event_id),
 FOREIGN KEY(vehicle_id,event_id) REFERENCES data_events(vehicle_id,event_id)
);
CREATE TABLE data_tasks (
 vehicle_id TEXT NOT NULL, request_id TEXT NOT NULL, payload BLOB NOT NULL,
 result BLOB, result_sequence INTEGER NOT NULL DEFAULT 0,
 created_at_ms INTEGER NOT NULL, PRIMARY KEY(vehicle_id,request_id)
);
PRAGMA user_version=2;
`

var errDataFull = errors.New("data retention capacity reached")
var errDataExpired = errors.New("task expired or future-created")

func (s *OperationsStore) saveDataSnapshot(ctx context.Context, vehicle, kind string, raw []byte, v map[string]any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var previous []byte
	var stream string
	var sequence, published int64
	err = tx.QueryRowContext(ctx, `SELECT stream_id,sequence,published_at_ms,payload FROM data_snapshots
 WHERE vehicle_id=? AND kind=?`, vehicle, kind).Scan(&stream, &sequence, &published, &previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	next, _ := telemetryInteger(v["sequence"], 1, maxTelemetryInteger)
	stamp, _ := telemetryInteger(v["published_at_ms"], 1, maxTelemetryInteger)
	if err == nil {
		if operationsJSONEqual(previous, raw) {
			return nil
		}
		if stamp < published || (stream == v["stream_id"] && next <= sequence) {
			return ErrOperationsConflict
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO data_snapshots VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(vehicle_id,kind) DO UPDATE SET stream_id=excluded.stream_id,sequence=excluded.sequence,
 published_at_ms=excluded.published_at_ms,received_at_ms=excluded.received_at_ms,payload=excluded.payload`,
		vehicle, kind, v["stream_id"], next, stamp, time.Now().UnixMilli(), raw)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *OperationsStore) saveDataEvent(ctx context.Context, vehicle string, raw []byte, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var previous []byte
	err = tx.QueryRowContext(ctx, `SELECT payload FROM data_events WHERE vehicle_id=? AND event_id=?`, vehicle, id).Scan(&previous)
	if err == nil {
		if operationsJSONEqual(previous, raw) {
			return nil
		}
		return ErrOperationsConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM data_events WHERE vehicle_id=?`, vehicle).Scan(&count); err != nil {
		return err
	}
	// Never silently evict fault history or its deduplication keys.
	if count >= 10000 {
		return errDataFull
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO data_events(vehicle_id,event_id,payload,received_at_ms) VALUES(?,?,?,?)`,
		vehicle, id, raw, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *OperationsStore) createDataTask(ctx context.Context, vehicle, id string, raw []byte) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var previous []byte
	err = tx.QueryRowContext(ctx, `SELECT payload FROM data_tasks WHERE vehicle_id=? AND request_id=?`, vehicle, id).Scan(&previous)
	if err == nil {
		if operationsJSONEqual(previous, raw) {
			return nil
		}
		return ErrOperationsConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var task map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err = decoder.Decode(&task); err != nil {
		return err
	}
	expires, _ := telemetryInteger(task["expires_at_ms"], 1, maxTelemetryInteger)
	created, _ := telemetryInteger(task["created_at_ms"], 1, maxTelemetryInteger)
	if expires <= time.Now().UnixMilli() || created > time.Now().UnixMilli()+1000 {
		return errDataExpired
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM data_tasks WHERE vehicle_id=?`, vehicle).Scan(&count); err != nil {
		return err
	}
	if count >= 1000 {
		return errDataFull
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO data_tasks(vehicle_id,request_id,payload,created_at_ms) VALUES(?,?,?,?)`,
		vehicle, id, raw, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *OperationsStore) pendingDataTask(ctx context.Context, vehicle string) (json.RawMessage, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM data_tasks WHERE vehicle_id=? AND
 (result IS NULL OR json_extract(result,'$.status') IN ('received','reconciling','unknown'))
 ORDER BY created_at_ms,request_id LIMIT 1`, vehicle).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return raw, err
}

func (s *OperationsStore) saveTaskResult(ctx context.Context, vehicle, id string, raw []byte) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var previous []byte
	var sequence int64
	err = tx.QueryRowContext(ctx, `SELECT result,result_sequence FROM data_tasks WHERE vehicle_id=? AND request_id=?`, vehicle, id).Scan(&previous, &sequence)
	if err != nil {
		return err
	}
	var next map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err = decoder.Decode(&next); err != nil {
		return err
	}
	nextSequence, _ := telemetryInteger(next["report_sequence"], 1, maxTelemetryInteger)
	if previous != nil {
		if operationsJSONEqual(previous, raw) {
			return nil
		}
		var old map[string]any
		if err = json.Unmarshal(previous, &old); err != nil {
			return err
		}
		if (old["status"] != "unknown" && old["status"] != "received" && old["status"] != "reconciling") || nextSequence != sequence+1 {
			return ErrOperationsConflict
		}
		if next["status"] == "received" ||
			(old["status"] == "unknown" && next["status"] == "reconciling") ||
			(old["status"] == "received" && next["status"] != "reconciling" && next["status"] != "rejected") {
			return ErrOperationsConflict
		}
	} else if nextSequence != 1 {
		return ErrOperationsConflict
	} else if next["status"] != "received" {
		return ErrOperationsConflict
	}
	_, err = tx.ExecContext(ctx, `UPDATE data_tasks SET result=?,result_sequence=? WHERE vehicle_id=? AND request_id=?`, raw, nextSequence, vehicle, id)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *OperationsStore) acknowledgeDataEvent(ctx context.Context, vehicle, id, operator string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM data_events WHERE vehicle_id=? AND event_id=?", vehicle, id).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return sql.ErrNoRows
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO data_event_acknowledgements VALUES(?,?,?,?)
 ON CONFLICT(vehicle_id,event_id) DO NOTHING`, vehicle, id, operator, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *OperationsStore) dataView(ctx context.Context, vehicle string) (map[string]any, error) {
	out := map[string]any{"vehicle_id": vehicle, "server_time_ms": time.Now().UnixMilli(),
		"health": nil, "profile": nil, "events": []json.RawMessage{}, "tasks": []map[string]any{}}
	for _, kind := range []string{"health", "profile", "diagnostics"} {
		out[kind] = nil
		var raw []byte
		var received int64
		err := s.db.QueryRowContext(ctx, `SELECT payload,received_at_ms FROM data_snapshots WHERE vehicle_id=? AND kind=?`, vehicle, kind).Scan(&raw, &received)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if err == nil {
			out[kind] = map[string]any{"payload": json.RawMessage(raw), "received_at_ms": received}
		}
	}
	rows, err := s.db.QueryContext(ctx, `SELECT payload FROM data_events WHERE vehicle_id=? ORDER BY id DESC LIMIT 100`, vehicle)
	if err != nil {
		return nil, err
	}
	events := []json.RawMessage{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return nil, err
		}
		events = append(events, raw)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out["events"] = events
	rows, err = s.db.QueryContext(ctx, `SELECT payload,result FROM data_tasks WHERE vehicle_id=? ORDER BY created_at_ms DESC,request_id LIMIT 100`, vehicle)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []map[string]any{}
	for rows.Next() {
		var raw, result []byte
		if err = rows.Scan(&raw, &result); err != nil {
			return nil, err
		}
		var value any
		if result != nil {
			value = json.RawMessage(result)
		}
		tasks = append(tasks, map[string]any{"request": json.RawMessage(raw), "result": value})
	}
	out["tasks"] = tasks
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT event_id,operator_id,acknowledged_at_ms
 FROM data_event_acknowledgements WHERE vehicle_id=? AND event_id IN
 (SELECT event_id FROM data_events WHERE vehicle_id=? ORDER BY id DESC LIMIT 100)
 ORDER BY acknowledged_at_ms DESC,event_id LIMIT 100`, vehicle, vehicle)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	acknowledgements := []map[string]any{}
	for rows.Next() {
		var id, operator string
		var stamp int64
		if err = rows.Scan(&id, &operator, &stamp); err != nil {
			return nil, err
		}
		acknowledgements = append(acknowledgements, map[string]any{"event_id": id, "operator_id": operator, "acknowledged_at_ms": stamp})
	}
	out["acknowledgements"] = acknowledgements
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	capacity, err := s.dataCapacity(ctx, vehicle)
	if err != nil {
		return nil, err
	}
	out["capacity"] = capacity
	return out, nil
}
