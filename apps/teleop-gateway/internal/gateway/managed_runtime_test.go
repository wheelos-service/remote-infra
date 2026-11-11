package gateway

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/go-jose/go-jose/v3"
	"github.com/go-jose/go-jose/v3/jwt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/redis/go-redis/v9"
)

const managedTestIssuer = "https://managed-idp.example"

func TestManagedAdditiveGuardCoexistsWithRTCReader(t *testing.T) {
	runtime := &ManagedRuntime{}
	runtime.mu.RLock()
	done := make(chan error, 1)
	go func() {
		release, err := runtime.BeforeAdditive(context.Background(), "")
		if err == nil {
			release()
		}
		done <- err
	}()
	select {
	case err := <-done:
		runtime.mu.RUnlock()
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		runtime.mu.RUnlock()
		<-done
		t.Fatal("fresh onboarding blocked on an existing RTC reader")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if release, err := runtime.BeforeAdditive(ctx, ""); err == nil || release != nil {
		t.Fatal("cancelled additive mutation was admitted")
	}
	release, err := runtime.BeforeAdditive(context.Background(), "")
	if err != nil {
		t.Fatal("cancelled request leaked mutation guard")
	}
	release()
}

func TestManagedAuthorizationConfigurationSeparation(t *testing.T) {
	for _, name := range []string{"AUTHORIZATION_MODE", "AUTH_MODE", "AUTHORIZATION_DATABASE_URL",
		"OIDC_ISSUER", "LIVEKIT_URL", "AUTHORIZATION_POLICY_FILE", "VEHICLE_REGISTRY_JSON",
		"VEHICLE_SUBJECT_MAP_JSON", "VEHICLE_ACL_JSON", "AUTHORIZATION_MANAGED_MAINTENANCE"} {
		t.Setenv(name, "")
	}
	t.Setenv("AUTH_MODE", "dev")
	if managed, err := managedAuthorizationConfigured(); err != nil || managed {
		t.Fatalf("legacy default = %v, %v", managed, err)
	}
	t.Setenv("AUTHORIZATION_MODE", "managed")
	t.Setenv("AUTHORIZATION_DATABASE_URL", "postgres://unused")
	t.Setenv("OIDC_ISSUER", managedTestIssuer)
	t.Setenv("LIVEKIT_URL", "https://livekit.example")
	t.Setenv("AUTHORIZATION_LIVEKIT_SERVER_VERSION", "v1.13.11")
	t.Setenv("AUTHORIZATION_LIVEKIT_INGRESS_GATED", "true")
	if _, err := managedAuthorizationConfigured(); err == nil {
		t.Fatal("managed mode accepted development authentication")
	}
	t.Setenv("AUTH_MODE", "oidc")
	for _, name := range []string{"AUTHORIZATION_POLICY_FILE", "VEHICLE_REGISTRY_JSON",
		"VEHICLE_SUBJECT_MAP_JSON", "VEHICLE_ACL_JSON"} {
		t.Setenv(name, "[]")
		if _, _, _, err := NewAuthorizationPolicyFromEnvironment(); err == nil {
			t.Fatalf("managed mode accepted nonempty legacy configuration %s", name)
		}
		t.Setenv(name, "")
	}
	registry, identities, _, err := NewAuthorizationPolicyFromEnvironment()
	if err != nil || len(registry.vehicles) != 0 || !identities.Strict() {
		t.Fatalf("managed placeholders = %#v, %#v, %v", registry, identities, err)
	}
	t.Setenv("AUTHORIZATION_MODE", "unknown")
	if _, err := managedAuthorizationConfigured(); err == nil {
		t.Fatal("unknown authorization mode accepted")
	}
}

type managedFixture struct {
	db         *sql.DB
	store      *authorization.Store
	runtime    *ManagedRuntime
	mux        *http.ServeMux
	client     *redis.Client
	redis      *miniredis.Miniredis
	orgID      string
	otherOrgID string
	adminID    string
	viewerID   string
	operatorID string
	schema     string
}

func newManagedFixture(t *testing.T) *managedFixture {
	t.Helper()
	dsn := os.Getenv("AUTHZ_POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("set AUTHZ_POSTGRES_TEST_DSN for real PostgreSQL managed-runtime tests")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	adminDB := stdlib.OpenDB(*config)
	schema := "managed_runtime_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := adminDB.Exec(`CREATE SCHEMA ` + schema); err != nil {
		adminDB.Close()
		t.Fatal(err)
	}
	local := config.Copy()
	local.RuntimeParams["search_path"] = schema
	db := stdlib.OpenDB(*local)
	db.SetMaxOpenConns(8)
	t.Cleanup(func() {
		_ = db.Close()
		_, _ = adminDB.Exec(`DROP SCHEMA ` + schema + ` CASCADE`)
		_ = adminDB.Close()
	})
	store, err := authorization.NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	f := &managedFixture{db: db, store: store, orgID: uuid.NewString(),
		otherOrgID: uuid.NewString(), adminID: uuid.NewString(), mux: http.NewServeMux(), schema: schema}
	for _, bootstrap := range []authorization.BootstrapInput{
		{OrganizationID: f.orgID, OrganizationName: "Pilot", UserID: f.adminID,
			Name: "Platform operator", Issuer: managedTestIssuer, Subject: "admin"},
		{OrganizationID: f.otherOrgID, OrganizationName: "Other", UserID: uuid.NewString(),
			Name: "Other operator", Issuer: managedTestIssuer, Subject: "other-admin"},
	} {
		if err := store.Bootstrap(ctx, bootstrap); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct{ vehicle, org, subject string }{
		{"car-one", f.orgID, "device-one"}, {"car-two", f.orgID, "device-two"},
		{"car-other", f.otherOrgID, "device-other"},
	} {
		if _, err := store.RegisterVehicle(ctx, f.adminID, row.org, managedTestIssuer,
			row.vehicle, "Name "+row.vehicle, row.subject); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct {
		subject string
		role    authorization.Role
	}{
		{"viewer", authorization.RoleViewer}, {"operator", authorization.RoleRemoteOperator},
		{"roleless", ""},
	} {
		person, err := store.RegisterPerson(ctx, f.adminID, f.orgID, managedTestIssuer, row.subject, row.subject)
		if err != nil {
			t.Fatal(err)
		}
		if row.role != "" {
			if _, err := store.AssignManagedRole(ctx, authorization.Assignment{ActorUserID: f.adminID,
				UserID: person.UserID, OrganizationID: f.orgID, Role: row.role,
				Scope: authorization.ScopeSelected, VehicleIDs: []string{"car-one"}}); err != nil {
				t.Fatal(err)
			}
		}
		if row.subject == "viewer" {
			f.viewerID = person.UserID
		}
		if row.subject == "operator" {
			f.operatorID = person.UserID
		}
	}
	f.redis = miniredis.RunT(t)
	f.client = redis.NewClient(&redis.Options{Addr: f.redis.Addr(), MaxRetries: -1})
	t.Cleanup(func() { _ = f.client.Close() })
	f.runtime = &ManagedRuntime{store: store, issuer: managedTestIssuer,
		roomsEmpty: func(context.Context) error { return nil }}
	previousRuntime, previousAuth := managedRuntime, authenticator
	previousRegistry, previousAuthorizer, previousIdentities := vehicleRegistry, vehicleAuthorizer, vehicleIdentities
	previousLeases, previousVideo, previousAudit := controlLeases, videoSessions, auditSink
	previousKey, previousSecret := lkApiKey, lkApiSecret
	t.Cleanup(func() {
		managedRuntime, authenticator = previousRuntime, previousAuth
		vehicleRegistry, vehicleAuthorizer, vehicleIdentities = previousRegistry, previousAuthorizer, previousIdentities
		controlLeases, videoSessions, auditSink = previousLeases, previousVideo, previousAudit
		lkApiKey, lkApiSecret = previousKey, previousSecret
	})
	managedRuntime = f.runtime
	authenticator = diagnosticAuthenticator(func(_ context.Context, subject string) (*UserClaims, error) {
		return &UserClaims{Name: subject, Issuer: managedTestIssuer, Organization: "untrusted-org",
			Roles:  []string{"admin", "controller", "vehicle"},
			Scopes: []string{"teleop:observe", "teleop:vehicle", "teleop:control"}}, nil
	})
	vehicleRegistry = &VehicleRegistry{byID: map[string]RegisteredVehicle{}}
	vehicleAuthorizer = &VehicleAuthorizer{}
	vehicleIdentities = &VehicleIdentityResolver{bySubject: map[string]string{}, strict: true}
	controlLeases = &ControlLeaseStore{client: f.client, ttl: time.Minute}
	videoSessions = NewVideoSessionStore(f.client, 0)
	auditSink = NewJSONAuditSink(io.Discard)
	lkApiKey, lkApiSecret = "managed-test-key", "managed-test-secret-long-enough-for-tests"
	(&VehicleTelemetryAPI{registry: vehicleRegistry, identities: vehicleIdentities,
		authorizer: vehicleAuthorizer, states: NewVehicleTelemetryStore(f.client, nil),
		leases: controlLeases}).register(f.mux)
	(&ViewingLeaseAPI{registry: vehicleRegistry, identities: vehicleIdentities,
		authorizer: vehicleAuthorizer, store: &ViewingLeaseStore{client: f.client}}).register(f.mux)
	(&ManagedAdminAPI{Store: store, TrustedIssuer: managedTestIssuer,
		BeforeMutation: f.runtime.BeforeMutation, BeforeAdditive: f.runtime.BeforeAdditive,
		Runtime: f.runtime}).Register(f.mux, AuthenticationMiddleware)
	registerSessionAndTokenRoutes(f.mux)
	(&DataAPI{registry: vehicleRegistry, identities: vehicleIdentities,
		authorizer: vehicleAuthorizer}).register(f.mux)
	return f
}

func (f *managedFixture) request(t *testing.T, method, path, subject, org, body string, status int) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+subject)
	if org != "" {
		r.Header.Set("X-Organization-ID", org)
	}
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s [%s] => %d %s, want %d", method, path, subject, w.Code, w.Body.String(), status)
	}
	return w
}

func TestManagedRuntimePostgresMemberContextAndOrganizationSelection(t *testing.T) {
	f := newManagedFixture(t)
	ctx := context.Background()
	w := f.request(t, "GET", "/api/organizations/context", "viewer", "", "", 200)
	var mode struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &mode); err != nil || mode.Mode != "managed" {
		t.Fatalf("managed context mode missing: %s", w.Body.String())
	}
	var result authorization.MemberContext
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Organizations) != 1 || result.Organizations[0].OrganizationID != f.orgID ||
		result.Organizations[0].Role != authorization.RoleViewer || result.Organizations[0].CanManage {
		t.Fatalf("member context leaks management or other organizations: %s", w.Body.String())
	}
	f.request(t, "GET", "/api/organizations/context", "unknown", "", "", 403)
	f.request(t, "GET", "/api/organizations/context", "device-one", "", "", 403)
	f.request(t, "GET", "/api/admin/context", "viewer", "", "", 403)
	if _, err := f.store.AddExistingMember(ctx, f.adminID, f.otherOrgID, managedTestIssuer, "viewer"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AssignManagedRole(ctx, authorization.Assignment{ActorUserID: f.adminID,
		UserID: f.viewerID, OrganizationID: f.otherOrgID, Role: authorization.RoleViewer, Scope: authorization.ScopeAll}); err != nil {
		t.Fatal(err)
	}
	w = f.request(t, "GET", "/api/organizations/context", "viewer", "", "", 200)
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Organizations) != 2 {
		t.Fatalf("multi-member context unavailable: %s %v", w.Body.String(), err)
	}
	f.request(t, "GET", "/api/vehicles", "viewer", "", "", 409)
	for _, entry := range []struct{ org, included, excluded string }{
		{f.orgID, "car-one", "car-other"}, {f.otherOrgID, "car-other", "car-one"},
	} {
		w = f.request(t, "GET", "/api/vehicles", "viewer", entry.org, "", 200)
		if !strings.Contains(w.Body.String(), entry.included) || strings.Contains(w.Body.String(), entry.excluded) {
			t.Fatalf("server did not isolate selected organization: %s", w.Body.String())
		}
	}
	f.request(t, "GET", "/api/vehicles/car-one/state", "viewer", f.otherOrgID, "", 403)
	if _, err := f.db.Exec(`UPDATE authz_organization_memberships SET status='removed' WHERE user_id=$1 AND org_id=$2`,
		f.viewerID, f.otherOrgID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/vehicles", "viewer", f.otherOrgID, "", 403)
	w = f.request(t, "GET", "/api/organizations/context", "viewer", "", "", 200)
	if strings.Contains(w.Body.String(), f.otherOrgID) {
		t.Fatalf("removed membership remains selectable: %s", w.Body.String())
	}
	// Even platform admins cannot create/rebind an identity via existing-member addition.
	if _, err := f.store.AddExistingMember(ctx, f.adminID, f.orgID, managedTestIssuer, "unknown-bound-subject"); !errors.Is(err, authorization.ErrIdentityBindingRestricted) {
		t.Fatalf("unknown existing subject = %v", err)
	}
	if _, err := f.store.ResolveUser(ctx, managedTestIssuer, "unknown-bound-subject"); !errors.Is(err, authorization.ErrUnknownIdentity) {
		t.Fatalf("existing-member path created an identity: %v", err)
	}
	f.request(t, "POST", "/api/admin/organizations/"+f.orgID+"/members", "viewer", "", `{"subject":"operator"}`, 403)
	f.request(t, "POST", "/api/admin/organizations/"+f.otherOrgID+"/members", "admin", "", `{"subject":"operator","email":"merge@example.test"}`, 400)
	f.request(t, "POST", "/api/admin/organizations/"+f.otherOrgID+"/members", "admin", "", `{"subject":"operator"}`, 409)
	f.runtime.maintenance = true
	f.request(t, "POST", "/api/admin/organizations/"+f.otherOrgID+"/members", "admin", "", `{"subject":"operator"}`, 409)
	if err := f.store.SetDrainQuietUntil(ctx, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	w = f.request(t, "POST", "/api/admin/organizations/"+f.otherOrgID+"/members", "admin", "", `{"subject":"operator"}`, 201)
	if !strings.Contains(w.Body.String(), f.operatorID) {
		t.Fatalf("existing member did not retain trusted user binding: %s", w.Body.String())
	}
	f.request(t, "POST", "/api/admin/organizations/"+f.otherOrgID+"/members", "admin", "", `{"subject":"operator"}`, 409)
	f.request(t, "POST", "/api/admin/organizations/"+f.otherOrgID+"/members", "admin", "", `{"subject":"no-such-identity"}`, 403)
}

func TestManagedRuntimePostgresIdentityAndResourceBoundaries(t *testing.T) {
	f := newManagedFixture(t)
	w := f.request(t, "GET", "/api/auth/me", "viewer", "", "", 200)
	var me map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if len(me) != 4 || me["Name"] != f.viewerID || me["Organization"] != f.orgID ||
		me["Roles"].([]any)[0] != "viewer" {
		t.Fatalf("legacy auth/me shape or DB identity changed: %s", w.Body.String())
	}
	f.request(t, "GET", "/api/vehicles/car-one/state", "viewer", "", "", 200)
	f.request(t, "GET", "/api/vehicles/car-two/state", "viewer", "", "", 200)
	f.request(t, "GET", "/api/vehicles/car-other/state", "viewer", "", "", 403)
	f.request(t, "GET", "/api/vehicles/car-one/state", "viewer", f.otherOrgID, "", 403)
	f.request(t, "GET", "/api/vehicles/car-one/state", "roleless", "", "", 200)
	f.request(t, "GET", "/api/vehicles/car-one/state", "unknown", "", "", 403)
	w = f.request(t, "GET", "/api/vehicles", "viewer", "", "", 200)
	if !strings.Contains(w.Body.String(), "car-one") || !strings.Contains(w.Body.String(), "car-two") || strings.Contains(w.Body.String(), "car-other") {
		t.Fatalf("member read baseline is incomplete or crossed organizations: %s", w.Body.String())
	}
	f.request(t, "GET", "/api/vehicles/car-one/state", "admin", "", "", 200)
	f.request(t, "GET", "/api/token/operator?vid=car-one&access=controller", "admin", "", "", 403)
	f.request(t, "GET", "/api/token/operator?vid=car-one&access=observer", "admin", "", "", 200)
	f.request(t, "GET", "/api/token/operator?vid=car-one&access=controller", "operator", "", "", 403)
	f.request(t, "POST", "/api/vehicles/car-one/control/acquire", "operator", "",
		`{"public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`, 403)
	f.request(t, "POST", "/api/vehicles/car-one/data/tasks", "operator", "", `{}`, 403)
	f.request(t, "POST", "/api/vehicles/car-one/data/events/event/acknowledge", "operator", "", `{}`, 403)
	f.request(t, "GET", "/api/vehicles/car-one/data/tasks/next", "device-one", "", "", 403)
	f.request(t, "GET", "/api/vehicles/car-two/device-auth-check", "device-one", "", "", 403)
	f.request(t, "GET", "/api/vehicles/car-one/device-auth-check", "device-one", "", "", 204)
	f.request(t, "GET", "/api/vehicles/car-two/video", "device-one", "", "", 403)
	otherVideo, err := videoSessions.AcquireViewer(context.Background(), "car-other")
	if err != nil {
		t.Fatal(err)
	}
	f.request(t, "POST", "/api/video/"+otherVideo.SessionID+"/release", "viewer", "", "", 403)
	f.request(t, "POST", "/api/video/"+otherVideo.SessionID+"/release", "device-one", "", "", 403)
	f.request(t, "POST", "/api/vehicles/car-one/state", "device-one", "",
		telemetryBody("car-one", "managed-stream", 1), 204)
	if len(vehicleRegistry.byID) != 0 || len(vehicleIdentities.bySubject) != 0 {
		t.Fatal("request mutated global legacy registry or identities")
	}
	shared := &UserClaims{Name: "viewer", Issuer: managedTestIssuer,
		Roles: []string{"admin"}, Scopes: []string{"teleop:observe"}}
	authenticator = diagnosticAuthenticator(func(context.Context, string) (*UserClaims, error) { return shared, nil })
	f.request(t, "GET", "/api/auth/me", "any", "", "", 200)
	f.request(t, "GET", "/api/auth/me", "any", "", "", 200)
	if shared.Name != "viewer" || shared.Roles[0] != "admin" || shared.managed != nil {
		t.Fatal("request mutated authenticator-owned identity claims")
	}
	shared.Issuer = "https://attacker.example"
	f.request(t, "GET", "/api/auth/me", "any", "", "", 403)
}

func TestManagedRuntimePostgresFreshRegistryAndOrganizationBootstrap(t *testing.T) {
	f := newManagedFixture(t)
	ctx := context.Background()
	if _, err := f.store.AssignManagedRole(ctx, authorization.Assignment{ActorUserID: f.adminID,
		UserID: f.viewerID, OrganizationID: f.orgID, Role: authorization.RoleViewer,
		Scope: authorization.ScopeAll}); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/vehicles/car-new/state", "viewer", "", "", 403)
	if _, err := f.store.RegisterVehicle(ctx, f.adminID, f.orgID, managedTestIssuer,
		"car-new", "Added live", "device-new"); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/vehicles/car-new/state", "viewer", "", "", 200)
	f.request(t, "GET", "/api/vehicles/car-new/device-auth-check", "device-new", "", "", 204)
	if _, err := f.store.AssignManagedRole(ctx, authorization.Assignment{ActorUserID: f.adminID,
		UserID: f.viewerID, OrganizationID: f.orgID, Role: authorization.RoleViewer,
		Scope: authorization.ScopeSelected, VehicleIDs: []string{"car-one"}}); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/vehicles/car-new/state", "viewer", "", "", 200)
	if _, err := f.store.AssignManagedRole(ctx, authorization.Assignment{ActorUserID: f.adminID,
		UserID: f.viewerID, OrganizationID: f.orgID, Role: authorization.RoleViewer,
		Scope: authorization.ScopeSelected}); err == nil {
		t.Fatal("empty selected range unexpectedly widened permissions")
	}
	if _, err := f.db.Exec(`UPDATE authz_vehicles SET status='disabled' WHERE vehicle_id='car-one'`); err != nil {
		t.Fatal(err)
	}
	w := f.request(t, "GET", "/api/vehicles", "viewer", "", "", 200)
	if strings.Contains(w.Body.String(), `"vehicle_id":"car-one"`) || !strings.Contains(w.Body.String(), `"vehicle_id":"car-new"`) || !strings.Contains(w.Body.String(), `"vehicle_id":"car-two"`) {
		t.Fatalf("inactive vehicle visible or active member baseline lost: %s", w.Body.String())
	}
	f.request(t, "GET", "/api/vehicles/car-one/state", "viewer", "", "", 403)
	f.request(t, "GET", "/api/vehicles/car-one/device-auth-check", "device-one", "", "", 403)
	if _, err := f.db.Exec(`INSERT INTO authz_organization_memberships(org_id,user_id,status) VALUES($1,$2,'active')`,
		f.otherOrgID, f.adminID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/vehicles", "admin", "", "", 409)
	f.request(t, "GET", "/api/vehicles", "admin", f.orgID, "", 200)
	w = f.request(t, "GET", "/api/auth/me", "admin", "", "", 200)
	if !strings.Contains(w.Body.String(), `"Organization":""`) ||
		!strings.Contains(w.Body.String(), `"Roles":[]`) {
		t.Fatalf("ambiguous auth bootstrap implied authority: %s", w.Body.String())
	}
	f.request(t, "GET", "/api/admin/context", "admin", "", "", 200)
	f.request(t, "GET", "/api/admin/organizations/"+f.orgID+"/people", "admin", "", "", 200)
	f.request(t, "GET", "/api/admin/organizations/"+f.orgID+"/people", "admin", f.otherOrgID, "", 403)
	f.request(t, "GET", "/api/admin/context", "viewer", "", "", 403)
	if _, err := f.db.Exec(`UPDATE authz_organization_memberships SET status='removed' WHERE user_id=$1`, f.adminID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/auth/me", "admin", "", "", 200)
	f.request(t, "GET", "/api/admin/context", "admin", "", "", 200)
	f.request(t, "GET", "/api/vehicles", "admin", "", "", 403)
}

func TestManagedRuntimePostgresMemberBaselineAndOperationScope(t *testing.T) {
	f := newManagedFixture(t)
	ctx := context.Background()
	assignment := authorization.Assignment{ActorUserID: f.adminID, UserID: f.operatorID,
		OrganizationID: f.orgID, Role: authorization.RoleRemoteOperator, Scope: authorization.ScopeNone}
	if _, err := f.store.AssignManagedRole(ctx, assignment); err != nil {
		t.Fatal(err)
	}
	version, err := f.store.Version(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Both existing assignments and members with no assignment receive read
	// access to later vehicles, without rewriting policies or operation scope.
	if _, err := f.store.RegisterVehicle(ctx, f.adminID, f.orgID, managedTestIssuer,
		"car-later", "Later car", "device-later"); err != nil {
		t.Fatal(err)
	}
	for _, subject := range []string{"operator", "viewer", "roleless", "admin"} {
		f.request(t, "GET", "/api/vehicles/car-later/state", subject, "", "", 200)
		f.request(t, "GET", "/api/token/operator?vid=car-later&access=observer", subject, "", "", 200)
		f.request(t, "GET", "/api/vehicles/car-other/state", subject, f.orgID, "", 403)
		f.request(t, "POST", "/api/vehicles/car-later/control/acquire", subject, "", `{}`, 403)
	}
	person, err := f.store.UserAssignment(ctx, f.operatorID, f.orgID)
	if err != nil || person.Scope != authorization.ScopeNone {
		t.Fatalf("read baseline altered existing operation scope: %+v %v", person, err)
	}
	if current, err := f.store.Version(ctx); err != nil || current != version+1 {
		t.Fatalf("read checks rewrote policies: version %d, previous %d, error %v", current, version, err)
	}
	assignment.Scope, assignment.VehicleIDs = authorization.ScopeSelected, []string{"car-one"}
	if _, err := f.store.AssignManagedRole(ctx, assignment); err != nil {
		t.Fatal(err)
	}
	for _, vehicle := range []string{"car-one", "car-two", "car-later"} {
		allowed, err := f.store.Enforce(ctx, f.operatorID, f.orgID, vehicle, authorization.ActionRemoteControl)
		if err != nil || allowed != (vehicle == "car-one") {
			t.Fatalf("selected execution scope %s: %v %v", vehicle, allowed, err)
		}
		f.request(t, "GET", "/api/vehicles/"+vehicle+"/state", "operator", "", "", 200)
	}
	f.request(t, "POST", "/api/vehicles/car-two/control/acquire", "operator", "", `{}`, 403)
	contextResponse := f.request(t, "GET", "/api/organizations/context", "operator", "", "", 200)
	var member authorization.MemberContext
	if err := json.Unmarshal(contextResponse.Body.Bytes(), &member); err != nil ||
		len(member.Organizations) != 1 || member.Organizations[0].Scope != authorization.ScopeSelected ||
		!slices.Equal(member.Organizations[0].VehicleIDs, []string{"car-one"}) {
		t.Fatalf("trusted operation scope not returned: %s %v", contextResponse.Body.String(), err)
	}
	assignment.Role, assignment.Scope, assignment.VehicleIDs = authorization.RoleViewer, authorization.ScopeAll, nil
	if _, err := f.store.AssignManagedRole(ctx, assignment); err != nil {
		t.Fatal(err)
	}
	f.request(t, "POST", "/api/vehicles/car-one/control/acquire", "operator", "", `{}`, 403)
	for _, lifecycle := range []struct {
		table, condition, inactive string
		args                       []any
	}{
		{"authz_organization_memberships", "user_id=$1 AND org_id=$2", "suspended", []any{f.operatorID, f.orgID}},
		{"authz_users", "user_id=$1", "disabled", []any{f.operatorID}},
		{"authz_organizations", "org_id=$1", "disabled", []any{f.orgID}},
		{"authz_vehicles", "vehicle_id=$1", "disabled", []any{"car-later"}},
	} {
		if _, err := f.db.Exec("UPDATE "+lifecycle.table+" SET status='"+lifecycle.inactive+"' WHERE "+lifecycle.condition, lifecycle.args...); err != nil {
			t.Fatal(err)
		}
		f.request(t, "GET", "/api/vehicles/car-later/state", "operator", "", "", 403)
		f.request(t, "GET", "/api/token/operator?vid=car-later&access=observer", "operator", "", "", 403)
		if _, err := f.db.Exec("UPDATE "+lifecycle.table+" SET status='active' WHERE "+lifecycle.condition, lifecycle.args...); err != nil {
			t.Fatal(err)
		}
		f.request(t, "GET", "/api/vehicles/car-later/state", "operator", "", "", 200)
	}
}

func TestManagedRuntimePostgresExclusiveInstanceAndLockLoss(t *testing.T) {
	f := newManagedFixture(t)
	dsn, err := url.Parse(os.Getenv("AUTHZ_POSTGRES_TEST_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	query := dsn.Query()
	query.Set("search_path", f.schema)
	dsn.RawQuery = query.Encode()
	for _, name := range []string{"AUTHORIZATION_POLICY_FILE", "VEHICLE_REGISTRY_JSON",
		"VEHICLE_SUBJECT_MAP_JSON", "VEHICLE_ACL_JSON"} {
		t.Setenv(name, "")
	}
	t.Setenv("AUTHORIZATION_MODE", "managed")
	t.Setenv("AUTH_MODE", "oidc")
	t.Setenv("AUTHORIZATION_DATABASE_URL", dsn.String())
	t.Setenv("AUTHORIZATION_MANAGED_MAINTENANCE", "true")
	t.Setenv("OIDC_ISSUER", managedTestIssuer)
	t.Setenv("LIVEKIT_URL", "https://livekit.example")
	t.Setenv("AUTHORIZATION_LIVEKIT_SERVER_VERSION", "v1.13.11")
	t.Setenv("AUTHORIZATION_LIVEKIT_INGRESS_GATED", "true")
	first, err := NewManagedRuntimeFromEnvironment(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := NewManagedRuntimeFromEnvironment(context.Background()); err == nil {
		second.Close()
		t.Fatal("second managed Gateway acquired the same PostgreSQL pilot")
	}
	managedRuntime = first
	f.request(t, "GET", "/api/auth/me", "viewer", "", "", 200)
	var pid int
	if err := first.instance.QueryRowContext(context.Background(), `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	var terminated bool
	if err := f.db.QueryRow(`SELECT pg_terminate_backend($1)`, pid).Scan(&terminated); err != nil || !terminated {
		t.Fatalf("terminate isolated advisory-lock session: %v, %v", terminated, err)
	}
	f.request(t, "GET", "/api/auth/me", "viewer", "", "", 503)
	if _, err := first.BeforeMutation(context.Background(), f.orgID); err == nil {
		t.Fatal("lost lifetime advisory lock did not disable mutation guard")
	}
}

func TestManagedRuntimeMultiInstanceAndPostgresOperationsStore(t *testing.T) {
	f := newManagedFixture(t)
	dsn, err := url.Parse(os.Getenv("AUTHZ_POSTGRES_TEST_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	query := dsn.Query()
	query.Set("search_path", f.schema)
	dsn.RawQuery = query.Encode()
	for _, name := range []string{"AUTHORIZATION_POLICY_FILE", "VEHICLE_REGISTRY_JSON",
		"VEHICLE_SUBJECT_MAP_JSON", "VEHICLE_ACL_JSON"} {
		t.Setenv(name, "")
	}
	t.Setenv("AUTHORIZATION_MODE", "managed")
	t.Setenv("AUTH_MODE", "oidc")
	t.Setenv("AUTHORIZATION_DATABASE_URL", dsn.String())
	t.Setenv("AUTHORIZATION_MULTI_INSTANCE", "true")
	t.Setenv("OIDC_ISSUER", managedTestIssuer)
	t.Setenv("LIVEKIT_URL", "https://livekit.example")
	t.Setenv("AUTHORIZATION_LIVEKIT_SERVER_VERSION", "v1.13.11")
	t.Setenv("AUTHORIZATION_LIVEKIT_INGRESS_GATED", "true")

	first, err := NewManagedRuntimeFromEnvironment(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := NewManagedRuntimeFromEnvironment(context.Background())
	if err != nil {
		t.Fatalf("second multi-instance Gateway failed to start: %v", err)
	}
	defer second.Close()

	managedRuntime = second
	f.request(t, "GET", "/api/auth/me", "viewer", "", "", 200)

	opsA, err := OpenPostgresOperationsStore(dsn.String())
	if err != nil {
		t.Fatalf("open postgres operations store A: %v", err)
	}
	defer opsA.Close()
	opsB, err := OpenPostgresOperationsStore(dsn.String())
	if err != nil {
		t.Fatalf("open postgres operations store B: %v", err)
	}
	defer opsB.Close()
	if err := opsA.Ping(context.Background()); err != nil {
		t.Fatalf("ping postgres operations store: %v", err)
	}
	if err := opsA.RecordMission(context.Background(), "car-one", OperationsMission{
		MissionID: "mission-1", Status: "running", UpdatedAtMS: 1700000000000, Description: "cross-instance mission",
	}); err != nil {
		t.Fatalf("record mission on instance A: %v", err)
	}
	snap, err := opsB.Snapshot(context.Background(), "car-one")
	if err != nil || len(snap.Missions) != 1 || snap.Missions[0].MissionID != "mission-1" {
		t.Fatalf("read mission from instance B: %+v, err=%v", snap, err)
	}
	nowMS := time.Now().UnixMilli()
	taskRaw := []byte(fmt.Sprintf(`{"schema_version":1,"type":"vehicle_task","vehicle_id":"car-one","request_id":"task-pg-1","created_at_ms":%d,"expires_at_ms":%d,"command":"navigate","parameters":{"target":"dock-a"}}`, nowMS, nowMS+60000))
	if err := opsA.createDataTask(context.Background(), "car-one", "task-pg-1", taskRaw); err != nil {
		t.Fatalf("create data task on instance A: %v", err)
	}
	pending, err := opsB.pendingDataTask(context.Background(), "car-one")
	if err != nil || len(pending) == 0 {
		t.Fatalf("read pending task from instance B: %s, err=%v", string(pending), err)
	}
	capView, err := opsB.dataCapacity(context.Background(), "car-one")
	if err != nil || capView["tasks_pending"] != 1 {
		t.Fatalf("data capacity from instance B: %+v, err=%v", capView, err)
	}
	recordsView, err := opsB.dataRecords(context.Background(), "car-one", "tasks", 0, 0)
	if err != nil || len(recordsView["records"].([]map[string]any)) != 1 {
		t.Fatalf("data records from instance B: %+v, err=%v", recordsView, err)
	}
}

func TestManagedRuntimeOnlineLifecycleAndLeaseEviction(t *testing.T) {
	f := newManagedFixture(t)
	ctx := context.Background()
	f.runtime.onlineMutations = true

	// 1. Online organization creation by platform admin (viewer is rejected)
	f.request(t, "POST", "/api/admin/organizations", "viewer", "", `{"name":"Illegal Fleet"}`, 403)
	orgResp := f.request(t, "POST", "/api/admin/organizations", "admin", "", `{"name":"Online Lifecycle Fleet"}`, 201)
	var newOrg authorization.Organization
	if err := json.Unmarshal(orgResp.Body.Bytes(), &newOrg); err != nil || newOrg.OrganizationID == "" {
		t.Fatalf("create org response=%s err=%v", orgResp.Body.String(), err)
	}
	base := "/api/admin/organizations/" + newOrg.OrganizationID

	// 2. Add existing member (operator) and register vehicles online without maintenance drain
	f.request(t, "POST", base+"/members", "admin", newOrg.OrganizationID, `{"subject":"operator"}`, 201)
	f.request(t, "POST", base+"/vehicles", "admin", newOrg.OrganizationID, `{"vehicle_id":"car-live-1","name":"Live 1","subject":"dev-live-1"}`, 201)
	f.request(t, "POST", base+"/vehicles", "admin", newOrg.OrganizationID, `{"vehicle_id":"car-live-2","name":"Live 2","subject":"dev-live-2"}`, 201)

	// 3. Grant operator remote_operator on [car-live-1, car-live-2] and acquire control on car-live-1
	f.request(t, "POST", base+"/assignments", "admin", newOrg.OrganizationID,
		`{"user_id":"`+f.operatorID+`","role":"remote_operator","scope":"selected","vehicle_ids":["car-live-1","car-live-2"]}`, 200)
	s1 := newTestControlSession("car-live-1", f.operatorID, uuid.NewString(), time.Minute)
	s1.OperatorTenant, s1.ProtocolVersion = newOrg.OrganizationID, 2
	if err := controlLeases.AcquireControlSession(ctx, s1); err != nil {
		t.Fatalf("AcquireControlSession car-live-1: %v", err)
	}
	if active, err := controlLeases.GetControlSession(ctx, "car-live-1"); err != nil || active.OperatorID != f.operatorID {
		t.Fatalf("expected active control lease on car-live-1, got %+v err=%v", active, err)
	}

	// 4. Narrow operator's vehicle scope to [car-live-2] -> car-live-1 control lease is immediately revoked to PENDING fence
	f.request(t, "POST", base+"/assignments", "admin", newOrg.OrganizationID,
		`{"user_id":"`+f.operatorID+`","role":"remote_operator","scope":"selected","vehicle_ids":["car-live-2"]}`, 200)
	if _, err := controlLeases.GetControlSession(ctx, "car-live-1"); !errors.Is(err, ErrControlSessionNotFound) {
		t.Fatalf("expected car-live-1 active lease to be deleted after scope narrowing, err=%v", err)
	}
	if handover, err := controlLeases.GetHandover(ctx, "car-live-1"); err != nil || handover.State != "PENDING" {
		t.Fatalf("expected car-live-1 handover state PENDING after scope narrowing, got %+v err=%v", handover, err)
	}
	f.request(t, "POST", "/api/vehicles/car-live-1/control/acquire", "operator", newOrg.OrganizationID, `{}`, 403)
	// Confirm handover on car-live-1 (or purge it) so operator's pending fence is cleared before driving car-live-2
	if err := controlLeases.PurgeVehicleLeases(ctx, "car-live-1"); err != nil {
		t.Fatal(err)
	}

	// 5. Acquire control on car-live-2, then revoke operator's role via DELETE /assignments/{user_id}
	s2 := newTestControlSession("car-live-2", f.operatorID, uuid.NewString(), time.Minute)
	s2.OperatorTenant, s2.ProtocolVersion = newOrg.OrganizationID, 2
	if err := controlLeases.AcquireControlSession(ctx, s2); err != nil {
		t.Fatalf("AcquireControlSession car-live-2: %v", err)
	}
	f.request(t, "DELETE", base+"/assignments/"+f.operatorID, "admin", newOrg.OrganizationID, "", 200)
	if _, err := controlLeases.GetControlSession(ctx, "car-live-2"); !errors.Is(err, ErrControlSessionNotFound) {
		t.Fatalf("expected car-live-2 active lease to be deleted after role revocation, err=%v", err)
	}
	if handover, err := controlLeases.GetHandover(ctx, "car-live-2"); err != nil || handover.State != "PENDING" {
		t.Fatalf("expected car-live-2 handover state PENDING after role revocation, got %+v err=%v", handover, err)
	}
	f.request(t, "POST", "/api/vehicles/car-live-2/control/acquire", "operator", newOrg.OrganizationID, `{}`, 403)
	// Operator is still a member with baseline view access
	f.request(t, "GET", "/api/vehicles/car-live-2/state", "operator", newOrg.OrganizationID, "", 200)

	// 6. Kick operator from organization via DELETE /members/{user_id}, then re-add
	f.request(t, "DELETE", base+"/members/"+f.operatorID, "admin", newOrg.OrganizationID, "", 200)
	f.request(t, "GET", "/api/vehicles/car-live-2/state", "operator", newOrg.OrganizationID, "", 403)
	f.request(t, "POST", base+"/members", "admin", newOrg.OrganizationID, `{"subject":"operator"}`, 201)
	f.request(t, "GET", "/api/vehicles/car-live-2/state", "operator", newOrg.OrganizationID, "", 200)

	// 7. Kick vehicle car-live-2 via DELETE /vehicles/car-live-2 -> purges Redis lease and disables vehicle, then re-register
	f.request(t, "DELETE", base+"/vehicles/car-live-2", "admin", newOrg.OrganizationID, "", 200)
	if handover, err := controlLeases.GetHandover(ctx, "car-live-2"); err != nil || handover.State != "NONE" || handover.SessionID != "" {
		t.Fatalf("expected car-live-2 handover to be completely purged, got %+v err=%v", handover, err)
	}
	f.request(t, "GET", "/api/vehicles/car-live-2/state", "admin", newOrg.OrganizationID, "", 403)
	f.request(t, "POST", base+"/vehicles", "admin", newOrg.OrganizationID, `{"vehicle_id":"car-live-2","name":"Live 2 Reborn","subject":"dev-live-2-reborn"}`, 201)
	f.request(t, "GET", "/api/vehicles/car-live-2/state", "admin", newOrg.OrganizationID, "", 200)

	// 8. Disable organization via DELETE /api/admin/organizations/{org_id}
	f.request(t, "DELETE", base, "admin", newOrg.OrganizationID, "", 200)
	f.request(t, "GET", "/api/vehicles/car-live-1/state", "admin", newOrg.OrganizationID, "", 403)
}

func TestManagedRuntimePostgresFailuresNeverUseStaleAuthority(t *testing.T) {
	f := newManagedFixture(t)
	f.request(t, "GET", "/api/vehicles/car-one/state", "viewer", "", "", 200)
	if _, err := f.db.Exec(`ALTER TABLE authz_authorization_state RENAME TO injected_unavailable_state`); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/vehicles/car-one/state", "viewer", "", "", 503)
	if _, err := f.db.Exec(`ALTER TABLE injected_unavailable_state RENAME TO authz_authorization_state`); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/vehicles/car-one/state", "viewer", "", "", 200)
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/vehicles/car-one/state", "viewer", "", "", 503)
	f.request(t, "GET", "/api/vehicles/car-one/device-auth-check", "device-one", "", "", 503)
}

func TestManagedRuntimePostgresTokenHorizonAndDrainSurviveRestart(t *testing.T) {
	f := newManagedFixture(t)
	ctx := context.Background()
	if _, err := f.runtime.BeforeMutation(ctx, f.orgID); !errors.Is(err, errManagedDrain) {
		t.Fatalf("normal serving accepted management write: %v", err)
	}
	for _, row := range []struct{ path, subject string }{
		{"/api/token/operator?vid=car-one&access=observer", "viewer"},
		{"/api/token/vehicle?vid=car-one", "device-one"},
	} {
		f.request(t, "GET", row.path, row.subject, "", "", 200)
	}
	horizon, err := f.store.TokenExpiry(ctx, "")
	if err != nil || time.Until(horizon) < 29*time.Minute {
		t.Fatalf("vehicle token was not persistently tracked: %s %v", horizon, err)
	}
	restartedStore, err := authorization.NewStore(f.db)
	if err != nil {
		t.Fatal(err)
	}
	restarted := &ManagedRuntime{store: restartedStore, issuer: managedTestIssuer, maintenance: true,
		roomsEmpty: func(context.Context) error { return nil }}
	if _, err := restarted.BeforeMutation(ctx, f.orgID); !errors.Is(err, errManagedDrain) {
		t.Fatalf("restart bypassed old-token drain: %v", err)
	}
	f.runtime.maintenance = true
	f.request(t, "GET", "/api/token/operator?vid=car-one&access=observer", "viewer", "", "", 503)
	f.request(t, "GET", "/api/token/vehicle?vid=car-one", "device-one", "", "", 503)
	f.request(t, "POST", "/api/vehicles/car-one/control/acquire", "operator", "", `{}`, 503)
	f.request(t, "POST", "/api/vehicles/car-one/viewing/acquire", "viewer", "", `{}`, 503)
	f.request(t, "POST", "/api/vehicles/car-one/video/acquire", "viewer", "", `{}`, 503)
	f.request(t, "GET", "/api/vehicles/car-one/device-auth-check", "device-one", "", "", 204)
	if _, err := f.db.Exec(`UPDATE authz_token_horizons SET expires_at=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	session := newTestControlSession("car-one", f.operatorID, uuid.NewString(), time.Minute)
	session.OperatorTenant, session.ProtocolVersion = f.orgID, 2
	if err := controlLeases.AcquireControlSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.BeforeMutation(ctx, f.orgID); !errors.Is(err, errManagedDrain) {
		t.Fatalf("active control bypassed drain: %v", err)
	}
	f.request(t, "POST", "/api/control/"+session.SessionID+"/release", "operator", "", "", 202)
	if _, err := restarted.BeforeMutation(ctx, f.orgID); !errors.Is(err, errManagedDrain) {
		t.Fatalf("pending handover bypassed drain: %v", err)
	}
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", `["car-one"]`)
	handover, err := controlLeases.GetHandover(ctx, "car-one")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"session_id": session.SessionID, "revision": handover.Revision})
	f.request(t, "POST", "/api/vehicles/car-one/control/simulation-ack", "device-one", "", string(body), 204)
	viewing := &ViewingLeaseStore{client: f.client}
	sid := uuid.NewString()
	if _, err := viewing.mutate(ctx, "acquire", "car-one", "owner", sid); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.BeforeMutation(ctx, f.orgID); !errors.Is(err, errManagedDrain) {
		t.Fatalf("active viewing bypassed drain: %v", err)
	}
	if _, err := viewing.mutate(ctx, "release", "car-one", "owner", sid); err != nil {
		t.Fatal(err)
	}
	restarted.roomsEmpty = func(context.Context) error { return errManagedDrain }
	if _, err := restarted.BeforeMutation(ctx, f.orgID); !errors.Is(err, errManagedDrain) {
		t.Fatalf("live room bypassed drain: %v", err)
	}
	restarted.roomsEmpty = func(context.Context) error { return errors.New("LiveKit unavailable") }
	if _, err := restarted.BeforeMutation(ctx, f.orgID); err == nil {
		t.Fatal("unavailable LiveKit bypassed drain")
	}
	restarted.roomsEmpty = func(context.Context) error { return nil }
	if _, err := restarted.BeforeMutation(ctx, f.orgID); !errors.Is(err, errManagedDrain) {
		t.Fatalf("server-refreshed tokens did not require a quiet interval: %v", err)
	}
	quietUntil, err := f.store.DrainQuietUntil(ctx)
	if err != nil || time.Until(quietUntil) < 10*time.Minute {
		t.Fatalf("server-refreshed token quiet interval was not persisted: %s %v", quietUntil, err)
	}
	if err := f.store.SetDrainQuietUntil(ctx, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	release, err := restarted.BeforeMutation(ctx, f.orgID)
	if err != nil {
		t.Fatalf("confirmed fences, released viewing and expired token could not drain: %v", err)
	}
	release()
	if _, err := f.db.Exec(`ALTER TABLE authz_token_horizons RENAME TO injected_missing_horizons`); err != nil {
		t.Fatal(err)
	}
	managedRuntime = restarted
	f.request(t, "POST", "/api/admin/organizations/"+f.orgID+"/people", "admin", "",
		`{"name":"new","subject":"new"}`, 503)
}

func TestManagedRuntimePostgresViewingAndV2ControlTokens(t *testing.T) {
	f := newManagedFixture(t)
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", `[]`)
	viewingRequest, _ := json.Marshal(map[string]string{
		"request_id": uuid.NewString(), "client_instance_id": uuid.NewString(),
	})
	w := f.request(t, "POST", "/api/vehicles/car-one/viewing/acquire", "viewer", "",
		string(viewingRequest), 200)
	var viewing struct {
		ViewingSessionID string `json:"viewing_session_id"`
		Token            string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &viewing); err != nil {
		t.Fatal(err)
	}
	assertTrackedToken := func(token, identity string, publishData bool) {
		t.Helper()
		verifier, err := auth.ParseAPIToken(token)
		if err != nil {
			t.Fatal(err)
		}
		claims, grants, err := verifier.Verify(lkApiSecret)
		if err != nil || grants.Identity != identity || grants.Video == nil ||
			grants.Video.Room != "teleop-car-one" || grants.Video.GetCanPublishData() != publishData ||
			grants.Video.GetCanPublish() {
			t.Fatalf("managed room token changed its isolation or permissions: %#v %v", grants, err)
		}
		horizon, err := f.store.TokenExpiry(context.Background(), "")
		if err != nil || horizon.Before(claims.Expiry.Time().Add(time.Minute)) {
			t.Fatalf("actual signed expiry was not committed before response: %s, %v", horizon, err)
		}
	}
	assertTrackedToken(viewing.Token, "observer-"+viewing.ViewingSessionID, false)
	w = f.request(t, "POST", "/api/vehicles/car-one/control/acquire", "operator", "",
		`{"public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","protocol_version":2,"client_instance_id":"browser-one"}`, 200)
	var control controlSessionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &control); err != nil {
		t.Fatal(err)
	}
	assertTrackedToken(control.Token, "control-"+control.Session.SessionID, true)
	if control.Session.ProtocolVersion != 2 || control.Session.OperatorID != f.operatorID {
		t.Fatalf("control did not use internal identity and explicit v2: %#v", control.Session)
	}
	f.request(t, "POST", "/api/control/"+control.Session.SessionID+"/renew", "operator", "", "", 200)
	f.runtime.maintenance = true
	f.request(t, "POST", "/api/control/"+control.Session.SessionID+"/renew", "operator", "", "", 503)
	f.request(t, "POST", "/api/vehicles/car-one/viewing/"+viewing.ViewingSessionID+"/renew", "viewer", "", "", 503)
	f.request(t, "POST", "/api/control/"+control.Session.SessionID+"/release", "operator", "", "", 202)
	f.request(t, "POST", "/api/vehicles/car-one/viewing/"+viewing.ViewingSessionID+"/release", "viewer", "", "", 204)
}

func TestManagedRuntimePostgresIssuanceFailureAndMutationSerialization(t *testing.T) {
	f := newManagedFixture(t)
	ctx := context.Background()
	if _, err := f.db.Exec(`ALTER TABLE authz_token_horizons RENAME TO injected_missing_horizons`); err != nil {
		t.Fatal(err)
	}
	w := f.request(t, "GET", "/api/token/vehicle?vid=car-one", "device-one", "", "", 503)
	if strings.Contains(w.Body.String(), `"token"`) {
		t.Fatal("untracked token escaped on PostgreSQL write failure")
	}
	if _, err := f.db.Exec(`ALTER TABLE injected_missing_horizons RENAME TO authz_token_horizons`); err != nil {
		t.Fatal(err)
	}
	claims := &UserClaims{Name: "viewer", Issuer: managedTestIssuer, Scopes: []string{"teleop:observe"}}
	request := httptest.NewRequest("GET", "/api/vehicles", nil)
	releaseRequest, err := f.runtime.authorizeRequest(request, claims)
	if err != nil {
		t.Fatal(err)
	}
	f.runtime.maintenance = true
	if err := f.store.SetDrainQuietUntil(ctx, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	acquired := make(chan func(), 1)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		release, err := f.runtime.BeforeMutation(ctx, f.orgID)
		if err == nil {
			acquired <- release
		}
	}()
	select {
	case release := <-acquired:
		release()
		releaseRequest()
		t.Fatal("mutation guard did not wait for in-flight resource authorization")
	case <-time.After(25 * time.Millisecond):
	}
	releaseRequest()
	select {
	case release := <-acquired:
		defer release()
	case <-time.After(3 * time.Second):
		t.Fatal("mutation guard did not acquire after request released")
	}
	wg.Wait()
	if f.runtime.mu.TryRLock() {
		f.runtime.mu.RUnlock()
		t.Fatal("mutation guard failed to exclude new token/control readers until release")
	}
}

func TestManagedRuntimeOIDCPostgresHTTPPilot(t *testing.T) {
	f := newManagedFixture(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{
			Key: &key.PublicKey, KeyID: "managed-http", Algorithm: string(jose.RS256), Use: "sig",
		}}})
	}))
	defer jwks.Close()
	authenticator, err = NewOIDCAuthenticator(managedTestIssuer, "teleop-api", jwks.URL)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithHeader(jose.HeaderKey("kid"), "managed-http"))
	if err != nil {
		t.Fatal(err)
	}
	sign := func(subject, scope string) string {
		t.Helper()
		raw, err := jwt.Signed(signer).Claims(struct {
			jwt.Claims
			Scope string   `json:"scope"`
			Roles []string `json:"roles"`
		}{
			Claims: jwt.Claims{Issuer: managedTestIssuer, Subject: subject, Audience: jwt.Audience{"teleop-api"},
				Expiry: jwt.NewNumericDate(time.Now().Add(time.Hour))},
			Scope: scope, Roles: []string{"admin", "controller", "vehicle"},
		}).CompactSerialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	server := httptest.NewServer(f.mux)
	defer server.Close()
	request := func(method, path, subject, scope, body string, status int) []byte {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", "Bearer "+sign(subject, scope))
		response, err := server.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		payload, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != status {
			t.Fatalf("real HTTP %s %s => %d %s, want %d; %v",
				method, path, response.StatusCode, payload, status, err)
		}
		return payload
	}
	const peopleScope = "openid profile teleop:observe"
	request("GET", "/api/auth/me", "admin", peopleScope, "", 200)
	request("GET", "/api/admin/context", "admin", peopleScope, "", 200)
	request("GET", "/api/admin/context", "admin", "openid", "", 403)
	f.runtime.maintenance = true
	if err := f.store.SetDrainQuietUntil(context.Background(), time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	base := "/api/admin/organizations/" + f.orgID
	personJSON := request("POST", base+"/people", "admin", peopleScope,
		`{"name":"HTTP pilot operator","subject":"pilot-operator"}`, 201)
	var person authorization.Person
	if err := json.Unmarshal(personJSON, &person); err != nil {
		t.Fatal(err)
	}
	request("POST", base+"/vehicles", "admin", peopleScope,
		`{"vehicle_id":"http-car","name":"HTTP pilot vehicle","subject":"http-device"}`, 201)
	assignment, _ := json.Marshal(map[string]any{"user_id": person.UserID, "role": "remote_operator",
		"scope": "selected", "vehicle_ids": []string{"http-car"}})
	request("POST", base+"/assignments", "admin", peopleScope, string(assignment), 200)
	f.runtime.maintenance = false
	request("GET", "/api/vehicles/http-car/device-auth-check", "http-device", "openid", "", 403)
	request("GET", "/api/vehicles/http-car/device-auth-check", "http-device", "teleop:observe", "", 403)
	request("GET", "/api/vehicles/http-car/device-auth-check", "http-device", "teleop:vehicle", "", 204)
	request("GET", "/api/vehicles/http-car/state", "pilot-operator", "openid", "", 403)
	request("GET", "/api/vehicles/http-car/state", "pilot-operator", peopleScope, "", 200)
	request("GET", "/api/vehicles/car-one/state", "pilot-operator", peopleScope, "", 200)
	payload := request("GET", "/api/vehicles", "pilot-operator", peopleScope, "", 200)
	if !strings.Contains(string(payload), "http-car") || !strings.Contains(string(payload), "car-one") || strings.Contains(string(payload), "car-other") {
		t.Fatalf("HTTP list did not honor own-organization read baseline: %s", payload)
	}
	request("POST", "/api/vehicles/car-one/control/acquire", "pilot-operator", peopleScope, `{}`, 403)
	request("GET", "/api/token/operator?vid=http-car&access=observer", "pilot-operator", peopleScope, "", 200)
	request("GET", "/api/token/vehicle?vid=http-car", "http-device", "teleop:vehicle", "", 200)
	viewing, _ := json.Marshal(map[string]string{"request_id": uuid.NewString(), "client_instance_id": uuid.NewString()})
	request("POST", "/api/vehicles/http-car/viewing/acquire", "pilot-operator", peopleScope, string(viewing), 200)
	t.Setenv("SIMULATED_CONTROL_VEHICLES_JSON", `["http-car"]`)
	payload = request("POST", "/api/vehicles/http-car/control/acquire", "pilot-operator", peopleScope,
		`{"public_key_b64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","protocol_version":2,"client_instance_id":"http-browser"}`, 200)
	var control controlSessionResponse
	if err := json.Unmarshal(payload, &control); err != nil || control.Session.OperatorID != person.UserID {
		t.Fatalf("HTTP control did not bind internal user identity: %s %v", payload, err)
	}
	request("GET", "/api/vehicles/http-car/control/context", "http-device", "teleop:vehicle", "", 200)
	request("POST", "/api/control/"+control.Session.SessionID+"/release", "pilot-operator", peopleScope, "", 202)
	request("GET", "/api/vehicles/http-car/state", "unknown", peopleScope, "", 403)
	f.runtime.maintenance = true
	request("POST", base+"/assignments", "admin", peopleScope, string(assignment), 409)
	if _, err := f.db.Exec(`ALTER TABLE authz_authorization_state RENAME TO injected_http_database_failure`); err != nil {
		t.Fatal(err)
	}
	request("GET", "/api/vehicles/http-car/state", "pilot-operator", peopleScope, "", 503)
}

func TestManagedRuntimePostgresRTCIngressClosesReconnectAndIssuanceGap(t *testing.T) {
	f := newManagedFixture(t)
	ctx := context.Background()
	if err := f.store.SetDrainQuietUntil(ctx, time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	entered, finish := make(chan struct{}), make(chan struct{})
	f.runtime.rtcProxy = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-finish
		w.WriteHeader(http.StatusNoContent)
	})
	done := make(chan struct{})
	response := httptest.NewRecorder()
	go func() {
		defer close(done)
		f.runtime.RTCIngress(response, httptest.NewRequest("GET", "/rtc/validate", nil))
	}()
	<-entered
	quietUntil, err := f.store.DrainQuietUntil(ctx)
	if err != nil || !quietUntil.IsZero() {
		t.Fatalf("reconnect did not invalidate persisted quiet observation: %s %v", quietUntil, err)
	}
	if f.runtime.mu.TryLock() {
		f.runtime.mu.Unlock()
		t.Fatal("proxy did not serialize the full signaling connection lifetime")
	}
	close(finish)
	<-done
	if response.Code != http.StatusNoContent {
		t.Fatalf("signaling proxy failed: %d", response.Code)
	}
	f.runtime.maintenance = true
	response = httptest.NewRecorder()
	f.runtime.RTCIngress(response, httptest.NewRequest("GET", "/rtc/v1", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatal("maintenance allowed a previously minted reconnect token to reach LiveKit")
	}
	f.runtime.maintenance = false
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	f.runtime.RTCIngress(response, httptest.NewRequest("GET", "/rtc", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatal("PostgreSQL failure allowed signaling ingress without persisting quiet invalidation")
	}
}

type managedRoomService struct {
	livekit.RoomService
	rooms []*livekit.Room
	err   error
}

func (s *managedRoomService) ListRooms(context.Context, *livekit.ListRoomsRequest) (*livekit.ListRoomsResponse, error) {
	return &livekit.ListRoomsResponse{Rooms: s.rooms}, s.err
}

func TestManagedRoomDrainQueriesLiveKitWithoutTerminatingParticipants(t *testing.T) {
	previousKey, previousSecret := lkApiKey, lkApiSecret
	lkApiKey, lkApiSecret = "test-key", "test-secret"
	t.Cleanup(func() { lkApiKey, lkApiSecret = previousKey, previousSecret })
	service := &managedRoomService{}
	handler := livekit.NewRoomServiceServer(service)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifier, err := auth.ParseAPIToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if err != nil {
			t.Error(err)
			w.WriteHeader(401)
			return
		}
		_, grants, err := verifier.Verify(lkApiSecret)
		if err != nil || grants.Video == nil || !grants.Video.RoomList || grants.Video.RoomJoin {
			t.Error("drain query must use server-only room-list grant")
			w.WriteHeader(401)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	check, err := managedRoomDrainCheck(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if err := check(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, room := range []*livekit.Room{
		{Name: "teleop-car-one", NumParticipants: 1},
		{Name: "teleop-car-one", NumParticipants: 0},
	} {
		service.rooms = []*livekit.Room{room}
		if err := check(context.Background()); !errors.Is(err, errManagedDrain) {
			t.Fatalf("existing room bypassed conservative drain: %v", err)
		}
	}
	service.rooms = []*livekit.Room{{Name: "unrelated-room", NumParticipants: 1}}
	if err := check(context.Background()); err != nil {
		t.Fatalf("unrelated room blocked pilot: %v", err)
	}
	server.Close()
	if err := check(context.Background()); err == nil {
		t.Fatal("unavailable LiveKit query allowed policy mutation")
	}
}
