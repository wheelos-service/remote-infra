package gateway

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v3"
	"github.com/go-jose/go-jose/v3/jwt"
)

func TestOIDCAuthenticator(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	const keyID = "test-key"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{
			Key: &privateKey.PublicKey, KeyID: keyID, Algorithm: string(jose.RS256), Use: "sig",
		}}})
	}))
	defer server.Close()

	authenticator, err := NewOIDCAuthenticator("https://issuer.example.com", "teleop-api,vehicle-client-id", server.URL)
	if err != nil {
		t.Fatalf("NewOIDCAuthenticator() error = %v", err)
	}

	token := signedTestToken(t, privateKey, keyID, "teleop-api")
	claims, err := authenticator.Authenticate(context.Background(), token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if claims.Name != "operator-001" || claims.Organization != "fleet-a" || !hasRole(claims.Roles, "controller") {
		t.Fatalf("Authenticate() claims = %#v, want operator, tenant, controller role", claims)
	}

	wrongAudience := signedTestToken(t, privateKey, keyID, "other-api")
	if _, err := authenticator.Authenticate(context.Background(), wrongAudience); err == nil {
		t.Fatal("Authenticate() with wrong audience error = nil, want error")
	}

	unknownKey := signedTestToken(t, privateKey, "unknown-key", "teleop-api")
	if _, err := authenticator.Authenticate(context.Background(), unknownKey); err == nil {
		t.Fatal("Authenticate() with unknown key ID error = nil, want error")
	}

	arrayScopeToken := signedTestTokenWithScope(t, privateKey, keyID, "teleop-api", []string{"teleop:observe", "teleop:control"})
	arrayScopeClaims, err := authenticator.Authenticate(context.Background(), arrayScopeToken)
	if err != nil || !hasRole(arrayScopeClaims.Roles, "controller") {
		t.Fatalf("Authenticate() array scope = %#v, %v; want controller role", arrayScopeClaims, err)
	}

	missingTenant := signedTestTokenWithTenant(t, privateKey, keyID, "teleop-api", "", "teleop:vehicle")
	if claims, err := authenticator.Authenticate(context.Background(), missingTenant); err != nil || claims.Organization != "vehicle" {
		t.Fatalf("Authenticate() vehicle without tenant = %#v, %v; want vehicle organization", claims, err)
	}

	operatorWithoutTenant := signedTestTokenWithTenant(t, privateKey, keyID, "teleop-api", "", "teleop:observe teleop:control")
	if claims, err := authenticator.Authenticate(context.Background(), operatorWithoutTenant); err != nil || claims.Organization != "" {
		t.Fatalf("Authenticate() operator without tenant = %#v, %v; want success with empty organization", claims, err)
	}

	clientAudience := signedTestTokenWithTenant(t, privateKey, keyID, "vehicle-client-id", "fleet-a", "teleop:vehicle")
	if _, err := authenticator.Authenticate(context.Background(), clientAudience); err != nil {
		t.Fatalf("Authenticate() with second configured audience error = %v, want success", err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: privateKey},
		(&jose.SignerOptions{}).WithHeader(jose.HeaderKey("kid"), keyID))
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"access-token", "id-token", "refresh-token", "unexpected"} {
		t.Run(kind, func(t *testing.T) {
			raw, err := jwt.Signed(signer).Claims(map[string]any{
				"iss": "https://issuer.example.com", "aud": "teleop-api",
				"sub": "operator-001", "exp": time.Now().Add(time.Minute).Unix(),
				"scope": "teleop:observe", "tokenType": kind,
			}).CompactSerialize()
			if err != nil {
				t.Fatal(err)
			}
			_, err = authenticator.Authenticate(context.Background(), raw)
			if kind == "access-token" {
				if err != nil {
					t.Fatal("explicit access token rejected")
				}
				return
			}
			var failure authenticationFailure
			if !errors.Is(err, ErrInvalidToken) || !errors.As(err, &failure) ||
				string(failure) != "OIDC_TOKEN_TYPE_INVALID" || err.Error() != ErrInvalidToken.Error() {
				t.Fatal("non-access token did not fail with sanitized token-type diagnostic")
			}
		})
	}
}

func TestDevAuthenticator(t *testing.T) {
	claims, err := (DevAuthenticator{}).Authenticate(context.Background(), "vehicle-001|fleet-a|vehicle")
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if claims.Name != "vehicle-001" || !hasRole(claims.Roles, "vehicle") {
		t.Fatalf("Authenticate() claims = %#v, want vehicle identity", claims)
	}
}

func TestManagedMachineAudienceRequiresVerifiedNarrowAccessToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{
			Key: &key.PublicKey, KeyID: "managed-key", Algorithm: string(jose.RS256), Use: "sig",
		}}})
	}))
	defer server.Close()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithHeader(jose.HeaderKey("kid"), "managed-key"))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, issuer, subject, scope, kind                    string
		expired, missingExpiry, dbFailure, bound, wantAllowed bool
		wantCalls                                             int
	}{
		{name: "bound vehicle", bound: true, wantAllowed: true, wantCalls: 1},
		{name: "unbound vehicle", wantCalls: 1},
		{name: "database failure", bound: true, dbFailure: true, wantCalls: 1},
		{name: "wrong issuer", issuer: "https://untrusted.example", bound: true},
		{name: "wrong subject", subject: "another-vehicle"},
		{name: "personnel scope", scope: "teleop:observe", bound: true},
		{name: "mixed scope", scope: "teleop:vehicle teleop:observe", bound: true},
		{name: "id token", kind: "id-token", bound: true},
		{name: "legacy untyped token", kind: "absent", bound: true},
		{name: "expired", expired: true, bound: true},
		{name: "missing expiry", missingExpiry: true, bound: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			a, err := NewOIDCAuthenticator("https://managed.example", "fixed-browser", server.URL)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			a.machineAudience = func(_ context.Context, issuer, sub string, audiences []string) (bool, error) {
				calls++
				if issuer != "https://managed.example" || len(audiences) != 1 || audiences[0] != "new-vehicle-client" {
					t.Fatal("unverified identity passed to managed audience lookup")
				}
				if test.dbFailure {
					return false, errors.New("private database detail")
				}
				return test.bound && sub == "admin/new-vehicle", nil
			}
			claims := map[string]any{
				"iss": "https://managed.example", "sub": "admin/new-vehicle",
				"aud": "new-vehicle-client", "exp": time.Now().Add(time.Minute).Unix(),
				"scope": "teleop:vehicle", "tokenType": "access-token",
			}
			for field, value := range map[string]string{
				"iss": test.issuer, "sub": test.subject, "scope": test.scope, "tokenType": test.kind,
			} {
				if value != "" {
					claims[field] = value
				}
			}
			if test.kind == "absent" {
				delete(claims, "tokenType")
			}
			if test.expired {
				claims["exp"] = time.Now().Add(-5 * time.Minute).Unix()
			}
			if test.missingExpiry {
				delete(claims, "exp")
			}
			raw, err := jwt.Signed(signer).Claims(claims).CompactSerialize()
			if err != nil {
				t.Fatal(err)
			}
			result, err := a.Authenticate(context.Background(), raw)
			wantCalls := test.wantCalls
			if test.subject != "" {
				wantCalls = 1
			}
			if (err == nil) != test.wantAllowed || calls != wantCalls {
				t.Fatalf("allowed=%v calls=%d want allowed=%v calls=%d", err == nil, calls, test.wantAllowed, wantCalls)
			}
			if err != nil && err.Error() != ErrInvalidToken.Error() {
				t.Fatal("lookup failure exposed internal details")
			}
			if result != nil && (len(result.Audiences) != 1 || result.Audiences[0] != "new-vehicle-client") {
				t.Fatal("verified audience was not retained")
			}
		})
	}
}

func TestOIDCDiagnosticReasonsDoNotExposeTokensOrProviderBodies(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const keyID = "diagnostic-key"
	var failingJWKS atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failingJWKS.Load() {
			http.Error(w, "private-provider-response-and-secret", http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{
			Key: &key.PublicKey, KeyID: keyID, Algorithm: string(jose.RS256), Use: "sig",
		}}})
	}))
	defer server.Close()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader(jose.HeaderKey("kid"), keyID))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, reason string
		modify       func(*jwt.Claims, *string)
	}{
		{"audience", "OIDC_AUDIENCE_MISMATCH", func(c *jwt.Claims, _ *string) { c.Audience = jwt.Audience{"other"} }},
		{"issuer", "OIDC_ISSUER_MISMATCH", func(c *jwt.Claims, _ *string) { c.Issuer = "https://other.example" }},
		{"expired", "OIDC_TIME_INVALID", func(c *jwt.Claims, _ *string) { c.Expiry = jwt.NewNumericDate(time.Now().Add(-5 * time.Minute)) }},
		{"subject", "OIDC_SUBJECT_MISSING", func(c *jwt.Claims, _ *string) { c.Subject = "" }},
		{"scope", "OIDC_SCOPE_MISSING", func(_ *jwt.Claims, s *string) { *s = "" }},
		{"jwks", "OIDC_JWKS_HTTP_ERROR", func(_ *jwt.Claims, _ *string) { failingJWKS.Store(true) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			failingJWKS.Store(false)
			claims := jwt.Claims{
				Issuer: "https://issuer.example", Subject: "subject",
				Audience: jwt.Audience{"teleop-api"}, Expiry: jwt.NewNumericDate(time.Now().Add(time.Minute)),
			}
			scope := "teleop:observe"
			test.modify(&claims, &scope)
			raw, err := jwt.Signed(signer).Claims(struct {
				jwt.Claims
				Scope string `json:"scope"`
			}{claims, scope}).CompactSerialize()
			if err != nil {
				t.Fatal(err)
			}
			a, err := NewOIDCAuthenticator("https://issuer.example", "teleop-api", server.URL)
			if err != nil {
				t.Fatal(err)
			}
			_, err = a.Authenticate(context.Background(), raw)
			var failure authenticationFailure
			if !errors.Is(err, ErrInvalidToken) || !errors.As(err, &failure) || string(failure) != test.reason {
				t.Fatalf("unexpected authentication failure: %v (%s)", err, failure)
			}
			if err.Error() != ErrInvalidToken.Error() {
				t.Fatal("authentication error exposed internal diagnostics")
			}
		})
	}
}

func signedTestToken(t *testing.T, privateKey *rsa.PrivateKey, keyID, audience string) string {
	return signedTestTokenWithScope(t, privateKey, keyID, audience, "teleop:observe teleop:control")
}

func signedTestTokenWithScope(t *testing.T, privateKey *rsa.PrivateKey, keyID, audience string, scope any) string {
	return signedTestTokenWithTenant(t, privateKey, keyID, audience, "fleet-a", scope)
}

func signedTestTokenWithTenant(t *testing.T, privateKey *rsa.PrivateKey, keyID, audience, tenant string, scope any) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: privateKey}, (&jose.SignerOptions{}).WithHeader(jose.HeaderKey("kid"), keyID))
	if err != nil {
		t.Fatalf("NewSigner() error = %v", err)
	}
	claims := struct {
		jwt.Claims
		Tenant string `json:"tenant"`
		Scope  any    `json:"scope"`
	}{
		Claims: jwt.Claims{
			Issuer:   "https://issuer.example.com",
			Subject:  "operator-001",
			Audience: jwt.Audience{audience},
			Expiry:   jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
		Tenant: tenant,
		Scope:  scope,
	}
	raw, err := jwt.Signed(signer).Claims(claims).CompactSerialize()
	if err != nil {
		t.Fatalf("CompactSerialize() error = %v", err)
	}
	return raw
}
