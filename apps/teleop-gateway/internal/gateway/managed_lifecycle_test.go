package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/google/uuid"
)

func TestManagedLifecycleHTTPGuardAndIsolation(t *testing.T) {
	store, _, in := managedAdminTestStore(t)
	ctx := context.Background()
	person, err := store.RegisterPerson(ctx, in.UserID, in.OrganizationID, in.Issuer, "Member", "member")
	if err != nil {
		t.Fatal(err)
	}
	claims := &UserClaims{UserID: in.UserID, Issuer: in.Issuer}
	api := &ManagedAdminAPI{Store: store, TrustedIssuer: in.Issuer}
	mux := http.NewServeMux()
	api.Register(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), "user", claims)))
		})
	})
	version, err := store.Version(ctx)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(authorization.LifecycleRequest{IdempotencyKey: uuid.NewString(), ExpectedVersion: version, Reason: "Access review"})
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/admin/organizations/" + in.OrganizationID
	request := func(method, path, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		if w.Code != want {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("cacheable management response")
		}
		return w
	}
	path := base + "/members/" + person.UserID + "/remove"
	request("POST", path, string(payload), 503)
	api.BeforeMutation = func(context.Context, string) (func(), error) { return nil, errManagedDrain }
	request("POST", path, string(payload), 409)
	if current, _ := store.Version(ctx); current != version {
		t.Fatal("blocked mutation committed")
	}
	api.BeforeMutation = func(context.Context, string) (func(), error) { return func() {}, nil }
	response := request("POST", path, string(payload), 200)
	var op authorization.LifecycleOperation
	if err := json.Unmarshal(response.Body.Bytes(), &op); err != nil {
		t.Fatal(err)
	}
	request("POST", path, string(payload), 200)
	request("GET", base+"/lifecycle-operations/"+op.ID, "", 200)
	request("GET", base+"/people/"+person.UserID+"/registration", "", 200)
	request("GET", base+"/audit?limit=1", "", 200)
	request("GET", base+"/audit?limit=0", "", 400)
	request("GET", base+"/audit?limit=1&limit=2", "", 400)
	request("POST", path, `{"reason":"one","reason":"two"}`, 400)
	claims = &UserClaims{UserID: person.UserID, Issuer: in.Issuer}
	request("GET", base+"/audit", "", 403)
	request("GET", base+"/lifecycle-operations/"+op.ID, "", 403)
	request("POST", path, string(payload), 403)
	claims = &UserClaims{Name: "device", Issuer: in.Issuer}
	request("POST", path, string(payload), 403)
}

func TestProviderRevocationReconcilesLostUpdateAndRejectsConflict(t *testing.T) {
	service := onboardingTestService(t)
	service.config.CasdoorOrganization = "fleet"
	service.config.Certificate = "cert"
	type providerApplication struct {
		Owner        string   `json:"owner"`
		Name         string   `json:"name"`
		Organization string   `json:"organization"`
		ClientID     string   `json:"clientId"`
		ClientSecret string   `json:"clientSecret"`
		Cert         string   `json:"cert"`
		TokenFormat  string   `json:"tokenFormat"`
		GrantTypes   []string `json:"grantTypes"`
		Scopes       []struct {
			Name string `json:"name"`
		} `json:"scopes"`
	}
	app := providerApplication{Owner: "admin", Name: "vehicle", Organization: "fleet", ClientID: "client", ClientSecret: "old-fixture", Cert: "cert", TokenFormat: "JWT", GrantTypes: []string{"client_credentials"}}
	app.Scopes = append(app.Scopes, struct {
		Name string `json:"name"`
	}{"teleop:vehicle"})
	updates := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			if err := json.NewDecoder(r.Body).Decode(&app); err != nil {
				t.Error(err)
			}
			updates++
			w.WriteHeader(503)
			return
		}
		_ = json.NewEncoder(w).Encode(struct {
			Status string              `json:"status"`
			Data   providerApplication `json:"data"`
		}{"ok", app})
	}))
	defer server.Close()
	service.config.CasdoorURL = server.URL
	work := authorization.RevocationWork{ProviderName: "vehicle", ClientID: "client"}
	if err := service.revokeProviderCredential(context.Background(), work); err != nil {
		t.Fatalf("lost response not reconciled: %v", err)
	}
	if updates != 1 || app.ClientSecret == "old-fixture" {
		t.Fatal("credential was not replaced")
	}
	work.ClientID = "foreign-client"
	if err := service.revokeProviderCredential(context.Background(), work); err == nil {
		t.Fatal("foreign provider application accepted")
	}
	if updates != 1 {
		t.Fatal("conflicting client mutated")
	}
}

func pendingReplacementFixture(t *testing.T, store *authorization.Store, in authorization.BootstrapInput) (authorization.OnboardingOperation, authorization.DeviceRotation) {
	t.Helper()
	ctx := context.Background()
	op, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, authorization.OnboardingRequest{Kind: "vehicle", VehicleID: "replacement-http", Name: "Replacement", IdempotencyKey: uuid.NewString()}, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.StartOnboarding(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.BindOnboarding(ctx, op, in.Issuer, "admin/"+op.ProviderName); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("installed-fixture"))
	if err := store.CreateInstallationTicket(ctx, in.UserID, in.OrganizationID, op.ID, hash, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConsumeInstallationTicket(ctx, hash); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteInstallation(ctx, in.Issuer, op.VehicleID); err != nil {
		t.Fatal(err)
	}
	version, err := store.Version(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Lifecycle(ctx, in.UserID, in.OrganizationID, op.VehicleID, "credential_rotate", authorization.LifecycleRequest{IdempotencyKey: uuid.NewString(), ExpectedVersion: version, Reason: "Replace installed fixture"}, true, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	work, err := store.NextRevocation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RecordRevocation(ctx, work, ""); err != nil {
		t.Fatal(err)
	}
	rotation, err := store.NextRotation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.BindRotation(ctx, rotation, in.Issuer); err != nil {
		t.Fatal(err)
	}
	return op, rotation
}

func TestReplacementIdentityCanOnlyVerifyInstallation(t *testing.T) {
	store, _, in := managedAdminTestStore(t)
	ctx := context.Background()
	op, rotation := pendingReplacementFixture(t, store, in)
	runtime := &ManagedRuntime{store: store, issuer: in.Issuer}
	original := UserClaims{Name: "admin/" + rotation.Operation.ProviderName, Issuer: in.Issuer, TokenType: "access-token", Scopes: []string{"teleop:vehicle"}, Audiences: []string{rotation.Operation.ClientID}}
	for _, route := range []struct {
		method, path string
		allowed      bool
	}{
		{"GET", "/api/auth/me", true}, {"GET", "/api/vehicles/replacement-http/device-auth-check", true}, {"POST", "/api/vehicles/replacement-http/installation-complete", true},
		{"POST", "/api/vehicles/replacement-http/state", false}, {"GET", "/api/vehicles/replacement-http/media-demand", false}, {"GET", "/api/vehicles/other/device-auth-check", false}, {"GET", "/api/admin/context", false},
	} {
		request := httptest.NewRequest(route.method, route.path, nil)
		bound, err := runtime.installingClaims(request, &original)
		if route.allowed {
			if err != nil || bound.managed == nil || !bound.managed.installationOnly {
				t.Fatalf("verification route denied: %s %v", route.path, err)
			}
		} else if err == nil {
			t.Fatalf("pending identity escaped: %s", route.path)
		}
	}
	original.Name = "admin/" + op.ProviderName
	if _, err := runtime.installingClaims(httptest.NewRequest("GET", "/api/auth/me", nil), &original); err == nil {
		t.Fatal("old JWT verified replacement")
	}
	service := onboardingTestService(t)
	service.store = store
	service.issuer = in.Issuer
	service.acquireMutation = func(context.Context, string) (func(), error) { return nil, errManagedDrain }
	claims := &UserClaims{Organization: in.OrganizationID, managed: &managedRequestClaims{deviceID: op.VehicleID, installationOnly: true, installationSubject: "admin/" + rotation.Operation.ProviderName, installationClient: rotation.Operation.ClientID}}
	recorder := httptest.NewRecorder()
	service.completeRotation(recorder, httptest.NewRequest("POST", "/", nil), claims)
	if recorder.Code != 409 {
		t.Fatalf("activation bypassed drain: %d", recorder.Code)
	}
	if _, err := store.ResolveVehicle(ctx, in.Issuer, "admin/"+rotation.Operation.ProviderName); err == nil {
		t.Fatal("blocked activation enabled device")
	}
}

func TestFirstAuthenticatedObservationExcludesDeniedAndDeviceRequests(t *testing.T) {
	f := newManagedFixture(t)
	ctx := context.Background()
	before, err := f.store.Registration(ctx, f.adminID, f.orgID, f.viewerID, "person")
	if err != nil || before.FirstAuthenticatedAt != nil {
		t.Fatal("unvisited fixture already observed")
	}
	f.request(t, "GET", "/api/vehicles/car-one/device-auth-check", "device-one", "", "", 204)
	f.request(t, "GET", "/api/vehicles/car-other/state", "viewer", "", "", 403)
	f.request(t, "GET", "/api/auth/me", "unbound-subject", "", "", 403)
	viewer, err := f.store.Registration(ctx, f.adminID, f.orgID, f.viewerID, "person")
	if err != nil {
		t.Fatal(err)
	}
	if viewer.FirstAuthenticatedAt != nil {
		t.Fatal("denied organization resolution recorded authentication")
	}
	f.request(t, "GET", "/api/auth/me", "viewer", "", "", 200)
	first, err := f.store.Registration(ctx, f.adminID, f.orgID, f.viewerID, "person")
	if err != nil || first.FirstAuthenticatedAt == nil {
		t.Fatal("verified request observation missing")
	}
	f.request(t, "GET", "/api/auth/me", "viewer", "", "", 200)
	second, err := f.store.Registration(ctx, f.adminID, f.orgID, f.viewerID, "person")
	if err != nil || !first.FirstAuthenticatedAt.Equal(*second.FirstAuthenticatedAt) {
		t.Fatal("first observation replaced")
	}
}

func TestReplacementRemovalRecoveryFencesOldClaims(t *testing.T) {
	store, _, in := managedAdminTestStore(t)
	original, rotation := pendingReplacementFixture(t, store, in)
	ctx := context.Background()
	hash := sha256.Sum256([]byte("cancelled-replacement"))
	if err := store.CreateRotationTicket(ctx, in.UserID, in.OrganizationID, rotation.Operation.ID, hash, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConsumeInstallationTicket(ctx, hash); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"vehicle_remove", "credential_rotate"} {
		version, err := store.Version(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.Lifecycle(ctx, in.UserID, in.OrganizationID, original.VehicleID, action, authorization.LifecycleRequest{IdempotencyKey: uuid.NewString(), ExpectedVersion: version, Reason: "Recover interrupted replacement"}, true, make([]byte, 32)); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
	}
	subject := "admin/" + rotation.Operation.ProviderName
	if err := store.CompleteRotation(ctx, in.Issuer, original.VehicleID, subject, rotation.Operation.ClientID); err == nil {
		t.Fatal("cancelled claims activated a later replacement")
	}
	if _, err := store.ResolveInstallingVehicle(ctx, in.Issuer, subject); err == nil {
		t.Fatal("cancelled claims retained installation access")
	}
}
