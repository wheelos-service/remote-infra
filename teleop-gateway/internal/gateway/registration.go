package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
)

func (s *OnboardingService) newRegistrationCode() ([]byte, error) {
	var code [32]byte
	if _, err := rand.Read(code[:]); err != nil {
		return nil, onboardingProviderUnavailable
	}
	return s.encryptCredential(hex.EncodeToString(code[:]))
}

func (s *OnboardingService) registrationCode(op authorization.OnboardingOperation) (string, error) {
	size := s.aead.NonceSize()
	data := op.CredentialCiphertext
	if len(data) != size+64+s.aead.Overhead() {
		return "", onboardingProviderRejected
	}
	clear, err := s.aead.Open(nil, data[:size], data[size:], []byte("teleop-onboarding-credential-v1"))
	if err != nil {
		return "", onboardingProviderRejected
	}
	if decoded, err := hex.DecodeString(string(clear)); err != nil || len(decoded) != 32 {
		return "", onboardingProviderRejected
	}
	return string(clear), nil
}

// Verify the pinned native signup contract before issuing an invitation. No
// password, email delivery, or public self-registration is handled by Gateway.
func (s *OnboardingService) verifyRegistrationApplication(ctx context.Context) error {
	raw, err := s.providerRequest(ctx, http.MethodGet, "/api/get-application?id="+url.QueryEscape("admin/"+s.config.BrowserApplication), nil)
	if err != nil {
		return err
	}
	var app struct {
		Owner, Name, Organization    string
		EnablePassword, EnableSignUp bool
		SignupItems                  []struct {
			Name              string
			Visible, Required bool
		}
	}
	if json.Unmarshal(raw, &app) != nil || app.Owner != "admin" || app.Name != s.config.BrowserApplication ||
		app.Organization != s.config.CasdoorOrganization || !app.EnablePassword || !app.EnableSignUp {
		return onboardingProviderConflict
	}
	required := map[string]bool{"Username": false, "Password": false, "Invitation code": false}
	for _, item := range app.SignupItems {
		if _, ok := required[item.Name]; ok {
			required[item.Name] = item.Visible && item.Required
		}
		if item.Visible && (item.Name == "Email" || item.Name == "Phone" || item.Name == "Email and phone") {
			return onboardingProviderConflict
		}
	}
	for _, present := range required {
		if !present {
			return onboardingProviderConflict
		}
	}
	return nil
}

type registrationInvitation struct {
	Owner       string `json:"owner"`
	Name        string `json:"name"`
	CreatedTime string `json:"createdTime"`
	DisplayName string `json:"displayName"`
	Code        string `json:"code"`
	DefaultCode string `json:"defaultCode"`
	IsRegexp    bool   `json:"isRegexp"`
	Quota       int    `json:"quota"`
	UsedCount   int    `json:"usedCount"`
	Application string `json:"application"`
	Username    string `json:"username"`
	Email       string `json:"email"`
	Phone       string `json:"phone"`
	SignupGroup string `json:"signupGroup"`
	ExpireTime  string `json:"expireTime"`
	State       string `json:"state"`
}

func (s *OnboardingService) registrationInvitation(op authorization.OnboardingOperation) (registrationInvitation, error) {
	code, err := s.registrationCode(op)
	return registrationInvitation{Owner: s.config.CasdoorOrganization, Name: op.ProviderName,
		CreatedTime: op.CreatedAt.UTC().Format(time.RFC3339), DisplayName: op.Name, Code: code, DefaultCode: code,
		Quota: 1, Application: s.config.BrowserApplication, Username: op.Name,
		ExpireTime: op.CreatedAt.Add(authorization.RegistrationLifetime).UTC().Format(time.RFC3339), State: "Active"}, err
}

func (s *OnboardingService) reconcileRegistration(ctx context.Context, want registrationInvitation) (bool, error) {
	raw, err := s.providerRequest(ctx, http.MethodGet, "/api/get-invitation?id="+url.QueryEscape(want.Owner+"/"+want.Name), nil)
	if err != nil {
		return false, err
	}
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false, nil
	}
	var actual registrationInvitation
	if json.Unmarshal(raw, &actual) != nil || actual.Owner != want.Owner || actual.Name != want.Name ||
		actual.Application != want.Application || actual.Username != want.Username || actual.Code != want.Code ||
		actual.DefaultCode != want.Code || actual.IsRegexp || actual.Quota != 1 || actual.UsedCount < 0 || actual.UsedCount > 1 ||
		actual.ExpireTime != want.ExpireTime || actual.State != "Active" || actual.Email != "" || actual.Phone != "" || actual.SignupGroup != "" {
		return false, onboardingProviderConflict
	}
	return true, nil
}

func (s *OnboardingService) ensureRegistration(ctx context.Context, op authorization.OnboardingOperation) error {
	if err := s.verifyRegistrationApplication(ctx); err != nil {
		return err
	}
	want, err := s.registrationInvitation(op)
	if err != nil {
		return err
	}
	found, err := s.reconcileRegistration(ctx, want)
	if err != nil || found {
		return err
	}
	// Never invite an already existing username or silently adopt its identity.
	raw, err := s.providerRequest(ctx, http.MethodGet, "/api/get-user?id="+url.QueryEscape(want.Owner+"/"+op.Name), nil)
	if err != nil {
		return err
	}
	if len(raw) != 0 && !bytes.Equal(raw, []byte("null")) {
		return onboardingProviderConflict
	}
	_, createErr := s.providerRequest(ctx, http.MethodPost, "/api/add-invitation", want)
	found, err = s.reconcileRegistration(ctx, want)
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

func (s *OnboardingService) registeredPerson(ctx context.Context, op authorization.OnboardingOperation) (string, error) {
	want, err := s.registrationInvitation(op)
	if err != nil {
		return "", err
	}
	found, err := s.reconcileRegistration(ctx, want)
	if err != nil {
		return "", err
	}
	if !found {
		return "", onboardingProviderConflict
	}
	raw, err := s.providerRequest(ctx, http.MethodGet, "/api/get-user?id="+url.QueryEscape(want.Owner+"/"+op.Name), nil)
	if err != nil {
		return "", err
	}
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "", nil
	}
	var user struct {
		onboardingProviderUser
		Invitation     string `json:"invitation"`
		InvitationCode string `json:"invitationCode"`
		CreatedTime    string `json:"createdTime"`
	}
	if json.Unmarshal(raw, &user) != nil || !onboardingUUID(user.ID) || user.Owner != want.Owner || user.Name != op.Name ||
		user.SignupApplication != want.Application || user.Invitation != want.Name || user.InvitationCode != want.Code ||
		user.IsAdmin || user.IsForbidden || user.IsDeleted || user.Type != "normal-user" {
		return "", onboardingProviderConflict
	}
	created, err := time.Parse(time.RFC3339, user.CreatedTime)
	if err != nil || created.Before(op.CreatedAt.Truncate(time.Second)) || created.After(op.CreatedAt.Add(authorization.RegistrationLifetime)) {
		return "", onboardingProviderConflict
	}
	return user.ID, nil
}

func (s *OnboardingService) serveRegistrationLink(w http.ResponseWriter, r *http.Request, actor, org, id string) {
	op, err := s.store.GetOnboarding(r.Context(), actor, org, id)
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	if op.Kind != "person" || op.Email != "" || op.Stage != "registration" ||
		(op.Status != "awaiting_registration" && op.Status != "running" && op.Status != "pending") ||
		time.Now().After(op.CreatedAt.Add(authorization.RegistrationLifetime)) {
		onboardingHTTPError(w, r, authorization.ErrConflict)
		return
	}
	code, err := s.registrationCode(op)
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	link := strings.TrimRight(s.issuer, "/") + "/signup/" + url.PathEscape(s.config.BrowserApplication) + "?" + url.Values{"invitationCode": {code}}.Encode()
	writeJSON(w, http.StatusOK, map[string]any{"url": link, "expires_at": op.CreatedAt.Add(authorization.RegistrationLifetime)})
}
