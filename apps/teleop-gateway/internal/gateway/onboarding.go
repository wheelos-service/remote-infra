package gateway

import (
	"context"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/google/uuid"
)

type OnboardingService struct {
	store           *authorization.Store
	issuer          string
	config          onboardingConfig
	aead            cipher.AEAD
	acquireAdditive func(context.Context, string) (func(), error)
	providerHTTP    *http.Client
	workMu          sync.Mutex
}

func NewOnboardingServiceFromEnvironment(store *authorization.Store, trustedIssuer string, acquireAdditive func(context.Context, string) (func(), error)) (*OnboardingService, error) {
	path := os.Getenv("AUTHORIZATION_ONBOARDING_CONFIG_FILE")
	if path == "" {
		return nil, nil
	}
	if store == nil || acquireAdditive == nil || !onboardingSafeURL(trustedIssuer) {
		return nil, errOnboardingConfig
	}
	config, aead, err := loadOnboardingConfig(path)
	if err != nil {
		return nil, err
	}
	return &OnboardingService{store: store, issuer: trustedIssuer, config: config, aead: aead, acquireAdditive: acquireAdditive,
		providerHTTP: &http.Client{Timeout: 10 * time.Second,
			Transport:     &http.Transport{ResponseHeaderTimeout: 5 * time.Second, TLSHandshakeTimeout: 5 * time.Second, MaxIdleConnsPerHost: 2},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (s *OnboardingService) Register(mux *http.ServeMux, authenticate func(http.Handler) http.Handler) {
	for _, pattern := range []string{
		"GET /api/admin/organizations/{org_id}/onboarding",
		"POST /api/admin/organizations/{org_id}/onboarding",
		"GET /api/admin/organizations/{org_id}/onboarding/{operation_id}",
		"POST /api/admin/organizations/{org_id}/onboarding/{operation_id}/retry",
		"POST /api/admin/organizations/{org_id}/onboarding/{operation_id}/installation-ticket",
	} {
		mux.Handle(pattern, authenticate(http.HandlerFunc(s.serveAdmin)))
	}
	mux.Handle("POST /api/vehicle/install", http.HandlerFunc(s.serveInstall))
	mux.Handle("POST /api/vehicles/{vehicle_id}/installation-complete", authenticate(http.HandlerFunc(s.serveInstallationComplete)))
}

func (s *OnboardingService) mutate(ctx context.Context, org string, fn func() error) error {
	release, err := s.acquireAdditive(ctx, org)
	if err != nil {
		return err
	}
	if release == nil {
		return errors.New("additive runtime guard unavailable")
	}
	defer release()
	return fn()
}

func (s *OnboardingService) serveAdmin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, _ := r.Context().Value("user").(*UserClaims)
	if claims == nil || claims.UserID == "" || claims.Issuer != s.issuer {
		writeDiagnosticError(w, r, "a bound human identity is required", "MANAGED_IDENTITY_REQUIRED", http.StatusForbidden)
		return
	}
	org := r.PathValue("org_id")
	if !onboardingUUID(org) || (r.PathValue("operation_id") != "" && !onboardingUUID(r.PathValue("operation_id"))) {
		managedAdminError(w, r, authorization.ErrInvalidRegistration)
		return
	}
	if r.Method == http.MethodGet {
		var result any
		var err error
		if r.PathValue("operation_id") == "" {
			result, err = s.store.ListOnboarding(r.Context(), claims.UserID, org)
		} else {
			result, err = s.store.GetOnboarding(r.Context(), claims.UserID, org, r.PathValue("operation_id"))
		}
		if err != nil {
			managedAdminError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	var op authorization.OnboardingOperation
	var err error
	switch r.Pattern {
	case "POST /api/admin/organizations/{org_id}/onboarding":
		var request authorization.OnboardingRequest
		if err := decodeManagedBody(w, r, &request, "kind", "name", "email", "vehicle_id", "vehicle_number", "role", "scope", "vehicle_ids", "idempotency_key"); err != nil {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
		var ciphertext []byte
		if request.Kind == "vehicle" {
			secret, randomErr := onboardingRandom()
			if randomErr != nil {
				onboardingHTTPError(w, r, randomErr)
				return
			}
			ciphertext, err = s.encryptCredential(secret)
			if err != nil {
				onboardingHTTPError(w, r, err)
				return
			}
		}
		err = s.mutate(r.Context(), org, func() error {
			var e error
			op, e = s.store.CreateOnboarding(r.Context(), claims.UserID, org, request, ciphertext)
			return e
		})
	case "POST /api/admin/organizations/{org_id}/onboarding/{operation_id}/retry":
		if err := onboardingEmptyBody(w, r); err != nil {
			managedAdminError(w, r, err)
			return
		}
		err = s.mutate(r.Context(), org, func() error {
			var e error
			op, e = s.store.RetryOnboarding(r.Context(), claims.UserID, org, r.PathValue("operation_id"))
			return e
		})
	default:
		if err := onboardingEmptyBody(w, r); err != nil {
			managedAdminError(w, r, err)
			return
		}
		s.issueInstallationTicket(w, r, claims.UserID, org, r.PathValue("operation_id"))
		return
	}
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, op)
}

func onboardingUUID(raw string) bool {
	id, err := uuid.Parse(raw)
	return err == nil && id.String() == raw
}

func onboardingEmptyBody(w http.ResponseWriter, r *http.Request) error {
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}
	var empty struct{}
	if decodeManagedBody(w, r, &empty) != nil {
		return authorization.ErrInvalidRegistration
	}
	return nil
}

func onboardingHTTPError(w http.ResponseWriter, r *http.Request, err error) {
	var provider onboardingFailure
	if errors.As(err, &provider) {
		writeDiagnosticError(w, r, "identity provider operation could not be completed; retry safely", string(provider), http.StatusBadGateway)
		return
	}
	managedAdminError(w, r, err)
}

// Run is a single durable worker, owned by the same Gateway as the managed
// lifetime-lock connection. No SQL transaction is held across network I/O.
func (s *OnboardingService) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		s.workMu.Lock()
		op, err := s.store.NextOnboarding(ctx)
		if err == nil {
			s.process(ctx, op)
		}
		s.workMu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *OnboardingService) process(ctx context.Context, op authorization.OnboardingOperation) {
	attempt, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	if op.Attempts >= 3 {
		_ = s.mutate(attempt, op.OrganizationID, func() error { return s.store.FailOnboarding(attempt, op.ID, "PROVIDER_UNAVAILABLE") })
		return
	}
	err := s.mutate(attempt, op.OrganizationID, func() error { return s.store.StartOnboarding(attempt, op.ID) })
	if err != nil {
		if errors.Is(err, authorization.ErrNotOrganizationAdmin) || errors.Is(err, authorization.ErrInactiveLifecycle) || errors.Is(err, authorization.ErrIdentityBindingRestricted) {
			_ = s.mutate(attempt, op.OrganizationID, func() error { return s.store.RejectOnboardingAuthorization(attempt, op.ID) })
		}
		return
	}
	if op.Stage == "planned" || op.Stage == "provider" {
		if op.Kind == "person" {
			err = s.ensurePerson(attempt, op)
		} else {
			err = s.ensureVehicle(attempt, op)
			if err == nil {
				err = s.verifyVehicleToken(attempt, op)
			}
		}
		if err == nil {
			subject := op.PlannedIdentityID
			if op.Kind == "vehicle" {
				subject = "admin/" + op.ProviderName
			}
			err = s.mutate(attempt, op.OrganizationID, func() error { return s.store.BindOnboarding(attempt, op, s.issuer, subject) })
		}
		if err == nil && op.Kind == "person" {
			op.Stage = "invitation"
		}
	}
	if err == nil && op.Stage == "invitation" {
		// Revoked administrators must not drive additional external actions.
		var allowed bool
		allowed, err = s.store.CanManageOrganization(attempt, op.ActorUserID, op.OrganizationID)
		if err == nil && !allowed {
			err = authorization.ErrNotOrganizationAdmin
		}
		if err == nil {
			err = s.sendInvitation(attempt, op)
		}
		if err == nil {
			err = s.mutate(attempt, op.OrganizationID, func() error { return s.store.CompleteInvitation(attempt, op) })
		}
	}
	if err != nil {
		// The attempted context may have expired. Persist only a fixed safe
		// category using a separate bounded context unless Gateway is stopping.
		recovery, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		_ = s.mutate(recovery, op.OrganizationID, func() error { return s.store.FailOnboarding(recovery, op.ID, onboardingSafeFailure(err)) })
	}
}

func (s *OnboardingService) issueInstallationTicket(w http.ResponseWriter, r *http.Request, actor, org, id string) {
	s.workMu.Lock()
	defer s.workMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	secret, err := onboardingRandom()
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	ciphertext, err := s.encryptCredential(secret)
	var op authorization.OnboardingOperation
	if err == nil {
		err = s.mutate(ctx, org, func() error {
			var e error
			op, e = s.store.PrepareInstallationRotation(ctx, actor, org, id, ciphertext)
			return e
		})
	}
	if err == nil {
		err = s.rotateVehicle(ctx, op, secret)
	}
	if err == nil {
		err = s.verifyVehicleToken(ctx, op)
	}
	if err != nil {
		if op.ID != "" {
			recovery, stop := context.WithTimeout(r.Context(), 5*time.Second)
			_ = s.mutate(recovery, org, func() error { return s.store.FailInstallationRotation(recovery, id, onboardingSafeFailure(err)) })
			stop()
		}
		onboardingHTTPError(w, r, err)
		return
	}
	token, err := onboardingRandom()
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	hash := sha256.Sum256([]byte(token))
	expires := time.Now().UTC().Add(5 * time.Minute)
	err = s.mutate(ctx, org, func() error { return s.store.CreateInstallationTicket(ctx, actor, org, id, hash, expires) })
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}{token, expires})
}

func (s *OnboardingService) serveInstall(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	// Serialize redemption against rotation and publication of a new ticket.
	s.workMu.Lock()
	defer s.workMu.Unlock()
	header := r.Header.Get("Authorization")
	token := strings.TrimPrefix(header, "Bearer ")
	if token == header || len(token) != 43 || strings.ContainsAny(token, " \r\n\t") {
		s.installationDenied(w, r)
		return
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(raw) != 32 || onboardingEmptyBody(w, r) != nil {
		s.installationDenied(w, r)
		return
	}
	hash := sha256.Sum256([]byte(token))
	org, err := s.store.InstallationTicketOrganization(r.Context(), hash)
	if err != nil {
		s.installationDenied(w, r)
		return
	}
	var op authorization.OnboardingOperation
	err = s.mutate(r.Context(), org, func() error {
		var e error
		op, e = s.store.ConsumeInstallationTicket(r.Context(), hash)
		return e
	})
	if err != nil {
		s.installationDenied(w, r)
		return
	}
	secret, err := s.decryptCredential(op.CredentialCiphertext)
	if err != nil {
		// Consumption is irrevocable, including local failure and a lost HTTP
		// response. Admin must rotate and issue a new ticket.
		writeDiagnosticError(w, r, "installation requires a new rotated ticket", "INSTALLATION_ROTATION_REQUIRED", http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		TokenURL     string `json:"token_url"`
		GatewayURL   string `json:"gateway_url"`
		VehicleID    string `json:"vehicle_id"`
		Issuer       string `json:"issuer"`
	}{op.ClientID, secret, strings.TrimRight(s.config.CasdoorURL, "/") + "/api/login/oauth/access_token", s.config.GatewayURL, op.VehicleID, s.issuer})
}

func (s *OnboardingService) installationDenied(w http.ResponseWriter, r *http.Request) {
	writeDiagnosticError(w, r, "installation ticket is invalid, expired, or consumed", "INSTALLATION_TICKET_INVALID", http.StatusUnauthorized)
}

func (s *OnboardingService) serveInstallationComplete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, _ := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	if claims == nil || claims.Issuer != s.issuer || claims.managed == nil || claims.managed.deviceID == "" || claims.managed.deviceID != vehicleID {
		writeDiagnosticError(w, r, "vehicle installation identity does not match", "VEHICLE_IDENTITY_MISMATCH", http.StatusForbidden)
		return
	}
	if err := onboardingEmptyBody(w, r); err != nil {
		managedAdminError(w, r, err)
		return
	}
	err := s.mutate(r.Context(), claims.Organization, func() error { return s.store.CompleteInstallation(r.Context(), s.issuer, vehicleID) })
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
