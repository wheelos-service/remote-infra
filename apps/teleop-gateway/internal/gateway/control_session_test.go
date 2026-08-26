package gateway

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestControlSessionLifecycleWithRedis(t *testing.T) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Skip("set REDIS_URL to run Redis control-session integration test")
	}

	store, err := NewControlLeaseStore(redisURL, 200*time.Millisecond)
	if err != nil {
		t.Fatalf("NewControlLeaseStore() error = %v", err)
	}
	defer store.client.Close()

	ctx := context.Background()
	vehicleID := "session-test-" + time.Now().UTC().Format("20060102150405.000000000")
	sessionA := newTestControlSession(vehicleID, "operator-a", "session-a", store.ttl)

	if err := store.AcquireControlSession(ctx, sessionA); err != nil {
		t.Fatalf("AcquireControlSession() error = %v", err)
	}
	if err := store.AcquireControlSession(ctx, newTestControlSession(vehicleID, "operator-b", "session-b", store.ttl)); !errors.Is(err, ErrControlLeaseHeld) {
		t.Fatalf("second AcquireControlSession() error = %v, want ErrControlLeaseHeld", err)
	}
	if _, err := store.RenewControlSession(ctx, sessionA.SessionID, "operator-b"); !errors.Is(err, ErrControlSessionOwner) {
		t.Fatalf("RenewControlSession() error = %v, want ErrControlSessionOwner", err)
	}
	if err := store.ReleaseControlSession(ctx, sessionA.SessionID, "operator-b"); !errors.Is(err, ErrControlSessionOwner) {
		t.Fatalf("ReleaseControlSession() error = %v, want ErrControlSessionOwner", err)
	}
	if _, err := store.RenewControlSession(ctx, sessionA.SessionID, "operator-a"); err != nil {
		t.Fatalf("RenewControlSession() error = %v", err)
	}
	if err := store.ReleaseControlSession(ctx, sessionA.SessionID, "operator-a"); err != nil {
		t.Fatalf("ReleaseControlSession() error = %v", err)
	}
	if _, err := store.GetControlSession(ctx, vehicleID); !errors.Is(err, ErrControlSessionNotFound) {
		t.Fatalf("GetControlSession() error = %v, want ErrControlSessionNotFound", err)
	}

	sessionB := newTestControlSession(vehicleID, "operator-b", "session-b", store.ttl)
	if err := store.AcquireControlSession(ctx, sessionB); err != nil {
		t.Fatalf("AcquireControlSession() after release error = %v", err)
	}

	time.Sleep(250 * time.Millisecond)
	if _, err := store.GetControlSession(ctx, vehicleID); !errors.Is(err, ErrControlSessionNotFound) {
		t.Fatalf("GetControlSession() after expiry error = %v, want ErrControlSessionNotFound", err)
	}
}

func newTestControlSession(vehicleID, operatorID, sessionID string, ttl time.Duration) ControlSession {
	now := time.Now()
	return ControlSession{
		SessionID:    sessionID,
		VehicleID:    vehicleID,
		OperatorID:   operatorID,
		PublicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		Status:       ControlSessionActive,
		CreatedAtMS:  now.UnixMilli(),
		ExpiresAtMS:  now.Add(ttl).UnixMilli(),
	}
}
