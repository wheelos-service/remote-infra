package gateway

import (
	"context"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
)

func TestCasdoorRealDeviceTokenAndBinding(t *testing.T) {
	raw := os.Getenv("CASDOOR_CONTRACT_ACCESS_TOKEN")
	if raw == "" {
		t.Skip("run python3 tests/casdoor-contract.py for disposable actual Casdoor acceptance")
	}
	issuer := os.Getenv("CASDOOR_CONTRACT_ISSUER")
	jwksURL := os.Getenv("CASDOOR_CONTRACT_JWKS_URL")
	for _, value := range []string{issuer, jwksURL} {
		endpoint, err := url.Parse(value)
		if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" {
			t.Fatal("Casdoor contract requires isolated loopback endpoints")
		}
	}
	verifier, err := NewOIDCAuthenticator(issuer, os.Getenv("CASDOOR_CONTRACT_AUDIENCE"), jwksURL)
	if err != nil {
		t.Fatal("could not configure actual Casdoor verifier")
	}
	claims, err := verifier.Authenticate(context.Background(), raw)
	if err != nil {
		t.Fatal("Gateway rejected actual Casdoor JWT signature or claims")
	}
	if claims.Name != "admin/contract-vehicle" || !hasScope(claims.Scopes, "teleop:vehicle") {
		t.Fatal("actual verified device identity or delegation differs from contract")
	}
	wrongAudience, err := NewOIDCAuthenticator(issuer, "undelegated-audience", jwksURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrongAudience.Authenticate(context.Background(), raw); err == nil {
		t.Fatal("actual Casdoor token accepted with wrong audience")
	}
	f := newManagedFixture(t)
	f.runtime.issuer = issuer
	if _, err := f.store.RegisterVehicle(context.Background(), f.adminID, f.orgID, issuer,
		"real-idp-car", "Disposable actual IdP vehicle", claims.Name); err != nil {
		t.Fatal("could not persist actual verified Casdoor subject binding")
	}
	r := httptest.NewRequest("GET", "/api/vehicles/real-idp-car/device-auth-check", nil)
	release, err := f.runtime.authorizeRequest(r, claims)
	if err != nil {
		t.Fatal("managed runtime rejected actual verified Casdoor device binding")
	}
	defer release()
	id, ok := resolveVehicleClaims(claims, nil)
	if !ok || id != "real-idp-car" || claims.UserID != "" {
		t.Fatal("actual machine token did not remain confined to bound vehicle identity")
	}
	personVerifier, err := NewOIDCAuthenticator(issuer, os.Getenv("CASDOOR_CONTRACT_PERSON_AUDIENCE"), jwksURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := personVerifier.Authenticate(context.Background(), os.Getenv("CASDOOR_CONTRACT_ID_TOKEN")); err == nil {
		t.Fatal("actual Casdoor ID token was accepted in place of an API access token")
	}
	personClaims, err := personVerifier.Authenticate(context.Background(), os.Getenv("CASDOOR_CONTRACT_PERSON_TOKEN"))
	if err != nil || personClaims.Name != os.Getenv("CASDOOR_CONTRACT_PERSON_SUBJECT") ||
		!hasScope(personClaims.Scopes, "teleop:observe") {
		t.Fatal("actual public PKCE person token failed trusted subject or delegation verification")
	}
	person, err := f.store.RegisterPerson(context.Background(), f.adminID, f.orgID, issuer,
		"Disposable actual PKCE person", personClaims.Name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AssignManagedRole(context.Background(), authorization.Assignment{
		ActorUserID: f.adminID, UserID: person.UserID, OrganizationID: f.orgID,
		Role: authorization.RoleViewer, Scope: authorization.ScopeSelected,
		VehicleIDs: []string{"real-idp-car"},
	}); err != nil {
		t.Fatal(err)
	}
	personRequest := httptest.NewRequest("GET", "/api/vehicles/real-idp-car/state", nil)
	releasePerson, err := f.runtime.authorizeRequest(personRequest, personClaims)
	if err != nil {
		t.Fatal("managed runtime rejected actual verified PKCE person binding")
	}
	defer releasePerson()
	if personClaims.UserID != person.UserID ||
		personClaims.managed.permissions["real-idp-car"][ControlPermission] ||
		!personClaims.managed.permissions["real-idp-car"][ObservePermission] {
		t.Fatal("actual PKCE viewer received unexpected business permissions")
	}
}
