package gateway

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newVideoSessionTestStore(t *testing.T, grace time.Duration) (*VideoSessionStore, func()) {
	t.Helper()
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	return NewVideoSessionStore(client, grace), func() {
		_ = client.Close()
		server.Close()
	}
}

func TestVideoSessionViewerGraceReturnsToStandby(t *testing.T) {
	store, cleanup := newVideoSessionTestStore(t, 20*time.Millisecond)
	defer cleanup()

	ctx := context.Background()
	session, err := store.AcquireViewer(ctx, "vehicle-001")
	if err != nil {
		t.Fatal(err)
	}
	if session.Mode != VideoActive || session.ViewerCount != 1 {
		t.Fatalf("active session = %#v", session)
	}
	if _, err := store.ReleaseViewer(ctx, session.SessionID); err != nil {
		t.Fatal(err)
	}
	grace, err := store.Get(ctx, "vehicle-001")
	if err != nil {
		t.Fatal(err)
	}
	if grace.Mode != VideoActive || grace.GraceDeadlineMS == 0 {
		t.Fatalf("session should remain active during grace = %#v", grace)
	}
	time.Sleep(30 * time.Millisecond)
	standby, err := store.Get(ctx, "vehicle-001")
	if err != nil {
		t.Fatal(err)
	}
	if standby.Mode != VideoStandby || standby.GraceDeadlineMS != 0 {
		t.Fatalf("session should return to standby = %#v", standby)
	}
}

func TestVideoSessionControllerKeepsVideoActiveWithObserver(t *testing.T) {
	store, cleanup := newVideoSessionTestStore(t, time.Second)
	defer cleanup()

	ctx := context.Background()
	observer, err := store.AcquireViewer(ctx, "vehicle-002")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetController(ctx, "vehicle-002", "control-001"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClearController(ctx, "vehicle-002", "control-001"); err != nil {
		t.Fatal(err)
	}
	current, err := store.Get(ctx, "vehicle-002")
	if err != nil {
		t.Fatal(err)
	}
	if current.Mode != VideoActive || current.ViewerCount != 1 || current.GraceDeadlineMS != 0 {
		t.Fatalf("observer should keep video active = %#v", current)
	}
	if _, err := store.ReleaseViewer(ctx, observer.SessionID); err != nil {
		t.Fatal(err)
	}
}
