package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/go-jose/go-jose/v3/jwt"
)

type onboardingFailure string

func (f onboardingFailure) Error() string { return string(f) }

const (
	onboardingProviderUnavailable onboardingFailure = "PROVIDER_UNAVAILABLE"
	onboardingProviderConflict    onboardingFailure = "PROVIDER_CONFLICT"
	onboardingProviderRejected    onboardingFailure = "PROVIDER_REJECTED"
	onboardingInvitationFailed    onboardingFailure = "INVITATION_UNAVAILABLE"
)

// providerRequest deliberately discards all provider messages and never
// follows redirects carrying management credentials.
func (s *OnboardingService) providerRequest(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil || len(encoded) > 64<<10 {
			return nil, onboardingProviderRejected
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(s.config.CasdoorURL, "/")+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, onboardingProviderRejected
	}
	request.SetBasicAuth(s.config.ManagementClientID, s.config.ManagementClientSecret)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.providerHTTP.Do(request)
	if err != nil {
		return nil, onboardingProviderUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, onboardingProviderRejected
	}
	limited, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(limited) > 1<<20 {
		return nil, onboardingProviderUnavailable
	}
	var envelope struct {
		Status string          `json:"status"`
		Data   json.RawMessage `json:"data"`
	}
	if json.Unmarshal(limited, &envelope) != nil || envelope.Status != "ok" {
		return nil, onboardingProviderRejected
	}
	return envelope.Data, nil
}

type onboardingProviderUser struct {
	ID                string `json:"id"`
	Owner             string `json:"owner"`
	Name              string `json:"name"`
	Email             string `json:"email"`
	SignupApplication string `json:"signupApplication"`
	IsAdmin           bool   `json:"isAdmin"`
	IsForbidden       bool   `json:"isForbidden"`
	IsDeleted         bool   `json:"isDeleted"`
	Type              string `json:"type"`
}

func (s *OnboardingService) reconcilePerson(ctx context.Context, op authorization.OnboardingOperation) (bool, error) {
	raw, err := s.providerRequest(ctx, http.MethodGet, "/api/get-user?id="+url.QueryEscape(s.config.CasdoorOrganization+"/"+op.ProviderName), nil)
	if err != nil {
		return false, err
	}
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false, nil
	}
	var user onboardingProviderUser
	if json.Unmarshal(raw, &user) != nil || user.ID != op.PlannedIdentityID || user.Owner != s.config.CasdoorOrganization ||
		user.Name != op.ProviderName || user.SignupApplication != s.config.BrowserApplication || strings.ToLower(user.Email) != op.Email ||
		user.IsAdmin || user.IsForbidden || user.IsDeleted || user.Type != "normal-user" {
		return false, onboardingProviderConflict
	}
	return true, nil
}

func (s *OnboardingService) ensurePerson(ctx context.Context, op authorization.OnboardingOperation) error {
	if err := s.verifyRecoveryApplication(ctx); err != nil {
		return err
	}
	found, err := s.reconcilePerson(ctx, op)
	if err != nil || found {
		return err
	}
	password, err := onboardingRandom()
	if err != nil {
		return onboardingProviderUnavailable
	}
	_, createErr := s.providerRequest(ctx, http.MethodPost, "/api/add-user", map[string]any{
		"owner": s.config.CasdoorOrganization, "name": op.ProviderName, "id": op.PlannedIdentityID,
		"displayName": op.Name, "email": op.Email, "password": password, "type": "normal-user", "isAdmin": false,
		"signupApplication": s.config.BrowserApplication,
	})
	// Even a successful create is reconciled. A timed-out POST can have
	// succeeded; next attempt begins here with GET, not a new identity.
	found, err = s.reconcilePerson(ctx, op)
	if err != nil {
		return err
	}
	if !found {
		if createErr != nil {
			return createErr
		}
		return onboardingProviderConflict
	}
	return nil
}

type onboardingProviderApplication struct {
	Owner        string   `json:"owner"`
	Name         string   `json:"name"`
	Organization string   `json:"organization"`
	ClientID     string   `json:"clientId"`
	ClientSecret string   `json:"clientSecret"`
	TokenFormat  string   `json:"tokenFormat"`
	Cert         string   `json:"cert"`
	GrantTypes   []string `json:"grantTypes"`
	Scopes       []struct {
		Name string `json:"name"`
	} `json:"scopes"`
}

func (s *OnboardingService) reconcileVehicle(ctx context.Context, op authorization.OnboardingOperation) (json.RawMessage, error) {
	raw, err := s.providerRequest(ctx, http.MethodGet, "/api/get-application?id="+url.QueryEscape("admin/"+op.ProviderName), nil)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, nil
	}
	var app onboardingProviderApplication
	if json.Unmarshal(raw, &app) != nil || app.Owner != "admin" || app.Name != op.ProviderName ||
		app.Organization != s.config.CasdoorOrganization || app.ClientID != op.ClientID ||
		app.TokenFormat != "JWT" || app.Cert != s.config.Certificate ||
		len(app.GrantTypes) != 1 || app.GrantTypes[0] != "client_credentials" ||
		len(app.Scopes) != 1 || app.Scopes[0].Name != "teleop:vehicle" {
		return nil, onboardingProviderConflict
	}
	return raw, nil
}

func (s *OnboardingService) ensureVehicle(ctx context.Context, op authorization.OnboardingOperation) error {
	found, err := s.reconcileVehicle(ctx, op)
	if err != nil || found != nil {
		return err
	}
	secret, err := s.decryptCredential(op.CredentialCiphertext)
	if err != nil {
		return onboardingProviderRejected
	}
	_, createErr := s.providerRequest(ctx, http.MethodPost, "/api/add-application", map[string]any{
		"owner": "admin", "name": op.ProviderName, "organization": s.config.CasdoorOrganization,
		"displayName": op.Name, "cert": s.config.Certificate, "clientId": op.ClientID, "clientSecret": secret,
		"grantTypes": []string{"client_credentials"}, "tokenFormat": "JWT", "expireInHours": 0.1,
		"scopes": []map[string]string{{"name": "teleop:vehicle", "displayName": "Vehicle API"}},
	})
	found, err = s.reconcileVehicle(ctx, op)
	if err != nil {
		return err
	}
	if found == nil {
		if createErr != nil {
			return createErr
		}
		return onboardingProviderConflict
	}
	return nil
}

func (s *OnboardingService) rotateVehicle(ctx context.Context, op authorization.OnboardingOperation, secret string) error {
	raw, err := s.reconcileVehicle(ctx, op)
	if err != nil {
		return err
	}
	if raw == nil {
		return onboardingProviderConflict
	}
	var app map[string]any
	if json.Unmarshal(raw, &app) != nil {
		return onboardingProviderConflict
	}
	app["clientSecret"] = secret
	_, updateErr := s.providerRequest(ctx, http.MethodPost, "/api/update-application?id="+url.QueryEscape("admin/"+op.ProviderName), app)
	updated, err := s.reconcileVehicle(ctx, op)
	if err != nil {
		return err
	}
	if updated == nil {
		return onboardingProviderConflict
	}
	return updateErr
}

func (s *OnboardingService) verifyRecoveryApplication(ctx context.Context) error {
	raw, err := s.providerRequest(ctx, http.MethodGet, "/api/get-application?id="+url.QueryEscape("admin/"+s.config.BrowserApplication), nil)
	if err != nil {
		return err
	}
	var app struct {
		Owner          string `json:"owner"`
		Name           string `json:"name"`
		Organization   string `json:"organization"`
		EnablePassword bool   `json:"enablePassword"`
		Providers      []struct {
			Rule     string `json:"rule"`
			Provider *struct {
				Category string `json:"category"`
			} `json:"provider"`
		} `json:"providers"`
	}
	if json.Unmarshal(raw, &app) != nil || app.Owner != "admin" || app.Name != s.config.BrowserApplication ||
		app.Organization != s.config.CasdoorOrganization || !app.EnablePassword {
		return onboardingProviderConflict
	}
	for _, p := range app.Providers {
		if p.Provider != nil && p.Provider.Category == "Email" {
			switch p.Rule {
			case "forget", "", "All", "all", "None":
				return nil
			}
		}
	}
	return onboardingProviderRejected
}

func (s *OnboardingService) verifyVehicleToken(ctx context.Context, op authorization.OnboardingOperation) error {
	secret, err := s.decryptCredential(op.CredentialCiphertext)
	if err != nil {
		return onboardingProviderRejected
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {op.ClientID}, "client_secret": {secret}, "scope": {"teleop:vehicle"}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.config.CasdoorURL, "/")+"/api/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return onboardingProviderRejected
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := s.providerHTTP.Do(request)
	if err != nil {
		return onboardingProviderUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return onboardingProviderRejected
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return onboardingProviderUnavailable
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if json.Unmarshal(raw, &token) != nil || token.AccessToken == "" || len(token.AccessToken) > 64<<10 {
		return onboardingProviderRejected
	}
	verifier, err := NewOIDCAuthenticator(s.issuer, op.ClientID, s.config.JWKSURL)
	if err != nil {
		return onboardingProviderRejected
	}
	verifier.client = s.providerHTTP
	claims, err := verifier.Authenticate(ctx, token.AccessToken)
	if err != nil || claims.Name != "admin/"+op.ProviderName || len(claims.Scopes) != 1 || claims.Scopes[0] != "teleop:vehicle" {
		return onboardingProviderConflict
	}
	// Authenticate verifies signature, issuer, time and audience. Require
	// Casdoor's signed access-token discriminator and bounded lifetime too.
	signed, err := jwt.ParseSigned(token.AccessToken)
	if err != nil {
		return onboardingProviderConflict
	}
	key, err := verifier.keyFor(ctx, signed.Headers[0].KeyID)
	if err != nil {
		return onboardingProviderUnavailable
	}
	var actual oidcTokenClaims
	if signed.Claims(key.Key, &actual) != nil || actual.TokenType != "access-token" || actual.Expiry == nil ||
		actual.Expiry.Time().After(time.Now().Add(10*time.Minute)) {
		return onboardingProviderConflict
	}
	return nil
}

func (s *OnboardingService) sendInvitation(ctx context.Context, op authorization.OnboardingOperation) error {
	// Casdoor owns both recovery credentials and mail configuration. Invoke
	// the pinned public recovery flow, without management Basic credentials.
	form := url.Values{
		"captchaType": {"none"}, "captchaToken": {""}, "clientSecret": {""},
		"method": {"forget"}, "countryCode": {""}, "dest": {op.Email},
		"type": {"email"}, "applicationId": {"admin/" + s.config.BrowserApplication},
		"checkUser": {""}, "signinPath": {""},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.config.CasdoorURL, "/")+"/api/send-verification-code", strings.NewReader(form.Encode()))
	if err != nil {
		return onboardingInvitationFailed
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := s.providerHTTP.Do(request)
	if err != nil {
		return onboardingInvitationFailed
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return onboardingInvitationFailed
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return onboardingInvitationFailed
	}
	var result struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Status != "ok" {
		return onboardingInvitationFailed
	}
	// Provider acceptance only: first login and mailbox delivery are not
	// inferred, and Gateway never receives the recovery code or password.
	return nil
}

func onboardingSafeFailure(err error) string {
	var failure onboardingFailure
	if errors.As(err, &failure) {
		return string(failure)
	}
	if errors.Is(err, authorization.ErrNotOrganizationAdmin) || errors.Is(err, authorization.ErrInactiveLifecycle) || errors.Is(err, authorization.ErrIdentityBindingRestricted) {
		return "AUTHORIZATION_CHANGED"
	}
	if errors.Is(err, authorization.ErrConflict) || errors.Is(err, authorization.ErrSelfAssignment) {
		return "BINDING_CONFLICT"
	}
	return "CONFIGURATION_INVALID"
}
