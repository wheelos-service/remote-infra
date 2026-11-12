package gateway

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
)

func onboardingTestService(t *testing.T) *OnboardingService {
	t.Helper()
	block, err := aes.NewCipher(bytes.Repeat([]byte{0x52}, 32))
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	return &OnboardingService{aead: aead, config: onboardingConfig{ManagementClientID: "disposable-client", ManagementClientSecret: "disposable-secret"}, providerHTTP: &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func TestOnboardingProviderDiscardsSensitiveErrorsAndRedirects(t *testing.T) {
	for _, status := range []int{200, 302, 401, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if user, password, ok := r.BasicAuth(); !ok || user != "disposable-client" || password != "disposable-secret" {
					t.Error("management authentication absent")
				}
				w.Header().Set("Location", "https://unrelated.invalid/credential-trap")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"status":"error","msg":"secret-private-provider-message","data":"secret-private-provider-message"}`))
			}))
			defer server.Close()
			service := onboardingTestService(t)
			service.config.CasdoorURL = server.URL
			raw, err := service.providerRequest(context.Background(), http.MethodGet, "/api/get-user", nil)
			if err == nil || raw != nil || strings.Contains(err.Error(), "secret-private") || strings.Contains(err.Error(), "http") {
				t.Fatalf("provider rejection leaked details: data=%q err=%v", raw, err)
			}
		})
	}
}

func TestOnboardingReconcileRejectsSameEmailDifferentImmutableUser(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": map[string]any{
			"id": "another-uuid", "owner": "fleet", "name": "teleop-op", "email": "new@example.test",
			"signupApplication": "browser", "type": "normal-user",
		}})
	}))
	defer server.Close()
	service := onboardingTestService(t)
	service.config.CasdoorURL, service.config.CasdoorOrganization, service.config.BrowserApplication = server.URL, "fleet", "browser"
	found, err := service.reconcilePerson(context.Background(), authorization.OnboardingOperation{PlannedIdentityID: "planned-uuid", ProviderName: "teleop-op", Email: "new@example.test"})
	if found || !errors.Is(err, onboardingProviderConflict) {
		t.Fatalf("arbitrary provider account adopted: found=%v err=%v", found, err)
	}
}

func TestOnboardingCredentialEncryptionAndIntegrity(t *testing.T) {
	service := onboardingTestService(t)
	secret, err := onboardingRandom()
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.encryptCredential(secret)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.encryptCredential(secret)
	if err != nil || bytes.Equal(first, second) || bytes.Contains(first, []byte(secret)) {
		t.Fatal("credential encryption did not use independent nonces")
	}
	clear, err := service.decryptCredential(first)
	if err != nil || clear != secret {
		t.Fatal("encrypted credential did not round trip")
	}
	first[len(first)-1] ^= 1
	if _, err := service.decryptCredential(first); err == nil || strings.Contains(err.Error(), secret) {
		t.Fatal("tampered credential accepted or leaked")
	}
}

func TestOnboardingURLTransportBounds(t *testing.T) {
	for _, raw := range []string{"http://example.test", "http://localhost", "https://u:p@example.test", "https://example.test/?secret=x", "https://example.test/#secret"} {
		if onboardingSafeURL(raw) {
			t.Fatalf("unsafe configured endpoint accepted: %s", raw)
		}

	}
	for _, raw := range []string{"http://127.0.0.1:8080", "http://[::1]:8080", "https://example.test"} {
		if !onboardingSafeURL(raw) {
			t.Fatalf("safe endpoint rejected: %s", raw)
		}
	}

}

func TestOnboardingProviderTimeoutIsSafe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	service := onboardingTestService(t)
	service.config.CasdoorURL = server.URL
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := service.providerRequest(ctx, http.MethodGet, "/api/get-user", nil)
	if !errors.Is(err, onboardingProviderUnavailable) || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("timeout leaked request detail: %v", err)
	}
}
