package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestStaticOrganizationContextAuthenticationAndPermissions(t *testing.T) {
	f := newTelemetryFixture(t)
	authenticator.(telemetryTestAuthenticator)["wrongtenant-controller"] = &UserClaims{
		Name: "alice", Organization: "tenant-b", Roles: []string{"controller"},
	}
	authenticator.(telemetryTestAuthenticator)["denied-controller"] = &UserClaims{
		Name: "bob", Organization: "tenant-a", Roles: []string{"controller"},
	}
	registerStaticOrganizationContext(f.mux, f.api.registry, f.api.authorizer)
	for _, test := range []struct {
		token string
		ids   []string
	}{
		{"observer", []string{}},
		{"controller", []string{"car-2"}},
		{"wrongtenant", []string{}},
		{"wrongtenant-controller", []string{}},
		{"denied", []string{}},
		{"denied-controller", []string{}},
		{"roleless", []string{}},
		{"device1", []string{}},
	} {
		t.Run(test.token, func(t *testing.T) {
			w := f.request(t, http.MethodGet, "/api/organizations/context", test.token, "", http.StatusOK)
			var result struct {
				Mode              string            `json:"mode"`
				Organizations     []json.RawMessage `json:"organizations"`
				ControlVehicleIDs []string          `json:"control_vehicle_ids"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Mode != "static" || result.Organizations == nil || len(result.Organizations) != 0 ||
				!reflect.DeepEqual(result.ControlVehicleIDs, test.ids) {
				t.Fatalf("unexpected static context: %s", w.Body.String())
			}
		})
	}
	f.request(t, http.MethodGet, "/api/organizations/context", "", "", http.StatusUnauthorized)
	f.request(t, http.MethodGet, "/api/organizations/context", "invalid", "", http.StatusUnauthorized)
}

func TestStaticOrganizationContextDoesNotRequireManagedOrLegacyOrganization(t *testing.T) {
	f := newTelemetryFixture(t)
	authenticator = telemetryTestAuthenticator{
		"no-organization": {Name: "alice", Roles: []string{"operator"}},
	}
	authorizer, err := NewVehicleAuthorizer([]VehicleACL{
		{UserID: "alice", VehicleID: "car-1", Permissions: []VehiclePermission{ControlPermission}},
		{UserID: "alice", TenantID: "tenant-a", VehicleID: "car-2", Permissions: []VehiclePermission{ControlPermission}},
	})
	if err != nil {
		t.Fatal(err)
	}
	registerStaticOrganizationContext(f.mux, f.api.registry, authorizer)
	r := httptest.NewRequest(http.MethodGet, "/api/organizations/context", nil)
	r.Header.Set("Authorization", "Bearer no-organization")
	r.Header.Set("X-Organization-ID", "tenant-a")
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	var result struct {
		Mode              string            `json:"mode"`
		Organizations     []json.RawMessage `json:"organizations"`
		ControlVehicleIDs []string          `json:"control_vehicle_ids"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || result.Mode != "static" || len(result.Organizations) != 0 ||
		!reflect.DeepEqual(result.ControlVehicleIDs, []string{"car-1"}) {
		t.Fatalf("static context required or trusted a client-selected organization: %d %s", w.Code, w.Body.String())
	}
}

func TestStaticOrganizationContextWithoutConfiguredResources(t *testing.T) {
	f := newTelemetryFixture(t)
	registerStaticOrganizationContext(f.mux, nil, nil)
	w := f.request(t, http.MethodGet, "/api/organizations/context", "controller", "", http.StatusOK)
	if got := w.Body.String(); got != "{\"mode\":\"static\",\"organizations\":[],\"control_vehicle_ids\":[]}\n" {
		t.Fatalf("unconfigured context invented permissions: %s", got)
	}
}

func TestStaticOrganizationContextPreservesLegacyControlRoles(t *testing.T) {
	f := newTelemetryFixture(t)
	registerStaticOrganizationContext(f.mux, f.api.registry, f.api.authorizer)
	authenticator = telemetryTestAuthenticator{}
	for _, role := range []string{"controller", "supervisor", "operator", "admin", "remote_operator"} {
		authenticator.(telemetryTestAuthenticator)[role] = &UserClaims{
			Name: "alice", Organization: "tenant-a", Roles: []string{role},
		}
		w := f.request(t, http.MethodGet, "/api/organizations/context", role, "", http.StatusOK)
		var result struct {
			ControlVehicleIDs []string `json:"control_vehicle_ids"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		want := []string{"car-2"}
		if role == "remote_operator" {
			want = []string{}
		}
		if !reflect.DeepEqual(result.ControlVehicleIDs, want) {
			t.Fatalf("role %s: control vehicles = %v, want %v", role, result.ControlVehicleIDs, want)
		}
	}
}
