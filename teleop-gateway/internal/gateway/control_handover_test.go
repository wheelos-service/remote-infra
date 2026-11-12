package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestControlHandoverGuardsVehicleAndOperatorAcrossExpiry(t *testing.T) {
	store, _ := newViewingStore(t)
	leases := &ControlLeaseStore{client: store.client, ttl: time.Minute}
	ctx := context.Background()
	first := newTestControlSession("car-a", "alice", "first", leases.ttl)
	first.OperatorTenant = "fleet"
	if err := leases.AcquireControlSession(ctx, first); err != nil {
		t.Fatal(err)
	}
	second := newTestControlSession("car-b", "alice", "second", leases.ttl)
	second.OperatorTenant = "fleet"
	if err := leases.AcquireControlSession(ctx, second); !errors.Is(err, ErrControlHandoverPending) {
		t.Fatalf("same operator acquired two vehicles: %v", err)
	}
	active, err := leases.GetHandover(ctx, "car-a")
	if err != nil || active.State != "ACTIVE" {
		t.Fatalf("active=%#v %v", active, err)
	}
	if err := leases.AcknowledgeHandover(ctx, "car-a", "first", active.Revision); !errors.Is(err, ErrControlHandoverPending) {
		t.Fatal("cannot acknowledge a still-active lease")
	}
	if err := leases.ReleaseControlSession(ctx, "first", "alice"); err != nil {
		t.Fatal(err)
	}
	pending, err := leases.GetHandover(ctx, "car-a")
	if err != nil || pending.State != "PENDING" || pending.EdgeRevocationApplied || pending.VehicleHandoverConfirmed {
		t.Fatalf("HTTP release falsely completed handover: %#v %v", pending, err)
	}
	if err := leases.AcquireControlSession(ctx, second); !errors.Is(err, ErrControlHandoverPending) {
		t.Fatal("release unblocked operator")
	}
	if err := leases.ReportHandover(ctx, "car-a", "first", pending.Revision, false); err != nil {
		t.Fatal(err)
	}
	applied, err := leases.GetHandover(ctx, "car-a")
	if err != nil || !applied.EdgeRevocationApplied || applied.VehicleHandoverConfirmed || applied.State != "PENDING" {
		t.Fatal("native revocation must remain distinct from physical handover", applied, err)
	}
	if err := leases.AcquireControlSession(ctx, second); !errors.Is(err, ErrControlHandoverPending) {
		t.Fatal("native-only acknowledgement unblocked another vehicle", err)
	}
	if err := leases.AcquireControlSession(ctx, newTestControlSession("car-a", "bob", "third", leases.ttl)); !errors.Is(err, ErrControlHandoverPending) {
		t.Fatal("release unblocked old vehicle")
	}
	for _, revision := range []int64{0, pending.Revision + 1} {
		if err := leases.AcknowledgeHandover(ctx, "car-a", "first", revision); !errors.Is(err, ErrControlHandoverPending) {
			t.Fatal("stale ack accepted")
		}
	}
	if err := leases.AcknowledgeHandover(ctx, "car-a", "wrong", pending.Revision); !errors.Is(err, ErrControlHandoverPending) {
		t.Fatal("wrong session accepted")
	}
	if err := leases.AcknowledgeHandover(ctx, "car-a", "first", pending.Revision); err != nil {
		t.Fatal(err)
	}
	if err := leases.AcknowledgeHandover(ctx, "car-a", "first", pending.Revision); err != nil {
		t.Fatal("ack not idempotent", err)
	}
	if err := leases.AcquireControlSession(ctx, second); err != nil {
		t.Fatal(err)
	}
	// Simulate actual lease/index expiry while retaining durable fences.
	if err := leases.client.Del(ctx, controlLeaseKey("car-b"), controlSessionIndexKey("second")).Err(); err != nil {
		t.Fatal(err)
	}
	expired, err := leases.GetHandover(ctx, "car-b")
	if err != nil || expired.State != "PENDING" {
		t.Fatalf("expiry=%#v %v", expired, err)
	}
	next := newTestControlSession("car-c", "alice", "fourth", leases.ttl)
	next.OperatorTenant = "fleet"
	if err := leases.AcquireControlSession(ctx, next); !errors.Is(err, ErrControlHandoverPending) {
		t.Fatal("lease expiry must not unblock another vehicle", err)
	}
}

func TestControlHandoverConcurrentOperatorAcquire(t *testing.T) {
	store, _ := newViewingStore(t)
	leases := &ControlLeaseStore{client: store.client, ttl: time.Minute}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, vehicle := range []string{"car-a", "car-b"} {
		wg.Add(1)
		go func(vehicle string) {
			defer wg.Done()
			errs <- leases.AcquireControlSession(context.Background(), newTestControlSession(vehicle, "alice", vehicle, leases.ttl))
		}(vehicle)
	}
	wg.Wait()
	close(errs)
	success, conflict := 0, 0
	for err := range errs {
		if err == nil {
			success++
		} else if errors.Is(err, ErrControlHandoverPending) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("singleton failed: %d %d", success, conflict)
	}
}

func TestControlHandoverDeviceAcknowledgementGate(t *testing.T) {
	f := newTelemetryFixture(t)
	previousLeases, previousAuth, previousIDs := controlLeases, vehicleAuthorizer, vehicleIdentities
	previousSink := auditSink
	auditSink = NewJSONAuditSink(io.Discard)
	controlLeases, vehicleAuthorizer, vehicleIdentities = f.api.leases, f.api.authorizer, f.api.identities
	t.Cleanup(func() {
		controlLeases, vehicleAuthorizer, vehicleIdentities = previousLeases, previousAuth, previousIDs
		auditSink = previousSink
	})
	registerControlHandover(f.mux)
	session := newTestControlSession("car-1", "alice", "session", time.Minute)
	if err := controlLeases.AcquireControlSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}

	path := "/api/vehicles/car-1/control/handover"
	f.request(t, http.MethodGet, path, "device2", "", http.StatusForbidden)
	f.request(t, http.MethodPost, path+"/ack", "observer", "{}", http.StatusForbidden)
	t.Setenv("CONTROL_HANDOVER_ACK_ENABLED", "false")
	f.request(t, http.MethodPost, path+"/ack", "device1", "{}", http.StatusServiceUnavailable)
	t.Setenv("CONTROL_HANDOVER_ACK_ENABLED", "true")
	handover, err := controlLeases.GetHandover(context.Background(), "car-1")
	if err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"session_id":"session","revision":%d,"edge_revocation_applied":true,"vehicle_handover_confirmed":true}`, handover.Revision)
	f.request(t, http.MethodPost, path+"/ack", "device1", body, http.StatusConflict)
	for _, bad := range []string{`{}`, `{"session_id":"session","revision":1,"edge_revocation_applied":false,"vehicle_handover_confirmed":false}`} {
		f.request(t, http.MethodPost, path+"/ack", "device1", bad, http.StatusBadRequest)
	}
	if err := controlLeases.ReleaseControlSession(context.Background(), "session", "alice"); err != nil {
		t.Fatal(err)
	}
	f.request(t, http.MethodGet, path, "device1", "", http.StatusOK)
	partial := fmt.Sprintf(`{"session_id":"session","revision":%d,"edge_revocation_applied":true,"vehicle_handover_confirmed":false}`, handover.Revision)
	f.request(t, http.MethodPost, path+"/ack", "device1", partial, http.StatusAccepted)
	f.request(t, http.MethodPost, path+"/ack", "device1", body, http.StatusNoContent)
	f.request(t, http.MethodPost, path+"/ack", "device1", body, http.StatusNoContent)
}

func TestControlHTTPReleaseIsPendingAndACLIsRechecked(t *testing.T) {
	f := newTelemetryFixture(t)
	previousLeases, previousAuth, previousIDs := controlLeases, vehicleAuthorizer, vehicleIdentities
	previousVideo, previousSink, previousKey, previousSecret := videoSessions, auditSink, lkApiKey, lkApiSecret
	controlLeases, vehicleAuthorizer, vehicleIdentities = f.api.leases, f.api.authorizer, f.api.identities
	videoSessions = NewVideoSessionStore(f.client, 0)
	auditSink = NewJSONAuditSink(io.Discard)
	lkApiKey, lkApiSecret = "test", "control-test-only-signing-key-not-a-production-credential"
	t.Cleanup(func() {
		controlLeases, vehicleAuthorizer, vehicleIdentities = previousLeases, previousAuth, previousIDs
		videoSessions, auditSink, lkApiKey, lkApiSecret = previousVideo, previousSink, previousKey, previousSecret
	})
	for pattern, handler := range map[string]http.HandlerFunc{
		"POST /api/vehicles/{vehicle_id}/control/acquire": handleAcquireControl,
		"POST /api/control/{session_id}/renew":            handleRenewControl,
		"POST /api/control/{session_id}/release":          handleReleaseControl,
	} {
		f.mux.Handle(pattern, vehicleTelemetryNoStore(AuthenticationMiddleware(handler)))
	}
	body := `{"public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
	response := f.request(t, http.MethodPost, "/api/vehicles/car-2/control/acquire", "controller", body, http.StatusOK)
	var acquired controlSessionResponse
	if err := json.Unmarshal(response.Body.Bytes(), &acquired); err != nil {
		t.Fatal(err)
	}
	root := "/api/control/" + acquired.Session.SessionID
	f.request(t, http.MethodPost, root+"/renew", "wrongtenant", "", http.StatusForbidden)
	f.request(t, http.MethodPost, root+"/release", "wrongtenant", "", http.StatusForbidden)
	f.request(t, http.MethodPost, root+"/renew", "controller", "", http.StatusOK)
	response = f.request(t, http.MethodPost, root+"/release", "controller", "", http.StatusAccepted)
	var pending ControlHandover
	if err := json.Unmarshal(response.Body.Bytes(), &pending); err != nil || pending.State != "PENDING" || pending.VehicleHandoverConfirmed {
		t.Fatal("HTTP release must report pending, not completed handover")
	}
	f.request(t, http.MethodPost, "/api/vehicles/car-2/control/acquire", "controller", body, http.StatusConflict)
	state := f.get(t, "car-2")
	if state.Control.Status != "unknown" {
		t.Fatal("pending handover was reported free")
	}
}
