package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func dataFixture(t *testing.T) (*telemetryFixture, *OperationsStore) {
	t.Helper()
	f := newTelemetryFixture(t)
	previousAudit := auditSink
	auditSink = NewJSONAuditSink(io.Discard)
	t.Cleanup(func() { auditSink = previousAudit })
	store := newOperationsTestStore(t, filepath.Join(t.TempDir(), "operations.sqlite"))
	(&DataAPI{store: store, registry: f.api.registry, authorizer: f.api.authorizer, identities: f.api.identities}).register(f.mux)
	return f, store
}
func taskJSON(vehicle, id, operation string) string {
	now := time.Now().UnixMilli()
	parameters := `{"duration_ms":0,"target_request_id":"target-1","target_client_epoch":"target-epoch"}`
	if operation == "simulate_wait" {
		parameters = `{"duration_ms":1,"target_request_id":null,"target_client_epoch":null}`
	}
	return fmt.Sprintf(`{"schema_version":1,"vehicle_id":%q,"request_id":%q,"client_epoch":"epoch-1","operation":%q,"created_at_ms":%d,"expires_at_ms":%d,"map_id":"map-a","parameters":%s}`, vehicle, id, operation, now, now+60000, parameters)
}
func TestDataIdentityContractsAndLifecycle(t *testing.T) {
	f, _ := dataFixture(t)
	base := "/api/vehicles/car-2/data"
	task := taskJSON("car-2", "request-1", "query")
	f.request(t, http.MethodPost, base+"/tasks", "observer", task, 403)
	f.request(t, http.MethodPost, base+"/tasks", "controller", task, 202)
	f.request(t, http.MethodPost, base+"/tasks", "controller", task, 202)
	f.request(t, http.MethodPost, base+"/tasks", "controller", strings.Replace(task, "target-1", "target-2", 1), 409)
	f.request(t, http.MethodGet, base+"/tasks/next", "device1", "", 403)
	f.request(t, http.MethodGet, base+"/tasks/next", "device2", "", 200)
	report := func(sequence int, status string) string {
		return fmt.Sprintf(`{"request_id":"request-1","report_sequence":%d,"status":%q,"reason":"test","mission_result":null}`, sequence, status)
	}
	f.request(t, http.MethodPost, base+"/task-results", "device2", report(2, "succeeded"), 409)
	for i, status := range []string{"received", "reconciling", "unknown", "succeeded"} {
		f.request(t, http.MethodPost, base+"/task-results", "device2", report(i+1, status), 204)
		f.request(t, http.MethodPost, base+"/task-results", "device2", report(i+1, status), 204)
	}
	f.request(t, http.MethodPost, base+"/task-results", "device2", report(5, "unknown"), 409)
	result := f.request(t, http.MethodGet, base+"/tasks/next", "device2", "", 200)
	if !strings.Contains(result.Body.String(), `"task":null`) {
		t.Fatal("terminal task still delivered")
	}
	f.request(t, http.MethodPost, base+"/tasks", "controller", taskJSON("car-2", "sim-1", "simulate_wait"), 403)
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", `["car-2"]`)
	f.request(t, http.MethodPost, base+"/tasks", "controller", taskJSON("car-2", "sim-1", "simulate_wait"), 202)
	f.request(t, http.MethodPost, base+"/tasks", "controller", strings.Replace(taskJSON("car-2", "unsafe", "query"), `"query"`, `"safety_reset"`, 1), 400)
	event := `{"schema_version":1,"type":"vehicle_event","vehicle_id":"car-2","event_id":"fault-1","fault_key":"components/monitor/process","severity":"ERROR","transition":"raised","occurred_at_ms":1,"message":"failed"}`
	f.request(t, http.MethodPost, base+"/events", "device1", event, 403)
	f.request(t, http.MethodPost, base+"/events", "device2", event, 204)
	f.request(t, http.MethodPost, base+"/events", "device2", event, 204)
	f.request(t, http.MethodPost, base+"/events", "device2", strings.Replace(event, "failed", "changed", 1), 409)
	f.request(t, http.MethodPost, base+"/events", "device2", strings.Replace(event, `"raised"`, `"recovered"`, 1), 400)
	f.request(t, http.MethodPost, base+"/events", "device2", strings.Replace(event, `"schema_version":1`, `"schema_version":1,"schema_version":1`, 1), 400)
	f.request(t, http.MethodPost, base+"/events", "device2", event+`{}`, 400)
	f.request(t, http.MethodPost, base+"/events/fault-1/acknowledge", "observer", "{}", 403)
	f.request(t, http.MethodPost, base+"/events/fault-1/acknowledge", "controller", "{}", 204)
	f.request(t, http.MethodPost, base+"/events/fault-1/acknowledge", "controller", "{}", 204)
	f.request(t, http.MethodPost, base+"/events/missing/acknowledge", "controller", "{}", 404)
	view := f.request(t, http.MethodGet, base, "observer", "", 200).Body.String()
	if !strings.Contains(view, `"transition":"raised"`) || !strings.Contains(view, `"operator_id":"alice"`) {
		t.Fatal("human acknowledgement mutated device recovery")
	}
	f.request(t, http.MethodGet, base, "observer", "", 200)
	f.request(t, http.MethodGet, base, "device2", "", 403)
}
func TestDataHealthAndMigration(t *testing.T) {
	f, store := dataFixture(t)
	path := "/api/vehicles/car-1/data/health"
	health := `{"schema_version":1,"type":"vehicle_health","vehicle_id":"car-1","stream_id":"stream-1","sequence":1,"published_at_ms":1,"sample":{"age_ms":null,"source_timestamp_ms":null,"source_sequence":null,"message":null}}`
	f.request(t, http.MethodPost, path, "device1", health, 204)
	f.request(t, http.MethodPost, path, "device1", health, 204)
	f.request(t, http.MethodPost, path, "device1", strings.Replace(health, `"age_ms":null`, `"age_ms":-1`, 1), 400)
	f.request(t, http.MethodPost, path, "device1", strings.Replace(health, `"published_at_ms":1`, `"published_at_ms":2`, 1), 409)
	ctx := context.Background()
	// Recreate the actual previous schema version, retaining existing operations.
	for _, query := range []string{"DROP TABLE data_snapshots", "DROP TABLE data_event_acknowledgements", "DROP TABLE data_events", "DROP TABLE data_tasks", "PRAGMA user_version=1"} {
		if _, err := store.db.ExecContext(ctx, query); err != nil {
			t.Fatal(err)
		}

	}
	if err := store.migrate(); err != nil {
		t.Fatal(err)
	}
	if err := store.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	event := []byte(`{"event_id":"persisted"}`)
	if err := store.saveDataEvent(ctx, "car-1", event, "persisted"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM data_events").Scan(&count); err != nil || count != 1 {
		t.Fatal("migration lost event table", err)
	}
	// Exercise durable reopen without depending on Redis or in-memory fixtures.
	durablePath := filepath.Join(t.TempDir(), "persist.sqlite")
	durable, err := OpenOperationsStore(durablePath)
	if err != nil {
		t.Fatal(err)
	}
	if err = durable.saveDataEvent(ctx, "car-1", event, "persisted"); err != nil {
		t.Fatal(err)
	}
	if err = durable.Close(); err != nil {
		t.Fatal(err)
	}
	durable = newOperationsTestStore(t, durablePath)
	if err = durable.saveDataEvent(ctx, "car-1", event, "persisted"); err != nil {
		t.Fatal(err)
	}
	view, err := durable.dataView(ctx, "car-1")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(view)
	if strings.Count(string(raw), `"event_id":"persisted"`) != 1 {
		t.Fatal("restart duplicate was not idempotent")
	}
}

func TestDataCapacityAndExpiredRetry(t *testing.T) {
	f, store := dataFixture(t)
	base := "/api/vehicles/car-2/data"
	now := time.Now().UnixMilli()
	task := fmt.Sprintf(`{"schema_version":1,"vehicle_id":"car-2","request_id":"expired","client_epoch":"epoch-1","operation":"query","created_at_ms":%d,"expires_at_ms":%d,"map_id":"map-a","parameters":{"duration_ms":0,"target_request_id":"target","target_client_epoch":"target-epoch"}}`, now-2000, now-1000)
	if _, err := store.db.Exec(`INSERT INTO data_tasks(vehicle_id,request_id,payload,created_at_ms) VALUES('car-2','expired',?,?)`, []byte(task), now-2000); err != nil {
		t.Fatal(err)
	}
	f.request(t, http.MethodPost, base+"/tasks", "controller", task, 202)
	f.request(t, http.MethodPost, base+"/tasks", "controller", strings.Replace(task, `"expired"`, `"new-expired"`, 1), 400)
	_, err := store.db.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
 INSERT INTO data_events(vehicle_id,event_id,payload,received_at_ms) SELECT 'car-2','event-'||i,'{}',1 FROM n`)
	if err != nil {
		t.Fatal(err)
	}
	event := `{"schema_version":1,"type":"vehicle_event","vehicle_id":"car-2","event_id":"new-event","fault_key":"monitor","severity":"ERROR","transition":"raised","occurred_at_ms":1,"message":"failed"}`
	f.request(t, http.MethodPost, base+"/events", "device2", event, 507)
	if err = store.saveDataEvent(context.Background(), "car-2", []byte(`{}`), "event-1"); err != nil {
		t.Fatal("capacity pressure broke exact retry", err)
	}
	if validMissionQueryResult(map[string]any{"outcome": "accepted", "code": "OK", "arbitrary": true}) {
		t.Fatal("loose Mission result contract accepted")
	}
	if dataUint64("18446744073709551616") || dataUint64(json.Number("1")) || !dataUint64("18446744073709551615") {
		t.Fatal("uint64 precision contract broken")
	}
}
