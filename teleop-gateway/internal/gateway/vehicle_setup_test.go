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

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
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
	t.Setenv("OIDC_ISSUER", "https://auth.example.test")
	t.Setenv("OIDC_JWKS_URL", "https://auth.example.test/.well-known/jwks")
	t.Setenv("AUTHORIZATION_ONBOARDING_MANAGEMENT_SECRET", "injected-management-secret")
	t.Setenv("AUTHORIZATION_ONBOARDING_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	derived := onboardingConfig{
		CasdoorVersionExpected: "4.25.0",
		ManagementClientID:     "fixture",
		CasdoorOrganization:    "fleet",
		BrowserApplication:     "browser",
		Certificate:            "cert",
		GatewayURL:             "https://api.example.test",
	}
	raw, _ := json.Marshal(derived)
	path := filepath.Join(dir, "onboarding.json")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	got, _, err := loadOnboardingConfig(path)
	if err != nil || got.CasdoorURL != "https://auth.example.test" ||
		got.JWKSURL != "https://auth.example.test/.well-known/jwks" ||
		got.ManagementClientSecret != "injected-management-secret" {
		t.Fatalf("derived/injected onboarding config failed: %+v err=%v", got, err)
	}
	t.Setenv("AUTHORIZATION_ONBOARDING_CONFIG_FILE", path)
	nop := func(context.Context, string) (func(), error) { return func() {}, nil }
	if _, err := NewOnboardingServiceFromEnvironment(&authorization.Store{}, "https://other-issuer.example.test", nop); err == nil ||
		!strings.Contains(err.Error(), "does not match OIDC_ISSUER") {
		t.Fatalf("mismatched OIDC_ISSUER and casdoor_url accepted: %v", err)
	}
}

func TestOnboardingSystemdCredentials(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OIDC_ISSUER", "https://auth.example.test")
	t.Setenv("OIDC_JWKS_URL", "https://auth.example.test/.well-known/jwks")
	t.Setenv("AUTHORIZATION_ONBOARDING_MANAGEMENT_SECRET", "")
	t.Setenv("AUTHORIZATION_ONBOARDING_ENCRYPTION_KEY", "")
	t.Setenv("CREDENTIALS_DIRECTORY", dir)

	for name, content := range map[string]string{
		"onboarding_management_secret": "fixture-management-secret",
		"onboarding_encryption_key":    base64.StdEncoding.EncodeToString(make([]byte, 32)),
	} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0400); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0400); err != nil {
			t.Fatal(err)
		}
	}

	config := onboardingConfig{
		SupportedVersion:    "4.25.0",
		ManagementClientID:  "fixture",
		CasdoorOrganization: "fleet",
		BrowserApplication:  "browser",
		Certificate:         "cert",
		GatewayURL:          "https://api.example.test",
	}
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "onboarding.json")
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatal(err)
	}

	got, _, err := loadOnboardingConfig(configPath)
	if err != nil || got.ManagementClientSecret != "fixture-management-secret" {
		t.Fatalf("systemd onboarding credentials failed: secret=%q err=%v", got.ManagementClientSecret, err)
	}
	if _, err := readOnboardingProtectedFile(filepath.Join(dir, "onboarding_encryption_key"), 128); err == nil {
		t.Fatal("read-only systemd credential was accepted as a protected config file")
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
