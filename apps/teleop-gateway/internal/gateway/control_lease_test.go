package gateway

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestControlLeaseKey(t *testing.T) {
	if got, want := controlLeaseKey("vehicle-001"), "control:vehicle-001"; got != want {
		t.Fatalf("controlLeaseKey() = %q, want %q", got, want)
	}
}

func TestNormalizeRedisURL(t *testing.T) {
	tests := map[string]string{
		"":                  "redis://localhost:6379/0",
		"redis:6379":        "redis://redis:6379/0",
		"redis://redis:6379/1": "redis://redis:6379/1",
	}
	for input, want := range tests {
		if got := normalizeRedisURL(input); got != want {
			t.Errorf("normalizeRedisURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestControlLeaseAcquireWithRedis(t *testing.T) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Skip("set REDIS_URL to run Redis lease integration test")
	}

	store, err := NewControlLeaseStore(redisURL, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("NewControlLeaseStore() error = %v", err)
	}
	defer store.client.Close()

	ctx := context.Background()
	vehicleID := "lease-test-" + time.Now().UTC().Format("20060102150405.000000000")

	acquired, err := store.Acquire(ctx, vehicleID, "operator-a")
	if err != nil || !acquired {
		t.Fatalf("first Acquire() = %v, %v; want true, nil", acquired, err)
	}

	acquired, err = store.Acquire(ctx, vehicleID, "operator-b")
	if err != nil || acquired {
		t.Fatalf("second Acquire() = %v, %v; want false, nil", acquired, err)
	}

	time.Sleep(150 * time.Millisecond)
	acquired, err = store.Acquire(ctx, vehicleID, "operator-b")
	if err != nil || !acquired {
		t.Fatalf("Acquire() after lease expiry = %v, %v; want true, nil", acquired, err)
	}
}
