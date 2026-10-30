package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

type telemetryTestAuthenticator map[string]*UserClaims

func (a telemetryTestAuthenticator) Authenticate(_ context.Context, token string) (*UserClaims, error) {
	if claims, ok := a[token]; ok {
		return claims, nil
	}
	return nil, ErrInvalidToken
}

type telemetryFixture struct {
	api    *VehicleTelemetryAPI
	mux    *http.ServeMux
	redis  *miniredis.Miniredis
	client *redis.Client
	now    time.Time
}

func newTelemetryFixture(t *testing.T) *telemetryFixture {
	t.Helper()
	t.Setenv("VEHICLE_REGISTRY_JSON", `[{"vehicle_id":"car-1","name":"First"},{"vehicle_id":"car-2","name":"Second"}]`)
	registry, err := NewVehicleRegistryFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	authorizer, err := NewVehicleAuthorizer([]VehicleACL{
		{UserID: "alice", TenantID: "tenant-a", VehicleID: "car-1", Permissions: []VehiclePermission{ObservePermission}},
		{UserID: "alice", TenantID: "tenant-a", VehicleID: "car-2", Permissions: []VehiclePermission{ControlPermission}},
		{UserID: "alice", TenantID: "tenant-a", VehicleID: "not-registered", Permissions: []VehiclePermission{ObservePermission}},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr(), MaxRetries: -1})
	t.Cleanup(func() { _ = client.Close() })
	fixture := &telemetryFixture{
		redis: server, client: client, mux: http.NewServeMux(), now: time.UnixMilli(1700000000000),
	}
	fixture.api = &VehicleTelemetryAPI{
		registry: registry, authorizer: authorizer,
		identities: &VehicleIdentityResolver{bySubject: map[string]string{
			"device-1": "car-1", "device-2": "car-2", "device-3": "not-registered",
		}},
		states: NewVehicleTelemetryStore(client, func() time.Time { return fixture.now }),
		leases: &ControlLeaseStore{client: client, ttl: time.Minute},
	}
	previous := authenticator
	authenticator = telemetryTestAuthenticator{
		"observer":    {Name: "alice", Organization: "tenant-a", Roles: []string{"observer"}},
		"controller":  {Name: "alice", Organization: "tenant-a", Roles: []string{"controller"}},
		"wrongtenant": {Name: "alice", Organization: "tenant-b", Roles: []string{"observer"}},
		"denied":      {Name: "bob", Organization: "tenant-a", Roles: []string{"observer"}},
		"roleless":    {Name: "alice", Organization: "tenant-a"},
		"device1":     {Name: "device-1", Organization: "devices", Roles: []string{"vehicle"}},
		"device2":     {Name: "device-2", Organization: "devices", Roles: []string{"vehicle"}},
		"device3":     {Name: "device-3", Organization: "devices", Roles: []string{"vehicle"}},
		"spoof":       {Name: "car-1", Organization: "devices", Roles: []string{"vehicle"}},
	}
	t.Cleanup(func() { authenticator = previous })
	fixture.api.register(fixture.mux)
	return fixture
}

func (f *telemetryFixture) request(t *testing.T, method, path, token, body string, status int) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	f.mux.ServeHTTP(recorder, request)
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("vehicle telemetry response must disable caching, including errors")
	}
	if recorder.Code != status {
		t.Fatalf("%s %s => %d (%s), want %d", method, path, recorder.Code, recorder.Body.String(), status)
	}
	return recorder
}

func telemetryBody(vehicle, stream string, sequence int64) string {
	return fmt.Sprintf(`{"schema_version":1,"type":"vehicle_telemetry","vehicle_id":%q,"stream_id":%q,"sequence":%d,"published_at_ms":1,"chassis":{"age_ms":50000,"source_timestamp_ms":11,"source_sequence":0,"message":{"speed_mps":1.25,"gear_location":"GEAR_DRIVE","steering_percentage":-100,"battery_soc_percentage":null,"parking_brake":false}},"localization":{"age_ms":null,"source_timestamp_ms":null,"source_sequence":null,"message":null}}`,
		vehicle, stream, sequence)
}

func (f *telemetryFixture) get(t *testing.T, vehicle string) vehicleStateResponse {
	t.Helper()
	response := f.request(t, http.MethodGet, "/api/vehicles/"+vehicle+"/state", "observer", "", http.StatusOK)
	var state vehicleStateResponse
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestVehicleRegistryValidation(t *testing.T) {
	for _, raw := range []string{
		`null`, `{}`, `[null]`, `[{"vehicle_id":"car-1","name":""}]`,
		`[{"vehicle_id":"bad/id","name":"Bad"}]`,
		`[{"vehicle_id":"car-1","name":"One"},{"vehicle_id":"car-1","name":"Duplicate"}]`,
		`[{"vehicle_id":"car-1","name":"One","tenant":"ignored"}]`,
		`[{"vehicle_id":"car-1","name":"One","name":"Two"}]`,
		`[] {}`, `[{"name":"Missing ID"}]`, `[{"vehicle_id":"car-1","name":null}]`,
	} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv("VEHICLE_REGISTRY_JSON", raw)
			if _, err := NewVehicleRegistryFromEnvironment(); err == nil {
				t.Fatal("invalid registry accepted")
			}
		})
	}
	for _, raw := range []string{"", "[]"} {
		t.Setenv("VEHICLE_REGISTRY_JSON", raw)
		registry, err := NewVehicleRegistryFromEnvironment()
		if err != nil || len(registry.vehicles) != 0 {
			t.Fatalf("empty registry = %#v, %v", registry, err)
		}
	}
}

func TestVehicleTelemetryAuthenticationAndACL(t *testing.T) {
	f := newTelemetryFixture(t)
	for _, path := range []string{"/api/vehicles", "/api/vehicles/car-1/state"} {
		f.request(t, http.MethodGet, path, "", "", http.StatusUnauthorized)
		f.request(t, http.MethodGet, path, "invalid", "", http.StatusUnauthorized)
		f.request(t, http.MethodGet, path, "roleless", "", http.StatusForbidden)
		f.request(t, http.MethodGet, path, "device1", "", http.StatusForbidden)
	}
	for _, token := range []string{"wrongtenant", "denied"} {
		f.request(t, http.MethodGet, "/api/vehicles/car-1/state", token, "", http.StatusForbidden)
		result := f.request(t, http.MethodGet, "/api/vehicles", token, "", http.StatusOK)
		if strings.TrimSpace(result.Body.String()) != `{"vehicles":[]}` {
			t.Fatalf("unauthorized list leaks vehicles: %s", result.Body.String())
		}
	}
	f.request(t, http.MethodGet, "/api/vehicles/not-registered/state", "observer", "", http.StatusNotFound)
	f.request(t, http.MethodGet, "/api/vehicles/car-2/state", "controller", "", http.StatusOK)
	body := telemetryBody("car-1", "stream-a", 1)
	for _, token := range []string{"observer", "device2", "spoof"} {
		f.request(t, http.MethodPost, "/api/vehicles/car-1/state", token, body, http.StatusForbidden)
	}
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "", body, http.StatusUnauthorized)
	f.request(t, http.MethodPost, "/api/vehicles/not-registered/state", "device3", telemetryBody("not-registered", "a", 1), http.StatusNotFound)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-2", "a", 1), http.StatusForbidden)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", body, http.StatusNoContent)

	delete(f.api.registry.byID, "car-1")
	f.api.registry.vehicles = nil
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", body, http.StatusNotFound)
	result := f.request(t, http.MethodGet, "/api/vehicles", "observer", "", http.StatusOK)
	if strings.TrimSpace(result.Body.String()) != `{"vehicles":[]}` {
		t.Fatal("stored telemetry must not register vehicles")
	}
}

func TestVehicleTelemetryStrictInput(t *testing.T) {
	f := newTelemetryFixture(t)
	base := telemetryBody("car-1", "stream-a", 1)
	cases := map[string]string{
		"null":                 `null`,
		"empty":                `{}`,
		"trailing JSON":        base + `{}`,
		"trailing garbage":     base + `broken`,
		"unknown root":         strings.Replace(base, `"schema_version":1`, `"extra":1,"schema_version":1`, 1),
		"wrong schema":         strings.Replace(base, `"schema_version":1`, `"schema_version":2`, 1),
		"null schema":          strings.Replace(base, `"schema_version":1`, `"schema_version":null`, 1),
		"wrong type":           strings.Replace(base, `"vehicle_telemetry"`, `"vehicle.state"`, 1),
		"missing root":         strings.Replace(base, `"published_at_ms":1,`, "", 1),
		"null sequence":        strings.Replace(base, `"sequence":1`, `"sequence":null`, 1),
		"fraction sequence":    strings.Replace(base, `"sequence":1`, `"sequence":1.1`, 1),
		"sequence too large":   strings.Replace(base, `"sequence":1`, `"sequence":9007199254740992`, 1),
		"sequence zero":        strings.Replace(base, `"sequence":1`, `"sequence":0`, 1),
		"publish zero":         strings.Replace(base, `"published_at_ms":1`, `"published_at_ms":0`, 1),
		"invalid stream":       strings.Replace(base, `"stream-a"`, `"bad/stream"`, 1),
		"unknown sample field": strings.Replace(base, `"age_ms":50000`, `"extra":1,"age_ms":50000`, 1),
		"missing nullable":     strings.Replace(base, `"source_timestamp_ms":null,`, "", 1),
		"negative age":         strings.Replace(base, `"age_ms":50000`, `"age_ms":-1`, 1),
		"fraction age":         strings.Replace(base, `"age_ms":50000`, `"age_ms":0.5`, 1),
		"source time zero":     strings.Replace(base, `"source_timestamp_ms":11`, `"source_timestamp_ms":0`, 1),
		"source sequence":      strings.Replace(base, `"source_sequence":0`, `"source_sequence":4294967296`, 1),
		"unknown chassis":      strings.Replace(base, `"speed_mps":1.25`, `"unknown":true`, 1),
		"speed string":         strings.Replace(base, `"speed_mps":1.25`, `"speed_mps":"1.25"`, 1),
		"bad gear":             strings.Replace(base, `"GEAR_DRIVE"`, `"DRIVE"`, 1),
		"bad driving mode":     strings.Replace(base, `"speed_mps":1.25`, `"driving_mode":"AUTO"`, 1),
		"steering range":       strings.Replace(base, `"steering_percentage":-100`, `"steering_percentage":-100.1`, 1),
		"throttle range":       strings.Replace(base, `"speed_mps":1.25`, `"throttle_percentage":101`, 1),
		"brake range":          strings.Replace(base, `"speed_mps":1.25`, `"brake_percentage":-1`, 1),
		"battery range":        strings.Replace(base, `"battery_soc_percentage":null`, `"battery_soc_percentage":100.1`, 1),
		"parking type":         strings.Replace(base, `"parking_brake":false`, `"parking_brake":0`, 1),
		"error code":           strings.Replace(base, `"speed_mps":1.25`, `"error_code":10`, 1),
		"error mask":           strings.Replace(base, `"speed_mps":1.25`, `"chassis_error_mask":2147483648`, 1),
		"fraction integer":     strings.Replace(base, `"sequence":1`, `"sequence":9007199254740991.1`, 1),
		"huge exponent":        strings.Replace(base, `"sequence":1`, `"sequence":1e9999999999999999999999`, 1),
		"tiny exponent":        strings.Replace(base, `"sequence":1`, `"sequence":1e-9999999999999999999999`, 1),
		"tiny negative brake":  strings.Replace(base, `"speed_mps":1.25`, `"brake_percentage":-1e-9999999999999999999999`, 1),
		"precise range":        strings.Replace(base, `"speed_mps":1.25`, `"throttle_percentage":100.000000000000000000000001`, 1),
		"speed overflow":       strings.Replace(base, `"speed_mps":1.25`, `"speed_mps":1e9999`, 1),
		"speed underflow":      strings.Replace(base, `"speed_mps":1.25`, `"speed_mps":1e-9999`, 1),
		"duplicate root":       strings.Replace(base, `"sequence":1`, `"sequence":2,"sequence":1`, 1),
		"duplicate sample":     strings.Replace(base, `"age_ms":50000`, `"age_ms":1,"age_ms":50000`, 1),
		"duplicate message":    strings.Replace(base, `"speed_mps":1.25`, `"speed_mps":1,"speed_mps":1.25`, 1),
		"escaped duplicate":    strings.Replace(base, `"speed_mps":1.25`, `"speed_mps":1,"speed_\u006dps":1.25`, 1),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", raw, http.StatusBadRequest)
		})
	}
	for name, message := range map[string]string{
		"unknown localization": `{"unknown":1}`,
		"position field":       `{"position":{"latitude":1}}`,
		"position type":        `{"position":[]}`,
		"position coordinate":  `{"position":{"x":"1"}}`,
		"heading type":         `{"heading_rad":true}`,
		"frame type":           `{"frame_id":1}`,
		"frame length":         `{"frame_id":"` + strings.Repeat("a", 129) + `"}`,
		"coordinate overflow":  `{"position":{"x":1e9999}}`,
		"heading underflow":    `{"heading_rad":1e-9999}`,
		"duplicate coordinate": `{"position":{"x":1,"x":2}}`,
	} {
		t.Run(name, func(t *testing.T) {
			raw := strings.Replace(base, `"source_sequence":null,"message":null`, `"source_sequence":null,"message":`+message, 1)
			f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", raw, http.StatusBadRequest)
		})
	}
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", base+strings.Repeat(" ", maxVehicleTelemetryBytes), http.StatusRequestEntityTooLarge)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", base+strings.Repeat(" ", maxVehicleTelemetryBytes-len(base)), http.StatusNoContent)
}

func TestVehicleTelemetryNullableAndOptionalSchemaFields(t *testing.T) {
	sample := `{"age_ms":null,"source_timestamp_ms":null,"source_sequence":null,"message":%s}`
	for _, message := range []string{
		`null`, `{}`, `{"speed_mps":null,"driving_mode":null,"gear_location":null,"parking_brake":null,"error_code":null,"chassis_error_mask":null}`,
		`{"throttle_percentage":100,"brake_percentage":0,"error_code":9,"chassis_error_mask":-2147483648}`,
		`{"brake_percentage":1e-300,"chassis_error_mask":0e9999999999999999999999}`,
	} {
		raw := fmt.Sprintf(`{"schema_version":1.0,"type":"vehicle_telemetry","vehicle_id":"car-1","stream_id":"a","sequence":1e0,"published_at_ms":9007199254740991,"chassis":%s,"localization":%s}`,
			fmt.Sprintf(sample, message), fmt.Sprintf(sample, `{"position":{"x":null,"y":1.25},"heading_rad":null,"frame_id":"map"}`))
		if _, err := validateVehicleTelemetry([]byte(raw)); err != nil {
			t.Fatalf("valid nullable/optional fields rejected: %v", err)
		}

	}
}

func TestVehicleTelemetryExternalFixture(t *testing.T) {
	path := os.Getenv("TELEMETRY_FIXTURE")
	if path == "" {
		t.Skip("set TELEMETRY_FIXTURE to an actual C++ telemetry snapshot JSON file")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > maxVehicleTelemetryBytes {
		t.Fatal("C++ telemetry fixture exceeds HTTP body limit")
	}
	state, err := validateVehicleTelemetry(raw)
	if err != nil {
		t.Fatalf("C++ telemetry fixture violates gateway contract: %v", err)
	}
	t.Logf("validated C++ telemetry: vehicle=%s stream=%s sequence=%d", state.VehicleID, state.StreamID, state.Sequence)
}

func TestVehicleTelemetrySnapshotsAndControlSummary(t *testing.T) {
	f := newTelemetryFixture(t)
	initial := f.get(t, "car-1")
	if string(initial.State) != "null" || initial.ReceivedAtMS != nil || initial.Online || initial.Control.Status != "free" {
		t.Fatalf("missing state must not be fresh: %#v", initial)
	}
	body := telemetryBody("car-1", "stream-a", 1)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", body, http.StatusNoContent)
	state := f.get(t, "car-1")
	if !state.Online || state.ReceivedAtMS == nil || *state.ReceivedAtMS != f.now.UnixMilli() || state.ServerTimeMS != f.now.UnixMilli() {
		t.Fatalf("receipt freshness incorrect: %#v", state)
	}
	var expected, actual any
	_ = json.Unmarshal([]byte(body), &expected)
	_ = json.Unmarshal(state.State, &actual)
	if !reflect.DeepEqual(expected, actual) {
		t.Fatal("source timestamps or envelope changed")
	}
	other := f.get(t, "car-2")
	if string(other.State) != "null" || other.Online {
		t.Fatal("state crossed vehicle boundary")
	}
	f.now = f.now.Add(10 * time.Second)
	if !f.get(t, "car-1").Online {
		t.Fatal("10-second receipt boundary should remain online")
	}
	f.now = f.now.Add(time.Millisecond)
	f.redis.FastForward(30 * 24 * time.Hour)
	offline := f.get(t, "car-1")
	if offline.Online || offline.State == nil || *offline.ReceivedAtMS != *state.ReceivedAtMS {
		t.Fatal("offline snapshot must remain stored with original receipt timestamp")
	}
	session := newTestControlSession("car-1", "alice", "secret-session", time.Minute)
	session.OperatorTenant = "tenant-a"
	session.CreatedAtMS = f.now.UnixMilli()
	session.ExpiresAtMS = f.now.Add(time.Minute).UnixMilli()
	if err := f.api.leases.AcquireControlSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	occupied := f.get(t, "car-1")
	if occupied.Control.Status != "occupied" || !occupied.Control.IsSelf {
		t.Fatalf("control summary = %#v", occupied.Control)
	}
	session.OperatorID = "another-operator"
	raw, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.client.Set(context.Background(), controlLeaseKey("car-1"), raw, time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	if summary := f.get(t, "car-1").Control; summary.Status != "occupied" || summary.IsSelf {
		t.Fatalf("another operator's lease = %#v", summary)
	}
	response := f.request(t, http.MethodGet, "/api/vehicles", "observer", "", http.StatusOK)
	for _, secret := range []string{"secret-session", "public_key", "operator_id", "expires_at", "session_id"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatalf("list leaked control session detail %q", secret)
		}
	}
	var list struct{ Vehicles []vehicleStateResponse }
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil || len(list.Vehicles) != 2 || list.Vehicles[0].Name != "First" {
		t.Fatalf("registered list: %s, error %v", response.Body.String(), err)
	}
	if err := f.client.Set(context.Background(), controlLeaseKey("car-2"), "legacy-owner", 0).Err(); err != nil {
		t.Fatal(err)
	}
	if f.get(t, "car-2").Control.Status != "unknown" {
		t.Fatal("legacy lease should not claim control is free")
	}
	f.api.leases = nil
	if f.get(t, "car-1").Control.Status != "unknown" {
		t.Fatal("unconfigured control store should be unknown")
	}
}

func TestVehicleTelemetryStreamOrdering(t *testing.T) {
	f := newTelemetryFixture(t)
	post := func(stream string, sequence int64, status int) {
		t.Helper()
		f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-1", stream, sequence), status)
	}
	post("a", 1, http.StatusNoContent)
	post("a", 1, http.StatusConflict)
	post("a", 3, http.StatusNoContent)
	post("a", 2, http.StatusConflict)
	post("b", 1, http.StatusConflict)
	f.now = f.now.Add(10 * time.Second)
	post("b", 1, http.StatusConflict)
	f.now = f.now.Add(time.Millisecond)
	post("b", 1, http.StatusNoContent)
	post("a", 4, http.StatusConflict)
	f.now = f.now.Add(30 * 24 * time.Hour)
	f.redis.FastForward(30 * 24 * time.Hour)
	post("a", 100, http.StatusConflict)
	post("b", 2, http.StatusNoContent)
	state := f.get(t, "car-1")
	validated, err := validateVehicleTelemetry(state.State)
	if err != nil || validated.StreamID != "b" || validated.Sequence != 2 {
		t.Fatalf("rejected packets replaced stored state: %s, %v", state.State, err)
	}
	f.now = f.now.Add(-time.Millisecond)
	post("b", 3, http.StatusConflict)
}

func TestVehicleTelemetryRetiredStreamsFailClosed(t *testing.T) {
	f := newTelemetryFixture(t)
	for i := 0; i <= maxRetiredStreams; i++ {
		f.now = f.now.Add(vehicleOnlineWindow + time.Millisecond)
		f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-1", fmt.Sprintf("stream-%d", i), 1), http.StatusNoContent)
	}
	f.now = f.now.Add(vehicleOnlineWindow + time.Millisecond)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-1", "overflow", 1), http.StatusConflict)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-1", "stream-0", 2), http.StatusConflict)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-1", fmt.Sprintf("stream-%d", maxRetiredStreams), 2), http.StatusNoContent)
	if count, err := f.client.HLen(context.Background(), vehicleTelemetryKey("car-1")).Result(); err != nil || count != maxRetiredStreams+5 {
		t.Fatalf("bounded stream history: %d fields, %v", count, err)
	}
}

func TestVehicleTelemetryMultiInstanceAtomicity(t *testing.T) {
	f := newTelemetryFixture(t)
	client := redis.NewClient(&redis.Options{Addr: f.redis.Addr()})
	defer client.Close()
	other := NewVehicleTelemetryStore(client, func() time.Time { return f.now })
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, store := range []*VehicleTelemetryStore{f.api.states, other} {
		wg.Add(1)
		go func(store *VehicleTelemetryStore) {
			defer wg.Done()
			state, err := validateVehicleTelemetry([]byte(telemetryBody("car-1", "stream-a", maxTelemetryInteger)))
			if err == nil {
				err = store.Save(context.Background(), state)
			}
			results <- err
		}(store)
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, errTelemetryConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("multi-instance writes: %d successes, %d conflicts", successes, conflicts)
	}
}

func TestVehicleTelemetryStorageFailures(t *testing.T) {
	for _, key := range []string{vehicleTelemetryKey("car-1"), controlLeaseKey("car-1")} {
		t.Run(key, func(t *testing.T) {
			f := newTelemetryFixture(t)
			if key == vehicleTelemetryKey("car-1") {
				if err := f.client.Set(context.Background(), key, "wrong-type", 0).Err(); err != nil {
					t.Fatal(err)
				}
				f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-1", "a", 1), http.StatusServiceUnavailable)
			} else {
				if err := f.client.HSet(context.Background(), key, "wrong", "type").Err(); err != nil {
					t.Fatal(err)
				}
			}
			f.request(t, http.MethodGet, "/api/vehicles/car-1/state", "observer", "", http.StatusServiceUnavailable)
			f.request(t, http.MethodGet, "/api/vehicles", "observer", "", http.StatusServiceUnavailable)
		})
	}
	t.Run("disconnected", func(t *testing.T) {
		f := newTelemetryFixture(t)
		_ = f.client.Close()
		f.request(t, http.MethodPost, "/api/vehicles/car-1/state", "device1", telemetryBody("car-1", "a", 1), http.StatusServiceUnavailable)
		f.request(t, http.MethodGet, "/api/vehicles", "observer", "", http.StatusServiceUnavailable)
	})
}
