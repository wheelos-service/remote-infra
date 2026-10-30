package gateway

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func newControlContextFixture(t *testing.T) *telemetryFixture {
	t.Helper()
	f := newTelemetryFixture(t)
	oldLeases, oldAuth, oldIDs := controlLeases, vehicleAuthorizer, vehicleIdentities
	oldVideo, oldSink, oldKey, oldSecret := videoSessions, auditSink, lkApiKey, lkApiSecret
	controlLeases, vehicleAuthorizer, vehicleIdentities = f.api.leases, f.api.authorizer, f.api.identities
	videoSessions = NewVideoSessionStore(f.client, 0)
	auditSink = NewJSONAuditSink(io.Discard)
	lkApiKey, lkApiSecret = "edge-integration-test", "disposable-loopback-only-test-secret"
	t.Cleanup(func() {
		controlLeases, vehicleAuthorizer, vehicleIdentities = oldLeases, oldAuth, oldIDs
		videoSessions, auditSink, lkApiKey, lkApiSecret = oldVideo, oldSink, oldKey, oldSecret
	})
	for pattern, handler := range map[string]http.HandlerFunc{
		"POST /api/vehicles/{vehicle_id}/control/acquire": handleAcquireControl,
		"POST /api/control/{session_id}/renew":            handleRenewControl,
		"POST /api/control/{session_id}/release":          handleReleaseControl,
	} {
		f.mux.Handle(pattern, vehicleTelemetryNoStore(AuthenticationMiddleware(handler)))
	}
	registerDeviceControl(f.mux)
	registerControlHandover(f.mux)
	t.Setenv("CONTROL_HANDOVER_ACK_ENABLED", "false")
	return f
}

func TestDeviceControlContextAndSimulationFence(t *testing.T) {
	f := newControlContextFixture(t)
	body := `{"protocol_version":2,"client_instance_id":"browser-test","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
	path := "/api/vehicles/car-2/control"
	f.request(t, "POST", path+"/acquire", "controller", body, 403)
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", `["car-2"]`)
	f.request(t, "POST", path+"/acquire", "controller", strings.Replace(body, "browser-test", "bad|instance", 1), 400)
	response := f.request(t, "POST", path+"/acquire", "controller", body, 200)
	var acquired controlSessionResponse
	if err := json.Unmarshal(response.Body.Bytes(), &acquired); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(acquired.Token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var jwt struct {
		Subject string `json:"sub"`
	}
	if json.Unmarshal(payload, &jwt) != nil || jwt.Subject != "control-"+acquired.Session.SessionID {
		t.Fatal("v2 RTC identity must be session-specific", string(payload))
	}
	f.request(t, "GET", path+"/context", "controller", "", 403)
	f.request(t, "GET", path+"/context", "device1", "", 403)
	result := f.request(t, "GET", path+"/context", "device2", "", 200)
	var context DeviceControlContext
	if json.Unmarshal(result.Body.Bytes(), &context) != nil || context.State != "ACTIVE" ||
		context.TTLMS <= 0 || context.Revision != 1 || context.Session == nil ||
		context.Session.ClientInstanceID != "browser-test" {
		t.Fatal("invalid active context", result.Body.String())
	}
	ack := fmt.Sprintf(`{"session_id":%q,"revision":1}`, acquired.Session.SessionID)
	f.request(t, "POST", path+"/simulation-ack", "device2", ack, 409)
	f.request(t, "POST", "/api/control/"+acquired.Session.SessionID+"/release", "controller", "{}", 202)
	for _, invalid := range []string{ack + "{}", strings.Replace(ack, `"revision":1`, `"revision":1,"revision":1`, 1), `{"session_id":"x","revision":2}`} {
		status := 400
		if strings.Contains(invalid, `"x"`) {
			status = 409
		}
		f.request(t, "POST", path+"/simulation-ack", "device2", invalid, status)
	}
	f.request(t, "POST", path+"/handover/ack", "device2", "{}", 503)
	f.request(t, "POST", path+"/simulation-ack", "device1", ack, 403)
	f.request(t, "POST", path+"/simulation-ack", "device2", ack, 204)
	f.request(t, "POST", path+"/simulation-ack", "device2", ack, 204)
	result = f.request(t, "GET", path+"/context", "device2", "", 200)
	if json.Unmarshal(result.Body.Bytes(), &context) != nil || context.State != "CONFIRMED" || context.Session != nil {
		t.Fatal("simulation did not clear fence", result.Body.String())
	}
	f.request(t, "POST", path+"/acquire", "controller", body, 200)
	f.redis.FastForward(time.Minute + time.Second)
	result = f.request(t, "GET", path+"/context", "device2", "", 200)
	if json.Unmarshal(result.Body.Bytes(), &context) != nil || context.State != "PENDING" || context.Revision != 2 || context.Session != nil {
		t.Fatal("expired lease did not retain revision fence", result.Body.String())
	}
}

// The acceptance runner starts real HTTP handlers and Redis Lua semantics in
// an isolated process; only OAuth identities are disposable test fixtures.
func TestControlChainServer(t *testing.T) {
	output := os.Getenv("CONTROL_CHAIN_FIXTURE")
	if output == "" {
		t.Skip("run tests/control-chain.py")
	}
	f := newControlContextFixture(t)
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", `["car-1","car-2"]`)
	var err error
	vehicleAuthorizer, err = NewVehicleAuthorizer([]VehicleACL{
		{UserID: "alice", TenantID: "tenant-a", VehicleID: "car-1", Permissions: []VehiclePermission{ControlPermission}},
		{UserID: "alice", TenantID: "tenant-a", VehicleID: "car-2", Permissions: []VehiclePermission{ControlPermission}},
	})
	if err != nil {
		t.Fatal(err)
	}
	api := &ViewingLeaseAPI{store: &ViewingLeaseStore{client: f.client}, registry: f.api.registry,
		authorizer: vehicleAuthorizer, identities: f.api.identities}
	api.register(f.mux)
	f.mux.Handle("GET /api/token/vehicle", AuthenticationMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := r.Context().Value("user").(*UserClaims)
		if !vehicleSelfMatches(claims, "car-2", vehicleIdentities) {
			http.Error(w, "forbidden", 403)
			return
		}
		token, err := issueVehicleToken("car-2")
		if err != nil {
			t.Error(err)
			http.Error(w, "token unavailable", 503)
			return
		}
		writeJSON(w, 200, map[string]string{"token": token})
	})))
	f.mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"access_token": "device2", "expires_in": 60})
	})
	server := httptest.NewServer(f.mux)
	defer server.Close()
	data, _ := json.Marshal(map[string]string{"gateway_url": server.URL})
	if err := os.WriteFile(output, data, 0600); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(90 * time.Second)
	for time.Now().Before(until) {
		if _, err := os.Stat(output + ".stop"); err == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("control chain runner did not stop fixture")
}
