package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func newOperationsTestStore(t *testing.T, path string) *OperationsStore {
	t.Helper()
	store, err := OpenOperationsStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func operationsTestTelemetry(t *testing.T, vehicle string, sequence, published int64, age, source, message string) validatedTelemetry {
	t.Helper()
	raw := fmt.Sprintf(`{"schema_version":1,"type":"vehicle_telemetry","vehicle_id":%q,"stream_id":"stream-a","sequence":%d,"published_at_ms":%d,"chassis":{"age_ms":%s,"source_timestamp_ms":%s,"source_sequence":0,"message":%s},"localization":{"age_ms":null,"source_timestamp_ms":null,"source_sequence":null,"message":null}}`,
		vehicle, sequence, published, age, source, message)
	state, err := validateVehicleTelemetry([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func recordOperationsTest(t *testing.T, store *OperationsStore, vehicle string, sequence, receipt int64, age, source, message string) validatedTelemetry {
	t.Helper()
	state := operationsTestTelemetry(t, vehicle, sequence, receipt, age, source, message)
	if err := store.RecordTelemetry(context.Background(), state, receipt); err != nil {
		t.Fatal(err)
	}
	return state
}

func operationsSnapshot(t *testing.T, store *OperationsStore, vehicle string) OperationsResponse {
	t.Helper()
	result, err := store.Snapshot(context.Background(), vehicle)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestOperationsDurableReopenIsolationAndIdempotency(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "private", "operations?#.sqlite")
	store := newOperationsTestStore(t, path)
	if err := store.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	state := recordOperationsTest(t, store, "car-1", 1, 100000, "0", "100000", `{"error_code":1,"speed_mps":2}`)
	recordOperationsTest(t, store, "car-2", 1, 100000, "0", "100000", `{"error_code":2}`)
	mission := OperationsMission{MissionID: "mission-1", Status: "accepted", UpdatedAtMS: 100000, Description: "Device report"}
	if err := store.RecordMission(ctx, "car-1", mission); err != nil {
		t.Fatal(err)
	}
	before := operationsSnapshot(t, store, "car-1")
	if err := store.RecordTelemetry(ctx, state, 100001); err != nil {
		t.Fatal(err)
	}
	changed := state
	changed.Payload = []byte(strings.Replace(string(state.Payload), `"error_code":1`, `"error_code":2`, 1))
	if err := store.RecordTelemetry(ctx, changed, 100002); !errors.Is(err, ErrOperationsConflict) {
		t.Fatalf("changed duplicate: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.Ping(ctx); err == nil {
		t.Fatal("closed database must fail readiness")
	}
	reopened := newOperationsTestStore(t, path)
	recordOperationsTest(t, reopened, "car-1", 2, 100001, "0", "100001", `{"error_code":1}`)
	after := operationsSnapshot(t, reopened, "car-1")
	if len(after.History) != 2 || len(after.Alerts) != 1 || after.Alerts[0].EventID != before.Alerts[0].EventID ||
		after.History[1].ReceivedAtMS != 100000 || len(after.Missions) != 1 || after.Missions[0] != mission {
		t.Fatalf("reopened snapshot lost/idempotency/isolation: %+v", after)
	}
	if string(after.History[1].Localization) != "null" || !strings.Contains(string(after.History[1].Chassis), `"speed_mps":2`) {
		t.Fatalf("history must expose message objects: %+v", after.History[1])
	}
	other := operationsSnapshot(t, reopened, "car-2")
	if len(other.History) != 1 || len(other.Alerts) != 1 || len(other.Missions) != 0 ||
		other.Alerts[0].EventID == after.Alerts[0].EventID {
		t.Fatalf("vehicle data leaked: %+v", other)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("database permissions: %v, %v", info, err)
	}
	parent, err := os.Stat(filepath.Dir(path))
	if err != nil || parent.Mode().Perm() != 0700 {
		t.Fatalf("database directory permissions: %v, %v", parent, err)
	}
}

func TestOperationsAlertsRequireFreshExplicitRecovery(t *testing.T) {
	store := newOperationsTestStore(t, ":memory:")
	recordOperationsTest(t, store, "car-1", 1, 100000, "0", "100000", `{"error_code":1}`)
	recordOperationsTest(t, store, "car-1", 2, 100001, "0", "100001", `{"error_code":1}`)
	recordOperationsTest(t, store, "car-1", 3, 100002, "0", "100002", `{"error_code":2}`)
	for i, sample := range []struct{ age, source, message string }{
		{"null", "null", "null"},
		{"0", "100003", "{}"},
		{"0", "100003", `{"error_code":null}`},
		{"20000", "100003", `{"error_code":0}`},
		{"0", "1", `{"error_code":0}`},
		{"0", "999999", `{"error_code":0}`},
		{"0", "null", `{"error_code":0}`},
	} {
		recordOperationsTest(t, store, "car-1", int64(i+4), int64(100003+i), sample.age, sample.source, sample.message)
	}
	result := operationsSnapshot(t, store, "car-1")
	if len(result.Alerts) != 2 {
		t.Fatalf("expected two error transitions: %+v", result.Alerts)
	}
	for _, alert := range result.Alerts {
		if alert.Status != "open" || alert.ResolvedAtMS != nil {
			t.Fatalf("missing/stale/default/clock samples resolved alert: %+v", alert)
		}
	}
	// A delayed SQL write must not apply a recovery older than the latest
	// accepted missing sample, even if its own source was fresh at receipt.
	recordOperationsTest(t, store, "car-1", 12, 100011, "null", "null", "null")
	recordOperationsTest(t, store, "car-1", 11, 100010, "0", "100010", `{"error_code":0}`)
	result = operationsSnapshot(t, store, "car-1")
	if result.Alerts[0].Status != "open" {
		t.Fatal("late recovery regressed alert state")
	}
	recordOperationsTest(t, store, "car-1", 13, 100012, "0", "100012", `{"error_code":0}`)
	for _, alert := range operationsSnapshot(t, store, "car-1").Alerts {
		if alert.Status != "resolved" || alert.ResolvedAtMS == nil || *alert.ResolvedAtMS != 100012 {
			t.Fatalf("explicit fresh recovery did not resolve: %+v", alert)
		}
	}
	recordOperationsTest(t, store, "car-1", 14, 100013, "0", "100013", `{"error_code":2}`)
	result = operationsSnapshot(t, store, "car-1")
	if len(result.Alerts) != 3 || result.Alerts[0].Status != "open" {
		t.Fatalf("recurrence must get a new event: %+v", result.Alerts)
	}
}

func TestOperationsReversedSQLWritesPreserveLatestAlertState(t *testing.T) {
	for _, test := range []struct {
		name        string
		lateReceipt int64
	}{
		{"older receipt", 100000},
		{"same receipt older sequence", 100001},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := newOperationsTestStore(t, ":memory:")
			// Redis accepted sequence 1 then 2, but the goroutine for 2
			// reaches SQL first. Sequence 1 must still enter history.
			recordOperationsTest(t, store, "car-1", 2, 100001, "0", "100001", `{"error_code":2}`)
			recordOperationsTest(t, store, "car-1", 1, test.lateReceipt, "0", fmt.Sprint(test.lateReceipt), `{"error_code":0}`)
			result := operationsSnapshot(t, store, "car-1")
			if len(result.History) != 2 || len(result.Alerts) != 1 ||
				result.Alerts[0].Status != "open" || result.Alerts[0].ResolvedAtMS != nil {
				t.Fatalf("late SQL recovery regressed alert or lost history: %+v", result)
			}
			recordOperationsTest(t, store, "car-1", 3, 100002, "0", "100002", `{"error_code":0}`)
			recordOperationsTest(t, store, "car-1", 1, test.lateReceipt, "0", fmt.Sprint(test.lateReceipt), `{"error_code":0}`)
			result = operationsSnapshot(t, store, "car-1")
			if len(result.Alerts) != 1 || result.Alerts[0].Status != "resolved" ||
				result.Alerts[0].ResolvedAtMS == nil || *result.Alerts[0].ResolvedAtMS != 100002 {
				t.Fatalf("latest explicit recovery or idempotent retry regressed: %+v", result.Alerts)
			}
		})
	}
}

func TestOperationsTransactionRollbackAndMigrationFailure(t *testing.T) {
	store := newOperationsTestStore(t, ":memory:")
	if _, err := store.db.Exec(`CREATE TRIGGER reject_alert BEFORE INSERT ON operations_alerts BEGIN SELECT RAISE(ABORT,'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	state := operationsTestTelemetry(t, "car-1", 1, 100000, "0", "100000", `{"error_code":1}`)
	if err := store.RecordTelemetry(context.Background(), state, 100000); err == nil {
		t.Fatal("SQL failure must be explicit")
	}
	if exists, err := store.HasTelemetry(context.Background(), "car-1", "stream-a", 1); err != nil || exists {
		t.Fatalf("failed transaction appeared archived: exists=%v err=%v", exists, err)
	}
	result := operationsSnapshot(t, store, "car-1")
	if len(result.History) != 0 || len(result.Alerts) != 0 {
		t.Fatalf("partial transaction persisted: %+v", result)
	}
	if _, err := store.db.Exec("DROP TRIGGER reject_alert"); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordTelemetry(context.Background(), state, 100000); err != nil {
		t.Fatal(err)
	}
	if exists, err := store.HasTelemetry(context.Background(), "car-1", "stream-a", 1); err != nil || !exists {
		t.Fatalf("successful retry not archived: exists=%v err=%v", exists, err)
	}
	if len(operationsSnapshot(t, store, "car-1").Alerts) != 1 {
		t.Fatal("failed transaction advanced the alert watermark")
	}
	path := filepath.Join(t.TempDir(), "future.sqlite")
	future := newOperationsTestStore(t, path)
	if _, err := future.db.Exec("PRAGMA user_version=999"); err != nil {
		t.Fatal(err)
	}
	_ = future.Close()
	if reopened, err := OpenOperationsStore(path); err == nil {
		_ = reopened.Close()
		t.Fatal("future schema must not be silently accepted")
	}
	if _, err := OpenOperationsStore(filepath.Join(path, "child.sqlite")); err == nil {
		t.Fatal("invalid disk path silently fell back")
	}
	if _, err := OpenOperationsStore(""); err == nil {
		t.Fatal("empty disk path silently fell back")
	}
	if _, err := OpenOperationsStore("file::memory:"); err == nil {
		t.Fatal("SQLite URI should not bypass path protection")
	}
}

func TestOperationsHistoryRecoveryLookupIsolationAndFailure(t *testing.T) {
	store := newOperationsTestStore(t, ":memory:")
	recordOperationsTest(t, store, "car-1", 1, 100000, "0", "100000", `{}`)
	for _, key := range []struct {
		vehicle, stream string
		sequence        int64
	}{
		{"car-2", "stream-a", 1},
		{"car-1", "stream-b", 1},
		{"car-1", "stream-a", 2},
	} {
		if exists, err := store.HasTelemetry(context.Background(), key.vehicle, key.stream, key.sequence); err != nil || exists {
			t.Fatalf("lookup leaked another key: %+v exists=%v err=%v", key, exists, err)
		}
	}
	_ = store.Close()
	if exists, err := store.HasTelemetry(context.Background(), "car-1", "stream-a", 1); err == nil || exists {
		t.Fatalf("unavailable store must not authorize recovery: exists=%v err=%v", exists, err)
	}
}

func TestOperationsRetentionAndResponseBounds(t *testing.T) {
	store := newOperationsTestStore(t, ":memory:")
	ctx := context.Background()
	for i := int64(1); i <= int64(OperationsHistoryRetention+5); i++ {
		recordOperationsTest(t, store, "car-1", i, 100000+i, "0", fmt.Sprint(100000+i), fmt.Sprintf(`{"error_code":%d}`, 1+i%2))
		if err := store.RecordMission(ctx, "car-1", OperationsMission{
			MissionID: fmt.Sprintf("mission-%04d", i), Status: "running", UpdatedAtMS: i,
		}); err != nil {
			t.Fatal(err)
		}
	}
	for table, want := range map[string]int{
		"operations_history": OperationsHistoryRetention,
		"operations_alerts":  OperationsAlertRetention, "operations_missions": OperationsMissionRetention,
	} {
		var count int
		if err := store.db.QueryRow("SELECT count(*) FROM " + table + " WHERE vehicle_id='car-1'").Scan(&count); err != nil || count != want {
			t.Fatalf("%s count=%d want=%d err=%v", table, count, want, err)
		}
	}
	result := operationsSnapshot(t, store, "car-1")
	if len(result.History) != OperationsHistoryLimit || len(result.Alerts) != OperationsAlertLimit ||
		len(result.Missions) != OperationsMissionLimit || result.History[0].Sequence != OperationsHistoryRetention+5 ||
		result.Missions[0].UpdatedAtMS != OperationsHistoryRetention+5 {
		t.Fatalf("response limits/order incorrect: history=%d alerts=%d missions=%d", len(result.History), len(result.Alerts), len(result.Missions))
	}
	if exists, err := store.HasTelemetry(ctx, "car-1", "stream-a", 1); err != nil || exists {
		t.Fatalf("retention should remove old history lookup: exists=%v err=%v", exists, err)
	}
	if exists, err := store.HasTelemetry(ctx, "car-1", "stream-a", OperationsHistoryRetention+5); err != nil || !exists {
		t.Fatalf("newest snapshot must remain archived: exists=%v err=%v", exists, err)
	}
}

func TestOperationsDiagnosticsConservativeTiming(t *testing.T) {
	for _, test := range []struct {
		name, age, source, message, issue string
		published, received, now          int64
		wantAge                           *int64
	}{
		{"missing", "null", "null", "null", "chassis_missing", 100000, 100001, 100002, nil},
		{"source unknown", "0", "null", `{}`, "chassis_timing_missing", 100000, 100001, 100002, nil},
		{"callback unknown", "null", "100000", `{}`, "chassis_timing_missing", 100000, 100001, 100002, nil},
		{"publication clock", "0", "100000", `{}`, "chassis_clock", 100002, 100001, 100003, nil},
		{"receipt clock", "0", "100000", `{}`, "chassis_clock", 100000, 100002, 100001, nil},
		{"source clock", "0", "100003", `{}`, "chassis_clock", 100000, 100001, 100002, nil},
		{"network stale", "0", "100000", `{}`, "chassis_stale", 100000, 120000, 120001, operationsInt(20001)},
		{"source stale", "0", "1", `{}`, "chassis_stale", 100000, 100001, 100002, operationsInt(100001)},
		{"callback age", "100", "100000", `{}`, "", 100000, 100001, 100002, operationsInt(102)},
		{"chassis error", "0", "100000", `{"error_code":1}`, "chassis_error", 100000, 100001, 100002, operationsInt(2)},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := operationsTestTelemetry(t, "car-1", 1, test.published, test.age, test.source, test.message)
			result := deriveOperationsDiagnostics(state.Payload, &test.received, test.now)
			if (result.ChassisAgeMS == nil) != (test.wantAge == nil) ||
				(result.ChassisAgeMS != nil && *result.ChassisAgeMS != *test.wantAge) {
				t.Fatalf("age=%v want=%v", result.ChassisAgeMS, test.wantAge)
			}
			found := false
			for _, issue := range result.Issues {
				found = found || issue.Code == test.issue
			}
			if test.issue != "" && !found {
				t.Fatalf("missing %s: %+v", test.issue, result.Issues)
			}
			if test.source == "null" && result.SourceTimestampMS != nil {
				t.Fatal("unknown source timestamp invented")
			}
		})
	}
}

func operationsInt(value int64) *int64 { return &value }

func TestOperationsAcceptsTelemetryIntegralExponentNotation(t *testing.T) {
	store := newOperationsTestStore(t, ":memory:")
	state := operationsTestTelemetry(t, "car-1", 1, 100000, "0e1", "1e5", `{"error_code":1e0}`)
	state.Payload = []byte(strings.Replace(string(state.Payload), `"published_at_ms":100000`, `"published_at_ms":1e5`, 1))
	if err := store.RecordTelemetry(context.Background(), state, 100000); err != nil {
		t.Fatal(err)
	}
	result := operationsSnapshot(t, store, "car-1")
	if len(result.Alerts) != 1 || result.History[0].PublishedAtMS != 100000 {
		t.Fatalf("valid exact exponent telemetry rejected/misparsed: %+v", result)
	}
}

func TestOperationsMissionOrderingAndConcurrentReports(t *testing.T) {
	store := newOperationsTestStore(t, ":memory:")
	ctx := context.Background()
	initial := OperationsMission{MissionID: "mission-1", Status: "running", UpdatedAtMS: 100, Description: "Started"}
	for i := 0; i < 2; i++ {
		if err := store.RecordMission(ctx, "car-1", initial); err != nil {
			t.Fatal(err)
		}
	}
	changed := initial
	changed.Description = "Different"
	if err := store.RecordMission(ctx, "car-1", changed); !errors.Is(err, ErrOperationsConflict) {
		t.Fatalf("equal-time conflict: %v", err)
	}
	changed.UpdatedAtMS = 99
	if err := store.RecordMission(ctx, "car-1", changed); !errors.Is(err, ErrMissionOutdated) {
		t.Fatalf("older report: %v", err)
	}
	var workers sync.WaitGroup
	for i := int64(101); i <= 130; i++ {
		workers.Add(1)
		go func(timestamp int64) {
			defer workers.Done()
			mission := initial
			mission.UpdatedAtMS = timestamp
			err := store.RecordMission(ctx, "car-1", mission)
			if err != nil && !errors.Is(err, ErrMissionOutdated) {
				t.Errorf("concurrent mission: %v", err)
			}
		}(i)
	}
	workers.Wait()
	if got := operationsSnapshot(t, store, "car-1").Missions[0].UpdatedAtMS; got != 130 {
		t.Fatalf("late report regressed mission to %d", got)
	}
}

func newOperationsAPIFixture(t *testing.T) (*telemetryFixture, *OperationsStore) {
	t.Helper()
	fixture := newTelemetryFixture(t)
	store := newOperationsTestStore(t, ":memory:")
	NewOperationsAPI(store, fixture.api.registry, fixture.api.states,
		fixture.api.authorizer, fixture.api.identities, func() time.Time { return fixture.now }).register(fixture.mux)
	return fixture, store
}

func TestOperationsAPIAuthenticationACLAndFailures(t *testing.T) {
	f, store := newOperationsAPIFixture(t)
	path := "/api/vehicles/car-1/operations"
	for token, status := range map[string]int{
		"": 401, "invalid": 401, "wrongtenant": 403, "denied": 403,
		"roleless": 403, "device1": 403, "observer": 200, "controller": 200,
	} {
		f.request(t, http.MethodGet, path, token, "", status)
	}
	f.request(t, http.MethodGet, "/api/vehicles/not-registered/operations", "observer", "", 404)
	response := f.request(t, http.MethodGet, path, "observer", "", 200)
	var empty OperationsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &empty); err != nil {
		t.Fatal(err)
	}
	if empty.VehicleID != "car-1" || empty.ServerTimeMS != f.now.UnixMilli() ||
		empty.History == nil || empty.Alerts == nil || empty.Missions == nil || empty.Diagnostics.SourceTimestampMS != nil ||
		empty.Capabilities.MissionCommands || empty.Capabilities.GeographicProjection || empty.Capabilities.Driving {
		t.Fatalf("invalid empty/read-only contract: %s", response.Body.String())
	}
	// Diagnostics must read the latest Redis snapshot even with empty SQL history.
	state := operationsTestTelemetry(t, "car-1", 1, f.now.UnixMilli(), "0", fmt.Sprint(f.now.UnixMilli()), `{"error_code":1}`)
	if err := f.api.states.Save(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	response = f.request(t, http.MethodGet, path, "observer", "", 200)
	if !strings.Contains(response.Body.String(), `"chassis_error"`) || !strings.Contains(response.Body.String(), `"history":[]`) {
		t.Fatalf("diagnostics are not from latest Redis: %s", response.Body.String())
	}
	_ = store.Close()
	f.request(t, http.MethodGet, path, "observer", "", 503)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/mission-status", "device1",
		`{"mission_id":"m","status":"running","updated_at_ms":1,"description":""}`, 503)
	f.redis.Close()
	f.request(t, http.MethodGet, path, "observer", "", 503)
}

func TestOperationsMissionAPIValidationAndDeviceIdentity(t *testing.T) {
	f, store := newOperationsAPIFixture(t)
	path := "/api/vehicles/car-1/mission-status"
	base := `{"mission_id":"mission-1","status":"running","updated_at_ms":100,"description":"Authoritative HTTP report"}`
	for token, status := range map[string]int{"": 401, "observer": 403, "device2": 403, "spoof": 403} {
		f.request(t, http.MethodPost, path, token, base, status)
	}

	f.request(t, http.MethodPost, "/api/vehicles/not-registered/mission-status", "device3", base, 404)
	for _, invalid := range []string{
		`null`, `{}`, base + `{}`, base + `garbage`,
		strings.Replace(base, `"mission_id":"mission-1"`, `"mission_id":"bad/id"`, 1),
		strings.Replace(base, `"status":"running"`, `"status":"dispatched"`, 1),
		strings.Replace(base, `"updated_at_ms":100`, `"updated_at_ms":0`, 1),
		strings.Replace(base, `"updated_at_ms":100`, `"updated_at_ms":-1`, 1),
		strings.Replace(base, `"updated_at_ms":100`, `"updated_at_ms":1.5`, 1),
		strings.Replace(base, `"updated_at_ms":100`, `"updated_at_ms":9007199254740992`, 1),
		strings.Replace(base, `"updated_at_ms":100`, `"updated_at_ms":null`, 1),
		strings.Replace(base, `"description":"Authoritative HTTP report"`, `"description":null`, 1),
		strings.Replace(base, `,"description":"Authoritative HTTP report"`, ``, 1),
		strings.Replace(base, `"mission_id":"mission-1"`, `"extra":1,"mission_id":"mission-1"`, 1),
		strings.Replace(base, `"status":"running"`, `"status":"accepted","status":"running"`, 1),
		strings.Replace(base, `"description":"Authoritative HTTP report"`, `"description":"`+strings.Repeat("x", 2049)+`"`, 1),
	} {
		f.request(t, http.MethodPost, path, "device1", invalid, 400)
	}
	f.request(t, http.MethodPost, path, "device1", strings.Repeat("x", 8193), 413)
	f.request(t, http.MethodPost, path, "device1", base, 204)
	f.request(t, http.MethodPost, path, "device1", base, 204)
	f.request(t, http.MethodPost, path, "device1", strings.Replace(base, `:100`, `:1e2`, 1), 204)
	f.request(t, http.MethodPost, path, "device1", strings.Replace(base, `"running"`, `"failed"`, 1), 409)
	f.request(t, http.MethodPost, path, "device1", strings.Replace(base, `:100`, `:99`, 1), 409)
	newer := strings.Replace(strings.Replace(base, `:100`, `:101`, 1), `"running"`, `"succeeded"`, 1)
	f.request(t, http.MethodPost, path, "device1", newer, 204)
	result := operationsSnapshot(t, store, "car-1")
	if len(result.Missions) != 1 || result.Missions[0].Status != "succeeded" || result.Missions[0].UpdatedAtMS != 101 {
		t.Fatalf("mission snapshot regressed: %+v", result.Missions)
	}
}

func TestOperationsRejectsCorruptStoredData(t *testing.T) {
	for _, test := range []struct {
		name, corrupt string
	}{
		{"history JSON", `UPDATE operations_history SET payload='{}'`},
		{"history identity", `UPDATE operations_history SET stream_id='other-stream'`},
		{"history receipt", `UPDATE operations_history SET received_at_ms=0`},
		{"history publication", `UPDATE operations_history SET published_at_ms=2`},
		{"mission status", `UPDATE operations_missions SET status='dispatching'`},
		{"alert status", `UPDATE operations_alerts SET status='acknowledged'`},
		{"alert false resolution", `UPDATE operations_alerts SET status='resolved',resolved_at_ms=NULL`},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, store := newOperationsAPIFixture(t)
			recordOperationsTest(t, store, "car-1", 1, 100000, "0", "100000", `{"error_code":1}`)
			if err := store.RecordMission(context.Background(), "car-1",
				OperationsMission{MissionID: "m", Status: "accepted", UpdatedAtMS: 100000}); err != nil {
				t.Fatal(err)
			}
			if _, err := store.db.Exec(test.corrupt); err != nil {
				t.Fatal(err)
			}
			f.request(t, http.MethodGet, "/api/vehicles/car-1/operations", "observer", "", 503)
		})
	}
}

// Optional fixture output uses synthetic data only. Callers may mount the
// session-state files directory and set OPERATIONS_FIXTURE_PATH for TS contract
// validation; default test runs never write an external fixture.
func TestOperationsAPIEmitsFixture(t *testing.T) {
	path := os.Getenv("OPERATIONS_FIXTURE_PATH")
	if path == "" {
		t.Skip("OPERATIONS_FIXTURE_PATH not configured")
	}
	f, store := newOperationsAPIFixture(t)
	now := f.now.UnixMilli()
	state := operationsTestTelemetry(t, "car-1", 1, now, "5", fmt.Sprint(now-5), `{"error_code":2,"speed_mps":1.5,"gear_location":"GEAR_DRIVE"}`)
	state.Payload = []byte(strings.Replace(string(state.Payload),
		`"localization":{"age_ms":null,"source_timestamp_ms":null,"source_sequence":null,"message":null}`,
		fmt.Sprintf(`"localization":{"age_ms":10,"source_timestamp_ms":%d,"source_sequence":1,"message":{"position":{"x":1,"y":2,"z":0},"heading_rad":0.5,"frame_id":"map"}}`, now-10), 1))
	if err := f.api.states.Save(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordTelemetry(context.Background(), state, now); err != nil {
		t.Fatal(err)
	}
	f.request(t, http.MethodPost, "/api/vehicles/car-1/mission-status", "device1",
		fmt.Sprintf(`{"mission_id":"mission-1","status":"running","updated_at_ms":%d,"description":"Synthetic device HTTP snapshot, not native Mission ingestion"}`, now), 204)
	response := f.request(t, http.MethodGet, "/api/vehicles/car-1/operations", "observer", "", 200)
	if err := os.WriteFile(path, response.Body.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
}
