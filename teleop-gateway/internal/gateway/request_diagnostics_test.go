package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type diagnosticAuthenticator func(context.Context, string) (*UserClaims, error)

func (a diagnosticAuthenticator) Authenticate(ctx context.Context, token string) (*UserClaims, error) {
	return a(ctx, token)
}

func TestAuthenticationDiagnosticErrors(t *testing.T) {
	old := authenticator
	t.Cleanup(func() { authenticator = old })
	authenticator = diagnosticAuthenticator(func(context.Context, string) (*UserClaims, error) {
		return nil, errors.New("private-provider-response-and-secret")
	})
	var logs bytes.Buffer
	writer := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(writer) })
	handler := withRequestID(AuthenticationMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("authentication failure reached protected handler")
	})))
	for _, test := range []struct {
		name, authorization, code string
	}{
		{"missing bearer", "", "AUTH_BEARER_REQUIRED"},
		{"wrong scheme", "Basic private-credentials", "AUTH_BEARER_REQUIRED"},
		{"invalid bearer", "Bearer private-token", "AUTH_INVALID_TOKEN"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
			request.Header.Set("Accept", "application/json")
			request.Header.Set("Authorization", test.authorization)
			request.Header.Set("X-Request-ID", "untrusted-client-id")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			assertDiagnosticError(t, response, http.StatusUnauthorized, test.code)
			if strings.Contains(response.Body.String(), "private-") || strings.Contains(logs.String(), "private-") {
				t.Fatal("diagnostics exposed credentials or raw provider errors")
			}
			if !strings.Contains(logs.String(), response.Header().Get("X-Request-ID")) {
				t.Fatal("diagnostic log is not correlated with the response")
			}
		})
	}
	authenticator = diagnosticAuthenticator(func(context.Context, string) (*UserClaims, error) {
		return nil, authenticationFailure("OIDC_AUDIENCE_MISMATCH")
	})
	request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer private-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertDiagnosticError(t, response, http.StatusUnauthorized, "AUTH_INVALID_TOKEN")
	if !strings.Contains(logs.String(), "reason=OIDC_AUDIENCE_MISMATCH") ||
		strings.Contains(response.Body.String(), "OIDC_AUDIENCE_MISMATCH") {
		t.Fatal("internal authentication reason was lost or exposed to the caller")
	}
}

func assertDiagnosticError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status || response.Header().Get("X-Error-Code") != code {
		t.Fatalf("status=%d code=%q body=%s", response.Code, response.Header().Get("X-Error-Code"), response.Body.String())
	}
	id := response.Header().Get("X-Request-ID")
	if _, err := uuid.Parse(id); err != nil {
		t.Fatalf("invalid server request id %q", id)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("diagnostic failure is cacheable")
	}
	var body struct {
		Error     string `json:"error"`
		Code      string `json:"code"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid diagnostic JSON: %v", err)
	}
	if body.Code != code || body.RequestID != id || body.Error == "" {
		t.Fatalf("inconsistent diagnostic body: %+v", body)
	}
}

func TestAuthenticationDiagnosticCompatibilityAndDependencyFailure(t *testing.T) {
	old := authenticator
	t.Cleanup(func() { authenticator = old })
	authenticator = diagnosticAuthenticator(func(context.Context, string) (*UserClaims, error) {
		return &UserClaims{Name: "device", Roles: []string{"vehicle"}, Scopes: []string{"teleop:vehicle"}, Organization: "vehicle"}, nil
	})
	handler := AuthenticationMiddleware(http.HandlerFunc(handleAuthMe))
	request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	request.Header.Set("Authorization", "Bearer private-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unexpected identity result: %d", response.Code)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 4 || string(body["Name"]) != `"device"` {
		t.Fatalf("legacy identity response changed: %s", response.Body.String())
	}
	if response.Header().Get("X-Error-Code") != "" {
		t.Fatal("successful identity request carries error code")
	}
	for _, accept := range []string{"", "*/*", "text/plain", "application/json;q=0"} {
		t.Run("legacy text "+accept, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
			request.Header.Set("Accept", accept)
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || !strings.HasPrefix(response.Header().Get("Content-Type"), "text/plain") {
				t.Fatal("default authentication rejection is no longer plain text")
			}
		})
	}
	request.Header.Set("Accept", "application/json")
	authenticator = nil
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertDiagnosticError(t, response, http.StatusServiceUnavailable, "AUTH_SERVICE_UNAVAILABLE")
	authenticator = diagnosticAuthenticator(func(context.Context, string) (*UserClaims, error) { return nil, nil })
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertDiagnosticError(t, response, http.StatusUnauthorized, "AUTH_INVALID_TOKEN")
}

func TestDeviceDiagnosticDoesNotRevealOtherVehicles(t *testing.T) {
	oldRegistry, oldIdentities, oldAuthenticator := vehicleRegistry, vehicleIdentities, authenticator
	t.Cleanup(func() {
		vehicleRegistry, vehicleIdentities, authenticator = oldRegistry, oldIdentities, oldAuthenticator
	})
	vehicleRegistry = &VehicleRegistry{byID: map[string]RegisteredVehicle{
		"car-1": {VehicleID: "car-1"},
	}}
	vehicleIdentities = &VehicleIdentityResolver{bySubject: map[string]string{
		"device": "car-1", "unregistered": "car-3",
	}, strict: true}
	authenticator = deviceAuthTestAuthenticator{
		"device-token":       {Name: "device", Roles: []string{"vehicle"}},
		"unregistered-token": {Name: "unregistered", Roles: []string{"vehicle"}},
	}
	mux := http.NewServeMux()
	registerDeviceAuthCheck(mux)
	for _, test := range []struct {
		path, token, code string
		status            int
	}{
		{"car-2", "device-token", "VEHICLE_IDENTITY_MISMATCH", http.StatusForbidden},
		{"car-3", "device-token", "VEHICLE_IDENTITY_MISMATCH", http.StatusForbidden},
		{"car-3", "unregistered-token", "VEHICLE_NOT_REGISTERED", http.StatusNotFound},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/vehicles/"+test.path+"/device-auth-check", nil)
		request.Header.Set("Authorization", "Bearer "+test.token)
		request.Header.Set("Accept", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		assertDiagnosticError(t, response, test.status, test.code)
		if strings.Contains(response.Body.String(), test.path) || strings.Contains(response.Body.String(), test.token) {
			t.Fatal("diagnostic leaked vehicle or credential details")
		}
	}
	vehicleRegistry = nil
	request := httptest.NewRequest(http.MethodGet, "/api/vehicles/car-1/device-auth-check", nil)
	request.Header.Set("Authorization", "Bearer device-token")
	request.Header.Set("Accept", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	assertDiagnosticError(t, response, http.StatusServiceUnavailable, "VEHICLE_REGISTRY_UNAVAILABLE")
}

func TestVehicleTokenDiagnosticFailures(t *testing.T) {
	oldIdentities, oldAuthenticator := vehicleIdentities, authenticator
	t.Cleanup(func() { vehicleIdentities, authenticator = oldIdentities, oldAuthenticator })
	vehicleIdentities = &VehicleIdentityResolver{bySubject: map[string]string{"device": "car-1"}, strict: true}
	authenticator = deviceAuthTestAuthenticator{
		"device-token": {Name: "device", Roles: []string{"vehicle"}},
		"other-token":  {Name: "unknown", Roles: []string{"vehicle"}},
		"human-token":  {Name: "device", Roles: []string{"observer"}},
	}
	handler := AuthenticationMiddleware(http.HandlerFunc(handleVehicleConnect))
	for _, test := range []struct {
		token, query, code string
	}{
		{"human-token", "", "VEHICLE_IDENTITY_REQUIRED"},
		{"other-token", "", "VEHICLE_IDENTITY_UNBOUND"},
		{"device-token", "?vid=car-2", "VEHICLE_IDENTITY_MISMATCH"},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/token/vehicle"+test.query, nil)
		request.Header.Set("Authorization", "Bearer "+test.token)
		request.Header.Set("Accept", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		assertDiagnosticError(t, response, http.StatusForbidden, test.code)
	}
	vehicleIdentities = nil
	request := httptest.NewRequest(http.MethodGet, "/api/token/vehicle", nil)
	request.Header.Set("Authorization", "Bearer device-token")
	request.Header.Set("Accept", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertDiagnosticError(t, response, http.StatusServiceUnavailable, "VEHICLE_IDENTITY_SERVICE_UNAVAILABLE")
}

func TestBusinessAuditUsesServerRequestID(t *testing.T) {
	oldSink := auditSink
	t.Cleanup(func() { auditSink = oldSink })
	var output bytes.Buffer
	auditSink = NewJSONAuditSink(&output)
	handler := withRequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recordAudit(r.Context(), AuditEvent{Event: "vehicle_access", Result: "success"})
		w.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	request.Header.Set("X-Request-ID", "untrusted-client-id")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var event AuditEvent
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event.RequestID == "" || event.RequestID != response.Header().Get("X-Request-ID") {
		t.Fatal("business audit is not correlated with the server request")
	}
}

func TestRequestIDsAreServerGeneratedAndVisibleToAllowedBrowser(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", "https://console.example")
	var handlerID string
	handler := withRequestID(withCORS(withRequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerID, _ = r.Context().Value(requestIDContextKey{}).(string)
		w.WriteHeader(http.StatusNoContent)
	}))))
	seen := make(map[string]bool)
	for range 2 {
		request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
		request.Header.Set("X-Request-ID", "untrusted-client-id")
		request.Header.Set("Origin", "https://console.example")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		id := response.Header().Get("X-Request-ID")
		if _, err := uuid.Parse(id); err != nil || id != handlerID || seen[id] {
			t.Fatal("request ID is invalid, replaced by nested middleware, or reused")
		}
		seen[id] = true
		if response.Header().Get("Access-Control-Expose-Headers") != "X-Request-ID, X-Error-Code" {
			t.Fatal("browser cannot read diagnostic headers")
		}
	}
	request := httptest.NewRequest(http.MethodOptions, "/api/auth/me", nil)
	request.Header.Set("Origin", "https://untrusted.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || response.Header().Get("X-Request-ID") == "" ||
		response.Header().Get("Access-Control-Expose-Headers") != "" {
		t.Fatal("CORS rejection lacks correlation or exposes headers to an untrusted browser")
	}
}

func TestDiagnosticJSONNegotiation(t *testing.T) {
	for _, test := range []struct {
		accept string
		want   bool
	}{
		{"application/json", true},
		{"text/plain, application/json;q=0.5", true},
		{"application/json;q=0", false},
		{"application/json;q=NaN", false},
		{"application/json;q=2", false},
		{"application/json;q=invalid", false},
		{"application/json;broken", false},
		{"*/*", false},
		{"", false},
	} {
		if got := acceptsDiagnosticJSON(test.accept); got != test.want {
			t.Errorf("accept %q: got %t, want %t", test.accept, got, test.want)
		}
	}
}
