package gateway

import (
	"context"
	"crypto/sha256"
	"errors"
	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/twitchtv/twirp"
	"golang.org/x/net/websocket"
	"google.golang.org/protobuf/proto"
)

// This test needs a disposable, loopback-only server, never a shared RTC service.
func TestManagedRealLiveKitSignalingAndDrain(t *testing.T) {
	rawURL := os.Getenv("MANAGED_RTC_TEST_URL")
	if rawURL == "" {
		t.Skip("run python3 tests/managed-auth-chain.py for disposable real LiveKit acceptance")
	}
	endpoint, err := url.Parse(rawURL)
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" {
		t.Fatal("MANAGED_RTC_TEST_URL must be an isolated loopback HTTP server")
	}
	f := newManagedFixture(t)
	lkApiKey, lkApiSecret = "managed-rtc-test", "disposable-managed-rtc-only-test-secret"
	f.runtime.roomsEmpty, err = managedRoomDrainCheck(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	f.runtime.rtcProxy = httputil.NewSingleHostReverseProxy(endpoint)
	server := httptest.NewServer(http.HandlerFunc(f.runtime.RTCIngress))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 14*time.Minute)
	defer cancel()
	mint := func() string {
		t.Helper()
		token, err := auth.NewAccessToken(lkApiKey, lkApiSecret).
			SetIdentity("managed-real-observer").
			SetValidFor(5 * time.Second).
			AddGrant(&auth.VideoGrant{RoomJoin: true, Room: "teleop-managed-real"}).ToJWT()
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	dial := func(token string) (*websocket.Conn, error) {
		target := "ws" + strings.TrimPrefix(server.URL, "http") +
			"/rtc?protocol=15&auto_subscribe=0&access_token=" + url.QueryEscape(token)
		config, err := websocket.NewConfig(target, server.URL)
		if err != nil {
			return nil, err
		}
		config.Dialer = &net.Dialer{Timeout: 5 * time.Second}
		return websocket.DialConfig(config)
	}
	original := mint()
	conn, err := dial(original)
	if err != nil {
		// Avoid printing a WebSocket URL: it contains an access token.
		t.Fatal("real LiveKit join through managed ingress failed")
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	joined, refreshed := false, ""
	for !joined || refreshed == "" {
		var data []byte
		if err := websocket.Message.Receive(conn, &data); err != nil {
			t.Fatal("real LiveKit did not send join and refreshed token within deadline")
		}
		var response livekit.SignalResponse
		if err := proto.Unmarshal(data, &response); err != nil {
			t.Fatal("invalid LiveKit signaling response")
		}
		if join := response.GetJoin(); join != nil {
			joined = join.Room != nil && join.ServerInfo != nil && join.Room.Name == "teleop-managed-real" &&
				join.ServerInfo.Version == "1.13.11"
		}
		if token := response.GetRefreshToken(); token != "" {
			refreshed = token
		}
	}
	verifier, err := auth.ParseAPIToken(refreshed)
	if err != nil {
		t.Fatal("server returned invalid refreshed JWT")
	}
	claims, _, err := verifier.Verify(lkApiSecret)
	if err != nil || claims.Expiry == nil {
		t.Fatal("server refreshed JWT signature or expiry invalid")
	}
	if remaining := time.Until(claims.Expiry.Time()); remaining < 9*time.Minute ||
		remaining > 10*time.Minute+time.Second {
		t.Fatal("pinned server refresh lifetime no longer fits the managed quiet interval")
	}
	if err := f.runtime.roomsEmpty(ctx); !errors.Is(err, errManagedDrain) {
		t.Fatal("actual joined room did not block mutation drain")
	}
	if f.runtime.mu.TryLock() {
		f.runtime.mu.Unlock()
		t.Fatal("real upgraded signaling did not hold the mutation barrier")
	}
	_ = conn.Close()
	// Serialize after the upgraded proxy has exited, as a maintenance restart
	// would do. There is deliberately no in-test quiet-clock acceleration.
	f.runtime.mu.Lock()
	f.runtime.maintenance = true
	f.runtime.mu.Unlock()
	for _, token := range []string{original, refreshed} {
		if unexpected, err := dial(token); err == nil {
			_ = unexpected.Close()
			t.Fatal("maintenance accepted previously issued signaling credentials")
		}
	}
	response, err := server.Client().Get(server.URL + "/rtc/validate")
	if err != nil {
		t.Fatal("maintenance validation request failed")
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatal("maintenance did not reject alternate signaling validation")
	}
	// A room can remain after a signaling disconnect. Delete only the room
	// created by this disposable test, never infer cleanup from socket closure.
	adminToken, err := auth.NewAccessToken(lkApiKey, lkApiSecret).
		AddGrant(&auth.VideoGrant{RoomCreate: true}).SetValidFor(time.Minute).ToJWT()
	if err != nil {
		t.Fatal(err)
	}
	headers := make(http.Header)
	headers.Set("Authorization", "Bearer "+adminToken)
	adminCtx, err := twirp.WithHTTPRequestHeaders(ctx, headers)
	if err != nil {
		t.Fatal(err)
	}
	service := livekit.NewRoomServiceProtobufClient(rawURL, &http.Client{Timeout: 5 * time.Second})
	if _, err := service.DeleteRoom(adminCtx, &livekit.DeleteRoomRequest{Room: "teleop-managed-real"}); err != nil {
		t.Fatal("could not delete owned disposable room")
	}
	if err := f.runtime.roomsEmpty(ctx); err != nil {
		t.Fatal("disposable room cleanup not acknowledged")
	}
	if release, err := f.runtime.BeforeMutation(ctx, f.orgID); !errors.Is(err, errManagedDrain) {
		if release != nil {
			release()
		}
		t.Fatal("fresh empty observation bypassed refreshed-token quiet interval")
	}
	quietUntil, err := f.store.DrainQuietUntil(ctx)
	if err != nil || time.Until(quietUntil) < 10*time.Minute {
		t.Fatal("quiet interval was not persisted")
	}
	t.Log("real join, server refresh bound, maintenance denial and room cleanup passed; waiting actual quiet interval")
	// Reconstruct the runtime without resetting the durable observation.
	restarted := &ManagedRuntime{store: f.store, maintenance: true, roomsEmpty: f.runtime.roomsEmpty}
	if release, err := restarted.BeforeMutation(ctx, f.orgID); !errors.Is(err, errManagedDrain) {
		if release != nil {
			release()
		}
		t.Fatal("restart bypassed durable quiet interval")
	}
	timer := time.NewTimer(time.Until(quietUntil) + 100*time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		t.Fatal("real quiet interval did not finish within bounded test time")
	case <-timer.C:
	}
	release, err := restarted.BeforeMutation(ctx, f.orgID)
	if err != nil {
		t.Fatal("fully drained real server did not permit mutation after actual quiet interval")
	}
	release()
	originalRotation, rotation := pendingReplacementFixture(t, f.store, authorization.BootstrapInput{UserID: f.adminID, OrganizationID: f.orgID, Issuer: managedTestIssuer})
	hash := sha256.Sum256([]byte("rtc-replacement-fixture"))
	if err := f.store.CreateRotationTicket(ctx, f.adminID, f.orgID, rotation.Operation.ID, hash, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ConsumeInstallationTicket(ctx, hash); err != nil {
		t.Fatal(err)
	}
	replacementService := &OnboardingService{store: f.store, issuer: managedTestIssuer, acquireMutation: restarted.BeforeMutation}
	replacementClaims := &UserClaims{Organization: f.orgID, managed: &managedRequestClaims{deviceID: originalRotation.VehicleID, installationOnly: true, installationSubject: "admin/" + rotation.Operation.ProviderName, installationClient: rotation.Operation.ClientID}}
	recorder := httptest.NewRecorder()
	replacementService.completeRotation(recorder, httptest.NewRequest("POST", "/", nil), replacementClaims)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("real drained replacement activation: %d %s", recorder.Code, recorder.Body.String())
	}
	if _, err := f.store.ResolveVehicle(ctx, managedTestIssuer, "admin/"+rotation.Operation.ProviderName); err != nil {
		t.Fatal("real drained activation did not enable replacement")
	}
	t.Log("actual 11-minute interval survived runtime reconstruction and permitted drained mutation")
}
