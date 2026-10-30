package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

func newViewingStore(t *testing.T) (*ViewingLeaseStore, *miniredis.Miniredis) {
	t.Helper()
	server := miniredis.RunT(t)
	server.SetTime(time.UnixMilli(1700000000000))
	client := redis.NewClient(&redis.Options{Addr: server.Addr(), MaxRetries: -1})
	t.Cleanup(func() { _ = client.Close() })
	return &ViewingLeaseStore{client: client}, server
}

func demandFor(t *testing.T, store *ViewingLeaseStore, vehicleID string) MediaDemand {
	t.Helper()
	demand, err := store.Demand(context.Background(), vehicleID)
	if err != nil {
		t.Fatal(err)
	}
	return demand
}

func TestViewingIndependentLeasesAndIdempotency(t *testing.T) {
	store, server := newViewingStore(t)
	ctx := context.Background()
	first, second := uuid.NewString(), uuid.NewString()
	initial := demandFor(t, store, "car-1")
	if initial.RTCRequired || initial.VideoRequired || initial.ViewerCount != 0 {
		t.Fatalf("no Room or old session should create demand: %#v", initial)
	}
	lease, err := store.mutate(ctx, "acquire", "car-1", "alice", first)
	if err != nil {
		t.Fatal(err)
	}
	server.SetTime(time.UnixMilli(lease.ServerTimeMS + 1000))
	duplicate, err := store.mutate(ctx, "acquire", "car-1", "alice", first)
	if err != nil || duplicate.ExpiresAtMS != lease.ExpiresAtMS {
		t.Fatalf("duplicate acquire extended lease: %#v %v", duplicate, err)
	}
	if _, err := store.mutate(ctx, "acquire", "car-1", "bob", second); err != nil {
		t.Fatal(err)
	}
	active := demandFor(t, store, "car-1")
	if active.ViewerCount != 2 || !active.VideoRequired || active.Epoch != initial.Epoch || active.Revision <= initial.Revision {
		t.Fatalf("independent demand = %#v", active)
	}
	if active.ValidUntilMS != active.ServerTimeMS+5000 {
		t.Fatal("demand must have a bounded validity horizon")
	}
	if _, err := store.mutate(ctx, "release", "car-1", "alice", first); err != nil {
		t.Fatal(err)
	}
	if _, err := store.mutate(ctx, "release", "car-1", "alice", first); err != nil {
		t.Fatalf("duplicate release failed: %v", err)
	}
	if current := demandFor(t, store, "car-1"); current.ViewerCount != 1 || !current.RTCRequired {
		t.Fatalf("release removed another viewer: %#v", current)
	}
	for _, op := range []string{"acquire", "renew"} {
		if _, err := store.mutate(ctx, op, "car-1", "alice", first); !errors.Is(err, errViewingGone) {
			t.Fatalf("%s resurrected released lease: %v", op, err)
		}
	}
	if other := demandFor(t, store, "car-2"); other.RTCRequired {
		t.Fatal("viewing demand crossed vehicle boundary")
	}
}

func TestViewingExpiryRenewalAndControlAuthority(t *testing.T) {
	store, server := newViewingStore(t)
	ctx := context.Background()
	sid := uuid.NewString()
	lease, err := store.mutate(ctx, "acquire", "car-1", "alice", sid)
	if err != nil {
		t.Fatal(err)
	}
	server.SetTime(time.UnixMilli(lease.ServerTimeMS + 20000))
	renewed, err := store.mutate(ctx, "renew", "car-1", "alice", sid)
	if err != nil || renewed.ExpiresAtMS != lease.ExpiresAtMS+20000 {
		t.Fatalf("renewal = %#v %v", renewed, err)
	}
	for _, op := range []string{"renew", "release", "acquire"} {
		if _, err := store.mutate(ctx, op, "car-1", "bob", sid); !errors.Is(err, errViewingOwner) {
			t.Fatalf("%s accepted another owner: %v", op, err)
		}
	}
	// A stale legacy controller reference must not retain media demand.
	if err := store.client.Set(ctx, videoSessionKey("car-1"), `{"controller_session_id":"stale"}`, 0).Err(); err != nil {
		t.Fatal(err)
	}
	server.SetTime(time.UnixMilli(renewed.ExpiresAtMS))
	if _, err := store.mutate(ctx, "renew", "car-1", "alice", sid); !errors.Is(err, errViewingGone) {
		t.Fatalf("expired renewal = %v", err)
	}
	off := demandFor(t, store, "car-1")
	if off.RTCRequired || off.ViewerCount != 0 {
		t.Fatalf("expired demand = %#v", off)
	}
	session := ControlSession{
		SessionID: uuid.NewString(), VehicleID: "car-1", OperatorID: "driver",
		Status: ControlSessionActive, CreatedAtMS: off.ServerTimeMS, ExpiresAtMS: off.ServerTimeMS + 20000,
	}
	control := &ControlLeaseStore{client: store.client, ttl: 3 * time.Second}
	if err := control.AcquireControlSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	driving := demandFor(t, store, "car-1")
	if !driving.ControlRequired || !driving.VideoRequired || driving.ValidUntilMS != driving.ServerTimeMS+3000 {
		t.Fatalf("live control demand = %#v", driving)
	}
	server.FastForward(3 * time.Second)
	server.SetTime(time.UnixMilli(driving.ServerTimeMS + 3000))
	expired := demandFor(t, store, "car-1")
	if expired.RTCRequired || expired.ControlRequired || expired.Revision <= driving.Revision {
		t.Fatalf("expired control retained demand: %#v", expired)
	}
	handover, err := control.GetHandover(ctx, "car-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := control.AcknowledgeHandover(ctx, "car-1", session.SessionID, handover.Revision); err != nil {
		t.Fatal(err)
	}
	activeViewer := uuid.NewString()
	if _, err := store.mutate(ctx, "acquire", "car-1", "alice", activeViewer); err != nil {
		t.Fatal(err)
	}
	session.SessionID = uuid.NewString()
	session.ExpiresAtMS = expired.ServerTimeMS + 3000
	if err := control.AcquireControlSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	both := demandFor(t, store, "car-1")
	if !both.ControlRequired || both.ViewerCount != 1 {
		t.Fatal("viewer and controller demand must coexist")
	}
	server.FastForward(3 * time.Second)
	server.SetTime(time.UnixMilli(expired.ServerTimeMS + 3000))
	viewing := demandFor(t, store, "car-1")
	if viewing.ControlRequired || !viewing.VideoRequired || viewing.ViewerCount != 1 {
		t.Fatal("controller expiry must not remove viewer demand")
	}
}

func TestViewingConcurrentAcquireRenewReleaseAndLimit(t *testing.T) {
	store, server := newViewingStore(t)
	ctx := context.Background()
	client := redis.NewClient(&redis.Options{Addr: server.Addr(), MaxRetries: -1})
	t.Cleanup(func() { _ = client.Close() })
	other := &ViewingLeaseStore{client: client}
	sid := uuid.NewString()
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			current := []*ViewingLeaseStore{store, other}[i%2]
			_, err := current.mutate(ctx, "acquire", "car-1", "alice", sid)
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if demandFor(t, store, "car-1").ViewerCount != 1 {
		t.Fatal("concurrent duplicate requests incremented viewer count")
	}
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = store.mutate(ctx, "renew", "car-1", "alice", sid) }()
	go func() { defer wg.Done(); _, _ = other.mutate(ctx, "release", "car-1", "alice", sid) }()
	wg.Wait()
	if demandFor(t, store, "car-1").RTCRequired {
		t.Fatal("renew/release race resurrected demand")
	}
	for i := 0; i < 64; i++ {
		if _, err := store.mutate(ctx, "acquire", "car-2", "alice", uuid.NewString()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.mutate(ctx, "acquire", "car-2", "alice", uuid.NewString()); !errors.Is(err, errViewingLimit) {
		t.Fatalf("unbounded viewers: %v", err)
	}
}

func TestViewingCoordinationStorageFailure(t *testing.T) {
	for _, key := range []string{"viewing:car-1:active", "viewing:car-1:demand", controlLeaseKey("car-1")} {
		t.Run(key, func(t *testing.T) {
			store, _ := newViewingStore(t)
			ctx := context.Background()
			if err := store.client.Set(ctx, key, "corrupt", 0).Err(); err != nil {
				t.Fatal(err)
			}
			sid := uuid.NewString()
			if _, err := store.mutate(ctx, "acquire", "car-1", "alice", sid); err == nil {
				t.Fatal("corrupt store returned successful lease")
			}
			if store.client.Exists(ctx, "viewing:car-1:lease:"+sid).Val() != 0 {
				t.Fatal("failed script partially created a lease")
			}
			if _, err := store.Demand(ctx, "car-1"); err == nil {
				t.Fatal("corrupt store returned OFF as a success-shaped fallback")
			}
		})
	}
	t.Run("incomplete demand metadata", func(t *testing.T) {
		store, _ := newViewingStore(t)
		ctx := context.Background()
		if err := store.client.HSet(ctx, "viewing:car-1:demand", "epoch", uuid.NewString()).Err(); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Demand(ctx, "car-1"); err == nil {
			t.Fatal("partial replay fence metadata must not become a fresh epoch")
		}
	})
}

func TestViewingClockRollbackDoesNotResurrectExpiredLease(t *testing.T) {
	store, server := newViewingStore(t)
	ctx := context.Background()
	sid := uuid.NewString()
	lease, err := store.mutate(ctx, "acquire", "car-1", "alice", sid)
	if err != nil {
		t.Fatal(err)
	}
	server.SetTime(time.UnixMilli(lease.ExpiresAtMS + 1))
	if demandFor(t, store, "car-1").RTCRequired {
		t.Fatal("expired viewer still contributes")
	}
	server.SetTime(time.UnixMilli(lease.ServerTimeMS + 1))
	if _, err := store.mutate(ctx, "renew", "car-1", "alice", sid); err == nil {
		t.Fatal("clock rollback resurrected an expired viewer")
	}
	if _, err := store.Demand(ctx, "car-1"); err == nil {
		t.Fatal("clock rollback must be explicit, not OFF or fresh demand")
	}
}

func TestViewingRealRedis(t *testing.T) {
	addr := os.Getenv("VIEWING_TEST_REDIS_ADDR")
	if addr == "" {
		t.Skip("set VIEWING_TEST_REDIS_ADDR to an isolated disposable Redis")
	}
	ctx := context.Background()
	client := redis.NewClient(&redis.Options{Addr: addr, MaxRetries: -1})
	t.Cleanup(func() { _ = client.Close() })
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatal(err)
	}
	store := &ViewingLeaseStore{client: client}
	vehicleID, sid := "test-"+uuid.NewString(), uuid.NewString()
	prefix := "viewing:" + vehicleID
	t.Cleanup(func() {
		if err := client.Del(ctx, prefix+":active", prefix+":demand", prefix+":lease:"+sid).Err(); err != nil {
			t.Error(err)
		}
	})
	lease, err := store.mutate(ctx, "acquire", vehicleID, "test-owner", sid)
	if err != nil {
		t.Fatal(err)
	}
	active := demandFor(t, store, vehicleID)
	if active.ViewerCount != 1 || !active.VideoRequired || active.ValidUntilMS > lease.ExpiresAtMS {
		t.Fatalf("real Redis demand = %#v", active)
	}
	if _, err := store.mutate(ctx, "renew", vehicleID, "test-owner", sid); err != nil {
		t.Fatal(err)
	}
	if _, err := store.mutate(ctx, "release", vehicleID, "test-owner", sid); err != nil {
		t.Fatal(err)
	}
	off := demandFor(t, store, vehicleID)
	if off.RTCRequired || off.Revision <= active.Revision || off.Epoch != active.Epoch {
		t.Fatalf("real Redis release = %#v", off)
	}
	if _, err := store.mutate(ctx, "acquire", vehicleID, "test-owner", sid); !errors.Is(err, errViewingGone) {
		t.Fatalf("real Redis resurrected a released lease: %v", err)
	}
}

func TestViewingAPIAuthenticationOwnershipAndTokens(t *testing.T) {
	f := newTelemetryFixture(t)
	previousSink, previousKey, previousSecret := auditSink, lkApiKey, lkApiSecret
	auditSink = NewJSONAuditSink(io.Discard)
	lkApiKey, lkApiSecret = "test-key", "viewing-test-only-signing-key-not-a-production-secret"
	t.Cleanup(func() { auditSink, lkApiKey, lkApiSecret = previousSink, previousKey, previousSecret })
	api := &ViewingLeaseAPI{store: &ViewingLeaseStore{client: f.client},
		registry: f.api.registry, authorizer: f.api.authorizer, identities: f.api.identities}
	api.register(f.mux)
	path := "/api/vehicles/car-1/viewing/acquire"
	body := fmt.Sprintf(`{"request_id":%q,"client_instance_id":%q}`, uuid.NewString(), uuid.NewString())
	for _, token := range []string{"", "invalid"} {
		f.request(t, http.MethodPost, path, token, body, http.StatusUnauthorized)
	}
	for _, token := range []string{"denied", "wrongtenant", "device1", "roleless"} {
		f.request(t, http.MethodPost, path, token, body, http.StatusForbidden)
	}
	f.request(t, http.MethodPost, "/api/vehicles/not-registered/viewing/acquire", "observer", body, http.StatusNotFound)
	for _, bad := range []string{`null`, `{}`, body + `{}`, strings.Replace(body, `"request_id":`, `"unknown":`, 1),
		strings.Replace(body, `"request_id":`, `"REQUEST_ID":`, 1),
		strings.Replace(body, `"request_id":`, `"request_id":"duplicate","request_id":`, 1), `{"request_id":"bad","client_instance_id":null}`} {
		f.request(t, http.MethodPost, path, "observer", bad, http.StatusBadRequest)
	}
	result := f.request(t, http.MethodPost, path, "observer", body, http.StatusOK)
	var lease struct {
		ViewingLease
		Token string `json:"token"`
	}
	if err := json.Unmarshal(result.Body.Bytes(), &lease); err != nil {
		t.Fatal(err)
	}
	// Check the actual JWT grants, not merely the token helper's intent.
	parts := strings.Split(lease.Token, ".")
	if len(parts) != 3 {
		t.Fatal("missing observer JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var jwt struct {
		Subject string `json:"sub"`
		Video   struct {
			Room           string `json:"room"`
			CanPublish     bool   `json:"canPublish"`
			CanPublishData bool   `json:"canPublishData"`
			CanSubscribe   bool   `json:"canSubscribe"`
		} `json:"video"`
	}
	if err := json.Unmarshal(payload, &jwt); err != nil {
		t.Fatal(err)
	}
	if jwt.Subject != "observer-"+lease.ViewingSessionID || jwt.Video.Room != "teleop-car-1" ||
		jwt.Video.CanPublish || jwt.Video.CanPublishData || !jwt.Video.CanSubscribe {
		t.Fatalf("invalid observer grants: %s", payload)
	}
	f.request(t, http.MethodPost, path, "observer", body, http.StatusOK)
	secondBody := fmt.Sprintf(`{"request_id":%q,"client_instance_id":%q}`, uuid.NewString(), uuid.NewString())
	secondResponse := f.request(t, http.MethodPost, path, "observer", secondBody, http.StatusOK)
	var second ViewingLease
	if err := json.Unmarshal(secondResponse.Body.Bytes(), &second); err != nil || second.ViewingSessionID == lease.ViewingSessionID {
		t.Fatal("separate browser instances must have distinct viewing identities")
	}
	demandPath := "/api/vehicles/car-1/media-demand"
	for _, token := range []string{"observer", "device2", "spoof"} {
		f.request(t, http.MethodGet, demandPath, token, "", http.StatusForbidden)
	}
	f.request(t, http.MethodGet, demandPath, "device1", "", http.StatusOK)
	root := "/api/vehicles/car-1/viewing/" + lease.ViewingSessionID
	f.request(t, http.MethodPost, root+"/renew", "observer", "{}", http.StatusBadRequest)
	f.request(t, http.MethodPost, root+"/renew", "observer", "", http.StatusOK)
	// Another authorized observer still cannot mutate Alice's lease.
	api.authorizer.entries = append(api.authorizer.entries, VehicleACL{
		UserID: "bob", TenantID: "tenant-a", VehicleID: "car-1", Permissions: []VehiclePermission{ObservePermission},
	})
	f.request(t, http.MethodPost, root+"/renew", "denied", "", http.StatusForbidden)
	f.request(t, http.MethodPost, root+"/release", "denied", "", http.StatusForbidden)
	f.request(t, http.MethodPost, "/api/vehicles/car-2/viewing/"+lease.ViewingSessionID+"/release", "observer", "", http.StatusNoContent)
	f.request(t, http.MethodPost, root+"/renew", "observer", "", http.StatusOK)
	f.request(t, http.MethodPost, root+"/release", "observer", "", http.StatusNoContent)
	f.request(t, http.MethodPost, root+"/release", "observer", "", http.StatusNoContent)
	f.request(t, http.MethodPost, root+"/renew", "observer", "", http.StatusConflict)
	f.request(t, http.MethodPost, path, "observer", body, http.StatusConflict)
	// Authorization is rechecked on renewal, not only on acquisition.
	api.authorizer.entries = nil
	f.request(t, http.MethodPost, "/api/vehicles/car-1/viewing/"+second.ViewingSessionID+"/renew", "observer", "", http.StatusForbidden)
	_ = f.client.Close()
	f.request(t, http.MethodGet, demandPath, "device1", "", http.StatusServiceUnavailable)
}
