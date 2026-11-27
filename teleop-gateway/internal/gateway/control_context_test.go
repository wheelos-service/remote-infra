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
	oldSink, oldKey, oldSecret := auditSink, lkApiKey, lkApiSecret
	controlLeases, vehicleAuthorizer, vehicleIdentities = f.api.leases, f.api.authorizer, f.api.identities
	auditSink = NewJSONAuditSink(io.Discard)
	lkApiKey, lkApiSecret = "edge-integration-test", "disposable-loopback-only-test-secret"
	t.Cleanup(func() {
		controlLeases, vehicleAuthorizer, vehicleIdentities = oldLeases, oldAuth, oldIDs
		auditSink, lkApiKey, lkApiSecret = oldSink, oldKey, oldSecret
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
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", `["car-2"]`)
	f.request(t, "POST", path+"/acquire", "controller", strings.Replace(body, "browser-test", "bad|instance", 1), 400)
	response := f.request(t, "POST", path+"/acquire", "controller", body, 200)
	var acquired controlSessionResponse
	if err := json.Unmarshal(response.Body.Bytes(), &acquired); err != nil {
		t.Fatal(err)
	}
	if acquired.ServerTimeMS <= 0 {
		t.Fatalf("acquire response missing server_time_ms: %+v", acquired)
	}
	if acquired.TimingPolicy == nil ||
		acquired.TimingPolicy.ControlTickMS >= acquired.TimingPolicy.WatchdogPauseMS ||
		acquired.TimingPolicy.WatchdogPauseMS >= acquired.TimingPolicy.RTCReconnectGraceMS ||
		acquired.TimingPolicy.RTCReconnectGraceMS >= acquired.TimingPolicy.WatchdogLockMS {
		t.Fatalf("acquire timing_policy violated ordering invariants: %+v", acquired.TimingPolicy)
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
		context.Session.ClientInstanceID != "browser-test" || context.TimingPolicy == nil ||
		context.TimingPolicy.WatchdogLockMS != 1500 {
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

func TestSimulationRenewalAndPendingHandover(t *testing.T) {
	f := newControlChainFixture(t)
	body := `{"protocol_version":2,"client_instance_id":"browser-test","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
	for _, expire := range []bool{false, true} {
		response := f.request(t, "POST", "/api/vehicles/car-2/control/acquire", "controller", body, 200)
		var acquired controlSessionResponse
		if err := json.Unmarshal(response.Body.Bytes(), &acquired); err != nil {
			t.Fatal(err)
		}
		f.redis.FastForward(4 * time.Second)
		f.request(t, "POST", "/api/control/"+acquired.Session.SessionID+"/renew", "controller", "{}", 200)
		f.redis.FastForward(2 * time.Second)
		active := f.request(t, "GET", "/api/vehicles/car-2/control/context", "device2", "", 200)
		var state DeviceControlContext
		if err := json.Unmarshal(active.Body.Bytes(), &state); err != nil || state.State != "ACTIVE" {
			t.Fatalf("renewal did not preserve authority: %s (%v)", active.Body.String(), err)
		}
		if expire {
			f.redis.FastForward(4 * time.Second)
			f.request(t, "POST", "/api/control/"+acquired.Session.SessionID+"/renew", "controller", "{}", 404)
		} else {
			f.request(t, "POST", "/api/control/"+acquired.Session.SessionID+"/release", "controller", "{}", 202)
		}
		f.request(t, "POST", "/api/vehicles/car-1/control/acquire", "controller", body, 409)
		f.request(t, "POST", "/api/vehicles/car-2/control/acquire", "controller", body, 409)
		pending := f.request(t, "GET", "/api/vehicles/car-2/control/context", "device2", "", 200)
		if err := json.Unmarshal(pending.Body.Bytes(), &state); err != nil || state.State != "PENDING" {
			t.Fatalf("missing pending handover: %s (%v)", pending.Body.String(), err)
		}
		ack := fmt.Sprintf(`{"session_id":%q,"revision":%d}`, acquired.Session.SessionID, state.Revision)
		f.request(t, "POST", "/api/vehicles/car-2/control/simulation-ack", "device2", ack, 204)
	}
	f.request(t, "POST", "/api/vehicles/car-1/control/acquire", "controller", body, 200)
}

func TestV2ControlDoesNotRequireSimulationAllowlist(t *testing.T) {
	f := newControlContextFixture(t)
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", "[]")
	body := `{"protocol_version":2,"client_instance_id":"browser-test","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
	path := "/api/vehicles/car-2/control"
	f.request(t, "POST", path+"/acquire", "device2", body, 403)
	response := f.request(t, "POST", path+"/acquire", "controller", body, 200)
	var acquired controlSessionResponse
	if err := json.Unmarshal(response.Body.Bytes(), &acquired); err != nil {
		t.Fatal(err)
	}
	f.request(t, "POST", "/api/control/"+acquired.Session.SessionID+"/renew", "controller", "{}", 200)
	result := f.request(t, "GET", path+"/context", "device2", "", 200)
	var state DeviceControlContext
	if json.Unmarshal(result.Body.Bytes(), &state) != nil || state.Simulation || state.State != "ACTIVE" || state.Session == nil || state.Session.ProtocolVersion != 2 {
		t.Fatal("non-simulation v2 context unavailable", result.Body.String())
	}
	f.request(t, "POST", "/api/control/"+acquired.Session.SessionID+"/release", "controller", "{}", 202)
	ack := fmt.Sprintf(`{"session_id":%q,"revision":%d}`, acquired.Session.SessionID, state.Revision)
	f.request(t, "POST", path+"/simulation-ack", "device2", ack, 403)
	f.request(t, "POST", path+"/handover/ack", "device2", "{}", 503)
	// Allowing Cyber sessions must not synthesize a physical handover.
	f.request(t, "POST", path+"/acquire", "controller", body, 409)
}

func newControlChainFixture(t *testing.T) *telemetryFixture {
	t.Helper()
	f := newControlContextFixture(t)
	f.api.leases.ttl = 5 * time.Second
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
	registerStaticOrganizationContext(f.mux, f.api.registry, vehicleAuthorizer)
	f.mux.Handle("GET /api/auth/me", AuthenticationMiddleware(http.HandlerFunc(handleAuthMe)))
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
	return f
}

// The acceptance runner starts real HTTP handlers and Redis Lua semantics in
// an isolated process; only OAuth identities are disposable test fixtures.
func TestControlChainServer(t *testing.T) {
	output := os.Getenv("CONTROL_CHAIN_FIXTURE")
	if output == "" {
		t.Skip("run tests/control-chain.py")
	}
	f := newControlChainFixture(t)
	server := httptest.NewServer(f.mux)
	defer server.Close()
	data, _ := json.Marshal(map[string]string{"gateway_url": server.URL})
	if err := os.WriteFile(output, data, 0600); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(90 * time.Second)
	lastTick := time.Now()
	for time.Now().Before(until) {
		if _, err := os.Stat(output + ".stop"); err == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
		now := time.Now()
		f.redis.FastForward(now.Sub(lastTick))
		lastTick = now
	}
	t.Fatal("control chain runner did not stop fixture")
}

func TestNativeBenchControlAndHandover(t *testing.T) {
	f := newControlContextFixture(t)
	path := "/api/vehicles/car-2/control"
	instance := "0123456789abcdef0123456789abcdef"
	other := "1123456789abcdef0123456789abcdef"
	body := `{"contract_version":3,"protocol_version":2,"client_instance_id":"bench-test","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
	f.request(t, "GET", path+"/bench-clock", "controller", "", 403)
	f.request(t, "POST", path+"/acquire", "controller", body, 503)
	t.Setenv("NATIVE_BENCH_VEHICLES_JSON", `["car-2"]`)
	f.request(t, "GET", path+"/bench-clock", "device1", "", 403)
	f.request(t, "GET", path+"/bench-clock", "controller", "", 200)
	f.request(t, "GET", path+"/context/native-v3-percent/"+instance, "device1", "", 403)
	f.request(t, "GET", path+"/context", "device2", "", 200)
	f.request(t, "POST", path+"/acquire", "controller", body, 503)
	poll := func() {
		t.Helper()
		r := f.request(t, "GET", path+"/context/native-v3-percent/"+instance, "device2", "", 200)
		var v map[string]any
		if json.Unmarshal(r.Body.Bytes(), &v) != nil || v["contract_version"] != 3.0 || v["simulation"] != nil || v["timing_policy"] == nil {
			t.Fatal("unexpected receiver contract", v)
		}
	}
	poll()
	clock := f.request(t, "GET", path+"/bench-clock", "controller", "", 200)
	var ready struct {
		TTL int64 `json:"receiver_ttl_ms"`
	}
	if json.Unmarshal(clock.Body.Bytes(), &ready) != nil || ready.TTL <= 0 || ready.TTL > 5000 {
		t.Fatal("receiver readiness missing")
	}
	f.redis.FastForward(6 * time.Second)
	f.request(t, "POST", path+"/acquire", "controller", body, 503)
	poll()
	r := f.request(t, "POST", path+"/acquire", "controller", body, 200)
	var sess controlSessionResponse
	if json.Unmarshal(r.Body.Bytes(), &sess) != nil || sess.Session.ReceiverInstanceID != instance {
		t.Fatal("unbound session")
	}
	pathID := "/api/control/" + sess.Session.SessionID
	ack := fmt.Sprintf(`{"revision":1,"session_id":%q,"edge_revocation_applied":true,"vehicle_handover_confirmed":true}`, sess.Session.SessionID)
	f.request(t, "POST", path+"/handover/ack/"+instance, "device2", ack, 409)
	f.request(t, "POST", pathID+"/renew", "controller", "{}", 200)
	f.request(t, "POST", pathID+"/release", "controller", "{}", 202)
	f.request(t, "POST", path+"/handover/ack/"+other, "device2", ack, 409)
	f.request(t, "POST", path+"/handover/ack/"+instance, "device2", strings.Replace(ack, `"revision":1`, `"revision":2`, 1), 409)
	f.request(t, "POST", path+"/handover/ack/"+instance, "device2", strings.Replace(ack, `confirmed":true`, `confirmed":false`, 1), 202)
	f.request(t, "POST", path+"/acquire", "controller", body, 409)
	f.request(t, "POST", path+"/handover/ack/"+instance, "device2", ack, 204)
	f.request(t, "POST", path+"/handover/ack/"+instance, "device2", ack, 204)
	f.request(t, "POST", path+"/acquire", "controller", body, 200)
}

func TestNativeHandbackAfterRestartBeforeRevocation(t *testing.T) {
	for _, lostBrowser := range []bool{false, true} {
		name := "explicit release"
		if lostBrowser {
			name = "browser lost before release"
		}
		t.Run(name, func(t *testing.T) {
			f := newControlContextFixture(t)
			t.Setenv("NATIVE_BENCH_VEHICLES_JSON", `["car-2"]`)
			const path = "/api/vehicles/car-2/control"
			const original = "0123456789abcdef0123456789abcdef"
			const replacement = "1123456789abcdef0123456789abcdef"
			const acquire = `{"contract_version":3,"protocol_version":2,"client_instance_id":"first-tab","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
			poll := func(instance string) DeviceControlContext {
				t.Helper()
				r := f.request(t, "GET", path+"/context/native-v3-percent/"+instance, "device2", "", 200)
				var c DeviceControlContext
				if err := json.Unmarshal(r.Body.Bytes(), &c); err != nil {
					t.Fatal(err)
				}
				return c
			}
			blocker := func(want string) {
				t.Helper()
				r := f.request(t, "GET", path+"/bench-clock", "controller", "", 200)
				var b struct {
					Blocker string `json:"control_request_blocker"`
				}
				if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil || b.Blocker != want {
					t.Fatalf("blocker %q, want %q: %v", b.Blocker, want, err)
				}
			}
			poll(original)
			f.request(t, "POST", path+"/acquire", "controller", acquire, 200)
			active := poll(original)
			report := func(instance string, confirmed bool, code int) {
				t.Helper()
				body := fmt.Sprintf(`{"revision":%d,"session_id":%q,"edge_revocation_applied":true,"vehicle_handover_confirmed":%t}`, active.Revision, active.SessionID, confirmed)
				f.request(t, "POST", path+"/handover/ack/"+instance, "device2", body, code)
			}
			poll(replacement)
			report(replacement, false, 409)
			if lostBrowser {
				f.redis.FastForward(f.api.leases.ttl + time.Millisecond)
			} else {
				f.request(t, "POST", "/api/control/"+active.SessionID+"/release", "controller", "{}", 202)
			}

			const revision = 1
			pending := poll(replacement)
			if pending.State != "PENDING" || pending.SessionID != active.SessionID || pending.Revision != revision || pending.Session != nil {
				t.Fatalf("replacement received incorrect revocation context: %+v", pending)
			}
			now := time.Unix(1730000000, 0)
			f.redis.SetTime(now)
			blocker("awaiting_revocation")
			report(replacement, true, 409)
			report(replacement, false, 409)
			drain := time.Duration(defaultControlTimingPolicy().ContextTTLMS+handoverEvidenceMaxAgeMS) * time.Millisecond
			f.redis.SetTime(now.Add(drain - time.Millisecond))
			report(replacement, false, 409)
			f.redis.SetTime(now.Add(drain))
			report(replacement, true, 409)
			report(replacement, false, 202)
			blocker("awaiting_vehicle")
			f.request(t, "POST", path+"/acquire", "controller", acquire, 409)
			report(original, true, 409)
			report(replacement, true, 204)
			report(replacement, true, 204)
			blocker("")
			f.request(t, "POST", path+"/acquire", "controller", strings.Replace(acquire, "first-tab", "new-tab", 1), 200)
			if next := poll(replacement); next.State != "ACTIVE" || next.Revision != revision+1 || next.SessionID == active.SessionID {
				t.Fatalf("new browser acquired incorrect session: %+v", next)
			}
			report(replacement, true, 409)
		})
	}
}
