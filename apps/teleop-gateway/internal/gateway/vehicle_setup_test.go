package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOnboardingConsoleConfigurationCompatibility(t *testing.T) {
	dir := t.TempDir()
	key := filepath.Join(dir, "key")
	if err := os.WriteFile(key, []byte(base64.StdEncoding.EncodeToString(make([]byte, 32))), 0600); err != nil {
		t.Fatal(err)
	}
	for _, console := range []string{"", "https://console.example.test", "http://remote.example", "https://console.example/?secret=x"} {
		config := onboardingConfig{SupportedVersion: "4.25.0", CasdoorURL: "https://auth.example", JWKSURL: "https://auth.example/jwks",
			ManagementClientID: "fixture", ManagementClientSecret: "fixture-secret", CasdoorOrganization: "fleet", BrowserApplication: "browser",
			Certificate: "cert", GatewayURL: "https://api.example", ConsoleURL: console, EncryptionKeyFile: key}
		raw, _ := json.Marshal(config)
		path := filepath.Join(dir, "onboarding.json")
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
		got, _, err := loadOnboardingConfig(path)
		if strings.HasPrefix(console, "http://") || strings.Contains(console, "?") {
			if err == nil {
				t.Fatal("unsafe console endpoint accepted")
			}
			continue
		}
		want := console
		if want == "" {
			want = config.GatewayURL
		}
		if err != nil || got.ConsoleURL != want {
			t.Fatalf("console fallback/configuration: %q %v", got.ConsoleURL, err)
		}
	}
}

func TestPostgresVehicleSetupEndpointsAreConfiguredAndManagerOnly(t *testing.T) {
	f := newManagedFixture(t)
	s := onboardingTestService(t)
	s.store, s.issuer = f.store, managedTestIssuer
	s.config.GatewayURL = "https://api.example.test"
	s.config.ConsoleURL = "https://console.example.test"
	s.Register(f.mux, AuthenticationMiddleware)
	path := "/api/admin/organizations/" + f.orgID + "/device-enrollments/setup"
	f.request(t, "GET", path, "viewer", "", "", 403)
	f.request(t, "GET", path, "device-one", "", "", 403)
	for _, console := range []string{"https://console.example.test", ""} {
		s.config.ConsoleURL = console
		w := f.request(t, "GET", path, "admin", "", "", 200)
		var value map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		want := console
		if want == "" {
			want = s.config.GatewayURL
		}
		if len(value) != 2 || value["gateway_url"] != s.config.GatewayURL || value["console_url"] != want {
			t.Fatal("setup leaked non-public config or returned incorrect endpoints")
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("setup response cacheable")
		}
	}
	// A forged Host never becomes a copied vehicle endpoint.
	r := httptest.NewRequest("GET", "https://evil.example"+path, nil)
	r.SetPathValue("org_id", f.orgID)
	r = r.WithContext(context.WithValue(r.Context(), "user", &UserClaims{UserID: f.adminID, Issuer: managedTestIssuer}))
	w := httptest.NewRecorder()
	s.serveEnrollmentSetup(w, r)
	if w.Code != 200 || strings.Contains(w.Body.String(), "evil.example") {
		t.Fatal("request Host affected setup")
	}
}
