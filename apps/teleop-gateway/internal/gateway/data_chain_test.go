package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDataSDKChain(t *testing.T) {
	client := os.Getenv("DATA_SDK_CLIENT")
	if client == "" {
		t.Skip("set DATA_SDK_CLIENT to the built C++ data_chain_client")
	}
	f, store := dataFixture(t)
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", `["car-1"]`)
	if err := store.createDataTask(context.Background(), "car-1", "chain-1", []byte(taskJSON("car-1", "chain-1", "simulate_wait"))); err != nil {
		t.Fatal(err)
	}
	var lostAck atomic.Bool
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			writeJSON(w, 200, map[string]any{"access_token": "device1", "expires_in": 3600})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/data/events") && !lostAck.Swap(true) {
			recorder := httptest.NewRecorder()
			f.mux.ServeHTTP(recorder, r)
			if recorder.Code != 204 {
				t.Errorf("first event rejected: %s", recorder.Body.String())
			}
			http.Error(w, "simulated lost ACK after commit", 503)
			return
		}
		f.mux.ServeHTTP(w, r)
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "device.sqlite")
	for attempt := 0; attempt < 2; attempt++ {
		cmd := exec.Command(client, server.URL, path)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("C++ SDK attempt %d: %v\n%s", attempt, err, output)
		}
		if attempt == 0 && !strings.Contains(string(output), "503") {
			t.Fatalf("ACK loss was not observed: %s", output)
		}
		view, err := store.dataView(context.Background(), "car-1")
		if err != nil {
			t.Fatal(err)
		}
		if view["health"] == nil || view["profile"] == nil || view["diagnostics"] == nil {
			t.Fatal("C++ health/profile/store diagnostics not received")
		}
		events := view["events"].([]json.RawMessage)
		if len(events) != (attempt+1)*2 {
			t.Fatalf("events lost or duplicate on retry/restart: %d", len(events))
		}
		var result []byte
		if err = store.db.QueryRow("SELECT result FROM data_tasks WHERE request_id='chain-1'").Scan(&result); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(result), `"status":"succeeded"`) || !strings.Contains(string(result), `"report_sequence":3`) {
			t.Fatalf("task lifecycle failed: %s", result)
		}
		state, _, err := f.api.states.Get(context.Background(), "car-1")
		if err != nil || state == nil {
			t.Fatalf("telemetry not received: %v", err)
		}
		if output := os.Getenv("DATA_PRODUCT_FIXTURE"); output != "" {
			view := f.request(t, http.MethodGet, "/api/vehicles/car-1/data", "observer", "", 200)
			events := f.request(t, http.MethodGet, "/api/vehicles/car-1/data/records?kind=events", "observer", "", 200)
			tasks := f.request(t, http.MethodGet, "/api/vehicles/car-1/data/records?kind=tasks", "observer", "", 200)
			fixture := map[string]json.RawMessage{"data": view.Body.Bytes(), "events": events.Body.Bytes(), "tasks": tasks.Body.Bytes()}
			raw, err := json.Marshal(fixture)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(output, raw, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
}
