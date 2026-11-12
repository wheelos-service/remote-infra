package gateway

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
)

func TestOnboardingNativeInvitationUsesCasdoorRecoveryOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/send-verification-code" || r.URL.RawQuery != "" {
			t.Errorf("unexpected recovery request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("public recovery request included management credentials")
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		for key, expected := range map[string]string{
			"method": "forget", "type": "email", "captchaType": "none",
			"applicationId": "admin/browser", "dest": "operator@example.test",
			"captchaToken": "", "clientSecret": "", "checkUser": "",
		} {
			if r.Form.Get(key) != expected {
				t.Errorf("form %s=%q, want %q", key, r.Form.Get(key), expected)
			}
		}
		_, _ = w.Write([]byte(`{"status":"ok","data":true}`))
	}))
	defer server.Close()
	service := onboardingTestService(t)
	service.config.CasdoorURL, service.config.BrowserApplication = server.URL, "browser"
	if err := service.sendInvitation(context.Background(), authorization.OnboardingOperation{Email: "operator@example.test"}); err != nil {
		t.Fatal(err)
	}
}

func TestOnboardingNativeInvitationRejectionStaysRetryableAndSafe(t *testing.T) {
	for _, response := range []struct {
		name   string
		status int
		body   string
	}{
		{"rate limit", http.StatusOK, `{"status":"error","msg":"secret-private-provider-detail: retry later"}`},
		{"captcha required", http.StatusOK, `{"status":"error","msg":"secret-private-provider-detail: Turing test failed"}`},
		{"redirect", http.StatusFound, `{"status":"ok"}`},
		{"malformed", http.StatusOK, `{"status":`},
	} {
		t.Run(response.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", "https://unrelated.invalid/recovery")
				w.WriteHeader(response.status)
				_, _ = w.Write([]byte(response.body))
			}))
			defer server.Close()
			service := onboardingTestService(t)
			service.config.CasdoorURL, service.config.BrowserApplication = server.URL, "browser"
			err := service.sendInvitation(context.Background(), authorization.OnboardingOperation{Email: "operator@example.test"})
			if !errors.Is(err, onboardingInvitationFailed) || strings.Contains(err.Error(), "secret-private") {
				t.Fatalf("unsafe or successful rejection: %v", err)
			}
		})
	}
}
