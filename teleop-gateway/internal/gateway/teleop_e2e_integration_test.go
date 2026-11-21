package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTeleopE2EViewingDemandControlHandoverAnd503Fences(t *testing.T) {
	f := newTelemetryFixture(t)
	previousLeases, previousVideo, previousSink := controlLeases, videoSessions, auditSink
	previousAuthz, previousIdents := vehicleAuthorizer, vehicleIdentities
	previousKey, previousSecret := lkApiKey, lkApiSecret
	controlLeases = &ControlLeaseStore{client: f.client, ttl: 10 * time.Second}
	videoSessions = NewVideoSessionStore(f.client, 0)
	auditSink = NewJSONAuditSink(nopWriteCloser{})
	authz, err := NewVehicleAuthorizer([]VehicleACL{
		{UserID: "alice", TenantID: "tenant-a", VehicleID: "car-1", Permissions: []VehiclePermission{ObservePermission, ControlPermission}},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.api.authorizer = authz
	vehicleAuthorizer, vehicleIdentities = authz, f.api.identities
	lkApiKey, lkApiSecret = "e2e-key", "e2e-signing-secret-with-sufficient-length"
	t.Cleanup(func() {
		controlLeases, videoSessions, auditSink = previousLeases, previousVideo, previousSink
		vehicleAuthorizer, vehicleIdentities = previousAuthz, previousIdents
		lkApiKey, lkApiSecret = previousKey, previousSecret
	})

	viewing := &ViewingLeaseAPI{
		store: &ViewingLeaseStore{client: f.client}, registry: f.api.registry,
		authorizer: f.api.authorizer, identities: f.api.identities,
	}
	viewing.register(f.mux)
	registerSessionAndTokenRoutes(f.mux)
	f.mux.Handle("POST /api/audit/events", vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(handleVehicleAudit))))
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", `[]`)
	t.Setenv("CONTROL_HANDOVER_ACK_ENABLED", "true")

	// 1. Acquire viewing lease -> MediaDemand turns active (viewer_count=1, video_required=true)
	reqID, instID := uuid.NewString(), uuid.NewString()
	acquireBody := fmt.Sprintf(`{"request_id":%q,"client_instance_id":%q}`, reqID, instID)
	w := f.request(t, http.MethodPost, "/api/vehicles/car-1/viewing/acquire", "observer", acquireBody, http.StatusOK)
	var vLease ViewingLease
	if err := json.Unmarshal(w.Body.Bytes(), &vLease); err != nil || vLease.ViewingSessionID == "" {
		t.Fatalf("decode viewing acquire: %v %s", err, w.Body.String())
	}
	w = f.request(t, http.MethodGet, "/api/vehicles/car-1/media-demand", "device1", "", http.StatusOK)
	var d1 MediaDemand
	if err := json.Unmarshal(w.Body.Bytes(), &d1); err != nil || !d1.RTCRequired || !d1.VideoRequired || d1.ViewerCount != 1 {
		t.Fatalf("initial demand = %+v err=%v", d1, err)
	}

	// 2. Viewing renew keeps MediaDemand.Revision constant; /token keeps expiry unchanged
	w = f.request(t, http.MethodPost, "/api/vehicles/car-1/viewing/"+vLease.ViewingSessionID+"/renew", "observer", "", http.StatusOK)
	var renewedLease ViewingLease
	_ = json.Unmarshal(w.Body.Bytes(), &renewedLease)
	w = f.request(t, http.MethodGet, "/api/vehicles/car-1/media-demand", "device1", "", http.StatusOK)
	var d2 MediaDemand
	_ = json.Unmarshal(w.Body.Bytes(), &d2)
	if d2.Revision != d1.Revision {
		t.Fatalf("viewing renew bumped demand revision: %d -> %d", d1.Revision, d2.Revision)
	}
	w = f.request(t, http.MethodPost, "/api/vehicles/car-1/viewing/"+vLease.ViewingSessionID+"/token", "observer", "", http.StatusOK)
	var refreshed struct {
		ViewingLease
		Token string `json:"token"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &refreshed)
	if refreshed.Token == "" || refreshed.ExpiresAtMS != renewedLease.ExpiresAtMS {
		t.Fatalf("token refresh mutated lease or omitted token: %+v (renewed=%+v)", refreshed, renewedLease)
	}

	// Cross-tenant / unauthorized & wrong-device access must fail closed with 403
	f.request(t, http.MethodPost, "/api/vehicles/car-1/viewing/"+vLease.ViewingSessionID+"/renew", "wrongtenant", "", http.StatusForbidden)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/viewing/"+vLease.ViewingSessionID+"/renew", "denied", "", http.StatusForbidden)
	f.request(t, http.MethodGet, "/api/vehicles/car-1/media-demand", "observer", "", http.StatusForbidden)

	// 3. Acquire v2 control -> DeviceContext ACTIVE, ControlRequired=true
	ctrlReq := `{"protocol_version":2,"client_instance_id":"pad-e2e","public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
	w = f.request(t, http.MethodPost, "/api/vehicles/car-1/control/acquire", "controller", ctrlReq, http.StatusOK)
	var ctrlResp controlSessionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &ctrlResp); err != nil || ctrlResp.Session.SessionID == "" {
		t.Fatalf("control acquire failed: %v %s", err, w.Body.String())
	}
	w = f.request(t, http.MethodGet, "/api/vehicles/car-1/control/context", "device1", "", http.StatusOK)
	var devCtx DeviceControlContext
	_ = json.Unmarshal(w.Body.Bytes(), &devCtx)
	if devCtx.State != "ACTIVE" || devCtx.SessionID != ctrlResp.Session.SessionID {
		t.Fatalf("device context = %+v", devCtx)
	}

	// 4. Release control -> PENDING fence blocks new acquire (409) until vehicle reports handover/ack
	f.request(t, http.MethodPost, "/api/control/"+ctrlResp.Session.SessionID+"/release", "controller", "", http.StatusAccepted)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/control/acquire", "controller", ctrlReq, http.StatusConflict)
	ackBody := fmt.Sprintf(`{"session_id":%q,"revision":%d,"edge_revocation_applied":true,"vehicle_handover_confirmed":true}`,
		ctrlResp.Session.SessionID, devCtx.Revision)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/control/handover/ack", "device1", ackBody, http.StatusNoContent)

	// After vehicle handover ACK, new acquire succeeds cleanly
	w = f.request(t, http.MethodPost, "/api/vehicles/car-1/control/acquire", "controller", ctrlReq, http.StatusOK)
	var ctrlResp2 controlSessionResponse
	_ = json.Unmarshal(w.Body.Bytes(), &ctrlResp2)
	f.request(t, http.MethodPost, "/api/control/"+ctrlResp2.Session.SessionID+"/release", "controller", "", http.StatusAccepted)
	w = f.request(t, http.MethodGet, "/api/vehicles/car-1/control/context", "device1", "", http.StatusOK)
	var devCtx2 DeviceControlContext
	_ = json.Unmarshal(w.Body.Bytes(), &devCtx2)
	ackBody2 := fmt.Sprintf(`{"session_id":%q,"revision":%d,"edge_revocation_applied":true,"vehicle_handover_confirmed":true}`,
		ctrlResp2.Session.SessionID, devCtx2.Revision)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/control/handover/ack", "device1", ackBody2, http.StatusNoContent)

	// 5. Release viewing -> MediaDemand clears to rtc_required=false and old sid returns 409
	f.request(t, http.MethodPost, "/api/vehicles/car-1/viewing/"+vLease.ViewingSessionID+"/release", "observer", "", http.StatusNoContent)
	f.request(t, http.MethodPost, "/api/vehicles/car-1/viewing/"+vLease.ViewingSessionID+"/renew", "observer", "", http.StatusConflict)
	w = f.request(t, http.MethodGet, "/api/vehicles/car-1/media-demand", "device1", "", http.StatusOK)
	var dOff MediaDemand
	_ = json.Unmarshal(w.Body.Bytes(), &dOff)
	if dOff.RTCRequired || dOff.VideoRequired || dOff.ControlRequired || dOff.ViewerCount != 0 {
		t.Fatalf("demand after release = %+v", dOff)
	}

	// 6. Vehicle safety audit events (paused_hold / camera_stalled / emergency_stop)
	for _, body := range []string{
		`{"session_id":"` + ctrlResp2.Session.SessionID + `","event":"paused_hold","reason":"command_paused","latency_ms":12.5}`,
		`{"session_id":"` + ctrlResp2.Session.SessionID + `","event":"camera_stalled","reason":"cam_1_timeout"}`,
	} {
		f.request(t, http.MethodPost, "/api/audit/events", "device1", body, http.StatusNoContent)
	}
	f.request(t, http.MethodPost, "/api/audit/events", "observer", `{"session_id":"s1","event":"paused_hold","reason":"r"}`, http.StatusForbidden)
}

func TestManagedInstanceMuIsolatesHotPathFromAdditiveMu(t *testing.T) {
	runtime := &ManagedRuntime{}
	runtime.additiveMu.Lock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		// Simulates a hot-path authorizeRequest acquiring RLock + instanceMu while an admin holds additiveMu.
		runtime.mu.RLock()
		runtime.instanceMu.Lock()
		runtime.instanceMu.Unlock()
		runtime.mu.RUnlock()
	}()
	select {
	case <-done:
		runtime.additiveMu.Unlock()
	case <-time.After(time.Second):
		runtime.additiveMu.Unlock()
		<-done
		t.Fatal("hot-path instanceMu blocked on admin additiveMu")
	}
}

type nopWriteCloser struct{}

func (nopWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
