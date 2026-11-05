package gateway

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
)

func (s *OnboardingService) processRotation(ctx context.Context) {
	rotation, err := s.store.NextRotation(ctx)
	if err != nil {
		return
	}
	if rotation.Attempts >= 3 {
		_ = s.mutate(ctx, rotation.Operation.OrganizationID, func() error { return s.store.FailRotation(ctx, rotation, "PROVIDER_UNAVAILABLE") })
		return
	}
	if err := s.mutate(ctx, rotation.Operation.OrganizationID, func() error { return s.store.StartRotation(ctx, rotation) }); err != nil {
		return
	}
	attempt, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	allowed, checkErr := s.store.CanManageOrganization(attempt, rotation.Operation.ActorUserID, rotation.Operation.OrganizationID)
	if checkErr != nil || !allowed {
		err = authorization.ErrNotOrganizationAdmin
	} else {
		err = s.ensureVehicle(attempt, rotation.Operation)
	}
	if err == nil {
		secret, decryptErr := s.decryptCredential(rotation.Operation.CredentialCiphertext)
		err = decryptErr
		if err == nil {
			err = s.rotateVehicle(attempt, rotation.Operation, secret)
		}
	}
	if err == nil {
		err = s.verifyVehicleToken(attempt, rotation.Operation)
	}
	if err == nil {
		err = s.mutate(attempt, rotation.Operation.OrganizationID, func() error { return s.store.BindRotation(attempt, rotation, s.issuer) })
	}
	if err != nil {
		recovery, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		_ = s.mutate(recovery, rotation.Operation.OrganizationID, func() error { return s.store.FailRotation(recovery, rotation, onboardingSafeFailure(err)) })
	}
}

func (s *OnboardingService) serveRotationTicket(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, _ := r.Context().Value("user").(*UserClaims)
	org, id := r.PathValue("org_id"), r.PathValue("operation_id")
	if claims == nil || claims.UserID == "" || claims.Issuer != s.issuer {
		managedAdminError(w, r, authorization.ErrNotOrganizationAdmin)
		return
	}
	if !onboardingUUID(org) || !onboardingUUID(id) || onboardingEmptyBody(w, r) != nil {
		managedAdminError(w, r, authorization.ErrInvalidRegistration)
		return
	}
	s.workMu.Lock()
	defer s.workMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	secret, err := onboardingRandom()
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	ciphertext, err := s.encryptCredential(secret)
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	var rotation authorization.DeviceRotation
	err = s.mutate(ctx, org, func() error {
		var e error
		rotation, e = s.store.PrepareRotationTicket(ctx, claims.UserID, org, id, ciphertext)
		return e
	})
	if err == nil {
		err = s.rotateVehicle(ctx, rotation.Operation, secret)
	}
	if err == nil {
		err = s.verifyVehicleToken(ctx, rotation.Operation)
	}
	if err == nil {
		err = s.mutate(ctx, org, func() error { return s.store.BindRotation(ctx, rotation, s.issuer) })
	}
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	ticket, err := onboardingRandom()
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	expiry := time.Now().Add(5 * time.Minute)
	err = s.mutate(ctx, org, func() error {
		return s.store.CreateRotationTicket(ctx, claims.UserID, org, id, sha256.Sum256([]byte(ticket)), expiry)
	})
	if err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}{ticket, expiry})
}

func (m *ManagedRuntime) installingClaims(r *http.Request, original *UserClaims) (*UserClaims, error) {
	if original.TokenType != "access-token" || len(original.Scopes) != 1 || !hasScope(original.Scopes, "teleop:vehicle") {
		return nil, errManagedDenied
	}
	device, err := m.store.ResolveInstallingVehicle(r.Context(), original.Issuer, original.Name)
	if err != nil {
		return nil, errManagedDenied
	}
	if !slices.Contains(original.Audiences, device.ClientID) {
		return nil, errManagedDenied
	}
	allowed := r.Method == http.MethodGet && (r.URL.Path == "/api/auth/me" || r.URL.Path == "/api/vehicles/"+device.VehicleID+"/device-auth-check") || r.Method == http.MethodPost && r.URL.Path == "/api/vehicles/"+device.VehicleID+"/installation-complete"
	if !allowed {
		return nil, errManagedDenied
	}
	if org := r.Header.Get("X-Organization-ID"); org != "" && org != device.OrganizationID {
		return nil, errManagedDenied
	}
	return &UserClaims{Name: device.VehicleID, Issuer: m.issuer, Organization: device.OrganizationID, Roles: []string{"vehicle"}, Scopes: []string{"teleop:vehicle"}, managed: &managedRequestClaims{deviceID: device.VehicleID, registry: managedRegistry([]authorization.Vehicle{device}), installationOnly: true, installationSubject: device.Subject, installationClient: device.ClientID}}, nil
}

func (s *OnboardingService) completeRotation(w http.ResponseWriter, r *http.Request, claims *UserClaims) {
	if s.acquireMutation == nil {
		writeDiagnosticError(w, r, "rotation activation requires maintenance/drain", "MANAGED_DRAIN_UNAVAILABLE", http.StatusServiceUnavailable)
		return
	}
	s.workMu.Lock()
	defer s.workMu.Unlock()
	release, err := s.acquireMutation(r.Context(), claims.Organization)
	if err != nil || release == nil {
		if errors.Is(err, errManagedDrain) || errors.Is(err, errManagedMaintenance) {
			writeDiagnosticError(w, r, "rotation activation requires maintenance/drain", "MANAGED_DRAIN_REQUIRED", http.StatusConflict)
		} else {
			writeDiagnosticError(w, r, "rotation activation guard unavailable", "MANAGED_DRAIN_UNAVAILABLE", http.StatusServiceUnavailable)
		}
		return
	}
	defer release()
	if err := s.store.CompleteRotation(r.Context(), s.issuer, claims.managed.deviceID, claims.managed.installationSubject, claims.managed.installationClient); err != nil {
		onboardingHTTPError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
