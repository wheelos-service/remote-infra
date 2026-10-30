package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

func (s *OperationsStore) dataCapacity(ctx context.Context, vehicle string) (map[string]any, error) {
	var events, tasks, pending, unknown, unacknowledged int
	err := s.db.QueryRowContext(ctx, `SELECT
 (SELECT COUNT(*) FROM data_events WHERE vehicle_id=?),
 (SELECT COUNT(*) FROM data_tasks WHERE vehicle_id=?),
 (SELECT COUNT(*) FROM data_tasks WHERE vehicle_id=? AND
 (result IS NULL OR json_extract(result,'$.status') IN ('received','reconciling','unknown'))),
 (SELECT COUNT(*) FROM data_tasks WHERE vehicle_id=? AND json_extract(result,'$.status')='unknown'),
 (SELECT COUNT(*) FROM data_events e WHERE e.vehicle_id=? AND NOT EXISTS
 (SELECT 1 FROM data_event_acknowledgements a WHERE a.vehicle_id=e.vehicle_id AND a.event_id=e.event_id))`,
		vehicle, vehicle, vehicle, vehicle, vehicle).Scan(&events, &tasks, &pending, &unknown, &unacknowledged)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"events_retained": events, "events_capacity": 10000,
		"tasks_retained": tasks, "tasks_capacity": 1000,
		"tasks_pending": pending, "tasks_unknown": unknown,
		"events_unacknowledged": unacknowledged,
		"capacity_warning":      events >= 8000 || tasks >= 800,
	}, nil
}

// Export is non-destructive. The upper cursor prevents concurrent new records
// extending an export indefinitely; task results/acknowledgements remain live.
func (s *OperationsStore) dataRecords(ctx context.Context, vehicle, kind string, after, through int64) (map[string]any, error) {
	table := "data_events"
	if kind == "tasks" {
		table = "data_tasks"
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if through == 0 {
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(rowid),0) FROM "+table+" WHERE vehicle_id=?", vehicle).Scan(&through); err != nil {
			return nil, err
		}
	}
	query := `SELECT e.rowid,e.payload,a.operator_id,a.acknowledged_at_ms
 FROM data_events e LEFT JOIN data_event_acknowledgements a
 ON a.vehicle_id=e.vehicle_id AND a.event_id=e.event_id
 WHERE e.vehicle_id=? AND e.rowid>? AND e.rowid<=? ORDER BY e.rowid LIMIT 101`
	if kind == "tasks" {
		query = `SELECT rowid,payload,result,NULL FROM data_tasks
 WHERE vehicle_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 101`
	}
	rows, err := tx.QueryContext(ctx, query, vehicle, after, through)
	if err != nil {
		return nil, err
	}
	records := []map[string]any{}
	next := after
	hasMore := false
	for rows.Next() {
		if len(records) == 100 {
			hasMore = true
			break
		}
		var id int64
		var raw []byte
		record := map[string]any{}
		if kind == "events" {
			var operator sql.NullString
			var stamp sql.NullInt64
			if err = rows.Scan(&id, &raw, &operator, &stamp); err != nil {
				break
			}
			record["acknowledgement"] = nil
			if operator.Valid && stamp.Valid {
				record["acknowledgement"] = map[string]any{"operator_id": operator.String, "acknowledged_at_ms": stamp.Int64}
			}
		} else {
			var result []byte
			var ignored any
			if err = rows.Scan(&id, &raw, &result, &ignored); err != nil {
				break
			}
			record["result"] = nil
			if result != nil {
				record["result"] = json.RawMessage(result)
			}
		}
		record["cursor"] = id
		record["payload"] = json.RawMessage(raw)
		records = append(records, record)
		next = id
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"vehicle_id": vehicle, "kind": kind, "through": through,
		"next": next, "has_more": hasMore, "records": records}, nil
}

func (api *DataAPI) records(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "observe") {
		return
	}
	values, parseErr := url.ParseQuery(r.URL.RawQuery)
	if parseErr != nil {
		http.Error(w, "invalid export query", 400)
		return
	}
	kind := values.Get("kind")
	if kind != "events" && kind != "tasks" {
		http.Error(w, "kind must be events or tasks", 400)
		return
	}
	for name, entries := range values {
		if len(entries) != 1 || (name != "kind" && name != "after" && name != "through") {
			http.Error(w, "invalid export query", 400)
			return
		}
	}
	cursor := func(name string) (int64, error) {
		if !values.Has(name) {
			return 0, nil
		}
		n, err := strconv.ParseInt(values.Get(name), 10, 64)
		if err != nil || n < 0 || n > maxTelemetryInteger {
			return 0, fmt.Errorf("invalid %s cursor", name)
		}
		return n, nil
	}
	after, err := cursor("after")
	through, upperErr := cursor("through")
	if err != nil || upperErr != nil || (after > 0 && (through == 0 || after > through)) {
		http.Error(w, "invalid export cursor", 400)
		return
	}
	value, err := api.store.dataRecords(r.Context(), r.PathValue("vehicle_id"), kind, after, through)
	if err != nil {
		dataWriteResult(w, err)
		return
	}
	writeJSON(w, 200, value)
}

func (api *DataAPI) diagnostics(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "device") {
		return
	}
	raw, v, ok := readDataJSON(w, r, 8192)
	if !ok {
		return
	}
	if !exactData(v, "schema_version", "type", "vehicle_id", "stream_id", "sequence", "published_at_ms", "store") ||
		!dataInt(v["schema_version"], 1, 1) || v["type"] != "vehicle_data_diagnostics" ||
		v["vehicle_id"] != r.PathValue("vehicle_id") || !dataID(v["stream_id"]) ||
		!dataInt(v["sequence"], 1, maxTelemetryInteger) || !dataInt(v["published_at_ms"], 1, maxTelemetryInteger) {
		http.Error(w, "invalid Data diagnostics", 400)
		return
	}
	stats, ok := v["store"].(map[string]any)
	if !ok || !exactData(stats, "capacity", "outbox_retained", "outbox_pending", "inbox_retained", "inbox_pending", "faults_retained") ||
		!dataInt(stats["capacity"], 1, 100000) {
		http.Error(w, "invalid Data store diagnostics", 400)
		return
	}
	capacity, _ := telemetryInteger(stats["capacity"], 1, 100000)
	for _, field := range []string{"outbox_retained", "outbox_pending", "inbox_retained", "inbox_pending", "faults_retained"} {
		if !dataInt(stats[field], 0, capacity) {
			http.Error(w, "invalid Data store counter", 400)
			return
		}
	}
	for _, pair := range [][2]string{{"outbox_pending", "outbox_retained"}, {"inbox_pending", "inbox_retained"}} {
		pending, _ := telemetryInteger(stats[pair[0]], 0, capacity)
		retained, _ := telemetryInteger(stats[pair[1]], 0, capacity)
		if pending > retained {
			http.Error(w, "inconsistent Data store counters", 400)
			return
		}
	}
	dataWriteResult(w, api.store.saveDataSnapshot(r.Context(), r.PathValue("vehicle_id"), "diagnostics", raw, v))
}
