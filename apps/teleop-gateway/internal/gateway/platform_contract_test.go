package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Synthetic device inputs pass through the real HTTP validators and both stores.
// Optional output is consumed by the frontend contract runner, not production.
func TestPlatformMockContracts(t *testing.T) {
	f, store := newOperationsAPIFixture(t)
	f.api.operations = store
	var corpus []map[string]any
	capture := func(name string, expected map[string]any) {
		t.Helper()
		entry := f.request(t, http.MethodGet, "/api/vehicles/car-1/state", "observer", "", 200)
		operations := f.request(t, http.MethodGet, "/api/vehicles/car-1/operations", "observer", "", 200)
		directory := f.request(t, http.MethodGet, "/api/vehicles", "observer", "", 200)
		var decoded OperationsResponse
		if err := json.Unmarshal(operations.Body.Bytes(), &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.Capabilities.Driving || decoded.Capabilities.MissionCommands {
			t.Fatal("mock contract must not enable vehicle commands")
		}
		corpus = append(corpus, map[string]any{
			"name": name, "entry": json.RawMessage(entry.Body.Bytes()),
			"operations": json.RawMessage(operations.Body.Bytes()),
			"directory":  json.RawMessage(directory.Body.Bytes()), "expected": expected,
		})
	}
	post := func(sequence int, stream, message, age, source string) {
		t.Helper()
		now := f.now.UnixMilli()
		body := fmt.Sprintf(`{"schema_version":1,"type":"vehicle_telemetry","vehicle_id":"car-1","stream_id":%q,"sequence":%d,"published_at_ms":%d,"chassis":{"age_ms":%s,"source_timestamp_ms":%s,"source_sequence":1,"message":%s},"localization":{"age_ms":0,"source_timestamp_ms":%d,"source_sequence":1,"message":{"position":{"x":10,"y":-2,"z":0},"heading_rad":0.5,"frame_id":"mock-map"}}}`,
			stream, sequence, now, age, source, message, now)
		f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", body, 204)
	}
	capture("never-received", map[string]any{"online": false, "freshness": "unknown", "history": 0})
	post(1, "mock-a", `{"speed_mps":2,"gear_location":"GEAR_DRIVE","error_code":0}`, "0", fmt.Sprint(f.now.UnixMilli()))
	capture("driving", map[string]any{"online": true, "freshness": "fresh", "speed": 2, "gear": "GEAR_DRIVE"})
	f.now = f.now.Add(time.Second)
	post(2, "mock-a", `{"speed_mps":0,"gear_location":"GEAR_PARKING","battery_soc_percentage":null,"error_code":0}`, "0", fmt.Sprint(f.now.UnixMilli()))
	capture("parking", map[string]any{"online": true, "freshness": "fresh", "speed": 0, "gear": "GEAR_PARKING"})
	f.now = f.now.Add(time.Second)
	post(4, "mock-a", `{"speed_mps":1,"gear_location":"GEAR_REVERSE","error_code":1}`, "0", fmt.Sprint(f.now.UnixMilli()))
	capture("reverse-error-gap", map[string]any{"online": true, "freshness": "fresh", "gear": "GEAR_REVERSE", "open_alerts": 1, "marker": "gap"})
	f.now = f.now.Add(time.Second)
	post(5, "mock-a", "null", "null", "null")
	capture("missing-does-not-recover", map[string]any{"online": true, "freshness": "unknown", "open_alerts": 1, "issue": "chassis_missing"})
	f.now = f.now.Add(time.Second)
	post(6, "mock-a", `{"error_code":0}`, "20000", fmt.Sprint(f.now.UnixMilli()))
	capture("stale-does-not-recover", map[string]any{"online": true, "freshness": "stale", "open_alerts": 1, "issue": "chassis_stale"})
	f.now = f.now.Add(time.Second)
	post(7, "mock-a", `{"error_code":0}`, "0", fmt.Sprint(f.now.Add(time.Minute).UnixMilli()))
	capture("future-clock", map[string]any{"online": true, "freshness": "clock-error", "open_alerts": 1, "issue": "chassis_clock"})
	f.now = f.now.Add(time.Second)
	post(8, "mock-a", `{"speed_mps":0,"gear_location":null,"error_code":0}`, "0", fmt.Sprint(f.now.UnixMilli()))
	capture("explicit-recovery", map[string]any{"online": true, "freshness": "fresh", "open_alerts": 0, "resolved_alerts": 1})
	for i, status := range []string{"unknown", "accepted", "running", "succeeded", "failed", "canceled"} {
		mission := fmt.Sprintf(`{"mission_id":"mock-mission","status":%q,"updated_at_ms":%d,"description":"Synthetic status only"}`, status, f.now.UnixMilli()+int64(i))
		f.request(t, http.MethodPost, "/api/vehicles/car-1/mission-status", "device1", mission, 204)
		f.request(t, http.MethodPost, "/api/vehicles/car-1/mission-status", "device1", mission, 204)
		f.request(t, http.MethodPost, "/api/vehicles/car-1/mission-status", "device2", mission, 403)
		capture("mission-"+status, map[string]any{"online": true, "freshness": "fresh", "mission": status})
	}
	f.now = f.now.Add(11 * time.Second)
	capture("offline-retains-last-value", map[string]any{"online": false, "freshness": "stale", "speed": 0, "resolved_alerts": 1})
	post(1, "mock-b", `{"speed_mps":0,"error_code":2}`, "0", fmt.Sprint(f.now.UnixMilli()))
	capture("restart-new-stream", map[string]any{"online": true, "freshness": "fresh", "open_alerts": 1, "marker": "stream"})
	// Malformed values and another vehicle's credentials never enter either store.
	valid := telemetryBody("car-1", "mock-b", 2)
	for _, invalid := range []string{
		strings.Replace(valid, `"speed_mps":1.25`, `"speed_mps":"fast"`, 1),
		strings.Replace(valid, `"gear_location":"GEAR_DRIVE"`, `"gear_location":"D"`, 1),
		strings.Replace(valid, `"schema_version":1`, `"schema_version":2`, 1),
		valid + `{}`,
	} {
		f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", invalid, 400)
	}
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device2", valid, 403)
	f.request(t, http.MethodGet, "/api/vehicles/car-1/operations", "wrongtenant", "", 403)
	other := f.request(t, http.MethodGet, "/api/vehicles/car-2/operations", "observer", "", 200)
	var isolated OperationsResponse
	if err := json.Unmarshal(other.Body.Bytes(), &isolated); err != nil || len(isolated.History)+len(isolated.Alerts)+len(isolated.Missions) != 0 {
		t.Fatal("mock records crossed vehicle boundary", err)
	}
	if path := os.Getenv("PLATFORM_CONTRACT_FIXTURE"); path != "" {
		data, err := json.MarshalIndent(corpus, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
