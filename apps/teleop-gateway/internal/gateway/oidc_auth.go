package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-jose/go-jose/v3"
	"github.com/go-jose/go-jose/v3/jwt"
)

var ErrInvalidToken = errors.New("invalid bearer token")

type Authenticator interface {
	Authenticate(context.Context, string) (*UserClaims, error)
}

type OIDCAuthenticator struct {
	issuer   string
	audiences jwt.Audience
	jwksURL  string
	client   *http.Client

	mu        sync.Mutex
	keys      jose.JSONWebKeySet
	fetchedAt time.Time
}

type oidcTokenClaims struct {
	jwt.Claims
	Organization string   `json:"organization"`
	Tenant       string   `json:"tenant"`
	Roles        []string `json:"roles"`
	Role         string   `json:"role"`
	Scope        ScopeClaim `json:"scope"`
}

type ScopeClaim []string

func (s *ScopeClaim) UnmarshalJSON(data []byte) error {
	var value string
	if err := json.Unmarshal(data, &value); err == nil {
		*s = strings.Fields(value)
		return nil
	}
	var values []string
	if err := json.Unmarshal(data, &values); err != nil {
		return err
	}
	*s = values
	return nil
}

func NewOIDCAuthenticator(issuer, audience, jwksURL string) (*OIDCAuthenticator, error) {
	if issuer == "" || audience == "" || jwksURL == "" {
		return nil, errors.New("OIDC_ISSUER, OIDC_AUDIENCE, and OIDC_JWKS_URL are required")
	}
	var audiences jwt.Audience
	for _, value := range strings.Split(audience, ",") {
		if value = strings.TrimSpace(value); value != "" {
			audiences = append(audiences, value)
		}
	}
	if len(audiences) == 0 {
		return nil, errors.New("OIDC_AUDIENCE must contain at least one audience")
	}
	return &OIDCAuthenticator{
		issuer:    issuer,
		audiences: audiences,
		jwksURL:   jwksURL,
		client:    &http.Client{Timeout: 3 * time.Second},
	}, nil
}

func (a *OIDCAuthenticator) Authenticate(ctx context.Context, rawToken string) (*UserClaims, error) {
	token, err := jwt.ParseSigned(rawToken)
	if err != nil || len(token.Headers) != 1 || token.Headers[0].KeyID == "" || !allowedOIDCAlgorithm(token.Headers[0].Algorithm) {
		return nil, ErrInvalidToken
	}

	key, err := a.keyFor(ctx, token.Headers[0].KeyID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}

	var claims oidcTokenClaims
	if err := token.Claims(key.Key, &claims); err != nil {
		return nil, ErrInvalidToken
	}
	scopes := []string(claims.Scope)
	tenant := firstNonEmpty(claims.Tenant, claims.Organization)
	if tenant == "" && hasScope(scopes, "teleop:vehicle") {
		tenant = "vehicle"
	}
	if !audienceAllowed(claims.Audience, a.audiences) || claims.Validate(jwt.Expected{Issuer: a.issuer, Time: time.Now()}) != nil || claims.Subject == "" || len(scopes) == 0 {
		return nil, ErrInvalidToken
	}

	return &UserClaims{
		Name:         claims.Subject,
		Organization: tenant,
		Roles:        claimRoles(claims),
		Scopes:       scopes,
	}, nil
}

func audienceAllowed(tokenAudience, allowedAudience jwt.Audience) bool {
	for _, allowed := range allowedAudience {
		if tokenAudience.Contains(allowed) {
			return true
		}
	}
	return false
}

func hasScope(scopes []string, wanted string) bool {
	for _, scope := range scopes {
		if scope == wanted {
			return true
		}
	}
	return false
}

func allowedOIDCAlgorithm(algorithm string) bool {
	switch jose.SignatureAlgorithm(algorithm) {
	case jose.RS256, jose.RS384, jose.RS512, jose.ES256, jose.ES384, jose.ES512, jose.EdDSA:
		return true
	default:
		return false
	}
}

func (a *OIDCAuthenticator) keyFor(ctx context.Context, keyID string) (jose.JSONWebKey, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if time.Since(a.fetchedAt) > 5*time.Minute || len(a.keys.Keys) == 0 {
		if err := a.refreshKeys(ctx); err != nil {
			return jose.JSONWebKey{}, err
		}
	}
	keys := a.keys.Key(keyID)
	if len(keys) == 0 {
		if err := a.refreshKeys(ctx); err != nil {
			return jose.JSONWebKey{}, err
		}
		keys = a.keys.Key(keyID)
	}
	if len(keys) != 1 {
		return jose.JSONWebKey{}, errors.New("signing key not found")
	}
	return keys[0], nil
}

func (a *OIDCAuthenticator) refreshKeys(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, a.jwksURL, nil)
	if err != nil {
		return fmt.Errorf("create JWKS request: %w", err)
	}
	response, err := a.client.Do(request)
	if err != nil {
		return fmt.Errorf("fetch JWKS: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch JWKS: status %d", response.StatusCode)
	}
	var keys jose.JSONWebKeySet
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&keys); err != nil {
		return fmt.Errorf("decode JWKS: %w", err)
	}
	if len(keys.Keys) == 0 {
		return errors.New("JWKS contains no keys")
	}
	a.keys = keys
	a.fetchedAt = time.Now()
	return nil
}

func claimRoles(claims oidcTokenClaims) []string {
	roles := append([]string{}, claims.Roles...)
	if claims.Role != "" {
		roles = append(roles, claims.Role)
	}
	for _, scope := range claims.Scope {
		switch scope {
		case "teleop:observe":
			roles = append(roles, "observer")
		case "teleop:control":
			roles = append(roles, "controller")
		case "teleop:supervise":
			roles = append(roles, "supervisor")
		case "teleop:vehicle":
			roles = append(roles, "vehicle")
		}
	}
	return roles
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

type DevAuthenticator struct{}

func (DevAuthenticator) Authenticate(_ context.Context, rawToken string) (*UserClaims, error) {
	claims := parseDevToken(rawToken)
	if claims.Name == "" {
		return nil, ErrInvalidToken
	}
	claims.Scopes = append([]string{}, claims.Roles...)
	return claims, nil
}

func NewAuthenticatorFromEnvironment() (Authenticator, error) {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AUTH_MODE"))) {
	case "dev":
		return DevAuthenticator{}, nil
	case "", "oidc":
		return NewOIDCAuthenticator(
			os.Getenv("OIDC_ISSUER"),
			os.Getenv("OIDC_AUDIENCE"),
			os.Getenv("OIDC_JWKS_URL"),
		)
	default:
		return nil, errors.New("AUTH_MODE must be dev or oidc")
	}
}