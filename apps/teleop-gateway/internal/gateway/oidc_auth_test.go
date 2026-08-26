package gateway

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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