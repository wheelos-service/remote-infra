package gateway

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTelemetryArchiveRetryPreservesOriginalReceipt(t *testing.T) {
	f := newTelemetryFixture(t)
	path := filepath.Join(t.TempDir(), "operations.db")
	operations, err := OpenOperationsStore(path)
	if err != nil {
		t.Fatal(err)
	}
	f.api.operations = operations
	if err := operations.Close(); err != nil {
		t.Fatal(err)
	}
	body := telemetryBody("car-1", "stream", 1)
	receipt := f.now.UnixMilli()
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", body, http.StatusServiceUnavailable)
	latest := f.get(t, "car-1")
	if latest.ReceivedAtMS == nil || *latest.ReceivedAtMS != receipt {
		t.Fatal("partial SQL failure must retain the actual Redis receipt")
	}
	operations, err = OpenOperationsStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer operations.Close()
	f.api.operations = operations
	f.now = f.now.Add(time.Second)
	// A conflicting packet cannot use the archive-retry path.
	changed := strings.Replace(body, `"published_at_ms":1`, `"published_at_ms":2`, 1)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", changed, http.StatusConflict)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", body, http.StatusNoContent)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", body, http.StatusConflict)
	if *f.get(t, "car-1").ReceivedAtMS != receipt {
		t.Fatal("archive retry falsely refreshed vehicle online time")
	}
	snapshot, err := operations.Snapshot(context.Background(), "car-1")
	if err != nil || len(snapshot.History) != 1 || snapshot.History[0].ReceivedAtMS != receipt {
		t.Fatalf("recovered archive = %#v %v", snapshot.History, err)
	}
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-1", "stream", 2), http.StatusNoContent)
	snapshot, err = operations.Snapshot(context.Background(), "car-1")
	if err != nil || len(snapshot.History) != 2 {
		t.Fatalf("new telemetry did not persist: %#v %v", snapshot.History, err)
	}
}

func TestTelemetryArchiveRejectsMissingOlderSnapshotRetry(t *testing.T) {
	f := newTelemetryFixture(t)
	operations, err := OpenOperationsStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer operations.Close()
	f.api.operations = operations
	// Simulate an earlier Redis success whose archive did not complete.
	first, err := validateVehicleTelemetry([]byte(telemetryBody("car-1", "stream", 1)))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.api.states.Save(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(time.Second)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-1", "stream", 2), http.StatusNoContent)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", string(first.Payload), http.StatusConflict)
	snapshot, err := operations.Snapshot(context.Background(), "car-1")
	if err != nil || len(snapshot.History) != 1 || snapshot.History[0].Sequence != 2 {
		t.Fatal("old data crossed the current Redis replay fence", err)
	}
}
